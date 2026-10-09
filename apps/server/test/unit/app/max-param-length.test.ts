import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * NEW (magick-agency, Phase 8 delta review 6): the public app carries master's
 * `maxParamLength: 200` (master `src/index.ts:330`). A 150-character id reaches the ROUTE, which
 * gives its own answer (each family's malformed-id 404 body), rather than find-my-way's route-not-found 404 at the
 * default 100. Mutation-checked: removing `routerOptions.maxParamLength` reds both cases.
 */

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildApp } from '../../../src/app.js';

const LONG = 'x'.repeat(150);
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ ctx: null });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('maxParamLength 200 on the public app', () => {
  it('a 150-char DNC id reaches the route: its own 404, not route-not-found', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/dnc/${LONG}` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found', message: 'DNC entry not found' });
  });

  it("a 150-char campaign id reaches the route: the campaign family's own 404 body", async () => {
    const res = await app.inject({ method: 'GET', url: `/proxy/agency/campaigns/${LONG}/stats` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found' });
  });
});
