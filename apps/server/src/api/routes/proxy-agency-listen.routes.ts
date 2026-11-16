import type { FastifyInstance } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { AGENCY_LISTEN_CLOSE } from '@magick-agency/contracts/agency';
import { disableNagle } from '../../utils/ws-nodelay.js';
import { handleListenSocket, LISTEN_TOKEN_INVALID_REASON } from '../../agency/listen/listen-socket.js';
import type { AgencyRuntime } from '../../agency/runtime.js';
import { isUuid } from './helpers/listen.js';
import '../../cluster/ws-handoff.plugin.js';

/*
 * The supervisor's listener socket, `/proxy/agency/listen/:sessionId/:listenId?token=…`
 * (docs/listening.md §3, §4), opened with a grant's `ws_url`. Like the station socket it carries
 * no bearer (a browser `WebSocket` cannot): the single-use token minted by the grant is its only
 * authority, spent by `handleListenSocket` (`agency/listen/listen-socket.ts`), which does the rest.
 *
 * This route's own refusals, before the token is touched: an id that is not a UUID (1008
 * `INVALID_UPGRADE`; a corrected retry keeps its token), a missing token (4401), no runtime (an app
 * built without a context, 1011). `disableNagle`: 20 ms frames, as on the station.
 *
 * With media workers the primary hands the upgrade to the worker that owns the agent's session
 * (`wsOwner: { by: 'session', param: 'sessionId' }`, `docs/scaling.md` §2.1): the process whose
 * bridge relays the call, whose grant handler minted the token, and whose registry holds the
 * caps. No audio crosses IPC.
 *
 * As HTTP closes, every session this process holds ends `server_shutdown` (its `ended` frame and
 * 1001 sent while the socket is still open, its row closed), ahead of the WebSocket plugin closing
 * the sockets with no reason.
 */

const log = createChildLogger({ component: 'agency-listen-route' });

export interface ProxyAgencyListenRouteOptions {
  /** The agency runtime, looked up per upgrade (null: built without a context). */
  getRuntime: () => AgencyRuntime | null;
}

export async function proxyAgencyListenRoutes(app: FastifyInstance, opts: ProxyAgencyListenRouteOptions): Promise<void> {
  app.addHook('preClose', async () => {
    await opts.getRuntime()?.listen.shutdown();
  });

  app.get<{ Params: { sessionId: string; listenId: string }; Querystring: { token?: string } }>(
    '/:sessionId/:listenId',
    { websocket: true, config: { wsOwner: { by: 'session', param: 'sessionId', route: 'listen' } } },
    (socket, request) => {
      socket.on('error', () => { /* the close follows; `handleListenSocket` logs its own */ });
      const { sessionId, listenId } = request.params;
      if (!isUuid(sessionId) || !isUuid(listenId)) {
        log.warn('Listen upgrade refused: an id is not a UUID');
        try { socket.close(AGENCY_LISTEN_CLOSE.INVALID_UPGRADE, 'invalid_upgrade'); } catch { /* ignore */ }
        return;
      }
      const token = request.query?.token;
      if (!token) {
        try { socket.close(AGENCY_LISTEN_CLOSE.TOKEN_REJECTED, LISTEN_TOKEN_INVALID_REASON); } catch { /* ignore */ }
        return;
      }
      const runtime = opts.getRuntime();
      if (!runtime) {
        try { socket.close(AGENCY_LISTEN_CLOSE.INTERNAL_ERROR, 'listen_unavailable'); } catch { /* ignore */ }
        return;
      }
      disableNagle(socket, log, { sessionId: sessionId.toLowerCase(), leg: 'listener' });
      void handleListenSocket(
        socket,
        { sessionId: sessionId.toLowerCase(), listenId: listenId.toLowerCase(), token },
        runtime.listenSocketDeps(),
      ).catch((err) => {
        log.error({ err, listenId }, 'Listen upgrade failed');
        try { socket.close(AGENCY_LISTEN_CLOSE.INTERNAL_ERROR, 'listen_unavailable'); } catch { /* ignore */ }
      });
    },
  );
}
