import { useState, type FormEvent } from 'react';
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
  if (job.title) return job.year ? `${job.title} (${job.year})` : job.title;
  return job.guess ?? job.discLabel;
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
      {results.length === 0 && job.guess && (
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
    job.status === 'needs_choice' || job.status === 'needs_name' || job.status === 'failed';

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
            name={job.status === 'done' ? 'check' : job.status === 'failed' ? 'alert' : 'disc'}
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
            <ButtonLink to={`/movie/${job.movieId}`} variant="primary" icon="play">
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
      {job.status === 'needs_choice' && <ChooseTitle job={job} />}
      {job.status === 'needs_name' && <ConfirmName job={job} canSearch={canSearch} />}
    </li>
  );
}

export function RipsPage({ session }: { session: SessionInfo }) {
  const rips = useRips(Boolean(session.ripper));
  const { testNotification } = useRipActions();
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
  const { health, jobs } = rips.data;

  return (
    <div className="page rips route-enter">
      <header className="page-header">
        <div>
          <h1 className="page-title">Discs</h1>
          <p>Insert a DVD and Wheelhouse rips, compresses, names and adds it to your library.</p>
        </div>
        <div className="page-header__actions">
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
            few seconds, and you’ll get a notification when the movie is ready to watch.
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
