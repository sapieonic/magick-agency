/**
 * The shared enumerations: agent, attempt, contact and campaign states, attempt
 * outcomes, abandon reasons.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the
 * contract's header (freeze rules, vocabulary).
 */

import type { AllListed } from '../primitives';

// ─── Shared enumerations ────────────────────────────────────────────────────

/**
 * Agent lifecycle. **Phase 1 implements `offline` / `available` /
 * `reserved` / `on_call` only**; `wrapup` and `break` are declared here so the
 * union never widens later (a widening union is a breaking change for every
 * exhaustive `switch` in the console), and are unreachable until Phase 2.
 */
export type AgencyAgentState =
  | 'offline'
  | 'available'
  | 'reserved'
  | 'on_call'
  | 'wrapup'
  | 'break';

/** Attempt lifecycle. `ended` is the single terminal state. */
export type AgencyAttemptState =
  | 'queued'
  | 'dialing'
  | 'ringing'
  | 'answered'
  | 'bridged'
  | 'ended';

/** Contact lifecycle. */
export type AgencyContactState =
  | 'pending'
  | 'in_flight'
  | 'connected'
  | 'completed'
  | 'exhausted'
  | 'suppressed';

/**
 * How an attempt finished, as classified from carrier events — never from AMD
 * (answering-machine detection is out of scope, so the system can never classify an outcome as
 * `machine`; a call answered by voicemail is `connected` and the ONLY signal it
 * was a machine is the agent's disposition).
 *
 * `machine` is nonetheless declared because the schema lists it as a legal column value
 * and a future AMD-enabled version would emit it. Nothing in v1 produces it.
 *
 * ── `canceled`: a dial WE stopped before anyone picked up ───────────────────
 *
 * Three facts that the pilot of 2026-09-08 proved are three, not one:
 *
 *   - `no_answer` — the ring completed and nobody picked up;
 *   - `canceled`  — we stopped the ring ourselves (an agent dismissing a ringing
 *     console, a supervisor stop landing mid-ring), so the customer was never
 *     given the chance to pick up and may not even have finished being rung;
 *   - `abandoned` — the customer DID pick up and reached nobody.
 *
 * Before this member the middle case had nowhere to go and
 * {@link classifyAttemptOutcome}'s `canceled`-status arm sent it to `abandoned`,
 * which is why ~19 of the pilot's abandoned rows are phantoms sitting in the same
 * column as the real ones. It is the *label* that was wrong, not the compliance
 * numerator — that has always been keyed on `isAbandonedAttempt`
 * (`abandonment-predicate.ts`), whose `answeredAt === null` arm already excluded
 * every cancelled ring — so this separates two facts without moving a metric.
 *
 * **No schema change is needed for it, and that is a property of the column rather
 * than an oversight.** `agency_call_attempts.outcome` is a bare `VARCHAR(30)`
 * with NO CHECK constraint; the vocabulary appears
 * in the baseline schema only as a trailing `--` comment, which enforces nothing.
 *
 * ⚠️ **Do not read that comment as the vocabulary.** It says
 * `connected|no_answer|busy|failed|machine|invalid|abandoned` and is wrong in both
 * directions: it lists `machine`, which nothing can produce while
 * answering-machine detection is out of scope, and omits
 * `agent_disconnected`, `orphaned` and `canceled`, all three of which are
 * produced constantly. This union is the vocabulary. Every gate on
 * this string is therefore TypeScript-side, and it is pinned in five places in
 * the server alone — `spine-filters.ts`'s `ATTEMPT_OUTCOMES` (the read surface's
 * inverted `Record` check), `retry-summary.ts`'s `OUTCOME_COPY`,
 * `retry-policy.ts`'s `DEFAULT_RETRY_POLICY`, `campaign-config.ts`'s
 * `RETRY_POLICY_OUTCOMES` and `outcome-classifier.ts` itself — plus the public API layer's
 * `RETRY_POLICY_OUTCOMES` and the console's `src/types/agency.ts`. Adding a member
 * means updating every one of those pins.
 */
export type AgencyAttemptOutcome =
  | 'connected'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'machine'
  | 'invalid'
  | 'abandoned'
  | 'agent_disconnected'
  | 'orphaned'
  | 'canceled';

/**
 * WHY an abandoned attempt reached no agent (`agency_call_attempts.abandon_reason`).
 *
 * A companion to {@link AgencyAttemptOutcome}, deliberately NOT a member of it.
 * The outcome vocabulary already says `abandoned` and the retry policy already
 * redials it; what was missing was the cause, and during a staged rollout the
 * causes call for opposite responses — `bind_failed` means roll back the flag,
 * `no_agent_available` means slow the pacing down.
 *
 * ⚠️ **This is diagnosis, never a definition.** The ratified abandonment
 * definition is `ABANDONED_ATTEMPT_PREDICATE_SQL` and its in-process twin, pinned
 * to each other by an agreement test; the compliance numerator keys on that and
 * must not start reading this. `abandon_reason IS NOT NULL` is not a substitute
 * for the predicate — the predicate deliberately catches abandoned attempts that
 * nobody labelled, which is how the gap was found.
 *
 * - `station_lost` — the agent's station was not there at the answer: either gone
 *   before we reached for the socket, or the `reserved` frame was refused. The
 *   two share a value because an operator cannot act on them differently; the
 *   WARN line's `announced` field keeps them apart.
 * - `bind_failed` — the socket was live and the bridge refused the bind. **The
 *   one that means roll the flag back**, as against slow the pacing down.
 * - `bridge_late` — it DID bridge, but outside `ABANDONMENT_BRIDGE_GRACE_MS`. A
 *   conversation happened; it was merely late.
 * - `unattributed` — abandoned by the predicate with no arm having observed a
 *   cause. **The honest residual, and it exists because the alternative caused a
 *   real defect**: the first version fell back to `no_agent_available`, so every
 *   station loss on the default (flag-off) path was reported as a pacing problem.
 *   Asserting a cause we did not observe is worse than admitting we did not.
 * - `no_agent_available` — a pacing controller dialed with nobody free.
 *   ⚠️ **Declared but UNPRODUCIBLE today**, on purpose and in the same spirit as
 *   `machine` in {@link AgencyAttemptOutcome}: pacing is strictly 1:1
 *   (`pacing-engine.ts` reserves agents before claiming contacts and bounds the
 *   target by `reserved.length`), and the dialer refuses to dial at all when the
 *   station has gone (`executeDial`'s pre-dial recheck). So no "we dialed and
 *   nobody was free" event can occur until over-dialing is built. Kept because it
 *   is the name for the thing an operator will need then — but note `machine`'s
 *   lesson: do not build configuration on an unproducible value.
 */
export type AgencyAbandonReason =
  | 'station_lost'
  | 'bind_failed'
  | 'bridge_late'
  | 'unattributed'
  | 'no_agent_available';

/**
 * The reason vocabulary as a value, for the Prometheus label set and any UI that
 * enumerates it.
 *
 * Two-sided exhaustiveness, the house pattern (`AGENCY_ACTION_ERROR_CODES`):
 * `satisfies` stops a member being listed that the union does not have, and
 * the `AllListed` guard below stops a union member being added without landing
 * here. A Prometheus label vocabulary must be bounded by source code.
 */
export const AGENCY_ABANDON_REASONS = [
  'station_lost',
  'bind_failed',
  'bridge_late',
  'unattributed',
  'no_agent_available',
] as const satisfies readonly AgencyAbandonReason[];

const _allAbandonReasonsListed: AllListed<
  AgencyAbandonReason,
  typeof AGENCY_ABANDON_REASONS
> = true;
void _allAbandonReasonsListed;

/** Campaign lifecycle. */
export type AgencyCampaignStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'completed'
  | 'stopped';
