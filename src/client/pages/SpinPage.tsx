import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Movie, MovieQuery, Preferences } from '../../shared/types';
import { MetaLine } from '../components/Hero';
import { Backdrop, Poster, primaryPlay } from '../components/movies';
import { Button, ButtonLink, Segmented, Spinner, StatusView } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { runtimeLabel, selectedDecade } from '../lib/filters';
import { usePrefersReducedMotion } from '../lib/hooks';
import { movieQueryString } from '../lib/queries';
import { slicePath, sliceAt, spinEase, polar, targetRotation, wheelLabel } from '../lib/wheel';
import { queryFromParams } from './BrowsePage';

// Slice colours: the accent plus muted "cinema" tones, with readable label ink.
const SLICES: { fill: string; ink: string }[] = [
  { fill: 'var(--accent)', ink: 'var(--accent-ink)' },
  { fill: '#2a2a31', ink: '#f3efe8' },
  { fill: '#a8513c', ink: '#fbf3ea' },
  { fill: '#1f3b4f', ink: '#eef4f8' },
  { fill: '#e8dfcf', ink: '#1d1a16' },
  { fill: '#4a3a5c', ink: '#f4eefa' },
  { fill: '#5d7a5e', ink: '#f1f6f0' },
  { fill: '#3a2420', ink: '#f6ebe4' },
];
const SPIN_MS = 5600;
const SOUND_KEY = 'wh-wheel-sound';

type Pool = 'unwatched' | 'all' | 'favorites';

/** A short "tick" like a flapper hitting a peg (Web Audio, no files). */
function useTicker(enabled: boolean) {
  const ctx = useRef<AudioContext | null>(null);
  return useCallback(
    (pitch = 1) => {
      if (!enabled) return;
      try {
        ctx.current ??= new AudioContext();
        const audio = ctx.current;
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'triangle';
        osc.frequency.value = 1400 * pitch;
        gain.gain.setValueAtTime(0.07, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.045);
        osc.connect(gain).connect(audio.destination);
        osc.start();
        osc.stop(audio.currentTime + 0.05);
      } catch {
        /* audio unavailable: silent wheel */
      }
    },
    [enabled],
  );
}

function Confetti() {
  // Deterministic "random" scatter (rendering must be pure).
  const noise = (n: number) => {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  const pieces = Array.from({ length: 48 }, (_, i) => ({
    id: i,
    x: (noise(i + 1) - 0.5) * 2,
    y: noise(i + 101),
    r: Math.round(noise(i + 201) * 720 - 360),
    delay: noise(i + 301) * 0.15,
    color: SLICES[i % SLICES.length]!.fill,
  }));
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p) => (
        <span
          key={p.id}
          style={
            {
              '--x': p.x,
              '--y': p.y,
              '--r': `${p.r}deg`,
              animationDelay: `${p.delay}s`,
              background: p.color,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

function Wheel({
  movies,
  rotation,
  winner,
  tick,
}: {
  movies: Movie[];
  rotation: number;
  winner: number | null;
  tick: number;
}) {
  const count = movies.length;
  const max = count <= 6 ? 20 : count <= 8 ? 17 : 13;
  const font = count <= 6 ? 7.2 : count <= 8 ? 6.4 : 5.4;
  return (
    <div className="wheel" aria-hidden="true">
      <div className="wheel__pointer" key={tick} />
      <svg viewBox="-110 -110 220 220" className="wheel__svg">
        <circle r="106" className="wheel__rim" />
        {Array.from({ length: count }, (_, i) => {
          const [x, y] = polar(104, i * (360 / count));
          return <circle key={i} cx={x} cy={y} r="1.8" className="wheel__peg" />;
        })}
        <g style={{ transform: `rotate(${rotation}deg)` }}>
          {movies.map((m, i) => {
            const colour = SLICES[i % SLICES.length]!;
            // Avoid two equal colours meeting where the wheel wraps around.
            const fill =
              i === count - 1 && count % SLICES.length === 1 ? SLICES[2]!.fill : colour.fill;
            const mid = (i + 0.5) * (360 / count);
            return (
              <g key={m.id} className={winner === i ? 'wheel__slice is-winner' : 'wheel__slice'}>
                <path d={slicePath(i, count, 100)} fill={fill} />
                <text
                  transform={`rotate(${mid - 90}) translate(92 0)`}
                  textAnchor="end"
                  dominantBaseline="central"
                  fill={colour.ink}
                  fontSize={font}
                >
                  {wheelLabel(m.title, max)}
                </text>
              </g>
            );
          })}
        </g>
        <circle r="17" className="wheel__hub-ring" />
      </svg>
    </div>
  );
}

export default function SpinPage({ prefs }: { prefs: Preferences }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const reduced = usePrefersReducedMotion();
  const filters = useMemo(() => {
    const q = queryFromParams(params, prefs);
    return { ...q, sort: undefined, dir: undefined, offset: undefined, limit: undefined };
  }, [params, prefs]);
  const pool: Pool = filters.favorite
    ? 'favorites'
    : filters.watched === 'unwatched'
      ? 'unwatched'
      : 'all';
  const count = Math.min(12, Math.max(4, Number(params.get('slots')) || 8));
  const [nonce, setNonce] = useState(0);

  const sample = useQuery({
    queryKey: ['wheel', movieQueryString(filters), count, nonce],
    queryFn: () =>
      api<{ movies: Movie[] }>(`/movies/sample?count=${count}&${movieQueryString(filters)}`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [removed, setRemoved] = useState<string[]>([]);
  const resetRound = () => {
    setRemoved([]);
    setWinner(null);
    setRevealed(false);
  };
  const movies = useMemo(
    () => (sample.data?.movies ?? []).filter((m) => !removed.includes(m.id)),
    [sample.data, removed],
  );

  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [winner, setWinner] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [tick, setTick] = useState(0);
  const resultRef = useRef<HTMLElement>(null);
  const [sound, setSound] = useState(() => {
    try {
      return localStorage.getItem(SOUND_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const playTick = useTicker(sound);
  const frame = useRef<number | null>(null);

  useEffect(() => () => void (frame.current && cancelAnimationFrame(frame.current)), []);

  // On phones the result appears below the wheel: bring it into view.
  useEffect(() => {
    if (revealed)
      resultRef.current?.scrollIntoView({
        block: 'nearest',
        behavior: reduced ? 'auto' : 'smooth',
      });
  }, [revealed, reduced]);

  const spin = useCallback(() => {
    if (spinning || movies.length < 2) return;
    const n = movies.length;
    const chosen = Math.floor(Math.random() * n);
    const start = rotation;
    const end = targetRotation(
      start,
      chosen,
      n,
      reduced ? 1 : 5 + Math.floor(Math.random() * 3),
      Math.random() - 0.5,
    );
    setWinner(null);
    setRevealed(false);
    setSpinning(true);

    const duration = reduced ? 700 : SPIN_MS + Math.random() * 900;
    const began = performance.now();
    let lastSlice = sliceAt(start, n);
    const step = (now: number) => {
      const t = (now - began) / duration;
      const r = start + (end - start) * spinEase(t);
      setRotation(r);
      const slice = sliceAt(r, n);
      if (slice !== lastSlice) {
        lastSlice = slice;
        setTick((x) => x + 1);
        playTick(1 + (1 - Math.min(1, t)) * 0.25);
      }
      if (t < 1) {
        frame.current = requestAnimationFrame(step);
      } else {
        setRotation(end);
        setSpinning(false);
        setWinner(chosen);
        window.setTimeout(() => setRevealed(true), reduced ? 0 : 450);
      }
    };
    frame.current = requestAnimationFrame(step);
  }, [spinning, movies.length, rotation, reduced, playTick]);

  const setPool = (next: Pool) => {
    const p = new URLSearchParams(params);
    p.delete('favorite');
    p.delete('watched');
    if (next === 'unwatched') p.set('watched', 'unwatched');
    if (next === 'favorites') p.set('favorite', '1');
    setParams(p, { replace: true });
    resetRound();
  };

  const setSlots = (n: string) => {
    const p = new URLSearchParams(params);
    p.set('slots', n);
    setParams(p, { replace: true });
    resetRound();
  };

  const toggleSound = () => {
    setSound((s) => {
      try {
        localStorage.setItem(SOUND_KEY, s ? 'off' : 'on');
      } catch {
        /* per-visit only */
      }
      return !s;
    });
  };

  const picked = winner != null ? movies[winner] : null;
  const browseFilters = describeFilters(filters);
  const browseHref = `/browse?${movieQueryString(filters)}`;

  return (
    <div className="page spin route-enter">
      <header className="page-header">
        <div>
          <h1 className="page-title">Spin the wheel</h1>
          <p>Can’t decide? Let fate pick tonight’s movie.</p>
        </div>
      </header>

      <div className="spin__layout">
        <div className="spin__stage">
          {sample.isPending ? (
            <div className="wheel wheel--loading">
              <Spinner size={40} label="Loading movies" />
            </div>
          ) : sample.isError ? (
            <StatusView icon="alert" tone="error" title="Couldn’t load movies">
              <p>{errorMessage(sample.error)}</p>
            </StatusView>
          ) : movies.length < 2 ? (
            <StatusView
              icon="wheel"
              title="Not enough movies to spin"
              action={
                <ButtonLink to="/browse" variant="secondary">
                  Change filters
                </ButtonLink>
              }
            >
              <p>
                The wheel needs at least two movies that match. Try “Everything” or fewer filters.
              </p>
            </StatusView>
          ) : (
            <>
              <Wheel movies={movies} rotation={rotation} winner={winner} tick={tick} />
              <button
                type="button"
                className="wheel__spin"
                onClick={spin}
                disabled={spinning}
                data-tv-focus
                aria-label={spinning ? 'Spinning…' : 'Spin the wheel'}
              >
                {spinning ? '…' : 'Spin'}
              </button>
              <ol className="visually-hidden" aria-label="Movies on the wheel">
                {movies.map((m) => (
                  <li key={m.id}>{m.title}</li>
                ))}
              </ol>
            </>
          )}
          {revealed && !reduced && <Confetti />}
        </div>

        <aside className="spin__side">
          {picked && revealed ? (
            <section
              ref={resultRef}
              className="spin-result"
              aria-live="assertive"
              aria-labelledby="spin-winner"
            >
              <Backdrop
                url={picked.images.backdrop ?? picked.images.poster}
                className="spin-result__art"
                sizes="420px"
              />
              <div className="spin-result__body">
                <p className="eyebrow">Tonight you’re watching</p>
                <div className="spin-result__head">
                  <div className="spin-result__poster">
                    <Poster movie={picked} sizes="96px" />
                  </div>
                  <div>
                    <h2 id="spin-winner" className="spin-result__title display">
                      {picked.title}
                    </h2>
                    <MetaLine movie={picked} />
                  </div>
                </div>
                {picked.overview && <p className="spin-result__overview">{picked.overview}</p>}
                <div className="spin-result__actions">
                  <Button
                    variant="primary"
                    icon="play"
                    onClick={() =>
                      navigate(primaryPlay(picked, prefs.playback.resumeBehavior).href)
                    }
                  >
                    {primaryPlay(picked, prefs.playback.resumeBehavior).label}
                  </Button>
                  <ButtonLink to={`/movie/${picked.id}`} variant="secondary" icon="info">
                    Details
                  </ButtonLink>
                </div>
                <div className="spin-result__again">
                  <button type="button" className="link-btn" onClick={spin}>
                    Spin again
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setRemoved((r) => [...r, picked.id]);
                      setWinner(null);
                      setRevealed(false);
                    }}
                  >
                    Not tonight: take it off the wheel
                  </button>
                </div>
              </div>
            </section>
          ) : (
            <div className="spin__controls">
              <div className="field">
                <span className="field__label">Spin from</span>
                <Segmented<Pool>
                  label="Spin from"
                  value={pool}
                  onChange={setPool}
                  options={[
                    { value: 'unwatched', label: 'Unwatched' },
                    { value: 'all', label: 'Everything' },
                    { value: 'favorites', label: 'Favorites' },
                  ]}
                />
              </div>
              <div className="field">
                <span className="field__label">Movies on the wheel</span>
                <Segmented
                  label="Movies on the wheel"
                  value={String(count)}
                  onChange={setSlots}
                  options={[
                    { value: '6', label: '6' },
                    { value: '8', label: '8' },
                    { value: '12', label: '12' },
                  ]}
                />
              </div>
              {browseFilters && (
                <p className="spin__filters">
                  Only {browseFilters}. <Link to={browseHref}>Change</Link>
                </p>
              )}
              <div className="spin__tools">
                <Button
                  variant="ghost"
                  icon="shuffle"
                  disabled={spinning}
                  onClick={() => {
                    resetRound();
                    setNonce((n) => n + 1);
                  }}
                >
                  New movies
                </Button>
                <Button
                  variant="ghost"
                  icon={sound ? 'volume' : 'mute'}
                  onClick={toggleSound}
                  aria-pressed={sound}
                >
                  Sound {sound ? 'on' : 'off'}
                </Button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** "comedy, under 90 min, from the 1960s" for filters carried over from Browse. */
function describeFilters(q: MovieQuery): string | null {
  const parts: string[] = [];
  if (q.q) parts.push(`matching “${q.q}”`);
  if (q.genres?.length) parts.push(q.genres.join(' or ').toLowerCase());
  if (q.directors?.length) parts.push(`directed by ${q.directors.join(' or ')}`);
  const runtime = runtimeLabel(q);
  if (runtime) parts.push(runtime.toLowerCase());
  const decade = selectedDecade(q);
  if (decade != null) parts.push(`from the ${decade}s`);
  else if (q.yearMin != null || q.yearMax != null)
    parts.push(`from ${q.yearMin ?? '…'}–${q.yearMax ?? '…'}`);
  if (q.countries?.length) parts.push(`from ${q.countries.join(' or ')}`);
  return parts.length ? parts.join(', ') : null;
}
