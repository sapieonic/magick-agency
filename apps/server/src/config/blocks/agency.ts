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

const agencySchema = z.object({
  rosterReplaceEnabled: envBoolean.default(false),
  insightsRollup: insightsRollupSchema.default({}),
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
    },
  };
}
