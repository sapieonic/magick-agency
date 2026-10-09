# Dialer contract vs console wire types

`packages/contracts` has two families of agency types. `../../agency.ts` is the **dialer
contract**: what the internal handler instance and the dialer runtime produce, including the
station socket frames. The files in this directory are the **console wire types**: what the public
API layer serves to the console, after its enrichment (agent names, omission counts). Where a name
exists in both, the two are not interchangeable. This file lists every difference, so a change to
either side can be checked against the other. `packages/contracts/test/console-wire-diff.test.ts`
pins, at type level, three fields the console wire types share with the dialer contract:
`supervisor_hold`, `callback_requested_at` and `deferred_hangup_ms`.

Found by walking both type trees (member name plus declared type text), then read by hand.
"Identical" means the same member names, optionality and type text.

## 1. Same name, different shape

| Type | Dialer contract (`agency.ts`) | Console wire type (`api/agency/*`) | Note |
|---|---|---|---|
| `AgencySessionBootstrap` | `station_token_expires_at: string` | `station_token_expires_at?: string` | The server always sends it |
| `AgencyStationIntervals` | `deferred_hangup_ms: number` (required) | `deferred_hangup_ms?: number` | The console reads the reconnect window |
| `AgencyStationBridgeStatusFrame` | `status` is a 10-member literal union | `status: string` | The console's diagnostic frame is deliberately wide |
| `AgencyDispositionResponse` | `extends AgencyCampaignScoped` (`campaign_id`); `contact_state: AgencyContactState`; `callback_requested_at?: string \| null` | no `campaign_id`; `contact_state: string`; `callback_requested_at?: string \| null` | The console shows the requested callback time beside the window-adjusted `next_attempt_at` |
| `AgencyDncResponse` | `extends AgencyCampaignScoped`; `contact_state: AgencyContactState` | no `campaign_id`; `contact_state: string` | Additive on the console side |
| `AgencySessionStateResponse` | `extends AgencyCampaignScoped`; `pending_state?: AgencyAgentState`; `break_reason?: string` | no `campaign_id`; both `\| null` | The server never sends `null` |
| `AgencyWrapupState` | `seconds_total: number`; `held_reason: AgencyWrapupHoldReason \| null` (required; 2 members) | no `seconds_total`; `held_reason?: AgencyWrapupHold \| null` (2 members) | `supervisor_hold` is declared on both sides but nothing produces it (`docs/decisions.md`, still open) |
| `AgencySupervisorAgent` | no name | `agent_name: string \| null` | Public API layer enrichment: it joins the name from `users` |
| `AgencyCampaignStats` | every counter required | every counter optional; adds `agents_peak?: number \| null` | `agents_peak` has no producer; the console degrades on absence. `stall` / `other_stalls` are identical |
| `AgencyCampaignActor` | `name: string \| null` | `name: string` | `null` is a real state (an id-only actor); the console must accept it |
| `AgencyRetryCreateResponse` | generic discriminated union `AgencyRetryCreated<T> \| AgencyRetryReplayed<T>` on `idempotent_replay` | one interface: `campaign: AgencyCampaign`, `idempotent_replay?: boolean`, `contacts_seeded: number \| null`, `duplicates_collapsed?: number \| null`, `excluded: … \| null` | Same wire; the console flattens the union |
| `AgencyCampaignLineage` | `campaigns: AgencyLineageCampaign[]` | `campaigns: AgencyCampaignLineageEntry[]` | Entries differ only in `status: string` (§2) |
| `AgencyAgentStatsBucket` / `AgencyAgentStatsTotals` | `occupancy: AgencyAgentOccupancy` (required) | `occupancy?: AgencyOccupancy \| null` | The console treats occupancy as possibly unmeasured |
| `AgencyAgentStats` | `bucket: AgencyStatsBucketUnit`; `by_campaign: AgencyAgentCampaignRow[]` | `AgencyStatsBucketWidth`; `AgencyAgentStatsByCampaign[]` | Renames only, same members (§2) |
| `AgencyRosterAgentRow` | `success_rate_reportable: boolean` | optional | Additive |
| `AgencyRosterBenchmark` | `shift_seconds`, `break_seconds`, `aht` required | optional | Additive |
| `AgencyRosterPage` | `order: 'asc' \| 'desc'`; `rows: AgencyRosterAgentRow[]` | `order: AgencyRosterOrder` (same literals); `rows: AgencyRosterAgentRowWithName[]`; adds `inactive_omitted: number`, `unattributed_omitted?: number` | Public API layer enrichment: names and the two omission counts, computed while joining identities |
| `AgencyGroupRow` | `rates_reportable`, `success_rate_reportable` required | optional | Additive |
| `AgencyGroupPage` | `resolved_timezone: string \| null`; `rows: AgencyGroupRow[]` | `resolved_timezone?`; `rows: AgencyGroupRowWithName[]`; adds `inactive_omitted`, `unattributed_omitted?` | Same enrichment as the roster page |
| `AgencyContactDetail` | `extends AgencyContactRow` | `extends AgencyRosterContact` | The base types have identical members (§2) |

## 2. Different name, same concept

| Dialer contract | Console wire type | Difference |
|---|---|---|
| `AgencyContactRow` | `AgencyRosterContact` | identical members |
| `AgencyAttemptRow` | `AgencyAttempt` | console adds `agent_name?: string \| null` (enrichment) |
| `AgencyLineageCampaign` | `AgencyCampaignLineageEntry` | `status: AgencyCampaignStatus` vs `string` |
| `AgencyAgentOccupancy` | `AgencyOccupancy` | `by_state: Record<AgencyAgentState, number>` vs `AgencyAgentsByState` (same type) |
| `AgencyStatsBucketUnit` | `AgencyStatsBucketWidth` | identical (`'day' \| 'week' \| 'month'`) |
| `AgencyAgentCampaignRow` | `AgencyAgentStatsByCampaign` | identical members |
| `AgencySessionCampaignConflict` | `AgencySessionConflict` | the dialer type `extends AgencyActionErrorResponse` (`error`, `message` required); the console declares `error` and an optional `message` |
| `AgencyWrapupHoldReason` | `AgencyWrapupHold` | same two members |
| `AgencyDisposition` | `AgencyDispositionEntry` | `retry` inline vs the named `AgencyRetryRule` (same members) |
| `AgencyCampaignStatsSeries` | `AgencyCampaignSeries` | console `timezone?` nullable, adds `from?` / `to?`; buckets typed as the agent bucket (`AgencyAgentStatsBucket`, occupancy optional) where the dialer contract uses `Omit<…, 'occupancy'>` |

## 3. Identical in both

`AgencyAgentState`, `AgencyAttemptState`, `AgencyContactState`, `AgencyAttemptOutcome`,
`AgencyCampaignStatus`, `AgencyReleaseReason`, `AgencyCampaignChangeReason`,
`AgencyStationErrorCode`, `AgencyActionErrorCode` (18 members both sides),
`AgencyStationServerFrame`, `AgencyAgentLiveState`, `AgencyAgentsByState`,
`AgencyStallCode` / `AgencyStall`, `RETRY_NO_OUTCOME`, `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`,
`AgencyRosterSort`, `AgencyGroupDimension`, `AgencyGroupSort`, and every frame or request interface
not listed in §1 (`AgencyDisposition`, `AgencyContextDisplay`, `AgencyBreakReason`,
`AgencyRetryContext`, `AgencyStationMediaFrame`, `AgencyStationReadyFrame`, `AgencyActiveAttempt`,
`AgencyMissedRelease`, `AgencyStationReservedFrame`, `AgencyReservedAttempt`, `AgencyPriorAttempt`,
the countdown / bridged / released / agent_state / campaign_state / pong / error / ended frames,
`AgencyStationTokenResponse`, `AgencyStationWrapupFrame`, `AgencyNotesResponse`,
`AgencyActionErrorResponse`, `AgencyRetrySelector`, `AgencyRetryPreview`, `AgencyRosterPercentiles`,
`AgencyGroupKey`, `AgencyKeysetPage`).

## 4. Console wire types with no dialer-contract counterpart

Shapes the public API layer owns outright: the campaign object (`AgencyCampaign`; the internal
handlers serialise it in `apps/server/src/api/responses/agency-campaign.response.ts`), ingest
(`AgencyIngest*`, `AgencyUploadResponse`, `AgencyColumn*`), retry policy
(`AgencyRetryOutcome` / `Policy` / `Rule`), `AGENCY_RETRY_REFUSAL_CODES`, staffing
(`AgencyMyAssignment(s)`, `AgencyAssignment`, `AgencyAssignedAgent`, `AgencyAgentAssignment`,
`AgencyStaffingHistory*`), the `*WithName` roster and group rows, activity (`agency-activity.ts`),
DNC (`dnc.ts`), analysis profiles (`call-analysis-profile.ts`), and the call detail
(`webrtc-call.ts`, `attempt-call.ts`).

## 5. Request fields the server sets itself

- `agent_user_id` on `AgencyCreateSessionRequest` and `AgencyActorFields` is filled by the public API
  layer from the authenticated session, never taken from the client; it remains in `agency.ts`
  because the internal handlers parse it. A candidate for removal.
- `on_behalf` is likewise decided server-side, from `agency.supervise`.
