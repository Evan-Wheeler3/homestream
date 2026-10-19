import fs from 'node:fs';
import path from 'node:path';
import type { MediaSourceKind } from '../shared/types.js';
import type { RipperConfig } from './ripper/ripper.js';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  source: MediaSourceKind;
  jellyfinUrl: string | null;
  mockPassword: string;
  cookieSecure: 'auto' | boolean;
  trustProxy: boolean;
  sessionDays: number;
  catalogTtlSeconds: number;
  clientDir: string | null;
  version: string;
  /** Automatic disc ripping (off unless RIPPER_ENABLED is set). */
  ripper: RipperConfig;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function normalizeUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('JELLYFIN_URL must start with http:// or https://');
  }
  return url.toString().replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const jellyfinUrl = normalizeUrl(env.JELLYFIN_URL);
  const requested = (env.MEDIA_SOURCE ?? 'auto').toLowerCase();
  let source: MediaSourceKind;
  if (requested === 'mock') source = 'mock';
  else if (requested === 'jellyfin') {
    if (!jellyfinUrl) throw new Error('MEDIA_SOURCE=jellyfin requires JELLYFIN_URL');
    source = 'jellyfin';
  } else source = jellyfinUrl ? 'jellyfin' : 'mock';

  const cookieSecureRaw = (env.COOKIE_SECURE ?? 'auto').toLowerCase();
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    source,
    jellyfinUrl,
    mockPassword: env.MOCK_PASSWORD ?? 'demo',
    cookieSecure: cookieSecureRaw === 'auto' ? 'auto' : bool(cookieSecureRaw, false),
    trustProxy: bool(env.TRUST_PROXY, false),
    sessionDays: Math.max(1, Number(env.SESSION_DAYS ?? 30)),
    catalogTtlSeconds: Math.max(10, Number(env.CATALOG_TTL_SECONDS ?? 300)),
    clientDir: env.CLIENT_DIR === undefined ? path.resolve('dist/client') : env.CLIENT_DIR || null,
    version: env.npm_package_version ?? APP_VERSION,
    ripper: loadRipperConfig(env),
  };
}

const MAKEMKVCON_MAC = '/Applications/MakeMKV.app/Contents/MacOS/makemkvcon';

function firstExisting(paths: string[]): string {
  return paths.find((p) => fs.existsSync(p)) ?? paths[0]!;
}

export function loadRipperConfig(env: NodeJS.ProcessEnv): RipperConfig {
  const num = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return value != null && value !== '' && Number.isFinite(n) ? n : fallback;
  };
  const publicUrl = env.WHEELHOUSE_PUBLIC_URL?.trim().replace(/\/+$/, '') || null;
  return {
    enabled: bool(env.RIPPER_ENABLED, false),
    ripsDir: path.resolve(env.RIPS_DIR || '/Volumes/LaCie/Rips'),
    moviesDir: path.resolve(env.MOVIES_DIR || '/Volumes/LaCie/Movies'),
    tvDir: path.resolve(env.TV_DIR || '/Volumes/LaCie/TV Shows'),
    volumesDir: env.DISC_VOLUMES_DIR || '/Volumes',
    makemkvcon: env.MAKEMKVCON || firstExisting([MAKEMKVCON_MAC, '/usr/bin/makemkvcon']),
    handbrakeCli:
      env.HANDBRAKE_CLI ||
      firstExisting([
        '/usr/local/bin/HandBrakeCLI',
        '/opt/homebrew/bin/HandBrakeCLI',
        '/Applications/HandBrakeCLI',
        '/usr/bin/HandBrakeCLI',
      ]),
    preset: env.HANDBRAKE_PRESET || 'Fast 1080p30',
    quality: num(env.HANDBRAKE_QUALITY, 20),
    minMinutes: num(env.RIP_MIN_MINUTES, 40),
    minFreeGb: num(env.RIP_MIN_FREE_GB, 15),
    closeDvdPlayer: bool(env.RIP_CLOSE_DVD_PLAYER, process.platform === 'darwin'),
    ntfyServer: env.NTFY_SERVER?.trim() || 'https://ntfy.sh',
    ntfyTopic: env.NTFY_TOPIC?.trim() || null,
    publicUrl,
    jellyfinApiKey: env.JELLYFIN_API_KEY?.trim() || null,
    pollMs: num(env.RIP_POLL_MS, 5000),
    importTimeoutMs: num(env.RIP_IMPORT_TIMEOUT_MS, 15 * 60_000),
    importPollMs: num(env.RIP_IMPORT_POLL_MS, 15_000),
  };
}

export const APP_VERSION = '1.0.0';
