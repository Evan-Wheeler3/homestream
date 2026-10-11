import { describe, expect, it } from 'vitest';
import { evaluateSmartCollection, parseSmartRules, ruleMatches } from '../../src/shared/rules';
import type { PersonalData } from '../../src/shared/types';
import { movie } from '../fixtures';

const now = Date.parse('2026-10-01T00:00:00Z');
const films = [
  movie({
    id: 'tokyo',
    title: 'Tokyo Story',
    year: 1953,
    runtimeMinutes: 136,
    countries: ['Japan'],
    officialRating: null,
    tags: [],
  }),
  movie({
    id: 'totoro',
    title: 'My Neighbor Totoro',
    year: 1988,
    runtimeMinutes: 86,
    countries: ['Japan'],
    officialRating: 'G',
    tags: ['family'],
    dateAdded: '2026-09-20T00:00:00Z',
  }),
  movie({
    id: 'fargo',
    title: 'Fargo',
    year: 1996,
    runtimeMinutes: 98,
    countries: ['United States'],
    officialRating: 'R',
    user: { favorite: true } as never,
  }),
  movie({
    id: 'heat',
    title: 'Heat',
    year: 1995,
    runtimeMinutes: 170,
    countries: ['United States'],
    officialRating: 'R',
    dateAdded: '2025-01-01T00:00:00Z',
  }),
];
const personal = new Map<string, PersonalData>([
  ['heat', { rating: 5, notes: '', updatedAt: null }],
]);
const lookup = (id: string) => personal.get(id);

describe('ruleMatches', () => {
  it('handles list rules case-insensitively with any/none', () => {
    expect(ruleMatches({ field: 'country', op: 'any', values: ['japan'] }, films[0]!, lookup)).toBe(
      true,
    );
    expect(
      ruleMatches({ field: 'country', op: 'none', values: ['Japan'] }, films[0]!, lookup),
    ).toBe(false);
  });
  it('handles open-ended ranges and missing values', () => {
    expect(
      ruleMatches({ field: 'runtime', op: 'between', min: null, max: 99 }, films[1]!, lookup),
    ).toBe(true);
    expect(
      ruleMatches({ field: 'runtime', op: 'between', min: null, max: 99 }, films[3]!, lookup),
    ).toBe(false);
    expect(
      ruleMatches({ field: 'personalRating', op: 'between', min: 4, max: null }, films[0]!, lookup),
    ).toBe(false);
    expect(
      ruleMatches({ field: 'personalRating', op: 'between', min: 4, max: null }, films[3]!, lookup),
    ).toBe(true);
  });
  it('evaluates "added within N days" relative to now', () => {
    expect(
      ruleMatches({ field: 'addedWithinDays', op: 'lte', value: 30 }, films[1]!, lookup, now),
    ).toBe(true);
    expect(
      ruleMatches({ field: 'addedWithinDays', op: 'lte', value: 30 }, films[3]!, lookup, now),
    ).toBe(false);
    expect(
      ruleMatches({ field: 'addedWithinDays', op: 'lte', value: 30 }, films[0]!, lookup, now),
    ).toBe(false);
  });
});

describe('evaluateSmartCollection', () => {
  it('combines rules with all/any and applies sort + limit', () => {
    const all = evaluateSmartCollection(
      {
        match: 'all',
        rules: [
          { field: 'country', op: 'any', values: ['Japan'] },
          { field: 'year', op: 'between', min: 1980, max: null },
        ],
        sort: 'year',
        dir: 'asc',
        limit: null,
      },
      films,
      lookup,
    );
    expect(all.map((m) => m.id)).toEqual(['totoro']);
    const any = evaluateSmartCollection(
      {
        match: 'any',
        rules: [
          { field: 'officialRating', op: 'any', values: ['G'] },
          { field: 'favorite', op: 'is', value: true },
        ],
        sort: 'title',
        dir: 'asc',
        limit: 1,
      },
      films,
      lookup,
    );
    expect(any.map((m) => m.id)).toEqual(['fargo']);
  });
  it('returns nothing for a collection with no rules', () => {
    expect(
      evaluateSmartCollection(
        { match: 'all', rules: [], sort: 'title', dir: 'asc', limit: null },
        films,
        lookup,
      ),
    ).toEqual([]);
  });
});

describe('parseSmartRules', () => {
  it('accepts valid input and normalises defaults', () => {
    const parsed = parseSmartRules({
      rules: [{ field: 'year', op: 'between', min: '1990', max: 1999 }],
      sort: 'bogus',
      limit: '0',
    });
    expect(parsed).toEqual({
      match: 'all',
      rules: [{ field: 'year', op: 'between', min: 1990, max: 1999 }],
      sort: 'title',
      dir: 'asc',
      limit: null,
    });
  });
  it('rejects unsupported fields and incomplete rules with readable messages', () => {
    expect(() => parseSmartRules({ rules: [{ field: 'actor', values: ['x'] }] })).toThrow(
      /unsupported field "actor"/,
    );
    expect(() => parseSmartRules({ rules: [{ field: 'genre', values: [] }] })).toThrow(
      /at least one value/,
    );
    expect(() => parseSmartRules({ rules: [{ field: 'runtime', min: null, max: null }] })).toThrow(
      /minimum or maximum/,
    );
    expect(() => parseSmartRules({ rules: [{ field: 'year', min: 'abc' }] })).toThrow(/numbers/);
    expect(() => parseSmartRules('nope')).toThrow();
  });
});
