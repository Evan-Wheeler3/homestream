// Serving files from R2 to signed-in browsers: video with full HTTP Range
// support (seeking, resuming, TV browsers), artwork (cached) and subtitles.
import type { R2Bucket, R2Object, R2ObjectBody, R2Range } from './env.js';

const TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  vtt: 'text/vtt; charset=utf-8',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  json: 'application/json',
};

export function contentTypeFor(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

export type ParsedRange =
  { kind: 'none' } | { kind: 'invalid' } | { kind: 'range'; range: R2Range };

/** Parses a single-range `Range` header. Several ranges are answered with the whole file. */
export function parseRange(header: string | null): ParsedRange {
  if (!header) return { kind: 'none' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return header.includes(',') ? { kind: 'none' } : { kind: 'invalid' };
  const [, start, end] = m;
  if (start === '' && end === '') return { kind: 'invalid' };
  if (start === '') {
    const suffix = Number(end);
    return suffix > 0 ? { kind: 'range', range: { suffix } } : { kind: 'invalid' };
  }
  const offset = Number(start);
  if (end === '') return { kind: 'range', range: { offset } };
  const last = Number(end);
  if (last < offset) return { kind: 'invalid' };
  return { kind: 'range', range: { offset, length: last - offset + 1 } };
}

/** First and last byte served, given the file size. */
function rangeBounds(range: R2Range, size: number): [number, number] | null {
  if (range.suffix !== undefined) {
    const length = Math.min(range.suffix, size);
    return length > 0 ? [size - length, size - 1] : null;
  }
  const start = range.offset ?? 0;
  if (start >= size) return null;
  const end = range.length !== undefined ? Math.min(size - 1, start + range.length - 1) : size - 1;
  return [start, end];
}

const hasBody = (o: R2Object | R2ObjectBody | null): o is R2ObjectBody =>
  Boolean(o && 'body' in o && o.body);

export interface ServeOptions {
  cacheControl: string;
  /** Overrides the type guessed from the key. */
  contentType?: string;
}

/** Answers GET/HEAD for one R2 object, honouring Range and If-None-Match. */
export async function serveObject(
  request: Request,
  bucket: R2Bucket,
  key: string,
  options: ServeOptions,
): Promise<Response> {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cacheControl,
    'Content-Type': options.contentType ?? contentTypeFor(key),
    'X-Content-Type-Options': 'nosniff',
  });
  const notFound = () =>
    new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

  if (request.method === 'HEAD') {
    const head = await bucket.head(key);
    if (!head) return notFound();
    headers.set('ETag', head.httpEtag);
    headers.set('Content-Length', String(head.size));
    return new Response(null, { status: 200, headers });
  }

  const parsed = parseRange(request.headers.get('Range'));
  const unsatisfiable = async () => {
    const head = await bucket.head(key);
    if (!head) return notFound();
    headers.set('Content-Range', `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  };
  if (parsed.kind === 'invalid') return unsatisfiable();

  if (parsed.kind === 'range') {
    let object: R2Object | R2ObjectBody | null;
    try {
      object = await bucket.get(key, { range: parsed.range });
    } catch {
      // R2 refuses ranges past the end of the file.
      return unsatisfiable();
    }
    if (!object) return notFound();
    const bounds = rangeBounds(parsed.range, object.size);
    if (!bounds || !hasBody(object)) return unsatisfiable();
    const [start, end] = bounds;
    headers.set('ETag', object.httpEtag);
    headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(object.body, { status: 206, headers });
  }

  const ifNoneMatch = request.headers.get('If-None-Match');
  const object = await bucket.get(
    key,
    ifNoneMatch ? { onlyIf: { etagDoesNotMatch: ifNoneMatch.replace(/^W\//, '') } } : undefined,
  );
  if (!object) return notFound();
  headers.set('ETag', object.httpEtag);
  // R2 returns the object without a body when the precondition failed: not modified.
  if (!hasBody(object)) return new Response(null, { status: 304, headers });
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

/** R2 keys the media route may serve (not backups or anything else in the bucket). */
export function isServableKey(key: string): boolean {
  if (key.includes('..') || key.includes('//')) return false;
  return /^(movies\/[\w-]{1,64}\/[\w.-]{1,80}|people\/[\w.-]{1,120})$/.test(key);
}

/**
 * Artwork through Cloudflare's edge cache, so popular posters don't cost an R2
 * read each time. The caller has already checked the session; the cache key is
 * the URL, which carries a version, so updated artwork is never stale.
 */
export async function serveCachedImage(
  request: Request,
  bucket: R2Bucket,
  key: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  const versioned = new URL(request.url).searchParams.has('v');
  const cacheControl = versioned ? 'private, max-age=31536000, immutable' : 'private, max-age=3600';
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const cacheKey = new Request(request.url, { method: 'GET' });
  if (cache && request.method === 'GET' && !request.headers.has('Range')) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) return hit;
  }
  const response = await serveObject(request, bucket, key, { cacheControl });
  if (cache && response.status === 200 && request.method === 'GET') {
    // The shared edge cache may keep it; browsers still see it as private.
    const copy = new Response(response.clone().body, response);
    copy.headers.set(
      'Cache-Control',
      versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    );
    waitUntil(cache.put(cacheKey, copy).catch(() => undefined));
  }
  return response;
}
