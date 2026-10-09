import type { FastifyInstance } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { disableNagle } from '../../utils/ws-nodelay.js';
import { isUnsafeCorePath } from '../../proxy/safe-core-path.js';
import { handleStationSocket } from '../../agency/station-socket.js';
import type { AgencyRuntime } from '../../agency/runtime.js';

/*
 * The console's station WebSocket, served at `/proxy/agency/station/:sessionId`
 * (decision B16: one process, one socket).
 *
 * This route makes two refusals, in this order: a tokenless upgrade (4401) and a
 * path-escaping session id (1008). Past those, the console's socket IS the station
 * socket: it is handed to `handleStationSocket` (`agency/station-socket.ts`), which
 * verifies and consumes the single-use token before anything else. The WebRTC bridge
 * borrows this same socket for media. With no runtime (an app built without a context)
 * the socket is closed 1011.
 *
 * The close codes `handleStationSocket` itself sends (4401, 4404, 4409) reach the
 * console directly; there is no relay leg to translate them. `disableNagle` is applied
 * to the agent's socket. `rewriteStationWsUrl` stays here because the agent routes use it
 * to rewrite the `station_ws_url` minted by the internal handler instance onto this path.
 *
 * `/api/v1/agency/station/:sessionId` (the path in that minted URL) is deliberately NOT
 * registered as a route: the console only ever connects here, and a second route to the
 * same handler would be a second unreviewed entry point.
 */

const log = createChildLogger({ component: 'agency-station-proxy' });

/**
 * WebSocket close codes this route originates.
 *
 * `MISSING_TOKEN` is 4401 to match `AgencyStationCloseCode`'s meaning of
 * "token missing, expired, already used, or wrong — **re-mint and retry**".
 * That is exactly the right instruction for a tokenless upgrade, and reusing
 * the code means the console needs one handler rather than two. The token is
 * single-use and lives ~2 minutes, so re-mint-and-retry is the common path,
 * not an edge case.
 *
 * `INVALID_SESSION_ID` is the plain RFC 6455 policy-violation code rather than
 * one of the station's 44xx codes: nothing about it maps onto a station state,
 * because the upgrade is refused before the station handler runs, and
 * re-minting a token would not help.
 *
 * `handleStationSocket` also uses 4404 (re-bootstrap, do not retry) and 4409
 * (superseded). This route never originates those; the handler sends them on
 * the same socket.
 */
export const STATION_CLOSE_CODES = {
  /** No token on the upgrade — never reached the station handler. Re-mint and retry. */
  MISSING_TOKEN: 4401,
  /** The session id would escape `/api/v1/agency/station`. Do not retry. */
  INVALID_SESSION_ID: 1008,
  /** The close for an app built without a runtime. */
  RUNTIME_UNAVAILABLE: 1011,
} as const;

/**
 * Rewrite the internal handler instance's `station_ws_url`
 * (`/api/v1/agency/station/<id>?token=…`) onto `/proxy/agency/station`,
 * preserving the path, the session id and the query string (which carries the
 * token). Mirrors `rewriteBrowserWsUrl`, and is exported for the same reason:
 * it is the one piece of this module that is a pure function and therefore the
 * one piece that can be tested without sockets.
 *
 * Falls back to the original URL if the shape is unexpected, rather than
 * producing a guaranteed-broken `/proxy/agency/station` path.
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

      // The station path the session id is interpolated into. Refused here because the
      // id is a path segment the console controls, and nothing that escapes it should
      // reach the token store.
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
