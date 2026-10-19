import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type CSSProperties, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import type { MediaSourceKind, PublicProfile, SessionInfo } from '../../shared/types';
import { Icon } from '../components/Icon';
import { ProfileAvatar, profileColour } from '../components/ProfileAvatar';
import { Button, Spinner } from '../components/ui';
import { api, ApiError, errorMessage } from '../lib/api';
import { cachedAppName } from '../lib/appearance';
import { connection } from '../lib/connection';
import { keys } from '../lib/queries';

interface LocationState {
  from?: string;
  expired?: boolean;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const state = (location.state ?? {}) as LocationState;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Profile picker: null = show the picker (when there are profiles), 'manual' = plain form.
  const [chosen, setChosen] = useState<PublicProfile | 'manual' | null>(null);
  const appName = cachedAppName();

  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api<{ profiles: PublicProfile[] }>('/auth/profiles'),
    retry: false,
  });

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<{ ok: boolean; source: MediaSourceKind }>('/health'),
    retry: 1,
  });
  const existing = useQuery({
    queryKey: keys.session,
    queryFn: () => api<SessionInfo>('/auth/session'),
    retry: false,
  });

  if (existing.data && !busy) return <Navigate to={state.from ?? '/'} replace />;

  const signIn = async (user: string, pass: string) => {
    setBusy(true);
    setError(null);
    try {
      const session = await api<SessionInfo>('/auth/login', {
        method: 'POST',
        body: { username: user, password: pass },
      });
      connection.clearAuthLost();
      qc.clear();
      qc.setQueryData(keys.session, session);
      navigate(state.from && state.from !== '/login' ? state.from : '/', { replace: true });
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.code === 'MEDIA_SERVER_UNREACHABLE' &&
        source !== 'cloud'
      ) {
        setError(
          'Jellyfin is not responding. Check that the Jellyfin server is running, then try again.',
        );
      } else setError(errorMessage(err));
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void signIn(typeof chosen === 'object' && chosen ? chosen.name : username, password);
  };

  const pick = (profile: PublicProfile) => {
    setChosen(profile);
    setPassword('');
    setError(null);
    // No password on this profile (e.g. a kids profile): straight in.
    if (!profile.hasPassword) void signIn(profile.name, '');
  };

  const list = profiles.data?.profiles ?? [];
  const showPicker = chosen === null && list.length > 0;
  const profile = typeof chosen === 'object' ? chosen : null;

  const source = health.data?.source;

  return (
    <div className="login">
      <div className="login__backdrop" aria-hidden="true" />
      <main className="login__panel">
        <div className="login__brand">
          <span className="topbar__mark" aria-hidden="true" />
          <h1 className="login__title display">{appName}</h1>
        </div>
        <p className="login__lede">
          {source === 'mock'
            ? 'Sample library mode. Sign in with any name and the sample password (MOCK_PASSWORD, “demo” by default).'
            : source === 'cloud'
              ? 'Sign in with the username and password you chose when you were invited.'
              : 'Sign in with your Jellyfin account.'}
        </p>

        {state.expired && !error && (
          <p className="login__notice" role="status">
            Your session expired. Please sign in again.
          </p>
        )}
        {health.isError && (
          <p className="login__error" role="alert">
            <Icon name="offline" size={18} /> Cannot reach the Wheelhouse server.{' '}
            <button type="button" className="link-btn" onClick={() => health.refetch()}>
              Retry
            </button>
          </p>
        )}

        {profiles.isPending ? (
          <div className="profiles">
            <Spinner label="Loading profiles" />
          </div>
        ) : showPicker ? (
          <section className="profiles" aria-labelledby="who-title">
            <h2 id="who-title" className="profiles__title">
              Who’s watching?
            </h2>
            <ul className="profiles__list">
              {list.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`profile ${p.backdrop ? 'profile--art' : ''}`}
                    onClick={() => pick(p)}
                    disabled={busy}
                    data-tv-focus={p === list[0] ? '' : undefined}
                    style={{ '--profile-colour': profileColour(p.name, p.look) } as CSSProperties}
                  >
                    {p.backdrop && (
                      <img
                        className="profile__art"
                        src={p.backdrop}
                        alt=""
                        loading="lazy"
                        onError={(e) => e.currentTarget.remove()}
                      />
                    )}
                    <ProfileAvatar name={p.name} look={p.look} image={p.image} />
                    <span className="profile__name">{p.name}</span>
                    {p.tagline && <span className="profile__tagline">{p.tagline}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {error && (
              <p className="login__error" role="alert">
                <Icon name="alert" size={18} /> {error}
              </p>
            )}
            <button type="button" className="link-btn" onClick={() => setChosen('manual')}>
              Sign in as someone else
            </button>
          </section>
        ) : (
          <form className="login__form" onSubmit={submit} noValidate>
            {profile ? (
              <div className="login__who">
                <ProfileAvatar
                  name={profile.name}
                  look={profile.look}
                  image={profile.image}
                  size="sm"
                />
                <span>{profile.name}</span>
                <button type="button" className="link-btn" onClick={() => setChosen(null)}>
                  Not you?
                </button>
                {/* Lets password managers match the account. */}
                <input type="hidden" autoComplete="username" value={profile.name} readOnly />
              </div>
            ) : (
              <>
                <label className="field__label" htmlFor="login-user">
                  Username
                </label>
                <input
                  id="login-user"
                  className="input"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </>
            )}
            <label className="field__label" htmlFor="login-pass">
              Password
            </label>
            <input
              id="login-pass"
              className="input"
              type="password"
              autoFocus={Boolean(profile)}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && (
              <p className="login__error" role="alert">
                <Icon name="alert" size={18} /> {error}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              busy={busy}
              disabled={!profile && !username.trim()}
            >
              Sign in
            </Button>
          </form>
        )}
        <p className="login__foot faint">
          {source === 'cloud'
            ? 'Invite only. Forgot your password? Ask for a reset link.'
            : source === 'jellyfin'
              ? 'Accounts are managed in your Jellyfin dashboard.'
              : source === 'mock'
                ? 'Connect Jellyfin by setting JELLYFIN_URL — see the README.'
                : ' '}
        </p>
      </main>
    </div>
  );
}
