import { useQuery } from '@tanstack/react-query';
import { useLocation, useParams } from 'react-router';
import type { PersonPage as PersonData } from '../../shared/types';
import { PosterCard, PosterGrid, PosterGridSkeleton } from '../components/movies';
import { ButtonLink, StatusView } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { sizedImage } from '../lib/images';

/** A director's or actor's movies in your library. */
export function PersonPage() {
  const { name = '' } = useParams();
  // The cast row passes the person's photo along when there is one.
  const photo = (useLocation().state as { photo?: string } | null)?.photo;
  const person = useQuery({
    queryKey: ['person', name],
    queryFn: () => api<PersonData>(`/people/${encodeURIComponent(name)}`),
  });

  if (person.isPending) {
    return (
      <div className="page">
        <PosterGridSkeleton count={6} />
      </div>
    );
  }
  if (person.isError) {
    return (
      <div className="page">
        <StatusView icon="user" title={name}>
          <p>{errorMessage(person.error)}</p>
        </StatusView>
      </div>
    );
  }
  const p = person.data;
  const all = new Set([...p.directed, ...p.actedIn].map((m) => m.id)).size;
  const roles = [
    p.directed.length ? `Directed ${plural(p.directed.length, 'movie')}` : null,
    p.actedIn.length ? `acted in ${plural(p.actedIn.length, 'movie')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const spinParams = new URLSearchParams(
    p.directed.length >= p.actedIn.length ? { director: p.name } : { actor: p.name },
  );

  return (
    <div className="page person-page route-enter">
      <header className="person-page__header">
        <span className="person-page__photo" aria-hidden="true">
          {photo ? (
            <img src={sizedImage(photo, 320)} alt="" />
          ) : (
            p.name
              .split(/\s+/)
              .map((w) => w[0])
              .slice(0, 2)
              .join('')
          )}
        </span>
        <div>
          <h1 className="page-title">{p.name}</h1>
          <p className="person-page__roles">
            {roles.charAt(0).toUpperCase() + roles.slice(1)} in your library
          </p>
        </div>
        {all > 1 && (
          <ButtonLink to={`/spin?${spinParams}`} variant="secondary" icon="wheel">
            Spin their movies
          </ButtonLink>
        )}
      </header>

      {p.directed.length > 0 && (
        <section className="person-page__section" aria-labelledby="directed">
          <h2 id="directed" className="row__title">
            Directed
          </h2>
          <PosterGrid label={`Directed by ${p.name}`}>
            {p.directed.map((m) => (
              <li key={m.id}>
                <PosterCard movie={m} />
              </li>
            ))}
          </PosterGrid>
        </section>
      )}
      {p.actedIn.length > 0 && (
        <section className="person-page__section" aria-labelledby="starring">
          <h2 id="starring" className="row__title">
            Starring
          </h2>
          <PosterGrid label={`Starring ${p.name}`}>
            {p.actedIn.map((m) => (
              <li key={m.id}>
                <PosterCard movie={m} />
              </li>
            ))}
          </PosterGrid>
        </section>
      )}
    </div>
  );
}
