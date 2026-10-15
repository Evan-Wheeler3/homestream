/** Parsing for HandBrakeCLI output. */

/** "Encoding: task 1 of 1, 45.67 % (…)" → 0.4567 */
export function parseEncodeProgress(line: string): number | null {
  const match = /Encoding: task (\d+) of (\d+), ([\d.]+) ?%/.exec(line);
  if (!match) return null;
  const task = Number(match[1]);
  const tasks = Number(match[2]) || 1;
  const pct = Number(match[3]) / 100;
  return Math.max(0, Math.min(1, (task - 1 + pct) / tasks));
}

/** Duration of the first title from `HandBrakeCLI --scan` output ("+ duration: 01:45:12"). */
export function parseScanDuration(output: string): number | null {
  const match = /\+ duration: (\d+):(\d{2}):(\d{2})/.exec(output);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function encodeArgs(
  input: string,
  output: string,
  preset: string,
  quality: number,
  subtitleLanguages: string[] = [],
) {
  // DVD subtitles are kept as tracks you can switch on, never burned into the picture.
  const subtitles = subtitleLanguages.length
    ? [
        '--subtitle-lang-list',
        subtitleLanguages.join(','),
        '--all-subtitles',
        '--subtitle-default=none',
      ]
    : [];
  return [
    '-i',
    input,
    '-o',
    output,
    '--preset',
    preset,
    '--quality',
    String(quality),
    '--format',
    'av_mp4',
    // Put the index at the start of the file so playback can begin before it is all read.
    '--optimize',
    ...subtitles,
  ];
}
