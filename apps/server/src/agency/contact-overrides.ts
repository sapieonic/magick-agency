/**
 * Outcome-granted overrides and the agent's own dial of one of their contacts (contact
 * assignment, phase 2): the pure rules. Every write that applies them is a guarded statement
 * in the agency repository; this module only decides.
 *
 *  - {@link overrideGrantOf}: what a catalog entry's `override` grants, normalised (decision CA8).
 *  - {@link applyExtraAttemptOverride}: a max-attempts exhaustion that an unspent
 *    `extra_attempts` turns into one more scheduled try (CA8 spend).
 *  - {@link validateOverrideNoteText}: the calling-hours note, counted as the soft phone counts
 *    its SP2 note (trimmed, code points, 10–500).
 *  - {@link chooseAgentDialBasis}: why an agent may dial one of their contacts now, and what
 *    the dial spends (CA7).
 *
 * DNC is never overridable: nothing here reads or grants anything about it, and every caller
 * keeps its DNC refusal ahead of these rules.
 */
import {
  AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX,
  AGENCY_OVERRIDE_NOTE_MAX,
  AGENCY_OVERRIDE_NOTE_MIN,
  type AgencyAttemptOutcome,
  type AgencyContactState,
  type AgencyDisposition,
} from '@magick-agency/contracts/agency';
import type { AgencyRetryPolicy } from '../db/models/agency.model.js';
import type { AgencyAgentRetryBlock } from '@magick-agency/contracts/api/agency/assignment';
import { DEFAULT_RETRY_POLICY } from './retry-policy.js';

// ─── Grant ──────────────────────────────────────────────────────────────────

/** The `override_*` columns a granting outcome writes (all of them: a grant REPLACES). */
export interface OverrideGrant {
  extraAttempts: number;
  retryDelay: boolean;
  callingHours: boolean;
}

/**
 * What `entry.override` grants, or null when it grants nothing (absent, malformed, every part
 * off, or on an entry that `suppress`es or is `terminal`: those can never be dialled again, and
 * the campaign validator refuses the combination; this is the runtime's own floor).
 * `extra_attempts` is truncated and clamped to 0–{@link AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX},
 * the column's CHECK, so a hand-edited catalog cannot fail the disposition's write.
 */
export function overrideGrantOf(entry: Pick<AgencyDisposition, 'override' | 'suppress' | 'terminal'>): OverrideGrant | null {
  const o = entry.override as unknown;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (entry.suppress === true || entry.terminal === true) return null;
  const raw = (o as Record<string, unknown>)['extra_attempts'];
  const extra = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(AGENCY_OVERRIDE_EXTRA_ATTEMPTS_MAX, Math.max(0, Math.trunc(raw)))
    : 0;
  const grant: OverrideGrant = {
    extraAttempts: extra,
    retryDelay: (o as Record<string, unknown>)['retry_delay'] === true,
    callingHours: (o as Record<string, unknown>)['calling_hours'] === true,
  };
  return grant.extraAttempts > 0 || grant.retryDelay || grant.callingHours ? grant : null;
}

// ─── Spend: extra attempts ──────────────────────────────────────────────────

/**
 * The decision reasons that mean "the retry rule's `max_attempts` is spent": the outcome
 * policy's (`resolveRetryDecision`) and a disposition `retry`'s (`resolveDispositionDecision`).
 * The only exhaustion an `extra_attempts` override can turn into another try. The our-fault
 * ledger's retirement (`our_fault_bound_reached`) is deliberately not here: that bound is the
 * platform's ceiling on redials WE caused, never the customer's allowance.
 */
export const MAX_ATTEMPTS_EXHAUSTION_REASONS: ReadonlySet<string> = new Set([
  'max_attempts_reached',
  'disposition_attempts_reached',
]);

/** The fields of a retry or disposition decision this rule reads and may rewrite. */
export interface SpendableDecision {
  contactState: AgencyContactState;
  nextAttemptAt: Date | null;
  reason: string;
}

/**
 * Apply an unspent `extra_attempts` override to a decision (CA8 spend).
 *
 * When `decision` exhausts the contact because the rule's `max_attempts` is spent and
 * `remaining > 0`, the contact stays `pending`, due after the rule's own delay, and one extra
 * attempt is spent. Anything else (a retry under the cap, a callback, a suppression, a
 * completion, an our-fault retirement, nothing left) is returned unchanged with `spent: false`.
 *
 * `remaining` is what the contact holds NOW, read under the row lock the write takes; the
 * write decrements it, never below 0.
 */
export function applyExtraAttemptOverride<D extends SpendableDecision>(
  decision: D,
  remaining: number,
  rule: { delayMinutes: number },
  now: Date,
): { decision: D; spent: boolean } {
  if (decision.contactState !== 'exhausted' || !MAX_ATTEMPTS_EXHAUSTION_REASONS.has(decision.reason)) {
    return { decision, spent: false };
  }
  if (!(Number.isFinite(remaining) && remaining > 0)) return { decision, spent: false };
  const delay = Number.isFinite(rule.delayMinutes) ? Math.max(0, rule.delayMinutes) : 0;
  return {
    decision: { ...decision, contactState: 'pending', nextAttemptAt: new Date(now.getTime() + delay * 60_000) },
    spent: true,
  };
}

/**
 * The delay of the outcome-policy rule `resolveRetryDecision` applied for `outcome`, in
 * minutes: the campaign's rule, else the default's, as that function resolves it. 0 when
 * there is none (an exhaustion is only ever produced by a rule, so this is a fallback).
 */
export function outcomeRuleDelayMinutes(policy: AgencyRetryPolicy | null, outcome: AgencyAttemptOutcome | null): number {
  if (!outcome) return 0;
  const rule = policy?.[outcome] ?? DEFAULT_RETRY_POLICY[outcome];
  const delay = rule?.delay_minutes;
  return typeof delay === 'number' && Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

/** The delay of a disposition `retry` rule, in minutes (0 when absent), as `resolveDispositionDecision` reads it. */
export function dispositionRuleDelayMinutes(entry: Pick<AgencyDisposition, 'retry'>): number {
  const delay = entry.retry?.delay_minutes;
  return typeof delay === 'number' && Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

// ─── The calling-hours note ─────────────────────────────────────────────────

/**
 * The note an agent gives to dial outside calling hours: trimmed, then 10–500 CHARACTERS
 * (code points, as `ck_agency_attempt_override_note`'s `char_length` counts; `.length` would
 * count an emoji twice). The trimmed text, or null when it is not a valid note. The soft
 * phone's `validateOverrideNote` applies the same rule to its SP2 note.
 */
export function validateOverrideNoteText(raw: unknown): string | null {
  return trimmedNoteWithin(raw, AGENCY_OVERRIDE_NOTE_MIN, AGENCY_OVERRIDE_NOTE_MAX);
}

// ─── Why an agent may dial one of their contacts now (CA7) ───────────────────

/**
 * What allows the dial, and so what it spends:
 *  - `due`: the contact is `pending` and due now. Spends nothing (pacing would dial it anyway;
 *    the agent only picks the order).
 *  - `retry_delay`: `pending`, not yet due, and it holds an unspent retry-delay override.
 *    Spends the override.
 *  - `retry_round`: it is retry-eligible (`agentRetryBlockSql` is NULL). Spends one of its
 *    agent retry rounds, and the retry-delay override too when that is what skipped an active
 *    cooldown.
 */
export type AgentDialBasis = 'due' | 'retry_delay' | 'retry_round';

/** The contact facts {@link chooseAgentDialBasis} reads, from one SQL evaluation. */
export interface AgentDialFacts {
  state: AgencyContactState;
  /** `suppressed_reason = 'dnc'`. */
  dnc: boolean;
  /** `pending` and `next_attempt_at <= now()`. */
  due: boolean;
  overrideRetryDelay: boolean;
  /** `agentRetryBlockSql`: NULL when retry-eligible. */
  retryBlock: AgencyAgentRetryBlock | null;
  /** The cooldown end, for a `cooldown` block. */
  availableAt: Date | null;
}

export type AgentDialChoice =
  | { ok: true; basis: AgentDialBasis }
  | { ok: false; reason: 'in_flight' }
  | { ok: false; reason: 'not_retryable'; blocked: AgencyAgentRetryBlock; availableAt: Date | null };

/**
 * Choose the basis of an agent's dial of one of their own contacts, or why there is none. In
 * order: suppressed (DNC or otherwise) never; on a call or held for a write-up is
 * `in_flight`; then `due`, `retry_delay`, `retry_round` (cheapest spend first); else the
 * retry rule's block (`retry_disabled` when the campaign does not allow agent retry, which
 * only matters for a contact that is neither due nor holding a retry-delay override).
 */
export function chooseAgentDialBasis(facts: AgentDialFacts): AgentDialChoice {
  if (facts.dnc || facts.state === 'suppressed') {
    return { ok: false, reason: 'not_retryable', blocked: 'suppressed', availableAt: null };
  }
  if (facts.state === 'in_flight' || facts.state === 'connected') return { ok: false, reason: 'in_flight' };
  if (facts.state === 'pending' && facts.due) return { ok: true, basis: 'due' };
  if (facts.state === 'pending' && facts.overrideRetryDelay) return { ok: true, basis: 'retry_delay' };
  if (facts.retryBlock === null && (facts.state === 'pending' || facts.state === 'exhausted')) {
    return { ok: true, basis: 'retry_round' };
  }
  const blocked = facts.retryBlock ?? 'not_retryable';
  return {
    ok: false,
    reason: 'not_retryable',
    blocked,
    availableAt: blocked === 'cooldown' ? facts.availableAt : null,
  };
}

// ─── One rule for an override note's length ─────────────────────────────────

/**
 * An override note's text: `raw` trimmed, when it is a string of `min`–`max` CHARACTERS (code
 * points, as the database's `char_length` checks count; `.length` would count an emoji
 * twice); else null. {@link validateOverrideNoteText} and the soft phone's
 * `validateOverrideNote` both count through this.
 */
export function trimmedNoteWithin(raw: unknown, min: number, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const note = raw.trim();
  const length = [...note].length;
  return length >= min && length <= max ? note : null;
}
