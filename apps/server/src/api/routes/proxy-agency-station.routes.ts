import type { FastifyInstance } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { AGENCY_STATION_CLOSE } from '@magick-agency/contracts/agency';
import { disableNagle } from '../../utils/ws-nodelay.js';
import { isUnsafeCorePath } from '../../proxy/safe-core-path.js';
import { handleStationSocket } from '../../agency/station-socket.js';
import { parseStationUpgradeQuery } from '../../agency/station-upgrade.js';
import type { AgencyRuntime } from '../../agency/runtime.js';

/*
 * The console's station WebSocket, served at `/proxy/agency/station/:sessionId`
 * (decision B16: one process, one socket).
 *
 * This route makes three refusals, in this order: a tokenless upgrade (4401), a
 * path-escaping session id (1008), and an unknown `client=` or `media=` on the upgrade
 * query (1008, `parseStationUpgradeQuery`). Past those, the console's socket IS the station
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
 * `INVALID_SESSION_ID` and `INVALID_UPGRADE_QUERY` are the plain RFC 6455
 * policy-violation code (the contract's `INVALID_UPGRADE`, 1008) rather than one of
 * the station's 44xx codes: nothing about them maps onto a station state, because
 * the upgrade is refused before the station handler runs, and re-minting a token
 * would not help. `RUNTIME_UNAVAILABLE` is the contract's `INTERNAL_ERROR` (1011).
 *
 * `handleStationSocket` also uses 4404 (re-bootstrap, do not retry) and 4409
 * (superseded). This route never originates those; the handler sends them on
 * the same socket.
 */
export const STATION_CLOSE_CODES = {
  /** No token on the upgrade — never reached the station handler. Re-mint and retry. */
  MISSING_TOKEN: AGENCY_STATION_CLOSE.TOKEN_REJECTED,
  /** The session id would escape `/api/v1/agency/station`. Do not retry. */
  INVALID_SESSION_ID: AGENCY_STATION_CLOSE.INVALID_UPGRADE,
  /**
   * `client=` or `media=` names something this server does not speak. Do not retry: the
   * same upgrade would be refused again. The close reason says which
   * (`invalid_client` / `invalid_media`).
   */
  INVALID_UPGRADE_QUERY: AGENCY_STATION_CLOSE.INVALID_UPGRADE,
  /** The close for an app built without a runtime. Retryable, but a client bounds it. */
  RUNTIME_UNAVAILABLE: AGENCY_STATION_CLOSE.INTERNAL_ERROR,
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
  app.get<{ Params: { sessionId: string }; Querystring: { token?: string; client?: string; media?: string } }>(
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

      // Before the token is consumed: a refused upgrade leaves the token for a corrected retry.
      const upgrade = parseStationUpgradeQuery(request.query);
      if (!upgrade.ok) {
        log.warn({ sessionId, reason: upgrade.reason }, 'Station proxy: upgrade refused, unknown client or media');
        clientSocket.close(STATION_CLOSE_CODES.INVALID_UPGRADE_QUERY, upgrade.reason);
        return;
      }

      const runtime = opts.getRuntime();
      if (!runtime) {
        try { clientSocket.close(STATION_CLOSE_CODES.RUNTIME_UNAVAILABLE, 'agency_runtime_unavailable'); } catch { /* ignore */ }
        return;
      }

      log.info({ sessionId, client: upgrade.query.client, media: upgrade.query.media },
        'Station proxy: handing the socket to the station handler');
      disableNagle(clientSocket, log, { sessionId, leg: 'agent' });

      void handleStationSocket(clientSocket, sessionId, token, runtime, upgrade.query);
    },
  );
}
