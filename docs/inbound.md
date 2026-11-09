# Inbound calls

Customers ring back the numbers agency dials them from. This is the design for answering those
calls on Plivo numbers (tenants' own accounts, B18–B22), putting the caller through to the agent who
spoke to them where possible, and turning every call nobody takes into a follow-up. VoiceLink
follows later behind the same router. Designed and reviewed 2026-11-09; Manas locked IB1–IB8 the
same day. **Nothing is built yet**: §12 is the build plan and its status.

It replaces launch decision 3 ("inbound calls play a message and hang up") for Plivo numbers that a
super-admin links to inbound. Unlinked numbers, and every VoiceLink number, keep today's behaviour.

## 1. Decisions

Status words as in [`decisions.md`](decisions.md).

| ID | Decision | Status |
|---|---|---|
| IB1 | Available agents are auto-connected with a distinct chime, as for outbound calls (panel on screen before audio). A Take call prompt is used only for pickups from break or the soft phone (P3) | **Decided** (Manas, 2026-11-09) |
| IB2 | Sticky routing defaults: `loose` mode, 30 s sticky wait, 30-day lookback; signals 1–3 of §4.1 on, signal 4 (last dialled, unanswered) off. `strict` and `off` are per-route options | **Decided** (Manas, 2026-11-09) |
| IB3 | When nobody answers (closed, waited too long, hung up while waiting, no line), the default action is a callback follow-up (§7); voicemail is optional per route | **Decided** (Manas, 2026-11-09) |
| IB4 | An inbound call reopens a contact whose retries are exhausted, as an inbound callback. A terminal outcome (a success, a terminal disposition, suppressed, DNC) is never reopened | **Decided** (Manas, 2026-11-09) |
| IB5 | Live inbound calls (waiting and connected) count in the account's live-call total, so outbound pacing shrinks to make room. An inbound call is never refused for the account limit while its route is under its own `max_concurrent` | **Decided** (Manas, 2026-11-09) |
| IB6 | Only super-admins link numbers to inbound (it writes to the tenant's Plivo account, which tenant admins cannot see; PL15) | **Decided** (Manas, 2026-11-09) |
| IB7 | A recording notice plays by default whenever the route records, before the agent is bridged | **Decided** (Manas, 2026-11-09) |
| IB8 | P2 runs single-process (`MEDIA_WORKERS=0`, the default). Handing a waiting caller to an agent on another media worker is P3, gated on the P0 Plivo check | **Decided** (Manas, 2026-11-09) |

## 2. Principles

1. **An inbound call is a third origin of the same call.** `agency_calls.origin` gains `inbound`
   (beside `campaign` and `manual`); the bridge, recording, analysis and customer history follow.
   A spine table, `agency_inbound_calls`, holds what is inbound-specific, as `agency_manual_calls`
   does for the soft phone.
2. **We hold the caller, not Plivo.** We answer at once with `<Stream>` to our server; greeting,
   hold audio and the queue are ours. Routing happens after the answer, never inside Plivo's
   answer-URL timeout. Plivo XML has no queue element; Conference / MultiPartyCall parking was
   considered and rejected (§3.2).
3. **Every unconnected call becomes a follow-up someone owns** (§7). Voicemail is an extra, not the
   only path.
4. **Owner first, then the team, never nobody.** Sticky routing has a bounded wait and always falls
   back.
5. **The operator links numbers; the account configures routing** (§8).

## 3. The call flow

```
Customer rings a linked number (tenant's Plivo account, number → our Plivo Application)
  │ answer_url  POST /api/v1/webhooks/plivo/inbound-answer/:credentialId?token=…
  ▼
Answer (synchronous, inside Plivo's answer-URL timeout)
  verify: purpose token for the credential + V3 signature over the STORED answer URL (24 h rotation
          grace) + nonce once per credential; the To number is synced from this credential and linked
  normalise From/To to +E.164 (Plivo sends digits only; non-numeric = withheld/unmatched)
  resolve route (§8.3); admit (IB5); insert agency_inbound_calls + agency_calls(origin=inbound)
  mint stream token; reply XML: <Stream bidirectional keepCallAlive> → our pstn-stream
  │  (a bad signature, unknown number, or a disabled credential that cannot verify → hangup XML;
  │   a disabled/invalid credential that still verifies → closed message + Missed row)
  ▼
Waiting ("parked") mode on our stream: greeting, then recording notice (IB7) if recording
  1. Hours: route schedule + holidays in the route timezone. Closed → closed clip → after-hours action
  2. Identify: ANI lookup (§4) → contact, campaign, account, sticky agent
  3. In-flight clash (§5.4): cancel a ringing outbound dial to this number; its agent takes this call
  4. Sticky offer (loose: ≤ sticky_wait_s; strict: until max wait) — taken from wrap-up by CAS
  5. Team queue: hold clip looped, longest idle first, pacing holds back (§5)
  6. Connect: inbound reservation → inbound panel frame → bind station → start recording (bridged_at)
  7. Not connected (max wait, caller hangs up, over a cap, no line) → overflow message → follow-up (§7)
  ▼
Connected: inbound outcome + wrap-up (§6); hangup via the credential-level status URL
```

### 3.1 Webhooks

| Route | Set where | Matched by |
|---|---|---|
| `POST /api/v1/webhooks/plivo/inbound-answer/:credentialId` | the Plivo Application's `answer_url` (stored on the credential, `inbound_answer_url`) | credential id in the path; purpose token in the query |
| `POST /api/v1/webhooks/plivo/inbound-status/:credentialId` | the Application's `hangup_url` | `CallUUID` → `agency_calls.provider_call_id` (new index); nonce set per credential |
| per-call recording / stream URLs | rendered by us per call | call id + per-call token, as outbound (Q6) |

The Application's fallback answer URL points at a static "we can't take your call, we'll call you
back" XML, so a deploy or outage never leaves a caller in silence. Signatures are verified against
the URL stored on the credential, never rebuilt from env, because the URL lives in the tenant's
Plivo account; the credential page shows a health check (the Application's URLs compared with the
stored ones) and a Re-point action. Do not reuse `plivoCallEvent` (it hardcodes `outbound` and reads
the answer callback as answered); inbound events get their own reader and fixture entries.

### 3.2 Holding on our stream

Connecting is "bind a station" in one process, exactly as outbound. Each waiting caller costs a
stream on our host, bounded by the route's `max_waiting` and `max_concurrent`. Needs a new bridge
session mode, **parked**: loop a clip (`PacedAudioStreamer` has no loop today), no pre-bind grace or
deferred hangup while unbound, its own queue timer; the call's maximum duration counts from the
bridge, not from answer.

With `MEDIA_WORKERS > 0` a call lives on its agent's worker (`slotFor(sessionId)`, `scaling.md`
§1.4), and an inbound call has no agent at answer time. IB8: P2 supports the single-process layout;
with workers on, the answer is placed on the sticky agent's worker when one is known and the pool is
limited to that worker. Cross-worker handover (a Plivo transfer to a new `<Stream>` URL on the
agent's worker) is P3, after the P0 check.

## 4. Identifying the caller and the sticky agent

### 4.1 Signals (IB2)

An actor-less, tenant-wide, unaudited read over the indexes customer history uses (one walk per
account of the tenant over `idx_agency_contacts_customer_history`, attempts by contact, manual calls
by destination), inside the lookback. Not the customer-history route: that one is user-scoped,
rate-limited and audited (CH2, CH6, CH10, CH11).

| Rank | Signal | From | Default |
|---|---|---|---|
| 1 | The contact's owner | `agency_contacts.assigned_user_id` | on |
| 2 | The agent whose latest attempt or manual call to this number went out from the number rung | attempts `caller_id` + `reserved_agent_id` → session's `agent_user_id`; manual calls | on |
| 3 | The last agent who spoke to the customer (connected) | attempts, manual calls | on |
| 4 | The last agent who dialled them, unanswered | attempts | off |

The dedicated caller ID (DN) is deliberately not a signal: when every number of a campaign is
dedicated, unowned contacts are dialled from someone's dedicated number (DN3). Ties across contacts
and campaigns: prefer the contact whose latest outbound call used the number rung, then the most
recent. The matched contact decides the account and campaign context shown to the agent, provided
that account may use the number rung. A campaign may opt out (`inbound_sticky_enabled`, default on).

### 4.2 Modes

`off`; `loose` (default: offer the agent for `sticky_wait_s`, then the team, still preferring the
agent if they free first); `strict` (only that agent until max wait; then a follow-up assigned to
them, never another agent).

### 4.3 Sticky agent's state → what happens

Eligible means the agent's live session is in the route's account (or the matched contact's
account): one live session per agent per tenant, so an agent working another account is offline
for this call.

| State | P2 | P3 |
|---|---|---|
| `available`, campaign session, eligible | reserve now (CAS), connect | same |
| `reserved` / `on_call` | hold; "Your customer is waiting" frame; taken from wrap-up when the call ends | same |
| `wrapup` | taken from wrap-up by CAS (the `reserveFromWrapup` pattern, WR5), so pacing never sees an `available` instant | same |
| `break` (catalog reasons) | skipped → team | Take call prompt; reservation from break with a guard; `break_reason` added to the Redis hash or read from the mirror |
| `break/soft_phone` | skipped → team | taken as a manual call (`manual` claim, `agency_manual_calls` row): a soft-phone session can never be `reserved` (0005 CHECK) |
| `break/device_away` | skipped (cannot ring) | skipped |
| mobile app (`client_kind = 'mobile'`) | treated as offline (the app has no inbound frame yet) | as console, after the Dart wire change |
| `offline`, or live on another account | team at once; follow-up assigned to them if nobody answers | same |
| unstaffed, membership removed, user deactivated | not sticky: next signal, else team; follow-up to the account | same |

## 5. When everyone is engaged

### 5.1 Queue

The route's agent pool: agents with a live campaign session in the route's account (option: only
agents staffed on listed campaigns), mobile excluded until P3. Longest idle first, the fairness
pacing uses. Limits per route: `queue_max_wait_s` (120), `max_waiting` (10), `max_concurrent`
(waiting + connected). Over a limit → overflow message → follow-up. A station lost before audio
binds puts the caller back at the head of the queue.

### 5.2 Inbound priority over pacing

A waiting caller publishes `inbound_waiting { accountId, n, preferredSessionIds }` on the pacing
invalidation bus (plain JSON, so the IPC bus carries it; no Redis pub/sub for pacing events). Each
round subtracts `n` from the account's headroom and drops the preferred sessions from candidates.
The router reserves with the same Lua CAS pacing uses, so an inbound offer and a pacing reservation
cannot both win.

### 5.3 Concurrency (IB5)

The guard's admission (`admitBridgeCall`) throws before a dial; an inbound call has already
arrived, so the answer handler decides instead: under the route's `max_concurrent` it is admitted
and counted in the account's live total (pacing shrinks); over it, or with the global or provider
scope full (PL14 included), the caller hears an "all lines busy" message and gets a follow-up
(outcome `overflow_no_capacity`).

### 5.4 A customer ringing while we dial them (MC4)

While an inbound call is live, its number joins the account's busy probe (`numberLiveSql`), so
pacing and the agent's own dial skip it. A still-ringing outbound dial to that number is cancelled
(Plivo cancels ringing, PL8), its contact returned uncharged; its reserved agent, who already has
the panel, gets the inbound call.

### 5.5 Metrics apart

A caller who hangs up while waiting is `abandoned_in_queue`. The outbound abandonment ceiling reads
`agency_call_attempts` only (`ABANDONED_ATTEMPT_PREDICATE_SQL`); inbound writes no attempt, so it
cannot leak in.

## 6. The agent's flow (P2)

Reservation, the station `reserved` frame, wrap-up and dispositions are all keyed on a campaign
attempt (`agency_call_attempts.campaign_id`/`contact_id` NOT NULL). Inbound gets its own flow,
modelled on the soft phone (`softphone.md` §4):

- a reservation kind `inbound` carrying `inbound_call_id`;
- an inbound panel frame (contracts, console; Dart wire types in P3), sent before any audio;
- its own outcome endpoint and wrap-up; outcomes from the matched campaign's catalog, else the
  route's catalog;
- a matched contact settled forward only with the soft phone's rule (SP6): a terminal contact is
  never reopened;
- `bridged_at` on the spine; talk time and the recording start at the bridge (Plivo Record API at
  bind), not at answer.

Supervisor floor: a queue tile per route (waiting, longest wait, eligible agents) and live inbound
calls marked.

## 7. Follow-ups

Every call that reaches no agent gets:

- **A Missed inbound row**, always: caller, number rung, time, reason (`closed`,
  `abandoned_in_queue`, `overflow`, `overflow_no_capacity`), voicemail if any, assignee (the sticky
  agent, else the account), status (open / handled, by whom, when). Actions: Call back (the soft
  phone, pre-filled, tagged to the matched campaign) and Mark handled.
- **A callback on the matched contact**, when it is on a running or paused campaign and not
  terminal (IB4: an exhausted contact is reopened): `callback_source = 'inbound'`, due at the
  route's next opening. `isCallbackSql` and the claim are widened to read it (today a callback
  needs an attempt whose disposition booked it, CA5). On `strict` / `preferred` campaigns it goes to
  the owner (CA4/CA5 grace and fallback apply); on `pool` any agent dials it, from the owner's
  dedicated caller ID if any (DN2).

| Caller | Follow-up |
|---|---|
| Matched, open or exhausted contact, live campaign | Missed row + callback on the contact |
| Matched, terminal contact | Missed row only |
| Matched, campaign completed or stopped | Missed row only |
| Unknown number | Missed row, unassigned |
| On DNC | Missed row flagged DNC; never dialled automatically (B8 fails closed). The agent is shown a DNC badge on a connected call: a customer's own call is an enquiry |
| Withheld / anonymous | Missed row with no number |

Voicemail (optional per route, IB3) is recorded from our own stream (we hold the μ-law frames), not
by moving the call to `<Record>` XML, unless the P0 check proves the transfer clean. It is attached
to the Missed row and analysed if the route has a summary profile. There is no in-app notification
channel; the station frame is the in-app alert, e-mail is not used for missed calls.

## 8. Configuration

### 8.1 Who sets what

| Level | Who | What |
|---|---|---|
| Tenant's Plivo credential | super-admin | **Enable inbound**: create one Plivo Application on the tenant's account (answer, hangup and fallback answer URLs); store `inbound_app_id`, `inbound_answer_url`. Health check and Re-point on the credential page |
| Each number | super-admin (IB6) | **Link to inbound** per number, never on sync. Store the number's previous Plivo app (`inbound_previous_app_id`) so Unlink restores it |
| Tenant / account | super-admin | Flag `agency_inbound_enabled` (default off) gates the console surfaces; calls on linked numbers are always answered |
| Account | account admin (`agency.inbound.write`) | Inbound routes: name, numbers, hours/timezone/holidays, clips (greeting, hold, closed, busy, recording notice), sticky mode/wait/lookback, agent pool, queue limits, after-hours and overflow actions, recording and summary profile, outcome catalog for unmatched callers |
| Campaign | supervisor | Optional `inbound_sticky_enabled` (default on) |
| Agent | — | No setting. Sees their own Missed rows (`agency.inbound.read`, floored at `agent`) |

### 8.2 Number lifecycle cascade

One function, called from account tagging, unassign, retire by sync (PL5), credential disable and
revoke: marks the route number inactive, clears the link, and while the credential still works
unlinks the Plivo number back to its previous app. Revoke is refused while numbers are linked.
Each step audited.

### 8.3 Which account a call belongs to

Plivo numbers sync to the tenant untagged, so several accounts may share one:
matched contact's account (if it may use the number) → the number's route → tenant default
(closed message + Missed row, no account).

## 9. Data model (sketch; one new migration per phase, never edit an applied one)

- `agency_inbound_routes`: tenant, account, name, timezone, weekly hours JSONB, holidays JSONB, clip
  ids (`audio_files`), sticky mode/wait/lookback, pool JSONB, `queue_max_wait_s`, `max_waiting`,
  `max_concurrent`, `after_hours_action`, `overflow_action`, `record_calls`, `analysis_profile_id`,
  `disposition_catalog`, status.
- `agency_inbound_route_numbers`: route ↔ `phone_number_id` UNIQUE, active.
- `agency_inbound_calls` (spine): tenant, account (nullable for the tenant default), route,
  credential, `provider_call_id`, from/to E.164, matched contact/campaign, sticky user + reason,
  state `arrived → greeting → queued → offered → connected → ended`, outcome (`answered`,
  `abandoned_in_queue`, `overflow`, `overflow_no_capacity`, `closed`, `voicemail`, `rejected`,
  `failed`), `arrived_at`, `bridged_at`, `ended_at`, answered by, follow-up assignee/status/handled
  by+at, voicemail key, `webrtc_call_id`.
- `agency_calls.origin` += `inbound` with `inbound_call_id`; the origin and manual-correlation
  CHECKs (0005) rewritten in the new migration; an index on `provider_call_id`.
- `agency_contacts`: callback source (`inbound`) and its due time, read by `isCallbackSql`.
- `telephony_credentials`: `inbound_app_id`, `inbound_answer_url`, inbound token.
  `phone_numbers`: inbound linked flag, `inbound_previous_app_id`.
- Usage counts: a third arm for inbound (`usage-counts.repository.ts`), from P1.

Audit actions: `telephony_credential.inbound_enabled` / `inbound_disabled` / `inbound_repointed`,
`phone_number.inbound_linked` / `inbound_unlinked`, `agency_inbound_route.created` / `updated` /
`deleted`, `agency_inbound_call.handled`. Ids and numbers only.

## 10. Restart and failure

- Startup and periodic sweep: non-terminal `agency_inbound_calls` rows become `abandoned_in_queue`
  with a follow-up (the spine is durable, so the follow-up survives).
- While we are unreachable Plivo plays the Application's fallback answer XML.
- A disabled or invalid credential: answered if the signature still verifies (closed message +
  Missed row), flagged on the credential page.

## 11. Reporting (P3)

Offered, answered, answered within 20 s (service level), average speed of answer, abandoned while
waiting, overflow, after hours, voicemails, sticky hit rate (offered to / answered by the sticky
agent), callbacks created and completed. An Inbound tab per account (the Insights pattern) and an
inbound section in account reports.

## 12. Build plan and status

| Phase | Scope | Status |
|---|---|---|
| P0 | Live Plivo checks, alongside the planned real Plivo call (step 5): create an Application and link/unlink a number; answer-URL params, timeout and inbound `CallStatus`; hangup URL params; fallback answer URL; moving a live streamed call to new XML (voicemail, worker handover); DTMF over the stream. Results into `plivo-carrier.fixture.json` | not started (needs a Plivo account) |
| P1 | Answer every call, connect nobody: credential Enable inbound + Application, per-number link/unlink + cascade (pilot tenant first), answer and status webhooks, spine + `origin = inbound`, routes with hours/holidays/clips (closed, "we'll call you back", recording notice), follow-ups (Missed list, inbound callback on contacts), startup sweep, usage, audit, flag, RBAC, super-admin and console screens | not started |
| P2 | Connect agents (console, single process, IB8): parked mode with looped hold, inbound reservation + panel + outcome + wrap-up, sticky loose/strict, team queue, `inbound_waiting` on the pacing bus, take-from-wrap-up CAS, in-flight clash (§5.4), concurrency answers (§5.3), voicemail, supervisor queue tile | not started |
| P3 | Mobile app frames (Dart wire), pickups from break and soft phone, media-worker handover, reports/Insights, "press 1 for a callback" if DTMF works | not started |
| P4 | VoiceLink behind a carrier-module `inbound` capability | not started |

P1 can be built and tested end to end against the mock Plivo carrier before P0 runs; P0's results
then correct the fixture. Contract changes run the mobile `agency_wire` `dart test` before commit
(root `CLAUDE.md`).
