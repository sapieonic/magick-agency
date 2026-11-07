import { describe, it, expect, vi, beforeEach } from 'vitest';

// Plivo's answer, status and recording callbacks (`src/api/routes/webhooks/plivo.ts`),
// through the real webhooks plugin (its form parser) and a REAL `PlivoAdapter` for the
// signature: each request is signed here with Plivo's V3 construction over the public URL
// Plivo was given, so the route's URL reconstruction (the full env base + the route, the
// call id and the request's query; never the Host header, never the path the request
// arrived on) is what is under test. The bridge is a stub. Each request is signed with its
// own nonce, as Plivo signs each callback: a repeated (call, nonce) is a replay.

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), isLevelEnabled: () => false }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), isLevelEnabled: () => false },
}));

const { PLIVO_BASE } = vi.hoisted(() => ({ PLIVO_BASE: 'https://agency.example.com/api/v1/webhooks/plivo' }));
vi.mock('../../../../src/config/index.js', () => ({
  config: { telephony: { plivo: { webhookBaseUrl: PLIVO_BASE }, voicelink: { webhookBaseUrl: '' } } },
}));

import Fastify, { type FastifyInstance } from 'fastify';
import querystring from 'node:querystring';
import { webhooksRoutes, setPlivoCallbackForwarder, setVoicelinkWebhookForwarder } from '../../../../src/api/routes/webhooks.routes.js';
import { DEFAULT_PLIVO_SETTINGS, PlivoAdapter, PLIVO_HANGUP_XML } from '../../../../src/telephony/plivo/plivo.adapter.js';
import { computePlivoV3Signature } from '../../../../src/telephony/plivo/plivo-signature.js';
import { Secret } from '../../../../src/telephony/credentials/secret.js';
import { budgetFor } from '../../../../src/api/middleware/rate-limit.middleware.js';
import { config } from '../../../../src/config/index.js';
import { buildCarrierUrls } from '../../../../src/core/bridge/carrier-urls.js';
import { normalizeWebhookBase } from '../../../../src/utils/webhook-base.js';

const TOKEN = 'plivo-auth-token-current';
const CALL_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const STREAM = `wss://agency.example.com/api/v1/webrtc-call/${CALL_ID}/pstn-stream?token=prov-tok&w=3`;

const adapter = new PlivoAdapter({
  ...DEFAULT_PLIVO_SETTINGS,
  webhookBaseUrl: PLIVO_BASE,
  authId: 'MAXXXXXXXXXXXXXXXXXX',
  authToken: new Secret(TOKEN),
  fetchImpl: async () => { throw new Error('no network in this test'); },
});

function makeBridge() {
  return {
    verifyWsToken: vi.fn().mockResolvedValue(true),
    // As the bridge's Redis set: true the first time a (call, nonce) is seen.
    seenNonces: new Set<string>(),
    claimCallbackNonce: vi.fn(async function (this: { seenNonces: Set<string> }, callId: string, nonce: string) {
      const key = `${callId}:${nonce}`;
      if (this.seenNonces.has(key)) return false;
      this.seenNonces.add(key);
      return true;
    }),
    releaseCallbackNonce: vi.fn(async function (this: { seenNonces: Set<string> }, callId: string, nonce: string) {
      this.seenNonces.delete(`${callId}:${nonce}`);
    }),
    carrierCallbackAdapter: vi.fn().mockResolvedValue(adapter),
    answerCarrierCall: vi.fn().mockResolvedValue({
      streamUrl: STREAM, enableRecording: true,
      recordingCallbackUrl: `${PLIVO_BASE}/webrtc-recording/${CALL_ID}?token=wh&w=3`, maxDurationSeconds: 900,
    }),
    handleCarrierStatus: vi.fn().mockResolvedValue(undefined),
    handleCarrierRecording: vi.fn().mockResolvedValue(undefined),
  };
}

async function buildApp(bridge: unknown): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(async (i) => { await webhooksRoutes(i, { webrtcBridge: bridge as any }); }, { prefix: '/api/v1/webhooks' });
  await app.ready();
  return app;
}

/** POST a form body to `path` (under the Plivo base), signed for the public URL unless told otherwise. */
function post(app: FastifyInstance, path: string, params: Record<string, string>, opts: {
  signWith?: string; signUrl?: string; nonce?: string; host?: string; unsigned?: boolean;
} = {}) {
  const publicUrl = opts.signUrl ?? `${PLIVO_BASE}${path}`;
  const nonce = opts.nonce ?? freshNonce();
  const sig = computePlivoV3Signature(opts.signWith ?? TOKEN, 'POST', publicUrl, params, nonce);
  return app.inject({
    method: 'POST',
    url: `/api/v1/webhooks/plivo${path}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      host: opts.host ?? 'internal-host:3021',
      ...(opts.unsigned ? {} : { 'x-plivo-signature-v3': sig, 'x-plivo-signature-v3-nonce': nonce }),
    },
    payload: querystring.stringify(params),
  });
}

const ANSWER = { CallUUID: 'uuid-1', RequestUUID: 'req-1', CallStatus: 'in-progress', From: '14155550100', To: '14155550199', Direction: 'outbound' };
const answerPath = `/webrtc-answer/${CALL_ID}?token=wh&w=3`;

let bridge: ReturnType<typeof makeBridge>;
beforeEach(() => {
  setVoicelinkWebhookForwarder(null);
  setPlivoCallbackForwarder(null);
  bridge = makeBridge();
});

/** Each request signed with its own nonce, as Plivo signs each callback it sends. */
let nonceSeq = 0;
const freshNonce = () => `nonce-${++nonceSeq}-${Math.random().toString(36).slice(2)}`;

describe('a replayed callback (the same signed nonce for the call) is refused', () => {
  it('a status replayed is 403 and reaches the bridge once; another nonce is accepted', async () => {
    const app = await buildApp(bridge);
    const path = `/webrtc-status/${CALL_ID}?token=wh&w=3`;
    const params = { CallUUID: 'uuid-1', CallStatus: 'ringing' };
    expect((await post(app, path, params, { nonce: 'n-1' })).statusCode).toBe(200);
    expect((await post(app, path, params, { nonce: 'n-1' })).statusCode).toBe(403);
    expect(bridge.handleCarrierStatus).toHaveBeenCalledTimes(1);
    expect((await post(app, path, params, { nonce: 'n-2' })).statusCode).toBe(200);
    expect(bridge.handleCarrierStatus).toHaveBeenCalledTimes(2);
    expect(bridge.claimCallbackNonce).toHaveBeenCalledWith(CALL_ID, 'n-1');
  });

  it('an answer replayed is put down with the hangup XML, never given the stream again', async () => {
    const app = await buildApp(bridge);
    expect((await post(app, answerPath, ANSWER, { nonce: 'a-1' })).body).toContain('<Stream');
    expect((await post(app, answerPath, ANSWER, { nonce: 'a-1' })).body).toBe(PLIVO_HANGUP_XML);
    expect(bridge.answerCarrierCall).toHaveBeenCalledTimes(1);
  });

  it('a nonce is claimed only after the token and signature verify (a forgery cannot burn a real nonce)', async () => {
    const app = await buildApp(bridge);
    const path = `/webrtc-status/${CALL_ID}?token=wh&w=3`;
    const params = { CallUUID: 'uuid-1', CallStatus: 'ringing' };
    expect((await post(app, path, params, { nonce: 'n-9', signWith: 'someone-elses-token' })).statusCode).toBe(403);
    expect(bridge.claimCallbackNonce).not.toHaveBeenCalled();
    expect((await post(app, path, params, { nonce: 'n-9' })).statusCode).toBe(200);
  });

  it('a callback that failed to process gives its nonce back: the carrier`s retry of it is processed', async () => {
    bridge.handleCarrierStatus.mockRejectedValueOnce(new Error('db down'));
    const app = await buildApp(bridge);
    const path = `/webrtc-status/${CALL_ID}?token=wh&w=3`;
    const params = { CallUUID: 'uuid-1', CallStatus: 'ringing' };
    expect((await post(app, path, params, { nonce: 'r-1' })).statusCode).toBe(503);
    expect(bridge.releaseCallbackNonce).toHaveBeenCalledWith(CALL_ID, 'r-1');
    expect((await post(app, path, params, { nonce: 'r-1' })).statusCode).toBe(200);
    expect(bridge.handleCarrierStatus).toHaveBeenCalledTimes(2);
  });
});

describe('POST /plivo/webrtc-answer/:callId', () => {
  it('a live call: the answer XML with the session`s stream URL and recording, as text/xml', async () => {
    const app = await buildApp(bridge);
    const res = await post(app, answerPath, ANSWER);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/xml/);
    expect(res.body).toContain('<Stream bidirectional="true"');
    expect(res.body).toContain(STREAM.replace(/&/g, '&amp;'));
    expect(res.body).toContain('<Record recordSession="true"');
    expect(res.body).toContain('maxLength="900"');
    expect(bridge.verifyWsToken).toHaveBeenCalledWith(CALL_ID, 'wh', 'webhook');
    expect(bridge.carrierCallbackAdapter).toHaveBeenCalledWith(CALL_ID, 'plivo');
    // The bridge got the answer event, carrying Plivo's call id to backfill.
    const [id, event, provider] = bridge.answerCarrierCall.mock.calls[0]!;
    expect([id, provider]).toEqual([CALL_ID, 'plivo']);
    expect(event).toMatchObject({ eventType: 'answer', providerCallId: 'uuid-1', provider: 'plivo' });
  });

  it('a call the bridge will not bridge (unknown or tearing down): the hangup XML', async () => {
    bridge.answerCarrierCall.mockResolvedValueOnce(null);
    const app = await buildApp(bridge);
    const res = await post(app, answerPath, ANSWER);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/xml/);
    expect(res.body).toBe(PLIVO_HANGUP_XML);
  });

  it('a bad webhook token: the hangup XML, and the bridge is not asked anything else', async () => {
    bridge.verifyWsToken.mockResolvedValueOnce(false);
    const app = await buildApp(bridge);
    const res = await post(app, answerPath, ANSWER);
    expect(res.body).toBe(PLIVO_HANGUP_XML);
    expect(bridge.carrierCallbackAdapter).not.toHaveBeenCalled();
    expect(bridge.answerCarrierCall).not.toHaveBeenCalled();
  });

  it.each([
    ['signed with another token', { signWith: 'someone-elses-token' }],
    ['unsigned', { unsigned: true }],
    ['signed for another URL (the token swapped)', { signUrl: `${PLIVO_BASE}/webrtc-answer/${CALL_ID}?token=other&w=3` }],
    ['signed for the Host header`s origin', { signUrl: `http://internal-host:3021/api/v1/webhooks/plivo${answerPath}` }],
  ])('a bad signature (%s): the hangup XML, the call untouched', async (_n, opts) => {
    const app = await buildApp(bridge);
    const res = await post(app, answerPath, ANSWER, opts);
    expect(res.body).toBe(PLIVO_HANGUP_XML);
    expect(bridge.answerCarrierCall).not.toHaveBeenCalled();
  });

  it('the signature is checked over the env origin, whatever Host the request came in on', async () => {
    const app = await buildApp(bridge);
    const res = await post(app, answerPath, ANSWER, { host: 'attacker.example' });
    expect(res.body).toContain('<Stream');
  });

  it('no Plivo account to check it against (unknown call, another carrier`s, credential gone): the hangup XML', async () => {
    bridge.carrierCallbackAdapter.mockResolvedValueOnce(null);
    const app = await buildApp(bridge);
    const res = await post(app, answerPath, ANSWER);
    expect(res.body).toBe(PLIVO_HANGUP_XML);
    expect(bridge.answerCarrierCall).not.toHaveBeenCalled();
  });

  it('a malformed call id: the hangup XML, before any lookup', async () => {
    const app = await buildApp(bridge);
    const res = await post(app, '/webrtc-answer/not-a-uuid?token=wh', ANSWER);
    expect(res.body).toBe(PLIVO_HANGUP_XML);
    expect(bridge.verifyWsToken).not.toHaveBeenCalled();
  });

  it('with media workers: a callback goes to the forwarder with the public URL, its params, the token, the hint and ONLY the signature headers; its answer is Plivo`s reply', async () => {
    const forwarder = vi.fn().mockResolvedValue({ statusCode: 200, contentType: 'text/xml', body: '<Response><Stream>from-worker</Stream></Response>' });
    setPlivoCallbackForwarder(forwarder);
    const app = await buildApp(bridge);
    const res = await post(app, answerPath, ANSWER);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/xml/);
    expect(res.body).toBe('<Response><Stream>from-worker</Stream></Response>');
    expect(forwarder).toHaveBeenCalledTimes(1);
    const input = forwarder.mock.calls[0]![0];
    expect(input).toMatchObject({ kind: 'answer', callId: CALL_ID, token: 'wh', hint: '3', url: `${PLIVO_BASE}${answerPath}`, params: ANSWER });
    expect(Object.keys(input.headers).sort()).toEqual(['x-plivo-signature-v3', 'x-plivo-signature-v3-nonce']);
    // Nothing ran in this process.
    expect(bridge.verifyWsToken).not.toHaveBeenCalled();
  });

  it('with media workers: a callback the forwarder hands back (no hint) runs here, on the same signature headers', async () => {
    const forwarder = vi.fn().mockResolvedValue(null);
    setPlivoCallbackForwarder(forwarder);
    const app = await buildApp(bridge);
    const res = await post(app, `/webrtc-answer/${CALL_ID}?token=wh`, ANSWER);
    expect(forwarder.mock.calls[0]![0].hint).toBeUndefined();
    expect(res.body).toContain('<Stream');
    expect(bridge.answerCarrierCall).toHaveBeenCalledTimes(1);
  });
});

describe('POST /plivo/webrtc-status/:callId', () => {
  const statusPath = `/webrtc-status/${CALL_ID}?token=wh&w=3`;

  it('ringing reaches the bridge as a ringing event', async () => {
    const app = await buildApp(bridge);
    const res = await post(app, statusPath, { CallStatus: 'ringing', RequestUUID: 'req-1', CallUUID: 'uuid-1' });
    expect(res.statusCode).toBe(200);
    expect(bridge.handleCarrierStatus).toHaveBeenCalledWith(CALL_ID, expect.objectContaining({ eventType: 'ringing' }), 'plivo');
  });

  it('a terminal reaches the bridge with Plivo`s classification', async () => {
    const app = await buildApp(bridge);
    await post(app, statusPath, { CallStatus: 'busy', CallUUID: 'uuid-1', HangupCauseName: 'Busy Line' });
    const event = bridge.handleCarrierStatus.mock.calls[0]![1];
    expect(event).toMatchObject({ eventType: 'error', metadata: expect.objectContaining({ dispositionStatus: 'busy' }) });
  });

  it('a status Plivo does not document drives nothing, and is answered 200', async () => {
    const app = await buildApp(bridge);
    const res = await post(app, statusPath, { CallStatus: 'early-media', CallUUID: 'uuid-1' });
    expect(res.statusCode).toBe(200);
    expect(bridge.handleCarrierStatus).not.toHaveBeenCalled();
  });

  it('a bad token or a bad signature is a 403, the call untouched', async () => {
    const app = await buildApp(bridge);
    bridge.verifyWsToken.mockResolvedValueOnce(false);
    expect((await post(app, statusPath, { CallStatus: 'completed' })).statusCode).toBe(403);
    expect((await post(app, statusPath, { CallStatus: 'completed' }, { signWith: 'wrong' })).statusCode).toBe(403);
    expect(bridge.handleCarrierStatus).not.toHaveBeenCalled();
  });

  it('a bridge fault is a 503, so Plivo does not take it as processed', async () => {
    bridge.handleCarrierStatus.mockRejectedValueOnce(new Error('db down'));
    const app = await buildApp(bridge);
    expect((await post(app, statusPath, { CallStatus: 'completed', CallUUID: 'u' })).statusCode).toBe(503);
  });
});

describe('POST /plivo/webrtc-recording/:callId', () => {
  const recPath = `/webrtc-recording/${CALL_ID}?token=wh&w=3`;
  const REC = {
    RecordUrl: 'https://media.plivo.com/v1/Account/MAXX/Recording/rec-1.mp3', RecordingID: 'rec-1',
    RecordingDuration: '42', CallUUID: 'uuid-1',
  };

  it('hands the recording URL and Plivo`s call id to the bridge', async () => {
    const app = await buildApp(bridge);
    const res = await post(app, recPath, REC);
    expect(res.statusCode).toBe(200);
    expect(bridge.handleCarrierRecording).toHaveBeenCalledWith(CALL_ID, 'plivo', { recordingUrl: REC.RecordUrl, carrierCallId: 'uuid-1' });
  });

  it('a bad signature is a 403 and nothing is persisted', async () => {
    const app = await buildApp(bridge);
    expect((await post(app, recPath, REC, { unsigned: true })).statusCode).toBe(403);
    expect(bridge.handleCarrierRecording).not.toHaveBeenCalled();
  });
});

// The signature covers the URL the dial handed Plivo, byte for byte. These bases are what
// an operator may well write: a host in capitals with an explicit default port (`URL`
// would lower-case the one and drop the other), a trailing slash, and a path prefix a
// reverse proxy strips before the request reaches us. Each callback is signed over the
// URL `buildCarrierUrls` built from that base, exactly as the dial sends it.
describe('the signed URL is the one the dial handed Plivo', () => {
  const cases: Array<{ name: string; base: string; arrivesAt: (path: string) => string }> = [
    {
      name: 'a host in capitals with an explicit :443',
      base: 'https://Dialer.example.com:443/api/v1/webhooks/plivo',
      arrivesAt: (p) => p,
    },
    {
      name: 'a trailing slash on the base',
      base: 'https://dialer.example.com/api/v1/webhooks/plivo/',
      arrivesAt: (p) => p,
    },
    {
      name: 'a path prefix the reverse proxy strips (`/dialer`)',
      base: 'https://Dialer.example.com:443/dialer/api/v1/webhooks/plivo',
      arrivesAt: (p) => p.replace(/^\/dialer/, ''),
    },
  ];

  it.each(cases)('$name: answer, status and recording callbacks all verify', async ({ base, arrivesAt }) => {
    config.telephony.plivo.webhookBaseUrl = base;
    try {
      const urls = buildCarrierUrls({
        base: normalizeWebhookBase(base), callId: CALL_ID, mediaUrlInDialRequest: false,
        providerToken: 'prov', webhookToken: 'wh', routeHint: '3',
      });
      const app = await buildApp(bridge);
      const send = (handed: string, params: Record<string, string>, nonce = freshNonce()) => app.inject({
        method: 'POST',
        url: arrivesAt(handed.slice(handed.indexOf('/', 'https://'.length))),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          host: 'internal-host:3021',
          'x-plivo-signature-v3': computePlivoV3Signature(TOKEN, 'POST', handed, params, nonce),
          'x-plivo-signature-v3-nonce': nonce,
        },
        payload: querystring.stringify(params),
      });
      const answer = await send(urls.answerUrl, ANSWER);
      expect(answer.body).toContain('<Stream');
      const status = await send(urls.statusCallbackUrl, { CallStatus: 'ringing', CallUUID: 'uuid-1', RequestUUID: 'req-1' });
      expect(status.statusCode).toBe(200);
      const rec = await send(urls.recordingCallbackUrl, { RecordUrl: 'https://media.plivo.com/v1/Account/MAXX/Recording/r.mp3', CallUUID: 'uuid-1' });
      expect(rec.statusCode).toBe(200);
      expect(bridge.handleCarrierStatus).toHaveBeenCalledTimes(1);
      expect(bridge.handleCarrierRecording).toHaveBeenCalledTimes(1);
    } finally {
      config.telephony.plivo.webhookBaseUrl = PLIVO_BASE;
    }
  });

  it('a signature over the normalised origin instead (lower-cased host, no port) is refused', async () => {
    const base = 'https://Dialer.example.com:443/api/v1/webhooks/plivo';
    config.telephony.plivo.webhookBaseUrl = base;
    try {
      const app = await buildApp(bridge);
      const path = `/webrtc-status/${CALL_ID}?token=wh`;
      const res = await post(app, path, { CallStatus: 'ringing', CallUUID: 'uuid-1' }, {
        signUrl: `https://dialer.example.com/api/v1/webhooks/plivo${path}`,
      });
      expect(res.statusCode).toBe(403);
      expect(bridge.handleCarrierStatus).not.toHaveBeenCalled();
    } finally {
      config.telephony.plivo.webhookBaseUrl = PLIVO_BASE;
    }
  });

  it('no base configured: refused, the bridge not asked', async () => {
    config.telephony.plivo.webhookBaseUrl = '';
    try {
      const app = await buildApp(bridge);
      expect((await post(app, `/webrtc-status/${CALL_ID}?token=wh`, { CallStatus: 'ringing' })).statusCode).toBe(403);
      expect(bridge.verifyWsToken).not.toHaveBeenCalled();
    } finally {
      config.telephony.plivo.webhookBaseUrl = PLIVO_BASE;
    }
  });
});

describe('Plivo callbacks share the carrier webhook rate-limit bucket', () => {
  it.each(['webrtc-answer', 'webrtc-status', 'webrtc-recording'])('%s', (route) => {
    expect(budgetFor({ url: `/api/v1/webhooks/plivo/${route}/${CALL_ID}?token=x`, headers: {} })).toBe('webhook');
  });
});
