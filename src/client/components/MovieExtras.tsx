import { useState } from 'react';
import type { Movie, Trailer } from '../../shared/types';
import { sizedImage } from '../lib/images';
import { Icon } from './Icon';
import { Button, Dialog } from './ui';

/**
 * The movie's title-logo art when Jellyfin has one (much like the big
 * streaming apps), otherwise the title in the display typeface.
 */
export function TitleArt({
  movie,
  className,
  as: Tag = 'h1',
}: {
  movie: Pick<Movie, 'title' | 'images'>;
  className: string;
  as?: 'h1' | 'h2';
}) {
  const [failed, setFailed] = useState(false);
  const logo = movie.images.logo;
  if (!logo || failed) return <Tag className={`${className} display`}>{movie.title}</Tag>;
  return (
    <Tag className={`${className} title-logo`}>
      <img src={sizedImage(logo, 800) ?? logo} alt={movie.title} onError={() => setFailed(true)} />
    </Tag>
  );
}

/** Community or IMDb (★ out of 10) and critics (% positive) scores, when known. */
export function RatingBadges({
  movie,
}: {
  movie: Pick<Movie, 'communityRating' | 'criticRating' | 'ratingSource'>;
}) {
  if (movie.communityRating == null && movie.criticRating == null) return null;
  const fresh = movie.criticRating != null && movie.criticRating >= 60;
  return (
    <p className="ratings">
      {movie.communityRating != null && (
        <span
          className="rating"
          title={
            movie.ratingSource === 'IMDb'
              ? 'IMDb rating (out of 10)'
              : 'Audience rating (out of 10)'
          }
        >
          <Icon name="starFilled" size={15} />
          <strong>{movie.communityRating.toFixed(1)}</strong>
          <span className="visually-hidden"> out of 10</span>
          {movie.ratingSource === 'IMDb' && <span className="rating__source">IMDb</span>}
        </span>
      )}
      {movie.criticRating != null && (
        <span
          className={`rating rating--critics ${fresh ? 'is-fresh' : 'is-rotten'}`}
          title={fresh ? 'Critics: mostly positive' : 'Critics: mostly negative'}
        >
          <span className="rating__dot" aria-hidden="true" />
          <strong>{movie.criticRating}%</strong> critics
        </span>
      )}
    </p>
  );
}

/** "Trailer" button and player. YouTube trailers use the privacy-enhanced player. */
export function TrailerButton({ trailers, title }: { trailers: Trailer[]; title: string }) {
  const [open, setOpen] = useState<Trailer | null>(null);
  const first = trailers[0];
  if (!first) return null;
  if (first.kind === 'link') {
    return (
      <a className="btn btn--secondary btn--lg" href={first.url} target="_blank" rel="noreferrer">
        <Icon name="film" size={20} />
        Trailer
      </a>
    );
  }
  return (
    <>
      <Button variant="secondary" size="lg" icon="film" onClick={() => setOpen(first)}>
        Trailer
      </Button>
      <Dialog
        open={open != null}
        onClose={() => setOpen(null)}
        title={`${title} · Trailer`}
        size="lg"
      >
        {open && (
          <div className="trailer">
            {open.kind === 'youtube' && open.embedUrl ? (
              <iframe
                src={open.embedUrl}
                title={`${title} trailer`}
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            ) : (
              <video src={open.url} controls autoPlay playsInline aria-label={`${title} trailer`} />
            )}
          </div>
        )}
        {trailers.length > 1 && (
          <div className="chip-list trailer__list">
            {trailers.map((t) => (
              <button
                key={t.url}
                type="button"
                className={`chip ${open?.url === t.url ? 'chip--selected' : ''}`}
                onClick={() => setOpen(t)}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}
      </Dialog>
    </>
  );
}
