import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import type { Movie } from '../../shared/types';
import type { Ranked, Wrapped } from '../../shared/wrapped';
import { Poster, PosterCard, PosterGrid, PosterGridSkeleton } from '../components/movies';
import { ButtonLink, Chip, StatusView } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatRuntime, plural } from '../lib/format';

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="wrapped-stat">
      <span className="wrapped-stat__value display">{value}</span>
      <span className="wrapped-stat__label">{label}</span>
    </div>
  );
}

function TopList({
  title,
  items,
  link,
}: {
  title: string;
  items: Ranked[];
  link?: (n: string) => string;
}) {
  if (items.length === 0) return null;
  return (
    <section className="wrapped-card">
      <h2 className="wrapped-card__title">{title}</h2>
      <ol className="wrapped-top">
        {items.map((item, i) => (
          <li key={item.name}>
            <span className="wrapped-top__rank">{i + 1}</span>
            {link ? (
              <Link to={link(item.name)} className="wrapped-top__name">
                {item.name}
              </Link>
            ) : (
              <span className="wrapped-top__name">{item.name}</span>
            )}
            <span className="faint">{plural(item.count, 'film')}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Feature({ title, movie, note }: { title: string; movie: Movie | null; note: string }) {
  if (!movie) return null;
  return (
    <Link to={`/movie/${movie.id}`} className="wrapped-card wrapped-feature">
      <div className="wrapped-feature__poster">
        <Poster movie={movie} sizes="90px" />
      </div>
      <div>
        <h2 className="wrapped-card__title">{title}</h2>
        <p className="wrapped-feature__movie">{movie.title}</p>
        <p className="faint">{note}</p>
      </div>
    </Link>
  );
}

export default function WrappedPage() {
  const [params, setParams] = useSearchParams();
  const year = params.get('year') ?? String(new Date().getFullYear());
  const data = useQuery({
    queryKey: ['wrapped', year],
    queryFn: () => api<Wrapped>(`/wrapped?year=${encodeURIComponent(year)}`),
  });

  const label = year === 'all' ? 'All time' : year;
  const w = data.data;
  const peak = w ? Math.max(...w.byMonth) : 0;
  const busiest = w && peak > 0 ? MONTH_NAMES[w.byMonth.indexOf(peak)] : null;
  const years = [...new Set([String(new Date().getFullYear()), ...(w?.years.map(String) ?? [])])];

  return (
    <div className="page wrapped route-enter">
      <header className="wrapped__header">
        <p className="eyebrow">Wheelhouse Wrapped</p>
        <h1 className="wrapped__title display">
          {year === 'all' ? 'All your movies' : `Your ${year} in movies`}
        </h1>
        <div className="chip-list" role="group" aria-label="Year">
          {years.map((y) => (
            <Chip key={y} selected={y === year} onClick={() => setParams({ year: y })}>
              {y}
            </Chip>
          ))}
          <Chip selected={year === 'all'} onClick={() => setParams({ year: 'all' })}>
            All time
          </Chip>
        </div>
      </header>

      {data.isPending ? (
        <PosterGridSkeleton count={6} />
      ) : data.isError ? (
        <StatusView icon="alert" tone="error" title="Couldn’t load your year">
          <p>{errorMessage(data.error)}</p>
        </StatusView>
      ) : !w || w.moviesWatched === 0 ? (
        <StatusView
          icon="film"
          title={`Nothing watched ${year === 'all' ? 'yet' : `in ${label}`}`}
          action={
            <ButtonLink to="/spin?watched=unwatched" variant="primary" icon="wheel">
              Spin the wheel
            </ButtonLink>
          }
        >
          <p>Movies you watch show up here, with your favourite genres, directors and more.</p>
        </StatusView>
      ) : (
        <>
          <div className="wrapped-stats">
            <Stat
              value={String(w.moviesWatched)}
              label={w.moviesWatched === 1 ? 'movie' : 'movies'}
            />
            <Stat
              value={
                w.hoursWatched >= 10 ? String(Math.round(w.hoursWatched)) : String(w.hoursWatched)
              }
              label="hours watched"
            />
            {w.topGenres[0] && <Stat value={w.topGenres[0].name} label="favourite genre" />}
            {w.topDecade && <Stat value={w.topDecade.name} label="favourite decade" />}
          </div>

          {year !== 'all' && peak > 0 && (
            <section className="wrapped-card wrapped-months" aria-label="Movies by month">
              <h2 className="wrapped-card__title">
                Month by month{busiest ? ` · busiest: ${busiest}` : ''}
              </h2>
              <div className="wrapped-months__bars">
                {w.byMonth.map((n, i) => (
                  <div key={i} className="wrapped-months__month" title={`${MONTH_NAMES[i]}: ${n}`}>
                    <span
                      className="wrapped-months__bar"
                      style={{ height: `${(n / peak) * 100}%` }}
                    />
                    <span className="wrapped-months__label" aria-hidden="true">
                      {MONTHS[i]}
                    </span>
                    <span className="visually-hidden">
                      {MONTH_NAMES[i]}: {n}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="wrapped-grid">
            <TopList
              title="Top directors"
              items={w.topDirectors}
              link={(n) => `/person/${encodeURIComponent(n)}`}
            />
            <TopList
              title="Top genres"
              items={w.topGenres}
              link={(n) => `/browse?genre=${encodeURIComponent(n)}`}
            />
            <TopList
              title="Most-watched actors"
              items={w.topActors}
              link={(n) => `/person/${encodeURIComponent(n)}`}
            />
            <Feature
              title="Longest sit"
              movie={w.longest}
              note={formatRuntime(w.longest?.runtimeMinutes) ?? ''}
            />
            <Feature
              title="Most rewatched"
              movie={w.mostRewatched?.movie ?? null}
              note={w.mostRewatched ? `${w.mostRewatched.plays} times` : ''}
            />
            <Feature
              title={year === 'all' ? 'The very first' : 'First of the year'}
              movie={w.first}
              note=""
            />
            <Feature title="Most recent" movie={w.latest} note="" />
          </div>

          <section className="wrapped__all" aria-labelledby="wrapped-all">
            <h2 id="wrapped-all" className="row__title">
              Everything you watched
            </h2>
            <PosterGrid label="Movies watched">
              {w.movies.map((m) => (
                <li key={m.id}>
                  <PosterCard movie={m} />
                </li>
              ))}
            </PosterGrid>
          </section>
          {w.approximate && (
            <p className="field__hint">
              Includes movies watched outside Wheelhouse (or before it kept history), counted once
              at the last time they were played.
            </p>
          )}
        </>
      )}
    </div>
  );
}
