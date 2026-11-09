# Inbound calls

Customers ring back the numbers agency dials them from. This is the design for answering those
calls on Plivo numbers (tenants' own accounts, B18–B22), putting the caller through to the agent who
spoke to them where possible, and turning every call nobody takes into a follow-up. VoiceLink
follows later behind the same router. Designed and reviewed 2026-11-09; Manas locked IB1–IB8 the
same day. **P1 is built** (§12): the foundation (§9), the operator side (§8.1, §8.2), the
webhooks, what callers hear and the follow-ups (§3.4), and the account's console (§8.4), with the
review's fixes. §12 is the build plan and its status.

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
| `POST /api/v1/webhooks/plivo/inbound-status/:credentialId` | the Application's `hangup_url` | `CallUUID` → `agency_inbound_calls.provider_call_id` (`uq_agency_inbound_calls_provider_call`), the row's tenant and credential checked against the URL's; nonce set per credential |
| per-call recording / stream URLs | rendered by us per call | call id + per-call token, as outbound (Q6) |

The Application's fallback answer URL points at a static "we can't take your call" XML, so a
deploy or outage never leaves a caller in silence: `PLIVO_INBOUND_FALLBACK_ANSWER_URL` when the
operator sets one (a file hosted off this deployment, fetched with GET, §3.3), else our own
`POST /api/v1/webhooks/plivo/inbound-fallback` (which covers a failing answer route, not this server
being down). Signatures are verified against the URL stored on the credential, never rebuilt from
env, because the URL lives in the tenant's Plivo account; the credential page shows a health check
(the Application's URLs compared with the stored ones) and a Re-point action.

All three URLs are built in one module, `apps/server/src/telephony/plivo/inbound-urls.ts`, on
`PLIVO_WEBHOOK_BASE_URL` as written (only trailing slashes stripped, as the outbound dial's URLs):
`plivoInboundUrls` (what Enable and Re-point give the carrier and store, WITHOUT the token),
`withInboundToken` (`?token=` appended for the carrier) and `inboundSignedUrl` (the signature's
subject: the stored URL plus the request's own query), which the webhooks use. Do not reuse `plivoCallEvent` (it hardcodes `outbound` and reads
the answer callback as answered); inbound events get their own reader and fixture entries.

### 3.2 Holding on our stream

Connecting is "bind a station" in one process, exactly as outbound. Each waiting caller costs a
stream on our host, bounded by the route's `max_waiting` and `max_concurrent`. Needs a new bridge
session mode, **parked**: loop a clip (`PacedAudioStreamer` has no loop today), no pre-bind grace or
deferred hangup while unbound, its own queue timer; the call's maximum duration counts from the
bridge, not from answer.

With `MEDIA_WORKERS > 0` a call lives on its agent's worker (`slotFor(sessionId)`, `scaling.md`
§1.4), and an inbound call has no agent at answer time. IB8: P2 supports the single-process layout
only; with workers on, P2 keeps P1's answer (nobody is connected, logged once, Q13). Placing an
inbound call on an agent's worker, and the cross-worker handover (a Plivo transfer to a new
`<Stream>` URL on the agent's worker), are P3, after the P0 check.

### 3.3 The fallback answer XML

Plivo fetches the Application's fallback answer URL when the answer URL fails or times out. Our own
route covers a failing answer handler; a static file hosted elsewhere also covers this deployment
being down. To host one:

1. Put this file on any `https:` host that does not depend on this deployment (an S3 bucket behind
   CloudFront, any CDN or static host), answering `GET` with `Content-Type: application/xml`:

   ```xml
   <Response>
     <Speak>Sorry, we cannot take your call right now. Please try again shortly.</Speak>
     <Hangup/>
   </Response>
   ```

   (`<Play>` of a hosted MP3 works too.) It must not promise a callback: a call answered by the
   fallback never reaches us, so it leaves no Missed row.
2. Set `PLIVO_INBOUND_FALLBACK_ANSWER_URL` to its URL (absolute `https:`, no fragment; checked at
   startup) and restart the server.
3. **Re-point** every credential with inbound enabled: an Application keeps the URL it was given
   until then (the health check says `stored_urls_current: false` meanwhile). The Application then
   fetches it with GET; our own route is fetched with POST.

### 3.4 What P1 builds of this (the webhook slice)

Built: the three webhooks, the answer and the hangup, what the caller hears, the follow-ups and the
sweep; nobody is connected (P2). Code: `api/routes/webhooks/plivo-inbound.ts` (voice) hands verified
calls through `seams/inbound-call-router.ts` (docs/seams.md §3.5) to
`agency/inbound/inbound-call-router.ts`; the bridge takes the call in with `acceptInboundCall` and
plays with `playClipSequenceThenHangUp` (docs/seams.md §3.1).

- **Verification** (answer and hangup URLs): the purpose token's hash (current, or the previous
  inside its grace), the V3 signature against the credential's auth tokens resolved for
  `call_control` (so a disabled or invalid credential still verifies), over the URL stored on the
  credential plus the request's query, and the signed nonce once per credential (Redis `SET NX`,
  6 h; fails open as the per-call guard; a request with no signed nonce is refused). A refusal is
  `<Hangup/>` on the answer URL, 403 on the hangup URL; a fault is the fallback message, 503 on the
  hangup URL, the nonce given back. The fallback answer URL answers fixed XML to anyone.
- **Tenant isolation**: a `CallUUID` is unique per provider (`uq_agency_inbound_calls_provider_call`),
  not per credential, so the answer's insert, on a conflict, uses the existing row only when it is
  this tenant's and arrived on this credential (a retried answer). A row of another tenant or
  credential is `foreign`: the call is hung up, nothing is written, and nothing of that row is read
  or ended, on the answer path and the refusal path alike (`insertArrival`; the hangup webhook
  already ignored such a row). A real `CallUUID` names one call on one carrier account, so the
  collision only comes from a forged or replayed id on a credential that verifies. The index stays
  per provider: widened to the credential, a forged id would write a second row for one carrier
  call, and the hangup lookup would need the credential to choose between them.
- **The answer is bounded**: 4 s (`INBOUND_ANSWER_BUDGET_MS`, Plivo's own timeout is a P0 check),
  past which the caller hears the fallback message ("try again shortly") and the router's abort
  signal fires (`InboundAnswerOptions.signal`, docs/seams.md §3.5). The call is then the
  fallback's: an answer aborted before it wrote anything writes nothing; one aborted after takes
  no stream, ends its leg `failed` (`inbound_answer_timed_out`) and the spine `failed` with **no
  Missed row and no callback** (the caller was told to ring again, and §3.3's fallback promises
  nothing); a hangup webhook or play loop that settles such a call later does the same. Only an
  abort inside the bridge's own admission (Redis, milliseconds) leaves a promised stream, which the
  carrier's hangup or, failing that, the media deadline (30 s, `INBOUND_MEDIA_DEADLINE_SECONDS`)
  ends.
- **Refused** (`rejected` spine row, no Missed row, `<Hangup/>`): a number the credential does not
  have, not linked, not `active`, or not assigned to the credential's tenant.
- **Account** (§8.3): the matched contact's (its account may use the number) → the route's (while
  its account may still use the number) → the tenant default: no account, no leg, the carrier
  speaks the closed message (`<Speak>`), the Missed row has no account.
- **Plan**: `closed` when the credential is not `active` (§10), there is no route, or the route is
  closed now (`unresolvable` is closed); else `overflow` (open, and P1 has nobody to connect).
- **Admission** (IB5): under a per-route advisory lock in the transaction that writes the spine
  and leg, the route's live admitted calls (`state` past `arrived`) against `max_concurrent`; at the
  cap the call stays `arrived` and hears "busy" (`overflow_no_capacity`), else it moves to
  `greeting`. The bridge then takes the shared slots: over the account's own limit the call is
  held with no slot (admitted, IB5); with the global or carrier scope full it hears "busy" too and
  its admission is taken back (`greeting → arrived`, `refuseAdmission`). `arrived` therefore means
  "not admitted": the route's count and the account's live total (`countLiveForAccount`'s third
  arm, `state <> 'ended' AND state <> 'arrived'`, index `0026`) hold every admitted call, playing
  its message or waiting, and no refused one, so pacing shrinks for callers on our lines only. A
  refused call ends straight from `arrived`.
- **What the caller hears**: when the route has a recording for the plan's message (`callback` for
  `overflow`, `closed`, `busy` for `overflow_no_capacity`), our stream plays the `greeting` (if
  set) and that message, then a REST hangup. **A message with no recording is never silence**:
  the call is answered with the carrier's spoken message instead (`<Speak>`, British English, the
  voice and language of the fallback and tenant-default answers, `plivo-inbound.webhook.ts`), then
  `<Hangup/>`, and is ended at once with its Missed row and callback exactly as a played one
  (outcome the plan's; the leg `completed`, `inbound_<plan>`); nothing streams, no slot is taken,
  and a greeting recording is not played before it. The words: closed "Thank you for calling. We
  can't take your call right now. Please try again later."; call-back "… Everyone is busy at the
  moment. We'll call you back as soon as we can."; busy "… All our lines are busy at the moment.
  We'll call you back as soon as we can." A caller who withheld their number hears the closed
  words, not a callback promise nobody can keep. With the global or carrier scope full (known only
  once the stream is promised) and no busy recording, the plan's own recording plays instead. A
  greeting or recording notice with no clip is skipped; a clip that is set but cannot be played
  (missing, undecodable) is skipped, logged. The recording notice (IB7) plays only before a
  recorded call; P1 records no inbound call (nobody is bridged; a recording starts at the bridge,
  §6), so it never plays in P1. Recorded built-in clips remain open (§12).
- **Outcome**: the plan's once every message played. A caller who hangs up mid-message: on the
  `overflow` plan (they would have queued) `abandoned_in_queue`; on `closed` and
  `overflow_no_capacity` the reason stays (an after-hours caller rang after hours). No media ever:
  `failed`, unless the carrier's hangup came first. One writer ends a call: the play loop while
  this process holds it, else the hangup webhook (`abandoned_in_queue`; `failed` with no follow-up
  for a caller the fallback answered), else the sweep.
- **Follow-up** (§7): the Missed row on every call that reached nobody, assigned to the sticky
  candidate if they can see the account, else the account. The matched contact's callback
  (`bookInboundCallback`, in the transaction that ends the spine): campaign `running` or `paused`;
  contact `pending` (a sooner due time is kept) or `exhausted` (reopened, IB4); never `completed`,
  `suppressed`, DNC-suppressed or live; the caller not flagged DNC and the registry re-checked
  (anything but `clear` books none, B8); due at the route's next opening (`nextInboundOpening`; no
  route: now; a route that never opens: none). The callback is read by `isCallbackSql` (buckets,
  agent retry, insights, drill-downs, CA5's fallback, which now runs on catalogs with no callback
  code too), dialled by the ordinary claims (an owned contact by its owner on `strict` /
  `preferred`; on `pool` by anyone, from the owner's dedicated caller ID, DN2), and cleared when
  the contact's next placed call settles (`chargeAttempt`, a placed soft-phone call); an our-fault
  redial keeps it. An owner-less contact on a `strict` campaign is not assigned one: it waits for a
  supervisor, as CA5's fallen-back callbacks do. On a catalog with no callback code CA5's sweep
  reads only the campaign's inbound callbacks (`idx_agency_contacts_inbound_callback`, `0026`), so
  a tenant with no inbound pays one probe of an empty index per sweep, not a walk of the roster.
- **Sweep** (§10): at agency start, every call not ended that arrived before the process started
  (`abandoned_in_queue`, its Missed row, its callback), then the router is registered; every 5 min,
  calls older than the longest call (4 h) + 10 min. Inbound calls live in the process that answered
  them (with media workers, the primary: the stream URL carries no worker hint).
- **Metrics**: `agency_inbound_calls_total{outcome}`, `agency_inbound_answer_seconds{result}`
  (`stream`, `spoken`, `hangup`, `fallback`, `refused`, `timed_out`).
- **Fixture**: `plivo-inbound.fixture.json`, every entry unverified until P0; the reader depends on
  neither `CallStatus` nor `Direction` being present (it refuses only `Direction` naming another
  direction).

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

**The console (built, WP-D).** The campaign station takes the `inbound_call` frame (the whole
`AgencyInboundCall`, kept newest by `utils/inbound/inboundCall.ts`'s `newerInboundCall`: a later
offer wins, then settled over unsettled, then progress within one offer; the row has no
`updated_at`) and shows the caller's panel in place of the campaign's, under the station's header
and in its frozen geometry (`components/agency/inbound/InboundCallView.tsx`): the rail (incoming,
on a call with the talk timer, outcome needed with "Without one, it closes in m:ss" from
`outcome_due_at`), Caller / Contact / Outcome, and Save outcome → Mark DNC → Mute → Hang up in
every state. The panel renders on the offer frame and the chime (IB1, the cue `inbound_ring`)
plays from the frame handler, before the server binds audio at `connects_at`. It is chimed once
per offer (call id and `offered_at`, so a restatement is silent and a re-offer after a requeue
rings again); connect and disconnect follow, keyed on the call id; a call already under way on a
reload is silent. The microphone arms on the offer and the uplink opens on `bridged_at`
(`audioTarget`). Hang up (hold-to-confirm, or `E` twice) is offered only once connected. Pad
(the call's resolved `disposition_catalog`, rebuilt from `allowed_codes` on a refusal), notes
autosave (`PATCH`, 700 ms), callback time, Mark DNC (campaign scope when matched, else the
account) and the keys are the soft phone's. A `ready` keeps the call (the server restates it right
after); a reconnect asks `GET /inbound/calls/:id` and retires a copy the server no longer holds
for this session (`inbound_call_not_found`, another `session_id`). A call that leaves without the
agent's outcome says why on the station for 30 s (the caller hung up first; it went back to the
queue). At phone width the panel's columns stack and the body scrolls. "Your customer is
waiting" (`customer_waiting`) is a pill in the station's action bar; it goes on the server's
`customer_waiting` with `cleared: true` for that caller, and as a backstop on an offer, a `ready`
(re-sent while they wait) and the agent leaving reserved / on a call / wrap-up. Supervisors: `InboundQueueTiles` (`GET /inbound/queue`, every 5 s,
visible-only, last numbers kept and marked stale on a failed read) on the agency home and the
Missed calls page; the floor reads "Inbound call" for `on_inbound_call`. Every call path is in
`api/inbound.ts`'s `INBOUND_PATHS`.

**The server (built, WP-C1; §2's state machine).** The router (`inbound-call-router.ts`) plans
`queue` for an open route's admitted caller (a slot, or over the account's own limit: IB5) when the
call's account has `agency_inbound_enabled` on and the server runs one process (IB8, Q12, Q13);
the stream is taken connectable (parked for `parkedSecondsFor(route)`: the maximum wait, a minute of
preamble and the exit's 150 s; the 8 s station grace; recorded from the bind when the route records
and the account allows it) and handed to the connector (`inbound-connector.ts`, `runtime.inbound`).
The connector plays the greeting and, for a recorded call, the notice (IB7) through
`playInboundHold`, and queues the caller only when the preamble has played (`onPreambleDone`, Q5):
the spine `queued`, the per-route FIFO (`inbound-queue.ts`; a requeued caller at the head; over
`max_waiting` only an agent free now keeps them; the maximum wait and the loose sticky wait as
timers), "Your customer is waiting" to a busy sticky agent, `inbound_waiting` for pacing (§5.2),
and the search (`eligibility.ts`, §4.3: the call's account's console campaign sessions on this
process, open, in the route's pool when the account is the route's, `available` and holding
nothing; a caller whose sticky agent is free matched to them first; then FIFO, the sticky agent
alone in the sticky phase (loose: the wait; strict: the maximum wait; an agent away: the team at
once, Q6), else longest idle by Redis `since`, `planTick`'s order). The agent is reserved by
compare-and-swap (`reserveForInbound` from `available`), the spine offered (guarded on the
session), and with no await between: `agent_state: reserved` then the `inbound_call` frame
(`connects_at` = the offer + 1.5 s, Q4). At `connects_at` the station socket must be open (else the
offer is cancelled: back to the head of the queue, the next agent searched) and the bridge binds
it; on `bridged` the spine is `connected`, the agent `on_call`, the lease renewed. When the call ends
the spine is `answered` with the outcome owed and the agent `wrapup` with the `inbound` field kept
(no auto-return, Q11); a caller who hangs up on offer ends `abandoned_in_queue` with the Missed row
and callback and the agent goes back to the pool. Every step of one call runs on its serial chain.
**The release hook:** `releaseAgent`, with no queued break, asks the connector first; an agent
coming out of a call or a wrap-up is CASed from `reserved` / `on_call` / `wrapup` straight to a
waiting caller (theirs first), so a sticky agent is taken from wrap-up with no `available` instant.
The station's close cancels an offer not yet bound; a bound call keeps presence for the bridge's
8 s grace (the close handler and the silent sweep); a reconnect re-adopts the leg and restates the
call and the waiting notices after `ready`; `/leave` refuses while a call is offered or connected;
a restart lands an agent owing an outcome on `break` with the call re-claimed (`rehydrateAgent`).
The finish routes (`proxy-agency-inbound/calls.ts` → `agency/inbound-calls.ts` →
`inbound-disposition.ts`, not behind the flag): the call, its notes, hang up, the outcome (the
catalog of Q10, the soft phone's validation and decision, DNC for a suppress code, the contact
settled forward only by `inbound-settlement.ts`, never charged, then the agent returned) and Mark
DNC (the matched campaign's scope, else the account's), by the agent who took the call or a
supervisor on behalf; audited `agency_inbound_call.dispositioned` / `.hung_up` / `.dnc_marked`. A
minute's sweep closes outcomes owed past 30 minutes (`no_disposition`) and returns the agent. At a
graceful shutdown the connector stops taking work and the bridge's `service_shutdown` ends settle a
caller nobody took `failed` with its follow-up and callback (Q18); a crash leaves them to the next
start's sweep (`abandoned_in_queue`), and an answered call owing its outcome stays owed.
`GET /inbound/queue` (`agency.supervise`, the flag) answers a tile per route from the connector's
queue. Metrics: `agency_inbound_queue_waiting{route_id}`, `agency_inbound_wait_seconds{result}`,
`agency_inbound_offers_total{result}`. A caller who reaches nobody hears the route's call-back
message (closed for a withheld number) and is put down; with no recording for it, no words (a
stream cannot fall back to the carrier's spoken message). Not built here: the in-flight clash
(§5.4) and voicemail, which build on the connector's handover and the router's `overflow`.

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
by moving the call to `<Record>` XML, unless the P0 check proves the transfer clean: the bridge's
`recordInboundAudio` plays the prompt and a beep, then records the caller through a carrier tap
installed only for the recording (docs/seams.md §3.1). It is attached
to the Missed row and analysed if the route has a summary profile. There is no in-app notification
channel; the station frame is the in-app alert, e-mail is not used for missed calls.

## 8. Configuration

### 8.1 Who sets what

| Level | Who | What |
|---|---|---|
| Tenant's Plivo credential | super-admin | **Enable inbound**: create one Plivo Application on the tenant's account (answer, hangup and fallback answer URLs); store `inbound_app_id`, the URLs, the token's hash. Health check and Re-point on the credential page; **Disable** deletes it, refused while numbers are linked |
| Each number | super-admin (IB6) | **Link to inbound** per number, never on sync. Store the number's previous Plivo app (`inbound_previous_app_id`) so Unlink restores it |
| Tenant / account | super-admin | Flag `agency_inbound_enabled` (default off) gates the console surfaces; calls on linked numbers are always answered |
| Account | account admin (`agency.inbound.write`) | Inbound routes: name, numbers, hours/timezone/holidays, clips (greeting, hold, closed, busy, recording notice), sticky mode/wait/lookback, agent pool, queue limits, after-hours and overflow actions, recording and summary profile, outcome catalog for unmatched callers |
| Campaign | supervisor | Optional `inbound_sticky_enabled` (default on) |
| Agent | — | No setting. Sees their own Missed rows (`agency.inbound.read`, floored at `agent`) |

**As built** (`apps/server/src/telephony/credentials/inbound-service.ts`, `TelephonyInboundService`,
on the credential service: docs/seams.md §3.4). Routes, all super-admin, beside the credential routes
(`api/routes/super-admin-telephony-credentials/inbound.ts`; wire `contracts/api/platform/super-admin-inbound`):
`GET /telephony-credentials/:id/inbound`, `POST …/inbound/enable | disable | repoint`,
`GET …/inbound/health`, `GET /phone-numbers/:id/inbound`, `POST /phone-numbers/:id/inbound/link | unlink`.
Refusals are the credential routes' codes (`inbound_enabled`, `inbound_not_enabled`,
`inbound_numbers_linked`, `inbound_unconfigured` 503, `phone_number_not_linkable`,
`phone_number_not_linked`, `carrier_number_missing`, `carrier_refused`, and the existing
`carrier_rejected` / `carrier_unreachable`). The REST calls are `PlivoAdapter`'s (fixed host; shapes in
`plivo-inbound.wire.ts`, pinned by the fixture's `inbound` entries, unverified until P0).

- The Application is named `inbound-<credential id>` on the tenant's account. Health compares each
  URL's address, method and (answer, hangup) token with what is stored: `ok`, `url_mismatch`
  (naming the URLs), `app_missing`, `unreachable`; `stored_urls_current` says whether env would give
  the same URLs now. Re-point updates the Application (new token; the old one accepted for
  `INBOUND_TOKEN_REPOINT_GRACE_SECONDS`, 24 h); an Application gone from the account is made again
  and every linked number moved onto it.
- Link: only an active number synced from the credential, assigned to its tenant, while the
  credential is active with inbound enabled. The app the carrier had it on is stored
  (`inbound_previous_app_id`) and Unlink restores it (none: the number is left on no app).
- **Partial failures.** Each operator write runs its carrier WRITE inside the database transaction
  that records it, the credential row locked (`lockInbound`; a link takes it `FOR SHARE`), and
  commits last: a carrier refusal writes nothing. Enable, Link, Unlink and Re-point call the
  carrier and then write the row; Disable writes (`disableInbound`) and then deletes the
  Application, in the same transaction, so a refused delete rolls the write back all the same. The
  read-only carrier answers a write starts from (Enable's find-by-name, Link's current app) are
  read before the lock, so the row and a pool connection are held only across the carrier writes
  (one or two requests, plus Re-point's rare recreate path: its find-by-name and one move per
  linked number); a find-by-name reads at most 5 pages (`PLIVO_APPLICATIONS_MAX_PAGES`, logged when
  reached). Kept rather than redesigned: these are super-admin actions on one credential, each
  request bounded by `PLIVO_REQUEST_TIMEOUT_MS`, and the lock is what makes "commit last" safe. If
  the commit fails after the carrier accepted:
  Enable left an Application nothing stores, which the next Enable adopts by its name (an
  Application made in a transaction that fails before the commit is deleted on the spot); Re-point
  left a token we do not know (calls refused until the next Re-point; health says `url_mismatch`);
  Disable left a stored id Plivo no longer has (the next Disable reads the 404 as done); Link left
  the number on the Application unlinked (the next Link finds it there and stores no previous app);
  Unlink left it restored but linked (the next Unlink sets it again).
- **Two Re-points inside one call's life.** The credential keeps one previous token. A Re-point is
  refused (`inbound_previous_token_in_use`, 409) while a call answered before the last Re-point is
  still live on the credential (its hangup carries the token this Re-point would drop); otherwise
  the previous token is no longer needed and is replaced. The last Re-point is the previous token's
  expiry less the grace. A call lasts at most the longest call (4 h; the sweep ends any older), so
  a refusal lasts at most that long after a Re-point, and only while such a call is live.
- A credential the carrier refuses (the tenant closed or rotated the account) that is not active may
  Disable inbound without deleting the Application, audited `application_deleted: false` with the
  app id to remove by hand; an active one must delete it.

### 8.2 Number lifecycle cascade

One function, called from account tagging, unassign, retire by sync (PL5), credential disable and
revoke: marks the route number inactive, clears the link, and while the credential still works
unlinks the Plivo number back to its previous app. Revoke is refused while numbers are linked.
Each step audited.

**As built:** `TelephonyInboundService.reconcileNumber` / `reconcileCredential`. For each linked
number that may no longer be (not `active`, or not assigned to its credential's tenant; on a
credential disable, every linked number): its route detached (`detachNumberEverywhere`,
`number_unlinked`) and its link cleared in one transaction, committed whatever the carrier says;
then, while the number is still the account's (`active`), put back on its previous app through the
credential (`call_control`: a disabled credential still opens). Audited `phone_number.inbound_unlinked`
with `cause` (`unlinked` by hand, `unassigned`, `retired_by_sync`, `retired`, `deleted`,
`credential_disabled`) and `carrier` (`restored`, `number_missing`, `skipped_not_active`, `failed`:
the previous app id is in the row, to put back by hand). It never fails the write that called it (a
failure is logged; the next sync's reconcile retries). Call sites: `DELETE /super-admin/phone-numbers/:id/assign/:tenantId`,
`DELETE /super-admin/phone-numbers/:id` (retire), `POST …/:id/delete`, `PUT /super-admin/phone-numbers/:id`
to a retired or deleted status, `POST /telephony-credentials/:id/sync-numbers` (after the sync) and
`POST /telephony-credentials/:id/disable`. The Application stays on a credential disable (Disable
inbound removes it). **Revoke** is refused while inbound is enabled (`inbound_enabled`, 409, naming
the linked count), in the service and in the revoking statement (and by
`ck_telephony_credentials_inbound_revoked`). **Account tagging** has no write path in this build
(`tenantPhoneAssignmentRepository.tagToAccount` / `untagFromAccount` have no caller): tags do not
change a link (it is the tenant's), and a route that may no longer use a number is a route matter
for the route's own attach rule; a tagging route, when one is added, should call the cascade.

### 8.3 Which account a call belongs to

Plivo numbers sync to the tenant untagged, so several accounts may share one:
matched contact's account (if it may use the number) → the number's route → tenant default
(closed message + Missed row, no account).

### 8.4 The account's console (built)

Behind `agency_inbound_enabled`: every route below answers `403 inbound_disabled` with it off, and
the console shows none of it. Wire: `packages/contracts/src/api/agency/inbound.ts`.

**API** (`/proxy/agency/inbound/*`, B16): the public routes
(`apps/server/src/api/routes/proxy-agency-inbound.routes.ts` with `proxy-agency-inbound/`) check
the session, the permission, then the flag, derive the actor and `agency.supervise` from the
role, fill names and write the audit rows; the internal handlers
(`api/routes/agency/inbound.ts`, every one `none` in `core-owners.ts`) validate and write.

| Route | Permission | What it does |
|---|---|---|
| `GET /inbound/routes`, `GET /inbound/routes/:id` | `agency.inbound.write` | the account's live routes, oldest first, with their numbers |
| `POST /inbound/routes` | `agency.inbound.write` | create with `phone_number_ids`, one transaction: a refused number writes nothing |
| `PATCH /inbound/routes/:id` | `agency.inbound.write` | the fields present; `phone_number_ids` is the whole set. The route is read `FOR UPDATE` in the write's transaction and the merged route is judged whole, so two PATCHes cannot each pass the cross-field rules and together break them |
| `DELETE /inbound/routes/:id` | `agency.inbound.write` | soft delete, numbers detached; 204 |
| `GET /inbound/numbers` | `agency.inbound.write` | every active number the account may use, with `linked`, this account's route holding it, and `held_elsewhere` (another account's route; never named) |
| `GET /inbound/clips` | `agency.inbound.write` | the account's `audio_files`, newest first, at most 200 |
| `GET /inbound/missed` | `agency.inbound.read` | keyset page, newest first; `status` (default `open`), `assignee`, `reason`, `from`/`to` |
| `POST /inbound/missed/:id/handled` | `agency.inbound.read` | idempotent: first handler and time kept, audited once |

Validation past the body's shape (`route-config.ts`): each clip must be one of the account's audio
files (the FK has no tenant: the abandon clip's scoped check, so another tenant's recording can
never be played), the summary profile an active profile of the account, each pool campaign one of
the account's (a PATCH checks only the references it sets). Problems answer
`inbound_route_invalid` with `{ path, message }` per field. A number the account may not use,
an unlinked one, or one on another route answers its own 409 with `phone_number_id`
(`inbound_number_in_use` names the holder's `route_id` only when it is this account's). A
malformed id is the family's 404. Audit: `agency_inbound_route.created` (`numbers_added`),
`.updated` (`fields`, `numbers_added`, `numbers_removed`; not written when nothing changed),
`.deleted` (`numbers_removed`), `agency_inbound_call.handled` (`reason`; only when this request
marked it).

**Who sees which Missed rows.** An agent (no `agency.supervise`) reads and marks only the rows
assigned to them: the list is forced to `assignee=me` whatever was asked, and another's row
answers `inbound_missed_call_not_found`. A row assigned to the account (no sticky agent) is
therefore a supervisor's to work; §8.1 gives an agent "their own Missed rows", and a row nobody
owns shown to every agent would be worked twice or by nobody. Supervisors read the account's,
filtering by `me`, `unassigned` or a person.

**Voicemail in P1.** `voicemail` stays in the vocabulary and the column, but nothing records one
before P2, so a create or PATCH that leaves either action on it is refused `inbound_route_invalid`
at `after_hours_action` / `overflow_action` (`AGENCY_INBOUND_AVAILABLE_ACTIONS`, the contract's
list of what a route may be set to in this build); the console offers no choice and says
"Voicemail isn't available yet". Widening the list is P2's change, with its recorder. The editor
offers the actions from that list (`offeredUnconnectedActions`, P2): out of hours and when nobody
can answer become radio groups the moment it includes `voicemail`, with no console change; a
Missed row with `voicemail_url` gets **Play voicemail** (fetched with the console's token only when
pressed, played from a blob URL).

**Console.** Settings → **Inbound calls** (`/app/inbound`, `/app/inbound/new`, `/app/inbound/:id`;
account admins; also "Inbound settings" in the agency sidebar): the routes and the route editor
(name, time zone, numbers with why one cannot be chosen, weekly hours, holidays, the six clips from
the account's audio files (with none chosen, the closed, all lines busy and call-back messages
are read out in a standard voice and the greeting is skipped, §3.4),
their agent first (IB2 defaults), the team (pool campaigns), waiting and limits, recording and the
notice, summary profile, outcomes for unmatched callers). In the hours editor a closing time
earlier than the opening runs overnight and belongs to its opening day; a closing time of `00:00`
is midnight (sent as `24:00`), so `00:00`–`00:00` is the whole day. A save sends only what
changed. **Missed calls** is in the agency sidebar (`/agency/inbound/missed`) and, for a
dedicated agent, in the agent nav (`/dialer/missed`): To follow up / Handled, filters, keyset
paging, a DNC badge, and per row **Call back** and **Mark handled**. Call back opens the soft
phone (`/dialer/phone`) with the caller's number on the pad and the matched campaign as "Log to"
when the agent may log to it, carried in history state, never the URL
(`utils/softphone/prefill.ts`): nothing is dialled until the agent presses Call, a DNC caller
meets the soft phone's DNC check and override note (SP1), a withheld number cannot be called
back, and with the soft phone off the button is not offered. At phone width each row becomes a
card.

The campaign's `inbound_sticky_enabled` is "Put callers through to their agent" in the campaign's
settings and builder (P2), shown with `agency_inbound_enabled` on and sent on every save like the
other behaviour fields (with the flag off, the loaded value goes back as it came). Not built here: a
console surface for tenant-default Missed rows (`account_id` NULL: the API lists only the
request account's); uploading audio files (the console lists the account's; none can be added
from it yet).

## 9. Data model (built: `0024_inbound.sql`, `0025_inbound_checks_validate.sql`, `0026_inbound_live_indexes.sql`)

What P1 and the spine need; P2 adds what connecting agents needs (a later migration, never an edit).
The inventory with every CHECK is `packages/db/BASELINE.md` ("0024"); the contract lists each CHECK
holds are `packages/contracts/src/agency/inbound.ts`, pinned by
`packages/db/test/integration/db/inbound-migration.test.ts`.

- **`agency_inbound_routes`**: tenant (FK, cascade), account, name (one live name per account,
  case-insensitive), timezone, `weekly_hours` (`[{day, start, end}]`, ISO day, `HH:MM`, `end` may be
  `24:00`, `end < start` runs overnight and belongs to the day it opens on), `holidays`
  (`[{from, to, label}]`, local dates inclusive, at most 31 days each), six clip ids
  (`greeting`, `hold`, `closed`, `busy`, `recording_notice`, `callback`; FK `audio_files` ON DELETE
  SET NULL: NULL is the built-in clip), `sticky_mode` / `sticky_wait_seconds` /
  `sticky_lookback_days` (IB2: `loose`, 30 s, 30 days), `pool_campaign_ids` (empty: the whole
  account), `queue_max_wait_seconds` (120), `max_waiting` (10), `max_concurrent` (20; this build's
  default), `after_hours_action` / `overflow_action` (`callback | voicemail`, default `callback`,
  IB3), `record_calls`, `recording_notice` (IB7, default on), `analysis_profile_id`,
  `disposition_catalog` (`[]`: the built-in catalog), soft delete (`deleted_at`). Bounds:
  `AGENCY_INBOUND_ROUTE_LIMITS`, CHECKed too; `sticky_wait_seconds ≤ queue_max_wait_seconds`,
  `max_waiting ≤ max_concurrent`.
- **`agency_inbound_route_numbers`**: route ↔ `phone_number_id`, one ACTIVE row per number
  (`uq_agency_inbound_route_numbers_active`); a detached row keeps when, by whom and why
  (`detached`, `route_deleted`, `number_unlinked`: the §8.2 cascade).
- **`agency_inbound_calls`** (the spine, and the Missed row): tenant, account (NULL: the tenant
  default, which has no route, match or media leg), route, number rung, provider and credential
  (composite FK, as `agency_calls`'), `provider_call_id` (unique per provider: a retried answer
  webhook finds its row), from (NULL: withheld) / to E.164, matched contact and campaign,
  `caller_dnc`, sticky user + reason (`owner`, `last_from_number`, `last_connected`,
  `last_dialled`), state `arrived → greeting → queued ⇄ offered → connected → ended`, outcome
  (`answered`, `abandoned_in_queue`, `overflow`, `overflow_no_capacity`, `closed`, `voicemail`,
  `rejected`, `failed`), `arrived_at`, `answered_at` (our answer), `bridged_at` + answered by,
  `ended_at`, `talk_seconds`, `webrtc_call_id`, `voicemail_key`, `callback_due_at` (the callback this
  call booked), and the follow-up: `follow_up_status` (`open | handled`), `follow_up_reason`
  (`closed`, `abandoned_in_queue`, `overflow`, `overflow_no_capacity`, `failed`), assignee (the
  sticky agent, else NULL for the account), handled by + at. A Missed row exists only on an ended
  call that is neither `answered` nor `rejected`. Indexes: the Missed list by account and status,
  and by assignee, newest first; open rows by age for the sweep.
- **`agency_calls.origin`** += `inbound` with `inbound_call_id`; the origin CHECK is rewritten; the
  manual-correlation CHECK (0005) needed no change, since its arms already keep an inbound leg's
  campaign, attempt and manual call NULL; `ck_agency_calls_inbound_correlation` is new. An inbound
  leg's `caller_id` is the number rung and `destination_phone` the caller's (`''` when withheld).
  The status webhook resolves the call through the spine (`uq_agency_inbound_calls_provider_call`);
  no new `agency_calls` index. The `'agency'` call scope takes inbound legs.
- **`agency_contacts`**: `callback_source` (`inbound`) and `callback_due_at`, together. Read by
  nothing yet: the inbound follow-up widens `isCallbackSql` (`callback_source IS NOT NULL OR` the
  disposition rule) and the claim, and clears both when the contact's next call settles.
- **`agency_campaigns.inbound_sticky_enabled`** (default true).
- **`telephony_credentials`**: `inbound_app_id`, the three URLs the Application was given (answer,
  hangup, fallback answer; stored without the token query, the signatures' subject), the token as
  sha256 hex only (`inbound_token_hash`; the raw token exists only in the URLs given to Plivo), the
  previous token's hash and expiry (a Re-point's grace), `inbound_enabled_at`. All or nothing; a
  revoked credential cannot hold an Application.
  **`phone_numbers`**: `inbound_linked_at` (the link flag, only on a synced number) and
  `inbound_previous_app_id`.
- **Usage counts**: the third arm (`usage-counts.repository.ts`): inbound calls with an account
  count as `dials` (every agency call that began in the window), windowed on `arrived_at`.

The two big tables' CHECKs are added `NOT VALID` by 0024 and validated by 0025 (0009 / 0010's split).
`0026` adds the indexes the reads need: `idx_agency_inbound_calls_account_live` (IB5's per-account
count of admitted calls), `idx_agency_contacts_inbound_callback` (a campaign's open inbound
callbacks, for CA5's sweep on a catalog with no callback code) and `callback_source` in
`idx_agency_contacts_insights`. Its builds scan `agency_contacts` under SHARE locks: acceptable
because a deploy stops the one server before the new container migrates (DEPLOYMENT.md), as for
every index migration before it (`packages/db/BASELINE.md`).

Audit actions: in `super_admin_audit_log`, `telephony_credential.inbound_enabled` /
`inbound_disabled` / `inbound_repointed`, `phone_number.inbound_linked` / `inbound_unlinked`
(`INBOUND_SUPER_ADMIN_AUDIT_ACTIONS`); in `platform_audit_log`, `agency_inbound_route.created` /
`updated` / `deleted`, `agency_inbound_call.handled`. Ids and numbers only. Flag
`agency_inbound_enabled` (default off, client-exposed: the console surfaces only); permissions
`agency.inbound.read` (floored at `agent`: an agent's own Missed rows) and `agency.inbound.write`
(`account_admin`).

### 9.1 What P2 adds (built: `0027_inbound_connect.sql`)

The agent side of `agency_inbound_calls` (inventory and every CHECK: `packages/db/BASELINE.md`
"0027"):

- `session_id` (the agent session offered or connected; cleared by a requeue), `queued_at` (the
  first queueing: the maximum wait counts from it), `offered_at` (the latest offer), `offer_count`,
  `recording_requested` (the leg's, mirrored), the outcome as the soft phone's
  (`disposition_code`, `disposition_source` `campaign | route`, `notes`, `callback_at`, who and
  when, on behalf), `settled_at`, `voicemail_seconds`, `clash_attempt_id`.
- An `offered` or `connected` call has its session; earlier states have none. One unsettled call
  per session (`uq_agency_inbound_calls_session_unsettled`). An unbridged call settles in the
  UPDATE that ends it; a bridged one when its outcome is saved or lapses (`no_disposition`,
  `AGENCY_INBOUND_OUTCOME_LAPSE_MS`, 30 min), never by the end or the startup sweep, which leave
  the outcome owed for the agent's return.
- The busy probe (`numberLiveSql`, MC4, §5.4) gains an inbound arm over
  `idx_agency_inbound_calls_live_from_digits`: a number whose customer is on an admitted, live
  inbound call to the account, or one bridged and owing its outcome, is busy for pacing's claims,
  the agent's own dial and retry; the soft phone refuses it `customer_on_inbound_call` (not
  `contact_in_flight`: the customer is calling us, and an unmatched caller has no contact to name).
  An `arrived` (unadmitted) call keeps nothing busy, as IB5's count reads it.
- The agent's Redis hash carries `inbound` (the call it holds). `available` is refused while it is
  set (`-3`, `inbound_call_owed`, answered `409 inbound_call_live` by `/available`,
  `force-available` and the return from the soft phone, read from the database first as the soft
  phone's guard is), and no attempt is ever reserved onto such a session (a CAS to `reserved`
  refuses). `reserveForInbound` takes an agent from the states asked for (`available`; `reserved`
  / `on_call` / `wrapup` for the release hook), `releaseInbound` clears only its own id, and
  `rehydrateInbound` lands a session that owes an outcome in `break` with the call re-claimed.
- Settling the matched contact (`settleFromInbound`, SP6 forward only, never charged): `pending`
  takes a callback, a success or a suppress; `exhausted` is reopened only by a callback; a live
  contact takes only a suppress; a terminal one nothing; the contact's inbound callback is cleared.
  A dial superseded by its customer's call returns its contact uncharged (`unclaimUncharged`).

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
| P1 | Answer every call, connect nobody: credential Enable inbound + Application, per-number link/unlink + cascade (pilot tenant first), answer and status webhooks, spine + `origin = inbound`, routes with hours/holidays/clips (closed, "we'll call you back", recording notice), follow-ups (Missed list, inbound callback on contacts), startup sweep, usage, audit, flag, RBAC, super-admin and console screens | **done** (the review's fixes below): foundation done (`feat(db,contracts,domain,server): inbound calls foundation`: `0024_inbound.sql` and `0025_inbound_checks_validate.sql`, contracts, flag, permissions, audit names, the schedule and number rules, the route and spine repositories, usage). **Super-admin slice done** (`feat(server,super-admin,contracts,db): inbound Plivo Application, number links and the lifecycle cascade`, §8.1, §8.2, §3.3): Enable / Disable / Health / Re-point, Link / Unlink, the cascade at every write that exists, revoke refused, the routes, the credential page's Inbound section and the numbers page's Link / Unlink and badge, the fixture's Application and number shapes (unverified until P0), the mock carrier's; `agency_inbound_enabled` is toggled on the generic flag screens. Rollout: link a pilot tenant's numbers first. **Webhook slice done** (§3.4): the answer, hangup and fallback webhooks, the inbound seam, the bridge's `acceptInboundCall` / `playClipSequenceThenHangUp`, caller identification, admission (IB5, `0026_inbound_live_indexes.sql`), the Missed row and the inbound callback (IB4) on the dialer's claims, the sweep, metrics. Open: recorded built-in clips (an unset message slot is spoken by the carrier, §3.4), Plivo's answer-URL params and timeout (P0). **Console slice done** (`feat(server,console,contracts): inbound routes and the Missed calls list in the console`, §8.4): the routes API with the editor's number and clip choices, the Missed list and Mark handled, Settings → Inbound calls, Missed calls for supervisors and agents with Call back into the soft phone; voicemail refused until P2; the campaign's `inbound_sticky_enabled` toggle and tenant-default Missed rows left open (§8.4). **Review fixes** (`fix(server,db,console,contracts,super-admin): inbound P1 review fixes`): a `CallUUID` held by another tenant or credential is refused (§3.4); the migration renumbered `0026` (no gap; the fixes needed no new migration, so the next one is `0027`); IB5's arm counts admitted calls only; CA5's code-less sweep reads an index of inbound callbacks; read-only carrier calls out of the operator transactions and the Application list bounded (§8.1); an answer past its budget leaves no follow-up; a second Re-point refused while the first's token is still needed (§8.1); an unrecorded message spoken by the carrier, never silence (§3.4) |
| P2 | Connect agents (console, single process, IB8): parked mode with looped hold, inbound reservation + panel + outcome + wrap-up, sticky loose/strict, team queue, `inbound_waiting` on the pacing bus, take-from-wrap-up CAS, in-flight clash (§5.4), concurrency answers (§5.3), voicemail, supervisor queue tile | in progress. **Foundation done** (`feat(db,contracts,server,console,mobile): inbound P2 foundation`, §9.1): `0027_inbound_connect.sql`; the contracts (`AgencyInboundCall`, the `inbound_call` and `customer_waiting` frames for console stations only, release reason `inbound_call`, the inbound call codes, `customer_on_inbound_call`, the queue tile, `voicemail_url`, `on_inbound_call`, the constants, the reserved code `inbound_call`); the `inbound_waiting` bus event with no consumer; the agent hash's `inbound` field (`reserveForInbound`, `releaseInbound`, `rehydrateInbound`, `available` refused `-3` and answered `409 inbound_call_live`, no attempt reserved onto it); the spine's agent-side writes; the busy probe's inbound arm (pacing, the agent's own dial and retry, the soft phone's pre-dial); `settleFromInbound` and `unclaimUncharged`; the campaign's `inbound_sticky_enabled` on create, PATCH and retry. Nothing connects yet: the connector, queue, hold loop, voicemail and the console panel follow. `AGENCY_INBOUND_AVAILABLE_ACTIONS` stays `callback` until the voicemail flow lands. **Bridge and voice done** (WP-B, docs/seams.md §3.1): a connectable call is parked (borrowed-unbound; its budget, answer XML stream timeout and slot TTL are parked + max duration; a parked backstop), `playInboundHold` (the preamble once, then the hold clip or the built-in generated hold tone on a loop, Q24; never hangs up), `stopInboundHold`, `recordInboundAudio` (prompt, beep, a bounded carrier tap with nobody bound), the bind stopping the hold synchronously, re-arming the max duration and counting talk time from it, and the recording from `bridged` through Plivo's Record API (its request and callback shapes unverified until P0). **Connector done** (WP-C1, §6 "The server"): the `queue` plan gated on the flag and one process, the preamble then the queue, sticky loose/strict, the team queue and its limits, the offer and the bind, the release hook taking an agent from wrap-up, `inbound_waiting` consumed by pacing, the station's drop and reconnect, the restart, the outcome routes and their audit, the lapse sweep, the queue tiles route, the metrics; `onPreambleDone` added to the hold seam and `cleared` to `customer_waiting`. Open: the in-flight clash (§5.4) and voicemail. **Console done** (WP-D, §6): the station's `inbound_call` and `customer_waiting` handling and restore after `ready`, the inbound chime, `InboundCallView` in the station's geometry with the outcome, notes, callback, hang-up, mute, DNC and the lapse countdown, the waiting pill, the supervisor's queue tiles and the floor's "Inbound call", the campaign's "Put callers through to their agent", voicemail playback on the Missed list and the route editor's actions from `AGENCY_INBOUND_AVAILABLE_ACTIONS`; built against the call routes' paths in `api/inbound.ts` (`INBOUND_PATHS`) and mock answers, its end-to-end check waits for the server's routes |
| P3 | Mobile app frames (Dart wire), pickups from break and soft phone, media-worker handover, reports/Insights, "press 1 for a callback" if DTMF works | not started |
| P4 | VoiceLink behind a carrier-module `inbound` capability | not started |

P1 can be built and tested end to end against the mock Plivo carrier before P0 runs; P0's results
then correct the fixture. Contract changes run the mobile `agency_wire` `dart test` before commit
(root `CLAUDE.md`).
