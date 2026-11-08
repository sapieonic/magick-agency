# Reports: agent, campaign and account exports

Performance reports as a PDF and an Excel workbook, built outside the dialer process, run ad hoc
or delivered on a schedule. This file is the design and the build contract: every workstream
follows it, and a change to it is a change to the contract. Decisions are RP1–RP16 below; the
ones marked **default, pending Manas** are the build's own calls from the 2026-11-08 design review
(D1–D9 on the design page) and are recorded in [`decisions.md`](decisions.md) §4 as well.

## Shape

```
console ──POST /proxy/agency/reports──► server (agency area, main process)
                                          │ insert report_runs (queued)
                                          ▼
                       assembler loop: claim run → build ReportDataset with the SCREENS' OWN reads
                                          │ (role-filtered) → S3 report-datasets/… (dataset.json,
                                          │  details-<sheet>.ndjson.gz)
                                          ▼
                  renderer = 'sqs':    SQS report-jobs ──► Lambda report-renderer (no VPC, no DB)
                  renderer = 'inline': apps/report-renderer called in process (dev, tests)
                                          │ reads dataset, writes report.pdf / report.xlsx to S3
                                          ▼
                       POST /webhooks/reports/rendered (HMAC, attempt-fenced) ─► run ready
                                          ▼
                       reports tick: notify (agency.report.ready email), reconcile lost
                       messages, subscriptions → runs, expire
                                          ▼
                       GET /proxy/agency/reports/:id/files/:format → { url } (5-min presigned)
```

## Decisions

| ID | Ruling | Status |
|---|---|---|
| RP1 | The server assembles the dataset with the reads the screens use (insights `compute*`, the agent record and roster through `callCore`, the same repositories); the renderer never touches the database. A Lambda reading RDS directly is later, once AWS deploys are automated. (D1) | default, pending Manas |
| RP2 | Window: at most 30 days, or exactly one local calendar month (stored cap 31 days + 1 hour, the hour a clock change adds). Same cap for every kind in v1. (D2) | default, pending Manas |
| RP3 | Zone: campaign report in the campaign's `default_timezone`; agent and account reports in the zone the request names (IANA, validated). No account time zone setting yet; the console defaults the form to the browser's zone. (D3) | default, pending Manas |
| RP4 | Scheduled recipients are members of the tenant only, re-checked against RBAC at send time. (D4) | default, pending Manas |
| RP5 | An agent may export their OWN review with the `self` audience: no floor benchmark, no call-analysis (sentiment) block or column, no recording column. Subscriptions are supervisors' only. (D5) | default, pending Manas |
| RP6 | Email carries a link to the console only, no attachments. (D6) | default, pending Manas |
| RP7 | Phone numbers in detail sheets are masked to the last four digits for the `self` audience and shown in full for `supervisor`. (D7) | default, pending Manas |
| RP8 | Retention: report files 90 days (`reports/` lifecycle), datasets 7 days (`report-datasets/` lifecycle). The run row is kept and turns `expired` at `expires_at`. (D8) | default, pending Manas |
| RP9 | Rate floors are served as each source serves them: agent rows and floor bands use the roster's 20 first dials, campaign and account figures Insights' 25; the definitions page names both. (D9, the open "25 vs 20" item) | default, pending Manas |
| RP10 | Reports live inside the agency module area (B4): config `agency.reports`, routes `proxy-agency-reports`, started from `bootstrap/agency.ts` in the main process only, metrics in the agency metrics file, flag `agency_reports_enabled`. | build |
| RP11 | Occupancy benchmarked against the floor is the roster's `occupancy_pct` ((talk + wrap-up) ÷ shift); the agent record's on-call ÷ shift (with and without breaks) is shown beside it, labelled. | build |
| RP12 | Detail sheets hold at most `AGENCY_REPORTS_MAX_DETAIL_ROWS` (100,000) rows each; past the cap the run is `truncated` and the sheet's first row says so. | build |
| RP13 | The render callback is applied only when its `run_id` and `attempt` match the row (fencing); the tick re-sends a run with no callback after `AGENCY_REPORTS_RENDER_TIMEOUT_MS`, up to `AGENCY_REPORTS_MAX_ATTEMPTS`, after first checking S3 for the files. | build |
| RP14 | A subscription produces one run per `(subscription_id, period_start)` (unique index); catch-up sends only the most recent missed period. Cadences: daily, weekly, monthly. | build |
| RP15 | The renderer is its own workspace app, `apps/report-renderer` (release-please component `report-renderer`), depending only on `@magick-agency/contracts`; one PDF path (React → HTML → headless Chromium via `puppeteer-core`), Excel via exceljs' streaming writer. | build |
| RP16 | Ad hoc runs email the requester only when the request sets `email_me`; the console shows readiness by polling. | build |

## Contracts (`packages/contracts`)

Console wire types in `src/api/agency/reports.ts` (also in the `AgencyApi` namespace); the dataset
and render protocol (shared by the server and the renderer) in `src/reports/` (barrel
`src/reports/index.ts`, exported as `@magick-agency/contracts/reports`, an explicit `exports`
entry ahead of `./*`). Literal unions are plain, each with an `as const` list (`REPORT_KINDS`,
`REPORT_FORMATS`, ...). None is a mobile vocabulary, so `literals.json` does not change. The files'
doc comments are the field-level contract; this section is the summary.

- `ReportKind = 'agent' | 'campaign' | 'account'`; `ReportFormat = 'pdf' | 'xlsx'`;
  `ReportAudience = 'supervisor' | 'self'`;
  `ReportRunStatus = 'queued' | 'assembling' | 'rendering' | 'ready' | 'failed' | 'expired'`
  (`REPORT_PENDING_STATUSES` = the first three); `ReportCadence = 'daily' | 'weekly' | 'monthly'`;
  `ReportFailureCode` (a run's `error.code`): `assembly_failed`, `subject_unavailable`,
  `dataset_unreadable`, `dataset_version_unsupported`, `render_failed`, `upload_failed`,
  `render_timed_out`; the renderer reports the middle four (`ReportRendererFailureCode`).
- Constants: `REPORT_MAX_WINDOW_DAYS = 30`, `REPORT_MAX_STORED_WINDOW_MS` = (31 × 24 + 1) h (RP2,
  the CHECK's cap), `REPORT_DOWNLOAD_URL_TTL_SECONDS = 300`, `REPORT_RUN_PAGE_DEFAULT_LIMIT = 25`
  / `_MAX_LIMIT = 100`, `REPORT_SUBSCRIPTION_MAX_RECIPIENTS = 20`, `REPORT_FORMAT_CONTENT_TYPES`.
- **Windows are local dates, both inclusive.** A request's and a run's `from`/`to` are
  `YYYY-MM-DD` in the zone; the server reads `[local midnight of from, local midnight after to)`.
  `reportWindowProblem(from, to, today?)` is the RP2 rule (≤ 30 days, or exactly one calendar
  month; `to` not after today), shared by the console form and the server.
- Error codes `AgencyReportErrorCode` with `AGENCY_REPORT_ERROR_CODES` (in `src/errors.ts` §5,
  re-exported by the wire file) and the two-sided guard and snapshot (`test/errors.test.ts`):
  `report_window_invalid` 400, `report_window_too_long` 400, `report_timezone_invalid` 400,
  `report_subject_not_found` 404, `report_queue_full` 429, `report_rate_limited` 429,
  `report_not_found` 404, `report_not_ready` 409, `report_expired` 410,
  `report_format_unavailable` 404, `report_subscription_not_found` 404,
  `report_subscription_invalid` 400, `report_recipient_invalid` 400. Body `{ error, code, message }`.
  Flag off: `403 feature_disabled` (the dialer gate's body), not a report code.
- `AgencyReportRun`: `id, kind, subject {id, name|null}, account_id|null, range {from, to,
  timezone}, formats, audience, status, requested_by {user_id, name|null}|null,
  subscription_id|null, created_at, finished_at|null, expires_at|null, files [{format, bytes}],
  truncated, error {code: ReportFailureCode, message}|null`.
- `AgencyCreateReportRequest`: `kind, subject_id, from, to, timezone?, formats, campaign_ids?,
  email_me?`. `timezone` is required for agent and account and ignored for campaign (RP3);
  `campaign_ids` is for `account` only (the agent review covers the whole account, as the record
  and roster do). `AgencyReportRunListQuery`: `cursor?, limit?, kind?, subject_id?,
  subscription_id?`. `AgencyReportRunPage`: `runs, next_cursor|null`. `AgencyReportDownload`:
  `url, filename, expires_at`.
- `AgencyReportSubscription`: `id, kind, subject {id, name|null}, account_id|null, cadence,
  send_local_time 'HH:MM', send_weekday 1–7|null (ISO, Monday 1), send_monthday 1–28|null,
  timezone, formats, recipients [{user_id, name|null}], enabled, next_run_at|null (null while
  disabled), last_run {id, status, period_start}|null, created_by {user_id, name|null},
  created_at`. Periods: daily the previous local day, weekly the seven days ending the day
  before, monthly the previous calendar month. `AgencyReportSubscriptionList {subscriptions}`;
  `AgencyCreateReportSubscriptionRequest` (`kind, subject_id, cadence, send_local_time,
  send_weekday?, send_monthday?, timezone?, formats, recipient_user_ids, enabled?`);
  `AgencyUpdateReportSubscriptionRequest` = a partial of it without `kind` and `subject_id`.
- `ReportDataset` = `AgentReviewDataset | CampaignReportDataset | AccountReportDataset`
  (`ReportDatasetOf<K>`), each with `dataset_version` (`REPORT_DATASET_VERSION = 1`),
  `run_id, kind, audience, generated_at, range {from, to, timezone, days, start, end},
  tenant {id, name}, account {id, name}|null, subject {id, name}, definitions [{key, label,
  text}], notes [string], detail_files [ReportDetailFile]` (`ReportDatasetBase`; `start`/`end`
  are the read window's instants, `days` the number of local days). Campaign and account
  datasets are `audience: 'supervisor'` by type.
  Blocks REUSE the existing wire types wherever a screen already serves the block, so the report
  cannot hold a second opinion about a number:
  - **agent**: `agent {user_id, name}`, `campaigns [{id, name, timezone}]`, `record`
    (`AgencyApi.AgencyAgentStatsTotals`, the console variant the proxy serves: occupancy
    optional), `roster_row` (`AgencyRosterAgentRowWithName`|null), `benchmark`
    (`ReportRosterBenchmark {cohort: AgencyApi.AgencyRosterBenchmark, pool_size}`|null, null for
    `self`), `occupancy {handling_pct, on_call_pct, on_call_pct_excl_break}` (RP11), `presence`,
    `daily` (one row per local day), `timeline` (the day with the most logged-in time, latest on a
    tie)|null, `outcomes`, `per_campaign` (`AgencyAgentStatsByCampaign` + `campaign_name`),
    `follow_through`, `quality`|null (null for `self`), `floors {agent_rate_min_first_dials}`.
  - **campaign**: `campaign {id, name, status, timezone}`, `summary`, `activity`, `trends`
    (`bucket: 'day'`; its `best_hours` is the hour-of-day block, so there is no separate hourly
    series), `health` (the Insights wire objects verbatim), `agent_names` (id → name|null, for the
    ids the Insights objects carry bare), `floors {campaign_rate_min_first_dials}`.
  - **account**: `account {id, name}`, `campaigns` (`AccountReportCampaignRow`: identity plus
    `AccountReportFigures {calls: AgencyInsightsCalls, callbacks_booked, abandoned, answered,
    abandoned_pct|null, recording_connected, recorded}`), `totals` (`AccountReportFigures` summed,
    rates recomputed from the sums), `agents` (roster rows with names), `benchmark`
    (`ReportRosterBenchmark`), `daily`, `health` (per campaign: `auto_pauses,
    stall_minutes_by_reason, concurrency_limit_minutes, carrier_failures, our_fault_retired,
    predial_blocks`), `floors {campaign_rate_min_first_dials, agent_rate_min_first_dials}`.
- `ReportDetailFile`: `sheet, label, key, rows, truncated, columns [{key, label, type}]` with
  `sheet: 'sessions' | 'state_log' | 'calls' | 'attempts'` (`REPORT_DETAIL_SHEETS_BY_KIND`: agent
  sessions, state_log, calls; campaign attempts, sessions; account attempts) and
  `type: 'text' | 'int' | 'number' | 'percent' | 'duration_s' | 'datetime' | 'date' | 'bool'`; the
  file is gzipped NDJSON, one JSON array of cell values per line, in `columns` order.
- `ReportRenderMessage` (SQS body): `run_id, attempt, dataset_version, bucket, dataset_key,
  output_prefix, formats, callback_url`; output at `${output_prefix}report.pdf|xlsx`
  (`REPORT_OUTPUT_FILE_NAMES`). `ReportRenderCallback`: `run_id, attempt,
  status 'rendered' | 'failed', files [{format, key, bytes}], error {code, message}|null,
  renderer_version`. Signed: header `x-mgkvc-report-timestamp` (unix seconds) and
  `x-mgkvc-report-signature` = hex HMAC-SHA256 of `${timestamp}.${rawBody}`
  (`reportSignaturePayload`) with `AGENCY_REPORTS_CALLBACK_SECRET`; refused outside ±300 s
  (`REPORT_CALLBACK_MAX_SKEW_SECONDS`).
- `reportFileName(kind, subjectName, from, to, format)` builds the download name, e.g.
  `agent-review_priya-s_2026-10-09_2026-11-07.pdf`.
- Flag `agency_reports_enabled` (`FF_AGENCY_REPORTS`, default off, global/tenant/account,
  client-exposed), registered in `apps/server/src/feature-flags/registry.ts`.

## Data (migration file 0023)

`report_runs` and `report_subscriptions` as on the design page (account_id nullable, the
31-days-plus-an-hour CHECK, `audience`, `claim_generation`/`claimed_at` for the assembler,
`render_attempt`/`sent_at` for the renderer, `files` JSONB, `truncated`, `dataset_key`,
`notified_at`, `expires_at`), the unique `(subscription_id, period_start)` index, a work index on
pending statuses, and one agent-first read index, `agency_agent_sessions (agent_user_id,
joined_at)`. No agent-first rollup index: the agent review's call figures come from the agent
record's attempt reads, and such an index drew the Insights allocation counters' campaign-first
plan off the unique index (`insights-reads.test.ts`). No roles.
Repositories in `apps/server/src/db/repositories/agency/report-run.repository.ts` and
`report-subscription.repository.ts`, from the `agency.repository.ts` barrel. Claims use
`WITH picked AS MATERIALIZED (… FOR UPDATE SKIP LOCKED)`.

## S3 keys

Derived on the server only, never from a client (the ingest-key lesson):
`report-datasets/{tenant}/{account|tenant}/{run}/dataset.json` and `…/details-{sheet}.ndjson.gz`
(lifecycle 7 days); `reports/{tenant}/{account|tenant}/{run}/report.pdf` and `report.xlsx`
(lifecycle 90 days). `{account|tenant}` is the run's account id, or the literal `tenant` for a run
with no account (none in v1). One module, `apps/server/src/agency/reports/report-keys.ts`; every id
must be a UUID (refused otherwise) and is written in lower case.

## Config (`agency.reports`, `config/blocks/agency.ts`)

| Env | Default | Meaning |
|---|---|---|
| `AGENCY_REPORTS_RENDERER` | `inline` | `inline` (in process, dev and tests) or `sqs` |
| `AGENCY_REPORTS_SQS_QUEUE_URL` | | required when `sqs` |
| `AGENCY_REPORTS_CALLBACK_BASE_URL` | | the server's public base URL, required when `sqs` |
| `AGENCY_REPORTS_CALLBACK_SECRET` | | ≥ 32 characters, required when `sqs` |
| `AGENCY_REPORTS_CHROME_PATH` | | Chromium for `inline` (else the renderer's own discovery) |
| `AGENCY_REPORTS_MAX_DETAIL_ROWS` | 100000 | RP12 |
| `AGENCY_REPORTS_ASSEMBLER_INTERVAL_MS` | 2000 | assembler poll |
| `AGENCY_REPORTS_TICK_INTERVAL_MS` | 60000 | tick |
| `AGENCY_REPORTS_RENDER_TIMEOUT_MS` | 900000 | RP13 |
| `AGENCY_REPORTS_MAX_ATTEMPTS` | 3 | RP13 |
| `AGENCY_REPORTS_RETENTION_DAYS` | 90 | `expires_at` |
| `AGENCY_REPORTS_TENANT_PENDING_LIMIT` | 5 | runs queued, assembling or rendering per tenant |
| `AGENCY_REPORTS_USER_PER_MINUTE` | 3 | ad hoc requests per user per minute |

## Datasets (`apps/server/src/agency/reports/datasets/`)

One builder per kind behind `REPORT_DATASET_BUILDERS` (`index.ts`): `buildAgentReview`
(`agent.ts`), `buildCampaignReport` (`campaign.ts`), `buildAccountReport` (`account.ts`), each
`(ctx: { run, now }) => { dataset, details }` (`types.ts`, the seam with the assembler). A builder
reads with `getPool()`; it throws `ReportSubjectUnavailableError` when the subject is not in the
run's tenant and account. RP1 is held by `test/integration/api/report-datasets-oracle.test.ts`,
which checks every block a screen serves against that screen's response for the same window,
fetched through `buildApp` + `inject`.

**The window.** A run's `[range_from, range_to)` (local midnights of `range.timezone`). Every
Insights read is served the range its route would serve for those two instants
(`insightsRangeFor`: the routes' own `parseInsightsRange`, so the same buckets; `to` stops at the
bucket "now" falls in, as on the tab). The agent record and roster reads take the window through
their handlers' own parsers (`parseAgentStatsQuery`, `parseRosterQuery`).

**Where each block comes from** (no figure a screen serves is computed a second time):

| Kind | Block | Source |
|---|---|---|
| agent | `record`, `per_campaign` | `agencyAgentStatsRepository.stats` (the read behind `/agents/:userId/stats` and `/my-stats`), `bucket=day`, the window |
| agent | `roster_row`, `benchmark` | `readAccountRoster` (`shared.ts`): the roster handler's read with the console's query (`sort=attempts`, `order=desc`, `limit=200`, no `campaign_id`), the route's membership scope (`scopeRowsToMembers`, now in `agency-agent-identity.ts`) and its names; departed agents kept (`include_inactive`) so a supervisor can review someone who left; `benchmark` null for `self` (RP5); `pool_size` = `cohort.agents_rated` |
| agent | `occupancy` | RP11: `handling_pct` = the roster row's `occupancy_pct`; `on_call_pct` = `record.occupancy` on-call ÷ shift; `on_call_pct_excl_break` the same over shift minus break |
| agent | `presence`, `daily` (time half), `timeline` | the shared occupancy intervals (`occupancyIntervalsCtes('agent')`, which now carry `session_id`), non-offline, folded in TypeScript (`agent-presence.ts`) into local days of `range.timezone` |
| agent | `daily` (attempt half), `presence.drops`, follow-through counters | `agentAttemptDays`: the record's join and `AGENCY_ATTEMPT_METRICS_SQL` grouped by local date, the rollup's measure expressions (`INSIGHTS_MEASURES`: redials placed and connected, reopened and manual dials, overrides, callbacks booked) and drops |
| agent | `outcomes` | conversations (`CONVERSATION_ATTEMPT_SQL`) by disposition code with the record's metrics; labels from each campaign's current catalog |
| agent | `follow_through.callbacks` (classes) | `agentCallbackTiming`: IN4's columns and CASE (`CALLBACK_BOOKING_COLUMNS_SQL`, `callbackClassSql`, shared with Insights) over the callbacks the agent booked, booked time in the window |
| agent | `dnc_marked`, `softphone_calls` | agent-written Do Not Call entries in the window (this account or tenant-wide); placed soft-phone calls (`created_at` in the window, Insights' rule, by agent) |
| agent | `quality` | supervisor only: analysed calls (`analysis_status = 'completed'`, `callSentimentLabelSql`) among the agent's placed attempts and soft-phone calls, one count per label the analysis emits (`positive`, `neutral`, `negative`, `mixed`; any other label is not counted); null when none |
| campaign | `summary`, `activity`, `trends`, `health` | `computeSummary` (with the route's `liveStats` through `callCore`; null when that fails, as on a refusal), `computeActivity`, `computeTrends` (`bucket: 'day'`), `computeHealth`; not through the routes' cache |
| campaign | `agent_names` | every id under `agent_user_id` / `user_id` / `never_joined` in the four objects (`agentIdsIn`), through `agentNamesOrNone` |
| account | campaign rows | per covered campaign: `computeActivity` (`calls`, `callbacks.booked`), `computeHealth` (`recording`, the health row), and abandoned / answered summed over the rollup's trend read (`agencyInsightsRollupRepository.trends`, the read `computeTrends` serves its buckets from) |
| account | `totals` | the campaign figures summed field by field (`sumCounts`), `abandoned_pct` recomputed from the sums with `ratePct` |
| account | `agents`, `benchmark` | `readAccountRoster` as the console asks it (departed agents dropped), the whole account whatever `campaign_ids` narrowed |
| account | `daily` | the rollup's trend read with `bucket: 'day'` and `timezone` = the REPORT's zone, per campaign, summed by date: the 15-minute UTC buckets re-bucketed into local days (DST aware; every zone offset is a multiple of 15 minutes, so no bucket straddles a local midnight); `agents_online_peak` null (a distinct count across campaigns is not measured, and a sum of per-campaign peaks would over-count) |

**Covered campaigns (account).** `run.campaign_ids` when set (each must be a campaign of the
account, else `subject_unavailable`); otherwise every campaign of the account with a rollup bucket
of dials in the window, or running, paused or stopping now; by name. They are read at most
three at a time (`ACCOUNT_CAMPAIGN_CONCURRENCY`).

**New definitions** (for blocks no screen serves; spelled in `agent-presence.ts`):

- *Logged-in time*: every non-offline second of the occupancy intervals, the agent's sessions in
  this account (campaign and soft phone), reserved folded into available. Whole seconds: each
  column is rounded across the days so the days sum to the window's rounded total
  (`roundPreservingSum`), and break reasons to the break total.
- *Day*: midnight to midnight in `range.timezone`; an interval crossing midnight is split there.
  `first_in` / `last_out` are the day's first and last logged-in instants, clipped to the day.
  `sessions`: sessions with logged-in time that day.
- *Drops*: the agent's placed attempts that ended `agent_disconnected`, by dial date.
- *Timeline*: the day with the most logged-in seconds (latest on a tie), from its local midnight
  to the next, clipped to `range.end` or to `generated_at` when earlier (the future is not drawn as
  offline time), `offline` in every gap, equal neighbours merged.
- *Conversations* on the agent's days are the record's `connected` (both count
  `CONVERSATION_ATTEMPT_SQL`), so `daily.conversations` always equals `daily.connected`; the
  campaign and account day rows are where the two differ.
- *Outcome rows*: `is_success` when any conversation of the code counted as a success in its
  campaign; `avg_talk_s` the agent leg of those conversations ÷ conversations, whole seconds.

**Definitions and notes.** `definitions.ts` holds each kind's definitions page in print order
(British English, final copy; the agent's `self` copy leaves out the floor comparison and
sentiment); each builder adds its notes (time from recorded state changes, reserved counted as
available, this account's sessions only, catalog relabelling, the day rule, rollup freshness, a
window running past `generated_at`, the `self` copy's omissions).

**Detail sheets.** Each source streams through `reportCursorRows`
(`db/repositories/agency/report-dataset-reads.ts`): a `DECLARE … NO SCROLL CURSOR` in a read-only
REPEATABLE READ transaction on a client of its own, 1,000 rows a fetch, released in `finally`
(destroyed after an error), acquired only when the first row is asked for.

| Sheet | Rows | Notes |
|---|---|---|
| agent `sessions` | the agent's sessions in the account overlapping the window | seconds per state in the window from the occupancy intervals, dials and drops per session |
| agent `state_log` | every non-offline state interval, clipped to the window | the state in words, break reason label, campaign or "Soft phone" |
| agent `calls` | placed campaign attempts reserved to the agent and placed soft-phone calls, by dial time | `self`: phone `****1234` (RP7), no Recorded or Sentiment column (RP5), the call table not read at all |
| campaign `attempts` | every placed attempt in the window | full phone, agent name (resolved per 500 rows), result, outcome code and label, talk (agent leg), measured wrap-up, caller ID, redial, callback |
| campaign `sessions` | every session on the campaign overlapping the window | the agent's sessions columns, the agent's name first |
| account `attempts` | every placed attempt of the covered campaigns | as the campaign sheet, with a Campaign column |

**Limits, stated.** The agent's `roster_row` is found in the roster read the console makes
(`limit=200` by attempts): on a floor of more than 200 dialling agents an agent below the 200th is
served `roster_row: null` and `handling_pct: null`. Whole-second rounding makes the days sum to the
window's ROUNDED totals: where the record serves fractional seconds (`talk_seconds`, the occupancy
block), Σ `daily.talk_s` and `presence.by_state` can differ from it by under a second. The
campaign report's summary reads the stats strip through `callCore`, so it needs the internal
handler instance the main process builds; without it the headline's live part is null (logged).

**Cost** (`test/integration/load/report-datasets-scale.test.ts`, opt-in `REPORT_DATASETS_SCALE=1
LOAD_SCALE=20`: one campaign, 1,000,000 attempts over 31 days by 50 agents, a state change every ten
minutes per agent; tables ANALYZEd; shared 4-CPU dev host, cold insights cache, best of two,
2026-11-08), a 30-day window: the agent review builds in 1.9 s, the campaign report in 1.0 s, the
account report (one campaign) in 2.9 s. Draining the sheets: the agent's 19,328 calls in 0.27 s and
4,321 state intervals in 0.06 s; the campaign's 967,284 attempts in 10.9 s (the assembler stops at
100,000), with the heap staying under 170 MB (rows are never held). An account with several
campaigns adds about one campaign's Insights reads per campaign, three at a time.

## Who may run what

- **agent**: `agency.supervise` over the context account → `supervisor` audience; otherwise the
  caller's own user id with `agency.station.connect` → `self` audience (RP5); else 403.
- **campaign**: `agency.supervise` and the campaign ownership probe (tenant and account).
- **account**: the subject is the context account; `agency.supervise` on it (account admin and up;
  tenant-wide admins on any account of the tenant).
- **subscriptions**: `agency.supervise`; every recipient must be a member with `agency.supervise`
  on the account (checked at create and again at send).
- **downloads**: only someone who could create the same run now, re-checked per download and
  audited `agency_report.downloaded`. A `self` review: the agent it is about (who requested it). A
  `supervisor` run: a caller with `agency.supervise` on the account now, whoever requested it; for
  a campaign run while the account still owns the campaign, for an agent run while the agent's
  membership reaches the account. Having requested a `supervisor` run is not enough: a supervisor
  demoted since still sees it in the history and on its page (`GET /reports/:id`; the run's
  metadata, never its contents), but each download answers `404 report_not_found`, the same
  refusal as a run the caller cannot reach.

## Pipeline (`agency/reports/`, routes, callback, email)

What W1 built, beside the contract above. Module detail and tests: [`modules.md`](modules.md)
(`apps/server/src/agency/reports/`).

- **Routes** (`api/routes/proxy-agency-reports.routes.ts` + `proxy-agency-reports/`, registered by
  the agency plugin). Guards in order: session, tenant context, the RBAC floor (runs
  `agency.station.connect`, subscriptions `agency.supervise`), the flag (`403 feature_disabled`,
  body `{ error: 'Feature Not Enabled', code: 'feature_disabled', message: 'Reports are not enabled
  for this account.' }`), then ids, body (the generic agency 400), reach over the subject ("Who may
  run what"; 403 without a code, or `report_subject_not_found`), zone, window, per-user rate,
  pending limit. A malformed, unknown or foreign run id is `report_not_found` (404), never 403. A run
  is visible (detail, history, retry) to its requester and to supervisors of its account; a download
  only to someone who could create the same run now (the agent for a `self` review; for a
  `supervisor` run a current supervisor, whoever requested it: "Who may run what"). Retry
  and run-now create AD HOC runs through the same checks as `POST /reports` (rate and pending limit
  included): retry keeps the parameters and `email_me` only when the caller is the requester;
  run-now covers `periodFor(cadence, now)` (the latest complete period), `email_me` on. A
  subscription PATCH recomputes `next_run_at` only when a schedule field (cadence, send time, day,
  zone) or `enabled` changes VALUE against the stored row, not when it is merely present (the
  console sends the whole schedule on every edit), so an edit to formats or recipients never skips
  a due send; its audit `details.fields` names only the fields that changed; a campaign subscription's zone is the campaign's current `default_timezone` (a `timezone` in
  the PATCH is ignored), and run-now cuts its period in the zone the run is stored with (for a
  campaign, the campaign's current zone). Audit
  actions (`platform_audit_log`, group "Reports"): `agency_report.requested` (`details.via`:
  `request`, `retry`, `run_now`), `agency_report.downloaded`, `agency_report_subscription.created`,
  `.updated`, `.deleted`.
- **Render callback** `POST /webhooks/reports/rendered` (`api/routes/webhooks/report-rendered.ts`),
  registered by `agencyWebhooksPlugin` in `agency.plugin.ts` beside the agency plugin (not inside
  it: everything the agency plugin registers is a session-guarded console route). Its own JSON
  parser keeps the raw body; HMAC verified before parsing; every answer counted in
  `agency_reports_callbacks_total`. In the app limiter's `webhook` bucket (`/webhooks/reports`
  prefix). With no `AGENCY_REPORTS_CALLBACK_SECRET` (inline) every callback is refused. The web
  image's nginx (`docker/nginx.conf`) proxies `/webhooks` to the server, so
  `AGENCY_REPORTS_CALLBACK_BASE_URL` may be the console's public origin.
- **One apply path**, `applyRenderOutcome` (`apply.ts`): the webhook, the inline renderer and the
  tick's reconcile all go through it (callback names the run and attempt; every key the run's own
  output key; a `rendered` result carries every requested format; then the attempt-fenced
  `applyRenderResult`). A callback for a run that no longer exists is `stale`.
- **Dispatch** (`dispatch.ts`): `sqs` sends the `ReportRenderMessage` JSON with
  `@aws-sdk/client-sqs` (region and keys from the `s3` block, else the SDK's default chain).
  `inline` loads `@magick-agency/report-renderer` with a dynamic `import()` of a non-literal
  specifier typed by the local `ReportRendererModule` (`renderRun(message, io, options)`; `io.writeObject(key, body, contentType, bytes)`),
  so the server's `tsc` never compiles the renderer's sources; the server must list the package as
  a dependency for the import to resolve, and until it does an inline render fails the run
  `render_failed` ("could not run"). Inline renders one run at a time; boot warns when `inline` runs
  with `NODE_ENV=production`.
- **Assembler** (`assembler.ts`): a run `assembling` with no dataset for 30 minutes
  (`REPORT_ASSEMBLY_STALE_MS`) is reclaimed; one claimed more than `AGENCY_REPORTS_MAX_ATTEMPTS`
  times fails `assembly_failed`. A failed run's stored message is generic copy; the error is logged
  with the run id only. Detail files are `application/gzip`.
- **Read timeouts (for the dataset builders).** The builder seam hands a builder no database
  client, and the builders read through the shared pool (the screens' own reads), so the assembler
  cannot run their statements under `SET LOCAL statement_timeout`. It bounds each builder call by
  wall clock instead (`REPORT_BUILD_TIMEOUT_MS`, 10 minutes): past it the run fails
  `assembly_failed` while the statements already sent finish on their own. Builders should keep
  each read bounded by its window and paging (detail sources by keyset pages, released in
  `finally` when the assembler calls `return()` at the row cap).
- **Tick** (`tick.ts`): each step handles at most 50 items a tick; a run assembled but unsent for
  5 minutes is sent; a run found rendered in S3 after a lost callback records `renderer_version =
  'reconciled'`; a HEAD that fails for any reason other than not-found is logged and counts as a
  file missing (re-sent under the attempt fence, or failed `render_timed_out` at the last attempt),
  so a `rendering` run is never stuck on S3 errors. Each due subscription's subject is probed at the claim
  (`subscription-subject.ts`, the builders' own `subject_unavailable` rule: the account exists; an
  agent's membership, any status, reaches it; the campaign is still the account's; an account
  report is about its own account): a subject that is gone DISABLES the subscription (no run, so no
  failure email every period). A campaign subscription's period, bounds and next send are cut in
  the campaign's CURRENT zone, read at the claim and written back to the subscription when it
  moved (a zone `Intl` cannot use keeps the stored one, logged). A subscription run that still
  fails `subject_unavailable` (the subject left between the claim and the build) disables its
  subscription in the assembler; that run's failure email is the last.
- **Email** (`notifications/agency-report-ready.ts`, template
  `notifications/templates/agency-report-ready.template.ts`): catalog event `agency.report.ready`
  (category `agency`, explicit audience, default on, so every role sees the toggle). Link
  `${CONSOLE_BASE_URL}/t/:tenant/a/:account/agency/reports/:runId`. Subjects: "Your agent review for
  … is ready", "Your scheduled campaign report for … is ready", "… could not be prepared". Counted
  per recipient in `agency_reports_emails_total` (`skipped` covers recipients without access, users
  who turned it off, a deleted subscription, no mail transport, and an already-claimed inbox).
- **Bootstrap**: `startReportPipeline` from `bootstrap/agency.ts` after the runtime starts, main
  process only, whatever the flag; stopped first on shutdown (assembler, tick, then the inline
  queue drains).

## Workstreams

| WS | Owns | Branch |
|---|---|---|
| F foundation | contracts (`src/api/agency/reports.ts`, `src/reports/`), flag, the 0023 migration + BASELINE, the two repositories and their integration tests, `agency.reports` config, `report-keys.ts`, S3 multipart/stream helpers in `storage/s3.ts`, metric declarations | `ccr-2d5a3f08-9lq4ms` |
| W1 pipeline | `agency/reports/` assembler, tick, render dispatch (SQS client, inline adapter), callback apply; `proxy-agency-reports` routes; the webhook route; audit vocabulary; `agency.report.ready` notification and email template; bootstrap wiring | `reports-w1` |
| W2 datasets | `agency/reports/datasets/{agent,campaign,account}.ts`, role filtering, detail row sources, oracle tests (report figure = screen figure) | `reports-w2` |
| W3 renderer | `apps/report-renderer` (templates, PDF, workbook, Lambda handler, zip build), release-please component, Dockerfile, CI browser | `reports-w3` |
| W4 console | API client, Reports page (history, subscriptions), export dialog, entry points (agent record, My stats, campaign Insights, account), flag gating | `reports-w4` |
| W5 infra | `aws/terraform/reports.tf`, IAM, lifecycle rules, Grafana alert rules | `reports-w5` |

Contract changes after F go through the orchestrator, never edited in a workstream branch.
