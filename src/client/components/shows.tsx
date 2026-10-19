import { Link } from 'react-router';
import { episodeLabel } from '../../shared/episodes';
import type { Episode, Show } from '../../shared/types';
import { formatRuntime, plural, timeLeft } from '../lib/format';
import { Icon } from './Icon';
import { Backdrop, Poster } from './movies';
import { IconButton, ProgressBar } from './ui';

export function isEpisodeInProgress(e: Episode) {
  return e.user.positionSeconds > 0 && !e.user.played;
}

export function episodePlayHref(e: Episode, startSeconds = 0) {
  return `/play/episode/${e.id}?t=${Math.max(0, Math.floor(startSeconds))}`;
}

/** Resume an episode that's part-watched, otherwise play it from the start. */
export function episodePlay(e: Episode) {
  return isEpisodeInProgress(e)
    ? { label: 'Resume', href: episodePlayHref(e, e.user.positionSeconds) }
    : { label: 'Play', href: episodePlayHref(e) };
}

/** "S1 E3 · Fog Bell" */
export function episodeName(e: Episode) {
  const label = episodeLabel(e);
  return label ? `${label} · ${e.title}` : e.title;
}

export function ShowCard({ show, eager }: { show: Show; eager?: boolean }) {
  const years = show.year
    ? show.endYear && show.endYear !== show.year
      ? `${show.year}–${show.endYear}`
      : String(show.year)
    : null;
  const allWatched = show.episodeCount > 0 && show.unwatchedCount === 0;
  return (
    <Link to={`/show/${show.id}`} className="poster-card" aria-label={show.title}>
      <div className="poster-card__art">
        <Poster movie={show} eager={eager} />
        {allWatched ? (
          <span className="poster-card__watched" title="All watched">
            <Icon name="check" size={14} />
          </span>
        ) : (
          show.unwatchedCount > 0 &&
          show.unwatchedCount < show.episodeCount && (
            <span className="poster-card__count" title={`${show.unwatchedCount} unwatched`}>
              {show.unwatchedCount}
            </span>
          )
        )}
      </div>
      <div className="poster-card__meta">
        <span className="poster-card__title">{show.title}</span>
        <span className="poster-card__sub">
          {[years, show.seasonCount ? plural(show.seasonCount, 'season') : null]
            .filter(Boolean)
            .join(' · ') || ' '}
        </span>
      </div>
    </Link>
  );
}

/** A wide card in the "Next up" row: plays straight away. */
export function NextUpCard({ episode }: { episode: Episode }) {
  const resuming = isEpisodeInProgress(episode);
  const play = episodePlay(episode);
  return (
    <div className="continue-card">
      <Link
        to={play.href}
        className="continue-card__art"
        aria-label={`${play.label} ${episode.showTitle}, ${episodeName(episode)}`}
      >
        <Backdrop
          url={episode.image}
          sizes="(max-width: 900px) 72vw, 380px"
          widths={[400, 640, 960]}
        />
        {!episode.image && (
          <span className="continue-card__fallback-title" aria-hidden="true">
            {episode.showTitle}
          </span>
        )}
        <span className="continue-card__play">
          <Icon name="play" size={22} />
        </span>
        {resuming && (
          <div className="continue-card__progress">
            <ProgressBar value={episode.user.progress} />
          </div>
        )}
      </Link>
      <Link to={`/show/${episode.showId}`} className="continue-card__meta">
        <span className="continue-card__title">{episode.showTitle}</span>
        <span className="continue-card__sub">
          {episodeName(episode)}
          {resuming && ` · ${timeLeft(episode.runtimeMinutes, episode.user.positionSeconds) ?? ''}`}
        </span>
      </Link>
    </div>
  );
}

/** One episode in a show's season list. */
export function EpisodeItem({
  episode,
  isNext,
  onToggleWatched,
  busy,
}: {
  episode: Episode;
  isNext: boolean;
  onToggleWatched: () => void;
  busy: boolean;
}) {
  const e = episode;
  const resuming = isEpisodeInProgress(e);
  const play = episodePlay(e);
  const runtime = formatRuntime(e.runtimeMinutes);
  const aired = e.premiereDate
    ? new Date(e.premiereDate).toLocaleDateString(undefined, { dateStyle: 'medium' })
    : null;
  return (
    <li
      className={`episode ${e.user.played ? 'episode--watched' : ''} ${isNext ? 'episode--next' : ''} ${e.available ? '' : 'episode--missing'}`}
    >
      {e.available ? (
        <Link
          to={play.href}
          className="episode__art"
          aria-label={`${play.label} ${episodeName(e)}`}
        >
          <Backdrop url={e.image} sizes="(max-width: 700px) 40vw, 240px" widths={[320, 480, 640]} />
          <span className="episode__play">
            <Icon name="play" size={20} />
          </span>
          {resuming && (
            <div className="episode__progress">
              <ProgressBar value={e.user.progress} />
            </div>
          )}
        </Link>
      ) : (
        <div className="episode__art" aria-hidden="true">
          <Backdrop url={e.image} sizes="(max-width: 700px) 40vw, 240px" widths={[320, 480, 640]} />
        </div>
      )}
      <div className="episode__body">
        <h3 className="episode__title">
          <span className="episode__number">{episodeLabel(e) || 'Episode'}</span> {e.title}
        </h3>
        <p className="episode__meta faint">
          {[
            runtime,
            aired,
            resuming ? timeLeft(e.runtimeMinutes, e.user.positionSeconds) : null,
            e.available ? null : 'Not in your library',
            isNext && !resuming ? 'Up next' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {e.overview && <p className="episode__overview">{e.overview}</p>}
      </div>
      {e.available && (
        <IconButton
          icon={e.user.played ? 'check' : 'eye'}
          label={
            e.user.played
              ? `Mark ${episodeName(e)} as unwatched`
              : `Mark ${episodeName(e)} as watched`
          }
          pressed={e.user.played}
          variant="outline"
          className={`episode__watched ${e.user.played ? 'is-watched' : ''}`}
          onClick={onToggleWatched}
          disabled={busy}
        />
      )}
    </li>
  );
}
