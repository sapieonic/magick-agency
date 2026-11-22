import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Applying a template to draft campaigns (docs/campaign-templates.md CT16), through the REAL app on
 * real Postgres: `POST /proxy/agency/campaign-templates/:id/apply`, the campaign PATCH path it runs
 * per campaign (`helpers/campaign-patch.ts` → `callCore` → the internal PATCH handler), the
 * repository.
 *
 * Pinned here: a draft is written the chosen sections as filled in for the account and its
 * `template_source` updated (the others kept); a running, an archived, another account's, a missing
 * campaign is refused for itself alone; the PATCH path's own refusal is the campaign's
 * (`campaign_rejected`, the PATCH's status, code and details, the same as a PATCH of that body
 * answers); a stale `expected_version` touches nothing; who may apply; the audit rows (the
 * template's `campaign_template.applied`, and each campaign's `agency_campaign.config_changed` from
 * the PATCH path).
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import { randomUUID } from 'node:crypto';
import { closePool, initDbPool } from '@magick-agency/db';
import {
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  type AgencyCampaignTemplate,
  type AgencyCampaignTemplateApplyResponse,
  type AgencyCampaignTemplateSource,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { insertAgencyCampaign } from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

let app: FastifyInstance;
let w: { tenant: string; a: string; b: string; sup: string; supId: string; supB: string; agent: string };

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
  await q(`INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink') ON CONFLICT (name) DO NOTHING`);
  const tenant = (await insertTenant()).id as string;
  const a = (await insertAccount({ tenant_id: tenant })).id as string;
  const b = (await insertAccount({ tenant_id: tenant })).id as string;
  const people: Record<string, { uid: string; id: string }> = {};
  for (const [key, account, role] of [['sup', a, 'account_admin'], ['supB', b, 'account_admin'], ['agent', a, 'agent']] as const) {
    const user = await insertUser({ display_name: key });
    await insertMembership({ user_id: user.id, tenant_id: tenant, account_id: account, role });
    people[key] = { uid: user.firebase_uid as string, id: user.id as string };
  }
  w = { tenant, a, b, sup: people.sup!.uid, supId: people.sup!.id, supB: people.supB!.uid, agent: people.agent!.uid };
  for (const flag of ['agency_dialer_enabled', 'agency_campaign_templates_enabled']) {
    await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ($1, 'tenant', $2, 'true'::jsonb)`, [flag, tenant]);
  }
  await getFeatureFlagService().invalidate({ tenantId: tenant });
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

const as = (uid: string, account: string, method: 'POST' | 'PATCH' | 'PUT', url: string, payload: unknown) =>
  app.inject({
    method, url: `/proxy/agency${url}`,
    headers: { authorization: `Bearer tok:${uid}`, 'x-tenant-id': w.tenant, 'x-account-id': account },
    payload: payload as object,
  });

const OUTCOMES = { disposition_catalog: [{ code: 'will_pay', label: 'Will pay' }, { code: 'refused', label: 'Refused' }], outcome_dispositions: {} };
const WRAPUP = { wrapup_seconds: 75, wrapup_auto_return: false };

async function template(sections: Record<string, unknown>): Promise<AgencyCampaignTemplate> {
  const res = await as(w.sup, w.a, 'POST', '/campaign-templates', { scope: 'account', name: `T ${randomUUID().slice(0, 6)}`, sections });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}
const campaign = async (overrides: Record<string, unknown> = {}) =>
  (await insertAgencyCampaign({ tenant_id: w.tenant, account_id: w.a, status: 'draft', ...overrides })).id as string;
const stored = async (id: string) => (await q(`SELECT * FROM agency_campaigns WHERE id = $1`, [id])).rows[0];
const apply = (templateId: string, body: Record<string, unknown>, uid = w.sup, account = w.a) =>
  as(uid, account, 'POST', `/campaign-templates/${templateId}/apply`, body);

describe('POST /campaign-templates/:id/apply (CT16)', () => {
  it('writes the chosen sections to a draft through the PATCH path, and records the template', async () => {
    const tpl = await template({ outcomes: OUTCOMES, wrapup: WRAPUP, hours: { calling_window_start: '11:00' } });
    const draft = await campaign({ wrapup_seconds: 75, wrapup_auto_return: false, allow_wrapup_redial: false });
    const res = await apply(tpl.id, { campaign_ids: [draft], sections: ['wrapup', 'outcomes'], expected_version: 1 });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as AgencyCampaignTemplateApplyResponse;
    expect(body.template).toEqual({ id: tpl.id, name: tpl.name, version: 1 });
    expect(body.results).toHaveLength(1);
    const result = body.results[0]!;
    expect(result).toMatchObject({ campaign_id: draft, result: 'applied', changed_sections: ['outcomes'] });

    const row = await stored(draft);
    expect(row).toMatchObject({ disposition_catalog: OUTCOMES.disposition_catalog, wrapup_seconds: 75, wrapup_auto_return: false });
    // Hours were not chosen: untouched.
    expect(row.calling_window_start).toBe('00:00:00');
    const source = row.template_source as AgencyCampaignTemplateSource;
    expect(source).toEqual({
      template: { id: tpl.id, name: tpl.name, version: 1, scope: 'account' },
      based_on: null,
      sections: Object.fromEntries(AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.map((k) => [k, k === 'outcomes' || k === 'wrapup' ? 'account' : 'campaign'])),
    });
    expect(result.result === 'applied' && result.template_source).toEqual(source);

    await platformAuditLogger.flush();
    const applied = await q(`SELECT account_id, resource_id, details FROM platform_audit_log WHERE action = 'campaign_template.applied'`);
    expect(applied.rows).toEqual([{
      account_id: w.a, resource_id: tpl.id,
      details: expect.objectContaining({ sections: ['outcomes', 'wrapup'], applied: [draft], refused: [], version: 1 }),
    }]);
    const changed = await q(`SELECT details FROM platform_audit_log WHERE action = 'agency_campaign.config_changed' AND campaign_id = $1`, [draft]);
    expect(changed.rows).toHaveLength(1);
    expect(changed.rows[0].details.fields).toContain('disposition_catalog');
  });

  it('keeps the other sections\' sources of a campaign made from a template', async () => {
    const first = await template({ outcomes: OUTCOMES });
    await as(w.sup, w.a, 'POST', `/campaign-templates/${first.id}/default`, undefined);
    const made = await as(w.sup, w.a, 'POST', '/campaigns', { name: 'Made', caller_ids: ['+919000000001'], wrapup_seconds: 40 });
    expect(made.statusCode, made.body).toBe(201);
    const id = (made.json() as { id: string }).id;
    const second = await template({ wrapup: WRAPUP });
    const res = await apply(second.id, { campaign_ids: [id], sections: ['wrapup'] });
    expect(res.json().results[0]).toMatchObject({ result: 'applied', changed_sections: ['wrapup'] });
    const source = (await stored(id)).template_source as AgencyCampaignTemplateSource;
    expect(source.template).toMatchObject({ id: second.id });
    expect(source.sections).toMatchObject({ outcomes: 'account', wrapup: 'account', numbers: 'campaign', hours: 'builtin' });
  });

  it('refuses each campaign that is not a draft of the account, and applies the others', async () => {
    const tpl = await template({ wrapup: WRAPUP });
    const draft = await campaign();
    const running = await campaign({ status: 'running' });
    const archived = await campaign({ archived_at: new Date() });
    const otherAccount = (await insertAgencyCampaign({ tenant_id: w.tenant, account_id: w.b, status: 'draft' })).id as string;
    const missing = randomUUID();
    const res = await apply(tpl.id, { campaign_ids: [running, draft, archived, otherAccount, missing, 'not-a-uuid'], sections: ['wrapup'] });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as AgencyCampaignTemplateApplyResponse).results.map((r) => [r.campaign_id, r.result === 'refused' ? r.code : r.result]))
      .toEqual([
        [running, 'campaign_not_draft'],
        [draft, 'applied'],
        [archived, 'campaign_archived'],
        [otherAccount, 'campaign_not_found'],
        [missing, 'campaign_not_found'],
        ['not-a-uuid', 'campaign_not_found'],
      ]);
    expect((await stored(running)).wrapup_seconds).toBe(30);
    expect((await stored(running)).template_source).toBeNull();
    expect((await stored(otherAccount)).wrapup_seconds).toBe(30);
    expect((await stored(draft)).wrapup_seconds).toBe(75);
  });

  it('the PATCH path\'s refusal is the campaign\'s, as a PATCH of that body answers it', async () => {
    // The template's numbers name none: the PATCH path refuses an empty pool.
    const tpl = await template({ numbers: { caller_ids: [] }, wrapup: WRAPUP });
    const draft = await campaign();
    const res = await apply(tpl.id, { campaign_ids: [draft], sections: ['numbers', 'wrapup'] });
    const result = (res.json() as AgencyCampaignTemplateApplyResponse).results[0]!;
    const patch = await as(w.sup, w.a, 'PATCH', `/campaigns/${draft}`, { caller_ids: [], telephony_provider: 'voicelink', telephony_credential_id: null });
    expect(patch.statusCode).toBe(400);
    expect(result).toMatchObject({ result: 'refused', code: 'campaign_rejected', status: 400, details: patch.json().details });
    // Nothing of it was written.
    expect((await stored(draft))).toMatchObject({ wrapup_seconds: 30, template_source: null });
  });

  it('a stale expected_version, an archived template: refused before any campaign is touched', async () => {
    const tpl = await template({ wrapup: WRAPUP });
    await as(w.sup, w.a, 'PUT', `/campaign-templates/${tpl.id}`, {
      name: tpl.name, description: null, based_on_template_id: null, sections: { wrapup: { wrapup_seconds: 20 } }, expected_version: 1,
    });
    const draft = await campaign();
    const stale = await apply(tpl.id, { campaign_ids: [draft], sections: ['wrapup'], expected_version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'campaign_template_changed', current_version: 2 });
    await as(w.sup, w.a, 'POST', `/campaign-templates/${tpl.id}/archive`, undefined);
    const archived = await apply(tpl.id, { campaign_ids: [draft], sections: ['wrapup'] });
    expect(archived.statusCode).toBe(409);
    expect(archived.json().code).toBe('campaign_template_archived');
    expect((await stored(draft)).wrapup_seconds).toBe(30);
  });

  it('who: another account\'s supervisor cannot see the template; an agent is refused; the body is checked', async () => {
    const tpl = await template({ wrapup: WRAPUP });
    const draft = await campaign();
    expect((await apply(tpl.id, { campaign_ids: [draft], sections: ['wrapup'] }, w.supB, w.b)).statusCode).toBe(404);
    expect((await apply(tpl.id, { campaign_ids: [draft], sections: ['wrapup'] }, w.agent, w.a)).statusCode).toBe(403);
    for (const body of [
      { campaign_ids: [], sections: ['wrapup'] },
      { campaign_ids: [draft], sections: [] },
      { campaign_ids: [draft], sections: ['lunch'] },
      { campaign_ids: [draft, draft], sections: ['wrapup'] },
      { campaign_ids: Array.from({ length: 51 }, () => randomUUID()), sections: ['wrapup'] },
    ]) {
      const res = await apply(tpl.id, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.json().code).toBe('campaign_template_invalid');
    }
    expect((await stored(draft)).wrapup_seconds).toBe(30);
  });
});
