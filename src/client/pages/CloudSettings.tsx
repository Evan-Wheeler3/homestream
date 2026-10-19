// Settings panels for the cloud edition: people and invitations, storage and
// cost, backups, and each movie's subtitles.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type {
  CloudBackup,
  CloudPerson,
  InviteLink,
  StorageReport,
  SubtitleChoice,
  SubtitleStatus,
} from '../../shared/types';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { Button, Field, Spinner, Switch } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatBytes, relativeTime } from '../lib/format';

const cloudKeys = {
  people: ['cloud', 'people'] as const,
  storage: ['cloud', 'storage'] as const,
  backups: ['cloud', 'backups'] as const,
  subtitles: ['cloud', 'subtitles'] as const,
};

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** A link shown once, right after it's made (only a hash is kept on the server). */
function NewLink({ link, onDone }: { link: InviteLink; onDone: () => void }) {
  const toast = useToast();
  const reset = link.person.status === 'active';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      toast.show('Link copied');
    } catch {
      toast.show('Couldn’t copy: select the link and copy it instead.', 'error');
    }
  };
  return (
    <div className="cloud-link" role="status">
      <p>
        <strong>
          {reset
            ? `Password reset link for ${link.person.name}`
            : `Invitation for ${link.person.name}`}
        </strong>{' '}
        · works once, until {dateLabel(link.expiresAt)}. Send it to them privately (a text or
        email). You won’t be able to see it again.
      </p>
      <input
        className="input cloud-link__url"
        readOnly
        value={link.url}
        onFocus={(e) => e.target.select()}
      />
      <div className="button-row">
        <Button icon="share" variant="primary" onClick={copy}>
          Copy link
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

export function PeoplePanel({ myId }: { myId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const people = useQuery({
    queryKey: cloudKeys.people,
    queryFn: () => api<{ people: CloudPerson[] }>('/admin/people'),
  });
  const [name, setName] = useState('');
  const [days, setDays] = useState(7);
  const [admin, setAdmin] = useState(false);
  const [link, setLink] = useState<InviteLink | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: cloudKeys.people });

  const invite = useMutation({
    mutationFn: () =>
      api<InviteLink>('/admin/people', { method: 'POST', body: { name, days, isAdmin: admin } }),
    onSuccess: (made) => {
      setLink(made);
      setName('');
      setAdmin(false);
      void refresh();
    },
    onError: (e) => toast.show(errorMessage(e), 'error'),
  });
  const action = useMutation({
    mutationFn: (a: { kind: 'link' | 'cancel' | 'remove'; person: CloudPerson }) =>
      a.kind === 'link'
        ? api<InviteLink>(`/admin/people/${a.person.id}/link`, { method: 'POST', body: { days } })
        : a.kind === 'cancel'
          ? api(`/admin/links/${a.person.link!.id}`, { method: 'DELETE' })
          : api(`/admin/people/${a.person.id}`, { method: 'DELETE' }),
    onSuccess: (result, a) => {
      if (a.kind === 'link') setLink(result as InviteLink);
      if (a.kind === 'remove') toast.show(`${a.person.name} no longer has access`);
      if (a.kind === 'cancel') toast.show('Link cancelled');
      setConfirmRemove(null);
      void refresh();
    },
    onError: (e) => toast.show(errorMessage(e), 'error'),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    invite.mutate();
  };

  return (
    <>
      {link && <NewLink link={link} onDone={() => setLink(null)} />}
      <form className="cloud-invite" onSubmit={submit}>
        <Field
          label="Invite someone"
          hint="Their name as you'd like it shown. They choose their own username and password."
        >
          {(id) => (
            <input
              id={id}
              className="input"
              placeholder="Name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Link works for">
          {(id) => (
            <select
              id={id}
              className="input"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {[1, 3, 7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? '1 day' : `${d} days`}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Switch
          label="Administrator"
          description="Can invite and remove people, see who's watching and manage discs."
          checked={admin}
          onChange={setAdmin}
        />
        <div className="button-row">
          <Button
            type="submit"
            icon="plus"
            variant="primary"
            busy={invite.isPending}
            disabled={!name.trim()}
          >
            Make invitation link
          </Button>
        </div>
      </form>

      <h3 className="section-label">Everyone with access</h3>
      {people.isPending ? (
        <Spinner label="Loading people" />
      ) : people.isError ? (
        <p className="field__error">{errorMessage(people.error)}</p>
      ) : (
        <ul className="cloud-people">
          {people.data.people.map((p) => (
            <li key={p.id} className="cloud-person">
              <div className="cloud-person__who">
                <strong>{p.name}</strong>
                {p.isAdmin && <span className="chip chip--small">Admin</span>}
                <span className="faint">
                  {p.status === 'pending'
                    ? p.link
                      ? `Invited · link works until ${dateLabel(p.link.expiresAt)}`
                      : 'Invited · no working link'
                    : [
                        p.username ? `@${p.username}` : null,
                        p.lastSeenAt
                          ? `last seen ${relativeTime(p.lastSeenAt)}`
                          : 'not signed in yet',
                        p.sessions ? `${p.sessions} device${p.sessions === 1 ? '' : 's'}` : null,
                        p.link?.kind === 'reset'
                          ? `reset link until ${dateLabel(p.link.expiresAt)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                </span>
              </div>
              <div className="button-row">
                <Button
                  variant="secondary"
                  busy={
                    action.isPending &&
                    action.variables?.person.id === p.id &&
                    action.variables.kind === 'link'
                  }
                  onClick={() => action.mutate({ kind: 'link', person: p })}
                >
                  {p.status === 'pending' ? 'New invitation link' : 'Reset password'}
                </Button>
                {p.link && (
                  <Button
                    variant="ghost"
                    onClick={() => action.mutate({ kind: 'cancel', person: p })}
                  >
                    Cancel link
                  </Button>
                )}
                {p.id !== myId &&
                  (confirmRemove === p.id ? (
                    <>
                      <Button
                        variant="danger"
                        busy={action.isPending}
                        onClick={() => action.mutate({ kind: 'remove', person: p })}
                      >
                        Remove {p.name}
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmRemove(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" icon="trash" onClick={() => setConfirmRemove(p.id)}>
                      Remove
                    </Button>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="field__hint">
        Removing someone signs them out everywhere straight away. A password reset link lets them
        choose a new password; their old one keeps working until they do.
      </p>
    </>
  );
}

export function StoragePanel() {
  const storage = useQuery({
    queryKey: cloudKeys.storage,
    queryFn: () => api<StorageReport>('/admin/storage'),
    staleTime: 5 * 60_000,
  });
  if (storage.isPending) return <Spinner label="Measuring storage" />;
  if (storage.isError) return <p className="field__error">{errorMessage(storage.error)}</p>;
  const s = storage.data;
  const used = Math.min(1, s.bytes / s.freeBytes);
  return (
    <>
      <dl className="facts facts--settings">
        <div className="facts__row">
          <dt>Stored</dt>
          <dd>
            {formatBytes(s.bytes)} · {s.movies} movie{s.movies === 1 ? '' : 's'} (videos{' '}
            {formatBytes(s.videoBytes)}) · {s.objects.toLocaleString()} files
          </dd>
        </div>
        <div className="facts__row">
          <dt>Estimated cost</dt>
          <dd>
            {s.monthlyUsd === 0
              ? `$0.00 a month: within the free ${formatBytes(s.freeBytes)}`
              : `about $${s.monthlyUsd.toFixed(2)} a month for storage`}
            <span className="faint">
              {' '}
              · ${s.pricePerGbMonth} per GB-month beyond the free amount
            </span>
          </dd>
        </div>
        <div className="facts__row">
          <dt>Plan</dt>
          <dd>{s.plan}</dd>
        </div>
      </dl>
      <div
        className="drive__bar"
        role="meter"
        aria-label="Free storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used * 100)}
      >
        <span style={{ width: `${Math.round(used * 100)}%` }} />
      </div>
      <p className="field__hint">
        Watching is free: Cloudflare doesn’t charge for streaming out of storage.
      </p>
    </>
  );
}

export function BackupsPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const backups = useQuery({
    queryKey: cloudKeys.backups,
    queryFn: () => api<{ backups: CloudBackup[] }>('/admin/backups'),
  });
  const now = useMutation({
    mutationFn: () => api<{ backups: CloudBackup[] }>('/admin/backups', { method: 'POST' }),
    onSuccess: (data) => {
      qc.setQueryData(cloudKeys.backups, data);
      toast.show('Backup made');
    },
    onError: (e) => toast.show(errorMessage(e), 'error'),
  });
  const list = backups.data?.backups ?? [];
  return (
    <>
      <p>
        {list[0]
          ? `Last backup ${relativeTime(list[0].createdAt)} · ${list.length} kept (the newest 14).`
          : 'No backups yet.'}{' '}
        <span className="faint">
          Every night the database (accounts, watch history, collections, ratings) is saved to your
          storage. Movies themselves are backed up by your copies on the Mac’s drive.
        </span>
      </p>
      <div className="button-row">
        <Button icon="upload" variant="secondary" busy={now.isPending} onClick={() => now.mutate()}>
          Back up now
        </Button>
      </div>
    </>
  );
}

const STATUS_LABEL: Record<SubtitleStatus['status'], string> = {
  disc: 'From the disc',
  downloaded: 'Downloaded',
  none: 'None',
};

function SubtitleRow({ movie }: { movie: SubtitleStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const choices = useQuery({
    queryKey: ['cloud', 'subtitle-choices', movie.id],
    queryFn: () => api<{ choices: SubtitleChoice[] }>(`/admin/subtitles/${movie.id}/choices`),
    enabled: picking,
  });
  const find = useMutation({
    mutationFn: (fileId?: number) =>
      api<{ release: string }>(`/admin/subtitles/${movie.id}`, {
        method: 'POST',
        body: fileId ? { fileId } : {},
      }),
    onSuccess: (r) => {
      toast.show(`Subtitles added: ${r.release || 'English'}`);
      setPicking(false);
      void qc.invalidateQueries({ queryKey: cloudKeys.subtitles });
    },
    onError: (e) => toast.show(errorMessage(e), 'error'),
  });
  return (
    <li className="cloud-subs__row">
      <div className="cloud-person__who">
        <strong>
          {movie.title}
          {movie.year ? ` (${movie.year})` : ''}
        </strong>
        <span className={movie.status === 'none' ? 'status-bad' : 'faint'}>
          {STATUS_LABEL[movie.status]}
          {movie.release ? ` · ${movie.release}` : ''}
        </span>
      </div>
      <div className="button-row">
        <Button
          variant="secondary"
          busy={find.isPending && !find.variables}
          onClick={() => find.mutate(undefined)}
        >
          {movie.status === 'none' ? 'Find subtitles' : 'Find others'}
        </Button>
        <Button variant="ghost" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
          Pick one…
        </Button>
      </div>
      {picking && (
        <div className="cloud-subs__choices">
          {choices.isPending ? (
            <Spinner label="Searching OpenSubtitles" />
          ) : choices.isError ? (
            <p className="field__error">{errorMessage(choices.error)}</p>
          ) : choices.data.choices.length === 0 ? (
            <p className="faint">OpenSubtitles has no English subtitles for this movie.</p>
          ) : (
            <ul>
              {choices.data.choices.map((choice) => (
                <li key={choice.fileId}>
                  <button
                    type="button"
                    className="link-btn"
                    disabled={find.isPending}
                    onClick={() => find.mutate(choice.fileId)}
                  >
                    {choice.release || `File ${choice.fileId}`}
                  </button>{' '}
                  <span className="faint">
                    {choice.downloads.toLocaleString()} downloads
                    {choice.hearingImpaired ? ' · for the hard of hearing' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="field__hint">
            Each download uses one of today’s 20 OpenSubtitles downloads.
          </p>
        </div>
      )}
    </li>
  );
}

export function SubtitlesPanel() {
  const subtitles = useQuery({
    queryKey: cloudKeys.subtitles,
    queryFn: () => api<{ movies: SubtitleStatus[] }>('/admin/subtitles'),
  });
  if (subtitles.isPending) return <Spinner label="Loading subtitles" />;
  if (subtitles.isError) return <p className="field__error">{errorMessage(subtitles.error)}</p>;
  const movies = subtitles.data.movies;
  const missing = movies.filter((m) => m.status === 'none').length;
  return (
    <>
      <p>
        {movies.length === 0
          ? 'No movies yet.'
          : missing
            ? `${missing} of ${movies.length} movies have no subtitles.`
            : `All ${movies.length} movies have English subtitles.`}{' '}
        <span className="faint">
          They’re off until you press <Icon name="captions" size={14} /> in the player.
        </span>
      </p>
      <ul className="cloud-subs">
        {movies.map((m) => (
          <SubtitleRow key={m.id} movie={m} />
        ))}
      </ul>
    </>
  );
}
