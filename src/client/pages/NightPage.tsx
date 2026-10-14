import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { MovieNight, NightCandidate } from '../../shared/types';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { Button, ButtonLink, Segmented, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatRuntime, plural } from '../lib/format';
import { sizedImage } from '../lib/images';

type Pool = 'unwatched' | 'all' | 'favorites' | 'watchlist';

export function CandidateArt({ c }: { c: Pick<NightCandidate, 'title' | 'year' | 'poster'> }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="night-art">
      {c.poster && !failed ? (
        <img
          src={sizedImage(c.poster, 320)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        // Guests can't load library posters: a simple title card instead.
        <span className="night-art__card">
          <span className="display">{c.title}</span>
          {c.year && <span>{c.year}</span>}
        </span>
      )}
    </span>
  );
}

function Setup({ onStart, busy }: { onStart: (pool: Pool, count: number) => void; busy: boolean }) {
  const [pool, setPool] = useState<Pool>('unwatched');
  const [count, setCount] = useState('4');
  return (
    <section className="night-setup">
      <p>
        Wheelhouse picks a shortlist; everyone votes on their phone; the winner plays here. Ties go
        to the wheel.
      </p>
      <div className="field">
        <span className="field__label">Choose from</span>
        <Segmented<Pool>
          label="Choose from"
          value={pool}
          onChange={setPool}
          options={[
            { value: 'unwatched', label: 'Unwatched' },
            { value: 'all', label: 'Everything' },
            { value: 'favorites', label: 'Favorites' },
            { value: 'watchlist', label: 'Watchlist' },
          ]}
        />
      </div>
      <div className="field">
        <span className="field__label">How many choices</span>
        <Segmented
          label="How many choices"
          value={count}
          onChange={setCount}
          options={['3', '4', '5', '6'].map((v) => ({ value: v, label: v }))}
        />
      </div>
      <Button
        variant="primary"
        size="lg"
        icon="play"
        busy={busy}
        data-tv-focus
        onClick={() => onStart(pool, Number(count))}
      >
        Start movie night
      </Button>
    </section>
  );
}

function Results({
  night,
  onClose,
  onRestart,
  busy,
}: {
  night: MovieNight;
  onClose: () => void;
  onRestart: () => void;
  busy: boolean;
}) {
  const total = night.candidates.reduce((n, c) => n + c.votes, 0);
  const open = night.status === 'open';
  const winners = night.candidates.filter((c) => night.winners.includes(c.id));
  const voteUrl = `${window.location.origin}/vote`;

  return (
    <>
      {open ? (
        <section className="night-join" aria-label="How to vote">
          <p>On your phone, go to</p>
          <p className="night-join__url">{voteUrl.replace(/^https?:\/\//, '')}</p>
          <p>and enter</p>
          <p
            className="night-join__code display"
            aria-label={`Code ${night.code.split('').join(' ')}`}
          >
            {night.code}
          </p>
        </section>
      ) : winners.length === 1 ? (
        <section className="night-winner" aria-live="assertive">
          <p className="eyebrow">Tonight’s movie</p>
          <h2 className="night-winner__title display">{winners[0]!.title}</h2>
          <div className="button-row">
            <ButtonLink to={`/play/${winners[0]!.id}?t=0`} variant="primary" size="lg" icon="play">
              Play
            </ButtonLink>
            <ButtonLink to={`/movie/${winners[0]!.id}`} variant="secondary" size="lg" icon="info">
              Details
            </ButtonLink>
          </div>
        </section>
      ) : winners.length > 1 ? (
        <section className="night-winner" aria-live="assertive">
          <p className="eyebrow">It’s a tie</p>
          <h2 className="night-winner__title display">
            {winners.map((w) => w.title).join(' vs ')}
          </h2>
          <ButtonLink
            to={`/spin?ids=${winners.map((w) => w.id).join('|')}&slots=12`}
            variant="primary"
            size="lg"
            icon="wheel"
          >
            Settle it on the wheel
          </ButtonLink>
        </section>
      ) : (
        <section className="night-winner">
          <h2 className="night-winner__title display">Nobody voted</h2>
        </section>
      )}

      <ul className="night-candidates" aria-label="Choices">
        {night.candidates.map((c) => {
          const share = total ? c.votes / total : 0;
          const won = night.winners.includes(c.id);
          return (
            <li key={c.id} className={`night-candidate ${won ? 'is-winner' : ''}`}>
              <Link to={`/movie/${c.id}`} className="night-candidate__art">
                <CandidateArt c={c} />
              </Link>
              <div className="night-candidate__info">
                <strong>{c.title}</strong>
                <span className="faint">
                  {[c.year, formatRuntime(c.runtimeMinutes)].filter(Boolean).join(' · ')}
                </span>
                <div className="night-bar" aria-hidden="true">
                  <span style={{ width: `${Math.round(share * 100)}%` }} />
                </div>
                <span className="night-candidate__votes">{plural(c.votes, 'vote')}</span>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="night-voters faint">
        {night.voters.length
          ? `Voted: ${night.voters.map((v) => v.name).join(', ')}`
          : 'Waiting for the first vote…'}
      </p>
      <div className="button-row">
        {open ? (
          <Button variant="primary" icon="check" busy={busy} onClick={onClose} data-tv-focus>
            Close voting and reveal
          </Button>
        ) : null}
        <Button variant="secondary" icon="refresh" onClick={onRestart}>
          New shortlist
        </Button>
      </div>
    </>
  );
}

/** The host's screen (usually the TV): join code, live votes, the reveal. */
export default function NightPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [setup, setSetup] = useState(false);
  const current = useQuery({
    queryKey: ['night'],
    queryFn: () => api<{ night: MovieNight | null }>('/nights/current'),
    refetchInterval: (q) => (q.state.data?.night?.status === 'open' ? 2000 : false),
  });
  const start = useMutation({
    mutationFn: (v: { pool: Pool; count: number }) =>
      api<MovieNight>('/nights', { method: 'POST', body: v }),
    onSuccess: (night) => {
      qc.setQueryData(['night'], { night });
      setSetup(false);
    },
    onError: (e) => toast.show(errorMessage(e), 'error'),
  });
  const close = useMutation({
    mutationFn: (id: string) => api<MovieNight>(`/nights/${id}/close`, { method: 'POST' }),
    onSuccess: (night) => qc.setQueryData(['night'], { night }),
    onError: (e) => toast.show(errorMessage(e), 'error'),
  });

  const night = current.data?.night;
  return (
    <div className="page night route-enter">
      <header className="page-header">
        <div>
          <h1 className="page-title">Movie night</h1>
          <p>Can’t agree? Put it to a vote.</p>
        </div>
      </header>
      {current.isPending ? (
        <Spinner label="Loading" />
      ) : night && !setup ? (
        <Results
          night={night}
          busy={close.isPending}
          onClose={() => close.mutate(night.id)}
          onRestart={() => setSetup(true)}
        />
      ) : (
        <Setup busy={start.isPending} onStart={(pool, count) => start.mutate({ pool, count })} />
      )}
      {current.isError && (
        <p className="field__error">
          <Icon name="alert" size={16} /> {errorMessage(current.error)}
        </p>
      )}
    </div>
  );
}
