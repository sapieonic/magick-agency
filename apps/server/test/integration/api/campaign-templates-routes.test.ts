import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

/**
 * Campaign templates' routes through the REAL app (`buildApp`) on real Postgres and Redis
 * (docs/campaign-templates.md §6): session middleware (Firebase's token check is the one stub),
 * tenancy, RBAC, the flag, the routes, the repository.
 *
 * Pinned here:
 *  - CT17: every route answers `403 feature_disabled` while the flag is off.
 *  - CT3: an agent and a viewer are refused every route; a supervisor reads and writes its
 *    account's templates but never an organisation template (the RBAC 403); an account-scoped
 *    tenant admin is refused an organisation write `403 tenant_wide_membership_required`; another
 *    account's or tenant's template is `404 campaign_template_not_found`, never a 403.
 *  - CT4: a section is refused as a campaign create refuses it, keyed by the campaign's own field
 *    names with the create's messages; the body, the name (CT13) and the sections' shape are
 *    `campaign_template_invalid`; CT5's scope rules `campaign_template_scope_invalid`.
 *  - CT6 versions and the stale save (409 `campaign_template_changed`); CT13 the name taken; the
 *    default switching in a scope; CT14 archive refused while account templates follow an
 *    organisation template, naming them with their account, and restore.
 *  - The effective read: the chain (none, the organisation's default, the account's default
 *    following its based-on or the organisation's default, a named template), its refusals, and
 *    the notes (recording, the call summary profile, numbers, carrier).
 *  - CT9: the audit rows, a default, archive or restore sent twice at once audited once.
 *  - The review's fixes: a set numbers section names a number (S9); `null` only on a nullable
 *    column's field, the list pinned to the schema (S4); sections stored as a campaign stores them
 *    (S5); the size cap (S6).
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import { randomUUID } from 'node:crypto';
import { closePool, initDbPool } from '@magick-agency/db';
import {
  AGENCY_CAMPAIGN_TEMPLATE_NULLABLE_FIELDS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTIONS_MAX_BYTES,
  AGENCY_CAMPAIGN_TEMPLATE_LIVE_MAX,
  AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE,
  AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE_MAX,
  type AgencyCampaignTemplate,
  type AgencyCampaignTemplateEffective,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { AGENCY_DEFAULT_DISPOSITION_CATALOG, AGENCY_NEW_CAMPAIGN_TIMEZONE } from '@magick-agency/contracts/agency';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertPhoneAssignment,
  insertPhoneNumber,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { buildApp } from '../../../src/app.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { agencyCampaignTemplateRepository } from '../../../src/db/repositories/agency.repository.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

interface Person { id: string; uid: string }
interface World {
  tenant: string; a: string; b: string; otherTenant: string; otherAccount: string;
  orgAdmin: Person; scopedAdmin: Person; supA: Person; supB: Person; viewerA: Person; agentA: Person; otherAdmin: Person;
}
let app: FastifyInstance;
let w: World;

async function person(tenant: string, account: string | null, role: string, name: string): Promise<Person> {
  const user = await insertUser({ display_name: name });
  await insertMembership({ user_id: user.id, tenant_id: tenant, account_id: account, role });
  return { id: user.id as string, uid: user.firebase_uid as string };
}

async function setFlag(tenant: string, flag: string, on: boolean): Promise<void> {
  await q(`DELETE FROM feature_flag_overrides WHERE flag_key = $1 AND tenant_id = $2`, [flag, tenant]);
  await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ($1, 'tenant', $2, $3::jsonb)`,
    [flag, tenant, on ? 'true' : 'false']);
  await getFeatureFlagService().invalidate({ tenantId: tenant });
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
  // The service's own carrier, as the baseline seeds it (the truncate empties it).
  await q(`INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink') ON CONFLICT (name) DO NOTHING`);
  const tenant = (await insertTenant()).id as string;
  const a = (await insertAccount({ tenant_id: tenant, name: 'North' })).id as string;
  const b = (await insertAccount({ tenant_id: tenant, name: 'South' })).id as string;
  const otherTenant = (await insertTenant()).id as string;
  const otherAccount = (await insertAccount({ tenant_id: otherTenant })).id as string;
  w = {
    tenant, a, b, otherTenant, otherAccount,
    orgAdmin: await person(tenant, null, 'tenant_admin', 'Olga Admin'),
    scopedAdmin: await person(tenant, a, 'tenant_admin', 'Scoped Admin'),
    supA: await person(tenant, a, 'account_admin', 'Sam Supervisor'),
    supB: await person(tenant, b, 'account_admin', 'Bina Supervisor'),
    viewerA: await person(tenant, a, 'viewer', 'Vic Viewer'),
    agentA: await person(tenant, a, 'agent', 'Asha Agent'),
    otherAdmin: await person(otherTenant, null, 'tenant_admin', 'Other Admin'),
  };
  for (const t of [tenant, otherTenant]) {
    await setFlag(t, 'agency_dialer_enabled', true);
    await setFlag(t, 'agency_campaign_templates_enabled', true);
  }
});

afterAll(async () => {
  await app?.close();
  await closePool();
  await closeTestPool();
});

function headers(who: Person, account: string | null, tenant = w.tenant): Record<string, string> {
  return {
    authorization: `Bearer tok:${who.uid}`,
    'x-tenant-id': tenant,
    ...(account ? { 'x-account-id': account } : {}),
  };
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (who: Person, account: string | null, method: Method, url: string, payload?: unknown, tenant?: string) =>
  app.inject({ method, url: `/proxy/agency${url}`, headers: headers(who, account, tenant), ...(payload !== undefined ? { payload: payload as object } : {}) });

const HOURS = { calling_window_start: '10:00', calling_window_end: '18:00', calling_days: [1, 2, 3, 4, 5, 6], default_timezone: 'Asia/Kolkata' };
const OUTCOMES = {
  disposition_catalog: [{ code: 'will_pay', label: 'Will pay' }, { code: 'refused', label: 'Refused' }],
  outcome_dispositions: {},
};

/** An organisation template, by the organisation admin. */
async function orgTemplate(body: Record<string, unknown> = {}): Promise<AgencyCampaignTemplate> {
  const res = await call(w.orgAdmin, null, 'POST', '/campaign-templates', {
    scope: 'organisation', name: `Org ${randomUUID().slice(0, 6)}`, sections: { hours: HOURS }, ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/** An account template of account A, by its supervisor. */
async function accountTemplate(body: Record<string, unknown> = {}, account = w.a, who = w.supA): Promise<AgencyCampaignTemplate> {
  const res = await call(who, account, 'POST', '/campaign-templates', {
    scope: 'account', name: `Acc ${randomUUID().slice(0, 6)}`, sections: { outcomes: OUTCOMES }, ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function auditRows(action: string): Promise<Array<{ account_id: string | null; resource_id: string; details: Record<string, unknown> }>> {
  await platformAuditLogger.flush();
  const { rows } = await q(
    `SELECT account_id, resource_id, details FROM platform_audit_log
      WHERE tenant_id = $1 AND action = $2 AND resource_type = 'campaign_template' ORDER BY created_at, id`,
    [w.tenant, action],
  );
  return rows;
}

const effective = async (account: string, templateId?: string): Promise<LightMyRequestResponse> =>
  call(w.supA, account, 'GET', `/campaign-templates/effective${templateId ? `?template_id=${templateId}` : ''}`);

// ── The flag (CT17) ─────────────────────────────────────────────────────────

describe('the flag off (CT17)', () => {
  it('every route answers 403 feature_disabled, before anything is read', async () => {
    const tpl = await accountTemplate();
    await setFlag(w.tenant, 'agency_campaign_templates_enabled', false);
    const id = tpl.id;
    const routes: Array<[Method, string, unknown?]> = [
      ['GET', '/campaign-templates'],
      ['GET', '/campaign-templates/effective'],
      ['GET', `/campaign-templates/${id}`],
      ['GET', `/campaign-templates/${id}/versions`],
      ['GET', `/campaign-templates/${id}/versions/1`],
      ['POST', '/campaign-templates', { scope: 'account', name: 'X', sections: {} }],
      ['PUT', `/campaign-templates/${id}`, { name: 'X', description: null, based_on_template_id: null, sections: {}, expected_version: 1 }],
      ['POST', `/campaign-templates/${id}/default`],
      ['DELETE', `/campaign-templates/${id}/default`],
      ['POST', `/campaign-templates/${id}/archive`],
      ['POST', `/campaign-templates/${id}/restore`],
      ['POST', `/campaign-templates/${id}/apply`, { campaign_ids: [randomUUID()], sections: ['hours'] }],
    ];
    for (const [method, url, payload] of routes) {
      const res = await call(w.supA, w.a, method, url, payload);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
      expect(res.json()).toMatchObject({ code: 'feature_disabled' });
    }
    expect((await agencyCampaignTemplateRepository.findVisible({ tenantId: w.tenant, accountId: w.a }, id))!.version).toBe(1);
  });
});

// ── Who (CT3) ───────────────────────────────────────────────────────────────

describe('who may read and write (CT3)', () => {
  it('an agent and a viewer are refused every read and write (the RBAC 403)', async () => {
    const tpl = await accountTemplate();
    for (const who of [w.agentA, w.viewerA]) {
      for (const [method, url, payload] of [
        ['GET', '/campaign-templates'],
        ['GET', '/campaign-templates/effective'],
        ['GET', `/campaign-templates/${tpl.id}`],
        ['POST', '/campaign-templates', { scope: 'account', name: 'Mine', sections: {} }],
        ['POST', `/campaign-templates/${tpl.id}/archive`],
      ] as Array<[Method, string, unknown?]>) {
        const res = await call(who, w.a, method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().message).toMatch(/Insufficient permissions/);
      }
    }
  });

  it('a supervisor keeps its account\'s templates and reads the organisation\'s, but never writes one', async () => {
    const org = await orgTemplate();
    const mine = await accountTemplate();
    const list = await call(w.supA, w.a, 'GET', '/campaign-templates');
    expect(list.statusCode).toBe(200);
    expect(list.json().templates.map((t: { id: string }) => t.id)).toEqual([mine.id, org.id]);

    const create = await call(w.supA, null, 'POST', '/campaign-templates', { scope: 'organisation', name: 'Mine too', sections: {} });
    expect(create.statusCode).toBe(403);
    expect(create.json().code).toBeUndefined();
    for (const [method, url, payload] of [
      ['PUT', `/campaign-templates/${org.id}`, { name: 'X', description: null, based_on_template_id: null, sections: {}, expected_version: 1 }],
      ['POST', `/campaign-templates/${org.id}/default`],
      ['DELETE', `/campaign-templates/${org.id}/default`],
      ['POST', `/campaign-templates/${org.id}/archive`],
      ['POST', `/campaign-templates/${org.id}/restore`],
    ] as Array<[Method, string, unknown?]>) {
      const res = await call(w.supA, w.a, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().message).toMatch(/Insufficient permissions/);
    }
    expect((await agencyCampaignTemplateRepository.findVisible({ tenantId: w.tenant, accountId: null }, org.id))!.version).toBe(1);
  });

  it('an account-scoped tenant admin is refused an organisation write: 403 tenant_wide_membership_required (AA1)', async () => {
    const res = await call(w.scopedAdmin, null, 'POST', '/campaign-templates', { scope: 'organisation', name: 'Scoped', sections: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'tenant_wide_membership_required' });
    const org = await orgTemplate();
    const archive = await call(w.scopedAdmin, w.a, 'POST', `/campaign-templates/${org.id}/archive`);
    expect(archive.statusCode).toBe(403);
    expect(archive.json()).toMatchObject({ code: 'tenant_wide_membership_required' });
    // Their own account's templates are theirs to keep.
    await accountTemplate({}, w.a, w.scopedAdmin);
  });

  it('an organisation admin writes organisation templates without an account, and any account\'s with one', async () => {
    const org = await orgTemplate();
    expect(org).toMatchObject({ scope: 'organisation', account_id: null, version: 1, sections_set: ['hours'] });
    expect(org.updated_by).toEqual({ user_id: w.orgAdmin.id, name: 'Olga Admin' });
    const forB = await accountTemplate({}, w.b, w.orgAdmin);
    expect(forB).toMatchObject({ scope: 'account', account_id: w.b });
  });

  it('another account\'s or tenant\'s template, a missing one and a malformed id are the same 404', async () => {
    const inA = await accountTemplate();
    const org = await orgTemplate();
    for (const [who, account, tenant, id] of [
      [w.supB, w.b, w.tenant, inA.id],
      [w.otherAdmin, w.otherAccount, w.otherTenant, inA.id],
      [w.otherAdmin, null, w.otherTenant, org.id],
      [w.supA, w.a, w.tenant, randomUUID()],
      [w.supA, w.a, w.tenant, 'not-a-uuid'],
    ] as Array<[Person, string | null, string, string]>) {
      for (const [method, url] of [
        ['GET', `/campaign-templates/${id}`],
        ['GET', `/campaign-templates/${id}/versions`],
        ['POST', `/campaign-templates/${id}/archive`],
        // The filled-in form is one account's (without one: 400 account_scope_required).
        ...(account ? [['GET', `/campaign-templates/effective?template_id=${id}`]] : []),
      ] as Array<[Method, string]>) {
        const res = await call(who, account, method, url, undefined, tenant);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.json()).toMatchObject({ code: 'campaign_template_not_found' });
      }
    }
  });

  it('the scope and the context agree: an organisation template without X-Account-Id, an account template with it', async () => {
    const orgWithAccount = await call(w.orgAdmin, w.a, 'POST', '/campaign-templates', { scope: 'organisation', name: 'O', sections: {} });
    expect(orgWithAccount.statusCode).toBe(400);
    expect(orgWithAccount.json().code).toBe('campaign_template_scope_invalid');
    const accountWithout = await call(w.orgAdmin, null, 'POST', '/campaign-templates', { scope: 'account', name: 'A', sections: {} });
    expect(accountWithout.statusCode).toBe(400);
    expect(accountWithout.json().code).toBe('campaign_template_scope_invalid');
  });
});

// ── What is checked (CT4, CT5, CT13) ───────────────────────────────────────

describe('a template is checked as a campaign (CT4) and its scope (CT5)', () => {
  it('a section a campaign create refuses is refused with the create\'s field keys and messages', async () => {
    const bad = {
      hours: { calling_window_start: '18:00', calling_window_end: '18:00' },
      outcomes: { disposition_catalog: [{ code: 'Bad Code', label: 'x' }] },
      wrapup: { allow_wrapup_redial: 'yes' },
    };
    const res = await call(w.supA, w.a, 'POST', '/campaign-templates', { scope: 'account', name: 'Bad', sections: bad });
    expect(res.statusCode, res.body).toBe(400);
    const body = res.json();
    expect(body.code).toBe('campaign_template_section_invalid');
    expect(body.sections).toEqual(['outcomes', 'hours', 'wrapup']);

    // A campaign create carrying the same fields is refused with the same keys and messages.
    const campaign = await call(w.supA, w.a, 'POST', '/campaigns', {
      name: 'Same', caller_ids: ['+919000000001'], ...bad.hours, ...bad.outcomes, ...bad.wrapup,
    });
    expect(campaign.statusCode).toBe(400);
    const keys = Object.keys(campaign.json().details).sort();
    expect(Object.keys(body.details).sort()).toEqual(keys);
    for (const k of keys) expect(body.details[k], k).toBe(campaign.json().details[k]);
    expect(await agencyCampaignTemplateRepository.list({ tenantId: w.tenant, accountId: w.a })).toEqual([]);
  });

  it('a field a section leaves out is its built-in value when checked: an end alone at the built-in start\'s time is refused', async () => {
    const res = await call(w.supA, w.a, 'POST', '/campaign-templates', {
      scope: 'account', name: 'Short day', sections: { hours: { calling_window_end: '09:00' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'campaign_template_section_invalid', sections: ['hours'] });
    expect(Object.keys(res.json().details)).toEqual(['calling_window_end']);
  });

  it('the body, the name and the sections\' shape: 400 campaign_template_invalid with details', async () => {
    for (const [body, key] of [
      [{ scope: 'account', name: '   ', sections: {} }, 'name'],
      [{ scope: 'account', name: 'Tab\there', sections: {} }, 'name'],
      [{ scope: 'account', name: 'x'.repeat(81), sections: {} }, 'name'],
      [{ scope: 'account', name: 'Long', description: 'd'.repeat(281), sections: {} }, 'description'],
      [{ scope: 'account', name: 'Extra', sections: {}, colour: 'red' }, 'body'],
      [{ scope: 'account', name: 'Unknown section', sections: { lunch: {} } }, 'sections.lunch'],
      [{ scope: 'account', name: 'Unknown field', sections: { hours: { lunch_break: true } } }, 'sections.hours.lunch_break'],
      [{ scope: 'account', name: 'Not an object', sections: { hours: [] } }, 'sections.hours'],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await call(w.supA, w.a, 'POST', '/campaign-templates', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().code, JSON.stringify(body)).toBe('campaign_template_invalid');
      expect(Object.keys(res.json().details), JSON.stringify(body)).toContain(key);
    }
  });

  it('an organisation template holds no account-only part, nor a based-on (CT5)', async () => {
    for (const sections of [
      { numbers: { caller_ids: [] } },
      { recording: { record_calls: true, analysis_profile_id: randomUUID() } },
    ]) {
      const res = await call(w.orgAdmin, null, 'POST', '/campaign-templates', { scope: 'organisation', name: 'O', sections });
      expect(res.statusCode, JSON.stringify(sections)).toBe(400);
      expect(res.json().code).toBe('campaign_template_scope_invalid');
    }
    const org = await orgTemplate();
    const basedOn = await call(w.orgAdmin, null, 'POST', '/campaign-templates', {
      scope: 'organisation', name: 'O2', sections: {}, based_on_template_id: org.id,
    });
    expect(basedOn.json().code).toBe('campaign_template_scope_invalid');
    // `record_calls` alone is an organisation's to set.
    await orgTemplate({ sections: { recording: { record_calls: true } } });
  });

  it('based-on: a live organisation template of the tenant only', async () => {
    const org = await orgTemplate();
    const acc = await accountTemplate();
    const onAccount = await call(w.supA, w.a, 'POST', '/campaign-templates', { scope: 'account', name: 'B1', sections: {}, based_on_template_id: acc.id });
    expect(onAccount.json().code).toBe('campaign_template_scope_invalid');
    const missing = await call(w.supA, w.a, 'POST', '/campaign-templates', { scope: 'account', name: 'B2', sections: {}, based_on_template_id: randomUUID() });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('campaign_template_not_found');
    const ok = await accountTemplate({ based_on_template_id: org.id });
    expect(ok.based_on).toEqual({ id: org.id, name: org.name, version: 1, archived: false });
    expect(ok.follows).toMatchObject({ id: org.id, via: 'based_on', archived: false, sections: { hours: HOURS } });
    // Archived: refused 409 (the follower above has to go first).
    expect((await call(w.supA, w.a, 'POST', `/campaign-templates/${ok.id}/archive`)).statusCode).toBe(200);
    expect((await call(w.orgAdmin, null, 'POST', `/campaign-templates/${org.id}/archive`)).statusCode).toBe(200);
    const archived = await call(w.supA, w.a, 'POST', '/campaign-templates', { scope: 'account', name: 'B3', sections: {}, based_on_template_id: org.id });
    expect(archived.statusCode).toBe(409);
    expect(archived.json().code).toBe('campaign_template_archived');
  });

  it('the account checks a create reads the database for: the call summary profile and the carrier', async () => {
    const profile = await call(w.supA, w.a, 'POST', '/campaign-templates', {
      scope: 'account', name: 'P', sections: { recording: { record_calls: false, analysis_profile_id: randomUUID() } },
    });
    expect(profile.statusCode).toBe(400);
    expect(profile.json()).toMatchObject({ code: 'campaign_template_section_invalid', sections: ['recording'] });
    expect(Object.keys(profile.json().details)).toEqual(['analysis_profile_id']);

    const carrier = await call(w.supA, w.a, 'POST', '/campaign-templates', {
      scope: 'account', name: 'N', sections: { numbers: { caller_ids: ['+919000000001'], telephony_credential_id: randomUUID() } },
    });
    expect(carrier.statusCode).toBe(400);
    expect(carrier.json()).toMatchObject({ code: 'campaign_template_section_invalid', sections: ['numbers'] });
    expect(carrier.json().details).toHaveProperty('telephony_credential_id');

    const blank = await call(w.supA, w.a, 'POST', '/campaign-templates', {
      scope: 'account', name: 'Blank', sections: { numbers: { caller_ids: ['  '] } },
    });
    expect(blank.json().details).toEqual({ caller_ids: 'every caller ID must be a non-empty string' });
  });

  it('a malformed call summary profile id is the section refusal keyed on the field, never a generic 400 (D9)', async () => {
    // With call analysis on, the profile is looked up: a non-id must be refused before it reaches the uuid cast.
    await setFlag(w.tenant, 'agency_call_analysis', true);
    for (const bad of ['not-an-id', `${randomUUID()}x`]) {
      const res = await call(w.supA, w.a, 'POST', '/campaign-templates', {
        scope: 'account', name: `P ${bad.slice(0, 4)}`, sections: { recording: { record_calls: false, analysis_profile_id: bad } },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ code: 'campaign_template_section_invalid', sections: ['recording'] });
      expect(Object.keys(res.json().details)).toEqual(['analysis_profile_id']);
    }
  });

  it('a set numbers section names at least one number, as a campaign does (S9)', async () => {
    for (const numbers of [{ caller_ids: [] }, { telephony_provider: 'voicelink' }]) {
      const res = await call(w.supA, w.a, 'POST', '/campaign-templates', { scope: 'account', name: 'Carrier only', sections: { numbers } });
      expect(res.statusCode, JSON.stringify(numbers)).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'campaign_template_section_invalid', sections: ['numbers'], details: { caller_ids: 'at least one caller ID is required' },
      });
    }
  });

  it('null only where a campaign column may hold it, keyed by the field (S4)', async () => {
    for (const [section, field] of [
      ['wrapup', 'wrapup_seconds'], ['wrapup', 'wrapup_auto_return'], ['recording', 'record_calls'],
      ['breaks', 'break_reasons'], ['numbers', 'telephony_provider'], ['hours', 'default_timezone'],
      ['outcomes', 'disposition_catalog'], ['agent_screen', 'agent_script'],
    ] as const) {
      const values: Record<string, unknown> = { [field]: null, ...(section === 'numbers' ? { caller_ids: ['+919000000001'] } : {}) };
      const res = await call(w.supA, w.a, 'POST', '/campaign-templates', { scope: 'account', name: `Null ${field}`, sections: { [section]: values } });
      expect(res.statusCode, field).toBe(400);
      expect(res.json(), field).toMatchObject({ code: 'campaign_template_section_invalid', sections: [section] });
      expect(Object.keys(res.json().details), field).toEqual([field]);
    }
    // Where null means something it is a setting.
    const saved = await accountTemplate({ sections: { agent_screen: { daily_target_calls: null }, recording: { record_calls: false, analysis_profile_id: null } } });
    expect(saved.sections).toEqual({ agent_screen: { daily_target_calls: null }, recording: { record_calls: false, analysis_profile_id: null } });
  });

  it('the section fields declared nullable are exactly the nullable campaign columns (S4)', async () => {
    const fields = AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.flatMap((k) => [...AGENCY_CAMPAIGN_TEMPLATE_SECTIONS[k]] as string[]);
    const { rows } = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'agency_campaigns'
          AND column_name = ANY($1::text[]) AND is_nullable = 'YES'
        ORDER BY column_name`,
      [fields],
    );
    const counted = await q(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'agency_campaigns' AND column_name = ANY($1::text[])`,
      [fields],
    );
    // Every section field is a column, so the list below is judged against all of them.
    expect(counted.rows[0].n).toBe(fields.length);
    expect(rows.map((r: { column_name: string }) => r.column_name)).toEqual([...AGENCY_CAMPAIGN_TEMPLATE_NULLABLE_FIELDS].sort());
  });

  it('sections are saved as a campaign stores them: caller IDs and script texts trimmed (S5)', async () => {
    const res = await call(w.supA, w.a, 'POST', '/campaign-templates', {
      scope: 'account', name: 'Untrimmed',
      sections: {
        numbers: { caller_ids: [' +919000000001 '] },
        agent_screen: { agent_script: { opening: 'Hello ', steps: [{ text: '  Ask for the amount' }] } },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const stored = (await q(`SELECT sections FROM agency_campaign_templates WHERE id = $1`, [res.json().id])).rows[0].sections;
    expect(stored.numbers.caller_ids).toEqual(['+919000000001']);
    expect(stored.agent_screen.agent_script).toEqual({ opening: 'Hello', steps: [{ text: 'Ask for the amount' }] });
    const version = (await q(`SELECT sections FROM agency_campaign_template_versions WHERE template_id = $1`, [res.json().id])).rows[0].sections;
    expect(version).toEqual(stored);
  });

  it('sections over the size cap are refused before anything is read: 400 campaign_template_invalid on sections (S6)', async () => {
    const big = { outcomes: { disposition_catalog: [{ code: 'x', label: 'x'.repeat(AGENCY_CAMPAIGN_TEMPLATE_SECTIONS_MAX_BYTES) }] } };
    const created = await call(w.supA, w.a, 'POST', '/campaign-templates', { scope: 'account', name: 'Big', sections: big });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({ code: 'campaign_template_invalid' });
    expect(Object.keys(created.json().details)).toEqual(['sections']);
    // A replace too, judged before the template is looked up: a missing one is not read.
    const replaced = await call(w.supA, w.a, 'PUT', `/campaign-templates/${randomUUID()}`, {
      name: 'Big', description: null, based_on_template_id: null, sections: big, expected_version: 1,
    });
    expect(replaced.statusCode).toBe(400);
    expect(Object.keys(replaced.json().details)).toEqual(['sections']);
    expect((await q(`SELECT count(*)::int AS n FROM agency_campaign_templates`)).rows[0].n).toBe(0);
    // A template within the cap is saved.
    const fits = { breaks: { break_reasons: [{ code: 'tea', label: 'Tea' }] } };
    await accountTemplate({ sections: fits });
  });
});

// ── Versions, names, defaults, archive (CT6, CT13, CT14) ───────────────────

describe('versions and the stale save (CT6)', () => {
  it('each save is a version; a save on an old version is 409 with the current one', async () => {
    const tpl = await accountTemplate({ description: 'First' });
    const put = (expected: number, sections: Record<string, unknown>) => call(w.supA, w.a, 'PUT', `/campaign-templates/${tpl.id}`, {
      name: tpl.name, description: 'Second', based_on_template_id: null, sections, expected_version: expected,
    });
    const saved = await put(1, { outcomes: OUTCOMES, hours: HOURS });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ version: 2, description: 'Second', sections_set: ['outcomes', 'hours'] });

    const stale = await put(1, { hours: HOURS });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'campaign_template_changed', current_version: 2 });

    const versions = await call(w.supA, w.a, 'GET', `/campaign-templates/${tpl.id}/versions`);
    expect(versions.json()).toMatchObject({
      template_id: tpl.id,
      versions: [
        { version: 2, sections_set: ['outcomes', 'hours'], saved_by: { user_id: w.supA.id, name: 'Sam Supervisor' } },
        { version: 1, sections_set: ['outcomes'] },
      ],
    });
    const v1 = await call(w.supA, w.a, 'GET', `/campaign-templates/${tpl.id}/versions/1`);
    expect(v1.json()).toMatchObject({ template_id: tpl.id, version: 1, sections: { outcomes: OUTCOMES } });
    for (const n of ['3', '0', 'x']) {
      expect((await call(w.supA, w.a, 'GET', `/campaign-templates/${tpl.id}/versions/${n}`)).statusCode).toBe(404);
    }

    const [updated] = await auditRows('campaign_template.updated');
    expect(updated).toMatchObject({
      account_id: w.a, resource_id: tpl.id,
      details: { scope: 'account', from_version: 1, to_version: 2, version: 2, sections_changed: ['hours'] },
    });
  });

  it('the history a page at a time: the newest by default, older ones before a version; a bad query is 400 (D4)', async () => {
    const tpl = await accountTemplate();
    for (let v = 1; v <= 3; v++) {
      const res = await call(w.supA, w.a, 'PUT', `/campaign-templates/${tpl.id}`, {
        name: tpl.name, description: null, based_on_template_id: null,
        sections: v === 2 ? { hours: HOURS, outcomes: OUTCOMES } : { outcomes: OUTCOMES }, expected_version: v,
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    const page = async (query: string) => {
      const res = await call(w.supA, w.a, 'GET', `/campaign-templates/${tpl.id}/versions${query}`);
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { versions: Array<{ version: number; sections_set: string[] }> }).versions;
    };
    expect((await page('')).map((v) => v.version)).toEqual([4, 3, 2, 1]);
    // `sections_set` in the section map's order, read without the sections.
    expect((await page('?limit=2')).map((v) => [v.version, v.sections_set])).toEqual([[4, ['outcomes']], [3, ['outcomes', 'hours']]]);
    expect((await page('?before=3&limit=5')).map((v) => v.version)).toEqual([2, 1]);
    expect(await page('?before=1')).toEqual([]);
    for (const bad of ['?limit=0', `?limit=${AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE_MAX + 1}`, '?limit=x', '?before=0', '?before=-1']) {
      const res = await call(w.supA, w.a, 'GET', `/campaign-templates/${tpl.id}/versions${bad}`);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().code).toBe('campaign_template_invalid');
    }
  });

  it('the history answers at most AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE versions when no limit is sent (D4)', async () => {
    const tpl = await accountTemplate();
    // Older saved states, written straight to the history.
    await q(
      `INSERT INTO agency_campaign_template_versions (template_id, version, name, sections)
       SELECT $1::uuid, n, 'Old', '{}'::jsonb FROM generate_series(2, $2::int + 5) n`,
      [tpl.id, AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE],
    );
    const res = await call(w.supA, w.a, 'GET', `/campaign-templates/${tpl.id}/versions`);
    const versions = (res.json() as { versions: Array<{ version: number }> }).versions;
    expect(versions).toHaveLength(AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE);
    expect(versions[0]!.version).toBe(AGENCY_CAMPAIGN_TEMPLATE_VERSIONS_PAGE + 5);
  });

  it('an archived template is not edited (409 campaign_template_archived)', async () => {
    const tpl = await accountTemplate();
    await call(w.supA, w.a, 'POST', `/campaign-templates/${tpl.id}/archive`);
    const res = await call(w.supA, w.a, 'PUT', `/campaign-templates/${tpl.id}`, {
      name: tpl.name, description: null, based_on_template_id: null, sections: {}, expected_version: 1,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('campaign_template_archived');
  });
});

describe('names (CT13)', () => {
  it('unique in the scope ignoring case and spaces; the organisation and an account may share one', async () => {
    const first = await accountTemplate({ name: 'Collections  Default' });
    const clash = await call(w.supA, w.a, 'POST', '/campaign-templates', { scope: 'account', name: ' collections default', sections: {} });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ code: 'campaign_template_name_taken', template: { id: first.id, name: 'Collections  Default' } });
    await orgTemplate({ name: 'Collections Default' });
    await accountTemplate({ name: 'Collections Default' }, w.b, w.supB);
  });
});

describe('the cap on live templates (D4)', () => {
  it('a create or a restore past AGENCY_CAMPAIGN_TEMPLATE_LIVE_MAX is 400 campaign_template_invalid on templates', async () => {
    const archived = await accountTemplate({ name: 'Old one' });
    await call(w.supA, w.a, 'POST', `/campaign-templates/${archived.id}/archive`);
    await q(
      `INSERT INTO agency_campaign_templates (tenant_id, account_id, name)
       SELECT $1::uuid, $2::uuid, 'Filler ' || n FROM generate_series(1, $3::int) n`,
      [w.tenant, w.a, AGENCY_CAMPAIGN_TEMPLATE_LIVE_MAX],
    );
    const create = await call(w.supA, w.a, 'POST', '/campaign-templates', { scope: 'account', name: 'One too many', sections: {} });
    expect(create.statusCode).toBe(400);
    expect(create.json()).toMatchObject({ code: 'campaign_template_invalid', details: { templates: expect.stringContaining(`${AGENCY_CAMPAIGN_TEMPLATE_LIVE_MAX} templates`) } });
    expect(create.json().message).toBe(create.json().details.templates);
    const restore = await call(w.supA, w.a, 'POST', `/campaign-templates/${archived.id}/restore`);
    expect(restore.statusCode).toBe(400);
    expect(restore.json().code).toBe('campaign_template_invalid');
    // The organisation has its own cap.
    expect((await call(w.orgAdmin, null, 'POST', '/campaign-templates', { scope: 'organisation', name: 'Org', sections: {} })).statusCode).toBe(201);
  });
});

describe('defaults', () => {
  it('one per scope: making another the default clears the first, in the answer and the list; DELETE leaves none', async () => {
    const one = await orgTemplate({ make_default: true });
    expect(one.is_default).toBe(true);
    const two = await orgTemplate();
    const res = await call(w.orgAdmin, null, 'POST', `/campaign-templates/${two.id}/default`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ template: { id: two.id, is_default: true }, replaced: { id: one.id, name: one.name, version: 1 } });
    const list = (await call(w.supA, w.a, 'GET', '/campaign-templates')).json().templates as Array<{ id: string; is_default: boolean }>;
    expect(list.filter((t) => t.is_default).map((t) => t.id)).toEqual([two.id]);
    // An account default is its own scope's.
    const mine = await accountTemplate({ make_default: true });
    expect(mine.is_default).toBe(true);

    const cleared = await call(w.orgAdmin, null, 'DELETE', `/campaign-templates/${two.id}/default`);
    expect(cleared.json()).toMatchObject({ template: { id: two.id, is_default: false }, replaced: null });
    expect((await call(w.supA, w.a, 'GET', '/campaign-templates')).json().templates
      .filter((t: { is_default: boolean }) => t.is_default).map((t: { id: string }) => t.id)).toEqual([mine.id]);

    // One flush writes a batch with one `created_at`: rows are compared by template, not by order.
    const set = new Map((await auditRows('campaign_template.default_set')).map((r) => [r.resource_id, r]));
    expect([...set.keys()].sort()).toEqual([one.id, two.id, mine.id].sort());
    expect(set.get(two.id)!.details).toMatchObject({ replaced: { id: one.id } });
    expect(set.get(one.id)!.account_id).toBeNull();
    expect(set.get(mine.id)!.account_id).toBe(w.a);
    expect((await auditRows('campaign_template.default_cleared')).map((r) => r.resource_id)).toEqual([two.id]);
  });
});

describe('archive and restore (CT14)', () => {
  it('an organisation template account templates follow is refused, naming them and their accounts', async () => {
    const org = await orgTemplate({ make_default: true });
    const follower = await accountTemplate({ name: 'Follows org', based_on_template_id: org.id });
    const res = await call(w.orgAdmin, null, 'POST', `/campaign-templates/${org.id}/archive`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'campaign_template_in_use',
      templates: [{ id: follower.id, name: 'Follows org', account_id: w.a, account_name: 'North' }],
    });
    expect(res.json().message).toContain('"Follows org"');

    expect((await call(w.supA, w.a, 'POST', `/campaign-templates/${follower.id}/archive`)).statusCode).toBe(200);
    const archived = await call(w.orgAdmin, null, 'POST', `/campaign-templates/${org.id}/archive`);
    expect(archived.json()).toMatchObject({ default_cleared: true, template: { is_default: false, archived_by: { user_id: w.orgAdmin.id } } });
    expect((await call(w.supA, w.a, 'GET', '/campaign-templates')).json().templates).toEqual([]);
    expect((await call(w.supA, w.a, 'GET', '/campaign-templates?archived=true')).json().templates.map((t: { id: string }) => t.id).sort())
      .toEqual([follower.id, org.id].sort());

    const restored = await call(w.orgAdmin, null, 'POST', `/campaign-templates/${org.id}/restore`);
    expect(restored.json()).toMatchObject({ template: { id: org.id, archived_at: null, is_default: false } });
    expect((await auditRows('campaign_template.archived')).map((r) => r.resource_id).sort()).toEqual([follower.id, org.id].sort());
    expect((await auditRows('campaign_template.restored')).map((r) => r.resource_id)).toEqual([org.id]);
  });

  it('a default, an archive or a restore sent twice at once is audited once (S12)', async () => {
    const tpl = await accountTemplate();
    const twice = (path: string, method: Method = 'POST') => Promise.all([
      call(w.supA, w.a, method, `/campaign-templates/${tpl.id}${path}`),
      call(w.supA, w.a, method, `/campaign-templates/${tpl.id}${path}`),
    ]);
    for (const [path, method, action] of [
      ['/default', 'POST', 'campaign_template.default_set'],
      ['/default', 'DELETE', 'campaign_template.default_cleared'],
      ['/archive', 'POST', 'campaign_template.archived'],
      ['/restore', 'POST', 'campaign_template.restored'],
    ] as const) {
      const answers = await twice(path, method);
      expect(answers.map((r) => r.statusCode), path).toEqual([200, 200]);
      expect((await auditRows(action)).length, action).toBe(1);
    }
  });

  it('restoring checks the name again', async () => {
    const old = await accountTemplate({ name: 'Renewals' });
    await call(w.supA, w.a, 'POST', `/campaign-templates/${old.id}/archive`);
    await accountTemplate({ name: 'renewals' });
    const res = await call(w.supA, w.a, 'POST', `/campaign-templates/${old.id}/restore`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('campaign_template_name_taken');
  });
});

// ── The filled-in form (effective) ─────────────────────────────────────────

describe('GET /campaign-templates/effective: the chain and the notes', () => {
  it('none: the built-in settings, Asia/Kolkata hours, every section built-in', async () => {
    const res = await effective(w.a);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as AgencyCampaignTemplateEffective;
    expect(body).toMatchObject({ template: null, based_on: null, notes: [] });
    expect(body.config.default_timezone).toBe(AGENCY_NEW_CAMPAIGN_TIMEZONE);
    expect(body.config.disposition_catalog).toEqual([...AGENCY_DEFAULT_DISPOSITION_CATALOG]);
    expect(Object.values(body.sources)).toEqual(AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.map(() => 'builtin'));
  });

  it('the organisation\'s default; then the account\'s default following it, or its based-on', async () => {
    const orgDefault = await orgTemplate({ make_default: true, sections: { hours: HOURS, safety: { abandonment_ceiling_pct: 2 } } });
    let body = (await effective(w.a)).json() as AgencyCampaignTemplateEffective;
    expect(body.template).toEqual({ id: orgDefault.id, name: orgDefault.name, version: 1, scope: 'organisation' });
    expect(body.based_on).toBeNull();
    expect(body.sources).toMatchObject({ hours: 'organisation', safety: 'organisation', outcomes: 'builtin' });
    expect(body.config).toMatchObject({ calling_window_start: '10:00:00', calling_days: [1, 2, 3, 4, 5, 6], abandonment_ceiling_pct: 2 });

    // An account default that sets outcomes and hours, and follows the organisation's default.
    const mine = await accountTemplate({ make_default: true, sections: { outcomes: OUTCOMES, hours: { calling_window_start: '11:00' } } });
    body = (await effective(w.a)).json();
    expect(body.template).toMatchObject({ id: mine.id, scope: 'account' });
    expect(body.based_on).toEqual({ id: orgDefault.id, name: orgDefault.name, version: 1 });
    expect(body.sources).toMatchObject({ outcomes: 'account', hours: 'account', safety: 'organisation' });
    // The account's hours win WHOLE (CT2): its absent fields are built-in, never the organisation's.
    expect(body.config).toMatchObject({ calling_window_start: '11:00:00', calling_window_end: '20:00:00', calling_days: [1, 2, 3, 4, 5], default_timezone: 'Asia/Kolkata' });
    expect(body.config.disposition_catalog).toEqual(OUTCOMES.disposition_catalog);

    // Based on another organisation template: that one, whatever the default.
    const other = await orgTemplate({ sections: { wrapup: { wrapup_seconds: 90 } } });
    const res = await call(w.supA, w.a, 'PUT', `/campaign-templates/${mine.id}`, {
      name: mine.name, description: null, based_on_template_id: other.id, sections: { outcomes: OUTCOMES }, expected_version: 1,
    });
    expect(res.statusCode, res.body).toBe(200);
    body = (await effective(w.a)).json();
    expect(body.based_on).toMatchObject({ id: other.id });
    expect(body.sources).toMatchObject({ outcomes: 'account', wrapup: 'organisation', safety: 'builtin', hours: 'builtin' });
    expect(body.config.wrapup_seconds).toBe(90);

    // Account B has no default: the organisation's.
    expect(((await call(w.supB, w.b, 'GET', '/campaign-templates/effective')).json() as AgencyCampaignTemplateEffective).template)
      .toMatchObject({ id: orgDefault.id });
  });

  it('a named template: any the account can see, else 404; archived 409; without an account 400', async () => {
    await orgTemplate({ make_default: true });
    const named = await orgTemplate({ sections: { wrapup: { wrapup_seconds: 45 } } });
    const body = (await effective(w.a, named.id)).json() as AgencyCampaignTemplateEffective;
    expect(body.template).toMatchObject({ id: named.id, scope: 'organisation' });
    expect(body.sources.hours).toBe('builtin');
    expect(body.config.wrapup_seconds).toBe(45);

    const inB = await accountTemplate({}, w.b, w.supB);
    expect((await effective(w.a, inB.id)).statusCode).toBe(404);
    await call(w.orgAdmin, null, 'POST', `/campaign-templates/${named.id}/archive`);
    const archived = await effective(w.a, named.id);
    expect(archived.statusCode).toBe(409);
    expect(archived.json().code).toBe('campaign_template_archived');
    const noAccount = await call(w.orgAdmin, null, 'GET', '/campaign-templates/effective');
    expect(noAccount.statusCode).toBe(400);
    expect(noAccount.json().code).toBe('account_scope_required');
  });

  it('the notes: recording the account cannot have, a profile gone, numbers and a carrier no longer usable', async () => {
    // Stored directly: the routes refuse a profile or a carrier that is not usable when saved; these
    // became unusable after.
    const voicelink = (await q(`SELECT id FROM telephony_providers WHERE name = 'voicelink'`)).rows[0].id as string;
    const kept = await insertPhoneNumber({ provider_id: voicelink, phone_number: '+919000000111' });
    await insertPhoneAssignment({ tenant_id: w.tenant, phone_number_id: kept.id });
    const created = await agencyCampaignTemplateRepository.create({ tenantId: w.tenant, accountId: w.a }, {
      name: 'Gone things', description: null, based_on_template_id: null,
      sections: {
        recording: { record_calls: true, analysis_profile_id: randomUUID() },
        numbers: { caller_ids: ['+919000000111', '+919000000222'] },
        assignment: { assignment_mode: 'strict' },
      },
    }, { actorUserId: w.supA.id });
    if (!created.ok) throw new Error(created.reason);
    const body = (await effective(w.a, created.template.id)).json() as AgencyCampaignTemplateEffective;
    expect(body.notes).toEqual([
      { code: 'section_flag_off', section: 'assignment' },
      { code: 'recording_not_allowed', section: 'recording' },
      { code: 'analysis_profile_unavailable', section: 'recording' },
      { code: 'numbers_unavailable', section: 'numbers', numbers: ['+919000000222'] },
    ]);
    expect(body.config).toMatchObject({ record_calls: false, analysis_profile_id: null, caller_ids: ['+919000000111'], assignment_mode: 'pool' });
    expect(body.sources).toMatchObject({ numbers: 'account', recording: 'account', assignment: 'builtin' });

    const plivo = await agencyCampaignTemplateRepository.create({ tenantId: w.tenant, accountId: w.a }, {
      name: 'Gone carrier', description: null, based_on_template_id: null,
      sections: { numbers: { caller_ids: ['+919000000111'], telephony_provider: 'plivo', telephony_credential_id: randomUUID() } },
    }, { actorUserId: w.supA.id });
    if (!plivo.ok) throw new Error(plivo.reason);
    const carrier = (await effective(w.a, plivo.template.id)).json() as AgencyCampaignTemplateEffective;
    expect(carrier.notes).toEqual([{ code: 'carrier_unavailable', section: 'numbers' }]);
    expect(carrier.sources.numbers).toBe('builtin');
    expect(carrier.config).toMatchObject({ caller_ids: [], telephony_provider: 'voicelink', telephony_credential_id: null });
  });

  it('recording kept where the account may record', async () => {
    await q(`INSERT INTO account_settings (tenant_id, account_id, allow_recording) VALUES ($1, $2, true)`, [w.tenant, w.a]);
    const tpl = await accountTemplate({ sections: { recording: { record_calls: true } } });
    const body = (await effective(w.a, tpl.id)).json() as AgencyCampaignTemplateEffective;
    expect(body.notes).toEqual([]);
    expect(body.config.record_calls).toBe(true);
  });
});

// ── The audit (CT9) ─────────────────────────────────────────────────────────

describe('the audit (CT9)', () => {
  it('created: an organisation template under the tenant, an account template under its account', async () => {
    const org = await orgTemplate();
    const acc = await accountTemplate({ based_on_template_id: org.id });
    const rows = new Map((await auditRows('campaign_template.created')).map((r) => [r.resource_id, r]));
    expect(rows.size).toBe(2);
    expect(rows.get(org.id)).toEqual(
      { account_id: null, resource_id: org.id, details: expect.objectContaining({ scope: 'organisation', version: 1, sections: ['hours'] }) });
    expect(rows.get(acc.id)).toEqual(
      { account_id: w.a, resource_id: acc.id, details: expect.objectContaining({ scope: 'account', version: 1, based_on_template_id: org.id }) });
  });
});
