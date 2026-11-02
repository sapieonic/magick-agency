# Scaling to several processes on one host

The design for carrying 400–500 simultaneous calls on one host by spreading the call audio
relay over several Node processes. A primary process forks workers over `child_process` IPC.
It covers the topology, the WebSocket handoff, the life of a call across processes, the IPC
protocol, the single-replica assumptions and how each is resolved, failure and lifecycle,
observability, config, tests and the build order. Status: **built** (phase B, 2026-11-02).
Where the build departed from the design, the section says so ("as built"); the departures
are listed in §12. Nothing here changes how the server runs until `MEDIA_WORKERS` or
`ANALYSIS_WORKERS` is set. Written 2026-11-02 against the tree at the merge of the codec,
analysis worker, pacing, console A-law and load-hardening work.

Read it with [`architecture.md`](architecture.md) (the single-process composition this
splits), [`seams.md`](seams.md) (the seams it reuses) and [`operations.md`](operations.md)
(shutdown, invariants).

## 0. The problem and the constraints

Every 20 ms frame of every call is relayed through the server's one event loop: 50 frames a
second each way per call, so 50 000 relayed messages a second at 500 calls. A relay bench on
real `ws` sockets, with the console on binary A-law passthrough, put one loop at ~70% busy
(p99 delay 5.6 ms) with 200 calls, and saturated (p99 75 ms) at 500. The loop is shared, so a
saturated relay also delays pacing ticks, carrier webhooks and the API. That works out to
about 35 µs of CPU per relayed frame. The spike in §2.6 measured 64% of a core for 19 000
frames a second, which matches.

Constraints (Manas):

1. **IPC, not Redis, for new communication between processes.** The primary forks workers.
   Redis keeps the roles it has today: leases, tokens, concurrency guards, station ownership
   keys, the cache-invalidation channel. No new pub/sub or queues.
2. **No edge change.** Every request and upgrade still reaches `:3021` through nginx exactly
   as now. The primary accepts everything and hands each upgraded socket to the worker that
   owns it.
3. **Single-process mode stays the default**, unchanged, and every existing test keeps its
   meaning.

What is ruled out, and why:

- **Node's `cluster` module.** Workers share the listening socket and the kernel or a round
  robin picks one, but the station socket and the carrier's media socket of one call must
  land in the same process. Routing has to be by a key in the request.
- **`worker_threads`.** A thread cannot receive a socket handle, so the relay could not move.

## 1. Topology

### 1.1 The two candidates

**(a) Workers as dialer-runtime shards.** Each media worker owns a fixed share of the agents:
their station sockets, `StationRegistry`, the agent state machine's in-process side,
`AgencyDialer` (live attempts), `WrapupManager`, `BreakRegistry`, `ManualDialer` and
`SoftphoneService`, and the WebRTC bridge sessions of their calls with both legs. The
primary keeps the HTTP server, the public API layer, the pacing engine, the reaper and every
leader-only sweep, and sends each dial to the owning worker over IPC.

**(b) Workers as pure media relays.** All state stays in the primary. Workers only shovel
frames between the two sockets of a call. Every control frame and every bridge lifecycle
step crosses IPC.

### 1.2 Recommendation: (a)

| | (a) runtime shards | (b) media relays |
|---|---|---|
| Per-frame IPC | none: both legs and the relay are in one worker | none for media, but the bridge's control half (the `start` negotiation, `providerMediaReady`, back-pressure counters, clip playback to the carrier) must be split from the relay half |
| Code that moves | a new composition layer (`src/cluster/`). The dialer, bridge, station handler, wrap-up and soft phone run unchanged inside the worker | `webrtc-bridge-session.ts` and the media half of `webrtc-bridge-manager.ts` cut in two, with IPC for every station control frame, lifecycle event, bind and re-attach |
| Correctness risk | low where it matters. The dialer's ordering invariants are all in-process sequences, and they stay in one process: "writes the agent's panel and binds the audio with no `await` between", the lifecycle listener registered before the dial, `releaseStationOnClose` as one synchronous run, `liveByAttempt` set before `createBridgedCall`. They cross IPC only at the two seams built for it | high. Those same sequences would straddle a process boundary, and each `no await between` would become an IPC round trip |
| Existing seams | uses them as designed: `DialDispatcher` / `DialCommand` ("designed to survive a process boundary"), `PacingInvalidationBus` with `parsePacingInvalidationEvent`, the station ownership key, the reaper's "owned by a replica whose heartbeat is gone" rule, the `FOR UPDATE SKIP LOCKED` analysis queue | uses almost none of them, and adds a seam through the middle of the bridge |

(a) costs one thing (b) does not. A few agent-control HTTP routes read in-process runtime
state: `/available` reads `isLocallyOwned`, a disposition reads the wrap-up, `break` reads the
`BreakRegistry`. Those internal handlers must run in the owning worker. B16 already makes
them an HTTP-shaped call (`callCore` → `inject` on a private instance), so the call is
forwarded by session (§3.4). That is a routing table plus a guard test, not new logic.

### 1.3 Which work runs where

| Work | Primary | Media worker *k* | Analysis worker |
|---|---|---|---|
| HTTP listen on `:3021`, every request and upgrade | yes | never listens | no |
| App-scope rate limiter, per-user bucket, sessions, tenancy, RBAC (the public API layer) | yes | no | no |
| Internal handlers (`/api/v1/agency/...`) not tied to a session; campaigns, stats, roster ingest, DNC, super-admin, invites | yes | no | no |
| Internal handlers tied to a session, attempt or manual call (§3.4) | no | yes, for its sessions | no |
| Station socket `/proxy/agency/station/:sessionId`, silent-station sweep | routes only | yes | no |
| Carrier media socket `/api/v1/webrtc-call/:id/pstn-stream` and the relay | routes only | yes | no |
| Carrier status webhooks | receives and forwards | handles, for its calls | no |
| Late webhooks for a call no live worker owns (no hint, or slot restarted) | handles, with a session-less bridge | no | no |
| `AgencyDialer`, `WrapupManager`, `BreakRegistry`, `ManualDialer`, `SoftphoneService`, bridge sessions | constructed idle (no stations) | yes | no |
| Pacing engine, leader leases, completion notices, campaign announcer | yes | no | no |
| Reaper: startup reap, periodic sweeps, wrap-up lapse, stranded contacts, manual sweeps | yes (§5.5) | no | no |
| Guard admission and release per call | no | yes | no |
| Guard self-heal reconcile, stale-call sweep | yes | no (wakes the primary) | no |
| Abandonment window and guardrail, live-concurrency refresh | yes | no | no |
| Audit buffers | own buffer | own buffer | own buffer |
| Audit partition maintenance, retention purge, credential shred sweep, ingest reaper, clip cache sweeper | yes | no | no |
| Analysis slots (claim, fetch, transcribe, analyse) | only when `ANALYSIS_WORKERS=0` | no | yes |
| Bridge → analysis hooks (enqueue a job) | n/a | yes (database insert, then `analysis.wake` over IPC) | n/a |

**Analysis workers** are separate processes with no HTTP, running only the slot pool
(`initDialerAnalysisWorker`) on the shared queue. Claims are already
`FOR UPDATE SKIP LOCKED`, shutdown requeues by generation, and `recoverStale` reclaims a dead
process's jobs once their heartbeat lapses. So K processes share the queue with no new
coordination. Each has its own recording byte budget and its own heap, which keeps recording
buffers and vendor waits off the call-serving loops. That alone is the reason to move them.
The `analysis.wake` IPC event replaces the in-process `getDialerAnalysisWorker().wake()`
(fan-out to all analysis workers, each of whose own 60 s sweep is the backstop).

### 1.4 Who owns a session: a hash, not a directory

`slotFor(sessionId) = fnv1a32(sessionId) mod MEDIA_WORKERS`. The station socket, every
session-scoped internal handler and every dial for that agent go to the same slot,
deterministically. Session ids are UUIDv4, so 500 agents over 3 slots is 167 ± ~11 each, and
calls follow their agents. A reconnect, including a mid-call re-attach inside the 8 s
deferred hangup, lands on the same worker, which still holds the live attempt. That is what
makes `reattachStation` work across processes without any handover.

The primary still keeps a `StationDirectory` of which sessions are *attached* (fed by IPC
events, §4.3). Pacing needs it to pick candidates. Routing does not depend on it.

A call is owned by the worker that dialled it, which is its agent's slot. The carrier's media
socket and webhooks are routed by a hint the worker writes into the URLs it hands the carrier
(§2.5).

## 2. Socket handoff

### 2.1 In the primary: route the upgrade through Fastify, then hand it off

`buildApp` gains `wsTransport: 'local' | 'handoff'`. The default, `'local'`, registers
`@fastify/websocket` exactly as today. `'handoff'` (primary, `MEDIA_WORKERS > 0`) registers
`src/cluster/ws-handoff.plugin.ts` instead:

1. **`server.on('upgrade', (req, socket, head))`** mirrors `@fastify/websocket`'s own
   `onUpgrade`. The first thing it does, synchronously, is **stop the socket's reads**:
   `socket._handle.reading = false; socket._handle.readStop()`. A plain `net.Socket`'s
   `pause()` does not stop its handle (only a `kBuffer` socket's), so without this any bytes the
   client sends while the primary is inside an async hook are read into the primary's JS buffer
   and lost at the handoff. The spike shows that loss (§2.6). Then it stashes `socket` and
   `head` on the request under private symbols, binds a `ServerResponse` to the socket, and
   calls `app.routing(req, res)`.
2. Fastify runs every app hook as for HTTP: the client log context, then the **rate limiter**
   (`station` bucket `st:<ip>`, `carrier_media` bucket `cm:<ip>`). A 429, a 404 for an unknown
   path, or a 503 is written to the raw socket as an HTTP response before any handoff, as
   today.
3. An `onRoute` hook replaces the handler of every `websocket: true` route. Non-upgrade GETs
   get 404, as `@fastify/websocket` does. Upgrades call `reply.hijack()`, compute the owner
   from the route's `config.wsOwner`, and send the handoff (§2.2). The route definitions and
   the route tables do not change. A guard test enumerates `onRoute` and requires a
   `config.wsOwner` on every WebSocket route:
   - station: `{ by: 'session', param: 'sessionId' }`
   - pstn: `{ by: 'carrier_hint', param: 'id' }`
4. **Failure answers are HTTP, before the handshake.** If the owning slot is down or
   restarting: `503` with `retry-after: 2`. The console's reconnect ladder re-mints and retries.
   The carrier's media connect for a call on a dead worker is moot, because that call died
   with the worker. If `socket.readableLength > 0` at handoff, which should be unreachable once
   reads are stopped: `503` and `ws_handoff_total{result="buffered"}`, never a silent loss.
   If `child.send` fails: the socket is destroyed and counted.

The primary never parses a frame, never sees the station token, and does no work per frame.

#### 2.1.1 The two Node internals the handoff relies on (as built)

Both live in one module, `src/cluster/socket-pause.ts`. Both are feature-detected, checked
once at boot on a real loopback socket (`probeSocketReadStop`), and pinned against the
running Node by `test/unit/cluster/socket-pause.test.ts`. Known good on Node 22 (`.nvmrc`). A
Node upgrade that changes either one fails that test. In production, if the boot probe fails,
the primary logs a warning and runs as one process: it forks no media workers and serves every
socket itself. Per-socket fallback is not attempted, because a primary with workers holds no
runtime for their sessions.

1. **Stopping the socket's reads**, `socket._handle.readStop()`, the call `net.Socket`'s own
   `pause()` makes for buffered sockets.

   **Why the public API is not enough.** For a plain socket, `pause()` only stops the stream
   flowing. libuv keeps reading into the JS buffer, and `child.send(msg, socket)` closes the
   parent's copy without moving that buffer. Draining with `socket.read()` after `pause()` does
   not close the race either:
   - `read()` re-arms the handle (`_read` → `tryReadStart`), so more bytes can land after the
     drain and before the send;
   - once `send` takes the handle it sets `handle.onread` to a no-op, so bytes read in that
     window are dropped.

   The spike (§2.6) and `test/integration/cluster/ws-handoff.test.ts` both lose the early
   frame without the read stop.
2. **Detaching the socket from its server**, `socket.server = null` before `child.send`.
   Found while building. For a socket a `net.Server` accepted, `child_process` registers the
   child as a "worker" of that server, and the server's `close()` then waits until the child
   reports every socket it was sent as closed.
   - The primary closes HTTP first on shutdown, while its workers still hold live stations
     and calls, so `close()` would wait for them forever. The first end-to-end run hung
     exactly there.
   - With `server` cleared, Node does no tracking. The server's own count (`_server`,
     untouched) is decremented once, when the primary destroys its copy of the socket after
     the send.
   - A refused upgrade's socket is destroyed once its 503 is written, so a client that never
     closes its side cannot hold `close()` open either.

### 2.2 The handoff message

```ts
// src/cluster/ipc-protocol.ts
interface WsHandoff {
  kind: 'handoff';
  route: 'station' | 'pstn';
  method: 'GET';
  url: string;             // path + query, verbatim (token, client=, media=, w=)
  httpVersion: string;     // '1.1'
  rawHeaders: string[];    // verbatim, so x-forwarded-for, x-client and sec-websocket-* survive
  head: string;            // base64 of the bytes after the headers (usually empty)
  requestId: string;       // the primary's request id, so both processes' log lines join
}
worker.send(message, socket);   // keepOpen: false; the primary's copy closes once sent
```

TLS is terminated before nginx, so the handle is a plain TCP socket. nginx opens a dedicated
upstream connection for every upgrade (`Connection: upgrade`; only plain requests use the
`keepalive 16` pool), so handing off the whole connection never strands a later request.

### 2.3 In the worker: rebuild the request and let `@fastify/websocket` finish

The worker builds a Fastify app that never listens (`buildWorkerApp`). It registers the error
handler, the client-log-context hook, `@fastify/websocket` with the same
`websocketPluginOptions(wsMaxPayloadBytes)`, the station route
(`proxyAgencyStationRoutes`) and the PSTN route (`webrtcCallRoutes`), and the internal
handler instance (`setCoreHandlers`). It registers no rate limiter.
`src/cluster/ws-adopt.ts`:

```ts
const req = new http.IncomingMessage(socket);
req.method = m.method; req.url = m.url; req.httpVersion = m.httpVersion;
req.httpVersionMajor = 1; req.httpVersionMinor = 1;
req.rawHeaders = m.rawHeaders; req.headers = foldRawHeaders(m.rawHeaders); // join repeats with ', '
socket.setNoDelay(true);                       // as utils/ws-nodelay.ts does for direct sockets
app.server.emit('upgrade', req, socket, Buffer.from(m.head, 'base64'));
```

From there it is the ordinary path. `@fastify/websocket` routes the request through the
worker's router, and `ws.handleUpgrade` checks the `sec-websocket-*` headers, negotiates
permessage-deflate, writes the 101 and unshifts `head`. The route's own handler then runs
unchanged: `parseStationUpgradeQuery`, `handleStationSocket`, `attachPstnLegVerified`.
`request.ip` is the same as in the primary, because the socket peer (nginx) and
`x-forwarded-for` are the same and `trustProxy` is the same hop-count function.

### 2.4 Auth, the single-use token, rate limits, `maxPayload`, back-pressure

- **Station token.** Minted over authenticated HTTP. The mint is a session-scoped internal
  handler, so it runs in the owner, but the token lives in Redis, so either process would do.
  It is verified and consumed in the worker, inside `handleStationSocket`, unchanged. The
  primary routes on the path's `sessionId` alone and never reads `?token=`, so a token is spent
  exactly once, by the process that keeps the socket. An unknown `client=`/`media=` is still
  refused 1008 by the worker before the token is consumed. A path-escaping or non-UUID session
  id hashes to some slot, and that worker refuses it as today.
- **Carrier tokens.** The provider token is verified in the worker by
  `attachPstnLegVerified` (Q6), unchanged. Webhook tokens: §3.2.
- **Rate limits** are charged once, in the primary, because every request and upgrade passes
  its Fastify. Workers register no limiter. The per-user bucket is charged by
  `sessionMiddleware` in the public layer (primary). Forwarded internal handlers run no
  session middleware, so nothing is charged twice. The rate-limit tests keep their meaning.
- **`maxPayload`** is enforced by `ws` in the worker, with the same 64 KiB default and the
  per-route sizing in `utils/ws-limits.ts`. The primary never reads a frame.
- **Back-pressure** stays per socket in the worker (`utils/ws-backpressure.ts`: soft limits,
  the 1 MiB station cap, 4408). Nothing about it crosses a process boundary, because no media
  goes over IPC.

### 2.5 Routing the carrier: a slot hint in the URLs

`placeOutboundLeg` (`core/webrtc-bridge-manager.ts`, step 6) builds the two URLs the carrier
gets. A worker appends its slot to both:

```
wss://<host>/api/v1/webrtc-call/<callId>/pstn-stream?token=<provider token>&w=<k>
https://<host>/api/v1/webhooks/voicelink/webrtc-status/<callId>?token=<webhook token>&w=<k>
```

`w` is routing, not authority. A forged or stale `w` reaches a worker that has no session for
that call id. The token check (Redis) and `handleVoicelinkStatus`'s "no live session → late
terminal" path then do exactly what they do today for an unknown call. Why a hint rather than
a `callId → worker` map in the primary: the URL is fixed before `add_lead` is sent. The
carrier cannot connect or post before the primary would know, and no IPC event can race it.
It survives nothing extra and costs nothing. Absent `w` (calls from before a restart, the
single-process mode): handled in the primary (§3.2). `redact-url.ts` keeps redacting
`token`, and `w` is not secret. In single-process mode no `w` is written.

### 2.6 Spike: `apps/server/scripts/spikes/ws-handoff-spike.ts`

One file, three roles:

- **Primary.** A Fastify app on an ephemeral port, with an async `onRequest` hook standing in
  for the Redis limiter (3 ms await, 429 on a header). It routes upgrades as in §2.1 and hands
  each one to `fnv1a(id) mod N`.
- **Workers.** `@fastify/websocket` with a 64 KiB `maxPayload`, adopting as in §2.3 and
  relaying like the A-law passthrough: a binary 160-byte frame becomes JSON base64 on the
  carrier leg, and the reverse. Each worker sends 20 IPC requests a second to the primary
  throughout, to measure round-trip time under load.
- **Client.** Its own process.

```
pnpm tsx scripts/spikes/ws-handoff-spike.ts          # from apps/server
SPIKE_WORKERS=2 SPIKE_CALLS=200 SPIKE_SECONDS=10 pnpm tsx scripts/spikes/ws-handoff-spike.ts
SPIKE_NO_READSTOP=1 …                                # mutation check
```

**Checks (all green):**

- both legs of a call on the same worker, the one the key names;
- query string and client IP survive the handoff;
- a frame each way through the worker's relay;
- 1009 past `maxPayload`, enforced in the worker;
- 429 from the primary's async hook, written before any handoff;
- 404 for an unknown WebSocket path;
- plain HTTP keep-alive served by the primary;
- a first frame sent in the same write as the upgrade request reaches the worker (it travels
  as `head`);
- a first frame sent 1 ms later, while the primary is inside its async hook, reaches the
  worker (it stays in the kernel and travels with the fd).

**Mutation:** with `SPIKE_NO_READSTOP=1` the last check goes red
(`early_frame_during_hook: false`, `bufferedAtHandoff: 1`). So the read stop in §2.1 is
load-bearing, and the build pins it with a test.

**Load** (200 calls, both legs, 50 fps each way, 10 s; a 4-core dev machine shared with
another test run, so read the ratios, not the absolutes):

| Workers | Frames delivered/s (of 20 000) | Primary loop | Each worker | IPC round trip (worker → primary → worker) |
|---|---|---|---|---|
| 1 | 18 761 | ELU 0.016, 2% CPU | ELU 0.79, 64% CPU, 19 000 relayed/s | p50 1.8 ms, p99 80 ms |
| 2 | 18 983 | ELU 0.019, 2% CPU | ELU 0.42 / 0.41, 35% CPU each, ~9 700 relayed/s | p50 0.55 ms, p99 20–30 ms |

The client process, which sends and receives 40 000 messages a second alone, is the likely
reason delivery is 94–95% of offered. What the spike establishes:

- The handoff works through the stock `@fastify/websocket` path in the worker.
- The primary's loop stays at ~2% while the workers carry the media.
- Relay load splits evenly across workers.
- IPC latency is sub-millisecond at the median. Its tail is the *receiving worker's* own loop
  delay, the same symptom as today's single loop. That is why the dial path's authorisation
  check is kept synchronous (§3.1) rather than made an IPC round trip.

## 3. The life of a call across processes

P = primary, W*k* = the agent's media worker (`slotFor(sessionId)`).

### 3.1 Reserve, dispatch, dial, media

| Step | Where | IPC |
|---|---|---|
| Agent joins (`POST /proxy/agency/sessions`): session row, rehydrate | P (no owner yet; Redis and Postgres only) | — |
| Station token mint (`POST /sessions/:id/station-token`) | W*k* via `core.inject`; the token is in Redis | `core.inject` request/response |
| Station upgrade | P routes → W*k* verifies the token, attaches, claims `agency:station:{sessionId}` = W*k*'s replica id, rehydrates, sends `ready` | `handoff` (socket); then event `station.attached {sessionId, campaignId, replicaId}` |
| Agent goes available | W*k* (`/available`, `isLocallyOwned` is meaningful there); the state write fires `onAvailable` | event `pacing.invalidate {type:'agent_available', sessionId, campaignId}` → P's in-process bus |
| Pacing round: candidates | P: `findLiveForCampaign` ∩ `StationDirectory.isAttached` (replaces `isLocallyOwned`); states by one pipelined Redis read, as now | — |
| Reserve (Redis CAS), claim contacts (SKIP LOCKED), pre-dial gates, `ownerOf`, attempt insert | P, unchanged | — |
| Dispatch | P: `IpcDialDispatcher.dispatch` checks the clearance with `rejectClearance` exactly as `LocalDialDispatcher` does, maps `ownerReplica` → slot (refuses a replica not in the live set), sends | request `dial.execute {cmd, grant}` |
| `executeDial` | W*k*: checks `cmd.ownerReplica === replicaId` (the same loud refusal as today), then `dialer.executeDial(cmd, { stillAuthorised })`, unchanged: flag read, priors, the `reserved` panel, lease CAS, `dialing` stamp, `liveByAttempt`, `createBridgedCall` | response when it settles |
| `stillAuthorised` | W*k*, **synchronous**, from pushed grants (below) | events `pacing.revoke {campaignId|null, upTo}` |
| Media URL minting | W*k* in `placeOutboundLeg`: tokens stored in Redis (Q6 memo on failure, in W*k*), URLs with `&w=k` | — |
| `add_lead` to VoiceLink | W*k* | — |
| Carrier media connect | P routes by `w` → W*k* verifies the provider token, adopts the leg | `handoff` |
| Relay | W*k* only, both sockets local | none |

**`stillAuthorised` without a round trip.** `DialOptions.stillAuthorised` is synchronous on
purpose: it sits between the panel send and the lease CAS. Over IPC it becomes a value:

- The pacing engine numbers each campaign's leadership (`grant`, incremented in
  `beginLeading`).
- `dial.execute` carries the grant it was issued under.
- When P revokes a campaign (lease lost) or begins `stop()`, it sends
  `pacing.revoke {campaignId, upTo: grant}` (or `campaignId: null` for stop) to every worker.
- The worker answers `stillAuthorised()` from a local map:
  `!stoppedAll && (revokedUpTo.get(campaignId) ?? -1) < cmd.grant`.

The IPC channel is FIFO, so a revoke issued after the dial was sent arrives during
`executeDial`'s own awaits, exactly when an in-process flag flip would be seen. A revoke within
the ~1 ms channel latency of the check is treated like a stop "inside the two writes after
that check" today: the dial goes out like any dial placed before the stop. In single-process
mode the closure stays `() => this.mayDial(campaignId)`.

**Dispatch outcomes.**

| What happens | `IpcDialDispatcher` does | Why |
|---|---|---|
| Worker answers ok | resolves | |
| Worker answers with an error (`executeDial` threw, owner mismatch) | throws | pacing ends the attempt `failed` and returns the pair, as today |
| Slot down, or replica not live, before sending | throws `DispatchRefused('owner_down')` | same |
| Timeout (`dial.execute` deadline 40 s: VoiceLink login 10 s + `add_lead` 15 s + database) | logs, counts, **resolves** | the worker still owns the attempt and will settle it; throwing would make pacing a second writer of a row the worker may be bridging |
| Worker dies after the send | resolves | the slot reap (§6.1) owns the cleanup |

**Returning a reserved agent.** Today `returnReserved` asks `queuedBreakRelease.hasQueuedBreak`
synchronously, and the `BreakRegistry` it reads lives in the worker. It becomes an injected
`ReservedReturn` (`returnReserved(sessionId): Promise<void>`):

- Single process: today's body.
- Primary: request `agent.return_reserved {sessionId}` to the owner, which runs today's body
  there. If the owner is down: `agents.set(sessionId, 'offline')`.

It is already awaited in `dialUpTo`, so nothing changes shape.

### 3.2 Webhooks

`POST /api/v1/webhooks/voicelink/webrtc-status/:callId` is charged to the `webhook` bucket and
its body parsed in P. Then:

- `w` names a live slot → request `carrier.webhook {callId, token, body}`. W*k* runs
  `handleVoicelinkWebhook(bridge, callId, token, body)`, extracted unchanged from the route:
  verify the webhook token (Q6), `parseVoicelinkWebhook`, `handleVoicelinkStatus`. It answers
  `{status, body}` and P replies with it. Deadline 10 s, then 503 (never a 200 for a post that
  was not processed).
- No `w`, or the slot is down → P runs the same function on its own **session-less** bridge.
  With no live session it can only take the late-terminal path
  (`persistLateVoicelinkTerminal`), which is correct: a call whose worker is gone has ended.

### 3.3 Answered, bridged, ended: back to pacing and the stats

Everything the call does after the dial happens in W*k*, in process, as today:

- the answer anchor, the abandon decision and the clip;
- `answered_at` / `bridged_at`;
- the compliance denominator counter;
- seat-time histograms;
- the `ended` write and contact settlement;
- wrap-up entry.

Pacing never read these in process. It reads the database per round (`countLiveForAccount`)
and is woken by the bus. So only bus events cross:

- `account_capacity_freed` (attempt and manual-call ends);
- `agent_available` (wrap-up ends, releases).

The abandonment window and the 3% guardrail, and the live-concurrency gauges, are table reads
in P, unchanged. Counters and histograms are emitted by whichever process saw the event and
summed in Grafana (§7).

### 3.4 Wrap-up, dispositions, hangup, breaks, the soft phone

The public handler (P) authenticates, checks tenancy and RBAC, and calls `callCore`.
`callCore` keeps everything up to the `app.inject` call. That call becomes
`injectCore(owner, {method, url, headers, payload})`:

- local (single-process mode, or no owner): `app.inject`, as today;
- remote: request `core.inject` to the owner slot, which runs `inject` on its own internal
  instance and answers `{statusCode, headers, body(base64)}`. Bodies are capped at 1 MiB;
  anything streaming large is classified `none` and stays in P.

Each internal route declares `config: { owner }`, and a guard test enumerates `onRoute` on
the internal instance and requires one:

| `owner` | Routes (current table) | Resolved in P by |
|---|---|---|
| `session` | `POST /sessions/:id/{available, break, break/cancel, force-available, leave, softphone, softphone/return, station-token}` | the path param |
| `attempt` | `POST /attempts/:id/{disposition, dnc, hangup, notes}` | `agency_attempts.reserved_agent_id` (one PK read) |
| `manual_call` | `PATCH /softphone/calls/:id`, `POST /softphone/calls/:id/{disposition, dnc, hangup}` | `agency_manual_calls.session_id` (one PK read) |
| `actor_session` | `GET /softphone/bootstrap`, `POST /softphone/calls` | the caller's live session (the read the handler already makes, moved before the forward) |
| `none` | `POST /sessions`, `POST /softphone/sessions`, softphone settings, call lists, `GET /softphone/calls/:id/recording`, everything under `/agency-campaigns` and `/agency-agents` | stays in P |

A route that reads per-session runtime state (`runtime.{dialer, wrapup, breaks, softphone,
manualDialer}` or `stations.isLocallyOwned/send`) must not be `none`. A source-text guard
scans the internal handlers for those members, in the style of the agent-reach tests. If the
owner slot is down: 503 `worker_unavailable` (retryable).

Consequences, all the same as single-process semantics:

- `/available` answers 409 when the station is not attached *to the owner*, which is the only
  place it can be.
- The mandatory-disposition refusal reads the owner's `WrapupManager`.
- `/leave`'s live-attempt check reads the owner's `liveByAttempt`.
- `stationPresence` stays unwired, for the reasons its comment gives.

**Hangup** (`/attempts/:id/hangup`) runs in the owner, which holds the bridge session.
**Supervisor `force-available`** (on behalf) is session-scoped and forwarded the same way.
**Soft phone:** `ManualDialer` dials agent-first on the session's worker (the station socket
is its media leg), and its carrier URLs carry `w` like any call.

**Frames from P to stations.** The campaign announcer's `broadcast` goes to every worker as
event `station.broadcast {campaignId, frame}`. Its return value, logged only, becomes the
directory's attached count for that campaign. No other P-side code sends station frames once
the session-scoped handlers run in the owner.

## 4. IPC protocol (`src/cluster/ipc-protocol.ts`, `ipc-channel.ts`)

### 4.1 Envelope

```ts
type Envelope =
  | { v: 1; kind: 'event'; type: string; body: unknown; tp?: string }
  | { v: 1; kind: 'req'; id: number; type: string; body: unknown; deadlineMs: number; tp?: string }
  | { v: 1; kind: 'res'; id: number; ok: true; body: unknown }
  | { v: 1; kind: 'res'; id: number; ok: false; error: { code: IpcErrorCode; message: string } }
  | WsHandoff;                                    // §2.2, sent with the socket handle
type IpcErrorCode = 'timeout' | 'gone' | 'not_owner' | 'refused' | 'handler_error' | 'malformed' | 'too_large';
```

- JSON serialisation (Node's default `serialization: 'json'`), so a socket handle can ride
  along.
- `tp` is the W3C `traceparent` of the sender's active span. The receiver continues it, so a
  dial's spans in the worker join the pacing tick's trace.

### 4.2 Validation

Every type has a decoder in the `parsePacingInvalidationEvent` pattern:
`parseX(raw: unknown): X | null`. A malformed body or an unknown type is dropped, logged once
per type per minute and counted (`ipc_messages_total{result="malformed"}`). A malformed
*request* is answered `malformed` rather than left to time out.

Decoders for record-carrying messages revive dates explicitly (`DialCommand`'s
`AgencyCampaignRecord` and `AgencyContactRecord`, manual-call rows). They are hand-written
over a small zod schema per type, inside `src/cluster/`. They never re-read the database,
because `DialCommand` is "a value, not a set of ids to re-read".

`DialCommand.clearance` (a brand only `pre-dial-gates.ts` can mint) does not cross. P checks
it before sending, which is the same choke point and the same check `LocalDialDispatcher`
runs. The worker trusts a command only from its parent channel.

### 4.3 Message catalogue

**Primary → media worker**

| Type | Kind | Body | Deadline |
|---|---|---|---|
| `handoff` | handoff + socket | §2.2 | — |
| `dial.execute` | req | `{cmd: DialCommand, grant}` | 40 s, then resolve-and-log (§3.1) |
| `pacing.revoke` | event | `{campaignId \| null, upTo}` | — |
| `core.inject` | req | `{method, url, headers, payload?}` | 15 s, then 504 |
| `carrier.webhook` | req | `{callId, token, body}` | 10 s, then 503 |
| `agent.return_reserved` | req | `{sessionId}` | 5 s, then `offline` write in P |
| `station.broadcast` | event | `{campaignId, frame}` | — |
| `concurrency.invalidate` | event | `{tenantId, accountId}`: drop the provider guard's 5 s `limitCache` and the degraded-mode local cache, as the seam does in P | — |
| `reaper.snapshot` | req | `{}` → `{activeAttemptIds, unrecordedEnds, manualActiveIds, activeCallIds}` | 5 s, then **skip the sweep** (fail closed) |
| `reaper.forget_unrecorded` | event | `{attemptIds}` | — |
| `softphone.closed_by_sweep` | req | `{rows}` (sent to each row's session slot) | 10 s |
| `health.ping` | req | `{}` → `{elu, stations, liveCalls, draining}` | 1 s |
| `shutdown` | req | `{graceMs}` | `graceMs` |

**Media worker → primary**

| Type | Kind | Body |
|---|---|---|
| `ready` | event | `{role, slot, replicaId, pid}` |
| `station.attached` / `station.detached` | event | `{sessionId, campaignId, replicaId}` / `{sessionId}` |
| `station.snapshot` | event | `{sessions: [{sessionId, campaignId}]}`, on ready and on request (reconcile) |
| `pacing.invalidate` | event | a `PacingInvalidationEvent` |
| `voice.wake_self_heal` | event | `{}` (the guard host's `wakeSelfHeal` in shard mode) |
| `analysis.wake` | event | `{}` |

**Primary ↔ analysis worker:** `ready`, `analysis.wake` (P → all),
`analysis.rate_paused {untilMs}` (one worker → P → all others, so one vendor 429 pauses the
fleet rather than each process discovering it; decision D10), `health.ping`, `shutdown`.

### 4.4 Correlation, timeouts and failure

`IpcChannel` (one per child in P, one to the parent in each child):

- monotonically increasing `id`;
- a pending map `id → {resolve, reject, timer, type, sentAt}`;
- a per-type default deadline (the tables above) that a caller may shorten;
- on `exit` / `disconnect`, every pending request rejects with `gone`;
- a request to a slot that is not `ready` rejects at once with `refused`;
- `ipc_request_duration_seconds{type}` and `ipc_request_failures_total{type, code}`.

### 4.5 Back-pressure and a slow worker

No media and no per-frame message crosses IPC. At 500 calls the expected control traffic is:

- tens of dials a second at peak (~510 dials a minute);
- ~15 webhook forwards a second;
- agent-control forwards in the tens a second;
- bus events in the low hundreds a second.

That is under 1 000 small JSON messages a second in total.

- `child.send` returns `false` when the channel's queue passes Node's threshold. That is
  counted (`ipc_send_backlogged_total`) and logged once a minute. Messages are still queued,
  never dropped, because every event here either has a backstop (bus events: the safety tick
  and cache TTL; `station.*`: the snapshot reconcile on every health ping whose count
  disagrees) or is a request with a deadline.
- In-flight requests per worker are capped at 256. Past that, new requests fail `refused`:
  - a dial is returned to the pool;
  - a forward answers 503;
  - a webhook answers 503 and the carrier retries.

  A worker that is that far behind is already failing its calls.
- A **slow worker** (loop saturated) shows as rising `ipc_request_duration_seconds` and
  `health.ping`'s `elu`. Its calls degrade as all calls do on today's saturated single loop,
  but the other workers and P are unaffected, which is the point of the split. v1 only
  measures and alerts. Shedding (P stops picking candidates on a slot whose ELU stays above
  0.85) is a follow-up (decision D5).

## 5. Ownership and the single-replica invariants

### 5.1 Replica id per process

`AgencyRuntime.replicaId` comes from `process.env.REPLICA_ID`. In cluster mode the primary
sets it per child: `${base}:mw${k}:${pid}` for media workers and `${base}:p:${pid}` for
itself. `base` is `REPLICA_ID` or the hostname. It is unique per *incarnation*, so a station
ownership key written by a crashed worker names a replica the primary knows is dead. The
primary keeps the live set: replica ids of children that sent `ready` and have not exited.

`agency_agent_sessions.owner_replica` is written at join. It is informational (nothing reads
it) and will read the primary's id. The build may stamp the worker's id at attach instead
(D11).

### 5.2 Station ownership keys

`agency:station:{sessionId}` is unchanged in shape and TTL (30 s, renewed by the station
ping), and written by the worker that holds the socket. Readers:

- **Pacing (P)**: `ownerOf` → `ownerReplica` → slot. A replica not in the live set is treated
  as no owner, so the pair is returned and the agent written `offline`, as today for a null
  owner.
- **Reaper (P)**: present **and** naming a live replica ⇒ held. A key naming a dead replica
  ⇒ not held. That is the reaper's documented multi-replica rule ("owned by a replica whose
  heartbeat is gone") made exact rather than TTL-approximate. A Redis error still fails
  closed (held).
- **Supervisor floor**: `connectedBySession` (MGET, presence only), unchanged and correct
  across processes.

### 5.3 The Q6 "SET failed at mint" memo

It is sound with this design, because **mint and verify are always in the same process**:

- Provider and webhook tokens are minted in `placeOutboundLeg` on W*k*.
- The provider token is verified on the PSTN connect, routed by `w=k` to W*k*.
- The webhook token is verified on W*k* by the forwarded `carrier.webhook`.

The only way verify lands elsewhere is that W*k* is gone. Then the call is gone too (§6.1),
and a late webhook verified in P with no memo is refused when its key is missing. That is the
same outcome a single-process restart has today ("a bridged call does not survive a
restart"). The memo stays process-local, and Q6's note that "scaling out needs the memo shared
or the excuse dropped" is answered by never splitting mint from verify. The cap
(`UNSTORED_WS_TOKEN_CAP` 10 000) becomes per worker.

### 5.4 `StationTokenStore.mint`'s local fallback

**Finding:** the fallback is already dead whenever Redis is configured.

- `mint` stores locally when the Redis `SET` throws.
- `verifyAndConsume` consults the local map **only when `this.redis` is null**. With a client
  configured it always asks Redis, and fails closed.

So today a token minted during a `SET` failure is refused (4401), and the console re-mints
until Redis answers. Across processes nothing changes: the mint and the verify may now be in
different processes, but the local map never mattered with Redis present. Cluster mode
**requires** Redis at boot (no Redis ⇒ refuse to fork workers). The build should make `mint`
answer 503 `station_token_unavailable` on a failed `SET` in every mode, rather than hand out a
token that cannot work. That is a behaviour change, so it is decision D9.

### 5.5 Sweeps: who runs them, and leader-only

There is one primary per host and one host, so "leader-only" means "primary only". No
election is needed.

| Sweep | Where | Cross-process input |
|---|---|---|
| `reapOnStartup` (all non-terminal attempts dead, `markAllOffline`, manual startup sweep) | P, **before any media worker is forked**, so its "dead by definition" premise still holds | — |
| `reapSlot(k)` (new, §6.1): the startup rule narrowed to one dead worker | P, on worker exit, **before** re-forking slot *k* | the dead slot's sessions by `slotFor` |
| `sweepOnce` (leaked attempts) | P | `owned` = union of every worker's `reaper.snapshot` `activeAttemptIds`; `isAgentHeldSomewhere` per §5.2; a snapshot timeout skips this cycle |
| `reapUnrecordedEnds` | P | snapshots' `unrecordedEnds`; `reaper.forget_unrecorded` back to each worker |
| `sweepLapsedWrapups`, `sweepStrandedContacts` | P | none (database) |
| `sweepManualCalls` | P | `manualActiveIds` union; `softphone.closed_by_sweep` to each row's slot |
| Guard self-heal reconcile (counters vs lock keys, Redis-global) | P | woken by `voice.wake_self_heal` |
| Stale WebRTC call sweep | P | `excludeIds` = union of `activeCallIds`; its cutoff (≥ 4 h 5 min) is the real guard |
| Silent-station sweep | each worker, its own stations | — |
| Audit partitions, retention purge, credential shred, ingest reaper, clip cache sweep | P | — |
| Analysis `recoverStale`, promote, expire | every analysis process (all `SKIP LOCKED` / guarded, already multi-process safe) | — |

B13: `TelephonyGuardHost.getActiveCallCount()` in P becomes the sum of the workers' last
`health.ping` `liveCalls`, so the self-heal poll stays armed while any worker bridges a call.

### 5.6 Concurrency guards and their caches

- **Redis state** (counters, per-call lock keys, generation keys, the account limit cache) is
  shared, and admission is atomic in Redis. It is correct across processes as it is across
  replicas.
- **Provider guard `limitCache`** (5 s TTL, per process). P's concurrency seam invalidates its
  own, then broadcasts `concurrency.invalidate`. A lost event costs at most 5 s.
- **Degraded mode (Redis down).** The global and account guards fall back to process-local
  leases. With N workers each would admit up to the full limit, so N× the limit in an outage.
  - Dialer calls are bounded anyway by pacing's database count (`countLiveForAccount`,
    global).
  - Soft-phone calls are not.
  - Provider-mode accounts already fail closed.

  Proposal: in cluster mode the degraded local limit is `ceil(limit / MEDIA_WORKERS)` (D6).

### 5.7 The reaper's "trivial startup case"

It survives unchanged for a whole-host start (above). The new case is one dead worker while
the others live. `reapSlot(k)` is that rule narrowed: "non-terminal and owned by a replica
whose heartbeat is gone", where "gone" is certain (the primary saw the exit) and ownership is
`slotFor(reserved_agent_id) === k`. No 5-minute age floor is needed, because the owning
process is dead by definition, and slot *k* is not re-forked until the reap finishes, so
nothing new can be owned by it meanwhile.

## 6. Failure and lifecycle

### 6.1 A media worker crashes mid-call

- **What the agents on slot *k* experience** (~1/N of the floor): the station socket drops
  (the kernel closes the dead process's fds, so they see a reset, not a timeout). The console
  and the app run their reconnect ladders. Upgrades answer 503 until slot *k* is back, then
  re-mint and attach. They come back in `break` and choose to go available, the same rule as a
  restart.
- **What the customers on slot *k* experience:** their media socket closes. `reapSlot` hangs
  their carrier legs up through the VoiceLink REST API (below), so they hear the call end
  rather than silence until the carrier notices.
- **Everyone else:** nothing. Other workers' sockets, calls and relays are untouched, and P
  keeps pacing.

`reapSlot(k)`, in P, in order:

1. Mark slot *k* down. The directory drops its sessions, so pacing stops picking them,
   dispatch refuses them, and forwards and upgrades answer 503. Every pending request to it
   fails `gone`.
2. Live calls of the dead slot: `agency_calls` non-terminal whose attempt's or manual call's
   session hashes to *k*, plus the last snapshot's `activeCallIds`. For each:
   - `hangupProviderLeg` best-effort (P holds the telephony registry and the credential
     service);
   - release its guard leases by call id (`releaseTelephonyLease`), so capacity returns now
     rather than when the 330 s lock TTL lapses;
   - mark the call row failed (`STUCK_ACTIVE_CALL`-style audit, reason `worker_exited`).
3. Attempts: non-terminal attempts whose `reserved_agent_id` hashes to *k* →
   `reapByIds` (state-guarded) → `requeueOrphanedContact` on the our-fault ledger, as the
   startup reap does.
4. Manual calls of those sessions → the orphan path of `sweepManualCalls`.
5. Agent leases of the slot's live sessions are cleared, and rows marked `offline`, so the
   agents rehydrate into `break`. That closes today's fast-restart window in which a
   still-live `on_call` lease would rehydrate as `on_call`. Station ownership keys naming the
   dead replica are deleted by compare-and-delete on the value.
6. Then re-fork slot *k*. It boots, sends `ready` and `station.snapshot` (empty), and is
   routable.

Every write above is state-guarded, so a pacing catch path racing it (§3.1) cannot
double-settle.

### 6.2 Restart policy

- Re-fork immediately after `reapSlot`. Then back off on repeats: 1, 2, 4, 8, … 30 s.
- More than 5 exits of any one slot in 5 minutes is a **crash loop**. The primary logs fatal
  and exits 1, and Docker's `restart: unless-stopped` restarts the container, so the whole
  host starts clean (D4).
- An analysis worker that exits is re-forked with the same backoff. Its claimed jobs are
  recovered by `recoverStale` once their heartbeat lapses, and nothing else is reaped.

### 6.3 The primary crashes

- In the container the primary is PID 1 (`exec node`). When it dies the container stops and
  every child is killed with it. Outside a container, children see their IPC channel
  `disconnect`: they run `bridge.gracefulShutdown` bounded to 5 s (hang up their carrier
  legs) and exit 1.
- Either way, the next boot's `reapOnStartup` sees a host with no live process and its
  premise holds.

### 6.4 Graceful shutdown within the 45 s grace

Children ignore SIGTERM and SIGINT and log them. A dev Ctrl-C signals the whole process
group, and the order must stay the primary's. They stop only on the IPC `shutdown` request,
or on `disconnect`.

| t | Primary | Media workers | Analysis workers |
|---|---|---|---|
| 0 | SIGTERM. `app.close()`: no new connections or upgrades. In-flight HTTP finishes; forwards are bounded by their deadlines | serving | serving |
| ≤ 5 s | `pacing.stop()` (ticks drained, `TICK_DRAIN_TIMEOUT_MS`), broadcast `pacing.revoke {campaignId: null}`, reaper stop | revoked: no dial in preparation goes out | — |
| then, **concurrently** | completion-notice drain (≤ 30 s) | `shutdown {graceMs: 30000}`: worker `app.close()` (station and media sockets close, as today's HTTP close does), `runtime.stop()` (shard: dialer, wrap-up, manual dialer timers), `bridge.gracefulShutdown()` (hang up live calls, release slots), guard host, audit flush, Redis and pool close, OTel flush, `exit 0` | `shutdown`: stop claims, requeue in flight (generation-matched), audit flush, `exit 0` |
| | waits for every child's `exit` (bound 30 s, then SIGKILL and `reapSlot` for any killed media slot) | | |
| ≤ ~37 s | voice stop (guard host, its self-heal wait bounded at 15 s, runs inside the window above), platform (audit buffers last), Redis, pool, OTel, `exit 0` | | |

Worst case is 5 s + 30 s + a few seconds, inside 45 s. Today's sequence runs the stops one
after another. In cluster mode the agency drain and the children's drains overlap, so adding
processes does not lengthen shutdown. The order inside each worker matches today's order
inside one process. `runtime-boot-order.test.ts` keeps pinning single-process mode, and a
cluster twin pins the table above.

### 6.5 Deploys

Unchanged: one container on one host, replaced on deploy. Live calls end, as today (the
bridge hangs them up), and agents come back in `break`. This design adds what a later rolling
deploy of media workers would need (a slot can be drained: stop picking its agents, wait for
its calls to end, restart it). That is not built, and it would not help a server image change,
which replaces the primary too.

### 6.6 Health and readiness

- `/healthz`: the primary is up, unchanged.
- `/readyz`: Postgres `SELECT 1` and Redis `PING`, as today. In cluster mode it also requires
  every media slot to be `ready` and to have answered `health.ping` within 2 s. A slot
  restarting makes `/readyz` 503 for the ~1–2 s it takes. The compose healthcheck's interval
  and retries ride that out.
- Single host, no load balancer: a 503 there takes nothing out of rotation. The alternative,
  "ready while at least one slot is", hides a dead slot from the healthcheck (D5).
- `GET /readyz?detail=1` returns the per-process view (role, slot, `ready`, `elu`,
  `stations`, `liveCalls`). It must stay exempt from the rate limiter like `/readyz` (the
  exemption has to match the path, not the URL with its query). Its body holds no secret.

## 7. Observability

- **Series identity.** Each process exports its own metrics over OTLP. Without a distinct
  `service.instance.id`, counters from several processes interleave into one series and
  `rate()` reads resets (the note in `utils/otel-sdk-config.ts`). In cluster mode the instance
  id is forced on, `<OTEL_SERVICE_INSTANCE_ID or hostname>:<role><slot>` (`:primary`,
  `:media0`, `:analysis0`). It is stable across a child's restarts, so a crash loop does not
  churn series. Series multiply by the processes that emit each metric: pacing metrics only
  from P, bridge metrics only from media workers, runtime-node gauges from all. That is decision
  D7, against the Grafana Cloud series cap.
- **Logs.** The pino base gains `role` and `slot`; `pid` is already there. Children's stdout
  and stderr are piped to the primary, which forwards whole lines. Two processes writing to
  one pipe interleave lines longer than `PIPE_BUF` (4 KiB), and some error lines are longer.
  Forwarding costs the primary work in proportion to log volume, which is small.
- **OTel in children.** `instrumentation.ts` is the first import of the one bundle every role
  runs, so each child starts its own SDK with the same env. `shutdownOtelSdk()` is called
  last in each child's shutdown. Trace context crosses IPC in the envelope's `tp`.
- **New metrics**, declared in `packages/observability/src/metrics/voice.ts` (the area that
  owns the WebSocket surfaces and the limiter), all bounded label sets:
  - `ws_handoff_total{route, result}`
  - `ipc_messages_total{role, type, direction, result}`
  - `ipc_request_duration_seconds{type}`
  - `ipc_request_failures_total{type, code}`
  - `ipc_send_backlogged_total{role}`
  - `cluster_worker_exits_total{role, reason}`
  - `cluster_slot_reaped_total{what}`
- **Grafana.**
  - Existing rules aggregate `by (service_name)` and keep working.
  - *Event-loop delay p99* (`max by (service_name)`) now pages on the worst process, which is
    what an operator wants.
  - New dashboard panels: ELU and p99 delay `by (instance)`, IPC request p99 by type, worker
    exits, handoff failures.
  - New rules: a media worker exit (any), and a crash loop.
  - `pnpm test:grafana` checks every new rule and panel against the declarations above, so the
    metrics must be declared in the same commit that the panels reference them.

## 8. Config

| Env | Key | Block | Default | Meaning |
|---|---|---|---|---|
| `MEDIA_WORKERS` | `processes.mediaWorkers` | `base.ts` (new top-level key `processes`) | `0` | 0: single process, exactly as today. N ≥ 1: primary plus N media workers |
| `MEDIA_WORKER_HEAP_MB` | `processes.mediaWorkerHeapMb` | `base.ts` | `768` | `--max-old-space-size` for each media worker (the fork's `execArgv`; the image's 4096 applies to the primary only) |
| `PRIMARY_HEAP_MB` | `processes.primaryHeapMb` | `base.ts` | unset (the entrypoint's flag) | lets the entrypoint keep one value per role |
| `WORKER_CRASH_LOOP_MAX` | `processes.crashLoopMax` | `base.ts` | `5` (per 5 min) | §6.2 |
| `ANALYSIS_WORKERS` | `dialerAnalysis.processes` | `analysis.ts` | `0` | 0: analysis slots run in the primary, as today. K ≥ 1: K analysis processes with `DIALER_ANALYSIS_CONCURRENCY` slots and `DIALER_ANALYSIS_MEMORY_BUDGET_BYTES` each |

Why there:

- Process topology is a process-level concern like `server`, `db` and `redis`, so it is
  `base.ts`, a shared file changed deliberately with its consumers.
- The analysis process count means nothing without the analysis block and sizes the same
  pool `DIALER_ANALYSIS_CONCURRENCY` does, so it is the analysis area's.
- Keys stay disjoint; `blocks-disjoint.test.ts` gains `processes`. `docs/seams.md` §2's base
  row should read `server, db, redis, otel, processes` (`otel` is already there in the code and
  missing from the table).
- The two settings are independent: `ANALYSIS_WORKERS` works with `MEDIA_WORKERS=0`. That is
  build step 2, and the safest first gain.
- Boot refuses `MEDIA_WORKERS > 0` without `REDIS_URL` resolving at start, or with
  `MEDIA_WORKERS > os.availableParallelism()`.

### 8.1 How many workers on which host: honest numbers

The CPU per relayed frame in Node is ~35 µs (bench and spike agree). 500 calls is 50 000
relayed frames a second, about **1.75 cores for the Node relay alone**. nginx and the TLS
terminator in front also touch every frame, both directions, on the same host. Neither was
measured here, and they are not free.

| Host | Suggested | What to expect |
|---|---|---|
| 2 vCPU / 4 GB (the `aws/terraform` default, `t3.medium`) | `MEDIA_WORKERS=1`, `ANALYSIS_WORKERS=0` or `1` with a smaller budget | **500 calls is not reachable on 2 vCPUs** by any process layout: the relay alone needs most of both cores before nginx, TLS, Redis and pacing. One media worker does not raise the relay ceiling (~200 calls at a healthy loop, as today). It moves pacing, webhooks and the API off the media loop, so a saturated relay no longer delays dials or webhooks. A second media worker on 2 vCPUs competes with the primary, nginx and the TLS terminator and buys little. `t3` is burstable: sustained relay load runs on CPU credits, so check the instance's credit specification |
| 4 vCPU / 8 GB | `MEDIA_WORKERS=2`, `ANALYSIS_WORKERS=1` | roughly 300–400 calls, to be measured with nginx and TLS in the path |
| 8 vCPU / 16 GB | `MEDIA_WORKERS=3`–`4`, `ANALYSIS_WORKERS=2` | 500 calls with each worker near 0.5 ELU |

**Measured since** (build step 8, a shared 4-core dev machine): one process saturates at 200
calls and cannot bridge more than about 250 of 500; with two workers all 500 bridge, the
primary's loop stays near 0.06 and each worker runs near 0.95. The table and the method are in
[`operations.md`](operations.md), "Sizing the media workers".

Rule of thumb: `MEDIA_WORKERS = min(vCPUs − 1, ceil(calls / 170))`. 170 calls keeps a worker
around 0.6 ELU on the bench's numbers. Leave a core for the primary, nginx and TLS. The real
figure for a host comes from the build-step-8 load test run on that host, with nginx and the
TLS terminator in the path.

**Memory**, the sum the host must hold:

- the primary's heap (the entrypoint's 4096 today, which alone equals a 4 GB VM's RAM);
- `MEDIA_WORKERS × MEDIA_WORKER_HEAP_MB`;
- `ANALYSIS_WORKERS × (DIALER_ANALYSIS_MEMORY_BUDGET_BYTES + ~512 MB)`;
- Redis, nginx and the OS.

The build lowers the primary's default heap when workers are configured. The pre-deploy
checklist gets a line.

## 9. Tests

**Unit** (no infrastructure):

- `ipc-protocol`: every decoder accepts its shape, refuses malformed and unknown input, and
  revives `DialCommand` dates. Round-trip property: `parse(JSON.parse(JSON.stringify(x))) ≡ x`
  for generated commands.
- `IpcChannel` over an in-memory channel pair: correlation, per-type deadlines, `gone` on
  disconnect for every pending request, the 256 in-flight cap, `send` back-pressure counting.
- `slotFor`: deterministic, and the distribution over 10 000 UUIDs within ±10% per slot.
- `IpcDialDispatcher`: a refused clearance throws before sending (mutation: drop the check
  and the test goes red); unknown replica → `DispatchRefused`; timeout and `gone` resolve
  without throwing; an `executeDial` error throws.
- Grants: a revoke after send makes the worker's synchronous `stillAuthorised` false; a revoke
  for an older grant does not.
- `StationDirectory`: attach, detach, snapshot reconcile, drop-on-exit.
- `ws-adopt`: an `IncomingMessage` rebuilt from raw headers passes `ws`'s validation
  (repeated headers, `sec-websocket-extensions`), and `request.ip` matches the primary's.
- The read stop: a test that fails if `net.Socket`'s handle stops exposing
  `readStop` / `reading` (it is a Node internal; the spike shows what breaks without it).
- **Guards:** every `websocket: true` route has `config.wsOwner`; every internal route has
  `config.owner`; no `owner: 'none'` handler reads per-session runtime state;
  `blocks-disjoint` with `processes`.

**Integration, multi-process** (real Postgres and Redis, real `fork`; a harness
`test/helpers/cluster-harness.ts` boots the real entry with `MEDIA_WORKERS=2` on an
ephemeral port against the worktree's test database):

- the end-to-end dial: join → mint → station upgrade (on the hashed slot) → pacing dial → mock
  VoiceLink (`test/mocks/voicelink`) media connect via `w` → answer → bridged media both ways
  → hangup → disposition (forwarded to the owner) → wrap-up → available;
- the same for a soft-phone call;
- webhooks: forwarded by `w`; no `w` → the primary's late-terminal path; a forged `w` → the
  other worker refuses or takes the late path, and nothing on the live call changes;
- Q6 across processes: force a token `SET` failure on W*k* and the call's webhooks still verify
  on W*k*;
- reaper: a snapshot timeout skips `sweepOnce`; a key naming a dead replica is not held;
- shutdown: SIGTERM with live calls on both workers; the order in the logs (by `time`) matches
  §6.4, it exits inside 45 s, and calls are hung up and slots released;
- `ANALYSIS_WORKERS=2`: two processes drain one queue with no job run twice; one vendor 429
  pauses both.

**Load:** `test/integration/load/multi-process-media.test.ts`, on the existing
`voicelink-load-harness.ts` and `station-floor-harness.ts`, sized by `LOAD_SCALE`.

- N calls (default 60; `LOAD_SCALE=8` for 480) across 2–3 workers, both legs at 50 fps for
  60 s, through the real primary.
- It reports per process: ELU, p99 loop delay, CPU and relayed frames a second (from
  `/readyz?detail=1` sampled each second). It also reports frame loss and inter-arrival
  jitter per leg.
- It asserts that the primary's ELU stays below 0.2, frame loss below 0.5%, and that no
  pacing round is skipped for lateness.
- A `LOAD_HOST=1` mode prints the per-process table for a run on a target host behind nginx.

**Chaos** (`test/integration/agency/chaos/`):

- `worker-killed-mid-call.test.ts`: SIGKILL W1 with calls live on both workers. W0's calls
  keep flowing (frames counted through the kill). Within one `reapSlot`:
  - W1's attempts end `orphaned` and their contacts are requeued on the our-fault ledger;
  - its carrier legs get a hangup;
  - guard counters equal the live calls left;
  - W1's agents reconnect after re-fork and land in `break`.
- `worker-crash-loop.test.ts`: the primary exits 1 after the configured count.
- `primary-killed.test.ts`: children exit on `disconnect`, and the next boot's startup reap
  closes everything.
- `worker-slow.test.ts`: a worker with an injected 200 ms loop stall. Its requests time out
  per their deadlines, the dial timeout leaves the attempt to the worker (one writer), and the
  other worker is unaffected.

**Existing suites** run in single-process mode, untouched, and keep their meaning. The new
code runs only under `MEDIA_WORKERS` / `ANALYSIS_WORKERS`, except for the step-3 refactors,
whose single-process implementations are today's bodies moved behind an interface.

## 10. Build plan

Each step is one commit (or a short series), shippable on its own, with its tests. Sizes are
lines of change including tests.

| # | Commit | Shared files | Size |
|---|---|---|---|
| 1 | `refactor(server): IPC protocol and channel for child processes`: `src/cluster/{ipc-protocol, ipc-channel, roles}.ts` (`slotFor`, role from env), unit tests. Nothing wired | — | S, ~600 |
| 2 | `feat(server): analysis worker processes (ANALYSIS_WORKERS)`: the primary forks K analysis processes running only the slot pool; retention stays in the primary; `analysis.wake` and `analysis.rate_paused`; shutdown requeue; a 2-process queue integration test; `operations.md` sizing | `config/blocks/analysis.ts`, `index.ts` (role switch), `docs/operations.md` | M, ~900 |
| 3 | `refactor(server): process seams for the dialer runtime` (single-process behaviour unchanged): `PacingStations` interface for `PacingEngine` and `CampaignAnnouncer`; `ReservedReturn` replacing `queuedBreakRelease`; leadership grants behind `stillAuthorised`; `injectCore` split out of `callCore`; `handleVoicelinkWebhook` extracted; the bridge's URL hint option (off); `AgencyRuntime` and `TelephonyGuardHost` role options; `config.owner` on internal routes plus the guards | `seams/` untouched; the bridge seam's member set unchanged (pinned by `webrtc-bridge-seam-contract.test.ts`); `api/core-dispatch.ts` | L, ~1 200 |
| 4 | `feat(server): hand WebSocket upgrades to media workers`: `ws-handoff.plugin.ts`, `ws-adopt.ts`, `buildWorkerApp`, `buildApp({ wsTransport })`, `config.wsOwner` guard; the spike's checks as an integration test | `app.ts`, `config/blocks/base.ts` (`processes`), `index.ts` | M, ~800 |
| 5 | `feat(server): dialer runtime shards in media workers (MEDIA_WORKERS)`: `IpcDialDispatcher`, `StationDirectory`, the IPC pacing bus (worker side) and its relay into the primary's bus, `core.inject` routing, webhook forwarding, broadcast, `concurrency.invalidate`, reaper snapshots, `voice.wake_self_heal`; the end-to-end multi-process integration test | `bootstrap/{agency,voice,analysis}.ts`, `agency/runtime.ts`, `api/webhooks.routes.ts` | L, ~2 000 |
| 6 | `feat(server): worker supervision, slot reap and cluster shutdown`: restart policy, crash loop, `reapSlot` (plus `agencyCallRepository` / attempt repository reads by session set; no migration), shutdown ordering, `/readyz` (+ `?detail=1`); chaos suites | `index.ts`, `app.ts` (`/readyz`), `packages/db` repository additions | L, ~1 200 |
| 7 | `feat(server,observability): per-process metrics, logs and traces`: instance ids per role, `role`/`slot` log fields, line-forwarding of child output, IPC metrics, Grafana panels and rules | `packages/observability`, `utils/otel-sdk-config.ts`, `grafana/` | M, ~600 |
| 8 | `test(server): multi-process media load test`: the harness extension of §9, `LOAD_HOST` mode | — | M, ~500 |
| 9 | `docs: multi-process operation`: `architecture.md`, `operations.md` (config, shutdown, health, sizing), `status.md` invariants (2: "one host, one primary; never scale `server`"), `seams.md` §1 (`src/cluster/` as composition) and §2 (`processes`), `decisions.md` (B16 amended, D1–D11), `DEPLOYMENT.md`; `docker/entrypoint.sh` heap per role; pre-deploy checklist | `docker/entrypoint.sh`, docs | S, ~300 |

Steps 1–3 change no behaviour. Step 2 is the first gain and is independent of the media work.
Step 4 can ship dark (no config enables it until 5). Steps 5 and 6 should ship together for
production use. Step 5 alone is safe to run in staging. CI: the multi-process integration
tests run in the existing server integration job; they fork processes against the same
service containers.

## 11. Decisions for Manas

| # | Decision | Recommendation |
|---|---|---|
| D1 | Topology | (a) runtime shards (§1.2) |
| D2 | Session ownership | sticky by `fnv1a(sessionId) mod MEDIA_WORKERS`. A worker crash costs ~1/N of the floor their live calls, and they reconnect in `break` |
| D3 | Carrier routing | the `w=<slot>` hint in the media and webhook URLs, over a primary-side `callId` map |
| D4 | Crash policy | re-fork with backoff; more than 5 exits of a slot in 5 min ⇒ the primary exits and the container restarts |
| D5 | `/readyz` and slow workers | not ready unless every media slot is ready; v1 measures slow workers and does not shed them |
| D6 | Guards with Redis down | each worker's local limit is `ceil(limit / MEDIA_WORKERS)` |
| D7 | Metrics | `service.instance.id` forced on per process in cluster mode (series × emitting processes) |
| D8 | Config placement | `MEDIA_WORKERS` in base (`processes`), `ANALYSIS_WORKERS` in the analysis block |
| D9 | Station token mint on a failed `SET` | answer 503 in every mode instead of a locally stored token that `verifyAndConsume` never reads (§5.4) |
| D10 | Vendor rate-limit pause | shared across analysis processes over IPC, rather than per process |
| D11 | `owner_replica` column | stamp the worker's replica id at attach, or leave it as the joiner's (informational either way) |
| B16 | Amendment | public handlers still call `callCore` in-process; for session-owned internal handlers that call is forwarded to the owning worker. B16's "one process, no network hop" becomes "no network hop" |
| Host | Sizing | 500 calls needs more than 2 vCPUs whatever the process layout (§8.1). On the current default host this design protects pacing, webhooks and the API from the relay, but does not raise the call ceiling |

## 12. As built (phase B, 2026-11-02): where the build departed from the design

| Topic | Design | As built, and why |
|---|---|---|
| Node internals (§2.1) | One internal: stopping the socket's reads | Two internals, in one module (`cluster/socket-pause.ts`), feature-detected, probed at boot and pinned by a unit test (§2.1.1). The second, `socket.server = null` before `child.send`, was found by the first end-to-end run: without it the primary's HTTP close waits for the workers' sockets forever. An integration test (the primary's close is not held open by a socket a worker holds) goes red without it. If either internal is missing, the primary runs as one process and logs a warning; there is no per-socket fallback |
| Refused upgrades | 503 written to the raw socket | 503, then the socket is destroyed once written: a client need not close its side, and a half-closed socket held the server's close open |
| Step boundaries (§10) | Steps 4, 5 and 6 as separate commits | One commit for the three: they share the protocol, the channel, the supervisor and `app.ts`, and none is usable alone. Steps 1–3 and 7–9 are their own commits |
| Runtime role options (step 3) | In the step-3 seam refactor | `AgencyRuntimeOptions` and `startShard` / `stopShard` landed with the shards that use them (step 5) |
| Heap per role (§8) | Entrypoint per role | `docker/` unchanged (no infrastructure change). Children get their heap through the fork's `execArgv`: `MEDIA_WORKER_HEAP_MB`, and for analysis the budget plus 512 MB. The primary keeps the entrypoint's 4 GB, so a host's RAM must cover the sum (pre-deploy checklist) |
| `MEDIA_WORKERS` vs cores (§8) | Boot refuses `MEDIA_WORKERS > availableParallelism()` | Not refused (config parsing stays independent of the host), but logged once at boot with the cores and the counts (media + analysis + primary) |
| Crash-time slot release (§6.1) | Release the slots from the worker's last snapshot | Exact. The bridge reports every admission and release as it happens (`observeLeases`), each worker forwards them as `call.lease` events, and the 5 s snapshot reconciles them, so the slot reap releases precisely what the dead worker held, including a call admitted a moment before the crash. Pinned by the chaos suite with the snapshots off; a mutation of the forwarding goes red |
| Crash-time carrier hangup (§6.1) | `reapSlot` hangs the dead worker's carrier legs up through VoiceLink's REST API | Not built: **VoiceLink has no hangup endpoint**, so a closed media socket is the only lever. Whether VoiceLink ends the call when its media socket drops, and how fast, is **unverified** and needs a sandbox check (`status.md`, "Not verified"). The rest of the reap is built: slots released, call rows failed, attempts ended `orphaned` with their contacts requeued, manual calls closed, agents written offline with leases cleared |
| Trace context across IPC (§4.1, §7) | `tp` in the envelope continues the sender's span | Not built: each process traces on its own. The envelope carries the `tp` field, unused |
| Readiness detail (§6.6) | Per-process view | As designed, plus each process's p99 loop delay and the primary's own loop sample. One process also answers `?detail=1` with its own loop; plain `/readyz` is unchanged |
| Analysis crash loop | Same as media | Analysis children are re-forked with backoff and never make the primary exit: analysis does not serve calls |
| Remote rate-limit pause (D10) | Each process half-opens when the pause ends | Also: a job here that slipped into a pause relayed from another process (its claim already on its way) cannot close that pause early. Found by a flaky multi-process run |
| D9 (station token mint) | Answer 503 on a failed `SET` | Not built (open decision) |
| Mobile stations (`docs/mobile.md`) | Unchanged by the handoff; untested (every multi-process test was `client=web`) | Unchanged, now tested: no defect found. The worker that holds a `client=mobile` station probes it every 3 s on the adopted socket, sees the pongs and sweeps it; M1's terminate and 8 s deferred hangup run there, and a phone back in time lands on the same worker (by hash) and resumes the call; `device_away` is forwarded to it. `cluster/mobile-stations.test.ts` (forked tree, public API, `alaw8` both ways) and `cluster/ws-handoff.test.ts` (the probe's timer and listeners go with an adopted socket). The load harness takes `--client web\|mobile\|<ratio>` |
