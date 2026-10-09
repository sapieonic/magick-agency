import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * The mask has no forwarded-4xx branch: internal handlers run in the same process, so there
 * is no recorded upstream status to mask or forward. Policy: 5xx bodies are masked, and any
 * 4xx passes through unchanged, whatever its shape.
 */

const mocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.logger }));

import {
  errorMaskHook,
  maskedErrorBody,
  MASKED_ERROR_MESSAGE,
} from '../../../../src/api/middleware/error-mask.middleware.js';

function makeReply(statusCode: number): any {
  return { statusCode, header: vi.fn() };
}
function makeRequest(overrides: Record<string, unknown> = {}): any {
  return { id: 'req-1', method: 'POST', url: '/proxy/calls', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('maskedErrorBody', () => {
  // Decision B17: the message names no support address.
  it('uses Internal Error label + the generic support message for 5xx', () => {
    const body = maskedErrorBody('req-9', 502);
    expect(body).toMatchObject({ error: 'Internal Error', statusCode: 502, requestId: 'req-9' });
    expect(body.message).toBe(MASKED_ERROR_MESSAGE);
    expect(body.message).toContain('contact support and quote the request ID');
    expect(body.message).not.toMatch(/@|magick\s?voice/i);
  });
  it('uses Request Failed label for 4xx', () => {
    expect(maskedErrorBody('req-9', 400).error).toBe('Request Failed');
  });
});

describe('errorMaskHook', () => {
  describe('passes through non-error responses', () => {
    it('returns 2xx payload unchanged', async () => {
      const payload = JSON.stringify({ ok: true });
      const out = await errorMaskHook(makeRequest(), makeReply(200), payload);
      expect(out).toBe(payload);
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });
  });

  describe('5xx masking', () => {
    it('masks any 5xx, hiding the original message', async () => {
      const reply = makeReply(500);
      const out = await errorMaskHook(
        makeRequest({ requestId: 'rid-5' }),
        reply,
        JSON.stringify({ error: 'Error', message: 'google ai: quota exceeded for project xyz' }),
      );
      const parsed = JSON.parse(out as string);
      expect(parsed.error).toBe('Internal Error');
      expect(parsed.requestId).toBe('rid-5');
      expect(parsed.message).toBe(MASKED_ERROR_MESSAGE);
      expect(out).not.toContain('google ai');
      expect(mocks.logger.error).toHaveBeenCalled();
      expect(reply.header).toHaveBeenCalledWith('x-request-id', 'rid-5');
    });

    it('masks 5xx even when the internal handler was not involved', async () => {
      const out = await errorMaskHook(makeRequest(), makeReply(503), JSON.stringify({ message: 'boom' }));
      expect(JSON.parse(out as string).error).toBe('Internal Error');
    });

    it('passes an explicitly marked reviewed upstream error through unchanged', async () => {
      const payload = JSON.stringify({
        error: 'Voice Alerting Disabled',
        message: 'Set VOICE_ALERTS_ENABLED to configure alerts',
      });
      const out = await errorMaskHook(
        makeRequest({
          url: '/super-admin/alerts/channels',
          preserveReviewedUpstreamError: true,
        }),
        makeReply(503),
        payload,
      );
      expect(out).toBe(payload);
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it('still masks an unmarked local failure on a Super Admin alerts URL', async () => {
      const out = await errorMaskHook(
        makeRequest({ url: '/super-admin/alerts/channels' }),
        makeReply(500),
        JSON.stringify({ error: 'Database Error', message: 'connection string leaked' }),
      );
      expect(out).not.toContain('connection string leaked');
      expect(JSON.parse(out as string).error).toBe('Internal Error');
      expect(mocks.logger.error).toHaveBeenCalled();
    });
  });

  describe('4xx — never masked', () => {
    it('passes ANY 4xx through unchanged, whatever its shape', async () => {
      for (const [status, body] of [
        [400, { error: 'Bad Request', message: 'vobiz error 21211: invalid To number' }],
        [404, { error: 'Not Found', message: 'some upstream resource detail' }],
        [400, { code: 'UNREVIEWED_PROVIDER_ERROR', message: 'provider detail must not leak' }],
        [409, { code: 'campaign_roster_empty', message: 'handler-authored explanation' }],
        [422, { error: 'Validation failed', details: { fieldErrors: { phone: ['bad'] } } }],
      ] as const) {
        const payload = JSON.stringify(body);
        const out = await errorMaskHook(makeRequest(), makeReply(status), payload);
        expect(out, `${status} ${payload}`).toBe(payload);
      }
      expect(mocks.logger.warn).not.toHaveBeenCalled();
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });
  });

  describe('4xx we generated ourselves (not from the internal handler)', () => {
    it('shows business errors (e.g. insufficient credits) unchanged', async () => {
      const payload = JSON.stringify({ error: 'Payment Required', message: 'Insufficient credits to initiate call' });
      const out = await errorMaskHook(makeRequest(), makeReply(402), payload);
      expect(out).toBe(payload);
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it('shows our Zod validation errors unchanged', async () => {
      const payload = JSON.stringify({ error: 'Bad Request', details: [{ path: ['x'], message: 'required' }] });
      const out = await errorMaskHook(makeRequest(), makeReply(400), payload);
      expect(out).toBe(payload);
    });

    it('shows the session email_unverified 403 unchanged, including its code', async () => {
      // SPA branches on `code: email_unverified`. Masking this into the generic
      // support body would make email/password owners look like a 403 RBAC miss.
      const payload = JSON.stringify({
        error: 'Forbidden',
        code: 'email_unverified',
        message: 'Verify your email before signing in. Check your inbox for a verification link, then try again.',
      });
      const out = await errorMaskHook(makeRequest({ url: '/auth/session' }), makeReply(403), payload);
      expect(out).toBe(payload);
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('429 rate / concurrency limits', () => {
    it('forwards an internal rate-limit body with retryAfter (not masked into support text)', async () => {
      const payload = JSON.stringify({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Try again in 17 seconds.',
        statusCode: 429,
        retryAfter: 17,
      });
      const out = await errorMaskHook(makeRequest(), makeReply(429), payload);
      expect(out).toBe(payload);
      expect(mocks.logger.warn).not.toHaveBeenCalled();
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it('forwards an internal concurrency / cooldown 429 with retry_after_seconds', async () => {
      const payload = JSON.stringify({
        error: 'Too Many Requests',
        message: 'Test call cooldown active',
        retry_after_seconds: 42,
      });
      const out = await errorMaskHook(makeRequest(), makeReply(429), payload);
      expect(out).toBe(payload);
    });

    it('forwards a CallManager concurrency 429 (bare error label, no retryAfter)', async () => {
      // Shape returned by calls.routes when CallManager throws CONCURRENCY_LIMIT —
      // the Call Detail / initiate path that was previously masked into support text.
      const payload = JSON.stringify({
        error: 'CONCURRENCY_LIMIT',
        message: 'Concurrency limit reached',
      });
      const out = await errorMaskHook(makeRequest(), makeReply(429), payload);
      expect(out).toBe(payload);
      expect(out).toContain('Concurrency limit reached');
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it('forwards our own rate-limit 429 unchanged', async () => {
      const payload = JSON.stringify({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Try again in 3 seconds.',
        statusCode: 429,
        retryAfter: 3,
      });
      const out = await errorMaskHook(makeRequest(), makeReply(429), payload);
      expect(out).toBe(payload);
    });
  });

  describe('non-JSON payloads', () => {
    it('masks a 5xx Buffer payload', async () => {
      const out = await errorMaskHook(makeRequest(), makeReply(500), Buffer.from('raw bytes'));
      expect(JSON.parse(out as string).error).toBe('Internal Error');
    });
  });

  it('sets a recomputed content-length on the masked body', async () => {
    const reply = makeReply(500);
    const out = await errorMaskHook(makeRequest(), reply, JSON.stringify({ message: 'x'.repeat(500) }));
    expect(reply.header).toHaveBeenCalledWith('content-length', Buffer.byteLength(out as string));
    expect(reply.header).toHaveBeenCalledWith('content-type', 'application/json; charset=utf-8');
  });
});
