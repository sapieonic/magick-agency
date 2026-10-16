import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { insertAgencyCampaign } from './agency-factories.js';

/**
 * ─── `AgencyCampaignRepository.update()` and `PATCH /:id`, against a real Postgres ─
 *
 * `break_reasons` is a JSONB column and is on `update()`'s allow-list, but it was
 * missing from the set of columns the method JSON-encodes. Bound as a JS array,
 * node-pg serialises it as a Postgres ARRAY literal (`{"{\"code\":…}"}`), which a
 * jsonb column refuses with `22P02` — so every PATCH carrying a non-empty list
 * 500'd. An empty list became the literal `{}`, a jsonb OBJECT, which
 * `ck_agency_campaign_break_reasons` refuses (`23514`), so clearing the list 500'd
 * too. The unit tier mocks the pool, so the bound value is asserted but never
 * parsed; only `create()` had a real-database test.
 *
 * Both arms go through the real repository, and the last through the real route,
 * because the route passes the body straight through (`update(campaign.id, body)`)
 * and is where an operator actually reaches this.
 */

vi.mock('@magick-agency/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({
  auditLogger: { log: vi.fn() },
}));

const { flags } = vi.hoisted(() => ({
  flags: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean' } },
}));

const { agencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { agencyCampaignRoutes } = await import('../../../src/api/routes/agency-campaigns.routes.js');
type AgencyCampaignRouteDeps = import('../../../src/api/routes/agency-campaigns.routes.js').AgencyCampaignRouteDeps;

const REASONS = [
  { code: 'lunch', label: 'Lunch' },
  { code: 'training', label: 'Training' },
];

/** The column as STORED, with its jsonb type — not the RETURNING row, which proves nothing about storage. */
async function storedBreakReasons(campaignId: string): Promise<{ value: unknown; type: string }> {
  const { rows } = await getTestPool().query<{ value: unknown; type: string }>(
    'SELECT break_reasons AS value, jsonb_typeof(break_reasons) AS type FROM agency_campaigns WHERE id = $1',
    [campaignId],
  );
  return rows[0]!;
}

describe('AgencyCampaignRepository.update — JSONB columns, against a real Postgres', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('stores a non-empty break_reasons list as a jsonb ARRAY (it 22P02\'d as a pg array literal)', async () => {
    const campaign = await insertAgencyCampaign();

    const updated = await agencyCampaignRepository.update(campaign.id, { break_reasons: REASONS });

    expect(updated!.break_reasons).toEqual(REASONS);
    expect(await storedBreakReasons(campaign.id)).toEqual({ value: REASONS, type: 'array' });
  });

  it('stores an empty list as [] (it became the jsonb object {}, refused by the CHECK)', async () => {
    const campaign = await insertAgencyCampaign({ break_reasons: JSON.stringify(REASONS) });

    await agencyCampaignRepository.update(campaign.id, { break_reasons: [] });

    expect(await storedBreakReasons(campaign.id)).toEqual({ value: [], type: 'array' });
  });

  it('still encodes the other JSONB columns and leaves scalar columns alone', async () => {
    const campaign = await insertAgencyCampaign();

    const updated = await agencyCampaignRepository.update(campaign.id, {
      retry_policy: { no_answer: { max_attempts: 2, backoff_seconds: 300 } },
      disposition_catalog: [{ code: 'sale', label: 'Sale', is_success: true }],
      context_display: { hero: ['Name'] },
      caller_ids: ['+919000000009'],
      wrapup_seconds: 40,
    });

    expect(updated!.retry_policy).toEqual({ no_answer: { max_attempts: 2, backoff_seconds: 300 } });
    expect(updated!.disposition_catalog).toEqual([{ code: 'sale', label: 'Sale', is_success: true }]);
    expect(updated!.context_display).toEqual({ hero: ['Name'] });
    expect(updated!.caller_ids).toEqual(['+919000000009']);
    expect(updated!.wrapup_seconds).toBe(40);
  });
});

describe('PATCH /api/v1/agency-campaigns/:id — break_reasons (integration)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await truncateAll();
    flags.isEnabled.mockResolvedValue(true);
    app = Fastify({ logger: false });
    // The deps are not read by PATCH; registered through a closure as `src/index.ts` does.
    await app.register(async (scope) => agencyCampaignRoutes(scope, {} as AgencyCampaignRouteDeps), {
      prefix: '/api/v1/agency-campaigns',
    });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('answers 200 and stores the list the operator sent', async () => {
    const campaign = await insertAgencyCampaign();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/agency-campaigns/${campaign.id}`,
      headers: { 'x-mgkvc-tenant': DEFAULTS.tenantId, 'x-mgkvc-account': DEFAULTS.accountId },
      payload: { break_reasons: REASONS },
    });

    expect(res.statusCode).toBe(200);
    expect(await storedBreakReasons(campaign.id)).toEqual({ value: REASONS, type: 'array' });
  });
});
