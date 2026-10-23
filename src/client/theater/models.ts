// Small things made of boxes, textured from the same block atlas: seats with
// cupholders, the machines behind the counters, and every snack you can carry.
import * as THREE from 'three';
import type { SnackId } from '../../shared/theater';
import { atlasMaterial, blockTiles, tile, type TileName } from './blocks';
import { VOXEL, type MeshArrays } from './grid';

export type Faces = TileName | { top: TileName; side: TileName; bottom?: TileName };

interface BoxOptions {
  /** One whole tile per face (small things), instead of one tile per half metre. */
  fit?: boolean;
  tint?: [number, number, number];
}

/** Collects boxes into one piece of geometry for the atlas material. */
export class BoxBuilder {
  readonly a: MeshArrays = { positions: [], uvs: [], tiles: [], colors: [], indices: [] };

  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    faces: Faces,
    options: BoxOptions = {},
  ) {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    const [az, bz] = [Math.min(z0, z1), Math.max(z0, z1)];
    const f = typeof faces === 'string' ? { top: faces, side: faces, bottom: faces } : faces;
    const t = options.tint ?? [1, 1, 1];
    const quad = (
      corners: [number, number, number][],
      w: number,
      h: number,
      name: TileName,
      shade: number,
    ) => {
      const base = this.a.positions.length / 3;
      const uw = options.fit ? 1 : w / VOXEL;
      const uh = options.fit ? 1 : h / VOXEL;
      const uv = [
        [0, 0],
        [uw, 0],
        [uw, uh],
        [0, uh],
      ];
      corners.forEach((c, i) => {
        this.a.positions.push(...c);
        this.a.uvs.push(...(uv[i] as [number, number]));
        this.a.tiles.push(tile(name));
        this.a.colors.push(t[0] * shade, t[1] * shade, t[2] * shade);
      });
      this.a.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const W = bx - ax;
    const H = by - ay;
    const D = bz - az;
    // +x, -x, +z, -z, +y, -y (each wound to face outward)
    quad(
      [
        [bx, ay, bz],
        [bx, ay, az],
        [bx, by, az],
        [bx, by, bz],
      ],
      D,
      H,
      f.side,
      0.78,
    );
    quad(
      [
        [ax, ay, az],
        [ax, ay, bz],
        [ax, by, bz],
        [ax, by, az],
      ],
      D,
      H,
      f.side,
      0.78,
    );
    quad(
      [
        [ax, ay, bz],
        [bx, ay, bz],
        [bx, by, bz],
        [ax, by, bz],
      ],
      W,
      H,
      f.side,
      0.9,
    );
    quad(
      [
        [bx, ay, az],
        [ax, ay, az],
        [ax, by, az],
        [bx, by, az],
      ],
      W,
      H,
      f.side,
      0.9,
    );
    quad(
      [
        [ax, by, bz],
        [bx, by, bz],
        [bx, by, az],
        [ax, by, az],
      ],
      W,
      D,
      f.top,
      1,
    );
    quad(
      [
        [ax, ay, az],
        [bx, ay, az],
        [bx, ay, bz],
        [ax, ay, bz],
      ],
      W,
      D,
      f.bottom ?? f.side,
      0.55,
    );
  }

  get empty() {
    return this.a.indices.length === 0;
  }
}

export function geometryOf(a: MeshArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(a.positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(a.uvs, 2));
  g.setAttribute('tile', new THREE.Float32BufferAttribute(a.tiles, 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(a.colors, 3));
  g.setIndex(a.indices);
  g.computeBoundingSphere();
  return g;
}

/** The atlas and its three materials, made once per visit. */
let shared: {
  texture: THREE.DataArrayTexture;
  opaque: THREE.MeshBasicMaterial;
  glow: THREE.MeshBasicMaterial;
  glass: THREE.MeshBasicMaterial;
} | null = null;

export function materials() {
  if (!shared) {
    const texture = blockTiles();
    shared = {
      texture,
      opaque: atlasMaterial(texture, 'opaque'),
      glow: atlasMaterial(texture, 'glow'),
      glass: atlasMaterial(texture, 'glass'),
    };
  }
  return shared;
}

export function disposeMaterials() {
  if (!shared) return;
  shared.texture.dispose();
  for (const m of [shared.opaque, shared.glow, shared.glass]) m.map?.dispose();
  shared.opaque.dispose();
  shared.glow.dispose();
  shared.glass.dispose();
  shared = null;
}

export function meshOf(builder: BoxBuilder, kind: 'opaque' | 'glow' | 'glass' = 'opaque') {
  return new THREE.Mesh(geometryOf(builder.a), materials()[kind]);
}

// -----------------------------------------------------------------------------
// Snacks

/** A snack, about the size of the real thing, standing on y = 0. `level`: how much is left. */
export function snackModel(id: SnackId, level: number): THREE.Mesh {
  const b = new BoxBuilder();
  const fit = { fit: true };
  const l = Math.max(0, Math.min(1, level));
  switch (id) {
    case 'popcorn':
      b.box(-0.08, 0, -0.08, 0.08, 0.2, 0.08, { top: 'white', side: 'popcornBucket' }, fit);
      if (l > 0) b.box(-0.09, 0.2, -0.09, 0.09, 0.2 + 0.08 * l, 0.09, 'kernels', fit);
      break;
    case 'soda':
      b.box(-0.055, 0, -0.055, 0.055, 0.19, 0.055, { top: 'lid', side: 'cup' }, fit);
      b.box(-0.06, 0.19, -0.06, 0.06, 0.205, 0.06, 'lid', fit);
      b.box(0.012, 0.205, -0.008, 0.028, 0.3, 0.008, 'straw', fit);
      break;
    case 'water':
      b.box(-0.035, 0, -0.035, 0.035, 0.05 + 0.15 * Math.max(l, 0.15), 0.035, 'bottle', fit);
      b.box(-0.02, 0.2, -0.02, 0.02, 0.23, 0.02, 'lid', fit);
      break;
    case 'candy':
      b.box(-0.06, 0, -0.02, 0.06, 0.04 + 0.12 * Math.max(l, 0.1), 0.02, 'candy', fit);
      break;
    case 'nachos':
      b.box(-0.1, 0, -0.07, 0.1, 0.03, 0.07, 'white', fit);
      if (l > 0) b.box(-0.09, 0.03, -0.06, 0.03, 0.03 + 0.05 * l, 0.06, 'chips', fit);
      b.box(0.04, 0.03, -0.035, 0.09, 0.06, 0.035, 'cheese', fit);
      break;
    case 'hotdog': {
      const half = 0.03 + 0.07 * Math.max(l, 0.1);
      b.box(-half, 0, -0.03, half, 0.04, 0.03, 'bun', fit);
      b.box(-half - 0.01, 0.03, -0.015, half + 0.01, 0.06, 0.015, 'sausage', fit);
      break;
    }
    case 'pretzel': {
      const s = 0.4 + 0.6 * Math.max(l, 0.1);
      b.box(-0.07 * s, 0, -0.06 * s, 0.07 * s, 0.03, 0.06 * s, 'pretzel', fit);
      break;
    }
    case 'icecream':
      b.box(-0.03, 0, -0.03, 0.03, 0.11, 0.03, 'cone', fit);
      if (l > 0)
        b.box(
          -0.045 * l - 0.01,
          0.11,
          -0.045 * l - 0.01,
          0.045 * l + 0.01,
          0.11 + 0.08 * l + 0.01,
          0.045 * l + 0.01,
          'iceCream',
          fit,
        );
      break;
  }
  return meshOf(b);
}

// -----------------------------------------------------------------------------
// A movie theater seat, with armrests and cupholders. Built in the seat's own
// frame: x across (left to right as you sit), z backwards, y up, origin at the
// floor under the middle of the seat.

export function addSeat(
  b: BoxBuilder,
  place: (x: number, y: number, z: number) => [number, number, number],
  withLeftArm: boolean,
) {
  const box = (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    faces: Faces,
  ) => {
    const p = place(x0, y0, z0);
    const q = place(x1, y1, z1);
    b.box(p[0], p[1], p[2], q[0], q[1], q[2], faces);
  };
  box(-0.4, 0.38, -0.32, 0.4, 0.5, 0.18, { top: 'velvet', side: 'velvet' });
  box(-0.4, 0.5, 0.12, 0.4, 1.08, 0.24, 'velvet');
  box(-0.38, 0, -0.1, 0.38, 0.38, 0.12, 'darkMetal');
  const arm = (x: number) => {
    box(x - 0.06, 0, 0.05, x + 0.06, 0.62, 0.2, 'darkMetal');
    box(x - 0.06, 0.62, -0.3, x + 0.06, 0.7, 0.2, 'black');
    // The cupholder: a little ring at the front of the armrest.
    box(x - 0.07, 0.62, -0.42, x + 0.07, 0.7, -0.3, 'darkMetal');
  };
  arm(0.5);
  if (withLeftArm) arm(-0.5);
}

/** Where a seat's cupholders are, in the seat's frame (left, right). */
export const CUPHOLDERS: [number, number][] = [
  [-0.5, -0.36],
  [0.5, -0.36],
];
export const CUPHOLDER_HEIGHT = 0.63;
