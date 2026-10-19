// Administrator features: people and invitations, storage and cost, backups.
import type { CloudBackup, CloudPerson, StorageReport } from '../shared/types.js';
import { ApiError, badRequest, notFound } from '../server/errors.js';
import { issueInvite, type UserRow } from './auth.js';
import { nowIso, randomId, type Sql } from './db.js';
import type { CloudEnv } from './env.js';

// -----------------------------------------------------------------------------
// People

interface PersonRow extends UserRow {
  invite_id: string | null;
  invite_kind: 'invite' | 'reset' | null;
  invite_expires: string | null;
  sessions: number;
}

const toPerson = (r: PersonRow): CloudPerson => ({
  id: r.id,
  name: r.display_name,
  username: r.username,
  isAdmin: r.is_admin === 1,
  status: r.status,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  link:
    r.invite_id && r.invite_kind && r.invite_expires
      ? { id: r.invite_id, kind: r.invite_kind, expiresAt: r.invite_expires }
      : null,
  sessions: r.sessions,
});

const PEOPLE_SQL = `
  SELECT u.*,
    i.id AS invite_id, i.kind AS invite_kind, i.expires_at AS invite_expires,
    (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?1) AS sessions
  FROM users u
  LEFT JOIN invites i ON i.user_id = u.id AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?1`;

export async function listPeople(sql: Sql): Promise<CloudPerson[]> {
  const rows = await sql.all<PersonRow>(
    `${PEOPLE_SQL} ORDER BY u.is_admin DESC, u.display_name COLLATE NOCASE`,
    nowIso(),
  );
  return rows.map(toPerson);
}

export async function getPerson(sql: Sql, id: string): Promise<CloudPerson> {
  const row = await sql.get<PersonRow>(`${PEOPLE_SQL} WHERE u.id = ?2`, nowIso(), id);
  if (!row) throw notFound('That person no longer has access.');
  return toPerson(row);
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 40) throw badRequest('Enter their name (up to 40 characters).');
  return name;
}

/** A pending person with an invitation link. Returns the link's token. */
export async function invitePerson(
  sql: Sql,
  input: { name?: unknown; days?: unknown; isAdmin?: unknown },
  createdBy: string | null,
) {
  const name = cleanName(input.name);
  const days = input.days === undefined ? 7 : Number(input.days);
  const id = randomId();
  const now = nowIso();
  await sql.run(
    `INSERT INTO users (id, display_name, is_admin, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
    id,
    name,
    input.isAdmin === true ? 1 : 0,
    now,
    now,
  );
  const link = await issueInvite(sql, id, 'invite', createdBy, days);
  return { id, ...link };
}

/** A fresh link: a new invitation for someone pending, or a password reset. */
export async function newLink(sql: Sql, userId: string, createdBy: string, days = 7) {
  const user = await sql.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  if (!user) throw notFound('That person no longer has access.');
  return issueInvite(sql, userId, user.status === 'pending' ? 'invite' : 'reset', createdBy, days);
}

export async function revokeLink(sql: Sql, inviteId: string) {
  const changed = await sql.run(
    'UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL',
    nowIso(),
    inviteId,
  );
  if (changed === 0) throw notFound('That link was already used or cancelled.');
}

/** Removes someone's access: their account, links and every signed-in device, at once. */
export async function removePerson(sql: Sql, userId: string, by: string) {
  if (userId === by) throw badRequest('You can’t remove yourself.');
  const user = await sql.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  if (!user) throw notFound('That person no longer has access.');
  if (user.is_admin) {
    const admins = await sql.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM users WHERE is_admin = 1',
    );
    if ((admins?.n ?? 0) <= 1) throw badRequest('Wheelhouse needs at least one administrator.');
  }
  await sql.batch([
    sql.stmt('DELETE FROM sessions WHERE user_id = ?', userId),
    sql.stmt('DELETE FROM invites WHERE user_id = ?', userId),
    sql.stmt('DELETE FROM now_playing WHERE user_id = ?', userId),
    sql.stmt('DELETE FROM users WHERE id = ?', userId),
  ]);
}

export async function renamePerson(sql: Sql, userId: string, name: unknown) {
  const changed = await sql.run(
    'UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?',
    cleanName(name),
    nowIso(),
    userId,
  );
  if (changed === 0) throw notFound('That person no longer has access.');
}

export async function hasAdmin(sql: Sql) {
  return Boolean(await sql.get('SELECT 1 AS x FROM users WHERE is_admin = 1 LIMIT 1'));
}

// -----------------------------------------------------------------------------
// Storage and cost

const GB = 1024 ** 3;
const FREE_BYTES = 10 * GB;
const PRICE_PER_GB_MONTH = 0.015;

export async function storageReport(env: CloudEnv, sql: Sql): Promise<StorageReport> {
  let bytes = 0;
  let objects = 0;
  let cursor: string | undefined;
  // At most 20 pages (20,000 objects) per report; plenty for a home library.
  for (let page = 0; page < 20; page++) {
    const list = await env.MEDIA.list({ cursor, limit: 1000 });
    for (const o of list.objects) {
      bytes += o.size;
      objects++;
    }
    if (!list.truncated) break;
    cursor = list.cursor;
  }
  const movies = await sql.get<{ n: number; video: number | null }>(
    'SELECT COUNT(*) AS n, SUM(video_bytes) AS video FROM movies',
  );
  const billable = Math.max(0, bytes - FREE_BYTES) / GB;
  return {
    movies: movies?.n ?? 0,
    objects,
    bytes,
    videoBytes: movies?.video ?? 0,
    freeBytes: FREE_BYTES,
    monthlyUsd: Math.round(billable * PRICE_PER_GB_MONTH * 100) / 100,
    pricePerGbMonth: PRICE_PER_GB_MONTH,
    plan: 'Workers Free + R2 pay-as-you-go',
  };
}

// -----------------------------------------------------------------------------
// Backups: every table as JSON in R2 (backups/…), the newest 14 kept.

const BACKUP_TABLES = [
  'users',
  'movies',
  'franchises',
  'user_state',
  'preferences',
  'personal_data',
  'collections',
  'collection_items',
  'item_snapshots',
  'watchlist',
  'watch_events',
  'movie_requests',
  'settings',
];

export async function backupNow(env: CloudEnv, sql: Sql): Promise<CloudBackup> {
  const tables: Record<string, unknown[]> = {};
  for (const table of BACKUP_TABLES) {
    // Password hashes stay out of backups: restoring means sending reset links.
    const columns =
      table === 'users'
        ? 'id, display_name, username, is_admin, status, created_at, updated_at'
        : '*';
    tables[table] = await sql.all(`SELECT ${columns} FROM ${table}`);
  }
  const createdAt = nowIso();
  const body = JSON.stringify({ version: 1, createdAt, tables });
  const key = `backups/wheelhouse-${createdAt.replace(/[:.]/g, '-')}.json`;
  await env.MEDIA.put(key, body, { httpMetadata: { contentType: 'application/json' } });
  await sql.run(
    `INSERT INTO settings (key, value, updated_at) VALUES ('last_backup', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    createdAt,
  );
  const keep = Math.max(1, Number(env.BACKUPS_KEEP) || 14);
  const all = await listBackups(env);
  const old = all.slice(keep).map((b) => b.key);
  if (old.length) await env.MEDIA.delete(old);
  return { key, bytes: body.length, createdAt };
}

export async function listBackups(env: CloudEnv): Promise<CloudBackup[]> {
  const list = await env.MEDIA.list({ prefix: 'backups/', limit: 1000 });
  return list.objects
    .map((o) => ({ key: o.key, bytes: o.size, createdAt: o.uploaded.toISOString() }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function requireAdmin(user: { isAdmin: boolean } | null | undefined, what: string) {
  if (!user?.isAdmin) throw new ApiError('FORBIDDEN', `Only an administrator can ${what}.`);
}
