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
 * ─── THE ROLLING 24h ABANDONMENT RATE (`AD-P2-C-06`) ────────────────────────
 *
 * The compliance number, and the one the auto-pause guardrail will read
 * (`AD-P4-C-02`). Derived from `agency_call_attempts` by SQL rather than from the
 * Prometheus counters, for two reasons that both matter:
 *
 * 1. **It must be correct across a restart** (acceptance (b)). A metric counter
 *    is process-local; a regulatory 24h window cannot be rebuilt from a process
 *    that started five minutes ago.
 * 2. **It must be an INDEPENDENT reading from the counters** (acceptance (a)).
 *    The counters are audited against the table; if the table number were derived
 *    from the counters the audit would be circular and would agree while both were
 *    wrong. That is precisely the defect `AD-P2-C-11` found — `answered_at` written
 *    from `bridgedAt` made the whole predicate vacuous while `T-P2d` passed for
 *    months returning 0.
 *
 * The two therefore respond DIFFERENTLY to a restart, and that difference is
 * asserted as a test rather than asserted in this comment. A comment claiming
 * independence is a §16.6 rule-3 candidate the moment someone changes one side.
 */

/**
 * Read the window once, publish it, then let the guardrail act on the SAME rows.
 *
 * Called on a plain in-process interval. The 24h window lives in the SQL; the
 * refresh cadence is a timer. Neither is a Redis TTL, and the distinction is the
 * §6.1 invariant: a key expiring must only ever mean "the thing renewing it is
 * gone", never "a business period elapsed".
 *
 * The single read is the point (`AD-P4-C-02`). Giving the guardrail its own query
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
  // circularity `AD-P2-C-11` is about, in miniature.
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
  // `metrics.ts`. This used to carry a `publishedLabels` memo to `remove` stale
  // label sets from prom-client, which retained every combination it was ever
  // given; with one OTel registry there is nothing to unwind. A plain assignment
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
