import { describe, expect, it } from 'vitest';
import {
  COUNTDOWN_MS,
  countdownLeft,
  dailyLineup,
  positionAt,
  THEATER_COUNT,
  TheaterState,
  type ServerMessage,
} from '../../src/shared/theater';

function house() {
  let now = 1_000_000;
  const inbox = new Map<string, ServerMessage[]>();
  const ids: string[] = [];
  const state = new TheaterState(
    (to, message, except) => {
      for (const id of to === null ? ids : [to]) {
        if (id === except) continue;
        inbox.set(id, [...(inbox.get(id) ?? []), message]);
      }
    },
    () => now,
  );
  return {
    state,
    tick: (ms: number) => (now += ms),
    now: () => now,
    join(id: string, name = id) {
      ids.push(id);
      state.join(id, { userId: `u-${id}`, name, color: '#123456', emoji: '🦊', image: null });
    },
    leave(id: string) {
      ids.splice(ids.indexOf(id), 1);
      state.leave(id);
    },
    last(id: string, t: ServerMessage['t']) {
      return (inbox.get(id) ?? []).filter((m) => m.t === t).at(-1);
    },
    ticket(
      id: string,
      movieId = 'tmdb-680',
      shared = true,
      startSeconds = 0,
      theater: number | null = 1,
    ) {
      state.handle(id, {
        t: 'ticket',
        movieId,
        title: 'Pulp Fiction',
        poster: null,
        runtimeMinutes: 154,
        shared,
        startSeconds,
        theater: theater ?? undefined,
      });
    },
  };
}

describe('the theater', () => {
  it('welcomes people and tells everyone else they arrived and left', () => {
    const h = house();
    h.join('a', 'Evan');
    h.join('b', 'Sam');
    const welcome = h.last('b', 'welcome');
    expect(welcome?.t === 'welcome' && welcome.players.map((p) => p.name)).toEqual(['Evan', 'Sam']);
    expect(h.last('a', 'player')).toMatchObject({ player: { name: 'Sam' } });
    h.state.handle('b', { t: 'move', x: 3, z: -7, yaw: 1.5 });
    expect(h.last('a', 'move')).toEqual({ t: 'move', id: 'b', x: 3, z: -7, yaw: 1.5 });
    h.leave('b');
    expect(h.last('a', 'gone')).toEqual({ t: 'gone', id: 'b' });
  });

  it('sitting down starts the movie after a countdown, from where you left off', () => {
    const h = house();
    h.join('a');
    h.ticket('a', 'tmdb-680', false, 600);
    const player = h.state.players.get('a')!;
    expect(player.ticket).toBe(1);
    const showing = h.state.showings.get(1)!;
    expect(showing.status).toBe('seating');
    h.state.handle('a', { t: 'sit', seat: 12 });
    expect(showing.status).toBe('playing');
    expect(countdownLeft(showing, h.now())).toBe(COUNTDOWN_MS);
    expect(positionAt(showing, h.now())).toBe(600);
    h.tick(COUNTDOWN_MS + 10_000);
    expect(positionAt(showing, h.now())).toBeCloseTo(610);
    // A private showing pauses when you stand and starts again when you sit.
    h.state.handle('a', { t: 'stand' });
    expect(showing.status).toBe('paused');
    h.tick(60_000);
    expect(positionAt(showing, h.now())).toBeCloseTo(610);
    h.state.handle('a', { t: 'sit', seat: 3 });
    expect(showing.status).toBe('playing');
    expect(countdownLeft(showing, h.now())).toBe(COUNTDOWN_MS);
  });

  it('needs a ticket to sit, and one person per seat', () => {
    const h = house();
    h.join('a');
    h.join('b');
    h.state.handle('a', { t: 'sit', seat: 1 });
    expect(h.last('a', 'error')).toMatchObject({ message: expect.stringMatching(/ticket/) });
    h.ticket('a');
    h.ticket('b');
    h.state.handle('a', { t: 'sit', seat: 1 });
    h.state.handle('b', { t: 'sit', seat: 1 });
    expect(h.last('b', 'error')).toMatchObject({ message: expect.stringMatching(/sitting/) });
    h.state.handle('b', { t: 'sit', seat: 999 });
    expect(h.state.players.get('b')!.seat).toBeNull();
  });

  it('a shared showing puts everyone in the same theater, in step', () => {
    const h = house();
    h.join('a', 'Evan');
    h.join('b', 'Sam');
    h.ticket('a');
    h.state.handle('a', { t: 'sit', seat: 5 });
    h.tick(COUNTDOWN_MS + 30_000);
    // Buying a ticket to the same shared movie joins the showing already on.
    h.ticket('b');
    expect(h.state.players.get('b')!.ticket).toBe(1);
    h.state.handle('b', { t: 'sit', seat: 6 });
    const showing = h.state.showings.get(1)!;
    expect(positionAt(showing, h.now())).toBeCloseTo(30);
    // Anyone seated can pause and seek for everyone.
    h.state.handle('b', { t: 'control', action: 'pause' });
    expect(h.last('a', 'showing')).toMatchObject({
      showing: { status: 'paused', positionSeconds: 30 },
    });
    h.state.handle('a', { t: 'control', action: 'seek', positionSeconds: 90 });
    h.state.handle('a', { t: 'control', action: 'play' });
    h.tick(5_000);
    expect(positionAt(showing, h.now())).toBeCloseTo(95);
    // One standing up doesn't stop it for the other.
    h.state.handle('a', { t: 'stand' });
    expect(showing.status).toBe('playing');
    // The host leaving hands the showing over; the last one out closes it.
    h.leave('a');
    expect(showing.hostName).toBe('Sam');
    h.state.handle('b', { t: 'returnTicket' });
    expect(h.state.showings.size).toBe(0);
    expect(h.last('b', 'closed')).toEqual({ t: 'closed', theater: 1 });
  });

  it('private showings get their own theater, and only their holder controls them', () => {
    const h = house();
    h.join('a');
    h.join('b');
    h.ticket('a', 'tmdb-680', false);
    h.ticket('b', 'tmdb-680', false);
    expect(h.state.players.get('b')!.ticket).toBe(2);
    expect(h.last('b', 'notice')).toMatchObject({ message: expect.stringMatching(/Theater 2/) });
    h.state.handle('b', { t: 'join', theater: 1 });
    expect(h.last('b', 'error')).toMatchObject({ message: expect.stringMatching(/isn’t open/) });
  });

  it('says so when every theater is busy', () => {
    const h = house();
    for (let i = 0; i <= THEATER_COUNT; i++) {
      h.join(`p${i}`);
      h.ticket(`p${i}`, `movie-${i}`);
    }
    expect(h.state.showings.size).toBe(THEATER_COUNT);
    expect(h.state.players.get(`p${THEATER_COUNT}`)!.ticket).toBeNull();
    expect(h.last(`p${THEATER_COUNT}`, 'error')).toMatchObject({
      message: expect.stringMatching(/All 8 theaters/),
    });
  });

  it('ignores nonsense', () => {
    const h = house();
    h.join('a');
    h.state.handle('a', { t: 'move', x: Number.NaN, z: 0, yaw: 0 });
    h.state.handle('a', { t: 'hands', hands: [{ id: 'caviar', level: 1 }, null] });
    h.state.handle('a', { t: 'hands', hands: [null] });
    h.state.handle('a', { t: 'react', emoji: '💩' });
    h.state.handle('a', null);
    h.state.handle('nobody', { t: 'stand' });
    const p = h.state.players.get('a')!;
    expect(p.x).toBe(0);
    expect(p.hands).toEqual([null, null]);
    h.state.handle('a', { t: 'score', game: 'pinball', score: 50 });
    expect(h.state.scores).toEqual({ snake: [], breakout: [], catch: [] });
    h.state.handle('a', { t: 'ping', c: 42 });
    expect(h.last('a', 'pong')).toEqual({ t: 'pong', c: 42, s: h.now() });
  });

  it('a ticket goes to the theater showing the movie, or the next free one', () => {
    const h = house();
    h.join('a');
    h.ticket('a', 'movie-x', false, 0, 5);
    expect(h.state.players.get('a')!.ticket).toBe(5);
    // A movie that isn't in today's lineup doesn't always land in Theater 1.
    h.join('b');
    const landed = new Set<number>();
    for (const id of ['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6']) {
      h.ticket('b', id, false, 0, null);
      landed.add(h.state.players.get('b')!.ticket!);
    }
    expect(landed.size).toBeGreaterThan(2);
  });

  it('carries snacks, shows bites to others, and keeps the high scores', () => {
    const saved: unknown[] = [];
    let now = 0;
    const inbox: { to: string | null; m: { t: string } }[] = [];
    const state = new TheaterState(
      (to, m) => inbox.push({ to, m }),
      () => now++,
      (scores) => saved.push(scores),
    );
    state.join('a', { userId: 'u', name: 'Evan', color: null, emoji: null, image: null });
    state.handle('a', {
      t: 'hands',
      hands: [
        { id: 'popcorn', level: 0.75 },
        { id: 'soda', level: 1, down: true },
      ],
      bite: 0,
    });
    expect(state.players.get('a')!.hands).toEqual([
      { id: 'popcorn', level: 0.75 },
      { id: 'soda', level: 1, down: true },
    ]);
    expect(inbox.some(({ m }) => m.t === 'bite')).toBe(true);
    state.handle('a', { t: 'score', game: 'snake', score: 120 });
    state.handle('a', { t: 'score', game: 'snake', score: 300 });
    expect(state.scores.snake.map((s) => s.score)).toEqual([300, 120]);
    expect(saved).toHaveLength(2);
    expect(inbox.at(-1)!.m).toMatchObject({ t: 'scores', game: 'snake' });
  });
});

describe('today’s lineup', () => {
  const movies = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`,
    dateAdded: `2026-01-${String(i + 1).padStart(2, '0')}`,
  }));

  it('puts the newest arrival in Theater 1 and eight different movies in eight theaters', () => {
    const today = dailyLineup(movies, '2026-10-23');
    expect(today[0]).toBe('m19');
    expect(new Set(today).size).toBe(8);
    // The same for everyone on the same day, different on another day.
    expect(dailyLineup([...movies].reverse(), '2026-10-23')).toEqual(today);
    expect(dailyLineup(movies, '2026-10-24')).not.toEqual(today);
  });

  it('leaves theaters empty when the library is small', () => {
    expect(dailyLineup(movies.slice(0, 3), 'd')).toHaveLength(8);
    expect(dailyLineup(movies.slice(0, 3), 'd').filter(Boolean)).toHaveLength(3);
  });
});
