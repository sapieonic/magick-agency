import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * ─── Team performance on real Postgres, through the real app (docs/team-performance.md §8) ─────
 *
 * One account's two campaigns over the last nine local days in Asia/Kolkata: c0 records promises
 * (Will pay), c1 does not; eight agents on c0 on four working days around a whole team's day off,
 * two of them on c1 too, one of them only before the window, a thin agent and a departed one, the
 * other call types (CP2), booked call-backs kept, missed and overdue, a night shift across local
 * midnight, and a second tenant and a second account beside it. Every figure the read serves is
 * known from the seed (`truth`), and held to the screens that already serve it (the ORACLE):
 *
 *  - every row equals the roster (`GET /agents/stats`, same scope and window) where both serve the
 *    number, and Compare (`POST /compare/query`, same campaign and window) for the main rate, the
 *    time to choose and the average call (TP2);
 *  - All campaigns: the mixed scope's main outcome is promises and `mixed` (TP8), every campaign's
 *    calls, no findings (TP7); the main outcome is decided over the campaigns worked in the window
 *    (an idle promise campaign never makes a successes day promises; a promise recorded on it does);
 *    one campaign: findings name the seeded gaps and praise, never a thin agent;
 *  - the per-day chart leaves the team's day off out and cuts days in the request's zone (a promise
 *    at 23:50 and one at 00:10 on their own local days, and on one day in UTC); a short window
 *    looks back 14 days for its working days, the team's whoever worked them;
 *  - isolation: another tenant's and another account's agents and campaigns are never in an answer,
 *    and another tenant's campaign catalog never in the main outcome;
 *  - the guards: RBAC, the flag, the statement timeout (503 through the error mask), the cache;
 *  - the promises statement plans on its 0050 indexes, on one campaign and across the account.
 *
 * `RECORD_TEAM_ANSWERS=<file>` (a path from this package's directory) also writes the one-campaign
 * and All-campaigns answers to that file, as the console's recorded answers
 * (docs/team-performance.md §8). Off by default.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'team-performance-secret-0123456789ab';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type pg from 'pg';
import type { AgencyCompareResponse } from '@magick-agency/contracts/api/agency/compare';
import type { AgencyTeamPerformance } from '@magick-agency/contracts/api/agency/team-performance';
import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, CATALOG, foreignIdsIn, foreignIdsOf, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { bulkInsert } from '../agency/insights-rollup-world.js';
import { agencyInsightsRollupRepository } from '../../../src/db/repositories/agency.repository.js';
import { teamPromisesSql } from '../../../src/db/repositories/agency/team-performance-reads.js';
import { localDateOf, localInstant } from '../../../src/agency/reports/schedule.js';

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
let dark: TenantFloor;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);
const sup = () => floor.supervisors[0]!;
const agent = (i: number) => floor.agents[i]!;

const ZONE = 'Asia/Kolkata';
/** The seed's anchor: today when the file loaded. The seed is laid out relative to it. */
const TODAY = localDateOf(new Date(), ZONE);
/** Today now, for a test about the window's end: the run can cross local midnight after the seed. */
const today = () => localDateOf(new Date(), ZONE);
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const T = (n: number) => shiftDate(TODAY, -n);
/** The working days in the window; T-3 is the whole team's day off. */
const WORK = [T(5), T(4), T(2), T(1)];
const FROM = T(5);
const TO = T(1);
/** A day before the window that a short window's chart still reaches (TP12). */
const EARLIER = T(9);
/** The other tenant's days with work on its success-only campaign alone (TP8, the campaigns worked decide). */
const OTHER_SUCCESS_DAY = T(12);
const OTHER_MIXED_DAY = T(11);
function L(date: string, hhmm: string): Date {
  const [h, m, s] = hhmm.split(':').map(Number) as [number, number, number?];
  return localInstant(ZONE, date, h * 3600 + m * 60 + (s ?? 0));
}
const plus = (d: Date, seconds: number) => new Date(d.getTime() + seconds * 1000);

const C0_CATALOG = [...CATALOG, { code: 'will_pay', label: 'Will pay', requires_promise: true }, { code: 'refused', label: 'Refused to pay' }];

// ── The seed and its truth ───────────────────────────────────────────────────

type Row = Record<string, unknown>;
const contacts: Row[] = [];
const sessions: Row[] = [];
const events: Row[] = [];
const attempts: Row[] = [];
const manual: Row[] = [];
const inbound: Row[] = [];

interface Truth { connected: number; successes: number; promises: number; other: number; talk: number; wrapup: number; measured: number; shift: number; brk: number }
const zero = (): Truth => ({ connected: 0, successes: 0, promises: 0, other: 0, talk: 0, wrapup: 0, measured: 0, shift: 0, brk: 0 });
/** Per campaign (`c0`, `c1`), per agent index: in the window. */
const truth = { c0: new Map<number, Truth>(), c1: new Map<number, Truth>() };
const tOf = (c: 'c0' | 'c1', i: number): Truth => { const t = truth[c].get(i) ?? zero(); truth[c].set(i, t); return t; };
/** The team's promises on c0 per local day (Asia/Kolkata), every call type, the earlier day included. */
const promisesByDay = new Map<string, number>();
/** Conversations in the window by campaign and code (null: no outcome chosen). */
const codes = { c0: new Map<string | null, number>(), c1: new Map<string | null, number>() };
let c0 = '';
let c1 = '';

let phoneSeq = 0;
function contact(f: TenantFloor, campaignId: string, state = 'completed'): string {
  const id = randomUUID();
  contacts.push({ id, campaign_id: campaignId, tenant_id: f.tenant, account_id: f.account, phone_e164: `+9196${String(phoneSeq++).padStart(8, '0')}`, context: {}, state });
  return id;
}

/** A campaign session from `join` to `leave` with a 30-minute break at 13:00 when `brk`. */
function session(f: TenantFloor, campaignId: string, agentId: string, join: Date, leave: Date, brk: Date | null): string {
  const id = randomUUID();
  sessions.push({ id, tenant_id: f.tenant, account_id: f.account, campaign_id: campaignId, agent_user_id: agentId, kind: 'campaign', state: 'offline', joined_at: join, left_at: leave });
  const steps: Array<[string | null, string, Date]> = [[null, 'available', join]];
  if (brk) steps.push(['available', 'break', brk], ['break', 'available', plus(brk, 1800)]);
  steps.push(['available', 'offline', leave]);
  for (const [from, to, at] of steps) {
    events.push({ id: randomUUID(), session_id: id, tenant_id: f.tenant, account_id: f.account, campaign_id: campaignId, agent_user_id: agentId, from_state: from, to_state: to, at });
  }
  return id;
}

interface Conversation { code: string | null; dialed: Date; talk: number; measured: number; callbackAt?: Date | null; contactState?: string }
function conversation(f: TenantFloor, campaignId: string, sid: string, c: Conversation): { contactId: string; attempt: Row } {
  const contactId = contact(f, campaignId, c.contactState);
  const ended = plus(c.dialed, 4 + c.talk);
  const attempt: Row = {
    id: randomUUID(), campaign_id: campaignId, contact_id: contactId, tenant_id: f.tenant, account_id: f.account, attempt_number: 1,
    caller_id: '+919000000001', reserved_agent_id: sid, state: 'ended', outcome: 'connected', disposition_code: c.code,
    dialed_at: c.dialed, answered_at: plus(c.dialed, 3), bridged_at: plus(c.dialed, 4), ended_at: ended, redial_number: 0,
    wrapup_started_at: ended, wrapup_ended_at: plus(ended, c.measured), wrapup_resolution: c.code === null ? 'auto_return' : 'disposition_submitted',
    callback_at: c.callbackAt ?? null, dispositioned_at: c.code === null ? null : plus(ended, c.measured),
    promise_date: c.code === 'will_pay' || c.code === 'promised' ? c.dialed.toISOString().slice(0, 10) : null,
    promise_amount: c.code === 'will_pay' ? 1000 : null,
  };
  attempts.push(attempt);
  return { contactId, attempt };
}

/** A dial that rang out: an attempt, never a conversation. */
function ringOut(f: TenantFloor, campaignId: string, sid: string, dialed: Date): void {
  attempts.push({
    id: randomUUID(), campaign_id: campaignId, contact_id: contact(f, campaignId), tenant_id: f.tenant, account_id: f.account, attempt_number: 1,
    caller_id: '+919000000001', reserved_agent_id: sid, state: 'ended', outcome: 'no_answer', disposition_code: null,
    dialed_at: dialed, answered_at: null, bridged_at: null, ended_at: plus(dialed, 25), redial_number: 0,
    wrapup_started_at: null, wrapup_ended_at: null, wrapup_resolution: null, callback_at: null, dispositioned_at: null, promise_date: null, promise_amount: null,
  });
}

/** One agent's c0 outcomes on one working day (8 conversations; the thin agent 5). */
function c0Codes(i: number, k: number): Array<string | null> {
  if (i === 7) return ['interested', 'will_pay', null, 'voicemail', 'not_interested'];
  if (i === 0) return ['interested', 'interested', 'not_interested', null, 'voicemail', 'not_interested', 'not_interested', 'no_disposition'];
  if (i === 3) return ['interested', 'will_pay', 'will_pay', 'will_pay', 'will_pay', null, 'voicemail', 'not_interested'];
  if (i === 2 && k === 0) return ['interested', 'interested', 'will_pay', null, 'voicemail', 'callback', 'callback', 'callback'];
  return ['interested', 'interested', 'will_pay', null, 'voicemail', 'not_interested', 'not_interested', 'not_interested'];
}

/** Call-backs agent 2 books on the first day: one kept on time, one missed (contact closed), one overdue. */
let callbackSeq = 0;
function seedC0Day(i: number, day: string, k: number, inWindow: boolean): void {
  const a = agent(i).id;
  const sid = session(floor, c0, a, L(day, '09:00'), L(day, '17:00'), L(day, '13:00'));
  const t = inWindow ? tOf('c0', i) : null;
  if (t) { t.shift += 8 * 3600; t.brk += 1800; }
  c0Codes(i, k).forEach((code, n) => {
    const dialed = plus(L(day, '11:00'), n * 300 + i);
    const talk = 60 + i;
    const measured = code === null || code === 'no_disposition' ? 30 : i === 6 ? 90 : 20 + i;
    const callbackAt = code === 'callback' ? plus(dialed, 3600) : null;
    const which = code === 'callback' ? callbackSeq++ : -1;
    const { contactId } = conversation(floor, c0, sid, { code, dialed, talk, measured, callbackAt, contactState: which === 2 ? 'pending' : 'completed' });
    if (which === 0) {
      // Kept: the contact's next dial five minutes after the booked time (no agent: not theirs).
      attempts.push({
        id: randomUUID(), campaign_id: c0, contact_id: contactId, tenant_id: floor.tenant, account_id: floor.account, attempt_number: 2,
        caller_id: '+919000000001', reserved_agent_id: null, state: 'ended', outcome: 'no_answer', disposition_code: null,
        dialed_at: plus(callbackAt!, 300), answered_at: null, bridged_at: null, ended_at: plus(callbackAt!, 320), redial_number: 0,
        wrapup_started_at: null, wrapup_ended_at: null, wrapup_resolution: null, callback_at: null, dispositioned_at: null, promise_date: null, promise_amount: null,
      });
    }
    if (code === 'will_pay') promisesByDay.set(day, (promisesByDay.get(day) ?? 0) + 1);
    if (!t) return;
    t.connected += 1; t.talk += talk; t.wrapup += measured; t.measured += 1;
    if (code === 'interested') t.successes += 1;
    if (code === 'will_pay') t.promises += 1;
    const bar = code === 'no_disposition' ? null : code;
    codes.c0.set(bar, (codes.c0.get(bar) ?? 0) + 1);
  });
  if (i !== 7) for (let n = 0; n < 2; n++) ringOut(floor, c0, sid, plus(L(day, '16:00'), n * 120 + i));
}

function seed(): void {
  for (let i = 0; i < 8; i++) {
    const days = i === 7 ? WORK.slice(0, 1) : WORK;
    days.forEach((day) => seedC0Day(i, day, WORK.indexOf(day), true));
  }
  // Before the window: agent 3 works c0 on an earlier day (the short window's chart reaches it).
  seedC0Day(3, EARLIER, 9, false);

  // Agent 2's night shift across local midnight: a promise at 23:50 on the first day, one at 00:10 on the second.
  const night = session(floor, c0, agent(2).id, L(WORK[0]!, '23:00'), L(WORK[1]!, '01:00'), null);
  const t2 = tOf('c0', 2);
  t2.shift += 2 * 3600;
  for (const [at, day] of [[L(WORK[0]!, '23:50'), WORK[0]!], [L(WORK[1]!, '00:10'), WORK[1]!]] as const) {
    conversation(floor, c0, night, { code: 'will_pay', dialed: at, talk: 62, measured: 22 });
    t2.connected += 1; t2.talk += 62; t2.wrapup += 22; t2.measured += 1; t2.promises += 1;
    promisesByDay.set(day, (promisesByDay.get(day) ?? 0) + 1);
    codes.c0.set('will_pay', (codes.c0.get('will_pay') ?? 0) + 1);
  }

  // Agents 1 and 5 on c1 one evening (it records no promises): six conversations each.
  for (const i of [1, 5]) {
    const day = WORK[2]!;
    const sid = session(floor, c1, agent(i).id, L(day, '18:00'), L(day, '20:00'), null);
    const t = tOf('c1', i);
    t.shift += 2 * 3600;
    (['interested', 'interested', 'interested', 'not_interested', 'not_interested', 'voicemail'] as const).forEach((code, n) => {
      conversation(floor, c1, sid, { code, dialed: plus(L(day, '18:30'), n * 300 + i), talk: 50, measured: 25 });
      t.connected += 1; t.talk += 50; t.wrapup += 25; t.measured += 1;
      if (code === 'interested') t.successes += 1;
      codes.c1.set(code, (codes.c1.get(code) ?? 0) + 1);
    });
  }

  // Agent 0's other call types on c0 (CP2): a soft-phone promise and an inbound one; and a soft-phone
  // conversation on no campaign, in neither scope.
  const day = WORK[2]!;
  const a0 = agent(0).id;
  const sp = randomUUID();
  sessions.push({ id: sp, tenant_id: floor.tenant, account_id: floor.account, campaign_id: null, agent_user_id: a0, kind: 'softphone', state: 'offline', joined_at: L(day, '17:30'), left_at: L(day, '18:00') });
  for (const [campaignId, code] of [[c0, 'will_pay'], [null, null]] as const) {
    manual.push({
      id: randomUUID(), tenant_id: floor.tenant, account_id: floor.account, session_id: sp, agent_user_id: a0, campaign_id: campaignId,
      destination_e164: '+919811110000', caller_id: '+919000000001', state: 'ended', outcome: 'connected',
      dialed_at: L(day, '17:35'), bridged_at: L(day, '17:35:10'), ended_at: L(day, '17:40'), created_at: L(day, '17:35'), settled_at: L(day, '17:41'),
      disposition_code: code, disposition_source: code === null ? null : 'campaign', dispositioned_at: code === null ? null : L(day, '17:41'), promise_date: code === null ? null : day, promise_amount: code === null ? null : 500,
    });
  }
  inbound.push({
    id: randomUUID(), tenant_id: floor.tenant, account_id: floor.account, provider_call_id: `pc-${randomUUID()}`,
    to_e164: '+919000000001', from_e164: '+919822220000', state: 'ended', outcome: 'answered',
    arrived_at: L(day, '15:00'), bridged_at: L(day, '15:00:20'), ended_at: L(day, '15:05'), answered_by_user_id: a0,
    matched_campaign_id: c0, disposition_code: 'will_pay', disposition_source: 'campaign', dispositioned_at: L(day, '15:06'), promise_date: day, promise_amount: 700,
  });
  const t0 = tOf('c0', 0);
  t0.promises += 2; t0.other += 2;
  promisesByDay.set(day, (promisesByDay.get(day) ?? 0) + 2);

  // The supervisor's own soft-phone promise on c0 (TP14): no dialler call, so no row and not in the
  // tiles, which sum the rows; the per-day chart is the whole team's, so it counts there.
  const s = sup().id;
  const ssp = randomUUID();
  sessions.push({ id: ssp, tenant_id: floor.tenant, account_id: floor.account, campaign_id: null, agent_user_id: s, kind: 'softphone', state: 'offline', joined_at: L(day, '16:00'), left_at: L(day, '16:30') });
  manual.push({
    id: randomUUID(), tenant_id: floor.tenant, account_id: floor.account, session_id: ssp, agent_user_id: s, campaign_id: c0,
    destination_e164: '+919811110001', caller_id: '+919000000001', state: 'ended', outcome: 'connected',
    dialed_at: L(day, '16:05'), bridged_at: L(day, '16:05:10'), ended_at: L(day, '16:10'), created_at: L(day, '16:05'), settled_at: L(day, '16:11'),
    disposition_code: 'will_pay', disposition_source: 'campaign', dispositioned_at: L(day, '16:11'), promise_date: day, promise_amount: 300,
  });
  promisesByDay.set(day, (promisesByDay.get(day) ?? 0) + 1);

  // The other tenant: one agent's evening on its own campaign, whose catalog records promises under another label.
  const o = other.agents[0]!.id;
  const osid = session(other, other.campaigns[0]!, o, L(day, '09:00'), L(day, '12:00'), null);
  for (let n = 0; n < 5; n++) conversation(other, other.campaigns[0]!, osid, { code: 'promised', dialed: plus(L(day, '10:00'), n * 300), talk: 40, measured: 20 });

  // The other tenant's second campaign records no promises (the default catalog's codes). Its agent
  // dials it alone on two days; on the second, a soft-phone promise is recorded on the promise
  // campaign, which has no dialler call that day (TP8: the campaigns worked in the window decide).
  const o1 = other.agents[1]!.id;
  for (const d of [OTHER_SUCCESS_DAY, OTHER_MIXED_DAY]) {
    const sid = session(other, other.campaigns[1]!, o1, L(d, '09:00'), L(d, '12:00'), null);
    for (let n = 0; n < 4; n++) conversation(other, other.campaigns[1]!, sid, { code: n === 0 ? 'interested' : 'not_interested', dialed: plus(L(d, '10:00'), n * 300), talk: 40, measured: 20 });
  }
  const osp = randomUUID();
  sessions.push({ id: osp, tenant_id: other.tenant, account_id: other.account, campaign_id: null, agent_user_id: o1, kind: 'softphone', state: 'offline', joined_at: L(OTHER_MIXED_DAY, '13:00'), left_at: L(OTHER_MIXED_DAY, '13:30') });
  manual.push({
    id: randomUUID(), tenant_id: other.tenant, account_id: other.account, session_id: osp, agent_user_id: o1, campaign_id: other.campaigns[0]!,
    destination_e164: '+919811110002', caller_id: '+919000000001', state: 'ended', outcome: 'connected',
    dialed_at: L(OTHER_MIXED_DAY, '13:05'), bridged_at: L(OTHER_MIXED_DAY, '13:05:10'), ended_at: L(OTHER_MIXED_DAY, '13:10'), created_at: L(OTHER_MIXED_DAY, '13:05'), settled_at: L(OTHER_MIXED_DAY, '13:11'),
    disposition_code: 'promised', disposition_source: 'campaign', dispositioned_at: L(OTHER_MIXED_DAY, '13:11'), promise_date: OTHER_MIXED_DAY, promise_amount: 400,
  });
}

/** The call-backs agent 2 booked on c0 (IN4): one kept on time, one missed, one overdue. */
const CALLBACKS = { due: 3, on_time: 1, late: 0, missed: 1, pending_due: 1, upcoming: 0 };

// ── Requests ─────────────────────────────────────────────────────────────────

function url(o: { campaign_id?: string; from?: string; to?: string; timezone?: string } = {}): string {
  const p = new URLSearchParams({ from: o.from ?? FROM, to: o.to ?? TO, timezone: o.timezone ?? ZONE });
  if (o.campaign_id) p.set('campaign_id', o.campaign_id);
  return `/proxy/agency/team-performance?${p}`;
}
async function team(o: Parameters<typeof url>[0] = {}, actor: Actor = sup(), f: TenantFloor = floor): Promise<AgencyTeamPerformance> {
  const res = await call(loaded.app, 'GET', url(o), actor, f);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return res.json() as AgencyTeamPerformance;
}
async function roster(campaignId?: string) {
  const start = L(FROM, '00:00');
  const end = L(shiftDate(TO, 1), '00:00');
  const res = await call(loaded.app, 'GET',
    `/proxy/agency/agents/stats?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}${campaignId ? `&campaign_id=${campaignId}` : ''}&sort=attempts&order=desc&limit=200&include_inactive=true`,
    sup(), floor);
  expect(res.statusCode, res.body).toBe(200);
  return new Map((res.json() as { rows: Array<Record<string, number | string | boolean | null>> }).rows.map((r) => [r['agent_user_id'] as string, r]));
}
async function compare(campaignId: string, agentIds: string[], keys: string[]): Promise<AgencyCompareResponse> {
  const res = await call(loaded.app, 'POST', '/proxy/agency/compare/query', sup(), floor, {
    campaign_id: campaignId, agent_ids: agentIds, metrics: keys.map((key) => ({ kind: 'builtin', key })), from: FROM, to: TO, timezone: ZONE,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AgencyCompareResponse;
}
const rowOf = (a: AgencyTeamPerformance, i: number) => a.agents.find((r) => r.agent_user_id === agent(i).id)!;

// ── Setup ────────────────────────────────────────────────────────────────────

let accountB = '';
let supB: Actor;

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other, dark] = await seedFloor({ tenants: 3, agentsPerTenant: 8, supervisorsPerTenant: 1, campaignsPerTenant: 2, staffAgents: true }) as [TenantFloor, TenantFloor, TenantFloor];
  [c0, c1] = floor.campaigns as [string, string];
  const created = L(shiftDate(EARLIER, -5), '08:00');
  await q(`UPDATE agency_campaigns SET status = 'running', started_at = $2, created_at = $2, default_timezone = $3, disposition_catalog = $4::jsonb, wrapup_seconds = 30 WHERE id = $1`,
    [c0, created, ZONE, JSON.stringify(C0_CATALOG)]);
  await q(`UPDATE agency_campaigns SET status = 'running', started_at = $2, created_at = $2, default_timezone = $3, wrapup_seconds = 45 WHERE id = $1`, [c1, created, ZONE]);
  await q(`UPDATE agency_campaigns SET status = 'running', started_at = $2, created_at = $2, default_timezone = $3, disposition_catalog = $4::jsonb WHERE id = $1`,
    [other.campaigns[0], created, ZONE, JSON.stringify([...CATALOG, { code: 'promised', label: 'Promised (other)', requires_promise: true }])]);
  for (const [key, tenant] of [['agency_team_performance_enabled', floor.tenant], ['agency_team_performance_enabled', other.tenant], ['agency_compare_enabled', floor.tenant]] as const) {
    await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ($1, 'tenant', $2, 'true'::jsonb)`, [key, tenant]);
  }

  seed();
  const pool = getTestPool();
  await bulkInsert(pool, 'agency_contacts', [['id', 'uuid'], ['campaign_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['phone_e164', 'text'], ['context', 'jsonb'], ['state', 'text']], contacts);
  await bulkInsert(pool, 'agency_agent_sessions', [['id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['campaign_id', 'uuid'], ['agent_user_id', 'uuid'], ['kind', 'text'], ['state', 'text'], ['joined_at', 'timestamptz'], ['left_at', 'timestamptz']], sessions);
  await bulkInsert(pool, 'agency_agent_session_events', [['id', 'uuid'], ['session_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['campaign_id', 'uuid'], ['agent_user_id', 'uuid'], ['from_state', 'text'], ['to_state', 'text'], ['at', 'timestamptz']], events);
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
  // Agent 4 has left the account: still a row (TP5), flagged.
  await q(`UPDATE memberships SET status = 'revoked' WHERE user_id = $1`, [agent(4).id]);

  // A second account in the same tenant, with its own supervisor and nothing dialled.
  accountB = randomUUID();
  await q(`INSERT INTO accounts (id, tenant_id, name, slug, settings, status) VALUES ($1, $2, 'Account B', $3, '{}', 'active')`, [accountB, floor.tenant, `acct-b-${accountB.slice(0, 8)}`]);
  const supBId = randomUUID();
  const uid = `team-sup-b-${supBId.slice(0, 8)}`;
  await q(`INSERT INTO users (id, firebase_uid, email, display_name, status) VALUES ($1, $2, $3, 'Supervisor B', 'active')`, [supBId, uid, `${uid}@load.example.com`]);
  await q(`INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, $4, 'account_admin', 'active')`, [randomUUID(), supBId, floor.tenant, accountB]);
  supB = { id: supBId, uid, tok: `tok:${uid}`, role: 'account_admin', ip: '10.9.201.1' };

  for (let i = 0; i < 100; i++) if ((await agencyInsightsRollupRepository.recomputeBatch(500)).picked < 500) break;
}, 180_000);

afterAll(async () => {
  await stopLoadApp(loaded);
});

// ── One campaign ─────────────────────────────────────────────────────────────

describe('one campaign: every figure equals the seed, the roster and Compare', () => {
  let a: AgencyTeamPerformance;
  beforeAll(async () => { a = await team({ campaign_id: c0 }); });

  it('the cohort is who dialled the campaign in the window, a departed agent kept and flagged (TP5)', () => {
    expect(a.agents.map((r) => r.agent_user_id).sort()).toEqual(floor.agents.map((x) => x.id).sort());
    expect(a.agents.filter((r) => r.departed).map((r) => r.agent_user_id)).toEqual([agent(4).id]);
    expect(rowOf(a, 0).agent_name).toBe('agent 0.0');
    expect(a).toMatchObject({ campaign_id: c0, from: FROM, to: TO, timezone: ZONE, comparable: true });
    // One campaign recording promises: never mixed.
    expect(a.main_outcome).toEqual({ kind: 'promises', codes: ['will_pay'], label: 'Will pay', mixed: false });
    expect(a.totals.wrapup_allowed).toEqual({ seconds: 30, varies: false });
    expect(a.rollup_as_of).not.toBeNull();
  });

  it('each row is the seed\'s, and the roster screen\'s where it serves the number', async () => {
    const screen = await roster(c0);
    for (let i = 0; i < 8; i++) {
      const t = truth.c0.get(i)!;
      const r = rowOf(a, i);
      const s = screen.get(agent(i).id)!;
      expect(r, `agent ${i}`).toMatchObject({
        calls_handled: t.connected, talk_seconds: t.talk, wrapup_seconds: t.wrapup, measured_wrapups: t.measured,
        shift_seconds: t.shift, break_seconds: t.brk, avg_call_seconds: t.talk / t.connected,
      });
      expect(r.main, `agent ${i}`).toMatchObject({ numerator: t.promises, denominator: t.connected + t.other });
      for (const [col, key] of [['calls_handled', 'connected'], ['talk_seconds', 'talk_seconds'], ['wrapup_seconds', 'wrapup_seconds'], ['shift_seconds', 'shift_seconds'], ['break_seconds', 'break_seconds']] as const) {
        expect(r[col], `agent ${i} ${col}`).toBe(s[key]);
      }
    }
  });

  it('the main rate, the time to choose and the average call are Compare\'s values for the same agents (TP2)', async () => {
    const ids = floor.agents.map((x) => x.id);
    for (let k = 0; k < ids.length; k += 3) {
      const c = await compare(c0, ids.slice(k, k + 3), ['promises_rate', 'choose_time', 'avg_call']);
      for (const ca of c.agents) {
        const r = a.agents.find((x) => x.agent_user_id === ca.agent_user_id)!;
        expect(r.main).toEqual(ca.values['promises_rate']);
        expect(r.choose).toEqual(ca.values['choose_time']);
        expect(r.avg_call_seconds).toBe(ca.values['avg_call']!.value);
      }
    }
  });

  it('the totals are the rows\' sums; the other call types are named; the call-backs are IN4\'s (TP10)', () => {
    const all = [...truth.c0.values()];
    const sum = (f: (t: Truth) => number) => all.reduce((s, t) => s + f(t), 0);
    expect(a.totals).toMatchObject({
      agents: 8, calls_handled: sum((t) => t.connected), other_conversations: 2,
      avg_call_seconds: sum((t) => t.talk) / sum((t) => t.connected), choose_seconds: sum((t) => t.wrapup) / sum((t) => t.measured),
      callbacks: CALLBACKS,
    });
    expect(a.totals.main).toMatchObject({ numerator: sum((t) => t.promises), denominator: sum((t) => t.connected + t.other), reportable: true });
    expect(a.medians.calls_handled).not.toBeNull();
  });

  it('an agent with no dialler call has no row and is not in the tiles, but is in the whole team\'s per-day chart (TP14)', () => {
    expect(a.agents.some((r) => r.agent_user_id === sup().id)).toBe(false);
    const rowSum = (f: (r: AgencyTeamPerformance['agents'][number]) => number) => a.agents.reduce((n, r) => n + f(r), 0);
    expect(a.totals.main.numerator).toBe(rowSum((r) => r.main.numerator));
    expect(a.totals.main.denominator).toBe(rowSum((r) => r.main.denominator ?? 0));
    const inWindow = a.trend.dates.reduce((n, d, k) => (d >= FROM && d <= TO ? n + a.trend.counts[k]! : n), 0);
    expect(inWindow).toBe(a.totals.main.numerator + 1);
  });

  it('what happened on the calls: the rollup\'s conversations by code, labelled from the catalog (TP13)', () => {
    const expected = [...codes.c0].map(([code, conversations]) => ({ code, conversations }))
      .sort((x, y) => y.conversations - x.conversations || (x.code === null ? 1 : 0) - (y.code === null ? 1 : 0) || (x.code ?? '').localeCompare(y.code ?? ''));
    expect(a.outcomes.map(({ code, conversations }) => ({ code, conversations }))).toEqual(expected);
    expect(a.outcomes.find((o) => o.code === 'will_pay')).toMatchObject({ label: 'Will pay' });
    expect(a.outcomes.find((o) => o.code === null)).toMatchObject({ label: null, icon: null });
  });

  it('worth a look names the seeded gaps and praise, never the thin agent (TP15)', () => {
    expect(a.findings.map((f) => [f.code, f.agent_user_id, f.metric]).sort()).toEqual([
      ['clear_gap', agent(0).id, 'promises_rate'],
      ['clear_gap', agent(6).id, 'choose_time'],
      ['stands_out', agent(3).id, 'promises_rate'],
    ].sort());
    expect(a.findings.some((f) => f.agent_user_id === agent(7).id)).toBe(false);
    expect(rowOf(a, 7).main).toMatchObject({ reportable: false, withheld: 'too_few' });
  });

  it('the per-day chart: a short window\'s last working days, the team\'s day off left out, promises by local day (TP12)', () => {
    expect(a.trend.span).toBe('last_working_days');
    expect(a.trend.dates).toEqual([EARLIER, ...WORK]);
    expect(a.trend.dates).not.toContain(T(3));
    expect(a.trend.counts).toEqual(a.trend.dates.map((d) => promisesByDay.get(d) ?? 0));
  });

  it('a window of 7 days or more holds every working day of it, and no day off', async () => {
    const w = await team({ campaign_id: c0, from: EARLIER });
    expect(w.trend).toEqual({ span: 'window', dates: [EARLIER, ...WORK], counts: [EARLIER, ...WORK].map((d) => promisesByDay.get(d) ?? 0) });
  });

  it('days are cut in the request\'s zone: in UTC the 00:10 promise is the evening before', async () => {
    const utc = await team({ campaign_id: c0, timezone: 'UTC' });
    const ist = (d: string) => promisesByDay.get(d) ?? 0;
    const on = (x: AgencyTeamPerformance, d: string) => x.trend.counts[x.trend.dates.indexOf(d)];
    expect(on(utc, WORK[0]!)).toBe(ist(WORK[0]!) + 1);
    expect(on(utc, WORK[1]!)).toBe(ist(WORK[1]!) - 1);
  });

  it('a campaign without promises is successes: Compare\'s success rate, no other conversations', async () => {
    const s = await team({ campaign_id: c1 });
    expect(s.main_outcome).toEqual({ kind: 'successes', codes: ['interested'], label: 'Interested', mixed: false });
    expect(s.agents.map((r) => r.agent_user_id).sort()).toEqual([agent(1).id, agent(5).id].sort());
    const c = await compare(c1, [agent(1).id, agent(5).id], ['success_rate']);
    for (const ca of c.agents) expect(s.agents.find((r) => r.agent_user_id === ca.agent_user_id)!.main).toEqual(ca.values['success_rate']);
    expect(s.totals).toMatchObject({ other_conversations: 0, wrapup_allowed: { seconds: 45, varies: false }, callbacks: { due: 0 } });
    expect(s.trend.dates).toEqual([WORK[2]]);
    expect(s.trend.counts).toEqual([6]);
  });
});

// ── All campaigns ────────────────────────────────────────────────────────────

describe('All campaigns', () => {
  let a: AgencyTeamPerformance;
  beforeAll(async () => { a = await team(); });

  it('a mixed scope is promises and says so (TP8); the allowed time differs; nobody is compared (TP7)', () => {
    expect(a).toMatchObject({ campaign_id: null, comparable: false, findings: [] });
    // c1 had conversations in the window and records no promises: mixed.
    expect(a.main_outcome).toEqual({ kind: 'promises', codes: ['will_pay'], label: 'Will pay', mixed: true });
    expect(a.totals.wrapup_allowed).toEqual({ seconds: null, varies: true });
  });

  it('the per-day chart is the team\'s promises by local day, this tenant\'s and account\'s only (TP12)', () => {
    // The other tenant's promises fall on WORK[2] and on its own days: never here.
    expect(a.trend).toEqual({ span: 'last_working_days', dates: [EARLIER, ...WORK], counts: [EARLIER, ...WORK].map((d) => promisesByDay.get(d) ?? 0) });
  });

  it('rollup_as_of is the newest rollup change of the campaigns with calls in the window', async () => {
    const one = await Promise.all([team({ campaign_id: c0 }), team({ campaign_id: c1 })]);
    const newest = one.map((x) => x.rollup_as_of!).sort().at(-1);
    expect(a.rollup_as_of).toBe(newest);
  });

  it('each row is every campaign\'s work: the roster without a campaign, the promises over every conversation', async () => {
    const screen = await roster();
    for (let i = 0; i < 8; i++) {
      const t0 = truth.c0.get(i)!;
      const t1 = truth.c1.get(i) ?? zero();
      const r = rowOf(a, i);
      const s = screen.get(agent(i).id)!;
      expect(r.calls_handled, `agent ${i}`).toBe(t0.connected + t1.connected);
      for (const [col, key] of [['calls_handled', 'connected'], ['talk_seconds', 'talk_seconds'], ['wrapup_seconds', 'wrapup_seconds'], ['shift_seconds', 'shift_seconds'], ['break_seconds', 'break_seconds']] as const) {
        expect(r[col], `agent ${i} ${col}`).toBe(s[key]);
      }
      // A soft-phone call on no campaign is in neither scope.
      expect(r.main, `agent ${i}`).toMatchObject({ numerator: t0.promises, denominator: t0.connected + t1.connected + t0.other });
    }
    expect(rowOf(a, 4).departed).toBe(true);
    expect(a.totals.callbacks).toEqual(CALLBACKS);
  });

  it('what happened on the calls holds every campaign\'s conversations', () => {
    expect(a.outcomes.find((o) => o.code === 'interested')!.conversations).toBe((codes.c0.get('interested') ?? 0) + (codes.c1.get('interested') ?? 0));
  });

  it('a window holding today with nobody dialled yet: no rows, the team\'s last working days still drawn', async () => {
    const now = await team({ from: today(), to: today() });
    expect(now.agents).toEqual([]);
    expect(now.trend).toMatchObject({ span: 'last_working_days', dates: [EARLIER, ...WORK] });
    // Nothing worked today: the main outcome is the whole scope's (promises, c0's catalog), not
    // mixed; and nothing to date the bars by.
    expect(now.main_outcome).toEqual({ kind: 'promises', codes: ['will_pay'], label: 'Will pay', mixed: false });
    expect(now.outcomes).toEqual([]);
    expect(now.rollup_as_of).toBeNull();
  });

  it('the campaigns worked in the window decide the main outcome, not every live one (TP8)', async () => {
    const sup2 = other.supervisors[0]!;
    // Only the success campaign dialled; the promise campaign is live but idle: successes.
    const idle = await team({ from: OTHER_SUCCESS_DAY, to: OTHER_SUCCESS_DAY }, sup2, other);
    expect(idle.main_outcome).toEqual({ kind: 'successes', codes: ['interested'], label: 'Interested', mixed: false });
    expect(idle.agents.map((r) => r.agent_user_id)).toEqual([other.agents[1]!.id]);
    expect(idle.agents[0]!.main).toMatchObject({ numerator: 1, denominator: 4 });
    // A soft-phone promise recorded on the promise campaign is work on it: promises, and mixed,
    // the success campaign's conversations in the rate's calls.
    const mixed = await team({ from: OTHER_MIXED_DAY, to: OTHER_MIXED_DAY }, sup2, other);
    expect(mixed.main_outcome).toEqual({ kind: 'promises', codes: ['promised'], label: 'Promised (other)', mixed: true });
    expect(mixed.agents[0]!.main).toMatchObject({ numerator: 1, denominator: 5 });
  });

  it('a legacy zone name is answered as sent, its days cut in the current name', async () => {
    const legacy = await team({ campaign_id: c0, timezone: 'Asia/Calcutta' });
    expect(legacy.timezone).toBe('Asia/Calcutta');
    const current = await team({ campaign_id: c0 });
    expect(legacy.trend).toEqual(current.trend);
  });
});

// ── Isolation and refusals ───────────────────────────────────────────────────

describe('isolation', () => {
  it('another tenant\'s agents, campaigns and catalog are never in an answer, nor ours in theirs', async () => {
    const foreign = foreignIdsOf([floor, other, dark], floor);
    for (const o of [{}, { campaign_id: c0 }]) {
      const res = await call(loaded.app, 'GET', url(o), sup(), floor);
      expect(foreignIdsIn(res.body, foreign)).toEqual([]);
    }
    // Their campaign's catalog ("Promised (other)") is not in our main outcome.
    expect((await team()).main_outcome.codes).toEqual(['will_pay']);
    const theirs = await team({}, other.supervisors[0]!, other);
    expect(theirs.agents.map((r) => r.agent_user_id)).toEqual([other.agents[0]!.id]);
    expect(theirs.main_outcome).toEqual({ kind: 'promises', codes: ['promised'], label: 'Promised (other)', mixed: false });
    expect(foreignIdsIn(JSON.stringify(theirs), foreignIdsOf([floor, other, dark], other))).toEqual([]);
    const res = await call(loaded.app, 'GET', url({ campaign_id: other.campaigns[0]! }), sup(), floor);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'team_campaign_not_found' });
  });

  it('another account of the same tenant sees none of this account\'s work, nor its campaigns', async () => {
    const asB = (u: string) => loaded.app.inject({
      method: 'GET', url: u,
      headers: { authorization: `Bearer ${supB.tok}`, 'x-tenant-id': floor.tenant, 'x-account-id': accountB },
    });
    const all = await asB(url());
    expect(all.statusCode, all.body).toBe(200);
    expect((all.json() as AgencyTeamPerformance).agents).toEqual([]);
    expect((all.json() as AgencyTeamPerformance).outcomes).toEqual([]);
    // Nor this account's promises in its per-day chart.
    expect((all.json() as AgencyTeamPerformance).trend).toEqual({ span: 'last_working_days', dates: [], counts: [] });
    expect((await asB(url({ campaign_id: c0 }))).statusCode).toBe(404);
  });
});

describe('refusals and guards', () => {
  it('an agent gets the RBAC 403 (TP3); the flag off is 403 feature_disabled', async () => {
    expect((await call(loaded.app, 'GET', url(), agent(0), floor)).statusCode).toBe(403);
    const off = await call(loaded.app, 'GET', url(), dark.supervisors[0]!, dark);
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ code: 'feature_disabled' });
  });

  it('the zone and the window', async () => {
    for (const [o, code] of [
      // Two days ahead of today now: past today whichever side of local midnight the server reads it.
      [{ timezone: 'Mars/Olympus' }, 'team_timezone_invalid'], [{ to: shiftDate(today(), 2) }, 'team_window_invalid'],
      [{ from: shiftDate(TO, -40) }, 'team_window_invalid'], [{ from: TO, to: FROM }, 'team_window_invalid'],
    ] as const) {
      const res = await call(loaded.app, 'GET', url(o), sup(), floor);
      expect(res.statusCode, JSON.stringify(o)).toBe(400);
      expect(res.json()).toMatchObject({ code });
    }
  });

  it('an answer is served from the cache for 30 s: the same as_of', async () => {
    const first = await team({ campaign_id: c1, from: WORK[2]!, to: WORK[2]! });
    const again = await team({ campaign_id: c1, from: WORK[2]!, to: WORK[2]! });
    expect(again.as_of).toBe(first.as_of);
  });

  it('a read past its budget is 503 team_timed_out, a reviewed body through the mask', async () => {
    const lock: pg.PoolClient = await getTestPool().connect();
    try {
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE agency_call_attempts IN ACCESS EXCLUSIVE MODE');
      const res = await call(loaded.app, 'GET', url({ from: WORK[3]!, to: WORK[3]! }), sup(), floor);
      expect(res.statusCode).toBe(503);
      expect(res.body).toBe(JSON.stringify({ error: 'Service Unavailable', code: 'team_timed_out', message: 'Too much to read at once. Try a shorter period.' }));
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  }, 20_000);
});

describe('the plans', () => {
  async function plan(text: string, values: unknown[]): Promise<string> {
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      // Usable, whatever the tiny seed's statistics say: the planner must be able to take the index.
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, values);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  const window = () => [floor.tenant, floor.account, L(FROM, '00:00'), L(shiftDate(TO, 1), '00:00'), floor.agents.map((x) => x.id)];

  it('the promises statement reads each call table on its 0050 promise index, on one campaign and across the account', async () => {
    for (const [scope, extra] of [[{ kind: 'campaign', campaignId: c0 }, [c0]], [{ kind: 'account' }, []]] as const) {
      const p = await plan(teamPromisesSql(scope), [...window(), ...extra]);
      for (const index of ['idx_agency_attempts_promise_written', 'idx_agency_manual_calls_promise_written', 'idx_agency_inbound_calls_promise_written']) {
        expect(p, `${scope.kind}: ${index}`).toContain(index);
      }
    }
  });
});

// ── The console's recorded answers (opt-in) ──────────────────────────────────

/** A value as one line of JSON with a space after each `:` and `,`, as the recorded file holds it. */
function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')}}`;
  return JSON.stringify(v);
}

/** One answer as a TypeScript constant: a line per field, `totals` a line per figure, a line per outcome, row and finding. */
function recorded(name: string, doc: string, a: AgencyTeamPerformance): string {
  const lines = Object.entries(a).map(([k, v]) => {
    if (k === 'totals') return `  ${k}: {\n${Object.entries(v as object).map(([t, x]) => `    ${t}: ${inline(x)},`).join('\n')}\n  },`;
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') return `  ${k}: [\n${v.map((x) => `    ${inline(x)},`).join('\n')}\n  ],`;
    return `  ${k}: ${inline(v)},`;
  });
  return `/** ${doc} */\nexport const ${name}: AgencyTeamPerformance = {\n${lines.join('\n')}\n};\n`;
}

const RECORD_TO = process.env['RECORD_TEAM_ANSWERS'];
if (RECORD_TO) {
  describe('recording the console\'s answers (RECORD_TEAM_ANSWERS)', () => {
    it('writes the one-campaign and All-campaigns answers over this seed', async () => {
      const one = await team({ campaign_id: c0 });
      const all = await team();
      const header = `import type { AgencyTeamPerformance } from '@magick-agency/contracts/api/agency/team-performance';

/**
 * Team performance answers recorded from the real route (\`GET /proxy/agency/team-performance\`, the
 * server over a seeded Postgres, ${localDateOf(new Date(), 'UTC')}), kept exactly as the server sent them. The seed is the
 * server's integration test's (\`apps/server/test/integration/api/team-performance.test.ts\`): eight
 * agents of one account over five local days in Asia/Kolkata with a day off, one campaign recording
 * promises (Will pay) and one not, a departed agent, a thin one, soft-phone and inbound promises,
 * and a supervisor's soft-phone promise with no row (TP14). Rewritten by that test with
 * \`RECORD_TEAM_ANSWERS\` set (docs/team-performance.md §8); do not edit by hand.
 *
 * \`__tests__/utils/teamAnswer.test.ts\` holds these and the hand-made answers of \`teamRecorded.ts\`
 * to the same rules, so the page's tests run on answers shaped and summed as the real read's.
 */
`;
      const text = [
        header,
        recorded('TEAM_ROUTE_ONE_CAMPAIGN', 'One campaign (promises), comparable, with the seeded gaps and the one who stands out.', one),
        recorded('TEAM_ROUTE_ALL_CAMPAIGNS', 'All campaigns: a mixed scope (promises, `mixed`), not comparable, allowed time differing by campaign.', all),
      ].join('\n');
      writeFileSync(resolve(process.cwd(), RECORD_TO), text);
    });
  });
}
