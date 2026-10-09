# packages/contracts — porting record

Sources, all read-only submodules of `MagickVoice-platform`, at:

| Repo | Version | Commit |
|---|---|---|
| `magic-voice-core` | v1.123.2 | `4850d1d9ffc9eb9eab56d2ed482b9bd616edd103` |
| `magick-master` | v3.24.0 | `a1f0756a58a63bf8a19baf74298a702f9fe7b430` |
| `magick-comms-cusui` | v2.96.0 | `ee5beb4400ec1fb5fdf6049871681ae6875e8d29` |

Below, `core@4850d1d`, `master@a1f0756`, `cusui@ee5beb4` abbreviate those.
Every changed line in a ported file is marked `PORT NOTE` in place.

## 1. Files

| Source | Destination | Status | Reason |
|---|---|---|---|
| `core@4850d1d:src/agency/contracts.ts` | `src/agency.ts` | modified | `credits_low` removed; `AGENCY_CORE_STALL_CODES` folded into `AGENCY_STALL_PRIORITY`; billing-only shapes deleted (§2). Everything else byte-for-byte. |
| `core@4850d1d:src/agency/agency-s2s-contract.fixture.json` (`actionErrorCodes.codes`) | `test/errors.test.ts` (snapshot) | modified | The 18 codes copied as a test snapshot. The fixture's other six seams are master↔core S2S and retire (plan §1). |
| `master@a1f0756:src/agency/agency-action-errors.ts` | `src/errors.ts` §1 | modified | The list + the two-sided trick (`:87-94`). The union is re-exported from `./agency` (core's, the authority) instead of mirrored. |
| `master@a1f0756:src/agency/agency-roster-errors.ts` | `src/errors.ts` §2 | modified | Union, list and guard verbatim; master-specific header condensed. |
| `master@a1f0756:src/api/middleware/error-mask.middleware.ts` (`:139-141, :163-164, :220, :247`) | `src/errors.ts` §3 | modified | Seven individually allow-listed strings became a union + list (`AgencyCampaignLifecycleErrorCode`). |
| `core@4850d1d:src/agency/contracts.ts` (`AgencyStationErrorCode`) | `src/errors.ts` §4 | modified | Union re-exported; runtime list added. |
| `core@4850d1d:src/feature-flags/registry.ts` (`:15-37`, `:389-440`, `:686-702`, `:704-751`) | `src/flags.ts` | modified | Three definitions verbatim (keys, defaults, scopes, `envVar`, `clientExposed`, owner, description, comments); `defineFlag`'s `Map` registry and `process.env` resolution not ported (no Node APIs in this package); `validate` dropped from the interface (unused by these three). |
| `master@a1f0756:src/rbac/roles.ts` | `src/rbac.ts` | modified | Levels and comments verbatim; permission set narrowed and five renamed (§4); `hasPermission` widened to accept a missing role (cusui's fail-closed behaviour). |
| `cusui@ee5beb4:src/utils/permissions.ts` | `src/rbac.ts` | deleted (merged) | The hand mirror is replaced by the one source. |
| `cusui@ee5beb4:src/types/agency.ts` | `src/api/agency/agency.ts` | verbatim | No credits, nothing non-agency. |
| `cusui@ee5beb4:src/types/agency-campaign.ts` | `src/api/agency/agency-campaign.ts` | modified | `credits_low` removed from `AgencyStallCode` and `AgencyStall`. |
| `cusui@ee5beb4:src/types/agency-spine.ts` | `src/api/agency/agency-spine.ts` | verbatim | |
| `cusui@ee5beb4:src/types/agency-stats.ts` | `src/api/agency/agency-stats.ts` | verbatim | |
| `cusui@ee5beb4:src/types/agency-activity.ts` | `src/api/agency/agency-activity.ts` | verbatim | |
| `cusui@ee5beb4:src/types/agency-campaign-series.ts` | `src/api/agency/agency-campaign-series.ts` | verbatim | |
| `cusui@ee5beb4:src/types/dnc.ts` | `src/api/agency/dnc.ts` | verbatim | |
| `cusui@ee5beb4:src/types/call-analysis-profile.ts` | `src/api/agency/call-analysis-profile.ts` | modified | Import path only (`./prompt` → `./shared`). |
| `cusui@ee5beb4:src/types/webrtc-call.ts` | `src/api/agency/webrtc-call.ts` | modified | Softphone surface removed (§2); import path `./call` → `./shared`. |
| `cusui@ee5beb4:src/types/prompt.ts:7-27`, `src/types/call.ts:33-58` | `src/api/agency/shared.ts` | modified (excerpt) | The three types the two files above import; rest of both files is AI calling. |
| `cusui@ee5beb4:src/api/agencySpine.ts:115-135` | `src/api/agency/attempt-call.ts` | modified (excerpt) | The call-detail envelope (`AgencyCallAvailability`, `AgencyAttemptCallDetail`) cusui declares in its API module. |
| — | `src/api/agency/CONTRACT-DIFF.md` | new | Field differences between same-named core and console types. |
| `cusui@ee5beb4:src/types/auth.ts` | `src/api/platform/auth.ts` | modified | `governance` → `settings`; path-4-only fields removed; `TenantServiceSettings` removed; `Role` re-exported from `rbac`; `AccountsListResponse`, `MyAccountsResponse`, `SessionRequest`, `SessionRefusal*` added. |
| `cusui@ee5beb4:src/types/governance.ts` | — | deleted | Governance is replaced by the per-account settings row (plan §3.2). Nothing ported. |
| — | `src/api/platform/settings.ts` | new | `AgencyAccountSettings` and its map / update body (plan §3.2). |
| `cusui@ee5beb4:src/types/team.ts` | `src/api/platform/team.ts` | modified | Verbatim + `TenantMembersResponse` (the wire shape, from `master@a1f0756:src/api/routes/tenant.routes.ts:133-191`). |
| `cusui@ee5beb4:src/types/invite.ts` | `src/api/platform/invite.ts` | verbatim | |
| `cusui@ee5beb4:src/types/notifications.ts` | `src/api/platform/notifications.ts` | modified | Digest preview (credits) removed. |
| `cusui@ee5beb4:src/types/feature-flags.ts` | `src/api/platform/feature-flags.ts` | verbatim (+ note) | |
| `cusui@ee5beb4:src/types/audit.ts` | `src/api/platform/audit.ts` | verbatim (+ header note) | |
| `cusui@ee5beb4:src/types/super-admin.ts`, `src/api/super-admin.ts:271-349, 592-646`, `src/types/phone-number.ts:1-64`; `master@a1f0756:src/api/validators/super-admin.validator.ts`, `src/api/routes/super-admin.routes.ts` | `src/api/platform/super-admin.ts` | modified | Subset per plan §3.4 (§2); request bodies from master's validators; NEW shapes for role change, revoke, add-to-account. |
| — | `src/api/platform/super-admin-usage.ts` | new | Read-only usage counts (plan §3.3). |
| — | `src/index.ts`, `src/api/agency/index.ts`, `src/api/platform/index.ts` | new | Re-exports; convention documented in `src/index.ts`. |

## 2. Removed declarations

### From `core:src/agency/contracts.ts` → `src/agency.ts`

| Declaration | Reason |
|---|---|
| `'credits_low'` in `AgencyStallCode` | No credits in v1 (plan Decided #8, §3.3). Core never produced it. |
| `'credits_low'` in `AGENCY_STALL_PRIORITY` | Same. Remaining seven keep core's order. |
| `{ code: 'credits_low'; estimated_connects_remaining }` arm of `AgencyStall` | Same. |
| `AGENCY_CORE_STALL_CODES` | Existed only to state the core-vs-master producer split; one app produces every code, and with `credits_low` gone it equals `AGENCY_STALL_PRIORITY`. Consumers (core's `campaign-health.test.ts`) assert against `AGENCY_STALL_PRIORITY` instead. |
| `AgencyConnectedCallSettlementFields` | Billing only (settlement webhook fields). Not referenced anywhere in core `src/` outside `contracts.ts`. |
| `AgencyAttemptBatchCallType` | Billing only (rate-card operation name). Used only by `attempt-batcher.ts` and `webhooks/settlement-dispatcher.ts`, both dropped (plan §2, §6 Phase 6 "No attempt batcher"). |
| `AgencyAttemptBatchSettlementPayload` | Billing only (hourly attempt-batch settlement). Same users as above. |
| The "Billing wire shapes" section comment | Describes the three above and core's settlement dispatcher. |

No master↔core S2S-only type was deleted: every candidate is used by core's agency runtime (see §3).

### From cusui files

| File | Declaration | Reason |
|---|---|---|
| `agency-campaign.ts` | `'credits_low'` in `AgencyStallCode`, and its `AgencyStall` arm | No credits. |
| `webrtc-call.ts` | `WebRtcCallStatus`, `TERMINAL_WEBRTC_STATUSES`, `KNOWN_WEBRTC_STATUSES` | Live softphone lifecycle; agency's station uses its own frames. |
| `webrtc-call.ts` | `WebRtcTelephonyProvider`, `WEBRTC_TELEPHONY_PROVIDERS` | `'vobiz' \| 'voicelink'` carrier choice; VoiceLink is the only carrier. |
| `webrtc-call.ts` | `WebRtcCallerId` | Softphone caller-ID picker (incl. BYOC `is_byoc`). |
| `webrtc-call.ts` | `WebRtcCallStartInput`, `WebRtcCallStartResponse` | Softphone call start; agency dials through the pacing engine. |
| `webrtc-call.ts` | `WebRtcCallsListResponse`, `WebRtcCallListFilters` | Softphone call history list; agency reads calls through the attempt spine. |
| `auth.ts` | `TenantServiceSettings` | AI pipelines, carrier choice, tenant recording default — not agency settings. |
| `auth.ts` | `SessionResponse.governance`, `MeResponse.governance` | Replaced by `settings` (plan §3.2). |
| `auth.ts` | `SessionResponse.needs_phone`, `.default_account`; `is_new: boolean` → `false` | Produced only by session path 4, which agency refuses (plan §3.1). |
| `governance.ts` | all 13 declarations | Governance retired (plan §3.2). |
| `notifications.ts` | `DigestPreviewOperation`, `DigestPreviewCampaign`, `DigestPreviewResponse` | `usage.digest` is a credits digest over AI calls and broadcasts. |
| `super-admin.ts` | `SuperAdminTenant.credit_balance`, `.credit_reserved` | Credits. |
| `super-admin.ts` | `SuperAdminTenantDetail.credits`, `.credit_cache`; `SuperAdminCreditCache`; `SuperAdminCreditReconcileResult` | Credits. |
| `super-admin.ts` | `SuperAdminCreditTransaction`, `SuperAdminCreditTransactionsResponse` | Credits. |
| `super-admin.ts` | `SuperAdminFleetUsage`, `SuperAdminFleetTenant`, `SuperAdminFleetResponse` | Fleet view is billed minutes + bulk-dispatch queues; replaced by usage counts. |
| `super-admin.ts` | `SuperAdminDispatchType`, `SuperAdminDispatchLane`, `SuperAdminDispatchLanesResponse`, `SuperAdminDispatchQueueDepth`, `SuperAdminDispatchQueueDepthResponse` | Bulk dispatch / dispatch lanes out of scope. |
| `api/super-admin.ts` (inline) | `AccountConcurrencyDetail.providers`, `.entitlements`, `.synchronization` | Provider catalog, master's purchased-quantity record, master→core sync status. |
| `phone-number.ts` | `TelephonyProvider` | Provider management out of scope. |
| `phone-number.ts` | `PhoneNumber.pool_eligible` (and on the create/update bodies) | The signup pool; agency creates tenants with no pooled number. |
| `phone-number.ts` | `TenantPhoneAssignment.is_byoc` | BYOC out of scope. |
| `phone-number.ts` | `PhoneNumberInboundConfig`, `PhoneNumberWithInbound`, `UpsertInboundConfig*` | Not ported: AI inbound routing (plan §7 decision 3 is open). |
| master `createTenant` response | `core_key_provisioned`, `phone_auto_assigned` | No core API key; no pooled number. |

## 3. Candidate deletions — kept

| Declaration | Where | Why kept |
|---|---|---|
| `AgencyCreateSessionRequest.agent_user_id` | `src/agency.ts` | "Master's fact" on the S2S hop. In one app the server derives it from the session, but core's `agency.routes.ts` parses it. |
| `AgencyActorFields` (`agent_user_id`, `on_behalf`), `AgencyHangupRequest` | `src/agency.ts` | Same: master asserted the actor for core. Used by `disposition.ts` and `agency.routes.ts`. |
| `AgencyCampaignTransitionRequest` (`actor_user_id`, `actor_name`) | `src/agency.ts` | Master sent the actor to core. Used by `agency-campaigns.routes.ts` and `agency.model.ts`. |
| `AgencyStationHangupFrame` | `src/agency.ts` | Withdrawn/deprecated in core (MAG-112) but kept there on purpose. |
| `AgencyStall` / stats comments about master inserting fields, `concurrency_in_use` "same Redis counter AI calls use" | `src/agency.ts` | Verbatim comments; describe the source system. |
| `AuditProductOption`, `AuditLogFilters.product`, `available_products` | `src/api/platform/audit.ts` | The product axis is single-valued in a one-product app. |
| `NotificationCadence` `'digest'`, `NotificationFrequency`, `frequency` fields | `src/api/platform/notifications.ts` | Part of the served preference shape; no digest event exists in v1. |
| `PhoneNumber.provider_*`, `ConcurrencyAllocationMode 'provider_breakdown'`, `UpdateAccountConcurrencyBody.force_migration` | `src/api/platform/super-admin.ts` | One carrier today; the guard keeps its provider scope (plan §5). |
| `SuperAdminUser.firebase_uid` | `src/api/platform/super-admin.ts` | Ships a `pending_` stub to the super-admin console (trusted). Consider dropping in favour of `is_pending`. |
| `SessionRequest.phone_number` | `src/api/platform/auth.ts` | Path 1 is ported unchanged and writes it. |
| `TenantAccount`'s optional fields, `Account.settings` | `src/api/platform/auth.ts` | Verbatim. |
| `AgencyAccountSettings.analyze_dialer_calls` beside `analyze_calls` | `src/api/platform/settings.ts` | Both exist in core today; whether agency needs two analysis toggles is an open question. |

## 4. Permissions (`src/rbac.ts`) and their master source

All floors equal master's (`master@a1f0756:src/rbac/roles.ts`). Pinned by `test/rbac.test.ts`.

| Permission | Floor | Master name | `roles.ts` line | Gates (master route → cusui check) |
|---|---|---|---|---|
| `tenant.read` | viewer | `tenant.read` | 80 | `GET /tenants/:id/members` (`tenant.routes.ts:133`) → team page |
| `account.read` | viewer | `account.read` | 83 | `GET /accounts` (`account.routes.ts:88`) → `TenantContext`. `GET /accounts/mine` has **no** permission. |
| `user.invite` | account_admin | `user.invite` | 86 | `POST /users/invite` (`user.routes.ts:268`), `POST /invites/resend` (`invites.routes.ts:847`) → `TeamPage` |
| `user.update_role` | tenant_admin | `user.update_role` | 87 | `PUT /users/:id/role` (`user.routes.ts:676`) → `TeamPage` |
| `user.remove` | tenant_admin | `user.remove` | 88 | `DELETE /users/:id/membership` (`user.routes.ts:806`) → `TeamPage` |
| `audit.read` | account_admin | `audit.read` | 131 | `GET /audit` (`audit.routes.ts:143`), campaign activity (`proxy-agency-campaigns.routes.ts:1270,1378`) |
| `agency.flags.read` | agent | `proxy.feature_flags.read` | 164 | `GET /proxy/feature-flags` (`proxy-feature-flags.routes.ts:34`) |
| `agency.campaigns.read` | viewer | `proxy.contact_lists.read` | 118 | 7 agency campaign reads (`proxy-agency-campaigns.routes.ts`) → `AgencySidebar` |
| `agency.campaigns.write` | account_admin | `proxy.contact_lists.write` | 119 | 8 agency campaign writes → campaign pages |
| `agency.analysis_profiles.read` | viewer | `proxy.prompts.read` | 94 | `GET /proxy/call-analysis-profiles[/:id]` (`proxy-call-analysis-profiles.routes.ts:68-69`) |
| `agency.analysis_profiles.write` | account_admin | `proxy.prompts.write` | 93 | profile POST/PUT/DELETE (`:70-72`) → `AnalysisProfilesPage` |
| `agency.station.connect` | agent | same | 175 | `proxy-agency-agent`, `-performance`, `-staffing` routes |
| `agency.attempts.handle` | agent | same | 176 | hangup |
| `agency.attempts.dispose` | agent | same | 177 | disposition, notes |
| `agency.dnc.write` | agent | same | 178 | mark-DNC on the live attempt |
| `agency.supervise` | account_admin | same | 192 | campaign control, floor, spine, force-available, recordings (`proxy-agency-calls.routes.ts`) |
| `agency.dnc.read` | viewer | same | 207 | `GET /dnc` (`dnc.routes.ts`) |
| `agency.dnc.manage` | account_admin | same | 208 | DNC add/delete |

Dropped from master's matrix: `credit.read`, `credit.allocate`, `tenant.update`, `account.create/update/delete`, `api_keys.manage`, every other `proxy.*`. Notification preferences carry no permission in master (`notification.routes.ts:38`).

## 5. Discrepancies found while porting

1. **18 action codes, not 16.** Core's union, core's fixture, master's list and cusui's list all have 18 (`session_on_other_campaign`, `agent_on_live_call` are the two `agency.md` §6.2 omits). The package carries 18; the test snapshot is the fixture's list.
2. **Error-mask line range.** The brief's `error-mask.middleware.ts:106-160` is `agency.md` §6.4's older range; at `master@a1f0756` the seven lifecycle codes sit at `:139-141, :163-164, :220, :247`, and `:106-160` now also holds non-agency intro-audio codes and station codes.
3. **`agency.md` §6.4 / `contracts.ts` line refs** (e.g. `AgencyActionErrorCode` "at `:1286`") are stale; it is at `:1574` in core@4850d1d.
4. **`/accounts/mine` has no permission** in master; the "account read" the plan names is `account.read` behind `GET /accounts`.
