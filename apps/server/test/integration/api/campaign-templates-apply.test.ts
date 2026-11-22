import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Applying a template to draft campaigns (docs/campaign-templates.md CT16), through the REAL app on
 * real Postgres: `POST /proxy/agency/campaign-templates/:id/apply`, the campaign PATCH path it runs
 * per campaign (`helpers/campaign-patch.ts` → `callCore` → the internal PATCH handler), the
 * repository.
 *
 * Pinned here: a draft is written the chosen sections as filled in for the account and its
 * `template_source` switched to the template, every section judged against it (CT9 as amended),
 * the answer carrying the record as stored; a running, an archived, another account's, a missing
 * campaign is refused for itself alone; the PATCH path's own refusal is the campaign's
 * (`campaign_rejected`, the PATCH's status, code and details, the same as a PATCH of that body
 * answers); a stale `expected_version` touches nothing; who may apply; the audit rows (the
 * template's `campaign_template.applied`, under the request's account for an organisation template
 * too, and each campaign's `agency_campaign.config_changed` from the PATCH path).
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
import type { AgencyCampaign } from '@magick-agency/contracts/api/agency/agency-campaign';
import { builtinTemplateSections, diffSections, sectionsFromCampaign } from '@magick-agency/domain/campaign-templates';
import { buildApp } from '../../../src/app.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { setCoreInjector } from '../../../src/api/core-dispatch.js';

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
/** Each section's source were the campaign compared with the built-in settings alone. */
const sourcesOf = (row: AgencyCampaign) => {
  const builtin = builtinTemplateSections();
  return Object.fromEntries(AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.map((k) => [
    k, diffSections({ [k]: sectionsFromCampaign(row, 'account', [k])[k] }, { [k]: builtin[k] }).length === 0 ? 'builtin' : 'campaign',
  ]));
};
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
    // Every section judged against the template (CT9 as amended): the hours it was not given are
    // the campaign's own (00:00 here, not the template's 11:00); the rest equal its built-in ones.
    expect(source).toEqual({
      template: { id: tpl.id, name: tpl.name, version: 1, scope: 'account' },
      based_on: null,
      sections: { ...sourcesOf(row as AgencyCampaign), outcomes: 'account', wrapup: 'account', hours: 'campaign' },
      notes: [],
    });
    // The answer is the record as stored.
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

  it('an apply of A2 for outcomes only re-labels every section against A2: hours made from A1 are the campaign\'s', async () => {
    const a1 = await template({ outcomes: OUTCOMES, hours: { calling_window_start: '11:00' } });
    await as(w.sup, w.a, 'POST', `/campaign-templates/${a1.id}/default`, undefined);
    const made = await as(w.sup, w.a, 'POST', '/campaigns', { name: 'Made', caller_ids: ['+919000000001'] });
    expect(made.statusCode, made.body).toBe(201);
    const id = (made.json() as { id: string }).id;
    expect(((await stored(id)).template_source as AgencyCampaignTemplateSource).sections)
      .toMatchObject({ outcomes: 'account', hours: 'account', wrapup: 'builtin', numbers: 'campaign' });

    const a2 = await template({ outcomes: { disposition_catalog: [{ code: 'paid', label: 'Paid' }], outcome_dispositions: {} } });
    const res = await apply(a2.id, { campaign_ids: [id], sections: ['outcomes'] });
    expect(res.json().results[0]).toMatchObject({ result: 'applied', changed_sections: ['outcomes'] });
    const source = (await stored(id)).template_source as AgencyCampaignTemplateSource;
    expect(source.template).toMatchObject({ id: a2.id, version: 1 });
    // A1's hours are not A2's (built-in, 09:00): the campaign's own now, never "A2's".
    expect(source.sections).toMatchObject({ outcomes: 'account', hours: 'campaign', wrapup: 'builtin', numbers: 'campaign' });
    expect(res.json().results[0].template_source).toEqual(source);
  });

  it('an organisation template\'s apply: the audit row is filed under the request\'s account (CTS7)', async () => {
    const admin = await insertUser({ display_name: 'Olga Admin' });
    await insertMembership({ user_id: admin.id, tenant_id: w.tenant, account_id: null, role: 'tenant_admin' });
    const org = await app.inject({
      method: 'POST', url: '/proxy/agency/campaign-templates',
      headers: { authorization: `Bearer tok:${admin.firebase_uid}`, 'x-tenant-id': w.tenant },
      payload: { scope: 'organisation', name: 'Org wrap-up', sections: { wrapup: WRAPUP } },
    });
    expect(org.statusCode, org.body).toBe(201);
    const draft = await campaign();
    const res = await apply(org.json().id, { campaign_ids: [draft], sections: ['wrapup'] });
    expect(res.json().results[0]).toMatchObject({ result: 'applied' });
    expect((await stored(draft)).template_source).toMatchObject({ template: { id: org.json().id, scope: 'organisation' }, sections: { wrapup: 'organisation' } });
    await platformAuditLogger.flush();
    const applied = await q(`SELECT account_id FROM platform_audit_log WHERE action = 'campaign_template.applied' AND resource_id = $1`, [org.json().id]);
    expect(applied.rows).toEqual([{ account_id: w.a }]);
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
    // A row whose hours never dial (hand-edited: a save would refuse it): the PATCH path refuses it.
    const hours = { calling_window_start: '10:00:00', calling_window_end: '18:00:00', calling_days: [1, 2, 3, 4, 5], default_timezone: 'Asia/Kolkata' };
    const tpl = await template({ hours, wrapup: WRAPUP });
    await q(`UPDATE agency_campaign_templates SET sections = jsonb_set(sections, '{hours,calling_window_end}', '"10:00:00"'::jsonb) WHERE id = $1`, [tpl.id]);
    const draft = await campaign();
    const res = await apply(tpl.id, { campaign_ids: [draft], sections: ['hours', 'wrapup'] });
    const result = (res.json() as AgencyCampaignTemplateApplyResponse).results[0]!;
    const patch = await as(w.sup, w.a, 'PATCH', `/campaigns/${draft}`, { ...hours, calling_window_end: '10:00:00' });
    expect(patch.statusCode).toBe(400);
    expect(result).toMatchObject({ result: 'refused', code: 'campaign_rejected', status: 400, details: patch.json().details });
    // Nothing of it was written.
    expect((await stored(draft))).toMatchObject({ wrapup_seconds: 30, template_source: null });
  });

  it('a campaign whose record cannot be written keeps its settings too: one transaction (D5)', async () => {
    const tpl = await template({ wrapup: WRAPUP });
    const [first, failing, last] = [await campaign(), await campaign(), await campaign()];
    // The database refuses the record of one campaign, inside the PATCH's write.
    await q(`CREATE FUNCTION test_refuse_template_record() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${failing}'::uuid AND NEW.template_source IS DISTINCT FROM OLD.template_source THEN
          RAISE EXCEPTION 'record refused';
        END IF;
        RETURN NEW;
      END $$`);
    await q(`CREATE TRIGGER test_refuse_template_record BEFORE UPDATE ON agency_campaigns
      FOR EACH ROW EXECUTE FUNCTION test_refuse_template_record()`);
    let res;
    try {
      res = await apply(tpl.id, { campaign_ids: [first, failing, last], sections: ['wrapup'] });
    } finally {
      await q(`DROP TRIGGER test_refuse_template_record ON agency_campaigns`);
      await q(`DROP FUNCTION test_refuse_template_record()`);
    }
    expect(res.statusCode, res.body).toBe(200);
    const results = (res.json() as AgencyCampaignTemplateApplyResponse).results;
    expect(results.map((r) => [r.campaign_id, r.result])).toEqual([[first, 'applied'], [failing, 'refused'], [last, 'applied']]);
    expect(results[1]).toMatchObject({ code: 'campaign_rejected', status: 500 });
    // Neither its settings nor its record: never the template's settings under no record.
    expect(await stored(failing)).toMatchObject({ wrapup_seconds: 30, wrapup_auto_return: true, template_source: null });
    expect(await stored(last)).toMatchObject({ wrapup_seconds: 75, template_source: { template: { id: tpl.id } } });
    await platformAuditLogger.flush();
    const applied = await q(`SELECT details FROM platform_audit_log WHERE action = 'campaign_template.applied' AND resource_id = $1`, [tpl.id]);
    expect(applied.rows).toHaveLength(1);
    expect(applied.rows[0].details).toMatchObject({ applied: [first, last], refused: [{ campaign_id: failing, code: 'campaign_rejected' }] });
  });

  it('a campaign whose apply throws is its own error result; the others apply and the audit row is written (D5)', async () => {
    const tpl = await template({ wrapup: WRAPUP });
    const [first, failing, last] = [await campaign(), await campaign(), await campaign()];
    // The internal call for one campaign fails outright (as a lost media worker would).
    setCoreInjector(async (args, local) => {
      if (args.method === 'PATCH' && args.url.includes(failing)) throw new Error('internal call lost');
      return local(args);
    });
    let res;
    try {
      res = await apply(tpl.id, { campaign_ids: [first, failing, last], sections: ['wrapup'] });
    } finally {
      setCoreInjector(null);
    }
    expect(res.statusCode, res.body).toBe(200);
    const results = (res.json() as AgencyCampaignTemplateApplyResponse).results;
    expect(results.map((r) => [r.campaign_id, r.result])).toEqual([[first, 'applied'], [failing, 'refused'], [last, 'applied']]);
    expect(results[1]).toMatchObject({
      code: 'campaign_rejected', status: 500, message: 'Something went wrong while changing this campaign. Try again.',
    });
    expect(await stored(failing)).toMatchObject({ wrapup_seconds: 30, template_source: null });
    await platformAuditLogger.flush();
    const applied = await q(`SELECT details FROM platform_audit_log WHERE action = 'campaign_template.applied' AND resource_id = $1`, [tpl.id]);
    expect(applied.rows).toHaveLength(1);
    expect(applied.rows[0].details).toMatchObject({ applied: [first, last], refused: [{ campaign_id: failing, code: 'campaign_rejected' }] });
  });

  it('numbers chosen from a template that sets none are refused up front, and no campaign is touched (D2)', async () => {
    const admin = await insertUser({ display_name: 'Olga Admin' });
    await insertMembership({ user_id: admin.id, tenant_id: w.tenant, account_id: null, role: 'tenant_admin' });
    const org = await app.inject({
      method: 'POST', url: '/proxy/agency/campaign-templates',
      headers: { authorization: `Bearer tok:${admin.firebase_uid}`, 'x-tenant-id': w.tenant },
      payload: { scope: 'organisation', name: 'Collections', sections: { outcomes: OUTCOMES } },
    });
    expect(org.statusCode, org.body).toBe(201);
    const unset = await template({ outcomes: OUTCOMES });
    // Numbers that name none (hand-edited: a save would refuse it) give no caller IDs either.
    const empty = await template({ numbers: { caller_ids: ['+919000000001'] }, outcomes: OUTCOMES });
    await q(`UPDATE agency_campaign_templates SET sections = jsonb_set(sections, '{numbers,caller_ids}', '[]'::jsonb) WHERE id = $1`, [empty.id]);
    const drafts = [await campaign(), await campaign()];
    for (const id of [org.json().id as string, unset.id, empty.id]) {
      const res = await apply(id, { campaign_ids: drafts, sections: ['outcomes', 'numbers'] });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ code: 'campaign_template_invalid', details: { 'sections.numbers': expect.any(String) } });
    }
    for (const id of drafts) {
      expect(await stored(id)).toMatchObject({ template_source: null, caller_ids: ['+919000000001'] });
      expect((await stored(id)).disposition_catalog).not.toEqual(OUTCOMES.disposition_catalog);
    }
    await platformAuditLogger.flush();
    expect((await q(`SELECT 1 FROM platform_audit_log WHERE tenant_id = $1 AND action IN ('campaign_template.applied', 'agency_campaign.config_changed')`, [w.tenant])).rows).toEqual([]);
    // Without numbers, the same apply goes through.
    const res = await apply(org.json().id, { campaign_ids: drafts, sections: ['outcomes'] });
    expect(res.json().results.map((r: { result: string }) => r.result)).toEqual(['applied', 'applied']);
  });

  it('a template\'s outcome overrides without contact assignment: applied without them, with the note, never refused (CT20)', async () => {
    const catalog = [{ code: 'will_pay', label: 'Will pay', override: { extra_attempts: 1 } }, { code: 'refused', label: 'Refused' }];
    // Saved while contact assignment was on, applied after it was turned off for the tenant.
    await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ('agency_contact_assignment_enabled', 'tenant', $1, 'true'::jsonb)`, [w.tenant]);
    await getFeatureFlagService().invalidate({ tenantId: w.tenant });
    const tpl = await template({ outcomes: { disposition_catalog: catalog, outcome_dispositions: {} } });
    await q(`DELETE FROM feature_flag_overrides WHERE flag_key = 'agency_contact_assignment_enabled' AND tenant_id = $1`, [w.tenant]);
    await getFeatureFlagService().invalidate({ tenantId: w.tenant });
    const draft = await campaign();
    const res = await apply(tpl.id, { campaign_ids: [draft], sections: ['outcomes'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results[0]).toMatchObject({ result: 'applied' });
    const row = await stored(draft);
    expect(row.disposition_catalog).toEqual([{ code: 'will_pay', label: 'Will pay' }, { code: 'refused', label: 'Refused' }]);
    expect(row.template_source).toMatchObject({
      template: { id: tpl.id }, sections: { outcomes: 'account' }, notes: [{ code: 'outcome_overrides_off', section: 'outcomes' }],
    });
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
      // One campaign named in two cases is named twice (CTS13).
      { campaign_ids: [draft, draft.toUpperCase()], sections: ['wrapup'] },
      { campaign_ids: Array.from({ length: 51 }, () => randomUUID()), sections: ['wrapup'] },
    ]) {
      const res = await apply(tpl.id, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.json().code).toBe('campaign_template_invalid');
    }
    expect((await stored(draft)).wrapup_seconds).toBe(30);
  });
});
