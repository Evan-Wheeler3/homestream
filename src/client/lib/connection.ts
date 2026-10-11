import { useSyncExternalStore } from 'react';

export interface ConnectionState {
  browserOnline: boolean;
  /** Can we reach this app's backend? */
  appServer: boolean;
  /** Is Jellyfin reachable (false = the backend is serving a cached library)? */
  mediaServer: boolean;
  /** Set when a request came back unauthenticated; the app returns to sign-in. */
  authLost: null | 'expired' | 'signedOut';
}

type Listener = () => void;

class ConnectionStore {
  private state: ConnectionState = {
    browserOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    appServer: true,
    mediaServer: true,
    authLost: null,
  };
  private listeners = new Set<Listener>();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.set({ browserOnline: true }));
      window.addEventListener('offline', () => this.set({ browserOnline: false }));
    }
  }

  private set(patch: Partial<ConnectionState>) {
    const next = { ...this.state, ...patch };
    if (Object.entries(patch).every(([k, v]) => this.state[k as keyof ConnectionState] === v))
      return;
    this.state = next;
    this.listeners.forEach((l) => l());
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = () => this.state;

  reportAppServer(ok: boolean) {
    this.set({ appServer: ok });
  }

  reportMediaServer(ok: boolean) {
    this.set({ mediaServer: ok });
  }

  reportAuthLost(expired: boolean) {
    this.set({ authLost: expired ? 'expired' : 'signedOut' });
  }

  clearAuthLost() {
    this.set({ authLost: null });
  }
}

export const connection = new ConnectionStore();

export function useConnection(): ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.get, connection.get);
}
