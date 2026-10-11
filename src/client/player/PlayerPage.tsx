import { useQueryClient } from '@tanstack/react-query';
import type Hls from 'hls.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { PlaybackInfo, PlaybackReport, Preferences } from '../../shared/types';
import { Icon } from '../components/Icon';
import { Button, IconButton, Spinner } from '../components/ui';
import { api, ApiError, errorMessage } from '../lib/api';
import { detectCapabilities } from '../lib/capabilities';
import { recordError } from '../lib/diagnostics';
import { formatClock, languageName } from '../lib/format';
import { sizedImage } from '../lib/images';
import { useMovie } from '../lib/queries';

interface StartOptions {
  startSeconds: number;
  mediaSourceId?: string | null;
  audioStreamIndex?: number | null;
  subtitleStreamIndex?: number | null;
  forceTranscode?: boolean;
}

const PROGRESS_INTERVAL_MS = 10_000;
const HIDE_CONTROLS_MS = 3000;
/** Generous: a slow server may need a while to produce the first transcoded segment. */
const STARTUP_TIMEOUT_MS = 45_000;

const METHOD_LABEL: Record<PlaybackInfo['method'], string> = {
  DirectPlay: 'Direct play',
  DirectStream: 'Direct stream (remux)',
  Transcode: 'Transcoding',
};

function report(event: 'start' | 'progress' | 'stop', body: PlaybackReport) {
  return api(`/playback/${event}`, { method: 'POST', body, keepalive: event === 'stop' }).catch(
    (error) => {
      recordError(`Playback ${event} report failed: ${errorMessage(error)}`);
    },
  );
}

export default function PlayerPage({ prefs }: { prefs: Preferences }) {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const movie = useMovie(id);

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const infoRef = useRef<PlaybackInfo | null>(null);
  const startedRef = useRef(false);
  const fallbackTriedRef = useRef(false);
  const hideTimer = useRef<number | undefined>(undefined);

  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [menu, setMenu] = useState<null | 'subtitles' | 'audio'>(null);
  // The user's subtitle choice for the current play session (null entry = use default).
  const [trackChoice, setTrackChoice] = useState<{ session: string; index: number | null } | null>(
    null,
  );

  // Last known playback position. Kept in a ref because React detaches element refs
  // before effect cleanups run, so the <video> is gone when the stop report is sent.
  const positionRef = useRef(0);

  const reportBody = useCallback((paused: boolean): PlaybackReport | null => {
    const i = infoRef.current;
    if (!i) return null;
    const position = videoRef.current?.currentTime ?? positionRef.current;
    return {
      itemId: i.itemId,
      mediaSourceId: i.mediaSourceId,
      playSessionId: i.playSessionId,
      positionSeconds: position,
      isPaused: paused,
      method: i.method,
      audioStreamIndex: i.selectedAudioIndex,
      subtitleStreamIndex: i.selectedSubtitleIndex,
    };
  }, []);

  const stopReport = useCallback((): Promise<unknown> => {
    if (!startedRef.current) return Promise.resolve();
    const body = reportBody(true);
    startedRef.current = false;
    return body ? report('stop', body) : Promise.resolve();
  }, [reportBody]);

  // ---------------------------------------------------------------------------
  // Negotiate a stream with the server

  const start = useCallback(
    async (options: StartOptions) => {
      void stopReport();
      setLoading(true);
      setError(null);
      setNeedsTap(false);
      try {
        const next = await api<PlaybackInfo>(`/movies/${id}/playback`, {
          method: 'POST',
          body: { capabilities: detectCapabilities(), ...options },
        });
        infoRef.current = next;
        setInfo(next);
      } catch (err) {
        const message =
          err instanceof ApiError && err.code === 'MEDIA_SERVER_UNREACHABLE'
            ? 'Jellyfin is not responding, so this movie can’t be played right now.'
            : errorMessage(err);
        recordError(`Playback negotiation failed: ${message}`);
        setError(message);
        setLoading(false);
      }
    },
    [id, stopReport],
  );

  useEffect(() => {
    const t = Number(params.get('t') ?? 0);
    fallbackTriedRef.current = false;
    // Kick off stream negotiation for this movie (async; state updates follow the request).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void start({ startSeconds: Number.isFinite(t) ? t : 0 });
    // Only on first mount / movie change; `t` is the initial position only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ---------------------------------------------------------------------------
  // Attach the stream to the <video> element

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !info) return;
    let cancelled = false;
    hlsRef.current?.destroy();
    hlsRef.current = null;

    const play = () => {
      video.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotAllowedError') setNeedsTap(true);
      });
    };

    const useHlsJs =
      info.delivery === 'hls' && video.canPlayType('application/vnd.apple.mpegurl') === '';
    if (useHlsJs) {
      void import('hls.js').then(({ default: HlsClass }) => {
        if (cancelled) return;
        if (!HlsClass.isSupported()) {
          setError('This browser cannot play adaptive (HLS) streams.');
          setLoading(false);
          return;
        }
        const hls = new HlsClass({
          startPosition: info.startSeconds,
          maxBufferLength: 30,
          backBufferLength: 60,
        });
        let recovered = false;
        hls.on(HlsClass.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          recordError(`HLS ${data.type}: ${data.details}`);
          const codecProblem =
            data.details === HlsClass.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR ||
            data.details === HlsClass.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR ||
            data.details === HlsClass.ErrorDetails.BUFFER_ADD_CODEC_ERROR;
          if (codecProblem) {
            // Retrying cannot help: the browser lacks a decoder for the stream.
            setError('This browser cannot decode the video format Jellyfin produced (H.264/AAC).');
            setLoading(false);
          } else if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR && !recovered) {
            recovered = true;
            hls.recoverMediaError();
          } else if (data.type === HlsClass.ErrorTypes.NETWORK_ERROR && !recovered) {
            recovered = true;
            hls.startLoad();
          } else {
            setError(
              data.type === HlsClass.ErrorTypes.NETWORK_ERROR
                ? 'The stream stopped responding. Jellyfin may be busy converting this file or may have gone offline.'
                : 'This stream could not be decoded on this device.',
            );
            setLoading(false);
          }
        });
        hls.on(HlsClass.Events.MANIFEST_PARSED, play);
        hls.loadSource(info.url);
        hls.attachMedia(video);
        hlsRef.current = hls;
      });
    } else {
      video.src = info.url;
      const onMeta = () => {
        if (info.startSeconds > 0 && Math.abs(video.currentTime - info.startSeconds) > 1) {
          video.currentTime = info.startSeconds;
        }
        play();
      };
      video.addEventListener('loadedmetadata', onMeta, { once: true });
      video.load();
    }

    // Watchdog: never leave the viewer looking at a spinner forever.
    const watchdog = window.setTimeout(() => {
      if (!cancelled && video.readyState === 0 && !video.error) {
        recordError(`Stream did not start within ${STARTUP_TIMEOUT_MS / 1000}s (${info.method})`);
        setError(
          'The stream did not start. Jellyfin may still be preparing it, or it may be unreachable. Try again in a moment.',
        );
        setLoading(false);
      }
    }, STARTUP_TIMEOUT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(watchdog);
    };
  }, [info]);

  // Tear down on leave: stop reporting, release the stream.
  useEffect(() => {
    const video = videoRef.current;
    const onPageHide = () => void stopReport();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      const stopped = stopReport();
      hlsRef.current?.destroy();
      if (video) {
        video.removeAttribute('src');
        video.load();
      }
      // Watch state changes once Jellyfin has processed the stop; refresh views after that.
      void stopped.finally(() => {
        void qc.invalidateQueries({ queryKey: ['movie', id] });
        void qc.invalidateQueries({ queryKey: ['home'] });
        void qc.invalidateQueries({ queryKey: ['movies'] });
        void qc.invalidateQueries({ queryKey: ['collection'] });
      });
    };
  }, [stopReport, qc, id]);

  // ---------------------------------------------------------------------------
  // Subtitles (text tracks are rendered by the browser; image ones are burned in)

  const defaultTextTrack = useMemo(() => {
    if (!info) return null;
    const preferred = prefs.playback.subtitleLanguage;
    const textSubs = info.subtitles.filter((s) => s.url);
    const initial =
      (info.selectedSubtitleIndex != null &&
        textSubs.find((s) => s.index === info.selectedSubtitleIndex)) ||
      (preferred && textSubs.find((s) => s.language === preferred)) ||
      textSubs.find((s) => s.isForced) ||
      null;
    return initial ? initial.index : null;
  }, [info, prefs.playback.subtitleLanguage]);
  const textTrack =
    info && trackChoice?.session === info.playSessionId ? trackChoice.index : defaultTextTrack;
  const setTextTrack = useCallback((index: number | null) => {
    if (infoRef.current) setTrackChoice({ session: infoRef.current.playSessionId, index });
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !info) return;
    const apply = () => {
      const tracks = Array.from(video.textTracks);
      tracks.forEach((track) => {
        track.mode = track.id === `sub-${textTrack}` ? 'showing' : 'disabled';
      });
    };
    apply();
    video.textTracks.addEventListener?.('addtrack', apply);
    return () => video.textTracks.removeEventListener?.('addtrack', apply);
  }, [textTrack, info]);

  // ---------------------------------------------------------------------------
  // Video element events

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let progressTimer: number | undefined;
    const onPlaying = () => {
      setPlaying(true);
      setWaiting(false);
      setLoading(false);
      setNeedsTap(false);
      const body = reportBody(false);
      if (!startedRef.current && body) {
        startedRef.current = true;
        void report('start', body);
      }
      window.clearInterval(progressTimer);
      progressTimer = window.setInterval(() => {
        const b = reportBody(video.paused);
        if (b && startedRef.current) void report('progress', b);
      }, PROGRESS_INTERVAL_MS);
    };
    const onPause = () => {
      setPlaying(false);
      window.clearInterval(progressTimer);
      const body = reportBody(true);
      if (body && startedRef.current) void report('progress', body);
    };
    const onTime = () => {
      positionRef.current = video.currentTime;
      setCurrent(video.currentTime);
      if (video.buffered.length) setBuffered(video.buffered.end(video.buffered.length - 1));
    };
    const onDuration = () => {
      if (Number.isFinite(video.duration)) setDuration(video.duration);
    };
    const onWaiting = () => setWaiting(true);
    const onCanPlay = () => {
      setWaiting(false);
      setLoading(false);
    };
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const onEnded = () => {
      setPlaying(false);
      void stopReport();
    };
    const onError = () => {
      const i = infoRef.current;
      const code = video.error?.code;
      if (!i || code == null || code === MediaError.MEDIA_ERR_ABORTED) return;
      recordError(`Video element error ${code}: ${video.error?.message ?? ''} (${i.method})`);
      // The browser could not play the original file: ask Jellyfin for a compatible stream.
      if (i.method === 'DirectPlay' && !fallbackTriedRef.current && !i.isSample) {
        fallbackTriedRef.current = true;
        void start({ startSeconds: video.currentTime || i.startSeconds, forceTranscode: true });
        return;
      }
      setError(
        code === MediaError.MEDIA_ERR_NETWORK
          ? 'The connection to the server was lost while playing.'
          : 'This video could not be played on this device.',
      );
      setLoading(false);
    };
    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('progress', onTime);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    return () => {
      window.clearInterval(progressTimer);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('progress', onTime);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('volumechange', onVolume);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
    };
  }, [reportBody, start, stopReport]);

  // ---------------------------------------------------------------------------
  // Controls

  const totalDuration = duration || info?.durationSeconds || 0;

  const showControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setControlsVisible(false);
    }, HIDE_CONTROLS_MS);
  }, []);

  // Controls are always shown while paused (see className); when playback starts, hide
  // them after a moment of inactivity.
  useEffect(() => {
    if (!playing) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), HIDE_CONTROLS_MS);
    return () => window.clearTimeout(hideTimer.current);
  }, [playing]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setNeedsTap(true));
    else video.pause();
  }, []);

  const seekBy = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      const max = video.duration || totalDuration;
      video.currentTime = Math.max(
        0,
        Math.min(max ? max - 0.5 : Infinity, video.currentTime + delta),
      );
    },
    [totalDuration],
  );

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    const video = videoRef.current as
      (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (container?.requestFullscreen) {
      void container.requestFullscreen().catch(() => video?.webkitEnterFullscreen?.());
    } else {
      // iPhone Safari: only the video element itself can go fullscreen (native player).
      video?.webkitEnterFullscreen?.();
    }
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const goBack = useCallback(() => {
    if (location.key !== 'default') navigate(-1);
    else navigate(`/movie/${id}`, { replace: true });
  }, [location.key, navigate, id]);

  const cycleSubtitles = useCallback(() => {
    if (!info) return;
    const text = info.subtitles.filter((s) => s.url);
    if (text.length === 0) return;
    const idx = text.findIndex((s) => s.index === textTrack);
    const next = idx + 1 < text.length ? text[idx + 1]!.index : null;
    setTextTrack(next);
  }, [info, textTrack, setTextTrack]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range') return;
      let handled = true;
      switch (event.key) {
        case ' ':
        case 'k':
        case 'K':
          if (target.tagName === 'BUTTON' && event.key === ' ') {
            handled = false;
            break;
          }
          togglePlay();
          break;
        case 'ArrowLeft':
        case 'j':
          seekBy(-10);
          break;
        case 'ArrowRight':
        case 'l':
          seekBy(10);
          break;
        case 'ArrowUp':
          video.volume = Math.min(1, video.volume + 0.1);
          video.muted = false;
          break;
        case 'ArrowDown':
          video.volume = Math.max(0, video.volume - 0.1);
          break;
        case 'm':
        case 'M':
          video.muted = !video.muted;
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'c':
        case 'C':
          cycleSubtitles();
          break;
        case 'Escape':
          if (menu) setMenu(null);
          else if (!document.fullscreenElement) goBack();
          else handled = false;
          break;
        default:
          handled = false;
      }
      if (handled) {
        event.preventDefault();
        showControls();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, toggleFullscreen, cycleSubtitles, goBack, showControls, menu]);

  // Lock-screen / headset controls.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !movie.data) return;
    const m = movie.data;
    const art = m.images.backdrop ?? m.images.poster;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: m.title,
      artist: m.directors.join(', '),
      artwork: art ? [{ src: sizedImage(art, 512) ?? art, sizes: '512x512' }] : [],
    });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => void videoRef.current?.play()],
      ['pause', () => videoRef.current?.pause()],
      ['seekbackward', () => seekBy(-10)],
      ['seekforward', () => seekBy(30)],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        /* unsupported action */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
  }, [movie.data, seekBy]);

  // ---------------------------------------------------------------------------
  // Track switching

  const selectSubtitle = (index: number | null) => {
    setMenu(null);
    if (!info) return;
    const sub = index == null ? null : info.subtitles.find((s) => s.index === index);
    const burnedIn =
      info.selectedSubtitleIndex != null &&
      info.subtitles.find((s) => s.index === info.selectedSubtitleIndex)?.url == null;
    if (sub && !sub.url) {
      // Image-based subtitles must be burned in by Jellyfin: restart the stream.
      void start({
        startSeconds: videoRef.current?.currentTime ?? 0,
        mediaSourceId: info.mediaSourceId,
        audioStreamIndex: info.selectedAudioIndex,
        subtitleStreamIndex: sub.index,
        forceTranscode: true,
      });
      return;
    }
    if (burnedIn) {
      // Leave the burned-in stream; the new session starts with the chosen text track.
      void start({
        startSeconds: videoRef.current?.currentTime ?? 0,
        mediaSourceId: info.mediaSourceId,
        audioStreamIndex: info.selectedAudioIndex,
        subtitleStreamIndex: index,
      });
      return;
    }
    setTextTrack(index);
  };

  const selectAudio = (index: number) => {
    setMenu(null);
    if (!info || index === info.selectedAudioIndex) return;
    const defaultIndex =
      info.audioTracks.find((a) => a.isDefault)?.index ?? info.audioTracks[0]?.index;
    const burnedIn =
      info.selectedSubtitleIndex != null &&
      info.subtitles.find((s) => s.index === info.selectedSubtitleIndex)?.url == null;
    void start({
      startSeconds: videoRef.current?.currentTime ?? 0,
      mediaSourceId: info.mediaSourceId,
      audioStreamIndex: index,
      // Keep whatever subtitles are currently on screen.
      subtitleStreamIndex: burnedIn ? info.selectedSubtitleIndex : textTrack,
      // Browsers play only the default audio track of a file; others need a remux.
      forceTranscode: index !== defaultIndex,
    });
  };

  // ---------------------------------------------------------------------------

  const m = movie.data;
  const poster = m ? sizedImage(m.images.backdrop ?? m.images.poster, 1280) : undefined;
  const remaining = Math.max(0, totalDuration - current);

  return (
    <div
      ref={containerRef}
      className={`player ${controlsVisible || !playing ? 'player--controls' : ''}`}
      onMouseMove={showControls}
      onTouchStart={showControls}
    >
      <video
        ref={videoRef}
        className="player__video"
        playsInline
        preload="metadata"
        poster={poster}
        onClick={togglePlay}
      >
        {info?.subtitles
          .filter((s) => s.url)
          .map((s) => (
            <track
              key={`${info.playSessionId}-${s.index}`}
              id={`sub-${s.index}`}
              kind="subtitles"
              src={s.url!}
              srcLang={s.language ?? undefined}
              label={languageName(s.language) ?? s.title}
            />
          ))}
      </video>

      {(loading || waiting) && !error && (
        <div className="player__center" aria-live="polite">
          <Spinner size={44} label={loading ? 'Preparing stream' : 'Buffering'} />
          {loading && info?.method === 'Transcode' && (
            <p className="player__hint">Jellyfin is converting this file for your device…</p>
          )}
        </div>
      )}

      {needsTap && !error && (
        <button type="button" className="player__big-play" onClick={togglePlay} aria-label="Play">
          <Icon name="play" size={40} />
        </button>
      )}

      {error && (
        <div className="player__error" role="alert">
          <Icon name="alert" size={32} />
          <h2>Playback problem</h2>
          <p>{error}</p>
          <div className="button-row">
            <Button
              variant="primary"
              icon="refresh"
              onClick={() => {
                fallbackTriedRef.current = false;
                void start({
                  startSeconds: videoRef.current?.currentTime || info?.startSeconds || 0,
                  forceTranscode: info?.method === 'DirectPlay',
                });
              }}
            >
              Try again
            </Button>
            <Button variant="ghost" onClick={goBack}>
              Go back
            </Button>
          </div>
          <p className="faint">Details are recorded in Settings → Diagnostics.</p>
        </div>
      )}

      <div className="player__top">
        <IconButton icon="chevronLeft" label="Back" size={26} onClick={goBack} />
        <div className="player__title">
          <span>{m?.title ?? ''}</span>
          {info && (
            <span className="player__badges">
              {info.isSample && (
                <span className="badge badge--sample">Sample clip · mock playback</span>
              )}
              {!info.isSample && (
                <span className="badge" title={info.transcodeReasons.join(', ') || undefined}>
                  {METHOD_LABEL[info.method]}
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      <div className="player__bottom">
        <div className="player__timeline">
          <span className="player__time">{formatClock(current)}</span>
          <div className="seek">
            <div
              className="seek__buffer"
              style={{ width: totalDuration ? `${(buffered / totalDuration) * 100}%` : 0 }}
            />
            <input
              type="range"
              className="seek__input"
              min={0}
              max={totalDuration || 0}
              step={1}
              value={Math.min(current, totalDuration || current)}
              aria-label="Seek"
              aria-valuetext={`${formatClock(current)} of ${formatClock(totalDuration)}`}
              onChange={(e) => {
                const video = videoRef.current;
                if (video) video.currentTime = Number(e.target.value);
                setCurrent(Number(e.target.value));
              }}
              style={
                {
                  '--seek-pct': totalDuration ? `${(current / totalDuration) * 100}%` : '0%',
                } as React.CSSProperties
              }
            />
          </div>
          <span className="player__time">-{formatClock(remaining)}</span>
        </div>
        <div className="player__controls">
          <div className="player__group">
            <IconButton
              icon={playing ? 'pause' : 'play'}
              label={playing ? 'Pause (k)' : 'Play (k)'}
              size={28}
              onClick={togglePlay}
            />
            <IconButton
              icon="rewind"
              label="Back 10 seconds (←)"
              size={26}
              onClick={() => seekBy(-10)}
            />
            <IconButton
              icon="forward"
              label="Forward 30 seconds"
              size={26}
              onClick={() => seekBy(30)}
            />
            <div className="player__volume">
              <IconButton
                icon={muted || volume === 0 ? 'mute' : 'volume'}
                label={muted ? 'Unmute (m)' : 'Mute (m)'}
                size={24}
                onClick={() => {
                  const v = videoRef.current;
                  if (v) v.muted = !v.muted;
                }}
              />
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label="Volume"
                className="volume__input"
                onChange={(e) => {
                  const v = videoRef.current;
                  if (!v) return;
                  v.volume = Number(e.target.value);
                  v.muted = v.volume === 0;
                }}
              />
            </div>
          </div>
          <div className="player__group">
            {info && info.subtitles.length > 0 && (
              <div className="player__menu-anchor">
                <IconButton
                  icon="captions"
                  label="Subtitles (c)"
                  size={24}
                  pressed={
                    textTrack != null ||
                    (info.selectedSubtitleIndex != null &&
                      !info.subtitles.find((s) => s.index === info.selectedSubtitleIndex)?.url)
                  }
                  onClick={() => setMenu(menu === 'subtitles' ? null : 'subtitles')}
                  aria-haspopup="menu"
                  aria-expanded={menu === 'subtitles'}
                />
                {menu === 'subtitles' && (
                  <div className="player__menu" role="menu" aria-label="Subtitles">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={textTrack == null && info.selectedSubtitleIndex == null}
                      onClick={() => selectSubtitle(null)}
                    >
                      Off
                    </button>
                    {info.subtitles.map((s) => {
                      const active = s.url
                        ? textTrack === s.index
                        : info.selectedSubtitleIndex === s.index;
                      return (
                        <button
                          key={s.index}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => selectSubtitle(s.index)}
                        >
                          {languageName(s.language) ?? s.title}
                          {s.isForced ? ' (forced)' : ''}
                          {!s.url && <span className="faint"> · burned in</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {info && info.audioTracks.length > 1 && (
              <div className="player__menu-anchor">
                <IconButton
                  icon="audio"
                  label="Audio track"
                  size={24}
                  onClick={() => setMenu(menu === 'audio' ? null : 'audio')}
                  aria-haspopup="menu"
                  aria-expanded={menu === 'audio'}
                />
                {menu === 'audio' && (
                  <div className="player__menu" role="menu" aria-label="Audio">
                    {info.audioTracks.map((a) => (
                      <button
                        key={a.index}
                        type="button"
                        role="menuitemradio"
                        aria-checked={info.selectedAudioIndex === a.index}
                        onClick={() => selectAudio(a.index)}
                      >
                        {a.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <IconButton
              icon={fullscreen ? 'exitFullscreen' : 'fullscreen'}
              label="Full screen (f)"
              size={24}
              onClick={toggleFullscreen}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
