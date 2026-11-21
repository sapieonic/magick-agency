# Compare agents

A tab of Reports where a supervisor puts up to three agents of one campaign side by side, against
the rest of the campaign's agents, and is told what stands out. The metrics are not fixed: each
kind of campaign starts from a **lens** (a set of metrics), the supervisor can change it, and the
page draws each metric with the chart its shape calls for. Outcome metrics are the supervisor's
choice: any set of the campaign's outcome codes (CP17). Designed 2026-11-21 and reviewed
independently the same day; rulings CP1–CP18 below. **The contract, the rules and the saved-views
table are built, and so are the server's read, routes and saved views; the console tab is not** (§9).

This file is the design and the build contract. Where it and another doc disagree about this page,
this file wins; where it reuses another area's read, that area's doc defines the number.

## 1. Rulings

CP1–CP7 and CP17 are Manas's answers of 2026-11-21. CP8–CP16 are the design's own recommendations,
which he left without comment; they stand as recommended (the convention of `agent-station.md` §1).
CP18 is the build's own, pending him.

| ID | Ruling | Status |
|---|---|---|
| CP1 | **Three agents at most** on the Compare page. Three is what stays readable on every chart and what the colour-blind check passes for every pair (the first three categorical slots, light and dark). The roster's compare tray keeps its own limit (`COMPARE_MAX_AGENTS = 4`, `apps/console/src/utils/agencyCompareTray.ts`) | **Decided** (Manas, 2026-11-21) |
| CP2 | **Will-pay counts promises made**, from every call type that records one: dialler attempts, soft-phone calls and inbound calls (the promise columns of 0041), attributed to the agent who took the call. The page says "promises", never "payments". A followed-up rate (`promise_followed_up_at`, PT7) is a later metric, not a condition for showing will-pay | **Decided** (Manas, 2026-11-21) |
| CP3 | **No agent view yet.** The page and its read are supervisor-only (`agency.supervise`); an agent never sees other agents or the team's figures here. RP5 stands | **Decided** (Manas, 2026-11-21) |
| CP4 | **Findings are for coaching now; appraisal later.** v1 keeps no record of the findings shown. Appraisal will need stricter rules and a record of every finding shown to whom; finding codes (§6) are kept stable so that record can be added without changing their meaning | **Decided** (Manas, 2026-11-21) |
| CP5 | **Logged-in time includes breaks**: the roster's basis (`shift_seconds`, breaks inside), so "Where their day went" and the roster's utilisation agree | **Decided** (Manas, 2026-11-21) |
| CP6 | **No worker process to start with.** The read runs in the primary with the guards of §7. An analytics child (the `ANALYSIS_WORKERS` pattern, `scaling.md`) is added only on the measured trigger in §7 | **Decided** (Manas, 2026-11-21) |
| CP7 | **No list or shift filter.** Agents are not put on lists or shifts in a pattern today, so within one campaign the comparison stands without one. Revisit if assignment starts to follow seniority | **Decided** (Manas, 2026-11-21) |
| CP8 | **One campaign per comparison.** The cohort is the campaign's agents, never a pooled multi-campaign cohort (`cohortComparable()`, `apps/console/src/utils/agency/roster/benchmark.ts`). Across campaigns only later, as each agent's actual rate against what their campaign mix predicts | Decided (as recommended) |
| CP9 | **One definition per number.** Every catalog entry names an existing read and takes its numerator, denominator and floor from it; the catalog adds only the unit, which way is better and the smallest gap worth a line. Rates use the roster's floor, 20 (`AGENCY_ROSTER_MIN_RATE_DENOMINATOR`, with `success_rate_reportable` for the success rate). The console's cells come from `agencyCompareTray.ts`, so the page cannot show a rate the roster withholds | Decided (as recommended) |
| CP10 | **Neutral metrics are shown, never flagged**: calls handled, calls per hour, connect rate, average call, amount promised, wrong-number share, waiting time and minutes of break. The list, the dialler or the debt size drives them more than the agent | Decided (as recommended) |
| CP11 | **A finding names an agent only when chance cannot explain it** (§6): rates by a 95% Wilson interval against the rest of the cohort's pooled rate; times from 1.5 times the median; breaks against the campaign's own limits | Decided (as recommended) |
| CP12 | **No language model in the findings.** The server returns codes and numbers; the console writes the words (AS15) | Decided (as recommended) |
| CP13 | **Call-analysis metrics are shown with their coverage and never flagged** in v1: "*n* analysed of *N* calls" on each, keyed by profile version | Decided (as recommended) |
| CP14 | **No free-form formulas.** A supervisor never types a ratio or an expression. An outcome set (CP17) is not one: it is a fixed definition (share of conversations ending in any of the chosen codes) over a chosen list of the campaign's own codes | Decided (as recommended) |
| CP15 | **Exports through the existing report pipeline** (a report kind `agent_compare`, the renderer Lambda), not a new process | Decided (as recommended) |
| CP16 | **No Inbound lens** until inbound calls are in the rollup | Decided (as recommended) |
| CP17 | **Outcome metrics are the supervisor's choice.** Beside the built-ins, a metric can be an **outcome set**: 1 to 5 outcome codes of the campaign's current catalog, giving the share of the agent's conversations on the campaign ending in any of them (dialler conversations, from `agency_insights_rollup_codes`, as Insights counts them). The supervisor names it (default: the codes' labels, "A, B or C") and says which way is better: higher, lower or neither. A set of neither direction is shown and never named; a directional one is judged by the same interval rule as every rate (§6). A set can be the per-day trend (its count per local day) and is kept in saved views. Will-pay is one such set; `promises_rate` (CP2) stays a built-in beside them | **Decided** (Manas, 2026-11-21) |
| CP18 | **Direction comes from the supervisor.** The catalog has no refusal category (`AgencyDisposition` has `is_success`, no refusal flag), so a set's direction is never inferred, except that a set of success codes only starts as "higher is better"; any other set starts as "shown, never flagged" until the supervisor chooses. No lens starts with a lower-is-better set | Default, pending Manas |

## 2. The screen

Reports gains a tab, **Compare agents**, beside the existing ones. Top to bottom:

1. **Filters in one row:** Lens, Campaign (one), When (a window of local dates, at most 31 days,
   the reports rule `reportWindowProblem`), and **Metrics · N**, which opens the picker (at most 6,
   grouped as in §3, each marked "higher is better", "lower is better" or "shown, never flagged").
   The picker's Outcomes group adds **an outcome set**: tick up to 5 of the campaign's outcome
   buttons, name it, choose the direction (CP17, CP18).
2. **Pick up to 3 agents:** a chip per agent of the campaign; an agent under the floor carries
   "few calls". A colour follows the person: removing one agent never repaints the others.
3. **Side by side:** a small bar chart per metric (§5) with the team median, the middle half of the
   team and, on rates, the likely range.
4. **What stands out:** at most 5 findings (§6), each with **Why this?** and a next step; under them
   **Not clear yet (N)**, gaps that could still be chance, with **Check a longer window**; and the
   list of metrics on screen that are shown for context and never flagged.
5. **The lens's main outcome per working day** (the trend: an outcome set or promises) and **Where
   their day went** (on a call, choosing outcome, break, waiting; waiting in grey and never flagged).
6. **The numbers:** the table behind every chart.

Copy follows AS15. The state of the page (lens, campaign, window, agents, metrics by their ids,
`compareMetricId`) is in the URL, so a link opens the same comparison; a saved view (§4) holds the
lens, metrics and trend, never agents or a window.

## 3. Metric catalog

Every metric is a built-in (`COMPARE_BUILTIN_METRICS`) or an outcome set
(`COMPARE_OUTCOME_SET_DEFINITION`), both in `packages/contracts/src/api/agency/compare.ts`, which
holds each one's unit, direction, smallest gap, floor and read. Rates are fractions on the wire.
Floors: the roster's 20 on each rate's own denominator (`AGENCY_ROSTER_MIN_RATE_DENOMINATOR`;
`success_rate` is exactly `success_rate_reportable`), 8 settled call-backs for call-backs kept (an
agent books a handful a week; the interval still keeps a thin rate from being named).

| Group | Metric (key) | Better is | Smallest gap | Read |
|---|---|---|---|---|
| Volume | Calls handled (`calls_handled`) | neutral | | roster row `connected` |
| Volume | Calls per hour logged in (`calls_per_hour`) | neutral | | roster `connected` ÷ `shift_seconds` (breaks inside, CP5) |
| Volume | Connect rate (`connect_rate`) | neutral | | roster row (`rosterFlag` already refuses it) |
| Outcomes | Success rate (`success_rate`) | higher | 5 points | roster `successes` ÷ `connected`, gated by `success_rate_reportable` |
| Outcomes | **An outcome set** (`outcomes:<better>:<codes>`) | the supervisor's (CP17, CP18) | 5 points | `agency_insights_rollup_codes` by agent: conversations ending in the set ÷ conversations |
| Outcomes | Promises (`promises_rate`), when the catalog has a `requires_promise` entry | higher | 5 points | promise columns on the three call tables ÷ their conversations (CP2) |
| Outcomes | Amount promised (`promised_amount`), the same condition | neutral | | the same; no currency (PT5) |
| Outcomes | Call-backs booked (`callbacks_booked`) · kept on time (`callbacks_kept_rate`) | neutral · higher | · 12 points | `agentCallbackTiming` scoped to the campaign (IN4 classes) |
| Handling | Average call (`avg_call`) | neutral | | roster `talk_seconds` ÷ `connected` |
| Handling | Time to choose outcome (`choose_time`) | lower | 1.5 × median | roster `wrapup_seconds` ÷ the count of the same measured wrap-ups |
| Handling | No outcome chosen (`no_outcome_rate`) | lower | 4 points | rollup `no_outcome` facet, by agent |
| Time use | On a call · choosing outcome · break · waiting | composition | | the agent review's presence fold (`reports/datasets/agent-presence.ts`), share of the shift (CP5); reserved is folded into waiting |
| Time use | Breaks over their limit (`breaks_over_limit`) | lower, against the limit | 2 breaks | `break_overrun_seconds` (0060, AS12) |
| Analysis | Each custom analysis question (yes/no → share, choice → mix, number → average); upset customer | shown only (CP13) | | completed analyses; the agent review's `quality` block for sentiment (phase 4) |

Outcome sets and `success_rate` follow the campaign's **current** outcome catalog, as Insights
does. A set names codes, so a code later removed from the catalog makes the set unusable on that
campaign (`compare_metric_invalid`); the console drops it from a saved view it applies, and says so.

## 4. Lenses

A lens is a starting set: fixed built-ins plus one slot for the campaign's **main outcome**, an
outcome set built from its current catalog, which is also the per-day trend
(`compareLensDefaults`, `packages/domain/src/agent-compare/lens.ts`).

| Lens | Metrics | Main outcome (and trend) |
|---|---|---|
| Collections | calls handled, main, time to choose outcome, no outcome chosen, average call, breaks over limit | "Will pay": the `requires_promise` codes, higher is better |
| Sales | calls handled, main, call-backs booked, call-backs kept on time, average call, calls per hour | "Success": the `is_success` codes, higher is better |
| Verification and surveys | calls handled, calls per hour, main, no outcome chosen, average call, time to choose outcome | "Success", as Sales |
| New joiner (phase 2) | one agent against their own previous four weeks and the team median | the lens's main outcome |

More qualifying codes than a set holds (5): the built-in that counts all of them, `promises_rate`
for Will pay (still the trend) or `success_rate` for Success (no trend), never a cut list. No
qualifying code: Collections falls back to Success; Sales and Verification leave the slot out. No
lens starts with a lower-is-better set (CP18): a supervisor who wants "Refused" adds it.

The campaign's starting lens (`compareStartingLens`): Collections when its outcome catalog has a
`requires_promise` entry, otherwise Sales. **Saved views** (`agency_compare_views`, 0063): a lens,
metrics and trend, personal or shared with the account's supervisors, optionally for one campaign
and optionally that campaign's default (shared, one per campaign); only the owner edits one; at
most 50 per supervisor per account.

## 5. Charts

| Metric shape | Chart |
|---|---|
| One value per agent | Horizontal bar per agent; the median as a line under the bars; the middle half (p25–p75) as a band; on rates a whisker for the 95% Wilson interval; value labels at the bar ends |
| Under the floor | No bar: "Too few to compare (12 calls; needs 20)" |
| Per working day (the trend) | A line per agent, broken on days they did not log in; the team median dashed; end labels |
| A split of the shift | 100% stacked bar per agent; waiting in grey |

Drawn in SVG in the console, as `AgentBucketChart` is; no chart library. Agent colours are the
first three categorical slots; activity colours are a separate set, so a colour never means both a
person and an activity. The band and median are the roster benchmark's method
(`cohortPercentiles`, `percentile_cont`, which the roster's `rosterPercentiles` now calls), over the
campaign's agents who clear the metric's floor, not a second percentile implementation.

## 6. Findings

A pure function, `compareFindings` in `packages/domain/src/agent-compare/findings.ts`, over the
read's figures for every cohort agent on each metric on screen. It names an agent only when:

| Code | Rule |
|---|---|
| `clear_gap` (rate) | the agent's rate passes the floor; the rest of the cohort's pooled rate is computed with the agent left out (every other agent, thin ones included); the agent's 95% Wilson interval lies wholly on the worse side of it; and the gap is at least the metric's smallest gap (5 points for success, promises and outcome sets, 4 for no outcome, 12 for call-backs kept) |
| `clear_gap` (time) | time to choose outcome at least 1.5 times the cohort median (agent included), with at least 20 measured wrap-ups |
| `over_break_limit` | two or more breaks over their reason's limit in the window |
| `stands_out` | a higher-is-better outcome rate (success, promises, a "higher" outcome set) whose interval lies wholly above the rest of the cohort's pooled rate by at least the smallest gap; offers "Share their best call" |
| `too_few_calls` | a picked agent under the floor on a flaggable metric on screen; once per agent, the first such metric |

Guards: neutral metrics and neutral outcome sets are never named; a metric whose rated cohort (agents
over its floor, picked ones included) is under 6 yields nothing at all, `too_few_calls` and
`not_clear` included; at most 3 findings per agent and 5 in all, taken as clear rate gaps, then
times, then breaks, then `stands_out`, then `too_few_calls`, the larger gap first within each; what
does not fit is dropped, never moved to `not_clear`. A gap of at least the smallest gap on the worse
side that fails the interval (or a time from 1.25 to 1.5 times the median) goes to `not_clear`, which
the console lists under **Not clear yet**; a smaller gap goes nowhere. Only metrics on screen are
judged. Analysis metrics are never named. When the agent is low on an outcome rate and slow to
choose an outcome, the time finding says it is worth asking whether the outcome buttons are clear to
them; it never states a cause.

Worked example: Priya at 5 of 29 against the rest's 86 of 308 (17% against 28%) is not clear yet
(her interval, 8% to 35%, reaches 28%); over a longer window, 38 of 196 against 561 of 2005 (19%
against 28%) is a clear gap (interval 14% to 25%).

Next steps (`next_step`), each a filtered view that exists: the call log for the agent (recorded
calls only, RC1; hidden without listening rights) for a low success, promise or higher-is-better set;
the call log for the agent and the set's codes for a lower-is-better set; their recorded calls ending
in the outcome to share (`stands_out`); the agent record's breaks; Call-backs filtered to the agent
(call-backs kept); a supervisor message (no outcome chosen, slow to choose).

## 7. Where it runs

The read runs in the primary (CP6). It composes reads that already serve screens, for at most three
agents and the campaign's cohort:

- `readAccountRoster` (`reports/datasets/shared.ts`) scoped to the campaign: the rows, the
  benchmark, the floor (plus the count of measured wrap-ups for `choose_time`);
- the Insights rollup by agent for the campaign: `agency_insights_rollup_codes` (outcome sets) and
  the `no_outcome` facet;
- the promise columns of the three call tables (`promises_rate`, `promised_amount`) and
  `agentCallbackTiming` scoped to the campaign (call-backs), only when those metrics are on screen;
- the presence fold for the picked agents (`agent-presence.ts`), and the break overruns;
- for the trend, the set's or the promises' count per local day per agent, and each agent's
  logged-in days on the campaign.

Guards: `SET LOCAL statement_timeout` of 3 s inside the read's transaction (the pool sets none by
default, `db-hygiene.md`); at most 2 compare reads at a time per tenant (429 past it); a 30 s
in-process cache keyed by tenant, the caller's membership scope, campaign, window, zone, agents,
metric ids and trend id (`COMPARE_TENANT_CONCURRENT_READS`, `COMPARE_READ_TIMEOUT_MS`,
`COMPARE_CACHE_TTL_MS`). The options read counts against the same limit. Metrics: `agency_compare_read_seconds` (histogram), `agency_compare_reads_refused_total`.

**Trigger for the analytics child:** the read's p95 above 1.5 s for a day, or `db_pool_acquire_seconds`
rising while compare reads run. Then the read moves to a child forked by the primary with its own
small pool, as `ANALYSIS_WORKERS` does, or to a read replica.

The interactive read is never a Lambda: the renderer has no database access by design (RP1).
Exports (phase 4) are a report kind `agent_compare` whose dataset is the same read's response; the
renderer Lambda draws the same charts.

**As built (server, phase 1b).** `apps/server/src/agency/compare/` (`read.ts`, `assemble.ts`,
`validate.ts`), its SQL `db/repositories/agency/compare-reads.ts`, the saved views
`compare-view.repository.ts`, the routes `api/routes/proxy-agency-compare.routes.ts`. Where the build
reads a number other than the way the text above words it, the reason:

- **The cohort** is the roster's own attempt statement (`rosterAttemptTotals`, the one
  `GET /agents/stats?campaign_id=` runs) on the read's client, with the roster route's membership
  filter (`filterRowsByMembership`, a departed agent kept, CP8). It is every row, not the roster
  page's first 200. The statement also counts the measured wrap-ups `choose_time` divides by.
- **No outcome chosen** is read from `agency_insights_rollup_codes` (a NULL code or `no_disposition`),
  not the `no_outcome` facet: the facet carries no agent. Insights reconciles the two
  (`no_outcome_vs_unclassified_codes`), so it is the same number by agent.
- **Promises** (CP2) divide by the roster's conversations plus the agent's soft-phone calls on the
  campaign that connected (`SOFTPHONE_CONNECTED_SQL`, `created_at` in the window, Insights' rule) and
  inbound calls they answered that matched the campaign (`outcome = 'answered'`, `arrived_at` in the
  window, the inbound summary's rule). Promises are counted by `dispositioned_at`, as My day does.
- **Where their day went** is the roster's occupancy fold for the picked agents (`foldOccupancy`
  over the same intervals and clips), so `day_split.shift_seconds` is the roster's `shift_seconds`
  rounded, the four parts summed to it (`roundPreservingSum`). The roster's occupancy statement is
  read for the whole cohort only when `calls_per_hour` is on screen.
- **The trend's days** are the local days the agent's sessions on the campaign touch, each session's
  life clipped to the window and to now. A session's life is its logged-in time (an agent is offline
  only once the session has ended); the event log is needed to split that time by state, never to
  say which days had any. On a month of 100 agents (1.4M state events) the event walk took 5.5 s,
  past the timeout; the session read takes 8 ms.
- **Outcome codes** are the campaign's current catalog, or the default catalog when it stores none
  (My day's `effectiveCatalog`). `success_rate` keeps the roster's rule (the stored catalog).
- **The cache** holds the query's answer only; the options read takes a slot and is never cached
  (its default view must show a save at once). An answer from the cache takes no slot. The cache key
  carries no outcome set's label (the id has none), so a cached answer is served with the request's
  own `metrics` and `trend_metric`. The caller's scope in the key is the context account: the cohort
  is the account's roster whoever in the account asks.
- **Without `X-Account-Id`** every route answers `400 account_scope_required`, the floor routes' rule.

**Cost, measured.** On 930,000 attempts (two campaigns of 100 agents × 31 days × 150 dials) and
1.4M state events, `EXPLAIN ANALYZE` of each statement, a 31-day window: the roster attempt statement
1.3–1.5 s (a parallel scan of the window; `idx_agency_attempts_campaign_dialed` on a 7-day window,
0.5 s), the roster occupancy statement for the whole cohort **4.3 s** (every event of the window, its
window sort spilling to disk; 0.9 s on 7 days), the same for three picked agents 0.1 s, rollup codes
0.1 s, promises 0.03 s, call-backs 0.03 s, breaks over the limit 0.08 s, the trend's days 0.008 s.
So on a campaign this busy a month with `calls_per_hour` on screen (the Sales and Verification
lenses) answers `503 compare_timed_out`; a week answers. That is the roster screen's own statement
and cost for the same window (it has no timeout); the trigger above is the remedy, or a narrower
default window on the page.

## 8. Contract

`packages/contracts/src/api/agency/compare.ts` (in the `AgencyApi` namespace), the build contract;
its doc comments are the field-level rules. Not a mobile vocabulary, so `literals.json` does not
change. Flag `agency_compare_enabled` (off by default; global, tenant, account; client-exposed).
Access: `agency.supervise` (CP3); flag off answers `403 feature_disabled`.

| Route | Body / query | Answer |
|---|---|---|
| `POST /proxy/agency/compare/query` | `AgencyCompareQuery`: `campaign_id`, `agent_ids` (1–3), `metrics` (1–6 `AgencyCompareMetricRef`), `trend?`, `from`, `to`, `timezone` | `AgencyCompareResponse`: resolved `metrics`, each picked agent's `values` keyed by metric id (value, numerator, denominator, reportable, Wilson `interval`) and `day_split`, the cohort's `per_metric` (p25, median, p75, pooled, agents rated), `findings`, `not_clear`, `trend`, `as_of` |
| `GET /proxy/agency/compare/options` | `campaign_id`, `from`, `to`, `timezone` | `AgencyCompareOptions`: the cohort's agents, the outcome codes, `records_promises`, `starting_lens`, `default_view` |
| `GET /proxy/agency/compare/views` | `campaign_id?` | `AgencyCompareViewList` |
| `POST /proxy/agency/compare/views` | `AgencyCreateCompareViewRequest` | 201 `AgencyCompareView` |
| `PATCH`, `DELETE /proxy/agency/compare/views/:id` | `AgencyUpdateCompareViewRequest` | 200 `AgencyCompareView`, 204 |

A metric is named by its id (`compareMetricId`): the built-in key, or
`outcomes:<better>:<sorted codes>` for a set; `parseCompareMetricId` reverses it for the URL.
Refusals are `{ error, code, message }` with the codes of `src/errors.ts` §9
(`AGENCY_COMPARE_ERROR_CODES`, statuses in `AGENCY_COMPARE_ERROR_STATUS`): `compare_campaign_required`
400, `compare_campaign_not_found` 404, `compare_too_many_agents` 400, `compare_too_many_metrics` 400,
`compare_metric_invalid` 400, `compare_window_invalid` 400, `compare_timezone_invalid` 400,
`compare_agent_not_in_cohort` 404, `compare_busy` 429, `compare_timed_out` 503 (a reviewed body
through the error mask), `compare_view_not_found` 404, `compare_view_invalid` 400,
`compare_view_limit` 409.

The rules both sides share are in `@magick-agency/domain/agent-compare`: `resolveCompareMetrics`
(a request's or view's refs against the catalog), `compareValue`, `compareCohortMetric`
(`cohortPercentiles`, the roster benchmark's `percentile_cont`; the roster's `rosterPercentiles`
delegates to it), `wilsonInterval`, `compareLensDefaults`, `compareStartingLens`, `compareFindings`.

## 9. Build plan and status

| Phase | Scope | Status |
|---|---|---|
| 1a | Contract (`compare.ts`, the error codes, the flag); `packages/domain/src/agent-compare/` (Wilson, percentiles, metrics, lenses, findings, mutation-checked); `agency_compare_views` (0063) | **Built** (2026-11-21) |
| 1b (server) | The read and the routes (`proxy-agency-compare.routes.ts`, agency area: query, options, saved views), metrics `agency_compare_read_seconds` and `agency_compare_reads_refused_total` (§7 "As built", "Cost, measured") | **Built** (2026-11-21) |
| 1b (console) | The console tab with the three lenses, the picker (built-ins and outcome sets), Side by side, What stands out, Where their day went, the trend, The numbers, saved views | Not started |
| 2 | The New joiner lens | Not started |
| 4 | Analysis questions as metrics (CP13); the `agent_compare` report kind and a weekly subscription to a saved view | Not started |
| 5 | Only if asked: a scatter of two metrics; across campaigns with expected against actual; the analytics child on its trigger | Not planned |

Phase 3 (a metric per outcome button, will-pay and amount promised) is folded into 1: outcome sets
(CP17), `promises_rate` and `promised_amount` are in the contract.

## 10. Tests

- Findings: table tests per code and guard in `packages/domain` (`test/unit/agent-compare/`),
  mutation-checked: the interval test (point estimate instead, wrong end), the six-agent guard
  (removed, off by one), the leave-one-out, the smallest gap, praise without the interval and the
  per-agent cap each turn them red. Built.
- Contract: `packages/contracts/test/compare.test.ts` (the catalog's directions, gaps and floors,
  metric ids, the ref rule) and the compare codes' snapshot in `errors.test.ts`. Built.
- Saved views: `packages/db/test/integration/db/compare-views-migration.test.ts` (0063). Built. The
  repository and the routes: only the owner edits or deletes; a new default clears the campaign's
  old one in one transaction, also under concurrent saves; the 50-view limit, also under concurrent
  creates; a view's codes checked against its campaign's catalog
  (`apps/server/test/integration/agency/compare-view-repository.test.ts`, the views block of
  `compare-agents.test.ts`). Built, mutation-checked.
- An integration oracle: every value the read returns equals the roster's and
  `/agents/:userId/stats`' for the same campaign and window (as `report-datasets-oracle.test.ts`
  does for reports). Built: `apps/server/test/integration/api/compare-agents.test.ts` holds every
  figure to the seed and, where it serves the number, to `GET /agents/stats?campaign_id=` (the
  roster's own row for the campaign; `/agents/:userId/stats` has no campaign scope).
- Route: the `agent` role gets 403 (CP3); another account's agent is refused and never enters the
  cohort; the per-tenant limit returns 429; the flag off returns `403 feature_disabled`; an
  outcome code not in the campaign's current catalog, or `promises_rate` on a catalog without
  promises, is `compare_metric_invalid`; an outcome set's value equals Insights' count by code for
  the same agent and window. Built in the same file, with the statement timeout's 503 and the
  cache; the outcome set is held to the seed's count by code (the rollup Insights reads).
- Console: a withheld rate renders as words, never a bar; colour follows the person when one is
  removed; finding codes render the right words.
