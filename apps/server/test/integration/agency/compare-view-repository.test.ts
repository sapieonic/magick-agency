import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * `AgencyCompareViewRepository` on real Postgres (0064, docs/compare-agents.md §4): the rules it owns
 * whatever the route checked first. Only the owner edits or deletes (the predicate is the
 * repository's, not just the route's); a new default clears the campaign's old one in the same
 * transaction, also when two supervisors set one at once; the per-owner limit holds under
 * concurrent creates; the list's order; the tenant and account scope.
 */

import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { closeTestPool, getTestPool, TEST_DB_URL, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { agencyCompareViewRepository as repo, type CompareViewContent } from '../../../src/db/repositories/agency.repository.js';
import { COMPARE_VIEW_DEFAULT_LOCK_SQL } from '../../../src/db/repositories/agency/compare-view.repository.js';

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

describe('lock order: the campaign\'s default lock before any row', () => {
  it('an edit of the default view while another save holds the lock and clears that row waits, never deadlocks (40P01)', async () => {
    const owner = randomUUID();
    const made = await repo.create({ ...scope, ownerUserId: owner, maxPerOwner: 50 }, content({ name: 'The default', is_campaign_default: true }));
    if (!made.ok) throw new Error('limit');
    const id = made.view.id;

    // Another save in its clearing phase: it holds the campaign's default lock...
    const other = await getTestPool().connect();
    try {
      await other.query('BEGIN');
      await other.query(COMPARE_VIEW_DEFAULT_LOCK_SQL, [campaign]);
      // ...while the owner re-saves the default (a rename keeps it the default).
      const edit = repo.update({ ...scope, ownerUserId: owner }, id, content({ name: 'Renamed default', is_campaign_default: true }))
        .then((v) => ({ ok: true as const, v }), (err: { code?: string }) => ({ ok: false as const, code: err.code }));
      // The edit is now waiting on the advisory lock.
      for (let i = 0; ; i++) {
        const { rows } = await getTestPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE a.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`);
        if (rows[0]!.n > 0) break;
        if (i > 200) throw new Error('the edit never waited on the default lock');
        await new Promise((r) => setTimeout(r, 10));
      }
      // The other save clears the campaign's default: a write to the edited row. An edit that had
      // locked its row before waiting for the default lock deadlocks here.
      const cleared = await other.query(
        `UPDATE agency_compare_views SET is_campaign_default = false WHERE campaign_id = $1::uuid AND is_campaign_default`, [campaign],
      ).then(() => 'ok', (err: { code?: string }) => err.code);
      await other.query(cleared === 'ok' ? 'COMMIT' : 'ROLLBACK');
      expect(cleared).toBe('ok');
      const result = await edit;
      expect(result).toMatchObject({ ok: true, v: { id, name: 'Renamed default', is_campaign_default: true } });
    } finally {
      other.release();
    }
    expect((await repo.findCampaignDefault(scope, campaign))!.id).toBe(id);
  }, 15_000);
});

describe('an edit that does not name the default keeps the row\'s value, read under its lock', () => {
  it('a rename after another supervisor made a new default does not take the default back', async () => {
    const mine = await repo.create({ ...scope, ownerUserId: sup1, maxPerOwner: 50 }, content({ name: 'Old default', is_campaign_default: true }));
    if (!mine.ok) throw new Error('limit');
    // What the route read before the edit's transaction: the view was the default then.
    const stale = await repo.findOwned({ ...scope, userId: sup1 }, mine.view.id);
    expect(stale).toMatchObject({ is_campaign_default: true });
    // Meanwhile another supervisor makes a new default, clearing it.
    const theirs = await repo.create({ ...scope, ownerUserId: sup2, maxPerOwner: 50 }, content({ name: 'New default', is_campaign_default: true }));
    if (!theirs.ok) throw new Error('limit');
    // The owner's rename sends no `is_campaign_default`: kept as the row stands now.
    const renamed = await repo.update({ ...scope, ownerUserId: sup1 }, mine.view.id, { ...content({ name: 'Renamed' }), is_campaign_default: null });
    expect(renamed).toMatchObject({ name: 'Renamed', is_campaign_default: false });
    expect((await repo.findCampaignDefault(scope, campaign))!.id).toBe(theirs.view.id);
  });

  it('also when the new default commits while the rename waits on the campaign\'s lock', async () => {
    const mine = await repo.create({ ...scope, ownerUserId: sup1, maxPerOwner: 50 }, content({ name: 'Old default', is_campaign_default: true }));
    if (!mine.ok) throw new Error('limit');
    // Another save holds the campaign's lock and is about to clear this default and set its own.
    const other = await getTestPool().connect();
    let theirs = '';
    try {
      await other.query('BEGIN');
      await other.query(COMPARE_VIEW_DEFAULT_LOCK_SQL, [campaign]);
      const rename = repo.update({ ...scope, ownerUserId: sup1 }, mine.view.id, { ...content({ name: 'Renamed' }), is_campaign_default: null });
      for (let i = 0; ; i++) {
        const { rows } = await getTestPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE a.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`);
        if (rows[0]!.n > 0) break;
        if (i > 200) throw new Error('the rename never waited on the default lock');
        await new Promise((r) => setTimeout(r, 10));
      }
      await other.query(`UPDATE agency_compare_views SET is_campaign_default = false WHERE campaign_id = $1::uuid AND is_campaign_default`, [campaign]);
      const { rows } = await other.query<{ id: string }>(
        `INSERT INTO agency_compare_views (tenant_id, account_id, owner_user_id, name, lens, metrics, campaign_id, shared, is_campaign_default)
         VALUES ($1, $2, $3, 'New default', 'sales', '[{"kind":"builtin","key":"calls_handled"}]', $4, true, true) RETURNING id`,
        [tenant, account, sup2, campaign]);
      theirs = rows[0]!.id;
      await other.query('COMMIT');
      expect(await rename).toMatchObject({ name: 'Renamed', is_campaign_default: false });
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      other.release();
    }
    expect((await repo.findCampaignDefault(scope, campaign))!.id).toBe(theirs);
  }, 15_000);

  it('a kept default stays the default when nobody changed it', async () => {
    const mine = await repo.create({ ...scope, ownerUserId: sup1, maxPerOwner: 50 }, content({ name: 'Default', is_campaign_default: true }));
    if (!mine.ok) throw new Error('limit');
    const renamed = await repo.update({ ...scope, ownerUserId: sup1 }, mine.view.id, { ...content({ name: 'Still default' }), is_campaign_default: null });
    expect(renamed).toMatchObject({ name: 'Still default', is_campaign_default: true });
    expect((await repo.findCampaignDefault(scope, campaign))!.id).toBe(mine.view.id);
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
