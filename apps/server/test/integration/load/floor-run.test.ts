import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { scaled } from '../../helpers/load-scale.js';

// A real meter provider before any product module creates its instruments, so the
// counter-vs-table cross-check reads what an export would carry. The log level is
// lowered unless the caller set one: a floor run settles thousands of attempts, and
// an info line per settle is minutes of terminal output and no evidence.
await vi.hoisted(async () => {
  process.env['LOG_LEVEL'] ??= 'warn';
  const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
  installMetricReader();
});

vi.mock('@magick-agency/db', async () => {
  const { floorPool } = await import('./floor-pool.js');
  return { getPool: () => floorPool() };
});
vi.mock('@magick-agency/db/connection', async () => {
  const { floorPool } = await import('./floor-pool.js');
  return { getPool: () => floorPool() };
});
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));

const {
  createFloorWorld, closeFloorPool, expectedDials, attemptRows, contactStateCounts,
} = await import('./floor-harness.js');
const { metricValue } = await import('../agency/chaos/harness.js');
const { refreshAbandonmentWindow } = await import('../../../src/agency/abandonment-metrics.js');
const { breachedRows } = await import('../../../src/agency/abandonment-guardrail.js');
const { agencyAbandonmentRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { ABANDONED_ATTEMPT_PREDICATE_SQL } = await import('@magick-agency/domain/abandonment-predicate');

type World = Awaited<ReturnType<typeof createFloorWorld>>;

/**
 * ─── A FULL FLOOR, WORKED TO EXHAUSTION ─────────────────────────────────────
 *
 * A hundred agents on five campaigns, across three tenants and five accounts,
 * working rosters of thousands of contacts through the real pacing engine, dialer,
 * station registry and agent state machine, against a carrier whose calls ring,
 * talk and end over many rounds with a seeded mix of every outcome the dialer
 * classifies. The run goes on until there is nothing left to dial.
 *
 * The invariants are read from Postgres and Redis after EVERY round, not only at
 * the end, because the failures that matter at scale are transient: a contact
 * dialled twice for one round, an agent holding two calls between a release and a
 * reservation, a reservation that outlives its attempt. An end-state check sees
 * none of those.
 *
 * The floor is shaped so each cap binds somewhere:
 *   A — the account cap equals the pool;
 *   B — the account cap (12) is BELOW the pool (20), so the cap, not the agents,
 *       is what paces it;
 *   C — a second tenant, ordinary;
 *   D — the DEFAULT retry policy (retries 15–120 minutes out), so its roster ends
 *       legitimately retry-scheduled rather than drained, and the campaign must
 *       stay `running` with that work outstanding;
 *   E — the cap ABOVE the pool, so the agents bind.
 * Every other campaign retries at once (`NO_DELAY_RETRY_POLICY`), so its roster
 * runs to exhaustion inside the test.
 *
 * Size scales with `LOAD_SCALE`; the seed is `LOAD_SEED` and is printed in every
 * violation.
 */

describe('full floor run (load)', () => {
  let world: World;

  beforeEach(truncateAll);
  afterEach(async () => {
    await world?.teardown();
    world = undefined as never;
  });
  afterAll(async () => {
    await closeFloorPool();
    await closeTestPool();
  });

  const contacts = (n: number) => scaled(n);
  const agentsN = (n: number) => scaled(n);

  it('works five rosters to exhaustion with every invariant holding at every round', async () => {
    world = await createFloorWorld({
      campaigns: [
        { label: 'A', tenant: 't1', account: 'a1', agents: agentsN(24), contacts: contacts(500), maxConcurrentCalls: agentsN(24) },
        { label: 'B', tenant: 't1', account: 'b1', agents: agentsN(20), contacts: contacts(400), maxConcurrentCalls: agentsN(12) },
        { label: 'C', tenant: 't2', account: 'c1', agents: agentsN(20), contacts: contacts(500), maxConcurrentCalls: agentsN(20) },
        {
          label: 'D', tenant: 't2', account: 'd1', agents: agentsN(16), contacts: contacts(300), maxConcurrentCalls: agentsN(16),
          // The shipped default: retries hours out. An empty JSONB is what a fresh
          // campaign row carries, and the policy resolves the defaults from it.
          campaign: { retry_policy: '{}' },
        },
        { label: 'E', tenant: 't3', account: 'e1', agents: agentsN(20), contacts: contacts(500), maxConcurrentCalls: agentsN(25) },
      ],
    });
    const seed = world.seed;
    const violations: string[] = [];
    const pacing: string[] = [];
    let peakLive = 0;

    const rounds = await world.runUntilDrained({
      maxRounds: scaled(3000),
      onRound: async (r) => {
        violations.push(...await world.checkInvariants());
        for (const [label, s] of Object.entries(r.campaigns)) {
          const want = expectedDials(s);
          if (s.attemptsCreated !== want) {
            pacing.push(`[seed ${seed}, round ${r.round}] ${label}: dialled ${s.attemptsCreated}, pacing law says ${want} `
              + `(available ${s.availableBefore}, live ${s.liveBefore}/${s.limit}, claimable ${s.claimableBefore}, ${s.status})`);
          }
        }
        peakLive = Math.max(peakLive, Object.values(r.campaigns).reduce((n, s) => n + s.liveBefore, 0));
        // The guardrail, on its own cadence: no running campaign may sit past its
        // ceiling after a refresh. On a floor with no churn there is nothing to
        // breach — reserve-before-dial means every answer has an agent.
        if (r.round % 10 === 0) {
          await refreshAbandonmentWindow();
          const breaches = breachedRows(await agencyAbandonmentRepository.window24h());
          for (const b of breaches) violations.push(`[seed ${seed}, round ${r.round}] campaign ${b.campaign_id} breached ${b.measured_pct}% and is still running`);
        }
        // Fail fast with the first few, rather than after thousands of rounds.
        if (violations.length > 0 || pacing.length > 0) {
          throw new Error([...violations, ...pacing].slice(0, 10).join('\n'));
        }
      },
    });

    expect(violations, violations.slice(0, 10).join('\n')).toEqual([]);
    expect(pacing, pacing.slice(0, 10).join('\n')).toEqual([]);
    const audit = await world.finalAudit();
    expect(audit, audit.slice(0, 20).join('\n')).toEqual([]);

    // ── The floor genuinely ran at scale ────────────────────────────────────
    const ids = world.campaigns.map((c) => c.id);
    const rows = await attemptRows(ids);
    const totalContacts = world.campaigns.reduce((s, c) => s + c.spec.contacts, 0);
    expect(rows.length, `seed ${seed}`).toBeGreaterThan(totalContacts);
    // Every kind of call happened, so no invariant passed for want of the case.
    const kinds = new Set(world.carrier.dials.map((d) => d.kind));
    expect([...kinds].sort(), `seed ${seed}`).toEqual(
      ['busy', 'connected_long', 'connected_short', 'failed', 'invalid', 'no_answer', 'ring_hangup', 'voicemail'],
    );
    // Concurrency was real: the floor held well over half its agents on calls at once.
    expect(peakLive, `seed ${seed}`).toBeGreaterThan(world.agents.length / 2);

    // ── Campaign end states ─────────────────────────────────────────────────
    for (const label of ['A', 'B', 'C', 'E']) {
      expect(await world.status(label), `campaign ${label}, seed ${seed}`).toBe('completed');
      const states = await contactStateCounts(world.campaign(label).id);
      expect(states['pending'] ?? 0, `campaign ${label}, seed ${seed}`).toBe(0);
    }
    // D's roster is legitimately retry-scheduled: pending, in the future, with at
    // least one attempt behind it; the campaign holds open for that work.
    expect(await world.status('D'), `seed ${seed}`).toBe('running');
    const { rows: dPending } = await getTestPool().query<{ n: number; future: number; dialled: number }>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE next_attempt_at > now())::int AS future,
              count(*) FILTER (WHERE attempt_count + our_fault_attempts > 0)::int AS dialled
         FROM agency_contacts WHERE campaign_id = $1 AND state = 'pending'`,
      [world.campaign('D').id],
    );
    expect(dPending[0]!.n, `seed ${seed}`).toBeGreaterThan(0);
    expect(dPending[0]!.future, `seed ${seed}`).toBe(dPending[0]!.n);
    expect(dPending[0]!.dialled, `seed ${seed}`).toBe(dPending[0]!.n);

    // ── B was paced by its account cap, never above it ──────────────────────
    const peakB = world.carrier.peakLiveByAccount.get(`${world.campaign('B').tenantId}:${world.campaign('B').accountId}`) ?? 0;
    expect(peakB, `seed ${seed}`).toBe(world.campaign('B').spec.maxConcurrentCalls);

    // ── Strict power dialing: no answered call ever lacked an agent ─────────
    const { rows: abandoned } = await getTestPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = ANY($1::uuid[]) AND (${ABANDONED_ATTEMPT_PREDICATE_SQL})`,
      [ids],
    );
    expect(abandoned[0]!.n, `seed ${seed}`).toBe(0);

    // ── The counters agree with the table, per campaign ─────────────────────
    for (const c of world.campaigns) {
      const answeredRows = rows.filter((r) => r.campaign_id === c.id && r.answered_at !== null).length;
      const answeredMetric = await metricValue('agency_answered_total', { campaign_id: c.id });
      expect(answeredMetric ?? 0, `campaign ${c.spec.label}, seed ${seed}`).toBe(answeredRows);
      expect(answeredRows, `campaign ${c.spec.label}, seed ${seed}`).toBeGreaterThan(0);
      expect(await metricValue('agency_abandoned_total', { campaign_id: c.id }) ?? 0).toBe(0);
    }

    // ── Every agent worked, and the longest-idle ordering spread the calls ──
    const perAgent = new Map<string, number>();
    for (const r of rows) perAgent.set(r.reserved_agent_id, (perAgent.get(r.reserved_agent_id) ?? 0) + 1);
    for (const a of world.agents) {
      expect(perAgent.get(a.sessionId) ?? 0, `agent ${a.label} took no call, seed ${seed}`).toBeGreaterThan(0);
    }

    console.info(`[floor-run] seed=${seed} agents=${world.agents.length} contacts=${totalContacts} `
      + `attempts=${rows.length} rounds=${rounds} peakLive=${peakLive}`);
  }, 600_000);
});
