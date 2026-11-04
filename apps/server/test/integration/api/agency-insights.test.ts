import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * ─── The campaign insights reads through the real app and real Postgres ────────
 *
 * `GET /proxy/agency/campaigns/:id/insights/{summary,readiness,allocation,uploads}`: session
 * middleware with Firebase stubbed, tenant context, RBAC, the dialer flag, the ownership probe
 * and the stats strip through `callCore`, the repositories on real Postgres. Every campaign
 * status's headline, the reconciliation the routes report, the allocation against the progress
 * read it must agree with, the readiness checks, and the refusals.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'insights-secret-0123456789abcdef';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  call, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { insightsCache } from '../../../src/agency/insights/cache.js';

let loaded: LoadApp;
let floors: TenantFloor[];
let floor: TenantFloor;
let viewer: Actor;
const app = () => loaded.app;
const sup = () => floor.supervisors[0]!;
const agent = (i: number) => floor.agents[i]!;
const C = (i: number) => floor.campaigns[i]!;
const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs);

async function get(section: string, campaignId: string, actor: Actor = sup(), f: TenantFloor = floor) {
  return call(app(), 'GET', `/proxy/agency/campaigns/${campaignId}/insights/${section}`, actor, f);
}

async function ok(section: string, campaignId: string) {
  const res = await get(section, campaignId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** A small roster in every bucket, owned round-robin by `owners` (null = the pool). */
async function seedRoster(campaignId: string, f: TenantFloor, owners: Array<string | null>): Promise<void> {
  await q(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state, next_attempt_at,
                                  attempt_count, dials_placed, last_outcome, last_disposition, suppressed_reason,
                                  assigned_user_id, assigned_at)
     SELECT $1, $2, $3, '+9190' || lpad(g::text, 8, '0'), '{}'::jsonb,
            (ARRAY['pending','pending','pending','pending','in_flight','connected','completed','exhausted','suppressed','suppressed'])[1 + g % 10],
            CASE WHEN g % 10 IN (1, 2) THEN now() + interval '2 hours' ELSE now() - interval '1 hour' END,
            CASE WHEN g % 10 IN (0, 4) THEN 0 ELSE 1 END,
            CASE WHEN g % 10 = 0 THEN 0 ELSE 1 + g % 3 END,
            CASE WHEN g % 10 IN (0, 4) THEN NULL WHEN g % 10 IN (2, 6) THEN 'connected' ELSE 'no_answer' END,
            CASE WHEN g % 10 = 2 THEN 'callback' WHEN g % 10 = 6 THEN 'interested' ELSE NULL END,
            CASE WHEN g % 10 = 8 THEN 'dnc' WHEN g % 10 = 9 THEN 'invalid' ELSE NULL END,
            ($4::uuid[])[1 + g % array_length($4::uuid[], 1)],
            CASE WHEN ($4::uuid[])[1 + g % array_length($4::uuid[], 1)] IS NULL THEN NULL ELSE now() END
       FROM generate_series(1, 60) g`,
    [campaignId, f.tenant, f.account, owners],
  );
  await q('UPDATE agency_campaigns SET contacts_total = 60 WHERE id = $1', [campaignId]);
}

async function status(campaignId: string, set: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(set);
  await q(`UPDATE agency_campaigns SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [campaignId, ...keys.map((k) => set[k])]);
}

async function platformAudit(campaignId: string, action: string, userId: string | null, createdAt: Date, details: Record<string, unknown> = {}) {
  await q(
    `INSERT INTO platform_audit_log (tenant_id, account_id, user_id, actor_type, action, resource_type, resource_id, campaign_id, details, created_at)
     VALUES ($1, $2, $3, $4, $5, 'agency_campaign', $6, $6, $7::jsonb, $8)`,
    [floor.tenant, floor.account, userId, userId ? 'human' : 'system', action, campaignId, JSON.stringify(details), createdAt]);
}

async function coreAudit(campaignId: string, eventType: string, actor: string, ts: Date, data: Record<string, unknown> = {}) {
  await q(
    `INSERT INTO audit_logs (tenant_id, account_id, event_type, event_category, severity, actor, event_data, timestamp)
     VALUES ($1, $2, $3, 'call', 'info', $4, $5::jsonb, $6)`,
    [floor.tenant, floor.account, eventType, actor, JSON.stringify({ campaign_id: campaignId, ...data }), ts]);
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  floors = await seedFloor({ tenants: 3, agentsPerTenant: 3, supervisorsPerTenant: 1, campaignsPerTenant: 9, staffAgents: true });
  floor = floors[0]!;
  // Flags before the first request (the flag service caches what it read): contact assignment on
  // for tenant 0 only; the dialer off for tenant 2.
  await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
           VALUES ('agency_contact_assignment_enabled', 'tenant', $1, 'true'::jsonb)`, [floor.tenant]);
  await q(`UPDATE feature_flag_overrides SET value = 'false'::jsonb WHERE flag_key = 'agency_dialer_enabled' AND tenant_id = $1`,
    [floors[2]!.tenant]);
  // A viewer on tenant 0's account.
  const vid = randomUUID();
  const vuid = `insights-viewer-${vid.slice(0, 8)}`;
  await q(`INSERT INTO users (id, firebase_uid, email, display_name, status) VALUES ($1, $2, $3, 'Viewer', 'active')`,
    [vid, vuid, `${vuid}@load.example.com`]);
  await q(`INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, $4, 'viewer', 'active')`,
    [randomUUID(), vid, floor.tenant, floor.account]);
  viewer = { id: vid, uid: vuid, tok: `tok:${vuid}`, role: 'agent', ip: '10.9.9.9' };
}, 120_000);

beforeEach(() => insightsCache.clear());

afterAll(async () => {
  await stopLoadApp(loaded);
});

describe('guards', () => {
  it('refuses an agent and a viewer (RBAC 403) on every route', async () => {
    for (const section of ['summary', 'readiness', 'allocation', 'uploads']) {
      for (const actor of [agent(0), viewer]) {
        const res = await get(section, C(0), actor);
        expect(res.statusCode, `${section} ${actor.uid}`).toBe(403);
        expect(res.json().message).toMatch(/^Insufficient permissions/);
      }
    }
  });

  it('404 for another tenant\'s campaign and for a malformed id, never a 22P02', async () => {
    for (const section of ['summary', 'readiness', 'allocation', 'uploads']) {
      const foreign = await get(section, floors[1]!.campaigns[0]!);
      expect(foreign.statusCode, section).toBe(404);
      expect(foreign.json().code).toBe('campaign_not_found');
      const malformed = await get(section, 'not-a-uuid');
      expect(malformed.statusCode, section).toBe(404);
      expect(malformed.json()).toEqual(foreign.json());
      const unknown = await get(section, randomUUID());
      expect(unknown.statusCode).toBe(404);
    }
  });

  it('403 feature_disabled while the dialer flag is off for the tenant', async () => {
    const off = floors[2]!;
    const res = await get('summary', off.campaigns[0]!, off.supervisors[0]!, off);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toEqual({ error: 'Feature Not Enabled', code: 'feature_disabled', message: expect.any(String) });
    // Before the id: a malformed id is the same answer.
    const malformed = await get('summary', 'nope', off.supervisors[0]!, off);
    expect(malformed.statusCode).toBe(403);
  });
});

describe('summary', () => {
  it('a draft: header, settings, roster with reconciliation, the readiness verdict', async () => {
    await status(C(0), { created_by: `user:${sup().id}` });
    await seedRoster(C(0), floor, [null]);
    const body = await ok('summary', C(0));
    expect(body).toMatchObject({
      campaign_id: C(0), status: 'draft', account: { id: floor.account, name: 'Load Account 0' },
      created_by: { user_id: sup().id, name: 'account_admin 0.0' },
      started_at: null, ended_at: null, parent_campaign: null, child_campaigns: [], transitions: [],
      headline: { running: null, paused: null, stopping: null, stopped: null, completed: null, draft: { ready: true } },
    });
    expect(body.settings).toMatchObject({
      timezone: 'UTC', calling_window_start: '00:00', calling_window_end: '24:00', calling_days: [1, 2, 3, 4, 5, 6, 7],
      calling_hours_default: false, caller_ids: ['+919000000001'], max_attempts: 4, assignment_mode: 'pool',
      wrapup_redial_limit: 2, analysis_profile: null,
    });
    const r = body.roster;
    expect(r.total).toBe(60);
    expect(r.reconciliation).toEqual([
      { check: 'contact_states_vs_total', expected: 60, actual: 60, ok: true },
      { check: 'attempts_per_contact_vs_attempted', expected: r.attempted, actual: r.attempted, ok: true },
      { check: 'waiting_vs_pending', expected: 24, actual: 24, ok: true },
    ]);
    expect(r.waiting_due_now + r.waiting_retry + r.waiting_callback + r.on_call + r.in_wrapup + r.completed
      + r.exhausted + r.suppressed_dnc + r.suppressed_invalid + r.suppressed_other).toBe(60);
    expect(r).toMatchObject({ on_call: 6, in_wrapup: 6, completed: 6, exhausted: 6, suppressed_dnc: 6, suppressed_invalid: 6, waiting_callback: 6, waiting_retry: 6 });
    expect(r.attempted).toBe(54);

    // A creator label that is not a user, and none: no actor.
    await status(C(0), { created_by: 'system:api' });
    insightsCache.clear();
    expect((await ok('summary', C(0))).created_by).toBeNull();
  });

  it('running: the stats strip\'s live numbers, the pace, and the ETA from finished contacts', async () => {
    const id = C(1);
    await seedRoster(id, floor, [null]);
    await status(id, { status: 'running', started_at: at(-2 * HOUR), last_transition_by_user_id: sup().id });
    const { rows } = await q(`SELECT id FROM agency_contacts WHERE campaign_id = $1 AND state = 'completed' LIMIT 3`, [id]);
    let n = 10;
    for (const row of rows as Array<{ id: string }>) {
      await q(`INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, dialed_at)
               VALUES ($1, $2, $3, $4, $5, '+919000000001', 'ended', now() - interval '5 minutes')`, [id, row.id, floor.tenant, floor.account, n++]);
    }
    await q(`INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state) VALUES ($1, $2, $3, $4, 'available')`,
      [floor.tenant, floor.account, id, agent(0).id]);
    const body = await ok('summary', id);
    const live = body.headline.running;
    expect(body.status).toBe('running');
    expect(live).toMatchObject({
      dials_per_hour: 12, abandonment_rate_24h: { abandoned: 0, answered: 0 },
    });
    expect(Array.isArray(live.other_stalls)).toBe(true);
    expect(live.agents_by_state.available).toBe(1);
    // 24 open contacts (pending, not DNC) at 3 finished in the last hour: 8 h of dialling.
    expect(live.eta_seconds).toBe(Math.round((24 / 3) * 3600));
    expect(Object.values(body.headline).filter((v) => v !== null)).toHaveLength(1);
  });

  it('paused by a supervisor and auto-paused: who, why, the frozen rate, callbacks missed while paused', async () => {
    const id = C(2);
    await seedRoster(id, floor, [null]);
    const cb = await q(`SELECT id FROM agency_contacts WHERE campaign_id = $1 AND last_disposition = 'callback' LIMIT 1`, [id]);
    await q(`UPDATE agency_contacts SET next_attempt_at = now() - interval '10 minutes' WHERE id = $1`, [(cb.rows[0] as { id: string }).id]);
    await status(id, {
      status: 'paused', pause_reason: 'supervisor', paused_at: at(-HOUR), started_at: at(-3 * HOUR),
      last_transition_by_user_id: sup().id, last_transition_by_name: 'snapshot',
    });
    await platformAudit(id, 'agency_campaign.started', sup().id, at(-3 * HOUR));
    await platformAudit(id, 'agency_campaign.paused', sup().id, at(-HOUR));
    const body = await ok('summary', id);
    expect(body.headline.paused).toMatchObject({
      reason: 'supervisor', actor: { user_id: sup().id, name: 'account_admin 0.0' }, abandonment_rate_pct_at_pause: null,
      calls_finishing: 0, callbacks_missed_while_paused: 1, waiting_to_resume: body.roster.waiting_due_now,
    });
    expect(body.transitions.map((t: { to_status: string; reason: string }) => [t.to_status, t.reason]))
      .toEqual([['running', 'supervisor'], ['paused', 'supervisor']]);
    expect(body.transitions[0].actor).toEqual({ user_id: sup().id, name: 'account_admin 0.0' });

    await status(id, { pause_reason: 'abandonment_ceiling', pause_abandonment_rate_pct: 4.2, last_transition_by_user_id: null, last_transition_by_name: null });
    await coreAudit(id, 'agency_campaign.auto_paused', 'system:abandonment-guardrail', at(-30 * 60_000), { measured_pct: 4.2 });
    const auto = await ok('summary', id);
    expect(auto.headline.paused).toMatchObject({ reason: 'abandonment_ceiling', actor: null, abandonment_rate_pct_at_pause: 4.2 });
    expect(auto.transitions.at(-1)).toMatchObject({ to_status: 'paused', reason: 'abandonment_ceiling', actor: null });
  });

  it('stopping, stopped (with a retry child) and completed', async () => {
    const stopping = C(3);
    await seedRoster(stopping, floor, [null]);
    await status(stopping, { status: 'stopping', started_at: at(-3 * HOUR), last_transition_by_user_id: sup().id });
    await platformAudit(stopping, 'agency_campaign.stopped', sup().id, at(-60_000));
    const s1 = await ok('summary', stopping);
    expect(s1.headline.stopping).toMatchObject({ actor: { user_id: sup().id }, calls_finishing: 0 });
    expect(new Date(s1.headline.stopping.stopped_at).getTime()).toBeGreaterThan(Date.now() - 2 * 60_000);
    expect(s1.transitions.at(-1)).toMatchObject({ to_status: 'stopping', reason: 'supervisor' });

    const stopped = C(4);
    await seedRoster(stopped, floor, [null]);
    await status(stopped, { status: 'stopped', started_at: at(-5 * HOUR), ended_at: at(-HOUR), last_transition_by_user_id: sup().id });
    await coreAudit(stopped, 'agency_campaign.stopped', 'system:pacing-leader', at(-HOUR));
    const child = C(5);
    await status(child, { parent_campaign_id: stopped, root_campaign_id: stopped, retry_generation: 1, name: 'Retry of it' });
    const s2 = await ok('summary', stopped);
    const roster = s2.roster;
    expect(s2.headline.stopped).toMatchObject({
      actor: { user_id: sup().id }, pending: roster.waiting_due_now + roster.waiting_retry + roster.waiting_callback,
      callbacks_scheduled: roster.waiting_callback, never_attempted: 60 - roster.attempted,
    });
    // What the Retry dialog's preview says for the console's default selector, as the console asks it.
    const preview = await call(app(), 'GET',
      `/proxy/agency/campaigns/${stopped}/retry/preview?last_outcome=no_answer&last_outcome=busy&last_outcome=__none__`, sup(), floor);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().matched).toBeGreaterThan(0);
    expect(s2.headline.stopped.retry_matched).toBe(preview.json().matched);
    expect(s2.child_campaigns).toEqual([{ id: child, name: 'Retry of it', status: 'draft' }]);
    expect(s2.transitions.at(-1)).toMatchObject({ to_status: 'stopped', reason: 'calls_drained', actor: null });
    const s3 = await ok('summary', child);
    expect(s3.parent_campaign).toEqual({ id: stopped, name: expect.any(String) });

    const completed = C(6);
    await seedRoster(completed, floor, [null]);
    await status(completed, { status: 'completed', started_at: at(-4 * HOUR), ended_at: at(-HOUR) });
    const s4 = await ok('summary', completed);
    expect(s4.headline.completed).toMatchObject({
      duration_seconds: 3 * 3600, reached: s4.roster.completed, successes: 6, dnc: s4.roster.suppressed_dnc,
      retry_matched: expect.any(Number),
    });
    expect(s4.headline.completed.not_reached).toBeGreaterThanOrEqual(s4.roster.exhausted);
  });

  it('is cached for a few seconds per campaign, and a campaign change misses the cache', async () => {
    const id = C(0);
    const first = await ok('summary', id);
    await q(`UPDATE agency_contacts SET state = 'completed' WHERE campaign_id = $1 AND state = 'exhausted'`, [id]);
    const second = await ok('summary', id);
    expect(second.generated_at).toBe(first.generated_at);
    expect(second.roster.exhausted).toBe(first.roster.exhausted);
    await status(id, { name: 'Renamed' });
    const third = await ok('summary', id);
    expect(third.name).toBe('Renamed');
    expect(third.roster.exhausted).toBe(0);
  });
});

describe('readiness', () => {
  it('every check, in order; fails block, warnings do not', async () => {
    const id = C(7);
    await q(`UPDATE agency_campaigns SET calling_window_start = '09:00', calling_window_end = '20:00', calling_days = '{1,2,3,4,5}',
                                         caller_ids = '{}', assignment_mode = 'strict' WHERE id = $1`, [id]);
    await seedRoster(id, floor, [agent(0).id, null]);
    await q(`INSERT INTO dnc_entries (tenant_id, account_id, phone_e164, source)
             SELECT tenant_id, NULL, phone_e164, 'api' FROM agency_contacts WHERE campaign_id = $1 AND state = 'pending' LIMIT 2`, [id]);
    await q(`INSERT INTO agency_ingest_jobs (tenant_id, campaign_id, s3_key, file_name, phone_column, status, rows_read, accepted, rejected, duplicates, dedupe_column)
             VALUES ($1, $2, 'k', 'roster.csv', 'Mobile', 'completed', 70, 60, 10, 4, 'Loan No')`, [floor.tenant, id]);
    const body = await ok('readiness', id);
    const by = Object.fromEntries(body.checks.map((c: { code: string }) => [c.code, c]));
    expect(body.checks.map((c: { code: string }) => c.code)).toEqual([
      'roster_uploaded', 'phone_column_mapped', 'outcomes_configured', 'caller_ids_present', 'calling_hours_set',
      'agents_staffed', 'contacts_allocated', 'abandonment_clip', 'contacts_on_dnc',
    ]);
    expect(by.roster_uploaded).toEqual({ code: 'roster_uploaded', result: 'pass', count: 60, detail: { rejected: 10, duplicates: 4, dedupe_column: 'Loan No' } });
    expect(by.phone_column_mapped).toMatchObject({ result: 'pass', detail: { phone_column: 'Mobile' } });
    expect(by.outcomes_configured).toMatchObject({ result: 'pass', count: 5, detail: { overrides: 0 } });
    expect(by.caller_ids_present).toMatchObject({ result: 'fail', count: 0 });
    expect(by.calling_hours_set).toMatchObject({ result: 'warn', detail: { window: '09:00–20:00', timezone: 'UTC' } });
    expect(by.agents_staffed).toMatchObject({ result: 'pass', count: 3 });
    expect(by.contacts_allocated.result).toBe('fail');
    expect(by.contacts_allocated.count).toBeGreaterThan(0);
    expect(by.abandonment_clip).toMatchObject({ result: 'warn' });
    expect(by.contacts_on_dnc).toMatchObject({ result: 'warn', count: 2 });
    expect(body.ready).toBe(false);

    await q(`UPDATE agency_campaigns SET caller_ids = '{+919000000001}', assignment_mode = 'preferred' WHERE id = $1`, [id]);
    const after = await ok('readiness', id);
    expect(after.ready).toBe(true);
    expect(after.checks.find((c: { code: string }) => c.code === 'contacts_allocated').result).toBe('warn');
  });
});

describe('allocation', () => {
  it('matches the progress read for the shared columns, reconciles, and names the agents', async () => {
    const id = C(8);
    await q(`UPDATE agency_campaigns SET assignment_mode = 'strict' WHERE id = $1`, [id]);
    await seedRoster(id, floor, [agent(0).id, agent(1).id, null]);
    // Agent 1 is on the campaign now; agent 0 was never seen.
    await q(`INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state) VALUES ($1, $2, $3, $4, 'on_call')`,
      [floor.tenant, floor.account, id, agent(1).id]);
    await q(`INSERT INTO platform_audit_log (tenant_id, account_id, user_id, actor_type, action, resource_type, resource_id, campaign_id, details)
             VALUES ($1, $2, $3, 'human', 'agency_contacts.assigned', 'agency_campaign', $4, $4, $5::jsonb)`,
      [floor.tenant, floor.account, sup().id, id, JSON.stringify({ kind: 'random_split', moved: 40, batch_id: '7b3e3c56-6b2a-4f64-9a51-0a5d7d2c1111' })]);

    const [alloc, progressRes] = await Promise.all([
      ok('allocation', id),
      call(app(), 'GET', `/proxy/agency/campaigns/${id}/assignments/progress`, sup(), floor),
    ]);
    expect(progressRes.statusCode, progressRes.body).toBe(200);
    const progress = progressRes.json();
    expect(alloc.assignment_mode).toBe('strict');
    expect(alloc.agents.map((a: { agent_user_id: string }) => a.agent_user_id))
      .toEqual(progress.agents.map((a: { agent_user_id: string }) => a.agent_user_id));
    for (const p of progress.agents) {
      const a = alloc.agents.find((x: { agent_user_id: string }) => x.agent_user_id === p.agent_user_id);
      expect(a, p.agent_user_id).toMatchObject({
        agent_name: p.agent_name, staffed: p.staffed, last_seen_at: p.last_seen_at, allocated: p.assigned,
        due_now: p.due_now, reached: p.counts.reached, not_reached: p.counts.not_reached, exhausted: p.counts.exhausted,
        last_activity_at: p.last_activity_at, due_while_absent: p.due_while_absent,
      });
    }
    expect(alloc.unassigned).toMatchObject({ allocated: progress.pool.total, due_now: progress.pool.due_now });
    expect(alloc.reconciliation).toEqual([
      { check: 'allocated_plus_unassigned_vs_total', expected: 60, actual: 60, ok: true },
      { check: 'agent_buckets_vs_allocated', expected: 60, actual: 60, ok: true },
    ]);
    expect(alloc.totals.allocated).toBe(60);
    const byId = new Map(alloc.agents.map((a: { agent_user_id: string }) => [a.agent_user_id, a]));
    expect(byId.get(agent(1).id)).toMatchObject({ state: 'on_call', due_while_absent: 0 });
    expect(byId.get(agent(0).id)).toMatchObject({ state: 'offline' });
    expect(byId.get(agent(2).id)).toMatchObject({ allocated: 0, staffed: true });
    // Agent 2 is staffed and holds nothing; agent 0 is away holding due contacts.
    expect(alloc.imbalance.empty).toEqual([agent(2).id]);
    expect(alloc.at_risk.held_by_absent.map((h: { agent_user_id: string }) => h.agent_user_id)).toContain(agent(0).id);
    expect(alloc.history).toEqual([{
      at: expect.any(String), actor: { user_id: sup().id, name: 'account_admin 0.0' }, kind: 'random_split', moved: 40,
      batch_id: '7b3e3c56-6b2a-4f64-9a51-0a5d7d2c1111',
    }]);
  });

  it('is served with the assignment flag off: a pool campaign is all unassigned', async () => {
    const other = floors[1]!;
    await seedRoster(other.campaigns[0]!, other, [null]);
    const res = await get('allocation', other.campaigns[0]!, other.supervisors[0]!, other);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ assignment_mode: 'pool', unassigned: { allocated: 60 }, imbalance: { high: [], empty: [] } });
    expect(body.agents.every((a: { allocated: number }) => a.allocated === 0)).toBe(true);
  });
});

describe('uploads', () => {
  it('lists the committed uploads with the uploader\'s name', async () => {
    await q(`INSERT INTO agency_ingest_jobs (tenant_id, campaign_id, s3_key, file_name, phone_column, status, created_by, rejected_by_reason, rows_read, accepted, rejected)
             VALUES ($1, $2, 'k', 'a.csv', 'Mobile', 'completed', $3, '{"invalid_phone": 3}'::jsonb, 13, 10, 3),
                    ($1, $2, 'k', 'dry.csv', 'Mobile', 'completed', $3, '{}'::jsonb, 1, 1, 0)`, [floor.tenant, C(6), sup().id]);
    await q(`UPDATE agency_ingest_jobs SET dry_run = true WHERE file_name = 'dry.csv'`);
    const body = await ok('uploads', C(6));
    expect(body.uploads).toEqual([expect.objectContaining({
      file_name: 'a.csv', uploaded_by: { user_id: sup().id, name: 'account_admin 0.0' }, status: 'completed', mode: 'append',
      rows_read: 13, accepted: 10, rejected: 3, rejected_by_reason: { invalid_phone: 3 }, duplicates: 0, dedupe_column: null,
      has_rejected_export: false,
    })]);
  });
});
