import type { MovieQuery } from '../../shared/types';

/** Runtime filters as people think about them, rather than raw minute limits. */
export const RUNTIME_PRESETS: { id: string; label: string; min?: number; max?: number }[] = [
  { id: 'short', label: 'Under 90 min', max: 89 },
  { id: 'standard', label: '90 min – 2 hours', min: 90, max: 120 },
  { id: 'long', label: 'Over 2 hours', min: 121 },
  { id: 'epic', label: 'Epic: 2½ hours +', min: 150 },
];

export function runtimePreset(q: Pick<MovieQuery, 'runtimeMin' | 'runtimeMax'>) {
  return RUNTIME_PRESETS.find((p) => p.min === q.runtimeMin && p.max === q.runtimeMax) ?? null;
}

/** Short description of a runtime filter, or null when there is none. */
export function runtimeLabel(q: Pick<MovieQuery, 'runtimeMin' | 'runtimeMax'>): string | null {
  if (q.runtimeMin == null && q.runtimeMax == null) return null;
  const preset = runtimePreset(q);
  if (preset) return preset.label;
  if (q.runtimeMin != null && q.runtimeMax != null) return `${q.runtimeMin}–${q.runtimeMax} min`;
  if (q.runtimeMax != null) return `Under ${q.runtimeMax + 1} min`;
  return `${q.runtimeMin} min +`;
}

/** The selected decade, when the year range is exactly one decade. */
export function selectedDecade(q: Pick<MovieQuery, 'yearMin' | 'yearMax'>): number | null {
  return q.yearMin != null && q.yearMax === q.yearMin + 9 && q.yearMin % 10 === 0
    ? q.yearMin
    : null;
}
