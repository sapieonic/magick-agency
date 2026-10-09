import { describe, it, expect } from 'vitest';
import {
  parseVoicelinkWebhook,
  normalizeVoicelinkWebhook,
  classifyVoicelinkOutcome,
  extractVoicelinkRecordingUrl,
} from '../../../../src/telephony/voicelink/voicelink.webhook.js';

describe('normalizeVoicelinkWebhook — dual payload shapes', () => {
  it('reads the observed NESTED shape (body.call.*)', () => {
    const n = normalizeVoicelinkWebhook({
      event: 'call.completed',
      call: {
        id: 'carrier-1',
        direction: 'outbound',
        callStatus: 'ANSWERED',
        durationSec: 4,
        recordingUrl: 'https://rec/abc.mp3',
        hangupCause: '16',
      },
    });
    expect(n.providerCallId).toBe('carrier-1');
    expect(n.callStatus).toBe('ANSWERED');
    expect(n.wasAnswered).toBe(true);
    expect(n.durationSec).toBe(4);
    expect(n.recordingUrl).toBe('https://rec/abc.mp3');
  });

  it('reads the documented FLAT shape (top-level callId/callStatus/duration/recordingUrl)', () => {
    const n = normalizeVoicelinkWebhook({
      event: 'call.completed',
      callId: '1764828073.53871',
      callStatus: 'ANSWER',
      direction: 'inbound',
      duration: 8,
      recordingUrl: 'https://example.com/recording.wav',
    });
    expect(n.providerCallId).toBe('1764828073.53871');
    expect(n.callStatus).toBe('ANSWER');
    expect(n.wasAnswered).toBe(true);
    expect(n.durationSec).toBe(8);
    expect(n.recordingUrl).toBe('https://example.com/recording.wav');
    expect(n.direction).toBe('inbound');
  });

  it('nested wins when both shapes are present', () => {
    const n = normalizeVoicelinkWebhook({
      event: 'call.completed',
      callId: 'flat-id',
      call: { id: 'nested-id' },
    });
    expect(n.providerCallId).toBe('nested-id');
  });

  it('does not misread "NOANSWER" (no space) as answered', () => {
    // "NOANSWER" contains "ANSWER" as a substring — a naive includes() test would
    // flag it answered. Whitespace-collapsed exclusion must catch this variant.
    expect(normalizeVoicelinkWebhook({ event: 'call.completed', callStatus: 'NOANSWER' }).wasAnswered).toBe(false);
    expect(normalizeVoicelinkWebhook({ event: 'call.completed', callStatus: 'NO ANSWER' }).wasAnswered).toBe(false);
    expect(normalizeVoicelinkWebhook({ event: 'call.completed', callStatus: 'ANSWERED' }).wasAnswered).toBe(true);
    expect(normalizeVoicelinkWebhook({ event: 'call.completed', callStatus: 'ANSWER' }).wasAnswered).toBe(true);
  });
});

describe('parseVoicelinkWebhook — flat documented payload no longer misclassified', () => {
  it('classifies a FLAT answered call.completed as hangup (not error) with real id', () => {
    const event = parseVoicelinkWebhook(
      {
        event: 'call.completed',
        callId: '1764828073.53871',
        callStatus: 'ANSWER',
        duration: 8,
        recordingUrl: 'https://example.com/recording.wav',
      },
      'our-call-id',
    );
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe('hangup'); // was 'error' before the fix
    expect(event!.providerCallId).toBe('1764828073.53871'); // was '' before
    expect(event!.metadata.recordingUrl).toBe('https://example.com/recording.wav');
  });

  it('still returns null for call.initiated', () => {
    expect(parseVoicelinkWebhook({ event: 'call.initiated', call: { id: 'x' } }, 'c')).toBeNull();
  });
});

describe('parseVoicelinkWebhook — call.ended is NOT proof of an answer', () => {
  // The branch used to be an unconditional `hangup` on the documented assumption
  // that VoiceLink only emits call.ended for answered calls. Production disproved
  // it (429 call.ended vs 206 call.answered over 24h on dedicated), and because a
  // call.ended payload carries no `callStatus`, the hangup handler found
  // an empty rawCallStatus, matched nothing, and settled `completed` — phantom
  // successes with talk_time_seconds=0. Payloads below are unmodified captures from
  // experiment/captures + the live incident (call effa5952-…).

  it('an UNANSWERED call.ended (no callStatus, null answeredAt) is an error, not a hangup', () => {
    const event = parseVoicelinkWebhook(
      {
        event: 'call.ended',
        call: {
          id: 'carrier-x',
          direction: 'outbound',
          status: 'ended',
          hangupCause: '19 - No answer from user',
          answeredAt: null,
          endedAt: '2026-08-07T10:18:35.000+05:30',
          durationSec: null,
        },
      } as never, // type-only cast: the capture's nulls are wire data the type omits
      'our-call-id',
    );
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe('error'); // was 'hangup' → settled 'completed'
    expect(event!.metadata.wasAnswered).toBe(false);
  });

  it('an ANSWERED call.ended still maps to hangup via answeredAt (it has no callStatus)', () => {
    // Recorded capture: 2026-07-11T06-39-57-498Z (answered, 4s talk time).
    const event = parseVoicelinkWebhook(
      {
        event: 'call.ended',
        call: {
          id: 'fecdd5a7-5d14-415f-9222-a0f99b655cb0',
          direction: 'outbound',
          status: 'ended',
          hangupCause: '16',
          answeredAt: '2026-07-11T12:09:59.000+05:30',
          endedAt: '2026-07-11T12:10:03.847+05:30',
          durationSec: 4,
          sipStatus: '200',
        },
      },
      'our-call-id',
    );
    expect(event!.eventType).toBe('hangup');
    expect(event!.metadata.wasAnswered).toBe(true);
  });

  it('a zero-duration answered call.ended is still answered (durationSec 0 is not "unanswered")', () => {
    // Several captures show answeredAt set with durationSec: 0 — answered then
    // immediately hung up. Must not be confused with never-answered.
    const event = parseVoicelinkWebhook(
      {
        event: 'call.ended',
        call: { id: 'c', status: 'ended', hangupCause: '16', answeredAt: '2026-07-11T13:18:57.000+05:30', durationSec: 0, sipStatus: '200' },
      },
      'our-call-id',
    );
    expect(event!.eventType).toBe('hangup');
  });

  it('an explicit NO ANSWER callStatus outranks a stray answeredAt', () => {
    // callStatus is checked first; answeredAt is only the fallback signal.
    const n = normalizeVoicelinkWebhook({
      event: 'call.completed',
      call: { id: 'c', callStatus: 'NO ANSWER', answeredAt: '2026-08-07T10:18:00.000+05:30' },
    });
    expect(n.wasAnswered).toBe(false);
  });

  it('an empty-string answeredAt is not an answer', () => {
    const n = normalizeVoicelinkWebhook({ event: 'call.ended', call: { id: 'c', status: 'ended', answeredAt: '' } });
    expect(n.wasAnswered).toBe(false);
  });

  it('answeredAt must PARSE as a real instant — junk/placeholder values are not answers', () => {
    // A bare non-empty-string test would mint a phantom answered call from a
    // carrier that JSON-encodes null as the literal "null", or from a zero-value
    // placeholder timestamp. Both are the exact failure this change removes.
    const wasAnswered = (answeredAt: unknown) =>
      normalizeVoicelinkWebhook({ event: 'call.ended', call: { id: 'c', status: 'ended', answeredAt } as never }).wasAnswered;

    expect(wasAnswered('null')).toBe(false);
    expect(wasAnswered('not-a-date')).toBe(false);
    expect(wasAnswered('   ')).toBe(false);
    expect(wasAnswered('1970-01-01T00:00:00.000Z')).toBe(false); // epoch 0 placeholder
    // Non-string types can't be a timestamp either.
    expect(wasAnswered(0)).toBe(false);
    expect(wasAnswered(false)).toBe(false);
    expect(wasAnswered(1786078115000)).toBe(false); // numeric epoch — not the carrier's shape
    // …and a real ISO instant still is one.
    expect(wasAnswered('2026-08-07T10:17:58.000+05:30')).toBe(true);
  });

  it('separator-drift spellings of NO ANSWER do not read as answered', () => {
    // "NO ANSWER" (space) is VoiceLink's spelling; `no-answer` (hyphen) is the
    // VoBiz-shaped one. Mismatched vocabulary is what caused this bug, so the
    // positive match must not be reachable by any separator variant.
    for (const s of ['NO ANSWER', 'NO_ANSWER', 'NO-ANSWER', 'NOANSWER', 'no answer', 'No-Answer']) {
      expect(normalizeVoicelinkWebhook({ event: 'call.completed', callStatus: s }).wasAnswered).toBe(false);
    }
    expect(normalizeVoicelinkWebhook({ event: 'call.completed', callStatus: 'ANSWERED' }).wasAnswered).toBe(true);
  });

  it('KNOWN RISK: an answered call.ended that omits answeredAt classifies unanswered', () => {
    // Documented, deliberate trade-off — not an oversight. With no `callStatus`
    // and no `answeredAt` there is no in-payload evidence of a pickup, so this
    // shape settles as a non-connected failure. All 8 captured `call.ended`
    // payloads carry `answeredAt`, so it is unobserved in production; this test
    // exists so the behaviour is pinned and visible rather than discovered.
    // If it ever starts arriving, the signature in Loki is a `failed`/no-answer
    // disposition alongside sipStatus 200 / hangupCause 16.
    const n = normalizeVoicelinkWebhook({
      event: 'call.ended',
      call: { id: 'c', status: 'ended', hangupCause: '16', sipStatus: '200', durationSec: 30 },
    });
    expect(n.wasAnswered).toBe(false);
  });

  it('the live incident call.failed payload classifies as no_answer', () => {
    // Recorded capture: experiment/captures/2026-07-11T07-18-13-231Z__006__webhook-event.json
    const event = parseVoicelinkWebhook(
      {
        event: 'call.failed',
        call: {
          id: '5fb5ac1a-2218-42d3-8846-f6e106d733a4',
          status: 'failed',
          hangupCause: '38 - Network out of order',
          answeredAt: null,
          callStatus: 'NO ANSWER',
          hangupReason: 'Network out of order',
          sipStatus: '503',
        },
      } as never, // type-only cast: the capture's nulls are wire data the type omits
      'our-call-id',
    );
    expect(event!.eventType).toBe('error');
    const n = normalizeVoicelinkWebhook(event!.metadata as never);
    expect(classifyVoicelinkOutcome(n).status).toBe('no_answer');
  });
});

describe('parseVoicelinkWebhook — terminal events carry the carrier disposition', () => {
  // Unmodified shape of a real unanswered call (2026-08-07). Before the
  // disposition was attached, this settled as failed/TELEPHONY_ERROR — the
  // "NO ANSWER" the carrier reported was buried in a JSON.stringify'd blob.
  const NO_ANSWER_BODY = {
    event: 'call.failed',
    call: {
      id: 'f69611cd-27b6-4896-b76c-99a8a7030032',
      direction: 'outbound',
      from: '919429390268',
      to: '9372533128',
      status: 'failed',
      hangupCause: '19 - User alerting, no answer',
      answeredAt: null,
      callStatus: 'NO ANSWER',
      hangupReason: 'User alerting, no answer',
      sipStatus: '480',
    },
  };

  it('marks an unanswered call.failed as no_answer, not a generic failure', () => {
    const event = parseVoicelinkWebhook(NO_ANSWER_BODY as never, 'our-call-id')!;
    expect(event.eventType).toBe('error');
    expect(event.metadata.dispositionStatus).toBe('no_answer');
    // The carrier's own words reach error_message instead of the raw body.
    expect(event.metadata.dispositionCause).toBe('User alerting, no answer');
    // rawCallStatus — the field the disposition is derived from — is preserved.
    expect(event.metadata.rawCallStatus).toBe('NO ANSWER');
  });

  it('marks an answered call.completed as completed', () => {
    const event = parseVoicelinkWebhook(
      { event: 'call.completed', call: { id: 'c1', callStatus: 'ANSWERED', durationSec: 12 } },
      'our-call-id',
    )!;
    expect(event.eventType).toBe('hangup');
    expect(event.metadata.dispositionStatus).toBe('completed');
  });

  it('treats an ANSWERED call.ended as completed via answeredAt (it carries no callStatus)', () => {
    // A real call.ended payload has status/hangupCause/answeredAt but NO
    // callStatus, so classifying it on callStatus alone would call a normal
    // remote hangup an unanswered failure. `answeredAt` — set here — is what
    // resolves it. Note this is NOT "call.ended implies answered": the
    // unanswered counterpart (no answeredAt) must classify no_answer, which the
    // sibling suite above pins.
    const event = parseVoicelinkWebhook(
      { event: 'call.ended', call: { id: 'c1', status: 'ended', hangupCause: '16', answeredAt: '2026-08-07T10:17:58.000+05:30', durationSec: 30 } },
      'our-call-id',
    )!;
    expect(event.eventType).toBe('hangup');
    expect(event.metadata.dispositionStatus).toBe('completed');
  });

  it('prefers the carrier wording, and falls back to the Q.850-prefixed cause', () => {
    // hangupReason wins when present…
    const withReason = parseVoicelinkWebhook(NO_ANSWER_BODY as never, 'c')!;
    expect(withReason.metadata.dispositionCause).toBe('User alerting, no answer');

    // …and hangupCause (which carries the numeric code) is the next best thing.
    const { hangupReason: _omitted, ...callWithoutReason } = NO_ANSWER_BODY.call;
    const noReason = parseVoicelinkWebhook({ ...NO_ANSWER_BODY, call: callWithoutReason } as never, 'c')!;
    expect(noReason.metadata.dispositionCause).toBe('19 - User alerting, no answer');
  });

  it('omits dispositionCause rather than restating the status as the reason', () => {
    // Only callStatus — no carrier wording anywhere. "NO ANSWER" must NOT become
    // the cause: it restates dispositionStatus, and emitting it would suppress
    // the raw-body fallback, which is strictly more diagnostic.
    const event = parseVoicelinkWebhook(
      { event: 'call.failed', call: { id: 'c1', callStatus: 'NO ANSWER' } },
      'c',
    )!;
    expect(event.metadata.dispositionStatus).toBe('no_answer');
    expect(event.metadata.dispositionCause).toBeUndefined();
    // rawCallStatus still carries it — the status word is preserved, just not
    // laundered into the reason field.
    expect(event.metadata.rawCallStatus).toBe('NO ANSWER');
  });

  it('marks a busy call busy', () => {
    const event = parseVoicelinkWebhook(
      { event: 'call.failed', call: { id: 'c1', callStatus: 'BUSY', sipStatus: '486', hangupReason: 'User Busy' } },
      'our-call-id',
    )!;
    expect(event.metadata.dispositionStatus).toBe('busy');
  });

  it('attaches no disposition to non-terminal events', () => {
    const ringing = parseVoicelinkWebhook({ event: 'call.ringing', call: { id: 'c1' } }, 'c')!;
    expect(ringing.metadata.dispositionStatus).toBeUndefined();
    const answered = parseVoicelinkWebhook({ event: 'call.answered', call: { id: 'c1' } }, 'c')!;
    expect(answered.metadata.dispositionStatus).toBeUndefined();
  });
});

describe('classifyVoicelinkOutcome — specific failure categories', () => {
  // Type-only cast: several cases omit `callStatus`; the runtime value is unchanged.
  const base = { event: 'call.completed', direction: 'outbound' as const, status: '', hangupCause: '', hangupReason: '', sipStatus: '' } as { event: string; direction: 'outbound'; status: string; hangupCause: string; hangupReason: string; sipStatus: string; callStatus: string };

  it('answered → completed', () => {
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', callStatus: 'ANSWERED', wasAnswered: true });
    expect(o.status).toBe('completed');
  });

  it('"NO ANSWER" → no_answer', () => {
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', callStatus: 'NO ANSWER', wasAnswered: false });
    expect(o.status).toBe('no_answer');
  });

  it('SIP 480/408 → no_answer', () => {
    expect(classifyVoicelinkOutcome({ ...base, providerCallId: 'x', callStatus: '', sipStatus: '480', wasAnswered: false }).status).toBe('no_answer');
    expect(classifyVoicelinkOutcome({ ...base, providerCallId: 'x', callStatus: '', sipStatus: '408', wasAnswered: false }).status).toBe('no_answer');
  });

  it('busy (SIP 486) → busy', () => {
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', callStatus: '', sipStatus: '486', wasAnswered: false });
    expect(o.status).toBe('busy');
  });

  it('cancel/reject (SIP 487) → canceled', () => {
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', callStatus: '', sipStatus: '487', wasAnswered: false });
    expect(o.status).toBe('canceled');
  });

  it('unknown cause → failed (raw retained)', () => {
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', callStatus: 'WEIRD', wasAnswered: false });
    expect(o.status).toBe('failed');
    expect(o.rawCause).toContain('weird');
  });

  // ── Full SIP-code table ─────────────────────────────────────────────────────
  it('SIP 486 (busy) → busy regardless of other signals', () => {
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', callStatus: '', sipStatus: '486', wasAnswered: false });
    expect(o.status).toBe('busy');
    expect(o.outcome).toBe('busy');
  });

  it('SIP 487 (request terminated / cancel) → canceled', () => {
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', callStatus: '', sipStatus: '487', wasAnswered: false });
    expect(o.status).toBe('canceled');
    expect(o.outcome).toBe('canceled');
  });

  it('SIP 408 (request timeout) → no_answer', () => {
    expect(classifyVoicelinkOutcome({ ...base, providerCallId: 'x', sipStatus: '408', wasAnswered: false }).status).toBe('no_answer');
  });

  it('SIP 480 (temporarily unavailable) → no_answer', () => {
    expect(classifyVoicelinkOutcome({ ...base, providerCallId: 'x', sipStatus: '480', wasAnswered: false }).status).toBe('no_answer');
  });

  // ── Keyword-driven branches (no SIP code) ────────────────────────────────────
  it('keyword "busy" (in hangupReason) → busy', () => {
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', hangupReason: 'User Busy', wasAnswered: false });
    expect(o.status).toBe('busy');
    expect(o.rawCause).toContain('user busy');
  });

  it('keyword "reject" → canceled', () => {
    expect(classifyVoicelinkOutcome({ ...base, providerCallId: 'x', hangupReason: 'Call Rejected', wasAnswered: false }).status).toBe('canceled');
  });

  it('keyword "declin" (declined) → canceled', () => {
    expect(classifyVoicelinkOutcome({ ...base, providerCallId: 'x', hangupReason: 'Declined by callee', wasAnswered: false }).status).toBe('canceled');
  });

  it('keyword "cancel" → canceled', () => {
    expect(classifyVoicelinkOutcome({ ...base, providerCallId: 'x', status: 'CANCELLED', wasAnswered: false }).status).toBe('canceled');
  });

  it('keyword "no answer" / "no-answer" / "noanswer" → no_answer', () => {
    expect(classifyVoicelinkOutcome({ ...base, providerCallId: 'x', hangupReason: 'no answer', wasAnswered: false }).status).toBe('no_answer');
    expect(classifyVoicelinkOutcome({ ...base, providerCallId: 'x', hangupReason: 'no-answer', wasAnswered: false }).status).toBe('no_answer');
    expect(classifyVoicelinkOutcome({ ...base, providerCallId: 'x', callStatus: 'NOANSWER', wasAnswered: false }).status).toBe('no_answer');
  });

  it('keyword "timeout" → no_answer', () => {
    expect(classifyVoicelinkOutcome({ ...base, providerCallId: 'x', hangupReason: 'ring timeout', wasAnswered: false }).status).toBe('no_answer');
  });

  // ── hangupCause / hangupReason-only inputs (no callStatus / sipStatus) ────────
  it('classifies from hangupCause alone (no callStatus/sipStatus)', () => {
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', hangupCause: 'busy', wasAnswered: false });
    expect(o.status).toBe('busy');
    expect(o.rawCause).toBe('busy');
  });

  it('classifies from hangupReason alone → no_answer, rawCause retained', () => {
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', hangupReason: 'No Answer from callee', wasAnswered: false });
    expect(o.status).toBe('no_answer');
    expect(o.rawCause).toBe('no answer from callee');
  });

  it('an unrecognized hangupCause-only input → failed with the raw cause preserved', () => {
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', hangupCause: '38', wasAnswered: false });
    expect(o.status).toBe('failed');
    expect(o.outcome).toBe('38'); // falls back to rawCause as the outcome
    expect(o.rawCause).toBe('38');
  });

  it('answered wins over a busy signal (an answered call is completed)', () => {
    // Defensive: if a payload somehow carries both answered + a busy code, answered
    // must win (the SIP branches only run when !wasAnswered).
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', callStatus: 'ANSWERED', sipStatus: '486', wasAnswered: true });
    expect(o.status).toBe('completed');
  });

  it('empty everything (no signals) → failed with generic telephony_error outcome', () => {
    const o = classifyVoicelinkOutcome({ ...base, providerCallId: 'x', wasAnswered: false });
    expect(o.status).toBe('failed');
    expect(o.outcome).toBe('telephony_error');
    expect(o.rawCause).toBe('');
  });
});

/**
 * Fixtures below are unmodified staging captures (Loki, 2026-08-07 and 2026-08-08),
 * from two independent trials of manually-labelled calls. They are the evidence
 * for the "clean teardown ⇒ busy" branch and exist to stop it being re-tuned from
 * the Q.850 spec instead of from what VoiceLink actually sends.
 *
 * The measured finding: a DECLINED call and a SWITCHED-OFF handset produce
 * BYTE-IDENTICAL terminal payloads. Across the two trials their ring durations
 * differed by 27ms and 1ms, both pinned at the carrier's ~31s ring ceiling.
 * No field separates them, so both settle `busy` — "reachable, didn't take the
 * call" — until VoiceLink surfaces the upstream Q.850 cause (17/20/21).
 */
describe('classifyVoicelinkOutcome — real VoiceLink captures (labelled by hand)', () => {
  const norm = (call: Record<string, unknown>, event: string) =>
    normalizeVoicelinkWebhook({ event, call } as never);

  it('ANSWERED → completed (hangupCause is a BARE "16" here)', () => {
    // Call 5bd5e79d, 2026-08-08. Settled `completed`, talk time 23s.
    const o = classifyVoicelinkOutcome(norm({
      status: 'ended', hangupCause: '16', sipStatus: '200',
      answeredAt: '2026-08-08T11:10:35.000+05:30', durationSec: 22,
    }, 'call.ended'));
    expect(o.status).toBe('completed');
  });

  // Calls 08dc4647 + 0ba55cd2 (2026-08-08) and ef583256 + 8b6e845e (2026-08-07).
  // These two payloads are transcribed separately and on purpose: in the captures
  // they are byte-identical, which is precisely why both settle `busy`. Keeping
  // them as two literals (rather than asserting one equals the other, which would
  // only prove the normalizer is deterministic) means a future capture that DOES
  // differ gets transcribed here and the divergence becomes visible in the diff.
  const DECLINED_CAPTURE = {
    status: 'ended', hangupCause: '16 - Normal Clearing',
    hangupReason: 'Normal Clearing', sipStatus: '200',
  };
  const SWITCHED_OFF_CAPTURE = {
    status: 'ended', hangupCause: '16 - Normal Clearing',
    hangupReason: 'Normal Clearing', sipStatus: '200',
  };

  it('DECLINED → busy (was `failed` → "Didn\'t connect")', () => {
    const o = classifyVoicelinkOutcome(norm(DECLINED_CAPTURE, 'call.ended'));
    expect(o.status).toBe('busy');
    // Matches what the AI-call path actually persists via
    // `call.busy` → handleCallEnd(…, 'busy', 'not_reached', …).
    expect(o.outcome).toBe('not_reached');
  });

  it('SWITCHED OFF → busy (same disposition; no field separates it from DECLINED)', () => {
    const o = classifyVoicelinkOutcome(norm(SWITCHED_OFF_CAPTURE, 'call.ended'));
    expect(o.status).toBe('busy');
    expect(o.outcome).toBe('not_reached');
  });

  it('UNREACHABLE (no network) → no_answer, via SIP 480 / cause 19', () => {
    // Call c3abdfb8, 2026-08-08. Arrives as call.failed, not call.ended.
    const o = classifyVoicelinkOutcome(norm({
      status: 'failed', callStatus: 'NO ANSWER',
      hangupCause: '19 - User alerting, no answer',
      hangupReason: 'User alerting, no answer', sipStatus: '480',
    }, 'call.failed'));
    expect(o.status).toBe('no_answer');
  });

  it('cause 16 alone never decides — answered vs not is resolved BEFORE it', () => {
    // The load-bearing ordering guard. VoiceLink reuses Q.850 16 for BOTH an
    // answered call hanging up normally and an unanswered one never taken, so a
    // cause-code table consulted before `wasAnswered` would collapse the two.
    const answered = classifyVoicelinkOutcome(norm({
      status: 'ended', hangupCause: '16', sipStatus: '200',
      answeredAt: '2026-08-08T11:10:35.000+05:30',
    }, 'call.ended'));
    const notTaken = classifyVoicelinkOutcome(norm({
      status: 'ended', hangupCause: '16 - Normal Clearing', sipStatus: '200',
    }, 'call.ended'));
    expect(answered.status).toBe('completed');
    expect(notTaken.status).toBe('busy');
  });

  it('the late call.completed for a not-taken call still reads no_answer', () => {
    // ~30s after call.ended, VoiceLink re-sends with callStatus present. That
    // event lands on a destroyed session and is dropped, but if it is ever
    // routed it must not regress to `failed`.
    const o = classifyVoicelinkOutcome(norm({
      status: 'ended', callStatus: 'NO ANSWER',
      hangupCause: '16 - Normal Clearing', hangupReason: '16 - Normal Clearing',
    }, 'call.completed'));
    expect(o.status).toBe('no_answer');
  });

  // ── The branch must stay NARROW: genuine faults are still `failed` ──────────
  it('a genuine fault with cause 16 but a non-200 SIP stays failed', () => {
    const o = classifyVoicelinkOutcome(norm({
      status: 'ended', hangupCause: '16 - Normal Clearing', sipStatus: '503',
    }, 'call.ended'));
    expect(o.status).toBe('failed');
  });

  it('an unrecognized cause on SIP 200 stays failed (we cannot say what happened)', () => {
    const o = classifyVoicelinkOutcome(norm({
      status: 'ended', hangupCause: '99 - Something New', sipStatus: '200',
    }, 'call.ended'));
    expect(o.status).toBe('failed');
  });

  it('cause "116" does not match cause 16 (token boundary, not substring)', () => {
    const o = classifyVoicelinkOutcome(norm({
      status: 'ended', hangupCause: '116 - Bogus', sipStatus: '200',
    }, 'call.ended'));
    expect(o.status).toBe('failed');
  });

  it('a fault cause with "Normal Clearing" in hangupReason stays failed', () => {
    // Regression guard. An earlier draft tested the pipe-joined `rawCause` blob,
    // so "normal clearing" appearing in ANY of the four joined fields flipped the
    // call to `busy` — relabelling genuine faults as "the callee didn't take the
    // call" whenever a carrier desynced hangupCause from hangupReason. The match
    // is against `hangupCause` alone; these must remain `failed`.
    for (const hangupCause of [
      '34 - No circuit available',
      '38 - Network out of order',
      '28 - Invalid number format',
    ]) {
      const o = classifyVoicelinkOutcome(norm({
        status: 'ended', hangupCause, hangupReason: 'Normal Clearing', sipStatus: '200',
      }, 'call.ended'));
      expect(o.status, `${hangupCause} must stay failed`).toBe('failed');
    }
  });

  it('a stray 16 embedded elsewhere in hangupCause does not match (anchored)', () => {
    // The match anchors at the leading Q.850 code. A token-boundary regex would
    // have accepted all of these.
    for (const hangupCause of ['1-16', 'cause=16;text=x', 'ANSWERED-16', 'a16b']) {
      const o = classifyVoicelinkOutcome(norm({
        status: 'ended', hangupCause, sipStatus: '200',
      }, 'call.ended'));
      expect(o.status, `${hangupCause} must not match cause 16`).toBe('failed');
    }
  });

  it('network/format faults are unaffected by the new branch', () => {
    expect(classifyVoicelinkOutcome(norm({
      status: 'failed', hangupCause: '38 - Network out of order',
      hangupReason: 'Network out of order', sipStatus: '503',
    }, 'call.failed')).status).toBe('failed');
    expect(classifyVoicelinkOutcome(norm({
      status: 'failed', hangupCause: '28 - Invalid number format',
      hangupReason: 'Invalid number format', sipStatus: '484',
    }, 'call.failed')).status).toBe('failed');
  });

  it('end-to-end: parseVoicelinkWebhook attaches dispositionStatus=busy', () => {
    // The classifier is only half the path — the disposition has to survive into
    // the event metadata for the carrier-disposition emitter to route it.
    const ev = parseVoicelinkWebhook({
      event: 'call.ended',
      call: { id: 'vl-1', ...DECLINED_CAPTURE },
    } as never, 'call-1')!;
    expect(ev.eventType).toBe('error'); // unanswered ⇒ error arm, not hangup
    expect(ev.metadata.dispositionStatus).toBe('busy');
    // The carrier's own wording rides along; it only ever reaches error_message.
    expect(ev.metadata.dispositionCause).toBe('Normal Clearing');
    expect(ev.metadata.wasAnswered).toBe(false);
  });

  it('end-to-end: an answered call still routes hangup/completed', () => {
    const ev = parseVoicelinkWebhook({
      event: 'call.ended',
      call: {
        id: 'vl-2', status: 'ended', hangupCause: '16', sipStatus: '200',
        answeredAt: '2026-08-08T11:10:35.000+05:30', durationSec: 22,
      },
    } as never, 'call-2')!;
    expect(ev.eventType).toBe('hangup');
    expect(ev.metadata.dispositionStatus).toBe('completed');
    expect(ev.metadata.wasAnswered).toBe(true);
  });

  it('a real Q.850 17 still classifies busy through the existing text branch', () => {
    // If VoiceLink ever starts sending the real cause, the pre-existing branch
    // handles it and the clean-teardown fallback is never reached.
    const o = classifyVoicelinkOutcome(norm({
      status: 'ended', hangupCause: '17 - User busy',
      hangupReason: 'User busy', sipStatus: '486',
    }, 'call.ended'));
    expect(o.status).toBe('busy');
    expect(o.outcome).toBe('busy'); // NOT 'not_taken' — a real busy is known, not inferred
  });
});

/**
 * Exhaustive coverage of the clean-teardown ⇒ `busy` branch and the normalizer's
 * string coercion.
 *
 * Every payload below is an unmodified staging capture, from two independent trials
 * of manually-placed calls whose real disposition was recorded by hand at dial
 * time (2026-08-07 and 2026-08-08, via the temporary raw-body diagnostic in
 * `webhooks.routes.ts`). The hand-label is in each test name — that is the
 * ground truth these assertions encode, and the reason the fixtures must not be
 * "tidied" into synthetic-looking values.
 *
 * Carrier behaviours that are easy to get wrong on a re-read, all load-bearing:
 *   - Q.850 cause 16 rides on BOTH answered (bare "16") and unanswered
 *     ("16 - Normal Clearing") calls, so the cause alone can never decide.
 *   - `call.ended` carries NO `callStatus`; only the late `call.completed` does.
 *   - `hangupReason` reformats between events ("Normal Clearing" on call.ended,
 *     "16 - Normal Clearing" on call.completed) — same field, same call.
 *   - `sipStatus` appears on call.ended/call.failed but NOT on call.completed.
 *
 * Never observed from VoiceLink, so do not write tests asserting the carrier
 * emits them: Q.850 17 (user busy), 20 (subscriber absent), 21 (call rejected).
 * Those are what would separate declined from switched-off for real; the carrier
 * has been asked. If they appear, REPLACE this inference rather than extend it.
 *
 * Every expectation below was measured against the implementation and written as
 * a literal — deliberately NOT re-derived from the source's own regex/logic,
 * which would make the test agree with any behaviour including a wrong one.
 */
describe('classifyVoicelinkOutcome — clean-teardown branch, exhaustive', () => {
  const cls = (call: Record<string, unknown>, event = 'call.ended') =>
    classifyVoicelinkOutcome(normalizeVoicelinkWebhook({ event, call } as never));

  // ── The `sip === '200'` conjunct ───────────────────────────────────────────
  // Cause 16 alone must never be enough. Each non-200 status either routes to
  // its own branch or falls through to `failed`; none may reach clean-teardown.
  describe('requires sipStatus exactly "200"', () => {
    const cause = '16 - Normal Clearing';
    it.each([
      ['200', 'busy'],       // the observed signature
      ['', 'failed'],        // absent — cannot confirm a clean teardown
      ['503', 'failed'],     // service unavailable — a real fault
      ['404', 'failed'],     // not found — a real fault
      ['200 OK', 'failed'],  // string equality, not a prefix/substring test
    ])('sipStatus %j → %s', (sipStatus, expected) => {
      expect(cls({ status: 'ended', hangupCause: cause, sipStatus }).status).toBe(expected);
    });

    // These carry their own meaning and are matched by EARLIER branches, so the
    // clean-teardown arm is never consulted even though cause 16 is present.
    it.each([
      ['486', 'busy'],       // busy branch (same status, different provenance)
      ['487', 'canceled'],
      ['480', 'no_answer'],
      ['408', 'no_answer'],
    ])('sipStatus %j is claimed by an earlier branch → %s', (sipStatus, expected) => {
      expect(cls({ status: 'ended', hangupCause: cause, sipStatus }).status).toBe(expected);
    });

    it('sipStatus "487" yields canceled, proving it did NOT fall to clean-teardown', () => {
      // Distinguishes "earlier branch won" from "both produce busy by accident".
      const o = cls({ status: 'ended', hangupCause: '16 - Normal Clearing', sipStatus: '487' });
      expect(o.status).toBe('canceled');
      expect(o.outcome).toBe('canceled');
    });
  });

  // ── Leading-code anchoring ─────────────────────────────────────────────────
  describe('anchors on the leading Q.850 code', () => {
    it.each([
      '16',                    // answered-call spelling (bare)
      '16 - Normal Clearing',  // unanswered spelling
      ' 16',                   // leading space tolerated by ^\s*
      '  16 - x',
      '16 ',                   // trailing space
    ])('matches %j', (hangupCause) => {
      expect(cls({ status: 'ended', hangupCause, sipStatus: '200' }).status).toBe('busy');
    });

    it.each([
      '116',               // 16 is not the leading code
      '160',
      '016',
      '1216',
      '1-16',
      'a16b',
      'cause=16;text=x',   // embedded — a token-boundary regex would have matched
      'ANSWERED-16',
      'x 16',              // ^\s* allows only whitespace before the digits
      '',                  // no cause at all
    ])('does NOT match %j', (hangupCause) => {
      expect(cls({ status: 'ended', hangupCause, sipStatus: '200' }).status).toBe('failed');
    });

    it('KNOWN LOOSENESS: a decimal/punctuated code like "16.5" DOES match', () => {
      // `\b` sits between `6` and `.`, so `/^\s*16\b/` accepts "16.5", "16,5",
      // "16-". Asserted as the real behaviour rather than the desired one.
      //
      // Not tightened to `/^\s*16(\s|$|\s*-)/` because VoiceLink has only ever
      // been observed sending "16" and "16 - Normal Clearing", so a stricter
      // pattern would be tuned against payloads that don't exist —
      // the exact mistake that produced the original `call.ended` bug. If a
      // capture ever shows a punctuated cause, tighten it and flip these.
      expect(cls({ status: 'ended', hangupCause: '16.5', sipStatus: '200' }).status).toBe('busy');
      expect(cls({ status: 'ended', hangupCause: '16,5', sipStatus: '200' }).status).toBe('busy');
      expect(cls({ status: 'ended', hangupCause: '16-', sipStatus: '200' }).status).toBe('busy');
    });
  });

  // ── Branch precedence ──────────────────────────────────────────────────────
  // With the full clean-teardown signature present, every earlier branch must
  // still win. This is what keeps cause 16 from becoming a standalone mapping.
  describe('is unreachable when an earlier branch matches', () => {
    const teardown = { status: 'ended', hangupCause: '16 - Normal Clearing', sipStatus: '200' };

    it('wasAnswered wins → completed (the load-bearing ordering guard)', () => {
      const o = cls({ ...teardown, answeredAt: '2026-08-08T11:10:35.000+05:30' });
      expect(o.status).toBe('completed');
      expect(o.outcome).toBe('remote_hangup');
    });

    it('a "no answer" text wins → no_answer', () => {
      expect(cls({ ...teardown, callStatus: 'NO ANSWER' }).status).toBe('no_answer');
    });

    it('a "busy" text wins → busy with outcome "busy", not "not_reached"', () => {
      // Same status, different provenance: a carrier-reported busy is known,
      // the clean-teardown one is inferred. The outcome is what separates them.
      const o = cls({ ...teardown, hangupReason: 'User busy' });
      expect(o.status).toBe('busy');
      expect(o.outcome).toBe('busy');
    });

    it.each(['Call Rejected', 'Declined by callee', 'Cancelled by originator'])(
      'a cancel/reject/decline text (%s) wins → canceled',
      (hangupReason) => {
        expect(cls({ ...teardown, hangupReason }).status).toBe('canceled');
      },
    );
  });

  // ── Scoping: hangupCause ONLY, never the joined rawCause blob ──────────────
  // Regression guard. An earlier draft tested `rawCause`, so "normal clearing"
  // in ANY of its four source fields relabelled a genuine fault as `busy`.
  describe('matches hangupCause alone, not the joined rawCause', () => {
    it.each([
      '34 - No circuit available',
      '38 - Network out of order',
      '28 - Invalid number format',
      '27 - Destination out of order',
    ])('fault cause %s + hangupReason "Normal Clearing" stays failed', (hangupCause) => {
      expect(cls({ status: 'ended', hangupCause, hangupReason: 'Normal Clearing', sipStatus: '200' }).status)
        .toBe('failed');
    });

    it('"Normal Clearing" in `status` does not flip a fault cause', () => {
      const o = cls({ status: 'Normal Clearing', hangupCause: '34 - No circuit available', sipStatus: '200' });
      expect(o.status).toBe('failed');
      // It DOES reach rawCause (which is diagnostic-only) — proving the field is
      // present and simply not consulted by the branch.
      expect(o.rawCause).toBe('normal clearing|34 - no circuit available');
    });

    it('"NORMAL CLEARING" in `callStatus` does not flip a fault cause', () => {
      const o = cls({
        status: 'ended', callStatus: 'NORMAL CLEARING',
        hangupCause: '34 - No circuit available', sipStatus: '200',
      });
      expect(o.status).toBe('failed');
      expect(o.rawCause).toBe('normal clearing|ended|34 - no circuit available');
    });
  });

  // ── Result shape ───────────────────────────────────────────────────────────
  it('returns outcome "not_reached" (matching what the AI path persists)', () => {
    // An earlier draft used 'not_taken', which is discarded on the AI and static
    // paths — `call.busy` → handleCallEnd(…, 'busy', 'not_reached', …).
    const o = cls({
      status: 'ended', hangupCause: '16 - Normal Clearing',
      hangupReason: 'Normal Clearing', sipStatus: '200',
    });
    expect(o).toEqual({
      status: 'busy',
      outcome: 'not_reached',
      rawCause: 'ended|normal clearing|16 - normal clearing',
    });
  });
});

describe('normalizeVoicelinkWebhook — hangupCause/sipStatus coercion', () => {
  const cls = (call: Record<string, unknown>, event = 'call.ended') =>
    classifyVoicelinkOutcome(normalizeVoicelinkWebhook({ event, call } as never));

  it('a numerically-encoded payload still classifies busy (nested shape)', () => {
    // Without String() coercion, `sip === '200'` is false for the number 200 and
    // the branch silently never fires — reverting to "Didn't connect" with no error.
    expect(cls({ status: 'ended', hangupCause: 16, sipStatus: 200 }).status).toBe('busy');
  });

  it('a numerically-encoded payload still classifies busy (flat shape)', () => {
    const n = normalizeVoicelinkWebhook({ event: 'call.ended', hangupCause: 16, sipStatus: 200 } as never);
    expect(n.hangupCause).toBe('16');
    expect(n.sipStatus).toBe('200');
    expect(classifyVoicelinkOutcome(n).status).toBe('busy');
  });

  it.each([
    ['486', 'busy'],
    ['487', 'canceled'],
    ['480', 'no_answer'],
    ['408', 'no_answer'],
  ])('coercion did not break the pre-existing numeric SIP %s branch → %s', (sip, expected) => {
    expect(cls({ status: 'ended', sipStatus: Number(sip) }).status).toBe(expected);
  });

  it('falsy 0 normalizes to "0"/"" and never fakes a match', () => {
    // `String(0) || ''` is '0' (truthy string), so sipStatus:0 becomes "0" — not
    // "200", so no match. hangupCause:0 becomes "0" — not a leading 16.
    const zeroSip = normalizeVoicelinkWebhook({
      event: 'call.ended', call: { status: 'ended', hangupCause: '16', sipStatus: 0 },
    } as never);
    expect(zeroSip.sipStatus).toBe('0');
    expect(classifyVoicelinkOutcome(zeroSip).status).toBe('failed');

    const zeroCause = normalizeVoicelinkWebhook({
      event: 'call.ended', call: { status: 'ended', hangupCause: 0, sipStatus: '200' },
    } as never);
    expect(zeroCause.hangupCause).toBe('0');
    expect(classifyVoicelinkOutcome(zeroCause).status).toBe('failed');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('%s normalizes to an empty string, not the literal text', (_label, value) => {
    // Guards the `?? ''` — String(null) would be "null", which could regex-match
    // or leak into rawCause as a phantom cause.
    const n = normalizeVoicelinkWebhook({
      event: 'call.ended', call: { status: 'ended', hangupCause: value, sipStatus: value },
    } as never);
    expect(n.hangupCause).toBe('');
    expect(n.sipStatus).toBe('');
    expect(classifyVoicelinkOutcome(n).status).toBe('failed');
  });

  it('nested call.* wins over the flat top-level field', () => {
    const n = normalizeVoicelinkWebhook({
      event: 'call.ended',
      call: { status: 'ended', hangupCause: '16 - Normal Clearing', sipStatus: '200' },
      hangupCause: '38 - Network out of order', sipStatus: '503',
    } as never);
    expect(n.hangupCause).toBe('16 - Normal Clearing');
    expect(n.sipStatus).toBe('200');
    expect(classifyVoicelinkOutcome(n).status).toBe('busy');
  });

  it('an empty/absent payload degrades to empty strings, never throws', () => {
    expect(normalizeVoicelinkWebhook({} as never).hangupCause).toBe('');
    const n = normalizeVoicelinkWebhook({ event: 'call.ended' } as never);
    expect(n.sipStatus).toBe('');
    expect(classifyVoicelinkOutcome(n)).toEqual({
      status: 'failed', outcome: 'telephony_error', rawCause: '',
    });
  });
});

describe('parseVoicelinkWebhook — the four labelled captures, end to end', () => {
  // Unmodified staging captures. The classifier is only half the path — the
  // disposition must survive into metadata for the call handler to route it.
  const ANSWERED = {
    status: 'ended', hangupCause: '16', sipStatus: '200',
    answeredAt: '2026-08-08T11:10:35.000+05:30', durationSec: 22,
  };
  const DECLINED = {
    status: 'ended', hangupCause: '16 - Normal Clearing',
    hangupReason: 'Normal Clearing', sipStatus: '200',
  };
  const SWITCHED_OFF = {
    status: 'ended', hangupCause: '16 - Normal Clearing',
    hangupReason: 'Normal Clearing', sipStatus: '200',
  };
  const UNREACHABLE = {
    status: 'failed', callStatus: 'NO ANSWER',
    hangupCause: '19 - User alerting, no answer',
    hangupReason: 'User alerting, no answer', sipStatus: '480',
  };

  it('ANSWERED → hangup + dispositionStatus=completed', () => {
    const ev = parseVoicelinkWebhook({ event: 'call.ended', call: { id: 'v1', ...ANSWERED } } as never, 'c1')!;
    expect(ev.eventType).toBe('hangup');
    expect(ev.metadata.dispositionStatus).toBe('completed');
    expect(ev.metadata.wasAnswered).toBe(true);
    expect(ev.providerCallId).toBe('v1');
  });

  it('DECLINED → error + dispositionStatus=busy, carrier wording preserved', () => {
    const ev = parseVoicelinkWebhook({ event: 'call.ended', call: { id: 'v2', ...DECLINED } } as never, 'c2')!;
    expect(ev.eventType).toBe('error');
    expect(ev.metadata.dispositionStatus).toBe('busy');
    expect(ev.metadata.dispositionCause).toBe('Normal Clearing');
    expect(ev.metadata.wasAnswered).toBe(false);
  });

  it('SWITCHED OFF → error + dispositionStatus=busy (same disposition as DECLINED)', () => {
    const ev = parseVoicelinkWebhook({ event: 'call.ended', call: { id: 'v3', ...SWITCHED_OFF } } as never, 'c3')!;
    expect(ev.eventType).toBe('error');
    expect(ev.metadata.dispositionStatus).toBe('busy');
    expect(ev.metadata.wasAnswered).toBe(false);
  });

  it('UNREACHABLE → error + dispositionStatus=no_answer', () => {
    const ev = parseVoicelinkWebhook({ event: 'call.failed', call: { id: 'v4', ...UNREACHABLE } } as never, 'c4')!;
    expect(ev.eventType).toBe('error');
    expect(ev.metadata.dispositionStatus).toBe('no_answer');
    expect(ev.metadata.dispositionCause).toBe('User alerting, no answer');
  });

  it.each(['call.ringing', 'call.answered'])('non-terminal %s carries no disposition', (event) => {
    const ev = parseVoicelinkWebhook({ event, call: { id: 'v5', ...DECLINED } } as never, 'c5')!;
    expect(ev.metadata.dispositionStatus).toBeUndefined();
  });

  it('call.initiated is informational and returns null', () => {
    expect(parseVoicelinkWebhook({ event: 'call.initiated', call: { id: 'v6' } } as never, 'c6')).toBeNull();
  });

  it('the LATE call.completed classifies no_answer, not busy — and that is expected', () => {
    // ~30s after call.ended VoiceLink re-sends WITH callStatus, which routes to
    // the no_answer branch before clean-teardown is reached. In production this
    // lands on a destroyed session and is dropped, so the settling event's `busy`
    // stands. Pinned so the divergence is deliberate rather than discovered.
    const ev = parseVoicelinkWebhook({
      event: 'call.completed',
      call: {
        id: 'v7', status: 'ended', callStatus: 'NO ANSWER',
        hangupCause: '16 - Normal Clearing', hangupReason: '16 - Normal Clearing',
      },
    } as never, 'c7')!;
    expect(ev.eventType).toBe('error');
    expect(ev.metadata.dispositionStatus).toBe('no_answer');
  });

  it('the LATE call.completed for an ANSWERED call still reads completed', () => {
    const ev = parseVoicelinkWebhook({
      event: 'call.completed',
      call: {
        id: 'v8', status: 'ended', callStatus: 'ANSWERED', hangupCause: '16',
        hangupReason: '16', answeredAt: '2026-08-08T11:10:35.000+05:30', durationSec: 22,
      },
    } as never, 'c8')!;
    expect(ev.eventType).toBe('hangup');
    expect(ev.metadata.dispositionStatus).toBe('completed');
  });
});

describe('normalizeVoicelinkWebhook — wasAnswered via the answeredAt fallback', () => {
  // The discriminator for `call.ended`, which carries no callStatus. It must
  // parse as a real instant — a non-empty string is not enough, or a carrier
  // JSON-encoding null as "null" would mint a phantom answered call.
  const answeredWith = (answeredAt: unknown) =>
    normalizeVoicelinkWebhook({
      event: 'call.ended',
      call: { status: 'ended', hangupCause: '16 - Normal Clearing', sipStatus: '200', answeredAt },
    } as never).wasAnswered;

  it('a valid ISO timestamp answers', () => {
    expect(answeredWith('2026-08-08T11:10:35.000+05:30')).toBe(true);
  });

  it.each([
    ['epoch 0', '1970-01-01T00:00:00.000Z'],  // zero-value placeholder, never a real pickup
    ['the literal string "null"', 'null'],
    ['unparseable garbage', 'not-a-date'],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('%s does NOT answer', (_label, value) => {
    expect(answeredWith(value)).toBe(false);
  });

  it('an unanswered call.ended therefore reaches the clean-teardown branch', () => {
    // Ties the fallback to the outcome: a phantom `answeredAt` would return
    // `completed` here and silently mint a connected call.
    const n = normalizeVoicelinkWebhook({
      event: 'call.ended',
      call: { status: 'ended', hangupCause: '16 - Normal Clearing', sipStatus: '200', answeredAt: 'null' },
    } as never);
    expect(n.wasAnswered).toBe(false);
    expect(classifyVoicelinkOutcome(n).status).toBe('busy');
  });
});

describe('extractVoicelinkRecordingUrl', () => {
  it('finds nested and flat recording URLs', () => {
    expect(extractVoicelinkRecordingUrl({ call: { recordingUrl: 'n' } })).toBe('n');
    expect(extractVoicelinkRecordingUrl({ recordingUrl: 'f' })).toBe('f');
    expect(extractVoicelinkRecordingUrl({})).toBeUndefined();
  });
});
