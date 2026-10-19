-- TV shows in the cloud: a show's details (summary JSON, like movies) and its
-- episodes, each with its own video in R2. Watch state uses user_state, keyed
-- by episode id, exactly like movies.
CREATE TABLE shows (
  id TEXT PRIMARY KEY,
  tmdb_id TEXT,
  title TEXT NOT NULL,
  year INTEGER,
  summary TEXT NOT NULL,
  date_added TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX shows_tmdb ON shows(tmdb_id) WHERE tmdb_id IS NOT NULL;

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  season_number INTEGER,
  number INTEGER,
  end_number INTEGER,
  title TEXT NOT NULL,
  overview TEXT,
  runtime_minutes INTEGER,
  premiere_date TEXT,
  image TEXT,
  video_key TEXT,
  video_bytes INTEGER,
  video_sha256 TEXT,
  duration_seconds REAL,
  subtitles TEXT NOT NULL DEFAULT '[]',
  subtitle_status TEXT NOT NULL DEFAULT 'none' CHECK (subtitle_status IN ('disc', 'downloaded', 'none')),
  source_path TEXT,
  date_added TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX episodes_show ON episodes(show_id, season_number, number);
