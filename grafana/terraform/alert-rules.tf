###############################################################################
# magick-agency alert rules
#
# magick-agency is one Fastify process (single replica) carrying four module
# areas: platform (identity, invites, notifications), agency (campaigns,
# pacing, DNC), voice (WebRTC bridge, carrier webhooks, concurrency, rate
# limiting) and analysis. It reports under its own service_name
# (var.agency_service_name_regex: magick-agency, magick-agency-Staging,
# magick-agency-Dedicated).
#
# Every expression selects ${local.agency} and nothing else
# (grafana/scripts/validate-alerts.test.mjs pins it).
#
# The new-series guard. Sparse counters (mail, invite claims) are created by
# their first failure, and increase() over a series with no earlier sample
# reads 0, so the first failure ever would never fire. The guard adds a second
# arm, `(x unless x offset W) and on (service_name) group by (service_name)
# (nodejs_eventloop_utilization_ratio offset W)`: a series that did not exist W
# ago counts with its current value, but only when the service itself was
# already reporting W ago, so a restart does not fire on every fresh series.
#
# Transition. Through the pilot and the rollback window (docs/decisions.md,
# open item 8) a tenant lives in exactly one system at a time, so these rules
# and the previous platform's own alerts never fire for the same campaign.
#
# No rule, and why:
#   * Billing (docs/decisions.md S6): no attempt batches, settlement or
#     settlement fan-out. The validators red if agency ever declares one of
#     those series.
#   * DNC sync and outbox (docs/decisions.md B8): the pre-dial gate reads the
#     dnc_entries table directly, so there is no sync gauge and no outbox
#     metric.
#   * API keys (docs/decisions.md #5) and purchased-concurrency sync: neither
#     exists here.
#   * Notification sends: notification_sends_total is declared
#     (metrics/platform.ts) but nothing increments it, so a rule over it could
#     never fire.
#   * The Grafana Cloud stack itself (discarded samples, usage): that watches
#     the stack, not a service, and is managed outside this repo.
#   * Known coverage gaps (../README.md): no api_requests_total /
#     api_request_duration_seconds, no call_dial_failures_total, no
#     webhook_signature_rejected_total, no media_stream_connect_timeouts_total
#     and no DNC registry metric, so no 5xx-ratio, latency, dial-failure,
#     carrier-signature, media-timeout or DNC-write rule.
###############################################################################

locals {
  agency_groups = {
    "agency-dialer" = [
      {
        uid  = "agy-dnc-unavailable"
        name = "Agency campaign halted — DNC registry unreadable"
        # The pre-dial gate fails CLOSED: when it
        # cannot confirm a number is not on the Do-Not-Call list it halts the
        # whole campaign rather than dial unchecked. Under B8 (docs/decisions.md) that check
        # is one indexed read of the dnc_entries table (DncRegistry.check), and
        # it answers `unavailable` only when that read throws — Postgres, not
        # Redis. A halted campaign places no calls and looks idle, not broken,
        # which is why this pages. sum BY campaign_id so the instance names the
        # campaign; window 5m under the 10m `for`.
        expr          = "sum by (service_name, campaign_id) (rate(agency_predial_gate_total{gate=\"dnc_unavailable\",${local.agency}}[5m]))"
        op            = "gt"
        threshold     = 0
        for           = "10m"
        severity      = "critical"
        no_data_state = "OK"
        summary       = "Agency campaign halted — cannot read the DNC registry"
        description   = "agency_predial_gate_total{gate=\"dnc_unavailable\"} has been advancing for 10m on {{ $labels.service_name }} (campaign_id={{ $labels.campaign_id }}). The pre-dial gate could not read the dnc_entries table, so it is refusing to dial — correctly: a wrongly-dialled DNC number is a regulatory event, a paused campaign is not. In magick-agency the DNC check is a direct Postgres read (there is no Redis DNC set), so this is the database: pool exhaustion, a timeout, or Postgres down. Check agency's Postgres and its pool; the caught error is logged under component=agency-dnc-registry, and each halted tick as 'Agency pre-dial gate halted the tick'. Every tick re-checks, so the campaign resumes on its own once the read succeeds; the supervisor's health strip shows the same stall meanwhile."
      },
    ]

    "concurrency" = [
      {
        uid  = "agy-telephony-lease-release-failure"
        name = "Telephony concurrency lease release failing"
        # A RATE, not any occurrence; `partial` folded in, `noop` deliberately
        # excluded; not grouped by `source`. The release code is
        # apps/server/src/core/telephony-release.ts.
        expr          = "sum by (service_name) (rate(telephony_lease_release_total{outcome=~\"failure|partial\",${local.agency}}[10m]))"
        op            = "gt"
        threshold     = 0
        for           = "15m"
        severity      = "critical"
        no_data_state = "OK"
        summary       = "Telephony concurrency leases are failing to release"
        description   = "telephony_lease_release_total{outcome=~\"failure|partial\"} has been non-zero for 15m on {{ $labels.service_name }}. Either Redis is rejecting the atomic lease release (`failure`) or a release deleted only one of the call's 2-3 leases and parked the rest (`partial`). Check which outcome is firing first — they have different causes. Either way the global/account/provider concurrency counters are over-reporting, so the dialer's admissible concurrency is drifting DOWN: dials get refused while capacity sits idle. `failure` is a Redis-write failure — check agency's Redis first. Break down by `source` to see which teardown path is affected. Recovery: the self-heal sweep (CONCURRENCY_RECONCILE_INTERVAL_MS, default 5m) rebuilds each counter from its live lock keys once the locks TTL-expire. If `failure` is flat and `partial` is the one firing, Redis is healthy and the cause is a key mismatch between the composite release (core/provider-concurrency-guard.ts) and the individual guards, or a wrong tenant/account reaching teardown. Uneven TTL expiry looks identical and is benign."
      },
      {
        uid  = "agy-telephony-lease-release-fallback"
        name = "Telephony lease release stuck on the slow path"
        # A latched-degraded guard
        # never returns to Redis for the life of the process, and a sustained
        # `fallback` majority is its only outside symptom.
        expr          = "sum by (service_name) (rate(telephony_lease_release_total{outcome=\"fallback\",${local.agency}}[15m])) / clamp_min(sum by (service_name) (rate(telephony_lease_release_total{${local.agency}}[15m])), 0.001)"
        op            = "gt"
        threshold     = 0.5
        for           = "30m"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "Most telephony lease releases are taking the per-scope fallback"
        description   = "More than 50% of telephony lease releases on {{ $labels.service_name }} have used the per-scope fallback for 30m instead of the single atomic transaction. The likely cause is a concurrency guard latched into degraded mode after a Redis failure — that latch never resets, so the process keeps accounting concurrency in a local counter. Restart the process once Redis is healthy. Search the logs for 'Atomic telephony lease release declined' and read `declineReason`: `degraded_guard` = the above; `no_provider` = a session reached teardown with no telephony provider stamped, a code bug worth a ticket; `missing_core_guard`/`no_release_all` = a wiring problem at boot. Calls are unaffected — this is a capacity-accounting alert, not a call-failure one."
      },
    ]

    # ── API edge / rate limiting ──────────────────────────────────────────
    #
    # The limiter (apps/server/src/api/middleware/rate-limit.middleware.ts) has no
    # `tenant` bucket: agency has no API keys (docs/decisions.md #5), so every
    # client that is not a carrier or the control plane is in the `ip` bucket.
    "api-edge" = [
      {
        uid  = "agy-rate-limit-infra-rejected"
        name = "Rate limiter is rejecting carrier or internal traffic"
        # These clients cannot back off, so
        # any sustained rejection is data loss. Threshold 0 with `for` 15m
        # strictly longer than the 10m window; grouped by both labels.
        expr          = "sum by (service_name, bucket_kind, route_class) (rate(rate_limit_rejected_total{bucket_kind=~\"webhook|carrier_media|internal\",${local.agency}}[10m]))"
        op            = "gt"
        threshold     = 0
        for           = "15m"
        severity      = "critical"
        no_data_state = "OK"
        summary       = "Carrier or internal requests are being rate-limited (429)"
        description   = "rate_limit_rejected_total has been non-zero for 15m on {{ $labels.service_name }} (bucket_kind={{ $labels.bucket_kind }}, route_class={{ $labels.route_class }}). This client cannot back off, so these 429s are DATA LOSS, not backpressure. bucket_kind=webhook: carrier lifecycle callbacks under /api/v1/webhooks are being refused and RETRIED, which amplifies the breach — raise RATE_LIMIT_WEBHOOK_MAX (default 1000). That ceiling scales with DIAL RATE (a carrier sends several callbacks per call from a handful of IPs), so raise it in step with the campaigns' pacing and the account concurrency limits. bucket_kind=carrier_media: raise RATE_LIMIT_CARRIER_MEDIA_MAX (default 600) — a 429 on a media WebSocket upgrade (including the WebRTC bridge's pstn-stream and browser-stream legs) is a live call with no audio for its whole length. bucket_kind=internal: RATE_LIMIT_INTERNAL_MAX (default 1000); nothing in agency serves /internal today, so a rejection there is a probe or a misrouted client, not the control plane. Agency runs one process, so each ceiling is the whole budget."
      },
      {
        uid  = "agy-rate-limit-ip-rejected"
        name = "Client traffic sustained over its rate limit"
        # Warning, 1/s for 30m. Only `ip` — there is no `tenant` bucket — so
        # this is the console, the
        # agent stations, super-admin and any unauthenticated caller, keyed by
        # client IP.
        expr          = "sum by (service_name, bucket_kind, route_class) (rate(rate_limit_rejected_total{bucket_kind=\"ip\",${local.agency}}[15m]))"
        op            = "gt"
        threshold     = 1
        for           = "30m"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "A client has been rate-limited above 1/s for 30m"
        description   = "rate_limit_rejected_total{bucket_kind=\"ip\"} has exceeded 1/s for 30m on {{ $labels.service_name }} (route_class={{ $labels.route_class }}). Some client IP is sustainably over RATE_LIMIT_MAX (default 200/min). In agency the `ip` bucket holds every browser — supervisors, agent stations, super-admin — so a whole call floor behind one office NAT shares one budget: if route_class is agency or api and the tenant runs a large floor, the limit may simply be too low. Otherwise look for a retry loop (a station reconnecting in a tight loop) or a scraper. The counter carries no tenant id; find the client IP in the request logs before raising the ceiling."
      },
    ]

    # ── Identity (console session auth) ──────────────────────────────────
    "identity" = [
      {
        uid  = "agy-firebase-auth-rejected"
        name = "Most console sign-ins are being rejected"
        # A ratio, half of all attempts, with a
        # 20-rejection floor — expired tokens are routine and refreshed.
        expr          = "(sum by (service_name) (rate(auth_attempts_total{method=\"firebase\",status=\"invalid_token\",${local.agency}}[15m])) / sum by (service_name) (rate(auth_attempts_total{method=\"firebase\",${local.agency}}[15m]))) and on (service_name) (sum by (service_name) (increase(auth_attempts_total{method=\"firebase\",status=\"invalid_token\",${local.agency}}[15m])) >= 20)"
        op            = "gt"
        threshold     = 0.5
        for           = "15m"
        severity      = "critical"
        no_data_state = "OK"
        summary       = "More than half of Firebase ID tokens are being rejected"
        description   = "auth_attempts_total{method=\"firebase\",status=\"invalid_token\"} has been more than 50% of Firebase auth attempts on {{ $labels.service_name }} for 15m (at least 20 rejections). Supervisors and agents cannot use the agency console, so no campaign can be run and no station can take a call. This is almost never a user problem: check that agency's FIREBASE_PROJECT_ID matches the Firebase project the console signs in against, and whether it changed in a recent deploy. Super-admin sign-in uses its own JWT and is unaffected, so it still works for triage."
      },
    ]

    # ── Mail the product depends on ────────────────────────────────────────
    #
    # These paths succeed whatever the mail does, so only these counters see a
    # failure, and all are sparse, so all carry the new-series guard (header).
    "notifications" = [
      {
        uid = "agy-invite-email-failures"
        # 2+ in 6h (threshold 1.5, N-0.5).
        name          = "Invite emails failing"
        expr          = "sum by (service_name, role) (((invite_emails_total{result=\"failed\",${local.agency}} unless invite_emails_total{result=\"failed\",${local.agency}} offset 6h) and on (service_name) group by (service_name) (nodejs_eventloop_utilization_ratio{${local.agency}} offset 6h)) or increase(invite_emails_total{result=\"failed\",${local.agency}}[6h]))"
        op            = "gt"
        threshold     = 1.5
        for           = "0s"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "Team invite emails are not leaving the building"
        description   = "invite_emails_total{result=\"failed\"} advanced by 2+ in 6h on {{ $labels.service_name }} (role={{ $labels.role }}). The invite was still created, so the inviter believes it worked. For role=agent the invite is the only way into the agency console, so an invited floor never arrives. Check agency's Mailjet credentials and sender; the invite-issuer log line names tenant and role, and affected invitees can be re-sent with POST /invites/resend once mail flows. not_configured and not_implemented are expected and not alerted on."
      },
      {
        uid = "agy-campaign-mail-failures"
        # failed, threw and claim_unavailable, grouped by result. In agency the notice is sent in
        # process when the pacing engine finalizes a campaign (no webhook).
        name          = "Agency campaign-completion emails failing"
        expr          = "sum by (service_name, tenant_id, result) (((agency_campaign_notifications_total{result=~\"failed|threw|claim_unavailable\",${local.agency}} unless agency_campaign_notifications_total{result=~\"failed|threw|claim_unavailable\",${local.agency}} offset 6h) and on (service_name) group by (service_name) (nodejs_eventloop_utilization_ratio{${local.agency}} offset 6h)) or increase(agency_campaign_notifications_total{result=~\"failed|threw|claim_unavailable\",${local.agency}}[6h]))"
        op            = "gt"
        threshold     = 0
        for           = "0s"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "Agency supervisors are not being told their campaign finished"
        description   = "agency_campaign_notifications_total{result=\"{{ $labels.result }}\"} advanced in the last 6h on {{ $labels.service_name }} (tenant_id={{ $labels.tenant_id }}). The campaign finished correctly; only the supervisor's completion email did not go out, and nothing else records that. failed: Mailjet refused or threw — check agency's Mailjet credentials (a revoked key stops every notice). threw: something outside the mailer failed — search the logs for 'Agency campaign completion notification threw'. claim_unavailable: the delivery ledger could not be written — agency's Postgres."
      },
      {
        uid = "agy-invite-claim-identity-conflicts"
        # cross_tenant_identity >= 2/h
        # and identity_already_bound >= 5/h, each arm a comparison filter, so
        # the threshold is 0.
        name          = "Burst of invite claims bound to the wrong identity"
        expr          = "(sum by (service_name, result) (((invite_claims_total{result=\"cross_tenant_identity\",${local.agency}} unless invite_claims_total{result=\"cross_tenant_identity\",${local.agency}} offset 1h) and on (service_name) group by (service_name) (nodejs_eventloop_utilization_ratio{${local.agency}} offset 1h)) or increase(invite_claims_total{result=\"cross_tenant_identity\",${local.agency}}[1h])) >= 2) or (sum by (service_name, result) (((invite_claims_total{result=\"identity_already_bound\",${local.agency}} unless invite_claims_total{result=\"identity_already_bound\",${local.agency}} offset 1h) and on (service_name) group by (service_name) (nodejs_eventloop_utilization_ratio{${local.agency}} offset 1h)) or increase(invite_claims_total{result=\"identity_already_bound\",${local.agency}}[1h])) >= 5)"
        op            = "gt"
        threshold     = 0
        for           = "0s"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "Invite claims are being presented by a different identity"
        description   = "invite_claims_total{result=\"{{ $labels.result }}\"} passed its bar in the last hour on {{ $labels.service_name }} (cross_tenant_identity: 2+, identity_already_bound: 5+). identity_already_bound: the invited membership is already bound to a DIFFERENT Firebase account. cross_tenant_identity: the invited user is pending in another tenant, and binding it would sign the claimant into a workspace the token does not name. Either can be honest once; a burst is worth reading as an account-takeover attempt. The public response is the same for both by design, so only this signal separates them. Read the 'Invite claim refused' warn logs (tenant, membership, claimant) — many memberships in one tenant, one claimant, one IP? Revoke the affected invites and treat the inviting tenant as suspect."
      },
    ]

    "logs" = [
      {
        uid           = "agy-error-log-volume"
        name          = "Agency error log volume high"
        datasource    = "loki"
        range_seconds = 900
        # 10+ per 15m: agency has no production baseline yet. Re-read it after
        # the pilot's first weeks and move it. count_over_time is an exact
        # count, so 9 = "10+". `nightly_window`: muted with staging's and
        # dedicated's nightly shutdown, like agy-service-not-reporting.
        expr          = "sum by (service_name) (count_over_time({service_name=~\"${var.agency_service_name_regex}\"} | severity_number >= 17 [15m]))"
        op            = "gt"
        threshold     = 9
        for           = "0s"
        severity      = "warning"
        no_data_state = "OK"
        labels        = { nightly_window = "mute" }
        summary       = "10 or more agency error logs in 15 minutes"
        description   = "{{ $labels.service_name }} logged 10+ ERROR/FATAL lines in the last 15m (count_over_time, severity_number >= 17). There is no baseline for agency yet, so read the burst before assuming an outage. Open Explore on {service_name=\"{{ $labels.service_name }}\"} | severity_number >= 17 and read the `component` field — it usually names the part (pacing engine, dialer, bridge, invites) whose own alert is about to fire."
      },
    ]

    # ── Liveness, process health, metrics pipeline ────────────────────────
    #
    # On agency's selector only, like every rule here.
    "liveness" = [
      {
        uid = "agy-service-not-reporting"
        # "Reported in the last 7 days, but not in the last 10 minutes", keyed on
        # the runtime gauge agency allow-lists (RUNTIME_METRIC_ALLOW_LIST in
        # apps/server/src/utils/otel-sdk-config.ts), observed on every export.
        # `nightly_window`: staging and dedicated go dark overnight;
        # the stack's mute timings silence them, production is never muted.
        name          = "Agency has stopped reporting telemetry"
        expr          = "group by (service_name) (max_over_time(nodejs_eventloop_utilization_ratio{${local.agency}}[7d])) unless on (service_name) group by (service_name) (max_over_time(nodejs_eventloop_utilization_ratio{${local.agency}}[10m]))"
        op            = "gt"
        threshold     = 0
        for           = "5m"
        severity      = "critical"
        no_data_state = "OK"
        labels        = { nightly_window = "mute" }
        summary       = "An agency deployment has sent no telemetry for 15 minutes"
        description   = "{{ $labels.service_name }} reported to Grafana Cloud in the last 7 days and has sent nothing for ~15 minutes: the process is down, crash-looping, or cannot reach the OTLP endpoint. Check the server container's logs first: docker/entrypoint.sh runs the migrations before the server starts, and a failed migration stops the container there (ledger table pgmigrations in agency's own Postgres). The SDK starts only with OTEL_ENABLED exactly true AND OTEL_EXPORTER_OTLP_ENDPOINT AND OTEL_SERVICE_NAME set — a deploy that dropped one of them exports nothing and logs a warning at boot. If logs are still arriving in Loki but metrics are not, it is the OTLP metrics exporter, not the service. A deployment switched off on purpose stops firing 7 days after its last push; silence it (service_name={{ $labels.service_name }}) until then."
      },
    ]

    "runtime" = [
      {
        uid = "agy-event-loop-delay-p99"
        # nodejs.eventloop.delay.p99 from
        # instrumentation-runtime-node (reset each collection, so one sample is
        # one 60s interval's p99); max by service_name, 0.5s for 10m.
        name          = "Agency event-loop delay p99 high"
        expr          = "max by (service_name) (nodejs_eventloop_delay_p99_seconds{${local.agency}})"
        op            = "gt"
        threshold     = 0.5
        for           = "10m"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "Agency's event loop has been blocked (p99 delay above 500ms) for 10m"
        description   = "nodejs_eventloop_delay_p99_seconds has been above 0.5s for 10m on {{ $labels.service_name }}, so every request, station socket message, pacing tick, carrier webhook and bridged media frame waits behind synchronous work. Agents hear it first: dead air and late audio on bridged calls. Check nodejs_eventloop_delay_max_seconds and nodejs_eventloop_utilization_ratio, and nodejs_heap_size_used_bytes (a heap near its limit means GC thrash), then traces for long synchronous spans (a large CSV ingest is the usual suspect). Agency runs one process, so restarting it is a full outage of the floor; prefer finding the hot path."
      },
      {
        uid = "agy-metric-cardinality-overflow"
        # The OTel SDK folds an
        # instrument's excess attribute sets into ONE series labelled
        # otel_metric_overflow="true" (SDK default 2000 per instrument here).
        # label_replace copies the name into a plain `metric` label with any
        # histogram suffix stripped; "$${1}" is HCL for the literal "${1}".
        name          = "An agency metric has overflowed its cardinality limit"
        expr          = "count by (service_name, metric) (label_replace({otel_metric_overflow=\"true\",${local.agency}}, \"metric\", \"$${1}\", \"__name__\", \"(.+?)(?:_bucket|_sum|_count)?\"))"
        op            = "gt"
        threshold     = 0
        for           = "5m"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "An agency metric is exporting a label-less overflow series — label-filtered alerts on it are under-reporting"
        description   = "{{ $labels.metric }} on {{ $labels.service_name }} hit its attribute-set limit and the excess is being exported as one series labelled otel_metric_overflow=\"true\" with no other labels. Every panel and rule that filters this metric by a label (campaign_id, tenant_id, gate, result, ...) is now missing whatever landed there. A counter or histogram keeps its overflow series until the process restarts. The fix is in packages/observability/src/metrics/ — an unbounded value (an id, a raw URL, free text) has reached a label; bound it rather than raising the limit."
      },
    ]
  }
}
