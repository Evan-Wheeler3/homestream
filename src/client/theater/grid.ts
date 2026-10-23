// The building as a grid of half-metre blocks. The same grid is drawn (only the
// faces that border open space, merged into big rectangles) and walked through
// (it's what you bump into), so the two can never disagree.
import { BLOCKS, isSolidBlock } from './blocks';

export const VOXEL = 0.5;

export interface Bounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

export class VoxelGrid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly cells: Uint8Array;

  constructor(readonly bounds: Bounds) {
    this.nx = Math.round((bounds.x1 - bounds.x0) / VOXEL);
    this.ny = Math.round((bounds.y1 - bounds.y0) / VOXEL);
    this.nz = Math.round((bounds.z1 - bounds.z0) / VOXEL);
    this.cells = new Uint8Array(this.nx * this.ny * this.nz);
  }

  ix(x: number) {
    return Math.floor((x - this.bounds.x0) / VOXEL + 1e-9);
  }
  iy(y: number) {
    return Math.floor((y - this.bounds.y0) / VOXEL + 1e-9);
  }
  iz(z: number) {
    return Math.floor((z - this.bounds.z0) / VOXEL + 1e-9);
  }

  /** Outside the grid counts as solid wall. */
  get(ix: number, iy: number, iz: number): number {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.nx || iy >= this.ny || iz >= this.nz) return 1;
    return this.cells[(iz * this.ny + iy) * this.nx + ix]!;
  }

  set(ix: number, iy: number, iz: number, id: number) {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.nx || iy >= this.ny || iz >= this.nz) return;
    this.cells[(iz * this.ny + iy) * this.nx + ix] = id;
  }

  at(x: number, y: number, z: number) {
    return this.get(this.ix(x), this.iy(y), this.iz(z));
  }

  solidAt(ix: number, iy: number, iz: number) {
    return isSolidBlock(this.get(ix, iy, iz));
  }

  /**
   * Fills the box [x0, x1) × [y0, y1) × [z0, z1) (metres, any corner order) with
   * a block, or with whatever `id` returns for each cell.
   */
  fill(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    id: number | ((ix: number, iy: number, iz: number) => number | null),
  ) {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    const [az, bz] = [Math.min(z0, z1), Math.max(z0, z1)];
    for (let iz = this.iz(az); iz < Math.ceil((bz - this.bounds.z0) / VOXEL - 1e-9); iz++) {
      for (let iy = this.iy(ay); iy < Math.ceil((by - this.bounds.y0) / VOXEL - 1e-9); iy++) {
        for (let ix = this.ix(ax); ix < Math.ceil((bx - this.bounds.x0) / VOXEL - 1e-9); ix++) {
          const v = typeof id === 'function' ? id(ix, iy, iz) : id;
          if (v !== null) this.set(ix, iy, iz, v);
        }
      }
    }
  }

  /** The middle of a cell, in metres. */
  cx(ix: number) {
    return this.bounds.x0 + (ix + 0.5) * VOXEL;
  }
  cy(iy: number) {
    return this.bounds.y0 + (iy + 0.5) * VOXEL;
  }
  cz(iz: number) {
    return this.bounds.z0 + (iz + 0.5) * VOXEL;
  }
}

// -----------------------------------------------------------------------------
// Turning the grid into geometry

export interface MeshArrays {
  positions: number[];
  uvs: number[];
  tiles: number[];
  colors: number[];
  indices: number[];
}

const emptyArrays = (): MeshArrays => ({
  positions: [],
  uvs: [],
  tiles: [],
  colors: [],
  indices: [],
});

/** Face brightness, Minecraft style: tops brightest, undersides darkest. */
const SHADE = { x: 0.78, y: [0.55, 1] as const, z: 0.9 };

/** Can you see a face of `a` that touches `b`? */
function faceVisible(a: number, b: number) {
  if (a === 0) return false;
  const da = BLOCKS[a]!;
  if (da.kind === 'invisible') return false;
  if (b === 0) return true;
  const db = BLOCKS[b]!;
  if (db.kind === 'invisible') return true;
  if (db.kind === 'glass') return da.kind !== 'glass' || a !== b;
  return false;
}

/**
 * The visible faces of the blocks in columns [ix0, ix1) × [iz0, iz1), merged
 * into rectangles. `tileFor(id, face)` picks the tile; `brightness` dims a
 * whole chunk (the auditoriums are darker than the lobby).
 */
export function meshChunk(
  grid: VoxelGrid,
  ix0: number,
  ix1: number,
  iz0: number,
  iz1: number,
  tileFor: (id: number, face: 'top' | 'side' | 'bottom') => number,
  brightness = 1,
): Record<'opaque' | 'glow' | 'glass', MeshArrays> {
  const out = { opaque: emptyArrays(), glow: emptyArrays(), glass: emptyArrays() };
  const lo = [ix0, 0, iz0];
  const hi = [ix1, grid.ny, iz1];
  const V = VOXEL;
  const { x0, y0, z0 } = grid.bounds;
  const origin = [x0, y0, z0];
  const getAt = (p: number[]) => grid.get(p[0]!, p[1]!, p[2]!);

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const du = hi[u]! - lo[u]!;
    const dv = hi[v]! - lo[v]!;
    const mask = new Int32Array(du * dv);
    for (const s of [1, -1] as const) {
      for (let k = lo[d]!; k < hi[d]!; k++) {
        // Which faces on this slice are visible (block id), facing s.
        let any = false;
        const p = [0, 0, 0];
        const q = [0, 0, 0];
        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du; i++) {
            p[d] = k;
            p[u] = lo[u]! + i;
            p[v] = lo[v]! + j;
            q[d] = k + s;
            q[u] = p[u]!;
            q[v] = p[v]!;
            const a = getAt(p);
            const visible = faceVisible(a, getAt(q));
            mask[j * du + i] = visible ? a : 0;
            if (visible) any = true;
          }
        }
        if (!any) continue;
        // Greedy merge into rectangles of the same block.
        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du;) {
            const id = mask[j * du + i]!;
            if (!id) {
              i++;
              continue;
            }
            let w = 1;
            while (i + w < du && mask[j * du + i + w] === id) w++;
            let h = 1;
            grow: while (j + h < dv) {
              for (let t = 0; t < w; t++) if (mask[(j + h) * du + i + t] !== id) break grow;
              h++;
            }
            for (let jj = 0; jj < h; jj++)
              for (let ii = 0; ii < w; ii++) mask[(j + jj) * du + i + ii] = 0;

            const def = BLOCKS[id]!;
            const face = d === 1 ? (s > 0 ? 'top' : 'bottom') : 'side';
            const target =
              out[def.kind === 'glow' ? 'glow' : def.kind === 'glass' ? 'glass' : 'opaque'];
            const shade =
              (d === 0 ? SHADE.x : d === 2 ? SHADE.z : SHADE.y[s > 0 ? 1 : 0]) *
              (def.kind === 'glow' ? 1 : brightness);
            const plane = k + (s > 0 ? 1 : 0);
            const corners = [
              [i, j],
              [i + w, j],
              [i + w, j + h],
              [i, j + h],
            ];
            const base = target.positions.length / 3;
            for (const [cu, cv] of corners) {
              const c = [0, 0, 0];
              c[d] = plane;
              c[u] = lo[u]! + cu!;
              c[v] = lo[v]! + cv!;
              const wx = origin[0]! + c[0]! * V;
              const wy = origin[1]! + c[1]! * V;
              const wz = origin[2]! + c[2]! * V;
              target.positions.push(wx, wy, wz);
              // One tile per block, lined up with the world (and upright on walls).
              if (d === 1) target.uvs.push(wx / V, wz / V);
              else if (d === 0) target.uvs.push(wz / V, wy / V);
              else target.uvs.push(wx / V, wy / V);
              target.tiles.push(tileFor(id, face));
              target.colors.push(shade, shade, shade);
            }
            if (s > 0) target.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            else target.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
            i += w;
          }
        }
      }
    }
  }
  return out;
}
