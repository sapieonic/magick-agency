import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Calls by type (`docs/call-log.md` §6, call log P4), on real Postgres through the real app: the
 * campaign's inbound figures (`calls.inbound` on Insights, `inbound` on `/stats`, the report
 * dataset), the soft phone's talk time, and the outcomes by type.
 *
 * ── What this file holds ────────────────────────────────────────────────────
 *  - **Parity with the Call log.** One seed with every call type, and every figure of the Calls
 *    by type table read beside the Call log's own count for the same campaign and window
 *    (`GET …/call-log?include_counts=1`): the chips' numbers ARE the table's. Change what an
 *    inbound row is on one side only and this goes red.
 *  - **One row, one call, one type.** A missed call and its call back are two calls; a call back
 *    that never dialled is none; marking a Missed row handled is not a call; a dial the
 *    customer's own call stopped is a dialler dial that reached nobody, and the conversation is
 *    counted once, under Inbound.
 *  - **Filed, not matched.** A call is counted under the campaign it is filed under
 *    (`campaign_id`), whatever catalog its outcome came from (`disposition_source`).
 *  - **No rate blends.** The dialler's counts are what they are with no soft-phone or inbound
 *    call at all.
 *  - **The report.** The campaign report's dataset carries the same counts, and the renderer
 *    draws the table from them.
 *
 * ── Where a figure and the Call log's chip differ, on purpose ────────────────
 * The seed has a row on each side of every one, so neither can move without a test going red:
 *  - the window: a figure's is half-open `[from, to)`; the log's `from` / `to` are inclusive. A
 *    call at exactly `to` (Z, s5) is in the log's count and in no figure;
 *  - Dials: placed dials, by when they were dialled. The Dialler chip under plain dates also
 *    lists an attempt that was never dialled (d7). Under the figure's own link they are equal;
 *  - Connected: the dialler's leaves wrap-up redials out (d6); the log's `outcome=connected`
 *    lists every connected row, and equals the figure with `redial=0`.
 *
 * The seed (every instant relative to BASE, three hours ago on a 15-minute boundary):
 *
 * | Row | Type | What | In the window's figures |
 * |---|---|---|---|
 * | d1 | dialler | connected, `interested`, 40 s of talk | a dial, connected, a person reached |
 * | d2 | dialler | stopped: the customer rang us (`canceled`, `inbound_call`) | a dial; nothing else |
 * | d3 | dialler | no answer | a dial |
 * | d5 | dialler | connected, then redialled from wrap-up (`redialed`), 10 s | a dial, connected; its conversation is d6's |
 * | d6 | dialler | d5's wrap-up redial, connected, `call_later`, 25 s | a dial (a redial), NOT in Connected; the conversation, a person reached |
 * | d7 | dialler | cancelled before it was ever dialled | nothing: not a dial. A row of the Call log all the same |
 * | A | inbound | d2's customer, answered, `will_pay`, 252 s | received, answered |
 * | B | inbound | nobody free, voicemail; open | received, missed, to follow up |
 * | C | inbound | out of hours; open | received, missed, to follow up; NOT open hours |
 * | D | inbound | hung up waiting; marked handled | received, missed |
 * | E | inbound | unknown caller filed by the route, answered, `interested`, 100 s | received, answered |
 * | s1 | soft phone | B's call back, connected, `call_later`, 30 s | placed, connected, reached |
 * | s2 | soft phone | connected, `interested`, 45 s | placed, connected, reached |
 * | s3 | soft phone | B's call back that never dialled | nothing: not a call |
 * | s4 | soft phone | dialled, no answer | placed |
 * | Z | inbound | arrived at the window's very end (`to`), answered, `will_pay`, 30 s | nothing: the window is half-open. `/stats` only |
 * | s5 | soft phone | created at the window's very end, connected, `call_later`, 20 s | nothing, the same. `/stats` only |
 * | J | inbound | open Missed row from two days ago | to follow up only |
 * | K | inbound | answered yesterday, 60 s | `/stats` (lifetime) only |
 * | live, rejected, unfiled, sibling, other tenant | inbound | | never |
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'calls-by-type-secret-0123456789abc';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import type { CampaignReportDataset } from '@magick-agency/contracts/reports';
import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { insertInboundCall, type InboundCallSeed } from '../../helpers/call-log-seed.js';
import { insightsCache } from '../../../src/agency/insights/cache.js';
import { REPORT_DATASET_BUILDERS, type BuiltReport } from '../../../src/agency/reports/datasets/index.js';
import { localDateOf, localDayBounds } from '../../../src/agency/reports/schedule.js';
import { agencyInsightsRollupRepository } from '../../../src/db/repositories/agency.repository.js';
import { inboundCampaignCountsStatement } from '../../../src/db/repositories/agency/inbound-campaign-sql.js';
import type { ReportRunRecord } from '../../../src/db/repositories/agency/report-run.repository.js';

/** What this test uses of `@magick-agency/report-renderer`, loaded as the server loads it (its `tsc` never follows into it). */
const RENDERER_PACKAGE: string = '@magick-agency/report-renderer';
const renderer = () => import(RENDERER_PACKAGE) as Promise<{
  renderReportHtml(dataset: CampaignReportDataset, options: { fonts: { css: string; embedded: boolean } }): string;
}>;

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
let campaignId: string;
let siblingCampaignId: string;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);
const MIN = 60_000;
const QUARTER = 15 * MIN;
/** Three hours ago on a 15-minute boundary: the Insights range is served on those. */
const BASE = new Date(Math.floor((Date.now() - 3 * 60 * MIN) / QUARTER) * QUARTER);
const at = (minutes: number, seconds = 0) => new Date(BASE.getTime() + minutes * MIN + seconds * 1000);
/** The window: `[BASE, BASE + 2 h)`. Every "in the window" row of the seed is well inside it. */
const WINDOW = { from: at(0), to: at(120) };
const windowQuery = `from=${encodeURIComponent(WINDOW.from.toISOString())}&to=${encodeURIComponent(WINDOW.to.toISOString())}`;
/**
 * The same window as the Call log spells it. Its `to` is INCLUSIVE and a figure's is not, so the
 * log's window that holds exactly the figure's calls ends one millisecond earlier (the seed's
 * instants are whole milliseconds).
 */
const logWindow = `from=${encodeURIComponent(WINDOW.from.toISOString())}&to=${encodeURIComponent(new Date(WINDOW.to.getTime() - 1).toISOString())}`;
/** The log's window with its `to` on the figure's `to`: one instant wider. */
const logWindowToInclusive = windowQuery;
const RUNG = '+919000000009';
const CALLER_B = '+919812307730';
const id = new Map<string, string>();

const get = async (path: string, f: TenantFloor = floor) => {
  const res = await call(loaded.app, 'GET', path, f.supervisors[0]!, f);
  expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
  return res.json();
};

interface Inbound { received: number; answered: number; missed: number; open_follow_ups: number; talk_seconds: number; open_hours: number }
interface Soft { placed: number; connected: number; human_connects: number; talk_seconds: number }
interface Calls {
  dials: number; connected: number; human_connects: number; conversations: number; talk_seconds: number;
  redials: { placed: number }; by_outcome: Record<string, number>; softphone: Soft; inbound: Inbound;
}
interface OutcomeByType { code: string | null; label: string | null; is_success: boolean; dialler: number; soft_phone: number; inbound: number; total: number }
interface Activity { calls: Calls; outcomes: Array<{ code: string | null; count: number }>; outcomes_by_type: OutcomeByType[]; range: { from: string; to: string } }
interface LogCounts { all: number; dialler: number; soft_phone: number; inbound: number; to_follow_up: number }

/** Insights over the window, read fresh (the route caches an answer for a few seconds). */
const activityOf = async (campaign = campaignId, f: TenantFloor = floor): Promise<Activity> => {
  insightsCache.clear();
  return await get(`/proxy/agency/campaigns/${campaign}/insights/activity?${windowQuery}`, f) as Activity;
};
/** The Call log's chip counts under `params`. */
const logCounts = async (params: string, campaign = campaignId): Promise<LogCounts> =>
  (await get(`/proxy/agency/campaigns/${campaign}/call-log?${params}&include_counts=1&limit=1`) as { counts: LogCounts }).counts;

/**
 * An `agency_inbound_calls` row, straight into the table (`insertInboundCall`): on this floor,
 * filed under the campaign and from a number of its own unless the test says otherwise.
 */
async function inbound(label: string, o: Omit<InboundCallSeed, 'tenantId' | 'accountId' | 'campaign' | 'from' | 'to'> & {
  tenant?: TenantFloor;
  campaign?: string | null;
  from?: string | null;
}): Promise<string> {
  const { tenant, campaign, from, ...seed } = o;
  const f = tenant ?? floor;
  const rowId = await insertInboundCall(label, {
    ...seed,
    tenantId: f.tenant,
    accountId: f.account,
    campaign: campaign === undefined ? campaignId : campaign,
    from: from === undefined ? `+9198${String(id.size).padStart(8, '0')}` : from,
    to: RUNG,
  });
  id.set(label, rowId);
  return rowId;
}

/** Run the Insights rollup until it has nothing left to fold in. */
async function rollUp(): Promise<void> {
  for (let i = 0; i < 50; i++) if ((await agencyInsightsRollupRepository.recomputeBatch(200)).picked < 200) break;
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other] = await seedFloor({ tenants: 2, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignsPerTenant: 2, staffAgents: true }) as [TenantFloor, TenantFloor];
  campaignId = floor.campaigns[0]!;
  siblingCampaignId = floor.campaigns[1]!;
  const [agent0, agent1] = [floor.agents[0]!.id, floor.agents[1]!.id];
  await q(`UPDATE agency_campaigns SET status = 'running', started_at = $2, created_at = $2,
                  disposition_catalog = $3::jsonb WHERE id = ANY($1::uuid[])`,
  [floor.campaigns, at(-5 * 24 * 60), JSON.stringify([
    { code: 'interested', label: 'Interested', is_success: true },
    { code: 'will_pay', label: 'Will pay', is_success: true },
    { code: 'call_later', label: 'Call later', is_success: false },
  ])]);

  // ── The dialler: a conversation, a dial the customer's own call stopped, a no answer. ──
  const { rows: [session] } = await q(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, joined_at, left_at)
     VALUES ($1, $2, $3, $4, 'offline', $5, $6) RETURNING id`, [floor.tenant, floor.account, campaignId, agent0, at(0), at(110)]);
  const contact = async (phone: string) => (await q(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, 'completed') RETURNING id`, [campaignId, floor.tenant, floor.account, phone])).rows[0].id as string;
  const contactA = await contact('+919700004821');
  const contactD = await contact('+919700002210');
  const contactX = await contact('+919700009999');
  const attempt = async (label: string, contactId: string, created: Date, outcome: string, code: string | null, talk: number | null,
    o: { redialOf?: string; neverDialled?: boolean } = {}) => {
    const bridged = talk === null ? null : new Date(created.getTime() + 5000);
    const ended = new Date(created.getTime() + 5000 + (talk ?? 20) * 1000);
    const { rows: [row] } = await q(
      `INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, reserved_agent_id,
              state, outcome, disposition_code, dialed_at, answered_at, bridged_at, ended_at, redial_number, redial_of_attempt_id, created_at)
       VALUES ($1, $2, $3, $4, $12, '+919000000001', $5, 'ended', $6, $7, $8, $9, $9, $10, $13, $14, $11) RETURNING id`,
      [campaignId, contactId, floor.tenant, floor.account, session.id, outcome, code, o.neverDialled ? null : created, bridged, ended, created,
        o.redialOf ? 2 : 1, o.redialOf ? 1 : 0, o.redialOf ?? null]);
    id.set(label, row.id as string);
  };
  await attempt('d1', contactD, at(10), 'connected', 'interested', 40);
  await attempt('d2', contactA, at(41), 'canceled', 'inbound_call', null);
  await attempt('d3', contactX, at(20), 'no_answer', null, null);
  // A conversation that took a wrap-up redial: the first leg is closed `redialed`, and the
  // redial carries the write-up. Two dials, one conversation, and Connected counts the first leg only.
  const contactR = await contact('+919700007777');
  await attempt('d5', contactR, at(70), 'connected', 'redialed', 10);
  await attempt('d6', contactR, at(72), 'connected', 'call_later', 25, { redialOf: id.get('d5')! });
  // Cancelled before it was dialled: an attempt row, never a dial.
  await attempt('d7', await contact('+919700006666'), at(75), 'canceled', null, null, { neverDialled: true });

  // ── Inbound, filed under the campaign, in the window. ──
  // A: the customer d2 was ringing rang us instead, and an agent answered.
  const clashId = await inbound('A', { arrived: at(42), matched: contactA, from: '+919700004821', bridgedAfter: 18, answeredBy: agent0, endedAfter: 270, talk: 252, code: 'will_pay' });
  await q('UPDATE agency_inbound_calls SET clash_attempt_id = $2 WHERE id = $1', [clashId, id.get('d2')]);
  await inbound('B', { arrived: at(12), from: CALLER_B, outcome: 'voicemail', endedAfter: 100, voicemailSeconds: 22, followUp: { status: 'open', reason: 'overflow' } });
  await inbound('C', { arrived: at(15), from: null, outcome: 'closed', closedCause: 'hours', followUp: { status: 'open', reason: 'closed' } });
  await inbound('D', {
    arrived: at(22), outcome: 'abandoned_in_queue', endedAfter: 52,
    followUp: { status: 'handled', reason: 'abandoned_in_queue', handledBy: agent0, handledReason: 'marked' },
  });
  // E: on no list, filed by its route; its outcome is from the campaign's catalog, stored `route` (CL20).
  await inbound('E', { arrived: at(60), bridgedAfter: 10, answeredBy: agent1, endedAfter: 130, talk: 100, code: 'interested' });
  // Z arrived at the window's `to`, to the millisecond: outside a half-open window.
  await inbound('Z', { arrived: WINDOW.to, bridgedAfter: 5, answeredBy: agent0, endedAfter: 40, talk: 30, code: 'will_pay' });
  // ── Outside the window. ──
  await inbound('J', { arrived: at(-2 * 24 * 60), outcome: 'overflow_no_capacity', followUp: { status: 'open', reason: 'overflow_no_capacity' } });
  await inbound('K', { arrived: at(-24 * 60), bridgedAfter: 5, answeredBy: agent0, endedAfter: 80, talk: 60, code: 'call_later' });
  // ── Never this campaign's. ──
  await inbound('live', { arrived: at(50), state: 'queued' });
  await inbound('rejected', { arrived: at(51), outcome: 'rejected' });
  await inbound('unfiled', { arrived: at(52), campaign: null, outcome: 'closed', followUp: { status: 'open', reason: 'closed' } });
  await inbound('sibling', { arrived: at(53), campaign: siblingCampaignId, bridgedAfter: 5, answeredBy: agent0, endedAfter: 30, talk: 20, code: 'interested' });
  await inbound('other-tenant', { arrived: at(54), tenant: other, campaign: other.campaigns[0]!, outcome: 'closed', followUp: { status: 'open', reason: 'closed' } });

  // ── The soft phone, by agent 1, logged to the campaign. ──
  const { rows: [soft] } = await q(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, kind, joined_at, left_at)
     VALUES ($1, $2, NULL, $3, 'offline', 'softphone', $4, $5) RETURNING id`, [floor.tenant, floor.account, agent1, at(0), at(110)]);
  const manual = async (label: string, created: Date, to: string, how: 'connected' | 'no_answer' | 'never_dialled', code: string | null, talk: number | null, callbackOf: string | null) => {
    const dialled = how !== 'never_dialled';
    const ended = new Date(created.getTime() + 60_000);
    const { rows: [row] } = await q(
      `INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, campaign_id, destination_e164, caller_id,
              state, outcome, disposition_code, disposition_source, dialed_at, bridged_at, ended_at, settled_at, created_at,
              talk_seconds, callback_of_inbound_call_id)
       VALUES ($1, $2, $3, $4, $5, $6, '+919000000002', 'ended', $7, $8, $9, $10, $11, $12, $12, $13, $14, $15) RETURNING id`,
      [floor.tenant, floor.account, soft.id, agent1, campaignId, to, how === 'never_dialled' ? 'failed' : how, code,
        code ? 'campaign' : null, dialled ? new Date(created.getTime() + 500) : null, how === 'connected' ? new Date(created.getTime() + 5000) : null,
        ended, created, talk, callbackOf]);
    id.set(label, row.id as string);
  };
  await manual('s1', at(31), CALLER_B, 'connected', 'call_later', 30, id.get('B')!);
  await manual('s2', at(40), '+919811000040', 'connected', 'interested', 45, null);
  await manual('s3', at(34), CALLER_B, 'never_dialled', null, null, id.get('B')!);
  await manual('s4', at(44), '+919811000044', 'no_answer', null, null, null);
  // Created at the window's `to`, to the millisecond.
  await manual('s5', WINDOW.to, '+919811000120', 'connected', 'call_later', 20, null);

  await rollUp();
}, 180_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

describe('a campaign\'s inbound figures (calls.inbound)', () => {
  it('counts the ended, served calls filed under the campaign that arrived in the window', async () => {
    const a = await activityOf();
    expect(a.range).toMatchObject({ from: WINDOW.from.toISOString(), to: WINDOW.to.toISOString() });
    expect(a.calls.inbound).toEqual({
      // A, B, C, D, E. Not J or K (before the window), not Z (at `to`: the window is half-open),
      // not the live or the rejected call, not the unfiled one, the sibling campaign's or the
      // other tenant's.
      received: 5,
      // A and E.
      answered: 2,
      // B, C and D left a Missed row; D's has been handled since.
      missed: 3,
      // B, C, and J from two days ago: still owed a call, whatever the window.
      open_follow_ups: 3,
      talk_seconds: 252 + 100,
      // C was answered with the closed message: nobody could have taken it.
      open_hours: 4,
    });
  });

  it('counts a call under the campaign it is filed under, not the one its number matched or its outcome\'s catalog', async () => {
    // E matched no contact (`matched_campaign_id` NULL) and stores `disposition_source = 'route'`.
    const { rows: [e] } = await q('SELECT matched_campaign_id, campaign_id, campaign_source, disposition_source FROM agency_inbound_calls WHERE id = $1', [id.get('E')]);
    expect(e).toEqual({ matched_campaign_id: null, campaign_id: campaignId, campaign_source: 'route', disposition_source: 'route' });
    const a = await activityOf();
    expect(a.outcomes_by_type.find((r) => r.code === 'interested')?.inbound).toBe(1);
    // The sibling campaign has its own one call, and nothing of this campaign's.
    const sibling = await activityOf(siblingCampaignId);
    expect(sibling.calls.inbound).toEqual({ received: 1, answered: 1, missed: 0, open_follow_ups: 0, talk_seconds: 20, open_hours: 1 });
    // Another tenant's campaign: its own closed call, none of ours.
    const theirs = await activityOf(other.campaigns[0]!, other);
    expect(theirs.calls.inbound).toMatchObject({ received: 1, answered: 0, missed: 1, open_follow_ups: 1 });
  });

  it('/stats serves the campaign\'s whole life, beside the dialler\'s and the soft phone\'s', async () => {
    const stats = await get(`/proxy/agency/campaigns/${campaignId}/stats`) as { inbound: Inbound; softphone: Soft; first_dials_placed: number; human_connects: number; connect_rate_pct: number };
    // The window's five, J and K before it, and Z at its end.
    expect(stats.inbound).toEqual({ received: 8, answered: 4, missed: 4, open_follow_ups: 3, talk_seconds: 252 + 100 + 60 + 30, open_hours: 7 });
    // s1, s2, s4, and s5 at the window's end.
    expect(stats.softphone).toEqual({ placed: 4, connected: 3, human_connects: 3, talk_seconds: 95 });
    // The dialler's connect rate is the dialler's alone: two people reached (d1, and the
    // conversation d6 carries) of four first dials (d1, d2, d3, d5; d6 is a redial, d7 never dialled).
    expect(stats.first_dials_placed).toBe(4);
    expect(stats.human_connects).toBe(2);
    expect(stats.connect_rate_pct).toBeCloseTo(50, 9);
  });
});

describe('Calls by type agrees with the Call log\'s chips for the same campaign and window', () => {
  it('soft-phone and inbound calls, and the calls still to follow up: the chips\' numbers are the table\'s', async () => {
    const { calls } = await activityOf();
    const counts = await logCounts(logWindow);
    expect(calls.softphone.placed).toBe(3);
    expect(calls.inbound.received).toBe(5);
    expect(calls.softphone.placed).toBe(counts.soft_phone);
    expect(calls.inbound.received).toBe(counts.inbound);
    expect(calls.inbound.open_follow_ups).toBe(counts.to_follow_up);
    expect(counts.to_follow_up).toBe(3);
  });

  it('the window is half-open on a figure and inclusive on the log: a call at exactly `to` is in the log\'s count alone', async () => {
    const { calls } = await activityOf();
    const inclusive = await logCounts(logWindowToInclusive);
    // Z arrived and s5 was created at `to`, to the millisecond.
    expect(inclusive.inbound).toBe(calls.inbound.received + 1);
    expect(inclusive.soft_phone).toBe(calls.softphone.placed + 1);
    // To follow up ignores the dates on both sides.
    expect(inclusive.to_follow_up).toBe(calls.inbound.open_follow_ups);
    // And they are counted: over the campaign's life, where no window cuts them.
    const stats = await get(`/proxy/agency/campaigns/${campaignId}/stats`) as { inbound: Inbound; softphone: Soft };
    expect(stats.inbound.received).toBe(inclusive.inbound + 2);
    expect(stats.softphone.placed).toBe(inclusive.soft_phone);
  });

  it('the Dialler column is the Dials figure: the list its own link opens, not every attempt the chip lists', async () => {
    const { calls } = await activityOf();
    // d1, d2, d3, d5 and the redial d6. Not d7, which was never dialled.
    expect(calls.dials).toBe(5);
    // The Insights dials link: placed dials, the range half-open on `dialed_at`, the Dialler chip.
    const linked = await logCounts(`type=dialler&placed=1&dialed_from=${encodeURIComponent(WINDOW.from.toISOString())}&dialed_to=${encodeURIComponent(WINDOW.to.toISOString())}`);
    expect(linked.dialler).toBe(calls.dials);
    // Under plain dates the chip also lists the attempt that was never dialled: one more row,
    // which no figure counts.
    const plain = await logCounts(logWindow);
    expect(plain.dialler).toBe(calls.dials + 1);
    const { rows: [never] } = await q('SELECT dialed_at FROM agency_call_attempts WHERE id = $1', [id.get('d7')]);
    expect(never.dialed_at).toBeNull();
    // So All calls is the chips' All less that one row.
    expect(calls.dials + calls.softphone.placed + calls.inbound.received).toBe(plain.all - 1);
    expect(plain).toEqual({ all: 14, dialler: 6, soft_phone: 3, inbound: 5, to_follow_up: 3 });
  });

  it('Connected: inbound\'s and the soft phone\'s are the log\'s own filter; the dialler\'s leaves wrap-up redials out', async () => {
    const { calls } = await activityOf();
    const connected = await logCounts(`${logWindow}&outcome=connected`);
    expect(connected.inbound).toBe(calls.inbound.answered);
    expect(connected.soft_phone).toBe(calls.softphone.connected);
    // The log lists the connected redial d6 as its own row; the Connected figure counts the
    // conversation's first leg only (`redial_number = 0`).
    expect(calls.connected).toBe(2);
    expect(connected.dialler).toBe(calls.connected + 1);
    expect(connected.dialler).toBe(calls.by_outcome['connected']);
    // With the figure's own filter (the Connected tile's link sends `redial=0`) they are equal.
    expect((await logCounts(`${logWindow}&outcome=connected&redial=0`)).dialler).toBe(calls.connected);
    // So the table's All calls · Connected is d1, d5, s1, s2, A, E.
    expect(calls.connected + calls.softphone.connected + calls.inbound.answered).toBe(6);
    expect(connected.all).toBe(7);
  });

  it('Missed by us is the log\'s Missed filter on the inbound rows', async () => {
    const { calls } = await activityOf();
    expect((await logCounts(`${logWindow}&outcome=missed`)).inbound).toBe(calls.inbound.missed);
  });

  it('holds over the campaign\'s whole life too (/stats beside the Call log with no dates)', async () => {
    const stats = await get(`/proxy/agency/campaigns/${campaignId}/stats`) as { inbound: Inbound; softphone: Soft };
    // No dates: every call of the campaign.
    const counts = await logCounts('type=all');
    expect(stats.inbound.received).toBe(counts.inbound);
    expect(stats.softphone.placed).toBe(counts.soft_phone);
    expect(stats.inbound.open_follow_ups).toBe(counts.to_follow_up);
  });
});

describe('one row, one call, one type', () => {
  it('a missed call and its call back are two calls, each under its own type; a call back that never dialled is none', async () => {
    const { calls } = await activityOf();
    // B is one of the five inbound calls and one of the three missed.
    // s1, its call back, is one of the three soft-phone calls; s3, which never dialled, is not.
    const { rows } = await q(
      `SELECT id, dialed_at IS NOT NULL AS dialled FROM agency_manual_calls WHERE callback_of_inbound_call_id = $1 ORDER BY created_at`, [id.get('B')]);
    expect(rows).toEqual([{ id: id.get('s1'), dialled: true }, { id: id.get('s3'), dialled: false }]);
    expect(calls.softphone.placed).toBe(3);
    expect(calls.inbound.received).toBe(5);
    // The call back reached the customer; the missed call itself reached nobody: at most one
    // person reached between the two.
    expect(calls.softphone.human_connects).toBe(2);
    expect(calls.inbound.answered).toBe(2);
    // A call back does not close the Missed row: B is still to follow up.
    expect(calls.inbound.open_follow_ups).toBe(3);
  });

  it('a dial the customer\'s own call stopped is a dialler dial that reached nobody; the conversation counts once, under Inbound', async () => {
    const a = await activityOf();
    // d2 was placed and rang, so it is one of the five dials, under `canceled` (docs/insights.md
    // "System dispositions"). d7, cancelled before it was dialled, is not.
    expect(a.calls.dials).toBe(5);
    expect(a.calls.by_outcome['canceled']).toBe(1);
    // It is no connect, no conversation, no person reached and no outcome row: the two
    // conversations are d1's and the one d5 began and d6 carries.
    expect(a.calls.connected).toBe(2);
    expect(a.calls.conversations).toBe(2);
    expect(a.calls.human_connects).toBe(2);
    expect(a.outcomes.map((o) => o.code).sort()).toEqual(['call_later', 'interested']);
    // Neither system code is an outcome on any type.
    expect(a.outcomes_by_type.find((r) => r.code === 'inbound_call')).toBeUndefined();
    expect(a.outcomes_by_type.find((r) => r.code === 'redialed')).toBeUndefined();
    // The customer's own call is A: answered, with its outcome, under Inbound and nowhere else.
    expect(a.outcomes_by_type.find((r) => r.code === 'will_pay')).toMatchObject({ dialler: 0, soft_phone: 0, inbound: 1, total: 1 });
    // Across the types that customer is one connected call and one person reached, not two.
    const log = await get(`/proxy/agency/campaigns/${campaignId}/call-log?${windowQuery}&phone=4821&limit=10`) as { rows: Array<{ type: string; outcome: string }> };
    expect(log.rows.map((r) => `${r.type}:${r.outcome}`).sort()).toEqual(['dialler:canceled', 'inbound:answered']);
  });

  it('every outcome is counted on the one type its call was, and the columns add up', async () => {
    const a = await activityOf();
    expect(a.outcomes_by_type).toEqual([
      // d1, s2, E.
      { code: 'interested', label: 'Interested', is_success: true, dialler: 1, soft_phone: 1, inbound: 1, total: 3 },
      // d6 (the redial carries the conversation's outcome), s1. Not s5, created at `to`.
      { code: 'call_later', label: 'Call later', is_success: false, dialler: 1, soft_phone: 1, inbound: 0, total: 2 },
      // A. Not Z, which arrived at `to`.
      { code: 'will_pay', label: 'Will pay', is_success: true, dialler: 0, soft_phone: 0, inbound: 1, total: 1 },
    ]);
    // The dialler's column is the dialler's own outcome table, untouched.
    expect(a.outcomes_by_type.reduce((s, r) => s + r.dialler, 0)).toBe(a.calls.conversations);
    // The soft phone's and inbound's columns are their conversations: s1, s2; A, E.
    expect(a.outcomes_by_type.reduce((s, r) => s + r.soft_phone, 0)).toBe(2);
    expect(a.outcomes_by_type.reduce((s, r) => s + r.inbound, 0)).toBe(a.calls.inbound.answered);
  });

  it('marking a Missed row handled is not a call: every count stays, only the calls to follow up drop', async () => {
    const before = await activityOf();
    const beforeLog = await logCounts(windowQuery);
    const res = await call(loaded.app, 'POST', `/proxy/agency/inbound/missed/${id.get('C')}/handled`, floor.supervisors[0]!, floor, {});
    expect(res.statusCode, res.body).toBe(200);
    const after = await activityOf();
    const afterLog = await logCounts(windowQuery);
    expect(after.calls.inbound).toEqual({ ...before.calls.inbound, open_follow_ups: before.calls.inbound.open_follow_ups - 1 });
    expect(after.calls.softphone).toEqual(before.calls.softphone);
    expect(after.calls.dials).toBe(before.calls.dials);
    // And the Call log moved with it: no call more or fewer, one fewer to follow up.
    expect(afterLog).toEqual({ ...beforeLog, to_follow_up: beforeLog.to_follow_up - 1 });
    expect(after.calls.inbound.open_follow_ups).toBe(afterLog.to_follow_up);
  });
});

describe('no rate blends outbound and inbound', () => {
  it('the dialler\'s figures are what they are with no soft-phone or inbound call at all', async () => {
    const a = await activityOf();
    // Four placed first dials, two people reached: 50%, whatever the other eight calls did.
    expect(a.calls.redials.placed).toBe(1);
    expect(a.calls.dials - a.calls.redials.placed).toBe(4);
    expect(a.calls.human_connects).toBe(2);
    // Every bridged leg: d1, d5 and its redial d6.
    expect(a.calls.talk_seconds).toBe(40 + 10 + 25);
    // Not vacuous: the soft phone and inbound reached four more people between them.
    expect(a.calls.softphone.human_connects + a.calls.inbound.answered).toBe(4);
    // The trend buckets, the dialler's own series, hold the three dials and nothing else.
    insightsCache.clear();
    const trends = await get(`/proxy/agency/campaigns/${campaignId}/insights/trends?${windowQuery}&bucket=hour`) as { buckets: Array<{ dials: number; human_connects: number; first_dials: number }> };
    expect(trends.buckets.reduce((s, b) => s + b.dials, 0)).toBe(5);
    expect(trends.buckets.reduce((s, b) => s + b.first_dials, 0)).toBe(4);
    expect(trends.buckets.reduce((s, b) => s + b.human_connects, 0)).toBe(2);
  });

  it('the wire carries counts only: no rate, blended or not', async () => {
    const a = await activityOf();
    expect(Object.keys(a.calls.inbound).sort()).toEqual(['answered', 'missed', 'open_follow_ups', 'open_hours', 'received', 'talk_seconds']);
    expect(Object.keys(a.calls.softphone).sort()).toEqual(['connected', 'human_connects', 'placed', 'talk_seconds']);
  });
});

describe('the campaign report', () => {
  it('carries the same counts in its dataset, and the renderer draws Calls by type from them', async () => {
    // Local days in the campaign's zone, from three days ago to today: every seeded call.
    const { rows: [c] } = await q('SELECT default_timezone FROM agency_campaigns WHERE id = $1', [campaignId]);
    const zone = c.default_timezone as string;
    const now = new Date();
    const from = localDateOf(at(-3 * 24 * 60), zone);
    const to = localDateOf(now, zone);
    const { start, end } = localDayBounds(from, to, zone);
    const run: ReportRunRecord = {
      id: randomUUID(), tenant_id: floor.tenant, account_id: floor.account, kind: 'campaign', subject_id: campaignId,
      campaign_ids: null, range_from: start, range_to: end, local_from: from, local_to: to,
      timezone: zone, formats: ['pdf', 'xlsx'], audience: 'supervisor', requested_by: null, email_me: false,
      subscription_id: null, period_start: null, status: 'assembling', claim_generation: 1, claimed_at: now,
      render_attempt: 0, sent_at: null, dataset_key: null, detail_files: [], files: [], truncated: false,
      renderer_version: null, error_code: null, error_message: null, notified_at: null, created_at: now,
      finished_at: null, expires_at: null,
    };
    insightsCache.clear();
    const built = await REPORT_DATASET_BUILDERS.campaign({ run, now }) as unknown as BuiltReport<'campaign'>;
    const dataset = built.dataset as CampaignReportDataset;
    const calls = dataset.activity.calls;
    // The Call log over the same instants. C was marked handled by the test above.
    const counts = await logCounts(`from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`);
    // Every seeded call is days inside this window, so no edge is in play: the chips are the figures.
    expect(calls.inbound).toEqual({ received: 8, answered: 4, missed: 4, open_follow_ups: 2, talk_seconds: 442, open_hours: 7 });
    expect(calls.inbound.received).toBe(counts.inbound);
    expect(calls.softphone.placed).toBe(counts.soft_phone);
    // Dials, less the attempt that was never dialled, which the chip lists under plain dates.
    expect(calls.dials).toBe(5);
    expect(counts.dialler).toBe(calls.dials + 1);
    expect(calls.inbound.open_follow_ups).toBe(counts.to_follow_up);
    expect(dataset.definitions.map((d) => d.key)).toEqual(expect.arrayContaining(['outbound_connect_rate', 'inbound_calls', 'calls_by_type']));
    expect(dataset.activity.outcomes_by_type.find((r) => r.code === 'interested')).toMatchObject({ dialler: 1, soft_phone: 1, inbound: 1, total: 3 });
    // The whole seed, the two calls at the short window's end included.
    expect(dataset.activity.outcomes_by_type.find((r) => r.code === 'call_later')).toMatchObject({ dialler: 1, soft_phone: 2, inbound: 1, total: 4 });

    const html = (await renderer()).renderReportHtml(dataset, { fonts: { css: '', embedded: false } });
    const table = html.slice(html.indexOf('data-testid="calls-by-type"'), html.indexOf('data-testid="calls-by-type-note"'));
    const cells = (row: string) => [...table.split(`data-row="${row}"`)[1]!.split('</tr>')[0]!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)]
      .map((m) => m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    // Dialler, Soft phone, Inbound, All calls: the chips' numbers, and All calls their sum.
    expect(cells('calls')).toEqual(['Calls', '5 dialled', `${counts.soft_phone} dialled`, `${counts.inbound} received`, String(counts.all - 1)]);
    expect(counts.all - 1).toBe(5 + 4 + 8);
    expect(cells('missed')).toEqual(['Missed by us', '—', '—', '4 (2 to follow up)', '4']);
    expect(cells('rate').at(-1)).toBe('not added');
    expect(html).toContain('Outbound connect rate');
    expect(html).not.toMatch(/All calls connect rate/i);
  });
});

describe('the inbound figures\' own statement', () => {
  it('reads the window on idx_agency_inbound_calls_campaign (0070), and scans the table for neither half', async () => {
    // Many campaigns' inbound calls beside the sibling's, so the planner has a reason to choose.
    await q(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider, provider_call_id, from_e164, to_e164, campaign_id, campaign_source,
              state, outcome, arrived_at, ended_at, settled_at)
       SELECT $1, $2, 'plivo', 'CA-plan-' || n, '+9198' || lpad(n::text, 8, '0'), $3,
              CASE WHEN n % 40 = 0 THEN $4::uuid ELSE gen_random_uuid() END, 'route',
              'ended', 'rejected', now() - (n || ' seconds')::interval, now(), now()
         FROM generate_series(1, 8000) n`,
      [floor.tenant, floor.account, RUNG, siblingCampaignId]);
    await q('ANALYZE agency_inbound_calls');
    const { text, values } = inboundCampaignCountsStatement({ campaignId: siblingCampaignId, tenantId: floor.tenant, from: at(-60), to: at(240) });
    const { rows } = await getTestPool().query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, values);
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
    // The window's counts are a range of the campaign's index; the open Missed rows are read
    // from the account's Missed rows (the Missed list's index), not from every call the
    // campaign ever had.
    expect(plan, plan).toContain('idx_agency_inbound_calls_campaign');
    expect(plan, plan).toMatch(/idx_agency_inbound_calls_missed/);
    expect(plan).not.toContain('Seq Scan');
  });
});
