// Each person's look: an uploaded photo or an emoji avatar, a colour, a short
// tagline, and a favourite movie whose backdrop sits behind their profile.
import { MAX_TAGLINE, PROFILE_EMOJI } from '../shared/profiles.js';
import type { ProfileDetails, ProfileLook } from '../shared/types.js';
import type { StoredSummary } from './catalog.js';
import { nowIso, type Sql } from './db.js';
import type { CloudEnv } from './env.js';
import { badRequest, notFound } from '../server/errors.js';
import { randomToken } from './auth.js';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export interface ProfileColumns {
  id: string;
  display_name: string;
  avatar_key?: string | null;
  avatar_emoji?: string | null;
  profile_color?: string | null;
  tagline?: string | null;
  favorite_movie_id?: string | null;
}

const version = (key: string) =>
  key
    .split('/')
    .pop()!
    .replace(/\.\w+$/, '');

export const avatarUrl = (userId: string, key: string) =>
  `/api/auth/profiles/${userId}/avatar?v=${version(key)}`;

export function lookOf(row: ProfileColumns): ProfileLook {
  return {
    image: row.avatar_key ? avatarUrl(row.id, row.avatar_key) : null,
    emoji: row.avatar_emoji ?? null,
    color: row.profile_color ?? null,
  };
}

/** The R2 key of a library movie's backdrop (or poster), if it has one. */
export async function favoriteArt(sql: Sql, movieId: string | null | undefined) {
  if (!movieId) return null;
  const row = await sql.get<{ id: string; title: string; year: number | null; summary: string }>(
    'SELECT id, title, year, summary FROM movies WHERE id = ?',
    movieId,
  );
  if (!row) return null;
  const images = (JSON.parse(row.summary) as StoredSummary).images;
  const url = images.backdrop ?? images.poster ?? null;
  const key = url?.startsWith('/api/media/')
    ? decodeURIComponent(url.slice('/api/media/'.length).split('?')[0]!)
    : null;
  return { id: row.id, title: row.title, year: row.year, url, key };
}

export async function getProfile(sql: Sql, userId: string): Promise<ProfileDetails> {
  const row = await sql.get<ProfileColumns>('SELECT * FROM users WHERE id = ?', userId);
  if (!row) throw notFound('Profile not found.');
  const art = await favoriteArt(sql, row.favorite_movie_id);
  return {
    name: row.display_name,
    look: lookOf(row),
    tagline: row.tagline ?? null,
    favoriteMovie: art ? { id: art.id, title: art.title, year: art.year, backdrop: art.url } : null,
  };
}

export async function updateProfile(sql: Sql, userId: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const sets: string[] = [];
  const values: unknown[] = [];
  if (b.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 40) throw badRequest('Your name needs 1–40 characters.');
    sets.push('display_name = ?');
    values.push(name);
  }
  if (b.emoji !== undefined) {
    if (b.emoji !== null && !(PROFILE_EMOJI as readonly string[]).includes(String(b.emoji)))
      throw badRequest('Pick one of the avatars.');
    sets.push('avatar_emoji = ?');
    values.push(b.emoji);
  }
  if (b.color !== undefined) {
    if (b.color !== null && !/^#[0-9a-f]{6}$/i.test(String(b.color)))
      throw badRequest('Pick a colour.');
    sets.push('profile_color = ?');
    values.push(b.color === null ? null : String(b.color).toLowerCase());
  }
  if (b.tagline !== undefined) {
    const tagline = typeof b.tagline === 'string' ? b.tagline.trim().slice(0, MAX_TAGLINE) : '';
    sets.push('tagline = ?');
    values.push(tagline || null);
  }
  if (b.favoriteMovieId !== undefined) {
    if (b.favoriteMovieId !== null) {
      const id = String(b.favoriteMovieId);
      if (!(await sql.get('SELECT 1 AS ok FROM movies WHERE id = ?', id)))
        throw badRequest('That movie isn’t in the library.');
    }
    sets.push('favorite_movie_id = ?');
    values.push(b.favoriteMovieId);
  }
  if (sets.length) {
    await sql.run(
      `UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
      ...values,
      nowIso(),
      userId,
    );
  }
  return getProfile(sql, userId);
}

/** Stores a new photo (already square and small: the browser crops it). */
export async function saveAvatar(
  env: CloudEnv,
  sql: Sql,
  userId: string,
  type: string,
  body: Uint8Array,
) {
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw badRequest('Upload a JPEG, PNG or WebP image.');
  if (body.byteLength === 0 || body.byteLength > MAX_AVATAR_BYTES)
    throw badRequest('That picture is too big (2 MB at most).');
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const key = `avatars/${userId}/${randomToken(9)}.${ext}`;
  await env.MEDIA.put(key, body, { httpMetadata: { contentType: type } });
  const old = await sql.get<{ avatar_key: string | null }>(
    'SELECT avatar_key FROM users WHERE id = ?',
    userId,
  );
  await sql.run(
    'UPDATE users SET avatar_key = ?, updated_at = ? WHERE id = ?',
    key,
    nowIso(),
    userId,
  );
  if (old?.avatar_key) await env.MEDIA.delete(old.avatar_key).catch(() => undefined);
  return getProfile(sql, userId);
}

export async function removeAvatar(env: CloudEnv, sql: Sql, userId: string) {
  const old = await sql.get<{ avatar_key: string | null }>(
    'SELECT avatar_key FROM users WHERE id = ?',
    userId,
  );
  await sql.run(
    'UPDATE users SET avatar_key = NULL, updated_at = ? WHERE id = ?',
    nowIso(),
    userId,
  );
  if (old?.avatar_key) await env.MEDIA.delete(old.avatar_key).catch(() => undefined);
  return getProfile(sql, userId);
}
