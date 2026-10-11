import http from 'node:http';
import https from 'node:https';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './errors.js';
import type { JellyfinProvider } from './providers/jellyfin.js';

const ID = '[0-9a-fA-F]{32}|[0-9a-fA-F-]{36}';

/**
 * Only media and artwork paths are reachable through the proxy; nothing
 * administrative. Jellyfin's own permission checks still apply on top, because
 * every request carries the signed-in user's token. Matching is case-insensitive
 * because Jellyfin's routes are, and its HLS URLs use a lowercase "/videos/".
 */
const ALLOWED: RegExp[] = [
  `^/Videos/(${ID})/(stream|stream\\.[a-z0-9]{2,5}|master\\.m3u8|main\\.m3u8|live\\.m3u8)$`,
  `^/Videos/(${ID})/hls1/[\\w-]{1,64}/[\\w-]{1,64}\\.(ts|mp4|m4s|aac)$`,
  `^/Videos/(${ID})/(${ID})/Subtitles/\\d{1,4}/(\\d{1,20}/)?Stream\\.(vtt|srt|ass|ssa)$`,
  `^/Videos/(${ID})/(${ID})/Subtitles/\\d{1,4}/subtitles\\.m3u8$`,
  `^/Items/(${ID})/Images/(Primary|Backdrop|Logo|Thumb)(/\\d{1,3})?$`,
].map((source) => new RegExp(source, 'i'));

const FORWARD_REQUEST_HEADERS = ['range', 'if-none-match', 'if-modified-since', 'if-range', 'accept'];
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
];
const STRIP_QUERY = new Set(['api_key', 'apikey', 'x-emby-token', 'x-mediabrowser-token']);

export function isAllowedMediaPath(pathname: string): boolean {
  if (pathname.includes('..') || pathname.includes('//')) return false;
  return ALLOWED.some((re) => re.test(pathname));
}

export function mediaProxy(provider: JellyfinProvider) {
  const base = new URL(provider.serverUrl);
  const client = base.protocol === 'https:' ? https : http;
  const basePath = base.pathname.replace(/\/+$/, '');

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next(new ApiError('FORBIDDEN', 'Method not allowed'));
    }
    const session = req.session;
    if (!session) return next(new ApiError('UNAUTHENTICATED', 'Sign in to continue.'));

    const incoming = new URL(req.originalUrl.replace(/^\/jf/, ''), 'http://local');
    if (!isAllowedMediaPath(incoming.pathname)) {
      return next(new ApiError('NOT_FOUND', 'Not found'));
    }
    for (const key of [...incoming.searchParams.keys()]) {
      if (STRIP_QUERY.has(key.toLowerCase())) incoming.searchParams.delete(key);
    }

    const headers: Record<string, string> = {
      Authorization: provider.proxyAuthHeader(session.ctx),
    };
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    const upstream = client.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || undefined,
        method: req.method,
        path: `${basePath}${incoming.pathname}${incoming.search}`,
        headers,
        timeout: 60_000, // idle timeout; first transcode segments can be slow
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        if (status === 401) {
          upstreamRes.resume();
          return next(new ApiError('SESSION_EXPIRED', 'Your Jellyfin session has expired.'));
        }
        res.status(status);
        for (const name of FORWARD_RESPONSE_HEADERS) {
          const value = upstreamRes.headers[name];
          if (value !== undefined) res.setHeader(name, value);
        }
        // Artwork is immutable per tag; let browsers cache it privately.
        if (incoming.pathname.includes('/Images/') && incoming.searchParams.has('tag') && status === 200) {
          res.setHeader('Cache-Control', 'private, max-age=2592000, immutable');
        }
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => res.destroy());
      },
    );

    // Stop the upstream transfer (and any transcode segment) when the browser goes away.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
    upstream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      next(new ApiError('MEDIA_SERVER_UNREACHABLE', `Cannot reach Jellyfin (${error.message})`));
    });
    upstream.end();
  };
}
