import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { scaled } from '../../helpers/load-scale.js';
import type { PacingTickObservation } from '../../../src/agency/pacing-engine.js';

await vi.hoisted(async () => {
  process.env['LOG_LEVEL'] ??= 'warn';
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

const { createFloorWorld, closeFloorPool } = await import('./floor-harness.js');
const { splitHeadroom } = await import('../../../src/agency/pacing/round.js');

type World = Awaited<ReturnType<typeof createFloorWorld>>;
type RoundReport = Awaited<ReturnType<World['round']>>;
type Stat = RoundReport['campaigns'][string];

/**
 * ─── SEVERAL RUNNING CAMPAIGNS ON ONE ACCOUNT (decisions MC1, MC2, MC4) ─────
 *
 * Two campaigns of one account run at once on a real floor (Postgres, Redis, the
 * runtime, the floor carrier) on the engine's scheduled path, where one round ticks
 * both and splits the account's `max_concurrent_calls` between them:
 *
 *  - the account's live calls never exceed its limit, across both campaigns;
 *  - with both saturated the slots split evenly (within one), and every round the
 *    split is MC1's: fewest live calls first, all the headroom either can use;
 *  - a campaign with nothing due leaves the whole limit to the other;
 *  - a tick whose dials outlive its round (the carrier slow to take one) holds its
 *    granted, not yet inserted dials in the engine's pending-dial ledger, so the next
 *    round, where its sibling ticks alone, is not granted those slots again.
 *
 * Needs migration 0015 (two running campaigns on one account were refused by
 * `uq_agency_campaign_running` before it).
 */

function observe(world: World): PacingTickObservation[] {
  const seen: PacingTickObservation[] = [];
  world.runtime.pacing.registerTickObserver((o) => seen.push(o));
  return seen;
}

async function liveOf(campaignId: string): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = $1 AND state <> 'ended'`, [campaignId]);
  return rows[0]!.n;
}

async function accountLive(tenantId: string, accountId: string): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agency_call_attempts WHERE tenant_id = $1 AND account_id = $2 AND state <> 'ended'`,
    [tenantId, accountId]);
  return rows[0]!.n;
}

async function attemptsOf(campaignId: string): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = $1', [campaignId]);
  return rows[0]!.n;
}

/**
 * A round's spend against MC1, as data: the two campaigns together placed exactly what the
 * headroom and their demand allowed (`MIN(headroom, demandA + demandB)`), and each placed
 * its fair share within one (the odd slot of a tie goes by rotation).
 */
function shareViolations(r: RoundReport, limit: number, seed: number): string[] {
  const a = r.campaigns['A']!;
  const b = r.campaigns['B']!;
  const demand = (s: Stat) => (s.status === 'running' ? Math.max(0, Math.min(s.availableBefore, s.claimableBefore)) : 0);
  const spent = (s: Stat) => s.attemptsCreated + s.dncSuppressed;
  const headroom = Math.max(0, limit - a.liveBefore - b.liveBefore);
  const want = splitHeadroom(headroom, [
    { id: 'A', demand: demand(a), ownLive: a.liveBefore },
    { id: 'B', demand: demand(b), ownLive: b.liveBefore },
  ]);
  const out: string[] = [];
  const tag = `[seed ${seed}, round ${r.round}]`;
  const wantTotal = want.get('A')! + want.get('B')!;
  if (spent(a) + spent(b) !== wantTotal) {
    out.push(`${tag} placed ${spent(a)} + ${spent(b)}, the split says ${wantTotal} in all `
      + `(headroom ${headroom}; A live ${a.liveBefore} demand ${demand(a)}; B live ${b.liveBefore} demand ${demand(b)})`);
  }
  for (const [label, s] of [['A', a], ['B', b]] as const) {
    if (Math.abs(spent(s) - want.get(label)!) > 1) {
      out.push(`${tag} ${label} placed ${spent(s)}, its share is ${want.get(label)} `
        + `(headroom ${headroom}; A live ${a.liveBefore} demand ${demand(a)}; B live ${b.liveBefore} demand ${demand(b)})`);
    }
  }
  if (a.liveBefore + b.liveBefore + spent(a) + spent(b) > limit) {
    out.push(`${tag} ${a.liveBefore + b.liveBefore} live + ${spent(a) + spent(b)} new over the account limit ${limit}`);
  }
  return out;
}

/**
 * The engine waits up to 1 s (`PACING_SHARE_WAIT_MS`) for a campaign's report before
 * splitting without it; a loaded runner must not turn a slow read into a lone split here.
 * The wait itself is pinned in `test/unit/agency/pacing-round.test.ts`.
 */
function patientRounds(world: World): void {
  (world.runtime.pacing as unknown as { shareWaitMs: number }).shareWaitMs = 10_000;
}

describe('several running campaigns on one account (load)', () => {
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

  it('both saturated: the account limit holds across both, and the slots split evenly', async () => {
    const LIMIT = 2 * scaled(3);
    world = await createFloorWorld({
      scheduled: true,
      campaigns: [
        { label: 'A', tenant: 't1', account: 'm1', agents: scaled(8), contacts: scaled(200), maxConcurrentCalls: LIMIT },
        { label: 'B', tenant: 't1', account: 'm1', agents: scaled(8), contacts: scaled(200), maxConcurrentCalls: LIMIT },
      ],
    });
    patientRounds(world);
    const a = world.campaign('A');
    const b = world.campaign('B');
    expect(a.accountId).toBe(b.accountId);
    const seed = world.seed;

    // One round with the carrier holding every call: both campaigns want more than the
    // limit, neither has a call up, so the limit splits down the middle.
    await world.runtime.pacing.runRound();
    expect([await liveOf(a.id), await liveOf(b.id)]).toEqual([LIMIT / 2, LIMIT / 2]);
    expect(await accountLive(a.tenantId, a.accountId)).toBe(LIMIT);
    // At the limit: nothing more, however many agents wait.
    await world.runtime.pacing.runRound();
    expect(await accountLive(a.tenantId, a.accountId)).toBe(LIMIT);

    // Then a churning floor: calls end, agents come back, every round re-splits.
    const violations: string[] = [];
    for (let i = 0; i < scaled(60); i++) {
      const r = await world.round();
      violations.push(...await world.checkInvariants());
      violations.push(...shareViolations(r, LIMIT, seed));
      const live = await accountLive(a.tenantId, a.accountId);
      if (live > LIMIT) violations.push(`[seed ${seed}, round ${r.round}] ${live} live on the account, limit ${LIMIT}`);
      if (violations.length) throw new Error(violations.slice(0, 10).join('\n'));
    }
    const peak = world.carrier.peakLiveByAccount.get(`${a.tenantId}:${a.accountId}`) ?? 0;
    expect(peak, `seed ${seed}`).toBeLessThanOrEqual(LIMIT);
    expect(peak, `seed ${seed}: the limit never bound`).toBe(LIMIT);
    const [dialsA, dialsB] = [await attemptsOf(a.id), await attemptsOf(b.id)];
    expect(dialsA, `seed ${seed}`).toBeGreaterThan(LIMIT);
    expect(dialsB, `seed ${seed}`).toBeGreaterThan(LIMIT);
    expect(violations).toEqual([]);
  }, 300_000);

  it('a tick whose dials outlive its round: the next round does not grant its slots again (pending-dial ledger)', async () => {
    // Not scaled: the arithmetic below is exact. 3 + 3 granted in round 1, 8 agents each.
    const LIMIT = 6;
    world = await createFloorWorld({
      scheduled: true,
      campaigns: [
        { label: 'A', tenant: 't1', account: 'm3', agents: 8, contacts: 60, maxConcurrentCalls: LIMIT },
        { label: 'B', tenant: 't1', account: 'm3', agents: 8, contacts: 60, maxConcurrentCalls: LIMIT },
      ],
    });
    patientRounds(world);
    const a = world.campaign('A');
    const b = world.campaign('B');
    const seed = world.seed;
    const accountKey = `${a.tenantId}:${a.accountId}`;
    // The pending-dial ledger per account: the sum of the ticks' holds.
    const ledger = () => new Map([...(world.runtime.pacing as unknown as {
      pendingDials: Map<string, Set<{ remaining: number }>>;
    }).pendingDials].map(([k, holds]) => [k, [...holds].reduce((n, h) => n + h.remaining, 0)] as const));
    const seen = observe(world);

    // The carrier hangs on the round's FIRST dial (whichever campaign placed it), so that
    // campaign's tick, granted 3, holds 2 granted dials not yet inserted past its round.
    let answer!: () => void;
    const hung = new Promise<void>((resolve) => { answer = resolve; });
    let hungAttempt: string | null = null;
    world.carrier.admission = {
      admit: async (call) => {
        if (hungAttempt === null) {
          hungAttempt = call.attemptId;
          await hung;
        }
      },
      release: async () => {},
    };

    const first = world.runtime.pacing.runRound();
    await vi.waitFor(() => expect(hungAttempt).not.toBeNull(), { timeout: 15_000 });
    const { rows } = await getTestPool().query<{ campaign_id: string }>(
      'SELECT campaign_id FROM agency_call_attempts WHERE id = $1', [hungAttempt]);
    const slowId = rows[0]!.campaign_id;
    const other = slowId === a.id ? b : a;
    // The other campaign's tick ends: all 3 of its dials placed.
    await vi.waitFor(() => expect(seen.some((o) => o.campaignId === other.id && o.mode === 'full')).toBe(true),
      { timeout: 15_000 });
    expect(await liveOf(other.id), `seed ${seed}`).toBe(3);
    expect(await liveOf(slowId), `seed ${seed}`).toBe(1);
    expect(ledger().get(accountKey), `seed ${seed}`).toBe(2);

    // Round 2 passes the slow campaign by (still ticking); the other ticks alone with 5
    // agents free. 4 rows + 2 pending = the limit: it is granted nothing. Without the
    // ledger it would read 4 live and dial 2 more, and the account would end at 8.
    await world.runtime.pacing.runRound();
    const lone = seen.filter((o) => o.campaignId === other.id).at(-1);
    expect(lone, `seed ${seed}`).toMatchObject({ mode: 'full', plan: { occupied: LIMIT, toDial: 0, idle: 'no_slots' } });

    answer();
    await first;
    world.carrier.admission = null;
    expect(await accountLive(a.tenantId, a.accountId), `seed ${seed}`).toBe(LIMIT);
    expect(world.carrier.peakLiveByAccount.get(accountKey) ?? 0, `seed ${seed}`).toBe(LIMIT);
    expect(world.carrier.refusals, `seed ${seed}`).toEqual([]);
    expect(ledger().size, `seed ${seed}`).toBe(0);
    const violations = await world.checkInvariants();
    expect(violations, violations.slice(0, 10).join('\n')).toEqual([]);
  }, 300_000);

  it('a campaign with nothing due leaves the whole limit to the other', async () => {
    const LIMIT = scaled(4);
    world = await createFloorWorld({
      scheduled: true,
      campaigns: [
        { label: 'A', tenant: 't1', account: 'm2', agents: scaled(6), contacts: scaled(150), maxConcurrentCalls: LIMIT },
        { label: 'B', tenant: 't1', account: 'm2', agents: scaled(6), contacts: scaled(20), maxConcurrentCalls: LIMIT },
      ],
    });
    patientRounds(world);
    const a = world.campaign('A');
    const b = world.campaign('B');
    const seed = world.seed;
    // B's roster is all in the future (retries maturing, say): agents ready, nothing to dial.
    await getTestPool().query(
      `UPDATE agency_contacts SET next_attempt_at = now() + interval '1 hour' WHERE campaign_id = $1`, [b.id]);
    const seen = observe(world);

    await world.runtime.pacing.runRound();
    expect(await liveOf(a.id)).toBe(LIMIT);
    expect(await liveOf(b.id)).toBe(0);
    expect(seen.find((o) => o.campaignId === b.id)).toMatchObject({
      mode: 'full', quiescent: false, plan: { toDial: 0, idle: 'no_contacts' },
    });

    const violations: string[] = [];
    for (let i = 0; i < scaled(30); i++) {
      const r = await world.round();
      violations.push(...await world.checkInvariants());
      violations.push(...shareViolations(r, LIMIT, seed));
      if (r.campaigns['B']!.attemptsCreated !== 0) violations.push(`[seed ${seed}, round ${r.round}] B dialled with nothing due`);
      if (violations.length) throw new Error(violations.slice(0, 10).join('\n'));
    }
    expect(await attemptsOf(b.id)).toBe(0);
    expect(await world.status('B')).toBe('running');
    expect(world.carrier.peakLiveByAccount.get(`${a.tenantId}:${a.accountId}`)).toBe(LIMIT);
  }, 300_000);
});
