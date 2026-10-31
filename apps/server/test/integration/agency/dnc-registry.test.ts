import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import {
  TEST_DB_URL, getTestPool, closeTestPool, truncateAll,
} from '../../../../../packages/db/test/helpers/test-db.js';
import { DncRegistry } from '../../../src/agency/dnc-registry.js';
import { markDnc } from '../../../src/agency/dnc-mark.js';
import { dncRepository } from '../../../src/dnc/dnc.repository.js';
import { agencyContactRepository } from '../../../src/db/repositories/agency.repository.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

/**
 * the dial-time DNC check and
 * the agent's mark against the REAL `dnc_entries` table. Covers "DNC
 * fails closed" (a real DB error is `unavailable`, never `clear`) and the three
 * scopes: tenant-wide, account-scoped and campaign-scoped entries each block.
 */
describe('DncRegistry + markDnc over real dnc_entries', () => {
  const PHONE = '+14155550123';
  let tenant: string; let account: string; let otherAccount: string;
  let campaign: string; let otherCampaign: string;
  const registry = new DncRegistry();

  beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 }); });
  afterAll(async () => { await closePool(); await closeTestPool(); });

  beforeEach(async () => {
    await truncateAll();
    tenant = randomUUID(); account = randomUUID(); otherAccount = randomUUID();
    campaign = randomUUID(); otherCampaign = randomUUID();
    const pool = getTestPool();
    await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1,'t',$2)`, [tenant, `t-${tenant}`]);
    for (const a of [account, otherAccount]) {
      await pool.query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1,$2,'a',$3)`, [a, tenant, `a-${a}`]);
    }
  });

  const insert = (o: { account_id?: string | null; campaign_id?: string | null }) =>
    dncRepository.insertMany({
      tenant_id: tenant, account_id: o.account_id ?? null, campaign_id: o.campaign_id ?? null,
      source: 'api', phones: [PHONE],
    });
  const check = (acct: string | null, camp: string | null) =>
    registry.check(tenant, PHONE, { accountId: acct, campaignId: camp });

  it('is clear with no entry', async () => {
    expect(await check(account, campaign)).toBe('clear');
  });

  it('a tenant-wide entry blocks every account and campaign', async () => {
    await insert({});
    expect(await check(account, campaign)).toBe('suppressed');
    expect(await check(otherAccount, otherCampaign)).toBe('suppressed');
    expect(await check(null, null)).toBe('suppressed');
  });

  it('an ACCOUNT-scoped entry blocks the dial for that account only', async () => {
    await insert({ account_id: account });
    expect(await check(account, campaign)).toBe('suppressed');
    expect(await check(otherAccount, campaign)).toBe('clear');
  });

  it('a CAMPAIGN-scoped entry blocks the dial for that campaign only', async () => {
    await insert({ campaign_id: campaign });
    expect(await check(account, campaign)).toBe('suppressed');
    expect(await check(account, otherCampaign)).toBe('clear');
  });

  it('another tenant is never affected', async () => {
    await insert({});
    expect(await registry.check(randomUUID(), PHONE, { accountId: null, campaignId: null })).toBe('clear');
  });

  it("an agent's campaign mark (markDnc) blocks that campaign's next dial and no other", async () => {
    const r = await markDnc({ tenantId: tenant, campaignId: campaign, phoneE164: PHONE });
    expect(r).toMatchObject({ recorded: true, alreadyPresent: false, phoneE164: PHONE, written: { campaign_id: campaign } });
    expect(await check(account, campaign)).toBe('suppressed');
    expect(await check(account, otherCampaign)).toBe('clear');
    expect(await markDnc({ tenantId: tenant, campaignId: campaign, phoneE164: PHONE }))
      .toMatchObject({ recorded: true, alreadyPresent: true });
  });

  it('the tenant escalation (campaignId omitted) writes a tenant-wide row', async () => {
    const r = await markDnc({ tenantId: tenant, phoneE164: PHONE });
    expect(r.written).toEqual({ id: expect.any(String), campaign_id: null, account_id: null });
    expect(await check(account, otherCampaign)).toBe('suppressed');
  });

  it('refuses an account scope and the nil-UUID sentinel, writing nothing', async () => {
    expect(await markDnc({ tenantId: tenant, accountId: account, phoneE164: PHONE })).toMatchObject({ recorded: false, refused: 'invalid_dnc_scope' });
    expect(await markDnc({ tenantId: tenant, campaignId: '00000000-0000-0000-0000-000000000000', phoneE164: PHONE })).toMatchObject({ refused: 'invalid_dnc_scope' });
    const { rows } = await getTestPool().query('SELECT 1 FROM dnc_entries');
    expect(rows).toHaveLength(0);
  });

  it('an unusable phone is unverifiable and writes nothing', async () => {
    expect(await registry.check(tenant, 'not-a-number', { accountId: null, campaignId: null })).toBe('unverifiable');
    expect((await markDnc({ tenantId: tenant, phoneE164: 'abc' })).phoneE164).toBeNull();
  });

  it("markDnc with the caller's client joins its transaction: the caller's ROLLBACK removes the row", async () => {
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      const r = await markDnc({ tenantId: tenant, campaignId: campaign, phoneE164: PHONE }, { client });
      expect(r).toMatchObject({ recorded: true, written: { campaign_id: campaign } });
      // Visible inside the open transaction, invisible outside it until COMMIT.
      expect((await client.query('SELECT 1 FROM dnc_entries')).rows).toHaveLength(1);
      expect((await getTestPool().query('SELECT 1 FROM dnc_entries')).rows).toHaveLength(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await getTestPool().query('SELECT 1 FROM dnc_entries')).rows).toHaveLength(0);
    expect(await check(account, campaign)).toBe('clear');
  });

  it("markDnc with the caller's client REJECTS on a failed statement instead of reporting recorded:false", async () => {
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      await expect(markDnc({ tenantId: 'not-a-uuid', campaignId: campaign, phoneE164: PHONE }, { client }))
        .rejects.toThrow(/invalid input syntax for type uuid/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // Without a client the same failure is reported, not thrown (module header).
    expect(await markDnc({ tenantId: 'not-a-uuid', campaignId: campaign, phoneE164: PHONE }))
      .toMatchObject({ recorded: false });
  });

  it('FAILS CLOSED on a real database error: a malformed tenant id is `unavailable`, never `clear`', async () => {
    expect(await registry.check('not-a-uuid', PHONE, { accountId: null, campaignId: null })).toBe('unavailable');
  });

  // ── checkEntry: the soft phone's `dnc_listed` names the entry (SP1) ──────────
  it('checkEntry answers the WIDEST matching entry, with the same scope predicate as check', async () => {
    expect(await registry.checkEntry(tenant, PHONE, { accountId: account, campaignId: campaign })).toEqual({ result: 'clear' });
    await insert({ campaign_id: campaign });
    const camp = await registry.checkEntry(tenant, PHONE, { accountId: account, campaignId: campaign });
    expect(camp.result === 'suppressed' && camp.entry.scope).toBe('campaign');
    // Another campaign of the account is not matched by it — exactly as `check`.
    expect(await registry.checkEntry(tenant, PHONE, { accountId: account, campaignId: otherCampaign })).toEqual({ result: 'clear' });
    await insert({ account_id: account });
    const acct = await registry.checkEntry(tenant, PHONE, { accountId: account, campaignId: campaign });
    expect(acct.result === 'suppressed' && acct.entry.scope).toBe('account');
    await insert({});
    const wide = await registry.checkEntry(tenant, PHONE, { accountId: account, campaignId: campaign });
    expect(wide.result === 'suppressed' && wide.entry.scope).toBe('tenant');
    const { rows } = await getTestPool().query(
      'SELECT id FROM dnc_entries WHERE tenant_id = $1 AND account_id IS NULL AND campaign_id IS NULL', [tenant]);
    expect(wide.result === 'suppressed' && wide.entry.id).toBe(rows[0].id);
  });

  it('checkEntry FAILS CLOSED on a real database error', async () => {
    expect(await registry.checkEntry('not-a-uuid', PHONE, { accountId: null, campaignId: null })).toEqual({ result: 'unavailable' });
    expect(await registry.checkEntry('not-a-uuid', PHONE, { accountId: account, everyCampaignOfAccount: true }))
      .toEqual({ result: 'unavailable' });
  });

  // ── The soft phone's UNTAGGED dial (docs/softphone.md §4.1 step 2) ───────────
  it('every-campaign-of-account: a campaign entry of ANY campaign of the account matches, another account\'s never', async () => {
    const mine = await insertAgencyCampaign({ tenant_id: tenant, account_id: account });
    const theirs = await insertAgencyCampaign({ tenant_id: tenant, account_id: otherAccount });
    const untagged = () => registry.checkEntry(tenant, PHONE, { accountId: account, everyCampaignOfAccount: true });

    expect(await untagged()).toEqual({ result: 'clear' });
    // Another account's campaign row, and a row naming no real campaign: not this account's.
    await insert({ campaign_id: theirs.id as string });
    await insert({ campaign_id: campaign });
    expect(await untagged()).toEqual({ result: 'clear' });
    // What an agent's station mark writes by default: campaign scope, account_id NULL.
    await markDnc({ tenantId: tenant, campaignId: mine.id as string, phoneE164: PHONE, reason: 'asked' });
    const hit = await untagged();
    expect(hit).toMatchObject({ result: 'suppressed', entry: { scope: 'campaign', reason: 'asked' } });
    // The plain account scope (`campaignId: null`) still does NOT reach campaign rows: that
    // reading is the station's and the campaign dials' and is unchanged.
    expect(await registry.checkEntry(tenant, PHONE, { accountId: account, campaignId: null })).toEqual({ result: 'clear' });
    // The widest entry is named first, as for a tagged dial.
    await insert({ account_id: account });
    const acct = await untagged();
    expect(acct.result === 'suppressed' && acct.entry.scope).toBe('account');
    // The other account's untagged dial is still clear of this account's rows.
    expect(await registry.checkEntry(tenant, PHONE, { accountId: otherAccount, everyCampaignOfAccount: true }))
      .toMatchObject({ result: 'suppressed', entry: { scope: 'campaign' } }); // its own campaign's row
    await getTestPool().query('DELETE FROM dnc_entries WHERE campaign_id = $1', [theirs.id]);
    expect(await registry.checkEntry(tenant, PHONE, { accountId: otherAccount, everyCampaignOfAccount: true }))
      .toEqual({ result: 'clear' });
  });

  it('every-campaign-of-account is one indexed read (EXPLAIN)', async () => {
    const mine = await insertAgencyCampaign({ tenant_id: tenant, account_id: account });
    await insert({ campaign_id: mine.id as string });
    const pool = getTestPool();
    const client = await pool.connect();
    try {
      // Small tables plan as seq scans; what is asked is whether the statement CAN be
      // served by the indexes it is written for, so seq scans are priced out.
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query(
        `EXPLAIN SELECT d.* FROM dnc_entries d
          WHERE d.tenant_id = $1::uuid AND d.phone_e164 = $2
            AND (d.account_id IS NULL OR d.account_id = $3::uuid)
            AND (d.campaign_id IS NULL OR EXISTS (
                  SELECT 1 FROM agency_campaigns c
                   WHERE c.id = d.campaign_id AND c.tenant_id = $1::uuid AND c.account_id = $3::uuid))
          ORDER BY (d.campaign_id IS NOT NULL), (d.account_id IS NOT NULL), d.created_at, d.id
          LIMIT 1`,
        [tenant, PHONE, account],
      );
      const plan = rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
      // One statement; `dnc_entries` by a tenant index, the account's campaigns by
      // `idx_agency_campaigns_tenant` or the primary key (the planner's choice).
      expect(plan).toMatch(/Index Scan using idx_dnc_entries_tenant_\w+ on dnc_entries/);
      expect(plan).toMatch(/Index (Only )?Scan using (idx_agency_campaigns_tenant|agency_campaigns_pkey) on agency_campaigns/);
      expect(plan).not.toMatch(/Seq Scan/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('findInFlightForAccount: the number in flight on any campaign of the account, by the in-flight index', async () => {
    const one = await insertAgencyCampaign({ tenant_id: tenant, account_id: account });
    const two = await insertAgencyCampaign({ tenant_id: tenant, account_id: account });
    const elsewhere = await insertAgencyCampaign({ tenant_id: tenant, account_id: otherAccount });
    await insertAgencyContact(one.id as string, { tenant_id: tenant, account_id: account, phone_e164: PHONE, state: 'pending' });
    await insertAgencyContact(elsewhere.id as string, { tenant_id: tenant, account_id: otherAccount, phone_e164: PHONE, state: 'in_flight' });
    expect(await agencyContactRepository.findInFlightForAccount(tenant, account, PHONE)).toBeNull();
    const live = await insertAgencyContact(two.id as string, {
      tenant_id: tenant, account_id: account, phone_e164: '+1 415 555 0123', state: 'in_flight',
    });
    expect(await agencyContactRepository.findInFlightForAccount(tenant, account, PHONE))
      .toMatchObject({ id: live.id, campaign_id: two.id });

    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query(
        `EXPLAIN SELECT * FROM agency_contacts
          WHERE state = 'in_flight' AND tenant_id = $1 AND account_id = $2
            AND regexp_replace(phone_e164, '[^0-9]', '', 'g') = $3`,
        [tenant, account, PHONE.slice(1)],
      );
      const plan = rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/idx_agency_contacts_in_flight/);
      expect(plan).not.toMatch(/Seq Scan/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
