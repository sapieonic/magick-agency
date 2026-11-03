import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { insertAgencyCampaign } from './agency-factories.js';

/**
 * ─── `agency_campaigns.allow_wrapup_redial` (0008), against a real Postgres ────
 *
 * The campaign setting behind wrap-up redial, through every writer of the row:
 * `create()` (the shared INSERT column list, COALESCEd to the column default),
 * `update()` (the patchable allow-list) and the PATCH route, and the retry create
 * (`retryFromCampaign`, which binds the same column list from the inherited config).
 *
 * The rule this pins is `packages/db/CLAUDE.md`'s: an optional field on a create
 * input plus an explicit INSERT column list typechecks and silently drops the
 * value. Every arm reads the column back with its own SELECT, never off the
 * RETURNING row alone.
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

const { RETRY_INHERITED_CONFIG_KEYS } = await import('@magick-agency/domain/retry-campaign-bounds');
const { agencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { agencyCampaignRoutes } = await import('../../../src/api/routes/agency-campaigns.routes.js');
type AgencyCampaignRouteDeps = import('../../../src/api/routes/agency-campaigns.routes.js').AgencyCampaignRouteDeps;
type AgencyCampaignConfigColumns = import('../../../src/db/models/agency.model.js').AgencyCampaignConfigColumns;

const HEADERS = { 'x-mgkvc-tenant': DEFAULTS.tenantId, 'x-mgkvc-account': DEFAULTS.accountId };

/** The column as STORED. */
async function stored(campaignId: string): Promise<unknown> {
  const { rows } = await getTestPool().query<{ allow_wrapup_redial: unknown }>(
    'SELECT allow_wrapup_redial FROM agency_campaigns WHERE id = $1',
    [campaignId],
  );
  return rows[0]!.allow_wrapup_redial;
}

/** What the retry route hands the repository: the parent's config keys, overrides on top. */
async function inheritedConfig(
  parentId: string,
  overrides: Record<string, unknown> = {},
): Promise<AgencyCampaignConfigColumns> {
  const parent = (await agencyCampaignRepository.findById(parentId))!;
  return {
    ...Object.fromEntries(
      RETRY_INHERITED_CONFIG_KEYS.map((k) => [k, (parent as unknown as Record<string, unknown>)[k]]),
    ),
    ...overrides,
  } as AgencyCampaignConfigColumns;
}

/** A parent with one retryable contact, so a retry create has something to seed. */
async function parentWithContact(allowWrapupRedial: boolean): Promise<string> {
  const parent = await insertAgencyCampaign({ allow_wrapup_redial: allowWrapupRedial, status: 'completed' });
  await getTestPool().query(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, attempt_count, last_outcome, state)
     VALUES ($1, $2, $3, '+919000000101', 1, 'no_answer', 'completed')`,
    [parent.id, DEFAULTS.tenantId, DEFAULTS.accountId],
  );
  return parent.id as string;
}

afterAll(closeTestPool);

describe('AgencyCampaignRepository — allow_wrapup_redial round-trips', () => {
  beforeEach(truncateAll);

  it('create() with the field omitted stores the column default, false', async () => {
    const campaign = await agencyCampaignRepository.create({
      tenant_id: DEFAULTS.tenantId, account_id: DEFAULTS.accountId,
      name: 'Minimal', caller_ids: ['+919000000001'],
    });
    expect(campaign.allow_wrapup_redial).toBe(false);
    expect(await stored(campaign.id)).toBe(false);
  });

  it('create() stores an explicit true rather than the default', async () => {
    const campaign = await agencyCampaignRepository.create({
      tenant_id: DEFAULTS.tenantId, account_id: DEFAULTS.accountId,
      name: 'Redial on', caller_ids: ['+919000000001'], allow_wrapup_redial: true,
    });
    expect(campaign.allow_wrapup_redial).toBe(true);
    expect(await stored(campaign.id)).toBe(true);
    expect((await agencyCampaignRepository.findById(campaign.id))!.allow_wrapup_redial).toBe(true);
  });

  it('update() turns it on and off, and leaves it alone when the patch does not name it', async () => {
    const campaign = await insertAgencyCampaign();
    expect(await stored(campaign.id as string)).toBe(false);

    expect((await agencyCampaignRepository.update(campaign.id as string, { allow_wrapup_redial: true }))!
      .allow_wrapup_redial).toBe(true);
    expect(await stored(campaign.id as string)).toBe(true);

    await agencyCampaignRepository.update(campaign.id as string, { wrapup_seconds: 40 });
    expect(await stored(campaign.id as string)).toBe(true);

    await agencyCampaignRepository.update(campaign.id as string, { allow_wrapup_redial: false });
    expect(await stored(campaign.id as string)).toBe(false);
  });
});

describe('retryFromCampaign — the child copies allow_wrapup_redial', () => {
  beforeEach(truncateAll);

  it('inherits the parent\'s true', async () => {
    const parentId = await parentWithContact(true);
    const result = await agencyCampaignRepository.retryFromCampaign({
      parent: (await agencyCampaignRepository.findById(parentId))!,
      selector: { last_outcome: ['no_answer'] },
      name: 'Retry 1',
      config: await inheritedConfig(parentId),
      createdBy: null,
      idempotencyKey: null,
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.campaign.allow_wrapup_redial).toBe(true);
    expect(await stored(result.campaign.id)).toBe(true);
  });

  it('takes an override of it over the parent\'s value', async () => {
    const parentId = await parentWithContact(true);
    const result = await agencyCampaignRepository.retryFromCampaign({
      parent: (await agencyCampaignRepository.findById(parentId))!,
      selector: { last_outcome: ['no_answer'] },
      name: 'Retry 1',
      config: await inheritedConfig(parentId, { allow_wrapup_redial: false }),
      createdBy: null,
      idempotencyKey: null,
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(await stored(result.campaign.id)).toBe(false);
  });
});

describe('the internal campaign routes — allow_wrapup_redial (integration)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await truncateAll();
    flags.isEnabled.mockResolvedValue(true);
    app = Fastify({ logger: false });
    await app.register(async (scope) => agencyCampaignRoutes(scope, {} as AgencyCampaignRouteDeps), {
      prefix: '/api/v1/agency-campaigns',
    });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('POST stores it and serves it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Redial on', caller_ids: ['+919000000001'], allow_wrapup_redial: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().allow_wrapup_redial).toBe(true);
    expect(await stored(res.json().id)).toBe(true);
  });

  it('PATCH writes it on a RUNNING campaign and GET serves it', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', started_at: new Date() });
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/agency-campaigns/${campaign.id}`, headers: HEADERS,
      payload: { allow_wrapup_redial: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stored(campaign.id as string)).toBe(true);

    const read = await app.inject({
      method: 'GET', url: `/api/v1/agency-campaigns/${campaign.id}`, headers: HEADERS,
    });
    expect(read.json().allow_wrapup_redial).toBe(true);
  });

  it('PATCH refuses null with a 400 rather than reaching the NOT NULL as a 500', async () => {
    const campaign = await insertAgencyCampaign({ allow_wrapup_redial: true });
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/agency-campaigns/${campaign.id}`, headers: HEADERS,
      payload: { allow_wrapup_redial: null },
    });
    expect(res.statusCode).toBe(400);
    expect(await stored(campaign.id as string)).toBe(true);
  });
});
