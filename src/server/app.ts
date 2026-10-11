import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ApiErrorBody } from '../shared/types.js';
import {
  cookieOptions,
  requireCsrfHeader,
  SESSION_COOKIE,
  sessionMiddleware,
  SessionStore,
} from './auth.js';
import { CatalogCache } from './catalog.js';
import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import { ApiError } from './errors.js';
import { LibraryService } from './library.js';
import { JellyfinProvider } from './providers/jellyfin.js';
import { MockProvider } from './providers/mock.js';
import type { MediaProvider } from './providers/types.js';
import { mediaProxy } from './proxy.js';
import { apiRouter } from './routes/api.js';
import { Store } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root, both when running from src/ (tsx) and dist/ (compiled). */
const ROOT = path.resolve(here, '..', '..');

export interface AppOptions {
  config: AppConfig;
  db: Db;
  provider?: MediaProvider;
  logger?: Pick<Console, 'error' | 'warn' | 'info'>;
}

export function createApp({ config, db, provider: injected, logger = console }: AppOptions) {
  const provider: MediaProvider =
    injected ??
    (config.source === 'jellyfin' && config.jellyfinUrl
      ? new JellyfinProvider(config.jellyfinUrl, config.version)
      : new MockProvider(db, config.mockPassword));

  const store = new Store(db, config.dataDir === ':memory:' ? ':memory:' : config.dataDir);
  const catalog = new CatalogCache(provider, config.catalogTtlSeconds * 1000);
  catalog.onRefresh = (movies) => {
    try {
      store.recordSnapshots(movies);
    } catch (error) {
      logger.warn('Could not record item snapshots', error);
    }
  };
  const library = new LibraryService(provider, catalog, store);
  const sessions = new SessionStore(db, config);
  sessions.purgeExpired();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use(sessionMiddleware(sessions));

  // Re-check each session's media-server token at most once a minute, so access
  // revoked in Jellyfin (e.g. a lost phone) ends promptly even while browsing is
  // served from the cached index. An unreachable server never signs anyone out.
  const lastValidated = new Map<string, number>();
  app.use(['/api', '/jf'], (req, res, next) => {
    const session = req.session;
    if (!session || provider.kind !== 'jellyfin') return next();
    const last = lastValidated.get(session.idHash) ?? 0;
    if (Date.now() - last < 60_000) return next();
    lastValidated.set(session.idHash, Date.now());
    provider
      .validate(session.ctx)
      .then(() => next())
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'SESSION_EXPIRED') {
          lastValidated.delete(session.idHash);
          next(error);
        } else next();
      });
  });

  app.use(
    '/api',
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
    requireCsrfHeader,
    express.json({ limit: '256kb' }),
    apiRouter({
      config,
      sessions,
      library,
      startedAt: new Date(),
      assetsDir: path.join(ROOT, 'assets'),
    }),
  );

  if (provider instanceof JellyfinProvider) {
    app.use('/jf', mediaProxy(provider));
  }

  // Production: serve the built frontend with SPA fallback.
  const clientDir = config.clientDir;
  if (clientDir && fs.existsSync(path.join(clientDir, 'index.html'))) {
    app.use(
      express.static(clientDir, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    const indexHtml = path.join(clientDir, 'index.html');
    app.get(/^(?!\/api\/|\/jf\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "img-src 'self' data: blob:",
          "media-src 'self' blob:",
          "style-src 'self' 'unsafe-inline'",
          "script-src 'self'",
          "worker-src 'self' blob:",
          "connect-src 'self'",
          "font-src 'self' data:",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; '),
      );
      res.sendFile(indexHtml);
    });
  }

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    let apiError: ApiError;
    if (error instanceof ApiError) apiError = error;
    else if (
      error &&
      typeof error === 'object' &&
      'type' in error &&
      error.type === 'entity.too.large'
    ) {
      apiError = new ApiError('BAD_REQUEST', 'Request is too large');
    } else if (error instanceof SyntaxError) {
      apiError = new ApiError('BAD_REQUEST', 'Malformed JSON');
    } else {
      logger.error(error);
      apiError = new ApiError('INTERNAL', 'Something went wrong on the server.');
    }
    if (apiError.code === 'SESSION_EXPIRED' && req.session) {
      sessions.delete(req.session.idHash);
      catalog.invalidate(req.session.user.id);
      res.clearCookie(SESSION_COOKIE, cookieOptions(config, req));
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body: ApiErrorBody = { error: { code: apiError.code, message: apiError.message } };
    res.status(apiError.status).json(body);
  });

  return { app, provider, library, sessions };
}
