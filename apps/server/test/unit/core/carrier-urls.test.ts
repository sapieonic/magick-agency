import { describe, expect, it } from 'vitest';
import { buildCarrierUrls, carrierCallbackUrl } from '../../../src/core/bridge/carrier-urls.js';

/*
 * The URLs the carrier is handed per dial. Without a route hint (one process) the
 * VoiceLink media and status URLs are byte-for-byte what the bridge always built; with
 * one (a media worker) each carries `&w=<slot>` after its token (docs/scaling.md §2.5).
 * Every callback carries the webhook token; the stream goes in the dial (VoiceLink) or
 * in our answer response (Plivo), never both.
 */
const base = 'https://agency.example.com/api/v1/webhooks/voicelink';
const plivoBase = 'https://agency.example.com/api/v1/webhooks/plivo';

describe('buildCarrierUrls', () => {
  it('one process: the URLs the bridge always built, plus tokenized answer and recording callbacks', () => {
    expect(buildCarrierUrls({ base, callId: 'c1', mediaUrlInDialRequest: true, providerToken: 'p', webhookToken: 'w' })).toEqual({
      mediaStreamUrl: 'wss://agency.example.com/api/v1/webrtc-call/c1/pstn-stream?token=p',
      answerStreamUrl: undefined,
      answerUrl: `${base}/webrtc-answer/c1?token=w`,
      statusCallbackUrl: `${base}/webrtc-status/c1?token=w`,
      recordingCallbackUrl: `${base}/webrtc-recording/c1?token=w`,
    });
  });

  it('a carrier with the stream in its answer: the stream URL is kept for the answer, not the dial', () => {
    expect(buildCarrierUrls({ base: plivoBase, callId: 'c1', mediaUrlInDialRequest: false, providerToken: 'p', webhookToken: 'w', routeHint: '2' })).toEqual({
      mediaStreamUrl: undefined,
      answerStreamUrl: 'wss://agency.example.com/api/v1/webrtc-call/c1/pstn-stream?token=p&w=2',
      answerUrl: `${plivoBase}/webrtc-answer/c1?token=w&w=2`,
      statusCallbackUrl: `${plivoBase}/webrtc-status/c1?token=w&w=2`,
      recordingCallbackUrl: `${plivoBase}/webrtc-recording/c1?token=w&w=2`,
    });
  });

  it('a provider with no tokens (no carrier module): untokenized callbacks, no stream URL, no hint', () => {
    expect(buildCarrierUrls({ base, callId: 'c1', mediaUrlInDialRequest: false, providerToken: undefined, webhookToken: undefined, routeHint: '2' })).toEqual({
      mediaStreamUrl: undefined,
      answerStreamUrl: undefined,
      answerUrl: `${base}/webrtc-answer/c1`,
      statusCallbackUrl: `${base}/webrtc-status/c1`,
      recordingCallbackUrl: `${base}/webrtc-recording/c1`,
    });
  });

  it('a media worker: every URL carries its slot after the token', () => {
    const urls = buildCarrierUrls({ base, callId: 'c1', mediaUrlInDialRequest: true, providerToken: 'p', webhookToken: 'w', routeHint: '2' });
    expect(urls.mediaStreamUrl).toBe('wss://agency.example.com/api/v1/webrtc-call/c1/pstn-stream?token=p&w=2');
    expect(urls.statusCallbackUrl).toBe(`${base}/webrtc-status/c1?token=w&w=2`);
    expect(urls.answerUrl).toBe(`${base}/webrtc-answer/c1?token=w&w=2`);
  });
});

describe('the stream URL keeps a proxy`s path prefix, as the callbacks do', () => {
  it('a base under a prefix: the stream route under the same prefix', () => {
    const prefixed = 'https://agency.example.com/edge/api/v1/webhooks/plivo/';
    const urls = buildCarrierUrls({ base: prefixed, callId: 'c1', mediaUrlInDialRequest: false, providerToken: 'p', webhookToken: 'w' });
    expect(urls.answerStreamUrl).toBe('wss://agency.example.com/edge/api/v1/webrtc-call/c1/pstn-stream?token=p');
    expect(urls.answerUrl).toBe('https://agency.example.com/edge/api/v1/webhooks/plivo/webrtc-answer/c1?token=w');
  });

  it('a base with no prefix, or not laid out as `…/api/v1/webhooks/<carrier>`: the stream at the host`s root, as before', () => {
    for (const b of [base, 'https://agency.example.com/hooks/voicelink', 'https://agency.example.com']) {
      const urls = buildCarrierUrls({ base: b, callId: 'c1', mediaUrlInDialRequest: true, providerToken: 'p', webhookToken: 'w' });
      expect(urls.mediaStreamUrl).toBe('wss://agency.example.com/api/v1/webrtc-call/c1/pstn-stream?token=p');
    }
  });
});

describe('carrierCallbackUrl (the dial`s URLs and the signature check`s subject)', () => {
  it('keeps the base as written: host case, an explicit default port, a path prefix; strips only trailing slashes', () => {
    expect(carrierCallbackUrl('https://Dialer.example.com:443/x/api/v1/webhooks/plivo//', 'webrtc-status', 'c1', '?token=w&w=2'))
      .toBe('https://Dialer.example.com:443/x/api/v1/webhooks/plivo/webrtc-status/c1?token=w&w=2');
  });

  it('is what buildCarrierUrls hands the carrier', () => {
    const raw = 'https://Dialer.example.com:443/api/v1/webhooks/plivo';
    const urls = buildCarrierUrls({ base: raw, callId: 'c1', mediaUrlInDialRequest: false, providerToken: 'p', webhookToken: 'w', routeHint: '2' });
    expect(urls.answerUrl).toBe(carrierCallbackUrl(raw, 'webrtc-answer', 'c1', '?token=w&w=2'));
    expect(urls.statusCallbackUrl).toBe(carrierCallbackUrl(raw, 'webrtc-status', 'c1', '?token=w&w=2'));
    expect(urls.recordingCallbackUrl).toBe(carrierCallbackUrl(raw, 'webrtc-recording', 'c1', '?token=w&w=2'));
    expect(urls.statusCallbackUrl.startsWith('https://Dialer.example.com:443/')).toBe(true);
  });
});
