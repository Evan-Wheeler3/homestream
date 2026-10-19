import { seededRandom } from '../../shared/catalog.js';
import type { SampleFilm } from './mockLibrary.js';

// Generated artwork for the sample library: typographic posters in the spirit of
// repertory-cinema prints, plus abstract backdrops. Deterministic per film.

const PALETTES: [bg: string, ink: string, accent: string][] = [
  ['#1b2a3a', '#ecdfc6', '#d9773a'],
  ['#2b1a1f', '#f0e1d0', '#c63d2f'],
  ['#10261f', '#e7e2cf', '#d4a64a'],
  ['#e8dfcc', '#1d1d1f', '#c2412d'],
  ['#0f0f12', '#f1ede4', '#7aa6c2'],
  ['#3a2c4a', '#f3e6d8', '#e6a15c'],
  ['#d9c7a3', '#2a2420', '#3d6b6b'],
  ['#1f3b4d', '#f4efe6', '#f2b134'],
  ['#401b1b', '#efe3cf', '#e0b04c'],
  ['#14213d', '#f3ead8', '#fca311'],
  ['#2f3e2c', '#efe8d6', '#c9643b'],
  ['#efe6d8', '#22303c', '#3f7f8c'],
];

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && (current + ' ' + word).length > maxChars) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines;
}

function motif(
  kind: number,
  rand: () => number,
  w: number,
  h: number,
  ink: string,
  accent: string,
) {
  const cx = w * (0.35 + rand() * 0.3);
  const cy = h * (0.3 + rand() * 0.15);
  const r = Math.min(w, h) * (0.22 + rand() * 0.12);
  switch (kind) {
    case 0: // sun over a horizon
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${accent}"/>
        <rect x="0" y="${cy + r * 0.35}" width="${w}" height="${h}" fill="${ink}" opacity="0.08"/>
        <line x1="0" x2="${w}" y1="${cy + r * 0.35}" y2="${cy + r * 0.35}" stroke="${ink}" stroke-width="2" opacity="0.6"/>`;
    case 1: // concentric arcs
      return Array.from({ length: 7 }, (_, i) => {
        const rr = r * (0.35 + i * 0.22);
        return `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="none" stroke="${i % 2 ? ink : accent}" stroke-width="${3 + (i % 3) * 3}" opacity="${0.9 - i * 0.1}"/>`;
      }).join('');
    case 2: // diagonal bands
      return Array.from({ length: 5 }, (_, i) => {
        const offset = -w + i * (w / 2.2) + rand() * 40;
        const color = i % 2 ? ink : accent;
        return `<polygon points="${offset},${h} ${offset + w * 0.25},${h} ${offset + w * 1.1},0 ${offset + w * 0.85},0" fill="${color}" opacity="${i % 2 ? 0.12 : 0.85}"/>`;
      }).join('');
    case 3: {
      // halftone dot field
      const dots: string[] = [];
      const step = Math.round(Math.min(w, h) / 14);
      for (let y = step; y < h * 0.62; y += step) {
        for (let x = step / 2; x < w; x += step) {
          const d = Math.hypot(x - cx, y - cy) / (r * 1.6);
          const size = Math.max(0, (1 - d) * step * 0.45);
          if (size > 0.5)
            dots.push(`<circle cx="${x}" cy="${y}" r="${size.toFixed(1)}" fill="${accent}"/>`);
        }
      }
      return dots.join('');
    }
    default: {
      // stacked bars
      return Array.from({ length: 6 }, (_, i) => {
        const bw = w * (0.2 + rand() * 0.6);
        const y = h * 0.1 + i * (h * 0.075);
        return `<rect x="${w - bw - w * 0.08}" y="${y}" width="${bw}" height="${h * 0.04}" fill="${i === 2 ? accent : ink}" opacity="${i === 2 ? 1 : 0.18}"/>`;
      }).join('');
    }
  }
}

function setup(film: SampleFilm) {
  const rand = seededRandom(film.id);
  const palette = PALETTES[Math.floor(rand() * PALETTES.length)] ?? PALETTES[0]!;
  const kind = Math.floor(rand() * 5);
  return { rand, palette, kind };
}

export function posterSvg(film: SampleFilm): string {
  const { rand, palette, kind } = setup(film);
  const [bg, ink, accent] = palette;
  const W = 600;
  const H = 900;
  const lines = wrap(film.title.toUpperCase(), 12);
  const longest = Math.max(...lines.map((l) => l.length));
  // Georgia capitals average ~0.74em wide; keep the longest line inside 520px.
  const size = Math.min(92, Math.floor(520 / Math.max(longest, 5) / 0.76));
  const lineHeight = size * 1.02;
  const titleTop = H - 120 - lines.length * lineHeight;
  const director =
    film.byline ??
    (film.directors.length
      ? `A FILM BY ${film.directors.slice(0, 2).join(' & ').toUpperCase()}`
      : 'A HOME MOVIE');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <g>${motif(kind, rand, W, H, ink, accent)}</g>
  <text x="40" y="58" fill="${ink}" font-family="${SANS}" font-size="15" letter-spacing="4" opacity="0.85">${escapeXml(director)}</text>
  <line x1="40" x2="${W - 40}" y1="78" y2="78" stroke="${ink}" stroke-width="1" opacity="0.35"/>
  ${lines
    .map(
      (line, i) =>
        `<text x="38" y="${titleTop + (i + 1) * lineHeight}" fill="${ink}" font-family="${SERIF}" font-size="${size}" letter-spacing="1">${escapeXml(line)}</text>`,
    )
    .join('')}
  <line x1="40" x2="${W - 40}" y1="${H - 84}" y2="${H - 84}" stroke="${ink}" stroke-width="1" opacity="0.35"/>
  <text x="40" y="${H - 48}" fill="${ink}" font-family="${SANS}" font-size="16" letter-spacing="3" opacity="0.8">${escapeXml((film.countries[0] ?? '').toUpperCase())}</text>
  <text x="${W - 40}" y="${H - 48}" text-anchor="end" fill="${accent}" font-family="${SANS}" font-size="18" font-weight="bold" letter-spacing="3">${film.year}</text>
</svg>`;
}

export function backdropSvg(film: SampleFilm): string {
  const { rand, palette, kind } = setup(film);
  const [bg, ink, accent] = palette;
  const W = 1920;
  const H = 1080;
  // Shift the motif right so overlaid hero text on the left stays legible.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <radialGradient id="v" cx="70%" cy="40%" r="80%">
      <stop offset="0" stop-color="${bg}" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.65"/>
    </radialGradient>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 0.07"/></feComponentTransfer></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <g transform="translate(${W * 0.32} ${H * 0.05}) scale(0.75)">${motif(kind, rand, W, H, ink, accent)}</g>
  <rect width="${W}" height="${H}" fill="url(#v)"/>
  <rect width="${W}" height="${H}" filter="url(#grain)"/>
</svg>`;
}

/** Title-logo art: the title on a transparent background, like the logos Jellyfin downloads. */
export function logoSvg(film: SampleFilm): string {
  const { palette } = setup(film);
  const accent = palette[2];
  const lines = wrap(film.title.toUpperCase(), 16);
  const W = 1000;
  const size = Math.min(150, Math.floor(940 / Math.max(...lines.map((l) => l.length), 5) / 0.72));
  const H = Math.round(lines.length * size * 1.02 + 40);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${lines
    .map(
      (line, i) =>
        `<text x="0" y="${(i + 1) * size * 1.0}" fill="#f6f1e7" stroke="${accent}" stroke-width="2" paint-order="stroke" font-family="${SERIF}" font-weight="bold" font-size="${size}" letter-spacing="6">${escapeXml(line)}</text>`,
    )
    .join('')}
  <rect x="2" y="${H - 18}" width="${Math.min(W - 4, size * 3)}" height="6" fill="${accent}"/>
</svg>`;
}
