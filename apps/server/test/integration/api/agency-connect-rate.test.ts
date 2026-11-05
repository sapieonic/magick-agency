import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * ─── One connect rate across the product ─────────────────────────────────────
 *
 * HUMAN CONNECTS over PLACED FIRST DIALS (`sql-fragments.ts` HUMAN_CONNECT_ATTEMPT_SQL,
 * PLACED_FIRST_DIAL_SQL). One seed, read through the real app, three surfaces:
 *
 *  - `/stats` `connect_rate_pct` (the campaign dashboard);
 *  - the Insights tab's lifetime connect rate, computed from the served numbers exactly as the
 *    console's `callsConnectRate` / `agentConnectRate` compute it (`human_connects` over `dials`
 *    minus the redials placed; `apps/console/src/utils/agency/insights/rates.ts`);
 *  - the agent record: the roster's per-agent `connect_rate_pct` over the same window and
 *    campaign, and the agent's own scorecard (`/agents/:id/stats`): its totals and its
 *    per-campaign row (`by_campaign[]`, which the agent page and the mobile app render).
 *
 * The seed carries every case the definition has to get right: human, voicemail-coded,
 * auto-stamped (`no_disposition`) and unwritten connects; dials that never bridged; a wrap-up
 * redial chain whose code sits on the redial; and a queued attempt never placed (no dial, so in
 * no denominator).
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'connect-rate-secret-0123456789abcd';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { bulkInsert } from '../agency/insights-rollup-world.js';
import { insightsCache } from '../../../src/agency/insights/cache.js';
import { agencyInsightsRollupRepository } from '../../../src/db/repositories/agency.repository.js';

let loaded: LoadApp;
let floor: TenantFloor;
let campaignId: string;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);
const MIN = 60_000;
const START = new Date(Date.now() - 3 * 60 * MIN);
const at = (minutes: number) => new Date(START.getTime() + minutes * MIN);
const get = async (path: string) => {
  const res = await call(loaded.app, 'GET', path, floor.supervisors[0]!, floor);
  expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
  return res.json();
};

/** What each agent's dials were, in order; every entry is one placed first dial unless noted. */
type Dial = 'human' | 'voicemail' | 'auto' | 'unwritten' | 'no_answer' | 'chain' | 'queued';
const PLANS: Dial[][] = [
  // agent 0: 8 human, 4 voicemail, 3 auto-stamped, 2 unwritten, 9 rang out, 2 redial chains, 1 queued.
  [...Array(8).fill('human'), ...Array(4).fill('voicemail'), ...Array(3).fill('auto'), ...Array(2).fill('unwritten'),
    ...Array(9).fill('no_answer'), 'chain', 'chain', 'queued'],
  // agent 1: a different mix.
  [...Array(5).fill('human'), ...Array(7).fill('voicemail'), 'auto', ...Array(14).fill('no_answer'), 'chain', 'queued', 'queued'],
];

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  floor = (await seedFloor({ tenants: 1, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignsPerTenant: 1, staffAgents: true }))[0]!;
  campaignId = floor.campaigns[0]!;
  await q(`UPDATE agency_campaigns SET status = 'running', started_at = $2, created_at = $2 WHERE id = $1`, [campaignId, START]);

  const contacts: Array<Record<string, unknown>> = [];
  const attempts: Array<Record<string, unknown>> = [];
  let phone = 0;
  for (const [i, plan] of PLANS.entries()) {
    const { rows: [session] } = await q(
      `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, joined_at, left_at)
       VALUES ($1, $2, $3, $4, 'offline', $5, $6) RETURNING id`,
      [floor.tenant, floor.account, campaignId, floor.agents[i]!.id, at(0), at(170)]);
    for (const [n, kind] of plan.entries()) {
      const contactId = randomUUID();
      contacts.push({
        id: contactId, campaign_id: campaignId, tenant_id: floor.tenant, account_id: floor.account,
        phone_e164: `+9197${String(phone++).padStart(8, '0')}`, context: {}, state: 'completed',
      });
      const base = {
        campaign_id: campaignId, contact_id: contactId, tenant_id: floor.tenant, account_id: floor.account,
        caller_id: '+919000000001', reserved_agent_id: session.id, redial_number: 0, redial_of_attempt_id: null,
      };
      const dialed = at(5 + n * 4 + i);
      if (kind === 'queued') {
        attempts.push({ ...base, id: randomUUID(), attempt_number: 1, state: 'queued', outcome: null, disposition_code: null,
          dialed_at: null, answered_at: null, bridged_at: null, ended_at: null });
        continue;
      }
      const talked = (d: Date) => ({
        state: 'ended', outcome: 'connected', dialed_at: d, answered_at: new Date(d.getTime() + 4000),
        bridged_at: new Date(d.getTime() + 4200), ended_at: new Date(d.getTime() + 60_000),
      });
      if (kind === 'no_answer') {
        attempts.push({ ...base, id: randomUUID(), attempt_number: 1, state: 'ended', outcome: 'no_answer', disposition_code: null,
          dialed_at: dialed, answered_at: null, bridged_at: null, ended_at: new Date(dialed.getTime() + 20_000) });
        continue;
      }
      if (kind === 'chain') {
        // The original closes `redialed`; the redial carries the conversation's human outcome.
        const original = randomUUID();
        attempts.push({ ...base, id: original, attempt_number: 1, ...talked(dialed), disposition_code: 'redialed' });
        const redialAt = new Date(dialed.getTime() + 90_000);
        attempts.push({ ...base, id: randomUUID(), attempt_number: 2, ...talked(redialAt), disposition_code: 'interested',
          redial_number: 1, redial_of_attempt_id: original });
        continue;
      }
      const code = { human: 'interested', voicemail: 'voicemail', auto: 'no_disposition', unwritten: null }[kind];
      attempts.push({ ...base, id: randomUUID(), attempt_number: 1, ...talked(dialed), disposition_code: code });
    }
  }
  await bulkInsert(getTestPool(), 'agency_contacts', [
    ['id', 'uuid'], ['campaign_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['phone_e164', 'text'], ['context', 'jsonb'],
    ['state', 'text'],
  ], contacts);
  await bulkInsert(getTestPool(), 'agency_call_attempts', [
    ['id', 'uuid'], ['campaign_id', 'uuid'], ['contact_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'],
    ['attempt_number', 'int'], ['caller_id', 'text'], ['reserved_agent_id', 'uuid'], ['state', 'text'], ['outcome', 'text'],
    ['disposition_code', 'text'], ['dialed_at', 'timestamptz'], ['answered_at', 'timestamptz'], ['bridged_at', 'timestamptz'],
    ['ended_at', 'timestamptz'], ['redial_number', 'int'], ['redial_of_attempt_id', 'uuid'],
  ], attempts);
  for (let i = 0; i < 50; i++) if ((await agencyInsightsRollupRepository.recomputeBatch(200)).picked < 200) break;
  insightsCache.clear();
}, 180_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

/** The seed's own arithmetic: human connects (a chain once, on its redial) over placed first dials. */
function expectedRate(plan: Dial[]): number {
  const human = plan.filter((d) => d === 'human' || d === 'chain').length;
  const firstDials = plan.filter((d) => d !== 'queued').length;
  return (human / firstDials) * 100;
}

/** The console's `callsConnectRate` / `agentConnectRate`, from the served counts. */
const consoleRate = (row: { human_connects: number; dials: number }, redials: number) => (row.human_connects / (row.dials - redials)) * 100;

describe('one connect rate: /stats, Insights and the agent record agree', () => {
  it('the campaign: /stats connect_rate_pct = the Insights lifetime connect rate = the seed\'s human connects over placed first dials', async () => {
    const stats = await get(`/proxy/agency/campaigns/${campaignId}/stats`);
    const activity = await get(`/proxy/agency/campaigns/${campaignId}/insights/activity`);
    const all = [...PLANS[0]!, ...PLANS[1]!];
    // Not vacuous: the seed separates the definitions this replaces.
    expect(activity.calls.connected).toBeGreaterThan(activity.calls.human_connects);   // voicemail, auto and unwritten connects
    expect(activity.calls.redials.placed).toBe(3);                                        // three chains
    expect(stats.attempts_total).toBeGreaterThan(activity.calls.dials);                   // the queued rows
    const insights = consoleRate(activity.calls, activity.calls.redials.placed);
    expect(insights).toBeCloseTo(expectedRate(all), 9);
    expect(stats.connect_rate_pct).toBeCloseTo(insights, 9);
    expect(stats.human_connects).toBe(activity.calls.human_connects);
    // The rate's own denominator is served, so the card prints the rate as its fraction.
    expect(stats.first_dials_placed).toBe(activity.calls.dials - activity.calls.redials.placed);
    expect(stats.connect_rate_pct).toBeCloseTo((stats.human_connects / stats.first_dials_placed) * 100, 9);
  });

  it('per agent: the roster\'s and the scorecard\'s connect_rate_pct = the Insights agent row\'s', async () => {
    const activity = await get(`/proxy/agency/campaigns/${campaignId}/insights/activity`);
    const { from, to } = activity.range as { from: string; to: string };
    const window = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&campaign_id=${campaignId}`;
    const roster = await get(`/proxy/agency/agents/stats?${window}`);
    for (const [i, plan] of PLANS.entries()) {
      const id = floor.agents[i]!.id;
      const row = (activity.agents as Array<{ agent_user_id: string; human_connects: number; dials: number; redials: number }>)
        .find((r) => r.agent_user_id === id)!;
      const insights = consoleRate(row, row.redials);
      expect(insights, `agent ${i}`).toBeCloseTo(expectedRate(plan), 9);
      const rosterRow = (roster.rows as Array<{ agent_user_id: string; connect_rate_pct: number | null }>).find((r) => r.agent_user_id === id)!;
      expect(rosterRow.connect_rate_pct, `agent ${i} roster`).toBeCloseTo(insights, 9);
      const scorecard = await get(`/proxy/agency/agents/${id}/stats?${window}&bucket=day`);
      expect(scorecard.totals.connect_rate_pct, `agent ${i} scorecard`).toBeCloseTo(insights, 9);
      // The scorecard's per-campaign row: the same rate from its own two counts, not
      // `connected / attempts` (the definition this replaces, which a client used to derive).
      const campaignRow = (scorecard.by_campaign as Array<{ campaign_id: string; human_connects: number; first_dials: number;
        connect_rate_pct: number | null; connected: number; attempts: number }>).find((r) => r.campaign_id === campaignId)!;
      expect(campaignRow.human_connects, `agent ${i} by_campaign`).toBe(row.human_connects);
      expect(campaignRow.first_dials, `agent ${i} by_campaign`).toBe(row.dials - row.redials);
      expect(campaignRow.connect_rate_pct, `agent ${i} by_campaign`).toBeCloseTo(insights, 9);
      expect(campaignRow.connect_rate_pct, `agent ${i} by_campaign`).not.toBeCloseTo((campaignRow.connected / campaignRow.attempts) * 100, 3);
    }
  });
});
