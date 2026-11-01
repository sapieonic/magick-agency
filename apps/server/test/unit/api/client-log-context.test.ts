import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { getLogContext } from '@magick-agency/observability';
import { clientLogContextHook } from '../../../src/api/middleware/client-log-context.js';

// `client` on every log line a request produces: through the ambient log context the
// app logger's mixin reads, seeded by an app-wide `onRequest` hook from `X-Client`.
describe('clientLogContextHook', () => {
  async function app() {
    const a = Fastify({ logger: false });
    a.addHook('onRequest', clientLogContextHook);
    // Read after an await, as a handler's module logger would be, deep in the request.
    a.get('/ctx', async () => {
      await new Promise((r) => setImmediate(r));
      return getLogContext() ?? null;
    });
    await a.ready();
    return a;
  }

  it('stamps the mobile app with its version and platform', async () => {
    const a = await app();
    const res = await a.inject({ url: '/ctx', headers: { 'x-client': 'magick-agency-mobile/1.4.0+212 (android 14; Pixel 8)' } });
    expect(res.json()).toEqual({ client: 'mobile', clientVersion: '1.4.0+212', clientPlatform: 'android' });
    await a.close();
  });

  it('stamps web for no header, and never carries a previous request\'s fields', async () => {
    const a = await app();
    await a.inject({ url: '/ctx', headers: { 'x-client': 'magick-agency-mobile/1.0.0 (ios 17)' } });
    const res = await a.inject({ url: '/ctx' });
    expect(res.json()).toEqual({ client: 'web' });
    await a.close();
  });

  it('is registered app-wide by buildApp, first, for every route', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../../src/app.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/app\.addHook\('onRequest', clientLogContextHook\)/);
    // Before the rate limiter and every plugin, so their lines carry it too.
    expect(source.indexOf("addHook('onRequest', clientLogContextHook)")).toBeLessThan(source.indexOf('registerRateLimit(app'));
  });
});
