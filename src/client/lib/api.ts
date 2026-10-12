import type { ApiErrorBody, ApiErrorCode } from '../../shared/types';
import { connection } from './connection';
import { recordError } from './diagnostics';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode | 'NETWORK',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

  get isAuth() {
    return this.code === 'UNAUTHENTICATED' || this.code === 'SESSION_EXPIRED';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method?: Method;
  body?: unknown;
  /** Raw body (e.g. an image upload); sent as-is with its own content type. */
  raw?: Blob;
  signal?: AbortSignal;
  keepalive?: boolean;
}

/**
 * Fetch wrapper for the app's own backend. Adds the CSRF header, parses JSON,
 * normalises errors and keeps the global connection state up to date.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Requested-With': 'wheelhouse',
  };
  let body: BodyInit | undefined;
  if (options.raw) {
    body = options.raw;
    headers['Content-Type'] = options.raw.type || 'application/octet-stream';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
      signal: options.signal,
      keepalive: options.keepalive,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    connection.reportAppServer(false);
    const err = new ApiError('NETWORK', 'Cannot reach the Wheelhouse server.', 0);
    recordError(`${options.method ?? 'GET'} ${path}: network error`);
    throw err;
  }

  connection.reportAppServer(true);
  if (response.headers.get('X-Catalog-Stale') === '1') connection.reportMediaServer(false);
  else if (response.ok && (path.startsWith('/movies') || path.startsWith('/home'))) {
    connection.reportMediaServer(true);
  }

  if (!response.ok) {
    let code: ApiErrorCode = 'INTERNAL';
    let message = `Request failed (${response.status})`;
    try {
      const data = (await response.json()) as ApiErrorBody;
      code = data.error.code;
      message = data.error.message;
    } catch {
      /* non-JSON error body */
    }
    if (code === 'MEDIA_SERVER_UNREACHABLE') connection.reportMediaServer(false);
    const err = new ApiError(code, message, response.status);
    if (!err.isAuth) recordError(`${options.method ?? 'GET'} ${path}: ${code} ${message}`);
    if (err.isAuth) connection.reportAuthLost(code === 'SESSION_EXPIRED');
    throw err;
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
