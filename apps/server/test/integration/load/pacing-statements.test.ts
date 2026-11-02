import { appendFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

await vi.hoisted(async () => {
  process.env['LOG_LEVEL'] ??= 'warn';
});

// Every statement the product sends goes through the counting pool.
vi.mock('@magick-agency/db', async () => {
  const { countingPool } = await import('./statement-counter.js');
  return { getPool: () => countingPool() };
});
vi.mock('@magick-agency/db/connection', async () => {
  const { countingPool } = await import('./statement-counter.js');
  return { getPool: () => countingPool() };
});
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));

const { createFloorWorld, closeFloorPool } = await import('./floor-harness.js');
const { counter } = await import('./statement-counter.js');

type World = Awaited<ReturnType<typeof createFloorWorld>>;

/**
 * ─── PACING STATEMENT HARNESS ───────────────────────────────────────────────
 *
 * How much database and Redis work the pacing engine does per second in STEADY
 * STATE, with N campaigns of M agents each led by one engine on its own timers
 * (the production path: no `tickOnce`, no supervise pass, no reaper). Each
 * campaign is on its own tenant and account, as `uq_agency_campaign_running`
 * requires of running campaigns.
 *
 *   idle — every agent on a break: each tick finds no agent (`no_agents`).
 *   busy — the account limit is half the pool and the carrier holds every call it
 *          is given, so half the agents are on calls, half wait available, and
 *          each tick finds no slot (`no_slots`): the five-statement tick.
 *
 * Counted: every pg statement through the product's pool (by statement text) and
 * every Redis command and round trip on the runtime's client, over a measured
 * window after a warm-up. What is reported is printed; the budget asserted is the
 * one the skip logic and the shared reads exist to meet. `PACING_HARNESS_MEASURE_ONLY=1`
 * skips the budget (to measure an engine without them).
 *
 * Scale: `PACING_HARNESS_CAMPAIGNS` (default 50), `PACING_HARNESS_AGENTS` (10),
 * `PACING_HARNESS_WINDOW_MS` (5000). `PACING_HARNESS_OUT=<file>` appends each
 * measurement there as a JSON line.
 */

const N = Number(process.env['PACING_HARNESS_CAMPAIGNS'] ?? 50);
const M = Number(process.env['PACING_HARNESS_AGENTS'] ?? 10);
const WINDOW_MS = Number(process.env['PACING_HARNESS_WINDOW_MS'] ?? 5_000);
const MEASURE_ONLY = process.env['PACING_HARNESS_MEASURE_ONLY'] === '1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Measurement {
  scenario: string;
  campaigns: number;
  agentsPerCampaign: number;
  windowMs: number;
  sqlPerSec: number;
  sqlPerCampaignPerSec: number;
  redisCmdPerSec: number;
  redisRoundTripsPerSec: number;
  topSql: Array<[string, number]>;
  topRedis: Array<[string, number]>;
}

async function lead(world: World): Promise<void> {
  // The supervise pass's own effect, without its flag reads: take each lease and
  // start leading. Present on every version of the engine this harness measures.
  const engine = world.runtime.pacing as unknown as {
    lease: { tryAcquire(id: string): Promise<boolean> };
    beginLeading(row: unknown): void;
  };
  for (const c of world.campaigns) {
    if (!(await engine.lease.tryAcquire(c.id))) throw new Error(`could not lead ${c.spec.label}`);
    const { rows } = await getTestPool().query('SELECT * FROM agency_campaigns WHERE id = $1', [c.id]);
    engine.beginLeading(rows[0]);
  }
}

async function measure(world: World, scenario: string): Promise<Measurement> {
  counter.instrumentRedis(world.redis);
  counter.reset();
  const started = Date.now();
  await sleep(WINDOW_MS);
  const elapsed = (Date.now() - started) / 1000;
  const m: Measurement = {
    scenario,
    campaigns: N,
    agentsPerCampaign: M,
    windowMs: WINDOW_MS,
    sqlPerSec: round1(counter.sqlTotal / elapsed),
    sqlPerCampaignPerSec: round1(counter.sqlTotal / elapsed / N),
    redisCmdPerSec: round1(counter.redisTotal / elapsed),
    redisRoundTripsPerSec: round1(counter.redisRoundTrips / elapsed),
    topSql: counter.top(counter.sql).map(([k, v]) => [k, round1(v / elapsed)]),
    topRedis: counter.top(counter.redisCommands).map(([k, v]) => [k, round1(v / elapsed)]),
  };
  // eslint-disable-next-line no-console
  console.log(`PACING-HARNESS ${JSON.stringify(m)}`);
  const out = process.env['PACING_HARNESS_OUT'];
  if (out) appendFileSync(out, `${JSON.stringify(m)}\n`);
  return m;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

async function liveAttempts(): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agency_call_attempts WHERE state <> 'ended'`);
  return rows[0]!.n;
}

function specs(limit: number) {
  return Array.from({ length: N }, (_, i) => ({
    label: `C${i}`, tenant: `pt${i}`, account: `pa${i}`, agents: M, contacts: 4 * M, maxConcurrentCalls: limit,
  }));
}

describe('pacing statement harness (load)', () => {
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

  it(`idle floor: ${N} campaigns x ${M} agents, every agent on a break`, async () => {
    world = await createFloorWorld({ campaigns: specs(M) });
    for (const a of world.agents) await world.goBreak(a);
    await lead(world);
    await sleep(1_500);
    const m = await measure(world, 'idle');
    expect(await liveAttempts()).toBe(0);
    expect(m.sqlPerSec).toBeGreaterThan(0);
    if (!MEASURE_ONLY) {
      // A quiescent campaign is ticked in full once per safety interval (1 s) at
      // most: findById (cached, so usually not), findLiveForCampaign and the
      // finalize count. Per-tick it was 3 statements, 4 times a second.
      expect(m.sqlPerCampaignPerSec).toBeLessThanOrEqual(3);
    }
  }, 300_000);

  it(`busy floor: ${N} campaigns x ${M} agents, account limit ${Math.floor(M / 2)}, every slot held`, async () => {
    const limit = Math.floor(M / 2);
    world = await createFloorWorld({ campaigns: specs(limit) });
    await lead(world);
    const deadline = Date.now() + 30_000;
    while ((await liveAttempts()) < N * limit && Date.now() < deadline) await sleep(100);
    expect(await liveAttempts()).toBe(N * limit);
    await sleep(1_500);
    const m = await measure(world, 'busy');
    // Steady: the carrier held every call, nothing was dialled past the limit.
    expect(await liveAttempts()).toBe(N * limit);
    if (!MEASURE_ONLY) {
      // Per-tick it was 5 statements, 4 times a second.
      expect(m.sqlPerCampaignPerSec).toBeLessThanOrEqual(5);
    }
  }, 300_000);
});
