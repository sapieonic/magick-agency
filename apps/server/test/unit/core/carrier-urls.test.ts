import { describe, expect, it } from 'vitest';
import { buildCarrierUrls } from '../../../src/core/bridge/carrier-urls.js';

/*
 * The URLs the carrier is handed per dial. Without a route hint (one process) they are
 * byte-for-byte what the bridge always built; with one (a media worker) both carry
 * `&w=<slot>` after their token (docs/scaling.md §2.5).
 */
const base = 'https://agency.example.com/api/v1/webhooks/voicelink';

describe('buildCarrierUrls', () => {
  it('one process: the URLs the bridge always built', () => {
    expect(buildCarrierUrls({ base, callId: 'c1', mediaUrlInDialRequest: true, providerToken: 'p', webhookToken: 'w' })).toEqual({
      mediaStreamUrl: 'wss://agency.example.com/api/v1/webrtc-call/c1/pstn-stream?token=p',
      statusCallbackUrl: `${base}/webrtc-status/c1?token=w`,
    });
  });

  it('a carrier with the stream in its answer gets no media URL; one with no tokens an untokenized webhook', () => {
    expect(buildCarrierUrls({ base, callId: 'c1', mediaUrlInDialRequest: false, providerToken: undefined, webhookToken: undefined, routeHint: '2' })).toEqual({
      mediaStreamUrl: undefined,
      statusCallbackUrl: `${base}/webrtc-status/c1`,
    });
  });

  it('a media worker: both URLs carry its slot after the token', () => {
    expect(buildCarrierUrls({ base, callId: 'c1', mediaUrlInDialRequest: true, providerToken: 'p', webhookToken: 'w', routeHint: '2' })).toEqual({
      mediaStreamUrl: 'wss://agency.example.com/api/v1/webrtc-call/c1/pstn-stream?token=p&w=2',
      statusCallbackUrl: `${base}/webrtc-status/c1?token=w&w=2`,
    });
  });
});
