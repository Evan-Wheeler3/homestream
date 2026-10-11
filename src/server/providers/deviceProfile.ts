import type { ClientCapabilities } from '../../shared/types.js';

const KNOWN_VIDEO = new Set(['h264', 'hevc', 'av1', 'vp8', 'vp9']);
const KNOWN_AUDIO = new Set(['aac', 'mp3', 'opus', 'flac', 'vorbis', 'ac3', 'eac3', 'alac']);

/** Accept only known codec names from the (untrusted) browser capability report. */
export function sanitizeCapabilities(input: unknown): ClientCapabilities {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const list = (value: unknown, allowed: Set<string>) =>
    Array.isArray(value) ? [...new Set(value.map(String).filter((v) => allowed.has(v)))] : [];
  const mp4 = list(raw.mp4VideoCodecs, KNOWN_VIDEO);
  const audio = list(raw.audioCodecs, KNOWN_AUDIO);
  const channels = Number(raw.maxAudioChannels);
  return {
    // Every browser we target plays H.264 + AAC; fall back to that if detection failed.
    mp4VideoCodecs: mp4.length ? mp4 : ['h264'],
    webmVideoCodecs: list(raw.webmVideoCodecs, KNOWN_VIDEO),
    audioCodecs: audio.length ? audio : ['aac', 'mp3'],
    nativeHls: Boolean(raw.nativeHls),
    mse: Boolean(raw.mse),
    maxAudioChannels: Number.isFinite(channels) && channels >= 1 ? Math.min(8, channels) : 2,
  };
}

/**
 * Build a Jellyfin DeviceProfile describing what this browser can play.
 * Jellyfin uses it to decide between direct play, remuxing (direct stream) and
 * transcoding. The transcode target is HLS with H.264 + AAC, which every target
 * browser can play (natively on Safari/iOS, via hls.js + MSE elsewhere).
 */
export function buildDeviceProfile(caps: ClientCapabilities, maxBitrate: number | null) {
  const bitrate = maxBitrate ?? 120_000_000;
  const mp4Audio = caps.audioCodecs.filter((c) =>
    ['aac', 'mp3', 'flac', 'opus', 'ac3', 'eac3', 'alac'].includes(c),
  );
  const webmAudio = caps.audioCodecs.filter((c) => ['opus', 'vorbis'].includes(c));
  const hlsVideo = caps.mp4VideoCodecs.includes('hevc') && caps.nativeHls ? 'h264,hevc' : 'h264';

  const directPlay: Record<string, unknown>[] = [
    {
      Container: 'mp4,m4v,mov',
      Type: 'Video',
      VideoCodec: caps.mp4VideoCodecs.join(','),
      AudioCodec: mp4Audio.join(','),
    },
  ];
  if (caps.webmVideoCodecs.length && webmAudio.length) {
    directPlay.push({
      Container: 'webm',
      Type: 'Video',
      VideoCodec: caps.webmVideoCodecs.join(','),
      AudioCodec: webmAudio.join(','),
    });
  }

  return {
    Name: 'Private Cinema Web',
    MaxStreamingBitrate: bitrate,
    MaxStaticBitrate: bitrate,
    MusicStreamingTranscodingBitrate: 384_000,
    DirectPlayProfiles: directPlay,
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        VideoCodec: hlsVideo,
        AudioCodec: caps.audioCodecs.includes('mp3') ? 'aac,mp3' : 'aac',
        Protocol: 'hls',
        Context: 'Streaming',
        MaxAudioChannels: String(caps.maxAudioChannels),
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      {
        Type: 'Video',
        Codec: 'h264',
        Conditions: [
          // Browsers cannot decode 10-bit H.264 (Hi10P); force a transcode for it.
          { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false },
        ],
      },
      {
        Type: 'VideoAudio',
        Conditions: [
          {
            Condition: 'LessThanEqual',
            Property: 'AudioChannels',
            Value: String(caps.maxAudioChannels),
            IsRequired: false,
          },
        ],
      },
    ],
    SubtitleProfiles: [
      ...['vtt', 'webvtt', 'srt', 'subrip', 'ass', 'ssa', 'mov_text'].map((Format) => ({
        Format,
        Method: 'External',
      })),
      ...['pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub'].map((Format) => ({
        Format,
        Method: 'Encode',
      })),
    ],
  };
}

export const IMAGE_SUBTITLE_CODECS = new Set(['pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub', 'dvb_subtitle', 'hdmv_pgs_subtitle', 'dvd_subtitle']);
