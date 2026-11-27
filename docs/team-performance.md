# Team performance

A tab of Reports where a supervisor sees how the whole team did over a period: on one campaign or
across every campaign of the account, as five tiles, the main outcome per working day, what
happened on the calls, and one row per agent with the ones worth a look marked. It reuses Compare
agents' definitions number for number (CP9): its read is Compare's sources for the whole cohort,
team-level, optionally across every campaign. Designed 2026-11-27; rulings TP1–TP20 below. Built
(§7): the contract, the flag `agency_team_performance_enabled` (off by default), the server's read
and its route, and the console tab. All campaigns over a whole month on a busy tenant reads at the
budget; Manas ruled on 2026-11-27 to keep the live read for now, with daily pre-processing as the
follow-up (§4 "Cost, measured", §7).

This file is the design and the build contract. Where it and another doc disagree about this page,
this file wins; where it reuses another area's read, that area's doc defines the number
(`compare-agents.md` for every figure, `insights.md` for the rollup and the call-back classes).

## 1. Rulings

TP1–TP20 are the design's of 2026-11-27. Those marked "default accepted" were open questions whose
proposed default Manas accepted the same day; the rest were the design's own recommendations, which
Manas ratified the same day, TP14's wording (the tiles are the rows' sums) included.

| ID | Ruling | Status |
|---|---|---|
| TP1 | **The page is `/agency/team-performance`, Reports' first tab.** Not `/agency/reports/team`: `reports/:runId` owns that space (the dedicated agent's twin path and Exports' sub-page would claim it). Tabs: Team performance, Analytics, Compare agents, Exports; Analytics stays ahead of Compare agents, so a supervisor with this flag off still lands on Analytics, not on Compare. A supervisor lands on Team performance (the section opens its first visible tab); a viewer or operator still lands on Analytics. No redirects: every existing URL keeps working. The Analytics tab keeps its name, and its By agent view stays as the per-person drill-down | Decided (default accepted, Manas, 2026-11-27; order amended at C, 2026-11-27, accepted by Manas) |
| TP2 | **One definition per number (CP9).** Every figure on the page is Compare agents' figure for the same agent, campaign and window, from the same statements (the roster's attempt and occupancy totals, the promise columns, the rollup codes, the call-back classes). The page adds sums, medians and the per-day series, never a new definition | Decided (ratified by Manas 2026-11-27) |
| TP3 | **Supervisors only** (`agency.supervise`, CP3). An agent never sees the team's figures here | Decided (ratified by Manas 2026-11-27) |
| TP4 | **Will pay follows CP2 exactly**: promises recorded on every call type, by `dispositioned_at`, credited to the agent who took the call, over the dialler conversations plus that agent's soft-phone conversations and answered inbound calls. When those other calls are in the figure, the tile's line says so ("counts 12 soft-phone and inbound calls") | Decided (default accepted, Manas, 2026-11-27) |
| TP5 | **The cohort is who dialled in the window**, the roster's rows for the scope (`rosterAttemptTotals`), with the roster route's membership filter keeping a departed member (`filterRowsByMembership`, kept); a departed agent is flagged and shown "(left)" | Decided (ratified by Manas 2026-11-27) |
| TP6 | **Its own flag**, `agency_team_performance_enabled`: boolean, off by default, global, tenant and account, client-exposed. Separate from `agency_compare_enabled` and `agency_reports_enabled`, because it runs in the primary over the whole account's cohort with its own guards | Decided (default accepted, Manas, 2026-11-27) |
| TP7 | **All campaigns by default; agents are compared only within one campaign** (CP8). With All campaigns the page shows every figure and no badges, with the note "Choose one campaign to see who's worth a look"; with one campaign, findings mark rows. `comparable` on the answer is the rule | Decided (default accepted, Manas, 2026-11-27) |
| TP8 | **The main outcome is the Live floor's rule.** If any campaign in scope has a catalog entry with `requires_promise` (its current catalog, or the default when it stores none: `effectiveCatalog`), the main outcome is promises (`promises_rate`); otherwise successes (`success_rate`, gated by `success_rate_reportable`). The campaigns that decide are those worked in the window (dialler conversations in the rollup, or promises recorded), and the whole scope only when none was: an idle or merely live promise campaign never makes a day of success-only calls promises (build, review fix S2). A mixed scope is promises, `main_outcome.mixed` is true when a campaign with dialler conversations in the window records no promises, and the page says so once, under the agents' heading, in the label's words: "Some campaigns here don’t record Will pay; their calls still count in the will-pay rate." (built, review fix C14). The server sends the label only when the counted codes carry exactly one distinct catalog label; otherwise the console writes "Will pay" or "Successes". Columns and the sort pill read "{label} rate" | Decided (default accepted, Manas, 2026-11-27) |
| TP9 | **"Stands out", not "Top performer"** (CP4: findings are for coaching, not appraisal) | Decided (default accepted, Manas, 2026-11-27) |
| TP10 | **Call-backs on time counts dialler-booked call-backs only**, in IN4's classes, for call-backs booked by cohort agents whose booked time falls in the window | Decided (default accepted, Manas, 2026-11-27) |
| TP11 | **Whole local days.** The window is local dates, both ends inclusive, under the reports' rule (`reportWindowProblem`: at most 30 days or exactly one calendar month, ending no later than today). A window that holds today runs to now, and the page says "Today, up to 2:15 PM". No custom time of day | Decided (default accepted, Manas, 2026-11-27) |
| TP12 | **The per-day chart shows working days.** A working day is a local day with at least one dialler conversation in scope or a count that is not zero; a day off is left out, not drawn as 0. A window of fewer than 7 local days shows the last 7 working days ending at its last day, looking back at most 14 days; a longer window shows every working day of it. One colour; the last bar labelled | Decided (ratified by Manas 2026-11-27) |
| TP13 | **"What happened on the calls" is dialler conversations only**, from the Insights rollup (`agency_insights_rollup_codes`), labelled from each campaign's catalog, and says how fresh the rollup is (`rollup_as_of`). The 7 largest outcomes are drawn one by one, the rest as "Other outcomes"; a null code and `no_disposition` are "No outcome chosen". The footnote that the bar and the main tile count differently is shown only when they differ | Decided (default accepted, Manas, 2026-11-27) |
| TP14 | **Soft-phone-only and inbound-only agents are not rows, and the tiles are the rows' sums.** An agent with no dialler call in the window has no row and is in no tile, so the tiles and the table always agree. The per-day chart and What happened on the calls are the whole team's in the scope, whoever took the calls (the page labels them "whole team" and "Dialler calls only"): the chart's promises per day count such an agent's promises too, so over the window it can pass the Will pay tile by those. Settled at D (2026-11-27): the first wording put their promises in the team's Will pay through nobody's row, which the contract's sums (`AgencyTeamTotals`) never did; the build keeps the sums | Decided (ratified by Manas 2026-11-27; wording settled at D and ratified) |
| TP15 | **Worth a look is Compare's findings over the whole cohort**: `compareFindings` on the main rate and `choose_time`, every row picked with no cap in all (`max: Infinity`: Compare's 5 in all is for its three picks and would drop a large team's gaps and crowd out its praise; Compare's 3 per agent holds), keeping `stands_out` and `clear_gap` only (no `too_few_calls`, no `not_clear`, no breaks). Words: "Stands out"; a gap on the rate "Low {label} rate"; on the time to choose "Slow to choose outcome" | Decided (ratified by Manas 2026-11-27) |
| TP16 | **The table is sorted in the browser**: by "{label} rate" (reportable rows first, highest first), Calls handled (most first) or Shortest calls (average call, shortest first, empty last). The rank is the position. Rows are not clickable in v1 | Decided (default accepted, Manas, 2026-11-27) |
| TP17 | **The server sends data, the console writes words** (CP12, AS15): codes, counts, fractions, labels from the campaigns' own catalogs. Every sentence on the page is the console's, in simple Indian English | Decided (ratified by Manas 2026-11-27) |
| TP18 | **Pick up to 3 rows and Compare picked** (CP1, `COMPARE_PAGE_MAX_AGENTS`): opens Compare agents with the campaign, the window and the picks. Shown only with `agency_compare_enabled` on; with All campaigns it is disabled and says why. Picks are not in the URL and clear when a filter changes | Decided (ratified by Manas 2026-11-27) |
| TP19 | **Download Excel is the existing campaign or account report** (one campaign: the campaign report; All campaigns: the account report), opened with the page's dates and the workbook chosen. A team-performance report kind is a later phase. Hidden when `agency_reports_enabled` is off | Decided (default accepted, Manas, 2026-11-27) |
| TP20 | **The read runs in the primary**, with Compare's guards (§4), and its cost is measured and recorded here before the tab is turned on for a tenant | Decided (default accepted, Manas, 2026-11-27) |

## 2. The screen

Top to bottom:

1. **Filters in one row:** When (Today, This week, Last 7 days, Last 30 days, Custom, Compare's
   presets), Campaign ("All campaigns" first, then the account's campaigns), and the line
   "Everything below follows these two filters." **Download Excel** at the right of the header.
2. **Five tiles:** Calls handled ("by N agents"), the main outcome ("27% of calls handled", or "26%
   will-pay rate · counts 12 soft-phone and inbound calls" when such calls are in it), Average call
   ("min:sec of talking"), Time to choose outcome ("30 s allowed", "no time limit" or "allowed time
   differs by campaign"), Call-backs on time ("due so far today" when the window holds now, else
   "due in this period"; "No call-backs due yet" when none is due).
3. **The main outcome per working day** (TP12) beside **What happened on the calls** (TP13).
4. **The agents:** one row per cohort agent: Agent (initials, name, "(left)"), Calls handled with
   the team median's tick, the main outcome's count, rate and bar ("Too few calls (12; needs 20)"
   under the floor, no bar), Average call, Choose outcome, Break (minutes), Worth a look (TP15).
   Sort pills (TP16) and pick boxes ("Pick {name} to compare", "N of 3 picked", TP18) above it;
   with All campaigns, "Choose one campaign to see who’s worth a look" (TP7); with a mixed scope,
   the line of TP8.

States: skeleton tiles on the first load, then the last answer kept while a new one loads
("Updating…"); no calls in the period: "No calls in this period", offering Last 7 days; a failed
read: the error's words, with Try again only for a failure that can clear by itself (busy, timed
out, 5xx, the network), Compare's retry rule; `503 team_timed_out`: "Too much to read at once. Try
a shorter period." While the rows on screen are not the answer to the filters above (a new filter
loading, or after its read failed: "These are the last figures that loaded, for 11 Nov to 17 Nov,
not for the filters above."), the pick boxes and Compare picked are disabled, so Compare never
opens on the new window with the old window's agents (TP18).

Reading again on its own: only a window that holds today **and** spans at most 7 local days
(`windowAutoRefreshes`: Today, This week, Last 7 days, or a custom window that short ending today)
is read again every 60 s while the page is visible and on return to the page. At local midnight
only a custom window is read again: a preset's dates move with the day, so its question changes
and is read anew. Last 30 days and any longer custom window, the heavy read (§4), are read once
per question. These reads are quiet (no "Updating…"). A failed one keeps the figures up with a
calm line, not an alert: "Couldn’t refresh. Showing figures up to 8:45 AM."; the next tick tries
again when the failure can clear by itself (busy, 5xx, the network). After a timeout, or a refusal
that would only repeat (404, 400, 403, `feature_disabled`), nothing is read on its own until the
filters change or the reader presses Try again (offered on that line after a timeout).

On a wide screen the tiles wrap (`repeat(auto-fit, minmax(160px, 1fr))`) and the table scrolls
sideways inside its card with the Agent column held. The two charts stack below about 900 px.
Below about 640 px the tiles go two to a row with an odd last one across both, the inline bars
hide, the header's actions wrap, and each agent is a card made from the same table (CSS only): the
pick box, rank and name, its badges, then the figures three to a row, each under its column's
name. The table keeps its roles, so a screen reader still reads a table with its column heads.

The per-day chart's axis tops out just above its tallest column (`trendAxis`: a whole-number step
of 1, 2, 2.5, 3, 4 or 5 × 10ⁿ, three or four gaps), not on `niceCeiling`'s coarser tops, which
left a peak of 105 under an axis of 200. When the main outcome's bar and its tile differ, the
footnote gives the likeliest reason in one line: "The tile also counts Will pay on soft-phone and
inbound calls (98 vs 96 here)." when such calls are in the tile; else, for promises, that the tile
counts a promise on the day it was given and the bars a call on the day it was made; for
successes, that the bars are a few minutes behind the tile.

## 3. Definitions

Every number with its source. "Roster" is the roster's attempt and occupancy totals
(`db/repositories/agency/agent-roster-stats.ts`) for the scope and window, read on the read's
client; "Compare" names the Compare metric whose number it is (`COMPARE_BUILTIN_METRICS`).

| Element | Source | Notes |
|---|---|---|
| Filters | Local `from`/`to` and the browser's `timezone` (Compare's model, TP11); campaigns from `listAgencyCampaigns` | "Today, up to 2:15 PM" from `as_of` |
| Calls handled, "by N agents" | Σ roster `connected` (`CONVERSATION_ATTEMPT_SQL`; Compare's `calls_handled`); N = the rows | |
| Main outcome and its line | Σ promises or Σ successes (TP8); the pooled rate Σ numerator ÷ Σ denominator over every row, a row whose own rate is withheld (`counts_disagree`) included: the tile is the rows' sums (TP14), where Compare's pooled figure leaves such a row out. "27% of calls handled" when `other_conversations` is 0; else the rate with "counts N soft-phone and inbound calls" | Promises: Compare's `promises_rate`, denominator roster `connected` + soft-phone connected (`SOFTPHONE_CONNECTED_SQL`) + inbound answered. Successes: Compare's `success_rate` |
| Average call | Σ `talk_seconds` ÷ Σ `connected` | "min:sec of talking" |
| Time to choose outcome | Σ `wrapup_seconds` ÷ Σ `measured_wrapups` (`MEASURED_WRAPUP_ATTEMPT_SQL`; Compare's `choose_time`). Allowed: the campaigns' `wrapup_seconds` (default 30) over those with calls: one value, its seconds; 0, no time limit; several, "differs by campaign" | |
| Call-backs on time | IN4's classes (`CALLBACK_BOOKING_COLUMNS_SQL`, `callbackClassSql`, as `COMPARE_CALLBACKS_SQL`) for call-backs booked by cohort agents with `callback_at` in the window. Due = on time + late + missed + pending due; on time within `AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES` (15) | Dialler-booked only (TP10) |
| Main outcome per day | Promises: the team's promises per local day of `dispositioned_at`. Successes: the rollup's conversations per local day on the success codes. Working days and span as TP12 | |
| What happened on the calls | `agency_insights_rollup_codes`, Σ by campaign and code over the scope; label and `icon` from each campaign's `effectiveCatalog`; a label clash goes to the campaign with most conversations on that code | Dialler only; `rollup_as_of` shown (TP13): the newest rollup change of the campaigns with conversations in the window, so an idle campaign never dates it back; null with none |
| Table: Calls handled, median tick | The row's `connected`; median by `cohortPercentiles` (`@magick-agency/domain/agent-compare/percentiles`) | |
| Table: main outcome | The row's figure by the domain's `compareValue` (floor 20, Wilson interval); median over the reportable rows | Under the floor: "Too few calls (12; needs 20)", no bar |
| Table: Avg call | `talk_seconds` ÷ `connected` | |
| Table: Choose outcome | `wrapup_seconds` ÷ `measured_wrapups`, reportable from 20 (`COMPARE_TIME_MIN_CALLS`) | |
| Table: Break | The roster's occupancy fold (`foldOccupancy`), `break_seconds` | Minutes |
| Table: Worth a look | `compareFindings` (`packages/domain/src/agent-compare/findings.ts`) over the main rate and `choose_time`, every row picked, no cap in all (TP15); only when `comparable` | |
| Sort pills | In the browser (TP16) | |
| Pick, Compare picked | At most 3 (TP18); opens `COMPARE_PATH` with `compareStateToParams` | Needs one campaign and the compare flag |

## 4. The read and its guards

`GET /proxy/agency/team-performance?from=YYYY-MM-DD&to=YYYY-MM-DD&timezone=<IANA>[&campaign_id=<uuid>]`,
`Cache-Control: no-store`. Guards in Compare's order:

1. session and tenant; RBAC `agency.supervise` (403);
2. the flag (`403 feature_disabled`);
3. the account context (`400 account_scope_required`);
4. the query's schema (the generic agency 400);
5. `campaign_id` a campaign of the account, else `404 team_campaign_not_found`;
6. the zone (`isRequestZone`, then `postgresZoneName`, a legacy alias cut in its current name),
   else `400 team_timezone_invalid`;
7. the window (`teamWindowProblem`, which is `reportWindowProblem`), else `400 team_window_invalid`;
8. a slot: at most `TEAM_PERFORMANCE_TENANT_CONCURRENT_READS` (2) per tenant and Compare's
   process-wide share of the pool (`compareGlobalReadLimit`), else `429 team_busy` with
   `Retry-After` and `retry_after_seconds` (`TEAM_PERFORMANCE_BUSY_RETRY_AFTER_SECONDS`);
9. the budget, `TEAM_PERFORMANCE_READ_TIMEOUT_MS` (8 s), else `503 team_timed_out`, a reviewed body
   through the error mask.

One read-only REPEATABLE READ transaction through `withCancellableRead`, one parallel worker, in
this order: the scope's campaigns, the rollup by code, the campaigns with promises in the window
(All campaigns only, and only when a campaign of the scope records promises; on the 0050 indexes),
then the main outcome from them (TP8), `rosterAttemptTotals`, `rosterOccupancyTotals`, the rollup by
day, the promises and the promises per day (promises only), the call-backs.
After the transaction, on the pool: the membership and the names (`filterRowsByMembership`,
`agentNamesOrNone`). A 30 s in-process cache (`TEAM_PERFORMANCE_CACHE_TTL_MS`) keyed by tenant,
account, campaign or all, window and zone; an identical read already running is joined, and a
cached or joined answer takes no slot. Every statement is scoped by tenant and account; the optional
campaign predicate is two SQL strings, never `$1 IS NULL OR`. Compare's SQL constants are not edited
(their plans are pinned by tests); the read reuses their exported fragments.

Metrics: `agency_team_performance_read_seconds{result}` and
`agency_team_performance_reads_refused_total{reason}` (`packages/observability/src/metrics/agency.ts`).

**How the build reads the scope** (chunk B, where the rulings left a choice):

- **All campaigns** is every campaign of the account: a promise, a soft-phone or an inbound call
  counts when it is on a campaign (`campaign_id IS NOT NULL`), so a soft-phone call on no campaign
  is in neither scope; a call-back on any campaign of the account. The scope's campaigns (the bars'
  labels, the rollup reads) are the ones a report covers (`accountCoveredCampaignIds`' rule): live
  now, or with rollup dials between the chart's first day and the window's end. Of those, the ones
  **worked in the window** (rollup conversations in it, or promises recorded in it) decide the main
  outcome, its codes and `mixed` (TP8); the ones with conversations in it give the allowed time and
  `rollup_as_of` (the newest of theirs).
- **The per-day chart and the bars are the team's, not only the window's cohort**: the rollup and
  the promises per day are read for the whole scope, whoever worked them. A short window's earlier
  days (TP12) are then the team's even when few of today's agents worked them, and a window holding
  today with nobody dialled yet still draws them. Over the window itself every dialler conversation
  is a cohort agent's; the promises per day can also hold the promises of an agent with no row
  (TP14), so the chart's sum can pass `totals.main.numerator` by those. The totals sum the rows (the
  contract's `AgencyTeamTotals`, TP14), so the tiles and the table always agree; the integration
  test holds a supervisor's soft-phone promise out of the tiles and in the chart.
- **"Campaigns with calls"** for the allowed time are the scope's campaigns with rollup
  conversations in the window.
- **Slots**: team reads have a limiter of their own with Compare's process-wide share
  (`compareGlobalReadLimit`, 5 of a pool of 30); Compare's and Team performance's reads together can
  hold two such shares (10 of 30).
- A missing `timezone` is `400 team_timezone_invalid` (the code's own doc in `errors.ts`, and
  Compare's rule for its zone); any other query that fails its shape, a malformed `campaign_id`
  included, is the generic agency 400.

**Cost, measured** (2026-11-27, TP20). No migration. Seeded as Compare's cost seed (§7 of
`compare-agents.md`): one account, two running campaigns of 100 agents each (one recording
promises), 31 days × 150 dials per agent (930,000 attempts, 310,000 conversations), 2.5 million
state events (more than Compare's 1.4 million: a reserve, a call and a wrap-up per dial), the rollup
folded. Each statement's `EXPLAIN (ANALYZE, BUFFERS)` inside the read's own transaction (one
parallel worker), and the whole read under its 8 s budget, in Asia/Kolkata:

| Window | Scope | Whole read | Roster attempts | Roster occupancy | Rollup (codes, days) | Promises (rows, days) | Call-backs |
|---|---|---|---|---|---|---|---|
| 1 day | one campaign | 0.19 s | 0.04 s | 0.08 s | 0.002 s, 0.04 s | 0.001 s, 0.007 s | 0.005 s |
| 1 day | All campaigns | 0.28–0.34 s | 0.08–0.13 s | 0.17–0.23 s | 0.003 s, 0.05–0.07 s | 0.002 s, 0.007 s | 0.009 s |
| 7 days | one campaign | 0.74 s | 0.22 s | 0.64 s | 0.01 s, 0.02 s | 0.003 s, 0.004 s | 0.04 s |
| 7 days | All campaigns | 1.53 s | 0.60 s | 1.30 s | 0.03 s, 0.05 s | 0.005 s, 0.004 s | 0.07 s |
| 31 days | one campaign | 2.8–3.1 s | 0.96 s | 2.83 s | 0.05 s, 0.06 s | 0.02 s, 0.02 s | 0.12 s |
| 31 days | All campaigns | **7.7 s, or `503 team_timed_out` at 7.8 s** | 3.67 s | **5.68 s** | 0.05 s, 0.12 s | 0.01 s, 0.02 s | 0.23 s |

(The scope's campaigns: under 0.02 s everywhere. The campaigns with promises in the window, added
after the measurement by the review (TP8), was not timed here: it reads the promises statement's
0050 indexes for the account (its plan held by the integration test), which take 0.02 s or less. "1 day" is a full busy day, as Today is at its end;
its chart reads 14 days of rollup and promises.) The read is the roster's two statements: the whole
cohort's occupancy (every state change of the window, its sort spilling to disk) and, across the
account, the attempt aggregate without a campaign to narrow `idx_agency_attempts_billing` on. Every
statement of the read's own is under a quarter of a second on 31 days, the promises on their 0050
indexes (held by the integration test's plan). So on an account this busy, All campaigns over a
whole month sits at the budget and answers `503 team_timed_out` about as often as not; a week, or
one campaign for a month, answers well inside it. That is the roster screen's own cost for the same
window (it has no timeout). **Decided (Manas, 2026-11-27): keep the live read as it is for
now** (the console says "Too much to read at once. Try a shorter period."). The follow-up is to
pre-process the figures once a day and serve the page from them, running the live read only when a
supervisor asks for a refresh (§7).

## 5. Contract

`packages/contracts/src/api/agency/team-performance.ts` (in the `AgencyApi` namespace), the build
contract; its doc comments are the field-level rules. Not a mobile vocabulary, so `literals.json`
does not change. Flag `agency_team_performance_enabled` (TP6).

| Route | Query | Answer |
|---|---|---|
| `GET /proxy/agency/team-performance` | `AgencyTeamPerformanceQuery`: `from`, `to`, `timezone`, `campaign_id?` | `AgencyTeamPerformance` |

`AgencyTeamPerformance`:

- `campaign_id` (null for All campaigns), `from`, `to`, `timezone` (the request's, echoed as sent,
  a legacy alias too), `as_of`, `rollup_as_of`;
- `main_outcome`: `kind` (`AgencyTeamMainOutcomeKind`: `promises`, `successes`), `codes`, `label`,
  `mixed` (promises, and a campaign with dialler conversations in the window records none; TP8);
  `TEAM_MAIN_OUTCOME_METRIC` maps the kind to its Compare metric (`promises_rate`,
  `success_rate`);
- `totals`: `agents`, `calls_handled`, `main` (an `AgencyCompareValue` over the sums),
  `other_conversations`, `avg_call_seconds`, `choose_seconds`, `wrapup_allowed` (`seconds`,
  `varies`), `callbacks` (`due`, `on_time`, `late`, `missed`, `pending_due`, `upcoming`);
- `medians`: `calls_handled`, `main_rate`, `avg_call_seconds`, `choose_seconds`;
- `outcomes`: every outcome with a conversation, most first (`code`, `label`, `icon`,
  `conversations`); the console folds past `TEAM_OUTCOME_BARS_MAX`;
- `trend`: `span` (`AgencyTeamTrendSpan`: `last_working_days`, `window`), `dates`, `counts` (TP12,
  `TEAM_TREND_WORKING_DAYS`, `TEAM_TREND_LOOKBACK_DAYS`);
- `agents`: every cohort row (`AgencyTeamAgentRow`), unsorted: `agent_user_id`, `agent_name`,
  `departed`, `calls_handled`, `main`, `talk_seconds`, `avg_call_seconds`, `wrapup_seconds`,
  `measured_wrapups`, `choose`, `break_seconds`, `shift_seconds`;
- `comparable` (`campaign_id !== null`) and `findings` (`AgencyCompareFinding[]`, only
  `TEAM_FINDING_CODES` on `TEAM_FINDING_METRICS`; `[]` unless comparable).

Refusals are `{ error, code, message }` (`AgencyTeamPerformanceErrorResponse`) with the codes of
`src/errors.ts` §11 (`AGENCY_TEAM_PERFORMANCE_ERROR_CODES`, statuses in
`AGENCY_TEAM_PERFORMANCE_ERROR_STATUS`): `team_campaign_not_found` 404, `team_timezone_invalid`
400, `team_window_invalid` 400, `team_busy` 429, `team_timed_out` 503.

## 6. Where the code goes

- Server: SQL in `apps/server/src/db/repositories/agency/team-performance-reads.ts` (through the
  `agency.repository.ts` barrel); `apps/server/src/agency/team-performance/` (`validate.ts`,
  `read.ts`, `assemble.ts`, pure), as `agency/compare/`; the route
  `api/routes/proxy-agency-team-performance.routes.ts`, registered in `api/agency.plugin.ts`.
- Console: `src/api/teamPerformance.ts`, `src/hooks/useTeamPerformance.ts`,
  `src/utils/agency/team/` (the flag and path, the URL state, the copy, the sort, the chart
  geometry), `src/pages/agency/TeamPerformancePage.tsx`, `src/components/agency/team/`; the route
  in `App.tsx` under `RequireFlag`, the tab in `consoleNav.ts`, the search entry in
  `consoleSearch.ts`. It reuses Compare's helpers (window presets, the URL's dates, the retry rule,
  the chart paths), not Compare's or the roster's components.

## 7. Build plan and status

| Chunk | Scope | Status |
|---|---|---|
| A | The contract (`team-performance.ts`, the error codes in `errors.ts` §11), the flag in `flags.ts` and the server's registry, this doc | **Built** (2026-11-27) |
| B | The server: the SQL, validate, read and assemble, the route and its guards, the metrics, the cost measured (§4) | **Built** (2026-11-27). The route is in the console's paths (`test/fixtures/console-paths.json`), called from `src/api/teamPerformance.ts` |
| C | The console tab (§2), its nav entry, search entry and Download Excel | **Built** (2026-11-27), against the contract and answers worked out by the shared domain rules (`__tests__/helpers/teamRecorded.ts`), held at D to answers recorded from the real route. The tabs read Team performance, Analytics, Compare agents, Exports: Analytics stays ahead of Compare agents so a supervisor with this flag off still lands on Analytics, not on Compare. The top bar's "Reports" crumb opens the first tab the reader may open, as the sidebar does, so a viewer's never points at this supervisor-only tab |
| D | The docs around it (the doc map, modules, status, Compare's and Reports' docs, seams, operations) and a run end to end against the real route on a seeded database | **Built** (2026-11-27). Answers recorded from the real route over the integration test's seed (`__tests__/helpers/teamRouteRecorded.ts`); `__tests__/utils/teamAnswer.test.ts` holds them and the page tests' hand-made answers to the server's rules (the sums, the medians, Compare's values and findings, the trend's span). TP14 settled: the tiles are the rows' sums. The phone layout, the per-day axis and the outcome footnote polished (§2) |
| Review | Three independent reviews of the built page (server, console, docs) | **Fixed** (2026-11-27). Server: the main outcome, `mixed` and `rollup_as_of` from the campaigns worked in the window (TP8, §3); Worth a look with no cap in all (TP15); the per-day chart's tenant and account bounds tested; the opt-in recorder (§8); the dashboard's Team performance row. Console: refreshing only short live windows and never after a refusal or a timeout, a failed refresh said calmly, the picks held to the answer on screen (§2 States); Download Excel's dates held to the dialog's today (`reports.md`); the bars aligned; "Success rate"; the mixed note (TP8) |

**Next (not built):** All campaigns over a whole month reads in about 7.7 s against the 8 s budget
on a tenant as busy as the cost seed and answers `503 team_timed_out` about as often as not (§4
"Cost, measured"). Manas ruled on 2026-11-27 to keep the live read for now and to follow with a
daily job that pre-processes each day's figures per account and campaign; the page then reads
those, and runs the live read only on a forced refresh.

## 8. Tests

- Contract: `packages/contracts/test/team-performance.test.ts` (the vocabularies, the main
  outcome's Compare metrics and their floors, the limits, the window rule against the reports' and
  Compare's) and the team codes' snapshot in `errors.test.ts`; the flag in `flags.test.ts`, the
  server's `test/unit/feature-flags/registry.test.ts`, the super-admin catalog test and the flag
  service's integration test. Built.
- Server (B): unit `test/unit/agency/team-performance/assemble.test.ts` (with the main outcome
  decided by the campaigns worked, `mixed`, `rollup_as_of` over the campaigns with calls, and a team
  of 30 with all 8 gaps and both praises named) and `read-guards.test.ts`;
  the route `test/unit/api/routes/proxy-agency-team-performance.routes.test.ts` (each refusal's
  order and body, the busy and timed-out bodies byte for byte); the route table and agent-reach
  guards. Integration `test/integration/api/team-performance.test.ts`, seeded as
  `compare-agents.test.ts`: every figure held to `GET /agents/stats` and `POST /compare/query` for
  the same campaign and window (the oracle), tenant and account isolation, a departed agent kept,
  calls at 23:50 and 00:10 in a zone other than UTC, the trend skipping a day off, a mixed scope,
  an agent with no row out of the tiles and in the chart (TP14), the main outcome decided by the
  campaigns worked in the window (an idle promise campaign beside a success-only day, then a
  soft-phone promise on it: `mixed`), the per-day chart's tenant and account bounds, a legacy zone
  echoed, the timeout's 503, and the plan of the promises statement using its index.
  Mutation-checked: the comparable gate on findings, the working-day rule, the scope's tenant and
  account predicate, the tiles as the rows' sums (TP14), the cap in all on findings, the campaigns
  worked deciding the main outcome, `rollup_as_of` over the campaigns with calls, the per-day
  promises' tenant and account predicates. Built.
- **The console's recorded answers** (`apps/console/src/__tests__/helpers/teamRouteRecorded.ts`) are
  written by that integration test, over its seed, when `RECORD_TEAM_ANSWERS` names the file
  (a path from `apps/server`; off by default, so CI never writes it). From `apps/server`:
  `RECORD_TEAM_ANSWERS=../console/src/__tests__/helpers/teamRouteRecorded.ts pnpm vitest run -c vitest.config.integration.ts test/integration/api/team-performance.test.ts`.
  Re-record after a change to the answer's shape or its rules, and commit the file with it.
- Console (C, D): the team utilities (`windowAutoRefreshes` and the copy included), the chart
  geometry (the per-day axis included), `pages/TeamPerformancePage.test.tsx` against the hand-made
  answers (each figure cell named for the phone layout, the figure boxes' widths, which windows read
  again on their own and after which failures, the quiet refresh failure's line, the picks disabled
  while the figures are another question's, Download Excel held to the campaign zone's today, the
  mixed note shown and hidden). The page tests fake `setInterval` for the 60 s timer and mock
  `useAtLocalMidnight`, firing its timers on demand, for midnight. `utils/teamAnswer.test.ts` holds
  those answers and the ones recorded from the real route (`helpers/teamRouteRecorded.ts`) to the
  server's rules (Worth a look with no cap in all, `mixed` only with promises included);
  `components/ExportReportDialog.test.tsx` (`initialDatesFor`); `navRouteGates.test.ts`,
  `consoleSearch.test.ts`, `reportEntryPoints.test.tsx` (Download Excel's entry),
  `api/teamPerformance.test.ts` (exactly the query the server validates) and a timezone test.
  Mutation-checked: the nav gate, the three-pick limit, the comparable rule, the per-day axis, the
  figures' names for the phone layout, the mixed note (shown, hidden) and `mixed` only with
  promises.
- Mobile: the app does not read this route. The flag adds one key to the platform fixture's flag
  map (`fixtures/agent/platform.json`), which the app's `FeatureFlags.fromJson` reads whatever its
  keys (`agency_wire`'s `platform_test.dart`).
