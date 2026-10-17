import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { AgencyRuntime } from '../../agency/runtime.js';
import { registerSessionRoutes } from './agency/sessions.js';
import { registerAttemptRoutes } from './agency/attempts.js';

export async function agencyRoutes(app: FastifyInstance, runtime: AgencyRuntime): Promise<void> {
  // This module is the session and attempt handlers only, registered on the
  // internal handler instance (`core-handlers.ts`, reached in-process via `callCore`;
  // decision B16). The station WebSocket is not served here: it lives in
  // `agency/station-socket.ts` (`handleStationSocket`) and is mounted only at
  // `/proxy/agency/station/:sessionId` by `proxy-agency-station.routes.ts`, which also
  // rewrites the `station_ws_url` minted in `./agency/sessions.ts` (`/api/v1/agency/station/<id>?token=…`)
  // onto that path. The roster hand-off is `agency/agency-roster.client.ts`.

  await app.register(async (sub) => {
    sub.addHook('preHandler', authMiddleware);

    // The handlers, by family (`./agency/`), inside this one authenticated scope.
    await registerSessionRoutes(sub, runtime);
    await registerAttemptRoutes(sub, runtime);
  });
}
