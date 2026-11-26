# Grafana: agency's alert rules and dashboard

Agency's alerting and dashboard, as a Terraform root module with its own state.
It is applied on its own and shares no resources with any other Terraform. It
also owns the stack's routing: every alert posts to one Slack channel; see
[Routing](#routing).

| Path | What it is |
|---|---|
| [`terraform/`](terraform/) | The root module: the folder **Magick Agency Alerts** (uid `magick-agency-alerts`), the alert rules, the dashboard |
| [`terraform/alert-rules.tf`](terraform/alert-rules.tf) | The 42 `agy-*` rules, as data (the newest, the `floor` group's `agy-station-drops-burst`, watches many working agents of one tenant losing their station at once; `agy-help-unanswered` before it watches the Need help requests left to expire unanswered; the `analysis` group's `agy-analysis-vendor-refusing` before it watches the post-call analysis worker's vendor rate limits; the `listen` group before it watches live call listening: the event loop's delay while listens are open, listener sockets closed for not reading, listens refused at the per-process limit and the listener tap's failures; the `inbound` group before it watches inbound calls on Plivo numbers: the answer webhook, failed and unanswered calls, the queue, connect availability, each tenant's Application and the rings to away phones; the `reports` group before it watches report runs, their pending age and the renderer's signed callback; the `carrier-credentials` group before it watches the tenant carrier credential keyring and sweep; `agy-pacing-share-starved` before it watches how the pacing round splits an account's slots between its running campaigns; the `insights` group before it watches the insights rollup job and the pacing history; runbooks in `docs/operations.md`, "Alert runbooks") |
| [`terraform/alerting.tf`](terraform/alerting.tf) | The folder, `local.agency` (the selector), the routing labels, and the one `grafana_rule_group` resource |
| [`terraform/routing.tf`](terraform/routing.tf) | The Slack contact point and the stack's notification policy |
| [`terraform/dashboard.tf`](terraform/dashboard.tf) | The dashboard resource (app-platform `grafana_apps_dashboard_dashboard_v1beta1`) |
| [`dashboards/magick-agency-overview.json`](dashboards/magick-agency-overview.json) | The dashboard (uid `magick-agency-overview`, classic model) |
| [`scripts/`](scripts/) | The validators, `pnpm test:grafana` |

## Apply

```bash
cd grafana/terraform
export AWS_PROFILE=<profile>                     # or any AWS credentials: the state is in S3
export GRAFANA_URL="https://magickagency.grafana.net"
export GRAFANA_AUTH="<service-account-token>"   # dashboards + alerting writer
export TF_VAR_slack_webhook_url="<slack-incoming-webhook-url>"   # where every alert posts
terraform init && terraform plan && terraform apply
```

**State is in S3 and separate.** This module's state is
`grafana/terraform.tfstate` in the same bucket as `aws/terraform`'s
(`magick-agency-terraform-state`, made once per AWS account by `aws/state`;
[`aws/README.md`](../aws/README.md), "State"), so any machine with AWS access
and the Grafana token can apply it, and a lock file stops two applies at once.
It is its own key, so it is planned and applied separately from anything else on
the stack and never sees other resources. Applying needs Terraform 1.10+ and AWS
credentials besides the token: `s3:ListBucket` on the bucket, and
`s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `grafana/*`. A machine
that applied before the backend existed moves its local `terraform.tfstate` up
once with `terraform init -migrate-state`, checks that `terraform plan` shows no
changes, then deletes the local file. Optional overrides are in
`terraform.tfvars.example` (gitignored once copied, so copy it across too).

The dashboard is locked in the UI unless `allow_ui_updates = true`. To change it,
edit in the UI, **Export → classic JSON**, commit it to `dashboards/`, run
`pnpm test:grafana`, and apply. Keep the uid: the alert annotations link to
`/d/magick-agency-overview`.

## Service names

Agency is selected by `agency_service_name_regex`, default `magick-agency(-.+)?`,
case-sensitive:

| Deployment | `OTEL_SERVICE_NAME` | `deployment` label |
|---|---|---|
| production | `magick-agency` | `production` |
| staging | `magick-agency-Staging` | `staging` |
| dedicated | `magick-agency-Dedicated` | `dedicated` |

`OTEL_SERVICE_NAME` is required for export. With `OTEL_ENABLED=true` but no
`OTEL_SERVICE_NAME`, the server starts no OTel SDK and logs a warning
(`apps/server/src/instrumentation.ts`), so an unnamed process never reaches
Grafana Cloud. A process that is not a deployment uses a name the regex does not
select (`.env.example` suggests `agency-dev-<you>`). Naming a dev box
`magick-agency` makes it production, and its criticals page. The `deployment`
label keys on the `-Staging` / `-Dedicated` suffix, so any other name the regex
selects is routed as production.

The dashboard's `service_name` variable lists only these names: its All value is
the same regex, and the validators keep the two equal.

## Routing

**This module owns the stack's routing** (`terraform/routing.tf`, decision B6
amended 2026-11-26). magickagency.grafana.net carries only agency, so the module
manages the Slack contact point **Magick Agency Slack** and the stack's
notification policy. The policy is a Grafana singleton: applying replaces the
stack's whole routing tree, so nothing else may manage routing on this stack.

Every alert, critical and warning, from every deployment, posts to one Slack
channel through an incoming webhook. The webhook URL is a secret and is passed
in, never committed:

```bash
export TF_VAR_slack_webhook_url="https://hooks.slack.com/services/..."
```

To move the alerts to another channel, make a new incoming webhook for it in
Slack, export its URL and apply.

The policy groups by `grafana_folder`, `alertname` and `deployment`, waits 30s
before the first message of a group and 5m between updates. Criticals are re-sent
hourly while they fire, warnings every 4 hours. The labels it reads:

| Label | Value | Used for |
|---|---|---|
| `severity` | `critical` / `warning` | criticals have their own route, re-sent hourly |
| `deployment` | templated from `service_name`: `-Staging` → `staging`, `-Dedicated` → `dedicated`, else `production` | grouping, so one rule's staging and production firings are separate messages. The template text is pinned by the routing test |
| `nightly_window` | `mute` (only on `agy-service-not-reporting` and `agy-error-log-volume`) | marks firings that are the staging and dedicated nightly shutdown. No mute timing uses it yet, so those post to Slack too |
| `service` | `agency` | shown in the message |
| `component` | the rule group | shown in the message |

The routing test in `scripts/validate-alerts.test.mjs` pins all of this:
- the label set and the `deployment` template text;
- that rules add no label but `nightly_window = "mute"`;
- that routing resources are declared only in `routing.tf`, with one policy,
  grouped as above, and a nested route on `severity = critical`;
- that the Slack URL is `var.slack_webhook_url`, declared sensitive, and no
  `.tf` file holds a literal webhook.

## Rules

Every expression selects `${local.agency}` and nothing else.

| uid | Reads |
|---|---|
| `agy-dnc-unavailable` | `agency_predial_gate_total{gate="dnc_unavailable"}` (the halt is a failed Postgres read of `dnc_entries`, decision B8) |
| `agy-pacing-share-starved` | `agency_pacing_share_withheld_total` by `campaign_id`, advancing for 10m while `agency_campaign_slots_in_use` reads 0. The counter alone measures contention (every campaign whose demand exceeded what it got while the account had headroom); withheld at 0 in use is starvation, since the fair share serves a campaign with no live call first (MC1–MC7 in `docs/decisions.md`). It can also fire with the share working, when more of an account's campaigns tie at 0 live calls than it has lines: raise the limit or run fewer campaigns at once (runbook in `docs/operations.md`) |
| `agy-telephony-lease-release-failure` | `telephony_lease_release_total{outcome=~"failure\|partial"}` |
| `agy-telephony-lease-release-fallback` | `telephony_lease_release_total`, `fallback` share |
| `agy-rate-limit-infra-rejected` | `rate_limit_rejected_total{bucket_kind=~"webhook\|carrier_media\|internal"}` |
| `agy-rate-limit-ip-rejected` | `rate_limit_rejected_total{bucket_kind=~"ip\|ip_auth\|user\|station"}`, the client buckets (no `tenant` bucket: no API keys, decision #5; `ip_auth` and `user`: Q9, amended 2026-11-01; `station`: the station socket upgrade) |
| `agy-firebase-auth-rejected` | `auth_attempts_total{method="firebase"}` |
| `agy-invite-email-failures` | `invite_emails_total{result="failed"}` |
| `agy-campaign-mail-failures` | `agency_campaign_notifications_total{result=~"failed\|threw\|claim_unavailable"}` |
| `agy-invite-claim-identity-conflicts` | `invite_claims_total` |
| `agy-error-log-volume` | Loki, ERROR/FATAL lines |
| `agy-service-not-reporting` | `nodejs_eventloop_utilization_ratio`, present in 7d, absent in 10m |
| `agy-event-loop-delay-p99` | `nodejs_eventloop_delay_p99_seconds` |
| `agy-metric-cardinality-overflow` | `{otel_metric_overflow="true"}` |
| `agy-cluster-child-crash` | `cluster_child_exits_total{expected="false"}`, with the new-series guard; the supervisor also records the series at zero when it starts |
| `agy-credential-keyring-missing-keys` | `telephony_credential_missing_key_ids` above 0: stored carrier credential secrets sealed under a master key `TELEPHONY_CREDENTIAL_KEYS` does not hold (B19). Set at boot and after each hourly sweep; pages |
| `agy-credential-sweep-failing` | `telephony_credential_sweeps_total{result="failed"}`, 2+ in 3h (the sweep is hourly), with the new-series guard; the housekeeping also records both results at zero when it starts |
| `agy-insights-rollup-failing` | `agency_insights_rollup_failures_total`, 10+ in 15m, with the new-series guard |
| `agy-insights-rollup-behind` | `agency_insights_rollup_oldest_dirty_seconds` above 120s (8 rollup intervals) for 10m |
| `agy-insights-rollup-stalled` | `agency_insights_rollup_recompute_seconds_count`, no committed batch for ~15m (a pass that never finishes freezes the backlog gauges) |
| `agy-pacing-history-write-failures` | `agency_pacing_history_write_failures_total` by `path`, 5+ in 15m, with the new-series guard |
| `agy-pacing-history-dropped` | `agency_pacing_history_dropped_total`, any, with the new-series guard |
| `agy-reports-pending-too-long` | `agency_reports_oldest_pending_seconds` above 900s for 10m: a report run queued, assembling or rendering for 25+ minutes, past one render re-send (`docs/reports.md`, RP13) |
| `agy-reports-failing` | `agency_reports_runs_total{status="failed"}`, 4+ in 1h, with the new-series guard |
| `agy-inbound-answer-fallback` | `agency_inbound_answer_seconds_count{result=~"fallback\|timed_out"}`, 2+ in 1h, with the new-series guard: callers told to try again |
| `agy-inbound-answer-refused` | `agency_inbound_answer_seconds_count{result="refused"}`, 5+ in 15m, with the new-series guard |
| `agy-inbound-calls-failed` | `agency_inbound_calls_total{outcome="failed"}`, 3+ in 1h, with the new-series guard |
| `agy-inbound-unanswered-share` | `agency_inbound_calls_total`: of the open-hours calls (answered, overflow, overflow_no_capacity, abandoned_in_queue, voicemail), the share that reached nobody above 0.5 over 1h, with a floor of 10 calls |
| `agy-inbound-answer-slow` | `agency_inbound_answer_seconds` p95 over 15m above 2s (half the 4s answer budget), with a floor of 5 answers |
| `agy-inbound-callers-unserved` | `agency_inbound_queue_waiting` above 0 for 15m with no `agency_inbound_offers_total` in the last 10m |
| `agy-inbound-connect-unavailable` | `agency_inbound_connect_available` at 0 (media workers on) while `agency_inbound_applications` counts a credential with inbound enabled; pages |
| `agy-inbound-application-broken` | `agency_inbound_applications{health=~"url_mismatch\|app_missing"}` above 0 for 5m (the scheduled health check, every 15m); pages |
| `agy-inbound-application-unchecked` | `agency_inbound_applications{health=~"unreachable\|failed"}` above 0 for 45m (three passes) |
| `agy-inbound-ring-push-failed` | `agency_inbound_rings_total`: of the rings to away agents' phones over 15m, the share `push_failed` above 0.2, with a floor of 5 rings (Mode B) |
| `agy-listen-loop-delay` | `nodejs_eventloop_delay_p99_seconds` above 40 ms (two 20 ms media frames) for 10m while `agency_listen_sessions_active` is above 0: the loop delays every bridged frame, and listening's cost (the tap runs after the relay's write, so it costs loop time, not relay dwell; docs/listening.md §10) is the first thing to rule out |
| `agy-listen-backlog-closes` | `websocket_send_backpressure_total{socket="listener",action="closed"}`, 3+ in 15m, with the new-series guard: supervisors' listener sockets closed `send_backlog` (past the 256 KiB cap, or 10 s of frames all dropped at the soft limit) |
| `agy-listen-grants-server-limit` | `agency_listen_grants_total{result="listen_limit_server"}`, any in 15m, with the new-series guard: a listen refused at `AGENCY_LISTEN_MAX_PER_PROCESS` |
| `agy-listen-tap-errors` | `agency_listen_tap_errors_total`, any rate sustained for 10m: the listener tap failing frames, or failing to open for a listener (never the call's own audio) |
| `agy-reports-callback-bad-signature` | `agency_reports_callbacks_total{result="bad_signature"}`, any in 15m, with the new-series guard: the renderer's and the server's `AGENCY_REPORTS_CALLBACK_SECRET` differ, or something else posts to the callback |
| `agy-analysis-vendor-refusing` | `dialer_analysis_rate_limit_consecutive_pauses` above 7.5 (the worker's `PERSISTENT_RATE_LIMIT_PAUSES`, pinned by the validator), filtered to deployments whose `dialer_analysis_rate_limit_pauses_total` rose in 25m (each analysis process holds its own gauge until a job of its own completes): ~45 minutes of every analysis probe refused by the AI vendor, a quota or billing stop; warns |
| `agy-help-unanswered` | `agency_help_requests_cleared_total{reason="expired"}`, any in 30m, with the new-series guard: an agent's Need help (raised from any state, BE-9) went 15 minutes with no supervisor answering; supervisors see it on every console page (`GET /proxy/agency/floor/alerts`, AS16) |
| `agy-station-drops-burst` | `agency_station_disconnects_total` by `tenant_id`, 5+ in 5m, with the new-series guard: many working agents of one tenant lost their station at once (a network, ingress or deploy problem; BE-11). By tenant, the dialer's label convention: the account is in the floor's `disconnected` alerts |

**Re-baseline `agy-error-log-volume` after the pilot.** It starts at 10+
ERROR/FATAL lines in 15m because agency has no production history. Read
the per-15m peaks of the pilot's first weeks, then move the threshold. Use
count − 1, since `count_over_time` is exact.

**No rules for:**
- Billing (decision S6): there is none. The validators red if agency declares
  `agency_attempt_batches_total`, `agency_attempt_batch_attempts_total`,
  `agency_attempt_settlement_failures_total`, `settlement_dispatch_total` or
  `webhook_fanout_abandoned_total`.
- DNC sync and outbox (B8).
- API keys (#5).
- Purchased-concurrency sync.
- Notification sends: `notification_sends_total` is declared but nothing
  increments it.
- The Grafana Cloud stack itself (usage, ingestion limits): that watches the
  stack, not a service, and is managed outside this repo.

## Dashboard

**Magick Agency — Overview**: every query carries `deployment_environment=~"$environment"`
and `service_name=~"$service_name"`. The rows:
- **Agency dialer**: live attempts by state, 24h abandonment, throughput,
  pre-dial gate outcomes, settled attempts by outcome, where seat time goes,
  hold time, answer latency, late bind, answer to audio connected
  (`agency_answer_to_bridge_seconds` p50 / p90 / p99 by carrier against the default 3 s
  grace, and the share of the last hour's bridged calls past it; a campaign set to another
  grace, 1–5 s, is judged by its own; no rule yet; `pnpm test:grafana` holds the panel to
  `DEFAULT_ABANDONMENT_GRACE_MS`), abandonment
  causes, wrap-up,
  our-fault retirements, campaign-completion emails; the insights rollup
  (backlog and oldest dirty mark, batch duration, batches, buckets and
  failures) and pacing-history write failures and drops; the pacing share
  (each campaign's slots in use against slots allocated, set only after a
  contended report to the split, and the slots the fair-share rule withheld
  from it, a measure of contention, MC1–MC7).
- **Inbound calls**: calls ended by outcome, the answer webhook by result and its p95, callers
  waiting and offers by result, wait time p50 / p95 by how it ended, the open-hours share that
  reached nobody, and connect availability with the Applications' health.
- **Agent station**: breaks over their limit by tenant (`agency_break_overruns_total`, BE-12),
  stations dropped while their agent was working by app and state
  (`agency_station_disconnects_total`, BE-11) and the time to reconnect, p50 / p95 by app
  (`agency_station_reconnect_seconds`).
- **Reports**: runs finished by kind and status, pending runs by status and the
  oldest one's age, assembly and render duration p95 by kind, and render callbacks,
  report-ready emails and subscription runs by result.
- **Compare agents**: a read's duration p95 by read (query, options) and result
  (`agency_compare_read_seconds`), and reads refused per minute by reason, busy or timed_out
  (`agency_compare_reads_refused_total`). No rule: they are the trigger in
  `docs/compare-agents.md` §7 for moving the read off the primary, not a service fault.
- **Live call listening**: sessions open and grants by result, sessions ended by reason, session
  length, the tap's errors by stage with the listener sockets' back-pressure, the media relay's
  per-frame dwell by direction (p50 / p99, sampled one frame in 50), and listener socket handoffs to
  media workers.
- **Voice, capacity and storage**: WebSockets, telephony lease release,
  provider concurrency admission, rate-limit rejections, S3, the carrier
  credential keyring and sweeps, carrier dial refusals.
- **Recordings**: recording fetches that did not return the audio by surface (playback, analysis),
  provider and reason (`recording_fetch_failures_total`, RC3), and recordings discarded because
  the call did not ask for one, by provider (`recording_discarded_unrequested_total`, RC1). No
  rule: a failing recording is one call's, and VoiceLink's discards are expected (RC2).
- **Identity and mail**: sign-in attempts; invite emails and claims.
- **Analysis**: dialer analysis and its latency.
- **Runtime and telemetry**: event-loop delay and utilization, heap,
  cardinality overflow, feature flags, ERROR/FATAL logs (Loki).

## Known metric gaps

Agency does not emit these, so it has no rule or panel for them. Each needs a
metric in `packages/observability/src/metrics/` first:

- `api_requests_total` / `api_request_duration_seconds`: no 5xx ratio, API
  latency, request rate or status-mix panels or rules.
- `call_dial_failures_total`: no carrier dial-failure rule. `carrier_dial_refusals_total`
  (by `provider` and `kind`; Plivo only, counted in its adapter) has a panel and no rule yet:
  it needs a production baseline first, and VoiceLink does not count into it.
- `webhook_signature_rejected_total`: no carrier signature-refusal rule.
- `media_stream_connect_timeouts_total`: no media-timeout rule.
- DNC registry writes: nothing counts them. The rollback-window DNC mirror that
  will use `agency_dnc_outbox` is not built yet.
- `notification_sends_total` is declared but never incremented.
- `websocket_connections_active` counts only the bridge's carrier leg
  (`webrtc_pstn`); the browser leg and the station socket are not instrumented.
- `agency_campaign_slots_in_use`, `agency_campaign_slots_allocated` and
  `agency_pacing_share_withheld_total` carry only `campaign_id`: no tenant or
  account label, so the Pacing Share panels ignore `$tenant_id` and cannot
  group the campaigns that share one account's limit. Read them one account's
  campaigns at a time. The two gauges are set only after the campaign reports
  demand to a contended split (two or more of its account's campaigns
  contending) and cleared on every other tick outcome, so a campaign running
  alone has none.

## Validators

```bash
pnpm test:grafana
```

`scripts/metric-declarations.mjs` reads every `*.ts` in
`packages/observability/src/metrics/`, the facades, the runtime allow-list,
drop views and heap gauge in `apps/server/src/utils/otel-sdk-config.ts` /
`instrumentation.ts`, and the installed runtime-node's instruments in
`apps/server/node_modules`, so it needs `pnpm install`. It cross-checks
`packages/observability/test/fixtures/agency-otlp-instruments.json`, and reds on
an OTel instrument created outside the facades.

`validate-alerts.test.mjs` checks the rules:
- every metric and label is declared and reaches OTLP, and no retired billing
  series is used or declared;
- `{{ $labels.x }}` placeholders survive the aggregation;
- groupings keep `service_name` and drop `instance`;
- pending periods are sound, and every firing `increase()` carries the
  new-series guard (a counter's first sample is invisible to `increase()`);
- an `lt` (heartbeat) rule reads an absent series as no data, never as 0;
- uids are unique and `agy-`;
- agency's selector only;
- the routing contract above.

`validate-dashboard.test.mjs` checks the dashboard the same way, plus the 1m Min
step and 5m windows the 60s OTLP export needs, agency-only scoping, and the
first-increment arm on every `rate()`/`increase()` over `agency_answered_total`,
`agency_abandoned_total` and `agency_abandoned_reason_total`, in the one structure that
counts it (below; the test runs fixtures that must pass and fail through the same check),
and that the Answer → Audio Connected panel's `le` bucket, threshold and the grace its text names are
`DEFAULT_ABANDONMENT_GRACE_MS`, read from `packages/domain/src/abandonment-predicate.ts`, and that its
title and text say it is the default (a campaign may set 1–5 s and is judged by its own, AG2).

## Counting a sparse counter's first increment

Agency's counters and histograms reach Grafana Cloud over OTLP with cumulative
temporality, and a series exists from its first increment or observation: its first
sample already holds every event of its first 60 s export, usually 1. `rate()` and
`increase()` count growth after their first sample, so those events are never
counted. A series is new more often than its own labels suggest: every series also
carries `service_version` (the server's version, a resource attribute), so each
release starts every counter and histogram afresh, for every label set, besides each
new `campaign_id` or other label value. On 23 Nov on Staging
`increase(agency_abandoned_reason_total[16h])` summed to 7 where the counters held 11
(four new series), and `agency_abandoned_total` read 8 of 11 (three series).

What that costs depends on how many events a series holds:
- **The three counters reconciled against SQL** (`agency_answered_total`,
  `agency_abandoned_total`, `agency_abandoned_reason_total`): a series per campaign,
  and a handful of events in each, so the loss is a large share. They get the arm below.
- **Every other counter panel** loses one export's events per label set at each
  release, and per new label value. At today's volume many of agency's series are
  sparse, so expect a dip in the window after a release on those panels; they show
  trends, and they keep plain `rate()`.
- **Histograms** lose the observations of each label set's first export after a
  release from their quantiles. `agency_answer_to_bridge_seconds` (tenant × provider)
  misses the first bridge of each tenant and carrier after each release from its
  p50 / p90 / p99: small at a release every few days. Its share over the grace reads
  a rolling hour with the arm, so it does not.

- **Alert rules**: every firing `increase()` carries the new-series guard
  (header of `terraform/alert-rules.tf`), and the validator holds them to it. No
  rule reads the abandonment counters.
- **Dashboard**: Throughput (answered, abandoned) and Abandonment Causes read
  `X` (with the panel's matchers) as

  ```promql
  (rate(X[$__rate_interval]) and X offset $__rate_interval)
  or ((max_over_time(X[$__rate_interval]) unless X offset $__rate_interval) / ($__rate_interval_ms / 1000))
  ```

  A series that existed a window ago goes through `rate()`; one born inside the
  window started at 0, so its whole value is its events, spread over the window as
  `rate()` spreads the rest. Integrated over the same 16h of 23 Nov, the causes read
  ~11 of 11 where plain `rate()` read 7, abandoned ~10.8 of 11 and answered ~121.7 of
  123: a series' second increment that lands inside its first window is counted only in
  part at the hand-off between the two arms. For an ad-hoc total over a range `R`, sum
  `(increase(X[R]) and X offset R) or (max_over_time(X[R]) unless X offset R)`; a rate
  over a fixed range divides the new-series arm by its seconds (`/ 3600` for `[1h]`).
  `pnpm test:grafana` holds every `rate()` / `increase()` over the three counters to
  exactly this structure.
- **What the arm cannot fix**: a series born and then reset by a restart inside one
  window counts only its larger part; across a restart, a series whose new value is
  at or above its old one reads as `new − old` (no reset is seen); an export gap of
  more than 5 minutes just before the window makes an old series look new.
- **The fix for all of it is a stack setting, outside this repo.** Grafana Cloud's
  metrics tenant limit `otel_created_timestamp_zero_ingestion_enabled` (Mimir's
  `-distributor.otel-created-timestamp-zero-ingestion-enabled`, experimental, off by
  default) writes a 0 sample at each OTLP point's start time. The OTel JS SDK
  stamps a new label set's start time at its first increment, so with it on every
  counter and histogram counts from 0 in every query, restarts included. It is off
  on this stack (every `agency_abandoned_reason_total` series' `min_over_time` on
  23 Nov is 1, never 0); Grafana Cloud support turns it on for the stack. The arm
  stays correct with it on (a series whose zero lands inside the window is still
  new; one whose zero lands before it goes through `rate()`), so the panels need
  no change either way.
