// Cloudflare Worker entry: the API (everything under /api), the nightly backup,
// and the React app's files for every other path.
import { backupNow } from './admin.js';
import { createApp } from './app.js';
import { readSession, SESSION_COOKIE } from './auth.js';
import { nowIso, Sql } from './db.js';
import { refreshRatings } from './ratings.js';
import type { CloudEnv } from './env.js';
import { THEATER_USER_HEADER } from './theater.js';

export { TheaterHouse } from './theater.js';

const app = createApp();

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export default {
  async fetch(request: Request, env: CloudEnv, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/theater/socket') return theaterSocket(request, env);
    if (url.pathname.startsWith('/api/')) return app.fetch(request, env, ctx as never);
    if (!env.ASSETS) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },

  /** Nightly: back up the database to R2, tidy away expired records, refresh some ratings. */
  async scheduled(_controller: unknown, env: CloudEnv, ctx: Ctx) {
    const sql = new Sql(env.DB);
    ctx.waitUntil(
      (async () => {
        await backupNow(env, sql);
        const now = nowIso();
        const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
        await sql.batch([
          sql.stmt('DELETE FROM sessions WHERE expires_at < ?', now),
          sql.stmt('DELETE FROM rate_limits WHERE reset_at < ?', Date.now()),
          sql.stmt('DELETE FROM now_playing WHERE updated_at < ?', dayAgo),
          sql.stmt('DELETE FROM mac_commands WHERE created_at < ?', dayAgo),
        ]);
        await refreshRatings(env, sql).catch((error) =>
          console.warn('Nightly ratings refresh failed', error),
        );
      })(),
    );
  },
};

const cookie = (request: Request, name: string) =>
  request.headers
    .get('cookie')
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/** Joins the shared theater (a WebSocket), as the person signed in. */
async function theaterSocket(request: Request, env: CloudEnv): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket', { status: 426 });
  }
  // Only Wheelhouse's own pages may open it with your cookie.
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return new Response('Forbidden', { status: 403 });
  }
  if (!env.THEATER) return new Response('The theater isn’t set up', { status: 503 });
  const session = await readSession(new Sql(env.DB), cookie(request, SESSION_COOKIE));
  if (!session) return new Response('Sign in to continue', { status: 401 });
  const { user } = session;
  const headers = new Headers(request.headers);
  headers.set(
    THEATER_USER_HEADER,
    JSON.stringify({
      userId: user.id,
      name: user.name,
      color: user.look?.color ?? null,
      emoji: user.look?.emoji ?? null,
      image: user.look?.image ?? null,
    }),
  );
  const house = env.THEATER.get(env.THEATER.idFromName('wheelhouse'));
  return house.fetch(new Request(request.url, { headers }));
}
