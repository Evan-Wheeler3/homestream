import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { MovieDetail, Preferences } from '../../shared/types';
import { AddToCollectionDialog } from '../components/AddToCollectionDialog';
import { MetaLine } from '../components/Hero';
import { RatingBadges, TitleArt, TrailerButton } from '../components/MovieExtras';
import { Icon } from '../components/Icon';
import {
  Backdrop,
  isInProgress,
  playHref,
  Poster,
  PosterCard,
  primaryPlay,
  Row,
} from '../components/movies';
import { useToast } from '../components/Toasts';
import {
  Button,
  ButtonLink,
  IconButton,
  PageLoader,
  ProgressBar,
  StarRating,
  StatusView,
} from '../components/ui';
import { ApiError, errorMessage } from '../lib/api';
import {
  formatBytes,
  formatRuntime,
  languageName,
  relativeTime,
  resolutionLabel,
  timeLeft,
} from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { sizedImage } from '../lib/images';
import {
  useMovie,
  useSavePersonal,
  useSimilar,
  useToggleFavorite,
  useToggleWatchlist,
  useTogglePlayed,
} from '../lib/queries';

function browseLink(key: string, value: string) {
  return `/browse?${key}=${encodeURIComponent(value)}`;
}

/** Names that open the person's page. */
function PeopleLinks({ names }: { names: string[] }) {
  return (
    <>
      {names.map((name, i) => (
        <span key={name}>
          {i > 0 && ', '}
          <Link to={`/person/${encodeURIComponent(name)}`} className="text-link">
            {name}
          </Link>
        </span>
      ))}
    </>
  );
}

function LinkList({ items, param }: { items: string[]; param: string }) {
  return (
    <>
      {items.map((item, i) => (
        <span key={item}>
          {i > 0 && ', '}
          <Link to={browseLink(param, item)} className="text-link">
            {item}
          </Link>
        </span>
      ))}
    </>
  );
}

function PersonalPanel({ movie }: { movie: MovieDetail }) {
  const save = useSavePersonal(movie.id);
  const toast = useToast();
  const [notes, setNotes] = useState(movie.personal.notes);
  // Pick up notes saved elsewhere (another device / refetch) without an effect.
  const [savedNotes, setSavedNotes] = useState(movie.personal.notes);
  if (movie.personal.notes !== savedNotes) {
    setSavedNotes(movie.personal.notes);
    setNotes(movie.personal.notes);
  }
  const dirty = notes !== movie.personal.notes;

  const saveNotes = () => {
    if (!dirty) return;
    save.mutate({ notes }, { onError: (e) => toast.show(errorMessage(e), 'error') });
  };

  return (
    <section className="detail-panel" aria-labelledby="personal-title">
      <h2 id="personal-title" className="detail-panel__title">
        My rating &amp; notes
      </h2>
      <StarRating
        value={movie.personal.rating}
        disabled={save.isPending}
        onChange={(rating) =>
          save.mutate({ rating }, { onError: (e) => toast.show(errorMessage(e), 'error') })
        }
      />
      <label htmlFor="notes" className="visually-hidden">
        Personal notes
      </label>
      <textarea
        id="notes"
        className="input textarea"
        rows={4}
        maxLength={5000}
        placeholder="Private notes — what you thought, who recommended it, favorite scenes…"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={saveNotes}
      />
      <div className="detail-panel__footer">
        <span className="faint" aria-live="polite">
          {save.isPending
            ? 'Saving…'
            : dirty
              ? 'Unsaved changes'
              : movie.personal.updatedAt
                ? `Saved ${relativeTime(movie.personal.updatedAt)}`
                : 'Only you can see this'}
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={saveNotes}
          disabled={!dirty}
          busy={save.isPending}
        >
          Save notes
        </Button>
      </div>
    </section>
  );
}

function MediaInfoPanel({ movie }: { movie: MovieDetail }) {
  const info = movie.mediaInfo;
  if (!info) return null;
  const rows: [string, string | null][] = [
    [
      'Format',
      [
        info.container?.toUpperCase(),
        info.videoCodec?.toUpperCase(),
        resolutionLabel(info.width, info.height),
      ]
        .filter(Boolean)
        .join(' · ') || null,
    ],
    ['File size', formatBytes(info.sizeBytes)],
    ['Audio', info.audioTracks.map((a) => a.title).join(', ') || null],
    [
      'Subtitles',
      info.subtitleTracks.map((s) => languageName(s.language) ?? s.title).join(', ') || 'None',
    ],
  ];
  return (
    <dl className="facts">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="facts__row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

export function MovieDetailPage({ prefs }: { prefs: Preferences }) {
  const { id = '' } = useParams();
  const movie = useMovie(id);
  const similar = useSimilar(id);
  const favorite = useToggleFavorite(id);
  const watchlist = useToggleWatchlist(id);
  const played = useTogglePlayed(id);
  const toast = useToast();
  const [addOpen, setAddOpen] = useState(false);
  useDocumentTitle(movie.data?.title);

  if (movie.isPending) return <PageLoader label="Loading movie" />;
  if (movie.isError) {
    const missing = movie.error instanceof ApiError && movie.error.status === 404;
    return (
      <div className="page">
        <StatusView
          icon={missing ? 'film' : 'offline'}
          tone={missing ? 'neutral' : 'error'}
          title={missing ? 'Movie not found' : 'This movie could not be loaded'}
          action={
            missing ? (
              <ButtonLink to="/browse" variant="primary">
                Browse the library
              </ButtonLink>
            ) : (
              <Button variant="primary" icon="refresh" onClick={() => movie.refetch()}>
                Try again
              </Button>
            )
          }
        >
          <p>{errorMessage(movie.error)}</p>
        </StatusView>
      </div>
    );
  }

  const m = movie.data;
  const play = primaryPlay(m, prefs.playback.resumeBehavior);
  const resumable = isInProgress(m);
  const facts: [string, React.ReactNode][] = [];
  if (m.directors.length)
    facts.push([
      m.directors.length > 1 ? 'Directors' : 'Director',
      <PeopleLinks names={m.directors} />,
    ]);
  if (m.writers.length) facts.push(['Writers', m.writers.join(', ')]);
  if (m.genres.length) facts.push(['Genres', <LinkList items={m.genres} param="genre" />]);
  if (m.countries.length) facts.push(['Country', <LinkList items={m.countries} param="country" />]);
  if (m.studios.length) facts.push(['Studio', m.studios.join(', ')]);
  if (m.originalTitle) facts.push(['Original title', m.originalTitle]);
  if (m.premiereDate)
    facts.push([
      'Released',
      new Date(m.premiereDate).toLocaleDateString(undefined, { dateStyle: 'long' }),
    ]);
  if (m.communityRating != null)
    facts.push(['Community rating', `${m.communityRating.toFixed(1)} / 10`]);
  if (m.criticRating != null) facts.push(['Critics', `${m.criticRating}%`]);
  if (m.tags.length) facts.push(['Tags', <LinkList items={m.tags} param="tag" />]);
  if (m.dateAdded)
    facts.push([
      'Added',
      new Date(m.dateAdded).toLocaleDateString(undefined, { dateStyle: 'medium' }),
    ]);

  const toggleFavorite = () =>
    favorite.mutate(!m.user.favorite, {
      onSuccess: (state) =>
        toast.show(state.favorite ? 'Added to favorites' : 'Removed from favorites'),
      onError: (e) => toast.show(errorMessage(e), 'error'),
    });
  const toggleWatched = () =>
    played.mutate(!m.user.played, {
      onSuccess: (state) => toast.show(state.played ? 'Marked as watched' : 'Marked as unwatched'),
      onError: (e) => toast.show(errorMessage(e), 'error'),
    });

  return (
    <article className="detail route-enter">
      <div className="detail__hero">
        <Backdrop
          url={m.images.backdrop}
          eager
          className="detail__backdrop"
          widths={[640, 960, 1440, 1920, 2560]}
        />
        <div className="detail__scrim" />
      </div>
      <div className="detail__body">
        <div className="detail__poster">
          <Poster movie={m} eager sizes="(max-width: 900px) 40vw, 300px" />
        </div>
        <div className="detail__main">
          <TitleArt movie={m} className="detail__title" />
          <MetaLine movie={m} />
          <RatingBadges movie={m} />
          {m.tagline && <p className="detail__tagline">{m.tagline}</p>}

          {!m.available && (
            <p className="notice notice--warning" role="status">
              <Icon name="alert" size={18} /> Jellyfin lists this movie but its file is missing, so
              it can’t be played.
            </p>
          )}

          {resumable && (
            <div className="detail__progress">
              <ProgressBar value={m.user.progress} />
              <span>{timeLeft(m.runtimeMinutes, m.user.positionSeconds)}</span>
            </div>
          )}

          <div className="detail__actions">
            {m.available && (
              <ButtonLink to={play.href} variant="primary" size="lg" icon="play">
                {play.label}
              </ButtonLink>
            )}
            {m.available && resumable && prefs.playback.resumeBehavior !== 'restart' && (
              <ButtonLink to={playHref(m, 0)} variant="secondary" size="lg" icon="refresh">
                Start over
              </ButtonLink>
            )}
            {m.available && resumable && prefs.playback.resumeBehavior === 'restart' && (
              <ButtonLink to={playHref(m, m.user.positionSeconds)} variant="secondary" size="lg">
                Resume
              </ButtonLink>
            )}
            <TrailerButton trailers={m.trailers} title={m.title} />
            <IconButton
              icon={m.onWatchlist ? 'bookmarkFilled' : 'bookmark'}
              label={m.onWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
              pressed={m.onWatchlist}
              variant="outline"
              size={22}
              className={m.onWatchlist ? 'is-favorite' : ''}
              onClick={() =>
                watchlist.mutate(!m.onWatchlist, {
                  onSuccess: (r) =>
                    toast.show(
                      r.onWatchlist ? 'Added to your watchlist' : 'Removed from your watchlist',
                    ),
                  onError: (e) => toast.show(errorMessage(e), 'error'),
                })
              }
            />
            <IconButton
              icon={m.user.favorite ? 'heartFilled' : 'heart'}
              label={m.user.favorite ? 'Remove from favorites' : 'Add to favorites'}
              pressed={m.user.favorite}
              variant="outline"
              size={22}
              className={m.user.favorite ? 'is-favorite' : ''}
              onClick={toggleFavorite}
              disabled={favorite.isPending}
            />
            <IconButton
              icon={m.user.played ? 'eyeOff' : 'eye'}
              label={m.user.played ? 'Mark as unwatched' : 'Mark as watched'}
              pressed={m.user.played}
              variant="outline"
              size={22}
              onClick={toggleWatched}
              disabled={played.isPending}
            />
            <IconButton
              icon="plus"
              label="Add to collection"
              variant="outline"
              size={22}
              onClick={() => setAddOpen(true)}
            />
          </div>

          <p className="detail__status faint">
            {m.user.played
              ? `Watched${m.user.lastPlayed ? ` ${relativeTime(m.user.lastPlayed)}` : ''}${m.user.playCount > 1 ? ` · ${m.user.playCount} plays` : ''}`
              : resumable
                ? `In progress · stopped at ${formatRuntime(Math.round(m.user.positionSeconds / 60)) ?? 'the start'}`
                : 'Not watched yet'}
          </p>

          {m.overview ? (
            <p className="detail__overview">{m.overview}</p>
          ) : (
            <p className="detail__overview faint">No synopsis is available for this movie.</p>
          )}

          {m.collections.length > 0 && (
            <div className="detail__collections">
              <span className="eyebrow">In your collections</span>
              <div className="chip-list">
                {m.collections.map((c) => (
                  <Link key={c.id} to={`/collections/${c.id}`} className="chip">
                    {c.name}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="detail__sections">
        {m.cast.length > 0 && (
          <Row title="Cast" id="cast">
            {m.cast.map((person) => (
              <li key={`${person.name}-${person.role}`} className="person">
                <Link
                  className="person__link"
                  to={`/person/${encodeURIComponent(person.name)}`}
                  state={person.image ? { photo: person.image } : undefined}
                >
                  <span className="person__photo">
                    {person.image ? (
                      <img
                        src={sizedImage(person.image, 200)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span aria-hidden="true">
                        {person.name
                          .split(/\s+/)
                          .map((p) => p[0])
                          .slice(0, 2)
                          .join('')}
                      </span>
                    )}
                  </span>
                  <span className="person__name">{person.name}</span>
                  {person.role && <span className="person__role">{person.role}</span>}
                </Link>
              </li>
            ))}
          </Row>
        )}

        <div className="detail__grid">
          <section className="detail-panel" aria-labelledby="about-title">
            <h2 id="about-title" className="detail-panel__title">
              About
            </h2>
            {facts.length ? (
              <dl className="facts">
                {facts.map(([label, value]) => (
                  <div key={label} className="facts__row">
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="faint">Jellyfin has no further details for this movie.</p>
            )}
            <MediaInfoPanel movie={m} />
            {m.externalLinks.length > 0 && (
              <p className="detail__links">
                {m.externalLinks.map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-link"
                  >
                    {link.name}
                  </a>
                ))}
              </p>
            )}
          </section>
          <PersonalPanel movie={m} />
        </div>

        {similar.data && similar.data.length > 0 && (
          <Row title="More like this" id="similar">
            {similar.data.map((s) => (
              <li key={s.id}>
                <PosterCard movie={s} />
              </li>
            ))}
          </Row>
        )}
      </div>

      <AddToCollectionDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        movieId={m.id}
        movieTitle={m.title}
        memberOf={m.collections.map((c) => c.id)}
      />
    </article>
  );
}
