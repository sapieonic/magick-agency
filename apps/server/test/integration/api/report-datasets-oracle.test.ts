import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * ─── Report figure = screen figure (RP1), on real Postgres through the real app ─────────────
 *
 * One seeded account (two campaigns in Asia/Kolkata and America/New_York, three agents, four
 * worked days of sessions with recorded state changes, a shift through midnight, a soft-phone
 * session, attempts across every outcome, redial chains, callbacks kept on time, late, missed
 * and pending, overrides, agent retries, recorded and analysed calls, Do Not Call marks and
 * soft-phone calls), the rollup recomputed, then each builder's dataset held against the SCREEN
 * responses for the same window, fetched through `buildApp` + `inject` on the real routes:
 * Insights summary / activity / trends / health, the agent record (`agents/:id/stats`,
 * `my-stats`) and the roster (`agents/stats`).
 *
 * Also: the `self` audience (no benchmark, no quality, masked phones, no recording or sentiment
 * column), account totals as sums with the rate recomputed, the account's and the agent's days
 * re-bucketed into Asia/Kolkata and America/New_York across the 2026-11-01 clock change, refused
 * subjects, and detail cursors that stop early and give their client back.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'report-datasets-secret-0123456789ab';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getPool } from '@magick-agency/db';
import type { ReportAudience, ReportKind } from '@magick-agency/contracts/api/agency/reports';
import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { bulkInsert } from '../agency/insights-rollup-world.js';
import { insightsCache } from '../../../src/agency/insights/cache.js';
import { agencyInsightsRollupRepository } from '../../../src/db/repositories/agency.repository.js';
import type { ReportRunRecord } from '../../../src/db/repositories/agency/report-run.repository.js';
import { localDateOf, localDayBounds, localInstant } from '../../../src/agency/reports/schedule.js';
import {
  REPORT_DATASET_BUILDERS,
  ReportSubjectUnavailableError,
  type BuiltReport,
  type ReportDetailSource,
} from '../../../src/agency/reports/datasets/index.js';
import { localDates } from '../../../src/agency/reports/datasets/shared.js';
import type { AccountReportDataset, AgentReviewDataset, CampaignReportDataset } from '@magick-agency/contracts/reports';

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);
const sup = () => floor.supervisors[0]!;
const agent = (i: number) => floor.agents[i]!;

const ZONE = 'Asia/Kolkata';
const C0_ZONE = 'Asia/Kolkata';
const C1_ZONE = 'America/New_York';
const NOW = new Date();
const TODAY = localDateOf(NOW, ZONE);
const DAYS = localDates(shiftDate(TODAY, -4), shiftDate(TODAY, -1));
const FROM = DAYS[0]!;
const TO = DAYS[DAYS.length - 1]!;
const WINDOW = localDayBounds(FROM, TO, ZONE);

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** A wall time on a local date of `zone`, `HH:MM[:SS]`. */
function L(date: string, hhmm: string, zone = ZONE): Date {
  const [h, m, s] = hhmm.split(':').map(Number) as [number, number, number?];
  return localInstant(zone, date, h * 3600 + m * 60 + (s ?? 0));
}
const plus = (d: Date, seconds: number) => new Date(d.getTime() + seconds * 1000);

function runOf(o: {
  kind: ReportKind; subject: string; tenant: string; account: string; from: string; to: string; timezone: string;
  audience?: ReportAudience; campaignIds?: string[] | null;
}): ReportRunRecord {
  const { start, end } = localDayBounds(o.from, o.to, o.timezone);
  return {
    id: randomUUID(), tenant_id: o.tenant, account_id: o.account, kind: o.kind, subject_id: o.subject,
    campaign_ids: o.campaignIds ?? null, range_from: start, range_to: end, local_from: o.from, local_to: o.to,
    timezone: o.timezone, formats: ['pdf', 'xlsx'], audience: o.audience ?? 'supervisor', requested_by: null, email_me: false,
    subscription_id: null, period_start: null, status: 'assembling', claim_generation: 1, claimed_at: new Date(),
    render_attempt: 0, sent_at: null, dataset_key: null, detail_files: [], files: [], truncated: false,
    renderer_version: null, error_code: null, error_message: null, notified_at: null, created_at: new Date(),
    finished_at: null, expires_at: null,
  };
}

const timings: Record<string, number> = {};
async function build<K extends ReportKind>(run: ReportRunRecord, label?: string): Promise<BuiltReport<K>> {
  const t0 = performance.now();
  const built = await REPORT_DATASET_BUILDERS[run.kind]({ run, now: NOW });
  if (label) timings[label] = Math.round(performance.now() - t0);
  return built as unknown as BuiltReport<K>;
}

async function collect(src: ReportDetailSource): Promise<unknown[][]> {
  const out: unknown[][] = [];
  for await (const row of src.rows()) out.push(row);
  return out;
}

async function get(path: string, actor: Actor = sup(), f: TenantFloor = floor) {
  const res = await call(loaded.app, 'GET', path, actor, f);
  expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
  return res.json();
}

/** A screen body without its `generated_at` stamps (the one field that is the read's clock). */
const unstamped = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'generated_at' ? undefined : x)));
const windowQuery = (start: Date, end: Date) => `from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;

// ── The seed ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const sessions: Row[] = [];
const events: Row[] = [];
const contacts: Row[] = [];
const attempts: Row[] = [];
const calls: Row[] = [];
const manual: Row[] = [];
const dnc: Row[] = [];

/** What the seed says agent 0 did, for the blocks no screen serves. */
const truth = {
  callbacks: { on_time: 0, late: 0, missed: 0, pending_future: 0, pending_due: 0, booked: 0 },
  sentiment: { positive: 0, neutral: 0, negative: 0 },
  dnc: 0,
  softphone: 0,
  drops: 0,
  callRows: 0,
};

let phoneSeq = 0;
function contact(f: TenantFloor, campaignId: string, state = 'completed'): string {
  const id = randomUUID();
  contacts.push({ id, campaign_id: campaignId, tenant_id: f.tenant, account_id: f.account, phone_e164: `+9198${String(phoneSeq++).padStart(8, '0')}`, context: {}, state });
  return id;
}

function session(f: TenantFloor, o: { agent: string; campaign: string | null; joined: Date; left: Date; steps: Array<[string, Date, string | null]> }): string {
  const id = randomUUID();
  sessions.push({
    id, tenant_id: f.tenant, account_id: f.account, campaign_id: o.campaign, agent_user_id: o.agent,
    kind: o.campaign === null ? 'softphone' : 'campaign', state: o.campaign === null ? 'offline' : 'offline',
    joined_at: o.joined, left_at: o.left,
  });
  for (const [state, at, reason] of o.steps) {
    events.push({ id: randomUUID(), session_id: id, tenant_id: f.tenant, account_id: f.account, campaign_id: o.campaign, agent_user_id: o.agent, to_state: state, at, break_reason: reason });
  }
  return id;
}

function attempt(f: TenantFloor, o: Row & { campaign_id: string; contact_id: string; dialed_at: Date | null }): string {
  const id = (o['id'] as string | undefined) ?? randomUUID();
  attempts.push({
    attempt_number: 1, caller_id: '+919000000001', reserved_agent_id: null, state: 'ended', outcome: null, disposition_code: null,
    answered_at: null, bridged_at: null, ended_at: null, redial_number: 0, redial_of_attempt_id: null, agent_reopened: false,
    agent_manual: false, override_applied: [], callback_at: null, webrtc_call_id: null, wrapup_started_at: null,
    wrapup_ended_at: null, wrapup_resolution: null,
    tenant_id: f.tenant, account_id: f.account, ...o, id,
  });
  return id;
}

const talked = (t: Date, code: string | null, talkS = 60) => ({
  outcome: 'connected', answered_at: plus(t, 3), bridged_at: plus(t, 4), ended_at: plus(t, 4 + talkS),
  wrapup_started_at: plus(t, 4 + talkS), wrapup_ended_at: plus(t, 34 + talkS), wrapup_resolution: 'disposition_submitted',
  disposition_code: code,
});

function analysedCall(f: TenantFloor, campaignId: string | null, attemptId: string | null, analysis: unknown, recorded: boolean): string {
  const id = randomUUID();
  calls.push({
    id, tenant_id: f.tenant, account_id: f.account, caller_id: '+919000000001', destination_phone: '+919800000000',
    status: 'completed', recording_url: recorded ? `https://rec.example/${id}.mp3` : null,
    analysis_status: analysis === null ? null : 'completed', call_analysis: analysis, campaign_id: campaignId, agency_attempt_id: attemptId,
  });
  return id;
}

/** Four worked days for agent `i` on the main floor. */
function seedAgent(i: number, campaigns: [string, string]): void {
  const a = agent(i).id;
  DAYS.forEach((day, k) => {
    const campaign = campaigns[(i + k) % 2]!;
    const zone = ZONE;
    const join = L(day, `09:${String(i * 10).padStart(2, '0')}`, zone);
    const m = (minutes: number, seconds = 0) => plus(join, minutes * 60 + seconds);
    const sid = session(floor, {
      agent: a, campaign, joined: join, left: L(day, '13:00'),
      steps: [
        ['break', join, null], ['available', m(5), null], ['on_call', m(20), null], ['wrapup', m(25), null],
        ['available', m(27), null], ['reserved', m(40), null], ['on_call', m(40, 10), null], ['wrapup', m(45), null],
        ['available', m(46), null], ['break', L(day, '11:00'), 'lunch'], ['available', L(day, '11:30'), null],
        ['offline', L(day, '13:00'), null],
      ],
    });
    const base = m(20);
    const at = (j: number) => plus(base, j * 360);
    const mine = { reserved_agent_id: sid, campaign_id: campaign };

    // 0: a person reached, recorded and analysed.
    const callId = analysedCall(floor, campaign, null,
      k === 3 ? { overall_sentiment: { label: 'neutral', score: 0.5 } }
        : { common: { overall_sentiment: { label: ['positive', 'negative', 'mixed'][k], score: 0.5 } } }, true);
    attempt(floor, { ...mine, contact_id: contact(floor, campaign), dialed_at: at(0), ...talked(at(0), 'interested', 60 + i), webrtc_call_id: callId });
    if (i === 0) {
      if (k === 3) truth.sentiment.neutral += 1;
      else truth.sentiment[(['positive', 'negative', 'neutral'] as const)[k]!] += 1;
    }
    // 1: voicemail. 2: rang out.
    attempt(floor, { ...mine, contact_id: contact(floor, campaign), dialed_at: at(1), ...talked(at(1), 'voicemail', 20) });
    attempt(floor, { ...mine, contact_id: contact(floor, campaign), dialed_at: at(2), outcome: 'no_answer', ended_at: plus(at(2), 20) });
    // 3: a callback booked for the same time tomorrow.
    const cbContact = contact(floor, campaign, i === 0 && k === 2 ? 'pending' : 'completed');
    const callbackAt = plus(at(3), 86_400);
    attempt(floor, { ...mine, contact_id: cbContact, dialed_at: at(3), ...talked(at(3), 'callback'), callback_at: callbackAt });
    const callbackInWindow = callbackAt.getTime() < WINDOW.end.getTime();
    if (i === 0) {
      truth.callbacks.booked += 1;
      if (k === 0) {
        attempt(floor, { campaign_id: campaign, contact_id: cbContact, attempt_number: 2, dialed_at: plus(callbackAt, 300), outcome: 'no_answer', ended_at: plus(callbackAt, 320) });
        truth.callbacks.on_time += 1;
      } else if (k === 1) {
        attempt(floor, { campaign_id: campaign, contact_id: cbContact, attempt_number: 2, dialed_at: plus(callbackAt, 2400), outcome: 'no_answer', ended_at: plus(callbackAt, 2420) });
        truth.callbacks.late += 1;
      } else if (k === 2 && callbackInWindow) {
        truth.callbacks.pending_due += 1; // contact still pending, booked time passed
      }
    } else if (k === 0) {
      // Another agent's callback, kept by agent 0's campaign: not agent 0's to count.
    }
    if (i === 1 && k === 1) truth.callbacks.missed += 0; // agent 1's missed callback is not agent 0's
    // 4: the station went away mid-call.
    attempt(floor, { ...mine, contact_id: contact(floor, campaign), dialed_at: at(4), outcome: 'agent_disconnected', answered_at: plus(at(4), 3), bridged_at: plus(at(4), 4), ended_at: plus(at(4), 30) });
    if (i === 0) truth.drops += 1;
    // 5: a wrap-up redial chain: the original closed `redialed`, the redial carries the outcome.
    const chainContact = contact(floor, campaign);
    const original = attempt(floor, { ...mine, contact_id: chainContact, dialed_at: at(5), ...talked(at(5), 'redialed', 30) });
    attempt(floor, { ...mine, contact_id: chainContact, attempt_number: 2, dialed_at: plus(at(5), 90), ...talked(plus(at(5), 90), 'not_interested', 30), redial_number: 1, redial_of_attempt_id: original });
    // 6: an agent's own dial; 7: a reopened contact; 8: an override spent.
    attempt(floor, { ...mine, contact_id: contact(floor, campaign), dialed_at: at(6), outcome: 'no_answer', ended_at: plus(at(6), 15), agent_manual: true });
    attempt(floor, { ...mine, contact_id: contact(floor, campaign), dialed_at: at(7), ...talked(at(7), 'interested', 45), agent_reopened: true });
    attempt(floor, { ...mine, contact_id: contact(floor, campaign), dialed_at: at(8), outcome: 'busy', ended_at: plus(at(8), 5), override_applied: ['extra_attempts'] });
    // 9: answered, reached no agent (abandoned), no session.
    attempt(floor, { campaign_id: campaign, contact_id: contact(floor, campaign), dialed_at: at(9), outcome: 'abandoned', answered_at: plus(at(9), 3), ended_at: plus(at(9), 11) });
    if (i === 0) truth.callRows += 10; // 0–8 and the redial (9 is not theirs)

    // Agent 0, day 1: a shift through midnight. Day 2: a soft-phone session with a call.
    if (i === 0 && k === 1 && DAYS[2]) {
      const night = L(day, '22:30');
      const sidN = session(floor, {
        agent: a, campaign, joined: night, left: L(DAYS[2], '01:30'),
        steps: [['available', night, null], ['on_call', L(day, '23:50'), null], ['available', L(DAYS[2], '00:20'), null], ['offline', L(DAYS[2], '01:30'), null]],
      });
      attempt(floor, { reserved_agent_id: sidN, campaign_id: campaign, contact_id: contact(floor, campaign), dialed_at: L(day, '23:49'), ...talked(L(day, '23:49'), 'interested', 1700) });
      truth.callRows += 1;
    }
    if (i === 0 && k === 2) {
      const sp = L(day, '14:00');
      const spId = session(floor, { agent: a, campaign: null, joined: sp, left: L(day, '14:30'), steps: [['break', sp, 'soft_phone'], ['offline', L(day, '14:30'), null]] });
      const spCall = analysedCall(floor, null, null, { common: { overall_sentiment: { label: 'positive', score: 0.9 } } }, false);
      manual.push({ id: randomUUID(), tenant_id: floor.tenant, account_id: floor.account, session_id: spId, agent_user_id: a, destination_e164: '+919812340000',
        caller_id: '+919000000001', state: 'ended', outcome: 'connected', dialed_at: L(day, '14:05'), bridged_at: L(day, '14:05:10'),
        ended_at: L(day, '14:07:10'), created_at: L(day, '14:05'), webrtc_call_id: spCall, settled_at: L(day, '14:07:10') });
      manual.push({ id: randomUUID(), tenant_id: floor.tenant, account_id: floor.account, session_id: spId, agent_user_id: a, destination_e164: '+919812349999',
        caller_id: '+919000000001', state: 'ended', outcome: 'canceled', dialed_at: null, bridged_at: null, ended_at: L(day, '14:20:05'), created_at: L(day, '14:20'), webrtc_call_id: null, settled_at: L(day, '14:20:05') });
      truth.softphone += 1;
      truth.sentiment.positive += 1;
      truth.callRows += 1;
    }
  });
  // Do Not Call marks: two in the window (both spellings of the author), one before it.
  dnc.push({ tenant_id: floor.tenant, account_id: floor.account, campaign_id: campaigns[0], phone_e164: `+91977${i}000001`, source: 'agent', added_by: a, created_at: L(DAYS[0]!, '10:00') });
  dnc.push({ tenant_id: floor.tenant, account_id: floor.account, campaign_id: campaigns[1], phone_e164: `+91977${i}000002`, source: 'agent', added_by: `user:${a}`, created_at: L(DAYS[1]!, '10:00') });
  dnc.push({ tenant_id: floor.tenant, account_id: floor.account, campaign_id: campaigns[0], phone_e164: `+91977${i}000003`, source: 'agent', added_by: a, created_at: L(shiftDate(FROM, -3), '10:00') });
  if (i === 0) truth.dnc = 2;
}

/** The DST floor (tenant 1): attempts at fixed instants around 2026-11-01 for re-bucketing. */
const DST_INSTANTS = [
  '2026-10-31T18:45:00Z', '2026-11-01T03:30:00Z', '2026-11-01T04:30:00Z', '2026-11-01T05:30:00Z',
  '2026-11-01T06:30:00Z', '2026-11-01T18:20:00Z', '2026-11-01T18:35:00Z', '2026-11-02T04:30:00Z', '2026-11-02T05:15:00Z',
].map((s) => new Date(s));
function seedDst(): void {
  const campaign = other.campaigns[0]!;
  const b0 = other.agents[0]!.id;
  const start = new Date('2026-10-31T12:00:00Z');
  const end = new Date('2026-11-02T12:00:00Z');
  const sid = session(other, { agent: b0, campaign, joined: start, left: end, steps: [['available', start, null], ['offline', end, null]] });
  for (const t of DST_INSTANTS) attempt(other, { reserved_agent_id: sid, campaign_id: campaign, contact_id: contact(other, campaign), dialed_at: t, outcome: 'no_answer', ended_at: plus(t, 10) });
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other] = await seedFloor({ tenants: 2, agentsPerTenant: 3, supervisorsPerTenant: 1, campaignsPerTenant: 2, staffAgents: true }) as [TenantFloor, TenantFloor];
  const [c0, c1] = floor.campaigns as [string, string];
  const created = L(shiftDate(FROM, -10), '08:00');
  await q(`UPDATE agency_campaigns SET status = 'running', started_at = $2, created_at = $2, default_timezone = $3 WHERE id = $1`, [c0, created, C0_ZONE]);
  await q(`UPDATE agency_campaigns SET status = 'paused', started_at = $2, created_at = $2, default_timezone = $3, paused_at = $2 WHERE id = $1`, [c1, created, C1_ZONE]);
  await q(`UPDATE agency_campaigns SET status = 'completed', created_at = '2026-10-20T00:00:00Z', default_timezone = 'Europe/London' WHERE id = $1`, [other.campaigns[0]]);

  for (let i = 0; i < 3; i++) seedAgent(i, [c0, c1]);
  seedDst();
  const pool = getTestPool();
  await bulkInsert(pool, 'agency_contacts', [['id', 'uuid'], ['campaign_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['phone_e164', 'text'], ['context', 'jsonb'], ['state', 'text']], contacts);
  await bulkInsert(pool, 'agency_agent_sessions', [['id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['campaign_id', 'uuid'], ['agent_user_id', 'uuid'], ['kind', 'text'], ['state', 'text'], ['joined_at', 'timestamptz'], ['left_at', 'timestamptz']], sessions);
  await bulkInsert(pool, 'agency_agent_session_events', [['id', 'uuid'], ['session_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['campaign_id', 'uuid'], ['agent_user_id', 'uuid'], ['to_state', 'text'], ['at', 'timestamptz'], ['break_reason', 'text']], events);
  await bulkInsert(pool, 'agency_calls', [['id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['caller_id', 'text'], ['destination_phone', 'text'], ['status', 'text'], ['recording_url', 'text'], ['analysis_status', 'text'], ['call_analysis', 'jsonb'], ['campaign_id', 'uuid'], ['agency_attempt_id', 'uuid']], calls);
  await bulkInsert(pool, 'agency_call_attempts', [
    ['id', 'uuid'], ['campaign_id', 'uuid'], ['contact_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['attempt_number', 'int'],
    ['caller_id', 'text'], ['reserved_agent_id', 'uuid'], ['state', 'text'], ['outcome', 'text'], ['disposition_code', 'text'],
    ['dialed_at', 'timestamptz'], ['answered_at', 'timestamptz'], ['bridged_at', 'timestamptz'], ['ended_at', 'timestamptz'],
    ['redial_number', 'int'], ['redial_of_attempt_id', 'uuid'], ['agent_reopened', 'boolean'], ['agent_manual', 'boolean'],
    ['override_applied', 'text[]'], ['callback_at', 'timestamptz'], ['webrtc_call_id', 'uuid'], ['wrapup_started_at', 'timestamptz'],
    ['wrapup_ended_at', 'timestamptz'], ['wrapup_resolution', 'text'],
  ], attempts);
  await bulkInsert(pool, 'agency_manual_calls', [['id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['session_id', 'uuid'], ['agent_user_id', 'uuid'],
    ['destination_e164', 'text'], ['caller_id', 'text'], ['state', 'text'], ['outcome', 'text'], ['dialed_at', 'timestamptz'], ['bridged_at', 'timestamptz'],
    ['ended_at', 'timestamptz'], ['created_at', 'timestamptz'], ['webrtc_call_id', 'uuid'], ['settled_at', 'timestamptz']], manual);
  await bulkInsert(pool, 'dnc_entries', [['tenant_id', 'uuid'], ['account_id', 'uuid'], ['campaign_id', 'uuid'], ['phone_e164', 'text'], ['source', 'text'], ['added_by', 'text'], ['created_at', 'timestamptz']], dnc);
  // Agent 2 has left the account: the roster screen drops them by default, the review keeps them.
  await q(`UPDATE memberships SET status = 'revoked' WHERE user_id = $1`, [agent(2).id]);
  for (let i = 0; i < 100; i++) if ((await agencyInsightsRollupRepository.recomputeBatch(500)).picked < 500) break;
  insightsCache.clear();
}, 180_000);

afterAll(async () => {
  // eslint-disable-next-line no-console
  console.log('report builder timings (ms):', JSON.stringify(timings));
  await stopLoadApp(loaded);
});

// ── The agent review ────────────────────────────────────────────────────────

describe('agent review: every figure equals the screen it comes from', () => {
  let ds: Omit<AgentReviewDataset, 'detail_files'>;
  let built: BuiltReport<'agent'>;
  beforeAll(async () => {
    built = await build<'agent'>(runOf({ kind: 'agent', subject: agent(0).id, tenant: floor.tenant, account: floor.account, from: FROM, to: TO, timezone: ZONE }), 'agent');
    ds = built.dataset;
  });

  it('record and per_campaign = GET /agents/:id/stats for the window (the agent record screen)', async () => {
    const screen = await get(`/proxy/agency/agents/${agent(0).id}/stats?${windowQuery(WINDOW.start, WINDOW.end)}&bucket=day`);
    expect(ds.record).toEqual(screen.totals);
    expect(ds.record.attempts).toBeGreaterThan(30); // not vacuous
    const byId = (rows: Array<{ campaign_id: string }>) => [...rows].sort((a, b) => a.campaign_id.localeCompare(b.campaign_id));
    expect(byId(ds.per_campaign.map(({ campaign_name: _n, ...row }) => row))).toEqual(byId(screen.by_campaign));
    expect(ds.per_campaign.map((c) => c.campaign_name).sort()).toEqual(['Load 0.0', 'Load 0.1']);
  });

  it('roster_row and benchmark = GET /agents/stats for the window (the roster screen); occupancy per RP11', async () => {
    const screen = await get(`/proxy/agency/agents/stats?${windowQuery(WINDOW.start, WINDOW.end)}&sort=attempts&order=desc&limit=200&include_inactive=true`);
    const row = screen.rows.find((r: { agent_user_id: string }) => r.agent_user_id === agent(0).id);
    expect(ds.roster_row).toEqual(row);
    expect(ds.benchmark).toEqual({ cohort: screen.benchmark, pool_size: screen.benchmark.agents_rated });
    expect(ds.occupancy.handling_pct).toBe(row.occupancy_pct);
    const occ = ds.record.occupancy!;
    expect(ds.occupancy.on_call_pct).toBeCloseTo((occ.by_state.on_call / occ.shift_seconds) * 100, 9);
    expect(ds.occupancy.on_call_pct_excl_break).toBeCloseTo((occ.by_state.on_call / (occ.shift_seconds - occ.by_state.break)) * 100, 9);
    expect(ds.floors.agent_rate_min_first_dials).toBe(20);
  });

  it('presence equals the record\'s occupancy; the days sum to the record', () => {
    const occ = ds.record.occupancy!;
    expect(ds.presence.by_state).toEqual({
      available: occ.by_state.available + occ.by_state.reserved, on_call: occ.by_state.on_call, wrapup: occ.by_state.wrapup, break: occ.by_state.break,
    });
    expect(ds.presence.station_seconds).toBe(occ.shift_seconds);
    expect(ds.daily).toHaveLength(ds.range.days);
    expect(ds.range.days).toBe(4);
    const total = (k: keyof AgentReviewDataset['daily'][number]) => ds.daily.reduce((s, d) => s + Number(d[k]), 0);
    expect(total('dials')).toBe(ds.record.attempts);
    expect(total('connected')).toBe(ds.record.connected);
    expect(total('conversations')).toBe(ds.record.connected);
    expect(total('successes')).toBe(ds.record.successes);
    expect(total('talk_s')).toBe(ds.record.talk_seconds);
    expect(total('first_dials')).toBe(ds.per_campaign.reduce((s, c) => s + c.first_dials, 0));
    expect(total('human_connects')).toBe(ds.per_campaign.reduce((s, c) => s + c.human_connects, 0));
    expect(total('station_s')).toBe(ds.presence.station_seconds);
    expect(total('drops')).toBe(truth.drops);
    expect(ds.presence.drops).toBe(truth.drops);
    expect(ds.presence.days_worked).toBe(4);
    expect(ds.presence.break_by_reason.reduce((s, r) => s + r.seconds, 0)).toBe(ds.presence.by_state.break);
    expect(ds.presence.break_by_reason.map((r) => r.reason).sort()).toEqual(['lunch', 'soft_phone', 'unspecified']);
    expect(ds.presence.break_by_reason.find((r) => r.reason === 'soft_phone')).toMatchObject({ label: 'Soft phone', seconds: 1800 });
    // The shift through midnight: split at local midnight, 90 minutes each side.
    expect(ds.daily[1]!.last_out).toBe(L(DAYS[2]!, '00:00').toISOString());
    expect(ds.daily[2]!.first_in).toBe(L(DAYS[2]!, '00:00').toISOString());
  });

  it('the agent\'s Insights rows agree: dials, talk, redials, retries, overrides and campaign time', async () => {
    let dials = 0, talk = 0, redials = 0, retries = 0, overrides = 0, online = 0;
    for (const c of floor.campaigns) {
      const activity = await get(`/proxy/agency/campaigns/${c}/insights/activity?${windowQuery(WINDOW.start, WINDOW.end)}`);
      const row = activity.agents.find((r: { agent_user_id: string | null }) => r.agent_user_id === agent(0).id);
      dials += row.dials; talk += row.talk_seconds; redials += row.redials; retries += row.retries; overrides += row.overrides; online += row.online_seconds;
    }
    expect(dials).toBe(ds.record.attempts);
    expect(talk).toBeCloseTo(ds.record.talk_seconds, 6);
    expect(ds.follow_through.redials_placed).toBe(redials);
    expect(ds.follow_through.agent_retries).toBe(retries);
    expect(ds.follow_through.overrides_used).toBe(overrides);
    // Insights counts campaign sessions; the review adds the soft-phone session's time.
    expect(online + 1800).toBe(ds.presence.station_seconds);
  });

  it('follow-through, outcomes and quality match the seed', () => {
    expect(ds.follow_through.callbacks).toEqual({
      booked: truth.callbacks.booked, on_time: truth.callbacks.on_time, late: truth.callbacks.late,
      missed: truth.callbacks.missed, pending_future: truth.callbacks.pending_future, pending_due: truth.callbacks.pending_due,
    });
    expect(ds.follow_through.redials_connected).toBe(ds.follow_through.redials_placed);
    expect(ds.follow_through.dnc_marked).toBe(truth.dnc);
    expect(ds.follow_through.softphone_calls).toBe(truth.softphone);
    expect(ds.quality).toEqual({ analysed_calls: 5, sentiment: truth.sentiment });
    const conversations = ds.outcomes.reduce((s, o) => s + o.conversations, 0);
    expect(conversations).toBe(ds.daily.reduce((s, d) => s + d.conversations, 0));
    expect(ds.outcomes.filter((o) => o.is_success).reduce((s, o) => s + o.conversations, 0)).toBe(ds.record.successes);
    expect(ds.outcomes.find((o) => o.code === 'interested')).toMatchObject({ label: 'Interested', is_success: true });
    expect(ds.outcomes.find((o) => o.code === null)).toMatchObject({ label: 'Closed without an outcome' }); // the dropped calls
    expect(ds.campaigns.map((c) => c.timezone).sort()).toEqual([C1_ZONE, C0_ZONE].sort());
  });

  it('the timeline is the busiest day, whole and contiguous', () => {
    expect(ds.timeline?.date).toBe(DAYS[2]);
    const segs = ds.timeline!.segments;
    expect(segs[0]!.start).toBe(L(DAYS[2]!, '00:00').toISOString());
    expect(segs.at(-1)!.end).toBe(L(DAYS[3]!, '00:00').toISOString());
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.start).toBe(segs[i - 1]!.end);
    expect(segs[0]).toMatchObject({ state: 'on_call', end: L(DAYS[2]!, '00:20').toISOString() });
    expect(segs.find((s) => s.break_reason === 'soft_phone')).toMatchObject({ state: 'break', start: L(DAYS[2]!, '14:00').toISOString() });
  });

  it('the detail sheets: every call and session, full numbers and the analysis for a supervisor', async () => {
    expect(built.details.map((d) => d.sheet)).toEqual(['sessions', 'state_log', 'calls']);
    const [sessionsSrc, stateSrc, callsSrc] = built.details as [ReportDetailSource, ReportDetailSource, ReportDetailSource];
    const callRows = await collect(callsSrc);
    expect(callRows).toHaveLength(ds.record.attempts + truth.softphone);
    expect(callRows).toHaveLength(truth.callRows);
    for (const r of callRows) expect(r).toHaveLength(callsSrc.columns.length);
    const keys = callsSrc.columns.map((c) => c.key);
    expect(keys).toContain('recorded');
    expect(keys).toContain('sentiment');
    const phone = keys.indexOf('phone');
    expect(callRows.every((r) => typeof r[phone] === 'string' && /^\+\d{10,}$/.test(r[phone] as string))).toBe(true);
    const times = callRows.map((r) => r[0] as string);
    expect([...times].sort()).toEqual(times);
    expect(callRows.filter((r) => r[keys.indexOf('recorded')] === true)).toHaveLength(4);

    const sessionRows = await collect(sessionsSrc);
    expect(sessionRows).toHaveLength(6); // four shifts, the night shift and the soft phone
    const loggedIn = sessionsSrc.columns.findIndex((c) => c.key === 'logged_in_s');
    expect(sessionRows.reduce((s, r) => s + Number(r[loggedIn]), 0)).toBe(ds.presence.station_seconds);
    const stateRows = await collect(stateSrc);
    const secs = stateSrc.columns.findIndex((c) => c.key === 'seconds');
    expect(stateRows.reduce((s, r) => s + Number(r[secs]), 0)).toBe(ds.presence.station_seconds);
  });
});

describe('agent review, self audience (RP5, RP7)', () => {
  let built: BuiltReport<'agent'>;
  beforeAll(async () => {
    built = await build<'agent'>(runOf({ kind: 'agent', subject: agent(0).id, tenant: floor.tenant, account: floor.account, from: FROM, to: TO, timezone: ZONE, audience: 'self' }), 'agent_self');
  });

  it('record = GET /my-stats as the agent; no benchmark, no quality', async () => {
    const screen = await get(`/proxy/agency/my-stats?${windowQuery(WINDOW.start, WINDOW.end)}&bucket=day`, agent(0));
    expect(built.dataset.record).toEqual(screen.totals);
    expect(built.dataset.audience).toBe('self');
    expect(built.dataset.benchmark).toBeNull();
    expect(built.dataset.quality).toBeNull();
    expect(built.dataset.roster_row).not.toBeNull();
    expect(built.dataset.definitions.map((d) => d.key)).not.toContain('sentiment');
    expect(built.dataset.definitions.map((d) => d.key)).not.toContain('floor_comparison');
  });

  it('the calls sheet masks every number to its last four digits and has no recording or sentiment column', async () => {
    const callsSrc = built.details.find((d) => d.sheet === 'calls')!;
    const keys = callsSrc.columns.map((c) => c.key);
    expect(keys).not.toContain('recorded');
    expect(keys).not.toContain('sentiment');
    const rows = await collect(callsSrc);
    expect(rows.length).toBeGreaterThan(30);
    const phone = keys.indexOf('phone');
    for (const r of rows) {
      expect(r).toHaveLength(keys.length);
      expect(r[phone]).toMatch(/^\*{4}\d{4}$/);
    }
  });
});

// ── The campaign report ─────────────────────────────────────────────────────

describe('campaign report: the Insights tab\'s four reads, verbatim', () => {
  let ds: Omit<CampaignReportDataset, 'detail_files'>;
  let built: BuiltReport<'campaign'>;
  const campaignWindow = () => localDayBounds(FROM, TO, C0_ZONE);
  beforeAll(async () => {
    built = await build<'campaign'>(runOf({ kind: 'campaign', subject: floor.campaigns[0]!, tenant: floor.tenant, account: floor.account, from: FROM, to: TO, timezone: C0_ZONE }), 'campaign');
    ds = built.dataset;
  });

  it('summary, activity, trends (day) and health = the four Insights routes for the window', async () => {
    const c = floor.campaigns[0]!;
    const w = windowQuery(campaignWindow().start, campaignWindow().end);
    insightsCache.clear();
    const [summary, activity, trends, health] = await Promise.all([
      get(`/proxy/agency/campaigns/${c}/insights/summary`),
      get(`/proxy/agency/campaigns/${c}/insights/activity?${w}`),
      get(`/proxy/agency/campaigns/${c}/insights/trends?${w}&bucket=day`),
      get(`/proxy/agency/campaigns/${c}/insights/health?${w}`),
    ]);
    expect(unstamped(ds.activity)).toEqual(unstamped(activity));
    expect(unstamped(ds.trends)).toEqual(unstamped(trends));
    expect(unstamped(ds.health)).toEqual(unstamped(health));
    expect(unstamped(ds.summary)).toEqual(unstamped(summary));
    expect(ds.activity.calls.dials).toBeGreaterThan(40);
    expect(ds.trends.buckets).toHaveLength(ds.range.days);
    expect(ds.campaign).toEqual({ id: c, name: 'Load 0.0', status: 'running', timezone: C0_ZONE });
    expect(ds.floors.campaign_rate_min_first_dials).toBe(25);
  });

  it('agent_names covers every agent id the blocks carry', () => {
    for (const row of ds.activity.agents) if (row.agent_user_id) expect(ds.agent_names).toHaveProperty(row.agent_user_id);
    for (const row of ds.activity.dnc_marked.by_agent) if (row.user_id) expect(ds.agent_names).toHaveProperty(row.user_id);
    expect(ds.agent_names[agent(0).id]).toBe('agent 0.0');
  });

  it('the attempts sheet holds every placed dial; the sessions sheet every session', async () => {
    const [attemptsSrc, sessionsSrc] = built.details as [ReportDetailSource, ReportDetailSource];
    expect(built.details.map((d) => d.sheet)).toEqual(['attempts', 'sessions']);
    const rows = await collect(attemptsSrc);
    expect(rows).toHaveLength(ds.activity.calls.dials);
    const phone = attemptsSrc.columns.findIndex((c) => c.key === 'phone');
    expect(rows.every((r) => /^\+\d+$/.test(String(r[phone])))).toBe(true);
    const agentCol = attemptsSrc.columns.findIndex((c) => c.key === 'agent');
    expect(rows.filter((r) => r[agentCol] === 'agent 0.0').length).toBeGreaterThan(0);
    const sessionRows = await collect(sessionsSrc);
    expect(sessionRows.length).toBeGreaterThanOrEqual(6);
    expect(sessionRows[0]).toHaveLength(sessionsSrc.columns.length);
  });
});

// ── The account report ──────────────────────────────────────────────────────

describe('account report: campaign rows from Insights, totals summed, agents from the roster', () => {
  let ds: Omit<AccountReportDataset, 'detail_files'>;
  let built: BuiltReport<'account'>;
  const tz = C1_ZONE;
  const w = () => localDayBounds(FROM, TO, tz);
  beforeAll(async () => {
    built = await build<'account'>(runOf({ kind: 'account', subject: floor.account, tenant: floor.tenant, account: floor.account, from: FROM, to: TO, timezone: tz }), 'account');
    ds = built.dataset;
  });

  it('each campaign row = that campaign\'s Insights activity, trends and health for the window', async () => {
    expect(ds.campaigns.map((c) => c.id)).toEqual(floor.campaigns);
    for (const row of ds.campaigns) {
      const qs = windowQuery(w().start, w().end);
      const [activity, trends, health] = await Promise.all([
        get(`/proxy/agency/campaigns/${row.id}/insights/activity?${qs}`),
        get(`/proxy/agency/campaigns/${row.id}/insights/trends?${qs}&bucket=day`),
        get(`/proxy/agency/campaigns/${row.id}/insights/health?${qs}`),
      ]);
      expect(row.calls).toEqual(activity.calls);
      expect(row.callbacks_booked).toBe(activity.callbacks.booked);
      const abandoned = trends.buckets.reduce((s: number, b: { abandoned: number }) => s + b.abandoned, 0);
      const answered = trends.buckets.reduce((s: number, b: { answered: number }) => s + b.answered, 0);
      expect(row.abandoned).toBe(abandoned);
      expect(row.answered).toBe(answered);
      expect(abandoned).toBeGreaterThan(0);
      expect(row.abandoned_pct).toBeCloseTo((abandoned / answered) * 100, 9);
      expect(row.recording_connected).toBe(health.recording.connected);
      expect(row.recorded).toBe(health.recording.recorded);
      const h = ds.health.find((x) => x.campaign_id === row.id)!;
      expect(h).toEqual({
        campaign_id: row.id, auto_pauses: health.abandonment.auto_pauses.length, stall_minutes_by_reason: health.stalls.minutes_by_reason,
        concurrency_limit_minutes: health.concurrency_limit_minutes, carrier_failures: health.carrier_failures,
        our_fault_retired: health.our_fault_retired, predial_blocks: health.predial_blocks,
      });
    }
  });

  it('totals are the campaigns summed, the rate recomputed from the sums (never averaged)', () => {
    const [a, b] = ds.campaigns as [AccountReportDataset['campaigns'][number], AccountReportDataset['campaigns'][number]];
    expect(ds.totals.calls.dials).toBe(a.calls.dials + b.calls.dials);
    expect(ds.totals.calls.redials.placed).toBe(a.calls.redials.placed + b.calls.redials.placed);
    expect(ds.totals.calls.by_outcome.connected).toBe(a.calls.by_outcome.connected + b.calls.by_outcome.connected);
    expect(ds.totals.calls.agent_retries.manual_dials).toBe(a.calls.agent_retries.manual_dials + b.calls.agent_retries.manual_dials);
    expect(ds.totals.abandoned).toBe(a.abandoned + b.abandoned);
    expect(ds.totals.answered).toBe(a.answered + b.answered);
    expect(ds.totals.abandoned_pct).toBeCloseTo(((a.abandoned + b.abandoned) / (a.answered + b.answered)) * 100, 9);
    expect(ds.totals.recorded).toBe(a.recorded + b.recorded);
  });

  it('agents and benchmark = GET /agents/stats for the window (departed agent dropped, as on the screen)', async () => {
    const screen = await get(`/proxy/agency/agents/stats?${windowQuery(w().start, w().end)}&sort=attempts&order=desc&limit=200`);
    expect(ds.agents).toEqual(screen.rows);
    expect(ds.agents.map((r) => r.agent_user_id)).not.toContain(agent(2).id);
    expect(ds.benchmark).toEqual({ cohort: screen.benchmark, pool_size: screen.benchmark.agents_rated });
  });

  it('the days are every local date of the window and sum to the totals', () => {
    expect(ds.daily.map((d) => d.date)).toEqual(localDates(FROM, TO));
    const sum = (k: 'dials' | 'first_dials' | 'connected' | 'conversations' | 'human_connects' | 'successes') => ds.daily.reduce((s, d) => s + d[k], 0);
    expect(sum('dials')).toBe(ds.totals.calls.dials);
    expect(sum('connected')).toBe(ds.totals.calls.connected);
    expect(sum('conversations')).toBe(ds.totals.calls.conversations);
    expect(sum('human_connects')).toBe(ds.totals.calls.human_connects);
    expect(sum('successes')).toBe(ds.totals.calls.successes);
    expect(sum('first_dials')).toBe(ds.totals.calls.dials - ds.totals.calls.redials.placed);
    expect(ds.daily.every((d) => d.agents_online_peak === null)).toBe(true);
  });

  it('the attempts sheet holds every placed dial of the covered campaigns', async () => {
    const rows = await collect(built.details[0]!);
    expect(built.details.map((d) => d.sheet)).toEqual(['attempts']);
    expect(rows).toHaveLength(ds.totals.calls.dials);
    expect(built.details[0]!.columns.map((c) => c.key)).toContain('campaign');
  });
});

// ── Days in another zone, across a clock change ─────────────────────────────

describe('days re-bucketed into the report\'s zone (Asia/Kolkata, America/New_York across 2026-11-01)', () => {
  const localDate = (d: Date, zone: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  for (const zone of ['America/New_York', 'Asia/Kolkata']) {
    it(`account and agent days in ${zone} put each dial on its local date`, async () => {
      const dates = localDates('2026-10-31', '2026-11-02');
      const expected = dates.map((date) => DST_INSTANTS.filter((t) => localDate(t, zone) === date).length);
      const { start, end } = localDayBounds('2026-10-31', '2026-11-02', zone);
      const inWindow = DST_INSTANTS.filter((t) => t >= start && t < end).length;
      expect(expected.reduce((s, n) => s + n, 0)).toBe(inWindow);

      const account = (await build<'account'>(runOf({ kind: 'account', subject: other.account, tenant: other.tenant, account: other.account, from: '2026-10-31', to: '2026-11-02', timezone: zone }))).dataset;
      expect(account.daily.map((d) => d.date)).toEqual(dates);
      expect(account.daily.map((d) => d.dials)).toEqual(expected);
      expect(account.campaigns.map((c) => c.id)).toEqual([other.campaigns[0]]); // a completed campaign, covered by its dials

      const review = (await build<'agent'>(runOf({ kind: 'agent', subject: other.agents[0]!.id, tenant: other.tenant, account: other.account, from: '2026-10-31', to: '2026-11-02', timezone: zone }))).dataset;
      expect(review.daily.map((d) => d.dials)).toEqual(expected);
      if (zone === 'America/New_York') {
        expect(end.getTime() - start.getTime()).toBe((3 * 24 + 1) * 3600_000);
        // 12:00Z Oct 31 to 12:00Z Nov 2: 16 h on Oct 31 (EDT), the 25-hour Nov 1, 7 h on Nov 2 (EST).
        expect(review.daily.map((d) => d.station_s)).toEqual([16 * 3600, 25 * 3600, 7 * 3600]);
      } else {
        // 17:30 IST Oct 31 to 17:30 IST Nov 2.
        expect(review.daily.map((d) => d.station_s)).toEqual([6.5 * 3600, 24 * 3600, 17.5 * 3600]);
      }
    });
  }
});

// ── Refusals ────────────────────────────────────────────────────────────────

describe('a subject outside the run\'s tenant or account is unavailable', () => {
  const base = { tenant: '', account: '', from: FROM, to: TO, timezone: ZONE };
  it('an agent of another tenant, a campaign of another tenant, a foreign campaign id, another account', async () => {
    const t = { ...base, tenant: floor.tenant, account: floor.account };
    await expect(build(runOf({ ...t, kind: 'agent', subject: other.agents[0]!.id }))).rejects.toBeInstanceOf(ReportSubjectUnavailableError);
    await expect(build(runOf({ ...t, kind: 'campaign', subject: other.campaigns[0]! }))).rejects.toBeInstanceOf(ReportSubjectUnavailableError);
    await expect(build(runOf({ ...t, kind: 'account', subject: floor.account, campaignIds: [floor.campaigns[0]!, other.campaigns[0]!] })))
      .rejects.toBeInstanceOf(ReportSubjectUnavailableError);
    await expect(build(runOf({ ...t, kind: 'account', subject: other.account }))).rejects.toBeInstanceOf(ReportSubjectUnavailableError);
  });

  it('a departed agent is still reviewable (any membership of the account)', async () => {
    const built = await build<'agent'>(runOf({ ...base, tenant: floor.tenant, account: floor.account, kind: 'agent', subject: agent(2).id }));
    expect(built.dataset.roster_row?.agent_user_id).toBe(agent(2).id);
  });

  it('account campaign_ids narrow the campaign rows, not the roster', async () => {
    const built = await build<'account'>(runOf({ ...base, tenant: floor.tenant, account: floor.account, kind: 'account', subject: floor.account, campaignIds: [floor.campaigns[1]!] }));
    expect(built.dataset.campaigns.map((c) => c.id)).toEqual([floor.campaigns[1]]);
    expect(built.dataset.agents.length).toBe(2);
  });
});

// ── Cursors ─────────────────────────────────────────────────────────────────

describe('detail sources release their client however the consumer stops', () => {
  async function inUse(): Promise<{ checkedOut: number; idleInTx: number }> {
    const pool = getPool();
    const { rows } = await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`);
    return { checkedOut: pool.totalCount - pool.idleCount, idleInTx: rows[0].n };
  }

  it('stopping after one row (the row cap) and throwing mid-stream both give the client back', async () => {
    const built = await build<'agent'>(runOf({ kind: 'agent', subject: agent(0).id, tenant: floor.tenant, account: floor.account, from: FROM, to: TO, timezone: ZONE }));
    for (const src of built.details) {
      const it = src.rows()[Symbol.asyncIterator]();
      const first = await it.next();
      expect(first.done).toBe(false);
      expect((await inUse()).checkedOut).toBe(1); // the cursor's client, held mid-stream
      await it.return?.();
      expect(await inUse()).toEqual({ checkedOut: 0, idleInTx: 0 });
    }
    const failing = async () => {
      for await (const _row of built.details[2]!.rows()) throw new Error('consumer failed');
    };
    await expect(failing()).rejects.toThrow('consumer failed');
    expect(await inUse()).toEqual({ checkedOut: 0, idleInTx: 0 });
  });
});
