import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Application-owned data. Media files and media metadata are never stored here —
 * only IDs that reference Jellyfin items/users plus the app's own records.
 */
const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    media_token TEXT,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE preferences (
    user_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE personal_data (
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    rating REAL,
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );

  CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('manual', 'smart')),
    rules TEXT,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
    artwork_kind TEXT NOT NULL DEFAULT 'auto' CHECK (artwork_kind IN ('auto', 'movie', 'upload')),
    artwork_ref TEXT,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX collections_owner_name ON collections(owner_user_id, name COLLATE NOCASE);

  CREATE TABLE collection_items (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (collection_id, item_id)
  );

  -- Last known title/year for referenced items so collections can show something
  -- meaningful when a movie is removed from Jellyfin.
  CREATE TABLE item_snapshots (
    item_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    year INTEGER,
    last_seen_at TEXT NOT NULL
  );

  -- Watch state for the built-in sample library only (Jellyfin owns it otherwise).
  CREATE TABLE mock_user_data (
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    played INTEGER NOT NULL DEFAULT 0,
    position_seconds REAL NOT NULL DEFAULT 0,
    play_count INTEGER NOT NULL DEFAULT 0,
    last_played TEXT,
    PRIMARY KEY (user_id, item_id)
  );
  `,
  // 2: disc ripping queue
  `
  CREATE TABLE rip_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    disc_label TEXT NOT NULL,
    disc_name TEXT NOT NULL DEFAULT '',
    mount_path TEXT NOT NULL,
    drive_index INTEGER,
    progress REAL,
    message TEXT,
    guess TEXT,
    title TEXT,
    year INTEGER,
    tmdb_id TEXT,
    imdb_id TEXT,
    candidates TEXT,
    disc_titles TEXT,
    title_index INTEGER,
    source_seconds INTEGER,
    movie_path TEXT,
    movie_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX rip_jobs_status ON rip_jobs(status);
  `,
  // 3: profiles seen on this server (the sample library has no user list of its own)
  `
  CREATE TABLE seen_users (
    user_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  `,
];

export type Db = DatabaseSync;

export function openDatabase(dataDir: string | ':memory:'): Db {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'wheelhouse.db');
    // The app was called "Private Cinema" before; carry its database over once.
    const legacy = path.join(dataDir, 'private-cinema.db');
    if (!fs.existsSync(file) && fs.existsSync(legacy)) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(legacy + suffix)) fs.renameSync(legacy + suffix, file + suffix);
      }
    }
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version] as string;
    transaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
    version++;
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const nowIso = () => new Date().toISOString();
