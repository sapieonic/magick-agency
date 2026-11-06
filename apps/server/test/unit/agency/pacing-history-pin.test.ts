import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The pacing history and the pacing metrics, PINNED TOGETHER (IN2).
//
// The history (`agency_campaign_pacing_minutes`) is counted next to `agency_tick_idle_total`
// and `agency_predial_gate_total`, in `recordIdle` and `recordGate`. If a later change adds an
// idle path or a gate that increments the metric and not the history (or the other way round),
// the insights page and Grafana silently disagree about why a campaign did not dial. So every
// scenario below drives the REAL engine into one idle reason or gate decision, and the same
// assertion runs after each: every metric increment, grouped by its label, equals the history's
// count of the column that label maps to. A scenario per reason and per gate, so none is pinned
// only vacuously.
//
// Also: running ticks and outside-hours ticks (the stall rule's denominator), the skipped tick's
// replay, dials placed, and a throwing metric not costing the history its count.
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
  settings: { getMaxConcurrentCalls: vi.fn().mockResolvedValue(5) },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAttemptRepository: repos.attempt,
  agencyAgentSessionRepository: repos.session,
  // No dedicated caller IDs (DN1): every contact dials from the rotation, the whole pool.
  agencyAgentCallerIdRepository: { mapForCampaign: async () => new Map() },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: settings,
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

import * as metrics from '@magick-agency/observability/metrics/agency';
import { PacingEngine, gateHistoryField } from '../../../src/agency/pacing-engine.js';
import { PacingHistoryAccumulator } from '../../../src/agency/pacing/pacing-history.js';
import { PACING_IDLE_FIELD, type PacingHistoryField } from '../../../src/agency/pacing/pacing-history-fields.js';
import { InProcessPacingInvalidationBus } from '../../../src/agency/pacing/invalidation-bus.js';
import { AGENCY_PACING_IDLE_REASONS } from '@magick-agency/contracts/api/agency/insights';
import type { DncCheck } from '../../../src/agency/dnc-registry.js';
import { resetSafeEmitLatches } from '../../../src/utils/safe-emit.js';

/** Tue 2026-08-11 10:30 IST (05:00 UTC): inside a 09:00–20:00 Mon–Fri Kolkata window. */
const IN_HOURS = new Date('2026-08-11T05:00:00Z');
/** Tue 2026-08-11 20:30 IST: after it closed. */
const AFTER_HOURS = new Date('2026-08-11T15:00:00Z');

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3', tenant_id: 't1', account_id: 'a1',
  status: 'running', caller_ids: ['+14155550100'],
  calling_window_start: '09:00:00', calling_window_end: '20:00:00',
  calling_days: [1, 2, 3, 4, 5], default_timezone: 'Asia/Kolkata',
  pause_reason: null, paused_at: null, pause_abandonment_rate_pct: null, abandonment_ceiling_pct: 3,
  disposition_catalog: [], assignment_mode: 'pool',
} as any;

function contact(id: string, over: Record<string, unknown> = {}) {
  return { id, phone_e164: `+9198765432${id.slice(-2)}`, timezone: null, context: {}, attempt_count: 0, ...over } as any;
}

function makeAgents(available: string[], reserve: 'reserved' | 'lost' = 'reserved') {
  const get = vi.fn(async (id: string) => (available.includes(id) ? { state: 'available', attemptId: null, since: 1 } : null));
  return {
    get,
    getMany: vi.fn(async (ids: readonly string[]) => Promise.all(ids.map((id) => get(id)))),
    reserve: vi.fn(async () => reserve),
    set: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStations(owned: string[]) {
  return {
    isLocallyOwned: vi.fn((id: string) => owned.includes(id)),
    ownerOf: vi.fn(async (id: string) => (owned.includes(id) ? 'r1' : null)),
    broadcast: vi.fn(() => owned.length),
    send: vi.fn(() => true),
    get: vi.fn((id: string) => (owned.includes(id) ? { campaignId: 'camp-1' } : undefined)),
  };
}

function rig(opts: { sessions?: string[]; reserve?: 'reserved' | 'lost'; dnc?: DncCheck } = {}) {
  const sessions = opts.sessions ?? ['s1'];
  repos.session.findLiveForCampaign.mockResolvedValue(sessions.map((id, i) => ({ id, agent_user_id: `u${i + 1}` })));
  const history = new PacingHistoryAccumulator({ sink: { upsertMinutes: vi.fn().mockResolvedValue(0) } });
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const clock = { t: 1_000_000 };
  const engine = new PacingEngine(
    null, '', 'r1', makeStations(sessions) as never, makeAgents(sessions, opts.reserve) as never,
    { dispatch } as never, { check: vi.fn(async () => opts.dnc ?? 'clear') } as never,
    { history, bus: new InProcessPacingInvalidationBus(), now: () => clock.t },
  );
  engine.setAutoRounds(false);
  return { engine, history, dispatch, clock };
}

let idleInc: ReturnType<typeof vi.spyOn>;
let gateInc: ReturnType<typeof vi.spyOn>;

/**
 * THE PIN: every `agency_tick_idle_total` increment maps to the same count of its column, and
 * every non-`dial` `agency_predial_gate_total` decision to its column, and nothing else is in
 * those columns. Returns the history's counts so a scenario can assert which column it hit.
 */
function expectMetricAndHistoryAgree(history: PacingHistoryAccumulator): Partial<Record<PacingHistoryField, number>> {
  const got = history.peek('camp-1');
  const expected: Partial<Record<PacingHistoryField, number>> = {};
  for (const call of idleInc.mock.calls) {
    const field = PACING_IDLE_FIELD[(call[0] as { reason: keyof typeof PACING_IDLE_FIELD }).reason];
    expected[field] = (expected[field] ?? 0) + 1;
  }
  for (const call of gateInc.mock.calls) {
    const { gate, action } = call[0] as { gate: string; action: string };
    if (action === 'dial') continue;
    const field = gateFieldOfLabels(gate, action);
    expected[field] = (expected[field] ?? 0) + 1;
  }
  const historyFields = Object.fromEntries(Object.entries(got).filter(([f]) =>
    f.startsWith('idle_') || ['calling_hours_deferrals', 'dnc_unavailable_halts', 'predial_dnc_suppressed', 'predial_invalid_suppressed'].includes(f)));
  expect(historyFields).toEqual(expected);
  return got;
}

/** The metric's labels → the column, written out independently of the engine's mapping. */
function gateFieldOfLabels(gate: string, action: string): PacingHistoryField {
  if (action === 'halt') return 'dnc_unavailable_halts';
  if (action === 'defer') return 'calling_hours_deferrals';
  if (action === 'suppress' && gate === 'dnc') return 'predial_dnc_suppressed';
  if (action === 'suppress' && gate === 'phone_invalid') return 'predial_invalid_suppressed';
  throw new Error(`unmapped gate ${gate}/${action}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(IN_HOURS);
  resetSafeEmitLatches();
  repos.campaign.findById.mockResolvedValue(CAMPAIGN);
  repos.campaign.countOutstanding.mockResolvedValue(1);
  repos.contact.claimDialable.mockResolvedValue([]);
  repos.attempt.countLiveForAccount.mockResolvedValue(0);
  repos.attempt.create.mockImplementation(async (p: { contactId: string; callerId: string }) => ({
    id: `att-${p.contactId}`, caller_id: p.callerId, attempt_number: 1, agent_reopened: false,
  }));
  settings.getMaxConcurrentCalls.mockResolvedValue(5);
  idleInc = vi.spyOn(metrics.agencyTickIdleTotal, 'inc');
  gateInc = vi.spyOn(metrics.agencyPreDialGateTotal, 'inc');
});

afterEach(() => {
  idleInc.mockRestore();
  gateInc.mockRestore();
  vi.useRealTimers();
});

describe('every idle reason counts into its pacing history column, with its metric', () => {
  const scenarios: Record<(typeof AGENCY_PACING_IDLE_REASONS)[number], () => ReturnType<typeof rig>> = {
    no_agents: () => rig({ sessions: [] }),
    no_slots: () => {
      settings.getMaxConcurrentCalls.mockResolvedValue(1);
      repos.attempt.countLiveForAccount.mockResolvedValue(4);
      return rig();
    },
    no_contacts: () => rig(),
    no_reservations: () => rig({ reserve: 'lost' }),
    no_caller_ids: () => {
      repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, caller_ids: [''] });
      return rig();
    },
    nothing_due: () => {
      repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, assignment_mode: 'strict' });
      repos.contact.probeAgentQueues.mockResolvedValue({
        agents: [{ agentUserId: 'u1', ownDue: false, ownNextAt: new Date(Date.now() + 3_600_000), ownHasNonCallback: true }],
        pool: null,
      });
      return rig();
    },
  };

  for (const reason of AGENCY_PACING_IDLE_REASONS) {
    it(reason, async () => {
      const { engine, history } = scenarios[reason]();
      await engine.tickOnce('camp-1');
      expect(idleInc).toHaveBeenCalledWith(expect.objectContaining({ reason }));
      const got = expectMetricAndHistoryAgree(history);
      expect(got[PACING_IDLE_FIELD[reason]]).toBe(1);
      expect(got.ticks).toBe(1);
    });
  }
});

describe('every gate decision counts into its pacing history column, with its metric', () => {
  it('a DNC hit: predial_dnc_suppressed', async () => {
    const { engine, history } = rig({ dnc: 'suppressed' });
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);
    await engine.tickOnce('camp-1');
    expect(expectMetricAndHistoryAgree(history).predial_dnc_suppressed).toBe(1);
  });

  it('an unusable number: predial_invalid_suppressed', async () => {
    const { engine, history } = rig();
    repos.contact.claimDialable.mockResolvedValue([contact('c-01', { phone_e164: 'not-a-number' })]);
    await engine.tickOnce('camp-1');
    expect(expectMetricAndHistoryAgree(history).predial_invalid_suppressed).toBe(1);
  });

  it('outside calling hours: calling_hours_deferrals', async () => {
    vi.setSystemTime(AFTER_HOURS);
    const { engine, history } = rig();
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);
    await engine.tickOnce('camp-1');
    expect(expectMetricAndHistoryAgree(history).calling_hours_deferrals).toBe(1);
  });

  it('an unresolvable calling window: calling_hours_deferrals', async () => {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, default_timezone: 'Not/AZone' });
    const { engine, history } = rig();
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);
    await engine.tickOnce('camp-1');
    expect(gateInc).toHaveBeenCalledWith(expect.objectContaining({ gate: 'calling_hours_unresolvable', action: 'defer' }));
    expect(expectMetricAndHistoryAgree(history).calling_hours_deferrals).toBe(1);
  });

  it('the DNC registry unavailable: dnc_unavailable_halts, once for the halted batch', async () => {
    const { engine, history } = rig({ sessions: ['s1', 's2'], dnc: 'unavailable' });
    repos.contact.claimDialable.mockResolvedValue([contact('c-01'), contact('c-02')]);
    await engine.tickOnce('camp-1');
    expect(expectMetricAndHistoryAgree(history).dnc_unavailable_halts).toBe(1);
  });

  it('a cleared dial counts nothing among the gates, and one dial placed once dispatched', async () => {
    const { engine, history, dispatch } = rig();
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);
    await engine.tickOnce('camp-1');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(expectMetricAndHistoryAgree(history)).toEqual({ ticks: 1, dials_placed: 1 });
  });

  it('a dispatch that throws is not a dial placed', async () => {
    const { engine, history, dispatch } = rig();
    dispatch.mockRejectedValueOnce(new Error('dialer refused'));
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);
    await engine.tickOnce('camp-1');
    expect(history.peek('camp-1').dials_placed).toBeUndefined();
  });

  it('gateHistoryField maps every non-dial decision (the engine\'s own table)', () => {
    expect(gateHistoryField({ action: 'suppress', gate: 'dnc', suppressedReason: 'dnc' })).toBe('predial_dnc_suppressed');
    expect(gateHistoryField({ action: 'suppress', gate: 'phone_invalid', suppressedReason: 'invalid' })).toBe('predial_invalid_suppressed');
    expect(gateHistoryField({ action: 'defer', gate: 'calling_hours', deferUntil: new Date() })).toBe('calling_hours_deferrals');
    expect(gateHistoryField({ action: 'halt', gate: 'dnc_unavailable' })).toBe('dnc_unavailable_halts');
    expect(gateHistoryField({ action: 'dial', clearance: {} as never })).toBeNull();
  });
});

describe('ticks: the stall rule\'s denominator', () => {
  it('a skipped tick replays its idle reason into both, and counts a running tick', async () => {
    const { engine, history, clock } = rig({ sessions: [] });
    (engine as any).beginLeading(CAMPAIGN);
    await engine.runRound(); // full: no_agents, quiescent
    clock.t += 250;
    await engine.runRound(); // skipped: replayed
    clock.t += 250;
    await engine.runRound();
    expect(idleInc).toHaveBeenCalledTimes(3);
    expect(expectMetricAndHistoryAgree(history)).toMatchObject({ ticks: 3, idle_no_agents: 3 });
    await engine.stop();
  });

  it('counts outside_hours_ticks while the campaign\'s own window is closed, decided per minute', async () => {
    vi.setSystemTime(AFTER_HOURS);
    const { engine, history } = rig({ sessions: [] });
    await engine.tickOnce('camp-1');
    await engine.tickOnce('camp-1');
    expect(history.peek('camp-1')).toMatchObject({ ticks: 2, outside_hours_ticks: 2, idle_no_agents: 2 });
    vi.setSystemTime(IN_HOURS);
    await engine.tickOnce('camp-1');
    expect(history.peek('camp-1').outside_hours_ticks).toBe(2);
    expect(history.peek('camp-1').ticks).toBe(3);
  });

  it('a paused campaign ticks without counting: it is not stalled, it is paused', async () => {
    repos.campaign.findById.mockResolvedValue({ ...CAMPAIGN, status: 'paused' });
    const { engine, history } = rig();
    await engine.tickOnce('camp-1');
    expect(history.peek('camp-1')).toEqual({});
  });
});

describe('telemetry faults stay apart', () => {
  it('a throwing idle metric does not cost the history its count', async () => {
    idleInc.mockImplementation(() => { throw new Error('exporter fault'); });
    const { engine, history } = rig({ sessions: [] });
    await engine.tickOnce('camp-1');
    expect(history.peek('camp-1').idle_no_agents).toBe(1);
  });

  it('a throwing gate metric does not cost the history its count, and the refusal still lands', async () => {
    gateInc.mockImplementation(() => { throw new Error('exporter fault'); });
    const { engine, history } = rig({ dnc: 'suppressed' });
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);
    await engine.tickOnce('camp-1');
    expect(history.peek('camp-1').predial_dnc_suppressed).toBe(1);
    expect(repos.contact.markState).toHaveBeenCalledWith('c-01', 'suppressed', { suppressed_reason: 'dnc' });
  });
});

describe('the engine flushes the history', () => {
  it('when it gives a campaign up, and on halt', async () => {
    const sinkRows: unknown[] = [];
    const history = new PacingHistoryAccumulator({ sink: { upsertMinutes: vi.fn(async (rows) => { sinkRows.push(...rows); }) } });
    repos.session.findLiveForCampaign.mockResolvedValue([]);
    const engine = new PacingEngine(
      null, '', 'r1', makeStations([]) as never, makeAgents([]) as never, { dispatch: vi.fn() } as never,
      { check: vi.fn() } as never, { history, bus: new InProcessPacingInvalidationBus() },
    );
    engine.setAutoRounds(false);
    const flush = vi.spyOn(history, 'flush');
    (engine as any).beginLeading(CAMPAIGN);
    await engine.runRound();
    await (engine as any).relinquish('camp-1');
    expect(flush).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(sinkRows).toHaveLength(1));
    const close = vi.spyOn(history, 'close');
    await engine.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
