import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgencyRingPush } from '@magick-agency/contracts/agency';

// The FCM HTTP v1 sender (src/notifications/push/fcm-sender.ts; docs/seams.md §3.6): the OAuth
// assertion and its cache, the message, every error mapping, the Retry-After hold, the timeout,
// and what is counted and logged (never a token).

const metrics = vi.hoisted(() => ({ trackPushSend: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/platform', () => metrics);

import { logger } from '@magick-agency/observability';
import {
  FCM_OAUTH_TOKEN_URL, FCM_SCOPE, FcmSender, fcmSendUrl, fcmTtl, mapFcmAnswer, type PushFetch,
} from '../../../../src/notifications/push/fcm-sender.js';
import type { FcmCredentials } from '../../../../src/notifications/push/credentials.js';
import type { PushSenderDevice } from '../../../../src/seams/push-sender.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CREDS: FcmCredentials = { projectId: 'agent-app', clientEmail: 'push@agent-app.iam.gserviceaccount.com', privateKey: rsa.privateKey };
const DEVICE: PushSenderDevice = { id: 'row-1', platform: 'android', fcm_token: 'fcm-token-secret-1', voip_token: null };
const RING: AgencyRingPush = {
  type: 'ring', call_id: 'call-1', offer_token: 'offer-token-secret', ring_expires_at: '2026-11-12T10:00:20.000Z', session_id: 'sess-1',
};
const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const MIN = 60_000;

interface Call { url: string; headers: Record<string, string>; body: string }

/** A scripted fetch: OAuth answered by `oauth`, sends by `send`; every call recorded. */
function harness(opts: {
  oauth?: (n: number) => Response | Promise<Response>;
  send?: (n: number, call: Call) => Response | Promise<Response>;
  timeoutMs?: number;
} = {}) {
  let now = T0;
  const oauthCalls: Call[] = [];
  const sendCalls: Call[] = [];
  const fetchImpl: PushFetch = async (url, init) => {
    const call = { url, headers: init.headers, body: init.body };
    if (url === FCM_OAUTH_TOKEN_URL) {
      oauthCalls.push(call);
      return (opts.oauth ?? ((n) => Response.json({ access_token: `access-${n}`, expires_in: 3600, token_type: 'Bearer' })))(oauthCalls.length);
    }
    sendCalls.push(call);
    return (opts.send ?? (() => Response.json({ name: 'projects/agent-app/messages/1' })))(sendCalls.length, call);
  };
  const sender = new FcmSender({ credentials: CREDS, fetchImpl, now: () => now, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  return {
    sender, oauthCalls, sendCalls,
    advance(ms: number) { now += ms; },
    send(device: PushSenderDevice = DEVICE, payload: AgencyRingPush = RING, ttlMs = 20_000) {
      return sender.send(device, payload, { ttlMs });
    },
  };
}

function fcmError(status: number, canonical: string, errorCode?: string, headers: Record<string, string> = {}, tokenField = false): Response {
  return Response.json({
    error: {
      code: status, message: 'x', status: canonical,
      ...(errorCode || tokenField ? {
        details: [
          ...(errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : []),
          ...(tokenField
            ? [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token', description: 'Invalid registration token' }] }]
            : []),
        ],
      } : {}),
    },
  }, { status, headers });
}

function jwtOf(call: Call) {
  const assertion = new URLSearchParams(call.body).get('assertion')!;
  const [h, c, s] = assertion.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(c!, 'base64url').toString()) as Record<string, unknown>,
    verified: verify('sha256', Buffer.from(`${h}.${c}`), rsa.publicKey, Buffer.from(s!, 'base64url')),
  };
}

beforeEach(() => { metrics.trackPushSend.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('FcmSender: auth', () => {
  it('signs an RS256 assertion for the messaging scope and trades it at Google\'s token URL', async () => {
    const h = harness();
    expect(await h.send()).toEqual({ ok: true });
    expect(h.oauthCalls).toHaveLength(1);
    const call = h.oauthCalls[0]!;
    expect(call.url).toBe('https://oauth2.googleapis.com/token');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(call.body).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const jwt = jwtOf(call);
    expect(jwt.header).toEqual({ typ: 'JWT', alg: 'RS256' });
    expect(jwt.claims).toEqual({
      iss: 'push@agent-app.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: T0 / 1000,
      exp: T0 / 1000 + 3600,
    });
    expect(FCM_SCOPE).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(jwt.verified).toBe(true);
    expect(h.sendCalls[0]!.headers['authorization']).toBe('Bearer access-1');
  });

  it('caches the access token for 55 minutes, then trades a new assertion', async () => {
    const h = harness();
    await h.send();
    await h.send();
    h.advance(55 * MIN - 1);
    await h.send();
    expect(h.oauthCalls).toHaveLength(1);
    h.advance(1);
    await h.send();
    expect(h.oauthCalls).toHaveLength(2);
    expect(h.sendCalls.map((c) => c.headers['authorization'])).toEqual(['Bearer access-1', 'Bearer access-1', 'Bearer access-1', 'Bearer access-2']);
    expect(jwtOf(h.oauthCalls[1]!).claims['iat']).toBe((T0 + 55 * MIN) / 1000);
  });

  it('a token with a shorter life is used until 5 minutes before it ends', async () => {
    const h = harness({ oauth: (n) => Response.json({ access_token: `access-${n}`, expires_in: 600 }) });
    await h.send();
    h.advance(5 * MIN - 1);
    await h.send();
    expect(h.oauthCalls).toHaveLength(1);
    h.advance(1);
    await h.send();
    expect(h.oauthCalls).toHaveLength(2);
  });

  it('concurrent sends share one exchange (single flight)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness({ oauth: async (n) => { await gate; return Response.json({ access_token: `access-${n}`, expires_in: 3599 }); } });
    const sends = [h.send(), h.send({ ...DEVICE, id: 'row-2', fcm_token: 't2' }), h.send({ ...DEVICE, id: 'row-3', fcm_token: 't3' })];
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await Promise.all(sends)).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(h.oauthCalls).toHaveLength(1);
    expect(h.sendCalls).toHaveLength(3);
  });

  it('a failed exchange answers unavailable, sends nothing and is not cached', async () => {
    const h = harness({ oauth: (n) => (n === 1 ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : Response.json({ access_token: 'access-2', expires_in: 3599 })) });
    expect(await h.send()).toEqual({ ok: false, reason: 'unavailable' });
    expect(h.sendCalls).toHaveLength(0);
    expect(await h.send()).toEqual({ ok: true });
    expect(h.oauthCalls).toHaveLength(2);
  });

  it('an exchange answering no access_token, or not JSON, is a failure', async () => {
    const empty = harness({ oauth: () => Response.json({ expires_in: 3599 }) });
    expect(await empty.send()).toEqual({ ok: false, reason: 'unavailable' });
    const garbage = harness({ oauth: () => new Response('<html>', { status: 200 }) });
    expect(await garbage.send()).toEqual({ ok: false, reason: 'unavailable' });
    expect(empty.sendCalls.length + garbage.sendCalls.length).toBe(0);
  });

  it('a send answered 401 drops the token and is sent once more with a fresh one', async () => {
    const h = harness({ send: (n) => (n === 1 ? fcmError(401, 'UNAUTHENTICATED') : Response.json({ name: 'm' })) });
    expect(await h.send()).toEqual({ ok: true });
    expect(h.oauthCalls).toHaveLength(2);
    expect(h.sendCalls.map((c) => c.headers['authorization'])).toEqual(['Bearer access-1', 'Bearer access-2']);
  });

  it('a second 401 is not retried again: unavailable', async () => {
    const h = harness({ send: () => fcmError(401, 'UNAUTHENTICATED') });
    expect(await h.send()).toEqual({ ok: false, reason: 'unavailable' });
    expect(h.sendCalls).toHaveLength(2);
  });
});

describe('FcmSender: the message', () => {
  it('posts a data-only message to the project\'s send URL: HIGH priority, the ring window as ttl', async () => {
    const h = harness();
    await h.send();
    const call = h.sendCalls[0]!;
    expect(call.url).toBe('https://fcm.googleapis.com/v1/projects/agent-app/messages:send');
    expect(fcmSendUrl('a/b')).toBe('https://fcm.googleapis.com/v1/projects/a%2Fb/messages:send');
    expect(call.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(call.body)).toEqual({
      message: {
        token: 'fcm-token-secret-1',
        data: {
          type: 'ring', call_id: 'call-1', offer_token: 'offer-token-secret', ring_expires_at: '2026-11-12T10:00:20.000Z', session_id: 'sess-1',
        },
        android: { priority: 'HIGH', ttl: '20s' },
      },
    });
  });

  it('every data value is a string and unset fields are left out', async () => {
    const h = harness();
    await h.send(DEVICE, { type: 'ring_off', session_id: 'sess-1', reason: 'ring_missed', call_id: undefined }, 60_000);
    const body = JSON.parse(h.sendCalls[0]!.body) as { message: { data: Record<string, unknown>; android: { ttl: string }; notification?: unknown } };
    expect(body.message.data).toEqual({ type: 'ring_off', session_id: 'sess-1', reason: 'ring_missed' });
    expect(Object.values(body.message.data).every((v) => typeof v === 'string')).toBe(true);
    expect(body.message.notification).toBeUndefined();
    expect(body.message.android.ttl).toBe('60s');
  });

  it('ttl: whole seconds rounded up, never negative, at most 28 days', () => {
    expect(fcmTtl(20_000)).toBe('20s');
    expect(fcmTtl(1_500)).toBe('2s');
    expect(fcmTtl(1)).toBe('1s');
    expect(fcmTtl(0)).toBe('0s');
    expect(fcmTtl(-5_000)).toBe('0s');
    expect(fcmTtl(100 * 24 * 3600 * 1000)).toBe('2419200s');
  });

  it('a device with no FCM token answers invalid and sends nothing', async () => {
    const h = harness();
    expect(await h.send({ ...DEVICE, fcm_token: null })).toEqual({ ok: false, reason: 'invalid' });
    expect(h.oauthCalls.length + h.sendCalls.length).toBe(0);
    expect(metrics.trackPushSend).toHaveBeenCalledWith('android', 'invalid', undefined);
  });
});

describe('FcmSender: errors', () => {
  it.each([
    [404, 'NOT_FOUND', 'UNREGISTERED', false, 'unregistered'],
    // A bare 404 names no token (a wrong project or path, a proxy): never a revoke.
    [404, 'NOT_FOUND', undefined, false, 'unavailable'],
    [400, 'INVALID_ARGUMENT', 'UNREGISTERED', false, 'unregistered'],
    // INVALID_ARGUMENT on the token itself: this token never works (revoked).
    [400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', true, 'invalid'],
    [400, 'INVALID_ARGUMENT', undefined, true, 'invalid'],
    // ...on the message: ours, every device alike.
    [400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', false, 'unavailable'],
    [400, 'INVALID_ARGUMENT', undefined, false, 'unavailable'],
    [403, 'PERMISSION_DENIED', 'SENDER_ID_MISMATCH', false, 'invalid'],
    [403, 'PERMISSION_DENIED', undefined, false, 'unavailable'],
    [429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED', false, 'rate_limited'],
    [500, 'INTERNAL', 'INTERNAL', false, 'unavailable'],
    [503, 'UNAVAILABLE', 'UNAVAILABLE', false, 'unavailable'],
    [502, 'UNKNOWN', undefined, false, 'unavailable'],
    [413, 'INVALID_ARGUMENT', undefined, false, 'unavailable'],
  ] as const)('%i %s %s (token field %s) → %s', async (status, canonical, errorCode, tokenField, reason) => {
    const h = harness({ send: () => fcmError(status, canonical, errorCode, {}, tokenField) });
    expect(await h.send()).toEqual({ ok: false, reason });
    expect(h.sendCalls).toHaveLength(1);
    expect(metrics.trackPushSend).toHaveBeenCalledWith('android', reason, expect.any(Number));
  });

  it('mapFcmAnswer: 2xx ok; a code without a body still maps by status', () => {
    expect(mapFcmAnswer(200, undefined)).toEqual({ ok: true });
    // UNREGISTERED alone revokes; a 404 without it is the service's trouble.
    expect(mapFcmAnswer(404, 'UNREGISTERED')).toEqual({ ok: false, reason: 'unregistered' });
    expect(mapFcmAnswer(404, undefined)).toEqual({ ok: false, reason: 'unavailable' });
    expect(mapFcmAnswer(404, 'NOT_FOUND')).toEqual({ ok: false, reason: 'unavailable' });
    expect(mapFcmAnswer(400, 'INVALID_ARGUMENT', { tokenRefused: true })).toEqual({ ok: false, reason: 'invalid' });
    expect(mapFcmAnswer(400, 'INVALID_ARGUMENT')).toEqual({ ok: false, reason: 'unavailable' });
    expect(mapFcmAnswer(429, undefined)).toEqual({ ok: false, reason: 'rate_limited' });
    expect(mapFcmAnswer(500, 'QUOTA_EXCEEDED')).toEqual({ ok: false, reason: 'rate_limited' });
    expect(mapFcmAnswer(302, undefined)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('an error body that is not JSON maps by status', async () => {
    const h = harness({ send: () => new Response('<html>bad gateway</html>', { status: 502 }) });
    expect(await h.send()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a network error is unavailable', async () => {
    const h = harness({ send: () => { throw new TypeError('fetch failed'); } });
    expect(await h.send()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a send the carrier never answers is cut at the timeout: unavailable', async () => {
    const h = harness({
      timeoutMs: 50,
      send: () => new Promise<Response>(() => {}),
    });
    const started = Date.now();
    expect(await h.send()).toEqual({ ok: false, reason: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('the abort reaches the transport at the timeout', async () => {
    let aborted = false;
    const fetchImpl: PushFetch = async (url, init) => {
      if (url === FCM_OAUTH_TOKEN_URL) return Response.json({ access_token: 'a', expires_in: 3599 });
      return new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }));
    };
    const sender = new FcmSender({ credentials: CREDS, fetchImpl, timeoutMs: 30 });
    expect(await sender.send(DEVICE, RING, { ttlMs: 20_000 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(aborted).toBe(true);
  });

  it('429: never retried, and the device is held back until its Retry-After', async () => {
    const h = harness({ send: (n) => (n === 1 ? fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED', { 'retry-after': '30' }) : Response.json({ name: 'm' })) });
    expect(await h.send()).toEqual({ ok: false, reason: 'rate_limited' });
    expect(h.sendCalls).toHaveLength(1);
    h.advance(29_999);
    // Held back by its own Retry-After, unsent: this device's trouble alone (no process-wide pause).
    expect(await h.send()).toEqual({ ok: false, reason: 'rate_limited', scope: 'device' });
    expect(h.sendCalls).toHaveLength(1);
    expect(metrics.trackPushSend).toHaveBeenLastCalledWith('android', 'rate_limited', undefined);
    // Another device is not held back.
    expect(await h.send({ ...DEVICE, id: 'row-2', fcm_token: 'other' })).toEqual({ ok: true });
    h.advance(1);
    expect(await h.send()).toEqual({ ok: true });
    expect(h.sendCalls).toHaveLength(3);
  });

  it('429 without Retry-After holds the device back 10 s', async () => {
    const h = harness({ send: (n) => (n === 1 ? fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED') : Response.json({ name: 'm' })) });
    await h.send();
    h.advance(9_999);
    expect(await h.send()).toEqual({ ok: false, reason: 'rate_limited', scope: 'device' });
    h.advance(1);
    expect(await h.send()).toEqual({ ok: true });
  });
});

describe('FcmSender: metrics and logs', () => {
  it('counts each send with its duration; a failure is logged by device row id, type and call id, never a token', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const h = harness({ send: (n) => (n === 1 ? Response.json({ name: 'm' }) : fcmError(404, 'NOT_FOUND', 'UNREGISTERED')) });
    await h.send();
    expect(metrics.trackPushSend).toHaveBeenLastCalledWith('android', 'ok', expect.any(Number));
    expect(warn).not.toHaveBeenCalled();
    await h.send();
    expect(metrics.trackPushSend).toHaveBeenLastCalledWith('android', 'unregistered', expect.any(Number));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toEqual({
      platform: 'android', push_device_id: 'row-1', push_type: 'ring', call_id: 'call-1',
      reason: 'unregistered', carrier_status: 404, carrier_code: 'UNREGISTERED',
    });
    const logged = JSON.stringify(warn.mock.calls);
    for (const secret of ['fcm-token-secret-1', 'offer-token-secret', 'access-1']) expect(logged).not.toContain(secret);
  });
});
