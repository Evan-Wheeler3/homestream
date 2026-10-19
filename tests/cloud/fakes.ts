// Stand-ins for Cloudflare's D1 and R2 so the Worker's code runs under Node:
// D1 on node:sqlite with the real migrations, R2 in memory.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2Range,
} from '../../src/cloud/env';
import type { CloudEnv } from '../../src/cloud/env';
import { createApp } from '../../src/cloud/app';

const MIGRATIONS = path.join(__dirname, '../../migrations');

class FakeStatement implements D1PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new FakeStatement(this.db, this.sql, values);
  }

  private args() {
    return this.values.map((v) => (typeof v === 'boolean' ? Number(v) : v)) as never[];
  }

  async first<T>() {
    return ((this.db.prepare(this.sql).get(...this.args()) as T | undefined) ?? null) as T | null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return { results: this.db.prepare(this.sql).all(...this.args()) as T[], meta: {} };
  }

  async run(): Promise<D1Result<unknown>> {
    return this.runSync();
  }

  runSync(): D1Result<unknown> {
    const info = this.db.prepare(this.sql).run(...this.args());
    return {
      results: [],
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  }
}

export class FakeD1 implements D1Database {
  readonly raw = new DatabaseSync(':memory:');

  constructor() {
    this.raw.exec('PRAGMA foreign_keys = ON');
    for (const file of fs.readdirSync(MIGRATIONS).sort()) {
      this.raw.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    }
  }

  prepare(sql: string) {
    return new FakeStatement(this.raw, sql);
  }

  async batch(statements: D1PreparedStatement[]) {
    this.raw.exec('BEGIN');
    try {
      const results = statements.map((s) => (s as FakeStatement).runSync());
      this.raw.exec('COMMIT');
      return results;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
}

interface Stored {
  data: Uint8Array;
  etag: string;
  uploaded: Date;
  contentType?: string;
}

export class FakeR2 implements R2Bucket {
  readonly objects = new Map<string, Stored>();
  /** Every get, for checking what the Worker asked for. */
  readonly gets: { key: string; range?: R2Range }[] = [];
  private counter = 0;

  private meta(key: string, o: Stored): R2Object {
    return {
      key,
      size: o.data.length,
      etag: o.etag,
      httpEtag: `"${o.etag}"`,
      uploaded: o.uploaded,
      httpMetadata: { contentType: o.contentType },
    };
  }

  async head(key: string) {
    const o = this.objects.get(key);
    return o ? this.meta(key, o) : null;
  }

  async get(key: string, options?: { range?: R2Range; onlyIf?: { etagDoesNotMatch?: string } }) {
    this.gets.push({ key, range: options?.range });
    const o = this.objects.get(key);
    if (!o) return null;
    if (options?.onlyIf?.etagDoesNotMatch?.replace(/"/g, '') === o.etag) return this.meta(key, o);
    let start = 0;
    let end = o.data.length;
    const r = options?.range;
    if (r) {
      if (r.suffix !== undefined) start = Math.max(0, o.data.length - r.suffix);
      else {
        start = r.offset ?? 0;
        if (start >= o.data.length) throw new Error('InvalidRange');
        if (r.length !== undefined) end = Math.min(o.data.length, start + r.length);
      }
    }
    const slice = o.data.slice(start, end);
    const body: R2ObjectBody = {
      ...this.meta(key, o),
      range: r,
      body: new Blob([slice]).stream(),
      arrayBuffer: async () => slice.buffer as ArrayBuffer,
      text: async () => new TextDecoder().decode(slice),
    };
    return body;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: { httpMetadata?: { contentType?: string } },
  ) {
    let data: Uint8Array;
    if (typeof value === 'string') data = new TextEncoder().encode(value);
    else if (value instanceof Blob) data = new Uint8Array(await value.arrayBuffer());
    else if (value instanceof ArrayBuffer) data = new Uint8Array(value);
    else if (ArrayBuffer.isView(value))
      data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else data = new Uint8Array(await new Response(value).arrayBuffer());
    const stored = {
      data,
      etag: `etag${++this.counter}`,
      uploaded: new Date(),
      contentType: options?.httpMetadata?.contentType,
    };
    this.objects.set(key, stored);
    return this.meta(key, stored);
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }

  async list(options?: { prefix?: string }) {
    const objects = [...this.objects.entries()]
      .filter(([k]) => !options?.prefix || k.startsWith(options.prefix))
      .map(([k, o]) => this.meta(k, o));
    return { objects, truncated: false };
  }
}

export const MAC_TOKEN = 'm'.repeat(40);

export function cloud(overrides: Partial<CloudEnv> = {}) {
  const db = new FakeD1();
  const media = new FakeR2();
  const env: CloudEnv = {
    DB: db,
    MEDIA: media,
    PEPPER: 'test-pepper',
    MAC_TOKEN,
    PBKDF2_ITERATIONS: '1000',
    ...overrides,
  };
  const app = createApp();
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} };
  const jar = new Map<string, string>();

  /** A request as a browser would make it (cookies kept between calls). */
  async function call(
    method: string,
    url: string,
    options: {
      body?: unknown;
      /** Bytes sent as-is (set content-type in headers). */
      rawBody?: Uint8Array;
      headers?: Record<string, string>;
      cookies?: boolean;
      ip?: string;
    } = {},
  ) {
    const headers = new Headers(options.headers);
    if (method !== 'GET' && method !== 'HEAD' && !headers.has('x-requested-with'))
      headers.set('x-requested-with', 'wheelhouse');
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    headers.set('cf-connecting-ip', options.ip ?? '203.0.113.9');
    if (options.cookies !== false && jar.size) {
      headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    const res = await app.fetch(
      new Request(`https://wheelhouse.example${url}`, {
        method,
        headers,
        body:
          options.rawBody !== undefined
            ? (options.rawBody as Uint8Array<ArrayBuffer>)
            : options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
      }),
      env,
      ctx as never,
    );
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, ...rest] = pair!.split('=');
      const v = rest.join('=');
      if (/Max-Age=0/i.test(c) || v === '') jar.delete(k!);
      else jar.set(k!, v);
    }
    return res;
  }

  const mac = (method: string, url: string, body?: unknown) =>
    call(method, `/api/mac${url}`, {
      body,
      cookies: false,
      headers: { authorization: `Bearer ${MAC_TOKEN}` },
    });

  return { env, db, media, app, call, mac, jar, waits };
}
