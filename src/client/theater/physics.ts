// Walking through the block grid: you slide along walls, step up one block
// (stairs) without jumping, fall back down, and jump. Theater doorways only
// let you through with a ticket for that theater.
import type { VoxelGrid } from './grid';
import { VOXEL } from './grid';
import { doorwayAt, PLAYER_HEIGHT, PLAYER_RADIUS } from './layout';

export const WALK_SPEED = 5.5;
export const SPRINT_SPEED = 9;
const GRAVITY = 24;
const JUMP_SPEED = 7.2;

export interface Body {
  x: number;
  /** Feet. */
  y: number;
  z: number;
  vy: number;
  onGround: boolean;
}

export function overlaps(grid: VoxelGrid, x: number, y: number, z: number): boolean {
  const r = PLAYER_RADIUS;
  const e = 1e-6;
  for (let ix = grid.ix(x - r); ix <= grid.ix(x + r - e); ix++) {
    for (let iy = grid.iy(y + e); iy <= grid.iy(y + PLAYER_HEIGHT - e); iy++) {
      for (let iz = grid.iz(z - r); iz <= grid.iz(z + r - e); iz++) {
        if (grid.solidAt(ix, iy, iz)) return true;
      }
    }
  }
  return false;
}

/** The theater whose doorway you'd be standing in without its ticket, if any. */
function gated(x: number, z: number, ticket: number | null): number | null {
  for (const [dx, dz] of [
    [-PLAYER_RADIUS, -PLAYER_RADIUS],
    [PLAYER_RADIUS, -PLAYER_RADIUS],
    [-PLAYER_RADIUS, PLAYER_RADIUS],
    [PLAYER_RADIUS, PLAYER_RADIUS],
  ] as const) {
    const n = doorwayAt(x + dx, z + dz);
    if (n !== null && n !== ticket) return n;
  }
  return null;
}

export interface StepResult {
  /** A theater door that stopped you (no ticket). */
  blockedBy: number | null;
}

/**
 * Moves a body by (dx, dz) this frame, with gravity and an optional jump.
 * Each axis moves on its own, from wherever the last one left it, so you slide
 * along walls instead of sticking to them.
 */
export function step(
  grid: VoxelGrid,
  body: Body,
  dx: number,
  dz: number,
  dt: number,
  jump: boolean,
  ticket: number | null,
): StepResult {
  let blockedBy: number | null = null;
  const tryAxis = (nx: number, nz: number) => {
    const door = gated(nx, nz, ticket);
    if (door !== null) {
      blockedBy = door;
      return;
    }
    if (!overlaps(grid, nx, body.y, nz)) {
      body.x = nx;
      body.z = nz;
      return;
    }
    // One block up (a stair), if there's room.
    if (
      body.onGround &&
      !overlaps(grid, nx, body.y + VOXEL, nz) &&
      !overlaps(grid, body.x, body.y + VOXEL, body.z)
    ) {
      body.x = nx;
      body.z = nz;
      body.y += VOXEL;
    }
  };
  // Big moves (a slow frame) in small pieces, so nothing is skipped over.
  const pieces = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.2));
  for (let i = 0; i < pieces; i++) {
    tryAxis(body.x + dx / pieces, body.z);
    tryAxis(body.x, body.z + dz / pieces);
  }

  if (jump && body.onGround) {
    body.vy = JUMP_SPEED;
    body.onGround = false;
  }
  body.vy -= GRAVITY * dt;
  const ny = body.y + body.vy * dt;
  if (body.vy <= 0) {
    if (overlaps(grid, body.x, ny, body.z)) {
      // Landed: on top of the block below.
      body.y = Math.ceil((ny - grid.bounds.y0) / VOXEL - 1e-6) * VOXEL + grid.bounds.y0;
      if (overlaps(grid, body.x, body.y, body.z)) body.y += VOXEL;
      body.vy = 0;
      body.onGround = true;
    } else {
      body.y = ny;
      body.onGround = false;
    }
  } else if (overlaps(grid, body.x, ny, body.z)) {
    body.vy = 0; // bumped your head
  } else {
    body.y = ny;
    body.onGround = false;
  }
  return { blockedBy };
}
