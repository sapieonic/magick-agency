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

IN9–IN12 (the waiting buckets, the connect rate, whose an allocation dial is, what "Lifetime" serves)
are the build's own calls where the mapping left a definition open, recorded in
[`decisions.md`](decisions.md) §4 as defaults pending Manas.

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
main process only, so once per deployment) recomputes each dirty bucket from the attempts in it. Recompute, never increment:
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
(`stalls.episodes_truncated`).

## The rollup (migration 0012)

**Tables.** Every row is keyed by campaign and a 15-minute UTC bucket of `dialed_at`
(`agency_insights_bucket()`, `date_bin` from 2000-01-01; `INSIGHTS_BUCKET_MINUTES` in the server).
Every measure is a count or a sum, so a range is the SUM of its buckets.

| Table | Key | Holds |
|---|---|---|
| `agency_insights_rollup_buckets` | campaign, bucket | the bucket's totals (every measure below), `source_updated_at` (the newest attempt `updated_at` folded in: "as of"), and the row the job locks |
| `agency_insights_rollup_agents` | + agent (`agency_agent_sessions.agent_user_id` of the reserved session; NULL without one) | every measure, per agent |
| `agency_insights_rollup_codes` | + agent, disposition code | conversations and dials per code, so successes and override grants are filtered by the caller's current code lists at read time |
| `agency_insights_rollup_facets` | + facet, key (+ agent for `override`) | `outcome` (dials), `caller_id` and `local_hour` (dials, connected), `no_outcome` (by wrap-up resolution), `override` (dials that spent an override, by the granting code) |
| `agency_insights_rollup_dirty` | append-only marks | "this bucket changed", written by triggers, deleted by the job |

**Measures** (`insights-rollup-sql.ts`), each spelled from `/stats`' definition and held to it by
`insights-rollup-oracle.test.ts`, which computes every read from the attempts with `/stats`'
own expressions:

| Measure | Definition |
|---|---|
| `dials` | every placed attempt (`dialed_at` in the bucket), wrap-up redials included |
| `connected` | `/stats` `attempts_connected`: `outcome = 'connected' AND redial_number = 0` |
| `conversations` | `CONVERSATION_ATTEMPT_SQL` (a redial chain once): the series' `connected` and the success denominator |
| successes | conversations whose code is in the caller's `successCodes` (the `successDispositionSql` predicate, with the catalog read by the caller) |
| `abandoned` / `answered` | `ABANDONED_ATTEMPT_PREDICATE_SQL` / `state = 'ended' AND answered_at IS NOT NULL` |
| talk, wrap-up, measured | `AGENCY_ATTEMPT_METRICS_SQL`'s: `ended_at - bridged_at` without orphans; measured wrap-up (`WRAPUP_MEASURED_RESOLUTIONS_SQL`), and how many; stored in microseconds |
| redials | placed (`redial_number > 0`), connected, chains at `AGENCY_WRAPUP_REDIAL_LIMIT` |
| agent retries | `agent_reopened` and `agent_manual` dials, and their connected |
| overrides used | `override_applied` non-empty; the granting code is the contact's latest dispositioned attempt before the dial |
| recorded | `connected` calls whose `agency_calls` row (`webrtc_call_id`) has a `recording_url` |
| callbacks booked | `callback_at` set, at the booking dial's bucket |
| human connects | conversations coded neither `voicemail` nor `no_disposition` (`/stats` `human_connects`) |
| no outcome | conversations coded NULL or `no_disposition` (`/stats` `unclassified_connects`), by wrap-up resolution |
| local hour | `dialed_at` in the contact's zone, else the campaign's, else UTC (an unresolvable name falls through) |

**Marking.** Statement triggers on `agency_call_attempts` (INSERT, UPDATE, DELETE) mark the old
and new bucket of every placed attempt the statement touched, once per bucket; row triggers with
WHEN clauses mark on `agency_calls.recording_url`, `agency_contacts.timezone` and
`agency_campaigns.default_timezone`. Marks are appended, never upserted (0012's header: an upsert
either loses a write or queues the dialler on one row lock). The overhead is ~85 µs per
single-row attempt UPDATE (BASELINE.md).

**The job** (`agency/insights-rollup-job.ts`, started by `bootstrap/agency.ts` in the main
process only): every `AGENCY_INSIGHTS_ROLLUP_INTERVAL_MS` (15 s) it claims up to
`AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE` (200) marks oldest first (`MATERIALIZED` + `SKIP LOCKED`),
collapses every other mark of those buckets, locks their header rows in key order, deletes and
rebuilds their rows from the attempts in one statement, and commits; it keeps batching while
batches are full, for at most half an interval. A failed batch rolls back with its marks. Two
jobs would only share the work. Metrics: `agency_insights_rollup_dirty_buckets`,
`_oldest_dirty_seconds`, `_recompute_seconds`, `_buckets_total`, `_failures_total`. Backfill is the
migration marking every bucket that has a placed attempt.

**Reads** (`agencyInsightsRollupRepository`, from the `agency.repository.ts` barrel). Each takes
`campaignId`, `tenantId` and a half-open `[from, to)` of bucket starts: pass 15-minute-aligned
instants (an unaligned `from` drops the bucket it falls in, an unaligned `to` keeps it). Each
returns null (or `[]`) for a campaign outside the tenant.

| Method | Returns | For |
|---|---|---|
| `activity({ successCodes, overrideCodes })` | calls (dials, connected, conversations, human connects, successes, by outcome with `null_outcome`, redials, agent retries, talk, wrap-up, measured, callbacks booked, recorded), outcomes by code, overrides by granting code and agent, no outcome by resolution, per agent, `reconciliation`, `as_of` | `activity` |
| `trends({ bucket, timezone, successCodes })` | every bucket zero-filled (dials, connected, conversations, successes, abandoned, answered; ISO instants, `YYYY-MM-DD` for day; hour and day in `timezone`, DST-aware), `best_hours` 0–23, the resolved zone, `as_of` | `trends` |
| `abandonmentTrend`, `callerIds`, `recording`, `carrierFailures` | per bucket abandoned/answered; dials/connected per caller ID; connected/recorded; `failed` dials | `health` |
| `asOf` | `as_of` and `pending_buckets` (marked, not yet recomputed) | every range section |
| `agentStateSeconds` | per agent: online, available (reserved folded in), on call, wrap-up, break by reason | `activity.agents` (not rollup: events) |
| `agentsOnlinePeak({ bucket, timezone })` | peak agents online per trend bucket, zero-filled | `trends` (not rollup: events) |
| `callbackTiming({ now })` | for callbacks whose booked time is in range: on time (follow-up dial by `callback_at` + 15 min, early included), late, missed, pending future and pending due, open and overdue by owner | `activity.callbacks` (not rollup: the callback index) |

**At scale** (`test/integration/load/insights-rollup-scale.test.ts`, `LOAD_SCALE=20`: one
campaign, 1,000,000 attempts over 30 days, 50 agents with a state change every 10 minutes; shared
dev host, best of three, 2026-11-04). The backfill marked 2,880 buckets in 0.8–1.0 s; the job drained
them in 62 s (15 batches of 200, the slowest 8.1 s); the rollup holds 2,880 headers, 143,856 agent
rows, 245,325 code rows and 41,672 facet rows. Lifetime reads: activity 250 ms, trends 241 ms
(quarter hour), 182 ms (hour), 155 ms (day), caller IDs 13 ms, recording 7 ms, carrier failures
9 ms, as-of 2 ms: each under the 300 ms budget, which the test asserts. With one campaign in the
tables the plans are parallel sequential scans; among several campaigns each read is a range of
its table's unique index (pinned in `insights-rollup-oracle.test.ts`). The reads that are not the
rollup scale with what they read: callback timing over a lifetime of 60,000 callbacks 1.6 s,
agent state seconds over 216,000 state changes 0.8 s, the online peak by day 1.9 s. Over the
page's usual ranges (a day, a week) they read a thirtieth or a quarter of that; over 92 days of
a large floor they are the slow sections.

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

## API (as-of-now reads)

Served by `apps/server/src/api/routes/proxy-agency-insights.routes.ts` (routes in
`proxy-agency-insights/`), assembled in `apps/server/src/agency/insights/` from
`apps/server/src/db/repositories/agency/insights-reads.repository.ts`. The roster buckets are one
definition, `insights-sql.ts`, for the summary and the contacts list's drill-down filters alike.

| Route | What | Cached |
|---|---|---|
| `GET /proxy/agency/campaigns/:id/insights/summary` | header, settings, status headline, roster | yes |
| `GET /proxy/agency/campaigns/:id/insights/readiness` | the draft checklist | no |
| `GET /proxy/agency/campaigns/:id/insights/allocation` | per-agent allocation, imbalance, at risk, history | yes |
| `GET /proxy/agency/campaigns/:id/insights/uploads` | committed uploads, newest first (at most 200) | no |

The range reads (`activity`, `trends`, `health`) are the next section.

**Guards, in order:** session and tenant context; `agency.supervise` (account admin and up; agents
and viewers get the RBAC 403); the dialer flag `agency_dialer_enabled` (`403 feature_disabled`, the
internal handlers' body); the id is a UUID (else `404 campaign_not_found`, the same body as an
unknown id); the ownership probe (tenant and account, its 404 forwarded). The contact-assignment
flag is not checked: pacing reads the stored `assignment_mode` and owners whatever the flag says
(CA9), so the allocation shows them as stored.

**Roster buckets** (a partition; each its own predicate, `insights-sql.ts`; the principal's rule,
which WS F's drill-down filters, `drilldown-sql.ts`, also follow): due now = `pending` and
`next_attempt_at <= now()`, a callback whose time has come included; callback = `pending`,
`next_attempt_at > now()`, latest disposition a callback code that is still the latest outcome
(`isCallbackSql`); retry = `pending`, later, not a callback (`COALESCE`d, so a connected contact
with no write-up is a retry). The three sum to the pending count. On a call = `in_flight`; in
wrap-up = `connected`; completed; exhausted; suppressed (`state = 'suppressed'`) by reason: DNC,
invalid, other. `attempted` = `dials_placed > 0` (decision IN6: a ringing first dial and an
our-fault dial count). `eta_seconds` is dialling time: pending contacts ÷ contacts dialled in the
last hour that are now finished × 3600, so the clock stops while the calling window is shut.

**Reconciliation identifiers** (`check`): summary roster `contact_states_vs_total` (the ten buckets
vs `count(*)`), `attempts_per_contact_vs_attempted` (1 + 2 + 3 + 4+ vs attempted),
`waiting_vs_pending` (due now + retry + callback vs pending contacts); allocation
`allocated_plus_unassigned_vs_total` (the agent rows and the pool, as served, vs the statement's
total), `agent_buckets_vs_allocated` (every owner's roster partition vs their allocation).

**Allocation dial counters** (`redials`, `retries_reopened`, `retries_manual`, `overrides_used`,
`last_activity_at`) are the rollup's per-agent rows over the campaign's lifetime
(`allocationCountersStatement`), attributed to the agent who PLACED the dial: the rollup's attribution and
the Call attempts list's `agent_user_id` filter, so each opens a list of exactly its dials. The contact
columns are by owner; in strict mode owners dial their own contacts and the two agree (the old per-attempt
query, by owner, is kept in `insights-reads.test.ts` as the oracle they were checked equal against). The
Unassigned row's dial counters are the dials with no reserved session; an agent who dialled without being
staffed or an owner gets a row (allocated 0), so the Total row is every dial. `last_activity_at` is the
agent's newest placed dial, exact to the dial and as fresh as the rollup: the newest bucket the rollup
holds for the agent, then the newest `dialed_at` among that one bucket's dials
(`idx_agency_attempts_campaign_dialed`, walked backwards).

**Readiness `detail` keys:** `roster_uploaded` `{ rejected, duplicates, dedupe_column }` (the
latest completed non-dry-run upload; nulls without one); `phone_column_mapped` `{ phone_column }`;
`outcomes_configured` `{ overrides }` (catalog entries carrying one); `calling_hours_set`
`{ window: 'HH:MM–HH:MM', timezone }`; every other check `{}`. Results: roster, phone column,
outcomes, caller IDs and staffed agents fail at none; calling hours warn while the window and the
days are still 0001's column defaults (09:00–20:00, Mon–Fri; IN7);
`contacts_allocated` passes in pool mode (count null), else counts open unassigned contacts and
fails in strict, warns in preferred; the abandonment clip warns when absent or retired; contacts on
DNC (pending contacts on a tenant-wide, account or campaign entry, the pre-dial gate's predicate)
warn above 0.

**Cost, measured** (1M-contact campaign in a 1.2M table, 900k attempts, 200k DNC entries; shared
dev host, warm cache): roster statement 0.56–0.9 s (the planner's parallel seq scan; a 200k
campaign is a Parallel Index Only Scan on `idx_agency_contacts_insights`, 0.12 s); allocation
statement 0.8 s; `allocationAttemptCounters` 1.1 s when it read every attempt (it now reads the rollup: "API (range
reads)", "Cost");
contacts on DNC 0.3 s; dial pace 0.04 s (`idx_agency_attempts_campaign_dialed`); the stats strip's
repository half 1.6–2.0 s. End to end: summary running 2.9 s, paused 0.8 s, stopped 1.3 s;
allocation 1.8 s; readiness 0.8 s. The retry preview itself (fingerprint DISTINCT) takes 5.0 s, so
`retry_matched` counts the same selection without it (0.3 s, the same answer; they differ only for
legacy rows with no stored fingerprint that duplicate one another).

**Cache** (`agency/insights/cache.ts`): in process (HTTP is served by one process, `scaling.md`),
single flight, keyed by section, campaign id, status and `updated_at` (a transition or a settings
edit misses), fresh for 5 s or four times the answer's compute time when longer (so one campaign's
insights keep the database busy at most a quarter of the time; a 1M running summary, measured at
2.5–2.9 s, is reused for ~10–12 s), at most 500 entries. The guards run on every request before it is consulted.

## API (range reads)

Served by the same family (`proxy-agency-insights/range.ts`), assembled in
`apps/server/src/agency/insights/{activity,trends,health}.ts`, the query parsed by
`agency/insights/range.ts`.

| Route | Params | What | Cached |
|---|---|---|---|
| `GET /proxy/agency/campaigns/:id/insights/activity` | `from`, `to` | calls, outcomes, callbacks, overrides, no-outcome, DNC marks, per agent | yes |
| `GET /proxy/agency/campaigns/:id/insights/trends` | `from`, `to`, `bucket` | the series (zeros included) with the online peak, best hours | yes |
| `GET /proxy/agency/campaigns/:id/insights/health` | `from`, `to` | abandonment, pre-dial blocks, caller IDs, stalls, concurrency minutes, carrier failures, recording | yes |

**Guards** are the as-of-now routes' chain, in the same order; the query is parsed AFTER it, so a
caller who may not read the campaign learns nothing from a 400.

**The range.** `from` / `to` are ISO-8601 instants with a zone (`Z` or `±HH:MM`), half-open. Both
absent is the lifetime: `created_at` to now, never refused for its length. One alone keeps the
other's default. Both ends are rounded OUT to the rollup's 15-minute bucket (`from` down, `to` up:
the rollup cannot cut inside a bucket, and the bucket a mid-bucket `to` falls in is counted anyway),
`to` never past the bucket now falls in, and the served range is echoed in `range`. Every zone's
offset is a multiple of 15 minutes, so a local-day range from the console is served exactly as
asked. `range.timezone` is the campaign's zone (trends: the zone Postgres resolved).

**`bucket`** (trends only): `quarter_hour | hour | day`; absent, `hour` up to 48 h and `day` beyond
(the console's default). A series is at most 92 days of quarter hours (8,832 buckets).

**Refused** `400 { error: 'Bad Request', code: 'invalid_insights_query', message }`
(`AGENCY_INSIGHTS_QUERY_ERROR_CODE`): a malformed instant (a bare date, a wall-clock time, a day
that does not exist), `from` not before `to`, a range starting in the future, a range wider than 92
calendar days (92 × 24 h plus the hour a clock change adds), an unknown or repeated parameter, a
`bucket` outside the list or on a read that takes none, a series over the bucket limit.

**Cache:** `insights/cache.ts`, keyed as the as-of-now sections plus the served range and bucket (a
"today" whose `to` is now hits the same entry for the rest of its 15 minutes). The range reads are
not polled; the cache shares one computation between supervisors and Refresh clicks, fresh for 5 s
or four times its compute time.

**Where each block comes from:**

| Block | Source |
|---|---|
| `activity.calls`, `outcomes`, `overrides`, `no_outcome`, the agents' dial columns, `reconciliation`, `as_of` | the rollup's `activity` read: ONE `REPEATABLE READ` snapshot, so every reconciliation is checked against the numbers served beside it |
| `calls.redials.refused_at_limit` | the pacing history |
| `calls.softphone_calls` | `agency_manual_calls` tagged to the campaign, placed, `created_at` in range (`idx_agency_manual_calls_campaign`) |
| `callbacks.booked` | the rollup (by the booking dial's time) |
| `callbacks` timing classes, `by_owner` | `callbackTiming` (IN4), the callbacks whose booked time is in range |
| `callbacks.open_due_today`, `open_overdue` | as of now: the allocation's totals, through the cache under the allocation's own key (the polled allocation and this read share one computation) |
| `activity.agents` state seconds, `never_joined` | `agentStateSeconds` (the occupancy intervals); never joined = staffed with neither state time nor a dial in range |
| `dnc_marked` | agent DNC entries scoped to the campaign, created in range (`idx_dnc_entries_tenant_created`) |
| `trends.buckets`, `best_hours` | the rollup's `trends` read; `agents_online_peak` from `agentsOnlinePeak`, joined on the bucket label |
| `health.abandonment.rolling_24h` | the guardrail's window for this campaign (`abandonmentWindowStatement`: ended, answered in the last 24 h; read as a day of the campaign's dials) |
| `health.abandonment.auto_pauses` | the guardrail's `agency_campaign.auto_paused` audit rows in range (at most 200) |
| `predial_blocks`, `concurrency_limit_minutes`, `our_fault_retired`, `stalls`, `pacing_history_since` | `pacingHistory` |
| `caller_ids`, `carrier_failures`, `recording` | the rollup |
| `health.analysis` | null: not served (no index-driven read of a range's analysed calls exists; a rollup facet or an index on `agency_calls (campaign_id, created_at)` would make one) |
| `pending_buckets` (all three) | the rollup's `asOf` |

Success and override-granting codes are the campaign's CURRENT catalog (`successCodes`,
`overrideCodes` in `insights/shared.ts`), so a catalog edit re-labels history.

**Activity reconciliation identifiers:** `outcomes_vs_dials`, `agents_dials_vs_dials`,
`agents_connected_vs_connected`, `outcome_codes_vs_conversations`,
`agents_overrides_vs_overrides_used`, `no_outcome_vs_unclassified_codes`.

**Contract changes made with these routes:**

- `running.concurrency_in_use: number | null`: null when Redis did not answer. E1's fallback (this
  campaign's live calls) is gone: a different number (one campaign, not the account) that, beside
  the account's limit, read as headroom that was not there.
- `stalls.episodes_truncated` (the newest 500 are served).
- Agent ids nullable: `activity.agents[].agent_user_id` and `overrides[].by_agent[].agent_user_id` are
  `string | null`, null being the dials with no reserved session. Null rather than a sentinel "no
  agent" row: a sentinel id would be sent as an `agent_user_id` filter (and refused as not a UUID),
  null is how `callbacks.by_owner` and `dnc_marked.by_agent` already spell "nobody", and keeping the
  row keeps `agents_dials_vs_dials` true.
- Callbacks: `pending` replaced by `pending_future` and `pending_due`, with IN4's definitions on the type.
- Freshness: `pending_buckets` beside `as_of` on all three; the page says "updating" above 0.
- "Connected": `calls.conversations`, `agents[].conversations`, `buckets[].conversations` added.
  `connected` is `/stats`' `attempts_connected` (outcome connected, not a redial), the CONNECT rate's
  numerator over dials; `conversations` (a redial chain once) is the SUCCESS rate's denominator. The
  console's `successRate` takes conversations. `calls.successes` added.

**Drill-downs, end to end.** `apps/server/test/fixtures/insights-drilldowns.json` lists every number
that opens a list, the list, and its params. `test/integration/api/agency-insights-drilldowns.test.ts`
seeds a campaign in every bucket, runs the rollup job, reads the sections through `buildApp` and checks
each list's `include_total=1` total equals its number; the console's `insightsDrilldowns.test.tsx`
checks its builders send exactly those params and the sections, rendered from that run's real
responses (`insights-responses.json`), carry the link. The "Connected" links send `redial=0`. Numbers
with no list whose total is theirs are not linked: callbacks due today (due before local midnight),
the callbacks' open-by-owner counts (booked in range, due ones included), the Unassigned row's dial
counters (dials with no session).

**Cost, measured** (`test/integration/load/insights-range-routes-scale.test.ts`,
`INSIGHTS_RANGE_SCALE=1 LOAD_SCALE=20`: one strict campaign, 1,000,000 attempts over 30 days by 50
agents on 200,000 owned contacts, ~60,000 callbacks, a state change every ten minutes per agent;
tables ANALYZEd as autovacuum leaves them; cold cache, best of three, shared dev host,
2026-11-04). The assembly below the guards, every read in parallel:

| Read | Lifetime (30 d) | Last 7 days | Its slow part |
|---|---|---|---|
| `activity` | 1.19 s | 0.70 s | callback timing 0.94 s / 0.28 s; agent state seconds 0.43 s / 0.43 s; the rollup read 0.11 s / 0.05 s |
| `trends` (day) | 0.97 s | 0.53 s | the online peak 1.05 s / 0.49 s (the rollup series ~0.2 s beside it) |
| `health` | 18 ms | 9 ms | none: rollup, pacing history (primary key), a day of dials |
| `allocation` | 108 ms | | the dial counters 32 ms (they replaced a 1.1 s read of every attempt) |

Every route is under 1.5 s at 1M over the lifetime, so nothing is narrowed: the slow reads run in
parallel with the rest and the answer is cached for four times its cost. They are the ones that
scale with the range (callbacks and state changes in it); over 92 days of a large floor they are
what grows. The campaign variant of the occupancy intervals plans as hash joins on analysed
tables (a seq scan of the events when one campaign is the whole table, `idx_agency_session_events_campaign_at`
among several, 0.40 s at 216,000 state changes): the nested-loop plan B saw on unanalysed tables
does not appear once statistics exist. The allocation counters' plan: the campaign's rollup agent
rows, then per agent one bucket of `idx_agency_attempts_campaign_dialed` walked backwards
(`insights-reads.test.ts` pins it).
