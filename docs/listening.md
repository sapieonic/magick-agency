# Live call listening

Supervisors see the calls in progress in their account and listen in silently from the console.
Listen only: no whisper, no barge. The audio is forked from our own WebRTC bridge, in the process
that owns the call; the carrier is not involved, and a slow, failing or dropped listener never
affects the agent's or the customer's audio. Designed 2026-11-16 from the code, reviewed and locked
by Manas the same day; decisions LS1–LS17 below. Built in phases (§10): phase 1, the foundation,
phase 2, the tap in the bridge and its seam member, phase 3, the server side (the routes, the
listener socket, the registry, revocation), the console (phase 4), the agent's standing line
(phase 5) and the inbound notice's monitoring words (phase 6) are built, and the load check has
run (§10 "Load check").

Where things are: the socket's contract `packages/contracts/src/agency/listen.ts`, the console wire
`packages/contracts/src/api/agency/live-calls.ts`, refusals `packages/contracts/src/errors.ts` §7,
permission `agency.calls.listen` (`rbac.ts`), flags `agency_live_listen_enabled` and
`agency_live_listen_unrecorded` (`flags.ts`), migration `0047_listen_sessions.sql`, repository
`apps/server/src/db/repositories/agency/listen-session.repository.ts`, config `agency.listen`
(`apps/server/src/config/blocks/agency.ts`), metrics in `packages/observability/src/metrics/agency.ts`
and `voice.ts`, alert group `listen` (`grafana/terraform/alert-rules.tf`), the tap
`apps/server/src/core/bridge/listen-tap.ts`, the seam member `WebRtcBridgeManager.openListenTap`
(types in `core/bridge/bridge-types.ts`, `docs/seams.md` §3.1), `LISTENER_LIMITS`
(`apps/server/src/utils/ws-backpressure.ts`), the listen runtime `apps/server/src/agency/listen/`
(`listen-registry.ts`, `listen-token.ts`, `listen-socket.ts`, `listen-access.ts`,
`listen-revocation.ts`), the routes `apps/server/src/api/routes/proxy-agency-live-calls.routes.ts`
and `proxy-agency-listen.routes.ts`, the internal handlers `api/routes/agency/live-calls.ts`, the
live list's SQL `db/repositories/agency/live-call.repository.ts`, IPC `listen.revoke`
(`cluster/ipc-protocol.ts`).

## 1. Decisions

Status words as in [`decisions.md`](decisions.md). LS1–LS13 are the locked design (Manas,
2026-11-16); LS14 collects the calls phase 1 made where the design was silent, LS15 phase 2's,
LS16 phase 3's, LS17 the voice review's; LS18–LS20 record the product owner's decisions on the persona review (Manas, 2026-11-16).

| ID | Decision | Status |
|---|---|---|
| LS1 | **Consent.** The flag `agency_live_listen_enabled` (scopes global, tenant, account; default **off**; client-exposed) is the consent gate: a super-admin turns it on for a tenant or an account once its callers are told calls may be monitored (under its handling policy and the enablement checklist, LS20). Inbound: the standard recording notice becomes "This call may be recorded or monitored for quality and training purposes.", its WAV regenerated (phase 6). Outbound: the agent's script says it; no product change. Every live-call route answers `403 feature_disabled` while it is off, and the periodic re-check ends listens open when it goes off (`permission_revoked`). | **Decided** (Manas, 2026-11-16) |
| LS2 | **What the agent sees.** No live indicator in this build. While the flag is on, the agent station shows a standing line "Calls may be listened to by a supervisor for quality and training." on the console station (the header's info popover and the join screen) and on the mobile app's station info sheet (copy only, no wire change; the app reads the client-exposed flag). The live "Supervisor listening" pill is not built. | **Decided** (Manas, 2026-11-16) |
| LS3 | **Who.** A new permission `agency.calls.listen`, floor `account_admin` (tenant admins and owners pass by the hierarchy; an account admin in the accounts of their membership). The live list needs `agency.supervise`; a supervisor who may watch but not listen sees the list without the Listen action. Agents, viewers, operators and super-admins cannot listen. Listening to a call you are the agent on is refused `listen_own_call`. Mobile supervisors are out of scope. | **Decided** (Manas, 2026-11-16) |
| LS4 | **Calls that are not recorded.** The flag `agency_live_listen_unrecorded` (scopes global, tenant, account; default **on**; client-exposed since LS20, for the account's Settings line; the server still decides each row). On: an unrecorded call (`agency_calls.recording_requested` false, RC1) is listenable like any other, and its row shows "Recording off". Off for the call's tenant or account: the row shows "Recording off", Listen is disabled with "Listening is turned off for unrecorded calls", and the grant answers `409 listen_recording_off`. | **Decided** (Manas, 2026-11-16) |
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
| LS15 | **Phase 2's own calls.** (a) The fault budget counts each leg's failed frames in a row apart: a dead customer leg is not kept attached by the agent's good frames. (b) A sink whose `send` throws, or answers `closed`, is ended `listener_disconnected` (4408, the console reconnects); `tap_error` is the budget only. (c) A sink's `frames_dropped` counts the frames it did not get: dropped at its soft limit, and the frames the tap failed while it was attached. (d) A call is listenable once the bridge has been announced (`bridged`: both legs live, the carrier's media negotiated), and stays so through the agent's re-attach window; a parked inbound caller, answered but with no agent bound, is `not_bridged`. (e) The tail of the customer leg needs the carrier's media negotiated and drops a payload too big to relay, as the relay does; an agent message the relay would refuse (not whole 20 ms frames) is not the tap's either. (f) A call's listeners end `call_ended` as soon as the call starts to settle: when a hangup of ours starts VoiceLink's wait for the carrier's confirmation (`ending`, up to 45 s, through which the agent's socket stays bound and keeps sending its microphone) and at the top of the terminal teardown (`endCall`, before its awaits), so nothing either party says after the hangup reaches a listener; a new `openListenTap` is refused `ending` until the session is gone (`not_found`). Revised by the voice review: it first kept the listener attached through `ending`, and the agent's leg still fed it. (g) As on the station, media alone stops at the soft limit, so the hard cap (`send_backlog`) is reached only by other bytes queued on the listener's socket (its control frames); a listener whose every frame has been dropped at the soft limit for 10 s is ended `send_backlog` too (LS17 b), so one that stopped reading but keeps pinging is not kept for ever. | **default, pending Manas** |
| LS16 | **Phase 3's own calls.** (a) The grant's internal handler is `POST /api/v1/agency/listen-grants` (owner `body_session`, the agent's session in `session_id`), not `/sessions/:id/listen-grants`: every `/sessions/:id` route is the session's own agent's (Q8, `requireOwnedSession`, held by `left-session-guards.test.ts`), and a grant is a supervisor's on someone else's session. Its `ws_url` is minted at the public path (there is no internal socket path to rewrite). (b) At the upgrade the caps are reserved BEFORE the row is written, so a refused attach (4429) leaves no row; a call the bridge no longer holds once the row is written closes that row `call_ended` (4404 `listen_call_not_live`), with no audit pair (it never started). (c) `revokeUser` re-checks the supervisor's sessions against the database (the periodic re-check's question) rather than ending them outright: a role change that still clears `agency.calls.listen` (a promotion, another membership) ends nothing. This immediate path fails CLOSED: a session it cannot check (a read that throws) ends `permission_revoked` too; the supervisor can ask again, and the grant and the upgrade check again. (d) The periodic pass fails OPEN, with a staleness cap: a session whose check cannot be made keeps going, but one not verified for 4 × `AGENCY_LISTEN_RECHECK_MS` (2 min at the defaults; `STALE_AFTER_RECHECKS`) ends `permission_revoked`, whether its checks fail or a pass hangs. A flag store that cannot be read is such a failure, not a flag value: both flags are read through `FeatureFlagService.strictSnapshot` (a read failure rejects; the registry defaults would end every listen through `agency_live_listen_enabled`, default off, and open LS4 through `agency_live_listen_unrecorded`, default on), and the grant answers it `503 listen_unavailable`. Coordinator decision of the server review, 2026-11-16. (e) One listen per supervisor across processes: a listen admitted in one media worker ends the supervisor's older listens in the others (`listen.revoke` `superseded`, naming the listen ids, worker → primary → the other workers); the primary holds no listen while workers run. (f) The list's `listenable` is computed from the open rows (every process); the grant's handler and the upgrade check the owning process's registry; a supervisor's own open listen on a call never counts against them (a reconnect supersedes it). (g) In one process, as HTTP closes the WebSocket plugin closes every socket first (no code: the console reconnects, as for 1001), then the listens end `server_shutdown` with their rows closed, so no `ended` frame goes out; a media worker ends its listens before its app closes (`ended { server_shutdown }`, 1001). (h) The listener socket reads at most 256 bytes a message (`LISTEN_MAX_CLIENT_MESSAGE_BYTES`); a longer message, a binary one or one that does not parse is ignored and does not count as liveness. (i) The live row's `aht_seconds` is the campaign stats' `aht_seconds` (one SQL fragment, `ahtSecondsSql`), read at most once a minute per campaign per process. (j) A withheld inbound number masks as `****`. (k) `listen_sessions` is on the campaign attempt read and the soft-phone call read (the two pages with "Listened to by"), absent when it could not be read; the inbound call read is unchanged. (l) `agency_listen_grants_total` counts the HTTP grant's outcomes; refusals at the upgrade are in the logs and the rows, not that counter. (m) `AgencyLiveCall` gained `correlation_id` (the spine row, for "Open call") and `aht_seconds` (additive, asked for by the console phase). (n) The upgrade asks the database too, after the reservation and before the row (`ListenRegistry.verify`, the re-check's question): 4403 `permission_revoked` if the supervisor may no longer listen, 1011 `listen_unavailable` if it cannot say; and a per-supervisor revocation generation, bumped by every `revokeUser` in that process (a promotion too), is recorded in the grant's token and again in the reservation: a token minted before a revocation is refused at the reservation (4403), and a revocation between the reservation and the admission refuses the admission (the row just written closes `permission_revoked`, 4403, no audit pair). A flag turned off bumps nothing: the upgrade reads the flag, and a session already open ends on the next pass (LS10's lag for flags). (o) A row close that fails is retried with its own reason and counters on every re-check tick until it lands (at most 1,000 wait), and each tick sweeps this process's open rows that nothing here holds (no session, no reservation, no close in flight or queued) and that started over 60 s ago, closing them `server_restarted` (the contract's reason for a session that outlived its process's knowledge of it; it has no other): `listen/listen-rows.ts`, `closeOrphans(replicaId, { keep, minAgeMs })`. (p) A listen admitted in one worker supersedes only the supervisor's rows OLDER than its own (`started_at`, then id): two listens admitted at once in two workers end the older one, never both. (q) A stopping process refuses a grant and an upgrade `listen_unavailable` (503, 1011: try again, a fresh grant reaches the process that owns the call), not `listen_limit_server`, which is the server's cap and feeds its alert. (r) `maxPerUser` counts a supervisor's listens per tenant: a user id is global, a listen belongs to its tenant, so a supervisor with memberships in two tenants may hold one in each. (s) Retention (LS12) follows the audit partitions rather than the exact cutoff: a session row goes when it started before the first instant of the cutoff's UTC month, the boundary below which the maintenance has dropped every audit partition, so it goes the same day as its month's audit rows. (t) The super-admin role change and member removal (`api/routes/super-admin/tenants.ts`) call `revokeListens` too, after their cache delete. (u) The live list's AHT cache holds at most 1,000 campaigns per process, dropping entries past their minute as it reads; the dialler spine reads the account's live attempts on `idx_agency_attempts_account_live` (pinned by `test/integration/agency/live-call-plan.test.ts`). (v) The handoff's refusal log lines carry the upgrade's URL redacted (`redactSpanUrl`): a station or listener token is unspent there. | **default, pending Manas** |
| LS17 | **The voice review's calls.** (a) A μ-law customer (Plivo, `wireFormat: 'mulaw8'`) reaches the tap's listeners through a 256-entry μ-law → A-law table (`MULAW_TO_ALAW`: each code decoded and encoded as A-law, the G.711 per-sample conversion bit for bit), not through the tap's own carrier codec and A-law encoder as §2 first said: both are 8 kHz, so the codec path's two resampling filters only cost CPU and a frame of lag (its first output is 144 bytes) and soften the top of the band; the table's A-law is at least as close to what the caller sent on tones from 300 Hz to 3.4 kHz. A carrier with no G.711 law keeps the codec path. A transcoded leg's first output is led by A-law silence to a whole frame (8 bytes, 1 ms, for 20 ms of `pcm16`), so it runs carry-free. (b) A listener whose every frame has been dropped at the soft limit for `LISTENER_SOFT_LIMIT_MAX_MS` (10 s), with none sent between, is ended `send_backlog` (4408), counted `websocket_send_backpressure_total{socket="listener",action="closed"}`, its last frame counted dropped too; measured on `bufferedAmount` as `ws` sees it, a constant rather than a setting. (c) A failed message counts its 20 ms frames (a failed 1 s agent message is 50) in the sink's `frames_dropped` and the leg's fault budget; `agency_listen_tap_errors_total` counts failed steps. (d) The alert on the tap's cost is `agy-listen-loop-delay` (event-loop delay p99 above 40 ms for 10 min while listens are open), replacing `agy-listen-relay-dwell-regressed`: the dwell excludes the tap by construction, and the load check saw the tap's cost on the loop only. | **default, pending Manas** |
| LS18 | **The inbound consent gap is accepted, and closed by the checklist.** The inbound notice plays only on a recorded call (the route records and the account allows recording) whose route has its notice on, while an unrecorded call can be listened to by default (LS4): a caller on a route that does not record, has its notice off, or plays a custom notice clip that says only "recorded" is not told the call may be monitored. Left as it is: tenants own their route settings, and the product neither changes nor blocks them. The enablement checklist ([`operations.md`](operations.md) "Enabling live call listening for a tenant", item 2, with the query that lists such routes) makes it an explicit step before the flag goes on: every inbound route that should be monitorable plays a notice that mentions monitoring, or `agency_live_listen_unrecorded` is turned off for that tenant or account. | **Decided** (Manas, 2026-11-16) |
| LS19 | **The account's listening history.** An account-level "Listening history" (who listened, the agent, the call type, the masked customer, start, time listened, how it ended in words, a link to the call where one exists; filters for supervisor, agent and date range; CSV), and readable listen rows on a campaign's History. Gate: `agency.supervise` and `agency_live_listen_enabled`. Built server side (§12): (a) `GET /proxy/agency/listen-history` and `.csv` through the internal `GET /api/v1/agency/listen-history` (owner `none`), account scoped, keyset-paged newest first; (b) a supervisor's sessions on one call are merged into one entry ON THE SERVER, in the history's SQL, while each starts at most `AGENCY_LISTEN_HISTORY_MERGE_GAP_MS` (30 s, twice the console's reconnect window) after every earlier one ended or while one is still open, so the page and the CSV show the same entries; the time listened counts overlaps once and gaps not at all; the date range filters sessions by their start before the merge; (c) the CSV carries masked numbers only ("Withheld" for a withheld caller) and is audited `agency_listen_sessions.exported` (the actor, the filters, the rows, any truncation; resource type `account`), as every bulk export here is; at most 10,000 entries and 30 s, past either cut and marked (`X-Export-Truncated`); (d) the words for each end reason are the contract's `AGENCY_LISTEN_END_REASON_LABELS`, shared by the page and the CSV; (e) a campaign History listen row carries `detail.agent_name`, resolved at the read in the page's one identity read (never written to the audit row). The page itself is the console's to build. | **Decided** (Manas, 2026-11-16); (a)–(e) are the build's calls, **default, pending Manas** |
| LS20 | **Guard rails on the consent gate.** All three: (a) a handling policy on `agency_live_listen_enabled` in the super-admin flag routes (`feature-flags/flag-policies.ts`, served as the catalog's `policy` and enforced on every write): turning it on for a tenant or account needs a reason (`400 flag_reason_required`); the bulk rollout refuses it (`422 flag_bulk_not_allowed`), and so does a GLOBAL On, which is every tenant at once (a global Off, the kill switch, stays allowed; the super-admin registry says why instead of asking for a reason); the super-admin UI's warning, reason dialog and bulk list already read the policy; (b) the enablement checklist in [`operations.md`](operations.md) (LS18's inbound item included); (c) a read-only line in the account's Settings, "Live call listening: On / Off", whether calls that are not recorded are included, and "Ask your account manager to change this.": served by making `agency_live_listen_unrecorded` client-exposed, so the console reads both flags from the client flag map (`GET /feature-flags`) as it already reads `agency_live_listen_enabled` for the Live calls page and the agent's line, rather than a new settings read; the server still computes `listenable` and refuses the grant itself. The global-On refusal (a) and the choice in (c) are the build's calls. | **Decided** (Manas, 2026-11-16); the calls in (a) and (c) **default, pending Manas** |

## 2. Architecture

Five pieces, each in the module area that owns its kind of work:

1. **The tap** (`apps/server/src/core/bridge/listen-tap.ts`, voice; phase 2, built): per bridge
   session, a fan-out of both legs to its listeners' sinks, normalised to A-law 8 kHz in 20 ms
   frames (§5 "The tap as built").
2. **The bridge seam** (phase 2, built): the `WebRtcBridgeManager` member
   `openListenTap(callId, sink): ListenTapHandle | { refused: 'not_found' | 'not_bridged' | 'ending' }`
   (types in `core/bridge/bridge-types.ts`), pinned with `docs/seams.md` §3.1 by the seam contract
   tests.
3. **The listen runtime** (`apps/server/src/agency/listen/`, agency; phase 3, built): `ListenRegistry`
   (sessions, the caps, supersede, revoke, the periodic re-check), `ListenTokenStore` (single-use
   socket tokens in Redis, modelled on `StationTokenStore`) and `listen-socket.ts` (§4 "As built").
4. **Routes** (phase 3, built): the list, the number reveal and the grant on the public layer, their
   internal handlers, and one WebSocket route.
5. **The record** (phase 1): the table `agency_listen_sessions` and the audit pair.

```
carrier socket ─ onPstnMessage ─ relay to the agent (unchanged) ─┐
                                                                 ├─ tap (customer leg) ─┐
station socket ─ onBrowserBinary / onBrowserMessage ─ relay to   │                      ├─ listener sockets
                 the carrier (unchanged) ────────────────────────┴─ tap (agent leg) ────┘
```

**Where it runs.** The process that owns the call: the primary with `MEDIA_WORKERS=0`, else the
media worker that owns the agent's session (the grant's internal handler is `body_session`-owned,
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
3. `callCore` → `POST /api/v1/agency/listen-grants` (owner `body_session`, LS16 a): the bridge
   has the call, the caps hold; mint a single-use token (`AGENCY_LISTEN_TOKEN_TTL_MS`, 60 s).
4. Answer `AgencyListenGrant { listen_id, ws_url, expires_at }`.
5. The upgrade consumes the token, fail-closed, reserves a slot under the caps (LS16 b) at the
   supervisor's revocation generation, and asks the database whether they may still listen
   (LS16 n).
6. Insert the `agency_listen_sessions` row and await it (LS7).
7. Open the tap, admit (refused if the supervisor was revoked since step 5), send `ready`, write
   `agency_call.listen_started`.

**End.** `stop` or a socket close removes the sink, closes the row (reason, frames sent and
dropped) and writes `agency_call.listen_ended`. The call's end (`session.destroy()` closes the tap)
sends `ended { call_ended }` and closes 1000. A second listen by the same supervisor ends the first
`superseded`. Shutdown ends every session `server_shutdown`. At boot, and when the primary reaps a
dead media worker, the open rows of the processes that are gone close `server_restarted` by
`replica_id` (`closeOrphansExcept`); a live process's re-check tick retries its failed row closes
and closes its own rows it no longer holds (`closeOrphans`, LS16 o).

**Revocation (LS10).** The role-change and member-removal routes (`api/routes/user.routes.ts` and
the super-admin's `api/routes/super-admin/tenants.ts`, where the membership cache is cleared) call
`revokeListens(tenantId, userId)`: the registry's `revokeUser`, a re-check of that supervisor
against the database now that fails closed (LS16 c) and bumps their revocation generation (LS16 n),
and with media workers IPC `listen.revoke` to every worker (`cluster/ipc-protocol.ts`,
`docs/scaling.md` §4.3). The backstop re-checks every open session every 30 s against the database
and the flags, failing open up to the staleness cap (LS16 d).

**The live list.** `GET /proxy/agency/live-calls?campaign_id=` (`agency.supervise`, the flag) →
`callCore` → `GET /api/v1/agency/live-calls` (owner `none`, SQL only): a union over the three live
spines on their live indexes (`idx_agency_attempts_live`, `idx_agency_manual_calls_live`,
`idx_agency_inbound_calls_account_live`) joined to `agency_calls`, the session and the contact, plus
the open `agency_listen_sessions` rows (`idx_agency_listen_sessions_open`). The public layer adds
names, masks numbers (LS9) and computes each row's `listenable` and `not_listenable_reason` for the
caller. The console polls it every 5 s while the page is visible.

### As built (phase 3)

**The routes** (`api/routes/proxy-agency-live-calls.routes.ts`, under `/proxy/agency`): the session,
the tenant context, the permission (`agency.supervise` for the list and the number,
`agency.calls.listen` for the grant), then the flag (`403 feature_disabled`; a flag store that
cannot be read is `503 listen_unavailable` on every route, which the console retries, never the
403 it treats as final), an account
(`X-Account-Id`, else 400), a malformed call id the uniform `404 listen_call_not_live` (a malformed
`campaign_id` a 400). The list and the number read the internal `GET /api/v1/agency/live-calls`
(owner `none`; `?campaign_id=`, `?call_id=`): `AgencyLiveCallRepository.listLive`, the three spines
on their live indexes joined to `agency_calls` (the spine's `webrtc_call_id`), the session, the
campaign, the inbound route and the contact, tenant and account scoped in each spine and again on
the leg; the open sessions of those calls (`listOpenForCalls`); each campaign's AHT. The public layer
adds the agent's and the listeners' names (`agentNamesOrNone`), masks the number (`maskPhone`) and
computes `listenable` / `not_listenable_reason` for the caller (`notListenableReason`: their own
call, LS4, the per-call cap not counting their own listen). The grant reads the same internal list
for the one call, refuses `listen_own_call` and `listen_recording_off` itself, then `callCore`s
`POST /listen-grants`, which the media-worker injector forwards to the session's worker; that handler
checks its bridge holds the call (`getActiveCallIds`), asks the registry (`check`) and mints the
token (`ListenTokenStore.mint`: `<token>|<grant JSON>` under `agency:listen-token:<listenId>`, PX the
TTL). A refusal from the owning process keeps its status; anything else, or no answer, is `503
listen_unavailable`.

**The socket** (`api/routes/proxy-agency-listen.routes.ts`, `wsOwner: { by: 'session', param:
'sessionId', route: 'listen' }`; in the `station` rate-limit bucket; the `token` query redacted in
logs and spans like every `token=`): a non-UUID id 1008, no token 4401, no runtime 1011, then
`handleListenSocket` (`agency/listen/listen-socket.ts`): the `error` handler first; the token spent
(`consume`, a Lua GET-compare-DEL; a grant naming another session is refused 4401 too, and is spent);
the slot reserved (4429; 1011 `listen_unavailable` while stopping; 4403 `permission_revoked` for a
token from before a revocation); the database asked (4403, or 1011 when it cannot say, LS16 n); the
row written and awaited (1011 `listen_unavailable`); the tap opened (4404, the row closed
`call_ended`); admitted (a revocation since the reservation closes the row `permission_revoked`,
4403; else the supervisor's older listen ends `superseded`),
`ready`, `agency_call.listen_started`, the gauge. `ping` → `pong { ts?, server_ts }`, `stop` →
`listener_stopped`; 30 s without a control frame → `listener_disconnected` (4408); the client's
close → `listener_disconnected`, nothing sent. Every end runs once: the tap detached (or the tap's
own `close`, with its stats), `ended { reason }` and the reason's close code, the row closed with
`frames_sent` / `frames_dropped`, `agency_call.listen_ended` (duration, reason, frames dropped),
`agency_listen_sessions_ended_total{reason}` and `agency_listen_session_seconds`.

**The registry** (`agency/listen/listen-registry.ts`, `runtime.listen`, one per process): the caps
count open sessions and reservations; `revokeUser` (fails closed), the periodic `recheck` (every
`AGENCY_LISTEN_RECHECK_MS`, armed with the runtime or the worker's shard; fails open up to the
staleness cap) and the upgrade's `verify` ask `listen-access.ts` (the membership the tenant context
would pick, read from `memberships` in the database, at `agency.calls.listen`;
`agency_live_listen_enabled`; for an unrecorded call `agency_live_listen_unrecorded`; both flags from
one strict snapshot, `readListenFlags`), each supervisor and account read once a pass, a failed read
leaving its sessions unchecked; each tick then hands the rows' upkeep (`listen-rows.ts`,
`runtime.listenRows`) the ids it holds (LS16 o); `shutdown` ends every session `server_shutdown`
and admits nothing more (`listen_unavailable`).

**Across processes** (`agency/listen/listen-revocation.ts`): the role-change and member-removal routes
(and the super-admin's) call `revokeListens(tenantId, userId)`, whose handlers are the runtime's `revokeUser` (registered by
`startAgency`) and, with media workers, the primary's broadcast of `listen.revoke { reason:
'permission_revoked', listenIds: null }` (registered by `startMediaWorkers`). A worker that admits a
listen reads the supervisor's open rows and sends `listen.revoke { reason: 'superseded', listenIds }`
for those another replica holds past the cap, older than its own (LS16 p); the primary relays it to the other workers
(`media-cluster.ts`), which end exactly those.

**Sweeps and shutdown.** At boot (`AgencyRuntime.start`, before any listener can attach and before
any media worker exists) every open row of another replica closes `server_restarted`; when the
primary reaps a dead media worker, every open row of a replica not alive now does
(`closeOrphansExcept`). While a process runs, its re-check tick retries a failed row close and
closes its own rows it no longer holds (`closeOrphans`, LS16 o). Shutdown: the listener route's `preClose` (one process, LS16 g), the media
worker's shutdown before its app closes, and `AgencyRuntime.stop` / `stopShard` as a backstop.

**The call detail.** `GET /proxy/agency/campaigns/:id/attempts/:attemptId` and
`GET /proxy/agency/softphone/calls/:id` (with `agency.supervise`) add `listen_sessions`
(`AgencyCallListenSession[]`, `callListenSessions` in `api/routes/helpers/listen.ts`).

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
  action="media_dropped"}`); above 256 KiB (about 16 s of both legs), or after 10 s in which every
  frame was dropped (`LISTENER_SOFT_LIMIT_MAX_MS`, LS17 b), the listener is closed `send_backlog`
  (4408). It reads only the listener socket's `bufferedAmount`.
- **Logs:** at most one line per listen per 10 s, with the call and listen ids only: no audio, no
  numbers.
- **On the way in:** fail closed (LS7). A refused grant is a toast with the reason; a refused
  upgrade closes with its code and reason (§3).

### The tap as built (phase 2)

**On the session.** `WebRtcBridgeSession.listenTap` is null until the first `openListenTap`, which
makes a `ListenTap` and adds the sink; later sinks join it. When its last sink goes (detached by its
owner or ended by the tap) or it fails its budget, the tap ends and the session drops the field, so
the next listener gets a fresh tap with fresh codecs. The call's settling ends it `call_ended`
(`endListenTap`): a VoiceLink hangup of ours as it enters `ending`, the terminal teardown at its top
(LS15 f), and `destroy()`. A re-attach of the agent's socket keeps it (`adoptBorrowedBrowserLeg`
resets only the agent leg's framer, encoder and priming, so a socket that chose another format is
taken up).

**In the relay.** `onPstnMessage` (customer), `onBrowserMessage` (`pcm16` agent) and
`onBrowserBinary` (`alaw8` agent) each call the relay (`relayPstnMedia`, `relayBrowserPcm16`,
`relayBrowserAlaw`, the old bodies unchanged, `relayCarrierToAlawBrowser` inside the first) and then
a tail: `const listen = session.listenTap; if (listen !== null && …) listen.feed…(…)`. The tail runs
whether or not the relay wrote (the agent's socket inside its re-attach window, the carrier's
socket gated), and only after `recordRelayFrame`, so the dwell excludes the tap. With nobody
listening the tail is that one read: no codec, no tap call, no send.

**The legs.** Customer: the carrier's base64 payload decoded again by the tap; A-law on the wire
(VoiceLink) is copied; μ-law (Plivo, `wireFormat: 'mulaw8'`) is mapped by the 256-entry
`MULAW_TO_ALAW` (LS17 a); anything else goes through the tap's own `carrier.media.createCodec()` to
PCM16 16 kHz and its own `VoicelinkTranscoder.pcm16kToAlaw`. Agent: a `pcm16` frame through the
tap's own encoder; an `alaw8` message copied. Each leg has its own `AlawFramer`, so a 1 s agent
message is 50 messages and a carrier frame that is not whole 20 ms frames carries its tail. A
transcoded leg's first output (152 bytes for 20 ms of `pcm16`: the resampler's look-ahead) is led
by A-law silence to a whole frame, once, so whole 20 ms inputs then come out as whole frames with
nothing carried. Each
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

**Faults.** Every feed is one try/catch with its stage (`decode`: the base64, the μ-law table or
the carrier codec; `encode`: the A-law encoder; `frame`: the priming, the framer and the message),
counted once in `agency_listen_tap_errors_total{stage}`. A failed message counts its 20 ms frames
(LS17 c) in each sink's `frames_dropped` and in the leg's run of failed frames, which resets on its
next good message; at `agency.listen.faultBudget` frames in a row every sink is ended `tap_error`
and the tap detaches. A
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
`listOpenForCalls`, `listForCall`, `listOpenForListener`, `closeOrphans(replicaId, { keep, minAgeMs })`
(a live process's lost rows, LS16 o), `closeOrphansExcept(liveReplicaIds)`.

**Audit** (`audit/platform/catalog.ts`): `agency_call.listen_started` and `agency_call.listen_ended`,
resource type `agency_call` (the call's id), labelled "Supervisor started / stopped listening to a
call" on the Audit Log and "Supervisor started / stopped listening" on the campaign's History
(`agency-activity-actions.ts`), where `campaign_id` puts them. `details`: the listen id, the call's
origin and `correlation_id`, the agent's user id; `_ended` adds the duration, the end reason and the
frames dropped. The supervisor is the actor on both, whoever ended the session: the end reason says
why, and the campaign's History names who listened.

**Retention (LS12, LS16 s).** The audit maintenance (`audit/audit-partition-maintenance.ts`, daily)
deletes listen sessions that started before the first instant (UTC) of the month the audit cutoff
(`AUDIT_RETENTION_DAYS`) falls in, in batches of 5000, after it drops the audit partitions
(`AUDIT_HORIZON_TABLES`, `purgeAuditHorizonRows`; its report carries `horizonRowsDeleted`). That is
the boundary below which every audit partition has been dropped (a partition goes once its whole
month is past the cutoff), so a session row goes the same day as its month's audit rows, never
before them.

## 7. Permission, flags, config

- `agency.calls.listen`, floor `account_admin` (LS3); the list and the number need
  `agency.supervise`.
- `agency_live_listen_enabled` (default off, client-exposed, `FF_AGENCY_LIVE_LISTEN`) and
  `agency_live_listen_unrecorded` (default on, client-exposed since LS20 for the account's Settings
  line, `FF_AGENCY_LIVE_LISTEN_UNRECORDED`). `agency_live_listen_enabled` has a handling policy in the
  super-admin flag routes (reason to turn on, no bulk, no global On; LS20).
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
since phase 3 (`ws_handoff_total{route="listen"}` by the primary's handoff, the four session and
grant series by `listen-socket.ts`, the grant route and the sweeps).

| Series | Kind | Labels | What it says |
|---|---|---|---|
| `agency_listen_sessions_active` | gauge, per process | | sessions open now |
| `agency_listen_grants_total` | counter | `result` (`granted` or the refusal code) | grants and why they were refused |
| `agency_listen_sessions_ended_total` | counter | `reason` (the end reasons) | how sessions end |
| `agency_listen_session_seconds` | histogram | | how long a listen lasts (reaped sessions excluded) |
| `agency_listen_tap_errors_total` | counter | `stage` (`decode`, `encode`, `frame`, `send`) | frames the tap dropped |
| `websocket_send_backpressure_total` | counter | `socket="listener"`, `action` | listener frames dropped, sockets closed |
| `ws_handoff_total` | counter | `route="listen"`, `result` | listener upgrades handed to media workers |
| `webrtc_relay_dwell_seconds` | histogram, sampled 1 in 50 | `direction` (`b2p`, `p2b`) | the relay's own per-frame dwell; it excludes the tap by construction, so the tap's cost is read on the loop (`nodejs_eventloop_delay_p99_seconds`, `nodejs_eventloop_utilization_ratio`) |

Alerts (group `listen`, warn only; runbooks in [`operations.md`](operations.md) "Alert runbooks"):
`agy-listen-loop-delay` (event-loop delay p99 above 40 ms for 10 min while
`agency_listen_sessions_active` is above 0: the tap runs after the relay's write, so its cost is
loop time before each call's next frame, which the load check measured there, LS17 d),
`agy-listen-backlog-closes` (3+ `send_backlog` closes in 15 min), `agy-listen-grants-server-limit` (any refusal at the process
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
blocked, "Agent is silent", "Reconnecting…" then "Connection lost", "Call ended · you listened
for mm:ss" (or "The call ended before you joined."), revoked, moved). The call page gets "Listened to by" (LS13). The agent's station gets
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
  so; the reads can overlap, the tab's return firing `focus` and `visibilitychange` beside the
  poll, so each carries a sequence number and only the latest asked may land: an older answer
  arriving late can neither end a live row nor drop its shown number) and the pure rules in
  `utils/listen/liveCallsTable.ts`. The whole table sits inside a `ph-no-capture` boundary (CH6:
  the rows carry customers' names and numbers, the shown number included, and the Show and Open
  call buttons are named after the customer). A row that cannot be listened to for the per-call
  cap says "This call has reached its listening limit" (the cap is `AGENCY_LISTEN_MAX_PER_CALL`,
  1–5, so the words name no count). Show/Hide calls
  `GET …/live-calls/:callId/number` per row and keeps the number in the table's state only, so
  leaving the page or the row ending masks it again. **Amber past twice the AHT** reads each row's
  own `aht_seconds` (its campaign's, LS16 i), on the account page and the campaign view alike; a
  row without one (no campaign, or none of its calls ended yet) is never amber
  (`isLiveCallOverrun`). Each row ends with **"Open call"**, a link to the call's own page from
  its `correlation_id` (`liveCallPagePath`): a dialler call's attempt
  (`/agency/campaigns/:id/attempts/:attemptId`), a soft-phone call's page
  (`/agency/softphone/calls/:id`); shown to every reader of the table, listen permission or not,
  and kept on a row fading as "Call ended". An inbound call has no call page in the console, so its
  row has no link.
- *The listen.* `components/listen/ListenProvider.tsx` (mounted by `ConsoleLayout` around the
  shell, keyed by the account, with `ListenBar` under `<main>`): one listen per shell, a second
  Listen stops the first, the first-use confirmation (`magick-agency.listen.confirmed` in browser
  storage), the toast for a refused first grant, the flag or the permission going away stopping it.
  A browser with no Web Audio, or one that will not make a context, is refused at the click with
  "This browser cannot play the call’s sound, so you cannot listen here." before any grant, so no
  session row or audit is written for a listen nobody could hear. When the listen ends (stopped,
  ended, lost) the provider releases the audio at once: the queued ~600 ms stops and the context
  is suspended, not left running for the shell's life; the Listen click and Try again, both
  gestures, resume it.
  `utils/listen/listenSessionReducer.ts` owns every state (idle, connecting, live, reconnecting,
  lost, ended with `call_ended` / `revoked` / `superseded` / `refused`; the 15 s window opened by
  the first drop and closed only by `ready` or Try again; the first attach has the same 15 s from
  the click, so a grant or a socket that never answers ends in "Connection lost", never
  "Connecting…" for ever; three server failures (1011) in a row end it, counted across `ready`s
  (a tap failing just after every `ready` would otherwise mint a grant, a row and two audit rows
  every few seconds) and counted afresh once the listen has stayed live 10 s
  (`LISTEN_STABLE_MS`); a refused re-grant ends it, or is retried, by its code);
  `utils/listen/listenSessionController.ts` does what each state asks (mint, open in binary mode,
  ping every 10 s, `stop`, wait 0.25–3 s between attaches, dismiss "Call ended" after 6 s);
  `utils/listen/listenFrames.ts` reads the wire and maps each close code (any code it does not
  name is a drop it reconnects from: 1006, and 1005, the code a browser reports when one process
  shutting down closes the socket with no code and no `ended` frame, LS16 g);
  `hooks/listen/useListenSession.ts` binds them to React. The audio is
  `utils/listen/listenPlayback.ts` (`ListenPlaybackEngine`: one 16 kHz `AudioContext`, per leg an
  `AlawDownlinkDecoder`, a queue re-based onto 120 ms after an underrun, and past 600 ms ahead
  (a burst after a stall) the leg's queued sources stopped before it re-bases, so two moments of
  the call never play over each other; an analyser then a gain (the meter reads before the
  mute), one master gain). While the context is not running (the autoplay policy, an
  interruption) its clock is frozen, so frames are dropped and anything queued stopped (on the
  frame, and on the context's `statechange`) rather than piling up to play in a heap; only a
  gesture resumes it, never a frame. Under it `hooks/listen/useListenPlayback.ts` (the mutes;
  the volume in `magick-agency.listen.volume`, every storage access in try/catch). "Agent is
  silent" is the agent's leg sending nothing for over 2 s while live: a console agent who mutes
  sends no frames, so the bar does not claim a reconnect it cannot see; "sound blocked" is the
  context not running, lifted by the banner's button.
- *The bar.* `components/listen/ListenBar.tsx`. At phone width (640 px) it is the live dot, the
  timer and Stop, and keeps the LS6 notice under them (the notice is never dismissible, so it is
  not dropped at any width). Esc anywhere inside the bar stops a listen (or dismisses an ended
  one). **"Open call"** opens the call's own page, as the table's link does (`liveCallHref` over
  the listen target's `correlationId`); an inbound call, which has no call page in the console,
  falls back to its live view (its campaign's Live, else `/agency/live`). The bar sits inside a
  `ph-no-capture` boundary (the agent's name, the masked number, the campaign; CH6). Focus: the
  row's Listen gives way to "Connecting…", so focus moves to the bar (`tabIndex=-1`, where Esc
  stops), and to it again whenever what held it inside the bar goes; when the bar goes (Stop, Esc,
  Dismiss, the 6 s dismissal) focus returns to that row's Listen (`data-listen-trigger`) if it is
  on the page. Focus the supervisor moved elsewhere is left alone. Once a listen has ended, the
  head and the reason are one `role="status"` region, so the reason is announced; a call gone
  before the first `ready` (4404 on the first attach) says "The call ended before you joined."
  rather than "you listened for 00:00".
  `ListenedToBy` is not marked: it names supervisors only, staff names show unmarked across the
  console, and it holds no customer data.
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
  client flag (`stationListenNoticeProvider` over `FeatureFlags.liveListenEnabled`, the key
  `agency_wire` keeps beside the other client flags and pins against the contract's
  `platform.json` fixture); no wire type changes.
- *Refusal words.* A refused grant's toast says its code's words (`listenRefusalMessage`). The
  grant's own 503s (`listen_limit_server`, `listen_unavailable`) arrive with their code: the
  route's `sendListenRefusal` marks a 5xx refusal reviewed (`preserveReviewedUpstreamError`), so
  the server's error mask (`error-mask.middleware.ts`) lets the fixed body through, and "busy"
  and "unavailable" read apart. A 503 without a listen code still reads as `listen_unavailable`
  ("Listening is not available right now. Try again."): a worker restarting answers
  `worker_unavailable`, and a 503 from in front of the server has no body to read. A re-grant
  answered 503 is retried within the window either way.
- *Analytics.* `analytics/redact.ts` takes the listener socket's `token` out of any URL on its way
  to PostHog (`redactListenToken`).

## 10. Status

| Phase | What | Status |
|---|---|---|
| 1 | Foundation: the permission, both flags, the socket and console contracts, the refusal codes, `0047_listen_sessions.sql` and its repository, the retention sweep, the audit actions and resource type, `agency.listen` config, the metric declarations, the alert group and dashboard row, this document | **Built** (2026-11-16) |
| 2 | The tap and the bridge seam: `listen-tap.ts`, `openListenTap` with `docs/seams.md` §3.1 and the seam contract tests, `LISTENER_LIMITS`, the fault budget, the sampled relay dwell, fault-injection tests | **Built** (2026-11-16) |
| 3 | The server side: `ListenRegistry`, `ListenTokenStore`, the listener socket, the four routes and two internal handlers with their guards (route tables, agent reach, owners, `wsOwner`, `ws-limits`, the rate-limit bucket, `token` redaction), revocation over IPC, the re-check, the boot and worker reaps, the audit writes, the call detail's `listen_sessions` | **Built** (2026-11-16): §4 "As built (phase 3)", LS16 |
| 4 | The console: Live calls page and campaign view, `LiveCallsTable`, `ListenBar`, `useListenSession`, `useListenPlayback`, "Listened to by" on the call page | **Built** (2026-11-16), against the contracts (§9 "As built"); since phase 3, reads the live row's `correlation_id` ("Open call" to the call's page) and `aht_seconds` (amber on both pages), and is checked against the server's routes, frames, close codes and refusals; the review's console and mobile fixes (K1–K12: the audio on a stopped clock, bursts, retries across `ready`, the first attach's deadline, ordered reads, `ph-no-capture`, focus, the words) are in §9 |
| 5 | The agent's standing line (LS2) on the console station and the mobile station info sheet | **Built** (2026-11-16) |
| 6 | The inbound notice's words and its regenerated WAV (LS1) | **Built** (2026-11-16): `AGENCY_INBOUND_STANDARD_WORDS.recording_notice` is "This call may be recorded or monitored for quality and training purposes." and `apps/server/assets/inbound/recording-notice.wav` is regenerated from it with `scripts/generate-inbound-clips.ts --only recording_notice` and the pinned voice (8 kHz mono PCM16, 5.0 s); the other six recordings are unchanged. The carrier never speaks the notice (its `<Speak>` covers closed, busy and call-back only), so the WAV is the only other copy of the words |

| Load check | 100 calls with nobody listening, then 6 and 20 listeners (one stalled), on one build: `apps/server/test/integration/load/listen-media-load.test.ts` | **Run** (2026-11-16): below |
| Voice review | The tap's review fixes: listeners ended as the call starts to settle (LS15 f), the μ-law customer by table and the transcoded legs primed (LS17 a), 10 s of drops ending a listener (LS17 b), failed frames counted in 20 ms frames (LS17 c), the loop-delay alert (LS17 d) | **Built** (2026-11-16): unit-tested; the load check's stalled listener now expects `send_backlog` (its integration file is updated, not yet re-run) |
| Server review | The agency and API side's review fixes: the upgrade's own access check and the revocation generation (LS16 n), the immediate path failing closed and the periodic pass's staleness cap (LS16 c, d), the flags read strictly, the super-admin's revocation, failed row closes retried and lost rows swept (LS16 o), supersede of older rows only (LS16 p), a stopping process `listen_unavailable` (LS16 q), retention on the partitions' month boundary (LS16 s), the AHT cache bounded and the dialler spine's index (LS16 u), the handoff's redacted URL (LS16 v) | **Built** (2026-11-16): `9f32bc5`, `09053e6`; counts in [`status.md`](status.md) "Test counts" |
| Persona review: history and guard rails | The account's listening history and its CSV (LS19), the agent named on a campaign's listen rows, the consent gate's handling policy, the enablement checklist and the unrecorded flag client-exposed (LS20), the inbound consent gap recorded (LS18), the live list and the number answering a flag store outage `503` (§12) | **Built server side** (2026-11-16): §12; the console's Listening history page and Settings line are still to build |

### Load check

**What runs.** `listen-media-load.test.ts` (wall-clock lane: the audio is paced in real time and
the stalled listener's end is the real 30 s idle bound) dials 100 calls (`LOAD_SCALE`, seeded by
`LOAD_SEED`) through the real bridge and `VoicelinkAdapter` to the mock VoiceLink carrier, which
streams paced A-law, 50 frames a second; each agent's leg is a real WebSocket on loopback lent to
the bridge as the station's socket is (half `alaw8`, half `pcm16`), talking 50 frames a second
back. The station route itself is left out: the bridge borrows its socket, so the route is not on
the media path. Three floors on one build: (a) nobody listening; (b) 6 listeners, the expected peak;
(c) 20, the process cap, with a 21st grant refused `503 listen_limit_server`. Listeners take the
whole real path (the public grant with the session, tenant context, RBAC and the flag, the live
list's SQL over a `bridged` attempt this file writes for each listened call, `callCore` to the
grant handler, the token, the upgrade, the row, the tap), two to a call, each a supervisor of
their own, and live in a child process (`listen-load-clients.ts`), as browsers would be elsewhere:
their own reading is not charged to the server's loop. One listener of each run stalls: it pauses
its socket at `ready` and never reads or pings again.

**How it is measured.** Each floor gets a 15 s window with nobody listening; (b) and (c) then attach
their listeners and measure a second 15 s window on the same calls, compared with the first. The
pairing is deliberate: across runs minutes apart, a busy neighbour on the machine (another worktree's
Flutter tests, here) moved the numbers more than 20 listeners do, and a CI runner's other lane files
would do the same. Primary, because the tap runs after the relay's write and can only cost the NEXT
frame, on the loop: the loop's utilisation and delay p99 (`createLoopSampler`) and each direction's
end-to-end frame latency (carrier send → agent receive, agent send → carrier receive, timed on both
sockets in the test). Secondary: `webrtc_relay_dwell_seconds`, the sampled relay dwell, which
excludes the tap by construction (LS8) and so says the relay itself is not slowed, never that the
tap is cheap.

**Bounds** (listening window against the quiet one): utilisation at most +0.2; loop delay p99 at
most max(2×, +10 ms); frame latency p50 at most max(1.5×, +1 ms) and p95 at most max(3×, +30 ms),
each direction; dwell mean at most max(2×, +50 µs) and its p99 bucket at most two buckets up. Past
p95 the latency is garbage-collection pauses, which move by tens of ms between windows with or
without listeners: reported, not bounded. Every run, every listener count: zero frames lost on
either leg of every call (count and loudness pattern both ways, the bridge's drop counters zero);
every reading listener gets both legs at 50 messages a second each (±10 %), ends `call_ended` with
`frames_dropped` 0 and `frames_sent` equal to what it received; the stalled one has frames dropped
at its soft limit (its row's `frames_dropped` equals the run's
`websocket_send_backpressure_total{socket="listener",action="media_dropped"}`), is ended
`listener_disconnected` by the idle bound while its call stays up and the call's other listener
keeps hearing it; the grant, end and active-session metrics move exactly; nothing leaks.

**Measured** (a 4-core container, 100 calls, seed 24301; two runs of the file alone with the
listeners out of process, each floor's quiet window → its listening window; the third figure is the
file in its lane, `INTEGRATION_LANE=wall-clock`, beside the lane's six other files):

| Floor | Utilisation | Loop delay p99 | Latency p50 | Latency p95 | Dwell mean b2p / p2b |
|---|---|---|---|---|---|
| (a) nobody listening | 0.65, 0.67; 0.74 | 4.2, 4.4; 4.7 ms | 0.84, 0.88; 1.13 ms | 4.2, 4.0; 5.8 ms | 16–18 / 19–22 µs |
| (b) 6 listeners | 0.65 → 0.69, 0.71 → 0.73; 0.75 → 0.83 | 4.3 → 4.9, 4.8 → 5.3; 5.4 → 9.1 ms | 0.82 → 0.91, 1.20 → 1.27; 1.13 → 1.58 ms | 7.3 → 9.5, 7.4 → 10.7; 17.6 → 38.7 ms | 14–19 / 19–24 µs, within noise |
| (c) 20 listeners | 0.71 → 0.70, 0.68 → 0.75; 0.77 → 0.84 | 5.0 → 4.4, 4.4 → 4.9; 5.5 → 6.6 ms | 0.99 → 0.98, 0.88 → 1.08; 1.18 → 1.49 ms | 15.0 → 10.6, 10.4 → 7.3; 8.5 → 14.7 ms | 15–20 / 18–24 µs, within noise |

Every reading listener received 49.9–50.2 messages a second per leg; the dwell's p99 sat in the
≤ 100 µs bucket throughout. So the server's price of the per-process cap on 100 calls is at most
about +0.07 of loop utilisation (+0.04 for the peak's 6), and nothing measurable in the loop's delay
or the calls' latency beyond the noise between two windows. In the lane, beside other files, the
noise is larger (the peak's window there moved more than the cap's): the closest reading to a bound
in every run so far is that one's p95, 38.7 ms against 52.8. The p95 slack was 20 ms for the first
runs and is 30 ms, for a CI runner's busier neighbours. Earlier runs with the listeners' sockets in the SAME process
(their reading charged to the loop) showed the ceiling of that price: at 20 listeners +0.05–0.11 of
utilisation and the calls' p95 latency 3–4× (4 → 18 ms), which is the 2,000 messages a second the
listeners themselves read; at 6 listeners +0.01–0.05. The relay dwell never moved, as LS8 says it
cannot.

**Findings.**
- *A stalled listener on loopback is ended by the idle bound before it is dropped.* A paused reader
  on loopback absorbs about 4 MB in the kernel (the send buffer autotunes to `tcp_wmem`'s maximum
  with 64 KiB segments) before `ws` buffers a byte: four minutes of one listener's audio, against the
  30 s idle bound. Across a real path the kernel takes tens of KiB, so the soft limit is reached in
  seconds; the suite reproduces that by corking the stalled listener's server end
  (`net.Socket.cork`), after which it is dropped (soft limit) within the window and then ended by the
  idle bound, as LS15 (g) then expected. Since the voice review (LS17 b) it is ended `send_backlog`
  10 s after its first dropped frame instead, before the idle bound; the clock runs on
  `bufferedAmount` as `ws` sees it, so on loopback it starts only once the kernel's 4 MB is full
  (the suite's expectations follow; not yet re-run since). Without the soft limit (mutation below)
  the same listener reaches the hard cap within the window and is closed `send_backlog`.
- *The grant's 503 refusals were masked.* Through the whole app the error mask replaced the bodies
  of `503 listen_limit_server` and `503 listen_unavailable` with the generic support message, so the
  console could not say why a Listen was refused (it read them as `listen_unavailable`). Fixed in
  `7b1c92a`: `sendListenRefusal` marks them reviewed (`preserveReviewedUpstreamError`), as the soft
  phone's reviewed 503s are; the route test runs behind the mask now.

**Mutation checks** (each red, then restored with `git checkout`): a 1 ms busy wait in the tap per
leg message (6 listeners: utilisation 0.68 → 0.94, loop delay p99 4.4 → 19.7 ms, latency p50 0.94 →
3.9 ms, all four primary bounds red; the dwell unchanged); the listener's soft limit removed (the
stalled listener closed `send_backlog` inside the window); a listened call's relay dropping one
frame in 500 (the zero-loss check red). Feeding the customer leg's tap BEFORE the relay is NOT caught
here (20 listeners: p2b dwell mean 21 → 26 µs, inside the bound: ten of a hundred calls carry the
tap's passthrough copy); it is pinned by `webrtc-bridge-listen-tap.test.ts` ("recordRelayFrame runs
before every listener send"), which goes red for it.

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
- The tap (phase 2, the voice review): `apps/server/test/unit/core/webrtc-bridge-listen-tap.test.ts`
  (both legs byte for byte on passthrough and framed, a 1 s agent message as 50; the μ-law customer
  by the table a frame out per frame in, a carrier with no G.711 law and the `pcm16` agent on the
  tap's own codecs, primed so each 20 ms in is a frame out, with the session's codec called once per
  frame; the table bit for bit against the per-sample conversion and at least as faithful as the
  codec path; no tap, no extra call; the tail after `recordRelayFrame` and the dwell samples
  unchanged by two listeners; the tail when the leg gate returns early; soft and hard limits on the
  listener's socket, and 10 s of drops ending it `send_backlog`; a throwing codec, encoder, framer,
  sink and close, a socket that errors mid-send or closes, one that never drains, each with both
  legs relayed and the right end reason; the budget at exactly N in a row, reset by a success, per
  leg; a failed message counted in 20 ms frames; `call_ended` as the hangup starts, and nothing from
  either leg after a VoiceLink hangup of ours (`alaw8` and `pcm16` agents) or inside the terminal
  teardown's await (a hangup of ours on a carrier with a hangup API, the carrier's `stop`); the
  re-attach keeping the tap and starting a `pcm16` agent's leg afresh; the refusals),
  `webrtc-bridge-seam-contract.test.ts` (the member and its types),
  `webrtc-bridge-manager.seams.test.ts` (the refusals and the handle through a VoiceLink call's
  life, closed as the hangup starts), `webrtc-bridge-inbound-connect.test.ts` (a parked caller
  `not_bridged`; after the bind, both legs through the tap on the real Plivo module, byte for byte),
  `test/unit/telephony/carrier-modules.test.ts` (Plivo's `wireFormat: 'mulaw8'`).
- The server side (phase 3): `test/unit/agency/listen/listen-registry.test.ts` (the three caps,
  reservations, a supervisor's own listen not counted, supersede, `endSessions`, `revokeUser` scoped
  and re-checked and failing closed, the periodic pass failing open up to the staleness cap (and a
  hung pass), the periodic re-check on fake timers, the rows' upkeep on the tick, a stopping process
  `listen_unavailable`, the revocation generation between grant and reservation and between
  reservation and admission, shutdown; the access question: the floor, a tenant-wide admin, the
  flag, LS4, a failed read unchecked while a known no still revokes, one read per supervisor and
  account), `listen-socket.test.ts` (the strict frame parser; the upgrade's order: token, session,
  caps, the database's answer (4403, or 1011 when it cannot say), a token from before a revocation,
  a revocation between reservation and admission, a stopping process, row before tap, the tap refused; `ready` and the started audit; ping/pong; every end's frame,
  close code, row and audit; the tap's own ends; the client's close; the idle bound on fake timers;
  ends once; a throwing row close or audit; supersede through the registry), `listen-token.test.ts`
  (single use, the listen id, a stored value that is not a grant, fail closed both ways, the
  in-process store), `listen-revocation.test.ts` (the hook; the cross-process supersede: past the
  cap, older rows only, two listens admitted at once ending one), `listen-rows.test.ts` (a failed
  close retried with its reason, the sweep's keep set and age floor, the queue bound),
  `test/unit/feature-flags/flag-snapshot.test.ts` (`strictSnapshot`: an outage rejects),
  `test/unit/api/routes/super-admin-memberships.test.ts` (the super-admin role change and removal
  re-check listens), `test/unit/api/routes/proxy-agency-live-calls.routes.test.ts`
  (RBAC before the flag, the flag, a flag store that cannot be read, the edge checks, masking and
  names, `listenable`, the number, the grant's refusals, its forwarding and its answer mapping),
  `agency-live-calls-internal.test.ts` (the grant handler: the bridge, the caps, the token and its
  revocation generation; the AHT cache's minute and bound),
  `test/unit/api/listen-route.test.ts` (the route, its `wsOwner` and handoff label, the refusals,
  the station bucket, the token's redaction in spans and in the handoff's own log line),
  `test/integration/agency/live-call-plan.test.ts` (the dialler spine on
  `idx_agency_attempts_account_live`), the guards (`agency-route-table`, `agency-agent-reach`,
  `core-route-owners`, `core-dispatch`, `websocket-max-payload`, `ipc-protocol`,
  `media-child-invalidations`); end to end `test/integration/agency/live-listen-e2e.test.ts`
  (VoiceLink: joining mid-call with both legs, the call's end, a drop, stop, the per-call cap,
  supersede, a role change and a removal through the real routes with the periodic re-check held
  off (so the immediate path), a demotion between a grant and its upgrade, LS4 both ways, the own call,
  another account and tenant, agents, operators, the flag, the number, the call details, a
  soft-phone call, a wrap-up redial, HTTP closing, the boot sweep, a replayed or foreign token),
  `test/integration/telephony/live-listen-plivo-e2e.test.ts` (Plivo outbound; inbound parked then
  connected), `test/integration/cluster/live-listen.test.ts` (`MEDIA_WORKERS=2`: the grant and the
  socket on the owning worker, supersede across workers, revocation over IPC with the periodic
  re-check held off, a demotion between a grant and its upgrade).
- The console (phases 4 and 5), under `apps/console/src/__tests__/`:
  `utils/listen/listenFrames.test.ts` (the parser, every close code, the `ended` reasons that end a
  session), `utils/listen/listenSessionReducer.test.ts` (every transition, stale attempts, the
  window, the bound, the bound across `ready`s and its fresh count after 10 s live, the first
  attach's 15 s, Try again, the bar's flags), `utils/listen/listenSessionController.test.ts`
  (grant → socket → ready, audio only while live, ping, stop, supersede, destroy, reconnect, a
  shutdown's close with no `ended` frame through masked and unanswered re-grants, the window, a
  first grant or socket that never answers, an unopenable socket),
  `utils/listen/listenPlayback.test.ts` (the cushion, per-leg queues and decoders, a burst past
  the ceiling never overlapping one leg, the graph, mute, volume, level, silence, blocked: frames
  dropped on a frozen clock with no resume per frame, "Turn sound on" with no burst, an
  interruption stopping the queue, release, a context the browser refuses, reset, close, no
  microphone in use or in the source), `utils/listen/liveCallsTable.test.ts` (sort, filters,
  ended rows, amber, the target, "Open call" by origin and its inbound fallback, the words, a
  bare 503), `api/liveCalls.test.ts`, `components/LiveCallsTable.test.tsx` (… the `ph-no-capture`
  boundary, an older read answering late), `components/ListenBar.test.tsx` (the confirmation,
  every bar state, Esc, mutes, the remembered volume with storage blocked, the toast, a second
  listen, the account switch and unmount with the socket and the context closed, phone width;
  the audio silenced and suspended on Stop, supersede and revoke and resumed by the next Listen
  and Try again; no Web Audio or a refused context refused with a toast; focus to the bar and
  back to the row's Listen, left alone when moved; the ended reason in the live region; "The call
  ended before you joined."; the bar's `ph-no-capture` boundary),
  `components/ConsoleLayout.listen.test.tsx` (the shell's real wiring: the bar under `<main>`,
  the listen across pages, ended by an account switch and by leaving the shell),
  `components/listenSurfaces.test.tsx` (the station popover, the join screen's line, "Listened to
  by", "Summary | Live"), `pages/LiveCallsPages.test.tsx`, and the navigation guards
  (`navRouteGates`, `consoleNav`, `consoleSearch`, `agencyCampaignTabs`), `analytics/redact.test.ts`,
  `analytics/autocaptureOptOut.test.ts` (the table and the bar among the surfaces that keep the
  class). Mobile: `apps/mobile/test/features/station/station_listen_notice_test.dart` and
  `apps/mobile/packages/agency_wire/test/platform_test.dart` (`FeatureFlags.liveListenEnabled`
  against the fixture).
- The load check: `apps/server/test/integration/load/listen-media-load.test.ts` and its listeners'
  child process `listen-load-clients.ts` (§10 "Load check").
- The notice's words (phase 6): `packages/contracts/test/inbound-route-warnings.test.ts` (the
  sentence word for word, as its WAV says it), `apps/console/src/__tests__/pages/InboundRoutes.test.tsx`
  (the route editor quotes it), `apps/server/test/unit/agency/inbound/inbound-standard-clips.test.ts`
  (the regenerated WAV's format, length and headroom).
- The history and the guard rails (§12): `packages/contracts/test/listen-history.test.ts` (the end
  reasons' words, the merge gap), `apps/server/test/integration/agency/listen-history.test.ts` (on
  Postgres: the merge within the gap and past it, a session joining an open one or overlapping it,
  the time listened counted once, the last-ended reason, the tenant and account scope, the filters,
  keyset pages with ties on the start, the joins that survive a purged call row; then the internal
  handler and the public routes together: masking, "Withheld", a malformed cursor, the CSV drained
  across pages and its audit row), `test/unit/api/routes/proxy-agency-listen-history.routes.test.ts`
  (RBAC before the flag, the flag, a flag store outage `503` through the error mask, the query
  refused at the edge, names and masking, the CSV's pages, row ceiling, formula guard and audit row,
  a refused page answering its own status with no file),
  `test/integration/agency/agency-activity-service.test.ts` (a listen row's `detail.agent_name`),
  `test/unit/api/routes/proxy-agency-live-calls.routes.test.ts` (an outage is `503` on the list and
  the number too), `test/unit/api/routes/super-admin-feature-flags.test.ts` (the policy on the
  catalog and the detail read, the reason, the bulk and global refusals),
  `apps/super-admin/src/__tests__/pages/SAFeatureFlagsPage.test.tsx` (no reason dialog for a global
  On of a policy flag; the global Off kept; not in the bulk rollout), the flag exposure
  (`packages/contracts/test/flags.test.ts`, `test/unit/feature-flags/registry.test.ts`,
  `test/integration/feature-flags/feature-flag.service.test.ts`, the `platform.json` fixture).

## 12. The listening history and the guard rails (persona review)

Built after the persona review, on the product owner's decisions (LS18–LS20).

**The listening history (LS19).** `GET /proxy/agency/listen-history`
(`api/routes/proxy-agency-listen-history.routes.ts`; contracts `api/agency/listen-history.ts`):
`agency.supervise`, then `agency_live_listen_enabled` for the account (`403 feature_disabled`; a
flag store that cannot be read is `503 listen_unavailable`, which the console retries), an
account, the query checked at the edge (`listener_user_id`, `agent_user_id` UUIDs, `from` / `to`
ISO instants, `to` exclusive and not before `from`, `limit` 1–100, `cursor`; unknown keys a 400).
It reads the internal `GET /api/v1/agency/listen-history` (owner `none`;
`api/routes/agency/listen-history.ts`, `AgencyListenHistoryRepository.listVisits`,
`LISTEN_HISTORY_SQL`), then adds the supervisor's and the agent's names (`agentNamesOrNone`) and
masks the number (`maskPhone`; `''`, a withheld caller, is `customer_phone_withheld: true`; a
purged call row is neither). An entry is a visit: one supervisor's sessions on one call, merged in
the SQL (LS19 b), with `listen_ids`, the first start, the last end (null while one is open), the
time listened, the reason of the session that ended last (null while open), the call's origin and
spine row (`correlation_id`, for the link: the campaign's attempt page, the soft-phone call page,
the inbound call), the campaign, the inbound route and the roster contact's name. Newest first by
the visit's start and first id, keyset-paged (`next_cursor`, the domain package's keyset cursor; a
cursor this API did not issue is `400 malformed_cursor`). Each page windows the account's sessions
the filters keep: a few rows a day per supervisor, purged at the audit horizon, so no index was
added for the account and start together (a supervisor filter uses
`idx_agency_listen_sessions_listener`).

`GET /proxy/agency/listen-history.csv` takes the same filters (no `limit`, no `cursor`), drains the
pages (100 at a time, `drainPages`) up to 10,000 entries and 30 s, and answers `text/csv`
(`listening-history-<date>.csv`, `X-Export-Rows`; cut short: `X-Export-Truncated: true`,
`X-Export-Truncated-Reason` `row_limit` or `deadline`, `X-Export-Row-Limit`). Columns:
`started_at, ended_at, listened_seconds, supervisor, supervisor_user_id, agent, agent_user_id,
call_type, campaign, inbound_route, customer, customer_phone, how_it_ended, end_reason, sessions,
call_id, listen_ids`; numbers masked, "Withheld", "Listening now" for an open visit; every cell
through the formula guard (`toCsvLine`). A refused page answers its own status and no file. Written
on success only: one `agency_listen_sessions.exported` audit row (resource `account`, the filters,
the rows, any truncation).

Sessions that never went live (a row written, then closed at the upgrade without admission) are
in the table too, and the history shows every row the statement keeps. Whatever marks a session
that went live (the persona review's QA-M2) is to be applied to `LISTEN_HISTORY_SQL`'s first CTE as
well, so "Listened to by" and the history agree.

**The campaign History's listen rows (LS19 e).** `fetchActivityPage` resolves the
`detail.agent_user_id` of `agency_call.listen_started` / `_ended` rows in the page's one identity
read and adds `detail.agent_name` (null when the user does not resolve). The duration, the end
reason and the call's ids are already in `detail`; the console words them.

**The live list and the number on a flag store outage.** They answer `503 listen_unavailable`
(through the error mask), as the grant does, never `403 feature_disabled`, which the console reads
as final and stops polling on.

**The consent gate's handling policy (LS20 a).** `apps/server/src/feature-flags/flag-policies.ts`
(`flagPolicy`, `checkOverridePolicy`, `checkBulkPolicy`): the catalog and the detail read carry
`policy { warning, bulk_allowed: false, reason_required_to_enable: true }` for
`agency_live_listen_enabled` and for no other flag; `PUT …/overrides` refuses an On without a reason
(`400 flag_reason_required`) and a global On (`422 flag_bulk_not_allowed`); `POST …/overrides/bulk`
refuses it whatever the value. Deleting an override and turning it off are not guarded. The
super-admin registry (`SAFeatureFlagsPage`, `canEnableGlobally` in `flagUtils.ts`) answers a global
On with why, not the reason dialog; the tenant tab's dialog already shows the warning on an On.

**The Settings line (LS20 c).** Both flags are client-exposed: the account's Settings reads
`agency_live_listen_enabled` and `agency_live_listen_unrecorded` from the client flag map
(`GET /feature-flags`) and shows them read-only. The console's line is the console's to build.

**The enablement checklist (LS18, LS20 b):** [`operations.md`](operations.md) "Enabling live call
listening for a tenant".
