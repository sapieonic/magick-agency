import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

/**
 * ─── The 0009 campaign settings, against a real Postgres ─────────────────────
 *
 * `assignment_mode`, `on_unstaff`, `callback_owner_grace_minutes`, `callback_fallback`,
 * `allow_agent_retry`, `agent_retry_rounds`, `agent_retry_cooldown_minutes`, through
 * every writer of the row, the template being `campaign-wrapup-redial-setting.test.ts`:
 * `create()` (the shared INSERT column list, COALESCEd to the column defaults),
 * `update()` (the patchable allow-list), the retry create (`retryFromCampaign`: inherit,
 * override, and `keep_assignments` both ways with its `inherited` history rows), and
 * the routes: the internal handler's POST/PATCH with the `assignment_mode` status rule
 * (D10), and the public PATCH in front of it (the 409 forwarded, the audit row on a real
 * change, the flag's 403 for a non-default setting, D9).
 *
 * Every arm reads the columns back with its own SELECT, never off the RETURNING row
 * alone (`packages/db/CLAUDE.md`: an optional input beside an explicit column list
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

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { flags, platformAudit } = vi.hoisted(() => ({
  flags: { dialer: true, assignment: true },
  platformAudit: { log: vi.fn() },
}));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: platformAudit }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({
    isEnabled: async (flag: { key: string }) =>
      flag.key === 'agency_contact_assignment_enabled' ? flags.assignment : flags.dialer,
  }),
  FLAGS: {
    agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean' },
    agency_contact_assignment_enabled: { key: 'agency_contact_assignment_enabled', type: 'boolean' },
  },
}));

// The public layer's session and tenancy: a signed-in supervisor of the default account.
const SUPERVISOR = randomUUID();
vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (request: { user?: { id: string } }) => { request.user = { id: SUPERVISOR }; },
}));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async (request: { tenantId?: string; accountId?: string }) => {
    request.tenantId = DEFAULTS.tenantId;
    request.accountId = DEFAULTS.accountId;
  },
}));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({ requirePermission: () => async () => {} }));

const { RETRY_INHERITED_CONFIG_KEYS } = await import('@magick-agency/domain/retry-campaign-bounds');
const { AGENCY_CONTACT_ASSIGNMENT_DEFAULTS } = await import('@magick-agency/contracts/agency');
const { agencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { agencyCampaignRoutes } = await import('../../../src/api/routes/agency-campaigns.routes.js');
const { proxyAgencyCampaignsRoutes } = await import('../../../src/api/routes/proxy-agency-campaigns.routes.js');
const { setCoreHandlers } = await import('../../../src/api/core-dispatch.js');
type AgencyCampaignRouteDeps = import('../../../src/api/routes/agency-campaigns.routes.js').AgencyCampaignRouteDeps;
type AgencyCampaignConfigColumns = import('../../../src/db/models/agency.model.js').AgencyCampaignConfigColumns;

const HEADERS = { 'x-mgkvc-tenant': DEFAULTS.tenantId, 'x-mgkvc-account': DEFAULTS.accountId };
const SETTING_KEYS = Object.keys(AGENCY_CONTACT_ASSIGNMENT_DEFAULTS);

/** A full set of non-default values. */
const CUSTOM = {
  assignment_mode: 'strict', on_unstaff: 'keep', callback_owner_grace_minutes: 15, callback_fallback: 'wait',
  allow_agent_retry: true, agent_retry_rounds: 3, agent_retry_cooldown_minutes: 120,
} as const;

/** The seven columns as STORED. */
async function stored(campaignId: string): Promise<Record<string, unknown>> {
  const { rows } = await getTestPool().query(
    `SELECT ${SETTING_KEYS.join(', ')} FROM agency_campaigns WHERE id = $1`,
    [campaignId],
  );
  return rows[0]!;
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

afterAll(closeTestPool);

describe('AgencyCampaignRepository — the 0009 settings round-trip', () => {
  beforeEach(truncateAll);

  it('create() with every field omitted stores the column defaults', async () => {
    const campaign = await agencyCampaignRepository.create({
      tenant_id: DEFAULTS.tenantId, account_id: DEFAULTS.accountId, name: 'Minimal', caller_ids: ['+919000000001'],
    });
    expect(await stored(campaign.id)).toEqual(AGENCY_CONTACT_ASSIGNMENT_DEFAULTS);
  });

  it('create() stores every explicit value rather than the default', async () => {
    const campaign = await agencyCampaignRepository.create({
      tenant_id: DEFAULTS.tenantId, account_id: DEFAULTS.accountId, name: 'Custom', caller_ids: ['+919000000001'],
      ...CUSTOM,
    });
    expect(await stored(campaign.id)).toEqual(CUSTOM);
    // The other end of each bound reaches the CHECKs intact too.
    const edge = await agencyCampaignRepository.create({
      tenant_id: DEFAULTS.tenantId, account_id: DEFAULTS.accountId, name: 'Edge', caller_ids: ['+919000000001'],
      assignment_mode: 'preferred', callback_owner_grace_minutes: 0, agent_retry_rounds: 10, agent_retry_cooldown_minutes: 10080,
    });
    expect(await stored(edge.id)).toMatchObject({
      assignment_mode: 'preferred', callback_owner_grace_minutes: 0, agent_retry_rounds: 10, agent_retry_cooldown_minutes: 10080,
    });
  });

  it('update() writes each, and leaves them alone when the patch does not name them', async () => {
    const campaign = await insertAgencyCampaign();
    await agencyCampaignRepository.update(campaign.id as string, { ...CUSTOM });
    expect(await stored(campaign.id as string)).toEqual(CUSTOM);
    await agencyCampaignRepository.update(campaign.id as string, { wrapup_seconds: 40 });
    expect(await stored(campaign.id as string)).toEqual(CUSTOM);
    await agencyCampaignRepository.update(campaign.id as string, { ...AGENCY_CONTACT_ASSIGNMENT_DEFAULTS });
    expect(await stored(campaign.id as string)).toEqual(AGENCY_CONTACT_ASSIGNMENT_DEFAULTS);
  });
});

describe('retryFromCampaign — the settings, and keep_assignments', () => {
  const AGENT_A = randomUUID();
  const AGENT_B = randomUUID();
  const ASSIGNER = randomUUID();
  const PARENT_STAMP = new Date('2026-01-01T00:00:00Z');

  /** A completed parent with three not-reached contacts: two owned, one in the pool. */
  async function parent(overrides: Record<string, unknown> = {}): Promise<string> {
    const p = await insertAgencyCampaign({ status: 'completed', ...CUSTOM, ...overrides });
    const base = { attempt_count: 1, last_outcome: 'no_answer', state: 'completed' };
    await insertAgencyContact(p.id as string, {
      ...base, phone_e164: '+919000000101', assigned_user_id: AGENT_A, assigned_at: PARENT_STAMP, assigned_by_user_id: ASSIGNER,
    });
    await insertAgencyContact(p.id as string, {
      ...base, phone_e164: '+919000000102', assigned_user_id: AGENT_B, assigned_at: PARENT_STAMP, assigned_by_user_id: ASSIGNER,
    });
    await insertAgencyContact(p.id as string, { ...base, phone_e164: '+919000000103' });
    return p.id as string;
  }

  async function retry(parentId: string, extra: Record<string, unknown> = {}) {
    const result = await agencyCampaignRepository.retryFromCampaign({
      parent: (await agencyCampaignRepository.findById(parentId))!,
      selector: { last_outcome: ['no_answer'] },
      name: 'Retry 1',
      config: await inheritedConfig(parentId, (extra['overrides'] as Record<string, unknown>) ?? {}),
      createdBy: null,
      idempotencyKey: null,
      ...extra,
    });
    if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`);
    return result;
  }

  async function childContacts(childId: string) {
    const { rows } = await getTestPool().query<{
      id: string; phone_e164: string; assigned_user_id: string | null; assigned_at: Date | null; assigned_by_user_id: string | null;
    }>(
      `SELECT id, phone_e164, assigned_user_id, assigned_at, assigned_by_user_id
         FROM agency_contacts WHERE campaign_id = $1 ORDER BY phone_e164`,
      [childId],
    );
    return rows;
  }

  async function events(campaignId: string) {
    const { rows } = await getTestPool().query(
      `SELECT tenant_id, contact_id, from_user_id, to_user_id, actor_user_id, reason, batch_id
         FROM agency_contact_assignment_events WHERE campaign_id = $1 ORDER BY to_user_id`,
      [campaignId],
    );
    return rows;
  }

  beforeEach(truncateAll);

  it('the child inherits the parent\'s seven settings', async () => {
    const result = await retry(await parent());
    expect(await stored(result.campaign.id)).toEqual(CUSTOM);
  });

  it('takes an override of them over the parent\'s values', async () => {
    const result = await retry(await parent(), {
      overrides: { assignment_mode: 'preferred', allow_agent_retry: false, agent_retry_rounds: 1 },
    });
    expect(await stored(result.campaign.id)).toEqual({
      ...CUSTOM, assignment_mode: 'preferred', allow_agent_retry: false, agent_retry_rounds: 1,
    });
  });

  it('keep_assignments (the default): each owned contact keeps its owner, restamped, with one inherited history row', async () => {
    const parentId = await parent();
    const before = new Date();
    const result = await retry(parentId, { actorUserId: SUPERVISOR });
    expect(result.contacts_seeded).toBe(3);
    expect(result.assignments_kept).toBe(2);

    const contacts = await childContacts(result.campaign.id);
    expect(contacts.map((c) => [c.phone_e164, c.assigned_user_id, c.assigned_by_user_id])).toEqual([
      ['+919000000101', AGENT_A, ASSIGNER],
      ['+919000000102', AGENT_B, ASSIGNER],
      ['+919000000103', null, null],
    ]);
    // `assigned_at` is when the CHILD's row got its owner, not the parent's stamp.
    for (const c of contacts.slice(0, 2)) expect(c.assigned_at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(contacts[2]!.assigned_at).toBeNull();

    const rows = await events(result.campaign.id);
    const owned = new Map(contacts.slice(0, 2).map((c) => [c.assigned_user_id, c.id]));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        tenant_id: DEFAULTS.tenantId, from_user_id: null, actor_user_id: SUPERVISOR, reason: 'inherited',
        batch_id: result.assignment_batch_id,
      });
      expect(row.contact_id).toBe(owned.get(row.to_user_id));
    }
    expect(new Set(rows.map((r) => r.batch_id)).size).toBe(1);
    // The parent's history is untouched.
    expect(await events(parentId)).toEqual([]);
  });

  it('with no actor, the inherited rows are the system\'s (actor NULL)', async () => {
    const result = await retry(await parent(), { keepAssignments: true });
    expect((await events(result.campaign.id)).map((r) => r.actor_user_id)).toEqual([null, null]);
  });

  it('keep_assignments false: every copied contact lands in the pool, and no history row is written', async () => {
    const result = await retry(await parent(), { keepAssignments: false, actorUserId: SUPERVISOR });
    expect(result.assignments_kept).toBe(0);
    expect(result.assignment_batch_id).toBeNull();
    const contacts = await childContacts(result.campaign.id);
    expect(contacts).toHaveLength(3);
    for (const c of contacts) expect([c.assigned_user_id, c.assigned_at, c.assigned_by_user_id]).toEqual([null, null, null]);
    expect(await events(result.campaign.id)).toEqual([]);
  });

  it('a cohort with no owned contact keeps nothing and writes no row', async () => {
    const p = await insertAgencyCampaign({ status: 'completed' });
    await insertAgencyContact(p.id as string, { phone_e164: '+919000000201', attempt_count: 1, last_outcome: 'no_answer', state: 'completed' });
    const result = await retry(p.id as string);
    expect(result.assignments_kept).toBe(0);
    expect(result.assignment_batch_id).toBeNull();
    expect(await events(result.campaign.id)).toEqual([]);
  });
});

describe('the routes — internal handler and the public layer in front of it (integration)', () => {
  let core: FastifyInstance;
  let app: FastifyInstance;

  beforeEach(async () => {
    await truncateAll();
    flags.dialer = true;
    flags.assignment = true;
    platformAudit.log.mockClear();
    core = Fastify({ logger: false });
    await core.register(async (scope) => agencyCampaignRoutes(scope, {} as AgencyCampaignRouteDeps), {
      prefix: '/api/v1/agency-campaigns',
    });
    await core.ready();
    setCoreHandlers(core);
    app = Fastify({ logger: false });
    await app.register(proxyAgencyCampaignsRoutes, { prefix: '/proxy/agency' });
    await app.ready();
  });

  afterEach(async () => {
    setCoreHandlers(null);
    await app?.close();
    await core?.close();
  });

  const patchCore = (id: string, payload: Record<string, unknown>) =>
    core.inject({ method: 'PATCH', url: `/api/v1/agency-campaigns/${id}`, headers: HEADERS, payload });
  const patchPublic = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/proxy/agency/campaigns/${id}`, payload });

  it('internal POST stores the settings and serves them', async () => {
    const res = await core.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Owned', caller_ids: ['+919000000001'], ...CUSTOM },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject(CUSTOM);
    expect(await stored(res.json().id)).toEqual(CUSTOM);
  });

  it('internal PATCH refuses a mode change on a RUNNING campaign (409) and writes nothing, the other settings included', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', started_at: new Date() });
    const res = await patchCore(campaign.id as string, { assignment_mode: 'strict', allow_agent_retry: true });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: 'Conflict', code: 'mode_change_requires_pause' });
    expect(await stored(campaign.id as string)).toEqual(AGENCY_CONTACT_ASSIGNMENT_DEFAULTS);
  });

  it('internal PATCH writes every other setting on a RUNNING campaign, and the unchanged mode with them', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', started_at: new Date() });
    const { assignment_mode: _mode, ...others } = CUSTOM;
    const res = await patchCore(campaign.id as string, { ...others, assignment_mode: 'pool' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stored(campaign.id as string)).toEqual({ ...CUSTOM, assignment_mode: 'pool' });
  });

  it('public PATCH: a mode change on a PAUSED campaign is written and audited once, with from and to', async () => {
    const campaign = await insertAgencyCampaign({ status: 'paused', started_at: new Date() });
    const res = await patchPublic(campaign.id as string, { assignment_mode: 'preferred' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await stored(campaign.id as string))['assignment_mode']).toBe('preferred');
    expect(platformAudit.log).toHaveBeenCalledTimes(1);
    expect(platformAudit.log).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: DEFAULTS.tenantId, account_id: DEFAULTS.accountId, actor_type: 'human', user_id: SUPERVISOR,
      action: 'agency_campaign.assignment_mode_changed', campaign_id: campaign.id,
      details: { campaign_id: campaign.id, from: 'pool', to: 'preferred' },
    }));

    // The same mode again is not a change: written, not audited.
    platformAudit.log.mockClear();
    const again = await patchPublic(campaign.id as string, { assignment_mode: 'preferred' });
    expect(again.statusCode).toBe(200);
    expect(platformAudit.log).not.toHaveBeenCalled();
  });

  it('public PATCH: a mode change on a RUNNING campaign is the handler\'s 409, forwarded, with nothing written or audited', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', started_at: new Date() });
    const res = await patchPublic(campaign.id as string, { assignment_mode: 'strict' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: 'Conflict', code: 'mode_change_requires_pause' });
    expect((await stored(campaign.id as string))['assignment_mode']).toBe('pool');
    expect(platformAudit.log).not.toHaveBeenCalled();
  });

  it('public PATCH with the flag off: a non-default setting is 403 feature_disabled and the row is untouched; the defaults save', async () => {
    flags.assignment = false;
    const campaign = await insertAgencyCampaign({ status: 'paused', started_at: new Date() });
    const refused = await patchPublic(campaign.id as string, { allow_agent_retry: true });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'feature_disabled' });
    const catalog = await patchPublic(campaign.id as string, {
      disposition_catalog: [{ code: 'promise_to_pay', label: 'Promise to pay', override: { extra_attempts: 2 } }],
    });
    expect(catalog.statusCode, catalog.body).toBe(403);
    expect(await stored(campaign.id as string)).toEqual(AGENCY_CONTACT_ASSIGNMENT_DEFAULTS);

    const defaults = await patchPublic(campaign.id as string, { ...AGENCY_CONTACT_ASSIGNMENT_DEFAULTS, wrapup_seconds: 45 });
    expect(defaults.statusCode, defaults.body).toBe(200);
    expect(platformAudit.log).not.toHaveBeenCalled();
  });

  it('internal retry create: keep_assignments false lands the cohort in the pool; a non-boolean is a 400', async () => {
    const p = await insertAgencyCampaign({ status: 'completed' });
    await insertAgencyContact(p.id as string, {
      phone_e164: '+919000000301', attempt_count: 1, last_outcome: 'no_answer', state: 'completed',
      assigned_user_id: randomUUID(), assigned_at: new Date(),
    });
    const bad = await core.inject({
      method: 'POST', url: `/api/v1/agency-campaigns/${p.id}/retry`, headers: HEADERS,
      payload: { selector: { last_outcome: ['no_answer'] }, keep_assignments: 'no' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details).toEqual({ keep_assignments: 'keep_assignments must be a boolean.' });

    const pooled = await core.inject({
      method: 'POST', url: `/api/v1/agency-campaigns/${p.id}/retry`, headers: HEADERS,
      payload: { selector: { last_outcome: ['no_answer'] }, keep_assignments: false, agent_user_id: SUPERVISOR },
    });
    expect(pooled.statusCode, pooled.body).toBe(201);
    const { rows } = await getTestPool().query(
      'SELECT assigned_user_id FROM agency_contacts WHERE campaign_id = $1', [pooled.json().campaign.id],
    );
    expect(rows).toEqual([{ assigned_user_id: null }]);
  });

  it('public retry create: the owner is kept by default, and the history names the supervisor', async () => {
    const owner = randomUUID();
    const p = await insertAgencyCampaign({ status: 'completed' });
    await insertAgencyContact(p.id as string, {
      phone_e164: '+919000000401', attempt_count: 1, last_outcome: 'no_answer', state: 'completed',
      assigned_user_id: owner, assigned_at: new Date(),
    });
    const res = await app.inject({
      method: 'POST', url: `/proxy/agency/campaigns/${p.id}/retry`,
      payload: { selector: { last_outcome: ['no_answer'] } },
    });
    expect(res.statusCode, res.body).toBe(201);
    const childId = res.json().campaign.id as string;
    const { rows } = await getTestPool().query(
      `SELECT c.assigned_user_id, e.actor_user_id, e.reason
         FROM agency_contacts c JOIN agency_contact_assignment_events e ON e.contact_id = c.id
        WHERE c.campaign_id = $1`,
      [childId],
    );
    expect(rows).toEqual([{ assigned_user_id: owner, actor_user_id: SUPERVISOR, reason: 'inherited' }]);
  });
});
