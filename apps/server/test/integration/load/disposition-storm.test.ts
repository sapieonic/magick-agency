import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ─── The disposition storm, with the supervisors watching ───────────────────────
 *
 * The end of a busy minute: every agent of the floor submits the dispositions of their
 * last calls at once, each one double-clicked or retried by the console (D identical copies
 * in flight together), a seeded share of them contradicted by a second, different code in
 * the same instant (two tabs, or a supervisor writing it up on behalf) — while "the dialer"
 * keeps landing new ended calls on the same campaigns, and every tenant's supervisors hammer
 * the dashboard reads (`/stats`, `/stats/series`, `/attempts`, `/contacts`, `/activity`).
 *
 * Through the real app: the public disposition route, `callCore`, the internal handler's
 * guarded UPDATE (`recordDisposition`: same code ⇒ success, different code ⇒ 409) and the
 * disposition policy's contact transition.
 *
 * What it pins:
 *  1. **Exactly one code per attempt.** Every submit carrying the code the row ended with
 *     answers 200; every other one answers `409 already_dispositioned`; no 5xx.
 *     Mutation-checked: dropping the `disposition_code IS NULL OR disposition_code = $2`
 *     guard (`attempt.repository.ts`) lets a contradicting code overwrite the record and
 *     reds case 1.
 *  2. **Exactly-once effects.** Each contact lands in the state its winning code's policy
 *     names (`completed` / `pending` with the retry or callback instant / `suppressed`),
 *     no contact or attempt row is created by a disposition, no attempt count moves, and
 *     each accepted submit is audited once.
 *  3. **Reads under write load are consistent.** Every stats payload a supervisor read
 *     mid-storm satisfies the payload's own invariants (parts never exceed their whole,
 *     the floor tally equals the roster, counters never go backwards between one
 *     supervisor's successive reads), every series bucket has `connected ≤ attempts`, no
 *     read 5xxs, and Postgres records no deadlock.
 *  4. **The final dashboard equals the database.**
 *  5. `it.fails` — a DEFECT, see the case: a same-code replay of an OLD attempt's
 *     disposition re-runs the contact transition, resurrecting a contact a later call
 *     already completed.
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { randomUUID } from 'node:crypto';
import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { createRng, scaled } from '../../helpers/load-scale.js';
import {
  call, deadlockCount, drainAudits, expectHealthy, foreignIdsIn, foreignIdsOf, scalar, seedFloor, startLoadApp,
  stopLoadApp, verifyTestToken, type Actor, type LoadApp, type TenantFloor,
} from './load-harness.js';

const TENANTS = 2;
const AGENTS = scaled(20);
const CALLS_PER_AGENT = 3;
const COPIES = 3;
const SUPERVISORS = 3;
const rng = createRng();

let loaded: LoadApp;
let floors: TenantFloor[];
const app = () => loaded.app;

interface Seeded { attempt: string; contact: string; agent: Actor; floor: TenantFloor }
let seeded: Seeded[] = [];
const sessionOf = new Map<string, string>();

beforeAll(async () => {
  console.log(`[disposition-storm] seed=${rng.seed} tenants=${TENANTS} agents/tenant=${AGENTS} calls/agent=${CALLS_PER_AGENT}`);
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  // The supervisors poll with no pause at all, far past the per-IP ceiling a real dashboard
  // stays under; the limiter is `rate-limit-bursts.test.ts`'s subject, not this one's.
  loaded = await startLoadApp({ configure: (c) => ({ ...c, rateLimit: { ...c.rateLimit, max: 1_000_000 } }) });
});

afterAll(async () => {
  await stopLoadApp(loaded);
});

let phoneSeq = 0;
const nextPhone = () => `+9197${String(++phoneSeq).padStart(8, '0')}`;

/** One ended, bridged call for `sessionId` on a fresh contact: what wrap-up leaves behind. */
function endedCall(f: TenantFloor, sessionId: string | null, attemptNumber = 1, contactId: string = randomUUID()) {
  const now = Date.now();
  return {
    contact: { id: contactId, campaign_id: f.campaigns[0], tenant_id: f.tenant, account_id: f.account, phone_e164: nextPhone(), state: 'connected', attempt_count: 1 },
    attempt: {
      id: randomUUID(), campaign_id: f.campaigns[0], contact_id: contactId, tenant_id: f.tenant, account_id: f.account,
      attempt_number: attemptNumber, caller_id: '+919000000001', state: 'ended', outcome: 'connected', reserved_agent_id: sessionId,
      dialed_at: new Date(now - 120_000), answered_at: new Date(now - 100_000), bridged_at: new Date(now - 99_000), ended_at: new Date(now - 10_000),
    },
  };
}

async function insertRows(table: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]!);
  const values: unknown[] = [];
  const tuples = rows.map((r) => `(${cols.map((c) => { values.push(r[c]); return `$${values.length}`; }).join(', ')})`);
  await getTestPool().query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}`, values);
}

beforeEach(async () => {
  await truncateAll();
  floors = await seedFloor({ tenants: TENANTS, agentsPerTenant: AGENTS, supervisorsPerTenant: SUPERVISORS, campaignStatus: 'running' });
  seeded = [];
  sessionOf.clear();
  const sessions: Record<string, unknown>[] = [];
  const contacts: Record<string, unknown>[] = [];
  const attempts: Record<string, unknown>[] = [];
  for (const f of floors) {
    for (const agent of f.agents) {
      const sessionId = randomUUID();
      sessionOf.set(agent.id, sessionId);
      sessions.push({ id: sessionId, tenant_id: f.tenant, account_id: f.account, campaign_id: f.campaigns[0], agent_user_id: agent.id, state: 'wrapup' });
      for (let i = 0; i < CALLS_PER_AGENT; i++) {
        const c = endedCall(f, sessionId);
        contacts.push(c.contact);
        attempts.push(c.attempt);
        seeded.push({ attempt: c.attempt.id, contact: c.contact.id, agent, floor: f });
      }
    }
    // The rest of the roster: untouched pending contacts, so the strip has every bucket.
    for (let i = 0; i < 30; i++) {
      contacts.push({ id: randomUUID(), campaign_id: f.campaigns[0], tenant_id: f.tenant, account_id: f.account, phone_e164: nextPhone(), state: 'pending', attempt_count: 0 });
    }
  }
  await insertRows('agency_agent_sessions', sessions);
  await insertRows('agency_contacts', contacts);
  await insertRows('agency_call_attempts', attempts);
});

/** The submit body for a code: a callback needs its instant. */
const CALLBACK_AT = new Date(Date.now() + 2 * 86_400_000);
CALLBACK_AT.setUTCHours(11, 0, 0, 0);
function bodyFor(code: string) {
  return code === 'callback' ? { disposition_code: code, callback_at: CALLBACK_AT.toISOString() } : { disposition_code: code };
}
const CODES = ['interested', 'not_interested', 'voicemail', 'callback', 'do_not_call'];

/** What the policy makes of a contact for each code. */
function expectedContact(code: string): { state: string; next?: 'retry' | 'callback' } {
  switch (code) {
    case 'interested': case 'not_interested': return { state: 'completed' };
    case 'voicemail': return { state: 'pending', next: 'retry' };
    case 'callback': return { state: 'pending', next: 'callback' };
    case 'do_not_call': return { state: 'suppressed' };
    default: throw new Error(code);
  }
}

interface StatsRead { at: number; body: Record<string, number> & { agents: unknown[]; agents_by_state: Record<string, number> } }

function checkStatsInvariants(s: StatsRead['body'], label: string) {
  const parts = s.contacts_pending + s.contacts_in_flight + s.contacts_completed + s.contacts_suppressed + s.contacts_exhausted;
  expect(parts, `${label}: contact states exceed contacts_total`).toBeLessThanOrEqual(s.contacts_total);
  expect(s.retries_pending, label).toBeLessThanOrEqual(s.contacts_pending);
  expect(s.attempts_connected, label).toBeLessThanOrEqual(s.attempts_total);
  expect(s.attempts_live, label).toBeLessThanOrEqual(s.attempts_total);
  expect(s.answered_24h, `${label}: answered > dialed`).toBeLessThanOrEqual(s.attempts_total);
  const bridged = s.human_connects + s.machine_connects + s.unclassified_connects;
  expect(bridged, label).toBeLessThanOrEqual(s.attempts_total);
  expect(s.attempts_success, label).toBeLessThanOrEqual(bridged);
  const tally = Object.values(s.agents_by_state).reduce((a, b) => a + b, 0);
  expect(tally, `${label}: agents_by_state disagrees with the roster`).toBe(s.agents.length);
}

describe('the disposition storm (integration, load)', () => {
  it('1–4. every agent dispositions at once, duplicated and contradicted, while calls land and supervisors read', async () => {
    const deadlocksBefore = await deadlockCount();
    const plan = seeded.map((s) => ({
      ...s,
      code: rng.pick(CODES),
      rival: rng.chance(0.3) ? rng.pick(CODES) : null,
      rivalBySupervisor: rng.chance(0.5),
    }));

    let storming = true;
    let landed = 0;
    const reads: Array<{ floor: TenantFloor; sup: Actor; stats: StatsRead[] }> = [];
    const readBodies: Array<{ floor: TenantFloor; body: string }> = [];

    // "The dialer": new ended calls keep landing on the same campaigns during the storm.
    const dialer = (async () => {
      while (storming) {
        const f = rng.pick(floors);
        const c = endedCall(f, null);
        await insertRows('agency_contacts', [c.contact]);
        await insertRows('agency_call_attempts', [c.attempt]);
        landed++;
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    // The supervisors, hammering every dashboard read until the storm is over.
    const series = `from=${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)}&bucket=day`;
    const watchers = floors.flatMap((f) => f.supervisors.map(async (sup) => {
      const mine: StatsRead[] = [];
      reads.push({ floor: f, sup, stats: mine });
      const c = f.campaigns[0];
      const urls = [`/proxy/agency/campaigns/${c}/stats`, `/proxy/agency/campaigns/${c}/stats/series?${series}`,
        `/proxy/agency/campaigns/${c}/attempts?limit=50`, `/proxy/agency/campaigns/${c}/contacts?limit=50`,
        `/proxy/agency/campaigns/${c}/activity`];
      let i = 0;
      while (storming || i < urls.length) {
        const url = urls[i++ % urls.length]!;
        const res = await call(app(), 'GET', url, sup, f);
        expectHealthy(res, `${sup.id} ${url}`);
        expect(res.statusCode, `${url}: ${res.body.slice(0, 200)}`).toBe(200);
        readBodies.push({ floor: f, body: res.body });
        if (url.endsWith('/stats')) mine.push({ at: Date.now(), body: res.json() });
        if (url.includes('/stats/series')) {
          for (const b of res.json().buckets as Array<{ attempts: number; connected: number }>) {
            expect(b.connected, 'series bucket: connected > attempts').toBeLessThanOrEqual(b.attempts);
          }
        }
      }
    }));

    // The storm.
    const submits = plan.flatMap((p) => {
      const agentSubmit = () => call(app(), 'POST', `/proxy/agency/attempts/${p.attempt}/disposition`, p.agent, p.floor, bodyFor(p.code))
        .then((res) => ({ p, code: p.code, res }));
      const out = Array.from({ length: COPIES }, agentSubmit);
      if (p.rival) {
        const who = p.rivalBySupervisor ? p.floor.supervisors[0]! : p.agent;
        out.push(call(app(), 'POST', `/proxy/agency/attempts/${p.attempt}/disposition`, who, p.floor, bodyFor(p.rival))
          .then((res) => ({ p, code: p.rival!, res })));
      }
      return out;
    });
    const answers = await Promise.all(rng.shuffle(submits));
    storming = false;
    await Promise.all([dialer, ...watchers]);

    // ── 1. exactly one code per attempt ──────────────────────────────────────
    const { rows } = await getTestPool().query<{ id: string; disposition_code: string | null; contact_id: string }>(
      'SELECT id, disposition_code, contact_id FROM agency_call_attempts WHERE id = ANY($1::uuid[])', [plan.map((p) => p.attempt)]);
    const winner = new Map(rows.map((r) => [r.id, r.disposition_code]));
    let accepted = 0;
    for (const { p, code, res } of answers) {
      expectHealthy(res, `disposition ${p.attempt}`);
      const won = winner.get(p.attempt);
      expect(won, `${p.attempt} has no disposition`).toBeTruthy();
      expect([p.code, p.rival]).toContain(won);
      if (code === won) {
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toMatchObject({ attempt_id: p.attempt, contact_id: p.contact, disposition_code: won });
        accepted++;
      } else {
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().code).toBe('already_dispositioned');
      }
    }

    // ── 2. exactly-once effects ──────────────────────────────────────────────
    const contacts = await getTestPool().query<{ id: string; state: string; next_attempt_at: Date; attempt_count: number; last_disposition: string }>(
      'SELECT id, state, next_attempt_at, attempt_count, last_disposition FROM agency_contacts WHERE id = ANY($1::uuid[])', [plan.map((p) => p.contact)]);
    const byId = new Map(contacts.rows.map((r) => [r.id, r]));
    for (const p of plan) {
      const won = winner.get(p.attempt)!;
      const c = byId.get(p.contact)!;
      const want = expectedContact(won);
      expect({ state: c.state, last: c.last_disposition, count: c.attempt_count }, `${p.contact} after ${won}`)
        .toEqual({ state: want.state, last: won, count: 1 });
      if (want.next === 'callback') expect(c.next_attempt_at.toISOString()).toBe(CALLBACK_AT.toISOString());
      if (want.next === 'retry') {
        const minutes = (c.next_attempt_at.getTime() - Date.now()) / 60_000;
        expect(minutes, 'voicemail retry instant').toBeGreaterThan(200);
        expect(minutes).toBeLessThan(241);
      }
    }
    // Dispositions create nothing: the rows are the seed plus what the dialer landed.
    expect(await scalar('SELECT count(*)::int AS n FROM agency_call_attempts')).toBe(seeded.length + landed);
    expect(await scalar('SELECT count(*)::int AS n FROM agency_contacts')).toBe(seeded.length + landed + 30 * TENANTS);
    await drainAudits();
    expect(await scalar(`SELECT count(*)::int AS n FROM platform_audit_log WHERE action = 'agency_disposition.created'`)).toBe(accepted);
    expect(await scalar(`SELECT count(DISTINCT resource_id)::int AS n FROM platform_audit_log WHERE action = 'agency_disposition.created'`)).toBe(plan.length);

    // ── 3. reads under write load ────────────────────────────────────────────
    let statsReads = 0;
    for (const { floor, stats } of reads) {
      let prev: StatsRead['body'] | null = null;
      for (const r of stats) {
        statsReads++;
        checkStatsInvariants(r.body, `stats ${floor.campaigns[0]}`);
        if (prev) {
          for (const k of ['attempts_total', 'attempts_connected', 'contacts_total', 'contacts_completed', 'contacts_suppressed', 'human_connects', 'machine_connects'] as const) {
            expect(r.body[k], `${k} went backwards between two reads`).toBeGreaterThanOrEqual(prev[k]);
          }
        }
        prev = r.body;
      }
    }
    expect(statsReads).toBeGreaterThan(0);
    for (const { floor, body } of readBodies) expect(foreignIdsIn(body, foreignIdsOf(floors, floor))).toEqual([]);
    expect(await deadlockCount()).toBe(deadlocksBefore);

    // ── 4. the final dashboard equals the database ───────────────────────────
    for (const f of floors) {
      const res = await call(app(), 'GET', `/proxy/agency/campaigns/${f.campaigns[0]}/stats`, f.supervisors[0]!, f);
      expect(res.statusCode).toBe(200);
      const s = res.json();
      const truth = await getTestPool().query<Record<string, number>>(
        `SELECT count(*)::int AS contacts_total,
                count(*) FILTER (WHERE state = 'completed')::int AS contacts_completed,
                count(*) FILTER (WHERE state = 'suppressed')::int AS contacts_suppressed,
                count(*) FILTER (WHERE state = 'pending')::int AS contacts_pending
           FROM agency_contacts WHERE campaign_id = $1`, [f.campaigns[0]]);
      expect(s).toMatchObject(truth.rows[0]!);
      expect(s.attempts_total).toBe(await scalar('SELECT count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = $1', [f.campaigns[0]]));
      checkStatsInvariants(s, 'final');
    }
  }, 60_000);

  /**
   * ── DEFECT: a stale same-code replay resurrects a completed contact ──────────────
   *
   * A same-code submit is an idempotent 200 by design (the console retries on a network
   * blip), and the route deliberately never reads the incumbent code — the guarded UPDATE
   * decides. But everything AFTER that UPDATE runs again on a replay, including
   * `agencyContactRepository.markState(contact, <policy state>)`. So a replay of an OLD
   * attempt's disposition — the console flushing a queued retry, or a supervisor
   * re-submitting a write-up from the attempt history — after a LATER call has already
   * settled the contact moves the contact back: here `voicemail` on call 1, `interested` on
   * call 2 (contact `completed`), then the call-1 retry arrives and the contact is `pending`
   * with a future `next_attempt_at` — a customer who said yes is dialed again. The fix is a
   * policy decision (should a disposition on a superseded attempt move the contact at all?),
   * so it is left failing rather than guessed at.
   */
  it.fails('5. a late replay of an old attempt\'s disposition does not move a contact a later call settled', async () => {
    const f = floors[0]!;
    const agent = f.agents[0]!;
    const first = seeded.find((s) => s.agent === agent)!;
    const r1 = await call(app(), 'POST', `/proxy/agency/attempts/${first.attempt}/disposition`, agent, f, { disposition_code: 'voicemail' });
    expect(r1.statusCode, r1.body).toBe(200);

    // The retry dial: call 2 on the same contact, which the agent closes as a sale.
    const second = endedCall(f, sessionOf.get(agent.id)!, 2, first.contact).attempt;
    await insertRows('agency_call_attempts', [second]);
    const r2 = await call(app(), 'POST', `/proxy/agency/attempts/${second.id}/disposition`, agent, f, { disposition_code: 'interested' });
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json().contact_state).toBe('completed');

    // The console's queued retry of call 1's submit finally gets through.
    const replay = await call(app(), 'POST', `/proxy/agency/attempts/${first.attempt}/disposition`, agent, f, { disposition_code: 'voicemail' });
    expect(replay.statusCode, replay.body).toBe(200);

    const { rows } = await getTestPool().query<{ state: string }>('SELECT state FROM agency_contacts WHERE id = $1', [first.contact]);
    expect(rows[0]!.state).toBe('completed');
  });
});
