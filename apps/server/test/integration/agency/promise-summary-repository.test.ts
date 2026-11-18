import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT } from '../setup/factories.js';
import {
  insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertManualCall, insertSoftphoneSession,
} from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyPromiseSummaryRepository, PROMISE_SUMMARY_SQL } = await import('../../../src/db/repositories/agency/promise-summary.repository.js');

/**
 * The promises summary on a real Postgres (decision B28b; `promise-summary.repository.ts`): every
 * promise recorded in `[from, to)` by when its outcome was written, on all three call tables (a
 * dialler attempt, a soft-phone call tagged or not, an inbound call matched or not), per campaign
 * with the calls of no campaign in one null row; the amounts summed exactly (no float: 0.10 + 0.20
 * is 0.30, twelve-digit amounts add to the cent), a promise with no amount counted but not summed,
 * the window's edges, another account and another tenant never counted, a call with an outcome
 * and no promise never counted. The account's active campaigns whose catalog asks for a promise.
 * Then the plan: each table read on its 0050 index by tenant, account and the window.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const FROM = new Date('2026-11-17T18:30:00.000Z');
const TO = new Date('2026-11-18T18:30:00.000Z');
const inWindow = new Date('2026-11-18T06:00:00.000Z');
const NULL_ONLY_AT = new Date('2026-11-18T09:00:00.000Z');
const PROMISE_ENTRY = { code: 'ptp', label: 'Will pay', requires_promise: true };

type Id = { id: string };
let c1: Id;
let c2: Id;

async function promised(campaign: Id, at: Date, amount: string | null, over: Record<string, unknown> = {}) {
  const contact = await insertAgencyContact(campaign.id, { account_id: over['account_id'] ?? A, tenant_id: over['tenant_id'] ?? T }) as Id;
  return insertAgencyAttempt(campaign.id, contact.id, {
    state: 'ended', dialed_at: at, ended_at: at, disposition_code: 'ptp', dispositioned_at: at,
    promise_date: '2026-11-25', promise_amount: amount, ...over,
  });
}

async function inbound(campaignId: string | null, at: Date, amount: string | null, over: Record<string, unknown> = {}) {
  await getTestPool().query(
    `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, to_e164, state, ended_at, outcome, bridged_at, answered_by_user_id,
                                       settled_at, matched_campaign_id, disposition_code, disposition_source, dispositioned_at, promise_date, promise_amount)
     VALUES ($1, $2, $3, '+919000000002', 'ended', $4, 'answered', $4, $7, $4, $5, 'ptp', $8, $4, '2026-11-25', $6)`,
    [over['tenant_id'] ?? T, over['account_id'] ?? A, `ptp-${randomUUID()}`, at, campaignId, amount, randomUUID(),
      campaignId ? 'campaign' : 'route']);
}

beforeAll(async () => {
  await truncateAll();
  c1 = await insertAgencyCampaign({ status: 'running', disposition_catalog: JSON.stringify([PROMISE_ENTRY]) }) as Id;
  c2 = await insertAgencyCampaign({ status: 'paused', disposition_catalog: JSON.stringify([{ code: 'x', label: 'X' }, PROMISE_ENTRY]) }) as Id;
  const completed = await insertAgencyCampaign({ status: 'completed', disposition_catalog: JSON.stringify([PROMISE_ENTRY]) }) as Id;
  await insertAgencyCampaign({ status: 'running', disposition_catalog: JSON.stringify([{ code: 'sale', label: 'Sale', requires_promise: false }]) });
  await insertAgencyCampaign({ status: 'stopping', disposition_catalog: '[]' });
  const elsewhere = await insertAgencyCampaign({ status: 'running', account_id: OTHER_ACCOUNT, disposition_catalog: JSON.stringify([PROMISE_ENTRY]) }) as Id;
  const otherTenant = await insertAgencyCampaign({ status: 'running', tenant_id: OTHER_TENANT, account_id: randomUUID(), disposition_catalog: JSON.stringify([PROMISE_ENTRY]) }) as Id & { account_id: string };

  // c1: dialler promises, amounts that a float would not add exactly, one with no amount, the edges.
  await promised(c1, inWindow, '0.10');
  await promised(c1, inWindow, '0.20');
  await promised(c1, FROM, '123456789012.34'); // at `from`: counts
  await promised(c1, inWindow, '987654321098.77');
  await promised(c1, inWindow, null);
  await promised(c1, new Date(FROM.getTime() - 1), '5.00'); // before: no
  await promised(c1, TO, '5.00'); // at `to`: no (exclusive)
  // An outcome without a promise: no.
  const plain = await insertAgencyContact(c1.id) as Id;
  await insertAgencyAttempt(c1.id, plain.id, { state: 'ended', disposition_code: 'sale', dispositioned_at: inWindow });

  // Soft phone: a call tagged to c1, an untagged one.
  const session = await insertSoftphoneSession() as { id: string; tenant_id: string; account_id: string; agent_user_id: string };
  await insertManualCall(session, { campaign_id: c1.id, state: 'ended', ended_at: inWindow, disposition_code: 'ptp', dispositioned_at: inWindow, promise_date: '2026-11-25', promise_amount: '0.01', settled_at: inWindow });
  await insertManualCall(session, { campaign_id: null, state: 'ended', ended_at: inWindow, disposition_code: 'ptp', dispositioned_at: inWindow, promise_date: '2026-11-25', promise_amount: '10.00', settled_at: inWindow });

  // Inbound: matched to c2, and unmatched.
  await inbound(c2.id, inWindow, '250.50');
  await inbound(c2.id, inWindow, null);
  await inbound(null, inWindow, null);
  // A promise with no amount, alone at its instant.
  await promised(c2, NULL_ONLY_AT, null);

  // Never counted: a completed campaign's promise still counts (it is a promise recorded today) …
  await promised(completed, inWindow, '1.00');
  // … but another account's and another tenant's do not.
  await promised(elsewhere, inWindow, '7.00', { account_id: OTHER_ACCOUNT });
  await promised(otherTenant, inWindow, '7.00', { tenant_id: OTHER_TENANT, account_id: otherTenant.account_id });
  await inbound(null, inWindow, '7.00', { account_id: OTHER_ACCOUNT });
}, 60_000);

afterAll(closeTestPool);

describe('summary', () => {
  it('counts each promise recorded in [from, to) on every call table, per campaign, the amounts summed exactly', async () => {
    const rows = await agencyPromiseSummaryRepository.summary(T, A, FROM, TO);
    const completedRow = rows.find((r) => r.campaign_id !== c1.id && r.campaign_id !== c2.id && r.campaign_id !== null);
    expect(rows).toEqual(expect.arrayContaining([
      // 5 dialler promises (one without an amount) and the tagged soft-phone call.
      { campaign_id: c1.id, promises: 6, with_amount: 5, amount_total: '1111111110111.42' },
      { campaign_id: c2.id, promises: 3, with_amount: 1, amount_total: '250.50' },
      { campaign_id: null, promises: 2, with_amount: 1, amount_total: '10.00' },
    ]));
    expect(completedRow).toMatchObject({ promises: 1, amount_total: '1.00' });
    expect(rows).toHaveLength(4);
    // The null row last.
    expect(rows.at(-1)!.campaign_id).toBeNull();
  });

  it('serves "0.00" for a campaign whose promises carry no amount', async () => {
    const rows = await agencyPromiseSummaryRepository.summary(T, A, NULL_ONLY_AT, new Date(NULL_ONLY_AT.getTime() + 1));
    expect(rows).toEqual([{ campaign_id: c2.id, promises: 1, with_amount: 0, amount_total: '0.00' }]);
    const none = await agencyPromiseSummaryRepository.summary(T, A, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-02T00:00:00Z'));
    expect(none).toEqual([]);
  });

  it('sums past a float\'s precision exactly: 150 twelve-digit amounts and a cent', async () => {
    const account = randomUUID();
    const big = await insertAgencyCampaign({ status: 'running', account_id: account }) as Id;
    await getTestPool().query(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164)
       SELECT $1::uuid, $2::uuid, $3::uuid, '+1444' || lpad(g::text, 7, '0') FROM generate_series(1, 151) g`, [big.id, T, account]);
    await getTestPool().query(
      `INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, ended_at,
                                         disposition_code, dispositioned_at, promise_date, promise_amount)
       SELECT campaign_id, id, tenant_id, account_id, 1, '+15550000000', 'ended', $2::timestamptz, 'ptp', $2::timestamptz, '2026-11-25',
              CASE WHEN phone_e164 = '+14440000151' THEN 0.01 ELSE 999999999999.99 END
         FROM agency_contacts WHERE campaign_id = $1::uuid`, [big.id, inWindow]);
    // A float8 sum reads 149999999999998.25 here.
    expect(await agencyPromiseSummaryRepository.summary(T, account, FROM, TO)).toEqual([
      { campaign_id: big.id, promises: 151, with_amount: 151, amount_total: '149999999999998.51' },
    ]);
  });

  it('another account sees only its own', async () => {
    const rows = await agencyPromiseSummaryRepository.summary(T, OTHER_ACCOUNT, FROM, TO);
    expect(rows).toEqual([
      expect.objectContaining({ promises: 1, amount_total: '7.00' }),
      { campaign_id: null, promises: 1, with_amount: 1, amount_total: '7.00' },
    ]);
  });
});

describe('promiseCampaignIds', () => {
  it('the account\'s active campaigns whose catalog has a requires_promise entry', async () => {
    const ids = await agencyPromiseSummaryRepository.promiseCampaignIds(T, A, ['running', 'stopping', 'paused']);
    expect(ids).toEqual([c1.id, c2.id].sort());
  });
});

describe('the plan, on seeded tables', () => {
  beforeAll(async () => {
    const pool = getTestPool();
    // Many calls with outcomes and no promise, on all three tables, across accounts.
    await pool.query(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164)
       SELECT $1::uuid, $2::uuid, $3::uuid, '+1555' || lpad(g::text, 7, '0') FROM generate_series(1, 20000) g`, [c1.id, T, A]);
    await pool.query(
      `INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, disposition_code, dispositioned_at)
       SELECT campaign_id, id, tenant_id, account_id, 1, '+15550000000', 'ended', 'sale', $1::timestamptz FROM agency_contacts WHERE phone_e164 LIKE '+1555%'`, [inWindow]);
    const session = await insertSoftphoneSession() as { id: string; agent_user_id: string };
    await pool.query(
      `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, destination_e164, caller_id, state, ended_at, disposition_code, dispositioned_at, settled_at)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, '+1555' || lpad(g::text, 7, '0'), '+15550000000', 'ended', $5::timestamptz, 'sale', $5::timestamptz, $5::timestamptz
         FROM generate_series(1, 20000) g`, [T, A, session.id, session.agent_user_id, inWindow]);
    await pool.query(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, to_e164, state, ended_at, outcome, bridged_at, answered_by_user_id,
                                         settled_at, disposition_code, disposition_source, dispositioned_at)
       SELECT $1::uuid, $2::uuid, 'plan-' || g, '+15550000001', 'ended', $3::timestamptz, 'answered', $3::timestamptz, gen_random_uuid(),
              $3::timestamptz, 'sale', 'route', $3::timestamptz FROM generate_series(1, 20000) g`,
      [T, A, inWindow]);
    await pool.query('ANALYZE agency_call_attempts, agency_manual_calls, agency_inbound_calls');
  }, 120_000);

  function indexScans(plan: unknown, out: Array<{ index: string; cond: string }> = []): Array<{ index: string; cond: string }> {
    if (Array.isArray(plan)) for (const p of plan) indexScans(p, out);
    else if (plan && typeof plan === 'object') {
      const node = plan as Record<string, unknown>;
      if (typeof node['Index Name'] === 'string') out.push({ index: node['Index Name'], cond: String(node['Index Cond'] ?? '') });
      for (const v of Object.values(node)) if (v && typeof v === 'object') indexScans(v, out);
    }
    return out;
  }

  it('reads each table on its promise index by tenant, account and the window', async () => {
    const { rows } = await getTestPool().query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${PROMISE_SUMMARY_SQL}`, [T, A, FROM, TO]);
    const scans = indexScans(rows[0]!['QUERY PLAN']);
    for (const index of ['idx_agency_attempts_promise_written', 'idx_agency_manual_calls_promise_written', 'idx_agency_inbound_calls_promise_written']) {
      const scan = scans.find((s) => s.index === index);
      expect(scan, index).toBeDefined();
      expect(scan!.cond).toMatch(/tenant_id = .*account_id = .*dispositioned_at >= .*dispositioned_at </);
    }
    // And the answer is unchanged by 60,000 calls without a promise.
    expect((await agencyPromiseSummaryRepository.summary(T, A, FROM, TO)).find((r) => r.campaign_id === c1.id))
      .toMatchObject({ promises: 6, amount_total: '1111111110111.42' });
  });
});
