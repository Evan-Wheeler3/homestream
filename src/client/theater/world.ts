// Builds the cinema from the floor plan (layout.ts): voxel walls and carpets,
// the counters, eight auditoriums, and a gallery with a poster for every movie
// in the library, sized to fit however many there are.
import * as THREE from 'three';
import { ROWS, SEAT_COUNT, THEATER_COUNT } from '../../shared/theater';
import { Avatar } from './avatars';
import {
  ARCADE,
  BOX_OFFICE,
  CONCESSIONS,
  dividerHalfLength,
  GALLERY_X,
  galleryPlan,
  HALL,
  LOBBY,
  POSTER_SIZE,
  posterSlot,
  RESTROOMS,
  rowU,
  SCREEN,
  seatPose,
  SolidMap,
  stadiumHeight,
  THEATER_DEPTH,
  THEATER_HALF_WIDTH,
  THEATER_HEIGHT,
  THEATERS,
  TICKET_TAKER,
  toWorld,
  type GalleryPlan,
  type Place,
  type TheaterPlan,
} from './layout';
import { blockTexture, canvasTexture, drawSign, PosterAtlas, signTexture } from './textures';
import { VoxelBatch } from './voxels';

export interface GalleryMovie {
  id: string;
  title: string;
  year: number | null;
  poster: string | null;
}

const C = {
  carpetA: 0x4a1030,
  carpetB: 0x2e0c3c,
  carpetGold: 0xd9a441,
  hallCarpet: 0x15224e,
  hallStar: 0xe8c45a,
  wall: 0x2b1640,
  wallLow: 0x4a1f63,
  ceiling: 0x120a1c,
  red: 0xb3202c,
  gold: 0xe8b84a,
  pink: 0xff3fa4,
  teal: 0x2ee6d6,
  yellow: 0xffd23f,
  orange: 0xff8a3d,
  purple: 0x7b2cbf,
  warm: 0xffd9a0,
  seat: 0x9c1b2a,
  seatDark: 0x3a0d18,
  curtain: 0x8e1020,
  theaterWall: 0x1d1028,
  panel: 0x26143a,
  tread: 0x2a1235,
  black: 0x050308,
  sidewalk: 0x4a4a55,
  road: 0x1b1b24,
  glass: 0x9fd8ff,
  green: 0x2fbf4a,
  wood: 0x6b3b1f,
};

export interface TheaterView {
  plan: TheaterPlan;
  screen: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  beam: THREE.Mesh;
  doorSign: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture };
}

export interface Hotspot {
  kind: 'boxoffice' | 'concessions' | 'arcade' | 'restroom' | 'taker';
  x: number;
  z: number;
  radius: number;
  label: string;
}

export interface World {
  root: THREE.Group;
  solid: SolidMap;
  gallery: GalleryPlan;
  atlas: PosterAtlas;
  posters: THREE.Mesh;
  /** Which movie a poster triangle belongs to. */
  posterMovie(faceIndex: number): string | undefined;
  /** Draws only the parts of the building that can be seen from a place. */
  showFrom(place: Place): void;
  theaters: TheaterView[];
  hotspots: Hotspot[];
  /** Little animations: popping corn, blinking bulbs, arcade screens. */
  animate(time: number): void;
  dispose(): void;
}

/** A box in a theater's own coordinates (u from the screen wall, v across). */
function theaterBox(
  batch: VoxelBatch,
  t: TheaterPlan,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  v0: number,
  v1: number,
  color: number,
) {
  const a = toWorld(t, u0, v0);
  const b = toWorld(t, u1, v1);
  batch.box(a.x, y0, a.z, b.x, y1, b.z, color);
}

function plane(
  w: number,
  h: number,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  yaw: number,
) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  mesh.position.set(x, y, z);
  mesh.rotation.y = yaw;
  return mesh;
}

// Plane faces +z by default; these turn it to face along an axis.
const FACE = { south: 0, north: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 };

export function buildWorld(movies: GalleryMovie[]): World {
  const root = new THREE.Group();
  const block = blockTexture();
  const solidMaterial = new THREE.MeshLambertMaterial({ map: block });
  const glowMaterial = new THREE.MeshBasicMaterial();
  const solid = new VoxelBatch(solidMaterial);
  const glow = new VoxelBatch(glowMaterial, 0);
  const smooth = new VoxelBatch(new THREE.MeshLambertMaterial(), 0.04);
  const disposables: { dispose(): void }[] = [block, solidMaterial, glowMaterial];
  const inArea = (name: string) => {
    solid.area(name);
    glow.area(name);
    smooth.area(name);
  };
  const sorted = [...movies].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  );
  const gallery = galleryPlan(sorted.length);
  const atlas = new PosterAtlas(sorted);
  disposables.push(atlas.texture);
  const signMaterials: THREE.Material[] = [];
  const sign = (
    lines: string[],
    w: number,
    h: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    style: Parameters<typeof signTexture>[1] = {},
  ) => {
    const texture = signTexture(lines, style);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    signMaterials.push(material);
    disposables.push(texture);
    root.add(plane(w, h, material, x, y, z, yaw));
  };

  // ---------------------------------------------------------------------------
  // Outside: a night street seen through the front doors.
  inArea('lobby');
  solid.blocks(-22, -1, LOBBY.z1 + 1, 22, 0, 18, C.sidewalk);
  solid.box(-22, -1.05, 18, 22, -0.05, 28, C.road);
  for (let x = -20; x < 22; x += 4) glow.box(x, -0.04, 22.9, x + 2, -0.02, 23.1, C.yellow);
  const car = (x: number, z: number, color: number) => {
    solid.box(x, 0, z, x + 4, 0.9, z + 1.8, color);
    solid.box(x + 0.8, 0.9, z + 0.1, x + 3, 1.6, z + 1.7, color);
    glow.box(x + 0.9, 1, z + 0.08, x + 2.9, 1.5, z + 0.1, 0x3b5a8a);
    for (const wx of [x + 0.6, x + 2.8]) {
      solid.box(wx, 0, z - 0.05, wx + 0.7, 0.6, z + 0.15, C.black);
      solid.box(wx, 0, z + 1.65, wx + 0.7, 0.6, z + 1.85, C.black);
    }
  };
  car(-15, 19, 0x2ee6d6);
  car(8, 19.2, 0xff3fa4);
  for (const x of [-12, 12]) {
    solid.box(x - 0.1, 0, 16.5, x + 0.1, 5, 16.7, 0x333340);
    glow.box(x - 0.4, 5, 16.3, x + 0.4, 5.3, 16.9, C.warm);
  }

  // ---------------------------------------------------------------------------
  // The lobby
  const carpet = (x: number, _y: number, z: number) => {
    const d = (Math.abs(x) + Math.abs(z)) % 6;
    if (d === 0) return C.carpetGold;
    if ((x * 7 + z * 3) % 11 === 0) return C.teal;
    return (x + z) % 2 === 0 ? C.carpetA : C.carpetB;
  };
  solid.blocks(LOBBY.x0, -1, LOBBY.z0 - 1, LOBBY.x1, 0, LOBBY.z1 + 1, carpet);
  const wallColor = (_x: number, y: number) => (y < 1 ? C.wallLow : C.wall);
  const H = LOBBY.height;
  solid.blocks(LOBBY.x0 - 1, 0, LOBBY.z0 - 1, LOBBY.x0, H, LOBBY.z1 + 1, wallColor);
  solid.blocks(LOBBY.x1, 0, LOBBY.z0 - 1, LOBBY.x1 + 1, H, LOBBY.z1 + 1, wallColor);
  // Front wall, with glass doors in the middle.
  solid.blocks(LOBBY.x0, 0, LOBBY.z1, -3, H, LOBBY.z1 + 1, wallColor);
  solid.blocks(3, 0, LOBBY.z1, LOBBY.x1, H, LOBBY.z1 + 1, wallColor);
  solid.blocks(-3, 3, LOBBY.z1, 3, H, LOBBY.z1 + 1, wallColor);
  smooth.box(-3, 0, LOBBY.z1 + 0.4, -2.85, 3, LOBBY.z1 + 0.6, C.gold);
  smooth.box(2.85, 0, LOBBY.z1 + 0.4, 3, 3, LOBBY.z1 + 0.6, C.gold);
  smooth.box(-0.08, 0, LOBBY.z1 + 0.4, 0.08, 3, LOBBY.z1 + 0.6, C.gold);
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(6, 3, 0.1),
    new THREE.MeshLambertMaterial({ color: C.glass, transparent: true, opacity: 0.18 }),
  );
  glass.position.set(0, 1.5, LOBBY.z1 + 0.5);
  root.add(glass);
  disposables.push(glass.geometry, glass.material as THREE.Material);
  // Back wall, open to the hallway.
  solid.blocks(LOBBY.x0, 0, LOBBY.z0 - 1, HALL.x0, H, LOBBY.z0, wallColor);
  solid.blocks(HALL.x1, 0, LOBBY.z0 - 1, LOBBY.x1, H, LOBBY.z0, wallColor);
  solid.blocks(HALL.x0, 3.5, LOBBY.z0 - 1, HALL.x1, H, LOBBY.z0, wallColor);
  // Ceiling and its lights.
  solid.box(LOBBY.x0 - 1, H, LOBBY.z0 - 1, LOBBY.x1 + 1, H + 0.4, LOBBY.z1 + 1, C.ceiling);
  for (let x = LOBBY.x0 + 3; x < LOBBY.x1; x += 5) {
    for (let z = LOBBY.z0 + 3; z < LOBBY.z1; z += 5)
      glow.box(x, H - 0.05, z, x + 1.2, H, z + 1.2, C.warm);
  }
  // Neon stripes along the walls: pink low, teal high.
  for (const [y, color] of [
    [2.2, C.pink],
    [5.2, C.teal],
  ] as const) {
    glow.box(LOBBY.x0, y, LOBBY.z0, LOBBY.x0 + 0.04, y + 0.12, LOBBY.z1, color);
    glow.box(LOBBY.x1 - 0.04, y, LOBBY.z0, LOBBY.x1, y + 0.12, LOBBY.z1, color);
    glow.box(LOBBY.x0, y, LOBBY.z1 - 0.04, -3, y + 0.12, LOBBY.z1, color);
    glow.box(3, y, LOBBY.z1 - 0.04, LOBBY.x1, y + 0.12, LOBBY.z1, color);
  }

  // The marquee over the hallway, with chasing bulbs.
  sign(['WHEELHOUSE', 'CINEMAS'], 11, 2.4, 0, 5.3, LOBBY.z0 + 0.02, FACE.south, {
    width: 192,
    height: 42,
    color: '#ffd23f',
    glow: '#ff3fa4',
    background: '#1a0820',
    border: '#ff3fa4',
  });
  const bulbsA = new VoxelBatch(new THREE.MeshBasicMaterial(), 0);
  const bulbsB = new VoxelBatch(new THREE.MeshBasicMaterial(), 0);
  let n = 0;
  for (let x = -5.6; x <= 5.6; x += 0.4) {
    for (const y of [4, 6.6]) {
      (n++ % 2 ? bulbsA : bulbsB).box(
        x - 0.08,
        y - 0.08,
        LOBBY.z0 + 0.02,
        x + 0.08,
        y + 0.08,
        LOBBY.z0 + 0.12,
        C.yellow,
      );
    }
  }
  for (let y = 4.4; y <= 6.2; y += 0.4) {
    for (const x of [-5.6, 5.6]) {
      (n++ % 2 ? bulbsA : bulbsB).box(
        x - 0.08,
        y - 0.08,
        LOBBY.z0 + 0.02,
        x + 0.08,
        y + 0.08,
        LOBBY.z0 + 0.12,
        C.yellow,
      );
    }
  }
  const bulbMeshA = bulbsA.build()[0]!;
  const bulbMeshB = bulbsB.build()[0]!;
  root.add(bulbMeshA, bulbMeshB);

  // Box office: a red counter with gold trim, glass, and someone behind it.
  const counter = (cx: number) => {
    solid.box(cx - 3.5, 0, BOX_OFFICE.z - 2.3, cx + 3.5, 1.1, BOX_OFFICE.z - 1.3, C.red);
    smooth.box(cx - 3.55, 1.1, BOX_OFFICE.z - 1.7, cx + 3.55, 1.2, BOX_OFFICE.z - 1.25, C.gold);
    glow.box(cx - 3.5, 0.05, BOX_OFFICE.z - 1.32, cx + 3.5, 0.12, BOX_OFFICE.z - 1.28, C.pink);
  };
  counter(BOX_OFFICE.x);
  for (const gx of [-1.2, 1.2]) {
    const pane = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1.4, 0.05),
      new THREE.MeshLambertMaterial({ color: C.glass, transparent: true, opacity: 0.22 }),
    );
    pane.position.set(BOX_OFFICE.x + gx, 1.9, BOX_OFFICE.z - 1.5);
    root.add(pane);
    disposables.push(pane.geometry, pane.material as THREE.Material);
  }
  smooth.box(
    BOX_OFFICE.x - 0.3,
    1.2,
    BOX_OFFICE.z - 1.65,
    BOX_OFFICE.x + 0.3,
    1.45,
    BOX_OFFICE.z - 1.35,
    0x222233,
  );
  glow.box(
    BOX_OFFICE.x - 0.2,
    1.3,
    BOX_OFFICE.z - 1.34,
    BOX_OFFICE.x + 0.2,
    1.4,
    BOX_OFFICE.z - 1.33,
    C.teal,
  );
  sign(
    ['BOX OFFICE', 'TICKETS · ALL SHOWS'],
    6,
    1.5,
    BOX_OFFICE.x,
    4.1,
    LOBBY.z0 + 0.02,
    FACE.south,
    {
      color: '#2ee6d6',
      glow: '#2ee6d6',
      border: '#2ee6d6',
    },
  );

  // Concessions: popcorn machine, soda fountain and a candy case.
  counter(CONCESSIONS.x);
  const cz = CONCESSIONS.z - 1.5;
  const popcornGlass = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 1.3, 0.8),
    new THREE.MeshLambertMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.25 }),
  );
  popcornGlass.position.set(CONCESSIONS.x - 2.3, 1.85, cz);
  root.add(popcornGlass);
  disposables.push(popcornGlass.geometry, popcornGlass.material as THREE.Material);
  smooth.box(CONCESSIONS.x - 3, 2.5, cz - 0.45, CONCESSIONS.x - 1.6, 2.75, cz + 0.45, C.red);
  for (let i = 0; i < 26; i++) {
    const px = CONCESSIONS.x - 2.85 + ((i * 37) % 11) * 0.1;
    const pz = cz - 0.3 + ((i * 17) % 6) * 0.1;
    smooth.box(px, 1.2, pz, px + 0.12, 1.32 + ((i * 7) % 4) * 0.06, pz + 0.12, 0xfff1a8);
  }
  const kernels = new THREE.Group();
  const kernelMaterial = new THREE.MeshLambertMaterial({ color: 0xfff6c8 });
  const kernelGeometry = new THREE.BoxGeometry(0.08, 0.08, 0.08);
  disposables.push(kernelMaterial, kernelGeometry);
  for (let i = 0; i < 10; i++) {
    const k = new THREE.Mesh(kernelGeometry, kernelMaterial);
    k.userData.phase = i / 10;
    kernels.add(k);
  }
  kernels.position.set(CONCESSIONS.x - 2.3, 1.3, cz);
  root.add(kernels);
  solid.box(CONCESSIONS.x - 1.1, 1.2, cz - 0.4, CONCESSIONS.x + 0.6, 2.1, cz + 0.4, 0x9aa0ad);
  [C.red, C.orange, C.teal, C.purple].forEach((color, i) =>
    glow.box(
      CONCESSIONS.x - 0.95 + i * 0.4,
      1.6,
      cz + 0.4,
      CONCESSIONS.x - 0.75 + i * 0.4,
      1.9,
      cz + 0.42,
      color,
    ),
  );
  smooth.box(CONCESSIONS.x + 1, 1.2, cz - 0.4, CONCESSIONS.x + 3.4, 1.9, cz + 0.4, 0x2a1838);
  const candy = [C.pink, C.yellow, C.teal, C.orange, C.green, C.purple];
  for (let i = 0; i < 18; i++) {
    const x = CONCESSIONS.x + 1.15 + (i % 6) * 0.37;
    const y = 1.3 + Math.floor(i / 6) * 0.2;
    glow.box(x, y, cz + 0.2, x + 0.22, y + 0.14, cz + 0.38, candy[(i * 5) % candy.length]!);
  }
  sign(
    ['CONCESSIONS', 'POPCORN · SODA · CANDY'],
    6,
    1.5,
    CONCESSIONS.x,
    4.1,
    LOBBY.z0 + 0.02,
    FACE.south,
    {
      color: '#ff8a3d',
      glow: '#ff8a3d',
      border: '#ff8a3d',
    },
  );

  // The ticket taker's podium and velvet ropes into the hallway.
  smooth.box(
    TICKET_TAKER.x - 0.5,
    0,
    TICKET_TAKER.z - 0.5,
    TICKET_TAKER.x + 0.5,
    1.1,
    TICKET_TAKER.z + 0.5,
    C.gold,
  );
  for (const x of [HALL.x0 - 0.4, HALL.x1 + 0.4]) {
    smooth.box(x - 0.08, 0, LOBBY.z0 + 0.6, x + 0.08, 1, LOBBY.z0 + 0.76, C.gold);
  }
  sign(['NOW SHOWING', 'TICKETS PLEASE'], 3.6, 1, 0, 4.2, LOBBY.z0 - 2, FACE.south, {
    color: '#ff3fa4',
    glow: '#ff3fa4',
  });

  // Arcade machines along the right wall.
  const arcadeScreens: THREE.InstancedMesh[] = [];
  const cabinet = [C.purple, C.teal, C.pink];
  ARCADE.forEach((a, i) => {
    solid.box(a.x - 0.5, 0, a.z - 0.55, a.x + 0.6, 2.2, a.z + 0.55, cabinet[i]!);
    solid.box(a.x - 0.75, 0.9, a.z - 0.5, a.x - 0.5, 1.05, a.z + 0.5, C.black);
    smooth.box(a.x - 0.7, 1.05, a.z - 0.2, a.x - 0.6, 1.2, a.z - 0.1, C.red);
    const s = new VoxelBatch(new THREE.MeshBasicMaterial(), 0);
    for (let px = 0; px < 5; px++) {
      for (let py = 0; py < 4; py++) {
        s.box(
          a.x - 0.52,
          1.25 + py * 0.15,
          a.z - 0.4 + px * 0.16,
          a.x - 0.51,
          1.39 + py * 0.15,
          a.z - 0.25 + px * 0.16,
          0xffffff,
        );
      }
    }
    const screen = s.build()[0]!;
    arcadeScreens.push(screen);
    root.add(screen);
    glow.box(a.x - 0.52, 1.95, a.z - 0.5, a.x - 0.5, 2.15, a.z + 0.5, C.yellow);
  });
  sign(['ARCADE'], 3, 0.8, LOBBY.x1 - 0.02, 3.2, 2.5, FACE.west, {
    color: '#ffd23f',
    glow: '#ff3fa4',
  });

  // Restrooms on the left wall.
  for (const r of RESTROOMS) {
    solid.box(LOBBY.x0, 0, r.z - 0.65, LOBBY.x0 + 0.12, 2.4, r.z + 0.65, C.wood);
    smooth.box(LOBBY.x0 + 0.12, 1.1, r.z + 0.4, LOBBY.x0 + 0.2, 1.2, r.z + 0.5, C.gold);
    sign(['RESTROOM'], 1.6, 0.4, LOBBY.x0 + 0.03, 2.75, r.z, FACE.east, { color: '#2ee6d6' });
  }

  // Benches, plants and bins.
  for (const x0 of [-8, 5]) {
    solid.box(x0, 0.35, 2.5, x0 + 3, 0.55, 3.5, C.red);
    solid.box(x0 + 0.1, 0, 2.6, x0 + 0.3, 0.35, 3.4, C.black);
    solid.box(x0 + 2.7, 0, 2.6, x0 + 2.9, 0.35, 3.4, C.black);
  }
  for (const [x, z] of [
    [LOBBY.x0 + 1, LOBBY.z1 - 1.5],
    [LOBBY.x1 - 1.6, LOBBY.z1 - 1.5],
  ] as const) {
    solid.box(x, 0, z, x + 0.6, 0.6, z + 0.6, C.gold);
    solid.box(x - 0.2, 0.6, z - 0.2, x + 0.8, 1.6, z + 0.8, C.green);
    solid.box(x + 0.1, 1.6, z + 0.1, x + 0.5, 2.1, z + 0.5, 0x3fd85c);
  }

  // ---------------------------------------------------------------------------
  // The hallway
  inArea('hall');
  solid.blocks(HALL.x0, -1, HALL.z0, HALL.x1, 0, LOBBY.z0 - 1, (x, _y, z) =>
    (x * 5 + z * 3) % 7 === 0 ? C.hallStar : C.hallCarpet,
  );
  solid.box(HALL.x0 - 1, HALL.height, HALL.z0, HALL.x1 + 1, HALL.height + 0.4, LOBBY.z0, C.ceiling);
  for (let z = LOBBY.z0 - 3; z > HALL.z0; z -= 4)
    glow.box(-0.6, HALL.height - 0.05, z, 0.6, HALL.height, z + 1.2, C.warm);
  for (const side of [-1, 1] as const) {
    const x0 = side === -1 ? HALL.x0 - 1 : HALL.x1;
    const doors = THEATERS.filter((t) => t.side === side).map((t) => t.door);
    for (let z = HALL.z0; z < LOBBY.z0 - 1; z++) {
      for (let y = 0; y < HALL.height; y++) {
        const inDoor = doors.some((d) => z + 0.5 > d.z0 && z + 0.5 < d.z1 && y < 3);
        if (inDoor) continue;
        solid.box(x0, y, z, x0 + 1, y + 1, z + 1, y < 1 ? C.wallLow : C.wall);
      }
    }
    glow.box(
      side === -1 ? HALL.x0 : HALL.x1 - 0.04,
      5.2,
      HALL.z0,
      side === -1 ? HALL.x0 + 0.04 : HALL.x1,
      5.32,
      LOBBY.z0 - 1,
      side === -1 ? C.pink : C.teal,
    );
  }

  // ---------------------------------------------------------------------------
  // The auditoriums
  const theaters: TheaterView[] = [];
  const screenGeometry = new THREE.PlaneGeometry(1, 1);
  disposables.push(screenGeometry);
  for (const t of THEATERS) {
    inArea(`theater-${t.number}`);
    // The stepped floor.
    for (let u = 0; u < THEATER_DEPTH; u++) {
      for (let v = -THEATER_HALF_WIDTH; v < THEATER_HALF_WIDTH; v++) {
        const h = stadiumHeight(u + 0.5);
        const aisle = Math.abs(v + 0.5) > 5.2;
        theaterBox(solid, t, u, u + 1, -1, h, v, v + 1, aisle ? 0x3a1830 : C.tread);
      }
    }
    // Step lights on the aisle stairs.
    for (let r = 0; r < ROWS; r++) {
      const u = rowU(r) - 1;
      for (const [v0, v1] of [
        [-THEATER_HALF_WIDTH, -5.5],
        [5.5, THEATER_HALF_WIDTH],
      ] as const) {
        theaterBox(
          glow,
          t,
          u - 0.03,
          u,
          stadiumHeight(u - 0.5) + 0.02,
          stadiumHeight(u - 0.5) + 0.08,
          v0,
          v1,
          C.orange,
        );
      }
    }
    // Side and back walls, in acoustic panels.
    const wallBlock = (u: number, y: number) =>
      (Math.floor(u / 2) + Math.floor(y / 2)) % 2 ? C.panel : C.theaterWall;
    for (let u = 0; u < THEATER_DEPTH + 1; u++) {
      for (let y = 0; y < THEATER_HEIGHT; y++) {
        theaterBox(
          solid,
          t,
          u,
          u + 1,
          y,
          y + 1,
          -THEATER_HALF_WIDTH - 1,
          -THEATER_HALF_WIDTH,
          wallBlock(u, y),
        );
        theaterBox(
          solid,
          t,
          u,
          u + 1,
          y,
          y + 1,
          THEATER_HALF_WIDTH,
          THEATER_HALF_WIDTH + 1,
          wallBlock(u, y),
        );
      }
    }
    for (let v = -THEATER_HALF_WIDTH; v < THEATER_HALF_WIDTH; v++) {
      for (let y = 0; y < THEATER_HEIGHT; y++) {
        theaterBox(
          solid,
          t,
          THEATER_DEPTH,
          THEATER_DEPTH + 1,
          y,
          y + 1,
          v,
          v + 1,
          wallBlock(v + 8, y),
        );
      }
    }
    // The hall wall above the doorway rises to the auditorium's height.
    theaterBox(
      solid,
      t,
      -1,
      0,
      HALL.height,
      THEATER_HEIGHT,
      -THEATER_HALF_WIDTH - 1,
      THEATER_HALF_WIDTH + 1,
      C.theaterWall,
    );
    theaterBox(
      solid,
      t,
      -1,
      THEATER_DEPTH + 1,
      THEATER_HEIGHT,
      THEATER_HEIGHT + 0.4,
      -THEATER_HALF_WIDTH - 1,
      THEATER_HALF_WIDTH + 1,
      C.ceiling,
    );
    // A starry ceiling.
    for (let i = 0; i < 46; i++) {
      const u = 1 + ((i * 53) % 200) / 10;
      const v = -7 + ((i * 29) % 140) / 10;
      theaterBox(
        glow,
        t,
        u,
        u + 0.08,
        THEATER_HEIGHT - 0.04,
        THEATER_HEIGHT,
        v,
        v + 0.08,
        i % 5 ? 0xfff3d0 : C.teal,
      );
    }
    // Wall lights.
    for (let u = 4; u < THEATER_DEPTH; u += 4) {
      for (const v of [-THEATER_HALF_WIDTH, THEATER_HALF_WIDTH - 0.06]) {
        theaterBox(glow, t, u, u + 0.6, 5, 5.5, v, v + 0.06, C.warm);
      }
    }
    // Screen frame, curtains and valance.
    theaterBox(
      solid,
      t,
      0,
      0.3,
      1.2,
      7.3,
      -SCREEN.width / 2 - 0.3,
      SCREEN.width / 2 + 0.3,
      C.black,
    );
    theaterBox(solid, t, 0, 0.7, 0, 8.2, -THEATER_HALF_WIDTH, -SCREEN.width / 2 - 0.3, C.curtain);
    theaterBox(solid, t, 0, 0.7, 0, 8.2, SCREEN.width / 2 + 0.3, 5.5, C.curtain);
    theaterBox(solid, t, 0, 0.8, 7.4, 8.4, -THEATER_HALF_WIDTH, 5.5, C.curtain);
    theaterBox(smooth, t, 0.8, 0.85, 7.4, 7.5, -THEATER_HALF_WIDTH, 5.5, C.gold);
    // The stage in front of the screen.
    theaterBox(solid, t, 0, 1.4, 0, 0.5, -SCREEN.width / 2 - 0.3, SCREEN.width / 2 + 0.3, 0x3a1020);
    const screenMaterial = new THREE.MeshBasicMaterial({ color: 0x9a9aa8 });
    disposables.push(screenMaterial);
    const screen = new THREE.Mesh(screenGeometry, screenMaterial);
    const sc = toWorld(t, SCREEN.u, 0);
    screen.position.set(sc.x, (SCREEN.bottom + SCREEN.top) / 2, sc.z);
    // Facing the seats (away from the hall).
    screen.rotation.y = t.side === -1 ? FACE.west : FACE.east;
    screen.scale.set(SCREEN.width, SCREEN.top - SCREEN.bottom, 1);
    root.add(screen);
    // Projector window and its beam (shown while a movie plays).
    const pj = toWorld(t, THEATER_DEPTH - 0.02, 0);
    glow.box(pj.x - 0.3, 6.9, pj.z - 0.3, pj.x + 0.3, 7.5, pj.z + 0.3, 0xcfe8ff);
    const from = new THREE.Vector3(pj.x, 7.2, pj.z);
    const to = new THREE.Vector3(sc.x, 4.25, sc.z);
    const length = from.distanceTo(to);
    const beamGeometry = new THREE.ConeGeometry(3.4, length, 24, 1, true);
    const beamMaterial = new THREE.MeshBasicMaterial({
      color: 0xdfefff,
      transparent: true,
      opacity: 0.018,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    disposables.push(beamGeometry, beamMaterial);
    const beam = new THREE.Mesh(beamGeometry, beamMaterial);
    beam.position.copy(from).add(to).multiplyScalar(0.5);
    beam.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, -1, 0),
      to.clone().sub(from).normalize(),
    );
    beam.visible = false;
    root.add(beam);
    // Seats.
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const p = seatPose(t, seat);
      const u = rowU(p.row) + 0.15;
      const v = -4.5 + p.col;
      theaterBox(solid, t, u - 0.3, u + 0.3, p.y, p.y + 0.42, v - 0.38, v + 0.38, C.seat);
      theaterBox(solid, t, u + 0.25, u + 0.42, p.y + 0.2, p.y + 1.05, v - 0.38, v + 0.38, C.seat);
      theaterBox(
        solid,
        t,
        u - 0.25,
        u + 0.35,
        p.y + 0.42,
        p.y + 0.58,
        v + 0.38,
        v + 0.46,
        C.seatDark,
      );
      if (p.col === 0)
        theaterBox(
          solid,
          t,
          u - 0.25,
          u + 0.35,
          p.y + 0.42,
          p.y + 0.58,
          v - 0.46,
          v - 0.38,
          C.seatDark,
        );
    }
    // EXIT over the doorway, inside.
    const ex = toWorld(t, 0.02, 6.5);
    sign(['EXIT'], 0.9, 0.3, ex.x, 3.3, ex.z, t.side === -1 ? FACE.west : FACE.east, {
      width: 48,
      height: 16,
      color: '#3dff6a',
      background: '#062a10',
    });
    // The sign over the door in the hallway (updated as showings change).
    const doorCanvas = document.createElement('canvas');
    drawSign(doorCanvas, [`THEATER ${t.number}`, 'OPEN'], {
      width: 128,
      height: 56,
      border: '#ffd23f',
    });
    const doorTexture = canvasTexture(doorCanvas);
    const doorMaterial = new THREE.MeshBasicMaterial({ map: doorTexture });
    disposables.push(doorTexture, doorMaterial);
    const dz = (t.door.z0 + t.door.z1) / 2;
    root.add(
      plane(
        2.6,
        1.15,
        doorMaterial,
        t.side === -1 ? HALL.x0 + 0.02 : HALL.x1 - 0.02,
        3.9,
        dz,
        t.side === -1 ? FACE.east : FACE.west,
      ),
    );
    smooth.box(
      t.door.wallX0 - 0.02,
      3,
      t.door.z0 - 0.1,
      t.door.wallX1 + 0.02,
      3.12,
      t.door.z1 + 0.1,
      C.gold,
    );
    theaters.push({
      plan: t,
      screen,
      beam,
      doorSign: { canvas: doorCanvas, texture: doorTexture },
    });
  }

  // ---------------------------------------------------------------------------
  // The Collection: every movie's poster, A to Z.
  inArea('gallery');
  const GH = 6;
  solid.blocks(-GALLERY_X, -1, gallery.z1, GALLERY_X, 0, HALL.z0, (x, _y, z) =>
    (x + z) % 2 === 0 ? C.carpetB : 0x23103a,
  );
  solid.blocks(-GALLERY_X - 1, 0, gallery.z1 - 1, -GALLERY_X, GH, HALL.z0, C.wall);
  solid.blocks(GALLERY_X, 0, gallery.z1 - 1, GALLERY_X + 1, GH, HALL.z0, C.wall);
  solid.blocks(-GALLERY_X, 0, gallery.z1 - 1, GALLERY_X, GH, gallery.z1, C.wall);
  solid.box(-GALLERY_X - 1, GH, gallery.z1 - 1, GALLERY_X + 1, GH + 0.4, HALL.z0, C.ceiling);
  sign(
    ['THE COLLECTION', `${sorted.length} ${sorted.length === 1 ? 'MOVIE' : 'MOVIES'} · A TO Z`],
    5,
    1.2,
    0,
    5.6,
    HALL.z0 + 0.6,
    FACE.south,
    { color: '#ffd23f', glow: '#ffd23f', border: '#ffd23f' },
  );
  gallery.dividers.forEach((z, i) => {
    smooth.box(-dividerHalfLength, 0, z - 0.2, dividerHalfLength, 4.2, z + 0.2, 0x163a44);
    smooth.box(-dividerHalfLength, 4.2, z - 0.22, dividerHalfLength, 4.3, z + 0.22, C.gold);
    glow.box(
      -dividerHalfLength + 0.5,
      GH - 0.05,
      z - 0.3,
      dividerHalfLength - 0.5,
      GH,
      z + 0.3,
      C.warm,
    );
    const first = sorted[i * 56];
    const last = sorted[Math.min(sorted.length, (i + 1) * 56) - 1];
    if (!first || !last) return;
    const range = `${first.title.slice(0, 1).toUpperCase()}–${last.title.slice(0, 1).toUpperCase()}`;
    for (const side of [-1, 1]) {
      sign(
        [range],
        0.38,
        0.9,
        side * (dividerHalfLength + 0.01),
        2.2,
        z,
        side === 1 ? FACE.east : FACE.west,
        {
          width: 24,
          height: 56,
          color: '#ffd23f',
        },
      );
    }
  });

  // Poster quads: the gallery's, plus the newest arrivals in the lobby.
  const quads: {
    movieId: string;
    x: number;
    y: number;
    z: number;
    yaw: number;
    w: number;
    h: number;
  }[] = [];
  sorted.forEach((m, i) => {
    const s = posterSlot(gallery, i);
    quads.push({
      movieId: m.id,
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.facing === 1 ? FACE.south : FACE.north,
      ...POSTER_SIZE,
    });
  });
  const newest = movies.slice(0, 8);
  newest.forEach((m, i) => {
    const left = i < 4;
    const k = i % 4;
    const x = left ? -12.2 + k * 2.1 : 5.9 + k * 2.1;
    quads.push({ movieId: m.id, x, y: 3.4, z: LOBBY.z1 - 0.05, yaw: FACE.north, w: 1.5, h: 2.25 });
  });
  if (newest.length) {
    sign(['NEW ARRIVALS'], 3.4, 0.55, -9, 5, LOBBY.z1 - 0.06, FACE.north, {
      color: '#ff3fa4',
      glow: '#ff3fa4',
    });
    sign(['NEW ARRIVALS'], 3.4, 0.55, 9, 5, LOBBY.z1 - 0.06, FACE.north, {
      color: '#2ee6d6',
      glow: '#2ee6d6',
    });
  }
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const quadMovie: string[] = [];
  const corner = new THREE.Vector3();
  for (const q of quads) {
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
    quadMovie.push(q.movieId);
    inArea(q.z > HALL.z0 ? 'lobby' : 'gallery');
    // A gold frame behind it.
    const back = new THREE.Vector3(0, 0, -0.03).applyMatrix4(rot);
    const fw = (q.w + 0.12) / 2;
    const fh = (q.h + 0.12) / 2;
    const side = new THREE.Vector3(fw, 0, 0).applyMatrix4(rot);
    smooth.box(
      q.x + back.x - Math.abs(side.x) - 0.02,
      q.y - fh,
      q.z + back.z - Math.abs(side.z) - 0.02,
      q.x + back.x + Math.abs(side.x) + 0.02,
      q.y + fh,
      q.z + back.z + Math.abs(side.z) + 0.02,
      C.gold,
    );
  }
  const posterGeometry = new THREE.BufferGeometry();
  posterGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  posterGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  posterGeometry.setIndex(indices);
  posterGeometry.computeBoundingSphere();
  const posterMaterial = new THREE.MeshBasicMaterial({ map: atlas.texture });
  disposables.push(posterGeometry, posterMaterial);
  const posters = new THREE.Mesh(posterGeometry, posterMaterial);
  root.add(posters);

  const areaMeshes = new Map<string, THREE.Object3D[]>();
  for (const batch of [solid, glow, smooth]) {
    for (const mesh of batch.build()) {
      root.add(mesh);
      disposables.push(mesh.geometry);
      const area = mesh.userData.area as string;
      areaMeshes.set(area, [...(areaMeshes.get(area) ?? []), mesh]);
    }
  }
  disposables.push(...signMaterials);

  // Staff.
  const staff = [
    { x: BOX_OFFICE.x, z: LOBBY.z0 + 1.2, emoji: '🎟️', color: '#2ee6d6' },
    { x: CONCESSIONS.x, z: LOBBY.z0 + 1.2, emoji: '🍿', color: '#ff8a3d' },
    { x: TICKET_TAKER.x + 0.9, z: TICKET_TAKER.z - 0.5, emoji: '😀', color: '#ff3fa4' },
  ].map((s) => {
    const a = new Avatar({ name: '', color: s.color, emoji: s.emoji, staff: true });
    a.target.set(s.x, 0, s.z);
    a.targetYaw = Math.PI;
    a.update(0, 0);
    root.add(a.group);
    return a;
  });

  const hotspots: Hotspot[] = [
    { kind: 'boxoffice', ...BOX_OFFICE, radius: 3.2, label: 'Buy a ticket' },
    { kind: 'concessions', ...CONCESSIONS, radius: 3.2, label: 'Get snacks' },
    {
      kind: 'taker',
      x: TICKET_TAKER.x,
      z: TICKET_TAKER.z + 0.9,
      radius: 1.6,
      label: 'Talk to the usher',
    },
    ...ARCADE.map((a) => ({
      kind: 'arcade' as const,
      x: a.x - 1.2,
      z: a.z,
      radius: 1.2,
      label: 'Play the arcade',
    })),
    ...RESTROOMS.map((r) => ({
      kind: 'restroom' as const,
      x: LOBBY.x0 + 1,
      z: r.z,
      radius: 1.2,
      label: 'Restroom',
    })),
  ];

  const solidMap = new SolidMap(gallery);
  return {
    root,
    solid: solidMap,
    gallery,
    atlas,
    posters,
    posterMovie: (face) => quadMovie[Math.floor(face / 2)],
    showFrom(place) {
      // What can be seen from here (walls hide the rest).
      const visible = new Set<string>(
        place.kind === 'theater'
          ? [`theater-${place.number}`, 'hall']
          : place.kind === 'gallery'
            ? ['gallery', 'hall']
            : place.kind === 'hall'
              ? ['lobby', 'hall', 'gallery', ...THEATERS.map((t) => `theater-${t.number}`)]
              : ['lobby', 'hall'],
      );
      for (const [area, meshes] of areaMeshes) {
        for (const m of meshes) m.visible = visible.has(area);
      }
    },
    theaters,
    hotspots,
    animate(time) {
      const on = Math.floor(time * 3) % 2 === 0;
      bulbMeshA.visible = on;
      bulbMeshB.visible = !on;
      kernels.children.forEach((k) => {
        const p = (time * 0.9 + (k.userData.phase as number)) % 1;
        k.position.set(
          Math.sin(p * 40) * 0.4,
          0.1 + Math.sin(p * Math.PI) * 0.9,
          Math.cos(p * 23) * 0.25,
        );
      });
      arcadeScreens.forEach((s, i) => {
        const color = new THREE.Color();
        for (let j = 0; j < s.count; j++) {
          const h =
            (time * 0.15 + i * 0.3 + ((j * 7) % 20) / 40 + (Math.floor(time * 4 + j) % 3) * 0.05) %
            1;
          color.setHSL(h, 0.9, 0.55);
          s.setColorAt(j, color);
        }
        if (s.instanceColor) s.instanceColor.needsUpdate = true;
      });
      for (const a of staff) a.update(0.016, 0);
      atlas.flush();
    },
    dispose() {
      for (const d of disposables) d.dispose();
      for (const a of staff) a.dispose();
      root.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose();
      });
    },
  };
}

/** Repaints a theater's hallway sign. */
export function paintDoorSign(view: TheaterView, lines: string[], open: boolean) {
  drawSign(view.doorSign.canvas, lines, {
    width: 128,
    height: 56,
    border: open ? '#ffd23f' : '#ff3fa4',
    color: open ? '#ffd23f' : '#ff3fa4',
    glow: open ? undefined : '#ff3fa4',
  });
  view.doorSign.texture.needsUpdate = true;
}

export const theaterCount = THEATER_COUNT;
