// Downloads for watching offline. The video, subtitles and poster go into the
// browser's Cache Storage; the service worker (public/sw.js) plays them from
// there, with seeking, whether or not the network is up. What's downloaded is
// listed in localStorage. Progress made offline is sent when back online.
import { useSyncExternalStore } from 'react';
import type { PlaybackInfo, PlaybackReport } from '../../shared/types';
import { api } from './api';
import { detectCapabilities } from './capabilities';
import { sizedImage } from './images';

export const DOWNLOADS_CACHE = 'wh-downloads';
const LIST_KEY = 'wh-downloads-v1';
const PENDING_KEY = 'wh-offline-progress-v1';

export interface DownloadEntry {
  id: string;
  kind: 'movie' | 'episode';
  title: string;
  /** e.g. the show and episode number. */
  subtitle: string | null;
  poster: string | null;
  runtimeMinutes: number | null;
  /** What the player needs to play it with no network. */
  playback: PlaybackInfo;
  /** Every URL put in the cache for this item. */
  urls: string[];
  bytes: number;
  status: 'downloading' | 'done' | 'failed';
  error?: string;
  downloadedAt: string;
}

export interface DownloadMeta {
  id: string;
  kind: 'movie' | 'episode';
  title: string;
  subtitle?: string | null;
  poster?: string | null;
  runtimeMinutes?: number | null;
}

export const downloadsSupported = () =>
  typeof window !== 'undefined' && 'caches' in window && 'serviceWorker' in navigator;

function readList(): DownloadEntry[] {
  try {
    const list = JSON.parse(localStorage.getItem(LIST_KEY) ?? '[]') as DownloadEntry[];
    // A download that was running when the page closed didn't finish.
    return list.map((e) =>
      e.status === 'downloading' ? { ...e, status: 'failed', error: 'Interrupted' } : e,
    );
  } catch {
    return [];
  }
}

let entries: DownloadEntry[] = readList();
const progress = new Map<string, number>();
const running = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let snapshot = { entries, progress: new Map(progress) };

function emit() {
  snapshot = { entries, progress: new Map(progress) };
  for (const l of listeners) l();
}

function save(next: DownloadEntry[]) {
  entries = next;
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(entries));
  } catch {
    /* storage full or blocked: the list lives for this session only */
  }
  emit();
}

const upsert = (entry: DownloadEntry) => save([entry, ...entries.filter((e) => e.id !== entry.id)]);

export function getDownloads(): DownloadEntry[] {
  return entries;
}

export function getDownload(id: string): DownloadEntry | null {
  return entries.find((e) => e.id === id) ?? null;
}

/** All downloads and their progress (0–1 for running ones), for React. */
export function useDownloads() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** Asks the browser not to clear downloads when space runs low. */
async function persistStorage() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted()))
      await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}

async function cacheUrl(cache: Cache, url: string, signal: AbortSignal) {
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok) throw new Error(`Couldn’t download (${res.status})`);
  await cache.put(url, res);
}

export async function startDownload(meta: DownloadMeta) {
  if (!downloadsSupported()) throw new Error('This browser can’t save videos for offline.');
  if (running.has(meta.id)) return;
  const abort = new AbortController();
  running.set(meta.id, abort);
  // Make sure the app itself (page and player) is saved for offline too.
  void fetch('/', { credentials: 'same-origin' }).catch(() => undefined);
  void import('../player/PlayerPage').catch(() => undefined);
  progress.set(meta.id, 0);
  const base: Omit<DownloadEntry, 'playback' | 'urls' | 'bytes'> = {
    id: meta.id,
    kind: meta.kind,
    title: meta.title,
    subtitle: meta.subtitle ?? null,
    poster: meta.poster ? (sizedImage(meta.poster, 320) ?? meta.poster) : null,
    runtimeMinutes: meta.runtimeMinutes ?? null,
    status: 'downloading',
    downloadedAt: new Date().toISOString(),
  };
  try {
    const playback = await api<PlaybackInfo>(`/movies/${meta.id}/playback`, {
      method: 'POST',
      body: { capabilities: detectCapabilities(), startSeconds: 0 },
    });
    if (playback.delivery !== 'file') {
      throw new Error('This one is converted while it plays, so it can’t be downloaded.');
    }
    const urls = [
      playback.url,
      ...playback.subtitles.map((s) => s.url).filter(Boolean),
    ] as string[];
    if (base.poster) urls.push(base.poster);
    upsert({ ...base, playback, urls, bytes: 0 });
    void persistStorage();
    const cache = await caches.open(DOWNLOADS_CACHE);

    // The video, counting bytes as they arrive.
    const res = await fetch(playback.url, { credentials: 'same-origin', signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`Couldn’t download the video (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    let done = 0;
    let lastEmit = 0;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          done += chunk.byteLength;
          if (total && Date.now() - lastEmit > 250) {
            lastEmit = Date.now();
            progress.set(meta.id, Math.min(0.99, done / total));
            emit();
          }
          controller.enqueue(chunk);
        },
      }),
    );
    const headers = new Headers({
      'Content-Type': res.headers.get('content-type') ?? 'video/mp4',
    });
    if (total) headers.set('Content-Length', String(total));
    await cache.put(playback.url, new Response(counted, { status: 200, headers }));
    for (const url of urls.slice(1))
      await cacheUrl(cache, url, abort.signal).catch(() => undefined);
    upsert({ ...base, playback, urls, bytes: done, status: 'done' });
  } catch (error) {
    const cancelled = abort.signal.aborted;
    if (cancelled) {
      await removeDownload(meta.id);
    } else {
      const existing = getDownload(meta.id);
      upsert({
        ...(existing ?? { ...base, playback: null as never, urls: [], bytes: 0 }),
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!cancelled) throw error;
  } finally {
    running.delete(meta.id);
    progress.delete(meta.id);
    emit();
  }
}

export function cancelDownload(id: string) {
  running.get(id)?.abort();
}

export async function removeDownload(id: string) {
  running.get(id)?.abort();
  const entry = getDownload(id);
  save(entries.filter((e) => e.id !== id));
  if (!entry || !downloadsSupported()) return;
  const cache = await caches.open(DOWNLOADS_CACHE);
  // Keep files another download still uses (e.g. the same poster).
  const stillUsed = new Set(entries.flatMap((e) => e.urls));
  await Promise.all(entry.urls.filter((u) => !stillUsed.has(u)).map((u) => cache.delete(u)));
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { used: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Watching offline: remember where you got to, and tell the server later.

interface PendingProgress {
  itemId: string;
  positionSeconds: number;
  at: string;
}

function readPending(): Record<string, PendingProgress> {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}') as Record<string, PendingProgress>;
  } catch {
    return {};
  }
}

/** Keeps the latest position for an item that couldn't be reported. */
export function rememberOfflineProgress(
  report: Pick<PlaybackReport, 'itemId' | 'positionSeconds'>,
) {
  const all = readPending();
  all[report.itemId] = {
    itemId: report.itemId,
    positionSeconds: report.positionSeconds,
    at: new Date().toISOString(),
  };
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(all));
  } catch {
    /* nothing more to do */
  }
}

/** Where to start an offline item: its last offline position, if any. */
export function offlinePosition(id: string): number {
  return readPending()[id]?.positionSeconds ?? 0;
}

let flushing = false;
/** Sends progress made offline (as a start + stop, so resume points and "watched" update). */
export async function flushOfflineProgress() {
  if (flushing) return;
  flushing = true;
  try {
    const all = readPending();
    for (const p of Object.values(all)) {
      const session = `offline-${p.itemId}-${Date.parse(p.at)}`;
      const body = {
        itemId: p.itemId,
        mediaSourceId: p.itemId,
        playSessionId: session,
        isPaused: true,
        method: 'DirectPlay',
        audioStreamIndex: null,
        subtitleStreamIndex: null,
      };
      try {
        await api('/playback/start', { method: 'POST', body: { ...body, positionSeconds: 0 } });
        await api('/playback/stop', {
          method: 'POST',
          body: { ...body, positionSeconds: p.positionSeconds },
        });
        const left = readPending();
        if (left[p.itemId]?.at === p.at) delete left[p.itemId];
        localStorage.setItem(PENDING_KEY, JSON.stringify(left));
      } catch {
        break; // still offline, or signed out: try again later
      }
    }
  } finally {
    flushing = false;
  }
}

/** Registers the service worker and sends offline progress whenever the network returns. */
export function installOfflineSupport() {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  window.addEventListener('online', () => void flushOfflineProgress());
  if (navigator.onLine) void flushOfflineProgress();
}
