import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Movie, Preferences } from '../../shared/types';
import { formatRuntime, timeLeft } from '../lib/format';
import { usePrefersReducedMotion } from '../lib/hooks';
import { Backdrop, isInProgress, playHref, primaryPlay } from './movies';
import { TitleArt } from './MovieExtras';
import { ButtonLink, ProgressBar } from './ui';

const EYEBROW: Record<Preferences['heroSource'], string> = {
  recentlyAdded: 'Recently added',
  random: 'Tonight’s feature',
  favorites: 'From your favorites',
  continueWatching: 'Pick up where you left off',
};

export function MetaLine({ movie, extra }: { movie: Movie; extra?: boolean }) {
  const parts = [
    movie.year ? String(movie.year) : null,
    formatRuntime(movie.runtimeMinutes),
    movie.officialRating,
    ...(extra ? movie.genres.slice(0, 3) : []),
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className="meta-line">
      {parts.map((part, i) => (
        <span key={i}>{part}</span>
      ))}
    </p>
  );
}

export function Hero({ movies, prefs }: { movies: Movie[]; prefs: Preferences }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = usePrefersReducedMotion();
  const count = movies.length;

  // Moves on every 9 seconds; a swipe or a dot restarts the wait.
  useEffect(() => {
    if (count < 2 || paused || reduced) return;
    const id = window.setTimeout(() => setIndex((i) => (i + 1) % count), 9000);
    return () => window.clearTimeout(id);
  }, [count, paused, reduced, index]);

  // Swiping with a finger (or pen): left for the next title, right for the previous.
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const swiped = useRef(false);
  const [drag, setDrag] = useState(0);
  const go = (step: number) => setIndex((i) => (i + step + count) % count);
  const onPointerDown = (e: PointerEvent) => {
    if (count < 2 || e.pointerType === 'mouse') return;
    swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    swiped.current = false;
  };
  const onPointerMove = (e: PointerEvent) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    // A mostly-vertical move is the page scrolling: leave it alone.
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
      swipe.current = null;
      setDrag(0);
      return;
    }
    if (Math.abs(dx) > 10) swiped.current = true;
    setDrag(dx);
  };
  const onPointerEnd = (e: PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    setDrag(0);
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) >= 50) go(dx < 0 ? 1 : -1);
  };

  const movie = movies[Math.min(index, count - 1)];
  if (!movie) return null;
  const play = primaryPlay(movie, prefs.playback.resumeBehavior);
  const showRestart = isInProgress(movie) && prefs.playback.resumeBehavior === 'ask';

  return (
    <section
      className="hero"
      aria-roledescription="carousel"
      aria-label="Featured"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      // A swipe that ends over a button shouldn't also press it.
      onClickCapture={(e) => {
        if (swiped.current) {
          e.preventDefault();
          e.stopPropagation();
          swiped.current = false;
        }
      }}
    >
      <div className="hero__media">
        {movies.map((m, i) => (
          <Backdrop
            key={m.id}
            url={m.images.backdrop ?? m.images.poster}
            eager={i === 0}
            className={`hero__backdrop ${i === index ? 'is-active' : ''}`}
            widths={[640, 960, 1440, 1920, 2560]}
          />
        ))}
        <div className="hero__scrim" />
      </div>
      <div
        className={`hero__content ${drag ? 'is-dragging' : ''}`}
        key={movie.id}
        aria-live="polite"
        style={
          drag
            ? {
                transform: `translateX(${drag * 0.4}px)`,
                opacity: Math.max(0.35, 1 - Math.abs(drag) / 400),
              }
            : undefined
        }
      >
        <p className="eyebrow hero__eyebrow">{EYEBROW[prefs.heroSource]}</p>
        <TitleArt movie={movie} className="hero__title" />
        <MetaLine movie={movie} extra />
        {movie.overview && <p className="hero__overview">{movie.overview}</p>}
        {isInProgress(movie) && (
          <div className="hero__progress">
            <ProgressBar value={movie.user.progress} />
            <span>{timeLeft(movie.runtimeMinutes, movie.user.positionSeconds)}</span>
          </div>
        )}
        <div className="hero__actions">
          {movie.available && (
            <ButtonLink to={play.href} variant="primary" size="lg" icon="play">
              {play.label}
            </ButtonLink>
          )}
          {showRestart && (
            <ButtonLink to={playHref(movie, 0)} variant="secondary" size="lg" icon="refresh">
              Start over
            </ButtonLink>
          )}
          <ButtonLink to={`/movie/${movie.id}`} variant="ghost" size="lg" icon="info">
            More info
          </ButtonLink>
        </div>
      </div>
      {count > 1 && (
        <div className="hero__dots" role="tablist" aria-label="Featured titles">
          {movies.map((m, i) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={m.title}
              className="hero__dot"
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function HeroSkeleton() {
  return (
    <section className="hero hero--loading" aria-hidden="true">
      <div className="hero__content">
        <div className="skeleton skeleton--line" style={{ width: 120 }} />
        <div className="skeleton" style={{ width: 'min(520px, 80%)', height: 64, marginTop: 16 }} />
        <div className="skeleton skeleton--line" style={{ width: 260, marginTop: 16 }} />
        <div className="skeleton" style={{ width: 'min(480px, 90%)', height: 60, marginTop: 16 }} />
      </div>
    </section>
  );
}
