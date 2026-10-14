import {
  buildFacets,
  decadeOf,
  lastWatched,
  queryMovies,
  recommendLike,
  seededRandom,
  shuffle,
} from '../shared/catalog.js';
import { buildWrapped } from '../shared/wrapped.js';
import { BUILTIN_SECTIONS } from '../shared/preferences.js';
import { evaluateSmartCollection } from '../shared/rules.js';
import type {
  Collection,
  CollectionDetail,
  HomePayload,
  HomeRow,
  Movie,
  MovieDetail,
  MovieQuery,
  Preferences,
} from '../shared/types.js';
import type { CatalogCache, CatalogSnapshot } from './catalog.js';
import { ApiError, notFound } from './errors.js';
import type { MediaProvider, ProviderDetail, UserContext } from './providers/types.js';
import type { CollectionRow, Store } from './store.js';

const ROW_LIMIT = 20;

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

export class LibraryService {
  constructor(
    readonly provider: MediaProvider,
    readonly catalog: CatalogCache,
    readonly store: Store,
  ) {}

  snapshot(ctx: UserContext, force = false): Promise<CatalogSnapshot> {
    return this.catalog.get(ctx, { force });
  }

  /** Narrow to the user's watchlist when the query asks for it (kept in watchlist order). */
  private pool(ctx: UserContext, movies: Movie[], query: MovieQuery): Movie[] {
    if (query.ids?.length) {
      const wanted = new Set(query.ids);
      movies = movies.filter((m) => wanted.has(m.id));
    }
    if (!query.watchlist) return movies;
    const byId = new Map(movies.map((m) => [m.id, m]));
    return this.store
      .watchlist(ctx.userId)
      .map((id) => byId.get(id))
      .filter((m): m is Movie => Boolean(m));
  }

  async query(ctx: UserContext, query: MovieQuery) {
    const snap = await this.snapshot(ctx);
    return { page: queryMovies(this.pool(ctx, snap.movies, query), query), stale: snap.stale };
  }

  async watchlist(ctx: UserContext): Promise<Movie[]> {
    const snap = await this.snapshot(ctx);
    return this.pool(ctx, snap.movies, { watchlist: true });
  }

  async wrapped(ctx: UserContext, year: number | null) {
    const snap = await this.snapshot(ctx);
    return buildWrapped(snap.movies, this.store.watchEvents(ctx.userId), year);
  }

  setWatchlist(ctx: UserContext, id: string, on: boolean) {
    this.store.setWatchlist(ctx.userId, id, on);
  }

  async facets(ctx: UserContext) {
    const snap = await this.snapshot(ctx);
    return buildFacets(snap.movies);
  }

  async random(ctx: UserContext, query: MovieQuery): Promise<Movie | null> {
    const snap = await this.snapshot(ctx);
    const pool = queryMovies(this.pool(ctx, snap.movies, query), {
      ...query,
      offset: 0,
      limit: 100_000,
    }).items.filter((m) => m.available);
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  }

  /** Up to `count` different playable movies matching the query, in random order. */
  async sample(ctx: UserContext, query: MovieQuery, count: number): Promise<Movie[]> {
    const snap = await this.snapshot(ctx);
    const pool = queryMovies(this.pool(ctx, snap.movies, query), {
      ...query,
      offset: 0,
      limit: 100_000,
    }).items.filter((m) => m.available);
    return shuffle(pool).slice(0, count);
  }

  /**
   * Full detail from the media server. If it is unreachable, fall back to the
   * cached index entry (without cast/media info) and flag the result as stale.
   */
  async detail(ctx: UserContext, id: string): Promise<{ detail: MovieDetail; stale: boolean }> {
    let detail: ProviderDetail | null;
    let stale = false;
    try {
      detail = await this.provider.getMovie(ctx, id);
    } catch (error) {
      const cached = this.catalog.peek(ctx.userId)?.byId.get(id);
      if (!(error instanceof ApiError && error.code === 'MEDIA_SERVER_UNREACHABLE') || !cached)
        throw error;
      detail = {
        ...cached,
        cast: [],
        trailers: [],
        writers: [],
        producers: [],
        mediaInfo: null,
        externalLinks: [],
      };
      stale = true;
    }
    if (!detail) throw notFound('This movie is not in the library (it may have been removed).');
    if (!stale) this.catalog.updateUserState(ctx.userId, id, detail.user);
    return {
      detail: {
        ...detail,
        personal: this.store.getPersonal(ctx.userId, id),
        collections: this.store.collectionsContaining(ctx.userId, id),
        onWatchlist: this.store.watchlist(ctx.userId).includes(id),
      },
      stale,
    };
  }

  async similar(ctx: UserContext, id: string): Promise<Movie[]> {
    const [ids, snap] = await Promise.all([this.provider.similar(ctx, id), this.snapshot(ctx)]);
    return ids.map((sid) => snap.byId.get(sid)).filter((m): m is Movie => Boolean(m));
  }

  // ---------------------------------------------------------------------------
  // Collections

  private collectionMovies(ctx: UserContext, row: CollectionRow, snap: CatalogSnapshot) {
    if (row.kind === 'smart') {
      const rules = this.store.parseRules(row);
      if (!rules) return { movies: [], missing: [] as string[] };
      const personal = this.store.allPersonal(ctx.userId);
      return {
        movies: evaluateSmartCollection(rules, snap.movies, (itemId) => personal.get(itemId)),
        missing: [] as string[],
      };
    }
    const ids = this.store.memberIds(row.id);
    const movies: Movie[] = [];
    const missing: string[] = [];
    for (const itemId of ids) {
      const movie = snap.byId.get(itemId);
      if (movie) movies.push(movie);
      else missing.push(itemId);
    }
    return { movies, missing };
  }

  private toCollection(
    ctx: UserContext,
    row: CollectionRow,
    movies: Movie[],
    snap: CatalogSnapshot,
  ): Collection {
    let artworkUrl: string | null = null;
    if (row.artwork_kind === 'upload' && row.artwork_ref) {
      artworkUrl = `/api/collections/${row.id}/artwork?v=${encodeURIComponent(row.artwork_ref)}`;
    } else if (row.artwork_kind === 'movie' && row.artwork_ref) {
      const movie = snap.byId.get(row.artwork_ref);
      artworkUrl = movie?.images.backdrop ?? movie?.images.poster ?? null;
    }
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      description: row.description,
      kind: row.kind,
      rules: this.store.parseRules(row),
      visibility: row.visibility,
      artwork: { kind: row.artwork_kind, ref: row.artwork_ref, url: artworkUrl },
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      itemCount: movies.length,
      previewPosters: movies
        .map((m) => m.images.poster)
        .filter((p): p is string => Boolean(p))
        .slice(0, 4),
      editable: row.owner_user_id === ctx.userId,
    };
  }

  async listCollections(ctx: UserContext): Promise<Collection[]> {
    const snap = await this.snapshot(ctx);
    return this.store
      .listCollections(ctx.userId)
      .map((row) =>
        this.toCollection(ctx, row, this.collectionMovies(ctx, row, snap).movies, snap),
      );
  }

  async collectionDetail(ctx: UserContext, id: string): Promise<CollectionDetail> {
    const row = this.store.getCollection(ctx.userId, id);
    const snap = await this.snapshot(ctx);
    const { movies, missing } = this.collectionMovies(ctx, row, snap);
    // Only report items as unavailable when we have a fresh catalog to compare against.
    const unavailable = snap.stale
      ? []
      : missing.map((itemId) => {
          const known = this.store.snapshot(itemId);
          return {
            itemId,
            lastKnownTitle: known?.title ?? null,
            lastKnownYear: known?.year ?? null,
          };
        });
    return { ...this.toCollection(ctx, row, movies, snap), movies, unavailable };
  }

  // ---------------------------------------------------------------------------
  // Home

  private pickHero(movies: Movie[], prefs: Preferences, ctx: UserContext): Movie[] {
    const withArt = movies.filter((m) => m.available && (m.images.backdrop || m.images.poster));
    const rand = seededRandom(`${ctx.userId}-${dayKey()}`);
    const byAdded = [...withArt].sort((a, b) =>
      (b.dateAdded ?? '').localeCompare(a.dateAdded ?? ''),
    );
    let candidates: Movie[];
    switch (prefs.heroSource) {
      case 'random':
        candidates = shuffle(withArt, rand);
        break;
      case 'favorites':
        candidates = shuffle(
          withArt.filter((m) => m.user.favorite),
          rand,
        );
        break;
      case 'continueWatching':
        candidates = inProgress(withArt);
        break;
      default:
        candidates = byAdded;
    }
    if (candidates.length === 0) candidates = byAdded;
    // Prefer titles with a real backdrop for the cinematic hero.
    const preferred = [
      ...candidates.filter((m) => m.images.backdrop),
      ...candidates.filter((m) => !m.images.backdrop),
    ];
    return preferred.slice(0, 5);
  }

  async home(ctx: UserContext): Promise<HomePayload & { stale: boolean }> {
    const prefs = this.store.getPreferences(ctx.userId);
    const snap = await this.snapshot(ctx);
    const movies = snap.movies.filter((m) => m.available);
    const rand = seededRandom(`${ctx.userId}-${dayKey()}-rows`);
    const sections: HomePayload['sections'] = [];
    const collectionRows = new Map(
      this.store.listCollections(ctx.userId).map((row) => [row.id, row]),
    );
    const titles = new Map(BUILTIN_SECTIONS.map((s) => [s.id, s.label]));

    const pushRow = (row: HomeRow) => {
      if (row.movies.length > 0) sections.push({ type: 'row', row });
    };

    for (const section of prefs.homeSections) {
      if (!section.visible || section.id === 'hero') continue;
      const title = titles.get(section.id) ?? '';
      switch (section.id) {
        case 'continueWatching':
          pushRow({
            id: section.id,
            title,
            kind: 'continue',
            movies: inProgress(movies).slice(0, ROW_LIMIT),
          });
          break;
        case 'watchlist': {
          const byId = new Map(movies.map((m) => [m.id, m]));
          pushRow({
            id: section.id,
            title,
            kind: 'movies',
            href: '/browse?watchlist=1&sort=dateAdded&dir=desc',
            movies: this.store
              .watchlist(ctx.userId)
              .map((id) => byId.get(id))
              .filter((m): m is Movie => Boolean(m))
              .slice(0, ROW_LIMIT),
          });
          break;
        }
        case 'becauseYouWatched': {
          const seed = lastWatched(movies);
          if (!seed) break;
          pushRow({
            id: section.id,
            title: `Because you watched ${seed.title}`,
            kind: 'movies',
            href: `/movie/${seed.id}`,
            movies: recommendLike(movies, seed, ROW_LIMIT),
          });
          break;
        }
        case 'recentlyAdded':
          pushRow({
            id: section.id,
            title,
            kind: 'movies',
            href: '/browse?sort=dateAdded&dir=desc',
            movies: [...movies]
              .sort((a, b) => (b.dateAdded ?? '').localeCompare(a.dateAdded ?? ''))
              .slice(0, ROW_LIMIT),
          });
          break;
        case 'favorites':
          pushRow({
            id: section.id,
            title,
            kind: 'movies',
            href: '/browse?favorite=1',
            movies: movies.filter((m) => m.user.favorite).slice(0, ROW_LIMIT),
          });
          break;
        case 'unwatched': {
          const unwatched = movies.filter((m) => !m.user.played && m.user.positionSeconds === 0);
          // In a small, entirely-unwatched library this row would just repeat everything.
          if (unwatched.length === movies.length && movies.length <= ROW_LIMIT) break;
          pushRow({
            id: section.id,
            title,
            kind: 'movies',
            href: '/browse?watched=unwatched',
            movies: shuffle(unwatched, rand).slice(0, ROW_LIMIT),
          });
          break;
        }
        case 'collections': {
          const list = (await this.listCollections(ctx)).filter((c) => c.itemCount > 0);
          if (list.length)
            sections.push({ type: 'collections', id: 'collections', collections: list });
          break;
        }
        case 'yearInReview': {
          const year = new Date().getFullYear();
          const w = buildWrapped(snap.movies, this.store.watchEvents(ctx.userId), year);
          if (w.moviesWatched > 0) {
            sections.push({
              type: 'yearInReview',
              id: 'yearInReview',
              year,
              movies: w.moviesWatched,
              hours: w.hoursWatched,
            });
          }
          break;
        }
        case 'randomPick':
          if (movies.length >= 2) {
            sections.push({
              type: 'randomPick',
              id: 'randomPick',
              movie: shuffle(movies, rand)[0] ?? null,
            });
          }
          break;
        case 'genres': {
          const facets = buildFacets(movies).genres;
          if (facets.length >= 2) {
            sections.push({
              type: 'genres',
              id: 'genres',
              genres: facets.slice(0, 18).map((g) => ({
                name: g.value,
                count: g.count,
                poster:
                  movies.find((m) => m.genres.includes(g.value) && m.images.backdrop)?.images
                    .backdrop ??
                  movies.find((m) => m.genres.includes(g.value))?.images.poster ??
                  null,
              })),
            });
          }
          break;
        }
        case 'decades': {
          const decades = buildFacets(movies).decades;
          if (decades.length >= 2) {
            sections.push({
              type: 'decades',
              id: 'decades',
              decades: decades.map((d) => ({
                decade: Number(d.value),
                count: d.count,
                poster:
                  movies.find(
                    (m) =>
                      m.year != null && decadeOf(m.year) === Number(d.value) && m.images.poster,
                  )?.images.poster ?? null,
              })),
            });
          }
          break;
        }
        default: {
          if (section.id.startsWith('collection:')) {
            const row = collectionRows.get(section.id.slice('collection:'.length));
            if (!row) break;
            pushRow({
              id: section.id,
              title: row.name,
              kind: 'movies',
              href: `/collections/${row.id}`,
              movies: this.collectionMovies(ctx, row, snap).movies.slice(0, ROW_LIMIT),
            });
          }
        }
      }
    }

    const heroVisible = prefs.homeSections.find((s) => s.id === 'hero')?.visible !== false;
    return {
      hero: heroVisible ? this.pickHero(movies, prefs, ctx) : [],
      sections,
      libraryCount: movies.length,
      stale: snap.stale,
    };
  }
}

function inProgress(movies: Movie[]): Movie[] {
  return movies
    .filter((m) => m.user.positionSeconds > 0 && !m.user.played)
    .sort((a, b) => (b.user.lastPlayed ?? '').localeCompare(a.user.lastPlayed ?? ''));
}
