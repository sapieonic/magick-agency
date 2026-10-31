# Modules

An inventory of every module in the repo: what each directory holds and which test files cover
it, grouped by package. Read it to find where something lives, or to see how a module is tested
before you change it. Generated from the tree on 2026-10-09.

**Counts.** Unit counts are the per-file numbers Vitest printed on 2026-10-09. Integration counts
(marked `~`) are static counts of `it(` / `test(` calls in the file, where an `it.each` table or a
loop counts as one, so they undercount; an unmarked integration count is the number Vitest printed
for that file. The authoritative integration totals are in [`status.md`](status.md). Tests are listed
under the source directory they mirror; tests that span several modules are listed at the end of
each package. The console's soft-phone test files (added 2026-10-30) are static counts too, exact
where the file has no `it.each` and marked `~` where it has one; the two existing console files the
soft phone added a case to (`HoldToConfirmButton`, `DncPage`) show the printed count plus that case.

For how the pieces fit together, read [`architecture.md`](architecture.md); for boundaries,
[`seams.md`](seams.md).

## `apps/server`

### `apps/server/src/`

Composition: `instrumentation.ts` (the OpenTelemetry SDK, imported first; exports over OTLP only when `OTEL_ENABLED`, the endpoint and `OTEL_SERVICE_NAME` are all set), `index.ts` (process start, signal handling, shutdown order, the OTel flush last), `app.ts` (`buildApp`: app-wide limiter, error handler and 5xx mask, probes, WebSocket plugin, the four area plugins), `app-context.ts` (what plugins and bootstraps receive), `db-tls.ts` (the Postgres TLS decision shared by the server, migrations and the super-admin CLI), `migrate.ts` (the pre-boot migration step, bundled to `dist/migrate.js` and run by `docker/entrypoint.sh`).

Files: `app-context.ts`, `app.ts`, `db-tls.ts`, `index.ts`, `instrumentation.ts`, `migrate.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/app/audit-flush-on-stop.test.ts` | ~2 |
| `apps/server/test/integration/app/concurrency-seam-wiring.test.ts` | ~2 |
| `apps/server/test/integration/app/error-mask-app-wide.test.ts` | ~3 |
| `apps/server/test/integration/app/feature-flag-boot-wiring.test.ts` | ~2 |
| `apps/server/test/integration/app/trust-proxy.test.ts` | ~4 |
| `apps/server/test/unit/app/max-param-length.test.ts` | 2 |
| `apps/server/test/unit/app/request-id.test.ts` | 2 |
| `apps/server/test/unit/deploy/migrate.test.ts` | 9 |

### `apps/server/src/agency/`

The dialer runtime and campaign management: `AgencyRuntime` (`runtime.ts`), the agent state machine and leases, pacing engine and leader lease, dial dispatcher and dialer, pre-dial gates, station registry, socket and tokens, wrap-up, breaks, reaper, abandonment clip, guardrail and metrics, live-concurrency metrics, DNC registry and mark, outcome classification, dispositions, retry policy, calling hours, campaign config, health, series and completion notice; and the campaign-management layer: CSV ingest and its jobs, staffing, activity trail, agent identity, the spine, campaign wire shapes, stats enrichment.

Files: `abandon-clip.ts`, `abandonment-guardrail.ts`, `abandonment-metrics.ts`, `agency-activity-actions.ts`, `agency-activity.service.ts`, `agency-activity.ts`, `agency-actor.ts`, `agency-agent-identity.ts`, `agency-campaign-config.ts`, `agency-campaign-wire.ts`, `agency-column-analysis.ts`, `agency-csv-ingest.ts`, `agency-csv.ts`, `agency-dialer.ts`, `agency-ingest-job.repository.ts`, `agency-ingest-keys.ts`, `agency-ingest.service.ts`, `agency-rejected-csv.ts`, `agency-roster.client.ts`, `agency-spine.ts`, `agency-stats-enrichment.ts`, `agent-record.ts`, `agent-state-machine.ts`, `calling-hours.ts`, `campaign-behavioral-settings.ts`, `campaign-completion-notice.ts`, `campaign-config.ts`, `campaign-health.ts`, `campaign-series.ts`, `campaign-thresholds.ts`, `dial-dispatcher.ts`, `disposition-policy.ts`, `disposition.ts`, `dnc-availability.ts`, `dnc-mark.ts`, `dnc-registry.ts`, `live-concurrency-metrics.ts`, `outcome-classifier.ts`, `pacing-engine.ts`, `pre-dial-gates.ts`, `reaper.ts`, `retry-policy.ts`, `runtime.ts`, `spine-filters.ts`, `station-registry.ts`, `station-socket.ts`, `station-token.ts`, `wrapup-manager.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/agency/abandonment-invariants.test.ts` | ~4 |
| `apps/server/test/integration/agency/agency-activity-service.test.ts` | ~6 |
| `apps/server/test/integration/agency/agency-agent-cas.test.ts` | ~6 |
| `apps/server/test/integration/agency/agency-agent-identity.test.ts` | ~4 |
| `apps/server/test/integration/agency/agency-agent-state-cycle.test.ts` | ~1 |
| `apps/server/test/integration/agency/agency-agent-state-get-many.test.ts` | ~1 |
| `apps/server/test/integration/agency/agency-analysis-profile-reference-check.test.ts` | ~8 |
| `apps/server/test/integration/agency/agency-campaign-create.test.ts` | ~3 |
| `apps/server/test/integration/agency/agency-campaign-stats.routes.test.ts` | ~10 |
| `apps/server/test/integration/agency/agency-campaign-stats.test.ts` | ~18 |
| `apps/server/test/integration/agency/agency-campaign-summaries.routes.test.ts` | ~9 |
| `apps/server/test/integration/agency/agency-campaign-update.test.ts` | 4 |
| `apps/server/test/integration/agency/agency-contact-claim-limit.test.ts` | 2 |
| `apps/server/test/integration/agency/agency-contact-unclaim-many.test.ts` | ~1 |
| `apps/server/test/integration/agency/agency-context-ordering.test.ts` | ~9 |
| `apps/server/test/integration/agency/agency-conversion-counting.test.ts` | ~13 |
| `apps/server/test/integration/agency/agency-crash-recovery.test.ts` | ~6 |
| `apps/server/test/integration/agency/agency-dnc-campaign-scope.test.ts` | ~10 |
| `apps/server/test/integration/agency/agency-dnc-mark-route.test.ts` | ~4 |
| `apps/server/test/integration/agency/agency-dnc-resurrection.test.ts` | ~12 |
| `apps/server/test/integration/agency/agency-dnc-runtime-wiring.test.ts` | ~1 |
| `apps/server/test/integration/agency/agency-double-reservation.test.ts` | ~9 |
| `apps/server/test/integration/agency/agency-duplicate-dial.test.ts` | ~11 |
| `apps/server/test/integration/agency/agency-gate-skip-logging.test.ts` | ~2 |
| `apps/server/test/integration/agency/agency-ingest-chunk-fate.test.ts` | 4 |
| `apps/server/test/integration/agency/agency-ingest-concurrent-total.test.ts` | 1 |
| `apps/server/test/integration/agency/agency-ingest-idempotency.test.ts` | ~13 |
| `apps/server/test/integration/agency/agency-ingest-job-repository-sql.test.ts` | ~12 |
| `apps/server/test/integration/agency/agency-ingest-roundtrip.test.ts` | ~7 |
| `apps/server/test/integration/agency/agency-ingest-route-seam.test.ts` | ~7 |
| `apps/server/test/integration/agency/agency-join-rehydrate-db.test.ts` | ~13 |
| `apps/server/test/integration/agency/agency-lease-ring-duration.test.ts` | ~4 |
| `apps/server/test/integration/agency/agency-migration.test.ts` | ~13 |
| `apps/server/test/integration/agency/agency-reaper-sql.test.ts` | ~14 |
| `apps/server/test/integration/agency/agency-retry-idempotency.test.ts` | ~9 |
| `apps/server/test/integration/agency/agency-retry-seeding.test.ts` | ~21 |
| `apps/server/test/integration/agency/agency-roster-handoff.test.ts` | ~19 |
| `apps/server/test/integration/agency/agency-session-tenant-unique.test.ts` | ~5 |
| `apps/server/test/integration/agency/agency-spine-read.test.ts` | ~20 |
| `apps/server/test/integration/agency/agency-stats-enrichment.test.ts` | ~16 |
| `apps/server/test/integration/agency/agent-grouped-read.test.ts` | ~14 |
| `apps/server/test/integration/agency/agent-multi-session.test.ts` | ~7 |
| `apps/server/test/integration/agency/agent-occupancy-carried-bound.test.ts` | 2 |
| `apps/server/test/integration/agency/agent-occupancy-window.test.ts` | ~8 |
| `apps/server/test/integration/agency/agent-record-tenant-isolation.test.ts` | ~7 |
| `apps/server/test/integration/agency/agent-stats-timezone-buckets.test.ts` | ~13 |
| `apps/server/test/integration/agency/agent-transition-ordering.test.ts` | ~11 |
| `apps/server/test/integration/agency/agent-window-boundaries.test.ts` | ~11 |
| `apps/server/test/integration/agency/campaign-behavioral-settings.test.ts` | ~4 |
| `apps/server/test/integration/agency/campaign-stats-equivalence.test.ts` | 4 |
| `apps/server/test/integration/agency/campaign-stats-series.test.ts` | ~16 |
| `apps/server/test/integration/agency/chaos/abandonment-counter-vs-table.test.ts` | ~9 |
| `apps/server/test/integration/agency/chaos/abandonment-predicate-agreement.test.ts` | ~3 |
| `apps/server/test/integration/agency/chaos/attempt-number-collision.test.ts` | ~6 |
| `apps/server/test/integration/agency/chaos/dnc-self-heal-loop.test.ts` | ~2 |
| `apps/server/test/integration/agency/chaos/lease-renewer-killed.test.ts` | ~5 |
| `apps/server/test/integration/agency/chaos/network-drop-during-ring.test.ts` | ~7 |
| `apps/server/test/integration/agency/chaos/redis-expired-wholesale.test.ts` | ~8 |
| `apps/server/test/integration/agency/chaos/restart-mid-bridge.test.ts` | ~2 |
| `apps/server/test/integration/agency/chaos/roster-exactly-once.test.ts` | ~8 |
| `apps/server/test/integration/agency/chaos/settle-write-failure.test.ts` | ~3 |
| `apps/server/test/integration/agency/dnc-registry.test.ts` | ~14 |
| `apps/server/test/integration/agency/repository-sql-coverage.test.ts` | 12 |
| `apps/server/test/integration/agency/runtime-boot-order.test.ts` | ~3 |
| `apps/server/test/integration/agency/runtime-e2e.test.ts` | ~1 |
| `apps/server/test/integration/agency/softphone-contact-settlement.test.ts` | ~42 |
| `apps/server/test/integration/agency/softphone-manual-call-repository.test.ts` | ~32 |
| `apps/server/test/integration/agency/softphone-mixed-data-reads.test.ts` | 5 |
| `apps/server/test/integration/agency/softphone-session-join.test.ts` | ~9 |
| `apps/server/test/integration/agency/softphone-session-route.test.ts` | 1 |
| `apps/server/test/integration/agency/softphone-settings-repository.test.ts` | ~6 |
| `apps/server/test/unit/agency/abandon-clip-cache-roundtrip.test.ts` | 5 |
| `apps/server/test/unit/agency/abandon-clip.test.ts` | 11 |
| `apps/server/test/unit/agency/abandon-reason-telemetry.test.ts` | 27 |
| `apps/server/test/unit/agency/abandoned-call-path.test.ts` | 16 |
| `apps/server/test/unit/agency/abandonment-guardrail.test.ts` | 27 |
| `apps/server/test/unit/agency/abandonment-metrics.test.ts` | 9 |
| `apps/server/test/unit/agency/abandonment-otlp-export.test.ts` | 11 |
| `apps/server/test/unit/agency/abandonment-window.test.ts` | 19 |
| `apps/server/test/unit/agency/agency-activity-actions.test.ts` | 6 |
| `apps/server/test/unit/agency/agency-activity.test.ts` | 56 |
| `apps/server/test/unit/agency/agency-actor.test.ts` | 6 |
| `apps/server/test/unit/agency/agency-agent-identity.test.ts` | 9 |
| `apps/server/test/unit/agency/agency-call-read-routes.test.ts` | 25 |
| `apps/server/test/unit/agency/agency-campaign-config.test.ts` | 80 |
| `apps/server/test/unit/agency/agency-column-analysis.test.ts` | 14 |
| `apps/server/test/unit/agency/agency-csv-ingest.isolation.test.ts` | 4 |
| `apps/server/test/unit/agency/agency-csv-ingest.streaming.test.ts` | 2 |
| `apps/server/test/unit/agency/agency-csv-ingest.test.ts` | 54 |
| `apps/server/test/unit/agency/agency-dialer-lineage.test.ts` | 5 |
| `apps/server/test/unit/agency/agency-dialer.test.ts` | 37 |
| `apps/server/test/unit/agency/agency-ingest-job.repository.test.ts` | 34 |
| `apps/server/test/unit/agency/agency-ingest-keys.test.ts` | 10 |
| `apps/server/test/unit/agency/agency-ingest-restart-contract.test.ts` | 9 |
| `apps/server/test/unit/agency/agency-ingest.service.test.ts` | 50 |
| `apps/server/test/unit/agency/agency-internal-ingest-ownership.test.ts` | 16 |
| `apps/server/test/unit/agency/agency-join-result.test.ts` | 7 |
| `apps/server/test/unit/agency/agency-proxy-path-traversal.test.ts` | 83 |
| `apps/server/test/unit/agency/agency-rejected-csv.test.ts` | 6 |
| `apps/server/test/unit/agency/agency-repository.test.ts` | 43 |
| `apps/server/test/unit/agency/agent-attempts-repository.test.ts` | 9 |
| `apps/server/test/unit/agency/agent-grouped-repository.test.ts` | 62 |
| `apps/server/test/unit/agency/agent-record-routes.test.ts` | 56 |
| `apps/server/test/unit/agency/agent-record.test.ts` | 102 |
| `apps/server/test/unit/agency/agent-roster-repository.test.ts` | 55 |
| `apps/server/test/unit/agency/agent-session-events.test.ts` | 20 |
| `apps/server/test/unit/agency/agent-state-machine.test.ts` | 17 |
| `apps/server/test/unit/agency/agent-stats-repository.test.ts` | 38 |
| `apps/server/test/unit/agency/calling-hours.test.ts` | 31 |
| `apps/server/test/unit/agency/campaign-abandon-config-route.test.ts` | 8 |
| `apps/server/test/unit/agency/campaign-analysis-profile-route.test.ts` | 13 |
| `apps/server/test/unit/agency/campaign-behavioral-settings.test.ts` | 52 |
| `apps/server/test/unit/agency/campaign-completion-notice.test.ts` | 6 |
| `apps/server/test/unit/agency/campaign-config-route.test.ts` | 57 |
| `apps/server/test/unit/agency/campaign-list-route.test.ts` | 6 |
| `apps/server/test/unit/agency/campaign-conversion-stats.test.ts` | 9 |
| `apps/server/test/unit/agency/campaign-health.test.ts` | 19 |
| `apps/server/test/unit/agency/campaign-insert-param-types.test.ts` | 3 |
| `apps/server/test/unit/agency/campaign-lifecycle-route.test.ts` | 10 |
| `apps/server/test/unit/agency/campaign-lifecycle-timestamps.test.ts` | 19 |
| `apps/server/test/unit/agency/campaign-retry-repository.test.ts` | 19 |
| `apps/server/test/unit/agency/campaign-retry-route.test.ts` | 57 |
| `apps/server/test/unit/agency/campaign-series-parse.test.ts` | 13 |
| `apps/server/test/unit/agency/campaign-sip-removal-route.test.ts` | 4 |
| `apps/server/test/unit/agency/campaign-start-roster-route.test.ts` | 16 |
| `apps/server/test/unit/agency/campaign-stats-concurrency-guard-route.test.ts` | 2 |
| `apps/server/test/unit/agency/campaign-stats-contract.test.ts` | 13 |
| `apps/server/test/unit/agency/campaign-stats-series-route.test.ts` | 15 |
| `apps/server/test/unit/agency/campaign-stats-series.test.ts` | 22 |
| `apps/server/test/unit/agency/canceled-outcome-ledger.test.ts` | 11 |
| `apps/server/test/unit/agency/dial-dispatcher.test.ts` | 7 |
| `apps/server/test/unit/agency/disposition-policy.test.ts` | 90 |
| `apps/server/test/unit/agency/disposition-route.test.ts` | 37 |
| `apps/server/test/unit/agency/disposition.test.ts` | 19 |
| `apps/server/test/unit/agency/dnc-availability.test.ts` | 6 |
| `apps/server/test/unit/agency/dnc-mark-route.test.ts` | 37 |
| `apps/server/test/unit/agency/dnc-mark.test.ts` | 16 |
| `apps/server/test/unit/agency/dnc-registry.test.ts` | 9 |
| `apps/server/test/unit/agency/dnc-resurrection.test.ts` | 12 |
| `apps/server/test/unit/agency/exhaustion-completion.test.ts` | 21 |
| `apps/server/test/unit/agency/forward-query-strictness.test.ts` | 16 |
| `apps/server/test/unit/agency/hangup-route.test.ts` | 10 |
| `apps/server/test/unit/agency/late-binding.test.ts` | 31 |
| `apps/server/test/unit/agency/left-session-guards.test.ts` | 38 |
| `apps/server/test/unit/agency/live-concurrency-metrics.test.ts` | 21 |
| `apps/server/test/unit/agency/live-concurrency-repository.test.ts` | 8 |
| `apps/server/test/unit/agency/occupancy-ctes.test.ts` | 4 |
| `apps/server/test/unit/agency/our-fault-redial.test.ts` | 20 |
| `apps/server/test/unit/agency/outcome-classifier.test.ts` | 45 |
| `apps/server/test/unit/agency/pacing-engine-gates.test.ts` | 22 |
| `apps/server/test/unit/agency/pacing-engine.test.ts` | 81 |
| `apps/server/test/unit/agency/pre-dial-gates.test.ts` | 20 |
| `apps/server/test/unit/agency/presence-resilience.test.ts` | 14 |
| `apps/server/test/unit/agency/profile-in-use-reference-check.test.ts` | 23 |
| `apps/server/test/unit/agency/proxy-agency-agent-actions.test.ts` | 62 |
| `apps/server/test/unit/agency/proxy-agency-agent-audit.test.ts` | 8 |
| `apps/server/test/unit/agency/proxy-agency-calls.routes.test.ts` | 81 |
| `apps/server/test/unit/agency/proxy-agency-campaign-activity.routes.test.ts` | 41 |
| `apps/server/test/unit/agency/proxy-agency-campaign-behavioral-capabilities.routes.test.ts` | 32 |
| `apps/server/test/unit/agency/proxy-agency-campaign-lifecycle-rbac.routes.test.ts` | 10 |
| `apps/server/test/unit/agency/proxy-agency-campaign-retry-rbac.routes.test.ts` | 11 |
| `apps/server/test/unit/agency/proxy-agency-campaign-retry.routes.test.ts` | 41 |
| `apps/server/test/unit/agency/proxy-agency-campaign-series.routes.test.ts` | 41 |
| `apps/server/test/unit/agency/proxy-agency-campaign-stats-enrichment.routes.test.ts` | 26 |
| `apps/server/test/unit/agency/proxy-agency-campaign-transition-actor.routes.test.ts` | 30 |
| `apps/server/test/unit/agency/proxy-agency-campaigns.routes.test.ts` | 139 |
| `apps/server/test/unit/agency/proxy-agency-grouped-stats.routes.test.ts` | 111 |
| `apps/server/test/unit/agency/proxy-agency-my-surfaces.routes.test.ts` | 78 |
| `apps/server/test/unit/agency/proxy-agency-roster.routes.test.ts` | 69 |
| `apps/server/test/unit/agency/proxy-agency-route-table.test.ts` | 29 |
| `apps/server/test/unit/agency/proxy-agency-spine.routes.test.ts` | 40 |
| `apps/server/test/unit/agency/proxy-agency-staffing.routes.test.ts` | 81 |
| `apps/server/test/unit/agency/proxy-agency-station.routes.test.ts` | 10 |
| `apps/server/test/unit/agency/reaper.test.ts` | 43 |
| `apps/server/test/unit/agency/retry-policy.test.ts` | 23 |
| `apps/server/test/unit/agency/retry-selector-parse.test.ts` | 34 |
| `apps/server/test/unit/agency/roster-row-identity.test.ts` | 3 |
| `apps/server/test/unit/agency/runtime-collapses.test.ts` | 7 |
| `apps/server/test/unit/agency/session-join-conflict-route.test.ts` | 14 |
| `apps/server/test/unit/agency/spine-filters.test.ts` | 34 |
| `apps/server/test/unit/agency/spine-read-routes.test.ts` | 23 |
| `apps/server/test/unit/agency/station-heartbeat-grace.test.ts` | 19 |
| `apps/server/test/unit/agency/station-reconnect-frame.test.ts` | 4 |
| `apps/server/test/unit/agency/station-registry.test.ts` | 29 |
| `apps/server/test/unit/agency/station-supersede-stomp.test.ts` | 10 |
| `apps/server/test/unit/agency/station-token.test.ts` | 5 |
| `apps/server/test/unit/agency/supervisor-stats.test.ts` | 26 |
| `apps/server/test/unit/agency/wrapup-manager.test.ts` | 34 |

### `apps/server/src/agency/agent-record/`

The three agent-record reads, re-exported from `agency/agent-record.ts` (import from that path): `stats.ts` (the agent's own record: bucket vocabulary, query parsing, bucket SQL, occupancy fold), `roster.ts` (the supervisor's roster: vocabulary, parsing, percentiles, sort), `grouped.ts` (the grouped read: dimensions, zone rule, parsing). Tested through `agent-record.test.ts` and the agent-record route and repository suites above.

Files: `grouped.ts`, `roster.ts`, `stats.ts`

### `apps/server/src/agency/dialer/`

The dialer's internals, split out of `agency-dialer.ts`: `live-attempt.ts` (the `LiveAttempt` record, `isUnannounced`, the panel builder) and `contact-settlement.ts` (`settleContact`: the our-fault / retry-policy routing of an ended attempt's contact). Tested through the `AgencyDialer` suites above (`agency-dialer`, `late-binding`, `canceled-outcome-ledger`, `our-fault-redial`, the chaos suites).

Files: `contact-settlement.ts`, `live-attempt.ts`

### `apps/server/src/agency/softphone/`

The soft phone's runtime (docs/softphone.md §4, §5): `softphone-service.ts` (`SoftphoneService`, `AgencyRuntime.softphone`: place, hang up, details, outcome, DNC, switch and return, reads; typed refusals, no HTTP), `manual-dialer.ts` (`ManualDialer`: dials a committed row agent-first through the bridge with a `manual` correlation, applies lifecycle events in order, settles unanswered calls, re-attaches on reconnect, takes the sweeps' closed rows), `manual-predial.ts` (number, caller ID, roster match, calling window, DNC, overrides), `manual-disposition.ts` (catalog, outcome and roster decision, and the retry-policy decision for a call closed with no outcome), `manual-settlement.ts` (that decision read and written for the dialer and the reaper), `softphone-audit.ts` (the one writer of `agency_session.softphone_started` / `.softphone_ended`), `call-fields.ts` (call-field values against the set in force), `session-guard.ts` (`setAvailableGuarded`: the `available` write and its `manual_call_live` refusal), `types.ts` (the refusal union and actor).

Files: `call-fields.ts`, `manual-dialer.ts`, `manual-disposition.ts`, `manual-predial.ts`, `manual-settlement.ts`, `session-guard.ts`, `softphone-audit.ts`, `softphone-service.ts`, `types.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/agency/chaos/softphone-restart-mid-call.test.ts` | 3 |
| `apps/server/test/integration/agency/softphone-agent-claim.test.ts` | 8 |
| `apps/server/test/integration/agency/softphone-manual-dialer.test.ts` | 10 |
| `apps/server/test/integration/agency/softphone-runtime-e2e.test.ts` | 14 |
| `apps/server/test/unit/agency/softphone/manual-dialer-rules.test.ts` | 5 |
| `apps/server/test/unit/agency/softphone/manual-disposition.test.ts` | 19 |
| `apps/server/test/unit/agency/softphone/manual-predial.test.ts` | 21 |

### `apps/server/src/agency/pacing/`

The pacing engine's parts, split out of `pacing-engine.ts`: `leader-lease.ts` (the per-campaign Redis leader lease), `campaign-announcer.ts` (the `campaign_state` broadcasts and their `flagGated` / `reportedStuck` latches), `caller-id-pool.ts` (usable caller IDs and the round-robin pick), `in-flight.ts` (tracking in-flight ticks and completion notices so `stop()` can wait for them). Tested through the `PacingEngine` suites above.

Files: `caller-id-pool.ts`, `campaign-announcer.ts`, `in-flight.ts`, `leader-lease.ts`

### `apps/server/src/ai/`

The AI client layer every AI request goes through: `createAiClient` (a builder per provider, typed over `AiProvider`) and the clients for `openai_compatible` and `azure_openai` (one Chat Completions mapping, `openai-chat.ts`) and `gemini` (native SDK, Files API, per-family thinking and sampling).

Files: `azure-openai.client.ts`, `factory.ts`, `gemini.client.ts`, `index.ts`, `openai-chat.ts`, `openai-compatible.client.ts`, `types.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/ai/factory.test.ts` | 4 |
| `apps/server/test/unit/ai/gemini.client.test.ts` | 8 |
| `apps/server/test/unit/ai/openai-clients.test.ts` | 10 |

### `apps/server/src/analysis/`

LLM call analysis: the analysis service (on an `ai/` client) and prompt builder, dimension presets, the campaign preflight for analysis profiles, and the bridge analysis hooks implementation.

Files: `analysis.service.ts`, `bridge-analysis-hooks.ts`, `dimension-presets.ts`, `index.ts`, `profile-preflight.ts`, `prompt-builder.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/analysis/pipeline.test.ts` | ~12 |
| `apps/server/test/unit/analysis/analysis.service.test.ts` | 22 |
| `apps/server/test/unit/analysis/bootstrap-analysis.test.ts` | 10 |
| `apps/server/test/unit/analysis/bridge-analysis-hooks.test.ts` | 30 |
| `apps/server/test/unit/analysis/dimension-presets.test.ts` | 10 |
| `apps/server/test/unit/analysis/index.test.ts` | 9 |
| `apps/server/test/unit/analysis/profile-preflight.test.ts` | 6 |
| `apps/server/test/unit/analysis/prompt-builder.test.ts` | 33 |

### `apps/server/src/analytics/`

PostHog client, product events and LLM observability events (off unless `POSTHOG_ENABLED`).

Files: `client.ts`, `llm-observability.ts`, `posthog.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/analytics/dialer-events.test.ts` | 7 |
| `apps/server/test/unit/analytics/posthog.test.ts` | 10 |
| `apps/server/test/unit/analytics/webrtc-analytics.test.ts` | 16 |

### `apps/server/src/api/`

The HTTP surface: the four area plugins (`platform`, `agency`, `voice`, `analysis`), `callCore` and `forwardCore` (`core-dispatch.ts`; `forwardCore` answers the public request with the internal handler's status and body) and the internal handler instance (`core-handlers.ts`), the id guard for agency routes, and profile-route auth.

Files: `agency-id-guard.ts`, `agency.plugin.ts`, `analysis.plugin.ts`, `core-dispatch.ts`, `core-handlers.ts`, `platform.plugin.ts`, `profile-route-auth.ts`, `voice.plugin.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/api/account.routes.test.ts` | ~3 |
| `apps/server/test/integration/api/agency-ingest-job-owner.test.ts` | ~3 |
| `apps/server/test/integration/api/agency-my-campaigns.routes.test.ts` | ~27 |
| `apps/server/test/integration/api/agency-offboarding-staffing.test.ts` | ~17 |
| `apps/server/test/integration/api/agency-performance-access.test.ts` | ~16 |
| `apps/server/test/integration/api/agency-performance-forwarding.test.ts` | ~23 |
| `apps/server/test/integration/api/agency-runtime-routes.test.ts` | ~19 |
| `apps/server/test/integration/api/agency-session-conflict-forward.test.ts` | ~13 |
| `apps/server/test/integration/api/agency-spine-export.e2e.test.ts` | ~4 |
| `apps/server/test/integration/api/agency-staffing.routes.test.ts` | ~51 |
| `apps/server/test/integration/api/agency-tenant-isolation.test.ts` | ~12 |
| `apps/server/test/integration/api/auth.routes.test.ts` | ~19 |
| `apps/server/test/integration/api/invite-every-role.test.ts` | 12 |
| `apps/server/test/integration/api/invite-security-audit.test.ts` | 47 |
| `apps/server/test/integration/api/notification.routes.test.ts` | ~6 |
| `apps/server/test/integration/api/phone-number.routes.test.ts` | ~4 |
| `apps/server/test/integration/api/platform-onboarding.e2e.test.ts` | ~2 |
| `apps/server/test/integration/api/super-admin.routes.test.ts` | ~45 |
| `apps/server/test/integration/api/tenant.routes.test.ts` | ~17 |
| `apps/server/test/integration/api/user.routes.test.ts` | ~15 |
| `apps/server/test/integration/api/voice-routes.test.ts` | ~7 |
| `apps/server/test/integration/api/webrtc-recordings.routes.test.ts` | ~11 |
| `apps/server/test/unit/api/agency-agent-reach.test.ts` | 3 |
| `apps/server/test/unit/api/agency-route-table.test.ts` | 9 |
| `apps/server/test/unit/api/agency-station-route.test.ts` | 2 |
| `apps/server/test/unit/api/core-dispatch.test.ts` | 13 |
| `apps/server/test/unit/api/platform-agent-reach.test.ts` | 4 |
| `apps/server/test/unit/api/profile-route-auth.test.ts` | 13 |
| `apps/server/test/unit/api/route-table.test.ts` | 3 |
| `apps/server/test/unit/api/voice-route-table.test.ts` | 1 |

### `apps/server/src/api/middleware/`

App-wide middleware: rate limiter and its buckets, error handler with the `22P02` backstop, 5xx error mask, session and tenant-context middleware, the membership cache key the tenant context reads and the routes that change a membership delete (`membership-cache-key.ts`), internal tenancy headers.

Files: `agency-error-handler.ts`, `auth.middleware.ts`, `error-handler.middleware.ts`, `error-mask.middleware.ts`, `headers.ts`, `membership-cache-key.ts`, `rate-limit.middleware.ts`, `tenant-context.middleware.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/api/middleware/error-handler.middleware.test.ts` | 11 |
| `apps/server/test/unit/api/middleware/error-mask.integration.test.ts` | 5 |
| `apps/server/test/unit/api/middleware/error-mask.middleware.test.ts` | 17 |
| `apps/server/test/unit/api/middleware/headers.test.ts` | 2 |
| `apps/server/test/unit/api/middleware/rate-limit.app-scope.test.ts` | 8 |
| `apps/server/test/unit/api/middleware/rate-limit.middleware.test.ts` | 38 |
| `apps/server/test/unit/api/middleware/rate-limit.scope.test.ts` | 3 |
| `apps/server/test/unit/api/middleware/tenant-context.middleware.test.ts` | 24 |

### `apps/server/src/api/responses/`

Response serialisers for campaigns and calls.

Files: `agency-campaign.response.ts`, `webrtc-call.response.ts`

_No dedicated test files._

### `apps/server/src/api/routes/`

Route handlers. Public API layer: `auth`, `tenant`, `account`, `user`, `invites`, `notification`, `feature-flags`, `super-admin*`, `proxy-agency-*`, `dnc`, `phone-number`, `call-analysis-profiles`. Internal handler instance: `agency.routes.ts`, `agency-campaigns.routes.ts`, `agency-agents.routes.ts`. Voice engine: `webhooks.routes.ts`, `webrtc-call.routes.ts`. Analysis: `webrtc-recordings.routes.ts`.

Route families: a large plugin keeps its exported function, hooks and module note in `<family>.routes.ts` and registers its routes from `<family>/` on the same instance, so the hooks apply to every one of them and the area plugins are unchanged: `agency/` (sessions, attempts, the soft phone's internal handlers and their refusal statuses and envelope, shared helpers), `agency-campaigns/` (guards with the `ownedCampaign` preHandler, crud with the batched `GET /summaries`, stats, spine, retry, lifecycle), `proxy-agency-campaigns/` (ownership, crud, stats, activity, spine with the CSV export drain, lifecycle, retry, ingest), `proxy-agency-performance/` (the per-agent pairs, the whole-floor reads, shared), `proxy-agency-staffing/` (the `my-*` reads, campaign agents), `proxy-agency-softphone/` (the soft phone, docs/softphone.md §6: sessions and the switch, calls, reads, settings, shared actor / flag / envelope / enrichment), `super-admin/` (login, own account, tenants, admins, concurrency). Source-text guards read a whole family (`test/helpers/route-source.ts`).

Shared helpers (`helpers/`): `core-campaign.ts` (`fetchOwnedCoreCampaign`, the one campaign ownership probe, and `stringField`), `csv-attachment.ts` (the CSV `Content-Disposition` pair), `drain-pages.ts` (the CSV exports' page loop), `parse-or-400.ts` (one 400 per validation dialect), `path-params.ts`, `read-cursor.ts` (`readKeysetCursor`), `settled.ts` (`settledValue`: independent reads started together, answered in order).

Files: `account.routes.ts`, `agency-agents.routes.ts`, `agency-campaigns.routes.ts`, `agency-campaigns/crud.ts`, `agency-campaigns/guards.ts`, `agency-campaigns/lifecycle.ts`, `agency-campaigns/retry.ts`, `agency-campaigns/spine.ts`, `agency-campaigns/stats.ts`, `agency.routes.ts`, `agency/attempts.ts`, `agency/helpers.ts`, `agency/sessions.ts`, `agency/softphone-answer.ts`, `agency/softphone.ts`, `auth.routes.ts`, `call-analysis-profiles.routes.ts`, `dnc.routes.ts`, `feature-flags.routes.ts`, `helpers/core-campaign.ts`, `helpers/csv-attachment.ts`, `helpers/drain-pages.ts`, `helpers/parse-or-400.ts`, `helpers/path-params.ts`, `helpers/read-cursor.ts`, `helpers/settled.ts`, `helpers/softphone-list-query.ts`, `invites.routes.ts`, `notification.routes.ts`, `phone-number.routes.ts`, `proxy-agency-agent.routes.ts`, `proxy-agency-calls.routes.ts`, `proxy-agency-campaigns.routes.ts`, `proxy-agency-campaigns/activity.ts`, `proxy-agency-campaigns/crud.ts`, `proxy-agency-campaigns/ingest.ts`, `proxy-agency-campaigns/lifecycle.ts`, `proxy-agency-campaigns/ownership.ts`, `proxy-agency-campaigns/retry.ts`, `proxy-agency-campaigns/spine.ts`, `proxy-agency-campaigns/stats.ts`, `proxy-agency-performance.routes.ts`, `proxy-agency-performance/floor.ts`, `proxy-agency-performance/per-agent.ts`, `proxy-agency-performance/shared.ts`, `proxy-agency-softphone.routes.ts`, `proxy-agency-softphone/calls.ts`, `proxy-agency-softphone/reads.ts`, `proxy-agency-softphone/sessions.ts`, `proxy-agency-softphone/settings.ts`, `proxy-agency-softphone/shared.ts`, `proxy-agency-staffing.routes.ts`, `proxy-agency-staffing/campaign-agents.ts`, `proxy-agency-staffing/my.ts`, `proxy-agency-station.routes.ts`, `super-admin-account-settings.routes.ts`, `super-admin-feature-flags.routes.ts`, `super-admin-phone.routes.ts`, `super-admin-telephony-credentials.routes.ts`, `super-admin-usage-counts.routes.ts`, `super-admin.routes.ts`, `super-admin/account.ts`, `super-admin/admins.ts`, `super-admin/concurrency.ts`, `super-admin/login.ts`, `super-admin/tenants.ts`, `tenant.routes.ts`, `user.routes.ts`, `webhooks.routes.ts`, `webrtc-call.routes.ts`, `webrtc-recordings.routes.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/api/routes/account.routes.test.ts` | 10 |
| `apps/server/test/unit/api/routes/call-analysis-profiles.test.ts` | 21 |
| `apps/server/test/unit/api/routes/feature-flags-client.test.ts` | 3 |
| `apps/server/test/unit/api/routes/feature-flags-internal.test.ts` | 22 |
| `apps/server/test/unit/api/routes/helpers/core-campaign.test.ts` | 4 |
| `apps/server/test/unit/api/routes/helpers/csv-attachment.test.ts` | 11 |
| `apps/server/test/unit/api/routes/helpers/parse-or-400.test.ts` | 4 |
| `apps/server/test/unit/api/routes/invites.routes.test.ts` | 140 |
| `apps/server/test/unit/api/routes/membership-fail-closed.test.ts` | 7 |
| `apps/server/test/unit/api/routes/notification.routes.test.ts` | 14 |
| `apps/server/test/unit/api/routes/phone-numbers-byoc-merge.test.ts` | 6 |
| `apps/server/test/unit/api/routes/proxy-feature-flags.routes.test.ts` | 4 |
| `apps/server/test/unit/api/routes/super-admin-account-settings.test.ts` | 24 |
| `apps/server/test/unit/api/routes/super-admin-accounts.test.ts` | 38 |
| `apps/server/test/unit/api/routes/super-admin-feature-flags.test.ts` | 22 |
| `apps/server/test/unit/api/routes/super-admin-memberships.test.ts` | 62 |
| `apps/server/test/unit/api/routes/super-admin-phone.test.ts` | 10 |
| `apps/server/test/unit/api/routes/super-admin-telephony-credentials.test.ts` | 38 |
| `apps/server/test/unit/api/routes/super-admin-usage-counts.test.ts` | 22 |
| `apps/server/test/unit/api/routes/tenant.routes.test.ts` | 9 |
| `apps/server/test/unit/api/routes/user-cache-invalidation.wiring.test.ts` | 4 |
| `apps/server/test/unit/api/routes/user-invite-mailer-isolation.test.ts` | 6 |
| `apps/server/test/unit/api/routes/user-offboarding-staffing.test.ts` | 30 |
| `apps/server/test/unit/api/routes/user.routes.test.ts` | 47 |
| `apps/server/test/unit/api/routes/voicelink-webhooks.test.ts` | 4 |
| `apps/server/test/unit/api/routes/webrtc-recordings.test.ts` | 6 |
| `apps/server/test/unit/agency/proxy-agency-softphone.routes.test.ts` | 42 |
| `apps/server/test/unit/agency/softphone-internal-routes.test.ts` | 43 |
| `apps/server/test/integration/api/softphone-routes.test.ts` | 11 |
| `apps/server/test/integration/api/softphone-policy-routes.test.ts` | 17 |

### `apps/server/src/api/validators/`

Zod request validators for the platform, super-admin and profile routes.

Files: `analytics-dimension.validator.ts`, `auth.validator.ts`, `call-analysis-profile.validator.ts`, `invite.validator.ts`, `notification.validator.ts`, `phone-number.validator.ts`, `super-admin-feature-flags.validator.ts`, `super-admin.validator.ts`, `user.validator.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/api/validators/analytics-dimension.validator.test.ts` | 10 |
| `apps/server/test/unit/api/validators/auth.validator.test.ts` | 7 |
| `apps/server/test/unit/api/validators/call-analysis-profile.validator.test.ts` | 8 |
| `apps/server/test/unit/api/validators/phone-number.validator.test.ts` | 6 |
| `apps/server/test/unit/api/validators/super-admin.validator.test.ts` | 56 |
| `apps/server/test/unit/api/validators/user.validator.test.ts` | 12 |
| `apps/server/test/unit/validators/notification.validator.test.ts` | 24 |

### `apps/server/src/audio/`

Clip decoding to PCM (`decode.ts`, decoder toolchain and truncation guard), `ensurePcmClip`, telephony clip format.

Files: `decode.ts`, `ensure-pcm-clip.ts`, `telephony-clip.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/audio/decode-missing-decoder.test.ts` | 3 |
| `apps/server/test/unit/audio/decode.test.ts` | 63 |
| `apps/server/test/unit/audio/decoder-toolchain-packaging.test.ts` | 6 |
| `apps/server/test/unit/audio/ensure-pcm-clip.test.ts` | 17 |
| `apps/server/test/unit/audio/telephony-clip.test.ts` | 16 |

### `apps/server/src/audit/`

Both audit writers and their buffer (`audit-logger.ts` → `audit_logs`; `platform/` → `platform_audit_log`), partition maintenance and retention, super-admin audit helper (decision B7).

Files: `audit-buffer.ts`, `audit-logger.ts`, `audit-partition-maintenance.ts`, `audit-retention.ts`, `audit.types.ts`, `super-admin-audit.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/audit/audit-loggers.test.ts` | ~4 |
| `apps/server/test/integration/audit/audit-partition-maintenance.test.ts` | ~4 |
| `apps/server/test/unit/audit/audit-partition-maintenance.test.ts` | 7 |
| `apps/server/test/unit/audit/audit-retention.test.ts` | 8 |
| `apps/server/test/unit/audit/super-admin-audit-failure-logged.test.ts` | 4 |

### `apps/server/src/audit/platform/`

The platform audit logger: catalog, vocabulary and actor types for `platform_audit_log`.

Files: `audit-actor.ts`, `audit-buffer.ts`, `audit-logger.ts`, `catalog.ts`, `vocabulary.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/audit/platform/audit-actor-call-sites.test.ts` | 7 |
| `apps/server/test/unit/audit/platform/audit-actor.test.ts` | 7 |
| `apps/server/test/unit/audit/platform/catalog.test.ts` | 6 |
| `apps/server/test/unit/audit/platform/concurrency-super-admin-only.test.ts` | 4 |
| `apps/server/test/unit/audit/platform/vocabulary.test.ts` | 20 |

### `apps/server/src/auth/`

Firebase initialisation and identity, the session middleware and session payload, session email rules, the super-admin JWT middleware.

Files: `firebase-identity.ts`, `firebase.ts`, `session-email.ts`, `session-payload.ts`, `session.middleware.ts`, `super-admin.middleware.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/auth/auth-session-email-verified.test.ts` | 6 |
| `apps/server/test/unit/auth/firebase-identity.test.ts` | 20 |
| `apps/server/test/unit/auth/invite-claim-session-composition.test.ts` | 11 |
| `apps/server/test/unit/auth/session-email.test.ts` | 6 |
| `apps/server/test/unit/auth/session.middleware.test.ts` | 8 |

### `apps/server/src/bootstrap/`

Background work per module area (`platform`, `voice`, `agency`, `analysis`), each returning a stop function; the singletons for the voice engine and dialer runtime.

Files: `agency.ts`, `analysis.ts`, `platform.ts`, `voice.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/bootstrap/agency-reaper-wiring.test.ts` | 4 |
| `apps/server/test/unit/bootstrap/platform.test.ts` | 4 |

### `apps/server/src/cache/`

Redis-backed cache with an optional in-process layer, cross-instance invalidation, and the retried revocation path (Q5).

Files: `local-cache.ts`, `redis-cache.ts`, `revocation-unavailable.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/cache/local-cache-invalidation.test.ts` | ~9 |
| `apps/server/test/integration/cache/membership-invalidation.test.ts` | ~3 |
| `apps/server/test/integration/cache/redis-cache.delbypattern.test.ts` | ~4 |
| `apps/server/test/integration/cache/tenant-record-cache.test.ts` | ~10 |
| `apps/server/test/unit/cache/local-cache-wiring.test.ts` | 7 |
| `apps/server/test/unit/cache/local-cache.test.ts` | 15 |
| `apps/server/test/unit/cache/redis-cache-invalidation-order.test.ts` | 4 |
| `apps/server/test/unit/cache/redis-cache-revocation.test.ts` | 3 |
| `apps/server/test/unit/cache/redis-cache.test.ts` | 23 |

### `apps/server/src/config/`

Environment parsing: `index.ts` (exits on invalid config), `load.ts`, `schema.ts` (disjoint-keys check), `env.ts`, call duration limits.

Files: `call-duration-limits.ts`, `env.ts`, `index.ts`, `load.ts`, `schema.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/config/analysis-config.test.ts` | 12 |
| `apps/server/test/unit/config/blocks-disjoint.test.ts` | 2 |
| `apps/server/test/unit/config/config.test.ts` | 3 |
| `apps/server/test/unit/config/open-questions-config.test.ts` | 38 |
| `apps/server/test/unit/config/otel-config.test.ts` | 4 |
| `apps/server/test/unit/config/schema.dialer-analysis.test.ts` | 11 |

### `apps/server/src/config/blocks/`

One config block per module area: `base`, `platform`, `agency`, `voice`, `analysis` (see `docs/seams.md`).

Files: `agency.ts`, `analysis.ts`, `base.ts`, `platform.ts`, `voice.ts`

_No dedicated test files._

### `apps/server/src/contact-lists/`

CSV parser used by roster ingest.

Files: `csv-parser.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/contact-lists/csv-parser.test.ts` | 31 |

### `apps/server/src/core/`

The voice engine: WebRTC bridge manager and session, the telephony guard host and the global / account / provider concurrency guards, concurrency control for the seam, telephony release, paced audio streamer and pace schedule, webhook URL builder; and the dialer analysis worker, its handle, runner and transcript-quality checks.

Files: `account-concurrency-guard.ts`, `concurrency-guard.ts`, `dialer-analysis-runner.ts`, `dialer-analysis-worker-handle.ts`, `dialer-analysis-worker.ts`, `pace-schedule.ts`, `paced-audio-streamer.ts`, `provider-concurrency-guard.ts`, `telephony-concurrency.ts`, `telephony-guard-host.ts`, `telephony-release.ts`, `transcript-quality.ts`, `voice-concurrency-control.ts`, `webhook-url-builder.ts`, `webrtc-bridge-manager.ts`, `webrtc-bridge-session.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/core/telephony-guard-scopes.test.ts` | ~10 |
| `apps/server/test/integration/core/voice-engine.test.ts` | ~9 |
| `apps/server/test/unit/core/account-concurrency-guard.test.ts` | 60 |
| `apps/server/test/unit/core/concurrency-extend-lock.test.ts` | 21 |
| `apps/server/test/unit/core/concurrency-guard.test.ts` | 25 |
| `apps/server/test/unit/core/dialer-analysis-race.test.ts` | 4 |
| `apps/server/test/unit/core/dialer-analysis-runner.test.ts` | 32 |
| `apps/server/test/unit/core/dialer-analysis-worker-handle.test.ts` | 3 |
| `apps/server/test/unit/core/dialer-analysis-worker.test.ts` | 13 |
| `apps/server/test/unit/core/group-lease-hooks.test.ts` | 1 |
| `apps/server/test/unit/core/pace-schedule.test.ts` | 15 |
| `apps/server/test/unit/core/paced-audio-streamer.test.ts` | 15 |
| `apps/server/test/unit/core/provider-concurrency-guard.test.ts` | 19 |
| `apps/server/test/unit/core/telephony-concurrency-group.test.ts` | 1 |
| `apps/server/test/unit/core/telephony-guard-host.test.ts` | 31 |
| `apps/server/test/unit/core/telephony-release-wiring.test.ts` | 2 |
| `apps/server/test/unit/core/telephony-release.test.ts` | 41 |
| `apps/server/test/unit/core/voice-concurrency-control.test.ts` | 8 |
| `apps/server/test/unit/core/webhook-url-builder.test.ts` | 6 |
| `apps/server/test/unit/core/webrtc-answer-anchor.test.ts` | 3 |
| `apps/server/test/unit/core/webrtc-bridge-borrowed-socket-soak.test.ts` | 2 |
| `apps/server/test/unit/core/webrtc-bridge-credential-hangup.test.ts` | 5 |
| `apps/server/test/unit/core/webrtc-bridge-late-binding.test.ts` | 17 |
| `apps/server/test/unit/core/webrtc-bridge-manager.bridged.test.ts` | 8 |
| `apps/server/test/unit/core/webrtc-bridge-manager.seams.test.ts` | 12 |
| `apps/server/test/unit/core/webrtc-bridge-manager.test.ts` | 62 |
| `apps/server/test/unit/core/webrtc-bridge-ring-cancel.test.ts` | 15 |
| `apps/server/test/unit/core/webrtc-bridge-manual-correlation.test.ts` | 6 |
| `apps/server/test/unit/core/webrtc-bridge-seam-contract.test.ts` | 3 |
| `apps/server/test/unit/core/webrtc-bridge-session.test.ts` | 31 |
| `apps/server/test/unit/core/webrtc-scenarios.test.ts` | 13 |

### `apps/server/src/core/bridge/`

Parts of the WebRTC bridge split out of `webrtc-bridge-manager.ts`, which stays the seam's module path (docs/seams.md §3.1) and re-exports the types: `bridge-types.ts` (`WebRtcCallError` and the exported seam types), `ws-tokens.ts` (`BridgeWsTokens`: the carrier's per-call tokens and the unstored-token memory; `verifyWsToken` stays on the manager as a delegate), `admission.ts` (`admitBridgeCall`: the slot acquire and its refusal mapping). None imports metrics. Tested through the bridge suites above.

Files: `admission.ts`, `bridge-types.ts`, `ws-tokens.ts`

### `apps/server/src/db/`

The agency repository (`agency.repository.ts`, decision B12), membership invites, notification deliveries and preferences, the telephony provider repository (uncached, so a status change is seen on the next read), and their models.

The agency repository is a folder, `repositories/agency/`, behind the `agency.repository.ts` barrel: every caller outside the folder imports the barrel and the unit suites `vi.mock` it, so a mock of the barrel replaces what callers use. One file per class: `campaign.repository.ts` (`AgencyCampaignRepository`; its retry and dashboard methods delegate to free functions in `campaign-retry.ts` and `campaign-stats.ts`), `contact.repository.ts`, `attempt.repository.ts`, `agent-session.repository.ts`, `fleet-metrics.repository.ts` (`AgencyAbandonmentRepository`, `AgencyLiveConcurrencyRepository`), `manual-call.repository.ts` (`AgencyManualCallRepository`: the soft phone's `agency_manual_calls` spine, docs/softphone.md), `softphone-settings.repository.ts` (`AgencySoftphoneSettingsRepository` and the settings validator) and `agent-stats.repository.ts` (`AgencyAgentStatsRepository`; `roster` and `groupedStats` delegate to `agent-roster-stats.ts` and `agent-grouped-stats.ts`). Three leaves hold what more than one file emits: `sql-fragments.ts` (the shared SQL spellings: phone digits, resolved zone, occupancy intervals, the five attempt metrics, the campaign INSERT columns), `query-builders.ts` (parameter accumulator, filter and keyset builders) and `projections.ts` (row to wire shape, including the manual call's `AgencyManualCall`). Files in the folder import only the leaves, the delegate files and external modules, never the barrel or another class.

Files: `models/agency.model.ts`, `models/membership-invite.model.ts`, `models/notification.model.ts`, `repositories/agency.repository.ts`, `repositories/agency/agent-grouped-stats.ts`, `repositories/agency/agent-roster-stats.ts`, `repositories/agency/agent-session.repository.ts`, `repositories/agency/agent-stats.repository.ts`, `repositories/agency/attempt.repository.ts`, `repositories/agency/campaign-retry.ts`, `repositories/agency/campaign-stats.ts`, `repositories/agency/campaign.repository.ts`, `repositories/agency/contact.repository.ts`, `repositories/agency/fleet-metrics.repository.ts`, `repositories/agency/manual-call.repository.ts`, `repositories/agency/projections.ts`, `repositories/agency/query-builders.ts`, `repositories/agency/softphone-settings.repository.ts`, `repositories/agency/sql-fragments.ts`, `repositories/membership-invite.repository.ts`, `repositories/notification-delivery.repository.ts`, `repositories/notification-preference.repository.ts`, `repositories/telephony-provider.repository.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/repositories/agency-ingest-job-account-scope.test.ts` | ~9 |
| `apps/server/test/integration/repositories/membership-invite-claim-confinement.test.ts` | ~7 |
| `apps/server/test/integration/repositories/notification-delivery.repository.test.ts` | ~42 |
| `apps/server/test/integration/repositories/notification-preference.repository.test.ts` | ~32 |
| `apps/server/test/integration/repositories/user-email-proof.test.ts` | ~31 |
| `apps/server/test/unit/db/repositories/membership-invite.repository.test.ts` | 38 |
| `apps/server/test/unit/db/repositories/notification-delivery.repository.test.ts` | 45 |
| `apps/server/test/unit/db/repositories/notification-preference.repository.test.ts` | 27 |
| `apps/server/test/unit/db/repositories/telephony-provider.repository.test.ts` | 6 |

### `apps/server/src/dnc/`

DNC list service and repository (`dnc_entries`, E.164 input, fail-closed reads; decision B8).

Files: `dnc.repository.ts`, `dnc.service.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/dnc/dnc-campaign-scope.test.ts` | ~10 |
| `apps/server/test/integration/dnc/dnc-index-usage.test.ts` | ~5 |
| `apps/server/test/integration/dnc/dnc-scope-sentinel.test.ts` | ~6 |
| `apps/server/test/unit/dnc/dnc.repository.test.ts` | 25 |
| `apps/server/test/unit/dnc/dnc.routes.test.ts` | 46 |
| `apps/server/test/unit/dnc/dnc.service.test.ts` | 21 |

### `apps/server/src/feature-flags/`

Feature-flag service, registry and initialisation.

Files: `feature-flag.service.ts`, `index.ts`, `registry.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/feature-flags/feature-flag.service.test.ts` | ~5 |
| `apps/server/test/unit/feature-flags/feature-flag.service.test.ts` | 46 |
| `apps/server/test/unit/feature-flags/flag-snapshot.test.ts` | 30 |
| `apps/server/test/unit/feature-flags/registry-contracts.test.ts` | 4 |
| `apps/server/test/unit/feature-flags/registry.test.ts` | 14 |

### `apps/server/src/invites/`

Invite issuing and invite state, and the membership provisioning `POST /users/invite` and the super-admin tenant create and add-user share (`membership-provisioning.ts`: the create-or-reactivate transactions, the proven-or-stub user, the guarded invitation).

Files: `invite-issuer.ts`, `membership-invite-state.ts`, `membership-provisioning.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/invites/invite-issuer.test.ts` | 26 |
| `apps/server/test/unit/invites/membership-provisioning.test.ts` | 5 |
| `apps/server/test/unit/invites/membership-invite-state.test.ts` | 6 |

### `apps/server/src/maintenance/`

Retention purge for analysis jobs, calls and transcripts.

Files: `retention-purge.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/maintenance/agency-retention-purge.test.ts` | ~6 |
| `apps/server/test/unit/maintenance/retention-purge.test.ts` | 16 |

### `apps/server/src/notifications/`

Mailjet client, notification engine (audience, catalog, delivery, period), invite mailer and token, campaign-completion mail, HTML escaping.

Files: `agency-campaign-completion.ts`, `engine/audience.ts`, `engine/catalog.ts`, `engine/deliver.ts`, `engine/period.ts`, `escape-html.ts`, `invite-mailer.ts`, `invite-token.ts`, `mailjet.client.ts`, `templates/agent-invite.template.ts`, `templates/invite-email.layout.ts`, `templates/invite-email.ts`, `templates/workspace-invite.template.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/notifications/agency-campaign-completion.test.ts` | 42 |
| `apps/server/test/unit/notifications/agency-campaign-unsubscribe.test.ts` | 8 |
| `apps/server/test/unit/notifications/agent-invite.template.test.ts` | 29 |
| `apps/server/test/unit/notifications/engine/audience.test.ts` | 34 |
| `apps/server/test/unit/notifications/engine/catalog.test.ts` | 28 |
| `apps/server/test/unit/notifications/engine/deliver.test.ts` | 6 |
| `apps/server/test/unit/notifications/engine/period.test.ts` | 4 |
| `apps/server/test/unit/notifications/invite-email.test.ts` | 25 |
| `apps/server/test/unit/notifications/invite-mailer.test.ts` | 77 |
| `apps/server/test/unit/notifications/invite-token.test.ts` | 14 |
| `apps/server/test/unit/notifications/mailjet.client.test.ts` | 8 |
| `apps/server/test/unit/notifications/workspace-invite.template.test.ts` | 19 |

### `apps/server/src/proxy/`

Path-traversal check used by `callCore` (`isUnsafeCorePath`).

Files: `safe-core-path.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/proxy/safe-core-path.test.ts` | 16 |

### `apps/server/src/rbac/`

`requirePermission` middleware over the roles and matrix in `packages/contracts/src/rbac.ts`.

Files: `rbac.middleware.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/rbac/rbac-middleware.test.ts` | 7 |
| `apps/server/test/unit/rbac/roles.agent.test.ts` | 18 |
| `apps/server/test/unit/rbac/roles.test.ts` | 19 |

### `apps/server/src/seams/`

The two cross-module seams: bridge → analysis hooks, super-admin → concurrency control (see `docs/seams.md`).

Files: `bridge-analysis-hooks.ts`, `concurrency-control.ts`

_No dedicated test files._

### `apps/server/src/services/`

Tenant and account name resolution for the internal tenancy headers.

Files: `tenant-name-resolver.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/services/tenant-name-resolver.test.ts` | 14 |
| `apps/server/test/unit/services/tenant-record-cache.edge.test.ts` | 7 |

### `apps/server/src/settings/`

Per-account settings resolved to effective values.

Files: `agency-account-settings.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/settings/agency-account-settings.test.ts` | ~1 |
| `apps/server/test/unit/settings/agency-account-settings.test.ts` | 13 |

### `apps/server/src/storage/`

The one S3 module (decision B14).

Files: `s3.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/storage/s3-ingest-reads.test.ts` | 9 |

### `apps/server/src/telephony/`

Telephony provider factory and types; the carrier modules (each carrier's media-stream protocol and hangup style, which the bridge asks instead of branching on a provider name); the VoiceLink adapter, media protocol, webhook normaliser, token manager and carrier fixture. `factory.ts` builds the service's own adapters from env and BYOC adapters from tenant credentials (`getForCredentialId`, decisions B18–B22): it peeks the credential row on every use and refuses another tenant or provider before any secret is opened, calls `resolve` only on a cache miss (keyed by peek's version list), and drops cached adapters only on `CredentialUnavailableError`, rethrowing transient errors unchanged.

Files: `carrier-module.ts`, `carrier-modules.ts`, `factory.ts`, `types.ts`, `webhook-grace.ts`, `voicelink/voicelink-carrier.fixture.json`, `voicelink/voicelink-token-manager.ts`, `voicelink/voicelink.adapter.ts`, `voicelink/voicelink.media.ts`, `voicelink/voicelink.types.ts`, `voicelink/voicelink.webhook.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/telephony/byoc-factory.test.ts` | 7 |
| `apps/server/test/unit/telephony/byoc-registry.test.ts` | 23 |
| `apps/server/test/unit/telephony/carrier-modules.test.ts` | 14 |
| `apps/server/test/unit/telephony/provider-capabilities.test.ts` | 6 |
| `apps/server/test/unit/telephony/voicelink/redact-url-tail.test.ts` | 7 |
| `apps/server/test/unit/telephony/voicelink/voicelink-carrier.fixture.test.ts` | 178 |
| `apps/server/test/unit/telephony/voicelink/voicelink-token-manager.test.ts` | 23 |
| `apps/server/test/unit/telephony/voicelink/voicelink.adapter.edge-cases.test.ts` | 14 |
| `apps/server/test/unit/telephony/voicelink/voicelink.adapter.test.ts` | 38 |
| `apps/server/test/unit/telephony/voicelink/voicelink.webhook.test.ts` | 125 |

### `apps/server/src/telephony/credentials/`

Per-tenant carrier credentials (BYOC, decisions B18–B22). `credential-sealer.ts`: AES-256-GCM envelope encryption under the env keyring (`TELEPHONY_CREDENTIAL_KEYS`), bound to tenant, credential, provider and version. `credential-specs.ts`: each BYOC carrier's form fields, validation and carrier check (Plivo). `credential-service.ts`: create, rotate, verify, disable, enable, revoke, the hourly sweep (shred revoked once their calls are past the 2 h post-end hold, prune retired versions), `peek(id, purpose)` (row checks only, nothing opened) and `resolve(id, purpose)` (grace versions opened best effort) for the registry; `CredentialUnavailableError` carries a `kind`, and `verify` opens only the current secret and answers `invalid_transition` or `version_conflict` when its version-pinned write does not land. `secret.ts`: a box that never prints its value. `safe-issues.ts`: validation messages with no submitted value. `index.ts`: the process's one service, built from config; a keyring with no entries after trim (`keyringEntries`) is no store.

Files: `credential-sealer.ts`, `credential-service.ts`, `credential-specs.ts`, `index.ts`, `safe-issues.ts`, `secret.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/telephony/credential-sealer.test.ts` | 30 |
| `apps/server/test/unit/telephony/credential-service.test.ts` | 49 |

### `apps/server/src/transcription/`

Transcriber factory, the Gemini transcriber (on the `ai/` gemini client) and the Sarvam transcriber, the recording fetcher with its host allow-list.

Files: `gemini-transcriber.ts`, `index.ts`, `recording-fetcher.ts`, `sarvam-transcriber.ts`, `types.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/transcription/gemini-transcriber.test.ts` | 20 |
| `apps/server/test/unit/transcription/index.test.ts` | 11 |
| `apps/server/test/unit/transcription/recording-fetcher.test.ts` | 29 |
| `apps/server/test/unit/transcription/sarvam-transcriber.test.ts` | 6 |

### `apps/server/src/tts/`

On-disk clip cache and its sweeper (no text-to-speech).

Files: `tts-file-cache.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/tts/hash-audio-file-content.test.ts` | 9 |
| `apps/server/test/unit/tts/tts-cache-sweep-liveness.test.ts` | 18 |
| `apps/server/test/unit/tts/tts-cache-sweep-metrics.test.ts` | 14 |
| `apps/server/test/unit/tts/tts-cache-sweep.test.ts` | 37 |
| `apps/server/test/unit/tts/tts-file-cache-atomic.test.ts` | 14 |
| `apps/server/test/unit/tts/tts-file-cache.test.ts` | 12 |

### `apps/server/src/utils/`

Shared helpers: audio and FIR filter, concurrency, decode gate, the one UUID shape check (`uuid.ts`, shared by routes and agency modules), phone normaliser, recording URL signing and resolution, recording proxy, URL redaction (logs and OTel spans), the OTel SDK's pure configuration (`otel-sdk-config.ts`: export interval, resource, metric views, fresh gauges, the bounded shutdown, and the trace config: pg without parameter values or pool-connect spans, untraced probes and PostHog), retry, safe emit, webhook base URL, WebSocket no-delay, abort errors.

Files: `abort-error.ts`, `audio-fir.ts`, `audio.ts`, `concurrency.ts`, `decode-gate.ts`, `otel-sdk-config.ts`, `phone-normalizer.ts`, `recording-proxy.ts`, `recording-url-resolver.ts`, `recording-url.ts`, `redact-url.ts`, `retry.ts`, `safe-emit.ts`, `uuid.ts`, `webhook-base.ts`, `ws-nodelay.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/utils/audio-downmix.test.ts` | 11 |
| `apps/server/test/unit/utils/audio-fir.test.ts` | 24 |
| `apps/server/test/unit/utils/audio.test.ts` | 41 |
| `apps/server/test/unit/utils/concurrency.core.test.ts` | 9 |
| `apps/server/test/unit/utils/concurrency.test.ts` | 14 |
| `apps/server/test/unit/utils/decode-gate.test.ts` | 23 |
| `apps/server/test/unit/utils/metrics-tts-clip-cache.test.ts` | 7 |
| `apps/server/test/unit/utils/otel-sdk-config.test.ts` | 35 |
| `apps/server/test/unit/utils/recording-proxy-resolve.test.ts` | 9 |
| `apps/server/test/unit/utils/recording-proxy.test.ts` | 25 |
| `apps/server/test/unit/utils/recording-url.test.ts` | 13 |
| `apps/server/test/unit/utils/trace-context.test.ts` | 4 |
| `apps/server/test/unit/utils/redact-url.test.ts` | 23 |
| `apps/server/test/unit/utils/retry.test.ts` | 9 |

### Cross-cutting tests (`apps/server`)

Scenario, flow, guard and setup tests that span several modules.

| Test file | Cases |
|---|---|
| `apps/server/test/integration/flows/concurrency-guards.test.ts` | ~24 |
| `apps/server/test/integration/flows/ensure-pcm-clip-heal.test.ts` | ~4 |
| `apps/server/test/integration/flows/feature-flag-rollout.test.ts` | ~4 |
| `apps/server/test/integration/flows/tts-cache-sweep-scale.test.ts` | ~6 |
| `apps/server/test/integration/scripts/create-super-admin.test.ts` | ~5 |
| `apps/server/test/unit/branding/no-parent-brand.test.ts` | 5 |
| `apps/server/test/unit/deploy/production-packaging.test.ts` | 15 |
| `apps/server/test/unit/scenarios/feature-flag-rollout-scenarios.test.ts` | 3 |
| `apps/server/test/unit/scenarios/stale-call-sweep-lifecycle-scenarios.test.ts` | 4 |
| `apps/server/test/unit/scenarios/voicelink-config-factory-scenarios.test.ts` | 5 |
| `apps/server/test/unit/scenarios/voicelink-webrtc-lifecycle-scenarios.test.ts` | 3 |
| `apps/server/test/unit/test-redis-guard.test.ts` | 7 |

### Load, soak and scenario suites (`apps/server`, 2026-10-23)

A full floor of agents under load, over real sockets, real Postgres and real Redis.
`apps/server/test/helpers/load-scale.ts` holds the shared knobs: default sizes keep each file
under about a minute, `LOAD_SCALE=<n>` multiplies them for a deliberate soak, and `LOAD_SEED`
pins the seeded PRNG (every file prints its seed). An `it.fails` case pins an open defect
([`status.md`](status.md), "Load and scenario suites") and goes red the moment it is fixed.

**Mocks** (`apps/server/test/mocks/`), Node-native on `ws` rather than WireMock: in this system
the server is the WebSocket *server* on both sockets that matter (consoles connect to the station
socket; VoiceLink dials out to the `websocket_url` sent in `add_lead`), so a mock carrier has to be
a WebSocket *client*, which a stub server cannot be.

| Mock | What it is |
|---|---|
| `mocks/voicelink/` | Scriptable VoiceLink carrier: login, `add_lead` and CDR REST with injectable faults (latency, status, hang, malformed JSON, TCP reset, held responses); per-call scripts that open the media WS to the server, send `start` (A-law 8 kHz), stream seeded audio, post webhooks (duplicated, shuffled, out of order) and end by any close code or a TCP destroy |
| `mocks/station-fleet.ts` | N agent consoles over real `ws` with real station tokens: heartbeat, ready / break / disposition, reconnect, network drop, silence, slow reader, rapid connect-disconnect, seeded hostile frames; frames recorded with timestamps |

| Test file | Cases | Guards |
|---|---|---|
| `apps/server/test/unit/load/load-scale.test.ts` | 3 | The shared PRNG is deterministic and in bounds |
| `apps/server/test/unit/load/mock-voicelink-carrier.test.ts` | 6 | The mock carrier itself: URL rewrite, auth and 422, fault ordering, a `start` the product parses, audio surviving the real codec |
| `apps/server/test/unit/telephony/voicelink/voicelink-adapter-mock-carrier.test.ts` | 18 | Adapter and token manager over real sockets: single-flight login under a burst, one re-login per 401 burst, faults fail only the dials they hit; 2 `it.fails` (no REST timeout) |
| `apps/server/test/unit/load/bridge-row-write-order.test.ts` | 1 | No live status lands over a terminal one, 200 calls with shuffled ringing / answered / terminal |
| `apps/server/test/unit/load/station-storm.test.ts` | 4 | 150 consoles across 3 tenants: registered once, no cross-talk, tab races leave one live station (4409 for the rest) |
| `apps/server/test/unit/load/station-heartbeat-scale.test.ts` | 1 | Exactly the silent consoles are reaped 4408 after grace; the sweep stops when the floor empties |
| `apps/server/test/unit/load/station-backpressure.test.ts` | 2 | Stalled consoles do not hold up broadcasts; 1 `it.fails` (unbounded send buffer) |
| `apps/server/test/unit/load/station-inbound-fuzz.test.ts` | 4 | About 2,800 seeded hostile frames never throw or disturb bystanders (the `null` frame crash); 1 `it.fails` (no frame-size limit) |
| `apps/server/test/unit/load/wrapup-manager-interleavings.test.ts` | 2 | Seeded interleavings of enter / disposition / force / cancel / timer: each wrap-up closes once, no early `auto_return` |
| `apps/server/test/unit/load/in-flight-contention.test.ts` | 2 | `InFlight.settle` waits only on work tracked at drain start |
| `apps/server/test/unit/load/audit-buffer-drain-under-load.test.ts` | 4 | Both audit buffers drain fully when shutdown lands mid-flush |
| `apps/server/test/unit/load/pacing-tick-properties.test.ts` | 1 | The real tick over 3,000 seeded floors: every term of the dial formula, longest-idle order, surplus release |
| `apps/server/test/unit/load/dialer-math-properties.test.ts` | 8 | Property families over retry, our-fault, abandonment, guardrail, calling hours, caller-id rotation |
| `apps/server/test/integration/load/voicelink-media-ws-load.test.ts` | ~7 | 50 simultaneous carrier streams in order both ways; token gate; `start` failures; slow carrier; every close shape settles once; mid-call reconnect |
| `apps/server/test/integration/load/voicelink-webhook-storm.test.ts` | ~3 | 40 calls of duplicated, shuffled, concurrent webhooks settle once with recordings and carrier ids kept; 1 `it.fails` (terminal overtaking `answered`) |
| `apps/server/test/integration/load/voicelink-full-stack.test.ts` | ~1 | Real app, real stations, pacing engine dialling through the real adapter into the mock carrier; no leaks |
| `apps/server/test/integration/load/station-floor.test.ts` | ~2 | 150-agent join / connect / available storm and a reconnect storm through the real routes |
| `apps/server/test/integration/load/station-floor-soak.test.ts` | ~1 | 100 agents, about 520 calls through wrap-up and disposition; console = Redis = session row |
| `apps/server/test/integration/load/floor-run.test.ts` | ~1 | 100 agents, 5 campaigns, 3 tenants, 2,200 contacts to exhaustion; invariants and the pacing law every round |
| `apps/server/test/integration/load/agent-churn.test.ts` | ~2 | Breaks, drops, re-attaches, leaves and late joins: no orphaned reservation; 1 `it.fails` (Available during an announced call) |
| `apps/server/test/integration/load/concurrency-cap.test.ts` | ~4 | Guards on real Redis gate dials without losing contacts; 2 `it.fails` (provider share ignored by the tick; refused dial stamped `dialed_at`) |
| `apps/server/test/integration/load/tenant-isolation.test.ts` | ~1 | A saturated tenant beside a small one: no starvation, caps and DNC scoped per tenant |
| `apps/server/test/integration/load/burst-answers.test.ts` | ~1 | 60 answers in one burst with a third of the stations lost: exactly those abandoned, the rest bridged once |
| `apps/server/test/integration/load/retry-storm.test.ts` | ~1 | Two leaders over a mostly-retryable roster: attempt numbers unique and gapless; retry campaign lineage |
| `apps/server/test/integration/load/campaign-controls.test.ts` | ~1 | Pause / resume / stop with 60 calls in flight: no dial after pause or stop, `stopping` → `stopped` once drained |
| `apps/server/test/integration/load/agent-state-linearizability.test.ts` | ~4 | Concurrent agent-state ops checked for linearizability against a model of the Lua scripts |
| `apps/server/test/integration/load/leader-lease-contention.test.ts` | ~4 | Exactly one pacing leader among racers; renew never extends a new holder |
| `apps/server/test/integration/load/concurrency-guard-storms.test.ts` | ~10 | Acquire / release / extend / reconcile storms never over cap, nothing leaked; 2 `it.fails` (lowered limit cached stale) |
| `apps/server/test/integration/load/token-redemption-races.test.ts` | ~5 | Station and carrier WS tokens: one redemption wins, purposes never cross |
| `apps/server/test/integration/load/contact-claim-contention.test.ts` | ~7 | Concurrent claimers and settlers, `SKIP LOCKED`, DNC racing claims, overlapping stranded-contact sweeps |
| `apps/server/test/integration/load/floor-morning-rush.test.ts` | ~5 | 90 agents sign in, join, connect and poll across 3 tenants; every body swept for foreign ids |
| `apps/server/test/integration/load/session-join-races.test.ts` | ~3 | Racing joins: one session, the documented 409, one "session started" event |
| `apps/server/test/integration/load/disposition-storm.test.ts` | ~2 | Concurrent and duplicate dispositions with supervisor reads: exactly-once effects, no deadlocks; 1 `it.fails` (stale replay reopens a contact) |
| `apps/server/test/integration/load/campaign-mutation-races.test.ts` | ~6 | Racing lifecycle and PATCH requests end legal and audited; 2 `it.fails` (audit `from`, combined calling window) |
| `apps/server/test/integration/load/roster-ingest-concurrency.test.ts` | ~3 | Concurrent ingests: totals exact, chunk idempotency keys honoured |
| `apps/server/test/integration/load/rate-limit-bursts.test.ts` | ~5 | Exact ceilings, 429 body and headers, per-client buckets, probes and webhooks unaffected |
| `apps/server/test/integration/load/resource-exhaustion.test.ts` | ~3 | A tiny and a starved pg pool, Redis cut and restored: probes correct, no 401 sign-outs, recovery |
| `apps/server/test/integration/load/hostile-input-fuzz.test.ts` | ~5 | Seeded fuzz over every route from `onRoute`: 4xx per contract, never a 500 or a stack; 1 `it.fails` (headerless multipart part hangs) |

Harnesses beside them: `integration/load/floor-harness.ts` and `floor-pool.ts` (multi-tenant world
on one real `AgencyRuntime`), `station-floor-harness.ts`, `voicelink-load-harness.ts` (real
`buildApp` pointed at the mock carrier, `assertNoLeaks`), `load-harness.ts` (bulk-seeded floor for
the API suites), `unit/load/station-load-harness.ts`.

## `grafana`

### `grafana/`

Agency's alert rules and dashboard as a Terraform root module with its own local state (decision B6); routing comes from the stack's shared notification policy. See `grafana/README.md`.

Files: `README.md`, `dashboards/magick-agency-overview.json`, `scripts/metric-declarations.mjs`, `terraform/alert-rules.tf`, `terraform/alerting.tf`, `terraform/dashboard.tf`, `terraform/terraform.tfvars.example`, `terraform/variables.tf`, `terraform/versions.tf`

| Test file | Cases |
|---|---|
| `grafana/scripts/validate-alerts.test.mjs` (`pnpm test:grafana`, node:test) | 16 |
| `grafana/scripts/validate-dashboard.test.mjs` (`pnpm test:grafana`, node:test) | 15 |

## `tooling` and release configuration

### `tooling/`

`test-env.ts` (the per-worktree test database and Redis db), the Vitest decorator transform, and the guard over the release-please setup (B24): `release-please-config.json` and `.release-please-manifest.json` at the root, `.github/workflows/release-please.yml` and `pr-title.yml`. See [`operations.md`](operations.md), "Releases and versioning".

Files: `release-please.test.mjs`, `test-env.ts`, `vitest-decorator-transform.ts`

| Test file | Cases |
|---|---|
| `tooling/release-please.test.mjs` (`pnpm test:release`, node:test) | 10 |

## `packages/contracts`

### `packages/contracts/src/`

Dialer types (`agency.ts`, a barrel over `agency/`), error-code unions and lists including the action and soft-phone error unions (`errors.ts`), feature flags (`flags.ts`), roles, permission matrix and the admin-invite address rule `inviteRequiresMatchingAddress` (`rbac.ts`, decision B25), shared primitives (`primitives.ts`: `SortOrder`, `STATS_BUCKET_UNITS`, `OffsetPage`, the `AllListed` exhaustiveness check), barrel.

Files: `agency.ts`, `errors.ts`, `flags.ts`, `index.ts`, `primitives.ts`, `rbac.ts`

| Test file | Cases |
|---|---|
| `packages/contracts/test/console-wire-derived.test.ts` | 1 (plus 24 type-level pins) |
| `packages/contracts/test/console-wire-diff.test.ts` | 2 |
| `packages/contracts/test/errors.test.ts` | 10 |
| `packages/contracts/test/exports.test.ts` | 10 |
| `packages/contracts/test/flags.test.ts` | 7 |
| `packages/contracts/test/rbac.test.ts` | 60 |
| `packages/contracts/test/stall.test.ts` | 4 |

`packages/contracts/test/type-equals.ts` is the shared type-level `Equals` / `Same` helper.

### `packages/contracts/src/agency/`

The dialer contract, one file per surface, re-exported by `../agency.ts`: shared enumerations (`enums.ts`), campaign-derived config and the session bootstrap (`session.ts`), the station socket and its close codes (`station.ts`), action and session-state routes with the Phase 2 pool (`actions.ts`), campaign stats and the campaign rate floor (`campaign-stats.ts`), the campaign config defaults the server applies and the console previews — built-in disposition catalog, our-fault redial bound (`campaign-defaults.ts`), lifecycle and retry campaigns (`campaign-lifecycle.ts`), series, agent record, roster and grouped reads (`performance.ts`), the attempt spine (`spine.ts`), the soft phone: session kind, manual call, call fields, settings, the `manual_call` frame and every soft-phone route's bodies (`softphone.ts`, `docs/softphone.md`).

Files: `actions.ts`, `campaign-defaults.ts`, `campaign-lifecycle.ts`, `campaign-stats.ts`, `enums.ts`, `performance.ts`, `session.ts`, `softphone.ts`, `spine.ts`, `station.ts`

_No dedicated test files._

### `packages/contracts/src/api/agency/`

Console wire types for the agency API: campaigns, series, stats, spine, activity, analysis profiles, DNC, calls, attempt call, soft phone. Declarations identical to the dialer contract are re-exported from it, and the ones that differ are derived from it; `CONTRACT-DIFF.md` lists each.

Files: `agency-activity.ts`, `agency-campaign-series.ts`, `agency-campaign.ts`, `agency-spine.ts`, `agency-stats.ts`, `agency.ts`, `attempt-call.ts`, `call-analysis-profile.ts`, `dnc.ts`, `index.ts`, `shared.ts`, `softphone.ts`, `webrtc-call.ts`

_No dedicated test files._

### `packages/contracts/src/api/platform/`

Wire types for the platform API: auth and session, team, invites, notifications, settings, feature flags, super-admin and usage. `super-admin-telephony-credentials.ts` also exports `TELEPHONY_CREDENTIAL_ERROR_CODES`, the runtime list of its error-code union with an exhaustiveness guard (snapshot in `exports.test.ts`).

Files: `auth.ts`, `feature-flags.ts`, `index.ts`, `invite.ts`, `notifications.ts`, `settings.ts`, `super-admin-telephony-credentials.ts`, `super-admin-usage.ts`, `super-admin.ts`, `team.ts`

_No dedicated test files._

## `packages/db`

### `packages/db/src/`

pg pool and TLS options (`connection.ts`), migrations directory, pg error helpers, barrel.

Files: `connection.ts`, `index.ts`, `migrations-dir.ts`, `pg-errors.ts`

_No dedicated test files._

### `packages/db/src/models/`

Row models for the shared tables.

Files: `account-settings.model.ts`, `account.model.ts`, `agency-call.model.ts`, `announcement.model.ts`, `audio-file.model.ts`, `audit.model.ts`, `call-analysis-profile.model.ts`, `call.model.ts`, `conversation-entry.model.ts`, `dialer-analysis-job.model.ts`, `feature-flag.model.ts`, `membership.model.ts`, `phone-number.model.ts`, `prompt.model.ts`, `static-call.model.ts`, `super-admin.model.ts`, `telephony-credential.model.ts`, `telephony-provider.model.ts`, `tenant-phone-assignment.model.ts`, `tenant.model.ts`, `user.model.ts`

_No dedicated test files._

### `packages/db/src/models/platform/`

Platform audit model.

Files: `audit.model.ts`

_No dedicated test files._

### `packages/db/src/repositories/`

Shared repositories: tenants, accounts, users, memberships, super-admins and their audit, phone numbers and assignments, account settings, provider concurrency, agency calls, staffing, call-analysis profiles, analysis jobs, audio files, announcements, feature flags, audit, usage counts.

Files: `account-settings.repository.ts`, `account.repository.ts`, `agency-call.repository.ts`, `agency-campaign-agent.repository.ts`, `announcement.repository.ts`, `audio-file.repository.ts`, `audit.repository.ts`, `call-analysis-profile.repository.ts`, `dialer-analysis-job.repository.ts`, `feature-flag.repository.ts`, `membership.repository.ts`, `phone-number.repository.ts`, `provider-concurrency.repository.ts`, `super-admin-audit.repository.ts`, `super-admin.repository.ts`, `telephony-credential.repository.ts`, `tenant-phone-assignment.repository.ts`, `tenant.repository.ts`, `usage-counts.repository.ts`, `user.repository.ts`

| Test file | Cases |
|---|---|
| `packages/db/test/integration/repositories/account-settings-toggles-writer.test.ts` | ~5 |
| `packages/db/test/integration/repositories/account-settings-webrtc-writer.test.ts` | ~4 |
| `packages/db/test/integration/repositories/account-settings.repository.test.ts` | ~23 |
| `packages/db/test/integration/repositories/account.repository.test.ts` | ~16 |
| `packages/db/test/integration/repositories/agency-campaign-agent.concurrency.test.ts` | ~11 |
| `packages/db/test/integration/repositories/agency-campaign-agent.repository.test.ts` | ~38 |
| `packages/db/test/integration/repositories/announcement-advanced.repository.test.ts` | ~14 |
| `packages/db/test/integration/repositories/announcement.repository.test.ts` | ~14 |
| `packages/db/test/integration/repositories/audio-file-advanced.repository.test.ts` | ~13 |
| `packages/db/test/integration/repositories/audio-file-pcm.repository.test.ts` | ~5 |
| `packages/db/test/integration/repositories/audio-file.repository.test.ts` | ~11 |
| `packages/db/test/integration/repositories/audit.repository.test.ts` | ~12 |
| `packages/db/test/integration/repositories/call-analysis-profile.repository.test.ts` | ~6 |
| `packages/db/test/integration/repositories/claim-limit.test.ts` | 5 |
| `packages/db/test/integration/repositories/dialer-analysis-job.repository.test.ts` | ~9 |
| `packages/db/test/integration/repositories/membership.repository.test.ts` | ~33 |
| `packages/db/test/integration/repositories/phone-number.repository.test.ts` | ~8 |
| `packages/db/test/integration/repositories/provider-concurrency.repository.test.ts` | ~6 |
| `packages/db/test/integration/repositories/shared-infra-coverage.test.ts` | ~8 |
| `packages/db/test/integration/repositories/telephony-credential.repository.test.ts` | 31 |
| `packages/db/test/integration/repositories/tenant.repository.test.ts` | ~13 |
| `packages/db/test/integration/repositories/usage-counts.repository.test.ts` | ~8 |
| `packages/db/test/integration/repositories/user-addressable-members.repository.test.ts` | ~11 |
| `packages/db/test/unit/db/repositories/account-settings.repository.test.ts` | 24 |
| `packages/db/test/unit/db/repositories/account.repository.test.ts` | 23 |
| `packages/db/test/unit/db/repositories/audio-file.repository.test.ts` | 12 |
| `packages/db/test/unit/db/repositories/audit-find-filtered.test.ts` | 10 |
| `packages/db/test/unit/db/repositories/call-analysis-profile.repository.test.ts` | 9 |
| `packages/db/test/unit/db/repositories/dialer-analysis-job.repository.test.ts` | 27 |
| `packages/db/test/unit/db/repositories/feature-flag.repository.test.ts` | 12 |
| `packages/db/test/unit/db/repositories/membership.repository.test.ts` | 33 |
| `packages/db/test/unit/db/repositories/super-admin-audit.repository.test.ts` | 14 |
| `packages/db/test/unit/db/repositories/super-admin.repository.test.ts` | 7 |
| `packages/db/test/unit/db/repositories/tenant.repository.test.ts` | 15 |
| `packages/db/test/unit/db/repositories/user.repository.test.ts` | 16 |
| `packages/db/test/unit/db/repositories/webrtc-call-repository-analysis.test.ts` | 9 |
| `packages/db/test/unit/db/repositories/webrtc-call-scope.test.ts` | 13 |

### `packages/db/src/repositories/platform/`

Platform audit repository.

Files: `audit.repository.ts`

| Test file | Cases |
|---|---|
| `packages/db/test/unit/db/repositories/platform/audit.repository.test.ts` | 30 |

### `packages/db/src/utils/`

Single-flight, SQL update builder, TTL cache, and `withTransaction` (`transaction.ts`): BEGIN with an isolation level and READ ONLY, COMMIT, ROLLBACK on a throw, release on every path, destroy a client whose ROLLBACK failed, `tx.rollback()` to end early without throwing, and `client` to join a caller's open transaction (decision B8). Import-free: the caller passes its pool. Imported as `@magick-agency/db/utils/transaction`.

Files: `single-flight.ts`, `sql-update.ts`, `transaction.ts`, `ttl-cache.ts`

| Test file | Cases |
|---|---|
| `packages/db/test/integration/db/transaction.test.ts` | 8 |
| `packages/db/test/unit/utils/single-flight.test.ts` | 16 |
| `packages/db/test/unit/utils/sql-update.test.ts` | 8 |
| `packages/db/test/unit/utils/transaction.test.ts` | 14 |
| `packages/db/test/unit/utils/ttl-cache.test.ts` | 51 |

### Cross-cutting tests (`packages/db`)

Scenario, flow, guard and setup tests that span several modules.

| Test file | Cases |
|---|---|
| `packages/db/test/integration/agency/webrtc-call-scope-isolation.test.ts` | ~14 |
| `packages/db/test/integration/db/attempt-indexes-migration.test.ts` | 4 |
| `packages/db/test/integration/baseline-down-up.test.ts` | ~5 |
| `packages/db/test/integration/baseline.test.ts` | ~55 |
| `packages/db/test/integration/db/contacts-in-flight-index-migration.test.ts` | 1 |
| `packages/db/test/integration/db/softphone-migration.test.ts` | 16 |
| `packages/db/test/integration/db/audio-file-pcm-migration.test.ts` | ~4 |
| `packages/db/test/integration/db/dialer-analysis-migration.test.ts` | ~6 |
| `packages/db/test/integration/db/webrtc-call-analysis-projection.test.ts` | ~2 |
| `packages/db/test/integration/db/webrtc-call.repository.test.ts` | ~31 |
| `packages/db/test/integration/flows/dialer-analysis-dsar.test.ts` | ~1 |
| `packages/db/test/integration/flows/dialer-analysis-failure-paths.test.ts` | ~2 |
| `packages/db/test/integration/flows/dialer-analysis-gating.test.ts` | ~2 |
| `packages/db/test/integration/flows/dialer-analysis-lifecycle.test.ts` | ~1 |
| `packages/db/test/integration/flows/dialer-analysis-race.test.ts` | ~2 |
| `packages/db/test/integration/flows/dialer-analysis-recovery.test.ts` | ~2 |
| `packages/db/test/integration/scenarios/account-settings-concurrency.test.ts` | ~11 |
| `packages/db/test/integration/scenarios/announcement-lifecycle.test.ts` | ~1 |
| `packages/db/test/integration/scenarios/audio-file-announcement-fk.test.ts` | ~4 |
| `packages/db/test/integration/scenarios/audit-logging.test.ts` | ~14 |
| `packages/db/test/unit/agency/agency-campaign-agent.repository.test.ts` | 64 |
| `packages/db/test/unit/db/connection-ssl.test.ts` | 5 |
| `packages/db/test/unit/db/dialer-analysis-job-model.test.ts` | 2 |
| `packages/db/test/unit/db/dialer-analysis-models.test.ts` | 1 |
| `packages/db/test/unit/helpers/truncate-all.test.ts` | 3 |
| `packages/db/test/unit/test-db-guard.test.ts` | 7 |

## `packages/domain`

### `packages/domain/src/`

Pure dialer rules: abandonment predicate, break manager, keyset cursor, rates, retry campaign bounds and summary, success disposition, timers (and `elapsedSeconds`, the one spelling of a seat-time / latency measurement).

Files: `abandonment-predicate.ts`, `break-manager.ts`, `index.ts`, `keyset-cursor.ts`, `rates.ts`, `retry-campaign-bounds.ts`, `retry-summary.ts`, `success-disposition.ts`, `timers.ts`

| Test file | Cases |
|---|---|
| `packages/domain/test/unit/agency/break-manager.test.ts` | 18 |
| `packages/domain/test/unit/agency/elapsed-seconds.test.ts` | 3 |
| `packages/domain/test/unit/agency/keyset-cursor.test.ts` | 9 |
| `packages/domain/test/unit/agency/retry-campaign-bounds.test.ts` | 4 |
| `packages/domain/test/unit/agency/retry-summary.test.ts` | 19 |

## `packages/observability`

### `packages/observability/src/`

Logger, log context, PII masking (`crypto.ts`), the log-side URL scrubber (`url-scrub.ts`, import-free so the OTel span hook can use it), OTel meter and metric instruments, `@Traced` and `withSpan`, the pg pool's connect-callback context binding (`trace-context.ts`, a subpath import; its test is `apps/server/test/unit/utils/trace-context.test.ts`, since this package has no SDK), service name and version.

Files: `crypto.ts`, `index.ts`, `log-context.ts`, `logger.ts`, `meter.ts`, `metric-instruments.ts`, `service.ts`, `trace-context.ts`, `tracing.ts`, `url-scrub.ts`, `version.ts`

| Test file | Cases |
|---|---|
| `packages/observability/test/logger.test.ts` | 4 |
| `packages/observability/test/metrics-agency.test.ts` | 8 |
| `packages/observability/test/tracing.test.ts` | 2 |

### `packages/observability/src/metrics/`

Metric declarations per module area: `platform`, `agency`, `voice`, `analysis`, `shared`.

Files: `agency.ts`, `analysis.ts`, `platform.ts`, `shared.ts`, `voice.ts`

_No dedicated test files._

## `packages/web-ui`

UI pieces shared by the console and super-admin, consumed as TypeScript source (decision B2; the
`exports` map points at `src/`): each app imports a module by path, e.g.
`@magick-agency/web-ui/components/Modal`. React, react-dom, react-router-dom and lucide-react are
peer dependencies, so both apps keep one instance of each. Not built on its own: each app's Vite build
compiles these files and their CSS modules. Has its own no-parent-brand scan (B17), since the apps'
scans cover only their own `src/`.

### `packages/web-ui/src/`

The error-message helpers and request-id marker (`errors.ts`), the one reading of an API error body
for both clients (`apiErrorBody.ts`: `parseApiErrorBody`, field-level `details` / `issues` before a
generic `message`), date and number formatting (`format.ts`), customer-facing carrier aliases
(`telephonyProviders.ts`), a bounded `allSettled`-style fan-out (`concurrency.ts`:
`mapWithConcurrency`), and the stylesheet both apps' `main.tsx` import (`global.css`: theme tokens,
base elements, `.toast-container`).

Files: `apiErrorBody.ts`, `concurrency.ts`, `errors.ts`, `format.ts`, `global.css`, `telephonyProviders.ts`

| Test file | Cases |
|---|---|
| `packages/web-ui/test/apiErrorBody.test.ts` | 14 |
| `packages/web-ui/test/concurrency.test.ts` | 9 |
| `packages/web-ui/test/errors.test.ts` | 21 |
| `packages/web-ui/test/format.test.ts` | 50 |
| `packages/web-ui/test/noParentBrand.test.ts` | 4 |
| `packages/web-ui/test/telephonyProviders.test.ts` | 10 |
| `packages/web-ui/test/themeTokenParity.test.ts` | 4 |

### `packages/web-ui/src/components/`

The 15 components both apps used as byte-identical copies, each with its CSS module, and `AppVersion`, the release version at the foot of every sidebar in both apps, and inline in the agent nav and the station header (B24).

Files: `AppVersion.module.css`, `AppVersion.tsx`, `Breadcrumbs.module.css`, `Breadcrumbs.tsx`, `ConfirmDialog.module.css`, `ConfirmDialog.tsx`, `DataTable.module.css`, `DataTable.tsx`, `EmptyState.module.css`, `EmptyState.tsx`, `ErrorAlert.module.css`, `ErrorAlert.tsx`, `ErrorText.module.css`, `ErrorText.tsx`, `HelpTooltip.module.css`, `HelpTooltip.tsx`, `LiveDot.module.css`, `LiveDot.tsx`, `LoadingSpinner.module.css`, `LoadingSpinner.tsx`, `Modal.module.css`, `Modal.tsx`, `PageHeader.module.css`, `PageHeader.tsx`, `Pagination.module.css`, `Pagination.tsx`, `RequestId.module.css`, `RequestId.tsx`, `StatusBadge.module.css`, `StatusBadge.tsx`, `Toast.module.css`, `Toast.tsx`

| Test file | Cases |
|---|---|
| `packages/web-ui/test/components/AppVersion.test.tsx` | 4 |
| `packages/web-ui/test/components/ConfirmDialog.test.tsx` | 12 |
| `packages/web-ui/test/components/DataTable.test.tsx` | 27 |
| `packages/web-ui/test/components/ErrorAlert.test.tsx` | 4 |
| `packages/web-ui/test/components/ErrorText.test.tsx` | 4 |
| `packages/web-ui/test/components/LiveDot.test.tsx` | 7 |
| `packages/web-ui/test/components/Pagination.test.tsx` | 28 |
| `packages/web-ui/test/components/StatusBadge.test.tsx` | 15 |
| `packages/web-ui/test/components/Toast.test.tsx` | 2 |
| `packages/web-ui/test/components/dataTableAlignCss.test.ts` | 5 |

### `packages/web-ui/src/contexts/`

`ToastProvider` / `useToast` (memoised context value).

Files: `ToastContext.tsx`

| Test file | Cases |
|---|---|
| `packages/web-ui/test/contexts/ToastContext.test.tsx` | 3 |

### `packages/web-ui/src/hooks/`

`useAsyncResource(fetcher, { initialData, errorMessage, enabled })`: `{ data, loading, error, reload }` where
only the latest load may write state; `enabled: false` makes no request, resets `data` to `initialData` and keeps `loading` true. The super-admin list hooks and the console's team, account and
phone-number hooks use it. `useDialogFocus({ open, dialogRef, onEscape?, initialFocusRef? })` is the one
focus-in / Tab-trap / Escape / restore-focus implementation (`Modal`, `ConfirmDialog` and the console's
dialog hooks call it; `trapTab` is its edge-wrap, used by the console's mobile drawer).

Files: `useAsyncResource.ts`, `useDialogFocus.ts`

| Test file | Cases |
|---|---|
| `packages/web-ui/test/hooks/useAsyncResource.test.ts` | 8 |
| `packages/web-ui/test/hooks/useDialogFocus.test.tsx` | 4 |

`packages/web-ui/test/setup.ts` registers the RTL cleanup (no `globals: true`).

## `apps/console`

### `apps/console/src/`

App shell: `App.tsx` (routes, including the soft phone's `/dialer/phone` (which reads `agency_softphone_enabled` itself, for finish mode), `/agency/softphone`, `/agency/softphone/calls/:callId`, `/agency/campaigns/:id/manual-calls` and `/app/softphone`, each of the others behind `agency_softphone_enabled`; their gates are pinned by `softphoneVisibility.test.tsx` under `components/`), `main.tsx` (imports `@magick-agency/web-ui/global.css`), `config.ts` (API base, endpoints, originator).

Files: `App.tsx`, `config.ts`, `main.tsx`, `vite-env.d.ts`

_No dedicated test files._

### `apps/console/src/analytics/`

PostHog wiring for the console. `events.ts` (`EventCatalog`) includes the soft phone's events: `agency_softphone_call_placed`, `agency_softphone_call_refused`, `agency_softphone_override_confirmed`, `agency_softphone_outcome_saved`, `agency_softphone_hangup`, `agency_softphone_dnc_marked` and `agency_softphone_switch` (`start`, `return` or `cancel_queued`, from the station and `/dialer/phone`); `/dialer/phone` is one of the full-viewport pages `productSurface.test.tsx` lists.

Files: `ProductSurface.tsx`, `events.ts`, `posthog.ts`, `redact.ts`, `useProductSurface.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/analytics/autocaptureOptOut.test.ts` | 4 |
| `apps/console/src/__tests__/analytics/events.test.ts` | 7 |
| `apps/console/src/__tests__/analytics/posthog.test.ts` | 22 |
| `apps/console/src/__tests__/analytics/productSurface.test.tsx` | 12 |
| `apps/console/src/__tests__/analytics/redact.test.ts` | 13 |

### `apps/console/src/api/`

API client (`client.ts`, auth headers) and one module per API family: accounts, agency, activity, campaigns, series, spine, stats, auth, analysis profiles, calls, DNC, CSV export, feature flags, invites, notifications, phone numbers, soft phone, tenants, users. `softphone.ts` is the soft phone's routes (docs/softphone.md §6), all under `/proxy/agency/softphone` except the switch and return on a campaign session: bootstrap, session open, place / update / hang up / outcome / DNC for a manual call, the keyset call list (`manualCallQuery`) and detail, the recording blob, and settings. Refusals come back as typed results (`SoftphoneResult`, `parseSoftphoneRefusal`: the DNC, calling-hours, contact-in-flight, session-on-campaign and call-pending shapes, a generic one for the rest of the code union, and an unknown one) rather than exceptions; `agencySpine.ts` exports `recordingRefusal` for its recording fetch.

Files: `accounts.ts`, `agency.ts`, `agencyActivity.ts`, `agencyCampaignSeries.ts`, `agencyCampaigns.ts`, `agencySpine.ts`, `agencyStats.ts`, `auth.ts`, `authHeaders.ts`, `call-analysis-profiles.ts`, `calls.ts`, `client.ts`, `dnc.ts`, `error-analytics.ts`, `exportCsv.ts`, `feature-flags.ts`, `invites.ts`, `notifications.ts`, `phone-numbers.ts`, `softphone.ts`, `tenants.ts`, `users.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/api/agency-account-header.test.ts` | 30 |
| `apps/console/src/__tests__/api/agency-notes.test.ts` | 17 |
| `apps/console/src/__tests__/api/agencyActivity.test.ts` | 8 |
| `apps/console/src/__tests__/api/agencyCampaignRetry.test.ts` | 8 |
| `apps/console/src/__tests__/api/agencyCampaignList.test.ts` | 7 |
| `apps/console/src/__tests__/api/agencyCampaignSeries.test.ts` | 6 |
| `apps/console/src/__tests__/api/agencyMyAssignments.test.ts` | 6 |
| `apps/console/src/__tests__/api/agencySpine.test.ts` | 11 |
| `apps/console/src/__tests__/api/agencyStats.test.ts` | 38 |
| `apps/console/src/__tests__/api/call-analysis-profiles.api.test.ts` | 5 |
| `apps/console/src/__tests__/api/error-analytics.test.ts` | 5 |
| `apps/console/src/__tests__/api/exportCsv.test.ts` | 3 |
| `apps/console/src/__tests__/api/invites.test.ts` | 21 |
| `apps/console/src/__tests__/api/originator-header.test.ts` | 4 |
| `apps/console/src/__tests__/api/softphone.test.ts` | 13 |
| `apps/console/src/__tests__/api/tenants.test.ts` | 6 |

### `apps/console/src/brand/`

Brand pack loading and types (decision B17).

Files: `index.ts`, `load-brand.ts`, `types.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/brand/index.test.ts` | 14 |
| `apps/console/src/brand/load-brand.test.ts` | 37 |

### `apps/console/src/components/`

UI components: `agency/` (station, state rail, wrap-up timer, campaign tabs, health strip and the rest of the agent and supervisor UI), `audio/`, `auth/` (route guards), `calls/` (call detail), `common/` (the console's own shared widgets: logo, page description, filters, copyable fields; the widgets both apps use are in `packages/web-ui`), `layout/` (app and agency shells, sidebar). The soft phone's own components are in `softphone/` (next entry). Its additions here: the station's `StationActionBar` offers **Switch to soft phone** beside Break and as the break menu's last entry, reading "Switching after this call" while the switch is queued, with the switch's own refusal under it (SP7, docs/softphone.md §4.2); `QueuedBreakPill` says "Switching to the soft phone after this call" for that queued break; `StationHeader` takes `extra` (where the call is logged, recording, Return to campaign) and a `subline`; `HoldToConfirmButton` has `reserveReasonLine` so the action bars keep one height with and without a call; `DispositionPad` takes a `hint` (whose outcome list it is) and a `callbackNote` for a call no campaign queue takes back; `CallDetailView` / `CallDetailSections` take `source` and `analysisSource` labels (Agent, AI) for the soft-phone call detail; `AgentNav` adds the Soft phone entry second (`useSoftphoneAvailable`: the flag on and `agency.softphone.dial`), a `header` variant, a `lockedReason` that turns the other entries into text while a call is unsettled, and a `leaveHint` (each link's description: the soft phone stays open); `AgencySidebar` adds Soft-phone calls (`agency.supervise`) and Soft phone settings (`agency.softphone.manage`), `Sidebar` adds ADMIN → Soft phone, and `CampaignTabs` the Soft-phone calls tab, each behind `agency_softphone_enabled`; `RequireFlag` reports a route that flag turns away (`trackFeatureGateUnavailable`), as it does for the other two agency flags. `softphoneVisibility.test.tsx` pins the nav, the sidebar, the campaign tab and the route gates with the flag on and off.

Files: `agency/AgencyRetryDialog.module.css`, `agency/AgencyRetryDialog.tsx`, `agency/AgentAnalyticsSection.module.css`, `agency/AgentAnalyticsSection.tsx`, `agency/AgentAttemptsPanel.module.css`, `agency/AgentAttemptsPanel.tsx`, `agency/AgentBucketChart.module.css`, `agency/AgentBucketChart.tsx`, `agency/AgentFloor.module.css`, `agency/AgentFloor.tsx`, `agency/AgentFloorDrawer.module.css`, `agency/AgentFloorDrawer.tsx`, `agency/AgentLanding.module.css`, `agency/AgentLanding.tsx`, `agency/AgentNav.module.css`, `agency/AgentNav.tsx`, `agency/AgentPerformancePanel.module.css`, `agency/AgentPerformancePanel.tsx`, `agency/AgentStation.module.css`, `agency/AgentSurfaceShell.module.css`, `agency/AgentSurfaceShell.tsx`, `agency/BestHours.tsx`, `agency/BestHoursMatrix.module.css`, `agency/BestHoursMatrix.tsx`, `agency/BreakMenu.module.css`, `agency/BreakMenu.tsx`, `agency/CampaignActivityChart.module.css`, `agency/CampaignActivityChart.tsx`, `agency/CampaignAgentAssignments.module.css`, `agency/CampaignAgentAssignments.tsx`, `agency/CampaignContribution.tsx`, `agency/CampaignHealthStrip.module.css`, `agency/CampaignHealthStrip.tsx`, `agency/CampaignLineageStrip.module.css`, `agency/CampaignLineageStrip.tsx`, `agency/CampaignPerformance.module.css`, `agency/CampaignPerformance.tsx`, `agency/CampaignRateChart.module.css`, `agency/CampaignRateChart.tsx`, `agency/CampaignRecordingField.module.css`, `agency/CampaignRecordingField.tsx`, `agency/CampaignSeriesSection.module.css`, `agency/CampaignSeriesSection.tsx`, `agency/CampaignTabs.module.css`, `agency/CampaignTabs.tsx`, `agency/CompareTray.tsx`, `agency/ConnectionHealthPill.tsx`, `agency/ContactDetail.tsx`, `agency/ContactPanel.tsx`, `agency/ContributionTable.tsx`, `agency/CueSettings.module.css`, `agency/CueSettings.tsx`, `agency/DialerUnavailable.module.css`, `agency/DialerUnavailable.tsx`, `agency/DispositionPad.module.css`, `agency/DispositionPad.tsx`, `agency/DncControl.module.css`, `agency/DncControl.tsx`, `agency/FilterChip.tsx`, `agency/FiltersCard.tsx`, `agency/GoogleMark.tsx`, `agency/HoldToConfirmButton.module.css`, `agency/HoldToConfirmButton.tsx`, `agency/IdleGuide.tsx`, `agency/JoinConflictScreen.tsx`, `agency/MultiSelectFilter.tsx`, `agency/NotesField.module.css`, `agency/NotesField.tsx`, `agency/PriorAttemptsList.tsx`, `agency/QueuedBreakPill.module.css`, `agency/QueuedBreakPill.tsx`, `agency/RailPresenceRegion.module.css`, `agency/RailPresenceRegion.tsx`, `agency/RosterTable.module.css`, `agency/RosterTable.tsx`, `agency/RosterToolbar.tsx`, `agency/SoftphoneJoinScreen.tsx`, `agency/SpineListLayout.module.css`, `agency/StateRail.module.css`, `agency/StateRail.tsx`, `agency/StationActionBar.tsx`, `agency/StationFatal.tsx`, `agency/StationHeader.tsx`, `agency/StationIdentity.module.css`, `agency/StationIdentity.tsx`, `agency/StationMenu.module.css`, `agency/StationMenu.tsx`, `agency/WorkspaceExit.tsx`, `agency/WrapupTimer.module.css`, `agency/WrapupTimer.tsx`, `agency/join/AddressMismatch.tsx`, `agency/join/AgencyJoin.module.css`, `agency/join/CredentialForm.tsx`, `agency/join/GuardedLink.tsx`, `agency/join/InviteJoinScreen.tsx`, `agency/join/JoinCardHeader.tsx`, `agency/join/Unavailable.tsx`, `agency/join/Unreachable.tsx`, `agency/join/joinDoor.ts`, `agency/join/joinPending.ts`, `agency/join/useInviteClaim.ts`, `agency/useAgentAnalyticsNav.ts`, `agency/useChartWidth.ts`, `audio/AudioWaveform.module.css`, `audio/AudioWaveform.tsx`, `auth/HomeRedirect.tsx`, `auth/RequireAuth.tsx`, `auth/RequireCapability.tsx`, `auth/RequireFlag.tsx`, `calls/CallDetailSections.tsx`, `calls/CallDetailView.tsx`, `common/AccountUnavailable.tsx`, `common/CapabilityUnavailable.tsx`, `common/CopyableField.module.css`, `common/CopyableField.tsx`, `common/DateRangeFilter.module.css`, `common/DateRangeFilter.tsx`, `common/FieldError.tsx`, `common/GlobalSearch.module.css`, `common/GlobalSearch.tsx`, `common/Logo.tsx`, `common/PageDescription.module.css`, `common/PageDescription.tsx`, `common/PhoneFilterInput.module.css`, `common/PhoneFilterInput.tsx`, `common/TruncatedId.module.css`, `common/TruncatedId.tsx`, `common/index.ts`, `layout/AccountSwitcher.module.css`, `layout/AccountSwitcher.tsx`, `layout/AgencyLayout.module.css`, `layout/AgencyLayout.tsx`, `layout/AgencySidebar.module.css`, `layout/AgencySidebar.tsx`, `layout/AppLayout.module.css`, `layout/AppLayout.tsx`, `layout/Sidebar.module.css`, `layout/Sidebar.tsx`, `layout/SwitcherDropdown.module.css`, `layout/SwitcherDropdown.tsx`, `layout/TenantSwitcher.module.css`, `layout/TenantSwitcher.tsx`, `layout/TopBar.module.css`, `layout/TopBar.tsx`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/components/AccountSwitcher.test.tsx` | 7 |
| `apps/console/src/__tests__/components/AgencyRetryDialog.test.tsx` | 31 |
| `apps/console/src/__tests__/components/AgencySidebar.test.tsx` | 13 |
| `apps/console/src/__tests__/components/AgencyWorkspaceSwitch.test.tsx` | 13 |
| `apps/console/src/__tests__/components/AgentAnalyticsSection.test.tsx` | 89 |
| `apps/console/src/__tests__/components/AgentBucketChart.test.tsx` | 15 |
| `apps/console/src/__tests__/components/AgentFloor.test.tsx` | 41 |
| `apps/console/src/__tests__/components/AgentLanding.test.tsx` | 15 |
| `apps/console/src/__tests__/components/AgentPerformancePanel.test.tsx` | 14 |
| `apps/console/src/__tests__/components/AppLayout.mobileDrawer.test.tsx` | 8 |
| `apps/console/src/__tests__/components/AudioWaveform.test.tsx` | 9 |
| `apps/console/src/__tests__/components/BestHours.test.tsx` | 22 |
| `apps/console/src/__tests__/components/BestHoursMatrix.test.tsx` | 17 |
| `apps/console/src/__tests__/components/BreakMenu.test.tsx` | 26 |
| `apps/console/src/__tests__/components/CallDetailSections.analysis.test.tsx` | 13 |
| `apps/console/src/__tests__/components/CallDetailView.test.tsx` | 21 |
| `apps/console/src/__tests__/components/CallerIdPicker.test.tsx` | 2 |
| `apps/console/src/__tests__/components/CampaignBehaviourSection.test.tsx` | 13 |
| `apps/console/src/__tests__/components/CampaignContribution.test.tsx` | 42 |
| `apps/console/src/__tests__/components/CampaignHealthStrip.test.tsx` | 14 |
| `apps/console/src/__tests__/components/CampaignPerformance.test.tsx` | 19 |
| `apps/console/src/__tests__/components/CampaignSeriesSection.test.tsx` | 25 |
| `apps/console/src/__tests__/components/CompareTray.test.tsx` | 21 |
| `apps/console/src/__tests__/components/ComposerSection.test.tsx` | 6 |
| `apps/console/src/__tests__/components/ConnectionHealthPill.test.tsx` | 8 |
| `apps/console/src/__tests__/components/ContributionTable.test.tsx` | 18 |
| `apps/console/src/__tests__/components/DialerUnavailable.test.tsx` | 3 |
| `apps/console/src/__tests__/components/DispositionPad.test.tsx` | 29 |
| `apps/console/src/__tests__/components/DncControl.test.tsx` | 7 |
| `apps/console/src/__tests__/components/GlobalSearchDnc.test.tsx` | 4 |
| `apps/console/src/__tests__/components/GovernanceGating.test.tsx` | 6 |
| `apps/console/src/__tests__/components/HoldToConfirmButton.test.tsx` | 43 |
| `apps/console/src/__tests__/components/HomeRedirect.test.tsx` | 8 |
| `apps/console/src/__tests__/components/NotesField.test.tsx` | 22 |
| `apps/console/src/__tests__/components/PageDescription.test.tsx` | 3 |
| `apps/console/src/__tests__/components/PhoneFilterInput.test.tsx` | 8 |
| `apps/console/src/__tests__/components/QueuedBreakPill.test.tsx` | 14 |
| `apps/console/src/__tests__/components/RailPresenceRegion.test.tsx` | 18 |
| `apps/console/src/__tests__/components/RequireAuth.returnPath.test.tsx` | 6 |
| `apps/console/src/__tests__/components/RequireCapability.settings.test.tsx` | 4 |
| `apps/console/src/__tests__/components/RequireFlag.test.tsx` | 11 |
| `apps/console/src/__tests__/components/RosterTable.test.tsx` | 49 |
| `apps/console/src/__tests__/components/Sidebar.activeState.test.tsx` | 2 |
| `apps/console/src/__tests__/components/StateRail.test.tsx` | 26 |
| `apps/console/src/__tests__/components/StationIdentity.test.tsx` | 2 |
| `apps/console/src/__tests__/components/SwitcherDropdown.test.tsx` | 8 |
| `apps/console/src/__tests__/components/TenantSwitcher.test.tsx` | 7 |
| `apps/console/src/__tests__/components/TopBar.test.tsx` | 8 |
| `apps/console/src/__tests__/components/WrapupTimer.test.tsx` | 25 |
| `apps/console/src/__tests__/components/agentSurfacesVersion.test.tsx` | 2 |
| `apps/console/src/__tests__/components/campaignSeriesCharts.test.tsx` | 16 |
| `apps/console/src/__tests__/components/joinDoor.test.ts` | 12 |
| `apps/console/src/__tests__/components/platformZoneExits.test.tsx` | 2 |
| `apps/console/src/__tests__/components/sidebarVersion.test.tsx` | 4 |
| `apps/console/src/__tests__/components/softphoneVisibility.test.tsx` | 11 |
| `apps/console/src/__tests__/components/switcherDropdownScrollCss.test.ts` | 4 |
| `apps/console/src/components/common/DateRangeFilter.test.tsx` | 25 |
| `apps/console/src/components/common/DateRangeFilter.timezone.test.tsx` | 1 |
| `apps/console/src/components/common/Logo.test.tsx` | 5 |

### `apps/console/src/components/softphone/`

The soft phone's screen (docs/softphone.md §7). `SoftphoneView` is the rail, three columns and action bar in the station's frozen geometry, mounted by two hosts: `/dialer/phone` and the campaign station once `agent_state` reports `break/soft_phone`; both pass it the same `useSoftphone` state, and the socket, microphone and header stay the host's. `SoftphoneRail` is the station rail's band, tints and timer with the soft phone's five states (Ready, Dialing, Ringing, On call, Outcome needed) and no End break. Column 1 is `DialPad` (number input, keypad, caller ID, Call; once placed, who is called from where, the SP3 warning while ringing and "Without one, it closes in m:ss" from `outcome_due_at`); column 2 `CallDetailsColumn` (the "Log to" campaign, fixed once dialled, the matched roster contact) with `CallFieldsForm` (the account's call fields by declared type, required markers tied to the input); column 3 `OutcomeColumn` (recent calls while idle, each with its day, then the station's `DispositionPad` and notes). `SoftphoneActionBar` is Save outcome, Mark DNC, Mute, Hang up (the station's order) in every state, disabled with a stated reason, Hang up hold-to-confirm. `OverrideDialog` is "Call anyway" for a DNC hit (SP1) or a closed calling window (SP2): what matched, and a 10–500 character note. `SoftphoneHeader` (with `SoftphoneDisclosures`, also used in the station's header) carries the agent's screens, locked while a call is unsettled, recording, mute, where the call is logged and the connection. `useSoftphoneShortcuts` is the window keyboard: in Ready digits type and Enter calls; on a call `1`–`9` pick an outcome, `M`, `N`, `C`, `D` (the Mark DNC confirmation), `Ctrl`/`⌘`+`Enter`, and `E` twice to hang up; keys in a field or a focused `<select>` are ignored. `SoftphoneCallsList` is the one calls list (stats strip, filters, keyset paging, Summary column) behind the supervisor's list, a campaign's Soft-phone calls tab and the agent's My calls tab; Clear goes back to the view it opened on (today for the supervisor's list).

Files: `CallDetailsColumn.tsx`, `CallFieldsForm.tsx`, `DialPad.tsx`, `OutcomeColumn.tsx`, `OverrideDialog.tsx`, `SoftphoneActionBar.tsx`, `SoftphoneCallsList.module.css`, `SoftphoneCallsList.tsx`, `SoftphoneHeader.tsx`, `SoftphoneRail.tsx`, `SoftphoneView.module.css`, `SoftphoneView.tsx`, `useSoftphoneShortcuts.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/components/SoftphoneView.test.tsx` | 40 |

`SoftphoneView.test.tsx` drives the view through `useSoftphone` with a fake station socket (`__tests__/helpers/fakeSocket.ts`, `__tests__/helpers/softphone.ts`): Ready, refusals and overrides, the call from `manual_call` frames, the outcome window, finish mode, keys on a focused select, the ringback, mute and reconnect. `SoftphoneCallsList` is tested through `SoftphoneSupervisor.test.tsx` and `AgentAttemptsPage.softphone.test.tsx` (`pages/`).

### `apps/console/src/contexts/`

React contexts: auth, tenant, theme and the rest (the toast context is in `packages/web-ui`). `AuthContext.tsx`'s invite-credential flow is in `authInvite.ts` (`useInviteJoin`, `useInviteCredentialFlow`) and its 6-hour cap check in `useSessionWatchdog.ts`; the context API is unchanged.

Files: `AuthContext.tsx`, `FeatureFlagsContext.tsx`, `GovernanceContext.tsx`, `TenantContext.tsx`, `ThemeContext.tsx`, `authInvite.ts`, `useSessionWatchdog.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/contexts/AuthContext.lazyInit.test.tsx` | 2 |
| `apps/console/src/__tests__/contexts/AuthContext.test.tsx` | 46 |
| `apps/console/src/__tests__/contexts/FeatureFlagsContext.test.tsx` | 14 |
| `apps/console/src/__tests__/contexts/GovernanceContext.test.tsx` | 6 |
| `apps/console/src/__tests__/contexts/TenantContext.test.tsx` | 33 |

### `apps/console/src/hooks/`

React hooks for data loading and the station. `useTeam`, `useAccounts` and `usePhoneNumbers` sit on web-ui's `useAsyncResource` (its `enabled: false` waits for their scope); `useVisibleInterval` (visible-only, single-flight polling) and `useRefetchOnReturn` drive the campaign detail page and the campaigns home; `useDialogA11y` and `useModalFocus` are thin callers of web-ui's `useDialogFocus`.

The soft phone (docs/softphone.md §7): `useSoftphone` is its state machine on a station connection the host owns (`/dialer/phone` or the switched campaign station). It never opens a socket or the microphone; it reads the host's `manual_call` frames, calls the soft-phone routes, and tells the host's audio which call is live. The call on screen is the newest copy from the frame, the HTTP answers and `GET /softphone/bootstrap` (re-read after every reconnect), compared by `newerCall` with the frame winning a tie. It owns the number, Call and its refusals (the override prompt for SP1 / SP2), the debounced call-details and notes saves, the outcome with the station's disposition rules plus `call_live` / `fields_required`, Mark DNC, hang-up and the ringback, and finish mode (`finishOnly`: the flag off per the host, the bootstrap's `softphone_enabled` or a `softphone_disabled` dial refusal; nothing can start a call, everything that finishes one stays). `useAgencyStation` accepts any `StationSocketBootstrap` (a soft-phone session has no campaign), keeps the last `manual_call` frame as `manualCall` (malformed frames are dropped with a diagnostic), and feeds `useStationUnloadGuard`'s new `busyRef` so a tab cannot close silently over a soft-phone call during `break`. `useBreakQueue` adds `requestSoftphone` (`POST /sessions/:id/softphone`, queued like a break) and `softphoneRejection`. `useFeatureFlagEnabled` reads one client flag and fails closed with no provider (`SOFTPHONE_FLAG`). `useSoftphone` is tested through `SoftphoneView.test.tsx` (`components/softphone/`).

Files: `agencyStation/types.ts`, `useAccounts.ts`, `useAgencyAudio.ts`, `useAgencyCues.ts`, `useAgencyNotes.ts`, `useAgencyStation.ts`, `useAgentAttempts.ts`, `useAgentPerformance.ts`, `useAgentRoster.ts`, `useAudioCapture.ts`, `useAudioPlayback.ts`, `useBestHours.ts`, `useBreakQueue.ts`, `useCallAnalysisProfiles.ts`, `useCampaignContribution.ts`, `useCampaignSeries.ts`, `useDialogA11y.ts`, `useDispositionSubmit.ts`, `useFeatureFlagEnabled.ts`, `useLatestRef.ts`, `useMediaQuery.ts`, `useModalFocus.ts`, `useMountedRef.ts`, `usePermission.ts`, `usePhoneNumbers.ts`, `usePostHogIdentify.ts`, `useRefetchOnReturn.ts`, `useRepaintTick.ts`, `useRosterIngest.ts`, `useServerClock.ts`, `useSoftphone.ts`, `useStationUnloadGuard.ts`, `useTeam.ts`, `useVisibleInterval.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/hooks/agencyStationWsUrl.test.ts` | 7 |
| `apps/console/src/__tests__/hooks/agentSurfacesStrictMode.test.tsx` | 9 |
| `apps/console/src/__tests__/hooks/tenantListHooks.test.tsx` | 5 |
| `apps/console/src/__tests__/hooks/useAgencyStation.manualCall.test.ts` | 5 |
| `apps/console/src/__tests__/hooks/useAgencyStation.media.test.ts` | 10 |
| `apps/console/src/__tests__/hooks/useAgencyStation.test.ts` | 77 |
| `apps/console/src/__tests__/hooks/useAudioCapture.test.ts` | 18 |
| `apps/console/src/__tests__/hooks/useCallAnalysisProfiles.test.tsx` | 9 |
| `apps/console/src/__tests__/hooks/useCampaignSeries.test.tsx` | 16 |
| `apps/console/src/__tests__/hooks/useMediaQuery.test.ts` | 3 |
| `apps/console/src/__tests__/hooks/useMountedRef.test.tsx` | 3 |
| `apps/console/src/__tests__/hooks/useRepaintTick.test.ts` | 4 |
| `apps/console/src/__tests__/hooks/useServerClock.test.ts` | 16 |
| `apps/console/src/__tests__/hooks/useVisibleInterval.test.ts` | 7 |

### `apps/console/src/pages/`

Pages: `agency/` (agent home and station, campaigns and their tabs, contacts, attempts, activity, analytics, performance, DNC, login and the agent join page), `auth/` (including `JoinPage.tsx`, the workspace invite claim page at `/join/:token`), `calls/`, `campaigns/` (campaign composer), `settings/` (analysis profiles, notifications, soft phone), `team/`.

Soft-phone pages (docs/softphone.md §7; the supervisor's list and call detail are the next entry). `agency/SoftphonePage.tsx` is `/dialer/phone`, full-viewport and outside both shells, gated like `/station` and reading `agency_softphone_enabled` itself (off: it rehydrates only an existing soft-phone session, into finish mode, else is unavailable, and a session the server will not reopen can still be closed): it opens a soft-phone session (`break/soft_phone` from birth) through `agency/softphone/useSoftphoneSession.ts`, connects the station socket for it, warms playback and probes the microphone on the agent's first gesture, and renders `SoftphoneView`; an agent live on a campaign is refused (`session_on_campaign`) and offered the switch on that session. In the station, `agency/station/useStationSoftphone.ts` (SP7) decides when the station is on the soft phone (`break/soft_phone`, or after a reload `session.on_softphone` from the soft-phone bootstrap; whatever the flag map says, so the flag turned off leaves finish mode rather than an ordinary break) and owns Return to campaign (`POST /sessions/:id/softphone/return`, disabled with its reason while a call is live or owes its outcome); `AgentConsolePage` then renders `SoftphoneView` under the station header with the disclosures and Return to campaign, shows `components/agency/SoftphoneJoinScreen.tsx` for `session_on_softphone` (`useStationJoin`'s `onSoftphoneElsewhere`, with **Close the soft phone and join**: `closeSoftphoneAndJoin` reads the soft-phone bootstrap, closes nothing while a call there is live or owes its outcome, then leaves that session and joins), and suspends the station's shortcuts (`useStationShortcuts`'s `suspended`); `useAgencyConsole` routes a manual call through the same audio `sync` (`audioTarget`) and exposes `pendingSoftphone`, `requestSoftphone` and `softphoneRejection` to the action bar. `agency/AgencyCampaignManualCallsPage.tsx` is a campaign's Soft-phone calls tab (`/agency/campaigns/:id/manual-calls`): the account's soft-phone list with the campaign tag fixed, apart from its Call attempts. `settings/SoftphoneSettingsPage.tsx` is Settings → Soft phone (`/app/softphone`): the untagged outcome list, the call-fields editor (keys locked once saved), summary profile, recording and default caller ID, editable with `agency.softphone.manage` and read-only otherwise. `agency/AgentAttemptsPage.tsx` (My calls) has a Soft-phone calls tab (`?view=softphone`, arrow keys switch tabs) when the soft phone is on for the agent, and `agency/DncPage.tsx`'s copy says exactly what the soft phone checks, with an audited override (SP1), where `agency_softphone_enabled` is on. `agency/AgencyContactDetailPage.tsx` lists, below a roster contact's attempts, the soft-phone calls that matched it (`GET /softphone/calls?contact_id=`), where the flag is on and the caller holds `agency.supervise` (below it the list would hold only the caller's own calls).

Files: `AppHomeRedirect.tsx`, `agency/AgencyAnalyticsPage.module.css`, `agency/AgencyAnalyticsPage.tsx`, `agency/AgencyAttemptCallPage.module.css`, `agency/AgencyAttemptCallPage.tsx`, `agency/AgencyCampaignActivityPage.module.css`, `agency/AgencyCampaignActivityPage.tsx`, `agency/AgencyCampaignAttemptsPage.module.css`, `agency/AgencyCampaignAttemptsPage.tsx`, `agency/AgencyCampaignContactsPage.module.css`, `agency/AgencyCampaignContactsPage.tsx`, `agency/AgencyCampaignDetailPage.module.css`, `agency/AgencyCampaignDetailPage.tsx`, `agency/AgencyCampaignManualCallsPage.tsx`, `agency/AgencyCampaignRosterPage.module.css`, `agency/AgencyCampaignRosterPage.tsx`, `agency/AgencyCampaignSettingsPage.module.css`, `agency/AgencyCampaignSettingsPage.tsx`, `agency/AgencyCampaignStatusBadge.tsx`, `agency/AgencyCampaignsPage.module.css`, `agency/AgencyCampaignsPage.tsx`, `agency/AgencyContactDetailPage.module.css`, `agency/AgencyContactDetailPage.tsx`, `agency/AgencyHomeRedirect.tsx`, `agency/AgencyJoinPage.tsx`, `agency/AgencyLoginPage.module.css`, `agency/AgencyLoginPage.tsx`, `agency/AgentAttemptsPage.tsx`, `agency/AgentConsolePage.tsx`, `agency/AgentHomePage.module.css`, `agency/AgentHomePage.tsx`, `agency/AgentPerformancePage.module.css`, `agency/AgentPerformancePage.tsx`, `agency/CallerIdPicker.module.css`, `agency/CallerIdPicker.tsx`, `agency/DncPage.module.css`, `agency/DncPage.tsx`, `agency/SoftphonePage.tsx`, `agency/campaign-detail/CampaignDetailHeader.tsx`, `agency/campaign-detail/CampaignOverviewPanel.tsx`, `agency/campaign-detail/useAgencyCampaignDetail.ts`, `agency/campaigns-home/ActiveCampaignCard.tsx`, `agency/campaigns-home/CampaignRow.tsx`, `agency/campaigns-home/GetStarted.tsx`, `agency/campaigns-home/Shortcuts.tsx`, `agency/campaigns-home/useCampaignsHome.ts`, `agency/station/useDncAction.ts`, `agency/station/useHangup.ts`, `agency/station/useStationExit.ts`, `agency/station/useStationJoin.ts`, `agency/station/useStationShortcuts.ts`, `agency/station/useStationSoftphone.ts`, `agency/useAgencyConsole.ts`, `auth/JoinPage.tsx`, `auth/LoginPage.module.css`, `auth/VerifyEmailPage.tsx`, `calls/CallDetailPage.module.css`, `campaigns/agency/BuilderStepper.module.css`, `campaigns/agency/BuilderStepper.tsx`, `campaigns/agency/BuilderSummary.module.css`, `campaigns/agency/BuilderSummary.tsx`, `campaigns/agency/CallingHoursFields.tsx`, `campaigns/agency/CampaignBehaviourSection.module.css`, `campaigns/agency/CampaignBehaviourSection.tsx`, `campaigns/agency/CampaignBuilderPage.module.css`, `campaigns/agency/CampaignBuilderPage.tsx`, `campaigns/agency/ColumnMapper.module.css`, `campaigns/agency/ColumnMapper.tsx`, `campaigns/agency/DispositionCatalogEditor.tsx`, `campaigns/agency/IngestSummary.module.css`, `campaigns/agency/IngestSummary.tsx`, `campaigns/agency/RetryPolicyTable.tsx`, `campaigns/agency/WrapupFields.tsx`, `campaigns/agency/builderFlow.ts`, `campaigns/agency/configFieldErrors.tsx`, `campaigns/components/ComposerSection.module.css`, `campaigns/components/ComposerSection.tsx`, `settings/AnalysisProfilesPage.module.css`, `settings/AnalysisProfilesPage.tsx`, `settings/NotificationSettingsPage.module.css`, `settings/NotificationSettingsPage.tsx`, `settings/SoftphoneSettingsPage.module.css`, `settings/SoftphoneSettingsPage.tsx`, `settings/analysisProfileForm.ts`, `team/InviteModal.tsx`, `team/MemberActionsMenu.tsx`, `team/ResendInviteModal.tsx`, `team/TeamPage.module.css`, `team/TeamPage.tsx`, `team/teamInvites.ts`, `team/teamRoles.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/pages/AgencyAnalyticsPage.test.tsx` | 23 |
| `apps/console/src/__tests__/pages/AgencyAttemptCallPage.test.tsx` | 19 |
| `apps/console/src/__tests__/pages/AgencyCampaignActivityPage.test.tsx` | 43 |
| `apps/console/src/__tests__/pages/AgencyCampaignAttemptsPage.test.tsx` | 23 |
| `apps/console/src/__tests__/pages/AgencyCampaignContactsPage.test.tsx` | 6 |
| `apps/console/src/__tests__/pages/AgencyCampaignDetailPage.test.tsx` | 97 |
| `apps/console/src/__tests__/pages/AgencyCampaignRosterPage.test.tsx` | 22 |
| `apps/console/src/__tests__/pages/AgencyCampaignSettingsPage.test.tsx` | 36 |
| `apps/console/src/__tests__/pages/AgencyCampaignsPage.test.tsx` | 23 |
| `apps/console/src/__tests__/pages/AgencyContactDetailPage.test.tsx` | 29 |
| `apps/console/src/__tests__/pages/AgencyHomeRedirect.test.tsx` | 7 |
| `apps/console/src/__tests__/pages/AgencyJoinPage.test.tsx` | 57 |
| `apps/console/src/__tests__/pages/AgencyLoginPage.test.tsx` | 38 |
| `apps/console/src/__tests__/pages/AgentAttemptsPage.softphone.test.tsx` | 3 |
| `apps/console/src/__tests__/pages/AgentAttemptsPage.test.tsx` | 46 |
| `apps/console/src/__tests__/pages/AgentConsolePage.audio.test.tsx` | 47 |
| `apps/console/src/__tests__/pages/AgentConsolePage.callbackDnc.test.tsx` | 31 |
| `apps/console/src/__tests__/pages/AgentConsolePage.cueVisual.test.tsx` | 22 |
| `apps/console/src/__tests__/pages/AgentConsolePage.renders.test.tsx` | 5 |
| `apps/console/src/__tests__/pages/AgentConsolePage.retry.test.tsx` | 14 |
| `apps/console/src/__tests__/pages/AgentConsolePage.softphone.test.tsx` | 24 |
| `apps/console/src/__tests__/pages/AgentConsolePage.stationExit.test.tsx` | 43 |
| `apps/console/src/__tests__/pages/AgentConsolePage.test.tsx` | 46 |
| `apps/console/src/__tests__/pages/AgentHomePage.test.tsx` | 29 |
| `apps/console/src/__tests__/pages/AgentPerformancePage.test.tsx` | 51 |
| `apps/console/src/__tests__/pages/AnalysisProfilesPage.test.tsx` | 9 |
| `apps/console/src/__tests__/pages/AppHomeRedirect.test.tsx` | 6 |
| `apps/console/src/__tests__/pages/CampaignBuilderPage.config.test.tsx` | 39 |
| `apps/console/src/__tests__/pages/CampaignBuilderPage.flow.test.tsx` | 9 |
| `apps/console/src/__tests__/pages/CampaignBuilderPage.test.tsx` | 19 |
| `apps/console/src/__tests__/pages/DncPage.test.tsx` | 21 |
| `apps/console/src/__tests__/pages/JoinPage.test.tsx` | 43 |
| `apps/console/src/__tests__/pages/NotificationSettingsPage.test.tsx` | 22 |
| `apps/console/src/__tests__/pages/RecordingSection.test.tsx` | 9 |
| `apps/console/src/__tests__/pages/SoftphonePage.audio.test.tsx` | 3 |
| `apps/console/src/__tests__/pages/SoftphonePage.test.tsx` | 15 |
| `apps/console/src/__tests__/pages/SoftphoneSettingsPage.test.tsx` | 8 |
| `apps/console/src/__tests__/pages/TeamPage.a11y.test.tsx` | 1 |
| `apps/console/src/__tests__/pages/TeamPage.actionErrors.test.tsx` | 5 |
| `apps/console/src/__tests__/pages/TeamPage.actionsMenu.test.tsx` | 8 |
| `apps/console/src/__tests__/pages/TeamPage.analytics.test.tsx` | 2 |
| `apps/console/src/__tests__/pages/TeamPage.inviteHandoff.test.tsx` | 33 |
| `apps/console/src/__tests__/pages/TeamPage.resendInvite.test.tsx` | 46 |
| `apps/console/src/__tests__/pages/TranscriptSection.test.tsx` | 7 |
| `apps/console/src/__tests__/pages/VerifyEmailPage.returnPath.test.tsx` | 6 |
| `apps/console/src/__tests__/pages/agencyRoutes.test.tsx` | 5 |
| `apps/console/src/__tests__/pages/dialerEntryRoutes.test.tsx` | 15 |
| `apps/console/src/__tests__/pages/joinRoutes.test.tsx` | 6 |
| `apps/console/src/__tests__/pages/useAgencyConsole.cues.test.ts` | 12 |
| `apps/console/src/__tests__/pages/useAgencyConsole.test.ts` | 12 |
| `apps/console/src/__tests__/pages/useAgencyConsole.wrapup.test.ts` | 16 |

### `apps/console/src/pages/agency/softphone/`

The supervisor's soft-phone surfaces (docs/softphone.md §7), each behind `agency_softphone_enabled` on top of the `/agency` subtree's gates, plus the session hook `/dialer/phone` opens with. `SoftphoneCallsPage` is `/agency/softphone`, Soft-phone calls in the agency sidebar: every manual call in the account through `SoftphoneCallsList` (the server scopes the account-wide read to `agency.supervise`), with a stats strip over the listed rows, filters (dates, agent, Logged to including Not logged, what happened, status including Waiting for an outcome, number), keyset paging, a Summary column when the account's analytics capability is on, and DNC / hours override badges. `SoftphoneCallDetailPage` is `/agency/softphone/calls/:callId`: the call view (`CallDetailView`: recording, summary, sentiment, custom dimensions, transcript) plus the outcome and who saved it (with the on-behalf marker), the agent's call details by field label, each labelled Agent beside the analysis labelled AI, and any override note; without the media it shows the record alone and says why from `call_availability` (never placed, purged, or `available` with the media withheld from a caller without `agency.supervise`, who is told the recording and analysis are a supervisor's). `useSoftphoneSession` opens or rehydrates the caller's soft-phone session (`POST /proxy/agency/softphone/sessions`) and makes sure its station socket has an upgrade token, reporting `session_on_campaign` for an agent live on a campaign. `SoftphoneSupervisor.test.tsx` also covers a campaign's Soft-phone calls page (`pages/agency/AgencyCampaignManualCallsPage.tsx`).

Files: `SoftphoneCallDetailPage.tsx`, `SoftphoneCallsPage.tsx`, `useSoftphoneSession.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/pages/SoftphoneSupervisor.test.tsx` | 18 |

### `apps/console/src/types/`

Type re-exports of `@magick-agency/contracts` for console modules; `softphone.ts` re-exports the soft phone's wire types (`api/agency/softphone.ts` in contracts).

Files: `agency-activity.ts`, `agency-campaign-series.ts`, `agency-campaign.ts`, `agency-spine.ts`, `agency-stats.ts`, `agency.ts`, `auth.ts`, `call-analysis-profile.ts`, `call.ts`, `dnc.ts`, `feature-flags.ts`, `invite.ts`, `notifications.ts`, `phone-number.ts`, `softphone.ts`, `team.ts`, `webrtc-call.ts`

_No dedicated test files._

### `apps/console/src/utils/`

Pure UI helpers: permissions, vocabulary, wrap-up, disposition submit, cue preferences, transcript preferences, series ranges and more. The soft phone's own helpers are in `softphone/` (next entry); here `agencyAgentSurfaces.ts` adds `SOFTPHONE_SURFACE` and `agentSurfacesFor` (the fourth agent screen, kept out of the fixed `AGENT_SURFACES`), `agencyCampaignTabs.ts` the Soft-phone calls tab with a `flag` that `visibleCampaignTabs` checks, and `agencyStationReducer.ts` the `manualCall` slot and its `manual_call` action. `format/` is the one rendering of counts, percentages and plurals (`number.ts`, display locale `en-IN`), durations (`duration.ts`: live timers floor, aggregates round), dates with cached formatters (`date.ts`), a named zone's wall clock (`zone.ts`) and calling days (`weekdays.ts`). `agency/` holds `metrics.ts` (`ratio`, `ratePct`, `stateShares`, `ON_SHIFT_STATES`) and the pieces the large agency modules were split into — `agentWindows`, `buckets`, `agentReadouts`, `roster/`, `overview/`, `config/` — each re-exported by its original module so import paths are unchanged.

Files: `agency/agentReadouts.ts`, `agency/agentWindows.ts`, `agency/buckets.ts`, `agency/config/callingWindow.ts`, `agency/config/configConstants.ts`, `agency/config/configValidate.ts`, `agency/metrics.ts`, `agency/overview/figure.ts`, `agency/overview/funnel.ts`, `agency/overview/lifecycle.ts`, `agency/overview/pulse.ts`, `agency/roster/benchmark.ts`, `agency/roster/cells.ts`, `agency/roster/columns.ts`, `agency/roster/notes.ts`, `agencyActivityCopy.ts`, `agencyAgentFloor.ts`, `agencyAgentPerformance.ts`, `agencyAgentRoster.ts`, `agencyAgentSurfaces.ts`, `agencyAssignmentEntry.ts`, `agencyAttemptFilters.ts`, `agencyAudioCopy.ts`, `agencyBestHours.ts`, `agencyCampaignConfigForm.ts`, `agencyCampaignContribution.ts`, `agencyCampaignControls.ts`, `agencyCampaignLineage.ts`, `agencyCampaignOverview.ts`, `agencyCampaignPerformance.ts`, `agencyCampaignRecording.ts`, `agencyCampaignSeries.ts`, `agencyCampaignTabs.ts`, `agencyCampaignsHome.ts`, `agencyCatalogSync.ts`, `agencyClock.ts`, `agencyColumnMapping.ts`, `agencyCompareTray.ts`, `agencyContext.ts`, `agencyCuePrefs.ts`, `agencyCues.ts`, `agencyDiagnostics.ts`, `agencyDispositionForm.ts`, `agencyDispositionSubmit.ts`, `agencyDncCopy.ts`, `agencyErrors.ts`, `agencyFieldFilter.ts`, `agencyHealthStrip.ts`, `agencyIngestSummary.ts`, `agencyInviteJoinCopy.ts`, `agencyJoinConflict.ts`, `agencyLiveSession.ts`, `agencyMedia.ts`, `agencyNotes.ts`, `agencyPadGate.ts`, `agencyPersona.ts`, `agencyPriorAttempts.ts`, `agencyReleaseCopy.ts`, `agencyRetrySelector.ts`, `agencyRosterFilters.ts`, `agencySpineCopy.ts`, `agencyStaleResponse.ts`, `agencyStationExit.ts`, `agencyStationIdle.ts`, `agencyStationLiveness.ts`, `agencyStationReducer.ts`, `agencyStationWsUrl.ts`, `agencyStatsConsumers.ts`, `agencyWebAudioCueSink.ts`, `agencyWrapup.ts`, `audio-worklet-processor.ts`, `format/date.ts`, `format/duration.ts`, `format/number.ts`, `format/weekdays.ts`, `format/zone.ts`, `inviteJoin.ts`, `invitedTenant.ts`, `keyboardTarget.ts`, `permissions.ts`, `phone.ts`, `poll-backoff.ts`, `returnPath.ts`, `session.ts`, `sessionRefusal.ts`, `snake-case.ts`, `switcherFocus.ts`, `switcherSearch.ts`, `transcript-prefs.ts`, `vocabulary.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/utils/agencyActionErrorCodes.test.ts` | 5 |
| `apps/console/src/__tests__/utils/agencyActivityCopy.test.ts` | 24 |
| `apps/console/src/__tests__/utils/agencyAgentFloor.test.ts` | 67 |
| `apps/console/src/__tests__/utils/agencyAgentPerformance.test.ts` | 73 |
| `apps/console/src/__tests__/utils/agencyAgentRoster.test.ts` | 82 |
| `apps/console/src/__tests__/utils/agencyAgentSurfaces.test.ts` | 7 |
| `apps/console/src/__tests__/utils/agencyAssignmentEntry.test.ts` | 19 |
| `apps/console/src/__tests__/utils/agencyAttemptFilters.test.ts` | 30 |
| `apps/console/src/__tests__/utils/agencyAttemptRange.timezone.test.ts` | 6 |
| `apps/console/src/__tests__/utils/agencyBestHours.test.ts` | 45 |
| `apps/console/src/__tests__/utils/agencyCampaignConfigForm.test.ts` | 75 |
| `apps/console/src/__tests__/utils/agencyCampaignContribution.test.ts` | 54 |
| `apps/console/src/__tests__/utils/agencyCampaignControls.test.ts` | 10 |
| `apps/console/src/__tests__/utils/agencyCampaignLineage.test.ts` | 11 |
| `apps/console/src/__tests__/utils/agencyCampaignOverview.test.ts` | 97 |
| `apps/console/src/__tests__/utils/agencyCampaignPerformance.test.ts` | 65 |
| `apps/console/src/__tests__/utils/agencyCampaignRecording.test.ts` | 35 |
| `apps/console/src/__tests__/utils/agencyCampaignSeries.test.ts` | 91 |
| `apps/console/src/__tests__/utils/agencyCampaignSeriesRange.timezone.test.ts` | 6 |
| `apps/console/src/__tests__/utils/agencyCampaignTabs.test.ts` | 17 |
| `apps/console/src/__tests__/utils/agencyCampaignsHome.test.ts` | 16 |
| `apps/console/src/__tests__/utils/agencyCatalogSync.test.ts` | 30 |
| `apps/console/src/__tests__/utils/agencyClock.test.ts` | 20 |
| `apps/console/src/__tests__/utils/agencyColumnMapping.test.ts` | 28 |
| `apps/console/src/__tests__/utils/agencyCompareTray.test.ts` | 23 |
| `apps/console/src/__tests__/utils/agencyContext.test.ts` | 15 |
| `apps/console/src/__tests__/utils/agencyCuePrefs.test.ts` | 6 |
| `apps/console/src/__tests__/utils/agencyCues.test.ts` | 20 |
| `apps/console/src/__tests__/utils/agencyDiagnostics.test.ts` | 4 |
| `apps/console/src/__tests__/utils/agencyDispositionForm.test.ts` | 26 |
| `apps/console/src/__tests__/utils/agencyDispositionSubmit.test.ts` | 34 |
| `apps/console/src/__tests__/utils/agencyDncCopy.test.ts` | 20 |
| `apps/console/src/__tests__/utils/agencyErrors.test.ts` | 4 |
| `apps/console/src/__tests__/utils/agencyFieldFilter.test.ts` | 12 |
| `apps/console/src/__tests__/utils/agencyHealthStrip.test.ts` | 46 |
| `apps/console/src/__tests__/utils/agencyIngestSummary.test.ts` | 27 |
| `apps/console/src/__tests__/utils/agencyInviteJoinCopy.test.ts` | 28 |
| `apps/console/src/__tests__/utils/agencyJoinConflict.test.ts` | 24 |
| `apps/console/src/__tests__/utils/agencyLiveSession.test.ts` | 19 |
| `apps/console/src/__tests__/utils/agencyMedia.test.ts` | 18 |
| `apps/console/src/__tests__/utils/agencyNotes.test.ts` | 43 |
| `apps/console/src/__tests__/utils/agencyPadGate.test.ts` | 11 |
| `apps/console/src/__tests__/utils/agencyPermissionMirror.test.ts` | 13 |
| `apps/console/src/__tests__/utils/agencyPersona.test.ts` | 23 |
| `apps/console/src/__tests__/utils/agencyPriorAttempts.test.ts` | 13 |
| `apps/console/src/__tests__/utils/agencyReleaseCopy.test.ts` | 46 |
| `apps/console/src/__tests__/utils/agencyRetrySelector.test.ts` | 48 |
| `apps/console/src/__tests__/utils/agencyRosterFilters.test.ts` | 11 |
| `apps/console/src/__tests__/utils/agencyShellBoundary.test.ts` | 2 |
| `apps/console/src/__tests__/utils/agencySpineCopy.test.ts` | 9 |
| `apps/console/src/__tests__/utils/agencyStaleResponse.test.ts` | 18 |
| `apps/console/src/__tests__/utils/agencyStationExit.test.ts` | 19 |
| `apps/console/src/__tests__/utils/agencyStationIdle.test.ts` | 5 |
| `apps/console/src/__tests__/utils/agencyStationLiveness.test.ts` | 8 |
| `apps/console/src/__tests__/utils/agencyStationReducer.test.ts` | 21 |
| `apps/console/src/__tests__/utils/agencyStatsConsumers.test.ts` | 37 |
| `apps/console/src/__tests__/utils/agencyWrapup.test.ts` | 33 |
| `apps/console/src/__tests__/utils/agentPermissions.test.ts` | 22 |
| `apps/console/src/__tests__/utils/agentWindows.timezone.test.ts` | 8 |
| `apps/console/src/__tests__/utils/audio-worklet-processor.test.ts` | 10 |
| `apps/console/src/__tests__/utils/build-splitting.test.ts` | 2 |
| `apps/console/src/__tests__/utils/builderFlow.test.ts` | 5 |
| `apps/console/src/__tests__/utils/format.test.ts` | 16 |
| `apps/console/src/__tests__/utils/inviteJoin.test.ts` | 8 |
| `apps/console/src/__tests__/utils/invitedTenant.test.ts` | 7 |
| `apps/console/src/__tests__/utils/keyboardTarget.test.ts` | 13 |
| `apps/console/src/__tests__/utils/permissions.test.ts` | 41 |
| `apps/console/src/__tests__/utils/phone.test.ts` | 7 |
| `apps/console/src/__tests__/utils/poll-backoff.test.ts` | 13 |
| `apps/console/src/__tests__/utils/returnPath.test.ts` | 81 |
| `apps/console/src/__tests__/utils/sessionRefusal.test.ts` | 5 |
| `apps/console/src/__tests__/utils/switcherFocus.test.ts` | 4 |
| `apps/console/src/__tests__/utils/switcherSearch.test.ts` | 6 |
| `apps/console/src/__tests__/utils/vocabulary.analysis.test.ts` | 15 |
| `apps/console/src/__tests__/utils/vocabulary.test.ts` | 16 |

### `apps/console/src/utils/softphone/`

The soft phone's pure rules (docs/softphone.md §7). `callState.ts` reads a manual call: `softphonePhase` (the rail's five states from one row), `isCallLive` / `isCallUnsettled`, `newerCall` (the one rule for the newest copy, the `manual_call` frame winning a tie; the station reducer's `manual_call` action uses it), `callEndSummary`, `contactName` and `describeSoftphoneRail`. `audioTarget.ts` tells `useAgencyAudio.sync` what to do for a station carrying an attempt or a manual call: arm the microphone when dialling starts (`queued`) and open the uplink only on `bridged_at`. `phoneInput.ts` is the number field: key presses, typing (`normaliseTypedNumber`: a leading trunk `0` dropped beside the country-code chip, `00` as `+`), `normalisePastedNumber` (`+91`, `00`, a trunk `0`, a bracketed `(0)` after a country code, spaces, `tel:`), `dialBlockReason` and display formatting; the server normalises to E.164, so nothing here guesses a country for a bare national number. `callFields.ts` is call-field values and the client half of `fields_invalid` (only keys of the rendered set, typed as the set says; a required field may be empty until the outcome is saved). `overrides.ts` describes the DNC (SP1) and calling-hours (SP2) refusals for the override dialog (entry scope, reason and date; window, timezone, next opening) and checks the 10–500 character note (`withOverride`, `overrideNoteBlock`). `refusalCopy.ts` is a `Record` over the whole refusal code union, so a new contract code without copy fails the type check; `refusalCopy`'s `status` context (the station's switch and Return to campaign) words `dial_failed` as a status that did not change, not a call that was not placed. `ringback.ts` (`RingbackTone`) makes the ringback in the browser (400 + 450 Hz, ring-ring) from `ringing` until `answered`, `bridged`, `ended` or Mute. `callLabels.ts` names a listed call's outcome from the catalog it was saved against (`disposition_source`), where it was logged, and when (`recentCallWhen`: Today, Yesterday or a date, with the time). `callStats.ts` is the list's stats strip over the listed rows (there is no aggregate route) and its filter query. `fieldSettings.ts` is the Settings call-fields editor (at most 20, snake_case keys up to 50 characters, unique, a `choice` needs options; a saved field's key is locked) and `settingsForm.ts` the Settings draft, its `PUT /settings` payload and the client half of `settings_invalid`, the outcome list held to the campaign builder's catalog rules.

Files: `audioTarget.ts`, `callFields.ts`, `callLabels.ts`, `callState.ts`, `callStats.ts`, `fieldSettings.ts`, `overrides.ts`, `phoneInput.ts`, `refusalCopy.ts`, `ringback.ts`, `settingsForm.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/utils/softphoneCallState.test.ts` | 17 |
| `apps/console/src/__tests__/utils/softphoneCallLabels.test.ts` | 4 |
| `apps/console/src/__tests__/utils/softphoneFields.test.ts` | 18 |
| `apps/console/src/__tests__/utils/softphoneOverrides.timezone.test.ts` | 5 |
| `apps/console/src/__tests__/utils/softphonePhoneInput.test.ts` | 31 |
| `apps/console/src/__tests__/utils/softphoneCallLabels.test.ts` | 6 |
| `apps/console/src/__tests__/utils/softphoneRingback.test.ts` | 4 |

`softphoneCallState.test.ts` also covers the station reducer's `manual_call` action (`utils/agencyStationReducer.ts`); `softphoneFields.test.ts` covers `callFields`, `fieldSettings`, `settingsForm`, the override note, `refusalCopy` and `callStats`.

### Cross-cutting tests (`apps/console`)

Scenario, flow, guard and setup tests that span several modules.

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/AuthContext.session.test.tsx` | 8 |
| `apps/console/src/__tests__/agencyBucketDates.timezone.test.tsx` | 8 |
| `apps/console/src/__tests__/analysisProfileForm.test.ts` | 15 |
| `apps/console/src/__tests__/branding/noParentBrand.test.ts` | 5 |
| `apps/console/src/__tests__/client.test.ts` | 26 |
| `apps/console/src/__tests__/devProxyPrefixes.test.ts` | 2 |
| `apps/console/src/__tests__/registration/agency-login-registration.test.ts` | 13 |
| `apps/console/src/__tests__/registration/analysis-profiles-registration.test.tsx` | 3 |
| `apps/console/src/__tests__/session.test.ts` | 9 |
| `apps/console/src/__tests__/snake-case.test.ts` | 19 |

## `apps/super-admin`

### `apps/super-admin/src/`

App shell: `App.tsx`, `main.tsx` (imports `@magick-agency/web-ui/global.css`), `config.ts`, `brand.ts`.

Files: `App.tsx`, `brand.ts`, `config.ts`, `main.tsx`, `vite-env.d.ts`

_No dedicated test files._

### `apps/super-admin/src/api/`

`saFetch` and the super-admin API module (JWT in `sessionStorage`); error bodies are read by `parseApiErrorBody` from `packages/web-ui`, as in the console.

Files: `saRoutes.ts`, `super-admin.ts`

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/api/saFetch.test.ts` | 35 |
| `apps/super-admin/src/__tests__/api/saRoutes.test.ts` | 55 |

### `apps/super-admin/src/components/`

Auth guard, the super-admin's own shared widgets (`StatCard`, `AdvancedSection`, logo; the rest are in `packages/web-ui`), layout, and super-admin components (tenant feature flags, settings, members and the rest).

Files: `auth/RequireSuperAdmin.tsx`, `common/AdvancedSection.module.css`, `common/AdvancedSection.tsx`, `common/Logo.tsx`, `common/StatCard.module.css`, `common/StatCard.tsx`, `common/index.ts`, `layout/SuperAdminLayout.module.css`, `layout/SuperAdminLayout.tsx`, `layout/SuperAdminSidebar.module.css`, `layout/SuperAdminSidebar.tsx`, `super-admin/TenantFeatureFlags.module.css`, `super-admin/TenantFeatureFlags.tsx`, `super-admin/TenantPicker.module.css`, `super-admin/TenantPicker.tsx`, `super-admin/feature-flags/BooleanFlagCell.tsx`, `super-admin/feature-flags/BulkRolloutModal.tsx`, `super-admin/feature-flags/ConfirmDialog.tsx`, `super-admin/feature-flags/FlagDialog.tsx`, `super-admin/feature-flags/FlagPolicyWarning.tsx`, `super-admin/feature-flags/NumberFlagDialog.tsx`, `super-admin/feature-flags/NumericFlagCell.tsx`, `super-admin/feature-flags/OverrideReasonDialog.tsx`, `super-admin/feature-flags/TriStateControl.tsx`, `super-admin/feature-flags/featureFlags.module.css`, `super-admin/feature-flags/flagUtils.ts`

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/components/BulkRolloutModal.test.tsx` | 14 |
| `apps/super-admin/src/__tests__/components/ConfirmDialog.test.tsx` | 4 |
| `apps/super-admin/src/__tests__/components/FlagDialog.test.tsx` | 10 |
| `apps/super-admin/src/__tests__/components/Logo.test.tsx` | 3 |
| `apps/super-admin/src/__tests__/components/OverrideReasonDialog.test.tsx` | 6 |
| `apps/super-admin/src/__tests__/components/SuperAdminSidebar.version.test.tsx` | 2 |
| `apps/super-admin/src/__tests__/components/TenantFeatureFlags.test.tsx` | 45 |
| `apps/super-admin/src/__tests__/components/TenantPicker.test.tsx` | 16 |
| `apps/super-admin/src/__tests__/components/TriStateControl.test.tsx` | 12 |
| `apps/super-admin/src/__tests__/components/flagUtils.test.ts` | 9 |

### `apps/super-admin/src/contexts/`

Super-admin auth context (memoised value; the toast context is in `packages/web-ui`).

Files: `SuperAdminContext.tsx`

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/contexts/SuperAdminContext.test.tsx` | 13 |

### `apps/super-admin/src/hooks/`

Data-loading hooks. The tenant, user and admin lists are thin wrappers over `useAsyncResource` from `packages/web-ui`.

Files: `useCountUp.ts`, `useSuperAdminAdmins.ts`, `useSuperAdminAudit.ts`, `useSuperAdminTenant.ts`, `useSuperAdminTenants.ts`, `useSuperAdminUsageCounts.ts`, `useSuperAdminUsers.ts`

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/hooks/useSuperAdminLists.test.ts` | 6 |
| `apps/super-admin/src/__tests__/hooks/useSuperAdminTenant.test.ts` | 3 |
| `apps/super-admin/src/__tests__/hooks/useSuperAdminUsageCounts.test.ts` | 15 |

### `apps/super-admin/src/pages/`

Login, and the super-admin pages: tenants and tenant detail, users, admins, phone numbers, feature flags, usage, audit. The tenant detail page's Service and Members tabs and its account settings panel are in `super-admin/tenant-detail/`; the phone numbers page's create and edit modals and its bulk selection hook are in `super-admin/phone-numbers/`.

Files: `auth/SuperAdminLoginPage.module.css`, `auth/SuperAdminLoginPage.tsx`, `super-admin/SAAdminsPage.module.css`, `super-admin/SAAdminsPage.tsx`, `super-admin/SAAuditPage.module.css`, `super-admin/SAAuditPage.tsx`, `super-admin/SAFeatureFlagsPage.module.css`, `super-admin/SAFeatureFlagsPage.tsx`, `super-admin/phone-numbers/PhoneNumberCreateModal.tsx`, `super-admin/phone-numbers/PhoneNumberEditModal.tsx`, `super-admin/phone-numbers/usePhoneNumberBulk.ts`, `super-admin/SAPhoneNumbersPage.module.css`, `super-admin/SAPhoneNumbersPage.tsx`, `super-admin/SATelephonyCredentialsPage.module.css`, `super-admin/SATelephonyCredentialsPage.tsx`, `super-admin/SATenantDetailPage.module.css`, `super-admin/SATenantDetailPage.tsx`, `super-admin/tenant-detail/AccountSettingsPanel.tsx`, `super-admin/tenant-detail/TenantMembersTab.tsx`, `super-admin/tenant-detail/TenantServiceTab.tsx`, `super-admin/SATenantsPage.module.css`, `super-admin/SATenantsPage.tsx`, `super-admin/SAUsagePage.module.css`, `super-admin/SAUsagePage.tsx`, `super-admin/SAUsersPage.module.css`, `super-admin/SAUsersPage.tsx`

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/pages/SAAuditPage.test.tsx` | 1 |
| `apps/super-admin/src/__tests__/pages/SAFeatureFlagsPage.test.tsx` | 34 |
| `apps/super-admin/src/__tests__/pages/SAPhoneNumbersPage.test.tsx` | 15 |
| `apps/super-admin/src/__tests__/pages/SATelephonyCredentialsPage.test.tsx` | 8 |
| `apps/super-admin/src/__tests__/pages/SATenantDetailPage.new.test.tsx` | 21 |
| `apps/super-admin/src/__tests__/pages/SATenantDetailPage.test.tsx` | 16 |
| `apps/super-admin/src/__tests__/pages/SATenantsPage.test.tsx` | 4 |
| `apps/super-admin/src/__tests__/pages/SAUsagePage.test.tsx` | 22 |
| `apps/super-admin/src/__tests__/pages/SAUsersPage.test.tsx` | 9 |
| `apps/super-admin/src/__tests__/pages/TenantMembersTab.test.tsx` | 4 |

### `apps/super-admin/src/utils/`

Helpers (error and format helpers are in `packages/web-ui`). `inviteEmailNotice.ts` turns the `invite_email` that tenant create and add-user answer into the note or warning the pages show.

Files: `inviteEmailNotice.ts`, `localDayBounds.ts`, `saStatus.ts`, `strictInteger.ts`, `tenant-search.ts`

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/utils/inviteEmailNotice.test.ts` | 5 |
| `apps/super-admin/src/__tests__/utils/tenant-search.test.ts` | 13 |

### Cross-cutting tests (`apps/super-admin`)

Scenario, flow, guard and setup tests that span several modules.

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/App.test.tsx` | 4 |
| `apps/super-admin/src/__tests__/branding/brandAssets.test.ts` | 5 |
| `apps/super-admin/src/__tests__/branding/noParentBrand.test.ts` | 5 |
| `apps/super-admin/src/__tests__/saStatus.test.ts` | 21 |
