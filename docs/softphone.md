# Soft phone

The soft phone lets an agent type a number and call it from the browser, outside campaign pacing.
The call can be logged to one of the agent's campaigns, so it uses that campaign's outcome list,
caller IDs, recording setting and summary profile, and its outcome updates the roster contact when
the number is on that campaign's roster. This page is the design the code implements: the data
model, the runtime, the API, the console and the rules. Read it before changing anything under
`apps/server/src/agency/softphone/`, the `softphone` routes, or the console's soft-phone screens.
Rulings are Manas's of 2026-10-30 (`decisions.md`, "Soft phone"). Written 2026-10-30.

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
against the set in force when they are saved; unknown keys are refused.

## 4. Runtime (`apps/server/src/agency/softphone/`)

### 4.1 `ManualDialer`

Owned by `AgencyRuntime`. One call at a time per session.

1. **Claim the session in Redis.** A Lua CAS on `agency:agent:{sessionId}:state` requires
   `state = break` and an empty `manual` field, and sets `manual = <manualCallId>`. The
   `available` transition (route, end-break) requires `manual` to be empty, so ending the break
   and dialing cannot interleave. Released when the call settles (outcome saved or lapsed).
   The DB session row must carry `break_reason = 'soft_phone'`.
2. **Pre-dial** (`manual-predial.ts`), in order: E.164 (`normalizeE164`, default region from the
   account's country, `+91` by default); caller ID in the allowed set (tagged: the campaign's
   `caller_ids`; untagged: the account's assigned numbers, `findAvailableForAccount`); roster
   match on the tag (`campaign_id` + phone digits, the existing index) — a contact `in_flight`
   with a live campaign attempt refuses `contact_in_flight` with no override; calling window
   (tagged) → `outside_calling_hours` unless overridden; DNC (tenant, account, tag) →
   `dnc_listed` unless overridden, lookup error → `dnc_unavailable` (503).
3. **Insert** the manual-call row (`queued`) and, for a roster match in `pending`, claim the
   contact (`pending → in_flight`, `FOR UPDATE SKIP LOCKED`, recording its prior state). A
   contact in any other state is linked, not claimed.
4. **Dial agent first**: `createBridgedCall` with the session's station socket and the
   correlation `{ kind: 'manual', manualCallId }`, `browserCloseGraceMs: 0` before answer.
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
   settings / built-in catalog; suppress codes write DNC in the same transaction (B8); then the
   contact settles (§5); then the Redis `manual` field is released.
8. **Lapse.** An ended call with no outcome after `SOFTPHONE_OUTCOME_LAPSE_MS` (30 min), or
   whose session left, is closed `no_disposition` (`settled_at` set) by the reaper sweep, and its contact claim is
   released to its prior state. Only a call that bridged (so owed an outcome) gets the `no_disposition` code; one
   that never bridged is just settled. The sweep (`lapseUnsettled`) returns the rows and releases nothing; the
   caller releases each claim (`releaseManualClaim`) and the Redis `manual` field.
9. **Reconnect.** A station reconnect reattaches a live manual call's browser leg
   (`reattachBorrowedBrowserLeg(manualCallId, ws)`) and resends `manual_call`.
10. **Restart.** The startup reaper ends non-terminal manual rows `orphaned` and releases their
    contact claims; the periodic sweep does the same for rows not owned by this process. A reaped row that
    never bridged is settled in the same statement and its claim released; one that bridged is ended and left
    awaiting its outcome (the agent talked to the customer and can still write it up after reconnecting), so
    its claim is kept until the outcome or the lapse (`reapOrphaned`).

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

Public routes under `/proxy/agency/softphone` (agency plugin), each calling an internal handler
under `/api/v1/agency/softphone` through `callCore` (B16). Permission `agency.softphone.dial`
(agent floor) unless noted; every route also requires `agency_softphone_enabled`.

| Route | What |
|---|---|
| `GET /bootstrap` | taggable campaigns (agent: active staffing; `agency.supervise`: all in account) with their catalogs, caller IDs and window; untagged caller IDs and catalog; call fields; recording / profile summary; the caller's live session, live or unsettled manual call |
| `POST /sessions` | open a soft-phone session (409 `session_on_campaign` with the campaign when live on one) |
| `POST /calls` | `{ session_id, to, caller_id?, campaign_id?, fields?, overrides?: { dnc_note?, hours_note? } }` → 201 `AgencyManualCall` |
| `PATCH /calls/:id` | `{ fields?, notes? }` while live or awaiting an outcome |
| `POST /calls/:id/hangup` | |
| `POST /calls/:id/disposition` | `{ code, notes?, callback_at?, fields? }`; `agency.supervise` may act on behalf |
| `POST /calls/:id/dnc` | mark DNC (campaign scope when tagged, else tenant) |
| `GET /calls`, `GET /calls/:id` | own calls; all in the account with `agency.supervise`; detail includes the media leg and analysis |
| `GET /settings`, `PUT /settings` | `agency.softphone.manage` (account admin) for PUT; GET at agent floor |
| `POST /proxy/agency/sessions/:id/softphone` and `/softphone/return` | switch from and back to a campaign (§4.2) |

The campaign session routes (`available`, `break`, `break/cancel`, `force-available`) answer 409
`wrong_session_kind` on a soft-phone session; `available` also answers 409 `manual_call_live`.
New station frame: `manual_call { call: AgencyManualCall }`.

Audit (`platform_audit_log`): `agency_manual_call.placed`, `.dnc_overridden`,
`.hours_overridden`, `.dispositioned`, `.hung_up`, `.dnc_marked`; `agency_softphone_settings.updated`;
the two session actions in §4.2. Resource types `agency_manual_call`, `agency_softphone_settings`.

## 7. Console

- `/dialer/phone`: the soft phone, a fourth agent nav item. Same frozen geometry as the station:
  header, state rail (Ready, Dialing, Ringing, On call, Outcome), three columns (dial pad with
  caller ID and "Log to" campaign | call details fields and roster contact | outcome pad, notes,
  callback | recent calls when idle), action bar.
- The station: **Switch to soft phone** in the action bar / break menu, the soft-phone view in
  place (same socket and mic), **Return to campaign** in the header.
- DNC and calling-hours refusals open an override dialog that requires a note.
- Supervisor: **Soft-phone calls** in the agency sidebar (list with filters, detail with summary,
  custom dimensions, recording, transcript and the agent's call details); the campaign shows its
  manual calls; Settings → **Soft phone** for account admins.
- My calls includes the agent's soft-phone calls.

## 8. Not built (yet)

Call details in the analysis prompt (needs a `context_pending` job hold), a callbacks list, DTMF,
per-campaign call fields, a "every call must be tagged" setting, cancel-while-ringing (Plivo),
transfer and conference.
