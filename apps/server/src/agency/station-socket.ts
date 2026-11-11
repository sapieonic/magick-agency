import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
import { agencyAgentSessionRepository, agencyCampaignRepository } from '../db/repositories/agency.repository.js';
import type { AgencyRuntime } from './runtime.js';
import { AGENT_LEASE_MS, type AgentLiveState } from './agent-state-machine.js';
import type {
  AgencyAgentState,
  AgencyStationClientFrame,
  AgencyStationMediaFormat,
  AgencyStationPingFrame,
} from '@magick-agency/contracts/agency';
import { AGENCY_STATION_CLOSE, SOFTPHONE_BREAK_REASON } from '@magick-agency/contracts/agency';
import type { AgencyAgentSessionRecord } from '../db/models/agency.model.js';
import { setBrowserLegMediaFormat } from '../core/bridge/browser-leg-media.js';
import { DEFAULT_STATION_UPGRADE, parseStationUpgradeQuery, stationCanTakeInbound, type StationUpgradeQuery } from './station-upgrade.js';
import { ownerModeOf, readAgentQueueState } from './pacing/agent-queue.js';
import { publishPacingInvalidation } from './pacing/invalidation-bus.js';
import { withTimeoutOr } from '../utils/with-timeout.js';

/**
 * The agent's station WebSocket: {@link handleStationSocket}, in this runtime-owned
 * module (decision B16).
 *
 * The console's station socket is served at `/proxy/agency/station/:sessionId` by
 * `proxyAgencyStationRoutes` (`api/routes/proxy-agency-station.routes.ts`), which makes
 * its refusals — a tokenless upgrade (4401), a path-escaping session id and an unknown
 * `client=` / `media=` (1008, `INVALID_UPGRADE`) — and then calls `handleStationSocket`
 * from this module.
 *
 * `runtime` may be `null` when the app is built without a context (the routing-only
 * test builds `buildApp({ ctx: null })`); such a socket is closed with 1011
 * (`INTERNAL_ERROR`) rather than dereferencing a missing runtime.
 */

const log = createChildLogger({ component: 'agency-routes' });

/**
 * How long the attach of a station that cannot take inbound calls waits for what its session held
 * of an inbound call to be let go (`InboundConnector.onStationCannotTakeInbound`) before it reads
 * the agent's state for `ready`. A bound: past it, `ready` goes out with whatever Redis says then.
 */
export const STATION_INBOUND_LET_GO_WAIT_MS = 3_000;

/**
 * The break's code to tell a client beside `state` (`ready.break_reason`, the bootstrap's
 * `break_reason`): the session row's reason when `state` is `break`, else nothing.
 *
 * `row` is the session as it was read for this attach or join, BEFORE the rehydrate that
 * produced `state`. Redis holds no reason, so the row is the only record of it, and every
 * write of a `break` with a reason (`setState(…, 'break', code)`: the break route, the
 * device-away pause, a queued break applied at the end of wrap-up) puts it there. A
 * soft-phone session's only break is `soft_phone`. A row with no reason (a rehydrate
 * after a restart) gives none: the client then shows a plain break.
 */
export function breakReasonFor(
  state: AgencyAgentState,
  row: Pick<AgencyAgentSessionRecord, 'kind' | 'break_reason'>,
): string | undefined {
  if (state !== 'break') return undefined;
  if (row.kind === 'softphone') return SOFTPHONE_BREAK_REASON;
  return row.break_reason ?? undefined;
}

/**
 * The lease a station heartbeat renews for an agent in `live`, or null: renew nothing.
 *
 * The heartbeat IS presence, so it keeps alive the lease of every state whose end is decided by
 * something other than the TTL: `available` and `break` (the agent's own move ends them), and
 * `wrapup`, whose end is an in-process timer, an outcome save or a supervisor (the class note of
 * `WrapupManager`), never the lease. Unrenewed, a write-up longer than its lease left NO key, and
 * the end of that wrap-up met `live: null`: the inbound release hook declined (the agent went
 * `available` instead of straight to a waiting caller), and a `/break` was applied at once instead
 * of queued, then undone by the outcome save (docs/inbound.md §6).
 *
 * `wrapup` is renewed only while something VOUCHES for it, so a lease nobody will ever end (one a
 * previous process left in Redis, found by a reconnect after a restart) still lapses instead of
 * being kept alive by a healthy station:
 *  - `holdsWrapup`: this process's `WrapupManager` holds a campaign wrap-up for the session;
 *  - the lease carries an inbound claim (`inboundCallId`): an answered inbound call owes its
 *    outcome. The claim is cleared by the outcome save or the lapse sweep, which return the agent.
 *
 * Every other state is renewed by its owner (`reserved`, `on_call`: the attempt's or the inbound
 * call's 5 s renewer) or by nothing (`offline`).
 */
export function heartbeatLeaseMs(live: AgentLiveState | null, holdsWrapup: boolean): number | null {
  if (!live) return null;
  if (live.state === 'available') return AGENT_LEASE_MS.available;
  if (live.state === 'break') return AGENT_LEASE_MS.break;
  if (live.state === 'wrapup' && (holdsWrapup || live.inboundCallId !== null)) return AGENT_LEASE_MS.wrapup;
  return null;
}

/**
 * Register `GET /station/:sessionId` (`websocket: true`) on `app`, handing each
 * socket to {@link handleStationSocket}.
 *
 * Not registered by the app; the served path is `/proxy/agency/station/:sessionId`
 * (`proxyAgencyStationRoutes`). The station unit tests mount the handler through it.
 */
export function registerStationSocket(app: FastifyInstance, runtime: AgencyRuntime | null): void {
  // ── Station WebSocket ─────────────────────────────────────────────────────
  // Deliberately registered OUTSIDE the authenticated scope: a WebSocket carries
  // no tenant headers. The session id is unguessable, and the single-use station
  // token on the upgrade (minted over authenticated HTTP) is what authenticates it.
  app.get('/station/:sessionId', { websocket: true }, (socket: WebSocket, request: FastifyRequest<{
    Params: { sessionId: string };
    Querystring: { token?: string; media?: string };
  }>) => {
    if (!runtime) {
      try { socket.close(AGENCY_STATION_CLOSE.INTERNAL_ERROR, 'agency_runtime_unavailable'); } catch { /* ignore */ }
      return;
    }
    // The same refusal as the served path (`proxyAgencyStationRoutes`): 1008 before attach.
    const upgrade = parseStationUpgradeQuery(request.query);
    if (!upgrade.ok) {
      try { socket.close(AGENCY_STATION_CLOSE.INVALID_UPGRADE, upgrade.reason); } catch { /* ignore */ }
      return;
    }
    void handleStationSocket(socket, request.params.sessionId, request.query?.token, runtime, upgrade.query);
  });
}

/**
 * The long-lived station socket. Carries control frames, the heartbeat, and — for
 * the duration of an attempt — media, because the bridge borrows this very socket
 * (the dialer depends on the bridge, never the reverse). The bridge attaches its
 * own listeners per attempt and removes them at
 * detach, so both handler sets coexist without interfering.
 *
 * `upgrade.media` is the agent leg's audio format (the route parsed and validated it). It
 * is recorded on the socket for the bridge, which reads it at every attach of this socket
 * to a call (`core/bridge/browser-leg-media.ts`). `upgrade.client` tunes liveness and is
 * written to the session at attach. `upgrade.caps` decides, with the client kind, whether this
 * socket can take inbound calls (`stationCanTakeInbound`, IQ46): kept on the registry entry, never
 * the session row.
 */
export async function handleStationSocket(
  socket: WebSocket,
  sessionId: string,
  token: string | undefined,
  runtime: AgencyRuntime,
  /** The upgrade's `client=` / `media=` / `caps=`, already parsed (`parseStationUpgradeQuery`). */
  upgrade: StationUpgradeQuery = DEFAULT_STATION_UPGRADE,
): Promise<void> {
  const mediaFormat: AgencyStationMediaFormat = upgrade.media;
  // Before anything can attach this socket to a call, so no attach can read it untagged.
  setBrowserLegMediaFormat(socket, mediaFormat);

  // Verify FIRST, before any DB work — an unauthenticated upgrade must not be
  // able to probe which session ids exist.
  if (!(await runtime.tokens.verifyAndConsume(sessionId, token))) {
    log.warn({ sessionId }, 'Station upgrade with missing/expired/used token — refusing');
    // 4401: re-mint and retry. Distinct from 4404 so the console can tell a
    // recoverable blip from a dead session instead of retrying forever.
    try { socket.close(AGENCY_STATION_CLOSE.TOKEN_REJECTED, 'station_token_invalid'); } catch { /* ignore */ }
    return;
  }

  // ── FRAME HANDLING, REGISTERED BEFORE THE SETUP AWAITS ───────────────────
  //
  // `ws` buffers nothing for a socket with no `message` listener: a frame that
  // arrives while a handler is between awaits is emitted to nobody and is gone.
  // Registered *after* the four awaits below, every frame in that window would be
  // dropped — and the console's first `ping` is exactly such a frame. A dropped
  // one costs the console a missed-ping tick out of the
  // three that put its rail in the "Disconnected" state, on a socket that is in
  // fact perfectly healthy.
  //
  // It is registered here and **not before `verifyAndConsume` above**: running
  // frame handling on an unauthenticated upgrade would let anyone who guessed a
  // session id renew that agent's lease.
  //
  // Registering early is necessary and not sufficient — `heartbeat` answers false
  // until `attach` has run, so an early ping would be received and then dropped
  // for a second reason. Hence `stationLive` and the single `deferredPing` slot,
  // which is deliberately not a queue: the only frame that can arrive here is a
  // `ping` whose one job is to be answered once, so a bounded slot answers it as
  // soon as there is a station to answer for, while an unbounded queue would need
  // its own limit and its own drop policy and would let a client that floods
  // pings pre-attach buy itself N database reads the moment the gate opens.
  // Superseded by a later ping is the right outcome: pongs are liveness, not
  // history.
  let stationLive = false;
  // The frame AND the instant it arrived — see `server_ts` in `handlePing`.
  type DeferredPing = { frame: AgencyStationPingFrame; receivedAt: number };
  let deferredPing: DeferredPing | null = null;
  /**
   * Read the held ping and clear the slot, `takeMissedRelease`-style.
   *
   * A function rather than two statements at the call site, because the only
   * assignment to `deferredPing` is inside the message listener and TypeScript's
   * flow analysis does not follow it — read inline, the slot narrows to `null` and
   * then to `never`, which silently types away everything on it.
   */
  function takeDeferredPing(): DeferredPing | null {
    const held = deferredPing;
    deferredPing = null;
    return held;
  }
  let closeSeen = false;
  /**
   * Media frames in the other format than this socket's (a binary frame on `pcm16`, a JSON
   * `media` frame on `alaw8`). Ignored here — media is the bridge's — and counted, with
   * the first one logged at debug and the total on the close line.
   */
  let ignoredMediaFrames = 0;
  const noteIgnoredMedia = (why: string): void => {
    if (ignoredMediaFrames++ === 0) {
      log.debug({ sessionId, mediaFormat, why }, 'Station socket: ignoring a media frame not in this socket\'s format');
    }
  };

  /**
   * "Is this socket still the one holding this session, and still open?"
   *
   * The setup below is a chain of awaits, and every one of them is a window in
   * which a reconnect can attach a NEW socket for the same session. `closeSeen`
   * alone does not see that: `attach` supersedes the prior socket by closing it,
   * and a close handshake takes a round trip, so for the whole of it this socket
   * is superseded and has not yet been told. A stale run then continued into the
   * side effects below with three distinct consequences, none of them visible in
   * a log:
   *
   *  * `dialer.reattachStation(sessionId, socket)` re-bound a live attempt's
   *    media leg to THIS socket — the one that is closing — which is dead air
   *    mid-call, arriving through the very mechanism that exists to survive a
   *    blip;
   *  * `dialer.takeMissedRelease(sessionId)` consumes a one-shot, so the
   *    replacement's own setup found nothing and the agent was never told how the
   *    call they were on had ended;
   *  * `ready` resolves by session id, so this run's snapshot — its `state`, its
   *    `active_attempt`, its `pending_break` — was delivered to the replacement,
   *    overwriting a fresher one it had just built for itself.
   *
   * Cheap to ask (a Map read and a field) and correct to ask more than once,
   * because what it answers can change at every await.
   */
  const stillOurs = (): boolean =>
    !closeSeen
    && socket.readyState === 1 /* OPEN */
    && runtime.stations.socketFor(sessionId) === socket;

  /**
   * `receivedAt` is when the frame landed, not when we get round to answering, and
   * the difference is the whole point.
   *
   * The console derives its clock offset as `server_ts - (ts + rtt/2)`, where `rtt`
   * is measured entirely client-side. For that to mean anything, `server_ts` has to
   * be our clock at the moment we saw the ping — roughly `ts + rtt/2` — so stamping
   * it at send time inflates the offset by however long we took to answer.
   *
   * On the live path that is one primary-key read plus a Redis read. On the DEFERRED
   * path it is the entire station setup: the console now sends a ping the instant the
   * socket opens, and this answer is held until `attach`, `claimOwnership`,
   * `rehydrateAgent` and `ready` are done — so `Date.now()` here over-estimated the
   * offset by about half that. The console's estimator is a median over a five-sample
   * window and this is its only sample for the first ~50s, which is exactly the
   * window in which a wrap-up deadline is rendered as a countdown against a one
   * second tolerance.
   *
   * Stamping the arrival is also the answer that stays right if the work below ever
   * gets slower, which excluding the deferred replay from sampling would not.
   */
  function handlePing(frame: AgencyStationPingFrame, receivedAt: number): void {
    // Scoped to THIS socket: a superseded socket that is still pinging must not
    // renew its replacement's liveness, nor have its pong delivered to it.
    void runtime.stations.heartbeat(sessionId, socket).then(async (ok) => {
      if (!ok) return;

      // ── A LEFT SESSION MUST STOP RENEWING ────────────────────────────────
      //
      // `left_at` is checked at upgrade, and without this recheck a session that
      // left while its console tab stayed open would go on renewing both the
      // station ownership key and the agent lease forever, because neither
      // renewal consults the row. Two things break
      // downstream, both silently:
      //
      //  * `AgencyReaper.isAgentHeldSomewhere` reads that ownership key and
      //    skips any attempt pointing at the session — so attempts on a closed
      //    session are never reaped and their contacts sit `in_flight` past the
      //    leak threshold, which is the exact harm the reaper exists to fix;
      //  * the agent is dialable-looking and undialable: the lease says
      //    `available`, while `findLiveForCampaign` — what the pacing tick reads
      //    — excludes left rows. A ready console that never rings.
      //
      // Not rare: besides a deliberate leave with the tab open, the session dedupe
      // closes sessions out from under whoever is holding them. So the recheck goes
      // on the ping: it is the one
      // event that both proves the tab is still there and is about to do the
      // renewing. One primary-key read per agent per 10s buys the invariant.
      //
      // 4404 is the console's existing "dead session, do not retry" close code,
      // the same one the upgrade path uses for a session that had already left.
      const current = await agencyAgentSessionRepository.findById(sessionId)
        .catch((err) => {
          // A failed read must not evict a live agent — presence is the
          // heartbeat, and a database blip is not an absence.
          log.warn({ err, sessionId }, 'Could not confirm session liveness on ping — keeping the station');
          return undefined;
        });
      if (current === null || current?.left_at) {
        log.info({ sessionId }, 'Station socket ping on a session that has left — closing');
        try { socket.close(AGENCY_STATION_CLOSE.SESSION_GONE, 'session_not_found'); } catch { /* ignore */ }
        return;
      }

      // The heartbeat is what renews a present agent's lease — it IS presence: an idle agent's,
      // and a wrap-up this process vouches for (`heartbeatLeaseMs`). `renew` is state-matched,
      // so a move between this read and the write is never extended.
      const live = await runtime.agents.get(sessionId);
      const leaseMs = heartbeatLeaseMs(live, runtime.wrapup.stateFor(sessionId) !== null);
      if (live && leaseMs !== null) {
        await runtime.agents.renew(sessionId, live.state, leaseMs);
      }
      // Scoped to this socket, and not merely for tidiness: `heartbeat` proved we
      // were the incumbent, then we awaited a row read and up to two Redis calls.
      // A supersede inside that window would deliver this pong — echoing a `ts`
      // the replacement never sent — to the replacement, which reads any pong as
      // proof its own round trip succeeded. See `send`'s `expectedWs`.
      runtime.stations.send(sessionId, { event: 'pong', ts: frame.ts, server_ts: receivedAt }, socket);
    });
  }

  socket.on('message', (data: Buffer | string, isBinary?: boolean) => {
    // Binary frames are `alaw8` audio, the bridge's to relay — never parsed here. Routed
    // on `isBinary` rather than a failed `JSON.parse`, which would throw per audio frame
    // (50/s) and could, by chance, parse.
    if (isBinary === true) {
      if (mediaFormat !== 'alaw8') noteIgnoredMedia('binary frame on a pcm16 socket');
      return;
    }
    // Taken before the parse, so a ping's `server_ts` is the arrival instant and
    // owes nothing to how long anything downstream takes.
    const receivedAt = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      return; // malformed text — ignored like any other non-frame
    }
    // ── A PARSE THAT SUCCEEDS IS NOT YET A FRAME ─────────────────────────
    //
    // `JSON.parse('null')` succeeds, and reading `.event` off its result threw
    // a TypeError out of this `ws` listener. There is no global
    // `uncaughtException` handler, so one four-byte text frame from any
    // authenticated console crashed the whole server — every station and every
    // live call on it — and wedged that socket's receiver on the way. Anything
    // that is not a JSON object is ignored, like any other non-frame.
    if (parsed === null || typeof parsed !== 'object') return;
    const frame = parsed as AgencyStationClientFrame;
    if (frame.event === 'ping') {
      // Held, not dropped, until the station is attached and `ready` is out. The
      // arrival instant is held with it — that is what the answer is stamped with.
      if (!stationLive) { deferredPing = { frame, receivedAt }; return; }
      handlePing(frame, receivedAt);
    }
    // `media` is consumed by the bridge's borrowed-socket listener, not here — on a
    // `pcm16` socket. On `alaw8` it is not this socket's format, and the bridge drops it.
    else if (frame.event === 'media' && mediaFormat !== 'pcm16') noteIgnoredMedia('json media frame on an alaw8 socket');
    //
    // Nothing else is read. A `hangup` frame is handled neither here nor by the
    // bridge's listener: the agent's hang-up is `POST /agency/attempts/:id/hangup`,
    // and the frame is withdrawn.
  });

  // ── THE CLOSE HANDLER IS REGISTERED HERE TOO, AND FOR THE SAME REASON ─────
  //
  // `ws` buffers nothing for an event with no listener, and `close` is emitted
  // exactly once. This was registered *below* every setup await, so a close that
  // landed between `attach` and that registration was emitted to nobody and
  // discarded — and `detach` is the only caller of the registry's `delete`, so
  // the entry became permanent. That is the whole harm the sweep exists to fix,
  // in the one shape the sweep could not reach: `isLocallyOwned` answered true
  // forever, so `POST /sessions/:id/available` kept succeeding and the pacing
  // engine kept the session as a dial candidate; `releaseStationOnClose` never
  // ran; and because `stations.size()` never returned to zero the sweep could
  // never go dormant on that replica either.
  //
  // Registered after `verifyAndConsume` and **not before it**, exactly as the
  // message listener is: releasing presence on an unauthenticated close would let
  // anyone who guessed a session id write that agent offline.
  //
  // The earlier registration is safe because the release below already asks WHICH
  // socket is attached rather than whether one is, so both new cases it exposes —
  // a socket that closes before it ever attached — answer correctly without a
  // second guard:
  //
  //  * a PREVIOUS healthy socket is still attached. `detach` no-ops (the entry is
  //    not ours), `socketFor` returns that previous socket, `superseded` is true
  //    and the release is suppressed. Correct: the agent has a working station.
  //  * there is no previous socket. `detach` no-ops (no entry), `socketFor`
  //    returns undefined, and the release runs — which is right, because presence
  //    IS the station and this session now has none. It is also exactly what a
  //    socket that attached and closed a millisecond later already did.
  //
  // Registering early makes the event ARRIVE; on its own it does not stop an
  // `attach` that runs afterwards from installing an entry the (already-run) close
  // handler will never be asked to remove. That is the same permanent leak by a
  // second route, and it is closed at the attach itself — see the guard there.
  // `AgencyRuntime.sweepSilentStations` detaches a CLOSED entry as the backstop for
  // anything that still slips through, and logs at warn if it ever has to.

  socket.on('close', () => {
    // Set synchronously, and read below: it means "the close event has already
    // been emitted and will not be emitted again", which is precisely the
    // condition under which an `attach` running afterwards would be permanent.
    closeSeen = true;
    void (async () => {
      // ── The pre-bind grace is armed BEFORE anything is awaited ─────────────
      //
      // Synchronous and first, because everything below this line can block: the
      // very next statement awaits `detach`, which awaits `redis.del`. On a slow
      // or unavailable Redis an unbound dial would otherwise sit with no socket
      // and no timer for an unbounded interval, answer, and become the abandoned
      // call the grace exists to prevent — the failure reintroduced by its own fix.
      //
      // A no-op for every announced attempt, and it does not re-arm, so the second
      // observer of the same loss (`sweepSilentStations`, the only thing that sees
      // a socket which died without a close frame) cannot slide the deadline
      // forward. `releaseStationOnClose` calls it too; whichever arrives first
      // wins and the other returns.
      runtime.dialer.noteStationClosed(sessionId);
      // Order matters: detach FIRST, so anything that asks "is this agent here?"
      // between here and the end of this handler gets the truthful answer.
      await runtime.stations.detach(sessionId, socket);

      // ── A SUPERSEDED SOCKET MUST NOT RELEASE THE ONE THAT REPLACED IT ─────
      //
      // `attach` supersedes a prior socket for the same session, and `detach` is
      // already guarded against evicting the replacement — so for a superseded
      // socket the line above correctly did nothing. The release below ran anyway,
      // and it is unconditional apart from `hasLiveAttempt`: it wrote the agent
      // `offline` in Redis **while the replacement socket was attached** and had
      // already reported `available` on its own `ready` frame. Nothing corrected
      // that afterwards, because the station heartbeat only ever renews an
      // existing `available`/`break` lease — it never restores one. The agent then
      // sat out of the dialable pool for the rest of their shift, on a console
      // that looked entirely healthy.
      //
      // The question is asked by comparing the ATTACHED socket rather than merely
      // asking whether one is attached, so the answer does not depend on `detach`
      // having run first — and so it also covers the other shape of the same
      // hazard: a genuine reconnect that attached inside this handler's own await
      // window. Either way, "some other socket is holding this session" is the
      // whole condition, and a socket that is not holding a session has no
      // business deciding the agent is gone.
      // This read and the write inside `releaseStationOnClose` are ONE synchronous
      // run (see that method) — so this check is not racing it. `socket` is
      // handed down anyway so the
      // same question can be re-asked at the write itself, which is what keeps
      // that property from being silently undone by a later `await`; a
      // `wentOffline === false` alongside `superseded === false` is how that
      // second refusal would read here.
      const replacement = runtime.stations.socketFor(sessionId);
      const superseded = replacement !== undefined && replacement !== socket;
      // Presence is the heartbeat — but a drop mid-attempt is the deferred
      // hangup's to resolve, not ours. `false` means it kept the agent.
      const wentOffline = superseded
        ? false
        : await runtime.releaseStationOnClose(sessionId, socket);
      log.info({ sessionId, superseded, wentOffline, mediaFormat, ignoredMediaFrames }, 'Station socket closed');
    })();
  });

  // Moved up with `close` for the same reason: an `error` emitted while the setup
  // awaits were in flight reached no listener, so the one class of failure most
  // worth having a log line for was the one class that produced none.
  socket.on('error', (err) => log.warn({ err, sessionId }, 'Station socket error'));

  // The session read, which also records which app is attaching (`client_kind`, written
  // only when it changes): every attach states its client, and a "continue on this
  // phone" attaches the same session from another device. One round trip, as the plain
  // read was.
  const session = await agencyAgentSessionRepository.readForStationAttach(sessionId, upgrade.client);
  if (!session || session.left_at) {
    try { socket.close(AGENCY_STATION_CLOSE.SESSION_GONE, 'session_not_found'); } catch { /* ignore */ }
    return;
  }

  // ── DO NOT ATTACH A SOCKET THAT HAS ALREADY CLOSED ───────────────────────
  //
  // Registering the close handler early makes the event *arrive*; it does not stop
  // an `attach` that runs after it. A close inside the session read leaves the
  // handler already run — `close` is emitted once — so the entry this would create
  // has nothing left to remove it, which is the same permanent leak by a second
  // route. Bailing here also stops a dead socket SUPERSEDING a healthy prior one
  // for the same session, which `attach` would otherwise do on its way in.
  //
  // `readyState` is tested as well as the flag, and it is the half that covers the
  // window the flag cannot: a close landing during `verifyAndConsume` itself, when
  // there was no listener to set the flag. Between this line and `attach`'s own
  // `stations.set` there is nothing to await, so the pair leaves no gap — which is
  // what makes the sweep's CLOSED arm a backstop rather than the recovery path.
  if (closeSeen || socket.readyState !== 1 /* OPEN */) {
    log.info({ sessionId, readyState: socket.readyState },
      'Station socket closed during setup — not attaching');
    return;
  }

  // This socket's own answer, never the session's (IQ46): a console always, a phone only with
  // `caps=inbound`. Decides whether it is sent the inbound frames and offered inbound callers, and
  // whether what the session held of an inbound call is let go below.
  const canTakeInbound = stationCanTakeInbound(upgrade);
  await runtime.stations.attach({
    sessionId,
    campaignId: session.campaign_id,
    tenantId: session.tenant_id,
    accountId: session.account_id,
    agentUserId: session.agent_user_id,
    ws: socket,
    // Picks the heartbeat grace and, for `mobile`, arms the protocol-ping probe.
    clientKind: upgrade.client,
    canTakeInbound,
  });

  // And the same question again, because `attach` has its own await (the ownership
  // key) and a close can land inside it. `detach` is identity-scoped, so this
  // removes only our own entry and never a replacement's; it is idempotent with the
  // close handler's own detach. Presence is deliberately not touched — the close
  // handler already decided that, on the truthful answer to "who is attached".
  if (!stillOurs()) {
    log.info({ sessionId, readyState: socket.readyState },
      'Station socket closed or superseded while attaching — detaching it');
    // Identity-scoped, so this removes only our own entry and never a
    // replacement's; idempotent with the close handler's own detach. Presence is
    // deliberately not touched — the close handler decides that, on the truthful
    // answer to "who is attached".
    await runtime.stations.detach(sessionId, socket);
    return;
  }
  // Arms the sweep that enforces `heartbeat_grace_ms`. Demand-driven: the sweep is
  // dormant while this replica holds no stations, and an attach is the only event
  // that can create something for it to watch.
  runtime.wakeStationSweep();

  // ── A station that cannot take inbound calls (IQ46) ───────────────────────
  // An older app build (no `caps=inbound`) taking over a session that holds an inbound offer, or
  // is held for one through a caller's preamble: let go as a lost station's, the agent returned to
  // the pool, BEFORE the rehydrate below reads the state `ready` reports. The connector also waits
  // for every return of the session it had in flight (a reservation on its way to an offer or a
  // give-back, the bind's own cancel), so that build's `ready` is not `reserved` for a call it
  // cannot show (`onStationCannotTakeInbound` says exactly what is covered). Bounded: a step stuck
  // on the call's chain delays nobody's `ready` past {@link STATION_INBOUND_LET_GO_WAIT_MS}; past
  // it `ready` says what Redis says, and the return's own `agent_state` frame follows. A bound call
  // is not re-adopted (below) and stays `on_call` until the bridge's deferred hangup ends it.
  const inbound = runtime.inbound;
  if (inbound && !canTakeInbound) {
    await withTimeoutOr(inbound.onStationCannotTakeInbound(sessionId), STATION_INBOUND_LET_GO_WAIT_MS, undefined);
  }

  // Contact assignment (CA3): the agent's own queue on a `strict` / `preferred` campaign, so a
  // reconnect shows "nothing due, and why" at once (pacing's `queue` frame is sent only on a
  // change, so a reconnecting station cannot wait for one). Read here, before the fence
  // below, so no await sits between the fence and the side effects. Best effort: a failed
  // read omits the field and the station keeps the reconnect. The mode comes with the
  // session read, so a `pool` campaign (no per-agent queue) costs no campaign read.
  const campaignId = session.campaign_id;
  const ownerMode = ownerModeOf({ assignment_mode: session.campaign_assignment_mode ?? 'pool' });
  const queueRead = campaignId && ownerMode
    ? Promise.resolve()
      .then(() => agencyCampaignRepository.findById(campaignId))
      .then((campaign) => (campaign ? readAgentQueueState(campaign, session.agent_user_id) : undefined))
      .catch((err: unknown) => {
        log.warn({ err, sessionId }, 'Could not read the agent queue for ready');
        return undefined;
      })
    : undefined;

  // Redis, or `break` — never the DB row. The rule and
  // the reason live on the runtime; this is transport. Together with the queue read, which
  // never rejects, so a rehydrate failure surfaces exactly as before.
  const [resumedState, queue] = await Promise.all([runtime.rehydrateAgent(sessionId, session), queueRead]);

  // Re-adopt a call the previous socket dropped out of, if the window has not
  // lapsed. This is what makes a wifi blip survivable: the bridge disarms its
  // deferred hangup and media resumes onto this socket.
  // Asked again, and this is the placement that matters: `rehydrateAgent` above
  // is the last await before the side effects, and everything below it either
  // mutates shared session state or consumes a one-shot. A stale run that gets
  // this far does no work at all rather than half of it.
  if (!stillOurs()) {
    log.info({ sessionId, readyState: socket.readyState },
      'Station socket closed or superseded during setup — abandoning this run');
    await runtime.stations.detach(sessionId, socket);
    return;
  }

  const activeAttempt = runtime.dialer.reattachStation(sessionId, socket);
  // A reconnecting agent may be mid-wrap-up: the countdown is an in-process timer
  // on this replica, so it survived the socket drop and the console needs the
  // absolute deadline to resume it. `undefined` when there is none.
  const activeWrapup = runtime.wrapup.stateFor(sessionId);
  // Consumed exactly once — read it here, not inline in the frame, because
  // `takeMissedRelease` clears as it reads and a second call would return null.
  const missedRelease = activeAttempt ? null : runtime.dialer.takeMissedRelease(sessionId);
  // PEEKED. A queued break is announced only by the HTTP response that queued it
  // and the `agent_state` frame beside it, both of which died with the old socket —
  // and the next `agent_state` this agent gets is the one `releaseAgent` sends when
  // it has already APPLIED the break. So without this a reconnecting agent is put
  // on break by a request their console no longer knows about. `take` here would
  // consume it and drop it, since it applies exactly once.
  const pendingBreak = runtime.breaks.peek(sessionId);
  // Deliberately NOT re-emitting `bridged` for a resumed attempt — the console's
  // `bridged` handler plays the audible connect cue, and a page reload starts with
  // an empty dedupe set, so it would fire mid-conversation. `active_attempt`
  // carries `bridged_at`, which is the authority for a resumed panel.
  // The break's code beside the state, so a client that lost the `agent_state` frame
  // naming it (the mobile app relaunched after the OS killed it while paused) can say why.
  const breakReason = breakReasonFor(resumedState, session);
  const readySent = runtime.stations.send(sessionId, {
    event: 'ready',
    session_id: sessionId,
    state: resumedState,
    ...(breakReason ? { break_reason: breakReason } : {}),
    ...(activeAttempt ? { active_attempt: activeAttempt } : {}),
    ...(activeWrapup ? { active_wrapup: activeWrapup } : {}),
    ...(queue ? { queue } : {}),
    // Only meaningful when nothing was resumed: an attempt that ended while the
    // socket was away, so the agent is told what happened to the call they were on
    // rather than finding an empty console.
    ...(missedRelease ? { missed_release: missedRelease } : {}),
    // Not conditional on `activeWrapup`: a break can also be queued from `reserved`
    // or `on_call`, and those reconnects land here with `active_attempt` instead.
    ...(pendingBreak
      ? { pending_state: 'break' as const, pending_break_reason: pendingBreak.code }
      : {}),
    // The fence above narrows the window; this closes it. `ready` carries this
    // run's whole view of the session, so delivering it to a socket that built
    // its own is strictly worse than delivering it to nobody — the replacement
    // has already sent, or is about to send, a `ready` of its own.
  }, socket);
  // Contact assignment (CA3): the station's queue is now this frame's (or none, when the read
  // failed), whatever `queue` frame pacing sent it before, including one sent while this run
  // was reading. Told to the pacing leader, which forgets what it last sent this session and
  // sends the agent's queue again on its next tick. After the send, never before it.
  if (readySent && campaignId && ownerMode) {
    publishPacingInvalidation({ type: 'station_ready', sessionId, campaignId });
  }

  // The gate the message listener above waits on. Opened after `ready` rather
  // than immediately after `attach`, so a ping can never interleave with the
  // rehydrate/re-adopt sequence, and any frame that arrived during it is answered
  // now instead of having been thrown away.
  stationLive = true;
  const held = takeDeferredPing();
  if (held) handlePing(held.frame, held.receivedAt);

  // ── The soft phone (docs/softphone.md §4.1 step 9) ───────────────────────
  // Re-adopt a live manual call's browser leg onto this socket (the bridge
  // disarms its deferred hangup and media resumes), and restore the session's
  // unsettled call — live, or awaiting its outcome — with a `manual_call` frame
  // right after `ready` (the ready frame has no field for it), so a reloaded
  // console comes back to the call. Scoped to this socket, like `ready`.
  if (!stillOurs()) return;
  const manualCall = await runtime.softphone.reattachStation(sessionId, socket).catch((err) => {
    log.warn({ err, sessionId }, 'Could not restore the soft-phone call on reconnect');
    return null;
  });
  if (manualCall && stillOurs()) {
    runtime.stations.send(sessionId, { event: 'manual_call', call: manualCall }, socket);
  }

  // ── Inbound calls (docs/inbound.md §2, P2) ───────────────────────────────
  // The same for an inbound call: re-adopt a bound call's leg onto this socket, restore the
  // session's unsettled inbound call (connected, or owing its outcome) with an `inbound_call` frame,
  // and re-send "Your customer is waiting" for every caller still waiting for this agent. Only on
  // a station that can take inbound calls (a console, or a phone that declared `caps=inbound`:
  // IQ46). One that cannot (an older app build taking the session over) had what the session held
  // let go before `ready` (above): an offer back to the queue, a bound call not re-adopted.
  if (!inbound || !canTakeInbound || !stillOurs()) return;
  const restored = await inbound.reattachStation(sessionId, socket).catch((err: unknown) => {
    log.warn({ err, sessionId }, 'Could not restore the inbound call on reconnect');
    return null;
  });
  if (!restored || !stillOurs()) return;
  if (restored.call) runtime.stations.send(sessionId, { event: 'inbound_call', call: restored.call }, socket);
  for (const frame of restored.waiting) runtime.stations.send(sessionId, frame, socket);
}
