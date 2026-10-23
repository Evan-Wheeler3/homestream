// The cinema's floor plan, in metres (x east, z south, y up), built as a grid of
// half-metre blocks: the building starts as solid block, rooms are carved out
// of it, and each room paints its own walls, floor and ceiling. What you see
// and what you walk into come from the same grid.
//
//            ┌──────────── The Collection (a zig-zag gallery, A to Z) ────────────┐
//            └──────────────────────────────┬──┬──────────────────────────────────┘
//   Theater 7 (screen on the hall wall)  ◄  │  │  ►  Theater 8
//   Theater 5                            ◄  │  │  ►  Theater 6
//   Theater 3                            ◄  │  │  ►  Theater 4
//   Theater 1                            ◄  │  │  ►  Theater 2
//            ┌──────────────────────────────┴──┴──────────────────────────────────┐
//            │ Box office   NOW SHOWING     usher        Concessions   (menu)     │
//            │ Restrooms                Lobby                         Arcade     │
//            └───────────────────────────[ glass doors ]──────────────────────────┘
//                                     sidewalk and street
import { ROWS, SEATS_PER_ROW, THEATER_COUNT } from '../../shared/theater';
import { BLOCK } from './blocks';
import { VoxelGrid, VOXEL, type Bounds } from './grid';

export const EYE_HEIGHT = 1.62;
export const SEATED_EYE_HEIGHT = 1.12;
export const PLAYER_RADIUS = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const SPAWN = { x: 0, z: 6, yaw: 0 };

export const LOBBY = { x0: -15, x1: 15, z0: -10, z1: 10, height: 7 };
export const HALL = { x0: -3, x1: 3, z0: -76, z1: -11, height: 7 };
export const GALLERY = { x0: -11, x1: 11, z1: -77, height: 6 };
export const BOX_OFFICE = { x0: -13, x1: -6, z0: -7, z1: -6 };
export const CONCESSIONS = { x0: 6, x1: 13, z0: -7, z1: -6 };
export const USHER = { x: 4, z: -8.5 };
export const ARCADE_Z = [0.5, 2.5, 4.5];
export const CLAW = { x0: 13, x1: 15, z0: 7, z1: 8.5 };
export const RESTROOMS = [2, 6];
export const TRASH = [
  { x: -4.75, z: -9.25 },
  { x: 5.25, z: -9.25 },
];
export const STANDEES = [
  { x: -5.25, z: 1.25 },
  { x: 5.25, z: 1.25 },
];

/** Inside an auditorium: u is metres from the screen wall (the hall), v across it. */
export const THEATER_DEPTH = 22;
export const THEATER_HALF_WIDTH = 7.5;
export const THEATER_HEIGHT = 9;
/** The screen: on the hall wall, in front of a black frame. */
export const SCREEN = { u: 0.52, width: 10.4, bottom: 1.2, top: 7.3 };
const FIRST_ROW_U = 6;
const ROW_STEP = 2;
const RISER = 0.5;

export interface TheaterPlan {
  number: number;
  /** -1: west of the hall, 1: east. */
  side: -1 | 1;
  /** The middle of the auditorium along the hall. */
  zc: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** The doorway in the hall wall, at the front corner by the screen. */
  door: { x0: number; x1: number; z0: number; z1: number };
}

export function theaterPlan(number: number): TheaterPlan {
  const pair = Math.floor((number - 1) / 2);
  const side = number % 2 === 1 ? -1 : 1;
  const zc = -19 - pair * 16;
  return {
    number,
    side,
    zc,
    x0: side === -1 ? -4 - THEATER_DEPTH : 4,
    x1: side === -1 ? -4 : 4 + THEATER_DEPTH,
    z0: zc - THEATER_HALF_WIDTH,
    z1: zc + THEATER_HALF_WIDTH,
    door: {
      x0: side === -1 ? -4 : 3,
      x1: side === -1 ? -3 : 4,
      z0: zc + 5.5,
      z1: zc + THEATER_HALF_WIDTH,
    },
  };
}

export const THEATERS = Array.from({ length: THEATER_COUNT }, (_, i) => theaterPlan(i + 1));

export function toLocal(t: TheaterPlan, x: number, z: number) {
  return { u: t.side === -1 ? -4 - x : x - 4, v: z - t.zc };
}

export function toWorld(t: TheaterPlan, u: number, v: number) {
  return { x: t.side === -1 ? -4 - u : 4 + u, z: t.zc + v };
}

/** Facing the screen (yaw 0 looks toward -z). */
export const screenYaw = (t: TheaterPlan) => (t.side === -1 ? -Math.PI / 2 : Math.PI / 2);

/** Row r's platform starts here (its front edge) and is one riser higher than the last. */
export const rowU = (row: number) => FIRST_ROW_U + row * ROW_STEP;
export const rowHeight = (row: number) => RISER * (row + 1);
/** Seats sit at the back half of each row's platform; you stand in front of them. */
const SEAT_U = 1.25;
const WALKWAY_U = 0.5;

export function seatPose(t: TheaterPlan, seat: number) {
  const row = Math.floor(seat / SEATS_PER_ROW);
  const col = seat % SEATS_PER_ROW;
  const v = -(SEATS_PER_ROW - 1) / 2 + col;
  const { x, z } = toWorld(t, rowU(row) + SEAT_U, v);
  return { x, z, y: rowHeight(row), yaw: screenYaw(t), row, col, u: rowU(row) + SEAT_U, v };
}

/** Where you stand to sit in a seat: the walkway in front of its row. */
export function seatWalkway(t: TheaterPlan, seat: number) {
  const p = seatPose(t, seat);
  return { ...toWorld(t, rowU(p.row) + WALKWAY_U, p.v), y: p.y };
}

export function theaterAt(x: number, z: number): TheaterPlan | null {
  return THEATERS.find((t) => x > t.x0 && x < t.x1 && z > t.z0 && z < t.z1) ?? null;
}

// -----------------------------------------------------------------------------
// The Collection: a zig-zag gallery. Walls run out from alternate sides, so you
// walk a snake past every poster, A to Z.

const DIVIDER_GAP = 5;
const POSTER_COLS = 12;
const POSTER_ROWS = 2;
const PER_FACE = POSTER_COLS * POSTER_ROWS;
const PER_DIVIDER = PER_FACE * 2;

export interface GalleryPlan {
  /** The far (north) end. */
  z0: number;
  dividers: { z: number; x0: number; x1: number }[];
}

export function galleryPlan(movieCount: number): GalleryPlan {
  const count = Math.max(1, Math.ceil(movieCount / PER_DIVIDER));
  const dividers = Array.from({ length: count }, (_, i) => ({
    // The wall is the half metre north of z.
    z: GALLERY.z1 - DIVIDER_GAP * (i + 1),
    x0: i % 2 === 0 ? GALLERY.x0 : GALLERY.x0 + 6,
    x1: i % 2 === 0 ? GALLERY.x1 - 6 : GALLERY.x1,
  }));
  return { z0: dividers.at(-1)!.z - VOXEL - DIVIDER_GAP, dividers };
}

export const POSTER_SIZE = { w: 1, h: 1.5 };

/** Where the i-th movie's poster hangs: its middle, and which way it faces (+1 south). */
export function posterSlot(plan: GalleryPlan, i: number) {
  const d = plan.dividers[Math.floor(i / PER_DIVIDER)]!;
  const k = i % PER_DIVIDER;
  const facing = k < PER_FACE ? 1 : -1;
  const j = k % PER_FACE;
  const col = j % POSTER_COLS;
  const row = Math.floor(j / POSTER_COLS);
  const span = d.x1 - d.x0 - 1.8;
  const step = span / (POSTER_COLS - 1);
  return {
    x: facing === 1 ? d.x0 + 0.9 + col * step : d.x1 - 0.9 - col * step,
    // Eye level first, then the row above.
    y: row === 0 ? 1.7 : 3.45,
    z: facing === 1 ? d.z + 0.02 : d.z - VOXEL - 0.02,
    facing,
  };
}

export function postersPerDivider() {
  return PER_DIVIDER;
}

// -----------------------------------------------------------------------------
// Places

export type Place =
  | { kind: 'outside' }
  | { kind: 'lobby' }
  | { kind: 'hall' }
  | { kind: 'gallery' }
  | { kind: 'theater'; number: number };

export function placeAt(x: number, z: number): Place {
  const t = theaterAt(x, z);
  if (t) return { kind: 'theater', number: t.number };
  if (z > LOBBY.z1) return { kind: 'outside' };
  if (z >= LOBBY.z0) return { kind: 'lobby' };
  if (z >= HALL.z0 - 0.5) return { kind: 'hall' };
  return { kind: 'gallery' };
}

export const placeName = (p: Place) =>
  p.kind === 'theater'
    ? `Theater ${p.number}`
    : { outside: 'Outside', lobby: 'Lobby', hall: 'Hallway', gallery: 'The Collection' }[p.kind];

// -----------------------------------------------------------------------------
// Building the grid

interface Room {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  /** The block for a surface cell next to this room, at (x, y, z) (cell middles, metres). */
  paint(surface: 'floor' | 'ceiling' | 'wall', x: number, y: number, z: number): number;
}

const lobbyPaint: Room['paint'] = (surface, x, y, z) => {
  if (surface === 'floor') {
    if (z > LOBBY.z1 - 2 && Math.abs(x) < 3) return BLOCK.carpetRed;
    const edge = Math.min(x - LOBBY.x0, LOBBY.x1 - x, z - LOBBY.z0, LOBBY.z1 - z);
    return edge < 1 ? BLOCK.carpetGold : BLOCK.carpetDiamond;
  }
  if (surface === 'ceiling') {
    const mx = (((x - LOBBY.x0) % 5) + 5) % 5;
    const mz = (((z - LOBBY.z0) % 5) + 5) % 5;
    return mx > 2 && mx < 3.5 && mz > 2 && mz < 3.5 ? BLOCK.light : BLOCK.ceiling;
  }
  if (y < 1) return BLOCK.wainscot;
  if (y > 2.5 && y < 3) return BLOCK.neonPink;
  if (y > 5 && y < 5.5) return BLOCK.neonTeal;
  return BLOCK.plaster;
};

const hallPaint: Room['paint'] = (surface, x, y, z) => {
  if (surface === 'floor') return Math.abs(x) < 1 ? BLOCK.runner : BLOCK.hallCarpet;
  if (surface === 'ceiling') {
    const m = ((z % 4) + 4) % 4;
    return m > 1.5 && m < 2.5 && Math.abs(x) < 1 ? BLOCK.light : BLOCK.ceiling;
  }
  if (y < 1) return BLOCK.wainscot;
  if (y > 5 && y < 5.5) return x < 0 ? BLOCK.neonPink : BLOCK.neonTeal;
  return BLOCK.plaster;
};

function theaterPaint(t: TheaterPlan): Room['paint'] {
  return (surface, x, y, z) => {
    if (surface === 'floor') return BLOCK.carpetRed;
    if (surface === 'ceiling') return BLOCK.starCeiling;
    const { u } = toLocal(t, x, z);
    return (Math.floor(Math.max(0, u) / 2) + Math.floor(y / 2)) % 2
      ? BLOCK.acoustic
      : BLOCK.acousticAlt;
  };
}

const galleryPaint: Room['paint'] = (surface, x, y, z) => {
  if (surface === 'floor') return BLOCK.galleryFloor;
  if (surface === 'ceiling') {
    // A light strip down each corridor.
    const m = (((GALLERY.z1 - z) % DIVIDER_GAP) + DIVIDER_GAP) % DIVIDER_GAP;
    return m > 2 && m < 3 && Math.abs(x) < 9 ? BLOCK.light : BLOCK.ceiling;
  }
  if (y > GALLERY.height - 0.5) return BLOCK.neonYellow;
  return BLOCK.galleryWall;
};

const doorwayPaint =
  (inner: Room['paint']): Room['paint'] =>
  (surface, x, y, z) =>
    surface === 'floor' ? inner('floor', x, y, z) : BLOCK.gold;

export interface Building {
  grid: VoxelGrid;
  gallery: GalleryPlan;
}

/** The grid's z boundaries fall every 8 m from the lobby's back wall, so each auditorium is two whole chunks. */
export const CHUNK = 16;

export function buildBuilding(movieCount: number): Building {
  const gallery = galleryPlan(movieCount);
  const chunkM = CHUNK * VOXEL;
  const k = Math.ceil((-11 - (gallery.z0 - 1)) / chunkM);
  const bounds: Bounds = { x0: -28, x1: 28, y0: -0.5, y1: 10, z0: -11 - k * chunkM, z1: 21 };
  const grid = new VoxelGrid(bounds);
  grid.cells.fill(BLOCK.rock);

  const rooms: Room[] = [];
  const carve = (room: Room) => {
    rooms.push(room);
    grid.fill(room.x0, room.y0, room.z0, room.x1, room.y1, room.z1, BLOCK.air);
  };

  // Outside: the sidewalk and street in front of the doors.
  carve({
    x0: bounds.x0,
    x1: bounds.x1,
    y0: 0,
    y1: bounds.y1,
    z0: LOBBY.z1 + 1,
    z1: bounds.z1,
    paint: (surface, _x, _y, z) =>
      surface === 'floor' ? (z < LOBBY.z1 + 5 ? BLOCK.sidewalk : BLOCK.asphalt) : BLOCK.facade,
  });
  carve({ ...LOBBY, y0: 0, y1: LOBBY.height, paint: lobbyPaint });
  // Into the hallway.
  carve({
    x0: HALL.x0,
    x1: HALL.x1,
    y0: 0,
    y1: 3.5,
    z0: HALL.z1,
    z1: LOBBY.z0,
    paint: doorwayPaint(hallPaint),
  });
  carve({ ...HALL, y0: 0, y1: HALL.height, paint: hallPaint });
  for (const t of THEATERS) {
    carve({
      x0: t.x0,
      x1: t.x1,
      y0: 0,
      y1: THEATER_HEIGHT,
      z0: t.z0,
      z1: t.z1,
      paint: theaterPaint(t),
    });
    carve({ ...t.door, y0: 0, y1: 3, paint: doorwayPaint(theaterPaint(t)) });
  }
  // The Collection.
  carve({
    x0: HALL.x0,
    x1: HALL.x1,
    y0: 0,
    y1: 4,
    z0: GALLERY.z1,
    z1: HALL.z0,
    paint: doorwayPaint(galleryPaint),
  });
  carve({
    x0: GALLERY.x0,
    x1: GALLERY.x1,
    y0: 0,
    y1: GALLERY.height,
    z0: gallery.z0,
    z1: GALLERY.z1,
    paint: galleryPaint,
  });

  // Each room paints the solid cells around it.
  const dirs = [
    [1, 0, 0, 'wall'],
    [-1, 0, 0, 'wall'],
    [0, 0, 1, 'wall'],
    [0, 0, -1, 'wall'],
    [0, 1, 0, 'ceiling'],
    [0, -1, 0, 'floor'],
  ] as const;
  for (const room of rooms) {
    for (let iz = grid.iz(room.z0); iz < grid.iz(room.z1 - 1e-6) + 1; iz++) {
      for (let iy = grid.iy(room.y0); iy < grid.iy(room.y1 - 1e-6) + 1; iy++) {
        for (let ix = grid.ix(room.x0); ix < grid.ix(room.x1 - 1e-6) + 1; ix++) {
          if (grid.get(ix, iy, iz) !== BLOCK.air) continue;
          for (const [dx, dy, dz, surface] of dirs) {
            if (grid.get(ix + dx, iy + dy, iz + dz) !== BLOCK.rock) continue;
            grid.set(
              ix + dx,
              iy + dy,
              iz + dz,
              room.paint(surface, grid.cx(ix + dx), grid.cy(iy + dy), grid.cz(iz + dz)),
            );
          }
        }
      }
    }
  }

  // Glass doors.
  grid.fill(-3, 0, LOBBY.z1, 3, 3, LOBBY.z1 + 1, BLOCK.glass);
  grid.fill(-0.5, 0, LOBBY.z1, 0.5, 3, LOBBY.z1 + 1, BLOCK.gold);

  // The box office: a counter, gold pillars and glass, a gold header.
  grid.fill(BOX_OFFICE.x0, 0, BOX_OFFICE.z0, BOX_OFFICE.x1, 1, BOX_OFFICE.z1, BLOCK.counter);
  grid.fill(
    BOX_OFFICE.x0,
    1.5,
    BOX_OFFICE.z0,
    BOX_OFFICE.x1,
    2.5,
    BOX_OFFICE.z0 + 0.5,
    BLOCK.glass,
  );
  for (const x of [BOX_OFFICE.x0, -10, BOX_OFFICE.x1 - 0.5]) {
    grid.fill(x, 1, BOX_OFFICE.z0, x + 0.5, 3, BOX_OFFICE.z0 + 0.5, BLOCK.gold);
  }
  grid.fill(BOX_OFFICE.x0, 2.5, BOX_OFFICE.z0, BOX_OFFICE.x1, 3, BOX_OFFICE.z0 + 0.5, BLOCK.gold);
  // Concessions: the front counter with a candy case, and the back counter.
  grid.fill(CONCESSIONS.x0, 0, CONCESSIONS.z0, CONCESSIONS.x1, 1, CONCESSIONS.z1, BLOCK.counter);
  grid.fill(10.5, 1, CONCESSIONS.z0, 12.5, 1.5, CONCESSIONS.z0 + 0.5, BLOCK.glass);
  grid.fill(CONCESSIONS.x0, 0, LOBBY.z0, LOBBY.x1, 1, LOBBY.z0 + 1, BLOCK.counter);
  // The usher's podium.
  grid.fill(USHER.x - 0.5, 0, USHER.z - 0.5, USHER.x + 0.5, 1, USHER.z + 0.5, BLOCK.oak);
  // Arcade machines against the east wall, and the claw machine.
  [BLOCK.cabinetPurple, BLOCK.cabinetTeal, BLOCK.cabinetPink].forEach((block, i) => {
    const z = ARCADE_Z[i]!;
    grid.fill(14, 0, z - 0.5, 15, 2.5, z + 0.5, block);
    grid.fill(13.5, 0.5, z - 0.5, 14, 1, z + 0.5, BLOCK.black);
  });
  grid.fill(CLAW.x0, 0, CLAW.z0, CLAW.x1, 1, CLAW.z1, BLOCK.metal);
  grid.fill(CLAW.x0, 1, CLAW.z0, CLAW.x1, 2.5, CLAW.z1, BLOCK.glass);
  grid.fill(CLAW.x0, 2.5, CLAW.z0, CLAW.x1, 3, CLAW.z1, BLOCK.neonPink);
  // Benches, plants, bins, restroom doors and the standees' bases.
  for (const z of [3, 6]) {
    grid.fill(-10, 0, z, -7, 0.5, z + 0.5, BLOCK.oak);
    grid.fill(-10, 0, z + 0.5, -7, 1, z + 1, BLOCK.darkOak);
  }
  for (const x of [-14.5, 13.5]) {
    grid.fill(x, 0, 8.5, x + 1, 0.5, 9.5, BLOCK.pot);
    grid.fill(x, 0.5, 8.5, x + 1, 2, 9.5, BLOCK.leaves);
  }
  for (const b of TRASH)
    grid.fill(b.x - 0.25, 0, b.z - 0.25, b.x + 0.25, 1, b.z + 0.25, BLOCK.trash);
  for (const z of RESTROOMS)
    grid.fill(LOBBY.x0 - 0.5, 0, z - 0.5, LOBBY.x0, 2.5, z + 0.5, BLOCK.darkOak);
  for (const s of STANDEES)
    grid.fill(s.x - 0.25, 0, s.z - 0.25, s.x + 0.25, 1.5, s.z + 0.25, BLOCK.barrier);

  // Each auditorium: stepped rows, a stage, the screen's frame, seats (solid,
  // drawn separately), wall lights, speakers and the projection window.
  for (const t of THEATERS) {
    const box = (
      u0: number,
      u1: number,
      y0: number,
      y1: number,
      v0: number,
      v1: number,
      id: number,
    ) => {
      const a = toWorld(t, u0, v0);
      const b = toWorld(t, u1, v1);
      grid.fill(a.x, y0, a.z, b.x, y1, b.z, id);
    };
    for (let r = 0; r < ROWS; r++) {
      box(
        rowU(r),
        r === ROWS - 1 ? THEATER_DEPTH : rowU(r) + ROW_STEP,
        0,
        rowHeight(r),
        -THEATER_HALF_WIDTH,
        THEATER_HALF_WIDTH,
        BLOCK.tread,
      );
      // The seats: you can't walk through them (or step up onto them).
      box(
        rowU(r) + 1,
        rowU(r) + 1.5,
        rowHeight(r),
        rowHeight(r) + 1,
        -SEATS_PER_ROW / 2,
        SEATS_PER_ROW / 2,
        BLOCK.barrier,
      );
    }
    box(0.5, 1.5, 0, 0.5, -5.5, 5.5, BLOCK.stage);
    box(0, 0.5, 1, 7.5, -5.5, 5.5, BLOCK.black);
    // Lights and speakers along the side walls; the projector at the back.
    for (const v of [-THEATER_HALF_WIDTH - 0.5, THEATER_HALF_WIDTH]) {
      for (let u = 4; u < THEATER_DEPTH; u += 4) box(u, u + 0.5, 5, 5.5, v, v + 0.5, BLOCK.light);
      for (const u of [3, 11]) box(u, u + 1, 3.5, 5, v, v + 0.5, BLOCK.speaker);
    }
    box(THEATER_DEPTH, THEATER_DEPTH + 0.5, 7, 7.5, -0.5, 0.5, BLOCK.projector);
    // A bin by the door, for the empties.
    box(2, 2.5, 0, 1, -THEATER_HALF_WIDTH, -THEATER_HALF_WIDTH + 0.5, BLOCK.trash);
    // Gold around the doorway, on both sides of the wall.
    const d = t.door;
    grid.fill(d.x0, 3, d.z0 - 0.5, d.x1, 3.5, d.z1 + 0.5, BLOCK.gold);
    grid.fill(d.x0, 0, d.z0 - 0.5, d.x1, 3, d.z0, BLOCK.gold);
    grid.fill(d.x0, 0, d.z1, d.x1, 3, d.z1 + 0.5, BLOCK.gold);
  }

  // The Collection's walls of posters.
  for (const d of gallery.dividers) {
    grid.fill(d.x0, 0, d.z - VOXEL, d.x1, GALLERY.height, d.z, BLOCK.galleryWall);
    grid.fill(d.x0, 0, d.z - VOXEL, d.x1, 0.5, d.z, BLOCK.darkOak);
  }
  return { grid, gallery };
}

/** The bin inside each auditorium (by the screen, across from the door). */
export const theaterTrash = (t: TheaterPlan) => toWorld(t, 2.25, -THEATER_HALF_WIDTH + 0.25);

/** Which theater's doorway (if any) a spot is in. */
export function doorwayAt(x: number, z: number): number | null {
  for (const t of THEATERS) {
    const d = t.door;
    if (x > d.x0 - 0.05 && x < d.x1 + 0.05 && z > d.z0 && z < d.z1) return t.number;
  }
  return null;
}
