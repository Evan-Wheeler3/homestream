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

/**
 * A plain-English hint for MakeMKV's errors when it can't read a disc, or
 * an empty string when there's nothing useful to add.
 */
export function readErrorHint(messages: string): string {
  if (/UNRECOVERED READ ERROR|errors of type 'Read Error'|Scsi error/i.test(messages)) {
    return 'The drive couldn’t read part of this disc. Wipe the shiny side with a soft cloth from the centre outwards and press Retry. If it fails again, the disc is scratched or copy-protected in a way this drive can’t get past: try it on another drive, or another copy of the movie.';
  }
  if (/OS access mode|Failed to open disc/i.test(messages)) {
    return 'macOS is probably blocking access to the drive: in System Settings → Privacy & Security → Full Disk Access, turn on “node” (run  open -R "$(readlink -f "$(which node)")"  in Terminal to find it) and MakeMKV, restart Wheelhouse, then press Retry.';
  }
  if (/registration key|evaluation period|too old|has expired/i.test(messages)) {
    return 'MakeMKV needs a key: Blu-ray reading is free while MakeMKV is in beta, but the beta key changes every month or two. Get the current one from the MakeMKV forum (“MakeMKV is free while in beta”) and enter it in MakeMKV → Help → Register, or update MakeMKV, then press Retry.';
  }
  return '';
}

/** Progress from PRGV lines: current/max as a 0–1 fraction. */
export function parseProgress(line: string): number | null {
  const rec = parseLine(line);
  if (!rec || rec.kind !== 'PRGV') return null;
  const [, total, max] = rec.fields.map(Number);
  if (!max || !Number.isFinite(total!)) return null;
  return Math.max(0, Math.min(1, total! / max));
}

/** The name of the overall operation from PRGT lines, e.g. "Saving to MKV file". */
export function parseProgressTitle(line: string): string | null {
  const rec = parseLine(line);
  if (!rec || rec.kind !== 'PRGT') return null;
  return rec.fields[2] ?? null;
}

/** Whether MakeMKV is copying the movie (rather than opening or analysing the disc). */
export const isCopyPhase = (title: string) => /sav|copy|writ/i.test(title);

/** Human-readable error messages from MSG lines, for diagnostics. */
export function parseMessages(output: string): string[] {
  const messages: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const rec = parseLine(line);
    if (rec?.kind === 'MSG' && rec.fields[3]) messages.push(rec.fields[3]);
  }
  return messages;
}

export type DiscKind = { kind: 'movie' } | { kind: 'tv'; episodes: DiscTitle[] };

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(10, b * 0.015);

/** MakeMKV's segment map ("1,2,3" or "0-3,5") as a list of segment numbers. */
function segmentList(map: string): number[] {
  const out: number[] = [];
  for (const part of map.split(',')) {
    const [a, b] = part.split('-').map((n) => Number(n.trim()));
    if (!Number.isInteger(a)) continue;
    const end = Number.isInteger(b) && b! >= a! && b! - a! < 500 ? b! : a!;
    for (let n = a!; n <= end; n++) out.push(n);
  }
  return out;
}

/**
 * Whether a disc holds TV episodes rather than a movie, and which titles are the
 * episodes. A season disc has several titles of about the same episode length,
 * often with a "play all" title that is just those episodes back to back. A disc
 * with a long title that isn't a "play all" is a movie (extras are often
 * episode-length too, so they don't count) — unless the label says it's a
 * season (`tvHint`, e.g. "THE_OFFICE_S2_D1"), where a long title is a "play all"
 * or a bonus.
 */
export function classifyDisc(
  titles: DiscTitle[],
  options: {
    minEpisodeMinutes?: number;
    maxEpisodeMinutes?: number;
    movieMinutes?: number;
    tvHint?: boolean;
  } = {},
): DiscKind {
  const minEpisode = (options.minEpisodeMinutes ?? 15) * 60;
  const maxEpisode = (options.maxEpisodeMinutes ?? 70) * 60;
  const movie = (options.movieMinutes ?? 75) * 60;
  const byIndex = [...titles].sort((a, b) => a.index - b.index);

  // Titles that play exactly the same segments are one title (e.g. another angle).
  const seen = new Set<string>();
  const unique = byIndex.filter((t) => {
    if (!t.segments) return true;
    if (seen.has(t.segments)) return false;
    seen.add(t.segments);
    return true;
  });

  const inRange = unique.filter(
    (t) => t.durationSeconds >= minEpisode && t.durationSeconds <= maxEpisode,
  );
  /** Is `t` other titles played back to back? */
  const isPlayAll = (t: DiscTitle) => {
    const others = inRange.filter((o) => o !== t && o.durationSeconds < t.durationSeconds);
    // It plays the very same video as two or more of them.
    if (t.segments) {
      const mine = new Set(segmentList(t.segments));
      const inside = others.filter((o) => {
        const theirs = segmentList(o.segments);
        return theirs.length > 0 && theirs.every((n) => mine.has(n));
      });
      if (inside.length >= 2) return true;
    }
    // A run of 2+ consecutive titles adds up to it.
    for (let start = 0; start < others.length; start++) {
      let sum = 0;
      for (let end = start; end < others.length; end++) {
        sum += others[end]!.durationSeconds;
        if (end > start && close(t.durationSeconds, sum)) return true;
        if (sum > t.durationSeconds) break;
      }
    }
    // Or all of them together do, give or take the menus and credits in between.
    const all = others.reduce((sum, o) => sum + o.durationSeconds, 0);
    return others.length >= 2 && Math.abs(all - t.durationSeconds) <= t.durationSeconds * 0.04;
  };

  if (!options.tvHint && unique.some((t) => t.durationSeconds >= movie && !isPlayAll(t))) {
    return { kind: 'movie' };
  }

  const candidates = inRange.filter((t) => !isPlayAll(t));
  if (candidates.length < 2) return { kind: 'movie' };
  // Episodes run about the same length; shorter extras and longer specials don't.
  const lengths = candidates.map((t) => t.durationSeconds).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)]!;
  const episodes = candidates.filter(
    (t) => t.durationSeconds >= median * 0.7 && t.durationSeconds <= median * 1.4,
  );
  return episodes.length >= 2 ? { kind: 'tv', episodes } : { kind: 'movie' };
}
