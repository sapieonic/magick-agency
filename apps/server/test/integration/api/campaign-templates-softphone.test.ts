import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * The soft phone's untagged outcomes follow the account's campaign template (docs/campaign-templates.md
 * CT11), on real Postgres: through the REAL app for what the console and the agent app read (the
 * settings' `outcomes_template`, the bootstrap's `untagged.disposition_catalog`), and through
 * `SoftphoneService.submitDisposition` for the outcome a call is saved and settled against.
 *
 * Pinned here: with the flag on and the soft phone setting none of its own, untagged calls use the
 * account's default template chain's outcomes (the account's default, else the organisation's), read
 * live (a template edited after is followed at once); the soft phone's own list wins, and the
 * settings still name what "Follow" would give (`outcomes_template`, on the PUT's answer too); the
 * followed catalog passes the soft phone's own catalog rules (no override, no promise); with the
 * flag off the built-in outcomes, as before; a tagged call keeps its campaign's; the source stays
 * `softphone`.
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import { randomUUID } from 'node:crypto';
import { closePool, initDbPool } from '@magick-agency/db';
import { AGENCY_DEFAULT_DISPOSITION_CATALOG, type AgencyDisposition, type AgencySoftphoneSettingsResponse } from '@magick-agency/contracts/agency';
import type { AgencyCampaignTemplate } from '@magick-agency/contracts/api/agency/campaign-templates';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { insertAgencyCampaign, insertManualCall, insertSoftphoneSession } from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { SoftphoneService, type SoftphoneServiceDeps } from '../../../src/agency/softphone/softphone-service.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

let app: FastifyInstance;
let w: { tenant: string; a: string; org: string; sup: string; supId: string };

async function setFlag(flag: string, on: boolean): Promise<void> {
  await q(`DELETE FROM feature_flag_overrides WHERE flag_key = $1 AND tenant_id = $2`, [flag, w.tenant]);
  await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ($1, 'tenant', $2, $3::jsonb)`,
    [flag, w.tenant, on ? 'true' : 'false']);
  await getFeatureFlagService().invalidate({ tenantId: w.tenant });
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (token.startsWith('tok:')) return { uid: token.slice(4), email: `${token.slice(4)}@example.com`, email_verified: true };
    throw new Error('bad token');
  });
  app = await buildApp({ ctx: null });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  const tenant = (await insertTenant()).id as string;
  const a = (await insertAccount({ tenant_id: tenant })).id as string;
  const org = await insertUser({ display_name: 'Olga Admin' });
  await insertMembership({ user_id: org.id, tenant_id: tenant, account_id: null, role: 'tenant_admin' });
  const sup = await insertUser({ display_name: 'Sam Supervisor' });
  await insertMembership({ user_id: sup.id, tenant_id: tenant, account_id: a, role: 'account_admin' });
  w = { tenant, a, org: org.firebase_uid as string, sup: sup.firebase_uid as string, supId: sup.id as string };
  for (const flag of ['agency_dialer_enabled', 'agency_softphone_enabled', 'agency_campaign_templates_enabled']) await setFlag(flag, true);
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

const as = (uid: string, account: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({
    method, url: `/proxy/agency${url}`,
    headers: { authorization: `Bearer tok:${uid}`, 'x-tenant-id': w.tenant, ...(account ? { 'x-account-id': account } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const ACCOUNT_OUTCOMES: AgencyDisposition[] = [{ code: 'will_pay', label: 'Will pay' }, { code: 'refused', label: 'Refused' }];
const ORG_OUTCOMES: AgencyDisposition[] = [{ code: 'paid_already', label: 'Paid already' }];
const OWN: AgencyDisposition[] = [{ code: 'sold', label: 'Sold', is_success: true }];

async function template(scope: 'organisation' | 'account', catalog: AgencyDisposition[]): Promise<AgencyCampaignTemplate> {
  const body = { scope, name: `T ${randomUUID().slice(0, 6)}`, sections: { outcomes: { disposition_catalog: catalog } }, make_default: true };
  const res = scope === 'organisation' ? await as(w.org, null, 'POST', '/campaign-templates', body) : await as(w.sup, w.a, 'POST', '/campaign-templates', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function readSettings(): Promise<AgencySoftphoneSettingsResponse> {
  const res = await as(w.sup, w.a, 'GET', '/softphone/settings');
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
async function untaggedPad(): Promise<AgencyDisposition[]> {
  const res = await as(w.sup, w.a, 'GET', '/softphone/bootstrap');
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { untagged: { disposition_catalog: AgencyDisposition[] } }).untagged.disposition_catalog;
}
async function ownCatalog(catalog: AgencyDisposition[]): Promise<void> {
  const res = await as(w.sup, w.a, 'PUT', '/softphone/settings', {
    disposition_catalog: catalog, call_fields: [], analysis_profile_id: null, record_calls: false, default_caller_id: null,
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** The service with its runtime collaborators stubbed: the outcome's catalog and write are what is under test. */
function service(): SoftphoneService {
  const deps = {
    agents: { releaseManual: vi.fn(async () => undefined) },
    manual: { sendFrame: vi.fn(async () => ({ stub: true })), wireFor: vi.fn(async () => ({ stub: true })) },
  } as unknown as SoftphoneServiceDeps;
  return new SoftphoneService(deps);
}

/** An untagged (or tagged) bridged call of the supervisor that ended, owing its outcome. */
async function endedCall(campaignId: string | null = null): Promise<string> {
  const session = await insertSoftphoneSession({ tenant_id: w.tenant, account_id: w.a, agent_user_id: w.supId });
  const call = await insertManualCall(session, {
    campaign_id: campaignId, state: 'ended', ended_at: new Date(), dialed_at: new Date(), answered_at: new Date(),
    bridged_at: new Date(), outcome: 'connected',
  });
  return call.id as string;
}
const save = (callId: string, code: string) =>
  service().submitDisposition({ tenantId: w.tenant, accountId: w.a, userId: w.supId, supervise: true }, callId, { code });
const savedAs = async (callId: string) =>
  (await q(`SELECT disposition_code, disposition_source FROM agency_manual_calls WHERE id = $1`, [callId])).rows[0];

describe('untagged soft-phone outcomes follow the account\'s template (CT11)', () => {
  it('the account\'s default template: the settings say so, the pad offers it, the outcome is saved against it', async () => {
    await template('organisation', ORG_OUTCOMES);
    const mine = await template('account', ACCOUNT_OUTCOMES);
    const settings = await readSettings();
    expect(settings.outcomes_template).toEqual({
      template: { id: mine.id, name: mine.name, version: 1, scope: 'account' }, disposition_catalog: ACCOUNT_OUTCOMES,
    });
    expect(await untaggedPad()).toEqual(ACCOUNT_OUTCOMES);

    const call = await endedCall();
    const refused = await save(call, 'voicemail');
    expect(refused).toMatchObject({ ok: false, refusal: { code: 'disposition_invalid', allowed_codes: ['will_pay', 'refused'] } });
    expect(await save(call, 'will_pay')).toMatchObject({ ok: true });
    expect(await savedAs(call)).toEqual({ disposition_code: 'will_pay', disposition_source: 'softphone' });
  });

  it('the organisation\'s default when the account has none; read live: an edit is followed at once', async () => {
    const org = await template('organisation', ORG_OUTCOMES);
    expect((await readSettings()).outcomes_template).toMatchObject({ template: { id: org.id, scope: 'organisation' }, disposition_catalog: ORG_OUTCOMES });
    const put = await as(w.org, null, 'PUT', `/campaign-templates/${org.id}`, {
      name: org.name, description: null, based_on_template_id: null,
      sections: { outcomes: { disposition_catalog: ACCOUNT_OUTCOMES } }, expected_version: 1,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(await untaggedPad()).toEqual(ACCOUNT_OUTCOMES);
    expect(await save(await endedCall(), 'refused')).toMatchObject({ ok: true });
  });

  it('no template: the built-in outcomes, named as following none', async () => {
    expect((await readSettings()).outcomes_template).toEqual({ template: null, disposition_catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG] });
    expect(await untaggedPad()).toEqual([...AGENCY_DEFAULT_DISPOSITION_CATALOG]);
  });

  it('the soft phone\'s own list wins; outcomes_template still says what Follow would give, on the GET and the PUT\'s answer', async () => {
    const mine = await template('account', ACCOUNT_OUTCOMES);
    const follows = { template: { id: mine.id, name: mine.name, version: 1, scope: 'account' }, disposition_catalog: ACCOUNT_OUTCOMES };
    const put = await as(w.sup, w.a, 'PUT', '/softphone/settings', {
      disposition_catalog: OWN, call_fields: [], analysis_profile_id: null, record_calls: false, default_caller_id: null,
    });
    expect(put.json().outcomes_template).toEqual(follows);
    expect((await readSettings()).outcomes_template).toEqual(follows);
    expect(await untaggedPad()).toEqual(OWN);
    const call = await endedCall();
    expect(await save(call, 'will_pay')).toMatchObject({ ok: false, refusal: { code: 'disposition_invalid', allowed_codes: ['sold'] } });
    expect(await save(call, 'sold')).toMatchObject({ ok: true });
    // Set back to none: the template again.
    await ownCatalog([]);
    expect((await readSettings()).outcomes_template).toMatchObject({ disposition_catalog: ACCOUNT_OUTCOMES });
  });

  it('the followed catalog is one the soft phone would accept: no override, no promise, the outcomes kept (S8)', async () => {
    await setFlag('agency_contact_assignment_enabled', true);
    await template('account', [
      { code: 'will_pay', label: 'Will pay', is_success: true, requires_promise: true, promise_follow_up_days: 2 },
      { code: 'call_later', label: 'Call later', requires_datetime: true, override: { calling_hours: true } },
      { code: 'refused', label: 'Refused' },
    ]);
    const softphone: AgencyDisposition[] = [
      { code: 'will_pay', label: 'Will pay', is_success: true },
      { code: 'call_later', label: 'Call later', requires_datetime: true },
      { code: 'refused', label: 'Refused' },
    ];
    expect((await readSettings()).outcomes_template?.disposition_catalog).toEqual(softphone);
    expect(await untaggedPad()).toEqual(softphone);
    // The soft phone's own settings accept that very list.
    await ownCatalog(softphone);
    await ownCatalog([]);
    // Saved against it: no promise is asked.
    const call = await endedCall();
    expect(await save(call, 'will_pay')).toMatchObject({ ok: true });
  });

  it('the flag off: the built-in outcomes as before, and no follow', async () => {
    await template('account', ACCOUNT_OUTCOMES);
    await setFlag('agency_campaign_templates_enabled', false);
    expect((await readSettings()).outcomes_template).toBeNull();
    expect(await untaggedPad()).toEqual([...AGENCY_DEFAULT_DISPOSITION_CATALOG]);
    const call = await endedCall();
    expect(await save(call, 'will_pay')).toMatchObject({ ok: false, refusal: { code: 'disposition_invalid' } });
    expect(await save(call, 'voicemail')).toMatchObject({ ok: true });
  });

  it('a template read that fails after the save still answers the save, audited, without outcomes_template (D3)', async () => {
    await template('account', ACCOUNT_OUTCOMES);
    const flags = getFeatureFlagService();
    const isEnabled = flags.isEnabled.bind(flags);
    const spy = vi.spyOn(flags, 'isEnabled').mockImplementation(async (flag, context) => {
      if (flag.key === 'agency_campaign_templates_enabled') throw new Error('flags unreadable');
      return isEnabled(flag, context);
    });
    let put;
    try {
      put = await as(w.sup, w.a, 'PUT', '/softphone/settings', {
        disposition_catalog: OWN, call_fields: [], analysis_profile_id: null, record_calls: false, default_caller_id: null,
      });
    } finally {
      spy.mockRestore();
    }
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).not.toHaveProperty('outcomes_template');
    expect(put.json().settings.disposition_catalog).toEqual(OWN);
    expect((await readSettings()).settings.disposition_catalog).toEqual(OWN);
    await platformAuditLogger.flush();
    const { rows } = await q(
      `SELECT details FROM platform_audit_log WHERE tenant_id = $1 AND action = 'agency_softphone_settings.updated'`, [w.tenant]);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ changed: ['disposition_catalog'] });
  });

  it('a tagged call keeps its campaign\'s outcomes', async () => {
    await template('account', ACCOUNT_OUTCOMES);
    const campaign = await insertAgencyCampaign({
      tenant_id: w.tenant, account_id: w.a, status: 'running', disposition_catalog: JSON.stringify(OWN),
    });
    const call = await endedCall(campaign.id as string);
    expect(await save(call, 'will_pay')).toMatchObject({ ok: false, refusal: { code: 'disposition_invalid', allowed_codes: ['sold'] } });
    expect(await save(call, 'sold')).toMatchObject({ ok: true });
    expect(await savedAs(call)).toEqual({ disposition_code: 'sold', disposition_source: 'campaign' });
  });
});
