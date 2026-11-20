# Dialer contract vs console wire types

`packages/contracts` has two families of agency types. `../../agency.ts` (a barrel over
`../../agency/*.ts`; the action error union lives in `../../errors.ts`) is the **dialer
contract**: what the internal handler instance and the dialer runtime produce, including the
station socket frames. The files in this directory are the **console wire types**: what the public
API layer serves to the console, after its enrichment (agent names, omission counts). Where a name
exists in both, the two are not interchangeable. This file lists every difference, so a change to
either side can be checked against the other. `packages/contracts/test/console-wire-diff.test.ts`
pins, at type level, three fields the console wire types share with the dialer contract:
`supervisor_hold`, `callback_requested_at` and `deferred_hangup_ms`; `console-wire-derived.test.ts`
pins every derived type (§1, §2) to its last hand-declared shape.

Found by walking both type trees (member name plus declared type text), then read by hand.
"Identical" means the same member names, optionality and type text.

## 1. Same name, different shape

Each console type in this table except `AgencyRetryCreateResponse` is DERIVED from its dialer
counterpart (`interface X extends Omit<Core.X, …> { …the members that differ }`), so a member added
to the dialer type reaches the console type with no second edit, and only the differences below
are written out. `packages/contracts/test/console-wire-derived.test.ts` pins each derived type to
the shape it had when it was hand-declared, so the derivation changed nothing the console compiles
against.

| Type | Dialer contract (`agency.ts`) | Console wire type (`api/agency/*`) | Note |
|---|---|---|---|
| `AgencySessionBootstrap` | `station_token_expires_at: string` | `station_token_expires_at?: string` | The server always sends it |
| `AgencyStationIntervals` | `deferred_hangup_ms: number` (required) | `deferred_hangup_ms?: number` | The console reads the reconnect window |
| `AgencyStationBridgeStatusFrame` | `status` is a 10-member literal union | `status: string` | The console's diagnostic frame is deliberately wide |
| `AgencyDispositionResponse` | `extends AgencyCampaignScoped` (`campaign_id`); `contact_state: AgencyContactState`; `callback_requested_at?: string \| null` | no `campaign_id`; `contact_state: string`; `callback_requested_at?: string \| null` | The console shows the requested callback time beside the window-adjusted `next_attempt_at` |
| `AgencyDncResponse` | `extends AgencyCampaignScoped`; `contact_state: AgencyContactState` | no `campaign_id`; `contact_state: string` | Additive on the console side |
| `AgencySessionStateResponse` | `campaign_id: string \| null` (NULL for a soft-phone session); `kind: AgencySessionKind`; `pending_state?: AgencyAgentState`; `break_reason?: string` | no `campaign_id`; `kind` inherited; both `\| null` | The server never sends `null` for the two optional fields |
| `AgencySoftphoneCreateSessionRequest`, `AgencyManualCallCreateRequest`, `AgencyManualCallUpdateRequest`, `AgencyManualCallHangupRequest`, `AgencyManualCallDispositionRequest`, `AgencyManualCallDncRequest` | carry the actor (`agent_user_id`, and `on_behalf` where a supervisor may act) | derived: the same bodies without them (§5); the session create and the hangup are `Record<string, never>` | The public API layer fills the actor from the authenticated session |
| `AgencyWrapupState` | `seconds_total: number`; `held_reason: AgencyWrapupHoldReason \| null` (required; 2 members) | no `seconds_total`; `held_reason?: AgencyWrapupHold \| null` (2 members) | `supervisor_hold` is declared on both sides but nothing produces it (`docs/decisions.md`, still open) |
| `AgencyStationReadyFrame` | `active_wrapup?: AgencyWrapupState` (dialer) | `active_wrapup?: AgencyWrapupState` (console, above) | Otherwise the dialer frame |
| `AgencySupervisorAgent` | no name | `agent_name: string \| null` | Public API layer enrichment: it joins the name from `users`. `on_inbound_call` (P2), `inbound_outcome_owed?` (the inbound wrap-up) and `can_take_inbound` (IQ56, a route field like `connected`) are inherited unchanged |
| `AgencyCampaignStats` | every counter required | every counter optional; `agents` is the console's `AgencySupervisorAgent[]`; adds `agents_peak?: number \| null` | `agents_peak` has no producer; the console degrades on absence. `stall`, `other_stalls`, `concurrency_limit`, `concurrency_in_use` and `abandonment_ceiling_pct` keep the dialer declaration. `concurrency?: AgencyCampaignConcurrency \| null` (MC7) is optional on both sides, like `attempts_retried` |
| `AgencyRetryCreateResponse` (declared, not derived) | generic discriminated union `AgencyRetryCreated<T> \| AgencyRetryReplayed<T>` on `idempotent_replay` | one interface: `campaign: AgencyCampaign`, `idempotent_replay?: boolean`, `contacts_seeded: number \| null`, `duplicates_collapsed?: number \| null`, `excluded: … \| null` | Same wire; the console flattens the union |
| `AgencyCampaignLineage` | `campaigns: AgencyLineageCampaign[]` | `campaigns: AgencyCampaignLineageEntry[]` | Entries differ only in `status: string` (§2) |
| `AgencyAgentStatsBucket` / `AgencyAgentStatsTotals` | `occupancy: AgencyAgentOccupancy` (required) | `occupancy?: AgencyOccupancy \| null` | The console treats occupancy as possibly unmeasured |
| `AgencyAgentStats` | `totals` / `buckets` of the dialer types | the console's `AgencyAgentStatsTotals` / `AgencyAgentStatsBucket` | `bucket` and `by_campaign` use aliases of the dialer types (§2) |
| `AgencyRosterAgentRow` | `success_rate_reportable: boolean` | optional | Additive |
| `AgencyRosterBenchmark` | `shift_seconds`, `break_seconds`, `aht` required | optional | Additive |
| `AgencyRosterPage` | `rows: AgencyRosterAgentRow[]`; `benchmark: AgencyRosterBenchmark` | `rows: AgencyRosterAgentRowWithName[]`; the console's `AgencyRosterBenchmark`; adds `inactive_omitted: number`, `unattributed_omitted?: number` | Public API layer enrichment: names and the two omission counts, computed while joining identities |
| `AgencyGroupRow` | `rates_reportable`, `success_rate_reportable` required | optional | Additive |
| `AgencyGroupPage` | `resolved_timezone: string \| null`; `rows: AgencyGroupRow[]` (`order` is `SortOrder` on both sides) | `resolved_timezone?`; `rows: AgencyGroupRowWithName[]`; adds `inactive_omitted`, `unattributed_omitted?` | Same enrichment as the roster page |

## 2. Different name, same concept

"Alias" means the console name is `export type ConsoleName = DialerName`; "derived" means it
extends the dialer type and declares only the difference.

| Dialer contract | Console wire type | Difference |
|---|---|---|
| `AgencyContactRow` | `AgencyRosterContact` | alias |
| `AgencyAttemptRow` | `AgencyAttempt` | derived: adds `agent_name?: string \| null` (enrichment) |
| `AgencyManualCall` (a `GET /softphone/calls` row) | `AgencyManualCallListRow` | derived: adds `analysis_status?: DialerAnalysisStatus \| null`, the media leg's summary status (the list read joins it), and `analysis_delay?: DialerAnalysisDelay \| null`, why a `pending` one is held up (the list read derives it from the analysis queue; the mobile app does not read it); `AgencyManualCallsPage` is the console's page of it, so the dialer `AgencyManualCallsPage` is not re-exported |
| `AgencyLineageCampaign` | `AgencyCampaignLineageEntry` | derived: `status: string` |
| `AgencyAgentOccupancy` | `AgencyOccupancy` | alias |
| `AgencyStatsBucketUnit` | `AgencyStatsBucketWidth` | alias (`'day' \| 'week' \| 'month'`) |
| `AgencyAgentCampaignRow` | `AgencyAgentStatsByCampaign` | alias |
| `AgencySessionCampaignConflict` | `AgencySessionConflict` | declared: the dialer type `extends AgencyActionErrorResponse` (`error`, `message` required, `allowed_codes?`); the console declares `error` and an optional `message` |
| `AgencyWrapupHoldReason` | `AgencyWrapupHold` | alias |
| `AgencyDisposition` | `AgencyDispositionEntry` | alias; `AgencyRetryRule` is `NonNullable<AgencyDisposition['retry']>` |
| `AgencyCampaignStatsSeries` | `AgencyCampaignSeries` | declared: console `timezone?` nullable, adds `from?` / `to?`; buckets typed as the agent bucket (`AgencyAgentStatsBucket`, occupancy optional) where the dialer contract uses `Omit<…, 'occupancy'>` |

## 3. Identical in both: re-exported, not copied

These are declared once, in the dialer contract, and the console wire files re-export them
(`export type { … } from '../../agency'`, the error list from `../../errors`), so they cannot
drift. They stay inside the `AgencyApi` namespace; nothing here is re-exported flat into the
package root.

- `api/agency/agency.ts`: `AgencyAgentState`, `AgencyAttemptState`, `AgencyAttemptOutcome`,
  `AgencyCampaignStatus`, `AgencyReleaseReason`, `AgencyCampaignChangeReason`,
  `AgencyStationErrorCode`, `AgencyActionErrorCode` (26 members) and `AGENCY_ACTION_ERROR_CODES`,
  `AgencyActionErrorResponse`, `AgencyNotesResponse`, `AgencyStationTokenResponse`,
  `AgencyDisposition`, `AgencyContextDisplay`, `AgencyBreakReason`, `AgencyRetryContext`,
  `AgencyActiveAttempt`, `AgencyMissedRelease`, `AgencyReservedAttempt`, `AgencyPriorAttempt`, and
  the media / reserved / countdown / bridged / released / agent_state / campaign_state / pong /
  error / bridge_ended frames; contact assignment's `queue` frame with `AgencyQueueState` and
  `AgencyQueueIdleReason`; late binding's `dial_activity` frame with `AgencyDialActivity`; for the
  wrap-up redial, `AgencyRedialInfo`, `AgencyRedialResponse`
  and the constants `AGENCY_WRAPUP_REDIAL_LIMIT` and `AGENCY_REDIALED_DISPOSITION_CODE`
  (`AgencyRedialRequest` is not re-exported: see §5).
- `api/agency/agency.ts`, for the agent station redesign (docs/agent-station.md, AS18; optional
  fields on shapes already re-exported above): the panel's call-later tag `AgencyAttemptCallback`
  with `AgencyAttemptCallbackSource` / `AGENCY_ATTEMPT_CALLBACK_SOURCES` (BE-4,
  `AgencyReservedAttempt.callback`); the typed facts `AgencyCustomerFacts`, `AgencyFactTile`,
  `AgencyFactTileRole` / `AGENCY_FACT_TILE_ROLES` (BE-6, `AgencyReservedAttempt.facts`); the
  context roles and types `AgencyContextRoles`, `AgencyContextRole` / `AGENCY_CONTEXT_ROLES`,
  `AgencyContextFieldType` / `AGENCY_CONTEXT_FIELD_TYPES` (BE-6, `AgencyContextDisplay.roles` /
  `.types`); the script `AgencyAgentScript`, `AgencyAgentScriptStep`, `AgencyScriptPlaceholder` /
  `AGENCY_SCRIPT_PLACEHOLDERS` and its bounds (BE-8, `AgencySessionBootstrap.script`); the number
  display `AgencyPhoneDisplay` / `AGENCY_PHONE_DISPLAYS` / `AGENCY_PHONE_DISPLAY_DEFAULT` (AS9,
  `AgencySessionBootstrap.phone_display`); the tile icons `AgencyTileIcon` / `AGENCY_TILE_ICONS`,
  `isAgencyTileIcon`, `agencyTileIconOrNone` (BE-13, `AgencyDisposition.icon`,
  `AgencyBreakReason.icon`). `AgencySessionHelp.state_at_raise` (BE-9) rides on the floor's `help`
  unchanged. The console's `AgencySessionBootstrap` (§1) inherits `script` and `phone_display` from
  the dialer type with no second edit, pinned by `console-wire-derived.test.ts`.
- `agency-campaign.ts`: `AgencyCampaignStatus` (the same binding again), `AgencyAgentLiveState`,
  `AgencyAgentsByState`, `AgencyStallCode` / `AgencyStall`, `AgencyRetryPreview`,
  `AgencyCampaignActor` (`name: string | null`; the console renders the id when it is null),
  `AgencyCampaignConcurrency` (the `concurrency` block on the campaign stats, decisions MC7); the
  campaign config defaults (`AGENCY_DEFAULT_DISPOSITION_CATALOG` and its neighbours from
  `../../agency/campaign-defaults.ts`) and, for New campaign (AS4), the "Collections" starter set
  `AGENCY_COLLECTIONS_STARTER_CATALOG`, the same frozen objects.
- `agency-spine.ts`: `AgencyContactState`, `AgencyRetrySelector`, `RETRY_NO_OUTCOME`,
  `AgencyKeysetPage`, `AgencyContactDetail`.
- `agency-stats.ts`: `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`, `AgencyRosterSort`,
  `AgencyRosterPercentiles`, `AgencyGroupDimension`, `AgencyGroupKey`, `AgencyGroupSort`.
- `inbound.ts` (`docs/inbound.md`): the inbound vocabularies and route configuration (P1), and
  the P2 call shapes the console reads unchanged: `AgencyInboundCall` (with `AgencyInboundCallMatch`,
  `AgencyInboundCallSticky`), `AgencyInboundCallResponse`, the disposition and DNC responses, the
  `inbound_call` and `customer_waiting` station frames, the disposition and catalog sources and the
  constants (`AGENCY_INBOUND_CONNECT_DELAY_MS`, `AGENCY_INBOUND_OUTCOME_LAPSE_MS`,
  `AGENCY_INBOUND_VOICEMAIL_MAX_SECONDS`, `AGENCY_INBOUND_TOOK_OVER_DISPOSITION_CODE`), and Mode B's
  ring vocabulary on the call (`AGENCY_INBOUND_OFFER_CHANNELS`, `AGENCY_INBOUND_RING_RESULTS`,
  `AGENCY_INBOUND_RING_MS`, `AGENCY_INBOUND_ACCEPT_GRACE_MS`, `AGENCY_INBOUND_RING_MAX_MISSES`). The
  push devices and the ring routes (`agency/push-devices.ts`, the `…/ring/*` bodies) are the app's
  and have no console twin.
  `AgencyInboundErrorCode` / `AGENCY_INBOUND_ERROR_CODES` from `../../errors`. Console-only there:
  the route, number and clip DTOs (the recordings' upload and delete, their limits and refusal
  reasons, the route warnings), the standard recordings' words (`AGENCY_INBOUND_STANDARD_WORDS`,
  which the server's carrier messages also speak), the Missed list (`voicemail_url?` is P2's;
  `assignee_departed` and `handled_reason`, whose vocabulary `AGENCY_INBOUND_HANDLED_REASONS` is the
  dialer contract's), its count, reassign, reopen and the inbound summary (`AgencyInboundMissedCountResponse`,
  `AgencyInboundMissedAssign*`, `AgencyInboundReopenResponse`, `AgencyInboundSummary*`, whose
  closed-call lines read the dialer contract's `AGENCY_INBOUND_CLOSED_CAUSES`, `AGENCY_INBOUND_MISSED_COUNT_CAP`,
  `AGENCY_INBOUND_SUMMARY_MAX_DAYS`), the supervisor's `AgencyInboundQueueTile` /
  `AgencyInboundQueueResponse`, `AgencyInboundCallLiveRefusal` and the request bodies (§5).
- `live-calls.ts` (`docs/listening.md`): the listener socket's vocabularies, wire format and frames
  from `../../agency/listen.ts` (`AGENCY_CALL_ORIGINS` / `AgencyCallOrigin`,
  `AGENCY_LISTEN_END_REASONS`, `AGENCY_LISTEN_CLOSE`, `AGENCY_LISTEN_END_CLOSE`, `AGENCY_LISTEN_LEG`,
  the frame and timing constants, the ready / ended / pong and ping / stop frames), and
  `AgencyListenErrorCode` with `AGENCY_LISTEN_ERROR_CODES` and the number reveal's
  `AgencyLiveCallNumberErrorCode` with `AGENCY_LIVE_CALL_NUMBER_ERROR_CODES` from `../../errors`.
  Console-only there: §4.
- `softphone.ts` (`docs/softphone.md`): every soft-phone shape the console reads unchanged — the
  manual call and its vocabularies, call fields, settings, bootstrap, session response, list query,
  disposition and DNC responses, the refusal bodies, `AgencyStationManualCallFrame` —
  its constants (`SOFTPHONE_*`, `AGENCY_SESSION_KINDS`, `AGENCY_MANUAL_CALL_*`,
  `AGENCY_CALL_FIELD_TYPES`) and `AgencySoftphoneErrorCode` with `AGENCY_SOFTPHONE_ERROR_CODES`
  (from `../../errors`).

The rename-only pairs of §2 are aliases of the dialer type: `AgencyRosterContact`,
`AgencyAgentStatsByCampaign`, `AgencyWrapupHold`, `AgencyStatsBucketWidth`.

`AgencyStationReadyFrame`, `AgencyStationWrapupFrame` and `AgencyStationServerFrame` (which
takes in the re-exported `AgencyStationManualCallFrame`) read the same as their dialer
counterparts but are NOT identical: the first two reference
`AgencyWrapupState`, and the union also takes in `AgencyStationBridgeStatusFrame`, both of which
differ (§1). The ready frame is derived (§1); the wrap-up frame (two members) and the server-frame
union stay declared in `api/agency/agency.ts`.

## 4. Console wire types with no dialer-contract counterpart

Shapes the public API layer owns outright: the campaign object (`AgencyCampaign`, which carries
`inbound_sticky_enabled?` from P2 of inbound calls; the internal
handlers serialise it in `apps/server/src/api/responses/agency-campaign.response.ts`), the carriers a
campaign may dial on (`AgencyCarrier`, `AgencyCarriersResponse`; served by the public layer itself), ingest
(`AgencyIngest*`, `AgencyUploadResponse`, `AgencyColumn*`), retry policy
(`AgencyRetryOutcome` / `Policy` / `Rule`), `AGENCY_RETRY_REFUSAL_CODES`, staffing
(`AgencyMyAssignment(s)`, `AgencyAssignment`, `AgencyAssignedAgent`, `AgencyAgentAssignment`,
`AgencyStaffingHistory*`), the `*WithName` roster and group rows, activity (`agency-activity.ts`),
DNC (`dnc.ts`), analysis profiles (`call-analysis-profile.ts`), the call detail
(`webrtc-call.ts`, `attempt-call.ts`), and the soft-phone call detail `AgencyManualCallDetail`
(`softphone.ts`), which carries the media leg's `WebRtcCallRecord` in the attempt detail's
envelope (`call_availability`) and the enriched `dispositioned_by_name?` (who saved the outcome,
joined from `users`). `WebRtcCallRecord.analysis_delay?: DialerAnalysisDelay | null` (why a
`pending` summary is held up: `vendor_unavailable` while the AI service refuses) is derived by the
server from the analysis queue on the attempt and soft-phone detail reads; it is never stored on
the call and carries no vendor detail.

The spine list pages (`agency-spine.ts`): `AgencySpineListPage<T>` extends the re-exported
`AgencyKeysetPage<T>` (§3) with `total?: number`, and `AgencyAttemptsListPage` /
`AgencyRosterContactsPage` are its pages of `AgencyAttempt` / `AgencyRosterContact`. The internal
handler writes `total` only when the request carries `?include_total=1`; the dialer contract's
`AgencyKeysetPage` deliberately has no `total` and is not changed, so the mobile app's pages
(`AgencyManualCallsPage`) are unaffected. The insights drill-down filter vocabulary is console-side
too: `AgencyContactWaiting` / `AGENCY_CONTACT_WAITING` (`?waiting=`), `AgencyListFlag` (`1` / `0`),
and the new keys on `AgencyAttemptFilters` / `AgencyContactFilters` (docs/insights.md, WS F).

Customer history (`customer-history.ts`, docs/customer-history.md) is console-side only: the
public API layer reads it directly (no internal handler hop), so every type there
(`CustomerSearchRequest`, `CustomerSearchResponse`, `CustomerTimelineEntry`, …) has no dialer
counterpart (`CustomerSearchOptionsResponse` included). It reuses the dialer vocabularies
`AgencyAttemptOutcome`, `AgencyCampaignStatus`, `AgencyContactState`, `AgencyDncEntryScope` and
`AgencyOverrideKind` (`override_applied`) by import rather than redeclaring them.

Home's board (`home.ts`, `GET /proxy/agency/home`, decision B28a) is console-side only: the public
API layer assembles it (the campaign list, the internal stats handler's payload through
`helpers/live-stats.ts`, the insights allocation through its cache, the health read's rollup
figures for today). `AgencyHomeCampaignStats` is a `Pick` of the console `AgencyCampaignStats` over
`AGENCY_HOME_STATS_FIELDS` (Home's fields and the Campaigns page's Active cards'), so its fields
keep that type's optionality. The attention facts (`AgencyAttentionAllocation`,
`AgencyAttentionStaffing`, `AgencyAttentionRangeFigures`, `AgencyAttentionSettings`) are projections
of the console Insights types, made by the functions beside them on both sides. The board is read
at `agency.campaigns.read`; below `agency.supervise` the server does not read the insights parts
and serves `staffing`, `allocation`, `today` and `settings` null, which is why `settings` is
nullable.

The Live floor's reads (decision B28b) are console-side only too. `floor.ts` is the public
`GET /proxy/agency/floor`; the internal `GET /agency/floor` answers the same agents without their
names or whether a call can be listened to, which the public route adds (`agentNamesOrNone`, the
listening flags). `promises.ts` (`GET /proxy/agency/promises/summary`) is assembled by the public
API layer from the three call tables. Neither has a dialer counterpart. Home's board gained
`AgencyHomeCampaign.status_changed` (`AgencyHomeStatusChange`: when, by whom, or automatic) for
"Paused by" on the Live floor's campaign cards. `AgencyFloorAgent.wrapup_window_seconds` is the
window the session's wrap-up actually takes, not the campaign's configured `wrapup_seconds` that
`AgencyCampaign` carries: on an inbound wrap-up it is the window captured on the inbound call
(IQ52), and a timerless campaign (`wrapup_seconds = 0`) serves null, as a soft-phone session does.
`AgencyFloorAgent.help` (LF4) is the dialer contract's `AgencySessionHelp` (`../../agency/floor-assist.ts`,
the same type the station's `ready.help` carries) on the open request only: the internal handler
answers it whatever the flag says, and the public route serves null on every row while
`agency_floor_assist_enabled` is off for the account (or cannot be read). Optional in the type only,
so a client written before Phase 3 compiles; the server always sends it. Floor assist's own shapes
(`AgencyHelpResponse`, `AgencySupervisorMessageRequest` and `…Response`, the three station frames,
`AgencyFloorAssistErrorCode` in `../../errors.ts` §8) are dialer-contract only: the public routes relay
the internal handlers' answers unchanged, so they have no console twin here. The three frames
(`supervisor_message`, `help_answered`, `help_cleared`) are members of both server-frame unions, the
dialer's `AgencyStationServerFrame` and this one, as the dialer's types unchanged; they were staged
outside both until the app could decode them (LF16), and `AgencyStationCapability` gained
`floor_assist` with them (the app's station declares `caps=floor_assist`).

Agent station, pool queue state (BE-5, AS18). `AgencyStationCapability` gained `queue_pool`
(`AGENCY_STATION_QUEUE_POOL_CAPABILITY`, in `AGENCY_STATION_CAPABILITIES` and the app's
`station_capabilities` vocabulary): a station that declares it is sent a `pool` campaign's queue state
(the `queue` frame and `ready.queue`). Unlike the other two, a console must declare it too: a console
tab or app build from before the redesign words queue state for an owner's own contacts, so it gets
none on `pool`, exactly as before BE-5. The bootstrap's `queue` is owner-mode only again (it is read
before the socket declares anything). No type changed shape; `strict` / `preferred` are unchanged.

Live floor Phase 3, break limits and callbacks (decisions LF6, LF7, LF20–LF22).
`AgencyBreakReason.limit_minutes` (optional, 1–240 whole minutes) is declared once, in the dialer
contract (`agency/session.ts`), and re-exported here like the rest of `AgencyBreakReason`: the
bootstrap's `break_reasons` carry it, which is how a station finds the limit of the break it is on.
`AgencyFloorAgent.break_limit_minutes` is computed by the internal `GET /agency/floor` from the
session's campaign catalog (its label and limit resolved once, `floorBreak`; the built-ins when it lists
none) and passed through by the public route; required, null when there is none, as is `help`. `callbacks.ts` (`GET /proxy/agency/callbacks`, `AgencyCallbacksPage`) is assembled by the public
API layer from the contacts table (SQL only); it has no dialer counterpart. The late-callbacks
hand-off (`AgencyLateCallbacksToLiveAgents` and its preview, commit, result and refusal types in
`assignment.ts`) is served by the public API layer like every assignment operation, so it has none
either.

The agent station redesign (docs/agent-station.md, rulings AS1–AS18) adds console-side shapes with
no dialer twin. The campaign object (`AgencyCampaign`, served by the internal handlers'
`formatAgencyCampaignResponse`, which spreads the row) gains `daily_target_calls?: number | null`
(BE-2, `AGENCY_DAILY_TARGET_CALLS_MIN` / `_MAX`), `agent_script?: AgencyAgentScript` (BE-8) and
`phone_display?: AgencyPhoneDisplay` (AS9), columns of 0056; the last two reach the station on the
dialer's bootstrap, the target only through My day. My day (`my-day.ts`,
`GET /proxy/agency/my-day`, BE-1 to BE-3: `AgencyMyDay`, `AgencyMyDayTarget`, `AgencyMyCallLater`,
`AgencyMyCallLaterRow`, `AGENCY_MY_DAY_QUERY_ERROR_CODE`, `AGENCY_MY_CALL_LATER_ROWS_MAX`,
`AGENCY_MY_DAY_TARGET_METRICS`, `AGENCY_MY_CALL_LATER_LEFT_GOES_TO`) is assembled by the public API
layer from SQL, like the callbacks list. The supervisor alerts (`floor.ts`,
`GET /proxy/agency/floor/alerts`, AS16: `AgencyFloorAlert`, its three kinds
`AgencyFloorHelpAlert` / `AgencyFloorBreakOverAlert` / `AgencyFloorDisconnectedAlert` over
`AgencyFloorAlertBase`, `AgencyFloorAlertsResponse`, `AGENCY_FLOOR_ALERT_KINDS`,
`AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS`) and `AgencyFloorAgent.disconnected_since?` (BE-11, the
station registry's detach time, held in memory) are the floor's, console-side like it. The agent
review dataset's `presence.break_overruns?` (`AgentReviewBreakOverruns`, BE-12, `../../reports/agent.ts`)
reads 0060's event columns.

Reports (`reports.ts`, docs/reports.md) are console-side only too: runs, downloads and
subscriptions are served by the public API layer itself, so `AgencyReportRun`,
`AgencyCreateReportRequest`, `AgencyReportSubscription` and the rest have no dialer counterpart.
`AgencyReportErrorCode` / `AGENCY_REPORT_ERROR_CODES` are declared in `../../errors.ts` (§5) and
re-exported, like the soft-phone codes. The report DATASET (`../../reports/`, its own subpath)
embeds console wire types from this directory (the Insights objects, `AgencyAgentStatsTotals`,
the roster row with its name and `AgencyRosterBenchmark`), never their dialer twins.

Live calls (`live-calls.ts`, docs/listening.md) are console-side too: the live list
(`AgencyLiveCall`, `AgencyLiveCallsResponse`, `AgencyLiveCallsQuery`, the listeners), the number
reveal (`AgencyLiveCallNumberResponse`, its refusal `AgencyLiveCallNumberErrorResponse`), the
grant (`AgencyListenGrant`), the refusal body (`AgencyListenErrorResponse`) and a call's listen
sessions (`AgencyCallListenSession`, carried as `listen_sessions` on the attempt detail
`AgencyAttemptCallDetail` and the soft-phone detail `AgencyManualCallDetail`) are what the public API layer serves after enrichment (names
from `users`, the masked number and `customer_phone_withheld`, `listenable` computed for the
caller; the row's `correlation_id`, the spine row the call pages are keyed on, and the campaign's
`aht_seconds`, added with the server side), so none has a dialer twin; `AGENCY_LIVE_CALL_NOT_LISTENABLE_REASONS` is a
subset of the dialer contract's `AgencyListenErrorCode`, so a row and the grant say the same thing.

The listening history (`listen-history.ts`, docs/listening.md §12) is console-side too:
`AgencyListenHistoryEntry` (a supervisor's merged sessions on one call, with the names and the
masked number the public layer adds, and `customer_phone_withheld`), `AgencyListenHistoryResponse`,
`AgencyListenHistoryQuery`, the merge gap, the page and export limits and
`AGENCY_LISTEN_END_REASON_LABELS` (keyed by the dialer contract's `AgencyListenEndReason`). The
internal handler answers the same visits with the full number and no names; it has no dialer twin.

## 5. Request fields the server sets itself

- `agent_user_id` on `AgencyCreateSessionRequest` and `AgencyActorFields` is filled by the public API
  layer from the authenticated session, never taken from the client; it remains in `agency.ts`
  because the internal handlers parse it. A candidate for removal.
- `on_behalf` is likewise decided server-side, from `agency.supervise`.
- `agent_user_id` on `AgencyRedialRequest` (`POST /sessions/:id/redial`): the console sends only
  `{ attempt_id }`, and the public API layer adds the actor; `AgencyRedialRequest` is therefore not
  re-exported into the console namespace. No `on_behalf`: only the session's own agent may redial.
- The soft-phone request bodies (`../../agency/softphone.ts`) carry the same two fields for the
  internal handlers; the console's are derived without them (§1).
- The inbound call request bodies (`../../agency/inbound.ts`: `AgencyInboundCallUpdateRequest`,
  `…HangupRequest`, `…DispositionRequest`, `…DncRequest`, docs/inbound.md §6) likewise: the console's
  (`inbound.ts` here) are derived without `agent_user_id` and `on_behalf`; the hangup is
  `Record<string, never>`.
