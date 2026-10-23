// The Wheelhouse API on Cloudflare Workers: the same /api routes the React app
// already uses, backed by D1 (data) and R2 (movies, artwork, subtitles).
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { normalizeText, personFilmography, searchPeople } from '../shared/catalog.js';
import { deviceNameFromUserAgent } from '../shared/devices.js';
import { OpenSubtitles } from '../shared/opensubtitles.js';
import { parseSmartRules } from '../shared/rules.js';
import type {
  ApiErrorBody,
  InviteInfo,
  InviteLink,
  MovieQuery,
  NowWatching,
  Person,
  PersonPage,
  PlaybackInfo,
  PlaybackReport,
  PublicProfile,
  RipCandidate,
  ServerStatus,
  SessionInfo,
  SortField,
  SubtitleDelivery,
  SubtitleStatus,
} from '../shared/types.js';
import { ApiError, badRequest, notFound } from '../server/errors.js';
import {
  backupNow,
  getPerson,
  hasAdmin,
  invitePerson,
  listBackups,
  listPeople,
  newLink,
  removePerson,
  renamePerson,
  requireAdmin,
  revokeLink,
  storageReport,
} from './admin.js';
import {
  clearRateLimit,
  createSession,
  findInvite,
  hashPassword,
  iterationsFrom,
  PROFILES_COOKIE,
  rateLimit,
  readSession,
  SESSION_COOKIE,
  SESSION_DAYS,
  toSessionUser,
  validateNewPassword,
  validateUsername,
  verifyPassword,
  type Session,
  type UserRow,
} from './auth.js';
import {
  getUserState,
  mediaKeys,
  mediaUrl,
  movieRow,
  patchUserState,
  type MovieRow,
  type StoredDetail,
  type StoredSubtitle,
} from './catalog.js';
import { nowIso, Sql } from './db.js';
import type { CloudEnv } from './env.js';
import { CloudLibrary } from './library.js';
import { refreshRatings } from './ratings.js';
import {
  episodeDetail,
  episodeInfo,
  episodeRow,
  ingestEpisode,
  ingestShow,
  listIngestedEpisodes,
  listShows,
  showDetail,
} from './shows.js';
import {
  favoriteArt,
  getProfile,
  lookOf,
  removeAvatar,
  saveAvatar,
  updateProfile,
  type ProfileColumns,
} from './profiles.js';
import {
  checkMacToken,
  finishCommand,
  importPerson,
  ingestMovie,
  libraryIndex,
  listIngested,
  queueDriveAction,
  queueRipAction,
  readMacStatus,
  receiveMacStatus,
  type RipAction,
} from './mac.js';
import { isServableKey, serveCachedImage, serveObject } from './media.js';
import { MovieNights, MovieRequests } from './social.js';
import { CloudStore } from './store.js';

export const VERSION = 'cloud-1';

type Vars = { sql: Sql; session: Session | null };
type Env = { Bindings: CloudEnv; Variables: Vars };
type C = Context<Env>;

// -----------------------------------------------------------------------------
// Helpers

const json = async <T = Record<string, unknown>>(c: C): Promise<T> => {
  try {
    return ((await c.req.json()) ?? {}) as T;
  } catch {
    return {} as T;
  }
};

function user(c: C) {
  const session = c.get('session');
  if (!session) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
  return session.user;
}

const library = (c: C) => {
  const sql = c.get('sql');
  return new CloudLibrary(sql, new CloudStore(sql, c.env.MEDIA), user(c).id);
};
const store = (c: C) => new CloudStore(c.get('sql'), c.env.MEDIA);

function itemId(c: C, name = 'id'): string {
  const id = c.req.param(name) ?? '';
  if (!/^[\w-]{1,64}$/.test(id)) throw badRequest('Invalid item id');
  return id;
}

const clientIp = (c: C) => c.req.header('cf-connecting-ip') ?? 'local';
const origin = (c: C) => new URL(c.req.url).origin;

const SORTS = new Set<SortField>(['title', 'year', 'dateAdded', 'runtime', 'rating', 'random']);

export function parseMovieQuery(get: (name: string) => string[] | undefined): MovieQuery {
  const one = (name: string) => get(name)?.[0];
  const list = (name: string) => {
    const values = (get(name) ?? []).flatMap((v) => v.split('|')).map((v) => v.trim());
    const clean = values.filter(Boolean);
    return clean.length ? clean : undefined;
  };
  const int = (name: string) => {
    const v = one(name);
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : undefined;
  };
  const sort = one('sort') as SortField | undefined;
  const watched = one('watched');
  const q = one('q')?.trim();
  return {
    q: q ? q.slice(0, 200) : undefined,
    genres: list('genre'),
    directors: list('director'),
    actors: list('actor'),
    countries: list('country'),
    tags: list('tag'),
    studios: list('studio'),
    ratings: list('rating'),
    yearMin: int('yearMin'),
    yearMax: int('yearMax'),
    runtimeMin: int('runtimeMin'),
    runtimeMax: int('runtimeMax'),
    watched:
      watched === 'watched' || watched === 'unwatched' || watched === 'inProgress'
        ? watched
        : undefined,
    favorite: one('favorite') === '1' || one('favorite') === 'true' ? true : undefined,
    watchlist: one('watchlist') === '1' || one('watchlist') === 'true' ? true : undefined,
    ids: list('ids')
      ?.filter((id) => /^[\w-]{1,64}$/.test(id))
      .slice(0, 50),
    sort: sort && SORTS.has(sort) ? sort : undefined,
    dir: one('dir') === 'asc' || one('dir') === 'desc' ? (one('dir') as 'asc' | 'desc') : undefined,
    offset: int('offset'),
    limit: int('limit'),
  };
}

const movieQuery = (c: C) => parseMovieQuery((name) => c.req.queries(name));

function cookie(c: C, name: string, value: string, maxAgeSeconds: number) {
  setCookie(c, name, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

/** Remembers which accounts signed in on this browser, for "Who's watching?". */
function rememberProfile(c: C, userId: string) {
  const known = (getCookie(c, PROFILES_COOKIE) ?? '')
    .split('.')
    .filter((id) => /^[\w-]{36}$/.test(id));
  const next = [userId, ...known.filter((id) => id !== userId)].slice(0, 8);
  cookie(c, PROFILES_COOKIE, next.join('.'), 400 * 86_400);
}

async function startSession(c: C, row: UserRow): Promise<SessionInfo> {
  const sql = c.get('sql');
  const { token } = await createSession(
    sql,
    row.id,
    deviceNameFromUserAgent(c.req.header('user-agent')),
  );
  cookie(c, SESSION_COOKIE, token, SESSION_DAYS * 86_400);
  rememberProfile(c, row.id);
  await store(c).ensureStarterCollections(row.id);
  return { user: toSessionUser(row), source: 'cloud', ripper: row.is_admin === 1 };
}

async function notifyPhone(
  env: CloudEnv,
  message: { title: string; message: string; tags?: string[]; click?: string },
) {
  if (!env.NTFY_TOPIC) return;
  await fetch(env.NTFY_SERVER || 'https://ntfy.sh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: env.NTFY_TOPIC, ...message }),
  });
}

function openSubtitles(env: CloudEnv) {
  if (!env.OPENSUBTITLES_API_KEY || !env.OPENSUBTITLES_USERNAME || !env.OPENSUBTITLES_PASSWORD) {
    throw badRequest('OpenSubtitles isn’t set up (its secrets are missing).');
  }
  return new OpenSubtitles({
    apiKey: env.OPENSUBTITLES_API_KEY,
    username: env.OPENSUBTITLES_USERNAME,
    password: env.OPENSUBTITLES_PASSWORD,
  });
}

const parseSubtitles = (row: MovieRow) => JSON.parse(row.subtitles || '[]') as StoredSubtitle[];

// -----------------------------------------------------------------------------
// The app

export function createApp() {
  const app = new Hono<Env>().basePath('/api');

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      const body: ApiErrorBody = { error: { code: error.code, message: error.message } };
      return c.json(body, error.status as 400);
    }
    console.error(error);
    const body: ApiErrorBody = {
      error: { code: 'INTERNAL', message: 'Something went wrong on the server.' },
    };
    return c.json(body, 500);
  });

  app.notFound((c) =>
    c.json(
      { error: { code: 'NOT_FOUND', message: 'Unknown API endpoint' } } satisfies ApiErrorBody,
      404,
    ),
  );

  // Every request: database helper, CSRF check, session.
  app.use('*', async (c, next) => {
    c.set('sql', new Sql(c.env.DB));
    const method = c.req.method;
    const isMac = c.req.path.startsWith('/api/mac/');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !isMac) {
      // Cross-site forms can't set this header (CSRF defence), as on the Mac.
      if (c.req.header('x-requested-with') !== 'wheelhouse') {
        throw new ApiError('FORBIDDEN', 'Missing request header.');
      }
    }
    c.set('session', isMac ? null : await readSession(c.get('sql'), getCookie(c, SESSION_COOKIE)));
    await next();
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'same-origin');
  });

  // ---------------------------------------------------------------------------
  // Public

  app.get('/health', (c) => c.json({ ok: true, source: 'cloud', version: VERSION }));

  app.post('/auth/login', async (c) => {
    const sql = c.get('sql');
    const { username, password } = await json<{ username?: unknown; password?: unknown }>(c);
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string') {
      throw badRequest('Enter your username and password.');
    }
    const name = username.trim().toLowerCase();
    await rateLimit(sql, `ip:${clientIp(c)}`, 30, 15 * 60_000);
    await rateLimit(sql, `login:${clientIp(c)}:${name}`, 8, 15 * 60_000);
    // Sign in by username, or by display name from the "Who's watching?" screen.
    const row = await sql.get<UserRow>(
      `SELECT * FROM users WHERE status = 'active' AND (username = ?1 COLLATE NOCASE OR display_name = ?1 COLLATE NOCASE)
       ORDER BY username = ?1 COLLATE NOCASE DESC LIMIT 1`,
      username.trim(),
    );
    const wanted = iterationsFrom(c.env.PBKDF2_ITERATIONS);
    const check = row?.password_hash
      ? await verifyPassword(password, row.password_hash, c.env.PEPPER ?? '', wanted)
      : { ok: false, rehash: false };
    if (!row || !check.ok) {
      throw new ApiError('INVALID_CREDENTIALS', 'That username and password don’t match.');
    }
    if (check.rehash) {
      await sql.run(
        'UPDATE users SET password_hash = ? WHERE id = ?',
        await hashPassword(password, wanted, c.env.PEPPER ?? ''),
        row.id,
      );
    }
    await clearRateLimit(sql, `login:${clientIp(c)}:${name}`);
    return c.json(await startSession(c, row));
  });

  // "Who's watching?": only the people who've signed in on this browser before.
  /** Account ids that signed in on this browser (newest first). */
  const knownProfiles = (c: C) =>
    (getCookie(c, PROFILES_COOKIE) ?? '')
      .split('.')
      .filter((id) => /^[\w-]{36}$/.test(id))
      .slice(0, 8);

  /** A profile's pictures are visible to its own browser, or to anyone signed in. */
  const canSeeProfile = (c: C, id: string) =>
    Boolean(c.get('session')) || knownProfiles(c).includes(id);

  // "Who's watching?": only the people who've signed in on this browser before.
  app.get('/auth/profiles', async (c) => {
    const ids = knownProfiles(c);
    if (ids.length === 0) return c.json({ profiles: [] });
    const rows = await c.get('sql').all<ProfileColumns>(
      `SELECT id, display_name, avatar_key, avatar_emoji, profile_color, tagline, favorite_movie_id
         FROM users WHERE status = 'active' AND id IN (${ids.map(() => '?').join(',')})`,
      ...ids,
    );
    const profiles: PublicProfile[] = ids
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is ProfileColumns => Boolean(r))
      .map((r) => {
        const look = lookOf(r);
        return {
          id: r.id,
          name: r.display_name,
          hasPassword: true,
          image: look.image,
          look,
          tagline: r.tagline ?? null,
          backdrop: r.favorite_movie_id
            ? `/api/auth/profiles/${r.id}/backdrop?v=${encodeURIComponent(r.favorite_movie_id)}`
            : null,
        };
      });
    return c.json({ profiles });
  });

  app.get('/auth/profiles/:id/avatar', async (c) => {
    const id = c.req.param('id');
    if (!canSeeProfile(c, id)) throw notFound();
    const row = await c
      .get('sql')
      .get<{ avatar_key: string | null }>('SELECT avatar_key FROM users WHERE id = ?', id);
    if (!row?.avatar_key) throw notFound();
    return serveCachedImage(c.req.raw, c.env.MEDIA, row.avatar_key, (p) =>
      c.executionCtx.waitUntil(p),
    );
  });

  app.get('/auth/profiles/:id/backdrop', async (c) => {
    const id = c.req.param('id');
    if (!canSeeProfile(c, id)) throw notFound();
    const sql = c.get('sql');
    const row = await sql.get<{ favorite_movie_id: string | null }>(
      'SELECT favorite_movie_id FROM users WHERE id = ?',
      id,
    );
    const art = await favoriteArt(sql, row?.favorite_movie_id);
    if (!art?.key || !isServableKey(art.key)) throw notFound();
    return serveCachedImage(c.req.raw, c.env.MEDIA, art.key, (p) => c.executionCtx.waitUntil(p));
  });

  app.get('/auth/session', (c) => {
    const s = c.get('session');
    if (!s) throw new ApiError('UNAUTHENTICATED', 'Not signed in.');
    const body: SessionInfo = { user: s.user, source: 'cloud', ripper: s.user.isAdmin };
    return c.json(body);
  });

  app.post('/auth/logout', async (c) => {
    const s = c.get('session');
    if (s) await c.get('sql').run('DELETE FROM sessions WHERE id_hash = ?', s.idHash);
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return c.json({ ok: true });
  });

  // Invitation and password-reset links.
  app.get('/invites/:token', async (c) => {
    await rateLimit(c.get('sql'), `invite:${clientIp(c)}`, 30, 15 * 60_000);
    const invite = await findInvite(c.get('sql'), c.req.param('token'));
    const body: InviteInfo = {
      name: invite.display_name,
      kind: invite.kind,
      username: invite.kind === 'reset' ? invite.username : null,
      expiresAt: invite.expires_at,
    };
    return c.json(body);
  });

  app.post('/invites/:token', async (c) => {
    const sql = c.get('sql');
    await rateLimit(sql, `invite:${clientIp(c)}`, 30, 15 * 60_000);
    const invite = await findInvite(sql, c.req.param('token'));
    const body = await json<{ username?: unknown; password?: unknown }>(c);
    const password = validateNewPassword(body.password);
    const now = nowIso();
    const hash = await hashPassword(
      password,
      iterationsFrom(c.env.PBKDF2_ITERATIONS),
      c.env.PEPPER ?? '',
    );
    let username = invite.username;
    if (invite.kind === 'invite') {
      username = validateUsername(body.username);
      const taken = await sql.get(
        'SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE AND id != ?',
        username,
        invite.user_id,
      );
      if (taken) throw new ApiError('CONFLICT', 'That username is taken. Pick another.');
    }
    // Use the link and set the password together, so a link can't be used twice.
    const results = await sql.batch([
      sql.stmt(
        'UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL',
        now,
        invite.id,
      ),
      sql.stmt(
        `UPDATE users SET username = ?, password_hash = ?, status = 'active', updated_at = ?
         WHERE id = ? AND EXISTS (SELECT 1 FROM invites WHERE id = ? AND used_at = ?)`,
        username,
        hash,
        now,
        invite.user_id,
        invite.id,
        now,
      ),
      // A new password signs out every other device.
      sql.stmt('DELETE FROM sessions WHERE user_id = ?', invite.user_id),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) throw badRequest('This link has already been used.');
    const row = await sql.get<UserRow>('SELECT * FROM users WHERE id = ?', invite.user_id);
    if (!row) throw notFound('That account no longer exists.');
    return c.json(await startSession(c, row));
  });

  // Movie night voting from any phone (guests too): join with the code on the TV.
  app.get('/public/nights/:code', async (c) => {
    const nights = new MovieNights(c.get('sql'));
    const id = await nights.idForCode(c.req.param('code').slice(0, 8));
    const voter = c.req.query('voter') ?? '';
    return c.json({
      night: await nights.view(id),
      myVote: voter ? await nights.myVote(id, voter) : null,
    });
  });

  app.post('/public/nights/:code/vote', async (c) => {
    await rateLimit(c.get('sql'), `vote:${clientIp(c)}`, 60, 10 * 60_000);
    const nights = new MovieNights(c.get('sql'));
    const id = await nights.idForCode(c.req.param('code').slice(0, 8));
    const body = await json<{ voterKey?: unknown; name?: unknown; itemId?: unknown }>(c);
    if (typeof body.itemId !== 'string') throw badRequest('Pick a movie.');
    await nights.vote(
      id,
      { key: String(body.voterKey ?? ''), name: String(body.name ?? '') },
      body.itemId,
    );
    return c.json({ night: await nights.view(id), myVote: body.itemId });
  });

  // ---------------------------------------------------------------------------
  // The Mac (bearer token)

  const mac = new Hono<Env>();
  mac.use('*', async (c, next) => {
    checkMacToken(c.env, c.req.header('authorization'));
    await next();
  });
  mac.post('/status', async (c) => c.json(await receiveMacStatus(c.get('sql'), await json(c))));
  mac.post('/commands/:id', async (c) => {
    await finishCommand(
      c.get('sql'),
      c.req.param('id'),
      (await json<{ error?: unknown }>(c)).error,
    );
    return c.json({ ok: true });
  });
  mac.get('/movies', async (c) => c.json({ movies: await listIngested(c.get('sql')) }));
  mac.put('/movies/:id', async (c) => {
    const result = await ingestMovie(c.env, c.get('sql'), c.req.param('id'), await json(c));
    // IMDb and Rotten Tomatoes ratings right away (the Mac sends TMDB's score).
    try {
      await refreshRatings(c.env, c.get('sql'), { ids: [c.req.param('id')] });
    } catch (error) {
      console.warn('Ratings lookup failed', error);
    }
    for (const r of result.fulfilled) {
      c.executionCtx.waitUntil(
        notifyPhone(c.env, {
          title: `Request added: ${r.title}`,
          message: `${r.userName}’s request is in the library.`,
          tags: ['tada'],
        }).catch(() => undefined),
      );
    }
    return c.json(result);
  });
  mac.put('/shows/:id', async (c) =>
    c.json(await ingestShow(c.get('sql'), c.req.param('id'), await json(c))),
  );
  mac.get('/episodes', async (c) => c.json({ episodes: await listIngestedEpisodes(c.get('sql')) }));
  mac.put('/episodes/:id', async (c) =>
    c.json(await ingestEpisode(c.env, c.get('sql'), c.req.param('id'), await json(c))),
  );
  mac.get('/library', async (c) => c.json({ movies: await libraryIndex(c.get('sql')) }));
  mac.post('/import/person', async (c) => c.json(await importPerson(c.get('sql'), await json(c))));
  // The very first administrator's invitation (only while there is none).
  mac.post('/bootstrap', async (c) => {
    const sql = c.get('sql');
    if (await hasAdmin(sql)) {
      throw new ApiError(
        'CONFLICT',
        'There is already an administrator. Invite people from Settings.',
      );
    }
    const body = await json<{ name?: unknown }>(c);
    const pending = await sql.get<{ id: string }>(
      `SELECT id FROM users WHERE display_name = ? COLLATE NOCASE AND status = 'pending'`,
      String(body.name ?? ''),
    );
    let link;
    if (pending) {
      await sql.run('UPDATE users SET is_admin = 1 WHERE id = ?', pending.id);
      link = await newLink(sql, pending.id, 'mac');
    } else {
      link = await invitePerson(sql, { name: body.name, isAdmin: true }, null);
    }
    return c.json({ url: `${origin(c)}/invite/${link.token}`, expiresAt: link.expiresAt });
  });
  app.route('/mac', mac);

  // ---------------------------------------------------------------------------
  // Everything below needs someone signed in

  app.use('*', async (c, next) => {
    user(c);
    await next();
  });

  // Files in R2 ----------------------------------------------------------------

  app.on(['GET', 'HEAD'], '/media/*', async (c) => {
    const key = decodeURIComponent(c.req.path.slice('/api/media/'.length));
    if (!isServableKey(key)) throw notFound();
    if (key.endsWith('.mp4')) {
      return serveObject(c.req.raw, c.env.MEDIA, key, { cacheControl: 'private, max-age=3600' });
    }
    if (key.endsWith('.vtt')) {
      return serveObject(c.req.raw, c.env.MEDIA, key, { cacheControl: 'private, max-age=3600' });
    }
    return serveCachedImage(c.req.raw, c.env.MEDIA, key, (p) => c.executionCtx.waitUntil(p));
  });

  // Status ------------------------------------------------------------------------

  app.get('/status', async (c) => {
    const sql = c.get('sql');
    const me = user(c);
    const [count, lastBackup, rips, watching] = await Promise.all([
      sql.get<{ n: number; updated: string | null }>(
        'SELECT COUNT(*) AS n, MAX(updated_at) AS updated FROM movies',
      ),
      sql.get<{ value: string; updated_at: string }>(
        `SELECT value, updated_at FROM settings WHERE key = 'last_backup'`,
      ),
      me.isAdmin ? readMacStatus(sql) : null,
      me.isAdmin ? nowWatching(sql) : null,
    ]);
    const status: ServerStatus = {
      app: {
        name: 'Wheelhouse',
        version: VERSION,
        startedAt: nowIso(),
        node: 'Cloudflare Workers',
      },
      source: 'cloud',
      mediaServer: {
        url: null,
        reachable: true,
        name: 'Cloudflare R2',
        version: null,
        latencyMs: null,
        error: null,
      },
      catalog: {
        count: count?.n ?? 0,
        lastRefreshed: count?.updated ?? null,
        stale: false,
        lastError: null,
      },
      drives: [],
      backups: me.isAdmin
        ? {
            enabled: true,
            dir: 'R2 bucket (backups/)',
            count: (await listBackups(c.env)).length,
            last: lastBackup?.updated_at ?? null,
          }
        : null,
      ripper: rips ? { ...rips.health, enabled: Boolean(rips.mac?.lastSeen) } : null,
      watching,
    };
    return c.json(status);
  });

  // "Refresh library": checks every movie's video is really in storage.
  app.post('/catalog/refresh', async (c) => {
    const sql = c.get('sql');
    const rows = await sql.all<{ id: string; video_key: string | null }>(
      'SELECT id, video_key FROM movies',
    );
    let missing = 0;
    for (const row of rows) {
      const key = row.video_key ?? mediaKeys.video(row.id);
      const head = await c.env.MEDIA.head(key);
      if (!head) missing++;
      if (Boolean(head) !== Boolean(row.video_key)) {
        await sql.run('UPDATE movies SET video_key = ? WHERE id = ?', head ? key : null, row.id);
      }
    }
    return c.json({ count: rows.length - missing, stale: false });
  });

  // Movies ------------------------------------------------------------------------

  app.get('/movies', async (c) => c.json(await library(c).query(movieQuery(c))));
  app.get('/movies/facets', async (c) => c.json(await library(c).facets()));
  app.get('/movies/sample', async (c) => {
    const count = Math.min(24, Math.max(2, Number(c.req.query('count')) || 8));
    return c.json({ movies: await library(c).sample(movieQuery(c), count) });
  });
  app.get('/movies/random', async (c) => c.json({ movie: await library(c).random(movieQuery(c)) }));
  app.get('/movies/:id', async (c) => c.json(await library(c).detail(itemId(c))));
  app.get('/movies/:id/similar', async (c) => c.json(await library(c).similar(itemId(c))));

  app.get('/wrapped', async (c) => {
    const raw = c.req.query('year') ?? '';
    const year =
      raw === 'all' ? null : /^\d{4}$/.test(raw) ? Number(raw) : new Date().getFullYear();
    return c.json(await library(c).wrapped(year));
  });

  app.get('/watchlist', async (c) => c.json({ movies: await library(c).watchlist() }));
  app.put('/movies/:id/watchlist', async (c) => {
    const { on } = await json<{ on?: unknown }>(c);
    if (typeof on !== 'boolean') throw badRequest('Send { "on": true | false }.');
    await store(c).setWatchlist(user(c).id, itemId(c), on);
    return c.json({ onWatchlist: on });
  });

  const runtimeOf = async (c: C, id: string) => {
    const row = await movieRow(c.get('sql'), id);
    if (row) return (JSON.parse(row.summary) as { runtimeMinutes: number | null }).runtimeMinutes;
    const episode = await episodeInfo(c.get('sql'), id);
    if (!episode) throw notFound('This movie is not in the library.');
    return episode.runtimeMinutes;
  };

  app.put('/movies/:id/favorite', async (c) => {
    const id = itemId(c);
    const { favorite } = await json<{ favorite?: unknown }>(c);
    await patchUserState(c.get('sql'), user(c).id, id, { favorite: Boolean(favorite) });
    return c.json(await getUserState(c.get('sql'), user(c).id, id, await runtimeOf(c, id)));
  });

  app.put('/movies/:id/played', async (c) => {
    const id = itemId(c);
    const { played } = await json<{ played?: unknown }>(c);
    const on = Boolean(played);
    await patchUserState(c.get('sql'), user(c).id, id, {
      played: on,
      positionSeconds: 0,
      ...(on ? { lastPlayed: nowIso(), addPlay: true } : {}),
    });
    return c.json(await getUserState(c.get('sql'), user(c).id, id, await runtimeOf(c, id)));
  });

  app.put('/movies/:id/personal', async (c) =>
    c.json(await store(c).setPersonal(user(c).id, itemId(c), await json(c))),
  );

  // Playback: straight from R2, no transcoding. Every movie is H.264/AAC MP4.
  app.post('/movies/:id/playback', async (c) => {
    const id = itemId(c);
    // Movies and TV episodes play the same way.
    const row =
      (await movieRow(c.get('sql'), id)) ??
      ((await episodeRow(c.get('sql'), id)) as unknown as Awaited<ReturnType<typeof movieRow>>);
    if (!row) throw notFound('This movie is not in the library.');
    if (!row.video_key) throw new ApiError('MEDIA_UNAVAILABLE', 'This file isn’t in storage.');
    const body = await json<{ startSeconds?: unknown }>(c);
    const prefs = await store(c).getPreferences(user(c).id);
    const detail = JSON.parse(row.detail || '{}') as Partial<StoredDetail>;
    const audio = detail.mediaInfo?.audioTracks?.[0];
    const subtitles: SubtitleDelivery[] = parseSubtitles(row).map((s, index) => ({
      index,
      language: s.language,
      title: s.label,
      codec: 'webvtt',
      isDefault: false,
      isExternal: true,
      url: mediaUrl(s.key, row.updated_at),
    }));
    const wantedLanguage = prefs.playback.subtitleLanguage;
    const info: PlaybackInfo = {
      itemId: id,
      mediaSourceId: id,
      playSessionId: crypto.randomUUID(),
      method: 'DirectPlay',
      delivery: 'file',
      url: mediaUrl(row.video_key, row.video_sha256?.slice(0, 12)),
      startSeconds: Math.max(0, Number(body.startSeconds) || 0),
      durationSeconds: row.duration_seconds,
      audioTracks: audio ? [{ ...audio, index: 0, isDefault: true }] : [],
      subtitles,
      selectedAudioIndex: audio ? 0 : null,
      // Subtitles are off unless the person chose a language in Settings.
      selectedSubtitleIndex: wantedLanguage
        ? (subtitles.find((s) => s.language === wantedLanguage)?.index ?? null)
        : null,
      isSample: false,
      transcodeReasons: [],
    };
    return c.json(info);
  });

  for (const event of ['start', 'progress', 'stop'] as const) {
    app.post(`/playback/${event}`, async (c) => {
      const sql = c.get('sql');
      const me = user(c);
      const raw = await json<Partial<PlaybackReport>>(c);
      if (typeof raw.itemId !== 'string' || !/^[\w-]{1,64}$/.test(raw.itemId)) {
        throw badRequest('itemId is required');
      }
      const id = raw.itemId;
      const position = Math.max(0, Number(raw.positionSeconds) || 0);
      const key = String(raw.playSessionId || `${me.id}:${id}`).slice(0, 80);
      const now = nowIso();
      const session = c.get('session')!;
      if (event !== 'stop') {
        await sql.batch([
          sql.stmt(
            `INSERT INTO now_playing (session_key, user_id, user_name, item_id, device, start_position, position_seconds, paused, started_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?8)
             ON CONFLICT(session_key) DO UPDATE SET position_seconds = excluded.position_seconds,
               paused = excluded.paused, updated_at = excluded.updated_at`,
            key,
            me.id,
            me.name,
            id,
            session.deviceName,
            position,
            raw.isPaused ? 1 : 0,
            now,
          ),
          // The resume point, written at most every 30 seconds of progress.
          sql.stmt(
            `INSERT INTO user_state (user_id, item_id, position_seconds, last_played, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(user_id, item_id) DO UPDATE SET position_seconds = excluded.position_seconds,
               last_played = excluded.last_played, updated_at = excluded.updated_at
             WHERE ABS(user_state.position_seconds - excluded.position_seconds) >= 30 OR ?5 = 'start'`,
            me.id,
            id,
            position,
            now,
            event,
          ),
        ]);
        return c.json({ ok: true });
      }
      // Stop: decide resume point / watched like Jellyfin did, and record history.
      const playing = await sql.get<{ start_position: number }>(
        'SELECT start_position FROM now_playing WHERE session_key = ?',
        key,
      );
      const runtime = ((await runtimeOf(c, id)) ?? 0) * 60;
      const finished = runtime > 0 && position >= runtime * 0.9;
      const tooEarly = runtime > 0 && position < Math.min(runtime * 0.05, 300);
      await sql.batch([
        sql.stmt('DELETE FROM now_playing WHERE session_key = ?', key),
        sql.stmt(
          `INSERT INTO user_state (user_id, item_id, played, position_seconds, play_count, last_played, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
           ON CONFLICT(user_id, item_id) DO UPDATE SET
             played = CASE WHEN ?3 = 1 THEN 1 ELSE played END,
             position_seconds = ?4, play_count = play_count + ?5,
             last_played = ?6, updated_at = ?6`,
          me.id,
          id,
          finished ? 1 : 0,
          finished || tooEarly ? 0 : position,
          finished ? 1 : 0,
          now,
        ),
      ]);
      const watched = playing ? position - playing.start_position : 0;
      // A minute or more counts toward your history (Wheelhouse Wrapped).
      if (watched >= 60 || finished)
        await store(c).recordWatch(me.id, id, Math.max(0, watched), finished);
      return c.json({ ok: true, user: await getUserState(sql, me.id, id, runtime / 60 || null) });
    });
  }

  // TV shows ---------------------------------------------------------------------

  app.get('/shows', async (c) => c.json(await listShows(c.get('sql'), user(c).id)));
  app.get('/shows/:id', async (c) => c.json(await showDetail(c.get('sql'), user(c).id, itemId(c))));
  app.get('/episodes/:id', async (c) =>
    c.json(await episodeDetail(c.get('sql'), user(c).id, itemId(c))),
  );
  app.put('/episodes/:id/played', async (c) => {
    const id = itemId(c);
    const sql = c.get('sql');
    const ep = await episodeInfo(sql, id);
    if (!ep) throw notFound('This episode isn’t in the library.');
    const { played } = await json<{ played?: unknown }>(c);
    const on = Boolean(played);
    await patchUserState(sql, user(c).id, id, {
      played: on,
      positionSeconds: 0,
      ...(on ? { lastPlayed: nowIso(), addPlay: true } : {}),
    });
    return c.json(await getUserState(sql, user(c).id, id, ep.runtimeMinutes));
  });

  // People and film series ---------------------------------------------------------

  app.get('/people', async (c) => {
    const q = (c.req.query('q') ?? '').slice(0, 100);
    return c.json({ people: searchPeople((await library(c).snapshot()).movies, q) });
  });
  app.get('/people/:name', async (c) => {
    const name = c.req.param('name').slice(0, 200);
    const page = personFilmography((await library(c).snapshot()).movies, name);
    if (!page.directed.length && !page.actedIn.length) throw notFound('No movies with this person');
    return c.json({ ...page, photo: await personPhoto(c.get('sql'), page) });
  });
  app.get('/franchises', async (c) => c.json({ franchises: await library(c).franchises() }));
  app.get('/franchises/:id', async (c) =>
    c.json(await library(c).franchise(c.req.param('id').slice(0, 100))),
  );

  // Home, collections, preferences ------------------------------------------------------

  app.get('/home', async (c) => c.json(await library(c).home()));

  app.get('/collections', async (c) => c.json(await library(c).listCollections()));
  app.post('/collections', async (c) => {
    const row = await store(c).createCollection(user(c).id, await json(c));
    return c.json(await library(c).collectionDetail(row.id), 201);
  });
  app.post('/collections/preview', async (c) => {
    let rules;
    try {
      rules = parseSmartRules((await json<{ rules?: unknown }>(c)).rules);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Invalid rules');
    }
    return c.json(await library(c).previewRules(rules));
  });
  app.put('/collections/order', async (c) => {
    await store(c).reorderCollections(user(c).id, (await json<{ ids?: unknown }>(c)).ids);
    return c.json({ ok: true });
  });
  app.get('/collections/:cid', async (c) =>
    c.json(await library(c).collectionDetail(c.req.param('cid'))),
  );
  app.patch('/collections/:cid', async (c) => {
    await store(c).updateCollection(user(c).id, c.req.param('cid'), await json(c));
    return c.json(await library(c).collectionDetail(c.req.param('cid')));
  });
  app.delete('/collections/:cid', async (c) => {
    const id = c.req.param('cid');
    const s = store(c);
    await s.deleteCollection(user(c).id, id);
    const prefs = await s.getPreferences(user(c).id);
    await s.updatePreferences(user(c).id, {
      homeSections: prefs.homeSections.filter((x) => x.id !== `collection:${id}`),
    });
    return c.json({ ok: true });
  });
  app.post('/collections/:cid/items', async (c) => {
    await store(c).addItems(
      user(c).id,
      c.req.param('cid'),
      (await json<{ itemIds?: unknown }>(c)).itemIds,
    );
    return c.json(await library(c).collectionDetail(c.req.param('cid')));
  });
  app.delete('/collections/:cid/items/:id', async (c) => {
    await store(c).removeItem(user(c).id, c.req.param('cid'), itemId(c));
    return c.json(await library(c).collectionDetail(c.req.param('cid')));
  });
  app.put('/collections/:cid/items/order', async (c) => {
    await store(c).reorderItems(
      user(c).id,
      c.req.param('cid'),
      (await json<{ itemIds?: unknown }>(c)).itemIds,
    );
    return c.json(await library(c).collectionDetail(c.req.param('cid')));
  });
  app.put('/collections/:cid/artwork', async (c) => {
    const type = c.req.header('content-type') ?? '';
    if (!/^image\/(png|jpeg|webp)$/.test(type))
      throw badRequest('Upload a PNG, JPEG or WebP image');
    const body = new Uint8Array(await c.req.arrayBuffer());
    await store(c).saveArtwork(user(c).id, c.req.param('cid'), body);
    return c.json(await library(c).collectionDetail(c.req.param('cid')));
  });
  app.get('/collections/:cid/artwork', async (c) => {
    const s = store(c);
    const row = await s.getCollection(user(c).id, c.req.param('cid'));
    const key = s.artworkKey(row);
    if (!key) throw notFound('No uploaded artwork');
    return serveObject(c.req.raw, c.env.MEDIA, key, {
      cacheControl: 'private, max-age=31536000, immutable',
    });
  });

  app.get('/profile', async (c) => c.json(await getProfile(c.get('sql'), user(c).id)));
  app.patch('/profile', async (c) =>
    c.json(await updateProfile(c.get('sql'), user(c).id, await json(c))),
  );
  app.put('/profile/avatar', async (c) =>
    c.json(
      await saveAvatar(
        c.env,
        c.get('sql'),
        user(c).id,
        c.req.header('content-type') ?? '',
        new Uint8Array(await c.req.arrayBuffer()),
      ),
    ),
  );
  app.delete('/profile/avatar', async (c) =>
    c.json(await removeAvatar(c.env, c.get('sql'), user(c).id)),
  );

  app.get('/preferences', async (c) => c.json(await store(c).getPreferences(user(c).id)));
  app.patch('/preferences', async (c) =>
    c.json(await store(c).updatePreferences(user(c).id, await json(c))),
  );

  // Movie night ------------------------------------------------------------------------

  app.post('/nights', async (c) => {
    const me = user(c);
    const body = await json<{ count?: unknown; pool?: unknown; ids?: unknown }>(c);
    const count = Math.min(8, Math.max(2, Number(body.count) || 4));
    const pool = String(body.pool ?? 'unwatched');
    const query: MovieQuery = {
      watched: pool === 'unwatched' ? 'unwatched' : undefined,
      favorite: pool === 'favorites' || undefined,
      watchlist: pool === 'watchlist' || undefined,
    };
    if (Array.isArray(body.ids)) query.ids = body.ids.map(String).slice(0, 8);
    const movies = await library(c).sample(query, count);
    if (movies.length < 2) throw badRequest('Not enough movies to choose from. Try “Everything”.');
    const nights = new MovieNights(c.get('sql'));
    return c.json(await nights.view(await nights.create({ id: me.id, name: me.name }, movies)));
  });
  app.get('/nights/current', async (c) => {
    const nights = new MovieNights(c.get('sql'));
    const id = await nights.currentFor(user(c).id);
    return c.json({ night: id ? await nights.view(id) : null });
  });
  app.post('/nights/:id/close', async (c) => {
    const nights = new MovieNights(c.get('sql'));
    await nights.close(c.req.param('id'), user(c).id);
    return c.json(await nights.view(c.req.param('id')));
  });

  // Requests ---------------------------------------------------------------------------

  app.get('/requests', async (c) => {
    const me = user(c);
    return c.json({
      requests: await new MovieRequests(c.get('sql')).list({ id: me.id, isAdmin: me.isAdmin }),
    });
  });
  app.post('/requests', async (c) => {
    const me = user(c);
    const created = await new MovieRequests(c.get('sql')).create(
      { id: me.id, name: me.name },
      await json(c),
      (await library(c).snapshot()).movies,
    );
    const year = created.year ? ` (${created.year})` : '';
    c.executionCtx.waitUntil(
      notifyPhone(c.env, {
        title: `Movie request: ${created.title}${year}`,
        message: `${created.userName} asked for it${created.note ? `: “${created.note}”` : '.'}`,
        tags: ['clapper'],
        click: `${origin(c)}/requests`,
      }).catch(() => undefined),
    );
    return c.json(created, 201);
  });
  app.patch('/requests/:id', async (c) => {
    requireAdmin(user(c), 'answer requests');
    const { status } = await json<{ status?: unknown }>(c);
    if (status !== 'open' && status !== 'added' && status !== 'declined') {
      throw badRequest('Status must be open, added or declined.');
    }
    return c.json(
      await new MovieRequests(c.get('sql')).setStatus(c.req.param('id'), status, user(c).id),
    );
  });
  app.delete('/requests/:id', async (c) => {
    const me = user(c);
    await new MovieRequests(c.get('sql')).remove(c.req.param('id'), {
      id: me.id,
      isAdmin: me.isAdmin,
    });
    return c.body(null, 204);
  });

  // Discs: the Mac's ripper, as last reported ----------------------------------------------

  app.get('/rips', async (c) => {
    requireAdmin(user(c), 'manage disc rips');
    return c.json(await readMacStatus(c.get('sql')));
  });
  const ripAction = (action: RipAction) => async (c: C) => {
    requireAdmin(user(c), 'manage disc rips');
    const id = c.req.param('id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(id)) throw badRequest('Invalid rip id');
    const payload = c.req.method === 'DELETE' ? {} : await json(c);
    const job = await queueRipAction(c.get('sql'), id, action, payload, user(c).id);
    return c.json(action === 'dismiss' ? { ok: true } : job);
  };
  app.post('/rips/eject', async (c) => {
    requireAdmin(user(c), 'manage disc rips');
    await queueDriveAction(c.get('sql'), 'eject', user(c).id);
    return c.json({ ok: true });
  });
  app.post('/rips/:id/choose', ripAction('choose'));
  app.post('/rips/:id/name', ripAction('name'));
  app.post('/rips/:id/episodes', ripAction('episodes'));
  app.post('/rips/:id/kind', ripAction('kind'));
  app.post('/rips/:id/retry', ripAction('retry'));
  app.delete('/rips/:id', ripAction('dismiss'));
  app.get('/rips/search', async (c) => {
    requireAdmin(user(c), 'manage disc rips');
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    if (!q) throw badRequest('Type a title to search for.');
    return c.json({
      results: await tmdbSearch(c.env, q, c.req.query('kind') === 'tv' ? 'tv' : 'movie'),
    });
  });
  app.post('/rips/test-notification', async (c) => {
    requireAdmin(user(c), 'send test notifications');
    if (!c.env.NTFY_TOPIC)
      throw badRequest('Phone notifications aren’t set up (no NTFY_TOPIC secret).');
    await notifyPhone(c.env, {
      title: '🎬 Wheelhouse test',
      message: 'Notifications from the cloud are working.',
      tags: ['white_check_mark'],
    });
    return c.json({ ok: true });
  });

  // Administration --------------------------------------------------------------------

  const admin = new Hono<Env>();
  admin.use('*', async (c, next) => {
    requireAdmin(user(c), 'manage Wheelhouse');
    await next();
  });

  admin.get('/people', async (c) => c.json({ people: await listPeople(c.get('sql')) }));
  admin.post('/people', async (c) => {
    const body = await json<{ name?: unknown; days?: unknown; isAdmin?: unknown }>(c);
    const made = await invitePerson(c.get('sql'), body, user(c).id);
    const link: InviteLink = {
      url: `${origin(c)}/invite/${made.token}`,
      expiresAt: made.expiresAt,
      person: await getPerson(c.get('sql'), made.id),
    };
    return c.json(link, 201);
  });
  admin.post('/people/:id/link', async (c) => {
    const { days } = await json<{ days?: unknown }>(c);
    const made = await newLink(
      c.get('sql'),
      c.req.param('id'),
      user(c).id,
      days === undefined ? 7 : Number(days),
    );
    const link: InviteLink = {
      url: `${origin(c)}/invite/${made.token}`,
      expiresAt: made.expiresAt,
      person: await getPerson(c.get('sql'), c.req.param('id')),
    };
    return c.json(link, 201);
  });
  admin.patch('/people/:id', async (c) => {
    await renamePerson(c.get('sql'), c.req.param('id'), (await json<{ name?: unknown }>(c)).name);
    return c.json(await getPerson(c.get('sql'), c.req.param('id')));
  });
  admin.delete('/people/:id', async (c) => {
    await removePerson(c.get('sql'), c.req.param('id'), user(c).id);
    return c.json({ ok: true });
  });
  admin.delete('/links/:id', async (c) => {
    await revokeLink(c.get('sql'), c.req.param('id'));
    return c.json({ ok: true });
  });

  admin.post('/ratings/refresh', async (c) => {
    if (!c.env.OMDB_API_KEY) {
      throw badRequest('IMDb ratings aren’t set up (no OMDB_API_KEY secret).');
    }
    try {
      return c.json(await refreshRatings(c.env, c.get('sql')));
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error));
    }
  });

  admin.get('/storage', async (c) => c.json(await storageReport(c.env, c.get('sql'))));
  admin.get('/backups', async (c) => c.json({ backups: await listBackups(c.env) }));
  admin.post('/backups', async (c) => {
    await backupNow(c.env, c.get('sql'));
    return c.json({ backups: await listBackups(c.env) });
  });

  admin.get('/subtitles', async (c) => {
    const rows = await c.get('sql').all<{
      id: string;
      title: string;
      year: number | null;
      subtitle_status: SubtitleStatus['status'];
      subtitles: string;
    }>('SELECT id, title, year, subtitle_status, subtitles FROM movies ORDER BY title COLLATE NOCASE');
    const list: SubtitleStatus[] = rows.map((r) => {
      const first = (JSON.parse(r.subtitles || '[]') as StoredSubtitle[])[0];
      return {
        id: r.id,
        title: r.title,
        year: r.year,
        status: r.subtitle_status,
        label: first?.label ?? null,
        release: first?.release ?? null,
      };
    });
    return c.json({ movies: list });
  });
  admin.get('/subtitles/:id/choices', async (c) => {
    const row = await movieRow(c.get('sql'), itemId(c));
    if (!row) throw notFound();
    const found = await openSubtitles(c.env).search({ imdbId: row.imdb_id, tmdbId: row.tmdb_id });
    return c.json({
      choices: found.slice(0, 15).map((x) => ({
        fileId: x.fileId,
        release: x.release,
        downloads: x.downloads,
        hearingImpaired: x.hearingImpaired,
      })),
    });
  });
  // "Find subtitles": the best match whose timing fits, or a specific one.
  admin.post('/subtitles/:id', async (c) => {
    const sql = c.get('sql');
    const id = itemId(c);
    const row = await movieRow(sql, id);
    if (!row) throw notFound();
    const { fileId } = await json<{ fileId?: unknown }>(c);
    const current = parseSubtitles(row);
    const found = await openSubtitles(c.env).findBest(
      { imdbId: row.imdb_id, tmdbId: row.tmdb_id },
      row.duration_seconds,
      {
        maxTries: 3,
        fileId: typeof fileId === 'number' ? fileId : undefined,
        skipFileIds: current.map((s) => s.fileId ?? 0).filter(Boolean),
      },
    );
    if (!found)
      throw badRequest('No English subtitles with matching timing were found. Try picking one.');
    const key = mediaKeys.subtitle(id, 'eng', 'opensubtitles');
    await c.env.MEDIA.put(key, found.vtt, {
      httpMetadata: { contentType: 'text/vtt; charset=utf-8' },
    });
    const subtitle: StoredSubtitle = {
      language: 'eng',
      label: 'English',
      key,
      source: 'opensubtitles',
      fileId: found.candidate.fileId,
      release: found.candidate.release,
    };
    // A downloaded file replaces any other downloaded one; disc subtitles stay first.
    const next = [...current.filter((s) => s.source === 'disc'), subtitle];
    await sql.run(
      `UPDATE movies SET subtitles = ?, subtitle_status = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(next),
      next.some((s) => s.source === 'disc') ? 'disc' : 'downloaded',
      nowIso(),
      id,
    );
    return c.json({ ok: true, release: found.candidate.release, timing: found.timing });
  });

  app.route('/admin', admin);

  // Things that only exist on the Mac edition.
  for (const path of [
    '/system/update',
    '/system/share',
    '/limits',
    '/limits/:userId',
    '/backups',
  ]) {
    app.all(path, () => {
      throw notFound('Not part of the cloud edition.');
    });
  }

  return app;
}

async function nowWatching(sql: Sql): Promise<NowWatching[]> {
  const since = new Date(Date.now() - 2 * 60_000).toISOString();
  const rows = await sql.all<{
    user_name: string;
    item_id: string;
    device: string;
    position_seconds: number;
    paused: number;
    started_at: string;
    summary: string | null;
  }>(
    `SELECT n.*, COALESCE(m.summary, json_object(
        'title', s.title || ' · S' || e.season_number || 'E' || e.number,
        'year', NULL,
        'runtimeMinutes', e.runtime_minutes,
        'images', json_object('poster', json_extract(s.summary, '$.images.poster'))
      )) AS summary
     FROM now_playing n
     LEFT JOIN movies m ON m.id = n.item_id
     LEFT JOIN episodes e ON e.id = n.item_id
     LEFT JOIN shows s ON s.id = e.show_id
     WHERE n.updated_at >= ? ORDER BY n.started_at`,
    since,
  );
  return rows.map((r) => {
    const m = r.summary
      ? (JSON.parse(r.summary) as {
          title: string;
          year: number | null;
          runtimeMinutes: number | null;
          images: { poster: string | null };
        })
      : null;
    return {
      userName: r.user_name,
      itemId: r.item_id,
      title: m?.title ?? 'A movie',
      year: m?.year ?? null,
      poster: m?.images.poster ?? null,
      positionSeconds: r.position_seconds,
      runtimeSeconds: m?.runtimeMinutes ? m.runtimeMinutes * 60 : null,
      paused: r.paused === 1,
      method: 'DirectPlay',
      place: 'away',
      device: r.device,
      limit: null,
      startedAt: r.started_at,
    };
  });
}

async function tmdbSearch(env: CloudEnv, q: string, kind: 'movie' | 'tv'): Promise<RipCandidate[]> {
  if (!env.TMDB_READ_TOKEN) throw badRequest('TMDB isn’t set up (no TMDB_READ_TOKEN secret).');
  const res = await fetch(
    `https://api.themoviedb.org/3/search/${kind}?query=${encodeURIComponent(q)}&include_adult=false`,
    { headers: { Authorization: `Bearer ${env.TMDB_READ_TOKEN}`, Accept: 'application/json' } },
  );
  if (!res.ok) throw new ApiError('MEDIA_SERVER_ERROR', `TMDB search failed (${res.status}).`);
  const body = (await res.json()) as {
    results?: {
      id: number;
      title?: string;
      name?: string;
      release_date?: string;
      first_air_date?: string;
    }[];
  };
  return (body.results ?? []).slice(0, 10).map((r) => {
    const date = r.release_date || r.first_air_date || '';
    return {
      title: r.title ?? r.name ?? '',
      year: date ? Number(date.slice(0, 4)) : null,
      tmdbId: String(r.id),
      imdbId: null,
    };
  });
}

/** A person's photo, from the cast list of one of the movies they acted in. */
async function personPhoto(sql: Sql, page: PersonPage): Promise<string | null> {
  const ids = page.actedIn.slice(0, 20).map((m) => m.id);
  if (!ids.length) return null;
  const key = normalizeText(page.name);
  const rows = await sql.all<{ detail: string }>(
    `SELECT detail FROM movies WHERE id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  );
  for (const row of rows) {
    const cast = (JSON.parse(row.detail || '{}') as { cast?: Person[] }).cast ?? [];
    const found = cast.find((p) => p.image && normalizeText(p.name) === key);
    if (found?.image) return found.image;
  }
  return null;
}
