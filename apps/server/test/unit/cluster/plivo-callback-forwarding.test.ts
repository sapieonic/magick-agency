import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import querystring from 'node:querystring';
import { MediaCluster } from '../../../src/cluster/media-cluster.js';
import { IPC_REQUEST_DECODERS } from '../../../src/cluster/ipc-protocol.js';
import { config } from '../../../src/config/index.js';
import { webhooksRoutes, setPlivoCallbackForwarder } from '../../../src/api/routes/webhooks.routes.js';
import { handlePlivoCallback } from '../../../src/api/routes/webhooks/plivo.js';
import { DEFAULT_PLIVO_SETTINGS, PlivoAdapter, PLIVO_HANGUP_XML } from '../../../src/telephony/plivo/plivo.adapter.js';
import { computePlivoV3Signature } from '../../../src/telephony/plivo/plivo-signature.js';
import { Secret } from '../../../src/telephony/credentials/secret.js';
import { EMPTY_SNAPSHOT, FakeChildProcess } from '../../helpers/fake-child-process.js';

/*
 * Plivo's callbacks with media workers (`docs/scaling.md` §3.2): the REAL webhook route in
 * the primary, the REAL MediaCluster forwarder, the IPC request through the real decoders
 * on both sides (the fake worker decodes the body as its channel would), and in the
 * "worker" the REAL `handlePlivoCallback` with a real `PlivoAdapter` checking the V3
 * signature. So what is under test is that the signature still verifies after the hop:
 * the public URL, the params and the two signature headers arrive exactly as Plivo sent
 * them. Each bridge is a stub (the worker's holds the call; the primary's holds none).
 */

const PLIVO_BASE = 'https://agency.example.com/api/v1/webhooks/plivo';
const TOKEN = 'plivo-auth-token-current';
const CALL_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const STREAM = `wss://agency.example.com/api/v1/webrtc-call/${CALL_ID}/pstn-stream?token=prov&w=1`;

const adapter = new PlivoAdapter({
  ...DEFAULT_PLIVO_SETTINGS,
  webhookBaseUrl: PLIVO_BASE,
  authId: 'MAXXXXXXXXXXXXXXXXXX',
  authToken: new Secret(TOKEN),
  fetchImpl: async () => { throw new Error('no network in this test'); },
});

function makeBridge(live: boolean) {
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
    answerCarrierCall: vi.fn().mockResolvedValue(live ? { streamUrl: STREAM, enableRecording: false, recordingCallbackUrl: null, maxDurationSeconds: 600 } : null),
    handleCarrierStatus: vi.fn().mockResolvedValue(undefined),
    handleCarrierRecording: vi.fn().mockResolvedValue(undefined),
  };
}

let workerBridge: ReturnType<typeof makeBridge>;
let primaryBridge: ReturnType<typeof makeBridge>;
let forks: FakeChildProcess[];
let cluster: MediaCluster | null = null;
let app: FastifyInstance | null = null;
const savedBase = config.telephony.plivo.webhookBaseUrl;

/** The worker side of `carrier.plivo_callback`: decode as the child's channel does, then the real handler. */
function workerHandler(body: unknown): Promise<unknown> {
  const decoded = IPC_REQUEST_DECODERS['carrier.plivo_callback'].req(JSON.parse(JSON.stringify(body)));
  if (!decoded) throw new Error('malformed');
  const { token, ...input } = decoded;
  return handlePlivoCallback(workerBridge as never, { ...input, token: token ?? undefined });
}

beforeEach(async () => {
  config.telephony.plivo.webhookBaseUrl = PLIVO_BASE;
  workerBridge = makeBridge(true);
  primaryBridge = makeBridge(false);
  forks = [];
  cluster = new MediaCluster({
    count: 2,
    fork: (slot) => {
      const child = new FakeChildProcess('media', slot);
      child.handlers.set('reaper.snapshot', () => EMPTY_SNAPSHOT);
      child.handlers.set('carrier.plivo_callback', workerHandler);
      forks.push(child);
      setImmediate(() => child.ready());
      return child.asChild();
    },
    readOwner: async () => null,
    setAgentOffline: async () => {},
    readyTimeoutMs: 2_000,
  });
  await cluster.start();
  setPlivoCallbackForwarder(cluster.plivoCallbackForwarder);
  app = Fastify({ logger: false });
  await app.register(async (i) => { await webhooksRoutes(i, { webrtcBridge: primaryBridge as never }); }, { prefix: '/api/v1/webhooks' });
  await app.ready();
});

afterEach(async () => {
  setPlivoCallbackForwarder(null);
  config.telephony.plivo.webhookBaseUrl = savedBase;
  await app?.close();
  await cluster?.stop(1_000);
  app = null;
  cluster = null;
});

/** POST as Plivo does: form params, signed (V3) for the public URL with `signWith`. */
function post(path: string, params: Record<string, string>, signWith = TOKEN) {
  const nonce = '12345678901234567890';
  return app!.inject({
    method: 'POST',
    url: `/api/v1/webhooks/plivo${path}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      host: 'internal-host:3021',
      cookie: 'not-forwarded=1',
      'x-plivo-signature-v3': computePlivoV3Signature(signWith, 'POST', `${PLIVO_BASE}${path}`, params, nonce),
      'x-plivo-signature-v3-nonce': nonce,
    },
    payload: querystring.stringify(params),
  });
}

const ANSWER = { CallUUID: 'uuid-1', RequestUUID: 'req-1', CallStatus: 'in-progress', From: '14155550100', To: '14155550199', Direction: 'outbound' };
const RINGING = { CallUUID: 'uuid-1', RequestUUID: 'req-1', CallStatus: 'ringing' };

describe('Plivo callbacks forwarded to the media worker their `w` names', () => {
  it('the answer callback runs in that worker: its signature verifies there, and its answer XML is Plivo`s reply', async () => {
    const res = await post(`/webrtc-answer/${CALL_ID}?token=wh&w=1`, ANSWER);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/xml/);
    expect(res.body).toContain('<Stream bidirectional="true"');
    expect(res.body).toContain(STREAM.replace(/&/g, '&amp;'));
    expect(forks[1]!.requests('carrier.plivo_callback')).toHaveLength(1);
    expect(forks[0]!.requests('carrier.plivo_callback')).toHaveLength(0);
    // Only the signature headers crossed, never the cookie or host.
    const sent = forks[1]!.requests('carrier.plivo_callback')[0]!.body as { headers: Record<string, string> };
    expect(Object.keys(sent.headers).sort()).toEqual(['x-plivo-signature-v3', 'x-plivo-signature-v3-nonce']);
    expect(workerBridge.answerCarrierCall).toHaveBeenCalledTimes(1);
    expect(primaryBridge.verifyWsToken).not.toHaveBeenCalled();
  });

  it('a forwarded callback with a bad signature is refused in the worker: the hangup XML, the call untouched', async () => {
    const res = await post(`/webrtc-answer/${CALL_ID}?token=wh&w=1`, ANSWER, 'someone-elses-token');
    expect(res.body).toBe(PLIVO_HANGUP_XML);
    expect(forks[1]!.requests('carrier.plivo_callback')).toHaveLength(1);
    expect(workerBridge.answerCarrierCall).not.toHaveBeenCalled();
  });

  it('a status callback runs in its worker and answers 200 JSON', async () => {
    const res = await post(`/webrtc-status/${CALL_ID}?token=wh&w=0`, RINGING);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: true });
    expect(workerBridge.handleCarrierStatus).toHaveBeenCalledWith(CALL_ID, expect.objectContaining({ eventType: 'ringing' }), 'plivo');
    expect(forks[0]!.requests('carrier.plivo_callback')).toHaveLength(1);
  });

  it('no hint: runs in the primary (its session-less bridge)', async () => {
    const res = await post(`/webrtc-status/${CALL_ID}?token=wh`, RINGING);
    expect(res.statusCode).toBe(200);
    expect(primaryBridge.handleCarrierStatus).toHaveBeenCalledTimes(1);
    expect(forks.every((f) => f.requests('carrier.plivo_callback').length === 0)).toBe(true);
  });

  it('the worker gone: the answer callback is hung up at once; a status runs in the primary (the late path)', async () => {
    forks[1]!.exit(1, null);
    await new Promise((r) => setImmediate(r));
    const answer = await post(`/webrtc-answer/${CALL_ID}?token=wh&w=1`, ANSWER);
    expect(answer.body).toBe(PLIVO_HANGUP_XML);
    expect(primaryBridge.answerCarrierCall).not.toHaveBeenCalled();
    const status = await post(`/webrtc-status/${CALL_ID}?token=wh&w=1`, RINGING);
    expect(status.statusCode).toBe(200);
    expect(primaryBridge.handleCarrierStatus).toHaveBeenCalledTimes(1);
  });

  it('a forwarded callback the worker fails: the answer is hung up, a status is 503 (never a 200 for a post not processed)', async () => {
    for (const f of forks) f.handlers.set('carrier.plivo_callback', () => Promise.reject(new Error('boom')));
    const answer = await post(`/webrtc-answer/${CALL_ID}?token=wh&w=1`, ANSWER);
    expect(answer.body).toBe(PLIVO_HANGUP_XML);
    const status = await post(`/webrtc-status/${CALL_ID}?token=wh&w=1`, RINGING);
    expect(status.statusCode).toBe(503);
    expect(primaryBridge.handleCarrierStatus).not.toHaveBeenCalled();
  });
});
