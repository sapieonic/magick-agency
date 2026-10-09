# Porting ledger

One row per ported file: source `path@sha` → destination, `verbatim | modified | deleted`, reason.
Sources: core `magic-voice-core@4850d1d9` (v1.123.2), master `magick-master@a1f0756a` (v3.24.0),
cusui `magick-comms-cusui@ee5beb44` (v2.96.0). Lanes append their rows under their section; the
lead merges package-level ledgers (`packages/*/PORTING.md`, `packages/db/BASELINE.md`) here.

## Phase 1 — scaffold

| Source | Destination | Kind | Reason |
|---|---|---|---|
| core `vitest.decorator-transform.ts@4850d1d9` | `tooling/vitest-decorator-transform.ts` | modified | Vite `Plugin` type replaced by a structural interface (no direct `vite` dependency at the root) |
| core `src/db/connection.ts@4850d1d9` | `packages/db/src/connection.ts` | modified | Takes pool options as an argument instead of importing app config | **Q1 (Manas, 2026-10-09): TLS now verifies by default — see "Open-question fixes" OQ-4.**
| core `src/utils/{logger,log-context,crypto,metric-instruments}.ts@4850d1d9` | `packages/observability/src/` | modified (logger: service name `magick-agency`) / verbatim | Shared by every lane |
| core `src/utils/version.ts@4850d1d9` | `packages/observability/src/version.ts` | modified | Version injected by the esbuild define; core's `__dirname` path is wrong in a bundle |
| core `src/utils/tracing.ts@4850d1d9` | `packages/observability/src/tracing.ts` | modified | Tracer name `magick-agency`; ported once for lanes C and D (both use `@Traced`). Core has no tests; 2 new inert-without-SDK tests |
| core `test/integration/setup/global-setup.ts@4850d1d9` (`waitForPostgres`) | `packages/db/test/helpers/global-setup.ts` | modified | Agency DB name/port guard; schema reset + node-pg-migrate runner |

## Phase 2 — contracts and baseline

(pending)

## Phase 2b — shared infrastructure

Sources: core `magic-voice-core@4850d1d9`, master `magick-master@a1f0756a`. Paths below are
relative to each repo. "Mocked-only" means the source tested the module only through a mocked
pool; those suites are ported AND covered by a new real-Postgres test.

### Source files

| Source | Destination | Kind | Reason |
|---|---|---|---|
| core `src/utils/sql-update.ts@4850d1d9` | `packages/db/src/utils/sql-update.ts` | verbatim | |
| core `src/utils/ttl-cache.ts@4850d1d9` | `packages/db/src/utils/ttl-cache.ts` | verbatim | |
| master `src/utils/concurrency.ts@a1f0756a` + core `src/utils/concurrency.ts@4850d1d9` (`runWithConcurrency`, appended) | `apps/server/src/utils/concurrency.ts` | verbatim (both, concatenated) | Landed early from lane A `5c3c6e2` (files only, lead-checked against both sources) because lane C's clip cache imports it and Vitest cannot mock an unresolvable path. Lane A owns the file; same path in both repos, master's owns it, no export collides |
| core `src/utils/single-flight.ts@4850d1d9` | `packages/db/src/utils/single-flight.ts` | verbatim | |
| core `src/db/pg-errors.ts@4850d1d9` | `packages/db/src/pg-errors.ts` | verbatim | Helper core's `agency.repository.ts` uses (lane B); no caller in 2b |
| core `src/db/models/webrtc-call.model.ts@4850d1d9` | `packages/db/src/models/agency-call.model.ts` | modified | Re-keyed onto `agency_calls`; type names kept (seams §3.1). Removed: `telephony_credential_id` (BYOC) and `sip_connection_id` (SIP) from `WebRtcCallRecord` and `CreateWebRtcCallInput`, as the baseline dropped the columns |
| core `src/db/models/call.model.ts@4850d1d9` (lines 200-232 only) | `packages/db/src/models/call.model.ts` | modified (subset) | Only `SentimentScore`, `TurnSentiment`, `CallAnalysisResult`, verbatim — the analysis result shape `agency_calls.call_analysis` and the analysis job reuse. The rest of `call.model.ts` is AI calls (not carried) |
| core `src/db/repositories/webrtc-call.repository.ts@4850d1d9` | `packages/db/src/repositories/agency-call.repository.ts` | modified | Every statement on `agency_calls`; INSERT and list projection drop `telephony_credential_id`/`sip_connection_id` (14 binds, was 16); default `provider` `'vobiz'` → `'voicelink'` (VoBiz deleted; matches the baseline default); `WebRtcCallScope` narrowed to `'agency'` (softphone deleted, plan §5; `scopeClause` body verbatim so omitted scope still fails closed); `analysisFlagFor` returns `agency_call_analysis` from `@magick-agency/contracts/flags` (this package cannot import the server registry; equality with the registry pinned by `apps/server/test/unit/feature-flags/registry-contracts.test.ts`); exported as `agencyCallRepository` + `webrtcCallRepository` alias. No settlement columns or methods existed at source (`failStaleActive` kept) |
| core `src/db/repositories/account-settings.repository.ts@4850d1d9` | `packages/db/src/repositories/account-settings.repository.ts` | modified | Removed `getDefaultAiPipeline` (AI) and `getAnalyzeDialerCalls` (Q3b); upsert no longer writes `default_ai_pipeline`/`analyze_dialer_calls` (5 binds, was 7). Added `getWebrtcMaxDurationSeconds(tenantId, accountId)` (plan §3.2 column), same cached dumb-read style. TtlCache and the `getMaxConcurrentCalls` cache bypass and comments verbatim (+ PORT NOTE) |
| core `src/db/models/account-settings.model.ts@4850d1d9` | `packages/db/src/models/account-settings.model.ts` | modified | Removed `default_ai_pipeline`, `analyze_dialer_calls` (record and upsert input); added `webrtc_max_duration_seconds: number \| null` to the record. Also holds the provider-concurrency types (as at source) |
| core `src/db/repositories/provider-concurrency.repository.ts@4850d1d9` | `packages/db/src/repositories/provider-concurrency.repository.ts` | verbatim | No separate model at source (types live in `account-settings.model.ts`) |
| core `src/db/repositories/feature-flag.repository.ts@4850d1d9` | `packages/db/src/repositories/feature-flag.repository.ts` | verbatim | |
| core `src/db/models/feature-flag.model.ts@4850d1d9` | `packages/db/src/models/feature-flag.model.ts` | verbatim | |
| core `src/db/repositories/audit.repository.ts@4850d1d9` | `packages/db/src/repositories/audit.repository.ts` | verbatim | Writes `audit_logs` (B7 "Dialer" half) |
| core `src/db/models/audit.model.ts@4850d1d9` | `packages/db/src/models/audit.model.ts` | verbatim | |
| master `src/db/repositories/agency-campaign-agent.repository.ts@a1f0756a` | `packages/db/src/repositories/agency-campaign-agent.repository.ts` | verbatim (+ header note) | Master has no model file; record/input types live in the repository |
| master `src/db/repositories/audit.repository.ts@a1f0756a` | `packages/db/src/repositories/platform/audit.repository.ts` | modified | Path collision with core's `audit.repository.ts` → `platform/` (the lead's `audit/platform/` convention; **lead to confirm**). `api_key_id` no longer inserted (baseline; decision #5): 10 binds per row, was 11. Exported as `auditRepository` (master's name) + `platformAuditRepository` |
| master `src/db/models/audit.model.ts@a1f0756a` | `packages/db/src/models/platform/audit.model.ts` | modified | Path collision (as above). `AuditActorFields` (minus `api_key`) is declared here because the repository needs it and cannot import the server; `audit-actor.ts` re-exports it. `CreateAuditLogInput<Action, Resource>` takes the catalog unions as type parameters (default `string`); the server binds them (`PlatformCreateAuditLogInput`). `AuditLogRecord.api_key_id` removed; `actor_type` is `'human' \| 'system' \| null` |
| core `src/utils/metrics.ts@4850d1d9` (`featureFlagEvaluationsTotal`, :2040-2044) | `packages/observability/src/metrics/shared.ts` | verbatim (declaration) | New non-lane metrics file for shared-infrastructure metrics; same name, kind, description, label keys |
| core `src/feature-flags/index.ts@4850d1d9` | `apps/server/src/feature-flags/index.ts` | modified | `ResolvedPrewarm` type export removed; `initFeatureFlagService`/`getFeatureFlagService` verbatim |
| core `src/feature-flags/registry.ts@4850d1d9` | `apps/server/src/feature-flags/registry.ts` | modified | Catalog = the three agency flags, each `defineFlag`'d FROM `AGENCY_FLAGS` (contracts) in core's order; `FlagScope`/`FlagType` re-exported from contracts; `FlagDefinition` = contracts' interface + `validate`. `defineFlag`, `getFlag`, `allFlags`, `clientExposedFlags`, `resolveEnvDefault` verbatim. Removed flags and validators listed below |
| core `src/feature-flags/feature-flag.service.ts@4850d1d9` | `apps/server/src/feature-flags/feature-flag.service.ts` | modified | Removed AI-only resolvers and their helpers (listed below). Kept verbatim: `getValue`, `isEnabled`, `snapshot`, `resolveAll`, `resolveClientExposed`, `resolveAllWithSource`, `invalidate`, Redis cache, degraded mode/probe, corrupt-cache guard, `readSnapshotPair` registry-default arm. Imports re-pointed to `@magick-agency/*` |
| core `src/audit/audit.types.ts@4850d1d9` | `apps/server/src/audit/audit.types.ts` | verbatim | |
| core `src/audit/audit-buffer.ts@4850d1d9` | `apps/server/src/audit/audit-buffer.ts` | modified (imports) | Repository/logger from `@magick-agency/db` / `@magick-agency/observability` |
| core `src/audit/audit-logger.ts@4850d1d9` | `apps/server/src/audit/audit-logger.ts` | modified (imports) | `maskPiiInObject` / `createChildLogger` from `@magick-agency/observability`; still exported as `auditLogger` |
| core `src/audit/audit-retention.ts@4850d1d9` | `apps/server/src/audit/audit-retention.ts` | modified (imports) | `getPool` from `@magick-agency/db`, `TtlCache` from `@magick-agency/db/utils/ttl-cache` |
| master `src/audit/audit-buffer.ts@a1f0756a` | `apps/server/src/audit/platform/audit-buffer.ts` | modified (imports) | Platform repository; input type from `./audit-logger.ts` |
| master `src/audit/audit-logger.ts@a1f0756a` | `apps/server/src/audit/platform/audit-logger.ts` | modified | Exported as `platformAuditLogger` (no `auditLogger` alias: that name is core's `audit_logs` writer here). Declares `PlatformCreateAuditLogInput` (the db input bound to this catalog) |
| master `src/audit/audit-actor.ts@a1f0756a` | `apps/server/src/audit/platform/audit-actor.ts` | modified | `api_key` branch removed (decision #5) from the union and both resolvers; `isPlatformApiKeyCaller` import gone; `AuditActorFields` re-exported from the db model with a two-way compile-time equality check against the catalog; `request.user` read through a structural cast (the `FastifyRequest` augmentation is lane A's session middleware). Exported signatures unchanged |
| master `src/audit/catalog.ts@a1f0756a` | `apps/server/src/audit/platform/catalog.ts` | modified | Trimmed (removed actions below). Master's catalog has no super-admin or notification-preference actions to keep |
| master `src/audit/vocabulary.ts@a1f0756a` | `apps/server/src/audit/platform/vocabulary.ts` | modified | Trimmed with the catalog; compile-time exhaustiveness checks unchanged |

### Removed functions, types, flags and actions

| Removed | From | Reason |
|---|---|---|
| `getDefaultAiPipeline` | account-settings repository | AI pipeline selection; column not carried |
| `getAnalyzeDialerCalls` | account-settings repository | Softphone gate 3 (decision Q3b); column not carried |
| `WebRtcCallScope` member `'dialer'`; `dialer_call_analysis` branch of `analysisFlagFor` | agency-call repository | Softphone deleted (plan §5) |
| `resolvePrewarm`, `resolveCallerActivity`, `ResolvedPrewarm`, `ResolvedCallerActivity` | feature-flag service | AI-only resolution paths (pre-warm, caller-activity gate) |
| `layerOf`, `exactBoolean`, `boundedNumber`, `RejectedValueContext`, `warnRejectedFlagValue`, `previewValue` | feature-flag service | Used only by the two removed resolvers |
| Flags: `whatsapp_personal`, `whatsapp_personal_groups`, `whatsapp_media`, `prewarm_enabled`, `prewarm_ring_delay_ms`, `webrtc_calls_enabled`, `byoc_telephony`, `custom_sip`, `max_sip_connections`, `knowledge_bases_enabled`, `max_knowledge_bases`, `max_catalog_rows`, `max_document_pages`, `max_kb_documents`, `gold_ii`, `dialer_call_analysis`, `dialer_analysis_max_duration_seconds`, `caller_activity_suppression`, `caller_activity_max_suppression_ms`, `caller_activity_cv_threshold`, `ai_call_intro_clip`, `ai_intro_clip_skip_opening_grace`, `gemini_live_vad_silence_duration_ms`, `gemini_live_manual_activity`, `ai_turn_transcript_logging`, `ai_call_transfer`, `max_escalation_destinations`, `ai_end_call_auto_attach`, `ai_closing_state`, `broadcast_concurrency` | registry | Messaging, AI, softphone, SIP, BYOC, KB, escalation and broadcast features are not in agency. (`dialer_analysis_max_duration_seconds` has no reader in core `src/`.) |
| Flag `webrtc_max_duration_seconds` and its validator `isWebrtcMaxDuration` (60..14400) | registry | Moved to `account_settings.webrtc_max_duration_seconds` (plan §3.2). The baseline CHECK is only `> 0`: the 60..14400 bound must be enforced by whichever route writes the column |
| Validators `isVadSilenceDurationMs`, `isRingDelay`, `isSipConnectionCap`, `isKnowledgeBaseCap`, `isCatalogRowCap`, `isDocumentPageCap`, `isKbDocumentCap`, `isDialerAnalysisMaxDuration`, `isEscalationDestinationCap`, `isSuppressionCapMs`, `isCvThreshold` | registry | Their flags are removed; the agency flags declare none |
| Actions `schedule.created`, `schedule.cancelled`, `schedule.executing`, `schedule.retry.scheduled`, `schedule.completed`, `schedule.failed`, `recurring_schedule.created`, `recurring_schedule.cancelled`, `recurring_schedule.paused`, `recurring_schedule.resumed`, `recurring_schedule.updated` | catalog + vocabulary | Master's scheduler (AI broadcasts, static calls, IVR, messaging) — not in agency |
| Resource types `schedule`, `recurring_schedule` | catalog + vocabulary | As above |
| Actor type `api_key` (+ its vocabulary entry) | catalog, vocabulary, actor union | Decision #5: no API keys; baseline dropped `api_key_id` |
| Group `'Scheduling'`; product `'ai'` (`AuditProduct`, `AUDIT_PRODUCTS`, product vocabulary) | vocabulary | No remaining action uses them; the module's own rule forbids an always-empty filter option |

### Tests (source cases → ported cases)

`it.each` rows counted individually. Unit suites in `packages/db` and `apps/server` run with mocked
pools as at source; ids in mocked suites are left as the source wrote them (nothing reaches Postgres).
Real-Postgres suites wrap every free-form tenant/account label in `uuidFor(label)` (a stable UUID per
label, `packages/db/test/integration/setup/factories.ts`) — plan-required, the columns are UUID.

| Source | Destination | Src → port | Kind | Deletions / changes |
|---|---|---|---|---|
| core `test/unit/utils/single-flight.test.ts` | `packages/db/test/unit/utils/` | 16 → 16 | verbatim | |
| core `test/unit/utils/sql-update.test.ts` | `packages/db/test/unit/utils/` | 8 → 8 | verbatim | |
| core `test/unit/utils/ttl-cache.test.ts` | `packages/db/test/unit/utils/` | 51 → 51 | verbatim | |
| core `test/unit/db/repositories/account-settings.repository.test.ts` | `packages/db/test/unit/db/repositories/` | 26 → 24 | modified | Deleted: "persists analyze_dialer_calls as the 7th param…", "getAnalyzeDialerCalls returns null when unset" (Q3b). The three `default_ai_pipeline` getter cases and the two write-through mentions now use `getWebrtcMaxDurationSeconds`; upsert params 5, not 7 |
| core `test/unit/db/repositories/feature-flag.repository.test.ts` | same | 12 → 12 | verbatim (paths) | Mocked-only → real-Postgres coverage in `shared-infra-coverage.test.ts` |
| core `test/unit/db/repositories/audit-find-filtered.test.ts` | same | 10 → 10 | verbatim (paths) | |
| core `test/unit/db/repositories/webrtc-call-repository-analysis.test.ts` | same | 8 → 8 | modified | Analysis binds at indexes 8..11 (was 10..13); scope `'agency'` |
| core `test/unit/db/repositories/webrtc-call-scope.test.ts` | same | 13 → 12 | modified | Deleted: "refuses agency rows with campaign_id IS NULL" (dialer predicate). Remaining dialer-scope cases assert the agency predicate on `agency_calls` |
| core `test/unit/db/dialer-analysis-models.test.ts` | `packages/db/test/unit/db/` | 3 → 1 | modified | Kept the call-model status case, read from the baseline. Job-status case moves with `dialer-analysis-job.model.ts` (lane D); settlement-status case deleted (plan §4) |
| master `test/unit/db/repositories/audit.repository.test.ts` | `packages/db/test/unit/db/repositories/platform/` | 32 → 30 | modified | Deleted: "writes the key id and NO user id for an api_key actor", "still records api_key when the key id is unavailable". "refuses a user id smuggled onto an api_key row" → onto a `system` row. 10 binds per row; `ACTIVITY_EXPORT_PAGE_SIZE` (master `agency-activity.ts:184`, lane B2) restated as 500. Mocked-only → real-Postgres coverage added |
| master `test/unit/agency/agency-campaign-agent.repository.test.ts` | `packages/db/test/unit/agency/` | 64 → 64 | verbatim (paths) | |
| core `test/integration/db/webrtc-call.repository.test.ts` | `packages/db/test/integration/db/` | 28 → 28 | modified | UUID ids; `agency_calls`; scope `'agency'` (factory rows carry `campaign_id`); provider default `'voicelink'` |
| core `test/integration/db/webrtc-call-analysis-projection.test.ts` | same | 2 → 2 | modified | UUID ids; scope `'agency'` |
| core `test/integration/agency/webrtc-call-scope-isolation.test.ts` | `packages/db/test/integration/agency/` | 15 → 11 | modified | Deleted the four "six by-id routes" (softphone) cases; the five list cases and the partition case now list the agency scope with campaign-less rows as the refused set |
| core `test/integration/repositories/account-settings.repository.test.ts` | `packages/db/test/integration/repositories/` | 27 → 23 | modified | Deleted the four `default_ai_pipeline` write-path cases; its three getter cases now cover `getWebrtcMaxDurationSeconds`; two mentions switched to `analyze_calls`; UUID ids |
| core `test/integration/repositories/provider-concurrency.repository.test.ts` | same | 3 → 3 | modified (ids) | |
| core `test/integration/repositories/audit.repository.test.ts` | same | 12 → 12 | modified (ids, read typing) | Reads typed as `Record<string, unknown>` (core does not type-check tests; agency's lint does) |
| core `test/integration/scenarios/account-settings-concurrency.test.ts` | `packages/db/test/integration/scenarios/` | 11 → 11 | modified (ids) | One inline-literal SQL check bound as parameters; unused Redis imports dropped |
| core `test/integration/scenarios/audit-logging.test.ts` | same | 14 → 14 | modified (ids, read typing) | Unused `insertCall`/`insertPrompt` imports dropped; `'analysis'` category cast (type-only) |
| master `test/integration/repositories/agency-campaign-agent.repository.test.ts` | `packages/db/test/integration/repositories/` | 38 → 38 | modified (DB URL) | Master's hard-coded 5434 URL → the agency harness `TEST_DB_URL` |
| master `test/integration/repositories/agency-campaign-agent.concurrency.test.ts` | same | 11 → 11 | modified (DB URL) | As above |
| (new) | `packages/db/test/integration/repositories/shared-infra-coverage.test.ts` | — → 8 | new | Real-Postgres run of every mocked-only method: feature-flag repository (all 7), platform audit repository (insertBatch, find incl. keyset/withTotal), `accountSettingsRepository.listByTenant`/`getWebrtcMaxDurationSeconds`, staffing `listAllForUser`/`closeAllForUser` |
| core `test/unit/feature-flags/feature-flag.service.test.ts` | `apps/server/test/unit/feature-flags/` | 89 → 46 | modified | Deleted 43: the "resolvePrewarm wrapper" describe (11 plain + 7 `it.each` rows), "rejected flag values are logged" (6), the "resolveCallerActivity wrapper" describe (5 plain + 12 `it.each` rows), and corrupt-cache "resolves the ringing hot path to vetted values", "cannot exempt a tenant from the fleet kill switch". Subject flag `whatsapp_personal` → registered `agency_dialer_enabled`; the no-account-scope case and the non-boolean case use unregistered copies of core definitions (`test/helpers/fixture-flags.ts`); reads that went through `resolvePrewarm(t)` go through `resolveAllWithSource({ tenantId: t })` (the call it made) |
| core `test/unit/feature-flags/flag-snapshot.test.ts` | same | 30 → 30 | modified | GATED flag `custom_sip` → `agency_dialer_enabled` (same shape); other flags are unregistered copies of core definitions |
| core `test/unit/feature-flags/registry.test.ts` | same | 18 → 13 | modified | Deleted: "prewarm flags are NOT client-exposed", the three `gold_ii` cases, the `prewarm_ring_delay_ms` validator case. Shape/declaration/defineFlag/resolveEnvDefault/clientExposed cases re-pointed at agency flags |
| (new) | `apps/server/test/unit/feature-flags/registry-contracts.test.ts` | — → 4 | new | Registry ⇄ `AGENCY_FLAGS` agree field for field; `analysisFlagFor('agency')` equals `FLAGS.agency_call_analysis` |
| core `test/unit/scenarios/feature-flag-rollout-scenarios.test.ts` | `apps/server/test/unit/scenarios/` | 3 → 3 | modified | Flag is an unregistered copy of `whatsapp_personal` |
| core `test/unit/audit/audit-retention.test.ts` | `apps/server/test/unit/audit/` | 8 → 8 | verbatim (mock paths) | |
| master `test/unit/audit/audit-actor.test.ts` | `apps/server/test/unit/audit/platform/` | 11 → 7 | modified | Deleted the four API-key cases; actor-type catalog is `['human', 'system']` |
| master `test/unit/audit/audit-actor-call-sites.test.ts` | same | 7 → 6 | modified | Guards `platformAuditLogger.log({`; **deleted for now** "finds the audited call sites at all" (master ≥ 29; none ported yet — lanes A/B must restore it with their count); SYSTEM_AUDIT_ACTOR allow-list is empty (master's two are AI scheduling) |
| master `test/unit/audit/catalog.test.ts` | same | 6 → 3 | modified | Scrape covers every `platformAuditLogger.log({` block under `src/` (master's nine fixed files are unported or AI). Deleted here: the three "D10 / MAG-157" source guards — they read `proxy-agency-campaigns.routes.ts`, `agency-campaign-config.ts`, `super-admin.routes.ts` and move with those files (lanes A/B) |
| master `test/unit/audit/vocabulary.test.ts` | same | 22 → 20 | modified | Deleted: "covers the scheduler actions the campaign trail excludes", "does not blur an API key into an automatic action". `GROUPS` without `'Scheduling'`; the scheduler half of the product spot-check and the two `CAMPAIGN_ACTIVITY_ACTIONS` assertions dropped (lane B2 restores those with `agency-activity-actions.ts`); two type-only casts |
| (new) | `apps/server/test/integration/feature-flags/feature-flag.service.test.ts` | — → 5 | new | Real service over Postgres 5436 + Redis 6383 db 1: precedence from stored rows, Redis keys, invalidate, all four multi-flag resolves, registry default on a failed read with the env var on, singleton |
| (new) | `apps/server/test/integration/audit/audit-loggers.test.ts` | — → 4 | new | Both loggers end to end into `audit_logs` (PII masked) and `platform_audit_log`; compile-time catalog/actor guarantees; retention horizon on the baseline partitions |
| master `test/unit/utils/concurrency.test.ts` | same | 14 → 14 | verbatim | From lane A `5c3c6e2` |
| core `test/unit/utils/concurrency.test.ts` | `apps/server/test/unit/utils/concurrency.core.test.ts` | 9 → 9 | verbatim | Renamed: master has a different suite at the same path |

### Source tests not ported here

| Source | Cases | Reason |
|---|---|---|
| core `test/unit/feature-flags/end-of-call-flags.test.ts` | 11 | AI flags (`ai_end_call_auto_attach`, `ai_closing_state`) |
| core `test/unit/feature-flags/intro-clip-flag.test.ts` | 9 | AI flag (`ai_call_intro_clip`) |
| core `test/unit/feature-flags/turn-taking-flags.test.ts` | 9 | AI flags |
| core `test/unit/feature-flags/webrtc-flags.test.ts` | 22 | `webrtc_calls_enabled` (softphone kill switch) and `webrtc_max_duration_seconds` (moved to account settings) |
| core `test/integration/flows/feature-flag-rollout.test.ts` | 4 | Drives the `/internal/feature-flags` and `/api/v1/feature-flags` routes — lane A ports it with the override routes |
| core `test/integration/gold-ii/flag-scopes.test.ts` | 7 | AI pipeline tier (`gold_ii`, `preflightPipelineTier`) |
| core `test/integration/repositories/paginated-order-total.test.ts` | 10 `it` + 1 `it.each` | AI call/usage/messaging/KB repositories; its one audit line (`findByTenant` both forms) is covered by the audit suites |
| master `test/unit/db/paginated-order-total.test.ts` | 13 `it` + 1 `it.each` | Static scan of all of master's `src/`; not a test of these modules |
| core/master route, bridge and service suites that `vi.mock` these modules | — | Owned by the lane porting the module under test |

## Lane A — platform

Sources: master `magick-master@a1f0756a` (v3.24.0) unless marked core (`magic-voice-core@4850d1d9`)
or cusui (`magick-comms-cusui@ee5beb44`). Paths are relative to each repo. "Planned" rows are the
inventory written before porting; the kind column is updated as each file lands.

### A.0 Placement decisions (approved by the lead)

- Master's `src/utils/concurrency.ts` collides with core's: one file at
  `apps/server/src/utils/concurrency.ts`, master's helpers plus core's `runWithConcurrency`
  appended (lane C's clip cache calls it). Its row is in Phase 2b above (landed early as
  `a9e79a2`); lane A owns the file.
- Master repositories/models that import SERVER modules would make `packages/db` → server cyclic,
  so (B12's logic) they keep master's src-relative path under `apps/server/src/db/`:
  `membership-invite.repository` (+ model; imports `auth/firebase-identity`, `auth/firebase`),
  `telephony-provider.repository` (imports `cache/redis-cache`), `notification.model` (imports
  `notifications/engine/period`) and the two repositories that import it
  (`notification-preference`, `notification-delivery`). Every other repository/model goes to
  `packages/db`.

### A.1 Source inventory (what the console and super-admin actually call)

Console callers found in cusui (`src/api/*`, `src/config.ts` ENDPOINTS, imported by
`contexts/{Auth,Tenant,FeatureFlags}Context.tsx`, `hooks/useTeam.ts`, `pages/team/TeamPage.tsx`,
`pages/agency/AgencyJoinPage.tsx`, `pages/settings/NotificationSettingsPage.tsx`):
`POST /auth/session`, `GET /auth/me`, `GET /accounts`, `GET /accounts/mine`,
`GET /tenants/:id/members`, `POST /users/invite`, `PUT /users/:id/role`,
`DELETE /users/:id/membership`, `GET /invites/:token`, `POST /invites/:token/claim`,
`POST /invites/resend`, `GET`/`PUT /notifications/preferences`, the client flag map
(`/proxy/feature-flags` → agency `GET /feature-flags`).

NOT ported because no console page in the agency scope needs them, or the contract has no
permission for them (`tenant.update`, `account.create|update|delete` are absent from
`@magick-agency/contracts/rbac`, decision Q3e): `GET /tenants`, `PUT /tenants/:id`
(TenantSettingsPage edits AI pipeline/provider settings), `POST|PUT|DELETE /accounts`
(AccountsPage). `GET /audit-log` (AuditLogPage) is an audit READ route and is not in lane A's
brief — reported, not ported.

| Source | Destination | Planned kind | Reason |
|---|---|---|---|
| `src/auth/firebase.ts` | `apps/server/src/auth/firebase.ts` | modified | Config from the platform block; adds `FIREBASE_SERVICE_ACCOUNT_PATH` (brief: JSON or path) |
| `src/auth/firebase-identity.ts` | `apps/server/src/auth/firebase-identity.ts` | verbatim | |
| `src/auth/session-email.ts` | `apps/server/src/auth/session-email.ts` | verbatim | |
| `src/auth/session-payload.ts` | `apps/server/src/auth/session-payload.ts` | modified | `governance` → `settings` map (plan §3.2, contract `SessionResponse.settings`) |
| `src/auth/session.middleware.ts` | `apps/server/src/auth/session.middleware.ts` | modified | Platform API-key branch deleted (decision #5) |
| `src/auth/super-admin.middleware.ts` | `apps/server/src/auth/super-admin.middleware.ts` | verbatim (imports) | |
| `src/auth/{api-key-caller,api-key-scopes,s2s-token}.ts` | — | deleted | No platform API keys (decision #5); no S2S peer |
| `src/cache/local-cache.ts`, `redis-cache.ts` | `apps/server/src/cache/` | verbatim (imports) | The membership/user cache the routes invalidate |
| `src/cache/metadata-cache.ts` | — | deleted | AI `/proxy/metadata` cache; its invalidation calls are removed with it |
| `src/services/tenant-name-resolver.ts` | `apps/server/src/services/tenant-name-resolver.ts` | modified | PostHog `identifyGroups` removed (no analytics module in agency) |
| `src/api/middleware/tenant-context.middleware.ts` | `apps/server/src/api/middleware/` | modified | API-key branch deleted |
| `src/rbac/rbac.middleware.ts` | `apps/server/src/rbac/rbac.middleware.ts` | modified | Matrix from `@magick-agency/contracts/rbac`; API-key scope narrowing deleted |
| `src/rbac/roles.ts` | — (`@magick-agency/contracts/rbac`) | not copied | The ONE matrix is the contract's |
| `src/utils/abort-error.ts` | `apps/server/src/utils/` | verbatim | (`concurrency.ts`: see Phase 2b) |
| `src/db/repositories/{user,tenant,account,membership,super-admin,super-admin-audit,phone-number,tenant-phone-assignment}.repository.ts` + models | `packages/db/src/{repositories,models}/` | verbatim (imports) | Path rule |
| `src/db/repositories/{membership-invite,telephony-provider,notification-preference,notification-delivery}.repository.ts`, `src/db/models/{membership-invite,notification}.model.ts` | `apps/server/src/db/{repositories,models}/` | verbatim (imports) | A.0 |
| `src/api/routes/auth.routes.ts` | `apps/server/src/api/routes/auth.routes.ts` | modified | Path 4 refuses 403 `no_membership` (plan §3.1); settings map |
| `src/api/routes/account.routes.ts` | same path | modified (subset) | `GET /`, `GET /mine` only |
| `src/api/routes/tenant.routes.ts` | same path | modified (subset) | `GET /:id/members` only |
| `src/api/routes/user.routes.ts` | same path | verbatim (imports) | Staffing close via shared `agencyCampaignAgentRepository.closeAllForUser` |
| `src/api/routes/invites.routes.ts` | same path | verbatim (imports) | |
| `src/api/routes/notification.routes.ts` | same path | modified | `POST /digests/preview` deleted (credits digest) |
| `src/api/routes/proxy-feature-flags.routes.ts` + core `src/api/routes/feature-flags.routes.ts` | `apps/server/src/api/routes/feature-flags.routes.ts` | modified (hop collapse) | Master's gate + core's body in-process; `GET /feature-flags` |
| `src/api/routes/super-admin.routes.ts` | same path | modified (subset) | Login, me, change-password, tenants list/create/detail, add user (+account, +invite), users, admins, audit, accounts + concurrency (core `PUT/GET /internal/account-concurrency` collapsed through `seams/concurrency-control.ts`). Credits, tenant service settings, pipeline backfill, tenant delete, retry-sync, entitlements/revisions deleted |
| `src/api/routes/super-admin-feature-flags.routes.ts` + core `internal.routes.ts` flag handlers | same path | modified (hop collapse) | Master's validation/audit + core's handler bodies on the shared flag service |
| `src/api/routes/super-admin-phone.routes.ts` | same path | modified (subset) | Phone inventory + assignments; telephony-provider CRUD and BYOC deleted |
| `src/api/routes/super-admin-usage.routes.ts` | — | deleted | Credits/fleet usage proxied from core; replaced by NEW usage counts |
| (new) | `apps/server/src/api/routes/super-admin-usage-counts.routes.ts` + repository | new | Plan §3.3 read-only usage counts |
| (new) | `super-admin` routes for role change / revoke / per-account settings | new | Contract shapes `ChangeMembershipRole*`, `RevokeMembership*`, `UpdateAgencyAccountSettingsBody` |
| `src/api/validators/{auth,user,invite,notification,super-admin,super-admin-feature-flags}.validator.ts` | `apps/server/src/api/validators/` | verbatim / subset | |
| `src/invites/{invite-issuer,membership-invite-state}.ts` | `apps/server/src/invites/` | verbatim (imports) | |
| `src/notifications/{invite-mailer,invite-token,mailjet.client,escape-html,agency-campaign-completion}.ts`, `templates/agent-invite.template.ts`, `engine/{audience,catalog,deliver,period}.ts` | `apps/server/src/notifications/...` | verbatim / modified | Catalog trimmed to agency events; completion trigger becomes an in-process call. `engine/campaign-gate.ts` is NOT ported: its only importers are the broadcast mailers `job-completion.ts` / `job-dispatched.ts` (deleted) |
| `src/notifications/{job-completion,job-dispatched,slack-webhook.client}.ts`, `digest/*`, `templates/usage-digest.template.ts` | — | deleted | Broadcast campaigns and the credits usage digest (plan §3.5) |
| (new) | `apps/server/src/agency/recording-analysis-assert.ts` | modified port | master `proxy-agency-campaigns.routes.ts:78-144` per-field assert over the settings row |
| (new) | `apps/server/scripts/create-super-admin.ts` | new | First super-admin, no seeded credentials (decision #6) |
| core `src/audit/audit-retention.ts` behaviour | `apps/server/src/bootstrap/platform.ts` partition job | new | Plan §3.5; baseline partitions end 2027-12 |

### A.2 Test plan (source cases, counted from the source files; `it.each` rows counted individually)

Ported suites, by area. Final per-file counts and deletions are recorded in A.3 when each lands.

| Area | Source suites (cases) |
|---|---|
| Identity | unit `auth/{firebase-identity 20, session-email 6, session.middleware 12, auth-session-email-verified 6, invite-claim-session-composition 11}`, `cache/{local-cache 15, local-cache-wiring 7, redis-cache 23, redis-cache-invalidation-order 4}`, `services/{tenant-name-resolver 16, tenant-record-cache.edge 7}`, `api/middleware/tenant-context.middleware 33`, `rbac/{rbac-middleware 19, roles 38, roles.agent 19}`, `api/routes/{account.routes 14, tenant.routes 11, record-cache-invalidation.wiring 11}`, `api/validators/{auth 7, user 12}`, `utils/concurrency 14`; integration `api/{auth.routes 16, account.routes 8, tenant.routes 23}`, `cache/{local-cache-invalidation 9, redis-cache.delbypattern 4, membership-invalidation 3, tenant-record-cache 10}` |
| Repositories | unit `db/repositories/{user 16, tenant 15, account 23, membership 33, membership-invite 38, super-admin 7, super-admin-audit 14, telephony-provider 19, notification-preference 27, notification-delivery 37}`; integration `repositories/{account 16, tenant 13, membership 33, phone-number 8, user-addressable-members 8+3, user-email-proof 32, membership-invite-claim-confinement 7, notification-preference 32, notification-delivery 42}` |
| Invites and team | unit `invites/{invite-issuer 13+each, membership-invite-state 6}`, `notifications/{invite-mailer 26+3 each, invite-token 14, agent-invite.template 24}`, `api/routes/{invites.routes 45+each, user.routes 43, user-offboarding-staffing 27, user-cache-invalidation.wiring 4, user-invite-mailer-isolation 6}`; integration `api/{user.routes 15, agency-offboarding-staffing 19}` |
| Notifications | unit `notifications/{mailjet.client 8, agency-campaign-completion 42, agency-campaign-unsubscribe 8}`, `notifications/engine/{audience 69+each, catalog 30, deliver 46, period 37}` (`campaign-gate 32+each` is NOT ported with its module, see A.5), `api/routes/notification.routes 19+2 each`, `validators/notification.validator 51` |
| Super-admin | unit `api/routes/{super-admin-accounts 26, super-admin-feature-flags 29+2 each, super-admin-phone 16, proxy-feature-flags.routes 5}`, `api/validators/super-admin.validator 37`; core unit `api/routes/feature-flags-internal 30`, `feature-flags-client 3`; integration `api/super-admin.routes 54+each`, core `flows/feature-flag-rollout 4` |
| Deleted with their module | master `api/routes/super-admin-usage 74+each`, integration `api/super-admin-usage 35` (credits usage, replaced); `auth/{api-key-caller, api-key-route-blocks, api-key-scopes, s2s-token}`; `notifications/{job-completion, job-dispatched, slack-webhook.client}`, `notifications/digest/*`, `templates/usage-digest.template`; `cache/metadata-cache*`; `api/routes/{super-admin-alerts, super-admin-bulk-dispatch-jobs, super-admin-credits, super-admin-dispatch-lanes, super-admin-sip, super-admin-telephony}` |
| New (exit gates) | route-table agent invariant (`onRoute`), per-field recording/analysis assert, super-admin → tenant → user → sign-in integration on real Postgres, usage counts on real Postgres, partition maintenance, `webrtc_max_duration_seconds` writer |

### A.3 Ported files and tests (filled in as each lands)

| Source | Destination | Kind | Tests src → port | Notes |
|---|---|---|---|---|
| master `src/utils/abort-error.ts` | `apps/server/src/utils/abort-error.ts` | verbatim | none at source | Used by `mailjet.client.ts` |
| master `src/api/routes/proxy-agency-campaigns.routes.ts:412-575` (`assertBehavioralCapabilitiesForConfig`, `assertCampaignBehavioralCapabilities`, `resolveInheritedBehavioralConfig`) | `apps/server/src/agency/campaign-behavioral-settings.ts` | modified | Own module so lane B2's campaign routes call one definition. Plan §3.2: `agency.recording` → `account_settings.allow_recording`, `agency.analytics` → `analyze_calls`; NULL/no row = off (governance default). Deleted: governance kill switch and the section `requireCapability('agency')` (no governance; the app is agency). **Interface changes vs master (lead's security review):** (1) the gate takes `target: { tenantId, accountId }`, the account that OWNS the campaign (master's governance was tenant-level, so the header could not diverge from the campaign); a missing id fails closed; (2) `assertCampaignBehavioralCapabilities(request, reply)` (raw `request.body`) is NOT ported — callers pass the schema-PARSED object they persist, or `resolveInheritedBehavioralConfig`'s output on retry. `resolveInheritedBehavioralConfig` verbatim. NEW pure `behavioralRefusalForConfig` |
| core `src/maintenance/retention-purge.ts:489-540@4850d1d9` + master `src/maintenance/retention-purge.ts:349-400@a1f0756a` (`purgeAuditPartitions`, both; the DROP half) | `apps/server/src/audit/audit-partition-maintenance.ts` | modified | One function parameterised by table + timestamp column (the two bodies differ only there); cutoff from `config.auditPartitions.retentionDays` (the Lambda's `RETENTION_DAYS`, default 85, floor 30 = `RETENTION_MIN_DAYS`). Lead decision: lane D's retention purge does NOT port `purgeAuditPartitions` or the `audit_partitions_dropped` / `audit_default_rows` report fields. NEW create half (`ensureFuturePartitions`, `<table>_YYYY_MM`, DEFAULT rows moved in before ATTACH) — no source had a runtime creator; it runs under `SET LOCAL TIME ZONE 'UTC'` with ISO-instant ATTACH bounds, so a non-UTC session zone cannot shift the bound away from the DEFAULT-row move. Create and drop are attempted independently per table (`errors` keyed `<table>.create` / `<table>.purge`), so a failing create never skips the drop |
| (new) | `apps/server/src/bootstrap/platform.ts` | new | Runs the partition job at boot + every `intervalMs` (no stacking); master's cache-invalidation subscriber (`index.ts:186-209`) when the local cache is enabled |
| core `test/unit/maintenance/retention-purge.test.ts@4850d1d9` — "drops only audit partitions entirely older than the cutoff and purges the default partition" (`:417`, MOVED here whole) + the partition assertions of "dry run counts rows without deleting or dropping anything" (`:430`, SPLIT); master `test/unit/maintenance/retention-purge.test.ts@a1f0756a` — the same two (`:255` moved, `:266` split). These are the cases lane D's "moved" rows point at | `apps/server/test/unit/audit/audit-partition-maintenance.test.ts` | modified | 2 per table × 2 tables = 4 (the "drops only…" cases are MOVED here whole: core 1 + master 1; the two dry-run cases are SPLIT: their table-count assertions stay with lane D's port, their partition assertions are here). Not ported: the Slack-summary partition line (no Slack summary for this job). NEW 3 (naming, month arithmetic, a failing create does not skip the drop half). 7 total |
| master `test/integration/maintenance/retention-purge.test.ts@a1f0756a` — "leaves the audit partitions alone when the cutoff predates all of them" (`:395`, MOVED) | `apps/server/test/integration/audit/audit-partition-maintenance.test.ts` | modified | 1 → 1 (now on both tables); NEW 2 on real Postgres: creates months past the baseline window and moves their DEFAULT rows in (idempotent second pass); drops wholly-aged partitions and old DEFAULT rows on both tables; NEW: UTC bounds under `Asia/Kolkata` (a DEFAULT row at 2028-01-31T20:00Z, which the old bare-date bound moved into a partition it then violated; fails on the old code). 4 total. `afterAll` drops the 2028 partitions the create cases add |
| (new) | `apps/server/test/unit/bootstrap/platform.test.ts` | new | 4: boot + interval with the configured window, no stacking, disabled, subscriber only with the local cache |
| master `test/unit/agency/proxy-agency-campaign-behavioral-capabilities.routes.test.ts` (14 `it` × 2 surfaces = 28) + `retry-inherited-config.test.ts` (6 `it` + 4 `it.each` = 10) | `apps/server/test/unit/agency/campaign-behavioral-settings.test.ts` | modified | 28 → 24 (deleted 2 × 2: "section preHandler still refuses on `agency`", "kill switch OFF"), 10 → 10 verbatim; NEW 18: no account context (×2), campaign account judged not header (×2), no row / NULL refuses (×2), on→off allowed without a settings read (×2), pure decision 10. Total 52 |
| master `src/auth/firebase.ts@a1f0756a` | `apps/server/src/auth/firebase.ts` | modified | none at source | `config.firebase` is optional, so a missing block logs a warning and leaves Firebase uninitialised. Every `verifyIdToken` then fails closed (401). NEW `serviceAccountPath` (`FIREBASE_SERVICE_ACCOUNT_PATH`): the same JSON, read from a file when `serviceAccountKey` is unset. `import { type AppConfig }` → `import type`. The rest is master's |
| master `src/auth/firebase-identity.ts@a1f0756a` | `apps/server/src/auth/firebase-identity.ts` | verbatim (imports) | `firebase-identity` 20 → 20 | |
| master `src/auth/session-email.ts@a1f0756a` | `apps/server/src/auth/session-email.ts` | verbatim (imports) | `session-email` 6 → 6 | |
| master `src/auth/session-payload.ts@a1f0756a` | `apps/server/src/auth/session-payload.ts` | modified | via `invite-claim-session-composition`, `auth.routes` | `governance: Record<string, boolean>` → `settings: AgencyAccountSettingsMap` (plan §3.2). `resolveGovernanceSafe(tenantId, accountId)` (governance for `memberships[0]` only) → `resolveSettingsSafe(memberships)`, which calls `buildAgencyAccountSettingsMap` over every account the active memberships reach (lead decision Q3a). Still fail-open (`{}` on throw), as at master. `governanceService` import removed |
| master `src/auth/session.middleware.ts@a1f0756a` | `apps/server/src/auth/session.middleware.ts` | modified | `session.middleware` 12 → 8 | Deleted (decision #5): the `X-Platform-Key` fallback (hash lookup → `platform_api_keys` → creator's user record) and the `apiKeyTenantId` / `apiKey` request fields. The 401 is master's, but its message no longer mentions a key header |
| master `src/auth/super-admin.middleware.ts@a1f0756a` | `apps/server/src/auth/super-admin.middleware.ts` | verbatim (imports) | none at source | |
| master `src/cache/local-cache.ts@a1f0756a` | `apps/server/src/cache/local-cache.ts` | verbatim (imports) | `local-cache` 15 → 15 | |
| master `src/cache/redis-cache.ts@a1f0756a` | `apps/server/src/cache/redis-cache.ts` | verbatim (imports) | `redis-cache` 23 → 23, `redis-cache-invalidation-order` 4 → 4 | | **Q5 (Manas, 2026-10-09): `delForRevocation` added — OQ-6.**
| master `src/services/tenant-name-resolver.ts@a1f0756a` | `apps/server/src/services/tenant-name-resolver.ts` | modified | `tenant-name-resolver` 16 → 14 | PostHog `identifyGroups` call and import removed: agency has no analytics module. Names still go onto the request and its log context |
| master `src/api/middleware/tenant-context.middleware.ts@a1f0756a` | `apps/server/src/api/middleware/tenant-context.middleware.ts` | modified | `tenant-context.middleware` 33 → 24 | Platform-API-key branch deleted (decision #5): key tenant must equal `X-Tenant-Id`, account-ownership check, creator's membership loaded for RBAC. The Firebase-user checks are master's |
| master `src/rbac/rbac.middleware.ts@a1f0756a` | `apps/server/src/rbac/rbac.middleware.ts` | modified | `rbac-middleware` 19 → 7 | Matrix from `@magick-agency/contracts/rbac`. Deleted (decision #5): the API-key scope gate (`resolveScopePermissions` / `scopesPermit`, 403 `api_key_not_permitted`), `API_KEY_FORBIDDEN_CODE`, the module logger. The role floor is the whole check |
| master `src/api/routes/auth.routes.ts@a1f0756a` | `apps/server/src/api/routes/auth.routes.ts` | modified | unit `auth-session-email-verified` 6 → 6, `invite-claim-session-composition` 11 → 11, `user-cache-invalidation.wiring` 4 → 4; integration `auth.routes` 16 → 19 | Path 4 REFUSES 403 `no_membership` and writes nothing (plan §3.1). It no longer creates a user, tenant, Default account, `tenant_owner` membership, signup credits, core API key or pooled phone (master `:218-358`). NEW `no_membership` code (contract `SessionRefusalCode`). Deleted: `SIGNUP_BONUS_MILLICREDITS`, `generateSlug`, the provisioning-only imports (account / credit-balance / credit-transaction / tenant-core-credential / phone-number / tenant-phone-assignment repositories, `createCoreApiKey`, `encryptAes256Gcm`, `config`, `signupPhoneAssignmentsTotal`), and `denyPlatformApiKey` on `GET /me` (decision #5). `GET /me` answers the per-account `settings` map over every reached account, where master gave `governance` for `memberships[0]` |
| master `src/api/routes/account.routes.ts@a1f0756a` | `apps/server/src/api/routes/account.routes.ts` | modified (subset) | unit `account.routes` 14 → 10; integration `account.routes` 8 → 3 | Kept: `GET /`, `GET /mine` (now with no `denyPlatformApiKey` preHandler). Deleted: `POST /` (`account.create`), `PUT /:id`, `DELETE /:id` (not in the contract, decision Q3e), `accountScopeMismatch` / `ACCOUNT_SCOPE_MISMATCH_REPLY` (guarded only PUT/DELETE), and the imports `invalidateAccountRecordCache`, `invalidateMetadataCache`, `account.validator`, core account-settings sync, `denyPlatformApiKey` |
| master `src/api/routes/tenant.routes.ts@a1f0756a` | `apps/server/src/api/routes/tenant.routes.ts` | modified (subset) | unit `tenant.routes` 11 → 9; integration `tenant.routes` 23 → 17 | Kept: `GET /:id/members`. Deleted: `GET /` (no console caller; the session already carries `tenants`), `PUT /:id` (`tenant.update`, not in the contract, Q3e), and the imports `tenantRepository`, `invalidateTenantRecordCache`, `invalidateMetadataCache`, `tenant.validator`, core account-settings sync, `denyPlatformApiKey` |
| master `src/api/routes/user.routes.ts@a1f0756a` | `apps/server/src/api/routes/user.routes.ts` | modified | unit `user.routes` 46 → 46, `user-offboarding-staffing` 27 → 27, `user-invite-mailer-isolation` 6 → 6, `user-cache-invalidation.wiring` 4 → 4; integration `user.routes` 15 → 15, `agency-offboarding-staffing` 19 → 17 | Plugin-wide `denyPlatformApiKey` preHandler removed (decision #5). `auditLogger` → `platformAuditLogger` (B7). HARDENING at the four caller-role checks: invite `canManageRole`; role change `canManageExistingRole` and `canManageRole`; revoke `canManageExistingRole`. `request.membership && !…` → `!request.membership \|\| !…`, so no membership now fails closed. Master relied on `requirePermission` running first. Covered by NEW `membership-fail-closed` |
| master `src/api/routes/invites.routes.ts@a1f0756a` | `apps/server/src/api/routes/invites.routes.ts` | modified | unit `invites.routes` 48 → 48; integration `invite-security-audit` NEW | `denyPlatformApiKey('administer users or memberships')` removed from `POST /resend` (decision #5). `auditLogger` → `platformAuditLogger` (B7). The `POST /resend` caller-role check gets the same fail-closed hardening (`!request.membership \|\| !canManageRole(…)`) |
| master `src/api/routes/notification.routes.ts@a1f0756a` | `apps/server/src/api/routes/notification.routes.ts` | modified | unit `notification.routes` 25 → 14; integration `notification.routes` NEW 6 | Deleted: `POST /notifications/digests/preview` (master `:253-420`, credits usage digest, plan §3.3/§3.5, now a 404) and the `denyPlatformApiKey` third hook (decision #5). Imports that served only those are gone: `config`, `accountRepository`, `tenantRepository`, `findNotificationEvent`, `formatPeriodLabel`, `resolvePeriodWindow`, `DigestFrequency`, `buildUsageDigest`, `renderUsageDigestEmail`, `previewDigestSchema`. `GET` / `PUT /preferences` are master's, with no permission floor |
| master `src/api/routes/proxy-feature-flags.routes.ts@a1f0756a` + core `src/api/routes/feature-flags.routes.ts@4850d1d9` | `apps/server/src/api/routes/feature-flags.routes.ts` | modified (hop collapse) | unit `proxy-feature-flags.routes` 5 → 4, `feature-flags-client` 3 → 3 | Master's gate (`sessionMiddleware` → `tenantContextMiddleware` → `requirePermission`) runs in-process over core's body (`getFeatureFlagService().resolveClientExposed`). No proxy, core API key or `x-mgkvc-*` headers. Permission `proxy.feature_flags.read` → contract `agency.flags.read` (same `agent` floor). Prefix `/feature-flags` (master `/proxy/feature-flags`). Core's 400 for a request with no account header is kept, now naming `X-Account-Id` |
| master `src/api/routes/super-admin.routes.ts@a1f0756a` + core `src/api/routes/internal.routes.ts@4850d1d9` (`GET/PUT /internal/account-concurrency`, `:325-364` utilization, `:366-450` PUT) | `apps/server/src/api/routes/super-admin.routes.ts` | modified (subset + hop collapse + new) | rows written separately (`super-admin-accounts`, `super-admin-memberships`, integration `super-admin.routes`) | Kept: login (5/min), `/me`, `/change-password`, tenants list/create/detail, add user, users, admins (create, list, delete, reactivate, reset password), audit, accounts + concurrency. Deleted: credits routes (`/credits`, `/credits/deduct`, `/credits/reconcile`, `GET …/credits/transactions`, `serializeCacheInspection`, `creditService` option); `PUT /tenants/:id/settings`; `POST /maintenance/backfill-core-default-pipelines`; `DELETE /tenants/:id`; core sync (`coreInternalRequest`, entitlement revisions, `POST …/concurrency/retry-sync`, `allocationMatchesIntent`, drift gauge and timer); telephony-catalog checks on a provider breakdown; `invalidateConcurrencyAllocation`. Tenant list/detail drop credit columns and `credit_cache`. Tenant create drops the credit row, core key and pooled number (`core_key_provisioned` / `phone_auto_assigned` off the response and audit row). Accounts + concurrency read and write in-process through `providerConcurrencyRepository` and `seams/concurrency-control.ts`, in core's invalidation order; `callManager.triggerDequeue()` is not carried. NEW: `account_id` on add-user (account-keyed leftover rules); add-user issues an invite through `issueInvite`; `PUT …/memberships/:membershipId/role`; `DELETE …/memberships/:membershipId`; tenant-wide staffing close (`isDemotionFromAgent` verbatim from master `user.routes.ts`) |
| master `src/api/routes/super-admin-feature-flags.routes.ts@a1f0756a` + core `src/api/routes/internal.routes.ts:655-900@4850d1d9` | `apps/server/src/api/routes/super-admin-feature-flags.routes.ts` | modified (hop collapse) | rows written separately (`super-admin-feature-flags`, `feature-flags-internal`) | Master's validation, tenant check and super-admin audit, with core's handler bodies in-process on `featureFlagRepository` and the flag service. Deleted: `coreInternalRequest` and every 502 branch; `REVIEWED_FLAG_ERROR_LABELS` / `markReviewedFlagError` / `preserveReviewedUpstreamError` (no error mask); `toForwardQuery`; flag-policies (no agency flag has one); `afterOverrideWrite` (broadcast cap); core's `trackFeatureFlagChanged` (PostHog). Core's `audit_logs` row is written for ACCOUNT scope only: the UUID columns refuse `'global'` / `'bulk'` / `'default'`. `old_value` and bulk applied/failed move onto the super-admin audit row. Core's prior-override read (`:668-677`) is verbatim |
| master `src/api/routes/super-admin-phone.routes.ts@a1f0756a` | `apps/server/src/api/routes/super-admin-phone.routes.ts` | modified (subset) | row written separately (`super-admin-phone`) | Kept: phone inventory and assignments. Deleted: telephony-provider CRUD (`POST\|GET /telephony-providers`, `PUT /telephony-providers/:id`, `describeLiveTransferStatusEffect`); `pool_eligible` on the wire (NEW helper strips it from rows); `invalidatePhoneCacheForNumber` / `invalidatePhoneCacheForTenant` / `invalidateAllMetadataCache`; the unassign cascade through `inboundConfigService.removeAllForTenantPhone` and the lookup that fed it |
| (new) | `apps/server/src/api/routes/super-admin-account-settings.routes.ts` | new | row written separately (`super-admin-account-settings`) | GET/PUT `/super-admin/tenants/:tenantId/accounts/:accountId/settings`. The PUT ports the body of core's tenant-facing `PUT /api/v1/account-settings` (`account-settings.routes.ts@4850d1d9`): `allow_recording` / `analyze_calls`, then the account-guard invalidation. MODIFIED: the toggles go through the toggles-only `setRecordingAnalysisToggles`, not core's read-concurrency-then-`upsert` (see A.4). Core's 403 for a differing `max_concurrent_calls` becomes a 400 from `.strict()`. Not carried: `default_ai_pipeline`, `triggerDequeue()`. Also writes `webrtc_max_duration_seconds` (core flag → column) through `setWebrtcMaxDurationSeconds` |
| (new; replaces master `src/api/routes/super-admin-usage.routes.ts`) | `apps/server/src/api/routes/super-admin-usage-counts.routes.ts` | new | row written separately (`super-admin-usage-counts`) | `GET /super-admin/usage`, plan §3.3. Read-only dials / answered / connected / talk seconds / analysis audio seconds over `[from, to)` on the attempt's `dialed_at`, via `usageCountsRepository`. No audit row |
| master `src/api/validators/auth.validator.ts@a1f0756a` | `apps/server/src/api/validators/auth.validator.ts` | verbatim (imports) | `auth.validator` 7 → 7 | |
| master `src/api/validators/invite.validator.ts@a1f0756a` | `apps/server/src/api/validators/invite.validator.ts` | verbatim (imports) | none of its own (via `invites.routes`) | |
| master `src/api/validators/user.validator.ts@a1f0756a` | `apps/server/src/api/validators/user.validator.ts` | verbatim (imports) | `user.validator` 12 → 12 | |
| master `src/api/validators/notification.validator.ts@a1f0756a` | `apps/server/src/api/validators/notification.validator.ts` | modified | `notification.validator` 51 → 24 | Deleted: `previewDigestSchema` and `runDigestsSchema` (master `:110-131`, credits usage digest). `DIGEST_FREQUENCIES` is kept |
| master `src/api/validators/phone-number.validator.ts@a1f0756a` | `apps/server/src/api/validators/phone-number.validator.ts` | modified | row written separately (`phone-number.validator`) | Deleted: `createTelephonyProviderSchema`, `updateTelephonyProviderSchema` (incl. `live_transfer_enabled`), `tagPhoneNumberSchema`. `pool_eligible` removed from the create and update schemas (unknown key stripped, not refused) |
| master `src/api/validators/super-admin-feature-flags.validator.ts@a1f0756a` + core `src/api/validators/feature-flags.validator.ts@4850d1d9` (`validateFlagValue`) | `apps/server/src/api/validators/super-admin-feature-flags.validator.ts` | modified (hop collapse) | row written separately (`super-admin-feature-flags`) | Core's `validateFlagValue` is copied verbatim here (its only consumer). Core's body schemas are not carried: they differed only by the S2S `updated_by`, which is now the authenticated super admin. `tenant_id` / `account_id` are `.uuid()` (baseline UUID columns; avoids a `22P02` 500) |
| master `src/api/validators/super-admin.validator.ts@a1f0756a` | `apps/server/src/api/validators/super-admin.validator.ts` | modified | row written separately (`super-admin.validator`) | Deleted: `topupCreditsSchema`, `deductCreditsSchema`. Role list hoisted to a const. NEW: `account_id` (uuid) on add-user; role-change schema (all six roles, `reason` ≤ 500); per-account settings PATCH schema (`.strict()`, `webrtc_max_duration_seconds` 60..14400, at least one field); usage-counts query schema (`[from, to)`, at most `USAGE_COUNTS_MAX_WINDOW_DAYS` = 400 days, uuid ids) |
| master `src/db/models/membership-invite.model.ts@a1f0756a` | `apps/server/src/db/models/membership-invite.model.ts` | verbatim (imports) | via `membership-invite.repository` | A.0: imports server modules, so it stays under `apps/server` |
| master `src/db/models/notification.model.ts@a1f0756a` | `apps/server/src/db/models/notification.model.ts` | verbatim (imports) | via the two repositories below | A.0 (imports `notifications/engine/period`) |
| master `src/db/repositories/membership-invite.repository.ts@a1f0756a` | `apps/server/src/db/repositories/membership-invite.repository.ts` | verbatim (imports) | unit 38 → 38; integration `membership-invite-claim-confinement` 7 → 7, `user-email-proof` 32 → 31 | A.0 |
| master `src/db/repositories/notification-delivery.repository.ts@a1f0756a` | `apps/server/src/db/repositories/notification-delivery.repository.ts` | verbatim (imports) | unit 45 → 45; integration 42 → 42 | A.0 |
| master `src/db/repositories/notification-preference.repository.ts@a1f0756a` | `apps/server/src/db/repositories/notification-preference.repository.ts` | verbatim (imports) | unit 27 → 27; integration 32 → 32 | A.0 |
| master `src/db/repositories/telephony-provider.repository.ts@a1f0756a` | `apps/server/src/db/repositories/telephony-provider.repository.ts` | modified (reads only) | row written separately (`telephony-provider.repository`) | A.0 (imports `cache/redis-cache`). Deleted: `create`, `update` (+ `TelephonyProviderPreviousValues`, `TelephonyProviderUpdateResult`, `pickPrevious`), `invalidateCache`, `findLiveTransferEnabledNames` (live transfer is AI escalation; migration 074's column is not in the baseline). Read-through cache keys and TTL are master's |
| master `src/invites/invite-issuer.ts@a1f0756a` | `apps/server/src/invites/invite-issuer.ts` | verbatim (imports) | `invite-issuer` 16 → 16 | |
| master `src/invites/membership-invite-state.ts@a1f0756a` | `apps/server/src/invites/membership-invite-state.ts` | verbatim (imports) | `membership-invite-state` 6 → 6 | |
| master `src/notifications/agency-campaign-completion.ts@a1f0756a` | `apps/server/src/notifications/agency-campaign-completion.ts` | modified | `agency-campaign-completion` 42 → 42, `agency-campaign-unsubscribe` 8 → 8 | `AGENCY_UUID_RE` is copied verbatim from master `src/agency/agency-billing-contract.ts:91-92` (that module is not ported). `config.cusuiBaseUrl` → `config.consoleBaseUrl`. Trigger: master's `POST /webhooks/core/agency-campaign-completed` (never emitted by core) is not ported. The campaign runtime will call `sendAgencyCampaignCompletionEmail` in-process (Phase 6 wires it and the outcome counter). The exported function, input and result union are unchanged. **`sendAgencyCampaignCompletionEmail` has NO caller in agency until Phase 6** (the campaign runtime's `running → completed` / `stopping → stopped` transition wires it); its suites drive it directly |
| master `src/notifications/engine/audience.ts@a1f0756a` | `apps/server/src/notifications/engine/audience.ts` | modified | `audience` 71 → 34 | Deleted: `collapseByInbox`, `resolveRoleFloorAudience` (master `:139-289`; their only caller was the credits digest runner), and the `notificationPreferenceRepository` import. `resolveEffectivePreferences`, `defaultPreferenceFor`, `isEventAddressableToRole`, `applyExplicitAudiencePreferences` are kept. `applyExplicitAudiencePreferences`'s caller is `agency-campaign-completion.ts`'s `suppressUnsubscribed`, through a dynamic import (`:340`, master `:311`) |
| master `src/notifications/engine/catalog.ts@a1f0756a` | `apps/server/src/notifications/engine/catalog.ts` | modified | `catalog` 30 → 28 | Only `agency.campaign.completed` is kept. Deleted: `campaign.dispatched`, `campaign.completed` (master `:108-129`, broadcast campaigns) and `usage.digest` (master `:143-183`, credits digest). Cadence and category types unchanged |
| master `src/notifications/engine/deliver.ts@a1f0756a` | `apps/server/src/notifications/engine/deliver.ts` | modified (trimmed) | `deliver` 50 → 6 | Only `buildDedupeKey` is kept. Deleted (master `:1-59`, `:78-262`): `dispatchNotification`, `NotificationDispatchInput` / `NotificationDispatchResult` / `EMPTY_RESULT`, `sendSemaphore` + `SEND_CONCURRENCY`, `outcomeStatus`, `outcomeDetail`, `countSends`, `scopeToken`, and their imports |
| master `src/notifications/engine/period.ts@a1f0756a` | `apps/server/src/notifications/engine/period.ts` | modified (trimmed) | `period` 37 → 4 | Only the cadence vocabulary (`isDigestFrequency` and types) is kept. Deleted (master `:42-173`): `PeriodWindow`, `resolvePeriodWindow`, `previousWindow`, `toIsoDate`, `formatPeriodLabel`, `startOfUtcDay`, `startOfUtcWeek`, `DAY_MS`, `MONTHS`, `formatUtcDate` |
| master `src/notifications/escape-html.ts@a1f0756a` | `apps/server/src/notifications/escape-html.ts` | verbatim (imports) | none at source | |
| master `src/notifications/invite-mailer.ts@a1f0756a` | `apps/server/src/notifications/invite-mailer.ts` | modified | `invite-mailer` 38 → 38 | `cusuiBaseUrl` → `consoleBaseUrl`. The skipped-mail warning names `CONSOLE_BASE_URL` (master `CUSUI_BASE_URL`) |
| master `src/notifications/invite-token.ts@a1f0756a` | `apps/server/src/notifications/invite-token.ts` | verbatim (imports) | `invite-token` 14 → 14 | |
| master `src/notifications/mailjet.client.ts@a1f0756a` | `apps/server/src/notifications/mailjet.client.ts` | verbatim (imports) | `mailjet.client` 8 → 8 | |
| master `src/notifications/templates/agent-invite.template.ts@a1f0756a` | `apps/server/src/notifications/templates/agent-invite.template.ts` | verbatim (imports) | `agent-invite.template` 24 → 24 | |
| (new) | `apps/server/src/settings/agency-account-settings.ts` | new | unit NEW 13; integration NEW 1 | The per-account EFFECTIVE settings map that replaces master's governance resolve (plan §3.2, Q3a). Reached by ACTIVE memberships: tenant-wide reaches every live account, account-scoped reaches its own. NULL defaults: `allow_recording` / `analyze_calls` → `false` (governance default), `max_concurrent_calls` → 5, `webrtc_max_duration_seconds` → 1800 (core flag default) |
| master `src/index.ts:121,181-184,494-631@a1f0756a` (route registration and boot wiring) | `apps/server/src/api/platform.plugin.ts` | new (lane-owned file) | `platform-agent-reach` NEW 4 | Registers every lane-A plugin at master's prefixes, except `/feature-flags` (master `/proxy/feature-flags`). With a context it calls `redisCache.init` (channel `${keyPrefix}cache:invalidate`) and `initFirebase`, and refuses to boot in production without Firebase. `@fastify/rate-limit` is registered `global: false` (per-route buckets: super-admin login, public invite routes), Redis-backed, `skipOnError`. Master's global IP limit is lane C's. The super-admin tree registers only when `config.superAdmin` is set |
| master `src/config/schema.ts@a1f0756a` (`:116-120`, `:183-185`, `:365-370`, `:450-479`, `:488-510`, `:721-727`) + `src/config/index.ts` (`:22-26`, `:52-54`, `:119-126`) | `apps/server/src/config/blocks/platform.ts` | modified (lane-owned block) | `local-cache-wiring` reads it | Blocks `firebase` (now OPTIONAL; + `serviceAccountPath`), `superAdmin`, `mailjet`, `brand`, `invites`, `localCache` (default off); `consoleBaseUrl` replaces `cusuiBaseUrl`. NEW `auditPartitions` (enabled, retentionDays ≥ 30 default 85, monthsAhead, intervalMs). Not carried: core-service, encryption, s2sAuth, webhooks, llm, platformEmail, scheduler, SQS, credits. `rateLimit` is lane C's |
| master `src/db/models/account.model.ts@a1f0756a` | `packages/db/src/models/account.model.ts` | verbatim (imports) | via the repository | |
| master `src/db/models/membership.model.ts@a1f0756a` | `packages/db/src/models/membership.model.ts` | verbatim (imports) | via the repository | |
| master `src/db/models/phone-number.model.ts@a1f0756a` | `packages/db/src/models/phone-number.model.ts` | verbatim (imports) | via the repository | Still declares `pool_eligible` (column is in the baseline) |
| master `src/db/models/super-admin.model.ts@a1f0756a` | `packages/db/src/models/super-admin.model.ts` | verbatim (imports) | via the repository | |
| master `src/db/models/telephony-provider.model.ts@a1f0756a` | `packages/db/src/models/telephony-provider.model.ts` | modified | via the repository | Deleted `live_transfer_enabled` (migration 074, not a baseline column) and the unused `Create`/`UpdateTelephonyProviderInput` (their users, the CRUD routes and repository writers, are deleted). The repository suite's fixture drops the field (type-only). The model is in `packages/db`; the repository is in `apps/server` (A.0) |
| master `src/db/models/tenant-phone-assignment.model.ts@a1f0756a` | `packages/db/src/models/tenant-phone-assignment.model.ts` | verbatim (imports) | via the repository | |
| master `src/db/models/tenant.model.ts@a1f0756a` | `packages/db/src/models/tenant.model.ts` | verbatim (imports) | via the repository | |
| master `src/db/models/user.model.ts@a1f0756a` | `packages/db/src/models/user.model.ts` | verbatim (imports) | via the repository | |
| master `src/db/repositories/account.repository.ts@a1f0756a` | `packages/db/src/repositories/account.repository.ts` | verbatim (imports) | unit 23 → 23; integration 16 → 16 | |
| master `src/db/repositories/membership.repository.ts@a1f0756a` | `packages/db/src/repositories/membership.repository.ts` | verbatim (imports) | unit 33 → 33; integration 33 → 33, `user-addressable-members` 15 → 15 | |
| master `src/db/repositories/tenant.repository.ts@a1f0756a` | `packages/db/src/repositories/tenant.repository.ts` | verbatim (imports) | unit 15 → 15; integration 13 → 13 | |
| master `src/db/repositories/user.repository.ts@a1f0756a` | `packages/db/src/repositories/user.repository.ts` | verbatim (imports) | unit 16 → 16 | |
| master `src/db/repositories/super-admin.repository.ts@a1f0756a` | `packages/db/src/repositories/super-admin.repository.ts` | verbatim (imports) | row written separately | |
| master `src/db/repositories/super-admin-audit.repository.ts@a1f0756a` | `packages/db/src/repositories/super-admin-audit.repository.ts` | verbatim (imports) | row written separately | |
| master `src/db/repositories/tenant-phone-assignment.repository.ts@a1f0756a` | `packages/db/src/repositories/tenant-phone-assignment.repository.ts` | verbatim (imports) | none at source (via `super-admin-phone`) | |
| master `src/db/repositories/phone-number.repository.ts@a1f0756a` | `packages/db/src/repositories/phone-number.repository.ts` | modified | integration 8 → 8 | Deleted `findPlatformOwned` (its one caller refused a platform DID as a BYOC number; BYOC out of scope, Decided #3). `findLeastAssigned` is kept verbatim but has no caller in agency (path 4 refuses; tenant create assigns no number, plan §3.4). It is a deletion candidate along with `pool_eligible` |
| core `src/db/repositories/account-settings.repository.ts@4850d1d9` (Phase 2b port) | `packages/db/src/repositories/account-settings.repository.ts` | modified (lane A additions) | integration `account-settings-webrtc-writer` NEW 4, `account-settings-toggles-writer` NEW 5 | Lane A adds `setWebrtcMaxDurationSeconds(tenantId, accountId, seconds)`: INSERT … ON CONFLICT (tenant_id, account_id) touching only that column and `updated_at`, then `TtlCache` write-through as in `upsert`. No core source. Also `setRecordingAnalysisToggles(tenantId, accountId, { allow_recording, analyze_calls })`: COALESCE on those two columns only (see A.4). The rest is Phase 2b's row |
| (new) | `packages/db/src/repositories/usage-counts.repository.ts` | new | integration `usage-counts.repository` NEW 7 | Plan §3.3 read behind `GET /super-admin/usage`: one `[from, to)` window on `agency_call_attempts.dialed_at` for every column. Analysis seconds join `dialer_analysis_jobs.call_id = webrtc_call_id` (at most one job per call). Served by `idx_agency_attempts_billing`. Attempts whose tenant/account row is gone still count |
| master `src/utils/metrics.ts@a1f0756a` (`:97-101` `local_cache_operations_total`, `:103-108` `local_cache_invalidations_total`, `:127-131` `auth_attempts_total`, `:215-219` `agency_campaign_notifications_total`, `:269-273` `invite_emails_total`, `:334-344` `InviteClaimResult` type, `:348-352` `invite_claims_total`, `:1090-1094` `notification_sends_total`) | `packages/observability/src/metrics/platform.ts` | modified (declarations) | none at source | Same names, descriptions (master's `help`) and label keys, checked against master. Declared through core's `counter(meter, name, { description })` facade instead of master's prom-client-shaped wrapper. All seven are counters. Not carried: `signupPhoneAssignmentsTotal` (path 4 refuses), `provider_concurrency_unsynced_accounts` (no sync) |
| (new) | `apps/server/scripts/create-super-admin.ts` | new | integration `create-super-admin` NEW 5 | Decision #6: creates the first super-admin. Mirrors `POST /super-admin/admins` (same body schema, bcrypt cost 10, duplicate refusal, `super_admin_audit_log` row). The password comes from env or stdin, never argv. `--system` sets `is_system`. Outside `src/`, listed for completeness |
| master `test/integration/setup/factories.ts@a1f0756a` (identity/phone half) | `packages/db/test/integration/setup/platform-factories.ts` | modified (test helper) | — | Verbatim except: re-exports the lead's `insertTenant` / `insertAccount` / `insertUser`; credit, rate-card, API-key, bulk-dispatch, contact-list and workflow factories are not carried; `provisionTenant` drops its credit-balance row |
| master `test/unit/auth/firebase-identity.test.ts@a1f0756a` | `apps/server/test/unit/auth/firebase-identity.test.ts` | verbatim (imports) | 20 → 20 | |
| master `test/unit/auth/session-email.test.ts@a1f0756a` | `apps/server/test/unit/auth/session-email.test.ts` | verbatim (imports) | 6 → 6 | |
| master `test/unit/auth/session.middleware.test.ts@a1f0756a` | `apps/server/test/unit/auth/session.middleware.test.ts` | modified | 12 → 8 | Deleted the 4-case 'API key auth path' block (decision #5): "should load API key from DB on cache miss and cache the result", "should return cached API key without hitting DB or writing back to cache", "should return 401 when API key not found", "should return 401 when API key is expired". `platform-api-key.repository` / `utils/crypto` mocks removed |
| master `test/unit/auth/auth-session-email-verified.test.ts@a1f0756a` | `apps/server/test/unit/auth/auth-session-email-verified.test.ts` | modified | 6 → 6 | MODIFIED "does not 403 a phone-auth token that carries no email": path 4 now asserts 403 `no_membership` and that no transaction opened (master: `connect` threw → 500). `proxy/core-client`, `utils/crypto`, `config/index`, `signupPhoneAssignmentsTotal` mocks removed |
| master `test/unit/auth/invite-claim-session-composition.test.ts@a1f0756a` | `apps/server/test/unit/auth/invite-claim-session-composition.test.ts` | modified | 11 → 11 | Static counter reads 13 → 13 (two `.test(` regex calls). `resolveGovernanceSafe` → `resolveSettingsSafe`, `governance` → `settings: {}`. MODIFIED "does NOT let a token for the invited address take the membership over": now asserts path 4's 403 `no_membership` (master: the fake raised PROVISIONED on `INSERT INTO users`) |
| master `test/unit/cache/local-cache.test.ts@a1f0756a` | `apps/server/test/unit/cache/local-cache.test.ts` | verbatim (imports) | 15 → 15 | |
| master `test/unit/cache/redis-cache.test.ts@a1f0756a` | `apps/server/test/unit/cache/redis-cache.test.ts` | verbatim (imports) | 23 → 23 | |
| master `test/unit/cache/redis-cache-invalidation-order.test.ts@a1f0756a` | `apps/server/test/unit/cache/redis-cache-invalidation-order.test.ts` | verbatim (imports) | 4 → 4 | |
| master `test/unit/cache/local-cache-wiring.test.ts@a1f0756a` | `apps/server/test/unit/cache/local-cache-wiring.test.ts` | modified | 7 → 7 | Source reads re-pointed from master `src/index.ts` to `src/api/platform.plugin.ts` (`redisCache.init(opts.ctx.redis, …)`), the three subscriber cases to `src/bootstrap/platform.ts` (`subscriber` for `cacheInvalidationSubscriber`, `quit()` on the stop function for `disconnect()`), and the schema to `src/config/blocks/platform.ts`. `envBoolean.default(false)` |
| master `test/unit/services/tenant-name-resolver.test.ts@a1f0756a` | `apps/server/test/unit/services/tenant-name-resolver.test.ts` | modified | 16 → 14 | Deleted with the `identifyGroups` call: "registers the resolved names as PostHog group properties", "passes resolved names (even partial) to identifyGroups". One case loses its `identifyGroups` assertion. PostHog mock removed |
| master `test/unit/services/tenant-record-cache.edge.test.ts@a1f0756a` | `apps/server/test/unit/services/tenant-record-cache.edge.test.ts` | modified (mocks) | 7 → 7 | PostHog mock removed, nothing else |
| master `test/unit/api/middleware/tenant-context.middleware.test.ts@a1f0756a` | `apps/server/test/unit/api/middleware/tenant-context.middleware.test.ts` | modified | 33 → 24 | Deleted 9 (decision #5): the 6-case 'API key authentication path' block ("should allow request when apiKeyTenantId matches X-Tenant-Id", "should set accountId from X-Account-Id header when using API key", "should return 403 when apiKeyTenantId does not match X-Tenant-Id", "should NOT resolve names when apiKeyTenantId mismatches (rejected before attach)", "should resolve and attach names on the API-key path", "should not query membership DB when using API key"), "uses the same selection on the platform-API-key branch", "applies on the platform-API-key path too", "should skip cache for API key auth path" |
| master `test/unit/rbac/rbac-middleware.test.ts@a1f0756a` | `apps/server/test/unit/rbac/rbac-middleware.test.ts` | modified | 19 → 7 | Deleted 12. API-key 'no user context' (3): "denies a key with no resolvable membership — the bypass must stay closed", "denies the most dangerous permission on that same shape", "should not skip when apiKeyTenantId is set but user is also set". 'API key scopes narrow, never widen' (6): "allows a permission the key scope covers", "denies a permission outside the key scope even when the ROLE clears it", "cannot widen a key beyond its creator role", "treats the wildcard as \"defer to the role\", the stored default", "does not retroactively brick a key whose scopes array is empty", "leaves a signed-in user untouched by scope logic". No contract permission at the floor (3): "should return 403 when viewer tries to create calls", "should pass when operator creates calls", "should pass when tenant_admin manages API keys". Three cases re-pointed to same-floor permissions: `credit.allocate` → `user.update_role`, `tenant.update` → `user.remove`, survivor `audit.read` |
| master `test/unit/rbac/roles.test.ts@a1f0756a` | `apps/server/test/unit/rbac/roles.test.ts` | modified | 38 → 19 | Runs against `@magick-agency/contracts/rbac`. `proxy.prompts.read\|write` → `agency.analysis_profiles.read\|write`. Lines asserting removed permissions are deleted. Deleted whole (19): "should require operator for call/static_call creation"; viewer "should deny operator-and-above permissions"; viewer and account_admin "should deny tenant_admin permissions"; both 'boundary conditions' cases ("should allow permission when role exactly matches minimum", "should deny permission when role is one level below minimum"); the 13 'RBAC — messaging permissions' cases (`proxy.messaging.*`, `proxy.analytics.read`) |
| master `test/unit/rbac/roles.agent.test.ts@a1f0756a` | `apps/server/test/unit/rbac/roles.agent.test.ts` | modified | 19 → 18 | `proxy.feature_flags.read` → `agency.flags.read`, `proxy.contact_lists.read` → `agency.campaigns.read`. Deleted "does NOT come with the stats lane it used to borrow" (`proxy.stats.read` not in the contract). One case trimmed: its `proxy.calls.create`, `proxy.calls.read` and `credit.read` lines are dropped and `tenant.read` remains |
| master `test/unit/api/routes/account.routes.test.ts@a1f0756a` | `apps/server/test/unit/api/routes/account.routes.test.ts` | modified | 14 → 10 | Deleted with PUT/DELETE `/accounts/:id`, the 4-case 'account-scope enforcement on PUT/DELETE (sibling-account IDOR)' block: "404s a PUT whose path id differs from an account-scoped caller's own account", "allows a PUT to the account-scoped caller's OWN account", "404s a DELETE of a sibling account for an account-scoped caller", "a TENANT-WIDE membership (account_id null) may PUT/DELETE any account in the tenant". `tenant-name-resolver`, `metadata-cache`, core settings-sync mocks removed |
| master `test/unit/api/routes/tenant.routes.test.ts@a1f0756a` | `apps/server/test/unit/api/routes/tenant.routes.test.ts` | modified | 11 → 9 | Deleted with `PUT /tenants/:id`: "updates the proven tenant when the path matches X-Tenant-Id", "404s without writing when the path names another tenant". `tenant.repository`, `tenant-name-resolver`, `metadata-cache`, core settings-sync mocks removed |
| master `test/unit/api/routes/user.routes.test.ts@a1f0756a` | `apps/server/test/unit/api/routes/user.routes.test.ts` | verbatim (imports) | 46 → 46 | Vitest per-file count 46 (source the same file shape). 43 `it(` lines, three of them inside two `for (const reversed of [false, true])` loops (`:784` holds 2, `:922` holds 1), so 40 + 3 × 2 = 46; a static `it(` count reads 43 |
| master `test/unit/api/routes/user-offboarding-staffing.test.ts@a1f0756a` | `apps/server/test/unit/api/routes/user-offboarding-staffing.test.ts` | modified (names) | 27 → 27 | `auditLogger` → `platformAuditLogger` and `cusuiBaseUrl` → `consoleBaseUrl` in the mock and config.  |
| master `test/unit/api/routes/user-invite-mailer-isolation.test.ts@a1f0756a` | `apps/server/test/unit/api/routes/user-invite-mailer-isolation.test.ts` | verbatim (imports) | 6 → 6 | |
| master `test/unit/api/routes/user-cache-invalidation.wiring.test.ts@a1f0756a` | `apps/server/test/unit/api/routes/user-cache-invalidation.wiring.test.ts` | modified (mocks) | 4 → 4 | Cases unchanged. Removed mocks for path-4 / governance modules `auth.routes.ts` no longer imports: credit-balance, credit-transaction, tenant-core-credential, phone-number, tenant-phone-assignment, proxy/core-client, utils/crypto, config/index, governance.service, `signupPhoneAssignmentsTotal` |
| master `test/unit/api/routes/invites.routes.test.ts@a1f0756a` | `apps/server/test/unit/api/routes/invites.routes.test.ts` | modified | 48 → 48 | `cusuiBaseUrl` → `consoleBaseUrl`; `auditLogger` → `platformAuditLogger`. MODIFIED "carries the full auth chain, and refuses a platform API key" → "carries the full auth chain": asserts `denyPlatformApiKey('` is ABSENT and the other three links are present |
| master `test/unit/api/routes/notification.routes.test.ts@a1f0756a` | `apps/server/test/unit/api/routes/notification.routes.test.ts` | modified | 25 → 14 | Cases on `usage.digest` / `campaign.completed` now assert on `agency.campaign.completed`. Deleted 14: "still offers a viewer the explicitly-addressed campaign events" (broadcast events); the `POST /digests/preview` block, 6 `it` ("403s a caller with no membership in this tenant", "takes the WIDEST membership, so a second row can clear the floor", "scopes to the membership that clears the floor, not the oldest one", "a tenant-wide row below the floor does not widen an account-scoped admin to the tenant", "refuses BEFORE reading the tenant, so an unauthorised caller costs nothing", "is refused for a platform API key like every other route here") + 2 `it.each` × 3 ("403s a %s, who cannot receive the digest", "serves a %s"); 'platform API keys' › "are refused — there is no \"me\" for a machine credential" (decision #5). NEW 3: "GETs its own preferences: 200, an empty list", "PUTs its own preferences: 200, stored against the session user" (agent, plan §9), "POST /digests/preview is not registered (credits usage digest, plan §3.5)" |
| master `test/unit/api/routes/proxy-feature-flags.routes.test.ts@a1f0756a` | `apps/server/test/unit/api/routes/proxy-feature-flags.routes.test.ts` | modified (hop collapse) | 5 → 4 | MODIFIED "proxies GET to core /feature-flags with the per-tenant API key + tenant/account" → "resolves GET in-process for the proven tenant/account …". Deleted "passes through the core status (e.g. 401)" (no upstream) and "uses the S2S-free tenant credential (not the bearer token path)" (no credential). Two permission cases re-pointed to `agency.flags.read`. NEW "400s a request that names no account, as core's auth middleware did through the proxy". Mocks are now the flag service, not `proxyToCore` / `resolveCoreApiKey` |
| core `test/unit/api/routes/feature-flags-client.test.ts@4850d1d9` | `apps/server/test/unit/api/routes/feature-flags-client.test.ts` | modified | 3 → 3 | Runs against the collapsed route: lane A's session / tenant-context / `requirePermission` are mocked where core's `authMiddleware` stood. Prefix `/api/v1/feature-flags` → `/feature-flags`. Fixture flag `whatsapp_personal` replaced (not an agency flag) |
| master `test/unit/api/validators/auth.validator.test.ts@a1f0756a` | `apps/server/test/unit/api/validators/auth.validator.test.ts` | verbatim (imports) | 7 → 7 | |
| master `test/unit/api/validators/user.validator.test.ts@a1f0756a` | `apps/server/test/unit/api/validators/user.validator.test.ts` | verbatim (imports) | 12 → 12 | |
| master `test/unit/validators/notification.validator.test.ts@a1f0756a` | `apps/server/test/unit/validators/notification.validator.test.ts` | modified | 51 → 24 | Deleted 22 with `previewDigestSchema` (2 + 5) and `runDigestsSchema` (4 + 11). Deleted 5 that need a digest event or two live events: "accepts a digest preference with a cadence", "accepts an explicit null frequency on a digest", "accepts a digest preference with NO frequency at all", "accepts every cadence the scheduler runs", "does not treat two DIFFERENT events as duplicates". Remaining cases use `agency.campaign.completed`. The 50-entry case shares one identity and still fails on the duplicate rule |
| master `test/unit/db/repositories/membership-invite.repository.test.ts@a1f0756a` | `apps/server/test/unit/db/repositories/membership-invite.repository.test.ts` | verbatim (imports) | 38 → 38 | Mocked specifier `src/db/connection.js` → `@magick-agency/db` |
| master `test/unit/db/repositories/notification-delivery.repository.test.ts@a1f0756a` | `apps/server/test/unit/db/repositories/notification-delivery.repository.test.ts` | verbatim (imports) | 45 → 45 | Static counter reads 37 → 37: a `for` loop over 9 rows generates "normalises …" cases. Mocked specifier → `@magick-agency/db` |
| master `test/unit/db/repositories/notification-preference.repository.test.ts@a1f0756a` | `apps/server/test/unit/db/repositories/notification-preference.repository.test.ts` | modified (typing) | 27 → 27 | `pref()` typed as `UpsertNotificationPreferenceInput` (agency typechecks tests, B1) |
| master `test/unit/invites/invite-issuer.test.ts@a1f0756a` | `apps/server/test/unit/invites/invite-issuer.test.ts` | verbatim (imports) | 16 → 16 | Mocks re-pointed to `@magick-agency/db/…`, `@magick-agency/observability(/metrics/platform)` |
| master `test/unit/invites/membership-invite-state.test.ts@a1f0756a` | `apps/server/test/unit/invites/membership-invite-state.test.ts` | verbatim | 6 → 6 | |
| master `test/unit/notifications/invite-mailer.test.ts@a1f0756a` | `apps/server/test/unit/notifications/invite-mailer.test.ts` | modified (names) | 38 → 38 | `cusuiBaseUrl` → `consoleBaseUrl` in every case. The warning assertion names `CONSOLE_BASE_URL`. Logger mock → `@magick-agency/observability`. No case deleted |
| master `test/unit/notifications/invite-token.test.ts@a1f0756a` | `apps/server/test/unit/notifications/invite-token.test.ts` | verbatim | 14 → 14 | |
| master `test/unit/notifications/mailjet.client.test.ts@a1f0756a` | `apps/server/test/unit/notifications/mailjet.client.test.ts` | verbatim (imports) | 8 → 8 | |
| master `test/unit/notifications/agent-invite.template.test.ts@a1f0756a` | `apps/server/test/unit/notifications/agent-invite.template.test.ts` | verbatim | 24 → 24 | |
| master `test/unit/notifications/agency-campaign-completion.test.ts@a1f0756a` | `apps/server/test/unit/notifications/agency-campaign-completion.test.ts` | modified (names) | 42 → 42 | `cusuiBaseUrl` → `consoleBaseUrl` (2 places) |
| master `test/unit/notifications/agency-campaign-unsubscribe.test.ts@a1f0756a` | `apps/server/test/unit/notifications/agency-campaign-unsubscribe.test.ts` | modified (names) | 8 → 8 | `cusuiBaseUrl` → `consoleBaseUrl` |
| master `test/unit/notifications/engine/audience.test.ts@a1f0756a` | `apps/server/test/unit/notifications/engine/audience.test.ts` | modified | 71 → 34 | Deleted 37, all driving `resolveRoleFloorAudience`: its block (14), the three after it ("drops the recipient from every cadence-narrowed run", "still resolves the recipient when the run is not narrowed, at a NULL cadence", "also leaves a STORED row at a null cadence, not at the stored value"), "is consistent with who `resolveRoleFloorAudience` actually mails", and 'resolveRoleFloorAudience, further edges' (17 + 2 `it.each` rows). Master's three other catalog entries are restated as fixtures (`MASTER_EVENTS`, from master `catalog.ts:108-183`). By-key cases use `agency.campaign.completed`. The `notificationPreferenceRepository` mock is kept but inert |
| master `test/unit/notifications/engine/catalog.test.ts@a1f0756a` | `apps/server/test/unit/notifications/engine/catalog.test.ts` | modified | 30 → 28 | Deleted the 'defaults' block: "the usage digest is on, weekly, and floored at account_admin", "campaign notices are addressed explicitly, not by role". "has exactly the four events this build ships" → "has exactly the one event this build ships". `usage.digest` assertions and key-spelling variants now use the live key |
| master `test/unit/notifications/engine/deliver.test.ts@a1f0756a` | `apps/server/test/unit/notifications/engine/deliver.test.ts` | modified | 50 → 6 | Static counter reads 46 for the source: 'the claim, per SendEmailOutcome' generates 5 cases from a `for` loop over `CASES`. Kept: the six `buildDedupeKey` cases, verbatim. Deleted 44: `dispatchNotification` (17), `scopeToken` (1), 'the claim, per SendEmailOutcome' (5 rows + 4), 'partial outcomes across one fan-out' (4), 'writes that fail after the mail has gone' (4), 'scopeToken edges' (4), 'buildDedupeKey edges' › "composes with scopeToken to separate the two scopes of one tenant" (1), 'the transport guard, once more' (4) |
| master `test/unit/notifications/engine/period.test.ts@a1f0756a` | `apps/server/test/unit/notifications/engine/period.test.ts` | modified | 37 → 4 | Kept: the four `isDigestFrequency` cases, verbatim. Deleted 33 with the window arithmetic: `resolvePeriodWindow` (daily 5, weekly 5, +2), `previousWindow` (2), `formatPeriodLabel` (2), `toIsoDate` (1), calendar edges (5), Sunday offset (2), `previousWindow` across boundaries (4), month names (5) |
| master `test/unit/audit/audit-actor-call-sites.test.ts@a1f0756a` | `apps/server/test/unit/audit/platform/audit-actor-call-sites.test.ts` | modified (lane A restores a case) | 7 → 7 | Phase 2b ported this 7 → 6. Lane A RESTORES "finds the audited call sites at all" with floor 4 (master ≥ 29; lane B2 raises it to 22). The Phase 2b changes stand |
| master `test/unit/audit/catalog.test.ts:60-80@a1f0756a` (the three "D10 / MAG-157" guards Phase 2b deleted) | `apps/server/test/unit/audit/platform/concurrency-super-admin-only.test.ts` | modified + new | 3 → 4 | VERBATIM: "super-admin account concurrency already writes super_admin_audit". MODIFIED to scan every agency route/module, not master's single file: "the agency campaign proxy has no concurrency write path" (master's comment check moves to B2), "agency campaign config validation has no concurrency field". NEW: "the limit is written only by the super-admin routes (the repository writers have exactly these callers)": `replaceProviderBreakdown` / `switchToLegacy` only in `super-admin.routes.ts`, `upsert` nowhere, `setRecordingAnalysisToggles` only in the settings route |
| (new) | `apps/server/test/helpers/drain-super-admin-audit.ts` | new (test helper) | — | Wraps `superAdminAuditRepository.log` so `super-admin.routes`, `feature-flag-rollout` and `platform-onboarding.e2e` await the routes' fire-and-forget audit writes in `afterEach`; an in-flight INSERT deadlocked with the next case's TRUNCATE (40P01 in the container log). Routes unchanged |
| (new) | `apps/server/test/unit/api/routes/membership-fail-closed.test.ts` | new | — → 7 | With `requirePermission` stubbed to pass and no `request.membership`, each of the five caller-role sites in `user.routes.ts` / `invites.routes.ts` must 403 and write nothing. Includes the equivalence half (membership present ⇒ master behaviour) |
| (new) | `apps/server/test/unit/api/platform-agent-reach.test.ts` | new | — → 4 | Plan §9: routes are enumerated from `onRoute`. The lane-A set is what `platformPlugin` registers on its own (captured from a bare app), matched against the real app's table and checked against the plugin's exported `PLATFORM_ROUTE_PREFIXES`. An `agent` reaches exactly `EXPECTED_AGENT_REACHABLE` |
| (new) | `apps/server/test/unit/settings/agency-account-settings.test.ts` | new | — → 13 | Settings map: reach by active memberships, NULL / missing-row defaults |
| master `test/integration/api/auth.routes.test.ts@a1f0756a` | `apps/server/test/integration/api/auth.routes.test.ts` | modified | 16 → 19 (static) | Real Postgres via `initDbPool` (master mocked `db/connection`). MODIFIED "auto-provisions a new user (201) … 100k signup bonus" → "refuses a new user (403 no_membership) and writes no user, tenant, account or membership". MODIFIED "sends governance: {} (fail-open) …" → "sends settings: {} …". GET /me asserts the real settings map. Deleted: "auto-assigns a signup-pool number as the tenant default when one is available", "still provisions the tenant (201) without a phone when the signup pool is empty", "does not fail signup (201) when phone assignment throws". NEW 6 (session paths 1–4, plan §3.1): path 1, path 2, path 3, path 4 verified stranger, path 4 phone-only token, "path 4 leaves no trace …". Mocks for core-client, crypto, config, tracing, tenant-core-credential, phone-number, tenant-phone-assignment, governance, metrics removed |
| master `test/integration/api/account.routes.test.ts@a1f0756a` | `apps/server/test/integration/api/account.routes.test.ts` | modified | 8 → 3 (static) | Kept "lists accounts for tenant". Deleted with POST/PUT/DELETE: the 4 'POST /accounts — validation errors' cases, 'PUT /accounts/:id — validation errors' (1), 'POST /accounts — successful creation' (1), 'DELETE /accounts/:id' (1). NEW `GET /accounts/mine` on real Postgres: "resolves a tenant-wide membership to every live account, three fields each", "confines an account-scoped membership to its own account". |
| master `test/integration/api/tenant.routes.test.ts@a1f0756a` | `apps/server/test/integration/api/tenant.routes.test.ts` | modified | 23 → 17 (static) | Deleted with `GET /tenants` and `PUT /tenants/:id`. 'GET / — lists user tenants' (2): "returns all tenants the user has memberships in", "returns empty array for user with no tenants". 'PUT /:id — update tenant' (4): "updates tenant name", "returns 400 for invalid name (empty string)", "returns 404 for non-existent tenant", "cannot rename another tenant when the path id disagrees with X-Tenant-Id". Real Postgres via `initDbPool`. Metadata-cache and settings-sync stubs removed |
| master `test/integration/api/user.routes.test.ts@a1f0756a` | `apps/server/test/integration/api/user.routes.test.ts` | modified (harness) | 15 → 15 (static) | `initDbPool` instead of mocking `db/connection`. Logger mock spreads the real `@magick-agency/observability` |
| master `test/integration/api/agency-offboarding-staffing.test.ts@a1f0756a` | `apps/server/test/integration/api/agency-offboarding-staffing.test.ts` | modified | 19 → 17 (static) | `GET /audit-log` is not ported. DELETED: "the account_admin of EACH account sees their own row and not the other's", "and the TENANT-level admin sees both". MODIFIED (route read half dropped, written-row account still asserted): "lands correctly even when the ACTOR sent no X-Account-Id at all", "is not filed under whichever account the ADMIN happened to have selected". Harness: `initDbPool`; master's `seen` helper copied; `auditLogger` → `platformAuditLogger` |
| master `test/integration/cache/local-cache-invalidation.test.ts@a1f0756a` | `apps/server/test/integration/cache/local-cache-invalidation.test.ts` | modified (Redis target) | 9 → 9 (static) | 6381 → agency's guarded test Redis (6383, non-zero db). FLUSHDB behind `assertSafeTestRedisUrl()` |
| master `test/integration/cache/membership-invalidation.test.ts@a1f0756a` | `apps/server/test/integration/cache/membership-invalidation.test.ts` | modified (harness) | 3 → 3 (static) | `db/connection` and `analytics/posthog` stubs removed. Redis target as above |
| master `test/integration/cache/redis-cache.delbypattern.test.ts@a1f0756a` | `apps/server/test/integration/cache/redis-cache.delbypattern.test.ts` | modified (Redis target) | 4 → 4 (static) | As above |
| master `test/integration/cache/tenant-record-cache.test.ts@a1f0756a` | `apps/server/test/integration/cache/tenant-record-cache.test.ts` | modified (harness) | 10 → 10 (static) | Package pool initialised on the test DB; PostHog stub removed. Redis target as above |
| master `test/integration/repositories/membership-invite-claim-confinement.test.ts@a1f0756a` | `apps/server/test/integration/repositories/membership-invite-claim-confinement.test.ts` | modified (harness, typing) | 7 → 7 (static) | `initDbPool`. `null` token claims are typed through `NO_CLAIM` (same runtime value) |
| master `test/integration/repositories/user-email-proof.test.ts@a1f0756a` | `apps/server/test/integration/repositories/user-email-proof.test.ts` | modified | 32 → 31 (static) | DELETED "BACKFILLS rows bound by a historical claim — history is not safe to default": it ran master migration 073's backfill, and agency's squashed baseline has no backfill (cutover copies the flag). `initDbPool`; `NO_CLAIM` typing |
| master `test/integration/repositories/notification-delivery.repository.test.ts@a1f0756a` | `apps/server/test/integration/repositories/notification-delivery.repository.test.ts` | modified (mock specifier) | 42 → 42 (static) | Mocked specifier `src/db/connection.js` → `@magick-agency/db`. It stays a redirectable holder on purpose. `event_key` values kept as master wrote them |
| master `test/integration/repositories/notification-preference.repository.test.ts@a1f0756a` | `apps/server/test/integration/repositories/notification-preference.repository.test.ts` | modified | 32 → 32 (static) | Real package pool via `initDbPool`. In one case the LIVE key is `agency.campaign.completed`, where master used `usage.digest` |
| (new) | `apps/server/test/integration/api/invite-security-audit.test.ts` | new | — → 46 | Lane-A security audit of invites and team management on real Postgres and Redis, with only Firebase mocked: (a) escalation and scope widening, (b) resend at or above own role, (c) role only from stored rows, (d) claim from a different address, (e) cross-tenant headers, (f) issue / revoke / single use / expiry, (g) auth chain on every authenticated route, (h) exact public-route bodies |
| (new) | `apps/server/test/integration/api/notification.routes.test.ts` | new | — → 6 (static) | Real route, session, tenant-context and Redis on Postgres 5436. Agent GET/PUT its own preferences, supervisor contrast, deleted key → 400, no token → 401, digest preview 404 |
| (new) | `apps/server/test/integration/api/platform-onboarding.e2e.test.ts` | new | — → 2 (static) | Plan §8 Phase 3 exit gate: create-super-admin → login → tenant create → owner path-2 sign-in → add agent → unverified claim → `/accounts/mine`. Path 4 refuses a stranger and writes nothing |
| (new) | `apps/server/test/integration/scripts/create-super-admin.test.ts` | new | — → 5 (static) | The CLI on real Postgres (decision #6) |
| (new) | `apps/server/test/integration/settings/agency-account-settings.test.ts` | new | — → 1 (static) | Settings map SQL on real Postgres: deleted / sibling / foreign accounts excluded, NULL → defaults, revoked membership reaches nothing |
| (new) | `apps/server/test/integration/agency/campaign-behavioral-settings.test.ts` | new | — → 6 (static) | Per-field gate against the real `account_settings` row (plan §9) |
| master `test/unit/db/repositories/account.repository.test.ts@a1f0756a` | `packages/db/test/unit/db/repositories/account.repository.test.ts` | verbatim (imports, type casts) | 23 → 23 | Type-only casts (B1) |
| master `test/unit/db/repositories/membership.repository.test.ts@a1f0756a` | `packages/db/test/unit/db/repositories/membership.repository.test.ts` | verbatim (imports, type casts) | 33 → 33 | Static counter reads 36 → 36 (three `.test(` regex calls). Type-only casts on two `mock.calls` reads |
| master `test/unit/db/repositories/tenant.repository.test.ts@a1f0756a` | `packages/db/test/unit/db/repositories/tenant.repository.test.ts` | verbatim (imports, type casts) | 15 → 15 | |
| master `test/unit/db/repositories/user.repository.test.ts@a1f0756a` | `packages/db/test/unit/db/repositories/user.repository.test.ts` | verbatim (imports) | 16 → 16 | |
| master `test/integration/repositories/account.repository.test.ts@a1f0756a` | `packages/db/test/integration/repositories/account.repository.test.ts` | verbatim (imports, one `!`) | 16 → 16 (static) | |
| master `test/integration/repositories/membership.repository.test.ts@a1f0756a` | `packages/db/test/integration/repositories/membership.repository.test.ts` | verbatim (imports, `!`) | 33 → 33 (static) | |
| master `test/integration/repositories/tenant.repository.test.ts@a1f0756a` | `packages/db/test/integration/repositories/tenant.repository.test.ts` | verbatim (imports) | 13 → 13 (static) | |
| master `test/integration/repositories/phone-number.repository.test.ts@a1f0756a` | `packages/db/test/integration/repositories/phone-number.repository.test.ts` | verbatim (imports) | 8 → 8 (static) | Factories from `platform-factories`. Keeps the `findLeastAssigned` / `pool_eligible` cases (column is in the baseline) |
| master `test/integration/repositories/user-addressable-members.repository.test.ts@a1f0756a` | `packages/db/test/integration/repositories/user-addressable-members.repository.test.ts` | verbatim (imports) | 15 → 15 (static) | 11 `it` incl. 3 `it.each` tables |
| (new) | `packages/db/test/integration/repositories/usage-counts.repository.test.ts` | new | — → 7 (static) | Window rule, analysis attribution, tenant/account narrowing, orphaned attempts still counted, served by `idx_agency_attempts_billing` |
| (new) | `packages/db/test/integration/repositories/account-settings-toggles-writer.test.ts` | new | — → 5 | The race on the real `upsert` SQL (read-then-upsert reverts a concurrency write that lands between), the toggles-only writer leaving it intact, PATCH/null semantics, insert at defaults, cache write-through |
| (new) | `packages/db/test/integration/repositories/account-settings-webrtc-writer.test.ts` | new | — → 4 (static) | `setWebrtcMaxDurationSeconds`: upsert, touches only its column, cache write-through, baseline CHECK `> 0` |
| master `test/unit/api/routes/super-admin-accounts.test.ts@a1f0756a` + core `test/unit/api/routes/feature-flags-internal.test.ts@4850d1d9` ('Internal S2S — provider concurrency control plane', 5) | `apps/server/test/unit/api/routes/super-admin-accounts.test.ts` | modified (hop collapse) + new | 26 + 5 → 38 | Master's `coreInternalRequest` assertions become assertions on `providerConcurrencyRepository`, `accountSettingsRepository.invalidate`, the `concurrency-control` seam (stubbed) and the two audit rows. Deleted 7: "should report unavailable rather than fabricate a limit when core returns 404" (no core non-200), "rejects unknown providers before calling core" (telephony catalog deleted), both `retry-sync` cases, the three `provider_concurrency_unsynced_accounts refresh` cases. Core's 5 control-plane cases ported as equivalence tests; core's `triggerDequeue()` assertion dropped (AI queue). NEW 14: invalidation ORDER (settings cache → account guard → provider guard), migration drain check on `getDistributedAccountCount` (503 / 409 / `force_migration`), version conflict → 409 + failed-audit row, core's `concurrency.allocation.updated` row with the super admin's email, utilization read (`null` when the seam throws), an unexpected throw → 500 WITH the failed-audit row |
| (new) | `apps/server/test/unit/api/routes/super-admin-memberships.test.ts` | new | — → 55 | `POST /super-admin/tenants` (no pooled number, `pending_` stub, unproven-address 409, ROLLBACK), `POST …/users` (tenant- and account-context rules, invite revoke in-transaction, `issueInvite(invitedBy: null)`, issuance failure keeps the 201), `PUT …/memberships/:id/role` and `DELETE …/memberships/:id` (last-owner CAS, cache del, staffing close rules, close failure does not fail the write), 401 without / with a wrong JWT on every route |
| (new) | `apps/server/test/unit/api/routes/super-admin-account-settings.test.ts` | new | — → 24 | PATCH semantics, `webrtc_max_duration_seconds` 60..14400 (59, 14401, 60.5, 0 refused), `.strict()` body, toggles through `upsert` with the UNCACHED concurrency, `invalidateAccountLimit`, audit row, 404 for another tenant's account |
| (new) | `apps/server/test/unit/api/routes/super-admin-usage-counts.test.ts` | new | — → 22 | Query validation (ISO window, 400-day cap, `account_id` needs `tenant_id`, dirty-parse guard), filters forwarded, exact tenant/total sums in first-seen order, 401 |
| master `test/unit/api/routes/super-admin-phone.test.ts@a1f0756a` | `apps/server/test/unit/api/routes/super-admin-phone.test.ts` | modified | 16 → 9 | Deleted 11: the two unassign-cascade cases ("cascades inbound config removal before unassigning", "continues with unassign even when cascade throws — best-effort") and the nine `PUT /super-admin/telephony-providers/:id — live_transfer_enabled` cases (route deleted). Modified 4: the two 404 cases lose the `removeAllForTenantPhone` assertion; the two `pool_eligible` forwarding cases are inverted (stripped, never on the wire). NEW 4: unassign with no lookup and no cascade; `pool_eligible` stripped from every GET row; the telephony-provider WRITE routes are not registered; `GET /telephony-providers` (master's list, kept by the lead in session 3 so the super-admin console can pick the seeded provider's id) lists and forwards `?status` |
| master `test/unit/api/validators/super-admin.validator.test.ts@a1f0756a` | `apps/server/test/unit/api/validators/super-admin.validator.test.ts` | modified + new | 37 → 56 | Deleted 14 with `topupCreditsSchema` (7) and `deductCreditsSchema` (7). 23 verbatim. NEW 33 (incl. 2 for the 400-day usage window: exactly 400 days accepted, 400 days + 1 ms refused): `addUserToTenantSchema.account_id`, `changeMembershipRoleSchema`, `updateAgencyAccountSettingsSchema` (bounds, strict, at least one field), `usageCountsQuerySchema` (half-open window, uuid ids, `account_id` needs `tenant_id`, refine on a dirty value does not throw) |
| master `test/unit/api/validators/phone-number.validator.test.ts@a1f0756a` | `apps/server/test/unit/api/validators/phone-number.validator.test.ts` | deleted + new | 8 → 6 | All 8 source cases test `updateTelephonyProviderSchema` (`live_transfer_enabled`, 3 `it` + 5 `it.each` rows), deleted with the telephony-provider routes. NEW 6: the deleted schemas are gone; `pool_eligible` is stripped by the create and update schemas |
| master `test/unit/db/repositories/telephony-provider.repository.test.ts@a1f0756a` | `apps/server/test/unit/db/repositories/telephony-provider.repository.test.ts` | modified | 19 → 10 | Deleted 10 with `findLiveTransferEnabledNames` (4), `create` (1) and `update` (5). 9 verbatim (reads; the shared fixture drops `live_transfer_enabled`, type-only). NEW "exposes the reads only" |
| master `test/unit/db/repositories/super-admin.repository.test.ts@a1f0756a` | `packages/db/test/unit/db/repositories/super-admin.repository.test.ts` | verbatim (imports) | 7 → 7 | |
| master `test/unit/db/repositories/super-admin-audit.repository.test.ts@a1f0756a` | `packages/db/test/unit/db/repositories/super-admin-audit.repository.test.ts` | verbatim (imports) | 14 → 14 | |
| master `test/integration/api/super-admin.routes.test.ts@a1f0756a` | `apps/server/test/integration/api/super-admin.routes.test.ts` | modified | 56 → 46 | Deleted 10: `POST …/credits` (4), `POST …/credits/deduct` (3), "reports the credit cache beside the ledger, as strings" (1), `DELETE /super-admin/tenants/:id` (2). Modified: "creates tenant with account and membership" (no `core_key_provisioned` / `phone_auto_assigned`, no `tenant_phone_assignments` or credit row), the tenant list and detail cases (credit fixture and assertions dropped). Real Postgres via `initDbPool`; core-client, crypto and phone mocks removed |
| master `test/unit/api/routes/super-admin-feature-flags.test.ts@a1f0756a` | `apps/server/test/unit/api/routes/super-admin-feature-flags.test.ts` | modified (hop collapse) | 35 → 22 | Outgoing-core-request assertions become the in-process effect (repository call, `invalidate`, response). UUID ids; `whatsapp_personal` → `agency_dialer_enabled`; policy / `prewarm` flags are unregistered fixture copies. Deleted 14: 'broadcast_concurrency cache bust' (2), "502 when the core call throws", the policy cases (3 `it.each` rows "refuses an enable with a %s reason, before core", "refuses bulk outright (422)…", "annotates the catalog entry…", "annotates the per-flag detail", "a prototype-named key gets no policy"), the bulk `422 Invalid Scope` `it.each` row (unreachable), and the three error-mask cases ("Fastify's unmatched-route 404 from core stays masked", "an unreviewed core 4xx label is still masked", "a core 5xx is still masked even with a reviewed label"). NEW: a non-UUID tenant on resolve is a 400 |
| core `test/unit/api/routes/feature-flags-internal.test.ts@4850d1d9` | `apps/server/test/unit/api/routes/feature-flags-internal.test.ts` | modified (hop collapse) | 30 → 22 | Core's handler bodies driven through `/super-admin/feature-flags*` with a super-admin JWT; actor is the authenticated admin, never a body `updated_by`; UUID ids; fixture copies of `whatsapp_personal` / `prewarm_ring_delay_ms` where a flag shape is needed. Core's `audit_logs` row asserted for ACCOUNT scope only (route change, see the route row). PostHog assertions removed. Deleted 8: 'API-key cache invalidation wiring' (3, decision #5); 'Internal S2S — provider concurrency control plane' (5, moved to `super-admin-accounts`) |
| core `test/integration/flows/feature-flag-rollout.test.ts@4850d1d9` | `apps/server/test/integration/flows/feature-flag-rollout.test.ts` | modified (hop collapse) | 4 → 4 | Writes through the real super-admin routes as a real `super_admins` row; reads through `GET /feature-flags`; real test Redis; UUID ids; `whatsapp_personal` → `agency_dialer_enabled`, the never-leaks case checks `agency_late_binding` |

### A.4 Modifications made in the resumed run (each with its test)

| Where | Change | Why | Test |
|---|---|---|---|
| `user.routes.ts` `POST /invite`, `PUT /:id/role` (×2), `DELETE /:id/membership`; `invites.routes.ts` `POST /resend` | `request.membership && !canManage…(…)` → `!request.membership \|\| !canManage…(…)` | Master skipped the caller-role comparison when `request.membership` was absent and relied on `requirePermission` (which runs first) to have refused already. Agency fails closed at the check itself. Behaviour with a membership is unchanged | `test/unit/api/routes/membership-fail-closed.test.ts` (4 fail-closed + 3 equivalence; reverting the change fails exactly the 4), integration `invite-security-audit` (g) shows the real chain refuses first |
| `super-admin.routes.ts` `PUT …/accounts/:accountId/concurrency` | an unexpected throw now writes `update_account_concurrency_failed` (status 500) before answering 500 | Master wrote that row for every core non-2xx, a 500 included (`super-admin.routes.ts:1522-1527`); the first port answered 500 without it | `super-admin-accounts` "an unexpected throw in the in-process half answers 500 and writes master's failed-audit row" |
| `super-admin-account-settings.routes.ts` PUT; `account-settings.repository.ts` | Toggles written by NEW `setRecordingAnalysisToggles` (COALESCE on `allow_recording` / `analyze_calls` only), not core's `getMaxConcurrentCalls` then `upsert({ max_concurrent_calls })` | In legacy_total mode `upsert` rewrites the limit and bumps its version, so a concurrency PUT landing between the read and the upsert was silently undone past the version lock (core had the same race through a 60s cache). Authorised by the lead | `account-settings-toggles-writer` (5, the first reproduces the race on the old pattern), `super-admin-account-settings` "writes toggles through the toggles-only writer and never reads or writes concurrency", D10 writer-callers guard |
| `packages/db/src/repositories/account-settings.repository.ts` | NEW `setWebrtcMaxDurationSeconds` (authorised by the lead: that column only, TtlCache write-through) | Writer half of the plan §3.2 column; the route enforces 60..14400 | `packages/db/test/integration/repositories/account-settings-webrtc-writer.test.ts` (4) |
| `apps/server/test/unit/audit/platform/audit-actor-call-sites.test.ts` | "finds the audited call sites at all": floor **4** (master ≥ 29) | Lane A's audited writers are `user.routes.ts` (2) and `invites.routes.ts` (2), the same counts as master's files. The super-admin routes write `super_admin_audit_log` through `superAdminAuditRepository`, not `platformAuditLogger`, so they add no site. Master's other 25: agency routes (18, Phase 8: agent 8, campaigns 6, staffing 2, dnc 2) and AI scheduling (10, not ported) — the agency routes (Phase 8) raise the floor to 22; lane B2 ports no audited route | the case itself |

### A.5 Source tests not ported (lane A scope)

| Source | Cases | Reason |
|---|---|---|
| master `test/unit/api/routes/record-cache-invalidation.wiring.test.ts` | 11 | Every case drives a deleted route: `PUT /tenants/:id` (3), `PUT/DELETE /accounts/:id` (4), super-admin `PUT /tenants/:id/settings` (2), `DELETE /super-admin/tenants/:id` (2) |
| master `test/unit/notifications/engine/campaign-gate.test.ts` | 37 | `engine/campaign-gate.ts` is NOT ported, although A.1 planned it. Its only importers are the broadcast-campaign mailers `job-completion.ts` / `job-dispatched.ts` (deleted, plan §3.5). `agency-campaign-completion.ts` names it only in comments. A.1 and A.2 record it as not ported |
| master `test/unit/notifications/job-completion.test.ts` | 5 | Broadcast campaign mailer, deleted (plan §3.5) |
| master `test/unit/notifications/job-dispatched.test.ts` | 12 | Broadcast campaign mailer, deleted (plan §3.5) |
| master `test/unit/notifications/slack-webhook.client.test.ts` | 4 | Slack client, deleted with the digest/job mailers |
| master `test/unit/notifications/digest/run-digests.test.ts` | 69 | Credits usage digest runner, deleted (plan §3.3/§3.5) |
| master `test/unit/notifications/digest/usage-digest.test.ts` | 45 | Credits usage digest, deleted |
| master `test/unit/notifications/templates/usage-digest.template.test.ts` | 85+ (two `it.each` tables built by `.map`, unresolved) | Credits usage digest template, deleted |
| master `test/integration/repositories/usage-digest.repository.test.ts` | 47 | Usage-digest repository, deleted with the digest |
| master `test/unit/api/routes/super-admin-usage.test.ts` | 77 | Credits/fleet usage proxied from core. Replaced by NEW `super-admin-usage-counts` |
| master `test/integration/api/super-admin-usage.test.ts` | 35 | As above |
| master `test/unit/api/routes/super-admin-credits.test.ts` | 36 | Credits routes deleted (plan §3.3, S6) |
| master `test/unit/api/routes/super-admin-alerts.test.ts` | 28 | `super-admin-alerts.routes.ts` is not ported. Every endpoint (`/alerts/catalog`, `/alerts/voice*`, `/alerts/channels*`, `/alerts/definitions`) forwards to core through `coreInternalRequest`. Listed as deleted in A.2; not in A.1's kept list |
| master `test/unit/api/routes/super-admin-bulk-dispatch-jobs.test.ts` | 31 | Bulk dispatch (AI broadcast) not in agency |
| master `test/unit/api/routes/super-admin-dispatch-lanes.test.ts` | 17 | Bulk-dispatch lanes not in agency |
| master `test/unit/api/routes/super-admin-sip.test.ts` | 15 | SIP not in agency |
| master `test/unit/api/routes/super-admin-telephony.test.ts` | 50 | Telephony-provider CRUD deleted (one seeded VoiceLink provider, Decided #3) |
| master `test/unit/api/routes/phone-cache-invalidation.wiring.test.ts` | 19 | Wiring of `invalidatePhoneCacheFor*` in `super-admin-phone.routes.ts` and the tenant tagging routes. Those helpers (master's `/proxy` phone-resolution cache) and the tagging route are deleted |
| master `test/integration/cache/phone-cache-invalidation.test.ts` | 6 | As above (proxy phone-resolution cache) |
| master `test/unit/cache/metadata-cache.test.ts` | 18 | `cache/metadata-cache.ts` deleted (AI `/proxy/metadata` cache) |
| master `test/integration/cache/metadata-cache-invalidation.test.ts` | 4 | As above (service-settings writers that bust it are deleted too) |
| master `test/integration/cache/metadata-transfer-providers.test.ts` | 11 | Escalation-transfer metadata filter: AI escalation plus the metadata cache |
| master `test/integration/cache/governance-cache.test.ts` | 2 | Governance replaced by the per-account settings row (plan §3.2) |
| master `test/unit/governance/auth-governance.test.ts` | 5 | `/auth/session` and `/auth/me` `governance` map. Replaced by `settings`; covered by integration `auth.routes` and unit `agency-account-settings` |
| master `test/unit/governance/super-admin-governance.routes.test.ts` | 12 | Super-admin governance routes not ported (plan §3.2) |
| master `test/unit/auth/api-key-caller.test.ts` | 8 | No platform API keys (decision #5) |
| master `test/unit/auth/api-key-route-blocks.test.ts` | 28 | As above |
| master `test/unit/auth/api-key-scopes.test.ts` | 27 | As above |
| master `test/integration/api/api-key.routes.test.ts` | 12 | As above |
| master `test/integration/api/platform-api-key-auth.test.ts` | 22 | As above |
| master `test/unit/auth/s2s-token.test.ts` | 34 | No S2S peer |
| master `test/unit/db/repositories/tenant-core-credential.repository.test.ts` | 5 | Per-tenant core API key store; no core service |
| master `test/unit/services/core-account-settings-sync.service.test.ts` | 16 | Master → core settings sync; the account/tenant routes no longer import it, and there is no core |
| master `test/unit/api/validators/account.validator.test.ts` | 16 | `account.validator.ts` deleted with `POST/PUT /accounts` |
| master `test/unit/api/validators/tenant.validator.test.ts` | 9 | `tenant.validator.ts` deleted with `PUT /tenants/:id` |
| core `test/unit/api/routes/account-settings.test.ts` | 19 | Core's tenant-facing `GET/PUT /api/v1/account-settings` is not ported. Its PUT body lives on in `super-admin-account-settings.routes.ts`, whose suite is NEW (no source) |
| core `test/integration/api/account-settings.routes.test.ts` | 18 | As above |

## Lane B — domain and data

### Lane B1 — core's agency domain, repository and the DNC collapse (branch `lane-b1/domain-data`)

Sources: core `magic-voice-core@4850d1d9` (v1.123.2), master `magick-master@a1f0756a` (v3.24.0). Paths are
relative to each repo.

#### Source inventory

| Source | Destination | Kind | Reason |
|---|---|---|---|
| core `src/agency/abandonment-predicate.ts@4850d1d9` | `packages/domain/src/abandonment-predicate.ts` | verbatim | leaf (no imports); importers use `@magick-agency/domain/abandonment-predicate` |
| core `src/agency/keyset-cursor.ts@4850d1d9` | `packages/domain/src/keyset-cursor.ts` | verbatim | leaf; importers use `@magick-agency/domain/keyset-cursor` |
| core `src/agency/rates.ts@4850d1d9` | `packages/domain/src/rates.ts` | verbatim | leaf; importers use `@magick-agency/domain/rates` |
| core `src/agency/retry-campaign-bounds.ts@4850d1d9` | `packages/domain/src/retry-campaign-bounds.ts` | verbatim | leaf; importers use `@magick-agency/domain/retry-campaign-bounds` |
| core `src/agency/retry-summary.ts@4850d1d9` | `packages/domain/src/retry-summary.ts` | modified (import) | leaf (contracts only; import re-pointed); importers use `@magick-agency/domain/retry-summary` |
| core `src/agency/success-disposition.ts@4850d1d9` | `packages/domain/src/success-disposition.ts` | verbatim | leaf; importers use `@magick-agency/domain/success-disposition` |
| core `src/agency/timers.ts@4850d1d9` | `packages/domain/src/timers.ts` | verbatim | leaf; importers use `@magick-agency/domain/timers` |
| core `src/agency/agent-record.ts@4850d1d9` | `apps/server/src/agency/agent-record.ts` | modified (imports) | non-leaf (imports the agency model, or a non-leaf module); `./contracts.js` → `@magick-agency/contracts/agency`, logger → `@magick-agency/observability`, `webrtc-call.model` → `@magick-agency/db/models/agency-call.model`, leaves → `@magick-agency/domain/*` |
| core `src/agency/calling-hours.ts@4850d1d9` | `apps/server/src/agency/calling-hours.ts` | modified (imports) | non-leaf (imports the agency model, or a non-leaf module); `./contracts.js` → `@magick-agency/contracts/agency`, logger → `@magick-agency/observability`, `webrtc-call.model` → `@magick-agency/db/models/agency-call.model`, leaves → `@magick-agency/domain/*` |
| core `src/agency/campaign-config.ts@4850d1d9` | `apps/server/src/agency/campaign-config.ts` | modified (imports) | non-leaf (imports the agency model, or a non-leaf module); `./contracts.js` → `@magick-agency/contracts/agency`, logger → `@magick-agency/observability`, `webrtc-call.model` → `@magick-agency/db/models/agency-call.model`, leaves → `@magick-agency/domain/*` |
| core `src/agency/campaign-health.ts@4850d1d9` | `apps/server/src/agency/campaign-health.ts` | modified (imports) | non-leaf (imports the agency model, or a non-leaf module); `./contracts.js` → `@magick-agency/contracts/agency`, logger → `@magick-agency/observability`, `webrtc-call.model` → `@magick-agency/db/models/agency-call.model`, leaves → `@magick-agency/domain/*` |
| core `src/agency/campaign-series.ts@4850d1d9` | `apps/server/src/agency/campaign-series.ts` | modified (imports) | non-leaf (imports the agency model, or a non-leaf module); `./contracts.js` → `@magick-agency/contracts/agency`, logger → `@magick-agency/observability`, `webrtc-call.model` → `@magick-agency/db/models/agency-call.model`, leaves → `@magick-agency/domain/*` |
| core `src/agency/disposition-policy.ts@4850d1d9` | `apps/server/src/agency/disposition-policy.ts` | modified (imports) | non-leaf (imports the agency model, or a non-leaf module); `./contracts.js` → `@magick-agency/contracts/agency`, logger → `@magick-agency/observability`, `webrtc-call.model` → `@magick-agency/db/models/agency-call.model`, leaves → `@magick-agency/domain/*` |
| core `src/agency/disposition.ts@4850d1d9` | `apps/server/src/agency/disposition.ts` | modified (imports) | non-leaf (imports the agency model, or a non-leaf module); `./contracts.js` → `@magick-agency/contracts/agency`, logger → `@magick-agency/observability`, `webrtc-call.model` → `@magick-agency/db/models/agency-call.model`, leaves → `@magick-agency/domain/*` |
| core `src/agency/outcome-classifier.ts@4850d1d9` | `apps/server/src/agency/outcome-classifier.ts` | modified (imports) | non-leaf (imports the agency model, or a non-leaf module); `./contracts.js` → `@magick-agency/contracts/agency`, logger → `@magick-agency/observability`, `webrtc-call.model` → `@magick-agency/db/models/agency-call.model`, leaves → `@magick-agency/domain/*` |
| core `src/agency/retry-policy.ts@4850d1d9` | `apps/server/src/agency/retry-policy.ts` | modified (imports) | non-leaf (imports the agency model, or a non-leaf module); `./contracts.js` → `@magick-agency/contracts/agency`, logger → `@magick-agency/observability`, `webrtc-call.model` → `@magick-agency/db/models/agency-call.model`, leaves → `@magick-agency/domain/*` |
| core `src/agency/spine-filters.ts@4850d1d9` | `apps/server/src/agency/spine-filters.ts` | modified (imports) | non-leaf (imports the agency model, or a non-leaf module); `./contracts.js` → `@magick-agency/contracts/agency`, logger → `@magick-agency/observability`, `webrtc-call.model` → `@magick-agency/db/models/agency-call.model`, leaves → `@magick-agency/domain/*` |
| core `src/agency/dnc-registry.ts@4850d1d9` | `apps/server/src/agency/dnc-registry.ts` | modified (collapse, B8) | see DNC section |
| core `src/agency/dnc-mark.ts@4850d1d9` | `apps/server/src/agency/dnc-mark.ts` | modified (collapse, B8) | see DNC section |
| core `src/db/models/agency.model.ts@4850d1d9` | `apps/server/src/db/models/agency.model.ts` | modified | `sip_connection_id` removed from `AgencyCampaignRecord` and `AgencyCampaignConfigColumns` (column gone from the baseline); imports re-pointed (decision B12 path) |
| core `src/db/repositories/agency.repository.ts@4850d1d9` | `apps/server/src/db/repositories/agency.repository.ts` | modified | see "Repository changes" |
| master `src/dnc/dnc.repository.ts@a1f0756a` | `apps/server/src/dnc/dnc.repository.ts` | modified (B8) | sync state, versions, `bumpVersion`, `listTenantWidePhones`, `hasTenantWideEntry`, `readSnapshot`, `markPublished*`, `findStaleTenants`, `readLagSummary`, `findSyncState` removed (no `dnc_sync_state` in the baseline, no flat set). `insertMany` takes an optional caller `client` (joins the caller's transaction). `deleteById` is one `DELETE` statement. `findSuppressed`, `list`, `findById`, `dncScopeUuid`, `dncScopeLabel`, `SCOPE_SENTINEL`, `UQ_DNC_SCOPE_TARGET` verbatim. `isTenantWide` now exported. |
| master `src/dnc/dnc.service.ts@a1f0756a` | `apps/server/src/dnc/dnc.service.ts` | modified (B8) | the two `dncSyncService.publish` calls and the `syncVersion` log field removed; everything else verbatim |
| master `src/utils/phone-normalizer.ts@a1f0756a` | `apps/server/src/utils/phone-normalizer.ts` | verbatim | `dnc.service` needs `E164_REGEX`. **Possible collision with lane A/B2**: if either ports it too the content is identical (path rule) |
| core `src/agency/attempt-batch-reference.ts@4850d1d9` | — | deleted | billing batch key; its only non-billing user, the repository, imported just the `AgencyAttemptHourBucket` type for the sweep below |
| core `agency.repository.ts` — `AgencyAttemptBatchRepository` (`hourlyBuckets`) and the `agencyAttemptBatchRepository` export | — | deleted | the billing sweep's query (hourly dial counts); the only method behind `AgencyAttemptHourBucket`. `idx_agency_attempts_billing` stays in the baseline (kept for metering, plan §3.3) |
| core `src/agency/{attempt-batcher,dnc-outbox,dnc-resync}.ts`, `agency-s2s-contract.fixture.json`, `src/db/{models/agency-dnc-outbox.model,repositories/agency-dnc-outbox.repository}.ts` | — | deleted / not ported | billing; the outbox forwarder and set resync (B8); the S2S fixture retires. The `agency_dnc_outbox` TABLE stays in the baseline for the Phase 10 rollback mirror; nothing writes it, so the outbox repository/model are not needed yet |
| master `src/dnc/{dnc-sync.service,dnc-sync.client}.ts` | — | not ported | master→core sync (B8) |

Phase 6 (runtime, not mine): `pacing-engine`, `agency-dialer`, `dial-dispatcher`, `station-registry`, `station-token`, `reaper`, `wrapup-manager`, `break-manager`, `runtime`, `abandonment-guardrail`, `abandonment-metrics`, `live-concurrency-metrics`, `abandon-clip`, `pre-dial-gates`, `agent-state-machine`. `contracts.ts` is `@magick-agency/contracts/agency`.

**Leaf / non-leaf split.** Leaf (→ `packages/domain/src`): abandonment-predicate, keyset-cursor, rates, retry-campaign-bounds, retry-summary, success-disposition, timers. Non-leaf (→ `apps/server/src/agency`): agent-record (→ spine-filters), calling-hours (type import of the agency model), campaign-config (→ calling-hours), campaign-health (model), campaign-series (→ agent-record, spine-filters), disposition (model), disposition-policy (→ retry-policy), outcome-classifier (call model), retry-policy (model), spine-filters (→ disposition-policy), dnc-mark, dnc-registry.

#### Repository changes (every one is a changed SQL statement or a deletion)

| Where | Change | Reason | Test |
|---|---|---|---|
| `AgencyCampaignRepository.create` | `sip_connection_id` column + `$6` removed; placeholders renumbered `$1..$20`; `COALESCE($5,'vobiz')` → `'voicelink'` | SIP deleted (baseline has no column); VoBiz deleted, baseline default is `voicelink` | `agency-campaign-create` (real PG), `campaign-insert-param-types` (typing rule) |
| `AgencyCampaignRepository.retryFromCampaign` | same: column and bind removed, `$1..$25` | same | `agency-retry-seeding`, `agency-retry-idempotency` (real PG) |
| `AgencyCampaignRepository.update` | `sip_connection_id` removed from the allow-list | same | `campaign-config` unit suites |
| `AgencyAgentSessionRepository.recordTransitions` | `UNNEST($1::uuid[], $2::varchar[], $3::varchar[], $4::uuid[], $5::varchar[], …)` → `$2::uuid[], $3::uuid[], $5::uuid[]` | baseline types `tenant_id`/`account_id`/`agent_user_id` UUID (core: VARCHAR); the varchar array is `42804` against a uuid column. **Found only by real Postgres** (`agent-transition-ordering`); the mocked-pool suites could not see it | `agent-transition-ordering`, `agent-session-events` |
| `AgencyAgentStatsRepository` (3 statements: `attemptBuckets`' sessions CTE, both occupancy event reads) | `agent_user_id = ANY($1::text[])` → `ANY($1::uuid[])` | same: `uuid = text` has no operator. **Behaviour note**: a non-UUID agent id now throws `22P02` instead of matching nothing; the route layer (Phase 8) validates the id as a UUID before it reaches here | `agent-record-tenant-isolation`, `agent-occupancy-window`, `agent-window-boundaries`, `repository-sql-coverage` |
| `AgencyAttemptBatchRepository` | deleted | billing | — |

No predicate that authorises (tenant/account scoping, the reserved-agent / `on_behalf` check, DNC/`suppressed_reason` filters in `claimDialable`/`suppressByPhone`, the `uq_dnc` conflict targets) was touched. A line-by-line diff of the repository against core, with comments stripped, shows exactly the changes in this table plus import specifiers.

**Every method on real Postgres.** The 22 integration files that exercise the repository plus `repository-sql-coverage.test.ts` (new, 11 cases) run all 68 public repository methods (instrumented: 39 reached by the ported suites, the remaining 29 by the coverage file) at least once. (Lead, after the Fable review: `countForCampaign` and `findByRetryIdempotencyKey` were reached only by the mocked unit suite; the coverage file's 11th case runs both, scoped.) The coverage file asserts the returned values, including that another tenant/account sees nothing.

#### DNC collapse (decision B8)

| Piece | Behaviour now |
|---|---|
| `DncRegistry.check(tenantId, phone, scope)` | One indexed read of `dnc_entries` via `DncRepository.findSuppressed` (same predicate the roster ingest uses; `idx_dnc_entries_tenant_phone`). Result union unchanged: `clear | suppressed | unverifiable | unavailable`. **Any rejected read (DB error, no pool) is `unavailable`, never `clear`**; `pre-dial-gates` turns that into a `halt`. Constructor is `new DncRegistry(repo?)` (core: `(redis, keyPrefix, onUnsynced)`); `applyDelta`, `applyReplace`, `appliedVersion`, the Lua scripts, `DncSyncResult`, `DncDelta`, `DncReplace` and `DNC_SYNC_BATCH` are gone; `normalizeE164` verbatim |
| scope argument | **Required**: `scope: { accountId: string \| null; campaignId: string \| null }` (null = tier not checked). A caller that forgets it fails to compile. Widening matches master's `findSuppressed`: tenant-wide row, or account row for that account, or campaign row for that campaign |
| `markDnc` (core `markDncOnMaster`) | Writes `dnc_entries` directly via `DncRepository.insertMany`: campaign scope when `campaignId` given, tenant-wide when omitted; `accountId` or the nil-UUID sentinel is refused (`refused: 'invalid_dnc_scope'`, nothing written). One transaction; with `deps.client` it joins the caller's transaction and throws on failure so the caller rolls back. Returns `written: { campaign_id }` read from the ROW. `forwardDncMark`, `resolveDncOutboxRow`, the backoff ladder, `DNC_OUTBOX_MAX_ATTEMPTS`, `MASTER_SCOPE_MISMATCH` detection are gone. **Not composable with `suppressByPhone`'s own transaction** (kept verbatim); Phase 8 decides whether to wrap both on one client |

**How core enforced account- and campaign-scoped DNC** (so none of it is lost): (1) at **ingest**, master's `agency-ingest.service.ts:261` `dncService.filterSuppressed` (lane B2) over all three scopes; (2) at **mark**, core `agency.routes.ts` `POST /attempts/:id/dnc` calls `suppressByPhone` (`agency.repository.ts` core `:3170`, ported verbatim here) which marks EVERY roster row in the campaign carrying the number `suppressed`/`dnc`, unconditionally, in both scopes (route: Phase 8, comment block at core `agency.routes.ts:969-1011`); (3) at **claim**, `claimDialable` excludes `suppressed_reason = 'dnc'` (core `agency.repository.ts:2795`, `IS DISTINCT FROM 'dnc'`, verbatim); and `markState` refuses to move a DNC suppression (core `:2990`, verbatim, `dnc-resurrection`). Core's dial-time Redis check covered **tenant-wide only** (core `dnc-registry.ts` header, "documented v1 simplification"). The new check additionally covers account and campaign rows, so scoped DNC now also stops a dial at the gate. Real-Postgres tests: `integration/agency/dnc-registry.test.ts` (a campaign-scoped entry and an account-scoped entry each block the dial; another account/campaign/tenant is untouched; a malformed tenant id is a real `22P02` and yields `unavailable`).

**REQUIRED change for Phase 6 (`pre-dial-gates.ts:182`)**: `deps.dnc.check(campaign.tenant_id, contact.phone_e164)` must become `deps.dnc.check(campaign.tenant_id, contact.phone_e164, { accountId: campaign.account_id, campaignId: campaign.id })`. The old two-argument call no longer compiles. `AgencyRuntime` must construct `new DncRegistry()` (core: `new DncRegistry(redis, keyPrefix, createDncResyncRequester())`). `PacingEngine`'s `DncRegistry` type import is unchanged.

#### Test classification (every core agency test file)

`it(` = source count of `it(`/`test(` calls (comments stripped; `it.each` blocks counted separately as `each`; loop-generated cases are in the printed counts). Ported = the count Vitest prints for the destination.

**Unit — 86 files**

| Source file | it( / each | Class | Destination / reason | Ported |
|---|---|---|---|---|
| `abandon-clip` | 16 / 0 | Phase 6 | runtime module under test | — |
| `abandon-clip-cache-roundtrip` | 5 / 0 | Phase 6 | runtime module under test | — |
| `abandon-reason-telemetry` | 26 / 0 | Phase 6 | runtime module under test | — |
| `abandoned-call-path` | 16 / 0 | Phase 6 | runtime module under test | — |
| `abandonment-guardrail` | 22 / 1 | Phase 6 | runtime module under test | — |
| `abandonment-metrics` | 21 / 0 | B1 (partial) | `apps/server/test/unit/agency/abandonment-window.test.ts`; 17 predicate/window cases + 2 independence-lock cases; the metrics-registry groups are Phase 6 | 19 |
| `abandonment-otlp-export` | 11 / 0 | Phase 6 | runtime module under test | — |
| `agency-analysis-flag-backfill` | 21 / 0 | deleted | migration 107's seed of `feature_flag_overrides` (DML, not carried); the flag service is the lead's (§4) and `registry-contracts.test.ts` pins `agency_call_analysis` | — |
| `agency-call-read-routes` | 19 / 2 | Phase 8 | route handler under test | — |
| `agency-dialer` | 28 / 0 | Phase 6 | runtime module under test | — |
| `agency-dialer-lineage` | 5 / 0 | Phase 6 | runtime module under test | — |
| `agency-internal-auth` | 5 / 0 | Phase 8 | route handler under test | — |
| `agency-internal-ingest-ownership` | 7 / 1 | Phase 8 | route handler under test | — |
| `agency-join-result` | 7 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 7 |
| `agency-repository` | 43 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 43 |
| `agent-attempts-repository` | 9 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 9 |
| `agent-grouped-repository` | 62 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 62 |
| `agent-record` | 102 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 102 |
| `agent-record-routes` | 56 / 0 | Phase 8 | route handler under test | — |
| `agent-roster-repository` | 55 / 0 | B1 (modified) | `apps/server/test/unit/agency/`; two assertions: `ANY($1::text[])` → `ANY($1::uuid[])` (UUID agent ids) | 55 |
| `agent-session-events` | 20 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 20 |
| `agent-state-machine` | 15 / 0 | Phase 6 | runtime module under test | — |
| `agent-stats-repository` | 36 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/`; source count includes loop-generated cases | 38 |
| `attempt-batcher` | 30 / 0 | deleted | billing (hourly attempt-batch settlement), plan §2 | — |
| `break-manager` | 18 / 0 | Phase 6 | runtime module under test | — |
| `calling-hours` | 31 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 31 |
| `campaign-abandon-config-route` | 8 / 0 | Phase 8 | route handler under test | — |
| `campaign-analysis-profile-route` | 13 / 0 | Phase 8 | route handler under test | — |
| `campaign-config-route` | 21 / 0 | Phase 8 | route handler under test | — |
| `campaign-conversion-stats` | 9 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 9 |
| `campaign-health` | 19 / 0 | B1 (modified) | `apps/server/test/unit/agency/`; `credits_low` / `AGENCY_CORE_STALL_CODES` assertion re-pointed at `AGENCY_STALL_PRIORITY`; `sip_connection_id` fixture field removed | 19 |
| `campaign-insert-param-types` | 3 / 0 | B1 (modified) | `apps/server/test/unit/agency/`; column types read off the baseline; INSERT has 20 columns (was 21) | 3 |
| `campaign-lifecycle-route` | 7 / 0 | Phase 8 | route handler under test | — |
| `campaign-lifecycle-timestamps` | 19 / 0 | B1 (partial) | `apps/server/test/unit/agency/`; 7 `formatAgencyCampaignResponse` cases deferred to Phase 8 (route formatter) | 12 |
| `campaign-retry-repository` | 19 / 0 | B1 (modified) | `apps/server/test/unit/agency/`; `sip_connection_id` fixture field removed | 19 |
| `campaign-retry-route` | 31 / 4 | Phase 8 | route handler under test | — |
| `campaign-series-parse` | 13 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 13 |
| `campaign-start-roster-route` | 16 / 0 | Phase 8 | route handler under test | — |
| `campaign-stats-concurrency-guard-route` | 2 / 0 | Phase 8 | route handler under test | — |
| `campaign-stats-contract` | 13 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 13 |
| `campaign-stats-series` | 22 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 22 |
| `campaign-stats-series-route` | 15 / 0 | Phase 8 | route handler under test | — |
| `canceled-outcome-ledger` | 11 / 0 | Phase 6 | runtime module under test | — |
| `dial-dispatcher` | 7 / 0 | Phase 6 | runtime module under test | — |
| `disposition` | 19 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 19 |
| `disposition-policy` | 28 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/`; `it.each` rows expanded | 90 |
| `disposition-route` | 37 / 0 | Phase 8 | route handler under test | — |
| `dnc-mark-route` | 38 / 0 | Phase 8 | route handler under test | — |
| `dnc-outbox` | 41 / 0 | deleted | the outbox forwarder/sweeper and its metrics; the mark no longer forwards (B8) | — |
| `dnc-registry` | 23 / 0 | B1 (rewritten) | `apps/server/test/unit/agency/`; Redis set deleted; 3 `normalizeE164` cases verbatim + 6 for the DB-backed check (see file header) | 9 |
| `dnc-resurrection` | 12 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 12 |
| `dnc-resync` | 19 / 0 | deleted | master→core resync of the Redis set; the set is gone (B8) | — |
| `dnc-sync-route` | 23 / 0 | deleted | `POST /internal/agency/dnc-sync` — the sync route; the set is gone (B8) | — |
| `dnc-synced-dual-emit` | 8 / 0 | deleted | the `agency_dnc_synced` gauge (set-sync health); no set, no gauge (B8) | — |
| `exhaustion-completion` | 19 / 0 | Phase 6 | runtime module under test | — |
| `hangup-route` | 10 / 0 | Phase 8 | route handler under test | — |
| `keyset-cursor` | 6 / 1 | B1 (verbatim (paths)) | `packages/domain/test/unit/agency/`; `it.each` rows expanded | 9 |
| `late-binding` | 30 / 0 | Phase 6 | runtime module under test | — |
| `left-session-guards` | 26 / 0 | Phase 8 | route handler under test | — |
| `live-concurrency-metrics` | 19 / 0 | Phase 6 | runtime module under test | — |
| `live-concurrency-repository` | 8 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 8 |
| `our-fault-redial` | 20 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 20 |
| `outcome-classifier` | 31 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/`; `it.each` rows expanded | 45 |
| `pacing-engine` | 62 / 1 | Phase 6 | runtime module under test | — |
| `pacing-engine-gates` | 22 / 0 | Phase 6 | runtime module under test | — |
| `pre-dial-gates` | 20 / 0 | Phase 6 | runtime module under test | — |
| `presence-resilience` | 16 / 0 | Phase 6 | runtime module under test | — |
| `profile-in-use-reference-check` | 23 / 0 | Phase 8 | route handler under test | — |
| `reaper` | 41 / 0 | Phase 6 | runtime module under test | — |
| `retry-campaign-bounds` | 4 / 0 | B1 (verbatim (paths)) | `packages/domain/test/unit/agency/` | 4 |
| `retry-lineage-migrations` | 16 / 3 | deleted | pins the text of migrations 111-114 (expand-only, down commented, idempotent); the build ships one baseline migration. The columns/trigger/index are covered by `agency-retry-seeding` and the baseline tests | — |
| `retry-policy` | 21 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 22 |
| `retry-selector-parse` | 18 / 4 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/`; `it.each` rows expanded | 34 |
| `retry-summary` | 9 / 2 | B1 (verbatim (paths)) | `packages/domain/test/unit/agency/`; `it.each` rows expanded | 19 |
| `roster-row-identity` | 19 / 0 | B1 (partial) | `apps/server/test/unit/agency/`; 3 repository-vs-baseline cases kept; 16 migration-text cases deleted | 3 |
| `s2s-contract` | 24 / 0 | deleted | core↔master S2S contract fixture; S2S retires (plan §1). The 18 error codes live in `packages/contracts/test/errors.test.ts` | — |
| `session-join-conflict-route` | 13 / 0 | Phase 8 | route handler under test | — |
| `spine-filters` | 26 / 2 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/`; `it.each` rows expanded | 34 |
| `spine-read-routes` | 16 / 1 | Phase 8 | route handler under test | — |
| `station-heartbeat-grace` | 19 / 0 | Phase 6 | runtime module under test | — |
| `station-reconnect-frame` | 4 / 0 | Phase 8 | route handler under test | — |
| `station-registry` | 29 / 0 | Phase 6 | runtime module under test | — |
| `station-supersede-stomp` | 10 / 0 | Phase 6 | runtime module under test | — |
| `station-token` | 5 / 0 | Phase 6 | runtime module under test | — |
| `supervisor-stats` | 26 / 0 | B1 (verbatim (paths)) | `apps/server/test/unit/agency/` | 26 |
| `wrapup-manager` | 34 / 0 | Phase 6 | runtime module under test | — |

B1 unit total: 850 cases in 33 source files (31 in `apps/server`, 3 in `packages/domain` = 32 cases there). Deleted 8, Phase 6: 25, Phase 8: 20 (33+8+25+20 = 86).

**Integration — 41 entries (30 `*.test.ts`, `agency-factories.ts`, `chaos/` with 9 tests + harness)**

| Source file | it( / each | Class | Destination / reason | Ported |
|---|---|---|---|---|
| `agency-agent-cas` | 6 / 0 | Phase 6 | runtime/pacing/reaper under test | — |
| `agency-agent-state-cycle` | 1 / 0 | Phase 6 | runtime/pacing/reaper under test | — |
| `agency-analysis-profile-reference-check` | 8 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids | 8 |
| `agency-campaign-create` | 3 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids; provider default `voicelink`; `sip_connection_id` assertion removed | 3 |
| `agency-campaign-stats` | 18 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids | 18 |
| `agency-campaign-stats.routes` | 7 / 0 | Phase 8 | route under test | — |
| `agency-context-ordering` | 9 / 0 | Phase 6 | runtime/pacing/reaper under test | — |
| `agency-conversion-counting` | 12 / 1 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids; `it.each` rows expanded | 18 |
| `agency-crash-recovery` | 6 / 0 | Phase 6 | runtime/pacing/reaper under test | — |
| `agency-dnc-campaign-scope` | 10 / 0 | B1 (verbatim (paths)) | `apps/server/test/integration/agency/` | 10 |
| `agency-dnc-mark-route` | 4 / 0 | Phase 8 | route under test | — |
| `agency-dnc-outbox` | 15 / 0 | deleted | outbox repository + forwarder tests (B8; table kept, nothing writes it) | — |
| `agency-dnc-resurrection` | 12 / 0 | B1 (verbatim (paths)) | `apps/server/test/integration/agency/` | 12 |
| `agency-dnc-runtime-wiring` | 1 / 0 | Phase 6 | runtime/pacing/reaper under test | — |
| `agency-double-reservation` | 9 / 0 | Phase 6 | runtime/pacing/reaper under test | — |
| `agency-duplicate-dial` | 11 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids; raw SQL literals bound to the shared tenant/account | 11 |
| `agency-gate-skip-logging` | 2 / 0 | Phase 6 | runtime/pacing/reaper under test | — |
| `agency-ingest-idempotency` | 13 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids | 13 |
| `agency-ingest-route-seam` | 7 / 1 | Phase 8 | route under test | — |
| `agency-join-rehydrate-db` | 13 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids (incl. generated agent/account ids) | 17 |
| `agency-lease-ring-duration` | 3 / 1 | Phase 6 | runtime/pacing/reaper under test | — |
| `agency-migration` | 13 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids; `webrtc_calls` → `agency_calls`; the plain call fixture passes `campaign_id: null` | 13 |
| `agency-migration-093-dedupe` | 15 / 0 | deleted | runs migration 093's dedupe UPDATE on populated tables; baseline has the end state and no data migrations | — |
| `agency-migration-104-105` | 12 / 1 | deleted | runs migrations 104/105 on populated tables; baseline creates the end state | — |
| `agency-migration-107-analysis-backfill` | 24 / 0 | deleted | migration 107's feature-flag seed (DML), not carried | — |
| `agency-reaper-sql` | 12 / 0 | Phase 6 | runtime/pacing/reaper under test | — |
| `agency-retry-idempotency` | 9 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids | 9 |
| `agency-retry-seeding` | 21 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids (raw SQL literals interpolated) | 21 |
| `agency-session-tenant-unique` | 11 / 0 | B1 (partial) | `apps/server/test/integration/agency/`; UUID ids; the 6 migration-093 cases deleted | 5 |
| `agency-spine-read` | 20 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids | 20 |
| `agent-grouped-read` | 14 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids | 14 |
| `agent-multi-session` | 7 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids | 7 |
| `agent-occupancy-window` | 8 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids | 8 |
| `agent-record-tenant-isolation` | 7 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids | 7 |
| `agent-stats-timezone-buckets` | 12 / 1 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids | 16 |
| `agent-transition-ordering` | 11 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids; needed the `recordTransitions` cast fix (see Repository SQL changes) | 11 |
| `agent-window-boundaries` | 11 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids | 11 |
| `campaign-stats-series` | 16 / 0 | B1 (modified) | `apps/server/test/integration/agency/`; UUID ids | 16 |
| `webrtc-call-scope-isolation` | 15 / 0 | already ported (lead, Phase 2b) | `packages/db/test/integration/agency/` (11 cases) | — |
| `agency-factories.ts` | — | B1 | `apps/server/test/integration/agency/agency-factories.ts`: UUID defaults, `voicelink`, UUID `agent_user_id`, harness DB URL | — |
| `chaos/abandonment-counter-vs-table` | 9 / 0 | Phase 6 | needs the dialer/pacing harness (`chaos/harness.ts`); its two §9 invariants are re-covered here by `abandonment-invariants` and `integration/agency/dnc-registry` | — |
| `chaos/abandonment-predicate-agreement` | 3 / 0 | Phase 6 | needs the dialer/pacing harness (`chaos/harness.ts`); its two §9 invariants are re-covered here by `abandonment-invariants` and `integration/agency/dnc-registry` | — |
| `chaos/attempt-number-collision` | 6 / 0 | Phase 6 | needs the dialer/pacing harness (`chaos/harness.ts`); its two §9 invariants are re-covered here by `abandonment-invariants` and `integration/agency/dnc-registry` | — |
| `chaos/dnc-self-heal-loop` | 3 / 0 | Phase 6 | needs the dialer/pacing harness (`chaos/harness.ts`); its two §9 invariants are re-covered here by `abandonment-invariants` and `integration/agency/dnc-registry` | — |
| `chaos/lease-renewer-killed` | 5 / 0 | Phase 6 | needs the dialer/pacing harness (`chaos/harness.ts`); its two §9 invariants are re-covered here by `abandonment-invariants` and `integration/agency/dnc-registry` | — |
| `chaos/network-drop-during-ring` | 7 / 0 | Phase 6 | needs the dialer/pacing harness (`chaos/harness.ts`); its two §9 invariants are re-covered here by `abandonment-invariants` and `integration/agency/dnc-registry` | — |
| `chaos/redis-expired-wholesale` | 8 / 0 | Phase 6 | needs the dialer/pacing harness (`chaos/harness.ts`); its two §9 invariants are re-covered here by `abandonment-invariants` and `integration/agency/dnc-registry` | — |
| `chaos/restart-mid-bridge` | 2 / 0 | Phase 6 | needs the dialer/pacing harness (`chaos/harness.ts`); its two §9 invariants are re-covered here by `abandonment-invariants` and `integration/agency/dnc-registry` | — |
| `chaos/roster-exactly-once` | 8 / 0 | Phase 6 | needs the dialer/pacing harness (`chaos/harness.ts`); its two §9 invariants are re-covered here by `abandonment-invariants` and `integration/agency/dnc-registry` | — |
| `chaos/harness.ts` | — | Phase 6 | the chaos world builds the real PacingEngine/AgencyDialer | — |

**Master DNC tests (module ported by B1)**

| Source file | it( | Class | Destination / reason | Ported |
|---|---|---|---|---|
| `test/unit/dnc/dnc.repository.test.ts` | 46 | B1 (partial) | `apps/server/test/unit/dnc/`. Deleted (sync): the 5 "sync version" cases, 4 `deleteById` version/survivor cases (replaced by 1 single-statement case), `readSnapshot` (2), publish watermark (4), `listTenantWidePhones` (2), `hasTenantWideEntry` (1), `readLagSummary` (6); "rolls back…" cases re-stated without a transaction. **+2 new (lead, after the Fable review)**: the `opts.client` path issues no BEGIN/COMMIT/ROLLBACK and no release, and propagates a failure | 25 |
| `test/unit/dnc/dnc.service.test.ts` | 28 | B1 (partial) | `apps/server/test/unit/dnc/`; the 7 "publishing to core" cases deleted | 21 |
| `test/integration/dnc/dnc-index-usage.test.ts` | 5 | B1 | `apps/server/test/integration/dnc/` (index is still the plan) | 5 |
| `test/integration/dnc/dnc-campaign-scope.test.ts` | 15 | B1 (partial) | the 5 `listTenantWidePhones` cases deleted (feed into the Redis set); version assertions dropped | 10 |
| `test/integration/dnc/dnc-scope-sentinel.test.ts` | 6 | B1 (partial) | the 2 hazard cases kept; 4 route-driven cases Phase 8 | 2 |
| `test/unit/dnc/{dnc-sync.client,dnc-sync.service,dnc.routes,internal-agency.routes}.test.ts` | — | deleted / Phase 8 | sync client/service deleted; routes Phase 8 | — |

**New tests (no source)**: `integration/agency/dnc-registry` (12: tenant-wide / account / campaign scope each block, other tenant clear, `markDnc` campaign and tenant escalation, sentinel/account refusals, unusable phone, **fail-closed on a real `22P02`** (a statement error; a pool-down / connection-refused fault takes the same `catch` and is covered by the unit stub "no database pool"), and — lead, after the Fable review — **`markDnc` with a caller's client: the caller's ROLLBACK removes the row; a failed statement rejects instead of reporting `recorded:false`**), `integration/agency/repository-sql-coverage` (11), `integration/agency/abandonment-invariants` (4: no back-fill of `answered_at`/`bridged_at`; SQL and in-process predicate agree on every shared arm incl. the exact grace boundary; the terminal filter is the SQL half's alone; the 24h window counts what the predicate counts).


#### Lead review notes (Fable review of `35b3a17`, session 2)

- **Rulings on the lane's open classifications.** `agency-analysis-flag-backfill` deleted: correct (7 cases pin migration 107's DML text, 14 pin the lead-owned flag service). `station-reconnect-frame`: deferred whole to Phase 8, not split (it drives the real station socket and `BreakRegistry`). Optional `insertMany` client: an additive change; an omitted client deliberately runs its own transaction (the supervisor DNC page); now tested.
- **Carried to Phase 6:** `pre-dial-gates.ts:182` must pass `{ accountId: campaign.account_id, campaignId: campaign.id }` (a required third parameter, so the old call won't compile).
- **Carried to Phase 8:** validate every id path/query param as a UUID at the schema and map `22P02` to 400 in the error handler as a backstop: tenant, account and agent ids are UUID columns now (core compared text and matched nothing). `markDnc({client})` cannot yet compose with `suppressByPhone` (`:3170`, its own connection), so B8's "same transaction as the attempt bookkeeping" is enabled, not achieved; parity with core holds (core also used two transactions). Phase 8 either threads a client through `suppressByPhone`/`markState` (a recorded modification) or records two transactions in `decisions.md`. The 7 `formatAgencyCampaignResponse` cases arrive with core `src/api/responses/agency-campaign.response.ts`.
- **Carried to Phase 10:** a tenant that has `agency_call_analysis` only through migration 107's seed loses analysis at cutover unless its `feature_flag_overrides` rows are copied.
- Cosmetic, left: `campaign-health.test.ts` fixture still says `telephony_provider: 'vobiz'` (pure module, no effect). Lead-owned, later: `0001_baseline.sql:583` comment still says `agency_campaigns` lives in core's database.

### Lane B2 — master's agency domain (branch `lane-b2/domain-master`)

Source: master `magick-master@a1f0756a` (v3.24.0); core `magic-voice-core@4850d1d9` for the hand-off handler. Paths relative to each repo.

#### Source inventory

| Source | Destination | Kind | Reason |
|---|---|---|---|
| master `src/agency/agency-csv.ts` | `apps/server/src/agency/agency-csv.ts` | verbatim | no imports |
| master `src/agency/agency-csv-ingest.ts` | same | verbatim | `csv-parse` added to `apps/server` (`^6.2.1`, master's major); `../utils/phone-normalizer.js` is B1's file on main |
| master `src/agency/agency-column-analysis.ts`, `agency-rejected-csv.ts`, `agency-ingest-keys.ts` | same | verbatim | |
| master `src/contact-lists/csv-parser.ts` | `apps/server/src/contact-lists/csv-parser.ts` | verbatim | the rest of `contact-lists/` (bulk dispatch) is not ported |
| master `src/agency/agency-campaign-config.ts`, `agency-campaign-wire.ts`, `agency-roster-errors.ts` | same | verbatim | no imports. `agency-roster-errors.ts` mirrors core's supersede refusal codes; it is a type-only file whose producer (supersede) does not exist, see "Roster hand-off" |
| master `src/agency/agency-spine.ts` | same | verbatim (preamble title modified by B17, §8.9) | `pageRows`, `forwardAllowedQuery`, CSV preamble, `enrichAttemptAgentNames` (pure; the name lookup is injected) |
| master `src/agency/agency-activity-actions.ts` | same | modified (imports) | `../audit/catalog.js` → `../audit/platform/catalog.js`, `../audit/vocabulary.js` → `../audit/platform/vocabulary.js` (Phase 2b paths) |
| master `src/agency/agency-activity.ts` | same | modified | imports re-pointed (`@magick-agency/db/models/platform/audit.model`, `../audit/platform/catalog.js`). **API-key actors deleted (decision #5):** `normalizeMasterRow` lost its third `apiKeyNames` parameter and `resolveMasterDisplay` its `actor_type === 'api_key'` branch; `actor.api_key_id` stays on the wire (`@magick-agency/contracts/api/agency` `ActivityActor` still declares it) and is always `null`; the CSV keeps its `actor_api_key_id` column (a fixed spreadsheet contract) and writes it empty. `ActivityActorType` = `'human' | 'system' | 'unknown'` (Q4) |
| master `src/agency/agency-ingest-job.repository.ts` | same | modified (import) | `../db/connection.js` → `@magick-agency/db`. SQL, constants and the widening-down tiers verbatim. The tiers' `42703` fallbacks are dead on the baseline (every column exists) and kept for verbatim; the first tier is the one that runs |
| master `src/agency/agency-roster.client.ts` | same | modified (collapse) | see "Roster hand-off" |
| master `src/agency/agency-actor.ts` | same | modified | RBAC from `@magick-agency/contracts/rbac`, error code from `@magick-agency/contracts/errors`. **API-key branch deleted (decision #5):** `isPlatformApiKeyCaller` (and its re-export from `auth/api-key-caller.ts`) and the `isPlatformApiKeyCaller(request) ? undefined : …` arm; `missing_actor`'s message no longer mentions keys |
| master `src/agency/agency-agent-identity.ts` | same | modified (imports) | `user.repository` / `agency-campaign-agent.repository` from `@magick-agency/db`, `ROLE_HIERARCHY`/`MembershipRole` from contracts rbac, logger from observability. Bodies verbatim |
| master `src/agency/agency-activity.service.ts` | same | modified (collapse, B7) | see "Activity service" |
| master `src/agency/agency-stats-enrichment.ts` | same | modified (credits removed, plan §2) | see "Stats enrichment" |
| master `src/agency/agency-ingest.service.ts` | same | modified (import) | logger → `@magick-agency/observability`; body verbatim (S3 imports resolve to the one module below). `startAgencyIngestReaper` / `AGENCY_INGEST_REAP_INTERVAL_MS` ported with it; boot wiring is Phase 6 (`bootstrap/agency.ts`) |
| master `src/storage/s3.ts:78-98` (`getFileStream`), `:115-130` (`headFile`) | `apps/server/src/storage/s3.ts` (lane C's port of core's, appended after `getPresignedUrl`) | modified (decision B14) | appended with their doc comments and a PORT NOTE; bodies verbatim except `getS3Client()` → `getClient()`, `s3Bucket!` → `audioBucket` (core's names for the same client and `config.s3.audioBucket`), and `headFile`'s `startTimer`/`stopTimer` → `process.hrtime` + `observe` (agency's instrument wrappers have no `startTimer`). Nothing else in the file touched; no new config key. Master's other S3 functions (`initS3Client` shape, `uploadFile`, `deleteFile`, `getFileBuffer`) are core's one module's equivalents or unused by B2 (`uploadFile` has the same signature) |
| master `src/utils/metrics.ts:457-469` (`s3_operations_total`, `s3_operation_duration_seconds`) | `packages/observability/src/metrics/agency.ts` (lane B's metrics file) | modified | same names, labels (`operation`,`status` / `operation`) and buckets; `unit: 's'` on the histogram per the repo's duration convention. Needed by the two appended functions; the platform overview dashboard charts both |

Not ported, with reasons:

| Source | Disposition | Reason |
|---|---|---|
| master `src/agency/agency-action-errors.ts` | deleted | the union is `@magick-agency/contracts/errors` (18 codes, Q2); nothing in B2 reads master's copy |
| master `src/agency/agency-attempt-settlement.repository.ts`, `agency-billing-contract.ts` | deleted | billing (plan §2) |
| master `src/agency/agency-s2s-contract.fixture.json` | deleted | S2S fixture retires (plan §1) |
| master `src/api/routes/internal-agency.routes.ts` | Phase 6/8, by function | core → master S2S consumers move in-process: `POST /internal/agency-ingest-jobs/*` ownership probes and attempt-completion hooks become direct calls in Phase 6/8; no B2 module reads it |
| master `src/api/routes/proxy-agency-*.routes.ts`, `api/routes/helpers/csv-attachment.ts`, `api/validators/agency-campaign-completion.validator.ts`, `api/middleware/error-mask.middleware.ts` | Phase 8 (the error mask: not ported, plan §1 one union) | routes |
| master `src/notifications/agency-campaign-completion.ts`, `notifications/engine/campaign-gate.ts` | lane A | |

#### Roster hand-off (plan §1, B9): `agency-roster.client.ts`

Exported API unchanged (`sendRosterChunk`, `supersedeRoster`, `rosterChunkKey`, `ROSTER_CHUNK_SIZE`, the request/response types, `RosterChunkError`, `RosterSupersedeError`), so `agency-ingest.service.ts` ports unchanged. Gone: `coreInternalRequest`, `withRetry` (transport retries), the S2S token, the 30 s HTTP timeouts.

| Piece | Source | Now |
|---|---|---|
| `sendRosterChunk` body | master `agency-roster.client.ts:~520-574` over core `POST /internal/agency-campaigns/:id/contacts`, handler `agency.routes.ts:1892-1962`@4850d1d9 | `applyRosterChunkInProcess` runs the handler body: tenant/account must be non-empty (400 `Validation failed`, `:1894-1900`), `ingest_job_id`/`chunk_index`/`idempotency_key`/`contacts` required (400, `:1901-1917`), `agencyCampaignRepository.findById` (404 `Campaign not found` for unknown AND not-yours alike, `:1918-1939`), `ingestCallerOwnsCampaign` (`:1841-1846`, `requireOwned`'s rule on tenant AND account, exported from the client file), `agencyContactRepository.applyIngestChunk` (B1's, unchanged), and on `is_final` + `chunk_count` `missingChunks` → `roster_complete`/`missing_chunks` (`:1953-1959`). The `{status, body}` pair feeds the unchanged response mapping, so a 4xx is still a `RosterChunkError(status, chunkIndex)` and the ingest job still fails `core_rejected_chunk` |
| `INTERNAL_CAMPAIGN_NOT_FOUND`, `nonEmptyString` | core `:1816-1820`, `:1848-1850` | copied verbatim into the client file (the route file is Phase 8 and the S2S route is deleted) |
| non-UUID campaign id | not handled by core's handler (a `22P02` → 500) | **added**: answered as the same 404, because B1's repository takes `$1::uuid` and the brief forbids feeding it unvalidated ids. Test: "answers a malformed campaign id with the same 404" |
| DB failure | core: Fastify 500, client retried 3× then threw a plain `Error` | propagates as thrown (no retry); the ingest service's `unexpected_error` arm records it, as it did for the exhausted-retry `Error` |
| `isCoreCampaignNotFound` | master | kept in the file but now unreferenced (it classified a 404 from the HTTP hop); left verbatim, listed as dead |
| `supersedeRoster` | master `:~290-420`, over `POST /internal/agency-campaigns/:id/roster/supersede` | **KNOWN GAP, reported to the lead.** The endpoint does not exist in core @4850d1d9 (`agency.routes.ts:1827` calls it "future"; core `083` header: no `superseded_at`, no retired state, no `ingest_job_id` on a contact). In production every call met Fastify's 404 and was mapped to `unsupported` after **one** attempt with nothing touched. Ported as exactly that outcome: it throws `RosterSupersedeError('This deployment cannot replace or clear a roster yet — …', 404, 'unsupported', undefined, 1)` and writes nothing. The behaviour is not invented |

Evidence for the supersede gap (what master does when core lacks it):

- `agency-ingest.service.ts:340-381`: for `mode === 'replace'` (non-dry-run) it `headFile`s the object, then `supersedeRoster`; the `RosterSupersedeError` arm (`:~640-690`) records `replace_unsupported` (or, with `attempts > 1`, marks the roster uncertain) and fails the job with "Nothing was imported and your existing contacts were not touched."
- `proxy-agency-campaigns.routes.ts:721-723,2955-3045` accepts `mode: 'append' | 'replace'` + `expected_contacts_total` on the ingest route; `:3152-3178` `POST /campaigns/:id/roster/clear` calls the same primitive. Both therefore always fail in production today.
- Migrations 057 (`mode`, `replace_superseded_contacts`) and 058 (`replace_superseded_uncertain`) are in the baseline (`agency_ingest_jobs.mode`, `.replace_superseded_*`); they are exercised by the repository tests.
- cusui v2.96.0 (`ee5beb44`) never sends `mode: 'replace'` or `expected_contacts_total` and has no clear-roster call (searched `src/api`, `src/services`, `src/types`): no console path reaches it.
- Decision needed from Manas/lead before Phase 8: leave replace/clear refusing as `unsupported` (matches production) or specify the endpoint (the three schema changes core's `agency-roster.client.ts` header lists: `superseded_at`, a live-rows-only fingerprint index, `agency_contacts.ingest_job_id`, plus a replace lock). Baseline has none of the three.

Equivalence test: `apps/server/test/integration/agency/agency-roster-handoff.test.ts` (real Postgres) re-runs the 22 old cases:

| Old case (master `agency-roster.client.test.ts`) | Now |
|---|---|
| rosterChunkKey ×2 | verbatim |
| sendRosterChunk: sends the agreed body with a stable key | asserts the `agency_ingest_chunks` marker `{job}-0` and the rows |
| reports a replayed chunk as a no-op | verbatim behaviour: replay → `duplicate_chunk: true`, `accepted: 0` |
| sends the same key on a retry | a re-sent chunk writes one marker/one set of rows |
| does NOT retry a 4xx | a 400 is a `RosterChunkError`, nothing written; plus 4 ownership cases (other tenant, sibling account, unknown id, malformed id → one 404) |
| surfaces completeness on the final chunk | real `missing_chunks` gap, then whole |
| threads core's duplicate-rejection fields | real fingerprint collision across jobs |
| defaults the duplicate-rejection fields when core omits them | fresh chunk reports `0`/`[]` (core never omits them in-process) |
| carries the "counts unknown" flag through untouched | marker with no recorded counts → `rejection_counts_unavailable: true` |
| leaves the flag ABSENT rather than false | verbatim |
| omits account_id cleanly | **modified**: refused 400 (core's handler required it; the HTTP client's omission was a 400 in production) |
| supersede: sends the specified body ×2 (replace/clear) | **modified**: always `unsupported`, roster rows unchanged |
| supersede: unrecognised 404 → unsupported; Fastify 404 → unsupported | folded into "says the deployment cannot do it" |
| supersede: core's campaign-404 is not a missing route; carries refusal code; counts attempts ×2; counts started attempts; wraps exhausted retry; retries a 5xx | **deleted**: transport-only (no HTTP, no retries) and the endpoint it classified does not exist |

#### Activity service (B7): `agency-activity.service.ts`

`readCore`'s HTTP call to `GET /internal/audit-logs` (core `internal.routes.ts:1080-1141`@4850d1d9) is now `auditRepository.findFiltered` on `audit_logs` (the shared repository, scope `tenant_id` AND `account_id`, filters `event_type[]`, `event_data->>'campaign_id'`, `from`, `to`, the keyset `(before_at, before_id)`, `with_total`; ordering `date_trunc('milliseconds', timestamp) DESC, id DESC`), in parallel with `getAuditRetentionHorizon()`; rows are enumerated as core's handler did, so `ip_address`/`duration_ms`/`tenant_id`/`account_id` never reach the trail. The `platform_audit_log` half is master's `auditRepository.find` (now `platform/audit.repository`) unchanged. `ActivityQuery.coreAccountId` is renamed `accountId` (the campaign's owning account, read off the campaign row by the Phase 8 route). The pure cursor decoder already refuses non-UUID ids, so a hand-edited cursor cannot reach a `::uuid` cast. Phase 8 must pass UUID `tenantId`/`accountId` (22P02 otherwise).

Deleted, each with its reason: `ActivityPartialReason` / `CORE_EMPTY` / the try-catch / `isAbortFromTimeout` (the "core is down" path has no meaning in one process; a failing read of either table now propagates, as master's own DB failure always did), `coreTimeoutMs` (bounded one HTTP request), `unverifiedAccountScope` (scoping for when core's ownership probe was unreachable; ownership is now a DB read), `parseCoreBody`/`parseRetention` (validating an untrusted HTTP body), `resolveApiKeyNames` and the `platformApiKeyRepository` branch (decision #5). `partial` stays on the wire as `false`/`partial_reason: null` (the contract declares both). Test: `integration/agency/agency-activity-service.test.ts` (6, real Postgres): merged order and source labels, **another tenant's, a sibling account's and another campaign's rows never appear** (both tables, both directions), keyset paging across both stores with no skipped or repeated row, action filter on both halves plus the `from`/`to` window, `skipTotal`, unresolved actor → null display.

#### Stats enrichment: `agency-stats-enrichment.ts`

Kept verbatim: `enrichAgentNames` (the `agent_name` half), `isRecord`, `enrichAgencyCampaignStats` minus the credit block. **Deleted:** `mergeStall` and the `credits_low` stall arm, `rankOf`, `AGENCY_STALL_PRIORITY` (its only reader was `mergeStall`; the single list is `@magick-agency/contracts/agency`), `DEFAULT_CREDITS_LOW_CONNECTS_THRESHOLD`, `AgencyStatsEnrichmentContext.creditsLowConnectsThreshold`, the `creditBalanceRepository` / `rateCardService` reads and the `AGENCY_CONNECTED_CALL_OPERATION` import. `stall` / `other_stalls` pass through as core sent them. Tests: master's 37-case route suite is Phase 8; the module's own cases are `integration/agency/agency-stats-enrichment.test.ts` (16, real Postgres): the 8 `agent_name` cases, the 5 byte-identity cases, the success/retry pass-through cases; **deleted** with the overlay: the 12 `credits_low` cases and the credit halves of two pass-through cases. A "no credits overlay" case replaces them. Also new, no source twin: `integration/agency/agency-agent-identity.test.ts` (4, real Postgres: tenant scoping, highest-role fold, non-UUID, grouped rows).

#### Other modifications and equivalence

| Where | Change | Test |
|---|---|---|
| `agency-csv-ingest.isolation.test.ts` | "no file under contact-lists/ imports the agency ingest" only reads the files that exist (`existsSync`); only `csv-parser.ts` exists here | the suite (4) |
| `agency-activity.test.ts` | the 3 `api_key` cases deleted ("reports a key-authenticated row as an api_key actor…", "falls back to a bare key label…", "names the credential rather than a user on a key-authenticated row"); `api_key_id` removed from the fixture record; third `new Map()` argument removed | 59 → 56 |
| `agency-activity-actions.test.ts` | two type-only casts; "leaves the scheduler actions out" now measures the non-campaign `user.*` actions (agency's catalog has no `schedule.*`), assertion unchanged | 6 → 6 |
| `test/unit/audit/platform/vocabulary.test.ts` (lane A/lead's file; edit authorised by the brief) | restored the two `CAMPAIGN_ACTIVITY_ACTIONS` assertions (`'Paused'`, `'Agent joined'`) in "labels the campaign-scoped actions self-standingly". The third dropped piece (the scheduler test) stays deleted: no scheduler actions | 20 → 20 (assertions, not cases) |
| `agency-ingest-uncertainty-backfill.test.ts` (6) | **deleted**: it reads master migrations 056/059's text; the baseline carries the columns and 059's backfill DML is not carried (BASELINE.md). The column's defaults are exercised in `agency-ingest-job-repository-sql.test.ts` ("create: an unqualified create is a pending … append") | — |
| `agency-stall-priority.contract.test.ts` (4) | **deleted** with the credits stall (see "Stats enrichment"): `AGENCY_STALL_PRIORITY` is `@magick-agency/contracts/agency`'s one list, covered by `packages/contracts/test/stall.test.ts` | — |

#### Phase 8 carry-forwards (lane B2)

- **UUID-validate before calling in.** `fetchActivityPage` (`tenantId`, `accountId`, `campaignId`) and `sendRosterChunk` (`tenantId`, `accountId`; `campaignId` is already answered as a 404 when malformed) hand ids to `$n::uuid` casts, so a non-UUID is `22P02` (a 500). The route layer validates at the schema.
- **`agency-agent-identity.test.ts`**, "is imported by both files that enrich an agent id": it asserts `consumers.length` is `0` because the two route files (`api/routes/proxy-agency-campaigns.routes.ts`, `proxy-agency-performance.routes.ts`) do not exist yet. Phase 8 changes the expected count to `2` when it lands them at those paths.
- **Replace/clear** stays `unsupported` (decision B15); the ingest route's `mode: 'replace'` and `POST /campaigns/:id/roster/clear` therefore fail `replace_unsupported` exactly as production does.
- **`ActivityQuery.coreAccountId` is now `accountId`**: pass the campaign row's owning account, read in-process.
- **Reaper wiring** (`api/agency-reaper-wiring`, 4 cases): `startAgencyIngestReaper` is in `agency-ingest.service.ts`; start it from `bootstrap/agency.ts` and clear it on shutdown.
- **Audited call sites**: B2 adds none; the floor of 22 belongs to the Phase 8 routes.
- **Prove ownership BEFORE the activity read.** The `platform_audit_log` half is scoped by tenant and campaign with NO account predicate on purpose (a predicate would drop pre-MAG-157 rows with a NULL account; the comment is restored in `readMaster`). That is only safe because the route proves the campaign is the caller's first. Do not "fix" it by adding an account predicate, and do not call `fetchActivityPage` on an unproven campaign id.
- **Pass the campaign row's account** (`agencyCampaignRepository.findById(...).account_id`, after the ownership proof) as `ActivityQuery.accountId`, never the request header.
- **Keep the `from >= to` refusal in the route.** Core's 422 `Invalid Period` for `from > to` (`internal.routes.ts:1087`) is gone in-process, so an inverted range now returns an empty `audit_logs` half instead of an error.
- **`agency_ingest_jobs.account_id` must always be set from the proven owner** of the campaign (the roster hand-off compares it to the campaign's account; a job with a different or NULL account fails `core_rejected_chunk`).
- **Phase 6:** wire `startAgencyIngestReaper` from `bootstrap/agency.ts` (and clear it on shutdown). Decide on a repository-level retry for transient `applyIngestChunk` errors: master's `withRetry` retried the HTTP hop 3×, so a transient connection error was recovered; in-process the same error now fails the job `unexpected_error` (the chunk key makes a retry safe).

#### Test classification (every master test file matching `agency|dnc|campaign|ingest|staffing|spine|roster|csv`)

`it(` = source count of `it(`/`test(` literals; `each` = number of `it.each`/`test.each` blocks (rows expand at run time, so the Vitest-printed count of a ported file can exceed `it(`). Ported = Vitest-printed count for the destination; `—` = not mine. Classes: **B2**, **B1 (done)** (already on main), **lead (done)** (shared infrastructure on main), **lane A**, **Phase 6**, **Phase 8**, **deleted**.

**Unit**

| Source file (`test/unit/…`) | it( / each | Class | Destination / reason | Ported |
|---|---|---|---|---|
| `agency/agency-activity-actions` | 6 / 0 | B2 | `apps/server/test/unit/agency/` | 6 |
| `agency/agency-activity` | 46 / 5 | B2 | same; 3 `api_key` cases deleted | 56 (source prints 59) |
| `agency/agency-actor` | 13 / 0 | B2 | same; 7 API-key cases deleted (see test header) | 6 |
| `agency/agency-agent-identity` | 9 / 0 | B2 | same; the consumer-import case checks only route files that exist (Phase 8 raises its expected count 0 → 2) + real-PG file | 9 (+4 real PG) |
| `agency/agency-billing-contract` | 13 / 1 | deleted | billing contract | — |
| `agency/agency-campaign-agent.repository` | 64 / 0 | lead (done) | `packages/db/test/unit/agency/` | on main |
| `agency/agency-campaign-config` | 79 / 0 | B2 | same | 79 |
| `agency/agency-column-analysis` | 14 / 0 | B2 | same | 14 |
| `agency/agency-csv-ingest.isolation` | 4 / 0 | B2 | modified (existsSync) | 4 |
| `agency/agency-csv-ingest.streaming` | 2 / 0 | B2 | same | 2 |
| `agency/agency-csv-ingest` | 54 / 0 | B2 | same | 54 |
| `agency/agency-ingest-job.repository` | 34 / 0 | B2 | same + real-PG file | 34 (+12 real PG) |
| `agency/agency-ingest-keys` | 6 / 1 | B2 | same | 10 |
| `agency/agency-ingest-restart-contract` | 9 / 0 | B2 | same | 9 |
| `agency/agency-ingest-uncertainty-backfill` | 6 / 0 | deleted | migration-text pins; baseline | — |
| `agency/agency-ingest.service` | 50 / 0 | B2 | same (logger mock re-pointed to `@magick-agency/observability`) | 50 |
| `agency/agency-proxy-path-traversal` | 11 / 7 | Phase 8 | route handlers | — |
| `agency/agency-rejected-csv` | 6 / 0 | B2 | same | 6 |
| `agency/agency-roster.client` | 22 / 0 | B2 | modified: `test/integration/agency/agency-roster-handoff.test.ts` (real PG), table above | 19 |
| `agency/agency-stall-priority.contract` | 4 / 0 | deleted | one list in contracts | — |
| `agency/forward-query-strictness` | 16 / 0 | B2 | same (tests `agency-spine`) | 16 |
| `agency/proxy-agency-agent-actions` | 58 / 1 | Phase 8 | route | — |
| `agency/proxy-agency-agent-audit` | 8 / 0 | Phase 8 | route | — |
| `agency/proxy-agency-calls.routes` | 40 / 8 | Phase 8 | route | — |
| `agency/proxy-agency-campaign-activity.routes` | 50 / 3 | Phase 8 | route; the service behind it is B2's and gets its own real-PG suite | — |
| `agency/proxy-agency-campaign-behavioral-capabilities.routes` | 14 / 0 | Phase 8 | route (logic is lane A's `campaign-behavioral-settings`) | — |
| `agency/proxy-agency-campaign-lifecycle-rbac.routes` | 4 / 2 | Phase 8 | route | — |
| `agency/proxy-agency-campaign-retry-rbac.routes` | 3 / 3 | Phase 8 | route | — |
| `agency/proxy-agency-campaign-retry.routes` | 41 / 0 | Phase 8 | route | — |
| `agency/proxy-agency-campaign-series.routes` | 29 / 4 | Phase 8 | route (uses `agency-campaign-wire`) | — |
| `agency/proxy-agency-campaign-stats-enrichment.routes` | 37 / 0 | Phase 8 | route; B2 writes module-level tests for the enrichment kept | — |
| `agency/proxy-agency-campaign-transition-actor.routes` | 18 / 8 | Phase 8 | route | — |
| `agency/proxy-agency-campaigns.routes` | 94 / 6 | Phase 8 | route | — |
| `agency/proxy-agency-grouped-stats.routes` | 96 / 8 | Phase 8 | route | — |
| `agency/proxy-agency-my-surfaces.routes` | 53 / 8 | Phase 8 | route | — |
| `agency/proxy-agency-roster.routes` | 59 / 3 | Phase 8 | route | — |
| `agency/proxy-agency-route-table` | 9 / 2 | Phase 8 | route table | — |
| `agency/proxy-agency-spine.routes` | 40 / 1 | Phase 8 | route | — |
| `agency/proxy-agency-staffing.routes` | 68 / 1 | Phase 8 | route (master has no staffing service module; the logic is in the route file) | — |
| `agency/proxy-agency-station.routes` | 39 / 1 | Phase 8 | route | — |
| `agency/retry-inherited-config` | 7 / 1 | lane A (done) | already in A's `campaign-behavioral-settings.test.ts` (10 → 10, PORTING Lane A); B2 did not re-port | — |
| `agency/s2s-contract` | 25 / 0 | deleted | the fixture retires (plan §1) | — |
| `agency/ws-harness.ts` | helper | Phase 8 | used by the station route suites | — |
| `api/agency-reaper-wiring` | 4 / 0 | Phase 6 | reads `index.ts` boot wiring of `startAgencyIngestReaper` (defined in `agency-ingest.service.ts`, B2/after C); the wiring goes in `bootstrap/agency.ts` | — |
| `api/middleware/error-mask.agency-contract` | 59 / 5 | deleted | error mask not ported (plan §1, one union) | — |
| `api/middleware/error-mask.retry-campaigns` | 8 / 3 | deleted | same | — |
| `api/routes/helpers/csv-attachment` | 11 / 0 | Phase 8 | helper under `api/routes/` | — |
| `api/routes/user-offboarding-staffing` | 27 / 0 | lane A | offboarding close | — |
| `api/routes/webhook-core-agency` | 53 / 8 | deleted | core → master settlement webhook (S2S + billing); its completion-notification consumer is lane A's | — |
| `contact-lists/csv-parser` | 31 / 0 | B2 | same | 31 |
| `credits/rate-card-agency` | 12 / 0 | deleted | billing | — |
| `credits/settlement-agency-attempts` | 21 / 0 | deleted | billing | — |
| `credits/settlement-agency` | 22 / 1 | deleted | billing | — |
| `dnc/dnc-sync.client`, `dnc-sync.service` | 13 / 0, 32 / 0 | deleted | master→core sync (B8) | — |
| `dnc/dnc.repository` | 46 / 0 | B1 (done) | on main | — |
| `dnc/dnc.service` | 28 / 0 | B1 (done) | on main | — |
| `dnc/dnc.routes` | 46 / 0 | Phase 8 | route | — |
| `dnc/internal-agency.routes` | 32 / 0 | Phase 6 / 8 | S2S consumers → in-process | — |
| `governance/catalog.agency` | 11 / 0 | lane A | master governance catalog | — |
| `notifications/agency-campaign-completion` | 42 / 0 | lane A | | — |
| `notifications/agency-campaign-unsubscribe` | 8 / 0 | lane A | | — |
| `notifications/engine/campaign-gate` | 33 / 1 | lane A | | — |

**Integration**

| Source file (`test/integration/…`) | it( / each | Class | Destination / reason | Ported |
|---|---|---|---|---|
| `api/agency-action-error-mask` | 10 / 0 | deleted | error mask | — |
| `api/agency-attempts-settlement-failures` | 8 / 0 | deleted | settlement | — |
| `api/agency-my-campaigns.routes` | 32 / 0 | Phase 8 | route | — |
| `api/agency-offboarding-staffing` | 19 / 0 | lane A | offboarding close | — |
| `api/agency-performance-access` | 23 / 7 | Phase 8 | route | — |
| `api/agency-performance-forwarding` | 26 / 2 | Phase 8 | route (its core hop collapses there) | — |
| `api/agency-session-conflict-forward` | 13 / 0 | Phase 8 | route | — |
| `api/agency-staffing.routes` | 54 / 0 | Phase 8 | route | — |
| `credits/agency-attempt-settlement(-no-balance-row)` | 12 / 0, 10 / 0 | deleted | billing | — |
| `dnc/dnc-campaign-scope`, `dnc-index-usage`, `dnc-scope-sentinel` | 15, 5, 6 | B1 (done) | on main (`apps/server/test/integration/dnc/`) | — |
| `repositories/agency-campaign-agent.concurrency`, `.repository`, `agency-campaign-agents-schema` | 11, 38, 24 | lead (done) | `packages/db` on main (agency-campaign-agent repo is §4) | — |
| `repositories/agency-ingest-job-account-scope` | 9 / 0 | B2 | `apps/server/test/integration/repositories/` | 9 |

**New B2 tests** (no source twin): `integration/agency/agency-roster-handoff.test.ts` (19, replaces `agency-roster.client` 22), `integration/agency/agency-ingest-job-repository-sql.test.ts` (12, every repository method on real Postgres), `agency-activity-service.test.ts` (6), `agency-stats-enrichment.test.ts` (16), `agency-agent-identity.test.ts` (4). `agency-ingest-roundtrip.test.ts` (7, the exit-gate round trip: all three DNC scopes real, S3 mocked at `storage/s3.js`, rejected-rows CSV, idempotent re-sent chunk, second-upload duplicates, dry run, fail-closed DNC, replace → `replace_unsupported` (B15), a campaign of another account refused), and `test/unit/storage/s3-ingest-reads.test.ts` (6: master's 3 `headFile` cases from `test/unit/storage/s3.test.ts` verbatim, plus 3 new `getFileStream` cases; master's other 4 cases cover functions that are core's, not B2's).

## Lane C — voice engine

Source: core `magic-voice-core@4850d1d9` (v1.123.2). Paths below are relative to the repo
(`src/…` → `apps/server/src/…`, core repositories/models → `packages/db/src/…`, tests mirror).
Every modified file carries a `PORT NOTE` at its top; every modified test case is marked inline.
"Imports" = only import specifiers changed (logger/`Traced`/`withSpan` → `@magick-agency/observability`,
repositories/models → `@magick-agency/db/…`, metrics → `@magick-agency/observability/metrics/voice`).

### Source inventory

| Source | Destination | Kind | Reason |
|---|---|---|---|
| `src/core/webrtc-bridge-manager.ts` (2,441) | same | modified | Constructor `(guardHost: TelephonyGuardHost, redis)` replaces `(callManager: CallManager, redis)` (seams §3.1); `triggerDequeue` call removed (AI SQS queue). Deleted: `createCall`, `attachBrowserLeg`, `forceEndByUser` (softphone; the agency path never calls them — `agency-dialer.ts` uses createBridgedCall/createUnboundBridgedCall/bind/reattach/forceEndWithOutcome/playClip), `handleVobizAnswer`, `handleVobizStatus`, the VoBiz L16 relay/clip/`playAudio` branches and `CARRIER_L16_SAMPLE_RATE`, BYOC pinning (`resolveCredentialIdForCallerId`, `getForCredentialId`, `telephony_credential_id`), SIP (`resolveSipDial`, `sipConnectionId`, `sipTrunkId`/`sipAuth*` dial args), `dispatchSettlement`. `maybeEnqueueAnalysis` + `notifyDialerAnalysisRecordingReady` deleted; their call sites call `getBridgeAnalysisHooks().onCallFinalized(facts)` (fire-and-forget, after the terminal write) and `.onRecordingReady(callId)` (awaited) — seams §3.2. Max duration: `accountSettingsRepository.getWebrtcMaxDurationSeconds(t, a) ?? 1800`, 1800 on a throw (core: `FLAGS.webrtc_max_duration_seconds`, default 1800). Default provider `voicelink` (core `vobiz`). The §3.1 members and exported types are unchanged (pinned by `webrtc-bridge-seam-contract.test.ts`); `WebRtcOutboundParams.sipConnectionId` removed (allowed by §3.1). The Redis ws-token store (`storeWsToken`/`verifyWsToken`/`clearWsToken`, fail-open — Q6) is inside this file, verbatim | **Q6 (Manas, 2026-10-09): `verifyWsToken` refuses a missing key when Redis answered; webhook token kept 2h past the end — OQ-5.**
| `src/core/webrtc-bridge-session.ts` | same | modified | Removed `sipConnectionId` (SIP) and `telephonyCredentialId` (BYOC; baseline dropped the column). Imports |
| `src/core/call-manager.ts` (8,919) — extracted | `apps/server/src/core/telephony-guard-host.ts` (new) | modified (extraction) | The four things the bridge used from CallManager. Verbatim bodies of: guard construction (:636-652), `tryAcquireTelephonyConcurrency`/`acquireTelephonyScopes` (:725-772, minus the 6th `group` arg — with no group core called `acquireScopes()` directly), dormancy derivation (:694-711), `runSelfHealSweep` / `wakeSelfHeal` / `armSelfHealTimer` / `runSelfHealPoll` (:7918-8036), `reconcileConcurrency` (:8092-8115, minus `triggerDequeue`), `registerWebrtcActiveIdsProvider`, the WebRTC source of `sweepStaleActiveCalls` (:8193-8335) + `sweepStaleWebrtcCalls` (:8597-8670, minus `dispatchSettlementsBounded`), the self-heal half of `gracefulShutdown` (:8774-8826, minus `noteUnfinishedFanoutProducer`). `getActiveCallCount` = the bridge's active call count (core: AI sessions + static/IVR gauge ids, neither exists) — the poll stays armed while a live agency call holds slots. A behaviour change (in core a live WebRTC call alone never kept the poll armed), kept by lead decision B13. Constants `SELF_HEAL_EMPTY_SWEEPS_BEFORE_DORMANT`, `SELF_HEAL_SHUTDOWN_WAIT_MS`, `TERMINAL_CALLBACK_GRACE_MS` verbatim |
| `src/core/concurrency-guard.ts` | same | verbatim (imports) | |
| `src/core/account-concurrency-guard.ts` | same | modified | Per-broadcast group gate stripped: `GroupLeaseHooks`, `setGroupLeaseHooks`, the field, `releaseGroupLease`, the hook calls in `release` (`release` = core `d1179938^` pre-gate body, identical with no hook wired). Lua/keys/TTLs/degraded mode verbatim |
| `src/core/provider-concurrency-guard.ts` | same | modified | Same stripping (`setGroupLeaseHooks`, `releaseGroupLease`, `extendGroupLease`; `releaseAll`/`extendAll` take the bodies of `releaseAllScopes`/`extendAllScopes`); `group_full` removed from `TelephonyAdmissionResult` (its only producer was the gate) |
| `src/core/telephony-concurrency.ts` | same | modified | Kept `TelephonyConcurrencyOwner`, `acquireTelephonyConcurrency` minus `group`. Deleted `TelephonyGroupAdmission`, `isCapacityRefusal` (callers: `group-refiller.ts:1131` and grouped branches of the SQS coordinator / bulk / static / IVR services), `isGroupParkRefusal`, `GroupGateAdmitter`, `rollbackGate`, `admitThroughGroupGate` |
| `src/core/telephony-release.ts` | same | verbatim (imports) | `TelephonyReleaseSource` kept whole (closed label set; members agency never emits are harmless) |
| (new) | `apps/server/src/core/voice-concurrency-control.ts` | new | `ConcurrencyControl` seam implementation (§3.3): five one-line forwards to the guard methods core's internal routes called |
| `src/core/group-concurrency-gate.ts`, `src/core/group-refiller.ts` | — | not ported | Per-broadcast bulk concurrency (brief) |
| `src/core/paced-audio-streamer.ts`, `src/core/pace-schedule.ts` | same | verbatim (imports) | `pace-schedule.ts` is the streamer's dependency |
| `src/core/paced-frame-queue.ts` | — | not ported | The streamer does not use it (AI output pacing only) |
| `src/core/webhook-url-builder.ts` | same | modified | `baseUrl` returns the VoiceLink base for `voicelink` and for an unknown provider (core fell back to VoBiz); deleted `providerWebhookBase`, `outboundUrls` (AI/static/IVR/escalation callers) |
| `src/utils/webhook-base.ts` | same | verbatim | |
| `src/utils/audio.ts` | same | modified | `frameDurationMs` + its `AudioEncoding` import removed (AI live adapters) |
| `src/utils/audio-fir.ts` | same | verbatim | |
| `src/telephony/voicelink/{voicelink.adapter,voicelink.webhook,voicelink-token-manager}.ts` | same | verbatim (imports) | |
| `src/telephony/voicelink/voicelink.types.ts` | same | verbatim | |
| (new) | `apps/server/src/telephony/voicelink/voicelink-carrier.fixture.json` | new | 58 payload → normalised event → classification entries, each citing its source test; core's copy is a later core PR (seams §5) |
| `src/telephony/types.ts` | same | modified | Kept what the adapter, normaliser and bridge use (`OutboundCallRequest` minus `sipTrunkId`/`sipAuthUsername`/`sipAuthPassword`, `InitiateCallResult`, `AnswerResponseOptions`, `CallEvent`, `ProviderCallStatus`, `AnnouncementResponseParams`, IVR render types, `ProviderCapabilities`, `canCancelRinging`, `queuesOutboundDials`, `TelephonyProvider`, `MediaStreamConfig`). Deleted: `StartRecordingRequest`, `RestRecordingCapableProvider`, `supportsRestRecording`, `TransferTarget`, `TransferCallRequest`, `TransferResponseParams`, `TransferConfirmResponseParams`, `TransferOutcomeResponseParams`, `TransferCapableProvider`, `supportsTransfer`, `TransferLegRequest`, `QueueEnqueueParams`, `QueueWaitParams`, `QueueDequeueParams`, `ScreenedQueueTransferProvider`, `QueueDeleteResult`, `TransferLegOutcomeUnknownError`, `supportsScreenedQueueTransfer` |
| `src/telephony/factory.ts` | same | modified | VoiceLink-only `TelephonyProviderRegistry` with `get`, `getDefault`, `getForCredentialId` (null → platform adapter; non-null → `ByocCredentialUnavailableError`, core's no-resolver branch). `buildProviderConfig(provider, config)` (BYOC `source` arg dropped). Deleted: 7 other adapters, credential-seam/source, `setTelephonyCredentialResolver` re-export, `MAX_BYOC_INSTANCES`, `ByocProviderUnsupportedError`, `getForTenant`, `getForAuthId`, `resolvedCredentialId`, `instanceCounts`, BYOC LRU/`forSource`/invalidation, `createTelephonyProvider` |
| `src/api/routes/webrtc-call.routes.ts` | same | modified (subset) | Kept `GET /:id/pstn-stream` verbatim (the only route the agency path uses; provider-token check in `attachPstnLegVerified`); null-bridge branch closes the socket. Deleted: `GET /:id/browser-stream` (owned softphone leg; with `createCall` gone it could only refuse) and the authenticated softphone API (`/caller-ids`, `POST /`, `GET /`, `GET /:id`, `/:id/recording`, `/:id/recording-url`, `/:id/end`, `/:id/retry-analysis`, `DELETE /:id/transcript`) |
| `src/api/routes/webhooks.routes.ts` (4,901) | same | modified (subset) | Kept the plugin-scoped form parser and `POST /voicelink/webrtc-status/:callId` (webhook-token check) verbatim. Deleted: every AI/static/IVR/inbound/escalation/recording/WS-static webhook, the Telnyx/Twilio signature hooks, `/vobiz/webrtc-{answer,status,recording}` |
| `src/api/middleware/rate-limit.middleware.ts` | same | verbatim (imports + one comment) | `budgetFor`, all six buckets, route classes, `onExceeded` → `rate_limit_rejected_total` verbatim, including predicates for routes agency lacks. Registered inside `voice.plugin.ts` scope (covers lane C's routes; core registered it globally — Phase 8). PORT NOTE: core's `trustProxy: true` sentence is not true here (Q7); exempt paths are `/health`,`/ready` (agency probes are `/healthz`,`/readyz` — only matters if registered globally) |
| `src/utils/api-key.ts` | same | modified (subset) | `hashApiKey` only (decision #5) |
| `src/api/middleware/headers.ts` | same | modified (subset) | `TENANT_HEADER` only |
| `src/audio/decode.ts` | same | verbatim (imports) | Decoders `mpg123`/`sndfile-convert` (not ffmpeg); a missing binary → `AudioDecodeError('DECODE_FAILED')` |
| `src/audio/ensure-pcm-clip.ts`, `src/audio/telephony-clip.ts`, `src/utils/decode-gate.ts`, `src/storage/s3.ts` | same | verbatim (imports) | |
| `src/tts/tts-file-cache.ts` | same | verbatim (imports) | Whole file incl. the sweeper. `runWithConcurrency` from `apps/server/src/utils/concurrency.ts`, provided by main **a9e79a2** (lane A owns the file). The sweeper runs without an evictable-clip filter (core's filter was keyed on static calls); `ensurePcmClip` re-materialises a missing clip |
| `src/db/models/static-call.model.ts` | `packages/db/src/models/static-call.model.ts` | modified (subset) | `STATIC_CALL_MAX_DURATION_SECONDS` (120) only — decode's length cap |
| `src/db/models/audio-file.model.ts`, `src/db/repositories/audio-file.repository.ts` | `packages/db/src/{models,repositories}/` | verbatim | |
| `src/db/models/announcement.model.ts` | `packages/db/src/models/` | modified | `tts_text`/`tts_voice`/`tts_language` removed, `type: 'audio'` (baseline; decision 4) |
| `src/db/repositories/announcement.repository.ts` | `packages/db/src/repositories/` | modified | `create` inserts 5 columns; TTS columns and their `'Polly.Joanna'`/`'en-US'` fallbacks removed |
| `src/analytics/client.ts` | same | verbatim (imports) | Lane C owns it (lead decision) |
| `src/analytics/posthog.ts` | same | modified (subset) | `initAnalytics`, `shutdownAnalytics`, `isAnalyticsEnabled`, `trackWebrtcCallInitiated/Rejected/Completed`, `WebrtcCallRejectionReason`, `WebrtcCallEndedBy`. `egress` is always `'pstn'`, `sip_connection_id` never sent (SIP), rejection default provider `voicelink`. Not carried (AI/static/IVR/messaging/KB/inbound/flags): `identifyTenantAccount` (+ group-name memo), `trackCallInitiated`, `CallRejectionReason`, `trackCallRejected`, `trackCallQueued`, `trackCallDequeued`, `CallEndedBy`, `CallExperienceMetrics`, `trackCallCompleted`, `SipDialFailureReason`, `trackSipDialFailed`, `trackCallAnalyzed`, `trackBatchCompleted`, `trackIvrSessionCompleted`, `trackInboundIntentCreated`, `trackFeatureFlagChanged`, `trackInboundCallResolved`, `trackEmailEngagement`, `trackMessagesDispatched`, `trackMessagingConnectionUnauthorized`, `trackKbCreated`, `trackKbDocumentAdded`, `trackKbIngestCompleted`, `trackKbDocumentReviewed`, `trackKbDocumentPreviewed`, `trackKbQueryResolved` |
| `src/config/{schema,index}.ts` (voice keys) | `apps/server/src/config/blocks/voice.ts` | modified | Keys `concurrency` (minus `mediaStreamConnectTimeoutSeconds`), `telephony` (VoiceLink only; core's provider `superRefine` → VoiceLink fields required when `NODE_ENV=production` or `TELEPHONY_ENABLED_PROVIDERS` names voicelink), `rateLimit`, `s3`, `staticCallTts` (cache-sweeper knobs only), `audio`, `analytics` (whole, incl. LLM keys lane D reads) |
| `src/config/call-duration-limits.ts` | same | modified (subset) | `WEBRTC_MAX_DURATION_SECONDS` only |
| `src/utils/metrics.ts` (lane C declarations) | `packages/observability/src/metrics/voice.ts` | verbatim (declarations) | `provider_concurrency_admission_total`, `provider_concurrency_reconciliation_total`, `telephony_lease_release_total`, `websocket_connections_active`, `rate_limit_rejected_total`, `audio_decode_gate_{queued,active,limit}`, `tts_clip_cache_{retained_total,liveness_failures_total,bytes}`; core's `safeEmit` body is private here (no `resetSafeEmitLatches`). `track*` parameters typed `string` (the package cannot import the server's unions) |
| `src/index.ts` (voice wiring) | `apps/server/src/bootstrap/voice.ts`, `apps/server/src/api/voice.plugin.ts` | modified | Boot order verbatim (S3 → clip cache + sweeper → scratch reap → decode-gate gauges → PostHog → release observer → guard host + bridge → startup self-heal → poll); `setConcurrencyControl` registered in `ensureVoiceEngine`; the engine is created on first use because the plugin registers before `startVoice`. `@fastify/websocket` and the limiter are registered in the plugin scope (Phase 8: hoist websocket if another lane needs it) |

### Tests (source cases → ported; `it.each` rows counted)

| Source (core `test/…`) | Destination (`apps/server/test/…` unless noted) | Src → port | Notes |
|---|---|---|---|
| `unit/core/webrtc-bridge-manager.test.ts` | same | 77 → 53 | Fixture: `createBridgedCall` (borrowed socket) on VoiceLink, `forceEndWithOutcome`. Deleted 24 (VoBiz relay ×2, `does not set mediaStreamUrl for VoBiz`, VoBiz webhooks ×3, `handleVobizStatus` mapping ×6, owned-leg token ×3, owned-leg re-attach ×2, `VoBiz skips the provider-token check…`, BYOC ×6) — names in the file header. Modified: recording ×3 (dial request instead of answer XML), max-duration ×2, the `ending` cases, endCall/shutdown/PostHog (settlement/dequeue asserts), `a payload exactly at the limit…` |
| `unit/core/webrtc-bridge-manager.bridged.test.ts` | same | 11 → 8 | Deleted: `refuses a /browser-stream connect for a bridged call`, `still mints a token and CLOSES its browser socket at teardown`, `writes NULL agency back-references` (softphone). 2 unchanged, 6 modified (named in the header). The relay case sends real 20ms tone frames and asserts one transcoded, non-silent frame of the right length each way, and drives the carrier's `call.ended` so "station never closed" is checked after finalization |
| `unit/core/webrtc-bridge-late-binding.test.ts` | same | 18 → 17 | Deleted: `refuses a /browser-stream connect, closing the intruder`. Relay asserted with real tone frames (length + level, one frame each way); three dropped-socket cases send the VoiceLink `start` frame so the call is answered with media, as VoBiz was on connect (keeps `refuses a socket that has already closed`'s `not.toContain('bridged')` meaningful) |
| `unit/core/webrtc-bridge-ring-cancel.test.ts` | same | 16 → 15 | Deleted: `refuses to return answer XML for a settled call (the VoBiz twin)`; settlement asserts → `trackWebrtcCallCompleted` |
| `unit/core/webrtc-bridge-borrowed-socket-soak.test.ts` | same | 2 → 2 | |
| `unit/core/webrtc-answer-anchor.test.ts` | same | 3 → 3 | verbatim (mock specifier) |
| `unit/core/webrtc-scenarios.test.ts` | same | 15 → 13 | Deleted: `a single end path calls triggerDequeue() once` (AI queue), `Scenario R5` (its premise — the manager never persists a recording URL — is false on VoiceLink). Modified (all 13, named in the header): the three `rawCallStatus` rows ride VoiceLink's pre-answer `call.ended` (`callStatus`); R1/R2/R3 assert the dial request's `enableRecording`/`maxDuration` instead of VoBiz's `<Record>` options; relays use real tone frames; settlement → terminal row + `trackWebrtcCallCompleted`; `forceEndByUser twice` stays answered with `call.ended` driven between the calls |
| `unit/scenarios/voicelink-webrtc-lifecycle-scenarios.test.ts` | same | 3 → 3 | modified fixture |
| `unit/scenarios/stale-call-sweep-lifecycle-scenarios.test.ts` | same | 13 → 4 | Unit under test → `TelephonyGuardHost`. Kept WebRTC cases + the two shutdown-wait cases (wedging the WebRTC sweep). Deleted 9 non-WebRTC cases (named in the header). `bounds that wait…` is stricter than core: advances exactly the 15s budget and pins `waitMs: 15_000` |
| `unit/core/webrtc-bridge-session.test.ts` | same | 31 → 31 | verbatim (mock specifier) |
| `unit/core/webrtc-bridge-manager.analysis.test.ts` | — (lane D) | 21 → handed over | seams §3.2 |
| `unit/core/call-manager-self-heal.test.ts` | `unit/core/telephony-guard-host.test.ts` | 77 → 28 (+3 new) | Kept reconcile ×6, WebRTC sweep ×5, `runSelfHealSweep` ×6, poll ×8, dormancy ×2, startup ×1. Deleted 49 (AI/static/IVR/SQS/settlement/refiller): 6 sweep cases + all 43 cases of the `reconcileAccountSlots` (5), `static_calls_total…` (4), `sweepOrphanedQueuedCalls` (19), `cancelCallWithoutSession` (5), `GroupRefiller wiring` (7), `registerDequeuedAiSession…` (3) describes, every case named in the file header. The deleted audit case's `reason`/`sweep` assertions are carried onto the WebRTC sweep case. New: bridge-count idle (lead decision B13), legacy rollback, provider-mode passthrough |
| `unit/core/concurrency-guard.test.ts` | same | 25 → 25 | |
| `unit/core/concurrency-extend-lock.test.ts` | same | 21 → 21 | |
| `unit/core/account-concurrency-guard.test.ts` | same | 60 → 60 | |
| `unit/core/provider-concurrency-guard.test.ts` | same | 19 → 19 | |
| `unit/core/telephony-release.test.ts` | same | 41 → 41 | two type-only casts |
| `unit/core/telephony-release-wiring.test.ts` | same | 5 → 2 | Audits `bootstrap/voice.ts`; counter read via a recording meter provider. Deleted the three `grafana/terraform/main.tf` alert audits (`alerts on BOTH outcomes that mean a lease is parked`, `does NOT page on noop, and says why`, `alerts on a sustained fallback majority (a latched-degraded replica)`) — alerting is the superproject's (B6) |
| `unit/core/telephony-concurrency-group.test.ts` | same | 18 → 1 | 17 group-gate cases deleted (names in header) |
| `unit/core/group-lease-hooks.test.ts` | same | 17 → 1 | 16 hook cases deleted |
| `unit/core/group-concurrency-gate.test.ts`, `group-concurrency-wiring.test.ts`, `broadcast-concurrency-preflight.test.ts` | — | 17 + 5 + 6 → 0 | per-broadcast concurrency, not ported |
| `unit/core/pace-schedule.test.ts`, `paced-audio-streamer.test.ts` | same | 15 → 15, 15 → 15 | |
| `unit/core/paced-frame-queue.test.ts` | — | 60 → 0 | module not ported |
| `unit/core/webhook-url-builder.test.ts` | same | 44 → 6 | 4 modified (VoiceLink fallback), 38 deleted (other providers, `providerWebhookBase` ×11, `outboundUrls` ×13) |
| `unit/utils/audio.test.ts`, `audio-downmix.test.ts`, `audio-fir.test.ts` | same | 41 → 41, 11 → 11, 24 → 24 | verbatim |
| `unit/telephony/voicelink/redact-url-tail`, `voicelink-token-manager`, `voicelink.adapter.edge-cases`, `voicelink.adapter`, `voicelink.webhook` | same | 7, 23, 14, 38, 125 → same | `voicelink.webhook` has type-only `as never` casts |
| `unit/telephony/provider-capabilities.test.ts` | same | 21 → 6 | 2 modified, 15 deleted (other providers, transfer gate) |
| `unit/telephony/byoc-factory.test.ts` | same | 35 → 7 | 6 modified, 28 BYOC cases deleted |
| `unit/telephony/telnyx/factory.test.ts` | — | 5 → 0 | Telnyx |
| `unit/scenarios/voicelink-config-factory-scenarios.test.ts` | same | 6 → 5 | Deleted `keeps voicelink and a co-configured vobiz as separate cached instances` |
| (new) | `unit/telephony/voicelink/voicelink-carrier.fixture.test.ts` | — → 178 | 4 structural + 58 entries × 3 |
| `unit/api/middleware/rate-limit.middleware.test.ts` | same | 37 → 37 | mock specifiers |
| (new) | `unit/api/middleware/rate-limit.scope.test.ts` | — → 3 | plugin-scoped registration: webhook bucket, separate carrier_media bucket, sibling unlimited |
| `unit/utils/api-key.test.ts` | same | 9 → 3 | 6 `generateApiKey` cases deleted |
| `unit/api/middleware/headers.test.ts` | same | 4 → 2 | 2 modified, 2 deleted |
| `unit/api/routes/voicelink-webhooks.test.ts` | same | 9 → 4 | 5 AI/WS-static cases deleted |
| `unit/api/routes/webrtc-call.test.ts`, `webrtc-call.analysis.test.ts` | — | 29 + 11 → 0 | softphone routes (no pstn-stream case at source) |
| `integration/api/webrtc-call.routes.test.ts` | — | 22 → 0 | softphone routes |
| `unit/audio/decode`, `ensure-pcm-clip`, `telephony-clip` | same | 63, 17, 16 → same | |
| `unit/audio/decoder-toolchain-packaging.test.ts` | — | 6 → 0 | reads `docker/Dockerfile` (none yet; lead/deploy) — covered meanwhile by the new missing-decoder test |
| (new) | `unit/audio/decode-missing-decoder.test.ts` | — → 3 | real spawn at missing binaries → `DECODE_FAILED` |
| `unit/tts/tts-file-cache`, `-atomic`, `tts-cache-sweep`, `-liveness`, `-metrics`, `hash-audio-file-content` | same | 12, 14, 37, 18, 14, 9 → same | `-atomic` type-only casts |
| `unit/tts/gemini-tts.client`, `tts-generator`, `telephony-clip-preconversion`, `preview-text` | — | 12, 45, 12, 13 → 0 | TTS synthesis (decision 4) |
| `unit/utils/decode-gate.test.ts`, `metrics-tts-clip-cache.test.ts` | same | 23 → 23, 7 → 7 | metrics test: `resetSafeEmitLatches` removed |
| `unit/db/repositories/audio-file.repository.test.ts` | `packages/db/test/unit/db/repositories/` | 18 → 12 | 6 migration-067-file cases deleted (baseline shape pinned by `audio-file-pcm-migration`) |
| `integration/repositories/announcement.repository`, `announcement-advanced` | `packages/db/test/integration/repositories/` | 16 → 14, 16 → 14 | 2 TTS cases deleted each; 1 / 2 modified |
| `integration/repositories/audio-file`, `audio-file-pcm`, `audio-file-advanced` | same | 11, 5, 13 → same | |
| `integration/scenarios/announcement-lifecycle.test.ts` | `packages/db/test/integration/scenarios/` | 7 → 1 | 6 TTS/static cases deleted; lifecycle case modified |
| `integration/scenarios/audio-file-announcement-fk.test.ts`, `integration/db/audio-file-pcm-migration.test.ts` | `packages/db/test/integration/…` | 4 → 4, 4 → 4 | |
| `integration/flows/ensure-pcm-clip-heal.test.ts`, `tts-cache-sweep-scale.test.ts` | same | 4 → 4, 6 → 6 | |
| `integration/flows/concurrency-guards.test.ts` | same | 24 → 24 | ids/harness |
| `unit/analytics/webrtc-analytics.test.ts` | same | 18 → 16 | Deleted the two SIP-egress cases; `defaults provider to vobiz…` → voicelink |
| `unit/analytics/posthog.test.ts` | same | 79 → 10 | Kept lifecycle ×6, identity ×1, environment ×3, driven through the WebRTC trackers; the rest test uncarried trackers |
| (new) | `unit/core/webrtc-bridge-seam-contract.test.ts` | — → 3 | type-level §3.1 member list + exported types (fails `tsc` on a signature change) |
| (new) | `unit/core/webrtc-bridge-manager.seams.test.ts` | — → 12 | §3.2 call sites (facts, order, fire-and-forget, awaited recording hook, swallowed errors); max-duration equivalence (value / NULL / throw); `verifyWsToken` length mismatch (Q6). Q6's other outcomes (no Redis, stored null, Redis error → accept; wrong token, none presented → reject) are core's own named cases, ported verbatim in `webrtc-bridge-manager.test.ts` (`…fail-open under Redis degradation`) |
| (new) | `unit/core/voice-concurrency-control.test.ts` | — → 8 | five forwards + bootstrap registration (spies on the engine's own guards prove `setConcurrencyControl` wired those, not another instance) |
| (new) | `unit/api/voice-route-table.test.ts` | — → 1 | route surface from `onRoute` |
| (new) | `integration/core/telephony-guard-scopes.test.ts` | — → 10 | real guards: each refusal scope, rollback, release |
| (new) | `integration/core/voice-engine.test.ts` | — → 9 | real host + bridge: refusals at each scope through the bridge, the stale sweep frees a dead session's slot, ConcurrencyControl on live leases |
| (new) | `integration/api/voice-routes.test.ts` | — → 7 | real app: webhook-token 403/accept, provider-token PSTN leg |
| (new, lead at merge) | `integration/app/concurrency-seam-wiring.test.ts` | — → 2 | the seam is unwired before `buildApp`; through `buildApp` with a real context, lane A's super-admin concurrency PUT commits, invalidates through the voice engine's seam and answers 200 (mutation: dropping `setConcurrencyControl` from `ensureVoiceEngine` makes it 500) |

### Dependencies on other lanes / the lead
- `apps/server/src/utils/concurrency.ts` (`runWithConcurrency`) — main **a9e79a2** (lane A's file, landed early by the lead).
- `apps/server/src/analytics/posthog.ts` — lane D's `trackDialerCallAnalyzed` folded in (verbatim, core `:556-585`) by the lead at lane C's merge; the two `$ai_generation` dialer emitters went to the new `analytics/llm-observability.ts`.
- Added to `apps/server/package.json` (as declared there; same major as core's `package.json`, core's range in brackets): `posthog-node ^5.55.0` (core `^5.35.15`), `@aws-sdk/client-s3 ^3.1147.0` (core `^3.1006.0`), `@aws-sdk/s3-request-presigner ^3.1147.0` (core `^3.1006.0`), `ws ^8.22.0` (core `^8.18.0`), `@types/ws ^8.18.2` (dev; core `^8.5.13`).

### Lead review notes (Fable review of 17ec275)
Carry-forwards for Phase 8; no code change on this branch.
- (a) `EXEMPT_PATHS` (`rate-limit.middleware.ts:94`) is core's `/health`, `/ready`; agency's probes are `/healthz`, `/readyz`. Hoisting the limiter to `app.ts` without changing that list puts the probes in the `ip` bucket, where they can be 429'd.
- (b) Until the limiter is hoisted, every non-voice route is unlimited (core limited them all).
- (c) `@fastify/websocket` is registered in `voice.plugin.ts:26`. Lane B's station socket needs it too; hoist it so there is one `upgrade` listener, not two.
- (d) Q7 unchanged: with no `trustProxy`, the carrier buckets (`wh:`, `cm:`) key on the load balancer's address.

## Lane D — analysis

Sources: core `magic-voice-core@4850d1d9` (v1.123.2). Paths relative to each repo. Counts are what
Vitest printed (see the bottom of this section), compared with the source's `it`/`test` cases
(`it.each` rows counted individually).

### Source inventory and test-file plan (written before porting)

Ported modules: `core/dialer-analysis-{runner,worker,worker-handle}`, `transcription/*`, `analysis/*`
(minus the scorecard), `utils/{retry,recording-url,recording-url-resolver,recording-proxy}`, the profile
and playback routes and the profile validators, `maintenance/retention-purge` (agency slice), the two
repositories and models, the bridge hooks (seam §3.2), the metrics. Test plan: every source suite for
those modules, per the tables below; suites whose module is not mine (AI-call analysis, softphone routes,
S2S support route) are listed under "Not ported".

### Source files

| Source | Destination | Kind | Reason |
|---|---|---|---|
| core `src/db/repositories/dialer-analysis-job.repository.ts` | `packages/db/src/repositories/dialer-analysis-job.repository.ts` | modified | `webrtc_calls` -> `agency_calls`. Settlement removed (plan §4): `claimPendingSettlements`, `markSettlementSent`, `markSettlementAbandoned`, `oldestPendingSettlementAgeSeconds` and every `settlement_*` assignment deleted (baseline dropped the columns); `completeWithAnalysis` no longer sets `next_attempt_at = now()` (only the settlement claim read it). `analysis_audio_seconds` kept and written. Imports nothing from `src/agency/`, so it is in `packages/db` (no B12 case) |
| core `src/db/models/dialer-analysis-job.model.ts` | `packages/db/src/models/dialer-analysis-job.model.ts` | modified | `DialerAnalysisSettlementStatus` and the three `settlement_*` fields removed |
| core `src/db/repositories/call-analysis-profile.repository.ts` | `packages/db/src/repositories/call-analysis-profile.repository.ts` | modified (SECURITY) | `findActiveSuccessor(id)` -> `findActiveSuccessor(id, tenantId, accountId)`, `WHERE dead.id = $1 AND dead.tenant_id = $2 AND dead.account_id = $3`. Core's unscoped form let a caller send another tenant's superseded profile id and get a 409 carrying that tenant's current profile id (and tell 404 from 409): a cross-tenant IDOR. **Deliberate deviation from verbatim; core has the same bug (`call-analysis-profiles.routes.ts:393`); flagged for a later core fix.** Rest verbatim |
| core `src/db/models/call-analysis-profile.model.ts` | `packages/db/src/models/call-analysis-profile.model.ts` | verbatim | |
| core `src/db/models/prompt.model.ts` (lines 1-12) | `packages/db/src/models/prompt.model.ts` | modified (subset) | Only `AnalyticsDimensionType`, `AnalyticsDimension`, `AnalyticsConfig` |
| core `src/db/models/call.model.ts` (lines 154-196) | `packages/db/src/models/conversation-entry.model.ts` | modified (subset, new path) | `ConversationEntry` / `ConversationEntrySource`. Core keeps them in `call.model.ts`; that file is lead-owned here (holds only the result subset), so they sit in a sibling file. `CallAnalysisResult` is imported from the lead's `call.model.ts` unchanged |
| core `src/utils/metrics.ts:862-907` (dialer analysis block) | `packages/observability/src/metrics/analysis.ts` | modified | Names, kinds, units, buckets, labels verbatim. `dialer_analysis_settlement_pending_age_seconds` and its setter not carried |
| core `src/core/dialer-analysis-runner.ts` | `apps/server/src/core/dialer-analysis-runner.ts` | modified | Re-keyed onto `agency_calls` through the shared repository (`webrtcCallRepository` alias). Removed: the `dialer.analysis.completed/failed` event-bus emits and step 12, the `analysis.completed` webhook dispatch (plan §4); settlement wording. `telephonyCredentialId` -> `allowedHosts` (new optional dep `recordingHosts`, default `[]` = refuse every fetch). PostHog / LLM events imported from `analytics/posthog.ts` and `analytics/llm-observability.ts` (core's modules; folded at lane C's merge). Status machine, resume, truncation retry, fencing, backoff verbatim |
| core `src/core/dialer-analysis-worker.ts` | `apps/server/src/core/dialer-analysis-worker.ts` | modified | Settle step, settlement constants and the pending-age gauge removed; promote -> expire -> claim -> recover (60s, concurrency 2) verbatim. `recordingHosts` option threaded to the runner |
| core `src/core/dialer-analysis-worker-handle.ts` | `apps/server/src/core/dialer-analysis-worker-handle.ts` | verbatim | |
| core `src/transcription/{types,gemini-transcriber,sarvam-transcriber,index}.ts` | `apps/server/src/transcription/` | verbatim | Import paths only. `gemini-3.5-flash`, 600s windows, adaptive split, 0.8x truncation retry unchanged |
| core `src/transcription/recording-fetcher.ts` | `apps/server/src/transcription/recording-fetcher.ts` | modified (REWORK, plan §4) | `telephony_credential_id` credential resolution (`buildUpstreamHeaders`, `resolveRecordingAuthSource`) dropped; unauthenticated fetch; the URL's PARSED hostname must be on `voicelinkRecording.allowedHosts` (exact-or-subdomain, https only, never `includes()`); an off-list host is a non-retryable `TranscriptionError` naming the allow-list. **Security modification: redirects are followed by hand (max 3), each `Location` re-checked** (core had no allow-list, so no redirect check either). Response handling verbatim |
| core `src/utils/recording-proxy.ts` | `apps/server/src/utils/recording-proxy.ts` | modified (REWORK) | Carrier credential code (Twilio/VoBiz/Plivo/Telnyx headers, BYOC `mismatch`, credential seam) deleted. `recordingHostMatches` kept with its argument (now the allow-list; logic verbatim) plus `recordingHostname`; `proxyCallRecording` keeps core's streaming/Range body but takes `allowedHosts` and refuses (502) an off-list URL. **Security modification: same manual, re-checked redirect following** (`fetchWithAllowedRedirects`, `RecordingHostRefusedError`, shared with the fetcher); each followed hop's body is cancelled so its connection is released (lead, after the Fable review) |
| core `src/utils/recording-url-resolver.ts` | `apps/server/src/utils/recording-url-resolver.ts` | modified | `resolveRecordingUrl` (AI-call `CallRecord` binding) not carried; `isDirectRecordingProvider`, `resolveClientRecordingUrl` verbatim |
| core `src/utils/recording-url.ts` | `apps/server/src/utils/recording-url.ts` | modified | Signing secret is `config.recordingUrlSigningSecret` (env `RECORDING_URL_SIGNING_SECRET`); core's `config.webhooks.secret` fallback has no counterpart. HMAC, canonical string, TTL, verify verbatim |
| core `src/utils/retry.ts` | `apps/server/src/utils/retry.ts` | verbatim | |
| core `src/analysis/{analysis.service,prompt-builder,dimension-presets,profile-preflight}.ts` | `apps/server/src/analysis/` | verbatim | Import paths only. `profile-preflight`'s `'dialer'` branch is unreachable (`WebRtcCallScope` is `'agency'`) |
| core `src/analysis/index.ts` | `apps/server/src/analysis/index.ts` | modified | Last key fallback (`config.ai.sarvamOpenai/openaiRealtime/sarvamGemini/geminiLive`, the live pipelines) deleted; the reader (`config/blocks/analysis.ts`) falls back to `OPENAI_API_KEY` / `GEMINI_API_KEY` into `postCallAnalysis.apiKey` instead |
| core `src/analysis/call-quality-scorecard.ts` | - | deleted | AI-call only (plan §2) |
| core `src/core/transcript-quality.ts` (lines 31-84) | `apps/server/src/core/transcript-quality.ts` | modified (subset) | Only `conversationEntrySource` and `isSpokenEntry`, which the prompt builder uses. Leak/repeat detection, intro-clip placement and `inspectAssistantTranscript` are the AI pipeline's |
| core `src/api/validators/{call-analysis-profile,analytics-dimension}.validator.ts` | `apps/server/src/api/validators/` | verbatim | |
| core `src/api/routes/call-analysis-profiles.routes.ts` | `apps/server/src/api/routes/call-analysis-profiles.routes.ts` | modified | (1) auth is a `ProfileRouteAuth` option, DEFAULT REFUSE-ALL (401 on every route; Phase 8 supplies the real one). (2) The campaign reference check (`agencyCampaignRepository.findLiveDependentsOnAnalysisProfile` / `countLiveCampaignsInheritingAccountDefault`, lane B's) is a `ProfileDependents` option with core's two signatures; absent => PUT/DELETE answer 503 rather than retire a profile unguarded. (3) Flag gate is `agency_call_analysis` alone (core ORed `dialer_call_analysis` with it; `call-analysis-profiles.routes.ts:94` reads a flag that does not exist here; `analysisFlagFor('agency')` is the same flag). (4) SECURITY: `findActiveSuccessor` called with the caller's tenant/account (see the repository row). Validation, copy-on-write, 409 bodies, audit events verbatim |
| core `src/api/routes/webrtc-recordings.routes.ts` | `apps/server/src/api/routes/webrtc-recordings.routes.ts` | modified | Token check, tenant/account re-check, bodies verbatim; takes `allowedHosts` and passes it to the proxy |
| core `src/maintenance/retention-purge.ts` | `apps/server/src/maintenance/retention-purge.ts` | modified (agency slice) | Only `dialer_analysis_jobs` + `agency_calls` (core's `window: 'agency'` targets, minus `campaign_id IS NOT NULL`), the Slack summary (batching/ordering verbatim). **`purgeAuditPartitions` (the `audit_logs` partition drop + default-partition row delete) and the `audit_partitions_dropped` / `audit_default_rows` report fields: moved to lane A (`apps/server/src/audit/audit-partition-maintenance.ts`), not deleted: lane A owns audit partition maintenance, creating and dropping, so two jobs never drop the same partitions.** Every AI/IVR/messaging/KB/softphone target deleted. Core's run window (the Lambda request's `retention_days`) has no counterpart: **window = `AGENCY_RETENTION_DAYS`, optional; unset => no row purge (default, pending Manas)**. Transcript step nulls `conversation_log` AND `transcript_meta` on `AGENCY_TRANSCRIPT_RETENTION_DAYS` (core nulled `conversation_log` only; `transcript_meta` carries `source_url`), `call_analysis` untouched; unset => not nulled early. Invoked by a timer in `bootstrap/analysis.ts` (`RETENTION_PURGE_INTERVAL_MS`, default daily), not an internal route. `AGENCY_RETENTION_DAYS < RETENTION_MIN_DAYS` still fails boot |
| core `src/core/webrtc-bridge-manager.ts:2190-2295` (`maybeEnqueueAnalysis`, `notifyDialerAnalysisRecordingReady`) | `apps/server/src/analysis/bridge-analysis-hooks.ts` | modified | Bodies moved verbatim into `createBridgeAnalysisHooks()`; gate 3 deleted (seams §3.2); `session.*` reads are the seam's facts; `analysisFlagFor(isAgencyCall ? 'agency' : 'dialer')` -> `analysisFlagFor('agency')`; `onCallFinalized` catches and logs (core's call site did, via `.catch`). Registered by `bootstrap/analysis.ts` (`setBridgeAnalysisHooks`) only when the worker is wired; stop resets it to the no-op |
| core `src/index.ts:535-549, 846-848` | `apps/server/src/bootstrap/analysis.ts` | modified | Worker wiring and graceful shutdown; plus the retention timer and the seam registration. The timer also runs once `BOOT_PURGE_DELAY_MS` (60 s) after boot (lead, after the Fable review: with only a 24 h interval, a process restarted nightly would never purge) |
| core `src/config/schema.ts` (`postCallAnalysis`, `dialerAnalysis`, `retention`) + `src/config/index.ts` env reads | `apps/server/src/config/blocks/analysis.ts` | modified | Keys, defaults, bounds verbatim. New: `voicelinkRecording.allowedHosts` (`VOICELINK_RECORDING_HOSTS`, default empty = fail closed), `recordingUrlSigningSecret`, `retention.purgeIntervalMs`. `retention.transcriptRetentionDays` (softphone) not carried. `analytics` is NOT declared here: lane C's block owns `config.analytics` | **Manas, 2026-10-09: `VOICELINK_RECORDING_HOSTS` defaults to `recording.app.voicelink.co.in` (OQ-3); `AGENCY_TRANSCRIPT_RETENTION_DAYS` defaults to 30 (OQ-7).**
| core `src/analytics/posthog.ts:556-585`, `src/analytics/llm-observability.ts:29-38,120-172` | `apps/server/src/analytics/posthog.ts` (`trackDialerCallAnalyzed`), `apps/server/src/analytics/llm-observability.ts` (new: `AI_GENERATION`, `llmEnabled`, `trackDialerTranscription`, `trackDialerLlmAnalysis`) | verbatim (subset) | Lane D carried them in `analytics/analysis-events.ts` with a no-op client stand-in; the lead folded them into core's modules on lane C's shared client at lane C's merge and deleted the stand-in. `llmEnabled` reads `config.analytics.llmObservabilityEnabled` as core. Not carried from `llm-observability.ts`: `captureContent`, `trackLlmGeneration`, `trackLlmAnalysis` (AI pipeline) |
| `api/analysis.plugin.ts` | - | new | Registers `/api/v1/call-analysis-profiles` (refuse-all auth by default) and `/api/v1/webrtc-recordings` (core's prefixes, `src/index.ts:715,727`) |
| core `src/api/routes/internal.routes.ts` (dialer analysis jobs support route), `src/api/routes/webrtc-call.routes.ts` (`/retry-analysis` etc.), `src/webhooks/{settlement-dispatcher,analysis-completion-dispatcher}.ts`, `src/core/events.ts` events | - | deleted / not mine | S2S/softphone surfaces and the dropped webhook + event bus (plan §4). The retry route's repository primitive (`requeueForManualRetry`) is ported; the route itself is Phase 8 |

New dependencies (same major as core; core declares `openai ^4.82.0`, `@google/genai ^1.46.0`): `apps/server/package.json` declares `openai ^4.104.0` and `@google/genai ^1.52.0`.

### Tests (source cases -> ported cases)

| Source | Destination | Src -> port | Kind | Deletions / changes |
|---|---|---|---|---|
| core `test/unit/core/dialer-analysis-runner.test.ts` | `apps/server/test/unit/core/` | 20 -> 21 | modified | Event-bus / webhook expectations removed (audit asserted instead); settlement fixtures dropped; +1 allow-list hand-off case |
| core `test/unit/core/dialer-analysis-worker.test.ts` | same | 16 -> 13 | modified | Deleted 3 "settlement sweep (B2)"; ordering/gauge/step-failure cases end at `recover` |
| core `test/unit/core/dialer-analysis-worker-handle.test.ts` | same | 3 -> 3 | verbatim | |
| core `test/unit/core/dialer-analysis-race.test.ts` | same | 4 -> 4 | modified (paths) | settlement fields in the in-memory model |
| core `test/unit/core/webrtc-bridge-manager.analysis.test.ts` | `apps/server/test/unit/analysis/bridge-analysis-hooks.test.ts` | 21 -> 14 ported (+14 new = 28) | modified | Driven through `createBridgeAnalysisHooks()` with the seam's facts. Deleted 7: "account toggle explicitly false" (gate 3), browser-vs-agency byte-identity, "campaign analysis_profile_id reaches the job", "`record_calls: false`", "account recording ceiling" (the last four are bridge intake: lane C), "gates a softphone call on dialer_call_analysis", "softphone opt-out still disables softphone analysis". Modified 3: enqueue-failure (no settlement; asserts the hook resolves), dialer-flag-off, softphone-opt-out (assert the dialer flag / account settings are never consulted). New: `onRecordingReady` x5, failure/gate edges, seam registration |
| core `test/unit/transcription/{gemini-transcriber,sarvam-transcriber,index}.test.ts` | `apps/server/test/unit/transcription/` | 20/6/11 -> 20/6/11 | verbatim (mock paths; `config` stub dropped in index) | |
| core `test/unit/transcription/recording-fetcher.test.ts` | same | 10 -> 29 | modified | Deleted "VoBiz auth headers" and "Twilio Basic auth headers". New: no-credentials, subdomain, 8 refusal rows (off-list, suffix/prefix lookalike, userinfo, path, query, http, unparseable), empty list, **redirects: manual mode, allowed->allowed (absolute + relative), 6 allowed->off-list/internal/http-downgrade/userinfo refusals, >3-hop loop, redirect without Location** |
| core `test/unit/analysis/{analysis.service,prompt-builder,dimension-presets}.test.ts` | `apps/server/test/unit/analysis/` | 16/32/14 -> 16/32/10 | verbatim (paths); `dimension-presets` modified | `dimension-presets`: the 4-case byte-identity block against cusui's `src/utils/knowledgeGrounding.ts` is DELETED (lead, session 3): that file serves only the AI `PromptEditorPage`, which the console does not port, so there is no console copy to compare |
| core `test/unit/analysis/index.test.ts` | same | 10 -> 7 | modified | Deleted 3 "falls back to pipeline key" cases (fallback moved to the env reader; tested in `config/analysis-config.test.ts`) |
| core `test/unit/utils/{retry,recording-url}.test.ts` | `apps/server/test/unit/utils/` | 9/13 -> 9/13 | verbatim (secret via mocked config) | |
| core `test/unit/utils/recording-proxy-resolve.test.ts` | same | 17 -> 9 | modified | Deleted 8: every case through `resolveRecordingUrl` |
| core `test/unit/utils/recording-proxy-byoc.test.ts` | `apps/server/test/unit/utils/recording-proxy.test.ts` | 30 -> 25 (rewritten) | modified | All credential/BYOC/Twilio/VoBiz/Plivo/Telnyx header cases deleted with their functions. Kept in spirit: the "HOST check, not a substring match" suite (8 hostile URLs, real host, subdomain, case, unparseable) against `recordingHostMatches`; `proxyCallRecording` 404/fetch. New: Range forwarding, off-list/lookalike/empty-list 502, **redirect refusals (internal, localhost, off-list, http downgrade, loop)** |
| core `test/unit/api/routes/call-analysis-profiles.test.ts` | `apps/server/test/unit/api/routes/` | 20 -> 21 | modified | Auth/dependents injected as options. Deleted: "softphone flag alone", "does not spend the agency resolution". New: refuse-all default (all 5 routes, enumerated from `onRoute`), 503 without the reference check, **stale-409 passes tenant/account; another tenant's superseded id is a 404 that does not leak its successor** |
| core `test/unit/agency/profile-in-use-reference-check.test.ts` | `apps/server/test/unit/agency/` | 23 -> 23 | modified (injection) | |
| core `test/unit/api/validators/{call-analysis-profile,analytics-dimension}.validator.test.ts` | `apps/server/test/unit/api/validators/` | 8 / 12+N -> 8 / 10 | modified | `analytics-dimension`: deleted "re-exported by the prompt validator", "enforced by prompt create and update" and the "shipped prompt JSONs" describe (prompt templates are AI-call) |
| core `test/unit/api/routes/webrtc-recordings.test.ts` | same | 4 -> 6 | modified | + cross-account token, + empty allow-list default |
| core `test/unit/config/schema.dialer-analysis.test.ts` | `apps/server/test/unit/config/` | 11 -> 11 | modified | transcript default 30 -> unset; softphone `transcriptRetentionDays` dropped |
| core `test/unit/maintenance/retention-purge.test.ts` | `apps/server/test/unit/maintenance/` | 19 -> 16 | modified | "drops only audit partitions..." **moved to lane A** (replaced by a case asserting no `audit_logs` / `pg_inherits` / `DROP` statement is issued and the report has no audit fields). Deleted: concurrency-group, IVR-session, softphone-fallback cases and the kb/AI blocks; the product-split cases became "touches only the agency tables" / window-binding / transcript-binding / unset cases; + "nulls transcript AND provenance, never the analysis" |
| core `test/unit/db/repositories/dialer-analysis-job.repository.test.ts` | `packages/db/test/unit/db/repositories/` | 32 -> 27 | modified | Deleted 5: settlement age gauge (2), settlement sweep primitives (3). Two `completeWithAnalysis` cases assert audio seconds recorded and no settlement column |
| core `test/unit/db/repositories/call-analysis-profile.repository.test.ts` | same | 8 -> 9 | modified | `findActiveSuccessor` binds tenant/account; + scoped-lookup case |
| core `test/unit/db/dialer-analysis-models.test.ts` (job-status case) | `packages/db/test/unit/db/dialer-analysis-job-model.test.ts` | 1 of 3 -> 2 | modified | Settlement-status case deleted; + the record/baseline carry no settlement field |
| (new) | `apps/server/test/unit/analysis/{profile-preflight,bootstrap-analysis}.test.ts`, `analytics/dialer-events.test.ts` (was `analysis/analysis-events.test.ts`; at lane C's merge it runs through the real `analytics/client.ts` over a mocked `posthog-node`), `config/analysis-config.test.ts` | - -> 6 / 9 / 7 / 5 | new | Core has no unit test for the preflight or the bootstrap wiring; events tests cover the PII posture, the LLM sub-gate and no-op without a client |
| core `test/integration/repositories/dialer-analysis-job.repository.test.ts` | `packages/db/test/integration/repositories/` | 6 -> 9 | modified | Settlement parts replaced by `analysis_audio_seconds` recorded; + expiry mirror, generation fencing on every write, recovery ceiling/graceful/rate-limit, queue depth/list |
| core `test/integration/repositories/call-analysis-profile.repository.test.ts` | same | 5 -> 6 | modified | UUID ids; scoped `findActiveSuccessor`; + **real-Postgres cross-tenant/cross-account IDOR case** |
| core `test/integration/db/dialer-analysis-migration.test.ts` | `packages/db/test/integration/db/` | 5 -> 6 | modified | Against the baseline; settlement columns/indexes and `analyze_dialer_calls` asserted gone |
| core `test/integration/flows/dialer-analysis-{lifecycle,failure-paths,gating,dsar,race,recovery}.test.ts` | `packages/db/test/integration/flows/` | 1/2/2/1/2/2 -> same | modified | Settlement assertions dropped |
| core `test/integration/flows/dialer-analysis-settlement-durability.test.ts` | - | 2 -> 0 | deleted | Settlement removed |
| core `test/integration/db/dialer-retention-purge.test.ts` | `apps/server/test/integration/maintenance/agency-retention-purge.test.ts` | 2 -> 6 | modified | **Exit gate: transcript nulled at the transcript day, analysis survives to row expiry, then the row and job go** |
| core `test/integration/api/webrtc-recordings.routes.test.ts` | `apps/server/test/integration/api/` | 14 -> 11 | modified | Playback describe only, with the real signer; softphone mint/`/recording` cases (7) deleted; + off-list host and redirect refusal |
| (new) | `apps/server/test/integration/analysis/pipeline.test.ts` | - -> 12 | new | Worker + runner + REAL fetcher over real job rows: happy path, late-recording promotion, skip x2, resume, truncation retry + backoff, backoff ceiling, rate limit, off-list host, off-list redirect, empty allow-list, stale recovery |

### Not ported

| Source | Reason |
|---|---|
| core `test/unit/analysis/call-quality-scorecard.test.ts`, `test/unit/core/{runPostCallAnalysis,post-call-analysis-runner}.test.ts`, `test/integration/flows/analysis-completion-flow.test.ts` | AI-call analysis / the dropped `analysis.completed` webhook |
| core `test/unit/api/routes/internal-dialer-analysis-jobs.test.ts` (4), `test/unit/api/routes/webrtc-call.analysis.test.ts` (11), `test/unit/api/routes/metadata-dimension-presets.test.ts` (4) | S2S support route, softphone routes and `GET /metadata` (Phase 8 / not carried) |
| core `test/integration/api/voicelink-recording.routes.test.ts` (8) | AI calls' `/api/v1/calls/:id/recording-url` |
| core `test/unit/analytics/{posthog,llm-observability,webrtc-analytics}.test.ts` | Lane C owns the client and catalog; the three dialer emitters are covered by `analytics/dialer-events.test.ts` |
| core `test/unit/agency/campaign-analysis-profile-route.test.ts` (13) | The agency campaign route: lane B |
| Phase 7 gate "one real recording transcribed and analysed on the pilot account" | NOT attempted: no vendor account (docs/seams.md §5) |

### Security modifications (not in core; each has tests)

1. **Redirect SSRF.** The recording allow-list is checked on every hop (`fetchWithAllowedRedirects`), `redirect: 'manual'`, max 3 hops, `Location` resolved against the current URL, https only. Fetcher: permanent `TranscriptionError`; proxy: 502. Tests: allowed->allowed (absolute/relative), allowed->internal / localhost:5436 / off-list / http downgrade / userinfo, loop past the cap, in unit (fetcher, proxy) and real-Postgres (pipeline, playback) suites.
2. **Cross-tenant IDOR on `findActiveSuccessor`.** Scoped by the caller's tenant/account. Tests: mocked-SQL, real-Postgres repository, and the route (cross-tenant superseded id is a 404 that does not leak the successor). Core has the same bug at `call-analysis-profiles.routes.ts:393`; flagged for a later core fix.

### Unscoped lookups reachable from a request

`api/routes/webrtc-recordings.routes.ts`: `webrtcCallRepository.findById(id)` is unscoped by design (the HMAC token is the authorization, bound to the call id; the row's tenant/account are re-checked against the token). Profile routes: every read/write is scoped (`findByIdScoped`, `update`, `softDelete`, `listByTenant`, `findActiveByName`, and now `findActiveSuccessor`). Not request-reachable but unscoped: `callAnalysisProfileRepository.findById(call.analysis_profile_id)` in the bridge hook (id is stamped on the call row from the campaign and validated at write time by `preflightAnalysisProfile`; same as core).

### Printed counts (lead re-run, session 2, on the merge head)

From inside each package: `apps/server` lint 0; unit 44 files, 556 passed, 4 skipped (the dimension-presets
byte-identity cases, waiting on `apps/console`, Phase 9); integration 5 files, 38 passed. `packages/db` lint 0;
unit 15 files, 281 passed; integration 22 files, 250 passed.

### Lead review notes (Fable review of `fab9a82`, session 2)

No blocking findings. Fixed by the lead before merging: the retention purge also runs once after boot (it
never ran on a process restarted more often than the interval), and followed redirect hops release their
connection. Carried forward:
- **Manas:** transcript retention. Core nulls an agency transcript at 30 days with no configuration (core
  `retention-purge.ts:461-465` falls back to `retention.transcriptRetentionDays`, default 30). Here
  `AGENCY_TRANSCRIPT_RETENTION_DAYS` is unset by default, so with `AGENCY_RETENTION_DAYS` also unset a
  transcript is kept for ever. Built as "default, pending Manas"; the reviewer recommends core's 30.
- **Phase 8:** `signRecordingUrl`'s default `basePath` is core's `/api/v1/recordings` (the AI calls' route, not
  ported); the only consumer here is `/api/v1/webrtc-recordings`. A minter that omits `basePath` mints dead
  links: make it required or change the default then.
- **Phase 8 hardening:** `bridge-analysis-hooks.ts:103` reads `analysis_profile_id` unscoped (verbatim, core
  `webrtc-bridge-manager.ts:2254`); safe while the campaign write path runs `preflightAnalysisProfile`.
  `findByIdScoped` would make it independent of that.

## Phase 6 — runtime

Branch `phase-6/runtime` (worktree `magick-agency-p6`). Source: core `magic-voice-core@4850d1d9` (v1.123.2)
unless marked master (`magick-master@a1f0756a`). Brief: `docs/briefs/phase-6-runtime.md`.

### 6.1 Test plan (written before the tests were ported)

Starts from the 44 rows B1 classified `Phase 6` (25 unit files, 9 integration files, `chaos/` 9 files + harness),
plus the core and master suites B1's tables did not carry. `it(` = `it(`/`test(` literals counted in the source
(`grep -cE "^\s*(it|test)\("`), `each` = `it.each`/`test.each` blocks (their rows expand at run time; the
ported column is what Vitest prints). Planned deletions are named in the "Planned changes" column; the "Ported"
column is filled from the printed counts in §6.4.

Unit (`apps/server/test/unit/agency/<f>.test.ts` unless noted; mocked as in core):

| Source `test/unit/agency/` | it( / each | Destination | Planned changes |
|---|---|---|---|
| `abandon-clip` | 16 / 0 | same | TTS cases deleted (decision #4: `abandon-clip.ts` TTS branch deleted); a non-`audio` row → `no_content` |
| `abandon-clip-cache-roundtrip` | 5 / 0 | same | carrier fixture VoBiz → VoiceLink (lane C deleted VoBiz) |
| `abandon-reason-telemetry` | 26 / 0 | same | `sip_connection_id` fixture field dropped; config stub without `vobiz` |
| `abandoned-call-path` | 16 / 0 | same | real bridge on VoiceLink instead of VoBiz (`<Stream>` answer → VoiceLink `start`), as lane C did |
| `abandonment-guardrail` | 22 / 1 | same | verbatim (imports) |
| `abandonment-metrics` | 21 / 0 | `abandonment-metrics.test.ts` | ONLY the 9 cases B1 deferred by name (the gauge/registry groups); B1's `abandonment-window.test.ts` holds the other 19 |
| `abandonment-otlp-export` | 11 / 0 | same | verbatim (paths) |
| `agency-dialer` | 28 / 0 | same | fixture `sip_connection_id` dropped; dial-param assertions without `sipConnectionId` |
| `agency-dialer-lineage` | 5 / 0 | same | as above |
| `agent-state-machine` | 15 / 0 | same | verbatim (paths) |
| `break-manager` | 18 / 0 | `packages/domain/test/unit/agency/break-manager.test.ts` | leaf module (path rule) |
| `canceled-outcome-ledger` | 11 / 0 | same | as `agency-dialer` |
| `dial-dispatcher` | 7 / 0 | same | verbatim (paths) |
| `exhaustion-completion` | 19 / 0 | same | attempt-batcher flush cases deleted (billing); equivalence: the finalize path is otherwise unchanged and calls the completion notifier once |
| `late-binding` | 30 / 0 | same | as `agency-dialer` |
| `live-concurrency-metrics` | 19 / 0 | same | verbatim (paths) |
| `pacing-engine` | 62 / 1 | same | batcher cases (if any) deleted; DNC stub takes the scope argument |
| `pacing-engine-gates` | 22 / 0 | same | DNC registry stub/fixtures re-pointed at B1's DB-backed `DncRegistry`; scope asserted |
| `pre-dial-gates` | 20 / 0 | same | `check` asserted with `{ accountId, campaignId }`; `account_id` in the campaign fixture |
| `presence-resilience` | 16 / 0 | same | real bridge on VoiceLink |
| `reaper` | 41 / 0 | same | verbatim (paths) |
| `station-heartbeat-grace` | 19 / 0 | same | handler under test is `agency/station-socket.ts` (not `agency.routes.ts`) |
| `station-registry` | 29 / 0 | same | verbatim (paths) |
| `station-supersede-stomp` | 10 / 0 | same | handler under test is `agency/station-socket.ts` |
| `station-token` | 5 / 0 | same | verbatim (paths) |
| `wrapup-manager` | 34 / 0 | same | verbatim (paths) |
| `station-reconnect-frame` | 4 / 0 | — | Phase 8 (lead ruling at B1's review: drives the route's bootstrap and `BreakRegistry` as a whole) |
| `dnc-resync` | 19 / 0 | — | deleted (B8; B1 listed it) |

Integration (`apps/server/test/integration/agency/<f>.test.ts`, real Postgres 5436 + Redis 6383, Redis db 7):

| Source `test/integration/agency/` | it( / each | Planned changes |
|---|---|---|
| `agency-agent-cas` | 6 / 0 | UUID ids |
| `agency-agent-state-cycle` | 1 / 0 | UUID ids; `runtime.dnc.applyReplace(...)` (Redis-set sync) removed — the table is the baseline (B8) |
| `agency-context-ordering` | 9 / 0 | UUID ids |
| `agency-crash-recovery` | 6 / 0 | UUID ids; `new DncRegistry(null, '')` → `new DncRegistry()` |
| `agency-dnc-runtime-wiring` | 1 / 0 | rewritten: core asserts the runtime arms the DNC outbox sweeper (deleted, B8); ported as "the runtime's DNC gate reads `dnc_entries` and halts on a read fault" |
| `agency-double-reservation` | 9 / 0 | UUID ids; `applyReplace` removed (B8) |
| `agency-gate-skip-logging` | 2 / 0 | UUID ids; `applyReplace` → a `dnc_entries` row where the case needs a suppressed number |
| `agency-lease-ring-duration` | 3 / 1 | UUID ids |
| `agency-reaper-sql` | 12 / 0 | UUID ids |
| `chaos/harness.ts` | — | verbatim design (ScriptedBridge carrier, real engine/dialer/registry/repositories); `makeTenantDncAuthoritative` / `resyncDnc` reduced to no-ops with a PORT NOTE (no set to sync, B8); Redis = the worktree's test db |
| `chaos/abandonment-counter-vs-table` | 9 / 0 | exit gate |
| `chaos/abandonment-predicate-agreement` | 3 / 0 | exit gate |
| `chaos/attempt-number-collision` | 6 / 0 | |
| `chaos/dnc-self-heal-loop` | 3 / 0 | **rewritten or deleted** (it drives master's resync over loopback, B8) — the DNC fail-closed exit gate is re-proved on the table: a read fault halts the whole batch, nothing dials |
| `chaos/lease-renewer-killed` | 5 / 0 | |
| `chaos/network-drop-during-ring` | 7 / 0 | |
| `chaos/redis-expired-wholesale` | 8 / 0 | `resyncDnc` calls become no-ops (B8) |
| `chaos/restart-mid-bridge` | 2 / 0 | exit gate |
| `chaos/roster-exactly-once` | 8 / 0 | exit gate |

Not in B1's tables, added here:

| Source | it( | Destination | Plan |
|---|---|---|---|
| core `test/unit/utils/metrics.test.ts` — "agency abandonment instruments (AD-P2-C-06)" (3) and "agency pre-dial gate + DNC-synced instruments (MAG-109)" (4) | 7 | `packages/observability/test/metrics-agency.test.ts` | the 3 abandonment cases + the 2 gate-counter cases; the 2 `agency_dnc_synced` cases deleted (B8) |
| core `test/unit/utils/metrics-otlp-contract.test.ts` + `test/fixtures/metrics/otlp-instruments.json` (agency rows) | — | same file | a contract over the agency rows of core's committed instrument fixture (names, kinds, units, buckets, label keys), minus the billing and DNC-set rows |
| master `test/unit/api/agency-reaper-wiring.test.ts` | 4 | `apps/server/test/unit/bootstrap/agency-reaper-wiring.test.ts` | same 4 assertions, scraped from `bootstrap/agency.ts` |
| master `test/unit/dnc/internal-agency.routes.test.ts` | 32 | — | not Phase 6: the runtime never calls master's `/internal/agency/dnc` or `/dnc-resync`. Its write half is B1's in-process `markDnc` (B1's suites); its caller is the Phase 8 DNC route; the resync/S2S/route-table halves are deleted (B8) |

New (no source twin):

| Destination | What it proves |
|---|---|
| `apps/server/test/integration/agency/runtime-e2e.test.ts` | the exit-gate end-to-end: boots the runtime through `bootstrap/agency.ts` on real Postgres/Redis with the REAL bridge and a stubbed `TelephonyProviderRegistry` (lane C's `voice-engine.test.ts` pattern); session → ready over the real station socket; reservation; bridged call; disposition; wrap-up; analysis enqueued through seam §3.2; attempt row `ended` |
| `apps/server/test/integration/agency/runtime-boot-order.test.ts` | (added on resume, lead's order pin) voice-then-agency boot and reversed stop order, driven through `startVoice` → `startAgency`; see §6.4 |
| `apps/server/test/unit/agency/runtime-collapses.test.ts` | equivalence for each hop collapse: no batcher/outbox/resync is constructed or started; the completion notifier is called exactly once per won terminal transition with the campaign's facts; the DNC registry is the DB-backed one |
| `apps/server/test/unit/agency/campaign-completion-notice.test.ts` | master's handler body in-process: counter `sent` / reason / `threw` |
| `apps/server/test/unit/api/agency-station-route.test.ts` | the station socket is registered at `/api/v1/agency/station/:sessionId` (enumerated from `onRoute`) and only once |

### 6.2 Source files

| Source (core `src/…`@4850d1d9) | Destination | Kind | Reason |
|---|---|---|---|
| `agency/runtime.ts` | `apps/server/src/agency/runtime.ts` | modified | Imports (path rule). Deleted: `AgencyAttemptBatcher` field/construction/`registerAttemptBatcher`/`start(ATTEMPT_BATCH_SWEEP_MS)`/`stop()` (billing, plan §8 Phase 6); `AgencyDncOutboxSweeper` field/construction/`start`/`gracefulShutdown` and `createDncResyncRequester`/`warnIfDncSelfHealUnavailable` (B8). `new DncRegistry(redis, keyPrefix, createDncResyncRequester())` → `new DncRegistry()` (B1's DB-backed registry). Added: `pacing.registerCompletionNotifier({ notifyCampaignFinished: notifyAgencyCampaignFinished })` (§6.3). Every other line verbatim, incl. `rehydrateAgent`, `releaseStationOnClose`, `sweepSilentStations`, start/stop order |
| `agency/pacing-engine.ts` | same | modified | Imports. The `registerAttemptBatcher` seam and the billing flush in `maybeFinalize` are replaced by `registerCompletionNotifier` and a `void notifyCampaignFinished(updated, to).catch(log)` at the same place (inside `if (updated)`); not awaited, see the inline PORT NOTE. NEW (review fix): the notice is tracked in `inFlightNotices` and `stop()` drains it after relinquishing, bounded by `COMPLETION_NOTICE_DRAIN_TIMEOUT_MS = 30_000` (core's `WEBHOOK_FANOUT_DRAIN_TIMEOUT_MS`, `src/config/webhook-fanout.config.ts:56`, the budget core gave its background webhook fan-out on shutdown; core awaited the flush here, master awaited the notifier at `webhook-core.routes.ts:1160`), logging the count lost on timeout. Tick, lease, revocation, gates, claim, finalize SQL calls verbatim |
| `agency/agency-dialer.ts` | same | modified | Imports. `sipConnectionId: cmd.campaign.sip_connection_id` removed from the dial params (SIP deleted, plan §5; seams §3.1 allows it). Nothing else |
| `agency/pre-dial-gates.ts` | same | modified | Imports. `deps.dnc.check(tenant, phone)` → `check(tenant, phone, { accountId: campaign.account_id, campaignId: campaign.id })` (B1's required carry-forward; B8) and `'account_id'` added to `PreDialGateInput.campaign`'s `Pick`. Gate order and every arm verbatim |
| `agency/abandon-clip.ts` | same | modified | Imports. TTS branch deleted (decision #4: `generateTtsAudio`, the VoBiz language table, `tts_text/tts_voice/tts_language`); a non-`audio` row now returns core's `no_content`. Scoped lookup, `ensurePcmClip`, every-failure-is-null verbatim. The `catch`'s core comment (TTS language / TTS outage) kept verbatim with a PORT NOTE beside it |
| `agency/{dial-dispatcher,station-registry,station-token,agent-state-machine,wrapup-manager,reaper,abandonment-guardrail,abandonment-metrics,live-concurrency-metrics}.ts` | same | verbatim (imports) | Diff against core is import specifiers only |
| `agency/break-manager.ts` | `packages/domain/src/break-manager.ts` | verbatim (imports) | Leaf (imports only contracts) → `packages/domain` (path rule); importers use `@magick-agency/domain/break-manager` |
| `utils/safe-emit.ts` | `apps/server/src/utils/safe-emit.ts` | verbatim (imports) | The pacing engine's `safeEmit`; lane C keeps a private copy inside `metrics/voice.ts` |
| `utils/metrics.ts:2294-2636, 2692-2962` | `packages/observability/src/metrics/agency.ts` | verbatim (declarations) | The agency runtime series (answered/abandoned counters, the 24h window gauges, live attempts, pre-dial gate, tick idle, hold/answer/bind latency, bind total, abandoned reason, wrap-up, our-fault retirement). Not carried: `:2637-2690` (attempt-batch billing series) and `:2964-` (`agency_dnc_synced`, DNC outbox series; B8) |
| `api/routes/agency.routes.ts:159-168` (the station route) + `:1358-1782` (`handleStationSocket`) | `apps/server/src/agency/station-socket.ts` (`registerStationSocket`, `handleStationSocket`) | modified | Bodies verbatim. Moved out of the route file (Phase 8 owns the rest of it, decision B16) so mounting is one call. Added: a `null` runtime (an app built with `ctx: null`) closes the socket 1011 instead of dereferencing nothing. Mounted by `agencyPlugin` at `/api/v1/agency` (core `src/index.ts:694`) |
| `index.ts:404, :856, :977-981` | `apps/server/src/bootstrap/agency.ts` | modified | `ensureAgencyRuntime` (lazy, like `ensureVoiceEngine`, because the plugin registers before `startAgency`) builds `new AgencyRuntime(ensureVoiceEngine(redis).bridge, redis, config.redis.keyPrefix)`; `startAgency` awaits `runtime.start()`; its stop function awaits `runtime.stop()`. `getAgencyRuntime()` for Phase 8. `resetAgencyRuntimeForTests()` is async and first runs the stop `startAgency` returned if nobody ran it (so a test's timers cannot outlive the singleton) |
| `index.ts:977-984` (`agencyRuntime.start()` then `app.listen`) | `apps/server/src/index.ts` (lead-owned; edit authorised by the lead at review) | modified | `app.listen` + its log line moved after the four `stops.push(await start…)` calls, so no request (once Phase 8 mounts `POST /sessions`) lands before the startup reap. Doc comment's start order updated. Pinned by `runtime-boot-order` case 1 |
| master `src/index.ts:677,720,741-770`@a1f0756a | `apps/server/src/bootstrap/agency.ts` | verbatim (relocated) | Boot-time `agencyIngestJobRepository.reapStaleJobs()` + `agencyIngestReapInterval = startAgencyIngestReaper()`, cleared on shutdown (lane B2 carry-forward) |
| (new) | `apps/server/src/agency/campaign-completion-notice.ts` | new | The in-process body of master's `POST /webhooks/core/agency-campaign-completed` (§6.3) |
| core `test/helpers/otel-metric-reader.ts` | `apps/server/test/helpers/otel-metric-reader.ts` | modified | Verbatim, with core's `ScrapeMetricReader` + `freshGaugeTemporality` inlined from `src/utils/otel-sdk-config.ts:242-245,268-272,320-331` (that file was not ported then; its non-scrape half now is, see "OpenTelemetry SDK", and `ScrapeMetricReader` still is not). Needs `@opentelemetry/sdk-metrics` (now a runtime dependency of `apps/server`, core's major 2) |

Deleted (not ported): `agency/attempt-batcher.ts`, `agency/attempt-batch-reference.ts` (billing; B1 listed the batch reference), `agency/dnc-outbox.ts`, `agency/dnc-resync.ts` (B8; B1 listed them), `agency/agency-s2s-contract.fixture.json` (retires).

### 6.3 Hop collapses (every core ↔ master call the runtime made)

| Core call (`src/…`@4850d1d9) | Master's receiving handler (@a1f0756a) | In agency | Equivalence test |
|---|---|---|---|
| `AgencyAttemptBatcher` hourly + `flushCampaign` post (`agency/attempt-batcher.ts`, wired `runtime.ts:120-122`, `pacing-engine.ts` finalize) | `webhook-core.routes.ts:939` `POST /webhooks/core/agency-attempts-completed` (settlement) | **deleted** (no billing, plan §2/§8). `idx_agency_attempts_billing` stays for metering | `unit/agency/runtime-collapses` (no batcher constructed/started/stopped; no network on start/stop); `unit/agency/exhaustion-completion` (finalize still single-writer, once per won transition) |
| `AgencyDncOutboxSweeper` forward of an agent's DNC mark (`agency/dnc-outbox.ts`, `runtime.ts:127,403-406,421-428`) | `internal-agency.routes.ts:224` `POST /internal/agency/dnc` | **collapsed by B1**: `markDnc` writes `dnc_entries` directly (its caller is the Phase 8 DNC route); the sweeper is deleted | B1's `integration/agency/dnc-registry`; here `integration/agency/agency-dnc-runtime-wiring` (rewritten: no outbox row, no network, a fresh runtime reads the same row) |
| `createDncResyncRequester()` self-heal (`agency/dnc-resync.ts`, `runtime.ts:110`) | `internal-agency.routes.ts:344` `POST /internal/agency/dnc-resync` | **deleted** (B8: no Redis set to resync) | `integration/agency/chaos/dnc-self-heal-loop` (rewritten: a real `dnc_entries` read fault halts the whole batch; recovery comes from the table) |
| (none — core never emitted it) campaign completion | `webhook-core.routes.ts:1058-1215` `POST /webhooks/core/agency-campaign-completed` → lane A's `sendAgencyCampaignCompletionEmail` | `PacingEngine.registerCompletionNotifier` → `agency/campaign-completion-notice.ts` (handler body: notifier awaited, `agency_campaign_notifications_total` by result, `threw` arm; HMAC/validator/webhook series gone) | `unit/agency/campaign-completion-notice` (6), `unit/agency/exhaustion-completion` (called once, only when won, never rethrows), `integration/agency/runtime-e2e` (a real completed campaign reaches it: exactly one `agency_campaign_notifications_total{tenant_id}` series, value 1, not `threw`, read off a real SDK collection; and `pendingNoticeCount()` back to 0 before teardown) |
| Bridge settlement `webrtc-completed` | `webhook-core.routes.ts:828` | deleted by lane C | lane C |
| Caller-ID validation | — | **not a runtime hop**: the runtime only reads `campaign.caller_ids` (`usableCallerIds`); caller-ID ownership is checked on campaign WRITES, which are Phase 8's routes | — |

The DNC gate itself: core asked a Redis set master published into; now `pre-dial-gates.ts` asks `DncRegistry.check(tenant, phone, { accountId, campaignId })`, one read of `dnc_entries`, `unavailable` (→ `halt`) on any read fault.

### 6.4 Tests (source cases → printed; `it.each` rows counted)

Printed = what Vitest printed for the destination file (run from inside the package). Every
ported file carries a header listing its deleted and modified cases by name, and each modified
line is marked `// PORT NOTE`.

**Unit** (`apps/server/test/unit/agency/` unless noted)

| Source (core `test/unit/agency/`) | Src it( / each | Printed | Deleted / modified |
|---|---|---|---|
| `abandon-clip` | 16 / 0 | 11 | Deleted 5 (decision #4, TTS branch gone): "reports `failed` — not a throw — when synthesis blows up", "synthesizes a TTS apology with the announcement’s own voice and language", "defaults only the voice, and never the wording (D8)", "passes an unrecognised language through RAW rather than defaulting it", "interpolates NOTHING — an apology is about us, not the contact". Modified 3: the TTS-text `no_content` case → a non-`audio` row is `no_content`; "FOREIGN announcement" loses its `generateTtsAudio` assertion; "NOT memoized" driven by two audio rows |
| `abandon-clip-cache-roundtrip` | 5 / 0 | 5 | Real bridge on VoiceLink (answer = `start` frame, A-law `media` frames, hangup = PSTN socket closed); byte identity vs the bridge's A-law conversion of the bytes on disk |
| `abandon-reason-telemetry` | 26 / 0 | 26 | Harness only (config stub without `vobiz`, no `sip_connection_id`) |
| `abandoned-call-path` | 16 / 0 | 16 | Real bridge on VoiceLink, as above. "counts an answered call that NEVER BRIDGED": VoiceLink classifies every carrier end of an answered call `completed` (→ `abandoned` when unbridged), so the non-`abandoned` label the case needs is produced by `forceEndWithOutcome('service_shutdown')` (`orphaned`, core used a carrier `failed`); the counter assertions (keyed on the predicate) unchanged |
| `abandonment-guardrail` | 22 / 1 | 27 | verbatim (specifiers) |
| `abandonment-metrics` | 21 / 0 | 9 | Only the 9 cases B1 deferred by name (B1's `abandonment-window` has the rest, 19). "serves all five series on the :9090 scrape" asserts all five in one collection (no `:9090` scrape is ported) |
| `abandonment-otlp-export` | 11 / 0 | 11 | verbatim (specifiers) |
| `agency-dialer` | 28 / 0 | 28 | Fixture drops `sip_connection_id` |
| `agency-dialer-lineage` | 5 / 0 | 5 | as above |
| `agent-state-machine` | 15 / 0 | 15 | verbatim (paths) |
| `break-manager` | 18 / 0 | 18 | `packages/domain/test/unit/agency/`; paths only |
| `canceled-outcome-ledger` | 11 / 0 | 11 | Fixture drops `sip_connection_id` |
| `dial-dispatcher` | 7 / 0 | 7 | Logger specifier only |
| `exhaustion-completion` | 19 / 0 | 21 | NEW 2 (review fix): "stop() waits for a completion notice still in flight", "the drain is bounded: a notice that never settles cannot hold stop() forever". RENAMED: "a failing billing flush does not abort finalization" → "a failing completion notice does not abort finalization". The three attempt-batcher cases keep their names (bar that rename) and now assert the completion notifier (equivalence): a LOSING leader notifies nobody; a WINNING leader notifies exactly once with `(updated row, 'completed')`; a rejecting notifier does not abort finalization (`list_exhausted` still announced, no unhandled rejection escapes) |
| `late-binding` | 30 / 0 | 30 | Fixture drops `sip_connection_id` |
| `live-concurrency-metrics` | 19 / 0 | 18 | Deleted: "a collection-time fault elsewhere cannot fail the whole /metrics response" (`renderPrometheusScrape` and `/metrics` are not ported). `collectProm` reads the same SDK collection as the OTLP view (no `:9090` scrape exists), so its "both views" assertions read one view twice. RENAMED so no name claims two exporters (core's name in a PORT NOTE beside each): describe "a snapshot reaches BOTH views" → "a snapshot reaches the metric collection"; "serves the series on the :9090 scrape AND in the collection OTLP exports" → "serves the series in the SDK collection (core compared …)"; "reports identical values on both, from one publish" → "reports the published values, from one publish"; "resolves them to DIFFERENT series, on both views" → "resolves them to DIFFERENT series" |
| `pacing-engine` | 62 / 1 | 67 | Import/mock paths only (no batcher case existed) |
| `pacing-engine-gates` | 22 / 0 | 22 | "only asks the DNC set once per contact" asserts `check(t, phone, { accountId: 'a1', campaignId: 'camp-1' })` |
| `pre-dial-gates` | 20 / 0 | 20 | Fixture gains `account_id`; "asks the DNC set for this tenant and this number" asserts the exact scope |
| `presence-resilience` | 16 / 0 | 14 | Deleted 2 (softphone `createCall`/`attachBrowserLeg`, deleted by lane C): "T-B5: an owned socket still closes at teardown and still hangs up on close", "T-B5: destroy() still CLOSES an owned browser socket". Real bridge on VoiceLink; failure mode 4 asserts the PSTN leg closed (VoiceLink's only hangup) then drives `call.ended`; failure modes 2/3 add `pstn.closeCalls === 0` / `session.ending === false` so they cannot pass vacuously on VoiceLink |
| `reaper` | 41 / 0 | 41 | Part B (real bridge) on VoiceLink; "reaps the same attempt once the window has actually lapsed" drives the carrier's `call.ended` (an answered VoiceLink hangup waits for it) |
| `station-heartbeat-grace` | 19 / 0 | 19 | `agencyRoutes` → `registerStationSocket` (same handler body, same prefix); `auth.middleware`/settlement mocks removed |
| `station-registry` | 29 / 0 | 29 | paths only |
| `station-supersede-stomp` | 10 / 0 | 10 | as heartbeat-grace |
| `station-token` | 5 / 0 | 5 | paths only |
| `wrapup-manager` | 34 / 0 | 34 | paths only |
| core `test/unit/utils/metrics.test.ts` (agency describes, 3 + 4) + `metrics-otlp-contract.test.ts` (3) | 10 | 8 (`packages/observability/test/metrics-agency.test.ts`) | Deleted 2 (B8): the `agency_dnc_synced` cases. Contract over core's agency rows of `otlp-instruments.json` (15 rows; the 2 batcher and 4 DNC-set rows removed), copied to `test/fixtures/agency-otlp-instruments.json`; captures filtered to `agency_*` (the file also holds B2's S3 series) |
| master `test/unit/api/agency-reaper-wiring.test.ts` | 4 / 0 | 4 (`test/unit/bootstrap/agency-reaper-wiring.test.ts`) | scrapes `src/bootstrap/agency.ts` instead of `src/index.ts`; regexes verbatim |
| (new) `runtime-collapses` | — | 6 | §6.3 equivalence: no batcher/outbox, DB-backed DNC registry (+ fail-closed), notifier on the seam, start/stop order, no network |
| (new) `campaign-completion-notice` | — | 6 | master's handler body in-process |
| (new) `test/unit/api/agency-station-route` | — | 2 | route from `onRoute`; 1011 with no runtime |

Not ported here: `station-reconnect-frame` (4; Phase 8, lead ruling), `dnc-resync` (19; deleted B8), master `dnc/internal-agency.routes` (32; see §6.1).

**Integration** (`apps/server/test/integration/agency/`, real Postgres 5436 + Redis 6383 db 7)

| Source (core `test/integration/agency/`) | Src it( / each | Printed | Deleted / modified |
|---|---|---|---|
| `agency-agent-cas` | 6 / 0 | 6 | Worktree Redis; contender clients drop core's `keyPrefix: 'test:'` (agency's shared client has none) |
| `agency-agent-state-cycle` | 1 / 0 | — | **Stopped → Phase 8**: drives core's `agencyRoutes` (`POST /sessions`, `/available`, `/break`, `/break/cancel`, `/force-available`, `/leave`, `agency-agent-state-cycle.test.ts:135,332`), none of which is Phase 6's |
| `agency-context-ordering` | 9 / 0 | 9 | imports/mocks |
| `agency-crash-recovery` | 6 / 0 | 6 | UUID agent ids; `new DncRegistry(null, '')` (answers `unavailable` to everything) → a registry whose `findSuppressed` throws (same answer) |
| `agency-dnc-runtime-wiring` | 1 / 0 | 1 | Rewritten (B8): the runtime boots with the DB-backed gate, no network, no `agency_dnc_outbox` write, a fresh runtime reads the same `dnc_entries` row, an unreadable table answers `unavailable` |
| `agency-double-reservation` | 9 / 0 | 9 | UUID ids; `applyReplace` baselines removed (`check()` must still answer `clear`) |
| `agency-gate-skip-logging` | 2 / 0 | 2 | DNC case inserts a `dnc_entries` row instead of `applyReplace` |
| `agency-lease-ring-duration` | 3 / 1 | 6 | worktree Redis db |
| `agency-reaper-sql` | 12 / 0 | 12 | imports/mocks |
| `chaos/harness.ts` | — | — | ScriptedBridge design verbatim; `CHAOS_DB` read off the worktree URL; agent ids `uuidFor`; `makeTenantDncAuthoritative` no longer publishes but still asserts `check()` is `clear` with the campaign's scope |
| `chaos/restart-mid-bridge` | 2 / 0 | 2 | plumbing |
| `chaos/roster-exactly-once` | 8 / 0 | 8 | plumbing |
| `chaos/abandonment-predicate-agreement` | 3 / 0 | 3 | plumbing |
| `chaos/abandonment-counter-vs-table` | 9 / 0 | 9 | metric reader path |
| `chaos/attempt-number-collision` | 6 / 0 | 6 | UUID defaults |
| `chaos/network-drop-during-ring` | 7 / 0 | 7 | plumbing |
| `chaos/lease-renewer-killed` | 5 / 0 | 5 | plumbing |
| `chaos/redis-expired-wholesale` | 8 / 0 | 8 | "an agent who re-attaches after the flush is dialable again": core expected a fail-closed pause until the DNC set was re-published; under B8 the list survives a Redis flush, so the case asserts the next tick dials, no `dnc_unavailable` halt is counted, and the dials were `cleared` by the gate |
| `chaos/dnc-self-heal-loop` | 3 / 0 | 2 | Rewritten (B8) on a real `dnc_entries` read fault (table renamed, restored in `finally`): the whole batch halts (no dial, no attempt row, contacts back to `pending`, agents back to `available`); recovery comes from the table (the listed number ends `suppressed`/`dnc`, its neighbour dials); ten ticks inside the fault stay halted. Deleted: "guards the guard — the fixture…" (the S2S fixture and both hops are gone) |
| (new) `runtime-e2e` | — | 1 | the exit-gate end-to-end (§6.1); boots the way `src/index.ts` does (`startVoice` → `startAgency` → `startAnalysis`, never importing `index.ts`; analysis hooks are registered by `startAnalysis`, not by the test), stops in reverse (analysis, agency, voice). Asserts the completion notice ran and settled (§6.3 row 4). Teardown closes the station and waits for the server's close handler (session `offline`) before closing Redis/the pool |
| (new) `runtime-boot-order` | — | 3 | the lead's order pin (core `src/index.ts:353-354`, `:856-857`, `:977-984`): a scrape that `index.ts` starts voice before agency, has exactly one `await app.listen(` and it comes after `startAgency` and `startAnalysis`, and stops reversed; then `startVoice` → `startAgency` on real PG/Redis with a led, ticking campaign, asserting (a) the startup self-heal COMPLETED before `runtime.start()`, and the startup reaper COMPLETED before `pacing.start()`; (b) zero `pacing.tickOnce` calls once the agency stop began, nothing led after, and `runtime.stop()` COMPLETED before `bridge.gracefulShutdown()` began. Case 3: `resetAgencyRuntimeForTests()` stops a runtime `startAgency` started (stop called once, nothing led, singleton null, idempotent). Mutation checks below |

Exit gate (plan §8 Phase 6): all 9 chaos suites green against the fake carrier (50 cases).

**Boot/stop-order mutation checks** (`runtime-boot-order`, each run alone, file restored with `git checkout`, `git diff` empty after each):

| # | Mutation | Red assertion |
|---|---|---|
| M1 | `index.ts`: `startAgency` pushed before `startVoice` | scrape: voice index > agency index |
| M2 | `bootstrap/voice.ts`: `void guardHost.runSelfHealSweep('startup')` (not awaited) | (a) `selfHeal:startup:done` absent (−1) when `runtime.start` ran — by construction since the spy waits 100ms before `:done` (re-run after the review fix) |
| M3 | `runtime.ts` `start()`: `this.pacing.start()` before `await this.reaper.reapOnStartup()` | (a) `pacing.start` after `reaper.reapOnStartup:done` |
| M4 | `runtime.ts` `stop()`: `await this.pacing.stop()` removed | (b) `ticksAfterStop` 4, expected 0 |
| M5 | `bootstrap/agency.ts` stop: `void agencyRuntime.stop()` (not awaited) | (b) `bridge.drain` after `runtime.stop:done` |
| M6 | `index.ts`: `for (const stop of stops)` (not reversed) | scrape: `stops.reverse()` |
| L1 | `index.ts`: `app.listen` moved back to right after `buildApp` | scrape: listen index 1109 not > agency index (a second `listen` inserted instead reds the single-listen assertion) |
| R1 | `bootstrap/agency.ts`: reset no longer runs `activeStop` | case 3: `stop` called 0 times |

**Completion-notice drain mutation checks** (`unit/agency/exhaustion-completion`): N1 `await this.drainNotices()` removed from `pacing.stop()` → "stop() waits…" red (`settled` false); N2 the notice not added to `inFlightNotices` → both new cases red; N3 the drain unbounded (no `Promise.race` with the timer) → "the drain is bounded…" times out. **e2e:** removing `pacing.registerCompletionNotifier(...)` from `runtime.ts` → "timed out waiting for completion notice counted"; with the analysis worker unwired (before `POST_CALL_ANALYSIS_*` was set for `startAnalysis`) it timed out on the analysis job. Each restored, `git diff` empty.

The test calls `initFeatureFlagService(redis, keyPrefix)` itself: `index.ts` runs `buildApp` (which does it, main `35b9c57`) before the bootstraps, and this test boots no HTTP app. Its campaign has one pending contact and no agent, so it is led and ticks without dialing or finalizing.

**DNC fail-closed, the chaos rewrite (lead request).** Modified row, `chaos/dnc-self-heal-loop` (3 → 2):

| | Core @4850d1d9 | Agency |
|---|---|---|
| Fault | the tenant's Redis DNC set has no baseline (unsynced), so `DncRegistry.check` answers `unavailable` until master's resync (`POST /internal/agency/dnc-resync` over loopback) republishes it | a real `dnc_entries` read failure (the table renamed for the case, restored in `finally`), so `DncRegistry.check` → `findSuppressed` throws → `unavailable` |
| Why it changed | — | B8: there is no Redis set, no publish, no baseline and no resync; the only way the gate can fail to answer is the table read failing |
| Asserted | the halt aborts the whole claimed batch; recovery after the resync | the same halt (no dial, no attempt row, contacts back to `pending`, agents back to `available`); recovery when the table answers again (the listed number `suppressed`/`dnc`, its neighbour dialed); ten ticks inside the fault stay halted |
| Deleted | — | "guards the guard — the fixture…" (pins the S2S fixture and both hops, all gone) |
| Mutation check | — | `dnc-registry.ts:120` returning `'clear'` instead of `'unavailable'` on a read fault turns all 3 DNC fail-closed cases red (the 2 here + `agency-dnc-runtime-wiring`); restored, `git diff` empty |

`agency-agent-state-cycle` (1 case) → **Phase 8** (lead accepted): it drives core's session routes, which Phase 8 ports; hand it to phase-8.

### Phase 6 — resume notes

State at the head after the merge of main `979c8b5` (index.ts reordered at `7dc28e3`: platform → voice → agency → analysis, stops reversed; `initFeatureFlagService` wired in `buildApp` at `35b9c57`).

**Done (committed):** all 15 runtime modules + station socket + `bootstrap/agency.ts` + agency metrics (`6396468`); every unit, integration and chaos port (`f23e24f`, `6b43e57`, `ce5d28f`); the end-to-end test, the collapse/notifier unit tests, the station-route test and the reaper-wiring scrape (`6268844`); PORTING §6.1–6.4. Last full run before the merge (`c68bc88`): server lint 0, unit 4625 (+4 skipped), integration 87 files / 916; domain 50; observability 14; db 404; contracts 69.

**Resumed session (after main `8c76469`):** merged main (docs only; no lockfile change). The order pin is `integration/agency/runtime-boot-order.test.ts` (2), mutation-checked M1–M6 (§6.4); `runtime-e2e` now boots through `startVoice` → `startAgency` and stops in reverse. Full re-run at `a6fe781`: server lint 0, unit 239 files / 4626 (0 skipped), integration 89 files / 920; domain 50; observability 14; db 404; contracts 71. **Review fixes (lead, after the Fable review of `a6fe781`):** listen after the bootstraps; completion notices drained on stop; e2e boots `startAnalysis` and asserts the notice; M2 deterministic; reset stops a started runtime; naming/comment nits. Re-run: server lint 0, unit 239 / **4628** (+2 `exhaustion-completion`), integration 89 / **921** (+1 `runtime-boot-order` case 3); domain 50; observability 14; db 404; contracts 71; lint 0 in all five. Deltas vs `c68bc88`, all from main's commits merged at `033e2bd` plus this pin: unit +1 (`super-admin-phone` 8 → 9, `979c8b5`) and −4 skipped (`dimension-presets` byte-identity block deleted, `4cb3e51`); integration +2 files / +4 (`app/feature-flag-boot-wiring` 2, `35b9c57`; `runtime-boot-order` 2); contracts +2 (`rbac.test.ts` row for `agency.phone_numbers.read`, `bb1e581`, feeds two `it.each`). Every §6.4 row equals the per-file Vitest JSON.

**Left:** nothing.

**Open questions:** none blocking. For Phase 8: `getAgencyRuntime()`, `runtime.stations.connectedBySession`, `registerStationSocket` are ready; `agency-agent-state-cycle` and `station-reconnect-frame` are Phase 8's; Phase 8 owns `config/blocks/agency.ts`'s `agency` key (Phase 6 added no config).

## Phase 9 — super-admin UI

Source: cusui `magick-comms-cusui@ee5beb44`. Destination root: `apps/super-admin/src/`. The server side was
lane A's; the UI calls `/super-admin/*` through `saFetch` with its own JWT in `sessionStorage` (never Firebase).
Types come from `@magick-agency/contracts/api/platform/{super-admin,super-admin-usage,settings}`; cusui's
`types/super-admin.ts` and `types/phone-number.ts` are not copied.

### 9.1 Deviations the lead should see

| # | Deviation | Why |
|---|---|---|
| 1 | UI routes sit at the root (`/tenants`, `/tenants/:id`, `/users`, `/admins`, `/phone-numbers`, `/feature-flags`, `/usage`, `/audit`, `/login`), not under `/super-admin/*` | The API is `/super-admin/*` on the same origin (B16). A UI at the same prefix collides: the dev proxy (and any static host) would treat a page reload as an API call. cusui avoided it only because its SPA shared an origin with the customer app. `Navigate` sends `/` and unknown paths to `/tenants`. |
| 2 | `/super-admin` overview page deleted; `/` redirects to `/tenants` | The overview ranked tenants on credits, billed minutes, ledger balance and dispatch backlog from `GET /super-admin/usage/fleet`, which lane A deleted. The new usage-counts page is the only usage surface. |
| 3 | Login is its own page (`pages/auth/SuperAdminLoginPage`), the `isSuperAdmin` branch of cusui's `LoginPage` | This app has no Firebase sign-in, tabs, Google button, forgot-password, promo banner or festive decor. |
| 4 | No analytics: `captureApiError` / `api/error-analytics` and PostHog events are not carried | Not a super-admin concern; agency has no PostHog wiring in the UIs. |
| 5 | Brand system (`src/brand/*`, `brands/*`) replaced by a constant (`brand.ts`); `Logo` is a wordmark tile | One brand; no logo asset exists yet. |
| 6 | `saFetchRaw` deleted | Its only consumer was the usage CSV export (`downloadUsageExportChunk`), deleted with the credits usage routes. |
| 7 | Phone-number create picks `provider_id` from `GET /super-admin/telephony-providers` (active only), as cusui did | The lead restored master's read-only route on main (979c8b5). The earlier inventory-derived picker and "Provider id (UUID)" fallback are gone. `TelephonyProvider` lives in `api/super-admin.ts` (the contract has none) without `live_transfer_enabled`. |
| 8 | Provider-concurrency modal: the row set is seeded as cusui did, but from `GET /telephony-providers` (active providers at 0) overlaid with `allocation.providers`, so a `legacy_total` account shows the snapshot rows `switchToLegacy` keeps (`provider-concurrency.repository.ts:233-247`); retry-sync, and the `providers` / `entitlements` / `synchronization` parts of the detail, removed | Contract `AccountConcurrencyDetail` is `{ allocation, utilization }` (no embedded catalog); `retry-sync` was not ported (no second service). |
| 9 | `api/super-admin.ts` `createPhoneNumber` / `updatePhoneNumber` return `{ phone_number }` | The server answers `{ phone_number }` (`super-admin-phone.routes.ts:98,176`); cusui typed a flat row it never read. |

### 9.2 Source files

| Source @ee5beb44 | Destination | Status | Reason |
|---|---|---|---|
| `src/api/super-admin.ts` | `api/super-admin.ts` | modified | `listTelephonyProviders` kept (read only); `saFetch`, `saError`, `firstIssueMessage` and token helpers verbatim; analytics calls and `saFetchRaw` removed; login redirect is `/login`; types from contracts. Deleted functions: `deleteTenant`, `topupCredits`, `deductCredits`, `reconcileCredits`, `updateTenantSettings`, `retryProviderConcurrencySync`, `getTenantCreditTransactions`, all dispatch-lane functions, `createTelephonyProvider`, `updateTelephonyProvider`. NEW: `changeMembershipRole`, `revokeMembership`, `getAccountSettings`, `updateAccountSettings`, `getUsageCounts`. `addUserToTenant` / `createTenant` take the contract bodies (`account_id`). Concurrency types moved to contracts |
| (new) | `api/saRoutes.ts` | new | The list of `{ method, path }` the UI calls, checked against the server by `saRoutes.test.ts` |
| `src/api/superAdminAlerts.ts` | — | deleted | Voice alert definitions forward to core (lane A did not port `super-admin-alerts`) |
| `src/api/superAdminTelephony.ts` | — | deleted | BYOC telephony credentials and numbers (AI telephony, plan §3.4) |
| `src/api/superAdminUsage.ts` | — | deleted | `GET /super-admin/usage/{summary,fleet,records,export*}`, credits usage deleted by lane A |
| `src/contexts/SuperAdminContext.tsx` | `contexts/SuperAdminContext.tsx` | verbatim (imports) | |
| `src/contexts/ToastContext.tsx`, `src/components/common/{Toast,RequestId}.tsx` | same | verbatim | Used by the ported pages |
| `src/components/auth/RequireSuperAdmin.tsx` | same | modified | `/login` instead of `/login?super-admin=true` |
| `src/components/layout/SuperAdminLayout.tsx` (+css) | same | modified | Logout goes to `/login` |
| `src/components/layout/SuperAdminSidebar.tsx` (+css) | same | modified | Nav trimmed to Tenants, Users, Admins, Phone Numbers, Feature Flags, Usage, Audit Log, at root paths. Removed: Overview, Providers, Governance, Dispatch lanes, Voice Alerts |
| `src/pages/auth/LoginPage.tsx` (+css) | `pages/auth/SuperAdminLoginPage.tsx` (+css) | modified | See 9.1 #3 |
| `src/pages/super-admin/SATenantsPage.tsx` (+css) | same | modified | Credits column and `formatCredits` removed; `/tenants/:id` link |
| `src/pages/super-admin/SATenantDetailPage.tsx` (+css) | same | modified | Removed: credits panel, top-up, deduct, reconcile and drift, transaction ledger, tenant Delete, Service Configuration (`ServiceConfigForm`, AI pipelines), Telephony tab, retry-sync and the providers/entitlements/synchronization parts of the concurrency modal. Kept: header, tabs (Overview = phone numbers, Service, Feature Flags, Members), assign/unassign, legacy-total editor, versioned provider allocation (rows seeded from `listTelephonyProviders`) with 409 force-migration flow. NEW: per-account settings panel (`allow_recording`, `analyze_calls`, `webrtc_max_duration_seconds` 60..14400 via `parseStrictInteger`, PATCH of changed fields only, `max_concurrent_calls` read-only), Members: change role and revoke (reports `staffing_closed`), add user with optional `account_id` and the `agent` role |
| `src/pages/super-admin/SAUsersPage.tsx`, `SAAdminsPage.tsx` (+css) | same | verbatim (imports) | |
| `src/pages/super-admin/SAAuditPage.tsx` (+css) | same | modified | Action-label map pruned of deleted actions (`delete_tenant`, `topup_credits`, `deduct_credits`, `reconcile_credit_cache`, `usage.viewed`, `usage.fleet.viewed`, `usage.exported`, `credits.transactions.viewed`, `dispatch_lane.updated`, `dispatch_lane.reset`) and extended with `change_membership_role`, `revoke_membership`, `update_account_settings` |
| `src/pages/super-admin/SAPhoneNumbersPage.tsx` (+css) | same | modified | Provider writes (create/update), signup pool (`pool_eligible` stat, column, badge, both toggles, help text) removed; `listTelephonyProviders` kept for the picker and filter; see 9.1 #7 |
| `src/pages/super-admin/SAFeatureFlagsPage.tsx` (+css) | same | verbatim (imports) | |
| `src/components/super-admin/{TenantFeatureFlags,TenantPicker}.tsx` (+css) | same | verbatim (imports) | |
| `src/components/super-admin/feature-flags/*` | same | verbatim, except `flagUtils.ts` and `OverrideReasonDialog.tsx` | `flagUtils.ts` modified (also the `canEditAtScope` doc comment, which named `prewarm_*` as live flags): `whatsapp` and `sip` tokens, and the SIP / knowledge-base / catalog / document-page labels and bounds (`max_sip_connections`, `max_knowledge_bases`, `max_catalog_rows`, `max_document_pages`, `max_kb_documents`) deleted. `OverrideReasonDialog.tsx`: example in a comment renamed |
| `src/hooks/useSuperAdmin{Admins,Audit,Tenant,Tenants,Users}.ts` | same | verbatim (imports) | |
| `src/hooks/useSuperAdminUsage.ts`, `useSuperAdminFleet.ts` | — | deleted | Read the deleted credits/fleet usage routes. Replaced by NEW `hooks/useSuperAdminUsageCounts.ts` |
| `src/hooks/useSuperAdminByocPhoneNumbers.ts`, `useSuperAdminTelephonyCredentials.ts` | — | deleted | BYOC / AI telephony |
| `src/pages/super-admin/SAUsagePage.tsx` | `pages/super-admin/SAUsagePage.tsx` | new (source deleted) | Credits/fleet usage view replaced by the plan §3.3 counts view: period presets 7/30/90 days or a custom range, half-open `[from, to)` (the end day plus one), refused above 400 days before any request, tenant and account filters in the URL. Seconds are shown exactly, with no rounding rule (that is a metering decision) |
| `src/pages/super-admin/SAOverviewPage.tsx` | — | deleted | See 9.1 #2 |
| `src/pages/super-admin/SAProvidersPage.tsx` | — | deleted | Telephony-provider CRUD (routes deleted; one seeded provider) |
| `src/pages/super-admin/SAGovernancePage.tsx`, `components/super-admin/governance/*` | — | deleted | Governance is replaced by per-account settings (plan §3.2) |
| `src/pages/super-admin/SADispatchLanesPage.tsx`, `SAAlertsPage.tsx` | — | deleted | Dispatch lanes and voice alerts are out (plan §3.4); the routes were not ported |
| `src/components/super-admin/ByocPhoneNumbersPanel.tsx`, `TenantTelephonyCredentials.tsx` (+css) | — | deleted | BYOC and AI telephony credentials |
| `src/components/settings/ServiceConfigForm.tsx` | — | deleted | AI pipeline and provider allow-lists |
| `src/utils/{saStatus,tenant-search,strictInteger,localDayBounds,errors}.ts` | same | verbatim | |
| `src/utils/format.ts` | same | modified | `formatCredits`, `formatCreditsExact`, `formatLedgerMillicredits` deleted; nothing else uses millicredits |
| `src/config/telephonyProviders.ts` | `config/telephonyProviders.ts` | modified | BYOC badge constants deleted; alias map kept |
| `src/components/common/{DataTable,PageHeader,ErrorAlert,ErrorText,EmptyState,StatusBadge,Modal,StatCard,LoadingSpinner,Pagination,ConfirmDialog,AdvancedSection,Breadcrumbs,LiveDot,HelpTooltip}.tsx` (+css), `hooks/useCountUp.ts` | same | verbatim | The pieces the ported pages use. `common/index.ts` is trimmed to them |
| `src/components/common/Logo.tsx`, `src/brand/*`, `src/config.ts` | `Logo.tsx`, `brand.ts`, `config.ts` | modified | See 9.1 #5; `config.ts` keeps `API_BASE`, `ORIGINATOR_HEADER`, `ORIGINATOR` only |
| `src/global.css` | `global.css` | verbatim | |
| `vite.config.ts` (scaffold) | `vite.config.ts` | modified | Dev proxy is `/super-admin` → server 3021 (was `/api`) |
| (scaffold) `__tests__/App.test.tsx` | same | modified | The one-line shell test is replaced by four routing tests |

### 9.3 Tests

Count = cusui `it`/`test` cases (an `it.each` counts its rows; a loop that generates cases counts its iterations)
against this app's printed count.

| Source test @ee5beb44 | Destination | Source → here | Status | Notes |
|---|---|---|---|---|
| `__tests__/saStatus.test.ts` | `__tests__/saStatus.test.ts` | 21 → 21 | verbatim | |
| `__tests__/utils/tenant-search.test.ts` | same | 13 → 13 | verbatim | |
| `__tests__/contexts/SuperAdminContext.test.tsx` | same | 12 → 12 | verbatim | |
| `__tests__/components/OverrideReasonDialog.test.tsx` | same | 6 → 6 | verbatim | |
| `__tests__/components/ConfirmDialog.test.tsx` | same | 4 → 4 | verbatim | Targets the feature-flags `ConfirmDialog` |
| `__tests__/components/BulkRolloutModal.test.tsx` | same | 14 → 14 | modified | Fixture flag key renamed |
| `__tests__/components/TenantFeatureFlags.test.tsx` | same | 45 → 45 | modified | Fixture flag key renamed (42 `it` + one 4-case loop) |
| `__tests__/components/TenantPicker.test.tsx` | same | 16 → 16 | verbatim | |
| `__tests__/components/TriStateControl.test.tsx` | same | 12 → 12 | verbatim | |
| `__tests__/components/FlagDialog.test.tsx` | same | 10 → 10 | verbatim | |
| `__tests__/components/flagUtils.test.ts` | same | 9 → 9 | verbatim | |
| `__tests__/pages/SAFeatureFlagsPage.test.tsx` | same | 34 → 34 | modified | Fixture rename; the search case now searches "next-gen" |
| `__tests__/pages/SAUsersPage.test.tsx` | same | 9 → 9 | modified | `credit_*` dropped from the tenant fixture |
| `__tests__/pages/SAAuditPage.test.tsx` | same | 1 → 1 | verbatim | |
| `__tests__/pages/SAPhoneNumbersPage.test.tsx` | same | 5 → 5 | modified | Deleted 3 `pool_eligible` cases (badge, create toggle, edit toggle); NEW 3 (picker lists active providers from the route and sends `provider_id`, picker works on an empty inventory with no free-text id, no pool UI and no `pool_eligible` on edit) |
| `__tests__/hooks/useSuperAdminTenant.test.ts` | same | 3 → 3 | modified | `credits` dropped from the fixture |
| `__tests__/pages/SATenantDetailPage.test.tsx` | same | 38 → 11 | modified | Deleted 28 (and 1 NEW: catalog seeding, mutation-checked by dropping the active filter and the seeding): Telephony tab (1), retry-sync (1), credit-cache drift (24), credit ledger (2). "routes each tab" modified; "force migration" modified (catalog now comes from `listTelephonyProviders`, mocked per test); `providers` catalog dropped from fixtures |
| (new) | `__tests__/pages/SATenantDetailPage.new.test.tsx` | — → 21 | new | Settings validation and PATCH body, role change, revoke and staffing note, add user with `account_id`. Mutation-checked: loosening the 60..14400 check reds 2; removing the `revokeMembership` call reds 3 |
| `__tests__/api/saFetchRaw.test.ts` | `__tests__/api/saFetch.test.ts` | 31 → 29 | modified | 15 `saError` cases verbatim; 13 `saFetchRaw` cases now drive `saFetch`; deleted: "returns the raw Response", "does NOT call res.json()", the analytics event case; 401 redirect is `/login` |
| `__tests__/api/originator-header.test.ts` | folded into `saFetch.test.ts` | 11 → 1 | modified | Only the super-admin `saFetch` case applies; the `saFetchRaw` case is deleted with `saFetchRaw`; the other 9 cover customer-API modules |
| (new) | `__tests__/api/saRoutes.test.ts` | — → 45 | new | Every exported API function fetches a method+path in `SA_ROUTES`; every `SA_ROUTES` entry is a route registered under `apps/server/src/api/routes/super-admin*.ts` (regex extraction, not Fastify's `onRoute`: the UI package cannot import the server, which exits on invalid config); every server route the UI does not call is on an explicit allow-list with a reason (today only `GET /feature-flags/:flagKey`) |
| (new) | `__tests__/hooks/useSuperAdminUsageCounts.test.ts`, `__tests__/pages/SAUsagePage.test.tsx` | — → 15, 22 | new | Window maths, 400-day refusal before any fetch, exclusive end day, URL params, totals, empty and error states. Mutation-checked: 400-day guard off reds 3, dropping the `+1` day reds 4 |
| (new) | `__tests__/App.test.tsx` | 1 (scaffold) → 4 | new | Login redirect, sign-in, nav shows exactly the kept surfaces, unknown path falls back |

Deleted with the module (source counts):

| Source test @ee5beb44 | Cases | Reason |
|---|---|---|
| `__tests__/hooks/useSuperAdminUsage.test.ts` | 95 | Credits usage hook |
| `__tests__/hooks/useSuperAdminFleet.test.ts` | 2 | Fleet usage hook |
| `__tests__/api/superAdminUsage.test.ts` | 30 | Credits usage API |
| `__tests__/api/superAdminAlerts.test.ts` | 6 | Voice alerts |
| `__tests__/api/superAdminReconcileCredits.test.ts` | 3 | Credits |
| `__tests__/api/superAdminTelephonyProviders.test.ts` | 2 | Telephony-provider CRUD |
| `__tests__/pages/SAUsagePage.test.tsx` | 95 | Credits usage page (replaced by the NEW counts page's tests) |
| `__tests__/pages/SAOverviewPage.test.tsx` | 9 | Fleet overview |
| `__tests__/pages/SAProvidersPage.test.tsx`, `SAProvidersPageSwitchCss.test.ts`, `SAProvidersPage.wire.test.tsx` | 18 + 5 + 1 | Providers page |
| `__tests__/pages/SAGovernancePage.test.tsx` | 5 | Governance |
| `__tests__/pages/SAAlertsPage.test.tsx`, `SADispatchLanesPage.test.tsx` | 12 + 5 | Alerts, dispatch lanes |
| `__tests__/components/TenantTelephonyCredentials.test.tsx` | 22 | BYOC credentials |

### 9.4 Printed counts (from `apps/super-admin`)

`pnpm lint` 0 errors; `pnpm test`: 23 files, 361 passed; `pnpm build` ok. Dependency added: `lucide-react@^0.500.0` (cusui's version).

### 9.5 Branding: no MagickVoice links (decision B17)

| Source @ee5beb44 | Destination | Status | Change and test |
|---|---|---|---|
| `src/pages/auth/LoginPage.tsx` (super-admin branch), `src/pages/super-admin/SAAdminsPage.tsx` | `pages/auth/SuperAdminLoginPage.tsx`, `pages/super-admin/SAAdminsPage.tsx` | modified | Email placeholder `admin@magickvoice.com` → `admin@example.com` |
| `src/config.ts` | `config.ts` | modified | `ORIGINATOR` `magick-agency-super-admin-ui` → `magick-agency-super-admin` (`${brand.id}-super-admin`). Header name `x-mgkvc-originator` unchanged (wire) |
| — | `src/__tests__/branding/noParentBrand.test.ts` | NEW (4) | Fails on any `magick[ -_]?voice` / `magic[ -_]?voice` (case-insensitive) left in non-test `src/**` (`.ts .tsx .css .json .html`), `index.html` or `vite.config.ts` after comments are stripped; pins `brand.id`/`brand.name` and `ORIGINATOR`; tests its own comment stripper. Mutation: the `SAAdminsPage` placeholder restored → 1 red |

Printed after B17 (`apps/super-admin`): `pnpm lint` 0 errors; `pnpm test`: 24 files, 365 passed (361 + 4 new); `pnpm build` ok.

Review follow-ups (`4824a58`): the guard's stripper no longer treats the `//` of a URL scheme as a comment (NEW case
"sees unquoted URLs…", 5 cases; mutation: rule removed → that case red); `index.html` declares `<link rel="icon"
href="data:,">`. Printed: 24 files, 366 passed.

## Phase 8 — API (branch `phase-8/api`)

Sources: core `magic-voice-core@4850d1d9`, master `magick-master@a1f0756a`, cusui `magick-comms-cusui@ee5beb44`.
Decision B16: the API serves the console's paths; each master handler keeps its validation, RBAC,
MAG-138 checks and enrichment, and its hop to core runs core's handler body in-process through
`callCore` (`apps/server/src/api/core-dispatch.ts`) on a private Fastify instance that is never
listened on (`core-handlers.ts`). Lead rulings applied: `callCore` approved (static resolution test;
tenancy from lane A's context only; per-family real-Postgres effects); master's errorHandler and the
error mask's 5xx branch app-wide, core-4xx branch dropped; flags stay at `GET /feature-flags`;
profiles at `/proxy/call-analysis-profiles`; `GET /phone-numbers` is Phase 8's; no `trustProxy` (Q7).

### 8.0 State

- **Done.** Every console path in cusui's inventory is served or listed as not served (§8.1); the 12 runtime
  paths landed after Phase 6 merged (main `6baec61`, merged here as `46a6d6a`): core's `agency.routes.ts`
  session and attempt handlers on the private core instance, master's `proxy-agency-agent.routes.ts` in front
  of them, and the station socket at `/proxy/agency/station/:sessionId` (master's
  `proxy-agency-station.routes.ts`, collapsed in-process onto Phase 6's `handleStationSocket`). Core's own
  station path is no longer registered (the console never called it). Every runtime read of the agency
  runtime is a per-request lookup (`getAgencyRuntime()`), never a reference captured in `buildApp`.
- **Review fixes folded in** (reviews of `5d407a9`): the limiter's API-key bucket deleted (BLOCKING), master's
  `genReqId`, the stats strip's runtime read made lazy, missing-account 400s on behavioural writes and the
  recording media route, stale-comment PORT NOTEs (invites, DNC routes, contracts `webrtc-call.ts`), the
  inventory's `ingest/upload` row, isolation for ingest jobs / recording / CSV exports / `/my-campaigns`.
- **Access-control audit of the runtime routes** (lead request after a scan flag on `4f2c4a1`): §8.8.
- **Delta review round on `0696e46`** (no blocking): audit buffers started and flushed by the platform
  bootstrap; public `maxParamLength: 200`; `markDnc`'s `refused` comment and in-transaction log line; the
  sibling recording isolation leg, the `suppressByPhone` client pin, the session-gap blast radius on the
  station socket, the outbox tripwire note (rows below).

### 8.1 Console and super-admin path inventory

Source: `apps/server/test/fixtures/console-paths.json` (360 entries: every HTTP and WebSocket call in cusui @ `ee5beb44` `src/api/*`, `src/config.ts` and the station/browser-call hooks). The route-table test (`test/unit/api/agency-route-table.test.ts`) enumerates the real app's routes from `onRoute` and fails if a served row is not registered, a not-served row is, or a registered route is in neither list. Core hops are read from the source by `test/unit/api/core-dispatch.test.ts` (static resolution) and listed here per handler.

**Served: agency routes (62)**

| Path | cusui | Master handler (in this repo) | Core handler run in-process (`callCore`) | Needs the runtime |
|---|---|---|---|---|
| `DELETE /dnc/:id` | src/api/dnc.ts:86 | master `dnc.routes.ts` (line 293) | — (master-native) | no |
| `DELETE /proxy/agency/campaigns/:id/agents/:userId` | src/api/agency.ts:505 | master `proxy-agency-staffing.routes.ts` (line 976) | `GET /api/v1/agency-campaigns/:_` | no |
| `DELETE /proxy/call-analysis-profiles/:id` | src/api/call-analysis-profiles.ts:80 | master `proxy-call-analysis-profiles.routes.ts` (passthrough; its chain is `profile-route-auth.ts`) | core `call-analysis-profiles.routes.ts` handler (lane D port, line 494), mounted at this path — no hop | no |
| `GET /dnc` | src/api/dnc.ts:40 | master `dnc.routes.ts` (line 151) | — (master-native) | no |
| `GET /phone-numbers` | src/api/phone-numbers.ts:12 | master `phone-number.routes.ts` (line 36) | — (master-native) | no |
| `GET /proxy/agency/agents/:userId/attempts` | src/api/agencyStats.ts:380 | master `proxy-agency-performance.routes.ts` (line 1255) | `GET /api/v1/agency-agents/:_/attempts` | no |
| `GET /proxy/agency/agents/:userId/stats` | src/api/agencyStats.ts:107 | master `proxy-agency-performance.routes.ts` (line 1181) | `GET /api/v1/agency-agents/:_/stats` | no |
| `GET /proxy/agency/agents/grouped-stats` | src/api/agencyStats.ts:298 | master `proxy-agency-performance.routes.ts` (line 923) | `GET /api/v1/agency-agents/grouped-stats` | no |
| `GET /proxy/agency/agents/stats` | src/api/agencyStats.ts:190 | master `proxy-agency-performance.routes.ts` (line 627) | `GET /api/v1/agency-agents/stats` | no |
| `GET /proxy/agency/campaigns/:id/activity.csv` | src/api/agencyActivity.ts:96 | master `proxy-agency-campaigns.routes.ts` (line 1246) | `GET /api/v1/agency-campaigns/:_` | no |
| `GET /proxy/agency/campaigns/:id/activity` | src/api/agencyActivity.ts:43 | master `proxy-agency-campaigns.routes.ts` (line 1133) | `GET /api/v1/agency-campaigns/:_` | no |
| `GET /proxy/agency/campaigns/:id/agents` | src/api/agency.ts:463 | master `proxy-agency-staffing.routes.ts` (line 769) | `GET /api/v1/agency-campaigns/:_` | no |
| `GET /proxy/agency/campaigns/:id/attempts.csv` | src/api/agencySpine.ts:289 | master `proxy-agency-campaigns.routes.ts` (line 1713) | `GET /api/v1/agency-campaigns/:_`, `GET /api/v1/agency-campaigns/:_/attempts` | no |
| `GET /proxy/agency/campaigns/:id/attempts/:attemptId/recording` | src/api/agencySpine.ts:222 | master `proxy-agency-calls.routes.ts` (line 569) | `GET /api/v1/agency-campaigns/:_/attempts/:_/recording` | no |
| `GET /proxy/agency/campaigns/:id/attempts/:attemptId` | src/api/agencySpine.ts:156 | master `proxy-agency-calls.routes.ts` (line 496) | `GET /api/v1/agency-campaigns/:_/attempts/:_` | no |
| `GET /proxy/agency/campaigns/:id/attempts` | src/api/agencySpine.ts:76 | master `proxy-agency-campaigns.routes.ts` (line 1408) | `GET /api/v1/agency-campaigns/:_/attempts` | no |
| `GET /proxy/agency/campaigns/:id/contacts.csv` | src/api/agencySpine.ts:289 | master `proxy-agency-campaigns.routes.ts` (line 1761) | `GET /api/v1/agency-campaigns/:_`, `GET /api/v1/agency-campaigns/:_/contacts` | no |
| `GET /proxy/agency/campaigns/:id/contacts/:contactId` | src/api/agencySpine.ts:109 | master `proxy-agency-campaigns.routes.ts` (line 1474) | `GET /api/v1/agency-campaigns/:_/contacts/:_` | no |
| `GET /proxy/agency/campaigns/:id/contacts` | src/api/agencySpine.ts:94 | master `proxy-agency-campaigns.routes.ts` (line 1448) | `GET /api/v1/agency-campaigns/:_/contacts` | no |
| `GET /proxy/agency/campaigns/:id/lineage` | src/api/agencyCampaigns.ts:373 | master `proxy-agency-campaigns.routes.ts` (line 2588) | `GET /api/v1/agency-campaigns/:_/lineage` | no |
| `GET /proxy/agency/campaigns/:id/retry/preview` | src/api/agencyCampaigns.ts:321 | master `proxy-agency-campaigns.routes.ts` (line 2250) | `GET /api/v1/agency-campaigns/:_/retry/preview` | no |
| `GET /proxy/agency/campaigns/:id/stats/series` | src/api/agencyCampaignSeries.ts:52 | master `proxy-agency-campaigns.routes.ts` (line 999) | `GET /api/v1/agency-campaigns/:_/stats/series` | no |
| `GET /proxy/agency/campaigns/:id/stats` | src/api/agencyCampaigns.ts:256 | master `proxy-agency-campaigns.routes.ts` (line 901) | `GET /api/v1/agency-campaigns/:_/stats` | reads `runtime.stations.connectedBySession` (degrades to `connected: null` until Phase 6 is wired) |
| `GET /proxy/agency/campaigns/:id` | src/api/agencyCampaigns.ts:199 | master `proxy-agency-campaigns.routes.ts` (line 779) | `GET /api/v1/agency-campaigns/:_` | no |
| `GET /proxy/agency/campaigns` | src/api/agencyCampaigns.ts:186 | master `proxy-agency-campaigns.routes.ts` (line 766) | `GET /api/v1/agency-campaigns` | no |
| `GET /proxy/agency/ingest/jobs/:id/rejected.csv` | src/api/agencyCampaigns.ts:164 | master `proxy-agency-campaigns.routes.ts` (line 3114) | — (master-native) | no |
| `GET /proxy/agency/ingest/jobs/:id` | src/api/agencyCampaigns.ts:128 | master `proxy-agency-campaigns.routes.ts` (line 2846) | — (master-native) | no |
| `GET /proxy/agency/ingest/limits` | src/api/agencyCampaigns.ts:54 | master `proxy-agency-campaigns.routes.ts` (line 2608) | — (master-native) | no |
| `GET /proxy/agency/my-assignment` | src/api/agency.ts:396 | master `proxy-agency-staffing.routes.ts` (line 726) | `GET /api/v1/agency-campaigns/:_` | no |
| `GET /proxy/agency/my-assignments` | src/api/agency.ts:428 | master `proxy-agency-staffing.routes.ts` (line 533) | `GET /api/v1/agency-campaigns/:_` | no |
| `GET /proxy/agency/my-attempts` | src/api/agencyStats.ts:364 | master `proxy-agency-performance.routes.ts` (line 523) | `GET /api/v1/agency-agents/:_/attempts` | no |
| `GET /proxy/agency/my-campaigns` | src/api/agencyStats.ts:410 | master `proxy-agency-staffing.routes.ts` (line 651) | `GET /api/v1/agency-campaigns/:_` | no |
| `GET /proxy/agency/my-stats` | src/api/agencyStats.ts:84 | master `proxy-agency-performance.routes.ts` (line 478) | `GET /api/v1/agency-agents/:_/stats` | no |
| `GET /proxy/call-analysis-profiles/:id` | src/api/call-analysis-profiles.ts:41 | master `proxy-call-analysis-profiles.routes.ts` (passthrough; its chain is `profile-route-auth.ts`) | core `call-analysis-profiles.routes.ts` handler (lane D port, line 424), mounted at this path — no hop | no |
| `GET /proxy/call-analysis-profiles` | src/api/call-analysis-profiles.ts:28 | master `proxy-call-analysis-profiles.routes.ts` (passthrough; its chain is `profile-route-auth.ts`) | core `call-analysis-profiles.routes.ts` handler (lane D port, line 409), mounted at this path — no hop | no |
| `PATCH /proxy/agency/campaigns/:id` | src/api/agencyCampaigns.ts:230 | master `proxy-agency-campaigns.routes.ts` (line 792) | `PATCH /api/v1/agency-campaigns/:_` | no |
| `POST /dnc` | src/api/dnc.ts:72 | master `dnc.routes.ts` (line 200) | — (master-native) | no |
| `POST /proxy/agency/attempts/:id/disposition` | src/api/agency.ts:229 | master `proxy-agency-agent.routes.ts` (line 534) | `POST /api/v1/agency/attempts/:_/disposition` | yes |
| `POST /proxy/agency/attempts/:id/dnc` | src/api/agency.ts:276 | master `proxy-agency-agent.routes.ts` (line 676) | `POST /api/v1/agency/attempts/:_/dnc` | yes |
| `POST /proxy/agency/attempts/:id/hangup` | src/api/agency.ts:110 | master `proxy-agency-agent.routes.ts` (line 485) | `POST /api/v1/agency/attempts/:_/hangup` | yes |
| `POST /proxy/agency/attempts/:id/notes` | src/api/agency.ts:359 | master `proxy-agency-agent.routes.ts` (line 603) | `POST /api/v1/agency/attempts/:_/notes` | yes |
| `POST /proxy/agency/campaigns/:id/agents` | src/api/agency.ts:490 | master `proxy-agency-staffing.routes.ts` (line 818) | `GET /api/v1/agency-campaigns/:_` | no |
| `POST /proxy/agency/campaigns/:id/pause` | src/api/agencyCampaigns.ts:282 | master `proxy-agency-campaigns.routes.ts` (line 2054) | `POST /api/v1/agency-campaigns/:_/pause` | no |
| `POST /proxy/agency/campaigns/:id/resume` | src/api/agencyCampaigns.ts:282 | master `proxy-agency-campaigns.routes.ts` (line 2087) | `POST /api/v1/agency-campaigns/:_/resume` | no |
| `POST /proxy/agency/campaigns/:id/retry` | src/api/agencyCampaigns.ts:350 | master `proxy-agency-campaigns.routes.ts` (line 2299) | `GET /api/v1/agency-campaigns/:_`, `POST /api/v1/agency-campaigns/:_/retry` | no |
| `POST /proxy/agency/campaigns/:id/start` | src/api/agencyCampaigns.ts:282 | master `proxy-agency-campaigns.routes.ts` (line 2021) | `POST /api/v1/agency-campaigns/:_/start` | no |
| `POST /proxy/agency/campaigns/:id/stop` | src/api/agencyCampaigns.ts:282 | master `proxy-agency-campaigns.routes.ts` (line 2133) | `POST /api/v1/agency-campaigns/:_/stop` | no |
| `POST /proxy/agency/campaigns` | src/api/agencyCampaigns.ts:208 | master `proxy-agency-campaigns.routes.ts` (line 712) | `POST /api/v1/agency-campaigns` | no |
| `POST /proxy/agency/ingest/analyze` | src/api/agencyCampaigns.ts:96 | master `proxy-agency-campaigns.routes.ts` (line 2670) | — (master-native) | no |
| `POST /proxy/agency/ingest/jobs/:id/cancel` | src/api/agencyCampaigns.ts:144 | master `proxy-agency-campaigns.routes.ts` (line 2861) | — (master-native) | no |
| `POST /proxy/agency/ingest/jobs` | src/api/agencyCampaigns.ts:116 | master `proxy-agency-campaigns.routes.ts` (line 2706) | `GET /api/v1/agency-campaigns/:_` | no |
| `POST /proxy/agency/ingest/upload` | src/api/agencyCampaigns.ts:71 | master `proxy-agency-campaigns.routes.ts` (line 2635) | — (master-native) | no |
| `POST /proxy/agency/sessions/:id/available` | src/api/agency.ts:78 | master `proxy-agency-agent.routes.ts` (line 275) | `POST /api/v1/agency/sessions/:_/available` | yes |
| `POST /proxy/agency/sessions/:id/break/cancel` | src/api/agency.ts:163 | master `proxy-agency-agent.routes.ts` (line 387) | `POST /api/v1/agency/sessions/:_/break/cancel` | yes |
| `POST /proxy/agency/sessions/:id/break` | src/api/agency.ts:138 | master `proxy-agency-agent.routes.ts` (line 341) | `POST /api/v1/agency/sessions/:_/break` | yes |
| `POST /proxy/agency/sessions/:id/force-available` | src/api/agency.ts:201 | master `proxy-agency-agent.routes.ts` (line 430) | `POST /api/v1/agency/sessions/:_/force-available` | yes |
| `POST /proxy/agency/sessions/:id/leave` | src/api/agency.ts:92 | master `proxy-agency-agent.routes.ts` (line 287) | `POST /api/v1/agency/sessions/:_/leave` | yes |
| `POST /proxy/agency/sessions/:id/station-token` | src/api/agency.ts:64 | master `proxy-agency-agent.routes.ts` (line 321) | `POST /api/v1/agency/sessions/:_/station-token` | yes |
| `POST /proxy/agency/sessions` | src/api/agency.ts:43 | master `proxy-agency-agent.routes.ts` (line 208) | `POST /api/v1/agency/sessions` | yes |
| `POST /proxy/call-analysis-profiles` | src/api/call-analysis-profiles.ts:51 | master `proxy-call-analysis-profiles.routes.ts` (passthrough; its chain is `profile-route-auth.ts`) | core `call-analysis-profiles.routes.ts` handler (lane D port, line 355), mounted at this path — no hop | no |
| `PUT /proxy/call-analysis-profiles/:id` | src/api/call-analysis-profiles.ts:66 | master `proxy-call-analysis-profiles.routes.ts` (passthrough; its chain is `profile-route-auth.ts`) | core `call-analysis-profiles.routes.ts` handler (lane D port, line 436), mounted at this path — no hop | no |
| `WS /proxy/agency/station/:sessionId` | src/hooks/useAgencyStation.ts:1260 | master `proxy-agency-station.routes.ts` (line 99), collapsed | core `handleStationSocket` (`agency/station-socket.ts`, Phase 6), handed the socket in-process | yes |

**Served: platform and super-admin (lane A; 46)**

| Path | cusui | Handler | Note |
|---|---|---|---|
| `DELETE /super-admin/admins/:id` | src/api/super-admin.ts:464 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `DELETE /super-admin/feature-flags/:flagKey/overrides` | src/api/super-admin.ts:425 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `DELETE /super-admin/phone-numbers/:id/assign/:tenantId` | src/api/super-admin.ts:643 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `DELETE /super-admin/phone-numbers/:id` | src/api/super-admin.ts:624 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `DELETE /users/:id/membership` | src/api/users.ts:29 | lane A `user.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |
| `GET /accounts/mine` | src/api/accounts.ts:28 | lane A `account.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |
| `GET /accounts` | src/api/accounts.ts:6 | lane A `account.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |
| `GET /auth/me` | src/api/auth.ts:13 | lane A `auth.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |
| `GET /invites/:token` | src/api/invites.ts:176 | lane A `invites.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |
| `GET /notifications/preferences` | src/api/notifications.ts:25 | lane A `notification.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |
| `GET /super-admin/admins` | src/api/super-admin.ts:453 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /super-admin/audit` | src/api/super-admin.ts:496 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /super-admin/feature-flags/resolve` | src/api/super-admin.ts:408 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /super-admin/feature-flags` | src/api/super-admin.ts:399 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /super-admin/me` | src/api/super-admin.ts:201 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /super-admin/phone-numbers/:id` | src/api/super-admin.ts:593 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /super-admin/phone-numbers` | src/api/super-admin.ts:587 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /super-admin/telephony-providers` | src/api/super-admin.ts:551 | lane A `super-admin*.routes.ts` | super-admin provider list, read-only (lead 979c8b5: POST /super-admin/phone-numbers needs a provider_id to pick from); create/update stay not ported |
| `GET /super-admin/tenants/:id/accounts/:accountId/concurrency` | src/api/super-admin.ts:371 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /super-admin/tenants/:id/accounts` | src/api/super-admin.ts:352 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /super-admin/tenants/:id/phone-numbers` | src/api/super-admin.ts:650 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /super-admin/tenants/:id` | src/api/super-admin.ts:211 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /super-admin/tenants` | src/api/super-admin.ts:207 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /super-admin/users` | src/api/super-admin.ts:268 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `GET /tenants/:id/members` | src/api/tenants.ts:56 | lane A `tenant.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |
| `POST /auth/session` | src/api/auth.ts:6 | lane A `auth.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |
| `POST /invites/:token/claim` | src/api/invites.ts:223 | lane A `invites.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |
| `POST /invites/resend` | src/api/invites.ts:294 | lane A `invites.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |
| `POST /super-admin/admins/:id/reactivate` | src/api/super-admin.ts:468 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `POST /super-admin/admins` | src/api/super-admin.ts:457 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `POST /super-admin/feature-flags/:flagKey/overrides/bulk` | src/api/super-admin.ts:435 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `POST /super-admin/login` | src/api/super-admin.ts:177 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `POST /super-admin/phone-numbers/:id/assign` | src/api/super-admin.ts:636 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `POST /super-admin/phone-numbers/:id/delete` | src/api/super-admin.ts:632 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `POST /super-admin/phone-numbers/:id/reactivate` | src/api/super-admin.ts:628 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `POST /super-admin/phone-numbers` | src/api/super-admin.ts:605 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `POST /super-admin/tenants/:id/users` | src/api/super-admin.ts:226 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `POST /super-admin/tenants` | src/api/super-admin.ts:219 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `POST /users/invite` | src/api/users.ts:15 | lane A `user.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |
| `PUT /notifications/preferences` | src/api/notifications.ts:40 | lane A `notification.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |
| `PUT /super-admin/admins/:id/password` | src/api/super-admin.ts:475 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `PUT /super-admin/change-password` | src/api/super-admin.ts:444 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `PUT /super-admin/feature-flags/:flagKey/overrides` | src/api/super-admin.ts:415 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `PUT /super-admin/phone-numbers/:id` | src/api/super-admin.ts:617 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) |
| `PUT /super-admin/tenants/:id/accounts/:accountId/concurrency` | src/api/super-admin.ts:361 | lane A `super-admin*.routes.ts` | super-admin route ported by lane A (super-admin*.routes.ts) (also updateProviderConcurrency, src/api/super-admin.ts:381) |
| `PUT /users/:id/role` | src/api/users.ts:22 | lane A `user.routes.ts` | platform route ported by lane A (PORTING.md Lane A A.1/A.3) |

**Pending:** none. The 12 runtime paths (sessions, attempt actions, the station socket) are served since Phase 6 merged; `PENDING` in the route-table test is empty.

**Not served (252)**, each with its reason

| Path | cusui | Reason |
|---|---|---|
| `DELETE /accounts/:id` | src/api/accounts.ts:57 | tenant/account CRUD: not ported by lane A (no tenant.update / account.* permission in contracts rbac, decision Q3e) |
| `DELETE /api-keys/:id` | src/api/api-keys.ts:48 | platform API keys: not ported (plan §2 "API keys", decision #5) |
| `DELETE /contact-lists/:id` | src/api/contact-lists.ts:26 | bulk dispatch / contact lists: not ported (plan §2 "bulk dispatch") |
| `DELETE /phone-numbers/:id/inbound` | src/api/phone-numbers.ts:52 | tenant phone tagging / inbound routing: not ported (inbound is an AI surface; lane A ported the super-admin inventory only) |
| `DELETE /phone-numbers/:id/tags/:accountId` | src/api/phone-numbers.ts:26 | tenant phone tagging / inbound routing: not ported (inbound is an AI surface; lane A ported the super-admin inventory only) |
| `DELETE /proxy/announcements/:id` | src/api/announcements.ts:75 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `DELETE /proxy/audio-files/:id` | src/api/announcements.ts:203 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `DELETE /proxy/automations/:id` | src/api/automations.ts:87 | automations: not ported (plan §2, AI surface) |
| `DELETE /proxy/escalation-destinations/:id` | src/api/escalation.ts:69 | escalation destinations (AI live transfer): not ported (plan §2, AI surface) |
| `DELETE /proxy/ivr-workflows/:id` | src/api/ivr.ts:35 | IVR: not ported (plan §2, AI surface) |
| `DELETE /proxy/knowledge-bases/:id/documents/:docId` | src/api/documents.ts:161 | knowledge bases: not ported (plan §2, AI surface) |
| `DELETE /proxy/knowledge-bases/:id` | src/api/catalogs.ts:51 | knowledge bases: not ported (plan §2, AI surface) (also src/api/documents.ts:40) |
| `DELETE /proxy/messaging/connections/:id` | src/api/messaging.ts:90 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `DELETE /proxy/messaging/email-templates/:id` | src/api/messaging.ts:248 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `DELETE /proxy/messaging/media/:id` | src/api/messaging.ts:303 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `DELETE /proxy/messaging/templates/:id` | src/api/messaging.ts:178 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `DELETE /proxy/prompts/:id/tools/:toolId` | src/api/prompt-tools.ts:24 | prompts / AI tools: not ported (plan §2, AI surface) |
| `DELETE /proxy/prompts/:id` | src/api/prompts.ts:83 | prompts / AI tools: not ported (plan §2, AI surface) |
| `DELETE /proxy/sip/connections/:id` | src/api/sip.ts:53 | SIP connections: not ported (plan §2 "SIP", decision #5) |
| `DELETE /proxy/webrtc-call/:id/transcript` | src/api/webrtc-call.ts:145 | WebRTC softphone (dialer product, not agency): not ported (lane C deleted the softphone API, plan §2 "delete the softphone branches") |
| `DELETE /super-admin/alerts/channels/:id` | src/api/superAdminAlerts.ts:33 | super-admin alerts: not ported (master alerting module; not in plan §3.4 scope) |
| `DELETE /super-admin/alerts/definitions/:id` | src/api/superAdminAlerts.ts:49 | super-admin alerts: not ported (master alerting module; not in plan §3.4 scope) |
| `DELETE /super-admin/byoc-phone-numbers/:id` | src/api/superAdminTelephony.ts:95 | super-admin telephony providers / credentials / BYOC: not ported (plan §3.4 "Left out: SIP ... AI telephony credentials"; lane A deleted telephony-provider CRUD) |
| `DELETE /super-admin/dispatch-lanes/:tenantId/:dispatchType` | src/api/super-admin.ts:541 | super-admin dispatch lanes: not ported (plan §3.4 "Left out: dispatch lanes") |
| `DELETE /super-admin/governance/:tenantId/overrides` | src/api/governance.ts:55 | super-admin governance: not ported (plan §3.2, governance replaced by per-account settings and feature flags) |
| `DELETE /super-admin/telephony-credentials/:id` | src/api/superAdminTelephony.ts:65 | super-admin telephony providers / credentials / BYOC: not ported (plan §3.4 "Left out: SIP ... AI telephony credentials"; lane A deleted telephony-provider CRUD) (also ?force=true) |
| `DELETE /super-admin/tenants/:id` | src/api/super-admin.ts:215 | super-admin tenant delete: not ported (lane A deleted DELETE /tenants/:id) |
| `GET /api-keys` | src/api/api-keys.ts:36 | platform API keys: not ported (plan §2 "API keys", decision #5) |
| `GET /audit-log` | src/api/audit.ts:52 | audit-log page: not ported (lane A), open |
| `GET /bulk-dispatch-jobs/:id/analytics` | src/api/bulk-dispatch-jobs.ts:128 | bulk dispatch / contact lists: not ported (plan §2 "bulk dispatch") |
| `GET /bulk-dispatch-jobs/:id` | src/api/bulk-dispatch-jobs.ts:79 | bulk dispatch / contact lists: not ported (plan §2 "bulk dispatch") |
| `GET /bulk-dispatch-jobs/summary` | src/api/bulk-dispatch-jobs.ts:67 | bulk dispatch / contact lists: not ported (plan §2 "bulk dispatch") |
| `GET /bulk-dispatch-jobs` | src/api/bulk-dispatch-jobs.ts:39 | bulk dispatch / contact lists: not ported (plan §2 "bulk dispatch") |
| `GET /contact-lists/:id` | src/api/contact-lists.ts:22 | bulk dispatch / contact lists: not ported (plan §2 "bulk dispatch") |
| `GET /contact-lists/template` | src/api/contact-lists.ts:82 | bulk dispatch / contact lists: not ported (plan §2 "bulk dispatch") |
| `GET /contact-lists` | src/api/contact-lists.ts:18 | bulk dispatch / contact lists: not ported (plan §2 "bulk dispatch") |
| `GET /credits/rate-card` | src/api/credits.ts:51 | credits/billing: not ported (plan decision #8, §3.3) |
| `GET /credits/transactions` | src/api/credits.ts:27 | credits/billing: not ported (plan decision #8, §3.3) |
| `GET /credits` | src/api/credits.ts:10 | credits/billing: not ported (plan decision #8, §3.3) |
| `GET /governance/effective` | src/api/governance.ts:23 | governance: not ported, replaced by the session settings map (plan §3.2) |
| `GET /phone-numbers/:id/inbound/conflict-check` | src/api/phone-numbers.ts:62 | tenant phone tagging / inbound routing: not ported (inbound is an AI surface; lane A ported the super-admin inventory only) |
| `GET /phone-numbers/inbound-config` | src/api/phone-numbers.ts:32 | tenant phone tagging / inbound routing: not ported (inbound is an AI surface; lane A ported the super-admin inventory only) |
| `GET /proxy/analytics/activity-timeline` | src/api/analytics.ts:21 | AI-call dashboard stats/analytics: not ported (plan §2, AI surface) |
| `GET /proxy/announcements` | src/api/announcements.ts:56 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `GET /proxy/audio-files/:id/url` | src/api/announcements.ts:165 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `GET /proxy/audio-files` | src/api/announcements.ts:107 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `GET /proxy/automations/:id/executions` | src/api/automations.ts:190 | automations: not ported (plan §2, AI surface) |
| `GET /proxy/automations/:id/runs` | src/api/automations.ts:140 | automations: not ported (plan §2, AI surface) |
| `GET /proxy/automations/:id` | src/api/automations.ts:56 | automations: not ported (plan §2, AI surface) |
| `GET /proxy/automations/autopilot/capabilities` | src/api/autopilot.ts:131 | autopilot (AI authoring assistant): not ported (plan §2, AI surface) (transport at src/api/autopilot.ts:68) |
| `GET /proxy/automations/context-schema` | src/api/automations.ts:111 | automations: not ported (plan §2, AI surface) |
| `GET /proxy/automations/executions/:executionId` | src/api/automations.ts:211 | automations: not ported (plan §2, AI surface) |
| `GET /proxy/automations/runs/:runId` | src/api/automations.ts:152 | automations: not ported (plan §2, AI surface) |
| `GET /proxy/automations` | src/api/automations.ts:48 | automations: not ported (plan §2, AI surface) |
| `GET /proxy/browser-call/prompts/:id` | src/api/browser-call.ts:38 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `GET /proxy/browser-call/prompts` | src/api/browser-call.ts:34 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `GET /proxy/calls/:id/recording` | src/api/calls.ts:149 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `GET /proxy/calls/:id` | src/api/calls.ts:34 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `GET /proxy/calls/concurrency-limits` | src/api/calls.ts:133 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `GET /proxy/calls/concurrency` | src/api/calls.ts:123 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `GET /proxy/calls/export` | src/api/calls.ts:101 | AI calls: not ported (plan decision #9, §2 "every AI surface") (src/api/exportCsv.ts:126, no field list) |
| `GET /proxy/calls` | src/api/calls.ts:30 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `GET /proxy/escalation-destinations/:id` | src/api/escalation.ts:33 | escalation destinations (AI live transfer): not ported (plan §2, AI surface) |
| `GET /proxy/escalation-destinations/caller-ids` | src/api/escalation.ts:87 | escalation destinations (AI live transfer): not ported (plan §2, AI surface) |
| `GET /proxy/escalation-destinations` | src/api/escalation.ts:21 | escalation destinations (AI live transfer): not ported (plan §2, AI surface) |
| `GET /proxy/feature-flags` | src/api/feature-flags.ts:11 | served at /feature-flags, console updated (lead ruling, Phase 8) |
| `GET /proxy/ivr-calls/:id` | src/api/ivr.ts:87 | IVR: not ported (plan §2, AI surface) |
| `GET /proxy/ivr-calls/export` | src/api/ivr.ts:116 | IVR: not ported (plan §2, AI surface) (src/api/exportCsv.ts:126) |
| `GET /proxy/ivr-calls` | src/api/ivr.ts:83 | IVR: not ported (plan §2, AI surface) |
| `GET /proxy/ivr-workflows/:id/export` | src/api/ivr.ts:41 | IVR: not ported (plan §2, AI surface) |
| `GET /proxy/ivr-workflows/:id` | src/api/ivr.ts:17 | IVR: not ported (plan §2, AI surface) |
| `GET /proxy/ivr-workflows/autopilot/capabilities` | src/api/autopilot.ts:131 | autopilot (AI authoring assistant): not ported (plan §2, AI surface) (transport at src/api/autopilot.ts:75) |
| `GET /proxy/ivr-workflows` | src/api/ivr.ts:13 | IVR: not ported (plan §2, AI surface) |
| `GET /proxy/knowledge-bases/:id/analytics` | src/api/catalogs.ts:96 | knowledge bases: not ported (plan §2, AI surface) |
| `GET /proxy/knowledge-bases/:id/chunks` | src/api/documents.ts:195 | knowledge bases: not ported (plan §2, AI surface) |
| `GET /proxy/knowledge-bases/:id/document-preview` | src/api/documents.ts:57 | knowledge bases: not ported (plan §2, AI surface) |
| `GET /proxy/knowledge-bases/:id/documents/:docId/source-url` | src/api/documents.ts:171 | knowledge bases: not ported (plan §2, AI surface) |
| `GET /proxy/knowledge-bases/:id/documents/:docId` | src/api/documents.ts:125 | knowledge bases: not ported (plan §2, AI surface) |
| `GET /proxy/knowledge-bases/:id/documents` | src/api/documents.ts:115 | knowledge bases: not ported (plan §2, AI surface) |
| `GET /proxy/knowledge-bases/:id/preview` | src/api/catalogs.ts:66 | knowledge bases: not ported (plan §2, AI surface) |
| `GET /proxy/knowledge-bases/:id` | src/api/catalogs.ts:35 | knowledge bases: not ported (plan §2, AI surface) (also src/api/documents.ts:36) |
| `GET /proxy/knowledge-bases` | src/api/catalogs.ts:31 | knowledge bases: not ported (plan §2, AI surface) (also src/api/documents.ts:32) |
| `GET /proxy/messaging/connections/:id/contacts` | src/api/messaging.ts:115 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/connections/:id/groups/:groupId` | src/api/messaging.ts:144 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/connections/:id/groups` | src/api/messaging.ts:130 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/connections/:id/invite-link` | src/api/messaging.ts:100 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/connections/:id/qr` | src/api/messaging.ts:104 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/connections/:id/stats` | src/api/messaging.ts:96 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/connections/:id` | src/api/messaging.ts:57 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/connections` | src/api/messaging.ts:53 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/email-templates/:id` | src/api/messaging.ts:230 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/email-templates` | src/api/messaging.ts:226 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/media/:id/content` | src/api/messaging.ts:356 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/media/:id` | src/api/messaging.ts:299 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/media` | src/api/messaging.ts:295 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/messages/:id` | src/api/messaging.ts:210 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/messages/batches/:batchId` | src/api/messaging.ts:214 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/messages` | src/api/messaging.ts:206 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/templates/:id` | src/api/messaging.ts:160 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/messaging/templates` | src/api/messaging.ts:156 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `GET /proxy/metadata` | src/api/metadata.ts:6 | AI metadata (/proxy/metadata): not ported (lane A deleted metadata-cache, plan §2) |
| `GET /proxy/platform-tools` | src/api/prompt-tools.ts:30 | prompts / AI tools: not ported (plan §2, AI surface) |
| `GET /proxy/prompts/:id/tools` | src/api/prompt-tools.ts:6 | prompts / AI tools: not ported (plan §2, AI surface) |
| `GET /proxy/prompts/:id` | src/api/prompts.ts:65 | prompts / AI tools: not ported (plan §2, AI surface) |
| `GET /proxy/prompts/autopilot/capabilities` | src/api/autopilot.ts:131 | autopilot (AI authoring assistant): not ported (plan §2, AI surface) (transport at src/api/autopilot.ts:61) |
| `GET /proxy/prompts` | src/api/prompts.ts:21 | prompts / AI tools: not ported (plan §2, AI surface) (also listPromptsPage, :53) |
| `GET /proxy/recurring-schedules/:id/instances` | src/api/recurring-schedules.ts:86 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `GET /proxy/recurring-schedules/:id` | src/api/recurring-schedules.ts:37 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `GET /proxy/recurring-schedules` | src/api/recurring-schedules.ts:29 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `GET /proxy/schedules/:id/analytics` | src/api/analytics.ts:40 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `GET /proxy/schedules/:id/contacts` | src/api/schedules.ts:35 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `GET /proxy/schedules/:id` | src/api/schedules.ts:24 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `GET /proxy/schedules` | src/api/schedules.ts:20 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `GET /proxy/sip/connections/:id/stats` | src/api/sip.ts:59 | SIP connections: not ported (plan §2 "SIP", decision #5) |
| `GET /proxy/sip/connections/:id` | src/api/sip.ts:26 | SIP connections: not ported (plan §2 "SIP", decision #5) |
| `GET /proxy/sip/connections` | src/api/sip.ts:22 | SIP connections: not ported (plan §2 "SIP", decision #5) |
| `GET /proxy/static-calls/analytics` | src/api/analytics.ts:32 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `GET /proxy/static-calls/export` | src/api/announcements.ts:326 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) (src/api/exportCsv.ts:126) |
| `GET /proxy/static-calls` | src/api/announcements.ts:246 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `GET /proxy/stats` | src/api/stats.ts:6 | AI-call dashboard stats/analytics: not ported (plan §2, AI surface) |
| `GET /proxy/voices` | src/api/voices.ts:6 | TTS/AI voices: not ported (plan §2 "TTS") |
| `GET /proxy/webrtc-call/:id/recording` | src/api/webrtc-call.ts:168 | WebRTC softphone (dialer product, not agency): not ported (lane C deleted the softphone API, plan §2 "delete the softphone branches") |
| `GET /proxy/webrtc-call/:id` | src/api/webrtc-call.ts:105 | WebRTC softphone (dialer product, not agency): not ported (lane C deleted the softphone API, plan §2 "delete the softphone branches") |
| `GET /proxy/webrtc-call/caller-ids` | src/api/webrtc-call.ts:32 | WebRTC softphone (dialer product, not agency): not ported (lane C deleted the softphone API, plan §2 "delete the softphone branches") |
| `GET /proxy/webrtc-call` | src/api/webrtc-call.ts:91 | WebRTC softphone (dialer product, not agency): not ported (lane C deleted the softphone API, plan §2 "delete the softphone branches") |
| `GET /super-admin/alerts/catalog` | src/api/superAdminAlerts.ts:16 | super-admin alerts: not ported (master alerting module; not in plan §3.4 scope) |
| `GET /super-admin/alerts/channels` | src/api/superAdminAlerts.ts:22 | super-admin alerts: not ported (master alerting module; not in plan §3.4 scope) |
| `GET /super-admin/alerts/definitions` | src/api/superAdminAlerts.ts:36 | super-admin alerts: not ported (master alerting module; not in plan §3.4 scope) |
| `GET /super-admin/alerts/voice/status` | src/api/superAdminAlerts.ts:19 | super-admin alerts: not ported (master alerting module; not in plan §3.4 scope) |
| `GET /super-admin/dispatch-lanes-queue-depth` | src/api/super-admin.ts:545 | super-admin dispatch lanes: not ported (plan §3.4 "Left out: dispatch lanes") |
| `GET /super-admin/dispatch-lanes/:tenantId/:dispatchType` | src/api/super-admin.ts:518 | super-admin dispatch lanes: not ported (plan §3.4 "Left out: dispatch lanes") |
| `GET /super-admin/dispatch-lanes` | src/api/super-admin.ts:511 | super-admin dispatch lanes: not ported (plan §3.4 "Left out: dispatch lanes") |
| `GET /super-admin/governance/:tenantId` | src/api/governance.ts:38 | super-admin governance: not ported (plan §3.2, governance replaced by per-account settings and feature flags) |
| `GET /super-admin/governance/catalog` | src/api/governance.ts:28 | super-admin governance: not ported (plan §3.2, governance replaced by per-account settings and feature flags) |
| `GET /super-admin/tenants/:id/byoc-phone-numbers` | src/api/superAdminTelephony.ts:71 | super-admin telephony providers / credentials / BYOC: not ported (plan §3.4 "Left out: SIP ... AI telephony credentials"; lane A deleted telephony-provider CRUD) |
| `GET /super-admin/tenants/:id/credits/transactions` | src/api/super-admin.ts:505 | super-admin credits: not ported (plan decision #8; lane A deleted the credits routes) |
| `GET /super-admin/tenants/:id/telephony-credentials` | src/api/superAdminTelephony.ts:42 | super-admin telephony providers / credentials / BYOC: not ported (plan §3.4 "Left out: SIP ... AI telephony credentials"; lane A deleted telephony-provider CRUD) |
| `GET /super-admin/usage/export/meta` | src/api/superAdminUsage.ts:51 | super-admin credits usage/fleet: not ported (lane A deleted super-admin-usage.routes.ts; replaced by NEW GET /super-admin/usage counts, plan §3.3) |
| `GET /super-admin/usage/export` | src/api/superAdminUsage.ts:64 | super-admin credits usage/fleet: not ported (lane A deleted super-admin-usage.routes.ts; replaced by NEW GET /super-admin/usage counts, plan §3.3) |
| `GET /super-admin/usage/fleet` | src/api/superAdminUsage.ts:42 | super-admin credits usage/fleet: not ported (lane A deleted super-admin-usage.routes.ts; replaced by NEW GET /super-admin/usage counts, plan §3.3) |
| `GET /super-admin/usage/records` | src/api/superAdminUsage.ts:47 | super-admin credits usage/fleet: not ported (lane A deleted super-admin-usage.routes.ts; replaced by NEW GET /super-admin/usage counts, plan §3.3) |
| `GET /super-admin/usage/summary` | src/api/superAdminUsage.ts:33 | super-admin credits usage/fleet: not ported (lane A deleted super-admin-usage.routes.ts; replaced by NEW GET /super-admin/usage counts, plan §3.3) |
| `GET /tenants` | src/api/tenants.ts:7 | tenant/account CRUD: not ported by lane A (no tenant.update / account.* permission in contracts rbac, decision Q3e) |
| `GET /threads/:id/timeline` | src/api/threads.ts:45 | threads (AI follow-up conversations): not ported (plan §2, AI surface) |
| `GET /threads/:id` | src/api/threads.ts:36 | threads (AI follow-up conversations): not ported (plan §2, AI surface) |
| `GET /threads/by-call/:callId` | src/api/threads.ts:77 | threads (AI follow-up conversations): not ported (plan §2, AI surface) |
| `GET /threads` | src/api/threads.ts:59 | threads (AI follow-up conversations): not ported (plan §2, AI surface) |
| `PATCH /proxy/knowledge-bases/:id/items` | src/api/catalogs.ts:148 | knowledge bases: not ported (plan §2, AI surface) |
| `POST /accounts` | src/api/accounts.ts:39 | tenant/account CRUD: not ported by lane A (no tenant.update / account.* permission in contracts rbac, decision Q3e) |
| `POST /api-keys` | src/api/api-keys.ts:41 | platform API keys: not ported (plan §2 "API keys", decision #5) |
| `POST /bulk-dispatch-jobs/:id/cancel` | src/api/bulk-dispatch-jobs.ts:103 | bulk dispatch / contact lists: not ported (plan §2 "bulk dispatch") |
| `POST /bulk-dispatch-jobs/:id/retry` | src/api/bulk-dispatch-jobs.ts:144 | bulk dispatch / contact lists: not ported (plan §2 "bulk dispatch") |
| `POST /bulk-dispatch-jobs/:id/stop-remaining` | src/api/bulk-dispatch-jobs.ts:116 | bulk dispatch / contact lists: not ported (plan §2 "bulk dispatch") |
| `POST /contact-lists` | src/api/contact-lists.ts:50 | bulk dispatch / contact lists: not ported (plan §2 "bulk dispatch") |
| `POST /credits/allocate` | src/api/credits.ts:34 | credits/billing: not ported (plan decision #8, §3.3) |
| `POST /credits/deallocate` | src/api/credits.ts:44 | credits/billing: not ported (plan decision #8, §3.3) |
| `POST /notifications/digests/preview` | src/api/notifications.ts:58 | credits usage digest preview: not ported (lane A deleted POST /notifications/digests/preview, plan §3.5) |
| `POST /phone-numbers/:id/tags` | src/api/phone-numbers.ts:19 | tenant phone tagging / inbound routing: not ported (inbound is an AI surface; lane A ported the super-admin inventory only) |
| `POST /proxy/announcements/:id/preview-tts` | src/api/announcements.ts:196 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `POST /proxy/announcements` | src/api/announcements.ts:61 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `POST /proxy/audio-files` | src/api/announcements.ts:155 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `POST /proxy/automations/:id/dry-run` | src/api/automations.ts:98 | automations: not ported (plan §2, AI surface) |
| `POST /proxy/automations/autopilot/stream` | src/api/autopilot.ts:686 | autopilot (AI authoring assistant): not ported (plan §2, AI surface) (SSE; transport at src/api/autopilot.ts:69) |
| `POST /proxy/automations/executions/:executionId/cancel` | src/api/automations.ts:254 | automations: not ported (plan §2, AI surface) |
| `POST /proxy/automations` | src/api/automations.ts:64 | automations: not ported (plan §2, AI surface) |
| `POST /proxy/browser-call/:id/end` | src/api/browser-call.ts:49 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `POST /proxy/browser-call/start` | src/api/browser-call.ts:42 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `POST /proxy/calls/:id/end` | src/api/calls.ts:45 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `POST /proxy/calls/:id/retry-analysis` | src/api/calls.ts:51 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `POST /proxy/calls/batches/:batchId/cancel` | src/api/calls.ts:68 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `POST /proxy/calls/bulk` | src/api/calls.ts:57 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `POST /proxy/calls/concurrency/reset` | src/api/calls.ts:137 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `POST /proxy/calls/export` | src/api/calls.ts:101 | AI calls: not ported (plan decision #9, §2 "every AI surface") (src/api/exportCsv.ts:120, with a field list) |
| `POST /proxy/calls` | src/api/calls.ts:38 | AI calls: not ported (plan decision #9, §2 "every AI surface") |
| `POST /proxy/escalation-destinations/:id/test` | src/api/escalation.ts:107 | escalation destinations (AI live transfer): not ported (plan §2, AI surface) |
| `POST /proxy/escalation-destinations` | src/api/escalation.ts:41 | escalation destinations (AI live transfer): not ported (plan §2, AI surface) |
| `POST /proxy/ivr-calls/batches/:batchId/cancel` | src/api/ivr.ts:131 | IVR: not ported (plan §2, AI surface) |
| `POST /proxy/ivr-calls/export` | src/api/ivr.ts:116 | IVR: not ported (plan §2, AI surface) (src/api/exportCsv.ts:120) |
| `POST /proxy/ivr-calls` | src/api/ivr.ts:170 | IVR: not ported (plan §2, AI surface) |
| `POST /proxy/ivr-workflows/autopilot/stream` | src/api/autopilot.ts:686 | autopilot (AI authoring assistant): not ported (plan §2, AI surface) (SSE; transport at src/api/autopilot.ts:76) |
| `POST /proxy/ivr-workflows` | src/api/ivr.ts:21 | IVR: not ported (plan §2, AI surface) |
| `POST /proxy/knowledge-bases/:id/documents/:docId/file` | src/api/documents.ts:235 | knowledge bases: not ported (plan §2, AI surface) |
| `POST /proxy/knowledge-bases/:id/documents` | src/api/documents.ts:211 | knowledge bases: not ported (plan §2, AI surface) |
| `POST /proxy/knowledge-bases/:id/file` | src/api/catalogs.ts:197 | knowledge bases: not ported (plan §2, AI surface) |
| `POST /proxy/knowledge-bases/documents` | src/api/documents.ts:97 | knowledge bases: not ported (plan §2, AI surface) |
| `POST /proxy/knowledge-bases` | src/api/catalogs.ts:177 | knowledge bases: not ported (plan §2, AI surface) |
| `POST /proxy/messaging/connections/:id/verify` | src/api/messaging.ts:61 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `POST /proxy/messaging/connections` | src/api/messaging.ts:71 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `POST /proxy/messaging/email-templates` | src/api/messaging.ts:234 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `POST /proxy/messaging/media` | src/api/messaging.ts:323 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `POST /proxy/messaging/messages` | src/api/messaging.ts:258 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `POST /proxy/messaging/templates/sync` | src/api/messaging.ts:184 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `POST /proxy/messaging/templates` | src/api/messaging.ts:164 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `POST /proxy/prompts/:id/tools` | src/api/prompt-tools.ts:10 | prompts / AI tools: not ported (plan §2, AI surface) |
| `POST /proxy/prompts/autopilot/stream` | src/api/autopilot.ts:686 | autopilot (AI authoring assistant): not ported (plan §2, AI surface) (SSE; transport at src/api/autopilot.ts:62) |
| `POST /proxy/prompts/enhance` | src/api/prompts.ts:89 | prompts / AI tools: not ported (plan §2, AI surface) |
| `POST /proxy/prompts` | src/api/prompts.ts:69 | prompts / AI tools: not ported (plan §2, AI surface) |
| `POST /proxy/recurring-schedules/:id/cancel` | src/api/recurring-schedules.ts:57 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `POST /proxy/recurring-schedules/:id/pause` | src/api/recurring-schedules.ts:65 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `POST /proxy/recurring-schedules/:id/resume` | src/api/recurring-schedules.ts:73 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `POST /proxy/recurring-schedules` | src/api/recurring-schedules.ts:15 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `POST /proxy/schedules/:id/cancel` | src/api/schedules.ts:39 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `POST /proxy/schedules` | src/api/schedules.ts:6 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `POST /proxy/sip/connections/:id/test` | src/api/sip.ts:63 | SIP connections: not ported (plan §2 "SIP", decision #5) |
| `POST /proxy/sip/connections` | src/api/sip.ts:34 | SIP connections: not ported (plan §2 "SIP", decision #5) |
| `POST /proxy/static-calls/batches/:batchId/cancel` | src/api/announcements.ts:295 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `POST /proxy/static-calls/export` | src/api/announcements.ts:326 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) (src/api/exportCsv.ts:120) |
| `POST /proxy/static-calls` | src/api/announcements.ts:284 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `POST /proxy/webrtc-call/:id/end` | src/api/webrtc-call.ts:67 | WebRTC softphone (dialer product, not agency): not ported (lane C deleted the softphone API, plan §2 "delete the softphone branches") |
| `POST /proxy/webrtc-call/:id/retry-analysis` | src/api/webrtc-call.ts:127 | WebRTC softphone (dialer product, not agency): not ported (lane C deleted the softphone API, plan §2 "delete the softphone branches") |
| `POST /proxy/webrtc-call` | src/api/webrtc-call.ts:50 | WebRTC softphone (dialer product, not agency): not ported (lane C deleted the softphone API, plan §2 "delete the softphone branches") |
| `POST /super-admin/alerts/channels` | src/api/superAdminAlerts.ts:27 | super-admin alerts: not ported (master alerting module; not in plan §3.4 scope) |
| `POST /super-admin/alerts/definitions/:id/test` | src/api/superAdminAlerts.ts:52 | super-admin alerts: not ported (master alerting module; not in plan §3.4 scope) |
| `POST /super-admin/alerts/definitions` | src/api/superAdminAlerts.ts:43 | super-admin alerts: not ported (master alerting module; not in plan §3.4 scope) |
| `POST /super-admin/byoc-phone-numbers/:id/accounts` | src/api/superAdminTelephony.ts:101 | super-admin telephony providers / credentials / BYOC: not ported (plan §3.4 "Left out: SIP ... AI telephony credentials"; lane A deleted telephony-provider CRUD) |
| `POST /super-admin/telephony-credentials/:id/verify` | src/api/superAdminTelephony.ts:68 | super-admin telephony providers / credentials / BYOC: not ported (plan §3.4 "Left out: SIP ... AI telephony credentials"; lane A deleted telephony-provider CRUD) |
| `POST /super-admin/telephony-providers` | src/api/super-admin.ts:561 | super-admin telephony providers / credentials / BYOC: not ported (plan §3.4 "Left out: SIP ... AI telephony credentials"; lane A deleted telephony-provider CRUD) |
| `POST /super-admin/tenants/:id/accounts/:accountId/concurrency/retry-sync` | src/api/super-admin.ts:391 | provider concurrency retry-sync (core sync): not ported (lane A deleted it with coreInternalRequest) |
| `POST /super-admin/tenants/:id/byoc-phone-numbers` | src/api/superAdminTelephony.ts:80 | super-admin telephony providers / credentials / BYOC: not ported (plan §3.4 "Left out: SIP ... AI telephony credentials"; lane A deleted telephony-provider CRUD) |
| `POST /super-admin/tenants/:id/credits/deduct` | src/api/super-admin.ts:240 | super-admin credits: not ported (plan decision #8; lane A deleted the credits routes) |
| `POST /super-admin/tenants/:id/credits/reconcile` | src/api/super-admin.ts:253 | super-admin credits: not ported (plan decision #8; lane A deleted the credits routes) |
| `POST /super-admin/tenants/:id/credits` | src/api/super-admin.ts:233 | super-admin credits: not ported (plan decision #8; lane A deleted the credits routes) |
| `POST /super-admin/tenants/:id/telephony-credentials` | src/api/superAdminTelephony.ts:50 | super-admin telephony providers / credentials / BYOC: not ported (plan §3.4 "Left out: SIP ... AI telephony credentials"; lane A deleted telephony-provider CRUD) |
| `POST /threads/follow-up` | src/api/threads.ts:23 | threads (AI follow-up conversations): not ported (plan §2, AI surface) |
| `PUT /accounts/:id` | src/api/accounts.ts:50 | tenant/account CRUD: not ported by lane A (no tenant.update / account.* permission in contracts rbac, decision Q3e) |
| `PUT /phone-numbers/:id/inbound` | src/api/phone-numbers.ts:41 | tenant phone tagging / inbound routing: not ported (inbound is an AI surface; lane A ported the super-admin inventory only) |
| `PUT /proxy/announcements/:id` | src/api/announcements.ts:68 | static calls / announcements / audio files (TTS broadcast): not ported (plan §2 "TTS", AI surface) |
| `PUT /proxy/automations/:id` | src/api/automations.ts:76 | automations: not ported (plan §2, AI surface) |
| `PUT /proxy/escalation-destinations/:id` | src/api/escalation.ts:58 | escalation destinations (AI live transfer): not ported (plan §2, AI surface) |
| `PUT /proxy/ivr-workflows/:id` | src/api/ivr.ts:28 | IVR: not ported (plan §2, AI surface) |
| `PUT /proxy/knowledge-bases/:id/documents/:docId/approve` | src/api/documents.ts:135 | knowledge bases: not ported (plan §2, AI surface) |
| `PUT /proxy/knowledge-bases/:id/documents/:docId/reject` | src/api/documents.ts:148 | knowledge bases: not ported (plan §2, AI surface) |
| `PUT /proxy/knowledge-bases/:id/mapping` | src/api/catalogs.ts:44 | knowledge bases: not ported (plan §2, AI surface) |
| `PUT /proxy/knowledge-bases/:id/settings` | src/api/catalogs.ts:119 | knowledge bases: not ported (plan §2, AI surface) |
| `PUT /proxy/messaging/connections/:id` | src/api/messaging.ts:83 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `PUT /proxy/messaging/email-templates/:id` | src/api/messaging.ts:241 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `PUT /proxy/messaging/templates/:id` | src/api/messaging.ts:171 | messaging (WhatsApp/email): not ported (plan §2, AI surface) |
| `PUT /proxy/prompts/:id/tools/:toolId` | src/api/prompt-tools.ts:17 | prompts / AI tools: not ported (plan §2, AI surface) |
| `PUT /proxy/prompts/:id` | src/api/prompts.ts:76 | prompts / AI tools: not ported (plan §2, AI surface) |
| `PUT /proxy/recurring-schedules/:id` | src/api/recurring-schedules.ts:46 | schedules / recurring schedules: not ported (plan §2, AI surface) |
| `PUT /proxy/sip/connections/:id` | src/api/sip.ts:46 | SIP connections: not ported (plan §2 "SIP", decision #5) |
| `PUT /super-admin/alerts/channels/:id` | src/api/superAdminAlerts.ts:30 | super-admin alerts: not ported (master alerting module; not in plan §3.4 scope) |
| `PUT /super-admin/alerts/definitions/:id` | src/api/superAdminAlerts.ts:46 | super-admin alerts: not ported (master alerting module; not in plan §3.4 scope) |
| `PUT /super-admin/byoc-phone-numbers/:id` | src/api/superAdminTelephony.ts:91 | super-admin telephony providers / credentials / BYOC: not ported (plan §3.4 "Left out: SIP ... AI telephony credentials"; lane A deleted telephony-provider CRUD) |
| `PUT /super-admin/dispatch-lanes/:tenantId/:dispatchType` | src/api/super-admin.ts:531 | super-admin dispatch lanes: not ported (plan §3.4 "Left out: dispatch lanes") |
| `PUT /super-admin/governance/:tenantId/overrides` | src/api/governance.ts:45 | super-admin governance: not ported (plan §3.2, governance replaced by per-account settings and feature flags) |
| `PUT /super-admin/telephony-credentials/:id` | src/api/superAdminTelephony.ts:57 | super-admin telephony providers / credentials / BYOC: not ported (plan §3.4 "Left out: SIP ... AI telephony credentials"; lane A deleted telephony-provider CRUD) |
| `PUT /super-admin/telephony-providers/:id` | src/api/super-admin.ts:572 | super-admin telephony providers / credentials / BYOC: not ported (plan §3.4 "Left out: SIP ... AI telephony credentials"; lane A deleted telephony-provider CRUD) |
| `PUT /super-admin/tenants/:id/settings` | src/api/super-admin.ts:259 | super-admin tenant service settings (AI pipeline/provider): not ported (lane A); per-account settings replace it (plan §3.2) |
| `PUT /tenants/:id` | src/api/tenants.ts:15 | tenant/account CRUD: not ported by lane A (no tenant.update / account.* permission in contracts rbac, decision Q3e) (TenantSettingsPage edits AI pipeline/provider settings) |
| `WS /proxy/media-stream/:callId` | src/hooks/useBrowserCall.ts:95 | AI calls: not ported (plan decision #9, §2 "every AI surface") (browser AI call media; ws_url from POST /proxy/browser-call/start) |
| `WS /proxy/webrtc-call/:id/browser-stream` | src/hooks/useWebRtcCall.ts:325 | WebRTC softphone (dialer product, not agency): not ported (lane C deleted the softphone API, plan §2 "delete the softphone branches") (built by src/utils/webrtc-ws.ts from `browser_ws_url` + ?token=) |

### 8.2 Source files (`6497b04..HEAD`)

| Source | Destination | Class | Reason / equivalence test |
|---|---|---|---|
| master `src/proxy/core-client.ts` (`proxyToCore`) | `apps/server/src/api/core-dispatch.ts` (`callCore`) | modified (hop collapse) | Same request shape minus `coreApiKey`; query via `URLSearchParams`, body only for POST/PUT/PATCH when truthy, JSON both ways, `rawResponse` Buffer, text for non-JSON, the traversal 400 (`isUnsafeCorePath`). Gone: the API key, retries, OTel client span, `proxy_requests_*`, the mask's core-status recording. NEW hardening: core's three identity headers are dropped from the extra `headers` before the context's values are written. Tests: `test/unit/api/core-dispatch.test.ts` (11), every route family suite. |
| core `src/index.ts:694-701`@4850d1d9 (the agency plugin mounts) | `apps/server/src/api/core-handlers.ts` | modified | Core's `agencyCampaignRoutes` / `agencyAgentRoutes` at core's prefixes on a private instance (`maxParamLength: 200` via `routerOptions`, the 22P02 backstop handler); not in the app's route table. Test: route-table "never exposes core's handler modules"; `core-dispatch` static resolution (every core path a master handler sends resolves; every core route is reached or listed). |
| core `src/api/middleware/auth.middleware.ts` | same path | modified | Header half only (tenant + account required, core's 400 body). Deleted: API-key and JWT branches (decision #5; in-process caller), PostHog `identifyTenantAccount`. Tests: staffing integration "a TENANT-level caller with no X-Account-Id: core's 400"; isolation suite. |
| core `src/api/middleware/headers.ts` | same path | verbatim | Lane C had carried `TENANT_HEADER` only. |
| master `src/api/middleware/error-handler.middleware.ts` | same path | verbatim (import specifier) | Registered app-wide (`app.ts`), as master did. |
| — | `apps/server/src/api/middleware/agency-error-handler.ts` | NEW | errorHandler + 22P02 → 400 `Invalid identifier` (value not echoed); app-wide and on the private core instance. Tests: `integration/app/error-mask-app-wide.test.ts` (genuine 22P02), isolation suite malformed-id case. |
| master `src/api/middleware/error-mask.middleware.ts` | same path | modified | Lead ruling: 5xx branch kept, core-forwarded 4xx branch dropped (`FORWARDABLE_ERROR_CODES`/`LABELS`, `isStructuredClientError`, `parseJsonPayload`, `sawCoreErrorStatus` deleted); `MASK_EXEMPT_PATHS` = `/healthz`, `/readyz`. Registered app-wide. Tests: `error-mask.middleware` (17), `error-mask.integration` (5), `error-mask-app-wide` (5, mutation-checked). |
| core `src/api/middleware/rate-limit.middleware.ts` (lane C port) | same path | modified | `EXEMPT_PATHS` → `/healthz`, `/readyz`; two `RATE_LIMIT_ROUTE_CLASSES` rows for `/proxy/agency`, `/dnc`; Q7 comment. Registered once in `app.ts`. Tests: `rate-limit.middleware` (38), `rate-limit.app-scope` (5, mutation-checked). | **Q7/Q9: PORT NOTE comments now describe the hop count — OQ-2.**
| core `src/api/responses/agency-campaign.response.ts`, `webrtc-call.response.ts` | same paths | verbatim (import specifiers) | — |
| core `src/api/routes/agency-agents.routes.ts` | same path | verbatim (import specifiers) | Private instance only. |
| core `src/api/routes/agency-campaigns.routes.ts` | same path | modified | SIP deleted (`sip_connection_id` not passed to `create`; retry config keys = B1's list minus it); `runtime`/`callManager` deps typed structurally (lane C guard host for the concurrency read; Phase 6 runtime later); `?agent_user_id=` shape-checked (UUID column now); `proxyCallRecording` takes the allow-list. Tests: `campaign-sip-removal-route` (4, NEW), `spine-read-routes` (+1), `agency-call-read-routes`. |
| master `src/api/routes/dnc.routes.ts` | same path | modified | `requireCapability('agency')` deleted (no governance, plan §3.2); `auditLogger` → `platformAuditLogger` (B7); imports. Test: `dnc.routes` (46, verbatim cases). |
| master `src/api/routes/helpers/csv-attachment.ts`, `helpers/path-params.ts` | same paths | verbatim | — |
| master `src/api/routes/phone-number.routes.ts` | same path | modified | `GET /` only (`:64-160`); BYOC half (`listByocCallerIds`, `is_byoc`) deleted (BYOC out of scope; contracts' `TenantPhoneAssignment` has no `is_byoc`); tag/default/inbound routes not served; permission `agency.phone_numbers.read` (viewer). Tests: `phone-numbers-byoc-merge` (6), integration `phone-number.routes` (4, 2 NEW isolation). |
| master `src/api/routes/proxy-agency-campaigns.routes.ts` | same path | modified | Hop collapse (every `proxyToCore` → `callCore`); RBAC renames; `requireCapability('agency')` deleted; behavioural settings through lane A's `campaign-behavioral-settings.ts` on the PARSED body (MAG-138); ownership probe's "unverified" arm and `'default'` fallbacks deleted; activity/spine export timeouts handed to the socket deleted (between-pages budget kept); `credits_low` overlay deleted; ingest job stamped from the proven owner; `getFileBuffer` = core's `getFile` (B14); API-key branches deleted (decision #5). Tests: the 14 `proxy-agency-campaign*` / roster / spine / grouped suites in §8.5. |
| master `src/api/routes/proxy-agency-staffing.routes.ts` | same path | modified | See "Phase 8 — staffing" below. Tests: `proxy-agency-staffing.routes` (78), integration `agency-staffing.routes` (55), `agency-my-campaigns.routes` (27). |
| master `src/api/routes/proxy-agency-performance.routes.ts` | same path | modified | See "Phase 8 — performance" below. Tests: `proxy-agency-grouped-stats`, `proxy-agency-roster`, `proxy-agency-my-surfaces`, integration `agency-performance-access` (21), `agency-performance-forwarding` (25). |
| master `src/api/routes/proxy-agency-calls.routes.ts` | same path | modified | Hop collapse; governance → the OWNING account's settings row (`analyze_calls` strips analysis, `allow_recording` gates the media route; NULL/no row/failure = off); section gate deleted. Test: `proxy-agency-calls.routes` (81). |
| master `src/proxy/safe-core-path.ts`, `src/utils/redact-url.ts` | same paths | verbatim | — |
| master `src/api/routes/proxy-call-analysis-profiles.routes.ts` | `apps/server/src/api/profile-route-auth.ts` | modified (passthrough collapsed) | Lane D's core profile routes are mounted at `/proxy/call-analysis-profiles` behind this `ProfileRouteAuth`: session → tenant-context → core's account requirement (400) → capability `agency.analytics` (= `account_settings.analyze_calls`, fail closed, master's 403 body) → `agency.analysis_profiles.read|write`. **Deviation:** master gated detail/create/update/delete on the softphone's `calls.dialer.analytics` and only the list on either; with the softphone deleted all five take `agency.analytics` (otherwise unreachable). Tests: `profile-route-auth` (13), isolation suite, agent-reach. |
| lane D `api/analysis.plugin.ts` | same | modified (lane-owned) | Profile routes moved out (to `agencyPlugin`). |
| core `src/utils/recording-url.ts` (lane D port) | same | modified | Default `basePath` `/api/v1/webrtc-recordings` (lane D review carry-forward: core's `/api/v1/recordings` is not served). Test: `recording-url` (2 modified). |
| lane D `analysis/bridge-analysis-hooks.ts` | same | modified | The stamped `analysis_profile_id` is used only when its row's tenant/account match the call's (lane D review hardening); not `findByIdScoped` because that reads active versions only. Test: `bridge-analysis-hooks` (+2, mutation-checked). |
| — | `apps/server/src/agency/dnc-availability.ts` | NEW | The stats strip's `runtime.dnc.appliedVersion` after B8: `null` exactly when `DncRegistry.check` answers `unavailable`. Tests: `dnc-availability` (6), `agency-campaign-stats.routes` (+2 real PG). |
| — | `apps/server/src/api/agency-id-guard.ts` | NEW | Malformed path ids answer each family's not-found (master's), and a malformed `X-Tenant-Id` a 400, before any `uuid` cast (B1/B2 carry-forward). Tests: isolation suite (malformed path and query ids, tenant header), per-family suites. |
| — | `apps/server/src/api/agency.plugin.ts` | lane-owned | Registers the families, the core instance, the guards. |
| lane A `api/platform.plugin.ts`, lane C `api/voice.plugin.ts`, lane C `bootstrap/voice.ts` | same | modified | Their scoped limiter registrations removed (hoisted); `initAnalytics()` moved to `index.ts`. |
| lead `apps/server/src/app.ts` (authorised) | same | modified | Limiter at app scope before any route (no `trustProxy`, Q7 comment); `setErrorHandler(agencyErrorHandler)` + `onSend` `errorMaskHook` app-wide; `agencyPlugin` registered. | **Q7/Q9 (Manas, 2026-10-09): `trustProxy` = `TRUST_PROXY_HOPS` hop count — OQ-2.**
| lead `apps/server/src/index.ts` (authorised) | same | modified | `initAnalytics()` above `app.listen` (lane C carry-forward). No test: `index.ts` runs `main()`. |
| lane B `config/blocks/agency.ts` | same | modified | master's `rosterReplaceEnabled` (default false); `creditsLowConnectsThreshold` not carried. |
| — | `apps/server/package.json` | dependency | `@fastify/multipart@^9.4.0` (master's major; the roster upload route). |
| master `src/proxy/proxy.utils.ts` (`resolveCoreApiKey`), `src/proxy/core-error.ts` | — | deleted | No core API key or forwarded core errors in one process. |

| core `src/api/routes/agency.routes.ts` | same path | modified | Session and attempt handlers only, on the private core instance (`core-handlers.ts`, `agency` deps; the runtime is a per-access lookup). Moved out: the station route and `handleStationSocket` (`:160-170`, `:1358-1783` — Phase 6, `agency/station-socket.ts`); deleted: `agencyInternalRoutes` (`:1807-1963`, B2's roster hand-off) and `internalAuthMiddleware`. `markDncOnMaster` → `markDnc`, and the DNC route's suppression, optional disposition and `dnc_entries` row run in ONE transaction (decision B8, lead ruling); `runtime.wrapup.noteDisposition` after COMMIT. Imports per the path rule. Tests: the six core route suites (§8.5), `agency-dnc-mark-route` (4), `agency-agent-state-cycle` (1), `agency-runtime-routes` (29, B8 rollback mutation-checked). |
| core `src/db/repositories/agency.repository.ts` (lane B1 port) | same | modified | `suppressByPhone(…, { client })` and `recordDisposition(…, { client })` join a caller's transaction (B8); omitted = core's own, verbatim. Tests: as above. |
| master `src/api/routes/proxy-agency-agent.routes.ts` | same path | modified | Hop collapse (`proxyToCore` → `callCore`, `resolveCoreApiKey` gone); `requireCapability('agency')` deleted; `auditLogger` → `platformAuditLogger` (8 audit rows, master's). Validation, RBAC floors, actor assertion (`resolveAgencyActor`, which overwrites any body `agent_user_id` / `on_behalf`), the `station_ws_url` rewrite: master's. Tests: `proxy-agency-agent-actions` (55), `-audit` (8), `agency-proxy-path-traversal` (83), `proxy-agency-route-table` (29), `agency-session-conflict-forward` (13), `agency-runtime-routes`. |
| master `src/api/routes/proxy-agency-station.routes.ts` | same path | modified (hop collapsed) | After master's 4401 (no token) and 1008 (path-escaping id), the console's socket is handed to core's `handleStationSocket` in-process (it verifies and consumes the single-use, session-bound token first). Deleted with the second leg: the relay, pending buffer, close translation (`closeSafely`, `isSendableCloseCode`, `truncateCloseReason`, `describeUnsendableCode`, `STATION_CLOSE_REASONS`, `STATION_CLOSE_DELIVERY`), 4502, `MEDIA_WS_CLIENT_OPTIONS`/`config.coreService`. NEW: 1011 without a runtime (Phase 6's behaviour). Tests: `proxy-agency-station.routes` (10), `agency-station-route` (2), `agency-runtime-routes` (station cases). |
| master `src/utils/ws-nodelay.ts` | same path | verbatim | `disableNagle` on the agent's station socket, as master's agent leg. |
| Phase 6 `src/agency/station-socket.ts` `registerStationSocket` | — | unused by the app | The app mounts the station through the console-path route; `registerStationSocket` stays exported (Phase 6's own suites use it). |
| core `src/api/middleware/rate-limit.middleware.ts` (review BLOCKING) | same | modified | The `tenant` bucket deleted with API keys (decision #5): core keyed any `x-api-key` request on `${x-mgkvc-tenant}:${hash(x-api-key)}`, an unauthenticated bucket-rotation knob here (unlimited super-admin password guesses). Unauthenticated traffic keys on the IP, as master's limiter did. Tests: `rate-limit.middleware` (7 modified), `rate-limit.app-scope` (+3, mutation-checked). |
| core `src/utils/api-key.ts` (`hashApiKey`, lane C) + its test (3) | — | deleted | Only the deleted bucket used it. |
| lead `apps/server/src/app.ts` (authorised, review N4) | same | modified | master's `genReqId` (`src/index.ts:331-340`: client `x-request-id`, else the active trace id, else a UUID; the trace API imported statically). Test: `test/unit/app/request-id.test.ts` (2, mutation-checked). |
| master `proxy-agency-campaigns.routes.ts` POST/PATCH `/campaigns`, `proxy-agency-calls.routes.ts` media gate (routes review 1) | same | modified | No account context → core's observed 400 `Missing required header: x-mgkvc-account` ahead of the account-level settings read (master's capability resolved at tenant level and core refused). PATCH keeps master's `request.body` line with a PORT NOTE: one reference is validated, asserted and forwarded (routes review 2). Tests: behavioural-capabilities +4, calls (1 case updated). |
| master `dnc.routes.ts`, lane A `invites.routes.ts`, contracts `api/agency/webrtc-call.ts` | same | comment-only | PORT NOTEs beside master's comments on the Redis DNC set, the `agency` capability, a `RATE_LIMIT_ENABLED` switch, BYOC `is_byoc` (routes review 3, review N6). |
| Phase 6 `test/integration/agency/runtime-e2e.test.ts`, `test/unit/api/agency-station-route.test.ts` | same | modified | The console station path. |

| lane A `src/bootstrap/platform.ts` (authorised, delta review 3) | same | modified | Starts master's `platformAuditLogger` and core's `auditLogger` at boot (master `src/index.ts:320`@a1f0756a, core `src/index.ts:579`@4850d1d9) and flushes both in its stop (master `:697`, core `:903`). Nothing in agency did either: the 500 ms timer never ran, so rows waited for 100 to accumulate and the tail was lost on stop. The platform stop runs last of the lanes' stops; master flushed after `app.close()`, and agency's `index.ts` closes the app after the stops, so a request in flight at that moment can log after the flush (open point, §8.7). Test: `integration/app/audit-flush-on-stop.test.ts` (2, real PG, mutation-checked). |
| lead `apps/server/src/app.ts` (authorised, delta review 6) | same | modified | `routerOptions: { maxParamLength: 200 }` (master `src/index.ts:330`, core `:589`). Test: `test/unit/app/max-param-length.test.ts` (2, mutation-checked). |
| core `src/agency/dnc-mark.ts` (lane B1 port, delta review 4, 5) | same | comment + log text | `refused` is unreachable from the one caller (the route resolves the campaign from the attempt and passes no account); the comment now says so. Inside a caller's transaction the log line reads "written (in the caller's transaction, not yet committed)". |

#### Phase 8 — staffing

`proxy-agency-staffing.routes.ts`: both `proxyToCore` calls (`resolveCampaignSummary`, the ownership
probe `assertCampaignInScope`) are `callCore` → core's `GET /agency-campaigns/:id` (feature gate,
then `requireOwned` on tenant AND account); `resolveCoreApiKey` / `resolveCoreApiKeyOrNull` and the
`coreApiKey` parameter deleted; `isPlatformApiKeyCaller` branch of `resolveMyAgentId` deleted
(decision #5); `requireCapability('agency')` deleted; `auditLogger` → `platformAuditLogger`.

#### Phase 8 — performance

`proxy-agency-performance.routes.ts`: every `proxyToCore` → `callCore` (`metricPath`/`timeoutMs` still
passed, ignored); `requireCapability('agency')` deleted; the `isPlatformApiKeyCaller` 400
`missing_actor` on `/agents/stats` and `/agents/grouped-stats` deleted with the predicate. Whitelists,
`include_inactive`, the account predicate, the membership filter, `inactive_omitted` /
`unattributed_omitted`, `assertAgentInTenant`'s 404 and the name enrichment are master's.

### 8.3 Carry-forwards closed

| From | Item | Where / test |
|---|---|---|
| B1, B2 | UUID-validate ids before `uuid`/`uuid[]` casts; malformed → 400/404 per master's route, never 500 | `agency-id-guard.ts` per family + the 22P02 backstop on both instances; `?agent_user_id=` shape check; `integration/api/agency-tenant-isolation` "a malformed id on any family…" (path ids on campaigns, attempts, contacts, staffing, performance, profiles, DNC; query ids on agents stats, grouped stats, spine, my-attempts, DNC; `X-Tenant-Id`), `spine-read-routes` +1, `agency-campaign-stats.routes` +1, `agency-performance-access` +1 |
| B1 | the 7 deferred `formatAgencyCampaignResponse` cases | `campaign-lifecycle-timestamps` 12 → 19 |
| B1 | `markDnc` transaction composition | one transaction (lead ruling): `POST /attempts/:id/dnc`; real-Postgres rollback in `agency-runtime-routes` and `agency-dnc-mark-route` (trigger raising inside the `dnc_entries` insert), mutation-checked |
| B2 | prove ownership BEFORE the activity read; `ActivityQuery.accountId` = the campaign row's account | `requireOwnedCampaign` then `fetchActivityPage({ accountId: owned.accountId })`; `proxy-agency-campaign-activity.routes` |
| B2 | keep the inverted-window refusal | master's rule kept (`from > to` refused, `from === to` allowed, since the list `to` is inclusive) — the brief's "`from >= to`" is read as "keep master's refusal"; `agency-ingest-route-seam` "refuses an inverted date range…", activity suite |
| B2 | `agency_ingest_jobs.account_id` from the proven owner | `POST /ingest/jobs`; `proxy-agency-campaigns.routes` +2, `integration/api/agency-ingest-job-owner` (4, mutation-checked) |
| B2 | `agency-agent-identity.test.ts` consumer count 0 → 2 | master's loop over both consumers |
| B2 | reaper wiring | Phase 6's `bootstrap/agency.ts` (not this branch) |
| lane A | audited call-site floor 4 → 22 | 22 (`dnc` 2, campaigns 6, staffing 2, agent 8) |
| lane A / C | `POST /auth/session` has no limit; limiter plugin-scoped; `EXEMPT_PATHS` | app-scope limiter; `rate-limit.app-scope` (login 5/min, invites 20/min/IP, `/auth/session` charged, probes exempt) |
| lane C | `initAnalytics()` before `listen` | `index.ts` |
| lane D | `signRecordingUrl` default path; unscoped profile read | §8.2 rows |

### 8.4 Contracts edits (authorised: `packages/contracts/src/api/agency/*`, these three only)

| Field | File | Shape (matches the console's override `apps/console/src/types/agency.ts` and CONTRACT-DIFF §1) | Producer |
|---|---|---|---|
| `AgencyStationIntervals.deferred_hangup_ms?: number` | `packages/contracts/src/api/agency/agency.ts` | optional (core's is required; absent degrades to cusui's copy) | core's session bootstrap — asserted on `POST /proxy/agency/sessions` = `DEFERRED_HANGUP_MS` (`agency-runtime-routes`) |
| `AgencyDispositionResponse.callback_requested_at?: string \| null` | same | optional, nullable | core's disposition handler — asserted on a callback disposition (the requested instant, `agency-runtime-routes`) |
| `AgencyWrapupHold = 'disposition_required' \| 'supervisor_hold'` | same | union widened to core's `AgencyWrapupHoldReason` | **declared, no producer** (lead ruling): core @ `4850d1d9` declares it, nothing sets `held_reason: 'supervisor_hold'`; contract-only, to Manas |

Test: `packages/contracts/test/console-wire-diff.test.ts` (2; type-level equality with core's
contract, mutation-checked: removing `supervisor_hold` fails `pnpm lint`). `CONTRACT-DIFF.md` rows
marked done. The console's local override now differs from the contract only in comments.
`agents_peak`: no producer anywhere; left unserved, as master did (`agency-campaign-wire.ts`), and the
console degrades on absence.

### 8.5 Tests (source cases → ported; `it.each` rows and `for…of` loops expanded)

Source counts are the static expansion of the source file at its SHA (`it(`/`test(` literals, `it.each`
rows from array literals or same-file consts, `describe.each` and `for (… of [...])` multiplying their
bodies); the same counter reproduces Vitest's printed count on every destination file below. "Ported" is
what Vitest prints for the destination (`server-unit.json` / `server-integration.json` / `contracts-unit.json`).
Rows: one per test file this branch adds or changes (81 server + 1 contracts).

| Destination | Source | Source cases | Ported (Vitest) | Changes |
|---|---|---|---|---|
| `test/unit/agency/agency-agent-identity.test.ts` | lane B2 port of master `test/unit/agency/agency-agent-identity.test.ts` — on main | 9 (main) | 9 | modified: "is imported by both files that enrich an agent id" loops over master's two consumers verbatim (B2 pinned 0 until they existed; consumer count 0 → 2) |
| `test/unit/agency/agency-call-read-routes.test.ts` | core `test/unit/agency/agency-call-read-routes.test.ts`@4850d1d9 | 25 (19 `it(` + 2 `each`) | 25 | verbatim; config mock gains `voicelinkRecording.allowedHosts`; the recording stream case passes the allow-list |
| `test/unit/agency/agency-internal-ingest-ownership.test.ts` | core `test/unit/agency/agency-internal-ingest-ownership.test.ts`@4850d1d9 | 15 (7 `it(` + 1 `each`) | 16 | the S2S route is gone: core's `/internal/agency-campaigns/:id/contacts` body runs through B2's in-process roster hand-off; the HTTP-only refusals (S2S token, malformed path) are deleted; +1 = the one non-auth case of core `agency-internal-auth.test.ts` ("applies the chunk with tenancy taken from the campaign row"); that file's 4 S2S-token cases are deleted with the route |
| `test/unit/agency/agency-proxy-path-traversal.test.ts` | master `test/unit/agency/agency-proxy-path-traversal.test.ts`@a1f0756a | 83 (4 `it(` + 7 `each`) | 83 | source 83 (counted by hand: 6×6 + 4 + 4 + 4×6 + 2 + 2 + 4 + 4 + 3; the static counter under-expands nested `describe` loops here, 71, on BOTH sides); 61 modified (`resolveCoreApiKey` not-called lines; `agency.campaigns.read` floor), 0 deleted |
| `test/unit/agency/agent-record-routes.test.ts` | core `test/unit/agency/agent-record-routes.test.ts`@4850d1d9 | 56 (56 `it(` + 0 `each`) | 56 | verbatim; 1 modified: the over-long id case expects the UUID shape refusal |
| `test/unit/agency/campaign-abandon-config-route.test.ts` | core `test/unit/agency/campaign-abandon-config-route.test.ts`@4850d1d9 | 8 (8 `it(` + 0 `each`) | 8 | verbatim |
| `test/unit/agency/campaign-analysis-profile-route.test.ts` | core `test/unit/agency/campaign-analysis-profile-route.test.ts`@4850d1d9 | 13 (13 `it(` + 0 `each`) | 13 | verbatim |
| `test/unit/agency/campaign-config-route.test.ts` | core `test/unit/agency/campaign-config-route.test.ts`@4850d1d9 | 57 (21 `it(` + 0 `each`) | 57 | verbatim |
| `test/unit/agency/campaign-lifecycle-route.test.ts` | core `test/unit/agency/campaign-lifecycle-route.test.ts`@4850d1d9 | 7 (7 `it(` + 0 `each`) | 7 | verbatim (the four handlers are pure `transitionStatus` writes, no runtime call) |
| `test/unit/agency/campaign-lifecycle-timestamps.test.ts` | lane B1 port of core `test/unit/agency/campaign-lifecycle-timestamps.test.ts` (19) — on main | 12 (main) | 19 | +7: the deferred `formatAgencyCampaignResponse` describe, verbatim, now that `api/responses/agency-campaign.response.ts` is ported (B1 carry-forward); file = core's 19 |
| `test/unit/agency/campaign-retry-route.test.ts` | core `test/unit/agency/campaign-retry-route.test.ts`@4850d1d9 | 57 (31 `it(` + 4 `each`) | 57 | verbatim |
| `test/unit/agency/campaign-sip-removal-route.test.ts` | NEW | — | 4 | NEW: equivalence tests for the SIP deletions in core `agency-campaigns.routes.ts` (`sip_connection_id`) |
| `test/unit/agency/campaign-start-roster-route.test.ts` | core `test/unit/agency/campaign-start-roster-route.test.ts`@4850d1d9 | 16 (16 `it(` + 0 `each`) | 16 | verbatim |
| `test/unit/agency/campaign-stats-concurrency-guard-route.test.ts` | core `test/unit/agency/campaign-stats-concurrency-guard-route.test.ts`@4850d1d9 | 2 (2 `it(` + 0 `each`) | 2 | verbatim |
| `test/unit/agency/campaign-stats-series-route.test.ts` | core `test/unit/agency/campaign-stats-series-route.test.ts`@4850d1d9 | 15 (15 `it(` + 0 `each`) | 15 | verbatim |
| `test/unit/agency/disposition-route.test.ts` | core `test/unit/agency/disposition-route.test.ts`@4850d1d9 | 37 (37 `it(` + 0 `each`) | 37 | verbatim (logger mock, contracts import) |
| `test/unit/agency/dnc-availability.test.ts` | NEW | — | 6 | NEW: equivalence test for `agency/dnc-availability.ts` (the stats strip's DNC input after B8) |
| `test/unit/agency/dnc-mark-route.test.ts` | core `test/unit/agency/dnc-mark-route.test.ts`@4850d1d9 | 38 (38 `it(` + 0 `each`) | 37 | B8: 2 deleted (SC4 outbox retry; master 503), 22 modified (`markDnc` mock and the transaction client; the master-throws case → "a failure after the suppression propagates and nothing commits"), 1 NEW (wrap-up release after COMMIT); the `{ client }` argument of `suppressByPhone` pinned (delta review 2); mutation-checked (a COMMIT before `markDnc` reds 4; dropping the client reds 1) |
| `test/unit/agency/dnc-mark.test.ts` | master `test/unit/dnc/internal-agency.routes.test.ts`@a1f0756a | 32 (32 `it(` + 0 `each`) | 16 | master `internal-agency.routes` mark half re-run against `markDnc`: 14 kept (mapped), 2 modified, 16 deleted (route table, S2S auth ×3, null/non-UUID ids ×3, `/dnc-resync` ×9; B8) |
| `test/unit/agency/hangup-route.test.ts` | core `test/unit/agency/hangup-route.test.ts`@4850d1d9 | 10 (10 `it(` + 0 `each`) | 10 | verbatim (logger mock) |
| `test/unit/agency/left-session-guards.test.ts` | core `test/unit/agency/left-session-guards.test.ts`@4850d1d9 | 30 (26 `it(` + 0 `each`) | 30 | verbatim; `registerStationSocket` mounted beside `agencyRoutes` (the station moved, Phase 6) |
| `test/unit/agency/proxy-agency-agent-actions.test.ts` | master `test/unit/agency/proxy-agency-agent-actions.test.ts`@a1f0756a | 61 (57 `it(` + 1 `each`) | 55 | 6 deleted (platform-API-key caller shapes ×3 routes ×2, decision #5) |
| `test/unit/agency/proxy-agency-agent-audit.test.ts` | master `test/unit/agency/proxy-agency-agent-audit.test.ts`@a1f0756a | 8 (8 `it(` + 0 `each`) | 8 | verbatim (mocks only) |
| `test/unit/agency/proxy-agency-calls.routes.test.ts` | master `test/unit/agency/proxy-agency-calls.routes.test.ts`@a1f0756a | 66 (32 `it(` + 8 `each`) | 81 | governance → owning-account settings (`allow_recording`, `analyze_calls`); 1 modified (no `agency` section gate in the order case); +15 NEW (owning-account settings describe, `it.each` rows), one of which (no account context) answers core's 400 since the routes review |
| `test/unit/agency/proxy-agency-campaign-activity.routes.test.ts` | master `test/unit/agency/proxy-agency-campaign-activity.routes.test.ts`@a1f0756a | 55 (47 `it(` + 3 `each`) | 41 | the S2S read of core's half is a direct `audit_logs` query (B2), so every case about core being unreachable / timing out / the 424 refusal is deleted (14, named below) |
| `test/unit/agency/proxy-agency-campaign-behavioral-capabilities.routes.test.ts` | master `test/unit/agency/proxy-agency-campaign-behavioral-capabilities.routes.test.ts`@a1f0756a | 28 (14 `it(` + 0 `each`) | 32 | governance section gate deleted (2 × 2 surfaces); +2 × 2 NEW (the settings row judged; the forwarded object is the asserted one); +2 × 2 NEW (routes review: no account → core's 400, nothing forwarded; the PATCH asserted object IS the forwarded one) |
| `test/unit/agency/proxy-agency-campaign-lifecycle-rbac.routes.test.ts` | master `test/unit/agency/proxy-agency-campaign-lifecycle-rbac.routes.test.ts`@a1f0756a | 10 (2 `it(` + 2 `each`) | 10 | verbatim (core 404 now a real in-process answer) |
| `test/unit/agency/proxy-agency-campaign-retry-rbac.routes.test.ts` | master `test/unit/agency/proxy-agency-campaign-retry-rbac.routes.test.ts`@a1f0756a | 11 (3 `it(` + 3 `each`) | 11 | 3 modified: the "both permissions" proof uses roles instead of API-key scopes (decision #5) |
| `test/unit/agency/proxy-agency-campaign-retry.routes.test.ts` | master `test/unit/agency/proxy-agency-campaign-retry.routes.test.ts`@a1f0756a | 41 (41 `it(` + 0 `each`) | 41 | −1 section-gate case, +1 NEW (the PARENT's account settings are judged); 1 modified (API-key case) |
| `test/unit/agency/proxy-agency-campaign-series.routes.test.ts` | master `test/unit/agency/proxy-agency-campaign-series.routes.test.ts`@a1f0756a | 41 (27 `it(` + 4 `each`) | 41 | verbatim cases; `metricPath`/`recordCoreErrors` asserts dropped from two 404 cases |
| `test/unit/agency/proxy-agency-campaign-stats-enrichment.routes.test.ts` | master `test/unit/agency/proxy-agency-campaign-stats-enrichment.routes.test.ts`@a1f0756a | 37 (37 `it(` + 0 `each`) | 26 | `credits_low` overlay deleted with billing (12 cases, named below); +1 NEW "never adds a credits_low stall, and issues no credit read" |
| `test/unit/agency/proxy-agency-campaign-transition-actor.routes.test.ts` | master `test/unit/agency/proxy-agency-campaign-transition-actor.routes.test.ts`@a1f0756a | 40 (10 `it(` + 8 `each`) | 30 | platform-API-key attribution cases deleted (decision #5; 10 incl. `it.each` rows) |
| `test/unit/agency/proxy-agency-campaigns.routes.test.ts` | master `test/unit/agency/proxy-agency-campaigns.routes.test.ts`@a1f0756a | 135 (88 `it(` + 6 `each`) | 137 | +2 NEW: the ingest job is stamped with the proven campaign row's account (B2 carry-forward) |
| `test/unit/agency/proxy-agency-grouped-stats.routes.test.ts` | master `test/unit/agency/proxy-agency-grouped-stats.routes.test.ts`@a1f0756a | 121 (88 `it(` + 8 `each`) | 113 | API-key cases (6), the masked-500 budget case and the mask-harness case deleted; the capability-hook pair becomes the two remaining plugin hooks (2 modified) |
| `test/unit/agency/proxy-agency-my-surfaces.routes.test.ts` | master `test/unit/agency/proxy-agency-my-surfaces.routes.test.ts`@a1f0756a | 83 (45 `it(` + 8 `each`) | 78 | API-key cases (2 × 2 paths) and the `agency` capability-hook cases deleted; the hook-count/hook-order cases assert the two remaining hooks (3 modified) |
| `test/unit/agency/proxy-agency-roster.routes.test.ts` | master `test/unit/agency/proxy-agency-roster.routes.test.ts`@a1f0756a | 77 (56 `it(` + 3 `each`) | 71 | as grouped-stats: API-key cases (5) and the masked-500 budget case deleted; 2 modified (two plugin hooks) |
| `test/unit/agency/proxy-agency-route-table.test.ts` | master `test/unit/agency/proxy-agency-route-table.test.ts`@a1f0756a | 29 (8 `it(` + 1 `each`) | 29 | verbatim cases (`getFile` rename in the s3 mock) |
| `test/unit/agency/proxy-agency-spine.routes.test.ts` | master `test/unit/agency/proxy-agency-spine.routes.test.ts`@a1f0756a | 42 (39 `it(` + 1 `each`) | 40 | the per-page HTTP timeout cases (3) deleted (`callCore` has no socket); +1 NEW: the between-pages time budget |
| `test/unit/agency/proxy-agency-staffing.routes.test.ts` | master `test/unit/agency/proxy-agency-staffing.routes.test.ts`@a1f0756a | 86 (67 `it(` + 1 `each`) | 78 | API-key cases (3) and the core-API-key resolution cases (4) and the per-summary time bound (1) deleted (no key, no transport) |
| `test/unit/agency/proxy-agency-station.routes.test.ts` | master `test/unit/agency/proxy-agency-station.routes.test.ts`@a1f0756a | 58 (38 `it(` + 1 `each`) | 10 | collapsed in-process: 49 deleted (relay, buffer, close propagation/laundering, `isSendableCloseCode` / `truncateCloseReason` / `describeUnsendableCode`, 4502), 2 modified, 1 NEW (1011 without a runtime); 7 verbatim |
| `test/unit/agency/session-join-conflict-route.test.ts` | core `test/unit/agency/session-join-conflict-route.test.ts`@4850d1d9 | 13 (13 `it(` + 0 `each`) | 13 | verbatim (logger mock) |
| `test/unit/agency/spine-read-routes.test.ts` | core `test/unit/agency/spine-read-routes.test.ts`@4850d1d9 | 19 (16 `it(` + 1 `each`) | 20 | 1 modified (agent filter is a UUID); +1 NEW: a non-UUID `agent_user_id` is a 400, never a 22P02 500 |
| `test/unit/agency/station-reconnect-frame.test.ts` | core `test/unit/agency/station-reconnect-frame.test.ts`@4850d1d9 | 4 (4 `it(` + 0 `each`) | 4 | verbatim; `registerStationSocket` instead of `agencyRoutes`; `BreakRegistry` from `@magick-agency/domain` |
| `test/unit/analysis/bridge-analysis-hooks.test.ts` | lane D (core `webrtc-bridge-manager.analysis.test.ts` + seam cases) — on main | 28 (main) | 30 | +2 NEW (`it.each`, 2 rows): a stamped profile id owned by another tenant / account is never snapshotted; 1 modified: the explicit-profile mock row carries its owner (lane D review hardening) |
| `test/unit/api/agency-agent-reach.test.ts` | NEW | — | 3 | NEW: plan §9 "agent reaches only the agent surfaces", agency half, over every agency route from `onRoute` |
| `test/unit/api/agency-route-table.test.ts` | NEW | — | 9 | NEW: the Phase 8 exit gate (route table from `onRoute` vs the console inventory + super-admin UI list) |
| `test/unit/api/agency-station-route.test.ts` | Phase 6 (NEW, no source twin) — on main | 2 (main) | 2 | 2 modified: the socket is at the console path; no `/api/v1/agency` route remains |
| `test/unit/api/core-dispatch.test.ts` | NEW | — | 11 | NEW: `callCore` static resolution, tenancy from context only, transport rules |
| `test/unit/api/middleware/error-handler.middleware.test.ts` | master `test/unit/api/middleware/error-handler.middleware.test.ts`@a1f0756a | 11 (11 `it(` + 0 `each`) | 11 | verbatim |
| `test/unit/api/middleware/error-mask.integration.test.ts` | master `test/unit/api/middleware/error-mask.integration.test.ts`@a1f0756a | 10 (10 `it(` + 0 `each`) | 5 | core-4xx branch dropped (lead ruling): 5 deleted; `/ready` → `/readyz` (1 modified) |
| `test/unit/api/middleware/error-mask.middleware.test.ts` | master `test/unit/api/middleware/error-mask.middleware.test.ts`@a1f0756a | 43 (26 `it(` + 2 `each`) | 17 | core-4xx branch dropped (lead ruling): 27 deleted (named below); +1 NEW "passes ANY 4xx through unchanged" |
| `test/unit/api/middleware/rate-limit.app-scope.test.ts` | NEW | — | 8 | NEW: per-route login/invite limits under the app-scope limiter; `/auth/session` charged; probes exempt; + 3 (review BLOCKING): rotating `x-api-key` / `x-mgkvc-tenant` rotates no bucket (login, `/auth/session`), a duplicated header is not a 500 — mutation-checked |
| `test/unit/api/middleware/rate-limit.middleware.test.ts` | lane C port of core `test/unit/api/middleware/rate-limit.middleware.test.ts` — on main | 37 (main) | 38 | modified: the exemption cases name agency's probes (`/healthz`, `/readyz`); +1 NEW route-class case for `/proxy/agency`, `/dnc`; review BLOCKING fix: 7 modified (the `tenant` / API-key bucket is deleted — an `x-api-key` header selects nothing; the duplicated-header case no longer throws) |
| `test/unit/api/profile-route-auth.test.ts` | NEW | — | 13 | NEW, replaces master `test/unit/api/routes/proxy-call-analysis-profiles.{routes,l2-attach}.test.ts` (see "not ported") |
| `test/unit/api/routes/helpers/csv-attachment.test.ts` | master `test/unit/api/routes/helpers/csv-attachment.test.ts`@a1f0756a | 11 (11 `it(` + 0 `each`) | 11 | verbatim |
| `test/unit/api/routes/phone-numbers-byoc-merge.test.ts` | master `test/unit/api/routes/phone-numbers-byoc-merge.test.ts`@a1f0756a | 12 (12 `it(` + 0 `each`) | 6 | BYOC half deleted (6 deleted, named below); 3 modified (no `is_byoc`; no BYOC expectation) |
| `test/unit/app/max-param-length.test.ts` | NEW | — | 2 | NEW (delta review 6): a 150-char id reaches the route (each family's own 404) on the public app; mutation-checked |
| `test/unit/app/request-id.test.ts` | NEW | — | 2 | NEW (review N4): master's `genReqId` — distinct UUID ids quoted by masked bodies; client id honoured; mutation-checked |
| `test/unit/audit/platform/audit-actor-call-sites.test.ts` | lane A port of master `test/unit/audit/audit-actor-call-sites.test.ts` — on main | 7 (main) | 7 | floor 4 → 22, master's count (dnc 2, campaigns 6, staffing 2, agent 8) |
| `test/unit/audit/platform/catalog.test.ts` | Phase 2b port of master `test/unit/audit/catalog.test.ts` (6) — on main | 3 (main) | 6 | +3 restored verbatim (the D10 call-site scrape: the route files now exist at master's paths); file = master's 6 |
| `test/unit/dnc/dnc.routes.test.ts` | master `test/unit/dnc/dnc.routes.test.ts`@a1f0756a | 46 (46 `it(` + 0 `each`) | 46 | verbatim cases (the `agency` capability mock is gone with governance) |
| `test/unit/proxy/safe-core-path.test.ts` | master `test/unit/proxy/safe-core-path.test.ts`@a1f0756a | 16 (16 `it(` + 0 `each`) | 16 | verbatim |
| `test/unit/utils/recording-url.test.ts` | lane D port of core `test/unit/utils/recording-url.test.ts` — on main | 13 (main) | 13 | 2 modified: the default path is `/api/v1/webrtc-recordings` (lane D review carry-forward) |
| `test/unit/utils/redact-url.test.ts` | master `test/unit/utils/redact-url.test.ts`@a1f0756a | 15 (15 `it(` + 0 `each`) | 13 | 2 deleted: they scrape master's `src/index.ts` request hooks and trace set, which agency does not have |
| `test/integration/agency/agency-agent-state-cycle.test.ts` | core `test/integration/agency/agency-agent-state-cycle.test.ts`@4850d1d9 | 1 (1 `it(` + 0 `each`) | 1 | core's one-walk case verbatim; harness: no API-key auth (header half), UUID ids, worktree test Redis with `cycle:` prefix, the DNC `applyReplace` sync deleted (B8), mocks re-pointed (PORT NOTE) |
| `test/integration/agency/agency-campaign-stats.routes.test.ts` | core `test/integration/agency/agency-campaign-stats.routes.test.ts`@4850d1d9 | 7 (7 `it(` + 0 `each`) | 10 | verbatim (7); +3 NEW: real DNC probe vs the real gate read (2), non-UUID agent filter 400 (1) |
| `test/integration/agency/agency-dnc-mark-route.test.ts` | core `test/integration/agency/agency-dnc-mark-route.test.ts`@4850d1d9 | 4 (4 `it(` + 0 `each`) | 4 | B8 one transaction: 2 modified (assert the `dnc_entries` row, outbox empty, where they asserted the master wire and outbox), 1 modified ("keeps a failed master hop durable…" → "a failed DNC write rolls back the local suppression", a genuine trigger failure), 1 assertion-only change; harness per PORT NOTE |
| `test/integration/agency/agency-ingest-route-seam.test.ts` | core `test/integration/agency/agency-ingest-route-seam.test.ts`@4850d1d9 | 9 (7 `it(` + 1 `each`) | 8 | over the wire → in-process (3 modified); the S2S-auth case deleted (1) |
| `test/integration/agency/runtime-e2e.test.ts` | Phase 6 (NEW, no source twin) — on main | 1 (main) | 1 | modified: the two station upgrades use the console path `/proxy/agency/station/:sessionId` (2 URL edits) |
| `test/integration/api/agency-ingest-job-owner.test.ts` | NEW | — | 4 | NEW: the ingest job carries the proven owner's account; foreign / sibling campaign writes no job (B2 carry-forward) |
| `test/integration/api/agency-my-campaigns.routes.test.ts` | master `test/integration/api/agency-my-campaigns.routes.test.ts`@a1f0756a | 32 (32 `it(` + 0 `each`) | 27 | API-key resolution cases (3), the platform-API-key case and the `agency` capability case deleted. The core hop stays STUBBED here (`callCore` mocked; the assertions are fan-out counts over ids that exist only as staffing rows) — the real hop for this route is `agency-tenant-isolation` "/my-campaigns through the real hop" (tests review 4) |
| `test/integration/api/agency-performance-access.test.ts` | master `test/integration/api/agency-performance-access.test.ts`@a1f0756a | 39 (16 `it(` + 7 `each`) | 21 | platform-API-key sections deleted (decision #5; 20 incl. rows); +2 NEW: malformed `:userId` 400; sibling-account isolation |
| `test/integration/api/agency-performance-forwarding.test.ts` | master `test/integration/api/agency-performance-forwarding.test.ts`@a1f0756a | 28 (24 `it(` + 2 `each`) | 25 | the three error-mask cases deleted (the core-4xx branch; the 5xx case is covered app-wide by `integration/app/error-mask-app-wide`) |
| `test/integration/api/agency-runtime-routes.test.ts` | NEW | — | 30 | NEW: runtime routes through the real app — ownership (403 not_your_attempt, body actor overwritten), isolation (404), the KNOWN SOURCE GAP pinned (incl. a token agent A minted opening agent B station socket, delta review 7), B8 rollback (mutation-checked), `deferred_hangup_ms` / `callback_requested_at` produced, station refusals |
| `test/integration/api/agency-session-conflict-forward.test.ts` | master `test/integration/api/agency-session-conflict-forward.test.ts`@a1f0756a | 13 (13 `it(` + 0 `each`) | 13 | 9 kept, 4 modified (the "unrecognised code IS masked" controls now assert pass-through: core-4xx branch dropped, lead ruling); the network stub is the private core instance behind the real `callCore` |
| `test/integration/api/agency-staffing.routes.test.ts` | master `test/integration/api/agency-staffing.routes.test.ts`@a1f0756a | 58 (54 `it(` + 0 `each`) | 55 | capability-gate block (3) and API-key cases (4) deleted; 1 modified (sibling-account campaign is a real row); +4 NEW (flag off 403, no account 400, cross-tenant 404, foreign campaign name never leaks) |
| `test/integration/api/agency-tenant-isolation.test.ts` | NEW | — | 28 | NEW: tenant/account isolation across every family through the real app; spoofed tenancy headers; malformed ids (path and query) never 500; + ingest jobs (get/cancel/rejected.csv), the recording, the three CSV exports, `/my-campaigns` through the real hop (tests review 5, 4); the sibling recording leg on an attempt of its own campaign (delta review 1; dropping the owning-account predicate reds it) |
| `test/integration/api/phone-number.routes.test.ts` | master `test/integration/api/phone-number.routes.test.ts`@a1f0756a | 9 (9 `it(` + 0 `each`) | 4 | 2 GET cases verbatim; the 7 tag/default administration cases deleted (routes not served); +2 NEW isolation cases |
| `test/integration/app/audit-flush-on-stop.test.ts` | NEW | — | 2 | NEW (delta review 3): the platform bootstrap starts both audit buffers and its stop flushes them (master `index.ts:320`/`:697`, core `:579`/`:903`); real PG; mutation-checked (drop shutdown → case 1 red; drop start → case 2 red) |
| `test/integration/app/error-mask-app-wide.test.ts` | NEW | — | 5 | NEW: no SQL/driver text in any 500 body; genuine 22P02 → 400; probes exempt (real Postgres errors) |
| `test/integration/dnc/dnc-scope-sentinel.test.ts` | lane B1 port of master `test/integration/dnc/dnc-scope-sentinel.test.ts` (6) — on main | 2 (main) | 6 | +4: master's two route-driven describes, driven through `markDnc` (the S2S route is gone, B8); `entry_id`/sync-version assertions deleted; file = master's 6 |
| `packages/contracts/test/console-wire-diff.test.ts` | NEW | — | 2 | the three CONTRACT-DIFF fields |

**Source titles not present in the port** (deleted, or renamed where the row says "modified"):

- `test/unit/agency/dnc-mark-route.test.ts`: "posts the mark to master with the S2S token and a campaign-scoped body"; "SC4: scope 'tenant' stores NULL on the durable row, so the RETRY escalates too"; "still suppresses and reports dnc_recorded false when master errors"; "still suppresses when the master call throws outright"; "reports dnc_recorded false when master refuses the number as invalid"
- `test/unit/agency/dnc-mark.test.ts`: "registers exactly POST /internal/agency/dnc"; "401s with no bearer token"; "401s with a wrong token, and writes nothing"; "accepts any token in the configured list, not only the first"; "treats an explicit campaign_id: null as the tenant-wide escalation"; "400s a non-uuid campaign_id rather than raising 22P02 inside the insert"; "400s the NIL UUID as a campaign_id — it is the index's tenant-wide sentinel"; "still 400s an account_id even when a valid campaign_id rides along"; "400s a supplied account_id rather than writing a row that cannot propagate"; "400s a non-uuid tenant_id"; "reports recorded:true with the entry id on a new write"; "reports recorded:TRUE for a redelivery, flagging already_present separately"; "400s an unparseable number instead of claiming it was recorded"; "does not swallow a write failure into a false success"; "publishes a full replace for the named tenant"; "answers BEFORE the publish resolves — core must not wait on master"; "throttles a second request for the same tenant inside the cooldown"; "throttles per TENANT, not globally"; "accepts again once the cooldown has passed"; "DROPS an expired entry from the map, not merely from the cooldown"; "marks the cooldown BEFORE the publish, not after it finishes"; "requires the S2S token"; "400s a missing or non-uuid tenant_id"
- `test/unit/agency/proxy-agency-agent-actions.test.ts`: "refuses an unattributable caller here rather than spending a round trip"; "refuses a CREATOR-BACKED key, which would otherwise act AS the creator"; "refuses an unattributable caller (API key, no user) without calling core"; "refuses a CREATOR-BACKED key, which would disposition in the creator's name"; "refuses an unattributable caller without spending a round trip"; "refuses a CREATOR-BACKED key on notes too"
- `test/unit/agency/proxy-agency-calls.routes.test.ts`: "runs session, tenant context and the agency gate, in that order"
- `test/unit/agency/proxy-agency-campaign-activity.routes.test.ts`: "[each] serves master's rows with partial: true on %s — never a 500, never a short list"; "swallows core's failure without recording it for the error mask"; "drops only the unreadable row, keeping the rest of core's half"; "still serves the vocabulary when core is unreachable"; "bounds the ownership probe rather than letting it run to core's global timeout"; "refuses rather than writing a file missing core's half"; "bounds every core call by what is left of the budget"; "reports a deadline that fires mid-page as time_limit, not as a 424"; "never hands the first page an already-expired timeout"; "bounds the ownership probe separately from the export budget"; "refuses the export when the ownership probe itself times out"; "says retention is unknown when core carried no retention field at all"
- `test/unit/agency/proxy-agency-campaign-behavioral-capabilities.routes.test.ts`: "the section preHandler still refuses on `agency` itself when the parent is off"; "kill switch OFF lets an enabling body straight through, and never reads overrides"
- `test/unit/agency/proxy-agency-campaign-retry.routes.test.ts`: "the section capability still gates the whole surface when `agency` itself is off"
- `test/unit/agency/proxy-agency-campaign-stats-enrichment.routes.test.ts`: "promotes credits_low into stall when core diagnosed nothing"; "reports estimated_connects_remaining as the balance floor-divided by the connect rate"; "does not fire above a RAISED threshold, and does below it"; "wins over a LOWER-priority core arm, demoting it into other_stalls"; "LOSES to a higher-priority core arm, taking other_stalls itself"; "never discards core’s arm — its code survives in one field or the other"; "re-sorts other_stalls by the shared priority after inserting the demoted code"; "does not duplicate credits_low if core already listed it in other_stalls"; "treats a missing balance row as zero and still diagnoses"; "leaves core’s diagnosis alone when the balance read throws, and stays 200"; "survives the CREDIT half of the enrichment too, null included"; "survives the CREDIT half of the enrichment too"
- `test/unit/agency/proxy-agency-campaign-transition-actor.routes.test.ts`: "[each] %s refuses to attribute a PLATFORM API KEY to its creator"; "a client-supplied actor does not survive a key-authenticated call either"; "[each] %s names the CREDENTIAL, not its creator, for a key caller"; "still records that a key acted when the credential id is unavailable"
- `test/unit/agency/proxy-agency-grouped-stats.routes.test.ts`: "and the harness can really mask — an unlisted, detail-less code does NOT survive"; "surfaces an expired budget as a MASKED 500, leaking nothing"; "refuses a USERLESS key — now at RBAC, one layer earlier"; "refuses it BEFORE the account predicate, so a key cannot probe scoping"; "refuses it before the query whitelist too, so it cannot probe the API"; "ALSO refuses a key that names its creator, whose role would have passed"; "and the RBAC floor still answers first when the creator is below it"; "refuses a creator-backed key BEFORE the account predicate too"; "runs session → tenant-context → capability"; "is refused when the capability hook refuses"
- `test/unit/agency/proxy-agency-my-surfaces.routes.test.ts`: "${path}: refuses a platform API key, which has no "my""; "${path}: refuses a CREATOR-BACKED key too, not just a system one"; "[each] %s runs session → tenant-context → capability"; "asks for the `agency` capability by name, once per registration"; "refuses the request when the capability hook refuses, on every route"; "registers exactly these three plugin-level hooks, so a fourth is noticed"
- `test/unit/agency/proxy-agency-roster.routes.test.ts`: "surfaces an expired budget as a MASKED 500, leaking nothing"; "refuses a USERLESS key — now at RBAC, one layer earlier"; "refuses it BEFORE the account predicate, so a key cannot probe scoping"; "ALSO refuses a key that names its creator, whose role would have passed"; "and the RBAC floor still answers first when the creator is below it"; "refuses a creator-backed key BEFORE the account predicate too"; "runs session → tenant-context → capability"; "is refused when the capability hook refuses"
- `test/unit/agency/proxy-agency-spine.routes.test.ts`: "turns a mid-page deadline abort into a TRUNCATED file, not a 500"; "never hands core a zero or negative timeout, on any page"; "hands each page what is left of the time budget rather than only checking between pages"
- `test/unit/agency/proxy-agency-staffing.routes.test.ts`: "refuses a platform API key, which has no "my""; "resolves the core API key ONCE for the whole fan-out"; "does not resolve a key at all for an unstaffed agent"; "answers 200 with null labels when the key cannot be resolved at all"; "the singular route survives an unresolvable key too"; "refuses a platform API key, which has no "my""; "bounds each summary lookup in TIME, where there was no bound at all"; "refuses a platform API key, which has no "my""
- `test/unit/agency/proxy-agency-station.routes.test.ts`: "${sendable ? 'sends' : 'refuses'} ${code} — ${why}"; "agrees with ws about every code in and around the ranges it cares about"; "leaves a reason inside the budget untouched"; "leaves a reason at exactly the budget untouched"; "measures BYTES, not characters — a 123-character multi-byte reason is over budget"; "drops a whole emoji rather than splitting its surrogate pair"; "drops trailing emoji whole when several straddle the budget"; "keeps the code marker and trims the peer's tail — the production-reachable case"; "marks the three no-status sentinels as such"; "uses the separate peer-code marker for codes that are merely unsendable"; "appends the peer's own reason after the marker"; "emits a bare marker when the peer sent no reason"; "relays agency control frames from core to the agent verbatim"; "relays BRIDGE-originated frames too — the frame set is not closed"; "relays the released frame with its reason intact"; "relays agent frames up to core"; "buffers agent frames sent before the upstream is open rather than dropping them"; "propagates core's close code and reason to the agent"; "substitutes a legal code when the peer closed without one"; "carries the unsendable code in the close reason instead of erasing it"; "logs the observed code alongside the code it actually sent"; "does not mark a sendable code as laundered"; "[each] forwards core's %i verbatim — both private-range codes, not just one"; "reports null rather than false on the cascade line, where nothing was sent"; "does not claim it forwarded a code to a core leg that was still upgrading"; "marks exactly one close line per bridge as the initiating one"; "names the agent-leg transport error on the wire and in the log"; "closes the upstream when the agent disconnects"; "reports an unreachable core distinctly from core closing the socket"; "survives a long session of many frames in both directions"
- `test/unit/api/middleware/error-mask.integration.test.ts`: "masks a forwarded bare core 4xx (provider error)"; "shows a forwarded core 4xx that carries field-level validation"; "shows a forwarded core 4xx carrying an allow-listed media code"; "shows a forwarded core 403 for a disabled feature"; "still masks a forwarded core 4xx whose code is not allow-listed"; "exempts /ready so its diagnostics survive"
- `test/unit/api/middleware/error-mask.middleware.test.ts`: "masks a bare provider/internal error (no validation structure)"; "shows a core validation error carrying details/fieldErrors"; "shows a core resource validation error with an allow-listed code"; "shows a core duplicate name error with an allow-listed code"; "[each] shows the agency agent-action error %s (%i) rather than masking it"; "shows a core invalid slug error with an allow-listed code"; "[each] forwards the actionable announcement audio error %s"; "forwards the analysis-profile 404 now that core codes it (MAG-149)"; "still masks an ordinary core 404 carrying no code"; "still masks an unknown core code"; "masks per-recipient calls[] feedback (error_message is free text that can leak provider strings)"; "masks a 4xx core text error (unparseable as JSON)"
- `test/unit/api/routes/phone-numbers-byoc-merge.test.ts`: "stamps is_byoc:false on every platform row, always present"; "appends BYOC numbers with is_byoc:true, projected onto the assignment shape"; "fetches core WITHOUT a provider filter — this list feeds every selector"; "degrades to platform numbers when core answers nothing"; "never lets an unexpected core field reach the tenant"; "prefers the platform row when the same number appears on both sides"; "does not ask for account tags on a BYOC number (there is no assignment row)"
- `test/unit/utils/redact-url.test.ts`: "src/index.ts logs a REDACTED url on both request hooks"; "the trace instrumentation set hands the redactor to the HTTP instrumentation"
- `test/integration/agency/agency-dnc-mark-route.test.ts`: "defaults to campaign scope across HTTP, roster SQL, the outbox, and the master wire"; "stores and forwards tenant scope without a campaign id while suppressing locally immediately"; "keeps a failed master hop durable and later lands the byte-identical scoped payload"
- `test/integration/agency/agency-ingest-route-seam.test.ts`: "is a REAL S2S-guarded endpoint: an unauthenticated chunk writes nothing to the database"; "a chunk accepted over HTTP lands with tenancy taken from the campaign row, and the CSV line in csv_line_number"; "the master-restart replay is refused over HTTP too, and the response names which layer refused it"; "a lost chunk is reported as a gap on the final chunk, over the wire"
- `test/integration/api/agency-my-campaigns.routes.test.ts`: "resolves the API key ONCE for the whole fan-out, not once per campaign"; "skips the key resolution entirely when there is nothing to name"; "degrades to nulls — never a 500 — when the key cannot be resolved at all"; "a platform API key is refused — there is no "my" for a key"; "refused when the `agency` capability is off, before anything is read"
- `test/integration/api/agency-performance-access.test.ts`: "[each] %s: refuses a CREATOR-BACKED key with missing_actor"; "[each] %s: refuses a SYSTEM key EARLIER — no membership, no access"; "refuses BOTH key shapes and lets neither reach core"; "never names the key CREATOR in the refusal"; "the key is not simply broken — it reaches a SUPERVISORY route fine"; "a key for ANOTHER tenant cannot name this tenant"; "[each] $name: refused with missing_actor, and nothing reaches core"; "but a SIGNED-IN supervisor is allowed, and does carry on_behalf"; "and a signed-in AGENT is allowed WITHOUT on_behalf"
- `test/integration/api/agency-performance-forwarding.test.ts`: "MASKS a core 5xx — no upstream detail reaches the client"; "MASKS a bare core 4xx that carries no field feedback"; "PASSES THROUGH a 429, because pacing is an authored signal"
- `test/integration/api/agency-session-conflict-forward.test.ts`: "a bare { error, message } 409 from core is masked — no code, nothing to rescue it"; "“Conflict” as a LABEL rescues nothing — only the code does"
- `test/integration/api/agency-staffing.routes.test.ts`: "refuses all five routes when the capability is off"; "fails CLOSED when governance cannot be resolved"; "resolves the capability for the request’s active (tenant, account)"; "refuses a SYSTEM platform API key — no membership, no access"; "refuses a CREATOR-BACKED key, which would otherwise answer AS the creator"; "refuses a SYSTEM platform API key — no membership, no access"; "refuses a CREATOR-BACKED key, which would otherwise answer AS the creator"
- `test/integration/api/phone-number.routes.test.ts`: "creates a tag and returns 201"; "returns 404 for assignment belonging to different tenant"; "returns 400 for missing account_id"; "removes the tag and returns 204"; "returns 404 for non-existent tag"; "sets the tag as account default"; "returns 404 for assignment belonging to different tenant"

### 8.6 Source suites not ported (Phase 8 scope)

| Source | Cases | Why |
|---|---|---|
| master `test/unit/api/middleware/error-mask.agency-contract.test.ts` | 80 | core-4xx allow-list vs core's scraped codes: the branch is dropped (lead ruling) |
| master `error-mask.als`, `.escalation-destinations`, `.escalation-dispatch`, `.intro-audio-forwarding`, `.intro-audio`, `.knowledge-bases`, `.retry-campaigns`, `.route-emissions`, `.session-conflict` (unit) | 12, 19, 14, 39, 8, 20, 14, 8, 9 | the core-4xx branch (ALS status recording, forwardable codes per surface); escalation, intro audio and knowledge bases are AI surfaces |
| master `test/integration/api/agency-action-error-mask.test.ts` | 10 | 9 cases are agency action codes surviving the core-4xx branch (dropped: every 4xx passes). The 10th, "a core 5xx is masked even when it wears an allow-listed agency code" (master `:251-266`), guards the 5xx branch, which is covered structurally by `error-mask.middleware.test.ts` "masks any 5xx" — no allow-list exists for a 5xx to wear |
| master `test/unit/api/routes/proxy-call-analysis-profiles.routes.test.ts`, `.l2-attach.test.ts` | 16, 12 | the passthrough is collapsed; its chain is `profile-route-auth.ts` (`profile-route-auth.test.ts`, NEW: capability on/off/NULL/no row/throw, order, RBAC floors, tenant/account handed on) and "no route without a guard" is `agency-agent-reach` "every agency route needs a session"; the softphone-capability cases are deleted with the softphone |
| master `test/unit/api/routes/phone-number-inbound.test.ts`, `internal-phone-numbers.routes.test.ts`, `services/byoc-phone-number.service.test.ts`, `api/validators/phone-number.validator.test.ts` | 44, 15, 20, 8 | inbound routing (AI), S2S phone numbers, BYOC, the tag validator of an unserved route |
| core `test/unit/agency/agency-internal-auth.test.ts` | 5 | 4 S2S-token cases deleted with the route; the 1 non-auth case is in `agency-internal-ingest-ownership` |
| master `test/unit/dnc/internal-agency.routes.test.ts` (32) | 16 deleted | route table, S2S auth ×3, client-supplied null/non-UUID ids ×3, `/dnc-resync` ×9 (the resync is deleted with the Redis set, B8); the mark half (16) is `test/unit/agency/dnc-mark.test.ts` |
| core `test/unit/utils/api-key.test.ts` (lane C port, 3) | 3 | `hashApiKey` deleted with the limiter's API-key bucket |

### 8.7 For the lead (deviations and open points)

1. Profiles: `agency.analytics` opens all five routes (master: the list only). Lead: to Manas.
2. `callCore` drops core's identity headers from extra headers (new hardening; tested).
3. The analysis hook ignores a stamped profile of another tenant/account (new behaviour; tested).
4. `GET /phone-numbers` rows carry no `is_byoc` (contracts removed it).
5. The masked body names `support@magickvoice.com` (master's). Lead: to Manas.
6. `supervisor_hold`: declared, no producer. Lead: to Manas.
7. The inverted activity window keeps master's rule (`from > to` refused, equal allowed). Lead: confirmed.
8. `initAnalytics()` stays first in `main()` (core `index.ts:244`), above the bootstraps and `listen`; no test (`index.ts` runs `main()` at import); `runtime-boot-order.test.ts` stays green.
9. The DNC mark's failure mode changed with B8: core kept the suppression and an outbox row when master was down (`dnc_recorded: false`); here a failed `dnc_entries` insert rolls back the suppression and the route answers a masked 500 (nothing claimed). A non-E.164 roster number is not a failure: the marked contact is suppressed and `dnc_recorded: false`.
10. **Access control (§8.8): a KNOWN SOURCE GAP**, kept verbatim and pinned: the session routes check tenant + account, not the agent — including a token one agent mints opening another agent's station socket in the same account.
11. Audit flush order: master flushed its audit buffer AFTER `app.close()` (`src/index.ts:689-697`); agency's `index.ts` (lead-owned) runs the lanes' stops, the platform's flush last, and then `app.close()`. A request still in flight then can log after the flush. Moving `app.close()` ahead of the stops in `index.ts` would match master; not done (lead-owned; Phase 6's boot-order test pins the stop order).

### 8.8 Access-control audit of the runtime routes (lead request)

Audited at `f674947` against core `agency.routes.ts`@4850d1d9 and master `proxy-agency-agent.routes.ts`@a1f0756a.

| Surface | Source behaviour | Port | Test (real app, `agency-runtime-routes`) |
|---|---|---|---|
| Attempt actions: hangup, disposition, notes, DNC with `disposition_code` | Core `checkActor(reservedUserId, body)` (`disposition.ts:88-106`): `reserved_agent_id` → session → `agent_user_id` against the body's `agent_user_id`; `on_behalf` only if master asserted it. Master builds the body as `{ ...zodParsed, ...resolveAgencyActor(request) }` (`proxy-agency-agent.routes.ts`), so `agent_user_id` is the session user and `on_behalf` is set only for `agency.supervise`; the zod schemas strip any client `agent_user_id` / `on_behalf` | verbatim | agent A on agent B's attempt → 403 `not_your_attempt`, nothing written (4 routes); a body naming B as actor changes nothing (mutation: spreading `request.body` last reds it); B and a supervisor (on behalf) succeed |
| DNC mark without a disposition | Core: "a plain mark-DNC deliberately has no ownership rule — a supervisor suppressing a number mid-shift is a real action" (`agency.routes.ts:1169`@4850d1d9); floor `agency.dnc.write` (agent) | verbatim (design, not a gap) | — |
| Private core instance | Reachable only through `callCore`; not in the app's route table | — | route-table "never exposes core's handler modules"; `core-dispatch` tenancy cases |
| Session routes: station-token, available, break, break/cancel, leave | Core `requireOwnedSession` (`agency.routes.ts:1340-1355`@4850d1d9): tenant + account + `left_at` only; master passes no actor on these five | ~~verbatim — SOURCE GAP~~ **modified, Q8 (Manas, 2026-10-09), OQ-1**: master now sends the actor and `requireOwnedSession` refuses a non-owner with the not-found 404; supervisors may NOT drive these five | foreign tenant / sibling account → 404 (7 cases); the former CURRENT BEHAVIOR cases are flipped: agent A on B's session → 404 for all five, B untouched; owner's token opens their own socket; supervisor → 404 |
| `POST /sessions` | Core takes `agent_user_id` from the body; master injects the session user (`resolveAgencyActor`) and zod strips the client's | verbatim | the session row's agent is the caller even when the body names agent B |
| force-available | `agency.supervise` (account_admin) + `requireOwnedSession` (tenant + account) | modified, Q8: the one session route where a supervisor (`on_behalf`) may act on another agent's session (OQ-1) | an agent → 403; a supervisor on another account's session → 404; a supervisor on a same-account agent's session → 200 |
| Station socket `/proxy/agency/station/:sessionId` | Token minted per session at an authenticated route; `verifyAndConsume(sessionId, token)` binds it to the session, single-use | collapsed (§8.2) | tokenless → 4401; a token for a different session → 4401; path-escaping id → 1008; CURRENT BEHAVIOR (blast radius): a token agent A minted for B's session opens B's station socket and receives B's `ready` |

### 8.9 Branding: no MagickVoice in user-facing server copy (decision B17)

| Source | Destination | Status | Change and test |
|---|---|---|---|
| master `src/api/middleware/error-mask.middleware.ts`@a1f0756a | same path | modified | `SUPPORT_EMAIL` (`support@magickvoice.com`) deleted; the masked message is the exported `MASKED_ERROR_MESSAGE` ("…Please contact support and quote the request ID below…"), no address and no config key. Tests re-pointed, same counts: `error-mask.middleware.test.ts` (17; the 5xx label case now asserts the exact message and no `@`), `error-mask.integration.test.ts` (5; `isMasked` matches the generic phrase), integration `agency-session-conflict-forward.test.ts` (imports `MASKED_ERROR_MESSAGE`) |
| master `src/config/schema.ts:450-479` (`brand.name` default) | `src/config/blocks/platform.ts` | modified | `PLATFORM_BRAND_NAME` default `MagickVoice` → `Magick Agency` |
| master `src/notifications/templates/agent-invite.template.ts` | same path | modified | `agencyProductName` appends only `Dialer` when the brand already ends in the word "Agency" (default → "Magick Agency Dialer", not "Magick Agency Agency Dialer"); any other brand composes as master did. `agent-invite.template.test.ts` 1 NEW case (`does not double "Agency"…`); its `BASE.brandName` and the subject/headline/logo-fallback assertions move to `Magick Agency`. Fixtures `brand.name: 'MagickVoice'` → `'Magick Agency'` in `invite-mailer`, `invites.routes`, `notification.routes`, `user-offboarding-staffing`, `agency-campaign-unsubscribe` tests (same counts) |
| master `src/agency/agency-spine.ts`, `src/agency/agency-activity.ts`@a1f0756a (CSV preambles) | same paths | modified | `# MagickVoice platform — campaign … export` → `# Magick Agency — campaign … export` (three preamble lines). `proxy-agency-spine.routes.test.ts` assertion updated (same count) |
| — | `test/unit/branding/no-parent-brand.test.ts` | NEW (4) | Fails on any `magick[ -_]?voice` / `magic[ -_]?voice` left in `src/**/*.ts` after comments are stripped (`.json` excluded: the VoiceLink fixture's `description` names the source repo); renders the default-config invite mail, product noun and masked body and asserts none names the parent product. Mutations (each → red): brand default back to `MagickVoice` (3 red), the address back in the masked message (2 red), an activity preamble back (1 red); `agencyProductName` de-dup removed (6 red across this file, the template and the mailer tests) |

Not changed (follow-ups): the internal header names `x-mgkvc-tenant`, `x-mgkvc-account`, `x-mgkvc-tenant-name`,
`x-mgkvc-account-name`, `x-mgkvc-originator` (`api/middleware/headers.ts`, the console's and super-admin's
`config.ts`) are wire, not shown to users. The completion mail's "Sent by Sapionic" / `[Sapionic]` subject and the
Mailjet `fromName` default `Sapionic` name the company, not MagickVoice. The accent `#7c5cfc` is kept.

Printed after B17 (`apps/server`): `pnpm lint` 0 errors; `pnpm test`: 295 files, 6280 passed (6275 + 5 new);
`pnpm test:integration`: 104 files, 1162 passed; `pnpm build` ok.

Review follow-ups (`4824a58`, test-only on the server): the guard also scans `packages/{contracts,db,domain,observability}/src`
(mutation: a probe string in `packages/db/src/connection.ts` and in `packages/contracts/src/errors.ts` → both listed),
and its stripper keeps the `//` of a URL scheme (NEW self-test case, 5 cases; mutation: rule removed → red). Lead-authorised
comment edit: `packages/contracts/src/api/platform/invite.ts:53` example → "Magick Agency Dialer". Printed: 295 files, 6281
passed. Integration not re-run (no server `src` change).

## Phase 9 — console

Source: cusui `magick-comms-cusui@ee5beb4400ec1fb5fdf6049871681ae6875e8d29` (v2.96.0) → `apps/console`
(branch `phase-9/console`). Path rule: cusui `src/<path>` → `apps/console/src/<path>`. Commit `6312045` is
the byte-for-byte copy of the import closure, and `01c12de` / `cf54fa8^` the verbatim test copies, so every
change below is a reviewable diff against them.

### 9.1 What the console is, and the decisions it was built on

- **Scope.** The agency tree (`pages/agency/**`, `components/agency/**`, `pages/campaigns/agency/**`, every
  agency hook and util, `useAgencyStation` and the station socket client), auth (`AuthContext`,
  `AgencyLoginPage` as the one door, `/agency/join/:token`, `VerifyEmailPage`), `TenantContext`, team and
  invites (`TeamPage`), the settings that apply to agency (`NotificationSettingsPage`, `AnalysisProfilesPage`),
  both shells, the API client (`apiFetch`) and the `components/common` the ported pages use. Not ported:
  everything AI (calls, prompts, IVR, automations, broadcasts and bulk jobs, messaging, documents, schedules,
  escalation, the AI dashboard), billing and credits, BYOC, API keys, `LoginPage` (AI marketing and a sign-up
  tab) and `/onboarding`, `TenantSettingsPage` / `AccountsPage` / `AuditLogPage` (no served route), and
  super-admin (Phase 9b).
- **API paths (B16).** Unchanged from cusui, with `API_BASE = VITE_API_BASE_URL || ''`, except the client flag
  map: `/proxy/feature-flags` → `GET /feature-flags` (lane A). Dev proxy (`vite.config.ts`): `/auth /accounts
  /tenants /users /invites /notifications /feature-flags /proxy /dnc /phone-numbers` → `:3021`, `ws` on `/proxy` (the station
  socket). The scaffold's `/api` entry is gone. **Console paths Phase 8 must serve or list:** every
  `/proxy/agency/...` and `/dnc` call in `src/api/*`, `/proxy/call-analysis-profiles`, `GET /phone-numbers`
  (the caller-ID picker; not in lane A's A.1 list), and the two call-detail defaults
  `/proxy/calls/:id/recording|retry-analysis` (unreachable from agency: `AgencyAttemptCallPage` overrides both).
- **Types.** The `src/types/*` files cusui shared with the wire re-export `@magick-agency/contracts/api/agency/*`
  and `.../api/platform/*`, so every ported import path is unchanged.
- **RBAC.** `utils/permissions.ts` re-exports the contract's matrix (one matrix for server and UI). cusui's names
  are renamed at every call site: `proxy.contact_lists.read|write` → `agency.campaigns.read|write`,
  `proxy.prompts.read|write` → `agency.analysis_profiles.read|write`, `proxy.feature_flags.read` →
  `agency.flags.read`, `proxy.phone_numbers.read` → `agency.phone_numbers.read` (contract `bb1e581`, floor
  `viewer`). cusui checks `proxy.phone_numbers.read` in no source file — the caller-ID picker
  (`pages/agency/CallerIdPicker.tsx`, `hooks/usePhoneNumbers.ts`) is ungated in cusui and stays so here —
  so that rename lands only in `agentPermissions.test.ts`, whose pre-dialer list carried it (cusui line 42).
- **Governance → settings (plan §3.2).** `GovernanceContext` keeps its name and value shape and DERIVES the map
  from `useAuth().settings[accountId]`: `agency` always true, `agency.recording` = `allow_recording`,
  `agency.analytics` = `analyze_calls`, any other key fail-open (cusui's rule). There is no
  `/governance/effective` read. The per-field recording and analysis checks on campaign settings are unchanged
  (mutation-checked, 9.4).
- **Session path 4 (plan §3.1).** A 403 `no_membership` from `POST /auth/session` is kept as
  `AuthContext.sessionRefusal` (`utils/sessionRefusal.ts`) and renders `AgencyLoginPage`'s "We don't recognise
  that account" screen — from a button press and after a reload — never a sign-up.
- **Shells.** Both of cusui's: `AgencyLayout` (the workspace) and `AppLayout` at `/app`, now the platform zone
  only (Team, Notifications, Call summaries). `/app`'s index is the new `AppHomeRedirect`; it must not redirect
  into `/agency` (cusui's §7b: that bounces the workspace exit). `/login` renders `AgencyLoginPage`.
- **`credits_low` (plan §3.3)** is removed from the health strip's priority, labels and copy, with a deletion test.
- **Test locale.** `vite.config.ts` sets `LANG` and `LC_ALL` to `en_US.UTF-8` beside cusui's TZ pin, and the
  pool is `forks` (cusui: `threads`). cusui's suite assumes en-US formatting, and ICU reads the locale once per
  process at start, so a worker THREAD keeps its parent's locale (verified: with `threads` and the env pin, 6
  cases still fail under `LANG=en_IN.UTF-8`); a forked worker inherits the pin. A bare `npx vitest run` under
  `LANG=en_IN.UTF-8`, and `pnpm test` under `de_DE`, both print 4363 passed (215 files) at the head of this
  branch. Cost: more wall time than `threads`; how much is machine-dependent.
- **Dev-proxy prefixes** (`API_PREFIXES` in `vite.config.ts`, all → `http://localhost:3021`): `/auth`, `/accounts`,
  `/tenants`, `/users`, `/invites`, `/notifications`, `/feature-flags`, `/proxy` (with `ws`, the station socket),
  `/dnc`, `/phone-numbers` (added by the lead after the console review: the caller-ID picker's GET fell
  through to the SPA fallback in dev). A Phase 8 route under any other prefix needs a line here; NEW
  `src/__tests__/devProxyPrefixes.test.ts` (1) fails when a `${API_BASE}/<segment>` in `src` is not proxied.
- **Dependencies added** (`apps/console/package.json`, at cusui's majors): `firebase ^11.0.0`,
  `lucide-react ^0.500.0`, `posthog-js ^1.380.1`, `date-fns ^4.1.0`. No chart library: the agency charts are
  hand-drawn SVG.
- **Build and config files.** `vite.config.ts` is cusui's (TZ pin, brand plugin, `__APP_VERSION__`/`__BRAND__`
  defines, unit/timezone projects) with port 5175 and the proxy above. `index.html` and `brands/magickvoice/` were
  verbatim until decision B17 (§9.6), which replaced the pack with `brands/magick-agency/` and dropped the favicon. `tsconfig.json` has no `types` allow-list (cusui had none; `brand/load-brand.ts` uses `node:fs`).

### 9.2 Source files

293 files are byte-identical to cusui (`cmp` against an extract of `ee5beb44`), by directory: `src/` 3, `src/analytics/` 4, `src/api/` 13, `src/brand/` 3, `src/components/agency/` 76, `src/components/audio/` 2, `src/components/auth/` 1, `src/components/calls/` 2, `src/components/common/` 45, `src/components/layout/` 13, `src/contexts/` 3, `src/hooks/` 22, `src/pages/agency/` 28, `src/pages/auth/` 1, `src/pages/calls/` 1, `src/pages/campaigns/agency/` 13, `src/pages/campaigns/components/` 2, `src/pages/settings/` 3, `src/pages/team/` 2, `src/utils/` 56

| Source (cusui `ee5beb44`) | Destination | Kind | Reason |
|---|---|---|---|
| `src/App.tsx` | `apps/console/src/App.tsx` | modified | cut to the console scope: agency doors, `/`, the four agent routes, the `/agency` tree verbatim; `/app` keeps Team, Notifications, Call summaries; `/login` = `AgencyLoginPage`; `/app` index = `AppHomeRedirect`; `MetadataProvider`, `SuperAdminProvider`, `IndependenceDayDecor` and every AI route not mounted; call-summaries gated on `agency.analytics` + `agency_call_analysis` |
| `src/analytics/events.ts` | `apps/console/src/analytics/events.ts` | modified | AI, onboarding, messaging, credits and broadcast trackers removed; gate ids cut to agency’s (+`agency_call_analysis`); setup events cut to team invites; export scopes unchanged |
| `src/api/accounts.ts` | `apps/console/src/api/accounts.ts` | modified | `createAccount` / `updateAccount` / `deleteAccount` removed (not served; account admin is super-admin’s) |
| `src/api/agency.ts` | `apps/console/src/api/agency.ts` | modified | comments only: permission names |
| `src/api/agencyCampaigns.ts` | `apps/console/src/api/agencyCampaigns.ts` | modified | comments only: permission names |
| `src/api/calls.ts` | `apps/console/src/api/calls.ts` | modified | cut to `retryAnalysis` + `fetchRecordingBlobUrl` (the shared call-detail defaults; the agency page overrides both) |
| `src/api/exportCsv.ts` | `apps/console/src/api/exportCsv.ts` | modified | cut to `outcomeReportFilename`; the AI calls/static-calls downloader removed |
| `src/api/notifications.ts` | `apps/console/src/api/notifications.ts` | modified | `previewDigest` removed (credits usage digest) |
| `src/api/phone-numbers.ts` | `apps/console/src/api/phone-numbers.ts` | modified | cut to `listMyPhoneNumbers` (the caller-ID picker); tagging and inbound config removed |
| `src/api/tenants.ts` | `apps/console/src/api/tenants.ts` | modified | `listTenants` / `updateTenant` removed (not served, PORTING A.1) |
| `src/components/auth/HomeRedirect.tsx` | `apps/console/src/components/auth/HomeRedirect.tsx` | modified | `PRIMARY_APP_PRODUCTS` / `isAgencyOnlyTenant` removed; agency-only = the dialer flag alone |
| `src/components/auth/RequireCapability.tsx` | `apps/console/src/components/auth/RequireCapability.tsx` | modified | known-gate union cut to `agency`, `agency.recording`, `agency.analytics`; reads the settings-derived map via `GovernanceContext` |
| `src/components/auth/RequireFlag.tsx` | `apps/console/src/components/auth/RequireFlag.tsx` | modified | tracks the agency flags (`agency_dialer_enabled`, `agency_call_analysis`) instead of `custom_sip` / `ai_call_transfer` |
| `src/components/common/GlobalSearch.tsx` | `apps/console/src/components/common/GlobalSearch.tsx` | modified | page directory cut to the agency workspace, Team, Notifications; Call Summaries entry on agency’s gates |
| `src/components/common/index.ts` | `apps/console/src/components/common/index.ts` | modified | barrel drops the ten unported components |
| `src/components/layout/AgencySidebar.tsx` | `apps/console/src/components/layout/AgencySidebar.tsx` | modified | permission names (`agency.campaigns.read|write`) |
| `src/components/layout/Sidebar.tsx` | `apps/console/src/components/layout/Sidebar.tsx` | modified | nav cut to ADMIN: Team, Notifications, Call Summaries (agency gates); icons trimmed; the `end` list (`/app`, `/app/calls`, `/app/calls/softphone`) and the `/app/calls` active-state override (`/app/calls/browser`, `/app/calls/softphone`) deleted — none is a console nav item, so both were always false (test: NEW `Sidebar.activeState`) |
| `src/components/layout/TopBar.tsx` | `apps/console/src/components/layout/TopBar.tsx` | modified | `CreditBadge` and the Settings / Credits / API Keys menu items removed |
| `src/config.ts` | `apps/console/src/config.ts` | modified | ENDPOINTS cut to what the console calls; `featureFlags` → `/feature-flags`; governance, credits, AI, super-admin, API-key endpoints and the TTS / credits constants removed; `ENDPOINTS.tenants.base` / `.get` and `ENDPOINTS.accounts.get` deleted (no caller; `tsc` is the guard); `DOCS_SLUGS` cut from 31 to `team`, the one guide a ported page links (`TeamPage`) — the other 30 are guides for unported pages (test: `PageDescription`, re-pointed) |
| `src/config/telephonyProviders.ts` | `apps/console/src/config/telephonyProviders.ts` | modified | BYOC badge copy removed |
| `src/contexts/AuthContext.tsx` | `apps/console/src/contexts/AuthContext.tsx` | modified | `governance` → `settings`; path-4 state (`defaultAccount`, `isNew`, `needsPhone`, `signUpEmail`, `updatePhone`, phone stash) removed; NEW `sessionRefusal`; concurrency-limits cache clear removed |
| `src/contexts/GovernanceContext.tsx` | `apps/console/src/contexts/GovernanceContext.tsx` | modified | capability map DERIVED from `useAuth().settings[accountId]` (no `/governance/effective` read); `agency` always on |
| `src/contexts/TenantContext.tsx` | `apps/console/src/contexts/TenantContext.tsx` | modified | `default_account` branch removed (path 4 only) |
| `src/hooks/useAccounts.ts` | `apps/console/src/hooks/useAccounts.ts` | modified | `remove` removed (account delete not served) |
| `src/pages/agency/AgencyAnalyticsPage.tsx` | `apps/console/src/pages/agency/AgencyAnalyticsPage.tsx` | modified | permission names |
| `src/pages/agency/AgencyCampaignContactsPage.tsx` | `apps/console/src/pages/agency/AgencyCampaignContactsPage.tsx` | modified | permission names |
| `src/pages/agency/AgencyCampaignDetailPage.tsx` | `apps/console/src/pages/agency/AgencyCampaignDetailPage.tsx` | modified | permission names |
| `src/pages/agency/AgencyCampaignRosterPage.tsx` | `apps/console/src/pages/agency/AgencyCampaignRosterPage.tsx` | modified | permission names |
| `src/pages/agency/AgencyCampaignSettingsPage.tsx` | `apps/console/src/pages/agency/AgencyCampaignSettingsPage.tsx` | modified | master’s profile-LIST capability split removed: `agency.analytics` alone decides the picker; the per-field recording/analysis checks are unchanged |
| `src/pages/agency/AgencyCampaignsPage.tsx` | `apps/console/src/pages/agency/AgencyCampaignsPage.tsx` | modified | permission names |
| `src/pages/agency/AgencyHomeRedirect.tsx` | `apps/console/src/pages/agency/AgencyHomeRedirect.tsx` | modified | comments only: permission names |
| `src/pages/agency/AgencyLoginPage.tsx` | `apps/console/src/pages/agency/AgencyLoginPage.tsx` | modified | unrecognised-account screen driven by 403 `no_membership` (button press and listener refusal), not `is_new`; both `/login` cross-links removed |
| `src/pages/agency/AgentConsolePage.tsx` | `apps/console/src/pages/agency/AgentConsolePage.tsx` | modified | comments: permission names; passes `intervals.deferred_hangup_ms` to `StateRail` (CONTRACT-DIFF §1) |
| `src/pages/agency/CallerIdPicker.tsx` | `apps/console/src/pages/agency/CallerIdPicker.tsx` | modified | BYOC badge removed |
| `src/pages/settings/AnalysisProfilesPage.tsx` | `apps/console/src/pages/settings/AnalysisProfilesPage.tsx` | modified | permission name `agency.analysis_profiles.write` |
| `src/pages/settings/NotificationSettingsPage.tsx` | `apps/console/src/pages/settings/NotificationSettingsPage.tsx` | modified | digest preview (button, modal, formatters) removed |
| `src/types/agency-activity.ts` | `apps/console/src/types/agency-activity.ts` | modified | re-export of `@magick-agency/contracts/api/agency/agency-activity` (see CONTRACT-DIFF.md) |
| `src/types/agency-campaign-series.ts` | `apps/console/src/types/agency-campaign-series.ts` | modified | re-export of `@magick-agency/contracts/api/agency/agency-campaign-series` (see CONTRACT-DIFF.md) |
| `src/types/agency-campaign.ts` | `apps/console/src/types/agency-campaign.ts` | modified | re-export of `@magick-agency/contracts/api/agency/agency-campaign` (see CONTRACT-DIFF.md) |
| `src/types/agency-spine.ts` | `apps/console/src/types/agency-spine.ts` | modified | re-export of `@magick-agency/contracts/api/agency/agency-spine` (see CONTRACT-DIFF.md) |
| `src/types/agency-stats.ts` | `apps/console/src/types/agency-stats.ts` | modified | re-export of `@magick-agency/contracts/api/agency/agency-stats` (see CONTRACT-DIFF.md) |
| `src/types/agency.ts` | `apps/console/src/types/agency.ts` | modified | re-export of `@magick-agency/contracts/api/agency/agency` (see CONTRACT-DIFF.md). Was a local override (the contract's file plus CONTRACT-DIFF §1's three fields) until the Phase 8 merge (`4be8de7`); the contract's `AgencyWrapupHold` (`'disposition_required' \| 'supervisor_hold'`), `AgencyDispositionResponse.callback_requested_at?: string \| null` and `AgencyStationIntervals.deferred_hangup_ms?: number` match the override exactly (`diff`: comments only), so no console code or fixture changed |
| `src/types/auth.ts` | `apps/console/src/types/auth.ts` | modified | re-export of `@magick-agency/contracts/api/platform/auth` |
| `src/types/call-analysis-profile.ts` | `apps/console/src/types/call-analysis-profile.ts` | modified | re-export of `@magick-agency/contracts/api/agency/call-analysis-profile` (see CONTRACT-DIFF.md) |
| `src/types/call.ts` | `apps/console/src/types/call.ts` | modified | cut to `CallAnalysisResult` (re-exported from the contract) + `ConversationEntry` (verbatim) |
| `src/types/dnc.ts` | `apps/console/src/types/dnc.ts` | modified | re-export of `@magick-agency/contracts/api/agency/dnc` (see CONTRACT-DIFF.md) |
| `src/types/feature-flags.ts` | `apps/console/src/types/feature-flags.ts` | modified | re-export of `@magick-agency/contracts/api/platform/feature-flags` |
| `src/types/invite.ts` | `apps/console/src/types/invite.ts` | modified | re-export of `@magick-agency/contracts/api/platform/invite` |
| `src/types/notifications.ts` | `apps/console/src/types/notifications.ts` | modified | re-export of `@magick-agency/contracts/api/platform/notifications` |
| `src/types/phone-number.ts` | `apps/console/src/types/phone-number.ts` | modified | cut to `TenantPhoneAssignment` without `is_byoc` |
| `src/types/team.ts` | `apps/console/src/types/team.ts` | modified | re-export of `@magick-agency/contracts/api/platform/team` |
| `src/types/webrtc-call.ts` | `apps/console/src/types/webrtc-call.ts` | modified | re-export of `@magick-agency/contracts/api/agency/webrtc-call` (see CONTRACT-DIFF.md) |
| `src/utils/agencyCampaignRecording.ts` | `apps/console/src/utils/agencyCampaignRecording.ts` | modified | `PROFILE_LIST_CAPABILITY` removed |
| `src/utils/agencyCampaignTabs.ts` | `apps/console/src/utils/agencyCampaignTabs.ts` | modified | comments only: permission names |
| `src/utils/agencyHealthStrip.ts` | `apps/console/src/utils/agencyHealthStrip.ts` | modified | `credits_low` removed from priority, labels and copy (plan §3.3) |
| `src/utils/format.ts` | `apps/console/src/utils/format.ts` | modified | three credit formatters removed |
| `src/utils/permissions.ts` | `apps/console/src/utils/permissions.ts` | modified | re-exports `@magick-agency/contracts/rbac` (the one matrix) + `getRoleLevel` / `PERMISSION_MIN_ROLE` over it; the hand mirror is gone |
| `src/utils/vocabulary.ts` | `apps/console/src/utils/vocabulary.ts` | modified | `TYPE_LABELS`, `SOURCE_LABELS`, `PIPELINE_VOICE_LABELS`, `pipelineVoiceLabel` removed |
| `src/components/agency/StateRail.tsx` | `apps/console/src/components/agency/StateRail.tsx` | modified | CONTRACT-DIFF §1: while a LIVE call reconnects and `deferred_hangup_ms` is known, the detail states the window as an upper bound ("held for up to 30 seconds"); never a countdown (cusui's own reason, kept); otherwise cusui's sentence |
| `src/components/agency/WrapupTimer.tsx` | `apps/console/src/components/agency/WrapupTimer.tsx` | modified | CONTRACT-DIFF §1: hold copy for `supervisor_hold` ("Held by your supervisor") |
| `src/utils/agencyWrapup.ts` | `apps/console/src/utils/agencyWrapup.ts` | modified | CONTRACT-DIFF §1: `heldReason` is the hold union; a `supervisor_hold` keeps holding after the disposition is submitted (it is not the agent's to end) |
| `src/utils/agencyDispositionSubmit.ts` | `apps/console/src/utils/agencyDispositionSubmit.ts` | modified | CONTRACT-DIFF §1: the saved outcome carries `callback_requested_at` when present; `confirmationCopy` names the dialled time and, when the request differs, adds ", the next time inside calling hours". The comparison is exact to the millisecond; a comment records that this relies on core echoing the same instant (`agency.routes.ts:1803`, `:959-960`). Behaviour unchanged |
| `src/pages/agency/useAgencyConsole.ts` | `apps/console/src/pages/agency/useAgencyConsole.ts` | modified | passes `callbackRequestedAt` to `confirmationCopy` |
| `src/pages/auth/VerifyEmailPage.tsx` | `apps/console/src/pages/auth/VerifyEmailPage.tsx` | modified | `session.is_new ? '/onboarding' : returnTo` → `returnTo`: agency has no onboarding or sign-up (path 4 of `/auth/session` refuses with `no_membership`), so the branch was dead and `/onboarding` is not routed |
| — | `apps/console/src/pages/AppHomeRedirect.tsx` | new | NEW: `/app` index (cusui’s was the AI dashboard) — Team / Notifications, or `DialerUnavailable` for a dedicated agent with the dialer off; never redirects into `/agency` (that would bounce the workspace exit) |
| — | `apps/console/src/utils/sessionRefusal.ts` | new | NEW: reads a 403 `no_membership` / `email_unverified` off a failed `POST /auth/session` (plan §3.1) |
| `src/api/credits.ts` | — | deleted | credits |
| `src/api/governance.ts` | — | deleted | governance → settings map |
| `src/api/super-admin.ts` | — | deleted | super-admin is its own app |
| `src/components/common/AdvancedSection.module.css` | — | deleted | not used by any ported page |
| `src/components/common/AdvancedSection.tsx` | — | deleted | not used by any ported page |
| `src/components/common/BatchConfirmModal.module.css` | — | deleted | not used by any ported page |
| `src/components/common/BatchConfirmModal.tsx` | — | deleted | not used by any ported page |
| `src/components/common/DeprecationNotice.module.css` | — | deleted | not used by any ported page |
| `src/components/common/DeprecationNotice.tsx` | — | deleted | not used by any ported page |
| `src/components/common/DirectionBadge.module.css` | — | deleted | not used by any ported page |
| `src/components/common/DirectionBadge.tsx` | — | deleted | not used by any ported page |
| `src/components/common/ExportColumnsModal.module.css` | — | deleted | not used by any ported page |
| `src/components/common/ExportColumnsModal.tsx` | — | deleted | not used by any ported page |
| `src/components/common/PersonalizeField.module.css` | — | deleted | not used by any ported page |
| `src/components/common/PersonalizeField.tsx` | — | deleted | not used by any ported page |
| `src/components/common/ProviderIcon.module.css` | — | deleted | not used by any ported page |
| `src/components/common/ProviderIcon.tsx` | — | deleted | not used by any ported page |
| `src/components/common/ProviderSegmentedControl.module.css` | — | deleted | not used by any ported page |
| `src/components/common/ProviderSegmentedControl.tsx` | — | deleted | not used by any ported page |
| `src/components/common/StatCard.module.css` | — | deleted | not used by any ported page |
| `src/components/common/StatCard.tsx` | — | deleted | not used by any ported page |
| `src/components/common/WorkspacePanel.module.css` | — | deleted | not used by any ported page |
| `src/components/common/WorkspacePanel.tsx` | — | deleted | not used by any ported page |
| `src/components/layout/CreditBadge.module.css` | — | deleted | credits |
| `src/components/layout/CreditBadge.tsx` | — | deleted | credits |
| `src/hooks/useCountUp.ts` | — | deleted | only consumer (StatCard) not ported |
| `src/hooks/useCredits.ts` | — | deleted | credits |
| `src/types/bulk-dispatch-job.ts` | — | deleted | AI broadcasts |
| `src/types/credit.ts` | — | deleted | credits |
| `src/types/escalation.ts` | — | deleted | AI transfer |
| `src/types/governance.ts` | — | deleted | governance → settings map |
| `src/types/prompt-tool.ts` | — | deleted | AI |
| `src/types/prompt.ts` | — | deleted | AI |
| `src/types/recurring-schedule.ts` | — | deleted | AI |
| `src/types/schedule.ts` | — | deleted | AI |
| `src/types/super-admin.ts` | — | deleted | super-admin app |
| `src/utils/broadcastPanel.ts` | — | deleted | AI broadcasts |
| `src/utils/concurrencyLimitsCache.ts` | — | deleted | AI broadcast composer cache |
| `src/utils/exportColumns.ts` | — | deleted | only consumer not ported |
| `src/utils/variables.ts` | — | deleted | only consumer not ported |

### 9.3 Tests (source cases → ported cases, per file, as Vitest prints them; `it.each` rows counted)

Source counts are Vitest's own, from running each verbatim copy (`01c12de`, `cf54fa8^`) in this package before
it was touched. `dialerEntryRoutes` failed at collection there (a describe-level assertion on the `/app` block),
so its 15 is the count of its `it(` calls. Ported counts come from `cd apps/console && pnpm test` at the head of
this branch.

| Source test (cusui `ee5beb44`) | Source | Ported | Kind / reason |
|---|---|---|---|
| `src/__tests__/AuthContext.session.test.tsx` | 8 | 8 | modified (fixture): `governance` → `settings` |
| `src/__tests__/agencyBucketDates.timezone.test.tsx` | 8 | 8 | verbatim |
| `src/__tests__/analysisProfileForm.test.ts` | 15 | 15 | verbatim |
| `src/__tests__/analytics/autocaptureOptOut.test.ts` | 4 | 4 | verbatim |
| `src/__tests__/analytics/dashboardEvents.test.ts` | 11 | 0 | deleted: AI dashboard trackers removed |
| `src/__tests__/analytics/events.test.ts` | 16 | 5 | modified: 11 AI-tracker cases deleted; 4 re-pointed onto the kept emitters and agency gate ids |
| `src/__tests__/analytics/followupEvents.test.ts` | 7 | 0 | deleted: follow-up trackers removed |
| `src/__tests__/analytics/posthog.test.ts` | 22 | 22 | verbatim |
| `src/__tests__/analytics/productSurface.test.tsx` | 12 | 12 | verbatim |
| `src/__tests__/analytics/redact.test.ts` | 8 | 8 | verbatim |
| `src/__tests__/analytics/webrtcEvents.test.ts` | 9 | 0 | deleted: softphone trackers removed |
| `src/__tests__/api/agency-account-header.test.ts` | 30 | 30 | verbatim |
| `src/__tests__/api/agency-notes.test.ts` | 17 | 17 | verbatim |
| `src/__tests__/api/agencyActivity.test.ts` | 8 | 8 | verbatim |
| `src/__tests__/api/agencyCampaignRetry.test.ts` | 8 | 8 | verbatim |
| `src/__tests__/api/agencyCampaignSeries.test.ts` | 6 | 6 | verbatim |
| `src/__tests__/api/agencyMyAssignments.test.ts` | 6 | 6 | verbatim |
| `src/__tests__/api/agencySpine.test.ts` | 11 | 11 | verbatim |
| `src/__tests__/api/agencyStats.test.ts` | 38 | 38 | verbatim |
| `src/__tests__/api/call-analysis-profiles.api.test.ts` | 5 | 5 | verbatim |
| `src/__tests__/api/error-analytics.test.ts` | 8 | 5 | modified: `raw fetch integrations` (3) deleted with their modules |
| `src/__tests__/api/exportCsv.test.ts` | 9 | 3 | modified: `filenameFromContentDisposition` (3) and `downloadExportCsv` (3) deleted with the AI downloader |
| `src/__tests__/api/invites.test.ts` | 15 | 15 | verbatim |
| `src/__tests__/api/originator-header.test.ts` | 11 | 4 | modified: super-admin (2), contact-list (2), audio (1), CSV export (2) deleted with their modules |
| `src/__tests__/api/tenants.test.ts` | 6 | 6 | verbatim |
| `src/__tests__/client.test.ts` | 26 | 26 | verbatim |
| `src/__tests__/components/AccountSwitcher.test.tsx` | 7 | 7 | verbatim |
| `src/__tests__/components/AdvancedSection.test.tsx` | 7 | 0 | deleted: component not used by any ported page |
| `src/__tests__/components/AgencyRetryDialog.test.tsx` | 31 | 31 | verbatim |
| `src/__tests__/components/AgencySidebar.test.tsx` | 11 | 11 | modified (comments only): permission names |
| `src/__tests__/components/AgencyWorkspaceSwitch.test.tsx` | 13 | 13 | modified (comments only): permission names |
| `src/__tests__/components/AgentAnalyticsSection.test.tsx` | 89 | 89 | verbatim |
| `src/__tests__/components/AgentBucketChart.test.tsx` | 15 | 15 | verbatim |
| `src/__tests__/components/AgentFloor.test.tsx` | 40 | 40 | verbatim |
| `src/__tests__/components/AgentLanding.test.tsx` | 15 | 15 | verbatim |
| `src/__tests__/components/AgentPerformancePanel.test.tsx` | 14 | 14 | verbatim |
| `src/__tests__/components/AppLayout.mobileDrawer.test.tsx` | 8 | 8 | modified (mock only): `CreditBadge` stub removed |
| `src/__tests__/components/AudioWaveform.test.tsx` | 9 | 9 | verbatim |
| `src/__tests__/components/BestHours.test.tsx` | 22 | 22 | verbatim |
| `src/__tests__/components/BestHoursMatrix.test.tsx` | 17 | 17 | verbatim |
| `src/__tests__/components/BreakMenu.test.tsx` | 26 | 26 | verbatim |
| `src/__tests__/components/CallDetailSections.analysis.test.tsx` | 13 | 13 | verbatim |
| `src/__tests__/components/CallDetailView.test.tsx` | 21 | 21 | verbatim |
| `src/__tests__/components/CallerIdPicker.test.tsx` | 2 | 2 | verbatim |
| `src/__tests__/components/CampaignBehaviourSection.test.tsx` | 4 | 4 | verbatim |
| `src/__tests__/components/CampaignContribution.test.tsx` | 42 | 42 | verbatim |
| `src/__tests__/components/CampaignHealthStrip.test.tsx` | 14 | 14 | verbatim |
| `src/__tests__/components/CampaignPerformance.test.tsx` | 19 | 19 | verbatim |
| `src/__tests__/components/CampaignSeriesSection.test.tsx` | 25 | 25 | verbatim |
| `src/__tests__/components/CommonConfirmDialog.test.tsx` | 12 | 12 | verbatim |
| `src/__tests__/components/CompareTray.test.tsx` | 21 | 21 | verbatim |
| `src/__tests__/components/ComposerSection.test.tsx` | 6 | 6 | verbatim |
| `src/__tests__/components/ContributionTable.test.tsx` | 18 | 18 | verbatim |
| `src/__tests__/components/DataTable.test.tsx` | 27 | 27 | verbatim |
| `src/__tests__/components/DeprecationNotice.test.tsx` | 4 | 0 | deleted: component not used by any ported page |
| `src/__tests__/components/DialerUnavailable.test.tsx` | 3 | 3 | verbatim |
| `src/__tests__/components/DispositionPad.test.tsx` | 28 | 28 | verbatim |
| `src/__tests__/components/DncControl.test.tsx` | 7 | 7 | verbatim |
| `src/__tests__/components/ErrorAlert.test.tsx` | 4 | 4 | verbatim |
| `src/__tests__/components/ErrorText.test.tsx` | 4 | 4 | verbatim |
| `src/__tests__/components/GlobalSearchDnc.test.tsx` | 4 | 4 | verbatim |
| `src/__tests__/components/GovernanceGating.test.tsx` | 6 | 6 | modified: RequireCapability cases drive `agency.recording` (was `messaging`); the 2 Sidebar MESSAGING cases now drive Call Summaries on `agency.analytics` |
| `src/__tests__/components/GovernancePhase4Nav.test.tsx` | 5 | 0 | deleted: Sidebar IVR / broadcasts / scheduling / softphone sections are not ported |
| `src/__tests__/components/HoldToConfirmButton.test.tsx` | 38 | 38 | verbatim |
| `src/__tests__/components/HomeRedirect.test.tsx` | 18 | 8 | modified: 7 `isAgencyOnlyTenant` cases deleted with the predicate; "AI-only tenant" and "governance read failed" deleted; "both-products tenant" now pins the flag-only predicate |
| `src/__tests__/components/LiveDot.test.tsx` | 7 | 7 | verbatim |
| `src/__tests__/components/NotesField.test.tsx` | 22 | 22 | verbatim |
| `src/__tests__/components/PageDescription.test.tsx` | 8 | 8 (→ 2 after B17, §9.6) | modified: `DOCS_SLUGS` is `team` only, so the `calls` slug/page key → `team`, and the slug-differs case maps `members` → `team` (was `announcements` → `voice-messages`); the allow-list's format check still runs over the remaining entry |
| `src/__tests__/components/Pagination.test.tsx` | 28 | 28 | verbatim |
| `src/__tests__/components/PersonalizeField.test.tsx` | 9 | 0 | deleted: component not used by any ported page |
| `src/__tests__/components/PhoneFilterInput.test.tsx` | 8 | 8 | verbatim |
| `src/__tests__/components/QueuedBreakPill.test.tsx` | 14 | 14 | verbatim |
| `src/__tests__/components/RailPresenceRegion.test.tsx` | 18 | 18 | verbatim |
| `src/__tests__/components/RequireAuth.returnPath.test.tsx` | 6 | 6 | verbatim |
| `src/__tests__/components/RequireFlag.test.tsx` | 11 | 11 | modified: default flag `agency_call_analysis` (was `custom_sip`) |
| `src/__tests__/components/RosterTable.test.tsx` | 49 | 49 | verbatim |
| `src/__tests__/components/StatCard.test.tsx` | 15 | 0 | deleted: component not used by any ported page |
| `src/__tests__/components/StateRail.test.tsx` | 23 | 25 | verbatim + NEW (2): the window as a bound; cusui's sentence without it |
| `src/__tests__/components/StationIdentity.test.tsx` | 2 | 2 | verbatim |
| `src/__tests__/components/StatusBadge.test.tsx` | 15 | 15 | verbatim |
| `src/__tests__/components/SwitcherDropdown.test.tsx` | 8 | 8 | verbatim |
| `src/__tests__/components/TenantSwitcher.test.tsx` | 7 | 7 | verbatim |
| `src/__tests__/components/Toast.test.tsx` | 2 | 2 | verbatim |
| `src/__tests__/components/TopBar.test.tsx` | 8 | 8 | modified: `CreditBadge` stub removed; the "rest of the menu" assertion reads `Sign Out` (the `Settings` item is gone) |
| `src/__tests__/components/WebRtcNavGating.test.tsx` | 16 | 0 | deleted: Softphone / Call History nav and GlobalSearch entries are not ported |
| `src/__tests__/components/WorkspacePanel.test.tsx` | 3 | 0 | deleted: component not used by any ported page |
| `src/__tests__/components/WrapupTimer.test.tsx` | 20 | 23 | verbatim + NEW (3): `supervisor_hold` copy, kept after the disposition (both `ends_at: null`, so they pin the `HOLD_COPY` entry), and the reason kept beside a running countdown after the disposition (non-null `ends_at`, so it guards `holding`) |
| `src/__tests__/components/campaignSeriesCharts.test.tsx` | 16 | 16 | verbatim |
| `src/__tests__/components/dataTableAlignCss.test.ts` | 5 | 5 | verbatim |
| `src/__tests__/components/switcherDropdownScrollCss.test.ts` | 4 | 4 | verbatim |
| `src/__tests__/contexts/AuthContext.lazyInit.test.tsx` | 2 | 2 | verbatim |
| `src/__tests__/contexts/AuthContext.test.tsx` | 42 | 45 | modified: fixtures carry `settings`; deleted `signUpEmail` (2) and concurrency-limits cache (2); pending-phone / logout / completeEmailVerification adjusted; NEW (7): `sessionRefusal` on listener, signInEmail, signInGoogle, non-refusal 403, cleared by a later session; settings adopted and refreshed |
| `src/__tests__/contexts/FeatureFlagsContext.test.tsx` | 14 | 14 | verbatim |
| `src/__tests__/contexts/GovernanceContext.test.tsx` | 4 | 6 | modified: 4 cases re-pointed from `GET /governance/effective` to the session settings map; NEW: `agency` always on; `loading` is the session’s |
| `src/__tests__/contexts/TenantContext.test.tsx` | 32 | 32 | verbatim |
| `src/__tests__/exportColumns.escalation.test.ts` | 3 | 0 | deleted: only consumer (`ExportColumnsModal`) not ported |
| `src/__tests__/hiddenPanelCss.test.ts` | 3 | 0 | deleted: all three call sites (WorkspacePanel, both AutoPilot builders) are not ported, so the scan is vacuous |
| `src/__tests__/hooks/agencyStationWsUrl.test.ts` | 7 | 7 | verbatim |
| `src/__tests__/hooks/agentSurfacesStrictMode.test.tsx` | 9 | 9 | verbatim |
| `src/__tests__/hooks/useAgencyStation.media.test.ts` | 10 | 10 | verbatim |
| `src/__tests__/hooks/useAgencyStation.test.ts` | 75 | 75 | verbatim |
| `src/__tests__/hooks/useAudioCapture.test.ts` | 18 | 18 | verbatim |
| `src/__tests__/hooks/useCallAnalysisProfiles.test.tsx` | 9 | 9 | verbatim |
| `src/__tests__/hooks/useCampaignSeries.test.tsx` | 16 | 16 | verbatim |
| `src/__tests__/hooks/useCountUp.test.ts` | 10 | 0 | deleted: only consumer (`StatCard`) not ported |
| `src/__tests__/hooks/useMediaQuery.test.ts` | 3 | 3 | verbatim |
| `src/__tests__/hooks/useServerClock.test.ts` | 15 | 15 | verbatim |
| `src/__tests__/pages/AgencyAnalyticsPage.test.tsx` | 21 | 21 | modified (comments only): permission names |
| `src/__tests__/pages/AgencyAttemptCallPage.test.tsx` | 19 | 19 | verbatim |
| `src/__tests__/pages/AgencyCampaignActivityPage.test.tsx` | 43 | 43 | verbatim |
| `src/__tests__/pages/AgencyCampaignAttemptsPage.test.tsx` | 23 | 23 | verbatim |
| `src/__tests__/pages/AgencyCampaignContactsPage.test.tsx` | 6 | 6 | verbatim |
| `src/__tests__/pages/AgencyCampaignDetailPage.test.tsx` | 94 | 94 | verbatim |
| `src/__tests__/pages/AgencyCampaignRosterPage.test.tsx` | 22 | 22 | verbatim |
| `src/__tests__/pages/AgencyCampaignSettingsPage.test.tsx` | 36 | 36 | modified: "names `calls.dialer.analytics`…" became "lists the profiles whenever `agency.analytics` is on" |
| `src/__tests__/pages/AgencyContactDetailPage.test.tsx` | 25 | 25 | verbatim |
| `src/__tests__/pages/AgencyHomeRedirect.test.tsx` | 7 | 7 | modified (comments only): permission names |
| `src/__tests__/pages/AgencyJoinPage.test.tsx` | 48 | 48 | verbatim |
| `src/__tests__/pages/AgencyLoginPage.test.tsx` | 38 | 38 | modified: the diagnosis is driven by a 403 `no_membership` (was `is_new: true`, 7 sites); Google reads Firebase’s current user; 2 cross-link cases deleted; NEW: listener refusal on reload, a different 403 is not the diagnosis |
| `src/__tests__/pages/AgentAttemptsPage.test.tsx` | 46 | 46 | verbatim |
| `src/__tests__/pages/AgentConsolePage.audio.test.tsx` | 47 | 47 | verbatim |
| `src/__tests__/pages/AgentConsolePage.callbackDnc.test.tsx` | 30 | 31 | verbatim + NEW: a callback moved into calling hours says so, on the page |
| `src/__tests__/pages/AgentConsolePage.cueVisual.test.tsx` | 22 | 22 | verbatim |
| `src/__tests__/pages/AgentConsolePage.retry.test.tsx` | 14 | 14 | verbatim |
| `src/__tests__/pages/AgentConsolePage.stationExit.test.tsx` | 43 | 43 | verbatim |
| `src/__tests__/pages/AgentConsolePage.test.tsx` | 41 | 42 | verbatim + NEW: the reconnect window reaches the rail |
| `src/__tests__/pages/AgentHomePage.test.tsx` | 26 | 26 | verbatim |
| `src/__tests__/pages/AgentPerformancePage.test.tsx` | 51 | 51 | verbatim |
| `src/__tests__/pages/AnalysisProfilesPage.test.tsx` | 9 | 9 | verbatim |
| `src/__tests__/pages/CampaignBuilderPage.config.test.tsx` | 33 | 33 | verbatim |
| `src/__tests__/pages/CampaignBuilderPage.flow.test.tsx` | 9 | 9 | verbatim |
| `src/__tests__/pages/CampaignBuilderPage.test.tsx` | 19 | 19 | verbatim |
| `src/__tests__/pages/DncPage.test.tsx` | 20 | 20 | verbatim |
| `src/__tests__/pages/NotificationSettingsPage.test.tsx` | 39 | 22 | modified: 17 digest-preview cases deleted (credits usage digest not ported) |
| `src/__tests__/pages/RecordingSection.test.tsx` | 9 | 9 | verbatim |
| `src/__tests__/pages/TeamPage.a11y.test.tsx` | 1 | 1 | verbatim |
| `src/__tests__/pages/TeamPage.actionsMenu.test.tsx` | 8 | 8 | verbatim |
| `src/__tests__/pages/TeamPage.analytics.test.tsx` | 2 | 2 | verbatim |
| `src/__tests__/pages/TeamPage.inviteHandoff.test.tsx` | 28 | 28 | verbatim |
| `src/__tests__/pages/TeamPage.resendInvite.test.tsx` | 10 | 10 | verbatim |
| `src/__tests__/pages/TranscriptSection.test.tsx` | 7 | 7 | verbatim |
| `src/__tests__/pages/VerifyEmailPage.returnPath.test.tsx` | 6 | 6 | modified: "sends a genuinely new user to onboarding regardless" became "sends a new session to the carried destination too — there is no onboarding" (an `is_new: true` session goes to `returnTo`, never `/onboarding`) |
| `src/__tests__/pages/agencyRoutes.test.tsx` | 5 | 5 | verbatim |
| `src/__tests__/pages/dialerEntryRoutes.test.tsx` | 15 | 15 | modified: the `/app` block ends at the catch-all (no super-admin section in the console) |
| `src/__tests__/pages/useAgencyConsole.cues.test.ts` | 12 | 12 | verbatim |
| `src/__tests__/pages/useAgencyConsole.test.ts` | 10 | 10 | verbatim |
| `src/__tests__/pages/useAgencyConsole.wrapup.test.ts` | 16 | 16 | verbatim |
| `src/__tests__/registration/agency-login-registration.test.ts` | 13 | 13 | verbatim |
| `src/__tests__/registration/analysis-profiles-registration.test.tsx` | 3 | 3 | modified: pins agency’s gates (`agency.analytics`, `agency_call_analysis`) |
| `src/__tests__/session.test.ts` | 9 | 9 | verbatim |
| `src/__tests__/snake-case.test.ts` | 19 | 19 | verbatim |
| `src/__tests__/themeTokenParity.test.ts` | 4 | 4 | verbatim |
| `src/__tests__/utils/agencyActionErrorCodes.test.ts` | 5 | 5 | modified: the 2 sibling-fixture cases (skipped in cusui standalone) read `@magick-agency/contracts/errors` and RUN |
| `src/__tests__/utils/agencyActivityCopy.test.ts` | 24 | 24 | verbatim |
| `src/__tests__/utils/agencyAgentFloor.test.ts` | 64 | 64 | verbatim |
| `src/__tests__/utils/agencyAgentPerformance.test.ts` | 70 | 70 | verbatim |
| `src/__tests__/utils/agencyAgentRoster.test.ts` | 81 | 81 | verbatim |
| `src/__tests__/utils/agencyAgentSurfaces.test.ts` | 7 | 7 | verbatim |
| `src/__tests__/utils/agencyAssignmentEntry.test.ts` | 19 | 19 | verbatim |
| `src/__tests__/utils/agencyAttemptFilters.test.ts` | 30 | 30 | verbatim |
| `src/__tests__/utils/agencyAttemptRange.timezone.test.ts` | 6 | 6 | verbatim |
| `src/__tests__/utils/agencyBestHours.test.ts` | 45 | 45 | verbatim |
| `src/__tests__/utils/agencyCampaignConfigForm.test.ts` | 69 | 69 | verbatim |
| `src/__tests__/utils/agencyCampaignContribution.test.ts` | 54 | 54 | verbatim |
| `src/__tests__/utils/agencyCampaignControls.test.ts` | 10 | 10 | verbatim |
| `src/__tests__/utils/agencyCampaignLineage.test.ts` | 11 | 11 | verbatim |
| `src/__tests__/utils/agencyCampaignOverview.test.ts` | 94 | 94 | verbatim |
| `src/__tests__/utils/agencyCampaignPerformance.test.ts` | 65 | 65 | verbatim |
| `src/__tests__/utils/agencyCampaignRecording.test.ts` | 35 | 34 | modified: the `PROFILE_LIST_CAPABILITY` case deleted with the constant |
| `src/__tests__/utils/agencyCampaignSeries.test.ts` | 91 | 91 | verbatim |
| `src/__tests__/utils/agencyCampaignSeriesRange.timezone.test.ts` | 6 | 6 | verbatim |
| `src/__tests__/utils/agencyCampaignTabs.test.ts` | 17 | 17 | verbatim |
| `src/__tests__/utils/agencyCatalogSync.test.ts` | 30 | 30 | verbatim |
| `src/__tests__/utils/agencyClock.test.ts` | 20 | 20 | verbatim |
| `src/__tests__/utils/agencyColumnMapping.test.ts` | 28 | 28 | verbatim |
| `src/__tests__/utils/agencyCompareTray.test.ts` | 23 | 23 | verbatim |
| `src/__tests__/utils/agencyContext.test.ts` | 15 | 15 | verbatim |
| `src/__tests__/utils/agencyCuePrefs.test.ts` | 6 | 6 | verbatim |
| `src/__tests__/utils/agencyCues.test.ts` | 20 | 20 | verbatim |
| `src/__tests__/utils/agencyDispositionForm.test.ts` | 26 | 26 | verbatim |
| `src/__tests__/utils/agencyDispositionSubmit.test.ts` | 30 | 34 | verbatim + NEW (4): `callback_requested_at` carried, named, ignored when equal or unparseable |
| `src/__tests__/utils/agencyDncCopy.test.ts` | 20 | 20 | verbatim |
| `src/__tests__/utils/agencyFieldFilter.test.ts` | 12 | 12 | verbatim |
| `src/__tests__/utils/agencyHealthStrip.test.ts` | 46 | 46 | modified: `credits_low` out of the priority / sort / no-mutate / evidence fixtures; "credits_low renders" became the DELETION test "credits_low is GONE" |
| `src/__tests__/utils/agencyIngestSummary.test.ts` | 27 | 27 | verbatim |
| `src/__tests__/utils/agencyJoinConflict.test.ts` | 24 | 24 | verbatim |
| `src/__tests__/utils/agencyLiveSession.test.ts` | 19 | 19 | verbatim |
| `src/__tests__/utils/agencyMedia.test.ts` | 18 | 18 | verbatim |
| `src/__tests__/utils/agencyNotes.test.ts` | 43 | 43 | verbatim |
| `src/__tests__/utils/agencyPermissionMirror.test.ts` | 13 | 13 | modified: `proxy.feature_flags.read` → `agency.flags.read`; `proxy.stats.read` → `agency.campaigns.read`; sorted list order |
| `src/__tests__/utils/agencyPersona.test.ts` | 23 | 23 | modified: viewer-floor pin reads `tenant.read` (was `proxy.calls.read`) |
| `src/__tests__/utils/agencyPriorAttempts.test.ts` | 13 | 13 | verbatim |
| `src/__tests__/utils/agencyReleaseCopy.test.ts` | 46 | 46 | verbatim |
| `src/__tests__/utils/agencyRetrySelector.test.ts` | 48 | 48 | verbatim |
| `src/__tests__/utils/agencyRosterFilters.test.ts` | 11 | 11 | verbatim |
| `src/__tests__/utils/agencyShellBoundary.test.ts` | 2 | 2 | verbatim |
| `src/__tests__/utils/agencySpineCopy.test.ts` | 9 | 9 | verbatim |
| `src/__tests__/utils/agencyStaleResponse.test.ts` | 18 | 18 | verbatim |
| `src/__tests__/utils/agencyStationExit.test.ts` | 19 | 19 | verbatim |
| `src/__tests__/utils/agencyStationIdle.test.ts` | 5 | 5 | verbatim |
| `src/__tests__/utils/agencyStatsConsumers.test.ts` | 37 | 37 | verbatim |
| `src/__tests__/utils/agencyWrapup.test.ts` | 30 | 33 | verbatim + NEW (3): `supervisor_hold` holds with or without a countdown, before and after the disposition |
| `src/__tests__/utils/agentPermissions.test.ts` | 53 | 22 | modified: the pre-dialer list is the contract’s 11 permissions, `proxy.phone_numbers.read` kept as `agency.phone_numbers.read` (31 `it.each` rows deleted with their permissions, `proxy.phone_numbers.manage` among them); stats-lane case reads `agency.campaigns.read` |
| `src/__tests__/utils/audio-worklet-processor.test.ts` | 10 | 10 | verbatim |
| `src/__tests__/utils/broadcastPanel.test.ts` | 11 | 0 | deleted: module unreachable once the broadcast tracker went |
| `src/__tests__/utils/build-splitting.test.ts` | 2 | 2 | verbatim |
| `src/__tests__/utils/builderFlow.test.ts` | 5 | 5 | verbatim |
| `src/__tests__/utils/concurrency.test.ts` | 9 | 9 | verbatim |
| `src/__tests__/utils/errors.test.ts` | 21 | 21 | verbatim |
| `src/__tests__/utils/exportColumns.test.ts` | 14 | 0 | deleted: only consumer (`ExportColumnsModal`) not ported |
| `src/__tests__/utils/format.test.ts` | 91 | 70 | modified: 21 credit-formatter cases deleted |
| `src/__tests__/utils/inviteJoin.test.ts` | 8 | 8 | verbatim |
| `src/__tests__/utils/permissions.test.ts` | 95 | 41 | modified: lists cut to the contract’s permissions under agency names; per-permission rows and 11 boundary cases for removed permissions deleted |
| `src/__tests__/utils/phone.test.ts` | 7 | 7 | verbatim |
| `src/__tests__/utils/poll-backoff.test.ts` | 13 | 13 | verbatim |
| `src/__tests__/utils/returnPath.test.ts` | 75 | 75 | verbatim |
| `src/__tests__/utils/sipPermissions.test.ts` | 2 | 0 | deleted: SIP not ported |
| `src/__tests__/utils/switcherFocus.test.ts` | 4 | 4 | verbatim |
| `src/__tests__/utils/switcherSearch.test.ts` | 6 | 6 | verbatim |
| `src/__tests__/utils/telephonyProviders.test.ts` | 10 | 10 | verbatim |
| `src/__tests__/utils/variables.test.ts` | 14 | 0 | deleted: only consumer (`PersonalizeField`) not ported |
| `src/__tests__/utils/vocabulary.analysis.test.ts` | 15 | 15 | verbatim |
| `src/__tests__/utils/vocabulary.test.ts` | 18 | 16 | modified: `TYPE_LABELS` / `SOURCE_LABELS` cases deleted with the maps |
| `src/brand/index.test.ts` | 14 | 14 | verbatim |
| `src/brand/load-brand.test.ts` | 26 | 26 (→ 24 after B17, §9.6) | verbatim (modified by B17) |
| `src/components/common/DateRangeFilter.test.tsx` | 25 | 25 | verbatim |
| `src/components/common/DateRangeFilter.timezone.test.tsx` | 1 | 1 | verbatim |
| `src/components/common/Logo.test.tsx` | 3 | 3 | verbatim (modified by B17, §9.6) |
| — (NEW) `src/__tests__/pages/AppHomeRedirect.test.tsx` | 0 | 6 | NEW: Team / Notifications landing, never `/agency`, the dedicated-agent notice, both waits |
| — (NEW) `src/__tests__/utils/sessionRefusal.test.ts` | 0 | 5 | NEW: the 403 classifier |
| — (NEW) `src/__tests__/components/RequireCapability.settings.test.tsx` | 0 | 4 | NEW: the real `GovernanceProvider` under `RequireCapability` — recording / analysis off on the active account refuses; a sibling's does not leak; `agency` never refused |
| — (NEW) `src/__tests__/components/Sidebar.activeState.test.tsx` | 0 | 2 | NEW: after the `/app/calls` special cases went, only the current item is active and a nested path keeps its item active |
| **Total (228 source files + 4 new)** | **4633** | **4363** | |

Net: 4633 source cases in these files → 4321 kept (312 deleted with their subjects), plus 42 new (`AuthContext` 7,
`GovernanceContext` 2, `AgencyLoginPage` 2, `AppHomeRedirect` 6, `sessionRefusal` 5, `RequireCapability.settings` 4,
`Sidebar.activeState` 2, and 14 for the CONTRACT-DIFF fields) = 4363, in 215 files, equal to the per-file counts of
`npx vitest run --reporter=json` at the head of this branch. cusui's 2 skipped cases (`agencyActionErrorCodes`, a
sibling-fixture `skipIf`) now run.

### 9.4 Invariants touched, mutation-checked (break → red → restore)

| Invariant | Mutation | Result |
|---|---|---|
| `agency` gate always on (plan §3.2) | `capabilityMapFromSettings` returns `agency: false` | `GovernanceContext` 1 red |
| recording/analysis read from the right setting | `agency.recording` ← `analyze_calls` | `GovernanceContext` 2 red |
| recording gated per field on campaign settings | `recordingEnabled = true` | `AgencyCampaignSettingsPage` 3 red |
| path 4 refused, shown as "not recognised" (plan §3.1) | listener drops `sessionRefusal` | `AuthContext` 3 red |
| only `no_membership` is the diagnosis | `sessionRefusalCode` returns `no_membership` for any error | `AuthContext` + `AgencyLoginPage` 2 red |
| the refusal survives a reload | `refusedOnSync = false` | `AgencyLoginPage` 1 red |
| `credits_low` gone (plan §3.3) | re-add to `AGENCY_STALL_PRIORITY` | `agencyHealthStrip` 3 red |
| single-abandon sample floor and its console copy (plan §9) | `abandoned <= 1` → `<= 0` | `agencyHealthStrip` 2 red |
| panel on screen at `reserved`, no await in between (plan §9) | `setLive` deferred with `setTimeout` | `useAgencyStation` 11 red |
| agency-only landing = the dialer flag | also require cusui's governance map | `HomeRedirect` 3 red |
| `/app` index never bounces into `/agency` | `AppHomeRedirect` navigates to `/agency` | `AppHomeRedirect` 3 red |
| `/app` index waits for the role | the `accountResolution === 'loading'` wait removed | `AppHomeRedirect` 1 red |
| `RequireCapability` reads the ACTIVE account's settings | map built from no row / from a sibling row / without `analyze_calls` | `RequireCapability.settings` 2 / 2 / 1 red |
| analysis gated per field on campaign settings | `analyticsEnabled = true` | `AgencyCampaignSettingsPage` 3 red |
| `agent` below `viewer` (plan §9) | contract `ROLE_HIERARCHY.agent` 5 → 10 (temporary, restored) | `agentPermissions` / mirror / persona / `AgentLanding` 15 red |
| a dedicated agent is exactly sub-viewer | `PLATFORM_NAVIGATION_FLOOR` `viewer` → `operator` | `agencyPersona` / `AgentLanding` / `AppHomeRedirect` 2 red |
| `supervisor_hold` survives the disposition | `supervisorHeld` returns false | `agencyWrapup` 2 red, `WrapupTimer` 1 red (the non-null `ends_at` case; the two `ends_at: null` cases pin only the `HOLD_COPY` entry) |
| `callback_requested_at` reaches the page | the `useAgencyConsole` pass-through removed | `AgentConsolePage.callbackDnc` 1 red |
| `deferred_hangup_ms` reaches the rail | the `AgentConsolePage` prop removed | `AgentConsolePage` 1 red |
| no onboarding: a new session goes to `returnTo` | cusui's `session.is_new ? '/onboarding' : returnTo` restored | `VerifyEmailPage.returnPath` 1 red |
| Sidebar active state without the `/app/calls` cases | every item `end` / `isActive` ignored | `Sidebar.activeState` 1 / 2 red |
| `agency.phone_numbers.read` is not an agent permission | contract floor `viewer` → `agent` (temporary, restored) | `agentPermissions` 2 red |

The agent-reach invariant (`agent` at 5 reaches only the agent surfaces) lives in the contract's matrix. The
console pins it through `agentPermissions`, `agencyPermissionMirror` and `agencyPersona`, all green against the
contract.

### 9.5 Not ported here, and open points

- **CONTRACT-DIFF fields** (`supervisor_hold`, `callback_requested_at`, `deferred_hangup_ms`): rendered against the
  contract since the Phase 8 merge (`4be8de7`); `src/types/agency.ts` is a re-export again. Same types and
  optionality as the override, so `deferred_hangup_ms` stays optional and the `BOOTSTRAP` fixtures are unchanged.
  Checked against the merged server: the station URL reaches the console as `/proxy/agency/station/<id>?token=…`
  (core's `/api/v1/agency/station` is rewritten in `proxy-agency-agent.routes.ts` before it leaves the server;
  `toAbsoluteWsUrl` resolves that path against `API_BASE`, and the console builds no station path of its own);
  `TenantPhoneAssignment` has no `is_byoc` and nothing reads it; masked 5xx bodies carry `requestId`, which
  `extractRequestId` reads without assuming a format. The builder has no recording/analysis step (cusui: "only the
  settings page exposes those fields"), so the per-field checks are the settings page's.
- **`knowledgeGrounding.ts`** is not ported (only cusui's AI `PromptEditorPage` uses it). The lead deleted lane
  D's 4 `dimension-presets` byte-identity cases that waited on it (`4cb3e51`).
- **Copy that named MagickVoice:** resolved by decision B17 (§9.6).
- **cusui tests not ported.** Their modules are not in the console. Counts are the source's `it(` calls, with an
  `it.each` counted once:

#### AI dashboard — 15 files
ActivityFeed.test.tsx (4), DashboardPage.test.tsx (19), LivePulseStrip.test.tsx (23), QuickActions.test.tsx (1), components/ActivityFeed.test.tsx (20), components/ActivityTrendChart.test.tsx (8), components/ChannelCards.test.tsx (32), components/DashboardHero.test.tsx (42), components/GettingStartedChecklist.test.tsx (16), components/Sparkline.test.tsx (3), hooks/useActivityTimeline.test.ts (7), hooks/useChannelTrends.test.ts (3), hooks/useRecentActivity.test.ts (8), pages/density.test.ts (6), utils/activityBuckets.test.ts (12)

#### broadcasts, schedules, contact lists — 53 files
AiCampaignIntroClip.test.tsx (10), AiCampaignTurnGrace.test.tsx (8), AnnouncementsPage.test.tsx (7), AudioFilesPage.test.tsx (2), StaticCallsPage.test.tsx (9), StaticCampaignRegistry.test.tsx (17), UpcomingSchedules.test.tsx (4), api/bulk-dispatch-jobs.test.ts (11), broadcastCardContainerQueries.test.ts (4), campaignComposerCardOverflow.test.ts (2), components/AnnouncementPlayer.test.tsx (17), components/BulkRolloutModal.test.tsx (14), components/RetryCampaignModal.test.tsx (38), components/ReviewSheet.test.tsx (20), components/VariableGrid.test.tsx (14), components/bulk-jobs/FilterChips.test.tsx (10), components/bulk-jobs/LiveJobCard.test.tsx (26), components/bulk-jobs/SegmentedProgressBar.test.tsx (21), components/bulk-jobs/broadcastChrome.test.tsx (42), components/bulk-jobs/jobProgressCell.test.tsx (8), components/bulk-jobs/lifecycleStepper.test.tsx (15), components/bulk-jobs/outcomeBreakdown.test.tsx (15), hooks/useBulkDispatchJobs.test.ts (37), hooks/useBulkDispatchJobsSummary.test.ts (10), hooks/useCampaignEstimate.test.ts (12), hooks/useRecurringSchedule.test.ts (4), hooks/useStaticCalls.test.ts (3), pages/BulkDispatchJobDetailPage.escalation.test.tsx (5), pages/BulkDispatchJobDetailPage.log.test.tsx (56), pages/BulkDispatchJobDetailPage.test.tsx (108), pages/BulkDispatchJobsPage.test.tsx (55), pages/CampaignAnalyticsPage.a11y.test.tsx (2), pages/CampaignComposerPage.escalation.test.tsx (5), pages/CampaignComposerPage.test.tsx (78), pages/ContactListDetailPage.escalation.test.tsx (3), pages/ContactListsPage.analytics.test.tsx (2), pages/RecurringScheduleEditorPage.test.tsx (9), pages/SchedulesPage.emptyState.test.tsx (2), pages/bulk-dispatch/broadcastAdapters.test.tsx (92), pages/bulk-dispatch/callRow.test.ts (13), pages/bulkProgress.test.ts (18), pages/campaign-registry.test.ts (123), static-calls-batch-poll.lock.test.ts (1), utils/broadcastConcurrency.test.ts (18), utils/broadcastMetrics.test.ts (60), utils/broadcastWorkspace.test.ts (16), utils/bulk-job-views.test.ts (23), utils/bulk-jobs.test.ts (129), utils/callErrorCopy.test.ts (11), utils/campaign-estimate.test.ts (21), utils/csv.test.ts (19), utils/recurring-schedule-routes.test.ts (1), components/campaigns/CallerIdPicker.test.tsx (23)

#### automations — 33 files
AutomationBuilderAutopilotTab.test.tsx (11), AutomationBuilderPage.test.tsx (8), AutomationCanvasGraph.test.tsx (39), AutomationCanvasNodes.test.tsx (19), AutomationRouteEditor.test.tsx (22), AutomationStepChannelGating.test.tsx (4), AutomationStepEditorFields.test.tsx (5), AutomationVariablesEditor.test.tsx (2), AutomationsSummary.test.tsx (3), WebhookFields.test.tsx (7), action-migration.test.ts (23), api/automation-executions.test.ts (9), automation-dry-run.test.ts (35), automation-evaluator.test.ts (24), automation-paths.test.ts (35), automation-planner.test.ts (40), automation-renderer.test.ts (24), automation-run-errors.test.ts (9), automationAutopilotPatch.test.ts (96), automationStepTree.test.ts (29), components/AutomationAttachmentPicker.test.tsx (12), components/AutomationGroupTarget.test.tsx (12), components/AutomationWhatsAppMedia.test.tsx (8), components/PredicateNumericInput.test.tsx (5), hooks/useAutomationExecutions.test.tsx (7), pages/AutomationDetailPage.routes.test.tsx (12), pages/AutomationDetailPage.stopRun.test.tsx (22), pages/InitiateCallPage.automations.test.tsx (4), planner-contract.test.ts (4), predicate-values.test.ts (15), registration/automations-capability-registration.test.ts (5), variable-key-validation.test.ts (6), webhook.test.ts (27)

#### call scripts, AutoPilot, knowledge — 47 files
AutopilotPanel.test.tsx (35), AutopilotToolChangesCard.test.tsx (17), PromptEditorAutopilotTab.test.tsx (21), PromptEditorIntroClip.test.tsx (27), PromptEditorLandmarks.test.tsx (4), PromptEditorNavSticky.test.tsx (2), PromptEditorPage.test.tsx (20), PromptEditorSaveReview.test.tsx (22), PromptEditorToolSaveRace.test.tsx (2), PromptEditorVersionRouting.test.tsx (5), PromptPreview.test.tsx (3), PromptsPage.test.tsx (17), ToolList.reloadSignal.test.tsx (4), ToolList.saveGate.test.tsx (5), api/knowledge-analytics.api.test.ts (9), api/promptsList.test.ts (5), autopilot.sse.test.ts (27), autopilotMarkdown.test.tsx (51), autopilotPatch.test.ts (51), autopilotToolChanges.test.ts (37), carryToolConfig.test.ts (9), catalogs.CatalogDetailPage.test.tsx (4), catalogs.CatalogTool.test.tsx (5), catalogs.CatalogsPage.test.tsx (3), catalogs.copy.test.ts (7), catalogs.polling.test.tsx (5), documents.DocumentDetailPage.test.tsx (6), documents.DocumentFileDetailPage.test.tsx (10), documents.DocumentsPage.test.tsx (5), documents.KnowledgeDocumentTool.test.tsx (4), documents.ToolList.attachGate.test.tsx (1), documents.api.test.ts (10), documents.copy.test.ts (14), hooks/useKnowledgeAnalytics.test.ts (3), hooks/usePromptEscalationRequirement.test.ts (5), hooks/usePromptsPage.test.ts (6), knowledge.CallRetrievalSection.test.tsx (16), knowledge.KnowledgeInsights.test.tsx (23), knowledge.analytics.test.ts (28), knowledge.detailPages.test.tsx (7), knowledge.grounding.test.tsx (11), knowledgeSettingsPurity.test.ts (5), pages/PromptEditor.escalation.test.tsx (9), promptDiff.test.ts (45), promptForm.test.ts (44), utils/call-script-draft.test.ts (15), utils/turnBargeInGrace.test.ts (33)

#### AI calls, softphone, SIP/BYOC, phone numbers, escalation — 49 files
InboundConfigDrawerFields.test.tsx (2), InitiateCallPagePhoneField.test.tsx (7), api/escalation.test.ts (12), api/sip.test.ts (10), api/webrtc-call.analysis.api.test.ts (5), api/webrtc-call.test.ts (34), components/ByocNumberBadge.test.tsx (6), components/CallActivityIcons.test.tsx (13), components/CallEscalationSection.test.tsx (18), components/InboundConfigDrawer.test.tsx (10), components/InboundEscalationNumber.test.tsx (11), hooks/useCall.test.tsx (7), hooks/useConcurrencyLimits.test.ts (27), hooks/useEscalationCallerIds.test.ts (9), hooks/useEscalationDestinations.test.ts (8), hooks/usePhoneNumberInboundConfig.test.tsx (4), hooks/useWebRtcCall.test.ts (53), hooks/useWebRtcCallDetail.test.ts (13), hooks/useWebRtcCallerIds.test.ts (10), hooks/useWebRtcCalls.test.ts (11), pages/CallsListPage.activity.test.tsx (5), pages/CallsListPage.barge.test.tsx (25), pages/CallsListPage.providers.test.tsx (4), pages/EscalateToHumanTool.test.tsx (18), pages/EscalationDestinationForm.test.tsx (28), pages/EscalationDestinationModal.test.tsx (15), pages/EscalationDestinationTestModal.polling.test.tsx (8), pages/EscalationDestinationTestModal.test.tsx (13), pages/EscalationDestinationsPage.test.tsx (19), pages/EscalationDestinationsPage.testAction.test.tsx (9), pages/EscalationHandoff.a11y.test.tsx (4), pages/InitiateCallPage.barge.test.tsx (27), pages/InitiateCallPage.byoc.test.tsx (1), pages/InitiateCallPage.escalation.test.tsx (6), pages/InitiateCallPage.systemVars.test.tsx (2), pages/WebRtcCallDetailPage.test.tsx (37), pages/WebRtcCallsListPage.test.tsx (24), pages/WebRtcDialerPage.analysis.test.tsx (11), pages/WebRtcDialerPage.test.tsx (42), pages/escalationCoverage.test.ts (47), pages/escalationErrors.test.ts (16), pages/escalationForm.test.ts (55), pages/escalationGating.test.tsx (15), utils/byocTelephony.test.ts (13), utils/callActivity.test.ts (43), utils/voice.test.ts (8), webrtc-call.test.ts (27), components/phone-numbers/InboundConfigDrawer.test.tsx (78), components/phone-numbers/PhoneNumberRow.test.tsx (13)

#### IVR / phone menus — 28 files
IvrCampaignRegistry.test.tsx (18), IvrSessionsPage.test.tsx (6), api/ivr-export.test.ts (11), ivr/DecisionNode.test.tsx (17), ivr/DecisionNodePorts.test.tsx (3), ivr/IvrBuilderAutopilotTab.test.tsx (16), ivr/IvrCanvasInteraction.test.tsx (7), ivr/IvrWorkflowBuilderPage.test.tsx (65), ivr/SimulatorPanel.test.tsx (2), ivr/SmartAudioFields.test.tsx (40), ivr/TemplateGallery.test.tsx (25), ivr/VariablesPanel.test.tsx (5), ivr/VoicePicker.test.tsx (30), ivr/autopilotPatch.test.ts (53), ivr/decisionExits.test.ts (22), ivr/graph.test.ts (37), ivr/ivr-graph.test.ts (29), ivr/layout.test.ts (16), ivr/panels.test.tsx (64), ivr/simulator.test.ts (86), ivr/stepFactory.test.ts (3), ivr/stepsReducer.test.ts (25), ivr/templates.test.ts (7), pages/CallDetailPage.ivrBanner.test.tsx (2), pages/IvrSessionDetailPage.aiHandoff.test.tsx (8), utils/flowLayout.test.ts (42), utils/ivr-workflow.test.ts (55), components/phone-numbers/ivr-insight.test.ts (10)

#### LoginPage/onboarding/festive (agency door is AgencyLoginPage) — 13 files
LoginPagePhoneField.test.tsx (3), OnboardingPhoneStep.test.tsx (1), components/AshokaChakra.test.tsx (1), components/IndependenceDayDecor.test.tsx (6), hooks/useOnboardingProgress.test.ts (2), pages/LoginPage.festive.test.tsx (3), pages/LoginPage.returnPath.test.tsx (8), pages/LoginPage.test.tsx (11), pages/OnboardingPage.flow.test.tsx (10), pages/OnboardingPage.ready.test.tsx (11), pages/OnboardingPage.test.tsx (7), pages/OnboardingPage.welcome-quickstart.test.tsx (12), utils/festive.test.ts (14)

#### platform pages not in scope / other — 12 files
TenantSettingsPage.test.tsx (7), api/analytics.test.ts (3), api/error-analytics.test.ts (8), components/ServiceConfigForm.test.tsx (3), contexts/MetadataContext.test.tsx (21), hooks/useHiddenTabPausedInterval.test.ts (2), pages/ApiKeysPage.analytics.test.tsx (2), pages/AuditLogPage.test.tsx (38), useFeatureFlag.test.ts (3), utils/localDayBounds.test.ts (2), utils/tenant-search.test.ts (13), utils/timezone.test.ts (13)

#### messaging, threads, follow-ups — 39 files
api/messaging-groups.test.ts (8), api/messaging-media.test.ts (8), api/threads.test.ts (19), components/FollowUpMenu.test.tsx (25), components/GroupPicker.test.tsx (35), components/GroupPickerRefresh.test.tsx (9), components/GroupPickerSingleSource.test.ts (5), components/PhoneInputToggleGroups.test.tsx (8), hooks/useConnectionGroups.test.ts (14), hooks/useConnectionQr.test.ts (6), hooks/useContactThreads.test.ts (8), hooks/useThread.test.ts (9), hooks/useThreadByCall.test.ts (9), hooks/useThreadTimeline.test.ts (11), messages-guidance.test.ts (8), messaging/template-components.test.ts (40), messaging/whatsapp-media.test.ts (23), pages/CallDetailPage.followup.test.tsx (4), pages/CallsListPage.followup.test.tsx (6), pages/ConnectionDetailPage.email-analytics.test.tsx (2), pages/ConnectionDetailPage.whatsapp-personal.test.tsx (4), pages/ConnectionsPage.a11y.test.tsx (3), pages/ConnectionsPage.analytics.test.tsx (6), pages/ConnectionsPage.governance.test.tsx (2), pages/InitiateCallPage.followup.test.tsx (11), pages/MessageDetailPage.group.test.tsx (9), pages/MessagesPage.followup.test.tsx (4), pages/MessagesPage.groups.test.tsx (11), pages/MessagesPage.guidance.test.tsx (4), pages/MessagesPage.media.test.tsx (16), pages/MessagesPage.mediaHeaderTemplate.test.tsx (4), pages/SipConnectionsPage.test.tsx (4), pages/TemplatesPage.mediaHeader.test.tsx (4), pages/ThreadTimelinePage.test.tsx (20), pages/WebRtcDialerPage.followup.test.tsx (4), pages/followupContract.test.tsx (1), pages/followupMessage.test.ts (13), utils/email-recipients.test.ts (9), utils/message-recipient.test.ts (14)

#### other — 26 files
api/originator-header.test.ts (11), components/AttentionLane.test.tsx (8), components/ConfirmDialog.test.tsx (4), components/ExecutionDetailDrawer.test.tsx (33), components/FlagDialog.test.tsx (10), components/FrequencyHint.test.tsx (8), components/MediaPickerModal.test.tsx (6), components/MediaUploadModal.test.tsx (11), components/OverrideReasonDialog.test.tsx (6), components/PerformancePanel.test.tsx (12), components/PriorCallBriefingCard.test.tsx (11), components/RunDetailDrawer.test.tsx (5), components/SummaryPane.test.tsx (19), components/TenantFeatureFlags.test.tsx (42), components/TenantPicker.test.tsx (16), components/TenantTelephonyCredentials.test.tsx (22), components/TriStateControl.test.tsx (12), components/ValueListInput.test.tsx (13), components/flagUtils.test.ts (9), gold-ii-tier.test.tsx (16), hooks/useChunks.test.ts (1), hooks/useRateCard.test.ts (6), hooks/useServerSort.test.ts (4), pages/DeprecationBanners.test.tsx (5), pages/MediaLibraryPage.test.tsx (6), pages/vocabularyRouteRedirects.test.tsx (14)

#### super-admin (its own app, Phase 9b) — 23 files
api/saFetchRaw.test.ts (25), api/superAdminAlerts.test.ts (6), api/superAdminReconcileCredits.test.ts (3), api/superAdminTelephonyProviders.test.ts (2), api/superAdminUsage.test.ts (30), contexts/SuperAdminContext.test.tsx (12), hooks/useSuperAdminFleet.test.ts (2), hooks/useSuperAdminTenant.test.ts (3), hooks/useSuperAdminUsage.test.ts (85), pages/SAAlertsPage.test.tsx (12), pages/SAAuditPage.test.tsx (1), pages/SADispatchLanesPage.test.tsx (5), pages/SAFeatureFlagsPage.test.tsx (34), pages/SAGovernancePage.test.tsx (5), pages/SAOverviewPage.test.tsx (9), pages/SAPhoneNumbersPage.test.tsx (5), pages/SAProvidersPage.test.tsx (18), pages/SAProvidersPage.wire.test.tsx (1), pages/SAProvidersPageSwitchCss.test.ts (5), pages/SATenantDetailPage.test.tsx (38), pages/SAUsagePage.test.tsx (89), pages/SAUsersPage.test.tsx (9), saStatus.test.ts (21)

#### credits and usage — 3 files
components/TransactionList.test.tsx (12), pages/CreditsPage.analytics.test.tsx (1), utils/creditOfferings.test.ts (24)

### 9.6 Branding: no MagickVoice links (decision B17, Manas 2026-10-09)

`/app` in this console is NOT the parent product: it is the platform zone of the same SPA (`AppLayout`: Team,
Notifications, Call summaries; index `AppHomeRedirect`). So no route leads out of Magick Agency, `/app`,
`AppHomeRedirect` and the `*` → `/app` catch-all stay, and the "Back to MagickVoice" exits are relabelled to say where
they go rather than deleted.

| Source @ee5beb44 | Destination | Status | Change and test |
|---|---|---|---|
| `src/components/layout/AgencyLayout.tsx` (+css) | same | modified | Topbar exit "Back to MagickVoice" (back arrow) → "Team & settings" (gear icon, `aria-label="Team and settings"` because the label hides on mobile), still `/app`. Removing it would strand a supervisor in `/agency` with no way to Team (inviting agents) or Call summaries |
| `src/components/agency/WorkspaceExit.tsx` | same | modified | Default children "Back to MagickVoice" → "Go to settings"; still the one sanctioned `/app` link under the agency roots (`agencyShellBoundary.test.ts` unchanged, green) |
| `src/pages/agency/AgentHomePage.tsx` | same | modified | `ExitToPlatform` (shown only to a `viewer`/`operator` on the agent persona) "Back to MagickVoice" → "Go to settings": for those roles `/app` opens on Notifications. Kept rather than replaced with sign-out: they have a real in-product destination |
| `brands/magickvoice/brand.config.json`, `brands/magickvoice/public/logo.png`, `brands/README.md` | `brands/magick-agency/brand.config.json`, README | modified / deleted | Pack renamed `magick-agency` (`Magick Agency` / `MA`); tagline "AI-Powered Voice Communications" and `promotions: true` dropped; MagickVoice logo deleted (no `public/`); accent colours kept |
| `vite.config.ts` | same | modified | `VITE_BRAND` default `magickvoice` → `magick-agency` |
| `index.html` | same | modified | `<link rel="icon" href="/logo.png">` removed (the logo was MagickVoice's); `<title>` is `%BRAND_NAME%` → "Magick Agency" |
| `src/brand/types.ts`, `src/brand/load-brand.ts` | same | modified | `promotions` removed from `Brand` and the loader (its only reader, cusui's `LoginPage` credits banner, is not ported). `load-brand.test.ts` 26 → 24: the 3 default-brand cases re-pointed at `magick-agency`; the 3 `promotions` cases replaced by 1 ("does not carry a promotions flag, even when the file sets one"). `index.test.ts` comments/titles renamed, same count |
| `src/components/common/Logo.tsx` | same | modified | `<img src="/logo.png">` → text tile (accent background, `shortName`), as the super-admin's. `Logo.test.tsx` 3 → 3 re-pointed (accessible name, no `<img>`, square size) |
| `src/config.ts` | same | modified | `ORIGINATOR` `${brand.id}-customer-ui` → `${brand.id}-console` (`magick-agency-console`; shown as the actor of dialer rows in the activity trail). `DOCS_BASE_URL` (`https://docs.magickvoice.com`), `DOCS_SLUGS`, `DocsSlug`, `docsUrl` deleted |
| `src/components/common/PageDescription.tsx` (+css), `src/pages/team/TeamPage.tsx` | same | modified | `docsSlug` / `docsLabel` props, the "Read the full guide" external link and `.docsLink` styles deleted; `TeamPage` no longer passes `docsSlug`. `PageDescription.test.tsx` 8 → 2 (the 8 link/`docsUrl` cases deleted; 2 deletion tests: no link rendered, no docs helpers exported) |
| `src/contexts/ThemeContext.tsx`, `src/utils/transcript-prefs.ts`, `src/utils/agencyCuePrefs.ts` | same | modified | localStorage keys `magickvoice-theme` → `magick-agency-theme`, `magickvoice-transcript-visible` → `magick-agency-transcript-visible`, `magickvoice.agency.cuePrefs.v1` → `magick-agency.cuePrefs.v1` (no users; no migration). `agencyCuePrefs.test.ts`, `TranscriptSection.test.tsx` updated, same counts |
| test fixtures | `__tests__/api/invites.test.ts`, `__tests__/pages/AgencyJoinPage.test.tsx`, `__tests__/pages/AgencyCampaignActivityPage.test.tsx` | modified | `product_name` → `Magick Agency Dialer` (the server's new output, §8.9); activity actor display → `magick-agency-console`. Same counts |
| — | `src/__tests__/branding/noParentBrand.test.ts` | NEW (4) | Fails on any `magick[ -_]?voice` / `magic[ -_]?voice` (case-insensitive) in non-test `src/**` (`.ts .tsx .css .json .html`), `brands/**`, `index.html`, `vite.config.ts` after comments are stripped; pins `brand.id = magick-agency`, no `brands/magickvoice`, no `logo.png`, `ORIGINATOR = magick-agency-console`; tests its stripper. Mutations (each → red): the AgencyLayout label restored and `DOCS_BASE_URL` re-added (2 offenders listed), `magickvoice-theme` restored (1), the `-customer-ui` suffix restored (originator case) |

Comments that only record provenance ("cusui said …", the staging-host incident in `useAgencyStation`) are left;
comments that quoted the old exit copy as current (`App.tsx`, `AppHomeRedirect`, `AgencyHomeRedirect`, `Sidebar`,
`agencyShellBoundary.test.ts`, `TeamPage`, `agencyActivityCopy`) are updated. Test fixtures that use
`app.magickvoice.com` as an arbitrary host (`posthog`, `redact`, `returnPath`, `TeamPage.*`, `agencyStationWsUrl`) are
not shipped and are left. `mv:sidebar-collapsed` and `mv:agency-live-session:*` keep their `mv:` prefix (internal,
not named in the ruling).

Printed after B17 (`apps/console`): `pnpm lint` 0 errors; `pnpm test`: 217 files, 4360 passed (4364 before: −6
`PageDescription`, −2 `load-brand`, +4 guard); `pnpm build` ok, and `dist/` contains no `magickvoice`.

Review follow-ups (`4824a58`):
- Guard stripper: `//` after `:` is a URL scheme, not a comment (unquoted URLs in JSX prose, CSS `url(...)`, unquoted
  attributes). NEW case "sees unquoted URLs…" (guard 4 → 5). Mutations: rule removed → that case red; an unquoted
  `https://docs.magickvoice.com` in `AgentHomePage` JSX prose → listed by the scan.
- NEW `src/__tests__/components/platformZoneExits.test.tsx` (2): `AgencyLayout`'s link named "Team and settings" →
  `/app` with text "Team & settings"; `<WorkspaceExit/>` default "Go to settings" → `/app`. `AgentHomePage.test.tsx`
  +3 (viewer with nothing assigned and operator with two campaigns see "Go to settings" → `/app`; a dedicated agent
  sees no exit). Mutations: label, default children, `canLeaveDialer = false` / `true` → red.
- `PageDescription.test.tsx` 2 → 3: cusui's collapsed-from-storage case restored without its link assertion (mutation:
  stored value ignored → red).
- `index.html`: `<link rel="icon" href="data:,">`. `vite.config.ts`: `publicDir` is the brand pack's `public/` only when
  it exists, else `false` (the stale "logo.png, doubling as favicon" comment replaced).

Printed (`apps/console`): `pnpm lint` 0 errors; `pnpm test`: 218 files, 4367 passed; `pnpm build` ok.

## Open-question fixes (branch `fix/open-questions`, Manas's rulings of 2026-10-09)

Deliberate departures from the verbatim port, each ruled on by Manas (docs/decisions.md Q1, Q5–Q9 and
the three non-Q rulings). Every change carries a `// Q<n> (Manas, 2026-10-09)` (or `Manas, 2026-10-09`)
comment and a test that was mutation-checked (break → red → restore).

| # | Source | Destination | Change | Tests (mutation-checked) |
|---|---|---|---|---|
| OQ-1 (Q8) | core `src/api/routes/agency.routes.ts@4850d1d9` `requireOwnedSession` (`:1340-1355`); master `src/api/routes/proxy-agency-agent.routes.ts@a1f0756a` session handlers | `apps/server/src/api/routes/agency.routes.ts`, `.../proxy-agency-agent.routes.ts` | modified. Master's six session handlers (station-token, available, break, break/cancel, leave, force-available) send the actor `resolveAgencyActor` already builds for attempt actions (`agent_user_id` = session user; `on_behalf` only for `agency.supervise`), spread last into the body. Core's guard: no actor → 400 `missing_actor` (before the lookup); caller is not `session.agent_user_id` → the SAME 404 as a missing session, checked before `left_at` (no 409 oracle); `supervisorMayAct` only on force-available. `requireOwnedAttempt` unchanged: every attempt route already runs `checkActor` (reserved agent, or `on_behalf`), and plain mark-DNC's lack of an ownership rule is core's documented design. Station socket: the upgrade carries no user identity (token-only, as core), so the binding is at mint — a token for session X can only be minted by X's agent (bootstrap or station-token) | unit `left-session-guards` 30 → 37 (harness sends the owner's actor; +7 Q8), `proxy-agency-agent-actions` 55 → 62 (1 modified: force-available body carries the actor; +7); integration `agency-runtime-routes` (2 CURRENT BEHAVIOR cases replaced by 8: A→B station-token 404 identical to missing, 4-row A→B presence routes 404 + untouched, owner's token opens own socket, supervisor 404 on presence, supervisor force-available 200), `agency-agent-state-cycle` (helper sends the agent's actor). Mutations: owner comparison removed → 5 unit + 6 integration red; station-token actor not forwarded → unit red |
| OQ-2 (Q7/Q9) | master `src/config/schema.ts:25-55@a1f0756a` (`trustProxyHops`), `src/index.ts:325-329` | `apps/server/src/config/blocks/base.ts` (`server.trustProxyHops`, `TRUST_PROXY_HOPS`), `apps/server/src/app.ts`, `.env.example`, `rate-limit.middleware.ts` comments | modified. Schema verbatim (`z.coerce.number().int().min(1, …).default(1)`). **Deviation:** passed to Fastify as `hopCountTrust(hops)` = `(addr, i) => i < hops` (proxy-addr's own hop rule), NOT the bare number: agency resolves Fastify 5.12.5, where a numeric `trustProxy` fails closed (always the socket peer) and no longer typechecks; master's lockfile pins 5.8.4, where the number meant exactly this. No context → `false` (socket peer). Never `true` | unit `open-questions-config` (TRUST_PROXY_HOPS default/2/refusals of 0, '', true, -1, 1.5; hopCountTrust; bare-number fails closed); integration `app/trust-proxy` (4: default 1; hops=1 ignores spoofed leftmost entries; rotating spoofs keeps one rate-limit bucket → 429; hops=2). Mutations: bare number → 3 red; `true` → 3 red |
| OQ-3 | (new key from lane D, plan §4) | `apps/server/src/config/blocks/analysis.ts`, `.env.example` | modified. `VOICELINK_RECORDING_HOSTS` unset → `['recording.app.voicelink.co.in']`; set → exactly the parsed list, so explicitly empty = `[]` = every recording fetch/playback refused (fail closed, an operator lever) | unit `open-questions-config` (default; empty; override; the real recording URL passes; lookalike suffix host, host-in-path, host-in-userinfo, sibling host, http refused), `analysis-config` (defaults case modified). Mutation: default back to `[]` → red |
| OQ-4 (Q1) | core `src/db/connection.ts@4850d1d9` (`ssl: { rejectUnauthorized: false }`) | `packages/db/src/connection.ts` (`buildSslOption`), `apps/server/src/config/blocks/base.ts` (`db.sslRejectUnauthorized`, `db.sslCa`), `apps/server/src/index.ts` | modified. TLS still on only in production (unchanged); when on, `rejectUnauthorized: true` unless `DB_SSL_REJECT_UNAUTHORIZED=false` (strict enum: '' / 'no' / '0' are boot errors); `DB_SSL_CA` = PEM text (literal `\n` allowed; a non-PEM value such as a path is a boot error; blank = unset). `DATABASE_URL` carrying `ssl` / `sslmode` / `sslrootcert` / `sslcert` / `sslkey` / `sslnegotiation` (any case; lead fix after review) is refused at config parse (`findUrlTlsParams`; pg assigns URL params over the `ssl` object, so they would silently replace the verified settings); no test, dev or script URL uses them | db unit `connection-ssl` (5, new); server unit `open-questions-config` (5 + 9 URL-parameter cases). Mutation: core's literal restored → 4 red |
| OQ-5 (Q6) | core `src/core/webrtc-bridge-manager.ts:2410@4850d1d9` (`verifyWsToken`, `storeWsToken`, `clearWsToken`) | `apps/server/src/core/webrtc-bridge-manager.ts` | modified (middle option). Redis answered + key missing → refuse; Redis absent / `get` error → accept (unchanged); present-but-wrong → refuse (unchanged). Legitimate missing-key paths handled explicitly: (a) the carrier's late terminal posts (recording URL, `persistLateVoicelinkTerminal`) after teardown — `clearWsToken` now `EXPIRE`s the webhook token to `WEBHOOK_TOKEN_POST_END_GRACE_SECONDS` (2h) instead of `DEL`; browser/provider tokens still deleted; (b) a token whose `SET` failed at mint (Redis blipped, then recovered) — remembered in-process (`unstoredWsTokens`, bounded, D2 single replica) and still accepted. No other leg relies on the fallback: provider/webhook tokens are stored before the dial, for maxDuration+60s; no caller verifies a `browser` token (softphone leg deleted; borrowed legs mint none). The refusal logs a warning; the Redis invariant (persistence, `noeviction`) is stated beside the grace constant and in `.env.example`; the unstored memo is process-local (D2) | unit `webrtc-bridge-manager` 53 → 57 (1 modified: missing key → false; +4: live call, post-end grace, SET-failed-at-mint, Redis absent/erroring). Mutations: missing-key → true reds 3; DEL instead of EXPIRE + no unstored memory reds 2 |
| OQ-6 (Q5) | master `src/cache/redis-cache.ts@a1f0756a` (`del` swallows); master `user.routes.ts` / agency's new super-admin membership routes | `apps/server/src/cache/redis-cache.ts` (`delForRevocation`, 3 attempts, 50/100ms backoff, ERROR log with keys), `src/cache/revocation-unavailable.ts`, `user.routes.ts`, `super-admin.routes.ts` | modified. Role changes (`PUT /users/:id/role`, `PUT /super-admin/tenants/:id/memberships/:membershipId/role`) are idempotent on retry → 503 `cache_invalidation_failed` (reviewed fixed-shape 5xx, passes the mask) AFTER the role write, staffing close and audit. Membership removals (`DELETE /users/:id/membership`, `DELETE /super-admin/tenants/:id/memberships/:membershipId`) are NOT idempotent (a retry 404s before the delete) → keep 2xx, ERROR log only. Grants (invite, add user, invite claim) and non-access invalidations (user record, tenant/account records) keep `del`. No metric added (none fits; adding one is an observability-declaration change). TTLs: membership 30 min, user 20 min, tenant/account record 5 min, local layer 5 s (off by default). No tenant/account soft-delete route exists in agency | unit `redis-cache-revocation` (3, new), `user-offboarding-staffing` (+3), `super-admin-memberships` (+2); 8 route test doubles gain `delForRevocation` forwarding to their `del` mock. Mutations: helper returns true → 1 red; 503 line removed → 2 red |
| OQ-7 | core `src/config/schema.ts:1961@4850d1d9` (`transcriptRetentionDays` `.default(30)`, agency window falls back to it) | `apps/server/src/config/blocks/analysis.ts`, `bootstrap/analysis.ts` comment | modified. `AGENCY_TRANSCRIPT_RETENTION_DAYS` defaults to 30 (env fallback `DIALER_TRANSCRIPT_RETENTION_DAYS`, core's order), so the purge timer is armed on every parsed config. `AGENCY_RETENTION_DAYS` stays unset (core had no config default; its row window came from the retention Lambda's request, `RETENTION_DAYS=85`); the `RETENTION_MIN_DAYS` floor is unchanged | unit `schema.dialer-analysis` (2 modified: "defaults transcript retention to thirty days" restored against the agency key; row window unset), `analysis-config` (defaults), `open-questions-config` (3), `bootstrap-analysis` (+1: default parsed config schedules the purge). Mutation: `.optional()` restored → 3 red |
| OQ-8 | master super-admin routes' `superAdminAuditRepository.log(...).catch(() => {})` | `apps/server/src/audit/super-admin-audit.ts` (`recordSuperAdminAudit`), `super-admin{,-phone,-feature-flags,-account-settings}.routes.ts` | modified. Still fire-and-forget; 20 silent catches replaced by the helper, which logs a failed write at ERROR with action, actor (id, email), target (type, id) and tenant. The two awaited concurrency writes keep master's shape (master's source-scan tests read it) with the same context added to their existing error logs | unit `super-admin-audit-failure-logged` (4, new, incl. a source scan that no route keeps the silent catch). Mutation: empty `onError` → 2 red |

## OpenTelemetry SDK (branch `feat/otel-sdk`, Manas 2026-10-09)

Nothing started an SDK, so every metric and `@Traced` span went to the OTel API's no-op. Export path
ruled by Manas: **OTLP push only** (core's Grafana Cloud path); core's `:9090` scrape stays unported.
With `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` set, traces and metrics export; otherwise no
provider is installed and behaviour is as before.

| Source | Destination | Kind | Notes |
|---|---|---|---|
| core `src/instrumentation.ts`@4850d1d9 | `apps/server/src/instrumentation.ts` | modified | Deleted: the pull-only `MeterProvider` installed with export off (`:213-228`) and both `setMetricsScrapeRenderer` calls (`:205`, `:227`); `withFreshGauges` takes no `lastExport`. Added: `import 'dotenv/config'` first (master `src/instrumentation.ts:1-2`@a1f0756a; here `.env` is otherwise loaded by `config/index.ts`, after this file), and master's invite-token hook on the HTTP instrumentation (`src/utils/otel-instrumentations.ts:132-134`@a1f0756a). `APP_VERSION`/`SERVICE_NAME` from `@magick-agency/observability/{version,service}` subpaths (the index would load `meter.ts` before the provider exists); heap gauge meter `magick-agency.runtime` |
| core `src/utils/otel-sdk-config.ts`@4850d1d9 | `apps/server/src/utils/otel-sdk-config.ts` | modified | `:1-301` verbatim except the default `service.name` (`SERVICE_NAME`, `:120`) and `withFreshGauges`' `lastExport` (`:280-291`). Deleted: the `:9090` section `:303-457` |
| core `src/utils/metrics-scrape.ts`@4850d1d9 | — | deleted | The `:9090` scrape seam |
| core `src/index.ts:1, :952`@4850d1d9 | `apps/server/src/index.ts` | modified | `instrumentation.js` imported first; `await shutdownOtelSdk()` after `closePool()`, before `process.exit(0)`. The listen log line carries `otelExport` |
| (new) | `apps/server/src/config/blocks/base.ts` (`otel`), `.env.example` | new | `config.otel` = `enabled`, `endpoint`, `exporting`, `metricsExportIntervalMs`, `serviceName`, `serviceInstanceIdEnabled`, parsed exactly as `instrumentation.ts` reads them (it cannot read config: it loads first, and config can `process.exit(1)`). `OTEL_EXPORTER_OTLP_HEADERS` (the token) is left out |

Dependencies (`apps/server`): `@opentelemetry/sdk-node` 0.223, `auto-instrumentations-node` 0.81,
`exporter-{trace,metrics}-otlp-proto` 0.223, `instrumentation-pino` 0.69, `resources` / `sdk-metrics`
2.12, `semantic-conventions` 1.43; dev `instrumentation-runtime-node` 0.36. Core pinned 0.213 / 0.75 /
2.6; one release train newer so `sdk-metrics` stays the single 2.12 copy already in the lockfile.

Tests:

| Test | Source | Source → ported | Notes |
|---|---|---|---|
| `test/unit/utils/otel-sdk-config.test.ts` | core `test/unit/utils/otel-sdk-config.test.ts`@4850d1d9 | 42 → 25 (+5 agency) = 30 | Deleted (17, the `:9090` scrape): "the :9090 scrape reader applies the same rule"; `renderPrometheusScrape — the local :9090 view` (4); `collection errors in the :9090 body` (3); `renderLastExportScrape — …` (8); "always builds a meter provider, so :9090 serves metrics with OTLP export off". Modified: default `service.name`; "drops none of OUR metrics" reads `packages/observability/src/metrics/*.ts` (canary 30, not 100); "exporting path has exactly ONE metric reader" (no `lastExport`). Added under `agency additions`: no provider with export off; `dotenv/config` first; observability reached only through import-free subpaths; the HTTP redaction hook (master's deleted `redact-url` case "the trace instrumentation set hands the redactor to the HTTP instrumentation", as a source audit); `index.ts` imports it first and flushes it last |
| `test/unit/config/otel-config.test.ts` | (new) | 4 | `config.otel` agrees with the SDK's own resolvers |

Mutation-checked (break → red → restore): HTTP hook removed; `dotenv/config` removed; flush moved before
`closePool()`; a provider installed with export off; config `enabled` accepting `'1'`; config parsing the
interval itself. Each turned one case red.

End-to-end against a local `otel/opentelemetry-collector-contrib:0.111.0` (OTLP/HTTP), both the esbuild
bundle and `tsx src/index.ts`: pg, ioredis and http spans; app metrics under scope `magick-agency`
(e.g. `invite_claims_total`), the runtime allow-list and `nodejs_heap_size_used_bytes`; logs through
`instrumentation-pino`; invite paths exported as `/invites/:token`; a final batch flushed on SIGTERM.
With OTel off: no `[otel]` output, nothing sent, same shutdown.
