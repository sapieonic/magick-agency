import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

/**
 * ─── `agency_campaigns.outcome_dispositions` (0019), against a real Postgres ────
 *
 * Automatic outcomes for unanswered calls (OD1–OD8): the campaign setting through every
 * writer of the row. `create()` (the shared INSERT column list, COALESCEd to the column
 * default `{}`), `update()` (the patchable allow-list and the JSONB cast), the retry create
 * (`retryFromCampaign`, which binds the same column list from the inherited config), and
 * the internal POST / PATCH / retry routes with their cross-check against the catalog
 * (`validateOutcomeDispositions` through `configRejected`: the column defaults on a create,
 * the stored campaign on a PATCH, the parent on a retry).
 *
 * Every arm reads the column back with its own SELECT, never off the RETURNING row alone
 * (`packages/db/CLAUDE.md`: an optional create field beside an explicit column list
 * typechecks and silently drops the value).
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

const RETRY_LATER = { code: 'retry_later', label: 'Retry later' };
const CALLBACK = { code: 'callback', label: 'Callback' };
const SWITCHED_OFF = { code: 'switched_off', label: 'Switched off' };
const DNC = { code: 'do_not_call', label: 'Do not call', suppress: true };
const CLOSED = { code: 'closed', label: 'Closed', terminal: true };
const CATALOG = [RETRY_LATER, CALLBACK, SWITCHED_OFF, DNC, CLOSED];
const MAP = { busy: 'retry_later', no_answer: 'callback' };

/** The column as STORED. */
async function stored(campaignId: string): Promise<unknown> {
  const { rows } = await getTestPool().query<{ outcome_dispositions: unknown }>(
    'SELECT outcome_dispositions FROM agency_campaigns WHERE id = $1',
    [campaignId],
  );
  return rows[0]!.outcome_dispositions;
}

/** A campaign row carrying `CATALOG` and `map`, written around the API. */
async function campaignWith(map: Record<string, string>, extra: Record<string, unknown> = {}) {
  return insertAgencyCampaign({
    disposition_catalog: JSON.stringify(CATALOG),
    outcome_dispositions: JSON.stringify(map),
    ...extra,
  });
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

/** A completed parent with one retryable contact, so a retry create has something to seed. */
async function parentWithContact(map: Record<string, string>): Promise<string> {
  const parent = await campaignWith(map, { status: 'completed' });
  await insertAgencyContact(parent.id as string, {
    phone_e164: '+919000000101', attempt_count: 1, last_outcome: 'no_answer', state: 'completed',
  });
  return parent.id as string;
}

afterAll(closeTestPool);

describe('AgencyCampaignRepository — outcome_dispositions round-trips', () => {
  beforeEach(truncateAll);

  it('create() with the field omitted stores the column default, {}', async () => {
    const campaign = await agencyCampaignRepository.create({
      tenant_id: DEFAULTS.tenantId, account_id: DEFAULTS.accountId,
      name: 'Minimal', caller_ids: ['+919000000001'],
    });
    expect(campaign.outcome_dispositions).toEqual({});
    expect(await stored(campaign.id)).toEqual({});
  });

  it('create() stores an explicit map rather than the default', async () => {
    const campaign = await agencyCampaignRepository.create({
      tenant_id: DEFAULTS.tenantId, account_id: DEFAULTS.accountId,
      name: 'Mapped', caller_ids: ['+919000000001'],
      disposition_catalog: CATALOG as never, outcome_dispositions: MAP,
    });
    expect(campaign.outcome_dispositions).toEqual(MAP);
    expect(await stored(campaign.id)).toEqual(MAP);
    expect((await agencyCampaignRepository.findById(campaign.id))!.outcome_dispositions).toEqual(MAP);
  });

  it('update() sets it, leaves it alone when the patch does not name it, and clears it with {}', async () => {
    const campaign = await insertAgencyCampaign({ disposition_catalog: JSON.stringify(CATALOG) });
    expect(await stored(campaign.id as string)).toEqual({});

    expect((await agencyCampaignRepository.update(campaign.id as string, { outcome_dispositions: MAP }))!
      .outcome_dispositions).toEqual(MAP);
    expect(await stored(campaign.id as string)).toEqual(MAP);

    await agencyCampaignRepository.update(campaign.id as string, { wrapup_seconds: 40 });
    expect(await stored(campaign.id as string)).toEqual(MAP);

    await agencyCampaignRepository.update(campaign.id as string, { outcome_dispositions: {} });
    expect(await stored(campaign.id as string)).toEqual({});
  });
});

describe('retryFromCampaign — the child copies outcome_dispositions', () => {
  beforeEach(truncateAll);

  it('the inherited key list names it', () => {
    expect(RETRY_INHERITED_CONFIG_KEYS).toContain('outcome_dispositions');
  });

  it('inherits the parent\'s map, beside the parent\'s catalog', async () => {
    const parentId = await parentWithContact(MAP);
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
    expect(result.campaign.outcome_dispositions).toEqual(MAP);
    expect(await stored(result.campaign.id)).toEqual(MAP);
    expect(result.campaign.disposition_catalog).toEqual(CATALOG);
  });

  it('takes an override of it over the parent\'s map', async () => {
    const parentId = await parentWithContact(MAP);
    const result = await agencyCampaignRepository.retryFromCampaign({
      parent: (await agencyCampaignRepository.findById(parentId))!,
      selector: { last_outcome: ['no_answer'] },
      name: 'Retry 1',
      config: await inheritedConfig(parentId, { outcome_dispositions: { busy: 'switched_off' } }),
      createdBy: null,
      idempotencyKey: null,
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(await stored(result.campaign.id)).toEqual({ busy: 'switched_off' });
  });
});

describe('the internal campaign routes — outcome_dispositions (integration)', () => {
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

  async function countCampaigns(): Promise<number> {
    const { rows } = await getTestPool().query<{ n: number }>('SELECT count(*)::int AS n FROM agency_campaigns');
    return rows[0]!.n;
  }

  it('POST stores it and serves it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Mapped', caller_ids: ['+919000000001'], disposition_catalog: CATALOG, outcome_dispositions: MAP },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().outcome_dispositions).toEqual(MAP);
    expect(await stored(res.json().id)).toEqual(MAP);
  });

  it('POST without the field stores {}', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Unmapped', caller_ids: ['+919000000001'], disposition_catalog: CATALOG },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await stored(res.json().id)).toEqual({});
  });

  it('POST refuses a map naming a code that is not in the body\'s catalog, keyed on the mapping, and creates nothing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: {
        name: 'Bad map', caller_ids: ['+919000000001'],
        disposition_catalog: CATALOG, outcome_dispositions: { busy: 'not_a_code' },
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details['outcome_dispositions.busy']).toMatch(/'not_a_code' is not in this campaign's outcome list/);
    expect(await countCampaigns()).toBe(0);
  });

  it('POST refuses a map with no catalog at all: the create\'s base is the column default []', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'No catalog', caller_ids: ['+919000000001'], outcome_dispositions: { busy: 'retry_later' } },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(Object.keys(res.json().details)).toEqual(['outcome_dispositions.busy']);
    expect(await countCampaigns()).toBe(0);
  });

  it('POST refuses mapping to a suppressing entry (do_not_call) and to a terminal one', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: {
        name: 'Suppress', caller_ids: ['+919000000001'],
        disposition_catalog: CATALOG, outcome_dispositions: { busy: 'do_not_call', no_answer: 'closed' },
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details['outcome_dispositions.busy']).toMatch(/stops the number being called/);
    expect(res.json().details['outcome_dispositions.no_answer']).toMatch(/closes the contact/);
    expect(await countCampaigns()).toBe(0);
  });

  it('PATCH writes a map on a RUNNING campaign and GET serves it', async () => {
    const campaign = await insertAgencyCampaign({
      status: 'running', started_at: new Date(), disposition_catalog: JSON.stringify(CATALOG),
    });
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/agency-campaigns/${campaign.id}`, headers: HEADERS,
      payload: { outcome_dispositions: MAP },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stored(campaign.id as string)).toEqual(MAP);

    const read = await app.inject({
      method: 'GET', url: `/api/v1/agency-campaigns/${campaign.id}`, headers: HEADERS,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().outcome_dispositions).toEqual(MAP);
  });

  it('PATCH clears the map with {}', async () => {
    const campaign = await campaignWith(MAP, { status: 'running', started_at: new Date() });
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/agency-campaigns/${campaign.id}`, headers: HEADERS,
      payload: { outcome_dispositions: {} },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stored(campaign.id as string)).toEqual({});
  });

  it('PATCH of a map alone is checked against the STORED catalog', async () => {
    const campaign = await campaignWith({});
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/agency-campaigns/${campaign.id}`, headers: HEADERS,
      payload: { outcome_dispositions: { failed: 'not_a_code' } },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(Object.keys(res.json().details)).toEqual(['outcome_dispositions.failed']);
    expect(await stored(campaign.id as string)).toEqual({});
  });

  it('PATCH of a catalog that drops a mapped code is refused, keyed on the mapping, and the row is unchanged', async () => {
    const campaign = await campaignWith(MAP);
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/agency-campaigns/${campaign.id}`, headers: HEADERS,
      payload: { disposition_catalog: [CALLBACK, SWITCHED_OFF, DNC, CLOSED] },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(Object.keys(res.json().details)).toEqual(['outcome_dispositions.busy']);
    expect(res.json().details['outcome_dispositions.busy']).toMatch(/no longer has 'retry_later'/);
    expect(await stored(campaign.id as string)).toEqual(MAP);
    const { rows } = await getTestPool().query('SELECT disposition_catalog FROM agency_campaigns WHERE id = $1', [campaign.id]);
    expect(rows[0].disposition_catalog).toEqual(CATALOG);
  });

  it('PATCH of a catalog that makes a mapped code suppress is refused, keyed on the mapping', async () => {
    const campaign = await campaignWith(MAP);
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/agency-campaigns/${campaign.id}`, headers: HEADERS,
      payload: { disposition_catalog: [{ ...RETRY_LATER, suppress: true }, CALLBACK, SWITCHED_OFF, DNC, CLOSED] },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(Object.keys(res.json().details)).toEqual(['outcome_dispositions.busy']);
    expect(await stored(campaign.id as string)).toEqual(MAP);
  });

  it('PATCH of a catalog that keeps every mapped code is accepted', async () => {
    const campaign = await campaignWith(MAP);
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/agency-campaigns/${campaign.id}`, headers: HEADERS,
      payload: { disposition_catalog: [RETRY_LATER, CALLBACK] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stored(campaign.id as string)).toEqual(MAP);
  });

  it('PATCH refuses a key that is not an unanswered outcome (connected), with its reason', async () => {
    const campaign = await campaignWith({});
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/agency-campaigns/${campaign.id}`, headers: HEADERS,
      payload: { outcome_dispositions: { connected: 'callback' } },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details['outcome_dispositions.connected'])
      .toMatch(/'connected' cannot have an automatic outcome: an agent spoke to the customer/);
    expect(await stored(campaign.id as string)).toEqual({});
  });

  it('PATCH refuses null and an array rather than reaching the CHECK as a 500', async () => {
    const campaign = await campaignWith(MAP);
    for (const payload of [{ outcome_dispositions: null }, { outcome_dispositions: ['busy'] }]) {
      const res = await app.inject({
        method: 'PATCH', url: `/api/v1/agency-campaigns/${campaign.id}`, headers: HEADERS, payload,
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().details).toHaveProperty('outcome_dispositions');
    }
    expect(await stored(campaign.id as string)).toEqual(MAP);
  });

  it('the retry route inherits the parent\'s map', async () => {
    const parentId = await parentWithContact(MAP);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/agency-campaigns/${parentId}/retry`, headers: HEADERS,
      payload: { selector: { last_outcome: ['no_answer'] } },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().campaign.outcome_dispositions).toEqual(MAP);
    expect(await stored(res.json().campaign.id)).toEqual(MAP);
  });

  it('the retry route takes an override checked against the parent\'s catalog', async () => {
    const parentId = await parentWithContact(MAP);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/agency-campaigns/${parentId}/retry`, headers: HEADERS,
      payload: { selector: { last_outcome: ['no_answer'] }, config_overrides: { outcome_dispositions: { failed: 'switched_off' } } },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await stored(res.json().campaign.id)).toEqual({ failed: 'switched_off' });
  });

  it('the retry route refuses an override map naming a code absent from the parent\'s catalog, and creates nothing', async () => {
    const parentId = await parentWithContact(MAP);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/agency-campaigns/${parentId}/retry`, headers: HEADERS,
      payload: { selector: { last_outcome: ['no_answer'] }, config_overrides: { outcome_dispositions: { busy: 'not_a_code' } } },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(Object.keys(res.json().details)).toEqual(['outcome_dispositions.busy']);
    expect(await countCampaigns()).toBe(1);
  });

  it('the retry route refuses a catalog override that drops a code the inherited map names', async () => {
    const parentId = await parentWithContact(MAP);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/agency-campaigns/${parentId}/retry`, headers: HEADERS,
      payload: { selector: { last_outcome: ['no_answer'] }, config_overrides: { disposition_catalog: [RETRY_LATER] } },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(Object.keys(res.json().details)).toEqual(['outcome_dispositions.no_answer']);
    expect(await countCampaigns()).toBe(1);
  });
});
