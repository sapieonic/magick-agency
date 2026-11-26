import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';
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
const { phoneNumberRepository } = await import('@magick-agency/db/repositories/phone-number.repository');
const { createConcurrencyControl } = await import('../../../src/core/voice-concurrency-control.js');
const { withPacingInvalidation } = await import('../../../src/agency/pacing/limit-invalidation.js');
const { getConcurrencyControl, resetConcurrencyControl, setConcurrencyControl } = await import('../../../src/seams/concurrency-control.js');

type World = Awaited<ReturnType<typeof createFloorWorld>>;
type GuardHost = InstanceType<typeof TelephonyGuardHost>;

/**
 * ─── CONCURRENCY CAPS UNDER PRESSURE ────────────────────────────────────────
 *
 * The pacing engine paces against the ACCOUNT's `max_concurrent_calls` and the account's
 * live attempts, and against the other scopes admission takes with it: the account's
 * share of the campaign's carrier in provider-breakdown mode (PL14) and the carrier
 * account's own cap (CR13), read from the guards' own Redis counters
 * (`agency/pacing/dial-scopes.ts`). The authority on capacity, though, is the bridge's
 * admission — the global, account, provider and credential leases in Redis — and that can
 * still be tighter than what the tick sees: calls outside pacing hold account slots the
 * database count does not include. When the two disagree the bridge refuses the
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
  // The seam the pacing engine reads the guards' counters through, decorated as `startAgency`
  // does, so a limit invalidation reaches pacing's caches too.
  setConcurrencyControl(withPacingInvalidation(createConcurrencyControl(host)));
  world.carrier.admission = {
    // Exactly as the bridge: the carrier account the dial names takes its own cap too (CR13).
    admit: (c) => admitBridgeCall(host, {
      concurrencyKey: c.attemptId, tenantId: c.tenantId, accountId: c.accountId, provider: c.provider, slotTtlSeconds: 600,
      telephonyCredentialId: c.credentialId,
    }),
    release: async (c) => {
      await releaseTelephonyLease(host, {
        concurrencyKey: c.attemptId, tenantId: c.tenantId, accountId: c.accountId, provider: c.provider, source: 'webrtc',
        credentialId: c.credentialId,
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

/** A tenant `t1` Plivo carrier account with a cap of its own, and two numbers on it every account may dial from (PL5). */
async function seedCappedCredential(cap: number) {
  const db = getTestPool();
  const tenantId = uuidFor('floor-tenant-t1');
  await db.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Floor t1', 'floor-t1-cap') ON CONFLICT (id) DO NOTHING`, [tenantId]);
  await db.query(
    `INSERT INTO telephony_providers (name, display_name, status) VALUES ('voicelink', 'VoiceLink', 'active'), ('plivo', 'Plivo', 'active')
     ON CONFLICT (name) DO UPDATE SET status = 'active'`);
  const { rows: [cred] } = await db.query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref, max_concurrent_calls)
     VALUES ($1, 'plivo', 'Shared', 'MASHAREDSHAREDSHARED', $2) RETURNING id`, [tenantId, cap]);
  const credentialId = cred!.id;
  const NUMBERS = ['+14155550101', '+14155550102'];
  await phoneNumberRepository.syncForCredential(credentialId, NUMBERS.map((n) => ({ phone_number: n, label: null })), null);
  return { credentialId, onCredential: { telephony_provider: 'plivo', telephony_credential_id: credentialId, caller_ids: NUMBERS } };
}

async function credentialCount(host: GuardHost, credentialId: string): Promise<number> {
  const read = await host.credentialConcurrencyGuard.getCounts([credentialId]);
  return read.counts.get(credentialId) ?? -1;
}

/**
 * Every round of a capped carrier account: the floor's invariants, the live calls on it within
 * `cap`, its counter equal to them, and no refusal at the bridge.
 */
function credentialChecker(world: World, host: GuardHost, credentialId: string, campaignIds: string[]) {
  const violations: string[] = [];
  return async (round: number, cap: number) => {
    violations.push(...await world.checkInvariants());
    let live = 0;
    for (const id of campaignIds) live += await liveAttempts(id);
    const count = await credentialCount(host, credentialId);
    const seed = world.seed;
    if (live > cap) violations.push(`[seed ${seed}, round ${round}] ${live} live calls on the carrier account over its cap ${cap}`);
    if (count !== live) violations.push(`[seed ${seed}, round ${round}] credential counter ${count} != ${live} live calls on it`);
    if (world.carrier.refusals.length) {
      violations.push(`[seed ${seed}, round ${round}] the bridge refused ${world.carrier.refusals.length} dials: ${world.carrier.refusals[0]!.code}`);
    }
    if (violations.length) throw new Error(violations.slice(0, 8).join('\n'));
  };
}

describe('concurrency caps under pressure (load)', () => {
  let world: World;

  beforeEach(truncateAll);
  afterEach(async () => {
    await world?.teardown();
    world = undefined as never;
    resetConcurrencyControl();
  });
  afterAll(async () => {
    await closeFloorPool();
    await closeTestPool();
  });

  it('a provider allocation below the account total gates dials without a refusal, and the floor recovers when it is raised', async () => {
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
      if (world.carrier.refusals.length) {
        violations.push(`[seed ${seed}, round ${round}] the bridge refused ${world.carrier.refusals.length} dials: ${world.carrier.refusals[0]!.code}`);
      }
      if (violations.length) throw new Error(violations.slice(0, 8).join('\n'));
    };

    // ── Phase 1: the provider share binds ───────────────────────────────────
    const peakOf = (c: { tenantId: string; accountId: string }) => world.carrier.peakLiveByAccount.get(`${c.tenantId}:${c.accountId}`) ?? 0;
    for (let i = 0; i < 15; i++) {
      const r = await world.round();
      await check(r.round, PROVIDER);
    }
    // The carrier's own high-water mark: the instant after a tick, before any call ends. The
    // share was filled, and never passed: the tick planned to it, so nothing was refused.
    expect(peakOf(g), `seed ${seed}`).toBe(PROVIDER);
    expect(world.carrier.refusals, `seed ${seed}`).toEqual([]);

    // ── Phase 2: an operator raises the allocation; the floor recovers ──────
    await useProviderBreakdown(g.tenantId, g.accountId, 'voicelink', AGENTS);
    await getConcurrencyControl().invalidateProviderLimits(g.tenantId, g.accountId);
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
    expect(world.carrier.refusals, `seed ${seed}: refusals after the allocation was raised`).toEqual([]);
    expect(peakOf(g), `seed ${seed}`).toBeGreaterThan(PROVIDER);

    // ── Nothing lost ────────────────────────────────────────────────────────
    const audit = await world.finalAudit();
    expect(audit, audit.slice(0, 20).join('\n')).toEqual([]);
    expect(await world.status('G')).toBe('completed');
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
   * CR13: a tenant's carrier account with a cap of its own. Two campaigns on two accounts of one
   * tenant dial on the same credential (cap 2), each account with room for 4; a third campaign of
   * the tenant dials on the service's own account. Asserted every round: the credential's counter
   * equals the live calls on it and never exceeds the cap, and the bridge refuses nothing: the
   * tick plans against the cap's room, which the two accounts share (`pacing/dial-scopes.ts`).
   * The service-account campaign is paced exactly as if the others were idle. Raising the cap
   * frees the floor, and nothing is lost: every slot comes back.
   *
   * The world's default path: each campaign's tick forced (`tickOnce`), all three at once, each in
   * a round of its own, so the two accounts' ticks race for the same room every round.
   */
  it('a carrier account\'s own cap binds across two accounts of its tenant without a refusal; the service account dials on unaffected', async () => {
    const CAP = 2;
    const AGENTS = 4;
    const { credentialId, onCredential } = await seedCappedCredential(CAP);
    world = await createFloorWorld({
      campaigns: [
        { label: 'A', tenant: 't1', account: 'cap-a', agents: AGENTS, contacts: scaled(60), maxConcurrentCalls: AGENTS, campaign: onCredential },
        { label: 'B', tenant: 't1', account: 'cap-b', agents: AGENTS, contacts: scaled(60), maxConcurrentCalls: AGENTS, campaign: onCredential },
        { label: 'S', tenant: 't1', account: 'cap-s', agents: AGENTS, contacts: scaled(60), maxConcurrentCalls: AGENTS },
      ],
    });
    const a = world.campaign('A');
    const b = world.campaign('B');
    const svc = world.campaign('S');
    const host = wireGuards(world);
    const seed = world.seed;
    const check = credentialChecker(world, host, credentialId, [a.id, b.id]);

    for (let i = 0; i < 15; i++) {
      const r = await world.round();
      await check(r.round, CAP);
      const s = r.campaigns['S']!;
      expect(s.attemptsCreated, `seed ${seed}, round ${r.round}: the service-account campaign was held back`).toBe(expectedDials(s));
    }
    expect(world.carrier.refusals, `seed ${seed}`).toEqual([]);
    expect(world.carrier.peakLiveByCredential.get(credentialId), `seed ${seed}: the cap never bound`).toBe(CAP);

    // An operator raises the cap (the super-admin route's write, then the seam); the floor recovers.
    await getTestPool().query('UPDATE telephony_credentials SET max_concurrent_calls = $2 WHERE id = $1', [credentialId, AGENTS * 2]);
    await getConcurrencyControl().invalidateCredentialLimit(credentialId);
    await world.runUntilDrained({ maxRounds: scaled(2000), onRound: async (r) => { await check(r.round, AGENTS * 2); } });
    expect(world.carrier.refusals, `seed ${seed}: refusals after the cap was raised`).toEqual([]);
    expect(world.carrier.peakLiveByCredential.get(credentialId), `seed ${seed}`).toBeGreaterThan(CAP);

    const audit = await world.finalAudit();
    expect(audit, audit.slice(0, 20).join('\n')).toEqual([]);
    for (const label of ['A', 'B', 'S']) expect(await world.status(label), `seed ${seed}`).toBe('completed');
    expect(await credentialCount(host, credentialId)).toBe(0);
    for (const c of [a, b, svc]) expect(await host.accountConcurrencyGuard.getAccountCount(c.tenantId, c.accountId)).toBe(0);
  }, 300_000);

  /**
   * The same cap on the engine's SCHEDULED path (`runRound`): one round ticks every campaign the
   * engine leads at once, with its cached limits and skip logic, the two accounts in two splits of
   * that round. The two splits share the cap's room through the scope ledger: never more than 2
   * live on the credential, and no refusal. Raising the cap through the seam
   * (`credential_limit_changed`) is seen by the very next rounds, not a cache TTL later.
   */
  it('on the scheduled path two accounts\' splits share a carrier account\'s cap, and a raise is seen at once', async () => {
    const CAP = 2;
    const AGENTS = 4;
    const RAISED = 6;
    const { credentialId, onCredential } = await seedCappedCredential(CAP);
    world = await createFloorWorld({
      scheduled: true,
      campaigns: [
        { label: 'A', tenant: 't1', account: 'cap-a', agents: AGENTS, contacts: scaled(80), maxConcurrentCalls: AGENTS, campaign: onCredential },
        { label: 'B', tenant: 't1', account: 'cap-b', agents: AGENTS, contacts: scaled(80), maxConcurrentCalls: AGENTS, campaign: onCredential },
        { label: 'S', tenant: 't1', account: 'cap-s', agents: AGENTS, contacts: scaled(80), maxConcurrentCalls: AGENTS },
      ],
    });
    const a = world.campaign('A');
    const b = world.campaign('B');
    const svc = world.campaign('S');
    const host = wireGuards(world);
    const seed = world.seed;
    const check = credentialChecker(world, host, credentialId, [a.id, b.id]);

    // One round, no call ending (the carrier is not advanced): both accounts want 4 at once, in
    // two splits of the same round; the cap's room is 2 and goes once. The service-account
    // campaign beside them takes its whole account.
    await world.runtime.pacing.runRound();
    await check(0, CAP);
    expect((await liveAttempts(a.id)) + (await liveAttempts(b.id)), `seed ${seed}`).toBe(CAP);
    expect(await liveAttempts(svc.id), `seed ${seed}: the service-account campaign was held back`).toBe(AGENTS);
    // At the cap: nothing more, however many agents wait.
    await world.runtime.pacing.runRound();
    await check(0, CAP);
    expect((await liveAttempts(a.id)) + (await liveAttempts(b.id)), `seed ${seed}`).toBe(CAP);

    // A churning floor: calls end, agents come back, both accounts keep competing; the
    // service-account campaign is paced by the law every round.
    for (let i = 0; i < 20; i++) {
      const r = await world.round();
      await check(r.round, CAP);
      const s = r.campaigns['S']!;
      expect(s.attemptsCreated, `seed ${seed}, round ${r.round}: the service-account campaign was held back`).toBe(expectedDials(s));
    }
    expect(world.carrier.refusals, `seed ${seed}`).toEqual([]);
    expect(world.carrier.peakLiveByCredential.get(credentialId), `seed ${seed}`).toBe(CAP);

    // Raise the cap through the seam: the very next rounds dial past the old cap (the engine's
    // cached cap is dropped by `credential_limit_changed`, and its campaigns are woken).
    await getTestPool().query('UPDATE telephony_credentials SET max_concurrent_calls = $2 WHERE id = $1', [credentialId, RAISED]);
    await getConcurrencyControl().invalidateCredentialLimit(credentialId);
    for (let i = 0; i < 3 && (world.carrier.peakLiveByCredential.get(credentialId) ?? 0) <= CAP; i++) {
      const r = await world.round();
      await check(r.round, RAISED);
    }
    expect(world.carrier.peakLiveByCredential.get(credentialId), `seed ${seed}: the raised cap was not seen`).toBeGreaterThan(CAP);

    await world.runUntilDrained({ maxRounds: scaled(2000), onRound: async (r) => { await check(r.round, RAISED); } });
    expect(world.carrier.refusals, `seed ${seed}`).toEqual([]);
    const audit = await world.finalAudit();
    expect(audit, audit.slice(0, 20).join('\n')).toEqual([]);
    expect(await credentialCount(host, credentialId)).toBe(0);
  }, 300_000);

  /**
   * Was a KNOWN DEFECT pinned with `it.fails` — the tick paced past a provider
   * allocation it never read. Fixed: the tick reads the account's share of the
   * campaign's carrier and the share's live counter (`agency/pacing/dial-scopes.ts`).
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
   * Now bounded: `toDial` never exceeds the share's room (decisions PL14).
   */
  it('the tick never dials past a provider allocation (no refusals while the share binds)', async () => {
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
