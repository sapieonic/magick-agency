import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// The scheduled path of the pacing engine: rounds, the skip of a quiescent
// campaign, the invalidation bus that wakes it, the safety tick that bounds a lost
// event, the cross-round caches of the campaign row and the account limit, and
// the per-account budget a round shares. `pacing-engine.test.ts` is the tick's
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
      unclaim: vi.fn().mockResolvedValue(undefined),
      unclaimMany: vi.fn().mockResolvedValue(undefined),
    },
    attempt: {
      countLive: vi.fn().mockResolvedValue(0),
      countLiveForAccount: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      setState: vi.fn().mockResolvedValue(null),
    },
    session: {
      findLiveForCampaign: vi.fn().mockResolvedValue([]),
      setState: vi.fn().mockResolvedValue(null),
    },
  },
  settings: { getMaxConcurrentCalls: vi.fn().mockResolvedValue(5) },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAttemptRepository: repos.attempt,
  agencyAgentSessionRepository: repos.session,
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

import { PacingEngine, PACING_SAFETY_TICK_MS, type PacingTickObservation } from '../../../src/agency/pacing-engine.js';
import {
  InProcessPacingInvalidationBus,
  parsePacingInvalidationEvent,
  type PacingInvalidationEvent,
} from '../../../src/agency/pacing/invalidation-bus.js';
import { GenerationTtlCache } from '../../../src/agency/pacing/read-cache.js';
import { PacingRound } from '../../../src/agency/pacing/round.js';
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

function makeStations(owned: Record<string, string>) {
  return {
    isLocallyOwned: vi.fn((id: string) => id in owned),
    ownerOf: vi.fn(async (id: string) => (id in owned ? 'r1' : null)),
    broadcast: vi.fn(() => 0),
    sessionIdsForCampaign: vi.fn(() => Object.keys(owned)),
    get: vi.fn((id: string) => (id in owned ? { sessionId: id, campaignId: owned[id] } : undefined)),
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
}): Rig {
  const bus = opts.bus ?? new InProcessPacingInvalidationBus();
  const clock = opts.clock ?? { t: 1_000_000 };
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const e = new PacingEngine(
    null, '', 'r1', opts.stations, opts.agents, { dispatch } as any, { check: vi.fn().mockResolvedValue('clear') } as any,
    { bus, now: () => clock.t, ...(opts.cacheTtlMs ? { cacheTtlMs: opts.cacheTtlMs } : {}) },
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
    repos.contact.claimDialable,
  ].reduce((n, f) => n + f.mock.calls.length, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  repos.campaign.findById.mockResolvedValue(CAMPAIGN);
  repos.campaign.countOutstanding.mockResolvedValue(1);
  repos.contact.claimDialable.mockResolvedValue([]);
  repos.attempt.countLiveForAccount.mockResolvedValue(0);
  repos.attempt.create.mockImplementation(async (p: any) => ({
    id: `att-${p.contactId}`, caller_id: p.callerId, attempt_number: 1,
  }));
  settings.getMaxConcurrentCalls.mockResolvedValue(5);
  repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
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
    ];
    for (const e of events) expect(parsePacingInvalidationEvent(JSON.parse(JSON.stringify(e)))).toEqual(e);
    for (const bad of [null, 'x', {}, { type: 'nope' }, { type: 'campaign_changed' },
      { type: 'account_limit_changed', tenantId: 't' }, { type: 'agent_available', sessionId: 's', campaignId: 7 },
      { type: 'station_ready', sessionId: 's', campaignId: null }, { type: 'station_ready', campaignId: 'c1' }]) {
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

  it('`fresh` reads through and still stores', async () => {
    const c = new GenerationTtlCache<number>(10_000);
    await c.getOrLoad('k', async () => 1);
    expect(await c.getOrLoad('k', async () => 2)).toBe(1);
    expect(await c.getOrLoad('k', async () => 3, { fresh: true })).toBe(3);
    expect(c.get('k')).toBe(3);
  });
});

// ─── The round's shared account budget ──────────────────────────────────────

describe('PacingRound', () => {
  it('two campaigns of one account share one live-call read and one headroom budget', async () => {
    const round = new PacingRound(false);
    const load = vi.fn().mockResolvedValue(3);
    const [a, b] = await Promise.all([round.liveCalls('t:a', load), round.liveCalls('t:a', load)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect([a, b]).toEqual([3, 3]);
    // limit 10, 3 live: 7 slots between them, whatever each has idle.
    expect(round.takeHeadroom('t:a', 10, 3, 5)).toBe(5);
    expect(round.takeHeadroom('t:a', 10, 3, 5)).toBe(2);
    expect(round.takeHeadroom('t:a', 10, 3, 5)).toBe(0);
    // Another account is untouched.
    expect(round.takeHeadroom('t:b', 10, 3, 5)).toBe(5);
  });

  it('with one campaign it is exactly MAX(0, MIN(limit − live, idle))', () => {
    for (const [limit, live, idle] of [[5, 0, 2], [5, 5, 3], [5, 7, 3], [2, 0, 9], [0, 0, 1]] as const) {
      expect(new PacingRound(false).takeHeadroom('k', limit, live, idle)).toBe(Math.max(0, Math.min(limit - live, idle)));
    }
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

describe('PacingEngine rounds: per-account sharing', () => {
  it('two campaigns of one account in one round read live calls ONCE and never plan past the limit together', async () => {
    const CAMP2 = { ...CAMPAIGN, id: 'camp-2' };
    repos.campaign.findById.mockImplementation(async (id: string) => (id === 'camp-2' ? CAMP2 : CAMPAIGN));
    repos.session.findLiveForCampaign.mockImplementation(async (id: string) =>
      id === 'camp-2' ? [{ id: 's3' }, { id: 's4' }] : [{ id: 's1' }, { id: 's2' }]);
    settings.getMaxConcurrentCalls.mockResolvedValue(5);
    repos.attempt.countLiveForAccount.mockResolvedValue(2); // 3 slots left on the account
    const r = track(rig({
      stations: makeStations({ s1: 'camp-1', s2: 'camp-1', s3: 'camp-2', s4: 'camp-2' }),
      agents: makeAgents({ s1: 'available', s2: 'available', s3: 'available', s4: 'available' }),
    }));
    lead(r.e);
    lead(r.e, CAMP2);
    await r.e.runRound();

    expect(repos.attempt.countLiveForAccount).toHaveBeenCalledTimes(1);
    expect(settings.getMaxConcurrentCalls).toHaveBeenCalledTimes(1);
    const planned = r.ticks.map((t) => (t.mode === 'full' ? t.plan!.toDial : 0));
    // 4 idle agents, 3 slots: 2 + 1 (in some order), never 2 + 2.
    expect(planned.reduce((a, b) => a + b, 0)).toBe(3);
    expect(repos.contact.claimDialable.mock.calls.reduce((n, c) => n + (c[1] as number), 0)).toBe(3);
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
