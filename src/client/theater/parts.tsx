// The theater's on-screen pieces: the box office, the snack counter, the
// controls while you're seated, who's here, and the thumbstick for phones.
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  positionAt,
  SNACKS,
  type Showing,
  type SnackId,
  type TheaterPlayer,
} from '../../shared/theater';
import type { Movie } from '../../shared/types';
import { Icon } from '../components/Icon';
import { Button, Dialog, IconButton, Segmented } from '../components/ui';
import { formatClock } from '../lib/format';
import { sizedImage } from '../lib/images';

export interface TicketChoice {
  movie: Movie;
  shared: boolean;
  startSeconds: number;
}

export function BoxOffice({
  open,
  movies,
  preselect,
  showings,
  othersHere,
  onClose,
  onBuy,
  onJoin,
}: {
  open: boolean;
  movies: Movie[];
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Box office"
      description="Every movie in the library is showing. Pick one and get a ticket."
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

export function SnackCounter({
  open,
  current,
  onClose,
  onPick,
}: {
  open: boolean;
  current: SnackId | null;
  onClose(): void;
  onPick(snack: SnackId | null): void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Concessions"
      description="Everything’s on the house."
    >
      <ul className="snacks">
        {SNACKS.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className="snacks__item"
              aria-pressed={current === s.id}
              onClick={() => onPick(s.id)}
            >
              <span className="snacks__emoji" aria-hidden="true">
                {s.emoji}
              </span>
              {s.label}
            </button>
          </li>
        ))}
      </ul>
      {current && (
        <Button variant="ghost" onClick={() => onPick(null)}>
          I’m done with my snack
        </Button>
      )}
    </Dialog>
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

/** A thumbstick for touch screens: drag from the circle to walk. */
export function Joystick({ onChange }: { onChange(x: number, y: number): void }) {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const active = useRef<number | null>(null);
  const move = (e: ReactPointerEvent) => {
    const el = base.current;
    if (!el || active.current !== e.pointerId) return;
    const r = el.getBoundingClientRect();
    let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    setKnob({ x, y });
    onChange(x, -y);
  };
  const end = () => {
    active.current = null;
    setKnob({ x: 0, y: 0 });
    onChange(0, 0);
  };
  return (
    <div
      ref={base}
      className="joystick"
      aria-hidden="true"
      onPointerDown={(e) => {
        active.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span
        className="joystick__knob"
        style={{ transform: `translate(${knob.x * 34}px, ${knob.y * 34}px)` }}
      />
    </div>
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
          <Icon name="film" size={18} /> Get a ticket at the <strong>box office</strong> (left), or
          walk to <strong>The Collection</strong> at the end of the hall and pick any poster.
        </li>
        <li>
          🍿 Grab snacks at the <strong>concessions</strong> stand (right).
        </li>
        <li>
          🎟️ Head down the hall to your theater and <strong>sit in a seat</strong>: the movie starts
          after 3, 2, 1.
        </li>
        <li>
          👥 Choose <strong>Watch together</strong> and anyone else here can join the same showing,
          in step.
        </li>
      </ol>
      <p className="muted">
        {touch
          ? 'Walk with the thumbstick, drag anywhere else to look around, and tap the button that appears to use things.'
          : 'Walk with W A S D or the arrow keys, drag to look around, and press E (or Enter) to use things.'}
      </p>
    </Dialog>
  );
}
