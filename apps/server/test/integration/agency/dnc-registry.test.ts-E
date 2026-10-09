import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import {
  TEST_DB_URL, getTestPool, closeTestPool, truncateAll,
} from '../../../../../packages/db/test/helpers/test-db.js';
import { DncRegistry } from '../../../src/agency/dnc-registry.js';
import { markDnc } from '../../../src/agency/dnc-mark.js';
import { dncRepository } from '../../../src/dnc/dnc.repository.js';

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
    expect(r.written).toEqual({ campaign_id: null });
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
});
