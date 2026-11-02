import { describe, it, expect } from 'vitest';
import {
  AGENCY_MEDIA_FRAME_SAMPLES,
  AGENCY_MEDIA_SAMPLE_RATE,
  MAX_AGENCY_MEDIA_PAYLOAD_CHARS,
  encodeAgencyMediaFrame,
  isPlayableAlawMessage,
  isSendableAlawMessage,
  readAgencyMediaPayload,
  uplinkFrameFormat,
  withStationMediaQuery,
} from '../../utils/agencyMedia';
import { AGENCY_WS_MAX_MESSAGE_BYTES } from '@magick-agency/contracts/agency';

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
     * The server's bound is the wire contract's `AGENCY_WS_MAX_MESSAGE_BYTES` (the
     * server's `WS_MAX_PAYLOAD_DEFAULT_BYTES` is that constant), so both sides read one
     * number; these assertions pin the arithmetic and the guard's boundary behaviour.
     */
    it('is the server’s 64 KiB message bound less the JSON envelope', () => {
      const envelope = JSON.stringify({ event: 'media', media: { payload: '' } }).length;
      expect(envelope).toBe(40);
      expect(AGENCY_WS_MAX_MESSAGE_BYTES).toBe(64 * 1024);
      expect(MAX_AGENCY_MEDIA_PAYLOAD_CHARS).toBe(AGENCY_WS_MAX_MESSAGE_BYTES - envelope);
      expect(MAX_AGENCY_MEDIA_PAYLOAD_CHARS).toBe(65_496);
    });

    it('keeps the largest frame it accepts inside the server’s message bound', () => {
      const frame = encodeAgencyMediaFrame('a'.repeat(MAX_AGENCY_MEDIA_PAYLOAD_CHARS));
      expect(frame).not.toBeNull();
      expect(new TextEncoder().encode(frame!).length).toBe(AGENCY_WS_MAX_MESSAGE_BYTES);
    });

    it('refuses a payload the server would close the station for', () => {
      // Over the bound the server's WebSocket closes with 1009, taking the station
      // down; a frame refused here is counted instead.
      expect(encodeAgencyMediaFrame('a'.repeat(MAX_AGENCY_MEDIA_PAYLOAD_CHARS + 1))).toBeNull();
      // And the boundary itself is accepted, so the guard is `>` and not `>=`.
      expect(encodeAgencyMediaFrame('a'.repeat(MAX_AGENCY_MEDIA_PAYLOAD_CHARS))).not.toBeNull();
    });

    it('refuses an empty payload', () => {
      expect(encodeAgencyMediaFrame('')).toBeNull();
    });

    it('is unreachable by real traffic — it guards a broken graph, not a busy one', () => {
      // 320 samples × 2 bytes → 640 bytes → 856 base64 characters: 1.3% of the
      // ceiling. Stated plainly because the opposite reading — that this bound
      // protects a live call from itself — would make it look load-bearing when
      // it is a tripwire for a capture graph that has already gone wrong.
      const bytes = AGENCY_MEDIA_FRAME_SAMPLES * 2;
      const base64Chars = Math.ceil(bytes / 3) * 4;
      expect(base64Chars).toBe(856);
      expect(base64Chars).toBeLessThan(MAX_AGENCY_MEDIA_PAYLOAD_CHARS / 50);
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

describe('media=alaw8', () => {
  describe('withStationMediaQuery: the upgrade names the socket format', () => {
    it('appends after the token, leaving the token byte for byte as minted', () => {
      const token = 'a+b/c=d%2Be';
      expect(withStationMediaQuery(`/proxy/agency/station/s1?token=${token}`, 'alaw8')).toBe(
        `/proxy/agency/station/s1?token=${token}&media=alaw8`,
      );
    });

    it('names pcm16 explicitly too', () => {
      expect(withStationMediaQuery('/proxy/agency/station/s1?token=t', 'pcm16')).toBe(
        '/proxy/agency/station/s1?token=t&media=pcm16',
      );
    });

    it('starts a query when there is none, and keeps a fragment last', () => {
      expect(withStationMediaQuery('/proxy/agency/station/s1', 'alaw8')).toBe('/proxy/agency/station/s1?media=alaw8');
      expect(withStationMediaQuery('/s?token=t#x', 'alaw8')).toBe('/s?token=t&media=alaw8#x');
    });

    it('replaces a media parameter already there: the server refuses a repeated one', () => {
      expect(withStationMediaQuery('/s?media=pcm16&token=t&media=x', 'alaw8')).toBe('/s?token=t&media=alaw8');
      expect(withStationMediaQuery('/s?media&token=t', 'alaw8')).toBe('/s?token=t&media=alaw8');
    });

    it('leaves look-alike parameters alone', () => {
      expect(withStationMediaQuery('/s?token=t&mediax=1', 'alaw8')).toBe('/s?token=t&mediax=1&media=alaw8');
    });

    it('works on an absolute ws(s) URL', () => {
      expect(withStationMediaQuery('wss://api.example/proxy/agency/station/s1?token=t', 'alaw8')).toBe(
        'wss://api.example/proxy/agency/station/s1?token=t&media=alaw8',
      );
    });
  });

  it('a frame says which socket format it belongs to by its type', () => {
    expect(uplinkFrameFormat('QUJD')).toBe('pcm16');
    expect(uplinkFrameFormat(new ArrayBuffer(160))).toBe('alaw8');
  });

  it('uplink: a non-zero whole number of 160-byte frames, at most one second (the server’s rule)', () => {
    for (const ok of [160, 320, 7840, 8000]) expect(isSendableAlawMessage(ok), `${ok}`).toBe(true);
    for (const bad of [0, 1, 159, 161, 640 + 1, 8160, 16000]) expect(isSendableAlawMessage(bad), `${bad}`).toBe(false);
  });

  it('downlink: anything from one byte to one second is played', () => {
    for (const ok of [1, 160, 8000]) expect(isPlayableAlawMessage(ok), `${ok}`).toBe(true);
    for (const bad of [0, 8001]) expect(isPlayableAlawMessage(bad), `${bad}`).toBe(false);
  });
});
