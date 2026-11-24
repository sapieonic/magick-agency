import type { AgencyDispositionEntry } from '../../types/agency-campaign';
import { DEFAULT_DISPOSITION_RETRY, isBuiltInCode } from '../agencyCampaignConfigForm';
import { plural } from '../format/number';
import { delayLabel, optionsOf, type RuleOption } from './ruleOptions';

/**
 * One button's rule as a sentence (CS3): "When the agent picks *No one spoke* → *try again after
 * 4 hours, up to 2 times*. Then stop calling. Counts as success: *No*." Pure.
 *
 * Each choice in the sentence is a field the outcome entry already has (`retry`,
 * `requires_datetime`, `requires_promise`, `terminal`, `suppress`, `is_success`,
 * `requires_note`). Everything else on the entry (the code, `icon`, `override`,
 * `promise_follow_up_days`, keys this console does not know) is the entry's own and survives
 * {@link withRule} untouched, unless a new choice makes it one the server refuses (an override on
 * an outcome that stops calling; a promise follow-up without a promise).
 *
 * ── What happens, by the server's precedence ─────────────────────────────────
 * The server decides an outcome by `suppress`, then `terminal`, then a callback time, then the
 * outcome's own `retry`; anything else ends the contact on this campaign. A promise to pay books
 * nothing by itself (PT3). {@link ruleOf} names the one choice that describes the entry, and
 * {@link ruleSummary} states what actually happens, in that order.
 */

/** What happens when the agent picks the button: the sentence's first choice. */
export type OutcomeAction = 'retry' | 'callback' | 'promise' | 'finish' | 'dnc' | 'nothing';

export interface OutcomeRule {
  action: OutcomeAction;
  /** Read only while `action` is `retry`. */
  retryDelayMinutes: number;
  /** Read only while `action` is `retry`; 1 or more. */
  retryMaxAttempts: number;
  success: boolean;
  note: boolean;
}

/** The action choices, in the order the sentence offers them. */
export const OUTCOME_ACTION_LABELS: Readonly<Record<OutcomeAction, string>> = {
  retry: 'try again',
  callback: 'call back at a time the agent picks',
  promise: 'record a promise to pay',
  finish: 'stop calling',
  dnc: 'never call again (Do Not Call)',
  nothing: 'nothing special',
};

export const OUTCOME_ACTIONS: readonly OutcomeAction[] = ['retry', 'callback', 'promise', 'finish', 'dnc', 'nothing'];

/**
 * The action a built-in code must keep: the server refuses `voicemail` without `retry`, `callback`
 * without `requires_datetime` and `do_not_call` without `suppress` (its built-in mismatch rule),
 * because the label would promise what the entry cannot do.
 */
export const BUILT_IN_ACTION: Readonly<Record<string, OutcomeAction>> = {
  voicemail: 'retry',
  callback: 'callback',
  do_not_call: 'dnc',
};

/** The action this built-in code must keep, or `null` for any other code. */
export function lockedAction(code: string): OutcomeAction | null {
  return isBuiltInCode(code) ? BUILT_IN_ACTION[code] ?? null : null;
}

/** The entry as a sentence. */
export function ruleOf(entry: AgencyDispositionEntry): OutcomeRule {
  const retry = entry.retry;
  return {
    action: actionOf(entry),
    retryDelayMinutes: retry ? retry.delay_minutes ?? 0 : DEFAULT_DISPOSITION_RETRY.delay_minutes ?? 0,
    retryMaxAttempts: retry && retry.max_attempts > 0 ? retry.max_attempts : DEFAULT_DISPOSITION_RETRY.max_attempts,
    success: entry.is_success === true,
    note: entry.requires_note === true,
  };
}

function actionOf(entry: AgencyDispositionEntry): OutcomeAction {
  if (entry.suppress) return 'dnc';
  // Ahead of `terminal`: a closing outcome may still record a promise, and the promise is what
  // the agent is asked for. The summary says the contact stops.
  if (entry.requires_promise) return 'promise';
  if (entry.terminal) return 'finish';
  if (entry.requires_datetime) return 'callback';
  // `max_attempts: 0` is "never retried", which the server treats as a plain outcome.
  if (entry.retry && entry.retry.max_attempts > 0) return 'retry';
  return 'nothing';
}

/** The fields the sentence's first choice governs. */
const ACTION_KEYS = ['retry', 'requires_datetime', 'requires_promise', 'promise_follow_up_days', 'terminal', 'suppress'] as const;

/**
 * `rule` applied to `entry`.
 *
 * - **Lossless on a round trip:** `withRule(e, ruleOf(e))` equals `e`. While the action stays the
 *   same its fields are kept as they are (a promise that also retries, a callback that also ends
 *   the contact); only a changed retry delay or count is written.
 * - **Never a refused shape:** a new action clears the other actions' fields first, so a promise
 *   never sits beside a callback time or Do Not Call, and a follow-up never outlives its promise.
 *   Stopping calls drops an `override` (the server refuses one there).
 * - **A built-in keeps its flag:** a new action that would take `voicemail`'s retry,
 *   `callback`'s time or `do_not_call`'s Do Not Call away is ignored ({@link lockedAction}).
 *
 * Returns the same object when nothing changes.
 */
export function withRule(entry: AgencyDispositionEntry, rule: OutcomeRule): AgencyDispositionEntry {
  const current = ruleOf(entry);
  const locked = lockedAction(entry.code);
  const action = locked !== null && rule.action !== locked ? current.action : rule.action;

  let next: AgencyDispositionEntry = entry;
  if (action !== current.action) {
    next = withAction(entry, action, rule);
  } else if (action === 'retry') {
    const retry = entry.retry ?? { ...DEFAULT_DISPOSITION_RETRY };
    if ((retry.delay_minutes ?? 0) !== rule.retryDelayMinutes || retry.max_attempts !== rule.retryMaxAttempts) {
      next = { ...entry, retry: { ...retry, delay_minutes: rule.retryDelayMinutes, max_attempts: rule.retryMaxAttempts } };
    }
  }

  next = withFlag(next, 'is_success', rule.success);
  next = withFlag(next, 'requires_note', rule.note);
  return next;
}

function withAction(entry: AgencyDispositionEntry, action: OutcomeAction, rule: OutcomeRule): AgencyDispositionEntry {
  const rest: Record<string, unknown> = { ...entry };
  for (const key of ACTION_KEYS) delete rest[key];
  const base = rest as unknown as AgencyDispositionEntry;
  switch (action) {
    case 'retry':
      return { ...base, retry: { delay_minutes: rule.retryDelayMinutes, max_attempts: Math.max(1, rule.retryMaxAttempts) } };
    case 'callback':
      return { ...base, requires_datetime: true };
    case 'promise':
      return { ...base, requires_promise: true };
    case 'finish':
      return withoutOverride({ ...base, terminal: true });
    case 'dnc':
      return withoutOverride({ ...base, suppress: true });
    case 'nothing':
      return base;
  }
}

function withoutOverride(entry: AgencyDispositionEntry): AgencyDispositionEntry {
  if (!('override' in entry)) return entry;
  const { override: _override, ...rest } = entry;
  void _override;
  return rest;
}

/** A yes/no flag set to `on`, leaving the entry alone when it already reads that way. */
function withFlag(entry: AgencyDispositionEntry, flag: 'is_success' | 'requires_note', on: boolean): AgencyDispositionEntry {
  if ((entry[flag] === true) === on) return entry;
  if (on) return { ...entry, [flag]: true };
  const rest: Record<string, unknown> = { ...entry };
  delete rest[flag];
  return rest as unknown as AgencyDispositionEntry;
}

// ── Words ─────────────────────────────────────────────────────────────────────

/** `1 time`, `3 times`. */
export function attemptsLabel(count: number): string {
  return plural(count, 'time');
}

/** The waits the sentence offers, in minutes. */
export const RETRY_DELAY_CHOICES: readonly number[] = [15, 30, 60, 120, 240, 480, 1440, 2880, 4320];

/** The counts the sentence offers. The server allows up to 20. */
export const RETRY_ATTEMPT_CHOICES: readonly number[] = [1, 2, 3, 4, 5, 6, 8, 10];

/** The wait options, with `current` added in its place when it is not one of them (a loaded value). */
export function delayOptions(current: number): RuleOption[] {
  return optionsOf(RETRY_DELAY_CHOICES, current, delayLabel);
}

/** The count options, with `current` added in its place when it is not one of them. */
export function attemptOptions(current: number): RuleOption[] {
  return optionsOf(RETRY_ATTEMPT_CHOICES, current, attemptsLabel);
}

/**
 * The grey one-liner under a button: what the agent is asked, whether it counts, and what then
 * happens to the customer, in the server's order ("Agent picks pay date & amount · counts as
 * success · no follow-up call").
 */
export function ruleSummary(entry: AgencyDispositionEntry): string {
  const parts: string[] = [];
  if (entry.requires_promise) parts.push('Agent picks pay date & amount');
  if (entry.requires_datetime) parts.push('Agent picks a time');
  if (entry.requires_note) parts.push('Agent writes a note');
  if (entry.is_success) parts.push('counts as success');
  parts.push(outcomeFate(entry));
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** {@link outcomeFate} of an outcome after which nothing calls the customer again. */
export const NO_FOLLOW_UP = 'no follow-up call';

/**
 * What then happens to the customer, by the server's precedence, in lower case: "stop calling",
 * "try again after 4 hours, up to 2 times", "no follow-up call".
 */
export function outcomeFate(entry: AgencyDispositionEntry): string {
  if (entry.suppress) return 'never call again (Do Not Call)';
  if (entry.terminal) return 'stop calling';
  if (entry.requires_datetime) return 'call back then';
  if (entry.retry && entry.retry.max_attempts > 0) {
    return `try again after ${delayLabel(entry.retry.delay_minutes ?? 0)}, up to ${attemptsLabel(entry.retry.max_attempts)}`;
  }
  if (entry.requires_promise && entry.promise_follow_up_days) {
    return `call again ${plural(entry.promise_follow_up_days, 'day')} after the pay date`;
  }
  return NO_FOLLOW_UP;
}
