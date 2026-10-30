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
| `AgencySessionStateResponse` | `extends AgencyCampaignScoped`; `pending_state?: AgencyAgentState`; `break_reason?: string` | no `campaign_id`; both `\| null` | The server never sends `null` |
| `AgencySoftphoneCreateSessionRequest`, `AgencyManualCallCreateRequest`, `AgencyManualCallUpdateRequest`, `AgencyManualCallHangupRequest`, `AgencyManualCallDispositionRequest`, `AgencyManualCallDncRequest` | carry the actor (`agent_user_id`, and `on_behalf` where a supervisor may act) | derived: the same bodies without them (§5); the session create and the hangup are `Record<string, never>` | The public API layer fills the actor from the authenticated session |
| `AgencyWrapupState` | `seconds_total: number`; `held_reason: AgencyWrapupHoldReason \| null` (required; 2 members) | no `seconds_total`; `held_reason?: AgencyWrapupHold \| null` (2 members) | `supervisor_hold` is declared on both sides but nothing produces it (`docs/decisions.md`, still open) |
| `AgencyStationReadyFrame` | `active_wrapup?: AgencyWrapupState` (dialer) | `active_wrapup?: AgencyWrapupState` (console, above) | Otherwise the dialer frame |
| `AgencySupervisorAgent` | no name | `agent_name: string \| null` | Public API layer enrichment: it joins the name from `users` |
| `AgencyCampaignStats` | every counter required | every counter optional; `agents` is the console's `AgencySupervisorAgent[]`; adds `agents_peak?: number \| null` | `agents_peak` has no producer; the console degrades on absence. `stall`, `other_stalls`, `concurrency_limit`, `concurrency_in_use` and `abandonment_ceiling_pct` keep the dialer declaration |
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
  `AgencyStationErrorCode`, `AgencyActionErrorCode` (18 members) and `AGENCY_ACTION_ERROR_CODES`,
  `AgencyActionErrorResponse`, `AgencyNotesResponse`, `AgencyStationTokenResponse`,
  `AgencyDisposition`, `AgencyContextDisplay`, `AgencyBreakReason`, `AgencyRetryContext`,
  `AgencyActiveAttempt`, `AgencyMissedRelease`, `AgencyReservedAttempt`, `AgencyPriorAttempt`, and
  the media / reserved / countdown / bridged / released / agent_state / campaign_state / pong /
  error / bridge_ended frames.
- `agency-campaign.ts`: `AgencyCampaignStatus` (the same binding again), `AgencyAgentLiveState`,
  `AgencyAgentsByState`, `AgencyStallCode` / `AgencyStall`, `AgencyRetryPreview`,
  `AgencyCampaignActor` (`name: string | null`; the console renders the id when it is null).
- `agency-spine.ts`: `AgencyContactState`, `AgencyRetrySelector`, `RETRY_NO_OUTCOME`,
  `AgencyKeysetPage`, `AgencyContactDetail`.
- `agency-stats.ts`: `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`, `AgencyRosterSort`,
  `AgencyRosterPercentiles`, `AgencyGroupDimension`, `AgencyGroupKey`, `AgencyGroupSort`.
- `softphone.ts` (`docs/softphone.md`): every soft-phone shape the console reads unchanged — the
  manual call and its vocabularies, call fields, settings, bootstrap, session response, list query
  and page, disposition and DNC responses, the refusal bodies, `AgencyStationManualCallFrame` —
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

Shapes the public API layer owns outright: the campaign object (`AgencyCampaign`; the internal
handlers serialise it in `apps/server/src/api/responses/agency-campaign.response.ts`), ingest
(`AgencyIngest*`, `AgencyUploadResponse`, `AgencyColumn*`), retry policy
(`AgencyRetryOutcome` / `Policy` / `Rule`), `AGENCY_RETRY_REFUSAL_CODES`, staffing
(`AgencyMyAssignment(s)`, `AgencyAssignment`, `AgencyAssignedAgent`, `AgencyAgentAssignment`,
`AgencyStaffingHistory*`), the `*WithName` roster and group rows, activity (`agency-activity.ts`),
DNC (`dnc.ts`), analysis profiles (`call-analysis-profile.ts`), the call detail
(`webrtc-call.ts`, `attempt-call.ts`), and the soft-phone call detail `AgencyManualCallDetail`
(`softphone.ts`), which carries the media leg's `WebRtcCallRecord` in the attempt detail's
envelope (`call_availability`).

## 5. Request fields the server sets itself

- `agent_user_id` on `AgencyCreateSessionRequest` and `AgencyActorFields` is filled by the public API
  layer from the authenticated session, never taken from the client; it remains in `agency.ts`
  because the internal handlers parse it. A candidate for removal.
- `on_behalf` is likewise decided server-side, from `agency.supervise`.
- The soft-phone request bodies (`../../agency/softphone.ts`) carry the same two fields for the
  internal handlers; the console's are derived without them (§1).
