import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ─── Every Insights number opens a list whose total is that number ───────────
 *
 * End to end, through `buildApp` and real Postgres: one campaign seeded with contacts in every
 * roster bucket and attempts across agents, outcomes, wrap-up redials, hand and reopened dials,
 * live calls and dials outside the range; the rollup job run until it is caught up; then
 * `/insights/{summary,allocation,activity}` read as the console reads them. For every row of
 * `test/fixtures/insights-drilldowns.json` the number is read from the response, the list the
 * console would open is requested with `include_total=1`, and its `total` must equal the
 * number. The console holds the same table against `links.ts` and the sections
 * (`apps/console/src/__tests__/utils/insightsDrilldowns.test.tsx`), so a param that changes on
 * one side only reds one of the two.
 *
 * The same run checks the range reads' wire against `test/fixtures/insights-responses.json`,
 * the responses of a real run (ids normalised) that the console's tests render: the live
 * responses must have exactly that shape. `INSIGHTS_WRITE_FIXTURES=1` rewrites the file from
 * this run (do that when the contract changes, and commit it with the change).
 *
 * Also here: the range reads' guards (the as-of-now routes' chain) and their 400s.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'insights-drill-secret-0123456789ab';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { bulkInsert } from '../agency/insights-rollup-world.js';
import { insightsCache } from '../../../src/agency/insights/cache.js';
import { agencyInsightsPacingRepository, agencyInsightsRollupRepository } from '../../../src/db/repositories/agency.repository.js';

interface DrillLink {
  id: string;
  number: string;
  minus?: string;
  list: 'contacts' | 'attempts';
  params: Record<string, string[]>;
}
const TABLE = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/insights-drilldowns.json', import.meta.url)), 'utf8')) as { links: DrillLink[] };
const RESPONSES_PATH = fileURLToPath(new URL('../../fixtures/insights-responses.json', import.meta.url));

let loaded: LoadApp;
let floors: TenantFloor[];
let floor: TenantFloor;
let campaignId: string;
const sup = () => floor.supervisors[0]!;
const agent = (i: number) => floor.agents[i]!;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

const MIN = 60_000;
const BUCKET = 15 * MIN;
/** The activity range: four hours to the end of the current bucket, bucket-aligned. */
const NOW = Date.now();
const FROM = new Date(Math.floor(NOW / BUCKET) * BUCKET - 4 * 60 * MIN);
const TO = new Date(Math.floor(NOW / BUCKET) * BUCKET + BUCKET);
const RANGE_QS = `from=${encodeURIComponent(FROM.toISOString())}&to=${encodeURIComponent(TO.toISOString())}`;
const at = (minutes: number, seconds = 0) => new Date(FROM.getTime() + minutes * MIN + seconds * 1000);

async function get(path: string, actor: Actor = sup(), f: TenantFloor = floor) {
  return call(loaded.app, 'GET', path, actor, f);
}
async function ok(path: string) {
  const res = await get(path);
  expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
  return res.json();
}
const insights = (section: string, qs = '') => `/proxy/agency/campaigns/${campaignId}/insights/${section}${qs ? `?${qs}` : ''}`;

// ── The seed ─────────────────────────────────────────────────────────────────

/** Roster buckets by `g % 12` (the owner is `floor(g / 12) % 3`: agent 0, agent 1, the pool). */
const BUCKETS = [
  { state: 'pending', due: true, dialled: false },
  { state: 'pending', due: true, dialled: true, last_outcome: 'no_answer' },
  { state: 'pending', due: false, dialled: true, last_outcome: 'no_answer' },
  { state: 'pending', due: false, dialled: true, last_outcome: 'connected', last_disposition: 'callback' },
  { state: 'in_flight', dialled: true, live: true },
  { state: 'connected', dialled: true },
  { state: 'completed', dialled: true, last_outcome: 'connected', last_disposition: 'interested' },
  { state: 'exhausted', dialled: true, last_outcome: 'no_answer' },
  { state: 'suppressed', suppressed_reason: 'dnc', dialled: false },
  { state: 'suppressed', suppressed_reason: 'invalid', dialled: false },
  { state: 'suppressed', suppressed_reason: 'max_attempts', dialled: true },
  { state: 'suppressed', suppressed_reason: 'manual', dialled: false },
] as const;
const OUTCOMES = ['connected', 'no_answer', 'busy', 'failed', 'abandoned'] as const;

async function seed(): Promise<{ sessions: string[] }> {
  campaignId = floor.campaigns[0]!;
  await q(`UPDATE agency_campaigns SET status = 'running', started_at = $2, assignment_mode = 'strict', created_at = $3,
                  default_timezone = 'Asia/Kolkata' WHERE id = $1`,
    [campaignId, at(-60), at(-120)]);
  const owners = [agent(0).id, agent(1).id, null];
  // One past shift per agent, joined before the range.
  const sessions: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { rows } = await q(
      `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, joined_at, left_at)
       VALUES ($1, $2, $3, $4, 'offline', $5, $6) RETURNING id`,
      [floor.tenant, floor.account, campaignId, agent(i).id, at(-60), at(200)]);
    sessions.push(rows[0].id);
    const steps: Array<[string, Date, string | null]> = [
      ['available', at(-50), null], ['on_call', at(10 + i), null], ['wrapup', at(20), null],
      ['break', at(30), 'lunch'], ['available', at(60), null], ['offline', at(200), null],
    ];
    for (const [state, when, reason] of steps) {
      await q(`INSERT INTO agency_agent_session_events (id, session_id, tenant_id, account_id, campaign_id, agent_user_id, to_state, at, break_reason)
               VALUES ($9, $1, $2, $3, $4, $5, $6, $7, $8)`,
        [rows[0].id, floor.tenant, floor.account, campaignId, agent(i).id, state, when, reason, randomUUID()]);
    }
  }

  const contacts: Array<Record<string, unknown>> = [];
  const attempts: Array<Record<string, unknown>> = [];
  for (let g = 0; g < 60; g++) {
    const b = BUCKETS[g % 12]!;
    const owner = owners[Math.floor(g / 12) % 3] ?? null;
    const id = randomUUID();
    contacts.push({
      id, campaign_id: campaignId, tenant_id: floor.tenant, account_id: floor.account,
      phone_e164: `+9198${String(g).padStart(8, '0')}`, context: {}, state: b.state,
      next_attempt_at: new Date(NOW + ('due' in b && b.due ? -30 * MIN : 120 * MIN)),
      last_outcome: 'last_outcome' in b ? b.last_outcome : null,
      last_disposition: 'last_disposition' in b ? b.last_disposition : null,
      suppressed_reason: 'suppressed_reason' in b ? b.suppressed_reason : null,
      assigned_user_id: owner, assigned_at: owner ? new Date() : null,
    });
    if (!b.dialled) continue;
    // Owners dial their own contacts (strict); the pool's are dialled by agent 2, or with no session.
    const session = owner ? sessions[owners.indexOf(owner)]! : g % 2 === 0 ? sessions[2]! : null;
    const dials = 1 + (g % 3);
    let number = 0;
    for (let n = 1; n <= dials; n++) {
      number += 1;
      const last = n === dials;
      // A dial before the range (out of every activity number), one exactly on its start.
      const dialed = g % 10 === 1 && n === 1 ? at(-20, g) : g === 2 && n === 1 ? FROM : at(g * 3 + n, g % 50);
      // The last call of a contact written up (a callback booked, a success) was a conversation.
      const outcome = 'live' in b && last ? null : 'last_disposition' in b && last ? 'connected' : OUTCOMES[(g + n) % OUTCOMES.length]!;
      const row: Record<string, unknown> = {
        id: randomUUID(), campaign_id: campaignId, contact_id: id, tenant_id: floor.tenant, account_id: floor.account,
        attempt_number: number, caller_id: g % 2 ? '+919000000001' : '+919000000002', reserved_agent_id: session,
        state: outcome === null ? 'ringing' : 'ended', outcome, dialed_at: dialed,
        redial_number: 0, agent_reopened: n === 2 && g % 2 === 0, agent_manual: n === 3 || g % 7 === 3,
        override_applied: n === 1 && g % 5 === 0 ? ['extra_attempts'] : [],
      };
      if (outcome === 'connected' || outcome === 'abandoned') row['answered_at'] = new Date(dialed.getTime() + 5000);
      if (outcome === 'connected') {
        row['bridged_at'] = new Date(dialed.getTime() + 5200);
        row['ended_at'] = new Date(dialed.getTime() + 95_000);
        row['wrapup_started_at'] = row['ended_at'];
        row['wrapup_ended_at'] = new Date(dialed.getTime() + 125_000);
        row['wrapup_resolution'] = 'disposition_submitted';
        row['disposition_code'] = 'last_disposition' in b && last ? b.last_disposition : g % 2 ? 'interested' : 'not_interested';
        // Half the callbacks booked for a time inside the range (now overdue), half for later.
        if (row['disposition_code'] === 'callback') row['callback_at'] = g % 24 === 3 ? at(150 + g) : new Date(NOW + 120 * MIN);
      } else if (outcome !== null) {
        row['ended_at'] = new Date(dialed.getTime() + 20_000);
      }
      attempts.push(row);
      // A wrap-up redial chain on some connected calls: the original closed `redialed`, the redial connected.
      if (outcome === 'connected' && (g + n) % 2 === 0 && !('last_disposition' in b && last)) {
        row['disposition_code'] = 'redialed';
        row['wrapup_resolution'] = 'redialed';
        row['callback_at'] = null;
        number += 1;
        const redialAt = new Date(dialed.getTime() + 130_000);
        attempts.push({
          ...row, id: randomUUID(), attempt_number: number, dialed_at: redialAt, redial_number: 1, redial_of_attempt_id: row['id'],
          agent_reopened: false, agent_manual: false, override_applied: [],
          answered_at: new Date(redialAt.getTime() + 4000), bridged_at: new Date(redialAt.getTime() + 4200),
          ended_at: new Date(redialAt.getTime() + 60_000), wrapup_started_at: new Date(redialAt.getTime() + 60_000),
          wrapup_ended_at: new Date(redialAt.getTime() + 70_000), wrapup_resolution: 'disposition_submitted',
          disposition_code: g % 2 ? 'interested' : 'not_interested',
        });
      }
    }
  }
  await bulkInsert(getTestPool(), 'agency_contacts', [
    ['id', 'uuid'], ['campaign_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'], ['phone_e164', 'text'], ['context', 'jsonb'],
    ['state', 'text'], ['next_attempt_at', 'timestamptz'], ['last_outcome', 'text'], ['last_disposition', 'text'],
    ['suppressed_reason', 'text'], ['assigned_user_id', 'uuid'], ['assigned_at', 'timestamptz'],
  ], contacts);
  // Attempt number order per contact: insert in one statement so the dialled counter (0011) counts each.
  await bulkInsert(getTestPool(), 'agency_call_attempts', [
    ['id', 'uuid'], ['campaign_id', 'uuid'], ['contact_id', 'uuid'], ['tenant_id', 'uuid'], ['account_id', 'uuid'],
    ['attempt_number', 'int'], ['caller_id', 'text'], ['reserved_agent_id', 'uuid'], ['state', 'text'], ['outcome', 'text'],
    ['disposition_code', 'text'], ['callback_at', 'timestamptz'], ['dialed_at', 'timestamptz'], ['answered_at', 'timestamptz'],
    ['bridged_at', 'timestamptz'], ['ended_at', 'timestamptz'], ['wrapup_started_at', 'timestamptz'], ['wrapup_ended_at', 'timestamptz'],
    ['wrapup_resolution', 'text'], ['redial_of_attempt_id', 'uuid'], ['redial_number', 'int'], ['agent_reopened', 'boolean'],
    ['agent_manual', 'boolean'], ['override_applied', 'text[]'],
  ], attempts);

  // The pacing history: a three-minute stall for want of agents, a refused redial, a pre-dial DNC.
  for (let m = 0; m < 3; m++) {
    await agencyInsightsPacingRepository.addToMinute({ campaignId, tenantId: floor.tenant, field: 'ticks', at: at(100 + m), n: 4 });
    await agencyInsightsPacingRepository.addToMinute({ campaignId, tenantId: floor.tenant, field: 'idle_no_agents', at: at(100 + m), n: 4 });
  }
  await agencyInsightsPacingRepository.addToMinute({ campaignId, tenantId: floor.tenant, field: 'redials_refused_at_limit', at: at(50) });
  await agencyInsightsPacingRepository.addToMinute({ campaignId, tenantId: floor.tenant, field: 'predial_dnc_suppressed', at: at(51) });
  await agencyInsightsPacingRepository.addToMinute({ campaignId, tenantId: floor.tenant, field: 'idle_no_slots', at: at(52) });
  await agencyInsightsPacingRepository.addToMinute({ campaignId, tenantId: floor.tenant, field: 'ticks', at: at(52), n: 8 });
  // An agent's campaign-scoped DNC mark, the guardrail's auto-pause, and a tagged soft-phone call.
  await q(`INSERT INTO dnc_entries (tenant_id, campaign_id, phone_e164, source, added_by, created_at) VALUES ($1, $2, '+919811111111', 'agent', $3, $4)`,
    [floor.tenant, campaignId, agent(0).id, at(40)]);
  await q(`INSERT INTO audit_logs (tenant_id, account_id, event_type, event_category, severity, actor, event_data, timestamp)
           VALUES ($1, $2, 'agency_campaign.auto_paused', 'call', 'error', 'system:abandonment-guardrail', $3::jsonb, $4)`,
    [floor.tenant, floor.account, JSON.stringify({ campaign_id: campaignId, reason: 'abandonment_ceiling', measured_pct: 3.4, ceiling_pct: 3 }), at(70)]);
  const { rows: [soft] } = await q(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, kind, joined_at, left_at)
     VALUES ($1, $2, NULL, $3, 'offline', 'softphone', $4, $5) RETURNING id`, [floor.tenant, floor.account, agent(2).id, at(1), at(2)]);
  await q(`INSERT INTO agency_manual_calls (tenant_id, account_id, session_id, agent_user_id, campaign_id, destination_e164, caller_id, state, dialed_at, ended_at, created_at)
           VALUES ($1, $2, $3, $4, $5, '+919822222222', '+919000000001', 'ended', $6, $7, $6)`,
    [floor.tenant, floor.account, soft.id, agent(2).id, campaignId, at(1, 30), at(1, 50)]);

  // The rollup job, run until the backlog is empty.
  for (let i = 0; i < 50; i++) if ((await agencyInsightsRollupRepository.recomputeBatch(200)).picked < 200) break;
  return { sessions };
}

// ── Reading a number ─────────────────────────────────────────────────────────

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);

/** `a.b[{agent}].c`: `[{x}]` picks the array element whose `agent_user_id` is the placeholder. */
function numberAt(root: Record<string, unknown>, path: string, vars: Record<string, string>): number {
  let cur: unknown = root;
  for (const part of fill(path, vars).split('.')) {
    const m = /^(\w+)\[([^\]]+)\]$/.exec(part);
    if (m) {
      const list = (cur as Record<string, unknown>)[m[1]!] as Array<Record<string, unknown>>;
      cur = list.find((row) => row['agent_user_id'] === m[2]);
    } else {
      cur = (cur as Record<string, unknown>)[part];
    }
    if (cur === undefined) throw new Error(`${path}: nothing at ${part}`);
  }
  if (typeof cur !== 'number') throw new Error(`${path}: not a number`);
  return cur;
}

// ── Shapes ───────────────────────────────────────────────────────────────────

/**
 * Where `live` differs in shape from `fixture` (keys, value types; null matches any type). An
 * array element matches when it has the shape of ANY fixture element (rows differ: the no-agent
 * row has no break reasons).
 */
function shapeDiff(live: unknown, fixture: unknown, path = '$'): string[] {
  if (live === null || fixture === null) return [];
  if (Array.isArray(fixture) !== Array.isArray(live)) return [`${path}: array vs not`];
  if (Array.isArray(fixture) && Array.isArray(live)) {
    if (fixture.length === 0 || live.length === 0) return [];
    return live.flatMap((item, i) => {
      const diffs = fixture.map((f) => shapeDiff(item, f, `${path}[${i}]`));
      return diffs.some((d) => d.length === 0) ? [] : diffs[0]!;
    });
  }
  if (typeof live !== typeof fixture) return [`${path}: ${typeof live} vs ${typeof fixture}`];
  if (typeof live !== 'object') return [];
  const a = Object.keys(live as object).sort();
  const b = Object.keys(fixture as object).sort();
  if (a.join() !== b.join()) return [`${path}: keys [${a.join(', ')}] vs [${b.join(', ')}]`];
  return a.flatMap((k) => shapeDiff((live as Record<string, unknown>)[k], (fixture as Record<string, unknown>)[k], `${path}.${k}`));
}

/** The run's ids replaced by stable ones, so the committed file only changes when the shape does. */
function normalised(value: unknown, known: Map<string, string>): unknown {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return JSON.parse(JSON.stringify(value), (_, v) => {
    if (typeof v !== 'string' || !UUID.test(v)) return v;
    if (!known.has(v)) known.set(v, `00000000-0000-4000-8000-${String(known.size + 1).padStart(12, '0')}`);
    return known.get(v);
  });
}

// ── The suite ────────────────────────────────────────────────────────────────

let responses: Record<string, Record<string, unknown>>;

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  floors = await seedFloor({ tenants: 3, agentsPerTenant: 3, supervisorsPerTenant: 1, campaignsPerTenant: 2, staffAgents: true });
  floor = floors[0]!;
  await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
           VALUES ('agency_contact_assignment_enabled', 'tenant', $1, 'true'::jsonb)`, [floor.tenant]);
  await q(`UPDATE feature_flag_overrides SET value = 'false'::jsonb WHERE flag_key = 'agency_dialer_enabled' AND tenant_id = $1`,
    [floors[2]!.tenant]);
  await seed();
  insightsCache.clear();
  responses = {
    summary: await ok(insights('summary')),
    allocation: await ok(insights('allocation')),
    activity: await ok(insights('activity', RANGE_QS)),
    trends: await ok(insights('trends', `${RANGE_QS}&bucket=hour`)),
    health: await ok(insights('health', RANGE_QS)),
  };
}, 180_000);

beforeEach(() => insightsCache.clear());

afterAll(async () => {
  await stopLoadApp(loaded);
});

describe('every number opens a list whose total is the number', () => {
  const vars = () => ({ agent: agent(0).id, from: FROM.toISOString(), to: TO.toISOString() });

  it.each(TABLE.links.map((l) => [l.id, l] as const))('%s', async (_id, link) => {
    const v = vars();
    const expected = numberAt(responses, link.number, v) - (link.minus ? numberAt(responses, link.minus, v) : 0);
    const qs = new URLSearchParams();
    for (const [key, values] of Object.entries(link.params)) for (const value of values) qs.append(key, fill(value, v));
    qs.set('include_total', '1');
    const res = await get(`/proxy/agency/campaigns/${campaignId}/${link.list}?${qs.toString()}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().total, `${link.number} = ${expected}`).toBe(expected);
    // Not vacuous: the seed puts something behind every number.
    expect(expected, link.number).toBeGreaterThan(0);
  });

  it('the table covers the brief\'s numbers', () => {
    const ids = new Set(TABLE.links.map((l) => l.id));
    for (const id of [
      'roster.waiting_due_now', 'roster.waiting_retry', 'roster.waiting_callback', 'roster.attempted', 'roster.never_attempted',
      'roster.suppressed_dnc', 'roster.suppressed_invalid', 'roster.suppressed_other',
      'allocation.agent.allocated', 'allocation.agent.attempted', 'allocation.agent.due_now', 'allocation.agent.redials',
      'allocation.agent.retries_reopened', 'allocation.agent.retries_manual',
      'activity.outcome.connected', 'activity.outcome.no_answer', 'activity.redials', 'activity.reopened', 'activity.manual',
    ]) expect(ids.has(id), id).toBe(true);
  });
});

describe('the range reads', () => {
  it('serve the range they were asked for, echoed, with the rollup caught up', () => {
    for (const section of ['activity', 'trends', 'health']) {
      expect(responses[section]!['range'], section).toMatchObject({ from: FROM.toISOString(), to: TO.toISOString(), lifetime: false });
      expect(responses[section]!['pending_buckets'], section).toBe(0);
      expect(responses[section]!['as_of'], section).toEqual(expect.any(String));
    }
    expect(responses['trends']!['range']).toMatchObject({ timezone: 'Asia/Kolkata' });
  });

  it('activity: every reconciliation holds, and the blocks outside the rollup are filled', () => {
    const a = responses['activity'] as Record<string, any>;
    expect(a.reconciliation.length).toBeGreaterThan(0);
    for (const check of a.reconciliation) expect(check, check.check).toMatchObject({ ok: true });
    expect(a.calls.softphone_calls).toBe(1);
    expect(a.calls.redials.refused_at_limit).toBe(1);
    expect(a.calls.conversations).toBeGreaterThan(0);
    expect(a.calls.successes).toBeLessThanOrEqual(a.calls.conversations);
    expect(a.dnc_marked).toEqual({ total: 1, by_agent: [{ user_id: agent(0).id, count: 1 }] });
    // The pool's dials with no session are the "no agent" row, so the rows sum to the totals.
    expect(a.agents.some((r: { agent_user_id: string | null }) => r.agent_user_id === null)).toBe(true);
    const lunch = a.agents.find((r: { agent_user_id: string }) => r.agent_user_id === agent(0).id).state_seconds.break_by_reason.lunch;
    expect(lunch).toBe(30 * 60);
    // As of now, the allocation's totals.
    expect(a.callbacks.open_overdue).toBe((responses['allocation'] as any).totals.callbacks_overdue);
    expect(a.callbacks.booked).toBeGreaterThan(0);
    expect(a.callbacks.pending_due).toBeGreaterThan(0);
    expect(a.callbacks.by_owner.reduce((s: number, o: { open: number }) => s + o.open, 0)).toBe(a.callbacks.pending_due + a.callbacks.pending_future);
  });

  it('trends: hour buckets in the campaign zone, the online peak joined on, summing to activity', () => {
    const t = responses['trends'] as Record<string, any>;
    expect(t.bucket).toBe('hour');
    const sum = (k: string) => t.buckets.reduce((s: number, b: Record<string, number>) => s + b[k]!, 0);
    const a = (responses['activity'] as any).calls;
    expect(sum('dials')).toBe(a.dials);
    expect(sum('connected')).toBe(a.connected);
    // The connect rate's denominator: the dials that were not a wrap-up redial.
    expect(sum('first_dials')).toBe(a.dials - a.redials.placed);
    expect(a.redials.placed).toBeGreaterThan(0);
    expect(sum('conversations')).toBe(a.conversations);
    expect(Math.max(...t.buckets.map((b: { agents_online_peak: number }) => b.agents_online_peak))).toBe(3);
  });

  it('health: the pacing history, the guardrail and the rollup', () => {
    const h = responses['health'] as Record<string, any>;
    expect(h.stalls.minutes_by_reason.no_agents).toBe(3);
    expect(h.stalls.episodes).toEqual([{ reason: 'no_agents', started_at: at(100).toISOString(), ended_at: at(103).toISOString(), minutes: 3 }]);
    expect(h.stalls.episodes_truncated).toBe(false);
    expect(h.concurrency_limit_minutes).toBe(1);
    expect(h.predial_blocks.dnc).toBe(1);
    expect(h.abandonment.auto_pauses).toEqual([{ at: at(70).toISOString(), measured_pct: 3.4, ceiling_pct: 3 }]);
    expect(h.abandonment.rolling_24h.answered).toBeGreaterThan(h.abandonment.rolling_24h.abandoned);
    expect(h.caller_ids.reduce((s: number, c: { dials: number }) => s + c.dials, 0)).toBe((responses['activity'] as any).calls.dials);
    expect(h.carrier_failures).toBe((responses['activity'] as any).calls.by_outcome.failed);
    expect(h.carrier_failures_by_code.reduce((s: number, c: { count: number }) => s + c.count, 0)).toBe(h.carrier_failures);
    const calls = (responses['activity'] as any).calls;
    expect(h.caller_ids.reduce((s: number, c: { first_dials: number }) => s + c.first_dials, 0)).toBe(calls.dials - calls.redials.placed);
    expect(h.analysis).toBeNull();
    expect(h.pacing_history_since).toBe(at(50).toISOString());
  });

  it('the responses have the shape of the committed fixture the console renders', () => {
    const known = new Map<string, string>([
      [campaignId, '00000000-0000-4000-8000-0000000000c1'],
      [agent(0).id, '00000000-0000-4000-8000-0000000000a0'],
      [agent(1).id, '00000000-0000-4000-8000-0000000000a1'],
      [agent(2).id, '00000000-0000-4000-8000-0000000000a2'],
    ]);
    const live = {
      _doc: 'Written by test/integration/api/agency-insights-drilldowns.test.ts (INSIGHTS_WRITE_FIXTURES=1): real responses, ids normalised. The console\'s tests render them; the server test holds the live shape to this file.',
      placeholders: { campaign: known.get(campaignId), agent: known.get(agent(0).id), from: FROM.toISOString(), to: TO.toISOString() },
      ...(normalised(responses, known) as Record<string, unknown>),
    };
    if (process.env['INSIGHTS_WRITE_FIXTURES'] === '1') writeFileSync(RESPONSES_PATH, `${JSON.stringify(live, null, 2)}\n`);
    const committed = JSON.parse(readFileSync(RESPONSES_PATH, 'utf8')) as Record<string, unknown>;
    for (const section of ['summary', 'allocation', 'activity', 'trends', 'health']) {
      expect(shapeDiff(live[section as keyof typeof live], committed[section]), section).toEqual([]);
    }
  });
});

describe('the range reads\' guards and refusals', () => {
  const sections = ['activity', 'trends', 'health'];

  it('refuse an agent (RBAC 403), another tenant\'s and a malformed id (404), and a tenant without the dialer (403)', async () => {
    for (const section of sections) {
      expect((await get(insights(section), agent(0))).statusCode, section).toBe(403);
      const foreign = await get(`/proxy/agency/campaigns/${floors[1]!.campaigns[0]}/insights/${section}`);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json().code).toBe('campaign_not_found');
      const malformed = await get(`/proxy/agency/campaigns/nope/insights/${section}?from=bad`);
      expect(malformed.statusCode).toBe(404);
      const off = floors[2]!;
      const disabled = await get(`/proxy/agency/campaigns/${off.campaigns[0]}/insights/${section}?from=bad`, off.supervisors[0]!, off);
      expect(disabled.statusCode).toBe(403);
      expect(disabled.json().code).toBe('feature_disabled');
    }
  });

  it('400 invalid_insights_query on a bad range, an unknown key or a stray bucket, after the guards', async () => {
    const cases: Array<[string, string]> = [
      ['activity', 'from=2026-11-04'],
      ['activity', `from=${encodeURIComponent(TO.toISOString())}&to=${encodeURIComponent(FROM.toISOString())}`],
      ['health', 'from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z'],
      ['health', 'since=2026-11-04T00:00:00Z'],
      ['activity', 'bucket=hour'],
      ['trends', 'bucket=week'],
    ];
    for (const [section, qs] of cases) {
      const res = await get(insights(section, qs));
      expect(res.statusCode, `${section}?${qs}`).toBe(400);
      expect(res.json()).toEqual({ error: 'Bad Request', code: 'invalid_insights_query', message: expect.any(String) });
    }
  });

  it('lifetime: no range given is the campaign\'s created_at to now, with a default bucket', async () => {
    const t = await ok(insights('trends'));
    expect(t.range).toMatchObject({ from: at(-120).toISOString(), lifetime: true, clamped: false });
    expect(t.bucket).toBe('hour');
    const a = await ok(insights('activity'));
    // The lifetime includes the dials before the range.
    expect(a.calls.dials).toBeGreaterThan((responses['activity'] as any).calls.dials);
  });

  it('lifetime: a campaign older than 92 days is served its last 92 days, flagged clamped, on every range read', async () => {
    const createdAt = (await q('SELECT created_at FROM agency_campaigns WHERE id = $1', [campaignId])).rows[0]!.created_at as Date;
    await q(`UPDATE agency_campaigns SET created_at = now() - interval '200 days' WHERE id = $1`, [campaignId]);
    try {
      for (const section of ['activity', 'trends', 'health']) {
        insightsCache.clear();
        const body = await ok(insights(section));
        expect(body.range, section).toMatchObject({ lifetime: true, clamped: true });
        expect(Date.parse(body.range.to) - Date.parse(body.range.from), section).toBe(92 * 86_400_000);
        expect(Date.parse(body.range.to), section).toBeGreaterThanOrEqual(Date.now() - 15 * 60_000);
      }
    } finally {
      await q('UPDATE agency_campaigns SET created_at = $2 WHERE id = $1', [campaignId, createdAt]);
    }
  });
});
