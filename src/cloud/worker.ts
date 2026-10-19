// Cloudflare Worker entry: the API (everything under /api), the nightly backup,
// and the React app's files for every other path.
import { backupNow } from './admin.js';
import { createApp } from './app.js';
import { nowIso, Sql } from './db.js';
import { refreshRatings } from './ratings.js';
import type { CloudEnv } from './env.js';

const app = createApp();

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export default {
  async fetch(request: Request, env: CloudEnv, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
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
