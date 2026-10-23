// The cinema's building blocks: each a 16 × 16 pixel texture drawn here (no
// image files), packed into one atlas, and a material that tiles them one per
// block, Minecraft style.
import * as THREE from 'three';

const TILE = 16;
const COLS = 8;
const ROWS = 8;

type Painter = (px: (x: number, y: number, color: string) => void, rnd: () => number) => void;

/** A random number generator that's the same every time for the same tile. */
function seeded(seed: number) {
  let s = seed * 9301 + 49297;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function shadeHex(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * (1 + amount))));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `rgb(${r},${g},${b})`;
}

/** A base colour with a little noise in every pixel. */
const noisy =
  (base: string, amount = 0.12): Painter =>
  (px, rnd) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) px(x, y, shadeHex(base, (rnd() - 0.5) * amount * 2));
    }
  };

const then =
  (...painters: Painter[]): Painter =>
  (px, rnd) => {
    for (const p of painters) p(px, rnd);
  };

const planks =
  (base: string, vertical = false): Painter =>
  (px, rnd) => {
    noisy(base, 0.08)(px, rnd);
    for (let i = 0; i < TILE; i++) {
      for (const line of [3, 7, 11, 15]) {
        if (vertical) px(line, i, shadeHex(base, -0.35));
        else px(i, line, shadeHex(base, -0.35));
      }
    }
    for (let k = 0; k < 6; k++) {
      const a = Math.floor(rnd() * 16);
      const b = Math.floor(rnd() * 4) * 4 + 1;
      if (vertical) px(b, a, shadeHex(base, -0.18));
      else px(a, b, shadeHex(base, -0.18));
    }
  };

const brick =
  (base: string, mortar: string): Painter =>
  (px, rnd) => {
    noisy(base, 0.1)(px, rnd);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const row = Math.floor(y / 4);
        const offset = row % 2 ? 4 : 0;
        if (y % 4 === 3 || (x + offset) % 8 === 7) px(x, y, mortar);
      }
    }
  };

const frame =
  (color: string, width = 1): Painter =>
  (px) => {
    for (let i = 0; i < TILE; i++) {
      for (let w = 0; w < width; w++) {
        px(i, w, color);
        px(i, TILE - 1 - w, color);
        px(w, i, color);
        px(TILE - 1 - w, i, color);
      }
    }
  };

const dots =
  (color: string, count: number): Painter =>
  (px, rnd) => {
    for (let i = 0; i < count; i++) px(Math.floor(rnd() * 16), Math.floor(rnd() * 16), color);
  };

const stripes =
  (a: string, b: string, width = 2): Painter =>
  (px) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) px(x, y, Math.floor(x / width) % 2 ? a : b);
    }
  };

const diamond =
  (base: string, line: string, dot: string): Painter =>
  (px, rnd) => {
    noisy(base, 0.1)(px, rnd);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
        if (Math.abs(d - 7) < 0.6) px(x, y, line);
      }
    }
    for (const [x, y] of [
      [7, 7],
      [8, 7],
      [7, 8],
      [8, 8],
    ] as const)
      px(x, y, dot);
  };

const neon =
  (base: string, core: string): Painter =>
  (px) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = Math.abs(y - 7.5);
        px(x, y, d < 2 ? core : d < 5 ? base : shadeHex(base, -0.45));
      }
    }
  };

/** Every tile, in atlas order. */
const TILES = {
  plaster: then(noisy('#4b2a66', 0.08), dots('#5c3679', 10)),
  wainscot: planks('#4a2c1a', true),
  carpetDiamond: diamond('#7a1630', '#d9a441', '#2ee6d6'),
  carpetRed: then(noisy('#7a1630', 0.12), dots('#9b2442', 8)),
  carpetGold: noisy('#c9932f', 0.12),
  hallCarpet: (px, rnd) => {
    noisy('#18245a', 0.12)(px, rnd);
    for (const [x, y] of [
      [7, 5],
      [6, 7],
      [7, 7],
      [8, 7],
      [9, 7],
      [7, 8],
      [6, 10],
      [8, 10],
      [7, 9],
    ] as const)
      px(x, y, '#e8c45a');
  },
  runner: then(noisy('#8d1b2f', 0.1), dots('#b8323f', 12)),
  ceiling: then(noisy('#160c22', 0.15), dots('#24163a', 6)),
  starCeiling: then(noisy('#0b0614', 0.2), dots('#fff3d0', 3), dots('#2ee6d6', 1)),
  lightPanel: then(noisy('#ffe2b0', 0.05), frame('#c9a36b')),
  neonPink: neon('#ff3fa4', '#ffd0ea'),
  neonTeal: neon('#2ee6d6', '#d6fffb'),
  neonYellow: neon('#ffd23f', '#fff6d0'),
  counterRed: (px, rnd) => {
    noisy('#a81d2a', 0.08)(px, rnd);
    for (let y = 0; y < TILE; y++) {
      px(0, y, '#d9343f');
      px(15, y, '#6e1019');
    }
  },
  counterTop: then(noisy('#efe3c8', 0.06), dots('#d9c8a4', 10)),
  gold: then(noisy('#e2b23d', 0.1), frame('#fff0a8'), dots('#b8861f', 8)),
  acoustic: (px, rnd) => {
    noisy('#26143a', 0.1)(px, rnd);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) if ((x + y) % 4 === 0) px(x, y, '#311b4a');
    }
    frame('#1a0d29')(px, rnd);
  },
  acousticAlt: (px, rnd) => {
    noisy('#3a1838', 0.1)(px, rnd);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) if ((x - y + 16) % 4 === 0) px(x, y, '#4a2047');
    }
    frame('#240d23')(px, rnd);
  },
  tread: then(noisy('#3a1430', 0.1), dots('#4f1b40', 10)),
  riser: (px, rnd) => {
    noisy('#1d0a18', 0.1)(px, rnd);
    for (let x = 0; x < TILE; x++) {
      px(x, 1, '#ffb347');
      px(x, 2, '#ff8a3d');
    }
  },
  stage: planks('#3d2014'),
  black: noisy('#07050b', 0.3),
  glass: then(noisy('#bfe8ff', 0.05), (px) => {
    for (let i = 3; i < 9; i++) px(i, i + 2, '#ffffff');
    for (let i = 9; i < 13; i++) px(i, i - 4, '#ffffff');
  }),
  sidewalk: (px, rnd) => {
    noisy('#7d7d86', 0.1)(px, rnd);
    for (let i = 0; i < TILE; i++) {
      px(i, 15, '#5d5d66');
      px(15, i, '#5d5d66');
    }
  },
  asphalt: then(noisy('#25252c', 0.2), dots('#3a3a44', 12)),
  facade: brick('#8c3b2e', '#c8b8a6'),
  galleryWall: (px, rnd) => {
    noisy('#163a44', 0.08)(px, rnd);
    for (let y = 0; y < TILE; y++) px(0, y, '#1e4c58');
  },
  galleryFloor: planks('#8a5a2f'),
  oak: planks('#b07a43'),
  darkOak: planks('#4a2c1a'),
  leaves: then(noisy('#2f8f3a', 0.25), dots('#4fbf4f', 20), dots('#1f5f26', 14)),
  pot: brick('#b5562f', '#7a3a1f'),
  velvet: (px, rnd) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const fold = Math.sin((x / 16) * Math.PI * 4);
        px(x, y, shadeHex('#a3132a', fold * 0.25 + (rnd() - 0.5) * 0.08));
      }
    }
  },
  metal: then(noisy('#9aa0ad', 0.08), frame('#6c717c')),
  darkMetal: then(noisy('#2c3036', 0.12), frame('#1b1e22')),
  speaker: (px, rnd) => {
    noisy('#0d0d10', 0.1)(px, rnd);
    for (let y = 2; y < 14; y += 2) for (let x = 2; x < 14; x += 2) px(x, y, '#2a2a30');
  },
  cabinetPurple: then(noisy('#5b2c9a', 0.1), (px) => {
    for (let y = 0; y < TILE; y++) {
      px(2, y, '#ff3fa4');
      px(13, y, '#2ee6d6');
    }
  }),
  cabinetTeal: then(noisy('#127c78', 0.1), (px) => {
    for (let y = 0; y < TILE; y++) {
      px(2, y, '#ffd23f');
      px(13, y, '#ff3fa4');
    }
  }),
  cabinetPink: then(noisy('#b0246f', 0.1), (px) => {
    for (let y = 0; y < TILE; y++) {
      px(2, y, '#2ee6d6');
      px(13, y, '#ffd23f');
    }
  }),
  exit: then(noisy('#0e6b2a', 0.1), frame('#3dff6a')),
  projector: then(noisy('#cfe8ff', 0.05), frame('#8fb7e0')),
  white: noisy('#f2efe8', 0.05),
  popcornBucket: stripes('#d62a2a', '#f4f0e6', 4),
  kernels: (px, rnd) => {
    noisy('#fff1a8', 0.15)(px, rnd);
    dots('#f2c94c', 30)(px, rnd);
    dots('#ffffff', 18)(px, rnd);
  },
  cup: then(noisy('#2a6fdb', 0.08), (px) => {
    for (let x = 0; x < TILE; x++) px(x, 6 + Math.round(Math.sin(x / 2) * 1.5), '#ffffff');
  }),
  lid: noisy('#f5f5f5', 0.05),
  straw: stripes('#e8343f', '#ffffff', 2),
  candy: then(noisy('#7b2cbf', 0.08), frame('#ffd23f')),
  chips: then(noisy('#f2a93b', 0.15), dots('#c9771d', 20)),
  cheese: noisy('#ffcc33', 0.1),
  bun: noisy('#d9a066', 0.1),
  sausage: noisy('#a8432e', 0.1),
  pretzel: then(noisy('#8a4b1f', 0.1), dots('#ffffff', 12)),
  cone: (px, rnd) => {
    noisy('#d9a35a', 0.08)(px, rnd);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++)
        if ((x + y) % 5 === 0 || (x - y + 15) % 5 === 0) px(x, y, '#a8752f');
    }
  },
  iceCream: then(noisy('#ff9ec7', 0.1), dots('#ffffff', 8)),
  bottle: then(noisy('#9fd8ff', 0.08), (px) => {
    for (let x = 0; x < TILE; x++) px(x, 7, '#2a6fdb');
  }),
  trash: then(noisy('#2f5f3a', 0.1), (px) => {
    for (let y = 0; y < TILE; y++) {
      px(4, y, '#244a2d');
      px(11, y, '#244a2d');
    }
  }),
  rope: noisy('#9b1b30', 0.15),
  plushPink: noisy('#ff8fc4', 0.15),
  plushBlue: noisy('#6fb3ff', 0.15),
  plushYellow: noisy('#ffe066', 0.15),
} satisfies Record<string, Painter>;

export type TileName = keyof typeof TILES;
const TILE_INDEX = Object.fromEntries(Object.keys(TILES).map((k, i) => [k, i])) as Record<
  TileName,
  number
>;
export const tile = (name: TileName) => TILE_INDEX[name];
export const ATLAS = { cols: COLS, rows: ROWS };

/** How a block is drawn: unlit surfaces get a light level, glowing ones don't, glass is see-through. */
export type BlockKind = 'opaque' | 'glow' | 'glass' | 'invisible';

export interface BlockDef {
  top: TileName;
  side: TileName;
  bottom: TileName;
  kind: BlockKind;
  solid: boolean;
}

const b = (
  side: TileName,
  kind: BlockKind = 'opaque',
  top: TileName = side,
  bottom: TileName = side,
  solid = true,
): BlockDef => ({ top, side, bottom, kind, solid });

/** Block ids (0 is air). The order is fixed: the grid stores these numbers. */
export const BLOCKS = [
  null, // 0 air
  b('plaster'), // 1 rock: the default inside walls (never seen)
  b('plaster'),
  b('wainscot'),
  b('carpetDiamond'),
  b('carpetRed'),
  b('carpetGold'),
  b('hallCarpet'),
  b('runner'),
  b('ceiling'),
  b('starCeiling', 'glow'), // 10
  b('lightPanel', 'glow'),
  b('neonPink', 'glow'),
  b('neonTeal', 'glow'),
  b('neonYellow', 'glow'),
  b('counterRed', 'opaque', 'counterTop'),
  b('gold'),
  b('acoustic'),
  b('acousticAlt'),
  b('riser', 'opaque', 'tread'),
  b('stage'), // 20
  b('black'),
  b('glass', 'glass'),
  b('sidewalk'),
  b('asphalt'),
  b('facade'),
  b('galleryWall'),
  b('galleryFloor'),
  b('oak'),
  b('darkOak'),
  b('leaves'), // 30
  b('pot'),
  b('cabinetPurple', 'opaque', 'black'),
  b('cabinetTeal', 'opaque', 'black'),
  b('cabinetPink', 'opaque', 'black'),
  b('exit', 'glow'),
  b('projector', 'glow'),
  b('speaker'),
  b('trash'),
  b('metal'),
  b('black', 'invisible', 'black', 'black', true), // 40 barrier: solid, not drawn
  b('lightPanel', 'glow', 'lightPanel', 'lightPanel', true),
] as const;

export const BLOCK = {
  air: 0,
  rock: 1,
  plaster: 2,
  wainscot: 3,
  carpetDiamond: 4,
  carpetRed: 5,
  carpetGold: 6,
  hallCarpet: 7,
  runner: 8,
  ceiling: 9,
  starCeiling: 10,
  light: 11,
  neonPink: 12,
  neonTeal: 13,
  neonYellow: 14,
  counter: 15,
  gold: 16,
  acoustic: 17,
  acousticAlt: 18,
  tread: 19,
  stage: 20,
  black: 21,
  glass: 22,
  sidewalk: 23,
  asphalt: 24,
  facade: 25,
  galleryWall: 26,
  galleryFloor: 27,
  oak: 28,
  darkOak: 29,
  leaves: 30,
  pot: 31,
  cabinetPurple: 32,
  cabinetTeal: 33,
  cabinetPink: 34,
  exit: 35,
  projector: 36,
  speaker: 37,
  trash: 38,
  metal: 39,
  barrier: 40,
  lamp: 41,
} as const;

export const isSolidBlock = (id: number) => id !== 0 && Boolean(BLOCKS[id]?.solid);

/**
 * Every tile, one layer each of a texture array. Each layer gets its own smaller
 * copies (mipmaps), so distant walls don't shimmer and tiles never bleed into
 * their neighbours.
 */
export function blockTiles(): THREE.DataArrayTexture {
  const names = Object.values(TILES);
  const data = new Uint8Array(TILE * TILE * 4 * names.length);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  names.forEach((paint, i) => {
    g.clearRect(0, 0, TILE, TILE);
    const px = (x: number, y: number, color: string) => {
      g.fillStyle = color;
      g.fillRect(x, y, 1, 1);
    };
    (paint as Painter)(px, seeded(i + 1));
    const pixels = g.getImageData(0, 0, TILE, TILE).data;
    // Bottom row first (texture rows count up from the bottom).
    for (let row = 0; row < TILE; row++) {
      const from = (TILE - 1 - row) * TILE * 4;
      data.set(pixels.subarray(from, from + TILE * 4), (i * TILE + row) * TILE * 4);
    }
  });
  const texture = new THREE.DataArrayTexture(data, TILE, TILE, names.length);
  texture.format = THREE.RGBAFormat;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** A stand-in map, so the material keeps its texture coordinates (the tiles come from the array). */
function whiteMap() {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

/**
 * A material that draws geometry whose `uv` counts blocks (1 = one tile) and
 * whose `tile` attribute says which tile: each block face repeats its tile.
 * Vertex colours carry the face shading (tops bright, sides darker).
 */
export function atlasMaterial(tiles: THREE.DataArrayTexture, kind: 'opaque' | 'glow' | 'glass') {
  const material = new THREE.MeshBasicMaterial({
    map: whiteMap(),
    vertexColors: true,
    transparent: kind === 'glass',
    opacity: kind === 'glass' ? 0.28 : 1,
    depthWrite: kind !== 'glass',
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.blockTiles = { value: tiles };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float tile;\nvarying float vTile;',
      )
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTile = tile;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform highp sampler2DArray blockTiles;\nvarying float vTile;',
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          // The slope of the unwrapped coordinates picks the mip level, so there are no seams.
          diffuseColor *= textureGrad(blockTiles, vec3(fract(vMapUv), floor(vTile + 0.5)), dFdx(vMapUv), dFdy(vMapUv));
        #endif`,
      );
  };
  material.customProgramCacheKey = () => `blocks-${kind}`;
  material.userData.shared = true;
  return material;
}
