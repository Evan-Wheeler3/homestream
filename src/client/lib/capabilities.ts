import type { ClientCapabilities } from '../../shared/types';

let cached: ClientCapabilities | null = null;

/**
 * Detect what this browser can decode so Jellyfin can choose direct play when
 * possible and transcode only when necessary.
 */
export function detectCapabilities(): ClientCapabilities {
  if (cached) return cached;
  const video = document.createElement('video');
  const can = (type: string) => {
    try {
      return (
        video.canPlayType(type) !== '' ||
        (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type))
      );
    } catch {
      return false;
    }
  };
  const mp4VideoCodecs: string[] = [];
  if (can('video/mp4; codecs="avc1.640029"')) mp4VideoCodecs.push('h264');
  if (can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"')) {
    mp4VideoCodecs.push('hevc');
  }
  if (can('video/mp4; codecs="av01.0.08M.08"')) mp4VideoCodecs.push('av1');
  const webmVideoCodecs: string[] = [];
  if (can('video/webm; codecs="vp9"')) webmVideoCodecs.push('vp9');
  if (can('video/webm; codecs="vp8"')) webmVideoCodecs.push('vp8');
  if (can('video/webm; codecs="av01.0.08M.08"')) webmVideoCodecs.push('av1');
  const audioCodecs: string[] = [];
  if (can('audio/mp4; codecs="mp4a.40.2"')) audioCodecs.push('aac');
  if (can('audio/mpeg')) audioCodecs.push('mp3');
  if (can('audio/webm; codecs="opus"') || can('audio/mp4; codecs="opus"')) audioCodecs.push('opus');
  if (can('audio/flac') || can('audio/mp4; codecs="flac"')) audioCodecs.push('flac');
  if (can('audio/webm; codecs="vorbis"')) audioCodecs.push('vorbis');
  if (can('audio/mp4; codecs="ac-3"')) audioCodecs.push('ac3');
  if (can('audio/mp4; codecs="ec-3"')) audioCodecs.push('eac3');
  cached = {
    mp4VideoCodecs,
    webmVideoCodecs,
    audioCodecs,
    nativeHls: video.canPlayType('application/vnd.apple.mpegurl') !== '',
    mse: typeof MediaSource !== 'undefined',
    maxAudioChannels: 2,
  };
  return cached;
}
