import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import type { FranchiseDetail } from '../../shared/types';
import { PosterCard, PosterGrid, PosterGridSkeleton } from '../components/movies';
import { ButtonLink, StatusView } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { sizedImage } from '../lib/images';

/** A film series (a Jellyfin collection), in release order. */
export function FranchisePage() {
  const { id = '' } = useParams();
  const franchise = useQuery({
    queryKey: ['franchise', id],
    queryFn: () => api<FranchiseDetail>(`/franchises/${encodeURIComponent(id)}`),
  });

  if (franchise.isPending) {
    return (
      <div className="page">
        <PosterGridSkeleton count={6} />
      </div>
    );
  }
  if (franchise.isError) {
    return (
      <div className="page">
        <StatusView icon="film" title="Film series">
          <p>{errorMessage(franchise.error)}</p>
        </StatusView>
      </div>
    );
  }
  const f = franchise.data;
  const next =
    f.movies.find((m) => m.user.positionSeconds > 0 && !m.user.played) ??
    f.movies.find((m) => !m.user.played && m.available);
  const watched = f.movies.filter((m) => m.user.played).length;
  const years = f.movies.map((m) => m.year).filter((y): y is number => y != null);
  const span =
    years.length > 0
      ? years[0] === years.at(-1)
        ? `${years[0]}`
        : `${years[0]}–${years.at(-1)}`
      : null;

  return (
    <div className="page franchise-page route-enter">
      {f.backdrop && (
        <div className="franchise-page__backdrop" aria-hidden="true">
          <img src={sizedImage(f.backdrop, 1600)} alt="" />
        </div>
      )}
      <header className="franchise-page__header">
        <span className="eyebrow">Film series</span>
        <h1 className="page-title">{f.name}</h1>
        <p className="franchise-page__meta">
          {[plural(f.movies.length, 'film'), span, `${watched} of ${f.movies.length} watched`]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {next && (
          <ButtonLink to={`/movie/${next.id}`} variant="primary" icon="play" data-tv-focus="">
            {next.user.positionSeconds > 0 ? 'Continue' : watched > 0 ? 'Up next' : 'Start'}:{' '}
            {next.title}
          </ButtonLink>
        )}
      </header>
      <PosterGrid label={`${f.name}, in release order`}>
        {f.movies.map((m) => (
          <li key={m.id}>
            <PosterCard movie={m} />
          </li>
        ))}
      </PosterGrid>
    </div>
  );
}
