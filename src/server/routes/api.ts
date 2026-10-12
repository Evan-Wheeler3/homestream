import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type {
  MovieQuery,
  PlaybackReport,
  PlaybackRequest,
  ServerStatus,
  SessionInfo,
  SortField,
} from '../../shared/types.js';
import {
  cookieOptions,
  DEVICE_COOKIE,
  deviceNameFromUserAgent,
  LoginRateLimiter,
  parseCookies,
  requireAuth,
  SESSION_COOKIE,
  type SessionStore,
} from '../auth.js';
import { evaluateSmartCollection, parseSmartRules } from '../../shared/rules.js';
import type { AppConfig } from '../config.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import type { LibraryService } from '../library.js';
import { backdropSvg, posterSvg } from '../providers/mockArt.js';
import { MockProvider } from '../providers/mock.js';
import type { UserContext } from '../providers/types.js';

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

/** Wrap async handlers so thrown errors reach the error middleware. */
const route =
  (handler: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res))
      .then((result) => {
        if (result !== undefined && !res.headersSent) res.json(result);
      })
      .catch(next);
  };

const ctxOf = (req: Request): UserContext => {
  if (!req.session) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
  return req.session.ctx;
};

const SORTS = new Set<SortField>(['title', 'year', 'dateAdded', 'runtime', 'rating']);

function list(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const values = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split('|'));
  const clean = values.map((v) => v.trim()).filter(Boolean);
  return clean.length ? clean : undefined;
}

function int(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

export function parseMovieQuery(q: Request['query']): MovieQuery {
  const sort = SORTS.has(q.sort as SortField) ? (q.sort as SortField) : undefined;
  const watched =
    q.watched === 'watched' || q.watched === 'unwatched' || q.watched === 'inProgress'
      ? q.watched
      : undefined;
  return {
    q: typeof q.q === 'string' && q.q.trim() ? q.q.trim().slice(0, 200) : undefined,
    genres: list(q.genre),
    directors: list(q.director),
    countries: list(q.country),
    tags: list(q.tag),
    studios: list(q.studio),
    ratings: list(q.rating),
    yearMin: int(q.yearMin),
    yearMax: int(q.yearMax),
    runtimeMax: int(q.runtimeMax),
    watched,
    favorite: q.favorite === '1' || q.favorite === 'true' ? true : undefined,
    sort,
    dir: q.dir === 'asc' || q.dir === 'desc' ? q.dir : undefined,
    offset: int(q.offset),
    limit: int(q.limit),
  };
}

function itemId(req: Request): string {
  const id = String(req.params.id ?? '');
  if (!/^[\w-]{1,64}$/.test(id)) throw badRequest('Invalid item id');
  return id;
}

export interface ApiDeps {
  config: AppConfig;
  sessions: SessionStore;
  library: LibraryService;
  startedAt: Date;
  assetsDir: string;
}

export function apiRouter(deps: ApiDeps): Router {
  const { config, sessions, library } = deps;
  const { provider, store, catalog } = library;
  const router = Router();
  const limiter = new LoginRateLimiter();

  // ---------------------------------------------------------------------------
  // Public

  router.get(
    '/health',
    route(() => ({ ok: true, source: config.source, version: config.version })),
  );

  router.post(
    '/auth/login',
    route(async (req, res) => {
      const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
      if (typeof username !== 'string' || !username.trim() || typeof password !== 'string') {
        throw badRequest('Enter your username and password.');
      }
      const key = `${req.ip}:${username.toLowerCase()}`;
      limiter.check(key);
      // One stable device id per browser, so Jellyfin's device list doesn't grow
      // with every sign-in. It identifies the browser only; it grants nothing.
      const existingDevice = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
      const device = {
        deviceId:
          existingDevice && /^pc-[0-9a-f-]{36}$/.test(existingDevice)
            ? existingDevice
            : `pc-${randomUUID()}`,
        deviceName: deviceNameFromUserAgent(req.headers['user-agent']),
      };
      const result = await provider.authenticate(username.trim(), password, device);
      limiter.reset(key);
      const { token, expires } = sessions.create(result.user, result.token, device);
      res.cookie(SESSION_COOKIE, token, { ...cookieOptions(config, req), expires });
      res.cookie(DEVICE_COOKIE, device.deviceId, {
        ...cookieOptions(config, req),
        maxAge: 400 * 86_400_000,
      });
      store.ensureStarterCollections(result.user.id);
      const body: SessionInfo = { user: result.user, source: config.source };
      return body;
    }),
  );

  router.get(
    '/auth/session',
    route((req) => {
      if (!req.session) throw new ApiError('UNAUTHENTICATED', 'Not signed in.');
      const body: SessionInfo = { user: req.session.user, source: config.source };
      return body;
    }),
  );

  router.post(
    '/auth/logout',
    route(async (req, res) => {
      if (req.session) {
        await provider.logout(req.session.ctx);
        sessions.delete(req.session.idHash);
        catalog.invalidate(req.session.user.id);
      }
      res.clearCookie(SESSION_COOKIE, cookieOptions(config, req));
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------------------------
  // Everything below requires a session

  router.use(requireAuth);

  router.get(
    '/status',
    route(async (req) => {
      const info = await provider.serverInfo();
      const peek = catalog.peek(ctxOf(req).userId);
      const status: ServerStatus = {
        app: {
          name: 'Wheelhouse',
          version: config.version,
          startedAt: deps.startedAt.toISOString(),
          node: process.version,
        },
        source: config.source,
        mediaServer: {
          url: provider.serverUrl,
          reachable: info.reachable,
          name: info.name,
          version: info.version,
          latencyMs: info.latencyMs,
          error: info.error,
        },
        catalog: {
          count: peek?.movies.length ?? 0,
          lastRefreshed: peek?.fetchedAt ? new Date(peek.fetchedAt).toISOString() : null,
          stale: peek?.stale ?? false,
          lastError: peek?.lastError ?? null,
        },
      };
      return status;
    }),
  );

  router.post(
    '/catalog/refresh',
    route(async (req) => {
      const snap = await library.snapshot(ctxOf(req), true);
      return { count: snap.movies.length, stale: snap.stale };
    }),
  );

  // Movies ------------------------------------------------------------------

  router.get(
    '/movies',
    route(async (req, res) => {
      const { page, stale } = await library.query(ctxOf(req), parseMovieQuery(req.query));
      if (stale) res.setHeader('X-Catalog-Stale', '1');
      return page;
    }),
  );

  router.get(
    '/movies/facets',
    route((req) => library.facets(ctxOf(req))),
  );

  router.get(
    '/movies/random',
    route(async (req) => ({ movie: await library.random(ctxOf(req), parseMovieQuery(req.query)) })),
  );

  router.get(
    '/movies/:id',
    route(async (req, res) => {
      const { detail, stale } = await library.detail(ctxOf(req), itemId(req));
      if (stale) res.setHeader('X-Catalog-Stale', '1');
      return detail;
    }),
  );

  router.get(
    '/movies/:id/similar',
    route((req) => library.similar(ctxOf(req), itemId(req))),
  );

  router.put(
    '/movies/:id/favorite',
    route(async (req) => {
      const ctx = ctxOf(req);
      const id = itemId(req);
      const state = await provider.setFavorite(ctx, id, Boolean(req.body?.favorite));
      catalog.updateUserState(ctx.userId, id, state);
      return state;
    }),
  );

  router.put(
    '/movies/:id/played',
    route(async (req) => {
      const ctx = ctxOf(req);
      const id = itemId(req);
      const state = await provider.setPlayed(ctx, id, Boolean(req.body?.played));
      catalog.updateUserState(ctx.userId, id, state);
      return state;
    }),
  );

  router.put(
    '/movies/:id/personal',
    route((req) => store.setPersonal(ctxOf(req).userId, itemId(req), req.body ?? {})),
  );

  router.post(
    '/movies/:id/playback',
    route(async (req) => {
      const ctx = ctxOf(req);
      const prefs = store.getPreferences(ctx.userId).playback;
      const body = (req.body ?? {}) as PlaybackRequest;
      const optionalIndex = (v: unknown) =>
        v === null || v === undefined || !Number.isInteger(Number(v)) ? null : Number(v);
      return provider.getPlayback(
        ctx,
        itemId(req),
        {
          capabilities: body.capabilities,
          mediaSourceId:
            typeof body.mediaSourceId === 'string' && /^[\w-]{1,64}$/.test(body.mediaSourceId)
              ? body.mediaSourceId
              : null,
          audioStreamIndex: optionalIndex(body.audioStreamIndex),
          subtitleStreamIndex: optionalIndex(body.subtitleStreamIndex),
          startSeconds: Number(body.startSeconds) || 0,
          forceTranscode: Boolean(body.forceTranscode),
        },
        prefs,
      );
    }),
  );

  for (const event of ['start', 'progress', 'stop'] as const) {
    router.post(
      `/playback/${event}`,
      route(async (req) => {
        const ctx = ctxOf(req);
        const raw = (req.body ?? {}) as Partial<PlaybackReport>;
        if (typeof raw.itemId !== 'string' || !/^[\w-]{1,64}$/.test(raw.itemId)) {
          throw badRequest('itemId is required');
        }
        const report: PlaybackReport = {
          itemId: raw.itemId,
          mediaSourceId: String(raw.mediaSourceId ?? raw.itemId),
          playSessionId: String(raw.playSessionId ?? ''),
          positionSeconds: Math.max(0, Number(raw.positionSeconds) || 0),
          isPaused: Boolean(raw.isPaused),
          method:
            raw.method === 'DirectStream' || raw.method === 'Transcode' ? raw.method : 'DirectPlay',
          audioStreamIndex: raw.audioStreamIndex ?? null,
          subtitleStreamIndex: raw.subtitleStreamIndex ?? null,
        };
        await provider.reportPlayback(ctx, event, report);
        if (event === 'stop') {
          // Jellyfin decides resume/played state; read it back into the index.
          const state = await provider.getUserState(ctx, report.itemId).catch(() => null);
          if (state) catalog.updateUserState(ctx.userId, report.itemId, state);
          return { ok: true, user: state };
        }
        return { ok: true };
      }),
    );
  }

  // Home ----------------------------------------------------------------------

  router.get(
    '/home',
    route(async (req, res) => {
      const home = await library.home(ctxOf(req));
      if (home.stale) res.setHeader('X-Catalog-Stale', '1');
      return home;
    }),
  );

  // Collections ---------------------------------------------------------------

  router.get(
    '/collections',
    route((req) => library.listCollections(ctxOf(req))),
  );

  router.post(
    '/collections',
    route(async (req, res) => {
      const ctx = ctxOf(req);
      const row = store.createCollection(ctx.userId, req.body ?? {});
      res.status(201);
      return library.collectionDetail(ctx, row.id);
    }),
  );

  router.post(
    '/collections/preview',
    route(async (req) => {
      const ctx = ctxOf(req);
      let rules;
      try {
        rules = parseSmartRules(req.body?.rules);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : 'Invalid rules');
      }
      const snap = await library.snapshot(ctx);
      const personal = store.allPersonal(ctx.userId);
      const movies = evaluateSmartCollection(rules, snap.movies, (id) => personal.get(id));
      return { count: movies.length, sample: movies.slice(0, 8) };
    }),
  );

  router.put(
    '/collections/order',
    route((req) => {
      store.reorderCollections(ctxOf(req).userId, req.body?.ids);
      return { ok: true };
    }),
  );

  router.get(
    '/collections/:cid',
    route((req) => library.collectionDetail(ctxOf(req), String(req.params.cid))),
  );

  router.patch(
    '/collections/:cid',
    route((req) => {
      const ctx = ctxOf(req);
      store.updateCollection(ctx.userId, String(req.params.cid), req.body ?? {});
      return library.collectionDetail(ctx, String(req.params.cid));
    }),
  );

  router.delete(
    '/collections/:cid',
    route((req) => {
      const ctx = ctxOf(req);
      const id = String(req.params.cid);
      store.deleteCollection(ctx.userId, id);
      // Drop it from the home layout too.
      const prefs = store.getPreferences(ctx.userId);
      store.updatePreferences(ctx.userId, {
        homeSections: prefs.homeSections.filter((s) => s.id !== `collection:${id}`),
      });
      return { ok: true };
    }),
  );

  router.post(
    '/collections/:cid/items',
    route((req) => {
      const ctx = ctxOf(req);
      store.addItems(ctx.userId, String(req.params.cid), req.body?.itemIds);
      return library.collectionDetail(ctx, String(req.params.cid));
    }),
  );

  router.delete(
    '/collections/:cid/items/:id',
    route((req) => {
      const ctx = ctxOf(req);
      store.removeItem(ctx.userId, String(req.params.cid), itemId(req));
      return library.collectionDetail(ctx, String(req.params.cid));
    }),
  );

  router.put(
    '/collections/:cid/items/order',
    route((req) => {
      const ctx = ctxOf(req);
      store.reorderItems(ctx.userId, String(req.params.cid), req.body?.itemIds);
      return library.collectionDetail(ctx, String(req.params.cid));
    }),
  );

  router.put(
    '/collections/:cid/artwork',
    express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' }),
    route((req) => {
      const ctx = ctxOf(req);
      if (!Buffer.isBuffer(req.body)) throw badRequest('Upload a PNG, JPEG or WebP image');
      store.saveArtwork(ctx.userId, String(req.params.cid), req.body);
      return library.collectionDetail(ctx, String(req.params.cid));
    }),
  );

  router.get(
    '/collections/:cid/artwork',
    route((req, res) => {
      const row = store.getCollection(ctxOf(req).userId, String(req.params.cid));
      const file = store.artworkPath(row);
      if (!file || !fs.existsSync(file)) throw notFound('No uploaded artwork');
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.sendFile(file);
    }),
  );

  // Preferences ---------------------------------------------------------------

  router.get(
    '/preferences',
    route((req) => store.getPreferences(ctxOf(req).userId)),
  );

  router.patch(
    '/preferences',
    route((req) => store.updatePreferences(ctxOf(req).userId, req.body ?? {})),
  );

  // Sample-library assets (mock mode only) ------------------------------------

  if (provider instanceof MockProvider) {
    const mock = provider;
    router.get('/mock/sample.mp4', (_req, res) => {
      res.sendFile(path.join(deps.assetsDir, 'sample', 'sample.mp4'));
    });
    router.get('/mock/sample.webm', (_req, res) => {
      res.sendFile(path.join(deps.assetsDir, 'sample', 'sample.webm'));
    });
    router.get('/mock/sample.en.vtt', (_req, res) => {
      res.type('text/vtt').sendFile(path.join(deps.assetsDir, 'sample', 'sample.en.vtt'));
    });
    router.get(
      '/mock/art/:id/:kind',
      route((req, res) => {
        const film = mock.film(String(req.params.id));
        const kind = String(req.params.kind);
        if (!film || (kind !== 'poster.svg' && kind !== 'backdrop.svg')) throw notFound();
        res.type('image/svg+xml');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.send(kind === 'poster.svg' ? posterSvg(film) : backdropSvg(film));
      }),
    );
  }

  router.use(() => {
    throw notFound('Unknown API endpoint');
  });

  return router;
}
