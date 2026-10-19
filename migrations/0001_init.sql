-- Wheelhouse in the cloud: everything that lived in Jellyfin and in the Mac's
-- SQLite database. Applied with `wrangler d1 migrations apply wheelhouse`.

-- People -----------------------------------------------------------------------

-- Everyone with access. A pending user has an invite but no username/password yet.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  username TEXT COLLATE NOCASE UNIQUE,
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT
);

-- Single-use links: an invitation for a new person, or a password reset.
-- Only a SHA-256 hash of the token is stored.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invite', 'reset')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX invites_user ON invites(user_id);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Sign-in and invite attempts per key (address + name), for rate limiting.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- Library ------------------------------------------------------------------------

-- One row per movie. `summary` is the shared `Movie` (without per-user state),
-- `detail` the extra MovieDetail fields (cast, writers, media info...).
CREATE TABLE movies (
  id TEXT PRIMARY KEY,
  tmdb_id TEXT,
  imdb_id TEXT,
  title TEXT NOT NULL,
  year INTEGER,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
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
CREATE UNIQUE INDEX movies_tmdb ON movies(tmdb_id) WHERE tmdb_id IS NOT NULL;

-- Film series (TMDB collections), with the library movies in them.
CREATE TABLE franchises (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  poster TEXT,
  backdrop TEXT,
  movie_ids TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

-- Watch state per person (Jellyfin kept this before).
CREATE TABLE user_state (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  played INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  position_seconds REAL NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

-- Who is playing what right now (player heartbeats); rows older than two minutes are stale.
CREATE TABLE now_playing (
  session_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  item_id TEXT NOT NULL,
  device TEXT NOT NULL,
  start_position REAL NOT NULL DEFAULT 0,
  position_seconds REAL NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- App data (same shapes as the Mac version) -----------------------------------------

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

CREATE TABLE item_snapshots (
  item_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  year INTEGER,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE watchlist (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE watch_events (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  watched_at TEXT NOT NULL,
  seconds INTEGER NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX watch_events_user ON watch_events(user_id, watched_at);

CREATE TABLE movie_nights (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  host_user_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  candidates TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  winner_id TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX movie_nights_code ON movie_nights(code, status);

CREATE TABLE night_votes (
  night_id TEXT NOT NULL REFERENCES movie_nights(id) ON DELETE CASCADE,
  voter_key TEXT NOT NULL,
  voter_name TEXT NOT NULL,
  item_id TEXT NOT NULL,
  voted_at TEXT NOT NULL,
  PRIMARY KEY (night_id, voter_key)
);

CREATE TABLE movie_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  title TEXT NOT NULL,
  year INTEGER,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  item_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX movie_requests_status ON movie_requests(status, created_at);

-- The Mac ---------------------------------------------------------------------------

-- Rip progress pushed by the Mac (one row), so the cloud Discs page can show it.
CREATE TABLE mac_status (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Small settings and bookkeeping (e.g. last backup).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Discs page actions taken in the cloud (pick a title, name a movie, retry...),
-- picked up by the Mac the next time it reports in.
CREATE TABLE mac_commands (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  taken_at TEXT,
  done_at TEXT,
  error TEXT
);
CREATE INDEX mac_commands_pending ON mac_commands(taken_at, created_at);
