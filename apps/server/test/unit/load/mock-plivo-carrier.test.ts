import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The mock Plivo carrier's own contract (`test/mocks/plivo`). The end-to-end Plivo suites
 * trust it to sign callbacks the way Plivo does, to speak the REST shapes the adapter
 * reads, to apply faults exactly as injected and to dial only the URLs it was given; a
 * mock that silently did less would make each of them vacuous. So:
 *  - its signature port matches the SDK-checked vectors and the server's checker;
 *  - the REAL `PlivoAdapter` (its transport pointed at the mock) places, cancels and hangs
 *    up against it, and reads each fault as the carrier's own answer would be read;
 *  - its transport refuses any host but Plivo's fixed API host;
 *  - a scripted call fetches the answer XML from a bare server, parses the `<Stream>` URL
 *    out of it, connects, sends `start` and μ-law media, and records `playAudio`.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import querystring from 'node:querystring';
import { WebSocketServer, type WebSocket } from 'ws';
import { MockPlivoCarrier, plivoSignedString, signPlivoCallback } from '../../mocks/plivo/index.js';
import { isLoudMulaw, mulawFrame } from '../../mocks/voicelink/audio-pattern.js';
import { DEFAULT_PLIVO_SETTINGS, PlivoAdapter, renderPlivoAnswerXml } from '../../../src/telephony/plivo/plivo.adapter.js';
import { InMemoryPlivoDialRateLimiter } from '../../../src/telephony/plivo/plivo-dial-rate.js';
import { verifyPlivoV3Signature } from '../../../src/telephony/plivo/plivo-signature.js';
import { Secret } from '../../../src/telephony/credentials/secret.js';
import { CarrierAuthRejectedError, CarrierRateLimitedError, isDialOutcomeUnknown } from '../../../src/telephony/carrier-errors.js';
import { plivoMedia } from '../../../src/telephony/plivo/plivo.media.js';

const PUBLIC = 'https://agency.test';
const CALL_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

describe('the mock`s V3 signature (an independent port of the SDK`s construction)', () => {
  // Two of the SDK-checked vectors in plivo-signature.test.ts.
  const TOKEN = 'MjQ1ZDM0YzE0NmQ0NjE3OGIwYzM5ZjA2ZTQ5YjZm';
  it.each<{ url: string; params: Record<string, string>; nonce: string; sig: string }>([
    {
      url: 'https://srv.example.com/api/v1/webhooks/plivo/webrtc-status/1b4e28ba-2fa1-11d2-883f-0016d3cca427?token=tok_abc123&w=2',
      params: { CallUUID: 'a1b2c3d4-0000-4000-8000-000000000001', CallStatus: 'ringing', Event: 'Ring', From: '918035000001', To: '919812345678', Direction: 'outbound', RequestUUID: 'f0e1d2c3-0000-4000-8000-000000000002' },
      nonce: '05429567804466091622',
      sig: 'DaxDLOuvCpNV435B0mcOBbDC3NXeGApyuunWtqa2qbg=',
    },
    {
      url: 'https://srv.example.com/api/v1/webhooks/plivo/webrtc-answer/1b4e28ba-2fa1-11d2-883f-0016d3cca427',
      params: { CallUUID: 'x', CallStatus: 'in-progress' },
      nonce: '12345',
      sig: 'lba/1bVsJ3eZSRLaI1M85Z8wDA/fubXYCwKwUK02fdQ=',
    },
  ])('matches the SDK vector for $url', (v) => {
    expect(signPlivoCallback(TOKEN, v.url, v.params, v.nonce)).toBe(v.sig);
  });

  it('what it signs, the server`s checker accepts; another token or URL it refuses', () => {
    const url = `${PUBLIC}/api/v1/webhooks/plivo/webrtc-status/${CALL_ID}?token=t&w=1`;
    const params = { CallUUID: 'u', CallStatus: 'completed', Duration: '7' };
    const headers = { 'x-plivo-signature-v3': signPlivoCallback('tok-a', url, params, 'n1'), 'x-plivo-signature-v3-nonce': 'n1' };
    expect(verifyPlivoV3Signature(['tok-a'], { method: 'POST', url, params, headers })).toBe(true);
    expect(verifyPlivoV3Signature(['tok-b'], { method: 'POST', url, params, headers })).toBe(false);
    expect(verifyPlivoV3Signature(['tok-a'], { method: 'POST', url: url.replace('w=1', 'w=2'), params, headers })).toBe(false);
    expect(plivoSignedString(url, params)).toBe(`${PUBLIC}/api/v1/webhooks/plivo/webrtc-status/${CALL_ID}?token=t&w=1.CallStatuscompletedCallUUIDuDuration7`);
  });
});

describe('the mock`s REST, through the real PlivoAdapter', () => {
  let carrier: MockPlivoCarrier;
  beforeAll(async () => {
    carrier = new MockPlivoCarrier({ numbers: [{ number: '14155550001' }, { number: '14155550002', voice_enabled: false }] });
    await carrier.start();
  });
  afterAll(async () => { await carrier.stop(); });
  beforeEach(() => { carrier.reset(); carrier.setScript(undefined); });

  const adapter = (token = carrier.authToken, requestTimeoutMs = 2_000) => new PlivoAdapter({
    ...DEFAULT_PLIVO_SETTINGS,
    webhookBaseUrl: `${PUBLIC}/api/v1/webhooks/plivo`,
    requestTimeoutMs,
    authId: carrier.authId,
    authToken: new Secret(token),
    fetchImpl: carrier.fetch,
    rateLimiter: new InMemoryPlivoDialRateLimiter(),
  });
  const dial = () => ({
    callId: CALL_ID,
    to: '+919812345678',
    from: '+14155550001',
    webhookUrl: `${PUBLIC}/api/v1/webhooks/plivo/webrtc-answer/${CALL_ID}?token=t`,
    statusCallbackUrl: `${PUBLIC}/api/v1/webhooks/plivo/webrtc-status/${CALL_ID}?token=t`,
    maxDuration: 600,
    enableRecording: false,
    machineDetection: false,
  });

  it('a create-call is 201 with a request_uuid; the dial body is the one Plivo takes', async () => {
    const r = await adapter().initiateCall(dial());
    expect(r.providerCallId).toBe('');
    expect(r.providerRequestId).toBe(carrier.callOrder[0]!.requestUuid);
    const [req] = carrier.requestsTo('create_call');
    expect(req).toMatchObject({ method: 'POST', status: 201, authorized: true, path: `/v1/Account/${carrier.authId}/Call/` });
    expect(req!.body).toMatchObject({ from: '14155550001', to: '919812345678', answer_method: 'POST', time_limit: 600 });
    expect(carrier.callOrder[0]!.callId).toBe(CALL_ID);
  });

  it('cancel by request id: 204 while unanswered, then 404; hangup by call id: 404 until the carrier named the call', async () => {
    const r = await adapter().initiateCall(dial());
    const call = carrier.callOrder[0]!;
    await expect(adapter().endCall(call.callUuid)).resolves.toBeUndefined(); // 404 resolves
    expect(carrier.requestsTo('hangup_call')[0]!.status).toBe(404);
    await expect(adapter().cancelDialRequest(r.providerRequestId!)).resolves.toBe('canceled');
    expect(call.canceledByApi).toBe(true);
    await expect(adapter().cancelDialRequest(r.providerRequestId!)).resolves.toBe('not_found');
  });

  it.each([
    ['401', { kind: 'status', status: 401 } as const, (e: unknown) => e instanceof CarrierAuthRejectedError],
    ['429', { kind: 'status', status: 429 } as const, (e: unknown) => e instanceof CarrierRateLimitedError],
    ['403 (a plain refusal)', { kind: 'status', status: 403 } as const, (e: unknown) => e instanceof Error && /error 403/.test(e.message)],
    ['an unreadable 201', { kind: 'malformed' } as const, (e: unknown) => isDialOutcomeUnknown(e)],
    ['no answer before the timeout', { kind: 'hang' } as const, (e: unknown) => isDialOutcomeUnknown(e)],
  ])('a create-call fault, %s, is read as the carrier`s own answer would be', async (_n, fault, check) => {
    carrier.injectFault('create_call', fault);
    const err = await adapter(carrier.authToken, 300).initiateCall(dial()).catch((e: unknown) => e);
    expect(check(err), String(err)).toBe(true);
    expect(carrier.requestsTo('create_call')[0]!.fault).toBe(fault.kind);
  });

  it('a wrong token is 401 from the carrier itself (no fault injected)', async () => {
    const err = await adapter('not-the-accounts-token-x').initiateCall(dial()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CarrierAuthRejectedError);
    expect(carrier.requestsTo('create_call')[0]).toMatchObject({ authorized: false, status: 401 });
  });

  it('the transport refuses any host but Plivo`s fixed API host', async () => {
    await expect(carrier.fetch('https://api.plivo.com.evil.test/v1/', { method: 'GET' })).rejects.toThrow(/not for Plivo/);
    await expect(carrier.fetch('http://127.0.0.1:1/v1/', { method: 'GET' })).rejects.toThrow(/not for Plivo/);
    expect(carrier.offHost).toHaveLength(2);
  });

  it('the number list pages as Plivo`s does', async () => {
    const res = await carrier.fetch(`https://api.plivo.com/v1/Account/${carrier.authId}/Number/?limit=20&offset=0`, {
      method: 'GET', headers: { Authorization: `Basic ${Buffer.from(`${carrier.authId}:${carrier.authToken}`).toString('base64')}` },
    });
    const body = await res.json() as { meta: { next: unknown }; objects: Array<{ number: string; voice_enabled: boolean }> };
    expect(body.meta.next).toBeNull();
    expect(body.objects).toEqual([
      expect.objectContaining({ number: '14155550001', voice_enabled: true }),
      expect.objectContaining({ number: '14155550002', voice_enabled: false }),
    ]);
  });
});

describe('a scripted call against a bare server', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let origin: string;
  const posts: Array<{ path: string; params: Record<string, string>; headers: http.IncomingHttpHeaders }> = [];
  const frames: unknown[] = [];
  let carrier: MockPlivoCarrier;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const params = querystring.parse(Buffer.concat(chunks).toString()) as Record<string, string>;
        posts.push({ path: req.url ?? '', params, headers: req.headers });
        if (req.url?.includes('/webrtc-answer/')) {
          res.writeHead(200, { 'content-type': 'text/xml' });
          res.end(renderPlivoAnswerXml(`wss://agency.test/api/v1/webrtc-call/${CALL_ID}/pstn-stream?token=p&w=1`, {
            enableRecording: true, recordingCallbackUrl: `${PUBLIC}/api/v1/webhooks/plivo/webrtc-recording/${CALL_ID}?token=t&w=1`, maxDurationSeconds: 600,
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":true}');
      });
    });
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws: WebSocket, req) => {
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString()) as { event: string; media?: { payload: string } };
        frames.push({ ...f, path: req.url });
        // Echo each carrier frame back as the bridge would answer it: a playAudio.
        if (f.event === 'media') ws.send(JSON.stringify(plivoMedia.frameOutbound(f.media!.payload, null)));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    carrier = new MockPlivoCarrier({ targetOrigin: () => origin });
    await carrier.start();
  });
  afterAll(async () => {
    await carrier.stop();
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('ring, answer (XML fetched and parsed), stream, recording, hangup: each signed for the public URL', async () => {
    const pattern = [true, false, true, true, false];
    carrier.setScript(() => ({
      name: 'answered',
      steps: [
        { do: 'ring' },
        { do: 'answer' },
        { do: 'connect' },
        { do: 'start' },
        { do: 'media', pattern, frameMs: 0 },
        { do: 'waitFor', until: (c) => c.playAudio.length === pattern.length, what: 'echoes' },
        { do: 'stop' },
        { do: 'close' },
        { do: 'hangup', status: 'completed' },
        { do: 'recording', recordingId: 'rec-1' },
      ],
    }));
    const adapter = new PlivoAdapter({
      ...DEFAULT_PLIVO_SETTINGS, webhookBaseUrl: `${PUBLIC}/api/v1/webhooks/plivo`, authId: carrier.authId,
      authToken: new Secret(carrier.authToken), fetchImpl: carrier.fetch, rateLimiter: new InMemoryPlivoDialRateLimiter(),
    });
    await adapter.initiateCall({
      callId: CALL_ID, to: '+919812345678', from: '+14155550001',
      webhookUrl: `${PUBLIC}/api/v1/webhooks/plivo/webrtc-answer/${CALL_ID}?token=t&w=1`,
      statusCallbackUrl: `${PUBLIC}/api/v1/webhooks/plivo/webrtc-status/${CALL_ID}?token=t&w=1`,
      maxDuration: 600, enableRecording: true, machineDetection: false,
    });
    await carrier.waitForCalls(1);
    await carrier.settled();
    const call = carrier.callOrder[0]!;
    expect(call.errors).toEqual([]);
    expect(call.streamUrl).toBe(`wss://agency.test/api/v1/webrtc-call/${CALL_ID}/pstn-stream?token=p&w=1`);
    expect(call.recordCallbackUrl).toBe(`${PUBLIC}/api/v1/webhooks/plivo/webrtc-recording/${CALL_ID}?token=t&w=1`);
    expect(posts.map((p) => [p.path.split('?')[0]!.split('/').at(-2), p.params['CallStatus'] ?? 'rec'])).toEqual([
      ['webrtc-status', 'ringing'], ['webrtc-answer', 'in-progress'], ['webrtc-status', 'completed'], ['webrtc-recording', 'rec'],
    ]);
    for (const p of posts) {
      const url = `${PUBLIC}${p.path}`;
      expect(verifyPlivoV3Signature([carrier.authToken], {
        method: 'POST', url, params: p.params, headers: p.headers as Record<string, string>,
      }), p.path).toBe(true);
    }
    expect(posts[3]!.params).toMatchObject({ RecordingID: 'rec-1', CallUUID: call.callUuid });
    expect(posts[3]!.params['RecordUrl']).toBe(`https://media.plivo.com/v1/Account/${carrier.authId}/Recording/rec-1.mp3`);
    // The stream: start in μ-law 8 kHz with Plivo's ids, the frames, stop; the echoes recorded as playAudio.
    const start = frames[0] as { event: string; start: { callId: string; streamId: string; mediaFormat: unknown }; path: string };
    expect(start.path).toBe(`/api/v1/webrtc-call/${CALL_ID}/pstn-stream?token=p&w=1`);
    expect(plivoMedia.parseStart(start)).toEqual({ ok: true, carrierCallId: call.callUuid, streamId: call.streamId });
    expect(frames.filter((f) => (f as { event: string }).event === 'media')).toHaveLength(pattern.length);
    expect((frames.at(-1) as { event: string }).event).toBe('stop');
    expect(call.playAudio.map(isLoudMulaw)).toEqual(pattern);
    expect(Buffer.compare(call.playAudio[0]!, mulawFrame(0, true))).toBe(0);
    expect(call.closedBy).toBe('carrier');
  });

  it('the call detail record: 404 while the call is live, then its `call_state`, read by the real adapter as ended', async () => {
    let hangUp = false;
    carrier.setScript(() => ({
      name: 'busy after a ring',
      steps: [
        { do: 'ring' },
        { do: 'waitFor', until: () => hangUp, what: 'the test' },
        { do: 'hangup', status: 'busy' },
      ],
    }));
    const adapter = new PlivoAdapter({
      ...DEFAULT_PLIVO_SETTINGS, webhookBaseUrl: `${PUBLIC}/api/v1/webhooks/plivo`, authId: carrier.authId,
      authToken: new Secret(carrier.authToken), fetchImpl: carrier.fetch, rateLimiter: new InMemoryPlivoDialRateLimiter(),
    });
    carrier.reset();
    await adapter.initiateCall({
      callId: CALL_ID, to: '+919812345678', from: '+14155550001',
      webhookUrl: `${PUBLIC}/api/v1/webhooks/plivo/webrtc-answer/${CALL_ID}?token=t&w=1`,
      statusCallbackUrl: `${PUBLIC}/api/v1/webhooks/plivo/webrtc-status/${CALL_ID}?token=t&w=1`,
      maxDuration: 600, enableRecording: false, machineDetection: false,
    });
    await carrier.waitForCalls(1);
    const call = carrier.callOrder[0]!;
    await vi.waitFor(() => expect(call.named).toBe(true));
    // Still ringing: no CDR yet, which the adapter reads as not ended.
    expect(await adapter.getCallStatus(call.callUuid)).toEqual({ status: 'live' });
    expect(carrier.requestsTo('get_call').at(-1)).toMatchObject({ method: 'GET', status: 404, id: call.callUuid });
    hangUp = true;
    await carrier.settled();
    expect(call.cdr).toMatchObject({ call_uuid: call.callUuid, call_state: 'BUSY', answer_time: null });
    expect(await adapter.getCallStatus(call.callUuid)).toMatchObject({ status: 'busy', errorCode: '3000', errorMessage: 'User Busy' });
    expect(carrier.requestsTo('get_call').at(-1)).toMatchObject({ status: 200 });
  });
});
