import type {
  Density,
  HomeSectionId,
  HomeSectionPref,
  Preferences,
  SortDir,
  SortField,
  ThemeName,
} from './types.js';

export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: 'Projector gold', value: '#d9a856' },
  { name: 'Velvet red', value: '#d4504a' },
  { name: 'Lagoon', value: '#4fb3a9' },
  { name: 'Ivory', value: '#e8e1d1' },
  { name: 'Azure', value: '#6c9ef0' },
  { name: 'Orchid', value: '#c98bd8' },
];

export const THEMES: { value: ThemeName; label: string; description: string }[] = [
  { value: 'graphite', label: 'Graphite', description: 'Soft charcoal, the default' },
  { value: 'midnight', label: 'Midnight', description: 'True black, ideal for OLED screens' },
  { value: 'sepia', label: 'Sepia', description: 'Warm, film-lab darkness' },
];

export const BUILTIN_SECTIONS: { id: HomeSectionId; label: string }[] = [
  { id: 'hero', label: 'Featured movie' },
  { id: 'continueWatching', label: 'Continue Watching' },
  { id: 'recentlyAdded', label: 'Recently Added' },
  { id: 'favorites', label: 'Personal Favorites' },
  { id: 'collections', label: 'Your Collections' },
  { id: 'randomPick', label: 'Random Pick' },
  { id: 'unwatched', label: 'Not Yet Watched' },
  { id: 'genres', label: 'Browse by Genre' },
  { id: 'decades', label: 'Browse by Decade' },
];

export const BITRATE_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'Auto (no limit)', value: null },
  { label: '40 Mbps — 4K', value: 40_000_000 },
  { label: '20 Mbps — 1080p high', value: 20_000_000 },
  { label: '10 Mbps — 1080p', value: 10_000_000 },
  { label: '4 Mbps — 720p', value: 4_000_000 },
  { label: '1.5 Mbps — mobile data', value: 1_500_000 },
];

export const DEFAULT_PREFERENCES: Preferences = {
  appName: 'Private Cinema',
  theme: 'graphite',
  accent: '#d9a856',
  motion: 'system',
  density: 'comfortable',
  defaultSort: 'title',
  defaultSortDir: 'asc',
  heroSource: 'recentlyAdded',
  homeSections: BUILTIN_SECTIONS.map((s) => ({ id: s.id, visible: true })),
  playback: {
    maxBitrate: null,
    resumeBehavior: 'ask',
    subtitleLanguage: '',
    preferDirectPlay: true,
  },
  starterCollectionsCreated: false,
};

const THEME_SET = new Set<ThemeName>(['graphite', 'midnight', 'sepia']);
const DENSITY_SET = new Set<Density>(['compact', 'comfortable', 'large']);
const SORT_SET = new Set<SortField>(['title', 'year', 'dateAdded', 'runtime', 'rating']);
const HERO_SET = new Set(['recentlyAdded', 'random', 'favorites', 'continueWatching']);
const BUILTIN_IDS = new Set<string>(BUILTIN_SECTIONS.map((s) => s.id));

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function sanitizeSections(input: unknown): HomeSectionPref[] {
  const seen = new Set<string>();
  const out: HomeSectionPref[] = [];
  if (Array.isArray(input)) {
    for (const entry of input) {
      if (!entry || typeof entry !== 'object') continue;
      const id = String((entry as { id?: unknown }).id ?? '');
      const valid = BUILTIN_IDS.has(id) || /^collection:[\w-]{1,64}$/.test(id);
      if (!valid || seen.has(id)) continue;
      seen.add(id);
      out.push({ id: id as HomeSectionId, visible: Boolean((entry as { visible?: unknown }).visible) });
    }
  }
  // Newly introduced built-in sections appear at the end, visible.
  for (const section of BUILTIN_SECTIONS) {
    if (!seen.has(section.id)) out.push({ id: section.id, visible: true });
  }
  return out;
}

/**
 * Merge an untrusted partial update onto existing preferences, dropping invalid values.
 * Used both for PATCH requests and for reading stored JSON (forward compatibility).
 */
export function mergePreferences(base: Preferences, patch: unknown): Preferences {
  const next: Preferences = structuredClone(base);
  if (!patch || typeof patch !== 'object') return next;
  const p = patch as Record<string, unknown>;

  if (typeof p.appName === 'string') {
    const name = p.appName.trim().slice(0, 40);
    next.appName = name || DEFAULT_PREFERENCES.appName;
  }
  if (THEME_SET.has(p.theme as ThemeName)) next.theme = p.theme as ThemeName;
  if (isHexColor(p.accent)) next.accent = p.accent.toLowerCase();
  if (p.motion === 'system' || p.motion === 'reduced') next.motion = p.motion;
  if (DENSITY_SET.has(p.density as Density)) next.density = p.density as Density;
  if (SORT_SET.has(p.defaultSort as SortField)) next.defaultSort = p.defaultSort as SortField;
  if (p.defaultSortDir === 'asc' || p.defaultSortDir === 'desc') {
    next.defaultSortDir = p.defaultSortDir as SortDir;
  }
  if (HERO_SET.has(String(p.heroSource))) {
    next.heroSource = p.heroSource as Preferences['heroSource'];
  }
  if ('homeSections' in p) next.homeSections = sanitizeSections(p.homeSections);
  if (typeof p.starterCollectionsCreated === 'boolean') {
    next.starterCollectionsCreated = p.starterCollectionsCreated;
  }
  if (p.playback && typeof p.playback === 'object') {
    const pb = p.playback as Record<string, unknown>;
    if (pb.maxBitrate === null) next.playback.maxBitrate = null;
    else if (typeof pb.maxBitrate === 'number' && pb.maxBitrate >= 250_000) {
      next.playback.maxBitrate = Math.round(Math.min(pb.maxBitrate, 200_000_000));
    }
    if (pb.resumeBehavior === 'ask' || pb.resumeBehavior === 'resume' || pb.resumeBehavior === 'restart') {
      next.playback.resumeBehavior = pb.resumeBehavior;
    }
    if (typeof pb.subtitleLanguage === 'string' && /^[a-z]{0,3}$/.test(pb.subtitleLanguage)) {
      next.playback.subtitleLanguage = pb.subtitleLanguage;
    }
    if (typeof pb.preferDirectPlay === 'boolean') next.playback.preferDirectPlay = pb.preferDirectPlay;
  }
  next.homeSections = sanitizeSections(next.homeSections);
  return next;
}
