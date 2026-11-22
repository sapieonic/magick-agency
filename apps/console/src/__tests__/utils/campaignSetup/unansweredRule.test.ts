import { describe, expect, it } from 'vitest';
import {
  SERVER_DEFAULT_UNANSWERED_RULES,
  UNANSWERED_OUTCOMES,
  attemptOptions,
  attemptsLabel,
  delayLabel,
  delayOptions,
  startingRuleOf,
  unansweredRuleOf,
  withUnansweredRule,
} from '../../../utils/campaignSetup/unansweredRule';
import {
  FIXED_ZERO_OUTCOMES,
  OUR_FAULT_RETRY_OUTCOMES,
  RETRY_OUTCOMES,
} from '../../../utils/agencyCampaignConfigForm';
import type { AgencyRetryPolicy } from '../../../types/agency-campaign';

/** One "doesn't pick up" rule (CS12). */

const same = (max: number, delay: number): AgencyRetryPolicy => ({
  no_answer: { max_attempts: max, delay_minutes: delay },
  busy: { max_attempts: max, delay_minutes: delay },
  failed: { max_attempts: max, delay_minutes: delay },
});

describe('the unanswered results', () => {
  it('are no answer, busy (a switched-off phone too) and failed: the customer side, nothing of ours', () => {
    expect([...UNANSWERED_OUTCOMES]).toEqual(['no_answer', 'busy', 'failed']);
    for (const outcome of UNANSWERED_OUTCOMES) {
      expect(RETRY_OUTCOMES).toContain(outcome);
      expect(OUR_FAULT_RETRY_OUTCOMES).not.toContain(outcome);
      expect(FIXED_ZERO_OUTCOMES).not.toContain(outcome);
    }
    expect(UNANSWERED_OUTCOMES).not.toContain('abandoned' as never);
  });
});

describe('unansweredRuleOf', () => {
  it('is one rule when the three share it', () => {
    expect(unansweredRuleOf(same(3, 120))).toEqual({ kind: 'same', maxAttempts: 3, delayMinutes: 120 });
  });

  it('reads an unset delay as 0, as the server does', () => {
    const policy: AgencyRetryPolicy = {
      no_answer: { max_attempts: 2 },
      busy: { max_attempts: 2, delay_minutes: 0 },
      failed: { max_attempts: 2 },
    };
    expect(unansweredRuleOf(policy)).toEqual({ kind: 'same', maxAttempts: 2, delayMinutes: 0 });
  });

  it('ignores the rows it does not own', () => {
    const policy: AgencyRetryPolicy = {
      ...same(4, 60),
      abandoned: { max_attempts: 9, delay_minutes: 1 },
      agent_disconnected: { max_attempts: 0, delay_minutes: 5 },
    };
    expect(unansweredRuleOf(policy)).toEqual({ kind: 'same', maxAttempts: 4, delayMinutes: 60 });
  });

  it('reads an unset row as the server default, so a new campaign says its rules differ', () => {
    const rule = unansweredRuleOf({});
    expect(rule.kind).toBe('mixed');
    if (rule.kind !== 'mixed') return;
    expect(rule.summary).toBe('Different rules for no answer, busy and calls that can’t connect');
    expect(rule.details).toEqual([
      'No answer: up to 3 calls in all, 1 hour apart (default)',
      'Busy or switched off: up to 4 calls in all, 15 minutes apart (default)',
      'Can’t connect: up to 2 calls in all, 2 hours apart (default)',
    ]);
  });

  it('names the odd one out when two of the three agree', () => {
    const rule = unansweredRuleOf({ ...same(3, 120), busy: { max_attempts: 5, delay_minutes: 15 } });
    expect(rule.kind).toBe('mixed');
    if (rule.kind !== 'mixed') return;
    expect(rule.summary).toBe('Busy has a different rule from no answer and calls that can’t connect');
    expect(rule.details[1]).toBe('Busy or switched off: up to 5 calls in all, 15 minutes apart');
  });

  it('says a rule of one call or fewer is not called again', () => {
    const rule = unansweredRuleOf({ ...same(3, 60), failed: { max_attempts: 0 } });
    expect(rule.kind === 'mixed' && rule.details[2]).toBe('Can’t connect: not called again');
  });

  it('treats an explicit rule equal to the default as the same rule', () => {
    const policy: AgencyRetryPolicy = { no_answer: { ...SERVER_DEFAULT_UNANSWERED_RULES.no_answer }, busy: { max_attempts: 3, delay_minutes: 60 }, failed: { max_attempts: 3, delay_minutes: 60 } };
    expect(unansweredRuleOf(policy)).toEqual({ kind: 'same', maxAttempts: 3, delayMinutes: 60 });
  });
});

describe('withUnansweredRule', () => {
  it('writes one rule to no answer, busy and failed, and leaves every other row as it was', () => {
    const before: AgencyRetryPolicy = {
      no_answer: { max_attempts: 1, delay_minutes: 5 },
      abandoned: { max_attempts: 2, delay_minutes: 5 },
      connected: { max_attempts: 0 },
      agent_disconnected: { max_attempts: 1, delay_minutes: 10 },
      canceled: { max_attempts: 0, delay_minutes: 0 },
      invalid: { max_attempts: 0 },
    };
    const after = withUnansweredRule(before, { maxAttempts: 4, delayMinutes: 120 });
    for (const outcome of UNANSWERED_OUTCOMES) {
      expect(after[outcome]).toEqual({ max_attempts: 4, delay_minutes: 120 });
    }
    expect(after.abandoned).toBe(before.abandoned);
    expect(after.connected).toBe(before.connected);
    expect(after.agent_disconnected).toBe(before.agent_disconnected);
    expect(after.canceled).toBe(before.canceled);
    expect(after.invalid).toBe(before.invalid);
    expect(before.no_answer).toEqual({ max_attempts: 1, delay_minutes: 5 });
    expect(unansweredRuleOf(after)).toEqual({ kind: 'same', maxAttempts: 4, delayMinutes: 120 });
  });

  it('adds no our-fault or fixed-zero row a campaign did not have', () => {
    const after = withUnansweredRule({}, { maxAttempts: 2, delayMinutes: 30 });
    expect(Object.keys(after).sort()).toEqual(['busy', 'failed', 'no_answer']);
  });

  it('starts a mixed campaign from no answer’s own rule', () => {
    expect(startingRuleOf({})).toEqual({ maxAttempts: 3, delayMinutes: 60 });
    expect(startingRuleOf({ no_answer: { max_attempts: 5, delay_minutes: 30 } })).toEqual({ maxAttempts: 5, delayMinutes: 30 });
  });
});

describe('the selects', () => {
  it('count calls in all, 1 to 10', () => {
    const options = attemptOptions();
    expect(options[0]).toEqual({ value: '1', label: '1 call' });
    expect(options.map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(attemptsLabel(3)).toBe('3 calls');
    expect(attemptsLabel(0)).toBe('1 call (no retry)');
  });

  it('keep a loaded value that is not a choice, in order, so it is never rewritten', () => {
    expect(attemptOptions(15).map((o) => o.value).slice(-2)).toEqual(['10', '15']);
    expect(attemptOptions(0)[0]).toEqual({ value: '0', label: '1 call (no retry)' });
    expect(delayOptions(90).map((o) => o.value)).toEqual(['15', '30', '60', '90', '120', '180', '240', '360', '720', '1440', '2880']);
  });

  it('say the time between calls in minutes, hours or days', () => {
    expect(delayOptions().map((o) => o.label)).toEqual([
      '15 minutes', '30 minutes', '1 hour', '2 hours', '3 hours', '4 hours', '6 hours', '12 hours', '1 day', '2 days',
    ]);
    expect(delayLabel(0)).toBe('0 minutes');
    expect(delayLabel(1)).toBe('1 minute');
    expect(delayLabel(90)).toBe('1 hour 30 minutes');
    expect(delayLabel(121)).toBe('2 hours 1 minute');
  });
});
