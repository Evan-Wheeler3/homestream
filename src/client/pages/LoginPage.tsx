import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import type { SessionInfo } from '../../shared/types';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui';
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
  const appName = cachedAppName();

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<{ ok: boolean; source: 'jellyfin' | 'mock' }>('/health'),
    retry: 1,
  });
  const existing = useQuery({
    queryKey: keys.session,
    queryFn: () => api<SessionInfo>('/auth/session'),
    retry: false,
  });

  if (existing.data && !busy) return <Navigate to={state.from ?? '/'} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api<SessionInfo>('/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      connection.clearAuthLost();
      qc.clear();
      qc.setQueryData(keys.session, session);
      navigate(state.from && state.from !== '/login' ? state.from : '/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MEDIA_SERVER_UNREACHABLE') {
        setError(
          'Jellyfin is not responding. Check that the Jellyfin server is running, then try again.',
        );
      } else setError(errorMessage(err));
      setBusy(false);
    }
  };

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

        <form className="login__form" onSubmit={submit} noValidate>
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
          <label className="field__label" htmlFor="login-pass">
            Password
          </label>
          <input
            id="login-pass"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <p className="login__error" role="alert">
              <Icon name="alert" size={18} /> {error}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" busy={busy} disabled={!username.trim()}>
            Sign in
          </Button>
        </form>
        <p className="login__foot faint">
          {source === 'jellyfin'
            ? 'Accounts are managed in your Jellyfin dashboard.'
            : source === 'mock'
              ? 'Connect Jellyfin by setting JELLYFIN_URL — see the README.'
              : ' '}
        </p>
      </main>
    </div>
  );
}
