import { verify } from 'node:crypto';
import http2 from 'node:http2';
import net, { type AddressInfo, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgencyRingPush } from '@magick-agency/contracts/agency';

// The APNs VoIP sender (src/notifications/push/apns-sender.ts; docs/seams.md §3.6) against the mock
// carrier's loopback HTTP/2 server: the request, the ES256 provider token and its cache, which
// push types go to iOS at all, every error mapping, the timeout, and the session (reused,
// reconnected after a GOAWAY or a cut connection, a refused stream sent once more).

const metrics = vi.hoisted(() => ({ trackPushSend: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/platform', () => metrics);

import { logger } from '@magick-agency/observability';
import {
  APNS_ORIGINS, APNS_PROVIDER_TOKEN_MAX_AGE_MS, ApnsSender, apnsExpiration, mapApnsAnswer, type ApnsConnect,
} from '../../../../src/notifications/push/apns-sender.js';
import type { PushSenderDevice } from '../../../../src/seams/push-sender.js';
import { MockPushCarrier, publicKeyOf } from '../../../mocks/push/index.js';

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const MIN = 60_000;
const RING: AgencyRingPush = {
  type: 'ring', call_id: 'call-1', offer_token: 'offer-token-secret', ring_expires_at: '2026-11-12T10:00:20.000Z', session_id: 'sess-1',
};

let carrier: MockPushCarrier;
let now: number;
let senders: ApnsSender[] = [];
let device: PushSenderDevice;

function apns(opts: { timeoutMs?: number; connect?: ApnsConnect; env?: 'sandbox' | 'production' } = {}): ApnsSender {
  const sender = new ApnsSender({
    credentials: { ...carrier.config.apns, ...(opts.env ? { env: opts.env } : {}) },
    connect: opts.connect ?? carrier.apnsConnect,
    now: () => now,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  senders.push(sender);
  return sender;
}

function decode(jwt: string) {
  const [h, c, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(c!, 'base64url').toString()) as Record<string, unknown>,
    verified: verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKeyOf(carrier.config.apns.key), dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url')),
  };
}

/** Lets a GOAWAY or a close reach the client session. */
const settleIo = () => new Promise((r) => setTimeout(r, 100));

beforeAll(async () => { carrier = await MockPushCarrier.start(); });
afterAll(async () => { await carrier.stop(); });
beforeEach(() => {
  now = T0;
  carrier.reset();
  metrics.trackPushSend.mockReset();
  device = MockPushCarrier.device('ios', 'row-ios-1');
});
afterEach(async () => {
  await Promise.all(senders.map((s) => s.close()));
  senders = [];
  vi.restoreAllMocks();
});

describe('ApnsSender: the request', () => {
  it('POSTs /3/device/{token} with the VoIP headers and IQ61\'s fields as the payload', async () => {
    const sender = apns();
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
    expect(carrier.sends).toHaveLength(1);
    const sent = carrier.sends[0]!;
    expect(sent).toMatchObject({
      platform: 'ios', token: device.voip_token, authorized: true, status: 200,
      data: { type: 'ring', call_id: 'call-1', offer_token: 'offer-token-secret', ring_expires_at: '2026-11-12T10:00:20.000Z', session_id: 'sess-1' },
      apns: { pushType: 'voip', topic: 'com.example.agent.voip', priority: '10', expiration: String((T0 + 20_000) / 1000) },
    });
    expect(metrics.trackPushSend).toHaveBeenCalledWith('ios', 'ok', expect.any(Number));
  });

  it('apns-expiration: the end of ttlMs in epoch seconds; 0 when there is no time', () => {
    expect(apnsExpiration(T0, 20_000)).toBe(String((T0 + 20_000) / 1000));
    expect(apnsExpiration(T0 + 999, 1)).toBe(String(T0 / 1000 + 1));
    expect(apnsExpiration(T0, 0)).toBe('0');
    expect(apnsExpiration(T0, -1)).toBe('0');
  });

  it('connects to the environment\'s fixed origin', async () => {
    const origins: string[] = [];
    const connect: ApnsConnect = (origin) => { origins.push(origin); return carrier.apnsConnect(origin); };
    await apns({ connect, env: 'production' }).send(device, RING, { ttlMs: 20_000 });
    await apns({ connect, env: 'sandbox' }).send(device, RING, { ttlMs: 20_000 });
    expect(origins).toEqual(['https://api.push.apple.com', 'https://api.sandbox.push.apple.com']);
    expect(APNS_ORIGINS).toEqual({ production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' });
    expect(carrier.offHost).toEqual([]);
  });

  it('only ring and test_ring go to iOS: ring_cancel and ring_off answer ok unsent, counted skipped', async () => {
    const sender = apns();
    expect(await sender.send(device, { type: 'ring_cancel', call_id: 'call-1', reason: 'caller_left' }, { ttlMs: 5_000 })).toEqual({ ok: true });
    expect(await sender.send(device, { type: 'ring_off', session_id: 'sess-1', reason: 'opted_out' }, { ttlMs: 5_000 })).toEqual({ ok: true });
    expect(carrier.sends).toHaveLength(0);
    expect(carrier.apnsConnections).toBe(0);
    expect(metrics.trackPushSend.mock.calls).toEqual([['ios', 'skipped', undefined], ['ios', 'skipped', undefined]]);
    expect(await sender.send(device, { type: 'test_ring' }, { ttlMs: 30_000 })).toEqual({ ok: true });
    expect(carrier.sends.map((s) => s.data)).toEqual([{ type: 'test_ring' }]);
  });

  it('a device with no VoIP token, or one that is not hex, answers invalid and sends nothing', async () => {
    const sender = apns();
    expect(await sender.send({ ...device, voip_token: null }, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'invalid' });
    expect(await sender.send({ ...device, voip_token: '../../3/device/x' }, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'invalid' });
    expect(carrier.sends).toHaveLength(0);
  });
});

describe('ApnsSender: the provider token', () => {
  it('ES256 with kid and iss, verifiable with the .p8\'s public key', async () => {
    await apns().send(device, RING, { ttlMs: 20_000 });
    const jwt = decode(carrier.sends[0]!.apns!.providerToken);
    expect(jwt.header).toEqual({ kid: 'MOCKKEY123', alg: 'ES256' });
    expect(jwt.claims).toEqual({ iss: 'MOCKTEAM12', iat: T0 / 1000 });
    expect(jwt.verified).toBe(true);
  });

  it('is reused for 50 minutes, then minted again', async () => {
    const sender = apns();
    await sender.send(device, RING, { ttlMs: 20_000 });
    now += APNS_PROVIDER_TOKEN_MAX_AGE_MS - 1;
    await sender.send(device, RING, { ttlMs: 20_000 });
    now += 1;
    await sender.send(device, RING, { ttlMs: 20_000 });
    const tokens = carrier.sends.map((s) => s.apns!.providerToken);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[1]);
    expect(decode(tokens[2]!).claims['iat']).toBe((T0 + 50 * MIN) / 1000);
    expect(APNS_PROVIDER_TOKEN_MAX_AGE_MS).toBe(50 * MIN);
  });

  it('ExpiredProviderToken: a new token is minted and the push sent once more', async () => {
    carrier.answer(device.voip_token!, { kind: 'status', status: 403, body: { reason: 'ExpiredProviderToken' } });
    const sender = apns();
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
    expect(carrier.sends).toHaveLength(2);
    // Same clock, so the same iat: the token is new because it was minted again (and still valid).
    expect(carrier.sends.every((s) => s.authorized)).toBe(true);
  });

  it('ExpiredProviderToken twice: unavailable, no third try', async () => {
    const expired = { kind: 'status', status: 403, body: { reason: 'ExpiredProviderToken' } } as const;
    carrier.answer(device.voip_token!, expired, expired, expired);
    expect(await apns().send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(carrier.sends).toHaveLength(2);
  });
});

describe('ApnsSender: errors', () => {
  it.each([
    ['410 Unregistered', 'unregistered', { kind: 'unregistered' }],
    ['410 ExpiredToken', 'unregistered', { kind: 'status', status: 410, body: { reason: 'ExpiredToken' } }],
    ['400 BadDeviceToken', 'unregistered', { kind: 'status', status: 400, body: { reason: 'BadDeviceToken' } }],
    ['400 DeviceTokenNotForTopic', 'invalid', { kind: 'invalid' }],
    // A request refused as malformed is ours, every device alike: the service's trouble.
    ['400 BadExpirationDate', 'unavailable', { kind: 'status', status: 400, body: { reason: 'BadExpirationDate' } }],
    ['413 PayloadTooLarge', 'unavailable', { kind: 'status', status: 413, body: { reason: 'PayloadTooLarge' } }],
    ['403 InvalidProviderToken', 'unavailable', { kind: 'status', status: 403, body: { reason: 'InvalidProviderToken' } }],
    ['500 InternalServerError', 'unavailable', { kind: 'status', status: 500, body: { reason: 'InternalServerError' } }],
    ['503 ServiceUnavailable', 'unavailable', { kind: 'unavailable' }],
    ['a stream reset after the request', 'unavailable', { kind: 'network' }],
  ] as const)('%s → %s', async (_label, reason, answer) => {
    carrier.answer(device.voip_token!, answer);
    expect(await apns().send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason });
    // Nothing is sent twice: a reset after the request went out may have rung the phone.
    expect(carrier.sends).toHaveLength(1);
    expect(metrics.trackPushSend).toHaveBeenCalledWith('ios', reason, expect.any(Number));
  });

  it('429 TooManyRequests → rate_limited, this device\'s alone (APNs limits per token)', async () => {
    carrier.answer(device.voip_token!, { kind: 'rate_limited' });
    expect(await apns().send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'rate_limited', scope: 'device' });
  });

  it('mapApnsAnswer: by status, then reason', () => {
    expect(mapApnsAnswer(200, undefined)).toEqual({ ok: true });
    expect(mapApnsAnswer(410, undefined)).toEqual({ ok: false, reason: 'unregistered' });
    expect(mapApnsAnswer(400, 'Unregistered')).toEqual({ ok: false, reason: 'unregistered' });
    expect(mapApnsAnswer(400, 'BadDeviceToken')).toEqual({ ok: false, reason: 'unregistered' });
    expect(mapApnsAnswer(400, 'DeviceTokenNotForTopic')).toEqual({ ok: false, reason: 'invalid' });
    expect(mapApnsAnswer(400, undefined)).toEqual({ ok: false, reason: 'unavailable' });
    expect(mapApnsAnswer(405, 'MethodNotAllowed')).toEqual({ ok: false, reason: 'unavailable' });
    expect(mapApnsAnswer(429, 'TooManyRequests')).toEqual({ ok: false, reason: 'rate_limited', scope: 'device' });
    expect(mapApnsAnswer(403, 'TopicDisallowed')).toEqual({ ok: false, reason: 'unavailable' });
    expect(mapApnsAnswer(204, undefined)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a send never answered is cancelled at the timeout (unavailable); the session still serves the next', async () => {
    carrier.answer(device.voip_token!, { kind: 'hang' });
    const sender = apns({ timeoutMs: 100 });
    const started = Date.now();
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
    expect(carrier.apnsConnections).toBe(1);
  });

  it('a peer that stops answering (no reply, no PING ack) is dropped after a timeout; the next send connects anew', async () => {
    // A TCP server that accepts and never speaks HTTP/2: a half-open connection, as far as the client can tell.
    const sockets: Socket[] = [];
    const dead = net.createServer((socket) => { sockets.push(socket); socket.on('error', () => {}); });
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    let first = true;
    const connect: ApnsConnect = (origin) => {
      if (!first) return carrier.apnsConnect(origin);
      first = false;
      return http2.connect(`http://127.0.0.1:${port}`);
    };
    try {
      const sender = apns({ timeoutMs: 100, connect });
      expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unavailable' });
      await new Promise((r) => setTimeout(r, 500)); // the PING probe's own timeout (100 ms)
      expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
      expect(carrier.apnsConnections).toBe(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => dead.close(() => r()));
    }
  });

  it('429: never retried, the device is held back until its Retry-After', async () => {
    carrier.answer(device.voip_token!, { kind: 'rate_limited', retryAfterSeconds: 20 });
    const sender = apns();
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'rate_limited', scope: 'device' });
    now += 19_999;
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'rate_limited', scope: 'device' });
    expect(carrier.sends).toHaveLength(1);
    now += 1;
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
  });

  it('logs a failure by device row id, type and call id, never the token or the provider token', async () => {
    const warn = vi.spyOn(logger, 'warn');
    carrier.answer(device.voip_token!, { kind: 'unregistered' });
    await apns().send(device, RING, { ttlMs: 20_000 });
    expect(warn.mock.calls[0]![0]).toEqual({
      platform: 'ios', push_device_id: 'row-ios-1', push_type: 'ring', call_id: 'call-1',
      reason: 'unregistered', carrier_status: 410, carrier_code: 'Unregistered',
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(device.voip_token!);
    expect(logged).not.toContain('offer-token-secret');
    expect(logged).not.toContain(carrier.sends[0]!.apns!.providerToken);
  });
});

describe('ApnsSender: the HTTP/2 session', () => {
  it('one session for every send, sequential or concurrent', async () => {
    const sender = apns();
    await sender.send(device, RING, { ttlMs: 20_000 });
    await sender.send(device, RING, { ttlMs: 20_000 });
    const many = await Promise.all(Array.from({ length: 5 }, () => sender.send(device, RING, { ttlMs: 20_000 })));
    expect(many.every((r) => r.ok)).toBe(true);
    expect(carrier.sends).toHaveLength(7);
    expect(carrier.apnsConnections).toBe(1);
  });

  it('after a GOAWAY the next send connects anew', async () => {
    const sender = apns();
    await sender.send(device, RING, { ttlMs: 20_000 });
    carrier.goawayApns();
    await settleIo();
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
    expect(carrier.apnsConnections).toBe(2);
  });

  it('503 Shutdown (and its GOAWAY): unavailable, and the next send connects anew', async () => {
    carrier.answer(device.voip_token!, { kind: 'shutdown' });
    const sender = apns();
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unavailable' });
    await settleIo();
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
    expect(carrier.apnsConnections).toBe(2);
  });

  it('after the connection is cut the next send connects anew', async () => {
    const sender = apns();
    await sender.send(device, RING, { ttlMs: 20_000 });
    carrier.dropApnsConnections();
    await settleIo();
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
    expect(carrier.apnsConnections).toBe(2);
  });

  it('a stream refused unprocessed (REFUSED_STREAM) is sent once more; refused twice is unavailable', async () => {
    carrier.answer(device.voip_token!, { kind: 'refused' });
    const sender = apns();
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
    expect(carrier.sends.map((s) => s.answer)).toEqual(['refused', 'ok']);

    carrier.reset();
    carrier.answer(device.voip_token!, { kind: 'refused' }, { kind: 'refused' }, { kind: 'ok' });
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(carrier.sends).toHaveLength(2);
  });

  it('a connect that throws is unavailable, and the next send tries again', async () => {
    let calls = 0;
    const connect: ApnsConnect = (origin) => {
      calls += 1;
      if (calls === 1) throw new Error('ENETUNREACH');
      return carrier.apnsConnect(origin);
    };
    const sender = apns({ connect });
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: true });
  });

  it('close() closes the session; a send after close is not attempted', async () => {
    const sender = apns();
    await sender.send(device, RING, { ttlMs: 20_000 });
    await sender.close();
    await settleIo();
    expect(await sender.send(device, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(carrier.sends).toHaveLength(1);
    expect(carrier.apnsConnections).toBe(1);
  });
});
