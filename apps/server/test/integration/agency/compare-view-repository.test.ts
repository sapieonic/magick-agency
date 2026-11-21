import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * `AgencyCompareViewRepository` on real Postgres (0063, docs/compare-agents.md §4): the rules it owns
 * whatever the route checked first. Only the owner edits or deletes (the predicate is the
 * repository's, not just the route's); a new default clears the campaign's old one in the same
 * transaction, also when two supervisors set one at once; the per-owner limit holds under
 * concurrent creates; the list's order; the tenant and account scope.
 */

import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { closeTestPool, getTestPool, TEST_DB_URL, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { agencyCompareViewRepository as repo, type CompareViewContent } from '../../../src/db/repositories/agency.repository.js';

const tenant = randomUUID();
const account = randomUUID();
const otherAccount = randomUUID();
const campaign = randomUUID();
const sup1 = randomUUID();
const sup2 = randomUUID();
const scope = { tenantId: tenant, accountId: account };

const content = (o: Partial<CompareViewContent> = {}): CompareViewContent => ({
  name: 'View', lens: 'sales', metrics: [{ kind: 'builtin', key: 'calls_handled' }], trend: null,
  campaign_id: campaign, shared: true, is_campaign_default: false, ...o,
});

beforeAll(async () => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 10 });
  await truncateAll();
  const q = (sql: string, v: unknown[]) => getTestPool().query(sql, v);
  await q(`INSERT INTO tenants (id, name, slug, settings, status) VALUES ($1, 'T', $2, '{}', 'active')`, [tenant, `t-${tenant.slice(0, 8)}`]);
  await q(`INSERT INTO accounts (id, tenant_id, name, slug, settings, status) VALUES ($1, $2, 'A', $3, '{}', 'active'), ($4, $2, 'B', $5, '{}', 'active')`,
    [account, tenant, `a-${account.slice(0, 8)}`, otherAccount, `b-${otherAccount.slice(0, 8)}`]);
  await q(`INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids, telephony_provider, status) VALUES ($1, $2, $3, 'C', ARRAY['+919000000001'], 'voicelink', 'draft')`,
    [campaign, tenant, account]);
});

afterAll(async () => {
  await closePool();
  await closeTestPool();
});

describe('ownership', () => {
  it('another supervisor can neither edit nor delete a view, even a shared one', async () => {
    const created = await repo.create({ ...scope, ownerUserId: sup1, maxPerOwner: 50 }, content({ name: 'Mine' }));
    if (!created.ok) throw new Error('limit');
    const id = created.view.id;
    expect(await repo.update({ ...scope, ownerUserId: sup2 }, id, content({ name: 'Hijacked' }))).toBeNull();
    expect(await repo.delete({ ...scope, ownerUserId: sup2 }, id)).toBe(false);
    expect(await repo.findOwned({ ...scope, userId: sup2 }, id)).toBeNull();
    expect(await repo.findVisible({ ...scope, userId: sup2 }, id)).toMatchObject({ name: 'Mine' });
    // Another account of the tenant sees nothing.
    expect(await repo.findVisible({ tenantId: tenant, accountId: otherAccount, userId: sup1 }, id)).toBeNull();
    const updated = await repo.update({ ...scope, ownerUserId: sup1 }, id, content({ name: 'Renamed' }));
    expect(updated).toMatchObject({ name: 'Renamed', owner_user_id: sup1 });
    expect(updated!.updated_at.getTime()).toBeGreaterThanOrEqual(created.view.updated_at.getTime());
    expect(await repo.delete({ ...scope, ownerUserId: sup1 }, id)).toBe(true);
  });
});

describe('one default per campaign', () => {
  it('a new default clears the old one, whoever owns it', async () => {
    const a = await repo.create({ ...scope, ownerUserId: sup1, maxPerOwner: 50 }, content({ name: 'A', is_campaign_default: true }));
    const b = await repo.create({ ...scope, ownerUserId: sup2, maxPerOwner: 50 }, content({ name: 'B', is_campaign_default: true }));
    if (!a.ok || !b.ok) throw new Error('limit');
    expect((await repo.findCampaignDefault(scope, campaign))!.id).toBe(b.view.id);
    const stillA = await repo.findOwned({ ...scope, userId: sup1 }, a.view.id);
    expect(stillA).toMatchObject({ is_campaign_default: false });
    // Cleared without being stamped: its owner did not edit it.
    expect(stillA!.updated_at.getTime()).toBe(a.view.updated_at.getTime());
    // The owner of A takes it back with an edit.
    await repo.update({ ...scope, ownerUserId: sup1 }, a.view.id, content({ name: 'A', is_campaign_default: true }));
    expect((await repo.findCampaignDefault(scope, campaign))!.id).toBe(a.view.id);
  });

  it('two supervisors setting a default at once: both succeed, one default remains', async () => {
    const results = await Promise.all([sup1, sup2, sup1, sup2].map((owner, i) =>
      repo.create({ ...scope, ownerUserId: owner, maxPerOwner: 50 }, content({ name: `Race ${i}`, is_campaign_default: true }))));
    expect(results.every((r) => r.ok)).toBe(true);
    const { rows } = await getTestPool().query(`SELECT count(*)::int AS n FROM agency_compare_views WHERE campaign_id = $1 AND is_campaign_default`, [campaign]);
    expect(rows[0]).toEqual({ n: 1 });
  });
});

describe('the per-owner limit', () => {
  it('holds under concurrent creates', async () => {
    const owner = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      repo.create({ ...scope, ownerUserId: owner, maxPerOwner: 5 }, content({ name: `L${i}`, shared: false, campaign_id: null }))));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toEqual(Array.from({ length: 3 }, () => ({ ok: false, reason: 'limit' })));
  });
});

describe('the list', () => {
  it('own and shared views, the campaign\'s default first, then own, newest first; never another account\'s', async () => {
    const owner = randomUUID();
    const mineNoCampaign = await repo.create({ ...scope, ownerUserId: owner, maxPerOwner: 50 }, content({ name: 'own any', shared: false, campaign_id: null }));
    if (!mineNoCampaign.ok) throw new Error('limit');
    await getPool().query(`INSERT INTO agency_compare_views (tenant_id, account_id, owner_user_id, name, lens, metrics, shared) VALUES ($1, $2, $3, 'elsewhere', 'sales', '[{"kind":"builtin","key":"calls_handled"}]', true)`,
      [tenant, otherAccount, owner]);
    const list = await repo.list({ ...scope, userId: owner, campaignId: campaign });
    const def = await repo.findCampaignDefault(scope, campaign);
    expect(list[0]!.id).toBe(def!.id);
    expect(list[1]!.id).toBe(mineNoCampaign.view.id);
    expect(list.every((v) => v.account_id === account)).toBe(true);
    expect(list.some((v) => !v.shared && v.owner_user_id !== owner)).toBe(false);
    const rest = list.slice(2).map((v) => v.updated_at.getTime());
    expect(rest).toEqual([...rest].sort((x, y) => y - x));
  });
});
