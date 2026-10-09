// The DNC double is an untyped `{ check }` stub, so the scope argument is not asserted here
// (it is asserted in `pacing-engine-gates.test.ts`).
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The closed-loop controller.
//
//   idle     = agents in `available` on this campaign  (busy agents excluded)
//   occupied = ALL non-terminal attempts  (a bridged call still holds a slot)
//   to_dial  = MAX(0, MIN(account max_concurrent_calls - occupied, idle))   -- D9
//
// The two terms bound different quantities: the account limit caps total
// concurrency (so `occupied` counts against it), `idle` caps how many NEW dials
// can be placed. Subtracting `occupied` from an idle-derived target charges every
// busy agent twice — see 'a busy agent must not consume an idle one's slot'.
//
// `to_dial == 0` IS the paused state, and the same expression resumes it — there
// is no pause flag anywhere that can be left stale.
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
      countOutstanding: vi.fn().mockResolvedValue(0),
      transitionStatus: vi.fn(),
    },
    contact: { claimDialable: vi.fn().mockResolvedValue([]), unclaim: vi.fn().mockResolvedValue(undefined) },
    attempt: { countLive: vi.fn().mockResolvedValue(0), create: vi.fn(), setState: vi.fn().mockResolvedValue(null) },
    // `setState` mirrors the winning reservation durably — the
    // supervisor's agents-by-state breakdown cannot see `reserved` otherwise.
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

// The supervise pass re-reads `agency_dialer_enabled` per campaign, so leadership
// is now conditional on it. Mocked ON by default — every test below is about the
// tick, and the gate itself is asserted in its own describe.
const { flags } = vi.hoisted(() => ({
  flags: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean', default: false } },
}));

const { audit } = vi.hoisted(() => ({ audit: { log: vi.fn() } }));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: audit }));

import { PacingEngine } from '../../../src/agency/pacing-engine.js';

// The window is deliberately ALL DAY, EVERY DAY (the pre-dial
// calling-hours gate). These tests are about the tick's arithmetic, and a fixture
// carrying the column defaults — 09:00–20:00, Mon–Fri — would make every dialing
// assertion here depend on what time the suite happened to run and on what day of
// the week. `24:00:00` rather than `23:59:59` because the latter leaves a
// one-second hole at the end of every day.
const CAMPAIGN = {
  id: 'camp-1', name: 'Q3', tenant_id: 't1', account_id: 'a1',
  status: 'running', caller_ids: ['+14155550100', '+14155550101'],
  calling_window_start: '00:00:00', calling_window_end: '24:00:00',
  calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
  // Migration 089. A running campaign carries no pause metadata, and the fixture
  // has to say so: the tick now reads `pause_reason` to tell a supervisor pause
  // from the abandonment guardrail's, and an absent key would make every
  // `{...CAMPAIGN, status: 'paused'}` in this file an unattributed pause that no
  // writer in the codebase can actually produce.
  pause_reason: null, paused_at: null, pause_abandonment_rate_pct: null,
  abandonment_ceiling_pct: 3,
} as any;

function contact(id: string) {
  return { id, phone_e164: '+919876543210', context: {}, attempt_count: 0 } as any;
}

/** Agents whose Redis state the tick reads. */
function makeAgents(states: Record<string, string>) {
  return {
    // `since` defaults to "just became available", so ordering tests must set it
    // explicitly — an undefined idle clock would make the fairness sort a no-op
    // and quietly pass a test written to prove it works.
    get: vi.fn(async (id: string) => (
      states[id] ? { state: states[id], attemptId: null, since: Date.now() } : null)),
    reserve: vi.fn(async (id: string) => (states[id] === 'available' ? 'reserved' : 'lost')),
    set: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStations(owned: string[]) {
  return {
    isLocallyOwned: vi.fn((id: string) => owned.includes(id)),
    ownerOf: vi.fn(async (id: string) => (owned.includes(id) ? 'r1' : null)),
    // Typed params, or `mock.calls[0][1]` is unindexable under a typechecked
    // test config — the frame assertions below all read the second argument.
    broadcast: vi.fn((_campaignId: string, _frame: unknown) => owned.length),
    sessionIdsForCampaign: vi.fn(() => owned),
  };
}

/**
 * A DNC registry that answers `clear`.
 *
 * The pre-dial gate is fail-closed, so an engine built without one dials nothing
 * and every assertion below would pass vacuously by never reaching the dial. A
 * stub rather than a real `DncRegistry`: what the registry decides is
 * `dnc-registry.test.ts`'s subject, and how the tick RESPONDS to each decision is
 * `pacing-engine-gates.test.ts`'s. This file is the arithmetic.
 */
function clearDnc() {
  return { check: vi.fn().mockResolvedValue('clear') };
}

function engine(
  stations: any, agents: any, dispatch = vi.fn().mockResolvedValue(undefined), dnc = clearDnc(),
) {
  const e = new PacingEngine(null, '', 'r1', stations as any, agents as any, { dispatch } as any, dnc as any);
  return { e, dispatch, dnc };
}

beforeEach(() => {
  vi.clearAllMocks();
  repos.campaign.findById.mockResolvedValue(CAMPAIGN);
  repos.campaign.countOutstanding.mockResolvedValue(0);
  repos.contact.claimDialable.mockResolvedValue([]);
  repos.attempt.countLive.mockResolvedValue(0);
  repos.attempt.create.mockImplementation(async (p: any) => ({
    id: `att-${p.contactId}`, caller_id: p.callerId, attempt_number: p.attemptNumber,
  }));
  settings.getMaxConcurrentCalls.mockResolvedValue(5);
  repos.session.findLiveForCampaign.mockResolvedValue([]);
  flags.isEnabled.mockResolvedValue(true);
});

describe('PacingEngine tick arithmetic', () => {
  it('dials nothing when no agent is available — that IS the paused state', async () => {
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    const { e, dispatch } = engine(makeStations(['s1', 's2']), makeAgents({ s1: 'on_call', s2: 'wrapup' }));

    await e.tickOnce('camp-1');

    expect(repos.contact.claimDialable).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('resumes on the very next tick when an agent frees up — no pause flag involved', async () => {
    const states: Record<string, string> = { s1: 'on_call' };
    const agents = makeAgents(states);
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    const { e, dispatch } = engine(makeStations(['s1']), agents);

    await e.tickOnce('camp-1');
    expect(dispatch).not.toHaveBeenCalled();

    // The agent finishes. Same expression, different answer.
    states.s1 = 'available';
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    await e.tickOnce('camp-1');

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('targets MIN(account limit, available agents)', async () => {
    // 4 agents free but the account ceiling is 2 → claim 2, not 4.
    settings.getMaxConcurrentCalls.mockResolvedValue(2);
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }]);
    const { e } = engine(
      makeStations(['s1', 's2', 's3', 's4']),
      makeAgents({ s1: 'available', s2: 'available', s3: 'available', s4: 'available' }),
    );

    await e.tickOnce('camp-1');
    expect(repos.contact.claimDialable).toHaveBeenCalledWith('camp-1', 2);
  });

  it('is bounded by available agents when they are scarcer than the ceiling', async () => {
    settings.getMaxConcurrentCalls.mockResolvedValue(10);
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    const { e } = engine(makeStations(['s1', 's2']), makeAgents({ s1: 'available', s2: 'available' }));

    await e.tickOnce('camp-1');
    expect(repos.contact.claimDialable).toHaveBeenCalledWith('camp-1', 2);
  });

  it('counts BRIDGED attempts as occupied, or the engine spins forever', async () => {
    // A bridged call still holds an account concurrency slot. Excluding
    // answered/bridged would make the engine reserve agents and claim contacts
    // only to be refused by the guard, every tick, forever, whenever agents
    // outnumber the account limit.
    settings.getMaxConcurrentCalls.mockResolvedValue(3);
    repos.attempt.countLive.mockResolvedValue(3); // all three slots are live calls
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    const { e } = engine(
      makeStations(['s1', 's2', 's3']),
      makeAgents({ s1: 'available', s2: 'available', s3: 'available' }),
    );

    await e.tickOnce('camp-1');
    expect(repos.contact.claimDialable).not.toHaveBeenCalled();
  });

  // ── The mixed state: some agents busy, some idle ─────────────────────────
  //
  // Every test above has all agents in ONE state, which is why the formula could
  // be wrong for the entire life of the feature without a red test. A busy agent
  // is absent from `candidates` (it failed the `state === 'available'` check) AND
  // present in `countLive` (its attempt is non-terminal), so a target computed as
  // `MIN(limit, idle) - occupied` removed it twice and the campaign stalled
  // whenever anyone was on a call.
  //
  // Staging, 2026-08-13: agent B went available at 06:47:15 while agent A's call
  // was still ringing; nothing was dialled for 24 s, until A's call ended
  // unanswered and both agents were idle — at which point two calls went out
  // 0.9 s apart. Both symptoms the operator reported are this one arithmetic bug.

  it('a busy agent must not consume an idle one\'s slot', async () => {
    // Two agents, one mid-call. The idle one is free to take a call and the
    // account ceiling is nowhere near — so exactly one dial.
    settings.getMaxConcurrentCalls.mockResolvedValue(10);
    repos.attempt.countLive.mockResolvedValue(1); // s1's live call
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    const { e } = engine(
      makeStations(['s1', 's2']),
      // s1 is ON a call, so it is not `available` — this is the shape no other
      // test in this file produces.
      makeAgents({ s1: 'on_call', s2: 'available' }),
    );

    await e.tickOnce('camp-1');
    expect(repos.contact.claimDialable).toHaveBeenCalledWith('camp-1', 1);
  });

  it('keeps dialling for the idle majority while a minority is busy', async () => {
    // Four agents, one busy. Three idle ⇒ three dials, not `3 - 1 = 2`.
    settings.getMaxConcurrentCalls.mockResolvedValue(10);
    repos.attempt.countLive.mockResolvedValue(1);
    repos.session.findLiveForCampaign.mockResolvedValue([
      { id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' },
    ]);
    const { e } = engine(
      makeStations(['s1', 's2', 's3', 's4']),
      makeAgents({ s1: 'on_call', s2: 'available', s3: 'available', s4: 'available' }),
    );

    await e.tickOnce('camp-1');
    expect(repos.contact.claimDialable).toHaveBeenCalledWith('camp-1', 3);
  });

  it('still refuses to exceed the account ceiling with a busy agent in the mix', async () => {
    // The half that WAS right, and must stay right: `occupied` counts against the
    // account limit. Ceiling 2, one call already up, two idle agents ⇒ one dial,
    // because the ceiling — not the agent count — is what binds here.
    settings.getMaxConcurrentCalls.mockResolvedValue(2);
    repos.attempt.countLive.mockResolvedValue(1);
    repos.session.findLiveForCampaign.mockResolvedValue([
      { id: 's1' }, { id: 's2' }, { id: 's3' },
    ]);
    const { e } = engine(
      makeStations(['s1', 's2', 's3']),
      makeAgents({ s1: 'on_call', s2: 'available', s3: 'available' }),
    );

    await e.tickOnce('camp-1');
    expect(repos.contact.claimDialable).toHaveBeenCalledWith('camp-1', 1);
  });

  it('dials nothing when the account ceiling is already fully occupied', async () => {
    // Ceiling 1, one live call, another agent idle and waiting. Correctly zero —
    // this is the account limit doing its job, not the double-count.
    settings.getMaxConcurrentCalls.mockResolvedValue(1);
    repos.attempt.countLive.mockResolvedValue(1);
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    const { e } = engine(
      makeStations(['s1', 's2']),
      makeAgents({ s1: 'on_call', s2: 'available' }),
    );

    await e.tickOnce('camp-1');
    expect(repos.contact.claimDialable).not.toHaveBeenCalled();
  });

  it('clamps to zero — and REPORTS zero — when occupied exceeds the ceiling', async () => {
    // The ceiling can drop below the live count (a supervisor lowers it mid-shift,
    // or a stale attempt lingers), making the headroom negative.
    //
    // **Asserted on the `no_slots` metric, not on `claimDialable`.** The obvious
    // version of this test — "claimDialable was not called" — is VACUOUS, which
    // review of #290 caught: `tickOnce` gates on `if (plan.toDial > 0)`, so
    // deleting `Math.max(0, …)` leaves `toDial` at `-3`, `-3 > 0` is false,
    // `dialUpTo` is never entered and `claimDialable` is never called. Green,
    // while the clamp it names is gone.
    //
    // The idle reason is the one observable that does discriminate: `planTick`
    // sets it on `toDial === 0`, and `-3 !== 0`, so an unclamped tick silently
    // stops reporting why it dialled nothing — which is exactly the supervisor's
    // "why is this campaign idle" question going unanswered.
    const metrics = await import('@magick-agency/observability/metrics/agency');
    const idle = vi.spyOn(metrics.agencyTickIdleTotal, 'inc');
    try {
      settings.getMaxConcurrentCalls.mockResolvedValue(1);
      repos.attempt.countLive.mockResolvedValue(4);
      repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
      const { e } = engine(
        makeStations(['s1', 's2']),
        makeAgents({ s1: 'on_call', s2: 'available' }),
      );

      await e.tickOnce('camp-1');

      expect(repos.contact.claimDialable).not.toHaveBeenCalled();
      expect(idle).toHaveBeenCalledWith(expect.objectContaining({ reason: 'no_slots' }));
    } finally {
      idle.mockRestore();
    }
  });

  it('ignores agents whose socket this replica does not hold', async () => {
    // Presence is the heartbeat, not the DB row. A row saying `available` for an
    // agent with no socket would put a real customer through to nobody.
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    const { e } = engine(makeStations(['s1']), makeAgents({ s1: 'available', s2: 'available' }));

    await e.tickOnce('camp-1');
    expect(repos.contact.claimDialable).toHaveBeenCalledWith('camp-1', 1);
  });

  it('does not dial a paused campaign, but still evaluates completion', async () => {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, status: 'paused' });
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    const { e, dispatch } = engine(makeStations(['s1']), makeAgents({ s1: 'available' }));

    await e.tickOnce('camp-1');
    expect(dispatch).not.toHaveBeenCalled();
    // A paused campaign is not finalized — only running/stopping are.
    expect(repos.campaign.transitionStatus).not.toHaveBeenCalled();
  });
});

describe('PacingEngine reserve-before-dial', () => {
  it('reserves an agent BEFORE creating the attempt or dispatching', async () => {
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    const agents = makeAgents({ s1: 'available' });
    const order: string[] = [];
    agents.reserve.mockImplementation(async () => { order.push('reserve'); return 'reserved'; });
    repos.attempt.create.mockImplementation(async (p: any) => {
      order.push('create-attempt');
      return { id: 'att-1', caller_id: p.callerId, attempt_number: 1 };
    });
    const dispatch = vi.fn(async () => { order.push('dispatch'); });
    const { e } = engine(makeStations(['s1']), agents, dispatch);

    await e.tickOnce('camp-1');

    // The agent is committed before the carrier is ever contacted — which is what
    // makes "answered call with no agent" unreachable under D1.
    expect(order).toEqual(['reserve', 'create-attempt', 'dispatch']);
  });

  it('NEVER consumes a contact when every agent is lost to another tick', async () => {
    // Agents are reserved before any contact is claimed, so a lost
    // CAS costs one Redis call and touches nothing durable.
    //
    // This assertion used to be `unclaim('c1', …)` — correct for the old order,
    // which claimed a batch of contacts and then hunted for agents, so a lost race
    // moved a real contact into `in_flight` and back out again. Recoverable, but it
    // made the contact's state a function of a race it had no part in, and every
    // round trip was a window where a crash stranded the row for the reaper. The
    // stronger claim now available is that the contact is never touched at all.
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    const agents = makeAgents({ s1: 'available' });
    agents.reserve.mockResolvedValue('lost');
    const { e, dispatch } = engine(makeStations(['s1']), agents, vi.fn());

    await e.tickOnce('camp-1');

    expect(dispatch).not.toHaveBeenCalled();
    expect(repos.contact.claimDialable).not.toHaveBeenCalled();
    expect(repos.contact.unclaim).not.toHaveBeenCalled();
  });

  it('claims exactly as many contacts as it holds agents, never the tick target', async () => {
    // Three agents available, concurrency 3, but only two win their CAS. Claiming
    // to the target would strand the third contact in `in_flight` with nobody to
    // dial it — the shape of (b) that a single-agent test cannot show.
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1'), contact('c2')]);
    const agents = makeAgents({ s1: 'available', s2: 'available', s3: 'available' });
    agents.reserve.mockImplementation(async (id: string) => (id === 's2' ? 'lost' : 'reserved'));
    const { e } = engine(makeStations(['s1', 's2', 's3']), agents, vi.fn());

    await e.tickOnce('camp-1');

    expect(repos.contact.claimDialable).toHaveBeenCalledWith('camp-1', 2);
  });

  it('returns a reserved agent to the pool when the roster runs out mid-tick', async () => {
    // Two agents reserved, one contact left. The surplus agent did nothing wrong
    // and must not sit `reserved` until their lease lapses — that would take them
    // out of the pool for 15s over a roster that simply ran dry.
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    const agents = makeAgents({ s1: 'available', s2: 'available' });
    const { e } = engine(makeStations(['s1', 's2']), agents, vi.fn());

    await e.tickOnce('camp-1');

    expect(agents.set).toHaveBeenCalledWith('s2', 'available', expect.anything());
  });

  it('reserves the longest-idle agent first, and does not let the pool order decide', async () => {
    // `findLiveForCampaign` returns a database order — stable
    // across ticks and unrelated to who has been waiting — so taking it as-is
    // hands the early rows most of the calls and lets a late row idle forever on a
    // pool larger than the concurrency ceiling. Deliberately fed in the WRONG
    // order, with the longest-idle agent last, so a test that merely echoed the
    // input order would pass while the fairness rule was absent.
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 'fresh' }, { id: 'middle' }, { id: 'stale' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    const now = Date.now();
    const agents = makeAgents({ fresh: 'available', middle: 'available', stale: 'available' });
    agents.get.mockImplementation(async (id: string) => ({
      state: 'available',
      attemptId: null,
      since: { fresh: now - 1_000, middle: now - 30_000, stale: now - 600_000 }[id]!,
    }));
    const { e } = engine(makeStations(['fresh', 'middle', 'stale']), agents, vi.fn());

    await e.tickOnce('camp-1');

    expect(agents.reserve.mock.calls[0]![0]).toBe('stale');
  });

  it('honours the duplicate-dial backstop and releases the agent', async () => {
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    repos.attempt.create.mockResolvedValue(null); // uq_agency_attempt_live refused it
    const agents = makeAgents({ s1: 'available' });
    const { e, dispatch } = engine(makeStations(['s1']), agents, vi.fn());

    await e.tickOnce('camp-1');

    // The database refusing is it doing its job, not an error to retry.
    expect(dispatch).not.toHaveBeenCalled();
    expect(agents.set).toHaveBeenCalledWith('s1', 'available');
    expect(repos.contact.unclaim).toHaveBeenCalledWith('c1', expect.any(Date));
  });

  it('releases the agent and contact when dispatch throws', async () => {
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    const agents = makeAgents({ s1: 'available' });
    const { e } = engine(makeStations(['s1']), agents, vi.fn().mockRejectedValue(new Error('no owner')));

    await e.tickOnce('camp-1');

    expect(repos.attempt.setState).toHaveBeenCalledWith('att-c1', 'ended', expect.objectContaining({ outcome: 'failed' }));
    expect(agents.set).toHaveBeenCalledWith('s1', 'available');
    expect(repos.contact.unclaim).toHaveBeenCalledWith('c1', expect.any(Date));
  });

  it('will not dial an agent no replica owns', async () => {
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    const stations = makeStations(['s1']);
    stations.ownerOf.mockResolvedValue(null); // socket died between reserve and dial
    const agents = makeAgents({ s1: 'available' });
    const { e, dispatch } = engine(stations, agents, vi.fn());

    await e.tickOnce('camp-1');

    expect(dispatch).not.toHaveBeenCalled();
    expect(agents.set).toHaveBeenCalledWith('s1', 'offline');
  });

  it('rotates the caller-ID pool rather than hammering one number', async () => {
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1'), contact('c2')]);
    const { e } = engine(makeStations(['s1', 's2']), makeAgents({ s1: 'available', s2: 'available' }));

    await e.tickOnce('camp-1');

    const used = repos.attempt.create.mock.calls.map((c: any) => c[0].callerId);
    for (const id of used) expect(CAMPAIGN.caller_ids).toContain(id);
    expect(used).toHaveLength(2);
  });

  it('an EMPTY caller-ID pool touches NOTHING — no reservation, no claim, no spin', async () => {
    // ── Why this is asserted as "nothing happened" rather than "it unwound" ────
    //
    // `pickCallerId` first threw (leaking every reservation the tick had taken),
    // then unwound via `abortRemainder`. Unwinding is not enough: the campaign stays
    // `running` and `tickOnce` fires again 250 ms later, so each tick reserved
    // agents, wrote N contacts to `in_flight`, and unclaimed them at `now()` — the
    // exact 4-claims-a-second spin `AgencyContactRepository.unclaim` documents as
    // the thing to avoid, forever, on a condition only a human can clear.
    //
    // Two further costs made it worse than wasted queries: every agent's
    // `availableSince` was restamped each tick, collapsing the longest-idle fairness
    // ordering the idle-first pick depends on; and an unthrottled `log.error` per tick is
    // ~345k lines/day.
    //
    // So the guard belongs BEFORE `planTick`, and the assertion is that the tick is
    // inert.
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, caller_ids: [] });
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1'), contact('c2')]);
    const agents = makeAgents({ s1: 'available', s2: 'available' });
    const stations = makeStations(['s1', 's2']);
    const { e, dispatch } = engine(stations, agents);

    await expect(e.tickOnce('camp-1')).resolves.toBeUndefined();

    // Never reached the pool or the roster at all.
    expect(agents.reserve).not.toHaveBeenCalled();
    expect(repos.contact.claimDialable).not.toHaveBeenCalled();
    expect(repos.contact.unclaim).not.toHaveBeenCalled();
    expect(repos.attempt.create).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    // And the agents' idle clocks are untouched, so fairness ordering survives.
    expect(agents.set).not.toHaveBeenCalled();
  });

  it('tells the AGENTS the campaign cannot dial, exactly once however many ticks run', async () => {
    // A supervisor has the campaign row and the `agency_tick_idle_total` series. An
    // agent has a console showing a Running badge and `dialing: true`, waiting for a
    // call that is never coming — the same "healthy-looking campaign that dials
    // nothing" shape this whole change exists to eliminate.
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, caller_ids: [] });
    const stations = makeStations(['s1']);
    const { e } = engine(stations, makeAgents({ s1: 'available' }));

    await e.tickOnce('camp-1');
    await e.tickOnce('camp-1');
    await e.tickOnce('camp-1');

    // Latched: 4 Hz × an unlatched broadcast is a frame storm at the console.
    expect(stations.broadcast).toHaveBeenCalledTimes(1);
    const frame = stations.broadcast.mock.calls[0]![1] as any;
    expect(frame.event).toBe('campaign_state');
    // `status` is still honestly `running` — nothing has written the row — but
    // `dialing` is the boolean the console drives its idle state from, and it must
    // not be derived from the status here or it would say `true`.
    expect(frame.status).toBe('running');
    expect(frame.dialing).toBe(false);
    expect(frame.message).toBeTruthy();
  });

  it('tells the agents when the campaign can dial AGAIN, and re-arms the report', async () => {
    // ── This test previously pinned the bug it was supposed to guard ──────────
    // It asserted exactly 2 broadcasts across broken→fixed→broken, which
    // enshrined the MISSING recovery frame as correct. There must be 3: stopped,
    // resumed, stopped. `campaign_state` is the only frame carrying `dialing`, and
    // `tickOnce`'s status-change detector cannot produce it here because the status
    // never leaves `running` — so without an explicit resume announcement the
    // console reads auto-paused forever while calls are routed to it.
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, caller_ids: [] });
    const stations = makeStations(['s1']);
    const { e } = engine(stations, makeAgents({ s1: 'available' }));
    await e.tickOnce('camp-1');
    expect(stations.broadcast).toHaveBeenCalledTimes(1);
    expect((stations.broadcast.mock.calls[0]![1] as any).dialing).toBe(false);

    // An operator adds a caller ID. The agents must be told.
    repos.campaign.findById.mockResolvedValue(CAMPAIGN);
    await e.tickOnce('camp-1');
    expect(stations.broadcast).toHaveBeenCalledTimes(2);
    const resumed = stations.broadcast.mock.calls[1]![1] as any;
    expect(resumed.event).toBe('campaign_state');
    expect(resumed.dialing).toBe(true);
    expect(resumed.reason).toBe('resumed');

    // Steady state is silent — an ordinary healthy tick must not broadcast.
    await e.tickOnce('camp-1');
    await e.tickOnce('camp-1');
    expect(stations.broadcast).toHaveBeenCalledTimes(2);

    // And if it breaks a second time, that is a new episode worth reporting.
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, caller_ids: [] });
    await e.tickOnce('camp-1');
    expect(stations.broadcast).toHaveBeenCalledTimes(3);
    expect((stations.broadcast.mock.calls[2]![1] as any).dialing).toBe(false);
  });

  it('treats a stored `caller_ids: [""]` as unusable — length was never the check', async () => {
    // ── The 4 Hz spin the latch was supposed to have removed ──────────────────
    // `pickCallerId` returned a falsy `''` for this pool while the guard tested
    // `length === 0`, so a length-1 junk pool passed the guard, `clearStuck` wiped
    // the latch on the way through, the dial loop failed on the empty string, and
    // `noteMisconfigured` fired UNLATCHED every 250 ms — the log flood and the
    // broadcast storm, plus reservation churn and fairness damage. The route
    // validator refuses `['']` now, but no migration cleans rows already stored.
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, caller_ids: [''] });
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    const stations = makeStations(['s1']);
    const agents = makeAgents({ s1: 'available' });
    const { e, dispatch } = engine(stations, agents);

    await e.tickOnce('camp-1');
    await e.tickOnce('camp-1');
    await e.tickOnce('camp-1');

    // Caught by the top-of-tick guard, so nothing is reserved or claimed at all.
    expect(agents.reserve).not.toHaveBeenCalled();
    expect(repos.contact.claimDialable).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    // And latched: one report across three ticks, not three.
    expect(stations.broadcast).toHaveBeenCalledTimes(1);
  });

  it('ignores whitespace-only and non-string caller IDs, and dials the real one', async () => {
    repos.campaign.findById.mockResolvedValue({
      ...CAMPAIGN, caller_ids: ['  ', null, 42, '  +14155550100  '],
    });
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    const { e, dispatch } = engine(makeStations(['s1']), makeAgents({ s1: 'available' }));

    await e.tickOnce('camp-1');

    expect(dispatch).toHaveBeenCalledTimes(1);
    // Trimmed, so a padded stored value cannot reach the carrier with spaces.
    expect(repos.attempt.create.mock.calls[0]![0].callerId).toBe('+14155550100');
  });

  it('stops dialing the remainder when leadership is given up mid-tick', async () => {
    // `relinquish` clears the interval, which does nothing about a tick already
    // parked on an await. Without a revocation check that tick resumes and
    // dispatches real outbound calls — after the lease was released and after the
    // flag gate told every console dialing had stopped.
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1'), contact('c2')]);
    const agents = makeAgents({ s1: 'available', s2: 'available' });
    const { e, dispatch } = engine(makeStations(['s1', 's2']), agents);

    // Relinquish while the tick is in flight: the gate evaluation is the await we
    // interpose on, so the very first contact sees the revocation.
    repos.contact.claimDialable.mockImplementation(async () => {
      await (e as any).relinquish('camp-1');
      return [contact('c1'), contact('c2')];
    });

    await e.tickOnce('camp-1');

    expect(dispatch).not.toHaveBeenCalled();
    // The remainder is returned, not stranded: both agents back, both contacts
    // unclaimed.
    expect(repos.contact.unclaim.mock.calls.map((c: any) => c[0]).sort()).toEqual(['c1', 'c2']);
  });
});

describe('PacingEngine finalization', () => {
  it('completes a drained campaign and tells every agent why', async () => {
    repos.campaign.countOutstanding.mockResolvedValue(0);
    repos.campaign.transitionStatus.mockResolvedValue({ ...CAMPAIGN, status: 'completed' });
    const stations = makeStations(['s1']);
    const { e } = engine(stations, makeAgents({}));

    await e.tickOnce('camp-1');

    // No fourth argument. The lifecycle stamps (`ended_at`, and its legacy twin
    // `completed_at`) are derived from the TARGET STATUS inside `transitionStatus`
    // since migration 108, so the leader carries no patch — which is the point of
    // moving them: a call site cannot get them wrong by omission when there is
    // nothing to omit. Asserted as an EXACT three-argument call rather than with a
    // trailing `expect.anything()`, so a patch quietly reappearing here is a
    // failure rather than something the matcher waves through.
    expect(repos.campaign.transitionStatus).toHaveBeenCalledWith('camp-1', ['running'], 'completed');
    // List exhaustion is the normal end of every run; an idle agent is
    // unreachable by any per-attempt frame, so this must be broadcast.
    const frame = stations.broadcast.mock.calls[0]![1] as any;
    expect(frame.event).toBe('campaign_state');
    expect(frame.reason).toBe('list_exhausted');
    expect(frame.dialing).toBe(false);
    expect(frame.message).toBeTruthy();
    // The leader-written terminal row is the record that the campaign
    // actually ended. Assert on payload, not on "a log happened" — a missing
    // call produces `[]`/`0` and would satisfy a count assertion.
    expect(audit.log).toHaveBeenCalledWith({
      tenantId: 't1',
      accountId: 'a1',
      eventType: 'agency_campaign.completed',
      eventCategory: 'call',
      severity: 'info',
      actor: 'system:pacing-leader',
      eventData: { campaign_id: 'camp-1', from: 'running', to: 'completed' },
    });
  });

  it('does not finalize while contacts are still outstanding', async () => {
    repos.campaign.countOutstanding.mockResolvedValue(7);
    const { e } = engine(makeStations([]), makeAgents({}));

    await e.tickOnce('camp-1');
    expect(repos.campaign.transitionStatus).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('drains a stopping campaign to stopped, not completed', async () => {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, status: 'stopping' });
    repos.campaign.transitionStatus.mockResolvedValue({ ...CAMPAIGN, status: 'stopped' });
    const stations = makeStations(['s1']);
    const { e } = engine(stations, makeAgents({}));

    await e.tickOnce('camp-1');

    // No fourth argument. The lifecycle stamps (`ended_at`, and its legacy twin
    // `completed_at`) are derived from the TARGET STATUS inside `transitionStatus`
    // since migration 108, so the leader carries no patch — which is the point of
    // moving them: a call site cannot get them wrong by omission when there is
    // nothing to omit. Asserted as an EXACT three-argument call rather than with a
    // trailing `expect.anything()`, so a patch quietly reappearing here is a
    // failure rather than something the matcher waves through.
    expect(repos.campaign.transitionStatus).toHaveBeenCalledWith('camp-1', ['stopping'], 'stopped');
    expect((stations.broadcast.mock.calls[0]![1] as any).reason).toBe('stopped_by_supervisor');
    expect(audit.log).toHaveBeenCalledWith({
      tenantId: 't1',
      accountId: 'a1',
      eventType: 'agency_campaign.stopped',
      eventCategory: 'call',
      severity: 'info',
      actor: 'system:pacing-leader',
      eventData: { campaign_id: 'camp-1', from: 'stopping', to: 'stopped' },
    });
  });

  it('stops a campaign stopped MID-ROSTER — undialed contacts are not a drain', async () => {
    // ── The predicate, not the source status, is what stranded `stopping` ──────
    //
    // `stopping → stopped` used to share `running → completed`'s roster count, and
    // that count includes every `pending` contact. Nothing moves those rows when a
    // campaign stops, so a campaign stopped at row 100 of 50 000 left 49 900 of them
    // and `countOutstanding` could never reach 0 — the row could not leave
    // `stopping` with a leader, with the flag on, at any point afterwards. The
    // previous two fixes narrowed `/stop`'s source statuses instead, which cannot
    // reach this: `running` and `paused` strand exactly as `draft` did.
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, status: 'stopping' });
    repos.campaign.countOutstanding.mockResolvedValue(49_900);   // the untouched roster
    repos.attempt.countLive.mockResolvedValue(0);                // every call has ended
    repos.campaign.transitionStatus.mockResolvedValue({ ...CAMPAIGN, status: 'stopped' });
    const { e } = engine(makeStations(['s1']), makeAgents({}));

    await e.tickOnce('camp-1');

    // No fourth argument. The lifecycle stamps (`ended_at`, and its legacy twin
    // `completed_at`) are derived from the TARGET STATUS inside `transitionStatus`
    // since migration 108, so the leader carries no patch — which is the point of
    // moving them: a call site cannot get them wrong by omission when there is
    // nothing to omit. Asserted as an EXACT three-argument call rather than with a
    // trailing `expect.anything()`, so a patch quietly reappearing here is a
    // failure rather than something the matcher waves through.
    expect(repos.campaign.transitionStatus)
      .toHaveBeenCalledWith('camp-1', ['stopping'], 'stopped');
    // And the roster was not even consulted — the two transitions ask different
    // questions, so sharing one query is the defect rather than an optimisation.
    expect(repos.campaign.countOutstanding).not.toHaveBeenCalled();
  });

  it('still waits for the calls themselves — a live attempt holds `stopping` open', async () => {
    // The inverse, so the test above cannot pass by the drain having been removed
    // altogether. "Stopped" has to mean the conversations ended, not merely that we
    // quit dialing.
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, status: 'stopping' });
    repos.campaign.countOutstanding.mockResolvedValue(0);
    repos.attempt.countLive.mockResolvedValue(1);

    const { e } = engine(makeStations(['s1']), makeAgents({}));
    await e.tickOnce('camp-1');

    expect(repos.campaign.transitionStatus).not.toHaveBeenCalled();
  });

  it('a RUNNING campaign still completes on the roster, not on live attempts', async () => {
    // The split has to cut the right way round. `running → completed` asks "is there
    // work left", and a pending contact whose retry is hours out is work — measuring
    // live attempts there would complete a campaign that is merely between calls.
    repos.campaign.countOutstanding.mockResolvedValue(7);
    repos.attempt.countLive.mockResolvedValue(0);

    const { e } = engine(makeStations([]), makeAgents({}));
    await e.tickOnce('camp-1');

    expect(repos.campaign.transitionStatus).not.toHaveBeenCalled();
  });

  it('does not finalize on a tick that actually dialed', async () => {
    // Completion is only ever evaluated on an idle tick, so a campaign cannot be
    // declared complete in the same breath as placing a call.
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    const { e } = engine(makeStations(['s1']), makeAgents({ s1: 'available' }));

    await e.tickOnce('camp-1');
    expect(repos.campaign.transitionStatus).not.toHaveBeenCalled();
  });

  it('announces a supervisor pause to idle agents', async () => {
    // Contacts still outstanding, so the seeding tick doesn't finalize the
    // campaign out from under the test.
    repos.campaign.countOutstanding.mockResolvedValue(5);
    const stations = makeStations(['s1']);
    const { e } = engine(stations, makeAgents({}));
    await e.tickOnce('camp-1');                                        // seed: running
    repos.campaign.findById.mockResolvedValue({
      ...CAMPAIGN, status: 'paused', pause_reason: 'supervisor', paused_at: new Date(),
    });
    stations.broadcast.mockClear();

    await e.tickOnce('camp-1');

    const frame = stations.broadcast.mock.calls[0]![1] as any;
    expect(frame.reason).toBe('paused_by_supervisor');
    expect(frame.dialing).toBe(false);
  });

  it('announces the ABANDONMENT guardrail as an auto-pause, not a supervisor pause', async () => {
    // The abandonment guardrail pauses out-of-band, from the abandonment refresh, and announces
    // nothing itself — this tick is the only thing that reaches the floor. Reading
    // the status alone told every agent on a campaign stopped for a REGULATORY
    // reason that their supervisor had done it, which is a different instruction:
    // one says "ask your supervisor", the other says "this will not resume until
    // someone above you decides it should".
    repos.campaign.countOutstanding.mockResolvedValue(5);
    const stations = makeStations(['s1']);
    const { e } = engine(stations, makeAgents({}));
    await e.tickOnce('camp-1');                                        // seed: running
    repos.campaign.findById.mockResolvedValue({
      ...CAMPAIGN,
      status: 'paused',
      pause_reason: 'abandonment_ceiling',
      pause_abandonment_rate_pct: 4.1,
      paused_at: new Date(),
    });
    stations.broadcast.mockClear();

    await e.tickOnce('camp-1');

    const frame = stations.broadcast.mock.calls[0]![1] as any;
    expect(frame.reason).toBe('auto_paused');
    expect(frame.message).toBe('This campaign was paused automatically.');
    expect(frame.dialing).toBe(false);
  });

  it('drops a campaign that vanished underneath it', async () => {
    repos.campaign.findById.mockResolvedValue(null);
    const { e } = engine(makeStations([]), makeAgents({}));
    await expect(e.tickOnce('gone')).resolves.toBeUndefined();
    expect(repos.contact.claimDialable).not.toHaveBeenCalled();
  });
});

describe('PacingEngine leadership', () => {
  it('leads everything when there is no Redis (single replica by definition)', async () => {
    repos.campaign.findActive.mockResolvedValue([CAMPAIGN]);
    const { e } = engine(makeStations([]), makeAgents({}));
    e.start();
    await vi.waitFor(() => expect(e.leading()).toContain('camp-1'));
    await e.stop();
    expect(e.leading()).toEqual([]);
  });

  it('does not lead a campaign whose lease another replica holds', async () => {
    const redis = { set: vi.fn().mockResolvedValue(null), eval: vi.fn().mockResolvedValue(0) };
    repos.campaign.findActive.mockResolvedValue([CAMPAIGN]);
    const e = new PacingEngine(
      redis as any, '', 'r1', makeStations([]) as any, makeAgents({}) as any,
      { dispatch: vi.fn() } as any, clearDnc() as any,
    );
    e.start();
    await vi.waitFor(() => expect(redis.set).toHaveBeenCalled());
    // The lease is the efficiency mechanism; losing it simply means another
    // replica is doing the work.
    expect(e.leading()).toEqual([]);
    await e.stop();
  });

  it('relinquishes a campaign that stops being active', async () => {
    repos.campaign.findActive.mockResolvedValue([CAMPAIGN]);
    const { e } = engine(makeStations([]), makeAgents({}));
    e.start();
    await vi.waitFor(() => expect(e.leading()).toContain('camp-1'));

    repos.campaign.findActive.mockResolvedValue([]);
    await (e as any).superviseOnce();
    expect(e.leading()).toEqual([]);
    await e.stop();
  });

  it('refuses to lead a campaign whose account has the dialer flag OFF', async () => {
    // `findActive()` selects on status alone, so a campaign left in `running` when
    // a tenant was switched off kept being led and kept dialing. Every campaign
    // CONTROL is flag-gated, which made it worse than it sounds: turning the flag
    // off took the operator's own stop button away (403) while the engine carried
    // on placing calls for a tenant the platform believes has no dialer.
    repos.campaign.findActive.mockResolvedValue([CAMPAIGN]);
    flags.isEnabled.mockResolvedValue(false);
    const { e } = engine(makeStations([]), makeAgents({}));

    await (e as any).superviseOnce();

    expect(e.leading()).toEqual([]);
    // Resolved against the campaign's OWN tenant/account, not the process — the
    // flag has account scope and one replica leads campaigns for many tenants.
    expect(flags.isEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'agency_dialer_enabled' }),
      { tenantId: 't1', accountId: 'a1' },
    );
    await e.stop();
  });

  it('DROPS leadership of a running campaign when the flag goes off mid-run', async () => {
    // The kill switch has to stop a campaign that is ALREADY dialing, not merely
    // decline to start new ones — otherwise switching a tenant off does nothing
    // until the next deploy.
    repos.campaign.findActive.mockResolvedValue([CAMPAIGN]);
    const { e } = engine(makeStations([]), makeAgents({}));
    await (e as any).superviseOnce();
    expect(e.leading()).toContain('camp-1');

    flags.isEnabled.mockResolvedValue(false);
    await (e as any).superviseOnce();

    expect(e.leading()).toEqual([]);
    await e.stop();
  });

  it('re-leads once the flag comes back on', async () => {
    repos.campaign.findActive.mockResolvedValue([CAMPAIGN]);
    flags.isEnabled.mockResolvedValue(false);
    const { e } = engine(makeStations([]), makeAgents({}));
    await (e as any).superviseOnce();
    expect(e.leading()).toEqual([]);

    flags.isEnabled.mockResolvedValue(true);
    await (e as any).superviseOnce();

    expect(e.leading()).toContain('camp-1');
    await e.stop();
  });

  it('tells the agents when the flag takes their campaign away', async () => {
    // Relinquishing kills `tickOnce`, which is where `announceCampaignState`
    // normally lives — so this is the ONLY place the frame can come from, and
    // without it every joined agent keeps a Running badge and `dialing: true`
    // indefinitely with a server-side log line as the sole signal.
    repos.campaign.findActive.mockResolvedValue([CAMPAIGN]);
    flags.isEnabled.mockResolvedValue(false);
    const stations = makeStations(['s1']);
    const { e } = engine(stations, makeAgents({}));

    await (e as any).superviseOnce();
    await (e as any).superviseOnce();
    await (e as any).superviseOnce();

    // Latched — the pass runs every 2s.
    expect(stations.broadcast).toHaveBeenCalledTimes(1);
    const frame = stations.broadcast.mock.calls[0]![1] as any;
    expect(frame.event).toBe('campaign_state');
    expect(frame.dialing).toBe(false);
    await e.stop();
  });

  it('one campaign failing to resolve does not strand the rest of the pass', async () => {
    // The comment here used to claim `for…of` gave isolation that `Promise.all`
    // would not. It does not: an await in a `for…of` propagates identically. Only
    // the try/catch makes the claim true.
    const other = { ...CAMPAIGN, id: 'camp-2' };
    repos.campaign.findActive.mockResolvedValue([CAMPAIGN, other]);
    flags.isEnabled
      .mockRejectedValueOnce(new Error('flag service exploded'))
      .mockResolvedValue(true);
    const { e } = engine(makeStations([]), makeAgents({}));

    await expect((e as any).superviseOnce()).resolves.toBeUndefined();

    // camp-1 failed closed (not led); camp-2 was still reached and led.
    expect(e.leading()).toEqual(['camp-2']);
    await e.stop();
  });

  it('does not overlap two supervise passes', async () => {
    // The pass does per-campaign Redis I/O on a fixed 2s interval, so a slow Redis
    // or a large roster can make one pass outlast its interval — and two overlapping
    // passes race `tryAcquireLeadership`/`relinquish` for the same campaigns.
    let inFlight = 0;
    let maxConcurrent = 0;
    repos.campaign.findActive.mockImplementation(async () => {
      inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return [];
    });
    const { e } = engine(makeStations([]), makeAgents({}));

    await Promise.all([
      (e as any).superviseOnce(), (e as any).superviseOnce(), (e as any).superviseOnce(),
    ]);

    expect(maxConcurrent).toBe(1);
    await e.stop();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // The off button must not need the feature switched back on.
  //
  // Every campaign READ is flag-gated (deliberately — a 403 is the honest answer
  // for a surface a tenant has not bought) and `/stop` is not, so an operator with
  // the dialer off can press Stop and then see nothing. That is tolerable only if
  // the row reaches `stopped` on its own. It did not: the gate dropped gated
  // campaigns from leadership wholesale, `maybeFinalize` runs only on a leader's
  // tick, so the row sat in `stopping` until someone re-enabled the dialer for the
  // whole account — turn the feature on in order to finish turning it off.
  //
  // Two rounds of fixes edited `/stop`'s source-status list, which could not
  // possibly have reached this.
  // ═══════════════════════════════════════════════════════════════════════════

  it('LEADS a stopping campaign with the flag OFF, so the drain can finish', async () => {
    repos.campaign.findActive.mockResolvedValue([{ ...CAMPAIGN, status: 'stopping' }]);
    flags.isEnabled.mockResolvedValue(false);
    const { e } = engine(makeStations([]), makeAgents({}));

    await (e as any).superviseOnce();

    expect(e.leading(), 'a flag-off stop can never finalize').toContain('camp-1');
    await e.stop();
  });

  it('and that campaign DIALS NOTHING — the drain is not a way back into dialing', async () => {
    // The whole risk of leading a campaign for a tenant whose flag is off. Draining
    // an already-bridged call is not placing a new one, and this is what makes that
    // distinction real rather than asserted.
    repos.campaign.findActive.mockResolvedValue([{ ...CAMPAIGN, status: 'stopping' }]);
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, status: 'stopping' });
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    repos.attempt.countLive.mockResolvedValue(1);            // still draining
    flags.isEnabled.mockResolvedValue(false);
    const agents = makeAgents({ s1: 'available' });
    const { e, dispatch } = engine(makeStations(['s1']), agents);

    await (e as any).superviseOnce();
    await e.tickOnce('camp-1');

    expect(dispatch).not.toHaveBeenCalled();
    expect(agents.reserve).not.toHaveBeenCalled();
    expect(repos.contact.claimDialable).not.toHaveBeenCalled();
    await e.stop();
  });

  it('does not spend a flag read on a stopping campaign it will lead regardless', async () => {
    // Not an optimisation: the answer cannot change the decision, and asking anyway
    // would let an `auto_paused`/`dialing: false` frame be broadcast to agents about
    // a campaign whose status already says it is stopping.
    repos.campaign.findActive.mockResolvedValue([{ ...CAMPAIGN, status: 'stopping' }]);
    const stations = makeStations(['s1']);
    const { e } = engine(stations, makeAgents({}));

    await (e as any).superviseOnce();

    expect(flags.isEnabled).not.toHaveBeenCalled();
    expect(stations.broadcast).not.toHaveBeenCalled();
    await e.stop();
  });

  it('a RUNNING campaign is still dropped by the flag — the exception is narrow', async () => {
    // The kill switch keeps its teeth. Only `stopping` is exempt, and only because
    // it cannot dial.
    repos.campaign.findActive.mockResolvedValue([
      { ...CAMPAIGN, id: 'running-1', status: 'running' },
      { ...CAMPAIGN, id: 'stopping-1', status: 'stopping' },
    ]);
    flags.isEnabled.mockResolvedValue(false);
    const { e } = engine(makeStations([]), makeAgents({}));

    await (e as any).superviseOnce();

    expect(e.leading()).toEqual(['stopping-1']);
    await e.stop();
  });

  it('does not leak the drain-only mark when the campaign reaches stopped', async () => {
    // Same leak the other two latches had: keyed by campaign id, cleared only on the
    // way back to a state that stops setting it.
    repos.campaign.findActive.mockResolvedValue([{ ...CAMPAIGN, status: 'stopping' }]);
    flags.isEnabled.mockResolvedValue(false);
    const { e } = engine(makeStations([]), makeAgents({}));
    await (e as any).superviseOnce();
    expect((e as any).drainOnly.size).toBe(1);

    repos.campaign.findActive.mockResolvedValue([]);   // it stopped
    await (e as any).superviseOnce();

    expect((e as any).drainOnly.size).toBe(0);
    await e.stop();
  });

  it('does not leak the gated-campaign latch when a campaign disappears', async () => {
    // The latch is only cleared on the way back to healthy, so a campaign deleted,
    // completed or stopped while gated would hold its id for the process lifetime.
    repos.campaign.findActive.mockResolvedValue([CAMPAIGN]);
    flags.isEnabled.mockResolvedValue(false);
    const { e } = engine(makeStations([]), makeAgents({}));
    await (e as any).superviseOnce();
    expect((e as any).flagGated.size).toBe(1);

    // The campaign is stopped, so `findActive` stops returning it.
    repos.campaign.findActive.mockResolvedValue([]);
    await (e as any).superviseOnce();

    expect((e as any).flagGated.size).toBe(0);
    await e.stop();
  });

  it('reads the flag once per campaign per supervise pass, not once per tick', async () => {
    // The tick runs at 250ms and the supervise pass at 2s. Resolving the flag on
    // the tick would be 8× the reads for a value that changes about once a quarter
    // — and the flag service's snapshots are Redis-cached, so keeping it on the
    // supervise pass means the steady-state cost is a cached read and no DB round
    // trip at all.
    repos.campaign.findActive.mockResolvedValue([CAMPAIGN]);
    const { e } = engine(makeStations([]), makeAgents({}));
    await (e as any).superviseOnce();
    expect(flags.isEnabled).toHaveBeenCalledTimes(1);

    await e.tickOnce('camp-1');
    await e.tickOnce('camp-1');
    await e.tickOnce('camp-1');
    expect(flags.isEnabled).toHaveBeenCalledTimes(1);
    await e.stop();
  });

  it('does not overlap a slow tick with the next one', async () => {
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    let inFlight = 0;
    let maxConcurrent = 0;
    repos.contact.claimDialable.mockImplementation(async () => {
      inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return [];
    });
    const { e } = engine(makeStations(['s1']), makeAgents({ s1: 'available' }));

    await Promise.all([e.tickOnce('camp-1'), e.tickOnce('camp-1'), e.tickOnce('camp-1')]);
    expect(maxConcurrent).toBe(1);
  });
});

describe('PacingEngine candidate fairness over a run', () => {
  it('does not let any agent idle diverge over a 200-call run', async () => {
    // Asserted as a long-run property: over a long run, not
    // on a single pick. A single-pick test passes on any rule that happens to
    // choose the right agent once — including "always pick index 0" if the pool
    // order flatters it — so the property that actually matters is what the
    // DISTRIBUTION looks like after the queue has rotated a few hundred times.
    //
    // Concurrency 1 makes each tick exactly one call, so 200 ticks over 5 agents
    // is a clean 40 each if selection is fair and a 200/0/0/0/0 landslide if the
    // pool order decides.
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const clock = { now: 1_000_000 };
    // Deliberately NOT round-robin-friendly starting values, and deliberately in
    // an order unrelated to the pool order below.
    const since: Record<string, number> = { a: 5, b: 1, c: 4, d: 2, e: 3 };
    const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0, e: 0 };

    settings.getMaxConcurrentCalls.mockResolvedValue(1);
    repos.session.findLiveForCampaign.mockResolvedValue(ids.map((id) => ({ id })));
    repos.contact.claimDialable.mockImplementation(async (_c: string, limit: number) =>
      Array.from({ length: Math.min(limit, 1) }, (_, i) => contact(`c${i}`)));

    const agents = {
      get: vi.fn(async (id: string) => ({ state: 'available', attemptId: null, since: since[id]! })),
      reserve: vi.fn(async (id: string) => {
        counts[id]!++;
        // The call happens and the agent returns to the pool with a fresh idle
        // clock — which is what makes the queue rotate rather than re-picking the
        // same agent forever.
        clock.now += 1_000;
        since[id] = clock.now;
        return 'reserved';
      }),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const { e } = engine(makeStations(ids), agents, vi.fn());

    for (let i = 0; i < 200; i++) await e.tickOnce('camp-1');

    const spread = Math.max(...Object.values(counts)) - Math.min(...Object.values(counts));
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(200);
    // Exactly even is what longest-idle-first produces here; allowing 1 keeps the
    // test about divergence rather than about an incidental tie-break.
    expect(spread).toBeLessThanOrEqual(1);
  });
});

describe('PacingEngine excludes non-available agents', () => {
  // Asserted here rather than in the wrap-up suite because THIS is
  // where the question is actually answered — the tick reads Redis, and a test in
  // the wrap-up file could only prove that file's own mock.
  it.each(['wrapup', 'break', 'on_call', 'reserved', 'offline'])(
    'never reserves an agent in `%s`',
    async (state) => {
      repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
      repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
      const agents = makeAgents({ s1: state });
      const { e, dispatch } = engine(makeStations(['s1']), agents, vi.fn());

      await e.tickOnce('camp-1');

      expect(agents.reserve).not.toHaveBeenCalled();
      expect(repos.contact.claimDialable).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it('counts only `available` agents toward the tick target', async () => {
    // Four agents, one available. Concurrency is 5, so a target derived from the
    // session count rather than the live Redis state would claim four contacts and
    // strand three of them in `in_flight` with nobody to dial them.
    repos.session.findLiveForCampaign.mockResolvedValue(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    );
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    const agents = makeAgents({ a: 'wrapup', b: 'break', c: 'available', d: 'on_call' });
    const { e } = engine(makeStations(['a', 'b', 'c', 'd']), agents, vi.fn());

    await e.tickOnce('camp-1');

    expect(repos.contact.claimDialable).toHaveBeenCalledWith('camp-1', 1);
    expect(agents.reserve.mock.calls.map((c: any[]) => c[0])).toEqual(['c']);
  });
});

// ---------------------------------------------------------------------------
// `dialing` is the one boolean an agent console drives its idle state from, so a
// `dialing: true` an agent cannot act on is the most expensive frame this engine
// sends: a real person sits watching a Running badge waiting for a call that is
// never placed.
//
// The engine holds TWO independent suppressions — `flagGated` (tenant kill switch)
// and `reportedStuck` (no usable caller IDs) — plus the status itself, and each
// suppression used to announce its own recovery without consulting the others.
// Every test below is a case where one condition cleared and another did not.
//
// They are asserted on the BROADCAST, never on the latch sets, because a latch in
// the right state that still emitted the wrong frame is precisely the bug.
// ---------------------------------------------------------------------------
describe('a resume frame can never claim dialing the engine will not do', () => {
  /** The stuck starting state: running, latched, agents already told `dialing: false`. */
  async function halted(stations: any) {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, caller_ids: [] });
    // Outstanding work, so `maybeFinalize` cannot transition the campaign and add
    // frames of its own — these assertions are about frame COUNTS.
    repos.campaign.countOutstanding.mockResolvedValue(1);
    const { e } = engine(stations, makeAgents({}));
    await e.tickOnce('camp-1');
    expect(stations.broadcast).toHaveBeenCalledTimes(1);
    expect((stations.broadcast.mock.calls[0]![1] as any).dialing).toBe(false);
    return e;
  }

  /** Every `dialing` value broadcast so far, in order. */
  function dialingFrames(stations: any): boolean[] {
    return stations.broadcast.mock.calls.map((c: any) => (c[1] as any).dialing);
  }

  it('does not tell a STOPPING campaign it resumed — it is draining, not dialing', async () => {
    // The empty-pool guard returns early only while `status === 'running'`, and a
    // `stopping` campaign is still led and still ticked at 4 Hz for the whole drain
    // (`findActive` returns running AND stopping). So the tick fell through to
    // `clearStuck`, which cleared the latch and announced `resumed`/`dialing: true`
    // — in the SAME tick that had just announced `stopped_by_supervisor`, and as the
    // last word the agents heard while the campaign wound down.
    const stations = makeStations(['s1']);
    const e = await halted(stations);

    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, status: 'stopping', caller_ids: [] });
    // A call still in flight, so the drain is not finished and `maybeFinalize` adds
    // no frames of its own — these assertions are about frame COUNTS. `halted`'s
    // outstanding-roster mock no longer does this job: `stopping` is drained on live
    // ATTEMPTS now, since the undialed roster of a stopped campaign is not work in
    // progress and used to strand the row in `stopping` forever.
    repos.attempt.countLive.mockResolvedValue(1);
    await e.tickOnce('camp-1');

    // The status change is announced; the resume is not.
    expect(stations.broadcast).toHaveBeenCalledTimes(2);
    expect((stations.broadcast.mock.calls[1]![1] as any).reason).toBe('stopped_by_supervisor');
    expect(dialingFrames(stations)).toEqual([false, false]);
  });

  it('does not tell a PAUSED campaign it resumed, however many ticks land before the pass', async () => {
    // A pause is only noticed by the supervise pass (0.5 Hz), so up to eight ticks
    // run against a `paused` row first — each of them skipping the guard and
    // reaching `clearStuck`.
    const stations = makeStations(['s1']);
    const e = await halted(stations);

    repos.campaign.findById.mockResolvedValue({
      ...CAMPAIGN, status: 'paused', caller_ids: [], pause_reason: 'supervisor', paused_at: new Date(),
    });
    await e.tickOnce('camp-1');
    await e.tickOnce('camp-1');
    await e.tickOnce('camp-1');

    expect((stations.broadcast.mock.calls[1]![1] as any).reason).toBe('paused_by_supervisor');
    // One status-change frame, no resume, and nothing claiming to dial.
    expect(stations.broadcast).toHaveBeenCalledTimes(2);
    expect(dialingFrames(stations)).toEqual([false, false]);
  });

  it('does not announce a flag recovery while the caller-ID halt still stands', async () => {
    // Both latches set, then only ONE clears. `campaignEnabled` announced
    // `dialing: true` on the strength of its own latch alone, and the next tick's
    // `noteMisconfigured` could not correct it — `reportedStuck` was still set, so
    // the report is a no-op. The console kept `dialing: true` indefinitely on a
    // campaign that places no calls, which is the exact shape of lie the halt frame
    // exists to prevent.
    const stations = makeStations(['s1']);
    repos.campaign.findActive.mockResolvedValue([{ ...CAMPAIGN, caller_ids: [] }]);
    const e = await halted(stations);

    // The tenant's dialer flag goes off, then comes back.
    flags.isEnabled.mockResolvedValue(false);
    await (e as any).superviseOnce();
    expect(stations.broadcast).toHaveBeenCalledTimes(2);
    flags.isEnabled.mockResolvedValue(true);
    await (e as any).superviseOnce();

    // Nothing new to say: the honest halt frame is still the last thing sent.
    expect(stations.broadcast).toHaveBeenCalledTimes(2);
    expect(dialingFrames(stations)).toEqual([false, false]);
    await e.stop();
  });

  it('announces the resume when the LAST condition clears, not the first', async () => {
    // The other half, and the reason suppressing the frame is not simply dropping
    // it: recovery is still reported, once, on the transition to actually-dialing.
    // Without this the fix would trade a false `dialing: true` for a permanent false
    // `dialing: false`, which strands the console just as badly.
    const stations = makeStations(['s1']);
    repos.campaign.findActive.mockResolvedValue([{ ...CAMPAIGN, caller_ids: [] }]);
    const e = await halted(stations);

    flags.isEnabled.mockResolvedValue(false);
    await (e as any).superviseOnce();
    flags.isEnabled.mockResolvedValue(true);
    await (e as any).superviseOnce();
    expect(stations.broadcast).toHaveBeenCalledTimes(2);

    // An operator adds a caller ID — now nothing is in the way.
    repos.campaign.findById.mockResolvedValue(CAMPAIGN);
    await e.tickOnce('camp-1');

    expect(stations.broadcast).toHaveBeenCalledTimes(3);
    const resumed = stations.broadcast.mock.calls[2]![1] as any;
    expect(resumed.reason).toBe('resumed');
    expect(resumed.dialing).toBe(true);
    // And steady state stays silent.
    await e.tickOnce('camp-1');
    expect(stations.broadcast).toHaveBeenCalledTimes(3);
    await e.stop();
  });

  it('clamps dialing:true at the broadcast, so a THIRD suppression cannot be forgotten', async () => {
    // ── The structural guarantee, asserted at the choke point ─────────────────
    //
    // The two bugs above were each a call site announcing recovery without knowing
    // about a latch it did not own. Cross-checking at every site fixes today's pair
    // and drifts the day a third suppression lands — which is how the second one got
    // here. So `announceCampaignState` derives the answer itself and clamps every
    // claim, including the status-derived default that no site passes explicitly.
    //
    // Driven directly, because the point is that it holds for ANY caller, not only
    // for the two that exist today: this is the assertion a future latch is checked
    // against.
    const stations = makeStations(['s1']);
    const e = await halted(stations);

    // A caller asking for the default (`isDialingStatus('running')` ⇒ true), and one
    // asking explicitly — neither may override a live suppression.
    (e as any).announceCampaignState({ ...CAMPAIGN, caller_ids: [] }, 'resumed');
    (e as any).announceCampaignState({ ...CAMPAIGN, caller_ids: [] }, 'started', { dialing: true });

    expect(stations.broadcast).toHaveBeenCalledTimes(3);
    expect(dialingFrames(stations)).toEqual([false, false, false]);
    // Suppression is only ever tightened — a caller that asked for `false` is not
    // second-guessed, and a healthy campaign is not clamped.
    (e as any).announceCampaignState(CAMPAIGN, 'started', { dialing: true });
    expect(dialingFrames(stations)).toEqual([false, false, false, false]);
    // Latch released on a campaign with a usable pool: `clearStuck` announces its
    // own recovery (the 5th frame), and an explicit claim is then honoured (the 6th)
    // — the clamp only ever subtracts, it never invents a `true`.
    (e as any).clearStuck(CAMPAIGN);
    (e as any).announceCampaignState(CAMPAIGN, 'started', { dialing: true });
    expect(dialingFrames(stations)).toEqual([false, false, false, false, true, true]);
  });
});

// ─── the reservation mirror that deliberately is not there ──────

describe('`reserved` is NOT mirrored to the durable row', () => {
  it('does not write the reservation to agency_agent_sessions', async () => {
    const states: Record<string, string> = { s1: 'available' };
    const agents = makeAgents(states);
    repos.session.findLiveForCampaign.mockResolvedValue([{ id: 's1' }]);
    repos.contact.claimDialable.mockResolvedValue([contact('c1')]);
    const { e } = engine(makeStations(['s1']), agents);

    await e.tickOnce('camp-1');

    // Pinning a DECISION, not an oversight. A mirror here would be write-only:
    // every release path in `dialUpTo` — surplus, suppress, defer, no station, the
    // duplicate-dial backstop, dispatch failure, abortRemainder — returns the agent
    // through Redis alone. An idle agent on a campaign with nothing dialable would
    // be reserved and released every 250ms tick while the supervisor's breakdown
    // showed them stuck at `reserved` indefinitely.
    //
    // Two further costs: `setState` restamps `state_since = now()`, which is the
    // anchor the risk ordering sorts on, and it is an awaited round trip per
    // reserved agent per tick on the dial path. `reserved` is a sub-second-to-15s
    // transient Redis owns; `on_call` IS mirrored, because `releaseAgent` mirrors
    // the return.
    expect(repos.session.setState).not.toHaveBeenCalledWith('s1', 'reserved');
  });
});
