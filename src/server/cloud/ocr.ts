// DVD subtitles are pictures (VobSub). Browsers need text, so at rip time the
// English track is pulled out of MakeMKV's file (mkvextract), each picture is
// decoded here, and Tesseract reads the words. The result is WebVTT.
//
// Needs Homebrew's `tesseract` and `mkvtoolnix`; without them this returns null
// and the movie gets downloaded subtitles instead.
import fs from 'node:fs';
import path from 'node:path';
import { toWebVtt } from '../../shared/subtitles.js';
import type { Runner } from '../ripper/process.js';

const SEARCH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

export function findTool(name: string): string | null {
  for (const dir of SEARCH) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// -----------------------------------------------------------------------------
// .idx (palette and where each subtitle starts in the .sub file)

export interface IdxFile {
  palette: [number, number, number][];
  entries: { seconds: number; filepos: number }[];
}

export function parseIdx(text: string): IdxFile {
  const paletteLine = /^palette:\s*(.+)$/m.exec(text)?.[1] ?? '';
  const palette = paletteLine
    .split(',')
    .map((hex) => hex.trim())
    .filter(Boolean)
    .map((hex) => {
      const n = Number.parseInt(hex, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as [number, number, number];
    });
  const entries = [
    ...text.matchAll(/timestamp:\s*(\d+):(\d+):(\d+):(\d+),\s*filepos:\s*([0-9a-fA-F]+)/g),
  ].map((m) => ({
    seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
    filepos: Number.parseInt(m[5]!, 16),
  }));
  return { palette, entries };
}

// -----------------------------------------------------------------------------
// .sub: MPEG program stream packs carrying the subtitle packets (SPUs)

/** The SPU (one subtitle's bitmap and timing) starting at `filepos`. */
export function readSpu(sub: Uint8Array, filepos: number): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let have = 0;
  let expected: number | null = null;
  let pos = filepos;
  for (let guard = 0; guard < 64 && pos + 4 < sub.length; guard++) {
    // Find the next pack header (00 00 01 BA).
    while (
      pos + 4 < sub.length &&
      !(sub[pos] === 0 && sub[pos + 1] === 0 && sub[pos + 2] === 1 && sub[pos + 3] === 0xba)
    )
      pos++;
    if (pos + 14 >= sub.length) break;
    pos += 14 + (sub[pos + 13]! & 7);
    // Then PES packets until the next pack.
    while (
      pos + 6 < sub.length &&
      sub[pos] === 0 &&
      sub[pos + 1] === 0 &&
      sub[pos + 2] === 1 &&
      sub[pos + 3] !== 0xba
    ) {
      const stream = sub[pos + 3]!;
      const length = (sub[pos + 4]! << 8) | sub[pos + 5]!;
      const end = pos + 6 + length;
      if (stream === 0xbd) {
        const headerLength = sub[pos + 8]!;
        const payload = pos + 9 + headerLength + 1; // skip the substream id byte
        const data = sub.subarray(payload, end);
        chunks.push(data);
        have += data.length;
        if (expected === null && have >= 2) {
          const first = chunks[0]!.length >= 2 ? chunks[0]! : concat(chunks);
          expected = (first[0]! << 8) | first[1]!;
        }
        if (expected !== null && have >= expected) return concat(chunks).subarray(0, expected);
      }
      pos = end;
    }
  }
  return null;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export interface SpuImage {
  width: number;
  height: number;
  /** One 2-bit colour slot (0–3) per pixel. */
  pixels: Uint8Array;
  /** Palette index and transparency (0 = invisible … 15 = solid) for each slot. */
  colors: [number, number, number, number];
  alpha: [number, number, number, number];
  startSeconds: number;
  endSeconds: number | null;
}

const DELAY_UNIT = 1024 / 90_000;

/** Decodes an SPU: control sequences (timing, colours, position) and the RLE bitmap. */
export function decodeSpu(spu: Uint8Array): SpuImage | null {
  if (spu.length < 4) return null;
  const control = (spu[2]! << 8) | spu[3]!;
  let colors: SpuImage['colors'] = [0, 1, 2, 3];
  let alpha: SpuImage['alpha'] = [0, 15, 15, 15];
  let x1 = 0;
  let x2 = -1;
  let y1 = 0;
  let y2 = -1;
  let top = 0;
  let bottom = 0;
  let start = 0;
  let end: number | null = null;
  let offset = control;
  for (let guard = 0; guard < 32 && offset + 4 <= spu.length; guard++) {
    const delay = ((spu[offset]! << 8) | spu[offset + 1]!) * DELAY_UNIT;
    const next = (spu[offset + 2]! << 8) | spu[offset + 3]!;
    let p = offset + 4;
    commands: while (p < spu.length) {
      const cmd = spu[p++]!;
      switch (cmd) {
        case 0x00:
        case 0x01:
          start = delay;
          break;
        case 0x02:
          end = delay;
          break;
        case 0x03:
          colors = [spu[p + 1]! & 15, spu[p + 1]! >> 4, spu[p]! & 15, spu[p]! >> 4];
          p += 2;
          break;
        case 0x04:
          alpha = [spu[p + 1]! & 15, spu[p + 1]! >> 4, spu[p]! & 15, spu[p]! >> 4];
          p += 2;
          break;
        case 0x05:
          x1 = (spu[p]! << 4) | (spu[p + 1]! >> 4);
          x2 = ((spu[p + 1]! & 15) << 8) | spu[p + 2]!;
          y1 = (spu[p + 3]! << 4) | (spu[p + 4]! >> 4);
          y2 = ((spu[p + 4]! & 15) << 8) | spu[p + 5]!;
          p += 6;
          break;
        case 0x06:
          top = (spu[p]! << 8) | spu[p + 1]!;
          bottom = (spu[p + 2]! << 8) | spu[p + 3]!;
          p += 4;
          break;
        default:
          break commands; // 0xFF ends the sequence
      }
    }
    if (next === offset) break;
    offset = next;
  }
  const width = x2 - x1 + 1;
  const height = y2 - y1 + 1;
  if (width <= 0 || height <= 0 || width > 2000 || height > 2000) return null;
  const pixels = new Uint8Array(width * height);
  decodeField(spu, top, control, width, height, 0, pixels);
  decodeField(spu, bottom, control, width, height, 1, pixels);
  return { width, height, pixels, colors, alpha, startSeconds: start, endSeconds: end };
}

/** One interlaced field of 2-bit run-length-coded pixels (every other line). */
function decodeField(
  spu: Uint8Array,
  offset: number,
  limit: number,
  width: number,
  height: number,
  firstLine: number,
  pixels: Uint8Array,
) {
  let nibble = offset * 2;
  const end = limit * 2;
  const read = () => {
    if (nibble >= end) return 0;
    const byte = spu[nibble >> 1]!;
    const value = nibble & 1 ? byte & 15 : byte >> 4;
    nibble++;
    return value;
  };
  for (let y = firstLine; y < height; y += 2) {
    let x = 0;
    while (x < width) {
      let v = read();
      if (v < 0x4) {
        v = (v << 4) | read();
        if (v < 0x10) {
          v = (v << 4) | read();
          if (v < 0x40) v = (v << 4) | read();
        }
      }
      const color = v & 3;
      let run = v >> 2;
      if (run === 0) run = width - x;
      pixels.fill(color, y * width + x, y * width + Math.min(width, x + run));
      x += run;
      if (nibble >= end) break;
    }
    if (nibble & 1) nibble++;
  }
}

/**
 * A black-on-white picture of the words for Tesseract: the bright, visible
 * colour is the text; the dark outline and the background become white.
 * Scaled up and with a margin, which OCR likes.
 */
export function toPgm(
  image: SpuImage,
  palette: IdxFile['palette'],
  scale = 2,
  margin = 12,
): Uint8Array {
  const luma = (slot: number) => {
    const rgb = palette[image.colors[slot]!] ?? [255, 255, 255];
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  };
  const visible = [0, 1, 2, 3].filter((slot) => image.alpha[slot]! > 0);
  const brightest = Math.max(...visible.map(luma), 0);
  // Text is the brightest visible colour (and anything nearly as bright).
  const ink = new Set(visible.filter((slot) => luma(slot) >= brightest - 40));
  if (ink.size === 0) visible.forEach((slot) => ink.add(slot));
  const w = image.width * scale + margin * 2;
  const h = image.height * scale + margin * 2;
  const header = new TextEncoder().encode(`P5\n${w} ${h}\n255\n`);
  const out = new Uint8Array(header.length + w * h).fill(255);
  out.set(header, 0);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (!ink.has(image.pixels[y * image.width + x]!)) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = header.length + (margin + y * scale + dy) * w + margin + x * scale;
        out.fill(0, row, row + scale);
      }
    }
  }
  return out;
}

/** Common OCR slips in subtitles. */
export function cleanOcrText(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/\s+/g, ' ')
        .replace(/(^|\s)\|(\s|$)/g, '$1I$2')
        .replace(/\bl(?=['’](?:m|ll|ve|d)\b)/g, 'I')
        .replace(/[`´]/g, '’')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}

// -----------------------------------------------------------------------------

interface MkvTrack {
  id: number;
  type: string;
  codec: string;
  properties?: {
    language?: string;
    language_ietf?: string;
    forced_track?: boolean;
    number?: number;
  };
}

/** The disc's English subtitles as WebVTT, or null when they can't be read. */
export async function ocrDiscSubtitles(
  run: Runner,
  mkv: string,
  workDir: string,
  tools = {
    mkvmerge: findTool('mkvmerge'),
    mkvextract: findTool('mkvextract'),
    tesseract: findTool('tesseract'),
  },
): Promise<string | null> {
  const { mkvmerge, mkvextract, tesseract } = tools;
  if (!mkvmerge || !mkvextract || !tesseract) return null;

  const info = await run(mkvmerge, ['-J', mkv]);
  const tracks =
    (JSON.parse(info.output.slice(info.output.indexOf('{'))) as { tracks?: MkvTrack[] }).tracks ??
    [];
  const english = tracks.filter(
    (t) =>
      t.type === 'subtitles' &&
      /vobsub/i.test(t.codec) &&
      (t.properties?.language === 'eng' || t.properties?.language_ietf?.startsWith('en')),
  );
  // Full subtitles, not the "forced" ones that only translate foreign dialogue.
  const track = english.find((t) => !t.properties?.forced_track) ?? english[0];
  if (!track) return null;

  const dir = path.join(workDir, 'ocr');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    const base = path.join(dir, 'english');
    const extracted = await run(mkvextract, [mkv, 'tracks', `${track.id}:${base}.sub`]);
    if (extracted.code !== 0 || !fs.existsSync(`${base}.idx`)) return null;
    const idx = parseIdx(fs.readFileSync(`${base}.idx`, 'utf8'));
    const sub = new Uint8Array(fs.readFileSync(`${base}.sub`));

    const cues: { start: number; end: number; image: string }[] = [];
    idx.entries.forEach((entry, i) => {
      const spu = readSpu(sub, entry.filepos);
      const image = spu ? decodeSpu(spu) : null;
      if (!image) return;
      const start = entry.seconds + image.startSeconds;
      const next = idx.entries[i + 1]?.seconds ?? start + 5;
      const end =
        image.endSeconds !== null ? entry.seconds + image.endSeconds : Math.min(next, start + 5);
      const file = path.join(dir, `${String(i).padStart(5, '0')}.pgm`);
      fs.writeFileSync(file, toPgm(image, idx.palette));
      cues.push({ start, end: Math.max(end, start + 0.5), image: file });
    });
    if (cues.length < 20) return null;

    // One Tesseract run for all pictures; pages come back separated by form feeds.
    const list = path.join(dir, 'pages.txt');
    fs.writeFileSync(list, cues.map((c) => c.image).join('\n') + '\n');
    const result = await run(tesseract, [list, path.join(dir, 'text'), '-l', 'eng', '--psm', '6']);
    const textFile = path.join(dir, 'text.txt');
    if (result.code !== 0 || !fs.existsSync(textFile)) return null;
    const pages = fs.readFileSync(textFile, 'utf8').split('\f');
    if (pages.length < cues.length) return null;

    const srt = cues
      .map((c, i) => ({ ...c, text: cleanOcrText(pages[i] ?? '') }))
      .filter((c) => c.text)
      .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
      .join('\n');
    return toWebVtt(srt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))},${pad(ms % 1000, 3)}`;
}
