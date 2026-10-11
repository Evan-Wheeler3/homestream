import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Movie, Preferences } from '../../shared/types';
import { formatRuntime, timeLeft } from '../lib/format';
import { POSTER_WIDTHS, sizedImage, srcSet } from '../lib/images';
import { Icon } from './Icon';
import { IconButton, ProgressBar, Skeleton } from './ui';

// -----------------------------------------------------------------------------
// Playback targets

export function isInProgress(movie: Movie) {
  return movie.user.positionSeconds > 0 && !movie.user.played;
}

export function playHref(movie: Movie, startSeconds: number) {
  return `/play/${movie.id}?t=${Math.max(0, Math.floor(startSeconds))}`;
}

/** Primary play action honouring the "resume behaviour" preference. */
export function primaryPlay(movie: Movie, behavior: Preferences['playback']['resumeBehavior']) {
  const resumable = isInProgress(movie);
  if (resumable && behavior !== 'restart') {
    return { label: 'Resume', href: playHref(movie, movie.user.positionSeconds), resumable };
  }
  return { label: 'Play', href: playHref(movie, 0), resumable };
}

// -----------------------------------------------------------------------------
// Artwork

export function Poster({
  movie,
  sizes = '(max-width: 600px) 33vw, 180px',
  eager,
}: {
  movie: Pick<Movie, 'title' | 'year' | 'images'>;
  sizes?: string;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const url = movie.images.poster;
  if (!url || failed) {
    return (
      <div className="poster poster--fallback" aria-hidden="true">
        <span className="poster__fallback-title">{movie.title}</span>
        {movie.year && <span className="poster__fallback-year">{movie.year}</span>}
      </div>
    );
  }
  return (
    <div className={`poster ${loaded ? 'is-loaded' : ''}`}>
      <img
        src={sizedImage(url, 400)}
        srcSet={srcSet(url, POSTER_WIDTHS)}
        sizes={sizes}
        alt=""
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export function Backdrop({
  url,
  sizes = '100vw',
  className = '',
  eager,
  widths = [640, 960, 1440, 1920],
}: {
  url: string | null;
  sizes?: string;
  className?: string;
  eager?: boolean;
  widths?: number[];
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (!url || failed)
    return <div className={`backdrop backdrop--empty ${className}`} aria-hidden="true" />;
  return (
    <div className={`backdrop ${loaded ? 'is-loaded' : ''} ${className}`} aria-hidden="true">
      <img
        src={sizedImage(url, 1440)}
        srcSet={srcSet(url, widths)}
        sizes={sizes}
        alt=""
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        fetchPriority={eager ? 'high' : 'auto'}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Cards

export function PosterCard({
  movie,
  eager,
  badge,
}: {
  movie: Movie;
  eager?: boolean;
  badge?: ReactNode;
}) {
  const runtime = formatRuntime(movie.runtimeMinutes);
  return (
    <Link
      to={`/movie/${movie.id}`}
      className="poster-card"
      aria-label={`${movie.title}${movie.year ? ` (${movie.year})` : ''}`}
    >
      <div className="poster-card__art">
        <Poster movie={movie} eager={eager} />
        {movie.user.played && (
          <span className="poster-card__watched" title="Watched">
            <Icon name="check" size={14} />
          </span>
        )}
        {!movie.available && <span className="poster-card__flag">Missing file</span>}
        {badge}
        {isInProgress(movie) && (
          <div className="poster-card__progress">
            <ProgressBar value={movie.user.progress} />
          </div>
        )}
      </div>
      <div className="poster-card__meta">
        <span className="poster-card__title">{movie.title}</span>
        <span className="poster-card__sub">
          {[movie.year, runtime].filter(Boolean).join(' · ') || ' '}
        </span>
      </div>
    </Link>
  );
}

export function ContinueCard({ movie }: { movie: Movie }) {
  const left = timeLeft(movie.runtimeMinutes, movie.user.positionSeconds);
  return (
    <div className="continue-card">
      <Link
        to={playHref(movie, movie.user.positionSeconds)}
        className="continue-card__art"
        aria-label={`Resume ${movie.title}`}
      >
        <Backdrop
          url={movie.images.backdrop ?? movie.images.poster}
          sizes="(max-width: 900px) 72vw, 380px"
          widths={[400, 640, 960]}
        />
        <span className="continue-card__play">
          <Icon name="play" size={22} />
        </span>
        <div className="continue-card__progress">
          <ProgressBar value={movie.user.progress} />
        </div>
      </Link>
      <Link to={`/movie/${movie.id}`} className="continue-card__meta">
        <span className="continue-card__title">{movie.title}</span>
        <span className="continue-card__sub">{left ?? 'In progress'}</span>
      </Link>
    </div>
  );
}

export function PosterGrid({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="poster-grid" aria-label={label}>
      {children}
    </ul>
  );
}

export function PosterGridSkeleton({ count = 18 }: { count?: number }) {
  return (
    <ul className="poster-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i}>
          <Skeleton className="skeleton--poster" />
          <Skeleton className="skeleton--line" />
        </li>
      ))}
    </ul>
  );
}

// -----------------------------------------------------------------------------
// Horizontal row

export function Row({
  title,
  href,
  children,
  wide,
  id,
}: {
  title: string;
  href?: string;
  children: ReactNode;
  wide?: boolean;
  id?: string;
}) {
  const scroller = useRef<HTMLUListElement>(null);
  const scrollBy = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };
  const headingId = id ? `row-${id}` : undefined;
  return (
    <section className="row" aria-labelledby={headingId}>
      <header className="row__header">
        <h2 className="row__title" id={headingId}>
          {href ? (
            <Link to={href} className="row__title-link">
              {title}
              <Icon name="chevronRight" size={18} />
            </Link>
          ) : (
            title
          )}
        </h2>
        <div className="row__nav">
          <IconButton
            icon="chevronLeft"
            label={`Scroll ${title} left`}
            onClick={() => scrollBy(-1)}
          />
          <IconButton
            icon="chevronRight"
            label={`Scroll ${title} right`}
            onClick={() => scrollBy(1)}
          />
        </div>
      </header>
      <ul ref={scroller} className={`row__track ${wide ? 'row__track--wide' : ''}`}>
        {children}
      </ul>
    </section>
  );
}
