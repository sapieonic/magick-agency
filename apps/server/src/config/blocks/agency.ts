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

const agencySchema = z.object({
  rosterReplaceEnabled: envBoolean.default(false),
  insightsRollup: insightsRollupSchema.default({}),
  customerHistory: customerHistorySchema.default({}),
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
    },
  };
}
