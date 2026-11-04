# Campaign insights

The Insights tab: one page per campaign that tells a supervisor or tenant owner the campaign's
whole health in every status. ClickUp ticket "Campaign insights page"; the data mapping and the
eight decisions (IN1–IN8 below) were signed off by Manas on 2026-11-04. The wire contract is
`packages/contracts/src/api/agency/insights.ts`; read its header first.

## Decisions (IN1–IN8)

| ID | Ruling |
|---|---|
| IN1 | Insights is a tab of the campaign shell at `/agency/campaigns/:id/insights` and replaces Overview and Performance; their URLs redirect to it. Agents, Contacts, Call attempts, Activity and Settings stay. |
| IN2 | Pacing history that was Prometheus-only (idle reasons, calling-hours deferrals, concurrency hits) is persisted per campaign per minute. |
| IN3 | No target date in v1; "pace vs needed pace" is dropped. |
| IN4 | A callback is kept on time when the follow-up dial is within 15 min of `callback_at`, late when after that, missed when never dialled or the contact closed first. |
| IN5 | One minimum-sample floor, 25, for every rate on the page. |
| IN6 | Attempts per contact counts every dial, wrap-up redials included (attempt rows). |
| IN7 | The launch checklist warns while calling hours are still the 09:00–20:00 default. |
| IN8 | The defects found during the mapping and the start-recording writes ship first, ahead of the page. |

## Shape

```
console Insights tab ──► GET /proxy/agency/campaigns/:id/insights/{summary,readiness,allocation,
                         activity,trends,health,uploads}   (agency.supervise, ownership probe)
                              │
        ┌─────────────────────┼────────────────────────────┐
  as-of-now reads       range reads (rollup)         pacing history
  agency_contacts        agency_insights_rollup        agency_campaign_pacing_minutes
  (covering index)       (recomputed from attempts)    (written by pacing, per minute)
```

**As-of-now numbers** (roster buckets, allocation, headline) read `agency_contacts` through a
covering index on `(campaign_id, state)` and the assignment index from 0010, in one statement per
section so every `reconciliation` block is computed at one instant.

**Range numbers** (calls, outcomes, agents, trends, caller IDs, recording) read a rollup, never the
attempt table. The rollup is a pure function of `agency_call_attempts`: a statement trigger marks
the 15-minute buckets an attempt write touches as dirty, and a background job (agency bootstrap,
leader only) recomputes each dirty bucket from the attempts in it. Recompute, never increment:
dispositions arrive after the call ends, the reaper rewrites outcomes, and an incremental counter
drifts the first time one path forgets it. Backfill is marking every bucket dirty. Freshness is
the `as_of` field on each range read.

**Pacing history** is aggregated in memory by the pacing leader per campaign per minute and
flushed as one additive upsert every 15 s (and when a campaign is given up, and at shutdown); the
events outside the tick (a wrap-up redial refused at the limit, an our-fault retirement) are one
single-row upsert each (`agency/pacing/pacing-history.ts`). It starts the day it ships;
`pacing_history_since` tells the page.

**Stalls** (`health.stalls`), computed from those minutes by
`AgencyInsightsPacingRepository.pacingHistory` (the rule is its module header): a minute is
stalled when at least half of its ticks on a running campaign dialled nothing; its reason is
`outside_calling_hours` when the campaign's own window was closed for at least half of them, else
the idle reason with the most ticks. Consecutive minutes stalled for the same reason are one
episode, cut at the range edges, open (`ended_at` null) while its last minute is the newest and
current. `concurrency_limit_minutes` counts the minutes with any `no_slots` tick, stalled or not.
The read returns at most the 500 newest episodes and says when it cut older ones
(`episodes_truncated`, not in the wire contract yet).

## Workstreams and ownership

Each runs in its own git worktree with its own `.test-env.local.json`. Migration numbers are
assigned here so parallel work never collides.

| WS | Owns | Migration |
|---|---|---|
| 0 foundation | `agent_reopened` on attempts, `dials_placed` on contacts and its trigger, the read indexes | 0011 |
| A defects and start-recording | stats `contacts_connected`, `created_by` from the actor, config-change and upload audit, stale comments | none |
| B rollup | the rollup tables, the dirty-bucket trigger and job, backfill, the range read functions | 0012 |
| C pacing history | `agency_campaign_pacing_minutes`, the pacing writer, redial-limit refusals, the reopen flag on attempts | 0013 |
| D console | the Insights tab, redirects, drill-down links, CSV, print stylesheet | none |
| E insights API | `proxy-agency-insights.routes.ts`, summary, readiness, allocation, uploads; then activity, trends, health on B and C | none |
| F drill-downs | list filters and totals so every number opens a list whose count matches | none |

## Drill-downs (WS F)

Every number links to the Contacts or Call attempts list (`apps/console/src/utils/agency/insights/links.ts`),
and both lists take `?include_total=1` (an exact `total`, counted with the list's own predicate), so the
list says "N contacts" / "N attempts" and that is the number clicked. The predicates are defined once, in
`apps/server/src/db/repositories/agency/drilldown-sql.ts` (re-exported from the repository barrel), and the
insights reads import them rather than respelling them:

- Contacts `waiting=due_now|retry|callback` (`waitingContactSql`), a partition of `pending`: due now is
  `next_attempt_at <= now()` (a due callback included); callback is later and waiting on a callback
  (`isCallbackSql`, the campaign's `callbackCodes`); retry is later and not a callback.
  `attempted=1|0` is `dials_placed > 0` (`attemptedContactSql`).
- Call attempts: `placed=1`, `dialed_from` / `dialed_to` (half-open on `dialed_at`, placed dials only,
  `dialedRangeSql`), `redial`, `agent_manual`, `agent_reopened`, `caller_id`, `outcome`,
  `disposition_code`, `agent_user_id` (through the attempt's session, `attemptAgentUserSql`). The list's
  own `from` / `to` stay inclusive on `created_at`; every insights link uses the `dialed_*` pair and
  `placed=1`.
