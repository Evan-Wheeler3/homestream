import { useMemo, useState } from 'react';
import { Row, PosterGrid, PosterGridSkeleton } from '../components/movies';
import { NextUpCard, ShowCard } from '../components/shows';
import { Button, StatusView } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { useShows } from '../lib/queries';

export function ShowsPage() {
  const shows = useShows();
  const [filter, setFilter] = useState('');
  useDocumentTitle('TV Shows');

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = shows.data?.shows ?? [];
    return q ? all.filter((s) => s.title.toLowerCase().includes(q)) : all;
  }, [shows.data, filter]);

  if (shows.isError) {
    return (
      <div className="page">
        <StatusView
          icon="offline"
          tone="error"
          title="TV shows could not be loaded"
          action={
            <Button variant="primary" icon="refresh" onClick={() => shows.refetch()}>
              Try again
            </Button>
          }
        >
          <p>{errorMessage(shows.error)}</p>
        </StatusView>
      </div>
    );
  }

  const data = shows.data;
  return (
    <div className="page shows route-enter">
      <header className="page-header">
        <div>
          <h1 className="page-title">TV Shows</h1>
          {data && data.shows.length > 0 && (
            <p>
              {data.shows.length === 1 ? '1 show' : `${data.shows.length} shows`} in your library
            </p>
          )}
        </div>
        {data && data.shows.length > 8 && (
          <div className="page-header__actions">
            <input
              className="input"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a show"
              aria-label="Find a show"
            />
          </div>
        )}
      </header>

      {!data ? (
        <PosterGridSkeleton />
      ) : data.shows.length === 0 ? (
        <StatusView icon="tv" title="No TV shows yet">
          <p>
            Put a TV season disc in the drive: Wheelhouse spots the episodes and asks you to check
            them on the Discs page. Shows already in a Jellyfin “Shows” library appear here too.
          </p>
        </StatusView>
      ) : (
        <>
          {data.nextUp.length > 0 && !filter && (
            <Row title="Next up" id="next-up" wide>
              {data.nextUp.map((episode) => (
                <li key={episode.id}>
                  <NextUpCard episode={episode} />
                </li>
              ))}
            </Row>
          )}
          <section aria-labelledby="all-shows">
            <h2 id="all-shows" className="row__title shows__heading">
              All shows
            </h2>
            {visible.length === 0 ? (
              <p className="faint">No show matches “{filter}”.</p>
            ) : (
              <PosterGrid label="TV shows">
                {visible.map((show, i) => (
                  <li key={show.id}>
                    <ShowCard show={show} eager={i < 12} />
                  </li>
                ))}
              </PosterGrid>
            )}
          </section>
        </>
      )}
    </div>
  );
}
