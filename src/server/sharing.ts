import os from 'node:os';
import type { NetworkPlace, NowWatching, ShareInfo, StreamLimit } from '../shared/types.js';
import { nowIso, type Db } from './db.js';
import { badRequest } from './errors.js';

/** Tailscale gives devices addresses in 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, '');
  const m = /^100\.(\d+)\./.exec(v4);
  if (m) return Number(m[1]) >= 64 && Number(m[1]) <= 127;
  return /^fd7a:115c:a1e0:/i.test(ip);
}

/**
 * Whether a request comes from the home network or from away (a Tailscale
 * device, or anywhere on the internet). Private and loopback addresses are home.
 */
export function networkPlace(ip: string | undefined): NetworkPlace {
  if (!ip) return 'home';
  if (isTailscaleAddress(ip)) return 'away';
  const v4 = ip.replace(/^::ffff:/i, '');
  if (/^(10|127)\./.test(v4) || /^192\.168\./.test(v4) || /^169\.254\./.test(v4)) return 'home';
  const b = /^172\.(\d+)\./.exec(v4);
  if (b && Number(b[1]) >= 16 && Number(b[1]) <= 31) return 'home';
  if (ip === '::1' || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip)) return 'home';
  return 'away';
}

/** Addresses this computer can be reached at: Tailscale first, then the home network. */
export function shareInfo(
  port: number,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  hostname = os.hostname(),
): ShareInfo {
  const addresses: ShareInfo['addresses'] = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== 'IPv4') continue;
      addresses.push({
        url: `http://${a.address}:${port}`,
        kind: isTailscaleAddress(a.address) ? 'tailscale' : 'home',
      });
    }
  }
  addresses.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'tailscale' ? -1 : 1));
  return {
    addresses,
    hostname: hostname.replace(/\.local$/i, ''),
    port,
    tailscale: addresses.some((a) => a.kind === 'tailscale'),
  };
}

interface LimitRow {
  user_id: string;
  user_name: string;
  max_bitrate: number | null;
  away_only: number;
}

/** Per-person streaming caps, so viewers away from home don't use up the home upload. */
export class StreamLimits {
  constructor(private readonly db: Db) {}

  /** Everyone who has signed in (or has a limit), with their limit. */
  list(): StreamLimit[] {
    const rows = this.db
      .prepare(
        `SELECT u.user_id, u.user_name, MAX(u.last_seen) AS last_seen,
                l.max_bitrate, COALESCE(l.away_only, 0) AS away_only
         FROM (
           SELECT user_id, user_name, last_seen_at AS last_seen FROM sessions
           UNION ALL
           SELECT user_id, user_name, NULL FROM stream_limits
         ) u
         LEFT JOIN stream_limits l ON l.user_id = u.user_id
         GROUP BY u.user_id
         ORDER BY u.user_name COLLATE NOCASE`,
      )
      .all() as unknown as (LimitRow & { last_seen: string | null })[];
    return rows.map((r) => ({
      userId: r.user_id,
      userName: r.user_name,
      maxBitrate: r.max_bitrate,
      awayOnly: Boolean(r.away_only),
      lastSeen: r.last_seen,
    }));
  }

  set(user: { id: string; name: string }, maxBitrate: number | null, awayOnly: boolean) {
    if (maxBitrate !== null && (!Number.isFinite(maxBitrate) || maxBitrate < 250_000)) {
      throw badRequest('The limit must be at least 0.25 Mbps.');
    }
    if (maxBitrate === null) {
      this.db.prepare('DELETE FROM stream_limits WHERE user_id = ?').run(user.id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO stream_limits (user_id, user_name, max_bitrate, away_only, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET user_name = excluded.user_name,
           max_bitrate = excluded.max_bitrate, away_only = excluded.away_only,
           updated_at = excluded.updated_at`,
      )
      .run(user.id, user.name, Math.round(maxBitrate), awayOnly ? 1 : 0, nowIso());
  }

  /** Name of a user who has signed in here (limits are only set for known people). */
  knownName(userId: string): string | null {
    return this.list().find((u) => u.userId === userId)?.userName ?? null;
  }

  /** The cap that applies to this person from this place, or null. */
  limitFor(userId: string, place: NetworkPlace): number | null {
    const row = this.db
      .prepare('SELECT max_bitrate, away_only FROM stream_limits WHERE user_id = ?')
      .get(userId) as { max_bitrate: number | null; away_only: number } | undefined;
    if (!row?.max_bitrate) return null;
    if (row.away_only && place === 'home') return null;
    return row.max_bitrate;
  }
}

/** The lower of the person's own setting and the administrator's limit. */
export function effectiveBitrate(own: number | null, limit: number | null): number | null {
  if (own == null) return limit;
  if (limit == null) return own;
  return Math.min(own, limit);
}

const STALE_MS = 2 * 60_000;

type Watching = NowWatching & { sessionId: string; updatedAt: number };

/** Who is playing what, from the player's start/progress/stop reports. */
export class NowPlaying {
  private readonly sessions = new Map<string, Watching>();

  update(sessionId: string, entry: Omit<NowWatching, 'startedAt'>) {
    const previous = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      ...entry,
      sessionId,
      startedAt: previous?.startedAt ?? nowIso(),
      updatedAt: Date.now(),
    });
    if (this.sessions.size > 200) this.sessions.delete(this.sessions.keys().next().value!);
  }

  stop(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  /** Current viewers; anything not heard from for two minutes has stopped. */
  list(): NowWatching[] {
    const cutoff = Date.now() - STALE_MS;
    const out: NowWatching[] = [];
    for (const [id, w] of this.sessions) {
      if (w.updatedAt < cutoff) {
        this.sessions.delete(id);
        continue;
      }
      const { sessionId: _s, updatedAt: _u, ...rest } = w;
      out.push(rest);
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}
