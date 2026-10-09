import { createChildLogger } from '@magick-agency/observability';
import { agencyAbandonmentRepository } from '../db/repositories/agency.repository.js';
import { abandonmentRatePct, type AgencyAbandonmentWindowRow } from '@magick-agency/domain/abandonment-predicate';
import { enforceAbandonmentCeiling } from './abandonment-guardrail.js';
import {
  setAgencyAbandonmentWindow,
  resetAgencyAbandonmentWindow,
  type AgencyAbandonmentSample,
} from '@magick-agency/observability/metrics/agency';

const log = createChildLogger({ component: 'agency-abandonment-metrics' });

/**
 * ─── THE ROLLING 24h ABANDONMENT RATE ───────────────────────────────────────
 *
 * The compliance number, and the one the auto-pause guardrail reads. Derived from
 * `agency_call_attempts` by SQL rather than from the Prometheus counters, for two
 * reasons that both matter:
 *
 * 1. **It must be correct across a restart.** A metric counter is process-local;
 *    a regulatory 24h window cannot be rebuilt from a process that started five
 *    minutes ago.
 * 2. **It must be an INDEPENDENT reading from the counters.** The counters are
 *    audited against the table; if the table number were derived from the counters
 *    the audit would be circular and would agree while both were wrong. A vacuous
 *    predicate hid exactly that once — `answered_at` written from `bridgedAt` made
 *    the rate read 0 while its test passed.
 *
 * The two therefore respond DIFFERENTLY to a restart, and that difference is
 * asserted as a test rather than asserted in this comment. A comment claiming
 * independence goes stale the moment someone changes one side.
 */

/**
 * Read the window once, publish it, then let the guardrail act on the SAME rows.
 *
 * Called on a plain in-process interval. The 24h window lives in the SQL; the
 * refresh cadence is a timer. Neither is a Redis TTL, and the distinction is an
 * invariant of the dialer runtime: a key expiring must only ever mean "the thing
 * renewing it is gone", never "a business period elapsed".
 *
 * The single read is the point. Giving the guardrail its own query
 * would be a second definition of "the rolling window", and a campaign paused on
 * a rate that disagrees with the gauge a compliance alert reads is a
 * contradiction nobody discovers until an audit. The publish runs first so a
 * failing pause cannot cost us the metrics; `enforceAbandonmentCeiling` never
 * throws, but the ordering says so without depending on that.
 */
export async function refreshAbandonmentWindow(): Promise<void> {
  const rows = await agencyAbandonmentRepository.window24h();
  publishAbandonmentMetrics(rows);
  await enforceAbandonmentCeiling(rows);
}

export function publishAbandonmentMetrics(rows: readonly AgencyAbandonmentWindowRow[]): void {
  // The rate is computed ONCE, here, and all three gauges read that one value.
  // Letting each derive its own would be two definitions of the compliance
  // number, and they would agree right up until someone changed one — the
  // circularity described above, in miniature.
  const samples: AgencyAbandonmentSample[] = rows.map((row) => ({
    tenant_id: row.tenant_id,
    campaign_id: row.campaign_id,
    answered: row.answered,
    abandoned: row.abandoned,
    ratePct: abandonmentRatePct(row),
  }));

  // A whole-snapshot replace, and that is all the bookkeeping there is: a
  // campaign that aged out of the window is simply absent from the next
  // collection, and a null rate is omitted rather than exported as 0 ("no data"
  // and "0%" are different answers) — both decided by the gauges' callbacks in
  // `metrics.ts`, so there are no stale label sets to remove. A plain assignment
  // that cannot throw, so it can never skip `enforceAbandonmentCeiling` after it.
  setAgencyAbandonmentWindow(samples);

  log.debug({ campaigns: rows.length }, 'Refreshed agency abandonment window');
}

/** Test seam — the module-level snapshot would otherwise leak between cases. */
export function resetAbandonmentMetricsState(): void {
  resetAgencyAbandonmentWindow();
}

/**
 * Periodic refresh. Returned handle stops it; `unref` so it never holds the
 * process open at shutdown.
 */
export function startAbandonmentMetricsRefresh(intervalMs: number): { stop: () => void } {
  const timer = setInterval(() => {
    void refreshAbandonmentWindow().catch((err) =>
      log.error({ err }, 'Failed to refresh agency abandonment window'));
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
