import { config } from '../config/index.js';
import { createChildLogger } from '@magick-agency/observability';
import { isAbortFromTimeout } from '../utils/abort-error.js';

const log = createChildLogger({ component: 'mailjet-client' });

/**
 * How long one Mailjet request may take before it is abandoned.
 *
 * ── Why any bound at all ───────────────────────────────────────────────────
 *
 * Without one, `fetch` here inherits the process-wide undici default — **300
 * seconds** of headers timeout. `agency-campaign-completion.ts` sends one
 * envelope PER RECIPIENT (a disclosure decision, not up for revision), so one
 * slow round could hold its fan-out for five minutes. The fan-out is bounded in
 * WIDTH (`SEND_CONCURRENCY`); this is the bound in TIME, and without it "bounded
 * concurrency" would only bound the burst, not the wait.
 *
 * ── Why it is set in the client, for every caller ──────────────────────────
 *
 * 300s is the wrong bound for every caller, not just one: the invite mailer has
 * an HTTP request waiting on it, the completion notice has a shutdown drain
 * bounding it, and none of them has a reader who benefits from a five-minute wait
 * over a reported failure. One bound in one place is fewer moving parts than a
 * per-call override every caller has to remember.
 *
 * A timeout lands on the `catch` below and returns `false` — the same value a
 * refusal returns — so no caller learns a new outcome and no contract changes.
 * 10s is comfortably above Mailjet's normal send latency; a request slower than
 * that is not going to be fast enough to matter to any of these callers.
 */
const MAILJET_TIMEOUT_MS = 10_000;

export interface SendEmailParams {
  to: Array<{ email: string; name?: string }>;
  subject: string;
  textBody: string;
  htmlBody: string;
}

/**
 * What actually happened to one send.
 *
 * ── Why `boolean` was not enough, and what depends on the difference ────────
 *
 * {@link sendEmail} collapses three outcomes into `false`: Mailjet is not
 * configured at all, Mailjet refused the message, and the request timed out. For
 * a mailer that logs and moves on, that is fine.
 *
 * A caller that CLAIMS a delivery row before sending (`notification_deliveries`)
 * and never retries a claimed row that fails has to tell the three cases apart.
 * No caller uses this form today:
 *
 *  - `unconfigured` — no transport exists, nothing was attempted, and the claim
 *    must be RELEASED. Without this case a staging environment with no Mailjet
 *    block silently burns the dedupe key, and turning Mailjet on later sends
 *    nothing for it.
 *  - `rejected` — Mailjet answered and said no. Nothing was delivered; the row
 *    is marked `failed` with the status on it.
 *  - `timeout` / `error` — the message may or may not have been accepted. This
 *    is exactly why a failed claim is NOT released: retrying a timeout does not
 *    recover a lost mail so much as duplicate a delivered one.
 */
export type SendEmailOutcome =
  | { result: 'sent'; messageUuids: string[] }
  | { result: 'unconfigured' }
  | { result: 'rejected'; status: number; detail?: string }
  | { result: 'timeout' }
  | { result: 'error'; detail: string };

/**
 * Send an email via Mailjet Send API v3.1.
 * Uses native fetch with Basic auth. Fire-and-forget — never throws.
 *
 * The boolean form, the contract both current callers use. It is a thin projection of {@link sendEmailWithOutcome} rather than a
 * second implementation, so the two cannot drift; new callers that need to
 * record WHY a send failed should use the outcome form directly.
 */
export async function sendEmail(params: SendEmailParams): Promise<boolean> {
  const outcome = await sendEmailWithOutcome(params);
  return outcome.result === 'sent';
}

/**
 * The same send, reporting which of the five things happened.
 *
 * Never throws — identical guarantee to {@link sendEmail}, and load-bearing for
 * the same reason: every caller is a mailer with somebody waiting behind it, and
 * a transport fault must not propagate into a request handler or the pacing
 * leader's finalize path.
 */
export async function sendEmailWithOutcome(params: SendEmailParams): Promise<SendEmailOutcome> {
  const mj = config.mailjet;
  if (!mj) {
    log.debug('Mailjet not configured, skipping email');
    return { result: 'unconfigured' };
  }

  const credentials = Buffer.from(`${mj.apiKey}:${mj.apiSecret}`).toString('base64');

  const body = {
    Messages: [
      {
        From: { Email: mj.fromEmail, Name: mj.fromName },
        To: params.to.map(r => ({ Email: r.email, ...(r.name ? { Name: r.name } : {}) })),
        Subject: params.subject,
        TextPart: params.textBody,
        HTMLPart: params.htmlBody,
      },
    ],
  };

  try {
    const response = await fetch('https://api.mailjet.com/v3.1/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(body),
      // Bounded rather than inheriting undici's 300s default — see
      // {@link MAILJET_TIMEOUT_MS}. An abort surfaces on the catch below as a
      // reported failure, exactly as a refusal does — though as a DIFFERENT
      // member of {@link SendEmailOutcome}, which is the distinction the
      // delivery ledger turns on.
      signal: AbortSignal.timeout(MAILJET_TIMEOUT_MS),
    });

    const responseBody = await response.json().catch(() => null) as {
      Messages?: Array<{ Status?: string; To?: Array<{ Email?: string; MessageUUID?: string }> }>;
    } | null;

    if (!response.ok) {
      log.error({ status: response.status, responseBody }, 'Mailjet send failed');
      return {
        result: 'rejected',
        status: response.status,
        // Mailjet's error bodies carry no customer data, but they are somebody
        // else's free text landing in a column support reads — bounded here
        // rather than at every reader.
        detail: responseBody ? JSON.stringify(responseBody).slice(0, 300) : undefined,
      };
    }

    const messageUuids = responseBody?.Messages?.flatMap(
      m => m.To?.map(t => t.MessageUUID).filter(Boolean) ?? [],
    ).filter((uuid): uuid is string => typeof uuid === 'string') ?? [];

    log.info({ recipientCount: params.to.length, subject: params.subject, messageUuids }, 'Email sent via Mailjet');
    return { result: 'sent', messageUuids };
  } catch (err) {
    // Includes the abort from {@link MAILJET_TIMEOUT_MS}. Logged with the bound so
    // a timeout is not read as an unexplained transport fault.
    log.error({ err, timeoutMs: MAILJET_TIMEOUT_MS }, 'Mailjet send threw an error');

    // Separated from a generic fault because the two mean different things to a
    // caller that has already claimed a delivery: a timeout may have been
    // ACCEPTED by Mailjet, so the claim is KEPT and the message never re-sent,
    // while `error` is the residual "something else broke" bucket. Neither is
    // retried today; the row records which.
    //
    // Detected with the shared predicate rather than
    // `err instanceof Error && err.name === 'TimeoutError'`, which misses the
    // abort on both of its real shapes: the thrown value is a `DOMException` (so
    // the `instanceof` can be false), and undici often delivers the reason one
    // level down on `.cause` under an `AbortError` or `TypeError`. A missed
    // `MAILJET_TIMEOUT_MS` abort would fall through to `{ result: 'error' }`, and
    // a caller that releases a claim on `error` would then re-send a notice
    // Mailjet may already have accepted. See {@link isAbortFromTimeout}.
    if (isAbortFromTimeout(err)) {
      return { result: 'timeout' };
    }
    return { result: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}
