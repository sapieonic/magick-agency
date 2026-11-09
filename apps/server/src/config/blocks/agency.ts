import { z } from 'zod';
import { envBoolean, type Env } from '../env.js';

/**
 * Agency config (decision B4: one config block per area, so blocks never collide).
 */

/**
 * `rosterReplaceEnabled` (`AGENCY_ROSTER_REPLACE_ENABLED`) gates the two DESTRUCTIVE roster
 * paths — `mode: 'replace'` on an ingest, and the roster-clear endpoint. **Defaults OFF**:
 * every replace fails at the in-process supersede (decision B15:
 * there is no supersede primitive), so a surface that is visible and always fails is a
 * support ticket per operator, while a surface that is not registered is a feature that has
 * not shipped. Enable it only once a real supersede exists.
 *
 * There is no credits threshold: the app has no credits (decision S6).
 *
 * `insightsRollup`: the insights rollup job (`agency/insights-rollup-job.ts`, migration 0012).
 *  - `intervalMs` (`AGENCY_INSIGHTS_ROLLUP_INTERVAL_MS`, default 15 s): how often a pass runs.
 *    The page's range sections are at most about this far behind the attempts table.
 *  - `batchSize` (`AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE`, default 200): dirty MARKS claimed per
 *    batch, oldest first, one transaction each (`INSIGHTS_CLAIM_SQL`'s LIMIT). The batch then
 *    collapses every other mark of the buckets those marks name and recomputes each bucket once,
 *    so it recomputes at most this many buckets (fewer when several claimed marks share one). A
 *    pass keeps taking batches while they come back full (a backfill, a burst), within half an
 *    interval.
 */
const insightsRollupSchema = z.object({
  intervalMs: z.coerce.number().int().min(1000).max(600_000).default(15_000),
  batchSize: z.coerce.number().int().min(1).max(5000).default(200),
});

/**
 * `customerHistory`: the customer-history search (`docs/customer-history.md`, CH6 and CH11).
 *  - `searchesPerMinute` (`AGENCY_CUSTOMER_SEARCH_PER_MINUTE`, default 30): searches and exports a
 *    minute per user, their own bucket (`chs:<user id>`) besides the general per-user one.
 *  - `searchTtlMinutes` (`AGENCY_CUSTOMER_SEARCH_TTL_MINUTES`, default 30): how long a `search_id`
 *    names its search for the timeline pages and the export.
 *  - `exportMaxRows` (`AGENCY_CUSTOMER_EXPORT_MAX_ROWS`, default 10000): the export's row cap;
 *    past it the CSV is cut and answers `X-Export-Truncated: true`.
 */
const customerHistorySchema = z.object({
  searchesPerMinute: z.coerce.number().int().min(1).max(10_000).default(30),
  searchTtlMinutes: z.coerce.number().int().min(1).max(24 * 60).default(30),
  exportMaxRows: z.coerce.number().int().min(1).max(100_000).default(10_000),
});

/**
 * `reports`: agent, campaign and account reports (docs/reports.md "Config", RP8, RP12, RP13).
 *  - `renderer` (`AGENCY_REPORTS_RENDERER`, default `inline`): `inline` renders in process (dev
 *    and tests); `sqs` sends each run to the renderer Lambda through `sqsQueueUrl`, which calls
 *    back at `${callbackBaseUrl}/webhooks/reports/rendered` signed with `callbackSecret`. Under
 *    `sqs` all three are required, the secret must be at least 32 characters, and the `s3` block
 *    (`S3_AUDIO_BUCKET`) must be set ({@link agencyCrossBlockIssues}): boot fails otherwise,
 *    rather than queueing runs nothing can ever finish. The secret is never trimmed: leading or
 *    trailing whitespace fails boot.
 *  - `callbackSecretPrevious` (`AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS`, optional): a second
 *    secret the webhook also accepts, never signs with. It exists for a rotation (aws/README.md,
 *    "Rotating the callback secret"): the server takes the new secret while still accepting the
 *    old one, so callbacks from renders that started before the Lambda switched still verify.
 *    Same rules as the secret (as written, no outer whitespace, at least 32 characters under
 *    `sqs`). Remove it once the rotation is done.
 *  - `chromePath` (`AGENCY_REPORTS_CHROME_PATH`): Chromium for `inline` (else the renderer's own
 *    discovery).
 *  - `maxDetailRows` (`AGENCY_REPORTS_MAX_DETAIL_ROWS`, 100,000): a detail sheet's row cap (RP12).
 *  - `assemblerIntervalMs` (2 s) and `tickIntervalMs` (60 s): the assembler's poll and the
 *    reports tick (notify, reconcile, subscriptions, expiry).
 *  - `renderTimeoutMs` (15 min) and `maxAttempts` (3): a run with no callback after the timeout
 *    is re-sent, up to the attempts, then fails `render_timed_out` (RP13). The timeout counts from
 *    the send, queue wait included: size it above the renderer's backlog (docs/operations.md,
 *    "Reports: sizing the render timeout").
 *  - `retentionDays` (90): a ready run's `expires_at` (RP8; the bucket's lifecycle matches it).
 *  - `tenantPendingLimit` (5): runs queued, assembling or rendering per tenant
 *    (`report_queue_full` past it). `userPerMinute` (3): ad hoc requests per user per minute
 *    (`report_rate_limited`).
 */
export const REPORTS_CALLBACK_SECRET_MIN_LENGTH = 32;

const optionalText = z.string().trim().optional().transform((v) => (v === undefined || v === '' ? undefined : v));
/**
 * The callback secret is used exactly as written, never trimmed: the renderer Lambda signs with
 * its own copy byte for byte, so a trimmed server copy would refuse every callback. Leading or
 * trailing whitespace is refused at load instead (below); empty is absent.
 */
const untrimmedOptionalText = z.string().optional().transform((v) => (v === undefined || v === '' ? undefined : v));

const reportsSchema = z.object({
  renderer: z.enum(['inline', 'sqs']).default('inline'),
  sqsQueueUrl: optionalText,
  callbackBaseUrl: optionalText,
  callbackSecret: untrimmedOptionalText,
  callbackSecretPrevious: untrimmedOptionalText,
  chromePath: optionalText,
  maxDetailRows: z.coerce.number().int().min(1).max(1_000_000).default(100_000),
  assemblerIntervalMs: z.coerce.number().int().min(250).max(600_000).default(2_000),
  tickIntervalMs: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  renderTimeoutMs: z.coerce.number().int().min(10_000).max(24 * 3_600_000).default(900_000),
  maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
  retentionDays: z.coerce.number().int().min(1).max(3650).default(90),
  tenantPendingLimit: z.coerce.number().int().min(1).max(1000).default(5),
  userPerMinute: z.coerce.number().int().min(1).max(1000).default(3),
}).superRefine((data, ctx) => {
  for (const [key, env] of [['callbackSecret', 'AGENCY_REPORTS_CALLBACK_SECRET'], ['callbackSecretPrevious', 'AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS']] as const) {
    const value = data[key];
    if (value !== undefined && value !== value.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${env} has leading or trailing whitespace: remove it here and in the renderer's copy `
          + '(the callback is signed with the value exactly as written)',
      });
    }
  }
  if (data.renderer !== 'sqs') return;
  if (data.sqsQueueUrl === undefined || !/^https:\/\/\S+$/.test(data.sqsQueueUrl)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sqsQueueUrl'],
      message: 'AGENCY_REPORTS_RENDERER=sqs needs AGENCY_REPORTS_SQS_QUEUE_URL (the https:// queue URL)',
    });
  }
  // Scheme and host only (a trailing slash is fine): the dispatcher appends the webhook path, and
  // a base with a path (`https://host/api`) would send every callback to a route that 404s.
  if (data.callbackBaseUrl === undefined || !/^https?:\/\/[^\s/]+\/?$/.test(data.callbackBaseUrl)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['callbackBaseUrl'],
      message: 'AGENCY_REPORTS_RENDERER=sqs needs AGENCY_REPORTS_CALLBACK_BASE_URL (the server\'s public base URL, http(s)://host, no path)',
    });
  }
  if (data.callbackSecret === undefined || data.callbackSecret.length < REPORTS_CALLBACK_SECRET_MIN_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['callbackSecret'],
      message: `AGENCY_REPORTS_RENDERER=sqs needs AGENCY_REPORTS_CALLBACK_SECRET of at least ${REPORTS_CALLBACK_SECRET_MIN_LENGTH} characters`,
    });
  }
  if (data.callbackSecretPrevious !== undefined && data.callbackSecretPrevious.length < REPORTS_CALLBACK_SECRET_MIN_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['callbackSecretPrevious'],
      message: `AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS must be at least ${REPORTS_CALLBACK_SECRET_MIN_LENGTH} characters, like the secret`,
    });
  }
}).transform((data) => ({
  ...data,
  // Joined with `/webhooks/reports/rendered` by the dispatcher: no trailing slash.
  callbackBaseUrl: data.callbackBaseUrl?.replace(/\/+$/, ''),
}));

/**
 * The checks that read another area's block, run by `parseConfig` (`config/load.ts`) on the
 * parsed config. `AGENCY_REPORTS_RENDERER=sqs` needs the app's bucket (the voice block's `s3`,
 * `S3_AUDIO_BUCKET`): the server writes each dataset there and the renderer reads it and writes
 * the files back, so without it every run would be queued and never finish.
 */
export function agencyCrossBlockIssues(config: {
  s3?: { audioBucket: string } | undefined;
  agency: { reports: { renderer: 'inline' | 'sqs' } };
}): z.ZodIssue[] {
  const issues: z.ZodIssue[] = [];
  if (config.agency.reports.renderer === 'sqs' && !config.s3?.audioBucket) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ['agency', 'reports', 'renderer'],
      message: 'AGENCY_REPORTS_RENDERER=sqs needs the S3 bucket the renderer reads and writes: set S3_AUDIO_BUCKET '
        + '(with AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)',
    });
  }
  return issues;
}

const agencySchema = z.object({
  rosterReplaceEnabled: envBoolean.default(false),
  insightsRollup: insightsRollupSchema.default({}),
  customerHistory: customerHistorySchema.default({}),
  reports: reportsSchema.default({}),
});

export const agencyConfigSchema = z.object({
  agency: agencySchema.default({}),
});

export function readAgencyEnv(env: Env): Record<string, unknown> {
  return {
    agency: {
      rosterReplaceEnabled: env['AGENCY_ROSTER_REPLACE_ENABLED'],
      insightsRollup: {
        intervalMs: env['AGENCY_INSIGHTS_ROLLUP_INTERVAL_MS'],
        batchSize: env['AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE'],
      },
      customerHistory: {
        searchesPerMinute: env['AGENCY_CUSTOMER_SEARCH_PER_MINUTE'],
        searchTtlMinutes: env['AGENCY_CUSTOMER_SEARCH_TTL_MINUTES'],
        exportMaxRows: env['AGENCY_CUSTOMER_EXPORT_MAX_ROWS'],
      },
      reports: {
        renderer: env['AGENCY_REPORTS_RENDERER'] || undefined,
        sqsQueueUrl: env['AGENCY_REPORTS_SQS_QUEUE_URL'],
        callbackBaseUrl: env['AGENCY_REPORTS_CALLBACK_BASE_URL'],
        callbackSecret: env['AGENCY_REPORTS_CALLBACK_SECRET'],
        callbackSecretPrevious: env['AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS'],
        chromePath: env['AGENCY_REPORTS_CHROME_PATH'],
        maxDetailRows: env['AGENCY_REPORTS_MAX_DETAIL_ROWS'],
        assemblerIntervalMs: env['AGENCY_REPORTS_ASSEMBLER_INTERVAL_MS'],
        tickIntervalMs: env['AGENCY_REPORTS_TICK_INTERVAL_MS'],
        renderTimeoutMs: env['AGENCY_REPORTS_RENDER_TIMEOUT_MS'],
        maxAttempts: env['AGENCY_REPORTS_MAX_ATTEMPTS'],
        retentionDays: env['AGENCY_REPORTS_RETENTION_DAYS'],
        tenantPendingLimit: env['AGENCY_REPORTS_TENANT_PENDING_LIMIT'],
        userPerMinute: env['AGENCY_REPORTS_USER_PER_MINUTE'],
      },
    },
  };
}
