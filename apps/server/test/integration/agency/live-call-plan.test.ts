import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT } from '../setup/factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { LIVE_CALLS_SQL } = await import('../../../src/db/repositories/agency/live-call.repository.js');

/**
 * The live list's dialler spine reads the account's live attempts on
 * `idx_agency_attempts_account_live` (`(tenant_id, account_id) WHERE state <> 'ended'`, 0005), not
 * through the account's campaigns (`idx_agency_attempts_live` is per campaign: reaching the live
 * attempts that way reads every campaign the account has ever had, on every 5 s poll of every
 * supervisor). docs/listening.md §4 "The live list".
 *
 * The plan is proven on a seeded table, with `enable_seqscan` left on: {@link CAMPAIGNS} campaigns
 * over two accounts, {@link CONTACTS_PER_CAMPAIGN} contacts and one ENDED attempt each with its
 * call leg, a handful bridged, then ANALYZE (an empty `agency_calls` would have the planner drive
 * the whole list from the legs instead). On a few rows the planner would scan whatever it likes. The assertion is on
 * the index's NAME: the per-campaign index is a plausible wrong answer that a weaker assertion
 * ("an index scan") would pass.
 *
 * The assertion is on the scan's index CONDITION too: the partial index can also be scanned whole
 * (every tenant's live attempts, no condition), which a name-only assertion would pass.
 *
 * Mutation-checked: the spine's old shape (`FROM agency_campaigns cam JOIN agency_call_attempts a
 * ON a.campaign_id = cam.id WHERE cam.tenant_id = $1 AND cam.account_id = $2`) scans the index
 * whole, without the account, and fails; so does putting back `a.reserved_agent_id IS NOT NULL`,
 * which offers the planner `idx_agency_attempts_agent`.
 */

const CAMPAIGNS = 2_000;
const CONTACTS_PER_CAMPAIGN = 10;
const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const TARGET_INDEX = 'idx_agency_attempts_account_live';

/** Every index scan in a JSON plan: its index and its index condition (empty when it has none). */
function indexScans(plan: unknown, out: Array<{ index: string; cond: string }> = []): Array<{ index: string; cond: string }> {
  if (Array.isArray(plan)) for (const p of plan) indexScans(p, out);
  else if (plan && typeof plan === 'object') {
    const node = plan as Record<string, unknown>;
    if (typeof node['Index Name'] === 'string') out.push({ index: node['Index Name'], cond: String(node['Index Cond'] ?? '') });
    for (const v of Object.values(node)) if (v && typeof v === 'object') indexScans(v, out);
  }
  return out;
}

describe('the live list\'s plan', () => {
  beforeAll(async () => {
    await truncateAll();
    const pool = getTestPool();
    await pool.query(
      `INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids)
       SELECT gen_random_uuid(), $1::uuid, CASE WHEN g % 2 = 0 THEN $2::uuid ELSE $3::uuid END, 'c' || g, ARRAY['+15550000000']
         FROM generate_series(1, ${CAMPAIGNS}) g`, [T, A, OTHER_ACCOUNT]);
    await pool.query(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164)
       SELECT c.id, c.tenant_id, c.account_id, '+1555' || lpad(g::text, 7, '0')
         FROM agency_campaigns c CROSS JOIN generate_series(1, ${CONTACTS_PER_CAMPAIGN}) g`);
    // Each attempt's call leg (the leg's id reuses the contact's: one attempt per contact).
    await pool.query(
      `INSERT INTO agency_calls (id, tenant_id, account_id, caller_id, destination_phone)
       SELECT id, tenant_id, account_id, '+15550000000', phone_e164 FROM agency_contacts`);
    await pool.query(
      `INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, webrtc_call_id)
       SELECT campaign_id, id, tenant_id, account_id, 1, '+15550000000', 'ended', id FROM agency_contacts`);
    await pool.query(
      `UPDATE agency_call_attempts SET state = 'bridged', bridged_at = now()
        WHERE id IN (SELECT id FROM agency_call_attempts WHERE account_id = $1 ORDER BY id LIMIT 5)`, [A]);
    await pool.query('ANALYZE agency_campaigns, agency_contacts, agency_calls, agency_call_attempts');
  }, 120_000);
  afterAll(closeTestPool);

  it(`reads the account's live attempts on ${TARGET_INDEX}, by the account`, async () => {
    const { rows } = await getTestPool().query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${LIVE_CALLS_SQL}`, [T, A, null, null]);
    const scans = indexScans(rows[0]!['QUERY PLAN']);
    // Keyed by the account: a scan of the whole partial index (every tenant's live attempts) is not it.
    const onAccount = scans.find((x) => x.index === TARGET_INDEX);
    expect(onAccount, JSON.stringify(scans)).toBeDefined();
    expect(onAccount!.cond).toMatch(/tenant_id = .*account_id = /);
    expect(scans.map((x) => x.index)).not.toContain('idx_agency_attempts_agent');
  });

  it('one campaign\'s list reads that campaign\'s live attempts on a live index (its own, or the account\'s)', async () => {
    const pool = getTestPool();
    const { rows: [one] } = await pool.query<{ campaign_id: string }>(
      `SELECT campaign_id FROM agency_call_attempts WHERE account_id = $1 AND state = 'bridged' LIMIT 1`, [A]);
    const { rows } = await pool.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${LIVE_CALLS_SQL}`, [T, A, one!.campaign_id, null]);
    const scans = indexScans(rows[0]!['QUERY PLAN']);
    expect(scans.some((x) => (x.index === TARGET_INDEX && /account_id = /.test(x.cond))
      || (x.index === 'idx_agency_attempts_live' && /campaign_id = /.test(x.cond))), JSON.stringify(scans)).toBe(true);
  });
});
