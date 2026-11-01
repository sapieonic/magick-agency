// Proves `registerRateLimit` is scoped when registered inside an encapsulated Fastify plugin
// (`voice.plugin.ts` registers it that way), using a real Fastify app and the no-Redis path
// (`redis: null`, the plugin's in-memory store).
// The bucket key itself is not observable from outside the plugin, so `wh:<ip>` is proven by
// behaviour: the budget is shared across webhook paths for one IP, separate per IP, and separate
// from the `cm:<ip>` carrier-media budget for the same IP.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { trackRateLimitRejected } = vi.hoisted(() => ({ trackRateLimitRejected: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/voice', () => ({ trackRateLimitRejected }));

import { registerRateLimit } from '../../../../src/api/middleware/rate-limit.middleware.js';

const WEBHOOK_MAX = 2;
const CARRIER_MEDIA_MAX = 3;
const PLAIN_MAX = 100;
const STATION_MAX = 4;
const CARRIER_IP = '9.9.9.9';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Child plugin, encapsulated (NOT fastify-plugin wrapped), as voice.plugin.ts is.
  await app.register(async (child) => {
    await registerRateLimit(child, null, {
      max: PLAIN_MAX,
      webhookMax: WEBHOOK_MAX,
      carrierMediaMax: CARRIER_MEDIA_MAX,
      stationMax: STATION_MAX,
      internalMax: 100,
      timeWindow: '1 minute',
    });
    child.post('/api/v1/webhooks/voicelink/webrtc-status/:callId', async () => ({ ok: true }));
    child.get('/api/v1/webrtc-call/:id/pstn-stream', async () => ({ ok: true }));
    // A plain route for the plain `<ip>` bucket, and the station upgrade's path (a plain GET
    // here: the bucket is decided in `onRequest`, before any upgrade handling).
    child.post('/auth/session', async () => ({ ok: true }));
    child.get('/proxy/agency/station/:sessionId', async () => ({ ok: true }));
  });
  // Sibling OUTSIDE the child plugin, deliberately on a webhook-bucket path: if the limiter
  // leaked to the root it would share the exhausted `wh:<ip>` counter.
  app.post('/api/v1/webhooks/voicelink/sibling/:callId', async () => ({ ok: true }));
  await app.ready();
  return app;
}

const postWebhook = (app: FastifyInstance, callId: string, ip = CARRIER_IP) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/webhooks/voicelink/webrtc-status/${callId}?token=t`,
    remoteAddress: ip,
    payload: {},
  });

const getPstnStream = (app: FastifyInstance, id: string, ip = CARRIER_IP) =>
  app.inject({ method: 'GET', url: `/api/v1/webrtc-call/${id}/pstn-stream`, remoteAddress: ip });

describe('registerRateLimit inside an encapsulated plugin (in-memory store)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    trackRateLimitRejected.mockClear();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('(a) 429s the webhook route after webhookMax, on a per-IP webhook key (wh:<ip>)', async () => {
    for (let i = 0; i < WEBHOOK_MAX; i++) {
      expect((await postWebhook(app, `c${i}`)).statusCode).toBe(200);
    }
    // The key is per IP and namespace, not per route: a different callId on the same IP is
    // refused too.
    const refused = await postWebhook(app, 'another-call');
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: 'Too Many Requests', statusCode: 429 });
    expect(trackRateLimitRejected).toHaveBeenCalledWith('webhook', 'webhooks');
    // A different client IP has its own `wh:` counter.
    expect((await postWebhook(app, 'c0', '8.8.8.8')).statusCode).toBe(200);
  });

  it('(b) carrier_media has its own budget: an exhausted webhook bucket does not 429 pstn-stream', async () => {
    for (let i = 0; i < WEBHOOK_MAX; i++) await postWebhook(app, `c${i}`);
    expect((await postWebhook(app, 'over')).statusCode).toBe(429);

    // Same IP, carrier-media path: its full `cm:<ip>` budget is still available.
    for (let i = 0; i < CARRIER_MEDIA_MAX; i++) {
      expect((await getPstnStream(app, `call-${i}`)).statusCode).toBe(200);
    }
    // And it is a real ceiling of its own, not unlimited.
    expect((await getPstnStream(app, 'call-over')).statusCode).toBe(429);
    expect(trackRateLimitRejected).toHaveBeenLastCalledWith('carrier_media', 'media_stream');
  });

  it('(d) the station upgrade has its own budget: an exhausted plain ip bucket does not 429 it', async () => {
    const NAT = '100.64.9.9';
    for (let i = 0; i < PLAIN_MAX; i++) {
      await app.inject({ method: 'POST', url: '/auth/session', remoteAddress: NAT, payload: {} });
    }
    expect((await app.inject({ method: 'POST', url: '/auth/session', remoteAddress: NAT, payload: {} })).statusCode).toBe(429);

    // Same IP: the station upgrade still has its whole `st:<ip>` budget …
    const upgrade = (i: number) => app.inject({
      method: 'GET', url: `/proxy/agency/station/s${i}?token=t${i}&client=mobile`, remoteAddress: NAT,
    });
    for (let i = 0; i < STATION_MAX; i++) {
      const res = await upgrade(i);
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe(String(STATION_MAX));
    }
    // … and it is a real ceiling of its own, not unlimited.
    expect((await upgrade(99)).statusCode).toBe(429);
    expect(trackRateLimitRejected).toHaveBeenLastCalledWith('station', 'agency');
    // Spending it does not spend the plain bucket of another IP, nor the other way round.
    expect((await app.inject({ method: 'GET', url: '/proxy/agency/station/s0', remoteAddress: '100.64.9.10' })).statusCode).toBe(200);
  });

  it('(c) does not limit a sibling route registered outside the child plugin', async () => {
    for (let i = 0; i < WEBHOOK_MAX; i++) await postWebhook(app, `c${i}`);
    expect((await postWebhook(app, 'over')).statusCode).toBe(429);

    for (let i = 0; i < WEBHOOK_MAX * 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/webhooks/voicelink/sibling/s${i}`,
        remoteAddress: CARRIER_IP,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });
});
