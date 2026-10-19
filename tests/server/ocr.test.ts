import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanOcrText,
  decodeSpu,
  ocrDiscSubtitles,
  parseIdx,
  readSpu,
  toPgm,
} from '../../src/server/cloud/ocr';
import type { Runner } from '../../src/server/ripper/process';

/** Encodes a bitmap the way DVDs do: 2-bit RLE, interlaced, plus control sequences. */
function encodeSpu(width: number, height: number, pixels: number[], stopDelay: number) {
  const field = (first: number) => {
    const nibbles: number[] = [];
    for (let y = first; y < height; y += 2) {
      let x = 0;
      while (x < width) {
        const color = pixels[y * width + x]!;
        let run = 1;
        while (x + run < width && pixels[y * width + x + run] === color) run++;
        const v = (run << 2) | color;
        nibbles.push(0, (v >> 8) & 15, (v >> 4) & 15, v & 15);
        x += run;
      }
      if (nibbles.length % 2) nibbles.push(0);
    }
    return Uint8Array.from(
      { length: nibbles.length / 2 },
      (_, i) => (nibbles[2 * i]! << 4) | nibbles[2 * i + 1]!,
    );
  };
  const top = field(0);
  const bottom = field(1);
  const topAt = 4;
  const bottomAt = topAt + top.length;
  const ctrl = bottomAt + bottom.length;
  const x1 = 100;
  const x2 = x1 + width - 1;
  const y1 = 400;
  const y2 = y1 + height - 1;
  const first = [
    0,
    0,
    0,
    0, // delay 0, next (filled below)
    0x01,
    0x03,
    0x2f,
    0x01, // e2=2, e1=f, p=0, b=1  → slots: b=1, p=0, e1=15, e2=2
    0x04,
    0xff,
    0xf0, // alpha: e2=15, e1=15, p=15, b=0
    0x05,
    x1 >> 4,
    ((x1 & 15) << 4) | (x2 >> 8),
    x2 & 255,
    y1 >> 4,
    ((y1 & 15) << 4) | (y2 >> 8),
    y2 & 255,
    0x06,
    topAt >> 8,
    topAt & 255,
    bottomAt >> 8,
    bottomAt & 255,
    0xff,
  ];
  const secondAt = ctrl + first.length;
  first[2] = secondAt >> 8;
  first[3] = secondAt & 255;
  const second = [stopDelay >> 8, stopDelay & 255, secondAt >> 8, secondAt & 255, 0x02, 0xff];
  const size = secondAt + second.length;
  return Uint8Array.from([
    size >> 8,
    size & 255,
    ctrl >> 8,
    ctrl & 255,
    ...top,
    ...bottom,
    ...first,
    ...second,
  ]);
}

/** Wraps an SPU in MPEG program stream packs, split across two PES packets. */
function packs(spu: Uint8Array): Uint8Array {
  const pes = (data: Uint8Array) => {
    const body = [0x81, 0x80, 5, 0x21, 0, 1, 0, 1, 0x20, ...data];
    return [0, 0, 1, 0xbd, body.length >> 8, body.length & 255, ...body];
  };
  const header = [0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 1, 0x89, 0xc3, 0xf8];
  const half = Math.ceil(spu.length / 2);
  return Uint8Array.from([
    ...header,
    ...pes(spu.subarray(0, half)),
    ...header,
    ...pes(spu.subarray(half)),
  ]);
}

const W = 10;
const H = 6;
// A white "bar" (slot 1 = pattern) with a black outline (slot 2) on transparency (slot 0).
const PIXELS = Array.from({ length: W * H }, (_, i) => {
  const x = i % W;
  const y = Math.floor(i / W);
  if (y === 0 || y === H - 1 || x === 0 || x === W - 1) return 0;
  if (y === 1 || y === H - 2 || x === 1 || x === W - 2) return 2;
  return 1;
});

const IDX = `# VobSub index file, v7
size: 720x480
palette: 000000, ffffff, 808080, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 101010
id: en, index: 0
timestamp: 00:01:02:500, filepos: 000000000
`;

describe('reading DVD subtitles', () => {
  it('decodes the run-length bitmap, colours, position and timing', () => {
    const spu = readSpu(packs(encodeSpu(W, H, PIXELS, 200)), 0)!;
    const image = decodeSpu(spu)!;
    expect(image).toMatchObject({ width: W, height: H, startSeconds: 0 });
    expect([...image.pixels]).toEqual(PIXELS);
    expect(image.colors).toEqual([1, 0, 15, 2]);
    expect(image.alpha).toEqual([0, 15, 15, 15]);
    expect(image.endSeconds).toBeCloseTo((200 * 1024) / 90000, 5);
  });

  it('reads the palette and timestamps from the .idx', () => {
    const idx = parseIdx(IDX);
    expect(idx.palette).toHaveLength(16);
    expect(idx.palette[1]).toEqual([255, 255, 255]);
    expect(idx.entries).toEqual([{ seconds: 62.5, filepos: 0 }]);
  });

  it('draws the bright text black on white for OCR, without the outline', () => {
    const image = decodeSpu(readSpu(packs(encodeSpu(W, H, PIXELS, 200)), 0)!)!;
    // Slot 1 → palette 0 (black), slot 2 → palette 15 (dark): make slot 1 white for this test.
    image.colors = [1, 1, 0, 2];
    const pgm = toPgm(image, parseIdx(IDX).palette, 1, 0);
    const pixels = pgm.subarray(pgm.length - W * H);
    const ink = [...pixels].map((p) => (p === 0 ? 1 : 0));
    expect(ink).toEqual(PIXELS.map((p) => (p === 1 ? 1 : 0)));
  });

  it('fixes common OCR slips', () => {
    expect(cleanOcrText("| don't know.\nl'm  sure  ")).toBe("I don't know.\nI'm sure");
  });

  it('turns the English track into timed WebVTT', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-ocr-'));
    const spu = packs(encodeSpu(W, H, PIXELS, 200));
    // Thirty subtitles, two seconds apart, all the same picture.
    const subFile = Buffer.concat(Array.from({ length: 30 }, () => Buffer.from(spu)));
    const idx =
      IDX.split('timestamp')[0] +
      Array.from(
        { length: 30 },
        (_, i) =>
          `timestamp: 00:00:${String(10 + i * 2).padStart(2, '0')}:000, filepos: ${(i * spu.length).toString(16).padStart(9, '0')}\n`,
      ).join('');
    const calls: string[] = [];
    const run: Runner = async (command, args) => {
      calls.push(path.basename(command));
      if (command === 'mkvmerge') {
        return {
          code: 0,
          output: JSON.stringify({
            tracks: [
              { id: 1, type: 'video', codec: 'MPEG-1/2' },
              { id: 3, type: 'subtitles', codec: 'VobSub', properties: { language: 'fre' } },
              {
                id: 4,
                type: 'subtitles',
                codec: 'VobSub',
                properties: { language: 'eng', forced_track: true },
              },
              { id: 5, type: 'subtitles', codec: 'VobSub', properties: { language: 'eng' } },
            ],
          }),
        };
      }
      if (command === 'mkvextract') {
        expect(args).toContain(`5:${path.join(dir, 'ocr', 'english.sub')}`);
        fs.writeFileSync(path.join(dir, 'ocr', 'english.idx'), idx);
        fs.writeFileSync(path.join(dir, 'ocr', 'english.sub'), subFile);
        return { code: 0, output: '' };
      }
      // tesseract: one page of text per picture.
      const pages = fs.readFileSync(args[0]!, 'utf8').trim().split('\n');
      fs.writeFileSync(
        `${args[1]}.txt`,
        pages.map((_, i) => `Line | number ${i + 1}\n`).join('\f') + '\f',
      );
      return { code: 0, output: '' };
    };
    const vtt = await ocrDiscSubtitles(run, '/rips/title.mkv', dir, {
      mkvmerge: 'mkvmerge',
      mkvextract: 'mkvextract',
      tesseract: 'tesseract',
    });
    expect(calls).toEqual(['mkvmerge', 'mkvextract', 'tesseract']);
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('00:00:10.000 --> 00:00:12.276\nLine I number 1');
    expect(vtt).toContain('Line I number 30');
    expect(fs.existsSync(path.join(dir, 'ocr'))).toBe(false);
  });

  it('gives up quietly when the tools aren’t installed', async () => {
    const run: Runner = async () => ({ code: 0, output: '' });
    expect(
      await ocrDiscSubtitles(run, 'x.mkv', os.tmpdir(), {
        mkvmerge: null,
        mkvextract: null,
        tesseract: null,
      }),
    ).toBeNull();
  });
});
