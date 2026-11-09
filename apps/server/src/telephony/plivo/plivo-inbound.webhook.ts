// Plivo's callbacks for a call a CUSTOMER placed to one of a tenant's numbers linked to inbound
// (docs/inbound.md §3, §3.1). Plivo runs the tenant's inbound Application, which names three
// credential-level URLs (stored on the credential, `inbound_*_url`):
//
//  - the answer URL when the call arrives (`From`, `To`, `CallUUID`, `Direction=inbound`,
//    `CallStatus`); we reply with XML;
//  - the hangup URL once it ends (a terminal `CallStatus` and the hangup cause);
//  - the fallback answer URL, which Plivo fetches only when the answer URL fails: it is answered
//    with fixed XML ({@link PLIVO_INBOUND_FALLBACK_XML}).
//
// Not `plivo.webhook.ts`'s reader: that one hardcodes `Direction: outbound` and reads an answer
// callback as the far end picking up a call WE placed. Here the answer callback is a call arriving,
// and it is OUR answer XML that answers it.
//
// The parameter names are Plivo's documented callback parameters. Which values Plivo sends on an
// inbound answer (`CallStatus` `ringing` or `in-progress`; whether `Direction` is always present)
// is not verified against a live call yet (P0, docs/inbound.md §12): the fixture
// (`plivo-inbound.fixture.json`) marks every entry `verified: false`, and the reader depends on
// neither: an answer needs a `CallUUID` and a `To`, and refuses only a `Direction` that names
// another direction.
import { plivoNumberToE164 } from '@magick-agency/domain/plivo-number';
import { AGENCY_INBOUND_STANDARD_WORDS } from '@magick-agency/contracts/api/agency/inbound';
import type { CallEvent } from '../types.js';
import { xmlEscape } from './plivo.adapter.js';
import { PLIVO_TERMINAL_STATUSES } from './plivo.webhook.js';

const str = (params: Record<string, string>, key: string): string => {
  const v = params[key];
  return typeof v === 'string' ? v.trim() : '';
};

/** A whole number of seconds, or undefined for anything that is not plain digits. */
const seconds = (raw: string): number | undefined => (/^\d+$/.test(raw) ? Number(raw) : undefined);

/** An arriving call, as the answer URL reads it. */
export interface PlivoInboundArrival {
  /** Plivo's `CallUUID`: the spine's `provider_call_id`, the id a REST hangup and the hangup URL name. */
  callUuid: string;
  /** The caller as +E.164 (`plivoNumberToE164`), or null: withheld, anonymous, a SIP URI, anything unreadable. */
  fromE164: string | null;
  /** The number rung as +E.164: never null on a reading that is returned. */
  toE164: string;
  /** Lower-cased `CallStatus`, or '' (informational: the reader does not depend on it). */
  callStatus: string;
}

/** Why an answer callback cannot be read as an arriving call. */
export type PlivoInboundArrivalRefusal = 'no_call_uuid' | 'no_to' | 'not_inbound';

/**
 * Read the answer URL's params. Never throws. Refused (and answered with a hangup by the route):
 * no `CallUUID`, a `To` that is not a phone number (the number rung is how the call is routed), or
 * a `Direction` present and not `inbound` (an outbound call's answer posted to the inbound URL is
 * not one of ours to route). A `From` that is not a number is a withheld caller, never a refusal.
 */
export function readPlivoInboundArrival(
  params: Record<string, string>,
): { ok: true; arrival: PlivoInboundArrival } | { ok: false; reason: PlivoInboundArrivalRefusal } {
  const callUuid = str(params, 'CallUUID');
  if (!callUuid) return { ok: false, reason: 'no_call_uuid' };
  const direction = str(params, 'Direction').toLowerCase();
  if (direction !== '' && direction !== 'inbound') return { ok: false, reason: 'not_inbound' };
  const toE164 = plivoNumberToE164(str(params, 'To'));
  if (!toE164) return { ok: false, reason: 'no_to' };
  return {
    ok: true,
    arrival: {
      callUuid,
      fromE164: plivoNumberToE164(str(params, 'From')),
      toE164,
      callStatus: str(params, 'CallStatus').toLowerCase(),
    },
  };
}

/** The hangup URL's params, read. */
export interface PlivoInboundHangup {
  /** Plivo's `CallUUID`, or '' (the route refuses a hangup without one). */
  callUuid: string;
  /** Lower-cased `CallStatus`, or ''. */
  callStatus: string;
  /** True for a status that ends the call (`completed`, `busy`, `failed`, `timeout`, `no-answer`, `cancel`). */
  terminal: boolean;
  /** `HangupCauseName`, else `HangupCause`, or ''. */
  hangupCause: string;
  hangupCauseCode: string;
  /** `HangupSource` (`Caller`, `Callee`, `Plivo`, `API Request`, `Error`, …), or ''. */
  hangupSource: string;
  /** `Duration`, whole seconds. */
  durationSec?: number;
  /** `EndTime` as Plivo sent it (non-empty only). */
  endedAt?: string;
}

/** Read the hangup URL's params. Never throws: a missing field is '' or absent. */
export function readPlivoInboundHangup(params: Record<string, string>): PlivoInboundHangup {
  const callStatus = str(params, 'CallStatus').toLowerCase();
  const durationSec = seconds(str(params, 'Duration'));
  const endTime = str(params, 'EndTime');
  return {
    callUuid: str(params, 'CallUUID'),
    callStatus,
    terminal: PLIVO_TERMINAL_STATUSES.has(callStatus),
    hangupCause: str(params, 'HangupCauseName') || str(params, 'HangupCause'),
    hangupCauseCode: str(params, 'HangupCauseCode'),
    hangupSource: str(params, 'HangupSource'),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(endTime ? { endedAt: endTime } : {}),
  };
}

/**
 * The bridge's terminal event for an inbound media leg the carrier says has ended: `hangup`, and
 * answered (our answer XML answered it, so the leg was live whatever the status says), so the
 * bridge settles it `completed` with nothing sent back to the carrier. The metadata keys are the
 * ones `plivoCallbackFromEvent` reads back (the Plivo carrier module's lifecycle reader).
 */
export function plivoInboundHangupEvent(h: PlivoInboundHangup, legId: string): CallEvent {
  return {
    providerCallId: h.callUuid,
    callId: legId,
    provider: 'plivo',
    eventType: 'hangup',
    timestamp: new Date(),
    direction: 'inbound',
    metadata: {
      rawEvent: 'status',
      rawCallStatus: h.callStatus,
      hangupCause: h.hangupCause,
      hangupCauseCode: h.hangupCauseCode,
      hangupSource: h.hangupSource,
      endedAt: h.endedAt,
      durationSec: h.durationSec,
      wasAnswered: true,
      dispositionStatus: 'completed',
      ...(h.hangupCause ? { dispositionCause: h.hangupCause } : {}),
    },
  };
}

/**
 * Spoken by Plivo itself (`<Speak>`, its own text to speech), in British English, where nothing
 * of ours streams: the fallback (we are unreachable), a call with no account to stream for (the
 * tenant default, §8.3), and a route's closed, "we'll call you back" or "all lines busy" message
 * when the route has no recording for it and the call will not stream (§3.4). The closed,
 * call-back and busy words are our standard recordings' (`AGENCY_INBOUND_STANDARD_WORDS`), so a
 * caller hears the same sentence whether it is spoken here or played from our stream.
 */
// The contract's words use typographic apostrophes; the carrier's speech is given plain ones.
const SPEAK = (text: string): string => `<Speak voice="WOMAN" language="en-GB">${xmlEscape(text.replace(/’/g, "'"))}</Speak>`;

/**
 * The fallback answer URL's reply: Plivo runs it when our answer URL fails (a deploy, an outage),
 * and our answer route speaks it when it cannot place a call. Static: no database, no state. It
 * promises no callback: a call answered by the fallback may never have reached us, so it may
 * leave no Missed row (docs/inbound.md §3.3, the operator-hosted file says the same).
 */
export const PLIVO_INBOUND_FALLBACK_XML =
  `<Response>${SPEAK("Sorry, we can't take your call right now. Please try again shortly.")}<Hangup/></Response>`;

/**
 * The closed message: a call that has nowhere to stream (the tenant default: no route and no
 * matched contact, so no account, §8.3), a route closed now with no closed recording, and any
 * caller who withheld their number or is on DNC where the route would promise a callback (nobody
 * can ring them back). Promises nothing. The Missed row is written.
 */
export const PLIVO_INBOUND_CLOSED_XML =
  `<Response>${SPEAK(AGENCY_INBOUND_STANDARD_WORDS.closed)}<Hangup/></Response>`;

/** A route's "we'll call you back" message with no recording (the call reached nobody; its follow-up is written). */
export const PLIVO_INBOUND_CALLBACK_XML =
  `<Response>${SPEAK(AGENCY_INBOUND_STANDARD_WORDS.callback)}<Hangup/></Response>`;

/** A route's "all lines busy" message with no recording (the route at its limit; its follow-up is written). */
export const PLIVO_INBOUND_BUSY_XML =
  `<Response>${SPEAK(AGENCY_INBOUND_STANDARD_WORDS.busy)}<Hangup/></Response>`;

/** The XML for a spoken answer (`seams/inbound-call-router.ts`, `InboundSpokenMessage`). */
export const PLIVO_INBOUND_SPOKEN_XML: Readonly<Record<'closed' | 'callback' | 'busy', string>> = Object.freeze({
  closed: PLIVO_INBOUND_CLOSED_XML,
  callback: PLIVO_INBOUND_CALLBACK_XML,
  busy: PLIVO_INBOUND_BUSY_XML,
});
