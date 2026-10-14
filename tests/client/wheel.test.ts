import { describe, expect, it } from 'vitest';
import { RUNTIME_PRESETS, runtimeLabel, selectedDecade } from '../../src/client/lib/filters';
import {
  sliceAt,
  slicePath,
  spinEase,
  targetRotation,
  wheelLabel,
} from '../../src/client/lib/wheel';

describe('movie wheel', () => {
  it('always stops with the chosen movie under the pointer', () => {
    for (const count of [2, 5, 6, 8, 12]) {
      let rotation = 0;
      for (let winner = 0; winner < count; winner++) {
        for (const offset of [-0.5, -0.2, 0, 0.2, 0.5]) {
          const end = targetRotation(rotation, winner, count, 5, offset);
          expect(sliceAt(end, count)).toBe(winner);
          // At least the requested number of full turns, always forwards.
          expect(end - rotation).toBeGreaterThanOrEqual(5 * 360);
          expect(end - rotation).toBeLessThan(6 * 360);
          rotation = end;
        }
      }
    }
  });

  it('reports the slice under the pointer as the wheel turns', () => {
    expect(sliceAt(0, 8)).toBe(0);
    expect(sliceAt(-50, 8)).toBe(1); // turning anticlockwise brings slice 1 to the top
    expect(sliceAt(10, 8)).toBe(7);
    expect(sliceAt(360 * 3 + 10, 8)).toBe(7);
  });

  it('eases from a fast start to a stop', () => {
    expect(spinEase(0)).toBe(0);
    expect(spinEase(1)).toBe(1);
    expect(spinEase(0.5)).toBeGreaterThan(0.9);
    expect(spinEase(2)).toBe(1);
  });

  it('draws closed slices and shortens long titles on a word boundary', () => {
    expect(slicePath(0, 4, 100)).toMatch(
      /^M0 0 L0\.000 -100\.000 A100 100 0 0 1 100\.000 0\.000 Z$/,
    );
    expect(wheelLabel('Seven Samurai', 17)).toBe('Seven Samurai');
    expect(wheelLabel('The Passion of Joan of Arc', 17)).toBe('The Passion of…');
  });
});

describe('quick filters', () => {
  it('describes runtime filters in plain words', () => {
    expect(runtimeLabel({})).toBeNull();
    expect(runtimeLabel({ runtimeMin: 90, runtimeMax: 120 })).toBe('90 min – 2 hours');
    expect(runtimeLabel({ runtimeMax: 99 })).toBe('Under 100 min');
    expect(runtimeLabel({ runtimeMin: 60 })).toBe('60 min +');
    expect(
      RUNTIME_PRESETS.map((p) => runtimeLabel({ runtimeMin: p.min, runtimeMax: p.max })),
    ).toEqual(RUNTIME_PRESETS.map((p) => p.label));
  });

  it('recognises a whole decade', () => {
    expect(selectedDecade({ yearMin: 1960, yearMax: 1969 })).toBe(1960);
    expect(selectedDecade({ yearMin: 1962, yearMax: 1971 })).toBeNull();
    expect(selectedDecade({ yearMin: 1960 })).toBeNull();
  });
});
