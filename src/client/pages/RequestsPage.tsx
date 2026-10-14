import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { MovieRequest, MovieRequestStatus, SessionInfo } from '../../shared/types';
import { useToast } from '../components/Toasts';
import { Button, Spinner, StatusView } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { relativeTime } from '../lib/format';

const STATUS_LABEL: Record<MovieRequestStatus, string> = {
  open: 'Asked for',
  added: 'Added',
  declined: 'Not this time',
};

/** Ask for a movie that isn't in the library; the administrator gets a notification. */
export function RequestsPage({ session }: { session: SessionInfo }) {
  const [params] = useSearchParams();
  const [title, setTitle] = useState(params.get('title') ?? '');
  const [year, setYear] = useState('');
  const [note, setNote] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const admin = session.user.isAdmin;

  const requests = useQuery({
    queryKey: ['requests'],
    queryFn: () => api<{ requests: MovieRequest[] }>('/requests'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['requests'] });

  const create = useMutation({
    mutationFn: () =>
      api<MovieRequest>('/requests', {
        method: 'POST',
        body: { title, year: year.trim() || null, note },
      }),
    onSuccess: (r) => {
      setTitle('');
      setYear('');
      setNote('');
      toast.show(`Asked for ${r.title}`);
      void refresh();
    },
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: MovieRequestStatus }) =>
      api(`/requests/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: refresh,
    onError: (e) => toast.show(errorMessage(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/requests/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => toast.show(errorMessage(e), 'error'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) create.mutate();
  };

  const list = requests.data?.requests ?? [];
  const open = list.filter((r) => r.status === 'open');
  const done = list.filter((r) => r.status !== 'open');

  const item = (r: MovieRequest) => (
    <li key={r.id} className={`request request--${r.status}`}>
      <div className="request__main">
        <strong className="request__title">
          {r.itemId && r.status === 'added' ? (
            <Link to={`/movie/${r.itemId}`}>{r.title}</Link>
          ) : (
            r.title
          )}
          {r.year ? <span className="faint"> ({r.year})</span> : null}
        </strong>
        <span className="request__meta">
          <span className={`request__status request__status--${r.status}`}>
            {STATUS_LABEL[r.status]}
          </span>
          {admin && !r.mine ? ` by ${r.userName}` : ''} · {relativeTime(r.createdAt)}
        </span>
        {r.note && <p className="request__note">“{r.note}”</p>}
      </div>
      <div className="request__actions">
        {admin && r.status === 'open' && (
          <>
            <Button
              size="sm"
              variant="secondary"
              icon="check"
              onClick={() => setStatus.mutate({ id: r.id, status: 'added' })}
            >
              Added
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setStatus.mutate({ id: r.id, status: 'declined' })}
            >
              Decline
            </Button>
          </>
        )}
        {admin && r.status !== 'open' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setStatus.mutate({ id: r.id, status: 'open' })}
          >
            Reopen
          </Button>
        )}
        {(admin || (r.mine && r.status === 'open')) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => remove.mutate(r.id)}
            aria-label={`Remove request for ${r.title}`}
          >
            Remove
          </Button>
        )}
      </div>
    </li>
  );

  return (
    <div className="page requests-page route-enter">
      <header className="page-header">
        <div>
          <h1 className="page-title">Requests</h1>
          <p>
            {admin
              ? 'Movies your family has asked for. Requests are marked Added by themselves when the movie shows up.'
              : 'Can’t find a movie? Ask for it. You’ll see it marked Added here when it’s in the library.'}
          </p>
        </div>
      </header>

      <form className="request-form" onSubmit={submit}>
        <label className="request-form__title">
          <span className="field__label">Movie</span>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. The Princess Bride"
            maxLength={150}
            required
            data-tv-focus=""
          />
        </label>
        <label className="request-form__year">
          <span className="field__label">Year (optional)</span>
          <input
            className="input"
            value={year}
            onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
            inputMode="numeric"
            placeholder="1987"
          />
        </label>
        <label className="request-form__note">
          <span className="field__label">Note (optional)</span>
          <input
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Director’s cut if you can"
            maxLength={300}
          />
        </label>
        <Button type="submit" variant="primary" icon="plus" busy={create.isPending}>
          Ask for it
        </Button>
        {create.isError && (
          <p className="field__error request-form__error" role="alert">
            {errorMessage(create.error)}
          </p>
        )}
      </form>

      {requests.isPending ? (
        <Spinner label="Loading requests" />
      ) : requests.isError ? (
        <p className="field__error">{errorMessage(requests.error)}</p>
      ) : list.length === 0 ? (
        <StatusView icon="film" title="No requests yet" compact>
          <p>{admin ? 'When someone asks for a movie, it shows up here.' : 'Ask for one above.'}</p>
        </StatusView>
      ) : (
        <>
          {open.length > 0 && (
            <section aria-labelledby="open-requests">
              <h2 id="open-requests" className="section-label">
                Waiting ({open.length})
              </h2>
              <ul className="requests">{open.map(item)}</ul>
            </section>
          )}
          {done.length > 0 && (
            <section aria-labelledby="done-requests">
              <h2 id="done-requests" className="section-label">
                Answered
              </h2>
              <ul className="requests">{done.map(item)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
