// A statue beside each theater's door, on a marble pedestal, picked from the
// movie's genres: a rocket for science fiction, a jack-o'-lantern for horror,
// a cactus in a cowboy hat for westerns... Built from boxes like everything else.
import { STATUE_GRID, type StatueSpec } from '../../shared/theater';
import type { BoxBuilder, Faces } from './models';

export type StatueTheme =
  | 'rocket'
  | 'pumpkin'
  | 'castle'
  | 'teddy'
  | 'heart'
  | 'cactus'
  | 'bomb'
  | 'magnifier'
  | 'helmet'
  | 'column'
  | 'duck'
  | 'guitar'
  | 'globe'
  | 'hourglass'
  | 'chest'
  | 'award';

/** The first genre on this list that a movie has decides its statue. */
const BY_GENRE: [string, StatueTheme][] = [
  ['horror', 'pumpkin'],
  ['science fiction', 'rocket'],
  ['sci-fi', 'rocket'],
  ['western', 'cactus'],
  ['animation', 'teddy'],
  ['fantasy', 'castle'],
  ['war', 'helmet'],
  ['music', 'guitar'],
  ['musical', 'guitar'],
  ['documentary', 'globe'],
  ['romance', 'heart'],
  ['crime', 'magnifier'],
  ['mystery', 'magnifier'],
  ['comedy', 'duck'],
  ['thriller', 'hourglass'],
  ['adventure', 'chest'],
  ['action', 'bomb'],
  ['family', 'teddy'],
  ['history', 'column'],
];

export function statueFor(genres: readonly string[] | undefined): StatueTheme {
  const have = new Set((genres ?? []).map((g) => g.toLowerCase()));
  return BY_GENRE.find(([g]) => have.has(g))?.[1] ?? 'award';
}

type RGB = [number, number, number];

/** The glow on each pedestal's plaque. */
const ACCENT: Record<StatueTheme, RGB> = {
  rocket: [0.18, 0.9, 0.84],
  pumpkin: [1, 0.55, 0.1],
  castle: [0.62, 0.35, 1],
  teddy: [1, 0.6, 0.8],
  heart: [1, 0.25, 0.55],
  cactus: [1, 0.75, 0.3],
  bomb: [1, 0.35, 0.15],
  magnifier: [0.95, 0.85, 0.4],
  helmet: [0.55, 0.8, 0.35],
  column: [0.9, 0.9, 1],
  duck: [1, 0.9, 0.2],
  guitar: [1, 0.3, 0.7],
  globe: [0.3, 0.7, 1],
  hourglass: [0.95, 0.8, 0.45],
  chest: [1, 0.82, 0.25],
  award: [1, 0.82, 0.25],
};

export interface StatueParts {
  opaque: BoxBuilder;
  glow: BoxBuilder;
  glass: BoxBuilder;
}

/** The pedestal's footprint (metres either side of the middle) and the height statues start at. */
export const PEDESTAL = { half: 0.5, top: 0.85 };

/**
 * Builds a statue and its pedestal. `at(x, y, z)` places a point given in the
 * statue's own space: x across (to your right as you face it), y up from the
 * floor, z toward you; the pedestal fills x and z from -0.5 to 0.5.
 */
export function buildStatue(
  theme: StatueTheme,
  parts: StatueParts,
  at: (x: number, y: number, z: number) => [number, number, number],
) {
  const put = (
    b: BoxBuilder,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    faces: Faces,
    tint?: RGB,
  ) => {
    const a = at(x0, y0, z0);
    const c = at(x1, y1, z1);
    b.box(a[0], a[1], a[2], c[0], c[1], c[2], faces, { fit: true, tint });
  };
  const o = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: RGB) =>
    put(parts.opaque, x0, y0, z0, x1, y1, z1, 'white', c);
  const solid = (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    faces: Faces,
  ) => put(parts.opaque, x0, y0, z0, x1, y1, z1, faces);
  const glow = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: RGB) =>
    put(parts.glow, x0, y0, z0, x1, y1, z1, 'white', c);
  const glass = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
    put(parts.glass, x0, y0, z0, x1, y1, z1, 'glass');

  // The pedestal: a dark plinth, marble, a gold top, and a glowing plaque.
  const marble: RGB = [0.86, 0.84, 0.8];
  solid(-0.5, 0, -0.5, 0.5, 0.15, 0.5, 'darkMetal');
  o(-0.42, 0.15, -0.42, 0.42, 0.75, 0.42, marble);
  solid(-0.48, 0.75, -0.48, 0.48, PEDESTAL.top, 0.48, 'gold');
  glow(-0.28, 0.38, 0.42, 0.28, 0.52, 0.44, ACCENT[theme]);

  const T = PEDESTAL.top;
  const black: RGB = [0.08, 0.08, 0.1];
  switch (theme) {
    case 'rocket': {
      const red: RGB = [0.9, 0.15, 0.2];
      o(-0.15, T + 0.1, -0.15, 0.15, T + 1.1, 0.15, [0.93, 0.93, 0.96]);
      o(-0.16, T + 0.75, -0.16, 0.16, T + 0.85, 0.16, red);
      o(-0.11, T + 1.1, -0.11, 0.11, T + 1.25, 0.11, red);
      o(-0.06, T + 1.25, -0.06, 0.06, T + 1.38, 0.06, red);
      glow(-0.07, T + 0.5, 0.15, 0.07, T + 0.64, 0.16, [0.3, 0.95, 1]);
      for (const s of [-1, 1]) {
        o(s * 0.15, T, -0.03, s * 0.32, T + 0.4, 0.03, red);
        o(-0.03, T, s * 0.15, 0.03, T + 0.4, s * 0.32, red);
      }
      glow(-0.09, T, -0.09, 0.09, T + 0.1, 0.09, [1, 0.55, 0.1]);
      break;
    }
    case 'pumpkin': {
      const stone: RGB = [0.55, 0.55, 0.6];
      o(-0.3, T, -0.42, 0.3, T + 0.9, -0.27, stone);
      o(-0.22, T + 0.9, -0.42, 0.22, T + 1.0, -0.27, stone);
      o(-0.05, T + 0.45, -0.27, 0.05, T + 0.75, -0.26, [0.35, 0.35, 0.4]);
      o(-0.15, T + 0.55, -0.27, 0.15, T + 0.63, -0.26, [0.35, 0.35, 0.4]);
      const orange: RGB = [1, 0.5, 0.08];
      o(-0.32, T + 0.05, -0.2, 0.32, T + 0.45, 0.32, orange);
      o(-0.26, T, -0.15, 0.26, T + 0.5, 0.27, orange);
      o(-0.04, T + 0.5, 0.0, 0.04, T + 0.62, 0.08, [0.25, 0.55, 0.2]);
      const lit: RGB = [1, 0.85, 0.2];
      glow(-0.17, T + 0.27, 0.32, -0.07, T + 0.36, 0.33, lit);
      glow(0.07, T + 0.27, 0.32, 0.17, T + 0.36, 0.33, lit);
      glow(-0.16, T + 0.1, 0.32, 0.16, T + 0.17, 0.33, lit);
      break;
    }
    case 'castle': {
      const stone: RGB = [0.62, 0.62, 0.68];
      o(-0.3, T, -0.3, 0.3, T + 1.2, 0.3, stone);
      for (const x of [-0.3, 0.15]) {
        for (const z of [-0.3, 0.15]) o(x, T + 1.2, z, x + 0.15, T + 1.35, z + 0.15, stone);
      }
      solid(-0.02, T + 1.2, -0.02, 0.02, T + 1.75, 0.02, 'metal');
      o(0.02, T + 1.52, -0.01, 0.3, T + 1.7, 0.01, [0.55, 0.2, 0.85]);
      o(-0.1, T, 0.3, 0.1, T + 0.38, 0.31, [0.25, 0.15, 0.08]);
      glow(-0.06, T + 0.72, 0.3, 0.06, T + 0.88, 0.31, [1, 0.85, 0.35]);
      break;
    }
    case 'teddy': {
      const fur: RGB = [0.62, 0.4, 0.22];
      const light: RGB = [0.85, 0.68, 0.48];
      o(-0.27, T, -0.2, 0.27, T + 0.6, 0.2, fur);
      o(-0.16, T + 0.1, 0.2, 0.16, T + 0.45, 0.22, light);
      for (const s of [-1, 1]) {
        o(s * 0.27, T + 0.22, -0.08, s * 0.37, T + 0.5, 0.08, fur);
        o(s * 0.08, T, 0.2, s * 0.24, T + 0.12, 0.3, fur);
        o(s * 0.13, T + 0.98, -0.04, s * 0.26, T + 1.12, 0.04, fur);
      }
      o(-0.22, T + 0.6, -0.18, 0.22, T + 1.02, 0.18, fur);
      o(-0.09, T + 0.66, 0.18, 0.09, T + 0.8, 0.25, light);
      o(-0.04, T + 0.75, 0.25, 0.04, T + 0.8, 0.26, black);
      for (const s of [-1, 1]) o(s * 0.06, T + 0.86, 0.18, s * 0.11, T + 0.92, 0.19, black);
      break;
    }
    case 'heart': {
      solid(-0.03, T, -0.03, 0.03, T + 0.25, 0.03, 'gold');
      const rows = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
      const c = 0.12;
      rows.forEach((row, r) => {
        [...row].forEach((ch, i) => {
          if (ch !== 'X') return;
          const x = (i - 3.5) * c;
          const y = T + 0.25 + (rows.length - 1 - r) * c;
          glow(x, y, -0.06, x + c, y + c, 0.06, [1, 0.2, 0.45]);
        });
      });
      break;
    }
    case 'cactus': {
      o(-0.42, T, -0.42, 0.42, T + 0.06, 0.42, [0.86, 0.72, 0.46]);
      const green: RGB = [0.27, 0.6, 0.27];
      o(-0.12, T, -0.12, 0.12, T + 1.3, 0.12, green);
      o(-0.32, T + 0.5, -0.07, -0.12, T + 0.62, 0.07, green);
      o(-0.32, T + 0.5, -0.07, -0.2, T + 0.95, 0.07, green);
      o(0.12, T + 0.75, -0.07, 0.32, T + 0.87, 0.07, green);
      o(0.2, T + 0.75, -0.07, 0.32, T + 1.15, 0.07, green);
      const hat: RGB = [0.5, 0.3, 0.15];
      o(-0.24, T + 1.3, -0.24, 0.24, T + 1.34, 0.24, hat);
      o(-0.13, T + 1.34, -0.13, 0.13, T + 1.5, 0.13, hat);
      o(-0.135, T + 1.36, -0.135, 0.135, T + 1.4, 0.135, [0.2, 0.12, 0.06]);
      break;
    }
    case 'bomb': {
      o(-0.25, T, -0.25, 0.25, T + 0.5, 0.25, black);
      o(-0.3, T + 0.1, -0.3, 0.3, T + 0.4, 0.3, black);
      o(-0.18, T + 0.5, -0.18, 0.18, T + 0.56, 0.18, black);
      solid(-0.06, T + 0.56, -0.06, 0.06, T + 0.64, 0.06, 'metal');
      solid(-0.015, T + 0.64, -0.015, 0.015, T + 0.82, 0.015, 'rope');
      glow(-0.06, T + 0.82, -0.06, 0.06, T + 0.92, 0.06, [1, 0.8, 0.2]);
      o(0.12, T + 0.3, 0.3, 0.2, T + 0.38, 0.31, [0.95, 0.95, 1]);
      break;
    }
    case 'magnifier': {
      solid(-0.04, T, -0.04, 0.04, T + 0.7, 0.04, 'darkOak');
      const cy = T + 1.02;
      solid(-0.32, cy + 0.26, -0.04, 0.32, cy + 0.32, 0.04, 'gold');
      solid(-0.32, cy - 0.32, -0.04, 0.32, cy - 0.26, 0.04, 'gold');
      solid(-0.32, cy - 0.26, -0.04, -0.26, cy + 0.26, 0.04, 'gold');
      solid(0.26, cy - 0.26, -0.04, 0.32, cy + 0.26, 0.04, 'gold');
      glass(-0.26, cy - 0.26, -0.015, 0.26, cy + 0.26, 0.015);
      solid(-0.05, T + 0.7, -0.05, 0.05, cy - 0.32, 0.05, 'gold');
      break;
    }
    case 'helmet': {
      solid(-0.32, T, -0.32, 0.32, T + 0.5, 0.32, 'oak');
      solid(-0.33, T + 0.2, -0.33, 0.33, T + 0.27, 0.33, 'darkOak');
      const olive: RGB = [0.33, 0.4, 0.22];
      o(-0.28, T + 0.5, -0.28, 0.28, T + 0.56, 0.28, olive);
      o(-0.22, T + 0.56, -0.22, 0.22, T + 0.72, 0.22, olive);
      o(-0.14, T + 0.72, -0.14, 0.14, T + 0.8, 0.14, olive);
      glow(-0.06, T + 0.3, 0.32, 0.06, T + 0.42, 0.33, [1, 0.82, 0.25]);
      break;
    }
    case 'column': {
      o(-0.3, T, -0.3, 0.3, T + 0.1, 0.3, marble);
      o(-0.2, T + 0.1, -0.2, 0.2, T + 1.2, 0.2, [0.92, 0.9, 0.86]);
      for (const x of [-0.12, -0.02, 0.08]) {
        o(x, T + 0.15, 0.2, x + 0.04, T + 1.15, 0.21, [0.75, 0.73, 0.7]);
      }
      o(-0.3, T + 1.2, -0.3, 0.3, T + 1.32, 0.3, marble);
      solid(-0.18, T + 1.32, -0.05, 0.18, T + 1.38, 0.05, 'gold');
      break;
    }
    case 'duck': {
      const yellow: RGB = [1, 0.85, 0.15];
      o(-0.3, T, -0.3, 0.3, T + 0.38, 0.2, yellow);
      o(-0.12, T + 0.25, -0.38, 0.12, T + 0.5, -0.3, yellow);
      o(-0.17, T + 0.38, -0.05, 0.17, T + 0.72, 0.25, yellow);
      o(-0.08, T + 0.48, 0.25, 0.08, T + 0.56, 0.38, [1, 0.5, 0.1]);
      for (const s of [-1, 1]) o(s * 0.07, T + 0.6, 0.25, s * 0.12, T + 0.65, 0.26, black);
      break;
    }
    case 'guitar': {
      const red: RGB = [0.8, 0.1, 0.2];
      o(-0.26, T, -0.07, 0.26, T + 0.45, 0.07, red);
      o(-0.19, T + 0.45, -0.07, 0.19, T + 0.7, 0.07, red);
      o(-0.07, T + 0.38, 0.07, 0.07, T + 0.52, 0.08, black);
      solid(-0.04, T + 0.7, -0.03, 0.04, T + 1.5, 0.03, 'darkOak');
      solid(-0.07, T + 1.5, -0.03, 0.07, T + 1.65, 0.03, 'darkOak');
      for (const x of [-0.02, 0.0, 0.02]) {
        o(x - 0.004, T + 0.2, 0.07, x + 0.004, T + 1.5, 0.075, [0.9, 0.9, 0.9]);
      }
      glow(0.22, T + 1.0, -0.01, 0.3, T + 1.08, 0.01, [1, 0.3, 0.7]);
      glow(0.27, T + 1.08, -0.01, 0.29, T + 1.3, 0.01, [1, 0.3, 0.7]);
      break;
    }
    case 'globe': {
      solid(-0.2, T, -0.2, 0.2, T + 0.05, 0.2, 'darkMetal');
      solid(-0.04, T + 0.05, -0.04, 0.04, T + 0.4, 0.04, 'gold');
      o(-0.3, T + 0.4, -0.3, 0.3, T + 1.0, 0.3, [0.2, 0.45, 0.85]);
      const land: RGB = [0.3, 0.7, 0.3];
      o(-0.22, T + 0.62, 0.3, 0.02, T + 0.88, 0.31, land);
      o(0.05, T + 0.45, 0.3, 0.22, T + 0.65, 0.31, land);
      o(0.3, T + 0.55, -0.15, 0.31, T + 0.85, 0.12, land);
      o(-0.31, T + 0.48, -0.1, -0.3, T + 0.7, 0.2, land);
      o(-0.1, T + 1.0, -0.1, 0.1, T + 1.01, 0.1, [0.95, 0.95, 1]);
      break;
    }
    case 'hourglass': {
      for (const y of [T, T + 1.0]) solid(-0.3, y, -0.3, 0.3, y + 0.06, 0.3, 'darkOak');
      for (const x of [-0.3, 0.25]) {
        for (const z of [-0.3, 0.25]) solid(x, T + 0.06, z, x + 0.05, T + 1.0, z + 0.05, 'darkOak');
      }
      const sand: RGB = [0.92, 0.76, 0.42];
      o(-0.15, T + 0.06, -0.15, 0.15, T + 0.2, 0.15, sand);
      o(-0.08, T + 0.2, -0.08, 0.08, T + 0.26, 0.08, sand);
      o(-0.1, T + 0.82, -0.1, 0.1, T + 0.96, 0.1, sand);
      o(-0.015, T + 0.26, -0.015, 0.015, T + 0.82, 0.015, sand);
      glass(-0.2, T + 0.06, -0.2, 0.2, T + 0.3, 0.2);
      glass(-0.1, T + 0.3, -0.1, 0.1, T + 0.76, 0.1);
      glass(-0.2, T + 0.76, -0.2, 0.2, T + 1.0, 0.2);
      break;
    }
    case 'chest': {
      solid(-0.36, T, -0.26, 0.36, T + 0.35, 0.26, 'oak');
      solid(-0.36, T + 0.35, -0.3, 0.36, T + 0.42, 0.26, 'darkOak');
      solid(-0.36, T + 0.42, -0.44, 0.36, T + 0.75, -0.36, 'darkOak');
      for (const x of [-0.28, 0.22]) solid(x, T, 0.26, x + 0.06, T + 0.35, 0.27, 'metal');
      solid(-0.05, T + 0.2, 0.26, 0.05, T + 0.32, 0.28, 'gold');
      glow(-0.3, T + 0.42, -0.22, 0.3, T + 0.5, 0.22, [1, 0.82, 0.25]);
      glow(-0.15, T + 0.5, -0.12, 0.12, T + 0.56, 0.1, [1, 0.9, 0.4]);
      break;
    }
    case 'award': {
      solid(-0.2, T, -0.2, 0.2, T + 0.25, 0.2, 'black');
      solid(-0.07, T + 0.25, -0.06, 0.07, T + 0.72, 0.06, 'gold');
      solid(-0.1, T + 0.72, -0.07, 0.1, T + 1.1, 0.07, 'gold');
      solid(-0.11, T + 0.85, 0.07, 0.11, T + 0.93, 0.1, 'gold');
      solid(-0.07, T + 1.12, -0.06, 0.07, T + 1.28, 0.06, 'gold');
      break;
    }
  }
}

/**
 * Builds a statue designed for this movie (see src/cloud/statues.ts) on the same
 * pedestal; `at` as for buildStatue.
 */
export function buildDesignedStatue(
  spec: StatueSpec,
  parts: StatueParts,
  at: (x: number, y: number, z: number) => [number, number, number],
) {
  const rgb = (c: number): RGB => [
    ((c >> 16) & 255) / 255,
    ((c >> 8) & 255) / 255,
    (c & 255) / 255,
  ];
  // The plaque glows in the statue's own glow colour (gold if nothing glows).
  const glowing = spec.boxes.find((b) => b[7] === 1);
  const put = (
    b: BoxBuilder,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    faces: Faces,
    tint?: RGB,
  ) => {
    const a = at(x0, y0, z0);
    const c = at(x1, y1, z1);
    b.box(a[0], a[1], a[2], c[0], c[1], c[2], faces, { fit: true, tint });
  };
  put(parts.opaque, -0.5, 0, -0.5, 0.5, 0.15, 0.5, 'darkMetal');
  put(parts.opaque, -0.42, 0.15, -0.42, 0.42, 0.75, 0.42, 'white', [0.86, 0.84, 0.8]);
  put(parts.opaque, -0.48, 0.75, -0.48, 0.48, PEDESTAL.top, 0.48, 'gold');
  put(
    parts.glow,
    -0.28,
    0.38,
    0.42,
    0.28,
    0.52,
    0.44,
    'white',
    glowing ? rgb(glowing[6]) : [1, 0.82, 0.25],
  );
  // Grid units are 1/16 m, centred on the pedestal.
  const gx = (n: number) => n / 16 - STATUE_GRID.x / 32;
  const gz = (n: number) => n / 16 - STATUE_GRID.z / 32;
  for (const [x0, y0, z0, x1, y1, z1, color, glow] of spec.boxes) {
    put(
      glow ? parts.glow : parts.opaque,
      gx(x0),
      PEDESTAL.top + y0 / 16,
      gz(z0),
      gx(x1),
      PEDESTAL.top + y1 / 16,
      gz(z1),
      'white',
      rgb(color),
    );
  }
}
