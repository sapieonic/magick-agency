# Live call listening

Supervisors see the calls in progress in their account and listen in silently from the console.
Listen only: no whisper, no barge. The audio is forked from our own WebRTC bridge, in the process
that owns the call; the carrier is not involved, and a slow, failing or dropped listener never
affects the agent's or the customer's audio. Designed 2026-11-16 from the code, reviewed and locked
by Manas the same day; decisions LS1–LS22 below. Built in phases (§10): phase 1, the foundation,
phase 2, the tap in the bridge and its seam member, phase 3, the server side (the routes, the
listener socket, the registry, revocation), the console (phase 4), the agent's standing line
(phase 5) and the inbound notice's monitoring words (phase 6) are built, and the load check has
run (§10 "Load check").

Where things are: the socket's contract `packages/contracts/src/agency/listen.ts`, the console wire
`packages/contracts/src/api/agency/live-calls.ts`, refusals `packages/contracts/src/errors.ts` §7,
permission `agency.calls.listen` (`rbac.ts`), flags `agency_live_listen_enabled` and
`agency_live_listen_unrecorded` (`flags.ts`), migrations `0047_listen_sessions.sql`,
`0048_listen_sessions_unverified.sql` and `0049_listen_history_index.sql`, repository
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
LS16 phase 3's, LS17 the voice review's; LS18–LS20 record the product owner's decisions on the persona review (Manas, 2026-11-16), LS21 is Manas's decision on an outage of the access check, LS22 the persona review's server calls and the final review's. The build's own calls (LS14–LS17, those in LS19 and LS20, LS22 (a)–(u)) were ratified by Manas on 2026-11-17, so every LS ruling is decided but LS22 (v) and (w), the build's fixes on the PR review (2026-11-17).

| ID | Decision | Status |
|---|---|---|
| LS1 | **Consent.** The flag `agency_live_listen_enabled` (scopes global, tenant, account; default **off**; client-exposed) is the consent gate: a super-admin turns it on for a tenant or an account once its callers are told calls may be monitored (under its handling policy and the enablement checklist, LS20). Inbound: the standard recording notice becomes "This call may be recorded or monitored for quality and training purposes.", its WAV regenerated (phase 6). Outbound: the agent's script says it; no product change. Every live-call route answers `403 feature_disabled` while it is off, and the periodic re-check ends listens open when it goes off (`permission_revoked`). It gates listening, not the record of past listens: the Listening history and "Listened to by" stay visible while it is off (LS19). | **Decided** (Manas, 2026-11-16); the consent and notice wording's legal check (LS1, LS2, LS18) done (Manas, 2026-11-17) |
| LS2 | **What the agent sees.** No live indicator in this build. While the flag is on, the agent station shows a standing line "Calls may be listened to by a supervisor for quality and training." on the console station (the header's info popover and the join screen) and on the mobile app's station info sheet (copy only, no wire change; the app reads the client-exposed flag). The live "Supervisor listening" pill is not built. The one-time notice that also shows the line the first time is a build call, LS22 (u). | **Decided** (Manas, 2026-11-16) |
| LS3 | **Who.** A new permission `agency.calls.listen`, floor `account_admin` (tenant admins and owners pass by the hierarchy; an account admin in the accounts of their membership). The live list needs `agency.supervise`; a supervisor who may watch but not listen sees the list without the Listen action (both floors are `account_admin` today, so that supervisor cannot occur yet: raising this floor is a code change to `rbac.ts`, and the console's "You can see live calls but not listen to them." is for then). Agents, viewers, operators and super-admins cannot listen. Listening to a call you are the agent on is refused `listen_own_call`. Mobile supervisors are out of scope. | **Decided** (Manas, 2026-11-16) |
| LS4 | **Calls that are not recorded.** The flag `agency_live_listen_unrecorded` (scopes global, tenant, account; default **on**; client-exposed since LS20, for the account's Settings line; the server still decides each row). On: an unrecorded call (`agency_calls.recording_requested` false, RC1) is listenable like any other, and its row shows "Recording off". Off for the call's tenant or account: the row shows "Recording off", Listen is disabled with "Listening is turned off for unrecorded calls", and the grant answers `409 listen_recording_off`. | **Decided** (Manas, 2026-11-16) |
| LS5 | **Scale and placement.** At most 2 listeners per call (`AGENCY_LISTEN_MAX_PER_CALL`, 1–5), 1 listen per supervisor (a second ends the first `superseded`), 20 per process (`AGENCY_LISTEN_MAX_PER_PROCESS`). Expected peak: 100 calls at once, 5–6 supervisors. The tap runs in the process that owns the call (a media worker when `MEDIA_WORKERS >= 1`): no listen worker, no audio over IPC. | **Decided** (Manas, 2026-11-16) |
| LS6 | **The supervisor is told, and every listen is recorded.** The listening bar always shows "This session is logged. Do not record or share what you hear." (not dismissible). A first-use confirmation per browser: "Listening is logged" / "Each time you listen, your name, the call and the start and end times are recorded in the account’s Listening history." / Cancel, Start listening (final since the account's Listening history exists, LS19: every listen, inbound and campaign-less ones too, is on it; the campaign History does not show an inbound or campaign-less listen, so "in the activity history" was not true of every call, and the interim "can be seen by your account’s admins" pointed nowhere). Each listen is one `agency_listen_sessions` row and two audit rows, `agency_call.listen_started` and `agency_call.listen_ended` (resource type `agency_call`, ids only, `campaign_id` set so they show on the campaign's History). | **Decided** (Manas, 2026-11-16) |
| LS7 | **Fail closed on the way in.** If the grant, the token or the session row's insert fails, the socket is refused with a reason the bar can show: no row, no audio. A failed audit write is logged and counted; the row is the record. | **Decided** (Manas, 2026-11-16) |
| LS8 | **The tap never touches the call.** It is a nullable field on the bridge session (one field read per frame with nobody listening, as `CarrierTap`), fed after the relay write in a guarded tail that also runs when the leg gate returns early, so the relay's dwell excludes it. It owns its codec instances (session codecs keep FIR history and are never called twice for a frame). Every entry point (each leg, each sink) is wrapped: a failing decode, encode or framing step drops that frame and counts it; 50 failures in a row (`AGENCY_LISTEN_FAULT_BUDGET`, one second) detach the tap and close its listeners `tap_error`; the call carries on. One bad listener stays one: a throwing send or a closed socket removes only that sink. Back-pressure reads only the listener's own socket: soft 48 KiB drops and counts, hard 256 KiB closes it `send_backlog` (4408). Nothing awaits. | **Decided** (Manas, 2026-11-16) |
| LS9 | **Numbers are masked.** The live list masks the customer's number (`****1234`, `maskPhone`). Each row's Show/Hide fetches the full number on demand (`GET /proxy/agency/live-calls/:callId/number`, `agency.supervise`, flag-gated, tenant and account scoped); it is never in the polled list and is masked again on leaving the page. Not audited: supervise holders already see full numbers elsewhere. | **Decided** (Manas, 2026-11-16) |
| LS10 | **Revocation.** Immediate on a role change or a member's removal (the routes that clear the membership cache call `revokeUser(tenantId, userId)`, sent to media workers as IPC `listen.revoke`); otherwise within 30 s (`AGENCY_LISTEN_RECHECK_MS`) through a re-check that reads the membership floor from the database, not the cache, and the two flags. Both end the listen `permission_revoked`. The lag is accepted. | **Decided** (Manas, 2026-11-16) |
| LS11 | **The wire.** A binary message is one tag byte (`0x01` customer, `0x02` agent) and 160 bytes of A-law (20 ms), built once per frame per call and sent to each listener. Text frames are control only. No mixing on the server: the browser mixes in WebAudio and never asks for the microphone. | **Decided** (Manas, 2026-11-16) |
| LS12 | **Retention.** `agency_listen_sessions` follows the platform audit log: its rows are deleted by the audit maintenance at the same cutoff (`AUDIT_RETENTION_DAYS`, default 85 days). | **Decided** (Manas, 2026-11-16) |
| LS13 | **Who listened, on the call.** The call detail pages get a "Listened to by" section (who, start–end, duration) read from `agency_listen_sessions` by call id, visible to `agency.supervise` holders like the rest of the call page. | **Decided** (Manas, 2026-11-16) |
| LS14 | **Phase 1's own calls.** (a) Refusal statuses: `listen_call_not_live` 404 (uniform: an ended call and another account's look alike), `listen_recording_off`, `listen_limit_call`, `listen_own_call` 409, `listen_limit_server`, `listen_unavailable` 503. (b) The socket's close codes and the code each end reason closes with (§3). (c) The session table carries a CHECK that a listener is never the call's agent, a backstop under `listen_own_call`, and has no foreign keys (it outlives its call, campaign and users). (d) Its Down refuses while any row exists. (e) Retention ages a row by its start, open or not: an open row past 85 days can only be one a dead process left, which the boot reap closes long before. (f) The live row carries `inbound_route_name` for "Inbound: <route>", which the field list in the design did not name. (g) `AGENCY_LISTEN_MAX_PER_USER` is a setting (default 1, at most 5). (h) `webrtc_relay_dwell_seconds` samples one frame in 50 per call and direction. | **Decided** (Manas, 2026-11-17) |
| LS15 | **Phase 2's own calls.** (a) The fault budget counts each leg's failed frames in a row apart: a dead customer leg is not kept attached by the agent's good frames. (b) A sink whose `send` throws, or answers `closed`, is ended `listener_disconnected` (4408, the console reconnects); `tap_error` is the budget only. (c) A sink's `frames_dropped` counts the frames it did not get: dropped at its soft limit, and the frames the tap failed while it was attached. (d) A call is listenable once the bridge has been announced (`bridged`: both legs live, the carrier's media negotiated), and stays so through the agent's re-attach window; a parked inbound caller, answered but with no agent bound, is `not_bridged`. (e) The tail of the customer leg needs the carrier's media negotiated and drops a payload too big to relay, as the relay does; an agent message the relay would refuse (not whole 20 ms frames) is not the tap's either. (f) A call's listeners end `call_ended` as soon as the call starts to settle: when a hangup of ours starts VoiceLink's wait for the carrier's confirmation (`ending`, up to 45 s, through which the agent's socket stays bound and keeps sending its microphone) and at the top of the terminal teardown (`endCall`, before its awaits), so nothing either party says after the hangup reaches a listener; a new `openListenTap` is refused `ending` until the session is gone (`not_found`). Revised by the voice review: it first kept the listener attached through `ending`, and the agent's leg still fed it. (g) As on the station, media alone stops at the soft limit, so the hard cap (`send_backlog`) is reached only by other bytes queued on the listener's socket (its control frames); a listener whose every frame has been dropped at the soft limit for 10 s is ended `send_backlog` too (LS17 b), so one that stopped reading but keeps pinging is not kept for ever. | **Decided** (Manas, 2026-11-17) |
| LS16 | **Phase 3's own calls**, 22 of them, (a)–(v), listed one by one under the table ("LS16 in full"); the letters are stable, other docs and code comments cite them. In short: where the grant's handler sits and the upgrade's order (a, b, n, q); revocation, failing closed on the immediate path and open with a staleness cap on the periodic one (c, d, amended by LS21), the flags read strictly (d), the super-admin's routes (t); one listen per supervisor across processes (e, p, r); the list's `listenable` (f); shutdown (g); the client message bound (h); the live row's extra fields and the call reads (i, j, k, m, u); the counters (l); the rows' upkeep (o) and retention (s); the handoff's redacted URL (v). | **Decided** (Manas, 2026-11-17) |
| LS17 | **The voice review's calls.** (a) A μ-law customer (Plivo, `wireFormat: 'mulaw8'`) reaches the tap's listeners through a 256-entry μ-law → A-law table (`MULAW_TO_ALAW`: each code decoded to 16-bit linear and re-encoded as A-law, what the bridge's own μ-law path does for the agent without its resampling; G.711's own μ-law to A-law table differs on 44 codes by one A-law step each, a scale convention (G.711 puts the two laws' overload at the same level, a 16-bit decode puts μ-law at exactly half A-law's scale) plus the sign of μ-law's negative zero, inaudible, and the table is kept so a listener hears the agent's quantisation; the final review pinned both against G.711's table as literals), not through the tap's own carrier codec and A-law encoder as §2 first said: both are 8 kHz, so the codec path's two resampling filters only cost CPU and a frame of lag (its first output is 144 bytes) and soften the top of the band; the table's A-law is at least as close to what the caller sent on tones from 300 Hz to 3.4 kHz. A carrier with no G.711 law keeps the codec path. A transcoded leg's first output is led by A-law silence to a whole frame (8 bytes, 1 ms, for 20 ms of `pcm16`), so it runs carry-free. (b) A listener whose every frame has been dropped at the soft limit for `LISTENER_SOFT_LIMIT_MAX_MS` (10 s), with none sent between, is ended `send_backlog` (4408), counted `websocket_send_backpressure_total{socket="listener",action="closed"}`, its last frame counted dropped too; measured on `bufferedAmount` as `ws` sees it, a constant rather than a setting. (c) A failed message counts its 20 ms frames (a failed 1 s agent message is 50) in the sink's `frames_dropped` and the leg's fault budget; `agency_listen_tap_errors_total` counts failed steps. (d) The alert on the tap's cost is `agy-listen-loop-delay` (event-loop delay p99 above 40 ms for 10 min while listens are open), replacing `agy-listen-relay-dwell-regressed`: the dwell excludes the tap by construction, and the load check saw the tap's cost on the loop only. | **Decided** (Manas, 2026-11-17) |
| LS18 | **The inbound consent gap is accepted, and closed by the checklist.** The inbound notice plays only on a recorded call (the route records and the account allows recording) whose route has its notice on, while an unrecorded call can be listened to by default (LS4): a caller on a route that does not record, has its notice off, or plays a custom notice clip that says only "recorded" is not told the call may be monitored. Left as it is: tenants own their route settings, and the product neither changes nor blocks them. The enablement checklist ([`operations.md`](operations.md) "Enabling live call listening for a tenant", item 2, with the query that lists such routes) makes it an explicit step before the flag goes on: every inbound route that should be monitorable plays a notice that mentions monitoring, or `agency_live_listen_unrecorded` is turned off for that tenant or account. | **Decided** (Manas, 2026-11-16) |
| LS19 | **The account's listening history.** An account-level "Listening history" (who listened, the agent, the call type, the masked customer, start, time listened, how it ended in words, a link to the call where one exists; filters for supervisor, agent and date range; CSV), and readable listen rows on a campaign's History. Gate: `agency.supervise` alone (amended 2026-11-17; it was `agency.supervise` and `agency_live_listen_enabled`): turning listening off stops new listens, not the record of past ones, so the history's routes never read the flag (no `403 feature_disabled`, no `503` on a flag store outage) and the console offers the page whether the flag is on or off. Built server side (§12): (a) `GET /proxy/agency/listen-history` and `.csv` through the internal `GET /api/v1/agency/listen-history` (owner `none`), account scoped, keyset-paged newest first; (b) a supervisor's sessions on one call are merged into one entry ON THE SERVER, in the history's SQL, while each starts at most `AGENCY_LISTEN_HISTORY_MERGE_GAP_MS` (30 s, twice the console's reconnect window) after every earlier one ended or while one is still open, so the page and the CSV show the same entries; the time listened counts overlaps once and gaps not at all; the date range filters sessions by their start before the merge; (c) the CSV carries masked numbers only ("Withheld" for a withheld caller) and is audited `agency_listen_sessions.exported` (the actor, the filters, the rows, any truncation; resource type `account`), as every bulk export here is; at most 10,000 entries and 30 s, past either cut and marked (`X-Export-Truncated`); (d) the words for each end reason are the contract's `AGENCY_LISTEN_END_REASON_LABELS`, shared by the page and the CSV; (e) a campaign History listen row carries `detail.agent_name`, resolved at the read in the page's one identity read (never written to the audit row). The console's page, the readable History rows and "Listened to by" merged by the same rule are in §12. | **Decided** (Manas, 2026-11-16); amended 2026-11-17: the history is gated by `agency.supervise` alone, so turning listening off does not hide past listens; (a)–(e) are the build's calls, **Decided** (Manas, 2026-11-17) |
| LS20 | **Guard rails on the consent gate.** All three: (a) a handling policy on `agency_live_listen_enabled` in the super-admin flag routes (`feature-flags/flag-policies.ts`, served as the catalog's `policy` and enforced on every write): turning it on for a tenant or account needs a reason (`400 flag_reason_required`); the bulk rollout refuses it (`422 flag_bulk_not_allowed`), and so does a GLOBAL On, which is every tenant at once (a global Off, the kill switch, stays allowed; the super-admin registry says why instead of asking for a reason); the super-admin UI's warning, reason dialog and bulk list already read the policy; (b) the enablement checklist in [`operations.md`](operations.md) (LS18's inbound item included); (c) a read-only line in the account's Settings, "Live call listening: On / Off", whether calls that are not recorded are included, and "Ask your account manager to change this.": served by making `agency_live_listen_unrecorded` client-exposed, so the console reads both flags from the client flag map (`GET /feature-flags`) as it already reads `agency_live_listen_enabled` for the Live calls page and the agent's line, rather than a new settings read; the server still computes `listenable` and refuses the grant itself. The global-On refusal (a) and the choice in (c) are the build's calls. The env default `FF_AGENCY_LIVE_LISTEN` bypasses (a): dev and staging only, warned at boot (LS22 p). | **Decided** (Manas, 2026-11-16); the calls in (a) and (c) **Decided** (Manas, 2026-11-17) |
| LS21 | **When access cannot be checked** (persona review, decision 4). The periodic re-check ends a session not verified for 2 × `AGENCY_LISTEN_RECHECK_MS` (60 s at the defaults; `STALE_AFTER_RECHECKS` was 4) with its own end reason, `access_unverified`, and close code 4503 (`AGENCY_LISTEN_CLOSE.ACCESS_UNVERIFIED`), not `permission_revoked`: nothing said the supervisor may no longer listen, so the console says listening stopped because their access could not be checked and offers Try again (the grant checks afresh), never "You no longer have access to listen to calls.". A contract addition (`AGENCY_LISTEN_END_REASONS`, `AGENCY_LISTEN_CLOSE`, `AGENCY_LISTEN_END_CLOSE`; not mirrored in Dart), the metric's `reason` label, and migration `0048_listen_sessions_unverified.sql` extending the end reason's CHECK (0047 unchanged). | **Decided** (Manas, 2026-11-16) |
| LS22 | **The persona review's server calls**, (a)–(m), and the final review's, (n)–(t), listed one by one under the table ("LS22 in full"): `access_unverified` on the immediate path too (a); its close code (b); `live_at` and "Listened to by" (c); protocol pings as liveness (d); the client message rate (e); a refusal sends no `ended` frame (f); the token store's outage (g); every close then terminated (h); withheld numbers (i); the fault budget through the seam (j); the rows' upkeep and the tick (k); seats added by an invite (l); the load check's timing bounds (m); and the final review's: no caching of live-call and history answers (n); the upgrade's database steps bounded (o); the env default `FF_AGENCY_LIVE_LISTEN` dev and staging only, warned at boot (p); a tap that fails to open counted (q); a dead process's rows closed on a retry, `server_restarted` counted for live rows only (r); a supersede reaching a listen mid-upgrade (s); the history's bounded read on its own index, 0049 (t); the agent's one-time notice (u); and the PR review's: the supersede's ranking for any `AGENCY_LISTEN_MAX_PER_USER`, never two listens on one call (v); the member routes not waiting for the re-check, and a seat added leaving an unreadable check to the periodic pass (w). | **Decided** (Manas, 2026-11-17); (v) and (w) the build's calls on the PR review (2026-11-17) |

### LS16 in full

Phase 3's own calls, each where the locked design was silent. The letters are stable (cited by code
comments and the other docs).

- **(a)** The grant's internal handler is `POST /api/v1/agency/listen-grants` (owner `body_session`,
  the agent's session in `session_id`), not `/sessions/:id/listen-grants`: every `/sessions/:id`
  route is the session's own agent's (Q8, `requireOwnedSession`, held by
  `left-session-guards.test.ts`), and a grant is a supervisor's on someone else's session. Its
  `ws_url` is minted at the public path (there is no internal socket path to rewrite).
- **(b)** At the upgrade the caps are reserved BEFORE the row is written, so a refused attach (4429)
  leaves no row; a call the bridge no longer holds once the row is written closes that row
  `call_ended` (4404 `listen_call_not_live`), with no audit pair (it never started).
- **(c)** `revokeUser` re-checks the supervisor's sessions against the database (the periodic
  re-check's question) rather than ending them outright: a role change that still clears
  `agency.calls.listen` (a promotion, another membership) ends nothing. This immediate path fails
  CLOSED: a session it cannot check (a read that throws) ends `permission_revoked` too; the
  supervisor can ask again, and the grant and the upgrade check again.
- **(d)** The periodic pass fails OPEN, with a staleness cap: a session whose check cannot be made
  keeps going, but one not verified for 4 × `AGENCY_LISTEN_RECHECK_MS` (2 min at the defaults;
  `STALE_AFTER_RECHECKS`) ends `permission_revoked`, whether its checks fail or a pass hangs. A flag
  store that cannot be read is such a failure, not a flag value: both flags are read through
  `FeatureFlagService.strictSnapshot` (a read failure rejects; the registry defaults would end every
  listen through `agency_live_listen_enabled`, default off, and open LS4 through
  `agency_live_listen_unrecorded`, default on), and the grant answers it `503 listen_unavailable`.
  Coordinator decision of the server review, 2026-11-16. Amended by LS21 (decision 4 of the persona
  review): the cap is 2 × the re-check (60 s at the defaults) and the session ends
  `access_unverified`, not `permission_revoked`; the immediate path's unreadable checks end
  `access_unverified` too (LS22 a).
- **(e)** One listen per supervisor across processes: a listen admitted in one media worker ends the
  supervisor's older listens in the others (`listen.revoke` `superseded`, naming the listen ids,
  worker → primary → the other workers); the primary holds no listen while workers run.
- **(f)** The list's `listenable` is computed from the open rows (every process); the grant's
  handler and the upgrade check the owning process's registry; a supervisor's own open listen on a
  call never counts against them (a reconnect supersedes it).
- **(g)** In one process, as HTTP closes the WebSocket plugin closes every socket first (no code:
  the console reconnects, as for 1001), then the listens end `server_shutdown` with their rows
  closed, so no `ended` frame goes out; a media worker ends its listens before its app closes
  (`ended { server_shutdown }`, 1001).
- **(h)** The listener socket reads at most 256 bytes a message (`LISTEN_MAX_CLIENT_MESSAGE_BYTES`);
  a longer message, a binary one or one that does not parse is ignored and does not count as
  liveness.
- **(i)** The live row's `aht_seconds` is the campaign stats' `aht_seconds` (one SQL fragment,
  `ahtSecondsSql`), read at most once a minute per campaign per process.
- **(j)** A withheld inbound number masks as `****`. Superseded in the console by LS22 (i): the row
  also says `customer_phone_withheld`, so the console shows "Withheld" and offers no Show.
- **(k)** `listen_sessions` is on the campaign attempt read and the soft-phone call read (the two
  pages with "Listened to by"), absent when it could not be read; the inbound call read is
  unchanged. Since LS22 (c), only the sessions that went live (`live_at` set).
- **(l)** `agency_listen_grants_total` counts the HTTP grant's outcomes; refusals at the upgrade are
  in the logs and the rows, not that counter (one exception, the server's own failure: a tap that
  throws as it opens is counted `agency_listen_tap_errors_total{stage="open"}`, LS22 q).
- **(m)** `AgencyLiveCall` gained `correlation_id` (the spine row, for "Open call") and
  `aht_seconds` (additive, asked for by the console phase).
- **(n)** The upgrade asks the database too, after the reservation and before the row
  (`ListenRegistry.verify`, the re-check's question): 4403 `permission_revoked` if the supervisor
  may no longer listen, 1011 `listen_unavailable` if it cannot say; and a per-supervisor revocation
  generation, bumped by every `revokeUser` in that process (a promotion too), is recorded in the
  grant's token and again in the reservation: a token minted before a revocation is refused at the
  reservation (4403), and a revocation between the reservation and the admission refuses the
  admission (the row just written closes `permission_revoked`, 4403, no audit pair). A flag turned
  off bumps nothing: the upgrade reads the flag, and a session already open ends on the next pass
  (LS10's lag for flags).
- **(o)** A row close that fails is retried with its own reason and counters on every re-check tick
  until it lands (at most 1,000 wait), and each tick sweeps this process's open rows that nothing
  here holds (no session, no reservation, no close in flight or queued) and that started over 60 s
  ago, closing them `server_restarted` (the contract's reason for a session that outlived its
  process's knowledge of it; it has no other): `listen/listen-rows.ts`, `closeOrphans(replicaId, {
  keep, minAgeMs })`.
- **(p)** A listen admitted in one worker supersedes only the supervisor's rows OLDER than its own
  (`started_at`, then id): two listens admitted at once in two workers end the older one, never
  both.
- **(q)** A stopping process refuses a grant and an upgrade `listen_unavailable` (503, 1011: try
  again, a fresh grant reaches the process that owns the call), not `listen_limit_server`, which is
  the server's cap and feeds its alert.
- **(r)** `maxPerUser` counts a supervisor's listens per tenant: a user id is global, a listen
  belongs to its tenant, so a supervisor with memberships in two tenants may hold one in each.
- **(s)** Retention (LS12) follows the audit partitions rather than the exact cutoff: a session row
  goes when it started before the first instant of the cutoff's UTC month, the boundary below which
  the maintenance has dropped every audit partition, so it goes the same day as its month's audit
  rows.
- **(t)** The super-admin role change and member removal (`api/routes/super-admin/tenants.ts`) re-check
  the listens too (`membershipRevoked`, which drops the cached membership first); so does its add-user
  route (`membershipAdded`, LS22 l).
- **(u)** The live list's AHT cache holds at most 1,000 campaigns per process (a `TtlCache`: an
  entry past its minute is read again, the least recently read go past the bound); the dialler spine reads the account's live attempts on
  `idx_agency_attempts_account_live` (pinned by `test/integration/agency/live-call-plan.test.ts`).
- **(v)** The handoff's refusal log lines carry the upgrade's URL redacted (`redactSpanUrl`): a
  station or listener token is unspent there.

### LS22 in full

The persona review's server calls (2026-11-16), beside the decided LS21, and the final review's
(n)–(u); each decided (Manas, 2026-11-17). (v) and (w) are the build's calls on the PR review's
comments (2026-11-17).

- **(a)** The immediate path (`revokeUser`, a role change or a removal) still fails closed (LS16 c),
  but a session it could not check ends `access_unverified`, like the periodic pass's: no read said
  the supervisor may not listen. What a read says no to still ends `permission_revoked`.
- **(b)** `access_unverified` closes 4503 (`ACCESS_UNVERIFIED`, the private code that mirrors HTTP
  503, as the others mirror theirs). The console stops and offers Try again; a console built before
  it reads 4503 as an ordinary drop and reconnects, which is safe (the grant refuses while the check
  cannot be made).
- **(c)** `agency_listen_sessions.live_at` (0048): when the session went live (admitted, `ready`
  sent). Stamped as it goes live, not awaited (audio is never held for it), and written by the close
  as the start when that stamp did not land; NULL for a row the upgrade wrote and then refused (the
  call gone before the tap, a revocation before the admission, the client gone), which carried no
  audio. "Listened to by" (`listForCall`) reads only live rows. Accepted (final review): a session
  that went live whose stamp did not land before its process died is closed by a reap (LS16 o,
  LS22 r), which cannot know it carried audio (its frame counters died with the process), so it
  stays out of "Listened to by" and the history; its `agency_call.listen_started` audit row, if
  written, still records the listen. Rows from before 0048 are backfilled
  with their start (they were all shown). The live list's listeners still read every open row: an
  upgrade between its row and its admission lasts milliseconds, and counting it keeps the list's
  per-call cap with the registry's reservations.
- **(d)** Liveness: the server pings the listener socket at the protocol level every 10 s
  (`AGENCY_LISTEN_PING_INTERVAL_MS`) and counts the pong as a client frame, so a hidden tab whose
  timers are throttled to once a minute is not ended `listener_disconnected` while its browser still
  answers pings. The JSON `ping` stays answered; the 30 s idle bound is unchanged.
- **(e)** A listener socket's client messages are rate-limited: a bucket of 20, refilled at 5 a
  second (`LISTEN_CLIENT_MESSAGE_BURST`, `LISTEN_CLIENT_MESSAGES_PER_SECOND`), every message counted,
  binary or text, before `ready` or after. Past it the socket closes 1008 `listen_message_rate` and
  a live session ends `listener_disconnected`. An honest console sends a ping every 10 s.
- **(f)** Only a session that went live sends `ended { reason }`; an end during the upgrade is a
  refusal, closed with the refusal's own code. So: a tap that ended under the attach (the sink closed
  at once, the handle detached) is the call gone, 4404 `listen_call_not_live` (the row `call_ended`);
  opening the tap throwing is the server's failure, 1011 `listen_unavailable` (the row `tap_error`),
  not the call's end; a process that started stopping while the row was written refuses 1011
  `listen_unavailable`, as it does at the reservation (LS16 q), where it used to send
  `ended { server_shutdown }` and 1001; a revocation between reservation and admission closes 4403
  with no `ended` frame.
- **(g)** A token store that cannot be asked at the upgrade (Redis down) is 1011
  `listen_unavailable`, not 4401 (`listen_token_invalid`, which re-mints at once): the grant already
  answers the same outage 503. A `token` query given twice is no token (4401) before anything reads
  it.
- **(h)** Every server close of a listener socket is close-then-terminate (`closeThenTerminate` in
  `utils/ws-backpressure.ts`, the station's backlog close generalised): a reader that stopped never
  completes the close handshake, and `ws` would hold its buffers for its own 30 s. The route's own
  refusals before the token (`proxy-agency-listen.routes.ts`: a malformed id, no token, no runtime,
  an upgrade that threw) are closed the same way.
- **(i)** A withheld number (an inbound caller with no readable number: no digit at all) is said so:
  the live row gains `customer_phone_withheld` (optional in the type so the console's older fixtures
  still type; the server always sends it) beside the unchanged `customer_phone_masked` (`****`), and
  the number reveal answers `404 live_call_number_withheld` (`AgencyLiveCallNumberErrorCode`, a union
  of its own, so the listen codes and the console's copy for them are unchanged) rather than an empty
  number.
- **(j)** The tap's fault budget comes through the seam (`openListenTap`'s `options`,
  `ListenTapOpenOptions`, `docs/seams.md` §3.1): the voice area reads no agency config; with none,
  `LISTEN_TAP_DEFAULT_FAULT_BUDGET` (50). The tap's own error counter stays the agency area's metric
  (`agency_listen_tap_errors_total`), emitted from voice on purpose, beside the series it is read
  with.
- **(k)** The rows' upkeep reads the registry's held ids right before its sweep, after its retries
  (a getter, not a snapshot taken when the tick began): a retry against a slow database can outlast
  the sweep's 60 s age floor. A tick that finds the last one still running starts no pass and no
  upkeep of its own and only applies the staleness cap, so hung ticks never stack.
- **(l)** Adding a seat re-checks the invitee's listens: `POST /users/invite`, the invite's
  claim and the super-admin's `POST /super-admin/tenants/:id/users` re-check them too (`membershipAdded`), since an account-scoped seat is the membership the tenant context
  picks in that account and can shadow a tenant-wide admin's (the access check shares the tenant
  context's `selectMembership`, now `rbac/select-membership.ts`). The tenant context reads
  `X-Tenant-Id` and `X-Account-Id` lower-cased, as the access check reads the account, so an
  upper-case header cannot miss the account seat and act under the wider tenant-wide role.
- **(m)** The load check's timing bounds (§10 "Load check") are asserted with 4 or more CPUs, or
  when asked (`LISTEN_LOAD_BOUNDS=on`, a `LOAD_SCALE` soak), and printed otherwise; everything else
  in it (zero frames lost, every listener's rate, ends and rows, the stalled listener, the metrics,
  the leak check) is asserted on every run. The wall-clock lane runs on every server PR, and on a
  busy 2-core runner two windows 20 s apart differ by more than the listeners. CI does not set
  `LISTEN_LOAD_BOUNDS` (on a `full-ci` run the bounds apply only if the runner has 4 CPUs).
- **(n)** The live-call routes and the history's page answer `Cache-Control: no-store`, refusals
  included, as the export already did (final review): the number reveal is the one answer with a
  customer's full number (LS9's "masked again on leaving the page" must not be undone by a browser or
  proxy cache), and the list and the history name supervisors and customers (masked). A call
  detail that carries `listen_sessions` ("Listened to by") answers it too (one `noStore` /
  `noStoreHook`, `api/routes/helpers/no-store.ts`).
- **(o)** Each of the upgrade's two database steps, the access check (LS16 n) and the row's insert,
  is bounded by `LISTEN_UPGRADE_STEP_TIMEOUT_MS` (10 s, a constant): past it the reservation is
  given back and the upgrade refused 1011 `listen_unavailable` (the console retries, bounded). A
  connection that hangs without an error (the pool sets no `statement_timeout`) would otherwise
  hold the slot as long as it hung, until the call's cap (`listen_limit_call`) and then the
  process's (`listen_limit_server`, and its alert) refused everyone. An insert that lands after its
  upgrade gave up is a row this process does not hold: its sweep (LS16 o) closes it
  `server_restarted` once it is 60 s old. A client closed 1008 for its message rate while the
  access check ran gets no row.
- **(p)** The env default `FF_AGENCY_LIVE_LISTEN=true` turns the consent gate on for every tenant,
  with no reason and no audit row: what LS20 (a) refuses a global On for, on a path the super-admin
  routes cannot see (as is deleting a global `false` override while it is set). It is kept as a dev
  and staging convenience, documented as such (`.env.example`, `docs/operations.md` "Key settings"
  and the enablement checklist), and boot logs a warning line while it is set
  (`warnOfEnvDefaultsPastPolicy`, `feature-flags/flag-policies.ts`, from `startPlatform`); the flag
  service is unchanged. `FF_AGENCY_LIVE_LISTEN_UNRECORDED` narrows rather than grants and needs no
  such warning.
- **(q)** Opening the tap throwing (LS22 f) is counted `agency_listen_tap_errors_total{stage="open"}`,
  so `agy-listen-tap-errors` sees a bridge that cannot open a tap for anyone; the other refusals at
  the upgrade stay in the logs and the rows (LS16 l).
- **(r)** The dead processes' close (at boot, and when the primary reaps a dead media worker:
  `closeOrphansExcept` with this process and the media workers alive now) goes through
  `ListenRowKeeper.closeDeadProcesses`; a close that fails (a database blip often comes with what
  killed the worker) is run again on the primary's every re-check tick until it lands, with the live
  processes read afresh, rather than leaving the rows open until the next boot: each live process
  sweeps only its own `replica_id`, so nothing else would close them, and an open row reads
  "Listening now" in the history and draws a supersede aimed at nothing. Every sweep counts
  `agency_listen_sessions_ended_total{reason="server_restarted"}` only for the rows that went live
  (`live_at` set), as the socket counts only live sessions.
- **(s)** A cross-process supersede (LS16 e, p) reaches a listen still in its upgrade: the worker it
  names may hold it as a reservation (its row written, which is how the other worker read it, not
  yet admitted), and `endSessions` marks it, so its admission is refused `superseded` (the row
  closes `superseded`, 4409 as a live session's supersede, no `ready`, no audit pair) instead of
  being admitted after the supersede passed it by, which left the supervisor two listens. (This
  letter used to accept that with `AGENCY_LISTEN_MAX_PER_USER` 2 or more a supervisor could hold
  one listen over the cap across processes; (v) closes it.)
- **(t)** The listening history reads one page's visits, not the account's history (final
  review): every page used to window every session the filters kept in the account (the whole
  tenant's, without a supervisor filter, to find them), and the CSV drains up to 100 pages. A
  visit's start is the session no earlier kept session of the same supervisor on the same call
  is open or within the gap of (the merge's own rule, asked of one session), so `LISTEN_HISTORY_SQL`
  first walks the account's live sessions newest first from the cursor on
  `idx_agency_listen_sessions_account_started` (`0049_listen_history_index.sql`, `(tenant_id,
  account_id, started_at DESC, id DESC) WHERE live_at IS NOT NULL`), each probed on its call, cut at
  the page, then windows only those calls' sessions. The entries are unchanged (the history's
  integration tests); the plan and the rows a page reads are pinned on 20,000 seeded sessions
  (`agency/listen-history-plan.test.ts`).
- **(u)** The agent is also shown LS2's standing line once, unprompted: an agent with one campaign
  is taken straight to the station and may never open the "Monitoring and recording" button, so
  the first time an agent opens the station or a soft phone for an account while the flag is on, a
  notice says it until they press Got it. The console's `StationListenFirstNotice` (a strip under
  the header, remembered per browser) and the app's `ListenFirstNoticeCard` (remembered per phone;
  on a call it says the line can be read again under "Monitoring and recording" between calls, as
  the on-call band has no button). Agent-facing words beyond LS2's two places, the build's call
  (§9 "The agent").
- **(v)** The supersede, for any `AGENCY_LISTEN_MAX_PER_USER` (the PR review): one rule
  (`supersededBy`, `listen-registry.ts`) ranks a supervisor's other listens newest first and ends,
  `superseded`, every one on the new listen's call (a supervisor never holds two listens on one
  call, and those take no place under the cap) and, of the rest, those past the newest
  `maxPerUser - 1`. The registry applies it to its own sessions at the admission, and its grant
  and reservation check (`check`) leave what the listen would end out of both counts, so the
  caller's own listens on the call never count against the per-call cap, as the live list's
  `notListenableReason` already said: a console re-granting the call it was on before the server
  noticed its socket drop is not refused `listen_limit_call` by its own stale session. With media
  workers, the admitting worker then applies it to the supervisor's open rows OLDER than its own
  (LS16 p), this process's and the others' ranked together (`supersedeTargets`,
  `listen-revocation.ts`), and ends what falls past it wherever it is: its own sessions (or
  reservations, LS22 s) here, the others' through the primary. Before, that pass dropped the local
  rows, and the admission had ranked only the local sessions, so with a cap of 2 a listen newer
  than a kept local one but held elsewhere was never ended (holds A on worker 1, B on worker 2,
  starts N on worker 1: N, A and B). The pass ranks nothing once its listen has left the registry
  under the read (a listen with an older row admitted after it ended it there: ranking it then
  would end that one too). At the default 1 every other listen ends, as before.
- **(w)** The member routes do not wait for the listen re-check (the PR review). `membershipAdded`
  and `membershipRevoked` (`rbac/membership-changed.ts`) drop the cached membership, call each
  subscriber and answer without waiting for it: the re-check reads the database and awaits each
  ended session's row close, and an admin's role change, removal or invite, and an invitee's
  claim, used to answer only after that work (on a slow database, as slowly; there is no
  statement timeout unless `DB_STATEMENT_TIMEOUT_MS`). The subscribers are still called before
  the route answers, after the cache drop, so the registry's revocation generation (LS16 n) has
  moved by then and a grant asked after the answer is checked afresh; a subscriber that fails, at
  once or later, is logged and never fails the request. And a seat added no longer fails closed:
  the subscribers are told which change it was (`added` or `revoked`, carried to the media workers
  on `listen.revoke` as `change`), and on `added` the re-check (`revokeUser(tenantId, userId,
  'added')`) leaves a session it could not check to the periodic pass, whose staleness cap (LS21)
  still ends it `access_unverified` if no check succeeds, instead of ending it at once: a
  transient read failure while a listening supervisor is invited to a second account no longer
  ends their listen when nothing said their access shrank. A read that says no still ends it
  `permission_revoked` at once (an account-scoped seat can shadow a tenant-wide admin's, LS22 l),
  and a role change or a removal still fails closed (LS16 c, LS22 a).

## 2. Architecture

Five pieces, each in the module area that owns its kind of work:

1. **The tap** (`apps/server/src/core/bridge/listen-tap.ts`, voice; phase 2, built): per bridge
   session, a fan-out of both legs to its listeners' sinks, normalised to A-law 8 kHz in 20 ms
   frames (§5 "The tap as built").
2. **The bridge seam** (phase 2, built): the `WebRtcBridgeManager` member
   `openListenTap(callId, sink, options?): ListenTapHandle | { refused: 'not_found' | 'not_bridged' | 'ending' }`
   (`options`: `ListenTapOpenOptions`, the fault budget, LS22 j; types in `core/bridge/bridge-types.ts`),
   pinned with `docs/seams.md` §3.1 by the seam contract tests.
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
copies the frame behind a tag byte. A Plivo customer leg is μ-law (`wireFormat: 'mulaw8'`): the tap
maps it to A-law one byte at a time through `MULAW_TO_ALAW` (LS17 a: both 8 kHz, nothing to
resample), only while someone listens; a carrier with no G.711 law would go through the tap's own
codec instance to PCM16 16 kHz and its own `VoicelinkTranscoder.pcm16kToAlaw`. A `pcm16` agent leg goes through
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
- **Protocol pings** (LS22 d): the server pings the socket every 10 s and counts the pong (which a
  browser sends by itself, throttled tab or not) as a client frame. At most 20 client messages at
  once, refilled at 5 a second; past that 1008 `listen_message_rate` (LS22 e).

**End reasons** (`AGENCY_LISTEN_END_REASONS`, the column's CHECK): `call_ended`, `listener_stopped`,
`listener_disconnected`, `permission_revoked`, `superseded`, `send_backlog`, `tap_error`,
`server_shutdown`, `server_restarted` (closed by the reap; never sent on a socket),
`access_unverified` (the access check could not be made for too long, LS21; appended by 0048).

**Close codes** (`AGENCY_LISTEN_CLOSE`) and what the console does:

| Code | Name | When | Console |
|---|---|---|---|
| 1000 | `NORMAL` | `call_ended`, `listener_stopped` | stop ("Call ended · you listened for mm:ss") |
| 1001 | `GOING_AWAY` | `server_shutdown` | reconnect |
| 4401 | `TOKEN_REJECTED` | at the upgrade: the token is missing, spent, expired or not this listen's | re-mint and retry |
| 4403 | `FORBIDDEN` | `permission_revoked` | stop ("You no longer have access to listen to calls.") |
| 4404 | `CALL_GONE` | at the upgrade: the call is no longer live in this process (`listen_call_not_live`) | stop |
| 4408 | `HEARTBEAT_TIMEOUT` | `listener_disconnected` (30 s silence), `send_backlog` | reconnect |
| 4409 | `SUPERSEDED` | `superseded`; at the upgrade, a supersede from another process while it was admitted (LS22 s) | stop ("You started listening in another tab or window, so it stopped here.": the console stops its own first listen before a second, so a supersede it hears of came from elsewhere) |
| 4429 | `LIMIT` | at the upgrade: `listen_limit_call`, `listen_limit_server` | stop, with the reason |
| 1008 | `INVALID_UPGRADE` | a malformed upgrade; past the client message rate (`listen_message_rate`, LS22 e) | stop |
| 1011 | `INTERNAL_ERROR` | `tap_error`; at the upgrade, `listen_unavailable` (no row, no audio; the token store, the tap or the process failing, LS22 f, g; the access check or the row's insert not answering within 10 s, LS22 o) | reconnect, bounded |
| 4503 | `ACCESS_UNVERIFIED` | `access_unverified` (LS21) | stop, "your access could not be checked", Try again (an older console: reconnect) |

`AGENCY_LISTEN_END_CLOSE` maps every reason sent on a socket to its code. A refusal at the upgrade
carries its error code as the close `reason` and sends no `ended` frame (LS22 f); after `ready`,
the end reason, after `ended`. Every server close is followed by a terminate 5 s later if the peer
has not completed it (LS22 h). Any other code is an
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
7. Open the tap, admit (refused if the supervisor was revoked since step 5, or their newer listen
   in another process superseded this one meanwhile, LS22 s), send `ready`, write
   `agency_call.listen_started`.

**End.** `stop` or a socket close removes the sink, closes the row (reason, frames sent and
dropped) and writes `agency_call.listen_ended`. The call's end (`session.destroy()` closes the tap)
sends `ended { call_ended }` and closes 1000. A second listen by the same supervisor ends the first
`superseded`. Shutdown ends every session `server_shutdown`. At boot, and when the primary reaps a
dead media worker, the open rows of the processes that are gone close `server_restarted` by
`replica_id` (`closeOrphansExcept`); a live process's re-check tick retries its failed row closes
and closes its own rows it no longer holds (`closeOrphans`, LS16 o).

**Revocation (LS10).** The role-change and member-removal routes (`api/routes/user.routes.ts` and
the super-admin's `api/routes/super-admin/tenants.ts`) call `membershipRevoked(tenantId, userId)`
(`rbac/membership-changed.ts`: the membership cache cleared, then its subscribers told, not
waited for, LS22 w), whose subscriber here is the registry's `revokeUser`, a re-check of that supervisor
against the database now that fails closed (LS16 c; a seat added leaves what it cannot read to the
periodic pass, LS22 w) and bumps their revocation generation (LS16 n),
and with media workers IPC `listen.revoke` to every worker (`cluster/ipc-protocol.ts`,
`docs/scaling.md` §4.3). The backstop re-checks every open session every 30 s against the database
and the flags, failing open up to the staleness cap (LS16 d), 2 × the re-check, ending a session it
could not verify `access_unverified` (LS21).

**The live list.** `GET /proxy/agency/live-calls?campaign_id=` (`agency.supervise`, the flag) →
`callCore` → `GET /api/v1/agency/live-calls` (owner `none`, SQL only): a union over the three live
spines on their live indexes (`idx_agency_attempts_account_live`, `idx_agency_manual_calls_live`,
`idx_agency_inbound_calls_account_live`, each pinned by `live-call-plan.test.ts`) joined to
`agency_calls`, the session and the contact, plus the open `agency_listen_sessions` rows (`idx_agency_listen_sessions_open`). The public layer adds
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
the leg; the account's open sessions of those calls (`listOpenForCalls`); each campaign's AHT, both read together. The public layer
adds the agent's and the listeners' names (`agentNamesOrNone`), masks the number (`maskPhone`) and
computes `listenable` / `not_listenable_reason` for the caller (`notListenableReason`: their own
call, LS4, the per-call cap not counting their own listen), and says a withheld number so
(`customer_phone_withheld`; the number reveal of one `404 live_call_number_withheld`, LS22 i). The
campaign AHT read costs each campaign's whole history (by `campaign_id` on an index, the same
aggregate as the campaign stats), so it is cached a minute per campaign per process (LS16 i, u). The grant reads the same internal list
for the one call, refuses `listen_own_call` and `listen_recording_off` itself, then `callCore`s
`POST /listen-grants`, which the media-worker injector forwards to the session's worker; that handler
checks its bridge holds the call (`hasActiveCall`), asks the registry (`check`) and mints the
token (`ListenTokenStore.mint`: `<token>|<grant JSON>` under `agency:listen-token:<listenId>`, PX the
TTL). A refusal from the owning process keeps its status; anything else, or no answer, is `503
listen_unavailable`.

**The socket** (`api/routes/proxy-agency-listen.routes.ts`, `wsOwner: { by: 'session', param:
'sessionId', route: 'listen' }`; in the `station` rate-limit bucket; the `token` query redacted in
logs and spans like every `token=`): a non-UUID id 1008, no token (or one given twice) 4401, no
runtime 1011, then `handleListenSocket` (`agency/listen/listen-socket.ts`): the `error` handler
first, then the per-socket message rate (LS22 e); the token spent (`consume`, a Lua
GET-compare-DEL; a grant naming another session is refused 4401 too, and is spent; a store that
cannot be asked 1011 `listen_unavailable`, LS22 g);
the slot reserved (4429; 1011 `listen_unavailable` while stopping; 4403 `permission_revoked` for a
token from before a revocation); the database asked (4403, or 1011 when it cannot say, LS16 n); the
row written and awaited (1011 `listen_unavailable`; a process that began stopping meanwhile 1011
too); the tap opened (refused, or ended under the attach: 4404, the row closed `call_ended`;
opening it threw: 1011, the row `tap_error`; LS22 f); admitted (a revocation since the reservation
closes the row `permission_revoked`, 4403; else the supervisor's older listen ends `superseded`),
`ready`, the row stamped live (`live_at`, not awaited, LS22 c), `agency_call.listen_started`, the
gauge, and a protocol ping every 10 s (LS22 d). `ping` → `pong { ts?, server_ts }`, `stop` →
`listener_stopped`; 30 s without a control frame or a pong → `listener_disconnected` (4408); the
client's close → `listener_disconnected`, nothing sent. A refusal sends no `ended` frame. Every end
runs once: the tap detached (or the tap's own `close`, with its stats), for a live session
`ended { reason }` and the reason's close code (then a terminate 5 s later if the close is not
completed, LS22 h), the row closed with `frames_sent` / `frames_dropped` (and `live_at` if its
stamp never landed), `agency_call.listen_ended` (duration, reason, frames dropped),
`agency_listen_sessions_ended_total{reason}` and `agency_listen_session_seconds`.

**The registry** (`agency/listen/listen-registry.ts`, `runtime.listen`, one per process): the caps
count open sessions and reservations; `revokeUser` (fails closed: what it could not check ends
`access_unverified`, LS22 a), the periodic `recheck` (every `AGENCY_LISTEN_RECHECK_MS`, armed with the
runtime or the worker's shard; fails open up to the staleness cap, 2 × the re-check, then
`access_unverified`, LS21) and the upgrade's `verify` ask `listen-access.ts` (the membership the tenant context
would pick, read from `memberships` in the database, at `agency.calls.listen`;
`agency_live_listen_enabled`; for an unrecorded call `agency_live_listen_unrecorded`; both flags from
one strict snapshot, `readListenFlags`), each supervisor and account read once a pass, a failed read
leaving its sessions unchecked; each tick then hands the rows' upkeep (`listen-rows.ts`,
`runtime.listenRows`) a getter of the ids it holds, read right before the sweep (LS16 o, LS22 k);
a tick that finds the last still running applies only the staleness cap; `shutdown` ends every session `server_shutdown`
and admits nothing more (`listen_unavailable`).

**Across processes** (`rbac/membership-changed.ts`, `agency/listen/listen-revocation.ts`): the role-change and member-removal routes
(and the super-admin's) call `membershipRevoked(tenantId, userId)`, and the three that add a seat (`POST /users/invite`, the invite's claim,
the super-admin's `POST /super-admin/tenants/:id/users`; LS22 l) `membershipAdded`, whose subscribers are the runtime's `revokeUser` (registered by
`startAgency`) and, with media workers, the primary's broadcast of `listen.revoke { reason:
'permission_revoked', listenIds: null, change }` (registered by `startMediaWorkers`; `change` is
`added` or `revoked`, LS22 w). Neither is waited for by the route (LS22 w). A worker that admits a
listen reads the supervisor's open rows, ranks those older than its own (LS16 p) across every replica
(LS22 v), ends its own past the cap and sends `listen.revoke { reason: 'superseded', listenIds }`
for those another replica holds; the primary relays it to the other workers
(`media-cluster.ts`), which end exactly those.

**Sweeps and shutdown.** At boot (`AgencyRuntime.start`, before any listener can attach and before
any media worker exists) every open row of another replica closes `server_restarted`; when the
primary reaps a dead media worker, every open row of a replica not alive now does
(`closeOrphansExcept`, pinned with a worker killed mid-listen by `cluster/live-listen.test.ts`);
both go through `ListenRowKeeper.closeDeadProcesses`, and one that fails is run again on the
primary's next re-check tick, with the live processes read afresh (LS22 r). While a process runs, its re-check tick retries a failed row close and
closes its own rows it no longer holds (`closeOrphans`, LS16 o). Shutdown: the listener route's `preClose` (one process, LS16 g), the media
worker's shutdown before its app closes, and `AgencyRuntime.stop` / `stopShard` as a backstop.

**The call detail.** `GET /proxy/agency/campaigns/:id/attempts/:attemptId` and
`GET /proxy/agency/softphone/calls/:id` (with `agency.supervise`) add `listen_sessions`
(`AgencyCallListenSession[]`, `callListenSessions` in `api/routes/helpers/listen.ts`): the sessions
that went live only (LS22 c). An agent reading their own soft-phone call (no `agency.supervise`)
gets no `listen_sessions`.

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
`onBrowserBinary` (`alaw8` agent) each bound the frame and, for the JSON legs, decode its base64
once (only when the relay or a tap will take it), then call the relay (`relayPstnMedia`,
`relayBrowserPcm16`, `relayBrowserAlaw`, `relayCarrierToAlawBrowser` inside the first) and then a
tail: `const listen = session.listenTap; if (listen !== null) listen.feed…(buffer)`, the same
decoded Buffer, which no consumer writes to. The tail runs whether or not the relay wrote (the
agent's socket inside its re-attach window, the carrier's socket gated), and only after
`recordRelayFrame`, so the dwell excludes the tap. With nobody listening the tail is that one read:
no codec, no tap call, no send.

**The legs.** Customer: the carrier's wire audio as the bridge decoded it; A-law on the wire
(VoiceLink) is copied; μ-law (Plivo, `wireFormat: 'mulaw8'`) is mapped by the 256-entry
`MULAW_TO_ALAW` (LS17 a), a whole 20 ms frame with nothing carried straight into its message; anything else goes through the tap's own `carrier.media.createCodec()` to
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
`stage="send"`); the other sinks get the frame. `sendToListenerSocket(ws, message, drops)` is the
socket-backed `send` phase 3's socket uses: `sendVerdict` under `LISTENER_LIMITS` (its
`softLimitMaxMs` measured by the socket's own `MediaDropRun`, `utils/ws-backpressure.ts`), counting
`websocket_send_backpressure_total{socket="listener"}`, a throwing `ws.send` answered `closed`.
The handle's `stats()` and `close`'s second argument give `framesSent` and `framesDropped` for the
session row.

**Faults.** Every feed is one try/catch with its stage (`decode`: the μ-law table or the carrier
codec; `encode`: the A-law encoder; `frame`: the priming, the framer and the message),
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

**`agency_listen_sessions`** (`0047_listen_sessions.sql`, `0048_listen_sessions_unverified.sql`,
`0049_listen_history_index.sql`; `packages/db/BASELINE.md`): `id` (the
listen id), `tenant_id`, `account_id`, `call_id` (no FK), `origin` (`AGENCY_CALL_ORIGINS`, the
same list as `ck_agency_calls_origin`), `campaign_id` (set for a dialler call), `correlation_id`
(the spine row), `agent_session_id`, `agent_user_id`, `listener_user_id`, `started_at`, `ended_at`
and `end_reason` (both or neither; `access_unverified` since 0048), `frames_sent`, `frames_dropped`,
`replica_id`, and `live_at` (0048, LS22 c: when it went live; NULL for a row the upgrade refused).
No foreign keys.
Indexes: the open sessions per account (partial), by call, by supervisor newest first, and (0049,
LS22 t) an account's live sessions newest first for the history. 0047's Down refuses while any row
exists. The repository (`AgencyListenSessionRepository`, via the agency
barrel): `open`, `markLive`, `close` (an open row only: the first close wins; `live` fills
`live_at` when its stamp was lost), `listOpenForCalls`, `listForCall` (live rows only), `listOpenForListener`, `closeOrphans(replicaId, { keep, minAgeMs })`
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
before them: a pass in which an audit partition purge failed (a lock timeout, say) skips the
horizon tables (`horizonSkipped`), and the next pass retries both (final review).

## 7. Permission, flags, config

- `agency.calls.listen`, floor `account_admin` (LS3); the list and the number need
  `agency.supervise`.
- `agency_live_listen_enabled` (default off, client-exposed, `FF_AGENCY_LIVE_LISTEN`) and
  `agency_live_listen_unrecorded` (default on, client-exposed since LS20 for the account's Settings
  line, `FF_AGENCY_LIVE_LISTEN_UNRECORDED`). `agency_live_listen_enabled` has a handling policy in the
  super-admin flag routes (reason to turn on, no bulk, no global On; LS20). Its env default,
  `FF_AGENCY_LIVE_LISTEN=true`, is dev/staging only: it bypasses that policy (LS20 a), with no reason
  and no audit row, for every tenant; boot logs a warning while it is set (LS22 p). It gates
  listening (the live list, the number, the grant, the socket, the console's Live pages, the bar
  and the agent's line), not the record of past listens: the Listening history (page and CSV) and a
  call's "Listened to by" need `agency.supervise` alone (LS19, amended 2026-11-17).
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
| `agency_listen_sessions_ended_total` | counter | `reason` (the end reasons, `access_unverified` included) | how sessions end |
| `agency_listen_session_seconds` | histogram | | how long a listen lasts (reaped sessions excluded) |
| `agency_listen_tap_errors_total` | counter | `stage` (`decode`, `encode`, `frame`, `send`, `open`) | frames the tap dropped; `open`: opening the tap for a listener threw (LS22 q) |
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
beside "All calls" (gated by `agency.supervise` and the flag); a campaign's
`/agency/campaigns/:id/calls/live` with a "Summary | Live" control on its Calls tab. The table:
"Live calls", "N in progress", "Updated N s ago"; filters for campaign (account page only), agent
and type (All, Dialler, Soft phone, Inbound), with Clear filters while any is in force; columns
Agent, Customer (name, else "Unknown caller" for a caller who rang in and "No name" for a number we
dialled; the masked number with Show/Hide), Campaign, Type, Time on call (amber past twice the average
handle time), Recording ("Recording" / "Recording off"), Listening, Action. Without
`agency.calls.listen`: no Action column and the footnote "You can see live calls but not listen to
them." Empty: "No calls in progress" / "Calls appear here as soon as an agent is connected to a
customer." Error: "Could not load live calls. Retrying…".

The **listening bar** (`ListenBar`) is docked at the bottom of the console shell and persists across
its pages: the live dot, "<Agent> with ****4321", the campaign and the timer; level meters and mutes
for Agent and Customer; volume (remembered per browser), "Open call", "Stop listening" (Esc while
focused); the notice of LS6, always. Its states are in the design (Connecting…, Live, sound
blocked, "No sound from the agent", "Reconnecting…" then "Connection lost" (the call is not
affected; Try again, Close), "Call ended" over "Priya S. with ****4321 · you listened for mm:ss"
(or "The call ended before you joined."), revoked, turned off, superseded from another tab). The
call page gets "Listened to by" (LS13). The agent's station and soft phone get the standing line of
LS2.

**As built (phases 4 and 5).** Everything above, in these places:

- *Navigation.* `consoleNav.ts` (the Campaigns section's `live` tab, `/agency/live` among its
  paths), `agencyCampaignTabs.ts` (`CAMPAIGN_TABS` `live`, `group: null`, `flag:
  agency_live_listen_enabled`, `barTabFor('live')` → Calls; `CALLS_VIEWS` and `visibleCallsViews`
  for "Summary | Live", drawn by `components/agency/CallsViews.tsx` on both views),
  `consoleSearch.ts` (`PAGE_KEYWORDS` and `CAMPAIGN_TAB_KEYWORDS`: live, in progress, listen,
  monitor), `utils/agency/home.ts`, the routes in `App.tsx` behind `RequireFlag`, and
  `navRouteGates.test.ts`'s rules for both URLs. The Listening history's tab beside it is not
  behind the flag (LS19, amended 2026-11-17; §12). The flag's one name is
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
  cap counts the row's own listeners ("2 supervisors are already listening"; the cap is
  `AGENCY_LISTEN_MAX_PER_CALL`, 1–5, so the words never name it), and falls back to "This call has
  reached its listening limit" with none to count; the refused grant's toast counts them the same
  way from the row the listen started from. The Listening column stacks three initials and "+N"
  for the rest (every name in the title and to a screen reader). The filters offer the agents and
  campaigns in the rows plus the one chosen, kept after its calls end, so a filter in force never
  reads as "All" (`liveCallFilterOptions`); Clear filters is offered beside the chips and under
  "No calls in progress match these filters." while any is in force. No "0 in progress" pill beside
  the empty state; "Updated just now" under a second, and "Updated N s ago" keeps counting while
  reads fail with no rows. While the supervisor's own listen on a row
  is connecting or reconnecting, the row says so beside a Stop. Every word is in
  `utils/listen/listenCopy.ts` (the page's intro, `LIVE_CALLS_PAGE_COPY`, included). Show/Hide calls
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
  storage), the toast for a refused first grant, and the flag or the permission going away here
  ending it: `withdraw` sends `stop` (no sound a moment longer) and the bar stays, saying
  "Listening has been turned off for this account." (the flag, checked first) or "You no longer
  have access to listen to calls.", until dismissed, rather than vanishing as if the supervisor had
  stopped. The server records that end as `listener_stopped` (the client's `stop` carries no
  reason). "Turned off" is read only from a flag map that has loaded (`ready`): while it loads, or
  when it could not be read, the listen goes on (the server's re-check gates it, LS10); a lost
  permission still ends it. The confirmation's Start listening checks again that this listen is
  allowed. "You listened for" leaves out the time between a stop and Try again.
  A browser with no Web Audio, or one that will not make a context, is refused at the click with
  "This browser cannot play the call’s sound, so you cannot listen here." before any grant, so no
  session row or audit is written for a listen nobody could hear. When the listen ends (stopped,
  ended, lost) the provider releases the audio at once: the queued ~600 ms stops and the context
  is suspended, not left running for the shell's life; the Listen click and Try again, both
  gestures, resume it, and a resume that settles after the listen has ended suspends it again.
  `utils/listen/listenSessionReducer.ts` owns every state (idle, connecting, live, reconnecting,
  lost, ended with `call_ended` / `revoked` / `turned_off` / `superseded` / `refused`; the 15 s window opened by
  the first drop and closed only by `ready` or Try again; the first attach has the same 15 s from
  the click, so a grant or a socket that never answers ends in "Connection lost", never
  "Connecting…" for ever; three server failures (1011) in a row end it, counted across `ready`s
  (a tap failing just after every `ready` would otherwise mint a grant, a row and two audit rows
  every few seconds) and counted afresh once the listen has stayed live 10 s
  (`LISTEN_STABLE_MS`); a refused re-grant ends it, or is retried, by its code, a 403
  `feature_disabled` as `turned_off`);
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
  the volume in `magick-agency.listen.volume`, every storage access in try/catch). "No sound
  from the agent" is the agent's leg sending nothing for over 2 s while live: a console agent who mutes
  sends no frames, so the bar does not claim a reconnect it cannot see; "sound blocked" is the
  context not running, lifted by the banner's button.
- *The bar.* `components/listen/ListenBar.tsx`. At phone width (640 px) it is the state in words
  and its dot (Connecting…, Listening, Reconnecting… in the warning colour, Connection lost; a live
  region, as at full width), the timer and Stop, its rows wrapping rather than squeezing, and keeps
  the LS6 notice under them (the notice is never dismissible, so it is not dropped at any width).
  An ended listen's reason wraps at every width and is read in full; only the live "who" lines are
  cut with an ellipsis. Esc anywhere inside the bar stops a listen (or dismisses an ended
  one). **"Open call"** opens the call's own page, as the table's link does (`liveCallPagePath` over
  the listen target's `correlationId`); an inbound call, which has no call page in the console, has
  none (a link to a list of other calls was a dead end), and a soft-phone call's page is not
  offered while `agency_softphone_enabled` is off for the account (the table, the bar and the
  history alike: `liveCallPagePath` takes the soft phone's flag). An ended call's head says "Call ended"
  and the line under it "Priya S. with ****4321 · you listened for 02:10" (at phone width, with no
  head, "Call ended · you listened for 02:10"). "Connection lost" says "The call is not affected."
  and offers Try again and Close, which puts the bar away (a red Stop listening, with nothing left
  to stop, read as acting on the call). The bar sits inside a
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
- *The agent (LS2).* `components/agency/StationListenNotice.tsx`: an info button named
  "Monitoring and recording" in the station header (every station view: campaign, soft phone,
  inbound) and in the standalone soft phone's (`/dialer/phone`, its top bar), opening the
  standing line; the line on the campaign screen an agent joins from (`AgentHomePage`, `/dialer`);
  and, because an agent with one campaign is taken straight to the station and may never open the
  button, `StationListenFirstNotice` (LS22 u): a strip under the station's or the soft phone's header the
  first time this agent opens either in this browser for this account while listening is on, until
  Got it (`magick-agency.listen.agent-notice-seen:<user>:<tenant>:<account>`, try/catch storage;
  blocked storage shows it again next time). The mobile app: the same "Monitoring and recording"
  button in the station header (`lib/features/station/parts/banners.dart`: the idle, incoming and
  link screens; the on-call band has none) and in the soft phone's header on both surfaces (the
  Phone tab and the station's), opening the sheet with the line; and `ListenFirstNoticeCard` at
  the top of the station's idle and call layouts and of the soft phone, the first time per agent
  and account on the phone until Got it (on a call, whose band has no button, it says the line can
  be read again under "Monitoring and recording" between calls; LS22 u) (`listenFirstNoticeProvider`, kept in the app's key-value
  store under `listen.agent_notice_seen:<user:tenant:account>`). All behind the client flag
  (`stationListenNoticeProvider` over `FeatureFlags.liveListenEnabled`, the key `agency_wire` keeps
  beside the other client flags and pins against the contract's `platform.json` fixture); no wire
  type changes.
- *Refusal words.* A refused grant's toast says its code's words (`listenRefusalMessage`). The
  grant's own 503s (`listen_limit_server`, `listen_unavailable`) arrive with their code: the
  route's `sendListenRefusal` marks a 5xx refusal reviewed (`preserveReviewedUpstreamError`), so
  the server's error mask (`error-mask.middleware.ts`) lets the fixed body through, and "busy"
  and "unavailable" read apart. A 503 without a listen code still reads as `listen_unavailable`
  ("Listening is not available right now. Try again."): a worker restarting answers
  `worker_unavailable`, and a 503 from in front of the server has no body to read. A re-grant
  answered 503 is retried within the window either way.
- *Analytics.* `analytics/redact.ts` takes any `token` query value, the listener socket's among
  them, out of a URL on its way to PostHog (`redactTokenQuery`).
- *Liveness (LS22 d).* The console still sends its JSON `ping` every 10 s; the server also pings the
  socket at the protocol level and counts the pong, which a browser sends by itself however its
  timers are throttled in a hidden tab. Nothing in the console answers it.

## 10. Status

| Phase | What | Status |
|---|---|---|
| 1 | Foundation: the permission, both flags, the socket and console contracts, the refusal codes, `0047_listen_sessions.sql` and its repository, the retention sweep, the audit actions and resource type, `agency.listen` config, the metric declarations, the alert group and dashboard row, this document | **Built** (2026-11-16) |
| 2 | The tap and the bridge seam: `listen-tap.ts`, `openListenTap` with `docs/seams.md` §3.1 and the seam contract tests, `LISTENER_LIMITS`, the fault budget, the sampled relay dwell, fault-injection tests | **Built** (2026-11-16) |
| 3 | The server side: `ListenRegistry`, `ListenTokenStore`, the listener socket, the four routes and two internal handlers with their guards (route tables, agent reach, owners, `wsOwner`, `ws-limits`, the rate-limit bucket, `token` redaction), revocation over IPC, the re-check, the boot and worker reaps, the audit writes, the call detail's `listen_sessions` | **Built** (2026-11-16): §4 "As built (phase 3)", LS16 |
| 4 | The console: Live calls page and campaign view, `LiveCallsTable`, `ListenBar`, `useListenSession`, `useListenPlayback`, "Listened to by" on the call page | **Built** (2026-11-16), against the contracts (§9 "As built"); since phase 3, reads the live row's `correlation_id` ("Open call" to the call's page) and `aht_seconds` (amber on both pages), and is checked against the server's routes, frames, close codes and refusals; the review's console and mobile fixes (twelve: the audio on a stopped clock, bursts, retries across `ready`, the first attach's deadline, ordered reads, `ph-no-capture`, focus, the words) are in §9 |
| 5 | The agent's standing line (LS2) on the console station and the mobile station info sheet | **Built** (2026-11-16) |
| Persona review (console) | The account's Listening history page and its CSV (LS19), the Settings line (LS20 c), the campaign History's listen rows in words (LS19 e), a supervisor's reconnects merged in "Listened to by" and on the History, `access_unverified` with Try again (LS21, LS22 b), withheld numbers (LS22 i), the confirmation pointing at the history (LS6), the live list polling on through a `503` | **Built** (2026-11-16): §12 "The console" |
| 6 | The inbound notice's words and its regenerated WAV (LS1) | **Built** (2026-11-16): `AGENCY_INBOUND_STANDARD_WORDS.recording_notice` is "This call may be recorded or monitored for quality and training purposes." and `apps/server/assets/inbound/recording-notice.wav` is regenerated from it with `scripts/generate-inbound-clips.ts --only recording_notice` and the pinned voice (8 kHz mono PCM16, 5.0 s); the other six recordings are unchanged. The carrier never speaks the notice (its `<Speak>` covers closed, busy and call-back only), so the WAV is the only other copy of the words |
| Load check | 100 calls with nobody listening, then 6 and 20 listeners (one stalled), on one build: `apps/server/test/integration/load/listen-media-load.test.ts` | **Run** (2026-11-16): below |
| Voice review | The tap's review fixes: listeners ended as the call starts to settle (LS15 f), the μ-law customer by table and the transcoded legs primed (LS17 a), 10 s of drops ending a listener (LS17 b), failed frames counted in 20 ms frames (LS17 c), the loop-delay alert (LS17 d) | **Built** (2026-11-16): unit-tested; the load check's stalled listener expects `send_backlog`, re-run green since (`a13635b`: the wall-clock lane, 29 passed) |
| Server review | The agency and API side's review fixes: the upgrade's own access check and the revocation generation (LS16 n), the immediate path failing closed and the periodic pass's staleness cap (LS16 c, d), the flags read strictly, the super-admin's revocation, failed row closes retried and lost rows swept (LS16 o), supersede of older rows only (LS16 p), a stopping process `listen_unavailable` (LS16 q), retention on the partitions' month boundary (LS16 s), the AHT cache bounded and the dialler spine's index (LS16 u), the handoff's redacted URL (LS16 v) | **Built** (2026-11-16): `9f32bc5`, `09053e6` |
| Persona review (server) | The principal reviews' server, database and contract items: `access_unverified` and the 60 s staleness cap (LS21), `live_at` and "Listened to by" live only, protocol pings, the message rate, refusals without `ended`, the token store's outage, close-then-terminate, withheld numbers, the fault budget through the seam, the upkeep's held ids and the tick, seats added by an invite (LS22), the dead code and the shared `selectMembership`, plan tests for the other spines, the AHT read and the session reads, a worker killed mid-listen, the agent's own hangup, the load check's timing bounds gated on CPUs (LS22 m) | **Built** (2026-11-16): `b3114f9` |
| Persona review: history and guard rails | The account's listening history and its CSV (LS19), the agent named on a campaign's listen rows, the consent gate's handling policy, the enablement checklist and the unrecorded flag client-exposed (LS20), the inbound consent gap recorded (LS18), the live list and the number answering a flag store outage `503` (§12) | **Built** (2026-11-16): the server in §12, the console in §12 "The console" |
| Final review | The last review's fixes: the super-admin's add-user re-checking listens and the tenant context's lower-cased id headers (LS22 l), `Cache-Control: no-store` (LS22 n), the upgrade's database steps bounded (LS22 o), the env default warned at boot (LS22 p), a tap that fails to open counted (LS22 q), a dead process's rows retried (LS22 r), a supersede reaching a listen mid-upgrade (LS22 s), the history's bounded read on `0049_listen_history_index.sql` (LS22 t), the μ-law table pinned against G.711's own (LS17 a), the session purge waiting for a failed audit partition purge, `listen_sessions` on the call detail contract; in the console the phone-width bar's state in words, the ended reason wrapping, "turned off" only from a loaded flag map, soft-phone links behind their flag and the history's filters and failed reads (§9, §12); on mobile the on-call notice's words (LS22 u) | **Built** (2026-11-17). Every LS ruling ratified (Manas, 2026-11-17) |
| LS19 amended | The Listening history gated by `agency.supervise` alone (Manas, 2026-11-17): the history's routes no longer read the flag, and the console's tab, search entry and route are offered whether listening is on or off; the page's "turned off" and flag-outage retry states gone. "Listened to by" and the campaign History's listen rows were never behind the flag | **Built** (2026-11-17): §12 |

**Not yet verified.** Every check above ran in this repository's suites, against the mock carriers,
in Node and jsdom. Not run yet:
- in a real browser: every console listening test runs in jsdom with a faked Web Audio, so the
  autoplay policy, A-law playback through a real `AudioContext`, the 4503 Try again and a hidden
  tab answering the server's pings are untested there;
- against a real carrier: VoiceLink and Plivo are the mock carriers here (the tap reads the bridge's
  legs, so it inherits the bridge's own unverified live-carrier check, [`status.md`](status.md)
  phase 5 and Plivo step 5);
- on a phone: the app's "Monitoring and recording" button and `ListenFirstNoticeCard` are
  widget-tested only;
- with mobile stations: no end-to-end test listens to a call whose agent is on the app
  (`client=mobile`). The end-to-end test's agent is a console station on `alaw8`, which is the
  app's media too (`client=mobile&media=alaw8`), and neither the bridge nor the listen runtime
  reads the station's client, so the tap sees the same leg; accepted as low risk, with a mobile
  station case in `live-listen-e2e.test.ts` a follow-up;
- in Grafana: the `listen` alert group and the dashboard row are validated (`pnpm test:grafana`)
  but not applied to Grafana Cloud, like the rest of `grafana/`;
- on CI's `full-ci` runs, the load check's timing bounds: CI does not set `LISTEN_LOAD_BOUNDS=on`
  (LS22 m), so on a runner with fewer than 4 CPUs they are printed, not asserted.

Before the first tenant: its enablement through the checklist ([`operations.md`](operations.md)
"Enabling live call listening for a tenant"), a listen in a real browser on staging, and the open
items in [`status.md`](status.md) "Open decisions and owners" (none left for listening: the consent
wording's legal check is done, Manas, 2026-11-17).

### Load check

**What runs.** `listen-media-load.test.ts` (wall-clock lane: the audio is paced in real time and
the stalled listener's end is the real 10 s back-pressure bound, LS17 b) dials 100 calls (`LOAD_SCALE`, seeded by
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

**What it does not run, and why.** The feature's first brief asked for a load check of one
listener per live call at the expected peak. LS5 (decided) set that peak at 5–6 supervisors and the
caps at 2 listeners per call and 20 per process, so 100 listeners on 100 calls cannot be reached
at the defaults and that figure is superseded by LS5: the check measures the peak (6) and the
process cap (20), two listeners to a call, on 100 calls. A soak past the cap would need
`AGENCY_LISTEN_MAX_PER_PROCESS` raised and is not run.

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
`send_backlog` after 10 s of drops (LS17 b) while its call stays up and the call's other listener
keeps hearing it; the grant, end and active-session metrics move exactly; nothing leaks. The timing
bounds above are asserted with 4 or more CPUs, or when asked (`LISTEN_LOAD_BOUNDS=on`, a
`LOAD_SCALE` soak); with fewer the readings are printed instead (LS22 m): the wall-clock lane runs
on every server PR, and on a busy 2-core runner two windows 20 s apart differ by more than the
listeners. The rest is asserted on every run.

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
  (the suite's expectations follow, re-run green since). Without the soft limit (mutation below)
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
  plans on analysed data, `listOpenForCalls`' and `listForCall`'s among them, the Down's refusal,
  down then up), `listen-sessions-unverified-migration.test.ts` (0048: the end reason's CHECK with
  `access_unverified` against the contract, `live_at` and its CHECK, the backfill, the Down's
  refusal, down then up), `baseline.test.ts`, `baseline-down-up.test.ts`.
- Server: `test/integration/agency/listen-session-repository.test.ts` (every method on real
  Postgres, scopes, the close's once-only rule and race, `markLive` and "Listened to by" live rows
  only, the reaps),
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
  frame; the table against G.711's conversion table, written out as literals (equal but for 44 named codes, one A-law step each) and at least as faithful as the
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
  reservations, a supervisor's own listen not counted, supersede (LS22 v: with `maxPerUser` 2 the
  same call's listen ends and a re-grant of it is not refused; `supersededBy`), `endSessions`, `revokeUser` scoped
  and re-checked and failing closed, the periodic pass failing open up to the staleness cap (and a
  hung pass), the periodic re-check on fake timers, the rows' upkeep on the tick, a stopping process
  `listen_unavailable`, the revocation generation between grant and reservation and between
  reservation and admission, shutdown; `access_unverified` from the 2 × cap and from the immediate
  path's unreadable checks, a tick in flight not stacked on, the upkeep's held ids read when asked; the access question: the floor, a tenant-wide admin, the
  flag, LS4, a failed read unchecked while a known no still revokes, one read per supervisor and
  account), `listen-socket.test.ts` (the strict frame parser; the upgrade's order: token, session,
  caps, the database's answer (4403, or 1011 when it cannot say), a token from before a revocation,
  a revocation between reservation and admission, a stopping process, row before tap, the tap refused; `ready` and the started audit; ping/pong; every end's frame,
  close code, row and audit; the tap's own ends; the client's close; the idle bound on fake timers;
  ends once; a throwing row close or audit; supersede through the registry; LS22: the row stamped
  live and a refused row not, protocol pongs as liveness, the message rate, close-then-terminate, a
  tap ended under the attach or throwing, the token store's outage, the fault budget through the
  seam, `access_unverified`'s 4503), `listen-token.test.ts` (single use, the listen id, a stored
  value that is not a grant, fail closed both ways and a store outage rejecting, the in-process
  store), `listen-revocation.test.ts` (the cross-process supersede: past the
  cap, older rows only, two listens admitted at once ending one; LS22 v: this process's rows and
  the others' ranked together, the same call's, a listen ended under the read ranking nothing), `listen-rows.test.ts` (a failed
  close retried with its reason, the sweep's keep set and age floor, the held ids read after a slow
  retry, `markLive`, the queue bound),
  `test/unit/feature-flags/flag-snapshot.test.ts` (`strictSnapshot`: an outage rejects),
  `test/unit/api/routes/super-admin-memberships.test.ts` (the super-admin role change and removal
  re-check listens), `test/unit/api/routes/proxy-agency-live-calls.routes.test.ts`
  (RBAC before the flag, the flag, a flag store that cannot be read, the edge checks, masking and
  names, a withheld number said so and its reveal `404 live_call_number_withheld`, `listenable`,
  the number, the grant's refusals, its forwarding and its answer mapping),
  `invites.routes.test.ts` and `user.routes.test.ts` (a seat added by an invite or its claim
  re-checks the invitee's listens), `test/unit/audit/platform/audit-logger-flush.test.ts` (the
  audit flush the e2e reads its rows with, the logger left running),
  `agency-live-calls-internal.test.ts` (the grant handler: the bridge, the caps, the token and its
  revocation generation; the AHT cache's minute and bound),
  `test/unit/api/listen-route.test.ts` (the route, its `wsOwner` and handoff label, the refusals,
  the station bucket, a token given twice, the token's redaction in spans and in the handoff's own
  log line),
  `test/integration/agency/live-call-plan.test.ts` (the dialler spine on
  `idx_agency_attempts_account_live`, the soft-phone and inbound spines on their account live
  indexes, the campaign AHT read by `campaign_id` on an index), the guards (`agency-route-table`, `agency-agent-reach`,
  `core-route-owners`, `core-dispatch`, `websocket-max-payload`, `ipc-protocol`,
  `media-child-invalidations`); end to end `test/integration/agency/live-listen-e2e.test.ts`
  (VoiceLink: joining mid-call with both legs, the call's end, a drop, stop, the per-call cap,
  supersede, a role change and a removal through the real routes with the periodic re-check held
  off (so the immediate path), a demotion between a grant and its upgrade, LS4 both ways, the own call,
  another account and tenant, agents, operators, the flag, the number, the call details, a
  soft-phone call (and the agent's own read of it, without `listen_sessions`), a wrap-up redial, HTTP
  closing, the boot sweep, a replayed or foreign token, the agent's own hangup with nothing of the
  agent heard after `ended`, a grant whose call ended before its upgrade (4404, not "Listened to
  by"), a super-admin's session refused),
  `test/integration/telephony/live-listen-plivo-e2e.test.ts` (Plivo outbound; inbound parked then
  connected), `test/integration/cluster/live-listen.test.ts` (`MEDIA_WORKERS=2`: the grant and the
  socket on the owning worker, supersede across workers, revocation over IPC with the periodic
  re-check held off, a demotion between a grant and its upgrade, a worker killed mid-listen: its
  row closed `server_restarted` by the reap, the other worker's listen open and hearing).
- The console (phases 4 and 5), under `apps/console/src/__tests__/`:
  `utils/listen/listenFrames.test.ts` (the parser, every close code, the `ended` reasons that end a
  session), `utils/listen/listenSessionReducer.test.ts` (every transition, stale attempts, the
  window, the bound, the bound across `ready`s and its fresh count after 10 s live, the first
  attach's 15 s, a listen withdrawn here (`revoked`, `turned_off`, from lost too), a re-grant
  refused `feature_disabled`, Try again, the bar's flags), `utils/listen/listenSessionController.test.ts`
  (grant → socket → ready, audio only while live, ping, stop, supersede, destroy, reconnect, a
  shutdown's close with no `ended` frame through masked and unanswered re-grants, the window, a
  first grant or socket that never answers, an unopenable socket),
  `utils/listen/listenPlayback.test.ts` (the cushion, per-leg queues and decoders, a burst past
  the ceiling never overlapping one leg, the graph, mute, volume, level, silence, blocked: frames
  dropped on a frozen clock with no resume per frame, "Turn sound on" with no burst, an
  interruption stopping the queue, release, a context the browser refuses, reset, close, no
  microphone in use or in the source), `utils/listen/liveCallsTable.test.ts` (sort, filters,
  the chosen option kept, Clear filters' rule, ended rows, amber, the target, "Open call" by
  origin and none for inbound, the words (a full call counted from its row), the page's intro, a
  bare 503), `api/liveCalls.test.ts`, `components/LiveCallsTable.test.tsx` (… Clear filters, a
  chosen agent kept after their call ends, "+N", no pill at zero, the `ph-no-capture` boundary, an
  older read answering late), `components/ListenBar.test.tsx` (the confirmation,
  every bar state, Esc, mutes, the remembered volume with storage blocked, the toast, a second
  listen, the account switch and unmount with the socket and the context closed, phone width;
  Stop beside Connecting and Reconnecting; Connection lost's Close; the flag or the permission
  going away here, and a re-grant refused `feature_disabled`; a full call's toast;
  the audio silenced and suspended on Stop, supersede and revoke and resumed by the next Listen
  and Try again; no Web Audio or a refused context refused with a toast; focus to the bar and
  back to the row's Listen, left alone when moved; the ended reason in the live region; "The call
  ended before you joined."; the bar's `ph-no-capture` boundary),
  `components/ConsoleLayout.listen.test.tsx` (the shell's real wiring: the bar under `<main>`,
  the listen across pages, ended by an account switch and by leaving the shell),
  `components/listenSurfaces.test.tsx` (the "Monitoring and recording" popover, the one-time
  notice: Got it, per agent and account, storage blocked; the join screen's line, "Listened to
  by", "Summary | Live"), `pages/SoftphonePage.test.tsx` and
  `pages/AgentConsolePage.softphone.test.tsx` (the button and the notice on the standalone soft
  phone, the station and its soft phone), `pages/LiveCallsPages.test.tsx`, and the navigation guards
  (`navRouteGates`, `consoleNav`, `consoleSearch`, `agencyCampaignTabs`), `analytics/redact.test.ts`,
  `analytics/autocaptureOptOut.test.ts` (the table and the bar among the surfaces that keep the
  class). The persona review's console (§12 "The console"): `listenFrames.test.ts`,
  `listenSessionReducer.test.ts`, `listenSessionController.test.ts` and `ListenBar.test.tsx` (4503
  and `ended { access_unverified }`: stopped, not revoked, no reconnect, Try again at both widths,
  Dismiss), `LiveCallsTable.test.tsx` and `ListenBar.test.tsx` (withheld: "Withheld", no Show, the
  reveal's 404), `listenVisits.test.ts` (the merge), `listenSurfaces.test.tsx` ("Listened to by"
  merged), `listenActivityRows.test.ts`, `agencyActivityCopy.test.ts` and
  `AgencyCampaignActivityPage.test.tsx` (the History's listen rows in words, merged and linked),
  `listenHistory.test.ts`, `api/listenHistory.test.ts` and `pages/ListenHistoryPage.test.tsx` (the
  history page), `pages/ListeningSettingsPage.test.tsx` (the Settings line), `LiveCallsPages.test.tsx`
  (a 503 keeps the poll), the navigation guards for both pages (`consoleNav`, `consoleSearch`,
  `navRouteGates`, `SettingsHub`), and the server's `agency-route-table.test.ts` (the history routes
  in the console inventory). Mobile: `apps/mobile/test/features/station/station_listen_notice_test.dart` (the
  button and sheet on the station and both soft-phone surfaces, the one-time notice until Got it
  per agent and account, on a call too, 200% text on 360×640) and
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
  the time listened counted once, the last-ended reason, a session that never went live left out
  (it neither shows nor bridges two visits), the tenant and account scope, the filters,
  keyset pages with ties on the start, the joins that survive a purged call row; then the internal
  handler and the public routes together: masking, "Withheld", a malformed cursor, the CSV drained
  across pages and its audit row), `test/unit/api/routes/proxy-agency-listen-history.routes.test.ts`
  (RBAC; the flag never read, so listening off or a flag store outage still answers 200, LS19 as
  amended 2026-11-17; the query refused at the edge, names and masking, withheld by the live list's rule, the CSV's pages, row ceiling, formula guard and audit row,
  a refused page answering its own status with no file),
  `test/integration/agency/agency-activity-service.test.ts` (a listen row's `detail.agent_name`),
  `test/unit/api/routes/proxy-agency-live-calls.routes.test.ts` (an outage is `503` on the list and
  the number too), `test/unit/api/routes/super-admin-feature-flags.test.ts` (the policy on the
  catalog and the detail read, the reason, the bulk and global refusals),
  `apps/super-admin/src/__tests__/pages/SAFeatureFlagsPage.test.tsx` (no reason dialog for a global
  On of a policy flag; the global Off kept; not in the bulk rollout), the flag exposure
  (`packages/contracts/test/flags.test.ts`, `test/unit/feature-flags/registry.test.ts`,
  `test/integration/feature-flags/feature-flag.service.test.ts`, the `platform.json` fixture).
- The final review (§10): `apps/server/test/integration/agency/listen-history-plan.test.ts` (the
  history's walk on its index, LS22 t), `packages/db/test/integration/db/listen-history-index-migration.test.ts`
  (0049), `apps/server/test/unit/feature-flags/flag-policies.test.ts` (the boot warning, LS22 p),
  `test/unit/api/middleware/tenant-context.middleware.test.ts` (the id headers lower-cased, LS22 l),
  `test/unit/api/routes/super-admin-memberships.test.ts` (the add-user's revocation),
  `test/unit/audit/audit-partition-maintenance.test.ts` (the session purge skipped after a failed
  partition drop); in the console `listenBarWrapCss.test.ts` (the ended reason wraps) and
  `listenHistory.timezone.test.ts` (the date range in the reader's zone); on mobile
  `station_listen_notice_test.dart` (the on-call notice's words). Counts in
  [`modules.md`](modules.md).

## 12. The listening history and the guard rails (persona review)

Built after the persona review, on the product owner's decisions (LS18–LS20).

**The listening history (LS19).** `GET /proxy/agency/listen-history`
(`api/routes/proxy-agency-listen-history.routes.ts`; contracts `api/agency/listen-history.ts`):
`agency.supervise` (alone: the listening flag is not read, so neither listening turned off nor a
flag store outage refuses it; LS19, amended 2026-11-17), an account, the query checked at the edge (`listener_user_id`, `agent_user_id` UUIDs, `from` / `to`
ISO instants, `to` exclusive and not before `from`, `limit` 1–100, `cursor`; unknown keys a 400).
It reads the internal `GET /api/v1/agency/listen-history` (owner `none`;
`api/routes/agency/listen-history.ts`, `AgencyListenHistoryRepository.listVisits`,
`LISTEN_HISTORY_SQL`), then adds the supervisor's and the agent's names (`agentNamesOrNone`) and
masks the number (`maskPhone`; a withheld caller, by the live list's rule `isWithheldNumber`
(no digit at all, `''` as stored), is `customer_phone_withheld: true`; a purged call row is
neither). An entry is a visit: one supervisor's sessions on one call, merged in the SQL (LS19 b),
with `listen_ids`, the first start, the last end (null while one is open), the
time listened, the reason of the session that ended last (null while open), the call's origin and
spine row (`correlation_id`, for the link: the campaign's attempt page, the soft-phone call page,
the inbound call), the campaign, the inbound route and the roster contact's name. Newest first by
the visit's start and first id, keyset-paged (`next_cursor`, the domain package's keyset cursor; a
cursor this API did not issue is `400 malformed_cursor`). Each page reads its own visits, not the
account's history (LS22 t): the sessions that start a visit are walked newest first from the
cursor on `idx_agency_listen_sessions_account_started` (0049) and cut at the page, and only their
calls' sessions are windowed and merged.

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
in the table too, with `live_at` null (LS22 c). `LISTEN_HISTORY_SQL` keeps only rows
with `live_at` set, as "Listened to by" does, so the two agree: a refused row neither shows nor
bridges two visits.

**The campaign History's listen rows (LS19 e).** `fetchActivityPage` resolves the
`detail.agent_user_id` of `agency_call.listen_started` / `_ended` rows in the page's one identity
read and adds `detail.agent_name` (null when the user does not resolve). The duration, the end
reason and the call's ids are already in `detail`; the console words them.

**The live list and the number on a flag store outage.** They answer `503 listen_unavailable`
(through the error mask), as the grant does, never `403 feature_disabled`, which the console reads
as final and stops polling on.

**The consent gate's handling policy (LS20 a).** Declared on the flag's definition
(`FlagDefinition.policy`, `packages/contracts/src/flags.ts`) and read and enforced by
`apps/server/src/feature-flags/flag-policies.ts` (`flagPolicy`, `checkOverridePolicy`,
`checkBulkPolicy`): the catalog and the detail read carry
`policy { warning, bulk_allowed: false, reason_required_to_enable: true }` for
`agency_live_listen_enabled` and for no other flag; `PUT …/overrides` refuses an On without a reason
(`400 flag_reason_required`) and a global On (`422 flag_bulk_not_allowed`); `POST …/overrides/bulk`
refuses it whatever the value. Deleting an override and turning it off are not guarded. The
super-admin registry (`SAFeatureFlagsPage`, `canEnableGlobally` in `flagUtils.ts`) answers a global
On with why, not the reason dialog; the tenant tab's dialog already shows the warning on an On.

**The Settings line (LS20 c).** Both flags are client-exposed: the account's Settings reads
`agency_live_listen_enabled` and `agency_live_listen_unrecorded` from the client flag map
(`GET /feature-flags`) and shows them read-only (§12 "The console").

**The console.** Built on the server's routes above, every word in `utils/listen/listenCopy.ts`
(the History rows' in `utils/agencyActivityCopy.ts`):

- *The Listening history* (`pages/agency/live/ListenHistoryPage.tsx`, `/agency/listening-history`):
  a tab of the Campaigns section beside Live calls ("Listening history"), gated as the routes are:
  `agency.supervise` in the page and the nav entry's gate, and no flag (LS19, amended 2026-11-17),
  so the tab, the route and search's words "listened", "who listened", "monitoring log" stay while
  listening is off (`navRouteGates.test.ts`; `ListenHistoryPage.test.tsx` pins the route in
  `App.tsx` free of `RequireFlag`). With Live calls hidden the bar is Campaigns, All calls and
  Listening history: every supervisor has Campaigns, so the tab
  never stands alone. Columns Supervisor, Agent, Call type ("Dialler", "Soft phone", "Inbound: <route>"),
  Customer (the name as the live table words it, "Unknown caller" and "No name" included, over the
  masked number or "Withheld"), Started, Time listened ("2m 10s", "Listening now" while open), How it
  ended (`AGENCY_LISTEN_END_REASON_LABELS`), and Call: "Open call" to the attempt or the soft-phone
  call (`liveCallPagePath`), none for an inbound call, and "Call no longer available" once the
  call's row is gone (no number and not withheld); a soft-phone call has no link while
  `agency_softphone_enabled` is off. Filters for supervisor (the team's members in this account, a
  tenant-wide seat or a seat in this account, who may listen, plus the rows'), agent (every such
  member, plus the rows') and a date range (the reader's
  local days, `to` sent as the next day's start, the route's `to` being exclusive), applied with
  Apply, a reversed range refused on the page; keyset paging ("Load older listens", not offered
  under new filters until they answer with a cursor of their own; a failed read under new filters
  clears the rows and the count rather than leaving the old ones under the error); Export CSV
  with the applied filters (`api/listenHistory.ts`, a blob, the server's file name), a cut-short
  file said in a toast by its reason (`row_limit` with the ceiling, `deadline`). A 401 or 403 (the
  permission taken away) says "The listening history is for supervisors. Ask an account admin if
  you need to see it." and is never asked again; any other failure, a 503 included, offers Try
  again. There is no "turned off" state. The table is inside a `ph-no-capture` boundary (CH6).
  The two routes are in the server's route-table inventory (`test/fixtures/console-paths.json`)
  with `api/listenHistory.ts` as their caller, no longer server-only.
- *The Settings line* (`pages/settings/ListeningSettingsPage.tsx`, Settings → This account → "Live
  call listening", `/settings/listening`, `agency.supervise`): "Live call listening: On" or "Off";
  when On, "Calls that are not recorded can be listened to as well." or "Only calls that are
  recorded can be listened to." (`agency_live_listen_unrecorded`, `LIVE_LISTEN_UNRECORDED_FLAG`);
  "Ask your account manager to change this." Read-only. While the flag map is loading it says
  "Checking…" and on a failed read offers Retry: the map fails closed, so it would say "Off" of an
  account that is on.
- *The campaign History's listen rows* (`activityDetailSummary`): "Listened to Priya S.’s call for
  2m 10s · ended: stopped by the supervisor" (the agent from `detail.agent_name`, "an agent’s call"
  without one; the reason's words lowercased after "ended:", left out for a reason this build does
  not know); a listen still open (its started row alone) "Started listening to Priya S.’s call.".
  "On what" links the call by the row's `origin` and `correlation_id` (`activityTargetPath`): the
  attempt, the soft-phone call (behind its flag), none for inbound. A supervisor's sessions on one
  call are merged for display (`utils/listen/listenActivityRows.ts`): the visit shows as the row of
  its newest end, its duration counted once and its reason the last to end; its other started and
  ended rows are not shown (the entry count above the table still counts audit rows).
- *Merging* (`utils/listen/listenVisits.ts`, `mergeListenVisits`): the server's rule,
  `AGENCY_LISTEN_HISTORY_MERGE_GAP_MS` (30 s) after every earlier session ended or while one is
  open, overlaps once, gaps not at all, the reason of the last to end. "Listened to by" shows one
  line per visit (its first start to its last end, "Listening now" while any is open).
- *`access_unverified`* (LS21, LS22 b): close 4503 or `ended { access_unverified }` is its own end
  (`listenFrames.ts` `unverified`; the reducer's `ended` with `end.kind: 'unverified'`), the one ended
  listen Try again starts afresh (`retryable`): "Listening stopped because your access could not be
  checked. Try again." with Try again and Dismiss, at every width; no reconnect loop, no 6 s
  dismissal, the sound released until Try again resumes it.
- *Withheld numbers* (LS22 i): a row with `customer_phone_withheld` shows "Withheld" and no Show in
  the live table, and the bar says "Priya S. with Withheld"; a reveal answered `404
  live_call_number_withheld` (a row that did not say so) shows "Withheld" and offers Show no more.
  The contract's field stays optional (absent reads as false).
- *The live list's 503*: a `503 listen_unavailable` read keeps the rows, says "Could not load live
  calls. Retrying…" and the poll goes on (`LiveCallsPages.test.tsx`); only a 403 stops it.

**The enablement checklist (LS18, LS20 b):** [`operations.md`](operations.md) "Enabling live call
listening for a tenant".
