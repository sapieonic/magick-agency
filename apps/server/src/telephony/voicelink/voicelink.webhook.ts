// PORT NOTE (magick-agency): ported from core src/telephony/voicelink/voicelink.webhook.ts@4850d1d9; only the logger import specifier changed.
import type { CallEvent } from '../types.js';
import { createChildLogger } from '@magick-agency/observability';
import type { VoicelinkWebhookBody, VoicelinkWebhookCall } from './voicelink.types.js';

const log = createChildLogger({ component: 'voicelink-webhook' });

/**
 * A VoiceLink webhook normalized into one flat internal shape, regardless of
 * whether the carrier sent the observed NESTED (`body.call.*`) or the documented
 * FLAT (top-level) payload. All downstream logic reads THIS, never the raw body.
 */
export interface NormalizedVoicelinkWebhook {
  event: string;
  /** The carrier's real call id (VoiceLink `call.id` / flat `callId`), or ''. */
  providerCallId: string;
  direction: 'inbound' | 'outbound';
  /** Upper-cased `callStatus` (e.g. "ANSWERED"/"NO ANSWER"), or ''. */
  callStatus: string;
  /** Upper-cased secondary `status` hint (e.g. "ENDED"/"FAILED"), or ''. */
  status: string;
  hangupCause: string;
  hangupReason: string;
  sipStatus: string;
  durationSec?: number;
  answeredAt?: string;
  endedAt?: string;
  recordingUrl?: string;
  /** True iff the call was actually answered (drives success/failure split). */
  wasAnswered: boolean;
}

/**
 * Merge the nested (`call.*`) and flat (top-level) VoiceLink payload shapes into
 * one structure. Nested wins when both are present (the observed live shape),
 * falling back to the documented flat fields.
 */
export function normalizeVoicelinkWebhook(body: VoicelinkWebhookBody): NormalizedVoicelinkWebhook {
  const call: VoicelinkWebhookCall = body.call || {};
  const first = <T>(...vals: Array<T | undefined | null>): T | undefined =>
    vals.find((v) => v !== undefined && v !== null && v !== '') as T | undefined;

  const event = (body.event || '').toLowerCase();
  const providerCallId = first<string>(call.id, body.callId) || '';
  const callStatus = (first<string>(call.callStatus, body.callStatus) || '').toUpperCase();
  const status = (first<string>(call.status, body.status) || '').toUpperCase();
  const direction =
    first<string>(call.direction, body.direction) === 'inbound' ? 'inbound' : 'outbound';
  const durationSec = first<number>(call.durationSec, body.durationSec, body.duration);

  return {
    event,
    providerCallId,
    direction,
    callStatus,
    status,
    // Same coercion as `sipStatus`: the clean-teardown branch regex-tests this
    // field directly, and the declared `string` type is unvalidated wire data.
    hangupCause: String(first<string | number>(call.hangupCause, body.hangupCause) ?? '') || '',
    hangupReason: first<string>(call.hangupReason, body.hangupReason) || '',
    // `String(...)` because every `sipStatus` consumer compares against a string
    // literal (`sip === '486'`, `'200'`, …). The field is TYPED `string?`, but
    // nothing validates the wire payload — a carrier that JSON-encodes it as the
    // number 200 would silently fail every one of those comparisons and fall
    // through to `failed`. Normalizing once here covers all branches at the source.
    sipStatus: String(first<string | number>(call.sipStatus, body.sipStatus) ?? '') || '',
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(first<string>(call.answeredAt, body.answeredAt) !== undefined
      ? { answeredAt: first<string>(call.answeredAt, body.answeredAt) }
      : {}),
    ...(first<string>(call.endedAt, body.endedAt) !== undefined
      ? { endedAt: first<string>(call.endedAt, body.endedAt) }
      : {}),
    ...(first<string>(call.recordingUrl, body.recordingUrl) !== undefined
      ? { recordingUrl: first<string>(call.recordingUrl, body.recordingUrl) }
      : {}),
    // Answered if callStatus says so: the doc shape uses "ANSWER", the live shape
    // "ANSWERED". A substring test would also match the NEGATIVE values
    // "NO ANSWER"/"NOANSWER" (both contain "ANSWER"), so collapse separators and
    // exclude any string containing "NOANSWER" before matching the positive form.
    // Separators (not just whitespace) are collapsed so the drift spellings
    // "NO_ANSWER"/"NO-ANSWER" can't read as answered — the same vocabulary drift
    // that caused this bug in the first place (VoiceLink's "NO ANSWER" with a
    // space vs the VoBiz-shaped `no-answer` with a hyphen).
    //
    // `answeredAt` is the SECOND positive signal, and the load-bearing one for
    // `call.ended` — that payload carries NO `callStatus` at all (only
    // `status:"ended"` + `hangupCause` + `answeredAt`), so a callStatus-only test
    // reports every `call.ended` as unanswered. Measured over the captures: all
    // 8 `call.ended` payloads carry a non-null `answeredAt`, and across every
    // terminal payload it is non-null on the 16 answered and null on all 7
    // unanswered — a reliable discriminator.
    //
    // It must PARSE as a real instant, not merely be a non-empty string: a
    // carrier that JSON-encodes null as the literal "null", or emits an
    // unparseable value, would otherwise mint a phantom answered call — exactly
    // the failure mode this whole change exists to remove. Epoch 0 is rejected
    // too; it is a zero-value placeholder, never a real pickup time.
    wasAnswered: (() => {
      const collapsed = callStatus.replace(/[\s_-]+/g, '');
      if (collapsed.includes('NOANSWER')) return false;
      if (collapsed.includes('ANSWER')) return true;
      // No usable callStatus — fall back to the answer timestamp.
      const at = first<string>(call.answeredAt, body.answeredAt);
      if (typeof at !== 'string' || at.trim() === '') return false;
      const parsed = Date.parse(at);
      return Number.isFinite(parsed) && parsed > 0;
    })(),
  };
}

/**
 * Extract just the recording URL from either payload shape (used by the webhook
 * route to persist a late `call.completed` recording independently of parsing).
 */
export function extractVoicelinkRecordingUrl(body: VoicelinkWebhookBody): string | undefined {
  return body.call?.recordingUrl || body.recordingUrl || undefined;
}

/**
 * A VoiceLink-specific terminal outcome. `no_answer`/`busy`/`canceled`/`failed`
 * preserve the real reason instead of collapsing every non-answer into a generic
 * telephony error. `rawCause` is retained for diagnostics (bounded — never used
 * as a status value).
 */
export interface VoicelinkOutcome {
  status: 'completed' | 'no_answer' | 'busy' | 'canceled' | 'failed';
  outcome: string;
  rawCause: string;
}

/**
 * Classify a terminal VoiceLink event into a specific outcome using the signals
 * the payload actually carries (`callStatus`, `status`, `hangupCause`,
 * `hangupReason`, `sipStatus`). An answered call is `completed`; otherwise we map
 * the raw cause to no_answer/busy/canceled, falling back to `failed`.
 *
 * Order matters and is load-bearing: `wasAnswered` is consulted FIRST, before any
 * cause inspection, because VoiceLink reuses Q.850 cause 16 for both an answered
 * call that hung up normally (`hangupCause:"16"`) and an unanswered one that was
 * never taken (`"16 - Normal Clearing"`). The cause alone cannot tell them apart;
 * only `answeredAt`/`callStatus` can.
 */
export function classifyVoicelinkOutcome(n: NormalizedVoicelinkWebhook): VoicelinkOutcome {
  const rawCause = [n.callStatus, n.status, n.hangupReason, n.hangupCause]
    .filter(Boolean)
    .join('|')
    .toLowerCase();

  if (n.wasAnswered) {
    return { status: 'completed', outcome: 'remote_hangup', rawCause };
  }
  // SIP status codes (486 busy, 487 request terminated/cancel, 480/408 no-answer).
  const sip = n.sipStatus;
  if (rawCause.includes('no answer') || rawCause.includes('no-answer') || rawCause.includes('no_answer')
    || rawCause.includes('timeout') || rawCause.includes('noanswer') || sip === '408' || sip === '480') {
    return { status: 'no_answer', outcome: 'no_answer', rawCause };
  }
  if (rawCause.includes('busy') || sip === '486') {
    return { status: 'busy', outcome: 'busy', rawCause };
  }
  if (rawCause.includes('cancel') || rawCause.includes('reject') || rawCause.includes('declin') || sip === '487') {
    return { status: 'canceled', outcome: 'canceled', rawCause };
  }
  // Unanswered, and the carrier reported a CLEAN TEARDOWN (Q.850 16 "normal
  // clearing" + SIP 200) rather than a fault. Measured on staging across two
  // independent trials (6 labelled calls): a DECLINED call and a SWITCHED-OFF
  // handset produce byte-identical payloads here —
  //
  //   event=call.ended, status=ended, callStatus ABSENT,
  //   hangupCause="16 - Normal Clearing", hangupReason="Normal Clearing",
  //   sipStatus="200", answeredAt ABSENT, legs[0].answerTime=null
  //
  // — differing only in ring duration by 27ms and 1ms respectively, both pinned
  // at the carrier's ~31s ring ceiling. VoiceLink does not surface the upstream
  // Q.850 cause that would separate them (17 user busy / 20 subscriber absent /
  // 21 call rejected); that is raised with the carrier separately. Until it is,
  // `busy` is the operator-facing label for both: the callee was reachable but
  // did not take the call.
  //
  // Deliberately NOT the `failed` default, which is what these settled as before
  // and rendered as "Didn't connect" — indistinguishable from a real telephony
  // fault in the call list, in `AI_CALLS_CONNECTED_STATUSES`, and to the
  // platform's campaign-retry policy. `failed` stays reserved for genuine faults.
  //
  // Scoped narrowly to the observed signature rather than widening the fallback:
  // an unanswered call with an UNRECOGNISED cause is still a `failed`, because
  // we genuinely can't say what happened.
  //
  // Matched against `hangupCause` ALONE, anchored at the leading Q.850 code —
  // deliberately NOT against `rawCause`, which is the pipe-joined [callStatus,
  // status, hangupReason, hangupCause] blob. Testing the blob would fire on
  // "normal clearing" appearing in ANY of the four fields, so a carrier that
  // desynced them ("34 - No circuit available" + hangupReason "Normal Clearing")
  // would have a genuine fault relabelled as "the callee didn't take the call".
  // Anchoring also rejects a stray 16 embedded elsewhere in the string
  // ("cause=16;…", "1-16"), which a token match would have accepted.
  //
  // Cause 16 is never a standalone mapping: a bare "16" rides on ANSWERED calls
  // and "16 - Normal Clearing" on unanswered ones, so this is only ever reached
  // AFTER the `wasAnswered` return above.
  //
  // `outcome` is 'not_reached' to match what the AI-call path actually persists
  // (`call.busy` → handleCallEnd(…, 'busy', 'not_reached', …)), so the three call
  // types agree. A distinct label here would be discarded on the AI and static
  // paths (static_calls has no outcome column at all) and survive only on
  // webrtc_calls — one dialer-only value that no consumer maps.
  const cause16 = /^\s*16\b/.test(n.hangupCause);
  if (cause16 && sip === '200') {
    return { status: 'busy', outcome: 'not_reached', rawCause };
  }
  return { status: 'failed', outcome: rawCause || 'telephony_error', rawCause };
}

/**
 * Parse a VoiceLink lifecycle webhook body into our internal `CallEvent`, or
 * `null` for purely informational events (`call.initiated`) that shouldn't drive
 * a state transition. Modeled on VoBiz's `parseVobizStatusCallback`.
 *
 * VoiceLink event → CallEvent mapping (see implementation plan §1.3):
 *   call.ringing                         → ringing
 *   call.answered                        → answer
 *   call.ended    (terminal, answered)   → hangup
 *   call.ended    (terminal, unanswered) → error
 *   call.failed                          → error    (never connected)
 *   call.completed (terminal, ANSWERED)  → hangup
 *   call.completed (terminal, not ANSWERED) → error
 *   call.initiated                       → null (informational, no transition)
 *
 * Accepts BOTH the nested (`body.call.*`, observed live) and flat (top-level,
 * documented) payload shapes via `normalizeVoicelinkWebhook`.
 *
 * NOTE: a real `call.ended` payload has NO `callStatus` field — it carries
 * `status:"ended"`, `hangupCause`, `answeredAt`, `durationSec`. It is emitted for
 * BOTH answered and unanswered calls, so the answered split applies to it just as
 * it does to `call.completed`; `answeredAt` is the discriminator. (This docblock
 * previously claimed `call.ended` implied an answer — VoiceLink's own docs say so,
 * but production does not: 429 `call.ended` vs 206 `call.answered` over 24h on
 * dedicated. Treat carrier docs as a hypothesis and the captures as the truth.)
 *
 * VoiceLink has NO AMD/voicemail, so there is no `machine` mapping. Both
 * `call.ended`/`call.failed` AND `call.completed` are terminal — the second is
 * deduped downstream by CallManager's `callEndTriggered`/`endHandled` guards.
 */
export function parseVoicelinkWebhook(body: VoicelinkWebhookBody, callId: string): CallEvent | null {
  const n = normalizeVoicelinkWebhook(body);

  // A terminal event carries the carrier's real disposition in `callStatus`
  // ("ANSWERED" / "NO ANSWER" / "BUSY" / …). Classify it here — the same
  // classification the WebRTC and WS-static owners already run — and attach the
  // result to the event, so the AI-call owner (CallManager) settles on the
  // carrier's actual outcome instead of collapsing every non-answer into a
  // generic TELEPHONY_ERROR failure.
  //
  // `call.ended` carries NO `callStatus` of its own and is only ever emitted for
  // a call that WAS answered, so fold that in before classifying — otherwise a
  // normal remote hangup would classify as an unanswered failure.
  const isTerminal = n.event === 'call.ended' || n.event === 'call.failed' || n.event === 'call.completed';
  // `n.wasAnswered` is used as-is. It previously carried an
  // `|| n.event === 'call.ended'` override, on the documented assumption that
  // VoiceLink only emits `call.ended` for answered calls — which production
  // disproves (429 `call.ended` vs 206 `call.answered` over 24h on dedicated).
  // That override forced an unanswered `call.ended` to classify `completed`,
  // which is exactly the phantom-success settlement this classification exists
  // to prevent. `normalizeVoicelinkWebhook` already resolves the answered
  // question correctly for a payload with no `callStatus` by falling back to
  // `answeredAt`, so no override is needed here.
  const disposition = isTerminal ? classifyVoicelinkOutcome(n) : undefined;

  let eventType: CallEvent['eventType'];
  switch (n.event) {
    case 'call.initiated':
      // Informational only — the call record already exists (we created it) and
      // there is no 'initiated' transition. Don't forward.
      return null;
    case 'call.ringing':
      eventType = 'ringing';
      break;
    case 'call.answered':
      eventType = 'answer';
      break;
    case 'call.ended':
      // Terminal in BOTH success and failure — same split as `call.completed`.
      //
      // This branch USED to be an unconditional `hangup`, on the documented
      // assumption that VoiceLink only emits `call.ended` for answered calls and
      // sends `call.failed` for the rest. Production disproves it: over 24h on
      // dedicated we saw 429 `call.ended` against 206 `call.answered`, i.e. about
      // half of them for calls that were never picked up. Because a `call.ended`
      // payload also carries no `callStatus`, CallManager's hangup handler found
      // an empty `rawCallStatus`, matched none of its branches, and fell through
      // to the `completed` default — settling unanswered calls as phantom
      // successes (240/24h with talk_time_seconds=0, all counted as connected by
      // AI_CALLS_CONNECTED_STATUSES).
      eventType = n.wasAnswered ? 'hangup' : 'error';
      break;
    case 'call.failed':
      eventType = 'error';
      break;
    case 'call.completed':
      // Terminal in BOTH success and failure — distinguish via callStatus.
      eventType = n.wasAnswered ? 'hangup' : 'error';
      break;
    default:
      log.warn({ callId, event: n.event }, 'Unknown VoiceLink webhook event');
      return null;
  }

  return {
    providerCallId: n.providerCallId,
    callId,
    eventType,
    timestamp: new Date(),
    direction: n.direction,
    metadata: {
      ...(body as Record<string, unknown>),
      rawEvent: n.event,
      rawCallStatus: n.callStatus,
      rawStatus: n.status,
      hangupCause: n.hangupCause,
      hangupReason: n.hangupReason,
      sipStatus: n.sipStatus,
      answeredAt: n.answeredAt,
      endedAt: n.endedAt,
      durationSec: n.durationSec,
      recordingUrl: n.recordingUrl,
      wasAnswered: n.wasAnswered,
      // Carrier disposition, present only on terminal events. `dispositionStatus`
      // is the classified terminal status the call should settle as;
      // `dispositionCause` is the operator-readable reason behind it, and only
      // ever reaches error_message.
      //
      // Deliberately only the two fields that carry the carrier's own WORDING:
      // `hangupReason` ("User alerting, no answer"), then `hangupCause`, which
      // says the same thing prefixed with the Q.850 code ("19 - User alerting,
      // no answer"). `callStatus` is excluded because it restates the status
      // ("NO ANSWER"/"BUSY") that `dispositionStatus` already carries, and
      // `rawCause` is a lowercased pipe-joined string built for classification,
      // not for a human — and it omits sipStatus. Both would add nothing while
      // suppressing CallManager's richer raw-body fallback, which is what should
      // land when the carrier named no reason at all.
      ...(disposition
        ? {
            dispositionStatus: disposition.status,
            ...(n.hangupReason || n.hangupCause
              ? { dispositionCause: n.hangupReason || n.hangupCause }
              : {}),
          }
        : {}),
    },
  };
}
