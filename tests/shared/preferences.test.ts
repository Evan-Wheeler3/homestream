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
    expect(next.homeSections[0]).toEqual({ id: 'favorites', visible: false });
    expect(next.homeSections[1]).toEqual({ id: 'collection:abc-123', visible: true });
    expect(next.homeSections.filter((s) => s.id === 'favorites')).toHaveLength(1);
    expect(next.homeSections.some((s) => (s.id as string) === 'not-a-section')).toBe(false);
    expect(next.homeSections.some((s) => s.id.includes('..'))).toBe(false);
    expect(next.homeSections).toHaveLength(BUILTIN_SECTIONS.length + 1);
  });

  it('falls back to the default name when blank', () => {
    expect(mergePreferences(DEFAULT_PREFERENCES, { appName: '   ' }).appName).toBe(
      'Private Cinema',
    );
  });
});
