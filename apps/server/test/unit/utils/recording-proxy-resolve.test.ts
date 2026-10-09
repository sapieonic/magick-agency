/*
 * PORT NOTE (magick-agency): ported from core test/unit/utils/recording-proxy-resolve.test.ts
 * @4850d1d9 (17 cases -> 9). Deleted: every case through `resolveRecordingUrl` (the AI-call
 * binding over `CallRecord`, not carried): the 3-case `resolveRecordingUrl` describe,
 * 4 of the 5 "exhaustive edge cases" and "agrees with resolveRecordingUrl". The
 * direct-provider and `resolveClientRecordingUrl` cases are unchanged.
 */
import { describe, it, expect } from 'vitest';

// The pure resolution helpers live in a config-free module, so this test needs
// no config/logger stubbing.
import {
  resolveClientRecordingUrl,
  isDirectRecordingProvider,
} from '../../../src/utils/recording-url-resolver.js';

const VOICELINK_URL =
  'https://voiceflowai.elisiontec.com/voiceapp-recordings/client_1150/2026-07-11/abc.mp3';

describe('isDirectRecordingProvider', () => {
  it('is true only for allowlisted direct providers', () => {
    expect(isDirectRecordingProvider('voicelink')).toBe(true);
    expect(isDirectRecordingProvider('twilio')).toBe(false);
    expect(isDirectRecordingProvider('vobiz')).toBe(false);
    expect(isDirectRecordingProvider('unknown')).toBe(false);
  });

  it('is case-sensitive (allowlist is lowercase only)', () => {
    expect(isDirectRecordingProvider('VoiceLink')).toBe(false);
    expect(isDirectRecordingProvider('VOICELINK')).toBe(false);
    expect(isDirectRecordingProvider('Voicelink')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isDirectRecordingProvider('')).toBe(false);
  });

  it('returns false for every other known telephony provider', () => {
    for (const p of ['twilio', 'vobiz', 'exotel', 'telnyx', 'z99', 'plivo', 'generic_sip']) {
      expect(isDirectRecordingProvider(p)).toBe(false);
    }
  });
});

describe('isDirectRecordingProvider — scope', () => {
  it('voicelink is the only direct provider today — twilio/vobiz go through the proxy', () => {
    expect(isDirectRecordingProvider('voicelink')).toBe(true);
    expect(isDirectRecordingProvider('twilio')).toBe(false);
    expect(isDirectRecordingProvider('vobiz')).toBe(false);
  });
});

describe('resolveClientRecordingUrl — the proxy-path-agnostic form', () => {
  // The WebRTC surface passes its own streaming route. The direct-provider rule
  // must be identical to AI calls' so a provider added to the allowlist takes
  // effect on every playback surface at once.
  const WEBRTC_PROXY = '/api/v1/webrtc-call/call-1/recording';

  it('returns null when there is no recording', () => {
    expect(
      resolveClientRecordingUrl({ recordingUrl: null, provider: 'voicelink', proxyPath: WEBRTC_PROXY }),
    ).toBeNull();
    expect(
      resolveClientRecordingUrl({ recordingUrl: undefined, provider: 'vobiz', proxyPath: WEBRTC_PROXY }),
    ).toBeNull();
    expect(
      resolveClientRecordingUrl({ recordingUrl: '', provider: 'voicelink', proxyPath: WEBRTC_PROXY }),
    ).toBeNull();
  });

  it('returns the raw provider URL for voicelink, whatever the proxy path', () => {
    expect(
      resolveClientRecordingUrl({ recordingUrl: VOICELINK_URL, provider: 'voicelink', proxyPath: WEBRTC_PROXY }),
    ).toBe(VOICELINK_URL);
    expect(
      resolveClientRecordingUrl({
        recordingUrl: VOICELINK_URL,
        provider: 'voicelink',
        proxyPath: '/api/v1/calls/call-1/recording',
      }),
    ).toBe(VOICELINK_URL);
  });

  it('returns the given proxy path for auth-gated providers', () => {
    for (const provider of ['twilio', 'vobiz', 'exotel', 'telnyx', 'z99', 'plivo', 'generic_sip']) {
      expect(
        resolveClientRecordingUrl({
          recordingUrl: 'https://provider.example/rec.mp3',
          provider,
          proxyPath: WEBRTC_PROXY,
        }),
      ).toBe(WEBRTC_PROXY);
    }
  });

  it('proxies for an empty or unrecognised provider (fail closed — never leak an auth-gated URL)', () => {
    expect(
      resolveClientRecordingUrl({
        recordingUrl: 'https://media.vobiz.ai/rec/1.mp3',
        provider: '',
        proxyPath: WEBRTC_PROXY,
      }),
    ).toBe(WEBRTC_PROXY);
    expect(
      resolveClientRecordingUrl({
        recordingUrl: 'https://x/y.mp3',
        provider: 'brand_new_carrier',
        proxyPath: WEBRTC_PROXY,
      }),
    ).toBe(WEBRTC_PROXY);
  });
});
