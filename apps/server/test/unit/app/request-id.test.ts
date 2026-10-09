import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * NEW (magick-agency, Phase 8 review N4): master's `genReqId` (master `src/index.ts:331-340`) in
 * `app.ts` — the client's `x-request-id`, else the active trace id, else a UUID — so the id a
 * masked 5xx body tells the user to quote is unique, and is the one on the response header.
 * Mutation-checked: removing `genReqId` makes ids `req-N` and reds the first case.
 */

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildApp } from '../../../src/app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ ctx: null });
  await app.register(async (scope) => {
    scope.get('/__test/boom', async () => { throw new Error('internal detail'); });
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('request ids (master genReqId)', () => {
  it('two requests get distinct UUID ids, and the masked 5xx body quotes the response header', async () => {
    const a = await app.inject({ method: 'GET', url: '/__test/boom' });
    const b = await app.inject({ method: 'GET', url: '/__test/boom' });
    for (const res of [a, b]) {
      expect(res.statusCode).toBe(500);
      expect(res.json().requestId).toMatch(UUID);
      expect(res.headers['x-request-id']).toBe(res.json().requestId);
      expect(res.body).not.toContain('internal detail');
    }
    expect(a.json().requestId).not.toBe(b.json().requestId);
  });

  it("honours the client's x-request-id", async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/boom', headers: { 'x-request-id': 'client-abc-123' } });
    expect(res.json().requestId).toBe('client-abc-123');
  });
});
