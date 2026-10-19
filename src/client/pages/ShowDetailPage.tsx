import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { episodeLabel } from '../../shared/episodes';
import type { Episode, ShowDetail } from '../../shared/types';
import { PersonPhoto } from '../components/PersonPhoto';
import { Backdrop, Poster, Row } from '../components/movies';
import {
  episodePlay,
  episodePlayHref,
  EpisodeItem,
  isEpisodeInProgress,
} from '../components/shows';
import { useToast } from '../components/Toasts';
import { Button, ButtonLink, PageLoader, ProgressBar, StatusView } from '../components/ui';
import { ApiError, errorMessage } from '../lib/api';
import { plural, timeLeft } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { useShow, useToggleEpisodePlayed } from '../lib/queries';

/** Seasons in order, with Specials (season 0) last. */
function seasonOrder(show: ShowDetail) {
  const key = (n: number | null) => (n === 0 ? 2000 : (n ?? 1000));
  return [...show.seasons].sort((a, b) => key(a.number) - key(b.number));
}

function episodesOf(show: ShowDetail, seasonId: string, seasonNumber: number | null) {
  return show.episodes.filter((e) =>
    e.seasonId ? e.seasonId === seasonId : e.seasonNumber === seasonNumber,
  );
}

export function ShowDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const show = useShow(id);
  const watched = useToggleEpisodePlayed();
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  useDocumentTitle(show.data?.title);

  if (show.isPending) return <PageLoader label="Loading show" />;
  if (show.isError) {
    const missing = show.error instanceof ApiError && show.error.status === 404;
    return (
      <div className="page">
        <StatusView
          icon={missing ? 'tv' : 'offline'}
          tone={missing ? 'neutral' : 'error'}
          title={missing ? 'Show not found' : 'This show could not be loaded'}
          action={
            missing ? (
              <ButtonLink to="/shows" variant="primary">
                All TV shows
              </ButtonLink>
            ) : (
              <Button variant="primary" icon="refresh" onClick={() => show.refetch()}>
                Try again
              </Button>
            )
          }
        >
          <p>{errorMessage(show.error)}</p>
        </StatusView>
      </div>
    );
  }

  const s = show.data;
  const seasons = seasonOrder(s);
  // Open on the season asked for, else the one with the next episode, else the first.
  const selected =
    seasons.find((x) => x.id === params.get('season')) ??
    seasons.find((x) => x.id === s.nextUp?.seasonId) ??
    seasons.find((x) => x.number === s.nextUp?.seasonNumber) ??
    seasons[0];
  const episodes = selected ? episodesOf(s, selected.id, selected.number) : s.episodes;
  const next = s.nextUp;
  const firstPlayable = s.episodes.find((e) => e.available);
  const years = s.year
    ? s.endYear && s.endYear !== s.year
      ? `${s.year}–${s.endYear}`
      : s.endYear
        ? String(s.year)
        : `${s.year}–`
    : null;

  const toggle = (e: Episode) => {
    setPending(e.id);
    watched.mutate(
      { id: e.id, played: !e.user.played },
      {
        onSuccess: (state) =>
          toast.show(
            `${episodeLabel(e) || e.title} marked as ${state.played ? 'watched' : 'unwatched'}`,
          ),
        onError: (error) => toast.show(errorMessage(error), 'error'),
        onSettled: () => setPending(null),
      },
    );
  };

  return (
    <article className="detail show-detail route-enter">
      <div className="detail__hero">
        <Backdrop
          url={s.images.backdrop}
          eager
          className="detail__backdrop"
          widths={[640, 960, 1440, 1920, 2560]}
        />
        <div className="detail__scrim" />
      </div>
      <div className="detail__body">
        <div className="detail__poster">
          <Poster movie={s} eager sizes="(max-width: 900px) 40vw, 300px" />
        </div>
        <div className="detail__main">
          <h1 className="detail__title display">{s.title}</h1>
          <p className="meta-line">
            {[
              years,
              s.officialRating,
              s.seasonCount ? plural(s.seasonCount, 'season') : null,
              s.episodeCount ? plural(s.episodeCount, 'episode') : null,
              ...s.genres.slice(0, 3),
            ]
              .filter(Boolean)
              .map((part, i) => (
                <span key={i}>{part}</span>
              ))}
          </p>

          {next && isEpisodeInProgress(next) && (
            <div className="detail__progress">
              <ProgressBar value={next.user.progress} />
              <span>{timeLeft(next.runtimeMinutes, next.user.positionSeconds)}</span>
            </div>
          )}

          <div className="detail__actions">
            {next ? (
              <ButtonLink to={episodePlay(next).href} variant="primary" size="lg" icon="play">
                {episodePlay(next).label} {episodeLabel(next)}
              </ButtonLink>
            ) : (
              firstPlayable && (
                <ButtonLink
                  to={episodePlayHref(firstPlayable)}
                  variant="primary"
                  size="lg"
                  icon="refresh"
                >
                  Watch again from {episodeLabel(firstPlayable) || 'the start'}
                </ButtonLink>
              )
            )}
          </div>

          <p className="detail__status faint">
            {next
              ? `${isEpisodeInProgress(next) ? 'Watching' : 'Up next'}: ${episodeLabel(next)} “${next.title}”${s.unwatchedCount > 1 ? ` · ${s.unwatchedCount} unwatched` : ''}`
              : s.episodeCount
                ? 'All watched'
                : 'No episodes in your library yet'}
          </p>

          {s.overview ? (
            <p className="detail__overview">{s.overview}</p>
          ) : (
            <p className="detail__overview faint">No synopsis is available for this show.</p>
          )}
        </div>
      </div>

      <div className="detail__sections">
        <section className="seasons" aria-labelledby="episodes-title">
          <header className="seasons__header">
            <h2 id="episodes-title" className="row__title">
              Episodes
            </h2>
            {seasons.length > 1 && (
              <div className="seasons__tabs" role="tablist" aria-label="Seasons">
                {seasons.map((season) => (
                  <button
                    key={season.id}
                    type="button"
                    role="tab"
                    aria-selected={season.id === selected?.id}
                    className={`chip ${season.id === selected?.id ? 'chip--selected' : ''}`}
                    onClick={() => {
                      const nextParams = new URLSearchParams(params);
                      nextParams.set('season', season.id);
                      setParams(nextParams, { replace: true });
                    }}
                  >
                    <span>{season.name}</span>
                    {season.unwatchedCount > 0 && season.unwatchedCount < season.episodeCount && (
                      <span className="chip__count" title={`${season.unwatchedCount} unwatched`}>
                        {season.unwatchedCount}
                      </span>
                    )}
                    {season.episodeCount > 0 && season.unwatchedCount === 0 && (
                      <span className="visually-hidden"> (watched)</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </header>
          {episodes.length === 0 ? (
            <p className="faint">No episodes of this season are in your library.</p>
          ) : (
            <ol className="episodes" role="tabpanel" aria-label={selected?.name ?? 'Episodes'}>
              {episodes.map((e) => (
                <EpisodeItem
                  key={e.id}
                  episode={e}
                  isNext={e.id === next?.id}
                  busy={pending === e.id}
                  onToggleWatched={() => toggle(e)}
                />
              ))}
            </ol>
          )}
        </section>

        {s.cast.length > 0 && (
          <Row title="Cast" id="cast">
            {s.cast.map((person) => (
              <li key={`${person.name}-${person.role}`} className="person">
                <div className="person__link">
                  <PersonPhoto name={person.name} image={person.image} />
                  <span className="person__name">{person.name}</span>
                  {person.role && <span className="person__role">{person.role}</span>}
                </div>
              </li>
            ))}
          </Row>
        )}
      </div>
    </article>
  );
}
