import { compareMovies } from './catalog.js';
import type { CollectionRule, Movie, PersonalData, RuleField, SmartRules } from './types.js';

/** Human-readable description of each supported rule field (shown in the editor). */
export const RULE_FIELDS: Record<RuleField, { label: string; kind: 'list' | 'range' | 'other' }> = {
  genre: { label: 'Genre', kind: 'list' },
  director: { label: 'Director', kind: 'list' },
  country: { label: 'Production country', kind: 'list' },
  tag: { label: 'Tag', kind: 'list' },
  studio: { label: 'Studio', kind: 'list' },
  officialRating: { label: 'Age rating', kind: 'list' },
  year: { label: 'Release year', kind: 'range' },
  runtime: { label: 'Runtime (minutes)', kind: 'range' },
  communityRating: { label: 'Community rating', kind: 'range' },
  personalRating: { label: 'My rating', kind: 'range' },
  watched: { label: 'Watch status', kind: 'other' },
  favorite: { label: 'Favorite', kind: 'other' },
  title: { label: 'Title contains', kind: 'other' },
  addedWithinDays: { label: 'Added within (days)', kind: 'other' },
};

export type PersonalLookup = (itemId: string) => PersonalData | undefined;

function inRange(value: number | null | undefined, min: number | null, max: number | null) {
  if (value == null) return false;
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}

export function ruleMatches(
  rule: CollectionRule,
  movie: Movie,
  personal: PersonalLookup,
  now: number = Date.now(),
): boolean {
  switch (rule.field) {
    case 'genre':
    case 'director':
    case 'country':
    case 'tag':
    case 'studio':
    case 'officialRating': {
      const source: string[] =
        rule.field === 'genre'
          ? movie.genres
          : rule.field === 'director'
            ? movie.directors
            : rule.field === 'country'
              ? movie.countries
              : rule.field === 'tag'
                ? movie.tags
                : rule.field === 'studio'
                  ? movie.studios
                  : movie.officialRating
                    ? [movie.officialRating]
                    : [];
      const wanted = rule.values.map((v) => v.toLowerCase());
      const hit = source.some((v) => wanted.includes(v.toLowerCase()));
      return rule.op === 'any' ? hit : !hit;
    }
    case 'year':
      return inRange(movie.year, rule.min, rule.max);
    case 'runtime':
      return inRange(movie.runtimeMinutes, rule.min, rule.max);
    case 'communityRating':
      return inRange(movie.communityRating, rule.min, rule.max);
    case 'personalRating':
      return inRange(personal(movie.id)?.rating, rule.min, rule.max);
    case 'watched':
      if (rule.value === 'watched') return movie.user.played;
      if (rule.value === 'unwatched') return !movie.user.played;
      return movie.user.positionSeconds > 0 && !movie.user.played;
    case 'favorite':
      return movie.user.favorite === rule.value;
    case 'title':
      return movie.title.toLowerCase().includes(rule.value.toLowerCase());
    case 'addedWithinDays': {
      if (!movie.dateAdded) return false;
      const ageDays = (now - Date.parse(movie.dateAdded)) / 86_400_000;
      return ageDays <= rule.value;
    }
  }
}

export function evaluateSmartCollection(
  rules: SmartRules,
  movies: Movie[],
  personal: PersonalLookup,
  now: number = Date.now(),
): Movie[] {
  const matched =
    rules.rules.length === 0
      ? []
      : movies.filter((movie) =>
          rules.match === 'all'
            ? rules.rules.every((rule) => ruleMatches(rule, movie, personal, now))
            : rules.rules.some((rule) => ruleMatches(rule, movie, personal, now)),
        );
  matched.sort((a, b) => compareMovies(a, b, rules.sort, rules.dir));
  return rules.limit ? matched.slice(0, rules.limit) : matched;
}

const LIST_FIELDS = new Set(['genre', 'director', 'country', 'tag', 'studio', 'officialRating']);
const RANGE_FIELDS = new Set(['year', 'runtime', 'communityRating', 'personalRating']);
const SORTS = new Set(['title', 'year', 'dateAdded', 'runtime', 'rating']);

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Range bounds must be numbers');
  return n;
}

/** Validate untrusted input into SmartRules; throws Error with a readable message. */
export function parseSmartRules(input: unknown): SmartRules {
  if (!input || typeof input !== 'object') throw new Error('Rules must be an object');
  const raw = input as Record<string, unknown>;
  const match = raw.match === 'any' ? 'any' : 'all';
  if (!Array.isArray(raw.rules)) throw new Error('rules must be an array');
  if (raw.rules.length > 25) throw new Error('A collection supports at most 25 rules');
  const rules: CollectionRule[] = raw.rules.map((value: unknown, i: number) => {
    if (!value || typeof value !== 'object') throw new Error(`Rule ${i + 1} is invalid`);
    const r = value as Record<string, unknown>;
    const field = String(r.field);
    if (LIST_FIELDS.has(field)) {
      if (!Array.isArray(r.values) || r.values.length === 0) {
        throw new Error(`Rule ${i + 1}: choose at least one value`);
      }
      return {
        field: field as 'genre',
        op: r.op === 'none' ? 'none' : 'any',
        values: r.values.map((v) => String(v).slice(0, 200)).slice(0, 100),
      };
    }
    if (RANGE_FIELDS.has(field)) {
      const min = finiteOrNull(r.min);
      const max = finiteOrNull(r.max);
      if (min == null && max == null) throw new Error(`Rule ${i + 1}: set a minimum or maximum`);
      return { field: field as 'year', op: 'between', min, max };
    }
    switch (field) {
      case 'watched':
        if (r.value !== 'watched' && r.value !== 'unwatched' && r.value !== 'inProgress') {
          throw new Error(`Rule ${i + 1}: invalid watch status`);
        }
        return { field: 'watched', op: 'is', value: r.value };
      case 'favorite':
        return { field: 'favorite', op: 'is', value: Boolean(r.value) };
      case 'title': {
        const text = String(r.value ?? '').trim();
        if (!text) throw new Error(`Rule ${i + 1}: enter some title text`);
        return { field: 'title', op: 'contains', value: text.slice(0, 200) };
      }
      case 'addedWithinDays': {
        const days = Number(r.value);
        if (!Number.isFinite(days) || days <= 0) throw new Error(`Rule ${i + 1}: days must be > 0`);
        return { field: 'addedWithinDays', op: 'lte', value: Math.round(days) };
      }
      default:
        throw new Error(`Rule ${i + 1}: unsupported field "${field}"`);
    }
  });
  const sort = SORTS.has(String(raw.sort)) ? (raw.sort as SmartRules['sort']) : 'title';
  const dir = raw.dir === 'desc' ? 'desc' : 'asc';
  const limitNum = raw.limit == null || raw.limit === '' ? null : Number(raw.limit);
  const limit =
    limitNum != null && Number.isFinite(limitNum) && limitNum > 0
      ? Math.min(500, Math.round(limitNum))
      : null;
  return { match, rules, sort, dir, limit };
}
