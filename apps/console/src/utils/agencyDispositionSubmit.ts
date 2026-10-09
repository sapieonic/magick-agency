import type { AgencyActionErrorCode } from '../types/agency';
import {
  decideDispositionResponse,
  decideDispositionSuccess,
  type InFlightDisposition,
  type StaleDiscardReason,
} from './agencyStaleResponse';

/**
 * Classifying a disposition submit's outcome against the server's frozen shape
 *.
 *
 * Pure, because the interesting cases are the ones a console gets wrong by
 * reading the status code literally.
 */

/**
 * ── Why a re-submitted SAME code is a success, not `already_dispositioned` ────
 *
 * The obvious reading of `already_dispositioned` is a 409. The server deliberately does
 * not do that, and the reasoning is about the one interaction whose entire purpose
 * is recording what was said to a customer: the agent presses Submit, the network
 * blips, the console retries — and a strict 409 would show them an error for an
 * action that in fact succeeded.
 *
 * So:
 *  - **same code ⇒ 200**, with `notes` / `callback_at` last-write-wins, which also
 *    makes an honest correction ("same outcome, better note") work;
 *  - **different code ⇒ 409**, because silently rewriting the record of a
 *    conversation is not a retry.
 *
 * **A replay is deliberately not distinguishable, and must not be rendered as
 * one.** From the agent's side it *was* a success; a "you already submitted this"
 * state would tell them their retry failed when it did precisely what they wanted.
 */
export type DispositionOutcome =
  /** Recorded. Covers a first submit and an idempotent replay of the same code. */
  /**
   * Recorded.
   *
   * `nextAttemptAt` is the server's own `next_attempt_at` — set when the disposition
   * scheduled a retry or honoured a `callback_at`, null otherwise. It is carried
   * here because it is the only thing that lets the confirmation name the
   * callback time, and `confirmationCopy` — the callback copy's mitigation — cannot say "we'll
   * call back at 3" without it. **Before this it had zero callers**: the console
   * announced a flat "Disposition saved." and the agent was never told the time
   * the system had actually booked.
   */
  | {
      kind: 'saved';
      nextAttemptAt: string | null;
      /**
       * The server's
       * `callback_requested_at`, what the agent ASKED for. Absent when the
       * response does not carry it; `nextAttemptAt` stays the time that will
       * actually be dialled.
       */
      callbackRequestedAt?: string | null;
    }
  /**
   * A **different** code is already recorded. Not an overwrite: the agent has to
   * be told, because the record of a conversation is not silently rewritable.
   */
  | { kind: 'conflict'; recordedCode?: string }
  /** The server refused it. `code` drives the pad's copy; `message` is the fallback. */
  | { kind: 'rejected'; code: AgencyActionErrorCode | null; message: string; allowedCodes?: string[] }
  /**
   * The response was for an attempt that is no longer on the station. Carries the
   * reason because a discard is never shown to the agent but must be **greppable**
   * — "the disposition I submitted never confirmed" is a support question and this
   * is the answer to it.
   */
  | { kind: 'discarded'; reason: StaleDiscardReason };

export interface RawSubmitResponse {
  status: number;
  body: unknown;
}

/**
 * Classifies a response, **assuming the stale-response guard has already run.**
 *
 * ⚠️ **Do not call this directly from a component.** Use `handleSubmitResponse`
 * below, which is the same two steps welded together in the only safe order.
 * Classifying first and checking staleness afterwards is the arrangement that
 * leaks customer A's note into customer B's field, and it reads perfectly
 * sensibly on the page.
 *
 * Exported because the classification is worth unit-testing on its own.
 */
export function classifySubmitOutcome(response: RawSubmitResponse): DispositionOutcome {
  const body = (response.body ?? {}) as Record<string, unknown>;

  if (response.status >= 200 && response.status < 300) {
    // Includes the idempotent replay. Nothing here inspects the body for a
    // "was this new?" signal, because the server deliberately does not send one.
    //
    // A missing or non-string `next_attempt_at` reads as null rather than as a
    // reason to fail the classification: a saved disposition is saved, and the
    // confirmation degrades to "we'll call back as scheduled" rather than
    // inventing a time.
    return {
      kind: 'saved',
      nextAttemptAt: typeof body['next_attempt_at'] === 'string' ? body['next_attempt_at'] : null,
      // Carried only when present, so a response
      // without it still classifies correctly.
      ...(typeof body['callback_requested_at'] === 'string'
        ? { callbackRequestedAt: body['callback_requested_at'] }
        : {}),
    };
  }

  const code = typeof body['code'] === 'string' ? (body['code'] as AgencyActionErrorCode) : null;
  const message = typeof body['message'] === 'string' ? body['message'] : 'That disposition could not be saved.';

  if (response.status === 409 || code === 'already_dispositioned') {
    return {
      kind: 'conflict',
      recordedCode: typeof body['disposition_code'] === 'string' ? body['disposition_code'] : undefined,
    };
  }

  return {
    kind: 'rejected',
    code,
    message,
    // Present on `unknown_disposition_code` and `unknown_break_reason`, and the
    // reason a console holding a stale catalog can recover in one round trip
    // rather than making the agent re-bootstrap mid-shift.
    allowedCodes: Array.isArray(body['allowed_codes'])
      ? (body['allowed_codes'] as unknown[]).filter((c): c is string => typeof c === 'string')
      : undefined,
  };
}

/**
 * **The only entry point a component may use for a landed disposition response.**
 *
 * ── Why this exists as one function rather than two calls ────────────────────
 * The stale-response guard and the classifier have to run in this order, and
 * nothing about their signatures says so. Written as two statements on the page,
 * the wrong order is one line-swap away and looks fine in review — a reviewer sees
 * an error being classified and then a staleness check, which reads like
 * defence-in-depth rather than like a bug.
 *
 * It is not defence-in-depth. Classifying first means `{kind:'rejected'}` reaches
 * the pad with customer A's message and A's preserved note, and the pad's own
 * rules then do the damage: the error renders over customer B's pad, **A's note is
 * restored into B's notes field**, and submit re-enables inviting the agent to
 * save A's disposition against B. The middle one is cross-contact data
 * contamination, it is silent, and the agent cannot detect it — a plausible note
 * simply appears in a field they have not typed into.
 *
 * So the order is welded shut here. There is no arrangement of arguments that
 * runs the classifier first.
 *
 * ── Why success and failure take different guards ────────────────────────────
 * `AgencyDispositionResponse` carries `attempt_id`; `AgencyActionErrorResponse`
 * does **not** — it is `{error, code, message, allowed_codes?}`. So the failing
 * path, which is the one that leaks, has nothing in its body to key off and must
 * rely entirely on the id captured when the request was issued.
 *
 * `currentAttemptId === null` is deliberately **not** a discard: with no attempt
 * on the station there is no other contact's field to contaminate, and the agent
 * may still be looking at the wrap-up panel for the attempt that just ended.
 * Discarding there would hide a real failure from the one person who can act on
 * it. The rule protects customer B; it does not suppress customer A's errors.
 */
export function handleSubmitResponse(
  inFlight: InFlightDisposition,
  response: RawSubmitResponse,
  currentAttemptId: string | null,
): DispositionOutcome {
  const ok = response.status >= 200 && response.status < 300;

  const decision = ok
    ? decideDispositionSuccess(
        inFlight,
        { attempt_id: readAttemptId(response.body) ?? inFlight.attemptId },
        currentAttemptId,
      )
    : decideDispositionResponse(inFlight, currentAttemptId);

  if (decision.action === 'discard') return { kind: 'discarded', reason: decision.reason };

  return classifySubmitOutcome(response);
}

/**
 * A missing `attempt_id` on a 2xx falls back to the id we submitted for rather
 * than being treated as a mismatch. The cross-check exists to catch a body that
 * names a *different* attempt — a mismatched promise, a proxy replaying a
 * response — and an absent field is not evidence of that. Discarding on absence
 * would throw away a genuine confirmation because of a field the console does not
 * strictly need.
 */
function readAttemptId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>)['attempt_id'];
  return typeof value === 'string' ? value : null;
}

/**
 * What the idle panel says about the call just recorded.
 *
 * ── Why a callback line exists in Phase 2 at all ─────────────────────────────
 * `contact_state` is `completed` and `next_attempt_at` null for almost every
 * disposition in P2 — **with one exception: a supplied `callback_at` is honoured**,
 * so the contact goes back to `pending` with `next_attempt_at` set. That was
 * approved rather than deferred because `requires_datetime` is already reachable
 * in P2, and capturing a datetime without acting on it means the agent promises a
 * callback and nothing ever happens.
 *
 * ── The callback copy, and why it is load-bearing here specifically ───────────────────────
 * Always "we", never "I". A callback re-enters the roster as an ordinary pending
 * contact and **whichever agent is available takes it** — so "I'll call you
 * back" is a promise the product breaks. This copy is the entire mitigation for
 * that decision, which is why it lives beside the outcome rather than at the call
 * site.
 */
export function confirmationCopy(input: {
  dispositionLabel: string;
  nextAttemptAt: string | null;
  /**
   * What the agent asked for. The server
   * defers a callback outside the contact's calling window to the next window
   * open, and says so by returning the two separately; "when they differ, the
   * console should say what will happen rather than what was asked". So the time
   * named is always `nextAttemptAt`, and a differing request only adds why it
   * moved — the agent must not repeat the asked-for time to the customer.
   */
  callbackRequestedAt?: string | null;
}): string {
  if (input.nextAttemptAt === null) return `Saved — ${input.dispositionLabel}.`;

  const when = new Date(Date.parse(input.nextAttemptAt));
  if (Number.isNaN(when.getTime())) {
    // A callback was scheduled but we cannot say when. Still say "we", and do not
    // invent a time.
    return `Saved — ${input.dispositionLabel}. We'll call back as scheduled.`;
  }

  const formatted = when.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  // "We", never "I", and it does not claim this agent will make the call.
  //
  // The "moved into calling hours" test is an exact,
  // millisecond comparison of two parsed instants. That is safe only because the server
  // echoes the SAME `Date` in both fields when it does not move the callback:
  // `resolveCallbackDialTime` returns `requestedAt` itself when the window is open
  // (in the server's agency routes), and both are serialised with
  // `toISOString()`. A server that rounded or
  // re-derived one of them (seconds precision, a different timezone offset in the
  // string is fine — `Date.parse` normalises it) would make every callback read
  // as moved. Behaviour deliberately unchanged; keep the server's echo exact.
  const requested =
    input.callbackRequestedAt != null ? Date.parse(input.callbackRequestedAt) : Number.NaN;
  if (!Number.isNaN(requested) && requested !== when.getTime()) {
    return `Saved — ${input.dispositionLabel}. We'll call back ${formatted}, the next time inside calling hours.`;
  }
  return `Saved — ${input.dispositionLabel}. We'll call back ${formatted}.`;
}
