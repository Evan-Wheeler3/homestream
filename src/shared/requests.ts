import type { Movie } from './types.js';

/** Title comparison that ignores case, punctuation and a leading "The"/"A". */
export function titleKey(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

/** A library movie matching a requested title (and year, when given, ±1). */
export function findInLibrary(library: Movie[], title: string, year: number | null): Movie | null {
  const key = titleKey(title);
  return (
    library.find(
      (m) =>
        (titleKey(m.title) === key ||
          (m.originalTitle != null && titleKey(m.originalTitle) === key)) &&
        (year == null || m.year == null || Math.abs(m.year - year) <= 1),
    ) ?? null
  );
}
