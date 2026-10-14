import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SECTIONS,
  DEFAULT_PREFERENCES,
  mergePreferences,
} from '../../src/shared/preferences';

describe('mergePreferences', () => {
  it('applies valid values and ignores invalid ones', () => {
    const next = mergePreferences(DEFAULT_PREFERENCES, {
      theme: 'midnight',
      accent: '#ABCDEF',
      density: 'huge',
      appName: '  Our Cinema  ',
      playback: { maxBitrate: 10, resumeBehavior: 'restart', subtitleLanguage: 'english' },
    });
    expect(next.theme).toBe('midnight');
    expect(next.accent).toBe('#abcdef');
    expect(next.density).toBe(DEFAULT_PREFERENCES.density);
    expect(next.appName).toBe('Our Cinema');
    expect(next.playback.maxBitrate).toBe(DEFAULT_PREFERENCES.playback.maxBitrate);
    expect(next.playback.resumeBehavior).toBe('restart');
    expect(next.playback.subtitleLanguage).toBe('');
  });

  it('does not mutate the base object', () => {
    const base = structuredClone(DEFAULT_PREFERENCES);
    mergePreferences(base, { theme: 'sepia' });
    expect(base.theme).toBe('graphite');
  });

  it('sanitises home sections: drops unknown ids and duplicates, appends missing built-ins', () => {
    const next = mergePreferences(DEFAULT_PREFERENCES, {
      homeSections: [
        { id: 'favorites', visible: false },
        { id: 'collection:abc-123', visible: true },
        { id: 'favorites', visible: true },
        { id: 'not-a-section', visible: true },
        { id: 'collection:../../etc', visible: true },
      ],
    });
    const ids = next.homeSections.map((s) => s.id);
    // Kept as given (first occurrence wins), in the same order…
    expect(next.homeSections.find((s) => s.id === 'favorites')).toEqual({
      id: 'favorites',
      visible: false,
    });
    expect(ids.indexOf('collection:abc-123')).toBeGreaterThan(ids.indexOf('favorites'));
    // …with missing built-ins slotted in after the section that precedes them by default.
    expect(ids[0]).toBe('hero');
    expect(ids.indexOf('collections')).toBe(ids.indexOf('favorites') + 1);
    expect(next.homeSections.filter((s) => s.id === 'favorites')).toHaveLength(1);
    expect(next.homeSections.some((s) => (s.id as string) === 'not-a-section')).toBe(false);
    expect(next.homeSections.some((s) => s.id.includes('..'))).toBe(false);
    expect(next.homeSections).toHaveLength(BUILTIN_SECTIONS.length + 1);
  });

  it('adds new built-in sections next to their neighbours for existing users', () => {
    // A saved layout from before "My Watchlist" and "Because You Watched" existed.
    const saved = DEFAULT_PREFERENCES.homeSections.filter(
      (s) => s.id !== 'watchlist' && s.id !== 'becauseYouWatched',
    );
    const ids = mergePreferences(DEFAULT_PREFERENCES, { homeSections: saved }).homeSections.map(
      (s) => s.id,
    );
    expect(ids.indexOf('watchlist')).toBe(ids.indexOf('continueWatching') + 1);
    expect(ids.indexOf('becauseYouWatched')).toBe(ids.indexOf('recentlyAdded') + 1);
  });

  it('falls back to the default name when blank', () => {
    expect(mergePreferences(DEFAULT_PREFERENCES, { appName: '   ' }).appName).toBe('Wheelhouse');
  });
});
