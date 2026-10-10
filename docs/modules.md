# Modules

An inventory of every module in the repo: what each directory holds and which test files cover
it, grouped by package. Read it to find where something lives, or to see how a module is tested
before you change it. Generated from the tree on 2026-10-09.

**Counts.** Unit counts are the per-file numbers Vitest printed on 2026-10-09. Integration counts
(marked `~`) are static counts of `it(` / `test(` calls in the file, where an `it.each` table or a
loop counts as one, so they undercount; the authoritative integration totals are in [`status.md`](status.md). Tests are listed
under the source directory they mirror; tests that span several modules are listed at the end of
each package.

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

Files: `abandon-clip.ts`, `abandonment-guardrail.ts`, `abandonment-metrics.ts`, `agency-activity-actions.ts`, `agency-activity.service.ts`, `agency-activity.ts`, `agency-actor.ts`, `agency-agent-identity.ts`, `agency-campaign-config.ts`, `agency-campaign-wire.ts`, `agency-column-analysis.ts`, `agency-csv-ingest.ts`, `agency-csv.ts`, `agency-dialer.ts`, `agency-ingest-job.repository.ts`, `agency-ingest-keys.ts`, `agency-ingest.service.ts`, `agency-rejected-csv.ts`, `agency-roster-errors.ts`, `agency-roster.client.ts`, `agency-spine.ts`, `agency-stats-enrichment.ts`, `agent-record.ts`, `agent-state-machine.ts`, `calling-hours.ts`, `campaign-behavioral-settings.ts`, `campaign-completion-notice.ts`, `campaign-config.ts`, `campaign-health.ts`, `campaign-series.ts`, `dial-dispatcher.ts`, `disposition-policy.ts`, `disposition.ts`, `dnc-availability.ts`, `dnc-mark.ts`, `dnc-registry.ts`, `live-concurrency-metrics.ts`, `outcome-classifier.ts`, `pacing-engine.ts`, `pre-dial-gates.ts`, `reaper.ts`, `retry-policy.ts`, `runtime.ts`, `spine-filters.ts`, `station-registry.ts`, `station-socket.ts`, `station-token.ts`, `wrapup-manager.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/integration/agency/abandonment-invariants.test.ts` | ~4 |
| `apps/server/test/integration/agency/agency-activity-service.test.ts` | ~6 |
| `apps/server/test/integration/agency/agency-agent-cas.test.ts` | ~6 |
| `apps/server/test/integration/agency/agency-agent-identity.test.ts` | ~4 |
| `apps/server/test/integration/agency/agency-agent-state-cycle.test.ts` | ~1 |
| `apps/server/test/integration/agency/agency-analysis-profile-reference-check.test.ts` | ~8 |
| `apps/server/test/integration/agency/agency-campaign-create.test.ts` | ~3 |
| `apps/server/test/integration/agency/agency-campaign-stats.routes.test.ts` | ~10 |
| `apps/server/test/integration/agency/agency-campaign-stats.test.ts` | ~18 |
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
| `apps/server/test/integration/agency/agency-ingest-idempotency.test.ts` | ~13 |
| `apps/server/test/integration/agency/agency-ingest-job-repository-sql.test.ts` | ~12 |
| `apps/server/test/integration/agency/agency-ingest-roundtrip.test.ts` | ~7 |
| `apps/server/test/integration/agency/agency-ingest-route-seam.test.ts` | ~7 |
| `apps/server/test/integration/agency/agency-join-rehydrate-db.test.ts` | ~13 |
| `apps/server/test/integration/agency/agency-lease-ring-duration.test.ts` | ~4 |
| `apps/server/test/integration/agency/agency-migration.test.ts` | ~13 |
| `apps/server/test/integration/agency/agency-reaper-sql.test.ts` | ~12 |
| `apps/server/test/integration/agency/agency-retry-idempotency.test.ts` | ~9 |
| `apps/server/test/integration/agency/agency-retry-seeding.test.ts` | ~21 |
| `apps/server/test/integration/agency/agency-roster-handoff.test.ts` | ~19 |
| `apps/server/test/integration/agency/agency-session-tenant-unique.test.ts` | ~5 |
| `apps/server/test/integration/agency/agency-spine-read.test.ts` | ~20 |
| `apps/server/test/integration/agency/agency-stats-enrichment.test.ts` | ~16 |
| `apps/server/test/integration/agency/agent-grouped-read.test.ts` | ~14 |
| `apps/server/test/integration/agency/agent-multi-session.test.ts` | ~7 |
| `apps/server/test/integration/agency/agent-occupancy-window.test.ts` | ~8 |
| `apps/server/test/integration/agency/agent-record-tenant-isolation.test.ts` | ~7 |
| `apps/server/test/integration/agency/agent-stats-timezone-buckets.test.ts` | ~13 |
| `apps/server/test/integration/agency/agent-transition-ordering.test.ts` | ~11 |
| `apps/server/test/integration/agency/agent-window-boundaries.test.ts` | ~11 |
| `apps/server/test/integration/agency/campaign-behavioral-settings.test.ts` | ~4 |
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
| `apps/server/test/integration/agency/dnc-registry.test.ts` | ~12 |
| `apps/server/test/integration/agency/repository-sql-coverage.test.ts` | ~11 |
| `apps/server/test/integration/agency/runtime-boot-order.test.ts` | ~3 |
| `apps/server/test/integration/agency/runtime-e2e.test.ts` | ~1 |
| `apps/server/test/unit/agency/abandon-clip-cache-roundtrip.test.ts` | 5 |
| `apps/server/test/unit/agency/abandon-clip.test.ts` | 11 |
| `apps/server/test/unit/agency/abandon-reason-telemetry.test.ts` | 26 |
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
| `apps/server/test/unit/agency/agency-campaign-config.test.ts` | 79 |
| `apps/server/test/unit/agency/agency-column-analysis.test.ts` | 14 |
| `apps/server/test/unit/agency/agency-csv-ingest.isolation.test.ts` | 4 |
| `apps/server/test/unit/agency/agency-csv-ingest.streaming.test.ts` | 2 |
| `apps/server/test/unit/agency/agency-csv-ingest.test.ts` | 54 |
| `apps/server/test/unit/agency/agency-dialer-lineage.test.ts` | 5 |
| `apps/server/test/unit/agency/agency-dialer.test.ts` | 28 |
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
| `apps/server/test/unit/agency/agent-state-machine.test.ts` | 15 |
| `apps/server/test/unit/agency/agent-stats-repository.test.ts` | 38 |
| `apps/server/test/unit/agency/calling-hours.test.ts` | 31 |
| `apps/server/test/unit/agency/campaign-abandon-config-route.test.ts` | 8 |
| `apps/server/test/unit/agency/campaign-analysis-profile-route.test.ts` | 13 |
| `apps/server/test/unit/agency/campaign-behavioral-settings.test.ts` | 52 |
| `apps/server/test/unit/agency/campaign-completion-notice.test.ts` | 6 |
| `apps/server/test/unit/agency/campaign-config-route.test.ts` | 57 |
| `apps/server/test/unit/agency/campaign-conversion-stats.test.ts` | 9 |
| `apps/server/test/unit/agency/campaign-health.test.ts` | 19 |
| `apps/server/test/unit/agency/campaign-insert-param-types.test.ts` | 3 |
| `apps/server/test/unit/agency/campaign-lifecycle-route.test.ts` | 7 |
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
| `apps/server/test/unit/agency/late-binding.test.ts` | 30 |
| `apps/server/test/unit/agency/left-session-guards.test.ts` | 37 |
| `apps/server/test/unit/agency/live-concurrency-metrics.test.ts` | 18 |
| `apps/server/test/unit/agency/live-concurrency-repository.test.ts` | 8 |
| `apps/server/test/unit/agency/our-fault-redial.test.ts` | 20 |
| `apps/server/test/unit/agency/outcome-classifier.test.ts` | 45 |
| `apps/server/test/unit/agency/pacing-engine-gates.test.ts` | 22 |
| `apps/server/test/unit/agency/pacing-engine.test.ts` | 67 |
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
| `apps/server/test/unit/agency/proxy-agency-campaigns.routes.test.ts` | 137 |
| `apps/server/test/unit/agency/proxy-agency-grouped-stats.routes.test.ts` | 113 |
| `apps/server/test/unit/agency/proxy-agency-my-surfaces.routes.test.ts` | 78 |
| `apps/server/test/unit/agency/proxy-agency-roster.routes.test.ts` | 71 |
| `apps/server/test/unit/agency/proxy-agency-route-table.test.ts` | 29 |
| `apps/server/test/unit/agency/proxy-agency-spine.routes.test.ts` | 40 |
| `apps/server/test/unit/agency/proxy-agency-staffing.routes.test.ts` | 78 |
| `apps/server/test/unit/agency/proxy-agency-station.routes.test.ts` | 10 |
| `apps/server/test/unit/agency/reaper.test.ts` | 41 |
| `apps/server/test/unit/agency/retry-policy.test.ts` | 22 |
| `apps/server/test/unit/agency/retry-selector-parse.test.ts` | 34 |
| `apps/server/test/unit/agency/roster-row-identity.test.ts` | 3 |
| `apps/server/test/unit/agency/runtime-collapses.test.ts` | 6 |
| `apps/server/test/unit/agency/session-join-conflict-route.test.ts` | 13 |
| `apps/server/test/unit/agency/spine-filters.test.ts` | 34 |
| `apps/server/test/unit/agency/spine-read-routes.test.ts` | 20 |
| `apps/server/test/unit/agency/station-heartbeat-grace.test.ts` | 19 |
| `apps/server/test/unit/agency/station-reconnect-frame.test.ts` | 4 |
| `apps/server/test/unit/agency/station-registry.test.ts` | 29 |
| `apps/server/test/unit/agency/station-supersede-stomp.test.ts` | 10 |
| `apps/server/test/unit/agency/station-token.test.ts` | 5 |
| `apps/server/test/unit/agency/supervisor-stats.test.ts` | 26 |
| `apps/server/test/unit/agency/wrapup-manager.test.ts` | 34 |

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

The HTTP surface: the four area plugins (`platform`, `agency`, `voice`, `analysis`), `callCore` (`core-dispatch.ts`) and the internal handler instance (`core-handlers.ts`), the id guard for agency routes, and profile-route auth.

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
| `apps/server/test/integration/api/agency-staffing.routes.test.ts` | ~51 |
| `apps/server/test/integration/api/agency-tenant-isolation.test.ts` | ~12 |
| `apps/server/test/integration/api/auth.routes.test.ts` | ~19 |
| `apps/server/test/integration/api/invite-security-audit.test.ts` | ~28 |
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
| `apps/server/test/unit/api/core-dispatch.test.ts` | 11 |
| `apps/server/test/unit/api/platform-agent-reach.test.ts` | 4 |
| `apps/server/test/unit/api/profile-route-auth.test.ts` | 13 |
| `apps/server/test/unit/api/route-table.test.ts` | 3 |
| `apps/server/test/unit/api/voice-route-table.test.ts` | 1 |

### `apps/server/src/api/middleware/`

App-wide middleware: rate limiter and its buckets, error handler with the `22P02` backstop, 5xx error mask, session and tenant-context middleware, internal tenancy headers.

Files: `agency-error-handler.ts`, `auth.middleware.ts`, `error-handler.middleware.ts`, `error-mask.middleware.ts`, `headers.ts`, `rate-limit.middleware.ts`, `tenant-context.middleware.ts`

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

Files: `account.routes.ts`, `agency-agents.routes.ts`, `agency-campaigns.routes.ts`, `agency.routes.ts`, `auth.routes.ts`, `call-analysis-profiles.routes.ts`, `dnc.routes.ts`, `feature-flags.routes.ts`, `helpers/csv-attachment.ts`, `helpers/path-params.ts`, `invites.routes.ts`, `notification.routes.ts`, `phone-number.routes.ts`, `proxy-agency-agent.routes.ts`, `proxy-agency-calls.routes.ts`, `proxy-agency-campaigns.routes.ts`, `proxy-agency-performance.routes.ts`, `proxy-agency-staffing.routes.ts`, `proxy-agency-station.routes.ts`, `super-admin-account-settings.routes.ts`, `super-admin-feature-flags.routes.ts`, `super-admin-phone.routes.ts`, `super-admin-usage-counts.routes.ts`, `super-admin.routes.ts`, `tenant.routes.ts`, `user.routes.ts`, `webhooks.routes.ts`, `webrtc-call.routes.ts`, `webrtc-recordings.routes.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/api/routes/account.routes.test.ts` | 10 |
| `apps/server/test/unit/api/routes/call-analysis-profiles.test.ts` | 21 |
| `apps/server/test/unit/api/routes/feature-flags-client.test.ts` | 3 |
| `apps/server/test/unit/api/routes/feature-flags-internal.test.ts` | 22 |
| `apps/server/test/unit/api/routes/helpers/csv-attachment.test.ts` | 11 |
| `apps/server/test/unit/api/routes/invites.routes.test.ts` | 48 |
| `apps/server/test/unit/api/routes/membership-fail-closed.test.ts` | 7 |
| `apps/server/test/unit/api/routes/notification.routes.test.ts` | 14 |
| `apps/server/test/unit/api/routes/phone-numbers-byoc-merge.test.ts` | 6 |
| `apps/server/test/unit/api/routes/proxy-feature-flags.routes.test.ts` | 4 |
| `apps/server/test/unit/api/routes/super-admin-account-settings.test.ts` | 24 |
| `apps/server/test/unit/api/routes/super-admin-accounts.test.ts` | 38 |
| `apps/server/test/unit/api/routes/super-admin-feature-flags.test.ts` | 22 |
| `apps/server/test/unit/api/routes/super-admin-memberships.test.ts` | 57 |
| `apps/server/test/unit/api/routes/super-admin-phone.test.ts` | 9 |
| `apps/server/test/unit/api/routes/super-admin-usage-counts.test.ts` | 22 |
| `apps/server/test/unit/api/routes/tenant.routes.test.ts` | 9 |
| `apps/server/test/unit/api/routes/user-cache-invalidation.wiring.test.ts` | 4 |
| `apps/server/test/unit/api/routes/user-invite-mailer-isolation.test.ts` | 6 |
| `apps/server/test/unit/api/routes/user-offboarding-staffing.test.ts` | 30 |
| `apps/server/test/unit/api/routes/user.routes.test.ts` | 46 |
| `apps/server/test/unit/api/routes/voicelink-webhooks.test.ts` | 4 |
| `apps/server/test/unit/api/routes/webrtc-recordings.test.ts` | 6 |

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
| `apps/server/test/unit/core/webrtc-bridge-late-binding.test.ts` | 17 |
| `apps/server/test/unit/core/webrtc-bridge-manager.bridged.test.ts` | 8 |
| `apps/server/test/unit/core/webrtc-bridge-manager.seams.test.ts` | 12 |
| `apps/server/test/unit/core/webrtc-bridge-manager.test.ts` | 58 |
| `apps/server/test/unit/core/webrtc-bridge-ring-cancel.test.ts` | 15 |
| `apps/server/test/unit/core/webrtc-bridge-seam-contract.test.ts` | 3 |
| `apps/server/test/unit/core/webrtc-bridge-session.test.ts` | 31 |
| `apps/server/test/unit/core/webrtc-scenarios.test.ts` | 13 |

### `apps/server/src/db/`

The agency repository (`agency.repository.ts`, decision B12), membership invites, notification deliveries and preferences, the telephony provider repository, and their models.

Files: `models/agency.model.ts`, `models/membership-invite.model.ts`, `models/notification.model.ts`, `repositories/agency.repository.ts`, `repositories/membership-invite.repository.ts`, `repositories/notification-delivery.repository.ts`, `repositories/notification-preference.repository.ts`, `repositories/telephony-provider.repository.ts`

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
| `apps/server/test/unit/db/repositories/telephony-provider.repository.test.ts` | 10 |

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
| `apps/server/test/unit/feature-flags/registry.test.ts` | 13 |

### `apps/server/src/invites/`

Invite issuing and invite state.

Files: `invite-issuer.ts`, `membership-invite-state.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/invites/invite-issuer.test.ts` | 16 |
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

Files: `agency-campaign-completion.ts`, `engine/audience.ts`, `engine/catalog.ts`, `engine/deliver.ts`, `engine/period.ts`, `escape-html.ts`, `invite-mailer.ts`, `invite-token.ts`, `mailjet.client.ts`, `templates/agent-invite.template.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/notifications/agency-campaign-completion.test.ts` | 42 |
| `apps/server/test/unit/notifications/agency-campaign-unsubscribe.test.ts` | 8 |
| `apps/server/test/unit/notifications/agent-invite.template.test.ts` | 25 |
| `apps/server/test/unit/notifications/engine/audience.test.ts` | 34 |
| `apps/server/test/unit/notifications/engine/catalog.test.ts` | 28 |
| `apps/server/test/unit/notifications/engine/deliver.test.ts` | 6 |
| `apps/server/test/unit/notifications/engine/period.test.ts` | 4 |
| `apps/server/test/unit/notifications/invite-mailer.test.ts` | 38 |
| `apps/server/test/unit/notifications/invite-token.test.ts` | 14 |
| `apps/server/test/unit/notifications/mailjet.client.test.ts` | 8 |

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

Telephony provider factory and types; the VoiceLink adapter, webhook normaliser, token manager and carrier fixture.

Files: `factory.ts`, `types.ts`, `voicelink/voicelink-carrier.fixture.json`, `voicelink/voicelink-token-manager.ts`, `voicelink/voicelink.adapter.ts`, `voicelink/voicelink.types.ts`, `voicelink/voicelink.webhook.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/telephony/byoc-factory.test.ts` | 7 |
| `apps/server/test/unit/telephony/provider-capabilities.test.ts` | 6 |
| `apps/server/test/unit/telephony/voicelink/redact-url-tail.test.ts` | 7 |
| `apps/server/test/unit/telephony/voicelink/voicelink-carrier.fixture.test.ts` | 178 |
| `apps/server/test/unit/telephony/voicelink/voicelink-token-manager.test.ts` | 23 |
| `apps/server/test/unit/telephony/voicelink/voicelink.adapter.edge-cases.test.ts` | 14 |
| `apps/server/test/unit/telephony/voicelink/voicelink.adapter.test.ts` | 38 |
| `apps/server/test/unit/telephony/voicelink/voicelink.webhook.test.ts` | 125 |

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

Shared helpers: audio and FIR filter, concurrency, decode gate, phone normaliser, recording URL signing and resolution, recording proxy, URL redaction (logs and OTel spans), the OTel SDK's pure configuration (`otel-sdk-config.ts`: export interval, resource, metric views, fresh gauges, the bounded shutdown), retry, safe emit, webhook base URL, WebSocket no-delay, abort errors.

Files: `abort-error.ts`, `audio-fir.ts`, `audio.ts`, `concurrency.ts`, `decode-gate.ts`, `otel-sdk-config.ts`, `phone-normalizer.ts`, `recording-proxy.ts`, `recording-url-resolver.ts`, `recording-url.ts`, `redact-url.ts`, `retry.ts`, `safe-emit.ts`, `webhook-base.ts`, `ws-nodelay.ts`

| Test file | Cases |
|---|---|
| `apps/server/test/unit/utils/audio-downmix.test.ts` | 11 |
| `apps/server/test/unit/utils/audio-fir.test.ts` | 24 |
| `apps/server/test/unit/utils/audio.test.ts` | 41 |
| `apps/server/test/unit/utils/concurrency.core.test.ts` | 9 |
| `apps/server/test/unit/utils/concurrency.test.ts` | 14 |
| `apps/server/test/unit/utils/decode-gate.test.ts` | 23 |
| `apps/server/test/unit/utils/metrics-tts-clip-cache.test.ts` | 7 |
| `apps/server/test/unit/utils/otel-sdk-config.test.ts` | 31 |
| `apps/server/test/unit/utils/recording-proxy-resolve.test.ts` | 9 |
| `apps/server/test/unit/utils/recording-proxy.test.ts` | 25 |
| `apps/server/test/unit/utils/recording-url.test.ts` | 13 |
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

## `grafana`

### `grafana/`

Agency's alert rules and dashboard as a Terraform root module with its own local state (decision B6); routing comes from the stack's shared notification policy. See `grafana/README.md`.

Files: `README.md`, `dashboards/magick-agency-overview.json`, `scripts/metric-declarations.mjs`, `terraform/alert-rules.tf`, `terraform/alerting.tf`, `terraform/dashboard.tf`, `terraform/terraform.tfvars.example`, `terraform/variables.tf`, `terraform/versions.tf`

| Test file | Cases |
|---|---|
| `grafana/scripts/validate-alerts.test.mjs` (`pnpm test:grafana`, node:test) | 16 |
| `grafana/scripts/validate-dashboard.test.mjs` (`pnpm test:grafana`, node:test) | 15 |

## `packages/contracts`

### `packages/contracts/src/`

Dialer types (`agency.ts`), error-code unions (`errors.ts`), feature flags (`flags.ts`), roles and permission matrix (`rbac.ts`), barrel.

Files: `agency.ts`, `errors.ts`, `flags.ts`, `index.ts`, `rbac.ts`

| Test file | Cases |
|---|---|
| `packages/contracts/test/console-wire-diff.test.ts` | 2 |
| `packages/contracts/test/errors.test.ts` | 9 |
| `packages/contracts/test/exports.test.ts` | 4 |
| `packages/contracts/test/flags.test.ts` | 6 |
| `packages/contracts/test/rbac.test.ts` | 48 |
| `packages/contracts/test/stall.test.ts` | 4 |

### `packages/contracts/src/api/agency/`

Console wire types for the agency API: campaigns, series, stats, spine, activity, analysis profiles, DNC, calls, attempt call; `CONTRACT-DIFF.md` lists where they differ from `agency.ts`.

Files: `agency-activity.ts`, `agency-campaign-series.ts`, `agency-campaign.ts`, `agency-spine.ts`, `agency-stats.ts`, `agency.ts`, `attempt-call.ts`, `call-analysis-profile.ts`, `dnc.ts`, `index.ts`, `shared.ts`, `webrtc-call.ts`

_No dedicated test files._

### `packages/contracts/src/api/platform/`

Wire types for the platform API: auth and session, team, invites, notifications, settings, feature flags, audit, super-admin and usage.

Files: `audit.ts`, `auth.ts`, `feature-flags.ts`, `index.ts`, `invite.ts`, `notifications.ts`, `settings.ts`, `super-admin-usage.ts`, `super-admin.ts`, `team.ts`

_No dedicated test files._

## `packages/db`

### `packages/db/src/`

pg pool and TLS options (`connection.ts`), migrations directory, pg error helpers, barrel.

Files: `connection.ts`, `index.ts`, `migrations-dir.ts`, `pg-errors.ts`

_No dedicated test files._

### `packages/db/src/models/`

Row models for the shared tables.

Files: `account-settings.model.ts`, `account.model.ts`, `agency-call.model.ts`, `announcement.model.ts`, `audio-file.model.ts`, `audit.model.ts`, `call-analysis-profile.model.ts`, `call.model.ts`, `conversation-entry.model.ts`, `dialer-analysis-job.model.ts`, `feature-flag.model.ts`, `membership.model.ts`, `phone-number.model.ts`, `prompt.model.ts`, `static-call.model.ts`, `super-admin.model.ts`, `telephony-provider.model.ts`, `tenant-phone-assignment.model.ts`, `tenant.model.ts`, `user.model.ts`

_No dedicated test files._

### `packages/db/src/models/platform/`

Platform audit model.

Files: `audit.model.ts`

_No dedicated test files._

### `packages/db/src/repositories/`

Shared repositories: tenants, accounts, users, memberships, super-admins and their audit, phone numbers and assignments, account settings, provider concurrency, agency calls, staffing, call-analysis profiles, analysis jobs, audio files, announcements, feature flags, audit, usage counts.

Files: `account-settings.repository.ts`, `account.repository.ts`, `agency-call.repository.ts`, `agency-campaign-agent.repository.ts`, `announcement.repository.ts`, `audio-file.repository.ts`, `audit.repository.ts`, `call-analysis-profile.repository.ts`, `dialer-analysis-job.repository.ts`, `feature-flag.repository.ts`, `membership.repository.ts`, `phone-number.repository.ts`, `provider-concurrency.repository.ts`, `super-admin-audit.repository.ts`, `super-admin.repository.ts`, `tenant-phone-assignment.repository.ts`, `tenant.repository.ts`, `usage-counts.repository.ts`, `user.repository.ts`

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
| `packages/db/test/integration/repositories/dialer-analysis-job.repository.test.ts` | ~9 |
| `packages/db/test/integration/repositories/membership.repository.test.ts` | ~33 |
| `packages/db/test/integration/repositories/phone-number.repository.test.ts` | ~8 |
| `packages/db/test/integration/repositories/provider-concurrency.repository.test.ts` | ~3 |
| `packages/db/test/integration/repositories/shared-infra-coverage.test.ts` | ~8 |
| `packages/db/test/integration/repositories/tenant.repository.test.ts` | ~13 |
| `packages/db/test/integration/repositories/usage-counts.repository.test.ts` | ~7 |
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
| `packages/db/test/unit/db/repositories/webrtc-call-repository-analysis.test.ts` | 8 |
| `packages/db/test/unit/db/repositories/webrtc-call-scope.test.ts` | 12 |

### `packages/db/src/repositories/platform/`

Platform audit repository.

Files: `audit.repository.ts`

| Test file | Cases |
|---|---|
| `packages/db/test/unit/db/repositories/platform/audit.repository.test.ts` | 30 |

### `packages/db/src/utils/`

Single-flight, SQL update builder, TTL cache.

Files: `single-flight.ts`, `sql-update.ts`, `ttl-cache.ts`

| Test file | Cases |
|---|---|
| `packages/db/test/unit/utils/single-flight.test.ts` | 16 |
| `packages/db/test/unit/utils/sql-update.test.ts` | 8 |
| `packages/db/test/unit/utils/ttl-cache.test.ts` | 51 |

### Cross-cutting tests (`packages/db`)

Scenario, flow, guard and setup tests that span several modules.

| Test file | Cases |
|---|---|
| `packages/db/test/integration/agency/webrtc-call-scope-isolation.test.ts` | ~11 |
| `packages/db/test/integration/baseline-down-up.test.ts` | ~2 |
| `packages/db/test/integration/baseline.test.ts` | ~55 |
| `packages/db/test/integration/db/audio-file-pcm-migration.test.ts` | ~4 |
| `packages/db/test/integration/db/dialer-analysis-migration.test.ts` | ~6 |
| `packages/db/test/integration/db/webrtc-call-analysis-projection.test.ts` | ~2 |
| `packages/db/test/integration/db/webrtc-call.repository.test.ts` | ~28 |
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

Pure dialer rules: abandonment predicate, break manager, keyset cursor, rates, retry campaign bounds and summary, success disposition, timers.

Files: `abandonment-predicate.ts`, `break-manager.ts`, `index.ts`, `keyset-cursor.ts`, `rates.ts`, `retry-campaign-bounds.ts`, `retry-summary.ts`, `success-disposition.ts`, `timers.ts`

| Test file | Cases |
|---|---|
| `packages/domain/test/unit/agency/break-manager.test.ts` | 18 |
| `packages/domain/test/unit/agency/keyset-cursor.test.ts` | 9 |
| `packages/domain/test/unit/agency/retry-campaign-bounds.test.ts` | 4 |
| `packages/domain/test/unit/agency/retry-summary.test.ts` | 19 |

## `packages/observability`

### `packages/observability/src/`

Logger, log context, PII masking (`crypto.ts`), the log-side URL scrubber (`url-scrub.ts`, import-free so the OTel span hook can use it), OTel meter and metric instruments, `@Traced` and `withSpan`, service name and version.

Files: `crypto.ts`, `index.ts`, `log-context.ts`, `logger.ts`, `meter.ts`, `metric-instruments.ts`, `service.ts`, `tracing.ts`, `url-scrub.ts`, `version.ts`

| Test file | Cases |
|---|---|
| `packages/observability/test/logger.test.ts` | 4 |
| `packages/observability/test/metrics-agency.test.ts` | 8 |
| `packages/observability/test/tracing.test.ts` | 2 |

### `packages/observability/src/metrics/`

Metric declarations per module area: `platform`, `agency`, `voice`, `analysis`, `shared`.

Files: `agency.ts`, `analysis.ts`, `platform.ts`, `shared.ts`, `voice.ts`

_No dedicated test files._

## `apps/console`

### `apps/console/src/`

App shell: `App.tsx` (routes), `main.tsx`, `config.ts` (API base, endpoints, originator), global CSS.

Files: `App.tsx`, `config.ts`, `global.css`, `main.tsx`, `vite-env.d.ts`

_No dedicated test files._

### `apps/console/src/analytics/`

PostHog wiring for the console.

Files: `ProductSurface.tsx`, `events.ts`, `posthog.ts`, `redact.ts`, `useProductSurface.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/analytics/autocaptureOptOut.test.ts` | 4 |
| `apps/console/src/__tests__/analytics/events.test.ts` | 5 |
| `apps/console/src/__tests__/analytics/posthog.test.ts` | 22 |
| `apps/console/src/__tests__/analytics/productSurface.test.tsx` | 12 |
| `apps/console/src/__tests__/analytics/redact.test.ts` | 8 |

### `apps/console/src/api/`

API client (`client.ts`, auth headers) and one module per API family: accounts, agency, activity, campaigns, series, spine, stats, auth, analysis profiles, calls, DNC, CSV export, feature flags, invites, notifications, phone numbers, tenants, users.

Files: `accounts.ts`, `agency.ts`, `agencyActivity.ts`, `agencyCampaignSeries.ts`, `agencyCampaigns.ts`, `agencySpine.ts`, `agencyStats.ts`, `auth.ts`, `authHeaders.ts`, `call-analysis-profiles.ts`, `calls.ts`, `client.ts`, `dnc.ts`, `error-analytics.ts`, `exportCsv.ts`, `feature-flags.ts`, `invites.ts`, `notifications.ts`, `phone-numbers.ts`, `tenants.ts`, `users.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/api/agency-account-header.test.ts` | 30 |
| `apps/console/src/__tests__/api/agency-notes.test.ts` | 17 |
| `apps/console/src/__tests__/api/agencyActivity.test.ts` | 8 |
| `apps/console/src/__tests__/api/agencyCampaignRetry.test.ts` | 8 |
| `apps/console/src/__tests__/api/agencyCampaignSeries.test.ts` | 6 |
| `apps/console/src/__tests__/api/agencyMyAssignments.test.ts` | 6 |
| `apps/console/src/__tests__/api/agencySpine.test.ts` | 11 |
| `apps/console/src/__tests__/api/agencyStats.test.ts` | 38 |
| `apps/console/src/__tests__/api/call-analysis-profiles.api.test.ts` | 5 |
| `apps/console/src/__tests__/api/error-analytics.test.ts` | 5 |
| `apps/console/src/__tests__/api/exportCsv.test.ts` | 3 |
| `apps/console/src/__tests__/api/invites.test.ts` | 15 |
| `apps/console/src/__tests__/api/originator-header.test.ts` | 4 |
| `apps/console/src/__tests__/api/tenants.test.ts` | 6 |

### `apps/console/src/brand/`

Brand pack loading and types (decision B17).

Files: `index.ts`, `load-brand.ts`, `types.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/brand/index.test.ts` | 14 |
| `apps/console/src/brand/load-brand.test.ts` | 24 |

### `apps/console/src/components/`

UI components: `agency/` (station, state rail, wrap-up timer, campaign tabs, health strip and the rest of the agent and supervisor UI), `audio/`, `auth/` (route guards), `calls/` (call detail), `common/` (shared widgets, logo, page description), `layout/` (app and agency shells, sidebar).

Files: `agency/AgencyRetryDialog.module.css`, `agency/AgencyRetryDialog.tsx`, `agency/AgentAnalyticsSection.module.css`, `agency/AgentAnalyticsSection.tsx`, `agency/AgentAttemptsPanel.module.css`, `agency/AgentAttemptsPanel.tsx`, `agency/AgentBucketChart.module.css`, `agency/AgentBucketChart.tsx`, `agency/AgentFloor.module.css`, `agency/AgentFloor.tsx`, `agency/AgentFloorDrawer.module.css`, `agency/AgentFloorDrawer.tsx`, `agency/AgentLanding.module.css`, `agency/AgentLanding.tsx`, `agency/AgentNav.module.css`, `agency/AgentNav.tsx`, `agency/AgentPerformancePanel.module.css`, `agency/AgentPerformancePanel.tsx`, `agency/AgentSurfaceShell.module.css`, `agency/AgentSurfaceShell.tsx`, `agency/BestHours.tsx`, `agency/BestHoursMatrix.module.css`, `agency/BestHoursMatrix.tsx`, `agency/BreakMenu.module.css`, `agency/BreakMenu.tsx`, `agency/CampaignActivityChart.module.css`, `agency/CampaignActivityChart.tsx`, `agency/CampaignAgentAssignments.module.css`, `agency/CampaignAgentAssignments.tsx`, `agency/CampaignContribution.tsx`, `agency/CampaignHealthStrip.module.css`, `agency/CampaignHealthStrip.tsx`, `agency/CampaignLineageStrip.module.css`, `agency/CampaignLineageStrip.tsx`, `agency/CampaignPerformance.module.css`, `agency/CampaignPerformance.tsx`, `agency/CampaignRecordingField.module.css`, `agency/CampaignRecordingField.tsx`, `agency/CampaignRateChart.module.css`, `agency/CampaignRateChart.tsx`, `agency/CampaignSeriesSection.module.css`, `agency/CampaignSeriesSection.tsx`, `agency/CampaignTabs.module.css`, `agency/CampaignTabs.tsx`, `agency/CompareTray.tsx`, `agency/ContributionTable.tsx`, `agency/CueSettings.module.css`, `agency/CueSettings.tsx`, `agency/DialerUnavailable.module.css`, `agency/DialerUnavailable.tsx`, `agency/DispositionPad.module.css`, `agency/DispositionPad.tsx`, `agency/DncControl.module.css`, `agency/DncControl.tsx`, `agency/FilterChip.tsx`, `agency/FiltersCard.tsx`, `agency/HoldToConfirmButton.module.css`, `agency/HoldToConfirmButton.tsx`, `agency/MultiSelectFilter.tsx`, `agency/NotesField.module.css`, `agency/NotesField.tsx`, `agency/QueuedBreakPill.module.css`, `agency/QueuedBreakPill.tsx`, `agency/RailPresenceRegion.module.css`, `agency/RailPresenceRegion.tsx`, `agency/RosterTable.module.css`, `agency/RosterTable.tsx`, `agency/SpineListLayout.module.css`, `agency/StateRail.module.css`, `agency/StateRail.tsx`, `agency/StationIdentity.module.css`, `agency/StationIdentity.tsx`, `agency/StationMenu.module.css`, `agency/StationMenu.tsx`, `agency/WorkspaceExit.tsx`, `agency/WrapupTimer.module.css`, `agency/WrapupTimer.tsx`, `agency/useChartWidth.ts`, `audio/AudioWaveform.module.css`, `audio/AudioWaveform.tsx`, `auth/HomeRedirect.tsx`, `auth/RequireAuth.tsx`, `auth/RequireCapability.tsx`, `auth/RequireFlag.tsx`, `calls/CallDetailSections.tsx`, `calls/CallDetailView.tsx`, `common/AccountUnavailable.tsx`, `common/Breadcrumbs.module.css`, `common/Breadcrumbs.tsx`, `common/CapabilityUnavailable.tsx`, `common/ConfirmDialog.module.css`, `common/ConfirmDialog.tsx`, `common/CopyableField.module.css`, `common/CopyableField.tsx`, `common/DataTable.module.css`, `common/DataTable.tsx`, `common/DateRangeFilter.module.css`, `common/DateRangeFilter.tsx`, `common/EmptyState.module.css`, `common/EmptyState.tsx`, `common/ErrorAlert.module.css`, `common/ErrorAlert.tsx`, `common/ErrorText.module.css`, `common/ErrorText.tsx`, `common/FieldError.tsx`, `common/GlobalSearch.module.css`, `common/GlobalSearch.tsx`, `common/HelpTooltip.module.css`, `common/HelpTooltip.tsx`, `common/LiveDot.module.css`, `common/LiveDot.tsx`, `common/LoadingSpinner.module.css`, `common/LoadingSpinner.tsx`, `common/Logo.tsx`, `common/Modal.module.css`, `common/Modal.tsx`, `common/PageDescription.module.css`, `common/PageDescription.tsx`, `common/PageHeader.module.css`, `common/PageHeader.tsx`, `common/Pagination.module.css`, `common/Pagination.tsx`, `common/PhoneFilterInput.module.css`, `common/PhoneFilterInput.tsx`, `common/RequestId.module.css`, `common/RequestId.tsx`, `common/StatusBadge.module.css`, `common/StatusBadge.tsx`, `common/Toast.module.css`, `common/Toast.tsx`, `common/TruncatedId.module.css`, `common/TruncatedId.tsx`, `common/index.ts`, `layout/AccountSwitcher.module.css`, `layout/AccountSwitcher.tsx`, `layout/AgencyLayout.module.css`, `layout/AgencyLayout.tsx`, `layout/AgencySidebar.module.css`, `layout/AgencySidebar.tsx`, `layout/AppLayout.module.css`, `layout/AppLayout.tsx`, `layout/Sidebar.module.css`, `layout/Sidebar.tsx`, `layout/SwitcherDropdown.module.css`, `layout/SwitcherDropdown.tsx`, `layout/TenantSwitcher.module.css`, `layout/TenantSwitcher.tsx`, `layout/TopBar.module.css`, `layout/TopBar.tsx`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/components/AccountSwitcher.test.tsx` | 7 |
| `apps/console/src/__tests__/components/AgencyRetryDialog.test.tsx` | 31 |
| `apps/console/src/__tests__/components/AgencySidebar.test.tsx` | 11 |
| `apps/console/src/__tests__/components/AgencyWorkspaceSwitch.test.tsx` | 13 |
| `apps/console/src/__tests__/components/AgentAnalyticsSection.test.tsx` | 89 |
| `apps/console/src/__tests__/components/AgentBucketChart.test.tsx` | 15 |
| `apps/console/src/__tests__/components/AgentFloor.test.tsx` | 40 |
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
| `apps/console/src/__tests__/components/CampaignBehaviourSection.test.tsx` | 4 |
| `apps/console/src/__tests__/components/CampaignContribution.test.tsx` | 42 |
| `apps/console/src/__tests__/components/CampaignHealthStrip.test.tsx` | 14 |
| `apps/console/src/__tests__/components/CampaignPerformance.test.tsx` | 19 |
| `apps/console/src/__tests__/components/CampaignSeriesSection.test.tsx` | 25 |
| `apps/console/src/__tests__/components/CommonConfirmDialog.test.tsx` | 12 |
| `apps/console/src/__tests__/components/CompareTray.test.tsx` | 21 |
| `apps/console/src/__tests__/components/ComposerSection.test.tsx` | 6 |
| `apps/console/src/__tests__/components/ContributionTable.test.tsx` | 18 |
| `apps/console/src/__tests__/components/DataTable.test.tsx` | 27 |
| `apps/console/src/__tests__/components/DialerUnavailable.test.tsx` | 3 |
| `apps/console/src/__tests__/components/DispositionPad.test.tsx` | 28 |
| `apps/console/src/__tests__/components/DncControl.test.tsx` | 7 |
| `apps/console/src/__tests__/components/ErrorAlert.test.tsx` | 4 |
| `apps/console/src/__tests__/components/ErrorText.test.tsx` | 4 |
| `apps/console/src/__tests__/components/GlobalSearchDnc.test.tsx` | 4 |
| `apps/console/src/__tests__/components/GovernanceGating.test.tsx` | 6 |
| `apps/console/src/__tests__/components/HoldToConfirmButton.test.tsx` | 38 |
| `apps/console/src/__tests__/components/HomeRedirect.test.tsx` | 8 |
| `apps/console/src/__tests__/components/LiveDot.test.tsx` | 7 |
| `apps/console/src/__tests__/components/NotesField.test.tsx` | 22 |
| `apps/console/src/__tests__/components/PageDescription.test.tsx` | 3 |
| `apps/console/src/__tests__/components/Pagination.test.tsx` | 28 |
| `apps/console/src/__tests__/components/PhoneFilterInput.test.tsx` | 8 |
| `apps/console/src/__tests__/components/QueuedBreakPill.test.tsx` | 14 |
| `apps/console/src/__tests__/components/RailPresenceRegion.test.tsx` | 18 |
| `apps/console/src/__tests__/components/RequireAuth.returnPath.test.tsx` | 6 |
| `apps/console/src/__tests__/components/RequireCapability.settings.test.tsx` | 4 |
| `apps/console/src/__tests__/components/RequireFlag.test.tsx` | 11 |
| `apps/console/src/__tests__/components/RosterTable.test.tsx` | 49 |
| `apps/console/src/__tests__/components/Sidebar.activeState.test.tsx` | 2 |
| `apps/console/src/__tests__/components/StateRail.test.tsx` | 25 |
| `apps/console/src/__tests__/components/StationIdentity.test.tsx` | 2 |
| `apps/console/src/__tests__/components/StatusBadge.test.tsx` | 15 |
| `apps/console/src/__tests__/components/SwitcherDropdown.test.tsx` | 8 |
| `apps/console/src/__tests__/components/TenantSwitcher.test.tsx` | 7 |
| `apps/console/src/__tests__/components/Toast.test.tsx` | 2 |
| `apps/console/src/__tests__/components/TopBar.test.tsx` | 8 |
| `apps/console/src/__tests__/components/WrapupTimer.test.tsx` | 23 |
| `apps/console/src/__tests__/components/campaignSeriesCharts.test.tsx` | 16 |
| `apps/console/src/__tests__/components/dataTableAlignCss.test.ts` | 5 |
| `apps/console/src/__tests__/components/platformZoneExits.test.tsx` | 2 |
| `apps/console/src/__tests__/components/switcherDropdownScrollCss.test.ts` | 4 |
| `apps/console/src/components/common/DateRangeFilter.test.tsx` | 25 |
| `apps/console/src/components/common/DateRangeFilter.timezone.test.tsx` | 1 |
| `apps/console/src/components/common/Logo.test.tsx` | 3 |

### `apps/console/src/config/`

Console configuration helpers.

Files: `telephonyProviders.ts`

_No dedicated test files._

### `apps/console/src/contexts/`

React contexts: auth, tenant, theme and the rest.

Files: `AuthContext.tsx`, `FeatureFlagsContext.tsx`, `GovernanceContext.tsx`, `TenantContext.tsx`, `ThemeContext.tsx`, `ToastContext.tsx`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/contexts/AuthContext.lazyInit.test.tsx` | 2 |
| `apps/console/src/__tests__/contexts/AuthContext.test.tsx` | 45 |
| `apps/console/src/__tests__/contexts/FeatureFlagsContext.test.tsx` | 14 |
| `apps/console/src/__tests__/contexts/GovernanceContext.test.tsx` | 6 |
| `apps/console/src/__tests__/contexts/TenantContext.test.tsx` | 32 |

### `apps/console/src/hooks/`

React hooks for data loading and the station.

Files: `useAccounts.ts`, `useAgencyAudio.ts`, `useAgencyCues.ts`, `useAgencyStation.ts`, `useAgentAttempts.ts`, `useAgentPerformance.ts`, `useAgentRoster.ts`, `useAudioCapture.ts`, `useAudioPlayback.ts`, `useBestHours.ts`, `useCallAnalysisProfiles.ts`, `useCampaignContribution.ts`, `useCampaignSeries.ts`, `useDialogA11y.ts`, `useMediaQuery.ts`, `useModalFocus.ts`, `usePermission.ts`, `usePhoneNumbers.ts`, `usePostHogIdentify.ts`, `useRepaintTick.ts`, `useRosterIngest.ts`, `useServerClock.ts`, `useTeam.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/hooks/agencyStationWsUrl.test.ts` | 7 |
| `apps/console/src/__tests__/hooks/agentSurfacesStrictMode.test.tsx` | 9 |
| `apps/console/src/__tests__/hooks/useAgencyStation.media.test.ts` | 10 |
| `apps/console/src/__tests__/hooks/useAgencyStation.test.ts` | 75 |
| `apps/console/src/__tests__/hooks/useAudioCapture.test.ts` | 18 |
| `apps/console/src/__tests__/hooks/useCallAnalysisProfiles.test.tsx` | 9 |
| `apps/console/src/__tests__/hooks/useCampaignSeries.test.tsx` | 16 |
| `apps/console/src/__tests__/hooks/useMediaQuery.test.ts` | 3 |
| `apps/console/src/__tests__/hooks/useServerClock.test.ts` | 15 |

### `apps/console/src/pages/`

Pages: `agency/` (agent home and station, campaigns and their tabs, contacts, attempts, activity, analytics, performance, DNC, login and join), `auth/`, `calls/`, `campaigns/` (campaign composer), `settings/` (analysis profiles, notifications), `team/`.

Files: `AppHomeRedirect.tsx`, `agency/AgencyAnalyticsPage.module.css`, `agency/AgencyAnalyticsPage.tsx`, `agency/AgencyAttemptCallPage.module.css`, `agency/AgencyAttemptCallPage.tsx`, `agency/AgencyCampaignActivityPage.module.css`, `agency/AgencyCampaignActivityPage.tsx`, `agency/AgencyCampaignAttemptsPage.module.css`, `agency/AgencyCampaignAttemptsPage.tsx`, `agency/AgencyCampaignContactsPage.module.css`, `agency/AgencyCampaignContactsPage.tsx`, `agency/AgencyCampaignDetailPage.module.css`, `agency/AgencyCampaignDetailPage.tsx`, `agency/AgencyCampaignRosterPage.module.css`, `agency/AgencyCampaignRosterPage.tsx`, `agency/AgencyCampaignSettingsPage.module.css`, `agency/AgencyCampaignSettingsPage.tsx`, `agency/AgencyCampaignStatusBadge.tsx`, `agency/AgencyCampaignsPage.module.css`, `agency/AgencyCampaignsPage.tsx`, `agency/AgencyContactDetailPage.module.css`, `agency/AgencyContactDetailPage.tsx`, `agency/AgencyHomeRedirect.tsx`, `agency/AgencyJoinPage.module.css`, `agency/AgencyJoinPage.tsx`, `agency/AgencyLoginPage.module.css`, `agency/AgencyLoginPage.tsx`, `agency/AgentAttemptsPage.tsx`, `agency/AgentConsolePage.module.css`, `agency/AgentConsolePage.tsx`, `agency/AgentHomePage.module.css`, `agency/AgentHomePage.tsx`, `agency/AgentPerformancePage.module.css`, `agency/AgentPerformancePage.tsx`, `agency/CallerIdPicker.module.css`, `agency/CallerIdPicker.tsx`, `agency/DncPage.module.css`, `agency/DncPage.tsx`, `agency/useAgencyConsole.ts`, `auth/LoginPage.module.css`, `auth/VerifyEmailPage.tsx`, `calls/CallDetailPage.module.css`, `campaigns/agency/BuilderStepper.module.css`, `campaigns/agency/BuilderStepper.tsx`, `campaigns/agency/BuilderSummary.module.css`, `campaigns/agency/BuilderSummary.tsx`, `campaigns/agency/CampaignBehaviourSection.module.css`, `campaigns/agency/CampaignBehaviourSection.tsx`, `campaigns/agency/CampaignBuilderPage.module.css`, `campaigns/agency/CampaignBuilderPage.tsx`, `campaigns/agency/ColumnMapper.module.css`, `campaigns/agency/ColumnMapper.tsx`, `campaigns/agency/IngestSummary.module.css`, `campaigns/agency/IngestSummary.tsx`, `campaigns/agency/builderFlow.ts`, `campaigns/components/ComposerSection.module.css`, `campaigns/components/ComposerSection.tsx`, `settings/AnalysisProfilesPage.module.css`, `settings/AnalysisProfilesPage.tsx`, `settings/NotificationSettingsPage.module.css`, `settings/NotificationSettingsPage.tsx`, `settings/analysisProfileForm.ts`, `team/TeamPage.module.css`, `team/TeamPage.tsx`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/pages/AgencyAnalyticsPage.test.tsx` | 21 |
| `apps/console/src/__tests__/pages/AgencyAttemptCallPage.test.tsx` | 19 |
| `apps/console/src/__tests__/pages/AgencyCampaignActivityPage.test.tsx` | 43 |
| `apps/console/src/__tests__/pages/AgencyCampaignAttemptsPage.test.tsx` | 23 |
| `apps/console/src/__tests__/pages/AgencyCampaignContactsPage.test.tsx` | 6 |
| `apps/console/src/__tests__/pages/AgencyCampaignDetailPage.test.tsx` | 94 |
| `apps/console/src/__tests__/pages/AgencyCampaignRosterPage.test.tsx` | 22 |
| `apps/console/src/__tests__/pages/AgencyCampaignSettingsPage.test.tsx` | 36 |
| `apps/console/src/__tests__/pages/AgencyContactDetailPage.test.tsx` | 25 |
| `apps/console/src/__tests__/pages/AgencyHomeRedirect.test.tsx` | 7 |
| `apps/console/src/__tests__/pages/AgencyJoinPage.test.tsx` | 48 |
| `apps/console/src/__tests__/pages/AgencyLoginPage.test.tsx` | 38 |
| `apps/console/src/__tests__/pages/AgentAttemptsPage.test.tsx` | 46 |
| `apps/console/src/__tests__/pages/AgentConsolePage.audio.test.tsx` | 47 |
| `apps/console/src/__tests__/pages/AgentConsolePage.callbackDnc.test.tsx` | 31 |
| `apps/console/src/__tests__/pages/AgentConsolePage.cueVisual.test.tsx` | 22 |
| `apps/console/src/__tests__/pages/AgentConsolePage.retry.test.tsx` | 14 |
| `apps/console/src/__tests__/pages/AgentConsolePage.stationExit.test.tsx` | 43 |
| `apps/console/src/__tests__/pages/AgentConsolePage.test.tsx` | 42 |
| `apps/console/src/__tests__/pages/AgentHomePage.test.tsx` | 29 |
| `apps/console/src/__tests__/pages/AgentPerformancePage.test.tsx` | 51 |
| `apps/console/src/__tests__/pages/AnalysisProfilesPage.test.tsx` | 9 |
| `apps/console/src/__tests__/pages/AppHomeRedirect.test.tsx` | 6 |
| `apps/console/src/__tests__/pages/CampaignBuilderPage.config.test.tsx` | 39 |
| `apps/console/src/__tests__/pages/CampaignBuilderPage.flow.test.tsx` | 9 |
| `apps/console/src/__tests__/pages/CampaignBuilderPage.test.tsx` | 19 |
| `apps/console/src/__tests__/pages/DncPage.test.tsx` | 20 |
| `apps/console/src/__tests__/pages/NotificationSettingsPage.test.tsx` | 22 |
| `apps/console/src/__tests__/pages/RecordingSection.test.tsx` | 9 |
| `apps/console/src/__tests__/pages/TeamPage.a11y.test.tsx` | 1 |
| `apps/console/src/__tests__/pages/TeamPage.actionsMenu.test.tsx` | 8 |
| `apps/console/src/__tests__/pages/TeamPage.analytics.test.tsx` | 2 |
| `apps/console/src/__tests__/pages/TeamPage.inviteHandoff.test.tsx` | 28 |
| `apps/console/src/__tests__/pages/TeamPage.resendInvite.test.tsx` | 10 |
| `apps/console/src/__tests__/pages/TranscriptSection.test.tsx` | 7 |
| `apps/console/src/__tests__/pages/VerifyEmailPage.returnPath.test.tsx` | 6 |
| `apps/console/src/__tests__/pages/agencyRoutes.test.tsx` | 5 |
| `apps/console/src/__tests__/pages/dialerEntryRoutes.test.tsx` | 15 |
| `apps/console/src/__tests__/pages/useAgencyConsole.cues.test.ts` | 12 |
| `apps/console/src/__tests__/pages/useAgencyConsole.test.ts` | 10 |
| `apps/console/src/__tests__/pages/useAgencyConsole.wrapup.test.ts` | 16 |

### `apps/console/src/types/`

Type re-exports of `@magick-agency/contracts` for console modules.

Files: `agency-activity.ts`, `agency-campaign-series.ts`, `agency-campaign.ts`, `agency-spine.ts`, `agency-stats.ts`, `agency.ts`, `auth.ts`, `call-analysis-profile.ts`, `call.ts`, `dnc.ts`, `feature-flags.ts`, `invite.ts`, `notifications.ts`, `phone-number.ts`, `team.ts`, `webrtc-call.ts`

_No dedicated test files._

### `apps/console/src/utils/`

Pure UI helpers: permissions, vocabulary, formatting, wrap-up, disposition submit, cue preferences, transcript preferences, series ranges and more.

Files: `agencyActivityCopy.ts`, `agencyAgentFloor.ts`, `agencyAgentPerformance.ts`, `agencyAgentRoster.ts`, `agencyAgentSurfaces.ts`, `agencyAssignmentEntry.ts`, `agencyAttemptFilters.ts`, `agencyAudioCopy.ts`, `agencyBestHours.ts`, `agencyCampaignConfigForm.ts`, `agencyCampaignContribution.ts`, `agencyCampaignControls.ts`, `agencyCampaignLineage.ts`, `agencyCampaignOverview.ts`, `agencyCampaignPerformance.ts`, `agencyCampaignRecording.ts`, `agencyCampaignSeries.ts`, `agencyCampaignTabs.ts`, `agencyCatalogSync.ts`, `agencyClock.ts`, `agencyColumnMapping.ts`, `agencyCompareTray.ts`, `agencyContext.ts`, `agencyCuePrefs.ts`, `agencyCues.ts`, `agencyDispositionForm.ts`, `agencyDispositionSubmit.ts`, `agencyDncCopy.ts`, `agencyFieldFilter.ts`, `agencyHealthStrip.ts`, `agencyIngestSummary.ts`, `agencyJoinConflict.ts`, `agencyLiveSession.ts`, `agencyMedia.ts`, `agencyNotes.ts`, `agencyPersona.ts`, `agencyPriorAttempts.ts`, `agencyReleaseCopy.ts`, `agencyRetrySelector.ts`, `agencyRosterFilters.ts`, `agencySpineCopy.ts`, `agencyStaleResponse.ts`, `agencyStationExit.ts`, `agencyStationIdle.ts`, `agencyStatsConsumers.ts`, `agencyWebAudioCueSink.ts`, `agencyWrapup.ts`, `audio-worklet-processor.ts`, `concurrency.ts`, `errors.ts`, `format.ts`, `inviteJoin.ts`, `permissions.ts`, `phone.ts`, `poll-backoff.ts`, `returnPath.ts`, `session.ts`, `sessionRefusal.ts`, `snake-case.ts`, `switcherFocus.ts`, `switcherSearch.ts`, `transcript-prefs.ts`, `vocabulary.ts`

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/utils/agencyActionErrorCodes.test.ts` | 5 |
| `apps/console/src/__tests__/utils/agencyActivityCopy.test.ts` | 24 |
| `apps/console/src/__tests__/utils/agencyAgentFloor.test.ts` | 64 |
| `apps/console/src/__tests__/utils/agencyAgentPerformance.test.ts` | 70 |
| `apps/console/src/__tests__/utils/agencyAgentRoster.test.ts` | 81 |
| `apps/console/src/__tests__/utils/agencyAgentSurfaces.test.ts` | 7 |
| `apps/console/src/__tests__/utils/agencyAssignmentEntry.test.ts` | 19 |
| `apps/console/src/__tests__/utils/agencyAttemptFilters.test.ts` | 30 |
| `apps/console/src/__tests__/utils/agencyAttemptRange.timezone.test.ts` | 6 |
| `apps/console/src/__tests__/utils/agencyBestHours.test.ts` | 45 |
| `apps/console/src/__tests__/utils/agencyCampaignConfigForm.test.ts` | 69 |
| `apps/console/src/__tests__/utils/agencyCampaignContribution.test.ts` | 54 |
| `apps/console/src/__tests__/utils/agencyCampaignControls.test.ts` | 10 |
| `apps/console/src/__tests__/utils/agencyCampaignLineage.test.ts` | 11 |
| `apps/console/src/__tests__/utils/agencyCampaignOverview.test.ts` | 94 |
| `apps/console/src/__tests__/utils/agencyCampaignPerformance.test.ts` | 65 |
| `apps/console/src/__tests__/utils/agencyCampaignRecording.test.ts` | 35 |
| `apps/console/src/__tests__/utils/agencyCampaignSeries.test.ts` | 91 |
| `apps/console/src/__tests__/utils/agencyCampaignSeriesRange.timezone.test.ts` | 6 |
| `apps/console/src/__tests__/utils/agencyCampaignTabs.test.ts` | 17 |
| `apps/console/src/__tests__/utils/agencyCatalogSync.test.ts` | 30 |
| `apps/console/src/__tests__/utils/agencyClock.test.ts` | 20 |
| `apps/console/src/__tests__/utils/agencyColumnMapping.test.ts` | 28 |
| `apps/console/src/__tests__/utils/agencyCompareTray.test.ts` | 23 |
| `apps/console/src/__tests__/utils/agencyContext.test.ts` | 15 |
| `apps/console/src/__tests__/utils/agencyCuePrefs.test.ts` | 6 |
| `apps/console/src/__tests__/utils/agencyCues.test.ts` | 20 |
| `apps/console/src/__tests__/utils/agencyDispositionForm.test.ts` | 26 |
| `apps/console/src/__tests__/utils/agencyDispositionSubmit.test.ts` | 34 |
| `apps/console/src/__tests__/utils/agencyDncCopy.test.ts` | 20 |
| `apps/console/src/__tests__/utils/agencyFieldFilter.test.ts` | 12 |
| `apps/console/src/__tests__/utils/agencyHealthStrip.test.ts` | 46 |
| `apps/console/src/__tests__/utils/agencyIngestSummary.test.ts` | 27 |
| `apps/console/src/__tests__/utils/agencyJoinConflict.test.ts` | 24 |
| `apps/console/src/__tests__/utils/agencyLiveSession.test.ts` | 19 |
| `apps/console/src/__tests__/utils/agencyMedia.test.ts` | 18 |
| `apps/console/src/__tests__/utils/agencyNotes.test.ts` | 43 |
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
| `apps/console/src/__tests__/utils/agencyStatsConsumers.test.ts` | 37 |
| `apps/console/src/__tests__/utils/agencyWrapup.test.ts` | 33 |
| `apps/console/src/__tests__/utils/agentPermissions.test.ts` | 22 |
| `apps/console/src/__tests__/utils/audio-worklet-processor.test.ts` | 10 |
| `apps/console/src/__tests__/utils/build-splitting.test.ts` | 2 |
| `apps/console/src/__tests__/utils/builderFlow.test.ts` | 5 |
| `apps/console/src/__tests__/utils/concurrency.test.ts` | 9 |
| `apps/console/src/__tests__/utils/errors.test.ts` | 21 |
| `apps/console/src/__tests__/utils/format.test.ts` | 70 |
| `apps/console/src/__tests__/utils/inviteJoin.test.ts` | 8 |
| `apps/console/src/__tests__/utils/permissions.test.ts` | 41 |
| `apps/console/src/__tests__/utils/phone.test.ts` | 7 |
| `apps/console/src/__tests__/utils/poll-backoff.test.ts` | 13 |
| `apps/console/src/__tests__/utils/returnPath.test.ts` | 75 |
| `apps/console/src/__tests__/utils/sessionRefusal.test.ts` | 5 |
| `apps/console/src/__tests__/utils/switcherFocus.test.ts` | 4 |
| `apps/console/src/__tests__/utils/switcherSearch.test.ts` | 6 |
| `apps/console/src/__tests__/utils/telephonyProviders.test.ts` | 10 |
| `apps/console/src/__tests__/utils/vocabulary.analysis.test.ts` | 15 |
| `apps/console/src/__tests__/utils/vocabulary.test.ts` | 16 |

### Cross-cutting tests (`apps/console`)

Scenario, flow, guard and setup tests that span several modules.

| Test file | Cases |
|---|---|
| `apps/console/src/__tests__/AuthContext.session.test.tsx` | 8 |
| `apps/console/src/__tests__/agencyBucketDates.timezone.test.tsx` | 8 |
| `apps/console/src/__tests__/analysisProfileForm.test.ts` | 15 |
| `apps/console/src/__tests__/branding/noParentBrand.test.ts` | 5 |
| `apps/console/src/__tests__/client.test.ts` | 26 |
| `apps/console/src/__tests__/devProxyPrefixes.test.ts` | 1 |
| `apps/console/src/__tests__/registration/agency-login-registration.test.ts` | 13 |
| `apps/console/src/__tests__/registration/analysis-profiles-registration.test.tsx` | 3 |
| `apps/console/src/__tests__/session.test.ts` | 9 |
| `apps/console/src/__tests__/snake-case.test.ts` | 19 |
| `apps/console/src/__tests__/themeTokenParity.test.ts` | 4 |

## `apps/super-admin`

### `apps/super-admin/src/`

App shell: `App.tsx`, `main.tsx`, `config.ts`, `brand.ts`, global CSS.

Files: `App.tsx`, `brand.ts`, `config.ts`, `global.css`, `main.tsx`, `vite-env.d.ts`

_No dedicated test files._

### `apps/super-admin/src/api/`

`saFetch` and the super-admin API module (JWT in `sessionStorage`).

Files: `saRoutes.ts`, `super-admin.ts`

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/api/saFetch.test.ts` | 29 |
| `apps/super-admin/src/__tests__/api/saRoutes.test.ts` | 45 |

### `apps/super-admin/src/components/`

Auth guard, shared widgets, layout, and super-admin components (tenant feature flags, settings, members and the rest).

Files: `auth/RequireSuperAdmin.tsx`, `common/AdvancedSection.module.css`, `common/AdvancedSection.tsx`, `common/Breadcrumbs.module.css`, `common/Breadcrumbs.tsx`, `common/ConfirmDialog.module.css`, `common/ConfirmDialog.tsx`, `common/DataTable.module.css`, `common/DataTable.tsx`, `common/EmptyState.module.css`, `common/EmptyState.tsx`, `common/ErrorAlert.module.css`, `common/ErrorAlert.tsx`, `common/ErrorText.module.css`, `common/ErrorText.tsx`, `common/HelpTooltip.module.css`, `common/HelpTooltip.tsx`, `common/LiveDot.module.css`, `common/LiveDot.tsx`, `common/LoadingSpinner.module.css`, `common/LoadingSpinner.tsx`, `common/Logo.tsx`, `common/Modal.module.css`, `common/Modal.tsx`, `common/PageHeader.module.css`, `common/PageHeader.tsx`, `common/Pagination.module.css`, `common/Pagination.tsx`, `common/RequestId.module.css`, `common/RequestId.tsx`, `common/StatCard.module.css`, `common/StatCard.tsx`, `common/StatusBadge.module.css`, `common/StatusBadge.tsx`, `common/Toast.module.css`, `common/Toast.tsx`, `common/index.ts`, `layout/SuperAdminLayout.module.css`, `layout/SuperAdminLayout.tsx`, `layout/SuperAdminSidebar.module.css`, `layout/SuperAdminSidebar.tsx`, `super-admin/TenantFeatureFlags.module.css`, `super-admin/TenantFeatureFlags.tsx`, `super-admin/TenantPicker.module.css`, `super-admin/TenantPicker.tsx`, `super-admin/feature-flags/BooleanFlagCell.tsx`, `super-admin/feature-flags/BulkRolloutModal.tsx`, `super-admin/feature-flags/ConfirmDialog.tsx`, `super-admin/feature-flags/FlagDialog.tsx`, `super-admin/feature-flags/FlagPolicyWarning.tsx`, `super-admin/feature-flags/NumberFlagDialog.tsx`, `super-admin/feature-flags/NumericFlagCell.tsx`, `super-admin/feature-flags/OverrideReasonDialog.tsx`, `super-admin/feature-flags/TriStateControl.tsx`, `super-admin/feature-flags/featureFlags.module.css`, `super-admin/feature-flags/flagUtils.ts`

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/components/BulkRolloutModal.test.tsx` | 14 |
| `apps/super-admin/src/__tests__/components/ConfirmDialog.test.tsx` | 4 |
| `apps/super-admin/src/__tests__/components/FlagDialog.test.tsx` | 10 |
| `apps/super-admin/src/__tests__/components/OverrideReasonDialog.test.tsx` | 6 |
| `apps/super-admin/src/__tests__/components/TenantFeatureFlags.test.tsx` | 45 |
| `apps/super-admin/src/__tests__/components/TenantPicker.test.tsx` | 16 |
| `apps/super-admin/src/__tests__/components/TriStateControl.test.tsx` | 12 |
| `apps/super-admin/src/__tests__/components/flagUtils.test.ts` | 9 |

### `apps/super-admin/src/config/`

Super-admin configuration helpers.

Files: `telephonyProviders.ts`

_No dedicated test files._

### `apps/super-admin/src/contexts/`

Super-admin auth context and the rest.

Files: `SuperAdminContext.tsx`, `ToastContext.tsx`

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/contexts/SuperAdminContext.test.tsx` | 12 |

### `apps/super-admin/src/hooks/`

Data-loading hooks.

Files: `useCountUp.ts`, `useSuperAdminAdmins.ts`, `useSuperAdminAudit.ts`, `useSuperAdminTenant.ts`, `useSuperAdminTenants.ts`, `useSuperAdminUsageCounts.ts`, `useSuperAdminUsers.ts`

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/hooks/useSuperAdminTenant.test.ts` | 3 |
| `apps/super-admin/src/__tests__/hooks/useSuperAdminUsageCounts.test.ts` | 15 |

### `apps/super-admin/src/pages/`

Login, and the super-admin pages: tenants and tenant detail, users, admins, phone numbers, feature flags, usage, audit.

Files: `auth/SuperAdminLoginPage.module.css`, `auth/SuperAdminLoginPage.tsx`, `super-admin/SAAdminsPage.module.css`, `super-admin/SAAdminsPage.tsx`, `super-admin/SAAuditPage.module.css`, `super-admin/SAAuditPage.tsx`, `super-admin/SAFeatureFlagsPage.module.css`, `super-admin/SAFeatureFlagsPage.tsx`, `super-admin/SAPhoneNumbersPage.module.css`, `super-admin/SAPhoneNumbersPage.tsx`, `super-admin/SATenantDetailPage.module.css`, `super-admin/SATenantDetailPage.tsx`, `super-admin/SATenantsPage.module.css`, `super-admin/SATenantsPage.tsx`, `super-admin/SAUsagePage.module.css`, `super-admin/SAUsagePage.tsx`, `super-admin/SAUsersPage.module.css`, `super-admin/SAUsersPage.tsx`

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/pages/SAAuditPage.test.tsx` | 1 |
| `apps/super-admin/src/__tests__/pages/SAFeatureFlagsPage.test.tsx` | 34 |
| `apps/super-admin/src/__tests__/pages/SAPhoneNumbersPage.test.tsx` | 5 |
| `apps/super-admin/src/__tests__/pages/SATenantDetailPage.new.test.tsx` | 21 |
| `apps/super-admin/src/__tests__/pages/SATenantDetailPage.test.tsx` | 11 |
| `apps/super-admin/src/__tests__/pages/SAUsagePage.test.tsx` | 22 |
| `apps/super-admin/src/__tests__/pages/SAUsersPage.test.tsx` | 9 |

### `apps/super-admin/src/utils/`

Formatting and helpers.

Files: `errors.ts`, `format.ts`, `localDayBounds.ts`, `saStatus.ts`, `strictInteger.ts`, `tenant-search.ts`

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/utils/tenant-search.test.ts` | 13 |

### Cross-cutting tests (`apps/super-admin`)

Scenario, flow, guard and setup tests that span several modules.

| Test file | Cases |
|---|---|
| `apps/super-admin/src/__tests__/App.test.tsx` | 4 |
| `apps/super-admin/src/__tests__/branding/noParentBrand.test.ts` | 5 |
| `apps/super-admin/src/__tests__/saStatus.test.ts` | 21 |
