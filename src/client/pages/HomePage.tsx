import { Link } from 'react-router';
import type { HomePayload, Movie, Preferences } from '../../shared/types';
import { CollectionCard } from '../components/CollectionCard';
import { Icon } from '../components/Icon';
import { Hero, HeroSkeleton } from '../components/Hero';
import { ContinueCard, PosterCard, Row } from '../components/movies';
import { Button, ButtonLink, Skeleton, StatusView } from '../components/ui';
import { errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { sizedImage } from '../lib/images';
import { useHome, useRefreshCatalog } from '../lib/queries';
import { slicePath } from '../lib/wheel';

/** A small, playful invitation to the wheel (replaces the old full-width random pick). */
function SpinPromo({ movie }: { movie: Movie | null }) {
  return (
    <section className="spin-promo" aria-labelledby="spin-promo-title">
      <div className="spin-promo__wheel" aria-hidden="true">
        <svg viewBox="-50 -50 100 100">
          {Array.from({ length: 8 }, (_, i) => (
            <path
              key={i}
              d={slicePath(i, 8, 48)}
              className={`spin-promo__slice spin-promo__slice--${i % 4}`}
            />
          ))}
          <circle r="9" className="spin-promo__hub" />
        </svg>
      </div>
      <div className="spin-promo__body">
        <p className="eyebrow">Can’t decide?</p>
        <h2 id="spin-promo-title" className="spin-promo__title display">
          Spin the wheel
        </h2>
        <p className="spin-promo__text">
          {movie
            ? `Tonight could be ${movie.title}… or anything else you haven’t seen. Let fate decide.`
            : 'Let fate pick tonight’s movie from the ones you haven’t seen.'}{' '}
          <Link to="/night">Or put it to a vote.</Link>
        </p>
      </div>
      <ButtonLink
        to="/spin?watched=unwatched"
        variant="primary"
        icon="wheel"
        className="spin-promo__cta"
      >
        Spin
      </ButtonLink>
    </section>
  );
}

function Section({ section }: { section: HomePayload['sections'][number] }) {
  switch (section.type) {
    case 'row':
      return (
        <Row
          title={section.row.title}
          href={section.row.href}
          wide={section.row.kind === 'continue'}
          id={section.row.id}
        >
          {section.row.movies.map((movie) => (
            <li key={movie.id}>
              {section.row.kind === 'continue' ? (
                <ContinueCard movie={movie} />
              ) : (
                <PosterCard movie={movie} />
              )}
            </li>
          ))}
        </Row>
      );
    case 'collections':
      return (
        <Row title="Your collections" href="/collections" wide id="collections">
          {section.collections.map((c) => (
            <li key={c.id}>
              <CollectionCard collection={c} />
            </li>
          ))}
        </Row>
      );
    case 'yearInReview':
      return (
        <Link to="/wrapped" className="year-promo">
          <span className="eyebrow">Wheelhouse Wrapped</span>
          <span className="year-promo__title display">Your {section.year} in movies</span>
          <span className="year-promo__stats">
            {plural(section.movies, 'movie')} ·{' '}
            {section.hours >= 10 ? Math.round(section.hours) : section.hours} hours
          </span>
          <Icon name="chevronRight" size={22} />
        </Link>
      );
    case 'randomPick':
      return <SpinPromo movie={section.movie} />;
    case 'genres':
      return (
        <Row title="Browse by genre" href="/browse" wide id="genres">
          {section.genres.map((g) => (
            <li key={g.name}>
              <Link to={`/browse?genre=${encodeURIComponent(g.name)}`} className="tile">
                {g.poster && (
                  <img src={sizedImage(g.poster, 480)} alt="" loading="lazy" decoding="async" />
                )}
                <span className="tile__label">
                  <span className="tile__name">{g.name}</span>
                  <span className="tile__count">{plural(g.count, 'film')}</span>
                </span>
              </Link>
            </li>
          ))}
        </Row>
      );
    case 'decades':
      return (
        <Row title="Browse by decade" id="decades">
          {section.decades.map((d) => (
            <li key={d.decade}>
              <Link
                to={`/browse?yearMin=${d.decade}&yearMax=${d.decade + 9}&sort=year&dir=asc`}
                className="tile tile--decade"
              >
                {d.poster && (
                  <img src={sizedImage(d.poster, 320)} alt="" loading="lazy" decoding="async" />
                )}
                <span className="tile__label">
                  <span className="tile__name display">{d.decade}s</span>
                  <span className="tile__count">{plural(d.count, 'film')}</span>
                </span>
              </Link>
            </li>
          ))}
        </Row>
      );
  }
}

export function HomePage({ prefs }: { prefs: Preferences }) {
  const home = useHome();
  const refresh = useRefreshCatalog();

  if (home.isPending) {
    return (
      <div className="home">
        <HeroSkeleton />
        <div className="home__sections">
          {[0, 1].map((i) => (
            <div key={i} className="row">
              <Skeleton className="skeleton--line" style={{ width: 180 }} />
              <div className="row__track">
                {Array.from({ length: 7 }, (_, j) => (
                  <Skeleton
                    key={j}
                    className="skeleton--poster"
                    style={{ width: 'var(--row-card)', flex: 'none' }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (home.isError) {
    return (
      <div className="page">
        <StatusView
          icon="offline"
          tone="error"
          title="Your library could not be loaded"
          action={
            <Button variant="primary" icon="refresh" onClick={() => home.refetch()}>
              Try again
            </Button>
          }
        >
          <p>{errorMessage(home.error)}</p>
        </StatusView>
      </div>
    );
  }

  const data = home.data;
  if (data.libraryCount === 0) {
    return (
      <div className="page">
        <StatusView
          title="Your library is empty"
          action={
            <>
              <Button
                variant="primary"
                icon="refresh"
                busy={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                Check again
              </Button>
              <ButtonLink to="/settings#server" variant="ghost">
                Server status
              </ButtonLink>
            </>
          }
        >
          <p>
            Add movie files to a Jellyfin “Movies” library and let Jellyfin scan them. They will
            appear here automatically.
          </p>
        </StatusView>
      </div>
    );
  }

  return (
    <div className="home route-enter">
      {data.hero.length > 0 ? (
        <Hero movies={data.hero} prefs={prefs} />
      ) : (
        <div className="home__spacer" />
      )}
      <div className="home__sections">
        {data.sections.map((section) => (
          <Section key={section.type === 'row' ? section.row.id : section.id} section={section} />
        ))}
        {data.sections.length === 0 && (
          <StatusView
            compact
            title="All home sections are hidden"
            action={<ButtonLink to="/settings#home">Customize home</ButtonLink>}
          />
        )}
      </div>
    </div>
  );
}
