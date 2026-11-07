// Plivo's call callbacks, read into one flat shape. Plivo POSTs form-encoded params to
// three URLs we hand it per dial:
//
//  - `answer_url` when the callee answers (`CallStatus=in-progress`); we reply with XML;
//  - `ring_url` and `hangup_url` (both our status URL): `CallStatus=ringing`, then one
//    terminal status: completed | busy | failed | timeout | no-answer | cancel;
//  - the `<Record callbackUrl>` when a session recording is ready (`RecordUrl`, …).
//
// The terminal vocabulary is VoiceLink's (`VoicelinkOutcome`), so the bridge settles both
// carriers' terminals the same way.
import type { CallEvent } from '../types.js';
import type { VoicelinkOutcome } from '../voicelink/voicelink.webhook.js';

export type PlivoCallbackKind = 'answer' | 'status' | 'recording';

/** Every terminal `CallStatus` Plivo reports on its hangup callback. */
export const PLIVO_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed', 'busy', 'failed', 'timeout', 'no-answer', 'cancel',
]);

export interface NormalizedPlivoCallback {
  kind: PlivoCallbackKind;
  /** Plivo's `CallUUID`, or ''. The id hangup, CDR and recording lookups take. */
  callUuid: string;
  /** Plivo's `RequestUUID` (the create-call's `request_uuid`), or ''. */
  requestUuid: string;
  /** Lower-cased `CallStatus`, or ''. */
  callStatus: string;
  /** `HangupCauseName`, else `HangupCause`, or ''. */
  hangupCause: string;
  hangupCauseCode: string;
  /** `HangupSource` (Caller, Callee, Plivo, API Request, Error, …), or ''. */
  hangupSource: string;
  /** `Duration`, whole seconds. */
  durationSec?: number;
  /** `AnswerTime` as Plivo sent it (non-empty only). */
  answeredAt?: string;
  /** `EndTime` as Plivo sent it (non-empty only). */
  endedAt?: string;
  /** `RecordUrl` (recording callbacks). */
  recordingUrl?: string;
  /** `RecordingID` (recording callbacks). */
  recordingId?: string;
  /** `RecordingDuration`, whole seconds (recording callbacks). */
  recordingDurationSec?: number;
  /** True iff the callee answered. */
  wasAnswered: boolean;
}

const str = (params: Record<string, string>, key: string): string => {
  const v = params[key];
  return typeof v === 'string' ? v.trim() : '';
};

/** A whole number of seconds, or undefined for anything that is not plain digits. */
const seconds = (raw: string): number | undefined => (/^\d+$/.test(raw) ? Number(raw) : undefined);

/** A real instant: parses, and is not epoch 0 (a zero-value placeholder). */
const isRealInstant = (raw: string): boolean => {
  if (raw === '') return false;
  const t = Date.parse(raw);
  return Number.isFinite(t) && t > 0;
};

/**
 * Read a callback's params. Never throws: a missing field is '' or absent.
 *
 * `wasAnswered`: an answer callback (`in-progress`), or an `AnswerTime` that is a real
 * instant, or a `completed` call with a non-zero `Duration` or `BillDuration`. A
 * `completed` with none of those is not taken as answered: reading it so would settle a
 * call nobody picked up as a success.
 */
export function normalizePlivoCallback(kind: PlivoCallbackKind, params: Record<string, string>): NormalizedPlivoCallback {
  const callStatus = str(params, 'CallStatus').toLowerCase();
  const answerTime = str(params, 'AnswerTime');
  const endTime = str(params, 'EndTime');
  const durationSec = seconds(str(params, 'Duration'));
  const billSec = seconds(str(params, 'BillDuration'));
  const recordingUrl = str(params, 'RecordUrl');
  const recordingId = str(params, 'RecordingID');
  const recordingDurationSec = seconds(str(params, 'RecordingDuration'));
  const wasAnswered = callStatus === 'in-progress'
    || isRealInstant(answerTime)
    || (callStatus === 'completed' && ((durationSec ?? 0) > 0 || (billSec ?? 0) > 0));
  return {
    kind,
    callUuid: str(params, 'CallUUID'),
    requestUuid: str(params, 'RequestUUID'),
    callStatus,
    hangupCause: str(params, 'HangupCauseName') || str(params, 'HangupCause'),
    hangupCauseCode: str(params, 'HangupCauseCode'),
    hangupSource: str(params, 'HangupSource'),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(answerTime ? { answeredAt: answerTime } : {}),
    ...(endTime ? { endedAt: endTime } : {}),
    ...(recordingUrl ? { recordingUrl } : {}),
    ...(recordingId ? { recordingId } : {}),
    ...(recordingDurationSec !== undefined ? { recordingDurationSec } : {}),
    wasAnswered,
  };
}

/**
 * Classify a terminal callback. An answered call is `completed`; otherwise Plivo's own
 * `CallStatus` names the outcome. `failed` (and a `completed` nobody answered, and any
 * status Plivo does not document) is `failed`, its outcome the raw cause.
 */
export function classifyPlivoOutcome(n: NormalizedPlivoCallback): VoicelinkOutcome {
  const rawCause = [n.callStatus, n.hangupCause, n.hangupCauseCode, n.hangupSource]
    .filter(Boolean)
    .join('|')
    .toLowerCase();
  if (n.wasAnswered) return { status: 'completed', outcome: 'remote_hangup', rawCause };
  switch (n.callStatus) {
    case 'no-answer':
    case 'timeout':
      return { status: 'no_answer', outcome: 'no_answer', rawCause };
    case 'busy':
      return { status: 'busy', outcome: 'busy', rawCause };
    case 'cancel':
      return { status: 'canceled', outcome: 'canceled', rawCause };
    default:
      break;
  }
  // A failed call whose cause says the callee turned it down reads as VoiceLink's does.
  const cause = n.hangupCause.toLowerCase();
  if (cause.includes('reject') || cause.includes('declin')) {
    return { status: 'canceled', outcome: 'canceled', rawCause };
  }
  return { status: 'failed', outcome: rawCause || 'telephony_error', rawCause };
}

/**
 * The lifecycle event a callback drives, or null when it drives none (a recording
 * callback, or a status Plivo does not document):
 *
 *   answer callback                       → answer
 *   status `ringing`                      → ringing
 *   status `in-progress`                  → answer
 *   terminal status, answered             → hangup
 *   terminal status, not answered         → error
 *
 * A terminal event carries the classification as `dispositionStatus` (and the carrier's
 * wording as `dispositionCause`), as VoiceLink's events do.
 */
export function plivoCallEvent(n: NormalizedPlivoCallback, callId: string): CallEvent | null {
  if (n.kind === 'recording') return null;
  let eventType: CallEvent['eventType'];
  let terminal = false;
  if (n.kind === 'answer' || n.callStatus === 'in-progress') {
    eventType = 'answer';
  } else if (n.callStatus === 'ringing') {
    eventType = 'ringing';
  } else if (PLIVO_TERMINAL_STATUSES.has(n.callStatus)) {
    terminal = true;
    eventType = n.wasAnswered ? 'hangup' : 'error';
  } else {
    return null;
  }
  const disposition = terminal ? classifyPlivoOutcome(n) : undefined;
  return {
    providerCallId: n.callUuid,
    callId,
    provider: 'plivo',
    eventType,
    timestamp: new Date(),
    direction: 'outbound',
    metadata: {
      rawEvent: n.kind,
      rawCallStatus: n.callStatus,
      requestUuid: n.requestUuid,
      hangupCause: n.hangupCause,
      hangupCauseCode: n.hangupCauseCode,
      hangupSource: n.hangupSource,
      answeredAt: n.answeredAt,
      endedAt: n.endedAt,
      durationSec: n.durationSec,
      recordingUrl: n.recordingUrl,
      wasAnswered: n.wasAnswered,
      ...(disposition
        ? {
            dispositionStatus: disposition.status,
            ...(n.hangupCause ? { dispositionCause: n.hangupCause } : {}),
          }
        : {}),
    },
  };
}

/**
 * The callback a {@link plivoCallEvent} event was made from, read back off its metadata
 * (the bridge is handed the event, not the params). Never throws: a field the event does
 * not carry is '' or absent, as in {@link normalizePlivoCallback}.
 */
export function plivoCallbackFromEvent(event: CallEvent): NormalizedPlivoCallback {
  const m = (event.metadata ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const kind: PlivoCallbackKind = m['rawEvent'] === 'answer' || m['rawEvent'] === 'recording' ? m['rawEvent'] : 'status';
  const durationSec = typeof m['durationSec'] === 'number' ? m['durationSec'] : undefined;
  return {
    kind,
    callUuid: typeof event.providerCallId === 'string' ? event.providerCallId : '',
    requestUuid: text(m['requestUuid']),
    callStatus: text(m['rawCallStatus']),
    hangupCause: text(m['hangupCause']),
    hangupCauseCode: text(m['hangupCauseCode']),
    hangupSource: text(m['hangupSource']),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(text(m['answeredAt']) ? { answeredAt: text(m['answeredAt']) } : {}),
    ...(text(m['endedAt']) ? { endedAt: text(m['endedAt']) } : {}),
    ...(text(m['recordingUrl']) ? { recordingUrl: text(m['recordingUrl']) } : {}),
    ...(text(m['recordingId']) ? { recordingId: text(m['recordingId']) } : {}),
    wasAnswered: m['wasAnswered'] === true,
  };
}

/** Which callback a param set is, when the route does not say: a recording, else a status. */
export function inferPlivoCallbackKind(params: Record<string, string>): PlivoCallbackKind {
  if (str(params, 'RecordUrl') || str(params, 'RecordingID')) return 'recording';
  return 'status';
}
