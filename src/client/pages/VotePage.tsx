import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import type { MovieNight, SessionInfo } from '../../shared/types';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { cachedAppName } from '../lib/appearance';
import { formatRuntime } from '../lib/format';
import { CandidateArt } from './NightPage';

// Phones remember who they are between votes (per-device convenience).
function stored(key: string, fallback: () => string) {
  try {
    const v = localStorage.getItem(key);
    if (v) return v;
    const next = fallback();
    localStorage.setItem(key, next);
    return next;
  } catch {
    return fallback();
  }
}

const voterKey = () =>
  stored('wh-voter', () =>
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `v-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
  );

/** Voting from a phone: no account needed, just the code on the TV and a name. */
export function VotePage() {
  const params = useParams();
  const qc = useQueryClient();
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('wh-voter-name') ?? '';
    } catch {
      return '';
    }
  });
  const [code, setCode] = useState((params.code ?? '').toUpperCase());
  // A link with the code skips straight to voting when this phone already knows its name.
  const [joined, setJoined] = useState(() => Boolean(params.code) && Boolean(name));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = voterKey();

  // Signed-in household members are named automatically.
  useQuery({
    queryKey: ['vote-session'],
    queryFn: async () => {
      const s = await api<SessionInfo>('/auth/session').catch(() => null);
      if (s && !name) setName(s.user.name);
      return s;
    },
    retry: false,
  });

  const night = useQuery({
    queryKey: ['vote', code],
    queryFn: () =>
      api<{ night: MovieNight; myVote: string | null }>(
        `/public/nights/${encodeURIComponent(code)}?voter=${encodeURIComponent(key)}`,
      ),
    enabled: joined && code.length === 4,
    refetchInterval: (q) => (q.state.data?.night.status === 'open' ? 3000 : false),
    retry: false,
  });

  const join = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setJoined(true);
  };

  const vote = async (itemId: string) => {
    if (!name.trim()) {
      setError('Enter your name first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem('wh-voter-name', name.trim());
    } catch {
      /* fine */
    }
    try {
      const result = await api<{ night: MovieNight; myVote: string }>(
        `/public/nights/${encodeURIComponent(code)}/vote`,
        { method: 'POST', body: { voterKey: key, name: name.trim(), itemId } },
      );
      qc.setQueryData(['vote', code], result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const data = night.data;
  const n = data?.night;
  const winners = n?.candidates.filter((c) => n.winners.includes(c.id)) ?? [];

  return (
    <div className="vote">
      <header className="vote__header">
        <span className="topbar__mark" aria-hidden="true" />
        <span className="vote__app display">{cachedAppName()}</span>
        <span className="eyebrow">Movie night</span>
      </header>

      {!joined || night.isError ? (
        <form className="vote__join" onSubmit={join}>
          <h1 className="vote__title display">Join the vote</h1>
          <label className="field__label" htmlFor="vote-code">
            Code on the TV
          </label>
          <input
            id="vote-code"
            className="input vote__code-input"
            value={code}
            onChange={(e) => {
              setCode(
                e.target.value
                  .toUpperCase()
                  .replace(/[^A-Z]/g, '')
                  .slice(0, 4),
              );
              setJoined(false);
            }}
            autoCapitalize="characters"
            autoComplete="off"
            inputMode="text"
            placeholder="ABCD"
          />
          <label className="field__label" htmlFor="vote-name">
            Your name
          </label>
          <input
            id="vote-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 30))}
            autoComplete="given-name"
          />
          {night.isError && joined && (
            <p className="login__error" role="alert">
              <Icon name="alert" size={18} /> {errorMessage(night.error)}
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            disabled={code.length !== 4 || !name.trim()}
          >
            Join
          </Button>
        </form>
      ) : !n ? (
        <p className="vote__status">Joining…</p>
      ) : n.status === 'closed' ? (
        <section className="vote__done" aria-live="polite">
          <h1 className="vote__title display">
            {winners.length === 1
              ? winners[0]!.title
              : winners.length > 1
                ? 'It’s a tie: off to the wheel!'
                : 'Voting closed'}
          </h1>
          {winners.length === 1 && <p>is tonight’s movie. Enjoy!</p>}
        </section>
      ) : (
        <section>
          <h1 className="vote__title display">
            {data?.myVote ? 'Vote counted' : 'What should we watch?'}
          </h1>
          <p className="faint">
            {data?.myVote ? 'Changed your mind? Tap another.' : `Voting as ${name}. Tap one.`}
          </p>
          {error && (
            <p className="login__error" role="alert">
              <Icon name="alert" size={18} /> {error}
            </p>
          )}
          <ul className="vote__choices">
            {n.candidates.map((c) => {
              const mine = data?.myVote === c.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`vote__choice ${mine ? 'is-mine' : ''}`}
                    aria-pressed={mine}
                    disabled={busy}
                    onClick={() => vote(c.id)}
                  >
                    <CandidateArt c={c} />
                    <span className="vote__choice-info">
                      <strong>{c.title}</strong>
                      <span className="faint">
                        {[c.year, formatRuntime(c.runtimeMinutes), ...c.genres.slice(0, 2)]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {c.overview && <span className="vote__overview">{c.overview}</span>}
                    </span>
                    {mine && <Icon name="check" size={22} />}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
