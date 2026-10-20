// Pixel-art textures drawn in the browser: block edges, chunky signs, and every
// movie's poster shrunk to a few dozen pixels. Nothing is made ahead of time, so
// a newly uploaded movie shows up in the theater the next time it opens.
import * as THREE from 'three';
import { sizedImage } from '../lib/images';

const pixel = (texture: THREE.Texture) => {
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

/** A soft bevel on every block: lighter top-left edge, darker bottom-right. */
export function blockTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillRect(0, 0, 16, 1);
  g.fillRect(0, 0, 1, 16);
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.fillRect(0, 15, 16, 1);
  g.fillRect(15, 0, 1, 16);
  g.fillStyle = 'rgba(0,0,0,0.05)';
  for (let i = 0; i < 10; i++) g.fillRect((i * 7) % 14, (i * 5) % 14, 1, 1);
  return pixel(new THREE.CanvasTexture(c));
}

export interface SignStyle {
  width?: number;
  height?: number;
  color?: string;
  background?: string;
  /** Neon: a glow around the letters. */
  glow?: string;
  font?: string;
  border?: string;
}

/** Text drawn small and blown up with hard edges: an 80s pixel sign. */
export function signCanvas(lines: string[], style: SignStyle = {}): HTMLCanvasElement {
  const c = document.createElement('canvas');
  drawSign(c, lines, style);
  return c;
}

export function drawSign(c: HTMLCanvasElement, lines: string[], style: SignStyle = {}) {
  const w = style.width ?? 128;
  const h = style.height ?? 32;
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.fillStyle = style.background ?? '#120818';
  g.fillRect(0, 0, w, h);
  if (style.border) {
    g.strokeStyle = style.border;
    g.lineWidth = 2;
    g.strokeRect(1, 1, w - 2, h - 2);
  }
  const lineHeight = h / Math.max(1, lines.length);
  lines.forEach((line, i) => {
    const big = i === 0;
    let size = Math.floor(lineHeight * (big ? 0.72 : 0.6));
    g.font = `${style.font ?? '800'} ${size}px "Courier New", ui-monospace, monospace`;
    // Shrink long lines to fit.
    while (size > 6 && g.measureText(line).width > w - 8) {
      size -= 1;
      g.font = `${style.font ?? '800'} ${size}px "Courier New", ui-monospace, monospace`;
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const y = lineHeight * i + lineHeight / 2 + 1;
    if (style.glow) {
      g.shadowColor = style.glow;
      g.shadowBlur = 6;
    }
    g.fillStyle = big ? (style.color ?? '#ffd23f') : '#f4e9ff';
    g.fillText(line, w / 2, y);
    g.shadowBlur = 0;
  });
}

export function signTexture(lines: string[], style: SignStyle = {}): THREE.CanvasTexture {
  return pixel(new THREE.CanvasTexture(signCanvas(lines, style))) as THREE.CanvasTexture;
}

export function canvasTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  return pixel(new THREE.CanvasTexture(c)) as THREE.CanvasTexture;
}

/** An emoji (or a letter) on a coloured square, for faces, snacks and reactions. */
export function emojiCanvas(emoji: string, background: string | null, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  if (background) {
    g.fillStyle = background;
    g.fillRect(0, 0, size, size);
  }
  g.font = `${Math.floor(size * 0.72)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#1b1022';
  g.fillText(emoji, size / 2, size / 2 + size * 0.05);
  return c;
}

const POSTER_W = 32;
const POSTER_H = 48;
const PER_ROW = 32;

/**
 * Every movie's poster as pixel art, side by side in one big texture, so the
 * whole collection draws in one go. Posters fill in as their images load.
 */
export class PosterAtlas {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  private readonly cells = new Map<string, number>();
  private dirty = false;

  constructor(movies: { id: string; title: string; poster: string | null }[]) {
    const rows = Math.max(1, Math.ceil(movies.length / PER_ROW));
    this.canvas.width = POSTER_W * PER_ROW;
    this.canvas.height = Math.min(4096, 2 ** Math.ceil(Math.log2(rows * POSTER_H)));
    this.g = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.g.imageSmoothingEnabled = true;
    this.g.fillStyle = '#1a0f24';
    this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.texture = canvasTexture(this.canvas);
    const capacity = PER_ROW * Math.floor(this.canvas.height / POSTER_H);
    movies.slice(0, capacity).forEach((m, i) => {
      this.cells.set(m.id, i);
      this.placeholder(i, m.title);
      if (m.poster) this.load(i, m.poster);
    });
  }

  /** The texture coordinates of a movie's poster (u0, v0, u1, v1), or null. */
  uv(movieId: string): [number, number, number, number] | null {
    const i = this.cells.get(movieId);
    if (i === undefined) return null;
    const x = (i % PER_ROW) * POSTER_W;
    const y = Math.floor(i / PER_ROW) * POSTER_H;
    const W = this.canvas.width;
    const H = this.canvas.height;
    return [x / W, 1 - (y + POSTER_H) / H, (x + POSTER_W) / W, 1 - y / H];
  }

  /** Copies one poster out (for a sign or a screen). */
  posterCanvas(movieId: string): HTMLCanvasElement | null {
    const i = this.cells.get(movieId);
    if (i === undefined) return null;
    const c = document.createElement('canvas');
    c.width = POSTER_W;
    c.height = POSTER_H;
    c.getContext('2d')!.drawImage(
      this.canvas,
      (i % PER_ROW) * POSTER_W,
      Math.floor(i / PER_ROW) * POSTER_H,
      POSTER_W,
      POSTER_H,
      0,
      0,
      POSTER_W,
      POSTER_H,
    );
    return c;
  }

  /** Call once a frame: uploads the texture when posters have arrived. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.texture.needsUpdate = true;
  }

  private placeholder(i: number, title: string) {
    const x = (i % PER_ROW) * POSTER_W;
    const y = Math.floor(i / PER_ROW) * POSTER_H;
    const hue = [...title].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
    this.g.fillStyle = `hsl(${hue} 55% 28%)`;
    this.g.fillRect(x, y, POSTER_W, POSTER_H);
    this.g.fillStyle = '#ffd23f';
    this.g.font = 'bold 7px monospace';
    this.g.textAlign = 'center';
    title
      .toUpperCase()
      .split(/\s+/)
      .slice(0, 4)
      .forEach((word, n) => this.g.fillText(word.slice(0, 7), x + POSTER_W / 2, y + 14 + n * 8));
    this.dirty = true;
  }

  private load(i: number, url: string) {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const x = (i % PER_ROW) * POSTER_W;
      const y = Math.floor(i / PER_ROW) * POSTER_H;
      this.g.drawImage(img, x, y, POSTER_W, POSTER_H);
      // Fewer colours, a little punchier: the 80s look.
      const data = this.g.getImageData(x, y, POSTER_W, POSTER_H);
      const d = data.data;
      for (let p = 0; p < d.length; p += 4) {
        for (let k = 0; k < 3; k++) {
          const v = Math.min(255, d[p + k]! * 1.08);
          d[p + k] = Math.round(v / 42.5) * 42.5;
        }
      }
      this.g.putImageData(data, x, y);
      this.dirty = true;
    };
    img.src = sizedImage(url, 160) ?? url;
  }
}
