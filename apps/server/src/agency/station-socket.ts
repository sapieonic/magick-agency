import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
import { agencyAgentSessionRepository } from '../db/repositories/agency.repository.js';
import type { AgencyRuntime } from './runtime.js';
import { AGENT_LEASE_MS } from './agent-state-machine.js';
import type {
  AgencyStationClientFrame,
  AgencyStationPingFrame,
} from '@magick-agency/contracts/agency';

/**
 * The agent's station WebSocket: {@link handleStationSocket}, in this runtime-owned
 * module (decision B16).
 *
 * The console's station socket is served at `/proxy/agency/station/:sessionId` by
 * `proxyAgencyStationRoutes` (`api/routes/proxy-agency-station.routes.ts`), which makes
 * its two refusals — a tokenless upgrade (4401) and a path-escaping session id (1008)
 * — and then calls `handleStationSocket` from this module.
 *
 * `runtime` may be `null` when the app is built without a context (the routing-only
 * test builds `buildApp({ ctx: null })`); such a socket is closed with 1011 rather
 * than dereferencing a missing runtime.
 */

const log = createChildLogger({ component: 'agency-routes' });

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
    Querystring: { token?: string };
  }>) => {
    if (!runtime) {
      try { socket.close(1011, 'agency_runtime_unavailable'); } catch { /* ignore */ }
      return;
    }
    void handleStationSocket(socket, request.params.sessionId, request.query?.token, runtime);
  });
}

/**
 * The long-lived station socket. Carries control frames, the heartbeat, and — for
 * the duration of an attempt — media, because the bridge borrows this very socket
 * (the dialer depends on the bridge, never the reverse). The bridge attaches its
 * own listeners per attempt and removes them at
 * detach, so both handler sets coexist without interfering.
 */
export async function handleStationSocket(
  socket: WebSocket,
  sessionId: string,
  token: string | undefined,
  runtime: AgencyRuntime,
): Promise<void> {
  // Verify FIRST, before any DB work — an unauthenticated upgrade must not be
  // able to probe which session ids exist.
  if (!(await runtime.tokens.verifyAndConsume(sessionId, token))) {
    log.warn({ sessionId }, 'Station upgrade with missing/expired/used token — refusing');
    // 4401: re-mint and retry. Distinct from 4404 so the console can tell a
    // recoverable blip from a dead session instead of retrying forever.
    try { socket.close(4401, 'station_token_invalid'); } catch { /* ignore */ }
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
        try { socket.close(4404, 'session_not_found'); } catch { /* ignore */ }
        return;
      }

      // The heartbeat is what renews an idle agent's lease — it IS presence.
      const live = await runtime.agents.get(sessionId);
      if (live && (live.state === 'available' || live.state === 'break')) {
        await runtime.agents.renew(sessionId, live.state, AGENT_LEASE_MS.available);
      }
      // Scoped to this socket, and not merely for tidiness: `heartbeat` proved we
      // were the incumbent, then we awaited a row read and up to two Redis calls.
      // A supersede inside that window would deliver this pong — echoing a `ts`
      // the replacement never sent — to the replacement, which reads any pong as
      // proof its own round trip succeeded. See `send`'s `expectedWs`.
      runtime.stations.send(sessionId, { event: 'pong', ts: frame.ts, server_ts: receivedAt }, socket);
    });
  }

  socket.on('message', (data: Buffer | string) => {
    // Taken before the parse, so a ping's `server_ts` is the arrival instant and
    // owes nothing to how long anything downstream takes.
    const receivedAt = Date.now();
    let frame: AgencyStationClientFrame;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      return; // media/binary or malformed — the bridge's own listener handles media
    }
    if (frame.event === 'ping') {
      // Held, not dropped, until the station is attached and `ready` is out. The
      // arrival instant is held with it — that is what the answer is stamped with.
      if (!stationLive) { deferredPing = { frame, receivedAt }; return; }
      handlePing(frame, receivedAt);
    }
    // `media` is consumed by the bridge's borrowed-socket listener, not here.
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
      log.info({ sessionId, superseded, wentOffline }, 'Station socket closed');
    })();
  });

  // Moved up with `close` for the same reason: an `error` emitted while the setup
  // awaits were in flight reached no listener, so the one class of failure most
  // worth having a log line for was the one class that produced none.
  socket.on('error', (err) => log.warn({ err, sessionId }, 'Station socket error'));

  const session = await agencyAgentSessionRepository.findById(sessionId);
  if (!session || session.left_at) {
    try { socket.close(4404, 'session_not_found'); } catch { /* ignore */ }
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

  await runtime.stations.attach({
    sessionId,
    campaignId: session.campaign_id,
    tenantId: session.tenant_id,
    accountId: session.account_id,
    agentUserId: session.agent_user_id,
    ws: socket,
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

  // Redis, or `break` — never the DB row. The rule and
  // the reason live on the runtime; this is transport.
  const resumedState = await runtime.rehydrateAgent(sessionId);

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
  runtime.stations.send(sessionId, {
    event: 'ready',
    session_id: sessionId,
    state: resumedState,
    ...(activeAttempt ? { active_attempt: activeAttempt } : {}),
    ...(activeWrapup ? { active_wrapup: activeWrapup } : {}),
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

  // The gate the message listener above waits on. Opened after `ready` rather
  // than immediately after `attach`, so a ping can never interleave with the
  // rehydrate/re-adopt sequence, and any frame that arrived during it is answered
  // now instead of having been thrown away.
  stationLive = true;
  const held = takeDeferredPing();
  if (held) handlePing(held.frame, held.receivedAt);
}
