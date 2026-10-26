import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  ACCENT_PRESETS,
  BITRATE_OPTIONS,
  BUILTIN_SECTIONS,
  THEMES,
} from '../../shared/preferences';
import type {
  HomeSectionPref,
  NowWatching,
  Preferences,
  ServerStatus,
  SessionInfo,
  ShareInfo,
  SortField,
  StreamLimit,
  UpdateStatus,
} from '../../shared/types';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import {
  Button,
  ButtonLink,
  Field,
  IconButton,
  Segmented,
  Spinner,
  Switch,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { detectCapabilities } from '../lib/capabilities';
import { recentErrors } from '../lib/diagnostics';
import { formatBytes, formatClock, relativeTime, SUBTITLE_LANGUAGE_OPTIONS } from '../lib/format';
import { sizedImage } from '../lib/images';
import { useCollections, useRefreshCatalog, useStatus, useUpdatePreferences } from '../lib/queries';
import { SORT_OPTIONS } from './BrowsePage';
import {
  BackupsPanel,
  PeoplePanel,
  RatingsPanel,
  StoragePanel,
  SubtitlesPanel,
} from './CloudSettings';
import { ProfilePanel } from './ProfileSettings';
import { setTvSetting, useTvMode } from '../lib/tv';

/** Check for and install updates (git installs; administrators only). */
function UpdatesPanel() {
  const toast = useToast();
  const [force, setForce] = useState(0);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ['update-status', force],
    queryFn: () => api<UpdateStatus>(`/system/update${force ? '?force=1' : ''}`),
    refetchInterval: (q) => {
      const st = q.state.data?.state;
      return st?.running || st?.restarting ? 1500 : false;
    },
  });
  const start = useMutation({
    mutationFn: () => api<UpdateStatus>('/system/update', { method: 'POST' }),
    onSuccess: () => void status.refetch(),
    onError: (e) => toast.show(errorMessage(e), 'error'),
  });

  // After an update the server restarts; reload once the new version answers.
  const restarting = status.data?.state.restarting;
  useEffect(() => {
    if (!restarting) return;
    const id = window.setInterval(async () => {
      try {
        const s = await api<ServerStatus>('/status');
        if (startedAt && s.app.startedAt !== startedAt) window.location.reload();
        if (!startedAt) setStartedAt(s.app.startedAt);
      } catch {
        /* still restarting */
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [restarting, startedAt]);

  if (status.isPending) return <Spinner label="Checking for updates" />;
  if (status.isError) return <p className="field__error">{errorMessage(status.error)}</p>;
  const u = status.data;
  const st = u.state;

  if (!u.supported) return <p className="field__hint">{u.reason}</p>;

  return (
    <div className="updates">
      {u.current && (
        <p className="field__hint">
          Installed: <code>{u.current.sha}</code> · {u.current.subject} ·{' '}
          {relativeTime(u.current.date)}
        </p>
      )}
      {u.reason && <p className="field__error">{u.reason}</p>}
      {st.running || st.restarting ? (
        <p className="updates__progress" aria-live="polite">
          <Spinner size={18} /> {st.step}…
        </p>
      ) : st.error ? (
        <p className="field__error">Update failed: {st.error}</p>
      ) : st.step ? (
        <p className="status-ok">{st.step}</p>
      ) : u.behind > 0 ? (
        <>
          <p>
            <strong>{u.behind === 1 ? '1 new change' : `${u.behind} new changes`}</strong>{' '}
            available:
          </p>
          <ul className="updates__changes">
            {u.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </>
      ) : (
        u.checkedAt && (
          <p className="status-ok">Up to date (checked {relativeTime(u.checkedAt)}).</p>
        )
      )}
      {u.auto && !st.running && !st.restarting && (
        <p className="faint">
          New versions install by themselves within half an hour, whenever nothing is ripping,
          compressing, uploading or playing.
        </p>
      )}
      <div className="button-row">
        {u.behind > 0 && !st.running && !st.restarting && (
          <Button
            variant="primary"
            icon="arrowDown"
            busy={start.isPending}
            onClick={() => start.mutate()}
          >
            Update now
          </Button>
        )}
        <Button
          variant="secondary"
          icon="refresh"
          busy={status.isFetching && !st.running}
          disabled={st.running || st.restarting}
          onClick={() => setForce((n) => n + 1)}
        >
          Check for updates
        </Button>
      </div>
    </div>
  );
}

/** TV mode is a per-device choice (a phone and a TV share one account). */
function TvModeField() {
  const tv = useTvMode();
  return (
    <div className="field">
      <span className="field__label">TV mode</span>
      <Segmented
        label="TV mode"
        value={tv.setting}
        onChange={setTvSetting}
        options={[
          { value: 'auto', label: 'Automatic' },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
      />
      <p className="field__hint">
        Larger layout you can drive with a TV remote: arrows to move, OK to select, Back to go back.
        Automatic turns it on for smart-TV browsers. This setting only affects this device
        {tv.enabled ? ', where it is currently on.' : '.'}
      </p>
    </div>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="settings-section" aria-labelledby={`${id}-title`}>
      <header className="settings-section__header">
        <h2 id={`${id}-title`} className="settings-section__title">
          {title}
        </h2>
        {description && <p className="muted">{description}</p>}
      </header>
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <span className="select">
          <select
            id={id}
            value={String(value)}
            onChange={(e) => {
              const match = options.find((o) => String(o.value) === e.target.value);
              if (match) onChange(match.value);
            }}
          >
            {options.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" size={16} />
        </span>
      )}
    </Field>
  );
}

function AppNameField({
  prefs,
  save,
}: {
  prefs: Preferences;
  save: (p: Partial<Preferences>) => void;
}) {
  const [name, setName] = useState(prefs.appName);
  const [savedName, setSavedName] = useState(prefs.appName);
  if (prefs.appName !== savedName) {
    setSavedName(prefs.appName);
    setName(prefs.appName);
  }
  const commit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== prefs.appName) save({ appName: trimmed });
    else setName(prefs.appName);
  };
  return (
    <Field label="Name" hint="Shown in the navigation bar, the sign-in screen and the browser tab.">
      {(id) => (
        <input
          id={id}
          className="input"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
    </Field>
  );
}

function HomeSectionsEditor({
  prefs,
  save,
}: {
  prefs: Preferences;
  save: (p: Partial<Preferences>) => void;
}) {
  const collections = useCollections();
  const labels = new Map<string, string>(BUILTIN_SECTIONS.map((s) => [s.id, s.label]));
  for (const c of collections.data ?? []) labels.set(`collection:${c.id}`, `Collection: ${c.name}`);
  // Hide entries for collections that no longer exist.
  const sections = prefs.homeSections.filter(
    (s) => labels.has(s.id) || (!collections.data && s.id.startsWith('collection:')),
  );
  const pinnable = (collections.data ?? []).filter(
    (c) => !prefs.homeSections.some((s) => s.id === `collection:${c.id}`),
  );

  const write = (next: HomeSectionPref[]) => save({ homeSections: next });
  const move = (index: number, delta: -1 | 1) => {
    const next = [...sections];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    write(next);
  };

  return (
    <div className="section-editor">
      <ol className="section-editor__list">
        {sections.map((section, i) => {
          const isCollection = section.id.startsWith('collection:');
          return (
            <li
              key={section.id}
              className={`section-editor__item ${section.visible ? '' : 'is-hidden'}`}
            >
              <span className="section-editor__label">
                {labels.get(section.id) ?? 'Collection'}
              </span>
              <div className="section-editor__controls">
                <IconButton
                  icon={section.visible ? 'eye' : 'eyeOff'}
                  label={
                    section.visible
                      ? `Hide ${labels.get(section.id)}`
                      : `Show ${labels.get(section.id)}`
                  }
                  pressed={section.visible}
                  onClick={() =>
                    write(
                      sections.map((s) =>
                        s.id === section.id ? { ...s, visible: !s.visible } : s,
                      ),
                    )
                  }
                />
                <IconButton
                  icon="arrowUp"
                  label="Move up"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                />
                <IconButton
                  icon="arrowDown"
                  label="Move down"
                  disabled={i === sections.length - 1}
                  onClick={() => move(i, 1)}
                />
                {isCollection && (
                  <IconButton
                    icon="close"
                    label="Remove from Home"
                    onClick={() => write(sections.filter((s) => s.id !== section.id))}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {pinnable.length > 0 && (
        <SelectField<string>
          label="Add a collection row"
          value=""
          options={[
            { value: '', label: 'Choose a collection…' },
            ...pinnable.map((c) => ({ value: c.id, label: c.name })),
          ]}
          onChange={(id) => id && write([...sections, { id: `collection:${id}`, visible: true }])}
        />
      )}
      <p className="field__hint">
        Empty sections are hidden automatically, so a small library never shows blank rows.
      </p>
    </div>
  );
}

const mbps = (bps: number) => `${Math.round((bps / 1_000_000) * 10) / 10} Mbps`;

const METHOD_LABEL: Record<NowWatching['method'], string> = {
  DirectPlay: 'Original file',
  DirectStream: 'Original video, repackaged',
  Transcode: 'Converted by Jellyfin',
};

/** Who's playing something right now (administrators). */
function WatchingNow({ watching }: { watching: NowWatching[] }) {
  return (
    <div className="watching">
      <h3 className="section-label">Watching now</h3>
      {watching.length === 0 ? (
        <p className="faint">Nobody is watching anything.</p>
      ) : (
        <ul className="watching__list">
          {watching.map((w) => (
            <li key={`${w.userName}-${w.itemId}-${w.startedAt}`} className="watching__item">
              {w.poster ? (
                <img src={sizedImage(w.poster, 120)} alt="" className="watching__poster" />
              ) : (
                <span className="watching__poster" aria-hidden="true" />
              )}
              <div className="watching__body">
                <strong>
                  {w.userName} · {w.title}
                  {w.year ? <span className="faint"> ({w.year})</span> : null}
                </strong>
                <span className="faint">
                  {w.paused ? 'Paused' : 'Playing'} at {formatClock(w.positionSeconds)}
                  {w.runtimeSeconds ? ` of ${formatClock(w.runtimeSeconds)}` : ''} ·{' '}
                  {w.place === 'away' ? 'Away from home' : 'At home'} · {w.device}
                </span>
                <span className="faint">
                  {METHOD_LABEL[w.method]}
                  {w.limit ? ` · limited to ${mbps(w.limit)}` : ''}
                </span>
                {w.runtimeSeconds ? (
                  <span className="watching__bar" aria-hidden="true">
                    <span
                      style={{
                        width: `${Math.min(100, (w.positionSeconds / w.runtimeSeconds) * 100)}%`,
                      }}
                    />
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Instructions and a ready-to-send message for family outside the home. */
function SharePanel({ appName }: { appName: string }) {
  const info = useQuery({
    queryKey: ['share-info'],
    queryFn: () => api<ShareInfo>('/system/share'),
  });
  const toast = useToast();
  const [address, setAddress] = useState<string | null>(null);
  if (info.isPending) return <Spinner label="Looking up addresses" />;
  if (info.isError) return <p className="field__error">{errorMessage(info.error)}</p>;
  const i = info.data;
  const suggested =
    i.addresses.find((a) => a.kind === 'tailscale')?.url ?? `http://${i.hostname}:${i.port}`;
  const url = address ?? suggested;
  const message = [
    `You're invited to ${appName}, our home movie library.`,
    '',
    '1. Install Tailscale (tailscale.com/download) on your phone or laptop and make a free account.',
    '2. Accept the Tailscale invite I sent you (check your email).',
    `3. With Tailscale on, open ${url}`,
    '4. Sign in with the username and password I give you.',
    '',
    'Tip: on a phone, use Add to Home Screen so it opens like an app.',
  ].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      toast.show('Invitation copied');
    } catch {
      toast.show('Couldn’t copy: select the text and copy it', 'error');
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: `${appName} invitation`, text: message });
    } catch {
      /* cancelled */
    }
  };

  return (
    <>
      <ol className="share-steps">
        <li>
          <strong>Tailscale on this computer.</strong>{' '}
          {i.tailscale ? (
            <span className="status-ok">
              <Icon name="check" size={16} /> Running
            </span>
          ) : (
            <span className="status-bad">
              Not found. Install it from tailscale.com/download and sign in.
            </span>
          )}
        </li>
        <li>
          <strong>Share this computer with each person:</strong> in the Tailscale admin console
          (login.tailscale.com) open <em>Machines</em>, click <em>…</em> next to this computer →{' '}
          <em>Share</em>, and send the invite to their email. They only get this one computer, not
          the rest of your network.
        </li>
        <li>
          <strong>Give each person their own Jellyfin account:</strong> Jellyfin{' '}
          <em>Dashboard → Users → +</em>. Leave “administrator” off. Their history, Watchlist and
          Wrapped are their own.
        </li>
        <li>
          <strong>Send them the invitation below.</strong> If your upload is slow, give them a
          streaming limit underneath.
        </li>
      </ol>
      <Field
        label="Address to send"
        hint={
          i.addresses.length
            ? `This computer: ${i.addresses.map((a) => `${a.url}${a.kind === 'tailscale' ? ' (Tailscale)' : ' (home only)'}`).join(', ')}. If you renamed it in Tailscale (e.g. “wheelhouse”), http://wheelhouse:${i.port} works too.`
            : undefined
        }
      >
        {(id) => (
          <input
            id={id}
            className="input"
            value={url}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
          />
        )}
      </Field>
      <pre className="share-message" aria-label="Invitation">
        {message}
      </pre>
      <div className="button-row">
        <Button icon="share" variant="secondary" onClick={copy}>
          Copy invitation
        </Button>
        {'share' in navigator && (
          <Button variant="ghost" onClick={share}>
            Send…
          </Button>
        )}
      </div>
    </>
  );
}

/** Per-person streaming caps (administrators). */
function LimitsPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const people = useQuery({
    queryKey: ['limits'],
    queryFn: () => api<{ people: StreamLimit[] }>('/limits'),
  });
  const save = useMutation({
    mutationFn: (p: { userId: string; maxBitrate: number | null; awayOnly: boolean }) =>
      api<{ people: StreamLimit[] }>(`/limits/${encodeURIComponent(p.userId)}`, {
        method: 'PUT',
        body: { maxBitrate: p.maxBitrate, awayOnly: p.awayOnly },
      }),
    onSuccess: (data) => {
      qc.setQueryData(['limits'], data);
      toast.show('Limit saved');
    },
    onError: (e) => toast.show(errorMessage(e), 'error'),
  });
  if (people.isPending) return <Spinner label="Loading people" />;
  if (people.isError) return <p className="field__error">{errorMessage(people.error)}</p>;
  const options = BITRATE_OPTIONS.map((o) => ({
    value: String(o.value ?? 'none'),
    label: o.value == null ? 'No limit' : o.label,
  }));
  return (
    <>
      <p className="field__hint">
        Caps the quality Jellyfin sends each person, so viewers away from home don’t use up your
        home internet’s upload. 4 Mbps suits most homes; DVD rips usually play below it untouched.
        Their own Playback setting still applies if it’s lower.
      </p>
      <ul className="limits">
        {people.data.people.map((p) => (
          <li key={p.userId} className="limits__row">
            <div className="limits__who">
              <strong>{p.userName}</strong>
              {p.lastSeen && <span className="faint">Last here {relativeTime(p.lastSeen)}</span>}
            </div>
            <span className="select">
              <select
                aria-label={`Streaming limit for ${p.userName}`}
                value={String(p.maxBitrate ?? 'none')}
                onChange={(e) =>
                  save.mutate({
                    userId: p.userId,
                    maxBitrate: e.target.value === 'none' ? null : Number(e.target.value),
                    awayOnly: p.awayOnly,
                  })
                }
              >
                {/* Keep a custom value visible if it isn't one of the presets. */}
                {p.maxBitrate != null && !options.some((o) => o.value === String(p.maxBitrate)) && (
                  <option value={String(p.maxBitrate)}>{mbps(p.maxBitrate)}</option>
                )}
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </span>
            <label className="limits__away">
              <input
                type="checkbox"
                checked={p.awayOnly}
                disabled={p.maxBitrate == null}
                onChange={(e) =>
                  save.mutate({
                    userId: p.userId,
                    maxBitrate: p.maxBitrate,
                    awayOnly: e.target.checked,
                  })
                }
              />
              Only when away from home
            </label>
          </li>
        ))}
      </ul>
      <p className="field__hint">People appear here after they’ve signed in once.</p>
    </>
  );
}

function ServerStatusPanel() {
  const status = useStatus();
  const backup = useMutation({ mutationFn: () => api('/backups', { method: 'POST' }) });
  const refresh = useRefreshCatalog();
  const toast = useToast();
  if (status.isPending) return <Spinner label="Checking server" />;
  if (status.isError) return <p className="field__error">{errorMessage(status.error)}</p>;
  const s = status.data;
  const ms = s.mediaServer;
  return (
    <>
      <dl className="facts facts--settings">
        <div className="facts__row">
          <dt>Media source</dt>
          <dd>
            {s.source === 'jellyfin'
              ? 'Jellyfin'
              : s.source === 'cloud'
                ? 'Cloudflare (movies in R2 storage)'
                : 'Built-in sample library (no Jellyfin configured)'}
          </dd>
        </div>
        {ms.url && (
          <div className="facts__row">
            <dt>Jellyfin address</dt>
            <dd>
              <code>{ms.url}</code>
            </dd>
          </div>
        )}
        <div className="facts__row">
          <dt>Status</dt>
          <dd className={ms.reachable ? 'status-ok' : 'status-bad'}>
            <Icon name={ms.reachable ? 'check' : 'alert'} size={16} />
            {ms.reachable
              ? `Connected${ms.latencyMs != null ? ` · ${ms.latencyMs} ms` : ''}`
              : `Unreachable — ${ms.error ?? 'unknown error'}`}
          </dd>
        </div>
        {ms.name && s.source === 'jellyfin' && (
          <div className="facts__row">
            <dt>Server</dt>
            <dd>
              {ms.name}
              {ms.version ? ` · Jellyfin ${ms.version}` : ''}
            </dd>
          </div>
        )}
        <div className="facts__row">
          <dt>Library index</dt>
          <dd>
            {s.catalog.count.toLocaleString()} movies
            {s.catalog.lastRefreshed ? ` · refreshed ${relativeTime(s.catalog.lastRefreshed)}` : ''}
            {s.catalog.stale ? ' · showing cached data' : ''}
          </dd>
        </div>
        {s.catalog.lastError && (
          <div className="facts__row">
            <dt>Last error</dt>
            <dd className="status-bad">{s.catalog.lastError}</dd>
          </div>
        )}
        {s.ripper && (
          <div className="facts__row">
            <dt>Disc ripping</dt>
            <dd className={s.ripper.problems.length ? 'status-bad' : 'status-ok'}>
              <Icon name={s.ripper.problems.length ? 'alert' : 'check'} size={16} />
              {s.ripper.problems.length
                ? `${s.ripper.problems.length} problem${s.ripper.problems.length > 1 ? 's' : ''}: see Discs`
                : 'Ready for discs'}
            </dd>
          </div>
        )}
        {s.backups && s.source !== 'cloud' && (
          <div className="facts__row">
            <dt>Backups</dt>
            <dd>
              {s.backups.last
                ? `Last backup ${relativeTime(s.backups.last)} · ${s.backups.count} kept`
                : 'No backup yet'}
              <span className="faint"> · daily, in {s.backups.dir}</span>
            </dd>
          </div>
        )}
      </dl>
      {s.watching && <WatchingNow watching={s.watching} />}
      {s.drives.length > 0 && (
        <ul className="drives" aria-label="Storage">
          {s.drives.map((d) => {
            const used = d.totalBytes && d.freeBytes != null ? 1 - d.freeBytes / d.totalBytes : 0;
            return (
              <li key={d.path} className={`drive ${d.low ? 'drive--low' : ''}`}>
                <div className="drive__head">
                  <strong>{d.label}</strong>
                  <span className={d.low ? 'status-bad' : 'faint'}>
                    {d.available
                      ? `${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}`
                      : 'Not connected'}
                  </span>
                </div>
                {d.available && (
                  <div
                    className="drive__bar"
                    role="meter"
                    aria-label={`${d.label} space used`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(used * 100)}
                  >
                    <span style={{ width: `${Math.round(used * 100)}%` }} />
                  </div>
                )}
                {d.low && (
                  <p className="field__hint status-bad">Almost full: new movies may not fit.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="button-row">
        <Button
          icon="refresh"
          variant="secondary"
          busy={status.isFetching}
          onClick={() => status.refetch()}
        >
          {s.source === 'cloud' ? 'Check again' : 'Test connection'}
        </Button>
        {s.backups && s.source !== 'cloud' && (
          <Button
            icon="upload"
            variant="secondary"
            busy={backup.isPending}
            onClick={() =>
              backup.mutate(undefined, {
                onSuccess: () => {
                  toast.show('Backup made');
                  void status.refetch();
                },
                onError: (e) => toast.show(errorMessage(e), 'error'),
              })
            }
          >
            Back up now
          </Button>
        )}
        <Button
          icon="refresh"
          variant="secondary"
          busy={refresh.isPending}
          onClick={() =>
            refresh.mutate(undefined, {
              onSuccess: (r) =>
                toast.show(
                  r.stale
                    ? 'Media server unreachable — kept cached library'
                    : `Library refreshed · ${r.count} movies`,
                  r.stale ? 'error' : 'info',
                ),
              onError: (e) => toast.show(errorMessage(e), 'error'),
            })
          }
        >
          Refresh library now
        </Button>
      </div>
      <p className="field__hint">
        {s.source === 'cloud'
          ? 'New movies appear as soon as the Mac has uploaded them. “Refresh library” checks every movie’s file is in storage.'
          : 'The Jellyfin address is set in the .env file on the host computer (see README). New movies appear automatically within a few minutes of Jellyfin scanning them.'}
      </p>
    </>
  );
}

function Diagnostics({ session }: { session: SessionInfo }) {
  const status = useStatus();
  const caps = detectCapabilities();
  const [errors, setErrors] = useState(recentErrors);
  const toast = useToast();
  const report = {
    app: status.data?.app,
    source: session.source,
    mediaServer: status.data?.mediaServer,
    catalog: status.data?.catalog,
    userAgent: navigator.userAgent,
    screen: `${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}x`,
    capabilities: caps,
    recentErrors: errors.slice(0, 10),
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      toast.show('Diagnostics copied');
    } catch {
      toast.show('Clipboard unavailable — select the text below instead.', 'error');
    }
  };
  return (
    <>
      <dl className="facts facts--settings">
        <div className="facts__row">
          <dt>App version</dt>
          <dd>{status.data ? `${status.data.app.version} · Node ${status.data.app.node}` : '—'}</dd>
        </div>
        <div className="facts__row">
          <dt>Server started</dt>
          <dd>{status.data ? relativeTime(status.data.app.startedAt) : '—'}</dd>
        </div>
        <div className="facts__row">
          <dt>Direct-play video</dt>
          <dd>
            {[
              ...caps.mp4VideoCodecs.map((c) => `${c} (mp4)`),
              ...caps.webmVideoCodecs.map((c) => `${c} (webm)`),
            ].join(', ') || 'none detected'}
          </dd>
        </div>
        <div className="facts__row">
          <dt>Audio</dt>
          <dd>{caps.audioCodecs.join(', ') || 'none detected'}</dd>
        </div>
        <div className="facts__row">
          <dt>Streaming</dt>
          <dd>
            {caps.nativeHls
              ? 'Native HLS (Safari)'
              : caps.mse
                ? 'HLS via Media Source Extensions'
                : 'No adaptive streaming support'}
          </dd>
        </div>
      </dl>
      <h3 className="section-label">Recent errors on this device</h3>
      {errors.length === 0 ? (
        <p className="faint">None recorded since this page was opened.</p>
      ) : (
        <ul className="error-log">
          {errors.map((e, i) => (
            <li key={i}>
              <time className="faint">{new Date(e.at).toLocaleTimeString()}</time> {e.message}
            </li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <Button icon="share" variant="secondary" onClick={copy}>
          Copy diagnostics
        </Button>
        <Button variant="ghost" onClick={() => setErrors(recentErrors())}>
          Reload log
        </Button>
      </div>
    </>
  );
}

export default function SettingsPage({
  session,
  prefs,
}: {
  session: SessionInfo;
  prefs: Preferences;
}) {
  const update = useUpdatePreferences();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const save = (patch: Partial<Preferences>) =>
    update.mutate(patch, { onError: (e) => toast.show(`Not saved: ${errorMessage(e)}`, 'error') });

  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [location.hash]);

  const signOut = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      qc.clear();
      navigate('/login', { replace: true });
    }
  };

  const customAccent = !ACCENT_PRESETS.some((p) => p.value === prefs.accent);
  const cloud = session.source === 'cloud';
  const admin = session.user.isAdmin;

  return (
    <div className="page settings route-enter">
      <header className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p>Changes save automatically and follow you to every device you sign in on.</p>
        </div>
      </header>
      <nav className="settings-nav" aria-label="Settings sections">
        {[
          ...(cloud ? [['profile', 'Profile']] : []),
          ['appearance', 'Appearance'],
          ['home', 'Home'],
          ['library', 'Library'],
          ['playback', 'Playback'],
          ['server', cloud ? 'Status' : 'Server'],
          ...(admin ? [['sharing', cloud ? 'People' : 'Sharing']] : []),
          ...(admin && cloud
            ? [
                ['storage', 'Storage'],
                ['subtitles', 'Subtitles'],
              ]
            : []),
          ['discs', 'Discs'],
          ...(cloud ? [] : [['updates', 'Updates']]),
          ['diagnostics', 'Diagnostics'],
          ['account', 'Account'],
        ].map(([id, label]) => (
          <a key={id} href={`#${id}`} className="chip">
            {label}
          </a>
        ))}
      </nav>

      {cloud && (
        <Section
          id="profile"
          title="Your profile"
          description="How you look on “Who’s watching?”, in the menu and to everyone you watch with."
        >
          <ProfilePanel prefs={prefs} />
        </Section>
      )}

      <Section
        id="appearance"
        title="Appearance"
        description="Make it yours: name, theme and accent colour."
      >
        <AppNameField prefs={prefs} save={save} />
        <div className="field">
          <span className="field__label">Theme</span>
          <div className="theme-options" role="radiogroup" aria-label="Theme">
            {THEMES.map((theme) => (
              <button
                key={theme.value}
                type="button"
                role="radio"
                aria-checked={prefs.theme === theme.value}
                className={`theme-option theme-option--${theme.value}`}
                onClick={() => save({ theme: theme.value })}
              >
                <span className="theme-option__swatch" />
                <span className="theme-option__name">{theme.label}</span>
                <span className="theme-option__desc">{theme.description}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field__label">Accent colour</span>
          <div className="accent-options" role="radiogroup" aria-label="Accent colour">
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                role="radio"
                aria-checked={prefs.accent === preset.value}
                aria-label={preset.name}
                title={preset.name}
                className="accent-swatch"
                style={{ background: preset.value }}
                onClick={() => save({ accent: preset.value })}
              >
                {prefs.accent === preset.value && <Icon name="check" size={16} />}
              </button>
            ))}
            <label
              className={`accent-swatch accent-swatch--custom ${customAccent ? 'is-selected' : ''}`}
              title="Custom colour"
            >
              <span className="visually-hidden">Custom accent colour</span>
              <input
                type="color"
                value={prefs.accent}
                onChange={(e) => save({ accent: e.target.value })}
              />
              <Icon name="plus" size={16} />
            </label>
          </div>
        </div>
        <Switch
          label="Reduce motion"
          description="Turns off hero rotation and animated transitions. Your system setting is always respected."
          checked={prefs.motion === 'reduced'}
          onChange={(v) => save({ motion: v ? 'reduced' : 'system' })}
        />
        <div className="field">
          <span className="field__label">Poster size</span>
          <Segmented
            label="Poster size"
            value={prefs.density}
            onChange={(density) => save({ density })}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'large', label: 'Large' },
            ]}
          />
        </div>
        <TvModeField />
      </Section>

      <Section
        id="home"
        title="Home screen"
        description="Choose which sections appear on Home and in what order."
      >
        <SelectField<Preferences['heroSource']>
          label="Featured movie"
          value={prefs.heroSource}
          onChange={(heroSource) => save({ heroSource })}
          options={[
            { value: 'recentlyAdded', label: 'Recently added' },
            { value: 'random', label: 'Random (changes daily)' },
            { value: 'favorites', label: 'From my favorites' },
            { value: 'continueWatching', label: 'What I’m watching' },
          ]}
        />
        <HomeSectionsEditor prefs={prefs} save={save} />
      </Section>

      <Section id="library" title="Library" description="Defaults for the Browse page.">
        <SelectField<SortField>
          label="Default sort"
          value={prefs.defaultSort}
          options={SORT_OPTIONS}
          onChange={(defaultSort) => save({ defaultSort })}
        />
        <div className="field">
          <span className="field__label">Default direction</span>
          <Segmented
            label="Default sort direction"
            value={prefs.defaultSortDir}
            onChange={(defaultSortDir) => save({ defaultSortDir })}
            options={[
              { value: 'asc', label: 'Ascending' },
              { value: 'desc', label: 'Descending' },
            ]}
          />
        </div>
        <div className="button-row">
          <ButtonLink to="/collections" icon="stack" variant="secondary">
            Manage collections
          </ButtonLink>
        </div>
      </Section>

      <Section
        id="playback"
        title="Playback"
        description="How movies start and how much bandwidth they may use."
      >
        {!cloud && (
          <SelectField<string>
            label="Maximum streaming quality"
            value={String(prefs.playback.maxBitrate ?? 'auto')}
            options={BITRATE_OPTIONS.map((o) => ({
              value: String(o.value ?? 'auto'),
              label: o.label,
            }))}
            onChange={(v) =>
              save({ playback: { ...prefs.playback, maxBitrate: v === 'auto' ? null : Number(v) } })
            }
            hint="Files above this bitrate are converted by Jellyfin to a smaller stream. Lower it for slow Wi-Fi or mobile data."
          />
        )}
        <SelectField<Preferences['playback']['resumeBehavior']>
          label="When a movie is part-watched"
          value={prefs.playback.resumeBehavior}
          onChange={(resumeBehavior) => save({ playback: { ...prefs.playback, resumeBehavior } })}
          options={[
            { value: 'ask', label: 'Show Resume and Start over' },
            { value: 'resume', label: 'Always resume' },
            { value: 'restart', label: 'Always start from the beginning' },
          ]}
        />
        <SelectField<string>
          label="Preferred subtitles"
          value={prefs.playback.subtitleLanguage}
          options={SUBTITLE_LANGUAGE_OPTIONS}
          onChange={(subtitleLanguage) =>
            save({ playback: { ...prefs.playback, subtitleLanguage } })
          }
          hint="Turned on automatically when a movie has subtitles in this language."
        />
        {!cloud && (
          <Switch
            label="Prefer direct play"
            description="Play the original file whenever this device supports it (best quality, least server load). Turn off to always let Jellyfin prepare a compatible stream."
            checked={prefs.playback.preferDirectPlay}
            onChange={(preferDirectPlay) =>
              save({ playback: { ...prefs.playback, preferDirectPlay } })
            }
          />
        )}
      </Section>

      <Section
        id="server"
        title={cloud ? 'Status' : 'Server'}
        description={cloud ? 'Your movies in the cloud.' : 'Connection to your media server.'}
      >
        <ServerStatusPanel />
      </Section>

      {admin && cloud && (
        <Section
          id="sharing"
          title="People"
          description="Wheelhouse is invite-only. Invite people by name; each link works once."
        >
          <PeoplePanel myId={session.user.id} />
        </Section>
      )}

      {admin && cloud && (
        <Section
          id="storage"
          title="Storage and backups"
          description="What your library takes up, and what it costs."
        >
          <StoragePanel />
          <h3 className="section-label">Backups</h3>
          <BackupsPanel />
          <h3 className="section-label">Ratings</h3>
          <RatingsPanel />
        </Section>
      )}

      {admin && cloud && (
        <Section
          id="subtitles"
          title="Subtitles"
          description="English subtitles for each movie: read from the disc, or downloaded from OpenSubtitles."
        >
          <SubtitlesPanel />
        </Section>
      )}

      {admin && !cloud && (
        <Section
          id="sharing"
          title="Share with family"
          description="Let people outside your home watch, privately, over Tailscale. Nothing is put on the public internet."
        >
          <SharePanel appName={prefs.appName} />
          <h3 className="section-label">Streaming limits</h3>
          <LimitsPanel />
        </Section>
      )}

      {admin && !cloud && (
        <Section
          id="updates"
          title="Updates"
          description="Get the newest Wheelhouse. Your library, collections and settings are kept."
        >
          <UpdatesPanel />
        </Section>
      )}

      <Section
        id="discs"
        title="Disc ripping"
        description={
          cloud
            ? 'Insert a DVD in the Mac: it’s ripped, compressed and uploaded here automatically.'
            : 'Insert a DVD and it’s added to your library automatically.'
        }
      >
        {session.ripper ? (
          <ButtonLink to="/rips" icon="disc">
            Open Discs
          </ButtonLink>
        ) : (
          <p className="field__hint">
            Not set up. On the computer running Wheelhouse, run <code>npm run setup:ripper</code>{' '}
            and restart Wheelhouse.
          </p>
        )}
      </Section>

      <Section
        id="diagnostics"
        title="Diagnostics"
        description="Useful when something doesn’t play or won’t connect."
      >
        <Diagnostics session={session} />
      </Section>

      <Section id="account" title="Account">
        <p>
          Signed in as <strong>{session.user.name}</strong>
          {session.user.isAdmin && session.source === 'jellyfin' ? ' (Jellyfin administrator)' : ''}
          .
        </p>
        <div className="button-row">
          <ButtonLink to="/requests" icon="plus" variant="secondary">
            Movie requests
          </ButtonLink>
          <Button icon="logout" variant="secondary" onClick={signOut}>
            Switch profile
          </Button>
        </div>
      </Section>
    </div>
  );
}
