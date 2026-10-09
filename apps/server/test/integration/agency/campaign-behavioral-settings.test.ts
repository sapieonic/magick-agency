import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { TEST_DB_URL, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { assertBehavioralCapabilitiesForConfig } from '../../../src/agency/campaign-behavioral-settings.js';

/**
 * Plan §9: "recording and analysis are gated per field on campaign writes" — the
 * gate reading the REAL `account_settings` row (Postgres 5436) through the shared
 * repository, so a renamed column or a changed NULL default cannot pass a mocked
 * suite and still ship. NEW (magick-agency); the per-field cases themselves are the
 * ported unit suite next door.
 */

const TENANT = randomUUID();
const ACCOUNT_ON = randomUUID();
const ACCOUNT_OFF = randomUUID();
const ACCOUNT_NULL = randomUUID();
const ACCOUNT_NONE = randomUUID();

let app: FastifyInstance;

async function write(config: Record<string, unknown>, accountId: string) {
  return app.inject({ method: 'POST', url: '/campaigns', payload: { config, accountId } });
}

describe('per-field recording/analysis gate on the real settings row (integration)', () => {
  beforeAll(async () => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
    app = Fastify({ logger: false });
    app.post('/campaigns', async (request, reply) => {
      const { config, accountId } = request.body as { config: Record<string, unknown>; accountId: string };
      if (!(await assertBehavioralCapabilitiesForConfig(request, reply, config, { tenantId: TENANT, accountId }))) return;
      return reply.send({ ok: true });
    });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    accountSettingsRepository.clearCache();
    const insert = `INSERT INTO account_settings (tenant_id, account_id, allow_recording, analyze_calls) VALUES ($1, $2, $3, $4)`;
    await getPool().query(insert, [TENANT, ACCOUNT_ON, true, true]);
    await getPool().query(insert, [TENANT, ACCOUNT_OFF, false, false]);
    await getPool().query(insert, [TENANT, ACCOUNT_NULL, null, null]);
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  it('allows recording and analysis on an account whose row says true', async () => {
    const res = await write({ record_calls: true, analysis_profile_id: randomUUID() }, ACCOUNT_ON);
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['explicitly off', ACCOUNT_OFF],
    ['NULL columns', ACCOUNT_NULL],
    ['no row at all', ACCOUNT_NONE],
  ])('refuses each field separately when the row is %s', async (_label, accountId) => {
    const rec = await write({ record_calls: true }, accountId);
    expect(rec.statusCode).toBe(403);
    expect(rec.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    const ana = await write({ analysis_profile_id: randomUUID() }, accountId);
    expect(ana.statusCode).toBe(403);
    expect(ana.json()).toEqual({ error: 'capability_disabled', capability: 'agency.analytics' });
  });

  it('allows the on→off write on an account that lost both permissions', async () => {
    const res = await write({ record_calls: false, analysis_profile_id: null }, ACCOUNT_OFF);
    expect(res.statusCode).toBe(200);
  });

  it('judges the target account: a write for an OFF account is refused even though an ON account exists', async () => {
    const res = await write({ record_calls: true }, ACCOUNT_OFF);
    expect(res.statusCode).toBe(403);
  });
});
