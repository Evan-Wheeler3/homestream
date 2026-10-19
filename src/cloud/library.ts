// The Mac version's LibraryService (src/server/library.ts) on D1. The browsing
// logic itself (filters, sorting, home rows, Wrapped, smart collections) is the
// shared code in src/shared, unchanged.
import {
  buildFacets,
  decadeOf,
  lastWatched,
  queryMovies,
  recommendLike,
  seededRandom,
  shuffle,
} from '../shared/catalog.js';
import { BUILTIN_SECTIONS } from '../shared/preferences.js';
import { evaluateSmartCollection } from '../shared/rules.js';
import { buildWrapped } from '../shared/wrapped.js';
import type {
  Collection,
  CollectionDetail,
  Franchise,
  FranchiseDetail,
  FranchiseSummary,
  HomePayload,
  HomeRow,
  Movie,
  MovieDetail,
  MovieQuery,
  PersonalData,
  Preferences,
} from '../shared/types.js';
import { notFound } from '../server/errors.js';
import { loadSnapshot, movieRow, type Snapshot, type StoredDetail } from './catalog.js';
import type { Sql } from './db.js';
import type { CloudStore, CollectionRow } from './store.js';

const ROW_LIMIT = 20;

const dayKey = () => new Date().toISOString().slice(0, 10);

/** One person's view of the library, for the length of one request. */
export class CloudLibrary {
  private snap: Promise<Snapshot> | null = null;
  private personal: Promise<Map<string, PersonalData>> | null = null;
  private franchiseList: Promise<Franchise[]> | null = null;

  constructor(
    private readonly sql: Sql,
    readonly store: CloudStore,
    readonly userId: string,
  ) {}

  snapshot(): Promise<Snapshot> {
    this.snap ??= loadSnapshot(this.sql, this.userId);
    return this.snap;
  }

  private allPersonal() {
    this.personal ??= this.store.allPersonal(this.userId);
    return this.personal;
  }

  // ---------------------------------------------------------------------------
  // Film series

  private rawFranchises(): Promise<Franchise[]> {
    this.franchiseList ??= this.sql
      .all<{
        id: string;
        name: string;
        poster: string | null;
        backdrop: string | null;
        movie_ids: string;
      }>('SELECT id, name, poster, backdrop, movie_ids FROM franchises')
      .then((rows) =>
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          poster: r.poster,
          backdrop: r.backdrop,
          movieIds: JSON.parse(r.movie_ids) as string[],
        })),
      );
    return this.franchiseList;
  }

  /** Each series' films that are in the library (at least two), oldest first. */
  private async franchiseMovies(snap: Snapshot) {
    return (await this.rawFranchises())
      .map((f) => ({
        franchise: f,
        movies: f.movieIds
          .map((id) => snap.byId.get(id))
          .filter((m): m is Movie => Boolean(m))
          .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title)),
      }))
      .filter((f) => f.movies.length >= 2);
  }

  async franchises(): Promise<FranchiseSummary[]> {
    const snap = await this.snapshot();
    return (await this.franchiseMovies(snap))
      .map(({ franchise, movies }) => ({
        id: franchise.id,
        name: franchise.name,
        count: movies.length,
        image:
          franchise.backdrop ??
          movies.find((m) => m.images.backdrop)?.images.backdrop ??
          franchise.poster ??
          movies[0]?.images.poster ??
          null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async franchise(id: string): Promise<FranchiseDetail> {
    const snap = await this.snapshot();
    const found = (await this.franchiseMovies(snap)).find((f) => f.franchise.id === id);
    if (!found) throw notFound('That film series isn’t in the library.');
    const { franchise, movies } = found;
    return {
      id: franchise.id,
      name: franchise.name,
      poster: franchise.poster,
      backdrop:
        franchise.backdrop ?? movies.find((m) => m.images.backdrop)?.images.backdrop ?? null,
      movies,
    };
  }

  // ---------------------------------------------------------------------------
  // Browsing

  /** Narrow to the watchlist when the query asks for it (kept in watchlist order). */
  private async pool(movies: Movie[], query: MovieQuery): Promise<Movie[]> {
    if (query.ids?.length) {
      const wanted = new Set(query.ids);
      movies = movies.filter((m) => wanted.has(m.id));
    }
    if (!query.watchlist) return movies;
    const byId = new Map(movies.map((m) => [m.id, m]));
    return (await this.store.watchlist(this.userId))
      .map((id) => byId.get(id))
      .filter((m): m is Movie => Boolean(m));
  }

  async query(query: MovieQuery) {
    const snap = await this.snapshot();
    return queryMovies(await this.pool(snap.movies, query), query);
  }

  async watchlist(): Promise<Movie[]> {
    const snap = await this.snapshot();
    return this.pool(snap.movies, { watchlist: true });
  }

  async wrapped(year: number | null) {
    const snap = await this.snapshot();
    return buildWrapped(snap.movies, await this.store.watchEvents(this.userId), year);
  }

  async facets() {
    return buildFacets((await this.snapshot()).movies);
  }

  private async matching(query: MovieQuery): Promise<Movie[]> {
    const snap = await this.snapshot();
    return queryMovies(await this.pool(snap.movies, query), {
      ...query,
      offset: 0,
      limit: 100_000,
    }).items.filter((m) => m.available);
  }

  async random(query: MovieQuery): Promise<Movie | null> {
    const pool = await this.matching(query);
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  }

  /** Up to `count` different playable movies matching the query, in random order. */
  async sample(query: MovieQuery, count: number): Promise<Movie[]> {
    return shuffle(await this.matching(query)).slice(0, count);
  }

  async detail(id: string): Promise<MovieDetail> {
    const [row, snap] = await Promise.all([movieRow(this.sql, id), this.snapshot()]);
    const movie = snap.byId.get(id);
    if (!row || !movie)
      throw notFound('This movie is not in the library (it may have been removed).');
    const stored = JSON.parse(row.detail || '{}') as Partial<StoredDetail>;
    const [personal, collections, watchlist, franchises] = await Promise.all([
      this.store.getPersonal(this.userId, id),
      this.store.collectionsContaining(this.userId, id),
      this.store.watchlist(this.userId),
      this.franchiseMovies(snap),
    ]);
    return {
      ...movie,
      cast: stored.cast ?? [],
      trailers: stored.trailers ?? [],
      writers: stored.writers ?? [],
      producers: stored.producers ?? [],
      mediaInfo: stored.mediaInfo ?? null,
      externalLinks: stored.externalLinks ?? [],
      personal,
      collections,
      onWatchlist: watchlist.includes(id),
      franchises: franchises
        .filter((f) => f.movies.some((m) => m.id === id))
        .map((f) => ({ id: f.franchise.id, name: f.franchise.name })),
    };
  }

  async similar(id: string): Promise<Movie[]> {
    const snap = await this.snapshot();
    const seed = snap.byId.get(id);
    if (!seed) return [];
    return recommendLike(
      snap.movies.filter((m) => m.available),
      seed,
      16,
    );
  }

  // ---------------------------------------------------------------------------
  // Collections

  private async collectionMovies(
    row: CollectionRow,
    snap: Snapshot,
    members?: string[],
  ): Promise<{ movies: Movie[]; missing: string[] }> {
    if (row.kind === 'smart') {
      const rules = this.store.parseRules(row);
      if (!rules) return { movies: [], missing: [] };
      const personal = await this.allPersonal();
      return {
        movies: evaluateSmartCollection(rules, snap.movies, (itemId) => personal.get(itemId)),
        missing: [],
      };
    }
    const ids = members ?? (await this.store.memberIds(row.id));
    const movies: Movie[] = [];
    const missing: string[] = [];
    for (const itemId of ids) {
      const movie = snap.byId.get(itemId);
      if (movie) movies.push(movie);
      else missing.push(itemId);
    }
    return { movies, missing };
  }

  private toCollection(row: CollectionRow, movies: Movie[], snap: Snapshot): Collection {
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
      editable: row.owner_user_id === this.userId,
    };
  }

  private async collectionRows() {
    const rows = await this.store.listCollections(this.userId);
    const members = await this.store.membersOf(
      rows.filter((r) => r.kind === 'manual').map((r) => r.id),
    );
    return { rows, members };
  }

  async listCollections(): Promise<Collection[]> {
    const snap = await this.snapshot();
    const { rows, members } = await this.collectionRows();
    return Promise.all(
      rows.map(async (row) =>
        this.toCollection(
          row,
          (await this.collectionMovies(row, snap, members.get(row.id))).movies,
          snap,
        ),
      ),
    );
  }

  async collectionDetail(id: string): Promise<CollectionDetail> {
    const row = await this.store.getCollection(this.userId, id);
    const snap = await this.snapshot();
    const { movies, missing } = await this.collectionMovies(row, snap);
    const unavailable = await Promise.all(
      missing.map(async (itemId) => {
        const known = await this.store.snapshot(itemId);
        return {
          itemId,
          lastKnownTitle: known?.title ?? null,
          lastKnownYear: known?.year ?? null,
        };
      }),
    );
    return { ...this.toCollection(row, movies, snap), movies, unavailable };
  }

  async previewRules(rules: Parameters<typeof evaluateSmartCollection>[0]) {
    const snap = await this.snapshot();
    const personal = await this.allPersonal();
    const movies = evaluateSmartCollection(rules, snap.movies, (id) => personal.get(id));
    return { count: movies.length, sample: movies.slice(0, 8) };
  }

  // ---------------------------------------------------------------------------
  // Home

  private pickHero(movies: Movie[], prefs: Preferences): Movie[] {
    const withArt = movies.filter((m) => m.available && (m.images.backdrop || m.images.poster));
    const rand = seededRandom(`${this.userId}-${dayKey()}`);
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
    return [
      ...candidates.filter((m) => m.images.backdrop),
      ...candidates.filter((m) => !m.images.backdrop),
    ].slice(0, 5);
  }

  async home(): Promise<HomePayload> {
    const [prefs, snap, watchlist] = await Promise.all([
      this.store.getPreferences(this.userId),
      this.snapshot(),
      this.store.watchlist(this.userId),
    ]);
    const movies = snap.movies.filter((m) => m.available);
    const rand = seededRandom(`${this.userId}-${dayKey()}-rows`);
    const sections: HomePayload['sections'] = [];
    const { rows: collectionList, members } = await this.collectionRows();
    const collectionRows = new Map(collectionList.map((row) => [row.id, row]));
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
            movies: watchlist
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
          const list = (await this.listCollections()).filter((c) => c.itemCount > 0);
          if (list.length)
            sections.push({ type: 'collections', id: 'collections', collections: list });
          break;
        }
        case 'franchises': {
          const list = await this.franchises();
          if (list.length)
            sections.push({ type: 'franchises', id: 'franchises', franchises: list });
          break;
        }
        case 'yearInReview': {
          const year = new Date().getFullYear();
          const w = buildWrapped(snap.movies, await this.store.watchEvents(this.userId), year);
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
              movies: (await this.collectionMovies(row, snap, members.get(row.id))).movies.slice(
                0,
                ROW_LIMIT,
              ),
            });
          }
        }
      }
    }

    const heroVisible = prefs.homeSections.find((s) => s.id === 'hero')?.visible !== false;
    return {
      hero: heroVisible ? this.pickHero(movies, prefs) : [],
      sections,
      libraryCount: movies.length,
    };
  }
}

function inProgress(movies: Movie[]): Movie[] {
  return movies
    .filter((m) => m.user.positionSeconds > 0 && !m.user.played)
    .sort((a, b) => (b.user.lastPlayed ?? '').localeCompare(a.user.lastPlayed ?? ''));
}
