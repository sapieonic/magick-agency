/*
 * `POST /webhooks/reports/rendered`: the report renderer's signed callback (docs/reports.md RP13;
 * the protocol is `packages/contracts/src/reports/render.ts`). Not a console route and not a
 * carrier's: no session, no tenant header. The signature is the credential.
 *
 *  1. The raw body is kept (this plugin's own JSON parser), because the signature is over the
 *     exact bytes: `x-mgkvc-report-signature` = hex HMAC-SHA256 with
 *     `AGENCY_REPORTS_CALLBACK_SECRET` of `${x-mgkvc-report-timestamp}.${rawBody}`, the timestamp
 *     within ±300 s (`verifyReportCallback`, constant-time). Else 401 `bad_signature`. With no
 *     secret configured (the inline renderer posts nothing) every callback is refused.
 *  2. The body is a `ReportRenderCallback` (zod), else 400 `invalid`.
 *  3. `applyRenderOutcome` (`agency/reports/apply.ts`), the one path every render result takes:
 *     each file key must be the run's own output key (a callback cannot point a run at another
 *     tenant's object; 400 `invalid`), and the write is fenced on the run's current attempt.
 *     Applied → 204; a superseded attempt or a finished run → 204 too (`stale`: idempotent, the
 *     renderer must not retry it).
 * Every answer is counted in `agency_reports_callbacks_total{result}`.
 *
 * Rate limiting: the path is in the app limiter's `webhook` bucket (`rate-limit.middleware.ts`,
 * `isWebhookPath`), keyed and budgeted apart from the console's traffic like the carrier
 * callbacks, so a burst of renders is never refused against the API's ceiling.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createChildLogger } from '@magick-agency/observability';
import { agencyReportsCallbacksTotal } from '@magick-agency/observability/metrics/agency';
import { REPORT_FORMATS } from '@magick-agency/contracts/api/agency/reports';
import {
  REPORT_SIGNATURE_HEADER,
  REPORT_TIMESTAMP_HEADER,
  type ReportRenderCallback,
} from '@magick-agency/contracts/reports';
import { UUID_RE } from '../../../utils/uuid.js';
import { verifyReportCallback } from '../../../agency/reports/callback-signature.js';
import { applyRenderOutcome, defaultApplyDeps, type RenderOutcomeResult } from '../../../agency/reports/apply.js';

const log = createChildLogger({ component: 'report-render-webhook' });

/** The path under the plugin's `/webhooks` prefix. */
export const REPORT_RENDERED_ROUTE = '/reports/rendered';

const callbackSchema = z.object({
  run_id: z.string().regex(UUID_RE),
  attempt: z.number().int().min(1),
  status: z.enum(['rendered', 'failed']),
  files: z.array(z.object({
    format: z.enum(REPORT_FORMATS),
    key: z.string().min(1).max(1024),
    bytes: z.number().int().min(0),
  })).max(REPORT_FORMATS.length),
  error: z.object({
    code: z.enum(['dataset_unreadable', 'dataset_version_unsupported', 'render_failed', 'upload_failed']),
    message: z.string().max(4000),
  }).nullable(),
  renderer_version: z.string().min(1).max(200),
});

export interface ReportRenderedWebhookOptions {
  /** `AGENCY_REPORTS_CALLBACK_SECRET`; undefined refuses every callback. */
  callbackSecret: string | undefined;
  /** `AGENCY_REPORTS_RETENTION_DAYS`. */
  retentionDays: number;
  /** Tests: the apply path and the clock. */
  apply?: (runId: string, attempt: number, callback: ReportRenderCallback) => Promise<RenderOutcomeResult>;
  nowMs?: () => number;
}

type RawRequest = FastifyRequest & { rawBody?: string };

export async function reportRenderedWebhookRoutes(app: FastifyInstance, opts: ReportRenderedWebhookOptions): Promise<void> {
  const applyDeps = defaultApplyDeps(opts.retentionDays);
  const apply = opts.apply ?? ((runId, attempt, callback) => applyRenderOutcome(runId, attempt, callback, applyDeps));
  const nowMs = opts.nowMs ?? Date.now;

  // This plugin's own JSON parser (encapsulated: no other route sees it): the body is kept as
  // the exact string the signature covers, and parsed only after the signature verifies.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as RawRequest).rawBody = body as string;
    done(null, body);
  });

  app.post(REPORT_RENDERED_ROUTE, async (request, reply) => {
    const rawBody = (request as RawRequest).rawBody ?? '';
    const check = verifyReportCallback({
      secret: opts.callbackSecret,
      timestamp: request.headers[REPORT_TIMESTAMP_HEADER],
      signature: request.headers[REPORT_SIGNATURE_HEADER],
      rawBody,
      nowMs: nowMs(),
    });
    if (!check.ok) {
      agencyReportsCallbacksTotal.inc({ result: 'bad_signature' });
      log.warn({ reason: check.reason, ip: request.ip }, 'Report render callback refused: bad signature');
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid callback signature.' });
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      json = undefined;
    }
    const parsed = callbackSchema.safeParse(json);
    if (!parsed.success) {
      agencyReportsCallbacksTotal.inc({ result: 'invalid' });
      return reply.code(400).send({ error: 'Bad Request', message: 'Not a render callback.' });
    }
    const callback: ReportRenderCallback = { ...parsed.data, run_id: parsed.data.run_id.toLowerCase() };
    const outcome = await apply(callback.run_id, callback.attempt, callback);
    if (outcome.result === 'invalid') {
      agencyReportsCallbacksTotal.inc({ result: 'invalid' });
      log.warn({ runId: callback.run_id, attempt: callback.attempt, reason: outcome.reason }, 'Report render callback refused');
      return reply.code(400).send({ error: 'Bad Request', message: 'The callback does not match the run.' });
    }
    agencyReportsCallbacksTotal.inc({ result: outcome.result });
    return reply.code(204).send();
  });
}
