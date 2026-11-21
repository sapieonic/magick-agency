import { ATTEMPT_OUTCOME_WORDS } from '../agency/stationCopy';
import type { AgencyContextDisplay } from '../../types/agency';
import { customerNameOf } from '../agencyContext';
import type { AgencyManualCall, AgencyManualCallEndReason } from '../../types/softphone';

/**
 * The soft phone's call, as the screen reads it.
 *
 * ── One row, replaced whole ──────────────────────────────────────────────────
 * Every state change of a manual call arrives as a `manual_call` frame carrying
 * the WHOLE `AgencyManualCall` (`docs/softphone.md` §4.1 step 5), and the HTTP
 * answers to `POST /calls`, `PATCH`, the hang-up and the outcome carry the same
 * row. So there is nothing to patch: the console holds the newest copy it has
 * seen from any source, and {@link newerCall} is the one rule for "newest".
 * The frame is the authority — on a tie it wins — because the HTTP answer to a
 * hang-up is read the instant the hang-up is issued and may still say `ringing`.
 */

export type SoftphonePhase = 'ready' | 'dialing' | 'ringing' | 'on_call' | 'outcome';

/** Whether this call still holds the session: live, or ended and owing its outcome. */
export function isCallUnsettled(call: AgencyManualCall | null | undefined): call is AgencyManualCall {
  if (!call || call.settled_at !== null) return false;
  return call.state !== 'ended' || call.requires_disposition;
}

/** Whether the call is still on the line (not `ended`). */
export function isCallLive(call: AgencyManualCall | null | undefined): call is AgencyManualCall {
  return Boolean(call && call.settled_at === null && call.state !== 'ended');
}

/**
 * Which of the rail's five states the call puts the soft phone in.
 *
 * `answered` reads as On call: the customer has picked up, and the agent's leg
 * was up before the customer was dialled (agent first, §4.1 step 4), so audio
 * follows within a beat. The talk timer still waits for `bridged_at`, which is
 * the instant audio is live both ways.
 */
export function softphonePhase(call: AgencyManualCall | null | undefined): SoftphonePhase {
  if (!call || call.settled_at !== null) return 'ready';
  switch (call.state) {
    case 'queued':
    case 'dialing':
      return 'dialing';
    case 'ringing':
      return 'ringing';
    case 'answered':
    case 'bridged':
      return 'on_call';
    case 'ended':
      return call.requires_disposition ? 'outcome' : 'ready';
  }
}

function instant(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * The newer of two copies of "the session's call".
 *
 * Different calls: the later `created_at` (a new dial always wins over the one
 * before it). The same call: the later `updated_at`; on a tie `a` wins, so pass
 * the frame's copy first. A settled copy also beats an unsettled one of the same
 * call with an equal stamp — settling is the one transition that never reverses.
 */
export function newerCall(
  a: AgencyManualCall | null | undefined,
  b: AgencyManualCall | null | undefined,
): AgencyManualCall | null {
  if (!a) return b ?? null;
  if (!b) return a;
  if (a.id !== b.id) return instant(b.created_at) > instant(a.created_at) ? b : a;
  const at = instant(a.updated_at);
  const bt = instant(b.updated_at);
  if (bt > at) return b;
  if (bt === at && b.settled_at !== null && a.settled_at === null) return b;
  return a;
}

/** The end of a call, said plainly — the station's release copy is about the pool, this is about one dial. */
export const MANUAL_END_REASON_COPY: Record<AgencyManualCallEndReason, string> = {
  completed: 'The call ended.',
  no_answer: 'No answer.',
  busy: 'The line was busy.',
  failed: 'The call did not go through.',
  invalid: 'This number cannot be called.',
  agent_disconnected: 'Your internet dropped and the call ended.',
  agent_hangup: 'You ended the call.',
  remote_hangup: 'The customer hung up.',
  supervisor_released: 'A supervisor ended the call.',
  orphaned: 'Something went wrong on our side and the call ended.',
};

/** One line for how a call finished, in the station's words: the end reason when known, else what the line did. */
export function callEndSummary(call: AgencyManualCall): string {
  if (call.end_reason && MANUAL_END_REASON_COPY[call.end_reason]) return MANUAL_END_REASON_COPY[call.end_reason];
  return call.outcome ? `${ATTEMPT_OUTCOME_WORDS[call.outcome]}.` : 'The call ended.';
}

/**
 * The matched contact's name, for "On call with Rahul Verma", read through the tag's
 * `context_display` by {@link contextName}.
 */
export function contactName(
  call: AgencyManualCall | null | undefined,
  display: AgencyContextDisplay | undefined,
): string | null {
  const context = call?.contact?.context;
  if (!context) return null;
  return contextName(context, display);
}

/**
 * A contact's name off its uploaded context, by the server's one rule (AS19 S1, the domain's
 * `customerNameFrom`): the `name` role's column when the display sets one (none when it is blank
 * on this row), else the guess from the column names (`Name`, `Customer Name`, …), never a
 * hidden column or a chosen fact's, and never the first column of an arbitrary CSV, which is as
 * likely to be a loan number as a person. On a campaign without chosen facts or a name column,
 * when the rule finds none, the card's guess from before AS19 (`Borrower Name`, …;
 * `customerNameOf`), so the band and the card name a legacy caller alike. Shared by the soft
 * phone's call and an inbound caller's matched contact (`inboundMatchName`).
 */
export function contextName(
  context: Record<string, unknown>,
  display: AgencyContextDisplay | undefined,
): string | null {
  return customerNameOf(context, display) ?? null;
}
