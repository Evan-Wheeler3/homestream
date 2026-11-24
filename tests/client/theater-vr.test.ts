import { describe, expect, it } from 'vitest';
import { buildBuilding, SPAWN, THEATER_HALF_WIDTH, toWorld } from '../../src/client/theater/layout';
import { overlaps } from '../../src/client/theater/physics';
import { vrMenu } from '../../src/client/theater/vrmenu';
import {
  buttonAt,
  castTeleport,
  layoutPanel,
  type VrPanelModel,
} from '../../src/client/theater/xr';

const { grid, layout } = buildBuilding(12);
const eye = (x: number, z: number) => ({ x, y: 1.6, z });
const down = { x: 0, y: -1, z: 0 };

describe('teleporting in VR', () => {
  it('lands on the lobby floor you point at', () => {
    const hit = castTeleport(grid, eye(SPAWN.x, SPAWN.z), { x: 0, y: -1, z: -1 }, null);
    expect(hit?.ok).toBe(true);
    expect(hit!.y).toBeCloseTo(0);
    expect(hit!.z).toBeCloseTo(SPAWN.z - 1.6, 1);
    expect(overlaps(grid, hit!.x, hit!.y, hit!.z)).toBe(false);
  });

  it('won’t put you in a wall you point straight at', () => {
    const hit = castTeleport(grid, eye(SPAWN.x, SPAWN.z), { x: 1, y: 0, z: 0 }, null, 40);
    expect(hit?.ok ?? false).toBe(false);
  });

  it('reaches only so far', () => {
    // Nearly level: the floor it would reach is well past the range.
    expect(
      castTeleport(grid, eye(SPAWN.x, SPAWN.z), { x: 0, y: -0.05, z: -1 }, null, 5),
    ).toBeNull();
  });

  it('keeps you out of a theater you have no ticket for', () => {
    const t = layout.theaters[0]!;
    // Somewhere in that theater's doorway.
    const near = toWorld(t, -2.2, THEATER_HALF_WIDTH - 1);
    let door: { x: number; z: number } | null = null;
    for (let dx = -4; dx <= 4 && !door; dx += 0.25) {
      for (let dz = -4; dz <= 4 && !door; dz += 0.25) {
        if (grid.doorway?.(near.x + dx, near.z + dz) === t.number)
          door = { x: near.x + dx, z: near.z + dz };
      }
    }
    expect(door).not.toBeNull();
    const without = castTeleport(grid, eye(door!.x, door!.z), down, null);
    expect(without).toMatchObject({ ok: false, blockedBy: t.number });
    const withTicket = castTeleport(grid, eye(door!.x, door!.z), down, t.number);
    expect(
      withTicket?.ok === true || (withTicket?.ok === false && withTicket.blockedBy === null),
    ).toBe(true);
  });
});

describe('the VR menu', () => {
  const model: VrPanelModel = {
    title: 'Lobby',
    lines: ['One line'],
    buttons: [
      { id: 'wide', label: 'Wide', wide: true },
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
      { id: 'wide2', label: 'Wide 2', wide: true },
    ],
  };
  const l = layoutPanel(model);
  const centre = (id: string) => {
    const r = l.buttons.find((b) => b.id === id)!;
    return { u: (r.x + r.w / 2) / l.width, v: 1 - (r.y + r.h / 2) / l.height };
  };

  it('lays buttons out two to a row, wide ones on their own', () => {
    const [wide, a, b, c, wide2] = l.buttons;
    expect(a!.y).toBe(b!.y);
    expect(a!.x).toBeLessThan(b!.x);
    expect(c!.y).toBeGreaterThan(a!.y);
    expect(wide2!.y).toBeGreaterThan(c!.y);
    expect(wide!.w).toBe(wide2!.w);
    expect(wide!.w).toBeGreaterThan(a!.w * 2);
    expect(wide2!.y + wide2!.h).toBeLessThan(l.height);
  });

  it('knows which button a pinch is pointing at', () => {
    for (const b of model.buttons) {
      const { u, v } = centre(b.id);
      expect(buttonAt(l, u, v)).toBe(b.id);
    }
    expect(buttonAt(l, 0.5, 0.99)).toBeNull(); // the title
  });

  const base = {
    vrPage: { kind: 'main' } as const,
    note: null,
    movies: Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      title: `Movie ${i}`,
      year: 2000 + i,
    })),
    seated: false,
    showing: undefined,
    countdown: 0,
    position: 0,
    duration: 0,
    canControl: false,
    needsTap: false,
    screenError: null,
    place: 'Lobby',
    ticket: null,
    ticketTitle: null,
    prompt: null,
  };
  const ids = (m: VrPanelModel) => m.buttons.map((b) => b.id);

  it('offers a ticket and a way to sit down once you have one', () => {
    expect(ids(vrMenu(base))).not.toContain('sit');
    const m = vrMenu({ ...base, ticket: 3, ticketTitle: 'Movie 2' });
    expect(ids(m)).toContain('sit');
    expect(m.lines.join(' ')).toContain('Theater 3');
    expect(ids(vrMenu({ ...base, prompt: { kind: 'boxoffice', label: 'Box office' } }))[0]).toBe(
      'use',
    );
  });

  it('pages through the movies at the box office', () => {
    const first = vrMenu({ ...base, vrPage: { kind: 'movies', page: 0 } });
    expect(ids(first).filter((id) => id.startsWith('movie:'))).toEqual([
      'movie:m0',
      'movie:m1',
      'movie:m2',
      'movie:m3',
      'movie:m4',
    ]);
    const last = vrMenu({ ...base, vrPage: { kind: 'movies', page: 2 } });
    expect(ids(last).filter((id) => id.startsWith('movie:'))).toEqual(['movie:m10', 'movie:m11']);
    expect(last.lines.at(-1)).toContain('page 3 of 3');
  });

  it('gives the seat controls while you watch', () => {
    const showing = { title: 'Movie 1', status: 'playing' } as Parameters<
      typeof vrMenu
    >[0]['showing'];
    const m = vrMenu({
      ...base,
      seated: true,
      showing,
      canControl: true,
      position: 75,
      duration: 5400,
    });
    expect(m.title).toBe('Movie 1');
    expect(m.buttons.find((b) => b.id === 'toggle')?.label).toBe('Pause');
    expect(ids(m)).toEqual(expect.arrayContaining(['back', 'ahead', 'stand', 'exit']));
    expect(m.lines[0]).toBe('Playing · 1:15 of 1:30:00');
    // Someone else's private screening: you can watch, not steer.
    expect(ids(vrMenu({ ...base, seated: true, showing, canControl: false }))).not.toContain(
      'toggle',
    );
  });
});
