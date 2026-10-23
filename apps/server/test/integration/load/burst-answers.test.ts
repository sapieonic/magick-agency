import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { scaled } from '../../helpers/load-scale.js';

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

const { createFloorWorld, closeFloorPool, attemptRows, pacingViolations } = await import('./floor-harness.js');
const { metricValue, assertAbandonmentPredicatesAgree } = await import('../agency/chaos/harness.js');
const { refreshAbandonmentWindow } = await import('../../../src/agency/abandonment-metrics.js');

type World = Awaited<ReturnType<typeof createFloorWorld>>;

/**
 * ─── A BURST OF ANSWERS INTO A FLOOR THAT HAS LOST AGENTS ───────────────────
 *
 * Strict power dialing reserves an agent before every dial, so an answer can only
 * outnumber the agents behind it one way: agents vanish while their calls ring.
 * Here a whole wave rings at once, a third of its agents lose their stations, and
 * then every call is answered in the same instant — the burst a carrier delivers
 * when a campaign's first wave lands together.
 *
 * What must come out of it, read from Postgres, Redis and the sockets:
 *  - every answer behind a lost station is abandoned (`station_lost`) and hung up,
 *    and nothing else is: no live agent's call is caught in it;
 *  - every surviving call is bridged exactly ONCE, to the agent reserved for it —
 *    no agent is bridged twice, no frame reaches a socket it was not meant for;
 *  - the abandonment counter, the answered counter and both abandonment predicates
 *    agree with the table;
 *  - the guardrail pauses THIS campaign (it is far past 3%), dials nothing for it
 *    afterwards, lets its live calls finish normally, and leaves the neighbouring
 *    campaign on the same floor running.
 */

describe('burst answers with fewer agents than answers (load)', () => {
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

  it('abandons exactly the answers behind lost stations, bridges every other one once, and the guardrail pauses only that campaign', async () => {
    const WAVE = scaled(60);
    const LOST = Math.floor(WAVE / 3);
    world = await createFloorWorld({
      campaigns: [
        { label: 'B', tenant: 't1', account: 'b1', agents: WAVE, contacts: scaled(600), maxConcurrentCalls: WAVE },
        { label: 'N', tenant: 't1', account: 'n1', agents: scaled(20), contacts: scaled(300), maxConcurrentCalls: scaled(20) },
      ],
    });
    const seed = world.seed;
    const b = world.campaign('B');
    const db = getTestPool();

    // B's first wave rings and keeps ringing; N runs its ordinary mix throughout.
    world.carrier.scriptOverride = ({ campaignId }) => (campaignId === b.id
      ? { kind: 'connected_long', ringRounds: 1_000, talkRounds: 3, talkSeconds: 300 }
      : undefined);
    const first = await world.round();
    expect(pacingViolations(first, seed)).toEqual([]);
    const wave = world.carrier.liveCalls().filter((c) => c.campaignId === b.id);
    expect(wave.length, `seed ${seed}`).toBe(WAVE);
    expect(wave.every((c) => c.phase === 'ringing')).toBe(true);
    world.carrier.scriptOverride = null;

    // A third of B's agents lose their stations mid-ring.
    const lostCalls = world.rng.shuffle(wave).slice(0, LOST);
    const lostSessions = new Set(lostCalls.map((c) => c.sessionId));
    for (const c of lostCalls) {
      const agent = world.agents.find((a) => a.sessionId === c.sessionId)!;
      const r = await world.dropStation(agent);
      expect(r.attemptId).toBe(c.attemptId);
      // The deferred hangup owns a ringing call; the agent is not written offline.
      expect(r.wroteOffline).toBe(false);
    }
    expect(await world.checkInvariants()).toEqual([]);

    // Every call in the wave answers at once.
    await world.carrier.answerNow(wave.map((c) => c.attemptId));
    expect(world.carrier.barrierTimeouts, `seed ${seed}`).toEqual([]);
    const afterBurst = await world.checkInvariants();
    expect(afterBurst, afterBurst.slice(0, 10).join('\n')).toEqual([]);

    // ── Exactly the lost stations' answers were abandoned ───────────────────
    const rows = await attemptRows([b.id]);
    const waveRows = rows.filter((r) => wave.some((c) => c.attemptId === r.id));
    const abandoned = waveRows.filter((r) => r.outcome === 'abandoned');
    expect(abandoned.map((r) => r.reserved_agent_id).sort(), `seed ${seed}`).toEqual([...lostSessions].sort());
    for (const r of abandoned) {
      expect(r.state).toBe('ended');
      expect(r.answered_at).not.toBeNull();
      expect(r.bridged_at).toBeNull();
    }
    const { rows: reasons } = await db.query<{ abandon_reason: string; n: number }>(
      `SELECT abandon_reason, count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = $1 AND outcome = 'abandoned' GROUP BY 1`, [b.id]);
    expect(reasons, `seed ${seed}`).toEqual([{ abandon_reason: 'station_lost', n: LOST }]);

    // ── Every other answer bridged once, to its own agent ───────────────────
    const bridged = waveRows.filter((r) => r.state === 'bridged');
    expect(bridged.length, `seed ${seed}`).toBe(WAVE - LOST);
    const bridgedFrames: Array<{ session: string; attempt: string }> = [];
    for (const a of world.agents) {
      for (const f of a.socket.ofType('bridged')) bridgedFrames.push({ session: a.sessionId, attempt: f['attempt_id'] as string });
    }
    const waveFrames = bridgedFrames.filter((f) => wave.some((c) => c.attemptId === f.attempt));
    expect(waveFrames.length, `seed ${seed}: bridged frames for the wave`).toBe(WAVE - LOST);
    expect(new Set(waveFrames.map((f) => f.attempt)).size, `seed ${seed}: an attempt bridged twice`).toBe(waveFrames.length);
    expect(new Set(waveFrames.map((f) => f.session)).size, `seed ${seed}: an agent bridged twice`).toBe(waveFrames.length);
    for (const f of waveFrames) {
      expect(bridged.find((r) => r.id === f.attempt)?.reserved_agent_id, `seed ${seed}`).toBe(f.session);
      expect(lostSessions.has(f.session), `seed ${seed}: media sent to a lost station`).toBe(false);
    }
    // The carrier still holds every surviving call; none was hung up by the abandon path.
    const stillLive = new Set(world.carrier.liveCalls().map((c) => c.attemptId));
    for (const r of bridged) expect(stillLive.has(r.id), `seed ${seed}`).toBe(true);
    // Lost agents are offline (their socket is gone), not back in the pool.
    for (const s of lostSessions) expect((await world.runtime.agents.get(s))?.state, `seed ${seed}`).toBe('offline');

    // ── Counters agree with the table ───────────────────────────────────────
    expect(await assertAbandonmentPredicatesAgree(b.id)).toBe(LOST);
    expect(await metricValue('agency_abandoned_total', { campaign_id: b.id })).toBe(LOST);
    expect(await metricValue('agency_answered_total', { campaign_id: b.id })).toBe(WAVE);

    // ── The guardrail pauses B, and only B ──────────────────────────────────
    await refreshAbandonmentWindow();
    expect(await world.status('B'), `seed ${seed}`).toBe('paused');
    expect(await world.status('N'), `seed ${seed}`).toBe('running');
    const { rows: [cam] } = await db.query<{ pause_reason: string; paused_at: Date }>(
      'SELECT pause_reason, paused_at FROM agency_campaigns WHERE id = $1', [b.id]);
    expect(cam!.pause_reason).toBe('abandonment_ceiling');

    // B's bridged calls finish normally; B dials nobody; N carries on and completes.
    const violations: string[] = [];
    await world.runUntilDrained({
      maxRounds: scaled(2000),
      onRound: async (r) => {
        violations.push(...await world.checkInvariants(), ...pacingViolations(r, seed));
        if (violations.length) throw new Error(violations.slice(0, 10).join('\n'));
      },
    });
    const audit = await world.finalAudit();
    expect(audit, audit.slice(0, 20).join('\n')).toEqual([]);
    expect(await world.status('B')).toBe('paused');
    expect(await world.status('N')).toBe('completed');
    const finalB = await attemptRows([b.id]);
    expect(finalB.filter((r) => r.created_at > cam!.paused_at).map((r) => r.id), `seed ${seed}: B dialled after the pause`).toEqual([]);
    for (const r of bridged) expect(finalB.find((x) => x.id === r.id)?.outcome, `seed ${seed}`).toBe('connected');
    // Nothing un-paused it: refusal 3 of the guardrail, held under load.
    await refreshAbandonmentWindow();
    expect(await world.status('B')).toBe('paused');
    expect(await world.status('N')).toBe('completed');
  }, 300_000);
});
