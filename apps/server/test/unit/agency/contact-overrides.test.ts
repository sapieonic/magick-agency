import { describe, expect, it } from 'vitest';
import {
  applyExtraAttemptOverride,
  chooseAgentDialBasis,
  dispositionRuleDelayMinutes,
  outcomeRuleDelayMinutes,
  overrideGrantOf,
  validateOverrideNoteText,
  type AgentDialFacts,
} from '../../../src/agency/contact-overrides.js';
import { resolveRetryDecision } from '../../../src/agency/retry-policy.js';
import { resolveDispositionDecision } from '../../../src/agency/disposition-policy.js';

/**
 * The pure rules of outcome overrides and of the agent's own dial (contact assignment D7, D8).
 * The writes that apply them are pinned on real Postgres (`agent-retry-*.test.ts`,
 * `contact-override-*.test.ts`).
 *
 * Mutation-checked: removing the `remaining > 0` floor in `applyExtraAttemptOverride` reds
 * "nothing left, nothing spent".
 */

const NOW = new Date('2026-11-03T10:00:00Z');

describe('overrideGrantOf', () => {
  it('normalises a grant: every part, the replace set', () => {
    expect(overrideGrantOf({ override: { extra_attempts: 3, retry_delay: true } }))
      .toEqual({ extraAttempts: 3, retryDelay: true, callingHours: false });
    expect(overrideGrantOf({ override: { calling_hours: true } }))
      .toEqual({ extraAttempts: 0, retryDelay: false, callingHours: true });
  });

  it('clamps extra_attempts to the column bound and truncates', () => {
    expect(overrideGrantOf({ override: { extra_attempts: 9 } })?.extraAttempts).toBe(5);
    expect(overrideGrantOf({ override: { extra_attempts: 2.7 } })?.extraAttempts).toBe(2);
    expect(overrideGrantOf({ override: { extra_attempts: -1, retry_delay: true } })?.extraAttempts).toBe(0);
  });

  it('grants nothing when absent, empty, malformed, or on a suppress / terminal entry', () => {
    expect(overrideGrantOf({})).toBeNull();
    expect(overrideGrantOf({ override: {} })).toBeNull();
    expect(overrideGrantOf({ override: { extra_attempts: 0, retry_delay: false } })).toBeNull();
    expect(overrideGrantOf({ override: 'yes' as never })).toBeNull();
    expect(overrideGrantOf({ override: { retry_delay: 'true' as never } })).toBeNull();
    // DNC is never overridable: an override on a suppressing entry is inert at runtime too.
    expect(overrideGrantOf({ suppress: true, override: { extra_attempts: 3 } })).toBeNull();
    expect(overrideGrantOf({ terminal: true, override: { calling_hours: true } })).toBeNull();
  });
});

describe('applyExtraAttemptOverride', () => {
  const exhausted = resolveRetryDecision(null, 'no_answer', NOW, 99);

  it('turns a max-attempts exhaustion into one more try after the rule delay, spending one', () => {
    expect(exhausted.reason).toBe('max_attempts_reached');
    const out = applyExtraAttemptOverride(exhausted, 3, { delayMinutes: 60 }, NOW);
    expect(out.spent).toBe(true);
    expect(out.decision).toMatchObject({ contactState: 'pending', nextAttemptAt: new Date(NOW.getTime() + 3_600_000) });
  });

  it('applies to a disposition retry exhaustion too', () => {
    const d = resolveDispositionDecision(
      { code: 'voicemail', label: 'Voicemail', retry: { max_attempts: 2, delay_minutes: 240 } },
      { now: NOW, attemptsUsed: 2, callbackAt: null },
    );
    expect(d.reason).toBe('disposition_attempts_reached');
    expect(applyExtraAttemptOverride(d, 1, { delayMinutes: 240 }, NOW).decision.contactState).toBe('pending');
  });

  it('nothing left, nothing spent: the decision is unchanged', () => {
    for (const remaining of [0, -1, Number.NaN]) {
      const out = applyExtraAttemptOverride(exhausted, remaining, { delayMinutes: 60 }, NOW);
      expect(out).toEqual({ decision: exhausted, spent: false });
    }
  });

  it('never applies to a suppression, a completion, a retry under the cap, or an our-fault retirement', () => {
    const decisions = [
      resolveRetryDecision(null, 'invalid', NOW, 1), // suppressed
      resolveRetryDecision(null, 'connected', NOW, 1), // completed (not retryable)
      resolveRetryDecision(null, 'no_answer', NOW, 1), // pending under the cap
      resolveDispositionDecision({ code: 'do_not_call', label: 'DNC', suppress: true }, { now: NOW, attemptsUsed: 9, callbackAt: null }),
      { contactState: 'exhausted' as const, nextAttemptAt: null, reason: 'our_fault_bound_reached' },
    ];
    for (const d of decisions) {
      expect(applyExtraAttemptOverride(d, 5, { delayMinutes: 0 }, NOW), d.reason).toEqual({ decision: d, spent: false });
    }
  });

  it('reads the rule delays as the decision functions do', () => {
    expect(outcomeRuleDelayMinutes({ no_answer: { delay_minutes: 15, max_attempts: 2 } }, 'no_answer')).toBe(15);
    expect(outcomeRuleDelayMinutes(null, null)).toBe(0);
    expect(dispositionRuleDelayMinutes({ retry: { max_attempts: 1, delay_minutes: 90 } })).toBe(90);
    expect(dispositionRuleDelayMinutes({})).toBe(0);
  });
});

describe('validateOverrideNoteText', () => {
  it('trims and counts code points, 10–500', () => {
    expect(validateOverrideNoteText('  Called back at 9pm by request  ')).toBe('Called back at 9pm by request');
    expect(validateOverrideNoteText('123456789')).toBeNull();
    expect(validateOverrideNoteText('1234567890')).toBe('1234567890');
    expect(validateOverrideNoteText('😀'.repeat(9))).toBeNull();
    expect(validateOverrideNoteText('😀'.repeat(10))).toBe('😀'.repeat(10));
    expect(validateOverrideNoteText('x'.repeat(500))).not.toBeNull();
    expect(validateOverrideNoteText('x'.repeat(501))).toBeNull();
    expect(validateOverrideNoteText(42)).toBeNull();
    expect(validateOverrideNoteText(null)).toBeNull();
  });
});

describe('chooseAgentDialBasis', () => {
  const base: AgentDialFacts = {
    state: 'pending', dnc: false, due: false, overrideRetryDelay: false, retryBlock: 'not_retryable', availableAt: null,
  };

  it('due first: spends nothing', () => {
    expect(chooseAgentDialBasis({ ...base, due: true, overrideRetryDelay: true, retryBlock: null }))
      .toEqual({ ok: true, basis: 'due' });
  });

  it('then a held retry-delay override on a pending contact', () => {
    expect(chooseAgentDialBasis({ ...base, overrideRetryDelay: true, retryBlock: null }))
      .toEqual({ ok: true, basis: 'retry_delay' });
  });

  it('then a retry round, for pending or exhausted', () => {
    expect(chooseAgentDialBasis({ ...base, retryBlock: null })).toEqual({ ok: true, basis: 'retry_round' });
    expect(chooseAgentDialBasis({ ...base, state: 'exhausted', retryBlock: null })).toEqual({ ok: true, basis: 'retry_round' });
    // An exhausted contact's retry-delay override is not a basis of its own.
    expect(chooseAgentDialBasis({ ...base, state: 'exhausted', overrideRetryDelay: true, retryBlock: 'rounds_used' }))
      .toMatchObject({ ok: false, blocked: 'rounds_used' });
  });

  it('DNC or suppressed never, whatever else holds', () => {
    expect(chooseAgentDialBasis({ ...base, dnc: true, due: true })).toMatchObject({ ok: false, blocked: 'suppressed' });
    expect(chooseAgentDialBasis({ ...base, state: 'suppressed', retryBlock: null })).toMatchObject({ ok: false, blocked: 'suppressed' });
  });

  it('on a call or held for a write-up is in flight', () => {
    expect(chooseAgentDialBasis({ ...base, state: 'in_flight' })).toEqual({ ok: false, reason: 'in_flight' });
    expect(chooseAgentDialBasis({ ...base, state: 'connected' })).toEqual({ ok: false, reason: 'in_flight' });
  });

  it('otherwise the retry block, with the cooldown end only for a cooldown', () => {
    const at = new Date('2026-11-03T10:30:00Z');
    expect(chooseAgentDialBasis({ ...base, retryBlock: 'cooldown', availableAt: at }))
      .toEqual({ ok: false, reason: 'not_retryable', blocked: 'cooldown', availableAt: at });
    expect(chooseAgentDialBasis({ ...base, retryBlock: 'retry_disabled', availableAt: at }))
      .toEqual({ ok: false, reason: 'not_retryable', blocked: 'retry_disabled', availableAt: null });
    expect(chooseAgentDialBasis({ ...base, state: 'completed', retryBlock: 'not_retryable' }))
      .toMatchObject({ ok: false, blocked: 'not_retryable' });
  });
});
