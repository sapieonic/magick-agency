import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The VoiceLink adapter and its token manager against the mock carrier over REAL
 * sockets (`test/mocks/voicelink`), under concurrency and injected faults.
 *
 * The existing adapter / token-manager suites stub `fetch` and pin the request shapes one
 * call at a time. What a stub cannot show is how the two behave when a floor of agents
 * dials at once against a carrier that is slow, failing or expiring tokens: whether the
 * login is really single-flight across a burst, whether a burst of 401s stampedes the
 * auth endpoint, whether a fault on one request leaks into its neighbours, and whether a
 * carrier that stops answering can stall the dial path. Every assertion reads what the
 * carrier recorded (requests, statuses, tokens) or what each dial returned.
 *
 * Sizes are `scaled()` (LOAD_SCALE); randomness is seeded (LOAD_SEED, printed in the
 * describe name).
 */

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { randomUUID } from 'node:crypto';
import { VoicelinkAdapter } from '../../../../src/telephony/voicelink/voicelink.adapter.js';
import { VoicelinkTokenManager } from '../../../../src/telephony/voicelink/voicelink-token-manager.js';
import { MockVoicelinkCarrier } from '../../../mocks/voicelink/index.js';
import { createRng, LOAD_SEED, scaled } from '../../../helpers/load-scale.js';

const BURST = scaled(50);
const rng = createRng(LOAD_SEED);

let carrier: MockVoicelinkCarrier;

/** A destination in one of the formats the dialer can hand the adapter. */
function destination(): { to: string; national: string } {
  const national = `9${String(rng.int(100_000_000, 999_999_999))}`;
  const to = rng.pick([`+91${national}`, `91${national}`, `0${national}`, national, `+91 ${national.slice(0, 5)} ${national.slice(5)}`]);
  return { to, national };
}

function dialRequest(to = '+919812345678') {
  const callId = randomUUID();
  return {
    callId,
    to,
    from: '+91 98000 00001',
    webhookUrl: `https://agency.test/api/v1/webhooks/voicelink/webrtc-answer/${callId}`,
    statusCallbackUrl: `https://agency.test/api/v1/webhooks/voicelink/webrtc-status/${callId}?token=${randomUUID()}`,
    mediaStreamUrl: `wss://agency.test/api/v1/webrtc-call/${callId}/pstn-stream?token=${randomUUID()}`,
    maxDuration: 1800,
    enableRecording: false,
    machineDetection: false,
  };
}

function newAdapter(): VoicelinkAdapter {
  return new VoicelinkAdapter(carrier.config());
}

async function settle<T>(work: Array<Promise<T>>): Promise<{ ok: T[]; errors: string[] }> {
  const results = await Promise.allSettled(work);
  return {
    ok: results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
    errors: results.flatMap((r) => (r.status === 'rejected' ? [String((r.reason as Error).message)] : [])),
  };
}

async function waitUntil(what: string, probe: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe(`VoiceLink adapter + token manager vs the mock carrier (burst ${BURST}, seed ${LOAD_SEED})`, () => {
  beforeAll(async () => {
    carrier = new MockVoicelinkCarrier();
    await carrier.start();
  });

  afterEach(() => {
    carrier.reset();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await carrier.stop();
  });

  describe('a burst of concurrent dials', () => {
    it('on a cold adapter shares ONE login, and every add_lead carries that token and a valid split lead', async () => {
      const adapter = newAdapter();
      // Slow the login so every dial is provably waiting on it, not served from a cache.
      carrier.injectFault('login', { kind: 'latency', ms: 50 });
      const dials = Array.from({ length: BURST }, () => {
        const d = destination();
        return { d, req: dialRequest(d.to) };
      });

      const { ok, errors } = await settle(dials.map(({ req }) => adapter.initiateCall(req)));

      expect(errors).toEqual([]);
      expect(ok.map((r) => r.providerCallId)).toEqual(dials.map(({ req }) => req.callId));
      const logins = carrier.requestsTo('login');
      expect(logins).toHaveLength(1);
      expect(logins[0]!.body).toEqual({ username: carrier.username, password: carrier.password });
      const token = carrier.requestsTo('add_lead')[0]!.authorization;
      expect(token).toMatch(/^Bearer \d+\|mockSanctumToken/);

      const leads = carrier.requestsTo('add_lead');
      expect(leads).toHaveLength(BURST);
      // The carrier's own field checks (422 on a bad split) passed for every format.
      expect(leads.map((r) => r.status)).toEqual(Array(BURST).fill(200));
      expect(new Set(leads.map((r) => r.authorization))).toEqual(new Set([token]));
      const byCall = new Map(leads.map((r) => [(r.body as { websocket_url: string }).websocket_url, r.body as Record<string, string>]));
      for (const { d, req } of dials) {
        const body = byCall.get(req.mediaStreamUrl)!;
        expect(body, `lead for ${req.to}`).toMatchObject({
          did_number: '919800000001',
          customer_number: d.national,
          country_code: '91',
          webhook_url: req.statusCallbackUrl,
        });
      }
    });

    it('with the carrier slow on every add_lead, all dials are in flight at once and all complete', async () => {
      const adapter = newAdapter();
      await adapter.initiateCall(dialRequest()); // warm the token
      carrier.reset();
      carrier.injectFault('add_lead', { kind: 'latency', ms: 100 }, BURST);

      const { ok, errors } = await settle(Array.from({ length: BURST }, () => adapter.initiateCall(dialRequest())));

      expect(errors).toEqual([]);
      expect(ok).toHaveLength(BURST);
      expect(carrier.requestsTo('login')).toHaveLength(0);
      // Nothing in the adapter serialises dials: the carrier saw all of them before the
      // first answer went out (each was held 100ms), i.e. N parallel connections.
      const leads = carrier.requestsTo('add_lead');
      const firstAnswerAt = Math.min(...leads.map((r) => r.receivedAt)) + 100;
      expect(leads.filter((r) => r.receivedAt < firstAnswerAt)).toHaveLength(BURST);
    });
  });

  describe('token expiry under load', () => {
    it('a burst of 401s (tokens revoked mid-shift) triggers ONE re-login, and every dial is retried once and succeeds', async () => {
      const adapter = newAdapter();
      await adapter.initiateCall(dialRequest());
      expect(carrier.requestsTo('login')).toHaveLength(1);
      carrier.reset();

      carrier.revokeTokens();
      let release!: () => void;
      carrier.injectFault('login', { kind: 'hold', gate: new Promise<void>((r) => { release = r; }) });
      const refresh = vi.spyOn(VoicelinkTokenManager.prototype, 'refresh');

      const work = Array.from({ length: BURST }, () => adapter.initiateCall(dialRequest()));
      // Every dial has had its 401 and asked for a refresh while the one login is held —
      // the stampede case, made deterministic rather than raced.
      await waitUntil(`${BURST} refreshes`, () => refresh.mock.calls.length === BURST);
      await waitUntil('the held login to reach the carrier', () => carrier.requestsTo('login').length > 0);
      release();
      const { ok, errors } = await settle(work);

      expect(errors).toEqual([]);
      expect(ok).toHaveLength(BURST);
      expect(carrier.requestsTo('login')).toHaveLength(1);
      const leads = carrier.requestsTo('add_lead');
      expect(leads.filter((r) => r.status === 401)).toHaveLength(BURST);
      expect(leads.filter((r) => r.status === 200)).toHaveLength(BURST);
      const fresh = new Set(leads.filter((r) => r.status === 200).map((r) => r.authorization));
      expect(fresh.size).toBe(1);
    });

    it('a refreshed token that is ALSO refused fails the dial after exactly one retry (no 401 loop)', async () => {
      const adapter = newAdapter();
      await adapter.initiateCall(dialRequest());
      carrier.reset();
      carrier.injectFault('add_lead', { kind: 'status', status: 401, body: '{"message":"Unauthenticated."}' }, 2);

      await expect(adapter.initiateCall(dialRequest())).rejects.toThrow(/add_lead error 401/);
      expect(carrier.requestsTo('add_lead')).toHaveLength(2);
      expect(carrier.requestsTo('login')).toHaveLength(1);
    });

    it('a login that fails rejects every waiting dial once and does not poison the next login', async () => {
      const adapter = newAdapter();
      carrier.injectFault('login', { kind: 'status', status: 500 });

      const { errors } = await settle(Array.from({ length: BURST }, () => adapter.initiateCall(dialRequest())));

      expect(errors).toHaveLength(BURST);
      expect(new Set(errors)).toEqual(new Set(['VoiceLink login failed: HTTP 500']));
      expect(carrier.requestsTo('login')).toHaveLength(1);
      expect(carrier.requestsTo('add_lead')).toHaveLength(0);

      await expect(adapter.initiateCall(dialRequest())).resolves.toBeDefined();
      expect(carrier.requestsTo('login')).toHaveLength(2);
    });

    it.each([
      ['reset', 'VoiceLink login request failed'],
      ['no_token', 'VoiceLink login response missing token'],
      ['malformed', ''],
    ] as const)('a login answered with %s fails the burst without a stampede', async (kind, message) => {
      const adapter = newAdapter();
      carrier.injectFault('login', { kind });
      const { errors } = await settle(Array.from({ length: BURST }, () => adapter.initiateCall(dialRequest())));
      expect(errors).toHaveLength(BURST);
      if (message) expect(new Set(errors)).toEqual(new Set([message]));
      expect(carrier.requestsTo('login')).toHaveLength(1);
      expect(carrier.requestsTo('add_lead')).toHaveLength(0);
    });
  });

  describe('add_lead faults are per request', () => {
    it.each([500, 502, 503, 429, 400])('HTTP %i fails only the dials it hit, with no retry, and the rest go through', async (status) => {
      const adapter = newAdapter();
      await adapter.initiateCall(dialRequest());
      carrier.reset();
      const hit = Math.max(1, Math.floor(BURST / 5));
      carrier.injectFault('add_lead', {
        kind: 'status', status, body: '{"status":false,"message":"carrier says no"}',
        ...(status === 429 ? { headers: { 'retry-after': '1' } } : {}),
      }, hit);

      const { ok, errors } = await settle(Array.from({ length: BURST }, () => adapter.initiateCall(dialRequest())));

      expect(errors).toHaveLength(hit);
      for (const e of errors) expect(e).toBe(`VoiceLink /v1/add_lead error ${status}: {"status":false,"message":"carrier says no"}`);
      expect(ok).toHaveLength(BURST - hit);
      // No retry on a non-401: one request per dial. (A retry here would re-queue a lead
      // the carrier may already have accepted — a double dial of the same customer.)
      expect(carrier.requestsTo('add_lead')).toHaveLength(BURST);
      expect(carrier.requestsTo('login')).toHaveLength(0);
    });

    it('a reset connection on add_lead rejects that dial with a network error, and the next dial is unaffected', async () => {
      const adapter = newAdapter();
      await adapter.initiateCall(dialRequest());
      carrier.injectFault('add_lead', { kind: 'reset' });
      await expect(adapter.initiateCall(dialRequest())).rejects.toThrow(/fetch failed/);
      await expect(adapter.initiateCall(dialRequest())).resolves.toBeDefined();
    });

    it('a 200 add_lead with a non-JSON body currently FAILS the dial (the carrier may have queued the lead)', async () => {
      // Pinned, not endorsed: `post` throws on `response.json()` after a 2xx, so the bridge
      // records `telephony_init_failed` for a lead the carrier accepted and will dial — its
      // media connect then finds no session and is closed. Treating it as accepted has the
      // opposite risk (a proxy's 200 error page for a lead that was never queued), so the
      // choice is the product's; this test makes a change to it visible.
      const adapter = newAdapter();
      await adapter.initiateCall(dialRequest());
      carrier.injectFault('add_lead', { kind: 'malformed' });
      await expect(adapter.initiateCall(dialRequest())).rejects.toThrow();
      const last = carrier.requestsTo('add_lead').at(-1)!;
      expect(last.status).toBe(200);
    });
  });

  describe('a carrier that stops answering', () => {
    // DEFECT (open): neither the adapter's `post` nor the token manager's `doLogin` sets a
    // request timeout (no `AbortSignal`), so a carrier that accepts the TCP connection and
    // never answers holds the dial for undici's default 300s headers timeout. On the dial
    // path that is an agent reserved on a ringing panel and three concurrency slots held for
    // five minutes per hung request. Fixing it means choosing a timeout and what a timed-out
    // add_lead means (the carrier may have queued the lead), which is a product decision.
    it.fails('a hung add_lead is abandoned within a bounded time', async () => {
      const adapter = newAdapter();
      await adapter.initiateCall(dialRequest());
      carrier.injectFault('add_lead', { kind: 'hang' });
      const dial = adapter.initiateCall(dialRequest());
      dial.catch(() => undefined); // settles (rejects) only when the carrier stops
      const outcome = await Promise.race([
        dial.then(() => 'settled', () => 'settled'),
        new Promise((r) => setTimeout(() => r('still pending'), 2_000)),
      ]);
      expect(outcome).toBe('settled');
    });

    // Same defect, amplified by single-flight: ONE hung login blocks EVERY dial that
    // arrives while it is in flight, not just the one that started it.
    it.fails('a hung login does not stall the whole burst behind it', async () => {
      const adapter = newAdapter();
      carrier.injectFault('login', { kind: 'hang' });
      const work = Array.from({ length: BURST }, () => adapter.initiateCall(dialRequest()));
      for (const w of work) w.catch(() => undefined);
      const settledCount = await Promise.race([
        Promise.allSettled(work).then((r) => r.length),
        new Promise<number>((r) => setTimeout(() => r(0), 2_000)),
      ]);
      expect(settledCount).toBe(BURST);
    });
  });

  describe('CDR lookups', () => {
    it('a miss, a 401 refresh and a reset all degrade to "unknown" without throwing', async () => {
      const adapter = newAdapter();
      await expect(adapter.getCallStatus('no-such-call')).resolves.toEqual({ status: 'unknown' });
      carrier.revokeTokens();
      await expect(adapter.getCallStatus('no-such-call')).resolves.toEqual({ status: 'unknown' });
      expect(carrier.requestsTo('login')).toHaveLength(2);
      carrier.injectFault('cdr', { kind: 'reset' });
      await expect(adapter.getCallStatus('no-such-call')).resolves.toEqual({ status: 'unknown' });
    });
  });
});
