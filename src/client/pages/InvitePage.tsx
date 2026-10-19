import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { InviteInfo, SessionInfo } from '../../shared/types';
import { Icon } from '../components/Icon';
import { Button, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { cachedAppName } from '../lib/appearance';
import { connection } from '../lib/connection';
import { keys } from '../lib/queries';

/** Opening an invitation (or password reset) link: choose a username and password. */
export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const appName = cachedAppName();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InviteInfo>(`/invites/${encodeURIComponent(token)}`),
    retry: false,
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== again) {
      setError('The two passwords don’t match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await api<SessionInfo>(`/invites/${encodeURIComponent(token)}`, {
        method: 'POST',
        body: { username, password },
      });
      connection.clearAuthLost();
      qc.clear();
      qc.setQueryData(keys.session, session);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const info = invite.data;
  const reset = info?.kind === 'reset';

  return (
    <div className="login">
      <div className="login__backdrop" aria-hidden="true" />
      <main className="login__panel">
        <div className="login__brand">
          <span className="topbar__mark" aria-hidden="true" />
          <h1 className="login__title display">{appName}</h1>
        </div>

        {invite.isPending ? (
          <Spinner label="Checking your link" />
        ) : invite.isError ? (
          <>
            <p className="login__error" role="alert">
              <Icon name="alert" size={18} /> {errorMessage(invite.error)}
            </p>
            <p className="login__foot faint">
              Already have an account? <Link to="/login">Sign in</Link>
            </p>
          </>
        ) : (
          <form className="login__form" onSubmit={submit} noValidate>
            <p className="login__lede">
              {reset ? (
                <>
                  Choose a new password for <strong>{info!.username ?? info!.name}</strong>.
                </>
              ) : (
                <>
                  Welcome, <strong>{info!.name}</strong>. Choose a username and password to finish
                  setting up your account.
                </>
              )}
            </p>
            {reset ? (
              <input type="hidden" autoComplete="username" value={info!.username ?? ''} readOnly />
            ) : (
              <>
                <label className="field__label" htmlFor="invite-user">
                  Username
                </label>
                <input
                  id="invite-user"
                  className="input"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
                <p className="field__hint">Letters and numbers, no spaces.</p>
              </>
            )}
            <label className="field__label" htmlFor="invite-pass">
              {reset ? 'New password' : 'Password'}
            </label>
            <input
              id="invite-pass"
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="field__hint">At least 8 characters.</p>
            <label className="field__label" htmlFor="invite-again">
              Type it again
            </label>
            <input
              id="invite-again"
              className="input"
              type="password"
              autoComplete="new-password"
              required
              value={again}
              onChange={(e) => setAgain(e.target.value)}
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
              disabled={(!reset && !username.trim()) || password.length < 8 || !again}
            >
              {reset ? 'Save password' : 'Create account'}
            </Button>
            <p className="login__foot faint">
              This link works once, until{' '}
              {new Date(info!.expiresAt).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'long',
              })}
              .
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
