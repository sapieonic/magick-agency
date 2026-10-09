import type {
  AgencyActionErrorCode,
  AgencyDisposition,
} from '@magick-agency/contracts/agency';
import type { AgencyCallAttemptRecord } from '../db/models/agency.model.js';

/**
 * ─── AGENCY DIALER — DISPOSITION SUBMIT RULES (`AD-P2-C-04`) ────────────────
 *
 * The decision logic, kept out of the route so it can be exercised directly.
 * Everything here is pure: no Redis, no database, no clock beyond one injected
 * `now`. The route owns ordering and I/O; this owns what is and is not allowed.
 */

/**
 * The code the reaper writes when a wrap-up lapsed with nothing submitted
 * (`AD-P2-C-08`). Named here, not in the reaper, because both sides must agree:
 * the sweep writes it and this module has to recognise it as "auto-closed"
 * rather than "the agent already dispositioned", which is a different message to
 * a different person.
 */
export const AUTO_DISPOSITION_CODE = 'no_disposition';

/** Which catalog entry a submitted code names, or the codes that are valid. */
export function resolveDisposition(
  catalog: AgencyDisposition[] | null | undefined,
  code: unknown,
): { ok: true; entry: AgencyDisposition } | { ok: false; allowed: string[] } {
  // Defensive on shape as well as membership, exactly as `resolveBreakReasons`
  // is: the column is CHECKed to be a JSON array but nothing constrains its
  // elements, so a malformed catalog must reject the submission rather than
  // throw a 500 that reads to the agent as core being broken.
  const entries = Array.isArray(catalog)
    ? catalog.filter((d): d is AgencyDisposition =>
      !!d && typeof d === 'object' && typeof d.code === 'string' && d.code.length > 0)
    : [];
  const match = typeof code === 'string' ? entries.find((d) => d.code === code) : undefined;
  return match ? { ok: true, entry: match } : { ok: false, allowed: entries.map((d) => d.code) };
}

/**
 * Whether this attempt can be dispositioned at all, and why not if it cannot.
 *
 * Two refusals, deliberately distinct from `already_dispositioned` so the
 * console can say "this call was auto-closed" rather than "you already did
 * this" — different facts, and only one of them is the agent's doing.
 *
 * **Never reached the agent** is keyed on `bridged_at`, not on the outcome. The
 * outcome is a classification that can be absent or late; `bridged_at` is the
 * instant media actually joined the two parties, so it is the only honest answer
 * to "was there a conversation to write up". A call that rang out has nothing to
 * disposition and never will.
 */
export function dispositionRefusal(attempt: AgencyCallAttemptRecord): AgencyActionErrorCode | null {
  if (attempt.bridged_at === null) return 'attempt_not_dispositionable';
  // `AD-P3-Q-01` — OPEN, and this line is the whole of it. An agent whose
  // wrap-up lapsed and who then submits their real disposition is refused, and
  // the record of what was actually said is lost in favour of the auto-close.
  //
  // That follows the frozen contract, which names this case explicitly, so it is
  // deliberate rather than an oversight. But the argument against it is real:
  // `no_disposition` is an admission of ABSENCE, not a substantive claim, so
  // overwriting it with the agent's real account differs in kind from
  // overwriting one real code with another — which is what the 409 exists to
  // prevent. A third option loses nothing: supersede *and* keep both.
  //
  // It is not a two-line change, which is why it is a ticket and not a TODO:
  // `no_disposition` feeds the retry policy, so anything that lets a later
  // submission replace it has to decide whether the retry decision is recomputed
  // retroactively (`AD-P3-C-01`/`C-02`). Do not "just allow it" here.
  if (attempt.disposition_code === AUTO_DISPOSITION_CODE) return 'attempt_not_dispositionable';
  return null;
}

/**
 * Steps 1–4 of the `AgencyActorFields` ownership rule, in order.
 *
 * `reservedAgentUserId` is the master user id behind the attempt's
 * `reserved_agent_id` **session**, resolved by the caller — the two columns are
 * different kinds of id and comparing them directly is the mistake this
 * signature exists to prevent.
 *
 * A null `reservedAgentUserId` (no reserved agent, or the session row is gone)
 * cannot match anything, so it falls to step 4: an attempt with no reserved
 * agent is not yours either, and a supervisor with `on_behalf` is still the
 * right way in.
 */
export function checkActor(
  reservedAgentUserId: string | null,
  actor: { agent_user_id?: unknown; on_behalf?: unknown },
): { ok: true; onBehalf: boolean; actorUserId: string } | { ok: false; code: AgencyActionErrorCode } {
  const actorUserId = typeof actor.agent_user_id === 'string' ? actor.agent_user_id.trim() : '';
  // 1. There is no anonymous disposition. It is the record of who said what
  //    about a customer, so an unattributed one is worth less than none.
  if (!actorUserId) return { ok: false, code: 'missing_actor' };
  // 2. The reserved agent, writing up their own call.
  if (reservedAgentUserId !== null && actorUserId === reservedAgentUserId) {
    return { ok: true, onBehalf: false, actorUserId };
  }
  // 3. Someone else, and master has vouched that they hold `agency.supervise`.
  //    Core cannot check that capability — which is exactly why master asserts
  //    it — so the flag is trusted and the fact is recorded, not inferred.
  if (actor.on_behalf === true) return { ok: true, onBehalf: true, actorUserId };
  // 4.
  return { ok: false, code: 'not_your_attempt' };
}

/**
 * Catalog-driven validation of the submitted fields.
 *
 * `requires_note` / `requires_datetime` are enforced here **as well as** in the
 * console, and that duplication is the point: they are operator config, a
 * console can hold a stale catalog for a whole shift, and the server is the only
 * place the requirement is actually true.
 */
export function validateDispositionFields(
  entry: AgencyDisposition,
  body: { notes?: unknown; callback_at?: unknown },
  now: Date,
): { ok: true; notes: string | null; callbackAt: Date | null } | { ok: false; code: AgencyActionErrorCode } {
  const notesRaw = typeof body.notes === 'string' ? body.notes : null;
  // Whitespace is not a note. Without the trim, `requires_note` is satisfiable
  // with a space — which passes the check and records nothing.
  if (entry.requires_note && (notesRaw === null || notesRaw.trim().length === 0)) {
    return { ok: false, code: 'note_required' };
  }

  const hasCallback = body.callback_at !== undefined && body.callback_at !== null && body.callback_at !== '';
  if (entry.requires_datetime && !hasCallback) return { ok: false, code: 'datetime_required' };

  let callbackAt: Date | null = null;
  if (hasCallback) {
    if (typeof body.callback_at !== 'string') return { ok: false, code: 'invalid_callback_at' };
    const parsed = new Date(body.callback_at);
    if (Number.isNaN(parsed.getTime())) return { ok: false, code: 'invalid_callback_at' };
    // A callback in the past is a promise already broken: the contact would be
    // immediately dialable, so the customer told "Tuesday" is called now.
    if (parsed.getTime() <= now.getTime()) return { ok: false, code: 'invalid_callback_at' };
    callbackAt = parsed;
  }

  return { ok: true, notes: notesRaw, callbackAt };
}

/** Human copy for each refusal. The console keys off `code`; this is its fallback. */
export function dispositionErrorMessage(code: AgencyActionErrorCode): string {
  switch (code) {
    case 'missing_actor':
      return 'The request did not identify who is dispositioning this call.';
    case 'not_your_attempt':
      return 'This call was handled by another agent.';
    case 'unknown_disposition_code':
      return 'That disposition code is not in this campaign\'s catalog.';
    case 'invalid_dnc_scope':
      return 'The do-not-call scope must be "campaign" or "tenant".';
    case 'note_required':
      return 'This disposition requires a note.';
    case 'datetime_required':
      return 'This disposition requires a callback date and time.';
    case 'invalid_callback_at':
      return 'The callback time must be a valid date in the future.';
    case 'attempt_not_dispositionable':
      return 'This call can no longer be dispositioned — it was auto-closed or never connected.';
    case 'already_dispositioned':
      return 'This call already has a different disposition recorded.';
    case 'attempt_not_live':
      return 'This call is no longer connected on this server, so it cannot be hung up here.';
    default:
      return 'The request was refused.';
  }
}
