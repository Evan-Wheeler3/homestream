import { describe, expect, it } from 'vitest';
import { BLOCK } from '../../src/client/theater/blocks';
import { meshChunk } from '../../src/client/theater/grid';
import {
  buildBuilding,
  galleryPlan,
  HALL,
  LOBBY,
  placeAt,
  posterSlot,
  seatPose,
  seatWalkway,
  SPAWN,
  THEATERS,
  toWorld,
} from '../../src/client/theater/layout';
import { overlaps, step, type Body } from '../../src/client/theater/physics';

const { grid, gallery } = buildBuilding(120);

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
    expect(placeAt(SPAWN.x, SPAWN.z)).toEqual({ kind: 'lobby' });
  });

  it('walls stop you, and you slide along them', () => {
    const b = body(0, 0);
    walkTo(b, -20, 0);
    expect(b.x).toBeCloseTo(LOBBY.x0 + 0.3, 1);
    // Diagonally into the wall: still moving along it.
    walkTo(b, -20, -5);
    expect(b.z).toBeLessThan(-4);
  });

  it('walks from the doors down the hallway to The Collection', () => {
    const b = body(SPAWN.x, SPAWN.z);
    expect(walkTo(b, 0, -40).reached).toBe(true);
    expect(placeAt(b.x, b.z)).toEqual({ kind: 'hall' });
    expect(walkTo(b, 0, HALL.z0 - 2).reached).toBe(true);
    expect(placeAt(b.x, b.z)).toEqual({ kind: 'gallery' });
    // Round the zig-zag walls: through the gap at the east end of the first.
    const [first, second] = gallery.dividers;
    expect(walkTo(b, 8, first!.z + 2).reached).toBe(true);
    expect(walkTo(b, 8, first!.z - 2.5).reached).toBe(true);
    // The second wall's gap is at the west end.
    expect(walkTo(b, 8, second!.z - 2.5).reached).toBe(false);
  });

  it('a theater door needs a ticket for that theater', () => {
    const t = THEATERS[2]!; // Theater 3, on the left
    const doorZ = (t.door.z0 + t.door.z1) / 2;
    const b = body(0, doorZ);
    const inside = toWorld(t, 3, doorZ - t.zc);
    const without = walkTo(b, inside.x, inside.z, null, 5);
    expect(without.reached).toBe(false);
    expect(without.blockedBy).toBe(3);
    expect(walkTo(b, inside.x, inside.z, 1, 5).blockedBy).toBe(3);
    expect(walkTo(b, inside.x, inside.z, 3).reached).toBe(true);
    expect(placeAt(b.x, b.z)).toEqual({ kind: 'theater', number: 3 });
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
    const plan = galleryPlan(120);
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
    const arrays = meshChunk(grid, 0, grid.nx, 0, grid.nz, () => 0);
    const seen = new Set<string>();
    const p = arrays.opaque.positions;
    for (let q = 0; q < p.length; q += 12) {
      const key = Array.from({ length: 12 }, (_, i) => p[q + i]!.toFixed(3))
        .sort()
        .join();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBeGreaterThan(500);
  });
});
