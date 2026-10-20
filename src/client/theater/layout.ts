// The cinema's floor plan, in metres (x east, z south, y up). Plain numbers and
// no 3D library, so the walls the camera bumps into and the ones that are drawn
// always agree, and the plan can be tested on its own.
//
//                 ┌──────── The Collection (every movie's poster) ────────┐
//                 └───────────────────────┬──┬───────────────────────────┘
//      Theater 7 ◄──────── screen │        │  │       │ screen ───────► Theater 8
//      Theater 5                   │  hall  │          Theater 6
//      Theater 3                   │        │          Theater 4
//      Theater 1                   │        │          Theater 2
//                 ┌────────────────┴────────┴───────────────┐
//                 │ Box office      ticket taker  Concessions│
//                 │ Restrooms           Lobby        Arcade  │
//                 └───────────────────[ doors ]──────────────┘
import { ROWS, SEATS_PER_ROW, THEATER_COUNT } from '../../shared/theater';

export const EYE_HEIGHT = 1.6;
export const SEATED_EYE_HEIGHT = 1.15;
export const PLAYER_RADIUS = 0.3;

export const LOBBY = { x0: -14, x1: 14, z0: -10, z1: 10, height: 7 };
export const HALL = { x0: -3, x1: 3, z0: -79, z1: -10, height: 7 };
export const BOX_OFFICE = { x: -8.5, z: -5.2 };
export const CONCESSIONS = { x: 8.5, z: -5.2 };
export const TICKET_TAKER = { x: 4.2, z: -8.6 };
export const ARCADE = [
  { x: 12.6, z: 0.5 },
  { x: 12.6, z: 2.5 },
  { x: 12.6, z: 4.5 },
];
export const RESTROOMS = [
  { z: 1, label: 'Restroom' },
  { z: 5.5, label: 'Restroom' },
];

/** Inside an auditorium: u is metres from the screen wall (the hall), v across it. */
export const THEATER_DEPTH = 22;
export const THEATER_HALF_WIDTH = 7.5;
export const THEATER_HEIGHT = 9;
export const SCREEN = { width: 10, bottom: 1.5, top: 7, u: 0.35 };
const ROW_STEP = 2;
const FIRST_ROW_U = 7;
const RISER = 0.45;

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
  /** The doorway in the hall wall (z range), at the front corner by the screen. */
  door: { z0: number; z1: number; wallX0: number; wallX1: number };
}

export function theaterPlan(number: number): TheaterPlan {
  const pair = Math.floor((number - 1) / 2);
  const side = number % 2 === 1 ? -1 : 1;
  const zc = -19.5 - pair * 17;
  const x0 = side === -1 ? -4 - THEATER_DEPTH : 4;
  const x1 = side === -1 ? -4 : 4 + THEATER_DEPTH;
  return {
    number,
    side,
    zc,
    x0,
    x1,
    z0: zc - THEATER_HALF_WIDTH,
    z1: zc + THEATER_HALF_WIDTH,
    door: {
      z0: zc + 5.5,
      z1: zc + THEATER_HALF_WIDTH,
      wallX0: side === -1 ? -4 : 3,
      wallX1: side === -1 ? -3 : 4,
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

export const rowU = (row: number) => FIRST_ROW_U + row * ROW_STEP;
export const rowHeight = (row: number) => RISER * (row + 1);

/** The stepped floor: flat by the screen, then one riser per row toward the back. */
export function stadiumHeight(u: number): number {
  if (u < FIRST_ROW_U - ROW_STEP / 2) return 0;
  const row = Math.min(ROWS - 1, Math.floor((u - (FIRST_ROW_U - ROW_STEP / 2)) / ROW_STEP));
  return rowHeight(row);
}

export function seatPose(t: TheaterPlan, seat: number) {
  const row = Math.floor(seat / SEATS_PER_ROW);
  const col = seat % SEATS_PER_ROW;
  const v = -(SEATS_PER_ROW - 1) / 2 + col;
  const { x, z } = toWorld(t, rowU(row) + 0.15, v);
  return { x, z, y: rowHeight(row), yaw: screenYaw(t), row, col };
}

export function theaterAt(x: number, z: number): TheaterPlan | null {
  return THEATERS.find((t) => x >= t.x0 && x <= t.x1 && z >= t.z0 && z <= t.z1) ?? null;
}

export function floorHeight(x: number, z: number): number {
  const t = theaterAt(x, z);
  return t ? stadiumHeight(toLocal(t, x, z).u) : 0;
}

// -----------------------------------------------------------------------------
// The Collection: free-standing walls of posters, in alphabetical order.

export const GALLERY_X = 12;
const DIVIDER_HALF = 9;
const POSTER_COLS = 14;
const POSTER_ROWS = 2;
const PER_FACE = POSTER_COLS * POSTER_ROWS;
const PER_DIVIDER = PER_FACE * 2;
const DIVIDER_GAP = 4;

export interface GalleryPlan {
  z0: number;
  z1: number;
  dividers: number[];
}

export function galleryPlan(movieCount: number): GalleryPlan {
  const count = Math.max(1, Math.ceil(movieCount / PER_DIVIDER));
  const dividers = Array.from({ length: count }, (_, i) => HALL.z0 - 4 - i * DIVIDER_GAP);
  return { z0: HALL.z0, z1: dividers.at(-1)! - 4, dividers };
}

export const POSTER_SIZE = { w: 1, h: 1.5 };

/** Where the i-th movie's poster hangs: its centre and which way it faces (+1 south). */
export function posterSlot(plan: GalleryPlan, i: number) {
  const divider = Math.floor(i / PER_DIVIDER);
  const k = i % PER_DIVIDER;
  const facing = k < PER_FACE ? 1 : -1;
  const j = k % PER_FACE;
  const col = j % POSTER_COLS;
  const row = Math.floor(j / POSTER_COLS);
  const span = (POSTER_COLS - 1) * 1.25;
  return {
    x: facing === 1 ? -span / 2 + col * 1.25 : span / 2 - col * 1.25,
    y: row === 0 ? 2.95 : 1.35,
    z: plan.dividers[divider]! + facing * 0.22,
    facing,
  };
}

export const dividerHalfLength = DIVIDER_HALF;

// -----------------------------------------------------------------------------
// What's solid: a half-metre grid. Doorways into theaters are solid unless you
// hold a ticket for that theater.

const CELL = 0.5;
const GX0 = -30;
const GX1 = 30;
const GZ1 = 20;

export type Place =
  | { kind: 'outside' }
  | { kind: 'lobby' }
  | { kind: 'hall' }
  | { kind: 'gallery' }
  | { kind: 'theater'; number: number };

export function placeAt(x: number, z: number, gallery: GalleryPlan): Place {
  const t = theaterAt(x, z);
  if (t) return { kind: 'theater', number: t.number };
  if (z > LOBBY.z1) return { kind: 'outside' };
  if (z >= LOBBY.z0) return { kind: 'lobby' };
  if (z >= HALL.z0) return { kind: 'hall' };
  if (z >= gallery.z1) return { kind: 'gallery' };
  return { kind: 'outside' };
}

export const placeName = (p: Place) =>
  p.kind === 'theater'
    ? `Theater ${p.number}`
    : { outside: 'Outside', lobby: 'Lobby', hall: 'Hallway', gallery: 'The Collection' }[p.kind];

export class SolidMap {
  private readonly cells: Uint8Array;
  private readonly cols: number;
  private readonly z0: number;

  constructor(readonly gallery: GalleryPlan) {
    this.z0 = gallery.z1 - 2;
    this.cols = Math.round((GX1 - GX0) / CELL);
    const rows = Math.round((GZ1 - this.z0) / CELL);
    // Everything starts solid; rooms are carved out, then furniture added.
    this.cells = new Uint8Array(this.cols * rows).fill(1);
    this.carve();
  }

  private index(x: number, z: number) {
    const cx = Math.floor((x - GX0) / CELL);
    const cz = Math.floor((z - this.z0) / CELL);
    if (cx < 0 || cx >= this.cols || cz < 0) return -1;
    const i = cz * this.cols + cx;
    return i < this.cells.length ? i : -1;
  }

  /** Sets every cell whose centre is inside the rectangle. */
  rect(x0: number, z0: number, x1: number, z1: number, value: number) {
    for (let x = Math.min(x0, x1) + CELL / 2; x < Math.max(x0, x1); x += CELL) {
      for (let z = Math.min(z0, z1) + CELL / 2; z < Math.max(z0, z1); z += CELL) {
        const i = this.index(x, z);
        if (i >= 0) this.cells[i] = value;
      }
    }
  }

  /** 0 free, 1 solid, 10 + n the doorway of theater n. */
  at(x: number, z: number) {
    const i = this.index(x, z);
    return i < 0 ? 1 : this.cells[i]!;
  }

  /** What stops someone standing at (x, z): null if nothing. */
  blocked(x: number, z: number, ticket: number | null): 'wall' | number | null {
    for (const [dx, dz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const c = this.at(x + dx * PLAYER_RADIUS, z + dz * PLAYER_RADIUS);
      if (c === 1) return 'wall';
      if (c >= 10 && c - 10 !== ticket) return c - 10;
    }
    return null;
  }

  private carve() {
    const free = (x0: number, z0: number, x1: number, z1: number) => this.rect(x0, z0, x1, z1, 0);
    const solid = (x0: number, z0: number, x1: number, z1: number) => this.rect(x0, z0, x1, z1, 1);
    free(LOBBY.x0, LOBBY.z0, LOBBY.x1, LOBBY.z1);
    free(HALL.x0, HALL.z0, HALL.x1, LOBBY.z0);
    free(-GALLERY_X, this.gallery.z1, GALLERY_X, HALL.z0);
    for (const t of THEATERS) {
      free(t.x0, t.z0, t.x1, t.z1);
      this.rect(t.door.wallX0, t.door.z0, t.door.wallX1, t.door.z1, 10 + t.number);
      // Seats.
      for (let seat = 0; seat < ROWS * SEATS_PER_ROW; seat++) {
        const p = seatPose(t, seat);
        solid(p.x - 0.4, p.z - 0.4, p.x + 0.4, p.z + 0.4);
      }
    }
    // Lobby furniture: counters, the ticket taker's podium, arcade machines, benches.
    solid(BOX_OFFICE.x - 3.5, LOBBY.z0, BOX_OFFICE.x + 3.5, BOX_OFFICE.z - 1.3);
    solid(CONCESSIONS.x - 3.5, LOBBY.z0, CONCESSIONS.x + 3.5, CONCESSIONS.z - 1.3);
    solid(TICKET_TAKER.x - 0.6, TICKET_TAKER.z - 0.6, TICKET_TAKER.x + 0.6, TICKET_TAKER.z + 0.6);
    for (const a of ARCADE) solid(a.x - 0.6, a.z - 0.6, LOBBY.x1, a.z + 0.6);
    solid(-8, 2.5, -5, 3.5);
    solid(5, 2.5, 8, 3.5);
    // Gallery walls.
    for (const z of this.gallery.dividers) solid(-DIVIDER_HALF, z - 0.25, DIVIDER_HALF, z + 0.25);
  }
}
