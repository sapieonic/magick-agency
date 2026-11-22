import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * A new campaign filled in from a template (docs/campaign-templates.md CT1, CT7, CT8, CT9, CT18),
 * through the REAL app (`buildApp`) on real Postgres: `POST /proxy/agency/campaigns`, the public
 * fill-in, `callCore`, the internal create handler, the repository.
 *
 * Pinned here:
 *  - CT17: with the flag off the create is today's, whatever a template or the body says: the
 *    row equals a create without `template_id`, in UTC, with no `template_source` (a client's is
 *    never stored).
 *  - CT8, CT18: with it on and no template, the built-in settings with New campaign's Asia/Kolkata;
 *    the account's default (following the organisation's); a named template; a section the body
 *    sends kept as sent (an empty outcome list too), its absent fields built-in; unknown, archived
 *    or another account's `template_id` refused before anything is written.
 *  - CT9 (as amended): `template_source` records the template, its based-on, each section's
 *    source (`campaign` where the stored settings differ from what was filled in) and the
 *    filling-in's notes; every settings PATCH recomputes it against the versions it names.
 *  - S1: a template's outcome overrides are left out, with a note, where contact assignment is off.
 *  - CT1: editing, then archiving, the template after the create leaves the campaign's row byte
 *    for byte the same.
 *  - CT7: a retry campaign copies its parent, never a template.
 *  - `break_reasons` is stored by the create, checked by the PATCH's rule.
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
  type AgencyCampaignTemplateSource,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { AGENCY_DEFAULT_DISPOSITION_CATALOG } from '@magick-agency/contracts/agency';
import type { AgencyCampaign } from '@magick-agency/contracts/api/agency/agency-campaign';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { insertAgencyContact } from '../agency/agency-factories.js';
import { buildApp } from '../../../src/app.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { agencyCampaignRepository, agencyCampaignTemplateRepository } from '../../../src/db/repositories/agency.repository.js';
import { templateSourceRecompute } from '../../../src/agency/campaign-templates/template-source.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

let app: FastifyInstance;
let w: { tenant: string; a: string; b: string; orgUid: string; supUid: string; supBUid: string };

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
  await q(`INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink') ON CONFLICT (name) DO NOTHING`);
  const tenant = (await insertTenant()).id as string;
  const a = (await insertAccount({ tenant_id: tenant })).id as string;
  const b = (await insertAccount({ tenant_id: tenant })).id as string;
  const org = await insertUser({ display_name: 'Olga Admin' });
  await insertMembership({ user_id: org.id, tenant_id: tenant, account_id: null, role: 'tenant_admin' });
  const sup = await insertUser({ display_name: 'Sam Supervisor' });
  await insertMembership({ user_id: sup.id, tenant_id: tenant, account_id: a, role: 'account_admin' });
  const supB = await insertUser({ display_name: 'Bina Supervisor' });
  await insertMembership({ user_id: supB.id, tenant_id: tenant, account_id: b, role: 'account_admin' });
  w = { tenant, a, b, orgUid: org.firebase_uid, supUid: sup.firebase_uid, supBUid: supB.firebase_uid };
  await setFlag('agency_dialer_enabled', true);
  await setFlag('agency_campaign_templates_enabled', true);
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

const headers = (uid: string, account: string | null) => ({
  authorization: `Bearer tok:${uid}`, 'x-tenant-id': w.tenant, ...(account ? { 'x-account-id': account } : {}),
});
const sup = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, account = w.a, uid = w.supUid) =>
  app.inject({ method, url: `/proxy/agency${url}`, headers: headers(uid, account), ...(payload !== undefined ? { payload: payload as object } : {}) });
const orgAdmin = (method: 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/proxy/agency${url}`, headers: headers(w.orgUid, null), ...(payload !== undefined ? { payload: payload as object } : {}) });

const OUTCOMES = {
  disposition_catalog: [{ code: 'will_pay', label: 'Will pay', is_success: true }, { code: 'refused', label: 'Refused' }],
  outcome_dispositions: {},
};
const WRAPUP = { wrapup_seconds: 60, wrapup_auto_return: false, allow_wrapup_redial: true };
const BASE = { name: 'Diwali dues', caller_ids: ['+919000000001'] };

async function template(scope: 'organisation' | 'account', sections: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<AgencyCampaignTemplate> {
  const body = { scope, name: `T ${randomUUID().slice(0, 6)}`, sections, ...extra };
  const res = scope === 'organisation' ? await orgAdmin('POST', '/campaign-templates', body) : await sup('POST', '/campaign-templates', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function create(payload: Record<string, unknown>, account = w.a, uid = w.supUid): Promise<string> {
  const res = await sup('POST', '/campaigns', payload, account, uid);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

/** The stored row as JSON, every column but the ones each create gives anew. */
async function row(id: string): Promise<Record<string, unknown>> {
  const { rows } = await q(`SELECT to_jsonb(c) AS r FROM agency_campaigns c WHERE id = $1`, [id]);
  return rows[0].r;
}
async function settings(id: string): Promise<Record<string, unknown>> {
  const { id: _id, name: _n, created_at: _c, updated_at: _u, ...rest } = await row(id);
  return rest;
}

const allSources = (source: string, over: Record<string, string> = {}) =>
  Object.fromEntries(AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.map((k) => [k, over[k] ?? source]));
/** A create always sends its caller IDs, which no template here sets: its numbers are the campaign's own. */
const created = (source: string, over: Record<string, string> = {}) => allSources(source, { numbers: 'campaign', ...over });

describe('the flag off: the create is today\'s (CT17)', () => {
  it('a template_id and a client\'s template_source change nothing; UTC hours; no template_source', async () => {
    const def = await template('account', { outcomes: OUTCOMES, wrapup: WRAPUP }, { make_default: true });
    await setFlag('agency_campaign_templates_enabled', false);
    const plain = await create(BASE);
    const withTemplate = await create({
      ...BASE, template_id: def.id,
      template_source: { template: { id: def.id, name: 'Forged', version: 9, scope: 'account' }, based_on: null, sections: allSources('account') },
    });
    expect(await settings(withTemplate)).toEqual(await settings(plain));
    expect(await settings(plain)).toMatchObject({
      template_source: null, default_timezone: 'UTC', calling_window_start: '09:00:00', wrapup_seconds: 30,
      disposition_catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG],
    });
  });
});

describe('the flag on: filled in from a template (CT8, CT9)', () => {
  it('template_id null: the built-in settings alone, whatever the defaults; absent: the default chain', async () => {
    const orgDef = await template('organisation', { wrapup: WRAPUP }, { make_default: true });
    const builtinOnly = await create({ ...BASE, template_id: null, abandonment_ceiling_pct: 2 });
    expect(await settings(builtinOnly)).toMatchObject({
      wrapup_seconds: 30, default_timezone: 'Asia/Kolkata', abandonment_ceiling_pct: 2,
      template_source: { template: null, based_on: null, sections: created('builtin', { safety: 'campaign' }) },
    });
    const chain = await create(BASE);
    expect(await settings(chain)).toMatchObject({
      wrapup_seconds: 60,
      template_source: { template: { id: orgDef.id, scope: 'organisation' }, sections: created('builtin', { wrapup: 'organisation' }) },
    });
    const empty = await sup('POST', '/campaigns', { ...BASE, template_id: '' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe('campaign_template_invalid');
  });

  it('no template: the built-in settings with Asia/Kolkata hours, every section built-in', async () => {
    const made = await sup('POST', '/campaigns', BASE);
    expect(made.statusCode, made.body).toBe(201);
    const id = (made.json() as AgencyCampaign).id;
    // Every campaign payload the console reads carries `created_at` (campaign Settings' "Started from").
    const createdAt = (made.json() as AgencyCampaign).created_at;
    expect(createdAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect((await sup('GET', `/campaigns/${id}`)).json().created_at).toBe(createdAt);
    expect((await sup('GET', '/campaigns')).json().campaigns.map((c: AgencyCampaign) => c.created_at)).toEqual([createdAt]);
    expect(await settings(id)).toMatchObject({
      default_timezone: 'Asia/Kolkata', calling_window_start: '09:00:00', calling_window_end: '20:00:00',
      calling_days: [1, 2, 3, 4, 5], disposition_catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG],
      wrapup_seconds: 30, record_calls: false, break_reasons: [], retry_policy: {},
      template_source: { template: null, based_on: null, sections: created('builtin') },
    });
  });

  it('the account\'s default, following the organisation\'s default; a section sent is kept and marked campaign', async () => {
    const orgDef = await template('organisation', { wrapup: WRAPUP, safety: { abandonment_ceiling_pct: 2 } }, { make_default: true });
    const accDef = await template('account', { outcomes: OUTCOMES, hours: { calling_window_start: '10:00', calling_window_end: '18:00' } }, { make_default: true });

    const id = await create({ ...BASE, abandonment_ceiling_pct: 2.5, calling_window_start: '10:00:00', calling_window_end: '18:00' });
    const stored = await settings(id);
    expect(stored).toMatchObject({
      disposition_catalog: OUTCOMES.disposition_catalog, outcome_dispositions: {},
      wrapup_seconds: 60, wrapup_auto_return: false, allow_wrapup_redial: true,
      abandonment_ceiling_pct: 2.5,
      // Sent as the template has it: kept, and still the account's.
      calling_window_start: '10:00:00', calling_window_end: '18:00:00', default_timezone: 'Asia/Kolkata',
    });
    const source = stored.template_source as AgencyCampaignTemplateSource;
    expect(source).toEqual({
      template: { id: accDef.id, name: accDef.name, version: 1, scope: 'account' },
      based_on: { id: orgDef.id, name: orgDef.name, version: 1 },
      sections: created('builtin', { outcomes: 'account', hours: 'account', wrapup: 'organisation', safety: 'campaign' }),
      notes: [],
    });
  });

  it('a sent section\'s absent fields are built-in, never the template\'s (the section is won whole)', async () => {
    await template('account', { wrapup: WRAPUP }, { make_default: true });
    const id = await create({ ...BASE, wrapup_seconds: 45 });
    expect(await settings(id)).toMatchObject({ wrapup_seconds: 45, wrapup_auto_return: true, allow_wrapup_redial: false });
    expect(((await settings(id)).template_source as AgencyCampaignTemplateSource).sections.wrapup).toBe('campaign');
  });

  it('an empty outcome list sent is kept as sent', async () => {
    await template('account', { outcomes: OUTCOMES }, { make_default: true });
    const id = await create({ ...BASE, disposition_catalog: [] });
    expect(await settings(id)).toMatchObject({ disposition_catalog: [] });
    expect(((await settings(id)).template_source as AgencyCampaignTemplateSource).sections.outcomes).toBe('campaign');
  });

  it('a named template wins over the default; refused when unknown, another account\'s or archived', async () => {
    await template('account', { outcomes: OUTCOMES }, { make_default: true });
    const named = await template('organisation', { wrapup: WRAPUP });
    const id = await create({ ...BASE, template_id: named.id });
    expect(await settings(id)).toMatchObject({ wrapup_seconds: 60, disposition_catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG] });
    expect(((await settings(id)).template_source as AgencyCampaignTemplateSource).template).toMatchObject({ id: named.id, scope: 'organisation' });

    const inB = await template('account', {}, {});
    // `inB` is account A's: B cannot use it.
    const fromB = await sup('POST', '/campaigns', { ...BASE, template_id: inB.id }, w.b, w.supBUid);
    expect(fromB.statusCode).toBe(404);
    expect(fromB.json().code).toBe('campaign_template_not_found');
    for (const bad of [randomUUID(), 'nope']) {
      const res = await sup('POST', '/campaigns', { ...BASE, template_id: bad });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('campaign_template_not_found');
    }
    const notString = await sup('POST', '/campaigns', { ...BASE, template_id: 7 });
    expect(notString.statusCode).toBe(400);
    expect(notString.json().code).toBe('campaign_template_invalid');
    await orgAdmin('POST', `/campaign-templates/${named.id}/archive`);
    const archived = await sup('POST', '/campaigns', { ...BASE, template_id: named.id });
    expect(archived.statusCode).toBe(409);
    expect(archived.json().code).toBe('campaign_template_archived');
    const { rows } = await q(`SELECT count(*)::int AS n FROM agency_campaigns`);
    expect(rows[0].n).toBe(1);
  });

  it('the create\'s checks judge the filled-in body: a template\'s recording the account may not have is off', async () => {
    await template('organisation', { recording: { record_calls: true } }, { make_default: true });
    const id = await create(BASE);
    expect(await settings(id)).toMatchObject({ record_calls: false });
  });

  it('a client\'s template_source is never stored: the server\'s is', async () => {
    const id = await create({ ...BASE, template_source: { template: null, based_on: null, sections: allSources('campaign') } });
    expect(((await settings(id)).template_source as AgencyCampaignTemplateSource).sections).toEqual(created('builtin'));
  });

  it('CT1: editing and archiving the template after the create leaves the campaign byte for byte the same', async () => {
    const tpl = await template('account', { outcomes: OUTCOMES, wrapup: WRAPUP }, { make_default: true });
    const id = await create(BASE);
    const before = await row(id);
    const put = await sup('PUT', `/campaign-templates/${tpl.id}`, {
      name: 'Renamed', description: 'changed', based_on_template_id: null,
      sections: { outcomes: { disposition_catalog: [{ code: 'other', label: 'Other' }] }, wrapup: { wrapup_seconds: 10 } },
      expected_version: 1,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(await row(id)).toEqual(before);
    expect((await sup('POST', `/campaign-templates/${tpl.id}/archive`)).statusCode).toBe(200);
    expect(await row(id)).toEqual(before);
    expect((before.template_source as AgencyCampaignTemplateSource).template).toMatchObject({ name: tpl.name, version: 1 });
  });

  it('CT7: a retry campaign copies its parent\'s settings, never a template', async () => {
    const tpl = await template('account', { wrapup: WRAPUP }, { make_default: true });
    const parent = await create(BASE);
    await q(`UPDATE agency_campaigns SET status = 'completed' WHERE id = $1`, [parent]);
    await insertAgencyContact(parent, {
      tenant_id: w.tenant, account_id: w.a, phone_e164: '+919000000002', state: 'completed', last_outcome: 'no_answer', attempt_count: 1,
    });
    // The default template changes after the parent was made: the child must not follow it.
    await sup('PUT', `/campaign-templates/${tpl.id}`, {
      name: tpl.name, description: null, based_on_template_id: null, sections: { wrapup: { wrapup_seconds: 15 } }, expected_version: 1,
    });
    const res = await sup('POST', `/campaigns/${parent}/retry`, { selector: { last_outcome: ['no_answer'] } });
    expect(res.statusCode, res.body).toBe(201);
    const child = await settings((res.json() as { campaign: { id: string } }).campaign.id);
    expect(child).toMatchObject({ wrapup_seconds: 60, wrapup_auto_return: false, allow_wrapup_redial: true, template_source: null });
  });
});

describe('the record follows the campaign (CT9 as amended)', () => {
  const sourceOf = async (id: string) => (await settings(id)).template_source as AgencyCampaignTemplateSource;
  const patch = async (id: string, body: Record<string, unknown>) => {
    const res = await sup('PATCH', `/campaigns/${id}`, body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as AgencyCampaign;
  };
  const HOURS = { calling_window_start: '10:00', calling_window_end: '18:00', calling_days: [1, 2, 3, 4, 5, 6], default_timezone: 'Asia/Kolkata' };

  it('a draft made with the template\'s sections, then PATCHed: hours read campaign; back to the template\'s, the template\'s again', async () => {
    const tpl = await template('account', { outcomes: OUTCOMES, hours: HOURS });
    // New campaign's roster upload makes the draft with the form as filled in, before Hours is edited.
    const id = await create({ ...BASE, template_id: tpl.id, ...OUTCOMES, ...HOURS });
    expect((await sourceOf(id)).sections).toEqual(created('builtin', { outcomes: 'account', hours: 'account' }));

    await patch(id, { calling_window_start: '11:00' });
    expect((await sourceOf(id)).sections).toEqual(created('builtin', { outcomes: 'account', hours: 'campaign' }));
    // A PATCH of another section leaves the hours' record as the settings say.
    await patch(id, { wrapup_seconds: 45 });
    expect((await sourceOf(id)).sections).toEqual(created('builtin', { outcomes: 'account', hours: 'campaign', wrapup: 'campaign' }));

    await patch(id, { calling_window_start: '10:00:00', wrapup_seconds: 30 });
    const back = await sourceOf(id);
    expect(back.sections).toEqual(created('builtin', { outcomes: 'account', hours: 'account' }));
    expect(back.template).toEqual({ id: tpl.id, name: tpl.name, version: 1, scope: 'account' });
    // Judged against the version it was made from, not the template as it is now.
    await sup('PUT', `/campaign-templates/${tpl.id}`, {
      name: tpl.name, description: null, based_on_template_id: null, sections: { hours: { ...HOURS, calling_window_start: '08:00' } }, expected_version: 1,
    });
    await patch(id, { phone_display: 'full' });
    expect((await sourceOf(id)).sections.hours).toBe('account');
  });

  it('a recording note keeps recording\'s source and the note, through a PATCH', async () => {
    const org = await template('organisation', { recording: { record_calls: true } }, { make_default: true });
    const id = await create(BASE);
    const note = { code: 'recording_not_allowed', section: 'recording' };
    expect(await sourceOf(id)).toMatchObject({ template: { id: org.id }, sections: { recording: 'organisation' }, notes: [note] });
    expect((await settings(id)).record_calls).toBe(false);
    await patch(id, { calling_window_start: '11:00' });
    expect(await sourceOf(id)).toMatchObject({ sections: { recording: 'organisation', hours: 'campaign' }, notes: [note] });
  });

  it('a record whose template version is gone is left as it is', async () => {
    const tpl = await template('account', { hours: HOURS }, { make_default: true });
    const id = await create(BASE);
    const before = await sourceOf(id);
    await q(`DELETE FROM agency_campaign_template_versions WHERE template_id = $1`, [tpl.id]);
    const after = await patch(id, { calling_window_start: '11:00' });
    expect(after.calling_window_start).toBe('11:00:00');
    expect(await sourceOf(id)).toEqual(before);
  });

  it('a settings PATCH never fails on the record: a template read that throws is logged, the record kept, the PATCH lands (D1)', async () => {
    await template('account', { hours: HOURS }, { make_default: true });
    const id = await create(BASE);
    const before = await sourceOf(id);
    const spy = vi.spyOn(agencyCampaignTemplateRepository, 'findVersion').mockRejectedValue(new Error('pool exhausted'));
    try {
      const after = await patch(id, { calling_window_start: '11:00' });
      expect(after.calling_window_start).toBe('11:00:00');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect((await settings(id)).calling_window_start).toBe('11:00:00');
    expect(await sourceOf(id)).toEqual(before);
  });

  it('a PATCH that names no section field reads no template and leaves the record (D1)', async () => {
    await template('account', { hours: HOURS }, { make_default: true });
    const id = await create(BASE);
    const before = await sourceOf(id);
    const spy = vi.spyOn(agencyCampaignTemplateRepository, 'findVersion');
    try {
      expect((await patch(id, { name: 'Renamed' })).name).toBe('Renamed');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await sourceOf(id)).toEqual(before);
  });

  it('the recompute reads nothing under the row lock: a record that names other versions by then is left as it is (D1)', async () => {
    const tpl = await template('account', { hours: HOURS }, { make_default: true });
    const id = await create(BASE);
    const campaign = (await agencyCampaignRepository.findById(id))!;
    const recordAfter = (await templateSourceRecompute(campaign))!;
    expect(recordAfter).not.toBeNull();
    // An apply of another version landed between the read and the lock.
    const moved: AgencyCampaignTemplateSource = { ...campaign.template_source!, template: { ...campaign.template_source!.template!, version: 7 } };
    const spy = vi.spyOn(agencyCampaignTemplateRepository, 'findVersion');
    try {
      expect(await recordAfter({ ...campaign, template_source: moved, calling_window_start: '11:00:00' })).toBeNull();
      // Same versions: computed from the fill made before the lock, still with no read.
      expect(await recordAfter({ ...campaign, calling_window_start: '11:00:00' })).toMatchObject({ template: { id: tpl.id }, sections: { hours: 'campaign' } });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a template\'s outcome overrides without contact assignment: left out with a note, never a 403 on a field not sent (S1)', async () => {
    const catalog = [{ code: 'will_pay', label: 'Will pay', override: { extra_attempts: 1 } }, { code: 'refused', label: 'Refused' }];
    const org = await template('organisation', { outcomes: { disposition_catalog: catalog, outcome_dispositions: {} } }, { make_default: true });
    // Contact assignment is off for the account (the flag's default).
    const effective = await sup('GET', '/campaign-templates/effective');
    expect(effective.json().notes).toEqual([{ code: 'outcome_overrides_off', section: 'outcomes' }]);
    const id = await create(BASE);
    const stored = await settings(id);
    expect(stored.disposition_catalog).toEqual([{ code: 'will_pay', label: 'Will pay' }, { code: 'refused', label: 'Refused' }]);
    expect(stored.template_source).toMatchObject({
      template: { id: org.id }, sections: { outcomes: 'organisation' }, notes: [{ code: 'outcome_overrides_off', section: 'outcomes' }],
    });
    // Where contact assignment is on, the overrides are kept.
    await setFlag('agency_contact_assignment_enabled', true);
    const withAssignment = await create(BASE);
    expect((await settings(withAssignment)).disposition_catalog).toEqual(catalog);
  });
});

describe('break_reasons on the create', () => {
  it('stored as sent, and refused by the PATCH\'s rule', async () => {
    const reasons = [{ code: 'tea', label: 'Tea', limit_minutes: 15 }];
    const id = await create({ ...BASE, break_reasons: reasons });
    expect((await settings(id)).break_reasons).toEqual(reasons);
    await setFlag('agency_campaign_templates_enabled', false);
    const off = await create({ ...BASE, break_reasons: reasons });
    expect((await settings(off)).break_reasons).toEqual(reasons);
    const bad = await sup('POST', '/campaigns', { ...BASE, break_reasons: [{ code: 'tea', label: 'Tea', limit_minutes: 999 }] });
    expect(bad.statusCode).toBe(400);
    expect(Object.keys(bad.json().details)).toEqual(['break_reasons']);
  });
});
