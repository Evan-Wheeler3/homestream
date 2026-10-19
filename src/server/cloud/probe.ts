// What's inside a video file, from `HandBrakeCLI --scan` (its log includes the
// ffmpeg-style stream list), and whether a browser can play it as it is.
import type { MediaInfo } from '../../shared/types.js';
import type { Runner } from '../ripper/process.js';

export interface ProbeResult {
  container: string | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  audioCodecs: string[];
  audioLanguages: (string | null)[];
  audioChannels: (number | null)[];
  durationSeconds: number | null;
}

export function parseScan(output: string): ProbeResult {
  const container = /Input #0, ([\w,]+), from/.exec(output)?.[1] ?? null;
  const video =
    /Stream #0:\d+(?:\[[^\]]*\])?(?:\((\w+)\))?: Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(
      output,
    );
  const audio = [
    ...output.matchAll(
      /Stream #0:\d+(?:\[[^\]]*\])?(?:\((\w+)\))?: Audio: (\w+)[^\n]*?(?:, (mono|stereo|5\.1(?:\(side\))?|7\.1|\d+ channels),|\n|$)/g,
    ),
  ];
  const duration = /\+ duration: (\d+):(\d{2}):(\d{2})/.exec(output);
  const channels = (layout: string | undefined) =>
    layout === 'mono'
      ? 1
      : layout === 'stereo'
        ? 2
        : layout?.startsWith('5.1')
          ? 6
          : layout === '7.1'
            ? 8
            : layout
              ? Number.parseInt(layout) || null
              : null;
  return {
    container,
    videoCodec: video?.[2] ?? null,
    width: video ? Number(video[3]) : null,
    height: video ? Number(video[4]) : null,
    audioCodecs: audio.map((a) => a[2]!),
    audioLanguages: audio.map((a) => (a[1] && a[1] !== 'und' ? a[1] : null)),
    audioChannels: audio.map((a) => channels(a[3])),
    durationSeconds: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : null,
  };
}

/** H.264 video with AAC (or MP3) audio in an MP4: plays in every browser and TV. */
export function isBrowserPlayable(p: ProbeResult): boolean {
  return (
    Boolean(p.container?.includes('mp4')) &&
    p.videoCodec === 'h264' &&
    p.audioCodecs.length > 0 &&
    ['aac', 'mp3'].includes(p.audioCodecs[0]!)
  );
}

export async function probe(run: Runner, handbrakeCli: string, file: string): Promise<ProbeResult> {
  const result = await run(handbrakeCli, ['--scan', '--title', '1', '-i', file]);
  return parseScan(result.output);
}

export function mediaInfo(p: ProbeResult, sizeBytes: number): MediaInfo {
  return {
    container: p.container?.includes('mp4') ? 'mp4' : p.container,
    videoCodec: p.videoCodec,
    width: p.width,
    height: p.height,
    sizeBytes,
    bitrate: p.durationSeconds ? Math.round((sizeBytes * 8) / p.durationSeconds) : null,
    audioTracks: p.audioCodecs.slice(0, 1).map((codec, i) => ({
      index: i,
      language: p.audioLanguages[i] ?? null,
      title: [
        codec.toUpperCase(),
        p.audioChannels[i] === 2 ? 'Stereo' : p.audioChannels[i] === 6 ? '5.1' : null,
      ]
        .filter(Boolean)
        .join(' '),
      codec,
      isDefault: true,
      channels: p.audioChannels[i] ?? null,
    })),
    subtitleTracks: [],
  };
}
