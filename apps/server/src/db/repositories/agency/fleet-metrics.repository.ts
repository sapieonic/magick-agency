/**
 * The fleet-wide gauge reads: the rolling abandonment window and live attempt
 * concurrency by state. Neither starts from a campaign.
 */
import { getPool } from '@magick-agency/db';
// A LEAF module by design — see its header. Importing the predicate from the
// metrics module instead would give this repository a dependency on the thing it
// exists to independently audit.
import {
  ABANDONED_ATTEMPT_PREDICATE_SQL,
  ABANDONMENT_WINDOW_HOURS,
  type AgencyAbandonmentWindowRow,
} from '@magick-agency/domain/abandonment-predicate';

/**
 * The rolling abandonment window.
 *
 * Its own class because it is the one reader whose whole purpose is to be an
 * INDEPENDENT audit of the Prometheus counters — it touches nothing in process,
 * derives everything from raw columns, and must stay that way. See
 * `src/agency/abandonment-metrics.ts` for why that independence is load-bearing.
 */
export class AgencyAbandonmentRepository {
  /**
   * Answered and abandoned counts per campaign over the rolling window.
   *
   * One grouped aggregate rather than a query per campaign: this runs on a timer
   * against a table that grows for the life of the account, and N+1 over campaigns
   * would scale with the thing most likely to grow.
   *
   * The window is bounded on `answered_at`, not `created_at`: the regulatory
   * question is "of the calls a customer picked up in the last 24 hours, how many
   * reached nobody", so an attempt that was placed yesterday and answered ten
   * minutes ago belongs in this window.
   */
  async window24h(): Promise<AgencyAbandonmentWindowRow[]> {
    const { rows } = await getPool().query<{
      tenant_id: string; campaign_id: string; answered: string; abandoned: string;
      status: string | null; ceiling_pct: number | null;
    }>(
      `SELECT a.tenant_id,
              a.campaign_id,
              COUNT(*)::text AS answered,
              COUNT(*) FILTER (WHERE ${ABANDONED_ATTEMPT_PREDICATE_SQL})::text AS abandoned,
              c.status,
              c.abandonment_ceiling_pct AS ceiling_pct
         FROM agency_call_attempts a
         LEFT JOIN agency_campaigns c ON c.id = a.campaign_id
        WHERE a.state = 'ended'
          AND a.answered_at IS NOT NULL
          AND a.answered_at > now() - ($1 || ' hours')::interval
        GROUP BY a.tenant_id, a.campaign_id, c.status, c.abandonment_ceiling_pct`,
      [ABANDONMENT_WINDOW_HOURS],
    );
    return rows.map((r) => ({
      tenant_id: r.tenant_id,
      campaign_id: r.campaign_id,
      answered: Number(r.answered),
      abandoned: Number(r.abandoned),
      status: r.status,
      ceiling_pct: r.ceiling_pct,
    }));
  }

}

/**
 * One row of the live-concurrency read: how many attempts a campaign is holding
 * in one non-terminal state, right now.
 *
 * `state` is deliberately typed `string` and NOT `AgencyAttemptState`, even
 * though `ck_agency_attempt_state` does constrain the column to
 * exactly that union. Typing it would make the CHECK constraint the definition of
 * a **Prometheus label vocabulary**, and the house rule is that label values are
 * bounded by *source code*, never by anything outside it — a migration can widen
 * that constraint in a commit that touches no TypeScript, and the assertion would
 * go on typechecking while the metric store minted a new permanent series.
 * Narrowing therefore happens once, in the publisher, against
 * `AGENCY_ATTEMPT_LIVE_STATES`; typing it here would let a reader assume that had
 * already happened.
 */
export interface AgencyLiveAttemptStateRow {
  tenant_id: string;
  campaign_id: string;
  state: string;
  live: number;
}

/**
 * The dialer's live-concurrency read — attempts in flight, split by state.
 *
 * It feeds `agency_live_attempts_current` (published by
 * `live-concurrency-metrics.ts`), the dialer's "how many calls are up" number,
 * derived from the attempts table rather than from any in-process map.
 *
 * Its own class for the same reason `AgencyAbandonmentRepository` has one — it
 * exists solely to be read by a metrics publisher on a timer, touches nothing in
 * process, and derives everything from raw columns. Nothing on the dial path may
 * come to depend on it, because a metrics read that acquires a caller is a
 * metrics read that can fail a call.
 *
 * ── Not tenant-scoped, deliberately ────────────────────────────────────────
 * Every `/api/v1/*` read is scoped by both headers; this is not one. It is the
 * same fleet-wide operator read as `window24h()` — a replica publishes what it
 * can see of the whole floor, and Prometheus labels the result per tenant.
 */
export class AgencyLiveConcurrencyRepository {
  /**
   * Non-terminal attempts per `(tenant, campaign, state)`.
   *
   * **One grouped aggregate, never a query per campaign.** Campaigns are created
   * per roster upload and are unbounded over an account's life, so an N+1 here
   * would scale with the thing most likely to grow — and it would do so on a
   * timer, which is how a metrics poller becomes the reason the database is busy.
   *
   * `state <> 'ended'` is written as a **literal, not a bound parameter**, and
   * that is load-bearing twice over:
   *
   * 1. It matches `uq_agency_attempt_live`'s partial-index predicate
   *    (`ON agency_call_attempts (contact_id) WHERE state <> 'ended'`) *byte for byte*, which is what lets the planner prove the
   *    index covers the query. Bound as `$1` the predicate is opaque at plan
   *    time and this degrades to a scan of a table that grows for the life of
   *    the account. So the cost of this read is bounded by **live concurrency**
   *    (tens of rows) rather than by history.
   * 2. It sidesteps the `42P08` parameter-typing trap this codebase has shipped
   *    twice (`transitionStatus`, `claimTerminal`): a statement with no
   *    parameters cannot have a `$n` deduced into conflicting types, and a
   *    mocked pool never parses SQL, so a unit test could not have caught it.
   *
   * It is also the **same predicate `AgencyAttemptRepository.countLive` uses** for
   * the pacing tick's `occupied` term. That is the point of matching it rather
   * than listing the five live states: the gauge and the tick then cannot
   * disagree about what "in flight" means, so the published family reconciles
   * with the number the tick subtracted from the account limit. Two definitions of
   * occupancy — one an operator reads, one the dialer acts on — would drift apart.
   *
   * ⚠️ Reconciling it in PromQL means `sum by (state)` ACROSS STATES and then
   * `max` ACROSS REPLICAS, in that order — never a bare `sum()`. This query is
   * fleet-wide and unleadered, so every replica publishes the identical series and
   * a bare `sum()` returns R times the truth. An earlier version of this
   * paragraph said `sum(agency_live_attempts_current)` *is* occupancy, which is
   * true of one replica's samples and false of the metric anyone actually queries.
   * See the aggregator note on the gauge in
   * `@magick-agency/observability/metrics/agency`.
   *
   * No `ORDER BY`: the consumer publishes a set of gauge samples, so ordering
   * would buy nothing and cost a sort on every tick.
   */
  async liveByState(): Promise<AgencyLiveAttemptStateRow[]> {
    const { rows } = await getPool().query<{
      tenant_id: string; campaign_id: string; state: string; live: string;
    }>(
      `SELECT tenant_id,
              campaign_id,
              state,
              COUNT(*)::text AS live
         FROM agency_call_attempts
        WHERE state <> 'ended'
        GROUP BY tenant_id, campaign_id, state`,
    );
    // `::text` because pg hands `int8` back as a string; parsed here rather than
    // in the publisher so a gauge can never be `set` to a string.
    return rows.map((r) => ({
      tenant_id: r.tenant_id,
      campaign_id: r.campaign_id,
      state: r.state,
      live: Number(r.live),
    }));
  }

  /**
   * Live soft-phone calls per `(tenant, state)` (`agency_live_manual_calls_current`):
   * the other half of what holds the account's carrier slots, which no campaign owns
   * (docs/softphone.md §2). `state <> 'ended'` as a literal, the predicate pacing's
   * `countLiveForAccount` counts them with and `idx_agency_manual_calls_live`'s, so
   * the read is bounded by live calls and the gauge reconciles with the tick.
   * `state` is a string for the reason {@link AgencyLiveAttemptStateRow}'s is.
   */
  async liveManualByState(): Promise<AgencyLiveManualCallStateRow[]> {
    const { rows } = await getPool().query<{ tenant_id: string; state: string; live: string }>(
      `SELECT tenant_id, state, COUNT(*)::text AS live
         FROM agency_manual_calls
        WHERE state <> 'ended'
        GROUP BY tenant_id, state`,
    );
    return rows.map((r) => ({ tenant_id: r.tenant_id, state: r.state, live: Number(r.live) }));
  }
}

/** One row of {@link AgencyLiveConcurrencyRepository.liveManualByState}. */
export interface AgencyLiveManualCallStateRow {
  tenant_id: string;
  state: string;
  live: number;
}

export const agencyAbandonmentRepository = new AgencyAbandonmentRepository();
export const agencyLiveConcurrencyRepository = new AgencyLiveConcurrencyRepository();
