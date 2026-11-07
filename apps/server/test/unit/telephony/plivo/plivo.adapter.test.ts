// The Plivo adapter against a fake `fetch`: what each REST call sends (fixed host, Basic
// auth, no redirects, a timeout), how each answer is read, the refusals made before
// anything is sent, the answer XML, and that the auth token never reaches a log line.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logs = vi.hoisted(() => ({ lines: [] as unknown[] }));
vi.mock('@magick-agency/observability', () => {
  const record = (...args: unknown[]) => { logs.lines.push(args); };
  return {
    createChildLogger: () => ({ info: record, warn: record, error: record, debug: record }),
    logger: { info: record, warn: record, error: record, debug: record },
  };
});
const refusals = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/voice', () => ({ trackCarrierDialRefusal: refusals.track }));

import {
  PlivoAdapter,
  PLIVO_HANGUP_XML,
  createPlivoAdapter,
  setPlivoTransportForTests,
  plivoNumber,
  renderPlivoAnswerXml,
  DEFAULT_PLIVO_SETTINGS,
  type PlivoFetch,
} from '../../../../src/telephony/plivo/plivo.adapter.js';
import { InMemoryPlivoDialRateLimiter, type PlivoDialRateLimiter } from '../../../../src/telephony/plivo/plivo-dial-rate.js';
import { computePlivoV3Signature } from '../../../../src/telephony/plivo/plivo-signature.js';
import { Secret } from '../../../../src/telephony/credentials/secret.js';
import {
  CarrierAuthRejectedError,
  CarrierRateLimitedError,
  CarrierRequestTimeoutError,
  isDialOutcomeUnknown,
} from '../../../../src/telephony/carrier-errors.js';
import type { OutboundCallRequest } from '../../../../src/telephony/types.js';
import type { AppConfig } from '../../../../src/config/index.js';

const AUTH_ID = 'MAABCDEFGHIJKLMNOPQR';
const TOKEN = 'tok_SECRET_value_0123456789';
const BASE = 'https://srv.example.com/api/v1/webhooks/plivo';
const REQUEST_UUID = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';

interface Sent { url: string; init: RequestInit }

function fakeFetch(responses: Array<{ status: number; body?: string } | Error>) {
  const sent: Sent[] = [];
  const impl: PlivoFetch = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('no scripted response');
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => r.body ?? '' };
  });
  return { impl, sent };
}

function adapter(fetchImpl: PlivoFetch, over: Partial<ConstructorParameters<typeof PlivoAdapter>[0]> = {}) {
  return new PlivoAdapter({
    ...DEFAULT_PLIVO_SETTINGS,
    webhookBaseUrl: BASE,
    authId: AUTH_ID,
    authToken: new Secret(TOKEN),
    fetchImpl,
    rateLimiter: new InMemoryPlivoDialRateLimiter(),
    sleep: async () => undefined,
    ...over,
  });
}

const dial = (over: Partial<OutboundCallRequest> = {}): OutboundCallRequest => ({
  callId: 'c0ffee00-0000-4000-8000-000000000001',
  to: '+91 98123-45678',
  from: '+918035550100',
  webhookUrl: `${BASE}/webrtc-answer/c0ffee00-0000-4000-8000-000000000001?token=answer-tok&w=2`,
  statusCallbackUrl: `${BASE}/webrtc-status/c0ffee00-0000-4000-8000-000000000001?token=status-tok&w=2`,
  maxDuration: 3600,
  ...over,
});

const created = { status: 201, body: JSON.stringify({ message: 'call fired', request_uuid: REQUEST_UUID, api_id: 'a1' }) };

beforeEach(() => { logs.lines.length = 0; refusals.track.mockReset(); });

describe('plivoNumber', () => {
  it.each([
    ['+919812345678', '919812345678'],
    ['+91 98123-45678', '919812345678'],
    ['(+1) 415.555.0100', '14155550100'],
    ['14155550100', '14155550100'],
  ])('%s → %s', (raw, want) => {
    expect(plivoNumber(raw, 'to')).toBe(want);
  });

  it.each([
    'sip:alice@phone.plivo.com',
    '919812345678<14155550100',
    '+0919812345678',
    '12345',
    '+9198123456781234567',
    '',
    'abc',
  ])('refuses %j', (raw) => {
    expect(() => plivoNumber(raw, 'to')).toThrow(/not a phone number/);
  });
});

describe('PlivoAdapter.initiateCall', () => {
  it('POSTs the create-call to the fixed host with Basic auth, no redirects and a timeout', async () => {
    const f = fakeFetch([created]);
    const res = await adapter(f.impl).initiateCall(dial());
    expect(res).toEqual({ providerCallId: '', providerRequestId: REQUEST_UUID });
    expect(f.sent).toHaveLength(1);
    const { url, init } = f.sent[0]!;
    expect(url).toBe(`https://api.plivo.com/v1/Account/${AUTH_ID}/Call/`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['Authorization'])
      .toBe(`Basic ${Buffer.from(`${AUTH_ID}:${TOKEN}`).toString('base64')}`);
    expect(JSON.parse(String(init.body))).toEqual({
      from: '918035550100',
      to: '919812345678',
      answer_url: dial().webhookUrl,
      answer_method: 'POST',
      hangup_url: dial().statusCallbackUrl,
      hangup_method: 'POST',
      ring_url: dial().statusCallbackUrl,
      ring_method: 'POST',
      time_limit: 3600,
      ring_timeout: 45,
    });
  });

  it('sends time_limit on every dial, whole seconds', async () => {
    const f = fakeFetch([created, created]);
    const a = adapter(f.impl);
    await a.initiateCall(dial({ maxDuration: 90.7 }));
    await a.initiateCall(dial({ maxDuration: 1 }));
    expect(f.sent.map((s) => JSON.parse(String(s.init.body)).time_limit)).toEqual([90, 1]);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('refuses a max duration of %s before sending', async (maxDuration) => {
    const f = fakeFetch([created]);
    await expect(adapter(f.impl).initiateCall(dial({ maxDuration }))).rejects.toThrow(/time_limit/);
    expect(f.sent).toHaveLength(0);
  });

  it('refuses a number that is not a single phone number before sending', async () => {
    const f = fakeFetch([created]);
    await expect(adapter(f.impl).initiateCall(dial({ to: '919812345678<14155550100' }))).rejects.toThrow(/'to'/);
    await expect(adapter(f.impl).initiateCall(dial({ from: 'sip:x@y' }))).rejects.toThrow(/'from'/);
    expect(f.sent).toHaveLength(0);
  });

  it('refuses callback URLs off the env webhook origin, or not https, and an unset base', async () => {
    const f = fakeFetch([created]);
    await expect(adapter(f.impl).initiateCall(dial({ webhookUrl: 'https://evil.example/x' }))).rejects.toThrow(/answer_url/);
    await expect(adapter(f.impl).initiateCall(dial({ statusCallbackUrl: 'http://srv.example.com/api/v1/webhooks/plivo/s' }))).rejects.toThrow(/hangup_url/);
    await expect(adapter(f.impl, { webhookBaseUrl: '' }).initiateCall(dial())).rejects.toThrow(/PLIVO_WEBHOOK_BASE_URL/);
    expect(f.sent).toHaveLength(0);
  });

  it('a 401 is CarrierAuthRejectedError', async () => {
    const err = await adapter(fakeFetch([{ status: 401, body: 'unauthorized' }]).impl).initiateCall(dial()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CarrierAuthRejectedError);
    expect((err as CarrierAuthRejectedError).httpStatus).toBe(401);
    expect(isDialOutcomeUnknown(err)).toBe(false);
  });

  it('a 403 (a destination outside the geo permissions) is a plain refusal, not an auth rejection', async () => {
    const err = await adapter(fakeFetch([{ status: 403, body: '{"error":"geo permission"}' }]).impl).initiateCall(dial()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CarrierAuthRejectedError);
    expect((err as Error).message).toMatch(/403/);
  });

  it('a 429 is CarrierRateLimitedError from the carrier; a 5xx is a plain refusal', async () => {
    const e429 = await adapter(fakeFetch([{ status: 429 }]).impl).initiateCall(dial()).catch((e: unknown) => e);
    expect(e429).toBeInstanceOf(CarrierRateLimitedError);
    expect((e429 as CarrierRateLimitedError).source).toBe('carrier');
    const e500 = await adapter(fakeFetch([{ status: 500, body: 'boom' }]).impl).initiateCall(dial()).catch((e: unknown) => e);
    expect((e500 as Error).message).toMatch(/error 500/);
    expect(isDialOutcomeUnknown(e500)).toBe(false);
  });

  it.each([
    ['not JSON', 'oops'],
    ['no request_uuid', '{"message":"call fired"}'],
    ['an empty request_uuid', '{"request_uuid":""}'],
    ['two request_uuids', `{"request_uuid":["${REQUEST_UUID}","x"]}`],
  ])('a 2xx with %s is an unknown outcome', async (_what, body) => {
    const err = await adapter(fakeFetch([{ status: 201, body }]).impl).initiateCall(dial()).catch((e: unknown) => e);
    expect(isDialOutcomeUnknown(err)).toBe(true);
  });

  it('accepts a one-element request_uuid array', async () => {
    const res = await adapter(fakeFetch([{ status: 201, body: `{"request_uuid":["${REQUEST_UUID}"]}` }]).impl).initiateCall(dial());
    expect(res.providerRequestId).toBe(REQUEST_UUID);
  });

  it('a timeout is an unknown outcome and is not retried', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const f = fakeFetch([timeout, created]);
    const err = await adapter(f.impl).initiateCall(dial()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CarrierRequestTimeoutError);
    expect(isDialOutcomeUnknown(err)).toBe(true);
    expect(f.sent).toHaveLength(1);
  });

  it('a network error is a plain refusal', async () => {
    const err = await adapter(fakeFetch([new TypeError('fetch failed')]).impl).initiateCall(dial()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(isDialOutcomeUnknown(err)).toBe(false);
  });

  it('refuses unsent when the calls-per-second gate gives no slot in time', async () => {
    const full: PlivoDialRateLimiter = { tryAcquire: vi.fn(async () => ({ admitted: false as const, retryAfterMs: 900 })) };
    const f = fakeFetch([created]);
    const err = await adapter(f.impl, { rateLimiter: full, dialRateMaxWaitMs: 500 }).initiateCall(dial()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CarrierRateLimitedError);
    expect((err as CarrierRateLimitedError).source).toBe('local_gate');
    expect(f.sent).toHaveLength(0);
    expect(full.tryAcquire).toHaveBeenCalledWith(AUTH_ID, 2);
  });

  it('gates on the account, at PLIVO_CALLS_PER_SECOND', async () => {
    const limiter = { tryAcquire: vi.fn(async () => ({ admitted: true as const })) };
    await adapter(fakeFetch([created]).impl, { rateLimiter: limiter, callsPerSecond: 7 }).initiateCall(dial());
    expect(limiter.tryAcquire).toHaveBeenCalledWith(AUTH_ID, 7);
  });

  it('never logs the auth token, the Basic header or a callback token', async () => {
    await adapter(fakeFetch([created]).impl).initiateCall(dial());
    await adapter(fakeFetch([{ status: 401 }]).impl).initiateCall(dial()).catch(() => undefined);
    const text = JSON.stringify(logs.lines);
    expect(logs.lines.length).toBeGreaterThan(0);
    for (const secret of [TOKEN, Buffer.from(`${AUTH_ID}:${TOKEN}`).toString('base64'), 'answer-tok', 'status-tok']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('PlivoAdapter.initiateCall: carrier_dial_refusals_total', () => {
  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

  it.each([
    ['a 401', 'auth_rejected', [{ status: 401 }]],
    ['a 429', 'rate_limited', [{ status: 429 }]],
    ['a 403', 'refused', [{ status: 403, body: 'geo' }]],
    ['a 5xx', 'refused', [{ status: 503, body: 'down' }]],
    ['a 2xx with no request_uuid', 'outcome_unknown', [{ status: 201, body: '{}' }]],
    ['a timeout', 'outcome_unknown', [timeout()]],
  ] as const)('%s counts once as %s', async (_what, kind, responses) => {
    await adapter(fakeFetch([...responses]).impl).initiateCall(dial()).catch(() => undefined);
    expect(refusals.track.mock.calls).toEqual([['plivo', kind]]);
  });

  it('the calls-per-second gate refusing counts as rate_limited', async () => {
    const full: PlivoDialRateLimiter = { tryAcquire: vi.fn(async () => ({ admitted: false as const, retryAfterMs: 900 })) };
    await adapter(fakeFetch([created]).impl, { rateLimiter: full, dialRateMaxWaitMs: 500 }).initiateCall(dial()).catch(() => undefined);
    expect(refusals.track.mock.calls).toEqual([['plivo', 'rate_limited']]);
  });

  it('a placed call, a refusal before the gate and a network error do not count', async () => {
    await adapter(fakeFetch([created]).impl).initiateCall(dial());
    await adapter(fakeFetch([created]).impl).initiateCall(dial({ to: 'sip:x@y' })).catch(() => undefined);
    await adapter(fakeFetch([new TypeError('fetch failed')]).impl).initiateCall(dial()).catch(() => undefined);
    expect(refusals.track).not.toHaveBeenCalled();
  });
});

describe('PlivoAdapter.endCall and cancelDialRequest', () => {
  const CALL_UUID = '4f6a2c1e-8b3d-4e5f-9a1b-2c3d4e5f6a7b';

  it('hangs up by call id with DELETE …/Call/{id}/; 204 and 404 resolve', async () => {
    const f = fakeFetch([{ status: 204 }, { status: 404 }]);
    const a = adapter(f.impl);
    await a.endCall(CALL_UUID);
    await a.endCall(CALL_UUID);
    expect(f.sent.map((s) => [s.init.method, s.url])).toEqual([
      ['DELETE', `https://api.plivo.com/v1/Account/${AUTH_ID}/Call/${CALL_UUID}/`],
      ['DELETE', `https://api.plivo.com/v1/Account/${AUTH_ID}/Call/${CALL_UUID}/`],
    ]);
    expect(f.sent[0]!.init.redirect).toBe('error');
    expect(f.sent[0]!.init.body).toBeUndefined();
  });

  it.each(['', '   ', '../', 'a/b', '?x=1', 'a'.repeat(65)])(
    'refuses a hangup or cancel with id %j and sends nothing (an empty id would end every call on the account)',
    async (id) => {
      const f = fakeFetch([{ status: 204 }, { status: 204 }]);
      const a = adapter(f.impl);
      await expect(a.endCall(id)).rejects.toThrow(/refused/);
      await expect(a.cancelDialRequest(id)).rejects.toThrow(/refused/);
      expect(f.sent).toHaveLength(0);
    },
  );

  it('a hangup refused for auth, or any other error, throws', async () => {
    await expect(adapter(fakeFetch([{ status: 401 }]).impl).endCall(CALL_UUID)).rejects.toBeInstanceOf(CarrierAuthRejectedError);
    await expect(adapter(fakeFetch([{ status: 500 }]).impl).endCall(CALL_UUID)).rejects.toThrow(/error 500/);
  });

  it('cancels a ringing dial by request id with DELETE …/Request/{id}/', async () => {
    const f = fakeFetch([{ status: 204 }, { status: 404 }, { status: 500 }]);
    const a = adapter(f.impl);
    expect(await a.cancelDialRequest(REQUEST_UUID)).toBe('canceled');
    expect(await a.cancelDialRequest(REQUEST_UUID)).toBe('not_found');
    await expect(a.cancelDialRequest(REQUEST_UUID)).rejects.toThrow(/error 500/);
    expect(f.sent[0]!.url).toBe(`https://api.plivo.com/v1/Account/${AUTH_ID}/Request/${REQUEST_UUID}/`);
    expect(f.sent[0]!.init.method).toBe('DELETE');
  });

  it('a hangup timeout is not an unknown dial outcome', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const err = await adapter(fakeFetch([timeout]).impl).endCall(CALL_UUID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CarrierRequestTimeoutError);
    expect(isDialOutcomeUnknown(err)).toBe(false);
  });
});

describe('answer XML', () => {
  const stream = 'wss://srv.example.com/api/v1/webrtc-call/c1/pstn-stream?token=x&w=2';
  const recCb = 'https://srv.example.com/api/v1/webhooks/plivo/webrtc-recording/c1?token=a&w=2';

  it('is byte-for-byte what Plivo’s own SDK renders for the same elements', () => {
    // Expected string rendered by plivo@4.79.0 `Response().addRecord(…).addStream(…).toXML()`.
    expect(renderPlivoAnswerXml(stream, {
      enableRecording: true, recordingCallbackUrl: recCb, recordingMaxLengthSeconds: 3600, maxDurationSeconds: 3600,
    })).toBe(
      '<Response><Record recordSession="true" redirect="false" maxLength="3600" callbackUrl="https://srv.example.com/api/v1/webhooks/plivo/webrtc-recording/c1?token=a&amp;w=2" callbackMethod="POST" fileFormat="mp3"/>'
      + '<Stream bidirectional="true" audioTrack="inbound" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000" streamTimeout="3600">wss://srv.example.com/api/v1/webrtc-call/c1/pstn-stream?token=x&amp;w=2</Stream></Response>',
    );
    expect(PLIVO_HANGUP_XML).toBe('<Response><Hangup/></Response>');
  });

  it('records nothing unless asked, and omits streamTimeout with no max duration', () => {
    expect(renderPlivoAnswerXml(stream)).toBe(
      '<Response><Stream bidirectional="true" audioTrack="inbound" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">wss://srv.example.com/api/v1/webrtc-call/c1/pstn-stream?token=x&amp;w=2</Stream></Response>',
    );
  });

  it('caps the recording at the call’s max duration, else four hours (Plivo’s default is 60 s)', () => {
    expect(renderPlivoAnswerXml(stream, { enableRecording: true, maxDurationSeconds: 900 })).toContain('maxLength="900"');
    expect(renderPlivoAnswerXml(stream, { enableRecording: true })).toContain('maxLength="14400"');
  });

  it('escapes every XML metacharacter in the URLs', () => {
    const xml = renderPlivoAnswerXml('wss://h.test/s?a=1&b="2"<x>\'', { enableRecording: true, recordingCallbackUrl: 'https://h.test/r?a=1&b="2"' });
    expect(xml).toContain('>wss://h.test/s?a=1&amp;b=&quot;2&quot;&lt;x&gt;&apos;</Stream>');
    expect(xml).toContain('callbackUrl="https://h.test/r?a=1&amp;b=&quot;2&quot;"');
  });

  it('refuses a stream URL that is not wss://', () => {
    expect(() => renderPlivoAnswerXml('https://h.test/s')).toThrow(/wss/);
    expect(() => renderPlivoAnswerXml('javascript:alert(1)')).toThrow(/wss/);
  });

  it('generateAnswerResponse renders the same XML', () => {
    expect(adapter(fakeFetch([]).impl).generateAnswerResponse('c1', stream, { maxDurationSeconds: 60 }))
      .toBe(renderPlivoAnswerXml(stream, { maxDurationSeconds: 60 }));
  });
});

describe('verifyCarrierRequest', () => {
  const url = `${BASE}/webrtc-status/c1?token=t&w=1`;
  const params = { CallUUID: 'u', CallStatus: 'ringing' };
  const signed = (token: string) => ({
    'x-plivo-signature-v3': computePlivoV3Signature(token, 'POST', url, params, 'nonce'),
    'x-plivo-signature-v3-nonce': 'nonce',
  });

  it('accepts the current token and a token still in the rotation grace, refuses another', () => {
    const a = adapter(fakeFetch([]).impl, { previousAuthTokens: [new Secret('old-token-in-grace')] });
    expect(a.verifyCarrierRequest({ method: 'POST', url, params, headers: signed(TOKEN) })).toBe(true);
    expect(a.verifyCarrierRequest({ method: 'POST', url, params, headers: signed('old-token-in-grace') })).toBe(true);
    expect(a.verifyCarrierRequest({ method: 'POST', url, params, headers: signed('stranger') })).toBe(false);
    expect(adapter(fakeFetch([]).impl).verifyCarrierRequest({ method: 'POST', url, params, headers: signed('old-token-in-grace') })).toBe(false);
  });

  it('the legacy body-signature check fails closed', () => {
    expect(adapter(fakeFetch([]).impl).validateWebhookSignature('{}', 'sig')).toBe(false);
  });
});

describe('getCallStatus and getRecordingUrl', () => {
  const CALL_UUID = '4f6a2c1e-8b3d-4e5f-9a1b-2c3d4e5f6a7b';

  it('reads the CDR, and is unknown on a miss, an error or a bad id', async () => {
    const f = fakeFetch([
      { status: 200, body: JSON.stringify({ call_status: 'Completed', call_duration: 42, hangup_cause_name: 'Normal Hangup', hangup_cause_code: 4000 }) },
      { status: 404 },
      new TypeError('fetch failed'),
    ]);
    const a = adapter(f.impl);
    expect(await a.getCallStatus(CALL_UUID)).toEqual({ status: 'completed', duration: 42, errorCode: '4000', errorMessage: 'Normal Hangup' });
    expect(await a.getCallStatus(CALL_UUID)).toEqual({ status: 'unknown' });
    expect(await a.getCallStatus(CALL_UUID)).toEqual({ status: 'unknown' });
    expect(await a.getCallStatus('')).toEqual({ status: 'unknown' });
    expect(f.sent[0]!.url).toBe(`https://api.plivo.com/v1/Account/${AUTH_ID}/Call/${CALL_UUID}/`);
    expect(f.sent).toHaveLength(3);
  });

  it('lists the call’s recordings and returns the first URL, else null', async () => {
    const rec = 'https://media.plivo.com/v1/Account/MAABCDEFGHIJKLMNOPQR/Recording/r1.mp3';
    const f = fakeFetch([
      { status: 200, body: JSON.stringify({ objects: [{ recording_url: rec }] }) },
      { status: 200, body: JSON.stringify({ objects: [] }) },
    ]);
    const a = adapter(f.impl);
    expect(await a.getRecordingUrl(CALL_UUID)).toBe(rec);
    expect(await a.getRecordingUrl(CALL_UUID)).toBeNull();
    expect(await a.getRecordingUrl('')).toBeNull();
    expect(f.sent[0]!.url).toBe(`https://api.plivo.com/v1/Account/${AUTH_ID}/Recording/?call_uuid=${CALL_UUID}`);
    expect(f.sent[0]!.init.method).toBe('GET');
  });
});

describe('parseWebhookEvent', () => {
  it('reads a status callback, and a recording as an informational event', () => {
    const a = adapter(fakeFetch([]).impl);
    expect(a.parseWebhookEvent({ CallUUID: 'u1', CallStatus: 'ringing' }, {}).eventType).toBe('ringing');
    const rec = a.parseWebhookEvent({ CallUUID: 'u1', RecordUrl: 'https://media.plivo.com/x.mp3' }, {});
    expect(rec.eventType).toBe('error');
    expect(rec.metadata).toMatchObject({ informational: true, recordingUrl: 'https://media.plivo.com/x.mp3' });
  });
});

describe('createPlivoAdapter (the BYOC factory)', () => {
  const config = { telephony: { plivo: { ...DEFAULT_PLIVO_SETTINGS, webhookBaseUrl: BASE, callsPerSecond: 3 } } } as unknown as AppConfig;
  const credential = {
    id: 'cred-1', tenantId: 't1', provider: 'plivo', accountRef: AUTH_ID, publicConfig: { auth_id: AUTH_ID }, version: 2,
    secret: new Secret({ auth_token: TOKEN }),
    previous: [{ version: 1, secret: new Secret({ auth_token: 'old-token' }) }],
  };

  it('builds an adapter on the credential’s account that checks signatures with every token', () => {
    const a = createPlivoAdapter(credential, config);
    expect(a.name).toBe('plivo');
    const url = `${BASE}/s`;
    for (const t of [TOKEN, 'old-token']) {
      const headers = { 'x-plivo-signature-v3': computePlivoV3Signature(t, 'POST', url, {}, 'n'), 'x-plivo-signature-v3-nonce': 'n' };
      expect(a.verifyCarrierRequest({ method: 'POST', url, params: {}, headers })).toBe(true);
    }
  });

  it('does not print its secrets', () => {
    const a = createPlivoAdapter(credential, config);
    expect(JSON.stringify(a)).not.toContain(TOKEN);
    expect(JSON.stringify(a)).not.toContain('old-token');
  });

  it('sends through the test transport when one is set (the host in the URL stays Plivo`s fixed one), and through `fetch` again once cleared', async () => {
    const f = fakeFetch([created]);
    setPlivoTransportForTests(f.impl);
    try {
      await createPlivoAdapter(credential, config).cancelDialRequest(REQUEST_UUID).catch(() => undefined);
    } finally {
      setPlivoTransportForTests(null);
    }
    expect(f.sent[0]!.url).toBe(`https://api.plivo.com/v1/Account/${AUTH_ID}/Request/${REQUEST_UUID}/`);
    const g = fakeFetch([created]);
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(g.impl as never);
    try {
      await createPlivoAdapter(credential, config).cancelDialRequest(REQUEST_UUID).catch(() => undefined);
    } finally {
      stub.mockRestore();
    }
    expect(f.sent).toHaveLength(1);
    expect(g.sent).toHaveLength(1);
  });

  it('refuses a credential with no auth token or a malformed Auth ID', () => {
    expect(() => createPlivoAdapter({ ...credential, secret: new Secret({}) }, config)).toThrow(/no auth_token/);
    expect(() => createPlivoAdapter({ ...credential, accountRef: 'MA1/../x' }, config)).toThrow(/Auth ID/);
  });
});
