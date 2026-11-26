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
    expect(isDirectRecordingProvider('voicelink', null)).toBe(true);
    expect(isDirectRecordingProvider('twilio', null)).toBe(false);
    expect(isDirectRecordingProvider('vobiz', null)).toBe(false);
    expect(isDirectRecordingProvider('unknown', null)).toBe(false);
  });

  it('is case-sensitive (allowlist is lowercase only)', () => {
    expect(isDirectRecordingProvider('VoiceLink', null)).toBe(false);
    expect(isDirectRecordingProvider('VOICELINK', null)).toBe(false);
    expect(isDirectRecordingProvider('Voicelink', null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isDirectRecordingProvider('', null)).toBe(false);
  });

  it('returns false for every other known telephony provider', () => {
    for (const p of ['twilio', 'vobiz', 'exotel', 'telnyx', 'z99', 'plivo', 'generic_sip']) {
      expect(isDirectRecordingProvider(p, null)).toBe(false);
    }
  });
});

describe('isDirectRecordingProvider — a call pinned to a credential (CR12)', () => {
  it('is never direct, even on a carrier whose service-account recordings are public', () => {
    expect(isDirectRecordingProvider('voicelink', 'cred-1')).toBe(false);
    expect(isDirectRecordingProvider('plivo', 'cred-1')).toBe(false);
  });

  it('reads only a null credential as unpinned: a row read without the column is proxied', () => {
    expect(isDirectRecordingProvider('voicelink', undefined)).toBe(false);
    expect(isDirectRecordingProvider('voicelink', '')).toBe(false);
  });
});

describe('isDirectRecordingProvider — scope', () => {
  it('voicelink is the only direct provider today — twilio/vobiz go through the proxy', () => {
    expect(isDirectRecordingProvider('voicelink', null)).toBe(true);
    expect(isDirectRecordingProvider('twilio', null)).toBe(false);
    expect(isDirectRecordingProvider('vobiz', null)).toBe(false);
  });
});

describe('resolveClientRecordingUrl — the proxy-path-agnostic form', () => {
  // The WebRTC surface passes its own streaming route. The direct-provider rule
  // must be identical on every playback surface, so a provider added to the
  // allowlist takes effect everywhere at once.
  const WEBRTC_PROXY = '/api/v1/webrtc-call/call-1/recording';

  it('returns null when there is no recording', () => {
    expect(
      resolveClientRecordingUrl({ recordingUrl: null, provider: 'voicelink', telephonyCredentialId: null, proxyPath: WEBRTC_PROXY }),
    ).toBeNull();
    expect(
      resolveClientRecordingUrl({ recordingUrl: undefined, provider: 'vobiz', telephonyCredentialId: null, proxyPath: WEBRTC_PROXY }),
    ).toBeNull();
    expect(
      resolveClientRecordingUrl({ recordingUrl: '', provider: 'voicelink', telephonyCredentialId: null, proxyPath: WEBRTC_PROXY }),
    ).toBeNull();
  });

  it('returns the raw provider URL for voicelink, whatever the proxy path', () => {
    expect(
      resolveClientRecordingUrl({ recordingUrl: VOICELINK_URL, provider: 'voicelink', telephonyCredentialId: null, proxyPath: WEBRTC_PROXY }),
    ).toBe(VOICELINK_URL);
    expect(
      resolveClientRecordingUrl({
        recordingUrl: VOICELINK_URL,
        provider: 'voicelink',
        telephonyCredentialId: null,
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
          telephonyCredentialId: null,
          proxyPath: WEBRTC_PROXY,
        }),
      ).toBe(WEBRTC_PROXY);
    }
  });

  it('returns the proxy path for a VoiceLink call pinned to a credential (CR12: revoking it ends playback)', () => {
    expect(
      resolveClientRecordingUrl({
        recordingUrl: VOICELINK_URL, provider: 'voicelink', telephonyCredentialId: 'cred-1', proxyPath: WEBRTC_PROXY,
      }),
    ).toBe(WEBRTC_PROXY);
  });

  it('proxies for an empty or unrecognised provider (fail closed — never leak an auth-gated URL)', () => {
    expect(
      resolveClientRecordingUrl({
        recordingUrl: 'https://media.vobiz.ai/rec/1.mp3',
        provider: '',
        telephonyCredentialId: null,
        proxyPath: WEBRTC_PROXY,
      }),
    ).toBe(WEBRTC_PROXY);
    expect(
      resolveClientRecordingUrl({
        recordingUrl: 'https://x/y.mp3',
        provider: 'brand_new_carrier',
        telephonyCredentialId: null,
        proxyPath: WEBRTC_PROXY,
      }),
    ).toBe(WEBRTC_PROXY);
  });
});
