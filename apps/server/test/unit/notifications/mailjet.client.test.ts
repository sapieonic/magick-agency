import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * ─── THE MAILJET REQUEST IS BOUNDED IN TIME ─────────────────────────────────
 *
 * The only property this file exists for. `fetch` here inherited undici's
 * process-wide default — **300 seconds** — and every caller of this module is a
 * fire-and-forget mailer with something waiting behind it: an HTTP request (the
 * invite mailer), an SQS message's visibility window (the bulk-dispatch
 * job-completion mailer), or a webhook handler awaiting a whole supervisor roster
 * one envelope at a time (`agency-campaign-completion.ts`).
 *
 * That last one is what made the gap visible. Its fan-out was capped in WIDTH at
 * 6 and not at all in TIME, so a width cap bounded the burst and not the wait —
 * one slow round could hold a webhook handler for five minutes, and core's
 * dispatcher (`WEBHOOK_TIMEOUT_MS`, default 5000, with three retries) would have
 * given up and redelivered long before, re-sending mail already delivered.
 *
 * ── Why this is asserted on the signal and not on elapsed time ─────────────
 *
 * A test that actually waits out a timeout is a test that takes as long as the
 * timeout. What can fail cheaply is the signal being HANDED to `fetch` at all:
 * remove it and undici silently falls back to its own default, with no error and
 * nothing else in the suite any different. So the assertion is that an
 * `AbortSignal` is passed and that it is a *timeout* signal, plus the behaviour
 * an abort produces — a reported `false`, not a throw, because every caller
 * treats this function as total.
 */

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.log }));

import { sendEmail, sendEmailWithOutcome } from '../../../src/notifications/mailjet.client.js';

const MAILJET = { apiKey: 'k', apiSecret: 's', fromEmail: 'no-reply@example.com', fromName: 'Sapionic' };

const params = {
  to: [{ email: 'supervisor@example.com' }],
  subject: 'Campaign finished',
  textBody: 'text',
  htmlBody: '<p>html</p>',
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.config)) delete mocks.config[key];
  Object.assign(mocks.config, { mailjet: MAILJET });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ Messages: [{ Status: 'success', To: [{ MessageUUID: 'm-1' }] }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  ) as ReturnType<typeof vi.spyOn>;
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('sendEmail bounds the request', () => {
  it('hands fetch an abort signal rather than inheriting undici’s 300s default', async () => {
    await sendEmail(params);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Not merely *a* signal: an already-aborted or never-firing one would satisfy
    // the check above while bounding nothing. A timeout signal starts unaborted
    // and carries its own reason, which is what distinguishes it from a caller's
    // manual controller.
    expect(init.signal!.aborted).toBe(false);
  });

  /**
   * A bound short enough to matter to the callers, and long enough not to refuse
   * an ordinary send.
   *
   * Read off `AbortSignal.timeout`'s argument rather than by advancing timers:
   * that signal's clock is a Node internal, not a `setTimeout`, so fake timers do
   * not move it and a timer-based test would have to wait out the real bound.
   * Asserted as a range rather than a literal so the constant can be tuned
   * without a test edit, but not silently returned to minutes.
   */
  it('bounds it in seconds, not minutes', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      await sendEmail(params);

      expect(timeoutSpy).toHaveBeenCalledOnce();
      const ms = timeoutSpy.mock.calls[0]![0];
      // Long enough for an ordinary Mailjet send...
      expect(ms).toBeGreaterThanOrEqual(2_000);
      // ...and nowhere near undici's 300s default, which is the whole point.
      expect(ms).toBeLessThanOrEqual(30_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  /**
   * Totality. An abort arrives at the same `catch` a network error does, and every
   * caller reads `false` as "this inbox did not get it" — the agency notifier
   * counts them and reports a partial delivery. A throw here would turn a
   * delivered campaign status into a redelivered one for the sake of an email.
   */
  it('reports false rather than throwing when the request aborts', async () => {
    fetchSpy.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    );

    await expect(sendEmail(params)).resolves.toBe(false);
    // Logged with the bound, so a timeout is not read as an unexplained fault.
    expect(mocks.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
      expect.any(String),
    );
  });

  /**
   * ── The timeout must be CLASSIFIED as one, not merely survived ───────────
   *
   * `sendEmail` collapses every failure to `false`, so the case above passes
   * whichever outcome the client picked. The delivery ledger reads the outcome
   * itself, and there the distinction decides whether a claim is kept: a timeout
   * may have been ACCEPTED by Mailjet, so the notice is never re-sent, while a
   * released claim invites the next core webhook redelivery to send again.
   *
   * The detection used to be `err instanceof Error && err.name === 'TimeoutError'`
   * and the case above is exactly the shape that hides its two real failures —
   * an `Error` with the name assigned onto it passes an `instanceof` check that
   * the genuine `DOMException` can fail, and it carries no `.cause`. So both real
   * shapes are pinned here explicitly.
   */
  describe('classifying the abort from MAILJET_TIMEOUT_MS', () => {
    it('reports timeout for a DOMException, which may not be an Error', async () => {
      // What `AbortSignal.timeout` actually rejects with. Not an `Error`
      // subclass on every runtime, which is why the predicate is duck-typed.
      fetchSpy.mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));
      await expect(sendEmailWithOutcome(params)).resolves.toEqual({ result: 'timeout' });
    });

    it('reports timeout when undici buries the reason on .cause', async () => {
      // undici wraps the abort depending on where in the request it lands, so
      // the top-level name is not the reason.
      fetchSpy.mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: new DOMException('The operation timed out', 'TimeoutError'),
        }),
      );
      await expect(sendEmailWithOutcome(params)).resolves.toEqual({ result: 'timeout' });
    });

    it('reports timeout for a bare AbortError', async () => {
      // This module installs no signal other than the deadline, so anything
      // aborted is that deadline.
      fetchSpy.mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));
      await expect(sendEmailWithOutcome(params)).resolves.toEqual({ result: 'timeout' });
    });

    it('still reports error for a genuine transport fault', async () => {
      // The other direction matters as much: widening the predicate until every
      // fault reads as a timeout would keep claims that should be released.
      fetchSpy.mockRejectedValue(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      await expect(sendEmailWithOutcome(params)).resolves.toEqual({
        result: 'error',
        detail: 'read ECONNRESET',
      });
    });
  });

  /** The configured-off path never reaches `fetch` at all, so it needs no bound. */
  it('does not call fetch when mailjet is not configured', async () => {
    for (const key of Object.keys(mocks.config)) delete mocks.config[key];

    await expect(sendEmail(params)).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
