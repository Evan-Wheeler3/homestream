import { describe, expect, it } from 'vitest';
import {
  COUNTDOWN_MS,
  countdownLeft,
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
    ticket(id: string, movieId = 'tmdb-680', shared = true, startSeconds = 0) {
      state.handle(id, {
        t: 'ticket',
        movieId,
        title: 'Pulp Fiction',
        poster: null,
        runtimeMinutes: 154,
        shared,
        startSeconds,
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
    h.state.handle('a', { t: 'snack', snack: 'caviar' });
    h.state.handle('a', { t: 'react', emoji: '💩' });
    h.state.handle('a', null);
    h.state.handle('nobody', { t: 'stand' });
    const p = h.state.players.get('a')!;
    expect(p.x).toBe(0);
    expect(p.snack).toBeNull();
    h.state.handle('a', { t: 'snack', snack: 'popcorn' });
    expect(p.snack).toBe('popcorn');
    h.state.handle('a', { t: 'ping', c: 42 });
    expect(h.last('a', 'pong')).toEqual({ t: 'pong', c: 42, s: h.now() });
  });
});
