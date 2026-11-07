import { describe, expect, it } from 'vitest';
import {
  IPC_DEFAULT_DEADLINES_MS,
  IPC_EVENT_DECODERS,
  IPC_REQUEST_DECODERS,
  parseHealthBody,
  parseIpcEnvelope,
  parseRatePausedBody,
  parseReadyBody,
  parseShutdownBody,
} from '../../../src/cluster/ipc-protocol.js';

const roundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('parseIpcEnvelope', () => {
  it('decodes each kind', () => {
    expect(parseIpcEnvelope({ v: 1, kind: 'event', type: 'analysis.wake', body: {} }))
      .toEqual({ v: 1, kind: 'event', type: 'analysis.wake', body: {} });
    expect(parseIpcEnvelope({ v: 1, kind: 'req', id: 7, type: 'health.ping', body: {}, deadlineMs: 1000, tp: '00-ab-cd-01' }))
      .toEqual({ v: 1, kind: 'req', id: 7, type: 'health.ping', body: {}, deadlineMs: 1000, tp: '00-ab-cd-01' });
    expect(parseIpcEnvelope({ v: 1, kind: 'res', id: 7, ok: true, body: { x: 1 } }))
      .toEqual({ v: 1, kind: 'res', id: 7, ok: true, body: { x: 1 } });
    expect(parseIpcEnvelope({ v: 1, kind: 'res', id: 7, ok: false, error: { code: 'timeout', message: 'm' } }))
      .toEqual({ v: 1, kind: 'res', id: 7, ok: false, error: { code: 'timeout', message: 'm' } });
  });

  it('refuses anything that is not an envelope of this version', () => {
    const bad: unknown[] = [
      null, undefined, 1, 'x', [], {},
      { v: 2, kind: 'event', type: 'analysis.wake', body: {} },
      { v: 1, kind: 'nope', type: 'analysis.wake' },
      { v: 1, kind: 'event', type: '' },
      { v: 1, kind: 'event', type: 'Has Spaces' },
      { v: 1, kind: 'event', type: 'x'.repeat(65) },
      { v: 1, kind: 'req', id: 0, type: 'health.ping', deadlineMs: 1 },
      { v: 1, kind: 'req', id: 1.5, type: 'health.ping', deadlineMs: 1 },
      { v: 1, kind: 'req', id: 1, type: 'health.ping' },
      { v: 1, kind: 'req', id: 1, type: 'health.ping', deadlineMs: -5 },
      { v: 1, kind: 'res', id: 1 },
      { v: 1, kind: 'res', id: 1, ok: false },
      { v: 1, kind: 'res', id: 1, ok: false, error: { code: 'made_up', message: 'm' } },
      { v: 1, kind: 'res', id: 1, ok: false, error: { code: 'timeout' } },
    ];
    for (const raw of bad) expect(parseIpcEnvelope(raw), JSON.stringify(raw)).toBeNull();
  });

  it('drops an oversized trace context and caps an error message rather than refusing the envelope', () => {
    const env = parseIpcEnvelope({ v: 1, kind: 'event', type: 'analysis.wake', body: {}, tp: 'x'.repeat(200) });
    expect(env && 'tp' in env).toBe(false);
    const res = parseIpcEnvelope({ v: 1, kind: 'res', id: 1, ok: false, error: { code: 'handler_error', message: 'm'.repeat(5000) } });
    expect(res && res.kind === 'res' && !res.ok && res.error.message.length).toBe(500);
  });
});

describe('body decoders', () => {
  it('ready', () => {
    expect(parseReadyBody({ role: 'analysis', slot: 0, pid: 42 })).toEqual({ role: 'analysis', slot: 0, pid: 42 });
    for (const bad of [{ role: 'pacing', slot: 0, pid: 1 }, { role: 'media', slot: -1, pid: 1 }, { role: 'media', slot: 0, pid: 0 }, null]) {
      expect(parseReadyBody(bad)).toBeNull();
    }
  });

  it('analysis.rate_paused', () => {
    expect(parseRatePausedBody({ untilMs: 1_700_000_000_000, consecutive: 2 })).toEqual({ untilMs: 1_700_000_000_000, consecutive: 2 });
    for (const bad of [{ untilMs: 0, consecutive: 1 }, { untilMs: 1, consecutive: 0 }, { untilMs: 1, consecutive: 65 }, { untilMs: '1', consecutive: 1 }]) {
      expect(parseRatePausedBody(bad)).toBeNull();
    }
  });

  it('shutdown and health', () => {
    expect(parseShutdownBody({ graceMs: 30_000 })).toEqual({ graceMs: 30_000 });
    expect(parseShutdownBody({ graceMs: 0 })).toBeNull();
    const health = { role: 'media', slot: 1, pid: 9, elu: 0.4, inFlight: 12, pausedForMs: 0, loopDelayP99Ms: 0, draining: false };
    expect(parseHealthBody(health)).toEqual(health);
    expect(parseHealthBody({ ...health, elu: 1.5 })).toBeNull();
    expect(parseHealthBody({ ...health, elu: Number.NaN })).toBeNull();
    expect(parseHealthBody({ ...health, draining: 'no' })).toBeNull();
    expect(parseHealthBody({ ...health, pausedForMs: -1 })).toBeNull();
  });

  it('pacing.invalidate is the pacing bus decoder itself', () => {
    const ev = { type: 'agent_available', sessionId: 's', campaignId: null };
    expect(IPC_EVENT_DECODERS['pacing.invalidate'](roundTrip(ev))).toEqual(ev);
    expect(IPC_EVENT_DECODERS['pacing.invalidate']({ type: 'made_up' })).toBeNull();
  });

  it('call.lease: a held lease whole, a release by its key, anything else refused', () => {
    const decode = IPC_EVENT_DECODERS['call.lease'];
    expect(decode({ op: 'released', concurrencyKey: 'k' })).toEqual({ op: 'released', concurrencyKey: 'k' });
    expect(decode({ op: 'held', lease: { callId: 'c', concurrencyKey: 'k', tenantId: 't', accountId: 'a' } })).toBeNull();
    expect(decode({ op: 'dropped', concurrencyKey: 'k' })).toBeNull();
  });

  it('reaper.snapshot: each unrecorded end says whether its dial outcome is unknown; anything else refused', () => {
    const decode = IPC_REQUEST_DECODERS['reaper.snapshot'].res;
    const snap = (unrecordedEnds: unknown) => ({ activeAttemptIds: [], unrecordedEnds, manualActiveIds: [], activeCallIds: [], leases: [] });
    const ends = [{ attemptId: 'a1', dialOutcomeUnknown: true }, { attemptId: 'a2', dialOutcomeUnknown: false }];
    expect(decode(roundTrip(snap(ends)))).toEqual(snap(ends));
    expect(decode(snap(['a1']))).toBeNull();
    expect(decode(snap([{ attemptId: 'a1' }]))).toBeNull();
    expect(decode(snap([{ attemptId: '', dialOutcomeUnknown: false }]))).toBeNull();
  });

  it('carrier.plivo_callback: the URL, params and only the two signature headers cross; anything else refused', () => {
    const decode = IPC_REQUEST_DECODERS['carrier.plivo_callback'].req;
    const body = {
      kind: 'answer', callId: 'c1', token: 'tok',
      url: 'https://agency.test/api/v1/webhooks/plivo/webrtc-answer/c1?token=tok&w=1',
      params: { CallUUID: 'u1', CallStatus: 'in-progress' },
      headers: { 'x-plivo-signature-v3': 'sig', 'x-plivo-signature-v3-nonce': 'n' },
    };
    expect(decode(roundTrip(body))).toEqual(body);
    expect(decode({ ...body, token: null })).toEqual({ ...body, token: null });
    expect(decode({ ...body, headers: {} })).toEqual({ ...body, headers: {} });
    // The scheme's case is not the URL's: a base written `HTTPS://` (which the config accepts,
    // and which dials and verifies in one process) crosses as written, so its signature still
    // verifies in the worker over the same bytes.
    const upper = { ...body, url: 'HTTPS://agency.test/api/v1/webhooks/plivo/webrtc-answer/c1?token=tok&w=1' };
    expect(decode(roundTrip(upper))).toEqual(upper);
    for (const bad of [
      { ...body, url: 'wss://agency.test/x' },
      { ...body, url: 'https//agency.test/x' },
      { ...body, url: 'not a url' },
      { ...body, kind: 'hangup' },
      { ...body, callId: '' },
      { ...body, token: 7 },
      { ...body, url: 'http://agency.test/x' },
      { ...body, url: `https://agency.test/${'x'.repeat(9000)}` },
      { ...body, params: { CallUUID: 7 } },
      { ...body, params: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, 'v'])) },
      // Any other header is refused, not dropped: the route sends only these two.
      { ...body, headers: { ...body.headers, cookie: 'x' } },
      { ...body, headers: { 'x-plivo-signature-v3': ['a'] } },
      { ...body, headers: undefined },
    ]) expect(decode(bad)).toBeNull();

    const answer = IPC_REQUEST_DECODERS['carrier.plivo_callback'].res;
    const xml = { statusCode: 200, contentType: 'text/xml', body: '<Response><Hangup/></Response>' };
    expect(answer(roundTrip(xml))).toEqual(xml);
    expect(answer({ statusCode: 503, contentType: 'application/json', body: '{"status":false}' })).not.toBeNull();
    for (const bad of [{ ...xml, contentType: 'text/html' }, { ...xml, statusCode: 99 }, { ...xml, body: { status: true } }, { ...xml, body: 'x'.repeat(65 * 1024) }]) {
      expect(answer(bad)).toBeNull();
    }
  });

  it('dialable.invalidate carries nothing, and refuses a body that is not an object', () => {
    const decode = IPC_EVENT_DECODERS['dialable.invalidate'];
    expect(decode(roundTrip({}))).toEqual({});
    expect(decode(undefined)).toEqual({});
    for (const bad of ['x', 1, null, ['a']]) expect(decode(bad)).toBeNull();
  });

  it('every request type has both decoders and a default deadline', () => {
    for (const type of Object.keys(IPC_REQUEST_DECODERS) as Array<keyof typeof IPC_REQUEST_DECODERS>) {
      expect(typeof IPC_REQUEST_DECODERS[type].req).toBe('function');
      expect(typeof IPC_REQUEST_DECODERS[type].res).toBe('function');
      expect(IPC_DEFAULT_DEADLINES_MS[type]).toBeGreaterThan(0);
    }
  });

  it('every decoder survives the JSON round trip of what it accepts', () => {
    const samples: Record<string, unknown> = {
      ready: { role: 'media', slot: 2, pid: 3 },
      'analysis.wake': {},
      'analysis.rate_paused': { untilMs: 5, consecutive: 1 },
      'pacing.invalidate': { type: 'account_capacity_freed', tenantId: 't', accountId: 'a' },
      'pacing.revoke': { campaignId: null, upTo: 7 },
      'station.attached': { sessionId: 's', campaignId: null, replicaId: 'h:mw0:1' },
      'station.detached': { sessionId: 's' },
      'station.snapshot': { replicaId: 'h:mw0:1', sessions: [{ sessionId: 's', campaignId: 'c' }] },
      'station.broadcast': { campaignId: 'c', frame: { event: 'campaign_state', campaign_id: 'c' } },
      'station.send': { sessionId: 's', frame: { event: 'queue', campaign_id: 'c', due: false, reason: 'queue_empty', next_due_at: null } },
      'concurrency.invalidate': { tenantId: 't', accountId: 'a' },
      'dialable.invalidate': {},
      'reaper.forget_unrecorded': { attemptIds: ['a1', 'a2'] },
      'voice.wake_self_heal': {},
      'call.lease': { op: 'held', lease: { callId: 'c', concurrencyKey: 'k', tenantId: 't', accountId: 'a', provider: 'voicelink' } },
    };
    for (const [type, decode] of Object.entries(IPC_EVENT_DECODERS)) {
      const sample = samples[type];
      expect(sample, `a sample for ${type}`).toBeDefined();
      expect((decode as (r: unknown) => unknown)(roundTrip(sample))).toEqual(sample);
    }
  });
});
