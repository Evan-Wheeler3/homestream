import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { SessionUser } from '../shared/types.js';
import type { AppConfig } from './config.js';
import { nowIso, type Db } from './db.js';
import { ApiError } from './errors.js';
import { deviceNameFromUserAgent } from '../shared/devices.js';
import type { UserContext } from './providers/types.js';

export const SESSION_COOKIE = 'pc_session';
export const DEVICE_COOKIE = 'pc_device';
/** Required on every state-changing request; cross-site forms cannot set it. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'wheelhouse';

interface SessionRow {
  id_hash: string;
  user_id: string;
  user_name: string;
  is_admin: number;
  source: string;
  media_token: string | null;
  device_id: string;
  device_name: string;
  expires_at: string;
  last_seen_at: string;
}

export interface Session {
  idHash: string;
  user: SessionUser;
  ctx: UserContext;
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: Session;
  }
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export { deviceNameFromUserAgent };

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  create(
    user: SessionUser,
    mediaToken: string | null,
    device: { deviceId: string; deviceName: string },
  ) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + this.config.sessionDays * 86_400_000);
    this.db
      .prepare(
        `INSERT INTO sessions (id_hash, user_id, user_name, is_admin, source, media_token, device_id, device_name, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hash(token),
        user.id,
        user.name,
        user.isAdmin ? 1 : 0,
        this.config.source,
        mediaToken,
        device.deviceId,
        device.deviceName,
        now.toISOString(),
        now.toISOString(),
        expires.toISOString(),
      );
    return { token, expires };
  }

  find(token: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(hash(token)) as
      SessionRow | undefined;
    if (!row) return null;
    // Sessions created for a different media source (e.g. sample mode) are invalid.
    if (Date.parse(row.expires_at) < Date.now() || row.source !== this.config.source) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
      return null;
    }
    // Sliding expiry, written at most once an hour.
    if (Date.now() - Date.parse(row.last_seen_at) > 3_600_000) {
      const expires = new Date(Date.now() + this.config.sessionDays * 86_400_000).toISOString();
      this.db
        .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?')
        .run(nowIso(), expires, row.id_hash);
    }
    return {
      idHash: row.id_hash,
      user: { id: row.user_id, name: row.user_name, isAdmin: row.is_admin === 1 },
      ctx: {
        userId: row.user_id,
        userName: row.user_name,
        token: row.media_token,
        deviceId: row.device_id,
        deviceName: row.device_name,
      },
    };
  }

  delete(idHash: string) {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  purgeExpired() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  }
}

export function cookieOptions(config: AppConfig, req: Request) {
  const secure = config.cookieSecure === 'auto' ? req.secure : config.cookieSecure;
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };
}

export function sessionMiddleware(sessions: SessionStore) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) req.session = sessions.find(token) ?? undefined;
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.session) return next(new ApiError('UNAUTHENTICATED', 'Sign in to continue.'));
  next();
}

/** Reject state-changing requests that lack the custom header (CSRF defence). */
export function requireCsrfHeader(req: Request, _res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.headers[CSRF_HEADER] !== CSRF_VALUE) {
    return next(new ApiError('FORBIDDEN', 'Missing request header.'));
  }
  next();
}

/** Small in-memory limiter for the login endpoint. */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 5 * 60_000,
  ) {}

  check(key: string) {
    const now = Date.now();
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      throw new ApiError(
        'FORBIDDEN',
        'Too many sign-in attempts. Wait a few minutes and try again.',
      );
    }
    recent.push(now);
    this.attempts.set(key, recent);
  }

  reset(key: string) {
    this.attempts.delete(key);
  }
}
