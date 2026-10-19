// Sending the video to a TV: AirPlay on Apple devices (Safari), and the Remote
// Playback API elsewhere (Chrome on Android casts to Chromecast this way).
import { useCallback, useEffect, useState, type RefObject } from 'react';

type AirPlayVideo = HTMLVideoElement & {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

interface RemotePlaybackLike extends EventTarget {
  state: 'disconnected' | 'connecting' | 'connected';
  watchAvailability(callback: (available: boolean) => void): Promise<number>;
  cancelWatchAvailability(id?: number): Promise<void>;
  prompt(): Promise<void>;
}

export type RemoteKind = 'airplay' | 'cast';

export interface RemotePlayback {
  /** What the button offers, or null when nothing is available. */
  kind: RemoteKind | null;
  /** Playing on the TV right now. */
  active: boolean;
  open: () => void;
}

const supportsAirPlay = () =>
  typeof window !== 'undefined' && 'WebKitPlaybackTargetAvailabilityEvent' in window;

/** `source` changes when a new stream is attached, so availability is checked again. */
export function useRemotePlayback(
  videoRef: RefObject<HTMLVideoElement | null>,
  source: unknown,
): RemotePlayback {
  const [kind, setKind] = useState<RemoteKind | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const video = videoRef.current as AirPlayVideo | null;
    if (!video || !source) return;

    if (supportsAirPlay()) {
      const onAvailability = (e: Event) =>
        setKind(
          (e as Event & { availability?: string }).availability === 'available' ? 'airplay' : null,
        );
      const onWireless = () => setActive(Boolean(video.webkitCurrentPlaybackTargetIsWireless));
      video.addEventListener('webkitplaybacktargetavailabilitychanged', onAvailability);
      video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
      onWireless();
      return () => {
        video.removeEventListener('webkitplaybacktargetavailabilitychanged', onAvailability);
        video.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
      };
    }

    const remote = (video as HTMLVideoElement & { remote?: RemotePlaybackLike }).remote;
    if (!remote) return;
    let watchId: number | undefined;
    let cancelled = false;
    const onState = () => setActive(remote.state === 'connected');
    remote.addEventListener('connect', onState);
    remote.addEventListener('disconnect', onState);
    remote
      .watchAvailability((available) => {
        if (!cancelled) setKind(available ? 'cast' : null);
      })
      .then((id) => {
        watchId = id;
      })
      // Not supported for this kind of stream (e.g. adaptive streams in Chrome).
      .catch(() => setKind(null));
    onState();
    return () => {
      cancelled = true;
      remote.removeEventListener('connect', onState);
      remote.removeEventListener('disconnect', onState);
      if (watchId !== undefined)
        void remote.cancelWatchAvailability(watchId).catch(() => undefined);
    };
  }, [videoRef, source]);

  const open = useCallback(() => {
    const video = videoRef.current as AirPlayVideo | null;
    if (!video) return;
    if (video.webkitShowPlaybackTargetPicker) {
      video.webkitShowPlaybackTargetPicker();
      return;
    }
    const remote = (video as HTMLVideoElement & { remote?: RemotePlaybackLike }).remote;
    void remote?.prompt().catch(() => undefined);
  }, [videoRef]);

  return { kind, active, open };
}
