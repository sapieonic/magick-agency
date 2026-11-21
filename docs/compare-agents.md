# Compare agents

A tab of Reports where a supervisor puts up to three agents of one campaign side by side, against
the rest of the campaign's agents, and is told what stands out. The metrics are not fixed: each
kind of campaign starts from a **lens** (a set of metrics), the supervisor can change it, and the
page draws each metric with the chart its shape calls for. Designed 2026-11-21 and reviewed
independently the same day; rulings CP1–CP16 below. **Not built yet** (§9).

This file is the design and the build contract. Where it and another doc disagree about this page,
this file wins; where it reuses another area's read, that area's doc defines the number.

## 1. Rulings

CP1–CP7 are Manas's answers of 2026-11-21. CP8–CP16 are the design's own recommendations, which
he left without comment; they stand as recommended (the convention of `agent-station.md` §1).

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
| CP14 | **No custom ratios** typed in by supervisors | Decided (as recommended) |
| CP15 | **Exports through the existing report pipeline** (a report kind `agent_compare`, the renderer Lambda), not a new process | Decided (as recommended) |
| CP16 | **No Inbound lens** until inbound calls are in the rollup | Decided (as recommended) |

## 2. The screen

Reports gains a tab, **Compare agents**, beside the existing ones. Top to bottom:

1. **Filters in one row:** Lens, Campaign (one), When (a window of local dates, at most 31 days,
   the reports rule `reportWindowProblem`), and **Metrics · N**, which opens the picker (at most 6,
   grouped as in §3, each marked "higher is better", "lower is better" or "shown, never flagged").
2. **Pick up to 3 agents:** a chip per agent of the campaign; an agent under the floor carries
   "few calls". A colour follows the person: removing one agent never repaints the others.
3. **Side by side:** a small bar chart per metric (§5) with the team median, the middle half of the
   team and, on rates, the likely range.
4. **What stands out:** at most 5 findings (§6), each with **Why this?** and a next step; under them
   **Not clear yet (N)**, gaps that could still be chance, with **Check a longer window**; and the
   list of metrics on screen that are shown for context and never flagged.
5. **The lens's main outcome per working day** (phase 2) and **Where their day went** (on a call,
   choosing outcome, break, waiting; waiting in grey and never flagged).
6. **The numbers:** the table behind every chart.

Copy follows AS15. The state of the page (lens, campaign, window, agents, metrics) is in the URL,
so a link opens the same comparison.

## 3. Metric catalog

v1 uses only metrics a read serves today. "Later" rows wait for the phase named.

| Group | Metric | Better is | Read | When |
|---|---|---|---|---|
| Volume | Calls handled (conversations) | neutral | roster row | v1 |
| Volume | Calls per hour logged in | neutral | roster row ÷ `shift_seconds` | v1 |
| Volume | Connect rate | neutral | roster row (`rosterFlag` already refuses it) | v1 |
| Outcomes | Success rate (the lens names it: sale, verified) | higher | roster row `success_rate_pct`, gated by `success_rate_reportable` | v1 |
| Outcomes | Call-backs booked · kept on time | neutral · higher | agent record's follow-through (`agentCallbackTiming`, IN4 classes) | v1 |
| Handling | Average call | neutral | roster `talk_seconds` ÷ calls | v1 |
| Handling | Time to choose outcome | lower | roster `wrapup_seconds` ÷ measured wrap-ups | v1 |
| Handling | No outcome chosen | lower | rollup `no_outcome` facet, by agent | v1 |
| Time use | On a call · choosing outcome · break · waiting | composition | the agent review's presence fold (`reports/datasets/agent-presence.ts`), share of the shift (CP5); reserved is folded into waiting | v1 |
| Time use | Breaks over their limit | lower, against the limit | `break_overrun_seconds` (0060, AS12) | v1 |
| Outcomes | Share of calls ending *X*, one per outcome button | set by the campaign's catalog: success higher, a refusal-type code lower, any other neutral | `agency_insights_rollup_codes` by agent | phase 3 |
| Outcomes | Will-pay rate (promises ÷ calls) | higher | promise columns on the three call tables (CP2) | phase 3 |
| Outcomes | Amount promised | neutral | the same; no currency (PT5) | phase 3 |
| Analysis | Each custom analysis question (yes/no → share, choice → mix, number → average); upset customer | shown only (CP13) | completed analyses; the agent review's `quality` block for sentiment | phase 4 |

A lens's success-rate metric and the share-of-outcome metrics follow the campaign's **current**
outcome catalog, as Insights does.

## 4. Lenses

| Lens | Metrics | Main outcome per day |
|---|---|---|
| Collections | calls handled, will-pay rate, time to choose outcome, Refused share, average call, breaks over limit (until phase 3: success rate in place of will-pay and Refused) | will pay |
| Sales | calls handled, sale rate, call-backs booked, call-backs kept on time, average call, calls per hour | sales |
| Verification and surveys | calls handled, calls per hour, verified rate, no outcome chosen, average call, time to choose outcome | verified |
| New joiner (phase 2) | one agent against their own previous four weeks and the team median | the lens's success outcome |

The campaign's starting lens: Collections when its outcome catalog has a `requires_promise` entry,
otherwise Sales. Phase 2 adds saved views (personal or shared with the account) and a default view
per campaign.

## 5. Charts

| Metric shape | Chart |
|---|---|
| One value per agent | Horizontal bar per agent; the median as a line under the bars; the middle half (p25–p75) as a band; on rates a whisker for the 95% Wilson interval; value labels at the bar ends |
| Under the floor | No bar: "Too few to compare (12 calls; needs 20)" |
| Per working day | A line per agent, the team median dashed, end labels (phase 2) |
| A split of the shift | 100% stacked bar per agent; waiting in grey |

Drawn in SVG in the console, as `AgentBucketChart` is; no chart library. Agent colours are the
first three categorical slots; activity colours are a separate set, so a colour never means both a
person and an activity. The band and median are the roster's benchmark for the campaign, not a
second percentile implementation.

## 6. Findings

A pure function, `packages/domain/src/agent-compare/findings.ts`, over the read's values. It names
an agent only when:

| Code | Rule |
|---|---|
| `clear_gap` (rate) | the agent's rate passes the floor; the rest of the cohort's pooled rate is computed with the agent left out; the agent's 95% Wilson interval lies wholly on the worse side of it; and the gap is at least the metric's smallest gap (5 points for success-type rates, 6 for refusal shares, 4 for no outcome, 12 for call-backs kept) |
| `clear_gap` (time) | time to choose outcome at least 1.5 times the cohort median, with at least 20 calls |
| `over_break_limit` | two or more breaks over their reason's limit in the window |
| `stands_out` | the higher-is-better outcome rate whose interval lies wholly above the rest of the cohort's pooled rate by at least the smallest gap; offers "Share their best call" |
| `too_few_calls` | a picked agent under the floor on a flaggable metric; once per agent |

Guards: no finding until at least 6 agents of the cohort pass the floor; at most 3 findings per
agent and 5 in all, rates first; neutral and analysis metrics are never named. A gap on the worse
side that fails the interval (or a time from 1.25 to 1.5 times the median) goes to `not_clear`, which
the console lists under **Not clear yet**. When the agent is low on an outcome rate and slow to
choose an outcome, the time finding says it is worth asking whether the outcome buttons are clear to
them; it never states a cause.

Next steps (`next_step`), each a filtered view that exists: the call log for the agent (recorded
calls only, RC1; hidden without listening rights), the call log for the agent and one outcome, the
agent record's breaks, Call-backs filtered to the agent, a supervisor message.

## 7. Where it runs

The read runs in the primary (CP6). It composes reads that already serve screens, for at most three
agents and the campaign's cohort:

- `readAccountRoster` (`reports/datasets/shared.ts`) scoped to the campaign: the rows, the
  benchmark, the floor;
- the presence fold for the picked agents (`agent-presence.ts`);
- from phase 2, the agent's day rows (`agentAttemptDays`).

Guards: `SET LOCAL statement_timeout` of 3 s inside the read's transaction (the pool sets none by
default, `db-hygiene.md`); at most 2 compare reads at a time per tenant (429 past it); a 30 s
in-process cache keyed by tenant, the caller's membership scope, campaign, window, agents and
metrics. Metrics: `agency_compare_read_seconds` (histogram), `agency_compare_reads_refused_total`.

**Trigger for the analytics child:** the read's p95 above 1.5 s for a day, or `db_pool_acquire_seconds`
rising while compare reads run. Then the read moves to a child forked by the primary with its own
small pool, as `ANALYSIS_WORKERS` does, or to a read replica.

The interactive read is never a Lambda: the renderer has no database access by design (RP1).
Exports (phase 4) are a report kind `agent_compare` whose dataset is the same read's response; the
renderer Lambda draws the same charts.

## 8. Contract (sketch)

`packages/contracts/src/api/agency/compare.ts`; not a mobile vocabulary, so `literals.json` does
not change.

```ts
export const COMPARE_PAGE_MAX_AGENTS = 3;        // CP1
export const COMPARE_MAX_METRICS = 6;
export const COMPARE_MIN_RATED_COHORT = 6;

/** GET /proxy/agency/agents/compare — agency.supervise, flag agency_compare_enabled. */
export interface AgencyCompareQuery {
  campaign_id: string;                           // CP8
  agent_ids: string[];                           // 1..COMPARE_PAGE_MAX_AGENTS
  metrics: AgencyCompareMetricKey[];             // 1..COMPARE_MAX_METRICS
  from: string; to: string; timezone: string;    // local dates, both inclusive, as reports
}

export interface AgencyCompareValue {
  value: number | null;                          // null when withheld
  numerator: number;
  denominator: number | null;
  reportable: boolean;                           // the roster's floor
  interval: [number, number] | null;             // Wilson 95%, rates only
}

export type AgencyCompareFindingCode =
  'clear_gap' | 'stands_out' | 'over_break_limit' | 'too_few_calls';
export type AgencyCompareNextStep =
  'listen_recent' | 'listen_outcome' | 'share_best_call' |
  'open_breaks' | 'message_outcome_tip' | 'late_callbacks';

export interface AgencyCompareFinding {
  code: AgencyCompareFindingCode;
  agent_user_id: string;
  metric: AgencyCompareMetricKey;
  value: number; baseline: number;
  interval: [number, number] | null;
  next_step: AgencyCompareNextStep | null;
}

export interface AgencyCompareResponse {
  campaign_id: string; from: string; to: string; as_of: string;
  agents: {
    agent_user_id: string; agent_name: string | null;
    values: Record<AgencyCompareMetricKey, AgencyCompareValue>;
    day_split: { on_call: number; choosing: number; break: number; waiting: number }; // seconds
  }[];
  cohort: {
    agents_rated: number;
    per_metric: Record<AgencyCompareMetricKey,
      { p25: number | null; median: number | null; p75: number | null; pooled: number | null }>;
  };
  findings: AgencyCompareFinding[];              // at most 5
  not_clear: AgencyCompareFinding[];
}
```

Error codes go in `src/errors.ts` with the two-sided guard: `compare_campaign_required` 400,
`compare_too_many_agents` 400, `compare_too_many_metrics` 400, `compare_metric_unknown` 400,
`compare_window_invalid` 400, `compare_agent_not_in_campaign` 404, `compare_busy` 429.

## 9. Build plan and status

| Phase | Scope | Status |
|---|---|---|
| 1 | Contract; `packages/domain/src/agent-compare/` (catalog, Wilson, findings); the read and route (`proxy-agency-compare.routes.ts`, agency area, flag `agency_compare_enabled`); the console tab with the three lenses, the picker over the v1 rows, Side by side, What stands out, Where their day went, The numbers | Not started |
| 2 | Per-day series; saved and shared views and a default per campaign (`agency_compare_views`); the New joiner lens | Not started |
| 3 | A metric per outcome button; will-pay and amount promised (CP2) | Not started |
| 4 | Analysis questions as metrics (CP13); the `agent_compare` report kind and a weekly subscription to a saved view | Not started |
| 5 | Only if asked: a scatter of two metrics; across campaigns with expected against actual; the analytics child on its trigger | Not planned |

## 10. Tests

- Findings: table tests per code and guard in `packages/domain`, mutation-checked (break the
  interval test, watch them go red, restore).
- An integration oracle: every value the read returns equals the roster's and
  `/agents/:userId/stats`' for the same campaign and window (as `report-datasets-oracle.test.ts`
  does for reports).
- Route: the `agent` role gets 403 (CP3); another account's agent is refused and never enters the
  cohort; the per-tenant limit returns 429; the flag off returns `403 feature_disabled`.
- Console: a withheld rate renders as words, never a bar; colour follows the person when one is
  removed; finding codes render the right words.
