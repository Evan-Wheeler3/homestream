// The theater's on-screen pieces: the box office, the concession stand, your
// snacks, the controls while you're seated, who's here, the arcade, and the
// touch controls for phones.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ARCADE_GAMES,
  positionAt,
  SNACKS,
  type ArcadeGameId,
  type Hands,
  type HighScore,
  type Showing,
  type SnackId,
  type TheaterPlayer,
} from '../../shared/theater';
import { ARCADE_H, ARCADE_W, createGame, type ArcadeGame, type ArcadeInput } from './arcade';
import { play } from './audio';
import type { Movie } from '../../shared/types';
import { Icon } from '../components/Icon';
import { Button, Dialog, IconButton, Segmented } from '../components/ui';
import { formatClock } from '../lib/format';
import { sizedImage } from '../lib/images';

export interface TicketChoice {
  movie: Movie;
  shared: boolean;
  startSeconds: number;
  /** The theater showing it today, if it's in the lineup. */
  theater?: number;
}

export function BoxOffice({
  open,
  movies,
  lineup,
  preselect,
  showings,
  othersHere,
  onClose,
  onBuy,
  onJoin,
}: {
  open: boolean;
  movies: Movie[];
  /** Today's movie in each theater (index 0 is Theater 1). */
  lineup: (string | null)[];
  preselect: string | null;
  showings: Showing[];
  othersHere: boolean;
  onClose(): void;
  onBuy(choice: TicketChoice): void;
  onJoin(theater: number): void;
}) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(preselect);
  const [shared, setShared] = useState<'together' | 'private'>(othersHere ? 'together' : 'private');
  const [from, setFrom] = useState<'resume' | 'start'>('resume');
  const sorted = useMemo(
    () =>
      [...movies].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      ),
    [movies],
  );
  const needle = q.trim().toLowerCase();
  const list = needle ? sorted.filter((m) => m.title.toLowerCase().includes(needle)) : sorted;
  const movie = movies.find((m) => m.id === (picked ?? preselect));
  const joinable = showings.filter((s) => s.shared && s.status !== 'ended');
  const resume = movie && movie.user.positionSeconds > 60 ? movie.user.positionSeconds : 0;
  const lineupIndex = movie ? lineup.indexOf(movie.id) : -1;
  const today = lineup
    .map((id, i) => ({ theater: i + 1, movie: movies.find((m) => m.id === id) }))
    .filter((x): x is { theater: number; movie: Movie } => Boolean(x.movie));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Box office"
      description="Pick a movie from today’s lineup, or anything from the collection."
      size="lg"
      footer={
        movie ? (
          <>
            <Button variant="ghost" onClick={() => setPicked(null)}>
              Back to the list
            </Button>
            <Button
              variant="primary"
              icon="film"
              onClick={() =>
                onBuy({
                  movie,
                  shared: shared === 'together',
                  startSeconds: from === 'resume' ? resume : 0,
                  theater: lineupIndex >= 0 ? lineupIndex + 1 : undefined,
                })
              }
            >
              Get a ticket
            </Button>
          </>
        ) : undefined
      }
    >
      {movie ? (
        <div className="boxoffice__chosen">
          {movie.images.poster && (
            <img className="boxoffice__poster" src={sizedImage(movie.images.poster, 240)} alt="" />
          )}
          <div className="boxoffice__options">
            <h3 className="boxoffice__title">
              {movie.title} {movie.year && <span>({movie.year})</span>}
            </h3>
            {movie.runtimeMinutes && <p className="muted">{movie.runtimeMinutes} min</p>}
            <p className="boxoffice__where">
              {lineupIndex >= 0
                ? `🎟️ Showing today in Theater ${lineupIndex + 1}`
                : '🎟️ A special screening: we’ll find it a free theater'}
            </p>
            <p className="boxoffice__label">Showing</p>
            <Segmented
              label="Showing"
              value={shared}
              onChange={setShared}
              options={[
                { value: 'together', label: 'Watch together' },
                { value: 'private', label: 'Private screening' },
              ]}
            />
            <p className="muted boxoffice__hint">
              {shared === 'together'
                ? 'Anyone in the building can get a ticket to the same showing and watch with you, in step.'
                : 'Your own theater. It pauses when you stand up and carries on when you sit back down.'}
            </p>
            {resume > 0 && (
              <>
                <p className="boxoffice__label">Start</p>
                <Segmented
                  label="Start"
                  value={from}
                  onChange={setFrom}
                  options={[
                    { value: 'resume', label: `Resume at ${formatClock(resume)}` },
                    { value: 'start', label: 'From the beginning' },
                  ]}
                />
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          {today.length > 0 && (
            <section className="boxoffice__section">
              <h3 className="boxoffice__label">Today’s lineup</h3>
              <ul className="boxoffice__lineup">
                {today.map(({ theater, movie: m }) => (
                  <li key={theater}>
                    <button type="button" className="lineup__card" onClick={() => setPicked(m.id)}>
                      {m.images.poster ? (
                        <img src={sizedImage(m.images.poster, 160)} alt="" loading="lazy" />
                      ) : (
                        <span className="boxoffice__noposter" />
                      )}
                      <span className="lineup__theater">Theater {theater}</span>
                      <span className="lineup__title">{m.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {joinable.length > 0 && (
            <section className="boxoffice__section">
              <h3 className="boxoffice__label">Now showing together</h3>
              <ul className="boxoffice__joins">
                {joinable.map((s) => (
                  <li key={s.theater}>
                    <span>
                      <strong>Theater {s.theater}</strong> · {s.title}
                      <span className="muted"> · {s.hostName}’s showing</span>
                    </span>
                    <Button size="sm" variant="primary" onClick={() => onJoin(s.theater)}>
                      Join
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <h3 className="boxoffice__label">Everything in the collection</h3>
          <input
            className="input boxoffice__search"
            type="search"
            placeholder={`Search ${movies.length} movies`}
            aria-label="Search movies"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="boxoffice__list">
            {list.map((m) => (
              <li key={m.id}>
                <button type="button" className="boxoffice__movie" onClick={() => setPicked(m.id)}>
                  {m.images.poster ? (
                    <img src={sizedImage(m.images.poster, 80)} alt="" loading="lazy" />
                  ) : (
                    <span className="boxoffice__noposter" />
                  )}
                  <span>
                    {m.title}
                    {m.year && <span className="muted"> ({m.year})</span>}
                  </span>
                </button>
              </li>
            ))}
            {!list.length && <li className="muted">No movies match “{q}”.</li>}
          </ul>
        </>
      )}
    </Dialog>
  );
}

/** The concession stand's menu: buy with your Wheelhouse Bucks; snacks go in your hands. */
export function Concessions({
  open,
  wallet,
  hands,
  onClose,
  onBuy,
}: {
  open: boolean;
  wallet: number;
  hands: Hands;
  onClose(): void;
  onBuy(snack: SnackId): void;
}) {
  const free = hands.filter((h) => !h).length;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Concessions"
      description={`You have $${wallet} in Wheelhouse Bucks · ${
        free === 0 ? 'your hands are full' : free === 1 ? 'one hand free' : 'both hands free'
      }`}
    >
      <ul className="snacks">
        {SNACKS.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className="snacks__item"
              disabled={!free || wallet < s.price}
              onClick={() => onBuy(s.id)}
            >
              <span className="snacks__emoji" aria-hidden="true">
                {s.emoji}
              </span>
              {s.label}
              <span className="snacks__price">${s.price}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="muted snacks__hint">
        Snacks go in your hands. Sit down and they go in your seat’s cupholders. Eat or drink with
        the buttons by your hands (or 1 and 2), and toss the empties in a bin.
      </p>
    </Dialog>
  );
}

/** Your two hands, and what's in them. */
export function HandsBar({
  hands,
  keys,
  onUse,
  onToss,
}: {
  hands: Hands;
  keys: boolean;
  onUse(hand: 0 | 1): void;
  onToss(hand: 0 | 1): void;
}) {
  if (!hands.some(Boolean)) return null;
  return (
    <div className="hands" role="group" aria-label="Your snacks">
      {hands.map((h, i) => {
        const hand = i as 0 | 1;
        if (!h)
          return <span key={i} className="hands__slot hands__slot--empty" aria-hidden="true" />;
        const snack = SNACKS.find((s) => s.id === h.id)!;
        const verb = h.level <= 0 ? 'Empty' : snack.kind === 'drink' ? 'Drink' : 'Eat';
        return (
          <span key={i} className="hands__slot">
            <button
              type="button"
              className="hands__use"
              disabled={h.level <= 0}
              aria-label={`${verb} (${snack.label})`}
              onClick={() => onUse(hand)}
            >
              <span className="hands__emoji" aria-hidden="true">
                {snack.emoji}
              </span>
              <span className="hands__bar" aria-hidden="true">
                <span style={{ width: `${Math.round(h.level * 100)}%` }} />
              </span>
              <span className="hands__verb">
                {keys && <kbd>{hand + 1}</kbd>} {verb}
              </span>
            </button>
            <button
              type="button"
              className="hands__toss"
              aria-label={`Throw away the ${snack.label.toLowerCase()}`}
              onClick={() => onToss(hand)}
            >
              ✕
            </button>
          </span>
        );
      })}
    </div>
  );
}

export function SeatControls({
  showing,
  now,
  duration,
  canControl,
  volume,
  muted,
  captions,
  hasCaptions,
  onToggle,
  onSeek,
  onVolume,
  onMute,
  onCaptions,
  onFullscreen,
  onPlayer,
  onStand,
}: {
  showing: Showing;
  now: number;
  duration: number;
  canControl: boolean;
  volume: number;
  muted: boolean;
  captions: boolean;
  hasCaptions: boolean;
  onToggle(): void;
  onSeek(seconds: number): void;
  onVolume(v: number): void;
  onMute(): void;
  onCaptions(): void;
  onFullscreen(): void;
  onPlayer(): void;
  onStand(): void;
}) {
  const position = positionAt(showing, now);
  const [scrub, setScrub] = useState<number | null>(null);
  const playing = showing.status === 'playing';
  return (
    <div className="seatbar" role="group" aria-label="Movie controls">
      <div className="seatbar__row">
        <IconButton
          icon={playing ? 'pause' : 'play'}
          label={playing ? 'Pause' : 'Play'}
          variant="filled"
          disabled={!canControl}
          onClick={onToggle}
        />
        <IconButton
          icon="rewind"
          label="Back 10 seconds"
          disabled={!canControl}
          onClick={() => onSeek(Math.max(0, position - 10))}
        />
        <IconButton
          icon="forward"
          label="Forward 30 seconds"
          disabled={!canControl}
          onClick={() => onSeek(position + 30)}
        />
        <span className="seatbar__time">
          {formatClock(scrub ?? position)}
          {duration > 0 && <span className="muted"> / {formatClock(duration)}</span>}
        </span>
        <input
          className="seatbar__scrub"
          type="range"
          min={0}
          max={Math.max(1, duration)}
          step={1}
          value={Math.min(duration || 1, scrub ?? position)}
          disabled={!canControl || duration <= 0}
          aria-label="Seek"
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={() => {
            if (scrub !== null) onSeek(scrub);
            setScrub(null);
          }}
          onKeyUp={() => {
            if (scrub !== null) onSeek(scrub);
            setScrub(null);
          }}
        />
      </div>
      <div className="seatbar__row">
        <IconButton
          icon={muted ? 'mute' : 'volume'}
          label={muted ? 'Unmute' : 'Mute'}
          onClick={onMute}
        />
        <input
          className="seatbar__volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          aria-label="Volume"
          onChange={(e) => onVolume(Number(e.target.value))}
        />
        {hasCaptions && (
          <IconButton
            icon="captions"
            label={captions ? 'Hide subtitles' : 'Show subtitles'}
            pressed={captions}
            onClick={onCaptions}
          />
        )}
        <IconButton icon="fullscreen" label="Full screen" onClick={onFullscreen} />
        <IconButton icon="tv" label="Open in the player" onClick={onPlayer} />
        <span className="seatbar__spacer" />
        {!canControl && (
          <span className="muted seatbar__note">{showing.hostName} has the remote</span>
        )}
        <Button size="sm" onClick={onStand}>
          Stand up
        </Button>
      </div>
    </div>
  );
}

export function PeopleList({
  open,
  players,
  meId,
  showings,
  where,
  onClose,
}: {
  open: boolean;
  players: TheaterPlayer[];
  meId: string | null;
  showings: Map<number, Showing>;
  where(p: TheaterPlayer): string;
  onClose(): void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Who’s here">
      <ul className="people">
        {players.map((p) => {
          const s = p.ticket ? showings.get(p.ticket) : undefined;
          return (
            <li key={p.id} className="people__row">
              <span className="people__face" style={{ background: p.color }} aria-hidden="true">
                {p.emoji ?? p.name.slice(0, 1)}
              </span>
              <span>
                <strong>
                  {p.name}
                  {p.id === meId && ' (you)'}
                </strong>
                <span className="muted">
                  {' '}
                  · {p.seat !== null && p.ticket ? `seated in Theater ${p.ticket}` : where(p)}
                  {s ? ` · ${s.title}` : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

/**
 * Touch controls: put your left thumb down anywhere on the left of the screen
 * and a thumbstick appears there (up and down walk, left and right turn; push
 * it all the way to run). Drag anywhere else to look around. Buttons on the
 * right: use, jump and run.
 */
export function TouchControls({
  seated,
  useLabel,
  sprint,
  onStick,
  onLook,
  onUse,
  onJump,
  onSprint,
}: {
  seated: boolean;
  useLabel: string | null;
  sprint: boolean;
  onStick(x: number, y: number): void;
  onLook(dx: number, dy: number): void;
  onUse(): void;
  onJump(): void;
  onSprint(on: boolean): void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const stick = useRef<{ id: number; x: number; y: number } | null>(null);
  const looks = useRef(new Map<number, { x: number; y: number }>());
  const [knob, setKnob] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const RADIUS = 56;

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const width = layer.current?.clientWidth ?? window.innerWidth;
    if (!seated && !stick.current && e.clientX < width * 0.45) {
      stick.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
      setKnob({ x: e.clientX, y: e.clientY, dx: 0, dy: 0 });
    } else {
      looks.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = stick.current;
    if (s && s.id === e.pointerId) {
      let dx = (e.clientX - s.x) / RADIUS;
      let dy = (e.clientY - s.y) / RADIUS;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      setKnob({ x: s.x, y: s.y, dx, dy });
      // A little dead zone so walking straight doesn't drift into a turn.
      onStick(Math.abs(dx) < 0.18 ? 0 : dx, Math.abs(dy) < 0.12 ? 0 : -dy);
      return;
    }
    const last = looks.current.get(e.pointerId);
    if (last) {
      onLook(e.clientX - last.x, e.clientY - last.y);
      looks.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (stick.current?.id === e.pointerId) {
      stick.current = null;
      setKnob(null);
      onStick(0, 0);
    }
    looks.current.delete(e.pointerId);
  };

  // Seated: no walking, so let go of the stick.
  useEffect(() => {
    if (seated && stick.current) {
      stick.current = null;
      onStick(0, 0);
    }
  }, [seated, onStick]);

  return (
    <>
      <div
        ref={layer}
        className="touch"
        aria-hidden="true"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {!knob && !seated && <span className="touch__hint">Drag here to walk</span>}
        {knob && (
          <span className="touch__stick" style={{ left: knob.x, top: knob.y }}>
            <span
              className="touch__knob"
              style={{ transform: `translate(${knob.dx * RADIUS}px, ${knob.dy * RADIUS}px)` }}
            />
          </span>
        )}
      </div>
      <div className="touch__buttons">
        {useLabel && (
          <button type="button" className="touch__use" onClick={onUse}>
            {useLabel}
          </button>
        )}
        {!seated && (
          <span className="touch__row">
            <button
              type="button"
              className="touch__round"
              aria-pressed={sprint}
              aria-label={sprint ? 'Stop running' : 'Run'}
              onClick={() => onSprint(!sprint)}
            >
              🏃
            </button>
            <button type="button" className="touch__round" aria-label="Jump" onClick={onJump}>
              ⤒
            </button>
          </span>
        )}
      </div>
    </>
  );
}

const ARCADE_PERSONAL = 'wh-arcade-best';

/** Your own best score on this device for each game (for when you play alone). */
export function personalBest(game: ArcadeGameId): number {
  try {
    return Number(
      (JSON.parse(localStorage.getItem(ARCADE_PERSONAL) ?? '{}') as Record<string, number>)[game] ??
        0,
    );
  } catch {
    return 0;
  }
}

function savePersonalBest(game: ArcadeGameId, score: number) {
  try {
    const all = JSON.parse(localStorage.getItem(ARCADE_PERSONAL) ?? '{}') as Record<string, number>;
    if (score > (all[game] ?? 0))
      localStorage.setItem(ARCADE_PERSONAL, JSON.stringify({ ...all, [game]: score }));
  } catch {
    // Not remembered: fine.
  }
}

/** A playable arcade machine. */
export function ArcadeDialog({
  game,
  top,
  touch,
  onClose,
  onScore,
}: {
  game: ArcadeGameId | null;
  top: HighScore[];
  touch: boolean;
  onClose(): void;
  onScore(game: ArcadeGameId, score: number): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const instance = useRef<ArcadeGame | null>(null);
  const input = useRef<ArcadeInput>({
    left: false,
    right: false,
    up: false,
    down: false,
    pointerX: null,
  });
  const [phase, setPhase] = useState<'ready' | 'playing' | 'over'>('ready');
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => (game ? personalBest(game) : 0));
  const title = ARCADE_GAMES.find((g) => g.id === game)?.title ?? '';

  const start = () => {
    if (!game) return;
    instance.current = createGame(game, (sound) => play(sound));
    input.current = { left: false, right: false, up: false, down: false, pointerX: null };
    setScore(0);
    setPhase('playing');
    play('coin');
  };

  // (The page gives each game its own copy of this dialog, so it starts fresh.)
  useEffect(() => {
    if (!game) return;
    const g = canvas.current?.getContext('2d');
    if (g) {
      g.fillStyle = '#0b0614';
      g.fillRect(0, 0, ARCADE_W, ARCADE_H);
    }
  }, [game]);

  // The game loop.
  useEffect(() => {
    if (phase !== 'playing' || !game) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const g = instance.current;
      const ctx = canvas.current?.getContext('2d');
      if (g && ctx) {
        g.update(dt, input.current);
        g.draw(ctx);
        setScore(g.score);
        if (g.over) {
          setPhase('over');
          savePersonalBest(game, g.score);
          setBest((b) => Math.max(b, g.score));
          if (g.score > 0) onScore(game, g.score);
          return;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [phase, game, onScore]);

  // Keys: arrows or W A S D; Space or Enter to start.
  useEffect(() => {
    if (!game) return;
    const map: Record<string, keyof Omit<ArcadeInput, 'pointerX'>> = {
      ArrowLeft: 'left',
      a: 'left',
      ArrowRight: 'right',
      d: 'right',
      ArrowUp: 'up',
      w: 'up',
      ArrowDown: 'down',
      s: 'down',
    };
    const onDown = (e: KeyboardEvent) => {
      const k = map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (k) {
        e.preventDefault();
        input.current[k] = true;
      } else if ((e.key === ' ' || e.key === 'Enter') && phase !== 'playing') {
        e.preventDefault();
        start();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const k = map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (k) input.current[k] = false;
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, phase]);

  const pointer = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    input.current.pointerX = ((e.clientX - r.left) / r.width) * ARCADE_W;
  };
  const hold = (k: keyof Omit<ArcadeInput, 'pointerX'>) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      e.preventDefault();
      input.current[k] = true;
    },
    onPointerUp: () => (input.current[k] = false),
    onPointerLeave: () => (input.current[k] = false),
    onPointerCancel: () => (input.current[k] = false),
  });

  return (
    <Dialog open={game !== null} onClose={onClose} title={title} size="lg">
      <div className="arcade">
        <div className="arcade__screen">
          <canvas
            ref={canvas}
            width={ARCADE_W}
            height={ARCADE_H}
            className="arcade__canvas"
            aria-label={`${title} game screen`}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              pointer(e);
            }}
            onPointerMove={(e) => {
              if (e.buttons || e.pointerType === 'touch') pointer(e);
            }}
            onPointerUp={() => (input.current.pointerX = null)}
          />
          {phase !== 'playing' && (
            <div className="arcade__overlay">
              {phase === 'over' && <p className="arcade__over">GAME OVER · {score}</p>}
              <Button variant="primary" onClick={start}>
                {phase === 'over' ? 'Play again' : 'Insert coin'}
              </Button>
              <p className="arcade__keys">
                {touch
                  ? 'Use the buttons below, or drag on the screen.'
                  : 'Arrow keys or W A S D. Space to start.'}
              </p>
            </div>
          )}
        </div>
        <div className="arcade__side">
          <p className="arcade__score">
            Score <strong>{score}</strong>
            <br />
            Your best <strong>{best}</strong>
          </p>
          <h3 className="boxoffice__label">High scores</h3>
          <ol className="arcade__top">
            {top.slice(0, 5).map((s, i) => (
              <li key={i}>
                <span>{s.name}</span> <strong>{s.score}</strong>
              </li>
            ))}
            {!top.length && <li className="muted">Nobody yet. Be the first!</li>}
          </ol>
        </div>
      </div>
      {touch && (
        <div className="arcade__pad" aria-label="Controls">
          <button type="button" aria-label="Left" {...hold('left')}>
            ◀
          </button>
          <button type="button" aria-label="Up" {...hold('up')}>
            ▲
          </button>
          <button type="button" aria-label="Down" {...hold('down')}>
            ▼
          </button>
          <button type="button" aria-label="Right" {...hold('right')}>
            ▶
          </button>
        </div>
      )}
    </Dialog>
  );
}

export function HelpDialog({
  open,
  touch,
  onClose,
}: {
  open: boolean;
  touch: boolean;
  onClose(): void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Welcome to Wheelhouse Cinemas"
      footer={
        <Button variant="primary" onClick={onClose}>
          Let’s go
        </Button>
      }
    >
      <ol className="theater-help">
        <li>
          <Icon name="film" size={18} /> Each theater shows its own movie today (see the{' '}
          <strong>Now Showing</strong> board). Get a ticket at the <strong>box office</strong>, or
          pick any poster in <strong>The Collection</strong> at the end of the hall.
        </li>
        <li>
          🍿 Buy snacks at the <strong>concessions</strong> stand. They go in your hands, then your
          seat’s cupholders. Eat and drink with the buttons by your hands.
        </li>
        <li>
          🎟️ Find your theater and <strong>sit in a seat</strong>: the curtains open, 3, 2, 1, and
          the movie starts.
        </li>
        <li>
          👥 Choose <strong>Watch together</strong> and anyone else here can join the same showing,
          in step. 🕹️ The arcade games are real, with high scores.
        </li>
      </ol>
      <p className="muted">
        {touch
          ? 'Put your left thumb down anywhere on the left of the screen to walk: push up to go, left or right to turn, all the way to run. Drag on the right to look around. Big buttons on the right use things and jump.'
          : 'W/S or ↑/↓ walk, ←/→ turn, A/D step sideways, Shift runs, Space jumps, drag to look. E (or Enter) uses things; 1 and 2 eat and drink.'}
      </p>
    </Dialog>
  );
}
