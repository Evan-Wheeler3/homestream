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

export const SNACKS = [
  { id: 'popcorn', label: 'Popcorn', emoji: '🍿' },
  { id: 'soda', label: 'Soda', emoji: '🥤' },
  { id: 'candy', label: 'Candy', emoji: '🍬' },
  { id: 'nachos', label: 'Nachos', emoji: '🧀' },
  { id: 'hotdog', label: 'Hot dog', emoji: '🌭' },
  { id: 'pretzel', label: 'Pretzel', emoji: '🥨' },
  { id: 'icecream', label: 'Ice cream', emoji: '🍦' },
] as const;
export type SnackId = (typeof SNACKS)[number]['id'];

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
  snack: SnackId | null;
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
  | { t: 'snack'; snack: SnackId | null }
  | {
      t: 'ticket';
      movieId: string;
      title: string;
      poster: string | null;
      runtimeMinutes: number | null;
      shared: boolean;
      startSeconds: number;
    }
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
  | { t: 'welcome'; you: string; players: TheaterPlayer[]; showings: Showing[]; now: number }
  | { t: 'player'; player: TheaterPlayer }
  | { t: 'move'; id: string; x: number; z: number; yaw: number }
  | { t: 'gone'; id: string }
  | { t: 'showing'; showing: Showing }
  | { t: 'closed'; theater: number }
  | { t: 'react'; id: string; emoji: string }
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

  constructor(
    private readonly send: Send,
    private readonly now: () => number = Date.now,
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
      snack: null,
      ticket: null,
      seat: null,
    };
    this.players.set(id, player);
    this.send(id, {
      t: 'welcome',
      you: id,
      players: [...this.players.values()],
      showings: [...this.showings.values()],
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
      case 'snack': {
        const snack = m.snack === null ? null : SNACKS.find((s) => s.id === m.snack)?.id;
        if (snack === undefined) return;
        player.snack = snack;
        this.send(null, { t: 'player', player });
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
    this.release(player);
    // A shared showing of the same movie: everyone ends up in the same theater.
    const same = shared
      ? [...this.showings.values()].find(
          (s) => s.shared && s.movieId === movieId && s.status !== 'ended',
        )
      : undefined;
    let theater = same?.theater;
    if (theater === undefined) {
      for (let n = 1; n <= THEATER_COUNT && theater === undefined; n++) {
        if (!this.showings.has(n)) theater = n;
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
