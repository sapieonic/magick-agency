// NEW (magick-agency, Phase 6): the agency plugin's surface after Phase 6 — exactly the
// agent station socket, at core's path (core `src/index.ts:694` mounts `agencyRoutes` at
// `/api/v1/agency`; the socket is `agency.routes.ts:163`, `GET /station/:sessionId`,
// `websocket: true`). Enumerated from Fastify's `onRoute` hook, never by grep. Every
// other core agency route is Phase 8.
//
// PORT NOTE (magick-agency, Phase 8): MODIFIED (2) — the socket moved to the console's path,
// `/proxy/agency/station/:sessionId` (master `proxy-agency-station.routes.ts`, collapsed), and
// core's path is no longer registered; both cases assert the new path (and the first, that no
// `/api/v1/agency` route remains).
import { describe, it, expect } from 'vitest';
import type { RouteOptions } from 'fastify';
import { buildApp } from '../../../src/app.js';

describe('agency plugin route table (Phase 6)', () => {
  it('registers the station socket once, as a websocket route, at the console\'s path (not core\'s)', async () => {
    const routes: Array<{ route: string; websocket: boolean }> = [];
    const app = await buildApp({
      ctx: null,
      onRoute: (r: RouteOptions) => {
        const methods = Array.isArray(r.method) ? r.method : [r.method];
        for (const m of methods) {
          if (m !== 'HEAD') routes.push({ route: `${m} ${r.url}`, websocket: (r as { websocket?: boolean }).websocket === true });
        }
      },
    });
    await app.ready();
    await app.close();

    expect(routes.filter((r) => r.route.includes('/api/v1/agency'))).toEqual([]);
    const station = routes.filter((r) => r.route.includes('/station/'));
    expect(station).toEqual([{ route: 'GET /proxy/agency/station/:sessionId', websocket: true }]);
  });

  it('closes a station socket with 1011 when the app was built without a runtime', async () => {
    // `buildApp({ ctx: null })` builds routing only; the handler must not dereference a
    // runtime that does not exist (the one addition to core's handler, see station-socket.ts).
    const app = await buildApp({ ctx: null });
    await app.ready();
    const ws = await app.injectWS('/proxy/agency/station/00000000-0000-0000-0000-000000000001?token=t');
    const code = await new Promise<number>((resolve) => ws.on('close', (c: number) => resolve(c)));
    expect(code).toBe(1011);
    await app.close();
  });
});
