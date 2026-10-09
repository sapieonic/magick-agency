// The agency plugin's surface is exactly the agent station socket, at the console's path
// `/proxy/agency/station/:sessionId` (`websocket: true`). No `/api/v1/agency` route is
// registered. Enumerated from Fastify's `onRoute` hook, never by grep.
import { describe, it, expect } from 'vitest';
import type { RouteOptions } from 'fastify';
import { buildApp } from '../../../src/app.js';

describe('agency plugin route table', () => {
  it('registers the station socket once, as a websocket route, at the console\'s path (not an /api/v1/agency path)', async () => {
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
    // runtime that does not exist (see station-socket.ts).
    const app = await buildApp({ ctx: null });
    await app.ready();
    const ws = await app.injectWS('/proxy/agency/station/00000000-0000-0000-0000-000000000001?token=t');
    const code = await new Promise<number>((resolve) => ws.on('close', (c: number) => resolve(c)));
    expect(code).toBe(1011);
    await app.close();
  });
});
