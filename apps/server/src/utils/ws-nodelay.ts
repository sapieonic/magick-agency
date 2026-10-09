// PORT NOTE (magick-agency, Phase 8): master `src/utils/ws-nodelay.ts`@a1f0756a, verbatim. Used by
// the station route (`api/routes/proxy-agency-station.routes.ts`) on the agent's socket, as master
// did on its agent leg. `MEDIA_WS_CLIENT_OPTIONS` is kept for fidelity (no outbound socket here).
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
 * Core disables it on all three legs it owns (`disableNagle` in
 * `magic-voice-core/src/core/webrtc-bridge-manager.ts`): the browser leg, the
 * borrowed agency station leg, and the carrier leg. Master's proxies sit
 * *between* two of those, so a proxy that skips this re-introduces on the way
 * through exactly what core turned off on either side of it, in both
 * directions.
 *
 * **There are THREE such proxies in master, not two**, and the third was missed
 * on the first pass: `proxy-agency-station` (the agent console),
 * `proxy-media-stream` (the AI browser call) and `proxy-webrtc-call` (the
 * browser→PSTN dialer's own media leg). The miss came from searching for the
 * *absence* of `setNoDelay`, which finds what is already fixed and cannot
 * enumerate what is not — `grep "websocket: true" src/` is the query that
 * answers "which routes carry media", and it is the one to use when adding a
 * fourth.
 *
 * ── Call it at the right moment ─────────────────────────────────────────────
 * `_socket` only exists once a TCP connection does. For an inbound (server)
 * socket that is immediately after the upgrade; for an outbound `ws` client it
 * is inside the `'open'` handler, **not** at construction.
 *
 * ── Why a failure is logged and not thrown ──────────────────────────────────
 * `_socket` is not part of `ws`'s public type and could disappear in a major
 * version. A proxy that refused to carry a phone call because it could not tune
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
 * latency and CPU, which is why core registers its WebSocket server with
 * `perMessageDeflate: false`. Core would therefore decline the extension
 * anyway — this stops master *offering* it, so the two ends cannot drift into
 * negotiating compression if core's config ever changes.
 *
 * `Object.freeze` and not merely `as const`: `as const` is erased at compile
 * time, so a single shared object handed to three `new WsWebSocket(...)` calls
 * would be mutable at runtime by any of them. `ws` copies its options rather
 * than mutating them, so this is depth rather than a live bug — but a shared
 * config object that three call sites can write to is worth making actually
 * immutable rather than only apparently so.
 */
export const MEDIA_WS_CLIENT_OPTIONS = Object.freeze({ perMessageDeflate: false });
