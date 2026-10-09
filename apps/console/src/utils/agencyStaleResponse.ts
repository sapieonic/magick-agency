import type { AgencyDispositionResponse } from '../types/agency';

/**
 * The stale-submit guard (spec `bcc2890`, the seam between and).
 *
 * ── The leak ─────────────────────────────────────────────────────────────────
 * A disposition submit is in flight for hundreds of milliseconds, and
 * requires a new `reserved` to win whenever one arrives. So this ordering is not
 * exotic, it is routine:
 *
 *   1. the agent submits a disposition for **customer A**;
 *   2. a new `reserved` arrives for **customer B** — correctly;
 *   3. **A's `400` lands.**
 *
 * Every error clause then fires against the wrong contact while reading
 * perfectly correct in isolation. The serious one is *"the note text is
 * preserved"*: it restores **A's note into B's notes field**, where the agent may
 * save it against B. Cross-contact, silent, and undetectable afterwards — the
 * note simply looks like something the agent typed about B.
 *
 * ── Why the autosave is not the protection ───────────────────────────────────
 *'s `localStorage` autosave is keyed by `attempt_id` and is fine. The
 * danger is in **in-flight component state, which is keyed by nothing at all**:
 * a `notes` string in a `useState`, and a pending promise that will write to it.
 *
 * So the guard is positional rather than a matter of careful error handling: on
 * every response — **success or failure** — compare the attempt the request was
 * issued for against the attempt currently on the station. If they differ,
 * discard the whole response. No error render, no note restoration, no state
 * change of any kind, and log the discard.
 *
 * This is the same shape as the retry forbids for hang-up ("a retry
 * landing after a new `reserved` hangs up a different customer"). Written in two
 * files deliberately.
 */

/**
 * Captured **at submit time**, not read off the response.
 *
 * This matters and is easy to get wrong: `AgencyActionErrorResponse` is
 * `{ error, code, message, allowed_codes? }` and **carries no `attempt_id`**.
 * The failing path — the one that leaks — therefore has nothing in its body to
 * key off, so the attempt id has to be captured when the request is issued and
 * carried alongside the promise.
 */
export interface InFlightDisposition {
  /** The attempt this submit was issued for. */
  attemptId: string;
}

/**
 * Why a response was discarded.
 *
 * - `attempt_changed` — the routine case: a new `reserved` won while the submit
 *   was in flight. Expected traffic, not an error.
 * - `attempt_id_mismatch` — the response body names an attempt we did not submit
 *   for. Should never happen; discarding is the safe read.
 */
export type StaleDiscardReason = 'attempt_changed' | 'attempt_id_mismatch';

export type StaleResponseDecision =
  | { action: 'apply' }
  | { action: 'discard'; reason: StaleDiscardReason };

/**
 * Whether a landed disposition response may touch the UI.
 *
 * `currentAttemptId` is the attempt on the station **now** — the live or reserved
 * one — or `null` when there is none.
 *
 * **Null is deliberately not a discard.** With no attempt on the station there is
 * no other contact's field to contaminate, and the agent may well still be
 * looking at the wrap-up panel for the attempt that just ended. Discarding there
 * would hide a genuine failure from the one person who can act on it, which is
 * the opposite of the intent: the rule protects customer B, it does not suppress
 * customer A's errors.
 */
export function decideDispositionResponse(
  inFlight: InFlightDisposition,
  currentAttemptId: string | null,
): StaleResponseDecision {
  if (currentAttemptId !== null && currentAttemptId !== inFlight.attemptId) {
    return { action: 'discard', reason: 'attempt_changed' };
  }
  return { action: 'apply' };
}

/**
 * The same decision for a **successful** submit, with one extra check available.
 *
 * `AgencyDispositionResponse` does carry `attempt_id`, so a success can be
 * cross-checked against what we submitted for. A disagreement means something is
 * badly wrong upstream — a mismatched promise, a proxy replaying a body — and the
 * safe move is to discard rather than to apply a confirmation to an attempt we
 * cannot identify. It should never fire; that is why it is worth asserting.
 */
export function decideDispositionSuccess(
  inFlight: InFlightDisposition,
  response: Pick<AgencyDispositionResponse, 'attempt_id'>,
  currentAttemptId: string | null,
): StaleResponseDecision {
  if (response.attempt_id !== inFlight.attemptId) {
    return { action: 'discard', reason: 'attempt_id_mismatch' };
  }
  return decideDispositionResponse(inFlight, currentAttemptId);
}

/**
 * The **only** sanctioned way to read `agent_state` off a disposition response.
 *
 * `AgencyDispositionResponse.agent_state` races the socket **by design**:
 * submitting releases the agent, the pacing tick runs every 250ms, so a new call
 * can be reserved and its `reserved` frame delivered *before* this response lands.
 * A console that assigns from the field unconditionally overwrites a fresh
 * `reserved` with a stale `available` and drops the panel for a customer who is
 * already talking.
 *
 * So this returns the hint only when it is still safe to use it, and `null`
 * otherwise. `null` means "keep whatever the socket told you" — which is always
 * the correct fallback, because the socket is the authority.
 *
 * The 3s reconciliation window is the caller's: this answers *may I*, not *should
 * I*. Pass `agentStateFrameArrived` so the answer is no once the socket has
 * spoken, since a hint is worthless next to the authority.
 */
export function advisoryAgentState(
  inFlight: InFlightDisposition,
  response: Pick<AgencyDispositionResponse, 'attempt_id' | 'agent_state'>,
  currentAttemptId: string | null,
  agentStateFrameArrived: boolean,
): AgencyDispositionResponse['agent_state'] | null {
  if (agentStateFrameArrived) return null;
  if (decideDispositionSuccess(inFlight, response, currentAttemptId).action === 'discard') return null;
  return response.agent_state;
}

/**
 * Diagnostic line for a discard, for the `?` overlay's ring buffer.
 *
 * A discard is never shown to the agent — there is nothing for them to do about
 * it and the state they are looking at is already correct — but it must be
 * greppable, because "the disposition I submitted never confirmed" is a support
 * question and this is the answer to it.
 */
export function describeDiscard(
  inFlight: InFlightDisposition,
  currentAttemptId: string | null,
  reason: StaleDiscardReason,
): string {
  return `Discarded a disposition response for attempt ${inFlight.attemptId} (${reason}); the station is now on ${currentAttemptId ?? 'no attempt'}`;
}

// ─── The same property, one shape down: a LIST read ─────────────────────────
//
// Everything above is about a WRITE landing against the wrong contact. What
// follows is the read-side twin, and it lives in this file deliberately rather
// than in a second module: it is one property — *a response that landed for a
// question nobody is asking any more must not touch the UI* — and a reader who
// finds one half of it should find the other half beside it.
//
// The list case is duller than the disposition case and no less real. Every
// agency spine list is a filtered keyset read, and a filter change fires a new
// first page while the previous one is still in flight. Change a filter twice
// quickly and the slow first response lands last, leaving rows that do not match
// the controls above them — which reads as a broken filter rather than as a race,
// so the reader's next move is to distrust the whole screen.
//
// `AgencyCampaignAttemptsPage` already guards this with a `useRef` counter
// compared inline in two places. Naming the decision is what makes the SECOND
// place — "load more", where the counter is captured rather than incremented —
// impossible to get subtly wrong: appending a page fetched under the old filter
// to a list rendered under the new one is the exact defect, and it is invisible
// in review because both halves of the code look correct on their own.

/**
 * A list read that was issued, identified by the generation it belongs to.
 *
 * Captured **when the request is issued**, exactly as {@link InFlightDisposition}
 * is and for the same reason: the response body says nothing about which query
 * produced it, so there is nothing in it to key off on arrival.
 */
export interface InFlightListRead {
  /**
   * The value of the caller's request counter at issue time.
   *
   * A first page **increments** the counter and holds the new value — it is a new
   * question. A "load more" **captures the current value without incrementing** —
   * it is a continuation of the question already on screen — so a filter change
   * landing in between moves the counter past it and this call discards it.
   */
  seq: number;
}

/**
 * Why a list response was discarded.
 *
 * One reason today, and named rather than left as a bare boolean so a log line
 * can say which race happened: a filter (or a manual reload) started a newer read
 * while this one was in flight.
 */
export type ListDiscardReason = 'superseded';

export type ListResponseDecision =
  | { action: 'apply' }
  | { action: 'discard'; reason: ListDiscardReason };

/**
 * Whether a landed list response may touch the UI.
 *
 * `currentSeq` is the caller's counter **now**. Success and failure both go
 * through it: a discarded read must not raise an error either, because the error
 * would describe a query the reader has already moved off and would sit above
 * rows that loaded perfectly well.
 *
 * Pure and total — no refs, no timers — so the property is unit-testable without
 * rendering anything, which is the point of putting it here rather than inline.
 */
export function decideListResponse(
  inFlight: InFlightListRead,
  currentSeq: number,
): ListResponseDecision {
  if (inFlight.seq !== currentSeq) return { action: 'discard', reason: 'superseded' };
  return { action: 'apply' };
}
