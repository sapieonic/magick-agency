import type { FastifyInstance } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { disableNagle } from '../../utils/ws-nodelay.js';
import { isUnsafeCorePath } from '../../proxy/safe-core-path.js';
import { handleStationSocket } from '../../agency/station-socket.js';
import type { AgencyRuntime } from '../../agency/runtime.js';

/*
 * PORT NOTE (magick-agency, Phase 8): master `src/api/routes/proxy-agency-station.routes.ts`
 * @a1f0756a, with the hop collapsed in-process (decision B16).
 *
 * In MagickVoice the console's station socket ended at master, which refused a tokenless
 * upgrade (4401) and a path-escaping session id (1008), then opened a SECOND socket to core's
 * `/api/v1/agency/station/:sessionId?token=` and relayed frames and close codes between the
 * two legs. Core verified the token and ran `handleStationSocket`. Here there is one process
 * and one socket: after master's two refusals, the console's socket IS the station socket —
 * handed to core's `handleStationSocket` (Phase 6's verbatim port, `agency/station-socket.ts`),
 * which verifies and consumes the token first, exactly as it did behind master. The bridge
 * borrows this same socket for media, as it borrowed core's leg.
 *
 * Kept: the route shape and path (`/:sessionId` under `/proxy/agency/station`, master
 * `src/index.ts:564`), the 4401 / 1008 refusals and their order, `disableNagle` on the agent's
 * socket, the log lines' meaning, `rewriteStationWsUrl` (the agent routes still rewrite core's
 * `station_ws_url` onto this path). Deleted with the second leg, each because there is no
 * upstream socket: `STATION_CLOSE_CODES.UPSTREAM_UNAVAILABLE` (4502), the pending-frame buffer
 * for a CONNECTING core leg, the two-way relay, `closeSafely` / `isSendableCloseCode` /
 * `truncateCloseReason` / `describeUnsendableCode` / `STATION_CLOSE_REASONS` /
 * `STATION_CLOSE_DELIVERY` (they translated a close observed on one leg into one sendable on
 * the other; core's own close codes — 4401, 4404, 4409 — now reach the console directly, as
 * master relayed them), `MEDIA_WS_CLIENT_OPTIONS` and `config.coreService.url`. One addition:
 * with no runtime (an app built without a context) the socket is closed 1011, Phase 6's
 * `registerStationSocket` behaviour.
 *
 * Core's own station path (`/api/v1/agency/station/:sessionId`, where Phase 6 mounted it) is
 * NOT registered: the console never called it (it called master's), and a second route to the
 * same handler would be a second unreviewed entry point.
 */

const log = createChildLogger({ component: 'agency-station-proxy' });

/**
 * WebSocket close codes this route originates.
 *
 * `MISSING_TOKEN` is 4401 to match core's `AgencyStationCloseCode` for
 * "token missing, expired, already used, or wrong — **re-mint and retry**".
 * That is exactly the right instruction for a tokenless upgrade, and reusing
 * core's code means the console needs one handler rather than two. Contract v2
 * made the token single-use and ~2 minutes, so re-mint-and-retry is now the
 * common path, not an edge case.
 *
 * `INVALID_SESSION_ID` is the plain RFC 6455 policy-violation code rather than
 * one of core's 44xx: nothing about it maps onto a core state, because master
 * refused before core was contacted, and re-minting a token would not help.
 *
 * Core also uses 4404 (re-bootstrap, do not retry) and 4409 (superseded). This
 * proxy never originates those — it relays them.
 */
export const STATION_CLOSE_CODES = {
  /** No token on the upgrade — never reached core. Re-mint and retry. */
  MISSING_TOKEN: 4401,
  /** The session id would escape `/api/v1/agency/station`. Do not retry. */
  INVALID_SESSION_ID: 1008,
  /** PORT NOTE (magick-agency): Phase 6's close for an app built without a runtime. */
  RUNTIME_UNAVAILABLE: 1011,
} as const;

/**
 * Rewrite core's absolute `station_ws_url` onto master's proxy prefix,
 * preserving the path, the session id and the query string (which carries the
 * token). Mirrors `rewriteBrowserWsUrl`, and is exported for the same reason:
 * it is the one piece of this module that is a pure function and therefore the
 * one piece that can be tested without sockets.
 *
 * Falls back to the original URL if the shape is unexpected, so an unrecognised
 * core URL degrades to "client talks to core directly" rather than to a
 * guaranteed-broken proxy path.
 */
export function rewriteStationWsUrl(stationWsUrl: string): string {
  let pathAndQuery = stationWsUrl;
  try {
    const url = new URL(stationWsUrl);
    pathAndQuery = `${url.pathname}${url.search}`;
  } catch {
    // Already a relative path — use as-is.
  }
  const proxied = pathAndQuery.replace(/^\/api\/v1\/agency\/station/, '/proxy/agency/station');
  return proxied.startsWith('/proxy/agency/station') ? proxied : stationWsUrl;
}

export interface ProxyAgencyStationRouteOptions {
  /** The agency runtime, looked up per upgrade (null: built without a context). */
  getRuntime: () => AgencyRuntime | null;
}

export async function proxyAgencyStationRoutes(
  app: FastifyInstance,
  opts: ProxyAgencyStationRouteOptions,
): Promise<void> {
  app.get<{ Params: { sessionId: string }; Querystring: { token?: string } }>(
    '/:sessionId',
    { websocket: true },
    (clientSocket, request) => {
      const { sessionId } = request.params;
      const token = request.query?.token;

      if (!token) {
        log.warn({ sessionId }, 'Station proxy: upgrade refused, no token');
        clientSocket.close(STATION_CLOSE_CODES.MISSING_TOKEN, 'missing token');
        return;
      }

      // The core path the session id would have been interpolated into. Kept as master's
      // refusal: the id is still a path segment the console controls, and nothing that
      // escapes it should reach the token store.
      const corePath = `/agency/station/${encodeURIComponent(sessionId)}`;
      if (isUnsafeCorePath(corePath)) {
        log.warn({ sessionId }, 'Station proxy: upgrade refused, path-escaping session id');
        clientSocket.close(STATION_CLOSE_CODES.INVALID_SESSION_ID, 'invalid session id');
        return;
      }

      const runtime = opts.getRuntime();
      if (!runtime) {
        try { clientSocket.close(STATION_CLOSE_CODES.RUNTIME_UNAVAILABLE, 'agency_runtime_unavailable'); } catch { /* ignore */ }
        return;
      }

      log.info({ sessionId }, 'Station proxy: handing the socket to the station handler');
      disableNagle(clientSocket, log, { sessionId, leg: 'agent' });

      void handleStationSocket(clientSocket, sessionId, token, runtime);
    },
  );
}
