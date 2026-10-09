import { describe, expect, it } from 'vitest';
import type { RouteOptions } from 'fastify';
import { buildApp } from '../../../src/app.js';

/**
 * Routes are enumerated from the router's own onRoute hook, never by grep: a
 * grep for `.post(` misses `app.post<{...}>(` and once reported 1 route for a
 * plugin that registers 11. The full console + super-admin path table is
 * `agency-route-table.test.ts`.
 */
async function registeredRoutes(): Promise<string[]> {
  const routes: string[] = [];
  const app = await buildApp({
    ctx: null,
    onRoute: (r: RouteOptions) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) if (m !== 'HEAD') routes.push(`${m} ${r.url}`);
    },
  });
  await app.ready();
  await app.close();
  return routes.sort();
}

describe('route table', () => {
  it('registers the health routes', async () => {
    const routes = await registeredRoutes();
    expect(routes).toEqual(expect.arrayContaining(['GET /healthz', 'GET /readyz']));
  });

  it('answers /healthz without storage', async () => {
    const app = await buildApp({ ctx: null });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('reports /readyz unavailable without storage', async () => {
    const app = await buildApp({ ctx: null });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
