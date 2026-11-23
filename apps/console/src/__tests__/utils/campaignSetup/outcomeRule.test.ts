import { describe, expect, it } from 'vitest';
import type { AgencyDispositionEntry } from '../../../types/agency-campaign';
import { DEFAULT_DISPOSITIONS, emptyCampaignConfig, validateConfig } from '../../../utils/agencyCampaignConfigForm';
import { collectionsStarterOutcomes } from '../../../utils/agency/collectionsStarter';
import { PURPOSE_PRESETS } from '../../../utils/campaignSetup/purposePresets';
import {
  OUTCOME_ACTIONS,
  RETRY_ATTEMPT_CHOICES,
  RETRY_DELAY_CHOICES,
  attemptOptions,
  attemptsLabel,
  delayLabel,
  delayOptions,
  lockedAction,
  outcomeFate,
  ruleOf,
  ruleSummary,
  withRule,
  type OutcomeAction,
  type OutcomeRule,
} from '../../../utils/campaignSetup/outcomeRule';

/** One button's rule as a sentence (CS3): read, written back, and summed up. */

const plain: AgencyDispositionEntry = { code: 'spoke', label: 'Spoke' };

/** Entries in shapes the editors produce or a server may hold, beyond the built-ins and presets. */
const ODD: AgencyDispositionEntry[] = [
  { code: 'spoke', label: 'Spoke' },
  { code: 'both', label: 'Both', suppress: true, terminal: true },
  { code: 'promise_retry', label: 'Promise, retry', requires_promise: true, retry: { delay_minutes: 60, max_attempts: 1 } },
  { code: 'promise_close', label: 'Promise, close', requires_promise: true, terminal: true, is_success: true },
  { code: 'promise_follow', label: 'Promise, follow', requires_promise: true, promise_follow_up_days: 3 },
  { code: 'late_close', label: 'Late close', requires_datetime: true, terminal: true },
  { code: 'never', label: 'Never retried', retry: { max_attempts: 0 } },
  { code: 'no_delay', label: 'No delay', retry: { max_attempts: 3 } },
  { code: 'odd_delay', label: 'Odd delay', retry: { delay_minutes: 90, max_attempts: 7 }, requires_note: true },
  { code: 'granting', label: 'Granting', override: { extra_attempts: 2, calling_hours: true }, icon: 'question' },
  { code: 'explicit_false', label: 'Explicit false', is_success: false, requires_note: false, terminal: false },
  // A key this console does not know is carried through as it came.
  { code: 'future', label: 'Future', future_flag: 'x' } as unknown as AgencyDispositionEntry,
];

const EVERY_ENTRY: AgencyDispositionEntry[] = [
  ...DEFAULT_DISPOSITIONS.map((e) => ({ ...e })),
  ...collectionsStarterOutcomes(),
  ...PURPOSE_PRESETS.flatMap((p) => p.outcomes()),
  ...ODD,
];

function rule(patch: Partial<OutcomeRule>): OutcomeRule {
  return { action: 'nothing', retryDelayMinutes: 240, retryMaxAttempts: 2, success: false, note: false, ...patch };
}

/** The catalogue findings `validateConfig` has for one entry. */
function findings(entry: AgencyDispositionEntry): Record<string, string> {
  const all = validateConfig({ ...emptyCampaignConfig(), dispositions: [entry] });
  return Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('disposition_catalog')));
}

describe('ruleOf', () => {
  it.each<[string, AgencyDispositionEntry, OutcomeAction]>([
    ['Do Not Call', { code: 'a', label: 'A', suppress: true }, 'dnc'],
    ['Do Not Call beside an end, which it beats', { code: 'a', label: 'A', suppress: true, terminal: true }, 'dnc'],
    ['a promise', { code: 'a', label: 'A', requires_promise: true }, 'promise'],
    ['a promise on a closing outcome', { code: 'a', label: 'A', requires_promise: true, terminal: true }, 'promise'],
    ['an end', { code: 'a', label: 'A', terminal: true }, 'finish'],
    ['an end beside a callback time, which it beats', { code: 'a', label: 'A', terminal: true, requires_datetime: true }, 'finish'],
    ['a callback time', { code: 'a', label: 'A', requires_datetime: true }, 'callback'],
    ['a callback time beside a retry, which it beats', { code: 'a', label: 'A', requires_datetime: true, retry: { max_attempts: 2 } }, 'callback'],
    ['a retry', { code: 'a', label: 'A', retry: { delay_minutes: 30, max_attempts: 2 } }, 'retry'],
    ['a retry of 0 tries, which is a plain outcome', { code: 'a', label: 'A', retry: { max_attempts: 0 } }, 'nothing'],
    ['a plain outcome', plain, 'nothing'],
  ])('reads %s', (_name, entry, action) => {
    expect(ruleOf(entry).action).toBe(action);
  });

  it('reads the retry, success and note', () => {
    expect(ruleOf({ code: 'a', label: 'A', retry: { delay_minutes: 30, max_attempts: 5 }, is_success: true, requires_note: true })).toEqual({
      action: 'retry',
      retryDelayMinutes: 30,
      retryMaxAttempts: 5,
      success: true,
      note: true,
    });
  });

  it('offers the voicemail default retry where the entry has none, and reads a missing delay as 0', () => {
    expect(ruleOf(plain)).toMatchObject({ retryDelayMinutes: 240, retryMaxAttempts: 2, success: false, note: false });
    expect(ruleOf({ code: 'a', label: 'A', retry: { max_attempts: 3 } })).toMatchObject({ retryDelayMinutes: 0, retryMaxAttempts: 3 });
    expect(ruleOf({ code: 'a', label: 'A', retry: { max_attempts: 0 } }).retryMaxAttempts).toBe(2);
  });
});

describe('withRule', () => {
  it('round-trips every built-in, Collections, preset and odd entry without loss, as the same object', () => {
    for (const entry of EVERY_ENTRY) {
      const copy = structuredClone(entry);
      const back = withRule(entry, ruleOf(entry));
      expect(back, entry.code).toBe(entry);
      expect(entry, entry.code).toStrictEqual(copy);
    }
  });

  it('sets each action on a plain entry, keeping its own fields', () => {
    const base: AgencyDispositionEntry = { code: 'x', label: 'X', icon: 'check' };
    expect(withRule(base, rule({ action: 'retry', retryDelayMinutes: 60, retryMaxAttempts: 3 }))).toStrictEqual({
      code: 'x', label: 'X', icon: 'check', retry: { delay_minutes: 60, max_attempts: 3 },
    });
    expect(withRule(base, rule({ action: 'callback' }))).toStrictEqual({ code: 'x', label: 'X', icon: 'check', requires_datetime: true });
    expect(withRule(base, rule({ action: 'promise' }))).toStrictEqual({ code: 'x', label: 'X', icon: 'check', requires_promise: true });
    expect(withRule(base, rule({ action: 'finish' }))).toStrictEqual({ code: 'x', label: 'X', icon: 'check', terminal: true });
    expect(withRule(base, rule({ action: 'dnc' }))).toStrictEqual({ code: 'x', label: 'X', icon: 'check', suppress: true });
    expect(withRule(base, rule({ action: 'nothing' }))).toBe(base);
  });

  it('clears the old action when the action changes: a promise and its follow-up go with it', () => {
    const entry: AgencyDispositionEntry = { code: 'p', label: 'P', requires_promise: true, promise_follow_up_days: 3, is_success: true };
    expect(withRule(entry, rule({ action: 'callback', success: true }))).toStrictEqual({
      code: 'p', label: 'P', is_success: true, requires_datetime: true,
    });
    expect(withRule({ code: 'c', label: 'C', requires_datetime: true, terminal: true }, rule({ action: 'dnc' }))).toStrictEqual({
      code: 'c', label: 'C', suppress: true,
    });
  });

  it('drops an override where calls stop, and keeps it elsewhere', () => {
    const granting: AgencyDispositionEntry = { code: 'g', label: 'G', override: { extra_attempts: 2 } };
    expect(withRule(granting, rule({ action: 'finish' }))).toStrictEqual({ code: 'g', label: 'G', terminal: true });
    expect(withRule(granting, rule({ action: 'dnc' }))).toStrictEqual({ code: 'g', label: 'G', suppress: true });
    expect(withRule(granting, rule({ action: 'callback' }))).toStrictEqual({
      code: 'g', label: 'G', override: { extra_attempts: 2 }, requires_datetime: true,
    });
  });

  it('writes a changed retry, keeping the rule’s other keys and the entry’s', () => {
    const entry: AgencyDispositionEntry = { code: 'v', label: 'V', retry: { max_attempts: 2 }, icon: 'voicemail' };
    expect(withRule(entry, rule({ action: 'retry', retryDelayMinutes: 0, retryMaxAttempts: 2 }))).toBe(entry);
    expect(withRule(entry, rule({ action: 'retry', retryDelayMinutes: 120, retryMaxAttempts: 4 }))).toStrictEqual({
      code: 'v', label: 'V', icon: 'voicemail', retry: { delay_minutes: 120, max_attempts: 4 },
    });
  });

  it('keeps a promise’s retry and closing while the action stays a promise', () => {
    const entry: AgencyDispositionEntry = { code: 'p', label: 'P', requires_promise: true, retry: { delay_minutes: 60, max_attempts: 1 } };
    expect(withRule(entry, { ...ruleOf(entry), success: true })).toStrictEqual({ ...entry, is_success: true });
  });

  it('turns success and the note on and off', () => {
    const on = withRule(plain, rule({ success: true, note: true }));
    expect(on).toStrictEqual({ code: 'spoke', label: 'Spoke', is_success: true, requires_note: true });
    expect(withRule(on, rule({}))).toStrictEqual(plain);
  });

  it('keeps a built-in’s flag: the action of voicemail, callback and do_not_call cannot change', () => {
    expect(lockedAction('voicemail')).toBe('retry');
    expect(lockedAction('callback')).toBe('callback');
    expect(lockedAction('do_not_call')).toBe('dnc');
    expect(lockedAction('will_pay')).toBeNull();
    for (const entry of DEFAULT_DISPOSITIONS) {
      for (const action of OUTCOME_ACTIONS) {
        const next = withRule(entry, { ...ruleOf(entry), action });
        expect(ruleOf(next).action, `${entry.code} → ${action}`).toBe(ruleOf(entry).action);
      }
    }
    // The flags still change.
    expect(withRule(DEFAULT_DISPOSITIONS[2]!, { ...ruleOf(DEFAULT_DISPOSITIONS[2]!), note: true })).toMatchObject({ suppress: true, requires_note: true });
  });

  it('never makes an entry the contracts or validateConfig refuse, from any entry, by any choice', () => {
    for (const entry of EVERY_ENTRY) {
      for (const action of OUTCOME_ACTIONS) {
        for (const success of [false, true]) {
          const next = withRule(entry, { ...ruleOf(entry), action, success, note: !success });
          const label = `${entry.code} → ${action}`;
          expect(findings(entry), entry.code).toEqual({});
          expect(findings(next), label).toEqual({});
          // The server's built-in rule: these codes keep the flag their label promises.
          if (next.code === 'voicemail') expect(next.retry, label).toBeDefined();
          if (next.code === 'callback') expect(next.requires_datetime, label).toBe(true);
          if (next.code === 'do_not_call') expect(next.suppress, label).toBe(true);
          if (next.requires_promise) {
            expect(next.requires_datetime, label).toBeFalsy();
            expect(next.suppress, label).toBeFalsy();
          }
          if (next.suppress || next.terminal) expect(next.override, label).toBeUndefined();
          if (next.promise_follow_up_days !== undefined) expect(next.requires_promise, label).toBe(true);
        }
      }
    }
  });
});

describe('ruleSummary', () => {
  it('sums up the Collections set', () => {
    expect(collectionsStarterOutcomes().map(ruleSummary)).toEqual([
      'Agent picks pay date & amount · counts as success · no follow-up call',
      'Agent picks a time · call back then',
      'Try again after 4 hours, up to 2 times',
      'Agent writes a note · no follow-up call',
      'Stop calling',
      'Never call again (Do Not Call)',
    ]);
  });

  it('follows the server’s precedence', () => {
    expect(ruleSummary({ code: 'a', label: 'A', suppress: true, terminal: true })).toBe('Never call again (Do Not Call)');
    expect(ruleSummary({ code: 'a', label: 'A', terminal: true, requires_datetime: true })).toBe('Agent picks a time · stop calling');
    expect(ruleSummary({ code: 'a', label: 'A', requires_datetime: true, retry: { max_attempts: 2 } })).toBe('Agent picks a time · call back then');
    expect(ruleSummary({ code: 'a', label: 'A', retry: { max_attempts: 0 } })).toBe('No follow-up call');
    expect(ruleSummary({ code: 'a', label: 'A', retry: { max_attempts: 1 } })).toBe('Try again after 0 minutes, up to 1 time');
    expect(ruleSummary({ code: 'a', label: 'A', requires_promise: true, promise_follow_up_days: 1 }))
      .toBe('Agent picks pay date & amount · call again 1 day after the pay date');
    expect(ruleSummary({ code: 'a', label: 'A', requires_promise: true, promise_follow_up_days: 3, terminal: true }))
      .toBe('Agent picks pay date & amount · stop calling');
    expect(outcomeFate({ code: 'a', label: 'A', is_success: true })).toBe('no follow-up call');
  });
});

describe('the choices', () => {
  it('words a wait and a count', () => {
    expect(delayLabel(1)).toBe('1 minute');
    expect(delayLabel(15)).toBe('15 minutes');
    expect(delayLabel(60)).toBe('1 hour');
    expect(delayLabel(240)).toBe('4 hours');
    expect(delayLabel(90)).toBe('1 hour 30 minutes');
    expect(delayLabel(1440)).toBe('1 day');
    expect(delayLabel(4320)).toBe('3 days');
    expect(delayLabel(0)).toBe('0 minutes');
    expect(attemptsLabel(1)).toBe('1 time');
    expect(attemptsLabel(3)).toBe('3 times');
  });

  it('offers the usual choices, with a loaded value added in its place', () => {
    expect(delayOptions(240).map((o) => o.value)).toEqual(RETRY_DELAY_CHOICES.map(String));
    expect(delayOptions(90).map((o) => o.value)).toEqual(['15', '30', '60', '90', '120', '240', '480', '1440', '2880', '4320']);
    expect(delayOptions(90).find((o) => o.value === '90')?.label).toBe('1 hour 30 minutes');
    expect(attemptOptions(2).map((o) => o.value)).toEqual(RETRY_ATTEMPT_CHOICES.map(String));
    expect(attemptOptions(7).map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '10']);
    expect(attemptOptions(20).at(-1)).toEqual({ value: '20', label: '20 times' });
  });
});
