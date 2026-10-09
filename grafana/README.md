# Grafana: agency's alert rules and dashboard

Agency's alerting and dashboard, as a Terraform root module with its own state.
It is applied on its own and shares no resources with the MagickVoice platform's
module (`MagickVoice-platform/grafana/terraform/`). The platform module still owns
the stack's routing; see [Routing](#routing-owned-by-the-platform).

| Path | What it is |
|---|---|
| [`terraform/`](terraform/) | The root module: the folder **Magick Agency Alerts** (uid `magick-agency-alerts`), the alert rules, the dashboard |
| [`terraform/alert-rules.tf`](terraform/alert-rules.tf) | The 13 `agy-*` rules, as data |
| [`terraform/alerting.tf`](terraform/alerting.tf) | The folder, `local.agency` (the selector), the routing labels, and the one `grafana_rule_group` resource |
| [`terraform/dashboard.tf`](terraform/dashboard.tf) | The dashboard resource (app-platform `grafana_apps_dashboard_dashboard_v1beta1`, as the platform uses) |
| [`dashboards/magick-agency-overview.json`](dashboards/magick-agency-overview.json) | The dashboard (uid `magick-agency-overview`, classic model) |
| [`scripts/`](scripts/) | The validators, `pnpm test:grafana` |

## Apply

```bash
cd grafana/terraform
export GRAFANA_URL="https://sapieonic.grafana.net"
export GRAFANA_AUTH="<service-account-token>"   # dashboards + alerting writer
terraform init && terraform plan && terraform apply
```

**State is local and separate.** This module keeps its own `terraform.tfstate`
(gitignored, like `.terraform/` and `*.tfvars`). It is a different state from
the platform module's, so the two are planned and applied separately and never
see each other's resources. Apply from the machine that holds this state, or
copy it, or `terraform import` each resource first, as the platform documents
for its own state. Optional overrides are in `terraform.tfvars.example`.

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

## Routing (owned by the platform)

**This module manages no contact point, notification policy, mute timing or
message template, and must not.** The stack has one notification policy (a
Grafana singleton), owned by the platform module together with AlertInSlack,
AlertInPagerDuty and the nightly mute timings. Applying a policy from here would
replace the platform's whole routing tree.

Agency's alerts reach Slack and PagerDuty only because they carry the labels
that policy routes on. That makes the labels a contract with the platform
module. If the platform changes its routing labels, this module must follow:

| Label | Value | Used by the platform policy for |
|---|---|---|
| `severity` | `critical` / `warning` | `critical` pages (production, dedicated) and is reminded hourly; warnings go to Slack |
| `deployment` | templated from `service_name`: `-Staging` → `staging`, `-Dedicated` → `dedicated`, else `production` | staging goes to Slack only; production and dedicated criticals page. The template is byte-identical to the platform's `local.deployment_label` |
| `nightly_window` | `mute` (only on `agy-service-not-reporting` and `agy-error-log-volume`) | the staging and dedicated nightly mute timings |
| `service` | `agency` | the PagerDuty incident's component |
| `component` | the rule group | the PagerDuty incident's class |

The policy groups by `grafana_folder`, `alertname` and `deployment`. The routing
test in `scripts/validate-alerts.test.mjs` pins all of this:
- the label set and the `deployment` template text;
- that rules add no label but `nightly_window = "mute"`;
- that no `.tf` file here declares a platform-only resource.

## Rules

Every expression selects `${local.agency}` and nothing else. `for`, thresholds,
windows and new-series guards are copied from the platform rules named; the
rationale comments stay in the platform's files.

| uid | Reads | From |
|---|---|---|
| `agy-dnc-unavailable` | `agency_predial_gate_total{gate="dnc_unavailable"}` | `vao-agency-dnc-unavailable` (here the halt is a failed Postgres read of `dnc_entries`, decision B8) |
| `agy-telephony-lease-release-failure` | `telephony_lease_release_total{outcome=~"failure\|partial"}` | `vao-telephony-lease-release-failure` |
| `agy-telephony-lease-release-fallback` | `telephony_lease_release_total`, `fallback` share | `vao-telephony-lease-release-fallback` |
| `agy-rate-limit-infra-rejected` | `rate_limit_rejected_total{bucket_kind=~"webhook\|carrier_media\|internal"}` | `vao-rate-limit-infra-rejected` |
| `agy-rate-limit-ip-rejected` | `rate_limit_rejected_total{bucket_kind="ip"}` | `vao-rate-limit-tenant-rejected` (no `tenant` bucket: no API keys, decision #5) |
| `agy-firebase-auth-rejected` | `auth_attempts_total{method="firebase"}` | `mst-firebase-auth-rejected` |
| `agy-invite-email-failures` | `invite_emails_total{result="failed"}` | `mst-invite-email-failures` |
| `agy-campaign-mail-failures` | `agency_campaign_notifications_total{result=~"failed\|threw\|claim_unavailable"}` | `mst-agency-campaign-mail-failures` |
| `agy-invite-claim-identity-conflicts` | `invite_claims_total` | `mst-invite-claim-identity-conflicts` |
| `agy-error-log-volume` | Loki, ERROR/FATAL lines | `mst-error-log-volume` |
| `agy-service-not-reporting` | `nodejs_eventloop_utilization_ratio`, present in 7d, absent in 10m | `plat-service-not-reporting` |
| `agy-event-loop-delay-p99` | `nodejs_eventloop_delay_p99_seconds` | `plat-event-loop-delay-p99` |
| `agy-metric-cardinality-overflow` | `{otel_metric_overflow="true"}` | `plat-metric-cardinality-overflow` |

**Re-baseline `agy-error-log-volume` after the pilot.** It starts at master's bar
(10+ ERROR/FATAL lines in 15m) because agency has no production history. Read
the per-15m peaks of the pilot's first weeks, then move the threshold. Use
count − 1, since `count_over_time` is exact.

**Not carried:**
- Billing (decision S6): `mst-agency-attempt-settlement-failures` and
  `vao-settlement-*` have no agency copy. The validators red if agency declares
  `agency_attempt_batches_total`, `agency_attempt_batch_attempts_total`,
  `agency_attempt_settlement_failures_total`, `settlement_dispatch_total` or
  `webhook_fanout_abandoned_total`.
- DNC sync and outbox (B8).
- API keys (#5).
- Purchased-concurrency sync.
- `mst-notification-send-failures`: `notification_sends_total` is declared but
  nothing increments it.
- The platform's S2S rules: agency has no hop to core or master.
- The Grafana Cloud stack rules: they watch the stack, not a service, and stay
  in the platform module.

## Dashboard

**Magick Agency — Overview**: every query carries `deployment_environment=~"$environment"`
and `service_name=~"$service_name"`. The rows:
- **Agency dialer**: live attempts by state, 24h abandonment, throughput,
  pre-dial gate outcomes, settled attempts by outcome, where seat time goes,
  hold time, answer latency, late bind, abandonment causes, wrap-up,
  our-fault retirements, campaign-completion emails.
- **Voice, capacity and storage**: WebSockets, telephony lease release,
  provider concurrency admission, rate-limit rejections, S3.
- **Identity and mail**: sign-in attempts; invite emails and claims.
- **Analysis**: dialer analysis and its latency.
- **Runtime and telemetry**: event-loop delay and utilization, heap,
  cardinality overflow, feature flags, ERROR/FATAL logs (Loki).

## Known metric gaps

Agency does not emit these, so it has no rule or panel for them. Each needs a
metric in `packages/observability/src/metrics/` first:

- `api_requests_total` / `api_request_duration_seconds`: no 5xx ratio, API
  latency, request rate or status-mix panels or rules.
- `call_dial_failures_total`: no carrier dial-failure rule.
- `webhook_signature_rejected_total`: no carrier signature-refusal rule.
- `media_stream_connect_timeouts_total`: no media-timeout rule.
- DNC registry writes: core's DNC outbox and sync metrics have no agency
  counterpart. The rollback-window mirror to master that will use
  `agency_dnc_outbox` is not built yet.
- `notification_sends_total` is declared but never incremented.
- `websocket_connections_active` counts only the bridge's carrier leg
  (`webrtc_pstn`); the browser leg and the station socket are not instrumented.

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
- pending periods are sound;
- uids are unique and `agy-`;
- agency's selector only;
- the routing contract above.

`validate-dashboard.test.mjs` checks the dashboard the same way, plus the 1m Min
step and 5m windows the 60s OTLP export needs, and agency-only scoping. Both are
ported from the platform's validators (`PORTING.md`, "Grafana alerting (B6)").
