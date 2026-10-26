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
import { Maintenance } from './maintenance.js';
import { MovieNights } from './nights.js';
import { MovieRequests } from './requests.js';
import { NowPlaying, StreamLimits } from './sharing.js';
import { AutoUpdater, isSupervised, Updater } from './updater.js';
import { JellyfinProvider } from './providers/jellyfin.js';
import { MockProvider } from './providers/mock.js';
import type { MediaProvider } from './providers/types.js';
import { mediaProxy } from './proxy.js';
import { RipJobStore } from './ripper/jobs.js';
import { runProcess, type Runner } from './ripper/process.js';
import { Ripper, type RipperCloud } from './ripper/ripper.js';
import { cloudLinkFromEnv, MacReporter } from './cloud/macLink.js';
import { ocrDiscSubtitles } from './cloud/ocr.js';
import {
  JellyfinAdmin,
  MacNotifier,
  MultiNotifier,
  NtfyNotifier,
  type Notifier,
} from './ripper/services.js';
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
  /** Test seams for the disc ripper. */
  ripperRunner?: Runner;
  ripperNotifier?: Notifier;
  ripperFetch?: typeof fetch;
  /** Test seams: the cloud upload and subtitle OCR (normally from .env). */
  ripperCloud?: RipperCloud | null;
  ripperOcr?: ((mkv: string, workDir: string) => Promise<string | null>) | null;
  /** Test seams for in-app updates. */
  updater?: Updater;
}

export function createApp({
  config,
  db,
  provider: injected,
  logger = console,
  ripperRunner = runProcess,
  ripperNotifier,
  ripperFetch = fetch,
  ripperCloud,
  ripperOcr,
  updater: injectedUpdater,
}: AppOptions) {
  const provider: MediaProvider =
    injected ??
    (config.source === 'jellyfin' && config.jellyfinUrl
      ? new JellyfinProvider(config.jellyfinUrl, config.version)
      : new MockProvider(db, config.mockPassword));

  const store = new Store(db, config.dataDir === ':memory:' ? ':memory:' : config.dataDir);
  const catalog = new CatalogCache(provider, config.catalogTtlSeconds * 1000);
  const library = new LibraryService(provider, catalog, store);
  const requests = new MovieRequests(db);
  const sessions = new SessionStore(db, config);
  sessions.purgeExpired();

  let ripper: Ripper | null = null;
  const rc = config.ripper;
  const ntfy = rc.ntfyTopic ? new NtfyNotifier(rc.ntfyServer, rc.ntfyTopic, ripperFetch) : null;
  const notifier =
    ripperNotifier ??
    new MultiNotifier([new MacNotifier(ripperRunner), ...(ntfy ? [ntfy] : [])], logger);
  // Requests are marked done when the movie appears; tell the household's phone.
  const requestNotifier = ripperNotifier ?? (ntfy ? notifier : null);
  catalog.onRefresh = (movies) => {
    try {
      store.recordSnapshots(movies);
    } catch (error) {
      logger.warn('Could not record item snapshots', error);
    }
    try {
      for (const r of requests.fulfil(movies)) {
        void requestNotifier
          ?.send({
            title: `${r.title} is in Wheelhouse`,
            message: `Requested by ${r.userName}.`,
            tags: ['movie_camera'],
            click: rc.publicUrl && r.itemId ? `${rc.publicUrl}/movie/${r.itemId}` : undefined,
          })
          .catch((error: unknown) => logger.warn('Request notification failed', error));
      }
    } catch (error) {
      logger.warn('Could not check movie requests', error);
    }
  };
  // Wheelhouse in the cloud: finished rips upload themselves (needs CLOUD_URL etc. in .env).
  const cloudLink =
    rc.enabled && config.dataDir !== ':memory:'
      ? cloudLinkFromEnv({
          run: ripperRunner,
          handbrakeCli: rc.handbrakeCli,
          dataDir: config.dataDir,
          log: logger,
        })
      : null;
  if (rc.enabled) {
    ripper = new Ripper({
      config: rc,
      jobs: new RipJobStore(db),
      run: ripperRunner,
      jellyfin:
        rc.jellyfinApiKey && config.jellyfinUrl
          ? new JellyfinAdmin(config.jellyfinUrl, rc.jellyfinApiKey, config.version, ripperFetch)
          : null,
      notifier,
      onImported: () => catalog.invalidate(),
      logger,
      cloud: ripperCloud !== undefined ? ripperCloud : (cloudLink?.publisher ?? null),
      titleSearch: cloudLink?.titleSearch ?? null,
      ocrSubtitles:
        ripperOcr !== undefined
          ? ripperOcr
          : cloudLink
            ? (mkv, workDir) => ocrDiscSubtitles(ripperRunner, mkv, workDir)
            : null,
    });
  }
  const macReporter =
    ripper && cloudLink ? new MacReporter(cloudLink.client, ripper, logger) : null;

  // Daily backups and drive-space warnings (not for in-memory test databases).
  const maintenance =
    config.dataDir === ':memory:'
      ? null
      : new Maintenance({
          db,
          dataDir: config.dataDir,
          backupDir: config.backupDir,
          keepBackups: config.keepBackups,
          drives: [
            { label: 'Wheelhouse data', path: config.dataDir },
            ...(rc.enabled
              ? [
                  { label: 'Movies', path: rc.moviesDir },
                  { label: 'Rips', path: rc.ripsDir },
                ]
              : []),
          ],
          lowSpaceGb: config.lowSpaceGb,
          notifier: ntfy ? notifier : null,
          publicUrl: rc.publicUrl,
          logger,
        });

  // In-app updates. Exiting with a non-zero code makes launchd/systemd start the new version.
  const updater =
    injectedUpdater ??
    new Updater({
      root: ROOT,
      restart: isSupervised() ? () => process.exit(75) : undefined,
      logger,
    });

  const nowPlaying = new NowPlaying();
  // Automatic updates: only when a service will restart Wheelhouse, and only while idle.
  const autoUpdater =
    config.autoUpdate && !injectedUpdater && isSupervised()
      ? new AutoUpdater({
          updater,
          idle: () => (!ripper || ripper.isIdle()) && nowPlaying.list().length === 0,
          hold: (on) => ripper?.holdForUpdate(on),
          everyMs: 30 * 60_000,
          notify: ntfy
            ? (title, message) =>
                notifier.send({ title, message, tags: ['arrows_counterclockwise'] })
            : undefined,
          logger,
        })
      : null;

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
      ripper,
      ntfy: ripperNotifier ?? ntfy,
      maintenance,
      updater,
      autoUpdate: Boolean(autoUpdater),
      nights: new MovieNights(db),
      requests,
      requestNotifier,
      limits: new StreamLimits(db),
      nowPlaying,
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
          // Trailers play in YouTube's privacy-enhanced (no-cookie) player.
          'frame-src https://www.youtube-nocookie.com',
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

  return { app, provider, library, sessions, ripper, maintenance, macReporter, autoUpdater };
}
