// Chunky blocks, many at a time: every box of one kind is a single instanced
// mesh (one draw call), so a whole cinema of them stays fast on a phone.
import * as THREE from 'three';

/** A small hash, so the same block always gets the same slight shade. */
function shade(x: number, y: number, z: number): number {
  const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return h - Math.floor(h);
}

export class VoxelBatch {
  private readonly areas = new Map<string, number[]>();
  private boxes: number[] = [];

  constructor(
    private readonly material: THREE.Material,
    /** How much each block's shade varies (0 = flat colour). */
    private readonly jitter = 0.07,
  ) {}

  /**
   * Which part of the building the next boxes belong to. Each part becomes its
   * own mesh, so the parts you can't see from where you are aren't drawn.
   */
  area(name: string) {
    let list = this.areas.get(name);
    if (!list) {
      list = [];
      this.areas.set(name, list);
    }
    this.boxes = list;
  }

  /** A box from one corner to the other, in one colour. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number) {
    this.boxes.push(
      Math.min(x0, x1),
      Math.min(y0, y1),
      Math.min(z0, z1),
      Math.abs(x1 - x0),
      Math.abs(y1 - y0),
      Math.abs(z1 - z0),
      color,
    );
  }

  /** Fills a region with 1 m blocks, so walls and floors look built from voxels. */
  blocks(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    color: number | ((x: number, y: number, z: number) => number),
  ) {
    for (let x = Math.min(x0, x1); x < Math.max(x0, x1) - 1e-6; x++) {
      for (let y = Math.min(y0, y1); y < Math.max(y0, y1) - 1e-6; y++) {
        for (let z = Math.min(z0, z1); z < Math.max(z0, z1) - 1e-6; z++) {
          const c = typeof color === 'function' ? color(x, y, z) : color;
          const w = Math.min(1, Math.max(x0, x1) - x);
          const h = Math.min(1, Math.max(y0, y1) - y);
          const d = Math.min(1, Math.max(z0, z1) - z);
          this.boxes.push(x, y, z, w, h, d, c);
        }
      }
    }
  }

  /** One mesh per area (tagged with userData.area). */
  build(): THREE.InstancedMesh[] {
    if (!this.areas.size) this.areas.set('all', this.boxes);
    return [...this.areas]
      .filter(([, boxes]) => boxes.length)
      .map(([name, boxes]) => {
        const mesh = this.buildOne(boxes);
        mesh.userData.area = name;
        return mesh;
      });
  }

  private buildOne(boxes: number[]): THREE.InstancedMesh {
    const count = boxes.length / 7;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.material, count);
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const [x, y, z, w, h, d, c] = boxes.slice(i * 7, i * 7 + 7) as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      m.makeScale(w, h, d).setPosition(x + w / 2, y + h / 2, z + d / 2);
      mesh.setMatrixAt(i, m);
      color.setHex(c);
      if (this.jitter) color.multiplyScalar(1 - this.jitter + shade(x, y, z) * this.jitter * 2);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.matrixAutoUpdate = false;
    mesh.computeBoundingSphere();
    return mesh;
  }
}
