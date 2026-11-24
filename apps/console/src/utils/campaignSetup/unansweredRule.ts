import { AGENCY_UNANSWERED_RETRY_DEFAULTS } from '@magick-agency/contracts/agency';
import type { AgencyRetryPolicy, AgencyRetryRule } from '../../types/agency-campaign';
import { joinAnd } from '../agencyCampaignConfigForm';
import { plural } from '../format/number';
import { delayLabel, optionsOf, type RuleOption } from './ruleOptions';

/*
  One "doesn't pick up" rule (CS12): the sentence on step 4 that writes one retry rule to every
  customer-side unanswered result, while the agent-side (our-fault) rows and the fixed-zero rows
  keep their own. The full table stays in Advanced (`RetryPolicyTable`).

  ── Which results are "the customer doesn't pick up" ─────────────────────────
  Of `RETRY_OUTCOMES`, the ones the customer's side produces without a conversation, as the
  server's outcome classifier assigns them:
   - `no_answer`: it rang out, or the customer declined (a far-end reject arrives as no answer);
   - `busy`: the line was busy, and a switched-off phone, which the carrier reports as busy
     (`OUTCOME_DISPOSITIONS_SWITCHED_OFF_NOTE`);
   - `failed`: the call could not be put through (not reachable, a network failure), anything
     the carrier did not call an invalid number.
  Not included: `abandoned` (the customer answered and no agent was free: ours), `invalid` and
  `connected` (fixed at zero), `agent_disconnected` and `canceled` (our fault, with their own
  bound).

  ── What `max_attempts` counts ───────────────────────────────────────────────
  The contact's calls in all, this one included: the server charges the attempt and then retries
  while `attempts used < max_attempts`. So `max_attempts: 3` is the first call and two more, which
  is why the sentence says "up to 3 calls in all" and not "try again 3 times".

  ── An unset row is the server's default, not "never" ────────────────────────
  The server falls back per key to its built-in policy (`DEFAULT_RETRY_POLICY` in the server's
  `agency/retry-policy.ts`) when a campaign leaves an outcome unset, which every new campaign
  does. {@link SERVER_DEFAULT_UNANSWERED_RULES} is that table's three rows: the contract's
  `AGENCY_UNANSWERED_RETRY_DEFAULTS`, which the server's table is built from.
*/

export const UNANSWERED_OUTCOMES = ['no_answer', 'busy', 'failed'] as const;
export type UnansweredOutcome = (typeof UNANSWERED_OUTCOMES)[number];

/** What the server uses for each of the three when the campaign leaves it unset. */
export const SERVER_DEFAULT_UNANSWERED_RULES: Readonly<Record<UnansweredOutcome, Required<AgencyRetryRule>>> =
  AGENCY_UNANSWERED_RETRY_DEFAULTS;

/** How the step names each result in its own copy. */
export const UNANSWERED_LABELS: Readonly<Record<UnansweredOutcome, string>> = {
  no_answer: 'No answer',
  busy: 'Busy or switched off',
  failed: 'Can’t connect',
};

/** The results as the mixed summary names them, inside a sentence. */
const SUMMARY_NAMES: Readonly<Record<UnansweredOutcome, string>> = {
  no_answer: 'no answer',
  busy: 'busy',
  failed: 'calls that can’t connect',
};

export interface OneUnansweredRule {
  /** The contact's calls in all, the first one included (`max_attempts`). */
  maxAttempts: number;
  /** Minutes between calls (`delay_minutes`; unset is 0, as the server reads it). */
  delayMinutes: number;
}

export type UnansweredRule =
  | ({ kind: 'same' } & OneUnansweredRule)
  | {
      kind: 'mixed';
      /** "Busy has a different rule from no answer and calls that can’t connect". */
      summary: string;
      /** One line per result, in order: "No answer: up to 3 calls in all, 1 hour apart (default)". */
      details: string[];
    };

interface Effective extends OneUnansweredRule {
  /** The campaign leaves it unset: the server's default applies. */
  isDefault: boolean;
}

function effectiveRule(policy: AgencyRetryPolicy, outcome: UnansweredOutcome): Effective {
  const own = policy[outcome];
  const rule = own ?? SERVER_DEFAULT_UNANSWERED_RULES[outcome];
  return {
    maxAttempts: rule.max_attempts,
    delayMinutes: Number.isFinite(rule.delay_minutes) ? Math.max(0, rule.delay_minutes!) : 0,
    isDefault: own === undefined,
  };
}

const sameRule = (a: OneUnansweredRule, b: OneUnansweredRule) =>
  a.maxAttempts === b.maxAttempts && a.delayMinutes === b.delayMinutes;

/** The three results' rule, when they share one; otherwise how they differ. */
export function unansweredRuleOf(policy: AgencyRetryPolicy): UnansweredRule {
  const rules = UNANSWERED_OUTCOMES.map((outcome) => ({ outcome, rule: effectiveRule(policy, outcome) }));
  const first = rules[0]!.rule;
  if (rules.every(({ rule }) => sameRule(rule, first))) {
    return { kind: 'same', maxAttempts: first.maxAttempts, delayMinutes: first.delayMinutes };
  }
  // Group the results that share a rule, in order of first appearance.
  const groups: UnansweredOutcome[][] = [];
  for (const { outcome, rule } of rules) {
    const group = groups.find((g) => sameRule(effectiveRule(policy, g[0]!), rule));
    if (group) group.push(outcome);
    else groups.push([outcome]);
  }
  let summary: string;
  if (groups.length === 2) {
    const odd = groups.find((g) => g.length === 1)!;
    const rest = groups.find((g) => g !== odd)!;
    const named = SUMMARY_NAMES[odd[0]!];
    summary = `${named[0]!.toUpperCase()}${named.slice(1)} has a different rule from ${joinAnd(rest.map((o) => SUMMARY_NAMES[o]))}`;
  } else {
    summary = `Different rules for ${joinAnd(UNANSWERED_OUTCOMES.map((o) => SUMMARY_NAMES[o]))}`;
  }
  const details = rules.map(
    ({ outcome, rule }) =>
      `${UNANSWERED_LABELS[outcome]}: ${ruleSentence(rule)}${rule.isDefault ? ' (default)' : ''}`,
  );
  return { kind: 'mixed', summary, details };
}

/** "up to 3 calls in all, 2 hours apart", "not called again". */
export function ruleSentence(rule: OneUnansweredRule): string {
  if (rule.maxAttempts <= 1) return 'not called again';
  return `up to ${attemptsLabel(rule.maxAttempts)} in all, ${delayLabel(rule.delayMinutes)} apart`;
}

/**
 * The policy with one rule on the three unanswered results. Every other key, and anything else
 * on those rows, is kept: the our-fault rows (`agent_disconnected`, `canceled`), `abandoned`,
 * and the fixed-zero `connected` (and any `invalid` a campaign was loaded with) are untouched.
 */
export function withUnansweredRule(policy: AgencyRetryPolicy, rule: OneUnansweredRule): AgencyRetryPolicy {
  const next: AgencyRetryPolicy = { ...policy };
  for (const outcome of UNANSWERED_OUTCOMES) {
    next[outcome] = { ...policy[outcome], max_attempts: rule.maxAttempts, delay_minutes: rule.delayMinutes };
  }
  return next;
}

/* ── The two selects ──────────────────────────────────────────────────────── */

/** Calls in all, 1–10 (the validator allows 0–20). */
const ATTEMPT_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** Minutes between calls. */
const DELAY_CHOICES = [15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880] as const;

/**
 * "3 calls", "1 call". A stored 0 ("never retried", which only the API can set) is the first call
 * alone, as 1 is, and says so.
 */
export function attemptsLabel(maxAttempts: number): string {
  if (maxAttempts <= 0) return '1 call (no retry)';
  return plural(maxAttempts, 'call');
}

/** The "calls in all" select. `current` is kept as an option so a loaded rule is never rewritten. */
export function attemptOptions(current: number | null = null): RuleOption[] {
  return optionsOf(ATTEMPT_CHOICES, current, attemptsLabel);
}

/** The "how long until the next call" select, with the current value kept as for attempts. */
export function delayOptions(current: number | null = null): RuleOption[] {
  return optionsOf(DELAY_CHOICES, current, delayLabel);
}

/**
 * The rule a mixed campaign starts from when the supervisor picks one in the sentence: no
 * answer's own (the commonest result), so one choice does not also reset the other.
 */
export function startingRuleOf(policy: AgencyRetryPolicy): OneUnansweredRule {
  const { maxAttempts, delayMinutes } = effectiveRule(policy, 'no_answer');
  return { maxAttempts, delayMinutes };
}
