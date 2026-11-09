-- A statue for each movie, by its theater's door in the 3D cinema: designed
-- once (by Claude, from the movie's story) as a list of coloured boxes.
CREATE TABLE statues (
  movie_id TEXT PRIMARY KEY,
  -- JSON: { name, boxes: [[x0, y0, z0, x1, y1, z1, rgb, glow], ...] }, or NULL until designed.
  spec TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL
);
