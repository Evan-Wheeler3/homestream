-- IMDb and Rotten Tomatoes ratings from OMDb: when each movie was last checked.
ALTER TABLE movies ADD COLUMN ratings_checked_at TEXT;
