# Baseline schema inventory — `migrations/0001_baseline.sql`

The baseline is the **end state** of every object Magick Agency carries from the two
source schemas, with each later `ALTER` folded into the `CREATE` it modifies.

| Source | Version | SHA (verified with `git -C <sub> rev-parse HEAD`) | Migrations read |
|---|---|---|---|
| `magic-voice-core` | v1.123.2 | `4850d1d9ffc9eb9eab56d2ed482b9bd616edd103` | 001–138 |
| `magick-master` | v3.24.0 | `a1f0756a58a63bf8a19baf74298a702f9fe7b430` | 001–079 |

Rules applied throughout:

- **Port verbatim.** Same names, constants, CHECKs, defaults, in-table comments,
  constraint comments and `COMMENT ON` text. Long migration *headers* are not
  repeated; each object carries a `source:` line naming the files that hold its
  rationale.
- **Ids.** Every tenant, account and user id column is `UUID` (core stored master's
  ids as `VARCHAR(100)`). Free-form *actor labels* that the source did not type as a
  user id stay as the source had them. Both lists are below.
- **Foreign keys.** Exactly the FKs each source had. No FK was added between domains
  the sources kept apart (core tables → `tenants`, `agency_*` → `users`, and so on).
  Candidates are under "Open questions".
- **Data.** Backfills and seeds are not carried. Only one reference row is seeded
  (`telephony_providers.voicelink`, see master 043).
- **Single file, single transaction.** node-pg-migrate splits SQL files on
  `/^\s*--[\s-]*(up|down)\s+migration/im`. The file has exactly one of each marker,
  and the test suite asserts that.

---

## 1. Migration inventory

Every source migration consulted, with what was carried and what was excluded.
Migrations not listed here were checked (by grepping every file for each carried
table name) and touch no carried object.

### magic-voice-core

| Migration | Carried | Excluded, and why |
|---|---|---|
| `001_initial_schema` | `update_updated_at()` function; `uuid-ossp` extension | `calls` etc. (AI calling); `pgcrypto` (`gen_random_uuid()` is built in from PG 13, and no carried SQL calls a pgcrypto function) |
| `003_audit_partitioning` | `audit_logs` (B7) + its 4 indexes | its 2026-02..05 partitions are replaced by the baseline's 2026-01..2027-12 window |
| `007_announcements` | `audio_files`, `announcements` (non-TTS columns), triggers, indexes | `static_call_status`, `static_calls` (static AI calls); `tts_text`/`tts_voice`/`tts_language` and `announcements_tts_check` (decision 4: uploaded clip only) |
| `014_account_id` | `account_id` on `announcements`, `audio_files`, `audit_logs`; their rebuilt indexes and `audio_files_tenant_account_name_key` | other tables (not carried); the `'default'` backfill UPDATEs (DML) |
| `015_drop_account_id_defaults` | the dropped `account_id` defaults on the three carried tables | other tables |
| `020_vobiz_tts_defaults` | nothing | TTS column defaults (columns not carried) |
| `022_account_settings` | `account_settings` table, unique, two indexes | — |
| `023_fix_account_settings` | (identical re-create of 022) | — |
| `024_backfill_account_settings` | nothing | backfill DML |
| `031_audio_file_fk_set_null` | `announcements_audio_file_id_fkey ON DELETE SET NULL`; relaxed `announcements_audio_check` | — |
| `038_audit_partitions_extend` | `audit_logs_default` DEFAULT partition | its relative partition loop (replaced by the fixed window) |
| `039_account_default_pipeline` | nothing | `account_settings.default_ai_pipeline` (AI pipeline selection) |
| `044_tenant_settings` | nothing | `tenant_settings` (AI pre-warm; dropped again by 046) |
| `046_feature_flags` | `feature_flag_overrides`, its 3 partial uniques, `idx_ff_tenant`, trigger | the `tenant_settings` backfill and drop |
| `047_webrtc_calls` | → `agency_calls` (renamed), its CHECK, trigger, 3 indexes (renamed) | — |
| `048_webrtc_call_recording` | `recording_requested`, `recording_url`, `recording_duration_seconds` | — |
| `051_sip_connections` | nothing | `sip_connections`; `webrtc_calls.sip_connection_id` (SIP) |
| `059_dialer_call_analysis` | `call_analysis_profiles`; 8 analysis columns + `ck_webrtc_analysis_status` + analysis-status index on `agency_calls`; `account_settings.analyze_dialer_calls`; `dialer_analysis_jobs` | `settlement_status`, `settlement_attempts`, `settlement_pending_since`, `ck_dialer_analysis_settlement`, `idx_dialer_analysis_jobs_settlement` (plan §4: no settlement) |
| `067_audio_file_pcm` | `pcm_audio_hash`, `pcm_sample_rate`, `pcm_channels` | — |
| `070_provider_concurrency` | allocation mode/version + 2 CHECKs on `account_settings`; `account_provider_concurrency_allocations` | — |
| `072_agency_campaigns` | `agency_campaigns`, 3 indexes, trigger, comments | `sip_connection_id` (SIP / BYO trunk egress) |
| `073_agency_contacts` | `agency_contacts`, 3 indexes incl. `uq_agency_contacts_source_row`, trigger, comments | — |
| `074_agency_agents` | `agency_agent_sessions`, `idx_agency_agent_sessions_live`, trigger, comments | `uq_agency_agent_live` (dropped by 093) |
| `075_agency_attempts` | `agency_call_attempts`, 6 indexes, trigger, comment | — |
| `076_webrtc_agency_columns` | `campaign_id`, `agency_attempt_id` on `agency_calls` + comments | — |
| `077_agency_ingest_chunks` | `agency_ingest_chunks`, 2 indexes, comment | — |
| `078_agency_break_reasons` | `break_reasons` + `ck_agency_campaign_break_reasons` | — |
| `079_agency_disposition_actor` | 3 disposition-actor columns, `idx_agency_attempts_on_behalf`, comment | — |
| `080_agency_abandon_announcement` | `abandon_announcement_id` + comment | — |
| `081_agency_attempt_billing_index` | `idx_agency_attempts_billing` + comment (kept for metering, plan §3.3) | — |
| `082_agency_our_fault_attempts` | `our_fault_attempts` + comment | — |
| `083_agency_contact_row_fingerprint` | `agency_contact_row_fingerprint()` + comment; `row_fingerprint` + comment; `uq_agency_contacts_row_fingerprint` | the fingerprint backfill UPDATE (DML) |
| `084_agency_ingest_chunk_rejections` | `rejected_duplicate_rows`, `duplicate_source_rows` + comments | — |
| `085_agency_contact_csv_line` | `csv_line_number` + comment; the updated comment on `source_row_number` | — |
| `086_agency_dnc_outbox` | `agency_dnc_outbox`, 3 indexes, trigger | — |
| `087_agency_dnc_campaign_scope` | `agency_dnc_outbox.campaign_id` + comment; `idx_agency_contacts_campaign_phone_digits` + comment | — |
| `088_agency_wrapup_measurement` | 3 wrap-up columns + comments, `ck_agency_wrapup_resolution`, `idx_agency_attempts_wrapup` | — |
| `089_agency_abandonment_ceiling` | 4 columns + comments, 2 CHECKs | — |
| `090_agency_attempts_calls_handled_index` | `idx_agency_attempts_agent_bridged` + comment | — |
| `093_agency_agent_session_tenant_unique` | `uq_agency_agent_live_tenant` + comment (replaces 074's index) | the `LOCK TABLE` and the dedupe UPDATE (DML) |
| `094_audit_logs_campaign_id_index` | `idx_audit_logs_campaign_id` (B7) | — |
| `095_agency_contacts_reporting_index` | `idx_agency_contacts_reporting`, `idx_agency_contacts_phone_suffix`, `idx_agency_attempts_keyset` + comments | — |
| `096_tenant_telephony_credentials` | nothing | BYOC credential table; `webrtc_calls.telephony_credential_id` |
| `098_telephony_credential_call_indexes` | nothing | `idx_webrtc_calls_telephony_credential` (BYOC; already dropped with its column by 099) |
| `099_drop_tenant_telephony_credentials` | (net: removes 096/098 objects) | — |
| `102_call_telephony_credential_id` | nothing | `webrtc_calls.telephony_credential_id` re-added (BYOC credentials) |
| `104_agency_attempts_agent_dialed_index` | `idx_agency_attempts_agent_dialed` + comment | — |
| `105_agency_agent_session_events` | `agency_agent_session_events`, index, comments | — |
| `106_webrtc_calls_scope_index` | nothing | `idx_webrtc_calls_tenant_dialer` (serves only the softphone history list, `campaign_id IS NULL`; the softphone is deleted, plan §5) |
| `107_agency_call_analysis_backfill` | nothing | seeds `feature_flag_overrides` rows (DML) |
| `108_agency_campaign_lifecycle` | `ended_at`, `last_transition_by_user_id`, `last_transition_by_name` + comments (incl. new comments on `started_at`, `completed_at`) | — |
| `109_agency_campaign_lifecycle_backfill` | nothing | backfill DML |
| `110_prompt_intro_clip` | nothing | `prompt_templates.intro_audio_file_id` (AI prompts) |
| `111_agency_campaign_retry_lineage` | 4 lineage columns + comments, `idx_agency_campaigns_parent` | — |
| `112_agency_contacts_lineage` | `source_contact_id`, `root_contact_id` + comments; `agency_contact_stamp_root()` + comment; `trg_agency_contacts_root` | — |
| `113_agency_contacts_lineage_backfill` | nothing | backfill DML |
| `114_agency_contacts_root_index` | `idx_agency_contacts_root` + comment | — |
| `115_agency_retry_idempotency` | `retry_idempotency_key` + comment, `uq_agency_campaign_retry_idempotency` | — |
| `119_agency_abandon_reason` | `abandon_reason` + comment | — |
| `131_call_request_flags` | nothing (it only mentions `account_settings` in a comment on `calls`) | AI calls |
| 116–118, 120–130, 132–138 | nothing | AI / IVR / KB / BYOC / escalation / bulk / quality scores; none touch a carried table |

### magick-master

| Migration | Carried | Excluded, and why |
|---|---|---|
| `001_initial_schema` | `update_updated_at()` (same body as core's), `tenants`, `accounts`, `users`, `membership_role`, `memberships`, their indexes and triggers | `pgcrypto` (see core 001) |
| `002_credits`, `006_credit_reservations` | nothing | credits/billing; they add no column to a carried table |
| `003_platform_api_keys`, `065_platform_api_key_created_by_restrict` | nothing | API keys (decision 5) |
| `004_tenant_core_credentials` | nothing | per-tenant core API keys (no core in agency) |
| `005_platform_audit_log` | `platform_audit_log`, 2 indexes | its relative partition loop |
| `007_super_admins` | `super_admins`, index | the seed row with a known default password (decision 6: super-admins are created fresh) |
| `008_user_phone_and_admin_audit` | `users.phone_number`; `super_admin_audit_log` + 2 indexes (the super-admin audit trail, plan §3.4) | — |
| `010_phone_numbers` | `telephony_providers`, `phone_numbers`, `tenant_phone_assignments`, `phone_account_tags`, indexes, triggers | the provider seed rows (only VoiceLink is seeded, from 043), the seed number, the assignment backfill |
| `012_backfill_tenant_phone_assignments` | nothing | backfill DML |
| `022_super_admin_is_system` | `super_admins.is_system` | the UPDATE marking the seed admin |
| `025_account_slug_partial_unique` | `idx_accounts_tenant_slug_active` (replaces `accounts_tenant_id_slug_key`) | — |
| `027`, `028`, `036` | nothing | telnyx / z99 provider seed rows |
| `034_audit_partitions_extend` | `platform_audit_log_default` DEFAULT partition | its relative partition loop |
| `037_phone_number_pool_eligible` | `phone_numbers.pool_eligible`, `idx_phone_numbers_pool` | the UPDATE on the seed number |
| `040_governance_overrides` | nothing | governance (plan §3.2 replaces it with the per-account settings row) |
| `043_voicelink_provider` | the `voicelink` provider row | — |
| `046`, `047`, `048` | nothing | dispatch lanes and provider concurrency *entitlements* (master's push source); agency's own guard tables (core 022/070) are the system of record |
| `050_dnc` | `dnc_entries`, `uq_dnc_scope`, 2 indexes | — |
| `051_membership_role_agent` | `'agent'` folded into `CREATE TYPE membership_role`, appended last as 051 did | — |
| `052_agency_rate_cards` | nothing | rate cards and `agency_attempt_settlements` (excluded by the plan) |
| `053_agency_ingest_jobs` | `agency_ingest_jobs`, 3 indexes, trigger | — |
| `054_dnc_sync_state` | `dnc_sync_state`, index, trigger | — |
| `055`, `056`, `057`, `058` | the six ingest columns, `ck_agency_ingest_mode`, comments | — |
| `059_agency_ingest_rejection_uncertainty_backfill` | its `COMMENT ON` (it supersedes 056's) | backfill UPDATE |
| `060_agency_campaign_agents` | `agency_campaign_agents`, `idx_agency_campaign_agents_campaign_active`, trigger, comments | `uq_agency_campaign_agent_active` (dropped by 064) |
| `061_audit_log_account_campaign` | `account_id`, `campaign_id`, 3 indexes | the `campaign_id` backfill UPDATE |
| `062` + `063` | nothing (net effect is zero: 063 drops what 062 added) | 063's DML on BYOC numbers |
| `064_agency_campaign_agents_multi` | `uq_agency_campaign_agent_active_campaign`; updated comments | — |
| `066`, `070`, `078` | nothing | credits (excluded by the plan) |
| `067_audit_log_actor_type` | `actor_type`, its comment, the new `user_id` comment | `api_key_id` and `idx_audit_log_tenant_api_key` (no API keys); the `SET lock_timeout` wrappers (not needed for a baseline) |
| `068_automation_routes` | nothing | automations |
| `069_membership_invites` | `membership_invites`, 2 indexes, comments | — |
| `071`, `075`, `076`, `077`, `079` | nothing | bulk dispatch |
| `072_notification_preferences` | `user_notification_preferences`, `notification_deliveries`, their indexes and trigger | `SET lock_timeout` |
| `073_users_email_unverified` | `users.email_unverified` + comment | the backfill UPDATE |
| `074_telephony_provider_live_transfer` | nothing | `telephony_providers.live_transfer_enabled` (AI escalation transfer only) |

---

## 2. Tables

34 tables (plus 48 monthly partitions and 2 DEFAULT partitions).

| Group | Tables |
|---|---|
| Identity (master) | `tenants`, `accounts`, `users`, `memberships`, `membership_invites`, `super_admins`, `super_admin_audit_log` |
| Phone inventory (master) | `telephony_providers`, `phone_numbers`, `tenant_phone_assignments`, `phone_account_tags` |
| Notifications (master) | `user_notification_preferences`, `notification_deliveries` |
| Audit | `platform_audit_log` (master), `audit_logs` (core, decision B7) |
| Master agency | `dnc_entries`, `dnc_sync_state`, `agency_ingest_jobs`, `agency_campaign_agents` |
| Settings, guard, flags (core) | `account_settings`, `account_provider_concurrency_allocations`, `feature_flag_overrides` |
| Clips (core) | `audio_files`, `announcements` |
| Analysis (core) | `call_analysis_profiles`, `dialer_analysis_jobs` |
| Core agency | `agency_campaigns`, `agency_contacts`, `agency_agent_sessions`, `agency_agent_session_events`, `agency_call_attempts`, `agency_ingest_chunks`, `agency_dnc_outbox`, `agency_calls` |

### Per-table columns

"Kept" lists every column. "Type" marks a change from the source type. Every drop has a reason.

#### `tenants` — master 001
Kept: `id, name, slug, settings, status, created_at, updated_at`. Dropped: none.

#### `accounts` — master 001, 025
Kept: `id, tenant_id, name, slug, settings, status, created_at, updated_at`. Dropped: none.
Constraint change from 001 (by 025): `accounts_tenant_id_slug_key` → partial `idx_accounts_tenant_slug_active`.

#### `users` — master 001, 008, 073
Kept: `id, firebase_uid, email, display_name, avatar_url, status, created_at, updated_at, phone_number, email_unverified`. Dropped: none.

#### `memberships` — master 001, 051
Kept: `id, user_id, tenant_id, account_id, role, status, invited_by, created_at, updated_at`. Dropped: none. Revoked rows are retained (`status = 'revoked'`).

#### `membership_role` (enum) — master 001, 051
`tenant_owner, tenant_admin, account_admin, operator, viewer, agent`. This is **master's actual order**: 051 used `ADD VALUE 'agent'` with no `BEFORE`, so `agent` sorts last. The order suggested in the brief (agent first) is not the source order and was not used. The level-5 hierarchy lives in `roles.ts`, never in enum order.

#### `membership_invites` — master 069
Kept: `id, membership_id, tenant_id, email, role, token_hash, expires_at, claimed_at, claimed_by_user_id, revoked_at, invited_by, created_at`. Dropped: none.

#### `super_admins` — master 007, 022
Kept: `id, email, password_hash, name, status, created_at, updated_at, is_system`. Dropped: none. **Seed row not carried** (decision 6).

#### `super_admin_audit_log` — master 008
Kept: `id, admin_id, admin_email, action, resource_type, resource_id, details, created_at`. Dropped: none.

#### `telephony_providers` — master 010
Kept: `id, name, display_name, status, created_at, updated_at`.
Dropped: `live_transfer_enabled` (074). It exists only for AI escalation's live transfer.
Seeded: one row, `('voicelink', 'VoiceLink')`.

#### `phone_numbers` — master 010, 037 (062/063 net zero)
Kept: `id, phone_number, provider_id, label, capabilities, region, max_concurrent_calls, status, notes, created_by, created_at, updated_at, pool_eligible`.
Dropped: none. `ownership` and `owner_tenant_id` (062) were already dropped at source by 063. The table has no provider-credential or SIP columns.

#### `tenant_phone_assignments` — master 010
Kept: `id, tenant_id, phone_number_id, is_default, assigned_by, assigned_at`. Dropped: none.

#### `phone_account_tags` — master 010
Kept: `id, assignment_id, account_id, is_default, tagged_by, tagged_at`. Dropped: none.

#### `user_notification_preferences` — master 072
Kept: `id, user_id, tenant_id, event_key, channel, enabled, frequency, created_at, updated_at`. Dropped: none.

#### `notification_deliveries` — master 072
Kept: `id, event_key, dedupe_key, recipient, tenant_id, account_id, status, error, sent_at, created_at`. Dropped: none.

#### `platform_audit_log` — master 005, 034, 061, 067
Kept: `id, tenant_id, user_id, action, resource_type, resource_id, details, ip_address, created_at, account_id, campaign_id, actor_type`.
Dropped: `api_key_id` and its partial index `idx_audit_log_tenant_api_key` (067). They name a platform API key, and agency has no API keys (decision 5).
Partitions: `platform_audit_log_2026_01` … `platform_audit_log_2027_12` plus `platform_audit_log_default`.

#### `audit_logs` — core 003, 014, 015, 038, 094 (lead decision B7)
Kept: `id, call_id, tenant_id (Type), event_type, event_category, severity, event_data, request_id, actor, ip_address, timestamp, duration_ms, account_id (Type)`. Dropped: none.
`call_id` has no FK, as in core. Partitions: `audit_logs_2026_01` … `audit_logs_2027_12` plus `audit_logs_default`. Core's own partitions began at 2026-02; 2026-01 was added so both audit tables share one window.

> **Partition maintenance is a runtime job (lane A).** The baseline creates the window
> to 2027-12 and a DEFAULT partition on each table. Creating later months, and
> dropping aged months for retention, is not done by any migration. Core and master
> both do this from `retention-purge.ts` and their partition code.

#### `dnc_entries` — master 050
Kept: `id, tenant_id, account_id, campaign_id, phone_e164, source, reason, added_by, created_at`. Dropped: none.

#### `dnc_sync_state` — master 054
Kept: `tenant_id, version, published_version, last_error, last_published_at, updated_at`. Dropped: none.

#### `agency_ingest_jobs` — master 053, 055–058
Kept: `id, tenant_id, account_id, campaign_id, s3_key, file_name, file_size_bytes, phone_column, timezone_column, ignore_columns, default_country_code, dedupe_phones, dry_run, status, cancel_requested, rows_read, accepted, rejected, duplicates, rejected_by_reason, bytes_read, chunks_sent, chunks_total, headers, context_columns, rejected_s3_key, rejected_row_count, rejected_truncated, error_code, error_message, created_by, created_at, started_at, finished_at, updated_at, core_rejected_duplicate_rows, core_duplicate_source_rows, core_rejected_duplicate_rows_may_undercount, mode, replace_superseded_contacts, replace_superseded_uncertain`. Dropped: none.

#### `agency_campaign_agents` — master 060, 064
Kept: `id, tenant_id, account_id, campaign_id, user_id, assigned_by, assigned_at, unassigned_at, created_at, updated_at`. Dropped: none.

#### `account_settings` — core 022/023, 049, 059, 070 (+ one added column)
Kept: `id, tenant_id (Type), account_id (Type), max_concurrent_calls, created_at, updated_at, analyze_calls, allow_recording, analyze_dialer_calls, concurrency_allocation_mode, concurrency_allocation_version`.
Dropped: `default_ai_pipeline` (039). It picks the default AI pipeline for inbound and DID calls; agency has no AI calling.
**Added (no source):** `webrtc_max_duration_seconds INTEGER NULL`, with `chk_account_settings_webrtc_max_duration_seconds CHECK (webrtc_max_duration_seconds IS NULL OR webrtc_max_duration_seconds > 0)`. Plan §3.2 folds core's `webrtc_max_duration_seconds` flag into the per-account settings row. NULL means the process default applies.

#### `account_provider_concurrency_allocations` — core 070
Kept: `id, tenant_id (Type), account_id (Type), telephony_provider, max_concurrent_calls, created_at, updated_at`. Dropped: none. The composite FK to `account_settings (tenant_id, account_id) ON DELETE RESTRICT` is kept.

#### `feature_flag_overrides` — core 046
(The brief calls this "`feature_flags`". The real table name is `feature_flag_overrides`, and that name is kept.)
Kept: `id, flag_key, scope_type, tenant_id (Type), account_id (Type), value, reason, expires_at, created_by, updated_by, created_at, updated_at`. Dropped: none.

#### `audio_files` — core 007, 014, 015, 067
Kept: `id, tenant_id (Type), name, slug, original_filename, content_type, size_bytes, s3_key, duration_seconds, created_at, updated_at, account_id (Type), pcm_audio_hash, pcm_sample_rate, pcm_channels`. Dropped: none.
What the abandon-clip path reads (`abandon-clip.ts` → `audioFileRepository.findById` → `ensurePcmClip`): `id, s3_key, content_type, pcm_audio_hash, pcm_sample_rate, pcm_channels`. The rest are kept because the upload path writes them as `NOT NULL`.

#### `announcements` — core 007, 014, 015, 031
Kept: `id, tenant_id (Type), name, type, audio_file_id, is_active, created_at, updated_at, account_id (Type)`.
What the abandon path reads (`findActiveByIdScoped`): `id, tenant_id, account_id, is_active, type, audio_file_id`.
Dropped:
- `tts_text`, `tts_voice`, `tts_language` (and 020's defaults). Decision 4 makes the clip an uploaded file only, so there is no TTS.
- `announcements_tts_check` (`type != 'tts' OR tts_text IS NOT NULL`). It references a dropped column.

Changed: the `type` CHECK is narrowed from `IN ('tts','audio')` to `IN ('audio')`. It keeps Postgres's auto-generated name, `announcements_type_check`. A `'tts'` row could never carry content now, and the resolver would only hit its `no_content` branch. See the open questions.

#### `call_analysis_profiles` — core 059
Kept: `id, tenant_id (Type), account_id (Type), name, description, context, custom_dimensions, language_hint, is_default, is_active, version, created_at, updated_at`. Dropped: none. Default `'default'` dropped from `account_id` (see the type changes).

#### `dialer_analysis_jobs` — core 059
Kept: `id, call_id, tenant_id (Type), account_id (Type), profile_id, profile_snapshot, analysis_language, status, attempts, attempts_total, claim_generation, claimed_at, heartbeat_at, next_attempt_at, analysis_audio_seconds, error_code, error_message, created_at, updated_at`.
Dropped (plan §4, settlement removed):
- `settlement_status`. It drove the credit-charge sweep.
- `settlement_attempts`. It was that sweep's retry counter.
- `settlement_pending_since`. It fed the settlement-age gauge.
- `ck_dialer_analysis_settlement`. It constrained `settlement_status`.
- `idx_dialer_analysis_jobs_settlement`. It was the sweep's index.

`analysis_audio_seconds` is kept for metering.
The call reference is **`call_id`** (the brief's "e.g. `webrtc_call_id`" — 059 named it `call_id`). It keeps `NOT NULL REFERENCES … ON DELETE CASCADE` and now points at `agency_calls(id)`. The FK's auto-generated name is unchanged: `dialer_analysis_jobs_call_id_fkey`.

#### `agency_campaigns` — core 072, 078, 080, 089, 108, 111, 115
Kept: `id, tenant_id (Type), account_id (Type), name, caller_ids, telephony_provider, calling_window_start, calling_window_end, calling_days, default_timezone, wrapup_seconds, wrapup_auto_return, retry_policy, disposition_catalog, record_calls, analysis_profile_id, context_display, status, contacts_total, created_by, started_at, completed_at, created_at, updated_at, break_reasons, abandon_announcement_id, abandonment_ceiling_pct, pause_reason, paused_at, pause_abandonment_rate_pct, ended_at, last_transition_by_user_id (Type), last_transition_by_name, parent_campaign_id, root_campaign_id, retry_generation, retry_selector, retry_idempotency_key`.
Dropped: `sip_connection_id` (072). It is the BYO-SIP-trunk egress selector, and plan §5 deletes the SIP branch (`resolveSipDial`). See open question 6.

#### `agency_contacts` — core 073, 082, 083, 085, 112
Kept: `id, campaign_id, tenant_id (Type), account_id (Type), phone_e164, context, source_row_number, timezone, state, attempt_count, last_outcome, last_disposition, next_attempt_at, suppressed_reason, created_at, updated_at, our_fault_attempts, row_fingerprint, csv_line_number, source_contact_id, root_contact_id`. Dropped: none. (`source_row_number` is legacy; see open question 11.)

#### `agency_agent_sessions` — core 074, 093
Kept: `id, tenant_id (Type), account_id (Type), campaign_id, agent_user_id (Type), state, break_reason, state_since, owner_replica, last_heartbeat, joined_at, left_at, created_at, updated_at`. Dropped: none.

#### `agency_agent_session_events` — core 105
Kept: `id, session_id, tenant_id (Type), account_id (Type), campaign_id, agent_user_id (Type), from_state, to_state, break_reason, at`. Dropped: none.

#### `agency_call_attempts` — core 075, 079, 088, 119
Kept: `id, campaign_id, contact_id, tenant_id (Type), account_id (Type), attempt_number, webrtc_call_id, caller_id, reserved_agent_id, state, outcome, disposition_code, notes, callback_at, dialed_at, answered_at, bridged_at, ended_at, talk_seconds, wrapup_seconds, created_at, updated_at, dispositioned_by_user_id (Type), dispositioned_at, dispositioned_on_behalf, wrapup_started_at, wrapup_ended_at, wrapup_resolution, abandon_reason`. Dropped: none. `webrtc_call_id` keeps its name and now holds an `agency_calls.id` (no FK, as in core).

#### `agency_ingest_chunks` — core 077, 084
Kept: `id, campaign_id, ingest_job_id, chunk_index, idempotency_key, chunk_count, row_count, applied_at, created_at, rejected_duplicate_rows, duplicate_source_rows`. Dropped: none.

#### `agency_dnc_outbox` — core 086, 087
Kept: `id, tenant_id (Type), phone_e164, reason, added_by, status, attempts, attempts_total, claim_generation, claimed_at, heartbeat_at, next_attempt_at, pending_since, landed_at, error_code, error_message, created_at, updated_at, campaign_id`. Dropped: none.

#### `agency_calls` (was core `webrtc_calls`) — core 047, 048, 059, 076
Kept: `id, tenant_id (Type), account_id (Type), caller_id, destination_phone, provider, provider_call_id, status, outcome, error_code, error_message, initiated_by, metadata, answered_at, ended_at, duration_seconds, talk_time_seconds, created_at, updated_at, recording_requested, recording_url, recording_duration_seconds, analysis_profile_id, analysis_language, analysis_status, call_analysis, conversation_log, transcript_meta, analysis_consent, analysis_consent_at, campaign_id, agency_attempt_id`.

Every kept column is read or written by the bridge (`webrtc-bridge-manager.ts`, `webrtc-bridge-session.ts`), the VoiceLink webhook, the stale-call sweep (`failStaleActive`), the analysis runner and job repository, or the agency module. Checked by grep.

Dropped:
- `sip_connection_id` (051). It is the BYO-SIP-trunk egress, and plan §5 deletes the SIP branch.
- `telephony_credential_id` (096/099/102). It names a tenant BYOC carrier credential (`credential-seam`, deleted by plan §5). Plan §4 replaces the recording fetcher's credential lookup with a VoiceLink host allow-list.

The table has no settlement or billing columns at source, so none were dropped for that reason. Settlement was keyed on the call row from outside.

### Every type change (VARCHAR/TEXT → UUID)

Core stored master's ids as `VARCHAR(100)`. Each of these columns is `UUID` in the baseline:

| Table | Columns |
|---|---|
| `agency_campaigns` | `tenant_id`, `account_id`, `last_transition_by_user_id` |
| `agency_contacts` | `tenant_id`, `account_id` |
| `agency_agent_sessions` | `tenant_id`, `account_id`, `agent_user_id` |
| `agency_agent_session_events` | `tenant_id`, `account_id`, `agent_user_id` |
| `agency_call_attempts` | `tenant_id`, `account_id`, `dispositioned_by_user_id` |
| `agency_dnc_outbox` | `tenant_id` |
| `agency_calls` | `tenant_id`, `account_id` |
| `dialer_analysis_jobs` | `tenant_id`, `account_id` |
| `call_analysis_profiles` | `tenant_id`, `account_id` |
| `account_settings` | `tenant_id`, `account_id` |
| `account_provider_concurrency_allocations` | `tenant_id`, `account_id` |
| `feature_flag_overrides` | `tenant_id`, `account_id` |
| `audio_files` | `tenant_id`, `account_id` |
| `announcements` | `tenant_id`, `account_id` |
| `audit_logs` | `tenant_id`, `account_id` |

Defaults removed as a consequence, because `'default'` is not a UUID: `DEFAULT 'default'` on `account_id` of `agency_campaigns` (072), `agency_calls` (047), `call_analysis_profiles` (059) and `dialer_analysis_jobs` (059). `audio_files`, `announcements` and `audit_logs` had already lost theirs in core 015. Every one stays `NOT NULL`.

Master's tables were already `UUID` and are unchanged.

**Deliberately not changed** (they are actor labels or opaque refs, not typed user ids at source). See open question 8:

- `agency_campaigns.created_by` (an originator *label*, `getOriginator`)
- `agency_calls.initiated_by` (agency writes the *session* id)
- `agency_dnc_outbox.added_by`, `dnc_entries.added_by` (any string ≤ 100 at source)
- `agency_ingest_jobs.created_by`
- `feature_flag_overrides.created_by` / `updated_by`
- `audit_logs.actor`
- `agency_ingest_chunks.ingest_job_id` (`VARCHAR(100)`, not an identity id)
- `platform_audit_log.campaign_id` (`TEXT`)

### Renamed objects (names that embedded `webrtc_calls`)

| Source name (core) | Baseline name |
|---|---|
| table `webrtc_calls` | `agency_calls` |
| `webrtc_calls_pkey` (implicit) | `agency_calls_pkey` |
| `trg_webrtc_calls_updated_at` | `trg_agency_calls_updated_at` |
| `idx_webrtc_calls_tenant` | `idx_agency_calls_tenant` |
| `idx_webrtc_calls_active` | `idx_agency_calls_active` |
| `idx_webrtc_calls_provider_call_id` | `idx_agency_calls_provider_call_id` |
| `idx_webrtc_calls_analysis_status` | `idx_agency_calls_analysis_status` |
| `idx_webrtc_calls_tenant_dialer` (106) | not carried (softphone only) |

These names contain `webrtc` but not `webrtc_calls`, so they are **kept verbatim**:

- `ck_webrtc_status` and `ck_webrtc_analysis_status` on `agency_calls`
- the column `agency_call_attempts.webrtc_call_id`, and its index `idx_agency_attempts_webrtc`

### Other renamed or replaced objects (end-state folds, not baseline choices)

- `uq_agency_agent_live` (074) → `uq_agency_agent_live_tenant` (093)
- `uq_agency_campaign_agent_active` (master 060) → `uq_agency_campaign_agent_active_campaign` (064)
- `accounts_tenant_id_slug_key` (master 001) → `idx_accounts_tenant_slug_active` (025)
- `audio_files_tenant_id_name_key` (core 007) → `audio_files_tenant_account_name_key` (014)

---

## 3. Triggers and functions

22 triggers, all asserted by name and by firing.

| Trigger | Table | Function | Source |
|---|---|---|---|
| `tenants_updated_at` | `tenants` | `update_updated_at()` | master 001 |
| `accounts_updated_at` | `accounts` | 〃 | master 001 |
| `users_updated_at` | `users` | 〃 | master 001 |
| `memberships_updated_at` | `memberships` | 〃 | master 001 |
| `trg_telephony_providers_updated` | `telephony_providers` | 〃 | master 010 |
| `trg_phone_numbers_updated` | `phone_numbers` | 〃 | master 010 |
| `user_notification_preferences_updated_at` | `user_notification_preferences` | 〃 | master 072 |
| `dnc_sync_state_updated_at` | `dnc_sync_state` | 〃 | master 054 |
| `agency_ingest_jobs_updated_at` | `agency_ingest_jobs` | 〃 | master 053 |
| `agency_campaign_agents_updated_at` | `agency_campaign_agents` | 〃 | master 060 |
| `set_feature_flag_overrides_updated_at` | `feature_flag_overrides` | 〃 | core 046 |
| `audio_files_updated_at` | `audio_files` | 〃 | core 007 |
| `announcements_updated_at` | `announcements` | 〃 | core 007 |
| `trg_analysis_profiles_updated_at` | `call_analysis_profiles` | 〃 | core 059 |
| `trg_dialer_analysis_jobs_updated_at` | `dialer_analysis_jobs` | 〃 | core 059 |
| `trg_agency_campaigns_updated_at` | `agency_campaigns` | 〃 | core 072 |
| `trg_agency_contacts_updated_at` | `agency_contacts` | 〃 | core 073 |
| `trg_agency_agent_sessions_updated_at` | `agency_agent_sessions` | 〃 | core 074 |
| `trg_agency_call_attempts_updated_at` | `agency_call_attempts` | 〃 | core 075 |
| `trg_agency_dnc_outbox_updated_at` | `agency_dnc_outbox` | 〃 | core 086 |
| `trg_agency_calls_updated_at` | `agency_calls` | 〃 | core 047 (renamed) |
| `trg_agency_contacts_root` (BEFORE INSERT) | `agency_contacts` | `agency_contact_stamp_root()` | core 112 |

Functions:

- `update_updated_at()` — core 001 and master 001 define it with the same body, under the same name.
- `agency_contact_stamp_root()` — core 112.
- `agency_contact_row_fingerprint(VARCHAR, JSONB, VARCHAR)` — core 083. It is a function only: **083 has no trigger**. The ingest INSERT calls it. See open question 2.

Extension: `uuid-ossp`, for `uuid_generate_v4()`. Core 003 (`audit_logs`) and core 007 (`audio_files`, `announcements`) use it as a default. `super_admins` and `account_settings` have `updated_at` columns but no trigger at source, and none was added.

---

## 4. Tests

`pnpm test:integration` runs `test/integration/baseline.test.ts`, `baseline-down-up.test.ts` and the shared factories in `fixtures.ts`. Assertions ported from the source suites:

| Source test | Ported as |
|---|---|
| core `test/integration/agency/agency-migration.test.ts` T-M1, T-M1b, T-M1c, T-M2…T-M2e, T-M3…T-M3c, T-M4b, T-M7 | table set, back-reference nullability, column shapes, state CHECKs, JSONB guards, cascades, ingest UNIQUE, `updated_at` firing (widened to all 21 `updated_at` triggers, with backdated rows so the assertion cannot pass vacuously) |
| core `test/integration/agency/agency-duplicate-dial.test.ts` T-D1/T-D2/T-D3/T-D3b, T-M5, T-M6 | `uq_agency_attempt_live` (all 25 live-state pairs + exact `indexdef`), `uq_agency_campaign_running`, `uq_agency_agent_live_tenant` |
| core `test/integration/agency/agency-retry-seeding.test.ts` "migration 112/113 lineage columns" | trigger stamps `root_contact_id = id`; the 113 predicate matches 0 rows (`rowCount`) |
| core `test/unit/agency/retry-lineage-migrations.test.ts` (111/112/114) | catalog facts: FKs on the pointers, none on the grouping keys, nullable defaultless lineage columns, `retry_generation` default 0, root index neither partial nor covering; supplied root left alone |
| core `test/integration/agency/agency-dnc-campaign-scope.test.ts` T-DNC8 | outbox `campaign_id` nullable; digit-projection index expression |
| core `test/integration/db/dialer-analysis-migration.test.ts` | one job per call, status CHECKs, cascade from `agency_calls`, profile partial uniques |
| core `test/integration/db/audio-file-pcm-migration.test.ts` | PCM columns nullable, typed, unindexed |
| master `test/integration/repositories/agency-campaign-agents-schema.test.ts` | 064 index definition, 060 index gone, per-campaign rule, closed rows accumulate |
| master `test/integration/dnc/dnc-index-usage.test.ts` "guards the guard" | the three DNC indexes exist |

New assertions:

- exactly one of each up/down marker;
- UUID typing and the dropped defaults;
- the excluded columns are absent;
- no `webrtc_calls` names remain;
- enum values and order;
- the fingerprint function;
- every other unique index;
- audit partition sets and routing for both audit tables;
- Down then Up through node-pg-migrate's `runner`, comparing a full object inventory (relations, functions, enum types, triggers, extensions) before and after;
- the single seed row.

The test helpers (`test/helpers/*`) were not changed and worked as written. One thing to know: `truncateAll` empties `telephony_providers`, so the seed row is asserted only in `baseline-down-up.test.ts`, straight after its own fresh `up`.

---

## 5. Open questions for the lead

1. **`uq_agency_agent_live` is not in the end state.** agency.md §2 lists it as one of the six load-bearing constraints. Core 093 dropped it and replaced it with `uq_agency_agent_live_tenant (tenant_id, agent_user_id) WHERE left_at IS NULL`. Core's code (`joinOrRehydrate`'s `ON CONFLICT`) and tests (`agency-duplicate-dial.test.ts` T-M6) use the tenant index. The tenant index is strictly stronger, since a campaign belongs to one tenant. The baseline carries the tenant index only, and the test asserts the per-campaign one is absent. **agency.md §2 is stale here.**
2. **"The 083 row-fingerprint function/trigger".** 083 defines a function and no trigger. The fingerprint is written by the ingest INSERT calling the function. The function is tested (definition, NOT STRICT, STABLE, collision behaviour); there is no trigger to test.
3. **`'vobiz'` defaults kept verbatim** on `agency_campaigns.telephony_provider` and `agency_calls.provider`. Agency dials VoiceLink only. Recommend changing both defaults to `'voicelink'`, or dropping the default so that the code must always say.
4. **`telephony_providers` seed.** The baseline seeds only `voicelink`, so `phone_numbers.provider_id` has something to point at. Confirm. The alternative is a super-admin "add provider" step. At cutover, master's provider ids have to be mapped to it.
5. **Analysis toggle.** `account_settings.analyze_dialer_calls` is carried as the brief asked. However, core's bridge skips this gate for agency calls (`webrtc-bridge-manager.ts:2149`: "Gate 3 is skipped for agency calls"), and nothing writes it. It may be dead in agency. Decide before lane A builds the settings UI.
6. **`agency_campaigns.sip_connection_id` dropped.** It is a SIP column, and plan §5 deletes `resolveSipDial`. Lane B's port must remove its reads and writes in `agency.repository.ts`, `agency-dialer.ts` and `retry-campaign-bounds.ts`. Confirm the drop rather than carrying a dead NULL column.
7. **`announcements.type` narrowed to `'audio'`.** This follows from decision 4. At cutover, any campaign whose `abandon_announcement_id` points at a core TTS announcement either needs the clip rendered to a file and uploaded, or the id set to NULL (the campaign then hangs up silently). Otherwise the copy fails the CHECK. The `abandon-clip.ts` port should delete the TTS branch.
8. **Actor-label columns kept as text** (list in §2). Most notably, `dnc_entries.added_by` and `agency_dnc_outbox.added_by` are documented as "master's user id" (`dnc-mark.ts:244`). However, master's validator accepts any string up to 100 characters, and the S2S fixture uses `"user-agent-1"`. Recommend `UUID` once the cutover pre-check shows every value parses. `agency_calls.initiated_by` holds a session id, which is a UUID but not a user id. Also consider `agency_ingest_chunks.ingest_job_id` → `UUID`: it is now always an in-process `agency_ingest_jobs.id`.
9. **FK candidates.** None were added. The sources kept these columns un-FK'd only because they lived in two databases:
   - `agency_ingest_jobs.campaign_id`, `agency_campaign_agents.campaign_id` and `dnc_entries.campaign_id` → `agency_campaigns(id)`. Pick `ON DELETE` per table: staffing/ingest probably CASCADE; DNC must **not** cascade, because the record outlives the campaign.
   - `agency_ingest_chunks.ingest_job_id` → `agency_ingest_jobs(id)` (needs the UUID change in question 8).
   - `agency_agent_sessions.agent_user_id`, `agency_agent_session_events.agent_user_id` and `agency_call_attempts.dispositioned_by_user_id` → `users(id)`.
   - `tenant_id` / `account_id` on the core-side tables → `tenants` / `accounts`. In particular: `account_settings` (CASCADE), `agency_campaigns` (RESTRICT), `call_analysis_profiles`, `audio_files`, `announcements`, `feature_flag_overrides`.

   **Not recommended**, because the source records a deliberate "no FK" for each:
   - `agency_call_attempts.webrtc_call_id`
   - `agency_calls.campaign_id` / `agency_attempt_id`
   - `agency_campaigns.abandon_announcement_id` and `analysis_profile_id`
   - `dialer_analysis_jobs.profile_id`
   - `root_*` grouping keys
   - `agency_dnc_outbox.campaign_id`
   - `membership_invites.claimed_by_user_id` / `invited_by`
   - `audit_logs.call_id`
10. **Cross-service plumbing carried as-is.** `agency_dnc_outbox` (core→master DNC forward) and `dnc_sync_state` (master→core Redis publish watermark) both exist to bridge two databases. Plan §1 collapses DNC into "one table, one transactional write". Both are carried because the brief requires the 086 trigger and master 054. They are probably needed only for the rollback-window mirror to master (plan §8). Decide whether lanes port their sweepers.
11. **Legacy `source_row_number` + `uq_agency_contacts_source_row`.** Core keeps both only until no pre-083 replica can serve traffic. That condition can never arise in agency, so the baseline could do core's "phase 3" drop now. They are kept to match the end state and so cutover can copy historic values. Recommend dropping them in a follow-up once cutover has decided whether to keep those values. Note core's comment warns that the fingerprint index must become partial on liveness before any roster-replace feature lands.
12. **Stale source comments, kept verbatim.** Several comments describe two services and billing:
    - `agency_calls.campaign_id`: "selects the agency billing rate"
    - `idx_agency_attempts_billing`: "hourly … billing sweep"
    - `agency_campaigns`: "lives in magick-master"
    - the various "opaque to core" / "master user id" notes
    - `platform_audit_log.actor_type`: mentions `api_key_id`, which is not carried

    Recommend one doc-only follow-up migration that rewrites them, so the port stays verbatim now.
13. **`api_key_id` not carried.** Master rows copied at cutover with `actor_type = 'api_key'` lose the key id. Recommend that the cutover script fold it into `details`.
14. **`users.phone_number NOT NULL DEFAULT '0000000000'`** is carried verbatim (master 008's placeholder). Confirm agency still wants it.
15. **No super-admin seed.** Lane A needs a bootstrap path (script or env-seeded first admin) to create the first `super_admins` row (decision 6).
16. **Partition maintenance** for both audit tables is a lane-A runtime job. The window ends 2027-12. After that, rows land in the DEFAULT partitions, which still accept them. A month whose rows are already in DEFAULT cannot be attached as a partition until those rows are moved.
17. **The two audit tables differ in shape**, verbatim from source: `ip_address` is `TEXT` in `platform_audit_log` and `INET` in `audit_logs`; the timestamp column is `created_at` in one and `timestamp` in the other. The merged activity-trail query must handle both.
18. **Master 048 provider-concurrency entitlements are not carried.** Agency is both the system of record and the enforcer. The super-admin "concurrency limits" screen (plan §3.4) should write `account_settings` and `account_provider_concurrency_allocations` directly. Confirm.

## 6. Lead resolutions (2026-10-08)

| Open question | Resolution |
|---|---|
| `'vobiz'` defaults | Changed to `'voicelink'` on `agency_campaigns.telephony_provider` and `agency_calls.provider` (VoiceLink is the only carrier, plan §5). Pinned by a test. |
| `agency_campaigns.sip_connection_id` | Dropped, as carried. SIP deletion is a plan-allowed change; lanes remove its reads/writes and record them. |
| Announcements narrowed to `'audio'` | Accepted (decision #4 default: uploaded clip only). Cutover must map TTS clips; noted for Phase 10. |
| `analyze_dialer_calls` | Dropped (decisions Q3b). |
| `dnc_sync_state` | Dropped (decision B8). `agency_dnc_outbox` kept for the rollback-window mirror. |
| `added_by` / `ingest_job_id` to UUID | Left as source types; revisit with the cutover pre-check. |
| New foreign keys | None in the baseline; candidates recorded above for after cutover data is measured. |
| `source_row_number` | Kept (verbatim; legacy, not written). |
| Stale billing / "core vs master" comments | Kept verbatim. |
| Super-admin bootstrap | Lane A ships a CLI to create the first super-admin (no seeded credentials). |
| Partition maintenance | Lane A runtime job (platform_audit_log and audit_logs). |
