// PORT NOTE (magick-agency, Phase 6): ported from core test/unit/agency/pacing-engine-gates.test.ts@4850d1d9 (22 → 22).
// Import/mock paths only, except ONE modified case (decision B8 — the scoped DNC check): 'only asks
// the DNC set once per contact' now asserts each `check` call carries `{ accountId: 'a1', campaignId:
// 'camp-1' }`, and the `check` stub declares the required `DncCheckScope` parameter. Mutation-checked:
// passing a null scope from `pre-dial-gates.ts` reds it. No case deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// AD-P3-C-05 + AD-P3-C-06 — the gates WHERE THEY ARE CONSUMED.
//
// §16.6 question 2, and the reason this file is separate from
// `pre-dial-gates.test.ts`: that file proves the decision table, which is worth
// nothing if the tick ignores it. Everything here is asserted against the writes
// the tick actually performs — `markState`, `unclaim`, `dispatch` — never against
// the decision the gate returned.
//
// The three things it exists to pin, in order of how badly they fail:
//
//  1. **A halt abandons the WHOLE claimed batch, not just the contact that
//     triggered it.** If the loop merely `continue`d, a Redis outage discovered on
//     contact 1 would dial contacts 2..N unchecked — fail-open at volume, which is
//     worse than having no gate at all, because it happens with a green health
//     check and at the exact moment nobody can check anything.
//  2. A deferral writes the **exact** next-window instant, strictly in the future.
//     `now()` re-claims the contact on the next tick and a campaign whose roster is
//     out of hours spins at 4 claims/second all night burning agent reservations.
//  3. A cleared dial carries a clearance bound to THAT contact, so the dispatcher's
//     guard has something true to check.
//
// The clock is faked, because `dialUpTo` calls `new Date()` itself and the
// deferral instants are exact values. Restored in `afterEach`.
// ---------------------------------------------------------------------------

// One STABLE child logger, not a fresh object per call. The module under test
// binds `createChildLogger(...)` once at import, so a factory returning a new
// object each time hands the assertions a spy the engine never wrote to — every
// `toHaveBeenCalled` would read 0 and pass as "no log emitted" no matter what the
// engine did. Hoisted so the skip-log assertions can reach it.
const { childLog } = vi.hoisted(() => ({
  childLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => childLog,
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
      markState: vi.fn().mockResolvedValue(undefined),
    },
    attempt: { countLive: vi.fn().mockResolvedValue(0), create: vi.fn(), setState: vi.fn().mockResolvedValue(null) },
    // `setState` mirrors the winning reservation durably (`AD-P4-C-01`) — the
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
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

import { PacingEngine } from '../../../src/agency/pacing-engine.js';
import type { DncCheck, DncCheckScope } from '../../../src/agency/dnc-registry.js';
import { rejectClearance } from '../../../src/agency/pre-dial-gates.js';

/** Tue 2026-08-11, 20:30 IST — the campaign below has just closed. */
const AFTER_HOURS_IST = new Date('2026-08-11T15:00:00Z');
/** Tue 2026-08-11, 10:30 IST — mid-window. */
const IN_HOURS_IST = new Date('2026-08-11T05:00:00Z');

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3', tenant_id: 't1', account_id: 'a1',
  status: 'running', caller_ids: ['+14155550100'],
  calling_window_start: '09:00:00', calling_window_end: '20:00:00',
  calling_days: [1, 2, 3, 4, 5], default_timezone: 'Asia/Kolkata',
} as never;

function contact(id: string, over: Record<string, unknown> = {}) {
  return {
    id, phone_e164: `+9198765432${id.slice(-2)}`, timezone: null,
    context: {}, attempt_count: 0, ...over,
  } as never;
}

function makeAgents(sessionIds: string[]) {
  return {
    get: vi.fn(async (id: string) => (sessionIds.includes(id)
      ? { state: 'available', attemptId: null, since: 1 } : null)),
    reserve: vi.fn(async (id: string) => (sessionIds.includes(id) ? 'reserved' : 'lost')),
    set: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStations(owned: string[]) {
  return {
    isLocallyOwned: vi.fn((id: string) => owned.includes(id)),
    ownerOf: vi.fn(async (id: string) => (owned.includes(id) ? 'r1' : null)),
    broadcast: vi.fn(() => owned.length),
    sessionIdsForCampaign: vi.fn(() => owned),
  };
}

function build(sessionIds: string[], dncAnswer: DncCheck | ((phone: string) => DncCheck) = 'clear') {
  // PORT NOTE (B8): the collapsed registry's `check` takes a REQUIRED scope, so the
  // stub declares it — the tick hands it `{ accountId, campaignId }` off the campaign.
  const check = vi.fn(async (_t: string, phone: string, _scope: DncCheckScope) =>
    (typeof dncAnswer === 'function' ? dncAnswer(phone) : dncAnswer));
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const agents = makeAgents(sessionIds);
  const engine = new PacingEngine(
    null, '', 'r1', makeStations(sessionIds) as never, agents as never,
    { dispatch } as never, { check } as never,
  );
  repos.session.findLiveForCampaign.mockResolvedValue(sessionIds.map((id) => ({ id })));
  return { engine, dispatch, agents, check };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  repos.campaign.findById.mockResolvedValue(CAMPAIGN);
  // Non-zero, so an idle tick does not finalize the campaign and confuse the
  // assertions with a `completed` transition.
  repos.campaign.countOutstanding.mockResolvedValue(1);
  repos.contact.claimDialable.mockResolvedValue([]);
  repos.attempt.countLive.mockResolvedValue(0);
  repos.attempt.create.mockImplementation(async (p: { contactId: string; callerId: string; attemptNumber: number }) => ({
    id: `att-${p.contactId}`, caller_id: p.callerId, attempt_number: p.attemptNumber,
  }));
  settings.getMaxConcurrentCalls.mockResolvedValue(5);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// A skipped contact leaves a trace.
//
// The gap this closes, found in staging: a campaign whose every contact deferred
// on `calling_hours` placed no calls, raised no error, and logged NOTHING — the
// agent sat on "waiting for a call" and the only evidence was a counter with no
// contact on it. Diagnosis required reading the campaign's window out of Postgres
// by hand.
//
// The assertions are on the FIELD NAMES, not merely on "a log happened", because
// the way this feature fails is silent in both directions: log nothing and the
// outage stays invisible, or log `phone_e164` and the customer's number reaches
// log storage in cleartext. Only `phone` is on the logger's redaction list.
// ---------------------------------------------------------------------------
describe('a skipped contact is logged', () => {
  /** The one `log.info` the skip path emits, or undefined. */
  function skipLine() {
    const call = childLog.info.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('pre-dial gate'),
    );
    return call?.[0] as Record<string, unknown> | undefined;
  }

  it('logs a deferred contact with the window that closed on it', async () => {
    vi.setSystemTime(AFTER_HOURS_IST);   // Tue 20:30 IST
    const { engine } = build(['s1']);
    repos.contact.claimDialable.mockResolvedValue([contact('c-01', { csv_line_number: 7 })]);

    await engine.tickOnce('camp-1');

    const line = skipLine();
    expect(line).toBeDefined();
    expect(line).toMatchObject({
      campaignId: 'camp-1',
      tenantId: 't1',
      contactId: 'c-01',
      gate: 'calling_hours',
      action: 'defer',
      csvLine: 7,
      // The answer to "why closed" on the line itself — without these the reader
      // has the verdict and still has to go find the evidence in the database.
      callingWindowStart: '09:00:00',
      callingWindowEnd: '20:00:00',
      callingDays: [1, 2, 3, 4, 5],
      campaignTimezone: 'Asia/Kolkata',
    });
    // Exact, and the same instant `unclaim` was given: a reader diffing the log
    // against the row must not find two different answers.
    expect(line!['deferUntil']).toBe('2026-08-12T03:30:00.000Z');
    expect(repos.contact.unclaim).toHaveBeenCalledWith('c-01', new Date(line!['deferUntil'] as string));
  });

  it('carries the number under `phone` — the key the logger actually redacts', async () => {
    vi.setSystemTime(AFTER_HOURS_IST);
    const { engine } = build(['s1']);
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

    await engine.tickOnce('camp-1');

    const line = skipLine()!;
    // `phone` is on REDACT_PATHS; `phone_e164` — the column's real name, and the
    // obvious thing to spread in — is NOT, and would ship the number in cleartext.
    // Pinned as an exact key check because the redaction happens downstream in
    // pino: nothing in this test's output would look wrong if it were mis-keyed.
    expect(Object.keys(line)).toContain('phone');
    expect(Object.keys(line)).not.toContain('phone_e164');
    expect(line['phone']).toBe('+919876543201');
  });

  it('logs a suppressed contact with its reason, and no window', async () => {
    // Mid-window, so nothing can defer — this contact leaves the roster on DNC.
    vi.setSystemTime(IN_HOURS_IST);
    const { engine } = build(['s1'], 'suppressed');
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

    await engine.tickOnce('camp-1');

    const line = skipLine();
    expect(line).toMatchObject({ contactId: 'c-01', gate: 'dnc', action: 'suppress', suppressedReason: 'dnc' });
    // The window is irrelevant to a DNC hit and would be noise on every such line.
    expect(line).not.toHaveProperty('callingWindowStart');
    expect(line).not.toHaveProperty('deferUntil');
  });

  it('stays silent when the contact clears — the log marks skips, not dials', async () => {
    vi.setSystemTime(IN_HOURS_IST);
    const { engine, dispatch } = build(['s1']);
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

    await engine.tickOnce('camp-1');

    // Asserted alongside the dial, so this cannot pass by the tick doing nothing.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(skipLine()).toBeUndefined();
  });
});

describe('a cleared contact dials, with a clearance the dispatcher will accept', () => {
  it('dispatches carrying a clearance bound to that contact', async () => {
    vi.setSystemTime(IN_HOURS_IST);
    const { engine, dispatch } = build(['s1']);
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

    await engine.tickOnce('camp-1');

    expect(dispatch).toHaveBeenCalledTimes(1);
    const cmd = dispatch.mock.calls[0]![0] as { contactId: string; clearance: never };
    expect(cmd.contactId).toBe('c-01');
    // Asserted through the dispatcher's own validator rather than by reading the
    // fields: if the token the tick mints would not satisfy the guard, the guard
    // is theatre and this is the only place the two meet.
    expect(rejectClearance(cmd.clearance, 'c-01', new Date())).toBeNull();
  });
});

describe('DNC', () => {
  it('suppresses a listed number, dials nothing, and creates no attempt', async () => {
    vi.setSystemTime(IN_HOURS_IST);
    const { engine, dispatch, agents } = build(['s1'], 'suppressed');
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

    await engine.tickOnce('camp-1');

    expect(dispatch).not.toHaveBeenCalled();
    // Before the attempt exists, so there is no attempt row to unwind — and no
    // dial attempt is billed for a call we declined to place.
    expect(repos.attempt.create).not.toHaveBeenCalled();
    expect(repos.contact.markState).toHaveBeenCalledWith('c-01', 'suppressed', {
      suppressed_reason: 'dnc',
    });
    // Not `unclaim`: a DNC hit never returns to `pending` (§4.2).
    expect(repos.contact.unclaim).not.toHaveBeenCalled();
    // The agent is not punished for the roster's contents.
    expect(agents.set).toHaveBeenCalledWith('s1', 'available', expect.anything());
  });

  it('does not bump the contact attempt count for a call it declined to place', async () => {
    vi.setSystemTime(IN_HOURS_IST);
    const { engine } = build(['s1'], 'suppressed');
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

    await engine.tickOnce('camp-1');

    // `attempt_count` is the retry budget and nothing else. Charging it here would
    // exhaust a contact who was never called — the same defect class as
    // `AD-P2-C-12`, from the other direction.
    expect(repos.contact.markState).toHaveBeenCalledWith('c-01', 'suppressed',
      expect.not.objectContaining({ bump_attempt: true }));
  });

  it('HALTS the whole claimed batch when the registry cannot answer', async () => {
    // THE assertion for this ticket. Three agents, three contacts, and the very
    // first DNC check comes back `unavailable`. If the loop merely skipped the
    // contact it could not check, contacts 2 and 3 would be dialed unchecked —
    // fail-open at volume, with a green health check, at the exact moment nobody
    // can verify anything.
    vi.setSystemTime(IN_HOURS_IST);
    const { engine, dispatch, agents } = build(['s1', 's2', 's3'], 'unavailable');
    const claimed = [contact('c-01'), contact('c-02'), contact('c-03')];
    repos.contact.claimDialable.mockResolvedValue(claimed);

    await engine.tickOnce('camp-1');

    expect(dispatch).not.toHaveBeenCalled();
    expect(repos.attempt.create).not.toHaveBeenCalled();
    // Every claimed contact goes back, not just the one that tripped the gate.
    expect(repos.contact.unclaim.mock.calls.map((c) => c[0]).sort())
      .toEqual(['c-01', 'c-02', 'c-03']);
    // And every reserved agent is released, or the pool shrinks by three every
    // tick until their leases lapse.
    for (const s of ['s1', 's2', 's3']) {
      expect(agents.set).toHaveBeenCalledWith(s, 'available', expect.anything());
    }
    // Nothing is suppressed: the numbers are not on the list, we simply could not
    // ask. Writing them off would be a data loss caused by an outage.
    expect(repos.contact.markState).not.toHaveBeenCalled();
  });

  it('refuses the contacts it had NOT yet checked, even when they would have cleared', async () => {
    // ── FOUND BY A FALSIFICATION THAT CAME BACK GREEN. ──────────────────────
    //
    // Replacing the halt's `return` with a per-contact abort-and-`continue` left
    // every other case in this file passing, because when the registry answers
    // `unavailable` for EVERY contact the two behaviours converge: each contact
    // aborts itself and nothing is dialed either way. The distinguishing case is
    // this one — the registry fails on the first read and then answers `clear` —
    // and under the falsifier contacts 2 and 3 are DIALED.
    //
    // A single read timing out is the most ordinary Redis failure there is, so this
    // is not a contrived shape. And a `clear` from a registry that just failed is
    // not evidence: "if the DNC set cannot be read, do not dial" is the whole
    // ticket, and it does not have an exception for the next read looking fine.
    vi.setSystemTime(IN_HOURS_IST);
    let calls = 0;
    const { engine, dispatch } = build(['s1', 's2', 's3'], () => (++calls === 1 ? 'unavailable' : 'clear'));
    repos.contact.claimDialable.mockResolvedValue([contact('c-01'), contact('c-02'), contact('c-03')]);

    await engine.tickOnce('camp-1');

    expect(dispatch).not.toHaveBeenCalled();
    // Only ONE read happened: the tick stopped asking, rather than asking and
    // then trusting the answers.
    expect(calls).toBe(1);
    expect(repos.contact.unclaim.mock.calls.map((c) => c[0]).sort())
      .toEqual(['c-01', 'c-02', 'c-03']);
  });

  it('stops mid-batch without undoing the dials it had already placed', async () => {
    // A registry that answers for the first contact and then fails. The two facts
    // that must both hold: the first call was checked and stands, and the rest of
    // the batch is abandoned rather than dialed.
    vi.setSystemTime(IN_HOURS_IST);
    let calls = 0;
    const { engine, dispatch } = build(['s1', 's2', 's3'], () => (++calls === 1 ? 'clear' : 'unavailable'));
    repos.contact.claimDialable.mockResolvedValue([contact('c-01'), contact('c-02'), contact('c-03')]);

    await engine.tickOnce('camp-1');

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as { contactId: string }).contactId).toBe('c-01');
    expect(repos.contact.unclaim.mock.calls.map((c) => c[0]).sort()).toEqual(['c-02', 'c-03']);
  });

  it('only asks the DNC set once per contact', async () => {
    // A second read would be a second answer, and the two could differ — which is
    // the whole reason the clearance is a token rather than a re-check.
    vi.setSystemTime(IN_HOURS_IST);
    const { engine, check } = build(['s1', 's2']);
    repos.contact.claimDialable.mockResolvedValue([contact('c-01'), contact('c-02')]);

    await engine.tickOnce('camp-1');

    expect(check).toHaveBeenCalledTimes(2);
    // PORT NOTE (B8): each check now also names the campaign's account and the
    // campaign, so an account- or campaign-scoped `dnc_entries` row stops the dial.
    expect(check).toHaveBeenCalledWith('t1', '+919876543201', { accountId: 'a1', campaignId: 'camp-1' });
    expect(check).toHaveBeenCalledWith('t1', '+919876543202', { accountId: 'a1', campaignId: 'camp-1' });
  });
});

describe('calling hours', () => {
  it('unclaims to the EXACT next window open, in the contact timezone', async () => {
    vi.setSystemTime(AFTER_HOURS_IST);   // Tue 20:30 IST
    const { engine, dispatch } = build(['s1']);
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

    await engine.tickOnce('camp-1');

    expect(dispatch).not.toHaveBeenCalled();
    expect(repos.attempt.create).not.toHaveBeenCalled();
    // Wed 09:00 IST. Exact, because "later" is satisfied by now()+1ms and the whole
    // point of the rule is that the contact is not re-claimed next tick.
    expect(repos.contact.unclaim).toHaveBeenCalledWith('c-01', new Date('2026-08-12T03:30:00.000Z'));
  });

  it('honours the contact timezone over the campaign default', async () => {
    // 10:30 IST is 01:00 in New York. The campaign is mid-window and this customer
    // is asleep, so the deferral is to 09:00 EDT the same day — eight hours on,
    // not the campaign's own next opening.
    vi.setSystemTime(IN_HOURS_IST);
    const { engine, dispatch } = build(['s1']);
    repos.contact.claimDialable.mockResolvedValue([contact('c-01', { timezone: 'America/New_York' })]);

    await engine.tickOnce('camp-1');

    expect(dispatch).not.toHaveBeenCalled();
    expect(repos.contact.unclaim).toHaveBeenCalledWith('c-01', new Date('2026-08-11T13:00:00.000Z'));
  });

  it('never returns an out-of-hours contact at now, however the window is broken', async () => {
    // The invariant, over every way the window can refuse: a contact returned at
    // `now()` satisfies `state='pending' AND next_attempt_at <= now()` immediately,
    // and the campaign spins at 4 claims/second all night on calls it will never
    // place (§4.2).
    for (const campaign of [
      CAMPAIGN,                                                       // simply closed
      { ...(CAMPAIGN as object), default_timezone: 'Not/AZone' },      // unreadable zone
      { ...(CAMPAIGN as object), calling_days: [] },                   // no dialable day
      { ...(CAMPAIGN as object), calling_window_end: '09:00:00' },     // empty window
    ]) {
      vi.clearAllMocks();
      vi.setSystemTime(AFTER_HOURS_IST);
      repos.campaign.findById.mockResolvedValue(campaign as never);
      repos.campaign.countOutstanding.mockResolvedValue(1);
      repos.attempt.countLive.mockResolvedValue(0);
      settings.getMaxConcurrentCalls.mockResolvedValue(5);
      const { engine, dispatch } = build(['s1']);
      repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

      await engine.tickOnce('camp-1');

      expect(dispatch).not.toHaveBeenCalled();
      expect(repos.contact.unclaim).toHaveBeenCalledTimes(1);
      const [, when] = repos.contact.unclaim.mock.calls[0] as [string, Date];
      expect(when.getTime()).toBeGreaterThan(AFTER_HOURS_IST.getTime());
    }
  });

  it('does not consult the DNC set for a contact it is not going to dial', async () => {
    // Ordering, where it is consumed: with DNC first, a campaign that is out of
    // hours would HALT on a Redis outage instead of deferring cleanly, and a
    // compliance alert would fire for what is really just "it is 8:30pm".
    vi.setSystemTime(AFTER_HOURS_IST);
    const { engine, check } = build(['s1'], 'unavailable');
    repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

    await engine.tickOnce('camp-1');

    expect(check).not.toHaveBeenCalled();
    expect(repos.contact.unclaim).toHaveBeenCalledTimes(1);
  });
});

describe('telemetry cannot break dialling', () => {
  it('dials even when the gate counter throws', async () => {
    // `evaluatePreDialGates` is written to be total so a compliance failure cannot
    // abort a tick with agents reserved and contacts claimed. The counter call sits
    // on the very NEXT line and was unguarded, so a label-set mismatch or a
    // duplicate registry entry could do exactly that damage — and it would present
    // as a pacing bug, not a metrics one.
    //
    // Asserted through the real counter rather than a mock: `inc` is stubbed to
    // throw, and the dial must still happen.
    vi.setSystemTime(IN_HOURS_IST);
    const metrics = await import('@magick-agency/observability/metrics/agency');
    const { resetSafeEmitLatches } = await import('../../../src/utils/safe-emit.js');
    resetSafeEmitLatches();
    const spy = vi.spyOn(metrics.agencyPreDialGateTotal, 'inc').mockImplementation(() => {
      throw new Error('Invalid label value: undefined');
    });

    try {
      const { engine, dispatch } = build(['s1']);
      repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

      await engine.tickOnce('camp-1');

      expect(spy).toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      resetSafeEmitLatches();
    }
  });

  it('still suppresses a DNC hit when the counter throws', async () => {
    // The other direction: a metrics fault must not turn a refusal into a dial
    // either, and must not lose the contact write that records the refusal.
    vi.setSystemTime(IN_HOURS_IST);
    const metrics = await import('@magick-agency/observability/metrics/agency');
    const { resetSafeEmitLatches } = await import('../../../src/utils/safe-emit.js');
    resetSafeEmitLatches();
    const spy = vi.spyOn(metrics.agencyPreDialGateTotal, 'inc').mockImplementation(() => {
      throw new Error('A metric with the name agency_predial_gate_total has already been registered');
    });

    try {
      const { engine, dispatch } = build(['s1'], 'suppressed');
      repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

      await engine.tickOnce('camp-1');

      expect(dispatch).not.toHaveBeenCalled();
      expect(repos.contact.markState).toHaveBeenCalledWith('c-01', 'suppressed', {
        suppressed_reason: 'dnc',
      });
    } finally {
      spy.mockRestore();
      resetSafeEmitLatches();
    }
  });
});

describe('an unusable phone number leaves the roster', () => {
  it('is suppressed invalid rather than deferred, even out of hours', async () => {
    // A row that can never be dialed must not be deferred to the next window every
    // night for the life of the campaign.
    vi.setSystemTime(AFTER_HOURS_IST);
    const { engine, dispatch, check } = build(['s1']);
    repos.contact.claimDialable.mockResolvedValue([contact('c-01', { phone_e164: 'not-a-number' })]);

    await engine.tickOnce('camp-1');

    expect(dispatch).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(repos.contact.markState).toHaveBeenCalledWith('c-01', 'suppressed', {
      suppressed_reason: 'invalid',
    });
    expect(repos.contact.unclaim).not.toHaveBeenCalled();
  });

  it('does not halt the campaign for one bad row', async () => {
    // The distinction `unverifiable` exists for: the second contact still dials.
    vi.setSystemTime(IN_HOURS_IST);
    const { engine, dispatch } = build(['s1', 's2']);
    repos.contact.claimDialable.mockResolvedValue([
      contact('c-01', { phone_e164: '' }),
      contact('c-02'),
    ]);

    await engine.tickOnce('camp-1');

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as { contactId: string }).contactId).toBe('c-02');
  });
});

// ---------------------------------------------------------------------------
// MAG-109 — the gate counter has to reach the pipeline that can alert on it.
//
// `agency_predial_gate_total` once existed twice: a prom-client counter that was
// incremented, and an OTel counter that had ZERO callers. Grafana Cloud is fed by
// OTLP, so the series an operator would alert on was the one nobody wrote to —
// byte-for-byte the `gemini_backend_breaker_open` defect. There is now one
// instrument (an OTel counter behind the `counter()` facade, which also feeds the
// `:9090` scrape), so the pin is that the tick writes it, once, with the labels.
//
// Asserted against the metric export itself rather than against "recordGate was
// called", because the failure being pinned is a call that never reaches it.
// ---------------------------------------------------------------------------
describe('MAG-109 — the pre-dial gate reaches the OTLP pipeline', () => {
  it('writes the counter once, with its labels, when a contact clears', async () => {
    vi.setSystemTime(IN_HOURS_IST);
    const metrics = await import('@magick-agency/observability/metrics/agency');
    const inc = vi.spyOn(metrics.agencyPreDialGateTotal, 'inc');

    try {
      const { engine, dispatch } = build(['s1']);
      repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

      await engine.tickOnce('camp-1');

      // The dial is asserted first so a tick that silently did nothing cannot
      // satisfy this test by emitting nothing.
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(inc.mock.calls).toEqual([[{ campaign_id: 'camp-1', gate: 'cleared', action: 'dial' }]]);
    } finally {
      inc.mockRestore();
    }
  });

  it('emits gate="dnc_unavailable" — the only signal that separates a compliance halt from a bug', async () => {
    vi.setSystemTime(IN_HOURS_IST);
    const metrics = await import('@magick-agency/observability/metrics/agency');
    const inc = vi.spyOn(metrics.agencyPreDialGateTotal, 'inc');

    try {
      const { engine, dispatch } = build(['s1'], 'unavailable');
      repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

      await engine.tickOnce('camp-1');

      expect(dispatch).not.toHaveBeenCalled();
      expect(inc).toHaveBeenCalledWith({
        campaign_id: 'camp-1', gate: 'dnc_unavailable', action: 'halt',
      });
    } finally {
      inc.mockRestore();
    }
  });

  it('a throwing counter write does not turn a refusal into a dial', async () => {
    // The mirror of `dials even when the gate counter throws`: `recordGate` is
    // guarded by `safeEmit`, so a throw from the write is swallowed — and the
    // tick must still refuse the number it was refusing.
    vi.setSystemTime(IN_HOURS_IST);
    const metrics = await import('@magick-agency/observability/metrics/agency');
    const { resetSafeEmitLatches } = await import('../../../src/utils/safe-emit.js');
    resetSafeEmitLatches();
    const inc = vi.spyOn(metrics.agencyPreDialGateTotal, 'inc').mockImplementation(() => {
      throw new Error('exporter fault');
    });

    try {
      const { engine, dispatch } = build(['s1'], 'suppressed');
      repos.contact.claimDialable.mockResolvedValue([contact('c-01')]);

      await engine.tickOnce('camp-1');

      expect(inc).toHaveBeenCalledWith({ campaign_id: 'camp-1', gate: 'dnc', action: 'suppress' });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      inc.mockRestore();
      resetSafeEmitLatches();
    }
  });
});
