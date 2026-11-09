// Builds the 3D cinema: the block grid (layout.ts) turned into textured chunks,
// plus everything that isn't a whole block: seats with cupholders, curtains,
// screens, signs, the machines behind the counters, standees and posters.
import * as THREE from 'three';
import {
  ARCADE_GAMES,
  SEAT_COUNT,
  SNACKS,
  type ArcadeGameId,
  type StatueSpec,
} from '../../shared/theater';
import { Avatar } from './avatars';
import { BLOCKS, tile } from './blocks';
import { meshChunk, VOXEL } from './grid';
import {
  ARCADE_Z,
  armRange,
  buildBuilding,
  CHUNK,
  CLAW,
  CORRIDOR,
  HALL,
  LOBBY,
  POSTER_SIZE,
  posterSlot,
  postersPerDivider,
  RESTROOMS,
  SCREEN,
  seatPose,
  STATUE,
  STANDEES,
  chunkOwner,
  theaterTrash,
  THEATER_DEPTH,
  THEATER_HALF_WIDTH,
  toWorld,
  TRASH,
  USHER,
  type Building,
  type Layout,
  type Place,
  type TheaterPlan,
} from './layout';
import { addSeat, BoxBuilder, geometryOf, materials, meshOf } from './models';
import { MOVIE_STATUES } from './designs';
import { buildDesignedStatue, buildStatue, statueFor } from './statues';
import { canvasTexture, drawBoard, drawSign, PosterAtlas, signTexture } from './textures';

export interface GalleryMovie {
  id: string;
  title: string;
  year: number | null;
  poster: string | null;
  /** Picks the statue by its theater's door. */
  genres?: string[];
}

export interface TheaterView {
  plan: TheaterPlan;
  /** Everything inside the auditorium: hidden when it can't be seen. */
  group: THREE.Group;
  screen: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  beam: THREE.Mesh;
  curtains: { left: THREE.Mesh; right: THREE.Mesh; open: number; target: number };
  doorSign: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture };
}

export interface Hotspot {
  kind: 'boxoffice' | 'concessions' | 'usher' | 'arcade' | 'claw' | 'restroom' | 'trash';
  x: number;
  z: number;
  radius: number;
  label: string;
  game?: ArcadeGameId;
}

export interface World {
  root: THREE.Group;
  building: Building;
  layout: Layout;
  atlas: PosterAtlas;
  /** The auditoriums near you (they're built as you get close, and let go when you leave). */
  views: Map<number, TheaterView>;
  /** Called when an auditorium has just been built, and when it's let go. */
  onView: ((view: TheaterView) => void) | null;
  onDrop: ((theater: number) => void) | null;
  hotspots: Hotspot[];
  arcadeScreens: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture }[];
  /** The poster nearest the middle of your view, within a few metres. */
  posterInView(x: number, z: number, yaw: number): string | undefined;
  /** Draws only what can be seen from a place. */
  showFrom(place: Place, x: number, z: number): void;
  /**
   * Builds what's near (x, z) and lets go of what's far away, a few pieces at a
   * time (or everything at once with `all`, e.g. after jumping somewhere).
   */
  update(x: number, z: number, all?: boolean): void;
  animate(time: number, dt: number): void;
  dispose(): void;
}

// Planes face +z by default; these turn them.
const FACE = { south: 0, north: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 };
/** Turns a plane to face a direction. */
const facing = (d: { x: number; z: number }) => Math.atan2(d.x, d.z);

/** Blocks are drawn within this distance (metres), and let go beyond the second. */
const CHUNKS_IN = 72;
const CHUNKS_OUT = 88;
/** Auditoriums (seats, screen, curtains, signs) are built within this distance. */
const ROOMS_IN = 40;
const ROOMS_OUT = 52;
/** How many chunks or auditoriums to build per update while walking. */
const BUDGET = 3;

export function buildWorld(
  movies: GalleryMovie[],
  lineup: (string | null)[],
  /** Statues designed for particular movies (the rest get one for their genre). */
  statues: Record<string, StatueSpec> = MOVIE_STATUES,
): World {
  const root = new THREE.Group();
  const mats = materials();
  const disposables: { dispose(): void }[] = [];
  const titleOf = (id: string | null | undefined) => movies.find((m) => m.id === id)?.title ?? '';
  const sorted = [...movies].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  );
  const building = buildBuilding(sorted.length);
  const { grid, gallery, layout } = building;
  const atlas = new PosterAtlas(sorted);
  disposables.push(atlas.texture);

  // ---------------------------------------------------------------------------
  // The block grid, in 8 m chunks, drawn near you. Chunks inside an auditorium
  // belong to it (hidden unless you can see into it).
  const groups = new Map<number, THREE.Group>();
  const groupFor = (n: number) => {
    let g = groups.get(n);
    if (!g) {
      g = new THREE.Group();
      groups.set(n, g);
      root.add(g);
    }
    return g;
  };
  const tileFor = (id: number, face: 'top' | 'side' | 'bottom') => tile(BLOCKS[id]![face]);
  interface Chunk {
    ix: number;
    iz: number;
    x: number;
    z: number;
    owner: number | null;
    meshes: THREE.Mesh[] | null;
  }
  const chunks: Chunk[] = [];
  for (let ix = 0; ix < grid.nx; ix += CHUNK) {
    for (let iz = 0; iz < grid.nz; iz += CHUNK) {
      const x = grid.bounds.x0 + (ix + CHUNK / 2) * VOXEL;
      const z = grid.bounds.z0 + (iz + CHUNK / 2) * VOXEL;
      chunks.push({ ix, iz, x, z, owner: chunkOwner(layout, grid, ix, iz), meshes: null });
    }
  }
  const meshChunkAt = (c: Chunk) => {
    const parts = meshChunk(
      grid,
      c.ix,
      c.ix + CHUNK,
      c.iz,
      c.iz + CHUNK,
      tileFor,
      c.owner ? 0.85 : 1,
    );
    c.meshes = [];
    for (const kind of ['opaque', 'glow', 'glass'] as const) {
      if (!parts[kind].indices.length) continue;
      const mesh = new THREE.Mesh(geometryOf(parts[kind]), mats[kind]);
      mesh.matrixAutoUpdate = false;
      (c.owner ? groupFor(c.owner) : root).add(mesh);
      c.meshes.push(mesh);
    }
  };
  const dropChunk = (c: Chunk) => {
    for (const m of c.meshes ?? []) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    c.meshes = null;
  };

  // Builders for the small things, per part of the building.
  const lobby = { opaque: new BoxBuilder(), glow: new BoxBuilder(), glass: new BoxBuilder() };
  const flush = (b: typeof lobby, parent: THREE.Object3D) => {
    for (const kind of ['opaque', 'glow', 'glass'] as const) {
      if (b[kind].empty) continue;
      const mesh = meshOf(b[kind], kind);
      disposables.push(mesh.geometry);
      parent.add(mesh);
    }
  };

  const plane = (
    w: number,
    h: number,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    yaw: number,
    parent: THREE.Object3D = root,
  ) => {
    const geometry = new THREE.PlaneGeometry(w, h);
    disposables.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    parent.add(mesh);
    return mesh;
  };
  const sign = (
    lines: string[],
    w: number,
    h: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    style: Parameters<typeof signTexture>[1] = {},
    parent: THREE.Object3D = root,
  ) => {
    const texture = signTexture(lines, style);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    disposables.push(texture, material);
    return plane(w, h, material, x, y, z, yaw, parent);
  };
  /** A sign seen from both sides (hanging from the ceiling). */
  const hanging = (
    front: string[],
    back: string[],
    w: number,
    h: number,
    x: number,
    y: number,
    z: number,
  ) => {
    sign(front, w, h, x, y, z + 0.03, FACE.south, {
      color: '#ffd23f',
      glow: '#ffd23f',
      border: '#ffd23f',
    });
    sign(back, w, h, x, y, z - 0.03, FACE.north, {
      color: '#2ee6d6',
      glow: '#2ee6d6',
      border: '#2ee6d6',
    });
    lobby.opaque.box(
      x - w / 2 + 0.2,
      y + h / 2,
      z - 0.02,
      x - w / 2 + 0.25,
      HALL.height,
      z + 0.02,
      'metal',
    );
    lobby.opaque.box(
      x + w / 2 - 0.25,
      y + h / 2,
      z - 0.02,
      x + w / 2 - 0.2,
      HALL.height,
      z + 0.02,
      'metal',
    );
  };

  // ---------------------------------------------------------------------------
  // The lobby
  sign(['WHEELHOUSE', 'CINEMAS'], 10, 2.2, 0, 5.3, LOBBY.z0 + 0.02, FACE.south, {
    width: 192,
    height: 42,
    color: '#ffd23f',
    glow: '#ff3fa4',
    background: '#1a0820',
    border: '#ff3fa4',
  });
  const bulbsA = new BoxBuilder();
  const bulbsB = new BoxBuilder();
  let n = 0;
  for (let x = -5.1; x <= 5.1; x += 0.34) {
    for (const y of [4.12, 6.48]) {
      (n++ % 2 ? bulbsA : bulbsB).box(
        x - 0.07,
        y - 0.07,
        LOBBY.z0,
        x + 0.07,
        y + 0.07,
        LOBBY.z0 + 0.1,
        'neonYellow',
        { fit: true },
      );
    }
  }
  const bulbMeshA = meshOf(bulbsA, 'glow');
  const bulbMeshB = meshOf(bulbsB, 'glow');
  root.add(bulbMeshA, bulbMeshB);
  disposables.push(bulbMeshA.geometry, bulbMeshB.geometry);

  // Now Showing above the box office, the menu above concessions.
  const nowShowing = document.createElement('canvas');
  // The newest arrivals, and their theaters.
  const newest = lineup
    .map((id, i) => ({ id, theater: i + 1 }))
    .reverse()
    .slice(0, 8);
  drawBoard(
    nowShowing,
    'NOW SHOWING',
    newest.map((m) => [String(m.theater), titleOf(m.id) || '—']),
    { heading: '#2ee6d6', accent: '#2ee6d6' },
  );
  const nowTexture = canvasTexture(nowShowing);
  const nowMaterial = new THREE.MeshBasicMaterial({ map: nowTexture });
  disposables.push(nowTexture, nowMaterial);
  plane(6.6, 2.64, nowMaterial, -9.5, 5.05, LOBBY.z0 + 0.02, FACE.south);
  const menu = document.createElement('canvas');
  drawBoard(
    menu,
    'CONCESSIONS',
    SNACKS.map((s) => [`$${s.price}`, s.label]),
    { heading: '#ff8a3d', accent: '#ffd23f' },
  );
  const menuTexture = canvasTexture(menu);
  const menuMaterial = new THREE.MeshBasicMaterial({ map: menuTexture });
  disposables.push(menuTexture, menuMaterial);
  plane(7.6, 3.04, menuMaterial, 10.5, 5.05, LOBBY.z0 + 0.02, FACE.south);
  sign(['BOX OFFICE'], 3.6, 0.5, -9.5, 3.3, -6.48, FACE.south, {
    width: 128,
    height: 18,
    color: '#2ee6d6',
    glow: '#2ee6d6',
  });
  sign(['ARCADE'], 4.4, 0.9, LOBBY.x1 - 0.02, 3.4, 2.5, FACE.west, {
    color: '#ffd23f',
    glow: '#ff3fa4',
  });
  for (const z of RESTROOMS) {
    sign(['RESTROOM'], 1.6, 0.4, LOBBY.x0 + 0.02, 2.85, z, FACE.east, {
      width: 96,
      height: 22,
      color: '#2ee6d6',
    });
  }

  // Behind the concessions counter: popcorn machine, soda fountain, hot dog roller.
  const bc = { y: 1, z0: LOBBY.z0 + 0.1, z1: LOBBY.z0 + 0.9 };
  lobby.opaque.box(6.5, bc.y, bc.z0, 8, bc.y + 0.15, bc.z1, 'metal');
  lobby.glass.box(6.55, bc.y + 0.15, bc.z0 + 0.05, 7.95, bc.y + 1.2, bc.z1 - 0.05, 'glass');
  lobby.opaque.box(6.5, bc.y + 1.2, bc.z0, 8, bc.y + 1.45, bc.z1, {
    top: 'gold',
    side: 'counterRed',
  });
  for (let i = 0; i < 24; i++) {
    const px = 6.65 + ((i * 37) % 11) * 0.11;
    const pz = bc.z0 + 0.12 + ((i * 17) % 5) * 0.11;
    lobby.opaque.box(
      px,
      bc.y + 0.15,
      pz,
      px + 0.13,
      bc.y + 0.25 + ((i * 7) % 4) * 0.05,
      pz + 0.13,
      'kernels',
      { fit: true },
    );
  }
  const kernels = new THREE.Group();
  const kernelGeometry = new THREE.BoxGeometry(0.06, 0.06, 0.06);
  const kernelMaterial = new THREE.MeshBasicMaterial({ color: 0xfff1b8 });
  disposables.push(kernelGeometry, kernelMaterial);
  for (let i = 0; i < 12; i++) {
    const k = new THREE.Mesh(kernelGeometry, kernelMaterial);
    k.userData.phase = i / 12;
    kernels.add(k);
  }
  kernels.position.set(7.25, bc.y + 0.3, (bc.z0 + bc.z1) / 2);
  root.add(kernels);
  lobby.opaque.box(8.4, bc.y, bc.z0, 9.9, bc.y + 1.05, bc.z0 + 0.55, {
    top: 'darkMetal',
    side: 'metal',
  });
  ['#e8343f', '#ff8a3d', '#2ee6d6', '#7b2cbf'].forEach((c, i) => {
    const col = new THREE.Color(c);
    lobby.glow.box(
      8.55 + i * 0.33,
      bc.y + 0.55,
      bc.z0 + 0.55,
      8.75 + i * 0.33,
      bc.y + 0.85,
      bc.z0 + 0.58,
      'white',
      {
        fit: true,
        tint: [col.r, col.g, col.b],
      },
    );
  });
  lobby.opaque.box(10.3, bc.y, bc.z0, 11.8, bc.y + 0.25, bc.z1, 'metal');
  for (let i = 0; i < 5; i++) {
    lobby.opaque.box(
      10.4,
      bc.y + 0.25,
      bc.z0 + 0.1 + i * 0.13,
      11.7,
      bc.y + 0.33,
      bc.z0 + 0.18 + i * 0.13,
      'sausage',
      { fit: true },
    );
  }
  // Registers, and candy in the glass case.
  for (const [x, z] of [
    [-9.5, -6.75],
    [8, -6.75],
  ] as const) {
    lobby.opaque.box(x - 0.25, 1, z - 0.2, x + 0.25, 1.25, z + 0.2, 'darkMetal');
    lobby.glow.box(x - 0.2, 1.25, z - 0.15, x + 0.2, 1.45, z - 0.12, 'neonTeal', { fit: true });
  }
  const candy = [
    [1, 0.25, 0.64],
    [1, 0.82, 0.25],
    [0.18, 0.9, 0.84],
    [1, 0.54, 0.24],
    [0.48, 0.17, 0.75],
  ] as const;
  for (let i = 0; i < 20; i++) {
    const x = 10.6 + (i % 10) * 0.19;
    const y = 1.03 + Math.floor(i / 10) * 0.2;
    lobby.opaque.box(x, y, -6.95, x + 0.15, y + 0.15, -6.6, 'white', {
      fit: true,
      tint: [...candy[i % candy.length]!],
    });
  }

  // A rope queue in front of the box office.
  for (let x = -12.5; x <= -6.5; x += 1.5) {
    lobby.opaque.box(x - 0.05, 0, -3.65, x + 0.05, 0.95, -3.55, 'gold', { fit: true });
    lobby.opaque.box(x - 0.08, 0, -3.68, x + 0.08, 0.05, -3.52, 'gold', { fit: true });
    if (x < -6.6) lobby.opaque.box(x, 0.82, -3.62, x + 1.5, 0.88, -3.58, 'rope');
  }

  // Standees of the two newest movies.
  const posterQuads: {
    movieId: string;
    x: number;
    y: number;
    z: number;
    yaw: number;
    w: number;
    h: number;
  }[] = [];
  STANDEES.forEach((s, i) => {
    const id = newest[i]?.id;
    if (!id) return;
    lobby.opaque.box(s.x - 0.05, 0, s.z - 0.05, s.x + 0.05, 0.6, s.z + 0.05, 'black', {
      fit: true,
    });
    lobby.opaque.box(s.x - 0.35, 0, s.z - 0.25, s.x + 0.35, 0.05, s.z + 0.25, 'black', {
      fit: true,
    });
    posterQuads.push({
      movieId: id,
      x: s.x,
      y: 1.55,
      z: s.z + 0.27,
      yaw: FACE.south,
      w: 1.2,
      h: 1.8,
    });
    lobby.opaque.box(s.x - 0.64, 0.6, s.z + 0.2, s.x + 0.64, 2.5, s.z + 0.25, 'gold', {
      fit: true,
    });
  });

  // The claw machine's prizes, and its claw.
  const plush = ['plushPink', 'plushBlue', 'plushYellow'] as const;
  for (let i = 0; i < 9; i++) {
    const x = CLAW.x0 + 0.25 + (i % 3) * 0.5;
    const z = CLAW.z0 + 0.25 + Math.floor(i / 3) * 0.42;
    lobby.opaque.box(x, 1, z, x + 0.3, 1.2 + (i % 2) * 0.1, z + 0.3, plush[i % 3]!, { fit: true });
  }
  lobby.opaque.box(13.95, 1.9, 7.7, 14.05, 2.5, 7.8, 'metal');
  lobby.opaque.box(13.85, 1.75, 7.6, 14.15, 1.9, 7.9, 'metal');

  // New arrivals on the front wall, by the doors.
  movies.slice(0, 8).forEach((m, i) => {
    const left = i < 4;
    const k = i % 4;
    const x = left ? -13.2 + k * 2.1 : 6.9 + k * 2.1;
    posterQuads.push({
      movieId: m.id,
      x,
      y: 3.6,
      z: LOBBY.z1 - 0.03,
      yaw: FACE.north,
      w: 1.5,
      h: 2.25,
    });
  });
  if (movies.length) {
    sign(['NEW ARRIVALS'], 3.4, 0.55, -10, 5.3, LOBBY.z1 - 0.03, FACE.north, {
      color: '#ff3fa4',
      glow: '#ff3fa4',
    });
    sign(['NEW ARRIVALS'], 3.4, 0.55, 10, 5.3, LOBBY.z1 - 0.03, FACE.north, {
      color: '#2ee6d6',
      glow: '#2ee6d6',
    });
  }

  // Staff.
  const staff = [
    { x: -9.5, z: -8.4, emoji: '🎟️', color: '#2ee6d6' },
    { x: 10, z: -8, emoji: '🍿', color: '#ff8a3d' },
    { x: USHER.x + 0.1, z: USHER.z - 0.95, emoji: '😀', color: '#ff3fa4' },
  ].map((s) => {
    const a = new Avatar({ name: '', color: s.color, emoji: s.emoji, staff: true });
    a.target.set(s.x, 0, s.z);
    a.targetYaw = Math.PI;
    a.update(0, 0);
    root.add(a.group);
    return a;
  });

  // Outside: parked cars, street lamps, the road's centre line.
  const car = (x: number, z: number, color: [number, number, number]) => {
    lobby.opaque.box(x, 0.25, z, x + 4, 1, z + 1.8, 'white', { tint: color });
    lobby.opaque.box(x + 0.8, 1, z + 0.1, x + 3, 1.6, z + 1.7, 'white', { tint: color });
    lobby.glass.box(x + 0.85, 1.05, z + 0.05, x + 2.95, 1.55, z + 1.75, 'glass');
    for (const wx of [x + 0.5, x + 2.8]) {
      lobby.opaque.box(wx, 0, z - 0.05, wx + 0.7, 0.6, z + 0.2, 'black');
      lobby.opaque.box(wx, 0, z + 1.6, wx + 0.7, 0.6, z + 1.85, 'black');
    }
  };
  car(-15, 16.5, [0.18, 0.9, 0.84]);
  car(8, 16.7, [1, 0.25, 0.64]);
  for (const x of [-12, 12]) {
    lobby.opaque.box(x - 0.1, 0, 13, x + 0.1, 5, 13.2, 'darkMetal');
    lobby.glow.box(x - 0.4, 5, 12.8, x + 0.4, 5.3, 13.4, 'lightPanel', { fit: true });
  }
  for (let x = -26; x < 26; x += 4)
    lobby.glow.box(x, 0.01, 18.4, x + 2, 0.03, 18.6, 'neonYellow', { fit: true });

  // ---------------------------------------------------------------------------
  // The main hall: which theaters are down each corridor, at every turn.
  const count = layout.theaters.length;
  hanging(
    [count ? `THEATERS 1–${count}` : 'THE COLLECTION'],
    ['LOBBY AND EXIT'],
    5.6,
    0.7,
    0,
    4.6,
    HALL.z1 - 1.5,
  );
  for (const w of layout.wings) {
    const west = armRange(w.west.theaters).replace('Theaters ', '').replace('Theater ', '');
    const east = armRange(w.east.theaters).replace('Theaters ', '').replace('Theater ', '');
    const arrows = (left: string, right: string) =>
      [left && `◀ ${left}`, right && `${right} ▶`].filter(Boolean).join('      ');
    hanging(
      [arrows(west, east)],
      [arrows(east, west)],
      5.6,
      0.7,
      0,
      4.6,
      w.zc + CORRIDOR.halfWidth + 2.5,
    );
  }
  sign(
    ['THE COLLECTION', `${sorted.length} ${sorted.length === 1 ? 'MOVIE' : 'MOVIES'} · A TO Z`],
    6,
    1.4,
    0,
    5.4,
    layout.hallZ0 + 0.02,
    FACE.south,
    { color: '#ffd23f', glow: '#ffd23f', border: '#ffd23f' },
  );

  // Beside each theater's door (corridor side): a statue for its movie, and its
  // poster in a light box.
  for (const t of layout.theaters) {
    const id = lineup[t.number - 1];
    if (!id) continue;
    const movie = movies.find((m) => m.id === id);
    // The statue faces the corridor; x is to your right as you face it.
    const at = (sx: number, sy: number, sz: number): [number, number, number] => {
      const w = toWorld(t, STATUE.u - sz, STATUE.v - sx * t.across);
      return [w.x, sy, w.z];
    };
    const designed = statues[id];
    if (designed) buildDesignedStatue(designed, lobby, at);
    else buildStatue(statueFor(movie?.genres), lobby, at);
    const out = { x: -t.dir.x, z: -t.dir.z };
    const p = toWorld(t, -1.01, THEATER_HALF_WIDTH - 3.5);
    posterQuads.push({ movieId: id, x: p.x, y: 2.1, z: p.z, yaw: facing(out), w: 1.2, h: 1.8 });
    const frame = (v0: number, v1: number, y0: number, y1: number) => {
      const a = toWorld(t, -1.06, v0);
      const b = toWorld(t, -1, v1);
      lobby.glow.box(a.x, y0, a.z, b.x, y1, b.z, 'lightPanel', { fit: true });
    };
    const v = THEATER_HALF_WIDTH - 3.5;
    frame(v - 0.7, v + 0.7, 1.1, 1.18);
    frame(v - 0.7, v + 0.7, 3.02, 3.1);
    frame(v - 0.7, v - 0.62, 1.1, 3.1);
    frame(v + 0.62, v + 0.7, 1.1, 3.1);
  }

  const screenGeometry = new THREE.PlaneGeometry(1, 1);
  disposables.push(screenGeometry);

  /** Builds one auditorium's insides (and the sign over its door). */
  const buildView = (t: TheaterPlan): { view: TheaterView; own: { dispose(): void }[] } => {
    const own: { dispose(): void }[] = [];
    const group = groupFor(t.number);
    // The sign over the door sits in the corridor, so it's drawn even when the room isn't.
    const outside = new THREE.Group();
    root.add(outside);
    own.push({ dispose: () => outside.removeFromParent() });
    const ownPlane = (
      w: number,
      h: number,
      material: THREE.Material,
      at: { x: number; z: number },
      y: number,
      yaw: number,
      parent: THREE.Object3D,
    ) => {
      const mesh = new THREE.Mesh(screenGeometry, material);
      mesh.scale.set(w, h, 1);
      mesh.position.set(at.x, y, at.z);
      mesh.rotation.y = yaw;
      parent.add(mesh);
      return mesh;
    };
    const inside = { opaque: new BoxBuilder(), glow: new BoxBuilder(), glass: new BoxBuilder() };
    const tb = (
      b: BoxBuilder,
      u0: number,
      u1: number,
      y0: number,
      y1: number,
      v0: number,
      v1: number,
      faces: Parameters<BoxBuilder['box']>[6],
      fit = false,
    ) => {
      const a = toWorld(t, u0, v0);
      const c = toWorld(t, u1, v1);
      b.box(a.x, y0, a.z, c.x, y1, c.z, faces, { fit });
    };
    const inward = facing(t.dir);
    const out = facing({ x: -t.dir.x, z: -t.dir.z });

    // Over the door (corridor side): the theater number and what's on.
    const doorCanvas = document.createElement('canvas');
    drawSign(
      doorCanvas,
      [`THEATER ${t.number}`, titleOf(lineup[t.number - 1]).toUpperCase() || 'COMING SOON'],
      { width: 128, height: 56, border: '#ffd23f' },
    );
    const doorTexture = canvasTexture(doorCanvas);
    const doorMaterial = new THREE.MeshBasicMaterial({ map: doorTexture });
    own.push(doorTexture, doorMaterial);
    ownPlane(2.6, 1.1, doorMaterial, toWorld(t, -1.02, THEATER_HALF_WIDTH - 1), 4.25, out, outside);

    // Seats, ten to a row, with armrests and cupholders.
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const p = seatPose(t, seat);
      addSeat(
        inside.opaque,
        (sx, sy, sz) => {
          const w = toWorld(t, p.u + sz, p.v + sx * t.across);
          return [w.x, p.y + sy, w.z];
        },
        p.col === 0,
      );
    }
    // The valance over the screen, and the EXIT sign over the door.
    tb(inside.opaque, 0.3, 0.9, SCREEN.top + 0.15, 8.4, -6.3, 6.3, 'velvet');
    tb(inside.opaque, 0.88, 0.95, SCREEN.top + 0.12, SCREEN.top + 0.22, -6.3, 6.3, 'gold');
    const exitTexture = signTexture(['EXIT'], {
      width: 48,
      height: 16,
      color: '#3dff6a',
      background: '#062a10',
    });
    const exitMaterial = new THREE.MeshBasicMaterial({ map: exitTexture });
    own.push(exitTexture, exitMaterial);
    ownPlane(0.9, 0.3, exitMaterial, toWorld(t, 0.03, 6.5), 3.45, inward, group);
    // A light in each aisle step.
    for (let r = 0; r < 6; r++) {
      for (const v of [-6.25, 6.25])
        tb(
          inside.glow,
          6 + r * 2 - 0.02,
          6 + r * 2,
          r * 0.5 + 0.05,
          r * 0.5 + 0.12,
          v - 0.5,
          v + 0.5,
          'neonYellow',
          true,
        );
    }
    for (const kind of ['opaque', 'glow', 'glass'] as const) {
      if (inside[kind].empty) continue;
      const mesh = meshOf(inside[kind], kind);
      own.push(mesh.geometry, { dispose: () => mesh.removeFromParent() });
      group.add(mesh);
    }

    // The screen, the projector's beam, and the curtains in front.
    const screenMaterial = new THREE.MeshBasicMaterial({ color: 0x55556a });
    own.push(screenMaterial);
    const screen = new THREE.Mesh(screenGeometry, screenMaterial);
    const sc = toWorld(t, SCREEN.u, 0);
    screen.position.set(sc.x, (SCREEN.bottom + SCREEN.top) / 2, sc.z);
    screen.rotation.y = inward;
    screen.scale.set(SCREEN.width, SCREEN.top - SCREEN.bottom, 1);
    group.add(screen);
    const pj = toWorld(t, THEATER_DEPTH - 0.05, 0);
    const from = new THREE.Vector3(pj.x, 7.25, pj.z);
    const to = new THREE.Vector3(sc.x, (SCREEN.bottom + SCREEN.top) / 2, sc.z);
    const beamGeometry = new THREE.ConeGeometry(3.6, from.distanceTo(to), 24, 1, true);
    const beamMaterial = new THREE.MeshBasicMaterial({
      color: 0xdfefff,
      transparent: true,
      opacity: 0.02,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    own.push(beamGeometry, beamMaterial);
    const beam = new THREE.Mesh(beamGeometry, beamMaterial);
    beam.position.copy(from).add(to).multiplyScalar(0.5);
    beam.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, -1, 0),
      to.clone().sub(from).normalize(),
    );
    beam.visible = false;
    group.add(beam);
    const curtain = (edgeV: number, dir: 1 | -1) => {
      // Built from its outer edge (along the screen wall), so it opens by shrinking toward that edge.
      const b = new BoxBuilder();
      const half = SCREEN.width / 2 + 0.25;
      b.box(-0.07, SCREEN.bottom - 0.15, 0, 0.07, SCREEN.top + 0.2, dir * half, 'velvet');
      const mesh = meshOf(b);
      own.push(mesh.geometry);
      const p = toWorld(t, SCREEN.u + 0.12, edgeV);
      mesh.position.set(p.x, 0, p.z);
      mesh.rotation.y = facing(t.perp);
      group.add(mesh);
      return mesh;
    };
    const left = curtain(-SCREEN.width / 2 - 0.25, 1);
    const right = curtain(SCREEN.width / 2 + 0.25, -1);
    own.push({
      dispose: () => {
        for (const m of [screen, beam, left, right]) m.removeFromParent();
      },
    });
    return {
      view: {
        plan: t,
        group,
        screen,
        beam,
        curtains: { left, right, open: 0, target: 0 },
        doorSign: { canvas: doorCanvas, texture: doorTexture },
      },
      own,
    };
  };
  const views = new Map<number, TheaterView>();
  const owned = new Map<number, { dispose(): void }[]>();

  // ---------------------------------------------------------------------------
  // The Collection: posters on every wall of the zig-zag, with a letter range at each turn.
  sorted.forEach((m, i) => {
    const s = posterSlot(gallery, i);
    posterQuads.push({
      movieId: m.id,
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.facing === 1 ? FACE.south : FACE.north,
      ...POSTER_SIZE,
    });
    const fz = s.facing === 1 ? s.z - 0.04 : s.z + 0.04;
    lobby.opaque.box(
      s.x - 0.56,
      s.y - 0.81,
      fz - 0.015,
      s.x + 0.56,
      s.y + 0.81,
      fz + 0.015,
      'gold',
      { fit: true },
    );
  });
  gallery.dividers.forEach((d, i) => {
    const per = postersPerDivider();
    const first = sorted[i * per];
    const last = sorted[Math.min(sorted.length, (i + 1) * per) - 1];
    if (!first || !last) return;
    const range = `${first.title.slice(0, 1).toUpperCase()}–${last.title.slice(0, 1).toUpperCase()}`;
    const endX = i % 2 === 0 ? d.x1 + 0.02 : d.x0 - 0.02;
    sign([range], 0.46, 1.1, endX, 2.6, d.z - VOXEL / 2, i % 2 === 0 ? FACE.east : FACE.west, {
      width: 24,
      height: 56,
      color: '#ffd23f',
    });
  });

  // Poster quads: one mesh for all of them.
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const placed: typeof posterQuads = [];
  const corner = new THREE.Vector3();
  for (const q of posterQuads) {
    const uv = atlas.uv(q.movieId);
    if (!uv) continue;
    const base = positions.length / 3;
    const rot = new THREE.Matrix4().makeRotationY(q.yaw);
    for (const [cx, cy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      corner.set((cx * q.w) / 2, (cy * q.h) / 2, 0).applyMatrix4(rot);
      positions.push(q.x + corner.x, q.y + corner.y, q.z + corner.z);
    }
    uvs.push(uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    placed.push(q);
  }
  const posterGeometry = new THREE.BufferGeometry();
  posterGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  posterGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  posterGeometry.setIndex(indices);
  posterGeometry.computeBoundingSphere();
  const posterMaterial = new THREE.MeshBasicMaterial({ map: atlas.texture });
  disposables.push(posterGeometry, posterMaterial);
  root.add(new THREE.Mesh(posterGeometry, posterMaterial));

  // Arcade screens: drawn each frame by the arcade (attract mode).
  const arcadeScreens = ARCADE_GAMES.map((_, i) => {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 80;
    const texture = canvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    disposables.push(texture, material);
    plane(0.84, 0.7, material, 13.98, 1.62, ARCADE_Z[i]!, FACE.west);
    return { canvas, texture };
  });

  flush(lobby, root);

  const hotspots: Hotspot[] = [
    { kind: 'boxoffice', x: -9.5, z: -5.1, radius: 3.4, label: 'Buy a ticket' },
    { kind: 'concessions', x: 9.5, z: -5.1, radius: 3.4, label: 'Buy snacks' },
    { kind: 'usher', x: USHER.x, z: USHER.z + 1.1, radius: 1.5, label: 'Talk to the usher' },
    ...ARCADE_GAMES.map((g, i) => ({
      kind: 'arcade' as const,
      x: 12.7,
      z: ARCADE_Z[i]!,
      radius: 1.3,
      label: `Play ${g.title}`,
      game: g.id,
    })),
    {
      kind: 'claw',
      x: 12.2,
      z: (CLAW.z0 + CLAW.z1) / 2,
      radius: 1.4,
      label: 'Try the claw machine',
    },
    ...RESTROOMS.map((z) => ({
      kind: 'restroom' as const,
      x: LOBBY.x0 + 1,
      z,
      radius: 1.2,
      label: 'Restroom',
    })),
    ...[...TRASH, ...layout.theaters.map(theaterTrash)].map((b) => ({
      kind: 'trash' as const,
      x: b.x,
      z: b.z,
      radius: 1.4,
      label: 'Throw away your trash',
    })),
  ];

  /** How far (x, z) is from a box, on the floor (0 inside it). */
  const away = (b: { x0: number; x1: number; z0: number; z1: number }, x: number, z: number) =>
    Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.z0 - z, 0, z - b.z1));
  let last = { x: Infinity, z: Infinity };

  const world: World = {
    root,
    building,
    layout,
    atlas,
    views,
    onView: null,
    onDrop: null,
    hotspots,
    arcadeScreens,
    update(x, z, all = false) {
      // Little changes from one step to the next: look again every couple of metres.
      if (!all && Math.hypot(x - last.x, z - last.z) < 2) return;
      last = { x, z };
      const near = (c: { x: number; z: number }) => Math.hypot(c.x - x, c.z - z);
      const wanted: Chunk[] = [];
      for (const c of chunks) {
        const d = near(c);
        if (c.meshes && d > CHUNKS_OUT) dropChunk(c);
        else if (!c.meshes && d < CHUNKS_IN) wanted.push(c);
      }
      wanted.sort((a, b) => near(a) - near(b));
      for (const c of all ? wanted : wanted.slice(0, BUDGET)) meshChunkAt(c);
      if (!all && wanted.length > BUDGET) last = { x: Infinity, z: Infinity };

      const rooms: TheaterPlan[] = [];
      for (const t of layout.theaters) {
        const d = away(t, x, z);
        if (views.has(t.number) && d > ROOMS_OUT) {
          for (const o of owned.get(t.number) ?? []) o.dispose();
          owned.delete(t.number);
          views.delete(t.number);
          world.onDrop?.(t.number);
        } else if (!views.has(t.number) && d < ROOMS_IN) rooms.push(t);
      }
      rooms.sort((a, b) => away(a, x, z) - away(b, x, z));
      for (const t of all ? rooms : rooms.slice(0, 1)) {
        const { view, own } = buildView(t);
        views.set(t.number, view);
        owned.set(t.number, own);
        world.onView?.(view);
      }
      if (!all && rooms.length > 1) last = { x: Infinity, z: Infinity };
      // Groups with nothing left in them go.
      for (const [n, g] of groups) {
        if (!g.children.length) {
          g.removeFromParent();
          groups.delete(n);
        }
      }
    },
    posterInView(x, z, yaw) {
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      let best: { id: string; score: number } | undefined;
      for (const q of placed) {
        const dx = q.x - x;
        const dz = q.z - z;
        const d = Math.hypot(dx, dz);
        // Close enough, on the side of the wall you're on, and roughly ahead.
        if (d > 3.2 || d < 0.05) continue;
        if (Math.sin(q.yaw) * -dx + Math.cos(q.yaw) * -dz <= 0) continue;
        const ahead = (dx * fx + dz * fz) / d;
        if (ahead < 0.75) continue;
        const score = (1 - ahead) * 4 + d * 0.1;
        if (!best || score < best.score) best = { id: q.movieId, score };
      }
      return best?.id;
    },
    showFrom(place, x, z) {
      // From a corridor only the nearest doorways show anything of the rooms behind them.
      // Inside a theater: it, and the one next door whose blocks include the wall between them.
      const room = place.kind === 'theater' ? layout.theaters[place.number - 1] : undefined;
      for (const [n, g] of groups) {
        const t = layout.theaters[n - 1]!;
        const door = toWorld(t, -0.5, THEATER_HALF_WIDTH - 1);
        g.visible =
          (room !== undefined && (room.number === n || room.inner === n)) ||
          (place.kind === 'hall' && Math.hypot(door.x - x, door.z - z) < 16);
      }
    },
    animate(time, dt) {
      const on = Math.floor(time * 3) % 2 === 0;
      bulbMeshA.visible = on;
      bulbMeshB.visible = !on;
      kernels.children.forEach((k) => {
        const p = (time * 0.9 + (k.userData.phase as number)) % 1;
        k.position.set(
          Math.sin(p * 40) * 0.5,
          0.1 + Math.sin(p * Math.PI) * 0.75,
          Math.cos(p * 23) * 0.25,
        );
      });
      for (const v of views.values()) {
        const c = v.curtains;
        c.open += (c.target - c.open) * Math.min(1, dt * 1.2);
        const s = 1 - c.open * 0.88;
        c.left.scale.z = s;
        c.right.scale.z = s;
      }
      for (const a of staff) a.update(0.016, 0);
      atlas.flush();
    },
    dispose() {
      for (const d of disposables) d.dispose();
      for (const own of owned.values()) for (const o of own) o.dispose();
      for (const c of chunks) dropChunk(c);
      for (const a of staff) a.dispose();
    },
  };
  return world;
}

export function paintDoorSign(view: TheaterView, lines: string[], busy: boolean) {
  drawSign(view.doorSign.canvas, lines, {
    width: 128,
    height: 56,
    border: busy ? '#ff3fa4' : '#ffd23f',
    color: busy ? '#ff3fa4' : '#ffd23f',
    glow: busy ? '#ff3fa4' : undefined,
  });
  view.doorSign.texture.needsUpdate = true;
}
