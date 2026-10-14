/**
 * Parsing for `makemkvcon -r` ("robot mode") output. Each line is
 * `PREFIX:field,field,...` with string fields in double quotes.
 * Reference: https://www.makemkv.com/developers/usage.txt
 */

/** Split one robot-mode record into fields, honouring quoted strings. */
export function splitFields(body: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= body.length) {
    if (body[i] === '"') {
      let value = '';
      i++;
      while (i < body.length) {
        const ch = body[i]!;
        if (ch === '\\' && i + 1 < body.length) {
          value += body[i + 1];
          i += 2;
        } else if (ch === '"' && body[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (ch === '"') {
          i++;
          break;
        } else {
          value += ch;
          i++;
        }
      }
      fields.push(value);
      // Skip to the next comma.
      while (i < body.length && body[i] !== ',') i++;
      i++;
    } else {
      const end = body.indexOf(',', i);
      if (end === -1) {
        fields.push(body.slice(i));
        break;
      }
      fields.push(body.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

export function parseLine(line: string): { kind: string; fields: string[] } | null {
  const match = /^([A-Z]+):(.*)$/.exec(line.trim());
  if (!match) return null;
  return { kind: match[1]!, fields: splitFields(match[2]!) };
}

// Drive states reported in DRV lines.
export const DRIVE_INSERTED = 2;

export interface Drive {
  index: number;
  state: number;
  driveName: string;
  discName: string;
  device: string;
}

export function parseDrives(output: string): Drive[] {
  const drives: Drive[] = [];
  for (const line of output.split(/\r?\n/)) {
    const rec = parseLine(line);
    if (!rec || rec.kind !== 'DRV') continue;
    const [index, state, , , driveName = '', discName = '', device = ''] = rec.fields;
    const st = Number(state);
    if (st === 256) continue; // no drive in this slot
    drives.push({ index: Number(index), state: st, driveName, discName, device });
  }
  return drives;
}

// Attribute ids (ap_ItemAttributeId).
const ATTR_NAME = 2;
const ATTR_CHAPTERS = 8;
const ATTR_DURATION = 9;
const ATTR_SIZE_BYTES = 11;
const ATTR_SEGMENTS_MAP = 26;
const ATTR_OUTPUT_FILE = 27;
const ATTR_VOLUME_NAME = 32;

export interface DiscTitle {
  index: number;
  name: string;
  durationSeconds: number;
  sizeBytes: number;
  chapters: number;
  segments: string;
  outputFile: string;
}

export interface DiscInfo {
  name: string;
  volumeName: string;
  titles: DiscTitle[];
}

export function parseDuration(value: string): number {
  const parts = value.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

export function parseDiscInfo(output: string): DiscInfo {
  const info: DiscInfo = { name: '', volumeName: '', titles: [] };
  const titles = new Map<number, DiscTitle>();
  for (const line of output.split(/\r?\n/)) {
    const rec = parseLine(line);
    if (!rec) continue;
    if (rec.kind === 'CINFO') {
      const [id, , value = ''] = rec.fields;
      if (Number(id) === ATTR_NAME) info.name = value;
      if (Number(id) === ATTR_VOLUME_NAME) info.volumeName = value;
    } else if (rec.kind === 'TINFO') {
      const [t, id, , value = ''] = rec.fields;
      const index = Number(t);
      let title = titles.get(index);
      if (!title) {
        title = {
          index,
          name: '',
          durationSeconds: 0,
          sizeBytes: 0,
          chapters: 0,
          segments: '',
          outputFile: '',
        };
        titles.set(index, title);
      }
      switch (Number(id)) {
        case ATTR_NAME:
          title.name = value;
          break;
        case ATTR_CHAPTERS:
          title.chapters = Number(value) || 0;
          break;
        case ATTR_DURATION:
          title.durationSeconds = parseDuration(value);
          break;
        case ATTR_SIZE_BYTES:
          title.sizeBytes = Number(value) || 0;
          break;
        case ATTR_SEGMENTS_MAP:
          title.segments = value;
          break;
        case ATTR_OUTPUT_FILE:
          title.outputFile = value;
          break;
      }
    }
  }
  info.titles = [...titles.values()].sort((a, b) => a.index - b.index);
  return info;
}

export type TitleChoice =
  | { kind: 'main'; title: DiscTitle }
  | { kind: 'ambiguous'; reason: string; candidates: DiscTitle[] };

/**
 * Pick the main feature: the longest title. Ask for help instead of guessing
 * when the disc has no feature-length title, or when it has many titles of
 * nearly the same length (a common copy-protection trick).
 */
export function chooseMainTitle(titles: DiscTitle[], minMinutes = 40): TitleChoice {
  const byLength = [...titles].sort(
    (a, b) => b.durationSeconds - a.durationSeconds || b.sizeBytes - a.sizeBytes,
  );
  const longest = byLength[0];
  if (!longest || longest.durationSeconds < minMinutes * 60) {
    return {
      kind: 'ambiguous',
      reason: `No title on this disc is longer than ${minMinutes} minutes.`,
      candidates: byLength.slice(0, 12),
    };
  }
  const similar = byLength.filter((t) => longest.durationSeconds - t.durationSeconds <= 60);
  // Titles that play exactly the same segments are the same cut (e.g. with another angle).
  const distinct = new Set(similar.map((t) => t.segments || `#${t.index}`));
  if (distinct.size >= 4) {
    return {
      kind: 'ambiguous',
      reason: `This disc has ${distinct.size} versions of the movie that are almost the same length — usually copy protection. Pick the right one.`,
      candidates: similar.slice(0, 20),
    };
  }
  return { kind: 'main', title: longest };
}

/** Progress from PRGV lines: current/max as a 0–1 fraction. */
export function parseProgress(line: string): number | null {
  const rec = parseLine(line);
  if (!rec || rec.kind !== 'PRGV') return null;
  const [, total, max] = rec.fields.map(Number);
  if (!max || !Number.isFinite(total!)) return null;
  return Math.max(0, Math.min(1, total! / max));
}

/** Human-readable error messages from MSG lines, for diagnostics. */
export function parseMessages(output: string): string[] {
  const messages: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const rec = parseLine(line);
    if (rec?.kind === 'MSG' && rec.fields[3]) messages.push(rec.fields[3]);
  }
  return messages;
}
