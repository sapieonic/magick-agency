# Live call listening

Supervisors see the calls in progress in their account and listen in silently from the console.
Listen only: no whisper, no barge. The audio is forked from our own WebRTC bridge, in the process
that owns the call; the carrier is not involved, and a slow, failing or dropped listener never
affects the agent's or the customer's audio. Designed 2026-11-16 from the code, reviewed and locked
by Manas the same day; decisions LS1–LS14 below. Built in phases (§10): phase 1, the foundation,
is built; nothing a supervisor can use is yet.

Where things are: the socket's contract `packages/contracts/src/agency/listen.ts`, the console wire
`packages/contracts/src/api/agency/live-calls.ts`, refusals `packages/contracts/src/errors.ts` §7,
permission `agency.calls.listen` (`rbac.ts`), flags `agency_live_listen_enabled` and
`agency_live_listen_unrecorded` (`flags.ts`), migration `0047_listen_sessions.sql`, repository
`apps/server/src/db/repositories/agency/listen-session.repository.ts`, config `agency.listen`
(`apps/server/src/config/blocks/agency.ts`), metrics in `packages/observability/src/metrics/agency.ts`
and `voice.ts`, alert group `listen` (`grafana/terraform/alert-rules.tf`).

## 1. Decisions

Status words as in [`decisions.md`](decisions.md). LS1–LS13 are the locked design (Manas,
2026-11-16); LS14 collects the calls phase 1 made where the design was silent.

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

## 2. Architecture

Five pieces, each in the module area that owns its kind of work:

1. **The tap** (`apps/server/src/core/bridge/listen-tap.ts`, voice; phase 2): per bridge session, a
   fan-out of both legs to its listeners' sinks, normalised to A-law 8 kHz in 20 ms frames.
2. **The bridge seam** (phase 2): a new `WebRtcBridgeManager` member
   `openListenTap(callId, sink): ListenTapHandle | { refused: 'not_found' | 'not_bridged' | 'ending' }`
   (types in `core/bridge/bridge-types.ts`), changed in one commit with `docs/seams.md` §3.1 and the
   seam contract tests.
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

Declared in phase 1; nothing emits them until phases 2 and 3.

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

## 10. Status

| Phase | What | Status |
|---|---|---|
| 1 | Foundation: the permission, both flags, the socket and console contracts, the refusal codes, `0047_listen_sessions.sql` and its repository, the retention sweep, the audit actions and resource type, `agency.listen` config, the metric declarations, the alert group and dashboard row, this document | **Built** (2026-11-16) |
| 2 | The tap and the bridge seam: `listen-tap.ts`, `openListenTap` with `docs/seams.md` §3.1 and the seam contract tests, `LISTENER_LIMITS`, the fault budget, the sampled relay dwell, fault-injection tests | Not built yet |
| 3 | The server side: `ListenRegistry`, `ListenTokenStore`, the listener socket, the four routes and two internal handlers with their guards (route tables, agent reach, owners, `wsOwner`, `ws-limits`, the rate-limit bucket, `token` redaction), revocation over IPC, the re-check, the boot and worker reaps, the audit writes, the call detail's `listen_sessions` | Not built yet |
| 4 | The console: Live calls page and campaign view, `LiveCallsTable`, `ListenBar`, `useListenSession`, `useListenPlayback`, "Listened to by" on the call page | Not built yet |
| 5 | The agent's standing line (LS2) on the console station and the mobile station info sheet | Not built yet |
| 6 | The inbound notice's words and its regenerated WAV (LS1) | Not built yet |

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
