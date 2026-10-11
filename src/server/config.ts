import path from 'node:path';
import type { MediaSourceKind } from '../shared/types.js';

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
  };
}

export const APP_VERSION = '1.0.0';
