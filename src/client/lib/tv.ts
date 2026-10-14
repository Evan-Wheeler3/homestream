import { useSyncExternalStore } from 'react';

/**
 * TV mode: a larger, remote-friendly layout with arrow-key ("spatial")
 * navigation. It is a per-device choice, so it lives in localStorage rather
 * than in the synced preferences.
 */

export type TvSetting = 'auto' | 'on' | 'off';

const STORAGE_KEY = 'wh-tv-mode';

/** Smart-TV browsers: LG webOS (old and new), Samsung Tizen, Fire TV, Android/Google TV, etc. */
const TV_UA =
  /smart-?tv|web0s|webos|netcast|tizen|hbbtv|bravia|viera|aquos|roku|aft[a-z]|crkey|googletv|android tv/i;

export function isTvUserAgent(userAgent: string): boolean {
  return TV_UA.test(userAgent);
}

function readSetting(): TvSetting {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'on' || v === 'off' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

let setting: TvSetting = typeof window === 'undefined' ? 'auto' : readSetting();
const listeners = new Set<() => void>();

export function tvSetting(): TvSetting {
  return setting;
}

export function isTvMode(): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return typeof navigator !== 'undefined' && isTvUserAgent(navigator.userAgent);
}

function apply() {
  if (typeof document === 'undefined') return;
  if (isTvMode()) document.documentElement.dataset.tv = '';
  else delete document.documentElement.dataset.tv;
}

export function setTvSetting(next: TvSetting) {
  setting = next;
  try {
    if (next === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable: the choice lasts for this visit */
  }
  apply();
  listeners.forEach((l) => l());
}

export function useTvMode(): { enabled: boolean; setting: TvSetting } {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => setting,
    () => 'auto' as TvSetting,
  );
  return { enabled: isTvMode(), setting: current };
}

// -----------------------------------------------------------------------------
// Remote control keys

export type RemoteKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'back'
  | 'play'
  | 'pause'
  | 'playPause'
  | 'stop'
  | 'fastForward'
  | 'rewind';

const BY_KEY: Record<string, RemoteKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
  Enter: 'enter',
  GoBack: 'back',
  BrowserBack: 'back',
  XF86Back: 'back',
  MediaPlay: 'play',
  MediaPause: 'pause',
  MediaPlayPause: 'playPause',
  MediaStop: 'stop',
  MediaFastForward: 'fastForward',
  MediaRewind: 'rewind',
  MediaTrackNext: 'fastForward',
  MediaTrackPrevious: 'rewind',
};

/** Key codes used by TV browsers that report `key` as "Unidentified". */
const BY_CODE: Record<number, RemoteKey> = {
  37: 'left',
  38: 'up',
  39: 'right',
  40: 'down',
  13: 'enter',
  461: 'back', // LG webOS
  10009: 'back', // Samsung Tizen
  415: 'play',
  19: 'pause',
  10252: 'playPause',
  179: 'playPause',
  413: 'stop',
  417: 'fastForward',
  412: 'rewind',
};

export function remoteKey(event: Pick<KeyboardEvent, 'key' | 'keyCode'>): RemoteKey | null {
  return BY_KEY[event.key] ?? BY_CODE[event.keyCode] ?? null;
}

// Apply as early as possible so the first paint already uses the TV layout.
apply();
