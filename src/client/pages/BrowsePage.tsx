import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type {
  Density,
  Facets,
  Movie,
  MovieQuery,
  Preferences,
  SortField,
} from '../../shared/types';
import { Icon } from '../components/Icon';
import { PosterCard, PosterGrid, PosterGridSkeleton } from '../components/movies';
import { useToast } from '../components/Toasts';
import {
  Button,
  Chip,
  Dialog,
  IconButton,
  Segmented,
  Spinner,
  StatusView,
  Switch,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { useDebounced, useInfiniteSentinel } from '../lib/hooks';
import { movieQueryString, useFacets, useMovies, useUpdatePreferences } from '../lib/queries';

export const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Release year' },
  { value: 'dateAdded', label: 'Date added' },
  { value: 'runtime', label: 'Runtime' },
  { value: 'rating', label: 'Community rating' },
];

const RUNTIME_OPTIONS = [90, 100, 120, 150];

const listParam = (params: URLSearchParams, key: string) =>
  params.get(key)?.split('|').filter(Boolean) ?? undefined;
const numParam = (params: URLSearchParams, key: string) => {
  const v = params.get(key);
  return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
};

/** URL search params are the single source of truth for browse state. */
export function queryFromParams(params: URLSearchParams, prefs: Preferences): MovieQuery {
  const sort = (params.get('sort') as SortField | null) ?? undefined;
  const watched = params.get('watched');
  return {
    q: params.get('q') ?? undefined,
    genres: listParam(params, 'genre'),
    directors: listParam(params, 'director'),
    countries: listParam(params, 'country'),
    tags: listParam(params, 'tag'),
    studios: listParam(params, 'studio'),
    ratings: listParam(params, 'rating'),
    yearMin: numParam(params, 'yearMin'),
    yearMax: numParam(params, 'yearMax'),
    runtimeMax: numParam(params, 'runtimeMax'),
    watched:
      watched === 'watched' || watched === 'unwatched' || watched === 'inProgress'
        ? watched
        : undefined,
    favorite: params.get('favorite') === '1' || undefined,
    sort: sort ?? (params.get('q') ? undefined : prefs.defaultSort),
    dir:
      (params.get('dir') as 'asc' | 'desc' | null) ??
      (sort ? undefined : params.get('q') ? undefined : prefs.defaultSortDir),
  };
}

function activeFilterCount(q: MovieQuery) {
  return (
    (q.genres?.length ?? 0) +
    (q.directors?.length ?? 0) +
    (q.countries?.length ?? 0) +
    (q.tags?.length ?? 0) +
    (q.studios?.length ?? 0) +
    (q.ratings?.length ?? 0) +
    (q.yearMin != null || q.yearMax != null ? 1 : 0) +
    (q.runtimeMax != null ? 1 : 0) +
    (q.watched ? 1 : 0) +
    (q.favorite ? 1 : 0)
  );
}

function FilterList({
  title,
  values,
  selected,
  onToggle,
  searchable,
}: {
  title: string;
  values: Facets['genres'];
  selected: string[] | undefined;
  onToggle: (value: string) => void;
  searchable?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(false);
  if (values.length === 0) return null;
  const needle = filter.trim().toLowerCase();
  const matching = needle ? values.filter((v) => v.value.toLowerCase().includes(needle)) : values;
  const limit = expanded || needle ? 200 : 16;
  // Keep selected values visible even when the list is truncated.
  const shown = [
    ...new Set([...(selected ?? []), ...matching.slice(0, limit).map((v) => v.value)]),
  ];
  const counts = new Map(values.map((v) => [v.value, v.count]));
  return (
    <fieldset className="filter-group">
      <legend className="filter-group__title">{title}</legend>
      {searchable && values.length > 12 && (
        <input
          className="input input--sm"
          type="search"
          placeholder={`Filter ${title.toLowerCase()}…`}
          aria-label={`Filter ${title.toLowerCase()}`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      <div className="chip-list">
        {shown.map((value) => (
          <Chip
            key={value}
            selected={selected?.includes(value)}
            count={counts.get(value)}
            onClick={() => onToggle(value)}
          >
            {value}
          </Chip>
        ))}
      </div>
      {!needle && matching.length > limit && (
        <button type="button" className="link-btn" onClick={() => setExpanded(true)}>
          Show all {matching.length}
        </button>
      )}
    </fieldset>
  );
}

export function BrowsePage({ prefs }: { prefs: Preferences }) {
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => queryFromParams(params, prefs), [params, prefs]);
  const [text, setText] = useState(query.q ?? '');
  const debouncedText = useDebounced(text, 250);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [randomBusy, setRandomBusy] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const facets = useFacets();
  const movies = useMovies(query);
  const updatePrefs = useUpdatePreferences();

  // Debounced search text → URL.
  useEffect(() => {
    const current = params.get('q') ?? '';
    if (debouncedText.trim() === current) return;
    const next = new URLSearchParams(params);
    if (debouncedText.trim()) next.set('q', debouncedText.trim());
    else next.delete('q');
    setParams(next, { replace: true });
  }, [debouncedText, params, setParams]);

  const update = (mutate: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    mutate(next);
    setParams(next, { replace: true });
  };

  const toggleList = (key: string, value: string) =>
    update((p) => {
      const current = p.get(key)?.split('|').filter(Boolean) ?? [];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      if (next.length) p.set(key, next.join('|'));
      else p.delete(key);
    });

  const setValue = (key: string, value: string | null) =>
    update((p) => {
      if (value == null || value === '') p.delete(key);
      else p.set(key, value);
    });

  const clearFilters = () =>
    update((p) => {
      for (const key of [
        'genre',
        'director',
        'country',
        'tag',
        'studio',
        'rating',
        'yearMin',
        'yearMax',
        'runtimeMax',
        'watched',
        'favorite',
      ]) {
        p.delete(key);
      }
    });

  const pages = movies.data?.pages ?? [];
  const items: Movie[] = pages.flatMap((p) => p.items);
  const total = pages[0]?.total ?? 0;
  const sentinel = useInfiniteSentinel(() => {
    if (movies.hasNextPage && !movies.isFetchingNextPage) void movies.fetchNextPage();
  }, Boolean(movies.hasNextPage));

  const filterCount = activeFilterCount(query);
  const f = facets.data;
  const decadeSelected = (d: number) => query.yearMin === d && query.yearMax === d + 9;

  const surprise = async () => {
    setRandomBusy(true);
    try {
      const { movie } = await api<{ movie: Movie | null }>(
        `/movies/random?${movieQueryString({ ...query, sort: undefined, dir: undefined })}`,
      );
      if (movie) navigate(`/movie/${movie.id}`);
      else toast.show('No movies match these filters.', 'error');
    } catch (error) {
      toast.show(errorMessage(error), 'error');
    } finally {
      setRandomBusy(false);
    }
  };

  const activeChips: { key: string; label: string; remove: () => void }[] = [];
  const listChips = (key: string, values: string[] | undefined) =>
    values?.forEach((v) =>
      activeChips.push({ key: `${key}-${v}`, label: v, remove: () => toggleList(key, v) }),
    );
  listChips('genre', query.genres);
  listChips('director', query.directors);
  listChips('country', query.countries);
  listChips('tag', query.tags);
  listChips('studio', query.studios);
  listChips('rating', query.ratings);
  if (query.yearMin != null || query.yearMax != null) {
    activeChips.push({
      key: 'years',
      label: `${query.yearMin ?? '…'}–${query.yearMax ?? '…'}`,
      remove: () => update((p) => (p.delete('yearMin'), p.delete('yearMax'))),
    });
  }
  if (query.runtimeMax != null)
    activeChips.push({
      key: 'rt',
      label: `Under ${query.runtimeMax + 1} min`,
      remove: () => setValue('runtimeMax', null),
    });
  if (query.watched)
    activeChips.push({
      key: 'w',
      label: { watched: 'Watched', unwatched: 'Unwatched', inProgress: 'In progress' }[
        query.watched
      ],
      remove: () => setValue('watched', null),
    });
  if (query.favorite)
    activeChips.push({ key: 'fav', label: 'Favorites', remove: () => setValue('favorite', null) });

  const sortValue = query.sort ?? 'relevance';
  const dir = query.dir ?? (query.sort === 'title' ? 'asc' : 'desc');

  return (
    <div className="page browse route-enter">
      <header className="page-header">
        <div>
          <h1 className="page-title">Browse</h1>
          <p aria-live="polite">{movies.isPending ? 'Loading…' : plural(total, 'movie')}</p>
        </div>
        <Button
          variant="secondary"
          icon="shuffle"
          busy={randomBusy}
          onClick={surprise}
          disabled={total === 0}
        >
          Random pick
        </Button>
      </header>

      <div className="toolbar" role="toolbar" aria-label="Browse options">
        <label className="search-field toolbar__search">
          <Icon name="search" size={18} />
          <span className="visually-hidden">Search titles</span>
          <input
            type="search"
            placeholder="Search titles"
            value={text}
            onChange={(e) => setText(e.target.value)}
            enterKeyHint="search"
          />
        </label>
        <div className="toolbar__group">
          <label className="select">
            <span className="visually-hidden">Sort by</span>
            <select
              value={sortValue}
              onChange={(e) =>
                update((p) => {
                  if (e.target.value === 'relevance') p.delete('sort');
                  else p.set('sort', e.target.value);
                  p.delete('dir');
                })
              }
            >
              {query.q && <option value="relevance">Best match</option>}
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={16} />
          </label>
          {query.sort && (
            <IconButton
              icon={dir === 'asc' ? 'sortAsc' : 'sortDesc'}
              label={
                dir === 'asc'
                  ? 'Ascending — switch to descending'
                  : 'Descending — switch to ascending'
              }
              variant="outline"
              onClick={() => setValue('dir', dir === 'asc' ? 'desc' : 'asc')}
            />
          )}
          <Button
            variant="secondary"
            icon="sliders"
            onClick={() => setFiltersOpen(true)}
            aria-haspopup="dialog"
          >
            Filters{filterCount ? ` · ${filterCount}` : ''}
          </Button>
          <Segmented<Density>
            label="Poster size"
            value={prefs.density}
            onChange={(density) => updatePrefs.mutate({ density })}
            options={[
              { value: 'compact', label: 'S' },
              { value: 'comfortable', label: 'M' },
              { value: 'large', label: 'L' },
            ]}
          />
        </div>
      </div>

      {activeChips.length > 0 && (
        <div className="active-filters" aria-label="Active filters">
          {activeChips.map((chip) => (
            <Chip key={chip.key} selected removable onClick={chip.remove}>
              <span className="visually-hidden">Remove filter </span>
              {chip.label}
            </Chip>
          ))}
          <button type="button" className="link-btn" onClick={clearFilters}>
            Clear all
          </button>
        </div>
      )}

      {movies.isPending ? (
        <PosterGridSkeleton />
      ) : movies.isError && items.length === 0 ? (
        <StatusView
          icon="offline"
          tone="error"
          title="Movies could not be loaded"
          action={
            <Button variant="primary" icon="refresh" onClick={() => movies.refetch()}>
              Try again
            </Button>
          }
        >
          <p>{errorMessage(movies.error)}</p>
        </StatusView>
      ) : items.length === 0 ? (
        <StatusView
          icon="search"
          title={query.q ? `Nothing matches “${query.q}”` : 'No movies match these filters'}
          action={
            filterCount || query.q ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setText('');
                  setParams(new URLSearchParams(), { replace: true });
                }}
              >
                Clear search and filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <PosterGrid label="Movies">
            {items.map((movie, i) => (
              <li key={movie.id}>
                <PosterCard movie={movie} eager={i < 12} />
              </li>
            ))}
          </PosterGrid>
          <div ref={sentinel} className="grid-sentinel">
            {movies.isFetchingNextPage && <Spinner label="Loading more" />}
            {movies.isError && (
              <Button variant="ghost" icon="refresh" onClick={() => movies.fetchNextPage()}>
                Load more
              </Button>
            )}
          </div>
        </>
      )}

      <Dialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filters"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={clearFilters} disabled={!filterCount}>
              Reset
            </Button>
            <Button variant="primary" onClick={() => setFiltersOpen(false)}>
              {movies.isFetching ? 'Updating…' : `Show ${plural(total, 'movie')}`}
            </Button>
          </>
        }
      >
        {facets.isPending ? (
          <Spinner label="Loading filters" />
        ) : facets.isError || !f ? (
          <p className="muted">Filters are unavailable: {errorMessage(facets.error)}</p>
        ) : (
          <div className="filters">
            <fieldset className="filter-group">
              <legend className="filter-group__title">Watch status</legend>
              <Segmented
                label="Watch status"
                value={query.watched ?? 'all'}
                onChange={(v) => setValue('watched', v === 'all' ? null : v)}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'unwatched', label: 'Unwatched' },
                  { value: 'inProgress', label: 'In progress' },
                  { value: 'watched', label: 'Watched' },
                ]}
              />
              <Switch
                label="Favorites only"
                checked={Boolean(query.favorite)}
                onChange={(v) => setValue('favorite', v ? '1' : null)}
              />
            </fieldset>
            <FilterList
              title="Genre"
              values={f.genres}
              selected={query.genres}
              onToggle={(v) => toggleList('genre', v)}
            />
            {f.decades.length > 0 && (
              <fieldset className="filter-group">
                <legend className="filter-group__title">Release year</legend>
                <div className="chip-list">
                  {f.decades.map((d) => {
                    const decade = Number(d.value);
                    return (
                      <Chip
                        key={d.value}
                        count={d.count}
                        selected={decadeSelected(decade)}
                        onClick={() =>
                          update((p) => {
                            if (decadeSelected(decade)) {
                              p.delete('yearMin');
                              p.delete('yearMax');
                            } else {
                              p.set('yearMin', String(decade));
                              p.set('yearMax', String(decade + 9));
                            }
                          })
                        }
                      >
                        {d.value}s
                      </Chip>
                    );
                  })}
                </div>
                <div className="range-inputs">
                  <label>
                    <span className="field__label">From</span>
                    <input
                      className="input input--sm"
                      type="number"
                      inputMode="numeric"
                      placeholder={f.yearRange ? String(f.yearRange[0]) : 'Year'}
                      value={query.yearMin ?? ''}
                      onChange={(e) => setValue('yearMin', e.target.value)}
                    />
                  </label>
                  <label>
                    <span className="field__label">To</span>
                    <input
                      className="input input--sm"
                      type="number"
                      inputMode="numeric"
                      placeholder={f.yearRange ? String(f.yearRange[1]) : 'Year'}
                      value={query.yearMax ?? ''}
                      onChange={(e) => setValue('yearMax', e.target.value)}
                    />
                  </label>
                </div>
              </fieldset>
            )}
            {f.runtimeRange && (
              <fieldset className="filter-group">
                <legend className="filter-group__title">Runtime</legend>
                <div className="chip-list">
                  {RUNTIME_OPTIONS.map((m) => (
                    <Chip
                      key={m}
                      selected={query.runtimeMax === m - 1}
                      onClick={() =>
                        setValue('runtimeMax', query.runtimeMax === m - 1 ? null : String(m - 1))
                      }
                    >
                      Under {m} min
                    </Chip>
                  ))}
                </div>
              </fieldset>
            )}
            <FilterList
              title="Director"
              values={f.directors}
              selected={query.directors}
              onToggle={(v) => toggleList('director', v)}
              searchable
            />
            <FilterList
              title="Country"
              values={f.countries}
              selected={query.countries}
              onToggle={(v) => toggleList('country', v)}
            />
            <FilterList
              title="Age rating"
              values={f.ratings}
              selected={query.ratings}
              onToggle={(v) => toggleList('rating', v)}
            />
            <FilterList
              title="Tag"
              values={f.tags}
              selected={query.tags}
              onToggle={(v) => toggleList('tag', v)}
              searchable
            />
            <FilterList
              title="Studio"
              values={f.studios}
              selected={query.studios}
              onToggle={(v) => toggleList('studio', v)}
              searchable
            />
          </div>
        )}
      </Dialog>
    </div>
  );
}
