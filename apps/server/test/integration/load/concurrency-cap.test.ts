import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { scaled } from '../../helpers/load-scale.js';

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
// The guard host reads its global ceiling and lock TTLs from config. The global
// ceiling is set far above the floor so the account and provider scopes are the
// ones under test.
vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {},
    concurrency: { maxConcurrentCalls: 10_000, callTimeoutSeconds: 600, reconcileIntervalMs: 60_000 },
  },
}));

const { createFloorWorld, closeFloorPool, attemptRows, expectedDials } = await import('./floor-harness.js');
const { TelephonyGuardHost } = await import('../../../src/core/telephony-guard-host.js');
const { admitBridgeCall } = await import('../../../src/core/bridge/admission.js');
const { releaseTelephonyLease } = await import('../../../src/core/telephony-release.js');

type World = Awaited<ReturnType<typeof createFloorWorld>>;
type GuardHost = InstanceType<typeof TelephonyGuardHost>;

/**
 * ─── CONCURRENCY CAPS UNDER PRESSURE ────────────────────────────────────────
 *
 * The pacing engine paces against the ACCOUNT's `max_concurrent_calls` and its own
 * campaign's live attempts. The authority on capacity, though, is the bridge's
 * admission — the global, account and provider leases in Redis — and that can be
 * tighter than what the tick sees: other calls on the account hold slots the
 * campaign's count does not include, and a provider-breakdown account allocates
 * each carrier a share of the total. When the two disagree the bridge refuses the
 * dial, and the dialer must turn that refusal into nothing worse than a wasted
 * tick: the attempt ends uncharged, the contact goes back to the pool, the agent
 * goes back to available, and when capacity frees the floor recovers by itself.
 *
 * The carrier here admits every dial through the PRODUCTION `TelephonyGuardHost`
 * (`admitBridgeCall`, exactly as `WebRtcBridgeManager.placeOutboundLeg` does) and
 * releases through `releaseTelephonyLease` at call end, on the floor's real Redis.
 * Asserted every round: the Redis counters equal the live attempts in Postgres
 * (no leaked or phantom slot), and never exceed the cap that is binding.
 */

async function useProviderBreakdown(tenantId: string, accountId: string, provider: string, limit: number) {
  const db = getTestPool();
  await db.query(
    `UPDATE account_settings SET concurrency_allocation_mode = 'provider_breakdown'
      WHERE tenant_id = $1 AND account_id = $2`, [tenantId, accountId]);
  await db.query(
    `INSERT INTO account_provider_concurrency_allocations (tenant_id, account_id, telephony_provider, max_concurrent_calls)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, account_id, telephony_provider) DO UPDATE SET max_concurrent_calls = EXCLUDED.max_concurrent_calls`,
    [tenantId, accountId, provider, limit]);
}

function wireGuards(world: World): GuardHost {
  const host = new TelephonyGuardHost(world.redis as never);
  world.carrier.admission = {
    admit: (c) => admitBridgeCall(host, {
      concurrencyKey: c.attemptId, tenantId: c.tenantId, accountId: c.accountId, provider: c.provider, slotTtlSeconds: 600,
    }),
    release: async (c) => {
      await releaseTelephonyLease(host, {
        concurrencyKey: c.attemptId, tenantId: c.tenantId, accountId: c.accountId, provider: c.provider, source: 'webrtc',
      });
    },
  };
  return host;
}

async function liveAttempts(campaignId: string): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = $1 AND state <> 'ended'`, [campaignId]);
  return rows[0]!.n;
}

describe('concurrency caps under pressure (load)', () => {
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

  it('a provider allocation below the account total gates dials without losing one, and the floor recovers when it is raised', async () => {
    const AGENTS = scaled(20);
    const PROVIDER = Math.max(1, Math.floor(AGENTS * 0.4));
    world = await createFloorWorld({
      campaigns: [{ label: 'G', tenant: 't1', account: 'g1', agents: AGENTS, contacts: scaled(400), maxConcurrentCalls: AGENTS }],
    });
    const g = world.campaign('G');
    await useProviderBreakdown(g.tenantId, g.accountId, 'voicelink', PROVIDER);
    const host = wireGuards(world);
    const seed = world.seed;
    const violations: string[] = [];

    const check = async (round: number, cap: number) => {
      violations.push(...await world.checkInvariants());
      const live = await liveAttempts(g.id);
      const provider = await host.providerConcurrencyGuard.getProviderCount(g.tenantId, g.accountId, 'voicelink');
      const account = await host.accountConcurrencyGuard.getAccountCount(g.tenantId, g.accountId);
      if (live > cap) violations.push(`[seed ${seed}, round ${round}] ${live} live calls over the binding cap ${cap}`);
      if (provider !== live) violations.push(`[seed ${seed}, round ${round}] provider counter ${provider} != ${live} live attempts`);
      if (account !== live) violations.push(`[seed ${seed}, round ${round}] account counter ${account} != ${live} live attempts`);
      if (violations.length) throw new Error(violations.slice(0, 8).join('\n'));
    };

    // ── Phase 1: the provider share binds ───────────────────────────────────
    const peakOf = (c: { tenantId: string; accountId: string }) => world.carrier.peakLiveByAccount.get(`${c.tenantId}:${c.accountId}`) ?? 0;
    for (let i = 0; i < 15; i++) {
      const r = await world.round();
      await check(r.round, PROVIDER);
    }
    // The carrier's own high-water mark: the instant after a tick, before any call ends.
    const peak1 = peakOf(g);
    const refusedPhase1 = world.carrier.refusals.length;
    expect(refusedPhase1, `seed ${seed}: the share never bound, so nothing was gated`).toBeGreaterThan(0);
    expect(world.carrier.refusals.every((r) => r.code === 'provider_concurrency_limit'), `seed ${seed}`).toBe(true);
    expect(peak1, `seed ${seed}`).toBe(PROVIDER);

    // ── Phase 2: an operator raises the allocation; the floor recovers ──────
    await useProviderBreakdown(g.tenantId, g.accountId, 'voicelink', AGENTS);
    await host.providerConcurrencyGuard.invalidateLimits(g.tenantId, g.accountId);
    await world.runUntilDrained({
      maxRounds: scaled(2000),
      onRound: async (r) => {
        await check(r.round, AGENTS);
        const s = r.campaigns['G']!;
        if (s.attemptsCreated !== expectedDials(s)) {
          throw new Error(`[seed ${seed}, round ${r.round}] dialled ${s.attemptsCreated}, pacing law says ${expectedDials(s)}`);
        }
      },
    });
    expect(world.carrier.refusals.length, `seed ${seed}: refusals continued after the allocation was raised`).toBe(refusedPhase1);
    expect(peakOf(g), `seed ${seed}`).toBeGreaterThan(PROVIDER);

    // ── Gated, not lost ─────────────────────────────────────────────────────
    const audit = await world.finalAudit();
    expect(audit, audit.slice(0, 20).join('\n')).toEqual([]);
    expect(await world.status('G')).toBe('completed');
    const rows = await attemptRows([g.id]);
    const refused = rows.filter((r) => world.carrier.refusals.some((x) => x.attemptId === r.id));
    expect(refused.length).toBe(refusedPhase1);
    for (const r of refused) {
      // Ended at once, as a failure that never reached the carrier…
      expect(r.state, `seed ${seed}`).toBe('ended');
      expect(r.outcome, `seed ${seed}`).toBe('failed');
      expect(r.webrtc_call_id, `seed ${seed}`).toBeNull();
    }
    // …and the contact behind every refusal was dialled for real afterwards.
    for (const contactId of new Set(refused.map((r) => r.contact_id))) {
      const dialled = rows.some((r) => r.contact_id === contactId && r.webrtc_call_id !== null);
      expect(dialled, `seed ${seed}: contact ${contactId} was refused and never dialled`).toBe(true);
    }
    // Every slot came back: nothing is held once the floor is quiet.
    expect(await host.providerConcurrencyGuard.getProviderCount(g.tenantId, g.accountId, 'voicelink')).toBe(0);
    expect(await host.accountConcurrencyGuard.getAccountCount(g.tenantId, g.accountId)).toBe(0);
  }, 300_000);

  it('calls outside the campaign holding account slots gate the floor, and it recovers when they end', async () => {
    const AGENTS = scaled(12);
    const FOREIGN = Math.max(1, Math.floor(AGENTS / 2));
    world = await createFloorWorld({
      campaigns: [
        { label: 'H', tenant: 't1', account: 'h1', agents: AGENTS, contacts: scaled(300), maxConcurrentCalls: AGENTS },
        // A second tenant on its own account, which must be untouched by H's pressure.
        { label: 'K', tenant: 't2', account: 'k1', agents: scaled(8), contacts: scaled(150), maxConcurrentCalls: scaled(8) },
      ],
    });
    const h = world.campaign('H');
    const k = world.campaign('K');
    const host = wireGuards(world);
    const seed = world.seed;

    // Manual browser-dialer calls on H's account: slots the pacing tick cannot see.
    for (let i = 0; i < FOREIGN; i++) {
      const got = await host.tryAcquireTelephonyConcurrency(`foreign-${i}`, h.tenantId, h.accountId, 'voicelink', 600);
      expect(got.result).toBe('acquired');
    }

    const violations: string[] = [];
    const check = async (round: number, foreign: number) => {
      violations.push(...await world.checkInvariants());
      const liveH = await liveAttempts(h.id);
      const liveK = await liveAttempts(k.id);
      const countH = await host.accountConcurrencyGuard.getAccountCount(h.tenantId, h.accountId);
      const countK = await host.accountConcurrencyGuard.getAccountCount(k.tenantId, k.accountId);
      if (countH !== liveH + foreign) violations.push(`[seed ${seed}, round ${round}] H counter ${countH} != ${liveH} live + ${foreign} foreign`);
      if (countH > AGENTS) violations.push(`[seed ${seed}, round ${round}] H counter ${countH} over its cap ${AGENTS}`);
      if (countK !== liveK) violations.push(`[seed ${seed}, round ${round}] K counter ${countK} != ${liveK} live`);
      if (violations.length) throw new Error(violations.slice(0, 8).join('\n'));
    };

    for (let i = 0; i < 12; i++) {
      const r = await world.round();
      await check(r.round, FOREIGN);
      // K is paced exactly as if H were idle: another account's pressure is not its own.
      const s = r.campaigns['K']!;
      expect(s.attemptsCreated, `seed ${seed}, round ${r.round}: K starved by H's pressure`).toBe(expectedDials(s));
    }
    const refusedWhileHeld = world.carrier.refusals.length;
    expect(refusedWhileHeld, `seed ${seed}`).toBeGreaterThan(0);
    expect(world.carrier.refusals.every((r) => r.campaignId === h.id && r.code === 'account_concurrency_limit'), `seed ${seed}`).toBe(true);

    // The foreign calls end; H's floor takes the slots back.
    for (let i = 0; i < FOREIGN; i++) {
      await releaseTelephonyLease(host, {
        concurrencyKey: `foreign-${i}`, tenantId: h.tenantId, accountId: h.accountId, provider: 'voicelink', source: 'webrtc',
      });
    }
    expect(world.carrier.peakLiveByAccount.get(`${h.tenantId}:${h.accountId}`), `seed ${seed}`).toBe(AGENTS - FOREIGN);
    await world.runUntilDrained({
      maxRounds: scaled(2000),
      onRound: async (r) => {
        await check(r.round, 0);
      },
    });
    expect(world.carrier.refusals.length, `seed ${seed}: refusals after the slots freed`).toBe(refusedWhileHeld);
    expect(world.carrier.peakLiveByAccount.get(`${h.tenantId}:${h.accountId}`), `seed ${seed}`).toBe(AGENTS);
    const audit = await world.finalAudit();
    expect(audit, audit.slice(0, 20).join('\n')).toEqual([]);
    expect(await world.status('H')).toBe('completed');
    expect(await world.status('K')).toBe('completed');
  }, 300_000);

  /**
   * ⚠️ KNOWN DEFECT, pinned with `it.fails` — the tick paces past a provider
   * allocation it never reads.
   *
   * `planTick` caps new dials at `account max_concurrent_calls − live`, and its own
   * header explains why the cap must be the guard's: "excluding them would make the
   * engine reserve agents and claim contacts only to be refused by the concurrency
   * guard, every tick, forever". Under `concurrency_allocation_mode =
   * 'provider_breakdown'` the binding cap is the PROVIDER's share, which the tick
   * does not consult — so with more agents than the share, every tick reserves
   * agents, claims contacts, inserts attempts and stamps them dialled, only for the
   * bridge to refuse the surplus. Each refusal is an attempt row, a `released`
   * popup on the agent's console ("The call could not be completed") and a wasted
   * claim, at the tick rate, for as long as the share is short. Nothing is lost
   * (the first case proves that), but the "refused every tick, forever" shape the
   * pacing header rules out is exactly what happens.
   *
   * The fix is to bound `toDial` by the provider allocation when the account is in
   * provider-breakdown mode (`providerConcurrencyRepository.getProviderLimit`). When
   * it lands this case goes green and `it.fails` reds: flip it to `it`.
   */
  it.fails('the tick never dials past a provider allocation (no refusals while the share binds)', async () => {
    world = await createFloorWorld({
      campaigns: [{ label: 'J', tenant: 't1', account: 'j1', agents: 10, contacts: 100, maxConcurrentCalls: 10 }],
    });
    const j = world.campaign('J');
    await useProviderBreakdown(j.tenantId, j.accountId, 'voicelink', 4);
    wireGuards(world);
    for (let i = 0; i < 5; i++) await world.round();
    expect(world.carrier.refusals).toEqual([]);
  }, 120_000);

  /**
   * ⚠️ KNOWN DEFECT, pinned with `it.fails` — a dial the bridge refused is recorded
   * as PLACED.
   *
   * `executeDial` stamps `dialed_at` (state `dialing`) before `createBridgedCall`,
   * and admission happens inside `createBridgedCall`, so a capacity refusal ends an
   * attempt that carries a `dialed_at`. The campaign stats read `dialed_at IS NOT
   * NULL` as "the call was placed" (`campaign-stats.ts`: "a dial that never happened
   * is not a dial"), as do the agent stats and the series — so every refusal above
   * is counted as a placed dial, and a retry refused at the bridge is counted in
   * `attempts_retried`. `executeDial`'s own comment names the hazard ("a refusal
   * after those would record a dial the carrier never saw") for its pre-dial
   * re-checks; admission is the one refusal that lands after the stamp.
   *
   * When refused attempts stop carrying `dialed_at` this case goes green and
   * `it.fails` reds: flip it to `it`.
   */
  it.fails('an attempt the bridge refused for capacity is not recorded as a placed dial', async () => {
    world = await createFloorWorld({
      campaigns: [{ label: 'L', tenant: 't1', account: 'l1', agents: 8, contacts: 50, maxConcurrentCalls: 8 }],
    });
    const l = world.campaign('L');
    const host = wireGuards(world);
    for (let i = 0; i < 6; i++) {
      await host.tryAcquireTelephonyConcurrency(`foreign-${i}`, l.tenantId, l.accountId, 'voicelink', 600);
    }
    await world.round();
    const refusedIds = world.carrier.refusals.map((r) => r.attemptId);
    expect(refusedIds.length).toBeGreaterThan(0);
    const rows = (await attemptRows([l.id])).filter((r) => refusedIds.includes(r.id));
    expect(rows.map((r) => r.dialed_at)).toEqual(rows.map(() => null));
  }, 120_000);
});
