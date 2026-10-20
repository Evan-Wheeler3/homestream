// Wheelhouse Cinemas: a voxel movie theater you walk around in. Get a ticket
// at the box office (or from any poster in The Collection), grab snacks, find
// your theater and sit down: after "3, 2, 1" the movie plays on the big
// screen. Showings can be shared, so everyone in the building watches in step.
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  countdownLeft,
  positionAt,
  REACTIONS,
  SNACKS,
  type ServerMessage,
  type Showing,
  type SnackId,
  type TheaterPlayer,
} from '../../shared/theater';
import type { Movie, Page, SessionUser } from '../../shared/types';
import { useToast } from '../components/Toasts';
import { Button, IconButton, Spinner, StatusView } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/queries';
import { drawCard, drawLeader } from './countdown';
import { TheaterEngine, type Prompt } from './engine';
import { galleryPlan, placeAt, placeName, THEATERS, type Place } from './layout';
import { TheaterLink, type LinkStatus } from './link';
import {
  BoxOffice,
  HelpDialog,
  Joystick,
  PeopleList,
  SeatControls,
  SnackCounter,
  type TicketChoice,
} from './parts';
import { ScreenPlayer } from './screen';
import '../styles/theater.css';

async function loadAllMovies(): Promise<Movie[]> {
  const all: Movie[] = [];
  for (let offset = 0; ;) {
    const page = await api<Page<Movie>>(
      `/movies?sort=dateAdded&dir=desc&limit=200&offset=${offset}`,
    );
    all.push(...page.items);
    offset += page.items.length;
    if (!page.items.length || offset >= page.total) break;
  }
  return all.filter((m) => m.available);
}

export default function TheaterPage() {
  const session = useSession();
  // Loaded once per visit: the building is built around this list.
  const movies = useQuery({
    queryKey: ['theater', 'movies'],
    queryFn: loadAllMovies,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  if (session.isError || movies.isError) {
    return (
      <div className="theater theater--message">
        <StatusView icon="alert" title="The theater couldn’t open">
          <p>{errorMessage(session.error ?? movies.error)}</p>
          <Button onClick={() => void movies.refetch()}>Try again</Button>
        </StatusView>
      </div>
    );
  }
  if (!session.data || !movies.data) {
    return (
      <div className="theater theater--message">
        <Spinner size={36} label="Opening the doors" />
        <p className="theater__opening">Opening the doors…</p>
      </div>
    );
  }
  return (
    <Cinema me={session.data.user} cloud={session.data.source === 'cloud'} movies={movies.data} />
  );
}

const ARCADE_LINES = [
  'GAME OVER. Insert coin 🕹️',
  'NEW HIGH SCORE! 👾 (Nobody else has played.)',
  'You lost to a pixelated ghost 👻',
];
const SIDE = (theater: number) => (THEATERS[theater - 1]!.side === -1 ? 'left' : 'right');
const HELP_KEY = 'wh-theater-help-v1';
type Dialogs =
  | { kind: 'boxoffice'; movieId: string | null }
  | { kind: 'concessions' }
  | { kind: 'people' }
  | { kind: 'help' }
  | null;

function Cinema({ me, cloud, movies }: { me: SessionUser; cloud: boolean; movies: Movie[] }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const toast = useToast();
  const meRef = useRef(me);
  const hostRef = useRef<HTMLDivElement>(null);
  const videoHostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TheaterEngine | null>(null);
  const linkRef = useRef<TheaterLink | null>(null);
  const screenRef = useRef<ScreenPlayer | null>(null);
  const meIdRef = useRef<string | null>(null);
  const playersRef = useRef(new Map<string, TheaterPlayer>());
  const showingsRef = useRef(new Map<number, Showing>());
  const promptRef = useRef<Prompt | null>(null);
  const intentRef = useRef<{ choice: TicketChoice; seat: number | null } | null>(null);
  const lastTicketRef = useRef<number | null>(null);
  // What's drawn: a copy of the building's state, refreshed after each change.
  const [snap, setSnap] = useState<{
    meId: string | null;
    players: TheaterPlayer[];
    showings: Showing[];
  }>({
    meId: null,
    players: [],
    showings: [],
  });
  const publish = useCallback(
    () =>
      setSnap({
        meId: meIdRef.current,
        players: [...playersRef.current.values()].map((p) => ({ ...p })),
        showings: [...showingsRef.current.values()].map((x) => ({ ...x })),
      }),
    [],
  );
  const [status, setStatus] = useState<LinkStatus>('connecting');
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [place, setPlace] = useState<Place>({ kind: 'lobby' });
  // Arriving from "In the theater" on a movie's page opens the box office with it;
  // the first visit ever opens the welcome.
  const [dialog, setDialog] = useState<Dialogs>(() => {
    const wanted = params.get('movie');
    if (wanted && movies.some((m) => m.id === wanted))
      return { kind: 'boxoffice', movieId: wanted };
    try {
      return localStorage.getItem(HELP_KEY) ? null : { kind: 'help' };
    } catch {
      return null;
    }
  });
  const [floats, setFloats] = useState<{ id: number; emoji: string }[]>([]);
  const [chat, setChat] = useState<{ id: number; name: string; text: string }[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState('');
  const [now, setNow] = useState(() => Date.now());
  // The movie screen's state, for the screen it was reported for.
  const [screen, setScreen] = useState<{
    key: string | null;
    ready: boolean;
    error: string | null;
    needsTap: boolean;
    duration: number;
    subtitles: boolean;
  }>({ key: null, ready: false, error: null, needsTap: false, duration: 0, subtitles: false });
  const [captions, setCaptions] = useState(false);
  const [caption, setCaption] = useState('');
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [travelOpen, setTravelOpen] = useState(false);
  const touch = useMemo(() => window.matchMedia?.('(pointer: coarse)').matches ?? false, []);
  const gallery = useMemo(() => galleryPlan(movies.length), [movies.length]);

  const meId = snap.meId;
  const mine = snap.players.find((p) => p.id === meId);
  const showingMap = useMemo(
    () => new Map(snap.showings.map((x) => [x.theater, x])),
    [snap.showings],
  );
  const myShowing = mine?.ticket ? showingMap.get(mine.ticket) : undefined;
  const inMyTheater =
    place.kind === 'theater' && mine?.ticket === place.number && Boolean(myShowing);
  const seated = mine?.seat != null && Boolean(myShowing);
  const players = snap.players;
  const others = players.filter((p) => p.id !== meId);

  const buy = useCallback((choice: TicketChoice, seat: number | null = null) => {
    intentRef.current = { choice, seat };
    linkRef.current?.send({
      t: 'ticket',
      movieId: choice.movie.id,
      title: choice.movie.title,
      poster: choice.movie.images.poster,
      runtimeMinutes: choice.movie.runtimeMinutes,
      shared: choice.shared,
      startSeconds: choice.startSeconds,
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Messages from the building

  const onMessage = useCallback(
    (m: ServerMessage) => {
      const engine = engineRef.current;
      const ps = playersRef.current;
      switch (m.t) {
        case 'welcome': {
          meIdRef.current = m.you;
          ps.clear();
          for (const p of m.players) ps.set(p.id, p);
          showingsRef.current = new Map(m.showings.map((s) => [s.theater, s]));
          const self = ps.get(m.you);
          if (self && engine) {
            self.x = engine.x;
            self.z = engine.z;
            self.yaw = engine.yaw;
            linkRef.current?.send({ t: 'move', x: engine.x, z: engine.z, yaw: engine.yaw });
          }
          // Back after a dropped connection: get the same ticket (and seat) again.
          const intent = intentRef.current;
          if (intent) {
            const pos = screenRef.current?.video.currentTime ?? intent.choice.startSeconds;
            buy({ ...intent.choice, startSeconds: pos }, intent.seat);
          }
          break;
        }
        case 'player': {
          ps.set(m.player.id, m.player);
          if (m.player.id === meIdRef.current && engine) {
            const p = m.player;
            engine.setTicket(p.ticket);
            if (p.ticket !== lastTicketRef.current) {
              lastTicketRef.current = p.ticket;
              if (p.ticket) {
                setDialog((d) => (d?.kind === 'boxoffice' ? null : d));
                const s = showingsRef.current.get(p.ticket);
                toast.show(
                  `🎟️ Theater ${p.ticket}${s ? ` · ${s.title}` : ''}: down the hall on the ${SIDE(p.ticket)}.`,
                );
              }
            }
            // Coming back after a dropped connection: sit down again.
            const intent = intentRef.current;
            if (p.ticket && p.seat === null && intent?.seat != null && engine.isSeated) {
              linkRef.current?.send({ t: 'sit', seat: intent.seat });
            } else if (p.seat === null && engine.isSeated && intent?.seat == null) {
              engine.standUp();
            } else if (p.ticket && p.seat !== null && !engine.isSeated) {
              engine.sitAt(p.ticket, p.seat);
            }
          }
          break;
        }
        case 'move': {
          const p = ps.get(m.id);
          if (p) Object.assign(p, { x: m.x, z: m.z, yaw: m.yaw });
          engine?.movePlayer(m.id, m.x, m.z, m.yaw);
          return;
        }
        case 'gone':
          ps.delete(m.id);
          break;
        case 'showing':
          showingsRef.current.set(m.showing.theater, m.showing);
          break;
        case 'closed':
          showingsRef.current.delete(m.theater);
          break;
        case 'react':
          if (m.id === meIdRef.current) {
            const id = Date.now() + Math.random();
            setFloats((f) => [...f, { id, emoji: m.emoji }]);
            window.setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 2000);
          } else {
            engine?.pop(m.id, m.emoji);
          }
          return;
        case 'chat': {
          if (m.id !== meIdRef.current) engine?.pop(m.id, m.text, true);
          const id = Date.now() + Math.random();
          setChat((c) => [...c.slice(-5), { id, name: m.name, text: m.text }]);
          window.setTimeout(() => setChat((c) => c.filter((x) => x.id !== id)), 15_000);
          return;
        }
        case 'error': {
          toast.show(m.message, 'error');
          const self = ps.get(meIdRef.current ?? '');
          if (engine?.isSeated && self?.seat === null) {
            engine.standUp();
            if (intentRef.current) intentRef.current.seat = null;
          }
          return;
        }
        default:
          return;
      }
      engine?.setPlayers([...ps.values()]);
      engine?.setShowings([...showingsRef.current.values()]);
      publish();
    },
    [buy, publish, toast],
  );

  // ---------------------------------------------------------------------------
  // Using things

  // The latest dialog and ticket, for handlers the 3D view calls.
  const dialogRef = useRef<Dialogs>(dialog);
  const ticketRef = useRef<number | null>(null);
  useEffect(() => {
    dialogRef.current = dialog;
    ticketRef.current = mine?.ticket ?? null;
  }, [dialog, mine?.ticket]);

  const stand = useCallback(() => {
    if (intentRef.current) intentRef.current.seat = null;
    engineRef.current?.standUp();
    linkRef.current?.send({ t: 'stand' });
  }, []);

  const returnTicket = () => {
    intentRef.current = null;
    engineRef.current?.standUp();
    linkRef.current?.send({ t: 'returnTicket' });
  };

  const findSeat = () => {
    const engine = engineRef.current;
    if (!engine || !mine?.ticket) return;
    engine.goTo({ theater: mine.ticket, seat: engine.freeSeat(mine.ticket) });
  };

  const interact = useCallback(
    (p: Prompt | null = promptRef.current) => {
      const engine = engineRef.current;
      const link = linkRef.current;
      if (!p || !engine || !link || dialogRef.current) return;
      const ticket = ticketRef.current;
      switch (p.kind) {
        case 'boxoffice':
          setDialog({ kind: 'boxoffice', movieId: null });
          break;
        case 'poster':
          setDialog({ kind: 'boxoffice', movieId: p.movieId });
          break;
        case 'concessions':
          setDialog({ kind: 'concessions' });
          break;
        case 'arcade':
          toast.show(ARCADE_LINES[Math.floor(Math.random() * ARCADE_LINES.length)]!);
          break;
        case 'restroom':
          toast.show('Occupied! 🚻 Try again after the movie.');
          break;
        case 'taker':
          toast.show(
            ticket
              ? `“Theater ${ticket}, down the hall on the ${SIDE(ticket)}. Enjoy the show!”`
              : '“Tickets are at the box office, just over there on the left.”',
          );
          break;
        case 'seat':
          screenRef.current?.unlock();
          if (intentRef.current) intentRef.current.seat = p.seat;
          engine.sitAt(p.theater, p.seat);
          link.send({ t: 'sit', seat: p.seat });
          break;
        case 'stand':
          stand();
          break;
      }
    },
    [stand, toast],
  );

  // ---------------------------------------------------------------------------
  // The 3D world and the connection

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const engine = new TheaterEngine(
      host,
      {
        onPrompt: (p) => {
          promptRef.current = p;
          setPrompt(p);
        },
        onMove: (x, z, yaw) => {
          const self = playersRef.current.get(meIdRef.current ?? '');
          if (self) Object.assign(self, { x, z, yaw });
          linkRef.current?.send({ t: 'move', x, z, yaw });
        },
        onPlace: setPlace,
        onBlocked: (n) =>
          toast.show(`Theater ${n} needs a ticket. Get one at the box office in the lobby.`),
        onInteract: () => interact(),
      },
      movies.map((m) => ({ id: m.id, title: m.title, year: m.year, poster: m.images.poster })),
      () => meIdRef.current,
    );
    engineRef.current = engine;
    const self = meRef.current;
    const link = new TheaterLink(
      {
        userId: self.id,
        name: self.name,
        color: self.look?.color ?? null,
        emoji: self.look?.emoji ?? null,
        image: self.look?.image ?? null,
      },
      onMessage,
      setStatus,
    );
    linkRef.current = link;
    link.start(cloud);
    if (params.get('movie')) engine.goTo('boxoffice');
    // Tests and the curious: move around from the console.
    (window as { __theater?: unknown }).__theater = { engine, link };
    return () => {
      link.close();
      engine.dispose();
      engineRef.current = null;
      linkRef.current = null;
      delete (window as { __theater?: unknown }).__theater;
    };
    // Built once per visit (the search parameter only matters on arrival).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud, movies, onMessage, toast, interact]);

  useEffect(() => {
    if (engineRef.current) engineRef.current.inputEnabled = !dialog && !chatOpen && !travelOpen;
  }, [dialog, chatOpen, travelOpen]);

  // ---------------------------------------------------------------------------
  // The movie on your screen

  const screenKey = inMyTheater && myShowing ? `${myShowing.theater}:${myShowing.movieId}` : null;
  useEffect(() => {
    const host = videoHostRef.current;
    const engine = engineRef.current;
    const link = linkRef.current;
    const showing = myShowing;
    if (!screenKey || !host || !engine || !link || !showing) return;
    const theater = showing.theater;
    const key = screenKey;
    const update = (patch: Partial<typeof screen>) =>
      setScreen((st) =>
        st.key === key
          ? { ...st, ...patch }
          : {
              key,
              ready: false,
              error: null,
              needsTap: false,
              duration: 0,
              subtitles: false,
              ...patch,
            },
      );
    const player = new ScreenPlayer(showing.movieId, host, {
      onReady: (video) =>
        update({
          ready: true,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          subtitles: video.textTracks.length > 0,
        }),
      onError: (error) => update({ error }),
      onNeedsTap: () => update({ needsTap: true }),
      onEnded: () => link.send({ t: 'ended' }),
    });
    screenRef.current = player;
    void player.load(positionAt(showing, link.now()));
    const card = document.createElement('canvas');
    let mode: 'poster' | 'leader' | 'card' | 'video' = 'poster';
    const show = (next: typeof mode) => {
      if (mode === next) return;
      mode = next;
      engine.setScreen(theater, next === 'poster' ? null : next === 'video' ? player.video : card);
    };
    const timer = window.setInterval(() => {
      const s = showingsRef.current.get(theater);
      if (!s) return;
      const t = link.now();
      const left = countdownLeft(s, t);
      if (left > 0) {
        drawLeader(card, left, s.title);
        show('leader');
        engine.refreshScreen(theater);
      } else if (s.status === 'ended') {
        drawCard(card, ['THE END', s.title.toUpperCase()]);
        show('card');
        engine.refreshScreen(theater);
      } else if (s.status === 'seating' || player.video.readyState < 2) {
        show('poster');
      } else {
        show('video');
        engine.fitScreen(theater, player.video);
      }
      player.sync(s, t);
      setCaption(player.caption());
    }, 200);
    return () => {
      window.clearInterval(timer);
      player.dispose();
      screenRef.current = null;
      engine.setScreen(theater, null);
    };
    // The showing object changes all the time; the key says when the movie does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenKey]);

  const current = screen.key === screenKey ? screen : null;
  const screenReady = Boolean(current?.ready);
  const screenError = current?.error ?? null;
  const needsTap = Boolean(current?.needsTap);
  useEffect(() => {
    screenRef.current?.setVolume(volume, muted);
  }, [volume, muted, screenReady]);

  useEffect(() => {
    screenRef.current?.setCaptions(captions);
  }, [captions, screenReady]);

  // House lights down while your movie plays; a clock for the controls.
  const playingHere = inMyTheater && myShowing?.status === 'playing';
  useEffect(() => {
    engineRef.current?.setDimmed(Boolean(playingHere));
  }, [playingHere]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(linkRef.current?.now() ?? Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  // ---------------------------------------------------------------------------

  const closeDialog = () => {
    if (dialog?.kind === 'help') {
      try {
        localStorage.setItem(HELP_KEY, '1');
      } catch {
        // Fine: it shows again next time.
      }
    }
    setDialog(null);
  };

  const control = (action: 'play' | 'pause' | 'seek', positionSeconds?: number) =>
    linkRef.current?.send({ t: 'control', action, positionSeconds });

  const countdown = myShowing && seated ? countdownLeft(myShowing, now) : 0;
  const canControl = Boolean(
    myShowing && seated && (myShowing.shared || myShowing.hostId === meId),
  );
  const duration = current?.duration || (myShowing?.runtimeMinutes ?? 0) * 60;
  const where = (p: TheaterPlayer) => placeName(placeAt(p.x, p.z, gallery));
  const statusLabel =
    status === 'together'
      ? `${players.length} here`
      : status === 'solo'
        ? 'Just you'
        : status === 'reconnecting'
          ? 'Reconnecting…'
          : 'Connecting…';

  return (
    <div className={`theater ${seated ? 'theater--seated' : ''}`}>
      <div ref={hostRef} className="theater__world" />
      <div ref={videoHostRef} className="theater__videos" aria-hidden="true" />

      <header className="theater__top">
        <Button size="sm" icon="chevronLeft" onClick={() => navigate('/')}>
          Leave
        </Button>
        <span className="theater__place" aria-live="polite">
          {placeName(place)}
        </span>
        <span className="theater__spacer" />
        <button
          type="button"
          className={`theater__status theater__status--${status}`}
          onClick={() => setDialog({ kind: 'people' })}
          title={
            status === 'solo' && !cloud ? 'Watching together needs the cloud edition.' : undefined
          }
        >
          👥 {statusLabel}
        </button>
        <IconButton icon="pin" label="Go to…" onClick={() => setTravelOpen((o) => !o)} />
        <IconButton icon="info" label="How it works" onClick={() => setDialog({ kind: 'help' })} />
      </header>

      {travelOpen && (
        <nav className="theater__travel" aria-label="Go to">
          {(
            [
              ['lobby', 'Lobby'],
              ['boxoffice', 'Box office'],
              ['concessions', 'Concessions'],
              ['gallery', 'The Collection'],
            ] as const
          ).map(([to, label]) => (
            <Button
              key={to}
              size="sm"
              variant="ghost"
              onClick={() => {
                engineRef.current?.goTo(to);
                setTravelOpen(false);
              }}
            >
              {label}
            </Button>
          ))}
          {mine?.ticket && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                findSeat();
                setTravelOpen(false);
              }}
            >
              My seat in Theater {mine.ticket}
            </Button>
          )}
        </nav>
      )}

      {mine?.ticket && !seated && (
        <aside className="ticket" aria-label="Your ticket">
          <span className="ticket__admit">ADMIT ONE</span>
          <strong className="ticket__theater">Theater {mine.ticket}</strong>
          <span className="ticket__title">{myShowing?.title}</span>
          <span className="ticket__kind">
            {myShowing?.shared ? 'Watch together' : 'Private screening'}
          </span>
          <div className="ticket__actions">
            <Button size="sm" variant="primary" onClick={findSeat}>
              Find me a seat
            </Button>
            <Button size="sm" variant="ghost" onClick={returnTicket}>
              Return ticket
            </Button>
          </div>
        </aside>
      )}

      {countdown > 0 && (
        // Drawn on the screen itself; this is for screen readers.
        <div className="visually-hidden" aria-live="assertive">
          {Math.min(3, Math.ceil(countdown / 1000))}
        </div>
      )}
      {seated && caption && <div className="theater__caption">{caption}</div>}
      {seated && screenError && <div className="theater__notice">{screenError}</div>}
      {seated && !screenError && !screenReady && myShowing?.status !== 'seating' && (
        <div className="theater__notice">Loading the movie…</div>
      )}
      {needsTap && inMyTheater && (
        <Button
          className="theater__sound"
          variant="primary"
          icon="volume"
          onClick={() => {
            setMuted(false);
            screenRef.current?.unlock();
            setScreen((st) => ({ ...st, needsTap: false }));
          }}
        >
          Tap for sound
        </Button>
      )}

      <div className="theater__floats" aria-hidden="true">
        {floats.map((f) => (
          <span key={f.id} className="theater__float">
            {f.emoji}
          </span>
        ))}
      </div>
      {chat.length > 0 && (
        <ol className="theater__chat" aria-label="Messages">
          {chat.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong> {c.text}
            </li>
          ))}
        </ol>
      )}

      <div className="theater__bottom">
        {prompt && !dialog && !seated && (
          <button type="button" className="theater__prompt" onClick={() => interact(prompt)}>
            {!touch && <kbd>E</kbd>} {prompt.label}
          </button>
        )}
        {seated && myShowing && (
          <SeatControls
            showing={myShowing}
            now={now}
            duration={duration}
            canControl={canControl}
            volume={volume}
            muted={muted}
            captions={captions}
            hasCaptions={Boolean(current?.subtitles)}
            onToggle={() => control(myShowing.status === 'playing' ? 'pause' : 'play')}
            onSeek={(s) => control('seek', s)}
            onVolume={(v) => {
              setVolume(v);
              setMuted(v === 0);
            }}
            onMute={() => setMuted((m) => !m)}
            onCaptions={() => setCaptions((c) => !c)}
            onFullscreen={() => screenRef.current?.fullscreen()}
            onPlayer={() =>
              navigate(`/play/${myShowing.movieId}?t=${Math.floor(positionAt(myShowing, now))}`)
            }
            onStand={stand}
          />
        )}
        <div className="theater__social">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="theater__react"
              aria-label={`React ${emoji}`}
              onClick={() => linkRef.current?.send({ t: 'react', emoji })}
            >
              {emoji}
            </button>
          ))}
          {chatOpen ? (
            <form
              className="theater__say"
              onSubmit={(e) => {
                e.preventDefault();
                if (chatText.trim()) linkRef.current?.send({ t: 'chat', text: chatText });
                setChatText('');
                setChatOpen(false);
              }}
            >
              <input
                className="input input--sm"
                autoFocus
                maxLength={140}
                placeholder="Say something"
                aria-label="Say something"
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                onBlur={() => !chatText && setChatOpen(false)}
              />
            </form>
          ) : (
            <button
              type="button"
              className="theater__react"
              aria-label="Say something"
              onClick={() => setChatOpen(true)}
            >
              💬
            </button>
          )}
          {mine?.snack && (
            <span className="theater__snack" title="Your snack">
              {SNACKS.find((s) => s.id === mine.snack)?.emoji}
            </span>
          )}
        </div>
      </div>

      {touch && !seated && <Joystick onChange={(x, y) => engineRef.current?.setJoystick(x, y)} />}

      <BoxOffice
        key={dialog?.kind === 'boxoffice' ? `bo-${dialog.movieId}` : 'bo'}
        open={dialog?.kind === 'boxoffice'}
        movies={movies}
        preselect={dialog?.kind === 'boxoffice' ? dialog.movieId : null}
        showings={snap.showings}
        othersHere={others.length > 0}
        onClose={closeDialog}
        onBuy={(choice) => buy(choice)}
        onJoin={(theater) => {
          const s = showingsRef.current.get(theater);
          const movie = movies.find((m) => m.id === s?.movieId);
          if (movie)
            intentRef.current = { choice: { movie, shared: true, startSeconds: 0 }, seat: null };
          linkRef.current?.send({ t: 'join', theater });
        }}
      />
      <SnackCounter
        open={dialog?.kind === 'concessions'}
        current={mine?.snack ?? null}
        onClose={closeDialog}
        onPick={(snack: SnackId | null) => {
          linkRef.current?.send({ t: 'snack', snack });
          const s = SNACKS.find((x) => x.id === snack);
          if (s) toast.show(`${s.emoji} ${s.label}, on the house. Enjoy!`);
          setDialog(null);
        }}
      />
      <PeopleList
        open={dialog?.kind === 'people'}
        players={players}
        meId={meId}
        showings={showingMap}
        where={where}
        onClose={closeDialog}
      />
      <HelpDialog open={dialog?.kind === 'help'} touch={touch} onClose={closeDialog} />
      {status === 'solo' && !cloud && (
        <p className="theater__solo muted">
          Watching together needs the cloud edition. Here it’s just you.
        </p>
      )}
    </div>
  );
}
