// The theater's connection: a WebSocket to the shared building on Cloudflare,
// or, when there isn't one (the home server, or no connection), the same
// building run right here in the browser with just you in it.
import {
  TheaterState,
  type ClientMessage,
  type ServerMessage,
  type TheaterUser,
} from '../../shared/theater';

export type LinkStatus = 'connecting' | 'together' | 'reconnecting' | 'solo';

const LOCAL_ID = 'me';
const FIRST_CONNECT_MS = 6000;

export class TheaterLink {
  private ws: WebSocket | null = null;
  private local: TheaterState | null = null;
  private offset = 0;
  private bestRtt = Infinity;
  private welcomed = false;
  private closed = false;
  private retry = 0;
  private timers: number[] = [];

  constructor(
    private readonly user: TheaterUser,
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly onStatus: (status: LinkStatus) => void,
  ) {}

  /** `shared`: try the building on the server first. */
  start(shared: boolean) {
    if (shared && 'WebSocket' in window) this.connect();
    else this.goSolo();
  }

  /** Server time now (ms), corrected for this device's clock. */
  now() {
    return Date.now() + this.offset;
  }

  send(message: ClientMessage) {
    if (this.local) {
      this.local.handle(LOCAL_ID, message);
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  close() {
    this.closed = true;
    for (const t of this.timers) window.clearTimeout(t);
    this.ws?.close();
    this.ws = null;
    if (this.local) this.local.leave(LOCAL_ID);
  }

  private later(fn: () => void, ms: number) {
    this.timers.push(window.setTimeout(fn, ms));
  }

  private connect() {
    this.onStatus(this.welcomed ? 'reconnecting' : 'connecting');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/theater/socket`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.goSolo();
      return;
    }
    this.ws = ws;
    let opened = false;
    if (!this.welcomed) {
      this.later(() => {
        if (!this.welcomed && this.ws === ws) {
          ws.close();
          this.goSolo();
        }
      }, FIRST_CONNECT_MS);
    }
    ws.addEventListener('open', () => {
      opened = true;
      this.retry = 0;
    });
    ws.addEventListener('message', (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.t === 'welcome') {
        this.welcomed = true;
        this.onStatus('together');
        this.syncClock(message.now);
      }
      if (message.t === 'pong') {
        const rtt = Date.now() - message.c;
        if (rtt <= this.bestRtt) {
          this.bestRtt = rtt;
          this.offset = message.s - (message.c + rtt / 2);
        }
        return;
      }
      this.onMessage(message);
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws || this.closed || this.local) return;
      this.ws = null;
      if (!this.welcomed && !opened) {
        // Never got in (the home server has no shared theater): carry on alone.
        this.goSolo();
        return;
      }
      const wait = [1000, 2000, 5000, 10000][Math.min(3, this.retry++)]!;
      this.onStatus('reconnecting');
      this.later(() => this.connect(), wait);
    });
  }

  /** A few pings to learn how this clock differs from the server's. */
  private syncClock(serverNow: number) {
    this.offset = serverNow - Date.now();
    this.bestRtt = Infinity;
    [0, 400, 1200, 30_000, 120_000].forEach((ms) =>
      this.later(() => this.send({ t: 'ping', c: Date.now() }), ms),
    );
  }

  private goSolo() {
    if (this.local || this.closed) return;
    this.ws = null;
    this.offset = 0;
    this.local = new TheaterState((to, message, except) => {
      const forMe = to === null ? except !== LOCAL_ID : to === LOCAL_ID;
      if (!forMe || message.t === 'pong') return;
      // Asynchronously, like a real connection.
      queueMicrotask(() => this.onMessage(message));
    });
    this.onStatus('solo');
    this.local.join(LOCAL_ID, this.user);
  }
}
