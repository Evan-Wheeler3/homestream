import type { ApiErrorCode } from '../shared/types.js';

const STATUS: Record<ApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  CONFLICT: 409,
  MEDIA_SERVER_UNREACHABLE: 503,
  MEDIA_SERVER_ERROR: 502,
  MEDIA_UNAVAILABLE: 422,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const badRequest = (message: string) => new ApiError('BAD_REQUEST', message);
export const notFound = (message = 'Not found') => new ApiError('NOT_FOUND', message);
