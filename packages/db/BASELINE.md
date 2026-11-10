# Baseline schema — `migrations/0001_baseline.sql`

The database schema of Magick Agency is the baseline migration plus the numbered migrations listed
under [Later migrations](#later-migrations). This file is their inventory: the rules
they follow, every table with its purpose and columns, the unique indexes that carry invariants, the
triggers and functions, how it is tested, and the schema questions still open. Read it before
writing a repository, a migration or an import script. Column lists are generated from the SQL;
the SQL is the authority. As of 2026-11-09.

## Rules

- **One file, one transaction.** node-pg-migrate splits SQL files on
  `/^\s*--[\s-]*(up|down)\s+migration/im`; the file has exactly one of each marker, and a test
  asserts that. Later schema changes go in new numbered migrations; never edit an applied one.
- **Ids.** Every tenant, account and user id column is `UUID`. Free-form actor labels (for example
  `dnc_entries.added_by`, `agency_dnc_outbox.added_by`, `agency_calls.initiated_by`) are text.
- **Foreign keys** only where the table pairs need them; see the open questions for candidates.
- **Seed.** One reference row, `telephony_providers ('voicelink', 'VoiceLink')`. No super-admin.
  (0002 adds `plivo`, inactive; 0019 activates it; see below.)
- **Extension** `uuid-ossp` for `uuid_generate_v4()` defaults (`audit_logs`, `audio_files`,
  `announcements`); other ids use the built-in `gen_random_uuid()`.

## Tables

33 tables in the baseline (35 with 0002, 37 with 0005, 38 with 0009, 43 with 0012, 44 with 0013, 45 with 0018, 47 with 0023, 50 with 0024), plus monthly partitions 2026-01 to 2027-12 and a DEFAULT partition for each of the two audit tables.

| Group | Tables |
|---|---|
| Identity | `tenants`, `accounts`, `users`, `memberships`, `membership_invites`, `super_admins`, `super_admin_audit_log` |
| Phone inventory | `telephony_providers`, `phone_numbers`, `tenant_phone_assignments`, `phone_account_tags` |
| Notifications | `user_notification_preferences`, `notification_deliveries` |
| Audit | `platform_audit_log`, `audit_logs` |
| Campaign management | `dnc_entries`, `agency_ingest_jobs`, `agency_campaign_agents` |
| Settings, guard and flags | `account_settings`, `account_provider_concurrency_allocations`, `feature_flag_overrides` |
| Clips | `audio_files`, `announcements` |
| Analysis | `call_analysis_profiles`, `dialer_analysis_jobs` |
| Dialer | `agency_campaigns`, `agency_contacts`, `agency_agent_sessions`, `agency_agent_session_events`, `agency_call_attempts`, `agency_ingest_chunks`, `agency_dnc_outbox`, `agency_calls` |
| Insights rollup (0012) | `agency_insights_rollup_dirty`, `agency_insights_rollup_buckets`, `agency_insights_rollup_agents`, `agency_insights_rollup_codes`, `agency_insights_rollup_facets` |
| Pacing history (0013) | `agency_campaign_pacing_minutes` |
| Inbound calls (0024) | `agency_inbound_routes`, `agency_inbound_route_numbers`, `agency_inbound_calls` |

### Identity

**`tenants`**. A customer organisation.

Columns: `id`, `name`, `slug`, `settings`, `status`, `created_at`, `updated_at`.

**`accounts`**. An account (workspace) inside a tenant. Slug unique per tenant among active accounts (`idx_accounts_tenant_slug_active`).

Columns: `id`, `tenant_id`, `name`, `slug`, `settings`, `status`, `created_at`, `updated_at`.

**`users`**. A person, linked to Firebase by `firebase_uid`. `email_unverified` marks an address that no lookup by email may bind. `phone_number` has a placeholder default `'0000000000'`.

Columns: `id`, `firebase_uid`, `email`, `display_name`, `avatar_url`, `status`, `created_at`, `updated_at`, `phone_number`, `email_unverified`.

**`memberships`**. A user's role in a tenant, optionally scoped to one account. Revoked rows are kept (`status = 'revoked'`).

Columns: `id`, `user_id`, `tenant_id`, `account_id`, `role`, `status`, `invited_by`, `created_at`, `updated_at`.

**`membership_invites`**. An invite to a membership: sha256 `token_hash`, expiry, claim and revoke.

Columns: `id`, `membership_id`, `tenant_id`, `email`, `role`, `token_hash`, `expires_at`, `claimed_at`, `claimed_by_user_id`, `revoked_at`, `invited_by`, `created_at`.

**`super_admins`**. Super-admin accounts (own login, bcrypt hash). `is_system` admins cannot be removed. No seed row: create the first with `apps/server/scripts/create-super-admin.ts`.

Columns: `id`, `email`, `password_hash`, `name`, `status`, `created_at`, `updated_at`, `is_system`.

**`super_admin_audit_log`**. Every super-admin action.

Columns: `id`, `admin_id`, `admin_email`, `action`, `resource_type`, `resource_id`, `details`, `created_at`.

### Phone inventory

**`telephony_providers`**. Carrier providers. Seeded with one row, `('voicelink', 'VoiceLink')`.

Columns: `id`, `name`, `display_name`, `status`, `created_at`, `updated_at`.

**`phone_numbers`**. The phone-number inventory: numbers on the service's own VoiceLink account (added by a super-admin), and, from 0019, numbers synced from a tenant's own carrier account (`telephony_credential_id`).

Columns: `id`, `phone_number`, `provider_id`, `label`, `capabilities`, `region`, `max_concurrent_calls`, `status`, `notes`, `created_by`, `created_at`, `updated_at`, `pool_eligible`.

**`tenant_phone_assignments`**. Numbers assigned to tenants.

Columns: `id`, `tenant_id`, `phone_number_id`, `is_default`, `assigned_by`, `assigned_at`.

**`phone_account_tags`**. Account tags and defaults on an assignment.

Columns: `id`, `assignment_id`, `account_id`, `is_default`, `tagged_by`, `tagged_at`.

### Notifications

**`user_notification_preferences`**. Per-user overrides of the notification catalog.

Columns: `id`, `user_id`, `tenant_id`, `event_key`, `channel`, `enabled`, `frequency`, `created_at`, `updated_at`.

**`notification_deliveries`**. Claim-before-send ledger: one row per notification and recipient, so an at-least-once trigger sends one mail. `tenant_id` is in the unique key, so a person in two tenants gets both.

Columns: `id`, `event_key`, `dedupe_key`, `recipient`, `tenant_id`, `account_id`, `status`, `error`, `sent_at`, `created_at`.

### Audit

**`platform_audit_log`**. Console and admin actions (the "Console" half of the activity trail). Monthly partitions plus a DEFAULT partition. `ip_address` is `TEXT`; the timestamp column is `created_at`. Partitioned `PARTITION BY RANGE (created_at)`.

Columns: `id`, `tenant_id`, `user_id`, `action`, `resource_type`, `resource_id`, `details`, `ip_address`, `created_at`, `account_id`, `campaign_id`, `actor_type`.

**`audit_logs`**. Dialer events (the "Dialer" half). Monthly partitions plus a DEFAULT partition. `ip_address` is `INET`; the timestamp column is `timestamp`. `call_id` has no FK. Partitioned `PARTITION BY RANGE (timestamp)`.

Columns: `id`, `call_id`, `tenant_id`, `event_type`, `event_category`, `severity`, `event_data`, `request_id`, `actor`, `ip_address`, `timestamp`, `duration_ms`, `account_id`.

### Campaign management

**`dnc_entries`**. The DNC list, scoped to a tenant, an account or a campaign (decision B8).

Columns: `id`, `tenant_id`, `account_id`, `campaign_id`, `phone_e164`, `source`, `reason`, `added_by`, `created_at`.

**`agency_ingest_jobs`**. CSV roster ingest jobs: the S3 object, column mapping, progress counters, rejected-rows export, status and errors. 0007 adds `dedupe_column` (the column whose value marks a duplicate row; see below), superseded by 0031's `dedupe_columns` (up to three columns combined).

Columns: `id`, `tenant_id`, `account_id`, `campaign_id`, `s3_key`, `file_name`, `file_size_bytes`, `phone_column`, `timezone_column`, `ignore_columns`, `default_country_code`, `dedupe_phones`, `dry_run`, `status`, `cancel_requested`, `rows_read`, `accepted`, `rejected`, `duplicates`, `rejected_by_reason`, `bytes_read`, `chunks_sent`, `chunks_total`, `headers`, `context_columns`, `rejected_s3_key`, `rejected_row_count`, `rejected_truncated`, `error_code`, `error_message`, `created_by`, `created_at`, `started_at`, `finished_at`, `updated_at`, `core_rejected_duplicate_rows`, `core_duplicate_source_rows`, `core_rejected_duplicate_rows_may_undercount`, `mode`, `replace_superseded_contacts`, `replace_superseded_uncertain`.

**`agency_campaign_agents`**. Staffing: which agents are assigned to which campaign, and when.

Columns: `id`, `tenant_id`, `account_id`, `campaign_id`, `user_id`, `assigned_by`, `assigned_at`, `unassigned_at`, `created_at`, `updated_at`.

**`agency_campaign_agent_caller_ids`** (0018). Dedicated caller IDs: one of a campaign's caller IDs given to an agent, so every dial to a contact they own on it goes out from that number (see below).

Columns: `id`, `tenant_id`, `account_id`, `campaign_id`, `user_id`, `caller_id`, `set_by_user_id`, `set_at`.

### Settings, guard and flags

**`account_settings`**. Per-account settings: `max_concurrent_calls`, `analyze_calls`, `allow_recording` (no row or NULL = off; the column comment saying NULL inherits true is superseded, see `docs/decisions.md` §4, 2026-10-10), `webrtc_max_duration_seconds` (NULL = process default; CHECK `> 0`), and the concurrency allocation mode and version.

Columns: `id`, `tenant_id`, `account_id`, `max_concurrent_calls`, `created_at`, `updated_at`, `analyze_calls`, `allow_recording`, `concurrency_allocation_mode`, `concurrency_allocation_version`, `webrtc_max_duration_seconds`.

**`account_provider_concurrency_allocations`**. Per-provider concurrency allocations for an account. Composite FK to `account_settings (tenant_id, account_id) ON DELETE RESTRICT`.

Columns: `id`, `tenant_id`, `account_id`, `telephony_provider`, `max_concurrent_calls`, `created_at`, `updated_at`.

**`feature_flag_overrides`**. Super-admin flag overrides by scope (global, tenant, account), with reason and expiry.

Columns: `id`, `flag_key`, `scope_type`, `tenant_id`, `account_id`, `value`, `reason`, `expires_at`, `created_by`, `updated_by`, `created_at`, `updated_at`.

### Clips

**`audio_files`**. Uploaded audio (abandon clips): S3 key, content type, and the PCM cache hash, rate and channels.

Columns: `id`, `tenant_id`, `name`, `slug`, `original_filename`, `content_type`, `size_bytes`, `s3_key`, `duration_seconds`, `created_at`, `updated_at`, `account_id`, `pcm_audio_hash`, `pcm_sample_rate`, `pcm_channels`.

**`announcements`**. A named clip pointing at an audio file. `type` is CHECKed to `'audio'` only (no TTS).

Columns: `id`, `tenant_id`, `name`, `type`, `audio_file_id`, `is_active`, `created_at`, `updated_at`, `account_id`.

### Analysis

**`call_analysis_profiles`**. Analysis profiles: context, custom dimensions, language hint, default and active flags, version.

Columns: `id`, `tenant_id`, `account_id`, `name`, `description`, `context`, `custom_dimensions`, `language_hint`, `is_default`, `is_active`, `version`, `created_at`, `updated_at`.

**`dialer_analysis_jobs`**. One analysis job per call: profile snapshot, status machine, attempt counters, `claim_generation` fencing, heartbeat, `analysis_audio_seconds`. Cascades from `agency_calls`.

Columns: `id`, `call_id`, `tenant_id`, `account_id`, `profile_id`, `profile_snapshot`, `analysis_language`, `status`, `attempts`, `attempts_total`, `claim_generation`, `claimed_at`, `heartbeat_at`, `next_attempt_at`, `analysis_audio_seconds`, `error_code`, `error_message`, `created_at`, `updated_at`.

### Dialer

**`agency_campaigns`**. A campaign: caller IDs, calling window and days, timezone, wrap-up, retry policy, disposition catalog, recording, analysis profile, context display, status, break reasons, abandon announcement, abandonment ceiling and pause reason, retry lineage. `telephony_provider` defaults to `'voicelink'`. The baseline allows one running campaign per account (`uq_agency_campaign_running`); 0015 drops that index, so an account may run several (see below). 0008 adds `allow_wrapup_redial` (the wrap-up redial setting, off by default; see below). 0009 adds the contact-assignment and agent-retry settings (see below). 0019 lets `pause_reason` be `carrier_auth`, 0020 `carrier_account_unavailable`, 0021 `carrier_refusing_calls`.

Columns: `id`, `tenant_id`, `account_id`, `name`, `caller_ids`, `telephony_provider`, `calling_window_start`, `calling_window_end`, `calling_days`, `default_timezone`, `wrapup_seconds`, `wrapup_auto_return`, `retry_policy`, `disposition_catalog`, `record_calls`, `analysis_profile_id`, `context_display`, `status`, `contacts_total`, `created_by`, `started_at`, `completed_at`, `created_at`, `updated_at`, `break_reasons`, `abandon_announcement_id`, `abandonment_ceiling_pct`, `pause_reason`, `paused_at`, `pause_abandonment_rate_pct`, `ended_at`, `last_transition_by_user_id`, `last_transition_by_name`, `parent_campaign_id`, `root_campaign_id`, `retry_generation`, `retry_selector`, `retry_idempotency_key`.

**`agency_contacts`**. Roster contacts: E.164 phone, context, timezone, state, attempt counts, last outcome and disposition, next attempt, DNC suppression, row fingerprint, and retry lineage (`source_contact_id`, `root_contact_id`). `source_row_number` is a legacy column, not written. 0011 adds `dials_placed` (every placed dial, kept by a trigger on `agency_call_attempts`; see below).

Columns: `id`, `campaign_id`, `tenant_id`, `account_id`, `phone_e164`, `context`, `source_row_number`, `timezone`, `state`, `attempt_count`, `last_outcome`, `last_disposition`, `next_attempt_at`, `suppressed_reason`, `created_at`, `updated_at`, `our_fault_attempts`, `row_fingerprint`, `csv_line_number`, `source_contact_id`, `root_contact_id`.

**`agency_agent_sessions`**. An agent's session on a campaign: state mirror, break reason, owning replica, heartbeat. One live session per agent per tenant (`uq_agency_agent_live_tenant`). 0005 adds `kind` and makes `campaign_id` nullable (a soft-phone session; see below). 0006 adds `client_kind` (`web | mobile`, the app the station last attached from).

Columns: `id`, `tenant_id`, `account_id`, `campaign_id`, `agent_user_id`, `state`, `break_reason`, `state_since`, `owner_replica`, `last_heartbeat`, `joined_at`, `left_at`, `created_at`, `updated_at`, `kind`, `client_kind`.

**`agency_agent_session_events`**. Agent state transitions, for seat-time reporting. `campaign_id` is nullable since 0005.

Columns: `id`, `session_id`, `tenant_id`, `account_id`, `campaign_id`, `agent_user_id`, `from_state`, `to_state`, `break_reason`, `at`.

**`agency_call_attempts`**. One row per dial: reserved agent, state, outcome, disposition, callback, `dialed_at` / `answered_at` / `bridged_at` / `ended_at`, talk and wrap-up seconds. One live attempt per contact (`uq_agency_attempt_live`). 0008 adds `redial_of_attempt_id` and `redial_number` (the wrap-up redial chain, one redial per attempt by `uq_agency_attempt_redial_of`) and `redialed` to `ck_agency_wrapup_resolution` (see below). 0011 adds `agent_reopened` (see below).

`outcome` has no CHECK; its vocabulary is `AgencyAttemptOutcome` (`packages/contracts/src/agency/enums.ts`): `connected`, `no_answer`, `busy`, `failed`, `machine`, `invalid`, `abandoned`, `agent_disconnected`, `orphaned`, `canceled`. **The trailing comment on the column in `0001_baseline.sql` is stale** (`connected|no_answer|busy|failed|machine|invalid|abandoned`): it omits `agent_disconnected`, `orphaned` and `canceled`, all produced, and lists `machine`, which nothing produces while answering-machine detection is out of scope. The migration is applied and is not edited; this paragraph and the union are the vocabulary.

Columns: `id`, `campaign_id`, `contact_id`, `tenant_id`, `account_id`, `attempt_number`, `webrtc_call_id`, `caller_id`, `reserved_agent_id`, `state`, `outcome`, `disposition_code`, `notes`, `callback_at`, `dialed_at`, `answered_at`, `bridged_at`, `ended_at`, `talk_seconds`, `wrapup_seconds`, `created_at`, `updated_at`, `dispositioned_by_user_id`, `dispositioned_at`, `dispositioned_on_behalf`, `wrapup_started_at`, `wrapup_ended_at`, `wrapup_resolution`, `abandon_reason`, `wrapup_resolution`.

**`agency_ingest_chunks`**. Idempotent roster chunks applied by an ingest job.

Columns: `id`, `campaign_id`, `ingest_job_id`, `chunk_index`, `idempotency_key`, `chunk_count`, `row_count`, `applied_at`, `created_at`, `rejected_duplicate_rows`, `duplicate_source_rows`.

**`agency_dnc_outbox`**. Reserved for mirroring DNC changes to the previous platform during a launch rollback window. Nothing writes it (decision B8).

Columns: `id`, `tenant_id`, `phone_e164`, `reason`, `added_by`, `status`, `attempts`, `attempts_total`, `claim_generation`, `claimed_at`, `heartbeat_at`, `next_attempt_at`, `pending_since`, `landed_at`, `error_code`, `error_message`, `created_at`, `updated_at`, `campaign_id`.

**`agency_calls`**. A bridged call: carrier ids, status and outcome, timings, recording, analysis status and result, conversation log, transcript metadata. `provider` defaults to `'voicelink'`.

Columns: `id`, `tenant_id`, `account_id`, `caller_id`, `destination_phone`, `provider`, `provider_call_id`, `status`, `outcome`, `error_code`, `error_message`, `initiated_by`, `metadata`, `answered_at`, `ended_at`, `duration_seconds`, `talk_time_seconds`, `created_at`, `updated_at`, `recording_requested`, `recording_url`, `recording_duration_seconds`, `analysis_profile_id`, `analysis_language`, `analysis_status`, `call_analysis`, `conversation_log`, `transcript_meta`, `analysis_consent`, `analysis_consent_at`, `campaign_id`, `agency_attempt_id`, `status`, `analysis_status`.

0002 adds `telephony_credential_id` and `provider_request_id`; 0005 adds `origin` and `manual_call_id`.

## Unique indexes

| Index | Table |
|---|---|
| `idx_accounts_tenant_slug_active` | `accounts` |
| `idx_memberships_user_tenant_level` | `memberships` |
| `uq_membership_invites_live` | `membership_invites` |
| `idx_tenant_phone_default` | `tenant_phone_assignments` |
| `idx_phone_account_default` | `phone_account_tags` |
| `uq_notification_deliveries_claim` | `notification_deliveries` |
| `uq_dnc_scope` | `dnc_entries` |
| `uq_agency_campaign_agent_active_campaign` | `agency_campaign_agents` |
| `uq_ff_global` | `feature_flag_overrides` |
| `uq_ff_tenant` | `feature_flag_overrides` |
| `uq_ff_account` | `feature_flag_overrides` |
| `idx_announcements_tenant_name_active` | `announcements` |
| `uq_analysis_profiles_name` | `call_analysis_profiles` |
| `uq_analysis_profiles_default` | `call_analysis_profiles` |
| `uq_agency_campaign_running` (dropped by 0015) | `agency_campaigns` |
| `uq_agency_campaign_retry_idempotency` | `agency_campaigns` |
| `uq_agency_contacts_source_row` | `agency_contacts` |
| `uq_agency_contacts_row_fingerprint` | `agency_contacts` |
| `uq_agency_agent_live_tenant` | `agency_agent_sessions` |
| `uq_agency_attempt_number` | `agency_call_attempts` |
| `uq_agency_attempt_live` | `agency_call_attempts` |
| `uq_agency_ingest_chunk` | `agency_ingest_chunks` |
| `uq_dialer_analysis_jobs_call` | `dialer_analysis_jobs` |
| `uq_agency_manual_call_unsettled` (0005) | `agency_manual_calls` |
| `uq_agency_softphone_settings_account` (0005) | `agency_softphone_settings` |
| `uq_agency_attempt_redial_of` (0008) | `agency_call_attempts` |
| `uq_agency_agent_caller_id_agent` (0018) | `agency_campaign_agent_caller_ids` |
| `uq_agency_agent_caller_id_number` (0018) | `agency_campaign_agent_caller_ids` |

## Triggers and functions

| Trigger | When | Table | Function |
|---|---|---|---|
| `tenants_updated_at` | BEFORE UPDATE | `tenants` | `update_updated_at()` |
| `accounts_updated_at` | BEFORE UPDATE | `accounts` | `update_updated_at()` |
| `users_updated_at` | BEFORE UPDATE | `users` | `update_updated_at()` |
| `memberships_updated_at` | BEFORE UPDATE | `memberships` | `update_updated_at()` |
| `trg_telephony_providers_updated` | BEFORE UPDATE | `telephony_providers` | `update_updated_at()` |
| `trg_phone_numbers_updated` | BEFORE UPDATE | `phone_numbers` | `update_updated_at()` |
| `user_notification_preferences_updated_at` | BEFORE UPDATE | `user_notification_preferences` | `update_updated_at()` |
| `agency_ingest_jobs_updated_at` | BEFORE UPDATE | `agency_ingest_jobs` | `update_updated_at()` |
| `agency_campaign_agents_updated_at` | BEFORE UPDATE | `agency_campaign_agents` | `update_updated_at()` |
| `set_feature_flag_overrides_updated_at` | BEFORE UPDATE | `feature_flag_overrides` | `update_updated_at()` |
| `audio_files_updated_at` | BEFORE UPDATE | `audio_files` | `update_updated_at()` |
| `announcements_updated_at` | BEFORE UPDATE | `announcements` | `update_updated_at()` |
| `trg_analysis_profiles_updated_at` | BEFORE UPDATE | `call_analysis_profiles` | `update_updated_at()` |
| `trg_agency_campaigns_updated_at` | BEFORE UPDATE | `agency_campaigns` | `update_updated_at()` |
| `trg_agency_contacts_updated_at` | BEFORE UPDATE (0011: WHEN not the `dials_placed` counter's nested update) | `agency_contacts` | `update_updated_at()` |
| `trg_agency_contacts_root` | BEFORE INSERT | `agency_contacts` | `agency_contact_stamp_root()` |
| `trg_agency_agent_sessions_updated_at` | BEFORE UPDATE | `agency_agent_sessions` | `update_updated_at()` |
| `trg_agency_call_attempts_updated_at` | BEFORE UPDATE | `agency_call_attempts` | `update_updated_at()` |
| `trg_agency_dnc_outbox_updated_at` | BEFORE UPDATE | `agency_dnc_outbox` | `update_updated_at()` |
| `trg_agency_calls_updated_at` | BEFORE UPDATE | `agency_calls` | `update_updated_at()` |
| `trg_dialer_analysis_jobs_updated_at` | BEFORE UPDATE | `dialer_analysis_jobs` | `update_updated_at()` |
| `trg_agency_manual_calls_updated_at` (0005) | BEFORE UPDATE | `agency_manual_calls` | `update_updated_at()` |
| `trg_agency_softphone_settings_updated_at` (0005) | BEFORE UPDATE | `agency_softphone_settings` | `update_updated_at()` |
| `trg_agency_attempts_dial_placed_insert` (0011) | AFTER INSERT, WHEN `NEW.dialed_at IS NOT NULL` | `agency_call_attempts` | `agency_attempt_count_placed_dial()` |
| `trg_agency_attempts_dial_placed_update` (0011) | AFTER UPDATE OF `dialed_at`, WHEN `OLD.dialed_at IS NULL AND NEW.dialed_at IS NOT NULL` | `agency_call_attempts` | `agency_attempt_count_placed_dial()` |
| `trg_agency_attempts_insights_insert` (0012) | AFTER INSERT, FOR EACH STATEMENT, `NEW TABLE AS new_rows` | `agency_call_attempts` | `agency_insights_mark_attempt_buckets()` |
| `trg_agency_attempts_insights_update` (0012) | AFTER UPDATE, FOR EACH STATEMENT, `OLD TABLE AS old_rows NEW TABLE AS new_rows` | `agency_call_attempts` | `agency_insights_mark_attempt_buckets()` |
| `trg_agency_attempts_insights_delete` (0012) | AFTER DELETE, FOR EACH STATEMENT, `OLD TABLE AS old_rows` | `agency_call_attempts` | `agency_insights_mark_attempt_buckets()` |
| `trg_agency_calls_insights_recording_insert` (0012) | AFTER INSERT, WHEN `NEW.recording_url IS NOT NULL` | `agency_calls` | `agency_insights_mark_call_recording()` |
| `trg_agency_calls_insights_recording_update` (0012) | AFTER UPDATE OF `recording_url`, WHEN it changed | `agency_calls` | `agency_insights_mark_call_recording()` |
| `trg_agency_calls_insights_error_insert` (0014) | AFTER INSERT, WHEN `NEW.error_code IS NOT NULL` | `agency_calls` | `agency_insights_mark_call_error()` |
| `trg_agency_calls_insights_error_update` (0014) | AFTER UPDATE OF `error_code`, WHEN it changed | `agency_calls` | `agency_insights_mark_call_error()` |
| `trg_agency_contacts_insights_zone` (0012) | AFTER UPDATE OF `timezone`, WHEN it changed | `agency_contacts` | `agency_insights_mark_contact_zone()` |
| `trg_agency_campaigns_insights_zone` (0012) | AFTER UPDATE OF `default_timezone`, WHEN it changed | `agency_campaigns` | `agency_insights_mark_campaign_zone()` |
| `trg_agency_attempts_inbound_reached` (0028, 0030) | AFTER UPDATE OF `disposition_code`, WHEN it changed to a code other than `voicemail`, `no_disposition`, `redialed` on a conversation (`bridged_at IS NOT NULL OR redial_number > 0`) | `agency_call_attempts` | `agency_attempt_inbound_reached()` |
| `trg_agency_manual_calls_inbound_reached` (0028, 0030) | AFTER UPDATE OF `disposition_code`, WHEN it changed to such a code on a bridged call | `agency_manual_calls` | `agency_manual_call_inbound_reached()` |
| `trg_agency_inbound_calls_inbound_reached` (0028) | AFTER UPDATE OF `bridged_at`, WHEN it is first set | `agency_inbound_calls` | `agency_inbound_call_inbound_reached()` |

Functions:

- `update_updated_at()`: stamps `updated_at` on every update.
- `agency_contact_stamp_root()`: on insert, sets `root_contact_id = id` when the row has none, so a
  retry lineage always has a root.
- `agency_contact_row_fingerprint(VARCHAR, JSONB, VARCHAR)`: called by the ingest INSERT to fingerprint
  a roster row. It is a function only; no trigger calls it.
- `agency_attempt_count_placed_dial()` (0011): adds one to the attempt's contact's `dials_placed`.
  The two `trg_agency_attempts_dial_placed_*` triggers' WHEN clauses decide that a dial was placed.
- `agency_insights_bucket(TIMESTAMPTZ)` (0012): the insights rollup bucket of an instant, its
  15-minute UTC boundary (`date_bin` from `2000-01-01T00:00:00Z`). `IMMUTABLE`; the rollup CHECKs,
  the triggers and the server's recompute all bin with it.
- `agency_insights_mark_attempt_buckets()`, `agency_insights_mark_call_recording()`,
  `agency_insights_mark_contact_zone()`, `agency_insights_mark_campaign_zone()` (0012): append a
  dirty mark per insights bucket the write touched (see 0012 below).
- `agency_inbound_close_reached_missed(tenant, account, phone, reached_at, user)` (0028, 0030):
  closes the account's open Missed inbound rows from `phone` (matched on its digits since 0030;
  nothing for a number with no digits) that arrived by `reached_at` (`handled`,
  `handled_reason = 'reached'`, handled by `user`). Its three callers, `agency_attempt_inbound_reached()`,
  `agency_manual_call_inbound_reached()` and `agency_inbound_call_inbound_reached()`, pass the
  conversation's account, number, start and agent (see 0028 and 0030 below).

`super_admins` and `account_settings` have `updated_at` columns but no trigger.

## Partition maintenance

The migration creates monthly partitions to 2027-12 and a DEFAULT partition on each audit table.
Creating later months and dropping aged months is the runtime job
`apps/server/src/audit/audit-partition-maintenance.ts` (daily; `AUDIT_RETENTION_DAYS`, default 85).
Rows for a month with no partition land in DEFAULT; a month whose rows are already in DEFAULT cannot
be attached as a partition until those rows are moved.

## Later migrations

### 0002 — `migrations/0002_telephony_credentials.sql`

Per-tenant carrier credentials (bring-your-own-carrier, decisions B18–B22).

- **Seed.** `telephony_providers ('plivo', 'Plivo', status 'inactive')`. It exists so credentials
  can reference it; it stays inactive (hidden from number creation and the concurrency editor)
  until the Plivo dial path ships.
- **`telephony_credentials`**: one row per carrier account a tenant dials on. `id`, `tenant_id`
  (→ `tenants`, RESTRICT), `provider` (→ `telephony_providers.name`), `label`, `status`
  (`active | disabled | invalid | revoked`), `account_ref` (the carrier's public account id),
  `public_config` (JSONB object, never a URL or host), `secret_version`, `secret_hint` (last four
  characters), `verified_at`, `last_error`, `created_by` / `updated_by` (→ `super_admins`),
  `created_at`, `updated_at`, `revoked_at`, `shredded_at`. CHECKs: `revoked_at` set exactly when
  revoked; a shredded row is revoked with no hint; non-blank label and account_ref; JSONB object.
  Rows are never deleted.
- **`telephony_credential_secrets`**: the sealed secret, one row per version. PK
  `(credential_id, secret_version)`; `secret_ciphertext`, `wrapped_dek`, `kek_id`
  (scheme-prefixed, e.g. `env:v1`), `created_at`, `retired_at` (NULL = current). Retired versions
  are pruned after the rotation grace; a revoked credential's rows are deleted (crypto-shred).
- **Repository** (`src/repositories/telephony-credential.repository.ts`). `shredIfIdle(id,
  postEndHoldSeconds)` refuses while any call pinned to the credential is non-terminal
  (`WEBRTC_NON_TERMINAL_STATUSES`, bound as a parameter) or ended (`COALESCE(ended_at,
  updated_at)`) within the hold; the server passes `WEBHOOK_TOKEN_POST_END_GRACE_SECONDS` (2 h,
  Q6). `findRevokedUnshredded(hold, limit)` lists only credentials that pass the same check, so
  ones a call still needs cannot fill the page and starve the rest. `markVerified(id, version,
  updatedBy)` is one statement pinned to the checked version: it re-activates `invalid`, leaves
  `disabled` disabled but clears its `last_error`, and is a no-op (null) on a revoked row or a
  replaced version. `findOpenableVersions` lists the versions `findOpenableSecrets` would return,
  without the ciphertext.
- **Unique indexes**: `uq_telephony_credentials_scope (id, tenant_id, provider)` (FK target);
  `uq_telephony_credentials_account (provider, account_ref) WHERE status <> 'revoked'` (one live
  registration per carrier account, across tenants); `uq_telephony_credentials_label (tenant_id,
  lower(label)) WHERE status <> 'revoked'`; `uq_telephony_credential_secrets_current
  (credential_id) WHERE retired_at IS NULL`.
- **Trigger**: `trg_telephony_credentials_updated` (`update_updated_at`).
- **New columns and composite FKs** (both `ON DELETE RESTRICT`, so a row can only pin a credential
  of its own tenant and provider):
  - `agency_campaigns.telephony_credential_id` →
    `telephony_credentials (id, tenant_id, provider)` via `(telephony_credential_id, tenant_id,
    telephony_provider)`. NULL = the service's own VoiceLink account.
  - `agency_calls.telephony_credential_id` → the same, via `(telephony_credential_id, tenant_id,
    provider)`; the credential a call was placed on, pinned at dial time.
  - `agency_calls.provider_request_id`: the carrier's dial-request id when it differs from the
    call id (Plivo `request_uuid`).
- **Down** drops the columns, FKs and tables, and deletes the `plivo` row unless a phone number
  references it.
- **Tests**: `test/integration/repositories/telephony-credential.repository.test.ts` (repository,
  CHECKs, composite FKs, rotation, revoke, the shred hold and its sweep, `markVerified`,
  `findOpenableVersions`) and the baseline suites, which pin the table
  set, the trigger list and the seed rows after both migrations.

### 0003 — `migrations/0003_agency_attempt_indexes.sql`

Indexes for the dialer's periodic reads. Checked with `EXPLAIN ANALYZE` on a seeded copy of the
schema (50 campaigns, 200k contacts, 265k attempts over 60 days, 40 live, 50 contacts in
`connected`, about 6k answered in the last 24 h):

| Change | Query | Before | After |
|---|---|---|---|
| `idx_agency_attempts_live (campaign_id)`: predicate `state IN (5 live states)` → `state <> 'ended'` | `countLive` (every pacing tick), `stats().attempts_live`, `liveByState` | BitmapAnd of `idx_agency_attempts_agent` and `idx_agency_attempts_reporting` (4,040 index rows read for 40 live) | Index Only Scan on `idx_agency_attempts_live` (40 rows) |
| new `idx_agency_attempts_answered (answered_at) WHERE answered_at IS NOT NULL` | `window24h` (every 60 s) | Parallel Seq Scan of all attempts | Bitmap Index Scan on `idx_agency_attempts_answered` |
| new `idx_agency_contacts_connected (id) WHERE state = 'connected'` | `findLapsedWrapups` (every reaper sweep) | Parallel Seq Scan of all contacts (200k), then `uq_agency_attempt_number` | Bitmap Index Scan on `idx_agency_contacts_connected` (50 rows), then `uq_agency_attempt_number` |
| drop `idx_agency_attempts_reporting (campaign_id, created_at DESC)` | everything filtering `campaign_id` (+ `created_at`) | used by the spine and by created_at range counts | the same plans on `idx_agency_attempts_keyset (campaign_id, created_at DESC, id DESC)`, same index condition |

The reaper's `state = ANY(<the five live states>)` still implies the new live predicate and keeps
using `idx_agency_attempts_live`. Plain `CREATE INDEX` (node-pg-migrate runs each file in one
transaction, where `CONCURRENTLY` is not allowed): each build holds a SHARE lock on its table,
blocking writes for the build; migrations run at container start, before the server. **Down**
restores the baseline's live predicate and `idx_agency_attempts_reporting` and drops the two new
indexes. **Tests**: `test/integration/db/attempt-indexes-migration.test.ts` (each definition, and
that the planner can use each index for its query) and the down → up inventory suite.

### 0004 — `migrations/0004_agency_contacts_in_flight_index.sql`

One index, for the reaper's stranded-contact sweep (`AgencyContactRepository.findStrandedInFlight`,
every 60 s): `idx_agency_contacts_in_flight (id) WHERE state = 'in_flight'`, the same shape as
0003's `idx_agency_contacts_connected`. The sweep drives from the few contacts in `in_flight` (one
per live call) and reads their attempts through `uq_agency_attempt_number`; without the index it
would scan every contact. Keyed on `id` rather than `updated_at`, so contact writes that only move
`updated_at` stay HOT-eligible. Plain `CREATE INDEX`, as in 0003. **Down** drops it. **Tests**:
`test/integration/db/contacts-in-flight-index-migration.test.ts` (the definition, and that the
planner can use it and `uq_agency_attempt_number` for the sweep's query) and the down → up
inventory suite.

### 0005 — `migrations/0005_softphone.sql`

The soft phone (`docs/softphone.md` §3; rulings SP1–SP7, Manas 2026-10-30): an agent dials a
typed number outside pacing, optionally logged ("tagged") to one of their campaigns.

- **`agency_agent_sessions`**: `kind VARCHAR(16) NOT NULL DEFAULT 'campaign'`; `campaign_id` DROP
  NOT NULL (the campaign FK and its cascade stay). CHECKs: `ck_agency_agent_session_kind` (`campaign
  | softphone`); `ck_agency_agent_session_kind_campaign` (`(kind = 'campaign') = (campaign_id IS NOT
  NULL)`); `ck_agency_agent_session_softphone_state` (a soft-phone session is only ever `break` or
  `offline`, so pacing can never reserve it). `uq_agency_agent_live_tenant` is unchanged and spans
  both kinds.
- **`agency_agent_session_events.campaign_id`**: DROP NOT NULL (copied from the session).
- **`agency_manual_calls`**: one row per soft-phone dial, the soft phone's audit spine. `id`,
  `tenant_id`, `account_id`, `session_id` (→ `agency_agent_sessions`, no cascade, like
  `agency_call_attempts.reserved_agent_id`), `agent_user_id`, `campaign_id` (the tag), `contact_id`
  (the roster match), `contact_claimed`, `contact_prior_state`, `webrtc_call_id`, `destination_e164`,
  `caller_id`, `state`, `outcome`, `end_reason`, `disposition_code`, `disposition_source`, `notes`,
  `callback_at`, `fields` (JSONB object), `recording_requested`, `analysis_profile_id`,
  `dnc_override_note`, `dnc_override_entry_id`, `hours_override_note`, `dialed_at`, `answered_at`,
  `bridged_at`, `ended_at`, `talk_seconds`, `dispositioned_by_user_id`, `dispositioned_at`,
  `dispositioned_on_behalf`, `settled_at`, `created_at`, `updated_at`. No FK on the tag, contact,
  leg, profile or DNC entry ids (each side purges or is deleted independently). CHECKs: `state`,
  `outcome`, `end_reason`, `disposition_source` and `contact_prior_state` vocabularies (the
  contract's `AGENCY_MANUAL_CALL_*` lists); `disposition_source = 'campaign'` exactly on a tagged
  call; a contact match only on a tag, a claim only with a contact and a prior state; override
  notes 10–500 characters after trimming, a DNC note only with its entry id; `ended_at` set exactly
  when `ended`; `settled_at` only once `ended`; `talk_seconds >= 0`. Indexes:
  `uq_agency_manual_call_unsettled (session_id) WHERE settled_at IS NULL` (one live or
  outcome-awaiting call per session; the lapse sweep reads it too); `idx_agency_manual_calls_agent
  (tenant_id, account_id, agent_user_id, created_at DESC, id DESC)` and
  `idx_agency_manual_calls_account (tenant_id, account_id, created_at DESC, id DESC)` (the two
  keyset lists); `idx_agency_manual_calls_live (account_id) WHERE state <> 'ended'` (pacing headroom
  across the account, the reapers); `idx_agency_manual_calls_campaign (campaign_id, created_at
  DESC) WHERE campaign_id IS NOT NULL`; `idx_agency_manual_calls_contact (contact_id) WHERE
  contact_id IS NOT NULL AND settled_at IS NULL` (the stranded-contact sweep and the pre-dial
  match); `idx_agency_manual_calls_contact_history (contact_id, created_at DESC, id DESC) WHERE
  contact_id IS NOT NULL` (a contact's soft-phone calls, settled included: `GET
  /softphone/calls?contact_id=`). No index on `webrtc_call_id`: nothing looks a manual call up by
  its leg. Trigger `trg_agency_manual_calls_updated_at`.
- **`agency_call_attempts`**: `idx_agency_attempts_account_live (tenant_id, account_id) WHERE state
  <> 'ended'`, the attempt half of pacing's account-wide headroom (`countLiveForAccount`, every
  tick): an index-only scan of the account's live attempts instead of a probe per campaign the
  account has ever had (~1.5 ms / 164 buffers → ~0.2 ms / 16 at 2,010 campaigns). Built with a
  plain `CREATE INDEX` over the existing rows, as 0003's.
- **`agency_calls`**: `origin VARCHAR(16) NOT NULL DEFAULT 'campaign'` (`campaign | manual`) and
  `manual_call_id UUID` (correlation, no FK). CHECKs: `ck_agency_calls_origin`;
  `ck_agency_calls_manual_correlation` (`manual_call_id` set exactly on a manual leg, whose
  `campaign_id` and `agency_attempt_id` are NULL, so no campaign aggregation counts it). Index
  `idx_agency_calls_manual_call (manual_call_id) WHERE manual_call_id IS NOT NULL`. A manual leg is
  still an agency call (SP5); `WebRtcCallScope`'s `'agency'` predicate must take it in before
  soft-phone calls are placed.
- **`agency_softphone_settings`**: one optional row per (tenant, account), for untagged calls (call
  fields apply to every call). `id`, `tenant_id`, `account_id`, `disposition_catalog` (JSONB array,
  `[]` = the built-in catalog), `call_fields` (JSONB array, at most 20), `analysis_profile_id`,
  `record_calls` (default false), `default_caller_id`, `created_at`, `updated_at`.
  `uq_agency_softphone_settings_account (tenant_id, account_id)`; trigger
  `trg_agency_softphone_settings_updated_at`. No FK to tenants/accounts, as `account_settings`.
- **Down** raises, before changing anything, while any session or session event has a NULL
  `campaign_id` (deleting soft-phone sessions would take their calls' audit trail), and while any
  manual call or `origin = 'manual'` leg exists (calls made from a campaign session switched to the
  soft phone leave no soft-phone session behind); otherwise it drops the attempts' account index,
  the settings table, the `agency_calls` columns and index, the manual-calls table, and restores
  `campaign_id NOT NULL` and drops `kind` with its CHECKs.
- **Tests**: `test/integration/db/softphone-migration.test.ts` (every CHECK from both sides, each
  vocabulary against the contract's list, the unsettled-call index, the FKs, the index definitions
  and three plans) and the baseline suites (table set, triggers, the down → up inventory, and the
  Down refusal while a soft-phone session or a switched campaign session's manual call exists).

### 0006 — `migrations/0006_agent_session_client_kind.sql`

The agent mobile app. **`agency_agent_sessions.client_kind`** `VARCHAR(16) NOT NULL DEFAULT 'web'`,
CHECK `ck_agency_agent_session_client_kind` (`web | mobile`, the contract's `AGENCY_CLIENT_KINDS`):
which app the session's station socket last attached from. Written by every station attach
(`AgencyAgentSessionRepository.readForStationAttach`, folded into the attach's own session read, and
only when it changes), so a session continued on another device follows the device. Read by the
supervisor's floor (a phone marker); station liveness reads the in-memory station entry, never this
column. Client-declared and never verified, so nothing security-relevant reads it. Every existing row
is `web`. No index (nothing filters on it). Adding a column with a constant DEFAULT does not rewrite
the table. **Down** drops the CHECK and the column. **Tests**:
`test/integration/db/agent-session-client-kind-migration.test.ts` (the column, its default, the
CHECK against the contract's list) and the down → up inventory suite.

### 0007 — `migrations/0007_ingest_dedupe_column.sql`

Roster upload, choosing the duplicate column. **`agency_ingest_jobs.dedupe_column`** `TEXT NULL`:
the header whose value marks a duplicate row in the file (for example a loan number, so one
borrower with two loans on one phone keeps both rows). Compared trimmed and case-insensitive; a
blank value is never a duplicate. NULL keeps the earlier behaviour, which `dedupe_phones` decides
(normalised phone, or none). Superseded by 0031's `dedupe_columns`, which the Up backfills from it:
nothing writes or reads `dedupe_column` any more. No index, no rewrite. **Down** drops the column. **Tests**:
`test/integration/db/ingest-dedupe-column-migration.test.ts` and the down → up inventory suite.

### 0008 — `migrations/0008_wrapup_redial.sql`

Wrap-up redial: an agent in wrap-up after a connected call, before saving the outcome, redials
the same customer (`POST /proxy/agency/sessions/:id/redial`, `apps/server/src/agency/wrapup-redial.ts`).

- **`agency_campaigns.allow_wrapup_redial`** `BOOLEAN NOT NULL DEFAULT false`: the campaign
  setting. Copied to a retry campaign like the other config columns.
- **`agency_call_attempts.redial_of_attempt_id`** `UUID NULL REFERENCES agency_call_attempts(id)
  ON DELETE SET NULL`: the attempt this one redials. That attempt keeps its outcome
  (`connected`) and is closed with the reserved system disposition `redialed` and
  `wrapup_resolution = 'redialed'`.
- **`agency_call_attempts.redial_number`** `SMALLINT NOT NULL DEFAULT 0`: 0 for a paced dial,
  1 and 2 for the redials of one call. The limit (`AGENCY_WRAPUP_REDIAL_LIMIT`, 2) lives in the
  contract and the server enforces it; `ck_agency_attempt_redial_number` only refuses a negative
  number, and `ck_agency_attempt_redial_link` requires a link to carry a number above 0 (the
  converse is not checked: a purged original leaves the link NULL and the number).
- **Unique index `uq_agency_attempt_redial_of`** `(redial_of_attempt_id) WHERE redial_of_attempt_id
  IS NOT NULL`: one redial per attempt, the backstop behind `beginWrapupRedial`'s row lock.
- **`ck_agency_wrapup_resolution`** re-created with `redialed`. The supervisor's average wrap-up
  does not count it.
- A redial attempt is otherwise an ordinary row: `uq_agency_attempt_live` and
  `uq_agency_attempt_number` apply, and the abandonment predicate counts it. The campaign stats
  count a redialled conversation once (at the attempt not closed `redialed`) and its redials as
  `attempts_redialed`, never as retries (`apps/server/src/db/repositories/agency/sql-fragments.ts`,
  `CONVERSATION_ATTEMPT_SQL`).

**Down** maps `redialed` resolutions to `agent_left`, restores the old CHECK, and drops the index,
the two CHECKs and the three columns. A `redialed` disposition code is left as it is (an ordinary
string to the schema). **Tests**: `test/integration/db/wrapup-redial-migration.test.ts` and the
down → up suite (`test/integration/baseline-down-up.test.ts`, including a Down over a redial chain).

### 0009 — `migrations/0009_contact_assignment.sql`

Contact assignment (supervisors assign roster contacts to agents), agent-led retry and
outcome-granted overrides.

- **`agency_campaigns`**: `assignment_mode` (`pool` default | `strict` | `preferred`), `on_unstaff`
  (`return_to_pool` default | `keep`), `callback_owner_grace_minutes` (0–10080, default 30),
  `callback_fallback` (`pool` default | `wait`), `allow_agent_retry` (default false),
  `agent_retry_rounds` (1–10, default 1), `agent_retry_cooldown_minutes` (0–10080, default 30).
  Each CHECKed (`ck_agency_campaign_*`). The defaults are today's behaviour.
- **`agency_contacts.assigned_user_id`** `UUID NULL`: the owning agent (NULL: the shared pool).
  No FK to `users`, as `agency_agent_sessions.agent_user_id`: user ids are opaque to the dialer
  and an FK would scan the roster on every user delete. `assigned_at` / `assigned_by_user_id`
  stamp it; `ck_agency_contact_assigned_at` requires `assigned_at` with an owner.
- **`agency_contacts.agent_retry_rounds_used`** `SMALLINT NOT NULL DEFAULT 0`: reopens an agent
  spent on the contact (bounded by `agent_retry_rounds`).
- **`agency_contacts.override_*`**: the latest override-granting outcome (`override_disposition`),
  what is left of it (`override_extra_attempts` 0–5, `override_retry_delay`,
  `override_calling_hours`) and `override_granted_at`. DNC has no column: never overridable.
- **Index `idx_agency_contacts_assignee`**: built by 0010 (below), not here.
- **`agency_contact_assignment_events`**: one row per contact per owner change (`from_user_id`,
  `to_user_id`, NULL = pool; `actor_user_id`, NULL = system; `reason`, CHECKed; `batch_id`
  shared by one operation, whose `platform_audit_log` row carries the same id). Cascades from the
  contact and the campaign. `ck_agency_assignment_event_moves` refuses a row that moves nothing.
- **`agency_call_attempts`**: `agent_manual` (an agent dialled the contact from their own list),
  `override_applied TEXT[]` (subset of `extra_attempts`, `retry_delay`, `calling_hours`) and
  `override_note` (10–500 characters, the calling-hours note).
- The bucket and retry-eligibility rules every read uses are SQL fragments in
  `apps/server/src/db/repositories/agency/assignment-sql.ts`.
- **Locking.** Catalog changes only, so its ACCESS EXCLUSIVE on `agency_contacts`,
  `agency_call_attempts` and `agency_campaigns` lasts milliseconds (~25 ms on 1M contacts with 1M
  attempts, against ~2 s with the scans and the index build in it). The five CHECKs on
  `agency_contacts` and `agency_call_attempts` (`ck_agency_contact_assigned_at`,
  `ck_agency_contact_agent_retry_rounds_used`, `ck_agency_contact_override_extra_attempts`,
  `ck_agency_attempt_override_applied`, `ck_agency_attempt_override_note`) are added `NOT
  VALID`: enforced on every new write, the existing rows satisfying them through the column
  defaults. The `agency_campaigns` CHECKs are validated here (one row per campaign).

**Down** drops the three attempt columns and their CHECKs, the history table, the contact columns
and the campaign settings with their CHECKs; contacts and their attempts survive, unowned.
**Tests**: `test/integration/db/contact-assignment-migration.test.ts` and the down → up suite
(`test/integration/baseline-down-up.test.ts`, including a Down with assigned contacts and their
history present, and 0009 applied alone: the five CHECKs not validated yet refusing bad writes).

### 0010 — `migrations/0010_contact_assignment_index_and_checks.sql`

The work over contact assignment's existing rows, kept out of 0009's ACCESS EXCLUSIVE. Its own
transaction: the image's runner (`apps/server/src/migrate.ts`) commits each file separately. The
node-pg-migrate CLI (`pnpm migrate:up`) puts every pending file in one transaction by default;
pass `--no-single-transaction` to it on a large roster.

- **`VALIDATE CONSTRAINT`** for the five `NOT VALID` CHECKs of 0009. Each scans its table under
  SHARE UPDATE EXCLUSIVE (reads and writes proceed); afterwards `pg_constraint.convalidated` is
  true for all. Cannot fail: rows written since 0009 were checked, older rows hold the defaults.
- **Index `idx_agency_contacts_assignee`** `(campaign_id, assigned_user_id, state,
  next_attempt_at)`: the per-agent claim, the preferred-mode pool claim (`assigned_user_id IS
  NULL`) and per-agent counts. `idx_agency_contacts_dialable` still serves the pool-mode claim.
  Plain `CREATE INDEX`, as 0003's: SHARE on `agency_contacts` while it builds (reads proceed,
  writes wait). ~0.6 s on 1M contacts, plus ~0.12–0.18 s per VALIDATE.

**Down** drops the index. The CHECKs stay validated (a constraint cannot be marked `NOT VALID`
again; 0009's Down drops them). **Tests**: `test/integration/db/contact-assignment-migration.test.ts`
(every 0009 CHECK validated, the index definition) and the down → up suite (0009 alone, then 0010
over rows that predate both).

### 0011 — `migrations/0011_insights_foundation.sql`

The shared schema of the campaign insights page (`docs/insights.md`).

- **`agency_call_attempts.agent_reopened`** `BOOLEAN NOT NULL DEFAULT false`: the dial came from
  an agent-led reopen ("Retry not reached") placed through pacing. Written by the pacing writer
  (insights workstream C); 0011 only adds the column.
- **`agency_contacts.dials_placed`** `INTEGER NOT NULL DEFAULT 0`, CHECK
  `ck_agency_contact_dials_placed` (`>= 0`): every placed dial on the contact, wrap-up redials and
  our-fault redials included (IN6). Not `attempt_count` (the customer's retry allowance) nor
  `our_fault_attempts` (the our-fault ledger). Application code never writes it.
- **Triggers** `trg_agency_attempts_dial_placed_insert` (AFTER INSERT, WHEN `NEW.dialed_at IS NOT
  NULL`) and `trg_agency_attempts_dial_placed_update` (AFTER UPDATE OF `dialed_at`, WHEN `OLD.dialed_at
  IS NULL AND NEW.dialed_at IS NOT NULL`), both calling `agency_attempt_count_placed_dial()`. One
  increment per attempt that is placed: a second write of `dialed_at` (setState's `COALESCE`) does
  not count again, an attempt never placed never counts, a deleted attempt does not decrement. The
  WHEN clauses run without calling the function, so the attempt writes that place nothing pay one
  comparison. `agency_call_attempts` is not partitioned.
- **`trg_agency_contacts_updated_at`** re-created with `WHEN (pg_trigger_depth() = 0 OR
  NEW.dials_placed IS NOT DISTINCT FROM OLD.dials_placed)`: the increment (a nested update that
  changes `dials_placed`) does not move the contact's `updated_at`, because counting a dial is not
  an edit and the reaper's stranded-contact sweep reads `updated_at` ("untouched since"). Every
  statement the server sends runs at depth 0 and is stamped as before. Down restores 0001's
  trigger.
- **Backfill**: `dials_placed` = the contact's attempts with `dialed_at` set, run between dropping
  and re-creating that trigger, so the filled contacts keep their `updated_at` too.
- **Indexes**, each with a `COMMENT ON INDEX`:
  - `idx_agency_contacts_insights` `(campaign_id, state) INCLUDE (next_attempt_at, suppressed_reason,
    attempt_count, dials_placed, last_outcome, last_disposition, assigned_user_id)`: the as-of-now
    roster buckets, allocation and headline for one campaign, as an Index Only Scan.
  - `idx_agency_attempts_campaign_dialed` `(campaign_id, dialed_at) WHERE dialed_at IS NOT NULL`:
    ranged attempt reads within one campaign and the rollup recompute. `idx_agency_attempts_billing`
    leads with `dialed_at` (a range across campaigns) and does not serve this.
  - `idx_agency_attempts_campaign_callback` `(campaign_id, callback_at) WHERE callback_at IS NOT
    NULL`: callback timing (IN4).
  - `idx_agency_session_events_campaign_at` `(campaign_id, at)` on `agency_agent_session_events`:
    the per-campaign agent state history (`idx_agency_session_events_agent` leads with the agent).
- **Locking.** One transaction, everything under ACCESS EXCLUSIVE on `agency_contacts` and
  `agency_call_attempts` (ADD COLUMN, CHECK, triggers), including the backfill and four plain
  `CREATE INDEX` builds. Production has no data yet (`docs/status.md`). Measured on 1.2M contacts
  with 1.2M attempts (800k placed), shared dev host: CHECK ~0.3 s, backfill ~115 s, builds ~4.1 s
  (contacts), ~1.0 s and ~0.2 s (attempts). On a populated database the backfill and the builds
  go in a file of their own first, as 0010 did for 0009.
- **Plans** on that seed (`EXPLAIN ANALYZE`): the bucket count for a 50k-contact campaign is an
  Index Only Scan on `idx_agency_contacts_insights` (56 ms); for the 1M-contact campaign, 83% of
  the table, the planner prefers a parallel seq scan (279 ms; the index-only scan, forced, 392 ms);
  a day of one campaign's dials in 15-minute buckets is an Index Only Scan on
  `idx_agency_attempts_campaign_dialed` (2.7 ms); a week of callbacks is a bitmap scan on
  `idx_agency_attempts_campaign_callback` (32 ms). The two dial triggers add ~0.33 ms per placed
  dial (10k `dialed_at` stamps: 4.2 s, against 0.95 s for an update that places nothing).

**Down** drops the indexes, both triggers, the function, restores 0001's
`trg_agency_contacts_updated_at`, and drops the CHECK and both columns. **Tests**:
`test/integration/db/insights-foundation-migration.test.ts` (columns and defaults, the CHECK, one
increment per placed dial including a wrap-up redial, counting leaving `updated_at` alone, the index definitions and comments, the
roster count as an Index Only Scan, the range plans, the backfill keeping `updated_at`, down then
up), the trigger list in `baseline.test.ts`, and the down → up suite.

### 0012 — `migrations/0012_insights_rollup.sql`

The campaign insights rollup (`docs/insights.md` "The rollup"): the range sections read it, never
the attempt table. A pure function of `agency_call_attempts` (plus each attempt's session agent,
contact zone and call recording), rebuilt per 15-minute UTC bucket of `dialed_at` by the server's
job, never incremented. The recompute SQL is the server's (`insights-rollup-sql.ts`), because it
is spelled from the domain's TypeScript definitions.

- **`agency_insights_bucket(TIMESTAMPTZ)`**: `date_bin('15 minutes', ts, '2000-01-01T00:00:00Z')`,
  `IMMUTABLE`, SQL-standard body. The one definition of a bucket.
- **`agency_insights_rollup_dirty`** (`id` identity PK, `campaign_id`, `bucket_start`, `marked_at`;
  CHECK `ck_agency_insights_dirty_bucket` that the bucket is aligned; index
  `idx_agency_insights_rollup_dirty_bucket (campaign_id, bucket_start)`): append-only marks. No FK
  (a campaign DELETE cascades to its attempts, whose DELETE trigger marks after the campaign row is
  gone; the job drops marks of a campaign that no longer exists). **Never upserted**: an `ON
  CONFLICT DO NOTHING` mark loses a write whose transaction commits after the job's recompute
  snapshot, and `ON CONFLICT DO UPDATE` makes every attempt write in one campaign's quarter hour
  queue on one row lock. The job deletes exactly the marks its claim saw, in the transaction that
  recomputes from a later snapshot.
- **`agency_insights_rollup_buckets`** (PK `(campaign_id, bucket_start)`, FK to `agency_campaigns`
  ON DELETE CASCADE, CHECK `ck_agency_insights_rollup_bucket`): the bucket's totals (19 BIGINT
  measures, durations in microseconds), `source_updated_at` (newest attempt `updated_at` folded
  in) and `computed_at`. Also the job's lock: two recomputes of one bucket serialize on this row.
- **`agency_insights_rollup_agents`** (`uq_… (campaign_id, bucket_start, agent_user_id) NULLS NOT
  DISTINCT`), **`agency_insights_rollup_codes`** (`uq_… (campaign_id, bucket_start, agent_user_id,
  disposition_code) NULLS NOT DISTINCT`), **`agency_insights_rollup_facets`** (`facet` CHECK
  `ck_agency_insights_rollup_facet` in `outcome`, `caller_id`, `local_hour`, `no_outcome`,
  `override`; `uq_… (campaign_id, facet, bucket_start, key, agent_user_id) NULLS NOT DISTINCT`):
  the breakdowns, each with an FK `(campaign_id, bucket_start)` to the header ON DELETE CASCADE.
  No primary keys: the unique indexes carry the invariant (one row per key) and serve the reads
  (campaign and bucket range, the facets' by facet first).
- **Triggers** (all AFTER, all appending marks): `trg_agency_attempts_insights_insert` /
  `_update` / `_delete` on `agency_call_attempts`, FOR EACH STATEMENT with transition tables (a
  trigger with transition tables takes one event and no column list), one function
  `agency_insights_mark_attempt_buckets()`: the DISTINCT old and new buckets of the statement's
  placed attempts, so moving `dialed_at` marks both and a bulk sweep writes one mark per bucket.
  `trg_agency_calls_insights_recording_insert` / `_update` (WHEN `recording_url` is set / changed;
  the attempt by `idx_agency_attempts_webrtc`), `trg_agency_contacts_insights_zone` (WHEN
  `timezone` changed; the contact's attempts by `uq_agency_attempt_number`),
  `trg_agency_campaigns_insights_zone` (WHEN `default_timezone` changed; every rolled-up bucket of
  the campaign). Sessions need none: `agent_user_id` never changes.
- **Backfill**: one mark per distinct bucket with a placed attempt, oldest first.
- **Cost**, shared dev host: the attempt triggers add ~85 µs per single-row attempt UPDATE (5,000
  updates run server-side, median of five: 0.84 s without, 1.27 s with); a 5,000-row UPDATE in one
  statement writes one mark per bucket. The backfill marked 2,880 buckets of a 1M-attempt campaign
  in 0.8–1.0 s, and the job drained them in 62 s.
- **Locking.** One transaction; CREATE TRIGGER takes SHARE ROW EXCLUSIVE on `agency_call_attempts`,
  `agency_calls`, `agency_contacts` and `agency_campaigns` until commit, with the backfill read
  under it. Production has no data yet (`docs/status.md`).
- **Tests rely on**: `test/helpers/test-db.ts`'s `truncateAll` deletes the marks its attempt
  DELETE leaves (a second statement, after the attempts DELETE trigger fires).

**Down** drops the triggers, functions, the five tables and the bucket function. **Tests**:
`test/integration/db/insights-rollup-migration.test.ts` (the bucket function, the keys and CHECKs,
each trigger marking exactly the buckets its write touched and the writes that mark nothing, a
campaign delete cascading, down then up with the backfill), the table and trigger lists in
`baseline.test.ts`, and the down → up suite. The recompute and the reads are pinned on Postgres
in `apps/server/test/integration/agency/insights-rollup-{oracle,job}.test.ts`, and at scale in
`apps/server/test/integration/load/insights-rollup-scale.test.ts`.

### 0013 — `migrations/0013_insights_pacing_history.sql`

Pacing history (IN2, `docs/insights.md`) and the reopen marker. It does not depend on 0012 (the
rollup).

- **`agency_campaign_pacing_minutes`**, primary key `(campaign_id, minute_start)`, `tenant_id`
  `UUID NOT NULL`, FK `campaign_id → agency_campaigns(id) ON DELETE CASCADE`. Fifteen additive
  `INTEGER NOT NULL DEFAULT 0` counters per campaign per UTC minute: `ticks` (pacing ticks, full or
  skipped, on a `running` campaign), `outside_hours_ticks` (of those, the campaign's own window was
  closed), `idle_no_agents | idle_no_slots | idle_no_contacts | idle_no_reservations |
  idle_no_caller_ids | idle_nothing_due` (`agency_tick_idle_total`'s reasons; one per tick, so
  their sum is at most `ticks`), `calling_hours_deferrals`, `dnc_unavailable_halts`,
  `dials_placed` (paced dials handed to the dialer), `predial_dnc_suppressed`,
  `predial_invalid_suppressed`, `our_fault_retired`, `redials_refused_at_limit`. CHECKs
  `ck_agency_pacing_minute_whole` (a whole UTC minute) and `ck_agency_pacing_minute_counts` (no
  negative counter). Written only by additive upserts (`ON CONFLICT … DO UPDATE SET x = t.x +
  EXCLUDED.x`): the pacing leader's batch every ~15 s, and single-row upserts outside the tick.
  A minute with no row was not recorded (absent, not zero). The primary key serves both reads (a
  range of one campaign's minutes; its first minute, `history_since`).
- **`agency_contacts.agent_reopen_pending`** `BOOLEAN NOT NULL DEFAULT false`: set by an agent's
  reopen, consumed by the first paced attempt insert (which is stamped `agent_reopened`, 0011),
  cleared by the agent's own dial of the contact, restored when a paced attempt is abandoned before
  its dial.
- **Locking.** A new table and one constant-default ADD COLUMN: catalog only.

**Down** drops the column and the table. **Tests**:
`test/integration/db/insights-pacing-history-migration.test.ts` (columns, key, CHECKs, the additive
upsert, the cascade, both read plans on the primary key, the marker's default, down then up), the
table list in `baseline.test.ts`, and the down → up suite.


### 0014 — `migrations/0014_insights_rollup_first_dials_carrier_errors.sql`

The rollup's connect-rate measures (decision IN10: human connects ÷ placed first dials, the same
number as `/stats` and the agent record) and carrier failures by error code (the mapping's §9).
Additive to 0012.

- **Columns**, all `BIGINT NOT NULL DEFAULT 0`: `human_connects` on
  `agency_insights_rollup_buckets` and `agency_insights_rollup_agents`; `first_dials` and
  `human_connects` on `agency_insights_rollup_facets` (the `caller_id` and `local_hour` facets;
  0 on every other facet). Buckets and agents derive first dials as dials − redials placed.
- **CHECK** `ck_agency_insights_rollup_facet` gains `carrier_error`: failed dials keyed by
  `agency_calls.error_code` (NULL key for no call row or no code).
- **Triggers** `trg_agency_calls_insights_error_insert` (WHEN `NEW.error_code IS NOT NULL`) and
  `trg_agency_calls_insights_error_update` (AFTER UPDATE OF `error_code`, WHEN it changed), function
  `agency_insights_mark_call_error()`: mark the bucket of the attempt whose `webrtc_call_id` is the
  call (`idx_agency_attempts_webrtc`). Cost: ~15 µs per error-code-changing call update (5,000
  updates, median of five: 536 ms with, 459 ms without); every other call write is excluded by the
  WHEN clauses.
- **Backfill**: one mark per existing rollup header, so the job recomputes every bucket with the
  new measures.
- **Locking.** ACCESS EXCLUSIVE on `agency_insights_rollup_facets` for the CHECK swap, SHARE ROW
  EXCLUSIVE on `agency_calls` for the triggers; one transaction.

**Down** drops the triggers and the function, deletes the `carrier_error` rows, restores the
CHECK and drops the four columns. **Tests**: `test/integration/db/insights-rollup-facets-migration.test.ts`
(the columns, the CHECK, both triggers marking the right bucket, the backfill, down then up), the
trigger list in `baseline.test.ts`, the down → up suite, and the server's rollup oracle.

### 0015 — `migrations/0015_multiple_running_campaigns.sql`

Several running campaigns per account (`docs/decisions.md`, "Several running campaigns per
account", MC4 and MC6).

- **Drops `uq_agency_campaign_running`**, the baseline's one running campaign per account. The
  account's `max_concurrent_calls` is shared between its running campaigns by the pacing round;
  Start and Resume no longer answer 409 `another_campaign_running` (the code is retired from
  `packages/contracts`). Agent exclusivity is unchanged (`uq_agency_agent_live_tenant`).
- **`idx_agency_contacts_account_live_digits`** `(tenant_id, account_id, regexp_replace(phone_e164,
  '[^0-9]', '', 'g')) WHERE state IN ('in_flight', 'connected')`: the claims' busy probe
  (`numberLiveSql`), widened from the campaign to the account so a number on a call on any of the
  account's campaigns (a retry child and its parent, two rosters sharing a number) is not
  claimed again. The key expression is `CONTACT_PHONE_DIGITS_SQL` byte for byte and the predicate
  is `LIVE_STATES_SQL`'s list, so the planner uses it for the probe; partial on the live states,
  it holds about one entry per live call.
- **Locking.** Plain `CREATE INDEX` (SHARE on `agency_contacts`, one scan of the table) and a
  catalog-only `DROP INDEX` on `agency_campaigns`; one transaction, at container start.

**Down** refuses (RAISE, nothing changed) while any account has more than one running campaign;
otherwise it drops the live-number index and recreates `uq_agency_campaign_running`. **Tests**:
`test/integration/db/multiple-running-campaigns-migration.test.ts` (the unique index gone, the new
index's definition and that the planner uses it for the probe, the refused down, down then up), the
`uq_agency_campaign_running` case in `baseline.test.ts`, and the down → up suite.

### 0016 — `migrations/0016_customer_history_indexes.sql`

Customer history: one number searched across the tenant's campaigns (`docs/customer-history.md`,
CH9).

- **`idx_agency_manual_calls_destination`** `(tenant_id, account_id, destination_e164,
  created_at DESC, id DESC)`: every soft-phone call to one number in the accounts the caller can
  see, logged to a campaign or not (an untagged call has no contact, only `destination_e164`).
  The history's timeline walks it once per visible account, keyset on `(created_at, id)` with the
  cursor in the index condition and no sort (`CUSTOMER_HISTORY_SQL.pageManualCalls`; pinned by
  `test/integration/db/customer-history-indexes-migration.test.ts` and EXPLAINed whole by the
  server's `test/integration/api/customer-history.test.ts`). `destination_e164` is already
  normalised to E.164 at pre-dial, the form the search produces.
- **Locking.** Plain `CREATE INDEX` (SHARE on `agency_manual_calls`, one scan); one transaction, at
  container start.

**Down** drops the index. **Tests**: `test/integration/db/customer-history-indexes-migration.test.ts`
(definition, the planner using it for the history's read, down then up) and the down → up suite.

### 0017 — `migrations/0017_customer_history_contacts_index.sql`

Customer history: every read bounded to a number's newest 2,000 roster rows
(`docs/customer-history.md`, CH9 and CH14).

- **`idx_agency_contacts_customer_history`** `(tenant_id, account_id, phone_e164, created_at DESC,
  id DESC) INCLUDE (campaign_id)`: a placeholder number pasted down a roster made every
  customer-history read O(roster rows). The history now covers the newest
  `CUSTOMER_HISTORY_MAX_CONTACT_ROWS` (2,000) rows of the number in the visible accounts, chosen by
  walking this index once per account newest first under a `LIMIT` (`newestContacts`,
  `CUSTOMER_HISTORY_SQL`): the walk stops at the cap, with no sort of every match. `campaign_id` is
  included so the walk can be answered from the index. `idx_agency_contacts_phone` stays (the DNC
  sweeps and the dialer's cross-campaign lookups).
- **Locking.** Plain `CREATE INDEX` (SHARE on `agency_contacts`, one scan); one transaction, at
  container start.

**Down** drops the index. **Tests**: `test/integration/db/customer-history-contacts-index-migration.test.ts`
(definition, the walk stopping at the cap on a 5,000-row placeholder among 200,000 rows, down then
up) and the down → up suite.

### 0018 — `migrations/0018_agent_caller_ids.sql`

Dedicated caller ID per agent on a campaign (`docs/decisions.md`, "Dedicated caller ID per agent",
DN1–DN10).

- **`agency_campaign_agent_caller_ids`**: `tenant_id` (FK `tenants`, CASCADE), `account_id` (the
  campaign's; no FK, as `agency_campaigns.account_id`), `campaign_id` (no FK, as
  `agency_campaign_agents.campaign_id`), `user_id` (FK `users`, CASCADE), `caller_id VARCHAR(20)`,
  `set_by_user_id` (FK `users`, SET NULL), `set_at`. `user_id` is FK'd, unlike
  `agency_contacts.assigned_user_id`: 0009's reason (a user delete scanning a million-row roster)
  does not apply to a table of one row per staffed agent per campaign, and the staffing row it
  follows cascades the same way.
- **`uq_agency_agent_caller_id_agent`** `(campaign_id, user_id)`: one number per agent on a
  campaign; the PUT replaces an agent's number with an UPSERT on it, and the dial paths' map
  read (`WHERE campaign_id = $1`) uses it. **`uq_agency_agent_caller_id_number`** `(campaign_id,
  caller_id)`: one agent per number on a campaign; a set that trips it is `caller_id_taken`.
  The same number may be dedicated on other campaigns.
- **`ck_agency_agent_caller_id_trimmed`**: stored trimmed and non-empty, so it compares with
  `usableCallerIds` (trimmed) as is.
- **`idx_agency_agent_caller_ids_user`** `(user_id)`: the user cascade and the unstaff release
  (DN7, a CTE of `returnOnUnstaff`, by agent across the campaigns whose staffing closed).
- A stored number the campaign no longer has is kept but not used: every dial re-checks it
  against the campaign's usable caller IDs (`resolveCallerId`).
- **Locking.** A new, empty table: no existing table is altered.

**Down** drops the table (every dedication is lost; contacts dial from the rotation again).
**Tests**: `test/integration/db/agent-caller-ids-migration.test.ts` (both uniqueness rules and a
number free on another campaign, the trimmed CHECK and the length, the cascades and SET NULL, the
index definitions, down then up) and the down → up suite.

### 0019 — `migrations/0019_plivo_numbers_and_carrier_pause.sql`

The Plivo dial path's schema (decisions B18–B22; docs/status.md Plivo step 4).

- **Activates** the `plivo` provider row 0002 seeded inactive: numbers, concurrency allocations
  and campaigns may name it.
- **`phone_numbers.telephony_credential_id`** (nullable UUID, FK `fk_phone_numbers_telephony_credential`
  → `telephony_credentials (id)`, RESTRICT) and the partial index
  `idx_phone_numbers_telephony_credential WHERE telephony_credential_id IS NOT NULL`: a number synced
  from a tenant's own carrier account names its credential; NULL is the service's own account. A
  plain FK, not a composite one: this table names its carrier by `provider_id` (uuid) and has no
  tenant column, so no key of `telephony_credentials` matches without a denormalised copy. The one
  writer, `phoneNumberRepository.syncForCredential`, reads the number's provider off the credential
  in SQL; it inserts the account's numbers pinned to the credential and assigns them to the
  credential's tenant with no account tag (every account of the tenant may use them, B20), refuses a
  number already registered on another credential or the service's own account (a conflict, never
  taken over), reactivates the credential's retired numbers the account lists again, and retires
  (never deletes) the ones it no longer lists; all under a `FOR NO KEY UPDATE` lock on an `active`
  credential row. `tenantPhoneAssignmentRepository.findCredentialNumbersForAccount` answers which
  caller IDs a campaign pinned to the credential may use; the account-number reads return the column.
- **`ck_agency_campaign_pause_reason`** gains `carrier_auth`: the carrier refused the campaign's
  credential.
- **Call insert** (repository, no schema change): `webrtcCallRepository.create` with a non-null
  `telephony_credential_id` writes the row only while that credential is `active`, in the INSERT
  itself (`INSERT … SELECT … WHERE EXISTS (… status = 'active' FOR SHARE)`), and otherwise throws
  `TelephonyCredentialNotActiveError` with nothing written; it also takes `provider_request_id`.
- **Locking.** A catalog-only `ADD COLUMN`, a plain `CREATE INDEX` on `phone_numbers` (small), and
  the CHECK swap on `agency_campaigns` (ACCESS EXCLUSIVE, one scan of a small table); one
  transaction, at container start.

**Down** rewrites `carrier_auth` pauses to `supervisor` (the campaign stays paused), restores the
CHECK, drops the index and the column (synced numbers stay, unlinked) and makes `plivo` inactive
again. **Tests**: `test/integration/db/plivo-numbers-migration.test.ts` (the column, its FK and
index, the CHECK, down then up), `test/integration/repositories/phone-number-sync.repository.test.ts`,
`test/integration/repositories/credential-call-insert.repository.test.ts` (including a disable and a
revoke committing while the insert waits), the seed-row case and the down → up suite.

### 0020 — `migrations/0020_carrier_account_unavailable_pause.sql`

A campaign whose carrier account went away (decisions B18–B20).

- **`ck_agency_campaign_pause_reason`** gains `carrier_account_unavailable`: the campaign's pinned
  tenant credential was disabled, marked invalid, revoked or could not be opened after the campaign
  started, so its dial was refused before the carrier (the bridge's `telephony_credential_unavailable`).
  The dialler pauses the campaign on that first refusal (`pauseForCarrierAccount`, running campaigns
  only) instead of holding the contact and cycling the roster; resume stays refused until the
  credential is active again. `carrier_auth` (0019) stays the carrier's own 401.
- **Locking.** The CHECK swap on `agency_campaigns` (ACCESS EXCLUSIVE, one scan of a small table);
  one transaction, at container start.

**Down** rewrites `carrier_account_unavailable` pauses to `carrier_auth` (still paused, still a
carrier-account pause) and restores 0019's CHECK. **Tests**:
`test/integration/db/carrier-account-unavailable-migration.test.ts` (the CHECK, down then up) and the
down → up suite.

### 0021 — `migrations/0021_carrier_refusing_calls_pause.sql`

A campaign whose carrier account keeps refusing its dials (decisions B18–B20, PL11).

- **`ck_agency_campaign_pause_reason`** gains `carrier_refusing_calls`: a campaign pinned to a
  tenant credential whose dials the carrier refused (any status but 401 and 429), or that could not
  be sent for the carrier's configuration, five times in a row with no call placed in between
  (`agency/carrier-refusal-breaker.ts`), is paused (`pauseForCarrierAccount`, running campaigns
  only) instead of spending the roster on refusals. A supervisor resumes it once the account is
  fixed at the carrier; nothing about the credential blocks the resume.
- **Locking.** The CHECK swap on `agency_campaigns` (ACCESS EXCLUSIVE, one scan of a small table);
  one transaction, at container start.

**Down** rewrites `carrier_refusing_calls` pauses to `supervisor` (still paused, resumable) and
restores 0020's CHECK. **Tests**: `test/integration/db/carrier-refusing-calls-migration.test.ts` (the
CHECK, down then up) and the down → up suite.

### 0022 — `migrations/0022_outcome_dispositions.sql`

Automatic outcomes for unanswered calls (`docs/decisions.md`, "Automatic outcomes for unanswered
calls", OD1–OD8).

- **`agency_campaigns.outcome_dispositions`** `JSONB NOT NULL DEFAULT '{}'`: outcome
  (`no_answer | busy | failed | invalid | abandoned`, `AGENCY_AUTO_DISPOSITION_OUTCOMES`) → a
  `disposition_catalog` code. `{}` maps nothing, so every existing campaign is unchanged.
  **`ck_agency_campaign_outcome_dispositions`**: a JSON object. Keys and codes are the server's
  to validate (each code names a catalog entry that neither suppresses nor is terminal).
- **`agency_call_attempts.auto_disposition_code`** `VARCHAR(50)` NULL: the code the dialer stamped
  when the attempt ended with a mapped outcome. Separate from `disposition_code` (what a person
  recorded), which every rate, agent count and wrap-up rule reads (OD4).
  **`ck_agency_attempt_auto_disposition`**: only on an attempt whose `outcome` is one of the five
  (a NULL outcome is refused too). Added **NOT VALID**: every existing row is NULL, so validating
  would scan the largest table under ACCESS EXCLUSIVE to prove nothing; enforced on every write.
- **Locking.** ADD COLUMN without a rewrite on both tables; the campaigns CHECK scans
  `agency_campaigns` once.

**Down** drops both columns and their CHECKs (mappings and stamped automatic outcomes are lost).
**Tests**: `test/integration/db/outcome-dispositions-migration.test.ts` (column shapes and
defaults, both CHECKs including the NULL outcome, a write-up beside an automatic outcome, the
NOT VALID attempts CHECK, down then up) and the down → up suite.

### 0023 — `migrations/0023_reports.sql`

Agent, campaign and account reports (`docs/reports.md`, RP1–RP16).

- **`report_runs`**: one row per run, a PDF and/or workbook about one subject over one window.
  `id`, `tenant_id` (FK `tenants`, CASCADE), `account_id` (nullable, no FK; v1 always sets it),
  `kind` (`agent | campaign | account`), `subject_id` (agent user id, campaign id or account id;
  no FK), `campaign_ids UUID[]` (account runs only, NULL = every campaign), the window twice:
  `local_from` / `local_to` (`DATE`, inclusive, in `timezone`) and `range_from` / `range_to`
  (the half-open instants read), `formats TEXT[]`, `audience` (`supervisor | self`),
  `requested_by` (no FK; NULL for a subscription's run), `email_me`, `subscription_id` (no FK:
  runs outlive their subscription) with `period_start`, `status` (`queued | assembling |
  rendering | ready | failed | expired`), `claim_generation` / `claimed_at` (assembler claim and
  fence), `render_attempt` / `sent_at` (renderer send and callback fence, RP13), `dataset_key`,
  `detail_files` (JSONB array), `files` (JSONB array of `{format, key, bytes}`), `truncated`
  (RP12), `renderer_version`, `error_code` / `error_message`, `notified_at`, `created_at`,
  `finished_at`, `expires_at`.
  CHECKs: kind, status; `self` only on an agent run (RP5); `campaign_ids` only on an account run,
  never empty; **`ck_report_runs_window`**: `range_to > range_from`, `range_to - range_from <=
  745 hours` (31 days plus the hour a clock change adds, RP2, `REPORT_MAX_STORED_WINDOW_MS`) and
  `local_to >= local_from`; formats non-empty within `pdf, xlsx`; a trimmed zone; subscription and
  period set together; non-negative counters; JSONB arrays; an error (a `ReportFailureCode`)
  exactly on a failed run; `finished_at` exactly when terminal, `expires_at` exactly when ready or
  expired.
- **`uq_report_runs_subscription_period`** `(subscription_id, period_start) WHERE subscription_id
  IS NOT NULL`: one run per subscription period (RP14); the tick inserts `ON CONFLICT DO NOTHING`
  on it, and the subscription's newest run is one backward step of it.
- **`idx_report_runs_pending`** `(status, created_at)` partial on the three pending statuses: the
  assembler's claim, the tick's reconcile, the per-tenant pending limit and the gauges.
  **`idx_report_runs_history`** `(tenant_id, account_id, created_at DESC, id DESC)`: the history
  page's keyset. **`idx_report_runs_requester`** `(requested_by, created_at DESC, id DESC)`: a
  caller's own runs and the per-user rate. **`idx_report_runs_unnotified`** `(finished_at)` on
  finished runs that email someone and are not yet handled. **`idx_report_runs_expiry`**
  `(expires_at) WHERE status = 'ready'` (RP8).
- **`report_subscriptions`**: `id`, `tenant_id` (FK, CASCADE), `account_id`, `kind`,
  `subject_id`, `cadence` (`daily | weekly | monthly`), `send_local_time TIME(0)`,
  `send_weekday` (ISO 1–7, weekly only), `send_monthday` (1–28, monthly only), `timezone`,
  `formats`, `recipient_user_ids UUID[]` (1–20), `enabled`, `next_run_at` (NULL exactly when
  disabled, `ck_report_subscriptions_enabled`), `created_by` (no FK), `created_at`,
  `updated_at` (set by the repository's UPDATE; no trigger). **`idx_report_subscriptions_due`**
  `(next_run_at) WHERE enabled`; **`idx_report_subscriptions_account`** `(tenant_id, account_id,
  created_at DESC, id DESC)`.
- **Agent-first read index** for the agent review, which reads one agent's sessions across every
  campaign: **`idx_agency_agent_sessions_agent`** `(agent_user_id, joined_at)`. No agent-first
  rollup index: the review's call figures come from the agent record's attempt reads, and such an
  index draws the allocation counters' campaign-first plan off the unique index.
- **Repositories** (server, B12): `apps/server/src/db/repositories/agency/report-run.repository.ts`
  (claims with `MATERIALIZED` + `SKIP LOCKED`, the per-tenant pending limit under a per-tenant
  advisory lock, every pipeline write fenced on `claim_generation` or `render_attempt`) and
  `report-subscription.repository.ts` (the due claim advances `next_run_at` in the transaction
  that creates the run).
- **Locking.** Two new tables; plain `CREATE INDEX` on `agency_agent_sessions` (SHARE, one
  scan); one transaction, at container start.

**Down** drops the index and both tables (every run record and subscription is lost; files stay
in S3 until their lifecycle). **Tests**: `test/integration/db/reports-migration.test.ts` (columns,
every CHECK including the 745-hour cap at its boundary, the unique period, the cascade, index
definitions, the planner using the agent-first index, down then up), the server's
`test/integration/agency/report-run-repository.test.ts` and
`report-subscription-repository.test.ts`, the table set in `baseline.test.ts` and the down → up
suite.

### 0024 — `migrations/0024_inbound.sql`

Inbound calls on Plivo numbers (`docs/inbound.md` §9, IB1–IB8): everything P1 and the spine need.

- **`agency_inbound_routes`**: an account's route. `id`, `tenant_id` (FK `tenants`, CASCADE),
  `account_id` (no FK, as campaigns'), `name` (trimmed, 1–100), `timezone` (trimmed; a usable IANA
  zone is the server's check), `weekly_hours` / `holidays` (JSONB arrays, at most 50 / 100; elements
  are the server's to validate), six clip ids `greeting_audio_id`, `hold_audio_id`,
  `closed_audio_id`, `busy_audio_id`, `recording_notice_audio_id`, `callback_audio_id` (FK
  `audio_files` ON DELETE SET NULL: a deleted clip puts the slot back on the built-in clip),
  `sticky_mode` (`off | loose | strict`, default `loose`), `sticky_wait_seconds` (5–300, default 30,
  at most `queue_max_wait_seconds`), `sticky_lookback_days` (1–365, default 30), `pool_campaign_ids`
  (UUID[], at most 50, empty = the whole account), `queue_max_wait_seconds` (10–1800, default 120),
  `max_waiting` (0–100, default 10, at most `max_concurrent`), `max_concurrent` (1–500, default
  20), `after_hours_action` / `overflow_action` (`callback | voicemail`, default `callback`),
  `record_calls` (false), `recording_notice` (true, IB7), `analysis_profile_id` (no FK),
  `disposition_catalog` (JSONB array, `[]` = built-in), `created_by`, `updated_by`, `created_at`,
  `updated_at`, `deleted_at` (soft delete), `deleted_by`. **`uq_agency_inbound_routes_name`**
  `(tenant_id, account_id, lower(name)) WHERE deleted_at IS NULL`; `idx_agency_inbound_routes_account`
  `(tenant_id, account_id, created_at) WHERE deleted_at IS NULL`; trigger
  `trg_agency_inbound_routes_updated_at`.
- **`agency_inbound_route_numbers`**: `id`, `route_id` (FK, CASCADE), `phone_number_id` (FK
  `phone_numbers`, RESTRICT), `attached_by`, `attached_at`, `detached_at`, `detached_by`,
  `detached_reason` (`detached | route_deleted | number_unlinked`, set exactly with `detached_at`).
  **`uq_agency_inbound_route_numbers_active`** `(phone_number_id) WHERE detached_at IS NULL`: one
  route answers a number. `idx_agency_inbound_route_numbers_route (route_id) WHERE detached_at IS
  NULL`.
- **`agency_inbound_calls`**, the spine and the Missed inbound row: `id`, `tenant_id`, `account_id`
  (NULL = the tenant default), `route_id`, `phone_number_id`, `provider` (default `plivo`),
  `telephony_credential_id` (composite FK `(credential, tenant, provider)`, RESTRICT, as
  `agency_calls`'), `provider_call_id`, `from_e164` (NULL = withheld), `to_e164`,
  `matched_contact_id`, `matched_campaign_id`, `caller_dnc`, `sticky_user_id`, `sticky_reason`,
  `state` (`arrived | greeting | queued | offered | connected | ended`), `outcome` (`answered |
  abandoned_in_queue | overflow | overflow_no_capacity | closed | voicemail | rejected | failed`),
  `arrived_at`, `answered_at`, `bridged_at`, `answered_by_user_id`, `ended_at`, `talk_seconds`,
  `webrtc_call_id`, `voicemail_key`, `callback_due_at`, `follow_up_status` (`open | handled`),
  `follow_up_reason` (`closed | abandoned_in_queue | overflow | overflow_no_capacity | failed`),
  `follow_up_assignee_user_id`, `handled_by_user_id`, `handled_at`, `created_at`, `updated_at`. No
  FK but the credential's (an audit spine). CHECKs: each vocabulary (the contract's lists in
  `packages/contracts/src/agency/inbound.ts`); E.164 numbers; a route, a match or a leg only with an
  account; a match is contact and campaign together, a callback only on a match; ended exactly with
  an outcome and `ended_at`; bridged exactly with its agent, `connected` and `answered` only once
  bridged; the sticky pair together; the follow-up only on an ended call that is not `answered` or
  `rejected`, status and reason together, an assignee only with one, `handled_at` exactly when
  handled. **`uq_agency_inbound_calls_provider_call`** `(provider, provider_call_id)` (a retried
  answer webhook finds its row); `idx_agency_inbound_calls_missed` `(tenant_id, account_id,
  follow_up_status, arrived_at DESC, id DESC)` and `idx_agency_inbound_calls_missed_assignee` (with
  the assignee after the account), both `WHERE follow_up_status IS NOT NULL`;
  `idx_agency_inbound_calls_open (arrived_at) WHERE state <> 'ended'` (the sweep). Trigger
  `trg_agency_inbound_calls_updated_at`.
- **`agency_calls`**: `inbound_call_id` (no FK); `ck_agency_calls_origin` rewritten to `campaign |
  manual | inbound`; `ck_agency_calls_inbound_correlation` (`inbound_call_id` exactly on an inbound
  leg). `ck_agency_calls_manual_correlation` is unchanged: its arms already keep an inbound leg's
  `campaign_id`, `agency_attempt_id` and `manual_call_id` NULL. No new index: the baseline's
  `idx_agency_calls_provider_call_id` serves the status webhook.
- **`agency_contacts`**: `callback_source` (`inbound`) and `callback_due_at`, together
  (`ck_agency_contact_callback_source`).
- **`agency_campaigns`**: `inbound_sticky_enabled BOOLEAN NOT NULL DEFAULT true`.
- **`telephony_credentials`**: `inbound_app_id`, `inbound_answer_url`, `inbound_hangup_url`,
  `inbound_fallback_answer_url` (without the token query), `inbound_token_hash` (sha256 hex),
  `inbound_previous_token_hash` with `inbound_previous_token_expires_at` (the Re-point grace),
  `inbound_enabled_at`. CHECKs: all of the enabled set or none; hashes are 64 lower-case hex; the
  previous pair together and only beside a current token; a revoked credential has no Application.
- **`phone_numbers`**: `inbound_linked_at` (only on a synced number) and `inbound_previous_app_id`
  (only while linked); `idx_phone_numbers_inbound_linked (telephony_credential_id) WHERE
  inbound_linked_at IS NOT NULL`.
- **Locking**: the `agency_calls` and `agency_contacts` CHECKs are added `NOT VALID` (no scan under
  ACCESS EXCLUSIVE; 0025 validates them). The small tables' CHECKs are validated here.
- **Down** raises, before changing anything, while any inbound call or `origin = 'inbound'` leg
  exists, or while a number is linked or a credential has inbound enabled; otherwise it drops the
  columns and tables and restores the two-value origin CHECK.

### 0025 — `migrations/0025_inbound_checks_validate.sql`

Validates 0024's three `NOT VALID` CHECKs (`ck_agency_calls_origin`,
`ck_agency_calls_inbound_correlation`, `ck_agency_contact_callback_source`) in its own transaction
under SHARE UPDATE EXCLUSIVE (0010's pattern). Down is a no-op.

**Tests** for both: `test/integration/db/inbound-migration.test.ts` (columns and defaults against
`AGENCY_INBOUND_ROUTE_DEFAULTS`, every CHECK from both sides, each vocabulary against the contract's
list, every limit, the unique indexes, the FKs and their ON DELETE, the indexes and that the planner
uses them, NOT VALID then validated, the Down's refusals, down then up), the server's
`test/integration/agency/inbound-route-repository.test.ts` and `inbound-call-repository.test.ts`,
`test/integration/repositories/telephony-credential.repository.test.ts` (the inbound storage), the
table set and triggers in `baseline.test.ts` and the down → up suite.

### 0026 — `migrations/0026_inbound_live_indexes.sql`

Inbound calls counted in their account's live-call total (`docs/inbound.md` §5.3, decision IB5),
and the inbound callbacks the callback fallback reads (§7, CA5). (Numbered 0026 after review: it was
first written as 0027 and never applied outside development databases; the next migration is 0027.)

- **`idx_agency_inbound_calls_account_live`** `(tenant_id, account_id) WHERE state <> 'ended' AND
  state <> 'arrived'`: the third arm of pacing's per-account live read (`countLiveForAccount`,
  every pacing round), partial on the arm's literal predicate. Only admitted calls count: one still
  `arrived` was turned away (the route at its `max_concurrent`, or the bridge's global or carrier
  scope full, whose admission is taken back) and holds no line. 0024's
  `idx_agency_inbound_calls_open` is keyed on `arrived_at` alone and would walk every tenant's
  live inbound calls each round. The answer webhook's per-route admission count (once per call,
  the same predicate) stays on `idx_agency_inbound_calls_open`.
- **`idx_agency_contacts_inbound_callback`** `(campaign_id) WHERE callback_source IS NOT NULL`: a
  campaign's open inbound callbacks. CA5's fallback sweep runs on every running owner-mode
  campaign every 30 s; on a catalog with no callback code its pick adds `callback_source IS NOT
  NULL` (implied by the bucket there, so the same rows move) and reads this index instead of the
  campaign's pending roster. Empty for a tenant with no inbound; its columns are already indexed
  elsewhere, so it costs no HOT update.
- **`idx_agency_contacts_insights`** (0011) rebuilt with `callback_source` added to its INCLUDE
  list: the inbound follow-up widens `isCallbackSql` to read it, and the insights as-of-now reads
  bucket every contact through that fragment, so without it they would leave their index-only
  scan. Same name, key and comment.
- **Locking.** Plain `CREATE INDEX` (SHARE on the table, one scan each; `agency_contacts` scanned
  twice, each of the size 0011 measured for the insights index, ~4 s on 1.2M contacts); the
  insights index is built under a temporary name, then the old one dropped and the new one
  renamed, so ACCESS EXCLUSIVE is held only from the swap to the commit. One transaction, at
  container start, with no writer running: a deploy stops the one server, then the new container
  migrates before it listens (`DEPLOYMENT.md`), the model 0003, 0004, 0015, 0016 and 0017 rely on.
  A deploy that overlapped the old process would have pacing's contact writes wait for the scans;
  that layout is not supported by these files.

**Down** drops both partial indexes and rebuilds the insights index exactly as 0011 made it (the
same swap). **Tests**: `test/integration/db/inbound-live-indexes-migration.test.ts` (the three
definitions, the planner using the live index on a large history with a busy floor elsewhere and
the callback index for the code-less fallback pick on a large pending roster, down restoring
0011's insights index, up again), `insights-foundation-migration.test.ts` (the definition after
every migration), the down → up suite, the server's `test/integration/agency/insights-reads.test.ts`
(the as-of-now reads still covered) and `inbound-follow-up.test.ts` (the count itself).

### 0027 — `migrations/0027_inbound_connect.sql`

Connecting agents to inbound calls (`docs/inbound.md` §2, §6, P2): the agent side of the spine.

- **`agency_inbound_calls`** gains `session_id` (the agent session it is offered to or connected
  with; no FK; cleared by a requeue), `queued_at` (first queueing: the maximum wait counts from it),
  `offered_at` (the latest offer), `offer_count` (`SMALLINT NOT NULL DEFAULT 0`),
  `recording_requested` (`BOOLEAN NOT NULL DEFAULT false`, the leg's, mirrored at arrival), the
  outcome as the soft phone's (`disposition_code` VARCHAR(64), `disposition_source` `campaign |
  route`, `notes`, `callback_at`, `dispositioned_by_user_id`, `dispositioned_at`,
  `dispositioned_on_behalf` `BOOLEAN NOT NULL DEFAULT false`), `settled_at`, `voicemail_seconds`
  and `clash_attempt_id` (the ringing attempt the call cancelled, §5.4; no FK).
- **CHECKs**: `ck_agency_inbound_calls_session` (`offered` / `connected` ⇒ a session, `offered_at`
  and an offer; `arrived` / `greeting` / `queued` ⇒ no session; `offer_count >= 0`);
  `ck_agency_inbound_calls_settled` (settled only once ended; an ended call offered to a session
  but never bridged is settled, so the session is free); `ck_agency_inbound_calls_disposition` (an outcome only on a bridged call, with its
  source and time; the source only with a code, `campaign` exactly when the call matched a
  campaign; who saved it and on behalf only with a code); `ck_agency_inbound_calls_voicemail` (a
  length only with the voicemail, never negative). Added validated (the table is small, and the
  file already holds ACCESS EXCLUSIVE for the columns).
- **`uq_agency_inbound_calls_session_unsettled`** `(session_id) WHERE session_id IS NOT NULL AND
  settled_at IS NULL`: one unsettled inbound call per agent session (the soft phone's
  `uq_agency_manual_call_unsettled` rule).
- **`idx_agency_inbound_calls_live_from_digits`** `(tenant_id, account_id,
  regexp_replace(from_e164, '[^0-9]', '', 'g')) WHERE from_e164 IS NOT NULL AND ((state <> 'ended'
  AND state <> 'arrived') OR (bridged_at IS NOT NULL AND settled_at IS NULL))`: the inbound arm of
  the account's busy probe (`numberLiveSql`, MC4) and the soft phone's pre-dial; the key is
  `CONTACT_PHONE_DIGITS_SQL` with the column swapped. `arrived` is "not admitted" (0026's rule).
- **`idx_agency_inbound_calls_unsettled_lapse`** `(ended_at) WHERE bridged_at IS NOT NULL AND
  settled_at IS NULL`: the outcome-lapse sweep.
- **Backfill**: every row 0024 ended is settled at its `ended_at` (P1 connected nobody), and
  `recording_requested` is copied from the leg; `updated_at` is kept (the trigger is disabled
  around the two UPDATEs).

**Down** refuses while any call is with an agent or owes its outcome (`session_id` set and
unsettled), or carries an outcome, notes or a callback; otherwise drops the indexes, CHECKs and
columns. **Tests**: `test/integration/db/inbound-connect-migration.test.ts` (columns and defaults,
every CHECK from both sides, the disposition sources against the contract's list, the unique
index, both partial indexes by definition and by the planner on a large history, the backfill,
the Down's refusals, down then up), the down → up suite, and the server's
`test/integration/agency/inbound-connect-repository.test.ts`.

### 0028 — `migrations/0028_inbound_missed_follow_up.sql`

The Missed inbound row's follow-up and the inbound summary (`docs/inbound.md` §7, §11).

- **`agency_inbound_calls.handled_reason`** VARCHAR(16): how a Missed row was handled, `marked`
  (a person) or `reached` (the customer was put through to an agent afterwards). NULL while open,
  and on a row handled before 0028 (read as `marked`). `ck_agency_inbound_calls_handled_reason`:
  NULL, or the row is `handled` and the reason is one of the contract's
  `AGENCY_INBOUND_HANDLED_REASONS`.
- **The reached triggers**: when `bridged_at` is first set on a campaign attempt, a soft-phone
  call or an inbound call, `agency_inbound_close_reached_missed` closes the open Missed rows of
  the same account from that number (the contact's `phone_e164`, the soft-phone call's
  `destination_e164`, the caller's `from_e164`) that arrived no later than the conversation began,
  handled by its agent (the attempt's session's `agent_user_id`, the soft-phone call's
  `agent_user_id`, the inbound call's `answered_by_user_id`). In the transaction that records the
  conversation; `follow_up_status = 'open'` in the UPDATE's WHERE, so two conversations at once,
  or one beside a person's Mark handled, close a row once. The contact is never touched (its
  inbound callback is settled by the call that reaches it).
- **`idx_agency_inbound_calls_missed_open_from`** `(tenant_id, account_id, from_e164) WHERE
  follow_up_status = 'open' AND from_e164 IS NOT NULL`: the triggers' probe, the size of the open
  follow-ups.
- **`idx_agency_inbound_calls_account_arrived`** `(tenant_id, account_id, arrived_at) WHERE state =
  'ended'`: the inbound summary's range read (ended calls only, the predicate repeated literally).
  Partial so it never offers the Missed list a backward scan to prefer over
  `idx_agency_inbound_calls_missed`.

**Down** drops the triggers, the functions, the indexes and the column (a reached row stays
handled, with no reason). **Tests**: `test/integration/db/inbound-missed-follow-up-migration.test.ts`
(the CHECK against the contract's list, each trigger and what it leaves alone, two closes at once
and a close beside a Mark handled, both indexes by definition and by the planner over a 40-account
history, down then up), the trigger list in `baseline.test.ts`, the down → up suite, and the
server's `test/integration/api/inbound-missed-work.test.ts`.

### 0029 — `migrations/0029_inbound_reach_settles.sql`

A reached inbound call settles the callback a missed call booked, and the spine keeps what the
carrier bills (`docs/inbound.md` §6, §7, §9).

- **`agency_contacts.callback_reopened`** BOOLEAN NOT NULL DEFAULT false (a constant default:
  catalog-only, no rewrite): the contact's inbound callback (`callback_source`) reopened it from
  `exhausted` (IB4). Written by `bookInboundCallback` (true when it reopens; a second booking keeps
  it; any other booking false), cleared by `settleFromInbound`, whose `none` arm (a retry or plain
  outcome, or the outcome lapsing) puts such a contact back to `exhausted`. Meaningful only while
  `callback_source` is set (other writers that clear the callback leave it; the next booking
  rewrites it). No index: read on a row already locked by primary key.
- **`agency_inbound_calls.carrier_seconds`** INTEGER, NULL until known:
  the carrier's duration of the call from its hangup callback (Plivo `Duration`).
  `ck_agency_inbound_calls_carrier_seconds`: NULL or ≥ 0. The usage report's `inbound_seconds`
  sums it when set, else `ended_at - answered_at` (a spoken answer ends on our side at the answer).

**Down** drops both columns and the CHECK. **Tests**:
`test/integration/db/inbound-reach-settles-migration.test.ts` (the columns, the CHECK, no rewrite
of `agency_contacts`, down then up), `test/integration/repositories/usage-counts-inbound-carrier.test.ts`,
the down → up suite, and the server's `inbound-agent-return.test.ts` (SWE-F2) and
`inbound-follow-up.test.ts`.

### 0030 — `migrations/0030_inbound_reached_on_outcome.sql`

A Missed inbound row closes as `reached` only when a person was reached, matched on the number's
digits; and why a call was answered closed (`docs/inbound.md` §7, §11).

- **The outbound reached triggers move to the outcome.** `trg_agency_attempts_inbound_reached` and
  `trg_agency_manual_calls_inbound_reached` are dropped and re-created `AFTER UPDATE OF
  disposition_code`: they fire when the outcome is written or changed to a code other than
  `voicemail` (a machine answered), `no_disposition` (the outcome lapsed) and `redialed` (a wrap-up
  redial carries the outcome), the connect rate's human connect, on a conversation (an attempt
  bridged or a wrap-up redial; a bridged soft-phone call). The attempt's conversation began at
  `COALESCE(bridged_at, dialed_at, created_at)`. The WHEN carries the whole rule, so every other
  write to the hot tables queues nothing. The inbound call's trigger is unchanged (at its bridge).
- **Digits.** `agency_inbound_close_reached_missed` compares `regexp_replace(…, '[^0-9]', '', 'g')`
  of both sides; `idx_agency_inbound_calls_missed_open_from` is replaced by
  **`idx_agency_inbound_calls_missed_open_digits`** `(tenant_id, account_id, <digits of from_e164>)
  WHERE follow_up_status = 'open' AND from_e164 IS NOT NULL` (CONTACT_PHONE_DIGITS_SQL with the
  column swapped, byte for byte).
- **`agency_inbound_calls.closed_cause`** VARCHAR(24): `hours`, `switched_off`, `no_route`,
  `credential_inactive` (the contract's `AGENCY_INBOUND_CLOSED_CAUSES`,
  `ck_agency_inbound_calls_closed_cause`), stamped by the router at arrival; NULL when the route
  was open. Backfill (the `updated_at` trigger disabled around it): a closed call (outcome `closed`,
  or a voicemail whose Missed reason is `closed`) is `no_route` without a route, else `hours`.

**Down** restores 0028 exactly (the bridge triggers and their function bodies, the text match, the
text index) and drops the column. **Tests**:
`test/integration/db/inbound-reached-on-outcome-migration.test.ts` (each trigger's rule and what it
leaves alone, a redial, a changed and a replayed outcome, digits, two closes at once and a close
beside a Mark handled, the index by definition and by the planner, the CHECK against the contract's
list, the backfill, down then up), the down → up suite, and the server's
`test/integration/agency/inbound-missed-reached.test.ts` (the no-contact codes are the server's
constants) and `test/integration/api/inbound-missed-work.test.ts`.

### 0031 — `migrations/0031_ingest_dedupe_columns.sql`

Roster upload, combining duplicate columns. **`agency_ingest_jobs.dedupe_columns`** `TEXT[] NULL`,
`ck_agency_ingest_jobs_dedupe_columns` (NULL, or 1 to 3 elements: the contract's
`AGENCY_MAX_DEDUPE_COLUMNS`; no NULL or empty element): the headers that together mark a duplicate row, in the operator's
order. A row is a duplicate only when every one matches an earlier accepted row (each trimmed and
case-insensitive; the phone column by its normalised number); a row with any of them blank is never
a duplicate. NULL: `dedupe_phones` decides, as before. The Up backfills it from 0007's
`dedupe_column`, which is superseded: no longer written or read. The backfill and the Down's copy
run with `agency_ingest_jobs_updated_at` disabled, so no job's `updated_at` (the running job's
heartbeat, `reapStaleJobs`) moves. Written by
`POST /proxy/agency/ingest/jobs` (`dedupe_columns`, or the single `dedupe_column`), read by the
ingest service, the job payload, the audit row and the insights reads. No index; the table holds
one row per upload. **Down** writes the first column back to `dedupe_column` where it is NULL (a
single key exactly; a combination keeps its first column, a record of a finished upload) and drops
the CHECK and the column. **Tests**: `test/integration/db/ingest-dedupe-columns-migration.test.ts`
(shape, the CHECK, the backfill, `updated_at` left alone, down then up) and the down → up inventory suite.

## Tests

`pnpm test:integration` in `packages/db` runs `test/integration/baseline.test.ts` and
`baseline-down-up.test.ts`. They cover:

- the table set, column shapes, nullability, state CHECKs, JSONB guards and cascades;
- every unique index above, including all live-state pairs of `uq_agency_attempt_live` and its exact
  definition, `uq_agency_campaign_running` (absent after 0015) and `uq_agency_agent_live_tenant`;
- every `updated_at` trigger firing (with backdated rows, so the check cannot pass vacuously);
- the root-stamping trigger and the retry-lineage columns and indexes;
- the fingerprint function (definition, `NOT STRICT`, `STABLE`, collision behaviour);
- the DNC indexes, the staffing index, the analysis job constraints, the PCM columns;
- UUID typing; enum values and order; audit partition sets and routing for both tables;
- exactly one up and one down marker;
- down then up through node-pg-migrate's runner, comparing a full object inventory (relations,
  functions, enum types, triggers, extensions) before and after;
- the seed rows (asserted only in `baseline-down-up.test.ts`, because `truncateAll` empties
  `telephony_providers`).

## Notes

- `membership_role` values are, in order: `tenant_owner, tenant_admin, account_admin, operator,
  viewer, agent`. The level-5 position of `agent` lives in `packages/contracts/src/rbac.ts`, never
  in enum order.
- The two audit tables differ in shape (`ip_address` `TEXT` vs `INET`; `created_at` vs `timestamp`);
  the merged activity-trail query handles both.
- `uq_agency_agent_live_tenant` (one live session per agent per tenant) is the session constraint;
  there is no per-campaign variant.

## Open questions

1. **Actor-label columns as `UUID`.** `dnc_entries.added_by`, `agency_dnc_outbox.added_by` and
   `agency_ingest_chunks.ingest_job_id` are text. Converting them needs a check that every imported
   value parses.
2. **Foreign-key candidates**, none added yet: `agency_ingest_jobs.campaign_id`,
   `agency_campaign_agents.campaign_id` and `dnc_entries.campaign_id` → `agency_campaigns(id)` (DNC
   must not cascade: the record outlives the campaign); `agency_ingest_chunks.ingest_job_id` →
   `agency_ingest_jobs(id)`; `agency_agent_sessions.agent_user_id`,
   `agency_agent_session_events.agent_user_id`, `agency_call_attempts.dispositioned_by_user_id` →
   `users(id)`; `tenant_id` / `account_id` on `account_settings`, `agency_campaigns`,
   `call_analysis_profiles`, `audio_files`, `announcements`, `feature_flag_overrides` → `tenants` /
   `accounts`. Deliberately without FKs: `agency_call_attempts.webrtc_call_id`,
   `agency_calls.campaign_id` / `agency_attempt_id`, `agency_campaigns.abandon_announcement_id` and
   `analysis_profile_id`, `dialer_analysis_jobs.profile_id`, the `root_*` grouping keys,
   `agency_dnc_outbox.campaign_id`, `membership_invites.claimed_by_user_id` / `invited_by`,
   `audit_logs.call_id`.
3. **`source_row_number`** and `uq_agency_contacts_source_row` are legacy and not written; drop them
   once the launch import has decided whether to keep historic values. Before any roster-replace
   feature (decision B15), the fingerprint index must become partial on liveness.
4. **`users.phone_number`** keeps a placeholder default `'0000000000'`; confirm it is still wanted.
5. **Imported clips.** `announcements.type` allows only `'audio'`; at launch, any imported campaign
   whose abandon announcement was text-to-speech needs the clip rendered to a file, or its
   `abandon_announcement_id` set to NULL (the campaign then hangs up silently).
6. **A catalog that already uses the code `redialed`.** 0008 reserves `redialed` as the system
   disposition of a redialled attempt (`AGENCY_REDIALED_DISPOSITION_CODE`), and the campaign config
   validation refuses it from now on. A campaign created before 0008 whose `disposition_catalog`
   already carries `redialed` is NOT migrated: its catalog keeps the entry, and a write that
   re-validates the catalog is refused until it is renamed. Attempts such a campaign dispositioned
   `redialed` by hand read, to the campaign stats, as redialled originals (not counted as a
   conversation). Check imported catalogs for the code before launch.
