// The theater building everyone shares: one Durable Object holds who is where
// and what each theater is showing (src/shared/theater.ts), and passes every
// change on to everyone connected over WebSockets.
import { TheaterState, type ServerMessage, type TheaterUser } from '../shared/theater.js';

/** Workers' WebSocket: the browser's, plus accept(). */
type ServerSocket = WebSocket & { accept(): void };
declare const WebSocketPair: new () => { 0: WebSocket; 1: ServerSocket };

/** The request header the Worker puts the signed-in person in (never from the browser). */
export const THEATER_USER_HEADER = 'x-wheelhouse-theater-user';

export class TheaterHouse {
  private readonly sockets = new Map<string, ServerSocket>();
  private readonly state = new TheaterState((to, message, except) =>
    this.deliver(to, message, except),
  );

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 });
    }
    let user: TheaterUser;
    try {
      user = JSON.parse(request.headers.get(THEATER_USER_HEADER) ?? '') as TheaterUser;
    } catch {
      return new Response('Who is this?', { status: 400 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const id = crypto.randomUUID();
    this.sockets.set(id, server);
    server.addEventListener('message', (event) => {
      try {
        this.state.handle(id, JSON.parse(String(event.data)));
      } catch {
        // Not JSON: ignore it.
      }
    });
    const close = () => {
      if (this.sockets.delete(id)) this.state.leave(id);
    };
    server.addEventListener('close', close);
    server.addEventListener('error', close);
    this.state.join(id, user);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  private deliver(to: string | null, message: ServerMessage, except?: string) {
    const data = JSON.stringify(message);
    const targets = to === null ? [...this.sockets] : [[to, this.sockets.get(to)] as const];
    for (const [id, socket] of targets) {
      if (!socket || id === except) continue;
      try {
        socket.send(data);
      } catch {
        // Closed: its close event tidies up.
      }
    }
  }
}
