// The movie on a theater screen. Everyone streams their own copy (as in the
// normal player) and keeps it in step with the showing (see follow.ts).
import type Hls from 'hls.js';
import { countdownLeft, positionAt, type Showing } from '../../shared/theater';
import type { PlaybackInfo, PlaybackReport } from '../../shared/types';
import { api, ApiError, errorMessage } from '../lib/api';
import { detectCapabilities } from '../lib/capabilities';
import { recordError } from '../lib/diagnostics';
import { Follower } from './follow';

export interface ScreenHooks {
  onReady(video: HTMLVideoElement): void;
  onError(message: string): void;
  /** The browser wouldn't play sound without a tap; it's playing muted. */
  onNeedsTap(): void;
  onEnded(): void;
}

function report(event: 'start' | 'progress' | 'stop', body: PlaybackReport) {
  return api(`/playback/${event}`, { method: 'POST', body, keepalive: event === 'stop' }).catch(
    (error: unknown) => recordError(`Theater ${event} report failed: ${errorMessage(error)}`),
  );
}

export class ScreenPlayer {
  readonly video: HTMLVideoElement;
  private info: PlaybackInfo | null = null;
  private hls: Hls | null = null;
  private started = false;
  private progressTimer = 0;
  private disposed = false;
  private wantPlaying = false;
  private readonly follower = new Follower();

  constructor(
    readonly movieId: string,
    host: HTMLElement,
    private readonly hooks: ScreenHooks,
  ) {
    const v = document.createElement('video');
    v.className = 'theater__video';
    v.playsInline = true;
    v.preload = 'auto';
    v.setAttribute('playsinline', '');
    v.setAttribute('x-webkit-airplay', 'allow');
    v.addEventListener('ended', () => this.hooks.onEnded());
    v.addEventListener('error', () => {
      if (this.disposed || !v.getAttribute('src')) return;
      this.hooks.onError('This movie couldn’t be played on this device.');
    });
    v.addEventListener('loadedmetadata', () => this.hooks.onReady(v), { once: true });
    host.appendChild(v);
    this.video = v;
  }

  async load(startSeconds: number) {
    try {
      this.info = await api<PlaybackInfo>(`/movies/${encodeURIComponent(this.movieId)}/playback`, {
        method: 'POST',
        body: { capabilities: detectCapabilities(), startSeconds },
      });
    } catch (error) {
      if (!this.disposed) {
        this.hooks.onError(
          error instanceof ApiError ? error.message : 'This movie couldn’t be started.',
        );
      }
      return;
    }
    if (this.disposed) return;
    const info = this.info;
    const v = this.video;
    for (const s of info.subtitles) {
      if (!s.url) continue;
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = s.title;
      track.srclang = s.language ?? 'und';
      track.src = s.url;
      v.appendChild(track);
    }
    if (info.delivery === 'hls' && v.canPlayType('application/vnd.apple.mpegurl') === '') {
      const { default: HlsClass } = await import('hls.js');
      if (this.disposed) return;
      if (!HlsClass.isSupported()) {
        this.hooks.onError('This browser can’t play this stream.');
        return;
      }
      const hls = new HlsClass({ startPosition: startSeconds, maxBufferLength: 30 });
      hls.on(HlsClass.Events.ERROR, (_e, data) => {
        if (data.fatal) this.hooks.onError('The stream stopped. Try sitting down again.');
      });
      hls.loadSource(info.url);
      hls.attachMedia(v);
      this.hls = hls;
    } else {
      v.src = info.url;
      v.addEventListener(
        'loadedmetadata',
        () => {
          if (startSeconds > 0) v.currentTime = startSeconds;
        },
        { once: true },
      );
      v.load();
    }
  }

  get hasSubtitles() {
    return this.video.textTracks.length > 0;
  }

  setVolume(volume: number, muted: boolean) {
    this.video.volume = volume;
    this.video.muted = muted;
  }

  setCaptions(on: boolean) {
    const tracks = this.video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i]!.mode = on && i === 0 ? 'hidden' : 'disabled';
    }
  }

  /** The caption line showing now, if captions are on. */
  caption(): string {
    const track = this.video.textTracks[0];
    if (!track || track.mode === 'disabled' || !track.activeCues) return '';
    return [...track.activeCues].map((c) => (c as VTTCue).text.replace(/<[^>]+>/g, '')).join('\n');
  }

  /** Lets sound play later: call from a tap or key press. */
  unlock() {
    const v = this.video;
    v.muted = false;
    if (v.readyState > 0 && v.paused) {
      void v
        .play()
        .then(() => {
          if (!this.wantPlaying) v.pause();
        })
        .catch(() => undefined);
    }
  }

  /** Follows the showing: play, pause, and stay within a fraction of a second. */
  sync(showing: Showing, now: number) {
    const v = this.video;
    if (!this.info || v.readyState < 1) return;
    const target = positionAt(showing, now);
    const playing = showing.status === 'playing' && countdownLeft(showing, now) === 0;
    this.wantPlaying = playing;
    if (!playing) {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - target) > 0.5 && !v.seeking) v.currentTime = target;
      this.setRate(1);
      this.follower.reset();
      return;
    }
    const ready = v.readyState >= 3 && !v.seeking;
    const step = this.follower.step(target - v.currentTime, ready, now);
    if (step.jumpAhead !== undefined) v.currentTime = target + step.jumpAhead;
    this.setRate(step.rate);
    if (v.paused && !v.ended) {
      v.play().then(
        () => this.reportStart(),
        (error: unknown) => {
          if (error instanceof DOMException && error.name === 'NotAllowedError' && !v.muted) {
            v.muted = true;
            this.hooks.onNeedsTap();
            void v.play().then(
              () => this.reportStart(),
              () => undefined,
            );
          }
        },
      );
    }
  }

  /** Changing the speed is audible, even to the same value on some browsers: only when it changes. */
  private setRate(rate: number) {
    if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
  }

  private body(): PlaybackReport | null {
    const i = this.info;
    if (!i) return null;
    return {
      itemId: i.itemId,
      mediaSourceId: i.mediaSourceId,
      playSessionId: i.playSessionId,
      positionSeconds: this.video.currentTime,
      isPaused: this.video.paused,
      method: i.method,
      audioStreamIndex: i.selectedAudioIndex,
      subtitleStreamIndex: null,
    };
  }

  private reportStart() {
    if (this.started || this.disposed) return;
    const body = this.body();
    if (!body) return;
    this.started = true;
    void report('start', body);
    this.progressTimer = window.setInterval(() => {
      const b = this.body();
      if (b) void report('progress', b);
    }, 10_000);
  }

  fullscreen() {
    const v = this.video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (v.requestFullscreen) {
      void v.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
    } else {
      v.webkitEnterFullscreen?.();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.clearInterval(this.progressTimer);
    if (this.started) {
      const body = this.body();
      if (body) void report('stop', { ...body, isPaused: true });
    }
    this.hls?.destroy();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
  }
}
