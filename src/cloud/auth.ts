import type { SessionUser } from '../shared/types.js';
import { ApiError, badRequest } from '../server/errors.js';
import { nowIso, randomId, type Sql } from './db.js';

// -----------------------------------------------------------------------------
// Encoding and hashing

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares without leaking where the first difference is. */
export function timingSafeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const x = typeof a === 'string' ? encoder.encode(a) : a;
  const y = typeof b === 'string' ? encoder.encode(b) : b;
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// -----------------------------------------------------------------------------
// Passwords: PBKDF2-SHA256 with a per-user salt, over an HMAC of the password
// with a secret pepper. Stored as pbkdf2-sha256$<iterations>$<salt>$<hash>, so
// the strength can be raised later and old hashes still verify.

export const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_ITERATIONS = 10_000;
/** Cloudflare's WebCrypto refuses more than this. */
const MAX_ITERATIONS = 100_000;

export function iterationsFrom(setting: string | undefined): number {
  const n = Number(setting);
  return Number.isInteger(n) && n >= 1000 ? Math.min(n, MAX_ITERATIONS) : DEFAULT_ITERATIONS;
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  pepper: string,
) {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper || 'wheelhouse'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const peppered = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(password));
  const key = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations: number, pepper: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations, pepper);
  return `pbkdf2-sha256$${iterations}$${base64url(salt)}$${base64url(hash)}`;
}

/** Whether the password matches, and whether the stored hash is weaker than wanted. */
export async function verifyPassword(
  password: string,
  stored: string,
  pepper: string,
  wantedIterations: number,
): Promise<{ ok: boolean; rehash: boolean }> {
  const [scheme, iter, salt, hash] = stored.split('$');
  const iterations = Number(iter);
  if (scheme !== 'pbkdf2-sha256' || !salt || !hash || !Number.isInteger(iterations)) {
    return { ok: false, rehash: false };
  }
  const actual = await derive(password, fromBase64url(salt), iterations, pepper);
  const ok = timingSafeEqual(actual, fromBase64url(hash));
  return { ok, rehash: ok && iterations < wantedIterations };
}

export function validateNewPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 200) throw badRequest('That password is too long.');
  return password;
}

export function validateUsername(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(name)) {
    throw badRequest(
      'Usernames are 2–32 letters or numbers (dots, dashes and underscores are fine), with no spaces.',
    );
  }
  return name;
}

// -----------------------------------------------------------------------------
// Rate limiting (fixed window, kept in D1 so every Worker instance shares it)

export async function rateLimit(sql: Sql, key: string, max: number, windowMs: number) {
  const now = Date.now();
  const row = await sql.get<{ count: number; reset_at: number }>(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
     RETURNING count, reset_at`,
    key,
    now + windowMs,
    now,
    now,
  );
  if (row && row.count > max) {
    const minutes = Math.max(1, Math.ceil((row.reset_at - now) / 60_000));
    throw new ApiError(
      'FORBIDDEN',
      `Too many attempts. Wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`,
    );
  }
}

export async function clearRateLimit(sql: Sql, key: string) {
  await sql.run('DELETE FROM rate_limits WHERE key = ?', key);
}

// -----------------------------------------------------------------------------
// Users

export interface UserRow {
  id: string;
  display_name: string;
  username: string | null;
  password_hash: string | null;
  is_admin: number;
  status: 'pending' | 'active';
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

export const toSessionUser = (u: UserRow): SessionUser => ({
  id: u.id,
  name: u.display_name,
  isAdmin: u.is_admin === 1,
});

// -----------------------------------------------------------------------------
// Sessions: a random token in an HttpOnly cookie; only its hash is stored.

export const SESSION_COOKIE = 'wh_session';
/** Accounts that have signed in on this browser, for "Who's watching?". */
export const PROFILES_COOKIE = 'wh_profiles';
export const SESSION_DAYS = 30;
const TOUCH_EVERY_MS = 10 * 60_000;

export interface Session {
  idHash: string;
  user: SessionUser;
  deviceName: string;
}

export async function createSession(sql: Sql, userId: string, deviceName: string) {
  const token = randomToken();
  const now = nowIso();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await sql.batch([
    sql.stmt(
      `INSERT INTO sessions (id_hash, user_id, device_name, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      await sha256(token),
      userId,
      deviceName,
      now,
      now,
      expires.toISOString(),
    ),
    sql.stmt('UPDATE users SET last_seen_at = ? WHERE id = ?', now, userId),
  ]);
  return { token, expires };
}

export async function readSession(sql: Sql, token: string | undefined): Promise<Session | null> {
  if (!token || token.length > 100) return null;
  const idHash = await sha256(token);
  const row = await sql.get<
    UserRow & { device_name: string; s_last_seen: string; expires_at: string }
  >(
    `SELECT u.*, s.device_name, s.last_seen_at AS s_last_seen, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND u.status = 'active'`,
    idHash,
  );
  if (!row) return null;
  if (row.expires_at <= nowIso()) {
    await sql.run('DELETE FROM sessions WHERE id_hash = ?', idHash);
    return null;
  }
  // Sliding expiry, written at most every ten minutes.
  if (Date.now() - Date.parse(row.s_last_seen) > TOUCH_EVERY_MS) {
    const now = nowIso();
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
    await sql.batch([
      sql.stmt(
        'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?',
        now,
        expires,
        idHash,
      ),
      sql.stmt('UPDATE users SET last_seen_at = ? WHERE id = ?', now, row.id),
    ]);
  }
  return { idHash, user: toSessionUser(row), deviceName: row.device_name };
}

// -----------------------------------------------------------------------------
// Invitations and password resets: single-use links that expire.

export const INVITE_DAYS = 7;

export interface InviteRow {
  id: string;
  token_hash: string;
  user_id: string;
  kind: 'invite' | 'reset';
  created_by: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

/** Makes a new link for a user, revoking any earlier unused one. Returns the token. */
export async function issueInvite(
  sql: Sql,
  userId: string,
  kind: 'invite' | 'reset',
  createdBy: string | null,
  days = INVITE_DAYS,
): Promise<{ token: string; expiresAt: string }> {
  if (!Number.isFinite(days) || days < 1 || days > 90) {
    throw badRequest('Links can last from 1 to 90 days.');
  }
  const token = randomToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + Math.round(days) * 86_400_000).toISOString();
  await sql.batch([
    sql.stmt(
      'UPDATE invites SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL',
      now,
      userId,
    ),
    sql.stmt(
      `INSERT INTO invites (id, token_hash, user_id, kind, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      randomId(),
      await sha256(token),
      userId,
      kind,
      createdBy,
      now,
      expiresAt,
    ),
  ]);
  return { token, expiresAt };
}

/** The usable invite for a token, or an error saying why it can't be used. */
export async function findInvite(sql: Sql, token: string) {
  if (!/^[\w-]{20,100}$/.test(token)) throw badRequest('This link isn’t valid.');
  const row = await sql.get<InviteRow & { display_name: string; username: string | null }>(
    `SELECT i.*, u.display_name, u.username FROM invites i JOIN users u ON u.id = i.user_id
     WHERE i.token_hash = ?`,
    await sha256(token),
  );
  if (!row) throw badRequest('This link isn’t valid. Ask for a new one.');
  if (row.used_at) throw badRequest('This link has already been used. Ask for a new one.');
  if (row.revoked_at) throw badRequest('This link was cancelled. Ask for a new one.');
  if (row.expires_at <= nowIso()) throw badRequest('This link has expired. Ask for a new one.');
  return row;
}
