# Soft phone

The soft phone lets an agent type a number and call it from the browser, outside campaign pacing.
The call can be logged to one of the agent's campaigns, so it uses that campaign's outcome list,
caller IDs, recording setting and summary profile, and its outcome updates the roster contact when
the number is on that campaign's roster. This page is the design the code implements: the data
model, the runtime, the API, the console and the rules. Read it before changing anything under
`apps/server/src/agency/softphone/`, the `softphone` routes, or the console's soft-phone screens.
Rulings are Manas's of 2026-10-30 (`decisions.md`, "Soft phone"). Written 2026-10-30; §4.1, §6 and §7 updated to the code as built the same day.

## 1. Rulings it rests on (Manas, 2026-10-30)

| # | Question | Ruling | What the code does |
|---|---|---|---|
| SP1 | Does DNC block soft-phone dials? | **Override with a note** | A DNC hit refuses the dial with `dnc_listed` and the matching entry; the agent may redial with an override note (10–500 chars). The note, the entry id and the actor are stored on the call and audited. A DNC **lookup failure** still refuses (fail closed) and cannot be overridden |
| SP2 | Do calling hours apply? | **Override with a note** | A call logged to a campaign whose calling window is closed (contact timezone when the number is on the roster, else the campaign default) is refused with `outside_calling_hours`; the agent may redial with an override note. Untagged calls have no window |
| SP3 | VoiceLink cannot cancel a ringing call | **Accept** | Hang-up while ringing is hold-to-confirm and the console says the customer's phone may keep ringing. Nothing else is built for it |
| SP4 | Who gets the soft phone? | **Every agent** in an account where `agency_softphone_enabled` is on | One permission at the agent floor; no per-agent switch |
| SP5 | Metering | **Same agency rate** | Manual calls are counted in usage counts and sit in the `agency` call scope |
| SP6 | Does a soft-phone outcome change the roster contact? | **Yes** | When the number is on the tagged campaign's roster the call claims the contact and its outcome settles it (§5) |
| SP7 | Swap from a running campaign | Agents can break from a campaign and use the soft phone, and back; audited | §4.2 |

## 2. Shape

- **The soft phone is a break.** While on the soft phone an agent's session is in `break` with the
  reserved reason code `soft_phone` (`SOFTPHONE_BREAK_REASON`). Pacing reserves only `available`
  agents, so pacing can never reserve an agent who is on the soft phone, by construction, and
  occupancy reports soft-phone time as a break reason with no new agent state.
- **Two ways in, one dialer.**
  - An agent who is not on a campaign opens a **soft-phone session**:
    `agency_agent_sessions.kind = 'softphone'`, `campaign_id IS NULL`. It is created in
    `break/soft_phone` and can never become `available`.
  - An agent live on a campaign **switches**: their campaign session goes to `break/soft_phone`
    (queued like any break while they are on a call or in wrap-up), and they dial from the same
    session and socket. **Return to campaign** ends that break.
  - Either way `uq_agency_agent_live_tenant` still allows one live session per agent per tenant:
    one pair of ears.
- **Calls live in `agency_manual_calls`**, never in `agency_contacts` / `agency_call_attempts`.
  Retries, roster completion, pacing headroom per campaign, the abandonment predicate and its 24 h
  guardrail never read it. The media leg is an ordinary `agency_calls` row with
  `origin = 'manual'` and `manual_call_id`; its `campaign_id` stays NULL so no campaign
  aggregation over `agency_calls` counts it.
- **The campaign is a tag**, chosen before Call and fixed for the call (caller ID, recording and
  summary profile are immutable on `agency_calls` after insert).

## 3. Data model (migration `0005_softphone.sql`)

- `agency_agent_sessions`: `kind VARCHAR(16) NOT NULL DEFAULT 'campaign'` (`campaign|softphone`);
  `campaign_id` nullable; `CHECK ((kind = 'campaign') = (campaign_id IS NOT NULL))`.
  `agency_agent_session_events`: `campaign_id` nullable.
- `agency_manual_calls`, one row per soft-phone dial: `id`, `tenant_id`, `account_id`,
  `session_id` (FK sessions), `agent_user_id`, `campaign_id` (tag, nullable, no FK), `contact_id`
  (roster match, nullable, no FK), `contact_claimed` (did this call move the contact to
  `in_flight`), `contact_prior_state`, `webrtc_call_id` (no FK), `destination_e164`, `caller_id`,
  `state` (`queued|dialing|ringing|answered|bridged|ended`), `outcome`, `end_reason`,
  `disposition_code`, `disposition_source` (`campaign|softphone`), `notes`, `callback_at`,
  `fields JSONB` (call details the agent entered), `recording_requested`, `analysis_profile_id`,
  `dnc_override_note`, `dnc_override_entry_id`, `hours_override_note`, `dialed_at`,
  `answered_at`, `bridged_at`, `ended_at`, `talk_seconds`, `dispositioned_by_user_id`,
  `dispositioned_at`, `dispositioned_on_behalf`, `settled_at` (outcome saved, lapsed, or an
  unanswered call closed), `created_at`, `updated_at`. Partial unique: one **unsettled** call per
  session (`settled_at IS NULL`), which covers a live call and one awaiting its outcome, so an
  agent cannot dial again before saving the last outcome.
  Indexes for the agent's own list, the account list (keyset on `created_at DESC, id DESC`),
  live calls, the tag (`campaign_id, created_at DESC`) and the contact.
- `agency_calls`: `origin VARCHAR(16) NOT NULL DEFAULT 'campaign'` (`campaign|manual`),
  `manual_call_id UUID` (correlation, no FK, like `agency_attempt_id`).
- `agency_softphone_settings`, one row per (tenant, account), all optional: `disposition_catalog`
  (`[]` = the built-in catalog), `call_fields` (`[]` = none), `analysis_profile_id`,
  `record_calls`, `default_caller_id`. Used for untagged calls; call fields apply to every call.

`call_fields` entries: `{ key, label, type: 'text'|'number'|'choice'|'boolean'|'date', options?,
required? }`, at most 20, snake_case keys up to 50 chars, unique. Values on a call are validated
against the set in force when they are saved; unknown keys are refused. A request's `fields`
(`PATCH /calls/:id`, the outcome) replaces the stored values wholesale; omitted, it leaves them
unchanged, and so does `{}` while the account has NO call fields in force (that client could not
have entered anything, so its empty object is not a clear of values saved under an earlier set).
While call fields are in force, `{}` is a real clear. An outcome that omits `fields` checks the
stored values of the fields still in force only; a value kept for a field since removed is not
re-validated (it was valid when saved, and the agent would have nothing to fix).

## 4. Runtime (`apps/server/src/agency/softphone/`)

### 4.1 `ManualDialer`

Owned by `AgencyRuntime`. One call at a time per session.

1. **Claim the session in Redis.** A Lua CAS on `agency:agent:{sessionId}:state` requires
   `state = break` and an empty `manual` field, and sets `manual = <manualCallId>`. Every write
   to `available` (the route, end-break, `releaseAgent`, the CAS) refuses inside its own script
   while `manual` is set, or while the hash carries `softphone = 1` (a soft-phone session, written
   at rehydrate), so ending the break and dialing cannot interleave and a soft-phone session can
   never be `available`. Released when the call settles (outcome saved, lapsed, or an unanswered
   call closed), by that call's id only. The DB session row must carry
   `break_reason = 'soft_phone'`. The claim is taken right AFTER step 3 commits, so it always names
   a row that exists; an end-break that wins the race leaves the session `available` and the row
   is closed undialled (`not_on_softphone`). Two dials from one session serialise on a row lock of
   the session inside step 3's transaction, so the second meets the first's call
   (`manual_call_live`), also when its pre-dial ran after the first committed and saw the contact
   the first had claimed (a pre-dial refusal is answered as the session's unsettled call when there
   is one). A rehydrate (reconnect, lapsed lease) of a soft-phone session, of a
   campaign session on the `soft_phone` break, or of ANY session holding an unsettled call
   (whatever its row's break reason says) lands in `break/soft_phone` and re-claims the
   session's unsettled call. An `offline` write (station drop, `releaseAgent` for a departed
   agent) keeps the row's `break_reason`, so a dropped campaign session on the soft phone comes
   back on it. Every route to `available` (`available`, `/softphone/return`, `force-available`)
   reads the session's unsettled call from the database BEFORE the Lua write
   (`setAvailableGuarded`, `owedSoftphoneCall`): one that exists refuses `manual_call_live` and
   re-claims the `manual` field, so a lease that lapsed and was rewritten without it cannot let
   an agent owing an outcome into the pacing pool.
2. **Pre-dial** (`manual-predial.ts`), in order: override notes when given (bounds); E.164
   (`normalizePhoneToE164` then `normalizeE164`; the schema has no account country, so the default
   region is the platform's, `DEFAULT_PHONE_COUNTRY_CODE`, `+91` by default); caller ID in the
   allowed set (tagged: the campaign's `caller_ids`, default the pool's round-robin pick as pacing
   dials; untagged: the account's assigned numbers, `findAvailableForAccount`, default the
   settings' `default_caller_id` while still assigned, else the account's default number); roster
   match on the tag (`campaign_id` + phone digits, the existing index) — a contact `in_flight`
   with a live campaign attempt refuses `contact_in_flight` with no override; calling window
   (tagged) → `outside_calling_hours` unless overridden; DNC (tenant, account, tag) →
   `dnc_listed` unless overridden, lookup error → `dnc_unavailable` (503).
3. **Insert** the manual-call row (`queued`) and, for a roster match in `pending`, claim the
   contact (`pending → in_flight`, `FOR UPDATE SKIP LOCKED`, recording its prior state). A
   contact in any other state is linked, not claimed.
4. **Dial agent first**: `createBridgedCall` with the session's station socket and the
   correlation `{ kind: 'manual', manualCallId }`, `browserCloseGraceMs: 0` before answer (the
   bridge honours the grace on a manual leg only once answered; after the answer the
   deferred-hangup window applies, so a wifi blip mid-conversation survives). `ringing` is
   written when the carrier accepts the dial. A dial the bridge refuses before the carrier
   (`concurrency_limit`, a dead socket, or `dial_failed` for a refusal the soft phone does not
   name) or the carrier refuses outright is ended `failed`, its contact claim released and no
   attempt charged; the carrier's refusal answers 201 with the row as it ended and settled. So is a dial that throws before the bridge is asked (a
   database fault on the `dialing` write): it is abandoned unplaced and the error reaches the
   caller, so nothing is left `queued` holding the session.
   Recording: tag's `record_calls`, else settings' `record_calls` (gated by the account's
   `allow_recording` in the bridge as today). Profile: tag's `analysis_profile_id`, else
   settings', else the account default (the analysis hook's fallback).
5. **Lifecycle → station frames.** Every state change sends `manual_call` (the full
   `AgencyManualCall` wire row). `bridged` starts audio both ways. The browser plays ringback.
6. **Ended** → write `ended`, outcome, talk seconds; if the call was never answered and there is
   no disposition owed, settle immediately with outcome only. Otherwise the call waits for an
   outcome.
7. **Outcome** (`manual-disposition.ts`): the existing pure functions (`resolveDisposition`,
   `validateDispositionFields`, `resolveDispositionDecision`) against the tag's catalog or the
   settings / built-in catalog (a tag whose catalog is empty falls back to the built-in, still
   source `campaign`: a bridged call always owes an outcome); call fields with `required`
   enforced; suppress codes write DNC in the same transaction (B8; campaign scope when tagged,
   else tenant); then the contact settles (§5); then the Redis `manual` field is released.
   **Mark DNC** on a tagged call also suppresses every roster row of the tag carrying the number,
   as the station's mark does.
8. **Lapse.** An ended call with no outcome after `SOFTPHONE_OUTCOME_LAPSE_MS` (30 min), or
   whose session left, is closed `no_disposition` (`settled_at` set) by the reaper sweep, and its contact claim is
   released to its prior state. Only a call that bridged (so owed an outcome) gets the `no_disposition` code; one
   that never bridged is just settled. The sweep (`lapseUnsettled`) returns the rows and releases nothing; the
   caller releases each claim (`releaseManualClaim`) and the Redis `manual` field.
9. **Reconnect.** A station reconnect reattaches a live manual call's browser leg
   (`reattachBorrowedBrowserLeg(manualCallId, ws)`) and resends `manual_call` right after `ready`
   (the ready frame has no field for it) with the session's unsettled call — live or awaiting
   its outcome — so a reloaded console restores the call. A socket close mid-call does not write
   the agent `offline` (the call's media leg owns the outcome), and `leave` is refused while a
   call is live.
10. **Restart.** The startup reaper ends non-terminal manual rows `orphaned` and releases their
    contact claims; the periodic sweep does the same for rows not owned by this process. A reaped row that
    never bridged is settled in the same statement and its claim released; one that bridged is ended and left
    awaiting its outcome (the agent talked to the customer and can still write it up after reconnecting), so
    its claim is kept until the outcome or the lapse (`reapOrphaned`). The periodic sweep spares
    this process's live calls and any row younger than 5 minutes. Both sweeps write an
    `audit_logs` system event per closed call (`agency_manual_call.orphaned` / `.lapsed`, actor
    `system:agency-reaper`).

Pacing headroom subtracts live calls on the **whole account** (attempts of every campaign plus
live manual calls): `countLiveForAccount`.

### 4.2 Switching from a campaign (SP7)

- `POST /proxy/agency/sessions/:id/softphone` → break with reason `soft_phone` on the campaign
  session. While the agent is reserved, on a call or in wrap-up the break is queued exactly like a
  normal break, and the console switches when the `agent_state` frame reports `break/soft_phone`.
- `POST /proxy/agency/sessions/:id/softphone/return` → refuses `manual_call_live` while a manual
  call is live or awaiting an outcome; otherwise ends the break (`available`).
- Audit: `agency_session.softphone_started` and `agency_session.softphone_ended` in
  `platform_audit_log` (session, campaign, from-state, whether the start was queued), plus the
  existing `audit_logs` session events.

### 4.3 Bridge seam (§3.1 of `seams.md`)

`WebRtcBridgedCallParams` replaces `campaignId` + `agencyAttemptId` with
`correlation: { kind: 'attempt'; campaignId; agencyAttemptId } | { kind: 'manual'; manualCallId }`.
The session's `correlationId` is the attempt id or the manual call id; the `agency_calls` insert
writes `origin` and `manual_call_id`. Changed in one commit with the type-level seam test and
`seams.md`.

## 5. Roster contact settlement (SP6)

Only when the call is tagged and the number matched a contact of that campaign.

| Contact at dial | At dial | Outcome saved |
|---|---|---|
| `pending` | claimed → `in_flight` | the disposition decision applies as on the station: suppress → `suppressed` (+ DNC), terminal / success → `completed`, callback → `pending` at the callback time (inside the window), retry → `pending` after the delay (or `exhausted` past max attempts), none → back to `pending` unchanged. `attempt_count` + 1 when the call was placed |
| `in_flight` (live campaign attempt) | refused `contact_in_flight` | — |
| `connected` (campaign call awaiting its own disposition) | linked only | only suppress applies |
| `completed`, `exhausted`, `suppressed` | linked only | only suppress applies; a terminal contact is never reopened |

The stranded-contact sweep ignores a contact with a live or unsettled manual call. Lapse and
restart release a claim to the recorded prior state, changing nothing else (no attempt is charged);
an unanswered call that settles with no outcome (§4.1 step 6) is the "none" row above.
`AgencyContactRepository.settleFromManual` applies this table; `claimForManual`,
`releaseManualClaim` and `findForManualMatch` are the claim and the match.

## 6. API

Public routes in `api/routes/proxy-agency-softphone.routes.ts` (with `proxy-agency-softphone/`),
registered by the agency plugin under `/proxy/agency`; each runs an internal handler
(`api/routes/agency/softphone.ts`, under `/api/v1/agency`) through `callCore` (B16). Every route
authenticates, applies its RBAC floor, then requires `agency_softphone_enabled` (403
`softphone_disabled`; after RBAC, so a caller without the permission is told that), validates its
body or query (ids are UUIDs at the edge; a malformed `:id` is the family's not-found), and answers a
runtime refusal as `{ error, code, message, ...fields }` with the status `errors.ts` names beside the
code (`SOFTPHONE_REFUSAL_STATUS`, pinned against those comments). `503 dnc_unavailable` and `503 dial_failed`
(Redis could not answer the session claim, or the bridge refused in a way the soft phone does
not name; nothing was dialled) are passed through the error mask as reviewed bodies.

`supervise` (act on another agent's call, read the account's calls, tag any campaign) is derived by
the public layer from the caller's ROLE holding `agency.supervise`, sent as `on_behalf` (body) or
`supervise=true` (GET query), and never read from the request. The audited routes' internal
answer is an envelope `{ answer, audit }`; the public layer sends `answer` and writes the audit row
from `audit` (a success without the envelope is a 502).

| Method and path (`/proxy/agency`) | Permission | What |
|---|---|---|
| `GET /softphone/bootstrap` | `softphone.dial` | taggable campaigns (agent: active staffing; supervise: every campaign of the account), each with status, caller IDs, catalog (the built-in when empty), calling window and whether it is open now, recording and summary profile, context display; untagged caller IDs (`findAvailableForAccount`), default caller ID, catalog and recording/profile; call fields; `default_country_code` (`+<digits>`); the caller's live session in the tenant (`on_softphone`, a queued switch as `pending_state` / `pending_break_reason`) and, in this account, its live or unsettled call (`agent_name` filled) |
| `POST /softphone/sessions` | `softphone.dial` | open (201) or rehydrate (200) the soft-phone session: `rehydrateAgent`, a station token, `station_ws_url` on `/proxy/agency/station`; 409 `session_on_campaign` with `session_id`, `campaign_id`, `campaign_name`, `state` |
| `POST /softphone/calls` | `softphone.dial` | `{ session_id, to, caller_id?, campaign_id? (null = untagged), fields?, overrides?: { dnc_note?, hours_note? } }` → 201 `AgencyManualCall` |
| `PATCH /softphone/calls/:id` | `softphone.dial` | `{ fields?, notes? }` while live or awaiting an outcome → the row (`fields` per §3: omitted, or `{}` with no call fields in force, is unchanged) |
| `POST /softphone/calls/:id/hangup` | `softphone.dial` | → the row; a supervisor may act on behalf |
| `POST /softphone/calls/:id/disposition` | `softphone.dial` | `{ code, notes?, callback_at?, fields? }` → `AgencyManualCallDispositionResponse`; a supervisor may act on behalf |
| `POST /softphone/calls/:id/dnc` | `softphone.dial` | `{ reason? }`: campaign scope when tagged, else tenant |
| `GET /softphone/calls` | `softphone.dial` | own calls; the account's with supervise. Query: `limit` (1–100, default 50), `cursor`, `agent_user_id` (an agent naming another agent: 403), `campaign_id` (uuid or `untagged`), `status`, `outcome`, `disposition_code`, `phone` (digits, suffix match), `from`, `to` (exclusive). Rows carry `agent_name` and the media leg's `analysis_status` |
| `GET /softphone/calls/:id` | `softphone.dial` | `AgencyManualCallDetail`: the call (contact context, prior attempts, `agent_name`), `dispositioned_by_name`, the override notes, the media leg with the attempt detail's entitlement strip (`allow_recording`, `analyze_calls` of the account), `call_availability` |
| `GET /softphone/calls/:id/recording` | `softphone.dial` | the bytes through the authenticated proxy (no signed URL), range forwarded; 403 `capability_disabled` without `allow_recording`; 404 `call_never_placed` / `call_purged` / no recording; own calls, any with supervise |
| `GET /softphone/settings` | `softphone.dial` | `{ settings }` |
| `PUT /softphone/settings` | `softphone.manage` | the whole row; 400 `settings_invalid` with `details[].path` (`disposition_catalog[i].code`, `call_fields[i].key`, `default_caller_id` not one of the account's numbers, `analysis_profile_id` not an active profile of the account, …) |
| `POST /sessions/:id/softphone` | `softphone.dial` | switch a campaign session to the soft phone (§4.2), queued while reserved, on a call or in wrap-up; `wrong_session_kind` on a soft-phone session |
| `POST /sessions/:id/softphone/return` | `softphone.dial` | back to `available`, or withdraw a queued switch; 409 `manual_call_live` (with the call) while a call is live or awaiting its outcome |

The two switch routes take the session routes' guard (`requireOwnedSession`: the caller's own
session, else 404; a left session 409 `session_ended`). The campaign session routes answer 409
`wrong_session_kind` on a soft-phone session: `available`, `break`, `break/cancel` and
`force-available` (`available` and `force-available` also 409 `manual_call_live` with the call
while one is live or awaiting its outcome; `force-available` answers the state it actually wrote:
`available`, `break` for a queued break, `offline` when the station is gone). `break/cancel` on a CAMPAIGN session
cancels a queued switch to the soft phone like any queued break. `leave` and `station-token` work
on a soft-phone session; `leave` is refused while a call is live. The campaign join answers 409
`session_on_softphone`. New station frame: `manual_call { call: AgencyManualCall }`.

Audit (`platform_audit_log`, resource types `agency_manual_call`, `agency_softphone_settings`, and
`agency_session`), each with the real actor and `campaign_id` set to the tag:
`agency_manual_call.placed` (session, `dnc_overridden` / `hours_overridden` flags),
`.dnc_overridden` (the note and the `dnc_entries` id), `.hours_overridden` (the note), `.hung_up`,
`.dispositioned` (code, `replay`), `.dnc_marked` (scope, `dnc_recorded`; never the number), each
with `on_behalf` when the call was another agent's; `agency_softphone_settings.updated` (`changed`
keys); `agency_session.softphone_started` (from-state, `queued`) and `.softphone_ended` (from-state,
`withdrawn`); `agency_session.joined` (`kind: softphone`) for the soft-phone session. Notes and
call-field values never go in `details`. The campaign activity trail offers the session and
manual-call actions (not the account-wide settings one) and the reaper's `audit_logs` events
`agency_manual_call.orphaned` / `.lapsed`, which carry the tag in `event_data.campaign_id`.

## 7. Console

- **`/dialer/phone`** (`SoftphonePage`): the soft phone, a fourth agent nav item ("Soft phone",
  shown when the flag is on and the caller has `agency.softphone.dial`). Same frozen geometry as
  the station: header, state rail (Ready, Dialing, Ringing, On call, Outcome needed), three
  columns (dial pad with caller ID and "Log to" campaign | call details fields and the roster
  contact | outcome pad, notes, callback; recent calls when idle), action bar. The rail, columns
  and action bar keep identical positions in every state (pinned by a geometry test).
- **Dialing.** Digits by click or keyboard; paste normalises `+91`, `00`, a trunk `0` (also a
  bracketed `(0)` after a country code, `+44 (0)20…`), spaces and `tel:`; typing drops a leading
  trunk `0` (the field reads after the country-code chip) and turns `00` into `+`; Enter calls. Redial fills the pad and focuses Call rather than dialling at once, so a
  misclick never rings a customer. "Log to" is locked once a call is placed. Single-key shortcuts
  are ignored while typing in a field or a focused `<select>`.
- **Audio.** On `/dialer/phone` the playback context is warmed and the microphone probed on the
  agent's first gesture on the page, so the permission prompt never lands mid-call. The mic opens
  when dialing starts and sends only once bridged; it is released when the call ends. The ringback
  is generated in the browser (400 + 450 Hz, ring-ring). While ringing, Mute silences only the
  ringback ("Mute ring"); the microphone's mute is separate, and answering with the microphone
  muted is announced assertively. The SP3 warning shows while ringing; hang-up is hold-to-confirm
  (or `E` twice).
- **Outcome.** The outcome pad uses the tagged campaign's catalog, else the soft-phone catalog,
  else the built-ins, with the station's rules (keys 1–9, required notes, callback times). Notes
  the agent cleared are sent as `notes: ''` with the outcome (the pending autosave is cancelled
  at Save, and an absent `notes` keeps the stored text); notes never touched are left out. An
  unsettled call blocks the next dial; the dial-pad column shows "Closes in m:ss" from
  `outcome_due_at` before the call lapses to `no_disposition`.
- **Call details.** The fields form is hydrated from the call and saved debounced (700 ms). Until
  the field set has loaded (for example a reload where the `manual_call` frame beats the
  bootstrap) the console sends no `fields`, so stored values are never wiped; on the server an
  omitted `fields` is "unchanged", and `{}` clears only when the account has call fields.
- **Overrides (SP1, SP2).** A `dnc_listed` or `outside_calling_hours` refusal opens a dialog that
  shows what matched (the DNC entry's scope, reason and date; the window, timezone and next
  opening), says the call is logged with the agent's name and note, and requires a note of 10–500
  characters before "Call anyway". A second refusal of the other kind keeps the first note.
  `dnc_unavailable` and `dial_failed` are plain errors with no override; `contact_in_flight` says
  the campaign is calling that customer right now.
- **The station (SP7).** **Switch to soft phone** in the action bar and the break menu. While the
  agent is reserved, on a call or in wrap-up the switch is queued: the button stays in place,
  disabled, reading "Switching after this call", and a pill with ✕ cancels it. When `agent_state`
  reports `break/soft_phone` the soft phone renders in place on the same socket and microphone,
  with the campaign preselected as the tag and **Return to campaign** in the header (disabled,
  with the reason, while a manual call is live or awaiting its outcome). The ordinary End break
  and the station's own shortcuts are suspended. After a reload during a soft-phone break the
  station reads `session.on_softphone` from the bootstrap.
- **Live floor.** A campaign agent on `break/soft_phone` reads "Soft phone" on the floor and in its
  drawer (`floorStateLabel`), never "On break · soft_phone", and is exempt from the 30-minute
  long-break flag. Whether they are on a call right now is not in the floor's data
  (`AgencySupervisorAgent` carries the session's state and reason only).
- **Supervisor.** **Soft-phone calls** in the agency sidebar (`agency.supervise`): a stats strip
  over the listed rows, filters (dates, agent, "Logged to" including "Not logged", what happened,
  status including "Waiting for an outcome", number), keyset paging, a Summary column from
  `analysis_status` (hidden when the account's analytics capability is off), DNC / hours override
  badges. The call detail reuses the call view (summary, sentiment, custom dimensions, recording,
  transcript) plus the outcome, who saved it (with the on-behalf marker) and the agent's call
  details, each labelled with its source (Agent / AI), and any override note. Each campaign has a
  **Manual calls** tab. **Settings → Soft phone** (`agency.softphone.manage` to edit, read-only
  otherwise): the untagged outcome list, the call fields editor (keys locked once saved), summary
  profile, recording, default caller ID.
- **My calls** has a "Soft-phone calls" tab (`?view=softphone`).
- **DNC page.** Its copy says DNC applies to the soft phone, with an audited override (SP1).

## 8. Not built (yet)

Call details in the analysis prompt (needs a `context_pending` job hold), a callbacks list, DTMF,
per-campaign call fields, a "every call must be tagged" setting, cancel-while-ringing (Plivo),
transfer and conference.
