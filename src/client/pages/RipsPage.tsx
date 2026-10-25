import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { RipCandidate, RipJob, SessionInfo } from '../../shared/types';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { Button, ButtonLink, PageLoader, ProgressBar, StatusView } from '../components/ui';
import { errorMessage } from '../lib/api';
import { formatBytes, formatRuntime, relativeTime } from '../lib/format';
import { searchRipCandidates, useRipActions, useRips } from '../lib/queries';

const STATUS_LABEL: Record<RipJob['status'], string> = {
  scanning: 'Reading the disc',
  needs_choice: 'Needs you: pick the movie',
  needs_episodes: 'Needs you: check the episodes',
  ripping: 'Ripping',
  ripped: 'Waiting to compress',
  encoding: 'Compressing',
  needs_name: 'Needs you: confirm the name',
  filing: 'Filing',
  importing: 'Adding to the library',
  done: 'Ready to watch',
  failed: 'Problem',
};

const candidateLabel = (c: RipCandidate) => (c.year ? `${c.title} (${c.year})` : c.title);

function jobName(job: RipJob) {
  const name = job.title
    ? job.year
      ? `${job.title} (${job.year})`
      : job.title
    : (job.guess ?? job.discLabel);
  return job.kind === 'tv' && job.season != null ? `${name} · Season ${job.season}` : name;
}

/** Correct Wheelhouse's guess about what kind of disc this is. */
function KindSwitch({ job }: { job: RipJob }) {
  const { kind } = useRipActions();
  const toast = useToast();
  const tv = job.kind === 'tv';
  // Already ripped as a movie: it gets ripped again, as episodes, when the disc goes back in.
  const again = !tv && ['needs_name', 'done', 'failed'].includes(job.status);
  return (
    <Button
      variant="ghost"
      icon={tv ? 'film' : 'tv'}
      busy={kind.isPending}
      onClick={async () => {
        if (
          again &&
          !window.confirm(
            job.status === 'done'
              ? 'Rip this disc again as TV episodes? Put it back in the drive afterwards. The movie file already on the drive isn’t touched: remove it from the library yourself.'
              : 'Rip this disc again as TV episodes? Put it back in the drive afterwards.',
          )
        )
          return;
        try {
          await kind.mutateAsync({ id: job.id, kind: tv ? 'movie' : 'tv' });
          if (again) toast.show('Put the disc back in to rip it as TV episodes.');
        } catch (error) {
          toast.show(errorMessage(error), 'error');
        }
      }}
    >
      {tv ? 'It’s a movie, not TV' : 'It’s a TV disc'}
    </Button>
  );
}

interface EpisodeRow {
  titleIndex: number;
  durationSeconds: number;
  sizeBytes: number;
  chapters: number;
  checked: boolean;
  episode: number;
}

/** Confirm the show, season and which disc titles are which episodes. */
function PickEpisodes({ job, canSearch }: { job: RipJob; canSearch: boolean }) {
  const { episodes: start } = useRipActions();
  const toast = useToast();
  const [show, setShow] = useState<RipCandidate | null>(() => {
    if (!job.title) return null;
    return (
      job.candidates.find((c) => c.title === job.title && c.year === job.year) ?? {
        title: job.title,
        year: job.year,
        tmdbId: null,
        imdbId: null,
      }
    );
  });
  const [results, setResults] = useState<RipCandidate[]>(job.candidates);
  const [query, setQuery] = useState(job.guess ?? '');
  const [searching, setSearching] = useState(false);
  const [manual, setManual] = useState({ title: job.guess ?? '', year: '' });
  const [season, setSeason] = useState(String(job.season ?? 1));
  const [rows, setRows] = useState<EpisodeRow[]>(() =>
    [...job.discTitles]
      .sort((a, b) => a.index - b.index)
      .map((t) => {
        const ep = job.episodes.find((e) => e.titleIndex === t.index);
        return {
          titleIndex: t.index,
          durationSeconds: t.durationSeconds,
          sizeBytes: t.sizeBytes,
          chapters: t.chapters,
          checked: Boolean(ep),
          episode: ep?.episode ?? 0,
        };
      }),
  );
  const [first, setFirst] = useState(() =>
    String(job.episodes.length ? Math.min(...job.episodes.map((e) => e.episode)) : 1),
  );

  const chosen = rows.filter((r) => r.checked);
  const numbers = chosen.map((r) => r.episode);
  const duplicate = numbers.find((n, i) => numbers.indexOf(n) !== i);
  const seasonNumber = Number(season);
  const problem = !show
    ? 'Choose the show first.'
    : !season || !Number.isInteger(seasonNumber) || seasonNumber < 0 || seasonNumber > 99
      ? 'Enter the season number.'
      : chosen.length === 0
        ? 'Tick at least one episode.'
        : chosen.some((r) => !(r.episode >= 1))
          ? 'Give every ticked title an episode number.'
          : duplicate
            ? `Episode ${duplicate} is used twice.`
            : null;

  /** Number the ticked titles in disc order, starting from `from`. */
  const renumber = (list: EpisodeRow[], from: number) => {
    let n = from;
    return list.map((r) => (r.checked ? { ...r, episode: n++ } : r));
  };
  const firstNumber = Math.max(1, Number(first) || 1);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const found = await searchRipCandidates(query.trim(), 'tv');
      setResults(found.results);
      if (found.results.length === 0) toast.show('No shows found. Try another spelling.');
    } catch (error) {
      toast.show(errorMessage(error), 'error');
    } finally {
      setSearching(false);
    }
  };

  const submit = async () => {
    if (problem || !show) return;
    try {
      await start.mutateAsync({
        id: job.id,
        show,
        season: seasonNumber,
        episodes: chosen.map((r) => ({ titleIndex: r.titleIndex, episode: r.episode })),
      });
      toast.show(`Ripping ${chosen.length === 1 ? '1 episode' : `${chosen.length} episodes`}`);
    } catch (error) {
      toast.show(errorMessage(error), 'error');
    }
  };

  return (
    <div className="rip__action rip-tv">
      <div className="rip-tv__step">
        <h3 className="rip-tv__label">Show</h3>
        {show ? (
          <div className="rip-tv__chosen">
            <strong>{candidateLabel(show)}</strong>
            <Button variant="ghost" size="sm" onClick={() => setShow(null)}>
              Change
            </Button>
          </div>
        ) : (
          <>
            {results.length > 0 && (
              <ul className="rip__candidates" aria-label="Possible shows">
                {results.map((c) => (
                  <li key={`${c.tmdbId ?? c.title}-${c.year}`}>
                    <button type="button" className="chip" onClick={() => setShow(c)}>
                      {candidateLabel(c)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {canSearch && (
              <form className="rip__form" onSubmit={search}>
                <input
                  className="input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search for the show"
                  aria-label="Search for the show"
                />
                <Button type="submit" icon="search" busy={searching}>
                  Search
                </Button>
              </form>
            )}
            <details className="rip__manual" open={!canSearch}>
              <summary>Type the name myself</summary>
              <form
                className="rip__form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (manual.title.trim()) {
                    setShow({
                      title: manual.title.trim(),
                      year: Number(manual.year) || null,
                      tmdbId: null,
                      imdbId: null,
                    });
                  }
                }}
              >
                <input
                  className="input"
                  value={manual.title}
                  onChange={(e) => setManual({ ...manual, title: e.target.value })}
                  placeholder="Show name"
                  aria-label="Show name"
                />
                <input
                  className="input rip__year"
                  value={manual.year}
                  onChange={(e) =>
                    setManual({ ...manual, year: e.target.value.replace(/\D/g, '').slice(0, 4) })
                  }
                  placeholder="Year"
                  aria-label="Year the show started"
                  inputMode="numeric"
                />
                <Button type="submit" disabled={!manual.title.trim()}>
                  Use this name
                </Button>
              </form>
            </details>
          </>
        )}
      </div>

      <div className="rip-tv__numbers">
        <label className="rip-tv__field">
          <span>Season</span>
          <input
            className="input"
            value={season}
            onChange={(e) => setSeason(e.target.value.replace(/\D/g, '').slice(0, 2))}
            inputMode="numeric"
          />
        </label>
        <label className="rip-tv__field">
          <span>First episode</span>
          <input
            className="input"
            value={first}
            onChange={(e) => {
              const value = e.target.value.replace(/\D/g, '').slice(0, 3);
              setFirst(value);
              setRows((list) => renumber(list, Math.max(1, Number(value) || 1)));
            }}
            inputMode="numeric"
          />
        </label>
      </div>

      <div className="rip-tv__step">
        <h3 className="rip-tv__label">Episodes on this disc</h3>
        <p className="faint">
          Wheelhouse ticked the titles that look like episodes and numbered them in disc order.
          Discs sometimes store episodes out of order: if a number is wrong, fix it here before
          ripping.
        </p>
        <div className="rip-tv__table-wrap">
          <table className="rip-tv__table">
            <thead>
              <tr>
                <th scope="col">Rip</th>
                <th scope="col">Title</th>
                <th scope="col">Length</th>
                <th scope="col">Episode</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.titleIndex} className={r.checked ? '' : 'is-off'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.checked}
                      aria-label={`Rip title ${r.titleIndex + 1}`}
                      onChange={(e) =>
                        setRows((list) =>
                          renumber(
                            list.map((x) =>
                              x.titleIndex === r.titleIndex
                                ? { ...x, checked: e.target.checked }
                                : x,
                            ),
                            firstNumber,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    Title {r.titleIndex + 1}
                    <span className="faint">
                      {' '}
                      · {r.chapters} ch · {formatBytes(r.sizeBytes)}
                    </span>
                  </td>
                  <td>{formatRuntime(Math.round(r.durationSeconds / 60))}</td>
                  <td>
                    {r.checked ? (
                      <input
                        className="input rip-tv__episode"
                        value={r.episode || ''}
                        aria-label={`Episode number for title ${r.titleIndex + 1}`}
                        inputMode="numeric"
                        onChange={(e) => {
                          const n = Number(e.target.value.replace(/\D/g, '').slice(0, 3)) || 0;
                          setRows((list) =>
                            list.map((x) =>
                              x.titleIndex === r.titleIndex ? { ...x, episode: n } : x,
                            ),
                          );
                        }}
                      />
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {problem && <p className="faint">{problem}</p>}
      <Button
        variant="primary"
        icon="disc"
        disabled={Boolean(problem)}
        busy={start.isPending}
        onClick={submit}
      >
        {chosen.length === 1 ? 'Rip 1 episode' : `Rip ${chosen.length} episodes`}
      </Button>
    </div>
  );
}

/** Where each episode of a TV disc is up to. */
function EpisodeStates({ job }: { job: RipJob }) {
  const label = { pending: 'waiting', ripped: 'ripped', encoded: 'compressed', filed: 'filed' };
  const sorted = useMemo(() => [...job.episodes].sort((a, b) => a.episode - b.episode), [job]);
  return (
    <ul className="rip-tv__states" aria-label="Episodes">
      {sorted.map((ep) => (
        <li key={ep.titleIndex} className={`rip-tv__state rip-tv__state--${ep.state}`}>
          E{ep.episode} <span className="faint">{label[ep.state]}</span>
        </li>
      ))}
    </ul>
  );
}

function ChooseTitle({ job }: { job: RipJob }) {
  const { choose } = useRipActions();
  const toast = useToast();
  const [selected, setSelected] = useState<number | null>(null);
  const submit = async () => {
    if (selected == null) return;
    try {
      await choose.mutateAsync({ id: job.id, titleIndex: selected });
    } catch (error) {
      toast.show(errorMessage(error), 'error');
    }
  };
  return (
    <div className="rip__action">
      <p className="faint">
        Tip: the right one usually has the most chapters. If unsure, check the disc on a site like
        the MakeMKV forum, or try one and see.
      </p>
      <div className="rip__choices" role="radiogroup" aria-label="Titles on the disc">
        {job.discTitles.map((t) => (
          <button
            key={t.index}
            type="button"
            role="radio"
            aria-checked={selected === t.index}
            className={`rip__choice ${selected === t.index ? 'is-selected' : ''}`}
            onClick={() => setSelected(t.index)}
          >
            <strong>Title {t.index + 1}</strong>
            <span>
              {formatRuntime(Math.round(t.durationSeconds / 60))} · {formatBytes(t.sizeBytes)} ·{' '}
              {t.chapters} chapters
            </span>
          </button>
        ))}
      </div>
      <Button
        variant="primary"
        icon="disc"
        disabled={selected == null}
        busy={choose.isPending}
        onClick={submit}
      >
        Rip this one
      </Button>
    </div>
  );
}

function ConfirmName({ job, canSearch }: { job: RipJob; canSearch: boolean }) {
  const { name } = useRipActions();
  const toast = useToast();
  const [results, setResults] = useState<RipCandidate[]>(job.candidates);
  const [query, setQuery] = useState(job.guess ?? '');
  const [searching, setSearching] = useState(false);
  const [title, setTitle] = useState(job.title ?? job.guess ?? '');
  const [year, setYear] = useState(job.year ? String(job.year) : '');

  const pick = async (movie: RipCandidate) => {
    try {
      await name.mutateAsync({ id: job.id, movie });
      toast.show(`Filing ${candidateLabel(movie)}`);
    } catch (error) {
      toast.show(errorMessage(error), 'error');
    }
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const found = await searchRipCandidates(query.trim());
      setResults(found.results);
      if (found.results.length === 0) toast.show('No movies found. Try another spelling.');
    } catch (error) {
      toast.show(errorMessage(error), 'error');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="rip__action">
      {results.length > 0 && (
        <ul className="rip__candidates" aria-label="Possible matches">
          {results.map((c) => (
            <li key={`${c.tmdbId ?? c.title}-${c.year}`}>
              <button
                type="button"
                className="chip"
                onClick={() => pick(c)}
                disabled={name.isPending}
              >
                {candidateLabel(c)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {results.length === 0 && job.guess && job.status !== 'failed' && (
        <Button
          variant="primary"
          icon="check"
          busy={name.isPending}
          onClick={() => pick({ title: job.guess!, year: null, tmdbId: null, imdbId: null })}
        >
          Use “{job.guess}”
        </Button>
      )}
      {canSearch && (
        <form className="rip__form" onSubmit={search}>
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for the movie"
            aria-label="Search for the movie"
          />
          <Button type="submit" icon="search" busy={searching}>
            Search
          </Button>
        </form>
      )}
      <details className="rip__manual">
        <summary>Type the name myself</summary>
        <form
          className="rip__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) {
              void pick({
                title: title.trim(),
                year: Number(year) || null,
                tmdbId: null,
                imdbId: null,
              });
            }
          }}
        >
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            aria-label="Title"
          />
          <input
            className="input rip__year"
            value={year}
            onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="Year"
            aria-label="Year"
            inputMode="numeric"
          />
          <Button type="submit" variant="primary" disabled={!title.trim()} busy={name.isPending}>
            Use this name
          </Button>
        </form>
      </details>
    </div>
  );
}

function RipCard({ job, canSearch }: { job: RipJob; canSearch: boolean }) {
  const { retry, dismiss } = useRipActions();
  const toast = useToast();
  const working = job.status === 'ripping' || job.status === 'encoding';
  const attention =
    job.status === 'needs_choice' ||
    job.status === 'needs_episodes' ||
    job.status === 'needs_name' ||
    job.status === 'failed';

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      toast.show(errorMessage(error), 'error');
    }
  };

  return (
    <li className={`rip ${attention ? 'rip--attention' : ''} rip--${job.status}`}>
      <div className="rip__head">
        <span className="rip__icon" aria-hidden="true">
          <Icon
            name={
              job.status === 'done'
                ? 'check'
                : job.status === 'failed'
                  ? 'alert'
                  : job.kind === 'tv'
                    ? 'tv'
                    : 'disc'
            }
            size={20}
          />
        </span>
        <div className="rip__titles">
          <h2 className="rip__name">{jobName(job)}</h2>
          <p className="rip__meta">
            <span className="rip__status">{STATUS_LABEL[job.status]}</span>
            <span className="faint">
              {' '}
              · disc “{job.discLabel}” · {relativeTime(job.finishedAt ?? job.createdAt)}
            </span>
          </p>
        </div>
        <div className="rip__buttons">
          {job.status === 'done' && job.movieId && (
            <ButtonLink
              to={job.kind === 'tv' ? `/show/${job.movieId}` : `/movie/${job.movieId}`}
              variant="primary"
              icon="play"
            >
              Open
            </ButtonLink>
          )}
          {job.status === 'failed' && (
            <Button
              icon="refresh"
              busy={retry.isPending}
              onClick={() => run(() => retry.mutateAsync(job.id))}
            >
              Retry
            </Button>
          )}
          {(job.status === 'scanning' || job.status === 'ripping') && (
            <Button
              variant="ghost"
              busy={dismiss.isPending}
              onClick={() => {
                if (!window.confirm('Stop this disc? It will be ejected.')) return;
                void run(() => dismiss.mutateAsync(job.id));
              }}
            >
              Stop
            </Button>
          )}
          {(job.status === 'done' || attention) && (
            <Button
              variant="ghost"
              busy={dismiss.isPending}
              onClick={() => {
                const leftover = job.status !== 'done';
                if (
                  leftover &&
                  !window.confirm(
                    'Dismiss this rip? Any files it left in the Rips folder are deleted.',
                  )
                ) {
                  return;
                }
                void run(() => dismiss.mutateAsync(job.id));
              }}
            >
              {job.status === 'done' ? 'Clear' : 'Dismiss'}
            </Button>
          )}
        </div>
      </div>
      {working && (
        <ProgressBar value={job.progress ?? 0} label={`${STATUS_LABEL[job.status]} progress`} />
      )}
      {working && job.progress != null && (
        <p className="rip__pct faint">{Math.round(job.progress * 100)}%</p>
      )}
      {job.message && (
        <p className={job.status === 'failed' ? 'rip__error' : 'rip__message'}>{job.message}</p>
      )}
      {job.kind === 'tv' && job.status !== 'needs_episodes' && job.episodes.length > 0 && (
        <EpisodeStates job={job} />
      )}
      {job.status === 'needs_choice' && <ChooseTitle job={job} />}
      {job.status === 'needs_episodes' && <PickEpisodes job={job} canSearch={canSearch} />}
      {(job.status === 'needs_choice' ||
        job.status === 'needs_episodes' ||
        (job.kind === 'movie' && ['needs_name', 'done', 'failed'].includes(job.status))) && (
        <KindSwitch job={job} />
      )}
      {(job.status === 'needs_name' || (job.status === 'failed' && job.kind !== 'tv')) && (
        <ConfirmName job={job} canSearch={canSearch} />
      )}
    </li>
  );
}

export function RipsPage({ session }: { session: SessionInfo }) {
  const rips = useRips(Boolean(session.ripper));
  const { testNotification, eject } = useRipActions();
  const toast = useToast();

  if (!session.ripper) {
    return (
      <div className="page">
        <StatusView icon="disc" title="Disc ripping isn’t set up">
          <p>
            On the computer running Wheelhouse, run <code>npm run setup:ripper</code>, then restart
            Wheelhouse. After that, inserting a DVD is all it takes.
          </p>
        </StatusView>
      </div>
    );
  }
  if (rips.isPending) return <PageLoader label="Loading rips" />;
  if (rips.isError) {
    return (
      <div className="page">
        <StatusView icon="alert" tone="error" title="Couldn’t load rips">
          <p>{errorMessage(rips.error)}</p>
        </StatusView>
      </div>
    );
  }
  const { health, jobs, mac } = rips.data;

  return (
    <div className="page rips route-enter">
      <header className="page-header">
        <div>
          <h1 className="page-title">Discs</h1>
          <p>
            Insert a DVD (a movie or a TV season) and Wheelhouse rips, compresses, names and adds it
            to your library.
          </p>
        </div>
        <div className="page-header__actions">
          <Button
            icon="disc"
            busy={eject.isPending}
            disabled={Boolean(mac && !mac.online)}
            onClick={async () => {
              try {
                await eject.mutateAsync();
                toast.show(mac ? 'Sent to the Mac: the disc will come out.' : 'Disc ejected.');
              } catch (error) {
                toast.show(errorMessage(error), 'error');
              }
            }}
          >
            Eject disc
          </Button>
          <Button
            icon="check"
            busy={testNotification.isPending}
            onClick={async () => {
              try {
                await testNotification.mutateAsync();
                toast.show('Test notification sent. Check your phone.');
              } catch (error) {
                toast.show(errorMessage(error), 'error');
              }
            }}
          >
            Test notification
          </Button>
        </div>
      </header>

      {mac && !mac.online && (
        <div className="rips__notice rips__notice--error" role="status">
          <Icon name="offline" size={18} />
          <div>
            <strong>Mac offline.</strong>{' '}
            {mac.lastSeen
              ? `Last heard from ${relativeTime(mac.lastSeen)}. This is what it was doing then.`
              : 'The Mac hasn’t reported in yet.'}{' '}
            Switch it on (and wake it up) to rip discs; movies already in the library play without
            it.
          </div>
        </div>
      )}
      {health.problems.length > 0 && (
        <div className="rips__notice rips__notice--error" role="alert">
          <Icon name="alert" size={18} />
          <div>
            <strong>Ripping won’t work until this is fixed:</strong>
            <ul>
              {health.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {health.warnings.length > 0 && (
        <div className="rips__notice">
          <Icon name="info" size={18} />
          <ul>
            {health.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {jobs.length === 0 ? (
        <StatusView icon="disc" title="No discs yet">
          <p>
            Put a DVD in the drive connected to the Wheelhouse computer. It appears here within a
            few seconds, and you’ll get a notification when it’s ready to watch. For a TV season
            disc, you’ll be asked to check the episode numbers first.
          </p>
          <p className="faint">
            Keep the MakeMKV app closed. It locks the drive. <Link to="/">Back to Home</Link>
          </p>
        </StatusView>
      ) : (
        <ul className="rips__list">
          {jobs.map((job) => (
            <RipCard key={job.id} job={job} canSearch={health.canSearch} />
          ))}
        </ul>
      )}
    </div>
  );
}
