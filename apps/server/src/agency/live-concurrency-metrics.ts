import { createChildLogger } from '@magick-agency/observability';
import {
  agencyLiveConcurrencyRepository,
  type AgencyLiveAttemptStateRow,
} from '../db/repositories/agency.repository.js';
import { AGENCY_ATTEMPT_LIVE_STATES } from '../db/models/agency.model.js';
import {
  setAgencyLiveAttempts,
  resetAgencyLiveAttempts,
  type AgencyLiveAttemptSample,
} from '@magick-agency/observability/metrics/agency';

const log = createChildLogger({ component: 'agency-live-concurrency-metrics' });

/**
 * ─── THE DIALER'S LIVE-CONCURRENCY SIGNAL ───────────────────────────────────
 *
 * Publishes `agency_live_attempts_current`: the dialer's live calls per tenant,
 * campaign and attempt state. The gauge is declared in
 * `@magick-agency/observability/metrics/agency`.
 *
 * The sibling of `abandonment-metrics.ts` and deliberately the same shape: read
 * `agency_call_attempts` on a timer, publish a whole snapshot, let the gauge
 * expire it at collection. One difference from that module, deliberate and
 * recorded where it is made:
 *
 * - **No guardrail rides along.** `refreshAbandonmentWindow` hands its rows to
 *   `enforceAbandonmentCeiling` so the compliance number has exactly one
 *   definition. Nothing acts on these rows, and nothing on the dial path may come
 *   to: the pacing tick derives its own `occupied` from
 *   `AgencyAttemptRepository.countLive`, which uses the **same SQL predicate**
 *   (`state <> 'ended'`) rather than reading this. That is what keeps the two
 *   consistent without making a metrics read something a dial can fail on.
 */

/**
 * The label value every unrecognised `agency_call_attempts.state` folds into.
 *
 * **Be honest about the odds: this is unreachable today.**
 * `ck_agency_attempt_state` (the baseline migration) constrains the column to exactly
 * `queued|dialing|ringing|answered|bridged|ended`, and `ended` is excluded by the
 * query's own predicate — so on the current schema every row lands on a known
 * label and this constant is never used. It is not dead weight either, and what
 * makes it reachable is one line in a future migration: a state added to the
 * CHECK, or the constraint dropped, in a commit that touches no TypeScript at
 * all. The rule this enforces is that a Prometheus label vocabulary is owned by
 * **source code**, never by anything outside it (`alert_key`,
 * `preflightReasonSlug`) — and a CHECK constraint in another file, in another
 * commit, is outside it. Without the guard, that migration would silently mint a
 * permanent series per new string in the metric store.
 *
 * Folding rather than dropping, and that is the load-bearing half. Dropping the
 * row would silently make the published total smaller than the
 * `occupied` term the pacing tick computed from the same predicate — the
 * gauge-disagrees-with-the-dialer divergence this whole family is built to avoid
 * — and it would do it invisibly, which is the worst way to lose a call from a
 * concurrency total. Folded, the sum still reconciles and the anomaly is visible
 * as a series nobody expected to see, plus the WARN below.
 */
export const UNKNOWN_ATTEMPT_STATE = 'unknown';

/**
 * The blessed label values, from `AGENCY_ATTEMPT_LIVE_STATES`.
 *
 * That constant rather than a list written here, and rather than
 * `spine-filters.ts`'s `ATTEMPT_STATES` (which includes `ended`): it is the
 * repository's own definition of "non-terminal", so the label vocabulary and the
 * SQL's `state <> 'ended'` are the same statement made twice rather than two
 * lists that can drift. A state added to `AgencyAttemptState` and to that
 * constant is labelled correctly here with no further change; one added to the
 * type alone shows up as `unknown`, which is the honest answer.
 */
const KNOWN_LIVE_STATES: ReadonlySet<string> = new Set<string>(AGENCY_ATTEMPT_LIVE_STATES);

/** Read the live snapshot and publish it. */
export async function refreshLiveConcurrency(): Promise<void> {
  publishLiveConcurrency(await agencyLiveConcurrencyRepository.liveByState());
}

/**
 * Normalise the rows to label-safe samples and replace the exported snapshot.
 *
 * Split from the read so a test can drive the publish with a fixture, exactly as
 * `publishAbandonmentMetrics` is.
 *
 * **Aggregated through a map rather than mapped one-to-one**, even though the SQL
 * already grouped by `(tenant_id, campaign_id, state)`. The fold above can
 * collide — two rows carrying different unrecognised states become two samples
 * with identical labels — and a duplicated label set is wrong: the gauge would
 * receive two observations for one attribute set in a single collection
 * (undefined which survives, so a count is silently lost). Summing is the only
 * answer that keeps the total reconcilable with the tick's `occupied`.
 */
export function publishLiveConcurrency(rows: readonly AgencyLiveAttemptStateRow[]): void {
  const byLabels = new Map<string, AgencyLiveAttemptSample>();
  let unknownStates = 0;

  for (const row of rows) {
    const known = KNOWN_LIVE_STATES.has(row.state);
    if (!known) unknownStates += row.live;
    const state = known ? row.state : UNKNOWN_ATTEMPT_STATE;
    // NUL-separated, as the abandonment module's label keys are: it cannot occur
    // in a UUID or a state slug, so no two distinct triples can collide into one
    // key the way a `-` or a `:` could.
    const key = `${row.tenant_id}\u0000${row.campaign_id}\u0000${state}`;
    const existing = byLabels.get(key);
    if (existing) existing.live += row.live;
    else byLabels.set(key, { tenant_id: row.tenant_id, campaign_id: row.campaign_id, state, live: row.live });
  }

  setAgencyLiveAttempts([...byLabels.values()]);

  // At WARN, not debug: an `unknown` series is either a state the type gained
  // without this module hearing about it or a hand-written row, and both are
  // things somebody has to look at. The count of affected attempts is on the line
  // because the series alone cannot say how much concurrency it accounts for.
  if (unknownStates > 0) {
    log.warn(
      { unknownStates },
      'Agency attempts are in a state outside AGENCY_ATTEMPT_LIVE_STATES — folded into the `unknown` label',
    );
  }

  log.debug({ series: byLabels.size }, 'Refreshed agency live-concurrency snapshot');
}

/** Test seam — the module-level snapshot in `metrics.ts` leaks between cases. */
export function resetLiveConcurrencyMetricsState(): void {
  resetAgencyLiveAttempts();
}

/**
 * Periodic refresh. Returned handle stops it; `unref` so it never holds the
 * process open at shutdown.
 *
 * Failures are logged and swallowed per tick, and the snapshot is deliberately
 * left **untouched** on a failure rather than cleared: `AGENCY_LIVE_ATTEMPTS_TTL_MS`
 * is what decides how long the last good reading may still be believed, and
 * clearing here would collapse that budget to a single missed poll.
 */
export function startLiveConcurrencyRefresh(intervalMs: number): { stop: () => void } {
  const timer = setInterval(() => {
    void refreshLiveConcurrency().catch((err) =>
      log.error({ err }, 'Failed to refresh agency live-concurrency snapshot'));
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
