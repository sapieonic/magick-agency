import { formatDialNumber } from '../softphone/phoneInput';
import { contextName, type RailTone } from '../softphone/callState';
import { contactStateLabel } from '../../types/agency-spine';
import type { StationConnection } from '../../hooks/agencyStation/types';
import type {
  AgencyInboundCall,
  AgencyInboundCallState,
  AgencyInboundStickyReason,
  AgencyStationCustomerWaitingFrame,
} from '../../types/inbound';

/**
 * An inbound call on the agent's station (P2, `docs/inbound.md` §6), as the screen reads it.
 *
 * ── One row, replaced whole ──────────────────────────────────────────────────
 * Every change of the call arrives as an `inbound_call` frame carrying the WHOLE
 * `AgencyInboundCall`, and the call routes answer with the same row, exactly as the soft
 * phone's `manual_call` does. So nothing is patched: the console holds the newest copy it has
 * seen from any source, and {@link newerInboundCall} is the one rule for "newest". The row has
 * no `updated_at`, so "newest" is read off the call's own progress (see there).
 */

/**
 * What the station shows for the call:
 *
 *  - `offered`: the panel is up and audio binds at `connects_at` (IB1: panel before audio);
 *  - `connected`: audio both ways;
 *  - `outcome`: the call ended after it was answered and owes its outcome.
 *
 * `null`: nothing to show. Settled (outcome saved, lapsed, or ended before it was answered),
 * or no longer this station's (a requeued call is `queued` again).
 */
export type InboundPhase = 'offered' | 'connected' | 'outcome';

export function inboundPhase(call: AgencyInboundCall | null | undefined): InboundPhase | null {
  if (!call || call.settled_at !== null) return null;
  switch (call.state) {
    case 'offered':
      return 'offered';
    case 'connected':
      return 'connected';
    case 'ended':
      // An unbridged end is settled by the server in the same write; a copy that says
      // otherwise owes nothing all the same: nobody spoke to the caller.
      return call.bridged_at !== null ? 'outcome' : null;
    default:
      return null;
  }
}

/** The call still holds the station: offered, connected, or ended owing its outcome. */
export function isInboundCallOnStation(call: AgencyInboundCall | null | undefined): call is AgencyInboundCall {
  return inboundPhase(call) !== null;
}

/** On the line: offered or connected. */
export function isInboundCallLive(call: AgencyInboundCall | null | undefined): call is AgencyInboundCall {
  const phase = inboundPhase(call);
  return phase === 'offered' || phase === 'connected';
}

/**
 * How far one offer of a call has got. An offer goes `offered` → `connected` → `ended`, or
 * `offered` → `queued` (requeued: the station was lost before audio bound), or `offered` →
 * `ended` (the caller hung up first); `queued` and `connected` never follow each other within
 * one offer, so they share a rank.
 */
const PROGRESS: Record<AgencyInboundCallState, number> = {
  arrived: 0,
  greeting: 0,
  queued: 2,
  offered: 1,
  connected: 2,
  ended: 3,
};

function instant(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * The newer of two copies of "the station's inbound call".
 *
 * Different calls: the later offer (`offered_at`) wins: a new offer always replaces the call
 * before it. The same call: a later offer of it (a re-offer after a requeue) wins; within one
 * offer, a settled copy beats an unsettled one (settling never reverses), then the copy further
 * along ({@link PROGRESS}). On a tie `a` wins, so pass the frame's copy first: the frame is the
 * authority, and the HTTP answer to a hang-up is read the instant the hang-up is issued.
 */
export function newerInboundCall(
  a: AgencyInboundCall | null | undefined,
  b: AgencyInboundCall | null | undefined,
): AgencyInboundCall | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const aOffer = instant(a.offered_at);
  const bOffer = instant(b.offered_at);
  if (a.id !== b.id) return bOffer > aOffer ? b : a;
  if (bOffer !== aOffer) return bOffer > aOffer ? b : a;
  if ((a.settled_at !== null) !== (b.settled_at !== null)) return b.settled_at !== null ? b : a;
  return PROGRESS[b.state] > PROGRESS[a.state] ? b : a;
}

/** The caller as the panel names them: their number, or "Number withheld". */
export const NUMBER_WITHHELD = 'Number withheld';

export function inboundCallerNumber(fromE164: string | null | undefined): string {
  return fromE164 ? formatDialNumber(fromE164) : NUMBER_WITHHELD;
}

/** The matched contact's name, read like the station's hero fields; null without one. */
export function inboundMatchName(call: Pick<AgencyInboundCall, 'match'> | null | undefined): string | null {
  const match = call?.match;
  if (!match) return null;
  return contextName(match.context, match.context_display);
}

/** Who is on the line, in the fewest words: the name, else the number, else "Number withheld". */
export function inboundCallerLabel(call: AgencyInboundCall): string {
  return inboundMatchName(call) ?? inboundCallerNumber(call.from_e164);
}

/**
 * The DNC badge. The caller's number is on a Do Not Call list, and they rang us: a customer's
 * own call is an enquiry (`docs/inbound.md` §10), so the agent helps them now, and nothing
 * dials them back unless they ask.
 */
export const INBOUND_DNC_BADGE = 'On Do Not Call';
export const INBOUND_DNC_ENQUIRY_COPY =
  'This number is on a Do Not Call list. The customer’s own call is an enquiry, so help them now — but don’t call them back unless they ask you to.';

/** Why the panel calls the caller "your customer" (`sticky.is_you`). */
export const STICKY_REASON_COPY: Record<AgencyInboundStickyReason, string> = {
  owner: 'Your customer: their contact is assigned to you',
  last_from_number: 'Your customer: you last called them from this number',
  last_connected: 'Your customer: you last spoke to them',
  last_dialled: 'Your customer: you last called them',
};

/** The sticky line, or null when the caller has no agent of their own. */
export function stickyLine(call: Pick<AgencyInboundCall, 'sticky'>): string | null {
  if (!call.sticky) return null;
  return call.sticky.is_you
    ? STICKY_REASON_COPY[call.sticky.reason]
    : 'Usually speaks to another agent, who isn’t free';
}

/** Where the pad's outcomes come from, said once above it. */
export function catalogHint(call: AgencyInboundCall): string {
  switch (call.catalog_source) {
    case 'campaign':
      return call.match ? `From ${call.match.campaign_name}’s outcome list` : 'From the campaign’s outcome list';
    case 'route':
      return call.route ? `From the ${call.route.name} route’s outcome list` : 'From the route’s outcome list';
    case 'builtin':
      return 'From the standard outcome list';
  }
}

/** The matched contact, in one line: "Home Loan Renewals · Pending". */
export function matchLine(call: AgencyInboundCall): string | null {
  if (!call.match) return null;
  return `${call.match.campaign_name} · ${contactStateLabel(call.match.contact_state)}`;
}

/** "Waited 1 min 5 s" — how long the caller held before this offer. */
export function waitedLine(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `Waited ${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `Waited ${m} min` : `Waited ${m} min ${rest} s`;
}

export interface InboundRailDescription {
  tone: RailTone;
  label: string;
  detail: string | null;
  /** The instant the rail's talk timer counts from, or null for none. */
  timerFrom: string | null;
  /** The instant an owed outcome lapses, for the countdown; null when none is owed. */
  lapseAt: string | null;
}

/**
 * The inbound call's rail, as a pure function of the connection and the call.
 *
 * Connection failures outrank the call, for the station's reason: an agent whose socket is gone
 * must be told whether the caller can hear them.
 */
export function describeInboundRail(input: {
  connection: StationConnection;
  call: AgencyInboundCall;
}): InboundRailDescription {
  const { connection, call } = input;
  const phase = inboundPhase(call);
  const live = phase === 'offered' || phase === 'connected';
  const who = inboundCallerLabel(call);
  const rang = `rang ${formatDialNumber(call.to_e164)}${call.route ? ` · ${call.route.name}` : ''}`;

  if (connection === 'superseded') {
    return {
      tone: 'danger',
      label: 'Your station moved to another device',
      detail: 'You opened it on your phone or in another window. Only one can take calls.',
      timerFrom: null,
      lapseAt: null,
    };
  }
  if (connection === 'session_gone') {
    return { tone: 'danger', label: 'Session ended', detail: 'Reload the page to rejoin.', timerFrom: null, lapseAt: null };
  }
  if (connection === 'disconnected') {
    return {
      tone: 'danger',
      label: 'Connection lost',
      detail: live ? 'The caller can’t hear you right now. Reconnect to get back on the call.' : 'Reconnect to save this call’s outcome.',
      timerFrom: null,
      lapseAt: null,
    };
  }
  if (connection === 'reconnecting') {
    return {
      tone: 'warning',
      label: 'Reconnecting',
      detail: live ? 'Stay on the line — we’re reconnecting you.' : 'Your outcome is kept while we reconnect.',
      timerFrom: null,
      lapseAt: null,
    };
  }

  switch (phase) {
    case 'offered':
      return {
        tone: 'info',
        label: `Incoming call from ${who}`,
        detail: `${call.from_e164 ? '' : 'The caller withheld their number · '}${capitalise(rang)} · connecting you now`,
        timerFrom: null,
        lapseAt: null,
      };
    case 'connected':
      return {
        tone: 'success',
        label: `On a call with ${who}`,
        detail: `Inbound · ${rang}`,
        timerFrom: call.bridged_at,
        lapseAt: null,
      };
    case 'outcome':
    default:
      return {
        tone: 'warning',
        label: 'Outcome needed',
        detail: `The call with ${who} ended. Pick an outcome and save it to take your next call.`,
        timerFrom: null,
        lapseAt: call.outcome_due_at,
      };
  }
}

/** "Without one, it closes in 0:24" — the countdown's words around its digits. */
export const LAPSE_PREFIX = 'Without one, it closes in';

/** Why the outcome pad is closed, by phase. */
export const INBOUND_PAD_DISABLED_COPY = 'Outcomes open when you’re connected to the caller.';
export const INBOUND_HANGUP_CONNECTING_COPY = 'Connecting you to the caller…';
export const INBOUND_HANGUP_ENDED_COPY = 'The call has ended';
export const INBOUND_DNC_WITHHELD_COPY = 'The caller withheld their number.';

/** The "Your customer is waiting" pill's words. */
export function customerWaitingLine(frame: AgencyStationCustomerWaitingFrame): string {
  const who = frame.match_name?.trim() || (frame.from_e164 ? formatDialNumber(frame.from_e164) : null);
  return who ? `Your customer is waiting: ${who}` : 'Your customer is waiting';
}

/** The pill's title: what happens next. */
export const CUSTOMER_WAITING_HINT =
  'A customer who usually speaks to you has rung in and is on hold. Finish this call’s work soon to take them.';

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}
