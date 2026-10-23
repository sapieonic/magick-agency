import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The mock VoiceLink carrier's own contract (`test/mocks/voicelink`), against a bare
 * `node:http` + `ws` server — no product code in the loop except the codec. The load
 * suites trust the mock to dial the URL it was given, carry the token, speak the frame
 * shapes `voicelink.media.ts` parses, record closes truthfully, and apply faults exactly
 * as injected; a mock that silently did less would make every one of them vacuous.
 *
 * The audio check runs the mock's frames through the product's `VoicelinkTranscoder` in
 * both directions, which is what makes `audio-pattern.ts`'s loud/quiet classification a
 * valid order-and-loss check in the integration suites.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { VoicelinkTranscoder } from '../../../src/utils/audio-fir.js';
import { voicelinkMedia } from '../../../src/telephony/voicelink/voicelink.media.js';
import {
  MockVoicelinkCarrier, bits, carrierScripts, isLoudAlaw, isLoudPcm16, pcm16kFrame, postRaw,
} from '../../mocks/voicelink/index.js';
import { createRng, LOAD_SEED } from '../../helpers/load-scale.js';

interface Received { path: string; frames: unknown[]; socket: WebSocket }

let server: http.Server;
let wss: WebSocketServer;
let origin: string;
const connections: Received[] = [];
const webhookPosts: Array<{ path: string; body: unknown }> = [];
let carrier: MockVoicelinkCarrier;
const rng = createRng(LOAD_SEED);

async function login(): Promise<string> {
  const res = await fetch(`${carrier.baseUrl}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: carrier.username, password: carrier.password }),
  });
  return ((await res.json()) as { data: { access_token: string } }).data.access_token;
}

async function addLead(token: string | null, overrides: Record<string, string> = {}): Promise<Response> {
  return fetch(`${carrier.baseUrl}/v1/add_lead`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      did_number: '919800000001', customer_number: '9812345678', country_code: '91',
      websocket_url: 'wss://agency.test/api/v1/webrtc-call/call-1/pstn-stream?token=tok-1',
      webhook_url: 'https://agency.test/api/v1/webhooks/voicelink/webrtc-status/call-1?token=wh-1',
      ...overrides,
    }),
  });
}

describe(`mock VoiceLink carrier (seed ${LOAD_SEED})`, () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        webhookPosts.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
        res.writeHead(req.url?.includes('token=wh-1') ? 200 : 403).end('{}');
      });
    });
    wss = new WebSocketServer({ server });
    wss.on('connection', (socket, req) => {
      const rec: Received = { path: req.url ?? '', frames: [], socket };
      connections.push(rec);
      socket.on('message', (d) => rec.frames.push(JSON.parse(d.toString())));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    carrier = new MockVoicelinkCarrier({ targetOrigin: () => origin });
    await carrier.start();
  });

  beforeEach(() => {
    carrier.reset();
    carrier.setScript(undefined);
    connections.length = 0;
    webhookPosts.length = 0;
  });

  afterAll(async () => {
    await carrier.stop();
    for (const c of wss.clients) c.terminate();
    wss.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('rewrites the public wss/https origin to the server under test, keeping path and token', () => {
    expect(carrier.rewrite('wss://agency.test/api/v1/webrtc-call/x/pstn-stream?token=abc'))
      .toBe(`${origin.replace('http', 'ws')}/api/v1/webrtc-call/x/pstn-stream?token=abc`);
    expect(carrier.rewrite('https://agency.test/api/v1/webhooks/voicelink/webrtc-status/x?token=t'))
      .toBe(`${origin}/api/v1/webhooks/voicelink/webrtc-status/x?token=t`);
  });

  it('authenticates like VoiceLink: bad credentials 401, no bearer 401, a revoked bearer 401, a bad split 422', async () => {
    const bad = await fetch(`${carrier.baseUrl}/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'x', password: 'y' }),
    });
    expect(bad.status).toBe(401);
    expect((await addLead(null)).status).toBe(401);
    const token = await login();
    expect((await addLead(token)).status).toBe(200);
    expect((await addLead(token, { customer_number: '09812345678' })).status).toBe(422);
    expect((await addLead(token, { customer_number: '+919812345678' })).status).toBe(422);
    carrier.revokeTokens();
    expect((await addLead(token)).status).toBe(401);
    expect(carrier.requestsTo('add_lead').map((r) => r.status)).toEqual([401, 200, 422, 422, 401]);
  });

  it('applies faults in order, each for exactly its count, then answers normally', async () => {
    const token = await login();
    carrier.injectFault('add_lead', { kind: 'status', status: 503 }, 2);
    carrier.injectFault('add_lead', { kind: 'status', status: 429 });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await addLead(token)).status);
    expect(statuses).toEqual([503, 503, 429, 200]);
    carrier.injectFault('add_lead', { kind: 'reset' });
    await expect(addLead(token)).rejects.toThrow();
    carrier.injectFault('add_lead', { kind: 'malformed' });
    const malformed = await addLead(token);
    expect(malformed.status).toBe(200);
    await expect(malformed.json()).rejects.toThrow();
  });

  it('places the call: dials the rewritten URL with the token, sends a VoiceLink start the product accepts, and paced A-law that survives the real codec in order', async () => {
    const pattern = carrierScripts.framePattern(rng, 30);
    carrier.setScript(() => ({
      name: 'self-test',
      steps: [
        { do: 'webhook', spec: carrierScripts.webhooks.ringing() },
        { do: 'connect' },
        { do: 'start' },
        { do: 'media', pattern, frameMs: 2 },
        { do: 'waitFor', until: (c) => c.mediaReceived.length >= 10 },
        { do: 'webhook', spec: { event: 'call.ringing', token: 'missing' } },
        { do: 'close', code: 1000 },
      ],
    }));
    const token = await login();
    expect((await addLead(token)).status).toBe(200);
    // The far side answers with 10 frames of transcoded agent audio.
    const agentPattern = carrierScripts.framePattern(rng, 10);
    const toCarrier = new VoicelinkTranscoder();
    const deadline = Date.now() + 10_000;
    while ((connections[0]?.frames.length ?? 0) < pattern.length + 1) {
      if (Date.now() > deadline) throw new Error('frames never arrived');
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const [k, loud] of agentPattern.entries()) {
      const alaw = toCarrier.pcm16kToAlaw(pcm16kFrame(k, loud));
      connections[0]!.socket.send(JSON.stringify(voicelinkMedia.frameOutbound(alaw.toString('base64'), null)));
    }
    await carrier.settled();
    const call = carrier.callOrder[0]!;

    expect(call.errors).toEqual([]);
    expect(connections[0]!.path).toBe('/api/v1/webrtc-call/call-1/pstn-stream?token=tok-1');
    expect(call.callId).toBe('call-1');
    const [start, ...media] = connections[0]!.frames as Array<Record<string, any>>;
    // The product's own parser accepts it and reads the carrier's ids.
    expect(voicelinkMedia.parseStart(start)).toEqual({ ok: true, carrierCallId: call.carrierCallId, streamId: call.streamSid });
    const fromCarrier = new VoicelinkTranscoder();
    const heard = media.map((f) => isLoudPcm16(fromCarrier.alawToPcm16k(Buffer.from(f.media.payload, 'base64'))));
    expect(bits(heard)).toBe(bits(pattern));
    expect(bits(call.mediaReceived.slice(0, 10).map(isLoudAlaw))).toBe(bits(agentPattern));
    expect(call.close).toMatchObject({ by: 'carrier', code: 1000, abrupt: false });
    // Webhooks: the rewritten URL, the token kept (200) or stripped on request (403).
    expect(call.webhookResults.map((w) => w.status)).toEqual([200, 403]);
    expect(webhookPosts[0]!.path).toBe('/api/v1/webhooks/voicelink/webrtc-status/call-1?token=wh-1');
    expect(webhookPosts[0]!.body).toMatchObject({ event: 'call.ringing', call: { id: call.carrierCallId } });
  });

  it('records who closed and how: server close codes, a carrier TCP destroy, and a refused connect', async () => {
    carrier.setScript(() => ({ name: 'close', steps: [{ do: 'connect' }, { do: 'waitForServerClose' }, { do: 'connect' }, { do: 'destroy' }] }));
    const token = await login();
    await addLead(token);
    const deadline = Date.now() + 10_000;
    while (connections.length < 1) {
      if (Date.now() > deadline) throw new Error('never connected');
      await new Promise((r) => setTimeout(r, 5));
    }
    connections[0]!.socket.close(4001, 'refused');
    await carrier.settled();
    const call = carrier.callOrder[0]!;
    expect(call.closes).toEqual([
      { socket: 0, code: 4001, reason: 'refused', by: 'server', abrupt: false },
      { socket: 1, code: 1006, reason: '', by: 'carrier', abrupt: true },
    ]);
    expect(carrier.openSocketCount().media).toBe(0);
  });

  it('postRaw reaches the server independently of any stubbed fetch', async () => {
    await expect(postRaw(`${origin}/x?token=wh-1`, '{"a":1}')).resolves.toBe(200);
  });
});
