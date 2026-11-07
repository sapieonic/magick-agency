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
# The new-series guard. Sparse counters (mail, invite claims, child exits) are created by
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
#   * Carrier dial refusals: carrier_dial_refusals_total (Plivo's adapter only)
#     has a dashboard panel and no rule until it has a production baseline.
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
      {
        uid  = "agy-pacing-share-starved"
        name = "A running campaign is starved of its account's slots"
        # Several running campaigns of one account split its max_concurrent_calls in the pacing
        # round, fewest live calls first (MC1-MC7, docs/decisions.md). The withheld counter alone
        # measures CONTENTION (every campaign whose demand exceeded what it got while the account
        # had headroom; a busy campaign above an equal share is withheld routinely). Withheld at
        # 0 in use is the starvation signal: a campaign with NO live call is first in line, so it
        # means its tick reports after its account's split closed (MC2: it then gets 0), more
        # campaigns tie at 0 live than the account has lines, or the split is wrong. The slot
        # gauges carry a series only while the campaign reports demand to a contended split, so
        # a campaign alone on its account, or not reporting demand, cannot match. Withheld
        # within every 5m window AND at 0 in use, held for 10m
        # (strictly longer than the rate window), is ~10-15 minutes of a campaign with demand
        # that placed no call. A sparse counter under rate(), not increase(): the condition is
        # sustained, so missing the first increment costs nothing. The `and` keeps only campaigns
        # whose in-use gauge exists and reads 0 (max BY campaign); a campaign that stops being
        # withheld resolves. Warns (Slack), never pages: the account still dials up to its limit
        # through the others.
        expr          = "sum by (service_name, campaign_id) (rate(agency_pacing_share_withheld_total{${local.agency}}[5m])) and on (service_name, campaign_id) (max by (service_name, campaign_id) (agency_campaign_slots_in_use{${local.agency}}) == 0)"
        op            = "gt"
        threshold     = 0
        for           = "10m"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "A running campaign has been withheld its account's slots for 10 minutes with no live call"
        description   = "agency_pacing_share_withheld_total has kept advancing for campaign_id={{ $labels.campaign_id }} on {{ $labels.service_name }} for 10m while agency_campaign_slots_in_use for it stayed at 0: the pacing round split its account's max_concurrent_calls between the account's running campaigns and gave this one nothing, although the account had headroom and the campaign had demand. The withheld counter alone only measures contention; withheld at 0 in use is starvation, because the fewest-live-calls-first rule (MC1, docs/decisions.md) serves a campaign with no live call first. Its ready agents wait while the account's other campaigns dial. Confirm on the dashboard's Pacing Share panels (this campaign's allocated never above its in use, another campaign's allocated rising). Then check whether the account runs more campaigns than it has lines (max_concurrent_calls; the console's campaign card then reads 'N campaigns share M lines'): campaigns tied at 0 live calls take turns, so one is always waiting, and this can fire with the share working as designed. If so, raise the account's limit or have the supervisors run no more campaigns at once than the account has lines. Otherwise read the pacing logs for this campaign_id: a tick that misses the 1 s wait but reports while its account's split is open still gets the leftover, but one that reports only after the split closed (at the latest the 5 s deadline, MC2) gets 0 and waits for the next split, so a tick whose reads are always that slow starves (a 'Pacing split open past its deadline' warning for the account points the same way; so does 'A pacing tick has held granted dials with no progress past the bound' for a dial hung in the carrier); file it with the campaign and account ids. Runbook: docs/operations.md, 'Alert runbooks'."
      },
    ]

    # ── Insights: the rollup job and the pacing history ──────────────────
    #
    # Both are reporting, not dialling: a stale or holed Insights page costs no call, so these
    # warn (Slack) and never page. The rollup job (apps/server/src/agency/insights-rollup-job.ts)
    # runs in the main process only, one pass every AGENCY_INSIGHTS_ROLLUP_INTERVAL_MS (15s),
    # batches of AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE (200), batching for at most half an interval.
    # Its gauges exist only once a pass has finished (no series before the job starts), and the
    # failure and pacing-history counters only once something failed, so on a healthy idle
    # deployment every rule here reads no data (OK) or 0. The thresholds assume the default
    # interval; re-derive them if it is raised.
    "insights" = [
      {
        uid  = "agy-insights-rollup-failing"
        name = "Insights rollup batches failing"
        # A failed batch rolls back (its marks stay dirty), counts once and ends the pass, so a
        # persistent failure counts one per pass: ~60 in 15m. 10+ in 15m (threshold 9.5, N-0.5)
        # is a sixth of the passes failing, or 2.5 minutes of consecutive passes: past a
        # Postgres blip or a lock timeout, which the next pass retries and nobody sees. A poison
        # bucket (one that fails its recompute every time) is claimed first in every batch
        # (oldest first) and fails every pass, so it reads ~60. Sparse counter: new-series guard.
        expr          = "sum by (service_name) (((agency_insights_rollup_failures_total{${local.agency}} unless agency_insights_rollup_failures_total{${local.agency}} offset 15m) and on (service_name) group by (service_name) (nodejs_eventloop_utilization_ratio{${local.agency}} offset 15m)) or increase(agency_insights_rollup_failures_total{${local.agency}}[15m]))"
        op            = "gt"
        threshold     = 9.5
        for           = "0s"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "The insights rollup keeps failing — the Insights page is going stale"
        description   = "agency_insights_rollup_failures_total advanced by 10+ in 15m on {{ $labels.service_name }}. Each failure is a rollup batch rolled back with its dirty marks kept, so the range sections of the Insights page (calls, outcomes, trends, caller IDs, recording) stop moving and the page shows \"updating\" until a batch commits. Dialling is unaffected. Read the error in the logs: component=agency-insights-rollup, 'Insights rollup batch failed'. A Postgres error (connection, pool timeout, lock) is the database: check agency's Postgres and its pool. The same SQL error on every pass after a deploy is a recompute bug or a poison bucket (the claim is oldest first, so one bad bucket blocks the whole backlog): find the oldest row of agency_insights_rollup_dirty and fix or report it; the marks stay dirty, so nothing is lost and the job catches up on its own once batches commit. Runbook: docs/operations.md, 'Alert runbooks'."
      },
      {
        uid  = "agy-insights-rollup-behind"
        name = "Insights rollup falling behind"
        # The gauge is the oldest dirty mark's age after each pass, 0 when the backlog is empty.
        # A healthy job's worst after-pass age, at the default 15s interval and batch 200: one
        # interval for a mark made just after a claim (15s), plus a long pass (half an interval
        # of batching, 7.5s, plus one batch's worst case, 10s: the histogram's top bucket; 8.1s
        # measured on a 1M-attempt campaign, docs/insights.md "At scale"), plus the tick that
        # pass made the timer skip (15s): ~48s. The same 1M-attempt backfill drained in 62s.
        # 120s (8 intervals) is 2.5x that ceiling and about twice the backfill; for 10m means
        # nothing older than two minutes was drained for ~12 minutes. A gauge, so no window and
        # no guard; max BY service_name, one job per deployment.
        expr          = "max by (service_name) (agency_insights_rollup_oldest_dirty_seconds{${local.agency}})"
        op            = "gt"
        threshold     = 120
        for           = "10m"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "The insights rollup is more than 2 minutes behind for 10 minutes"
        description   = "agency_insights_rollup_oldest_dirty_seconds has been above 120s for 10m on {{ $labels.service_name }}: the oldest dirty insights bucket has waited more than 8 rollup intervals, so the Insights page's range sections are behind the attempts table and the page says \"updating\". Read agency_insights_rollup_dirty_buckets beside it (the dashboard's Insights Rollup panels). Failures rising too: follow agy-insights-rollup-failing. Backlog shrinking and batches completing: the job is working off a backfill or a burst (the migration that marks every bucket, a large reaper or disposition rewrite) and clears on its own; a backfill drains about 200 buckets per batch, several batches per 15s pass. Backlog growing with fast batches: more marks arrive than half an interval of batching drains; raise AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE. Slow batches (p95 near 10s): Postgres is slow; check its load and agency_insights_rollup_recompute_seconds. Runbook: docs/operations.md, 'Alert runbooks'."
      },
      {
        uid  = "agy-insights-rollup-stalled"
        name = "Insights rollup has stopped completing batches"
        # The backlog gauge is set only when a pass finishes, so a pass that never finishes (a
        # batch waiting on a lock: the server sets no statement_timeout) freezes it at its last
        # value, often 0, and agy-insights-rollup-behind cannot see it. Every committed batch
        # observes the histogram, the empty one that ends an idle pass included, so a running
        # job adds at least one count per pass (~0.067/s at 15s). Below 0.001/s over 10m, for
        # 5m, is no batch for 15 minutes. A job that has not started, or has failed every batch
        # since it started, has no series (no data, OK; the failing rule covers the second); a
        # fresh series has one sample for its first minute, and rate() of one sample is empty.
        expr          = "sum by (service_name) (rate(agency_insights_rollup_recompute_seconds_count{${local.agency}}[10m]))"
        op            = "lt"
        threshold     = 0.001
        for           = "5m"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "The insights rollup has completed no batch for 15 minutes"
        description   = "agency_insights_rollup_recompute_seconds_count has not advanced for ~15m on {{ $labels.service_name }}, although the job completed batches before: a rollup pass started and has not finished (the job runs one pass at a time, so every later tick is skipped), and the backlog gauges are frozen at their last value. The Insights page's range sections stop moving. Dialling is unaffected. If agy-insights-rollup-failing fires too, follow that one. Otherwise a batch is blocked: in agency's Postgres, look in pg_stat_activity for a long-running statement on agency_insights_rollup_dirty or agency_insights_rollup_buckets and what it waits on (a lock held by another transaction, an exhausted pool). Cancelling the blocked statement rolls its batch back and the next pass retries it; a restart does the same. The main-process log line 'Insights rollup job started' shows when the job last started. Runbook: docs/operations.md, 'Alert runbooks'."
      },
      {
        uid  = "agy-pacing-history-write-failures"
        name = "Pacing history writes failing"
        # The leader flushes every 15s (path="batch"); a failed flush is kept and resent, so one
        # costs nothing. The events outside the tick are one upsert each (path="direct") and a
        # failure loses that event. 5+ in 15m (threshold 4.5) is over a minute of consecutive
        # failed flushes, or five lost events. BY path, so the instance says which. Sparse
        # counter: new-series guard.
        expr          = "sum by (service_name, path) (((agency_pacing_history_write_failures_total{${local.agency}} unless agency_pacing_history_write_failures_total{${local.agency}} offset 15m) and on (service_name) group by (service_name) (nodejs_eventloop_utilization_ratio{${local.agency}} offset 15m)) or increase(agency_pacing_history_write_failures_total{${local.agency}}[15m]))"
        op            = "gt"
        threshold     = 4.5
        for           = "0s"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "Pacing history is failing to write to Postgres"
        description   = "agency_pacing_history_write_failures_total{path=\"{{ $labels.path }}\"} advanced by 5+ in 15m on {{ $labels.service_name }}. path=batch: the pacing leader's 15s flush to agency_campaign_pacing_minutes is failing; the minutes are kept in memory and resent, but past 10,000 unwritten campaign-minutes the oldest are dropped (agy-pacing-history-dropped). path=direct: the single-row writes outside the tick (a wrap-up redial refused at the limit, an our-fault retirement) are failing, and each failure is an event the Insights page's pacing history never shows. Dialling is unaffected: a failed write never fails a tick or a request. Read the error in the logs ('Pacing history flush failed' or 'Pacing history write failed'); it is almost always agency's Postgres or its pool. Runbook: docs/operations.md, 'Alert runbooks'."
      },
      {
        uid  = "agy-pacing-history-dropped"
        name = "Pacing history minutes dropped"
        # Any drop: each one is a campaign-minute of history lost for good. It needs the pending
        # cap (10,000 campaign-minutes) full, which takes minutes to hours of failed flushes, so
        # it never fires on a blip. Threshold 0 over a 15m window, for 0s (not the window, the
        # validators pin that). Sparse counter: new-series guard.
        expr          = "sum by (service_name) (((agency_pacing_history_dropped_total{${local.agency}} unless agency_pacing_history_dropped_total{${local.agency}} offset 15m) and on (service_name) group by (service_name) (nodejs_eventloop_utilization_ratio{${local.agency}} offset 15m)) or increase(agency_pacing_history_dropped_total{${local.agency}}[15m]))"
        op            = "gt"
        threshold     = 0
        for           = "0s"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "Pacing history is being dropped — the Insights stall history has holes"
        description   = "agency_pacing_history_dropped_total advanced in the last 15m on {{ $labels.service_name }}: the pacing leader held more than 10,000 unwritten campaign-minutes (its flushes kept failing) and dropped the oldest. Those minutes are gone from agency_campaign_pacing_minutes for good, so the Insights page's pacing and stall history has gaps for that period; nothing re-derives them. agy-pacing-history-write-failures (path=batch) has been firing before this: fix the write first (agency's Postgres), and the drops stop with it. The WARN 'Pacing history over its pending cap' gives how many were dropped. Tell the affected supervisors that the pacing history of that window is incomplete. Runbook: docs/operations.md, 'Alert runbooks'."
      },
    ]

    "processes" = [
      {
        uid  = "agy-cluster-child-crash"
        name = "A media or analysis worker process crashed"
        # Unexpected exits only (`expected="false"`): a clean exit 0 after the primary asked
        # for it is not a crash; a worker that dies of a signal or exits non-zero during the
        # primary's own shutdown is, and is reaped like one. It warns (Slack), never pages: a
        # stop was under way anyway, but the worker lost its graceful drain. The supervisor
        # records the series at zero when it starts (primeChildExits), so increase() sees the
        # first crash; the new-series guard (header) covers a crash before that zero's first
        # export (60s).
        expr          = "sum by (service_name, role) (((cluster_child_exits_total{expected=\"false\",${local.agency}} unless cluster_child_exits_total{expected=\"false\",${local.agency}} offset 10m) and on (service_name) group by (service_name) (nodejs_eventloop_utilization_ratio{${local.agency}} offset 10m)) or increase(cluster_child_exits_total{expected=\"false\",${local.agency}}[10m]))"
        op            = "gt"
        threshold     = 0
        for           = "0s"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "A server child process exited unexpectedly"
        description   = "cluster_child_exits_total{expected=\"false\"} rose on {{ $labels.service_name }} (role={{ $labels.role }}). A media worker crash ends the live calls of the agents it held (about 1/MEDIA_WORKERS of the floor): the primary reaps its slot (attempts ended `orphaned`, contacts requeued, agents written offline) and re-forks it, and the agents reconnect in `break`. An analysis crash leaves its jobs to the stale recovery. More than WORKER_CRASH_LOOP_MAX media exits of one slot in 5 minutes makes the primary exit and the container restart. A crash while the primary is stopping counts too (anything but exit 0 after the shutdown request): its slot is reaped before the stop goes on, and nothing restarts. Read the logs around the exit (component=child-supervisor) for the code or signal; an OOM kill shows as SIGKILL: check MEDIA_WORKER_HEAP_MB against the host's RAM. Design: docs/scaling.md §6."
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

    # ── Tenant carrier credentials (docs/decisions.md B19-B20) ───────────
    #
    # The main process's credential housekeeping (apps/server/src/bootstrap/voice.ts,
    # startCredentialHousekeeping) checks the keyring and sweeps at boot, then hourly. Both
    # series exist from boot (the gauge once the first check answers; the sweep counter is
    # recorded at zero for both results), and carry no credential, tenant or key id: the
    # ERROR/WARN logs name them.
    "carrier-credentials" = [
      {
        uid  = "agy-credential-keyring-missing-keys"
        name = "Carrier credentials sealed under a master key the keyring does not hold"
        # A gauge set at boot and after each hourly sweep, so no window and no guard; max BY
        # service_name (one main process per deployment). It changes only on a restart or a
        # pass, so a firing instance is a configuration fact, not a blip: for 0s. Pages: every
        # call on those tenants' credentials fails closed, and so do the hangups and webhook
        # checks of calls already pinned to them (B20: never a fallback to another account).
        expr          = "max by (service_name) (telephony_credential_missing_key_ids{${local.agency}})"
        op            = "gt"
        threshold     = 0
        for           = "0s"
        severity      = "critical"
        no_data_state = "OK"
        summary       = "Stored carrier credentials cannot be opened: their master key is missing from the keyring"
        description   = "telephony_credential_missing_key_ids is {{ $value }} on {{ $labels.service_name }}: tenant carrier credential secrets (Plivo, B19) are sealed under master key ids that TELEPHONY_CREDENTIAL_KEYS does not hold, so those secrets cannot be opened. Every call on an affected credential fails closed (no fallback to the service's VoiceLink account, B20): campaigns pinned to it place no calls, and the hangups and webhook signature checks of its calls already in flight fail too. The service's own VoiceLink calls are unaffected. The main-process ERROR 'Telephony credential secrets are sealed under keys missing from TELEPHONY_CREDENTIAL_KEYS' (component telephony bootstrap) names the missing ids (kekIds). Almost always a deploy that dropped or renamed a keyring entry: restore the missing id:key pairs to TELEPHONY_CREDENTIAL_KEYS (from the keyring backup, kept apart from the database) and restart; the gauge reads 0 at the next boot. If a key is truly lost, its secrets never open again: a super-admin rotates each affected credential's secret (the Telephony Credentials screen), which reseals it under TELEPHONY_CREDENTIAL_ACTIVE_KEY. No keyring configured at all (TELEPHONY_CREDENTIAL_KEYS unset) with credentials stored reads every stored key id as missing. Runbook: docs/operations.md, 'Alert runbooks'."
      },
      {
        uid  = "agy-credential-sweep-failing"
        name = "Carrier credential sweeps failing"
        # One sweep an hour (and one at boot), so a 3h window holds ~3 passes. One failure is
        # retried an hour later and costs a shred or prune an hour late; 2+ failed in 3h
        # (threshold 1.5, N-0.5) is the sweep failing persistently. Recorded at zero at boot
        # (primeTelephonyCredentialSweeps); the new-series guard covers a failure before that
        # zero's first export. Warns (Slack): nothing dials on a revoked credential either way,
        # but its secrets outlive the retention B20 promises.
        expr          = "sum by (service_name) (((telephony_credential_sweeps_total{result=\"failed\",${local.agency}} unless telephony_credential_sweeps_total{result=\"failed\",${local.agency}} offset 3h) and on (service_name) group by (service_name) (nodejs_eventloop_utilization_ratio{${local.agency}} offset 3h)) or increase(telephony_credential_sweeps_total{result=\"failed\",${local.agency}}[3h]))"
        op            = "gt"
        threshold     = 1.5
        for           = "0s"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "The carrier credential sweep keeps failing"
        description   = "telephony_credential_sweeps_total{result=\"failed\"} advanced by 2+ in 3h on {{ $labels.service_name }}: the hourly sweep that shreds revoked carrier credentials once their calls have ended (2 h after the last one) and drops secret versions past the 24 h rotation grace is failing. Nothing dials on a revoked credential either way, but its sealed secrets stay in telephony_credential_secrets past the retention B20 promises until a sweep succeeds. Read the main-process WARN 'Telephony credential sweep failed' for the error: it is almost always agency's Postgres or its pool (the sweep is a few reads and row-locked updates on telephony_credentials, telephony_credential_secrets and the calls pinned to them). A lock wait on a credential row being revoked or rotated clears on its own. The sweep is idempotent and the next hourly pass catches up once it succeeds; a restart also runs one at boot. Runbook: docs/operations.md, 'Alert runbooks'."
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
        # Warning, 1/s for 30m. The client buckets — there is no `tenant` bucket:
        # `ip` (unauthenticated, by client IP), `ip_auth` (bearer-carrying, by client
        # IP), `user` (by verified user; decision Q9, amended 2026-11-01) and `station`
        # (station socket upgrades, by client IP).
        expr          = "sum by (service_name, bucket_kind, route_class) (rate(rate_limit_rejected_total{bucket_kind=~\"ip|ip_auth|user|station\",${local.agency}}[15m]))"
        op            = "gt"
        threshold     = 1
        for           = "30m"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "A client has been rate-limited above 1/s for 30m"
        description   = "rate_limit_rejected_total{bucket_kind=\"{{ $labels.bucket_kind }}\"} has exceeded 1/s for 30m on {{ $labels.service_name }} (route_class={{ $labels.route_class }}). bucket_kind=user: one signed-in person is sustainably over RATE_LIMIT_USER_MAX (default 300/min), almost always a client retry loop (a console or app polling in a tight loop), not load; find the user in the request logs. bucket_kind=ip_auth: one client IP's bearer-carrying traffic is over RATE_LIMIT_IP_AUTH_MAX (default 3000/min): a very large floor behind one NAT, or forged bearers (each one a 401); raise the ceiling only for the first. bucket_kind=ip: one client IP's unauthenticated traffic (sign-in, invites, /client-config) is over RATE_LIMIT_MAX (default 200/min): a scraper or a retry loop. bucket_kind=station: one client IP's station socket upgrades are over RATE_LIMIT_STATION_MAX (default 1200/min): a reconnect storm behind one NAT (raise it), or a token-guessing loop (each upgrade a 4401; do not). The counter carries no tenant id; find the client in the request logs before raising a ceiling."
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
        description   = "invite_emails_total{result=\"failed\"} advanced by 2+ in 6h on {{ $labels.service_name }} (role={{ $labels.role }}). The invite was still created, so the inviter believes it worked. Every role's invite mail carries the only link into its claim page (/agency/join for agents, /join for everyone else), so invited agents, operators and admins never arrive. Check agency's Mailjet credentials and sender; the invite-issuer log line names tenant and role, and affected invitees can be re-sent with POST /invites/resend once mail flows. not_configured (no Mailjet block or no CONSOLE_BASE_URL) is expected and not alerted on; not_implemented is no longer emitted."
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
        # cross_tenant_identity >= 2/h,
        # identity_already_bound >= 5/h and address_required >= 3/h, each arm a
        # comparison filter, so the threshold is 0. address_required (decision
        # B25): an account_admin-or-above invite claimed by a sign-in that is not
        # the invited address. The join page stops that before it claims, so the
        # server only sees it from a stale page, a role change mid-flight, or a
        # client that is not the console — a burst is somebody holding admin
        # invite links that are not theirs.
        name          = "Burst of invite claims from the wrong identity"
        expr          = "(sum by (service_name, result) (((invite_claims_total{result=\"cross_tenant_identity\",${local.agency}} unless invite_claims_total{result=\"cross_tenant_identity\",${local.agency}} offset 1h) and on (service_name) group by (service_name) (nodejs_eventloop_utilization_ratio{${local.agency}} offset 1h)) or increase(invite_claims_total{result=\"cross_tenant_identity\",${local.agency}}[1h])) >= 2) or (sum by (service_name, result) (((invite_claims_total{result=\"identity_already_bound\",${local.agency}} unless invite_claims_total{result=\"identity_already_bound\",${local.agency}} offset 1h) and on (service_name) group by (service_name) (nodejs_eventloop_utilization_ratio{${local.agency}} offset 1h)) or increase(invite_claims_total{result=\"identity_already_bound\",${local.agency}}[1h])) >= 5) or (sum by (service_name, result) (((invite_claims_total{result=\"address_required\",${local.agency}} unless invite_claims_total{result=\"address_required\",${local.agency}} offset 1h) and on (service_name) group by (service_name) (nodejs_eventloop_utilization_ratio{${local.agency}} offset 1h)) or increase(invite_claims_total{result=\"address_required\",${local.agency}}[1h])) >= 3)"
        op            = "gt"
        threshold     = 0
        for           = "0s"
        severity      = "warning"
        no_data_state = "OK"
        summary       = "Invite claims are being presented by a different identity"
        description   = "invite_claims_total{result=\"{{ $labels.result }}\"} passed its bar in the last hour on {{ $labels.service_name }} (cross_tenant_identity: 2+, identity_already_bound: 5+, address_required: 3+). identity_already_bound: the invited membership is already bound to a DIFFERENT Firebase account. cross_tenant_identity: the invited user is pending in another tenant, and binding it would sign the claimant into a workspace the token does not name. address_required: an account_admin, tenant_admin or tenant_owner invitation was presented by a sign-in whose email is not the invited address (refused, nothing bound, the invite stays live); the console stops this before claiming, so these come from a stale page or a client that is not the console. Any of the three can be honest once; a burst is worth reading as an account-takeover attempt, address_required as somebody holding admin invite links (a forwarded or leaked mail) that are not theirs. The public response for the first two is the same by design, so only this signal separates them. Read the 'Invite claim refused' warn logs (tenant, invitation, membership or role; never an address) — many memberships in one tenant, one claimant, one IP? Revoke the affected invites and treat the inviting tenant as suspect."
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
