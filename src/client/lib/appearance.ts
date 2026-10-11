import type { Preferences } from '../../shared/types';

/** Pick near-black or near-white text for legibility on the accent colour. */
export function accentInk(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255);
  return luminance > 0.36 ? '#15110a' : '#fbf8f3';
}

const THEME_COLORS: Record<Preferences['theme'], string> = {
  graphite: '#0e0e10',
  midnight: '#000000',
  sepia: '#120e0b',
};

/** Apply appearance preferences to the document and cache them for the next load. */
export function applyAppearance(prefs: Preferences) {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.density = prefs.density;
  root.dataset.motion = prefs.motion;
  const ink = accentInk(prefs.accent);
  root.style.setProperty('--accent', prefs.accent);
  root.style.setProperty('--accent-ink', ink);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLORS[prefs.theme]);
  try {
    localStorage.setItem(
      'pc-appearance',
      JSON.stringify({
        theme: prefs.theme,
        density: prefs.density,
        motion: prefs.motion,
        accent: prefs.accent,
        accentInk: ink,
        appName: prefs.appName,
      }),
    );
  } catch {
    /* storage unavailable (private mode): fine, server copy is canonical */
  }
}

export function cachedAppName(): string {
  try {
    return JSON.parse(localStorage.getItem('pc-appearance') ?? 'null')?.appName ?? 'Private Cinema';
  } catch {
    return 'Private Cinema';
  }
}
