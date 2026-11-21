import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * ─── Compare agents on real Postgres, through the real app (docs/compare-agents.md §10) ─────
 *
 * One account's campaign worked by eight agents over three local days in Asia/Kolkata, every
 * figure the read serves known from the seed (the ORACLE: `truth`): conversations by code, talk and
 * measured wrap-up, first dials, promises on all three call types (CP2), booked call-backs kept and
 * missed, breaks over their limit, shifts with calls and a break, a day off, a thin agent and a
 * departed one (CP8). The rollup is recomputed, then:
 *
 *  - every picked agent's value and the cohort's band equal the seed AND the roster screen
 *    (`GET /agents/stats?campaign_id=`) where both serve the number;
 *  - outcome sets count the rollup's conversations by code; the trend is null on a day off and the
 *    cohort median is over the agents who worked that day;
 *  - findings name the seeded clear gaps (a low success rate, a slow outcome choice, breaks over
 *    their limit) and never the thin agent beyond `too_few_calls`;
 *  - refusals: the agent role (403, CP3), the flag off, another tenant's agent and campaign, another
 *    account of the same tenant, metrics the catalog cannot serve, the window and the zone;
 *  - the guards: the per-tenant limit (429 while two reads wait on a held lock), the statement
 *    timeout (503 through the error mask), the cache (an answer and its `as_of` served again);
 *  - saved views: create, list order, the default switch, ownership 404s, the per-owner limit.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'compare-agents-secret-0123456789abcd';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import type pg from 'pg';
import {
  AGENCY_COMPARE_ERROR_STATUS,
  COMPARE_BUSY_RETRY_AFTER_SECONDS,
  COMPARE_VIEWS_PER_USER_MAX,
  compareMetricId,
  type AgencyCompareMetricRef,
  type AgencyCompareOptions,
  type AgencyCompareResponse,
  type AgencyCompareView,
} from '@magick-agency/contracts/api/agency/compare';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, CATALOG, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { bulkInsert } from '../agency/insights-rollup-world.js';
import { agencyInsightsRollupRepository } from '../../../src/db/repositories/agency.repository.js';
import { localDateOf, localInstant } from '../../../src/agency/reports/schedule.js';
import { localDates } from '../../../src/agency/reports/datasets/shared.js';

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);
const sup = (i = 0) => floor.supervisors[i]!;
const agent = (i: number) => floor.agents[i]!;

const ZONE = 'Asia/Kolkata';
const NOW = new Date();
const TODAY = localDateOf(NOW, ZONE);
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const DAYS = localDates(shiftDate(TODAY, -3), shiftDate(TODAY, -1));
const FROM = DAYS[0]!;
const TO = DAYS[2]!;
function L(date: string, hhmm: string): Date {
  const [h, m, s] = hhmm.split(':').map(Number) as [number, number, number?];
  return localInstant(ZONE, date, h * 3600 + m * 60 + (s ?? 0));
}
const plus = (d: Date, seconds: number) => new Date(d.getTime() + seconds * 1000);

/** The campaign's catalog: the floor's plus a promise code and a refusal. */
const C0_CATALOG = [
  ...CATALOG,
  { code: 'will_pay', label: 'Will pay', requires_promise: true },
  { code: 'refused', label: 'Refused to pay' },
];

// ── The seed and its truth ───────────────────────────────────────────────────

type Row = Record<string, unknown>;
const contacts: Row[] = [];
const sessions: Row[] = [];
const events: Row[] = [];
const attempts: Row[] = [];
const manual: Row[] = [];
const inbound: Row[] = [];

interface Truth {
  connected: number; successes: number; willPay: number; noOutcome: number;
  talk: number; wrapup: number; measured: number; humanConnects: number; firstDials: number;
  promises: number; amount: number; otherConversations: number;
  callbacks: { on_time: number; late: number; missed: number; pending_future: number; pending_due: number };
  breaksOver: number; shift: number; onCall: number; choosing: number; brk: number;
  willPayByDay: Map<string, number>; days: Set<string>;
}
const truth: Truth[] = [];
let c0 = '';
let c1 = '';

let phoneSeq = 0;
function contact(campaignId: string, state = 'completed'): string {
  const id = randomUUID();
  contacts.push({ id, campaign_id: campaignId, tenant_id: floor.tenant, account_id: floor.account, phone_e164: `+9197${String(phoneSeq++).padStart(8, '0')}`, context: {}, state });
  return id;
}

/** The days each agent works: agent 1 is off on the last day; agent 7 (thin) works the first only. */
const daysOf = (i: number): string[] => (i === 1 ? DAYS.slice(0, 2) : i === 7 ? DAYS.slice(0, 1) : [...DAYS]);

/** One agent's conversations on one day, by code (null: closed with no outcome). */
function codesFor(i: number, k: number): Array<string | null> {
  if (i === 7) return ['interested', 'will_pay', null, 'voicemail', 'not_interested'];
  const successes = i === 0 ? (k === 0 ? 1 : 0) : 6;
  const willPay = i === 3 ? 6 : 2;
  const out: Array<string | null> = [];
  for (let n = 0; n < successes; n++) out.push('interested');
  for (let n = 0; n < willPay; n++) out.push('will_pay');
  out.push(null, 'voicemail');
  if (i === 2 && k === 0) out.push('callback', 'callback');
  while (out.length < 14) out.push('not_interested');
  return out;
}

function seedAgent(i: number): void {
  const a = agent(i).id;
  const t: Truth = {
    connected: 0, successes: 0, willPay: 0, noOutcome: 0, talk: 0, wrapup: 0, measured: 0, humanConnects: 0, firstDials: 0,
    promises: 0, amount: 0, otherConversations: 0, callbacks: { on_time: 0, late: 0, missed: 0, pending_future: 0, pending_due: 0 },
    breaksOver: 0, shift: 0, onCall: 0, choosing: 0, brk: 0, willPayByDay: new Map(), days: new Set(),
  };
  truth[i] = t;
  daysOf(i).forEach((day) => {
    const k = DAYS.indexOf(day);
    t.days.add(day);
    const sid = randomUUID();
    const join = L(day, '09:00');
    sessions.push({ id: sid, tenant_id: floor.tenant, account_id: floor.account, campaign_id: c0, agent_user_id: a, kind: 'campaign', state: 'offline', joined_at: join, left_at: L(day, '17:00') });
    const overrun = i === 5 || (i === 4 && k === 0);
    const steps: Array<[string | null, string, Date, string | null, number | null]> = [
      [null, 'available', join, null, null],
      ['available', 'on_call', L(day, '10:00'), null, null],
      ['on_call', 'wrapup', L(day, '10:30'), null, null],
      ['wrapup', 'available', L(day, '10:35'), null, null],
      ['available', 'break', L(day, '13:00'), 'lunch', null],
      ['break', 'available', L(day, '13:30'), null, overrun ? 900 : null],
      ['available', 'offline', L(day, '17:00'), null, null],
    ];
    for (const [from, to, at, reason, over] of steps) {
      events.push({
        id: randomUUID(), session_id: sid, tenant_id: floor.tenant, account_id: floor.account, campaign_id: c0, agent_user_id: a,
        from_state: from, to_state: to, at, break_reason: reason,
        break_limit_minutes: over === null ? null : 15, break_overrun_seconds: over,
      });
    }
    if (overrun) t.breaksOver += 1;
    t.shift += 8 * 3600;
    t.onCall += 1800;
    t.choosing += 300;
    t.brk += 1800;

    codesFor(i, k).forEach((code, n) => {
      const dialed = plus(L(day, '11:00'), n * 300 + i);
      const talkS = 60 + i;
      const measured = code === null ? 30 : i === 6 ? 90 : 20 + i;
      const ended = plus(dialed, 4 + talkS);
      const callbackAt = code === 'callback' ? plus(dialed, 3600) : null;
      const cid = contact(c0);
      attempts.push({
        id: randomUUID(), campaign_id: c0, contact_id: cid, tenant_id: floor.tenant, account_id: floor.account, attempt_number: 1,
        caller_id: '+919000000001', reserved_agent_id: sid, state: 'ended', outcome: 'connected', disposition_code: code,
        dialed_at: dialed, answered_at: plus(dialed, 3), bridged_at: plus(dialed, 4), ended_at: ended, redial_number: 0,
        wrapup_started_at: ended, wrapup_ended_at: plus(ended, measured), wrapup_resolution: code === null ? 'auto_return' : 'disposition_submitted',
        callback_at: callbackAt, dispositioned_at: code === null ? null : plus(ended, measured),
        promise_date: code === 'will_pay' ? day : null, promise_amount: code === 'will_pay' ? 1000 + i : null,
      });
      t.connected += 1;
      t.talk += talkS;
      t.wrapup += measured;
      t.measured += 1;
      t.firstDials += 1;
      if (code === 'interested') t.successes += 1;
      if (code === 'will_pay') {
        t.willPay += 1;
        t.promises += 1;
        t.amount += 1000 + i;
        t.willPayByDay.set(day, (t.willPayByDay.get(day) ?? 0) + 1);
      }
      if (code === null) t.noOutcome += 1;
      if (code !== null && code !== 'voicemail') t.humanConnects += 1;
      if (code === 'callback' && callbackAt !== null) {
        if (n % 2 === 0) {
          // Kept: the contact's next dial five minutes after the booked time (no agent: not theirs).
          attempts.push({
            id: randomUUID(), campaign_id: c0, contact_id: cid, tenant_id: floor.tenant, account_id: floor.account, attempt_number: 2,
            caller_id: '+919000000001', reserved_agent_id: null, state: 'ended', outcome: 'no_answer', disposition_code: null,
            dialed_at: plus(callbackAt, 300), answered_at: null, bridged_at: null, ended_at: plus(callbackAt, 320), redial_number: 0,
            wrapup_started_at: null, wrapup_ended_at: null, wrapup_resolution: null, callback_at: null, dispositioned_at: null,
            promise_date: null, promise_amount: null,
          });
          t.callbacks.on_time += 1;
        } else {
          t.callbacks.missed += 1; // the contact closed, never dialled again
        }
      }
    });
    // Three dials that rang out: first dials, never conversations.
    if (i !== 7) {
      for (let n = 0; n < 3; n++) {
        const dialed = plus(L(day, '16:00'), n * 120 + i);
        attempts.push({
          id: randomUUID(), campaign_id: c0, contact_id: contact(c0), tenant_id: floor.tenant, account_id: floor.account, attempt_number: 1,
          caller_id: '+919000000001', reserved_agent_id: sid, state: 'ended', outcome: 'no_answer', disposition_code: null,
          dialed_at: dialed, answered_at: null, bridged_at: null, ended_at: plus(dialed, 25), redial_number: 0,
          wrapup_started_at: null, wrapup_ended_at: null, wrapup_resolution: null, callback_at: null, dispositioned_at: null,
          promise_date: null, promise_amount: null,
        });
        t.firstDials += 1;
      }
    }
  });
}

/** Agent 0's two promises outside the dialler (CP2): a soft-phone call and an inbound call on the campaign. */
function seedOtherCallTypes(): void {
  const a = agent(0).id;
  const day = DAYS[1]!;
  const sp = randomUUID();
  sessions.push({ id: sp, tenant_id: floor.tenant, account_id: floor.account, campaign_id: null, agent_user_id: a, kind: 'softphone', state: 'offline', joined_at: L(day, '17:30'), left_at: L(day, '18:00') });
  manual.push({
    id: randomUUID(), tenant_id: floor.tenant, account_id: floor.account, session_id: sp, agent_user_id: a, campaign_id: c0,
    destination_e164: '+919811110000', caller_id: '+919000000001', state: 'ended', outcome: 'connected',
    dialed_at: L(day, '17:35'), bridged_at: L(day, '17:35:10'), ended_at: L(day, '17:40'), created_at: L(day, '17:35'), settled_at: L(day, '17:41'),
    disposition_code: 'will_pay', disposition_source: 'campaign', dispositioned_at: L(day, '17:41'), promise_date: day, promise_amount: 500,
  });
  inbound.push({
    id: randomUUID(), tenant_id: floor.tenant, account_id: floor.account, provider_call_id: `pc-${randomUUID()}`,
    to_e164: '+919000000001', from_e164: '+919822220000', state: 'ended', outcome: 'answered',
    arrived_at: L(day, '15:00'), bridged_at: L(day, '15:00:20'), ended_at: L(day, '15:05'), answered_by_user_id: a,
    matched_campaign_id: c0, disposition_code: 'will_pay', disposition_source: 'campaign', dispositioned_at: L(day, '15:06'),
    promise_date: day, promise_amount: 700,
  });
  truth[0]!.promises += 2;
  truth[0]!.amount += 1200;
  truth[0]!.otherConversations += 2;
  // Agent 1's day off on this campaign is a day on the other one: still a day off here.
  const offDay = DAYS[2]!;
  const elsewhere = randomUUID();
  sessions.push({ id: elsewhere, tenant_id: floor.tenant, account_id: floor.account, campaign_id: c1, agent_user_id: agent(1).id, kind: 'campaign', state: 'offline', joined_at: L(offDay, '09:00'), left_at: L(offDay, '17:00') });
  for (const [from, to, at] of [[null, 'available', L(offDay, '09:00')], ['available', 'offline', L(offDay, '17:00')]] as const) {
    events.push({ id: randomUUID(), session_id: elsewhere, tenant_id: floor.tenant, account_id: floor.account, campaign_id: c1, agent_user_id: agent(1).id, from_state: from, to_state: to, at, break_reason: null, break_limit_minutes: null, break_overrun_seconds: null });
  }
}

// ── Requests ─────────────────────────────────────────────────────────────────

const builtin = (key: string): AgencyCompareMetricRef => ({ kind: 'builtin', key } as AgencyCompareMetricRef);
const WILL_PAY: AgencyCompareMetricRef = { kind: 'outcomes', codes: ['will_pay'], better: 'higher', label: 'Will pay' };
const WILL_PAY_ID = compareMetricId(WILL_PAY);

function body(o: Partial<{ campaign_id: string; agent_ids: string[]; metrics: AgencyCompareMetricRef[]; trend: AgencyCompareMetricRef | null; from: string; to: string; timezone: string }> = {}) {
  return {
    campaign_id: c0,
    agent_ids: [agent(0).id, agent(6).id, agent(7).id],
    metrics: [builtin('success_rate'), WILL_PAY, builtin('choose_time'), builtin('no_outcome_rate'), builtin('calls_handled'), builtin('breaks_over_limit')],
    trend: WILL_PAY,
    from: FROM,
    to: TO,
    timezone: ZONE,
    ...o,
  };
}

async function query(b: unknown, actor: Actor = sup(), f: TenantFloor = floor) {
  return call(loaded.app, 'POST', '/proxy/agency/compare/query', actor, f, b);
}
async function ok(b: unknown): Promise<AgencyCompareResponse> {
  const res = await query(b);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AgencyCompareResponse;
}
function expectRefusal(res: { statusCode: number; json: () => unknown }, code: keyof typeof AGENCY_COMPARE_ERROR_STATUS): void {
  expect(res.statusCode).toBe(AGENCY_COMPARE_ERROR_STATUS[code]);
  expect(res.json()).toMatchObject({ code, error: expect.any(String), message: expect.any(String) });
}

const roster = async () => {
  const { start, end } = { start: L(FROM, '00:00'), end: L(shiftDate(TO, 1), '00:00') };
  const res = await call(loaded.app, 'GET',
    `/proxy/agency/agents/stats?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}&campaign_id=${c0}&sort=attempts&order=desc&limit=200&include_inactive=true`,
    sup(), floor);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { rows: Array<Record<string, number | string | boolean | null>>; benchmark: Record<string, unknown> };
};

// ── Setup ────────────────────────────────────────────────────────────────────

let accountB = '';
let supB: Actor;

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other] = await seedFloor({ tenants: 2, agentsPerTenant: 8, supervisorsPerTenant: 2, campaignsPerTenant: 2, staffAgents: true }) as [TenantFloor, TenantFloor];
  [c0, c1] = floor.campaigns as [string, string];
  const created = L(shiftDate(FROM, -10), '08:00');
  await q(`UPDATE agency_campaigns SET status = 'running', started_at = $2, created_at = $2, default_timezone = $3, disposition_catalog = $4::jsonb WHERE id = $1`,
    [c0, created, ZONE, JSON.stringify(C0_CATALOG)]);
  await q(`UPDATE agency_campaigns SET status = 'running', started_at = $2, created_at = $2, default_timezone = $3 WHERE id = $1`, [c1, created, ZONE]);
  // The flag: on for the first tenant only (off by default for the other).
  await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ('agency_compare_enabled', 'tenant', $1, 'true'::jsonb)`, [floor.tenant]);

  for (let i = 0; i < 8; i++) seedAgent(i);
  seedOtherCallTypes();
  const pool = getTestPool();
  await bulkInsert(pool, 'agency_contacts', [['id', 'uuid'], ['campaign_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['phone_e164', 'text'], ['context', 'jsonb'], ['state', 'text']], contacts);
  await bulkInsert(pool, 'agency_agent_sessions', [['id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['campaign_id', 'uuid'], ['agent_user_id', 'uuid'], ['kind', 'text'], ['state', 'text'], ['joined_at', 'timestamptz'], ['left_at', 'timestamptz']], sessions);
  await bulkInsert(pool, 'agency_agent_session_events', [['id', 'uuid'], ['session_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['campaign_id', 'uuid'], ['agent_user_id', 'uuid'], ['from_state', 'text'], ['to_state', 'text'], ['at', 'timestamptz'], ['break_reason', 'text'], ['break_limit_minutes', 'smallint'], ['break_overrun_seconds', 'int']], events);
  await bulkInsert(pool, 'agency_call_attempts', [
    ['id', 'uuid'], ['campaign_id', 'uuid'], ['contact_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['attempt_number', 'int'],
    ['caller_id', 'text'], ['reserved_agent_id', 'uuid'], ['state', 'text'], ['outcome', 'text'], ['disposition_code', 'text'],
    ['dialed_at', 'timestamptz'], ['answered_at', 'timestamptz'], ['bridged_at', 'timestamptz'], ['ended_at', 'timestamptz'], ['redial_number', 'int'],
    ['wrapup_started_at', 'timestamptz'], ['wrapup_ended_at', 'timestamptz'], ['wrapup_resolution', 'text'], ['callback_at', 'timestamptz'],
    ['dispositioned_at', 'timestamptz'], ['promise_date', 'date'], ['promise_amount', 'numeric'],
  ], attempts);
  await bulkInsert(pool, 'agency_manual_calls', [
    ['id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['session_id', 'uuid'], ['agent_user_id', 'uuid'], ['campaign_id', 'uuid'],
    ['destination_e164', 'text'], ['caller_id', 'text'], ['state', 'text'], ['outcome', 'text'], ['dialed_at', 'timestamptz'], ['bridged_at', 'timestamptz'],
    ['ended_at', 'timestamptz'], ['created_at', 'timestamptz'], ['settled_at', 'timestamptz'], ['disposition_code', 'text'], ['disposition_source', 'text'],
    ['dispositioned_at', 'timestamptz'], ['promise_date', 'date'], ['promise_amount', 'numeric'],
  ], manual);
  await bulkInsert(pool, 'agency_inbound_calls', [
    ['id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['provider_call_id', 'text'], ['to_e164', 'text'], ['from_e164', 'text'],
    ['state', 'text'], ['outcome', 'text'], ['arrived_at', 'timestamptz'], ['bridged_at', 'timestamptz'], ['ended_at', 'timestamptz'],
    ['answered_by_user_id', 'uuid'], ['matched_campaign_id', 'uuid'], ['disposition_code', 'text'], ['disposition_source', 'text'],
    ['dispositioned_at', 'timestamptz'], ['promise_date', 'date'], ['promise_amount', 'numeric'],
  ], inbound);
  // Agent 4 has left the account: still in the cohort (CP8), shown as not active.
  await q(`UPDATE memberships SET status = 'revoked' WHERE user_id = $1`, [agent(4).id]);

  // A second account in the same tenant, with its own supervisor.
  accountB = randomUUID();
  await q(`INSERT INTO accounts (id, tenant_id, name, slug, settings, status) VALUES ($1, $2, 'Account B', $3, '{}', 'active')`, [accountB, floor.tenant, `acct-b-${accountB.slice(0, 8)}`]);
  const supBId = randomUUID();
  const uid = `cmp-sup-b-${supBId.slice(0, 8)}`;
  await q(`INSERT INTO users (id, firebase_uid, email, display_name, status) VALUES ($1, $2, $3, 'Supervisor B', 'active')`, [supBId, uid, `${uid}@load.example.com`]);
  await q(`INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, $4, 'account_admin', 'active')`, [randomUUID(), supBId, floor.tenant, accountB]);
  supB = { id: supBId, uid, tok: `tok:${uid}`, role: 'account_admin', ip: '10.9.200.1' };

  for (let i = 0; i < 100; i++) if ((await agencyInsightsRollupRepository.recomputeBatch(500)).picked < 500) break;
}, 180_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

// ── The oracle ───────────────────────────────────────────────────────────────

describe('every figure equals the seed and the roster screen', () => {
  let res: AgencyCompareResponse;
  let screen: Awaited<ReturnType<typeof roster>>;
  const allMetrics = [
    builtin('calls_handled'), builtin('calls_per_hour'), builtin('connect_rate'), builtin('success_rate'), builtin('avg_call'), builtin('choose_time'),
  ];
  beforeAll(async () => {
    res = await ok(body({ agent_ids: [agent(0).id, agent(1).id, agent(4).id], metrics: allMetrics, trend: null }));
    screen = await roster();
  });

  it('the cohort is the roster\'s rows for the campaign: every agent who dialled it, the departed one included', () => {
    expect(res.cohort.agents).toBe(8);
    expect(screen.rows.map((r) => r.agent_user_id).sort()).toEqual(floor.agents.map((a) => a.id).sort());
  });

  it('the roster\'s six numbers, value for value, for every picked agent', () => {
    for (const [col, i] of [[0, 0], [1, 1], [2, 4]] as const) {
      const a = res.agents[col]!;
      const t = truth[i]!;
      const row = screen.rows.find((r) => r.agent_user_id === a.agent_user_id)!;
      expect(a.agent_user_id).toBe(agent(i).id);
      expect(a.agent_name).toBe(`agent 0.${i}`);
      // calls handled: the roster's `connected`
      expect(a.values['calls_handled']).toEqual({ value: t.connected, numerator: t.connected, denominator: null, reportable: true, interval: null });
      expect(row['connected']).toBe(t.connected);
      // success: successes / connected, the roster's rate and floor
      expect(a.values['success_rate']!.numerator).toBe(t.successes);
      expect(a.values['success_rate']!.denominator).toBe(t.connected);
      expect(a.values['success_rate']!.value! * 100).toBeCloseTo(row['success_rate_pct'] as number, 9);
      expect(a.values['success_rate']!.reportable).toBe(row['success_rate_reportable']);
      // connect rate: human connects / placed first dials
      expect(a.values['connect_rate']!.numerator).toBe(t.humanConnects);
      expect(a.values['connect_rate']!.denominator).toBe(t.firstDials);
      expect(a.values['connect_rate']!.value! * 100).toBeCloseTo(row['connect_rate_pct'] as number, 9);
      expect(a.values['connect_rate']!.reportable).toBe(row['rates_reportable']);
      // average call: talk / connected
      expect(a.values['avg_call']).toMatchObject({ numerator: t.talk, denominator: t.connected, value: t.talk / t.connected });
      expect(row['talk_seconds']).toBe(t.talk);
      // choosing an outcome: measured wrap-up / measured wrap-ups
      expect(a.values['choose_time']).toMatchObject({ numerator: t.wrapup, denominator: t.measured, value: t.wrapup / t.measured, reportable: t.measured >= 20 });
      expect(row['wrapup_seconds']).toBe(t.wrapup);
      // calls per hour: connected per logged-in hour, breaks inside (CP5)
      expect(a.values['calls_per_hour']).toMatchObject({ numerator: t.connected, denominator: t.shift, reportable: true });
      expect(a.values['calls_per_hour']!.value).toBeCloseTo((t.connected / t.shift) * 3600, 9);
      expect(row['shift_seconds']).toBe(t.shift);
      // where the day went: the same shift, split
      expect(a.day_split).toEqual({ on_call: t.onCall, choosing: t.choosing, break: t.brk, waiting: t.shift - t.onCall - t.choosing - t.brk, shift_seconds: t.shift });
    }
  });

  it('the cohort band and pooled rate are the roster benchmark\'s', () => {
    const bench = screen.benchmark as { success_rate: { p25: number; median: number; p75: number }; success_rate_pct: number; aht: unknown };
    const band = res.cohort.per_metric['success_rate']!;
    expect(band.p25! * 100).toBeCloseTo(bench.success_rate.p25, 9);
    expect(band.median! * 100).toBeCloseTo(bench.success_rate.median, 9);
    expect(band.p75! * 100).toBeCloseTo(bench.success_rate.p75, 9);
    expect(band.pooled! * 100).toBeCloseTo(bench.success_rate_pct, 9);
    expect(band.agents_rated).toBe(7); // the thin agent is under the floor
    const connected = truth.reduce((s, t) => s + t.connected, 0);
    expect(res.cohort.per_metric['calls_handled']).toMatchObject({ pooled: null, agents_rated: 8 });
    expect(res.cohort.per_metric['avg_call']!.pooled).toBeCloseTo(truth.reduce((s, t) => s + t.talk, 0) / connected, 9);
  });
});

describe('outcome sets, promises, call-backs and breaks', () => {
  it('an outcome set is the rollup\'s conversations by code over all conversations; no outcome is a null code', async () => {
    const res = await ok(body({ agent_ids: [agent(0).id, agent(3).id], metrics: [WILL_PAY, builtin('no_outcome_rate')], trend: null }));
    for (const [col, i] of [[0, 0], [1, 3]] as const) {
      const t = truth[i]!;
      expect(res.agents[col]!.values[WILL_PAY_ID]).toMatchObject({ numerator: t.willPay, denominator: t.connected, value: t.willPay / t.connected, reportable: true });
      expect(res.agents[col]!.values[WILL_PAY_ID]!.interval![0]).toBeLessThan(t.willPay / t.connected);
      expect(res.agents[col]!.values['no_outcome_rate']).toMatchObject({ numerator: t.noOutcome, denominator: t.connected });
    }
    expect(res.metrics[0]).toMatchObject({ id: WILL_PAY_ID, label: 'Will pay', flaggable: true, definition: { unit: 'rate', better: 'higher' } });
  });

  it('promises count all three call types on the campaign, over their conversations (CP2); the amount carries no currency', async () => {
    const res = await ok(body({ agent_ids: [agent(0).id, agent(2).id], metrics: [builtin('promises_rate'), builtin('promised_amount')], trend: null }));
    const t0 = truth[0]!;
    expect(res.agents[0]!.values['promises_rate']).toMatchObject({ numerator: t0.promises, denominator: t0.connected + t0.otherConversations });
    expect(res.agents[0]!.values['promised_amount']).toEqual({ value: t0.amount, numerator: t0.amount, denominator: null, reportable: true, interval: null });
    expect(t0.otherConversations).toBe(2);
    const t2 = truth[2]!;
    expect(res.agents[1]!.values['promises_rate']).toMatchObject({ numerator: t2.promises, denominator: t2.connected });
  });

  it('call-backs booked and kept on time (IN4), under their own floor of 8', async () => {
    const res = await ok(body({ agent_ids: [agent(2).id, agent(0).id], metrics: [builtin('callbacks_booked'), builtin('callbacks_kept_rate')], trend: null }));
    const t = truth[2]!.callbacks;
    expect(t).toMatchObject({ on_time: 1, missed: 1 });
    expect(res.agents[0]!.values['callbacks_booked']!.value).toBe(2);
    expect(res.agents[0]!.values['callbacks_kept_rate']).toMatchObject({ numerator: 1, denominator: 2, value: 0.5, reportable: false });
    expect(res.agents[1]!.values['callbacks_kept_rate']).toMatchObject({ numerator: 0, denominator: 0, value: null, reportable: false });
  });

  it('breaks over their limit on the campaign (0060), and the finding for two or more', async () => {
    const res = await ok(body({ agent_ids: [agent(5).id, agent(4).id], metrics: [builtin('breaks_over_limit')], trend: null }));
    expect(res.agents[0]!.values['breaks_over_limit']!.value).toBe(truth[5]!.breaksOver);
    expect(res.agents[1]!.values['breaks_over_limit']!.value).toBe(1);
    expect(res.findings).toEqual([
      { code: 'over_break_limit', agent_user_id: agent(5).id, metric: 'breaks_over_limit', value: 3, baseline: null, interval: null, ratio: null, count: null, next_step: 'open_breaks' },
    ]);
  });
});

describe('the trend and the findings', () => {
  let res: AgencyCompareResponse;
  beforeAll(async () => {
    res = await ok(body({ agent_ids: [agent(0).id, agent(1).id, agent(7).id] }));
  });

  it('counts per local day; null on a day off and before the first shift; the cohort median over who worked that day', () => {
    const trend = res.trend!;
    expect(trend.metric).toBe(WILL_PAY_ID);
    expect(trend.dates).toEqual(DAYS);
    const series = (i: number) => DAYS.map((d) => (truth[i]!.days.has(d) ? truth[i]!.willPayByDay.get(d) ?? 0 : null));
    expect(trend.agents).toEqual([
      { agent_user_id: agent(0).id, counts: series(0) },
      { agent_user_id: agent(1).id, counts: series(1) },
      { agent_user_id: agent(7).id, counts: series(7) },
    ]);
    expect(trend.agents[1]!.counts[2]).toBeNull();
    // Day 0: all eight worked (2,2,2,6,2,2,2,1) → median 2. Day 2: seven worked (agent 1 off, 7 thin off).
    expect(trend.cohort_median).toEqual([2, 2, 2]);
    expect(res.trend_metric!.id).toBe(WILL_PAY_ID);
  });

  it('names the seeded clear gap, and the thin agent only as too few calls', () => {
    expect(res.findings).toContainEqual(expect.objectContaining({
      code: 'clear_gap', agent_user_id: agent(0).id, metric: 'success_rate', value: 1 / 42, count: 42, next_step: 'listen_recent',
    }));
    const thin = res.findings.filter((f) => f.agent_user_id === agent(7).id);
    expect(thin).toEqual([expect.objectContaining({ code: 'too_few_calls', metric: 'success_rate', value: 5, baseline: 20, count: 5 })]);
    expect(res.not_clear.filter((f) => f.agent_user_id === agent(7).id)).toEqual([]);
    expect(res.findings.length).toBeLessThanOrEqual(5);
  });

  it('a slow outcome choice is a time gap against the cohort median', async () => {
    const r = await ok(body({ agent_ids: [agent(6).id], metrics: [builtin('choose_time')], trend: null }));
    const f = r.findings.find((x) => x.agent_user_id === agent(6).id)!;
    expect(f).toMatchObject({ code: 'clear_gap', metric: 'choose_time', count: 42, next_step: 'message_outcome_tip' });
    expect(f.ratio!).toBeGreaterThan(1.5);
    expect(f.baseline).toBe(r.cohort.per_metric['choose_time']!.median);
  });
});

describe('options', () => {
  it('the cohort for the chips (most calls first; the departed agent not active), the catalog, promises and the starting lens', async () => {
    const res = await call(loaded.app, 'GET', `/proxy/agency/compare/options?campaign_id=${c0}&from=${FROM}&to=${TO}&timezone=${encodeURIComponent(ZONE)}`, sup(), floor);
    expect(res.statusCode, res.body).toBe(200);
    const o = res.json() as AgencyCompareOptions;
    expect(o).toMatchObject({ campaign_id: c0, campaign_name: 'Load 0.0', records_promises: true, starting_lens: 'collections' });
    expect(o.outcome_codes.map((c) => c.code)).toEqual(C0_CATALOG.map((c) => c.code));
    expect(o.outcome_codes.find((c) => c.code === 'will_pay')).toEqual({ code: 'will_pay', label: 'Will pay', is_success: false, requires_promise: true });
    expect(o.agents).toHaveLength(8);
    expect(o.agents.map((a) => a.calls)).toEqual([...o.agents.map((a) => a.calls)].sort((x, y) => y - x));
    expect(o.agents.find((a) => a.agent_user_id === agent(4).id)).toMatchObject({ active: false, calls: 42, reportable: true });
    expect(o.agents.find((a) => a.agent_user_id === agent(7).id)).toMatchObject({ active: true, calls: 5, reportable: false });
    expect(o.default_view).toBeNull();
  });

  it('a campaign without promise codes starts on Sales and refuses promise metrics', async () => {
    const res = await call(loaded.app, 'GET', `/proxy/agency/compare/options?campaign_id=${c1}&from=${FROM}&to=${TO}&timezone=${encodeURIComponent(ZONE)}`, sup(), floor);
    expect(res.json()).toMatchObject({ records_promises: false, starting_lens: 'sales', agents: [] });
    expectRefusal(await query(body({ campaign_id: c1, metrics: [builtin('promises_rate')], trend: null })), 'compare_metric_invalid');
  });
});

describe('refusals', () => {
  it('an agent gets the RBAC 403 (CP3)', async () => {
    const res = await query(body(), agent(0));
    expect(res.statusCode).toBe(403);
    const opts = await call(loaded.app, 'GET', `/proxy/agency/compare/views`, agent(0), floor);
    expect(opts.statusCode).toBe(403);
  });

  it('the flag off answers 403 feature_disabled on every route', async () => {
    const supO = other.supervisors[0]!;
    for (const [method, url] of [['POST', '/proxy/agency/compare/query'], ['GET', `/proxy/agency/compare/options?campaign_id=${other.campaigns[0]}&from=${FROM}&to=${TO}&timezone=UTC`], ['GET', '/proxy/agency/compare/views']] as const) {
      const res = await call(loaded.app, method, url, supO, other, method === 'POST' ? body({ campaign_id: other.campaigns[0]! }) : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json()).toMatchObject({ code: 'feature_disabled' });
    }
  });

  it('another tenant\'s agent is never in the cohort; another account\'s campaign is not found', async () => {
    expectRefusal(await query(body({ agent_ids: [agent(0).id, other.agents[0]!.id] })), 'compare_agent_not_in_cohort');
    expectRefusal(await query(body({ campaign_id: other.campaigns[0]! })), 'compare_campaign_not_found');
    // A supervisor of account B (same tenant) asking about account A's campaign from B.
    const fromB = await app().inject({
      method: 'POST', url: '/proxy/agency/compare/query',
      headers: { authorization: `Bearer ${supB.tok}`, 'x-tenant-id': floor.tenant, 'x-account-id': accountB, 'content-type': 'application/json' },
      payload: JSON.stringify(body()),
    });
    expectRefusal(fromB, 'compare_campaign_not_found');
    // And asking as account A, where B's supervisor has no membership.
    const asA = await app().inject({
      method: 'POST', url: '/proxy/agency/compare/query',
      headers: { authorization: `Bearer ${supB.tok}`, 'x-tenant-id': floor.tenant, 'x-account-id': floor.account, 'content-type': 'application/json' },
      payload: JSON.stringify(body()),
    });
    expect(asA.statusCode).toBe(403);
  });

  it('every compare code in the contract\'s order, and the generic 400 for a bad body', async () => {
    const { campaign_id: _c, ...noCampaign } = body();
    expectRefusal(await query(noCampaign), 'compare_campaign_required');
    expectRefusal(await query(body({ campaign_id: 'not-a-uuid' })), 'compare_campaign_not_found');
    expectRefusal(await query(body({ agent_ids: [agent(0).id, agent(1).id, agent(2).id, agent(3).id] })), 'compare_too_many_agents');
    expectRefusal(await query(body({ metrics: [...body().metrics, builtin('avg_call')] })), 'compare_too_many_metrics');
    expectRefusal(await query(body({ metrics: [{ kind: 'outcomes', codes: ['not_a_code'], better: 'higher' }] })), 'compare_metric_invalid');
    expectRefusal(await query(body({ metrics: [builtin('avg_call'), builtin('avg_call')] })), 'compare_metric_invalid');
    expectRefusal(await query(body({ trend: builtin('success_rate') })), 'compare_metric_invalid');
    expectRefusal(await query(body({ metrics: [{ kind: 'builtin', key: 'made_up' } as unknown as AgencyCompareMetricRef] })), 'compare_metric_invalid');
    expectRefusal(await query(body({ timezone: 'Mars/Olympus' })), 'compare_timezone_invalid');
    const { timezone: _t, ...noZone } = body();
    expectRefusal(await query(noZone), 'compare_timezone_invalid');
    expectRefusal(await query(body({ to: shiftDate(TODAY, 1) })), 'compare_window_invalid');
    expectRefusal(await query(body({ from: shiftDate(TO, -40) })), 'compare_window_invalid');
    expectRefusal(await query(body({ from: TO, to: FROM })), 'compare_window_invalid');
    expectRefusal(await query(body({ agent_ids: [agent(0).id, randomUUID()] })), 'compare_agent_not_in_cohort');
    for (const bad of [body({ agent_ids: [] }), body({ metrics: [] }), body({ agent_ids: [agent(0).id, agent(0).id.toUpperCase()] }), { ...body(), from: 3 }]) {
      const res = await query(bad);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'Validation Error' });
    }
  });
});

const app = () => loaded.app;

describe('the guards: per-tenant limit, statement timeout, cache', () => {
  /** Hold an exclusive lock on the attempts table from a client of the test's own. */
  async function holdAttempts(): Promise<pg.PoolClient> {
    const client = await getTestPool().connect();
    await client.query('BEGIN');
    await client.query('LOCK TABLE agency_call_attempts IN ACCESS EXCLUSIVE MODE');
    return client;
  }
  async function waitersOnLock(n: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const { rows } = await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      if ((rows[0] as { n: number }).n >= n) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`fewer than ${n} reads waited on the lock`);
  }

  it('a third read while two run is 429 compare_busy; a cached answer takes no slot; the two then answer', async () => {
    const cachedBody = body({ agent_ids: [agent(5).id], metrics: [builtin('calls_handled')], trend: null });
    const cached = await ok(cachedBody);
    const lock = await holdAttempts();
    try {
      const first = query(body({ agent_ids: [agent(0).id], from: DAYS[1]!, trend: null }));
      const second = call(loaded.app, 'GET', `/proxy/agency/compare/options?campaign_id=${c0}&from=${DAYS[2]}&to=${TO}&timezone=${encodeURIComponent(ZONE)}`, sup(), floor);
      await waitersOnLock(2);
      const third = await query(body({ agent_ids: [agent(0).id], from: DAYS[2]!, trend: null }));
      expectRefusal(third, 'compare_busy');
      // An authored 429 says when to try again (the error mask's policy).
      expect(third.headers['retry-after']).toBe(String(COMPARE_BUSY_RETRY_AFTER_SECONDS));
      expect(third.json()).toMatchObject({ retry_after_seconds: COMPARE_BUSY_RETRY_AFTER_SECONDS });
      // Both slots are held, and the cached answers are still served: the query's and the options' cohort.
      const optionsHit = await call(loaded.app, 'GET', `/proxy/agency/compare/options?campaign_id=${c0}&from=${FROM}&to=${TO}&timezone=${encodeURIComponent(ZONE)}`, sup(), floor);
      expect(optionsHit.statusCode).toBe(200);
      const hit = await query(cachedBody);
      expect(hit.statusCode).toBe(200);
      expect((hit.json() as AgencyCompareResponse).as_of).toBe(cached.as_of);
      await lock.query('ROLLBACK');
      expect((await first).statusCode).toBe(200);
      expect((await second).statusCode).toBe(200);
      // The slots came back.
      expect((await query(body({ agent_ids: [agent(0).id], from: DAYS[2]!, trend: null }))).statusCode).toBe(200);
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      lock.release();
    }
  });

  it('a client that goes away gives its slot back at once and its statement is cancelled; a read is kept while another request waits on it', async () => {
    /**
     * Exactly `n` of this database's backends waiting on a lock, within `withinMs`: well inside the
     * read's 3 s statement timeout, so a statement the timeout ends cannot pass for one cancelled.
     */
    async function lockWaitersAre(n: number, withinMs = 1000): Promise<void> {
      const deadline = Date.now() + withinMs;
      let seen = -1;
      do {
        const { rows } = await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        seen = (rows[0] as { n: number }).n;
        if (seen === n) return;
        await new Promise((r) => setTimeout(r, 20));
      } while (Date.now() < deadline);
      throw new Error(`expected ${n} lock waiters within ${withinMs} ms, saw ${seen}`);
    }
    /** A real HTTP request the test can drop mid-read, as a browser aborts a superseded fetch. */
    function droppable(method: 'GET' | 'POST', path: string, payload?: unknown): { drop: () => void; done: Promise<void> } {
      const { port } = loaded.app.server.address() as AddressInfo;
      const data = payload === undefined ? undefined : JSON.stringify(payload);
      const req = http.request({
        host: '127.0.0.1', port, method, path,
        headers: { ...headersFor(sup(), floor, data === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) }) },
      });
      const done = new Promise<void>((resolve) => { req.on('error', () => resolve()); req.on('response', (res) => { res.resume(); res.on('end', () => resolve()); }); });
      req.end(data);
      return { drop: () => req.destroy(), done };
    }
    await loaded.app.listen({ port: 0, host: '127.0.0.1' });

    const lock = await holdAttempts();
    try {
      // A query, joined by an identical one (which takes no slot), and the options read.
      const K = body({ agent_ids: [agent(1).id], from: DAYS[1]!, trend: null });
      const a = droppable('POST', '/proxy/agency/compare/query', K);
      await waitersOnLock(1);
      const joiner = droppable('POST', '/proxy/agency/compare/query', K);
      const opts = droppable('GET', `/proxy/agency/compare/options?campaign_id=${c0}&from=${DAYS[1]}&to=${TO}&timezone=${encodeURIComponent(ZONE)}`);
      await lockWaitersAre(2);
      // Two slots held: one more read is refused.
      expectRefusal(await query(body({ agent_ids: [agent(2).id], from: DAYS[2]!, trend: null })), 'compare_busy');

      // The first requester goes: the joiner still waits, so the read runs on.
      a.drop();
      await a.done;
      await new Promise((r) => setTimeout(r, 100));
      await lockWaitersAre(2);
      // The joiner and the options reader go: both statements are cancelled, both slots come back.
      const { rows: waiting } = await q(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      expect(waiting).toHaveLength(2);
      joiner.drop();
      opts.drop();
      await Promise.all([joiner.done, opts.done]);
      await lockWaitersAre(0);
      // A connection that was sent a cancel is destroyed, never handed to the next borrower: both
      // backends end (a released connection would sit idle in the pool with its pid).
      const pids = (waiting as Array<{ pid: number }>).map((r) => r.pid);
      const deadline = Date.now() + 2000;
      let alive: unknown[] = [];
      do {
        ({ rows: alive } = await q(`SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[])`, [pids]));
        if (alive.length === 0) break;
        await new Promise((r) => setTimeout(r, 20));
      } while (Date.now() < deadline);
      expect(alive).toEqual([]);
      // Still under the lock: two fresh reads both get a slot and wait; a third is refused.
      const fresh1 = query(body({ agent_ids: [agent(2).id], from: DAYS[2]!, trend: null }));
      const fresh2 = query(body({ agent_ids: [agent(3).id], from: DAYS[2]!, trend: null }));
      await lockWaitersAre(2);
      expectRefusal(await query(body({ agent_ids: [agent(4).id], from: DAYS[2]!, trend: null })), 'compare_busy');
      await lock.query('ROLLBACK');
      expect((await fresh1).statusCode).toBe(200);
      expect((await fresh2).statusCode).toBe(200);
      // The dropped read left nothing in the cache: asked again, it is read afresh and answers.
      expect((await query(K)).statusCode).toBe(200);
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      lock.release();
    }
  });

  it('a read past the statement timeout is 503 compare_timed_out, a reviewed body through the mask', async () => {
    const lock = await holdAttempts();
    try {
      const res = await query(body({ agent_ids: [agent(0).id], to: DAYS[1]!, trend: null }));
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'Service Unavailable', code: 'compare_timed_out', message: expect.stringContaining('took too long') });
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  }, 15_000);

  it('an answer is served from the cache for 30 s: the same as_of, the request\'s own label', async () => {
    const b = body({ agent_ids: [agent(2).id], metrics: [WILL_PAY], trend: null, from: DAYS[0]!, to: DAYS[0]! });
    const first = await ok(b);
    const again = await ok({ ...b, metrics: [{ ...WILL_PAY, label: 'Promised to pay' }] });
    expect(again.as_of).toBe(first.as_of);
    expect(again.agents).toEqual(first.agents);
    expect(again.metrics[0]!.label).toBe('Promised to pay');
    // Another agent order is another key: read afresh.
    const fresh = await ok({ ...b, agent_ids: [agent(3).id] });
    expect(fresh.agents[0]!.agent_user_id).toBe(agent(3).id);
  });
});

describe('saved views', () => {
  const views = '/proxy/agency/compare/views';
  const create = (actor: Actor, b: Record<string, unknown>) => call(loaded.app, 'POST', views, actor, floor, b);
  const view = (o: Record<string, unknown> = {}) => ({
    name: '  Collections morning  ', lens: 'collections', metrics: [builtin('calls_handled'), WILL_PAY], trend: WILL_PAY, campaign_id: c0, ...o,
  });

  it('create, list in the contract\'s order, and one default per campaign switched in one transaction', async () => {
    const mine = await create(sup(0), view({ shared: true, is_campaign_default: true }));
    expect(mine.statusCode, mine.body).toBe(201);
    const v0 = mine.json() as AgencyCompareView;
    expect(v0).toMatchObject({ name: 'Collections morning', shared: true, is_campaign_default: true, owner: { user_id: sup(0).id, name: 'account_admin 0.0' } });
    const theirs = (await create(sup(1), view({ name: 'Theirs', shared: true, is_campaign_default: true }))).json() as AgencyCompareView;
    const privateOne = (await create(sup(1), view({ name: 'Private', campaign_id: null, metrics: [builtin('avg_call')], trend: null }))).json() as AgencyCompareView;
    const { rows } = await q(`SELECT id, is_campaign_default FROM agency_compare_views WHERE campaign_id = $1 ORDER BY created_at`, [c0]);
    expect(rows).toEqual([{ id: v0.id, is_campaign_default: false }, { id: theirs.id, is_campaign_default: true }]);

    const list = await call(loaded.app, 'GET', `${views}?campaign_id=${c0}`, sup(0), floor);
    expect((list.json() as { views: AgencyCompareView[] }).views.map((v) => v.id)).toEqual([theirs.id, v0.id]);
    const list1 = await call(loaded.app, 'GET', views, sup(1), floor);
    expect((list1.json() as { views: AgencyCompareView[] }).views.map((v) => v.id)).toEqual([privateOne.id, theirs.id, v0.id]);

    const opts = await call(loaded.app, 'GET', `/proxy/agency/compare/options?campaign_id=${c0}&from=${FROM}&to=${TO}&timezone=${encodeURIComponent(ZONE)}`, sup(0), floor);
    expect((opts.json() as AgencyCompareOptions).default_view).toMatchObject({ id: theirs.id, owner: { user_id: sup(1).id } });

    // The owner switches the default back with an edit.
    const patched = await call(loaded.app, 'PATCH', `${views}/${v0.id}`, sup(0), floor, { is_campaign_default: true });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ id: v0.id, is_campaign_default: true, name: 'Collections morning' });
    const after = await q(`SELECT id FROM agency_compare_views WHERE campaign_id = $1 AND is_campaign_default`, [c0]);
    expect(after.rows).toEqual([{ id: v0.id }]);
  });

  it('only the owner edits or deletes: another supervisor\'s view is 404, as a missing or malformed one', async () => {
    const v = (await create(sup(0), view({ name: 'Owned', shared: true }))).json() as AgencyCompareView;
    for (const [method, id] of [['PATCH', v.id], ['DELETE', v.id]] as const) {
      expectRefusal(await call(loaded.app, method, `${views}/${id}`, sup(1), floor, method === 'PATCH' ? { name: 'Hijack' } : undefined), 'compare_view_not_found');
    }
    expectRefusal(await call(loaded.app, 'DELETE', `${views}/${randomUUID()}`, sup(0), floor), 'compare_view_not_found');
    expectRefusal(await call(loaded.app, 'DELETE', `${views}/nope`, sup(0), floor), 'compare_view_not_found');
    const del = await call(loaded.app, 'DELETE', `${views}/${v.id}`, sup(0), floor);
    expect(del.statusCode).toBe(204);
  });

  it('invalid views: codes outside the catalog, promises without promise codes, a default not shared, a bad name', async () => {
    expectRefusal(await create(sup(0), view({ metrics: [{ kind: 'outcomes', codes: ['gone'], better: 'higher' }] })), 'compare_view_invalid');
    expectRefusal(await create(sup(0), view({ campaign_id: c1, metrics: [builtin('promises_rate')], trend: null })), 'compare_view_invalid');
    expectRefusal(await create(sup(0), view({ is_campaign_default: true, shared: false })), 'compare_view_invalid');
    expectRefusal(await create(sup(0), view({ name: '   ' })), 'compare_view_invalid');
    expectRefusal(await create(sup(0), view({ trend: builtin('avg_call') })), 'compare_view_invalid');
    expectRefusal(await create(sup(0), view({ campaign_id: other.campaigns[0]! })), 'compare_campaign_not_found');
  });

  it('at most COMPARE_VIEWS_PER_USER_MAX views per supervisor in the account: 409', async () => {
    const { rows } = await q(`SELECT count(*)::int AS n FROM agency_compare_views WHERE owner_user_id = $1`, [sup(1).id]);
    const have = (rows[0] as { n: number }).n;
    for (let i = have; i < COMPARE_VIEWS_PER_USER_MAX; i++) {
      await q(`INSERT INTO agency_compare_views (tenant_id, account_id, owner_user_id, name, lens, metrics) VALUES ($1, $2, $3, $4, 'sales', '[{"kind":"builtin","key":"calls_handled"}]'::jsonb)`,
        [floor.tenant, floor.account, sup(1).id, `Filler ${i}`]);
    }
    expectRefusal(await create(sup(1), view({ name: 'One too many' })), 'compare_view_limit');
    // Another supervisor is not limited by it.
    expect((await create(sup(0), view({ name: 'Still fine' }))).statusCode).toBe(201);
  });
});
