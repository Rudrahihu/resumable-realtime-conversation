import { io } from 'socket.io-client';

let socketInstance = null;

/**
 * Returns a single shared socket.io connection for the app.
 *
 * Reconnect policy (explicit, not left to library defaults):
 *
 *   - reconnection: true, reconnectionAttempts: Infinity — a dropped
 *     connection is the expected case this whole exercise is about
 *     (browser sleep, network handoff, service restart), not a fatal
 *     error. Giving up after N tries would convert a resumable outage
 *     into an unrecoverable one, which contradicts the point of having
 *     a durable, cursor-addressable event log on the server. The client
 *     surfaces 'disconnected'/'reconnecting' the whole time (see
 *     useSocketConnection / useRun) so an endless retry is never silent.
 *   - reconnectionDelay: 1000, reconnectionDelayMax: 5000,
 *     randomizationFactor: 0.5 — exponential backoff (1s, 2s, 4s, capped
 *     at 5s) with jitter, so a client reconnecting after a service
 *     restart doesn't thunder-herd the server the moment it comes back.
 *   - timeout: 10000 — how long a single connection attempt is given
 *     before socket.io treats it as failed and schedules the next
 *     backoff step, rather than hanging indefinitely on a half-open
 *     network path.
 *
 * This module only owns the transport-level connection; it makes sure
 * the whole app shares one socket instead of each component opening its
 * own. Resume semantics (cursor, replay/live merge) live in useRun.js.
 */
export function getSocket() {
  if (!socketInstance) {
    const url = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
    socketInstance = io(url, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 10000,
    });
  }
  return socketInstance;
}
