-- Per-profile look: a photo or emoji avatar, a colour, a short tagline and a
-- favourite movie (its backdrop is the profile card on "Who's watching?").
ALTER TABLE users ADD COLUMN avatar_key TEXT;
ALTER TABLE users ADD COLUMN avatar_emoji TEXT;
ALTER TABLE users ADD COLUMN profile_color TEXT;
ALTER TABLE users ADD COLUMN tagline TEXT;
ALTER TABLE users ADD COLUMN favorite_movie_id TEXT;
