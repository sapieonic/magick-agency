/**
 * `AgencyAgentStatsRepository`: an agent's own record. The roster and grouped
 * bodies live in `agent-roster-stats.ts` and `agent-grouped-stats.ts`; the
 * methods here delegate.
 */
import { getPool } from '@magick-agency/db';
import { createChildLogger } from '@magick-agency/observability';
// THE null-not-zero rate rule, in one place. Imported rather than re-expressed at
// each of the five call sites below — see the module for why a `0` on an empty
// denominator is the failure this exists to prevent.
import { ratePct, ratio } from '@magick-agency/domain/rates';
// The agent record's parsed window, its bucket vocabulary and the ONE spelling of
// a bucket boundary. `bucketStartSql` is shared by both aggregates below so the
// attempt buckets and the occupancy buckets cannot be cut differently.
import {
  bucketStartSql,
  bucketTruncSql,
  foldOccupancy,
  type AgentStatsParams,
} from '../../../agency/agent-record.js';
import type {
  AgencyAgentOccupancy,
  AgencyAgentStats,
  AgencyAgentStatsBucket,
  AgencyAgentCampaignRow,
} from '@magick-agency/contracts/agency';
import {
  AGENCY_ATTEMPT_METRICS_SQL,
  AGENCY_RESOLVED_ZONE_JOIN_SQL,
  AGENCY_RESOLVED_ZONE_SQL,
  occupancyIntervalsCtes,
  readAttemptMetrics,
} from './sql-fragments.js';
import { params } from './query-builders.js';
import { agentRoster } from './agent-roster-stats.js';
import { agentGroupedStats } from './agent-grouped-stats.js';

const log = createChildLogger({ component: 'agency-repository' });

/**
 * The agent's own record (`GET /api/v1/agency-agents/:agentUserId/stats`).
 *
 * Its own class for the same reason `AgencyAbandonmentRepository` has one: the
 * question it answers is not a campaign's. Every other read here starts from a
 * campaign id; this one starts from a PERSON, joins to their sessions, and only
 * then reaches attempts and campaigns — so its predicates, its indexes and its
 * grouping have nothing in common with the supervisor dashboard's.
 *
 * ── Two round trips, on purpose ─────────────────────────────────────────────
 *
 * `campaignStats` keeps every scalar aggregate in ONE statement because its
 * numerator and denominator both resolve `now()` and a rate built from two
 * statements can exceed 100% on arithmetic alone. That hazard does not exist
 * here: both reads are bounded by the SAME caller-supplied `[from, to)` window,
 * not by `now()`, so they cannot disagree about which window they measured. The
 * one place `now()` does appear — closing an open final interval — is in the
 * occupancy read alone and has no counterpart in the other.
 *
 * What they do not share is shape: one aggregates ATTEMPTS by (bucket,
 * campaign), the other aggregates INTERVALS by (bucket, state) from a different
 * table with a window function and a lateral series. There is no honest single
 * statement, and they are issued in parallel.
 *
 * ── Every counter in `totals` is the SUM of the buckets, computed here ───────
 *
 * Not read as a second aggregate with the grouping removed. The buckets, the
 * per-campaign rows and the totals are three foldings of one row set, so they
 * cannot disagree — the same reasoning `agents_by_state` uses when it tallies the
 * roster it already fetched rather than issuing its own `GROUP BY`. It also makes
 * the "cross-campaign totals sum exactly" property of the per-campaign-timezone
 * bucketing (see `AgencyAgentStats`) structural rather than a claim.
 */
export class AgencyAgentStatsRepository {
  /**
   * `scope` is the caller's tenant and account, and it is a REQUIRED predicate
   * rather than a filter.
   *
   * There is no campaign in this route's path, so there is nothing to run
   * `requireOwned` against: `agent_user_id` is the app's `users.id`, opaque to
   * the dialer tables, which cannot tell a real one from a guess. Both reads below therefore
   * scope on `agency_agent_sessions` — which carries the tenant and account
   * stamped from the campaign — so an agent id from another tenant resolves to no
   * sessions, no attempts and no events, i.e. an empty record rather than someone
   * else's.
   */
  async stats(
    scope: { tenantId: string; accountId: string; agentUserId: string },
    query: AgentStatsParams,
  ): Promise<AgencyAgentStats> {
    const [attemptRows, occupancyRows] = await Promise.all([
      this.attemptBuckets(scope, query),
      // ── Occupancy degrades ALONE; the rest of the record does not ─────────
      //
      // The two reads answer different questions and only one of them depends on
      // the session event log. An occupancy-specific failure — the events table
      // unreadable, the same drift the write
      // path already swallows — must not discard attempt totals that were read
      // successfully: the caller asked "what did I do", and answering it with a
      // 500 because a second statement about where their time went could not run
      // is strictly worse than answering it with the occupancy block at zero.
      //
      // This is the read-side counterpart of `recordTransitions`, which is
      // deliberately best-effort for the mirror-image reason (a dropped event
      // costs one occupancy row; a thrown error mid-transition takes an agent off
      // the floor). Both sides of the log are therefore non-fatal, and the warn
      // log is the only symptom either produces.
      //
      // ⚠️ The degraded value is `[]`, which `foldOccupancy` turns into
      // `zeroOccupancy()` — all six states present at zero. That is the only shape
      // available: `AgencyAgentOccupancy` documents `by_state` as "all six states,
      // always present", so there is no way to say "not measured" on this payload
      // and the degraded record is INDISTINGUISHABLE from an agent who has no
      // events at all (a session with no recorded transitions). Making the two distinguishable is
      // a contract change, not a catch block; until then the log line below is the
      // only place the difference exists.
      this.occupancyBuckets(scope, query).catch((err: unknown) => {
        log.warn(
          {
            err,
            agentUserId: scope.agentUserId,
            from: query.from.toISOString(),
            to: query.to.toISOString(),
          },
          'Agent occupancy read failed — serving the record with occupancy at zero',
        );
        return [] as { bucket_start: string; state: string; seconds: number }[];
      }),
    ]);
    const agentUserId = scope.agentUserId;

    /** One accumulator per bucket label, built from BOTH reads. */
    interface BucketAcc {
      attempts: number; connected: number; successes: number;
      talk: number; wrapup: number;
      occupancy: { state: string; seconds: number }[];
    }
    const emptyBucket = (): BucketAcc =>
      ({ attempts: 0, connected: 0, successes: 0, talk: 0, wrapup: 0, occupancy: [] });
    const buckets = new Map<string, BucketAcc>();
    const bucketFor = (label: string): BucketAcc => {
      const existing = buckets.get(label);
      if (existing) return existing;
      const fresh = emptyBucket();
      buckets.set(label, fresh);
      return fresh;
    };

    const campaigns = new Map<string, AgencyAgentCampaignRow>();

    for (const row of attemptRows) {
      const bucket = bucketFor(row.bucket_start);
      bucket.attempts += row.attempts;
      bucket.connected += row.connected;
      bucket.successes += row.successes;
      bucket.talk += row.talk_seconds;
      bucket.wrapup += row.wrapup_seconds;

      const campaign = campaigns.get(row.campaign_id) ?? {
        campaign_id: row.campaign_id,
        attempts: 0, connected: 0, successes: 0, talk_seconds: 0, wrapup_seconds: 0,
      };
      campaign.attempts += row.attempts;
      campaign.connected += row.connected;
      campaign.successes += row.successes;
      campaign.talk_seconds += row.talk_seconds;
      campaign.wrapup_seconds += row.wrapup_seconds;
      campaigns.set(row.campaign_id, campaign);
    }

    // A bucket that carries occupancy and no attempts is created here rather than
    // skipped: an agent who was on the floor and never dialled is one of the more
    // useful rows on this payload, and dropping it would make the record look like
    // they were not at work.
    for (const row of occupancyRows) {
      bucketFor(row.bucket_start).occupancy.push({ state: row.state, seconds: row.seconds });
    }

    // Lexicographic on `YYYY-MM-DD` IS chronological, which is half the reason the
    // label is formatted that way (the other half is that node-pg would parse a
    // bare timestamp into a local-time Date — see `bucketStartSql`).
    const labels = [...buckets.keys()].sort();

    const wireBuckets: AgencyAgentStatsBucket[] = labels.map((label) => {
      const acc = buckets.get(label) as BucketAcc;
      return {
        bucket_start: label,
        attempts: acc.attempts,
        connected: acc.connected,
        successes: acc.successes,
        talk_seconds: acc.talk,
        wrapup_seconds: acc.wrapup,
        occupancy: foldOccupancy(acc.occupancy),
      };
    });

    const totals = wireBuckets.reduce(
      (acc, bucket) => {
        acc.attempts += bucket.attempts;
        acc.connected += bucket.connected;
        acc.successes += bucket.successes;
        acc.talk += bucket.talk_seconds;
        acc.wrapup += bucket.wrapup_seconds;
        return acc;
      },
      { attempts: 0, connected: 0, successes: 0, talk: 0, wrapup: 0 },
    );
    // Folded from every occupancy row in one pass rather than by adding the
    // buckets' `shift_seconds` together — same rows, same answer, and it keeps the
    // "unknown state" and "negative interval" guards in exactly one place.
    const occupancy: AgencyAgentOccupancy = foldOccupancy(occupancyRows);

    return {
      agent_user_id: agentUserId,
      bucket: query.bucket,
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      totals: {
        attempts: totals.attempts,
        connected: totals.connected,
        // `null`, never `0`, on a zero denominator — the imported rule. Nothing
        // dialled is not a 0% connect rate.
        connect_rate_pct: ratePct(totals.connected, totals.attempts),
        successes: totals.successes,
        // The denominator is CONNECTED, not attempts: a call that never bridged
        // had no conversation to convert.
        success_rate_pct: ratePct(totals.successes, totals.connected),
        talk_seconds: totals.talk,
        wrapup_seconds: totals.wrapup,
        // Talk PLUS wrap-up over connected calls — deliberately a different
        // definition from `AgencyCampaignStats.aht_seconds` (talk only, voicemail
        // excluded). See the field's doc comment; the denominator is on the
        // payload so the number is always reproducible by the reader.
        aht_seconds: ratio(totals.talk + totals.wrapup, totals.connected),
        campaigns: campaigns.size,
        occupancy,
      },
      buckets: wireBuckets,
      by_campaign: [...campaigns.values()],
    };
  }

  /**
   * Attempts per (bucket, campaign) over `[from, to)` on `dialed_at`.
   *
   * ── The bucket is cut in the CAMPAIGN's timezone, per row ───────────────────
   *
   * `bucketStartSql` interpolates the validated unit and the resolved zone; the
   * product argument for having no `tz` parameter is on `AgencyAgentStats`. The
   * mechanical point here is that `c.default_timezone` comes off the attempt's own
   * campaign, so a cross-campaign query cuts each attempt in its own zone and
   * every attempt still lands in exactly one bucket.
   *
   * ── The zone is RESOLVED, never used raw ───────────────────────────────────
   *
   * `default_timezone` is `VARCHAR(64)` with no constraint and is populated from
   * customer-facing config, so it can hold anything. `some_ts AT TIME ZONE
   * 'Mars/Olympus'` raises `22023 invalid_parameter_value`, which nothing maps to
   * a status — so ONE campaign with a typo would 500 the whole record, including
   * every other campaign's numbers. The LEFT JOIN to `pg_timezone_names` turns
   * that into a fallback: a zone Postgres will not resolve yields NULL and the
   * COALESCE buckets those rows in UTC.
   *
   * That is the same shape as `calling-hours.ts`, which caches a per-zone
   * `Intl.DateTimeFormat` and returns null for one it cannot construct rather than
   * letting a `RangeError` out of the pacing tick — and it is deliberately as
   * strict: `pg_timezone_names` carries zone NAMES, not the abbreviations in
   * `pg_timezone_abbrevs`, so a bare `IST` falls back to UTC exactly as
   * `isUsableTimezone` refuses it. The join is once per statement over a ~1,200
   * row view, not once per attempt.
   *
   * It is also LATERAL and `LIMIT 1`, and that is about CARDINALITY rather than cost
   * — the join sits inside an aggregate's FROM, so two matching zone rows for one
   * campaign would double every counter for that campaign's attempts. See
   * {@link AGENCY_RESOLVED_ZONE_JOIN_SQL}, which is the single spelling all three
   * statements carrying this join interpolate.
   *
   * Bucketed on `dialed_at` and nothing else: `created_at` precedes the dial by a
   * dispatch hop (so it can bucket an attempt into a day nothing was dialled in)
   * and `ended_at` pushes a call straddling midnight into the later day while
   * leaving a live one in no day at all. `hourlyBuckets` states both, and this
   * follows it — including formatting the label in SQL, because node-pg parses a
   * bare `timestamp` into a LOCAL-time `Date` and would put the server's zone back
   * on the way out.
   */
  private async attemptBuckets(
    scope: { tenantId: string; accountId: string; agentUserId: string },
    p: AgentStatsParams,
  ): Promise<{
    bucket_start: string; campaign_id: string;
    attempts: number; connected: number; successes: number;
    talk_seconds: number; wrapup_seconds: number;
  }[]> {
    const zone = AGENCY_RESOLVED_ZONE_SQL;
    const bind = params();
    for (const value of [scope.agentUserId, p.from, p.to, scope.tenantId, scope.accountId]) bind.add(value);
    const campaignFilter = p.campaignId
      ? `\n          AND a.campaign_id = ${bind.add(p.campaignId)}::uuid`
      : '';

    const { rows } = await getPool().query<{
      bucket_start: string; campaign_id: string;
      attempts: string; connected: string; successes: string;
      talk_seconds: string; wrapup_seconds: string;
    }>(
      `SELECT ${bucketStartSql(p.bucket, 'a.dialed_at', zone)} AS bucket_start,
              a.campaign_id,
              ${AGENCY_ATTEMPT_METRICS_SQL}
         FROM agency_call_attempts a
         JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
         JOIN agency_campaigns c ON c.id = a.campaign_id
         ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
        WHERE s.agent_user_id = $1
          AND s.tenant_id = $4
          AND s.account_id = $5
          AND a.dialed_at IS NOT NULL
          AND a.dialed_at >= $2
          AND a.dialed_at < $3${campaignFilter}
        GROUP BY 1, a.campaign_id
        ORDER BY 1, a.campaign_id`,
      bind.values,
    );

    return rows.map((r) => ({
      bucket_start: r.bucket_start,
      campaign_id: r.campaign_id,
      ...readAttemptMetrics(r),
    }));
  }

  /**
   * Seconds per (bucket, state), from the transition log.
   *
   * ── How an interval is built ────────────────────────────────────────────────
   *
   * The log records instants, not durations: an event says "this agent entered
   * `wrapup` at 14:02:11". The duration is therefore the gap to the NEXT event on
   * the same session, which is `lead(at) OVER (PARTITION BY session_id ORDER BY
   * at)`.
   *
   * Three clips make that safe at the edges:
   *
   *  1. **An OPEN final interval** — the newest event of a session, with nothing
   *     after it — is the agent's current state, and it has no end. It runs to
   *     `LEAST(now(), to)`: to the query's own upper bound if the window is
   *     historical, and to `now()` if it reaches into the present. Without this the
   *     current state contributes nothing at all, so the state an agent has been in
   *     all afternoon would be the one the record does not mention.
   *  2. **The event that CARRIES IN.** The state at `from` is set by the last event
   *     BEFORE `from`, which is not in the window. `carried` fetches exactly that
   *     one row per session (`DISTINCT ON … ORDER BY at DESC, id DESC`) and
   *     `GREATEST(at, from)` clips its interval to the window's start. Without it,
   *     an agent who went `available` at 08:55 and made their first call at 09:30
   *     would show 35 minutes of nothing in a window starting at 09:00 — and every
   *     occupancy figure would be low by however long the agent had been in their
   *     state.
   *
   *     **That clip is why `sess` is bounded to sessions overlapping the window,
   *     and the two are one mechanism rather than two.** `carried` fetches one row
   *     per session, so the read is bounded by the window only if the SESSION SET
   *     is — and per-session is per-shift. Left unbounded, every session the agent
   *     has ever closed still has a terminal event before `from`, and each one
   *     therefore carries in an interval with no successor inside the window, i.e.
   *     one that runs the window's full width. Sixty past shifts read as sixty
   *     full-window intervals: `by_state.offline` scaling with tenure rather than
   *     with the window, and `shift_seconds` inflated too for any session abandoned
   *     in a non-`offline` state. The `joined_at`/`left_at` overlap predicate is
   *     what makes “bounded by the window” true of the whole read.
   *  3. **Bucket splitting.** An interval that spans midnight belongs to two
   *     buckets, so it is CROSS JOINed to the buckets it covers and clipped to each
   *     (`LEAST(ended, bucket_end) - GREATEST(started, bucket_start)`). Attributing
   *     the whole interval to the bucket its START falls in would be the easy
   *     version and would put a night shift's whole occupancy on the first day.
   *
   * The bucket series is generated per interval from the same truncation
   * `bucketStartSql` uses, converted back through the campaign's zone so a DST day
   * is measured as the 23 or 25 hours it actually was.
   *
   * ── A session with no events reads as zero, and that is the honest answer ────
   *
   * Sessions with no recorded transitions have no rows here, so they contribute no
   * intervals and every state comes back 0 — see `zeroOccupancy`. The alternative
   * would be reconstructing time-in-state from `agency_agent_sessions.state_since`,
   * which is a snapshot every transition overwrites: it would attribute an agent's
   * ENTIRE history to whichever state they happen to be in now. Occupancy is
   * meaningful only where events were recorded.
   *
   * `offline` is measured and returned but excluded from `shift_seconds`
   * (`foldOccupancy`), so a session that ended hours ago cannot dilute occupancy
   * merely by having its final `offline` interval run to the end of the window.
   */
  private async occupancyBuckets(
    scope: { tenantId: string; accountId: string; agentUserId: string },
    p: AgentStatsParams,
  ): Promise<{
    bucket_start: string; state: string; seconds: number;
  }[]> {
    const bind = params();
    for (const value of [scope.agentUserId, p.from, p.to, scope.tenantId, scope.accountId]) bind.add(value);
    const campaignFilter = p.campaignId
      ? `\n            AND s.campaign_id = ${bind.add(p.campaignId)}::uuid`
      : '';
    // The clipped overlap of one interval with one bucket. Named because it is
    // needed twice — in the SUM and in the HAVING that drops a zero-width bucket
    // (the series is inclusive of the bucket containing `ended`, so an interval
    // ending exactly on a boundary generates one bucket it does not occupy).
    const overlap =
      'EXTRACT(EPOCH FROM (LEAST(i.ended, b.bucket_end) - GREATEST(i.started, b.bucket_start)))';
    const zone = AGENCY_RESOLVED_ZONE_SQL;

    const { rows } = await getPool().query<{
      bucket_start: string; state: string; seconds: string;
    }>(
      `${occupancyIntervalsCtes('agent', campaignFilter)}       SELECT ${bucketStartSql(p.bucket, 'b.bucket_start', 'i.zone')} AS bucket_start,
              i.state,
              SUM(${overlap})::text AS seconds
         FROM intervals i
         CROSS JOIN LATERAL (
           SELECT (gs AT TIME ZONE i.zone) AS bucket_start,
                  ((gs + interval '1 ${p.bucket}') AT TIME ZONE i.zone) AS bucket_end
             FROM generate_series(
                    ${bucketTruncSql(p.bucket, 'i.started', 'i.zone')},
                    ${bucketTruncSql(p.bucket, 'i.ended', 'i.zone')},
                    interval '1 ${p.bucket}') gs
         ) b
        WHERE i.ended > i.started
        GROUP BY 1, i.state
       HAVING SUM(${overlap}) > 0
        ORDER BY 1, i.state`,
      bind.values,
    );

    return rows.map((r) => ({
      bucket_start: r.bucket_start,
      state: r.state,
      seconds: Number(r.seconds),
    }));
  }

  /** The supervisor's agent roster; see {@link agentRoster}. */
  async roster(...args: Parameters<typeof agentRoster>): ReturnType<typeof agentRoster> {
    return agentRoster(...args);
  }

  /** The grouped agent read; see {@link agentGroupedStats}. */
  async groupedStats(...args: Parameters<typeof agentGroupedStats>): ReturnType<typeof agentGroupedStats> {
    return agentGroupedStats(...args);
  }
}

export const agencyAgentStatsRepository = new AgencyAgentStatsRepository();
