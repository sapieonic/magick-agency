import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoicelinkAdapter } from '../../../../src/telephony/voicelink/voicelink.adapter.js';
import type { VoicelinkConfig, VoicelinkWebhookBody } from '../../../../src/telephony/voicelink/voicelink.types.js';
import type { OutboundCallRequest } from '../../../../src/telephony/types.js';

const VOICELINK_CONFIG: VoicelinkConfig = {
  baseUrl: 'https://app.voicelink.example/api',
  username: 'vl-user',
  password: 'super-secret-password',
  webhookBaseUrl: 'https://host/api/v1/webhooks/voicelink',
  defaultCallerId: '919228130625',
  defaultCountryCode: '91',
};

const LOGIN_OK = {
  ok: true,
  status: 200,
  json: async () => ({ data: { access_token: 'vl-token-abc', token_type: 'Bearer' } }),
  text: async () => JSON.stringify({ data: { access_token: 'vl-token-abc' } }),
};

const ADD_LEAD_OK = {
  ok: true,
  status: 200,
  json: async () => ({
    status: true,
    message: 'Lead added successfully',
    data: { outbound_queue_id: 1716830, bot_id: 321, reseller_id: 1113, client_id: 1150, carrier_id: 14 },
  }),
  text: async () => JSON.stringify({ status: true, message: 'Lead added successfully' }),
};

const makeReq = (over: Partial<OutboundCallRequest> = {}): OutboundCallRequest => ({
  callId: 'call-1',
  to: '+917978021700',
  from: '919228130625',
  webhookUrl: 'https://host/answer',
  statusCallbackUrl: 'https://host/status',
  maxDuration: 600,
  ...over,
});

describe('VoicelinkAdapter', () => {
  describe('static / XML-shape methods', () => {
    const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);

    it('reports its name as voicelink', () => {
      expect(adapter.name).toBe('voicelink');
    });

    it('generateAnswerResponse returns an empty string (VoiceLink has no answer XML)', () => {
      expect(adapter.generateAnswerResponse('call-1', 'wss://host/api/v1/media-stream/call-1')).toBe('');
    });

    it('generateAnnouncementResponse returns an empty string', () => {
      expect(adapter.generateAnnouncementResponse({ type: 'tts', text: 'hello' })).toBe('');
    });

    it('validateWebhookSignature returns true (HTTPS + opaque id trust model)', () => {
      expect(adapter.validateWebhookSignature('{}', 'whatever')).toBe(true);
    });

    it('getMediaStreamConfig reports pcma (A-law) at 8kHz, bidirectional websocket', async () => {
      const cfg = await adapter.getMediaStreamConfig('call-1');
      expect(cfg).toEqual({
        type: 'websocket',
        codec: 'pcma',
        sampleRate: 8000,
        direction: 'both',
      });
    });

    it('generateIvrResponse throws (IVR is not supported on voicelink)', () => {
      expect(() => adapter.generateIvrResponse([])).toThrow(/IVR not supported for voicelink/);
    });
  });

  // ─── The country-code split — the load-bearing, VoiceLink-unique transform ──
  // Matrix from FINDINGS §2b: every input format must normalize to a BARE
  // national customer_number + a SEPARATE country_code (no `+`, no leading 0).
  describe('splitDestination (country-code split matrix)', () => {
    const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);

    const cases: Array<{ label: string; to: string; expected: { countryCode: string; customerNumber: string } }> = [
      {
        label: 'CC concatenated (918093773107) → peel 91 off',
        to: '918093773107',
        expected: { countryCode: '91', customerNumber: '8093773107' },
      },
      {
        label: 'leading 0 (08093773107) → strip trunk 0, default CC',
        to: '08093773107',
        expected: { countryCode: '91', customerNumber: '8093773107' },
      },
      {
        label: 'E.164 (+918093773107) → strip +, peel 91 off',
        to: '+918093773107',
        expected: { countryCode: '91', customerNumber: '8093773107' },
      },
      {
        label: 'bare national (8093773107) → default CC prepended as separate field',
        to: '8093773107',
        expected: { countryCode: '91', customerNumber: '8093773107' },
      },
      {
        label: 'E.164 with separators (+91 80937-73107) → digits only',
        to: '+91 80937-73107',
        expected: { countryCode: '91', customerNumber: '8093773107' },
      },
    ];

    for (const { label, to, expected } of cases) {
      it(`normalizes ${label}`, () => {
        expect(adapter.splitDestination(to)).toEqual(expected);
      });
    }

    it('honors a non-default configured country code', () => {
      const usAdapter = new VoicelinkAdapter({ ...VOICELINK_CONFIG, defaultCountryCode: '1' });
      // +1 415 555 0100 → peel the 1, bare national follows.
      expect(usAdapter.splitDestination('+14155550100')).toEqual({
        countryCode: '1',
        customerNumber: '4155550100',
      });
    });

    it('strips a non-digit country code config down to digits', () => {
      const adapter2 = new VoicelinkAdapter({ ...VOICELINK_CONFIG, defaultCountryCode: '+91' });
      expect(adapter2.splitDestination('+917978021700')).toEqual({
        countryCode: '91',
        customerNumber: '7978021700',
      });
    });
  });

  describe('initiateCall', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/v1/auth/login')) return LOGIN_OK as unknown as Response;
        if (url.endsWith('/v1/add_lead')) return ADD_LEAD_OK as unknown as Response;
        throw new Error(`unexpected fetch to ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    const bodyOf = (callArgs: unknown[]): Record<string, unknown> =>
      JSON.parse((callArgs[1] as { body: string }).body);

    const callsTo = (suffix: string) => fetchMock.mock.calls.filter(([u]) => String(u).endsWith(suffix));

    it('returns providerCallId === callId', async () => {
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      const result = await adapter.initiateCall(makeReq());
      expect(result).toEqual({ providerCallId: 'call-1' });
    });

    it('POSTs to /v1/add_lead exactly once', async () => {
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      await adapter.initiateCall(makeReq());
      expect(callsTo('/v1/add_lead')).toHaveLength(1);
    });

    it('add_lead body has the split customer_number + separate country_code (the working recipe)', async () => {
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      await adapter.initiateCall(makeReq({ to: '+917978021700', from: '919228130625' }));
      const body = bodyOf(callsTo('/v1/add_lead')[0]!);
      // The exact shape verified end-to-end in the live capture.
      expect(body['did_number']).toBe('919228130625');
      expect(body['customer_number']).toBe('7978021700');
      expect(body['country_code']).toBe('91');
      // The CC must be a SEPARATE field, never baked into customer_number.
      expect(String(body['customer_number'])).not.toContain('91');
      expect(String(body['customer_number'])).not.toContain('+');
    });

    it('add_lead body table-tests the full number-format matrix', async () => {
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      const inputs = ['918093773107', '08093773107', '+918093773107', '8093773107'];
      for (const to of inputs) {
        fetchMock.mockClear();
        await adapter.initiateCall(makeReq({ to }));
        const body = bodyOf(callsTo('/v1/add_lead')[0]!);
        expect(body['customer_number']).toBe('8093773107');
        expect(body['country_code']).toBe('91');
      }
    });

    it('strips the leading + off the DID (did_number must be bare digits)', async () => {
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      await adapter.initiateCall(makeReq({ from: '+919228130625' }));
      const body = bodyOf(callsTo('/v1/add_lead')[0]!);
      expect(body['did_number']).toBe('919228130625');
    });

    it('derives websocket_url from webhookBaseUrl host + callId path and honors statusCallbackUrl', async () => {
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      await adapter.initiateCall(makeReq({ callId: 'abc-9' }));
      const body = bodyOf(callsTo('/v1/add_lead')[0]!);
      // webhookBaseUrl host is "host".
      expect(body['websocket_url']).toBe('wss://host/api/v1/media-stream/abc-9');
      // webhook_url honors the caller's status callback (the AI path passes the
      // identical /voicelink/status URL; the WebRTC bridge passes its own route).
      expect(body['webhook_url']).toBe('https://host/status');
    });

    it('falls back to the default status route when statusCallbackUrl is absent', async () => {
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      await adapter.initiateCall(makeReq({ callId: 'abc-9', statusCallbackUrl: '' }));
      const body = bodyOf(callsTo('/v1/add_lead')[0]!);
      expect(body['webhook_url']).toBe('https://host/api/v1/webhooks/voicelink/status/abc-9');
    });

    it('uses mediaStreamUrl as websocket_url when provided (WebRTC bridge leg)', async () => {
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      const streamUrl = 'wss://host/api/v1/webrtc-call/abc-9/pstn-stream';
      await adapter.initiateCall(makeReq({ callId: 'abc-9', mediaStreamUrl: streamUrl }));
      const body = bodyOf(callsTo('/v1/add_lead')[0]!);
      expect(body['websocket_url']).toBe(streamUrl);
    });

    it('sends Authorization: Bearer <token> and Accept: application/json', async () => {
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      await adapter.initiateCall(makeReq());
      const init = callsTo('/v1/add_lead')[0]![1] as { headers: Record<string, string> };
      expect(init.headers['Authorization']).toBe('Bearer vl-token-abc');
      expect(init.headers['Accept']).toBe('application/json');
    });

    it('on HTTP 401 refreshes the token and retries add_lead exactly once', async () => {
      let attempts = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith('/v1/auth/login')) return LOGIN_OK as unknown as Response;
        if (url.endsWith('/v1/add_lead')) {
          attempts++;
          if (attempts === 1) {
            return { ok: false, status: 401, text: async () => 'unauthorized' } as unknown as Response;
          }
          return ADD_LEAD_OK as unknown as Response;
        }
        throw new Error(`unexpected fetch to ${url}`);
      });

      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      await adapter.initiateCall(makeReq());

      // add_lead attempted twice (401 then retry); login twice (initial + refresh).
      expect(callsTo('/v1/add_lead')).toHaveLength(2);
      expect(callsTo('/v1/auth/login')).toHaveLength(2);
    });

    it('does not retry more than once — a second 401 propagates as an error', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith('/v1/auth/login')) return LOGIN_OK as unknown as Response;
        if (url.endsWith('/v1/add_lead')) {
          return { ok: false, status: 401, text: async () => 'still unauthorized' } as unknown as Response;
        }
        throw new Error(`unexpected fetch to ${url}`);
      });

      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      await expect(adapter.initiateCall(makeReq())).rejects.toThrow(/VoiceLink \/v1\/add_lead error 401/);
      // Exactly one retry: the initial 401 + the post-refresh 401.
      expect(callsTo('/v1/add_lead')).toHaveLength(2);
    });

    it('throws on a non-401 non-ok add_lead response (no retry)', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith('/v1/auth/login')) return LOGIN_OK as unknown as Response;
        if (url.endsWith('/v1/add_lead')) {
          return { ok: false, status: 400, text: async () => 'Invalid number format' } as unknown as Response;
        }
        throw new Error(`unexpected fetch to ${url}`);
      });

      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      await expect(adapter.initiateCall(makeReq())).rejects.toThrow(
        /VoiceLink \/v1\/add_lead error 400: Invalid number format/,
      );
      expect(callsTo('/v1/add_lead')).toHaveLength(1);
    });
  });

  // ─── parseWebhookEvent — maps every VoiceLink lifecycle event (§1.3) ────────
  describe('parseWebhookEvent', () => {
    const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);

    const makeBody = (event: string, call: Record<string, unknown> = {}): VoicelinkWebhookBody => ({
      event,
      timestamp: '2026-07-11T13:49:42.070+05:30',
      call: { id: 'vl-call-77', direction: 'outbound', ...call },
    });

    it('call.ringing → ringing', () => {
      const ev = adapter.parseWebhookEvent(makeBody('call.ringing', { status: 'ringing', ringingAt: 'x' }), {});
      expect(ev.eventType).toBe('ringing');
      expect(ev.providerCallId).toBe('vl-call-77');
      expect(ev.callId).toBe('vl-call-77');
    });

    it('call.answered → answer (billing-critical anchor)', () => {
      const ev = adapter.parseWebhookEvent(makeBody('call.answered', { status: 'answered', answeredAt: 'x' }), {});
      expect(ev.eventType).toBe('answer');
    });

    // Real captured shape (experiment/captures/*__call.ended): NO `callStatus`
    // field — only `status:"ended"`, `hangupCause`, `answeredAt`, `durationSec`.
    // Because `callStatus` is absent, `answeredAt` is the discriminator: this
    // fixture carries one, so it is a hangup. `call.ended` is NOT proof of an
    // answer on its own — VoiceLink emits it for unanswered calls too (429
    // call.ended vs 206 call.answered over 24h on dedicated), which is why the
    // unanswered counterpart below must map to `error`. See the split in
    // voicelink.webhook.test.ts.
    it('call.ended WITH answeredAt → hangup (real payload has no callStatus)', () => {
      const ev = adapter.parseWebhookEvent(
        makeBody('call.ended', {
          status: 'ended',
          hangupCause: '16',
          answeredAt: '2026-07-11T13:50:06.000+05:30',
          endedAt: '2026-07-11T13:50:27.219+05:30',
          durationSec: 21,
          sipStatus: '200',
        }),
        {},
      );
      expect(ev.eventType).toBe('hangup');
    });

    // The counterpart of the case above, and the regression that let unanswered
    // calls settle as phantom `completed`. Same event, no `answeredAt`.
    it('call.ended WITHOUT answeredAt → error (never answered)', () => {
      const ev = adapter.parseWebhookEvent(
        makeBody('call.ended', {
          status: 'ended',
          hangupCause: '19 - No answer from user',
          answeredAt: null,
          endedAt: '2026-08-07T10:18:35.000+05:30',
          durationSec: null,
        }),
        {},
      );
      expect(ev.eventType).toBe('error');
    });

    it('call.failed → error', () => {
      const ev = adapter.parseWebhookEvent(
        makeBody('call.failed', {
          status: 'failed',
          callStatus: 'NO ANSWER',
          hangupCause: '38 - Network out of order',
          sipStatus: '503',
        }),
        {},
      );
      expect(ev.eventType).toBe('error');
    });

    it('call.completed (ANSWERED) → hangup — completed is NOT auto-success', () => {
      const ev = adapter.parseWebhookEvent(
        makeBody('call.completed', { status: 'ended', callStatus: 'ANSWERED', hangupCause: '16' }),
        {},
      );
      expect(ev.eventType).toBe('hangup');
    });

    it('call.completed (NOT answered) → error — terminal-but-failed', () => {
      const ev = adapter.parseWebhookEvent(
        makeBody('call.completed', { status: 'failed', callStatus: 'NO ANSWER', hangupCause: '38 - Network out of order' }),
        {},
      );
      expect(ev.eventType).toBe('error');
    });

    it('call.initiated → benign informational error event (no real transition)', () => {
      // The adapter interface must return a CallEvent; call.initiated has no
      // transition, so the parser returns null and the adapter surfaces a benign
      // informational event.
      const ev = adapter.parseWebhookEvent(makeBody('call.initiated', { status: 'initiated' }), {});
      expect(ev.eventType).toBe('error');
      expect(ev.metadata['informational']).toBe(true);
    });

    it('preserves failure diagnostics + recordingUrl in metadata', () => {
      const ev = adapter.parseWebhookEvent(
        makeBody('call.completed', {
          status: 'ended',
          callStatus: 'ANSWERED',
          hangupCause: '16',
          hangupReason: 'Normal Clearing',
          sipStatus: '200',
          answeredAt: '2026-07-11T13:50:06.000+05:30',
          endedAt: '2026-07-11T13:50:27.000+05:30',
          durationSec: 21,
          recordingUrl: 'https://voiceflowai.elisiontec.com/rec/abc.mp3',
        }),
        {},
      );
      expect(ev.metadata['hangupCause']).toBe('16');
      expect(ev.metadata['sipStatus']).toBe('200');
      expect(ev.metadata['recordingUrl']).toBe('https://voiceflowai.elisiontec.com/rec/abc.mp3');
      expect(ev.metadata['rawEvent']).toBe('call.completed');
      expect(ev.metadata['rawCallStatus']).toBe('ANSWERED');
    });

    it('propagates direction=outbound by default', () => {
      const ev = adapter.parseWebhookEvent(makeBody('call.answered', { direction: 'outbound' }), {});
      expect(ev.direction).toBe('outbound');
    });

    it('maps direction=inbound when reported', () => {
      const ev = adapter.parseWebhookEvent(makeBody('call.answered', { direction: 'inbound' }), {});
      expect(ev.direction).toBe('inbound');
    });

    it('unknown event → benign informational error event', () => {
      const ev = adapter.parseWebhookEvent(makeBody('call.somethingNew'), {});
      expect(ev.eventType).toBe('error');
      expect(ev.metadata['informational']).toBe(true);
    });
  });

  describe('endCall', () => {
    it('is a no-op and fires no fetch (hangup unobserved — WS close ends the call)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      try {
        const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
        await expect(adapter.endCall('call-1')).resolves.toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
