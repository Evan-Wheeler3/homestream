// The Worker's bindings, typed by hand: only the parts Wheelhouse uses, so the
// same code runs on Cloudflare and in the Node test suite (with small fakes).

export interface D1Result<T> {
  results: T[];
  meta: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]>;
}

export interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

export interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
  range?: R2Range;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(
    key: string,
    options?: { range?: R2Range; onlyIf?: { etagDoesNotMatch?: string } },
  ): Promise<R2ObjectBody | R2Object | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2Objects>;
}

export interface CloudEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  /** Static files of the React app (absent in tests). */
  ASSETS?: { fetch(request: Request): Promise<Response> };

  // Plain settings (wrangler.jsonc "vars")
  PBKDF2_ITERATIONS?: string;
  NTFY_SERVER?: string;
  BACKUPS_KEEP?: string;

  // Secrets (wrangler secret put …)
  /** Mixed into every password hash; a database copy alone can't be used to guess passwords. */
  PEPPER?: string;
  /** Shared with the Mac: lets it add movies and report rip progress. */
  MAC_TOKEN?: string;
  NTFY_TOPIC?: string;
  TMDB_READ_TOKEN?: string;
  /** omdbapi.com key: IMDb and Rotten Tomatoes ratings. */
  OMDB_API_KEY?: string;
  OPENSUBTITLES_API_KEY?: string;
  OPENSUBTITLES_USERNAME?: string;
  OPENSUBTITLES_PASSWORD?: string;
}
