import type { Movie, MovieUserState } from '../shared/types.js';
import { ApiError } from './errors.js';
import type { MediaProvider, UserContext } from './providers/types.js';

interface Entry {
  movies: Movie[];
  byId: Map<string, Movie>;
  fetchedAt: number;
  lastError: string | null;
  inflight: Promise<Entry> | null;
}

export interface CatalogSnapshot {
  movies: Movie[];
  byId: Map<string, Movie>;
  fetchedAt: number;
  /** True when served from cache because the media server could not be reached. */
  stale: boolean;
  lastError: string | null;
}

/**
 * Per-user in-memory index of the movie library. Jellyfin is queried at most once
 * per TTL (or on explicit refresh); filtering, sorting, search and smart
 * collections run against this index so browsing stays fast on large libraries.
 * If Jellyfin becomes unreachable the last good index is served and marked stale.
 */
export class CatalogCache {
  private readonly entries = new Map<string, Entry>();
  onRefresh: ((movies: Movie[]) => void) | null = null;

  constructor(
    private readonly provider: MediaProvider,
    private readonly ttlMs: number,
  ) {}

  private async load(ctx: UserContext, entry: Entry | undefined): Promise<Entry> {
    if (entry?.inflight) return entry.inflight;
    const target: Entry = entry ?? {
      movies: [],
      byId: new Map(),
      fetchedAt: 0,
      lastError: null,
      inflight: null,
    };
    this.entries.set(ctx.userId, target);
    target.inflight = (async () => {
      try {
        const movies = await this.provider.listMovies(ctx);
        target.movies = movies;
        target.byId = new Map(movies.map((m) => [m.id, m]));
        target.fetchedAt = Date.now();
        target.lastError = null;
        this.onRefresh?.(movies);
        return target;
      } catch (error) {
        target.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        target.inflight = null;
      }
    })();
    return target.inflight;
  }

  async get(ctx: UserContext, options: { force?: boolean } = {}): Promise<CatalogSnapshot> {
    const entry = this.entries.get(ctx.userId);
    const fresh = entry && entry.fetchedAt > 0 && Date.now() - entry.fetchedAt < this.ttlMs;
    // A failed refresh since the last success means the server is down right now.
    if (entry && fresh && !options.force) return { ...entry, stale: Boolean(entry.lastError) };
    try {
      const loaded = await this.load(ctx, entry);
      return { ...loaded, stale: false };
    } catch (error) {
      // Never hide an expired session behind stale data.
      if (error instanceof ApiError && error.code === 'SESSION_EXPIRED') throw error;
      if (entry && entry.fetchedAt > 0) return { ...entry, stale: true };
      throw error;
    }
  }

  /** Peek without triggering a fetch (used by status/diagnostics). */
  peek(userId: string): CatalogSnapshot | null {
    const entry = this.entries.get(userId);
    if (!entry || entry.fetchedAt === 0) return null;
    return {
      ...entry,
      stale: Boolean(entry.lastError),
    };
  }

  /** Patch per-user state after a mutation so the index never shows stale state. */
  updateUserState(userId: string, itemId: string, state: MovieUserState) {
    const entry = this.entries.get(userId);
    const movie = entry?.byId.get(itemId);
    if (movie) movie.user = state;
  }

  invalidate(userId?: string) {
    if (userId) this.entries.delete(userId);
    else this.entries.clear();
  }
}
