import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT } from '../setup/factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { LIVE_CALLS_SQL, CAMPAIGN_AHT_SQL } = await import('../../../src/db/repositories/agency/live-call.repository.js');

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
 * The other two spines (QA-L6), seeded the same way (many ended rows, a few live): a soft-phone
 * call on `idx_agency_manual_calls_live` by the account, an inbound call on
 * `idx_agency_inbound_calls_account_live` by the tenant and account. And the campaign AHT read
 * (`campaignAhtSeconds`, cached a minute per campaign): it reads one campaign's attempts by
 * `campaign_id` on an index, never the table; its cost is that campaign's whole history, which is
 * why it is cached (docs/listening.md §4).
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
    // Soft-phone calls: many ended (settled), a few bridged, each live one on its own session.
    const sessions = await pool.query<{ id: string; account_id: string; agent_user_id: string }>(
      `INSERT INTO agency_agent_sessions (tenant_id, account_id, kind, agent_user_id, state, break_reason)
       SELECT $1::uuid, CASE WHEN g <= 5 THEN $2::uuid WHEN g = 6 THEN $2::uuid ELSE $3::uuid END, 'softphone', gen_random_uuid(), 'break', 'soft_phone'
         FROM generate_series(1, 7) g
       RETURNING id, account_id, agent_user_id`, [T, A, OTHER_ACCOUNT]);
    const [live, ended] = [sessions.rows.slice(0, 5), sessions.rows.slice(5)];
    await pool.query(
      `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, destination_e164, caller_id, state, ended_at, settled_at)
       SELECT $1::uuid, s.account_id, s.id, s.agent_user_id, '+1555' || lpad(g::text, 7, '0'), '+15550000000', 'ended', now(), now()
         FROM generate_series(1, ${CAMPAIGNS * CONTACTS_PER_CAMPAIGN}) g
         JOIN agency_agent_sessions s ON s.id = (ARRAY[$2::uuid, $3::uuid])[1 + g % 2]`, [T, ended[0]!.id, ended[1]!.id]);
    for (const [i, sess] of live.entries()) {
      await pool.query(
        `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, destination_e164, caller_id, state, bridged_at, webrtc_call_id)
         VALUES ($1, $2, $3, $4, $5, '+15550000000', 'bridged', now(), gen_random_uuid())`,
        [T, sess.account_id, sess.id, sess.agent_user_id, `+155590000${i}`]);
    }
    // Inbound calls: many ended, a few connected.
    await pool.query(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, to_e164, state, ended_at, outcome)
       SELECT CASE WHEN g % 4 = 0 THEN $1::uuid ELSE gen_random_uuid() END,
              CASE WHEN g % 20 = 0 THEN $2::uuid ELSE gen_random_uuid() END, 'plan-' || g, '+15550000001', 'ended', now(), 'failed'
         FROM generate_series(1, ${CAMPAIGNS * CONTACTS_PER_CAMPAIGN}) g`, [T, A]);
    await pool.query(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, to_e164, state, bridged_at, answered_by_user_id, session_id,
                                         offered_at, offer_count, webrtc_call_id)
       SELECT $1::uuid, $2::uuid, 'plan-live-' || g, '+15550000001', 'connected', now(), gen_random_uuid(), gen_random_uuid(),
              now(), 1, gen_random_uuid()
         FROM generate_series(1, 5) g`, [T, A]);
    // Other tenants' callers waiting in their queues: open, but not this account's.
    await pool.query(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, to_e164, state)
       SELECT gen_random_uuid(), gen_random_uuid(), 'plan-queued-' || g, '+15550000001', 'queued'
         FROM generate_series(1, 2000) g`);
    await pool.query('ANALYZE agency_campaigns, agency_contacts, agency_calls, agency_call_attempts, agency_manual_calls, agency_inbound_calls');
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

  it('QA-L6: the soft-phone spine on idx_agency_manual_calls_live and the inbound spine on idx_agency_inbound_calls_account_live, by the account', async () => {
    const { rows } = await getTestPool().query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${LIVE_CALLS_SQL}`, [T, A, null, null]);
    const scans = indexScans(rows[0]!['QUERY PLAN']);
    const manual = scans.find((x) => x.index === 'idx_agency_manual_calls_live');
    expect(manual, JSON.stringify(scans)).toBeDefined();
    expect(manual!.cond).toMatch(/account_id = /);
    const inbound = scans.find((x) => x.index === 'idx_agency_inbound_calls_account_live');
    expect(inbound, JSON.stringify(scans)).toBeDefined();
    expect(inbound!.cond).toMatch(/tenant_id = .*account_id = /);
  });

  it('QA-L6, SWE-L7: the campaign AHT read takes one campaign\'s attempts by campaign_id on an index, never the whole table', async () => {
    const pool = getTestPool();
    const { rows: [one] } = await pool.query<{ campaign_id: string }>(
      `SELECT campaign_id FROM agency_call_attempts WHERE account_id = $1 LIMIT 1`, [A]);
    const { rows } = await pool.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${CAMPAIGN_AHT_SQL}`, [T, [one!.campaign_id], 'voicemail']);
    const plan = JSON.stringify(rows[0]!['QUERY PLAN']);
    expect(plan).not.toMatch(/"Node Type":"Seq Scan","Parallel Aware":(true|false),"Async Capable":(true|false),"Relation Name":"agency_call_attempts"/);
    const scans = indexScans(rows[0]!['QUERY PLAN']);
    expect(scans.some((x) => /campaign_id = /.test(x.cond)), plan).toBe(true);
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
