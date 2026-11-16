// The supervisor's listener socket route, `/proxy/agency/listen/:sessionId/:listenId`
// (docs/listening.md §3): registered once as a websocket route at the console's path, owned by the
// agent's session for the handoff (`wsOwner`, labelled `listen`), refusing a malformed upgrade
// before its token is spent; charged to the station's rate-limit bucket; its token redacted from
// spans and from the handoff's own log lines (asserted on the line itself). Enumerated from Fastify's `onRoute` hook, never by grep.
import { describe, it, expect, vi } from 'vitest';
import Fastify, { type RouteOptions } from 'fastify';

/** Every line the `ws-handoff` component logs, as handed to the logger (before any serializer). */
const handoffLog = vi.hoisted(() => [] as Array<{ level: string; obj: unknown; msg: unknown }>);
vi.mock('@magick-agency/observability', async (importOriginal) => {
  const real = await importOriginal<typeof import('@magick-agency/observability')>();
  return {
    ...real,
    createChildLogger: (bindings: Record<string, unknown>) => {
      const child = real.createChildLogger(bindings);
      if (bindings['component'] !== 'ws-handoff') return child;
      const record = (level: string) => (obj: unknown, msg?: unknown) => { handoffLog.push({ level, obj, msg }); };
      return Object.assign(Object.create(child), { warn: record('warn'), info: record('info'), error: record('error'), debug: record('debug') });
    },
  };
});

import { buildApp } from '../../../src/app.js';
import { budgetFor } from '../../../src/api/middleware/rate-limit.middleware.js';
import { redactSpanUrl } from '../../../src/utils/redact-url.js';
import { proxyAgencyListenRoutes } from '../../../src/api/routes/proxy-agency-listen.routes.js';
import { registerWsHandoff, type WsHandoffTarget } from '../../../src/cluster/ws-handoff.plugin.js';

const S = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';

async function closeOf(ws: { on: (e: 'close', cb: (code: number, reason: Buffer) => void) => void }): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
}

describe('the listener socket route', () => {
  it('is one websocket route at the console\'s path, owned by the agent\'s session and labelled `listen`', async () => {
    const routes: Array<{ route: string; websocket: boolean; wsOwner: unknown }> = [];
    const app = await buildApp({
      ctx: null,
      onRoute: (r: RouteOptions) => {
        const methods = Array.isArray(r.method) ? r.method : [r.method];
        for (const m of methods) {
          if (m !== 'HEAD' && r.url.includes('/listen/')) {
            routes.push({ route: `${m} ${r.url}`, websocket: (r as { websocket?: boolean }).websocket === true, wsOwner: r.config?.wsOwner });
          }
        }
      },
    });
    await app.ready();
    await app.close();
    expect(routes).toEqual([{
      route: 'GET /proxy/agency/listen/:sessionId/:listenId', websocket: true,
      wsOwner: { by: 'session', param: 'sessionId', route: 'listen' },
    }]);
  });

  it('refuses an id that is not a UUID 1008, a missing token 4401, and closes 1011 with no runtime', async () => {
    const app = await buildApp({ ctx: null });
    await app.ready();
    try {
      expect(await closeOf(await app.injectWS(`/proxy/agency/listen/not-a-uuid/${L}?token=t`))).toEqual({ code: 1008, reason: 'invalid_upgrade' });
      expect(await closeOf(await app.injectWS(`/proxy/agency/listen/${S}/${L}`))).toEqual({ code: 4401, reason: 'listen_token_invalid' });
      // SWE-NITS: a token given twice is a list, not a token: refused 4401 before anything reads it.
      expect(await closeOf(await app.injectWS(`/proxy/agency/listen/${S}/${L}?token=a&token=b`))).toEqual({ code: 4401, reason: 'listen_token_invalid' });
      expect(await closeOf(await app.injectWS(`/proxy/agency/listen/${S}/${L}?token=t`))).toEqual({ code: 1011, reason: 'listen_unavailable' });
    } finally {
      await app.close();
    }
  });

  it('with media workers, the primary hands the upgrade to the session\'s worker as `listen`', async () => {
    const handed: Array<{ slot: number; route: string; url: string }> = [];
    const target: WsHandoffTarget = {
      slotFor: (owner, params) => (owner.by === 'session' && params[owner.param] === S ? 1 : null),
      handoff: (slot, msg, socket) => { handed.push({ slot, route: msg.route, url: msg.url }); socket.destroy(); return true; },
    };
    const app = Fastify({ logger: false });
    registerWsHandoff(app, { target: () => target });
    await app.register(proxyAgencyListenRoutes, { prefix: '/proxy/agency/listen', getRuntime: () => null });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const port = (app.server.address() as { port: number }).port;
      const { WebSocket } = await import('ws');
      const ws = new WebSocket(`ws://127.0.0.1:${port}/proxy/agency/listen/${S}/${L}?token=t`);
      await new Promise<void>((resolve) => { ws.on('error', () => resolve()); ws.on('close', () => resolve()); });
      await vi.waitFor(() => expect(handed).toHaveLength(1));
      expect(handed[0]).toEqual({ slot: 1, route: 'listen', url: `/proxy/agency/listen/${S}/${L}?token=t` });
    } finally {
      await app.close();
    }
  });

  it('is charged to the station bucket, with or without a bearer; a lookalike is not', () => {
    expect(budgetFor({ url: `/proxy/agency/listen/${S}/${L}?token=abc`, headers: {} })).toBe('station');
    expect(budgetFor({ url: `/proxy/agency/listen/${S}/${L}?token=abc`, headers: { authorization: 'Bearer x' } })).toBe('station');
    expect(budgetFor({ url: '/proxy/agency/listeners', headers: {} })).toBe('ip');
    // The HTTP routes are ordinary bearer-authenticated requests.
    expect(budgetFor({ url: `/proxy/agency/live-calls/${S}/listen`, headers: { authorization: 'Bearer x' } })).toBe('ip_auth');
  });

  it('its token never reaches a span or a log line', async () => {
    const url = `/proxy/agency/listen/${S}/${L}?token=secret-token-value`;
    expect(redactSpanUrl(url)).toBe(`/proxy/agency/listen/${S}/${L}?token=[REDACTED]`);

    // The handoff's refusal logs the upgrade's URL while its token is unspent: redacted.
    handoffLog.length = 0;
    const target: WsHandoffTarget = { slotFor: () => 1, handoff: () => false };
    const app = Fastify({ logger: false });
    registerWsHandoff(app, { target: () => target });
    await app.register(proxyAgencyListenRoutes, { prefix: '/proxy/agency/listen', getRuntime: () => null });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const port = (app.server.address() as { port: number }).port;
      const { WebSocket } = await import('ws');
      const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`);
      await new Promise<void>((resolve) => { ws.on('error', () => resolve()); ws.on('close', () => resolve()); });
      await vi.waitFor(() => expect(handoffLog.some((l) => String(l.msg).startsWith('Upgrade handoff could not be sent'))).toBe(true));
    } finally {
      await app.close();
    }
    const line = handoffLog.find((l) => String(l.msg).startsWith('Upgrade handoff could not be sent'))!;
    expect(line.obj).toEqual({ slot: 1, url: `/proxy/agency/listen/${S}/${L}?token=[REDACTED]` });
    expect(JSON.stringify(handoffLog)).not.toContain('secret-token-value');
  });
});
