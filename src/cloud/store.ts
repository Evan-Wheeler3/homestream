// The Mac version's Store (src/server/store.ts), on D1: preferences, ratings and
// notes, watchlist, watch history, collections and their artwork.
import { DEFAULT_PREFERENCES, mergePreferences } from '../shared/preferences.js';
import { parseSmartRules } from '../shared/rules.js';
import type { CollectionKind, PersonalData, Preferences, SmartRules } from '../shared/types.js';
import type { WatchEvent } from '../shared/wrapped.js';
import { ApiError, badRequest, notFound } from '../server/errors.js';
import { nowIso, randomId, type Sql } from './db.js';
import type { R2Bucket } from './env.js';

export interface CollectionRow {
  id: string;
  owner_user_id: string;
  name: string;
  description: string;
  kind: CollectionKind;
  rules: string | null;
  visibility: 'private' | 'shared';
  artwork_kind: 'auto' | 'movie' | 'upload';
  artwork_ref: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CollectionInput {
  name?: unknown;
  description?: unknown;
  kind?: unknown;
  rules?: unknown;
  visibility?: unknown;
  artwork?: unknown;
}

const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;

export function detectImageType(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (
    bytes.length > 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
  )
    return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

export const collectionArtworkKey = (file: string) => `collections/${file}`;

export class CloudStore {
  constructor(
    private readonly sql: Sql,
    private readonly media: R2Bucket,
  ) {}

  // ---------------------------------------------------------------------------
  // Preferences

  async getPreferences(userId: string): Promise<Preferences> {
    const row = await this.sql.get<{ data: string }>(
      'SELECT data FROM preferences WHERE user_id = ?',
      userId,
    );
    if (!row) return structuredClone(DEFAULT_PREFERENCES);
    try {
      return mergePreferences(DEFAULT_PREFERENCES, JSON.parse(row.data));
    } catch {
      return structuredClone(DEFAULT_PREFERENCES);
    }
  }

  async updatePreferences(userId: string, patch: unknown): Promise<Preferences> {
    const next = mergePreferences(await this.getPreferences(userId), patch);
    await this.sql.run(
      `INSERT INTO preferences (user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      userId,
      JSON.stringify(next),
      nowIso(),
    );
    return next;
  }

  // ---------------------------------------------------------------------------
  // Watch history, watchlist, ratings and notes

  async recordWatch(userId: string, itemId: string, seconds: number, finished: boolean) {
    await this.sql.run(
      'INSERT INTO watch_events (user_id, item_id, watched_at, seconds, finished) VALUES (?, ?, ?, ?, ?)',
      userId,
      itemId,
      nowIso(),
      Math.round(seconds),
      finished ? 1 : 0,
    );
  }

  async watchEvents(userId: string): Promise<WatchEvent[]> {
    const rows = await this.sql.all<{
      item_id: string;
      watched_at: string;
      seconds: number;
      finished: number;
    }>(
      'SELECT item_id, watched_at, seconds, finished FROM watch_events WHERE user_id = ? ORDER BY watched_at',
      userId,
    );
    return rows.map((r) => ({
      itemId: r.item_id,
      at: r.watched_at,
      seconds: r.seconds,
      finished: r.finished === 1,
    }));
  }

  /** Watchlist item ids, most recently added first. */
  async watchlist(userId: string): Promise<string[]> {
    const rows = await this.sql.all<{ item_id: string }>(
      'SELECT item_id FROM watchlist WHERE user_id = ? ORDER BY added_at DESC, rowid DESC',
      userId,
    );
    return rows.map((r) => r.item_id);
  }

  async setWatchlist(userId: string, itemId: string, on: boolean) {
    if (on) {
      await this.sql.run(
        'INSERT OR IGNORE INTO watchlist (user_id, item_id, added_at) VALUES (?, ?, ?)',
        userId,
        itemId,
        nowIso(),
      );
    } else {
      await this.sql.run('DELETE FROM watchlist WHERE user_id = ? AND item_id = ?', userId, itemId);
    }
  }

  async getPersonal(userId: string, itemId: string): Promise<PersonalData> {
    const row = await this.sql.get<{ rating: number | null; notes: string; updated_at: string }>(
      'SELECT rating, notes, updated_at FROM personal_data WHERE user_id = ? AND item_id = ?',
      userId,
      itemId,
    );
    return row
      ? { rating: row.rating, notes: row.notes, updatedAt: row.updated_at }
      : { rating: null, notes: '', updatedAt: null };
  }

  async allPersonal(userId: string): Promise<Map<string, PersonalData>> {
    const rows = await this.sql.all<{
      item_id: string;
      rating: number | null;
      notes: string;
      updated_at: string;
    }>('SELECT item_id, rating, notes, updated_at FROM personal_data WHERE user_id = ?', userId);
    return new Map(
      rows.map((r) => [r.item_id, { rating: r.rating, notes: r.notes, updatedAt: r.updated_at }]),
    );
  }

  async setPersonal(
    userId: string,
    itemId: string,
    input: { rating?: unknown; notes?: unknown },
  ): Promise<PersonalData> {
    const current = await this.getPersonal(userId, itemId);
    let rating = current.rating;
    if ('rating' in input) {
      if (input.rating === null) rating = null;
      else {
        const n = Number(input.rating);
        if (!Number.isInteger(n) || n < 1 || n > 5)
          throw badRequest('Rating must be a whole number from 1 to 5');
        rating = n;
      }
    }
    let notes = current.notes;
    if ('notes' in input) {
      if (typeof input.notes !== 'string') throw badRequest('Notes must be text');
      if (input.notes.length > 5000) throw badRequest('Notes are limited to 5000 characters');
      notes = input.notes;
    }
    const updatedAt = nowIso();
    if (rating === null && notes.trim() === '') {
      await this.sql.run(
        'DELETE FROM personal_data WHERE user_id = ? AND item_id = ?',
        userId,
        itemId,
      );
      return { rating: null, notes: '', updatedAt };
    }
    await this.sql.run(
      `INSERT INTO personal_data (user_id, item_id, rating, notes, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, item_id) DO UPDATE SET rating = excluded.rating, notes = excluded.notes, updated_at = excluded.updated_at`,
      userId,
      itemId,
      rating,
      notes,
      updatedAt,
    );
    return { rating, notes, updatedAt };
  }

  async snapshot(itemId: string): Promise<{ title: string; year: number | null } | null> {
    return this.sql.get('SELECT title, year FROM item_snapshots WHERE item_id = ?', itemId);
  }

  // ---------------------------------------------------------------------------
  // Collections

  /** Collections visible to a user: their own (in their order), then others' shared ones. */
  listCollections(userId: string): Promise<CollectionRow[]> {
    return this.sql.all<CollectionRow>(
      `SELECT * FROM collections WHERE owner_user_id = ? OR visibility = 'shared'
       ORDER BY CASE WHEN owner_user_id = ? THEN 0 ELSE 1 END, position, name COLLATE NOCASE`,
      userId,
      userId,
    );
  }

  async getCollection(userId: string, id: string): Promise<CollectionRow> {
    const row = await this.sql.get<CollectionRow>('SELECT * FROM collections WHERE id = ?', id);
    if (!row || (row.owner_user_id !== userId && row.visibility !== 'shared')) {
      throw notFound('Collection not found');
    }
    return row;
  }

  async getEditableCollection(userId: string, id: string): Promise<CollectionRow> {
    const row = await this.getCollection(userId, id);
    if (row.owner_user_id !== userId) {
      throw new ApiError('FORBIDDEN', 'Only the owner can change this collection');
    }
    return row;
  }

  parseRules(row: CollectionRow): SmartRules | null {
    if (row.kind !== 'smart' || !row.rules) return null;
    try {
      return parseSmartRules(JSON.parse(row.rules));
    } catch {
      return null;
    }
  }

  private validateName(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw badRequest('Collection name is required');
    const name = value.trim().replace(/\s+/g, ' ');
    if (name.length > 80) throw badRequest('Collection names are limited to 80 characters');
    return name;
  }

  private async wrapUnique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        throw new ApiError('CONFLICT', 'You already have a collection with that name');
      }
      throw error;
    }
  }

  async createCollection(userId: string, input: CollectionInput): Promise<CollectionRow> {
    const name = this.validateName(input.name);
    const kind: CollectionKind = input.kind === 'smart' ? 'smart' : 'manual';
    let rules: string | null = null;
    if (kind === 'smart') {
      try {
        rules = JSON.stringify(parseSmartRules(input.rules));
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : 'Invalid rules');
      }
    }
    const description =
      typeof input.description === 'string' ? input.description.slice(0, 500) : '';
    const visibility = input.visibility === 'shared' ? 'shared' : 'private';
    const id = randomId();
    const now = nowIso();
    await this.wrapUnique(() =>
      this.sql.run(
        `INSERT INTO collections (id, owner_user_id, name, description, kind, rules, visibility, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?,
           (SELECT COALESCE(MAX(position), -1) + 1 FROM collections WHERE owner_user_id = ?), ?, ?)`,
        id,
        userId,
        name,
        description,
        kind,
        rules,
        visibility,
        userId,
        now,
        now,
      ),
    );
    return this.getCollection(userId, id);
  }

  async updateCollection(userId: string, id: string, input: CollectionInput) {
    const row = await this.getEditableCollection(userId, id);
    const name = input.name !== undefined ? this.validateName(input.name) : row.name;
    const description =
      typeof input.description === 'string' ? input.description.slice(0, 500) : row.description;
    const visibility =
      input.visibility === 'shared' || input.visibility === 'private'
        ? input.visibility
        : row.visibility;
    let rules = row.rules;
    if (input.rules !== undefined) {
      if (row.kind !== 'smart') throw badRequest('Only smart collections have rules');
      try {
        rules = JSON.stringify(parseSmartRules(input.rules));
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : 'Invalid rules');
      }
    }
    let artworkKind = row.artwork_kind;
    let artworkRef = row.artwork_ref;
    if (input.artwork !== undefined) {
      const art = (input.artwork ?? {}) as { kind?: unknown; ref?: unknown };
      if (art.kind === 'auto') {
        await this.removeArtworkFile(row);
        artworkKind = 'auto';
        artworkRef = null;
      } else if (
        art.kind === 'movie' &&
        typeof art.ref === 'string' &&
        /^[\w-]{1,64}$/.test(art.ref)
      ) {
        await this.removeArtworkFile(row);
        artworkKind = 'movie';
        artworkRef = art.ref;
      } else {
        throw badRequest(
          'Artwork must be "auto" or a movie id (use the upload endpoint for images)',
        );
      }
    }
    await this.wrapUnique(() =>
      this.sql.run(
        `UPDATE collections SET name = ?, description = ?, visibility = ?, rules = ?, artwork_kind = ?, artwork_ref = ?, updated_at = ?
         WHERE id = ?`,
        name,
        description,
        visibility,
        rules,
        artworkKind,
        artworkRef,
        nowIso(),
        id,
      ),
    );
    return this.getCollection(userId, id);
  }

  async deleteCollection(userId: string, id: string) {
    const row = await this.getEditableCollection(userId, id);
    await this.removeArtworkFile(row);
    await this.sql.batch([
      this.sql.stmt('DELETE FROM collection_items WHERE collection_id = ?', id),
      this.sql.stmt('DELETE FROM collections WHERE id = ?', id),
    ]);
  }

  async reorderCollections(userId: string, ids: unknown) {
    if (!Array.isArray(ids)) throw badRequest('ids must be an array');
    const own = await this.sql.all<{ id: string }>(
      'SELECT id FROM collections WHERE owner_user_id = ? ORDER BY position',
      userId,
    );
    const ownIds = new Set(own.map((r) => r.id));
    const ordered = ids.map(String).filter((id) => ownIds.has(id));
    // Collections missing from the request keep their relative order at the end.
    for (const r of own) if (!ordered.includes(r.id)) ordered.push(r.id);
    await this.sql.batch(
      ordered.map((id, i) =>
        this.sql.stmt('UPDATE collections SET position = ? WHERE id = ?', i, id),
      ),
    );
  }

  async memberIds(collectionId: string): Promise<string[]> {
    const rows = await this.sql.all<{ item_id: string }>(
      'SELECT item_id FROM collection_items WHERE collection_id = ? ORDER BY position, added_at',
      collectionId,
    );
    return rows.map((r) => r.item_id);
  }

  /** Members of all the given collections at once (one query instead of one per collection). */
  async membersOf(collectionIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>(collectionIds.map((id) => [id, []]));
    if (collectionIds.length === 0) return out;
    const rows = await this.sql.all<{ collection_id: string; item_id: string }>(
      `SELECT collection_id, item_id FROM collection_items
       WHERE collection_id IN (${collectionIds.map(() => '?').join(',')})
       ORDER BY position, added_at`,
      ...collectionIds,
    );
    for (const r of rows) out.get(r.collection_id)?.push(r.item_id);
    return out;
  }

  collectionsContaining(userId: string, itemId: string): Promise<{ id: string; name: string }[]> {
    return this.sql.all(
      `SELECT c.id, c.name FROM collections c JOIN collection_items i ON i.collection_id = c.id
       WHERE i.item_id = ? AND (c.owner_user_id = ? OR c.visibility = 'shared') AND c.kind = 'manual'
       ORDER BY c.name COLLATE NOCASE`,
      itemId,
      userId,
    );
  }

  async addItems(userId: string, id: string, itemIds: unknown) {
    const row = await this.getEditableCollection(userId, id);
    if (row.kind !== 'manual') throw badRequest('Smart collections are filled by their rules');
    if (!Array.isArray(itemIds) || itemIds.length === 0)
      throw badRequest('itemIds must be a non-empty array');
    const ids = itemIds
      .map(String)
      .filter((v) => /^[\w-]{1,64}$/.test(v))
      .slice(0, 500);
    const next =
      (
        await this.sql.get<{ next: number }>(
          'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM collection_items WHERE collection_id = ?',
          id,
        )
      )?.next ?? 0;
    const now = nowIso();
    await this.sql.batch([
      ...ids.map((itemId, i) =>
        this.sql.stmt(
          'INSERT OR IGNORE INTO collection_items (collection_id, item_id, position, added_at) VALUES (?, ?, ?, ?)',
          id,
          itemId,
          next + i,
          now,
        ),
      ),
      this.touch(id),
    ]);
  }

  async removeItem(userId: string, id: string, itemId: string) {
    await this.getEditableCollection(userId, id);
    await this.sql.batch([
      this.sql.stmt(
        'DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?',
        id,
        itemId,
      ),
      this.touch(id),
    ]);
  }

  async reorderItems(userId: string, id: string, itemIds: unknown) {
    const row = await this.getEditableCollection(userId, id);
    if (row.kind !== 'manual') throw badRequest('Smart collections are ordered by their sort rule');
    if (!Array.isArray(itemIds)) throw badRequest('itemIds must be an array');
    const current = await this.memberIds(id);
    const set = new Set(current);
    const ordered = itemIds.map(String).filter((v) => set.has(v));
    for (const v of current) if (!ordered.includes(v)) ordered.push(v);
    await this.sql.batch([
      ...ordered.map((itemId, i) =>
        this.sql.stmt(
          'UPDATE collection_items SET position = ? WHERE collection_id = ? AND item_id = ?',
          i,
          id,
          itemId,
        ),
      ),
      this.touch(id),
    ]);
  }

  private touch(id: string) {
    return this.sql.stmt('UPDATE collections SET updated_at = ? WHERE id = ?', nowIso(), id);
  }

  // ---------------------------------------------------------------------------
  // Collection artwork uploads (kept in R2)

  async saveArtwork(userId: string, id: string, body: Uint8Array) {
    const row = await this.getEditableCollection(userId, id);
    if (body.length === 0) throw badRequest('Empty upload');
    if (body.length > MAX_ARTWORK_BYTES) throw badRequest('Images are limited to 5 MB');
    const type = detectImageType(body);
    if (!type) throw badRequest('Upload a PNG, JPEG or WebP image');
    const file = `${id}-${crypto.randomUUID().slice(0, 12)}.${type}`;
    await this.media.put(collectionArtworkKey(file), body, {
      httpMetadata: { contentType: type === 'jpg' ? 'image/jpeg' : `image/${type}` },
    });
    await this.removeArtworkFile(row);
    await this.sql.run(
      `UPDATE collections SET artwork_kind = 'upload', artwork_ref = ?, updated_at = ? WHERE id = ?`,
      file,
      nowIso(),
      id,
    );
  }

  artworkKey(row: CollectionRow): string | null {
    if (row.artwork_kind !== 'upload' || !row.artwork_ref) return null;
    if (!/^[\w.-]{1,120}$/.test(row.artwork_ref)) return null;
    return collectionArtworkKey(row.artwork_ref);
  }

  private async removeArtworkFile(row: CollectionRow) {
    const key = this.artworkKey(row);
    if (key) await this.media.delete(key);
  }

  // ---------------------------------------------------------------------------
  // Starter collections

  async ensureStarterCollections(userId: string) {
    const prefs = await this.getPreferences(userId);
    if (prefs.starterCollectionsCreated) return;
    for (const starter of STARTERS) {
      try {
        await this.createCollection(userId, starter);
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'CONFLICT')) throw error;
      }
    }
    await this.updatePreferences(userId, { starterCollectionsCreated: true });
  }
}

const STARTERS: CollectionInput[] = [
  {
    name: 'Personal Favorites',
    description: 'Everything you have marked as a favorite.',
    kind: 'smart',
    rules: {
      match: 'all',
      rules: [{ field: 'favorite', op: 'is', value: true }],
      sort: 'title',
      dir: 'asc',
    },
  },
  {
    name: '1990s Cinema',
    description: 'Released between 1990 and 1999.',
    kind: 'smart',
    rules: {
      match: 'all',
      rules: [{ field: 'year', op: 'between', min: 1990, max: 1999 }],
      sort: 'year',
      dir: 'asc',
    },
  },
  {
    name: 'Japanese Cinema',
    description: 'Films produced in Japan.',
    kind: 'smart',
    rules: {
      match: 'all',
      rules: [{ field: 'country', op: 'any', values: ['Japan'] }],
      sort: 'year',
      dir: 'asc',
    },
  },
  {
    name: 'Under 100 Minutes',
    description: 'For when the evening is short.',
    kind: 'smart',
    rules: {
      match: 'all',
      rules: [{ field: 'runtime', op: 'between', min: null, max: 99 }],
      sort: 'runtime',
      dir: 'asc',
    },
  },
  {
    name: 'Family Movie Night',
    description: 'Rated G or PG, or tagged “family”.',
    kind: 'smart',
    rules: {
      match: 'any',
      rules: [
        { field: 'officialRating', op: 'any', values: ['G', 'PG', 'TV-G', 'TV-Y', 'TV-PG'] },
        { field: 'tag', op: 'any', values: ['family'] },
      ],
      sort: 'title',
      dir: 'asc',
    },
  },
  { name: 'Movies to Rewatch', description: 'Worth another look.', kind: 'manual' },
  {
    name: 'Favorite Directors',
    description: 'Hand-picked work from directors you love.',
    kind: 'manual',
  },
];
