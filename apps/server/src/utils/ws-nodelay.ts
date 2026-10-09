// Used by the station route (`api/routes/proxy-agency-station.routes.ts`) on the agent's
// socket. `MEDIA_WS_CLIENT_OPTIONS` currently has no user: no route here opens an outbound socket.
import type { Logger } from 'pino';
import type { WebSocket as WsWebSocket } from 'ws';

/**
 * Disable Nagle's algorithm on a WebSocket's underlying TCP connection.
 *
 * ── Why every media proxy has to call this ──────────────────────────────────
 * Nagle withholds a small write until the previous segment has been
 * acknowledged, coalescing it with whatever arrives in the meantime. That is
 * the right trade for bulk transfer and the wrong one for a stream of 20 ms
 * audio frames, where it can add up to ~40 ms per socket — and interacts badly
 * with delayed ACK, which is where the worst cases come from. **Node enables it
 * on every socket by default.**
 *
 * The voice engine disables it on the legs it owns (its own private
 * `disableNagle` in `src/core/webrtc-bridge-manager.ts`). A socket that skips
 * this re-introduces exactly what the engine turned off, in both directions.
 *
 * To find every route that carries media, search for `websocket: true` under
 * `src/` — not for the *absence* of `setNoDelay`, which finds what is already
 * fixed and cannot enumerate what is not.
 *
 * ── Call it at the right moment ─────────────────────────────────────────────
 * `_socket` only exists once a TCP connection does. For an inbound (server)
 * socket that is immediately after the upgrade; for an outbound `ws` client it
 * is inside the `'open'` handler, **not** at construction.
 *
 * ── Why a failure is logged and not thrown ──────────────────────────────────
 * `_socket` is not part of `ws`'s public type and could disappear in a major
 * version. A socket handler that refused to carry a phone call because it could not tune
 * a socket option would be a worse outcome than one that carries it slightly
 * late, so this degrades rather than fails.
 *
 * @param context Correlation fields for the log line — `{ callId }`,
 *                `{ sessionId, leg }`, whatever the caller logs by.
 */
export function disableNagle(
  socket: WsWebSocket,
  log: Logger,
  context: Record<string, unknown> = {},
): void {
  try {
    const raw = (socket as unknown as { _socket?: { setNoDelay?: (noDelay: boolean) => void } })
      ._socket;
    raw?.setNoDelay?.(true);
  } catch (err) {
    // `err` LAST, so the caught error always wins. `context` is caller-supplied
    // and untyped beyond `Record<string, unknown>`; spreading it over `err`
    // would let a caller passing its own `err` field replace the very error
    // this line exists to report — and because the root logger registers
    // `pino.stdSerializers.err` for that key, a non-Error value there
    // serializes to something worse than useless.
    log.warn({ ...context, err }, 'Could not set TCP_NODELAY on media socket');
  }
}

/**
 * Options for an upstream `ws` client on a media path.
 *
 * Per-message deflate on a few hundred bytes of audio buys nothing and costs
 * latency and CPU. This stops the client *offering* the extension, so the two
 * ends cannot drift into negotiating compression if the server's config ever
 * changes.
 *
 * `Object.freeze` and not merely `as const`: `as const` is erased at compile
 * time, so a single shared object handed to three `new WsWebSocket(...)` calls
 * would be mutable at runtime by any of them. `ws` copies its options rather
 * than mutating them, so this is depth rather than a live bug — but a shared
 * config object that three call sites can write to is worth making actually
 * immutable rather than only apparently so.
 */
export const MEDIA_WS_CLIENT_OPTIONS = Object.freeze({ perMessageDeflate: false });
