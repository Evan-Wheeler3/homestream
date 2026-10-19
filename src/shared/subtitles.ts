// Subtitle text formats: SRT (what OCR tools and OpenSubtitles give us) to
// WebVTT (what browsers show), and a sanity check of the timing.

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function seconds(stamp: string): number | null {
  const m = TIME.exec(stamp);
  if (!m) return null;
  const [, h, min, s, ms] = m;
  return Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(ms!.padEnd(3, '0')) / 1000;
}

function stamp(total: number): string {
  const ms = Math.round(total * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Cues from SRT or WebVTT text (both use "start --> end" lines). */
export function parseCues(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timing = lines.findIndex((l) => l.includes('-->'));
    if (timing < 0) continue;
    const [from, to] = lines[timing]!.split('-->');
    const start = seconds(from ?? '');
    const end = seconds(to ?? '');
    if (start === null || end === null || end < start) continue;
    const body = lines
      .slice(timing + 1)
      .join('\n')
      .trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues;
}

/** Keeps the simple formatting browsers understand; drops SSA/ASS override tags. */
function cleanText(text: string): string {
  return text
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?font[^>]*>/gi, '')
    .replace(/&(?![a-z]+;|#\d+;)/gi, '&amp;');
}

/** WebVTT from SRT (or VTT), optionally shifted by `offsetSeconds`. */
export function toWebVtt(text: string, offsetSeconds = 0): string {
  const cues = parseCues(text);
  const out = ['WEBVTT', ''];
  for (const cue of cues) {
    const start = Math.max(0, cue.start + offsetSeconds);
    const end = Math.max(start, cue.end + offsetSeconds);
    out.push(`${stamp(start)} --> ${stamp(end)}`, cleanText(cue.text), '');
  }
  return out.join('\n');
}

export interface TimingCheck {
  ok: boolean;
  cues: number;
  firstSeconds: number | null;
  lastSeconds: number | null;
  reason: string | null;
}

/**
 * Whether subtitles plausibly belong to a movie of this length: enough cues,
 * starting reasonably early and ending before (but not long before) the end.
 * A file for another cut or frame rate usually ends well off the movie's end.
 */
export function checkTiming(text: string, durationSeconds: number | null): TimingCheck {
  const cues = parseCues(text);
  const firstSeconds = cues[0]?.start ?? null;
  const lastSeconds = cues.length ? Math.max(...cues.map((c) => c.end)) : null;
  const result = (ok: boolean, reason: string | null): TimingCheck => ({
    ok,
    cues: cues.length,
    firstSeconds,
    lastSeconds,
    reason,
  });
  if (cues.length < 20) return result(false, `Only ${cues.length} lines of dialogue.`);
  if (!durationSeconds) return result(true, null);
  if (lastSeconds! > durationSeconds + 90) {
    return result(false, 'The subtitles run past the end of the movie (a different cut?).');
  }
  if (lastSeconds! < durationSeconds * 0.6) {
    return result(false, 'The subtitles stop long before the movie ends (a different cut?).');
  }
  if (firstSeconds! > durationSeconds * 0.25) {
    return result(false, 'The subtitles start very late.');
  }
  return result(true, null);
}
