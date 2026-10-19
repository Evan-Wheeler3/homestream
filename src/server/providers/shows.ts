import type { Episode } from '../../shared/types.js';

const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

/**
 * The episode to play from a show's page: the one being watched, else the
 * first unwatched one after the last watched, else the first unwatched.
 * Specials (season 0) are only picked when they are all there is.
 */
export function pickNextUp(episodes: Episode[]): Episode | null {
  const playable = episodes.filter((e) => e.available);
  const regular = playable.filter((e) => e.seasonNumber !== 0);
  const pool = regular.length ? regular : playable;

  const resumable = pool
    .filter((e) => !e.user.played && e.user.positionSeconds > 0)
    .sort((a, b) => time(b.user.lastPlayed) - time(a.user.lastPlayed))[0];
  if (resumable) return resumable;

  let lastWatched = -1;
  let latest = 0;
  pool.forEach((e, i) => {
    if (e.user.played && time(e.user.lastPlayed) >= latest) {
      latest = time(e.user.lastPlayed);
      lastWatched = i;
    }
  });
  return (
    pool.slice(lastWatched + 1).find((e) => !e.user.played) ??
    pool.find((e) => !e.user.played) ??
    null
  );
}
