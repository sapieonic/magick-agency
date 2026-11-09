import { describe, it, expect, vi, beforeEach } from 'vitest';

// Plivo's inbound callbacks (`src/api/routes/webhooks/plivo-inbound.ts`, docs/inbound.md §3.1),
// through the real webhooks plugin (its form parser) and a REAL `PlivoAdapter` for the signature:
// each request is signed here with Plivo's V3 construction over the URL STORED on the credential
// (+ the request's query), never env's base nor the path the request arrived on, which is what is
// under test. The credential store, the router seam and the bridge are stubs.

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), isLevelEnabled: () => false }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), isLevelEnabled: () => false },
}));
vi.mock('@magick-agency/observability/metrics/agency', () => ({ trackInboundAnswer: vi.fn() }));
vi.mock('../../../../src/config/index.js', () => ({
  // Env's base is deliberately NOT the stored URL's host: a check rebuilt from env would fail.
  config: { telephony: { plivo: { webhookBaseUrl: 'https://env-host.example.com/api/v1/webhooks/plivo' }, voicelink: { webhookBaseUrl: '' } } },
}));

const { credentials } = vi.hoisted(() => ({
  credentials: {
    findInbound: vi.fn(),
    inboundTokenMatches: vi.fn(),
  },
}));
vi.mock('@magick-agency/db/repositories/telephony-credential.repository', () => ({ telephonyCredentialRepository: credentials }));

import Fastify, { type FastifyInstance } from 'fastify';
import querystring from 'node:querystring';
import { webhooksRoutes } from '../../../../src/api/routes/webhooks.routes.js';
import { DEFAULT_PLIVO_SETTINGS, PlivoAdapter, PLIVO_HANGUP_XML } from '../../../../src/telephony/plivo/plivo.adapter.js';
import { computePlivoV3Signature } from '../../../../src/telephony/plivo/plivo-signature.js';
import { Secret } from '../../../../src/telephony/credentials/secret.js';
import { hashInboundToken } from '../../../../src/telephony/plivo/inbound-token.js';
import {
  PLIVO_INBOUND_BUSY_XML, PLIVO_INBOUND_CALLBACK_XML, PLIVO_INBOUND_CLOSED_XML, PLIVO_INBOUND_FALLBACK_XML,
} from '../../../../src/telephony/plivo/plivo-inbound.webhook.js';
import { resetInboundCallRouter, setInboundCallRouter, type InboundCallRouter } from '../../../../src/seams/inbound-call-router.js';

const AUTH = 'tenant-auth-token-current';
const CRED = '6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5';
const TENANT = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'purpose-token-abc';
const STORED_ANSWER = `https://stored-host.example.com:8443/prefix/api/v1/webhooks/plivo/inbound-answer/${CRED}`;
const STORED_HANGUP = `https://stored-host.example.com:8443/prefix/api/v1/webhooks/plivo/inbound-status/${CRED}`;
const STREAM = 'wss://stored-host.example.com/api/v1/webrtc-call/leg-1/pstn-stream?token=prov';

const adapter = new PlivoAdapter({
  ...DEFAULT_PLIVO_SETTINGS,
  authId: 'MAXXXXXXXXXXXXXXXXXX',
  authToken: new Secret(AUTH),
  fetchImpl: async () => { throw new Error('no network in this test'); },
});

function makeBridge() {
  const seen = new Set<string>();
  return {
    inboundCallbackAdapter: vi.fn().mockResolvedValue(adapter),
    claimInboundCallbackNonce: vi.fn(async (credentialId: string, nonce: string): Promise<'claimed' | 'replay' | 'unavailable'> => {
      const key = `${credentialId}:${nonce}`;
      if (seen.has(key)) return 'replay';
      seen.add(key);
      return 'claimed';
    }),
    releaseInboundCallbackNonce: vi.fn(async (credentialId: string, nonce: string) => { seen.delete(`${credentialId}:${nonce}`); }),
    handleCarrierStatus: vi.fn().mockResolvedValue(undefined),
  };
}

const ARRIVAL = { CallUUID: 'cu-1', From: '919812345678', To: '14155550101', Direction: 'inbound', CallStatus: 'ringing' };
const HANGUP = { CallUUID: 'cu-1', CallStatus: 'completed', HangupSource: 'Caller', Duration: '7' };

let n = 0;
const nextNonce = () => `nonce-${++n}`;

async function post(
  app: FastifyInstance,
  kind: 'answer' | 'status',
  params: Record<string, string>,
  o: { token?: string; signedUrl?: string; nonce?: string; authToken?: string; credentialId?: string } = {},
) {
  const credentialId = o.credentialId ?? CRED;
  const query = o.token === undefined ? `?token=${TOKEN}` : o.token === '' ? '' : `?token=${o.token}`;
  const nonce = o.nonce ?? nextNonce();
  const subject = o.signedUrl ?? `${kind === 'answer' ? STORED_ANSWER : STORED_HANGUP}${query}`;
  return app.inject({
    method: 'POST',
    url: `/api/v1/webhooks/plivo/inbound-${kind}/${credentialId}${query}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-plivo-signature-v3': computePlivoV3Signature(o.authToken ?? AUTH, 'POST', subject, params, nonce),
      'x-plivo-signature-v3-nonce': nonce,
    },
    payload: querystring.stringify(params),
  });
}

describe('Plivo inbound webhooks', () => {
  let bridge: ReturnType<typeof makeBridge>;
  let app: FastifyInstance;
  let router: { answer: ReturnType<typeof vi.fn>; ended: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    resetInboundCallRouter();
    credentials.findInbound.mockResolvedValue({
      credential_id: CRED, tenant_id: TENANT, provider: 'plivo', status: 'active', app_id: 'app-1',
      answer_url: STORED_ANSWER, hangup_url: STORED_HANGUP, fallback_answer_url: 'https://x/f',
      enabled_at: new Date(), previous_token_expires_at: null, linked_numbers: 1,
    });
    credentials.inboundTokenMatches.mockImplementation(async (_id: string, hash: string) => hash === hashInboundToken(TOKEN));
    router = {
      answer: vi.fn().mockResolvedValue({ kind: 'stream', callId: 'leg-1', streamUrl: STREAM, maxDurationSeconds: 1800 }),
      ended: vi.fn().mockResolvedValue({ legId: 'leg-1' }),
    };
    setInboundCallRouter(router as unknown as InboundCallRouter);
    bridge = makeBridge();
    app = Fastify();
    await app.register(webhooksRoutes, { prefix: '/api/v1/webhooks', webrtcBridge: bridge as never });
    await app.ready();
  });

  describe('answer', () => {
    it('a verified arriving call is handed to the router and answered with our stream', async () => {
      const res = await post(app, 'answer', ARRIVAL);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/xml/);
      expect(res.body).toContain('<Stream bidirectional="true"');
      expect(res.body).toContain('keepCallAlive="true"');
      expect(res.body).toContain(STREAM.replace(/&/g, '&amp;'));
      expect(res.body).toContain('streamTimeout="1800"');
      expect(res.body).not.toContain('<Record');
      expect(router.answer).toHaveBeenCalledWith({
        credentialId: CRED, tenantId: TENANT, provider: 'plivo', credentialStatus: 'active',
        carrierCallId: 'cu-1', fromE164: '+919812345678', toE164: '+14155550101',
      }, { signal: expect.any(AbortSignal) });
      expect(bridge.inboundCallbackAdapter).toHaveBeenCalledWith(CRED, TENANT, 'plivo');
    });

    it('verifies over the STORED url (+ the query), never env\'s base or the path it arrived on', async () => {
      const envSigned = `https://env-host.example.com/api/v1/webhooks/plivo/inbound-answer/${CRED}?token=${TOKEN}`;
      const res = await post(app, 'answer', ARRIVAL, { signedUrl: envSigned });
      expect(res.body).toBe(PLIVO_HANGUP_XML);
      expect(router.answer).not.toHaveBeenCalled();
      // The stored URL WITHOUT the query is not the subject either.
      expect((await post(app, 'answer', ARRIVAL, { signedUrl: STORED_ANSWER })).body).toBe(PLIVO_HANGUP_XML);
    });

    it('a signature by another account\'s token, a wrong or missing purpose token, an unknown credential: hangup, nothing routed', async () => {
      expect((await post(app, 'answer', ARRIVAL, { authToken: 'another-accounts-token' })).body).toBe(PLIVO_HANGUP_XML);
      expect((await post(app, 'answer', ARRIVAL, { token: 'wrong' })).body).toBe(PLIVO_HANGUP_XML);
      expect((await post(app, 'answer', ARRIVAL, { token: '' })).body).toBe(PLIVO_HANGUP_XML);
      expect((await post(app, 'answer', ARRIVAL, { credentialId: 'not-a-uuid' })).body).toBe(PLIVO_HANGUP_XML);
      credentials.findInbound.mockResolvedValueOnce(null);
      expect((await post(app, 'answer', ARRIVAL)).body).toBe(PLIVO_HANGUP_XML);
      credentials.findInbound.mockResolvedValueOnce({ credential_id: CRED, tenant_id: TENANT, provider: 'plivo', status: 'active', answer_url: null, hangup_url: null });
      expect((await post(app, 'answer', ARRIVAL)).body).toBe(PLIVO_HANGUP_XML);
      bridge.inboundCallbackAdapter.mockResolvedValueOnce(null);
      expect((await post(app, 'answer', ARRIVAL)).body).toBe(PLIVO_HANGUP_XML);
      expect(router.answer).not.toHaveBeenCalled();
    });

    it('a replayed callback (same nonce) is refused; the first is answered', async () => {
      expect((await post(app, 'answer', ARRIVAL, { nonce: 'replayed' })).body).toContain('<Stream');
      expect((await post(app, 'answer', ARRIVAL, { nonce: 'replayed' })).body).toBe(PLIVO_HANGUP_XML);
      expect(router.answer).toHaveBeenCalledTimes(1);
    });

    it('the replay guard cannot be asked (Redis down): 503, so Plivo answers from the fallback URL; nothing routed (QA-F11)', async () => {
      bridge.claimInboundCallbackNonce.mockResolvedValueOnce('unavailable');
      const res = await post(app, 'answer', ARRIVAL, { nonce: 'redis-down' });
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('<Stream');
      expect(router.answer).not.toHaveBeenCalled();
      // Nothing was claimed, so nothing is given back; the carrier's retry is checked afresh.
      expect(bridge.releaseInboundCallbackNonce).not.toHaveBeenCalled();
      expect((await post(app, 'answer', ARRIVAL, { nonce: 'redis-down' })).body).toContain('<Stream');
    });

    it('an answer that is not an arriving call (an outbound one, no To) is hung up', async () => {
      expect((await post(app, 'answer', { ...ARRIVAL, Direction: 'outbound' })).body).toBe(PLIVO_HANGUP_XML);
      expect((await post(app, 'answer', { ...ARRIVAL, To: 'anonymous' })).body).toBe(PLIVO_HANGUP_XML);
      expect(router.answer).not.toHaveBeenCalled();
    });

    it('a withheld caller is routed with no number', async () => {
      await post(app, 'answer', { ...ARRIVAL, From: 'anonymous' });
      expect(router.answer).toHaveBeenCalledWith(expect.objectContaining({ fromE164: null }), expect.anything());
    });

    it('renders each decision: the three spoken messages, hangup, fallback', async () => {
      router.answer.mockResolvedValueOnce({ kind: 'spoken', message: 'closed' });
      expect((await post(app, 'answer', ARRIVAL)).body).toBe(PLIVO_INBOUND_CLOSED_XML);
      router.answer.mockResolvedValueOnce({ kind: 'spoken', message: 'callback' });
      expect((await post(app, 'answer', ARRIVAL)).body).toBe(PLIVO_INBOUND_CALLBACK_XML);
      router.answer.mockResolvedValueOnce({ kind: 'spoken', message: 'busy' });
      expect((await post(app, 'answer', ARRIVAL)).body).toBe(PLIVO_INBOUND_BUSY_XML);
      router.answer.mockResolvedValueOnce({ kind: 'hangup' });
      expect((await post(app, 'answer', ARRIVAL)).body).toBe(PLIVO_HANGUP_XML);
      router.answer.mockResolvedValueOnce({ kind: 'fallback' });
      expect((await post(app, 'answer', ARRIVAL)).body).toBe(PLIVO_INBOUND_FALLBACK_XML);
    });

    it('passes a disabled credential\'s status on (it still verifies, §10)', async () => {
      credentials.findInbound.mockResolvedValueOnce({
        credential_id: CRED, tenant_id: TENANT, provider: 'plivo', status: 'disabled', answer_url: STORED_ANSWER, hangup_url: STORED_HANGUP,
      });
      await post(app, 'answer', ARRIVAL);
      expect(router.answer).toHaveBeenCalledWith(expect.objectContaining({ credentialStatus: 'disabled' }), expect.anything());
    });

    it('a router fault is the fallback message, and the nonce is given back for the carrier\'s retry', async () => {
      router.answer.mockRejectedValueOnce(new Error('pool gone'));
      const first = await post(app, 'answer', ARRIVAL, { nonce: 'retry-me' });
      expect(first.body).toBe(PLIVO_INBOUND_FALLBACK_XML);
      expect(bridge.releaseInboundCallbackNonce).toHaveBeenCalledWith(CRED, 'retry-me');
      expect((await post(app, 'answer', ARRIVAL, { nonce: 'retry-me' })).body).toContain('<Stream');
    });

    it('past its budget the caller hears the fallback message, and the router is told (its signal aborts)', async () => {
      const slow = Fastify();
      const { registerPlivoInboundWebhookRoutes } = await import('../../../../src/api/routes/webhooks/plivo-inbound.js');
      await slow.register(async (scope) => {
        scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) => done(null, querystring.parse(body as string)));
        registerPlivoInboundWebhookRoutes(scope, { webrtcBridge: bridge as never, budgetMs: 20 });
      }, { prefix: '/api/v1/webhooks' });
      let signal: AbortSignal | undefined;
      router.answer.mockImplementationOnce((_arrival, opts) => {
        signal = opts?.signal;
        expect(signal?.aborted).toBe(false);
        return new Promise((resolve) => setTimeout(() => resolve({ kind: 'hangup' }), 200));
      });
      expect((await post(slow, 'answer', ARRIVAL)).body).toBe(PLIVO_INBOUND_FALLBACK_XML);
      expect(signal?.aborted).toBe(true);
      await slow.close();
    });

    it('an answer inside its budget never aborts the router\'s signal', async () => {
      let signal: AbortSignal | undefined;
      router.answer.mockImplementationOnce(async (_arrival, opts) => {
        signal = opts?.signal;
        return { kind: 'hangup' };
      });
      await post(app, 'answer', ARRIVAL);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    });

    it('with no router registered (agency not started), the fallback message', async () => {
      resetInboundCallRouter();
      expect((await post(app, 'answer', ARRIVAL)).body).toBe(PLIVO_INBOUND_FALLBACK_XML);
    });
  });

  describe('status (hangup)', () => {
    it('a verified hangup goes to the router first, then the bridge is told the carrier ended the leg', async () => {
      const res = await post(app, 'status', HANGUP);
      expect(res.statusCode).toBe(200);
      expect(router.ended).toHaveBeenCalledWith({
        credentialId: CRED, tenantId: TENANT, provider: 'plivo', carrierCallId: 'cu-1', callStatus: 'completed', hangupSource: 'Caller',
      });
      expect(bridge.handleCarrierStatus).toHaveBeenCalledWith('leg-1', expect.objectContaining({ eventType: 'hangup', callId: 'leg-1', providerCallId: 'cu-1' }), 'plivo');
      expect(router.ended.mock.invocationCallOrder[0]!).toBeLessThan(bridge.handleCarrierStatus.mock.invocationCallOrder[0]!);
    });

    it('signed over the stored HANGUP url; the answer url does not verify it', async () => {
      const res = await post(app, 'status', HANGUP, { signedUrl: `${STORED_ANSWER}?token=${TOKEN}` });
      expect(res.statusCode).toBe(403);
      expect(router.ended).not.toHaveBeenCalled();
    });

    it('a call with no leg tells the bridge nothing; a non-terminal status is acknowledged and ignored', async () => {
      router.ended.mockResolvedValueOnce({ legId: null });
      expect((await post(app, 'status', HANGUP)).statusCode).toBe(200);
      expect(bridge.handleCarrierStatus).not.toHaveBeenCalled();
      expect((await post(app, 'status', { CallUUID: 'cu-1', CallStatus: 'in-progress' })).statusCode).toBe(200);
      expect(router.ended).toHaveBeenCalledTimes(1);
    });

    it('a replay is 403; a fault is 503 with the nonce given back', async () => {
      await post(app, 'status', HANGUP, { nonce: 'h-1' });
      expect((await post(app, 'status', HANGUP, { nonce: 'h-1' })).statusCode).toBe(403);
      router.ended.mockRejectedValueOnce(new Error('db down'));
      expect((await post(app, 'status', HANGUP, { nonce: 'h-2' })).statusCode).toBe(503);
      expect(bridge.releaseInboundCallbackNonce).toHaveBeenCalledWith(CRED, 'h-2');
    });

    it('the replay guard cannot be asked (Redis down): 503 (the carrier retries), the router never told (QA-F11)', async () => {
      bridge.claimInboundCallbackNonce.mockResolvedValueOnce('unavailable');
      expect((await post(app, 'status', HANGUP, { nonce: 'h-3' })).statusCode).toBe(503);
      expect(router.ended).not.toHaveBeenCalled();
      expect(bridge.handleCarrierStatus).not.toHaveBeenCalled();
    });
  });

  it('the fallback answer URL is fixed XML for anyone: no token, no signature, no read', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/webhooks/plivo/inbound-fallback', payload: '' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.body).toBe(PLIVO_INBOUND_FALLBACK_XML);
    expect(credentials.findInbound).not.toHaveBeenCalled();
    expect(router.answer).not.toHaveBeenCalled();
  });
});
