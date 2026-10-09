// PORT NOTE (magick-agency): ported from magic-voice-core/test/unit/api/middleware/rate-limit.middleware.test.ts@4850d1d9.
// Changed: mock specifiers only. The logger mock targets `@magick-agency/observability`; the
// metrics mock targets `@magick-agency/observability/metrics/voice` and returns
// `{ trackRateLimitRejected }` directly, since core's `metricsMock` helper (which stubs core's whole
// metrics module) is not carried. Every case is verbatim except:
//  - Phase 8: the exemption cases name agency's probes (`/healthz`, `/readyz`); +1 NEW route-class
//    case for the agency API at the console paths;
//  - Phase 8 (review, BLOCKING fix): the `tenant` bucket is deleted with platform API keys
//    (decision #5; see the middleware's header). MODIFIED (7), each now asserting that an
//    `x-api-key` / `x-mgkvc-tenant` header selects nothing: "keys on tenant + hashed api key",
//    "uses "anon" scope…", "an authenticated request keeps its tenant key…", "does NOT give an
//    authenticated webhook-path request the webhook ceiling", "CURRENT BEHAVIOR: a duplicated
//    x-api-key header…", "budgetFor resolves each bucket kind…", "labels the 429 with the bucket
//    ACTUALLY charged…", plus a comment in "keeps max, keyGenerator and allowList in lockstep…".
//    `hashApiKey` is no longer imported (deleted).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { mockRegister } = vi.hoisted(() => ({
  mockRegister: vi.fn(),
}));

vi.mock('@fastify/rate-limit', () => ({
  default: 'rate-limit-plugin',
}));

const { trackRateLimitRejected } = vi.hoisted(() => ({ trackRateLimitRejected: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/voice', () => ({ trackRateLimitRejected }));

import {
  registerRateLimit,
  budgetFor,
  routeClassFor,
  RATE_LIMIT_ROUTE_CLASSES,
} from '../../../../src/api/middleware/rate-limit.middleware.js';

/** Minimal request stub: the `max` resolver and keyGenerator read url/headers/ip. */
const apiReq = (url: string, ip = '1.2.3.4') => ({ url, headers: {}, ip }) as any;

describe('registerRateLimit', () => {
  beforeEach(() => {
    mockRegister.mockClear();
    trackRateLimitRejected.mockClear();
  });

  it('registers the rate-limit plugin on the fastify instance', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    expect(mockRegister).toHaveBeenCalledWith('rate-limit-plugin', expect.objectContaining({
      // `max` is a per-request resolver now (webhooks get their own ceiling),
      // so assert the resolved value rather than a literal.
      max: expect.any(Function),
      timeWindow: '1 minute',
    }));
    const options = mockRegister.mock.calls[0]![1] as any;
    expect(options.max(apiReq('/api/v1/calls'))).toBe(200);
  });

  it('uses the Redis store when a client is provided', async () => {
    const app = { register: mockRegister } as any;
    const redis = { fake: 'client' } as any;
    await registerRateLimit(app, redis);

    const options = mockRegister.mock.calls[0]![1] as any;
    expect(options.redis).toBe(redis);
  });

  it('omits the Redis store when no client is provided (in-memory fallback)', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const options = mockRegister.mock.calls[0]![1] as any;
    expect(options.redis).toBeUndefined();
  });

  it('an x-api-key header selects no bucket: the key is the peer IP, and never carries the header', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const options = mockRegister.mock.calls[0]![1] as any;
    const keyGen = options.keyGenerator;

    const key = keyGen({ headers: { 'x-api-key': 'my-key', 'x-mgkvc-tenant': 'tenant-1' }, ip: '1.2.3.4' });
    expect(key).toBe('1.2.3.4');
    expect(key).not.toContain('my-key');
  });

  it('rotating x-api-key or x-mgkvc-tenant does not rotate the bucket', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const options = mockRegister.mock.calls[0]![1] as any;
    const keyGen = options.keyGenerator;

    const keys = new Set(['a', 'b', 'c'].map((k) =>
      keyGen({ headers: { 'x-api-key': `key-${k}`, 'x-mgkvc-tenant': `tenant-${k}` }, ip: '1.2.3.4' })));
    expect([...keys]).toEqual(['1.2.3.4']);
  });

  it('falls back to IP when no x-api-key header', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const options = mockRegister.mock.calls[0]![1] as any;
    const keyGen = options.keyGenerator;

    expect(keyGen({ headers: {}, ip: '10.0.0.1' })).toBe('10.0.0.1');
  });

  it('configures errorResponseBuilder with retry info', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const options = mockRegister.mock.calls[0]![1] as any;
    const builder = options.errorResponseBuilder;

    const response = builder({}, { ttl: 30000 });
    expect(response).toEqual({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Try again in 30 seconds.',
      statusCode: 429,
      retryAfter: 30,
    });
  });

  it('rounds ttl to nearest second in error response', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const options = mockRegister.mock.calls[0]![1] as any;
    const builder = options.errorResponseBuilder;

    const response = builder({}, { ttl: 45500 });
    expect(response.retryAfter).toBe(46);
    expect(response.message).toContain('46 seconds');
  });

  it('propagates opts.max / opts.timeWindow, overriding the defaults', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app, null, { max: 1000, timeWindow: '5 minutes' });

    const options = mockRegister.mock.calls[0]![1] as any;
    expect(options.max(apiReq('/api/v1/calls'))).toBe(1000);
    expect(options.timeWindow).toBe('5 minutes');
  });

  it('accepts a numeric timeWindow (ms)', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app, null, { timeWindow: 60_000 });

    const options = mockRegister.mock.calls[0]![1] as any;
    expect(options.timeWindow).toBe(60_000);
    // max still falls back to the default when only timeWindow is supplied.
    expect(options.max(apiReq('/api/v1/calls'))).toBe(200);
  });

  // ── Provider-webhook bucket + ceiling ──────────────────────────────────────
  // Regression cover for the 2026-09-03 VoiceLink incident: carrier status
  // callbacks are unauthenticated, so they all keyed on one client IP and were
  // budgeted like tenant API traffic — 17.5k were rejected with 429, and each
  // rejection was retried by the carrier, amplifying the breach.

  it('gives webhook routes the higher webhookMax ceiling, other routes the normal max', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const { max } = mockRegister.mock.calls[0]![1] as any;
    expect(max(apiReq('/api/v1/webhooks/voicelink/static-status/abc'))).toBe(1000);
    expect(max(apiReq('/api/v1/calls'))).toBe(200);
  });

  it('applies webhookMax across every provider webhook mount, not just telephony', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const { max } = mockRegister.mock.calls[0]![1] as any;
    for (const url of [
      '/api/v1/webhooks/vobiz/inbound-status',
      '/api/v1/webhooks/twilio/ivr-gather/s1/step1',
      '/api/v1/webhooks/whatsapp',
      '/api/v1/webhooks/greenapi/conn-1',
      '/api/v1/webhooks/resend',
    ]) {
      expect(max(apiReq(url))).toBe(1000);
    }
  });

  it('matches the webhook prefix on the PATH, ignoring the query string', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const options = mockRegister.mock.calls[0]![1] as any;
    // VoiceLink's status callback carries ?token=… — the very route that was
    // being 429'd. Note a bare `startsWith` would also pass here; the split
    // matters only for the exact-prefix comparison, so this pins the
    // real-world URL shape end to end rather than the stripping itself.
    const url = '/api/v1/webhooks/voicelink/static-status/abc?token=deadbeef';
    expect(options.max(apiReq(url))).toBe(1000);
    expect(options.keyGenerator(apiReq(url, '9.9.9.9'))).toBe('wh:9.9.9.9');
  });

  it('puts webhooks in their own key namespace so they cannot exhaust other unauthenticated traffic', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const { keyGenerator } = mockRegister.mock.calls[0]![1] as any;
    // Same IP, different buckets — this is what makes a per-request `max` safe.
    expect(keyGenerator(apiReq('/api/v1/webhooks/voicelink/status/x', '5.5.5.5'))).toBe('wh:5.5.5.5');
    expect(keyGenerator(apiReq('/healthz', '5.5.5.5'))).toBe('5.5.5.5');
  });

  it('does not treat a path merely CONTAINING the webhook prefix as a webhook', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const options = mockRegister.mock.calls[0]![1] as any;
    const url = '/api/v1/calls?next=/api/v1/webhooks/voicelink';
    expect(options.max(apiReq(url))).toBe(200);
    expect(options.keyGenerator(apiReq(url, '7.7.7.7'))).toBe('7.7.7.7');
  });

  it('an x-api-key on a webhook path stays in the webhook bucket', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const { keyGenerator } = mockRegister.mock.calls[0]![1] as any;
    const key = keyGenerator({
      url: '/api/v1/webhooks/voicelink/status/x',
      headers: { 'x-api-key': 'k', 'x-mgkvc-tenant': 't1' },
      ip: '1.2.3.4',
    });
    expect(key).toBe('wh:1.2.3.4');
  });

  it('measures an x-api-key webhook-path request against the webhook ceiling of the bucket it is in', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const options = mockRegister.mock.calls[0]![1] as any;
    const req = {
      url: '/api/v1/webhooks/voicelink/static-status/a',
      headers: { 'x-api-key': 'k', 'x-mgkvc-tenant': 't1' },
      ip: '1.2.3.4',
    };
    // PORT NOTE (magick-agency): core put this in the TENANT bucket at the tenant
    // ceiling. With no tenant bucket it is a webhook request like any other, and
    // the ceiling still follows the bucket (one counter, one budget).
    expect(options.keyGenerator(req)).toBe('wh:1.2.3.4');
    expect(options.max(req)).toBe(1000);
  });

  it('keeps max and keyGenerator in lockstep across every auth/path combination', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app, null, { max: 200, webhookMax: 300 });

    const options = mockRegister.mock.calls[0]![1] as any;
    const cases = [
      { url: '/api/v1/webhooks/x', headers: {}, ip: 'i' },
      { url: '/api/v1/calls', headers: {} , ip: 'i' },
      { url: '/api/v1/webhooks/x', headers: { 'x-api-key': 'k' }, ip: 'i' },
      { url: '/api/v1/calls', headers: { 'x-api-key': 'k' }, ip: 'i' },
    ];
    for (const req of cases) {
      const isWebhookBucket = String(options.keyGenerator(req)).startsWith('wh:');
      // The invariant: webhook ceiling iff webhook bucket.
      expect(options.max(req) === 300).toBe(isWebhookBucket);
    }
  });

  it('propagates an explicit webhookMax override', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app, null, { max: 50, webhookMax: 5000 });

    const { max } = mockRegister.mock.calls[0]![1] as any;
    expect(max(apiReq('/api/v1/webhooks/voicelink/static-status/a'))).toBe(5000);
    expect(max(apiReq('/api/v1/calls'))).toBe(50);
  });

  it('treats an explicit null redis the same as absent (in-memory fallback)', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app, null);

    const options = mockRegister.mock.calls[0]![1] as any;
    expect(options.redis).toBeUndefined();
    expect('redis' in options).toBe(false);
  });

  it('rounds a sub-second ttl up to at least the nearest second boundary', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const options = mockRegister.mock.calls[0]![1] as any;
    const builder = options.errorResponseBuilder;

    // 400ms rounds to 0 seconds (Math.round) — documents current behavior.
    const response = builder({}, { ttl: 400 });
    expect(response.retryAfter).toBe(0);
    expect(response.message).toContain('0 seconds');
  });

  it('a duplicated x-api-key header (array) no longer throws: it is not read at all', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const options = mockRegister.mock.calls[0]![1] as any;
    const keyGen = options.keyGenerator;

    // Core: a repeated header arrived as string[] and hashApiKey(array) threw in
    // crypto's .update() — a 500 on any route. The header now selects nothing.
    expect(keyGen({ headers: { 'x-api-key': ['a', 'b'], 'x-mgkvc-tenant': 't1' }, ip: '1.2.3.4' })).toBe('1.2.3.4');
  });

  // ── Generalised buckets (Part 4): carrier media, /internal, probe exemption ──
  // PR #357 namespaced /api/v1/webhooks/* only, leaving every OTHER
  // unauthenticated route in one shared `<ip>` bucket at the tenant ceiling —
  // the same failure one door along, and /internal/* is the live one (master
  // authenticates with Authorization: Bearer, so its whole fleet keyed on one
  // egress IP, and master retries).

  it('gives carrier-facing media paths their own bucket and ceiling', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const { max, keyGenerator } = mockRegister.mock.calls[0]![1] as any;
    for (const url of [
      '/api/v1/media-stream/abc-123',
      // The WS-static route NESTS under the AI media-stream prefix on purpose
      // (nginx's upgrade block), so one prefix covers both.
      '/api/v1/media-stream/static/call-1/token-1',
      '/api/v1/static-media-stream/call-1/token-1',
      '/api/v1/tts-audio/deadbeefcafe',
    ]) {
      expect(max(apiReq(url))).toBe(600);
      expect(keyGenerator(apiReq(url, '4.4.4.4'))).toBe('cm:4.4.4.4');
    }
  });

  it('keeps carrier media in a DIFFERENT bucket from webhooks on the same IP', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const { keyGenerator } = mockRegister.mock.calls[0]![1] as any;
    // The whole point: a webhook retry storm from a carrier IP must not be able
    // to 429 that same carrier's media upgrade, which is unrecoverable dead air.
    expect(keyGenerator(apiReq('/api/v1/webhooks/voicelink/static-status/a', '4.4.4.4'))).toBe('wh:4.4.4.4');
    expect(keyGenerator(apiReq('/api/v1/media-stream/a', '4.4.4.4'))).toBe('cm:4.4.4.4');
  });

  it('gives /internal/* its own bucket and ceiling (keyed on the PATH, not the Bearer header)', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const { max, keyGenerator } = mockRegister.mock.calls[0]![1] as any;
    // No Authorization header at all — classification must not depend on it, or a
    // request that forgot it would land in a different bucket than the route serves.
    expect(max(apiReq('/internal/usage/export'))).toBe(1000);
    expect(keyGenerator(apiReq('/internal/usage/export', '8.8.8.8'))).toBe('int:8.8.8.8');
    const withBearer = {
      url: '/internal/api-keys',
      headers: { authorization: 'Bearer s2s-token' },
      ip: '8.8.8.8',
    };
    expect(max(withBearer)).toBe(1000);
    expect(keyGenerator(withBearer)).toBe('int:8.8.8.8');
  });

  // PORT NOTE (magick-agency, Phase 8): agency's probes are `/healthz` and `/readyz`
  // (`EXEMPT_PATHS`); every probe path below is core's with that rename, and core's own
  // `/health` / `/ready` are now ordinary (unserved) paths in the `ip` bucket.
  it('exempts /healthz and /readyz outright via allowList', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const { allowList } = mockRegister.mock.calls[0]![1] as any;
    expect(allowList(apiReq('/healthz'))).toBe(true);
    expect(allowList(apiReq('/readyz'))).toBe(true);
    // A 429 on a probe fails the readiness gate, so the exemption must hold
    // whatever headers the probe carries.
    expect(allowList({ url: '/readyz', headers: { 'x-api-key': 'k' }, ip: 'i' })).toBe(true);
    expect(allowList(apiReq('/api/v1/calls'))).toBe(false);
    expect(allowList(apiReq('/api/v1/webhooks/voicelink/status/x'))).toBe(false);
    // Boundary: a route merely starting with the same characters is not a probe.
    expect(allowList(apiReq('/readyzz'))).toBe(false);
    expect(allowList(apiReq('/healthz-check'))).toBe(false);
    // Core's probe paths are not agency's, and are not exempt here.
    expect(allowList(apiReq('/health'))).toBe(false);
    expect(allowList(apiReq('/ready'))).toBe(false);
    // And exemption is EXACT, not a prefix: neither probe has sub-routes, so a
    // prefix match would leave `/health/<junk>` — an arbitrary-volume 404 path —
    // as the one completely uncapped surface at the edge.
    expect(allowList(apiReq('/healthz/deep'))).toBe(false);
    expect(allowList(apiReq('/readyz/x/y'))).toBe(false);
    expect(budgetFor({ url: '/healthz/deep', headers: {} })).toBe('ip');
    // A query string still exempts the probe itself.
    expect(allowList(apiReq('/healthz?verbose=1'))).toBe(true);
  });

  it('puts the WebRTC media legs in the carrier-media bucket, but not the control API above them', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const { max, keyGenerator } = mockRegister.mock.calls[0]![1] as any;
    // Both legs are unauthenticated WS upgrades registered at the plugin root
    // (the auth hook is scoped to an encapsulated child), and `pstn-stream` is
    // dialled by VoBiz from the same egress IPs as the webhooks. A 429 on either
    // drops the upgrade and the bridge goes silent — it is not a retryable
    // failure, so it must not share a budget with the webhook stream.
    for (const url of [
      '/api/v1/webrtc-call/8f1c-callid/pstn-stream',
      '/api/v1/webrtc-call/8f1c-callid/browser-stream?token=t',
    ]) {
      expect(max(apiReq(url))).toBe(600);
      expect(keyGenerator(apiReq(url, '6.6.6.6'))).toBe('cm:6.6.6.6');
      expect(routeClassFor(url)).toBe('media_stream');
    }
    // The parent is authenticated tenant CRUD and must stay in the tenant/ip
    // budget — matching the whole prefix would have moved it too.
    expect(max(apiReq('/api/v1/webrtc-call'))).toBe(200);
    expect(max(apiReq('/api/v1/webrtc-call/8f1c-callid'))).toBe(200);
    expect(keyGenerator(apiReq('/api/v1/webrtc-call/8f1c-callid', '6.6.6.6'))).toBe('6.6.6.6');
    // A lookalike suffix outside the parent prefix is not a media leg.
    expect(max(apiReq('/api/v1/calls/x/pstn-stream'))).toBe(200);
  });

  it('propagates carrierMediaMax / internalMax overrides', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app, null, { carrierMediaMax: 42, internalMax: 77 });

    const { max } = mockRegister.mock.calls[0]![1] as any;
    expect(max(apiReq('/api/v1/media-stream/x'))).toBe(42);
    expect(max(apiReq('/internal/usage/summary'))).toBe(77);
  });

  it('keeps max, keyGenerator and allowList in lockstep for EVERY bucket kind', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app, null, {
      max: 200, webhookMax: 300, carrierMediaMax: 600, internalMax: 1000,
    });

    const { max, keyGenerator, allowList } = mockRegister.mock.calls[0]![1] as any;
    // The invariant PR #357 introduced for `wh:`, extended to the new
    // namespaces: the ceiling a request is measured against is decided by the
    // SAME predicate as the counter it is measured in, so one counter can never
    // hold two ceilings.
    const expected: Record<string, number> = {
      'wh:': 300, 'cm:': 600, 'int:': 1000,
    };
    const cases = [
      { url: '/api/v1/webhooks/x', headers: {}, ip: 'i' },
      { url: '/api/v1/media-stream/x', headers: {}, ip: 'i' },
      { url: '/api/v1/tts-audio/x', headers: {}, ip: 'i' },
      { url: '/internal/x', headers: {}, ip: 'i' },
      { url: '/api/v1/webrtc-call/c1/pstn-stream', headers: {}, ip: 'i' },
      { url: '/api/v1/webrtc-call/c1', headers: {}, ip: 'i' },
      { url: '/api/v1/calls', headers: {}, ip: 'i' },
      { url: '/healthz', headers: {}, ip: 'i' },
      { url: '/healthz/deep', headers: {}, ip: 'i' },
      // An API key wins over the path in every one of them.
      // PORT NOTE (magick-agency): no longer — the header selects nothing (no tenant bucket);
      // the rows stay, and the lockstep they assert holds for the path's own bucket.
      { url: '/api/v1/webhooks/x', headers: { 'x-api-key': 'k' }, ip: 'i' },
      { url: '/api/v1/media-stream/x', headers: { 'x-api-key': 'k' }, ip: 'i' },
      { url: '/internal/x', headers: { 'x-api-key': 'k' }, ip: 'i' },
      { url: '/api/v1/calls', headers: { 'x-api-key': 'k' }, ip: 'i' },
    ];
    for (const req of cases) {
      if (allowList(req)) continue; // never limited, so no ceiling to agree on
      const key = String(keyGenerator(req));
      const prefix = Object.keys(expected).find((p) => key.startsWith(p));
      expect(max(req)).toBe(prefix ? expected[prefix] : 200);
    }
  });

  it('budgetFor resolves each bucket kind, exempt first; an x-api-key header selects nothing', () => {
    expect(budgetFor({ url: '/healthz', headers: {} })).toBe('exempt');
    expect(budgetFor({ url: '/readyz?verbose=1', headers: {} })).toBe('exempt');
    expect(budgetFor({ url: '/api/v1/webhooks/voicelink/status/x', headers: {} })).toBe('webhook');
    expect(budgetFor({ url: '/api/v1/media-stream/x', headers: {} })).toBe('carrier_media');
    expect(budgetFor({ url: '/api/v1/webrtc-call/c1/pstn-stream', headers: {} })).toBe('carrier_media');
    expect(budgetFor({ url: '/api/v1/webrtc-call/c1', headers: {} })).toBe('ip');
    expect(budgetFor({ url: '/internal/usage/records', headers: {} })).toBe('internal');
    expect(budgetFor({ url: '/api/v1/calls', headers: { 'x-api-key': 'k' } })).toBe('ip');
    expect(budgetFor({ url: '/api/v1/browser-call/client', headers: {} })).toBe('ip');
    // A missing url mis-buckets rather than throwing: keyGenerator runs inside the
    // request path, and a throw there is a 500 on every call.
    expect(budgetFor({ headers: {} })).toBe('ip');
  });

  // ── 429 telemetry (Part 1) ─────────────────────────────────────────────────
  // The incident was invisible: no onExceeded hook, no counter, no alert. 17,539
  // rejections were found by log archaeology on error-handler warn lines.

  it('emits rate_limit_rejected_total from onExceeded, labelled by bucket kind and route class', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const { onExceeded } = mockRegister.mock.calls[0]![1] as any;
    // The exact URL that was 429'd 17,539 times on 2026-09-03.
    onExceeded(apiReq('/api/v1/webhooks/voicelink/static-status/abc?token=deadbeef'), 'wh:1.2.3.4');
    expect(trackRateLimitRejected).toHaveBeenCalledWith('webhook', 'webhooks');
  });

  it('labels the 429 with the bucket ACTUALLY charged, whatever headers it carries', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const options = mockRegister.mock.calls[0]![1] as any;
    // PORT NOTE (magick-agency): core's case put an x-api-key webhook request in the
    // tenant bucket and expected `tenant`; with no tenant bucket the charged bucket —
    // and so the label — is `webhook`, whatever headers it carries.
    const req = {
      url: '/api/v1/webhooks/voicelink/static-status/a',
      headers: { 'x-api-key': 'k', 'x-mgkvc-tenant': 't1' },
      ip: '1.2.3.4',
    };
    expect(String(options.keyGenerator(req))).toBe('wh:1.2.3.4');
    options.onExceeded(req, 'ignored');
    expect(trackRateLimitRejected).toHaveBeenCalledWith('webhook', 'webhooks');
  });

  it('emits the other bucket kinds with their route class', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const { onExceeded } = mockRegister.mock.calls[0]![1] as any;
    onExceeded(apiReq('/api/v1/media-stream/static/c1/t1'), 'cm:1.1.1.1');
    onExceeded(apiReq('/api/v1/tts-audio/abcdef'), 'cm:1.1.1.1');
    onExceeded(apiReq('/internal/usage/export?chunk=3'), 'int:1.1.1.1');
    onExceeded(apiReq('/api/v1/browser-call/client'), '1.1.1.1');
    expect(trackRateLimitRejected.mock.calls).toEqual([
      ['carrier_media', 'media_stream'],
      ['carrier_media', 'tts_audio'],
      ['internal', 'internal'],
      ['ip', 'api'],
    ]);
  });

  it('never lets a metrics failure turn the 429 into a 500', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);
    trackRateLimitRejected.mockImplementationOnce(() => { throw new Error('label mismatch'); });

    const { onExceeded } = mockRegister.mock.calls[0]![1] as any;
    // The plugin awaits this hook inside the request path and throws the 429
    // immediately after, so a throw here would be served as a 500 instead —
    // the same failure the file's header calls out for `keyGenerator`.
    expect(() => onExceeded(apiReq('/api/v1/webhooks/x'), 'wh:1.1.1.1')).not.toThrow();
  });

  it('never emits for an exempt request', async () => {
    const app = { register: mockRegister } as any;
    await registerRateLimit(app);

    const { onExceeded } = mockRegister.mock.calls[0]![1] as any;
    // Unreachable in production (allowList short-circuits first), so this pins
    // the narrowing rather than a behaviour anyone can observe.
    onExceeded(apiReq('/healthz'), '1.1.1.1');
    expect(trackRateLimitRejected).not.toHaveBeenCalled();
  });

  // ── Label cardinality is a hard constraint ────────────────────────────────

  it('route_class is bounded by the code table and leaks no id, phone or token', () => {
    const urls = [
      // Every param-bearing / credential-bearing shape that can realistically 429.
      '/api/v1/webhooks/voicelink/static-status/8f1c-callid?token=live-secret',
      '/api/v1/webhooks/twilio/ivr-gather/session-9/step-3',
      '/api/v1/webhooks/greenapi/conn-42',
      '/api/v1/media-stream/8f1c-callid',
      '/api/v1/media-stream/static/8f1c-callid/media-token-secret',
      '/api/v1/static-media-stream/8f1c-callid/media-token-secret',
      '/api/v1/tts-audio/9a3f5c1e',
      '/api/v1/webrtc-recordings/rec-1?token=signed-secret',
      '/internal/api-keys/key-1',
      '/api/v1/calls/8f1c-callid',
      '/api/v1/messaging/media/asset-1/content',
      '/api/v1/prompts/p-1/tools/t-1',
      '/healthz',
      '/readyz',
      '/favicon.ico',
      '',
    ];
    const seen = new Set<string>();
    for (const url of urls) {
      const cls = routeClassFor(url);
      seen.add(cls);
      expect(RATE_LIMIT_ROUTE_CLASSES).toContain(cls);
      // The whole point of the slug: none of the variable parts survive into the
      // label, so the series count cannot grow with traffic.
      expect(cls).not.toContain('8f1c-callid');
      expect(cls).not.toContain('secret');
      expect(cls).not.toContain('token');
      expect(cls).not.toContain('/');
    }
    // Sanity: the table is actually discriminating, not collapsing everything.
    expect(seen.size).toBeGreaterThan(5);
    expect(routeClassFor(undefined)).toBe('other');
  });

  // NEW (magick-agency, Phase 8): the console's agency paths carry the `agency` class.
  it('labels the agency API at the console paths as agency', () => {
    expect(routeClassFor('/proxy/agency/campaigns/c1/stats')).toBe('agency');
    expect(routeClassFor('/dnc')).toBe('agency');
    expect(routeClassFor('/dnc/e1')).toBe('agency');
    expect(routeClassFor('/dncx')).toBe('other');
    expect(routeClassFor('/proxy/agencyx')).toBe('other');
  });

  it('classifies on a path BOUNDARY, so a lookalike route is not misattributed', () => {
    // `/api/v1/calls` must not swallow `/api/v1/call-analysis-profiles`, and the
    // more specific prefixes must stay ahead of the `/api/v1` catch-all.
    expect(routeClassFor('/api/v1/call-analysis-profiles')).toBe('api');
    expect(routeClassFor('/api/v1/calls/bulk')).toBe('calls');
    expect(routeClassFor('/api/v1/webhooks')).toBe('webhooks');
    expect(routeClassFor('/api/v1/webhooksomething')).toBe('api');
    expect(routeClassFor('/internal-tools')).toBe('other');
    // A query string that merely mentions another prefix changes nothing.
    expect(routeClassFor('/api/v1/calls?next=/internal/x')).toBe('calls');
    // The bulk-dispatch surfaces are separated from ordinary CRUD, because
    // "a batch dispatch is being refused" is a different operator action.
    expect(routeClassFor('/api/v1/static-calls/batches/b1/cancel')).toBe('static_calls');
    expect(routeClassFor('/api/v1/ivr-calls')).toBe('ivr_calls');
    expect(routeClassFor('/api/v1/agency-campaigns/c1/start')).toBe('agency');
    expect(routeClassFor('/api/v1/agency-agents')).toBe('agency');
  });
});
