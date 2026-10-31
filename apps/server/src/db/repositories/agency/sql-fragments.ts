/**
 * The agency repository's shared SQL fragments: every spelling more than one
 * repository file must emit byte-identically (the phone-digits prefilter, the
 * resolved campaign zone, the occupancy intervals, the five attempt metrics, the
 * campaign INSERT column list). A leaf: it imports nothing from this folder.
 */
// What counts as a conversion, as SQL. A leaf module for the same reason
// `ABANDONED_ATTEMPT_PREDICATE_SQL` is one: the campaign roll-up and the agent
// record must count the SAME thing, and two spellings of a JSONB predicate is how
// two screens come to disagree about how many sales there were.
import { successDispositionSql } from '@magick-agency/domain/success-disposition';

/**
 * "This roster row's number, digits only" — the PREFILTER for
 * {@link AgencyContactRepository.suppressByPhone}, and nothing more.
 *
 * ⚠️ It is **not** a normalizer and must never be used as one. Every string
 * `normalizeE164` accepts is made of digits plus characters this drops, so a row
 * that normalizes to a given number always survives this filter — the converse
 * does not hold (`1a4155550100` passes here and is `null` there), which is why the
 * exact decision stays in TypeScript. Being deliberately looser is what makes it
 * safe: a prefilter that could reject a real match would be a fail-open.
 *
 * A literal fragment with no interpolated input, and it must stay byte-identical
 * to the expression indexed by `idx_agency_contacts_campaign_phone_digits`
 * — Postgres matches expression indexes structurally, so a stray
 * space or a `'[^\d]'` spelling costs the index and turns an agent's button press
 * into a scan of every contact in the campaign, silently.
 */
export const CONTACT_PHONE_DIGITS_SQL = "regexp_replace(phone_e164, '[^0-9]', '', 'g')";

/**
 * The wrap-up resolutions that are evidence of how long wrap-up TAKES.
 *
 * `disposition_submitted` (the agent finished and said so), `auto_return` (the
 * agent used the whole window — the one that says the allotment is too short) and
 * `agent_returned` (the agent finished early and went available without a
 * disposition, the fastest wrap-ups there are). `forced`, `agent_left` and
 * `campaign_stopped` are excluded: each measures a supervisor's patience, an
 * agent vanishing or a campaign ending, and all three move the average toward
 * "shorten the allotment" — the opposite of what those events mean.
 */
export const WRAPUP_MEASURED_RESOLUTIONS_SQL =
  "wrapup_resolution IN ('disposition_submitted','auto_return','agent_returned')";

/**
 * The RESOLVED campaign timezone, spelled once for the three statements that cut
 * something in it.
 *
 * Never `c.default_timezone` raw. That column is `VARCHAR(64)` with no constraint,
 * populated from customer-facing config, so it can hold anything — and
 * `some_ts AT TIME ZONE 'Mars/Olympus'` raises `22023 invalid_parameter_value`,
 * which nothing maps to a status. One campaign with a typo would therefore take out
 * every OTHER campaign's numbers in the same statement. The
 * {@link AGENCY_RESOLVED_ZONE_JOIN_SQL} that every caller carries turns that into a
 * per-row fallback: a zone Postgres will not resolve yields NULL, and this COALESCE
 * buckets those rows in UTC.
 *
 * `pg_timezone_names` carries zone NAMES, not the abbreviations in
 * `pg_timezone_abbrevs`, so a bare `IST` falls back to UTC — deliberately as strict
 * as `calling-hours.ts`'s `isUsableTimezone`, which refuses the same input.
 *
 * Shared rather than re-spelled at each site for the same reason
 * {@link AGENCY_ATTEMPT_METRICS_SQL} is: the per-agent record's buckets, its
 * occupancy intervals and the grouped read's time dimensions must fall on the SAME
 * boundaries, and three copies of one fallback is how one of them comes to bucket
 * an unresolvable zone somewhere else.
 */
export const AGENCY_RESOLVED_ZONE_SQL = "COALESCE(z.name, 'UTC')";

/**
 * The join that RESOLVES that zone, in one spelling for the three statements that
 * carry it — and it is a LATERAL with `LIMIT 1` rather than a plain equi-join.
 *
 * ── Why LATERAL, when a plain LEFT JOIN read more simply ────────────────────
 *
 * The three call sites put this join inside an AGGREGATE's FROM clause, so its
 * cardinality is not a presentation detail: if `lower(z.name) = lower(...)` ever
 * matched TWO rows of `pg_timezone_names` for one campaign, that campaign's
 * attempts would be duplicated and every counter selected beside it —
 * {@link AGENCY_ATTEMPT_METRICS_SQL}'s five, and the roster's `campaigns` — would
 * double. Nothing in `pg_timezone_names` declares `lower(name)` unique; it is a
 * view over tzdata, whose contents change with the platform's zone files, so the
 * property is an assumption about data we do not own rather than a constraint we
 * enforce. No case-colliding pair is known in shipped tzdata and no failure could
 * be constructed — but `rosterAttemptTotals` has a byte-identical FROM and WHERE
 * clause EXCEPT this join, and the whole reason the metric expressions are shared
 * is that a supervisor subtracting the roster from the grouped read must get zero.
 * That property should not rest on an unasserted uniqueness claim.
 *
 * `LEFT JOIN LATERAL (… LIMIT 1) z ON true` removes the assumption outright: at
 * most one row, by construction, whatever tzdata holds. It preserves both
 * properties the plain join was carrying — a zone Postgres cannot resolve still
 * yields NULL for {@link AGENCY_RESOLVED_ZONE_SQL} to COALESCE to UTC, so one
 * campaign's typo still cannot raise `22023` and take out every other campaign's
 * numbers in the same statement.
 *
 * ⚠️ Which row `LIMIT 1` keeps is unordered, and that is deliberate rather than
 * overlooked: the only way two rows can match is a pair of names differing in case
 * alone, which are the same zone, so either row resolves to the same offsets. An
 * `ORDER BY` would be picking between two spellings of one answer.
 *
 * ✅ **EXECUTED.** No longer a claim about text: this join runs against Postgres 16
 * in `agent-stats-timezone-buckets.test.ts` (per-campaign bucketing, DST days, and
 * the unresolvable-zone fallback) and in `agent-grouped-read.test.ts` (the grouped
 * read's time dimensions, and `resolved_timezone` reading the join back out). The
 * uniqueness assumption the lateral removes was also checked directly —
 * `SELECT lower(name), count(*) FROM pg_timezone_names GROUP BY 1 HAVING count(*) > 1`
 * returns no rows on this platform's tzdata — which is evidence that no collision
 * exists today, not that none can, so the lateral stays.
 */
export const AGENCY_RESOLVED_ZONE_JOIN_SQL =
  'LEFT JOIN LATERAL (SELECT z.name FROM pg_timezone_names z'
  + ' WHERE lower(z.name) = lower(c.default_timezone) LIMIT 1) z ON true';

/**
 * ── THE OCCUPANCY INTERVALS, IN ONE SPELLING ────────────────────────────────
 *
 * The `sess` / `in_window` / `carried` / `events` / `intervals` CTEs both occupancy
 * reads open with: `occupancyBuckets` (one agent, bucketed in the campaign's zone)
 * and `rosterOccupancyTotals` (a known set of agents, no buckets). The two must
 * agree — the roster's `shift_seconds` and the per-agent record's buckets are one
 * measurement asked at two altitudes, and a supervisor comparing them is entitled
 * to one answer — so the clips, the tiebreaks and the carried-in bound are written
 * ONCE, here. `occupancy-ctes.test.ts` asserts the two variants differ only in the
 * places listed in {@link OCCUPANCY_VARIANTS}.
 *
 * Both bind the same five values at the same positions: `$1` the agent selector,
 * `$2`/`$3` the window, `$4`/`$5` tenant and account. A swapped from/to would
 * survive review because `WHERE i.ended > i.started` absorbs an inverted window as
 * an empty result rather than as an error. `campaignFilter` is the optional
 * `AND s.campaign_id = $n::uuid` line, appended to `sess`.
 *
 * Callers append their own outer SELECT over `intervals i` (columns `state`,
 * `started`, `ended`, plus the variant's key).
 */
const OCCUPANCY_VARIANTS = {
  // The per-agent record: one agent, and the campaign's resolved zone carried down
  // to the buckets.
  agent: {
    agentMatch: '= $1',
    intervalKey: 'sess.zone',
    sess: `         -- The agent's sessions that OVERLAP the window, never all of them. A
         -- session's life is [joined_at, left_at), the window is [$2, $3), and two
         -- half-open intervals overlap iff each starts before the other ends.
         --
         -- Unbounded, this CTE is what makes the whole read scale with the agent's
         -- TENURE rather than with the window: every closed session the agent has
         -- ever had still has a terminal event before $2, so carried hands each one
         -- a carried-in interval that, having no successor inside the window, runs
         -- the full width of it. Sixty past shifts become sixty full-window offline
         -- intervals -- about 42 days of "offline" inside a 24-hour bucket -- and a
         -- session abandoned in a non-offline state inflates shift_seconds by the
         -- same construction.
         --
         -- The campaign join is LEFT: a soft-phone session (kind softphone,
         -- campaign_id NULL, docs/softphone.md §2) is shift time on the soft_phone
         -- break, and the roster variant counts it, so an INNER join here made the
         -- two reads disagree for any agent who used the soft phone. With no campaign
         -- there is no zone to resolve: the lateral finds nothing and
         -- AGENCY_RESOLVED_ZONE_SQL buckets the session in UTC, the same fallback an
         -- unresolvable campaign zone gets. A campaign filter still drops it
         -- (s.campaign_id = $n is never true of NULL), as it does in the roster.
         SELECT s.id, s.left_at, s.joined_at, ${AGENCY_RESOLVED_ZONE_SQL} AS zone
           FROM agency_agent_sessions s
           LEFT JOIN agency_campaigns c ON c.id = s.campaign_id
           ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
          WHERE s.agent_user_id = $1
            AND s.tenant_id = $4
            AND s.account_id = $5
            AND s.joined_at < $3
            AND (s.left_at IS NULL OR s.left_at > $2)\${campaignFilter}
`,
  },
  // The roster: a known SET of agents, and no zone (a duration is
  // zone-independent, and nothing here buckets).
  roster: {
    agentMatch: '= ANY($1::uuid[])',
    intervalKey: 'sess.agent_user_id',
    sess: `         -- The sessions that OVERLAP the window, never all of them. A session's
         -- life is [joined_at, left_at), the window is [$2, $3), and two half-open
         -- intervals overlap iff each starts before the other ends.
         --
         -- Unbounded, this CTE is what would make the read scale with TENURE
         -- rather than with the window: every closed session still has a terminal
         -- event before $2, so carried hands each one an interval that, having no
         -- successor inside the window, runs the window's full width. Sixty past
         -- shifts become sixty full-window offline intervals per agent.
         SELECT s.id, s.agent_user_id, s.left_at, s.joined_at
           FROM agency_agent_sessions s
          WHERE s.tenant_id = $4
            AND s.account_id = $5
            AND s.agent_user_id = ANY($1::uuid[])
            AND s.joined_at < $3
            AND (s.left_at IS NULL OR s.left_at > $2)\${campaignFilter}
`,
  },
} as const;

type OccupancyVariant = keyof typeof OCCUPANCY_VARIANTS;

/** The shared occupancy CTEs for `variant`; see {@link OCCUPANCY_VARIANTS}. */
export function occupancyIntervalsCtes(variant: OccupancyVariant, campaignFilter: string): string {
  const v = OCCUPANCY_VARIANTS[variant];
  return `WITH sess AS (
${v.sess.replace('${campaignFilter}', campaignFilter)}       ), in_window AS (
         -- The predicate on e.agent_user_id is the denormalised copy the event
         -- log carries, and it is what makes idx_agency_session_events_agent
         -- (agent_user_id, at) usable: without it the planner has no predicate on
         -- the index's leading column, so the range on at cannot be driven from it,
         -- and session_id is indexed by nothing at all. The join to sess stays --
         -- it applies the tenant/account scope and the optional campaign narrowing.
         -- e.id rides along for the lead() tiebreak in intervals, for the same
         -- reason carried's ORDER BY carries it: at alone is not unique.
         SELECT e.session_id, e.to_state, e.at, e.id
           FROM agency_agent_session_events e
           JOIN sess ON sess.id = e.session_id
          WHERE e.agent_user_id ${v.agentMatch}
            AND e.at >= $2 AND e.at < $3
       ), carried AS (
         -- e.id DESC breaks a tie on at. DISTINCT ON returns whichever row the
         -- executor reached first among rows equal on the ORDER BY, so two events
         -- on one session sharing a timestamp make the state carried into the
         -- window non-reproducible between two runs of the same query -- one run
         -- reports the agent went on break at 08:55, the next reports available.
         -- Ties are real in rows already in the table: before at was carried from
         -- the mutation, the batch INSERT took the column's DEFAULT now(), which
         -- is the transaction timestamp and therefore identical for every row of a
         -- markAllOffline sweep of the whole floor.
         SELECT DISTINCT ON (e.session_id) e.session_id, e.to_state, e.at, e.id
           FROM agency_agent_session_events e
           JOIN sess ON sess.id = e.session_id
          WHERE e.agent_user_id ${v.agentMatch}
            AND e.at < $2
            -- The lower bound is what stops this range scan reading the agent's
            -- whole tenure, and it is EXACT: a session's events never predate its
            -- joined_at. recordTransitions is the only writer of this table and
            -- stamps clock_timestamp() from the statement that moved the session,
            -- which (on a server clock that does not step backwards) reads no
            -- earlier than the INSERT that set joined_at (DEFAULT now(), never
            -- updated). So every row DISTINCT ON could pick for a
            -- session in sess is at or after the earliest joined_at in sess.
            -- agent-occupancy-carried-bound.test.ts carries a month-old state.
            AND e.at >= (SELECT MIN(joined_at) FROM sess)
          ORDER BY e.session_id, e.at DESC, e.id DESC
       ), events AS (
         SELECT * FROM in_window
         UNION ALL
         SELECT * FROM carried
       ), intervals AS (
         -- Three clips on the close, and the third is not decoration.
         --
         -- lead() gives the next event on the same SESSION; its absence means the
         -- newest event, i.e. the state the agent is in now, which has no end.
         -- now() closes that, $3 closes it again for a historical window -- and
         -- sess.left_at closes it for a session that ENDED. leave() sets left_at
         -- and writes the closing offline event in the same call, but that write is
         -- the best-effort one recordTransitions swallows with a warn: drop it and
         -- a session closed at 11:30 in state available credits every remaining
         -- second of the window to available, inflating shift_seconds and
         -- deflating the occupancy read that divides by it. left_at is the one
         -- clip whose source is the sessions table rather than the log, so it
         -- survives exactly the failure the other two cannot see.
         --
         -- LEAST already ignores NULLs, so the COALESCE is for the reader: a live
         -- session has no left_at and must not be clipped at all, and 'infinity'
         -- says that rather than leaving it to a function's null semantics.
         --
         -- ev.id breaks a tie on ev.at, the same tie carried breaks above and for
         -- the same reason -- markAllOffline's batch INSERT shares one transaction
         -- timestamp across the whole floor. Where two tied events are followed by
         -- a third, lead() without the tiebreak leaves it undefined WHICH of the
         -- tied states keeps the surviving interval, so two reads of one window can
         -- attribute the same seconds to different states. id is a random uuid, so
         -- the order it imposes on a tie is arbitrary -- but it is TOTAL and it is
         -- STABLE, which is the whole ask: tied events have no chronology to
         -- recover, and the failure being fixed is a number that moves between
         -- reads, not a number that is wrong.
         SELECT ${v.intervalKey},
                ev.to_state AS state,
                GREATEST(ev.at, $2::timestamptz) AS started,
                LEAST(
                  COALESCE(lead(ev.at) OVER (PARTITION BY ev.session_id ORDER BY ev.at, ev.id), now()),
                  $3::timestamptz,
                  -- The left_at clip applies to every state EXCEPT offline, and
                  -- that exception is the point of the clip rather than a
                  -- softening of it.
                  --
                  -- What the clip defends is shift_seconds, which foldOccupancy
                  -- sums over the NON-offline states only. A session closed in
                  -- 'available' -- because leave()'s closing write is the
                  -- best-effort one recordTransitions swallows with a warn --
                  -- would credit every remaining second of the window to
                  -- 'available' and inflate the shift. That failure is a failure
                  -- of a SHIFT state, by construction.
                  --
                  -- offline cannot commit it. It is excluded from the shift, so
                  -- extending it past left_at adds nothing to the denominator
                  -- occupancy divides by. And extending it is the DOCUMENTED
                  -- contract on this method: "a session that ended hours ago
                  -- cannot dilute occupancy merely by having its final offline
                  -- interval run to the end of the window" -- a sentence that is
                  -- only true of a read where that interval DOES run to the
                  -- window's end.
                  --
                  -- Clipping offline too made by_state.offline 0 for every
                  -- properly closed session, because leave() writes the offline
                  -- event AT left_at: the interval then starts and ends on one
                  -- instant. agent-occupancy-window.test.ts pins the 12:00 to
                  -- 24:00 tail and is what caught it. A unit test over a mocked
                  -- pool never could -- the bug was in what the SQL MEANS, not in
                  -- what it says.
                  CASE
                    WHEN ev.to_state = 'offline' THEN 'infinity'::timestamptz
                    ELSE COALESCE(sess.left_at, 'infinity'::timestamptz)
                  END
                ) AS ended
           FROM events ev
           JOIN sess ON sess.id = ev.session_id
       )
`;
}

/**
 * The FIVE metric expressions every agency attempts aggregate selects, in ONE
 * spelling.
 *
 * ── Why this is a frozen string and not a function taking aliases ────────────
 *
 * The property being protected is that a supervisor's roster line, an agent's own
 * scorecard and a grouped cell all report the SAME five numbers for the same
 * attempts — so a supervisor who subtracts one from the other gets zero. That
 * property is byte-equality of the emitted SQL, and a builder taking `attempt` /
 * `catalog` aliases could be called with different ones and emit two different
 * texts, i.e. it would hand back exactly the freedom this exists to remove. All
 * three call sites alias `agency_call_attempts` as `a` and `agency_campaigns` as
 * `c` — the joins are identical because the metrics are only defined over that
 * join — so there is nothing left to parameterise.
 *
 * Interpolated at column 14 in all three statements, which is why the
 * continuation lines carry their own indentation and the last line has no
 * trailing comma: a caller with further columns appends one.
 *
 * ── What each expression is, and the trap it avoids ─────────────────────────
 *
 * `attempts` / `connected` are plain counts; `successes` goes through
 * {@link successDispositionSql} so the campaign roll-up and every agent read
 * count the same conversion. The two durations are the ones with history, and both
 * comments below are load-bearing rather than decorative — see
 * the reaper.
 *
 * ⚠️ Every column is cast `::text`. That is not cosmetic: node-pg returns `bigint`
 * and `numeric` as strings anyway, and the cast makes the `::text` → `Number()`
 * hop explicit at both ends. A caller that wants to ORDER BY one of these has to
 * cast it back to `numeric` — text ordering would rank `'9'` above `'400'`.
 */
export const AGENCY_ATTEMPT_METRICS_SQL = `COUNT(*)::text AS attempts,
              COUNT(*) FILTER (WHERE a.bridged_at IS NOT NULL)::text AS connected,
              COUNT(*) FILTER (WHERE a.bridged_at IS NOT NULL
                AND ${successDispositionSql({ attempt: 'a', catalog: 'c.disposition_catalog' })})::text
                AS successes,
              -- The AGENT's leg: ended_at - bridged_at, never the persisted
              -- talk_seconds column (anchored on the carrier's answer, and nonzero
              -- even when no agent bridged -- an abandoned attempt settles carrying
              -- the apology clip's talk time). Orphans are excluded: the reaper
              -- stamps ended_at at SWEEP time, so one crashed conversation would
              -- contribute its whole time-until-sweep to whichever group it lands
              -- in -- an agent's day, their roster line, or a grouped cell.
              COALESCE(SUM(EXTRACT(EPOCH FROM (a.ended_at - a.bridged_at))) FILTER (
                WHERE a.bridged_at IS NOT NULL
                  AND a.ended_at IS NOT NULL
                  AND a.outcome IS DISTINCT FROM 'orphaned'), 0)::text AS talk_seconds,
              -- MEASURED wrap-up, never the wrapup_seconds allotment copied from
              -- the campaign at wrap-up entry (averaging that hands
              -- the operator their own setting back as if it were evidence), and
              -- only the three resolutions that are evidence of how long wrap-up
              -- takes.
              COALESCE(SUM(EXTRACT(EPOCH FROM (a.wrapup_ended_at - a.wrapup_started_at))) FILTER (
                WHERE a.wrapup_started_at IS NOT NULL
                  AND a.wrapup_ended_at IS NOT NULL
                  AND ${WRAPUP_MEASURED_RESOLUTIONS_SQL.replace('wrapup_resolution', 'a.wrapup_resolution')}), 0)::text
                AS wrapup_seconds`;

/** The five {@link AGENCY_ATTEMPT_METRICS_SQL} columns, as numbers. */
export interface AgencyAttemptMetrics {
  attempts: number; connected: number; successes: number;
  talk_seconds: number; wrapup_seconds: number;
}

/**
 * Read {@link AGENCY_ATTEMPT_METRICS_SQL}'s five `::text` columns off a row — the
 * other half of that frozen string, shared by every statement that selects it.
 */
export function readAttemptMetrics(row: {
  attempts: string; connected: string; successes: string; talk_seconds: string; wrapup_seconds: string;
}): AgencyAttemptMetrics {
  return {
    attempts: Number(row.attempts),
    connected: Number(row.connected),
    successes: Number(row.successes),
    talk_seconds: Number(row.talk_seconds),
    wrapup_seconds: Number(row.wrapup_seconds),
  };
}

/**
 * The twenty columns a campaign is created with, in the order `create()` and
 * `retryFromCampaign` bind `$1..$20`. A retry appends its five lineage columns
 * after them. One list, so a column added to the config is added to both writers or
 * to neither — an optional input field beside an explicit column list typechecks
 * and silently drops the value.
 */
export const CAMPAIGN_INSERT_COLUMNS_SQL = `tenant_id, account_id, name, caller_ids, telephony_provider,
          calling_window_start, calling_window_end, calling_days, default_timezone,
          wrapup_seconds, wrapup_auto_return, retry_policy, disposition_catalog,
          context_display, break_reasons, record_calls, analysis_profile_id, created_by,
          abandon_announcement_id, abandonment_ceiling_pct`;
