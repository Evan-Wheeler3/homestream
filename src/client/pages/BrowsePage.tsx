import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { Facets, Movie, MovieQuery, Preferences, SortField } from '../../shared/types';
import { Icon } from '../components/Icon';
import { PosterCard, PosterGrid, PosterGridSkeleton } from '../components/movies';
import {
  Button,
  ButtonLink,
  Chip,
  Dialog,
  IconButton,
  Segmented,
  Spinner,
  StatusView,
  Switch,
} from '../components/ui';
import { errorMessage } from '../lib/api';
import { RUNTIME_PRESETS, runtimeLabel, runtimePreset, selectedDecade } from '../lib/filters';
import { plural } from '../lib/format';
import { useDebounced, useInfiniteSentinel } from '../lib/hooks';
import { movieQueryString, useFacets, useMovies } from '../lib/queries';

export const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Release year' },
  { value: 'dateAdded', label: 'Date added' },
  { value: 'runtime', label: 'Runtime' },
  { value: 'rating', label: 'Community rating' },
];

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
    actors: listParam(params, 'actor'),
    countries: listParam(params, 'country'),
    tags: listParam(params, 'tag'),
    studios: listParam(params, 'studio'),
    ratings: listParam(params, 'rating'),
    yearMin: numParam(params, 'yearMin'),
    yearMax: numParam(params, 'yearMax'),
    runtimeMin: numParam(params, 'runtimeMin'),
    runtimeMax: numParam(params, 'runtimeMax'),
    watched:
      watched === 'watched' || watched === 'unwatched' || watched === 'inProgress'
        ? watched
        : undefined,
    favorite: params.get('favorite') === '1' || undefined,
    watchlist: params.get('watchlist') === '1' || undefined,
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
    (q.actors?.length ?? 0) +
    (q.countries?.length ?? 0) +
    (q.tags?.length ?? 0) +
    (q.studios?.length ?? 0) +
    (q.ratings?.length ?? 0) +
    (q.yearMin != null || q.yearMax != null ? 1 : 0) +
    (q.runtimeMin != null || q.runtimeMax != null ? 1 : 0) +
    (q.watched ? 1 : 0) +
    (q.favorite ? 1 : 0) +
    (q.watchlist ? 1 : 0)
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

type QuickPanel = 'genre' | 'runtime' | 'director' | 'decade';

/**
 * One-tap filters for the things people filter by most. Each pill opens a
 * small panel under the row (rather than a pop-over, so it also works on
 * phones where the row scrolls sideways).
 */
function QuickFilters({
  query,
  facets,
  toggleList,
  setRuntime,
  setDecade,
  setValue,
  filterCount,
  onClear,
}: {
  query: MovieQuery;
  facets: Facets | undefined;
  toggleList: (key: string, value: string) => void;
  setRuntime: (preset: { min?: number; max?: number } | null) => void;
  setDecade: (decade: number | null) => void;
  setValue: (key: string, value: string | null) => void;
  filterCount: number;
  onClear: () => void;
}) {
  const [open, setOpen] = useState<QuickPanel | null>(null);
  const [directorText, setDirectorText] = useState('');
  const decade = selectedDecade(query);
  const runtime = runtimeLabel(query);

  const pillLabel = (name: string, values: string[] | undefined) =>
    !values?.length ? name : values.length === 1 ? values[0]! : `${name} · ${values.length}`;

  const pills: { id: QuickPanel; label: string; active: boolean }[] = [
    { id: 'genre', label: pillLabel('Genre', query.genres), active: Boolean(query.genres?.length) },
    { id: 'runtime', label: runtime ?? 'Runtime', active: Boolean(runtime) },
    {
      id: 'director',
      label: pillLabel('Director', query.directors),
      active: Boolean(query.directors?.length),
    },
    { id: 'decade', label: decade != null ? `${decade}s` : 'Decade', active: decade != null },
  ];

  const needle = directorText.trim().toLowerCase();
  const directors = (facets?.directors ?? [])
    .filter((d) => !needle || d.value.toLowerCase().includes(needle))
    .slice(0, needle ? 60 : 24);

  return (
    <div className="quick-filters">
      <div className="quick-filters__row" role="group" aria-label="Quick filters">
        <button
          type="button"
          className={`pill ${query.watched === 'unwatched' ? 'is-active' : ''}`}
          aria-pressed={query.watched === 'unwatched'}
          onClick={() => setValue('watched', query.watched === 'unwatched' ? null : 'unwatched')}
        >
          Unwatched
        </button>
        <button
          type="button"
          className={`pill ${query.watchlist ? 'is-active' : ''}`}
          aria-pressed={Boolean(query.watchlist)}
          onClick={() => setValue('watchlist', query.watchlist ? null : '1')}
        >
          Watchlist
        </button>
        {pills.map((pill) => (
          <button
            key={pill.id}
            type="button"
            className={`pill ${pill.active ? 'is-active' : ''} ${open === pill.id ? 'is-open' : ''}`}
            aria-expanded={open === pill.id}
            aria-controls={`quick-${pill.id}`}
            onClick={() => setOpen(open === pill.id ? null : pill.id)}
          >
            {pill.label}
            <Icon name="chevronDown" size={14} />
          </button>
        ))}
        {filterCount > 0 && (
          <button type="button" className="link-btn quick-filters__clear" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {open && facets && (
        <div
          className="quick-filters__panel"
          id={`quick-${open}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(null);
          }}
        >
          {open === 'genre' && (
            <div className="chip-list">
              {facets.genres.map((g) => (
                <Chip
                  key={g.value}
                  count={g.count}
                  selected={query.genres?.includes(g.value)}
                  onClick={() => toggleList('genre', g.value)}
                >
                  {g.value}
                </Chip>
              ))}
            </div>
          )}
          {open === 'runtime' && (
            <div className="chip-list">
              {RUNTIME_PRESETS.map((p) => {
                const selected = runtimePreset(query)?.id === p.id;
                return (
                  <Chip
                    key={p.id}
                    selected={selected}
                    onClick={() => setRuntime(selected ? null : p)}
                  >
                    {p.label}
                  </Chip>
                );
              })}
            </div>
          )}
          {open === 'director' && (
            <>
              <input
                className="input input--sm quick-filters__search"
                type="search"
                placeholder="Find a director"
                aria-label="Find a director"
                value={directorText}
                onChange={(e) => setDirectorText(e.target.value)}
              />
              <div className="chip-list">
                {[
                  ...(query.directors ?? [])
                    .filter((d) => !directors.some((x) => x.value === d))
                    .map((value) => ({ value, count: undefined as number | undefined })),
                  ...directors,
                ].map((d) => (
                  <Chip
                    key={d.value}
                    count={d.count}
                    selected={query.directors?.includes(d.value)}
                    onClick={() => toggleList('director', d.value)}
                  >
                    {d.value}
                  </Chip>
                ))}
                {directors.length === 0 && <p className="faint">No director matches.</p>}
              </div>
            </>
          )}
          {open === 'decade' && (
            <div className="chip-list">
              {facets.decades.map((d) => {
                const value = Number(d.value);
                return (
                  <Chip
                    key={d.value}
                    count={d.count}
                    selected={decade === value}
                    onClick={() => setDecade(decade === value ? null : value)}
                  >
                    {d.value}s
                  </Chip>
                );
              })}
            </div>
          )}
          <button
            type="button"
            className="link-btn quick-filters__done"
            onClick={() => setOpen(null)}
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}

export function BrowsePage({ prefs }: { prefs: Preferences }) {
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => queryFromParams(params, prefs), [params, prefs]);
  const [text, setText] = useState(query.q ?? '');
  const debouncedText = useDebounced(text, 250);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const facets = useFacets();
  const movies = useMovies(query);

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
        'actor',
        'country',
        'tag',
        'studio',
        'rating',
        'yearMin',
        'yearMax',
        'runtimeMin',
        'runtimeMax',
        'watched',
        'favorite',
        'watchlist',
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
  const decadeSelected = (d: number) => selectedDecade(query) === d;

  const setRuntime = (preset: { min?: number; max?: number } | null) =>
    update((p) => {
      if (preset?.min != null) p.set('runtimeMin', String(preset.min));
      else p.delete('runtimeMin');
      if (preset?.max != null) p.set('runtimeMax', String(preset.max));
      else p.delete('runtimeMax');
    });

  const setDecade = (decade: number | null) =>
    update((p) => {
      if (decade == null) {
        p.delete('yearMin');
        p.delete('yearMax');
      } else {
        p.set('yearMin', String(decade));
        p.set('yearMax', String(decade + 9));
      }
    });

  // The wheel spins through movies matching the current search and filters.
  const spinHref = `/spin?${movieQueryString({ ...query, sort: undefined, dir: undefined })}`;

  const activeChips: { key: string; label: string; remove: () => void }[] = [];
  const listChips = (key: string, values: string[] | undefined) =>
    values?.forEach((v) =>
      activeChips.push({ key: `${key}-${v}`, label: v, remove: () => toggleList(key, v) }),
    );
  // Genre, director, runtime, decade and "unwatched" show in the quick-filter pills.
  listChips('actor', query.actors);
  listChips('country', query.countries);
  listChips('tag', query.tags);
  listChips('studio', query.studios);
  listChips('rating', query.ratings);
  if ((query.yearMin != null || query.yearMax != null) && selectedDecade(query) == null) {
    activeChips.push({
      key: 'years',
      label: `${query.yearMin ?? '…'}–${query.yearMax ?? '…'}`,
      remove: () => update((p) => (p.delete('yearMin'), p.delete('yearMax'))),
    });
  }
  if (query.watched && query.watched !== 'unwatched')
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
        {total > 1 && (
          <ButtonLink to={spinHref} variant="secondary" icon="wheel">
            Spin the wheel
          </ButtonLink>
        )}
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
            All filters{filterCount ? ` · ${filterCount}` : ''}
          </Button>
        </div>
      </div>

      <QuickFilters
        query={query}
        facets={f}
        toggleList={toggleList}
        setRuntime={setRuntime}
        setDecade={setDecade}
        setValue={setValue}
        filterCount={filterCount}
        onClear={clearFilters}
      />

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
                        onClick={() => setDecade(decadeSelected(decade) ? null : decade)}
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
                  {RUNTIME_PRESETS.map((p) => {
                    const selected = runtimePreset(query)?.id === p.id;
                    return (
                      <Chip
                        key={p.id}
                        selected={selected}
                        onClick={() => setRuntime(selected ? null : p)}
                      >
                        {p.label}
                      </Chip>
                    );
                  })}
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
