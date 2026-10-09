import { describe, it, expect } from 'vitest';
import {
  AGENCY_MEDIA_FRAME_SAMPLES,
  AGENCY_MEDIA_SAMPLE_RATE,
  MAX_AGENCY_MEDIA_PAYLOAD_CHARS,
  encodeAgencyMediaFrame,
  readAgencyMediaPayload,
} from '../../utils/agencyMedia';

/**
 * The **wire format**, pinned against the API rather than against our own intent.
 *
 * Every constant and every shape below was read out of
 * the server's WebRTC bridge manager and is repeated here as a
 * literal on purpose. Asserting `encodeAgencyMediaFrame` against
 * `JSON.stringify({event:'media', ...})` would be the function testing itself;
 * asserting it against the literal string the API's `JSON.parse` has to accept is
 * the only version that catches a rename.
 *
 * The bug this file exists to make impossible: the console produced no audio at
 * all, so there was never a moment where a *wrong* format was visible. The first
 * format we ship is the one nobody can compare against a working baseline.
 */

describe('the agency station audio wire format', () => {
  it('produces exactly the envelope the API reads', () => {
    // `webrtc-bridge-manager.ts:1083` — `data.event === 'media' && typeof
    // data.media?.payload === 'string'`. Nothing else is inspected, and nothing
    // else may be required.
    expect(encodeAgencyMediaFrame('AAEC')).toBe('{"event":"media","media":{"payload":"AAEC"}}');
  });

  it('names 16 kHz, because both carriers are normalised to it before this socket', () => {
    // VoiceLink A-law 8k is transcoded up (`:1152-1154`), VoBiz L16 16k passes
    // through (`:1157`). The console never sees the carrier.
    expect(AGENCY_MEDIA_SAMPLE_RATE).toBe(16000);
  });

  it('frames at 20ms, matching the worklet the AI-call path already ships', () => {
    // 320 samples at 16 kHz. Stated as a relationship rather than as `320` so a
    // change to either number has to be a deliberate change to both.
    expect(AGENCY_MEDIA_FRAME_SAMPLES / AGENCY_MEDIA_SAMPLE_RATE).toBeCloseTo(0.02, 5);
  });

  describe('the frame ceiling is the API’s, not a guess', () => {
    /**
     * **This is NOT a check against the server's constant.** Nothing here imports
     * it, and a test that read `webrtc-bridge-manager.ts` off disk would couple
     * this console's unit suite to the server's source layout.
     *
     * An earlier version asserted `MAX_AGENCY_MEDIA_PAYLOAD_CHARS === 64000 * 2`
     * — our literal against our other literal, arranged to look like a
     * derivation from the API's constant. It could not fail for any reason worth
     * knowing about: if the API tightened its bound to the arithmetically correct
     * `ceil(64000/3)*4 = 85336`, every frame between 85337 and 128000 would
     * start vanishing into the API's silent drop with this test still green.
     *
     * So the assertions below pin the two things that are actually ours to
     * defend — the guard's boundary behaviour, and that real traffic is nowhere
     * near it — and the agreement with the server's constant is named as a manual obligation in
     * `agencyMedia.ts` rather than pretended at here.
     */
    it('is the transcribed value, re-checked by hand against the API', () => {
      expect(MAX_AGENCY_MEDIA_PAYLOAD_CHARS).toBe(128000);
    });

    it('is comfortably above base64’s true 4/3 expansion of the API’s byte limit', () => {
      // The property that makes the transcription safe *today*: whatever the API
      // meant by `* 2`, 128000 is not below the honest encoded bound, so we
      // never reject a frame the API would have accepted.
      const honestEncodedBound = Math.ceil(64000 / 3) * 4;
      expect(honestEncodedBound).toBe(85336);
      expect(MAX_AGENCY_MEDIA_PAYLOAD_CHARS).toBeGreaterThanOrEqual(honestEncodedBound);
    });

    it('refuses a payload the API would silently drop', () => {
      // The API logs and returns. A frame we hand it over the ceiling is audio that
      // vanishes downstream with nothing on this side to show for it.
      expect(encodeAgencyMediaFrame('a'.repeat(MAX_AGENCY_MEDIA_PAYLOAD_CHARS + 1))).toBeNull();
      // And the boundary itself is accepted, so the guard is `>` and not `>=`.
      expect(encodeAgencyMediaFrame('a'.repeat(MAX_AGENCY_MEDIA_PAYLOAD_CHARS))).not.toBeNull();
    });

    it('refuses an empty payload', () => {
      expect(encodeAgencyMediaFrame('')).toBeNull();
    });

    it('is unreachable by real traffic — it guards a broken graph, not a busy one', () => {
      // 320 samples × 2 bytes → 640 bytes → 856 base64 characters: 0.7% of the
      // ceiling. Stated plainly because the opposite reading — that this bound
      // protects a live call from itself — would make it look load-bearing when
      // it is a tripwire for a capture graph that has already gone wrong.
      const bytes = AGENCY_MEDIA_FRAME_SAMPLES * 2;
      const base64Chars = Math.ceil(bytes / 3) * 4;
      expect(base64Chars).toBe(856);
      expect(base64Chars).toBeLessThan(MAX_AGENCY_MEDIA_PAYLOAD_CHARS / 100);
    });
  });

  describe('reading the API’s downlink frame', () => {
    it('accepts the frame the API actually writes', () => {
      // `:1154` / `:1157` — identical envelope in both carrier branches.
      expect(readAgencyMediaPayload({ event: 'media', media: { payload: 'QUJD' } })).toBe('QUJD');
    });

    it.each([
      ['a bridge status frame', { event: 'status', status: 'answered' }],
      ['a bridge ended frame', { event: 'ended', reason: 'remote_hangup' }],
      ['an agency control frame', { event: 'bridged', attempt_id: 'att-1' }],
    ])('returns null for %s', (_label, frame) => {
      expect(readAgencyMediaPayload(frame)).toBeNull();
    });

    it.each([
      ['no media body', { event: 'media' }],
      ['a null body', { event: 'media', media: null }],
      ['a non-string payload', { event: 'media', media: { payload: 42 } }],
      ['an empty payload', { event: 'media', media: { payload: '' } }],
      ['not an object at all', 'media'],
      ['null', null],
    ])('returns null rather than throwing for %s', (_label, frame) => {
      // This runs inside the station socket's `onmessage`. A throw here would
      // take the agent's whole session down over one malformed audio frame.
      expect(() => readAgencyMediaPayload(frame)).not.toThrow();
      expect(readAgencyMediaPayload(frame)).toBeNull();
    });
  });
});
