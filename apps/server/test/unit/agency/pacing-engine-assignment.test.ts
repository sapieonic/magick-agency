import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Contact assignment in the tick (CA1, CA3): on a `strict` or `preferred` campaign an agent
// with nothing due is not reserved, every reserved agent is paired with the contact claimed
// FOR them (never by position), and each available agent hears their `queue` frame when it
// changes. `pool` mode is the tick as it was: `claimDialable` with N, no probe, no frame.
//
// The SQL of the per-agent claim and of the queue probe is proven on real Postgres
// (`test/integration/agency/agency-contact-claim-owner.test.ts`,
// `agency-agent-queue.test.ts`); this file is the tick's use of them.
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
      claimForAgents: vi.fn().mockResolvedValue([]),
      probeAgentQueues: vi.fn(),
      unclaim: vi.fn().mockResolvedValue(undefined),
      unclaimMany: vi.fn().mockResolvedValue(undefined),
      markState: vi.fn().mockResolvedValue(undefined),
    },
    attempt: {
      countLive: vi.fn().mockResolvedValue(0),
      countLiveForAccount: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      setState: vi.fn().mockResolvedValue(null),
    },
    session: { findLiveForCampaign: vi.fn().mockResolvedValue([]), setState: vi.fn().mockResolvedValue(null) },
  },
  settings: { getMaxConcurrentCalls: vi.fn().mockResolvedValue(10) },
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
const { fallback } = vi.hoisted(() => ({
  fallback: { sweep: vi.fn().mockResolvedValue(0), unstaffed: vi.fn().mockResolvedValue(0) },
}));
vi.mock('../../../src/agency/pacing/callback-fallback.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/agency/pacing/callback-fallback.js')>()),
  CALLBACK_FALLBACK_SWEEP_MS: 30_000,
  sweepCallbackFallback: fallback.sweep,
  sweepUnstaffedOwners: fallback.unstaffed,
}));

import { PacingEngine, type PacingTickObservation } from '../../../src/agency/pacing-engine.js';
import {
  getPacingInvalidationBus,
  InProcessPacingInvalidationBus,
  type PacingInvalidationEvent,
} from '../../../src/agency/pacing/invalidation-bus.js';

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3', tenant_id: 't1', account_id: 'a1',
  status: 'running', caller_ids: ['+14155550100'],
  calling_window_start: '00:00:00', calling_window_end: '24:00:00',
  calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
  pause_reason: null, paused_at: null, pause_abandonment_rate_pct: null, abandonment_ceiling_pct: 3,
  disposition_catalog: [{ code: 'callback', label: 'Call back', requires_datetime: true }],
  assignment_mode: 'strict', callback_fallback: 'pool', callback_owner_grace_minutes: 30,
} as any;

/** Three agents, s1 longest idle; each session's agent is `u<n>`. */
const SESSIONS = [
  { id: 's1', agent_user_id: 'u1' },
  { id: 's2', agent_user_id: 'u2' },
  { id: 's3', agent_user_id: 'u3' },
];

function contact(id: string, owner: string | null) {
  return { id, phone_e164: '+919876543210', context: {}, attempt_count: 0, assigned_user_id: owner } as any;
}

function makeAgents(states: Record<string, string>) {
  const order = ['s1', 's2', 's3'];
  const get = vi.fn(async (id: string) => (
    states[id] ? { state: states[id], attemptId: null, since: 1_000 + order.indexOf(id) } : null));
  return {
    get,
    getMany: vi.fn(async (ids: readonly string[]) => Promise.all(ids.map((id) => get(id)))),
    reserve: vi.fn(async (id: string) => (states[id] === 'available' ? 'reserved' : 'lost')),
    set: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStations(owned: string[], send = vi.fn((_id: string, _frame: unknown) => true)) {
  return {
    isLocallyOwned: vi.fn((id: string) => owned.includes(id)),
    ownerOf: vi.fn(async (id: string) => (owned.includes(id) ? 'r1' : null)),
    broadcast: vi.fn(() => owned.length),
    send,
  };
}

/** A probe answer: `due` agents have an own contact due; the rest have one in an hour. */
const LATER = new Date(Date.now() + 3_600_000);
function probe(due: string[], opts: { all?: string[]; pool?: { dueCount: number } | null; callbacksOnly?: string[] } = {}) {
  const later = LATER;
  return {
    agents: (opts.all ?? ['u1', 'u2', 'u3']).map((u) => ({
      agentUserId: u,
      ownDue: due.includes(u),
      ownNextAt: due.includes(u) ? new Date(Date.now() - 1_000) : later,
      ownHasNonCallback: due.includes(u) ? null : !(opts.callbacksOnly ?? []).includes(u),
    })),
    pool: opts.pool === undefined ? null : opts.pool && { dueCount: opts.pool.dueCount, nextAt: null, hasNonCallback: null },
  };
}

function engine(stations: any, agents: any, dispatch = vi.fn().mockResolvedValue(undefined), now?: () => number) {
  const e = new PacingEngine(
    null, '', 'r1', stations, agents, { dispatch } as any, { check: vi.fn().mockResolvedValue('clear') } as any,
    now ? { now } : {},
  );
  const ticks: PacingTickObservation[] = [];
  e.registerTickObserver((o) => ticks.push(o));
  return { e, dispatch, ticks };
}

beforeEach(() => {
  vi.clearAllMocks();
  repos.campaign.findById.mockResolvedValue(CAMPAIGN);
  repos.campaign.countOutstanding.mockResolvedValue(1);
  repos.session.findLiveForCampaign.mockResolvedValue(SESSIONS);
  repos.contact.claimDialable.mockResolvedValue([]);
  repos.contact.claimForAgents.mockResolvedValue([]);
  repos.attempt.create.mockImplementation(async (p: any) => ({ id: `att-${p.contactId}`, caller_id: p.callerId, attempt_number: 1 }));
  settings.getMaxConcurrentCalls.mockResolvedValue(10);
  fallback.sweep.mockResolvedValue(0);
  fallback.unstaffed.mockResolvedValue(0);
});

describe('strict / preferred: an agent with nothing due is not reserved (CA3)', () => {
  it('reserves only the agents with something due, in fairness order, and claims for them by user', async () => {
    repos.contact.probeAgentQueues.mockResolvedValue(probe(['u1', 'u3']));
    const agents = makeAgents({ s1: 'available', s2: 'available', s3: 'available' });
    const { e } = engine(makeStations(['s1', 's2', 's3']), agents);

    await e.tickOnce('camp-1');

    expect(repos.contact.probeAgentQueues).toHaveBeenCalledWith('camp-1', ['u1', 'u2', 'u3'], expect.objectContaining({
      callbackCodes: ['callback'],
    }));
    expect(agents.reserve.mock.calls.map((c) => c[0])).toEqual(['s1', 's3']);
    expect(repos.contact.claimForAgents).toHaveBeenCalledWith('camp-1', ['u1', 'u3'], 'strict');
    expect(repos.contact.claimDialable).not.toHaveBeenCalled();
  });

  it('nothing due for anyone: no reservation, no claim, idle `nothing_due`, and the tick is not quiescent', async () => {
    repos.contact.probeAgentQueues.mockResolvedValue(probe([]));
    const agents = makeAgents({ s1: 'available', s2: 'available', s3: 'available' });
    const { e, ticks } = engine(makeStations(['s1', 's2', 's3']), agents);

    await e.tickOnce('camp-1');

    expect(agents.reserve).not.toHaveBeenCalled();
    expect(repos.contact.claimForAgents).not.toHaveBeenCalled();
    const full = ticks.find((t) => t.mode === 'full') as Extract<PacingTickObservation, { mode: 'full' }>;
    expect(full.plan).toMatchObject({ toDial: 0, idle: 'nothing_due' });
    // Retries fall due with time, and nothing announces that: the campaign keeps ticking.
    expect(full.quiescent).toBe(false);
    // The probe saw open contacts (every reading has a `next_due_at`), so completion cannot be
    // due and the roster is not counted this tick.
    expect(repos.campaign.countOutstanding).not.toHaveBeenCalled();
    expect(repos.campaign.transitionStatus).not.toHaveBeenCalled();
  });

  it('nothing due and every queue empty: completion is evaluated on the idle tick', async () => {
    repos.contact.probeAgentQueues.mockResolvedValue({
      agents: ['u1', 'u2', 'u3'].map((u) => ({ agentUserId: u, ownDue: false, ownNextAt: null, ownHasNonCallback: null })),
      pool: null,
    });
    repos.campaign.countOutstanding.mockResolvedValueOnce(0);
    repos.campaign.transitionStatus.mockResolvedValueOnce(null);
    const { e, ticks } = engine(makeStations(['s1', 's2', 's3']), makeAgents({ s1: 'available', s2: 'available', s3: 'available' }));

    await e.tickOnce('camp-1');

    const full = ticks.find((t) => t.mode === 'full') as Extract<PacingTickObservation, { mode: 'full' }>;
    expect(full.plan).toMatchObject({ toDial: 0, idle: 'nothing_due' });
    expect(repos.campaign.countOutstanding).toHaveBeenCalledWith('camp-1');
    expect(repos.campaign.transitionStatus).toHaveBeenCalledWith('camp-1', ['running'], 'completed');
  });

  it('preferred: agents without own work are reserved only up to the due pool contacts', async () => {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, assignment_mode: 'preferred' });
    repos.contact.probeAgentQueues.mockResolvedValue(probe(['u3'], { pool: { dueCount: 1 } }));
    const agents = makeAgents({ s1: 'available', s2: 'available', s3: 'available' });
    const { e } = engine(makeStations(['s1', 's2', 's3']), agents);

    await e.tickOnce('camp-1');

    // u3 has own work; of u1 and u2, only the longest idle takes the one pool contact.
    expect(agents.reserve.mock.calls.map((c) => c[0])).toEqual(['s1', 's3']);
    expect(repos.contact.claimForAgents).toHaveBeenCalledWith('camp-1', ['u1', 'u3'], 'preferred');
    expect(repos.contact.probeAgentQueues).toHaveBeenCalledWith('camp-1', ['u1', 'u2', 'u3'], expect.objectContaining({
      pool: { dueCap: 3 },
    }));
  });
});

describe('strict / preferred: pairing is by agent, never by position (CA1)', () => {
  it("dials each contact to the agent it was claimed for, whatever order the claim returned", async () => {
    repos.contact.probeAgentQueues.mockResolvedValue(probe(['u1', 'u2']));
    // Returned in the opposite order to the reservation.
    repos.contact.claimForAgents.mockResolvedValue([
      { agentUserId: 'u2', contact: contact('c-of-u2', 'u2') },
      { agentUserId: 'u1', contact: contact('c-of-u1', 'u1') },
    ]);
    const { e, dispatch } = engine(makeStations(['s1', 's2']), makeAgents({ s1: 'available', s2: 'available' }));

    await e.tickOnce('camp-1');

    const dialed = dispatch.mock.calls.map((c: any[]) => [c[0].sessionId, c[0].contactId]);
    expect(dialed).toEqual([['s1', 'c-of-u1'], ['s2', 'c-of-u2']]);
    expect(repos.attempt.create.mock.calls.map((c: any[]) => [c[0].reservedAgentId, c[0].contactId]))
      .toEqual([['s1', 'c-of-u1'], ['s2', 'c-of-u2']]);
  });

  it('a reserved agent the claim gave nothing goes straight back to the pool', async () => {
    repos.contact.probeAgentQueues.mockResolvedValue(probe(['u1', 'u2']));
    repos.contact.claimForAgents.mockResolvedValue([{ agentUserId: 'u2', contact: contact('c-of-u2', 'u2') }]);
    const agents = makeAgents({ s1: 'available', s2: 'available' });
    const { e, dispatch } = engine(makeStations(['s1', 's2']), agents);

    await e.tickOnce('camp-1');

    expect(agents.set).toHaveBeenCalledWith('s1', 'available');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0].sessionId).toBe('s2');
  });

  it("never dials a contact to an agent who does not own it: a mis-paired row is returned undialled", async () => {
    repos.contact.probeAgentQueues.mockResolvedValue(probe(['u1', 'u2']));
    repos.contact.claimForAgents.mockResolvedValue([
      // Claimed "for u1" but owned by u2: a claim bug the tick must not act on.
      { agentUserId: 'u1', contact: contact('c-of-u2', 'u2') },
      // Strict mode: a pool contact is nobody's to dial.
      { agentUserId: 'u2', contact: contact('c-pool', null) },
    ]);
    const agents = makeAgents({ s1: 'available', s2: 'available' });
    const { e, dispatch } = engine(makeStations(['s1', 's2']), agents);

    await e.tickOnce('camp-1');

    expect(dispatch).not.toHaveBeenCalled();
    expect(repos.contact.unclaimMany).toHaveBeenCalledWith(['c-of-u2', 'c-pool'], expect.any(Date));
    expect(agents.set).toHaveBeenCalledWith('s1', 'available');
    expect(agents.set).toHaveBeenCalledWith('s2', 'available');
  });

  it('preferred: a pool contact is paired with the agent it was claimed for', async () => {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, assignment_mode: 'preferred' });
    repos.contact.probeAgentQueues.mockResolvedValue(probe([], { pool: { dueCount: 1 } }));
    repos.contact.claimForAgents.mockResolvedValue([{ agentUserId: 'u1', contact: contact('c-pool', null) }]);
    const { e, dispatch } = engine(makeStations(['s1', 's2']), makeAgents({ s1: 'available', s2: 'available' }));

    await e.tickOnce('camp-1');

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ sessionId: 's1', contactId: 'c-pool' });
  });

  it("a halted gate returns every pair it had not dialled, each agent with its own contact", async () => {
    repos.contact.probeAgentQueues.mockResolvedValue(probe(['u1', 'u2']));
    repos.contact.claimForAgents.mockResolvedValue([
      { agentUserId: 'u1', contact: contact('c-of-u1', 'u1') },
      { agentUserId: 'u2', contact: contact('c-of-u2', 'u2') },
    ]);
    const agents = makeAgents({ s1: 'available', s2: 'available' });
    const e = new PacingEngine(
      null, '', 'r1', makeStations(['s1', 's2']) as any, agents as any, { dispatch: vi.fn() } as any,
      { check: vi.fn().mockResolvedValue('unavailable') } as any,
    );

    await e.tickOnce('camp-1');

    expect(repos.contact.unclaimMany).toHaveBeenCalledWith(['c-of-u1', 'c-of-u2'], expect.any(Date));
    expect(agents.set.mock.calls.map((c) => c[0]).sort()).toEqual(['s1', 's2']);
  });
});

describe('the `queue` frame: sent to the agent only when it changes (CA3)', () => {
  function queueFrames(send: ReturnType<typeof vi.fn>) {
    return send.mock.calls.filter((c) => (c[1] as { event: string }).event === 'queue').map((c) => [c[0], c[1]]);
  }

  it('sends each available agent their state once, not again on an unchanged tick, and again on a change', async () => {
    const send = vi.fn((_id: string, _frame: unknown) => true);
    repos.contact.probeAgentQueues.mockResolvedValue(probe([], { all: ['u1', 'u2'], callbacksOnly: ['u2'] }));
    const { e } = engine(makeStations(['s1', 's2'], send), makeAgents({ s1: 'available', s2: 'available' }));

    await e.tickOnce('camp-1');
    const first = queueFrames(send);
    expect(first).toHaveLength(2);
    expect(first[0]).toEqual(['s1', expect.objectContaining({
      event: 'queue', campaign_id: 'camp-1', due: false, reason: 'waiting_for_retry',
    })]);
    expect(first[1]![1]).toMatchObject({ reason: 'callbacks_later' });

    // Unchanged: nothing more is sent.
    send.mockClear();
    await e.tickOnce('camp-1');
    expect(queueFrames(send)).toHaveLength(0);

    // u1's contact fell due: only u1 hears about it.
    repos.contact.probeAgentQueues.mockResolvedValue(probe(['u1'], { all: ['u1', 'u2'], callbacksOnly: ['u2'] }));
    send.mockClear();
    await e.tickOnce('camp-1');
    expect(queueFrames(send)).toEqual([['s1', { event: 'queue', campaign_id: 'camp-1', due: true, reason: null, next_due_at: null }]]);
  });

  it('retries a frame that reached no station, and forgets a session once it is no longer live', async () => {
    const send = vi.fn((_id: string, _frame: unknown) => false);
    repos.contact.probeAgentQueues.mockResolvedValue(probe([], { all: ['u1'] }));
    repos.session.findLiveForCampaign.mockResolvedValue([SESSIONS[0]]);
    const { e } = engine(makeStations(['s1'], send), makeAgents({ s1: 'available' }));

    await e.tickOnce('camp-1');
    await e.tickOnce('camp-1');
    expect(queueFrames(send)).toHaveLength(2);

    send.mockImplementation(() => true);
    await e.tickOnce('camp-1');
    await e.tickOnce('camp-1');
    expect(queueFrames(send)).toHaveLength(3);

    // The session left (no longer live), then the same id came back: told again.
    repos.session.findLiveForCampaign.mockResolvedValueOnce([]);
    await e.tickOnce('camp-1');
    await e.tickOnce('camp-1');
    expect(queueFrames(send)).toHaveLength(4);
  });

  // FALSIFIED: with every agent reading the pool's due count (the reading before this fix:
  // `queueStateFrom` without `poolDueTaken`), s2 and s3 are told `due: true` and this reds.
  it('preferred: only the agents a due pool contact goes to are told due, longest idle first', async () => {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, assignment_mode: 'preferred' });
    // One due pool contact, nothing of their own; the probe answers in its own order.
    repos.contact.probeAgentQueues.mockResolvedValue({
      agents: ['u3', 'u2', 'u1'].map((u) => ({ agentUserId: u, ownDue: false, ownNextAt: null, ownHasNonCallback: null })),
      pool: { dueCount: 1, nextAt: new Date(Date.now() - 5_000), hasNonCallback: null },
    });
    const send = vi.fn((_id: string, _frame: unknown) => true);
    const agents = makeAgents({ s1: 'available', s2: 'available', s3: 'available' });
    const { e } = engine(makeStations(['s1', 's2', 's3'], send), agents);

    await e.tickOnce('camp-1');

    // The frames say what the tick did: s1 (longest idle) is reserved for the pool contact,
    // s2 and s3 are not, and are not told they are due.
    expect(agents.reserve.mock.calls.map((c) => c[0])).toEqual(['s1']);
    const notDue = { event: 'queue', campaign_id: 'camp-1', due: false, reason: 'waiting_for_retry', next_due_at: null };
    expect(queueFrames(send)).toEqual([
      ['s1', { event: 'queue', campaign_id: 'camp-1', due: true, reason: null, next_due_at: null }],
      ['s2', notDue],
      ['s3', notDue],
    ]);
  });

  // A reconnect's `ready` carries a queue read before it is sent: a frame this engine sent in
  // between is overwritten on the station by the older reading, and a failed read sends none
  // (the clients then clear their queue). The attach publishes `station_ready` after `ready`.
  // FALSIFIED: with the engine's `station_ready` case not dropping the entry, the resend reds.
  it("sends an agent's queue again after their station was sent `ready` (station_ready), and only theirs", async () => {
    const send = vi.fn((_id: string, _frame: unknown) => true);
    repos.contact.probeAgentQueues.mockResolvedValue(probe([], { all: ['u1', 'u2'] }));
    const bus = new InProcessPacingInvalidationBus();
    const e = new PacingEngine(
      null, '', 'r1', makeStations(['s1', 's2'], send) as any, makeAgents({ s1: 'available', s2: 'available' }) as any,
      { dispatch: vi.fn() } as any, { check: vi.fn().mockResolvedValue('clear') } as any, { bus },
    );
    e.setAutoRounds(false);
    const ticks: PacingTickObservation[] = [];
    e.registerTickObserver((o) => ticks.push(o));
    (e as any).beginLeading(CAMPAIGN);
    try {
      await e.runRound();
      expect(queueFrames(send)).toHaveLength(2);
      send.mockClear();
      await e.tickOnce('camp-1');
      expect(queueFrames(send)).toHaveLength(0);

      // s1's station reconnected and was sent `ready`: the reading is unchanged, but s1 is told
      // again on the next tick, and s2 is not.
      bus.publish({ type: 'station_ready', sessionId: 's1', campaignId: 'camp-1' });
      ticks.length = 0;
      await e.runRound();
      expect(ticks[0]).toMatchObject({ mode: 'full', cause: 'event' });
      expect(queueFrames(send)).toEqual([['s1', expect.objectContaining({ event: 'queue', reason: 'waiting_for_retry' })]]);

      // Once told, unchanged again.
      send.mockClear();
      await e.tickOnce('camp-1');
      expect(queueFrames(send)).toHaveLength(0);
    } finally {
      await e.stop();
    }
  });

  it('pool mode: claimDialable with N, no probe and no queue frame (the tick as it was)', async () => {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, assignment_mode: 'pool' });
    const send = vi.fn((_id: string, _frame: unknown) => true);
    const agents = makeAgents({ s1: 'available', s2: 'available', s3: 'available' });
    const { e } = engine(makeStations(['s1', 's2', 's3'], send), agents);

    await e.tickOnce('camp-1');

    expect(repos.contact.claimDialable).toHaveBeenCalledWith('camp-1', 3);
    expect(repos.contact.probeAgentQueues).not.toHaveBeenCalled();
    expect(repos.contact.claimForAgents).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fallback.sweep).not.toHaveBeenCalled();
  });
});

describe('the callback grace/fallback sweep runs from the leader, throttled (CA5)', () => {
  it('sweeps an owner-mode campaign at most every 30 s, and wakes it when callbacks moved', async () => {
    const clock = { t: 5_000_000 };
    repos.contact.probeAgentQueues.mockResolvedValue(probe([]));
    const events: PacingInvalidationEvent[] = [];
    const unsubscribe = getPacingInvalidationBus().subscribe((ev) => { events.push(ev); });
    try {
      const { e } = engine(makeStations(['s1']), makeAgents({ s1: 'available' }), undefined, () => clock.t);

      await e.tickOnce('camp-1');
      await e.tickOnce('camp-1');
      expect(fallback.sweep).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]);

      clock.t += 30_000;
      fallback.sweep.mockResolvedValueOnce(2);
      await e.tickOnce('camp-1');
      expect(fallback.sweep).toHaveBeenCalledTimes(2);
      expect(events).toContainEqual({ type: 'contacts_changed', campaignId: 'camp-1' });
    } finally {
      unsubscribe();
    }
  });

  it('does not sweep `wait`, and a failing sweep costs the tick nothing', async () => {
    repos.contact.probeAgentQueues.mockResolvedValue(probe(['u1'], { all: ['u1'] }));
    repos.contact.claimForAgents.mockResolvedValue([{ agentUserId: 'u1', contact: contact('c1', 'u1') }]);
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, callback_fallback: 'wait' });
    const first = engine(makeStations(['s1']), makeAgents({ s1: 'available' }));
    await first.e.tickOnce('camp-1');
    expect(fallback.sweep).not.toHaveBeenCalled();

    repos.campaign.findById.mockResolvedValue(CAMPAIGN);
    fallback.sweep.mockRejectedValueOnce(new Error('db blip'));
    const second = engine(makeStations(['s1']), makeAgents({ s1: 'available' }));
    await second.e.tickOnce('camp-1');
    expect(fallback.sweep).toHaveBeenCalledTimes(1);
    expect(second.dispatch).toHaveBeenCalledTimes(1);
  });

  it('with on_unstaff return_to_pool the unstaffed-owner return runs too (CA6); one failing does not skip the other', async () => {
    repos.contact.probeAgentQueues.mockResolvedValue(probe([]));
    const events: PacingInvalidationEvent[] = [];
    const unsubscribe = getPacingInvalidationBus().subscribe((ev) => { events.push(ev); });
    try {
      repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, on_unstaff: 'keep' });
      await engine(makeStations(['s1']), makeAgents({ s1: 'available' })).e.tickOnce('camp-1');
      expect(fallback.unstaffed).not.toHaveBeenCalled();
      fallback.sweep.mockClear();

      repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, on_unstaff: 'return_to_pool', callback_fallback: 'wait' });
      fallback.unstaffed.mockResolvedValueOnce(3);
      await engine(makeStations(['s1']), makeAgents({ s1: 'available' })).e.tickOnce('camp-1');
      expect(fallback.unstaffed).toHaveBeenCalledTimes(1);
      expect(fallback.sweep).not.toHaveBeenCalled();
      expect(events).toContainEqual({ type: 'contacts_changed', campaignId: 'camp-1' });

      repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, on_unstaff: 'return_to_pool' });
      fallback.unstaffed.mockRejectedValueOnce(new Error('db blip'));
      await engine(makeStations(['s1']), makeAgents({ s1: 'available' })).e.tickOnce('camp-1');
      expect(fallback.unstaffed).toHaveBeenCalledTimes(2);
      expect(fallback.sweep).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
});
