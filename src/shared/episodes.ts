import type { Episode } from './types.js';

/** "S1 E5", "S1 E5–6", "Special" */
export function episodeLabel(e: Pick<Episode, 'seasonNumber' | 'number' | 'endNumber'>): string {
  if (e.seasonNumber === 0) return 'Special';
  const ep = e.number == null ? '' : ` E${e.number}${e.endNumber ? `–${e.endNumber}` : ''}`;
  return `${e.seasonNumber == null ? '' : `S${e.seasonNumber}`}${ep}`.trim();
}
