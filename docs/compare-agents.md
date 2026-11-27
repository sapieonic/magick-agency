# Compare agents

A tab of Reports where a supervisor puts up to three agents of one campaign side by side, against
the rest of the campaign's agents, and is told what stands out. The metrics are not fixed: each
kind of campaign starts from a **lens** (a set of metrics), the supervisor can change it, and the
page draws each metric with the chart its shape calls for. Outcome metrics are the supervisor's
choice: any set of the campaign's outcome codes (CP17). Designed 2026-11-21 and reviewed
independently the same day; rulings CP1–CP18 below. **Phase 1 is built: the contract, the
rules, the saved-views table, the read, the routes and the console tab**, behind the flag
`agency_compare_enabled` (§9).

This file is the design and the build contract. Where it and another doc disagree about this page,
this file wins; where it reuses another area's read, that area's doc defines the number.

## 1. Rulings

CP1–CP7, CP17 and CP18 are Manas's answers of 2026-11-21 (CP18 the build's default, which he kept).
CP8–CP16 are the design's own recommendations, which he left without comment; they stand as
recommended (the convention of `agent-station.md` §1).

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
| CP17 | **Outcome metrics are the supervisor's choice.** Beside the built-ins, a metric can be an **outcome set**: 1 to 5 outcome codes of the campaign's current catalog, giving the share of the agent's conversations on the campaign ending in any of them (dialler conversations, from `agency_insights_rollup_codes`, as Insights counts them). The supervisor names it (default: the codes' labels, "A, B or C") and says which way is better: higher, lower or neither. A set of neither direction is shown and never named; a directional one is judged by the same interval rule as every rate (§6). A set can be the per-day trend (its count per local day) and is kept in saved views. A supervisor can build any such set, a "Will pay" set of the promise codes among them; the Collections lens starts on the built-in Promises (`promises_rate`, CP2: every call type), not on a set | **Decided** (Manas, 2026-11-21) |
| CP18 | **Direction comes from the supervisor.** The catalog has no refusal category (`AgencyDisposition` has `is_success`, no refusal flag), so a set's direction is never inferred, except that a set of success codes only starts as "higher is better"; any other set starts as "shown, never flagged" until the supervisor chooses. No lens starts with a lower-is-better set | **Decided** (Manas, 2026-11-21) |

## 2. The screen

Reports gains a tab, **Compare agents**, beside the existing ones. Top to bottom:

It is also opened from **Team performance** (`team-performance.md`, TP18): with one campaign, a
supervisor picks up to three rows there and **Compare picked** opens this tab with the campaign,
the window and the picks in the URL (`compareStateToParams`). That page uses this tab's
definitions number for number (TP2: the same roster statements, promise columns, rollup codes,
call-back classes, `compareValue` and `compareFindings`), so an agent's figure there is the figure
here for the same campaign and window.

1. **Filters in one row:** Lens, Campaign (one), When (a window of local dates, at most 30 days or
   exactly one calendar month, the reports rule `reportWindowProblem`), and **Metrics · N**, which opens the picker (at most 6,
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
5. **The lens's main outcome per working day** (the trend: promises for Collections, an outcome
   set or promises otherwise, §4) and **Where their day went** (on a call, choosing outcome, break, waiting; waiting in grey and never flagged).
6. **The numbers:** the table behind every chart.

Copy follows AS15. The state of the page (lens, campaign, window, agents, metrics by their ids,
`compareMetricId`) is in the URL, so a link opens the same comparison; a saved view (§4) holds the
lens, metrics and trend, never agents or a window. A link or view whose metrics a campaign cannot
show is applied without them, and the page says what was left out and why; when none can be
shown, it shows the lens's metrics and says so.

The console asks the query only with the options of the current campaign, window and zone (the
cohort changes with the window), holding it while a new window's options load, and only once the
picks have stayed still for 300 ms, so a burst of clicks is one read. A query still in flight when
a new window's options start loading, or once the picks have moved on, is cancelled, so a page
never has the options read and a query in flight together (the per-tenant limit is 2, §7); the
last answer stays on screen, marked as updating. The charts draw the picked agents the answer on
screen has; a pick still loading is not drawn until its figures come. When a read fails, the last
answer is never passed off as the new one: after a failed comparison it stays, labelled as the
last figures that loaded with their window; after a failed options read the charts are taken off.
Try again is offered only for a failure that can clear by itself (busy, timed out, 429, 5xx, the
network); a failure with no answer at all is worded by the console, never the browser. Today, the
window's presets and the date pickers' latest day follow the clock, so a page left open past
midnight moves on with it.

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
| Handling | No outcome chosen (`no_outcome_rate`) | lower | 4 points | rollup codes by agent (`agency_insights_rollup_codes`): a NULL code or `no_disposition`, the conversations the `no_outcome` facet counts (the facet carries no agent; §7 "As built") |
| Time use | On a call · choosing outcome · break · waiting | composition | | the roster's occupancy fold for the campaign (`foldOccupancy`, the roster's own `shift_seconds`; §7 "As built"), share of the shift (CP5); reserved is folded into waiting |
| Time use | Breaks over their limit (`breaks_over_limit`) | lower, against the limit | 2 breaks | `break_overrun_seconds` (0060, AS12) |
| Analysis | Each custom analysis question (yes/no → share, choice → mix, number → average); upset customer | shown only (CP13) | | completed analyses; the agent review's `quality` block for sentiment (phase 4) |

Outcome sets and `success_rate` follow the campaign's **current** outcome catalog, as Insights
does. A set names codes, so a code later removed from the catalog makes the set unusable on that
campaign (`compare_metric_invalid`); the console drops it from a saved view it applies, and says so.

## 4. Lenses

A lens is a starting set: fixed built-ins plus one slot for the campaign's **main outcome**, which
is also the per-day trend when it can be counted per day (`compareLensDefaults`,
`packages/domain/src/agent-compare/lens.ts`).

| Lens | Metrics | Main outcome (and trend) |
|---|---|---|
| Collections | calls handled, main, time to choose outcome, no outcome chosen, average call, breaks over limit | **Promises** (`promises_rate`): promises made on dialler, soft-phone and inbound calls (CP2), higher is better; also the trend |
| Sales | calls handled, main, call-backs booked, call-backs kept on time, average call, calls per hour | "Success": the `is_success` codes, higher is better |
| Verification and surveys | calls handled, calls per hour, main, no outcome chosen, average call, time to choose outcome | "Success", as Sales |
| New joiner (phase 2) | one agent against their own previous four weeks and the team median | the lens's main outcome |

Collections' main outcome is the built-in, not an outcome set over the `requires_promise` codes:
a set counts dialler conversations only (the Insights rollup, CP17), and will-pay counts promises
made on every call type that records one (CP2). A supervisor who wants a "Will pay" outcome set
builds it in the picker and can keep it in a saved view. More success codes than a set holds (5):
`success_rate`, which counts all of them (no trend), never a cut list. A catalog that records no
promises: Collections falls back to Success; with no success code either, Sales and Verification
(and Collections) leave the slot out. No lens starts with a lower-is-better set (CP18): a
supervisor who wants "Refused" adds it.

The campaign's starting lens (`compareStartingLens`): Collections when its outcome catalog has a
`requires_promise` entry, otherwise Sales. **Saved views** (`agency_compare_views`, 0064): a lens,
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
(`cohortPercentiles`, `percentile_cont`, which the roster's benchmark calls too), over the
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
(call-backs kept); a supervisor message (no outcome chosen, slow to choose). Where that view does
not exist yet the console opens the nearest one that does (§9, phase 1c; `CompareNextStep` in the
contract); the code's meaning stays.

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
in-process cache of the cohort's snapshot, keyed by what its SQL reads ("The caches" below)
(`COMPARE_TENANT_CONCURRENT_READS`, `COMPARE_READ_TIMEOUT_MS`, `COMPARE_CACHE_TTL_MS`). The options read counts against the same limit. Metrics: `agency_compare_read_seconds` (histogram), `agency_compare_reads_refused_total`.

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
  page's first 200. The statement also counts the measured wrap-ups `choose_time` divides by. So the
  cohort is who **dialled the campaign** in the window: an agent whose only work on it was soft-phone
  or inbound calls is in no cohort, and their promises are in nobody's baseline (the rest's pooled
  figure and band are over dialling agents only).
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
- **The trend's days** are the local days the agent's campaign sessions were online, each online
  span clipped to the window, to `left_at` and to now. A session row is not one stretch of logged-in
  time: a live session goes `offline` without `left_at` (the station closed or its heartbeat lapsed,
  a restart's `markAllOffline`, the dialler releasing it) and the next join reuses the row
  (`offline → break`, `joined_at` unchanged). So the spans come from the session's start and its
  offline boundaries only (events whose `to_state` or `from_state` is `offline`), on
  `idx_agency_session_events_offline` (0065, `(session_id, at)` partial), never the day's state
  changes the roster's occupancy statement walks. A day with a count that is not zero is a worked
  day too (`trendOf`), session or not: a promise taken on the soft phone (its session has no
  campaign) or on an inbound call matched to the campaign but answered from a station on another one
  is in the series and in that day's median. A server test plans the statement with its
  `OFFLINE_BOUNDARY_EVENT_SQL` and finds 0065's index in the plan.
- **Outcome codes** are the campaign's current catalog, or the default catalog when it stores none
  (`effectiveCatalog`, `agency/disposition-policy.ts`, which My day reads too). `success_rate` keeps
  the roster's rule (the stored catalog).
- **The caches** (30 s each): a query's **snapshot**, not its answer: the cohort's sources, keyed
  by what its SQL reads (`compareSnapshotKey`: tenant, account, campaign, window, zone, the sources
  the metrics need, the trend's id, and whose occupancy is read: the whole cohort when
  `calls_per_hour` is on screen, else the picked agents, sorted). Every request is answered from it
  for its own picks, metrics, labels and order (`compareAnswer`, pure; the cohort's names are in the
  snapshot), so a chip toggled with `calls_per_hour` on screen, a reorder of the chips or the
  metrics, or another metric of a source already read sends no SQL and takes no slot. Without
  `calls_per_hour` on screen a new pick is a new snapshot: its day split needs that agent's
  occupancy, and the whole cohort's statement costs 3.3 s on a busy month against 0.1 s for three
  agents ("Cost, measured"), so it is not read for every snapshot; and one answer's sources are never
  split across two snapshots. The options' cohort is cached on its own key (tenant, account, campaign,
  window, zone); the options' default view is read fresh every time, so a save shows at once. A
  snapshot or a cohort from the cache takes no slot. The caller's scope in the keys is the context
  account: the cohort is the account's roster whoever in the account asks.
- **Zones.** A zone must pass the cheap rules first (`isRequestZone`, `agency/zone.ts`, the
  reports' rule: `Intl`, trimmed, at most 64 characters); only then is Postgres asked whether it can
  cut days in it (`postgresZoneName`). A legacy zone name a browser's ICU reports (Chromium's
  `Asia/Calcutta` for India) that Postgres does not know is cut in its current name
  (`LEGACY_ZONE_ALIASES` and `currentZoneName` in `@magick-agency/domain/zone-clock`, the one table:
  the console maps the reader's zone by it too, when the browser knows the current name). The answer
  echoes the request's zone; the days are cut in Postgres's name for it.
- **Impossible counts are withheld** (`value` null, not reportable, no interval,
  `withheld: 'counts_disagree'`; the counts still served), as the roster does for `occupancy_pct`: a rate over its denominator (`promises_rate`
  counts promises when recorded and conversations when dialled) or `calls_per_hour` over a shift
  shorter than the calls' own talk and wrap-up. Such an agent is left out of that metric's band,
  pooled figure and findings.
- **Without `X-Account-Id`** every route answers `400 account_scope_required`, the floor routes' rule.
- **Slots.** At most 2 reads per tenant and a sixth of the pool in the process
  (`compareGlobalReadLimit`, 5 of the default 30), so compare can never take the connections the
  dialler needs; past either `429 compare_busy` with `Retry-After` and `retry_after_seconds`
  (`COMPARE_BUSY_RETRY_AFTER_SECONDS`), whose message ("Too many comparisons are running right now")
  is true of both limits. A slot belongs to a read that runs SQL: a cached answer, and a request that
  joins an identical query read already in flight, take none. A request never holds two pooled
  connections: the options route reads the campaign's default view only after the cohort's snapshot
  has ended, and memberships and names are read after it too.
- **Database CPU.** The read sets `max_parallel_workers_per_gather` to 1 for its own transaction
  (`COMPARE_MAX_PARALLEL_WORKERS_PER_GATHER`; Postgres's default is 2), so five reads at once take at
  most ten processes, not fifteen. Only the cohort's attempt statement runs in parallel: on the seed
  below, 1.30 s with no worker, 1.00 s with one, 0.90 s with two (7 days: 0.39, 0.28, 0.30 s); the
  whole cohort's occupancy statement never does.
- **The budget.** The whole read has 3 s (`COMPARE_READ_TIMEOUT_MS`), counted from before it takes a
  connection; a read sends one statement per source it needs. Its settings statement sets
  `statement_timeout` to what is left of the budget less 200 ms (`COMPARE_STATEMENT_TIMEOUT_MARGIN_MS`,
  or the session's own ceiling when lower), and before a later statement it is lowered again to what
  is left by then when that is lower by more than 50 ms. So Postgres ends a slow statement just before
  the deadline: `57014`, `503 compare_timed_out`, the transaction rolled back and the connection back
  in the pool to be reused, no cancel sent. The integration test holds that path: the read's backend
  lives on idle after the 503, and no cancel was recorded.
- **Stopping a read.** The deadline itself is the backstop (and stops a read between statements);
  the client going away is the other stop (its connection closes before the answer, or was already
  closed when the handler started, as when the console aborts a superseded read; a query read is
  aborted once no request waits on it). Either way the statement running is cancelled as
  `withCancellableRead` does it (`packages/db/src/utils/cancellable-read.ts`, whose note has the whole
  rule): on a connection of its own (`cancelBackend`), by the backend's own pid
  (`pg_backend_pid()`, never `processID`, a pooler's number behind the Supabase session pooler), the
  cancel awaited, no further statement sent, the connection destroyed rather than returned to the
  pool. Compare's options: a signalled statement still running a second after its cancel is
  abandoned with its connection; a cancel that could not be sent leaves the statement running until
  its own `statement_timeout`, so the slot is held until that bound has passed, plus the second. The
  report cursor runs through the same helper with its own options (a fixed bound, the role's ceiling,
  no grace). The cancel's connection and a destroyed connection's backend that is still finishing are
  counted in the Postgres connection budget (`operations.md`, "Sizing the media workers", *Postgres
  connections*).
- **Saved views' default.** An edit that does not send `is_campaign_default` keeps the view's value
  as read under the row's lock in the edit's own transaction (after the campaign's lock), never the
  value the route read before it: a rename cannot take the default back from another supervisor who
  set a new one meanwhile.

**Cost, measured.** On 930,000 attempts (two campaigns of 100 agents × 31 days × 150 dials) and
1.4M state events, `EXPLAIN ANALYZE` of each statement, a 31-day window, at Postgres's default two
parallel workers (the read now allows one: about 0.1 s more on the attempt statement, "Database CPU"
above): the roster attempt statement 1.3–1.5 s (a parallel scan of the window; `idx_agency_attempts_campaign_dialed` on a 7-day window,
0.5 s), the roster occupancy statement for the whole cohort **4.3 s** (every event of the window, its
window sort spilling to disk; 0.9 s on 7 days), the same for three picked agents 0.1 s, rollup codes
0.1 s, promises 0.03 s, call-backs 0.03 s, breaks over the limit 0.002 s on 0066's index (0.09 s and
28,000 buffers before it: every state change of the window), the trend's days 0.03 s (an index scan
of 0065 per session, 3,100 probes; walking the window's state events took 5.5 s). Measured again
for the snapshot cache (2026-11-21, the same seed): the cohort's attempt statement 0.98 s on 31 days
(0.39 s on 7), the whole cohort's occupancy 3.3 s (0.86 s on 7), three picked agents' 0.10 s (0.02 s
on 7); so the occupancy stays per pick unless `calls_per_hour` is on screen, and a cached snapshot
answers any pick it covers.
So on a campaign this busy a month with `calls_per_hour` on screen (the Sales and Verification
lenses) answers `503 compare_timed_out`; a week answers. That is the roster screen's own statement
and cost for the same window (it has no timeout); the trigger above is the remedy, or a narrower
default window on the page.
Accepted as it stands for now (Manas, 2026-11-21): no narrower window and no move to the
analytics child yet; revisit when supervisors meet the timeout, `agency_compare_read_seconds` and
`agency_compare_reads_refused_total{reason="timed_out"}` show it.

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

A figure that is not `reportable` says why in `withheld` (`AgencyCompareWithheld`,
`AGENCY_COMPARE_WITHHELD`: `too_few`, `none_due`, `counts_disagree`, `no_logged_in_time`; null when
reportable), set by `compareValue` and the read's counts-disagree step, so the chart and the table
word it the same. Additive: optional in the type, always sent by this server; the console reads a
recorded answer without it from its counts.

The rules both sides share are in `@magick-agency/domain/agent-compare`: `resolveCompareMetrics`
(a request's or view's refs against the catalog), `isCountableRef` (the trend rule), `compareValue`
(a metric's figure and why it is withheld), `compareCohortMetric` (`cohortPercentiles`, the roster
benchmark's `percentile_cont`, which the roster calls too), `wilsonInterval`, `compareLensDefaults`,
`compareStartingLens`, `compareFindings`.

## 9. Build plan and status

| Phase | Scope | Status |
|---|---|---|
| 1a | Contract (`compare.ts`, the error codes, the flag); `packages/domain/src/agent-compare/` (Wilson, percentiles, metrics, lenses, findings, mutation-checked); `agency_compare_views` (0064) | **Built** (2026-11-21) |
| 1b | The read, the routes and the saved views' repository, with the guards and the two metrics (§7 "As built", "Cost, measured"); figures held to the roster by the integration oracle. Review fixes: trend days from online spans (0065), a safe cancel and a whole-read deadline, a process-wide limit, the options' cohort cached, impossible counts withheld, legacy zone names, `Retry-After` on `compare_busy`, the saved views' lock order. Final review fixes: cancels by `pg_backend_pid()`, Postgres's timeout ending a slow read first (the connection reused), the slot held while an unsent cancel's statement runs, one parallel worker, one connection per request, worked trend days with a count, a rename keeping another supervisor's new default | **Built** (2026-11-21) |
| 1c | The console tab at `/agency/compare` (Reports' Compare agents tab, `agency.supervise`, the flag): the three lenses, the picker (built-ins and outcome sets), the agent chips, Side by side, What stands out (the words, Why this?, next steps, Not clear yet, Check a longer window), the trend, Where their day went, The numbers, saved views, the whole state in the URL. Run end to end against the real routes on a seeded database (every figure matched the seed; the review and end-to-end fixes are in). Three next steps open the nearest page that exists: the call log has no recorded-only filter, so the listening steps open the agent's placed calls in the window (narrowed to the outcome's codes); the agent record is not addressable by URL, so `open_breaks` opens Analytics, By agent; Call-backs filters by campaign, not agent, so `late_callbacks` opens the campaign's. Modules and tests in `modules.md` | **Built** (2026-11-21) |
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
- Console: the client, the URL state, the picker's limits (6 metrics, 5 codes, 3 agents), every
  finding code's words on every unit, every refusal's words, the chart geometry, the nav gate and
  the page (`modules.md`, `components/agency/compare/`), mutation-checked: the six-metric, five-code
  and three-agent limits, the colour slot, the nav gate and flag, the listening steps without
  listening rights, the dropped view metrics, the cohort-under-six note and the retry rule each
  turn them red; so do the query held for a new window's options, the 300 ms settle, a pick drawn
  before its figures come, a flag-only view change keeping unsaved edits, a likely range rounded
  onto its baseline, each metric's too-few reason and the lens fallback note. Built.
- Saved views: `packages/db/test/integration/db/compare-views-migration.test.ts` (0064). Built. The
  repository and the routes: only the owner edits or deletes; a new default clears the campaign's
  old one in one transaction, also under concurrent saves; the 50-view limit, also under concurrent
  creates; a view's codes checked against its campaign's catalog
  (`apps/server/test/integration/agency/compare-view-repository.test.ts`, the views block of
  `compare-agents.test.ts`); the lock order: an edit of the default view while another save holds
  the campaign's lock and clears that row waits rather than deadlocks; a rename that does not send the default keeps the
  row's value as it stands under its lock, also when the new default commits while it waits. Built,
  mutation-checked.
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
  cache; the outcome set is held to the seed's count by code (the rollup Insights reads). Also there:
  a session that never leaves, offline overnight and off a day (null that day); calls at 23:50 and
  00:10 local and just outside the window; the promises trend; a dropped client's statement cancelled
  by its backend's own pid (every pooled connection's `processID` set to a pooler's number) and its
  connection destroyed, asserted by the cancels recorded, not by time; the statement timeout's 503
  with its connection reused and no cancel; a promise on a day with no session on the campaign;
  `Retry-After`; a legacy zone answering as its current name. The guards' rules without a database
  (the deadline, the budgeted `statement_timeout` and its lowering, the cancel by
  `pg_backend_pid()`, the awaited cancel, the abandon, the slot held until the statement ends or,
  when the cancel was not sent, until its timeout bound, a throwing cancel, the process-wide limit,
  a shared read's joiner and last waiter, an already-gone socket):
  `apps/server/test/unit/agency/compare/compare-read-cancel.test.ts`; the snapshot cache (a pick
  change with calls per hour on screen, a reorder of picks or metrics: no SQL, no slot; a new source
  or a new pick without calls per hour: a new snapshot): `compare-read-cache.test.ts` and its key
  `compare-read-guards.test.ts`; the helper itself (the cancel once by pid, awaited, the connection
  destroyed, the grace, an unsent cancel's bound, a deadline's lowering):
  `packages/db/test/unit/utils/cancellable-read.test.ts` and, on Postgres, its ceilings and a real
  stop, `packages/db/test/integration/cancellable-read.test.ts`; the day statements given
  Postgres's zone name, not the request's: `compare-read-zone.test.ts`; the options route's order and
  a PATCH's unsent default, a zone looked up only after the cheap rules, the busy and timed-out
  bodies byte for byte: `test/unit/api/routes/proxy-agency-compare.routes.test.ts`; the trend
  days' plan on 0065: `test/integration/agency/compare-offline-index.test.ts`; the breaks over their
  limit on 0066: `compare-break-overrun-index.test.ts` and the db package's
  `session-events-break-overrun-index-migration.test.ts`; each withheld reason: the domain's
  `metrics.test.ts`, the console's `compareMetrics.test.ts` and `CompareNumbers.test.tsx`; the shared cancel with
  the pool exhausted, and never throwing: `packages/db/test/integration/cancel-backend.test.ts`; the
  report cursor's cancel by its backend's pid: `report-assembler-deadline.test.ts`. Mutation-checked.
