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
export function identify(guess: string, results: Candidate[]): Identification {
  const target = normalizeTitle(guess);
  const exact = results.filter((r) => normalizeTitle(r.title) === target && r.year);
  // Only when the exact match is also the best search result: a label like
  // A_NEW_HOPE matches an obscure film of that name, while the search ranks
  // Star Wars (1977) first.
  if (exact.length === 1 && results[0] === exact[0]) {
    return { kind: 'confident', match: exact[0]! };
  }
  if (exact.length === 1) {
    return {
      kind: 'unsure',
      reason: `Is this “${exact[0]!.title}” (${exact[0]!.year}), or another movie?`,
      candidates: [...new Set([...results.slice(0, 7), exact[0]!])],
    };
  }
  if (exact.length > 1) {
    return {
      kind: 'unsure',
      reason: `There are ${exact.length} movies called “${exact[0]!.title}”. Which one is this?`,
      candidates: exact.slice(0, 8),
    };
  }
  return {
    kind: 'unsure',
    reason: results.length
      ? `Couldn’t be sure which movie “${guess}” is.`
      : `Couldn’t find a movie called “${guess}”.`,
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
