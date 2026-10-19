/** Turning disc labels into movie titles, and titles into Jellyfin-friendly file names. */

// Words on disc labels that describe the disc rather than the movie.
// Kept short on purpose: a word like "FULL" or "US" can be part of a real title.
const NOISE = new Set([
  'WS',
  'FS',
  'WIDESCREEN',
  'FULLSCREEN',
  '16X9',
  '4X3',
  'NTSC',
  'PAL',
  'DVD',
  'DVD5',
  'DVD9',
  'BLURAY',
  'R1',
  'R2',
  'R4',
  'SE',
  'CE',
  'ANNIVERSARY',
  'ANNIV',
  'UNRATED',
  'THEATRICAL',
  'REMASTERED',
]);

const DISC_NUMBER = /^(D|DISC|DISK|DVD|CD)\d{1,2}$/;
const SMALL_WORDS = new Set(['a', 'an', 'and', 'the', 'of', 'in', 'on', 'to', 'for', 'at', 'or']);

function titleCase(words: string[]): string {
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      if (/^[ivx]+$/i.test(w) && w.length <= 4) return w.toUpperCase(); // Roman numerals
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/**
 * Best guess at a searchable title. MakeMKV's disc name is used when it looks
 * like real metadata (mixed case); otherwise the volume label is cleaned up:
 * "STAR_WARS_EP4_WS_D1" → "Star Wars Ep4".
 */
export function guessTitle(discName: string, volumeLabel: string): string {
  const meta = discName.trim();
  if (meta && /[a-z]/.test(meta) && /[A-Z]/.test(meta) && !/_/.test(meta)) return meta;
  const label = (volumeLabel || discName).trim();
  const words = label
    .replace(/[_.-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const kept = words.filter((w) => {
    const up = w.toUpperCase();
    return !NOISE.has(up) && !DISC_NUMBER.test(up);
  });
  return titleCase(kept.length ? kept : words);
}

/** Normalised form for comparing titles: lowercase, no articles or punctuation. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Candidate {
  title: string;
  year: number | null;
  tmdbId: string | null;
  imdbId: string | null;
}

export type Identification =
  | { kind: 'confident'; match: Candidate }
  | { kind: 'unsure'; reason: string; candidates: Candidate[] };

/**
 * Decide whether search results identify the disc. Confident only when exactly
 * one result matches the guessed title exactly (ignoring case, articles and
 * punctuation); several exact matches means remakes ("Godzilla" 1954 vs 2014).
 */
export function identify(
  guess: string,
  results: Candidate[],
  noun: 'movie' | 'show' = 'movie',
): Identification {
  const target = normalizeTitle(guess);
  const exact = results.filter((r) => normalizeTitle(r.title) === target && r.year);
  if (exact.length === 1) return { kind: 'confident', match: exact[0]! };
  if (exact.length > 1) {
    return {
      kind: 'unsure',
      reason: `There are ${exact.length} ${noun}s called “${exact[0]!.title}”. Which one is this?`,
      candidates: exact.slice(0, 8),
    };
  }
  return {
    kind: 'unsure',
    reason: results.length
      ? `Couldn’t be sure which ${noun} “${guess}” is.`
      : `Couldn’t find a ${noun} called “${guess}”.`,
    candidates: results.slice(0, 8),
  };
}

/** Remove characters that are not allowed (or are awkward) in file names on macOS/Windows. */
export function safeFileName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150);
}

/**
 * Jellyfin naming: "Movies/Title (Year) [tmdbid-123]/Title (Year).mp4". The
 * id in the folder name makes Jellyfin match the exact movie.
 */
export function movieFileNames(match: {
  title: string;
  year: number | null;
  tmdbId: string | null;
}) {
  const base = safeFileName(match.year ? `${match.title} (${match.year})` : match.title);
  const folder = match.tmdbId ? `${base} [tmdbid-${match.tmdbId}]` : base;
  return { folder, file: `${base}.mp4` };
}

const SEASON_WORD = /^(SEASON|SERIES|SEA|S)(\d{1,2})?$/;
const SEASON_AND_DISC = /^S(\d{1,2})D(\d{1,2})$/;
const DISC_WORD = /^(D|DISC|DISK|DVD)$/;

/**
 * Show name, season and disc number from a TV disc's label or name:
 * "THE_OFFICE_S1_D2" → The Office, season 1, disc 2;
 * "Friends: Season 3 (Disc 1)" → Friends, season 3, disc 1.
 */
export function guessTv(
  discName: string,
  volumeLabel: string,
): { show: string; season: number | null; disc: number | null } {
  const meta = discName.trim();
  if (meta && /[a-z]/.test(meta) && /[A-Z]/.test(meta) && !/_/.test(meta)) {
    const season = /\b(?:season|series)\s*(\d{1,2})\b/i.exec(meta);
    const disc = /\b(?:disc|disk|dvd)\s*(\d{1,2})\b/i.exec(meta);
    const show = meta
      .replace(/[:\-–(,]?\s*\b(season|series)\s*\d{1,2}\b.*$/i, '')
      .replace(/[:\-–(,]?\s*\b(disc|disk|dvd)\s*\d{1,2}\b.*$/i, '')
      .replace(/[\s:\-–(,]+$/, '')
      .trim();
    return {
      show: show || meta,
      season: season ? Number(season[1]) : null,
      disc: disc ? Number(disc[1]) : null,
    };
  }
  const words = (volumeLabel || discName)
    .trim()
    .replace(/[_.-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
  let season: number | null = null;
  let disc: number | null = null;
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    const both = SEASON_AND_DISC.exec(w);
    if (both) {
      season = Number(both[1]);
      disc = Number(both[2]);
      continue;
    }
    const s = SEASON_WORD.exec(w);
    if (s && (s[2] || (next && /^\d{1,2}$/.test(next)))) {
      season = Number(s[2] ?? next);
      if (!s[2]) i++;
      continue;
    }
    const d = DISC_NUMBER.exec(w);
    if (d) {
      disc = Number(w.replace(/\D/g, ''));
      continue;
    }
    if (DISC_WORD.test(w) && next && /^\d{1,2}$/.test(next)) {
      disc = Number(next);
      i++;
      continue;
    }
    if (NOISE.has(w)) continue;
    kept.push(w);
  }
  return { show: titleCase(kept.length ? kept : words), season, disc };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Jellyfin naming for episodes:
 * "TV Shows/Show (Year) [tmdbid-123]/Season 01/Show S01E05.mp4".
 */
export function episodeFileNames(show: {
  title: string;
  year: number | null;
  tmdbId: string | null;
  season: number;
  episode: number;
}) {
  const name = safeFileName(show.title);
  const base = safeFileName(show.year ? `${show.title} (${show.year})` : show.title);
  return {
    folder: show.tmdbId ? `${base} [tmdbid-${show.tmdbId}]` : base,
    seasonFolder: `Season ${pad(show.season)}`,
    file: `${name} S${pad(show.season)}E${pad(show.episode)}.mp4`,
  };
}
