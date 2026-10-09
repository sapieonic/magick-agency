import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_DISPOSITIONS,
  BUILT_IN_DISPOSITION_CODES,
  builtInSemanticMismatches,
  resolveDispositionDecision,
} from '../../../src/agency/disposition-policy.js';
import { DEFAULT_RETRY_POLICY, resolveRetryDecision } from '../../../src/agency/retry-policy.js';
import type { AgencyAttemptOutcome, AgencyDisposition } from '@magick-agency/contracts/agency';

// ---------------------------------------------------------------------------
// Disposition semantics. The precedence rule, and the three
// named codes.
//
// Pure module, so no harness: a clock is injected and there is no I/O to double.
// Every expected instant is computed from the injected `now` rather than read off
// a run (anything clock-derived is asserted to exact values).
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-11T10:00:00.000Z');
/** `now` + n minutes, as the exact instant the policy should produce. */
const plus = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

function entry(over: Partial<AgencyDisposition> = {}): AgencyDisposition {
  return { code: 'x', label: 'X', ...over };
}

const D = (e: AgencyDisposition, over: Partial<{ attemptsUsed: number; callbackAt: Date | null }> = {}) =>
  resolveDispositionDecision(e, { now: NOW, attemptsUsed: 0, callbackAt: null, ...over });

// ═══════════════════════════════════════════════════════════════════════════
// The precedence, arm by arm, and in the order that makes the ordering itself
// the property under test.
// ═══════════════════════════════════════════════════════════════════════════

describe('suppress > terminal > callback > retry', () => {
  it('suppress sends the contact to `suppressed` with reason `dnc`', () => {
    const d = D(entry({ code: 'do_not_call', suppress: true }));
    expect(d.contactState).toBe('suppressed');
    expect(d.nextAttemptAt).toBeNull();
    // Migration 073's column comment enumerates `dnc | invalid | max_attempts |
    // manual`. `dnc`, not `manual`: an agent recording `do_not_call` on a live call
    // IS the DNC path's entry point, and `invalid` means the number does not work.
    expect(d.suppressedReason).toBe('dnc');
    expect(d.reason).toBe('disposition_suppressed');
  });

  it('suppress BEATS a callback on the same submission', () => {
    // The ordering assertion, and the one that matters most. A customer who says
    // "do not call me again" must not be re-queued because the submission also
    // carried a datetime — which a console with a sticky field, or a supervisor
    // correcting a code without clearing the time, can produce. Every other arm can
    // put the contact back in the roster; this is the only arm that must stop that.
    const d = D(entry({ code: 'do_not_call', suppress: true }), { callbackAt: plus(60) });
    expect(d.contactState).toBe('suppressed');
    expect(d.nextAttemptAt).toBeNull();
  });

  it('suppress BEATS its own retry block', () => {
    const d = D(entry({ suppress: true, retry: { delay_minutes: 5, max_attempts: 9 } }));
    expect(d.contactState).toBe('suppressed');
  });

  it('terminal BEATS a callback, resolving a contradictory catalog toward silence', () => {
    // `terminal` plus a datetime is a malformed catalog. Resolving it toward "stop
    // calling" is the direction that cannot annoy a customer; the other direction
    // re-queues someone an operator marked done.
    const d = D(entry({ terminal: true }), { callbackAt: plus(60) });
    expect(d.contactState).toBe('completed');
    expect(d.nextAttemptAt).toBeNull();
    expect(d.reason).toBe('disposition_terminal');
  });

  it('terminal BEATS its own retry block', () => {
    const d = D(entry({ terminal: true, retry: { max_attempts: 5 } }));
    expect(d.contactState).toBe('completed');
    expect(d.reason).toBe('disposition_terminal');
  });

  it('a callback BEATS the retry block, and is scheduled for what was promised', () => {
    const at = plus(2880);
    const d = D(entry({ requires_datetime: true, retry: { delay_minutes: 240, max_attempts: 2 } }), {
      callbackAt: at,
    });
    expect(d.contactState).toBe('pending');
    // The promised instant, not `now + 240`. An agent said a time out loud.
    expect(d.nextAttemptAt).toEqual(at);
    expect(d.reason).toBe('callback_scheduled');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The callback arm's two deliberate choices.
// ═══════════════════════════════════════════════════════════════════════════

describe('the callback arm', () => {
  it('is keyed on a datetime being PRESENT, not on the code being `callback`', () => {
    // An operator code carrying `requires_datetime` means the same thing as the
    // built-in. Hardcoding the string would make the built-in a special case the
    // rest of the catalog could not express — and nothing else keys on the string.
    const at = plus(120);
    const operatorCode = D(entry({ code: 'ring_me_back', requires_datetime: true }), { callbackAt: at });
    expect(operatorCode.contactState).toBe('pending');
    expect(operatorCode.nextAttemptAt).toEqual(at);
    expect(operatorCode.reason).toBe('callback_scheduled');

    // And the converse: the built-in `callback` code with NO datetime does not
    // schedule anything. `requires_datetime` is enforced upstream by
    // `validateDispositionFields`, so this arm must not invent a time when it is
    // reached anyway.
    const noTime = D(entry({ code: 'callback', requires_datetime: true }));
    expect(noTime.contactState).toBe('completed');
    expect(noTime.reason).toBe('disposition_recorded');
    expect(noTime.nextAttemptAt).toBeNull();
  });

  it('honours a callback even when the attempt budget is spent', () => {
    // Deliberate, and the direction is the argument: a customer who named a time is
    // owed that call even with the budget gone. Dropping it would have the agent
    // promise a call that never comes — the exact failure the callback-budget rule exists to
    // prevent one step later, so it would be incoherent to defeat it here.
    const at = plus(4320);
    const d = D(entry({ code: 'callback', requires_datetime: true, retry: { max_attempts: 1 } }), {
      attemptsUsed: 99, callbackAt: at,
    });
    expect(d.contactState).toBe('pending');
    expect(d.nextAttemptAt).toEqual(at);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The retry arm — voicemail's mechanism, and the attempts boundary.
// ═══════════════════════════════════════════════════════════════════════════

describe('the disposition retry arm', () => {
  it('schedules at now + delay_minutes, exactly', () => {
    const d = D(entry({ retry: { delay_minutes: 240, max_attempts: 2 } }), { attemptsUsed: 1 });
    expect(d.contactState).toBe('pending');
    expect(d.nextAttemptAt).toEqual(plus(240));
    expect(d.reason).toBe('disposition_retry_scheduled');
  });

  it('treats a missing delay as 0, not as a fabricated default', () => {
    const d = D(entry({ retry: { max_attempts: 3 } }), { attemptsUsed: 1 });
    // `claimDialable` gates on `next_attempt_at <= now()`, so this is re-claimable
    // on the very next tick — the intended behaviour for a retry with no delay.
    expect(d.nextAttemptAt).toEqual(NOW);
    expect(d.reason).toBe('disposition_retry_scheduled');
  });

  it('ON the attempts boundary the contact is `exhausted`, one below it retries', () => {
    // The boundary pair a threshold needs: a max tested only at 0
    // and 99 can be off by one and never show it. `attemptsUsed` INCLUDES the
    // attempt just dispositioned, so used === max means the budget is spent.
    const rule = { delay_minutes: 30, max_attempts: 2 };
    const atMax = D(entry({ retry: rule }), { attemptsUsed: 2 });
    expect(atMax.contactState).toBe('exhausted');
    expect(atMax.nextAttemptAt).toBeNull();
    expect(atMax.reason).toBe('disposition_attempts_reached');

    const belowMax = D(entry({ retry: rule }), { attemptsUsed: 1 });
    expect(belowMax.contactState).toBe('pending');
    expect(belowMax.nextAttemptAt).toEqual(plus(30));
  });

  it('distinguishes "never retried" from "ran out", because a dashboard reads both', () => {
    // `max_attempts: 0` ⇒ nothing was used up, so `completed`, not `exhausted`.
    // `exhausted` tells a supervisor the list was worked; conflating them makes the
    // number lie in one direction or the other.
    const never = D(entry({ retry: { max_attempts: 0 } }), { attemptsUsed: 0 });
    expect(never.contactState).toBe('completed');
    expect(never.reason).toBe('disposition_not_retryable');

    const ranOut = D(entry({ retry: { max_attempts: 1 } }), { attemptsUsed: 1 });
    expect(ranOut.contactState).toBe('exhausted');
    expect(ranOut.reason).toBe('disposition_attempts_reached');
  });

  it('clamps a hostile max_attempts rather than trusting the JSONB column', () => {
    // Nothing constrains the elements of `disposition_catalog`, so these are
    // reachable values, not hypotheticals.
    for (const max of [NaN, -5, Infinity] as number[]) {
      const d = D(entry({ retry: { max_attempts: max } }), { attemptsUsed: 0 });
      expect(d.contactState, `max_attempts ${max} must not schedule a retry`).toBe('completed');
    }
    // A negative delay must not schedule a retry in the PAST, which would be
    // immediately claimable and re-dial in a tight loop.
    const negDelay = D(entry({ retry: { delay_minutes: -60, max_attempts: 3 } }), { attemptsUsed: 0 });
    expect(negDelay.nextAttemptAt).toEqual(NOW);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The plain arm, and the convergence that makes it hard to test honestly.
// ═══════════════════════════════════════════════════════════════════════════

describe('a plain label ends the contact, and `reason` is the only proof', () => {
  it('sends a flagless disposition to `completed`', () => {
    const d = D(entry({ code: 'not_interested', label: 'Not interested' }));
    expect(d.contactState).toBe('completed');
    expect(d.nextAttemptAt).toBeNull();
    expect(d.reason).toBe('disposition_recorded');
  });

  it('CONVERGES with the outcome policy, so contactState alone proves nothing here', () => {
    // Stated as a test rather than a comment because it is a trap for the next
    // person: a dispositioned attempt's outcome is `connected`, whose default
    // policy is `max_attempts: 0` ⇒ `completed`. So both paths agree on this arm,
    // and an assertion on `contactState` cannot tell "the disposition decided" from
    // "the outcome policy decided" — a conflation the assertion on `contactState` alone would hide.
    // `reason` is the field that can, which is why it is returned and not just logged.
    const viaDisposition = D(entry({ code: 'not_interested' }));
    const viaOutcome = resolveRetryDecision(null, 'connected', NOW, 1);

    expect(viaDisposition.contactState).toBe(viaOutcome.contactState);
    expect(DEFAULT_RETRY_POLICY.connected!.max_attempts).toBe(0);
    // …and they are still distinguishable, which is the point.
    expect(viaDisposition.reason).not.toBe(viaOutcome.reason);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The three named codes. NOT a fallback — see the module header.
// ═══════════════════════════════════════════════════════════════════════════

describe('the built-in codes carry their built-in semantics', () => {
  it('names exactly the three built-in codes', () => {
    expect([...BUILT_IN_DISPOSITION_CODES].sort()).toEqual(['callback', 'do_not_call', 'voicemail']);
  });

  it('each one resolves to the mechanism its name promises', () => {
    const byCode = new Map(BUILT_IN_DISPOSITIONS.map((d) => [d.code, d]));

    // The property is the DECISION, not the flag — asserted through the resolver
    // rather than by reading the literal back, or this would only prove the object
    // is the object it is.
    const voicemail = D(byCode.get('voicemail')!, { attemptsUsed: 1 });
    expect(voicemail.contactState).toBe('pending');
    expect(voicemail.nextAttemptAt).toEqual(plus(240));

    const callbackAt = plus(1440);
    const callback = D(byCode.get('callback')!, { callbackAt });
    expect(callback.contactState).toBe('pending');
    expect(callback.nextAttemptAt).toEqual(callbackAt);
    // Without this the console never collects a time and the code is inert.
    expect(byCode.get('callback')!.requires_datetime).toBe(true);

    const dnc = D(byCode.get('do_not_call')!);
    expect(dnc.contactState).toBe('suppressed');
    expect(dnc.suppressedReason).toBe('dnc');
  });

  it('is frozen, so a consumer cannot mutate the shared reference', () => {
    // These are module-level singletons handed to any caller; a `push` or a field
    // write would change every campaign's idea of the default for the process.
    expect(Object.isFrozen(BUILT_IN_DISPOSITIONS)).toBe(true);
    for (const d of BUILT_IN_DISPOSITIONS) expect(Object.isFrozen(d)).toBe(true);
  });

  it('voicemail is retry-driven, because D1 makes an outcome rule impossible', () => {
    // With AMD off the carrier reports `connected` for a voicemail pickup, so there
    // is no `machine` outcome for a policy to key on — asserted here so the absence
    // is a pinned property rather than an omission someone "fixes".
    expect('machine' in DEFAULT_RETRY_POLICY).toBe(false);
    expect(BUILT_IN_DISPOSITIONS.find((d) => d.code === 'voicemail')!.retry).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The hazard created by "nothing keys on the code string".
// ═══════════════════════════════════════════════════════════════════════════

describe('a built-in name with no flag behind it is detectable', () => {
  it('reports a `do_not_call` that does not suppress', () => {
    // The live hazard: since every mechanism keys on a FLAG and nothing on the
    // code string, this entry is a button labelled "Do not call" that does not
    // suppress. The customer asks never to be called again, the agent clicks the
    // obvious control, and the contact is retried on schedule.
    const catalog = [entry({ code: 'do_not_call', label: 'Do not call' })];
    expect(builtInSemanticMismatches(catalog)).toEqual([{ code: 'do_not_call', missing: 'suppress' }]);
    // And the resolver confirms the consequence rather than the report only
    // claiming it — checked at the consumer.
    expect(D(catalog[0]!).contactState).toBe('completed');
    expect(D(catalog[0]!).suppressedReason).toBeNull();
  });

  it('reports voicemail without retry and callback without a datetime', () => {
    expect(builtInSemanticMismatches([entry({ code: 'voicemail' })]))
      .toEqual([{ code: 'voicemail', missing: 'retry' }]);
    expect(builtInSemanticMismatches([entry({ code: 'callback' })]))
      .toEqual([{ code: 'callback', missing: 'requires_datetime' }]);
  });

  it('says nothing about a built-in whose VALUES an operator changed', () => {
    // The negative control, and the line the check must not cross: `voicemail` with
    // one retry instead of two is an operator's business. Only a MISSING flag is
    // reported, because that is the case where the label promises a behaviour the
    // entry cannot deliver.
    expect(builtInSemanticMismatches([
      entry({ code: 'voicemail', retry: { delay_minutes: 15, max_attempts: 1 } }),
      entry({ code: 'callback', requires_datetime: true }),
      entry({ code: 'do_not_call', suppress: true }),
    ])).toEqual([]);
  });

  it('says nothing about an operator code that shares no name with a built-in', () => {
    expect(builtInSemanticMismatches([entry({ code: 'sale', is_success: true })])).toEqual([]);
  });

  it('survives a malformed catalog rather than throwing at an agent', () => {
    // The column is CHECKed to be an array and nothing constrains its elements.
    const junk = [null, undefined, 42, 'do_not_call', {}, { code: 7 }] as unknown as AgencyDisposition[];
    expect(builtInSemanticMismatches(junk)).toEqual([]);
    expect(builtInSemanticMismatches(null)).toEqual([]);
    expect(builtInSemanticMismatches(undefined)).toEqual([]);
  });

  it('is ADVISORY — an empty catalog is a legitimate configuration', () => {
    // Pinned because it was nearly built the other way. One could claim these three
    // "cannot be removed from a catalog … because the retry engine, the scheduler
    // and the DNC path each depend on one of them existing", and a grep for
    // consumers shows that justification is false: every mechanism keys on a flag,
    // and the real DNC path is the `attempts/:id/dnc` route, which never reads the
    // catalog. So `[]` means "outcome-driven retry, no human write-up step", and
    // synthesising the built-ins on read would have deleted that capability
    // platform-wide. If someone turns this into a merge, this test is the record of
    // why not.
    expect(builtInSemanticMismatches([])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Acceptance (d): the precedence, over every outcome × disposition combination.
//
// What this table can and cannot prove, stated plainly, because the distinction
// decides how much weight it carries:
//
//  - `resolveDispositionDecision` takes NO outcome parameter, so "the outcome
//    does not influence the answer" is true by signature here. The table's value
//    is (1) pinning all 63 cells as an executable specification, and (2) the
//    census below, which proves the two halves genuinely DISAGREE on real cells
//    — without that, "the disposition wins" is an agreement check on data that
//    cannot disagree, which proves nothing.
//  - Precedence WHERE IT IS CONSUMED is a different assertion and lives in
//    `disposition-route.test.ts`, because the route is the only place both
//    policies exist. Neither file covers the other.
//
// If anyone ever merges the two policies — the change this ticket's design most
// explicitly rules out — the merged function must take an outcome, and every
// row here reds rather than one hand-picked case.
// ═══════════════════════════════════════════════════════════════════════════

/** Every value of the union in `contracts.ts`, not a sample of it. */
const ALL_OUTCOMES: AgencyAttemptOutcome[] = [
  'connected', 'no_answer', 'busy', 'failed', 'machine',
  'invalid', 'abandoned', 'agent_disconnected', 'orphaned',
];

/** One row per ARM of the precedence, each carrying the input that reaches it. */
const ARMS: Array<{
  arm: string;
  entry: AgencyDisposition;
  attemptsUsed: number;
  callbackAt: Date | null;
  expected: Pick<ReturnType<typeof D>, 'contactState' | 'nextAttemptAt' | 'suppressedReason' | 'reason'>;
}> = [
  {
    arm: 'suppress',
    entry: entry({ code: 'do_not_call', suppress: true }),
    attemptsUsed: 0, callbackAt: null,
    expected: { contactState: 'suppressed', nextAttemptAt: null, suppressedReason: 'dnc', reason: 'disposition_suppressed' },
  },
  {
    arm: 'terminal',
    entry: entry({ code: 'not_interested', terminal: true }),
    attemptsUsed: 0, callbackAt: null,
    expected: { contactState: 'completed', nextAttemptAt: null, suppressedReason: null, reason: 'disposition_terminal' },
  },
  {
    arm: 'callback',
    entry: entry({ code: 'callback', requires_datetime: true }),
    attemptsUsed: 0, callbackAt: plus(2880),
    expected: { contactState: 'pending', nextAttemptAt: plus(2880), suppressedReason: null, reason: 'callback_scheduled' },
  },
  {
    arm: 'retry — budget left',
    entry: entry({ code: 'voicemail', retry: { delay_minutes: 240, max_attempts: 2 } }),
    attemptsUsed: 1, callbackAt: null,
    expected: { contactState: 'pending', nextAttemptAt: plus(240), suppressedReason: null, reason: 'disposition_retry_scheduled' },
  },
  {
    arm: 'retry — on the boundary',
    entry: entry({ code: 'voicemail', retry: { delay_minutes: 240, max_attempts: 2 } }),
    attemptsUsed: 2, callbackAt: null,
    expected: { contactState: 'exhausted', nextAttemptAt: null, suppressedReason: null, reason: 'disposition_attempts_reached' },
  },
  {
    arm: 'retry — never retried',
    entry: entry({ code: 'one_and_done', retry: { max_attempts: 0 } }),
    attemptsUsed: 0, callbackAt: null,
    expected: { contactState: 'completed', nextAttemptAt: null, suppressedReason: null, reason: 'disposition_not_retryable' },
  },
  {
    arm: 'plain label',
    entry: entry({ code: 'sale', is_success: true }),
    attemptsUsed: 0, callbackAt: null,
    expected: { contactState: 'completed', nextAttemptAt: null, suppressedReason: null, reason: 'disposition_recorded' },
  },
];

describe('every outcome × every disposition', () => {
  for (const outcome of ALL_OUTCOMES) {
    for (const row of ARMS) {
      it(`${outcome} × ${row.arm} → ${row.expected.contactState}`, () => {
        const d = D(row.entry, { attemptsUsed: row.attemptsUsed, callbackAt: row.callbackAt });
        // The whole decision, not a field: a decision that got `contactState`
        // right while dropping `suppressedReason` would leave a DNC contact
        // suppressed with no recorded reason, which is the field a compliance
        // export reads.
        expect({
          contactState: d.contactState,
          nextAttemptAt: d.nextAttemptAt,
          suppressedReason: d.suppressedReason,
          reason: d.reason,
        }).toEqual(row.expected);
      });
    }
  }

  it('the two halves DISAGREE on real cells, so the precedence is not vacuous', () => {
    // Applied before the fact rather than after. If the
    // outcome policy and the disposition policy happened to agree everywhere, every
    // row above would pass under an implementation that consulted the WRONG one,
    // and "the disposition wins" would be untested while looking covered.
    //
    // `null` policy on the outcome side deliberately: that is the ordinary
    // production case (`retry_policy` defaults to `'{}'` and the public API layer never sends the
    // field), so the comparison is against `DEFAULT_RETRY_POLICY`, which is what
    // real campaigns actually run.
    const disagreements: string[] = [];
    for (const outcome of ALL_OUTCOMES) {
      for (const row of ARMS) {
        const byDisposition = D(row.entry, { attemptsUsed: row.attemptsUsed, callbackAt: row.callbackAt });
        const byOutcome = resolveRetryDecision(null, outcome, NOW, row.attemptsUsed);
        if (byDisposition.contactState !== byOutcome.contactState) {
          disagreements.push(`${outcome} × ${row.arm}`);
        }
      }
    }
    // An exact count rather than `toBeGreaterThan(0)`, so a change in either policy
    // has to be looked at rather than absorbed. 9 outcomes × 7 arms = 63 cells.
    //
    // ── 40 → 42, and the +2 was enumerated cell by cell, not absorbed ────────
    //
    // The our-fault ledger gave `agent_disconnected` and `orphaned` entries in
    // `DEFAULT_RETRY_POLICY`. Both used to answer `completed` for every arm (via
    // `no_policy_for_outcome`); both now answer `pending` at `attemptsUsed < 3`.
    // Per outcome that LOSES 2 disagreements and GAINS 3:
    //
    //   lost   — `callback` and `retry — budget left` (both `pending` by
    //            disposition, so the two halves now agree)
    //   gained — `terminal`, `retry — never retried` and `plain label` (all
    //            `completed` by disposition, which the outcome half no longer is)
    //
    // Net +1 each, +2 overall. The precedence gets STRONGER, not weaker: the two
    // halves now differ on more of the grid, so a implementation consulting the
    // wrong one has more places to be caught.
    expect(disagreements.length).toBe(42);

    // The named cells the criteria turn on, asserted individually so a future
    // count change cannot quietly drop one of them.
    //
    // (a): `connected` is `max_attempts: 0` ⇒ `completed` by outcome, while a
    // `voicemail` disposition schedules a retry. The exact cell D1 forces to exist.
    expect(disagreements).toContain('connected × retry — budget left');
    // The DNC arm on an outcome that would otherwise have retried.
    expect(disagreements).toContain('no_answer × suppress');
    // `invalid` suppresses by outcome; a plain label completes.
    expect(disagreements).toContain('invalid × plain label');
    // The our-fault ledger's two new cells, named so the +2 above cannot later be
    // "corrected" back to 40 by deleting the defaults that fix the retry defaults. A
    // `terminal` disposition retires the contact; the outcome half now retries,
    // which is the whole point — our own fault must not be the thing that ends it.
    expect(disagreements).toContain('agent_disconnected × terminal');
    expect(disagreements).toContain('orphaned × terminal');
  });

  it('covers the union exhaustively rather than a sample of it', () => {
    // The guard that makes "every outcome" true rather than aspirational: a value
    // added to `AgencyAttemptOutcome` without being added here would leave the
    // table silently partial. `machine` is in the union and deliberately absent
    // from the retry policy (D1), so it is exactly the kind of member that gets
    // forgotten.
    expect(ALL_OUTCOMES).toHaveLength(9);
    expect(new Set(ALL_OUTCOMES).size).toBe(ALL_OUTCOMES.length);
    expect(ALL_OUTCOMES).toContain('machine');
  });
});
