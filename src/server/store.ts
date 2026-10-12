import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PREFERENCES, mergePreferences } from '../shared/preferences.js';
import { parseSmartRules } from '../shared/rules.js';
import type {
  CollectionKind,
  Movie,
  PersonalData,
  Preferences,
  SmartRules,
} from '../shared/types.js';
import { nowIso, transaction, type Db } from './db.js';
import { ApiError, badRequest, notFound } from './errors.js';

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

export function detectImageType(buffer: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (
    buffer.length > 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'jpg';
  if (
    buffer.length > 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export class Store {
  readonly artworkDir: string | null;

  constructor(
    private readonly db: Db,
    dataDir: string | ':memory:',
  ) {
    this.artworkDir = dataDir === ':memory:' ? null : path.join(dataDir, 'artwork');
    if (this.artworkDir) fs.mkdirSync(this.artworkDir, { recursive: true });
  }

  // ---------------------------------------------------------------------------
  // Preferences

  getPreferences(userId: string): Preferences {
    const row = this.db.prepare('SELECT data FROM preferences WHERE user_id = ?').get(userId) as
      { data: string } | undefined;
    if (!row) return structuredClone(DEFAULT_PREFERENCES);
    try {
      const stored = JSON.parse(row.data) as { appName?: string };
      // Users who never renamed the app keep following the default name.
      if (stored.appName === 'Private Cinema') delete stored.appName;
      return mergePreferences(DEFAULT_PREFERENCES, stored);
    } catch {
      return structuredClone(DEFAULT_PREFERENCES);
    }
  }

  updatePreferences(userId: string, patch: unknown): Preferences {
    const next = mergePreferences(this.getPreferences(userId), patch);
    this.db
      .prepare(
        `INSERT INTO preferences (user_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(userId, JSON.stringify(next), nowIso());
    return next;
  }

  // ---------------------------------------------------------------------------
  // Personal ratings & notes

  getPersonal(userId: string, itemId: string): PersonalData {
    const row = this.db
      .prepare(
        'SELECT rating, notes, updated_at FROM personal_data WHERE user_id = ? AND item_id = ?',
      )
      .get(userId, itemId) as
      { rating: number | null; notes: string; updated_at: string } | undefined;
    return row
      ? { rating: row.rating, notes: row.notes, updatedAt: row.updated_at }
      : { rating: null, notes: '', updatedAt: null };
  }

  allPersonal(userId: string): Map<string, PersonalData> {
    const rows = this.db
      .prepare('SELECT item_id, rating, notes, updated_at FROM personal_data WHERE user_id = ?')
      .all(userId) as {
      item_id: string;
      rating: number | null;
      notes: string;
      updated_at: string;
    }[];
    return new Map(
      rows.map((r) => [r.item_id, { rating: r.rating, notes: r.notes, updatedAt: r.updated_at }]),
    );
  }

  setPersonal(
    userId: string,
    itemId: string,
    input: { rating?: unknown; notes?: unknown },
  ): PersonalData {
    const current = this.getPersonal(userId, itemId);
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
      this.db
        .prepare('DELETE FROM personal_data WHERE user_id = ? AND item_id = ?')
        .run(userId, itemId);
      return { rating: null, notes: '', updatedAt };
    }
    this.db
      .prepare(
        `INSERT INTO personal_data (user_id, item_id, rating, notes, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, item_id) DO UPDATE SET rating = excluded.rating, notes = excluded.notes, updated_at = excluded.updated_at`,
      )
      .run(userId, itemId, rating, notes, updatedAt);
    return { rating, notes, updatedAt };
  }

  // ---------------------------------------------------------------------------
  // Item snapshots (for unavailable / removed media)

  recordSnapshots(movies: Movie[]) {
    const stmt = this.db.prepare(
      `INSERT INTO item_snapshots (item_id, title, year, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET title = excluded.title, year = excluded.year, last_seen_at = excluded.last_seen_at`,
    );
    const now = nowIso();
    transaction(this.db, () => {
      for (const movie of movies) stmt.run(movie.id, movie.title, movie.year, now);
    });
  }

  snapshot(itemId: string): { title: string; year: number | null } | null {
    const row = this.db
      .prepare('SELECT title, year FROM item_snapshots WHERE item_id = ?')
      .get(itemId) as { title: string; year: number | null } | undefined;
    return row ?? null;
  }

  // ---------------------------------------------------------------------------
  // Collections

  /** Collections visible to a user: their own (in their order), then others' shared ones. */
  listCollections(userId: string): CollectionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM collections WHERE owner_user_id = ? OR visibility = 'shared'
         ORDER BY CASE WHEN owner_user_id = ? THEN 0 ELSE 1 END, position, name COLLATE NOCASE`,
      )
      .all(userId, userId) as unknown as CollectionRow[];
  }

  getCollection(userId: string, id: string): CollectionRow {
    const row = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as
      CollectionRow | undefined;
    if (!row || (row.owner_user_id !== userId && row.visibility !== 'shared')) {
      throw notFound('Collection not found');
    }
    return row;
  }

  getEditableCollection(userId: string, id: string): CollectionRow {
    const row = this.getCollection(userId, id);
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

  private wrapUnique<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: collections/.test(error.message)) {
        throw new ApiError('CONFLICT', 'You already have a collection with that name');
      }
      throw error;
    }
  }

  createCollection(userId: string, input: CollectionInput): CollectionRow {
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
    const id = randomUUID();
    const now = nowIso();
    const { next } = this.db
      .prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM collections WHERE owner_user_id = ?',
      )
      .get(userId) as { next: number };
    this.wrapUnique(() =>
      this.db
        .prepare(
          `INSERT INTO collections (id, owner_user_id, name, description, kind, rules, visibility, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, userId, name, description, kind, rules, visibility, next, now, now),
    );
    return this.getCollection(userId, id);
  }

  updateCollection(userId: string, id: string, input: CollectionInput): CollectionRow {
    const row = this.getEditableCollection(userId, id);
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
        this.removeArtworkFile(row);
        artworkKind = 'auto';
        artworkRef = null;
      } else if (
        art.kind === 'movie' &&
        typeof art.ref === 'string' &&
        /^[\w-]{1,64}$/.test(art.ref)
      ) {
        this.removeArtworkFile(row);
        artworkKind = 'movie';
        artworkRef = art.ref;
      } else {
        throw badRequest(
          'Artwork must be "auto" or a movie id (use the upload endpoint for images)',
        );
      }
    }
    this.wrapUnique(() =>
      this.db
        .prepare(
          `UPDATE collections SET name = ?, description = ?, visibility = ?, rules = ?, artwork_kind = ?, artwork_ref = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(name, description, visibility, rules, artworkKind, artworkRef, nowIso(), id),
    );
    return this.getCollection(userId, id);
  }

  deleteCollection(userId: string, id: string) {
    const row = this.getEditableCollection(userId, id);
    this.removeArtworkFile(row);
    this.db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  }

  reorderCollections(userId: string, ids: unknown) {
    if (!Array.isArray(ids)) throw badRequest('ids must be an array');
    const own = this.db
      .prepare('SELECT id FROM collections WHERE owner_user_id = ?')
      .all(userId) as { id: string }[];
    const ownIds = new Set(own.map((r) => r.id));
    const ordered = ids.map(String).filter((id) => ownIds.has(id));
    // Collections missing from the request keep their relative order at the end.
    for (const r of own) if (!ordered.includes(r.id)) ordered.push(r.id);
    const stmt = this.db.prepare('UPDATE collections SET position = ? WHERE id = ?');
    transaction(this.db, () => ordered.forEach((id, i) => stmt.run(i, id)));
  }

  memberIds(collectionId: string): string[] {
    const rows = this.db
      .prepare(
        'SELECT item_id FROM collection_items WHERE collection_id = ? ORDER BY position, added_at',
      )
      .all(collectionId) as { item_id: string }[];
    return rows.map((r) => r.item_id);
  }

  collectionsContaining(userId: string, itemId: string): { id: string; name: string }[] {
    return this.db
      .prepare(
        `SELECT c.id, c.name FROM collections c JOIN collection_items i ON i.collection_id = c.id
         WHERE i.item_id = ? AND (c.owner_user_id = ? OR c.visibility = 'shared') AND c.kind = 'manual'
         ORDER BY c.name COLLATE NOCASE`,
      )
      .all(itemId, userId) as { id: string; name: string }[];
  }

  addItems(userId: string, id: string, itemIds: unknown) {
    const row = this.getEditableCollection(userId, id);
    if (row.kind !== 'manual') throw badRequest('Smart collections are filled by their rules');
    if (!Array.isArray(itemIds) || itemIds.length === 0)
      throw badRequest('itemIds must be a non-empty array');
    const ids = itemIds.map(String).filter((v) => /^[\w-]{1,64}$/.test(v));
    const { next } = this.db
      .prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM collection_items WHERE collection_id = ?',
      )
      .get(id) as { next: number };
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO collection_items (collection_id, item_id, position, added_at) VALUES (?, ?, ?, ?)',
    );
    const now = nowIso();
    transaction(this.db, () => ids.forEach((itemId, i) => stmt.run(id, itemId, next + i, now)));
    this.touch(id);
  }

  removeItem(userId: string, id: string, itemId: string) {
    this.getEditableCollection(userId, id);
    this.db
      .prepare('DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?')
      .run(id, itemId);
    this.touch(id);
  }

  reorderItems(userId: string, id: string, itemIds: unknown) {
    const row = this.getEditableCollection(userId, id);
    if (row.kind !== 'manual') throw badRequest('Smart collections are ordered by their sort rule');
    if (!Array.isArray(itemIds)) throw badRequest('itemIds must be an array');
    const current = this.memberIds(id);
    const set = new Set(current);
    const ordered = itemIds.map(String).filter((v) => set.has(v));
    for (const v of current) if (!ordered.includes(v)) ordered.push(v);
    const stmt = this.db.prepare(
      'UPDATE collection_items SET position = ? WHERE collection_id = ? AND item_id = ?',
    );
    transaction(this.db, () => ordered.forEach((itemId, i) => stmt.run(i, id, itemId)));
    this.touch(id);
  }

  private touch(id: string) {
    this.db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  }

  // ---------------------------------------------------------------------------
  // Collection artwork uploads

  saveArtwork(userId: string, id: string, body: Buffer): CollectionRow {
    const row = this.getEditableCollection(userId, id);
    if (!this.artworkDir) throw badRequest('Artwork uploads are not available');
    if (body.length === 0) throw badRequest('Empty upload');
    if (body.length > MAX_ARTWORK_BYTES) throw badRequest('Images are limited to 5 MB');
    const type = detectImageType(body);
    if (!type) throw badRequest('Upload a PNG, JPEG or WebP image');
    const file = `${id}-${randomBytes(6).toString('hex')}.${type}`;
    fs.writeFileSync(path.join(this.artworkDir, file), body);
    this.removeArtworkFile(row);
    this.db
      .prepare(
        `UPDATE collections SET artwork_kind = 'upload', artwork_ref = ?, updated_at = ? WHERE id = ?`,
      )
      .run(file, nowIso(), id);
    return this.getCollection(userId, id);
  }

  artworkPath(row: CollectionRow): string | null {
    if (row.artwork_kind !== 'upload' || !row.artwork_ref || !this.artworkDir) return null;
    // artwork_ref is generated by us, but never trust a path from the DB blindly.
    const file = path.basename(row.artwork_ref);
    return path.join(this.artworkDir, file);
  }

  private removeArtworkFile(row: CollectionRow) {
    const file = this.artworkPath(row);
    if (file) fs.rmSync(file, { force: true });
  }

  // ---------------------------------------------------------------------------
  // Starter collections

  ensureStarterCollections(userId: string) {
    const prefs = this.getPreferences(userId);
    if (prefs.starterCollectionsCreated) return;
    const starters: CollectionInput[] = [
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
    transaction(this.db, () => {
      for (const starter of starters) {
        try {
          this.createCollection(userId, starter);
        } catch (error) {
          if (!(error instanceof ApiError && error.code === 'CONFLICT')) throw error;
        }
      }
      this.updatePreferences(userId, { starterCollectionsCreated: true });
    });
  }
}
