import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * `AgencyCampaignTemplateRepository` on real Postgres (0067, docs/campaign-templates.md §4): the
 * rules it owns whatever the route checked first. Versions and the stale-save refusal (CT6), names
 * unique per scope ignoring case and spaces, also under concurrent creates (CT13), one default per
 * scope (the organisation's included), archive refused while live account templates are based on
 * an organisation template and restore re-checking the name (CT14), the based-on rules (CT10), and
 * the tenant and account scope. Then the campaign side: the create stores `template_source`, and
 * the contract's column defaults (which the built-in template settings are built from) are the
 * `agency_campaigns` column DEFAULTs.
 */

import { closePool, initDbPool } from '@magick-agency/db';
import {
  AGENCY_CAMPAIGN_COLUMN_DEFAULTS,
  AGENCY_CONTACT_ASSIGNMENT_DEFAULTS,
  AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT,
  AGENCY_PHONE_DISPLAY_DEFAULT,
} from '@magick-agency/contracts/agency';
import type { AgencyCampaignTemplateSource } from '@magick-agency/contracts/api/agency/campaign-templates';
import { builtinTemplateSections, sectionsFromCampaign } from '@magick-agency/domain/campaign-templates';
import { closeTestPool, getTestPool, TEST_DB_URL, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  agencyCampaignRepository,
  agencyCampaignTemplateRepository as repo,
  type CampaignTemplateContent,
  type CampaignTemplateScope,
} from '../../../src/db/repositories/agency.repository.js';
import { formatAgencyCampaignResponse } from '../../../src/api/responses/agency-campaign.response.js';
import type { AgencyCampaignRecord } from '../../../src/db/models/agency.model.js';

const tenant = randomUUID();
const otherTenant = randomUUID();
const accountA = randomUUID();
const accountB = randomUUID();
const actor = randomUUID();

const org: CampaignTemplateScope = { tenantId: tenant, accountId: null };
const inA: CampaignTemplateScope = { tenantId: tenant, accountId: accountA };
const inB: CampaignTemplateScope = { tenantId: tenant, accountId: accountB };
const by = { actorUserId: actor };

const content = (o: Partial<CampaignTemplateContent> = {}): CampaignTemplateContent => ({
  name: `Template ${randomUUID().slice(0, 8)}`,
  description: null,
  based_on_template_id: null,
  sections: { hours: { calling_window_start: '10:00:00', calling_window_end: '18:00:00' } },
  ...o,
});

async function created(scope: CampaignTemplateScope, o: Partial<CampaignTemplateContent> = {}, makeDefault = false) {
  const r = await repo.create(scope, content(o), { ...by, makeDefault });
  if (!r.ok) throw new Error(`create refused: ${r.reason}`);
  return r.template;
}

const q = (sql: string, v: unknown[] = []) => getTestPool().query(sql, v);

beforeAll(async () => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 10 });
});

beforeEach(async () => { await truncateAll(); });

afterAll(async () => {
  await closePool();
  await closeTestPool();
});

describe('create, versions', () => {
  it('a create is version 1 with its version row; a replace bumps the version and writes the next', async () => {
    const t = await created(inA, { name: 'Collections', description: 'Daily book' });
    expect(t).toMatchObject({ tenant_id: tenant, account_id: accountA, version: 1, is_default: false, created_by: actor, updated_by: actor, archived_at: null });
    const r = await repo.replace(inA, t.id, { ...content({ name: 'Collections v2', sections: { safety: { abandonment_ceiling_pct: 2 } } }), expected_version: 1 }, by);
    if (!r.ok) throw new Error(r.reason);
    expect(r.template).toMatchObject({ version: 2, name: 'Collections v2', sections: { safety: { abandonment_ceiling_pct: 2 } } });
    expect(r.template.updated_at.getTime()).toBeGreaterThanOrEqual(t.updated_at.getTime());
    const versions = await repo.listVersions(inA, t.id);
    expect(versions!.map((v) => [v.version, v.name])).toEqual([[2, 'Collections v2'], [1, 'Collections']]);
    expect(await repo.findVersion(inA, t.id, 1)).toMatchObject({ version: 1, sections: t.sections, saved_by: actor });
    expect(await repo.findVersion(inA, t.id, 3)).toBeNull();
  });

  it('a save on a stale version is refused with the current version, and changes nothing', async () => {
    const t = await created(inA);
    const first = await repo.replace(inA, t.id, { ...content({ name: 'First' }), expected_version: 1 }, by);
    expect(first.ok).toBe(true);
    expect(await repo.replace(inA, t.id, { ...content({ name: 'Second' }), expected_version: 1 }, by))
      .toEqual({ ok: false, reason: 'changed', current_version: 2 });
    expect(await repo.findVisible(inA, t.id)).toMatchObject({ name: 'First', version: 2 });
    expect((await repo.listVersions(inA, t.id))!.length).toBe(2);
  });

  it('two saves of the same version at once: one wins, the other is refused (the row lock)', async () => {
    const t = await created(inA);
    const results = await Promise.all(['One', 'Two'].map((name) =>
      repo.replace(inA, t.id, { ...content({ name }), expected_version: 1 }, by)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'changed', current_version: 2 }]);
  });
});

describe('names (CT13)', () => {
  it('unique among the scope\'s live templates, ignoring case and repeated spaces', async () => {
    const t = await created(inA, { name: 'Collections  Q1' });
    expect(await repo.create(inA, content({ name: 'collections q1' }), by))
      .toEqual({ ok: false, reason: 'name_taken', template: { id: t.id, name: 'Collections  Q1' } });
    expect((await repo.create(inA, content({ name: ' COLLECTIONS Q1 ' }), by)).ok).toBe(false);
    // Another account, and the organisation, are other scopes.
    expect((await repo.create(inB, content({ name: 'Collections Q1' }), by)).ok).toBe(true);
    expect((await repo.create(org, content({ name: 'Collections Q1' }), by)).ok).toBe(true);
    expect((await repo.create(org, content({ name: 'collections q1' }), by)).ok).toBe(false);
  });

  it('a replace may keep its own name, not take another\'s', async () => {
    const t = await created(inA, { name: 'Sales' });
    await created(inA, { name: 'Renewals' });
    expect((await repo.replace(inA, t.id, { ...content({ name: 'SALES' }), expected_version: 1 }, by)).ok).toBe(true);
    expect(await repo.replace(inA, t.id, { ...content({ name: 'renewals' }), expected_version: 2 }, by))
      .toMatchObject({ ok: false, reason: 'name_taken' });
  });

  it('an archived template\'s name is free; restoring it checks the name again', async () => {
    const old = await created(inA, { name: 'Festive' });
    expect((await repo.archive(inA, old.id, by)).ok).toBe(true);
    const fresh = await created(inA, { name: 'festive' });
    expect(await repo.restore(inA, old.id)).toEqual({ ok: false, reason: 'name_taken', template: { id: fresh.id, name: 'festive' } });
    expect((await repo.findVisible(inA, old.id))!.archived_at).not.toBeNull();
    expect((await repo.archive(inA, fresh.id, by)).ok).toBe(true);
    const restored = await repo.restore(inA, old.id);
    expect(restored).toMatchObject({ ok: true, template: { archived_at: null, archived_by: null, is_default: false } });
  });

  it('two creates of one name at once: one template (the scope lock)', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => repo.create(inA, content({ name: 'Rush' }), by)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r as { reason: string }).reason)).toEqual(['name_taken', 'name_taken', 'name_taken']);
  });
});

describe('defaults', () => {
  it('one default per scope: a new default replaces the old in the same transaction', async () => {
    const a1 = await created(inA, {}, true);
    const a2 = await repo.create(inA, content(), { ...by, makeDefault: true });
    expect(a2).toMatchObject({ ok: true, replaced: { id: a1.id, name: a1.name, version: 1 } });
    expect((await repo.findVisible(inA, a1.id))!.is_default).toBe(false);
    const a3 = await created(inA);
    expect(await repo.setDefault(inA, a3.id)).toMatchObject({ ok: true, template: { id: a3.id, is_default: true }, replaced: { id: (a2 as { template: { id: string } }).template.id } });
    expect((await repo.findDefault(inA))!.id).toBe(a3.id);
    // Already the default: nothing replaced.
    expect(await repo.setDefault(inA, a3.id)).toMatchObject({ ok: true, replaced: null });
  });

  it('the organisation, and each account, has its own default', async () => {
    const o = await created(org, {}, true);
    const a = await created(inA, {}, true);
    const b = await created(inB, {}, true);
    expect((await repo.findDefault(org))!.id).toBe(o.id);
    expect((await repo.findDefault(inA))!.id).toBe(a.id);
    expect((await repo.findDefault(inB))!.id).toBe(b.id);
    const o2 = await created(org);
    expect(await repo.setDefault(org, o2.id)).toMatchObject({ ok: true, replaced: { id: o.id } });
    expect((await repo.findDefault(inA))!.id).toBe(a.id);
  });

  it('clearing the default leaves the scope with none; an archived template cannot become one', async () => {
    const a = await created(inA, {}, true);
    expect(await repo.clearDefault(inA, a.id)).toMatchObject({ ok: true, template: { is_default: false } });
    expect(await repo.findDefault(inA)).toBeNull();
    await repo.archive(inA, a.id, by);
    expect(await repo.setDefault(inA, a.id)).toEqual({ ok: false, reason: 'archived' });
  });

  it('archiving the default clears it', async () => {
    const a = await created(inA, {}, true);
    expect(await repo.archive(inA, a.id, by)).toMatchObject({ ok: true, default_cleared: true, template: { is_default: false, archived_by: actor } });
    expect(await repo.findDefault(inA)).toBeNull();
    // Archived again: nothing changes.
    expect(await repo.archive(inA, a.id, by)).toMatchObject({ ok: true, default_cleared: false });
  });
});

describe('based on and archive (CT10, CT14)', () => {
  it('an account template may follow a live organisation template, not an account template nor an archived one', async () => {
    const o = await created(org);
    const other = await created(inB);
    expect((await repo.create(inA, content({ based_on_template_id: o.id }), by)).ok).toBe(true);
    expect(await repo.create(inA, content({ based_on_template_id: other.id }), by)).toEqual({ ok: false, reason: 'based_on_not_found' });
    expect(await repo.create(inA, content({ based_on_template_id: randomUUID() }), by)).toEqual({ ok: false, reason: 'based_on_not_found' });
    const gone = await created(org);
    await repo.archive(org, gone.id, by);
    expect(await repo.create(inA, content({ based_on_template_id: gone.id }), by)).toEqual({ ok: false, reason: 'based_on_archived' });
  });

  it('archiving an organisation template live account templates follow is refused, naming them; archived followers do not count', async () => {
    const o = await created(org);
    const a = await created(inA, { name: 'Alpha', based_on_template_id: o.id });
    const b = await created(inB, { name: 'Beta', based_on_template_id: o.id });
    expect(await repo.archive(org, o.id, by)).toEqual({
      ok: false, reason: 'in_use',
      templates: [{ id: a.id, name: 'Alpha', account_id: accountA }, { id: b.id, name: 'Beta', account_id: accountB }],
    });
    await repo.archive(inA, a.id, by);
    await repo.archive(inB, b.id, by);
    expect((await repo.archive(org, o.id, by)).ok).toBe(true);
    // Its followers cannot come back while it is archived.
    expect(await repo.restore(inA, a.id)).toEqual({ ok: false, reason: 'based_on_archived' });
  });

  it('an archived template cannot be edited', async () => {
    const t = await created(inA);
    await repo.archive(inA, t.id, by);
    expect(await repo.replace(inA, t.id, { ...content(), expected_version: 1 }, by)).toEqual({ ok: false, reason: 'archived' });
  });
});

describe('tenant and account scope', () => {
  it('another tenant\'s template is not found, read or written', async () => {
    const t = await created(inA);
    const o = await created(org);
    const stranger = { tenantId: otherTenant, accountId: accountA };
    expect(await repo.findVisible(stranger, t.id)).toBeNull();
    expect(await repo.findVisible({ tenantId: otherTenant, accountId: null }, o.id)).toBeNull();
    expect(await repo.list(stranger)).toEqual([]);
    expect(await repo.listVersions(stranger, t.id)).toBeNull();
    expect(await repo.findVersion(stranger, t.id, 1)).toBeNull();
    expect(await repo.replace(stranger, t.id, { ...content(), expected_version: 1 }, by)).toEqual({ ok: false, reason: 'not_found' });
    expect(await repo.setDefault(stranger, t.id)).toEqual({ ok: false, reason: 'not_found' });
    expect(await repo.archive(stranger, t.id, by)).toEqual({ ok: false, reason: 'not_found' });
    expect(await repo.restore(stranger, t.id)).toEqual({ ok: false, reason: 'not_found' });
    expect(await repo.clearDefault(stranger, t.id)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('account B cannot read or write account A\'s template; both read the organisation\'s', async () => {
    const a = await created(inA, { name: 'A one' });
    const o = await created(org, { name: 'Org one' });
    expect(await repo.findVisible(inB, a.id)).toBeNull();
    expect(await repo.listVersions(inB, a.id)).toBeNull();
    expect(await repo.replace(inB, a.id, { ...content(), expected_version: 1 }, by)).toEqual({ ok: false, reason: 'not_found' });
    expect((await repo.findVisible(inB, o.id))!.id).toBe(o.id);
    expect((await repo.list(inB)).map((t) => t.id)).toEqual([o.id]);
    // A write names the exact scope: an account context cannot write an organisation template as its own.
    expect(await repo.setDefault(inA, o.id)).toEqual({ ok: false, reason: 'not_found' });
    // No account context: the organisation's only.
    expect((await repo.list(org)).map((t) => t.id)).toEqual([o.id]);
  });

  it('the list: the account\'s before the organisation\'s, each default first then by name; archived ones apart', async () => {
    const z = await created(inA, { name: 'zeta' });
    const aDefault = await created(inA, { name: 'Omega' }, true);
    const b = await created(inA, { name: 'Beta' });
    const o = await created(org, { name: 'Alpha' });
    const gone = await created(inA, { name: 'Old' });
    await repo.archive(inA, gone.id, by);
    expect((await repo.list(inA)).map((t) => t.id)).toEqual([aDefault.id, b.id, z.id, o.id]);
    expect((await repo.list(inA, { archived: true })).map((t) => t.id)).toEqual([gone.id]);
  });
});

describe('the campaign side', () => {
  const minimal = { tenant_id: tenant, account_id: accountA, name: 'C', caller_ids: ['+919000000001'] };

  it('a create stores template_source, and the campaign\'s wire shape carries it', async () => {
    const source: AgencyCampaignTemplateSource = {
      template: { id: randomUUID(), name: 'Collections', version: 3, scope: 'account' },
      based_on: { id: randomUUID(), name: 'Organisation default', version: 7 },
      sections: {
        outcomes: 'account', retries: 'organisation', hours: 'campaign', wrapup: 'builtin', breaks: 'builtin', recording: 'builtin',
        agent_screen: 'builtin', safety: 'builtin', assignment: 'builtin', inbound: 'builtin', numbers: 'campaign',
      },
    };
    const c = await agencyCampaignRepository.create({ ...minimal, template_source: source, break_reasons: [{ code: 'tea', label: 'Tea' }] });
    expect(c.template_source).toEqual(source);
    expect(c.break_reasons).toEqual([{ code: 'tea', label: 'Tea' }]);
    expect(formatAgencyCampaignResponse(c).template_source).toEqual(source);
    expect((await agencyCampaignRepository.create(minimal)).template_source).toBeNull();
  });

  it('the contract\'s column defaults are agency_campaigns\' DEFAULTs, and a create that omits a setting stores the same', async () => {
    const { rows } = await q(
      `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids) VALUES ($1, $2, 'Raw', ARRAY['+919000000001']) RETURNING *`,
      [tenant, accountA]);
    const raw = rows[0] as AgencyCampaignRecord;
    expect(raw).toMatchObject({
      ...AGENCY_CAMPAIGN_COLUMN_DEFAULTS,
      calling_days: [...AGENCY_CAMPAIGN_COLUMN_DEFAULTS.calling_days],
      ...AGENCY_CONTACT_ASSIGNMENT_DEFAULTS,
      phone_display: AGENCY_PHONE_DISPLAY_DEFAULT,
      abandonment_ceiling_pct: AGENCY_DEFAULT_ABANDONMENT_CEILING_PCT,
    });
    const viaRepo = await agencyCampaignRepository.create(minimal);
    const templateFields = (c: AgencyCampaignRecord) => sectionsFromCampaign(c as never, 'account');
    expect(templateFields(viaRepo)).toEqual(templateFields(raw));
  });

  it('the built-in template settings are what a campaign with every setting omitted holds, but the catalog the create seeds', async () => {
    const { rows } = await q(
      `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids) VALUES ($1, $2, 'Raw', '{}') RETURNING *`,
      [tenant, accountA]);
    const asStored = sectionsFromCampaign(rows[0] as never, 'account');
    const builtin = builtinTemplateSections();
    // The column default is `[]`; the create path seeds the built-in catalog (`withCampaignConfigDefaults`).
    expect(asStored.outcomes!.disposition_catalog).toEqual([]);
    expect({ ...asStored, outcomes: builtin.outcomes }).toEqual(builtin);
  });
});
