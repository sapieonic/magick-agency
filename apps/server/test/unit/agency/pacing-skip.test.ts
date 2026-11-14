import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// The scheduled path of the pacing engine: rounds, the skip of a quiescent
// campaign, the invalidation bus that wakes it, the safety tick that bounds a lost
// event, the cross-round caches of the campaign row and the account limit, and
// the per-account split a round arbitrates between the campaigns of one account, the
// cached dedicated caller IDs (`pacing/dedicated-caller-ids.ts`) and `dedications_changed`,
// (decisions MC1, MC2, MC4, MC5, MC7; the round itself is `pacing-round.test.ts`), the
// pending-dial ledger that carries a tick's grant across rounds, and the claim-shortfall cap. `pacing-engine.test.ts` is the tick's
// arithmetic through `tickOnce` (a forced, never-skipped, fresh tick); this file
// drives `runRound`, with the round timer off and a fake engine clock.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { repos, settings } = vi.hoisted(() => ({
  repos: {
    campaign: {
      findById: vi.fn(),
      findActive: vi.fn().mockResolvedValue([]),
      countOutstanding: vi.fn().mockResolvedValue(1),
      transitionStatus: vi.fn(),
    },
    contact: {
      claimDialable: vi.fn().mockResolvedValue([]),
      countDialable: vi.fn(async (_id: string, limit: number) => limit),
      unclaim: vi.fn().mockResolvedValue(undefined),
      unclaimMany: vi.fn().mockResolvedValue(undefined),
      markState: vi.fn().mockResolvedValue(null),
    },
    attempt: {
      countLive: vi.fn().mockResolvedValue(0),
      countLiveForAccount: vi.fn().mockResolvedValue(0),
      countLiveByCampaignForAccount: vi.fn().mockResolvedValue(new Map()),
      create: vi.fn(),
      setState: vi.fn().mockResolvedValue(null),
    },
    session: {
      findLiveForCampaign: vi.fn().mockResolvedValue([]),
      setState: vi.fn().mockResolvedValue(null),
    },
    // No dedicated caller IDs (DN1) unless a case says so: every contact dials from the rotation.
    callerIds: { mapForCampaign: vi.fn(async () => new Map<string, string>()) },
  },
  settings: { getMaxConcurrentCalls: vi.fn().mockResolvedValue(5) },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAttemptRepository: repos.attempt,
  agencyAgentSessionRepository: repos.session,
  agencyAgentCallerIdRepository: repos.callerIds,
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: settings,
}));
const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean', default: false } },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

import {
  PacingEngine, PACING_DIAL_HOLD_MAX_MS, PACING_SAFETY_TICK_MS, type PacingTickObservation,
} from '../../../src/agency/pacing-engine.js';
import {
  InProcessPacingInvalidationBus,
  parsePacingInvalidationEvent,
  type PacingInvalidationEvent,
} from '../../../src/agency/pacing/invalidation-bus.js';
import { GenerationTtlCache } from '../../../src/agency/pacing/read-cache.js';
import {
  agencyCampaignSlotsSnapshot,
  agencyPacingShareWithheldTotal,
  resetAgencyCampaignSlots,
} from '@magick-agency/observability/metrics/agency';
import { withPacingInvalidation } from '../../../src/agency/pacing/limit-invalidation.js';

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3', tenant_id: 't1', account_id: 'a1',
  status: 'running', caller_ids: ['+14155550100'],
  calling_window_start: '00:00:00', calling_window_end: '24:00:00',
  calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
  pause_reason: null, paused_at: null, pause_abandonment_rate_pct: null,
  abandonment_ceiling_pct: 3, updated_at: new Date('2026-11-01T00:00:00Z'),
} as any;

function contact(id: string) {
  return { id, phone_e164: '+919876543210', context: {}, attempt_count: 0 } as any;
}

function makeAgents(states: Record<string, string>) {
  const get = vi.fn(async (id: string) => (states[id] ? { state: states[id], attemptId: null, since: 1 } : null));
  return {
    get,
    getMany: vi.fn(async (ids: readonly string[]) => Promise.all(ids.map((id) => get(id)))),
    reserve: vi.fn(async (id: string) => {
      if (states[id] !== 'available') return 'lost';
      states[id] = 'reserved';
      return 'reserved';
    }),
    set: vi.fn(async (id: string, s: string) => { states[id] = s; return 'ok'; }),
  };
}

/** Stations on `owned`'s campaigns; each can take inbound calls (IQ46) unless listed in `cannotTakeInbound`. */
function makeStations(owned: Record<string, string>, cannotTakeInbound: readonly string[] = []) {
  return {
    isLocallyOwned: vi.fn((id: string) => id in owned),
    ownerOf: vi.fn(async (id: string) => (id in owned ? 'r1' : null)),
    broadcast: vi.fn(() => 0),
    sessionIdsForCampaign: vi.fn(() => Object.keys(owned)),
    get: vi.fn((id: string) => (id in owned
      ? { sessionId: id, campaignId: owned[id], canTakeInbound: !cannotTakeInbound.includes(id) }
      : undefined)),
  };
}

interface Rig {
  e: PacingEngine;
  bus: InProcessPacingInvalidationBus;
  clock: { t: number };
  ticks: PacingTickObservation[];
  dispatch: ReturnType<typeof vi.fn>;
}

function rig(opts: {
  stations: any; agents: any; bus?: InProcessPacingInvalidationBus; clock?: { t: number }; cacheTtlMs?: number;
  shareWaitMs?: number;
}): Rig {
  const bus = opts.bus ?? new InProcessPacingInvalidationBus();
  const clock = opts.clock ?? { t: 1_000_000 };
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const e = new PacingEngine(
    null, '', 'r1', opts.stations, opts.agents, { dispatch } as any, { check: vi.fn().mockResolvedValue('clear') } as any,
    {
      bus, now: () => clock.t, ...(opts.cacheTtlMs ? { cacheTtlMs: opts.cacheTtlMs } : {}),
      ...(opts.shareWaitMs !== undefined ? { shareWaitMs: opts.shareWaitMs } : {}),
    },
  );
  e.setAutoRounds(false);
  const ticks: PacingTickObservation[] = [];
  e.registerTickObserver((o) => ticks.push(o));
  return { e, bus, clock, ticks, dispatch };
}

/** Lead without the supervise pass (no lease: the engine was built with no Redis). */
function lead(e: PacingEngine, campaign = CAMPAIGN): void {
  (e as any).beginLeading(campaign);
}

/** Every statement the engine's repositories were asked for. */
function dbCalls(): number {
  return [
    repos.campaign.findById, repos.campaign.countOutstanding, repos.attempt.countLive,
    repos.attempt.countLiveForAccount, repos.session.findLiveForCampaign, settings.getMaxConcurrentCalls,
    repos.contact.claimDialable, repos.attempt.countLiveByCampaignForAccount, repos.contact.countDialable,
  ].reduce((n, f) => n + f.mock.calls.length, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  repos.campaign.findById.mockResolvedValue(CAMPAIGN);
  repos.campaign.countOutstanding.mockResolvedValue(1);
  repos.contact.claimDialable.mockResolvedValue([]);
  repos.attempt.countLiveForAccount.mockResolvedValue(0);
  repos.attempt.countLiveByCampaignForAccount.mockResolvedValue(new Map());
  repos.contact.countDialable.mockImplementation(async (_id: string, limit: number) => limit);
  repos.contact.markState.mockResolvedValue(null);
  resetAgencyCampaignSlots();
  repos.attempt.create.mockImplementation(async (p: any) => ({
    id: `att-${p.contactId}`, caller_id: p.callerId, attempt_number: 1,
  }));
  settings.getMaxConcurrentCalls.mockResolvedValue(5);
  repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
  repos.callerIds.mapForCampaign.mockImplementation(async () => new Map());
});

const engines: PacingEngine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
});
function track(r: Rig): Rig {
  engines.push(r.e);
  return r;
}

// ─── The bus ────────────────────────────────────────────────────────────────

describe('PacingInvalidationBus (in process)', () => {
  it('delivers a JSON copy of each event to every subscriber, and stops after unsubscribe', () => {
    const bus = new InProcessPacingInvalidationBus();
    const got: PacingInvalidationEvent[] = [];
    const off = bus.subscribe((e) => got.push(e));
    const event = { type: 'account_limit_changed', tenantId: 't1', accountId: 'a1' } as const;
    bus.publish(event);
    expect(got).toEqual([event]);
    expect(got[0]).not.toBe(event); // went through the wire format
    off();
    bus.publish(event);
    expect(got).toHaveLength(1);
    expect(bus.subscriberCount).toBe(0);
  });

  it('a throwing subscriber neither stops the others nor reaches the publisher', () => {
    const bus = new InProcessPacingInvalidationBus();
    const got: string[] = [];
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe((e) => got.push(e.type));
    expect(() => bus.publish({ type: 'campaign_changed', campaignId: 'c' })).not.toThrow();
    expect(got).toEqual(['campaign_changed']);
  });

  it('every event type survives the wire; malformed and unknown ones are dropped', () => {
    const events: PacingInvalidationEvent[] = [
      { type: 'campaign_changed', campaignId: 'c1' },
      { type: 'contacts_changed', campaignId: 'c1' },
      { type: 'account_limit_changed', tenantId: 't', accountId: 'a' },
      { type: 'account_capacity_freed', tenantId: 't', accountId: 'a' },
      { type: 'agent_available', sessionId: 's', campaignId: 'c1' },
      { type: 'agent_available', sessionId: 's', campaignId: null },
      { type: 'station_ready', sessionId: 's', campaignId: 'c1' },
      { type: 'dedications_changed', campaignId: 'c1' },
      { type: 'campaign_stats_stale', campaignId: 'c1' },
    ];
    for (const e of events) expect(parsePacingInvalidationEvent(JSON.parse(JSON.stringify(e)))).toEqual(e);
    for (const bad of [null, 'x', {}, { type: 'nope' }, { type: 'campaign_changed' },
      { type: 'account_limit_changed', tenantId: 't' }, { type: 'agent_available', sessionId: 's', campaignId: 7 },
      { type: 'station_ready', sessionId: 's', campaignId: null }, { type: 'station_ready', campaignId: 'c1' },
      { type: 'dedications_changed' }, { type: 'dedications_changed', campaignId: '' }]) {
      expect(parsePacingInvalidationEvent(bad)).toBeNull();
    }
  });
});

// ─── The cache ──────────────────────────────────────────────────────────────

describe('GenerationTtlCache', () => {
  it('serves until the TTL, then misses', () => {
    const clock = { t: 0 };
    const c = new GenerationTtlCache<number>(100, () => clock.t);
    c.setIf('k', c.generation('k'), 1);
    clock.t = 99;
    expect(c.get('k')).toBe(1);
    clock.t = 100;
    expect(c.get('k')).toBeUndefined();
  });

  it('a load that an invalidation overtook is returned but NOT stored', async () => {
    const c = new GenerationTtlCache<string>(10_000);
    let release!: (v: string) => void;
    const loading = c.getOrLoad('k', () => new Promise<string>((r) => { release = r; }));
    c.invalidate('k'); // the write commits and its event lands while the read is in flight
    release('stale');
    expect(await loading).toBe('stale');
    expect(c.get('k')).toBeUndefined();
    expect(await c.getOrLoad('k', async () => 'fresh')).toBe('fresh');
    expect(c.get('k')).toBe('fresh');
  });

  it('remembers a bounded number of generations, and a fold never lets an overtaken load store', async () => {
    const c = new GenerationTtlCache<string>(10_000, Date.now, 3);
    let release!: (v: string) => void;
    const loading = c.getOrLoad('k', () => new Promise<string>((r) => { release = r; }));
    c.invalidate('k'); // overtakes the load
    for (const key of ['a', 'b', 'c', 'd', 'e']) c.invalidate(key); // folds the map, forgetting 'k'
    expect(c.trackedGenerations).toBeLessThanOrEqual(3);
    release('stale');
    expect(await loading).toBe('stale');
    expect(c.get('k')).toBeUndefined();
    // A key never invalidated still caches after a fold, and so does 'k' afresh.
    expect(await c.getOrLoad('z', async () => 'fresh')).toBe('fresh');
    expect(c.get('z')).toBe('fresh');
    expect(await c.getOrLoad('k', async () => 'again')).toBe('again');
    expect(c.get('k')).toBe('again');
  });

  it('a load in flight across a clear does not store', async () => {
    const c = new GenerationTtlCache<string>(10_000);
    let release!: (v: string) => void;
    const loading = c.getOrLoad('never-invalidated', () => new Promise<string>((r) => { release = r; }));
    c.clear();
    release('stale');
    await loading;
    expect(c.get('never-invalidated')).toBeUndefined();
  });

  it('bounded: an expired entry is dropped when looked up; a full cache drops every expired entry before any live one', () => {
    const clock = { t: 0 };
    const c = new GenerationTtlCache<number>(100, () => clock.t, 10, 3);
    clock.t = 950; c.setIf('live-old', c.generation('live-old'), 1);
    clock.t = 800; c.setIf('stale-1', c.generation('stale-1'), 2);
    clock.t = 850; c.setIf('stale-2', c.generation('stale-2'), 3);
    clock.t = 1_000; c.setIf('new', c.generation('new'), 4);
    expect(c.size).toBe(2);
    expect(c.get('live-old')).toBe(1);
    expect(c.get('new')).toBe(4);
    clock.t = 1_100;
    expect(c.get('new')).toBeUndefined();
    expect(c.size).toBe(1);
  });

  it('bounded: with nothing expired a full cache drops the oldest stored (a rewrite is the newest)', () => {
    const clock = { t: 0 };
    const c = new GenerationTtlCache<number>(1_000, () => clock.t, 10, 2);
    const put = (k: string, v: number, t: number) => { clock.t = t; c.setIf(k, c.generation(k), v); };
    put('first', 1, 0);
    put('second', 2, 1);
    put('first', 10, 2);
    put('third', 3, 3);
    expect(c.size).toBe(2);
    expect(c.get('second')).toBeUndefined();
    expect(c.get('first')).toBe(10);
    expect(c.get('third')).toBe(3);
  });

  it('`fresh` reads through and still stores', async () => {
    const c = new GenerationTtlCache<number>(10_000);
    await c.getOrLoad('k', async () => 1);
    expect(await c.getOrLoad('k', async () => 2)).toBe(1);
    expect(await c.getOrLoad('k', async () => 3, { fresh: true })).toBe(3);
    expect(c.get('k')).toBe(3);
  });
});

// ─── The engine's scheduled path ────────────────────────────────────────────

describe('PacingEngine rounds: skipping a quiescent campaign', () => {
  it('after one full no-agents tick, rounds skip with NO database or Redis work until something changes', async () => {
    const agents = makeAgents({ s1: 'on_call', s2: 'break' });
    const r = track(rig({ stations: makeStations({ s1: 'camp-1', s2: 'camp-1' }), agents }));
    lead(r.e);

    await r.e.runRound();
    expect(r.ticks).toEqual([expect.objectContaining({ mode: 'full', cause: 'first', quiescent: true })]);
    const db = dbCalls();
    const redis = agents.getMany.mock.calls.length;

    for (let i = 0; i < 3; i++) {
      r.clock.t += 250;
      await r.e.runRound();
    }
    expect(r.ticks.slice(1).map((t) => t.mode)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(dbCalls()).toBe(db);
    expect(agents.getMany.mock.calls.length).toBe(redis);
  });

  it('an agent becoming available after an idle period is dialed on the VERY NEXT round', async () => {
    const states: Record<string, string> = { s1: 'on_call', s2: 'break' };
    const agents = makeAgents(states);
    const r = track(rig({ stations: makeStations({ s1: 'camp-1', s2: 'camp-1' }), agents }));
    lead(r.e);
    await r.e.runRound();
    for (let i = 0; i < 3; i++) { r.clock.t += 250; await r.e.runRound(); }
    expect(r.dispatch).not.toHaveBeenCalled();

    // The agent's wrap-up ends: the state write publishes (the runtime wires it).
    states.s1 = 'available';
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    r.bus.publish({ type: 'agent_available', sessionId: 's1', campaignId: null }); // resolved via the station
    r.clock.t += 250;
    await r.e.runRound();

    expect(r.ticks.at(-1)).toMatchObject({ mode: 'full', cause: 'event' });
    expect(r.dispatch).toHaveBeenCalledTimes(1);
  });

  it('with no event at all, the safety tick re-reads within PACING_SAFETY_TICK_MS and counts a missed wake-up', async () => {
    const states: Record<string, string> = { s1: 'on_call' };
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents(states) }));
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    lead(r.e);
    await r.e.runRound();

    // The agent becomes available by a path that published nothing.
    states.s1 = 'available';
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    let rounds = 0;
    while (r.dispatch.mock.calls.length === 0 && rounds < 20) {
      r.clock.t += 250;
      await r.e.runRound();
      rounds++;
    }
    expect(r.dispatch).toHaveBeenCalledTimes(1);
    expect(rounds * 250).toBeLessThanOrEqual(PACING_SAFETY_TICK_MS);
    expect(rounds * 250).toBeGreaterThanOrEqual(PACING_SAFETY_TICK_MS);
    expect(r.ticks.at(-1)).toMatchObject({ mode: 'full', cause: 'safety', plan: { toDial: 1 } });
  });

  it('a campaign that planned a dial ticks every round (never skipped while active)', async () => {
    const states: Record<string, string> = { s1: 'available' };
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents(states) }));
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    // Agents available, nothing to claim (retries maturing): planned 1, dialled 0.
    lead(r.e);
    for (let i = 0; i < 4; i++) { await r.e.runRound(); r.clock.t += 250; states.s1 = 'available'; }
    expect(r.ticks.map((t) => t.mode)).toEqual(['full', 'full', 'full', 'full']);
    expect(r.ticks.slice(1).every((t) => t.mode === 'full' && t.cause === 'active')).toBe(true);
  });

  it('an event that lands DURING a full tick wakes the next round', async () => {
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents({ s1: 'on_call' }) }));
    repos.session.findLiveForCampaign.mockImplementation(async () => {
      r.bus.publish({ type: 'account_capacity_freed', tenantId: 't1', accountId: 'a1' });
      return [{ id: 's1' }];
    });
    lead(r.e);
    await r.e.runRound();
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.map((t) => t.mode === 'full' ? t.cause : 'skipped')).toEqual(['first', 'event']);
  });

  it('a paused campaign is skipped until campaign_changed, which also drops the cached row', async () => {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, status: 'paused' });
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents({ s1: 'available' }) }));
    lead(r.e);
    await r.e.runRound();
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.map((t) => t.mode)).toEqual(['full', 'skipped']);

    repos.campaign.findById.mockResolvedValue(CAMPAIGN);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    r.bus.publish({ type: 'campaign_changed', campaignId: 'camp-1' });
    r.clock.t += 250;
    await r.e.runRound();
    expect(repos.campaign.findById).toHaveBeenCalledTimes(2);
    expect(r.dispatch).toHaveBeenCalledTimes(1);
  });

  it('an unrelated account event does not wake the campaign', async () => {
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents({ s1: 'on_call' }) }));
    lead(r.e);
    await r.e.runRound();
    r.bus.publish({ type: 'account_capacity_freed', tenantId: 't1', accountId: 'other' });
    r.bus.publish({ type: 'campaign_changed', campaignId: 'other' });
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.map((t) => t.mode)).toEqual(['full', 'skipped']);
  });

  it('a skipped round still counts as an idle tick with the last reason', async () => {
    const { agencyTickIdleTotal } = await import('@magick-agency/observability/metrics/agency');
    const inc = vi.spyOn(agencyTickIdleTotal, 'inc');
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents({ s1: 'on_call' }) }));
    lead(r.e);
    await r.e.runRound();
    r.clock.t += 250;
    await r.e.runRound();
    expect(inc.mock.calls.map((c) => (c[0] as any).reason)).toEqual(['no_agents', 'no_agents']);
    inc.mockRestore();
  });

  it('`tickOnce` is never skipped and always reads the row and the limit fresh', async () => {
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents({ s1: 'available' }) }));
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    lead(r.e);
    await r.e.runRound();
    await r.e.tickOnce('camp-1');
    await r.e.tickOnce('camp-1');
    expect(repos.campaign.findById).toHaveBeenCalledTimes(3);
    expect(settings.getMaxConcurrentCalls).toHaveBeenCalledTimes(3);
  });

  it('stop() unsubscribes from the bus and stops the rounds', async () => {
    const r = rig({ stations: makeStations({}), agents: makeAgents({}) });
    lead(r.e);
    expect(r.bus.subscriberCount).toBe(1);
    await r.e.stop();
    expect(r.bus.subscriberCount).toBe(0);
    await r.e.runRound();
    expect(r.ticks).toEqual([]);
  });
});

describe('PacingEngine rounds: the cached account limit', () => {
  /** A campaign at its limit with one agent waiting: every full tick reads the limit. */
  function atLimit(limit: number) {
    settings.getMaxConcurrentCalls.mockResolvedValue(limit);
    repos.attempt.countLiveForAccount.mockResolvedValue(limit);
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
  }

  it('is read once and reused by later full ticks until its TTL', async () => {
    atLimit(2);
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents({ s1: 'available' }), cacheTtlMs: 2_000 }));
    lead(r.e);
    await r.e.runRound();
    r.bus.publish({ type: 'account_capacity_freed', tenantId: 't1', accountId: 'a1' });
    r.clock.t += 250;
    await r.e.runRound();
    expect(settings.getMaxConcurrentCalls).toHaveBeenCalledTimes(1);
    r.clock.t += 2_000;
    r.bus.publish({ type: 'account_capacity_freed', tenantId: 't1', accountId: 'a1' });
    await r.e.runRound();
    expect(settings.getMaxConcurrentCalls).toHaveBeenCalledTimes(2);
  });

  it('a LOWERED limit reaches two engines on one bus within one round, through the seam', async () => {
    // Two engines ("replicas") on the same bus, each leading a campaign on account
    // a1, each holding the limit 5 in its cache.
    const bus = new InProcessPacingInvalidationBus();
    const clock = { t: 1_000_000 };
    const agentsA = makeAgents({ s1: 'available', s2: 'available', s3: 'available' });
    const agentsB = makeAgents({ s4: 'available', s5: 'available', s6: 'available' });
    const a = track(rig({ bus, clock, stations: makeStations({ s1: 'camp-1', s2: 'camp-1', s3: 'camp-1' }), agents: agentsA }));
    const b = track(rig({ bus, clock, stations: makeStations({ s4: 'camp-2', s5: 'camp-2', s6: 'camp-2' }), agents: agentsB }));
    const CAMP2 = { ...CAMPAIGN, id: 'camp-2' };
    repos.campaign.findById.mockImplementation(async (id: string) => (id === 'camp-2' ? CAMP2 : CAMPAIGN));
    repos.session.findLiveForCampaign.mockImplementation(async (id: string) =>
      id === 'camp-2' ? [{ id: 's4' }, { id: 's5' }, { id: 's6' }] : [{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    settings.getMaxConcurrentCalls.mockResolvedValue(5);
    repos.attempt.countLiveForAccount.mockResolvedValue(5); // at the limit: both quiescent, both cached 5
    lead(a.e);
    lead(b.e, CAMP2);
    await a.e.runRound();
    await b.e.runRound();
    expect(a.ticks.at(-1)).toMatchObject({ plan: { accountLimit: 5, toDial: 0 } });
    expect(b.ticks.at(-1)).toMatchObject({ plan: { accountLimit: 5, toDial: 0 } });

    // A super-admin lowers the limit to 2 and three calls end (live 2). The write goes
    // through the ConcurrencyControl seam, decorated as `startAgency` decorates it.
    settings.getMaxConcurrentCalls.mockResolvedValue(2);
    repos.attempt.countLiveForAccount.mockResolvedValue(2);
    const control = withPacingInvalidation({
      invalidateAccountLimit: vi.fn().mockResolvedValue(undefined),
      invalidateProviderLimits: vi.fn().mockResolvedValue(undefined),
      getAccountProviderCounts: vi.fn(), getAccountCount: vi.fn(), getDistributedAccountCount: vi.fn(),
    }, (e) => bus.publish(e));
    await control.invalidateAccountLimit('t1', 'a1');
    bus.publish({ type: 'account_capacity_freed', tenantId: 't1', accountId: 'a1' });

    clock.t += 250;
    await a.e.runRound();
    await b.e.runRound();
    // With the stale 5 each would plan 3 dials; with 2, none.
    expect(a.ticks.at(-1)).toMatchObject({ mode: 'full', plan: { accountLimit: 2, toDial: 0 } });
    expect(b.ticks.at(-1)).toMatchObject({ mode: 'full', plan: { accountLimit: 2, toDial: 0 } });
    expect(repos.contact.claimDialable).not.toHaveBeenCalled();
  });

  it('a lowered limit whose event is LOST is picked up once the TTL lapses (the backstop)', async () => {
    const bus = new InProcessPacingInvalidationBus();
    const clock = { t: 1_000_000 };
    const a = track(rig({ bus, clock, cacheTtlMs: 500, stations: makeStations({ s1: 'camp-1', s2: 'camp-1' }), agents: makeAgents({ s1: 'available', s2: 'available' }) }));
    const b = track(rig({ bus, clock, cacheTtlMs: 500, stations: makeStations({ s1: 'camp-1', s2: 'camp-1' }), agents: makeAgents({ s1: 'available', s2: 'available' }) }));
    settings.getMaxConcurrentCalls.mockResolvedValue(5);
    repos.attempt.countLiveForAccount.mockResolvedValue(5);
    lead(a.e);
    lead(b.e);
    await a.e.runRound();
    await b.e.runRound();

    // Raw write: no event. Live drops to 2 by a path that published nothing either.
    settings.getMaxConcurrentCalls.mockResolvedValue(2);
    repos.attempt.countLiveForAccount.mockResolvedValue(2);
    const seen: Array<number | null> = [];
    for (let i = 0; i < 8; i++) {
      clock.t += 250;
      await a.e.runRound();
      await b.e.runRound();
    }
    for (const r of [a, b]) {
      const full = r.ticks.filter((t) => t.mode === 'full' && t.plan);
      seen.push((full.at(-1) as any).plan.accountLimit);
    }
    expect(seen).toEqual([2, 2]);
    expect(repos.contact.claimDialable).not.toHaveBeenCalled();
  });
});

describe('PacingEngine rounds: the cached dedicated caller IDs (DN4)', () => {
  const POOL = ['+14155550100', '+14155550101'];
  const OWNED = { ...CAMPAIGN, caller_ids: POOL };
  /** One agent, one contact owned by u1 per round: the round's dial shows which map it used. */
  function dialling() {
    repos.campaign.findById.mockResolvedValue(OWNED);
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    repos.contact.claimDialable.mockImplementation(async () => [{ ...contact('c1'), assigned_user_id: 'u1' }]);
    const states: Record<string, string> = { s1: 'available' };
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents(states), cacheTtlMs: 2_000 }));
    lead(r.e);
    /** The next round, with the agent back in `available` (the mock dispatch never ends the call). */
    const round = async () => {
      states['s1'] = 'available';
      r.clock.t += 250;
      await r.e.runRound();
    };
    const lastCallerId = () => r.dispatch.mock.calls.at(-1)![0].callerId as string;
    return { r, round, lastCallerId, states };
  }

  it('is read once and reused by later dialling rounds; dedications_changed drops it at once', async () => {
    repos.callerIds.mapForCampaign.mockResolvedValue(new Map([['u1', '+14155550101']]));
    const { r, round, lastCallerId } = dialling();
    await round();
    expect(lastCallerId()).toBe('+14155550101');

    // Released in the database, but no event yet: the cached dedication is still used.
    repos.callerIds.mapForCampaign.mockResolvedValue(new Map());
    await round();
    expect(repos.callerIds.mapForCampaign).toHaveBeenCalledTimes(1);
    expect(lastCallerId()).toBe('+14155550101');

    // Another campaign's event leaves this one cached.
    r.bus.publish({ type: 'dedications_changed', campaignId: 'camp-2' });
    await round();
    expect(repos.callerIds.mapForCampaign).toHaveBeenCalledTimes(1);

    // The release's event: the very next round reads again and dials from the rotation.
    r.bus.publish({ type: 'dedications_changed', campaignId: 'camp-1' });
    await round();
    expect(repos.callerIds.mapForCampaign).toHaveBeenCalledTimes(2);
    expect(r.dispatch).toHaveBeenCalledTimes(4);
    expect(POOL).toContain(lastCallerId());
    expect(r.e.dedications.isArmed).toBe(true);
  });

  it('a change whose event is LOST is picked up once the TTL lapses (the backstop)', async () => {
    const { r, round, lastCallerId } = dialling();
    await round();
    repos.callerIds.mapForCampaign.mockResolvedValue(new Map([['u1', '+14155550101']]));
    await round();
    expect(repos.callerIds.mapForCampaign).toHaveBeenCalledTimes(1);
    r.clock.t += 2_000;
    await round();
    expect(repos.callerIds.mapForCampaign).toHaveBeenCalledTimes(2);
    expect(lastCallerId()).toBe('+14155550101');
  });

  it('dedications_changed wakes nothing: a quiescent campaign stays skipped', async () => {
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents({ s1: 'on_call' }) }));
    lead(r.e);
    await r.e.runRound();
    r.bus.publish({ type: 'dedications_changed', campaignId: 'camp-1' });
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.map((t) => t.mode)).toEqual(['full', 'skipped']);
    expect(repos.callerIds.mapForCampaign).not.toHaveBeenCalled();
  });

  it('a failed read is not cached: the next round reads again', async () => {
    repos.callerIds.mapForCampaign.mockRejectedValueOnce(new Error('connection reset'));
    const { r, round } = dialling();
    await round();
    expect(r.dispatch).not.toHaveBeenCalled();
    await round();
    expect(repos.callerIds.mapForCampaign).toHaveBeenCalledTimes(2);
    expect(r.dispatch).toHaveBeenCalledTimes(1);
  });

  it('a forced tick reads through; giving up the last campaign disarms the cache (reads through again)', async () => {
    const { r, round, states } = dialling();
    await round();
    states['s1'] = 'available';
    await r.e.tickOnce('camp-1');
    expect(repos.callerIds.mapForCampaign).toHaveBeenCalledTimes(2);
    await r.e.stop();
    expect(r.e.dedications.isArmed).toBe(false);
    await r.e.dedications.read('camp-1');
    await r.e.dedications.read('camp-1');
    expect(repos.callerIds.mapForCampaign).toHaveBeenCalledTimes(4);
  });
});

describe('PacingEngine rounds: per-account sharing (MC1, MC2)', () => {
  const CAMP2 = { ...CAMPAIGN, id: 'camp-2' };

  /**
   * camp-1 (s1 … sN) and camp-2 (sN+1 … s2N) on account t1:a1, N = `agentsEach` (default 2),
   * every agent available, both led. `states` is the agents' Redis state, for a test to
   * hand dialled agents back between rounds.
   */
  function twoCampaigns(opts: { shareWaitMs?: number; camp2?: any; agentsEach?: number } = {}): Rig & {
    states: Record<string, string>;
    freeAll(): void;
  } {
    const camp2 = opts.camp2 ?? CAMP2;
    const n = opts.agentsEach ?? 2;
    const states: Record<string, string> = {};
    const owned: Record<string, string> = {};
    const sessionsOf: Record<string, Array<{ id: string }>> = { 'camp-1': [], 'camp-2': [] };
    for (const [c, campaignId] of ['camp-1', 'camp-2'].entries()) {
      for (let i = 1; i <= n; i++) {
        const id = `s${c * n + i}`;
        states[id] = 'available';
        owned[id] = campaignId;
        sessionsOf[campaignId]!.push({ id });
      }
    }
    repos.campaign.findById.mockImplementation(async (id: string) => (id === 'camp-2' ? camp2 : CAMPAIGN));
    repos.session.findLiveForCampaign.mockImplementation(async (id: string) => sessionsOf[id] ?? []);
    const r = track(rig({
      stations: makeStations(owned),
      agents: makeAgents(states),
      ...(opts.shareWaitMs !== undefined ? { shareWaitMs: opts.shareWaitMs } : {}),
    }));
    lead(r.e);
    lead(r.e, camp2);
    return {
      ...r, states,
      freeAll: () => { for (const id of Object.keys(states)) states[id] = 'available'; },
    };
  }

  /** As many fresh contacts as asked, for every campaign. */
  function claimsAll(): void {
    let seq = 0;
    repos.contact.claimDialable.mockImplementation(async (id: string, limit: number) =>
      Array.from({ length: limit }, () => contact(`${id}-c${seq++}`)));
  }

  /**
   * Every attempt the mock inserts stays live, and the account reads count them: what the
   * database would show while the carrier holds every call.
   */
  function insertsStayLive(): Record<string, number> {
    const live: Record<string, number> = {};
    repos.attempt.create.mockImplementation(async (p: any) => {
      live[p.campaignId] = (live[p.campaignId] ?? 0) + 1;
      return { id: `att-${p.contactId}`, caller_id: p.callerId, attempt_number: 1 };
    });
    repos.attempt.countLiveForAccount.mockImplementation(async () =>
      Object.values(live).reduce((a, b) => a + b, 0));
    repos.attempt.countLiveByCampaignForAccount.mockImplementation(async () => new Map(Object.entries(live)));
    return live;
  }

  /** The pending-dial ledger per account: the sum of its holds (stale or not). */
  const ledger = (r: Rig) => new Map([...((r.e as any).pendingDials as Map<string, Set<{ remaining: number }>>)]
    .map(([k, holds]) => [k, [...holds].reduce((n, h) => n + h.remaining, 0)] as const));

  const planOf = (r: Rig, campaignId: string) => {
    const t = r.ticks.filter((x) => x.campaignId === campaignId).at(-1);
    return t && t.mode === 'full' ? t : undefined;
  };

  /** Hold camp-2's session reads until the returned release is called. */
  function holdCamp2Read(): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sessions = repos.session.findLiveForCampaign.getMockImplementation()!;
    repos.session.findLiveForCampaign.mockImplementation(async (id: string) => {
      if (id === 'camp-2') await gate;
      return sessions(id);
    });
    return release;
  }

  /** camp-1's carrier hangs until the returned answer is called, so its tick outlives its round. */
  function hangCarrier(r: Rig): () => void {
    let answer!: () => void;
    const carrier = new Promise<void>((resolve) => { answer = resolve; });
    r.dispatch.mockImplementation(async (cmd: any) => { if (cmd.campaignId === 'camp-1') await carrier; });
    return answer;
  }

  it('two campaigns of one account read the account ONCE and split its headroom, never past the limit', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(5);
    repos.attempt.countLiveForAccount.mockResolvedValue(2); // 3 slots left on the account
    const r = twoCampaigns();
    await r.e.runRound();

    expect(repos.attempt.countLiveForAccount).toHaveBeenCalledTimes(1);
    expect(settings.getMaxConcurrentCalls).toHaveBeenCalledTimes(1);
    // Contended: one grouped per-campaign read for the account, one due-contact count each.
    expect(repos.attempt.countLiveByCampaignForAccount).toHaveBeenCalledTimes(1);
    expect(repos.attempt.countLiveByCampaignForAccount).toHaveBeenCalledWith('t1', 'a1');
    expect(repos.contact.countDialable.mock.calls.map((c) => c[0]).sort()).toEqual(['camp-1', 'camp-2']);
    // 4 idle agents, 3 slots, both campaigns at 0 live: 2 + 1 (the odd slot by the
    // rotation, camp-1 first in the first round), never 2 + 2 and never 3 + 0.
    expect(planOf(r, 'camp-1')!.plan!.toDial).toBe(2);
    expect(planOf(r, 'camp-2')!.plan!.toDial).toBe(1);
    expect(repos.contact.claimDialable.mock.calls.reduce((n, c) => n + (c[1] as number), 0)).toBe(3);
  });

  it('a tie\'s odd slot alternates between the campaigns round by round', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(3);
    repos.attempt.countLiveForAccount.mockResolvedValue(2); // one slot a round
    const r = twoCampaigns();
    const winners: string[] = [];
    for (let i = 0; i < 4; i++) {
      await r.e.runRound();
      winners.push((planOf(r, 'camp-1')!.plan!.toDial === 1) ? 'camp-1' : 'camp-2');
      r.clock.t += 250;
    }
    expect(winners).toEqual(['camp-1', 'camp-2', 'camp-1', 'camp-2']);
  });

  it('each slot goes to the campaign with the fewest live calls; the one held back is not quiescent (MC5)', async () => {
    const inc = vi.spyOn(agencyPacingShareWithheldTotal, 'inc');
    try {
      settings.getMaxConcurrentCalls.mockResolvedValue(5);
      repos.attempt.countLiveForAccount.mockResolvedValue(3);
      repos.attempt.countLiveByCampaignForAccount.mockResolvedValue(new Map([['camp-1', 3]]));
      const r = twoCampaigns();
      await r.e.runRound();

      // 2 slots: camp-2 (0 live) takes both before camp-1 (3 live) gets any.
      expect(planOf(r, 'camp-2')!.plan!.toDial).toBe(2);
      expect(planOf(r, 'camp-1')).toMatchObject({ quiescent: false, plan: { toDial: 0, idle: 'no_slots' } });
      // The share rule held 2 back from camp-1 while the account had room.
      expect(inc.mock.calls).toEqual([[{ campaign_id: 'camp-1' }, 2]]);
      expect(Object.fromEntries(agencyCampaignSlotsSnapshot())).toEqual({
        'camp-1': { inUse: 3, allocated: 3 },
        'camp-2': { inUse: 0, allocated: 2 },
      });

      // Not skipped next round although nothing woke it: no event announces the other
      // campaign leaving slots unused.
      r.clock.t += 250;
      await r.e.runRound();
      expect(planOf(r, 'camp-1')).toMatchObject({ mode: 'full', cause: 'active' });
    } finally {
      inc.mockRestore();
    }
  });

  it('a campaign at the limit with no headroom stays quiescent (nothing was withheld)', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(4);
    repos.attempt.countLiveForAccount.mockResolvedValue(4);
    const r = twoCampaigns();
    await r.e.runRound();
    for (const id of ['camp-1', 'camp-2']) {
      expect(planOf(r, id)).toMatchObject({ quiescent: true, plan: { toDial: 0, idle: 'no_slots' } });
    }
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.slice(-2).map((t) => t.mode)).toEqual(['skipped', 'skipped']);
  });

  it('capacity a campaign cannot use flows to the other: no due contacts leaves it the whole headroom', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(4);
    repos.attempt.countLiveForAccount.mockResolvedValue(2); // 2 slots
    repos.contact.countDialable.mockImplementation(async (id: string, limit: number) => (id === 'camp-2' ? 0 : limit));
    const r = twoCampaigns();
    await r.e.runRound();
    expect(planOf(r, 'camp-1')!.plan!.toDial).toBe(2);
    // Nothing due on camp-2: recorded before any reservation, and not quiescent (time makes contacts due).
    expect(planOf(r, 'camp-2')).toMatchObject({ quiescent: false, plan: { toDial: 0, idle: 'no_contacts' } });
    expect(repos.contact.claimDialable.mock.calls.map((c) => c[0])).toEqual(['camp-1']);
  });

  it('a campaign alone on its account issues no extra statement and carries no slot series', async () => {
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents({ s1: 'available' }) }));
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    const { setAgencyCampaignSlots } = await import('@magick-agency/observability/metrics/agency');
    setAgencyCampaignSlots('camp-1', 7, 7); // a stale series from an earlier contended round
    lead(r.e);
    await r.e.runRound();
    expect(r.ticks.at(-1)).toMatchObject({ plan: { toDial: 1 } });
    expect(repos.attempt.countLiveByCampaignForAccount).not.toHaveBeenCalled();
    expect(repos.contact.countDialable).not.toHaveBeenCalled();
    expect(agencyCampaignSlotsSnapshot().has('camp-1')).toBe(false);
  });

  it('a forced tick is its own round\'s only participant, whatever else the account runs', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(5);
    repos.attempt.countLiveForAccount.mockResolvedValue(2);
    const r = twoCampaigns();
    await r.e.tickOnce('camp-1');
    expect(r.ticks.at(-1)).toMatchObject({ campaignId: 'camp-1', plan: { toDial: 2 } });
    expect(repos.attempt.countLiveByCampaignForAccount).not.toHaveBeenCalled();
  });

  it('a sibling that fails before reporting drops out at once: the other is not held for the wait', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(4);
    repos.attempt.countLiveForAccount.mockResolvedValue(2);
    // A wait no test would survive: the round must not need it.
    const r = twoCampaigns({ shareWaitMs: 60_000 });
    repos.session.findLiveForCampaign.mockImplementation(async (id: string) => {
      if (id === 'camp-2') throw new Error('connection reset');
      return [{ id: 's1' }, { id: 's2' }];
    });
    await r.e.runRound();
    expect(planOf(r, 'camp-1')!.plan!.toDial).toBe(2);
  });

  it('a sibling slower than the wait is left out; reporting late, it gets only the leftover (here none)', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(4);
    repos.attempt.countLiveForAccount.mockResolvedValue(2); // 2 slots
    const r = twoCampaigns({ shareWaitMs: 30 });
    const releaseSlow = holdCamp2Read();
    const done = r.e.runRound();
    await vi.waitFor(() => expect(planOf(r, 'camp-1')).toBeDefined());
    expect(planOf(r, 'camp-1')!.plan!.toDial).toBe(2);
    releaseSlow();
    await done;
    expect(planOf(r, 'camp-2')).toMatchObject({ quiescent: false, plan: { toDial: 0, idle: 'no_slots' } });
    expect(repos.contact.claimDialable.mock.calls.reduce((n, c) => n + (c[1] as number), 0)).toBe(2);
  });

  it('claims of two campaigns of one account never overlap (MC4)', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(10);
    const r = twoCampaigns();
    let releaseFirst!: (rows: unknown[]) => void;
    repos.contact.claimDialable
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValue([]);
    const done = r.e.runRound();
    await vi.waitFor(() => expect(repos.contact.claimDialable).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(repos.contact.claimDialable).toHaveBeenCalledTimes(1);
    releaseFirst([]);
    await done;
    expect(repos.contact.claimDialable).toHaveBeenCalledTimes(2);
    expect((r.e as any).claimLocks.size).toBe(0);
  });

  it('claims of campaigns on different accounts still run side by side', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(10);
    const r = twoCampaigns({ camp2: { ...CAMP2, account_id: 'a2' } });
    const releases: Array<(rows: unknown[]) => void> = [];
    repos.contact.claimDialable.mockImplementation(() => new Promise((resolve) => { releases.push(resolve); }));
    const done = r.e.runRound();
    await vi.waitFor(() => expect(repos.contact.claimDialable).toHaveBeenCalledTimes(2));
    for (const release of releases) release([]);
    await done;
  });

  it('giving up a campaign drops its slot series and, with the account\'s last campaign, its rotation', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(5);
    const r = twoCampaigns();
    await r.e.runRound();
    expect(agencyCampaignSlotsSnapshot().has('camp-1')).toBe(true);
    const rotation = (r.e as any).shareRotation;
    expect(rotation.size).toBe(1);
    await (r.e as any).relinquish('camp-1');
    expect(agencyCampaignSlotsSnapshot().has('camp-1')).toBe(false);
    expect(rotation.size).toBe(1); // camp-2 still on the account
    await (r.e as any).relinquish('camp-2');
    expect(rotation.size).toBe(0);
  });

  // ─── The pending-dial ledger (MC2) ───────────────────────────────────────

  it('a tick whose dials outlive its round holds its grant: a sibling ticking alone meanwhile is not granted it again', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(4);
    const live = insertsStayLive();
    claimsAll();
    const r = twoCampaigns({ agentsEach: 3 });
    // camp-1's carrier hangs on its first dial, so its tick outlives the round.
    const answer = hangCarrier(r);

    const first = r.e.runRound();
    await vi.waitFor(() => {
      expect(planOf(r, 'camp-2')).toBeDefined();
      expect(r.dispatch.mock.calls.some((c) => c[0].campaignId === 'camp-1')).toBe(true);
    });
    // 4 slots, 0 live, 3 agents each: 2 + 2. camp-2 inserted both; camp-1 one of its two.
    expect(planOf(r, 'camp-2')!.plan!.toDial).toBe(2);
    expect(live).toEqual({ 'camp-1': 1, 'camp-2': 2 });
    expect(ledger(r).get('t1:a1')).toBe(1); // camp-1's second dial: granted, not yet a row

    // The next round passes camp-1 by (still ticking); camp-2 ticks alone, uncontended,
    // with one agent free. 3 rows + 1 pending = the limit: nothing for camp-2.
    r.clock.t += 250;
    await r.e.runRound();
    expect(planOf(r, 'camp-2')).toMatchObject({ plan: { occupied: 4, toDial: 0, idle: 'no_slots' } });

    answer();
    await first;
    expect(live).toEqual({ 'camp-1': 2, 'camp-2': 2 }); // never above the limit of 4
    expect(ledger(r).size).toBe(0);
  });

  it('a hold with no progress for PACING_DIAL_HOLD_MAX_MS stops counting (a tick hung in the carrier); its end still releases it', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(4);
    const live = insertsStayLive();
    claimsAll();
    const r = twoCampaigns({ agentsEach: 3 });
    const answer = hangCarrier(r);

    const first = r.e.runRound(); // 2 + 2; camp-1 hangs after its first insert, holding 1
    await vi.waitFor(() => {
      expect(planOf(r, 'camp-2')).toBeDefined();
      expect(r.dispatch.mock.calls.some((c) => c[0].campaignId === 'camp-1')).toBe(true);
    });
    expect(ledger(r).get('t1:a1')).toBe(1);

    r.clock.t += 250; // fresh: counted, so camp-2 (one agent free) gets nothing
    await r.e.runRound();
    expect(planOf(r, 'camp-2')).toMatchObject({ plan: { occupied: 4, toDial: 0 } });

    r.clock.t += PACING_DIAL_HOLD_MAX_MS; // no progress since the insert: stale, left out
    await r.e.runRound();
    expect(planOf(r, 'camp-2')).toMatchObject({ plan: { occupied: 3, toDial: 1 } });
    const [hold] = [...(r.e as any).pendingDials.get('t1:a1')];
    expect(hold).toMatchObject({ remaining: 1, staleWarned: true }); // warned once, still held

    answer(); // the hung tick ends after all: its own `finally` releases what is left
    await first;
    expect(ledger(r).size).toBe(0);
    // 2 + 3 live on a limit of 4: the price of the bound when the hung tick does recover,
    // which the account concurrency guard refuses in production.
    expect(live).toEqual({ 'camp-1': 2, 'camp-2': 3 });
  });

  it('a campaign alone on its account sees an empty ledger: its reads and to_dial are the single-campaign law', async () => {
    const r = track(rig({ stations: makeStations({ s1: 'camp-1', s2: 'camp-1' }), agents: makeAgents({ s1: 'available', s2: 'available' }) }));
    repos.attempt.countLiveForAccount.mockResolvedValue(3);
    claimsAll();
    lead(r.e);
    await r.e.runRound();
    expect(r.ticks.at(-1)).toMatchObject({ plan: { accountLimit: 5, occupied: 3, toDial: 2 } });
    expect(ledger(r).size).toBe(0);
  });

  it('the ledger is released when a tick throws mid-dial', async () => {
    const r = track(rig({ stations: makeStations({ s1: 'camp-1', s2: 'camp-1' }), agents: makeAgents({ s1: 'available', s2: 'available' }) }));
    claimsAll();
    let atThrow: number | undefined;
    repos.attempt.create
      .mockImplementationOnce(async (p: any) => ({ id: `att-${p.contactId}`, caller_id: p.callerId, attempt_number: 1 }))
      .mockImplementationOnce(async () => {
        atThrow = ledger(r).get('t1:a1');
        throw new Error('connection reset');
      });
    lead(r.e);
    await r.e.runRound(); // the round logs the tick's failure
    expect(repos.attempt.create).toHaveBeenCalledTimes(2);
    expect(atThrow).toBe(1); // granted 2, one inserted
    expect(ledger(r).size).toBe(0);
  });

  it('a pair the gates suppress gives its slot back: at the next pair, and at the latest when the tick ends', async () => {
    const states: Record<string, string> = { s1: 'available', s2: 'available' };
    const r = track(rig({ stations: makeStations({ s1: 'camp-1', s2: 'camp-1' }), agents: makeAgents(states) }));
    // Not a number: suppressed by the first gate, no attempt row.
    const bad = { ...contact('bad'), phone_e164: 'not-a-number' };
    repos.contact.claimDialable.mockResolvedValue([bad, contact('good')]);
    let whileSuppressing: number | undefined;
    repos.contact.markState.mockImplementation(async () => { whileSuppressing = ledger(r).get('t1:a1'); return null; });
    let whileDialling: number | undefined = -1;
    r.dispatch.mockImplementation(async () => { whileDialling = ledger(r).get('t1:a1'); });
    lead(r.e);
    await r.e.runRound();
    expect(repos.contact.markState).toHaveBeenCalledWith('bad', 'suppressed', expect.anything());
    expect(whileSuppressing).toBe(2); // both slots still held while the first pair is handled
    expect(whileDialling).toBeUndefined(); // suppressed slot released, dialled slot is a row
    expect(ledger(r).size).toBe(0);

    // Suppressed LAST: its slot is held until the tick ends, then released.
    repos.contact.claimDialable.mockResolvedValue([contact('good2'), { ...bad, id: 'bad2' }]);
    states.s1 = 'available';
    states.s2 = 'available';
    r.clock.t += 250;
    await r.e.runRound();
    expect(whileSuppressing).toBe(1);
    expect(ledger(r).size).toBe(0);
  });

  // ─── One open split per account (MC2) ─────────────────────────────────────

  const camp1Reads = () => repos.session.findLiveForCampaign.mock.calls.filter((c) => c[0] === 'camp-1').length;
  /** The engine's open splits: its entries whose split is still open (a closed one is pruned next round). */
  const openSplits = (r: Rig) => new Map([...((r.e as any).openSplits as Map<string, { round: { isOpen(k: string): boolean } }>)]
    .filter(([k, o]) => o.round.isOpen(k)));

  it('a sibling slower than the wait: the split runs without it but stays open, so it gets the leftover, into the ledger', async () => {
    const r = twoCampaigns({ shareWaitMs: 30 }); // limit 5, nothing live: 5 slots
    claimsAll(); // every grant is claimed in full, so no claim-shortfall cap is set
    const release = holdCamp2Read();
    let heldAtDial: number | undefined;
    r.dispatch.mockImplementation(async (cmd: any) => {
      if (cmd.campaignId === 'camp-2' && heldAtDial === undefined) heldAtDial = ledger(r).get('t1:a1');
    });
    const done = r.e.runRound();
    await vi.waitFor(() => expect(planOf(r, 'camp-1')).toBeDefined());
    expect(planOf(r, 'camp-1')!.plan!.toDial).toBe(2); // split without camp-2 once the wait ran out
    expect(openSplits(r).has('t1:a1')).toBe(true); // camp-2 still pending: open

    // A round meanwhile starts nothing on the account: camp-2 is ticking, camp-1 is held back.
    r.freeAll();
    r.clock.t += 250;
    const before = r.ticks.length;
    await r.e.runRound();
    expect(r.ticks.length).toBe(before);

    release();
    await done;
    // Late while open: MIN(2, 5 − 2). Its grant went into the ledger like any other.
    expect(planOf(r, 'camp-2')).toMatchObject({ plan: { toDial: 2 } });
    expect(heldAtDial).toBe(1); // at its first dispatch: that dial is a row, its second still pending
    expect(openSplits(r).size).toBe(0);
    expect(ledger(r).size).toBe(0);
    expect((r.e as any).demandCap.size).toBe(0);

    r.freeAll();
    r.clock.t += 250;
    await r.e.runRound();
    expect([planOf(r, 'camp-1')!.plan!.toDial, planOf(r, 'camp-2')!.plan!.toDial]).toEqual([2, 2]);
  });

  it('while an account\'s split is open, the next round starts none of its campaigns; the first round after it closes does', async () => {
    const r = twoCampaigns();
    await (r.e as any).relinquish('camp-1');
    const release = holdCamp2Read();
    const first = r.e.runRound(); // camp-2 alone, its split open until it reports
    await vi.waitFor(() => expect(repos.session.findLiveForCampaign).toHaveBeenCalledWith('camp-2'));
    expect(openSplits(r).has('t1:a1')).toBe(true);

    lead(r.e); // camp-1 of the same account, due its first tick
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.filter((t) => t.campaignId === 'camp-1')).toEqual([]); // neither ticked nor skipped
    expect(camp1Reads()).toBe(0);

    release(); // camp-2 reports, alone: its split settles and closes at once
    await first;
    expect(openSplits(r).size).toBe(0);
    r.clock.t += 250;
    await r.e.runRound();
    expect(planOf(r, 'camp-1')).toMatchObject({ mode: 'full', cause: 'first' });
  });

  it('a round whose every participant withdraws closes the split, and the account is not held', async () => {
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents({ s1: 'available' }) }));
    repos.session.findLiveForCampaign.mockRejectedValueOnce(new Error('connection reset'));
    lead(r.e);
    await r.e.runRound(); // the tick throws before reporting: withdrawn in `finally`
    expect(openSplits(r).size).toBe(0);
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.filter((t) => t.mode === 'full')).toHaveLength(2);
  });

  it('a split nobody reports to is closed after the deadline; its stuck member then reports late', async () => {
    const r = twoCampaigns();
    await (r.e as any).relinquish('camp-1');
    const release = holdCamp2Read();
    const first = r.e.runRound();
    await vi.waitFor(() => expect(repos.session.findLiveForCampaign).toHaveBeenCalledWith('camp-2'));
    lead(r.e);
    r.clock.t += 4_999;
    await r.e.runRound();
    expect(camp1Reads()).toBe(0); // still within the deadline

    r.clock.t += 1; // 5 s (PACING_SPLIT_DEADLINE_MS) after it opened
    await r.e.runRound();
    expect(planOf(r, 'camp-1')).toMatchObject({ mode: 'full', cause: 'first', plan: { toDial: 2 } });

    release();
    await first;
    expect(planOf(r, 'camp-2')).toMatchObject({ quiescent: false, plan: { toDial: 0, idle: 'no_slots' } });
    expect(openSplits(r).size).toBe(0);
  });

  // ─── The claim-shortfall cap (MC5) ────────────────────────────────────────

  it('a contended campaign that claims nothing gets at most one slot next round; the cap lifts once it fills its grant', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(4);
    let starve = true;
    let seq = 0;
    repos.contact.claimDialable.mockImplementation(async (id: string, limit: number) =>
      (id === 'camp-1' && starve ? [] : Array.from({ length: limit }, () => contact(`${id}-c${seq++}`))));
    const r = twoCampaigns({ agentsEach: 4 });
    const grants = () => [planOf(r, 'camp-1')!.plan!.toDial, planOf(r, 'camp-2')!.plan!.toDial];
    const caps = () => (r.e as any).demandCap as Map<string, number>;

    // Round 1: 4 slots, both want 4: 2 + 2. camp-1's claim finds nothing (a number busy on
    // the other campaign, say): capped at MAX(1, 0).
    await r.e.runRound();
    expect(grants()).toEqual([2, 2]);
    expect(caps().get('camp-1')).toBe(1);
    expect(caps().has('camp-2')).toBe(false);

    // Round 2: camp-1 states a demand of 1 (its due-contact read too), camp-2 gets the rest.
    r.freeAll();
    r.clock.t += 250;
    repos.contact.countDialable.mockClear();
    await r.e.runRound();
    expect(repos.contact.countDialable).toHaveBeenCalledWith('camp-1', 1);
    expect(grants()).toEqual([1, 3]);
    expect(caps().get('camp-1')).toBe(1); // still nothing claimed

    // Round 3: its contacts are claimable again; it fills its grant of 1 and the cap lifts.
    starve = false;
    r.freeAll();
    r.clock.t += 250;
    await r.e.runRound();
    expect(grants()).toEqual([1, 3]);
    expect(caps().has('camp-1')).toBe(false);

    // Round 4: back to an even split.
    r.freeAll();
    r.clock.t += 250;
    await r.e.runRound();
    expect(grants()).toEqual([2, 2]);
  });

  it('the cap is cleared on an uncontended tick and when the campaign is given up', async () => {
    const r = twoCampaigns();
    const caps = () => (r.e as any).demandCap as Map<string, number>;
    caps().set('camp-1', 1);
    caps().set('camp-2', 1);
    await r.e.tickOnce('camp-1'); // a forced tick is alone in its round: uncontended
    expect(caps().has('camp-1')).toBe(false);
    await (r.e as any).relinquish('camp-2');
    expect(caps().has('camp-2')).toBe(false);
  });

  // ─── Who joins a round's split ────────────────────────────────────────────

  it('a paused sibling woken by account_capacity_freed leaves the running campaign uncontended', async () => {
    const paused = { ...CAMP2, status: 'paused' };
    const r = twoCampaigns({ camp2: paused });
    await r.e.runRound(); // camp-2's first tick finds it paused
    r.freeAll();
    resetAgencyCampaignSlots();
    const before = {
      dialable: repos.contact.countDialable.mock.calls.length,
      byCampaign: repos.attempt.countLiveByCampaignForAccount.mock.calls.length,
    };
    // Its row is read again, slowly: were it a CONTENDING participant, camp-1 would find the
    // account contended. It joins as not contending: waited for, not counted.
    (r.e as any).campaignCache.invalidate('camp-2');
    repos.campaign.findById.mockImplementation(async (id: string) => {
      if (id !== 'camp-2') return CAMPAIGN;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return paused;
    });
    r.bus.publish({ type: 'account_capacity_freed', tenantId: 't1', accountId: 'a1' });
    r.clock.t += 250;
    await r.e.runRound();

    expect(planOf(r, 'camp-2')).toMatchObject({ mode: 'full', cause: 'event' });
    expect(planOf(r, 'camp-1')).toMatchObject({ plan: { toDial: 2 } });
    expect(repos.contact.countDialable.mock.calls.length).toBe(before.dialable);
    expect(repos.attempt.countLiveByCampaignForAccount.mock.calls.length).toBe(before.byCampaign);
    expect(agencyCampaignSlotsSnapshot().size).toBe(0);
  });

  it('slot series stop when a campaign of a contended account next ticks with no agents (MC7)', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(5);
    claimsAll();
    const r = twoCampaigns();
    await r.e.runRound();
    expect(agencyCampaignSlotsSnapshot().has('camp-1')).toBe(true);
    // Every agent is now on a call (dispatched, never handed back): `no_agents` for both.
    r.clock.t += 250;
    await r.e.runRound();
    expect(planOf(r, 'camp-1')).toMatchObject({ plan: { toDial: 0, idle: 'no_agents' } });
    expect(agencyCampaignSlotsSnapshot().size).toBe(0);
  });
});

describe('PacingEngine rounds: supervise pass primes the row cache', () => {
  it('a row the pass reads replaces the cached one, and a changed row wakes the campaign', async () => {
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents({ s1: 'on_call' }) }));
    lead(r.e);
    await r.e.runRound();
    expect(repos.campaign.findById).toHaveBeenCalledTimes(1);

    // Unchanged row from the pass: no wake.
    repos.campaign.findActive.mockResolvedValue([CAMPAIGN]);
    await (r.e as any).superviseOnce();
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.at(-1)).toMatchObject({ mode: 'skipped' });

    // Changed behind our back (raw SQL): the pass sees a new updated_at and wakes it;
    // the woken tick uses the primed row and reads no row itself.
    const edited = { ...CAMPAIGN, caller_ids: [], updated_at: new Date('2026-11-02T00:00:00Z') };
    repos.campaign.findActive.mockResolvedValue([edited]);
    await (r.e as any).superviseOnce();
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.at(-1)).toMatchObject({ mode: 'full', cause: 'event' });
    expect(repos.campaign.findById).toHaveBeenCalledTimes(1);
  });
});

// ─── Inbound callers first (docs/inbound.md §5.2, IQ2) ───────────────────────

describe('PacingEngine rounds: inbound_waiting holds agents back for waiting inbound callers', () => {
  const waiting = (over: Partial<Extract<PacingInvalidationEvent, { type: 'inbound_waiting' }>> = {}): PacingInvalidationEvent => ({
    type: 'inbound_waiting', tenantId: 't1', accountId: 'a1', n: 1, preferredSessionIds: [], poolCampaignIds: null, ttlMs: 5_000, ...over,
  });
  const reservedIds = (agents: ReturnType<typeof makeAgents>) => agents.reserve.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    repos.contact.claimDialable.mockImplementation(async (_id: string, limit: number) =>
      Array.from({ length: limit }, (_, i) => contact(`c${i}`)));
  });

  it('holds back the n longest-idle candidates (s1 before s2 by the session-id tie-break)', async () => {
    const agents = makeAgents({ s1: 'available', s2: 'available' });
    const r = track(rig({ stations: makeStations({ s1: 'camp-1', s2: 'camp-1' }), agents }));
    lead(r.e);
    r.bus.publish(waiting({ n: 1 }));
    await r.e.runRound();
    expect(reservedIds(agents)).toEqual(['s2']);
  });

  it('drops the sessions a waiting caller is sticky to, then n of the rest', async () => {
    const agents = makeAgents({ s1: 'available', s2: 'available', s3: 'available' });
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    const r = track(rig({ stations: makeStations({ s1: 'camp-1', s2: 'camp-1', s3: 'camp-1' }), agents }));
    lead(r.e);
    r.bus.publish(waiting({ n: 1, preferredSessionIds: ['s3'] }));
    await r.e.runRound();
    expect(reservedIds(agents)).toEqual(['s2']);
  });

  it('a station that cannot take inbound calls (an older app build) is never held back, preferred or not: the one held is one that can take the caller (IQ46)', async () => {
    const agents = makeAgents({ s1: 'available', s2: 'available', s3: 'available' });
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    // s1 is the longest idle and s3 is a sticky caller's agent, both on an older build.
    const r = track(rig({ stations: makeStations({ s1: 'camp-1', s2: 'camp-1', s3: 'camp-1' }, ['s1', 's3']), agents }));
    lead(r.e);
    r.bus.publish(waiting({ n: 1, preferredSessionIds: ['s3'] }));
    await r.e.runRound();
    expect(reservedIds(agents).sort()).toEqual(['s1', 's3']);
  });

  it('a station whose capability is not known here (no `canTakeInbound`: the media workers` directory) is never held back', async () => {
    const agents = makeAgents({ s1: 'available' });
    const stations = makeStations({ s1: 'camp-1' });
    stations.get.mockImplementation((id: string) => (id === 's1' ? { sessionId: id, campaignId: 'camp-1' } : undefined) as never);
    const r = track(rig({ stations, agents }));
    lead(r.e);
    r.bus.publish(waiting({ n: 1 }));
    await r.e.runRound();
    expect(reservedIds(agents)).toEqual(['s1']);
  });

  it('only on the campaigns of the routes` pools; another account`s callers hold nothing here', async () => {
    const agents = makeAgents({ s1: 'available', s2: 'available' });
    const r = track(rig({ stations: makeStations({ s1: 'camp-1', s2: 'camp-1' }), agents }));
    lead(r.e);
    r.bus.publish(waiting({ n: 2, poolCampaignIds: ['camp-other'] }));
    r.bus.publish(waiting({ n: 2, accountId: 'a-other' }));
    await r.e.runRound();
    expect(reservedIds(agents).sort()).toEqual(['s1', 's2']);
  });

  it('n = 0 lifts it and wakes the campaign at once; a hold nobody republishes lapses after its TTL', async () => {
    const states: Record<string, string> = { s1: 'available', s2: 'available' };
    const agents = makeAgents(states);
    const r = track(rig({ stations: makeStations({ s1: 'camp-1', s2: 'camp-1' }), agents }));
    lead(r.e);
    r.bus.publish(waiting({ n: 2 }));
    await r.e.runRound();
    expect(agents.reserve).not.toHaveBeenCalled();
    expect(r.ticks.at(-1)).toMatchObject({ mode: 'full', quiescent: true });
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.at(-1)).toMatchObject({ mode: 'skipped' }); // quiescent: nothing reads until a change
    // The callers were taken: n = 0 wakes the campaign on the very next round.
    r.bus.publish(waiting({ n: 0 }));
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.at(-1)).toMatchObject({ mode: 'full', cause: 'event' });
    expect(reservedIds(agents).sort()).toEqual(['s1', 's2']);

    states.s1 = 'available';
    states.s2 = 'available';
    agents.reserve.mockClear();
    r.bus.publish(waiting({ n: 2, ttlMs: 1_000 }));
    r.clock.t += 1_000;
    await r.e.runRound();
    expect(reservedIds(agents).sort()).toEqual(['s1', 's2']);
  });

  it('the same hold republished wakes nothing', async () => {
    const r = track(rig({ stations: makeStations({ s1: 'camp-1' }), agents: makeAgents({ s1: 'on_call' }) }));
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    lead(r.e);
    r.bus.publish(waiting({ n: 1, preferredSessionIds: ['s1'] }));
    await r.e.runRound();
    r.bus.publish(waiting({ n: 1, preferredSessionIds: ['s1'] }));
    r.clock.t += 250;
    await r.e.runRound();
    expect(r.ticks.map((t) => t.mode)).toEqual(['full', 'skipped']);
  });
});
