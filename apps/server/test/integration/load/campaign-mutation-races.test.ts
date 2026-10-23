import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ─── Supervisors racing on one campaign ─────────────────────────────────────────
 *
 * Two or three supervisors on one dashboard press Start / Pause / Resume / Stop and save
 * the builder at the same moment. Through the real routes: the public lifecycle handlers
 * (actor resolution, platform audit row), `callCore`, the internal `transition` (status
 * guard, roster gate, `uq_agency_campaign_running`, the `audit_logs` row) and the guarded
 * `transitionStatus` UPDATE; the public and internal PATCH.
 *
 * ── Forcing the interleaving instead of hoping for it ───────────────────────────
 * Every route reads the campaign first (the `ownedCampaign` preHandler) and writes it
 * last. {@link whileRowLocked} holds the campaign row `FOR UPDATE` on a side connection:
 * plain reads pass, every UPDATE queues behind the lock. The suite waits until exactly the
 * expected writers are queued (`pg_stat_activity`), then commits — so "both read the old
 * row, both write" happens every run, not one run in a hundred.
 *
 * What it pins:
 *  1. Racing transitions never double-apply: from `running`, three Pauses and three Stops
 *     queued together leave exactly one Pause and at most one Stop applied, a legal final
 *     status, and exactly one `audit_logs` and one `platform_audit_log` row per 200.
 *     Mutation-checked: dropping `AND status = ANY($2::varchar[])` from `transitionStatus`
 *     lets every queued Pause re-apply (three 200s) and reds case 1.
 *  2. A free-for-all over several campaigns and rounds: every campaign ends in a status its
 *     accepted transitions can reach from where it started, and every 200 is audited once
 *     in each trail.
 *  3. Two campaigns of one account started at once: exactly one runs, the other gets the
 *     documented `409 another_campaign_running` (`uq_agency_campaign_running`).
 *  4. Concurrent PATCHes of DIFFERENT fields both land (column-scoped update, no lost update).
 *  5. `it.fails` — DEFECT: the lifecycle audit's `from` is the status the preHandler READ,
 *     not the one the guarded UPDATE moved from.
 *  6. `it.fails` — DEFECT: two individually-valid PATCHes of the calling window combine
 *     into the invalid start == end window the validator exists to refuse (write skew).
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { createRng, scaled } from '../../helpers/load-scale.js';
import {
  call, drainAudits, expectHealthy, scalar, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from './load-harness.js';

const rng = createRng();
const CAMPAIGNS = scaled(6);
const ROUNDS = 4;

let loaded: LoadApp;
let floor: TenantFloor;
const app = () => loaded.app;

beforeAll(async () => {
  console.log(`[campaign-mutation-races] seed=${rng.seed} campaigns=${CAMPAIGNS} rounds=${ROUNDS}`);
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp({ configure: (c) => ({ ...c, rateLimit: { ...c.rateLimit, max: 1_000_000 } }) });
});

beforeEach(async () => {
  await truncateAll();
  floor = (await seedFloor({ tenants: 1, agentsPerTenant: 0, supervisorsPerTenant: 3, campaignsPerTenant: CAMPAIGNS }))[0]!;
  // A dialable roster on every campaign, so `/start` is never refused for want of one.
  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const c of floor.campaigns) {
    for (let i = 0; i < 3; i++) {
      values.push(randomUUID(), c, floor.tenant, floor.account, `+9196${String(tuples.length).padStart(8, '0')}`);
      const n = values.length;
      tuples.push(`($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n}, 'pending')`);
    }
  }
  await getTestPool().query(
    `INSERT INTO agency_contacts (id, campaign_id, tenant_id, account_id, phone_e164, state) VALUES ${tuples.join(', ')}`, values);
});

afterAll(async () => {
  await stopLoadApp(loaded);
});

type Op = 'start' | 'pause' | 'resume' | 'stop';
const TARGET: Record<Op, string> = { start: 'running', pause: 'paused', resume: 'running', stop: 'stopping' };

const sup = (i: number): Actor => floor.supervisors[i % floor.supervisors.length]!;
const control = (campaign: string, op: Op, who: Actor) =>
  call(app(), 'POST', `/proxy/agency/campaigns/${campaign}/${op}`, who, floor, {});

async function setStatus(campaign: string, status: string) {
  await getTestPool().query('UPDATE agency_campaigns SET status = $2 WHERE id = $1', [campaign, status]);
}
async function statusOf(campaign: string): Promise<string> {
  const { rows } = await getTestPool().query<{ status: string }>('SELECT status FROM agency_campaigns WHERE id = $1', [campaign]);
  return rows[0]!.status;
}

/** Writers queued on a row lock of agency_campaigns right now. */
async function queuedWriters(): Promise<number> {
  return scalar(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE agency_campaigns%'`);
}
async function waitForQueued(n: number) {
  const deadline = Date.now() + 10_000;
  while ((await queuedWriters()) < n) {
    if (Date.now() > deadline) throw new Error(`expected ${n} queued writers, saw ${await queuedWriters()}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Hold `campaign`'s row lock while `fire` launches requests; `waves` are fired one after
 * another, each released only once its `queued` writers are waiting, so the lock queue
 * order is the wave order. Commits, then resolves with every answer.
 */
async function whileRowLocked(
  campaign: string,
  waves: Array<{ fire: () => Array<Promise<LightMyRequestResponse>>; queued: number }>,
): Promise<LightMyRequestResponse[]> {
  const holder = await getTestPool().connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM agency_campaigns WHERE id = $1 FOR UPDATE', [campaign]);
    const inflight: Array<Promise<LightMyRequestResponse>> = [];
    let expected = 0;
    for (const wave of waves) {
      inflight.push(...wave.fire());
      expected += wave.queued;
      await waitForQueued(expected);
    }
    await holder.query('COMMIT');
    return await Promise.all(inflight);
  } catch (err) {
    await holder.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    holder.release();
  }
}

async function auditCounts(campaign: string) {
  await drainAudits();
  const core = await getTestPool().query<{ event_type: string; from: string; to: string }>(
    `SELECT event_type, event_data->>'from' AS from, event_data->>'to' AS to FROM audit_logs
      WHERE event_data->>'campaign_id' = $1 ORDER BY timestamp`, [campaign]);
  const platform = await scalar(
    `SELECT count(*)::int AS n FROM platform_audit_log WHERE campaign_id = $1 AND action LIKE 'agency_campaign.%'`, [campaign]);
  return { core: core.rows, platform };
}

describe('racing campaign mutations (integration, load)', () => {
  it('1. three Pauses and three Stops queued on one running campaign: none double-applies, each 200 audited once', async () => {
    const c = floor.campaigns[0]!;
    await setStatus(c, 'running');
    const answers = await whileRowLocked(c, [
      { fire: () => [0, 1, 2].map((i) => control(c, 'pause', sup(i))), queued: 3 },
      { fire: () => [0, 1, 2].map((i) => control(c, 'stop', sup(i))), queued: 3 },
    ]);
    for (const res of answers) {
      expectHealthy(res, 'lifecycle');
      expect([200, 409], res.body).toContain(res.statusCode);
      if (res.statusCode === 409) expect(res.json().code).toBe('invalid_campaign_transition');
    }
    const ok = answers.filter((r) => r.statusCode === 200);
    // The first queued Pause wins; the others find `paused` and refuse. One Stop then
    // applies (paused → stopping); the other two find `stopping` and refuse.
    expect(answers.slice(0, 3).filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(answers.slice(3).filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await statusOf(c)).toBe('stopping');
    const audits = await auditCounts(c);
    expect(audits.core.map((a) => a.event_type).sort()).toEqual(['agency_campaign.paused', 'agency_campaign.stopping']);
    expect(audits.platform).toBe(ok.length);
  });

  it('2. a free-for-all over every campaign: final statuses are reachable from the accepted transitions, each audited once', async () => {
    const start = new Map<string, string>();
    // One running campaign per account (`uq_agency_campaign_running`), the rest paused.
    for (const [i, c] of floor.campaigns.entries()) {
      const s = i === 0 ? 'running' : 'paused';
      start.set(c, s);
      await setStatus(c, s);
    }
    const accepted = new Map<string, Op[]>(floor.campaigns.map((c) => [c, []]));
    let total200 = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const ops = floor.campaigns.flatMap((c) =>
        Array.from({ length: 5 }, (_, i) => ({ c, op: rng.pick<Op>(['start', 'pause', 'resume', 'stop']), who: sup(i) })));
      const answers = await Promise.all(rng.shuffle(ops).map(async (o) => ({ ...o, res: await control(o.c, o.op, o.who) })));
      for (const { c, op, res } of answers) {
        expectHealthy(res, `${op} ${c}`);
        if (res.statusCode === 200) {
          accepted.get(c)!.push(op);
          total200++;
          expect(res.json().status, `${op} answered with the wrong status`).toBe(TARGET[op]);
        } else {
          expect(res.statusCode, res.body).toBe(409);
          // `another_campaign_running`: one running campaign per account.
          expect(['invalid_campaign_transition', 'another_campaign_running']).toContain(res.json().code);
        }
      }
    }
    // At most one running campaign in the account, whatever happened.
    expect(await scalar(`SELECT count(*)::int AS n FROM agency_campaigns WHERE status = 'running'`)).toBeLessThanOrEqual(1);
    for (const c of floor.campaigns) {
      const ops = accepted.get(c)!;
      const into = (s: string) => ops.filter((op) => TARGET[op] === s).length;
      const final = await statusOf(c);
      // running ⇄ paused alternate; stopping is terminal and entered at most once.
      const run = into('running') + (start.get(c) === 'running' ? 1 : 0);
      const pau = into('paused') + (start.get(c) === 'paused' ? 1 : 0);
      expect(into('stopping'), `${c}: stopped twice`).toBeLessThanOrEqual(1);
      if (final === 'stopping') {
        expect(into('stopping')).toBe(1);
        expect(Math.abs(run - pau), `${c}: ${ops.join(',')}`).toBeLessThanOrEqual(1);
      } else {
        expect(into('stopping')).toBe(0);
        expect(final === 'running' ? run - pau : pau - run, `${c} ${start.get(c)}→${final}: ${ops.join(',')}`).toBe(1);
      }
    }
    await drainAudits();
    expect(await scalar(`SELECT count(*)::int AS n FROM audit_logs WHERE event_type LIKE 'agency_campaign.%'`)).toBe(total200);
    expect(await scalar(`SELECT count(*)::int AS n FROM platform_audit_log WHERE action LIKE 'agency_campaign.%'`)).toBe(total200);
  });

  it('3. two campaigns of one account started at once: exactly one runs, the other is told why', async () => {
    const [a, b] = floor.campaigns as [string, string];
    const answers = await Promise.all([control(a, 'start', sup(0)), control(b, 'start', sup(1)), control(a, 'start', sup(2)), control(b, 'start', sup(0))]);
    for (const res of answers) expectHealthy(res, 'start');
    const ok = answers.filter((r) => r.statusCode === 200);
    expect(ok.length).toBe(1);
    for (const res of answers.filter((r) => r.statusCode !== 200)) {
      expect(res.statusCode).toBe(409);
      expect(['another_campaign_running', 'invalid_campaign_transition']).toContain(res.json().code);
    }
    expect(await scalar(`SELECT count(*)::int AS n FROM agency_campaigns WHERE status = 'running'`)).toBe(1);
  });

  it('4. concurrent PATCHes of different fields both land: no lost update', async () => {
    const c = floor.campaigns[0]!;
    const answers = await whileRowLocked(c, [{
      fire: () => [
        call(app(), 'PATCH', `/proxy/agency/campaigns/${c}`, sup(0), floor, { name: 'Renamed under load' }),
        call(app(), 'PATCH', `/proxy/agency/campaigns/${c}`, sup(1), floor, { wrapup_seconds: 45 }),
      ],
      queued: 2,
    }]);
    for (const res of answers) {
      expectHealthy(res, 'patch');
      expect(res.statusCode, res.body).toBe(200);
    }
    const { rows } = await getTestPool().query('SELECT name, wrapup_seconds FROM agency_campaigns WHERE id = $1', [c]);
    expect(rows[0]).toEqual({ name: 'Renamed under load', wrapup_seconds: 45 });
  });

  /**
   * ── DEFECT: the lifecycle audit records the status it READ, not the one it changed ──
   *
   * `transition()` (`agency-campaigns/lifecycle.ts`) writes `audit_logs.event_data.from`
   * as `campaign.status` from the `ownedCampaign` preHandler's read, while the guarded
   * `transitionStatus` UPDATE accepts any status in the route's from-list and is
   * re-evaluated on the row as it is when its lock is granted. A Stop that read `running`
   * and queued behind a Pause applies `paused → stopping` — and is audited
   * `running → stopping`. The trail then shows two exits from `running` and none from
   * `paused`. The fix needs the pre-update status from the UPDATE itself (the
   * `FROM (SELECT … FOR UPDATE)` idiom `sessionTransitionSql` uses), which changes the
   * statement several callers and SQL-text unit tests pin; left failing.
   */
  it.fails('5. the audit trail names the status each transition actually moved from', async () => {
    const c = floor.campaigns[0]!;
    await setStatus(c, 'running');
    const answers = await whileRowLocked(c, [
      { fire: () => [control(c, 'pause', sup(0))], queued: 1 },
      { fire: () => [control(c, 'stop', sup(1))], queued: 1 },
    ]);
    expect(answers.map((r) => r.statusCode)).toEqual([200, 200]);
    const audits = await auditCounts(c);
    expect(audits.core.map((a) => `${a.from}→${a.to}`).sort()).toEqual(['paused→stopping', 'running→paused']);
  });

  /**
   * ── DEFECT: calling-window write skew between two PATCHes ───────────────────────
   *
   * The window rule ("start and end cannot be the same instant — the campaign would never
   * dial", `validateCallingWindow`) is checked against the row the preHandler READ, and the
   * UPDATE writes only the patched columns. Window 09:00–20:00: one supervisor moves the
   * start to 10:00 (valid against end 20:00), another moves the end to 10:00 (valid against
   * start 09:00); both commit and the campaign stores 10:00–10:00, which the validator
   * refuses from either PATCH alone and which never dials. A fix needs the check and the
   * write in one transaction (or the read window as an UPDATE predicate with a new 409 for
   * the console); left failing.
   */
  it.fails('6. two PATCHes cannot combine into the start == end window either one alone is refused', async () => {
    const c = floor.campaigns[0]!;
    await getTestPool().query(`UPDATE agency_campaigns SET calling_window_start = '09:00', calling_window_end = '20:00' WHERE id = $1`, [c]);
    const answers = await whileRowLocked(c, [{
      fire: () => [
        call(app(), 'PATCH', `/proxy/agency/campaigns/${c}`, sup(0), floor, { calling_window_start: '10:00' }),
        call(app(), 'PATCH', `/proxy/agency/campaigns/${c}`, sup(1), floor, { calling_window_end: '10:00' }),
      ],
      queued: 2,
    }]);
    for (const res of answers) expectHealthy(res, 'patch');
    const { rows } = await getTestPool().query<{ s: string; e: string }>(
      'SELECT calling_window_start::text AS s, calling_window_end::text AS e FROM agency_campaigns WHERE id = $1', [c]);
    expect(rows[0]!.s).not.toBe(rows[0]!.e);
  });
});
