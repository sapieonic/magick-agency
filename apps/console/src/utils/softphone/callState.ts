import { formatDialNumber } from './phoneInput';
import { resolveContextFields } from '../agencyContext';
import { attemptOutcomeLabel } from '../../types/agency-spine';
import type { StationConnection } from '../../hooks/agencyStation/types';
import type { AgencyContextDisplay } from '../../types/agency';
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
  failed: 'The call didn’t go through.',
  invalid: 'That number can’t be called.',
  agent_disconnected: 'Your connection dropped and the call ended.',
  agent_hangup: 'You hung up.',
  remote_hangup: 'The customer hung up.',
  supervisor_released: 'A supervisor ended the call.',
  orphaned: 'Something went wrong on our side and the call was cleaned up.',
};

/** One line for how a call finished: the end reason when known, else the telephony outcome. */
export function callEndSummary(call: AgencyManualCall): string {
  if (call.end_reason) return MANUAL_END_REASON_COPY[call.end_reason] ?? attemptOutcomeLabel(call.outcome);
  return call.outcome ? `${attemptOutcomeLabel(call.outcome)}.` : 'The call ended.';
}

/**
 * The matched contact's name, for "On call with Rahul Verma".
 *
 * Read through the tag's `context_display` and the same hero resolution the
 * station's contact panel uses, then the first hero that looks like a name —
 * never the first column of an arbitrary CSV, which is as likely to be a loan
 * number as a person.
 */
export function contactName(
  call: AgencyManualCall | null | undefined,
  display: AgencyContextDisplay | undefined,
): string | null {
  const context = call?.contact?.context;
  if (!context) return null;
  const resolved = resolveContextFields(context, display);
  const named = [...resolved.hero, ...resolved.fields].find(
    (field) => !field.isEmpty && /(^|[\s_-])(full[\s_-]?)?name$|^name$|customer|contact[\s_-]?name/i.test(field.label),
  );
  return named?.value ?? null;
}

export type RailTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface SoftphoneRailDescription {
  tone: RailTone;
  label: string;
  detail: string | null;
  /** Which instant the rail's timer counts from, or null for no timer. */
  timerFrom: string | null;
}

/**
 * The soft phone's rail, as a pure function of the connection and the call.
 *
 * Connection failures outrank the call for the station's reason: an agent whose
 * socket is gone must not be told they are ready to dial, and an agent mid-call
 * must be told whether the customer can hear them.
 */
export function describeSoftphoneRail(input: {
  connection: StationConnection;
  call: AgencyManualCall | null;
  /** The call that just settled, for "Last call: no answer" on the Ready rail. */
  lastCall: AgencyManualCall | null;
  /** Whether the agent came from a campaign (SP7) — changes the Ready sentence. */
  fromCampaign: boolean;
  contactName: string | null;
}): SoftphoneRailDescription {
  const { connection, call, lastCall, fromCampaign } = input;
  const phase = softphonePhase(call);
  const live = phase === 'dialing' || phase === 'ringing' || phase === 'on_call';

  if (connection === 'superseded') {
    return {
      tone: 'danger',
      label: 'Your soft phone moved to another window',
      detail: 'You opened it somewhere else. Only one window can make calls.',
      timerFrom: null,
    };
  }
  if (connection === 'session_gone') {
    return { tone: 'danger', label: 'Session ended', detail: 'Reload the page to open the soft phone again.', timerFrom: null };
  }
  if (connection === 'disconnected') {
    return live
      ? {
          tone: 'danger',
          label: 'Connection lost',
          detail: 'The customer can’t hear you right now. Reconnect to get back on the call.',
          timerFrom: null,
        }
      : { tone: 'danger', label: 'Disconnected', detail: 'Reconnect to make calls.', timerFrom: null };
  }
  if (connection === 'reconnecting') {
    return {
      tone: 'warning',
      label: 'Reconnecting',
      detail: live ? 'Stay on the line — we’re reconnecting you.' : 'Calls are paused until your phone reconnects.',
      timerFrom: null,
    };
  }

  const number = call ? formatDialNumber(call.destination_e164) : '';
  const from = call ? `from ${formatDialNumber(call.caller_id)}` : '';

  switch (phase) {
    case 'dialing':
      return {
        tone: 'warning',
        label: `Dialing ${number}`,
        detail: `${capitalise(from)} · connecting your line first`,
        timerFrom: call?.dialed_at ?? null,
      };
    case 'ringing':
      return {
        tone: 'warning',
        label: `Ringing ${number}`,
        detail: `${capitalise(from)} · the ringback tone plays in your browser`,
        timerFrom: call?.dialed_at ?? null,
      };
    case 'on_call': {
      const bridged = call?.bridged_at ?? null;
      return {
        tone: 'success',
        label: input.contactName ? `On call with ${input.contactName}` : 'On call',
        detail: bridged ? `${number} · ${from}` : `${number} · connecting audio…`,
        timerFrom: bridged,
      };
    }
    case 'outcome':
      return {
        tone: 'warning',
        label: 'Outcome needed',
        detail: `${call ? callEndSummary(call) : 'The call ended.'} Pick an outcome and save it — the next call unlocks when you do.`,
        timerFrom: call?.ended_at ?? null,
      };
    case 'ready':
    default: {
      if (connection !== 'open') {
        return { tone: 'neutral', label: 'Connecting your phone…', detail: null, timerFrom: null };
      }
      const last = lastCall && lastCall.id !== call?.id ? lastCall : (call ?? null);
      const lastLine = last && last.state === 'ended' && !last.requires_disposition
        ? `Last call to ${formatDialNumber(last.destination_e164)}: ${callEndSummary(last)} `
        : '';
      return {
        tone: 'info',
        label: 'Ready to dial',
        detail: fromCampaign
          ? `${lastLine}Type a number or redial a recent call. Soft-phone calls are not paced, and the campaign's dialer does not reserve you here.`
          : `${lastLine}Type a number or redial a recent call.`,
        timerFrom: null,
      };
    }
  }
}

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}
