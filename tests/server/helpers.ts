import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/server/app';
import type { AppConfig } from '../../src/server/config';
import { openDatabase } from '../../src/server/db';
import type { MediaProvider } from '../../src/server/providers/types';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: ':memory:',
    source: 'mock',
    jellyfinUrl: null,
    mockPassword: 'demo',
    cookieSecure: false,
    trustProxy: false,
    sessionDays: 30,
    catalogTtlSeconds: 300,
    clientDir: null,
    version: 'test',
    ...overrides,
  };
}

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(
  overrides: Partial<AppConfig> = {},
  provider?: MediaProvider,
): Promise<TestServer & { db: ReturnType<typeof openDatabase> }> {
  const db = openDatabase(':memory:');
  const { app } = createApp({
    config: testConfig(overrides),
    db,
    provider,
    logger: { error: () => undefined, warn: () => undefined, info: () => undefined },
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    db,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A minimal cookie-keeping HTTP client: each instance behaves like one device. */
export class Client {
  cookie = '';
  constructor(private readonly base: string) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const init: RequestInit = {
      method,
      headers: {
        'X-Requested-With': 'private-cinema',
        ...(body !== undefined && !(body instanceof Uint8Array)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body:
        body === undefined
          ? undefined
          : body instanceof Uint8Array
            ? new Blob([body as Uint8Array<ArrayBuffer>])
            : JSON.stringify(body),
    };
    const response = await fetch(this.base + path, init);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const first = setCookie.split(';')[0]!;
      this.cookie = first.endsWith('=') ? '' : first;
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: response.status, headers: response.headers, json: json as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  get(path: string) {
    return this.request('GET', path);
  }
  post(path: string, body?: unknown) {
    return this.request('POST', path, body ?? {});
  }
  put(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request('PUT', path, body ?? {}, headers);
  }
  patch(path: string, body?: unknown) {
    return this.request('PATCH', path, body ?? {});
  }
  delete(path: string) {
    return this.request('DELETE', path);
  }

  async login(username = 'owner', password = 'demo') {
    const res = await this.post('/api/auth/login', { username, password });
    if (res.status !== 200)
      throw new Error(`login failed: ${res.status} ${JSON.stringify(res.json)}`);
    return res;
  }
}
