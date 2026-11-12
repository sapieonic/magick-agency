# Inbound calls

Customers ring back the numbers agency dials them from. This is the design for answering those
calls on Plivo numbers (tenants' own accounts, B18–B22), putting the caller through to the agent who
spoke to them where possible, and turning every call nobody takes into a follow-up. VoiceLink
follows later behind the same router. Designed and reviewed 2026-11-09; Manas locked IB1–IB8 the
same day. **P1 is built** (§12): the foundation (§9), the operator side (§8.1, §8.2), the
webhooks, what callers hear and the follow-ups (§3.4), and the account's console (§8.4), with the
review's fixes. **P2 is built** (§12): callers put through to agents on the console (§6), the
in-flight clash (§5.4) and voicemail (§7). **P3's mobile station is built** (2026-11-10,
IQ46 and IQ47, §6 "Mobile stations"): a phone whose station declares `caps=inbound` is offered
callers as a console is, and the agent app takes them on its station and lists the agent's Missed
calls with Call back ([`mobile.md`](mobile.md) "Inbound calls", "Missed calls"; not yet run on a
phone or a carrier). **Mode B is built on the server and Android** (2026-11-12, IQ58–IQ74, §6.1):
an agent who leaves the app having opted in has their phone rung by a push for a caller, and
answering it puts the caller through to the app; iOS is designed only, and none of it has run on a
phone, FCM or APNs. An independent engineering, product and QA review of P1 and P2 was fixed in
two rounds (the fix pass, §12). §12 is the build plan and its status; P0 (the live Plivo checks),
the rest of P3 (pickups from a break and the soft phone, the media-worker handover, inbound in
reports, Insights and customer history, voicemail analysis, "press 1 for a callback") and P4 are
open.

It replaces launch decision 3 ("inbound calls play a message and hang up") for Plivo numbers that a
super-admin links to inbound. Unlinked numbers, and every VoiceLink number, keep today's behaviour.

## 1. Decisions

Status words as in [`decisions.md`](decisions.md). The design's decisions are below. The build's
rulings (the P2 plan's, IQ1–IQ24), the fix pass's decisions (IQ25–IQ45), the mobile app's
(IQ46–IQ47), the pilot rulings (IQ48–IQ57) and Mode B's (IQ58–IQ74, with the plan review's N1–N5)
are recorded in [`decisions.md`](decisions.md) §4, "Inbound P2 build rulings", "Inbound fix pass",
"Inbound calls on the mobile app", "Inbound pilot rulings" and "Mode B", with the
earlier ruling each one amends; this document and the code cite them as `IQ<n>`, and the review
findings a fix closes (`SWE-…`, `PM-…`, `QA-…`) are named in those rows.

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
only; with workers on, P2 keeps P1's answer (nobody is connected, logged once, IQ13). Placing an
inbound call on an agent's worker, and the cross-worker handover (a Plivo transfer to a new
`<Stream>` URL on the agent's worker), are P3, after the P0 check.

**It is loud, not silent** (`telephony/credentials/inbound-monitor.ts`, started by
`bootstrap/voice.ts`): `MEDIA_WORKERS=0` is a deployment invariant while any credential has inbound
enabled (`operations.md`, "Deployment invariants"; `DEPLOYMENT.md` 8.6). At boot the server sets
`agency_inbound_connect_available` (1 with no workers, 0 with) and, when a credential has inbound
enabled with workers on, logs a warning; the super-admin credential section says "Calls can't be
put through to agents: media workers are on" (`connects_agents` on the credential's inbound state);
`agy-inbound-connect-unavailable` pages while the gauge reads 0 and a credential has inbound
enabled; and the route editor warns (§8.4, "Route warnings"; IQ38).

### 3.3 The fallback answer XML

Plivo fetches the Application's fallback answer URL when the answer URL fails or times out. Our own
route covers a failing answer handler; a static file hosted elsewhere also covers this deployment
being down. To host one:

1. Put this file on any `https:` host that does not depend on this deployment (an S3 bucket behind
   CloudFront, any CDN or static host), answering `GET` with `Content-Type: application/xml`:

   ```xml
   <Response>
     <Speak voice="WOMAN" language="en-GB">Thank you for calling. All our lines are busy at the moment. Please try again shortly. Goodbye.</Speak>
     <Hangup/>
   </Response>
   ```

   The standard busy message's words in the voice of the server's own spoken messages
   (`PLIVO_INBOUND_BUSY_XML`), not the closed one (false in opening hours). (`<Play>` of a hosted
   MP3 works too, our `busy.wav` for one.) It must not promise a callback: a call answered by the
   fallback never reaches us, so it leaves no Missed row.
2. Set `PLIVO_INBOUND_FALLBACK_ANSWER_URL` to its URL (absolute `https:`, no fragment; checked at
   startup) and restart the server.
3. **Re-point** every credential with inbound enabled: an Application keeps the URL it was given
   until then (the health check says `stored_urls_current: false` meanwhile). The Application then
   fetches it with GET; our own route is fetched with POST.

It is on the pre-deploy checklist (`DEPLOYMENT.md` 8.6 and 9), and with `NODE_ENV=production` the
server warns at boot while a credential has inbound enabled and the variable is unset
(`inbound-monitor.ts`).

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
  6 h; a request with no signed nonce is refused). The nonce check fails CLOSED: when Redis cannot
  answer, both URLs answer 503, so Plivo answers the caller from the Application's fallback answer
  URL (and retries the hangup), and no captured callback can be replayed through a Redis outage
  (`claimCredentialCallbackNonce` answers `claimed`, `replay` or `unavailable`; with no Redis
  configured at all, a dev process, every nonce is claimed). A refusal is `<Hangup/>` on the
  answer URL, 403 on the hangup URL; a fault is the fallback message, 503 on the hangup URL, the
  nonce given back. The fallback answer URL answers fixed XML to anyone.
- **Tenant isolation**: a `CallUUID` is unique per provider (`uq_agency_inbound_calls_provider_call`),
  not per credential, so the answer's insert, on a conflict, uses the existing row only when it is
  this tenant's and arrived on this credential (a retried answer). A row of another tenant or
  credential is `foreign`: the call is hung up, nothing is written, and nothing of that row is read
  or ended, on the answer path and the refusal path alike (`insertArrival`). The hangup webhook
  likewise ends only a row of its own tenant and credential: one naming another tenant's, or
  another credential's, `CallUUID` names no leg and changes nothing (pinned by
  `inbound-call-router-hangup.test.ts`). A real `CallUUID` names one call on one carrier account, so the
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
  set) and that message, then a REST hangup. **No caller is put down in silence.** A call that
  will only hear a message the route has no recording for is answered with the carrier's spoken
  message instead (`<Speak>`, British English, the voice and language of the fallback and
  tenant-default answers, `plivo-inbound.webhook.ts`), then `<Hangup/>`, and is ended at once with
  its Missed row and callback exactly as a played one (outcome the plan's; the leg `completed`,
  `inbound_<plan>`); nothing streams, no slot is taken, and a greeting recording is not played
  before it. On our stream (a caller who may queue, a voicemail, a recording that turns out not
  to play, the scopes found full once the stream is promised) a message with no recording of the
  route's plays **our standard recording** of the same words: recorded WAVs committed under
  `apps/server/assets/inbound/` (synthesised offline in a British English voice, drop-in
  replaceable, `assets/inbound/README.md`; the image copies them beside `dist/`), loaded into the
  clip cache through its content-addressed path on first use (`inbound-standard-clips.ts`). The
  words are one set, `AGENCY_INBOUND_STANDARD_WORDS` (contracts), for both the recordings and the
  carrier's `<Speak>`:

  | Message | Words |
  |---|---|
  | closed | Thank you for calling. We’re closed at the moment. Please call again during our opening hours. Goodbye. |
  | busy | Thank you for calling. All our lines are busy at the moment. Please try again shortly. Goodbye. |
  | call-back | Thank you for calling. Everyone is busy at the moment, so we’ll call you back as soon as we can. Goodbye. |
  | recording notice | This call may be recorded for quality and training purposes. |
  | please hold | Thank you for calling. Please hold and we’ll put you through to the next person available. |
  | voicemail prompt | Please leave your name and a short message after the tone, and we’ll call you back. |
  | neutral voicemail prompt | Please leave your name, your number and a short message after the tone. |

  A caller who withheld their number **or whose number is on DNC** is never promised a callback
  nobody can or may make, and is never told "we're closed" while the line is open (PM-N1): in
  opening hours (an open route's caller nobody takes, at the answer or from the queue) they hear the
  **busy** words instead of the call-back ones, on every path (spoken, played, the queue's exit;
  `messageSlotFor`); a `closed` plan keeps the closed words for everyone, and over capacity is busy
  for everyone. Where the route's action is voicemail they can always leave one: their prompt is
  our **neutral** recording (`voicemail-prompt-neutral.wav`, the seventh), whatever the route's
  recordings, which would say "we're closed" or promise a call (`voicemailPrompt`). With the global or
  carrier scope full (known only once the stream is promised) the caller hears "busy", the route's
  recording or ours. Before a closed, busy or call-back message an unset greeting is skipped; a
  caller who will wait for an agent hears the greeting or, unset, our "please hold", then the hold
  sound (the route's hold recording, else the built-in hold tone, IQ24). The recording notice (IB7)
  plays before a recorded call whenever the route's notice switch is on: the route's recording,
  else ours; with the switch off nothing is said (the editor and API warn,
  `recording_without_notice`). A recording that is set but cannot be played (missing, another
  account's, undecodable) falls back to ours where the part has one, logged.
- **Outcome**: the plan's once every message played. A caller who hangs up mid-message: on the
  `overflow` plan (they would have queued) `abandoned_in_queue`; on `closed` and
  `overflow_no_capacity` the reason stays (an after-hours caller rang after hours). No media ever:
  `failed`, unless the carrier's hangup came first. One writer ends a call: the play loop while
  this process holds it, else the hangup webhook (`abandoned_in_queue`; `failed` with no follow-up
  for a caller the fallback answered), else the sweep.
- **A hangup before the answer finishes** (the caller gave up during our answer-URL work, so
  Plivo's hangup lands first and finds no row): the router remembers it for 30 s
  (`INBOUND_EARLY_HANGUP_MS`), under the credential and tenant that verified it, and the answer
  that follows ends its freshly written row at once as the caller who left (the early-hangup rule
  above: an open route's caller `abandoned_in_queue`, a closed or busy reason kept), with its
  Missed row and callback, and answers `<Hangup/>`: no stream promised, no bridge session or slot
  held until the media deadline, never `failed`. A hangup that finds the row while the answer is
  still taking its stream ends the row and the answer lets that stream go at once. Another
  credential's hangup for the `CallUUID` changes nothing.
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
  (a bridged one `answered`, still owing its outcome; any other `failed`, its Missed row reason
  `failed`, its callback: we lost the caller, nobody knows they hung up), then the router is
  registered; every 5 min, calls whose latest start (`COALESCE(bridged_at, arrived_at)`: the bind
  re-arms the max duration) is older than the longest parked budget (`INBOUND_MAX_PARKED_SECONDS`,
  the longest maximum wait + the preamble + the exit) + the longest call (4 h) + 10 min, so a live
  call, however long it was parked, is never swept. Inbound calls live in the process that answered
  them (with media workers, the primary: the stream URL carries no worker hint).
- **Metrics**: `agency_inbound_calls_total{outcome}`, `agency_inbound_answer_seconds{result}`
  (`stream`, `spoken`, `hangup`, `fallback`, `refused`, `timed_out`); with P2 the queue's
  (`agency_inbound_queue_waiting`, `agency_inbound_wait_seconds`, `agency_inbound_offers_total`);
  and the two operations gauges, `agency_inbound_connect_available` (§3.2) and
  `agency_inbound_applications{health}` (§8.1, the scheduled health check). Grafana: the
  dashboard's *Inbound calls* row and the `inbound` alert group (`grafana/README.md`; runbooks in
  `operations.md`, "Alert runbooks").
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
| 3 | The last agent who spoke to the customer (connected), in either direction: an answered inbound call counts (IQ49) | attempts, manual calls, the caller's bridged inbound calls (`answered_by_user_id`; `idx_agency_inbound_calls_answered_from`, `0033`) | on |
| 4 | The last agent who dialled them, unanswered | attempts | off |

The dedicated caller ID (DN) is deliberately not a signal: when every number of a campaign is
dedicated, unowned contacts are dialled from someone's dedicated number (DN3). Ties across contacts
and campaigns: prefer the contact whose latest outbound call used the number rung, then the most
recent. The matched contact decides the account and campaign context shown to the agent, provided
that account may use the number rung. A campaign may opt out (`inbound_sticky_enabled`, default on).

### 4.2 Modes

`off`; `loose` (default: offer the agent for `sticky_wait_s`, then the team, still preferring the
agent if they free first); `strict` (only that agent until max wait; then a follow-up assigned to
them, never another agent). As built (IQ6), `strict` holds the caller only while their agent is
working (on a call or finishing one): an agent who is offline, on a break, on an app build that
cannot take inbound calls (no `caps=inbound`, IQ46) or on another account sends the caller to the
team at once. The editor calls it "Wait for their agent"
and says so.

### 4.3 Sticky agent's state → what happens

Eligible means the agent's live session is in the route's account (or the matched contact's
account): one live session per agent across tenants (OS1), so an agent working another account is offline
for this call.

| State | P2 | P3 |
|---|---|---|
| `available`, campaign session, eligible | reserve now (CAS), connect | same |
| `reserved` / `on_call` | hold; "Your customer is waiting" frame; taken from wrap-up when the call ends | same |
| `wrapup` | taken from wrap-up by CAS (the `reserveFromWrapup` pattern, WR5), so pacing never sees an `available` instant, however long the write-up: the station heartbeat keeps the `wrapup` lease (§6) | same |
| `break` (catalog reasons) | skipped → team | Take call prompt; reservation from break with a guard; `break_reason` added to the Redis hash or read from the mirror |
| `break/soft_phone` | skipped → team | taken as a manual call (`manual` claim, `agency_manual_calls` row): a soft-phone session can never be `reserved` (0005 CHECK) |
| `break/device_away` | skipped (cannot ring) | skipped (counts as could take for 30 s, IQ50) |
| `break/away_ring` (Mode B: away from the app, opted in) | — | **built (IQ58–IQ74, §6.1):** rung by a data push, not offered on a station (there is none): the sticky agent's phone for one window before the team on screen, under `strict` too (IQ63, amending IQ6); a team member's phone only when nobody is on screen; answered, the app's station takes the call as any mobile offer; declined or missed, the caller goes to the team and never rings that phone again |
| mobile app (`client=mobile` station) | treated as offline (the app had no inbound frame) | **built (IQ46, IQ47):** a station that declared `caps=inbound` (the app sends it on every connect) is a console's equal (offered, sent the frames, taken from wrap-up, the hand-over, the tile), and the app shows the offer, the call and the outcome on its station ([`mobile.md`](mobile.md) "Inbound calls"); one that did not (every older build) is still treated as offline and never sent the frames. Only with the app on screen: leaving it pauses the agent `device_away`, or, opted in on an account with Mode B on, `away_ring`, whose phone is rung (row above) |
| `offline`, or live on another account | team at once; follow-up assigned to them if nobody answers | same |
| unstaffed, membership removed, user deactivated | not sticky: next signal, else team; follow-up to the account | same |

## 5. When everyone is engaged

### 5.1 Queue

The route's agent pool: agents with a live campaign session in the route's account (option: only
agents staffed on listed campaigns), a phone only when its station declared `caps=inbound` (IQ46;
every older app build excluded). Longest idle first, the fairness
pacing uses. Limits per route: `queue_max_wait_s` (120), `max_waiting` (10), `max_concurrent`
(waiting + connected). Over a limit → overflow message → follow-up. A station lost before audio
binds puts the caller back at the head of the queue.

**As built (P2 review fixes).** A caller nobody could ever take is not held to the maximum wait.
"Could take" is a station that can take inbound calls (a console, or a phone that declared
`caps=inbound`, IQ46) on this process, on a campaign in the pool (the route's pool
applies only to a caller of the route's own account, IQ21), whose agent is an active user with an
active membership that sees the call's account, in `available`, `reserved`, `on_call` or `wrapup`
(another call held counts: it ends). An agent on a break, offline, on an app build without
`caps=inbound`, outside the
pool, on the soft phone, removed from the account or who turned this caller down does not count.
With nobody who could, the caller is overflowed at once (the route's overflow action, written
`overflow` on the spine as any overflow is: the vocabulary has no closer word, and a migration was
not wanted for it), counted apart as `agency_inbound_overflows_total{reason="no_agents"}`. Asked at
every search: when the caller queues, and while they wait whenever presence changes as the
connector hears it (an agent available; a break, which no event reports: the next 2 s republish;
a station's rejoin grace ending, below).

**Decided at the answer (round 2, PM-M6 / SWE-N4).** The router asks the same question, with the
connector's own rule and presence read (`InboundConnector.couldAnyoneTake`), before the greeting:
a caller nobody in their pool could take is not queued, never hears "please hold" and is never
recorded; they get the route's overflow action at once, as any open-route caller nobody can take
(the call-back message, spoken by the carrier or played from our stream, or a voicemail),
`overflow` on the spine and `no_agents` on the metric. A read that fails queues them as before
(the connector asks again).

**The rejoin grace (round 2, SWE-F1).** A station whose socket closed less than
`INBOUND_STATION_REJOIN_GRACE_MS` (15 s: the console's reconnect and the bridge's 8 s deferred
hangup) ago still counts as one who could take a caller when its agent was then, or is still, in
`available`, `reserved`, `on_call` or `wrapup` (the registry's detach hands the connector the
station, and the connector reads the agent's state at once, before the close handler writes
`offline`; a live call keeps `on_call` across the blip). It is never offered a caller (no open
station), only counted, so a Wi-Fi blip, a page refresh or a backlog close of the one agent who
could take the account's callers does not overflow them all. When the grace ends the account is
searched again (its own timer, as well as the 2 s republish): a caller held only by an agent who
never came back is overflowed then. An agent who was on a break when the station closed never
counted and does not.

**The device-away grace (IQ50).** A phone's `device_away` pause less than
`DEVICE_AWAY_RETURN_GRACE_MS` (30 s, contracts; the server's `INBOUND_DEVICE_AWAY_GRACE_MS`) old
counts as one who could take a caller (`awayGrace`), never offered one: the app returns an agent who
comes back within 30 s on its own, so callers queue for them instead of overflowing at once. When
the pause began is the session row's (`state_since` with `break_reason = 'device_away'`; Redis holds
no break reason), read only for sessions Redis says went on a break inside the grace; a failed read
counts nobody. When the grace ends the connector searches the account again, as for the rejoin
grace. A `phone_call` pause (IQ51) never counts: the agent is on another call.

**Ringable agents (IQ68, Mode B, §6.1).** An agent on `away_ring` whose phone may be rung for the
caller counts as one who could take them, and so does one whose phone is ringing now for another
caller; an agent this caller already declined or missed does not.

### 5.2 Inbound priority over pacing

A waiting caller publishes `inbound_waiting { accountId, n, preferredSessionIds }` on the pacing
invalidation bus (plain JSON, so the IPC bus carries it; no Redis pub/sub for pacing events). Each
round subtracts `n` from the account's headroom and drops the preferred sessions from candidates.
The router reserves with the same Lua CAS pacing uses, so an inbound offer and a pacing reservation
cannot both win.

**As built (P2).** `n` counts the waiting callers the team may take, now or when a `loose` sticky
phase lapses: a `strict` caller whose sticky agent is not away (as the connector's last search saw
them) is that agent's alone, and a caller promised by a hand-over (§5.4) is its superseded dial's
agent's, so neither holds a team agent back (the sticky agent is held back as a preferred session).
A `loose` caller in its sticky phase is counted on purpose: the team takes them when the phase
lapses, and the agent held back is the one free to (IQ2's over-hold, bounded by `n`). The connector
republishes every 2 s while anyone waits and searches the account again each time: the backstop for
a change no event reports (a busy sticky agent going on a queued break or losing their station makes
their caller the team's at once, IQ6). Only a station that can take inbound calls is held back
(IQ46, `pacing/inbound-hold-back.ts`): the connector never names an older app build's station as a
preferred session, and pacing keeps such a station, preferred or not, without counting it toward
`n`, so it is dialled while an agent the caller can be put through to is held back in its place. A
station the engine does not know (the media workers' directory, IB8) is never held back.

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

**As built (P2).** Only for a caller who may be put through (the `queue` plan): at the answer,
once the connector holds the call, the router asks the dialer for a paced dial on the call's
account still ringing the caller's number (`findRingingAttemptTo`: digits compared as the busy
probe compares them; placed, never answered or bridged, not abandoned, not a wrap-up redial, whose
agent owes the conversation's outcome first). On a carrier that cannot cancel ringing (VoiceLink)
nothing is cancelled and the caller queues normally (IQ7). Otherwise, with no await between: the
connector promises the call to the dial's session (`expectHandover`; no other agent is offered it),
and the dialer marks the dial and cancels it (`supersedeForInbound` → `forceEndWithOutcome(…,
'canceled')`, whose first step marks the bridge session ending, so no answer is taken after it).
The dialer's `ended` arm settles it as the clash in one transaction (IQ8): the attempt `canceled`
with the reserved system code `inbound_call` (written up by nobody: `dispositioned_by_user_id`
NULL; the dial itself is the reserved agent's, so the rollups count it on their row as a placed
`canceled` dial and never as an outcome: docs/insights.md "System dispositions"), its contact back to `pending`
now, neither `attempt_count` nor the our-fault ledger charged and an agent's reopen marker
restored (`endSupersededByInbound`, `unclaimUncharged`); the station gets `released` with reason
`inbound_call` (nothing under late binding, where the agent never saw the dial); and the agent is
released through the inbound release hook, which takes them for the call: offered at once when the
call is queued; when it is still in its greeting or recording notice (the usual case: the cancel
lands within a few hundred ms), the agent is HELD for it there and then (CAS from `reserved`, the
`inbound` field set, the lease renewed, `agent_state: reserved`; never `available`, so pacing
cannot take them) and offered it the moment the preamble ends (IQ5: nobody is bound during the
greeting). The panel and the chime come with that offer; between the two the agent sees the
`released` copy ("The customer rang us"). A call that ends, a station that drops or a lease lost
while the agent is held lets the agent go. `clash_attempt_id` is stamped once the dial was
cancelled. A dial the carrier answered before the cancel (a conversation now) is kept and settles
as any call; the hand-over is dropped and the caller queues normally, as when the release never
reaches the hook (a queued break wins; the station gone), with a 15 s backstop. The soft phone's
manual dial to the same number is left alone (decided): a soft-phone session cannot take an
inbound reservation (§4.3, P3), so cancelling the agent's own dial would leave both with nothing;
the caller queues for the team and the manual dial meets a busy line. So is a paced dial whose
station could never take the hand-over: a phone whose station did not declare `caps=inbound`
(IQ20 as amended by IQ46; a phone that did takes the hand-over as a console does), a station not
OPEN, a session with no campaign. `expectHandover` applies the release hook's own test and refuses,
so nothing is cancelled and the caller queues normally. A cancel that fails outright (the bridge
throws) drops the hand-over at once rather than at the backstop. The hand-over's promises, timers
and steps are `inbound-handover.ts` (`InboundHandovers`), behind a small host interface onto the
connector's calls, chains, reservations and offers.

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

**Who the tile counts (P2 review fixes).** `eligible_agents` uses the search's own rules. With
callers waiting on the route, it counts the agents free now (`available`, holding nothing) who may
take at least one of them, each caller judged by ITS account. The cross-account case (IQ21): a
caller whose matched contact is in another account than the route's waits on this route's tile, but
only the matched account's agents may take them and the route's pool does not apply to them; such
a route reads 0 agents free while its own agents sit idle, and the tile's line says callers are
waiting with nobody free to take them, which is what the connector will do. With nobody waiting it
counts the agents who could take the route's next caller (one of the route's account).
`no_agents_available` is true when nobody in the route's pool could take its next caller now or
once their current work ends (§5.1's "could take"): on an open route the console says "Open, but no
one can take calls: callers go straight to Missed calls instead of waiting." It says nothing of the
route's hours, and is false on a deployment with no connector (nothing is put through there at all).

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
queue, also when a reconnect finds a call that was on offer no longer this station's). At phone width the panel's columns stack and the body scrolls. "Your customer is
waiting" (`customer_waiting`) is a pill in the station's action bar; it goes on the server's
`customer_waiting` with `cleared: true` for that caller, and as a backstop on an offer, a `ready`
(re-sent while they wait) and the agent leaving reserved / on a call / wrap-up. Supervisors: `InboundQueueTiles` (`GET /inbound/queue`, every 5 s,
visible-only, last numbers kept and marked stale on a failed read) on the agency home and the
Missed calls page; the floor reads "Inbound call" for `on_inbound_call`. Every call path is in
`api/inbound.ts`'s `INBOUND_PATHS`.

**The server (built, WP-C1; §2's state machine).** The router (`inbound-call-router.ts`) plans
`queue` for an open route's admitted caller (a slot, or over the account's own limit: IB5) when the
call's account has `agency_inbound_enabled` on and the server runs one process (IB8, IQ12, IQ13);
the stream is taken connectable (parked for `parkedSecondsFor(route)`: the maximum wait, a minute of
preamble and the exit's 150 s; the 8 s station grace; recorded from the bind when the route records
and the account allows it) and handed to the connector (`inbound-connector.ts`, `runtime.inbound`).
The connector plays the greeting and, for a recorded call, the notice (IB7) through
`playInboundHold`, and queues the caller only when the preamble has played (`onPreambleDone`, IQ5):
the spine `queued`, the per-route FIFO (`inbound-queue.ts`; a requeued caller at the head; over
`max_waiting` only an agent free now keeps them; the maximum wait and the loose sticky wait as
timers), "Your customer is waiting" to a busy sticky agent, `inbound_waiting` for pacing (§5.2),
and the search (`eligibility.ts`, §4.3: the call's account's console campaign sessions on this
process, open, in the route's pool when the account is the route's, `available` and holding
nothing; a caller whose sticky agent is free matched to them first; then FIFO, the sticky agent
alone in the sticky phase (loose: the wait; strict: the maximum wait; an agent away: the team at
once, IQ6), else longest idle by Redis `since`, `planTick`'s order). The agent is reserved by
compare-and-swap (`reserveForInbound` from `available`), the spine offered (guarded on the
session), and with no await between: `agent_state: reserved` then the `inbound_call` frame
(`connects_at` = the offer + 1.5 s, IQ4). At `connects_at` the station socket must be open (else the
offer is cancelled: back to the head of the queue, the next agent searched) and the bridge binds
it (a bind the bridge refuses: when the call is ending, `isCallEnding`, its end settles the offer;
for any other reason, a leg already bound or the socket closing between the two checks, the offer
is cancelled the same way, the caller never offered to that session again, and an agent whose
station is still OPEN returned to the pool); on `bridged` the spine is `connected`, the agent `on_call`, the lease renewed (a `connected`
write that fails, a database blip, leaves the call connected in memory and is retried at its end,
before `answered`: a pair who talked is never recorded as a caller who hung up on offer). When the call ends
the spine is `answered` with the outcome owed and the agent `wrapup` with the `inbound` field kept;
the wrap-up then follows the outbound wrap-up's auto-return rule (below, "The wrap-up"); a caller who hangs up on offer ends `abandoned_in_queue` with the Missed row
and callback and the agent goes back to the pool. Every step of one call runs on its serial chain.
**The release hook:** `releaseAgent`, with no queued break, asks the connector first; an agent
coming out of a call or a wrap-up is CASed from `reserved` / `on_call` / `wrapup` straight to a
waiting caller (theirs first), so a sticky agent is taken from wrap-up with no `available` instant,
however long the write-up took: the station heartbeat (the console's 10 s ping) renews a `wrapup`
lease (45 s, as `available`'s) while this process vouches for the wrap-up, a campaign wrap-up held
by `WrapupManager` or an inbound outcome owed (the lease's `inbound` claim; `heartbeatLeaseMs` in
`station-socket.ts`). Before, nothing renewed it: 15 s into a write-up the agent had no key, the
hook declined (`live: null`) and the agent went `available` first, and a `/break` asked for during
the write-up was applied at once and undone by the outcome save; it is now queued and applied by
the save. A `wrapup` key nothing vouches for (a previous process's) is not renewed and rehydrates as
`break`; a station that goes away is written `offline` by its close, whatever the lease. When the
hook declines, `releaseAgent` writes `available` without announcing it, mirrors it, sends the
frame, and only then announces it: the search the announcement starts can never land its offer
before a stale `available` frame or under an `available` row.
The station's close cancels an offer not yet bound; a bound call keeps presence for the bridge's
8 s grace (the close handler and the silent sweep); a reconnect re-adopts the leg and restates the
call and the waiting notices after `ready`; `/leave` refuses while a call is offered or connected;
a restart lands an agent owing an outcome on `break` with the call re-claimed (`rehydrateAgent`).
The finish routes (`proxy-agency-inbound/calls.ts` → `agency/inbound-calls.ts` →
`inbound-disposition.ts`, not behind the flag): the call, its notes, hang up, the outcome (the
catalog of IQ10, the soft phone's validation and decision, DNC for a suppress code, the contact
settled forward only by `inbound-settlement.ts`, never charged, then the agent returned) and Mark
DNC (the matched campaign's scope, else the account's), by the agent who took the call or a
supervisor on behalf; audited `agency_inbound_call.dispositioned` / `.hung_up` / `.dnc_marked`.
Hang up asks the connector, not the row, whether the call is live here (a row the stale sweep
ended while its call goes on still gets the call ended) and answers once the connector has written
the end (its per-call completion promise, `whenLeft`, bounded at 5 s). A hang-up of a call on
offer whose audio has not bound is the agent declining it: the offer is cancelled as a lost
station's (back at the head of the queue, `queued_at` kept), the caller is never offered to that
session again, the agent goes back to the pool, and nothing is recorded as abandoned (no Missed
row, no callback); with nobody else who could take them the caller is overflowed (§5.1). The
console offers Hang up only once connected, so this is the API's (and a supervisor's on behalf).
**The wrap-up** (`inbound-wrapup.ts`; IQ52, which replaced IQ32's campaign rule and its 120 s
unmatched default): the ROUTE's window, `agency_inbound_routes.wrapup_seconds` (30 s by default,
10–600, set in the route editor; `0032_inbound_route_wrapup.sql`), always with auto-return, on a
console or a phone. It is captured on the call row when the call arrives
(`agency_inbound_calls.wrapup_seconds`, NULL read as 30 s), so editing or deleting the route never
moves a countdown already on screen. The 30-minute lapse
(`AGENCY_INBOUND_OUTCOME_LAPSE_MS`) stays as the backstop: no outcome waits longer. The panel's
`outcome_due_at` and the lapse sweep's SQL (`lapseUnsettled`) read the one rule. The sweep runs
every 5 s (`INBOUND_LAPSE_SWEEP_INTERVAL_MS`) and closes each lapsed outcome `no_disposition`
(nobody recorded it), clears the session's `inbound` field and tells the panel; it returns the
agent (`releaseAgent`: a queued break, the release hook, else `available`) **only from the state
the call holds them in** (`returnsToPool`: `wrapup`, `reserved` or `on_call` with the field naming
this call). In the transaction that closes the call it settles the matched contact as an outcome
that moves nothing would (`settleFromInbound` with `none`, round 2, SWE-F2): the customer was
reached, so the inbound callback a missed call booked is cleared (the campaign must not ring them
back for it), and a contact that callback reopened from `exhausted` (`callback_reopened`,
`0029_inbound_reach_settles.sql`) goes back to `exhausted`, as it does when a saved outcome moves
nothing. An agent who chose a break since (a restart lands an agent owing an outcome on `break`
with the call re-claimed, and a break pressed there applies at once), or whom the station's close
wrote `offline`, stays where they are, and their own "Go available" brings them back; the outcome
saved from such a break does the same. The connector's `session_busy` give-back (the spine says a
session it reserved holds another unsettled call: its Redis field was lost) puts the agent on
`break`, re-claimed for the owed call, never back in the pool, also when the spine cannot be read.
**A supervisor's force-available** on an agent who owes an inbound outcome closes it as the lapse
would (`closeOwedForSupervisor`: `no_disposition`, the contact settled, the claim cleared, the panel told) and returns the
agent as from any wrap-up; the public layer audits `agency_inbound_call.closed` ("Inbound call
closed by a supervisor", the supervisor the actor, `details.via: force_available`). A call still
offered or connected is not forced: `409 inbound_call_live` ("The agent is on an inbound call: they
can be made available once it has ended."). By design (IQ9, IQ19) the busy probe's inbound arm holds
the number while its outcome is owed, so an agent who leaves without saving keeps the customer
undialable for the whole account until the call's window lapses (the campaign's wrap-up window,
at most 30 minutes); an agent who saves frees it with the save. At a graceful shutdown the
inbound stop (`startInboundCalls`), first in the agency stop and before the runtime stops, takes no
more work, ends every call it holds `service_shutdown` and waits up to 10 s for their settles: a
caller nobody took `failed` with its follow-up and callback (IQ18), an answered call owing its
outcome. A crash leaves them to the next start's sweep (`failed`: we dropped them, not a caller who
hung up; still followed up), and an answered call owing its outcome stays owed.
`GET /inbound/queue` (`agency.supervise`, the flag) answers a tile per route from the connector's
queue (who it counts: above). Membership is read at every search with the agents' Redis states
(an active user, an active membership in the tenant or the call's account), so an agent removed
from the account or deactivated while a caller waits, station still open, is never offered them.
The two inbound frames (`AGENCY_STATION_INBOUND_EVENTS`: `inbound_call`, `customer_waiting`) are
sent only to a station that can take inbound calls (every console, and a phone that declared
`caps=inbound`, IQ46): `StationRegistry.send` drops them for any other station, whoever asks; the
eligibility rules that keep such a station out of the pool stay, as they decide who is
offered a call. Metrics: `agency_inbound_queue_waiting{route_id}` (a route nobody waits on reports
0 once and its series then goes), `agency_inbound_wait_seconds{result}`,
`agency_inbound_offers_total{result,client}` (`declined`: the agent hung up the offer; `bind_refused`; `client`: `web` or `mobile`, the station the offer went to — an older build without `caps=inbound` is never offered one, so it shows up in neither),
`agency_inbound_overflows_total{reason}` (`max_wait`, `over_cap`, `no_agents`). A caller who reaches nobody leaves through the router's
`overflow`, which carries out the route's overflow action and answers how the call ends (an
`InboundCallEnd`: the outcome and, for a voicemail, its recording, threaded to the spine's `end`):
the call-back message (busy for a withheld or DNC caller), the route's recording or our standard
one (§3.4), then the call is put down; or a voicemail (§7). Nobody waiting is ever put down
without a word. The moment a caller's exit is decided (the maximum wait, a cancelled offer past
it, over `max_waiting` with nobody free) they are marked leaving, synchronously, and no search or release hook reserves an agent for
them, so no account lock ever waits behind their message or voicemail. An offer cancelled past the
maximum wait (the agent declines, the bridge refuses the bind) returns its agent and answers
first; the exit runs on the call's chain after (round 2, SWE-F3). The in-flight clash's
hand-over is §5.4.

**Mobile stations (IQ46, IQ47; P3, built).** The station upgrade takes `caps=` (contracts
`AGENCY_STATION_CAPABILITIES`, today `inbound`): comma-separated, a repeated parameter the union,
an unknown value ignored and never refused (a 1008 is terminal for the app). A console station can
always take inbound calls; a `client=mobile` station only when it declared `caps=inbound` (the app
connects with `client=mobile&media=alaw8&caps=inbound`). The capability belongs to the socket, not
the session row: `StationRegistry` keeps `canTakeInbound` on the station, set at every attach, and
every inbound rule reads it (eligibility's `no_inbound_capability`, the release hook and the
hand-over's `releasableStation`, the could-take count and the queue tile, the send filter, the
reconnect's restore). A capable phone's audio binds as any station's does, in the format its socket
chose (`media=alaw8`: A-law binary frames, `core/bridge/browser-leg-media.ts`). The phone's own
paths:
- **Lost before the bind** (dropped, or silent past its 10–15 s grace: the silent-station sweep's
  idle arm terminates it, since an unbound offer is not a call): the close cancels the offer as any
  lost station's, the caller back at the head of the queue, the agent `offline` (§5.1).
- **Lost after the bind:** the campaign call's rule (M1, IQ17). The sweep terminates a phone silent
  past its grace on a live inbound call at once (it no longer waits on TCP), and the bridge's 8 s
  deferred hangup decides: back in time with `caps=inbound`, the leg is re-adopted and the call
  restored after `ready`; else the call ends `answered` with its outcome owed and the agent
  `offline`, back on `break` with the call to write up at the next attach.
- **Reattached by a station that cannot take inbound calls** (an older build on another device
  taking the session over, 4409 to the first): what the session held is handled as a lost
  station's (`InboundConnector.onStationCannotTakeInbound`, and the bind re-checks the capability):
  an offer not yet bound is cancelled (`station_lost`: back at the head of the queue, the next agent
  searched) and the agent, whose station is still open, returned to the pool (`releaseAgent`); a
  hand-over held through the preamble is let go; a bound call is never re-adopted onto that socket
  (no audio, no frame), so the prior socket's close ends it after the 8 s deferred hangup as
  `answered`, its outcome owed, and the agent owes it in `wrapup` on that station (the wrap-up's
  lapse or a supervisor's close returns them; the older build cannot show the outcome pad).
- **The device-away break** (`POST /sessions/:id/break {reason: 'device_away'}`, `decideDeviceAway`):
  unchanged, and it already holds for inbound: an agent `reserved` for an inbound offer, on an
  inbound call or in an inbound wrap-up has it queued behind the call (the offer still binds and
  connects; the caller is never stranded), and it applies at the release (`releaseAgent` applies a
  queued break before it asks the release hook, so no fresh inbound caller is taken for a
  backgrounded phone). An `available` phone's applies at once by a CAS from `available`, so it and
  an inbound reservation (`reserveForInbound`, also a CAS from `available`) cannot both win: the
  loser is re-decided (device-away then queues behind the offer). A hand-over held through a
  caller's preamble is a reservation too: a device-away queued during it waits behind that call.
- **The phone-call break** (IQ51; `POST /sessions/:id/break {reason: 'phone_call'}`, reserved
  beside `device_away` and `soft_phone`, `APP_PAUSE_BREAK_REASONS`): the app asks for it when a
  cellular call starts while the agent is available, and lifts it with `/available` when the call
  ends. The server runs the device-away rules with its own code: applied at once from `available`,
  queued behind a reservation, call or wrap-up, never replacing a break already chosen or queued, a
  `200` with the current state where it changes nothing, withdrawn by `break/cancel`. No campaign
  catalog may list it, and for inbound it is an ordinary break (never could-take, unlike a fresh
  `device_away`, §5.1).
- **An older build's `ready`.** When such a build takes over a session holding an inbound offer or
  a hand-over held through the preamble, the offer is let go right after the attach and before the
  rehydrate (`InboundConnector.onStationCannotTakeInbound`, bounded at 3 s). It first waits for
  every return of the session to the pool the connector has in flight (a reservation the search
  or the release hook holds, through its offer or give-back; a give-back; the bind's cancel of an
  offer to this station, whose timer may fire during the attach), then lets go of what is still
  held and waits again. So its `ready` reports the agent back in the pool, not `reserved` for a
  call it cannot show, unless the 3 s bound is hit (then `ready` says what Redis says and the
  return's own `agent_state` frame follows). An offer refused because the station cannot take
  inbound calls is `station_incapable`, never `session_busy`: the agent is returned with no read
  of the call records, so a failed read can never put them on a break.
- **Older builds on the floor (IQ56).** `GET /campaigns/:id/stats` `agents[].can_take_inbound`
  (`StationRegistry.inboundCapabilityBySession`, process-local): `false` for a phone station that
  did not declare `caps=inbound`, which the supervisor floor marks "Update app" ("App can't take
  inbound calls — update the app" as its tooltip and what a screen reader hears) on an account with
  `agency_inbound_enabled` on; `null` when this process holds no live station for the session (with media
  workers, a station a worker holds; such a deployment puts no caller through anyway). When the
  pilot starts, `MOBILE_MIN_SUPPORTED_VERSION` is raised to the first release that declares it, so
  every older build blocks on "Update required" (a deployment setting, not code).
- **The app's side (IQ47, built 2026-11-10;** [`mobile.md`](mobile.md) "Inbound calls", "Missed
  calls"). The app connects with `client=mobile&media=alaw8&caps=inbound` on every upgrade and
  follows the console's flow on its station: the offer with the chime once per offer, the call, the
  outcome pad once the call ends (the mobile campaign convention), "Your customer is waiting", the
  reconnect check against `GET /inbound/calls/:id` (an offer is retired at once by a `ready` that
  says the agent is not reserved, and by a backstop 10 s past `connects_at`), and a neutral "A
  call is coming through · Connecting…" screen for the `reserved` the server sends before the
  offer lands. A paused campaign's station says "no campaign calls for now" and that customers who
  ring in can still reach the agent: the search never reads the campaign's status (§4.3), so an
  available agent on a paused campaign is still offered callers (the console says the same). iOS reports the call to
  CallKit as an outgoing call, as it does a campaign call. Missed calls is a segment of My calls
  (the agent's own rows, `assignee=me`) with Call back into the soft phone. Only with the app on
  screen: a phone in the background is paused (`device_away`) and offered nothing, unless the
  agent opted in to having it rung (Mode B, `away_ring`, §6.1).

### 6.1 Ringing an away phone (Mode B)

Built 2026-11-12 on the server and Android (decisions IQ58–IQ74 and the plan review's N1–N5, all
**default, pending Manas**, [`decisions.md`](decisions.md) §4, "Mode B"). An agent on duty in a
campaign session who leaves the app having opted in is not just paused: their phone is rung by a
data push for an inbound caller, and answering it puts the caller through to the app's station as
any mobile offer is. Opt-in per account (flag `agency_inbound_ring_enabled`, with
`agency_inbound_enabled`) and per device. iOS is a design only (IQ64; [`mobile.md`](mobile.md)
"iOS: the design (Mode B)"). Nothing of it has run on a phone, against FCM or APNs, or with a real Plivo
caller (§12). The app's side is [`mobile.md`](mobile.md) "Ringing while away (Mode B)"; the push
carriers are the platform area's, behind `seams/push-sender.ts` ([`seams.md`](seams.md) §3.6).

**The away break (`away_ring`, IQ58, IQ65–IQ67; `agency/away-ring.ts`, `runtime.awayRing`).**

- **The device.** One `agency_push_devices` row per agent and device (§9.4); the device that may
  be rung for a session is the one holding its station (`station_device_id`, OS3, IQ60). The app
  registers it at every open (`PUT /proxy/agency/push-devices/:deviceId` with its FCM token; a
  revoked row is revived), opts in or out (`PATCH {ring_enabled}`), reads its status (`GET`:
  the device, `account_allows_ring`, `push_configured`), removes it at sign-out (`DELETE`, 204) and
  sends a test ring (`POST …/test-ring`, 202, a `test_ring` push; one per 10 s per agent and
  device). Firebase session and `agency.station.connect`; own devices only, the actor always the
  signed-in user; tokens never served back or logged. Audited `agency_push_device.ring_opt_in_changed`
  and `agency_push_device.revoked`.
- **Entering.** The app asks `POST /sessions/:id/break {reason: 'away_ring'}` on leaving the app
  instead of `device_away`. Checked before anything is read from Redis or written
  (`AwayRingService.refusalFor`), refused 409 in this order: `ring_not_allowed` (not a campaign
  session, a flag off, or this absence already past its maximum age), `no_push_device` (no row for
  the station's device, revoked, or no token for its platform), `ring_disabled` (not opted in),
  `push_unavailable` (the sender has no credentials for the platform); the app then asks
  `device_away`. Otherwise the device-away rules apply (§6 "Mobile stations"): from `available` at
  once by CAS (`enterAwayRing`), queued behind a reservation, a call or a wrap-up (a queued
  `device_away` and a queued `away_ring` replace each other: the latest says what the phone can do
  now), and `device_away ↔ away_ring` is a break-to-break switch on `break`, never from another
  break, so a named break or the soft phone's never gains it. A queued `away_ring` is applied by
  the release with or without a socket (`AgencyDialer.releaseAgent` through
  `AwayRingService.applyQueued`, re-checked first; `device_away` when it can no longer apply; a
  release that leaves a campaign outcome owed always applies `device_away`, IQ72). It applies from
  `offline` too (the app parks its socket once it has asked to go away, so a station closed during
  the wrap-up was written `offline`), and over no key at all (that `offline` lease lapsed during a
  long wrap-up: the key is created only if still absent, by the reconcile's create-if-absent
  script).
- **Its state.** Redis: `state = break` and `ring = 1` on the agent hash, a fresh `since`, and a
  TTL of the time left to `AGENCY_AWAY_RING_MAX_MS` (4 h) from `away_ring_since`. Nothing renews it:
  `heartbeatLeaseMs` answers null while `ring = 1` (N2), and the renew script (`RENEW_SCRIPT`)
  itself refuses a key with `ring = 1`, so a heartbeat that read `break` (`device_away`) just before
  a switch to `away_ring` cannot cut the 4 h TTL to the break lease's 45 s. It is the one lease that
  is not a liveness detector (IQ67). Every other write of `state` clears `ring`. The mirror:
  `break/away_ring`, with `away_ring_since` stamped once per absence (§9.4). The app then parks its
  station socket and stops its microphone service: the station close keeps the session
  (`setOfflineUnlessAway`, one Lua script that is still `releaseStationOnClose`'s first await: it
  writes `offline` unless `ring = 1`, or `inbound` is held with the `push` field or the connector's
  synchronous `holdsPushOffer`), and so does `releaseAgent`'s path for a station not owned here.
- **The supervisor.** The floor shows "Away · rings for inbound". Force-available is refused
  `409 agent_away_ring` ("They're away from the app; their phone rings for inbound calls."): there
  is no station to put them in the pool on. Force-break and sign-off work as for any break.

**Who is rung (IQ60, IQ63, IQ68, IQ69; `eligibility.ts`).** Every search reads the account's
ringable sessions first: both flags on, then one statement (`findRingableInAccount`: live campaign
sessions with `away_ring_since` set and fewer than `AGENCY_INBOUND_RING_MAX_MISSES` missed rings,
joined on (agent, station device) to a push device that is not revoked, opted in and has a token; on
0037's partial index `idx_agency_agent_sessions_away_ring`), then the sender configured for the platform; a failed read rings
nobody that search. Such an agent is ringable for a caller (`ringIneligibility`) when every
station rule holds but the station and the state: the call's account, a campaign in the pool, an
active member who sees the account, Redis `break` with `ring = 1` holding nothing, and not a session
this caller already declined or missed. `candidatesFor` tags each candidate `station` or `push`, in
this order (while ringing is paused after a push failure, every `push` candidate is skipped):

1. the sticky agent on screen and available;
2. the sticky agent's phone, rung for one window (under `strict` too: a ringable sticky agent is
   away, so the team takes over after the ring; IQ63 amends IQ6);
3. team members on screen, longest idle first;
4. team members' phones, longest idle first by the break's `since` (rewritten on every return to
   `away_ring`), only when nobody is on screen to try.

No phone at all when the caller has less than one ring window of their maximum wait left (IQ69;
checked again when the ring starts), so a ring in flight overruns the maximum wait by at most the
15 s grace. One phone per caller at a time: having rung one, the search moves to the next caller.

**The ring (IQ66, IQ61; `InboundConnector.ringOffer`).** On the call's serial chain:

1. the search's CAS `break (ring = 1) → reserved` (`reserveForInbound`'s `break` arm, which refuses
   any other break) writes `inbound` and `push = 1` in the same script;
2. the device and IQ69 are checked again; the spine is `offered` with `offer_channel = push`,
   `ringing_at`, `ring_count + 1` (the previous ring's `accepted_at` and `ring_result` cleared);
3. with no await between: phase `offered`, `held.channel = 'push'`, a fresh offer token (128 random
   bits, held only in memory: never logged, audited or persisted), the `reserved` lease renewed by
   the connector (there is no socket), the ring timer (`AGENCY_INBOUND_RING_MS`, 20 s);
4. the mirror `reserved`, then the `ring` push outside the account's lock: `type`, `call_id`,
   `offer_token`, `ring_expires_at`, `session_id` and nothing else (IQ61), held at the carrier for
   the ring window.

No `inbound_call` frame (there is no socket) and no 1.5 s bind timer. On the wire the call's
`offer_channel` is `push`, `connects_at` null, `ring_expires_at` the deadline until it is answered.
A send that fails ends the ring `push_failed`, which is **never a miss** (IQ62 counts only the
agent's own: a failed push is the carrier's): the caller goes back to the head of the queue and no
`ring_cancel` is sent. An `unregistered` token revokes the device and ends the absence `revoked`
(that caller never rings the agent again; nobody does, the device is gone). Any other failure (the
push service unavailable, rate-limited, refusing the message, or unconfigured) leaves the agent on
`away_ring` and ringable for this caller too, runs no new search, and pauses all ringing in this
connector for `INBOUND_PUSH_RETRY_MS` (10 s): searches meanwhile skip every `push` candidate (a
station agent is still offered), and the republish after the pause retries. An outage of the push
service therefore never walks one caller through the whole pool in milliseconds, nor costs anyone
a miss.

**Answering, accepting and binding (IQ71, N5; `api/routes/agency/inbound-ring.ts`).** The routes are
`/proxy/agency/inbound/calls/:id/ring/{answering,decline,accept}` (`proxy-agency-inbound-ring.routes.ts`).

- **`answering {offer_token}`** (token only; native Android posts it at the tap): on the call's
  chain, the ring re-checked there (N3), the ring timer stops, `accepted_at` is stamped, the accept
  grace starts (`AGENCY_INBOUND_ACCEPT_GRACE_MS`, 15 s) and IQ73 can no longer take the caller.
  Answers `{call_id, accept_by}`; idempotent while the grace runs.
- **`accept {offer_token, device_id}`** (the agent's Firebase Bearer, `agency.station.connect`;
  Dart posts it): the ring must be the Bearer's agent's, and `device_id` must be the device holding
  the session's station (`claimStationOrReply` without a take-over, else `station_on_other_device`).
  It does `answering` if that has not happened, marks the ring accepted, mints a station token and
  answers `{call, session_id, campaign_id, station_ws_url, station_token_expires_at}`. Idempotent
  for the same agent and device until the call binds; `already_accepted` for another device or once
  bound; `ring_expired` for this call's last ring that ended unanswered; anything else the uniform
  `404 ring_not_offered`. If an OPEN station that can take inbound calls is already attached, it is
  sent the `inbound_call` frame and the call binds now.
- **The attach** (`reattachStation`): for a push offer, the `inbound_call` frame (`connects_at` null,
  `accepted_at` set) after `ready`, then the bind once accepted (`bindAcceptedRing`). The state
  stays `reserved` throughout (no `ring` cleared, no reason rewritten, no `ring_off`). An attach with
  `caps=inbound` during a ring not yet answered (the agent opened the app by its icon) is an
  implicit answer and accept: it binds at once and the phone is sent `ring_cancel`. An attach by a
  build without `caps=inbound` ends the ring `cancelled` and returns the agent as Mode A does.
- **A socket close inside the grace** does not cancel an accepted ring: it waits for a re-attach
  until the grace ends (`accept_lapsed`). `holdsPushOffer` is true from the ring until the bind.
- **The bind:** `ring_result = answered`, the missed rings reset and the absence over
  (`ringAnswered`: `ring_misses = 0` and `away_ring_since` cleared, so a later absence, such as a
  queued `away_ring` applied after this call's wrap-up, starts its own maximum age rather than
  inheriting this one's start), `agency_inbound_rings_total` `answered`; from here it is any inbound call on a phone (`connected`, `on_call`, the outcome and
  the route's wrap-up). After the outcome the agent is released as today (IQ72); the app asks for
  `away_ring` again if it is hidden.

**Declining (IQ70, N4).** `decline {offer_token, reason}` (token only; `reason` `declined` or
`busy_on_phone`) is valid until `accept`: the ring ends with that result, never a miss; the caller
goes back to the head of the queue and is never rung by that agent again; the agent goes back to
`away_ring`. Audited `agency_inbound_call.ring_declined` with the agent the ring was for as the
actor (the token was theirs), ids only. After `accept` it is `already_accepted`, and the agent's
hang-up on the station is the way out: an offer not yet bound is declined (`declined`, not a miss).
Android declines `busy_on_phone` by itself when a cellular call is on (IQ70); the server never rings
a `phone_call` break.

**Every other end of a ring (`endRing`).** `expired` (the ring timer), `accept_lapsed` (accepted or
answered, not bound within the grace), `push_failed`, `caller_left`, the lease lost,
`answered_elsewhere` (IQ73, or the take-over below) and `cancelled` (the away break ended, an older
build attached, a bind refused). Each writes `ring_result`, sends Android `ring_cancel` with the
result (fire and forget; not after `push_failed`), returns the agent to `away_ring`
(`AwayRingService.releaseInbound`: Redis `releaseInboundToAwayRing`, only while this call holds the
session, then the mirror `restoreAwayRing`), and puts the caller back at the head of the queue,
searched again (or leaving at the maximum wait). With an OPEN station attached here (an accepted
ring whose station came), Mode A's `releaseAgent` runs instead. A ring that ends past the absence's
maximum age returns the agent and then ends the absence `max_age`. A session the spine says holds
another unsettled call is never rung again: its absence ends. A requeue whose write throws still
releases the agent and requeues the caller in memory (never a push offer left with no timer); the
spine then reads `offered` to that session, so later offers of the caller are refused there and the
caller leaves at their maximum wait, whose settle ends the row. **Misses (IQ62):** only `expired`
and `accept_lapsed` add one to `ring_misses` (never `push_failed`, never a decline); the second in a
row ends `away_ring` (`ring_missed`). An agent at `ring_misses >= AGENCY_INBOUND_RING_MAX_MISSES` is
not ringable (`findRingableInAccount` filters them), and every ring's end that returns the agent to
`away_ring` asks the count again, not only a miss: a ring another caller's search started between a
miss's release and its end (`ring_in_flight`) would otherwise leave the owed `ring_missed` end
unsent, so that ring's end sends it. After `declined`, `busy_on_phone`, `expired` or
`accept_lapsed`, or a `push_failed` for an unregistered token, that caller never rings that agent
again; after any other `push_failed` they may.

**On screen first, mid-ring (IQ73, N3).** When a station agent becomes available (the
`onAgentAvailable` search, or the release hook `takeOnRelease`) after a caller's ring began and
before it reached `answering`, the caller is theirs: the station agent is reserved under the
account's lock first, then in one step of the call's chain the ring ends `answered_elsewhere` (no
miss) with no new search and the station agent is offered the caller, or, if `answering` landed
first, the station agent is given back. A search never takes over a ring it started itself. The
ring's start is read once per caller in a search, but whether the ring may still be taken over is
asked again for each candidate: an earlier candidate's take-over may have ended the ring and then
been refused, or the ring may have ended during an await. Once the ring is gone the caller is
searched for, and offered (`takeOverRing` falls back to `offer`), as any queued caller; nothing
throws.

**Could take (IQ68).** For IQ29's at-once overflow (`couldTakeLater`), a ringable agent counts as
one who could take the caller, as does one ringing now for another caller (that ring ends, and they
are ringable again), except an agent this caller declined or missed.

**Ending `away_ring` (IQ67).** Always `device_away`, then `offline` when no station socket is here
(`AwayRingService.end`: Redis first, by a script that acts only on `break, ring = 1`, then the mirror
with `away_ring_since` cleared; the mirror's write matches a row with `away_ring_since` set or still
reading `break/away_ring`, so a reconcile that cleared the key between the two writes cannot strand
the row on `away_ring` with no `ring_off` and no audit). The server's ends send Android a `ring_off` push with the reason
(held an hour at the carrier) and are audited `agency_session.away_ring_ended` ("Phone stopped
ringing for inbound calls", `details.reason`, the system as the actor; "Stop ringing" and a removal
are also audited on the device, with the agent as the actor):

| Reason | When |
|---|---|
| `ring_missed` | the second missed ring in a row |
| `revoked` | the device removed (`DELETE`), or its token reported unregistered by FCM or APNs |
| `opted_out` | "Stop ringing" (`PATCH ring_enabled=false`) |
| `flag_off` | the reconcile finds a flag off for the account |
| `max_age` | the absence past `AGENCY_AWAY_RING_MAX_MS` |
| `taken_over` | another device took the station (OS3): the claim clears `away_ring_since` and rewrites `break/away_ring` to `device_away` in the same statement, Redis's `ring` is cleared, and the old device is told. Also sent, with no audit, when the session itself ends under a parked phone: `POST /sessions/:id/leave` from another device (a ring in flight refuses the leave first), and OS7's `endIdleSessionElsewhere` ending the session in another tenant (Redis `ring = 1`, or the row's `away_ring_since` set when the key has lapsed). OS7 still counts `away_ring` as idle: the agent is at a station in this tenant now, and keeping the absence would lock them out for up to `AGENCY_AWAY_RING_MAX_MS`; a ring in flight holds the session (`reserved`, `findCallForSession`). Without the push the phone's "rings this phone" notification would outlive the session |

Two ends send nothing and are not audited: the agent's return (a station attach or a join over
`break, ring = 1`: `device_away` on screen, and the app's `/available` follows) and the app asking
`device_away` while on `away_ring` (the switch). A ring in flight is never ended by a state write
(N1): the end goes through the connector's `cancelRingForAwayRingEnd` on the call's chain, which
cancels a ring not yet answered (`cancelled`; `answered_elsewhere` for a take-over) and then ends the
absence; an answered ring runs to its end and the next reconcile ends the absence, except on a
take-over, which cancels it too (the device that answered no longer holds the station).

**Restart and the reconcile (IQ67, N1).** Offers die with the process as today (the startup sweep
fails their calls). `AwayRingService.reconcile` runs at boot, after the startup reaper and the
inbound sweep, then every 60 s (`bootstrap/agency.ts`), over every live session with
`away_ring_since` set (never keyed on `break_reason`, which a ring's `reserved` nulls): a ring in
flight is skipped (unless its absence must end, then cancelled through the connector); an absence
past its age, with a flag off (a flag read that fails ends nobody), or whose device is gone, revoked,
tokenless or opted out is ended with its reason; a live absence whose Redis key is gone (a restart
that outlived it, a crash mid-ring whose `reserved` lease lapsed) is re-seeded with a create-if-absent
script and its mirror restored; a mirror the startup reaper wrote `offline` is restored; Redis off
`away_ring` with nothing in flight only clears the mirror's key. Passes never overlap.

**Metrics and the alert.** `agency_inbound_rings_total{result}` (every `AGENCY_INBOUND_RING_RESULTS`
value), `agency_inbound_ring_answer_seconds` (the ring's start to `answering`),
`agency_inbound_offers_total{result,client,channel}` (`channel` `station` or `push`; a ring's
offer ends `connected`, `declined` (`busy_on_phone` too), `unanswered` (`expired`, `accept_lapsed`,
`push_failed`), `caller_left`, `answered_elsewhere` or `cancelled`), and the platform's `agency_push_sends_total{platform,result}` and
`agency_push_send_seconds{platform}`. The alert `agy-inbound-ring-push-failed` fires when more than
a fifth of the rings in 15 minutes (at least 5) ended `push_failed` ([`operations.md`](operations.md),
the inbound runbooks); the dashboard has a row "Mode B: ringing away phones" (rings by result, ring
to answer p50/p90, push sends by result).

**Tests.** Unit: `inbound-eligibility.test.ts` (ringable, the order, IQ68, IQ69),
`device-away-break.test.ts` (the switch, the refusals), `agent-state-machine.test.ts` and
`station-heartbeat-lease.test.ts` (N2), the push senders and config (`notifications/push/*`,
`push-config.test.ts`). Integration (rest lane): `agency/away-ring-state.test.ts` (the Lua scripts on
real Redis, the mirror, the take-over, the close and its race with a ring, the reconcile),
`agency/inbound-ring.test.ts` (ring → answering → accept → attach → bind and every end, misses, the
order, IQ73 both ways and a take-over whose ring ended mid-search, a failed push that is no miss, a
push outage that pauses ringing instead of walking the pool, a requeue that throws, an agent at the
maximum misses, a crash mid-ring and a reconcile tick during a ring), `away-ring-state.test.ts` also
pins the renew that never touches `away_ring`, an end the reconcile half-saw, and a queued
`away_ring` applied from `offline` and over no key; `end-idle-session-elsewhere.test.ts` (unit) the
OS7 `ring_off`,
`api/away-ring-routes.test.ts` and `api/inbound-ring-routes.test.ts` (the routes, refusals, the
uniform 404, the rate limits, the audits, the leave that tells a parked phone), `packages/db`
`inbound-ring-migration.test.ts` and `away-ring-sessions-index-migration.test.ts` (0037).
Wall-clock lane: `telephony/inbound-ring-e2e.test.ts` (mock Plivo, the mock push carrier and a real
station socket: answered with audio both ways, declined, expired on the real 20 s window).

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

**A Missed row closes on its own when the customer is reached** (built, `0028_inbound_missed_follow_up.sql`,
`0030_inbound_reached_on_outcome.sql`). Once an agent of the same account has spoken to the
customer after the call, every open Missed row of that account from that number that rang before
the conversation began is `handled` with `handled_reason = 'reached'`, handled by the agent who
took the conversation, so nobody calls the customer a second time for nothing. "Spoken to" is:

- **a later inbound call of theirs put through to an agent** (`bridged_at` first set): the customer
  rang us, which an answering machine does not do;
- **an outbound call to their number (a campaign attempt or a soft-phone call) whose outcome says a
  person was reached**: the connect rate's human connect (`HUMAN_CONNECT_ATTEMPT_SQL`), a
  conversation (`CONVERSATION_ATTEMPT_SQL` for an attempt, so a wrap-up redial that rang out still
  counts; bridged for a soft-phone call) written up with any code but `voicemail` (a machine
  answered), `no_disposition` (the outcome lapsed: nobody said who answered) and `redialed` (the
  redial carries the outcome). Not the bridge (0028 closed the row there): with no answering-machine
  detection the agent is put through to whatever answers, and only the outcome says it was the
  customer's voicemail. While the call is live the row stays open, but nobody can ring the number
  twice: the soft phone's pre-dial busy probe refuses a number with a live call in the account. An
  outcome changed later to a person-reached code closes the rows; one changed to a no-contact code
  reopens nothing (Reopen, below, does).

The number is matched on its digits (`CONTACT_PHONE_DIGITS_SQL`), so a roster number stored as it
was ingested matches the caller's E.164. Row triggers do it on the transaction that records the
conversation or the outcome, so the close commits with it; `follow_up_status = 'open'` in the
UPDATE makes two closes at once, or one beside a person's Mark handled, close a row once (the
second waits on the row lock and finds it handled). A withheld caller's rows, the tenant default's
(no account) and another account's are never closed. Mark handled records `handled_reason = 'marked'` (a row handled before 0028 has none and
reads as marked). The matched contact is not touched: its booked inbound callback
(`callback_source = 'inbound'`) is settled by the conversation that reaches the contact, with the
outcome the agent chose. Call back from a Missed row opens the soft phone logging to the matched
campaign, so its call claims a `pending` contact (SP6) and its outcome settles it, the callback
cleared with it (`settleFromManual`; a campaign attempt's `chargeAttempt` and an answered inbound
call's `settleFromInbound` do the same). A call logged to another campaign, or untagged, closes the
row but leaves the contact to its campaign. Clearing the callback on its own would leave the
contact `pending` (the state it was reopened from is not recorded), so the campaign would dial it
anyway.

**Reopen** (built, fix pass round 2, IQ41): a handled row goes back on the list (`open`, its reason, handler and
time cleared, the assignee kept), for a row marked by mistake or closed as reached when the
customer was not. Mark handled's rules: an agent reopens the rows assigned to them, a supervisor
any of the account's; idempotent; audited `agency_inbound_call.reopened` with how and by whom the
row had been handled; not behind the flag. A reopened row closes again on the customer's next
conversation. A reopen at the same instant as a reached close leaves the row open in either order
(the close matches the rows open when it started and passes over one still handled; a reopen
after a close reopens it): the person's reopen stands.

**Supervisors reassign** (built): a row's assignee is the sticky agent, else the account; a
supervisor (`agency.supervise`) gives an open row to an active member who can work the account's
rows (an active user with an active membership at tenant level or in the account, the answer
webhook's assignee rule), or to the account, audited `agency_inbound_call.reassigned` (`from`, `to`).
A handled row is not reassigned. A row whose assignee has since left the account (removed or
deactivated) reads **Former member**, with the prompt to reassign it. Agents still see and mark only
their own rows. The nav entry carries the open count of the caller's scope as a badge.

**The Team view and claim (IQ49).** An agent may also read the account's unassigned rows
(`assignee=unassigned`: an unmatched or withheld caller nobody answered) and claim one:
`POST /inbound/missed/:id/claim` assigns it to them only while it is unassigned (a compare-and-set),
answers the row (200 also when it is already theirs), refuses `inbound_missed_call_claimed` (409)
when someone else has it and `inbound_missed_call_handled` (409) for a handled row, and is audited
`agency_inbound_call.claimed` (`from: null`, `to`) when it changed. An agent may play the voicemail
of an open unassigned row, to decide. Every row carries `match_name` (IQ54): the matched contact's
name (the first of `name`, `full_name`, `customer_name`, `first_name` in its roster columns, trimmed,
at most 100 characters; `match-name.ts`), null when the caller was not matched, withheld their
number or the contact has no name.

Voicemail (optional per route, IB3) is recorded from our own stream (we hold the μ-law frames), not
by moving the call to `<Record>` XML, unless the P0 check proves the transfer clean: the bridge's
`recordInboundAudio` plays the prompt and a beep, then records the caller through a carrier tap
installed only for the recording (docs/seams.md §3.1). It is attached
to the Missed row and analysed if the route has a summary profile. There is no in-app notification
channel; the station frame is the in-app alert, e-mail is not used for missed calls.

**Voicemail as built (P2; `agency/inbound/inbound-voicemail.ts`, the router).** A route's
`after_hours_action` (a caller out of hours) or `overflow_action` (an open route's caller nobody
takes: nobody can be connected, or the queue's exit: the maximum wait, over `max_waiting`) may be
`voicemail`. The case's message is the prompt (closed after hours; the call-back message from the
queue; our neutral prompt for a withheld or DNC caller), with the greeting before it for a call not yet held, then
the built-in beep, then up to `AGENCY_INBOUND_VOICEMAIL_MAX_SECONDS` (120 s) recorded from our
stream (`recordInboundAudio`); a recording that runs to the maximum ends the call
(`inbound_voicemail`). The whole of it fits whatever the account's max call duration: a caller who
was never held is budgeted the longer of that and `INBOUND_VOICEMAIL_BUDGET_SECONDS` (the prompt and
the recording; `acceptInboundCall` takes `parkedSeconds` as a floor for a call that is not
connectable), and a queued caller's parked budget already includes the exit. It is kept only when
the caller spoke (at least a second, with one 20 ms stretch above a quiet floor: a floor, not voice
detection, so a cough or a door counts), stored as a WAV (PCM16, 16 kHz, mono) in the app's bucket at
`inbound-voicemail/<tenant>/<account>/<call>.wav`, and the call ends `voicemail` with
`voicemail_key`, `voicemail_seconds`, the Missed reason of the case (`closed` / `overflow`) and the
callback as for any Missed row. A caller who leaves before speaking (during the prompt, at the
beep) leaves none: the case's own outcome and reason. The prompt (`voicemailPrompt`) is the route's
recording for the case's message, else our standard voicemail prompt ("Please leave your name and a
short message after the tone, and we'll call you back."), so a route with no recordings takes
voicemail too, after hours and from the queue. A caller who may not be promised a callback
(withheld, DNC) always hears our neutral prompt ("Please leave your name, your number and a short
message after the tone."), whatever the route's recordings, so they can always leave one (round 2;
before it they left none on a route with no closed recording). Not taken: for a busy caller (`overflow_no_capacity`), under the kill switch (§8.1), or
with no bucket configured (`S3_AUDIO_BUCKET`: the action's message plays instead). Retention: the call's
recordings stay at the carrier and age out with the call data (`AGENCY_RETENTION_DAYS`); a
voicemail ages out on the same window (`maintenance/retention-purge.ts` deletes the object, then
the row forgets it; the Missed row is kept). That step runs last, after the database steps; it is
skipped with a warning when no bucket is configured (the rows keep their keys for a run that can
delete them), and a delete that fails is counted (`inbound_voicemails_failed`), left naming its
object for the next run, and does not stop the rest. A stored voicemail whose row cannot be written
(the settle fails) is deleted again, best-effort, so no object is left that nothing names. Memory:
a voicemail in flight holds its PCM16 (up to 120 s, 3.84 MB) and, while it is written, its WAV
copy (about 7.7 MB at the peak), bounded by the route's `max_concurrent` and the stream slots. Playback: `GET /proxy/agency/inbound/missed/:id/
voicemail` (`agency.inbound.read` and the flag; the Missed list's rules: the account's row, an
agent only their own; `inbound_missed_call_not_found` for a row with none or an object gone),
`audio/wav`, `Cache-Control: private, no-store` (no browser or proxy copy outlives the retention
purge), streamed from the bucket (the internal handler names the object, the public route
streams it; a `Range` is passed to the bucket and answered 206; no automatic HEAD, which would
open a bucket stream for nothing); Missed rows carry
`voicemail_url` (`/inbound/missed/:id/voicemail`, relative to the proxy) when there is one. The
console fetches it with its bearer token only when it is that route (`voicemailFetchUrl` accepts
`/inbound/missed/:id/voicemail` or the same under `/proxy/agency`, nothing absolute, no query, no
other path), so a server mistake can never send the token elsewhere.
Analysis of voicemails is P3.

## 8. Configuration

### 8.1 Who sets what

| Level | Who | What |
|---|---|---|
| Tenant's Plivo credential | super-admin | **Enable inbound**: create one Plivo Application on the tenant's account (answer, hangup and fallback answer URLs); store `inbound_app_id`, the URLs, the token's hash. Health check and Re-point on the credential page; **Disable** deletes it, refused while numbers are linked |
| Each number | super-admin (IB6) | **Link to inbound** per number, never on sync. Store the number's previous Plivo app (`inbound_previous_app_id`) so Unlink restores it |
| Tenant / account | super-admin | Flag `agency_inbound_enabled` (default off), the kill switch: off, every call on the account's linked numbers is answered with the closed message by the carrier (no queue, no stream, no voicemail, whatever the route's actions; closed too with the route at its `max_concurrent`, never "all lines busy") with its `closed` Missed row, and the route editor and queue tiles are hidden; the Missed list, its voicemails and Mark handled, and the finish routes of calls already taken stay available |
| Account | account admin (`agency.inbound.write`) | Inbound routes: name, numbers, hours/timezone/holidays, clips (greeting, hold, closed, busy, call-back, recording notice; uploaded from the editor, IQ28), sticky mode/wait/lookback, agent pool, queue limits, after-hours and overflow actions, recording and summary profile, outcome catalog for unmatched callers |
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
- **Health on a timer** (`telephony/credentials/inbound-monitor.ts`, main process, from
  `bootstrap/voice.ts`): every 15 minutes, and once at boot, every credential with inbound enabled
  and not revoked (`listInboundEnabled`; a disabled one too, since it still answers) is checked as
  the button does, one at a time; the results are counted in `agency_inbound_applications{health}`
  (`ok`, `url_mismatch`, `app_missing`, `unreachable`, and `failed` when the check could not run:
  the carrier refused the credential or its secret cannot be opened), every series set each pass,
  and each one not `ok` is logged with its credential and tenant. With none enabled nothing is
  asked or logged and the gauges read 0. Alerts: `agy-inbound-application-broken` (pages) and
  `agy-inbound-application-unchecked`.
- **Before a route exists.** The Link confirmation says that until an account route answers the
  number its callers hear the closed message. The numbers list badges a linked number no route
  answers "Inbound · no route" (`inbound_route_name` on the list, `GET /super-admin/phone-numbers`),
  the credential's numbers say "no route", and a number's Inbound panel counts its open Missed rows
  that reached no account (§8.3: `unrouted_missed`, count and the latest;
  `phoneNumberRepository.findUnroutedMissed`, on `idx_agency_inbound_calls_missed`), since no
  console screen lists them. The setup order is `operations.md`, "Setting up inbound calls for a
  tenant".

### 8.2 Number lifecycle cascade

One function, called from account tagging, unassign, retire by sync (PL5) and revoke: marks the
route number inactive, clears the link, and while the credential still works unlinks the Plivo
number back to its previous app. Revoke is refused while numbers are linked. Each step audited.
A credential disable is not a cascade (below): its numbers stay linked.

**As built:** `TelephonyInboundService.reconcileNumber` / `reconcileCredential`. For each linked
number that may no longer be (not `active`, or not assigned to its credential's tenant): its route detached (`detachNumberEverywhere`,
`number_unlinked`) and its link cleared in one transaction, committed whatever the carrier says;
then, while the number is still the account's (`active`), put back on its previous app through the
credential (`call_control`: a disabled credential still opens). Audited `phone_number.inbound_unlinked`
with `cause` (`unlinked` by hand, `unassigned`, `retired_by_sync`, `retired`, `deleted`; rows
written before credential disables stopped unlinking may say `credential_disabled`) and `carrier` (`restored`, `number_missing`, `skipped_not_active`, `failed`:
the previous app id is in the row, to put back by hand). It never fails the write that called it (a
failure is logged; the next sync's reconcile retries). Call sites: `DELETE /super-admin/phone-numbers/:id/assign/:tenantId`,
`DELETE /super-admin/phone-numbers/:id` (retire), `POST …/:id/delete`, `PUT /super-admin/phone-numbers/:id`
to a retired or deleted status and `POST /telephony-credentials/:id/sync-numbers` (after the sync).
**A credential disable keeps every link, route attachment and the Application**
(`POST /telephony-credentials/:id/disable` runs no cascade): the numbers stay on our Application at
Plivo, and while the credential is disabled its calls are answered with the closed message and a
Missed row (§10, the answer's `credentialStatus`); enabling it again answers them as before, with
nothing to rebuild. It used to unlink every number and detach it from its route, so a disable and
an enable lost every account's route numbers; the number is still the tenant's, so nothing
requires that. **Revoke** is refused while inbound is enabled (`inbound_enabled`, 409, naming
the linked count), in the service and in the revoking statement (and by
`ck_telephony_credentials_inbound_revoked`). **Account tagging** has no write path in this build
(`tenantPhoneAssignmentRepository.tagToAccount` / `untagFromAccount` have no caller): tags do not
change a link (it is the tenant's), and a route that may no longer use a number is a route matter
for the route's own attach rule; a tagging route, when one is added, should call the cascade.

### 8.3 Which account a call belongs to

Plivo numbers sync to the tenant untagged, so several accounts may share one:
matched contact's account (if it may use the number) → the number's route → tenant default
(closed message + Missed row, no account). The tenant default's Missed rows are shown to
super-admins on the number's Inbound panel (count and latest, §8.1), the only screen that can.

### 8.4 The account's console (built)

Behind `agency_inbound_enabled`: the routes below answer `403 inbound_disabled` with it off,
except the Missed list, a row's voicemail and Mark handled, which stay readable and workable (the
kill switch, §8.1: the follow-ups of calls taken before it stay someone's to work), as the finish
routes do. Wire: `packages/contracts/src/api/agency/inbound.ts`.

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
| `GET /inbound/clips` | `agency.inbound.write` | the account's recordings (`audio_files`), newest first, at most 200, each with the live routes playing it; `upload_available` (audio storage configured) and `connects_agents` (one process, IB8) |
| `POST /inbound/clips` | `agency.inbound.write` | upload a recording (multipart: `name`, then `file`): WAV, MP3 or OGG, at most 5 MB and 120 s, decoded whole before anything is stored; 201 `{ clip }`; refused `inbound_clip_invalid` (400, 413 for the size; `upload_reason`), `inbound_clip_name_taken`, `inbound_clip_storage_unavailable` (503) |
| `DELETE /inbound/clips/:id` | `agency.inbound.write` | delete one no live route (or active announcement) uses; 204; `inbound_clip_in_use` (409, naming the routes), `inbound_clip_not_found` |
| `GET /inbound/clips/:id/audio` | `agency.inbound.write` | the editor's preview of one of the account's recordings: its bytes as stored, streamed from the bucket (the internal handler says where, tenant and account scoped); `inbound_clip_not_found` for another account's, an unknown or malformed id, or an object gone from the bucket |
| `GET /inbound/clips/standard/:recording/audio` | `agency.inbound.write` | the preview of one of our standard recordings (`AGENCY_INBOUND_STANDARD_RECORDINGS`), `audio/wav` from the image; an unknown name is `inbound_clip_not_found` |
| `GET /inbound/missed` | `agency.inbound.read` | keyset page, newest first; `status` (default `open`), `assignee`, `reason`, `from`/`to`; rows carry `match_name` (IQ54) |
| `POST /inbound/missed/:id/claim` | `agency.inbound.read` | an unassigned row to the caller (IQ49, a compare-and-set); `{ call }`, 200 also when already theirs; `inbound_missed_call_claimed` (409), `inbound_missed_call_handled` (409), `inbound_missed_call_not_found`; audited `agency_inbound_call.claimed` when it changed; not behind the flag |
| `POST /inbound/missed/:id/handled` | `agency.inbound.read` | idempotent: first handler and time kept, audited once; `handled_reason = 'marked'` |
| `POST /inbound/missed/:id/reopen` | `agency.inbound.read` | a handled row back to open (reason, handler and time cleared; assignee kept); Mark handled's rules (an agent's own rows); idempotent; audited `agency_inbound_call.reopened` (`handled_reason`, `handled_by_user_id`: how it had been handled) when it changed; not behind the flag |
| `GET /inbound/missed/count` | `agency.inbound.read` | the nav badge: the open rows of the caller's scope (an agent's own; with `agency.supervise`, the account's), narrowed by the list's `assignee` when given (IQ57: a supervisor's `me` counts only theirs) and by `since` (rows whose call arrived at or after it: the app's "rang while you were away", IQ50), counted to 100 (`open_capped` past it), and whether the scope has any row (`has_rows`); not behind the flag |
| `POST /inbound/missed/:id/assign` | `agency.supervise` | `{ assignee_user_id }` (a member, or `null`: the account); `inbound_assignee_invalid` (400) for someone who cannot work the account's rows, `inbound_missed_call_handled` (409) for a handled row; audited `agency_inbound_call.reassigned` when it changed; not behind the flag |
| `GET /inbound/summary` | `agency.supervise` | the inbound summary over `from`–`to` (§11); not behind the flag |

Validation past the body's shape (`route-config.ts`): each clip must be one of the account's audio
files (the FK has no tenant: the abandon clip's scoped check, so another tenant's recording can
never be played), the summary profile an active profile of the account, each pool campaign one of
the account's (a PATCH checks only the references it sets). Problems answer
`inbound_route_invalid` with `{ path, message }` per field. A number the account may not use,
an unlinked one, or one on another route answers its own 409 with `phone_number_id`
(`inbound_number_in_use` names the holder's `route_id` only when it is this account's). A
malformed id is the family's 404. Missed rows carry `assignee_departed` (the public layer's: the
assignee is no longer an active member who can work the account's rows), `handled_reason`
(`marked`, `reached`; null while open) and, on a `closed` row, `closed_cause` (`hours`,
`switched_off`, `no_route`, `credential_inactive`; 0030). Audit: `agency_inbound_route.created` (`numbers_added`),
`.updated` (`fields`, `numbers_added`, `numbers_removed`; not written when nothing changed),
`.deleted` (`numbers_removed`), `agency_inbound_call.handled` (`reason`; only when this request
marked it), `agency_inbound_call.reassigned` (`from`, `to`; only when it changed),
`agency_inbound_call.reopened` (`handled_reason`, `handled_by_user_id`; only when this request
reopened it).

**With the flag off** (the kill switch stops new calls reaching a queue, not the follow-up of the
calls that came in): the badge's count, reassign, Reopen and the summary are never behind the flag;
the console keeps Missed calls (the nav entry and the page, under a notice that inbound is switched
off, that callers hear the closed message and are still listed there) and the
Inbound summary while the caller's scope has rows to read, and hides them when it has none. What
the list and Mark handled answer with the flag off is the server's read rule; actions that start
calls follow the server's answer.

**Who sees which Missed rows.** An agent (no `agency.supervise`) reads and marks only the rows
assigned to them: the list is forced to `assignee=me` whatever was asked but `unassigned`, and
another's row answers `inbound_missed_call_not_found`. A row assigned to the account (no sticky
agent) is shown to agents only in the Team view (`assignee=unassigned`) and is worked once claimed
(IQ49), so it is never worked twice or by nobody. Supervisors read the account's,
filtering by `me`, `unassigned` or a person.

**Recordings (the final review's fix pass).** An account admin uploads recordings from the route
editor (`api/routes/proxy-agency-inbound/clips.ts`, the internal `api/routes/agency/inbound-clips.ts`,
`agency/inbound/inbound-recordings.ts`). An upload is checked before anything is stored: audio
storage configured (else 503, before the body is read), the type from the file's name (else the
browser's type), the name (given, else the file's, at most 120 characters), the size (multipart
limit 5 MB, 413), then the whole file decoded as a call would play it (`decodeToPcm16`, the 120 s
maximum; an undecodable file is refused with a clear message). It is converted to 8 kHz and put
in the clip cache under the hash `ensurePcmClip` computes, stored at
`inbound-audio/<tenant>/<account>/<random id>.<ext>`, and recorded by the internal handler, which
accepts only a key of the request's tenant and account; a row that cannot be written (the name
taken) deletes the object again. Delete refuses while a live route or an active announcement uses
the recording, under the file's row lock (a route write naming it waits and then fails its FK
check), and removes the object after the row. Audited `agency_inbound_clip.uploaded` (size and
length) and `.deleted`, filed under the recording (`agency_inbound_clip`). An upload naming no
account (no `X-Account-Id`) is refused `400 account_scope_required` before the body is read or
anything stored (the key names the account).

**Hearing a recording (round 2).** The editor plays what each message's choice means: beside each
clip slot a **Play** for the recording chosen, else our standard recording for that slot
(`AGENCY_INBOUND_SLOT_STANDARD`; the hold with none chosen has no Play: the built-in hold tone is
made as it plays), and a Play on every recording in the list. Both preview routes (the table
above) take the list's permission and flag, need the account, answer `Cache-Control: private,
no-store` and `X-Content-Type-Options: nosniff`, register no automatic HEAD and send the whole file
(no ranges: a recording is at most 5 MB). The console fetches the audio with its token into a blob
URL when Play is pressed and revokes it when the preview goes (`pages/settings/inbound-route/RecordingPreview.tsx`,
`fetchRecordingBlobUrl`), as the Missed list's voicemail; a new choice starts from Play again. A
seventh standard recording added to the contract's list is offered by the standard route with no
change here.

**Voicemail (P2).** `AGENCY_INBOUND_AVAILABLE_ACTIONS` (the contract's list of what a route may be
set to in this build) is `callback` and `voicemail` since P2 records one (§7); in P1 it was
`callback` alone and a route left on `voicemail` was refused `inbound_route_invalid`. The editor
offers the actions from that list (`offeredUnconnectedActions`): out of hours and when nobody can
answer are radio groups; a Missed row with `voicemail_url` gets **Play voicemail** (fetched with
the console's token only when pressed, played from a blob URL).

**Route warnings.** Every route read and write carries `warnings` (`inboundRouteWarnings`,
contracts; advisory, never a refusal), and the editor shows the same, live, beside the field each
is about: a route with no opening hours is closed at all times (`no_opening_hours`), calls recorded
with the notice switched off (`recording_without_notice`), and, for the whole route, a deployment
that cannot put callers through to agents (`connect_unavailable`: media workers on, IB8; nobody is
put through, and an open-hours caller hears the call-back message, or the busy one when they may
not be promised a callback; the warning says so in the editor's names for the two messages). The server reads the deployment as the router does
(`MEDIA_WORKERS`); the editor reads it from `GET /inbound/clips` (`connects_agents`). A message
with no recording is no warning: our standard recording plays (§3.4). The P2 warnings about a
silent overflow and a voicemail with no prompt are gone with the silence they described.

**Console.** Settings → **Inbound routing** (`/settings/inbound`, `/settings/inbound/new`,
`/settings/inbound/:id`; the old `/app/inbound*` URLs redirect there (B28); account admins): the routes and the route editor
(name, time zone, numbers with why one cannot be chosen, weekly hours (a new route starts open
Monday to Friday, 09:00–17:30, in the browser's zone: the account has none of its own; editable;
the hours card names the zone they are read in), holidays, the six clips from the account's
recordings (with none chosen, "Our standard recording", the words quoted under each; the hold,
"Built-in hold tone", §3.4), each with a Play, the recordings themselves (upload, the list with the
routes playing each and a Play, delete of one nothing uses; without audio storage the editor says
uploads are unavailable), their agent first (IB2 defaults; the seconds a `loose` caller is offered
to their agent are "How long to wait for their agent (seconds)", never the strict mode's name),
the team (pool campaigns), waiting and limits, what callers nobody answers hear (a withheld or DNC
caller hears the All lines busy message in opening hours, never the closed one), recording and the
notice, summary profile, outcomes for unmatched callers). In the hours editor a closing time
earlier than the opening runs overnight and belongs to its opening day; a closing time of `00:00`
is midnight (sent as `24:00`), so `00:00`–`00:00` is the whole day. A save sends only what
changed. **Missed calls** is in the agency sidebar (`/agency/inbound/missed`) and, for a
dedicated agent, in the agent nav (`/dialer/missed`): To follow up / Handled, filters, keyset
paging, a DNC badge, and per row **Call back** and **Mark handled**; for a supervisor, **Reassign**
(the account, or an active member of it) and "Former member" with the prompt to reassign; the
Handled tab says "Customer reached by …" for a row that closed on its own, and offers **Reopen** on
every handled row. A closed row's reason reads "Out of hours", or its cause when it was not the
hours ("Inbound switched off", "Number not on a route", "Phone line not active"). "Nobody free to
answer" means one thing on the list, its guide and the summary: the caller waited as long as the
line allows, the queue was full, or nobody in the team could take calls (`overflow`); every line
busy is its own reason. With the flag off and rows to read, the page says so: callers hear the
closed message and are still listed here. The nav entry (the
agency sidebar and the agent's nav) carries the open count as a badge ("99+" past the cap), read
once for every reader of the tab, polled every minute while inbound is on and on the reader's
return, and re-read after a Mark handled or a reassign. **Inbound summary** (`/agency/inbound/summary`,
supervisors) is §11. On the supervisor's floor an agent owing an ended inbound call's outcome
(`inbound_outcome_owed` on the floor's agent row) reads "Wrapping up an inbound call", and the
drawer's force-return is **Close and make available**: `force-available`, which closes the call's
outcome as lapsed ("closed by a supervisor") and returns the agent, with its own confirm; a server
that refuses (`409 inbound_call_live`) is said in plain words. An agent on a break who owes one (a
restart rehydrates them there, §6) is offered the same close, its confirm adding that the break
ends (the server closes it whatever the state); the row's control reads "Close inbound call…".
The agent's station says why a call closed with no outcome saved: "The time to save this call's
outcome ran out, so it was closed without one." once its window has ended (`outcome_due_at` on the
server's clock; also the words of an "already saved" refusal after the window), else "A
supervisor closed this call without an outcome." (the wire carries no reason: bridged, settled,
no code). Call back opens the soft
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
request account's; super-admins see them per number, §8.1).

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
- **`handled_reason`** (0028): `marked` or `reached` on a handled Missed row (§7); the triggers
  that close a row when the customer is reached (0030: the campaign attempt's and the soft-phone
  call's on a person-reached outcome, the inbound call's at its bridge, the number by its digits);
  `idx_agency_inbound_calls_missed_open_digits` (their probe, 0030; 0028's
  `idx_agency_inbound_calls_missed_open_from` matched text) and
  `idx_agency_inbound_calls_account_arrived` (the summary's range). Inventory:
  `packages/db/BASELINE.md` "0028", "0030".
- **`closed_cause`** (0030): why the answer treated the caller as closed, stamped by the router at
  arrival: `hours`, `switched_off` (the kill switch), `no_route`, `credential_inactive`; NULL when
  the route was open. Backfilled for the closed calls before it (`no_route` without a route, else
  `hours`).
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
- **Usage counts** (`usage-counts.repository.ts`, the super-admin Usage page): inbound calls with
  an account are counted apart from the dials, windowed on `arrived_at`: `inbound_calls`,
  `inbound_answered_calls`, `inbound_connected_calls`, carrier time `inbound_seconds` (what the
  carrier bills, messages and holding included: the carrier's own duration from its hangup
  callback, `carrier_seconds` (0029, round 2, SWE-F8), when the call has one, else answer to end; a
  call answered with a spoken message ends on our side at the answer while the carrier speaks on), `inbound_hold_seconds` (queued to
  bridged, else to the end), `inbound_talk_seconds`, `inbound_analysis_audio_seconds`. The dial
  columns count placed calls only, as before inbound. A tenant-default call (no account) is not
  counted (no row to land in).

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
  UPDATE that ends it; a bridged one when its outcome is saved or lapses (`no_disposition`, at
  its wrap-up window, §6, at most `AGENCY_INBOUND_OUTCOME_LAPSE_MS`, 30 min) or a supervisor's
  force-available closes it the same way, never by the end or the startup sweep, which leave
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

### 9.2 Round 2 (built: `0029_inbound_reach_settles.sql`)

Inventory and the CHECK: `packages/db/BASELINE.md` "0029".

- **`agency_contacts.callback_reopened`** (NOT NULL DEFAULT false, catalog-only): the inbound
  callback reopened this contact from `exhausted` (IB4). `bookInboundCallback` writes it (a reopen:
  true; a second booking keeps it; any other booking false); `settleFromInbound` clears it, and its
  `none` arm (a retry or plain outcome saved, or an outcome that lapsed or a supervisor closed)
  puts such a contact back to `exhausted`. Meaningful only while `callback_source` is set.
- **`agency_inbound_calls.carrier_seconds`** (NULL until known, ≥ 0): the carrier's duration from
  its hangup callback (Plivo `Duration`, passed through the seam as `durationSeconds`), recorded
  whatever the call's state; `inbound_seconds` reads it when set (§9 "Usage counts").

### 9.3 The pilot rulings (built: `0032_inbound_route_wrapup.sql`, `0033_inbound_answered_from_index.sql`)

Inventory: `packages/db/BASELINE.md` "0032", "0033".

- **`agency_inbound_routes.wrapup_seconds`** (SMALLINT NOT NULL DEFAULT 30, CHECK 10–600): the
  route's wrap-up window (IQ52, §6). **`agency_inbound_calls.wrapup_seconds`** (nullable): the
  window captured from the route when the call arrives, read by the panel's `outcome_due_at` and the
  lapse sweep (NULL: 30 s); existing calls were backfilled from their route.
- **`idx_agency_inbound_calls_answered_from`** (`tenant_id, account_id, from_e164, arrived_at DESC,
  id DESC` WHERE `bridged_at IS NOT NULL AND from_e164 IS NOT NULL`): the caller's answered inbound
  calls for the sticky signal (IQ49, §4.1).

### 9.4 Mode B (built: `0036_inbound_ring.sql`, `0037_away_ring_sessions_index.sql`)

Inventory and the CHECKs: `packages/db/BASELINE.md` "0036"; pinned by
`packages/db/test/integration/db/inbound-ring-migration.test.ts` (each CHECKed list held equal to its
contract list). The down drops it all; a session left on `break/away_ring` reads as an ordinary break
to an older server.

- **`agency_push_devices`** (new): one row per agent and device, `UNIQUE (user_id, device_id)`
  (the register's upsert arbiter and the ring's join from a session on `(agent_user_id,
  station_device_id)`). `device_id` VARCHAR(64), the app's station device id (OS3, non-blank);
  `platform` `android` | `ios`; `fcm_token` (Android) and `voip_token` (iOS PushKit), device
  addresses stored in plain text (not secrets), never served back or logged, non-empty when set,
  each unique among live rows (partial indexes `WHERE revoked_at IS NULL`: a reinstalled phone is
  never rung twice, the register revokes the older row); `app_build`; `ring_enabled` (the opt-in,
  default false); `last_seen_at` (the last register); `revoked_at` (removed, or the token reported
  unregistered; a register revives it); `last_failure_at` and `last_failure_reason` (the last failed
  send, both or neither, from `AGENCY_PUSH_FAILURE_REASONS`); `tenant_id` (the tenant it last
  registered from; it scopes nothing the ring reads: one phone across tenants, OS1). User and tenant
  are foreign keys `ON DELETE CASCADE`.
- **`agency_inbound_calls`**: `offer_channel` (`station` | `push`; NULL before any offer, and on a
  row offered before Mode B, read as `station`), `ringing_at` (the latest ring's start: the ring
  window counts from it), `accepted_at` (when that ring was answered: the grace counts from it),
  `ring_result` (how it ended: `AGENCY_INBOUND_RING_RESULTS`), `ring_count` (rings across requeues,
  default 0). CHECK: a `push` offer has `ringing_at`, an answer only after a ring, `ring_count >= 0`.
- **`agency_agent_sessions`**: `ring_misses` (missed rings in a row, IQ62; default 0, never
  negative; reset when a ring binds and on `available`; a session at the maximum is never rung) and
  `away_ring_since` (the start of this absence on `away_ring`, IQ67: stamped by the first
  `break/away_ring`, kept across the rings in it, cleared when a ring binds (`ringAnswered`: the
  agent is back in the app, on the call), by every other state, by the take-over's claim and by
  leaving; the reconcile's key, N1, because each ring rewrites `state_since` and nulls
  `break_reason`).
- **0037** (`0037_away_ring_sessions_index.sql`; `packages/db/BASELINE.md` "0037", pinned by
  `packages/db/test/integration/db/away-ring-sessions-index-migration.test.ts`):
  `idx_agency_agent_sessions_away_ring (tenant_id, account_id) WHERE away_ring_since IS NOT NULL AND
  left_at IS NULL`, partial, so it holds only the agents away right now, for the connector's search
  of an account (`findRingableInAccount`) and the reconcile (`findAwayRingCandidates`), which
  otherwise scanned every session row. The down drops it.

## 10. Restart and failure

- Startup and periodic sweep: non-terminal `agency_inbound_calls` rows become `failed` (a bridged
  one `answered`, its outcome still owed) with a follow-up (the spine is durable, so the follow-up
  survives); `failed`, not `abandoned_in_queue`, because we dropped those callers.
- While we are unreachable Plivo plays the Application's fallback answer XML.
- A disabled or invalid credential: answered if the signature still verifies (closed message +
  Missed row), flagged on the credential page. Its links and routes are kept (§8.2), so enabling
  it again answers as before.
- An Application changed or deleted in Plivo's console: found by the scheduled health check
  (§8.1) within 15 minutes, `agy-inbound-application-broken`.
- Mode B (§6.1): a ring dies with the process like any offer; the agents on `away_ring` (their
  Redis keys, or the database when a key lapsed) are restored by the reconcile at boot and every
  60 s, and an absence past its age, its flags or its device is ended with a `ring_off`.

## 11. Reporting

**The inbound summary (built).** `GET /proxy/agency/inbound/summary?from&to` (`agency.supervise`;
`api/routes/agency/inbound-missed-work.ts` over `db/repositories/agency/inbound-report.repository.ts`)
and the console's **Inbound summary** (`/agency/inbound/summary`: Today, Last 7 days, Last 30 days
or two dates, cut at the viewer's local midnights; at most 93 days). One account's calls that
arrived in `[from, to)` and have ENDED (a live call counts once it ends), two statements over
`idx_agency_inbound_calls_account_arrived` (0028):

- **calls**; the calls answered with the closed message (or a voicemail taken out of hours: Missed
  reason `closed`), by why (`closed_cause`, 0030): **after hours** (out of the route's hours or a
  holiday), **switched off** (the kill switch), **no route** (the number reaches none), and an
  inactive credential, which counts as not served; a closed call with no cause recorded is after
  hours with a route, no route without one. **Open-hours calls**: the rest less `rejected` (turned
  away at the answer), the denominator of every rate;
- **answered** and the **answer rate** (answered ÷ open-hours calls); **abandoned**
  (`abandoned_in_queue`) and the **abandon rate** (÷ open-hours calls);
- **time to answer**: arrival to being put through (`bridged_at - arrived_at`, the greeting
  included: what the caller lived through), the average and the 90th percentile over answered
  calls;
- **voicemails**; **nobody free to answer** (`overflow`: the maximum wait or queue length was
  reached, or nobody in the pool could take calls; the Missed list's meaning) and **all lines busy**
  (`overflow_no_capacity`), apart, with `overflow` their sum; **not served** (`failed`, `rejected`,
  and a closed call whose credential was not active);
- **sticky hit rate**: open-hours calls answered by their sticky agent ÷ open-hours calls that had
  one (§4.1);
- the **Missed rows** the calls left and how many are handled;
- **per agent**: calls answered and talk time (`talk_seconds`), busiest first, names filled by the
  public layer.

Rates are to one decimal, null with nothing to divide by. Not built (P3): service level (answered
within 20 s), callbacks created and completed, an Inbound tab per account in Insights (the Insights
pattern), inbound in agent performance, the floor's `calls_handled`, account reports and customer
history.

**Mode B (IQ74).** `away_ring` is break time, not staffed time, as any break. A caller whose rings
went unanswered and who then overflows is in Missed as today. How each ring ended is on the call
(`ring_result`, `ring_count`, §9.4) and in `agency_inbound_rings_total`; no report reads them yet.

## 12. Build plan and status

| Phase | Scope | Status |
|---|---|---|
| P0 | Live Plivo checks, alongside the planned real Plivo call (step 5): create an Application and link/unlink a number; answer-URL params, timeout and inbound `CallStatus`; hangup URL params; fallback answer URL; moving a live streamed call to new XML (voicemail, worker handover); DTMF over the stream. Results into `plivo-carrier.fixture.json` | not started (needs a Plivo account) |
| P1 | Answer every call, connect nobody: credential Enable inbound + Application, per-number link/unlink + cascade (pilot tenant first), answer and status webhooks, spine + `origin = inbound`, routes with hours/holidays/clips (closed, "we'll call you back", recording notice), follow-ups (Missed list, inbound callback on contacts), startup sweep, usage, audit, flag, RBAC, super-admin and console screens | **done** (the review's fixes below): foundation done (`feat(db,contracts,domain,server): inbound calls foundation`: `0024_inbound.sql` and `0025_inbound_checks_validate.sql`, contracts, flag, permissions, audit names, the schedule and number rules, the route and spine repositories, usage). **Super-admin slice done** (`feat(server,super-admin,contracts,db): inbound Plivo Application, number links and the lifecycle cascade`, §8.1, §8.2, §3.3): Enable / Disable / Health / Re-point, Link / Unlink, the cascade at every write that exists, revoke refused, the routes, the credential page's Inbound section and the numbers page's Link / Unlink and badge, the fixture's Application and number shapes (unverified until P0), the mock carrier's; `agency_inbound_enabled` is toggled on the generic flag screens. Rollout: link a pilot tenant's numbers first. **Webhook slice done** (§3.4): the answer, hangup and fallback webhooks, the inbound seam, the bridge's `acceptInboundCall` / `playClipSequenceThenHangUp`, caller identification, admission (IB5, `0026_inbound_live_indexes.sql`), the Missed row and the inbound callback (IB4) on the dialer's claims, the sweep, metrics. Open: Plivo's answer-URL params and timeout (P0). Recorded built-in clips: done in the final review's fix pass (P2 row). **Console slice done** (`feat(server,console,contracts): inbound routes and the Missed calls list in the console`, §8.4): the routes API with the editor's number and clip choices, the Missed list and Mark handled, Settings → Inbound calls, Missed calls for supervisors and agents with Call back into the soft phone; voicemail refused until P2; the campaign's `inbound_sticky_enabled` toggle and tenant-default Missed rows left open (§8.4). **Review fixes** (`fix(server,db,console,contracts,super-admin): inbound P1 review fixes`): a `CallUUID` held by another tenant or credential is refused (§3.4); the migration renumbered `0026` (no gap; the fixes needed no new migration, so the next one is `0027`); IB5's arm counts admitted calls only; CA5's code-less sweep reads an index of inbound callbacks; read-only carrier calls out of the operator transactions and the Application list bounded (§8.1); an answer past its budget leaves no follow-up; a second Re-point refused while the first's token is still needed (§8.1); an unrecorded message spoken by the carrier, never silence (§3.4) |
| P2 | Connect agents (console, single process, IB8): parked mode with looped hold, inbound reservation + panel + outcome + wrap-up, sticky loose/strict, team queue, `inbound_waiting` on the pacing bus, take-from-wrap-up CAS, in-flight clash (§5.4), concurrency answers (§5.3), voicemail, supervisor queue tile | **done**, with the fix pass (both rounds; below the table). The build's rulings are IQ1–IQ24 (`decisions.md`). **Foundation done** (`feat(db,contracts,server,console,mobile): inbound P2 foundation`, §9.1): `0027_inbound_connect.sql`; the contracts (`AgencyInboundCall`, the `inbound_call` and `customer_waiting` frames for console stations only, release reason `inbound_call`, the inbound call codes, `customer_on_inbound_call`, the queue tile, `voicemail_url`, `on_inbound_call`, the constants, the reserved code `inbound_call`); the `inbound_waiting` bus event with no consumer; the agent hash's `inbound` field (`reserveForInbound`, `releaseInbound`, `rehydrateInbound`, `available` refused `-3` and answered `409 inbound_call_live`, no attempt reserved onto it); the spine's agent-side writes; the busy probe's inbound arm (pacing, the agent's own dial and retry, the soft phone's pre-dial); `settleFromInbound` and `unclaimUncharged`; the campaign's `inbound_sticky_enabled` on create, PATCH and retry. Nothing connects yet: the connector, queue, hold loop, voicemail and the console panel follow. `AGENCY_INBOUND_AVAILABLE_ACTIONS` stays `callback` until the voicemail flow lands. **Bridge and voice done** (WP-B, docs/seams.md §3.1): a connectable call is parked (borrowed-unbound; its budget, answer XML stream timeout and slot TTL are parked + max duration; a parked backstop), `playInboundHold` (the preamble once, then the hold clip or the built-in generated hold tone on a loop, IQ24; never hangs up), `stopInboundHold`, `recordInboundAudio` (prompt, beep, a bounded carrier tap with nobody bound), the bind stopping the hold synchronously, re-arming the max duration and counting talk time from it, and the recording from `bridged` through Plivo's Record API (its request and callback shapes unverified until P0). **Connector done** (WP-C1, §6 "The server"): the `queue` plan gated on the flag and one process, the preamble then the queue, sticky loose/strict, the team queue and its limits, the offer and the bind, the release hook taking an agent from wrap-up, `inbound_waiting` consumed by pacing, the station's drop and reconnect, the restart, the outcome routes and their audit, the lapse sweep, the queue tiles route, the metrics; `onPreambleDone` added to the hold seam and `cleared` to `customer_waiting`. **In-flight clash and voicemail done** (WP-C2, `feat(server,contracts,console): inbound P2 in-flight clash and voicemail`; §5.4, §7, §8.4): a queued caller's ringing dial cancelled on Plivo and its agent handed the call (held through the caller's preamble, never `available`; the dial `canceled` / `inbound_call`, its contact uncharged, released `inbound_call`; the bridged-first race kept as a call; VoiceLink and the soft phone's own dial left alone); a caller past the maximum wait marked leaving at once so no lock waits behind an exit; voicemail after hours and from the queue (recorded from our stream, kept when the caller spoke, a WAV in the bucket on the call-data retention, the Missed row with `voicemail_url`, streamed by `GET /inbound/missed/:id/voicemail` with ranges); `AGENCY_INBOUND_AVAILABLE_ACTIONS` widened; route warnings for a silent overflow or a voicemail with no prompt (API and editor, advisory). No migration. Tests (on the code commit): `pnpm lint` clean; unit: server 477 files, 9458 passed (1 expected fail, 42 skipped), console 316 files, 6014, contracts 13 files, 367; server integration `INTEGRATION_LANE=rest` 239 files, 2513 passed (9 expected fail, 2 skipped), `wall-clock` 3 files, 15; new suites `inbound-clash-voicemail-e2e` 5, `agency-dialer-inbound-clash` 7, `inbound-voicemail` 5, `inbound-route-warnings` 6, the connector races +7 (19), the routes +4 (17). **Review fix pass done** (`fix(server,console): inbound P2 review fixes`; §4.3, §5.2, §5.4, §6, §7, §8.4): the station heartbeat renews a `wrapup` lease this process vouches for (45 s, as `available`'s), so the release hook takes an agent from a wrap-up of any length with no `available` instant and a `/break` asked for during it is queued, while an unvouched `wrapup` key lapses and rehydrates as `break`; `releaseAgent` announces `available` only after its mirror and frame; `inbound_waiting` holds no team agent for a strict caller whose sticky agent is not away or for a hand-over, and the connector searches again on each republish; no hand-over (so no cancelled dial) to a phone, a station not OPEN or the soft phone; a failed `connected` write ends `answered`, not `abandoned_in_queue`; the inbound stop ends and settles its calls before the runtime stops; a turned-away caller asks for no recording; a voicemail's budget covers its recording whatever the account's ceiling, a voicemail whose row cannot be written is discarded, the purge's voicemail step runs last and survives a failed delete or a missing bucket, and playback has no automatic HEAD; the Insights override lookup skips `inbound_call` (docs/insights.md "System dispositions"); the console says a call on offer went back to the queue when a reconnect finds it gone. By design and documented: the outcome window's busy number (§6). No migration. Tests (on the code commit): `pnpm lint` clean; unit: server 478 files, 9467 passed (1 expected fail, 42 skipped), console 316 files, 6016; server integration `INTEGRATION_LANE=rest` 239 files, 2520 passed (9 expected fail, 2 skipped; one unhandled timer error from `report-assembler-deadline.test.ts`, a flake in a file this pass does not touch), `wall-clock` 4 files, 19; `packages/db` integration 68 files, 696; new suites `inbound-wrapup-lease` 4 (wall-clock), `station-heartbeat-lease` 5; the connector races +3 (22), `inbound-connect-e2e` +1 (14), `inbound-clash-voicemail-e2e` +1 (6), the insights oracle +1 (8), the state cycle +1 (2). **Console done** (WP-D, §6): the station's `inbound_call` and `customer_waiting` handling and restore after `ready`, the inbound chime, `InboundCallView` in the station's geometry with the outcome, notes, callback, hang-up, mute, DNC and the lapse countdown, the waiting pill, the supervisor's queue tiles and the floor's "Inbound call", the campaign's "Put callers through to their agent", voicemail playback on the Missed list and the route editor's actions from `AGENCY_INBOUND_AVAILABLE_ACTIONS`; built against the call routes' paths in `api/inbound.ts` (`INBOUND_PATHS`) and mock answers; since the connector landed, those paths are in the route table's console-paths fixture (`agency-route-table.test.ts`: served, at the console's path and method). Not run here: the console in a browser against a running server. **Verification pass done** (`test(db): …`, `test(server): …`; no product change): the full run's three reds were test-order assumptions, each reproduced and made deterministic. The 0003 and 0004 partial-index plan tests plan over a roster and attempts of their own (`insertPlanRoster`): over what earlier files left (`agency_contacts` analyzed empty, the partial indexes bloated by dead rows, `idx_agency_contacts_insights` rebuilt small by a down → up across `0026`) the planner priced indexes by pages and took the insights index; over a campaign-shaped roster it takes the partial indexes with or without `0026`, so no index changed. `inbound-connect-e2e` 2b read B's offer and A's cleared "customer waiting" frame at the instant the spine row read `offered`, which the connector commits before it sends them; it now waits for both and pins A's notices as exactly [waiting, cleared]. Counts in `status.md` "Test counts". **Final review fix pass, what callers hear** (IQ25–IQ28, IQ44; §3.4, §6, §7, §8.4): our standard recordings (six WAVs, British English, `assets/inbound/`, the words one set with the carrier's `<Speak>`) play wherever a slot is unset on our stream: the queue's exit (no caller put down in silence; the silent path, its log line and warning removed), the voicemail prompt (a route with no recordings takes voicemail), the recording notice (IB7 kept whenever the notice switch is on), the "please hold" for no greeting; DNC callers hear the closed words, never a callback promise (round 2: the busy words in opening hours, IQ27); recordings uploaded from the route editor (checked and decoded before storage, S3 + `audio_files`, tenant and account scoped, audited) and deleted when nothing uses them; the editor's copy says what callers hear, a new route opens Monday to Friday 09:00–17:30, warnings for no hours, recording unannounced and a deployment that cannot connect; "Wait for their agent" says what strict does. No migration. **Final review fix pass, Missed calls and supervisor tools** (IQ33, IQ41, IQ42; `0028_inbound_missed_follow_up.sql`; §7, §8.4, §11): a Missed row closes on its own when the customer is put through (`reached`); supervisors reassign, a departed assignee reads "Former member"; the nav badge; Missed calls and the summary readable with the flag off while there are rows; the floor's "Close and make available" for an inbound wrap-up; the inbound summary; the voicemail fetched only from its own route and never cached. **Fix pass round 2, the server runtime** (IQ27, IQ29, IQ30, IQ32, IQ36, IQ40; `0029_inbound_reach_settles.sql`; §3.4, §5.1, §6, §7, §8.1, §9.2): a caller nobody could take is answered with the overflow action before the greeting (no "please hold"); a station closed within the 15 s rejoin grace still counts as one who could take a caller; withheld and DNC callers hear the busy words in opening hours, never "we're closed", and leave voicemail with a seventh, neutral standard recording; a decline or refused bind past the maximum wait returns its agent before the exit; the kill switch wins over `max_concurrent` and takes no voicemail; an unmatched call's wrap-up is 120 s; a lapsed or supervisor-closed outcome settles the booked inbound callback (a contact it reopened goes back to exhausted); the carrier's duration from the hangup callback counts in `inbound_seconds` |
| P3 | Mobile app frames (Dart wire), pickups from break and soft phone, media-worker handover, reports/Insights, "press 1 for a callback" if DTMF works | **mobile app frames done** (2026-11-10; IQ46 and IQ47, both **Decided**; §4.3, §5.1, §5.2, §5.4, §6 "Mobile stations"; [`mobile.md`](mobile.md) "Inbound calls", "Missed calls"). **The Dart wire types** (`feat(mobile,contracts): Dart wire types for inbound calls and the Missed list`): `agency_wire`'s `inbound.dart`, the two frames decoded, the inbound vocabularies and refusals, `fixtures/agent/inbound.json`. **The Missed list** (`feat(mobile): Missed calls tab with Call back`): a segment of My calls with the open count badged, Mark handled and Reopen, Call back into the soft phone (it fills the pad and never dials). **The station** (`feat(mobile): take inbound calls on the station`, then `test(mobile): hold the inbound hang-up bar the way a finger does` and `docs(mobile): say what of inbound calls has not run; the Missed list is not behind the flag`): `caps=inbound` on every connect, the offer, the call and the outcome on the campaign call's parts, the chime made in the engine (Dart reference, Kotlin, Swift, shared vectors), "Your customer is waiting", the reconnect check. **The server** (`feat(server,contracts): offer inbound calls to mobile stations that declare caps=inbound`, then `fix(server): never offer an inbound call to a station that lost the capability mid-offer`): the station upgrade's `caps=inbound`, the capability on the live socket, every mobile exclusion replaced by it, `AGENCY_STATION_INBOUND_EVENTS` (renamed from the console-only list), a phone silent on a live inbound call dropped as on a campaign call (M1), an older build's reattach handled as a lost station, an offer refused to a station that lost the capability before the spine's write; the inbound vocabularies and `station_capabilities` in `literals.json`. **Two review rounds** (`docs: ratify IQ46 and record the mobile app's inbound defaults as IQ47`; app: `fix(mobile): keep notes restored after a restart over the server's older copy`, `fix(mobile): give a waiting Call back a lifetime and close the override prompt it replaces`, `fix(mobile): keep the Missed list and badge fresh mid-shift and list only the agent's own rows`, `docs(mobile): the Missed list's refresh rule, assignee=me and the Call back lifetime`, `fix(mobile): check the inbound vocabularies as extracted and drop the unused lapse constant`, `fix(mobile): follow inbound calls in the server's own frame order, and keep a let-go call gone`, `fix(mobile): a refused soft-phone outcome sends the last notes; an agent's Missed fixture row`; server: `fix(server): keep pacing's inbound hold-back and an older build's ready to stations that can take the caller`, `test(server): tighten the IQ46 guards and accept the pool tick's reservation in the cluster device_away case`, `docs(server,contracts): correct the inbound capability comments and which inbound routes the flag gates`, `test(server): pin that onStationCannotTakeInbound settles only after the agent's return`): the server's frame order followed (a neutral screen for the `reserved` before the offer), a let-go copy kept gone, the reconnect check kept going after any non-answer, restored notes kept over the server's older copy, a refused outcome re-sending the notes (the soft phone's too), the Missed count polled every 60 s in the foreground and re-read on a settle and on entering, `assignee=me`, a 5-minute Call back lifetime; pacing's hold-back and an older build's `ready` kept to stations that can take the caller. Not run on a real phone or carrier; iOS does not compile yet and the chime's Swift has never been compiled; the chime's Kotlin was compiled and `ChimeTest.kt` passed offline on a JVM during review, but CI does not run the Android unit tests (`mobile.md` "Not verified yet"). **Pilot rulings built** (2026-11-11, IQ48–IQ57, `decisions.md` §4; `0032`, `0033`; §4.1, §5.1, §6, §7, §9.3; [`mobile.md`](mobile.md)): Missed calls on duty with a one-step Call back, an answered inbound call as a sticky signal, the Team view and claim, the 30 s device-away return and could-take, the `phone_call` pause, the route's wrap-up window, `match_name`, the DNC note, the floor's "Update app", the badge's `assignee`; in-app voicemail playback after the pilot (IQ53). **Remaining:** pickups from a catalog break and from an idle soft phone (§4.3), the media-worker handover (IB8, gated on P0), inbound in reports, Insights and customer history (§11's "Not built"), the analysis of voicemails (§7, IQ14), "press 1 for a callback" if P0 shows DTMF works over the stream. **Mode B, ringing an away agent's phone** (2026-11-12, IQ58–IQ74 and N1–N5, all **default, pending Manas**; §6.1, §9.4; [`mobile.md`](mobile.md) "Ringing while away (Mode B)"): **server and Android built, iOS designed only, not field-tested** (below the table) |
| P4 | VoiceLink behind a carrier-module `inbound` capability | not started |

**Mode B** (2026-11-12, `0036_inbound_ring.sql` and `0037_away_ring_sessions_index.sql`, flag
`agency_inbound_ring_enabled`). Built and
tested: the foundation (`feat(contracts,db,domain,server,console,mobile): Mode B foundation`: the
`away_ring` break, the ring fields on the call, push devices, the flag, 0036, the Dart wire types),
the push seam and the FCM HTTP v1 and APNs VoIP senders behind it (`feat(server): the push-sender
seam, unwired`, `feat(server,observability): FCM and APNs VoIP push senders behind the push seam`),
`away_ring` with its Lua, the push-device routes and the reconcile (`feat(server,contracts,console,mobile):
Mode B away_ring: the Lua, push devices, the reconcile`), the connector's ring, the ring routes, the
metrics, the alert and the dashboard row (`feat(server,observability,grafana): ring an away agent's
phone for an inbound caller`, then `test(server): pin that a ring is rung once per declining phone
and not taken over by an agent already on screen`), the Android native ring (`feat(mobile): Android
native ring — FCM, self-managed Telecom call and full-screen CallStyle`, `fix(mobile): start the app
before answering from the lock-screen ring`) and the Flutter side (`feat(mobile): ring this phone for
inbound calls — opt-in, away_ring and answering from a ring`), then a review round
(`fix(mobile): Mode B review fixes — a ring answer holds the station for the accept's URL`,
`fix(mobile): Mode B review fixes — own ring is not busy, server-timed expiry, bounded decline,
hang-up after accept`, `fix(server,db): Mode B review fixes — push outages, take-over race, renew,
ends and the away index`): a failed push is never a miss and an outage pauses ringing for
`INBOUND_PUSH_RETRY_MS` instead of walking the pool, an agent at the maximum misses is not
ringable, an answered ring ends the absence, IQ73's take-over survives a ring ending mid-search,
the renew never touches `away_ring`, `/leave` and OS7 tell a parked phone, a queued `away_ring`
applies from `offline`, and `0037_away_ring_sessions_index.sql` (§9.4). The server's side is tested on real
Postgres and Redis with fakes, and end to end against mock Plivo, the mock push carrier and a real
station socket; the app's with a fake ring channel; Android's logic (the state machine, the push
parser, the request builders) by Kotlin JVM tests. **Not done:** no Gradle build or APK has run
(the Android SDK was out of reach): the Telecom, notification, activity and FCM adapters compiled
only with `kotlinc` against the framework jar outside Gradle, and the manifest and Gradle changes
were never processed; nothing has run on a phone, against FCM or APNs, or with a real caller; the
Play Console full-screen-intent declaration is not filed; iOS is a design only (blocked on its first
compile, an Apple account and an APNs key). The field test (the Telecom answer from a headset or a
car, Android 14/15's background activity starts, battery killers and a force-stop that drops FCM)
is the next step; the two-miss rule bounds what a phone that cannot ring costs callers.

**The fix pass is done** (two rounds, 2026-11-09, on top of P1 and P2): every finding of the
independent engineering, product and QA reviews of P1 and P2, then of a review of the first round,
that Manas approved fixing is fixed, and its decisions are recorded as IQ25–IQ45 in
`decisions.md`, each with the ruling it amends (IQ32 replaces IQ11's "no auto-return"; IQ29 amends
IQ5; IQ35 amends IQ18; IQ36 amends IQ12; IQ38 amends IQ13; IQ25 and IQ27 amend IQ14; IQ43 amends
IQ20; IQ37 replaces the credential-disable cascade). The pieces: round 1's queue and offers
(callers nobody can take overflowed at once, membership read at the offer, a declined offer
requeued, console-only frames dropped at the send, `isCallEnding`; IQ29, IQ30, IQ43) and its
settlement and agent return (no agent lifted off a break, the wrap-up's auto-return, the
supervisor's close, the fail-closed nonce, the sweeps and early hangups; IQ31–IQ35), in §3.4 and
§6; the P2 row's "Final review fix pass" and "Fix pass round 2" entries; and the two paragraphs
below. The mobile `agency_wire` `dart test` has run on the merged branch (510 passed, Dart
3.13.7). Still open: P0; listening to the standard recordings and signing off their licence; the
voicemail and spine retention for a UK pilot; the follow-ups `status.md` lists under "Not built".

**Operations review fixes** (IQ37–IQ40, IQ45; `fix(server,super-admin,db,contracts,observability,grafana): inbound operations, monitoring, kill switch and usage`):
media workers on made loud (§3.2), the fallback URL on the checklist with a boot warning (§3.3),
the Application health check on a timer (§8.1), the Grafana inbound rules and dashboard row, the
onboarding hole closed in super-admin (§8.1, §8.3), the flag as the kill switch with the Missed
list readable (§8.1, §8.4), a credential disable that keeps its links (§8.2), inbound counted
apart in usage with carrier and hold time (§9). No migration.

**Fix pass round 2, Missed calls and the summary** (IQ36, IQ41, IQ42; `0030_inbound_reached_on_outcome.sql`; §7,
§8.4, §9, §11): an outbound call closes the customer's Missed rows on an outcome that says a
person was reached, not at its bridge (an answering machine no longer reads "Customer reached"),
the number matched by its digits; **Reopen** on a handled row; why a call was answered closed
(`closed_cause`), so the summary counts the kill switch and a number with no route apart from out
of hours and an inactive credential as not served; "Nobody free to answer" one meaning on the list,
its guide and the summary, with all lines busy apart; the flag-off notice says callers hear the
closed message and are still listed; the usage plan test plans over its own analysed rows.

P1 can be built and tested end to end against the mock Plivo carrier before P0 runs; P0's results
then correct the fixture. Contract changes run the mobile `agency_wire` `dart test` before commit
(root `CLAUDE.md`).
