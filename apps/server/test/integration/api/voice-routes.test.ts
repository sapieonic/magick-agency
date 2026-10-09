import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The voice plugin end to end through the real app
 * (`buildApp` with a real context: Postgres 5436, Redis 6383 test db). Route-level
 * tests elsewhere mock the bridge; these drive the real bridge and its real Redis ws-token store,
 * with only the carrier faked. They pin that the two unauthenticated carrier surfaces keep
 * their token checks exactly:
 *   - `POST /api/v1/webhooks/voicelink/webrtc-status/:callId?token=` — the purpose-bound
 *     WEBHOOK token (403 on a wrong one; a right one drives the bridge);
 *   - `GET  /api/v1/webrtc-call/:id/pstn-stream?token=` (WebSocket) — the purpose-bound
 *     PROVIDER token (a wrong one is closed; the right one becomes the PSTN leg).
 * The tokens are the ones the bridge minted into the dial request, read back from the
 * URLs it handed the carrier.
 */

vi.hoisted(() => {
  process.env['VOICELINK_WEBHOOK_BASE_URL'] = 'https://agency.test/api/v1/webhooks/voicelink';
});

const { fakeAdapter } = vi.hoisted(() => ({
  fakeAdapter: {
    name: 'voicelink',
    capabilities: { cancelRinging: false, queuesOutboundDials: true },
    initiateCall: vi.fn(async (req: { callId: string }) => ({ providerCallId: req.callId })),
    endCall: vi.fn(async () => undefined),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() { return fakeAdapter; }
  },
}));

import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { uuidFor } from '../../../../../packages/db/test/integration/setup/factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import { getVoiceEngine, resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';

const TENANT = uuidFor('voice-routes-tenant');
const ACCOUNT = uuidFor('voice-routes-account');
const CAMPAIGN = uuidFor('voice-routes-campaign');

let app: FastifyInstance;

function stationWs() {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  return {
    readyState: 1, OPEN: 1, sent: [] as any[],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    on(ev: string, cb: (...a: any[]) => void) { (handlers[ev] ||= []).push(cb); },
    off(ev: string, cb: (...a: any[]) => void) {
      const l = handlers[ev]; if (!l) return; const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1);
    },
    emit(ev: string, ...a: any[]) { (handlers[ev] || []).slice().forEach((cb) => cb(...a)); },
    close() { this.readyState = 3; },
  };
}

/** Open a real WebSocket to the listening app (`app.ts` registers @fastify/websocket). */
async function connect(pathAndQuery: string): Promise<WebSocket> {
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathAndQuery}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  return ws;
}

/** Dial a call and return its id plus the two carrier tokens from the dial request. */
async function dial() {
  const bridge = getVoiceEngine()!.bridge;
  const record = await bridge.createBridgedCall({
    tenantId: TENANT, accountId: ACCOUNT,
    callerId: '+919800000001', destinationPhone: '+919800000002',
    browserSocket: stationWs() as any,
    campaignId: CAMPAIGN, agencyAttemptId: uuidFor(`attempt-${Math.random()}`),
  });
  const req = fakeAdapter.initiateCall.mock.calls.at(-1)![0] as unknown as { statusCallbackUrl: string; mediaStreamUrl: string };
  const webhookToken = new URL(req.statusCallbackUrl).searchParams.get('token')!;
  const providerToken = new URL(req.mediaStreamUrl).searchParams.get('token')!;
  return { callId: record.id, webhookToken, providerToken };
}

describe('voice plugin routes against the real bridge (integration)', () => {
  beforeAll(async () => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
    await getTestPool().query(
      `INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls) VALUES ($1, $2, 5)`,
      [TENANT, ACCOUNT],
    );
    if (app) await app.close();
    resetVoiceEngineForTests();
    app = await buildApp({ ctx: { config, pool: getPool(), redis: getTestRedis() } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    fakeAdapter.initiateCall.mockClear();
  });

  afterAll(async () => {
    await getVoiceEngine()?.bridge.gracefulShutdown();
    await getVoiceEngine()?.guardHost.gracefulShutdown();
    await app?.close();
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  it('the dial request carries purpose-bound tokens that are stored in Redis', async () => {
    const { callId, webhookToken, providerToken } = await dial();
    expect(webhookToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(providerToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(webhookToken).not.toBe(providerToken);
    await expect(getTestRedis().get(`webrtc:ws-token:webhook:${callId}`)).resolves.toBe(webhookToken);
    await expect(getTestRedis().get(`webrtc:ws-token:provider:${callId}`)).resolves.toBe(providerToken);
    // A borrowed (agency) leg mints no browser token.
    await expect(getTestRedis().get(`webrtc:ws-token:browser:${callId}`)).resolves.toBeNull();
  });

  it('webrtc-status: a wrong webhook token is refused 403 and drives nothing', async () => {
    const { callId } = await dial();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/voicelink/webrtc-status/${callId}?token=forged`,
      payload: { event: 'call.ringing', call: { id: 'c-1' } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: false });
    expect(getVoiceEngine()!.bridge.getSession(callId)!.status).toBe('initiating');
  });

  it('webrtc-status: a missing token is refused 403 while the call is live', async () => {
    const { callId } = await dial();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/voicelink/webrtc-status/${callId}`,
      payload: { event: 'call.ringing', call: { id: 'c-1' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('webrtc-status: the right token drives the bridge (ringing, then a terminal no-answer)', async () => {
    const { callId, webhookToken } = await dial();
    const url = `/api/v1/webhooks/voicelink/webrtc-status/${callId}?token=${webhookToken}`;

    const ringing = await app.inject({ method: 'POST', url, payload: { event: 'call.ringing', call: { id: 'c-1' } } });
    expect(ringing.statusCode).toBe(200);
    expect(ringing.json()).toEqual({ status: true });
    expect(getVoiceEngine()!.bridge.getSession(callId)!.status).toBe('ringing');

    const ended = await app.inject({
      method: 'POST', url,
      payload: { event: 'call.completed', call: { id: 'c-1', callStatus: 'NO ANSWER' } },
    });
    expect(ended.statusCode).toBe(200);
    expect(getVoiceEngine()!.bridge.getSession(callId)).toBeUndefined();
    const { rows } = await getTestPool().query('SELECT status FROM agency_calls WHERE id = $1', [callId]);
    expect(rows[0]!.status).toBe('no_answer');
    // decision Q6: the media legs' tokens are cleared at teardown; the WEBHOOK
    // token is kept for the post-end grace (2h) so VoiceLink's late terminal post — the one
    // carrying the recording URL — still verifies, now that a missing key is refused.
    await expect(getTestRedis().get(`webrtc:ws-token:provider:${callId}`)).resolves.toBeNull();
    await expect(getTestRedis().get(`webrtc:ws-token:webhook:${callId}`)).resolves.toBe(webhookToken);
    const ttl = await getTestRedis().ttl(`webrtc:ws-token:webhook:${callId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2 * 60 * 60);
    const late = await app.inject({ method: 'POST', url, payload: { event: 'call.completed', call: { id: 'c-1', callStatus: 'NO ANSWER' } } });
    expect(late.statusCode).toBe(200);
    const forged = await app.inject({
      method: 'POST', url: `/api/v1/webhooks/voicelink/webrtc-status/${callId}?token=forged`,
      payload: { event: 'call.completed', call: { id: 'c-1' } },
    });
    expect(forged.statusCode).toBe(403);
  });

  it('webrtc-status: an informational event (call.initiated) is acknowledged and ignored', async () => {
    const { callId, webhookToken } = await dial();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/voicelink/webrtc-status/${callId}?token=${webhookToken}`,
      payload: { event: 'call.initiated', call: { id: 'c-1' } },
    });
    expect(res.statusCode).toBe(200);
    expect(getVoiceEngine()!.bridge.getSession(callId)!.status).toBe('initiating');
  });

  it('pstn-stream: the right provider token becomes the PSTN leg', async () => {
    const { callId, providerToken } = await dial();
    const ws = await connect(`/api/v1/webrtc-call/${callId}/pstn-stream?token=${providerToken}`);
    await vi.waitFor(() => expect(getVoiceEngine()!.bridge.getSession(callId)!.pstnWs).not.toBeNull());
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.terminate();
  });

  it('pstn-stream: a wrong provider token is closed and never attached', async () => {
    const { callId } = await dial();
    const ws = await connect(`/api/v1/webrtc-call/${callId}/pstn-stream?token=forged`);
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else ws.once('close', () => resolve());
    });
    expect(getVoiceEngine()!.bridge.getSession(callId)!.pstnWs).toBeNull();
  });
});
