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
pending statuses, and two agent-first read indexes: `agency_insights_rollup_agents
(agent_user_id, bucket_start)` and `agency_agent_sessions (agent_user_id, joined_at)`. No roles.
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

## Who may run what

- **agent**: `agency.supervise` over the context account → `supervisor` audience; otherwise the
  caller's own user id with `agency.station.connect` → `self` audience (RP5); else 403.
- **campaign**: `agency.supervise` and the campaign ownership probe (tenant and account).
- **account**: the subject is the context account; `agency.supervise` on it (account admin and up;
  tenant-wide admins on any account of the tenant).
- **subscriptions**: `agency.supervise`; every recipient must be a member with `agency.supervise`
  on the account (checked at create and again at send).
- **downloads**: the requester, or anyone who could create the same run; re-checked per download,
  audited `agency_report.downloaded`.

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
