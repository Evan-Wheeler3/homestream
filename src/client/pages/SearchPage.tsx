import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PersonSummary } from '../../shared/types';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Icon } from '../components/Icon';
import { PosterCard, PosterGrid, PosterGridSkeleton } from '../components/movies';
import { Button, Chip, Spinner, StatusView } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { useDebounced, useInfiniteSentinel } from '../lib/hooks';
import { useFacets, useMovies } from '../lib/queries';

const RECENT_KEY = 'pc-recent-searches';

// Recent searches are a per-device convenience, so browser storage is appropriate.
function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    /* ignore */
  }
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const query = useDebounced(text.trim(), 200);
  const [recent, setRecent] = useState(loadRecent);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const facets = useFacets();
  const results = useMovies({ q: query }, query.length > 0);
  const people = useQuery({
    queryKey: ['people', query],
    queryFn: () => api<{ people: PersonSummary[] }>(`/people?q=${encodeURIComponent(query)}`),
    enabled: query.length > 1,
  });
  const matches = query.length > 1 ? (people.data?.people ?? []) : [];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setParams(query ? { q: query } : {}, { replace: true });
  }, [query, setParams]);

  const items = results.data?.pages.flatMap((p) => p.items) ?? [];
  const total = results.data?.pages[0]?.total ?? 0;
  const sentinel = useInfiniteSentinel(() => {
    if (results.hasNextPage && !results.isFetchingNextPage) void results.fetchNextPage();
  }, Boolean(results.hasNextPage));

  const remember = (term: string) => {
    const next = [term, ...recent.filter((r) => r.toLowerCase() !== term.toLowerCase())].slice(
      0,
      8,
    );
    setRecent(next);
    saveRecent(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && items[0]) {
      remember(text.trim());
      navigate(`/movie/${items[0].id}`);
    } else if (event.key === 'ArrowDown') {
      const first = resultsRef.current?.querySelector<HTMLAnchorElement>('a');
      if (first) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === 'Escape') {
      setText('');
    }
  };

  return (
    <div className="page search-page route-enter">
      <h1 className="visually-hidden">Search</h1>
      <div className="search-hero">
        <label className="search-field search-field--large">
          <Icon name="search" size={24} />
          <span className="visually-hidden">Search movies by title or director</span>
          <input
            ref={inputRef}
            type="search"
            placeholder="Titles, directors, actors…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {results.isFetching && query && <Spinner size={18} />}
        </label>
        <p className="search-hero__hint faint">
          Press <kbd>Enter</kbd> to open the top result · <kbd>↓</kbd> to move into results ·{' '}
          <kbd>/</kbd> to search from anywhere
        </p>
      </div>

      {!query ? (
        <div className="search-idle">
          {recent.length > 0 && (
            <section>
              <h2 className="section-label">Recent searches</h2>
              <div className="chip-list">
                {recent.map((term) => (
                  <Chip key={term} onClick={() => setText(term)}>
                    {term}
                  </Chip>
                ))}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setRecent([]);
                    saveRecent([]);
                  }}
                >
                  Clear
                </button>
              </div>
            </section>
          )}
          {facets.data && facets.data.genres.length > 0 && (
            <section>
              <h2 className="section-label">Browse genres</h2>
              <div className="chip-list">
                {facets.data.genres.map((g) => (
                  <Link
                    key={g.value}
                    to={`/browse?genre=${encodeURIComponent(g.value)}`}
                    className="chip"
                  >
                    {g.value}
                    <span className="chip__count">{g.count}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      ) : results.isPending ? (
        <PosterGridSkeleton count={12} />
      ) : results.isError ? (
        <StatusView
          icon="offline"
          tone="error"
          title="Search failed"
          action={
            <Button variant="primary" onClick={() => results.refetch()}>
              Try again
            </Button>
          }
        >
          <p>{errorMessage(results.error)}</p>
        </StatusView>
      ) : items.length === 0 && matches.length === 0 ? (
        <StatusView icon="search" title={`No results for “${query}”`}>
          <p>Try a shorter search, or check the spelling.</p>
        </StatusView>
      ) : (
        <div ref={resultsRef} onClick={() => remember(query)}>
          {matches.length > 0 && (
            <section className="search-people" aria-label="People">
              <h2 className="section-label">People</h2>
              <ul className="search-people__list">
                {matches.map((p) => (
                  <li key={p.name}>
                    <Link to={`/person/${encodeURIComponent(p.name)}`} className="person-chip">
                      <span className="person-chip__initials" aria-hidden="true">
                        {p.name
                          .split(/\s+/)
                          .map((w) => w[0])
                          .slice(0, 2)
                          .join('')}
                      </span>
                      <span>
                        <strong>{p.name}</strong>
                        <span className="faint">
                          {[
                            p.directed ? `Directed ${p.directed}` : null,
                            p.actedIn ? `Acted in ${p.actedIn}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="section-label" aria-live="polite">
            {plural(total, 'result')}
          </p>
          <PosterGrid label="Search results">
            {items.map((movie) => (
              <li key={movie.id}>
                <PosterCard movie={movie} />
              </li>
            ))}
          </PosterGrid>
          <div ref={sentinel} className="grid-sentinel" />
        </div>
      )}
    </div>
  );
}
