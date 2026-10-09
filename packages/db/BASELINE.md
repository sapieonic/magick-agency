# Baseline schema — `migrations/0001_baseline.sql`

The whole database schema of Magick Agency is one migration. This file is its inventory: the rules
it follows, every table with its purpose and columns, the unique indexes that carry invariants, the
triggers and functions, how it is tested, and the schema questions still open. Read it before
writing a repository, a migration or an import script. Column lists are generated from the SQL;
the SQL is the authority. As of 2026-10-09.

## Rules

- **One file, one transaction.** node-pg-migrate splits SQL files on
  `/^\s*--[\s-]*(up|down)\s+migration/im`; the file has exactly one of each marker, and a test
  asserts that. Later schema changes go in new numbered migrations; never edit an applied one.
- **Ids.** Every tenant, account and user id column is `UUID`. Free-form actor labels (for example
  `dnc_entries.added_by`, `agency_dnc_outbox.added_by`, `agency_calls.initiated_by`) are text.
- **Foreign keys** only where the table pairs need them; see the open questions for candidates.
- **Seed.** One reference row, `telephony_providers ('voicelink', 'VoiceLink')`. No super-admin.
- **Extension** `uuid-ossp` for `uuid_generate_v4()` defaults (`audit_logs`, `audio_files`,
  `announcements`); other ids use the built-in `gen_random_uuid()`.

## Tables

33 tables, plus monthly partitions 2026-01 to 2027-12 and a DEFAULT partition for each of the two audit tables.

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

**`phone_numbers`**. The phone-number inventory for agency's VoiceLink account.

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

**`agency_ingest_jobs`**. CSV roster ingest jobs: the S3 object, column mapping, progress counters, rejected-rows export, status and errors.

Columns: `id`, `tenant_id`, `account_id`, `campaign_id`, `s3_key`, `file_name`, `file_size_bytes`, `phone_column`, `timezone_column`, `ignore_columns`, `default_country_code`, `dedupe_phones`, `dry_run`, `status`, `cancel_requested`, `rows_read`, `accepted`, `rejected`, `duplicates`, `rejected_by_reason`, `bytes_read`, `chunks_sent`, `chunks_total`, `headers`, `context_columns`, `rejected_s3_key`, `rejected_row_count`, `rejected_truncated`, `error_code`, `error_message`, `created_by`, `created_at`, `started_at`, `finished_at`, `updated_at`, `core_rejected_duplicate_rows`, `core_duplicate_source_rows`, `core_rejected_duplicate_rows_may_undercount`, `mode`, `replace_superseded_contacts`, `replace_superseded_uncertain`.

**`agency_campaign_agents`**. Staffing: which agents are assigned to which campaign, and when.

Columns: `id`, `tenant_id`, `account_id`, `campaign_id`, `user_id`, `assigned_by`, `assigned_at`, `unassigned_at`, `created_at`, `updated_at`.

### Settings, guard and flags

**`account_settings`**. Per-account settings: `max_concurrent_calls`, `analyze_calls`, `allow_recording`, `webrtc_max_duration_seconds` (NULL = process default; CHECK `> 0`), and the concurrency allocation mode and version.

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

**`agency_campaigns`**. A campaign: caller IDs, calling window and days, timezone, wrap-up, retry policy, disposition catalog, recording, analysis profile, context display, status, break reasons, abandon announcement, abandonment ceiling and pause reason, retry lineage. `telephony_provider` defaults to `'voicelink'`. One running campaign per account (`uq_agency_campaign_running`).

Columns: `id`, `tenant_id`, `account_id`, `name`, `caller_ids`, `telephony_provider`, `calling_window_start`, `calling_window_end`, `calling_days`, `default_timezone`, `wrapup_seconds`, `wrapup_auto_return`, `retry_policy`, `disposition_catalog`, `record_calls`, `analysis_profile_id`, `context_display`, `status`, `contacts_total`, `created_by`, `started_at`, `completed_at`, `created_at`, `updated_at`, `break_reasons`, `abandon_announcement_id`, `abandonment_ceiling_pct`, `pause_reason`, `paused_at`, `pause_abandonment_rate_pct`, `ended_at`, `last_transition_by_user_id`, `last_transition_by_name`, `parent_campaign_id`, `root_campaign_id`, `retry_generation`, `retry_selector`, `retry_idempotency_key`.

**`agency_contacts`**. Roster contacts: E.164 phone, context, timezone, state, attempt counts, last outcome and disposition, next attempt, DNC suppression, row fingerprint, and retry lineage (`source_contact_id`, `root_contact_id`). `source_row_number` is a legacy column, not written.

Columns: `id`, `campaign_id`, `tenant_id`, `account_id`, `phone_e164`, `context`, `source_row_number`, `timezone`, `state`, `attempt_count`, `last_outcome`, `last_disposition`, `next_attempt_at`, `suppressed_reason`, `created_at`, `updated_at`, `our_fault_attempts`, `row_fingerprint`, `csv_line_number`, `source_contact_id`, `root_contact_id`.

**`agency_agent_sessions`**. An agent's session on a campaign: state mirror, break reason, owning replica, heartbeat. One live session per agent per tenant (`uq_agency_agent_live_tenant`).

Columns: `id`, `tenant_id`, `account_id`, `campaign_id`, `agent_user_id`, `state`, `break_reason`, `state_since`, `owner_replica`, `last_heartbeat`, `joined_at`, `left_at`, `created_at`, `updated_at`.

**`agency_agent_session_events`**. Agent state transitions, for seat-time reporting.

Columns: `id`, `session_id`, `tenant_id`, `account_id`, `campaign_id`, `agent_user_id`, `from_state`, `to_state`, `break_reason`, `at`.

**`agency_call_attempts`**. One row per dial: reserved agent, state, outcome, disposition, callback, `dialed_at` / `answered_at` / `bridged_at` / `ended_at`, talk and wrap-up seconds. One live attempt per contact (`uq_agency_attempt_live`).

Columns: `id`, `campaign_id`, `contact_id`, `tenant_id`, `account_id`, `attempt_number`, `webrtc_call_id`, `caller_id`, `reserved_agent_id`, `state`, `outcome`, `disposition_code`, `notes`, `callback_at`, `dialed_at`, `answered_at`, `bridged_at`, `ended_at`, `talk_seconds`, `wrapup_seconds`, `created_at`, `updated_at`, `dispositioned_by_user_id`, `dispositioned_at`, `dispositioned_on_behalf`, `wrapup_started_at`, `wrapup_ended_at`, `wrapup_resolution`, `abandon_reason`, `wrapup_resolution`.

**`agency_ingest_chunks`**. Idempotent roster chunks applied by an ingest job.

Columns: `id`, `campaign_id`, `ingest_job_id`, `chunk_index`, `idempotency_key`, `chunk_count`, `row_count`, `applied_at`, `created_at`, `rejected_duplicate_rows`, `duplicate_source_rows`.

**`agency_dnc_outbox`**. Reserved for mirroring DNC changes to the previous platform during a launch rollback window. Nothing writes it (decision B8).

Columns: `id`, `tenant_id`, `phone_e164`, `reason`, `added_by`, `status`, `attempts`, `attempts_total`, `claim_generation`, `claimed_at`, `heartbeat_at`, `next_attempt_at`, `pending_since`, `landed_at`, `error_code`, `error_message`, `created_at`, `updated_at`, `campaign_id`.

**`agency_calls`**. A bridged call: carrier ids, status and outcome, timings, recording, analysis status and result, conversation log, transcript metadata. `provider` defaults to `'voicelink'`.

Columns: `id`, `tenant_id`, `account_id`, `caller_id`, `destination_phone`, `provider`, `provider_call_id`, `status`, `outcome`, `error_code`, `error_message`, `initiated_by`, `metadata`, `answered_at`, `ended_at`, `duration_seconds`, `talk_time_seconds`, `created_at`, `updated_at`, `recording_requested`, `recording_url`, `recording_duration_seconds`, `analysis_profile_id`, `analysis_language`, `analysis_status`, `call_analysis`, `conversation_log`, `transcript_meta`, `analysis_consent`, `analysis_consent_at`, `campaign_id`, `agency_attempt_id`, `status`, `analysis_status`.

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
| `uq_agency_campaign_running` | `agency_campaigns` |
| `uq_agency_campaign_retry_idempotency` | `agency_campaigns` |
| `uq_agency_contacts_source_row` | `agency_contacts` |
| `uq_agency_contacts_row_fingerprint` | `agency_contacts` |
| `uq_agency_agent_live_tenant` | `agency_agent_sessions` |
| `uq_agency_attempt_number` | `agency_call_attempts` |
| `uq_agency_attempt_live` | `agency_call_attempts` |
| `uq_agency_ingest_chunk` | `agency_ingest_chunks` |
| `uq_dialer_analysis_jobs_call` | `dialer_analysis_jobs` |

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
| `trg_agency_contacts_updated_at` | BEFORE UPDATE | `agency_contacts` | `update_updated_at()` |
| `trg_agency_contacts_root` | BEFORE INSERT | `agency_contacts` | `agency_contact_stamp_root()` |
| `trg_agency_agent_sessions_updated_at` | BEFORE UPDATE | `agency_agent_sessions` | `update_updated_at()` |
| `trg_agency_call_attempts_updated_at` | BEFORE UPDATE | `agency_call_attempts` | `update_updated_at()` |
| `trg_agency_dnc_outbox_updated_at` | BEFORE UPDATE | `agency_dnc_outbox` | `update_updated_at()` |
| `trg_agency_calls_updated_at` | BEFORE UPDATE | `agency_calls` | `update_updated_at()` |
| `trg_dialer_analysis_jobs_updated_at` | BEFORE UPDATE | `dialer_analysis_jobs` | `update_updated_at()` |

Functions:

- `update_updated_at()`: stamps `updated_at` on every update.
- `agency_contact_stamp_root()`: on insert, sets `root_contact_id = id` when the row has none, so a
  retry lineage always has a root.
- `agency_contact_row_fingerprint(VARCHAR, JSONB, VARCHAR)`: called by the ingest INSERT to fingerprint
  a roster row. It is a function only; no trigger calls it.

`super_admins` and `account_settings` have `updated_at` columns but no trigger.

## Partition maintenance

The migration creates monthly partitions to 2027-12 and a DEFAULT partition on each audit table.
Creating later months and dropping aged months is the runtime job
`apps/server/src/audit/audit-partition-maintenance.ts` (daily; `AUDIT_RETENTION_DAYS`, default 85).
Rows for a month with no partition land in DEFAULT; a month whose rows are already in DEFAULT cannot
be attached as a partition until those rows are moved.

## Tests

`pnpm test:integration` in `packages/db` runs `test/integration/baseline.test.ts` and
`baseline-down-up.test.ts`. They cover:

- the table set, column shapes, nullability, state CHECKs, JSONB guards and cascades;
- every unique index above, including all live-state pairs of `uq_agency_attempt_live` and its exact
  definition, `uq_agency_campaign_running` and `uq_agency_agent_live_tenant`;
- every `updated_at` trigger firing (with backdated rows, so the check cannot pass vacuously);
- the root-stamping trigger and the retry-lineage columns and indexes;
- the fingerprint function (definition, `NOT STRICT`, `STABLE`, collision behaviour);
- the DNC indexes, the staffing index, the analysis job constraints, the PCM columns;
- UUID typing; enum values and order; audit partition sets and routing for both tables;
- exactly one up and one down marker;
- down then up through node-pg-migrate's runner, comparing a full object inventory (relations,
  functions, enum types, triggers, extensions) before and after;
- the single seed row (asserted only in `baseline-down-up.test.ts`, because `truncateAll` empties
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
