import { formatDialNumber } from '../softphone/phoneInput';
import { contextName } from '../softphone/callState';
import type {
  AgencyInboundCall,
  AgencyInboundCallState,
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

/** Why the outcome pad is closed, by phase. */
export const INBOUND_PAD_DISABLED_COPY = 'Outcomes open when you’re connected to the caller.';

/** The "Your customer is waiting" pill's words. */
export function customerWaitingLine(frame: AgencyStationCustomerWaitingFrame): string {
  const who = frame.match_name?.trim() || (frame.from_e164 ? formatDialNumber(frame.from_e164) : null);
  return who ? `Your customer is waiting: ${who}` : 'Your customer is waiting';
}

/** The pill's title: what happens next. */
export const CUSTOMER_WAITING_HINT =
  'A customer who usually speaks to you has rung in and is on hold. Finish this call’s work soon to take them.';
