// The voxel movie theater's rules, shared by the Worker's Durable Object (one
// building everyone walks around in together) and the browser (the same
// building, on your own, when there is no server to share it through).
//
// The server only keeps track of people and showings: who is where, who holds a
// ticket for which theater and seat, and where each showing's movie is. Every
// viewer streams the movie themselves and keeps their video in step with it.

export const THEATER_COUNT = 8;
export const ROWS = 6;
export const SEATS_PER_ROW = 10;
export const SEAT_COUNT = ROWS * SEATS_PER_ROW;
/** "3, 2, 1" before the movie starts once someone sits down. */
export const COUNTDOWN_MS = 3_500;
const MAX_POSITION = 24 * 3600;

/** The concession stand's menu. `bites`: how many bites (or sips) until it's gone. */
export const SNACKS = [
  { id: 'popcorn', label: 'Popcorn', emoji: '🍿', price: 7, kind: 'food', bites: 12 },
  { id: 'soda', label: 'Soda', emoji: '🥤', price: 5, kind: 'drink', bites: 8 },
  { id: 'candy', label: 'Candy', emoji: '🍬', price: 4, kind: 'food', bites: 6 },
  { id: 'nachos', label: 'Nachos', emoji: '🧀', price: 6, kind: 'food', bites: 8 },
  { id: 'hotdog', label: 'Hot dog', emoji: '🌭', price: 5, kind: 'food', bites: 5 },
  { id: 'pretzel', label: 'Pretzel', emoji: '🥨', price: 4, kind: 'food', bites: 5 },
  { id: 'icecream', label: 'Ice cream', emoji: '🍦', price: 4, kind: 'food', bites: 6 },
  { id: 'water', label: 'Water', emoji: '💧', price: 3, kind: 'drink', bites: 6 },
] as const;
export type SnackId = (typeof SNACKS)[number]['id'];
/** Wheelhouse Bucks you arrive with (pretend money, topped up each visit). */
export const WALLET = 30;

/** Something in your hand: how much is left, 1 (full) to 0 (empty). */
export interface HeldItem {
  id: SnackId;
  level: number;
  /** Set down in your seat's cupholder (only while you're sitting). */
  down?: boolean;
}
/** Left hand, right hand (or the matching cupholder while you're seated). */
export type Hands = [HeldItem | null, HeldItem | null];

/** The playable arcade machines. */
export const ARCADE_GAMES = [
  { id: 'snake', title: 'Snack Snake' },
  { id: 'breakout', title: 'Brick Breaker' },
  { id: 'catch', title: 'Popcorn Catch' },
] as const;
export type ArcadeGameId = (typeof ARCADE_GAMES)[number]['id'];
export interface HighScore {
  name: string;
  score: number;
}
export type Scores = Record<ArcadeGameId, HighScore[]>;
export const emptyScores = (): Scores => ({ snake: [], breakout: [], catch: [] });
const TOP_SCORES = 10;

/** A small seeded random number generator (the same sequence for the same seed). */
function seeded(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/**
 * Today's lineup: which movie each theater shows (index 0 is Theater 1). The
 * newest arrival gets Theater 1; the rest are a shuffle that changes each day
 * and is the same for everyone.
 */
export function dailyLineup(
  movies: { id: string; dateAdded: string | null }[],
  day: string,
): (string | null)[] {
  const newest = [...movies].sort(
    (a, b) => (b.dateAdded ?? '').localeCompare(a.dateAdded ?? '') || a.id.localeCompare(b.id),
  )[0];
  const rest = movies
    .filter((m) => m !== newest)
    .map((m) => m.id)
    .sort();
  const random = seeded(day);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  const ids = newest ? [newest.id, ...rest] : rest;
  return Array.from({ length: THEATER_COUNT }, (_, i) => ids[i] ?? null);
}

export const REACTIONS = ['😂', '😱', '😍', '👏', '😭', '🔥', '🍿', '👀'] as const;

/** Where people walk in (just inside the front doors), facing the box office. */
export const SPAWN = { x: 0, z: 4, yaw: 0 };

/** Someone in the building. `id` is their connection (one per open tab). */
export interface TheaterPlayer {
  id: string;
  userId: string;
  name: string;
  color: string;
  emoji: string | null;
  image: string | null;
  x: number;
  z: number;
  yaw: number;
  /** What they're carrying (in their seat's cupholders while seated). */
  hands: Hands;
  /** The theater their ticket is for. */
  ticket: number | null;
  /** Their seat in that theater, while sitting. */
  seat: number | null;
}

export interface Showing {
  theater: number;
  movieId: string;
  title: string;
  poster: string | null;
  runtimeMinutes: number | null;
  /** Who bought the first ticket (and controls a private showing). */
  hostId: string;
  hostName: string;
  /** Others can buy a ticket to it and watch at the same time. */
  shared: boolean;
  /** 'seating': waiting for the first person to sit down. */
  status: 'seating' | 'playing' | 'paused' | 'ended';
  /** Where the movie is at `at` (server time, ms). While playing it moves on from there. */
  positionSeconds: number;
  /** A time in the future is the countdown: the movie starts then. */
  at: number;
}

export interface TheaterUser {
  userId: string;
  name: string;
  color: string | null;
  emoji: string | null;
  image: string | null;
}

export type ClientMessage =
  | { t: 'move'; x: number; z: number; yaw: number }
  /** What you're carrying now; `bite` says which hand you just ate or drank from. */
  | { t: 'hands'; hands: Hands; bite?: 0 | 1 }
  | {
      t: 'ticket';
      movieId: string;
      title: string;
      poster: string | null;
      runtimeMinutes: number | null;
      shared: boolean;
      startSeconds: number;
      /** The theater showing it today, when it's in the lineup. */
      theater?: number;
    }
  | { t: 'score'; game: ArcadeGameId; score: number }
  | { t: 'join'; theater: number }
  | { t: 'returnTicket' }
  | { t: 'sit'; seat: number }
  | { t: 'stand' }
  | { t: 'control'; action: 'play' | 'pause' | 'seek'; positionSeconds?: number }
  | { t: 'ended' }
  | { t: 'react'; emoji: string }
  | { t: 'chat'; text: string }
  | { t: 'ping'; c: number };

export type ServerMessage =
  | {
      t: 'welcome';
      you: string;
      players: TheaterPlayer[];
      showings: Showing[];
      scores: Scores;
      now: number;
    }
  | { t: 'player'; player: TheaterPlayer }
  | { t: 'move'; id: string; x: number; z: number; yaw: number }
  | { t: 'gone'; id: string }
  | { t: 'showing'; showing: Showing }
  | { t: 'closed'; theater: number }
  | { t: 'react'; id: string; emoji: string }
  | { t: 'bite'; id: string; hand: 0 | 1 }
  | { t: 'scores'; game: ArcadeGameId; top: HighScore[] }
  | { t: 'notice'; message: string }
  | { t: 'chat'; id: string; name: string; text: string }
  | { t: 'pong'; c: number; s: number }
  | { t: 'error'; message: string };

/** Where a showing's movie is at server time `now`. */
export function positionAt(showing: Showing, now: number): number {
  if (showing.status !== 'playing') return showing.positionSeconds;
  return showing.positionSeconds + Math.max(0, now - showing.at) / 1000;
}

/** Milliseconds of countdown left (0 once the movie has started). */
export function countdownLeft(showing: Showing, now: number): number {
  return showing.status === 'playing' ? Math.max(0, showing.at - now) : 0;
}

const DEFAULT_COLOR = '#e8a33d';

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function parseHands(raw: unknown): Hands | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const hands = raw.map((h: unknown) => {
    if (h === null) return null;
    if (!h || typeof h !== 'object') return undefined;
    const { id, level, down } = h as Record<string, unknown>;
    const snack = SNACKS.find((s) => s.id === id)?.id;
    const l = finite(level, 0, 1);
    if (!snack || l === null) return undefined;
    return down === true ? { id: snack, level: l, down: true } : { id: snack, level: l };
  });
  return hands.includes(undefined) ? null : (hands as Hands);
}
const finite = (n: unknown, min: number, max: number): number | null =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
const text = (s: unknown, max: number): string =>
  typeof s === 'string' ? s.trim().slice(0, max) : '';

type Send = (to: string | null, message: ServerMessage, except?: string) => void;

/**
 * The building's state and what each message does to it. `send(null, …)` goes
 * to everyone (except `except`), `send(id, …)` to one connection.
 */
export class TheaterState {
  readonly players = new Map<string, TheaterPlayer>();
  readonly showings = new Map<number, Showing>();
  scores: Scores = emptyScores();

  constructor(
    private readonly send: Send,
    private readonly now: () => number = Date.now,
    /** Called when the high scores change (the server keeps them). */
    private readonly onScores?: (scores: Scores) => void,
  ) {}

  join(id: string, user: TheaterUser) {
    const player: TheaterPlayer = {
      id,
      userId: user.userId,
      name: text(user.name, 40) || 'Guest',
      color: user.color || DEFAULT_COLOR,
      emoji: user.emoji,
      image: user.image,
      x: SPAWN.x,
      z: SPAWN.z,
      yaw: SPAWN.yaw,
      hands: [null, null],
      ticket: null,
      seat: null,
    };
    this.players.set(id, player);
    this.send(id, {
      t: 'welcome',
      you: id,
      players: [...this.players.values()],
      showings: [...this.showings.values()],
      scores: this.scores,
      now: this.now(),
    });
    this.send(null, { t: 'player', player }, id);
  }

  leave(id: string) {
    const player = this.players.get(id);
    if (!player) return;
    this.release(player);
    this.players.delete(id);
    this.send(null, { t: 'gone', id });
  }

  handle(id: string, raw: unknown) {
    const player = this.players.get(id);
    if (!player || !raw || typeof raw !== 'object') return;
    const m = raw as Record<string, unknown>;
    switch (m.t) {
      case 'move': {
        const x = finite(m.x, -500, 500);
        const z = finite(m.z, -500, 500);
        const yaw = finite(m.yaw, -100, 100);
        if (x === null || z === null || yaw === null) return;
        Object.assign(player, { x, z, yaw });
        this.send(null, { t: 'move', id, x, z, yaw }, id);
        return;
      }
      case 'hands': {
        const hands = parseHands(m.hands);
        if (!hands) return;
        player.hands = hands;
        this.send(null, { t: 'player', player });
        if (m.bite === 0 || m.bite === 1) this.send(null, { t: 'bite', id, hand: m.bite }, id);
        return;
      }
      case 'score': {
        const game = ARCADE_GAMES.find((g) => g.id === m.game)?.id;
        const score = finite(m.score, 0, 1_000_000);
        if (!game || score === null || score < 1) return;
        const top = [...this.scores[game], { name: player.name, score: Math.floor(score) }]
          .sort((a, b) => b.score - a.score)
          .slice(0, TOP_SCORES);
        if (JSON.stringify(top) === JSON.stringify(this.scores[game])) return;
        this.scores = { ...this.scores, [game]: top };
        this.onScores?.(this.scores);
        this.send(null, { t: 'scores', game, top });
        return;
      }
      case 'ticket':
        return this.buyTicket(player, m);
      case 'join': {
        const showing = this.showings.get(Number(m.theater));
        if (!showing || (!showing.shared && showing.hostId !== id)) {
          return this.fail(id, 'That showing isn’t open to join.');
        }
        if (player.ticket !== showing.theater) this.release(player);
        player.ticket = showing.theater;
        this.send(null, { t: 'player', player });
        return;
      }
      case 'returnTicket':
        this.release(player);
        this.send(null, { t: 'player', player });
        return;
      case 'sit':
        return this.sit(player, m.seat);
      case 'stand':
        return this.stand(player);
      case 'control':
        return this.control(player, m);
      case 'ended': {
        const showing = this.mine(player);
        if (!showing || player.seat === null || showing.status === 'ended') return;
        showing.positionSeconds = positionAt(showing, this.now());
        showing.status = 'ended';
        showing.at = this.now();
        this.send(null, { t: 'showing', showing });
        return;
      }
      case 'react': {
        if (!(REACTIONS as readonly string[]).includes(String(m.emoji))) return;
        this.send(null, { t: 'react', id, emoji: String(m.emoji) });
        return;
      }
      case 'chat': {
        const message = text(m.text, 140);
        if (message) this.send(null, { t: 'chat', id, name: player.name, text: message });
        return;
      }
      case 'ping': {
        const c = finite(m.c, 0, Number.MAX_SAFE_INTEGER);
        if (c !== null) this.send(id, { t: 'pong', c, s: this.now() });
        return;
      }
    }
  }

  private fail(id: string, message: string) {
    this.send(id, { t: 'error', message });
  }

  private mine(player: TheaterPlayer): Showing | null {
    return player.ticket === null ? null : (this.showings.get(player.ticket) ?? null);
  }

  private buyTicket(player: TheaterPlayer, m: Record<string, unknown>) {
    const movieId = text(m.movieId, 120);
    if (!movieId) return;
    const shared = m.shared === true;
    const wanted =
      typeof m.theater === 'number' &&
      Number.isInteger(m.theater) &&
      m.theater >= 1 &&
      m.theater <= THEATER_COUNT
        ? m.theater
        : null;
    this.release(player);
    // A shared showing of the same movie: everyone ends up in the same theater.
    const same = shared
      ? [...this.showings.values()].find(
          (s) => s.shared && s.movieId === movieId && s.status !== 'ended',
        )
      : undefined;
    let theater = same?.theater;
    if (theater === undefined) {
      // The theater showing it today if it's free; otherwise the next free one
      // (a movie that isn't in the lineup always tries the same theater first).
      const start = wanted ?? (hash(movieId) % THEATER_COUNT) + 1;
      for (let k = 0; k < THEATER_COUNT && theater === undefined; k++) {
        const n = ((start - 1 + k) % THEATER_COUNT) + 1;
        if (!this.showings.has(n)) theater = n;
      }
      if (wanted !== null && theater !== undefined && theater !== wanted) {
        this.send(player.id, {
          t: 'notice',
          message: `Theater ${wanted} is busy with another showing, so yours is in Theater ${theater}.`,
        });
      }
    }
    if (theater === undefined) {
      this.send(null, { t: 'player', player });
      return this.fail(
        player.id,
        `All ${THEATER_COUNT} theaters are showing something. Join a showing, or try again when one finishes.`,
      );
    }
    if (!same) {
      const showing: Showing = {
        theater,
        movieId,
        title: text(m.title, 200) || 'Untitled',
        poster: typeof m.poster === 'string' ? m.poster.slice(0, 500) : null,
        runtimeMinutes: finite(m.runtimeMinutes, 0, 1000),
        hostId: player.id,
        hostName: player.name,
        shared,
        status: 'seating',
        positionSeconds: finite(m.startSeconds, 0, MAX_POSITION) ?? 0,
        at: this.now(),
      };
      this.showings.set(theater, showing);
      this.send(null, { t: 'showing', showing });
    }
    player.ticket = theater;
    this.send(null, { t: 'player', player });
  }

  /** Gives up a ticket (and seat); a theater nobody holds a ticket for closes. */
  private release(player: TheaterPlayer) {
    const theater = player.ticket;
    player.ticket = null;
    player.seat = null;
    if (theater === null) return;
    const showing = this.showings.get(theater);
    if (!showing) return;
    const others = [...this.players.values()].filter(
      (p) => p.id !== player.id && p.ticket === theater,
    );
    if (!others.length) {
      this.showings.delete(theater);
      this.send(null, { t: 'closed', theater });
      return;
    }
    if (showing.hostId === player.id) {
      showing.hostId = others[0]!.id;
      showing.hostName = others[0]!.name;
    }
    this.pauseIfEmpty(showing);
    this.send(null, { t: 'showing', showing });
  }

  private sit(player: TheaterPlayer, rawSeat: unknown) {
    const showing = this.mine(player);
    if (!showing) return this.fail(player.id, 'You need a ticket for this theater.');
    const seat = Number(rawSeat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= SEAT_COUNT) return;
    const taken = [...this.players.values()].some(
      (p) => p.id !== player.id && p.ticket === showing.theater && p.seat === seat,
    );
    if (taken) return this.fail(player.id, 'Someone’s sitting there.');
    player.seat = seat;
    this.send(null, { t: 'player', player });
    const now = this.now();
    // Sitting down starts the movie (after "3, 2, 1"); in a private showing it
    // also picks up where you left it when you stood up.
    if (
      showing.status === 'seating' ||
      (showing.status === 'paused' && (!showing.shared || this.seated(showing) === 1))
    ) {
      showing.status = 'playing';
      showing.at = now + COUNTDOWN_MS;
      this.send(null, { t: 'showing', showing });
    }
  }

  private stand(player: TheaterPlayer) {
    if (player.seat === null) return;
    player.seat = null;
    this.send(null, { t: 'player', player });
    const showing = this.mine(player);
    if (showing && this.pauseIfEmpty(showing)) this.send(null, { t: 'showing', showing });
  }

  private seated(showing: Showing) {
    return [...this.players.values()].filter((p) => p.ticket === showing.theater && p.seat !== null)
      .length;
  }

  /** Nobody left in the seats: hold the movie where it is. */
  private pauseIfEmpty(showing: Showing): boolean {
    if (showing.status !== 'playing' || this.seated(showing) > 0) return false;
    const now = this.now();
    showing.positionSeconds = positionAt(showing, now);
    showing.status = 'paused';
    showing.at = now;
    return true;
  }

  private control(player: TheaterPlayer, m: Record<string, unknown>) {
    const showing = this.mine(player);
    if (!showing || player.seat === null) return;
    if (!showing.shared && showing.hostId !== player.id) return;
    const now = this.now();
    const given = finite(m.positionSeconds, 0, MAX_POSITION);
    const current = positionAt(showing, now);
    switch (m.action) {
      case 'play':
        showing.positionSeconds = given ?? current;
        showing.status = 'playing';
        // Pressing play during the countdown keeps it.
        showing.at = Math.max(now, showing.at);
        break;
      case 'pause':
        showing.positionSeconds = given ?? current;
        showing.status = 'paused';
        showing.at = now;
        break;
      case 'seek':
        if (given === null) return;
        showing.positionSeconds = given;
        showing.at = now;
        if (showing.status === 'ended') showing.status = 'paused';
        break;
      default:
        return;
    }
    this.send(null, { t: 'showing', showing });
  }
}
