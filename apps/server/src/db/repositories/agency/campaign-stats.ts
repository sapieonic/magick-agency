/**
 * The supervisor dashboard's campaign reads: the stats payload and its agent
 * roster, the trend line, and the health strip's SQL inputs. Bodies of
 * `AgencyCampaignRepository.stats` / `statsSeries` / `healthInputs`, which
 * delegate here.
 */
import { getPool } from '@magick-agency/db';
// A LEAF module by design — see its header. Importing the predicate from the
// metrics module instead would give this repository a dependency on the thing it
// exists to independently audit.
import {
  ABANDONED_ATTEMPT_PREDICATE_SQL,
  ABANDONMENT_WINDOW_HOURS,
  abandonmentRatePct,
} from '@magick-agency/domain/abandonment-predicate';
// The route/repository split of the stats payload, imported rather than restated
// as a second `Omit<..., 'campaign_id' | 'status' | ...>` literal: two copies of
// "who produces what" is how one producer quietly stops owning a field.
import { AGENCY_STATS_ROUTE_FIELDS } from '@magick-agency/contracts/agency';
import type {
  AgencyAgentLiveState,
  AgencyAgentsByState,
  AgencyCampaignStats,
  AgencyCampaignStatsBucket,
  AgencyCampaignStatsSeries,
  AgencySupervisorAgentRow,
} from '@magick-agency/contracts/agency';
// The window the strip's copy names, imported so the SQL and the sentence agree.
// From the LEAF both this repository and `campaign-health.ts` import (B9), never
// from the campaign-management module that consumes this repository's rows.
// The compliance ceiling the supervisor gauge is drawn against (imported above,
// from the same leaf), rather than re-declared: the abandonment auto-pause fires on
// the same number, and two copies of a regulatory threshold is how a dashboard
// comes to draw one line while the guardrail enforces another.
import {
  DEFAULT_ABANDONMENT_CEILING_PCT,
  RECENT_FAILURE_WINDOW_MINUTES,
} from '../../../agency/campaign-thresholds.js';
// THE null-not-zero rate rule, in one place. Imported rather than re-expressed at
// each of the five call sites below — see the module for why a `0` on an empty
// denominator is the failure this exists to prevent.
import { ratePct } from '@magick-agency/domain/rates';
// What counts as a conversion, as SQL. A leaf module for the same reason
// `ABANDONED_ATTEMPT_PREDICATE_SQL` is one: the campaign roll-up and the agent
// record must count the SAME thing, and two spellings of a JSONB predicate is how
// two screens come to disagree about how many sales there were.
import { successDispositionSql } from '@magick-agency/domain/success-disposition';
import { bucketStartSql, bucketTruncSql } from '../../../agency/agent-record.js';
// The campaign trend line's parsed window. Its own module rather than
// `agent-record.ts` because that one is the AGENT's record; see its header for
// what it imports rather than re-declares (the bucket vocabulary, the 92-day cap,
// the date rules).
import type { CampaignSeriesParams } from '../../../agency/campaign-series.js';
// The reaper's auto-stamp for a wrap-up nobody wrote up. Imported rather than
// respelled: the supervisor dashboard's third connect bucket is defined as "NULL or this",
// and a local copy would drift from the reaper that writes it — putting every
// abandoned write-up back into the human column, which is the defect the bucket
// exists to remove. Safe to import: `disposition.ts` has type-only imports.
import { AUTO_DISPOSITION_CODE } from '../../../agency/disposition.js';
import {
  AGENCY_ATTEMPT_METRICS_SQL,
  AGENCY_RESOLVED_ZONE_JOIN_SQL,
  AGENCY_RESOLVED_ZONE_SQL,
  WRAPUP_MEASURED_RESOLUTIONS_SQL,
  readAttemptMetrics,
} from './sql-fragments.js';

/**
 * A machine connect is an agent who sat through an answering machine, and the
 * only signal for it is the agent's own write-up: AMD is out of scope, so
 * nothing else in the system knows. Kept as one constant because the count, its
 * complement (`human_connects`) and both AHT variants must all agree on the same
 * code — a second spelling would put a voicemail in the human column and in the
 * AHT it is excluded from at the same time.
 */
const VOICEMAIL_DISPOSITION_CODE = 'voicemail';

/**
 * A `TIMESTAMPTZ` as an ISO instant, degrading to the epoch rather than throwing.
 *
 * `state_since` is `NOT NULL`, so the fallback is unreachable through the schema —
 * but `new Date(undefined).toISOString()` throws a `RangeError`, and the whole
 * supervisor dashboard 500ing because one roster row carried an unexpected value
 * is a far worse outcome than one agent tile being wrong. The epoch is chosen over
 * `now()` deliberately: it renders as an implausibly long time-in-state and sorts
 * to the TOP of the console's risk ordering, so the bad row is the first thing the
 * supervisor sees instead of the one that looks freshest.
 */
const isoOrEpoch = (value: Date | string): string => {
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString();
};

/** Every live state at zero. See {@link AgencyAgentsByState}. */
const zeroAgentsByState = (): AgencyAgentsByState => ({
  offline: 0,
  available: 0,
  reserved: 0,
  on_call: 0,
  wrapup: 0,
  break: 0,
});

/**
 * Supervisor dashboard payload. Two round trips: every scalar aggregate in one
 * statement, plus the agent roster.
 *
 * **Typed against the contract on purpose.** This returned
 * `Record<string, number>` while `AgencyCampaignStats` declared three fields as
 * REQUIRED that no line here produced — `abandoned_24h`, `answered_24h` and
 * `abandonment_rate_24h_pct`. An index signature satisfies every field name, so
 * the compiler cheerfully agreed the contract was met and every consumer read
 * `undefined` off a field typed non-optional. The abandonment auto-pause is
 * specified against `abandonment_rate_24h_pct`, and `undefined > ceiling` is
 * `false` — the guardrail would have read as present in review and never fired.
 * The `Omit` is what makes a future required field a compile error here instead:
 * the route supplies `campaign_id`/`status`, this method owes the rest.
 *
 * The 24h numbers are derived **from `agency_call_attempts`, not from the
 * metric counters**: a
 * metric counter is process-local, so a regulatory window cannot be rebuilt
 * from a replica that started five minutes ago, and the counter under-reports by
 * construction (see `isAbandonedAttempt`'s header). This reads the same
 * `ABANDONED_ATTEMPT_PREDICATE_SQL` and `ABANDONMENT_WINDOW_HOURS` the audited
 * window gauge reads, imported rather than restated, so the dashboard figure and
 * the gauge cannot drift into disagreeing.
 *
 * Both 24h counters resolve `now()` to the same statement timestamp, so the
 * numerator can never be read against a later window than its denominator. That
 * is why every scalar aggregate — the 24h pair, the flow metrics and all six
 * `previous_hour` windows — stays in ONE statement rather than being split for
 * readability: `now()` re-resolves per statement, and a numerator measured
 * against a window one tick later than its denominator is how a rate briefly
 * exceeds 100% and trips a guardrail on arithmetic alone.
 *
 * The roster is the deliberate second statement. It is
 * set-returning and there is no honest way to fold rows into a list of scalars;
 * it also carries no rate whose halves could disagree.
 */
export async function campaignStats(
  campaignId: string,
): Promise<
  // `agents` is overridden rather than omitted: the repository produces the whole
  // roster, but one FIELD of each row (`connected`) is the route's, because it is
  // a Redis read. See `AGENCY_AGENT_ROUTE_FIELDS`.
  Omit<AgencyCampaignStats, (typeof AGENCY_STATS_ROUTE_FIELDS)[number] | 'agents'>
  & { agents: AgencySupervisorAgentRow[] }
> {
  // ── Two scans, not twenty ─────────────────────────────────────────────────
  //
  // Every contact counter is a FILTER over ONE pass of the campaign's contacts
  // (`ct`), and every attempt counter a FILTER over ONE pass of its attempts
  // (`att`). Spelled as one subquery per number this was about twenty scans per
  // dashboard request, and `agency_contacts` has no `(campaign_id, state)` index
  // to make the six per-state ones cheap. Each FILTER is the WHERE clause its
  // subquery carried, verbatim; `campaign-stats-equivalence.test.ts` holds the
  // per-number spelling as the oracle and compares every field.
  //
  // Still ONE statement, so every `now()` below is the same instant (see the
  // header). An aggregate with no GROUP BY yields exactly one row even over no
  // rows, so the cross join of the two CTEs is always one row.
  const { rows } = await getPool().query<Record<string, string>>(
    `WITH ct AS (
         SELECT COUNT(*) AS contacts_total,
                COUNT(*) FILTER (WHERE state = 'pending') AS contacts_pending,
                COUNT(*) FILTER (WHERE state = 'in_flight') AS contacts_in_flight,
                COUNT(*) FILTER (WHERE state = 'completed') AS contacts_completed,
                COUNT(*) FILTER (WHERE state = 'suppressed') AS contacts_suppressed,
                COUNT(*) FILTER (WHERE state = 'exhausted') AS contacts_exhausted,
                COUNT(*) FILTER (WHERE state = 'pending' AND next_attempt_at > now()) AS retries_pending
           FROM agency_contacts
          WHERE campaign_id = $1
       ), att AS (
         -- FROM the attempts table ALONE: ABANDONED_ATTEMPT_PREDICATE_SQL and
         -- WRAPUP_MEASURED_RESOLUTIONS_SQL name their columns unqualified, and a
         -- joined agency_campaigns carries an ended_at and a wrapup_seconds of
         -- its own. The one counter that needs the catalog reads it through an
         -- uncorrelated subquery (an InitPlan, evaluated once), which also keeps
         -- attempts_success at 0 for a campaign row that has gone, as the JOIN
         -- it replaces did.
         SELECT COUNT(*) FILTER (WHERE state <> 'ended') AS attempts_live,
                COUNT(*) AS attempts_total,
                COUNT(*) FILTER (WHERE outcome = 'connected') AS attempts_connected,
                -- Dials that were NOT a contact's first.
                --
                -- A different question from retries_pending, and the pair
                -- is the one most likely to be read as one number: that counts contacts
                -- whose next_attempt_at is still in the future — work QUEUED — while
                -- this counts dials already PLACED. A campaign that worked its whole
                -- retry budget has retries_pending: 0 and a large attempts_retried,
                -- and reporting only the first makes it look like a campaign that reached
                -- everybody first time.
                --
                -- attempt_number is the attempts table's own counter, derived at insert
                -- from MAX(attempt_number) over the contact's rows, NOT
                -- from agency_contacts.attempt_count — the two were decoupled on
                -- purpose, and the consequence here is that an OUR-FAULT redial (a dropped
                -- station socket, a reaper requeue) is counted even though it never spent
                -- the customer's allowance. That is the honest reading of "dials that were
                -- not the first": the number was called again, whoever's fault it was.
                --
                -- dialed_at IS NOT NULL is what makes "PLACED" true, and it is not
                -- defensive: attempts are INSERTed in state 'queued' with dialed_at NULL
                -- (AgencyAttemptRepository.create), so an un-placed retry row exists by
                -- construction for the whole gap between reservation and dial — and for good
                -- on a campaign paused or stopped in that gap. Without the gate a paused
                -- campaign holding 50 queued second attempts reports attempts_retried: 50
                -- having redialled nobody. Same gate the series aggregate uses on the same
                -- table, and for the same reason it gives (see statsSeries): a dial that
                -- never happened is not a dial.
                COUNT(*) FILTER (WHERE attempt_number > 1 AND dialed_at IS NOT NULL) AS attempts_retried,
                COUNT(*) FILTER (
                  WHERE state = 'ended'
                    AND answered_at IS NOT NULL
                    AND answered_at > now() - ($2 || ' hours')::interval) AS answered_24h,
                COUNT(*) FILTER (
                  WHERE answered_at > now() - ($2 || ' hours')::interval
                    AND (${ABANDONED_ATTEMPT_PREDICATE_SQL})) AS abandoned_24h,

                -- ── Flow, over the campaign's lifetime ─────────────────────────────
                --
                -- bridged_at IS NOT NULL is the denominator gate throughout, NOT
                -- outcome = 'connected'. bridged_at is the instant media actually
                -- joined the two parties, and it is the same gate disposition.ts uses
                -- to decide whether there was a conversation to write up; outcome is a
                -- classification that can be absent, late, or say connected about a
                -- call no agent ever heard.
                --
                -- Three buckets, not two. IS DISTINCT FROM 'voicemail' is true of NULL,
                -- so a two-way split books every never-written-up call as a HUMAN connect
                -- at full duration — and that population is not small: the reaper stamps
                -- no_disposition on every lapsed wrap-up, which skews toward exactly the
                -- voicemails an agent walked away from rather than classify. The split
                -- exists so voicemail time cannot inflate the human numbers; a two-way
                -- version would have moved only the ones an agent bothered to label.
                COUNT(*) FILTER (
                  WHERE bridged_at IS NOT NULL
                    AND disposition_code IS NOT NULL
                    AND disposition_code <> $3
                    AND disposition_code <> $4) AS human_connects,
                COUNT(*) FILTER (
                  WHERE bridged_at IS NOT NULL
                    AND (disposition_code IS NULL OR disposition_code = $4)) AS unclassified_connects,
                COUNT(*) FILTER (
                  WHERE bridged_at IS NOT NULL
                    AND disposition_code = $3) AS machine_connects,

                -- Conversions -- the is_success flag. It is on every catalog entry,
                -- and its only other reader is a type check in the config validator:
                -- without this count the operator's answer would be confirmed as a
                -- boolean and then thrown away.
                --
                -- See successDispositionSql for the two shape decisions the predicate
                -- rests on: EXISTS rather than a JOIN (which would double-count a
                -- catalog carrying a duplicate code), and a jsonb comparison rather
                -- than a boolean cast (the cast raises 22P02 on a non-boolean value,
                -- and nothing maps that to a status -- the whole stats payload would
                -- 500 on one bad character in one operator's config).
                --
                -- bridged_at IS NOT NULL is the gate, like every other flow metric
                -- here: outcome = 'connected' is a classification that can be absent,
                -- late, or say connected about a call no agent ever heard.
                COUNT(*) FILTER (
                  WHERE a.bridged_at IS NOT NULL
                    AND ${successDispositionSql({
                    attempt: 'a',
                    catalog: '(SELECT cam.disposition_catalog FROM agency_campaigns cam WHERE cam.id = $1)',
                  })}) AS attempts_success,

                -- AHT is ended_at - bridged_at: the AGENT's leg. Deliberately not the
                -- persisted talk_seconds, which is anchored on answered_at (the
                -- carrier's answer) and is nonzero even when no agent ever bridged —
                -- an abandoned attempt settles carrying the apology clip's talk time.
                -- Averaging that would fold ring-to-bridge latency and
                -- abandoned calls into the one number whose purpose is agent work.
                -- outcome <> 'orphaned' on both: the reaper settles a crash-orphaned
                -- attempt with ended_at = now() AT SWEEP TIME, so a conversation whose
                -- replica died contributes its whole time-until-sweep — minutes, or
                -- hours — to the average. One orphan moves the tile visibly on a
                -- low-volume campaign, and the outcome column already names them.
                AVG(EXTRACT(EPOCH FROM (ended_at - bridged_at))) FILTER (
                  WHERE state = 'ended'
                    AND bridged_at IS NOT NULL
                    AND outcome IS DISTINCT FROM 'orphaned'
                    AND disposition_code IS DISTINCT FROM $3) AS aht_seconds,
                AVG(EXTRACT(EPOCH FROM (ended_at - bridged_at))) FILTER (
                  WHERE state = 'ended'
                    AND bridged_at IS NOT NULL
                    AND outcome IS DISTINCT FROM 'orphaned') AS aht_seconds_including_machine,

                -- Measured wrap-up, never the configured allotment. wrapup_seconds is
                -- what was OWED, copied from the campaign at wrap-up entry, so averaging
                -- it hands the operator their own setting back as if it were evidence.
                AVG(EXTRACT(EPOCH FROM (wrapup_ended_at - wrapup_started_at))) FILTER (
                  WHERE wrapup_started_at IS NOT NULL
                    AND wrapup_ended_at IS NOT NULL
                    AND ${WRAPUP_MEASURED_RESOLUTIONS_SQL}) AS avg_wrapup_seconds
           FROM agency_call_attempts a
          WHERE a.campaign_id = $1
       )
       SELECT ct.contacts_total::text AS contacts_total,
              ct.contacts_pending::text AS contacts_pending,
              ct.contacts_in_flight::text AS contacts_in_flight,
              ct.contacts_completed::text AS contacts_completed,
              ct.contacts_suppressed::text AS contacts_suppressed,
              ct.contacts_exhausted::text AS contacts_exhausted,
              ct.retries_pending::text AS retries_pending,
              att.attempts_live::text AS attempts_live,
              att.attempts_total::text AS attempts_total,
              att.attempts_connected::text AS attempts_connected,
              att.attempts_retried::text AS attempts_retried,
              (SELECT COUNT(*) FROM agency_agent_sessions WHERE campaign_id = $1 AND left_at IS NULL)::text AS agents_live,
              att.answered_24h::text AS answered_24h,
              att.abandoned_24h::text AS abandoned_24h,
              att.human_connects::text AS human_connects,
              att.unclassified_connects::text AS unclassified_connects,
              att.machine_connects::text AS machine_connects,
              att.attempts_success::text AS attempts_success,
              -- Does this campaign offer the code at all? An agent cannot submit one
              -- the catalog does not carry, so without it machine_connects is
              -- structurally 0 and measures nothing — which the console has to say
              -- rather than render as a confident zero.
              (SELECT EXISTS (
                 SELECT 1 FROM agency_campaigns c, LATERAL jsonb_array_elements(c.disposition_catalog) e
                  WHERE c.id = $1 AND e->>'code' = $3))::text AS machine_connects_available,
              att.aht_seconds::text AS aht_seconds,
              att.aht_seconds_including_machine::text AS aht_seconds_including_machine,
              att.avg_wrapup_seconds::text AS avg_wrapup_seconds,
              -- The campaign's own ceiling. A subquery rather than a
              -- join because the row is already in cache from the route's
              -- ownership check a moment earlier, and a join would make the two
              -- aggregates above depend on the campaign row existing.
              (SELECT abandonment_ceiling_pct FROM agency_campaigns
                 WHERE id = $1)::text AS abandonment_ceiling_pct
         FROM ct, att`,
    [campaignId, ABANDONMENT_WINDOW_HOURS, VOICEMAIL_DISPOSITION_CODE, AUTO_DISPOSITION_CODE],
  );
  const row = rows[0] ?? {};
  const num = (key: string): number => Number(row[key] ?? 0);
  /**
   * `null`, never `0`, for an average with nothing behind it.
   *
   * `AVG` over an empty set is SQL NULL, and the whole point of the distinction
   * is that "no wrap-up has concluded yet" and "wrap-ups take no time" are
   * different facts. `num()` would flatten both to a plausible `0` — a tile
   * reading `AHT 0s` on a campaign that has not connected anyone.
   */
  const avg = (key: string): number | null => {
    const raw = row[key];
    return raw === undefined || raw === null ? null : Number(raw);
  };

  const answered24h = num('answered_24h');
  const abandoned24h = num('abandoned_24h');
  const humanConnects = num('human_connects');
  const machineConnects = num('machine_connects');
  const unclassifiedConnects = num('unclassified_connects');
  const attemptsTotal = num('attempts_total');
  const attemptsSuccess = num('attempts_success');
  /**
   * The conversion rate's denominator: every BRIDGED attempt.
   *
   * Summed from the three connect buckets rather than read as a fourth
   * `COUNT(*) … WHERE bridged_at IS NOT NULL`. The three are disjoint and
   * exhaustive over bridged attempts by construction (`code <> voicemail AND
   * code <> no_disposition` / `code = voicemail` / `code IS NULL OR code =
   * no_disposition`), so this IS that count — and deriving it makes the payload
   * internally consistent by arithmetic instead of by two subqueries agreeing.
   * Same reasoning as `agents_by_state`, which is tallied from the roster rather
   * than read as its own `GROUP BY`: a second observation of the same rows can
   * only ever introduce a window in which they disagree.
   *
   * It is deliberately NOT `attempts_total`. A dial that rang out had no
   * conversation to convert, so counting it against the script would turn the
   * conversion rate into a measure of list quality.
   */
  const attemptsBridged = humanConnects + machineConnects + unclassifiedConnects;

  const agents = await supervisorAgents(campaignId);

  return {
    contacts_total: num('contacts_total'),
    contacts_pending: num('contacts_pending'),
    contacts_in_flight: num('contacts_in_flight'),
    contacts_completed: num('contacts_completed'),
    contacts_suppressed: num('contacts_suppressed'),
    contacts_exhausted: num('contacts_exhausted'),
    retries_pending: num('retries_pending'),
    attempts_live: num('attempts_live'),
    attempts_total: attemptsTotal,
    attempts_connected: num('attempts_connected'),
    // ALWAYS emitted, even though the contract types it optional: omitting it
    // would make "absent" ambiguous with "zero redials" — and
    // `campaign-stats-contract.test.ts`
    // asserts the produced key set against the field roster, so a conditional
    // spread here would red that suite rather than shipping quietly.
    attempts_retried: num('attempts_retried'),
    agents_live: num('agents_live'),
    abandoned_24h: abandoned24h,
    answered_24h: answered24h,
    // `null`, never `0`, when nothing has been answered — the single definition,
    // imported. "No calls answered yet" and "no calls abandoned" are different
    // facts, and rendering the first as a reassuring 0.0% is how a guardrail gets
    // trusted before it has measured anything.
    abandonment_rate_24h_pct: abandonmentRatePct({ answered: answered24h, abandoned: abandoned24h }),

    // ── The supervisor dashboard ──────────────────────────────────────────
    agents,
    // Tallied from the roster rather than read as its own `GROUP BY`, so the
    // breakdown and the floor beside it are the same observation of the same
    // rows — the two have identical predicates, and a second statement could
    // only ever introduce a window in which they disagree. Seeded with all six
    // states because a missing key is indistinguishable from zero to a consumer,
    // and the console renders all six.
    agents_by_state: agents.reduce<AgencyAgentsByState>((acc, agent) => {
      // Guarded rather than blind. The state CHECK and the union agree
      // today; if a seventh state is ever added to one and not the other, an
      // invented key here is one the console's exhaustive switch cannot render,
      // and the six it does promise would all still be present — so nothing
      // would look wrong. Dropping the unknown loses a count; inventing a key
      // loses the contract.
      // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a state
      // literally named `constructor` or `toString` would pass the guard and
      // then do `Object.prototype.toString + 1` → a NaN own-property on the
      // payload. Unreachable through the state CHECK, but the guard did
      // not do what its comment claimed.
      if (Object.hasOwn(acc, agent.state)) acc[agent.state] += 1;
      return acc;
    }, zeroAgentsByState()),

    human_connects: humanConnects,
    machine_connects: machineConnects,
    unclassified_connects: unclassifiedConnects,
    machine_connects_available: row['machine_connects_available'] === 'true',
    connect_rate_pct: ratePct(humanConnects, attemptsTotal),
    attempts_success: attemptsSuccess,
    // `null`, never `0`, when nothing has bridged — the same imported helper
    // `abandonment_rate_24h_pct` uses, and the same distinction: "nothing has
    // converted yet" and "nothing has been dispositioned yet" are different
    // facts, and rendering the second as 0.0% is how a metric gets trusted
    // before it has measured anything.
    success_rate_pct: ratePct(attemptsSuccess, attemptsBridged),
    aht_seconds: avg('aht_seconds'),
    aht_seconds_including_machine: avg('aht_seconds_including_machine'),
    avg_wrapup_seconds: avg('avg_wrapup_seconds'),
    // The CAMPAIGN's ceiling, not the constant.
    // Serving the constant here while the guardrail fired on the column would
    // draw the dashboard's threshold in a different place from the line that
    // actually pauses the campaign — the exact drift
    // `DEFAULT_ABANDONMENT_CEILING_PCT`'s own doc comment warns about. The
    // fallback covers only a campaign row that vanished between the two reads.
    abandonment_ceiling_pct: row['abandonment_ceiling_pct'] === undefined
      || row['abandonment_ceiling_pct'] === null
      ? DEFAULT_ABANDONMENT_CEILING_PCT
      : Number(row['abandonment_ceiling_pct']),
  };
}

/**
 * The floor, one row per LIVE agent session on this campaign.
 *
 * Unsorted on purpose: the console orders by RISK — longest in `wrapup`, longest
 * on a break, idle longest — and those rules change with the UI, so a server-side
 * `ORDER BY` would be a second opinion the console has to undo.
 *
 * `state_since` is served as the raw instant rather than a computed duration for
 * the same reason: a tile ticks live, so a server-rendered "8m 41s" is wrong the
 * moment it arrives.
 */
async function supervisorAgents(campaignId: string): Promise<AgencySupervisorAgentRow[]> {
  const { rows } = await getPool().query<{
    session_id: string;
    agent_user_id: string;
    state: AgencyAgentLiveState;
    state_since: Date | string;
    break_reason: string | null;
    calls_handled: string;
  }>(
    // `calls_handled` counts by `reserved_agent_id`, which is a SESSION id,
    // so this is the attempts handled in THIS session — what
    // the floor shows, and what makes an agent who rejoined after a shift start
    // from zero rather than inheriting the morning's count.
    //
    // A LEFT JOIN so an agent who has handled nothing is still on the floor:
    // an inner join would silently hide exactly the agent a supervisor is
    // looking for.
    `SELECT s.id AS session_id,
              s.agent_user_id,
              s.state,
              s.state_since,
              -- Only while they are actually on a break. The column keeps the last
              -- reason after they return, and a stale "Lunch" beside an available
              -- agent reads as a live fact.
              CASE WHEN s.state = 'break' THEN s.break_reason END AS break_reason,
              COUNT(a.id)::text AS calls_handled
         FROM agency_agent_sessions s
         LEFT JOIN agency_call_attempts a
                ON a.reserved_agent_id = s.id
               AND a.bridged_at IS NOT NULL
        WHERE s.campaign_id = $1
          AND s.left_at IS NULL
        GROUP BY s.id, s.agent_user_id, s.state, s.state_since, s.break_reason`,
    [campaignId],
  );

  return rows.map((r) => ({
    // Already in the `GROUP BY`; it was one projection short of the wire, and the
    // omission would have surfaced as an unwireable button in the console rather than
    // as anything failing here.
    session_id: r.session_id,
    agent_user_id: r.agent_user_id,
    state: r.state,
    state_since: isoOrEpoch(r.state_since),
    break_reason: r.break_reason ?? null,
    calls_handled: Number(r.calls_handled ?? 0),
  }));
}

/**
 * ── THE CAMPAIGN'S TREND LINE ─────────────────────────────────────────────
 *
 * `GET /api/v1/agency-campaigns/:id/stats/series`. One row per calendar bucket
 * over `[from, to)`, cut in the campaign's own timezone, **gap-free**.
 *
 * Returns `null` for a campaign that is not in scope — which the route has
 * already checked, so in practice it means the campaign was deleted between
 * `requireOwned` and this statement. The route answers 404 either way.
 *
 * ── ONE STATEMENT, and the reason is the echoed `timezone` ─────────────────
 *
 * The spine, the aggregate and the resolved zone are all in this statement, not
 * three. `groupedStats` needs a `REPEATABLE READ` transaction to keep its
 * `resolved_timezone` honest precisely because it reads the zone in a SECOND
 * statement: on the pool, two connections are two READ COMMITTED snapshots, and
 * a `default_timezone` UPDATE committing between them makes the response report
 * a zone the buckets were never cut in. Folding everything into one statement
 * removes the failure rather than fencing it — there is no second snapshot to
 * disagree with — and it needs no client, no transaction and no isolation level.
 *
 * ── The zone is RESOLVED, and echoing the raw column would BE the bug ──────
 *
 * `AGENCY_RESOLVED_ZONE_SQL` through `AGENCY_RESOLVED_ZONE_JOIN_SQL`, the same
 * two constants every other zoned agency read carries. `default_timezone` is
 * `VARCHAR(64)` with no constraint and comes from customer-facing config, so
 * `AT TIME ZONE 'Asia/Kolkata_typo'` would raise `22023 invalid_parameter_value`
 * — which nothing maps to a status. The LATERAL join turns that into a UTC
 * fallback, and the consequence is that the STORED value and the zone the
 * buckets were actually cut in differ exactly when the stored value is garbage.
 * So `SELECT c.default_timezone` here would hand the console a broken zone name
 * to print over columns that are in fact UTC, on precisely the campaign whose
 * zone is broken. Same rule, same reason, as `resolvedCampaignZone`.
 *
 * This read is scoped to ONE campaign, so there is no per-row zone derivation
 * and none of the "a day is not 24 hours when an agent works two zones" cost the
 * agent record accepts: one campaign, one zone, every bucket contiguous.
 *
 * ── THE ZERO-FILL IS THE POINT, and it lives in SQL ────────────────────────
 *
 * `spine` is `generate_series` over the window, and `agg` is LEFT JOINed onto
 * it. A weekend therefore arrives as `attempts: 0`, never as an absent key.
 *
 * This is the one place this read deliberately DIFFERS from the per-agent
 * record, whose `buckets[]` carries only labels that had something in them (a
 * `Map` keyed on whatever the GROUP BY returned). That read is a person's own
 * record, where a missing day is usually a day they did not work. This is a
 * campaign's trend line, where a missing day is a data point: fed a gappy
 * series, a chart either draws a straight line through the hole — inventing
 * dials that did not happen — or shifts every later point one column left. "We
 * dialled nobody" and "that day was not in the response" are different facts
 * and only the first can be drawn.
 *
 * In SQL rather than filled in TypeScript because the spine has to be generated
 * in the CAMPAIGN's zone to know which labels exist: a DST day is 23 or 25 hours
 * long, and walking the range with a 24-hour step in JS would skip or duplicate
 * a label twice a year. `generate_series` over bare local timestamps steps
 * calendar units, which is the arithmetic that gets that right.
 *
 * ── The upper bound: `to - 1 microsecond` ──────────────────────────────────
 *
 * The window is half-open, so the last bucket is the one containing the greatest
 * instant STRICTLY BEFORE `to`. Generating up to `date_trunc(unit, to)` would
 * emit one bucket too many whenever `to` lands exactly on a boundary — which is
 * the ordinary case, since a console asks for whole days — and that extra bucket
 * is always all-zeros, i.e. it would render as a day the campaign did nothing on
 * a chart whose axis had not reached it. A microsecond is Postgres's own
 * timestamp resolution, so `to - interval '1 microsecond'` is exactly the
 * greatest representable instant inside the window; it is not an epsilon fudge.
 *
 * ── Both labels come from `bucketStartSql` — the SAME expression ───────────
 *
 * The spine's label and the aggregate's label are produced by one helper, which
 * is what makes the LEFT JOIN's `=` a total match rather than a coincidence of
 * two `to_char` spellings. `generate_series` yields a BARE local timestamp, so
 * the spine converts it back through `AT TIME ZONE` before handing it to
 * `bucketStartSql` (which truncates in a zone) — exactly the round-trip
 * `occupancyBuckets` performs on its own series, for exactly this reason. The
 * round trip is label-stable across DST: a nonexistent or ambiguous local
 * midnight resolves to an instant inside the same calendar day, so it truncates
 * back to the same label.
 *
 * ── The counters are `AGENCY_ATTEMPT_METRICS_SQL`, unmodified ──────────────
 *
 * The same frozen string the per-agent record, the roster and the grouped read
 * select — so a supervisor comparing a campaign's series against an agent's
 * buckets is comparing the same definition of a connect, a success, a talk
 * second and a measured wrap-up second. It also settles what these buckets sum
 * to on `AgencyCampaignStats`, which is worth being exact about because two of
 * the pairings are NOT the obvious ones:
 *
 *   * `attempts` sums to `attempts_total` RESTRICTED to attempts with a
 *     `dialed_at` in the window. `attempts_total` is a bare `COUNT(*)` with no
 *     date filter, so it also counts rows that were created and never placed;
 *     those are in no bucket, deliberately — a dial that never happened is not a
 *     dial.
 *   * `connected` sums to `human_connects + machine_connects +
 *     unclassified_connects` — every BRIDGED attempt — and **not** to
 *     `attempts_connected`, which is `outcome = 'connected'`, a classification
 *     that can be absent, late, or say connected about a call no agent ever
 *     heard. `bridged_at IS NOT NULL` is the gate every flow metric on that
 *     payload uses, and it is the one this shares.
 *   * `successes` sums to `attempts_success`: the same `successDispositionSql`
 *     predicate behind the same `bridged_at` gate.
 *   * `talk_seconds`/`wrapup_seconds` are SUMS and have no lifetime counterpart
 *     to equal — `aht_seconds` and `avg_wrapup_seconds` are averages over
 *     narrower predicates (`state = 'ended'`, voicemail excluded from the first).
 *     Documented rather than reconciled: they answer a different question.
 *
 * Bucketed on `dialed_at` and nothing else, the same choice and the same reasons
 * as `attemptBuckets` and `hourlyBuckets`: `created_at` precedes the dial by a
 * dispatch hop (so it can bucket an attempt into a day nothing was dialled in)
 * and `ended_at` pushes a call straddling midnight into the later day while
 * leaving a live one in no day at all.
 *
 * ── The scope is a predicate on the CAMPAIGN row, in both halves ───────────
 *
 * `c.tenant_id`/`c.account_id` in `camp` AND in `agg`. Redundant, because the
 * route ran `requireOwned` first and `agg` filters on the same campaign id — and
 * kept, because it is the WHERE clause that separates two accounts' campaign
 * data, and a caller reaching this method without the route's check (a future
 * route, a test) must not get an answer for someone else's campaign.
 */
export async function campaignStatsSeries(
  scope: { tenantId: string; accountId: string },
  campaignId: string,
  p: CampaignSeriesParams,
): Promise<AgencyCampaignStatsSeries | null> {
  const zone = AGENCY_RESOLVED_ZONE_SQL;
  // Bound in the SAME ORDER as `attemptBuckets`/`occupancyBuckets`: the subject
  // selector first, then `from`, `to`, tenant, account. Those statements say the
  // same thing about themselves, and for the same reason -- these are ~5 nearly
  // identical parameter lists and a future editor will diff or copy between
  // them, so binding one value at a different position is a trap that survives
  // review and shows up as a window nobody asked for.
  const values: unknown[] = [campaignId, p.from, p.to, scope.tenantId, scope.accountId];

  const { rows } = await getPool().query<{
    bucket_start: string; timezone: string;
    attempts: string; connected: string; successes: string;
    talk_seconds: string; wrapup_seconds: string;
  }>(
    `WITH camp AS (
         -- At most one row: the primary key, plus the scope predicate. The zone is
         -- resolved here and carried down, so the label expression, the spine and
         -- the echoed field are all the same value from the same snapshot.
         SELECT ${zone} AS zone
           FROM agency_campaigns c
           ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
          WHERE c.id = $1::uuid
            AND c.tenant_id = $4
            AND c.account_id = $5
       ), spine AS (
         -- THE CALENDAR, independent of whether anything was dialled on it.
         --
         -- generate_series over BARE local timestamps: date_trunc(unit, ts AT TIME
         -- ZONE tz) drops the zone, and adding interval '1 day' to a bare
         -- timestamp is exactly +24h of wall clock with no DST arithmetic, so the
         -- boundaries stay at 00:00 local through a transition. Stepping in real
         -- instants instead would drift by an hour twice a year and eventually
         -- relabel a bucket.
         --
         -- The upper bound is to minus one microsecond -- Postgres's own
         -- timestamp resolution -- because the window is half-open: generating up
         -- to date_trunc(unit, to) emits an extra all-zero bucket every time to
         -- lands on a boundary, which is the ordinary case.
         --
         -- The subtraction is PARENTHESISED, and that is not style: AT TIME ZONE
         -- binds tighter than -, so an unbracketed expression parses as
         -- $3 - (interval AT TIME ZONE zone) -- applying a zone to an interval,
         -- which is an error rather than a wrong answer, but only at run time.
         --
         -- The label round-trips the bare series value back through AT TIME ZONE
         -- so it can go through bucketStartSql, the SAME expression the aggregate
         -- labels with -- which is what makes the LEFT JOIN's = a total match
         -- rather than a coincidence of two to_char spellings. It reads as a
         -- double conversion because it is one: bare -> instant -> bare, a no-op
         -- by construction, and it is exactly what occupancyBuckets does to its
         -- own generate_series for the same reason.
         SELECT ${bucketStartSql(p.bucket, '(gs AT TIME ZONE camp.zone)', 'camp.zone')} AS bucket_start,
                camp.zone
           FROM camp,
                generate_series(
                  ${bucketTruncSql(p.bucket, '$2::timestamptz', 'camp.zone')},
                  ${bucketTruncSql(p.bucket, "($3::timestamptz - interval '1 microsecond')", 'camp.zone')},
                  interval '1 ${p.bucket}') gs
       ), agg AS (
         SELECT ${bucketStartSql(p.bucket, 'a.dialed_at', zone)} AS bucket_start,
              ${AGENCY_ATTEMPT_METRICS_SQL}
           FROM agency_call_attempts a
           JOIN agency_campaigns c ON c.id = a.campaign_id
           ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
          WHERE a.campaign_id = $1::uuid
            AND c.tenant_id = $4
            AND c.account_id = $5
            AND a.dialed_at IS NOT NULL
            AND a.dialed_at >= $2
            AND a.dialed_at < $3
          GROUP BY 1
       )
       SELECT sp.bucket_start,
              sp.zone AS timezone,
              -- COALESCE on the TEXT, because AGENCY_ATTEMPT_METRICS_SQL casts
              -- every column ::text (pg returns int8/numeric as strings anyway and
              -- the cast makes the ::text -> Number() hop explicit at both ends).
              -- A '0' here is a real zero and the mapper's Number() turns it into
              -- one; the alternative -- mapping a SQL NULL in TypeScript -- would
              -- put the zero-fill in two places, and the SQL half would still be
              -- needed for the labels.
              COALESCE(g.attempts, '0')       AS attempts,
              COALESCE(g.connected, '0')      AS connected,
              COALESCE(g.successes, '0')      AS successes,
              COALESCE(g.talk_seconds, '0')   AS talk_seconds,
              COALESCE(g.wrapup_seconds, '0') AS wrapup_seconds
         FROM spine sp
         LEFT JOIN agg g ON g.bucket_start = sp.bucket_start
        ORDER BY sp.bucket_start`,
    values,
  );

  // No spine rows means `camp` matched nothing -- the campaign is not in this
  // account, or was deleted since the route's ownership check. It CANNOT mean an
  // empty window: `parseCampaignSeriesQuery` refuses `from >= to`, so every
  // accepted window generates at least one bucket. Returning an empty `buckets`
  // array here would report "this campaign dialled nobody" about a campaign that
  // does not exist.
  const zoneEchoed = rows[0]?.timezone;
  if (zoneEchoed === undefined) return null;

  const buckets: AgencyCampaignStatsBucket[] = rows.map((r) => ({
    bucket_start: r.bucket_start,
    ...readAttemptMetrics(r),
  }));

  return {
    campaign_id: campaignId,
    bucket: p.bucket,
    timezone: zoneEchoed,
    buckets,
  };
}

/**
 * The SQL half of the supervisor dashboard's health strip.
 *
 * Separate from {@link stats} on purpose. `stats()` is the numbers a supervisor
 * reads; this is the evidence behind a *diagnosis*, it is only consulted when the
 * strip is being rendered, and keeping it out of `stats()` means the dashboard's
 * one statement does not grow four more scans for a feature the caller may not want.
 *
 * **Pending contacts are grouped BY TIMEZONE rather than evaluated per row.**
 * Calling-hours is a TypeScript rule (`callingWindowState`), and re-expressing it
 * in SQL would be a second definition of a compliance rule — the exact mistake
 * `ABANDONED_ATTEMPT_PREDICATE_SQL` exists to prevent. Grouping is exact and
 * cheap: a roster has a handful of distinct timezones however many contacts it
 * has, so the caller evaluates the real rule a few times instead of a million.
 */
export async function campaignHealthInputs(campaignId: string): Promise<{
  pendingByTimezone: Array<{ timezone: string | null; count: number }>;
  nextRetryAt: Date | null;
  lastDialAt: Date | null;
  recent: { attempts: number; failed: number };
  onBreakByReason: Record<string, number>;
}> {
  const pool = getPool();
  const [pending, dial, recent, breaks] = await Promise.all([
    // **Every pending contact, NOT only the ones due right now** — and this is
    // the whole correctness of the calling-hours diagnosis.
    //
    // The pre-dial gate DEFERS an out-of-hours contact by writing its next
    // window-open instant to `next_attempt_at` (`unclaim(contact.id,
    // gate.deferUntil)`). So a `next_attempt_at <= now()` filter here measured
    // exactly the contacts the gate had not got to yet: after one pacing pass the
    // due set is empty, the count falls to zero and the strip goes silent — the
    // overnight "0 in flight and no reason given" case it exists to explain.
    //
    // It also has to match `contacts_pending`'s population, because the assembler
    // compares the two ("is EVERYTHING waiting shut out?"). `contacts_pending` is
    // a bare `state = 'pending'` count, so a due-only numerator against it meant
    // one scheduled retry anywhere on the roster suppressed the diagnosis, before
    // deferral even entered into it. Both counts are now the same set.
    //
    // Grouping stays the point: the calling-hours rule itself is evaluated in
    // TypeScript, once per distinct timezone, never restated in SQL.
    //
    // The next scheduled retry rides the SAME scan as a per-zone
    // `MIN(...) FILTER`, folded to the overall minimum below: both read the
    // campaign's pending contacts, and the minimum of the per-group minima is the
    // minimum over the union.
    pool.query<{ timezone: string | null; n: string; next_attempt_at: Date | null }>(
      `SELECT timezone,
                COUNT(*)::text AS n,
                MIN(next_attempt_at) FILTER (WHERE next_attempt_at > now()) AS next_attempt_at
           FROM agency_contacts
          WHERE campaign_id = $1 AND state = 'pending'
          GROUP BY timezone`,
      [campaignId],
    ),
    pool.query<{ dialed_at: Date | null }>(
      `SELECT MAX(dialed_at) AS dialed_at FROM agency_call_attempts WHERE campaign_id = $1`,
      [campaignId],
    ),
    // Only `failed` counts as a failure. `no_answer` and `busy` are ORDINARY
    // outcomes on a cold list — counting them would put "38% of dials failed —
    // possible carrier problem" on every healthy campaign, and a strip that
    // cries wolf on its lowest-priority diagnosis is one supervisors learn to
    // ignore. `invalid` is a data-quality fact about the roster, not the
    // carrier, and `orphaned`/`agent_disconnected` are our own faults, which
    // deserve their own diagnosis rather than being laundered as a carrier hint.
    pool.query<{ attempts: string; failed: string }>(
      `SELECT COUNT(*)::text AS attempts,
                COUNT(*) FILTER (WHERE outcome = 'failed')::text AS failed
           FROM agency_call_attempts
          WHERE campaign_id = $1
            AND dialed_at > now() - ($2 || ' minutes')::interval`,
      [campaignId, RECENT_FAILURE_WINDOW_MINUTES],
    ),
    pool.query<{ break_reason: string | null; n: string }>(
      `SELECT break_reason, COUNT(*)::text AS n FROM agency_agent_sessions
          WHERE campaign_id = $1 AND left_at IS NULL AND state = 'break'
          GROUP BY break_reason`,
      [campaignId],
    ),
  ]);

  const onBreakByReason: Record<string, number> = {};
  for (const r of breaks.rows) onBreakByReason[r.break_reason ?? 'unspecified'] = Number(r.n);

  let nextRetryAt: Date | null = null;
  for (const r of pending.rows) {
    if (r.next_attempt_at && (!nextRetryAt || r.next_attempt_at < nextRetryAt)) nextRetryAt = r.next_attempt_at;
  }

  return {
    pendingByTimezone: pending.rows.map((r) => ({ timezone: r.timezone, count: Number(r.n) })),
    nextRetryAt,
    lastDialAt: dial.rows[0]?.dialed_at ?? null,
    recent: {
      attempts: Number(recent.rows[0]?.attempts ?? 0),
      failed: Number(recent.rows[0]?.failed ?? 0),
    },
    onBreakByReason,
  };
}
