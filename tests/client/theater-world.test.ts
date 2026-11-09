import { describe, expect, it } from 'vitest';
import { BLOCK } from '../../src/client/theater/blocks';
import { meshChunk } from '../../src/client/theater/grid';
import { statueFor } from '../../src/client/theater/statues';
import {
  buildBuilding,
  CHUNK,
  chunkOwner,
  galleryPlan,
  LOBBY,
  placeAt,
  planLayout,
  posterSlot,
  seatPose,
  seatWalkway,
  SPAWN,
  STATUE,
  THEATER_HALF_WIDTH,
  toWorld,
  type TheaterPlan,
} from '../../src/client/theater/layout';
import { overlaps, step, type Body } from '../../src/client/theater/physics';

const { grid, gallery, layout } = buildBuilding(120);
const THEATERS = layout.theaters;

/** Just outside a theater's door, in its corridor. */
const outsideDoor = (t: TheaterPlan) => toWorld(t, -2.2, THEATER_HALF_WIDTH - 1);
/** Up the main hall to a theater's corridor, then along it to the door. */
function walkToDoor(b: Body, t: TheaterPlan, ticket: number | null = null) {
  const zc = layout.wings[t.wing]!.zc;
  const door = outsideDoor(t);
  return walkTo(b, 0, zc, ticket, 120).reached && walkTo(b, door.x, door.z, ticket, 60).reached;
}

function body(x: number, z: number, y = 0): Body {
  return { x, y, z, vy: 0, onGround: true };
}

/** Walks toward a spot at 60 frames a second; returns where it ended up. */
function walkTo(b: Body, x: number, z: number, ticket: number | null = null, seconds = 30) {
  let blockedBy: number | null = null;
  for (let t = 0; t < seconds * 60; t++) {
    const dx = x - b.x;
    const dz = z - b.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.1) break;
    const s = Math.min(d, 5.5 / 60);
    const r = step(grid, b, (dx / d) * s, (dz / d) * s, 1 / 60, false, ticket);
    if (r.blockedBy !== null) blockedBy = r.blockedBy;
  }
  // Let it settle (fall onto whatever's below).
  for (let t = 0; t < 30; t++) step(grid, b, 0, 0, 1 / 60, false, ticket);
  return { reached: Math.hypot(x - b.x, z - b.z) < 0.15, blockedBy };
}

describe('the cinema building', () => {
  it('starts you on the lobby floor, with room to stand', () => {
    expect(overlaps(grid, SPAWN.x, 0, SPAWN.z)).toBe(false);
    expect(placeAt(layout, SPAWN.x, SPAWN.z)).toEqual({ kind: 'lobby' });
  });

  it('walls stop you, and you slide along them', () => {
    const b = body(0, 0);
    walkTo(b, -20, 0);
    expect(b.x).toBeCloseTo(LOBBY.x0 + 0.3, 1);
    // Diagonally into the wall: still moving along it.
    walkTo(b, -20, -5);
    expect(b.z).toBeLessThan(-4);
  });

  it('walks from the doors up the main hall to The Collection', () => {
    const b = body(SPAWN.x, SPAWN.z);
    expect(walkTo(b, 0, -40).reached).toBe(true);
    expect(placeAt(layout, b.x, b.z)).toEqual({ kind: 'hall' });
    expect(walkTo(b, 0, layout.hallZ0 - 2, null, 120).reached).toBe(true);
    expect(placeAt(layout, b.x, b.z)).toEqual({ kind: 'gallery' });
    // Round the zig-zag walls: through the gap at the east end of the first.
    const [first, second] = gallery.dividers;
    expect(walkTo(b, 8, first!.z + 2).reached).toBe(true);
    expect(walkTo(b, 8, first!.z - 2.5).reached).toBe(true);
    // The second wall's gap is at the west end.
    expect(walkTo(b, 8, second!.z - 2.5).reached).toBe(false);
  });

  it('every movie has its own theater, off corridors branching from the main hall', () => {
    expect(THEATERS).toHaveLength(120);
    expect(THEATERS.map((t) => t.number)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    // 12 down each arm of a corridor: 24 to a corridor, left and right.
    expect(layout.wings).toHaveLength(5);
    expect(layout.wings[0]!.west.theaters.map((t) => t.number)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect(layout.wings[0]!.east.theaters[0]!.number).toBe(13);
    // On both sides of the corridor.
    expect(new Set(THEATERS.slice(0, 12).map((t) => t.dir.z))).toEqual(new Set([1, -1]));
    // No two theaters overlap, and each is wholly inside the grid.
    for (const a of THEATERS) {
      expect(a.x0).toBeGreaterThan(grid.bounds.x0);
      expect(a.x1).toBeLessThan(grid.bounds.x1);
      for (const b of THEATERS) {
        if (a === b) continue;
        const apart = a.x1 <= b.x0 || b.x1 <= a.x0 || a.z1 <= b.z0 || b.z1 <= a.z0;
        expect(apart, `theaters ${a.number} and ${b.number}`).toBe(true);
      }
    }
    // Each door opens from a corridor into its theater.
    for (const t of THEATERS) {
      const door = toWorld(t, -0.5, THEATER_HALF_WIDTH - 1);
      const out = outsideDoor(t);
      const inside = toWorld(t, 1.5, THEATER_HALF_WIDTH - 1);
      for (const p of [door, out, inside]) expect(grid.at(p.x, 1, p.z)).toBe(BLOCK.air);
      expect(placeAt(layout, out.x, out.z)).toMatchObject({ kind: 'hall' });
      expect(placeAt(layout, inside.x, inside.z)).toEqual({ kind: 'theater', number: t.number });
    }
  });

  it('a new movie adds a theater at the end of the newest corridor, and nothing else moves', () => {
    const before = planLayout(30);
    const after = planLayout(31);
    expect(after.theaters).toHaveLength(31);
    expect(after.theaters.slice(0, 30)).toEqual(before.theaters);
    expect(after.theaters[30]!.wing).toBe(before.theaters[29]!.wing);
    // A full corridor: the next movie starts a new one, further up the main hall.
    const full = planLayout(32);
    const next = planLayout(33);
    expect(next.wings).toHaveLength(full.wings.length + 1);
    expect(next.hallZ0).toBeLessThan(full.hallZ0);
  });

  it('from inside any theater, all four of its walls are drawn', () => {
    // A wall is drawn with the chunk it's in: always, or with this theater, or with the
    // one next door that's drawn along with it.
    const ownerAt = (x: number, z: number) =>
      chunkOwner(
        layout,
        grid,
        Math.floor(grid.ix(x) / CHUNK) * CHUNK,
        Math.floor(grid.iz(z) / CHUNK) * CHUNK,
      );
    for (const t of THEATERS) {
      const shown = new Set([null, t.number, t.inner]);
      const walls = [
        ...[-THEATER_HALF_WIDTH - 0.25, THEATER_HALF_WIDTH + 0.25].flatMap((v) =>
          [1, 6, 11, 16, 21].map((u) => toWorld(t, u, v)),
        ),
        ...[-0.25, 22.25].flatMap((u) => [-6, 0, 3].map((v) => toWorld(t, u, v))),
      ];
      for (const w of walls) {
        expect(grid.at(w.x, 2, w.z), `theater ${t.number} wall`).not.toBe(BLOCK.air);
        expect(shown.has(ownerAt(w.x, w.z)), `theater ${t.number} wall at ${w.x},${w.z}`).toBe(
          true,
        );
      }
    }
  });

  it('a statue by every door, picked by genre, that you walk round (not through the door)', () => {
    expect(statueFor(['Drama', 'Science Fiction'])).toBe('rocket');
    expect(statueFor(['Comedy', 'Horror'])).toBe('pumpkin');
    expect(statueFor(['Western'])).toBe('cactus');
    expect(statueFor(['Drama'])).toBe('award');
    expect(statueFor(undefined)).toBe('award');
    for (const t of THEATERS) {
      const p = toWorld(t, STATUE.u, STATUE.v);
      expect(grid.at(p.x, 0.5, p.z), `theater ${t.number} pedestal`).toBe(BLOCK.barrier);
      // The doorway and the corridor down the middle stay clear.
      const door = toWorld(t, -1.5, THEATER_HALF_WIDTH - 1);
      expect(grid.at(door.x, 0.5, door.z)).toBe(BLOCK.air);
      const middle = toWorld(t, -4, STATUE.v);
      expect(grid.at(middle.x, 0.5, middle.z)).toBe(BLOCK.air);
    }
  });

  it('names the corridor you are in', () => {
    const t = THEATERS[13]!; // Theater 14: first corridor, right
    const out = outsideDoor(t);
    expect(placeAt(layout, out.x, out.z)).toEqual({ kind: 'hall', corridor: 'Theaters 13–24' });
  });

  it('a theater door needs a ticket for that theater', () => {
    const t = THEATERS[2]!; // Theater 3: first corridor, left
    const b = body(SPAWN.x, SPAWN.z);
    expect(walkToDoor(b, t)).toBe(true);
    const inside = toWorld(t, 3, THEATER_HALF_WIDTH - 1);
    const without = walkTo(b, inside.x, inside.z, null, 5);
    expect(without.reached).toBe(false);
    expect(without.blockedBy).toBe(3);
    expect(walkTo(b, inside.x, inside.z, 1, 5).blockedBy).toBe(3);
    expect(walkTo(b, inside.x, inside.z, 3).reached).toBe(true);
    expect(placeAt(layout, b.x, b.z)).toEqual({ kind: 'theater', number: 3 });
  });

  it('you can walk from the lobby to the furthest theater and in', () => {
    const t = THEATERS.at(-1)!;
    const b = body(SPAWN.x, SPAWN.z);
    expect(walkToDoor(b, t, t.number)).toBe(true);
    const inside = toWorld(t, 3, THEATER_HALF_WIDTH - 1);
    expect(walkTo(b, inside.x, inside.z, t.number).reached).toBe(true);
    expect(placeAt(layout, b.x, b.z)).toEqual({ kind: 'theater', number: t.number });
  });

  it('the aisle is stairs: you climb to the back row without jumping', () => {
    const t = THEATERS[0]!;
    const b = body(...(Object.values(toWorld(t, 3, 6.5)) as [number, number]));
    const back = toWorld(t, 20, 6.5);
    expect(walkTo(b, back.x, back.z, 1).reached).toBe(true);
    expect(b.y).toBeCloseTo(3, 5);
    // And back down again.
    const front = toWorld(t, 3, 6.5);
    expect(walkTo(b, front.x, front.z, 1).reached).toBe(true);
    expect(b.y).toBeCloseTo(0, 5);
  });

  it('rows have a walkway in front of the seats, and the seats themselves are solid', () => {
    const t = THEATERS[0]!;
    const b = body(0, 0);
    const aisle = toWorld(t, 3, 6.5);
    Object.assign(b, { x: aisle.x, z: aisle.z });
    const middle = seatWalkway(t, 24); // row C, middle
    // Up the aisle to row C's walkway, then along it.
    const aisleC = toWorld(t, 10.5, 6.5);
    expect(walkTo(b, aisleC.x, aisleC.z, 1).reached).toBe(true);
    expect(walkTo(b, middle.x, middle.z, 1).reached).toBe(true);
    expect(b.y).toBeCloseTo(middle.y, 5);
    // Straight into the seat: blocked.
    const seat = seatPose(t, 24);
    expect(walkTo(b, seat.x, seat.z, 1, 3).reached).toBe(false);
  });

  it('you can jump, and you land back on the floor', () => {
    const b = body(0, 0);
    step(grid, b, 0, 0, 1 / 60, true, null);
    let top = 0;
    for (let i = 0; i < 120; i++) {
      step(grid, b, 0, 0, 1 / 60, false, null);
      top = Math.max(top, b.y);
    }
    expect(top).toBeGreaterThan(0.8);
    expect(b.y).toBe(0);
    expect(b.onGround).toBe(true);
  });

  it('posters hang on the gallery walls, each in its own place', () => {
    const plan = galleryPlan(120, gallery.z1);
    const slots = Array.from({ length: 120 }, (_, i) => posterSlot(plan, i));
    const keys = new Set(slots.map((s) => `${s.x.toFixed(2)},${s.y},${s.z.toFixed(2)}`));
    expect(keys.size).toBe(120);
    for (const s of slots) {
      // Right against a wall block.
      const wallZ = s.facing === 1 ? s.z - 0.1 : s.z + 0.1;
      expect(grid.at(s.x, s.y, wallZ)).toBe(BLOCK.galleryWall);
    }
  });

  it('draws only faces you can see, and never two in the same place', () => {
    // The lobby and the first corridor.
    const arrays = meshChunk(grid, 0, grid.nx, grid.iz(-80), grid.nz, () => 0);
    const seen = new Set<string>();
    const p = arrays.opaque.positions;
    for (let q = 0; q < p.length; q += 12) {
      // The face's four corners, as points (in any order).
      const key = Array.from({ length: 4 }, (_, c) =>
        [0, 1, 2].map((a) => p[q + c * 3 + a]!.toFixed(3)).join(' '),
      )
        .sort()
        .join();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBeGreaterThan(500);
  });
});

describe('the statues designed for movies', () => {
  it('fit on the statue grid, stand on the pedestal, and have a name', async () => {
    const { MOVIE_STATUES } = await import('../../src/client/theater/designs');
    const { STATUE_GRID } = await import('../../src/shared/theater');
    expect(Object.keys(MOVIE_STATUES).length).toBeGreaterThanOrEqual(18);
    for (const [id, spec] of Object.entries(MOVIE_STATUES)) {
      expect(spec.name, id).toBeTruthy();
      expect(spec.boxes.length, id).toBeGreaterThan(3);
      expect(Math.min(...spec.boxes.map((b) => b[1])), `${id} stands on the pedestal`).toBe(0);
      for (const [x0, y0, z0, x1, y1, z1, color, glow] of spec.boxes) {
        expect(x0 >= 0 && x1 <= STATUE_GRID.x && x0 < x1, `${id} x`).toBe(true);
        expect(y0 >= 0 && y1 <= STATUE_GRID.y && y0 < y1, `${id} y`).toBe(true);
        expect(z0 >= 0 && z1 <= STATUE_GRID.z && z0 < z1, `${id} z`).toBe(true);
        expect(color >= 0 && color <= 0xffffff && (glow === 0 || glow === 1), id).toBe(true);
      }
    }
  });
});
