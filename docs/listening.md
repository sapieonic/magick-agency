# Live call listening

Supervisors see the calls in progress in their account and listen in silently from the console.
Listen only: no whisper, no barge. The audio is forked from our own WebRTC bridge, in the process
that owns the call; the carrier is not involved, and a slow, failing or dropped listener never
affects the agent's or the customer's audio. Designed 2026-11-16 from the code, reviewed and locked
by Manas the same day; decisions LS1–LS15 below. Built in phases (§10): phase 1, the foundation,
and phase 2, the tap in the bridge and its seam member, are built, and so are the console (phase 4),
the agent's standing line (phase 5) and the inbound notice's monitoring words (phase 6); the
console works once the socket and routes it calls exist (phase 3).

Where things are: the socket's contract `packages/contracts/src/agency/listen.ts`, the console wire
`packages/contracts/src/api/agency/live-calls.ts`, refusals `packages/contracts/src/errors.ts` §7,
permission `agency.calls.listen` (`rbac.ts`), flags `agency_live_listen_enabled` and
`agency_live_listen_unrecorded` (`flags.ts`), migration `0047_listen_sessions.sql`, repository
`apps/server/src/db/repositories/agency/listen-session.repository.ts`, config `agency.listen`
(`apps/server/src/config/blocks/agency.ts`), metrics in `packages/observability/src/metrics/agency.ts`
and `voice.ts`, alert group `listen` (`grafana/terraform/alert-rules.tf`), the tap
`apps/server/src/core/bridge/listen-tap.ts`, the seam member `WebRtcBridgeManager.openListenTap`
(types in `core/bridge/bridge-types.ts`, `docs/seams.md` §3.1), `LISTENER_LIMITS`
(`apps/server/src/utils/ws-backpressure.ts`).

## 1. Decisions

Status words as in [`decisions.md`](decisions.md). LS1–LS13 are the locked design (Manas,
2026-11-16); LS14 collects the calls phase 1 made where the design was silent, LS15 phase 2's.

| ID | Decision | Status |
|---|---|---|
| LS1 | **Consent.** The flag `agency_live_listen_enabled` (scopes global, tenant, account; default **off**; client-exposed) is the consent gate: a tenant turns it on once callers are told calls may be monitored. Inbound: the standard recording notice becomes "This call may be recorded or monitored for quality and training purposes.", its WAV regenerated (phase 6). Outbound: the agent's script says it; no product change. Every live-call route answers `403 feature_disabled` while it is off, and the periodic re-check ends listens open when it goes off (`permission_revoked`). | **Decided** (Manas, 2026-11-16) |
| LS2 | **What the agent sees.** No live indicator in this build. While the flag is on, the agent station shows a standing line "Calls may be listened to by a supervisor for quality and training." on the console station (the header's info popover and the join screen) and on the mobile app's station info sheet (copy only, no wire change; the app reads the client-exposed flag). The live "Supervisor listening" pill is not built. | **Decided** (Manas, 2026-11-16) |
| LS3 | **Who.** A new permission `agency.calls.listen`, floor `account_admin` (tenant admins and owners pass by the hierarchy; an account admin in the accounts of their membership). The live list needs `agency.supervise`; a supervisor who may watch but not listen sees the list without the Listen action. Agents, viewers, operators and super-admins cannot listen. Listening to a call you are the agent on is refused `listen_own_call`. Mobile supervisors are out of scope. | **Decided** (Manas, 2026-11-16) |
| LS4 | **Calls that are not recorded.** The flag `agency_live_listen_unrecorded` (scopes global, tenant, account; default **on**; not client-exposed). On: an unrecorded call (`agency_calls.recording_requested` false, RC1) is listenable like any other, and its row shows "Recording off". Off for the call's tenant or account: the row shows "Recording off", Listen is disabled with "Listening is turned off for unrecorded calls", and the grant answers `409 listen_recording_off`. | **Decided** (Manas, 2026-11-16) |
| LS5 | **Scale and placement.** At most 2 listeners per call (`AGENCY_LISTEN_MAX_PER_CALL`, 1–5), 1 listen per supervisor (a second ends the first `superseded`), 20 per process (`AGENCY_LISTEN_MAX_PER_PROCESS`). Expected peak: 100 calls at once, 5–6 supervisors. The tap runs in the process that owns the call (a media worker when `MEDIA_WORKERS >= 1`): no listen worker, no audio over IPC. | **Decided** (Manas, 2026-11-16) |
| LS6 | **The supervisor is told, and every listen is recorded.** The listening bar always shows "This session is logged. Do not record or share what you hear." (not dismissible). A first-use confirmation per browser: "Listening is logged" / "Each time you listen, your name, the call and the start and end times are recorded in the activity history." / Cancel, Start listening. Each listen is one `agency_listen_sessions` row and two audit rows, `agency_call.listen_started` and `agency_call.listen_ended` (resource type `agency_call`, ids only, `campaign_id` set so they show on the campaign's History). | **Decided** (Manas, 2026-11-16) |
| LS7 | **Fail closed on the way in.** If the grant, the token or the session row's insert fails, the socket is refused with a reason the bar can show: no row, no audio. A failed audit write is logged and counted; the row is the record. | **Decided** (Manas, 2026-11-16) |
| LS8 | **The tap never touches the call.** It is a nullable field on the bridge session (one field read per frame with nobody listening, as `CarrierTap`), fed after the relay write in a guarded tail that also runs when the leg gate returns early, so the relay's dwell excludes it. It owns its codec instances (session codecs keep FIR history and are never called twice for a frame). Every entry point (each leg, each sink) is wrapped: a failing decode, encode or framing step drops that frame and counts it; 50 failures in a row (`AGENCY_LISTEN_FAULT_BUDGET`, one second) detach the tap and close its listeners `tap_error`; the call carries on. One bad listener stays one: a throwing send or a closed socket removes only that sink. Back-pressure reads only the listener's own socket: soft 48 KiB drops and counts, hard 256 KiB closes it `send_backlog` (4408). Nothing awaits. | **Decided** (Manas, 2026-11-16) |
| LS9 | **Numbers are masked.** The live list masks the customer's number (`****1234`, `maskPhone`). Each row's Show/Hide fetches the full number on demand (`GET /proxy/agency/live-calls/:callId/number`, `agency.supervise`, flag-gated, tenant and account scoped); it is never in the polled list and is masked again on leaving the page. Not audited: supervise holders already see full numbers elsewhere. | **Decided** (Manas, 2026-11-16) |
| LS10 | **Revocation.** Immediate on a role change or a member's removal (the routes that clear the membership cache call `revokeUser(tenantId, userId)`, sent to media workers as IPC `listen.revoke`); otherwise within 30 s (`AGENCY_LISTEN_RECHECK_MS`) through a re-check that reads the membership floor from the database, not the cache, and the two flags. Both end the listen `permission_revoked`. The lag is accepted. | **Decided** (Manas, 2026-11-16) |
| LS11 | **The wire.** A binary message is one tag byte (`0x01` customer, `0x02` agent) and 160 bytes of A-law (20 ms), built once per frame per call and sent to each listener. Text frames are control only. No mixing on the server: the browser mixes in WebAudio and never asks for the microphone. | **Decided** (Manas, 2026-11-16) |
| LS12 | **Retention.** `agency_listen_sessions` follows the platform audit log: its rows are deleted by the audit maintenance at the same cutoff (`AUDIT_RETENTION_DAYS`, default 85 days). | **Decided** (Manas, 2026-11-16) |
| LS13 | **Who listened, on the call.** The call detail pages get a "Listened to by" section (who, start–end, duration) read from `agency_listen_sessions` by call id, visible to `agency.supervise` holders like the rest of the call page. | **Decided** (Manas, 2026-11-16) |
| LS14 | **Phase 1's own calls.** (a) Refusal statuses: `listen_call_not_live` 404 (uniform: an ended call and another account's look alike), `listen_recording_off`, `listen_limit_call`, `listen_own_call` 409, `listen_limit_server`, `listen_unavailable` 503. (b) The socket's close codes and the code each end reason closes with (§3). (c) The session table carries a CHECK that a listener is never the call's agent, a backstop under `listen_own_call`, and has no foreign keys (it outlives its call, campaign and users). (d) Its Down refuses while any row exists. (e) Retention ages a row by its start, open or not: an open row past 85 days can only be one a dead process left, which the boot reap closes long before. (f) The live row carries `inbound_route_name` for "Inbound: <route>", which the field list in the design did not name. (g) `AGENCY_LISTEN_MAX_PER_USER` is a setting (default 1, at most 5). (h) `webrtc_relay_dwell_seconds` samples one frame in 50 per call and direction. | **default, pending Manas** |
| LS15 | **Phase 2's own calls.** (a) The fault budget counts each leg's failed frames in a row apart: a dead customer leg is not kept attached by the agent's good frames. (b) A sink whose `send` throws, or answers `closed`, is ended `listener_disconnected` (4408, the console reconnects); `tap_error` is the budget only. (c) A sink's `frames_dropped` counts the frames it did not get: dropped at its soft limit, and the frames the tap failed while it was attached. (d) A call is listenable once the bridge has been announced (`bridged`: both legs live, the carrier's media negotiated), and stays so through the agent's re-attach window; a parked inbound caller, answered but with no agent bound, is `not_bridged`. (e) The tail of the customer leg needs the carrier's media negotiated and drops a payload too big to relay, as the relay does; an agent message the relay would refuse (not whole 20 ms frames) is not the tap's either. (f) During a VoiceLink hangup's wait for the carrier's confirmation (`ending`) a listener stays attached, hearing nothing, until the session is destroyed (`call_ended`); a new `openListenTap` is refused `ending`. (g) As on the station, media alone stops at the soft limit, so the hard cap (`send_backlog`) is reached only by other bytes queued on the listener's socket (its control frames); a listener that stops reading entirely is expected to be ended by its idle timeout (phase 3). | **default, pending Manas** |

## 2. Architecture

Five pieces, each in the module area that owns its kind of work:

1. **The tap** (`apps/server/src/core/bridge/listen-tap.ts`, voice; phase 2, built): per bridge
   session, a fan-out of both legs to its listeners' sinks, normalised to A-law 8 kHz in 20 ms
   frames (§5 "The tap as built").
2. **The bridge seam** (phase 2, built): the `WebRtcBridgeManager` member
   `openListenTap(callId, sink): ListenTapHandle | { refused: 'not_found' | 'not_bridged' | 'ending' }`
   (types in `core/bridge/bridge-types.ts`), pinned with `docs/seams.md` §3.1 by the seam contract
   tests.
3. **The listen runtime** (`apps/server/src/agency/listen/`, agency; phase 3): `ListenRegistry`
   (sessions, the caps, supersede, revoke, the periodic re-check), `ListenTokenStore` (single-use
   socket tokens in Redis, modelled on `StationTokenStore`) and `listen-socket.ts`.
4. **Routes** (phase 3): the list, the number reveal and the grant on the public layer, their
   internal handlers, and one WebSocket route.
5. **The record** (phase 1): the table `agency_listen_sessions` and the audit pair.

```
carrier socket ─ onPstnMessage ─ relay to the agent (unchanged) ─┐
                                                                 ├─ tap (customer leg) ─┐
station socket ─ onBrowserBinary / onBrowserMessage ─ relay to   │                      ├─ listener sockets
                 the carrier (unchanged) ────────────────────────┴─ tap (agent leg) ────┘
```

**Where it runs.** The process that owns the call: the primary with `MEDIA_WORKERS=0`, else the
media worker that owns the agent's session (the grant's internal handler is `session_param`-owned,
and the socket's upgrade is handed to that worker as the station's is, `wsOwner: { by: 'session',
param: 'sessionId' }`). No audio crosses IPC; only the revoke does (`listen.revoke`).

**What a frame costs.** VoiceLink with an `alaw8` agent is byte passthrough both ways: the tap
copies the frame behind a tag byte. A Plivo customer leg is μ-law and always transcoded for the
agent; the tap transcodes it again with its own codec (Plivo's codec to PCM16 16 kHz, then its own
`VoicelinkTranscoder.pcm16kToAlaw`), only while someone listens. A `pcm16` agent leg goes through
the tap's own PCM16 → A-law; an `alaw8` agent's messages (up to 1 s) are cut into 160-byte frames
by the tap's own `AlawFramer`. The listener socket sets TCP_NODELAY, as the station does.

**The browser** (phase 4): one `AudioContext`; per leg an `AlawDownlinkDecoder`, a scheduled-buffer
queue with about 120 ms of cushion, a gain and an analyser, into a master gain. It never asks for
the microphone.

## 3. Wire format

`GET /proxy/agency/listen/:sessionId/:listenId?token=…` (WebSocket), opened with the grant's
`ws_url`. Every constant below is declared once in `packages/contracts/src/agency/listen.ts`.

- **Binary, server → client**: `[tag][160 bytes A-law]` (`AGENCY_LISTEN_MESSAGE_BYTES` = 161), tag
  `AGENCY_LISTEN_LEG` (`customer` 1, `agent` 2). Both legs interleave as their own messages. A
  binary message from the client is ignored.
- **Text, server → client**: `ready { listen_id, call_id, format: 'alaw8', frame_bytes: 160 }` once,
  first, after the row is written and the tap attached; `ended { reason }` once, last, just before
  the close; `pong { ts?, server_ts }`.
- **Text, client → server**: `ping { ts? }` every 10 s (`AGENCY_LISTEN_PING_INTERVAL_MS`); `stop`.
  No frame for 30 s (`AGENCY_LISTEN_IDLE_TIMEOUT_MS`) ends the session `listener_disconnected`.

**End reasons** (`AGENCY_LISTEN_END_REASONS`, the column's CHECK): `call_ended`, `listener_stopped`,
`listener_disconnected`, `permission_revoked`, `superseded`, `send_backlog`, `tap_error`,
`server_shutdown`, `server_restarted` (closed by the reap; never sent on a socket).

**Close codes** (`AGENCY_LISTEN_CLOSE`) and what the console does:

| Code | Name | When | Console |
|---|---|---|---|
| 1000 | `NORMAL` | `call_ended`, `listener_stopped` | stop ("Call ended · you listened for mm:ss") |
| 1001 | `GOING_AWAY` | `server_shutdown` | reconnect |
| 4401 | `TOKEN_REJECTED` | at the upgrade: the token is missing, spent, expired or not this listen's | re-mint and retry |
| 4403 | `FORBIDDEN` | `permission_revoked` | stop ("You no longer have access to listen to calls.") |
| 4404 | `CALL_GONE` | at the upgrade: the call is no longer live in this process (`listen_call_not_live`) | stop |
| 4408 | `HEARTBEAT_TIMEOUT` | `listener_disconnected` (30 s silence), `send_backlog` | reconnect |
| 4409 | `SUPERSEDED` | `superseded` | stop ("Listening moved to another call.") |
| 4429 | `LIMIT` | at the upgrade: `listen_limit_call`, `listen_limit_server` | stop, with the reason |
| 1008 | `INVALID_UPGRADE` | a malformed upgrade | stop |
| 1011 | `INTERNAL_ERROR` | `tap_error`; at the upgrade, `listen_unavailable` (no row, no audio) | reconnect, bounded |

`AGENCY_LISTEN_END_CLOSE` maps every reason sent on a socket to its code. A refusal at the upgrade
carries its error code as the close `reason`; after `ready`, the end reason. Any other code is an
ordinary drop: the console re-mints and reconnects for up to 15 s
(`AGENCY_LISTEN_RECONNECT_WINDOW_MS`), each attach its own audited session, then shows "Connection
lost" with "Try again".

## 4. Lifecycle

**Start.**
1. `POST /proxy/agency/live-calls/:callId/listen`: session, tenant context, `agency.calls.listen`,
   the flag.
2. The public layer loads the `agency_calls` row scoped to the tenant and account, checks it is live
   and bridged (`agency_call_attempts.state='bridged'`, `agency_manual_calls.state='bridged'`,
   `agency_inbound_calls.state='connected'`), applies LS4 and the own-call rule, and resolves the
   agent's session from the spine row.
3. `callCore` → `POST /api/v1/agency/sessions/:id/listen-grants` (owner `session_param`): the bridge
   has the call, the caps hold; mint a single-use token (`AGENCY_LISTEN_TOKEN_TTL_MS`, 60 s).
4. Answer `AgencyListenGrant { listen_id, ws_url, expires_at }`.
5. The upgrade consumes the token, fail-closed.
6. Insert the `agency_listen_sessions` row and await it (LS7).
7. Open the tap, send `ready`, write `agency_call.listen_started`.

**End.** `stop` or a socket close removes the sink, closes the row (reason, frames sent and
dropped) and writes `agency_call.listen_ended`. The call's end (`session.destroy()` closes the tap)
sends `ended { call_ended }` and closes 1000. A second listen by the same supervisor ends the first
`superseded`. Shutdown ends every session `server_shutdown`. At boot, and when the primary reaps a
dead media worker, the open rows of the processes that are gone close `server_restarted` by
`replica_id` (`closeOrphansExcept`, `closeOrphans`).

**Revocation (LS10).** The role-change and member-removal routes (`api/routes/user.routes.ts`, where
the membership cache is cleared) call `listenRegistry.revokeUser(tenantId, userId)`, sent to media
workers as IPC `listen.revoke` (`cluster/ipc-protocol.ts`, `docs/scaling.md` §4.3). The backstop
re-checks every open session every 30 s against the database and the flags.

**The live list.** `GET /proxy/agency/live-calls?campaign_id=` (`agency.supervise`, the flag) →
`callCore` → `GET /api/v1/agency/live-calls` (owner `none`, SQL only): a union over the three live
spines on their live indexes (`idx_agency_attempts_live`, `idx_agency_manual_calls_live`,
`idx_agency_inbound_calls_account_live`) joined to `agency_calls`, the session and the contact, plus
the open `agency_listen_sessions` rows (`idx_agency_listen_sessions_open`). The public layer adds
names, masks numbers (LS9) and computes each row's `listenable` and `not_listenable_reason` for the
caller. The console polls it every 5 s while the page is visible.

## 5. Error handling

Required of the tap (LS8), with fault-injection tests (phase 2): a throwing codec, a throwing sink,
a socket that errors mid-send and one that never drains, each asserting both legs still get their
frames, the process stays up and the row closes with the right reason. A throw inside a `ws`
listener crashes the process (there is no `uncaughtException` handler), so every tap entry point is
wrapped and every listener socket has its `error` handler attached before anything else.

- **Fault budget:** a failed decode, encode or framing step drops the frame and counts it
  (`agency_listen_tap_errors_total{stage}`); `AGENCY_LISTEN_FAULT_BUDGET` (50) in a row detach the
  tap and close its listeners `tap_error`.
- **Back-pressure** (`LISTENER_LIMITS`, `utils/ws-backpressure.ts`): above 48 KiB unsent a frame is
  dropped for that listener and counted (`websocket_send_backpressure_total{socket="listener",
  action="media_dropped"}`); above 256 KiB the listener is closed `send_backlog` (4408). It reads
  only the listener socket's `bufferedAmount`.
- **Logs:** at most one line per listen per 10 s, with the call and listen ids only: no audio, no
  numbers.
- **On the way in:** fail closed (LS7). A refused grant is a toast with the reason; a refused
  upgrade closes with its code and reason (§3).

### The tap as built (phase 2)

**On the session.** `WebRtcBridgeSession.listenTap` is null until the first `openListenTap`, which
makes a `ListenTap` and adds the sink; later sinks join it. When its last sink goes (detached by its
owner or ended by the tap) or it fails its budget, the tap ends and the session drops the field, so
the next listener gets a fresh tap with fresh codecs. `destroy()` ends it `call_ended`. A re-attach
of the agent's socket keeps it (`adoptBorrowedBrowserLeg` resets only the agent leg's framer and
encoder, so a socket that chose another format is taken up).

**In the relay.** `onPstnMessage` (customer), `onBrowserMessage` (`pcm16` agent) and
`onBrowserBinary` (`alaw8` agent) each call the relay (`relayPstnMedia`, `relayBrowserPcm16`,
`relayBrowserAlaw`, the old bodies unchanged, `relayCarrierToAlawBrowser` inside the first) and then
a tail: `const listen = session.listenTap; if (listen !== null && …) listen.feed…(…)`. The tail runs
whether or not the relay wrote (the agent's socket inside its re-attach window, the carrier's
socket gated), and only after `recordRelayFrame`, so the dwell excludes the tap. With nobody
listening the tail is that one read: no codec, no tap call, no send.

**The legs.** Customer: the carrier's base64 payload decoded again by the tap; A-law on the wire
(VoiceLink) is copied; anything else goes through the tap's own `carrier.media.createCodec()` to
PCM16 16 kHz and its own `VoicelinkTranscoder.pcm16kToAlaw`. Agent: a `pcm16` frame through the
tap's own encoder; an `alaw8` message copied. Each leg has its own `AlawFramer`, so a 1 s agent
message is 50 messages and a carrier frame that is not whole 20 ms frames carries its tail. Each
frame is built once (`Buffer.allocUnsafe(161)`, tag then audio) and the same Buffer goes to every
sink.

**Sinks.** `ListenSink { listenId, send(message): 'sent' | 'dropped' | 'backlog' | 'closed',
close(reason, stats) }` (`bridge-types.ts`): `dropped` counts the frame against the sink, `backlog`
ends it `send_backlog`, `closed` or a throw ends it `listener_disconnected` (counted
`stage="send"`); the other sinks get the frame. `sendToListenerSocket(ws, message)` is the
socket-backed `send` phase 3's socket uses: `sendVerdict` under `LISTENER_LIMITS`, counting
`websocket_send_backpressure_total{socket="listener"}`, a throwing `ws.send` answered `closed`.
The handle's `stats()` and `close`'s second argument give `framesSent` and `framesDropped` for the
session row.

**Faults.** Every feed is one try/catch with its stage (`decode`: the base64 or the carrier codec;
`encode`: the A-law encoder; `frame`: the framer and the message), counted in
`agency_listen_tap_errors_total{stage}`. The leg's run of failures resets on its next good frame;
at `agency.listen.faultBudget` in a row every sink is ended `tap_error` and the tap detaches. A
fault line is logged at most once per tap per 10 s, with the call id, the listen ids, the leg, the
stage and the run; a sink ended by the tap gets one line. A throwing `close` or idle hook is caught.

**The relay's dwell.** `recordRelayFrame` records one frame in `RELAY_DWELL_SAMPLE_EVERY` (50) per
call and direction in `webrtc_relay_dwell_seconds{direction}`, from the per-direction frame counts
it already kept.

## 6. Data

**`agency_listen_sessions`** (`0047_listen_sessions.sql`; `packages/db/BASELINE.md`): `id` (the
listen id), `tenant_id`, `account_id`, `call_id` (no FK), `origin` (`AGENCY_CALL_ORIGINS`, the
same list as `ck_agency_calls_origin`), `campaign_id` (set for a dialler call), `correlation_id`
(the spine row), `agent_session_id`, `agent_user_id`, `listener_user_id`, `started_at`, `ended_at`
and `end_reason` (both or neither), `frames_sent`, `frames_dropped`, `replica_id`. No foreign keys.
Indexes: the open sessions per account (partial), by call, by supervisor newest first. The Down
refuses while any row exists. The repository (`AgencyListenSessionRepository`, via the agency
barrel): `open`, `close` (an open row only: the first close wins), `listOpenInAccount`,
`listOpenForCalls`, `listForCall`, `listOpenForListener`, `closeOrphans(replicaId)`,
`closeOrphansExcept(liveReplicaIds)`.

**Audit** (`audit/platform/catalog.ts`): `agency_call.listen_started` and `agency_call.listen_ended`,
resource type `agency_call` (the call's id), labelled "Supervisor started / stopped listening to a
call" on the Audit Log and "Supervisor started / stopped listening" on the campaign's History
(`agency-activity-actions.ts`), where `campaign_id` puts them. `details`: the listen id, the call's
origin and `correlation_id`, the agent's user id; `_ended` adds the duration, the end reason and the
frames dropped. The supervisor is the actor on both, whoever ended the session: the end reason says
why, and the campaign's History names who listened.

**Retention (LS12).** The audit maintenance (`audit/audit-partition-maintenance.ts`, daily) deletes
listen sessions that started before the audit cutoff (`AUDIT_RETENTION_DAYS`), in batches of 5000,
after it drops the audit partitions (`AUDIT_HORIZON_TABLES`, `purgeAuditHorizonRows`; its report
carries `horizonRowsDeleted`). The cutoff is the policy rather than the partitions' month rounding,
so a session row can go up to a month before the audit rows about it.

## 7. Permission, flags, config

- `agency.calls.listen`, floor `account_admin` (LS3); the list and the number need
  `agency.supervise`.
- `agency_live_listen_enabled` (default off, client-exposed, `FF_AGENCY_LIVE_LISTEN`) and
  `agency_live_listen_unrecorded` (default on, not exposed, `FF_AGENCY_LIVE_LISTEN_UNRECORDED`).
- `agency.listen` (`config/blocks/agency.ts`; `docs/operations.md` "Key settings"):

| Key | Env | Default | Range |
|---|---|---|---|
| `maxPerCall` | `AGENCY_LISTEN_MAX_PER_CALL` | 2 | 1–5 |
| `maxPerProcess` | `AGENCY_LISTEN_MAX_PER_PROCESS` | 20 | 1–200 |
| `maxPerUser` | `AGENCY_LISTEN_MAX_PER_USER` | 1 | 1–5 |
| `recheckMs` | `AGENCY_LISTEN_RECHECK_MS` | 30000 | 5000–300000 |
| `tokenTtlMs` | `AGENCY_LISTEN_TOKEN_TTL_MS` | 60000 | 5000–300000 |
| `faultBudget` | `AGENCY_LISTEN_FAULT_BUDGET` | 50 | 1–1000 |

## 8. Observability

Declared in phase 1. Emitted since phase 2: `agency_listen_tap_errors_total`,
`websocket_send_backpressure_total{socket="listener"}` and `webrtc_relay_dwell_seconds`; the rest
from phase 3.

| Series | Kind | Labels | What it says |
|---|---|---|---|
| `agency_listen_sessions_active` | gauge, per process | | sessions open now |
| `agency_listen_grants_total` | counter | `result` (`granted` or the refusal code) | grants and why they were refused |
| `agency_listen_sessions_ended_total` | counter | `reason` (the end reasons) | how sessions end |
| `agency_listen_session_seconds` | histogram | | how long a listen lasts (reaped sessions excluded) |
| `agency_listen_tap_errors_total` | counter | `stage` (`decode`, `encode`, `frame`, `send`) | frames the tap dropped |
| `websocket_send_backpressure_total` | counter | `socket="listener"`, `action` | listener frames dropped, sockets closed |
| `ws_handoff_total` | counter | `route="listen"`, `result` | listener upgrades handed to media workers |
| `webrtc_relay_dwell_seconds` | histogram, sampled 1 in 50 | `direction` (`b2p`, `p2b`) | the relay's per-frame dwell: the guard that the tap adds nothing |

Alerts (group `listen`, warn only; runbooks in [`operations.md`](operations.md) "Alert runbooks"):
`agy-listen-relay-dwell-regressed` (p99 above 5 ms for 15 min), `agy-listen-backlog-closes` (3+
`send_backlog` closes in 15 min), `agy-listen-grants-server-limit` (any refusal at the process
limit in 15 min), `agy-listen-tap-errors` (a sustained tap error rate). The dashboard's *Live call
listening* row charts each series above.

## 9. The console and the agent

British English throughout. **Live calls** at `/agency/live`, a nav entry in the Campaigns section
beside "Soft-phone calls" (gated by `agency.supervise` and the flag); a campaign's
`/agency/campaigns/:id/calls/live` with a "Summary | Live" control on its Calls tab. The table:
"Live calls", "N in progress", "Updated N s ago"; filters for campaign (account page only), agent
and type (All, Dialler, Soft phone, Inbound); columns Agent, Customer (name or "Unknown caller",
the masked number with Show/Hide), Campaign, Type, Time on call (amber past twice the average
handle time), Recording ("Recording" / "Recording off"), Listening, Action. Without
`agency.calls.listen`: no Action column and the footnote "You can see live calls but not listen to
them." Empty: "No calls in progress" / "Calls appear here as soon as an agent is connected to a
customer." Error: "Could not load live calls. Retrying…".

The **listening bar** (`ListenBar`) is docked at the bottom of the console shell and persists across
its pages: the live dot, "<Agent> with ****4321", the campaign and the timer; level meters and mutes
for Agent and Customer; volume (remembered per browser), "Open call", "Stop listening" (Esc while
focused); the notice of LS6, always. Its states are in the design (Connecting…, Live, sound
blocked, "Agent reconnecting…", "Reconnecting…" then "Connection lost", "Call ended · you listened
for mm:ss", revoked, moved). The call page gets "Listened to by" (LS13). The agent's station gets
the standing line of LS2.

**As built (phases 4 and 5).** Everything above, in these places:

- *Navigation.* `consoleNav.ts` (the Campaigns section's `live` tab, `/agency/live` among its
  paths), `agencyCampaignTabs.ts` (`CAMPAIGN_TABS` `live`, `group: null`, `flag:
  agency_live_listen_enabled`, `barTabFor('live')` → Calls; `CALLS_VIEWS` and `visibleCallsViews`
  for "Summary | Live", drawn by `components/agency/CallsViews.tsx` on both views),
  `consoleSearch.ts` (`PAGE_KEYWORDS` and `CAMPAIGN_TAB_KEYWORDS`: live, in progress, listen,
  monitor), `utils/agency/home.ts`, the routes in `App.tsx` behind `RequireFlag`, and
  `navRouteGates.test.ts`'s rules for both URLs. The flag's one name is
  `utils/listen/liveListenFlag.ts`.
- *Pages.* `pages/agency/live/LiveCallsPage.tsx` (h1) and
  `pages/agency/AgencyCampaignLiveCallsPage.tsx` (the campaign workspace, Calls marked, h2).
- *The table.* `components/listen/LiveCallsTable.tsx` over `hooks/listen/useLiveCalls.ts` (the
  read every 5 s while visible with `useVisibleInterval`, again on return, the server clock from
  `as_of`, a call that leaves the list kept 3 s as "Call ended", a 403 stops the poll and says
  so) and the pure rules in `utils/listen/liveCallsTable.ts`. Show/Hide calls
  `GET …/live-calls/:callId/number` per row and keeps the number in the table's state only, so
  leaving the page or the row ending masks it again. **Amber past twice the AHT** shows on the
  campaign view only, from the workspace's own stats read (`aht_seconds`): the live row carries no
  handle time and the account page would need a stats read per campaign, so it shows none.
- *The listen.* `components/listen/ListenProvider.tsx` (mounted by `ConsoleLayout` around the
  shell, keyed by the account, with `ListenBar` under `<main>`): one listen per shell, a second
  Listen stops the first, the first-use confirmation (`magick-agency.listen.confirmed` in browser
  storage), the toast for a refused first grant, the flag or the permission going away stopping it.
  `utils/listen/listenSessionReducer.ts` owns every state (idle, connecting, live, reconnecting,
  lost, ended with `call_ended` / `revoked` / `superseded` / `refused`; the 15 s window opened by
  the first drop and closed only by `ready` or Try again; three server failures (1011) in one
  recovery end it; a refused re-grant ends it, or is retried, by its code);
  `utils/listen/listenSessionController.ts` does what each state asks (mint, open in binary mode,
  ping every 10 s, `stop`, wait 0.25–3 s between attaches, dismiss "Call ended" after 6 s);
  `utils/listen/listenFrames.ts` reads the wire and maps each close code;
  `hooks/listen/useListenSession.ts` binds them to React. The audio is
  `utils/listen/listenPlayback.ts` (`ListenPlaybackEngine`: one 16 kHz `AudioContext`, per leg an
  `AlawDownlinkDecoder`, a queue re-based onto 120 ms after an underrun or past 600 ms ahead, an
  analyser then a gain (the meter reads before the mute), one master gain) under
  `hooks/listen/useListenPlayback.ts` (the mutes; the volume in `magick-agency.listen.volume`,
  every storage access in try/catch). "Agent reconnecting…" is the agent's leg silent over 2 s
  while live; "sound blocked" is the context not running, lifted by the banner's button.
- *The bar.* `components/listen/ListenBar.tsx`. At phone width (640 px) it is the live dot, the
  timer and Stop, and keeps the LS6 notice under them (the notice is never dismissible, so it is
  not dropped at any width). Esc anywhere inside the bar stops a listen (or dismisses an ended
  one). **"Open call"** opens the call's live view (its campaign's Live, else `/agency/live`): the
  live row carries the call's `agency_calls.id` but not the attempt or soft-phone call id the call
  pages are keyed on, so the call page itself cannot be linked from it.
- *Who listened.* `components/listen/ListenedToBy.tsx` on `AgencyAttemptCallPage` and
  `SoftphoneCallDetailPage`, from the detail's optional `listen_sessions` (the console's
  `AgencyAttemptCallDetail` and `WithListenSessions<AgencyManualCallDetail>`); a detail without
  the field, or with none, shows no section. The console has no inbound call page.
- *The agent (LS2).* `components/agency/StationListenNotice.tsx`: an info button in the station
  header (every station view: campaign, soft phone, inbound) opening the standing line; and the
  line on the campaign screen an agent joins from (`AgentHomePage`, `/dialer`; an agent with one
  campaign is taken straight to the station and reads it in the header). The mobile app: an info
  button in the station header (`lib/features/station/parts/banners.dart`: the idle, incoming and
  link screens; the on-call band has none) opens the station info sheet with the line, behind the
  client flag (`stationListenNoticeProvider`, `liveListenFlagKey`); no wire type changes.
- *Analytics.* `analytics/redact.ts` takes the listener socket's `token` out of any URL on its way
  to PostHog (`redactListenToken`).

## 10. Status

| Phase | What | Status |
|---|---|---|
| 1 | Foundation: the permission, both flags, the socket and console contracts, the refusal codes, `0047_listen_sessions.sql` and its repository, the retention sweep, the audit actions and resource type, `agency.listen` config, the metric declarations, the alert group and dashboard row, this document | **Built** (2026-11-16) |
| 2 | The tap and the bridge seam: `listen-tap.ts`, `openListenTap` with `docs/seams.md` §3.1 and the seam contract tests, `LISTENER_LIMITS`, the fault budget, the sampled relay dwell, fault-injection tests | **Built** (2026-11-16) |
| 3 | The server side: `ListenRegistry`, `ListenTokenStore`, the listener socket, the four routes and two internal handlers with their guards (route tables, agent reach, owners, `wsOwner`, `ws-limits`, the rate-limit bucket, `token` redaction), revocation over IPC, the re-check, the boot and worker reaps, the audit writes, the call detail's `listen_sessions` | Not built yet |
| 4 | The console: Live calls page and campaign view, `LiveCallsTable`, `ListenBar`, `useListenSession`, `useListenPlayback`, "Listened to by" on the call page | **Built** (2026-11-16), against the contracts; live once phase 3's routes exist (§9 "As built") |
| 5 | The agent's standing line (LS2) on the console station and the mobile station info sheet | **Built** (2026-11-16) |
| 6 | The inbound notice's words and its regenerated WAV (LS1) | **Built** (2026-11-16): `AGENCY_INBOUND_STANDARD_WORDS.recording_notice` is "This call may be recorded or monitored for quality and training purposes." and `apps/server/assets/inbound/recording-notice.wav` is regenerated from it with `scripts/generate-inbound-clips.ts --only recording_notice` and the pinned voice (8 kHz mono PCM16, 5.0 s); the other six recordings are unchanged. The carrier never speaks the notice (its `<Speak>` covers closed, busy and call-back only), so the WAV is the only other copy of the words |

## 11. Tests

- Contracts: `packages/contracts/test/rbac.test.ts` (the floor, nobody below `account_admin`),
  `flags.test.ts`, `errors.test.ts` (the listen codes' snapshot, their overlap with the other
  unions, the live row's reasons as a subset), `exports.test.ts` (the socket's vocabularies, wire
  sizes and close codes, and the console re-exports), `agent-fixtures.test.ts` (the client flag
  map fixture).
- DB: `packages/db/test/integration/db/listen-sessions-migration.test.ts` (shape, every CHECK both
  ways, each stored list against the contract's and `ck_agency_calls_origin`, the indexes and their
  plans on analysed data, the Down's refusal, down then up), `baseline.test.ts`,
  `baseline-down-up.test.ts`.
- Server: `test/integration/agency/listen-session-repository.test.ts` (every method on real
  Postgres, scopes, the close's once-only rule and race, the reaps),
  `test/unit/audit/audit-partition-maintenance.test.ts` and
  `test/integration/audit/audit-partition-maintenance.test.ts` (the retention sweep),
  `test/unit/config/config.test.ts` (`agency.listen`), `test/unit/feature-flags/registry.test.ts`,
  `test/unit/agency/agency-activity-actions.test.ts` (the campaign History offers both actions),
  `test/unit/audit/platform/catalog.test.ts` and `vocabulary.test.ts`,
  `test/unit/agency/listen/listen-metric-vocabulary.test.ts` (the metric labels against the
  contract).
- Observability: `test/metrics-agency.test.ts` and its instrument snapshot. Grafana:
  `pnpm test:grafana`.
- The tap (phase 2): `apps/server/test/unit/core/webrtc-bridge-listen-tap.test.ts` (both legs byte
  for byte on passthrough and framed, a 1 s agent message as 50; the μ-law customer and the `pcm16`
  agent on the tap's own codecs with the session's codec called once per frame; no tap, no extra
  call; the tail after `recordRelayFrame` and the dwell samples unchanged by two listeners; the
  tail when the leg gate returns early; soft and hard limits on the listener's socket; a throwing
  codec, encoder, framer, sink and close, a socket that errors mid-send or closes, one that never
  drains, each with both legs relayed and the right end reason; the budget at exactly N in a row,
  reset by a success, per leg; `call_ended` at the end; the re-attach keeping the tap; the
  refusals), `webrtc-bridge-seam-contract.test.ts` (the member and its types),
  `webrtc-bridge-manager.seams.test.ts` (the refusals and the handle through a VoiceLink call's
  life), `webrtc-bridge-inbound-connect.test.ts` (a parked caller `not_bridged`; after the bind,
  both legs through the tap on the real Plivo codec).
- The console (phases 4 and 5), under `apps/console/src/__tests__/`:
  `utils/listen/listenFrames.test.ts` (the parser, every close code, the `ended` reasons that end a
  session), `utils/listen/listenSessionReducer.test.ts` (every transition, stale attempts, the
  window, the bound, Try again, the bar's flags), `utils/listen/listenSessionController.test.ts`
  (grant → socket → ready, audio only while live, ping, stop, supersede, destroy, reconnect, the
  window, an unopenable socket), `utils/listen/listenPlayback.test.ts` (the cushion, per-leg queues
  and decoders, the graph, mute, volume, level, silence, blocked, reset, close, no microphone in
  use or in the source), `utils/listen/liveCallsTable.test.ts` (sort, filters, ended rows, amber,
  the target, the words), `api/liveCalls.test.ts`, `components/LiveCallsTable.test.tsx`,
  `components/ListenBar.test.tsx` (the confirmation, every bar state, Esc, mutes, the remembered
  volume with storage blocked, the toast, a second listen, the account switch, unmount, phone
  width), `components/listenSurfaces.test.tsx` (the station popover, the join screen's line,
  "Listened to by", "Summary | Live"), `pages/LiveCallsPages.test.tsx`, and the navigation guards
  (`navRouteGates`, `consoleNav`, `consoleSearch`, `agencyCampaignTabs`), `analytics/redact.test.ts`.
  Mobile: `apps/mobile/test/features/station/station_listen_notice_test.dart`.
- The notice's words (phase 6): `packages/contracts/test/inbound-route-warnings.test.ts` (the
  sentence word for word, as its WAV says it), `apps/console/src/__tests__/pages/InboundRoutes.test.tsx`
  (the route editor quotes it), `apps/server/test/unit/agency/inbound/inbound-standard-clips.test.ts`
  (the regenerated WAV's format, length and headroom).
