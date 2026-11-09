import type Redis from 'ioredis';
import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
import {
  AGENCY_STATION_CLOSE,
  AGENCY_STATION_CONSOLE_ONLY_EVENTS,
  type AgencyClientKind,
  type AgencyStationServerFrame,
} from '@magick-agency/contracts/agency';
import { MOBILE_STATION_PROBE_MS, stationHeartbeatGraceMs } from '@magick-agency/domain/timers';
import { trackWebsocketSendBackpressure } from '@magick-agency/observability/metrics/voice';
import { closeForSendBacklog, sendVerdict, STATION_PCM16_LIMITS } from '../utils/ws-backpressure.js';

const log = createChildLogger({ component: 'agency-station-registry' });

/** Ownership key TTL. Renewed by the station socket's own heartbeat. */
const OWNERSHIP_TTL_MS = 30_000;

interface StationEntry {
  sessionId: string;
  /**
   * NULL for a soft-phone session (docs/softphone.md), which dials on its station
   * socket like a campaign session but belongs to no campaign. Never equal to a
   * campaign id, so `broadcast` / `sessionIdsForCampaign` cannot reach it.
   */
  campaignId: string | null;
  tenantId: string;
  accountId: string;
  agentUserId: string;
  ws: WebSocket;
  /**
   * Which app attached (`client=` on the upgrade). Picks the heartbeat grace the sweep
   * holds this station to ({@link stationGraceFor}) and whether it is probed with
   * protocol pings (`mobile`).
   */
  clientKind: AgencyClientKind;
  /**
   * Last sign of life: attach, every client `ping`, and — for a `mobile` station only —
   * every protocol pong or ping. Liveness is derived from this.
   */
  lastSeen: number;
}

/** What `attach` takes: the entry, with the client kind defaulting to `web`. */
export type StationAttachInput = Omit<StationEntry, 'lastSeen' | 'clientKind'> & { clientKind?: AgencyClientKind };

/** The heartbeat grace this station is held to: `heartbeat_grace_ms` for its client kind. */
export function stationGraceFor(entry: Pick<StationEntry, 'clientKind'>): number {
  return stationHeartbeatGraceMs(entry.clientKind);
}

/**
 * Agent presence and replica ownership.
 *
 * **The agent's station socket is the anchor of ownership.** Whatever replica
 * accepts the socket owns that agent, writes `agency:station:{sessionId}` with a
 * 30s TTL, and renews it from the socket's own heartbeat. Socket closes or
 * heartbeat lapses ⇒ key expires ⇒ the agent is no longer available anywhere.
 *
 * The server is single-replica in v1, so the ownership key currently always
 * resolves to us. It is written and read anyway, from day one, so the invariant
 * "dial only on the owning replica" is exercised continuously rather than being
 * dead code that rots until someone needs it — which is the whole reason the
 * multi-replica change later is one `DialDispatcher` implementation rather than a
 * rewrite of the dial path.
 */
export class StationRegistry {
  private readonly stations = new Map<string, StationEntry>();
  /** A mobile station's protocol-ping probe, by session: its stop function. See {@link startProbe}. */
  private readonly probes = new Map<string, () => void>();

  constructor(
    private readonly redis: Redis | null,
    private readonly keyPrefix: string,
    /** This process's identity. Stable for the life of the replica. */
    readonly replicaId: string,
  ) {}

  private ownershipKey(sessionId: string): string {
    return `${this.keyPrefix}agency:station:${sessionId}`;
  }

  private readonly attachListeners = new Set<(entry: { sessionId: string; campaignId: string | null }) => void>();

  /**
   * Be told after every attach. An agent whose `available` lease outlived a dropped
   * socket becomes dialable again on reconnect with no state write at all (the
   * rehydrate reads the live lease), so the attach itself is the pacing engine's
   * wake-up for it (wired by the runtime). Total: a throwing listener is logged.
   */
  onAttached(listener: (entry: { sessionId: string; campaignId: string | null }) => void): () => void {
    this.attachListeners.add(listener);
    return () => { this.attachListeners.delete(listener); };
  }

  private readonly detachListeners = new Set<(sessionId: string) => void>();

  /** Be told after every detach (a media worker tells the primary's directory). Total. */
  onDetached(listener: (sessionId: string) => void): () => void {
    this.detachListeners.add(listener);
    return () => { this.detachListeners.delete(listener); };
  }

  /** Register a newly-opened station socket and claim ownership of the agent. */
  async attach(input: StationAttachInput): Promise<void> {
    const entry: Omit<StationEntry, 'lastSeen'> = { ...input, clientKind: input.clientKind ?? 'web' };
    // Supersede any prior socket for this session (a reconnect that raced the old
    // socket's close). The prior socket is closed so it cannot go on relaying.
    //
    // ── 4409, AND A LOG LINE ─────────────────────────────────────────────────
    //
    // A bare `close()` inside a swallowing `try` would be two silences in one
    // line. A close frame with no code makes the peer report 1005/1006 — the
    // RFC 6455 "no status received" sentinels — so a supersede would be
    // indistinguishable from a network drop **to the console and to anyone
    // reading the logs**, where it would not appear at all. `4409` is declared
    // in `AgencyStationCloseCode` for exactly this.
    //
    // ⚠️ The console's 4409 handler is terminal — it sets
    // `connection: 'superseded'`, does not retry, and releases the microphone.
    // Send it only for a socket a newer one for the same session has replaced.
    const prior = this.stations.get(entry.sessionId);
    if (prior && prior.ws !== entry.ws) {
      log.info({ sessionId: entry.sessionId, campaignId: entry.campaignId },
        'Superseding prior station socket for this session');
      try { prior.ws.close(AGENCY_STATION_CLOSE.SUPERSEDED, 'superseded'); } catch { /* already gone */ }
    }
    // Whatever probed the prior entry stops with it: a probe belongs to one socket, and a
    // superseded socket's pongs must not keep its replacement alive.
    this.stopProbe(entry.sessionId);
    this.stations.set(entry.sessionId, { ...entry, lastSeen: Date.now() });
    if (entry.clientKind === 'mobile') this.startProbe(entry.sessionId, entry.ws);
    await this.claimOwnership(entry.sessionId);
    log.info({ sessionId: entry.sessionId, campaignId: entry.campaignId, clientKind: entry.clientKind },
      'Station socket attached');
    for (const listener of this.attachListeners) {
      try {
        listener({ sessionId: entry.sessionId, campaignId: entry.campaignId });
      } catch (err) {
        log.warn({ err, sessionId: entry.sessionId }, 'Station attach listener threw');
      }
    }
  }

  /**
   * ── THE MOBILE LIVENESS PROBE ──────────────────────────────────────────────
   *
   * A mobile station is sent an RFC 6455 ping every `MOBILE_STATION_PROBE_MS` (3s),
   * and every protocol PONG renews its `lastSeen`, as does every protocol PING the app
   * sends of its own (it pings at the same cadence). That is what lets the sweep hold
   * a phone to `MOBILE_STATION_HEARTBEAT_GRACE_MS` (10s) without closing a healthy one:
   * the app-level `ping` comes only every 10s, while a protocol frame is answered by
   * the client's WebSocket stack, not its app code, so it stops exactly when the
   * transport does or the OS suspends the app.
   *
   * **In memory only.** A renewal writes `lastSeen` and nothing else: no Postgres, no
   * Redis. The ownership key and the agent lease are still renewed by the app-level
   * `ping` alone (`heartbeat`, every 10s), exactly as on the web; the probe makes a
   * dead phone visible sooner, it never keeps a lease alive.
   *
   * **Socket-scoped**, like `heartbeat` and `detach`: a renewal lands only while this
   * socket is still the session's entry, so a superseded socket's late pong cannot
   * keep its replacement alive. The timer and the three listeners are removed on
   * whichever comes first: `detach` of this socket, a supersede (`attach` stops the
   * prior probe), or the socket's own `close`. The timer is `unref`'d, so a probe can
   * never hold the process open.
   */
  private startProbe(sessionId: string, ws: WebSocket): void {
    // A socket already closing will emit no `close` for the stop below to hear.
    if (ws.readyState !== 1 /* OPEN */) return;
    const alive = (): void => {
      const entry = this.stations.get(sessionId);
      if (entry && entry.ws === ws) entry.lastSeen = Date.now();
    };
    const timer = setInterval(() => {
      if (ws.readyState !== 1 /* OPEN */) return;
      try { ws.ping(); } catch { /* closing under us; the close stops the probe */ }
    }, MOBILE_STATION_PROBE_MS);
    timer.unref?.();
    const stop = (): void => {
      clearInterval(timer);
      ws.off('pong', alive);
      ws.off('ping', alive);
      ws.off('close', stop);
      if (this.probes.get(sessionId) === stop) this.probes.delete(sessionId);
    };
    ws.on('pong', alive);
    ws.on('ping', alive);
    ws.on('close', stop);
    this.probes.set(sessionId, stop);
  }

  private stopProbe(sessionId: string): void {
    this.probes.get(sessionId)?.();
  }

  /** How many probes are armed: zero once every mobile station is gone (no timer leaks). */
  probeCount(): number {
    return this.probes.size;
  }

  /** Release the socket and the ownership key. Idempotent. */
  async detach(sessionId: string, ws?: WebSocket): Promise<void> {
    const entry = this.stations.get(sessionId);
    // A superseded socket closing must not evict the socket that replaced it.
    if (!entry || (ws && entry.ws !== ws)) return;
    this.stations.delete(sessionId);
    this.stopProbe(sessionId);
    for (const listener of this.detachListeners) {
      try { listener(sessionId); } catch (err) { log.warn({ err, sessionId }, 'Station detach listener threw'); }
    }
    if (this.redis) {
      await this.redis.del(this.ownershipKey(sessionId)).catch((err) =>
        log.warn({ err, sessionId }, 'Failed to clear station ownership key'));
    }
    log.info({ sessionId }, 'Station socket detached');
  }

  /**
   * Heartbeat: renew ownership and record liveness. Called on every client `ping`.
   * Returns false when the session is not attached here, or when `ws` is given and
   * is not the socket currently holding it.
   *
   * ── SOCKET-SCOPED, LIKE `detach` AND FOR THE SAME REASON ──────────────────
   *
   * This was keyed on the session alone, so it renewed whichever socket happened to
   * be attached — meaning a **superseded** socket's ping renewed its REPLACEMENT.
   * Two things follow, and neither is what any caller means by a heartbeat:
   *
   *  * `lastSeen` stopped measuring "has THIS socket pinged" and started measuring
   *    "has any socket for this session pinged", which is exactly the premise
   *    {@link silentSince} and the sweep rest on. A console whose old socket is
   *    still pinging on an orphaned timer would keep a genuinely silent replacement
   *    out of the sweep's reach.
   *  * the route answers by `send(sessionId, …)`, which resolves to the attached
   *    socket — so the replacement's console received a `pong` echoing a `ts` it
   *    never sent, i.e. a fabricated round-trip sample and, since the pong carries
   *    `server_ts`, a fabricated clock-offset sample with it.
   *
   * Bounded in practice, because `attach` now closes the prior socket with 4409 —
   * but bounded by a race rather than by a rule, and every other guard on this path
   * (`detach`, the close handler's `socketFor` comparison) is socket-scoped. `ws` is
   * optional for the same reason it is on `detach`: a caller that legitimately holds
   * only a session id keeps the old behaviour.
   */
  async heartbeat(sessionId: string, ws?: WebSocket): Promise<boolean> {
    const entry = this.stations.get(sessionId);
    if (!entry || (ws && entry.ws !== ws)) return false;
    entry.lastSeen = Date.now();
    await this.claimOwnership(sessionId);
    return true;
  }

  private async claimOwnership(sessionId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(
        this.ownershipKey(sessionId),
        JSON.stringify({ replicaId: this.replicaId }),
        'PX', OWNERSHIP_TTL_MS,
      );
    } catch (err) {
      log.warn({ err, sessionId }, 'Failed to write station ownership key');
    }
  }

  /**
   * Which replica owns this agent. With one replica this is always us when the agent is
   * live — but the dial path asks anyway, so the question is load-bearing from
   * day one rather than becoming load-bearing on the day we scale out.
   */
  async ownerOf(sessionId: string): Promise<string | null> {
    if (!this.redis) return this.stations.has(sessionId) ? this.replicaId : null;
    try {
      const raw = await this.redis.get(this.ownershipKey(sessionId));
      if (!raw) return null;
      return (JSON.parse(raw) as { replicaId?: string }).replicaId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Which of these agents' stations are held right now — the supervisor floor's
   * liveness column.
   *
   * ── Why this is not a loop over `ownerOf` ────────────────────────────────────
   *
   * Two reasons, and the second is the load-bearing one.
   *
   * 1. **One `MGET`, not N round trips.** The floor is polled, and a busy campaign
   *    has tens of agents on it.
   *
   * 2. **`ownerOf` cannot say "I don't know".** It maps a Redis fault to `null`,
   *    the same value it uses for "no key" — correct there, because every caller is
   *    a dial-path guard for which "not owned" is the fail-SAFE answer. It is the
   *    wrong answer here: the floor would render a confident "disconnected" for
   *    every agent whenever Redis hiccuped, on the one screen a supervisor acts
   *    from. So this **throws** instead, and the route maps that to `connected:
   *    null` = unknown. Distinguishing the two is the whole point of the method.
   *
   * With no Redis configured, the in-process map is the truthful authority (single
   * replica) and is used directly.
   *
   * @throws whatever ioredis throws. Callers must treat that as "unknown", never
   *   as "disconnected".
   */
  async connectedBySession(sessionIds: readonly string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    // `MGET` with no keys is an error, and an empty floor is the common case on a
    // campaign between shifts.
    if (sessionIds.length === 0) return out;
    if (!this.redis) {
      for (const id of sessionIds) out.set(id, this.stations.has(id));
      return out;
    }
    const raw = await this.redis.mget(...sessionIds.map((id) => this.ownershipKey(id)));
    sessionIds.forEach((id, i) => {
      // Presence is the whole signal: the key carries a 30s TTL renewed by the
      // station ping, so a key that exists means a ping landed inside that window.
      // The replica id inside it is deliberately not parsed — with one replica it is always
      // us, and after scale-out "some replica holds this agent" is still exactly
      // the question the floor is asking.
      out.set(id, raw[i] != null);
    });
    return out;
  }

  isLocallyOwned(sessionId: string): boolean {
    return this.stations.has(sessionId);
  }

  /**
   * Is this agent's station held ANYWHERE — the cross-replica answer that
   * `POST /sessions/:id/available` will need.
   *
   * ── ⚠️ NOT WIRED IN, AND NOT SAFE TO WIRE IN ON ITS OWN ────────────────────
   *
   * Groundwork, kept because it is the correct primitive and is tested. Nothing
   * in production calls it today, and the `available` route deliberately still
   * uses `isLocallyOwned`.
   *
   * The reason is not caution about this method — it is that the local check it
   * would replace is incidentally protecting every replica-local guard further
   * down that route. Swap it in and the gate starts passing on a non-owning
   * replica, where `WrapupManager`'s in-process Map then reports no wrap-up: the
   * mandatory-disposition refusal silently stops firing and the reaper stamps
   * `no_disposition` over the record of what was said to a customer. `/leave`'s
   * live-attempt check fails open the same way. The route's own comment block
   * spells this out at the call site.
   *
   * Wiring this in therefore belongs with making wrap-up, breaks and the
   * live-attempt set cross-replica — not before. Read the two limits at the
   * bottom of this comment first; they are properties of the ownership key, and
   * they do not go away.
   *
   * ── Why `isLocallyOwned` was the wrong primitive there ──────────────────────
   *
   * It is a plain in-process `Map` read, so it answers "do *I* hold this socket",
   * and the route was treating that as "does a socket exist". Those are the same
   * question only while exactly one replica is running. Behind a load balancer the
   * station socket pins to whichever replica accepted the upgrade, while the
   * ordinary POST is routed independently — so an agent whose console is connected
   * and pinging normally gets a 409 telling them to open the station they already
   * have, on roughly (N-1)/N of attempts. That is ONE part of the "single replica
   * only" deploy constraint on the agency dialer — not the whole of it. The dial
   * path (leadership plus a local-only dispatcher) and the replica-local wrap-up,
   * break and live-attempt state hold the rest; see the route's comment block.
   *
   * ── The three-valued return is the point ────────────────────────────────────
   *
   * `connectedBySession` throws on a Redis fault precisely so the supervisor floor
   * can render "unknown" rather than a confident "disconnected". The same
   * distinction matters here for a different reason: an agent whose station is fine
   * must not be told to open it. So this reports `unknown` rather than folding a
   * Redis outage into `absent`, leaving a caller free to say something different
   * for each. No caller does today — `/available` has no `unknown` branch, because
   * it does not call this method at all.
   *
   * ── What a future caller should do with `unknown` ───────────────────────────
   *
   * Refuse, and it is worth recording why the obvious justification for that is
   * wrong. Admitting an unconfirmable agent
   * does NOT produce an abandoned call: the dial path independently refuses one
   * three times over — `planTick` filters candidates on the local map,
   * `dialUpTo` refuses a null `ownerOf`, and `LocalDialDispatcher` throws on an
   * owner mismatch. The actual cost of failing open is a ghost-`available` agent
   * who is never dialed, which is a support ticket rather than a compliance event.
   *
   * So this is a judgement call, not a forced move: refusing keeps the agent's
   * state honest and the remedy in their hands, at the price that on a
   * multi-replica deployment a Redis READ outage stops every agent whose socket is
   * on another replica from going available at all — a floor-wide outage on a
   * route that previously touched no Redis. Single replica is unaffected, because
   * the local hit short-circuits before any of this.
   *
   * The local map is checked FIRST and short-circuits, which is what keeps the
   * single-replica and no-Redis configurations behaving exactly as they did.
   *
   * Do NOT read that as "the map is ground truth" — an earlier draft of this
   * comment said so and `timers.ts` says the opposite, at length: a socket whose
   * client heartbeat is orphaned stays in this map while the ownership key that
   * same heartbeat renews has long expired, which is why the silent-station sweep
   * exists. The two branches answer genuinely different questions ("a socket
   * object is in my map" vs "a ping landed within the TTL") and they disagree for
   * roughly the sweep's grace window. Preserving the old behaviour on the
   * deployment we actually run is the reason for the ordering; authority is not.
   *
   * ── TWO LIMITS OF THE REDIS BRANCH, both real ──────────────────────────────
   *
   * 1. **A key can outlive its socket.** `detach`'s `del` is best-effort and an
   *    ungraceful death runs no `detach` at all, so for up to the key's TTL after
   *    a restart the key exists with no socket behind it. `stationPresence` cannot
   *    tell that from a sibling replica's live socket — the two are the same two
   *    values, and the replica id is not a discriminator when ids differ per
   *    process. The reaper uses this same key CONSERVATIVELY (present ⇒ don't
   *    reap, which fails closed); reading it permissively, as here, is what makes
   *    the staleness matter. Consequence on one replica: for that window after a
   *    restart an agent can go available before their console re-attaches, and
   *    then sits ready without being dialed (the pacing engine filters on the
   *    local map) until it does. Bounded and self-healing, but a real regression
   *    against the old refusal, with no offsetting benefit while the dial path is
   *    still single-replica.
   * 2. **`unknown` covers read faults only.** `claimOwnership` swallows a failed
   *    `SET` and `detach` a failed `DEL`, so a Redis whose writes fail while reads
   *    succeed (a READONLY replica after failover, an eviction) yields a confident
   *    `absent` — the very wrong-and-certain answer this method exists to avoid,
   *    reached through the write path instead of the read path.
   */
  async stationPresence(sessionId: string): Promise<'connected' | 'absent' | 'unknown'> {
    // We hold it. Not because the map is more authoritative than Redis — the
    // docstring above says it is not, and an orphaned socket outlives its
    // ownership key — but because short-circuiting here is what preserves the
    // existing single-replica behaviour, which is the common case.
    if (this.stations.has(sessionId)) return 'connected';
    // No Redis configured means one replica: the in-process map IS the authority, and a miss
    // is a genuine absence rather than something we failed to look up.
    if (!this.redis) return 'absent';
    try {
      // Presence is the whole signal, exactly as in `connectedBySession`: the key
      // carries a 30s TTL renewed by the station ping, so a key that exists means a
      // ping landed inside that window. The replica id inside is deliberately not
      // parsed — "some replica holds this agent" is the question being asked, and
      // reading the id would invite a same-replica comparison that reintroduces the
      // bug this method exists to fix.
      const raw = await this.redis.get(this.ownershipKey(sessionId));
      return raw != null ? 'connected' : 'absent';
    } catch (err) {
      log.warn({ err, sessionId }, 'Station ownership lookup failed — presence unknown');
      return 'unknown';
    }
  }

  /**
   * Stations whose last sign of life is older than their grace — the selector the
   * silent-station sweep filters and acts on (`AgencyRuntime.sweepSilentStations`).
   *
   * `graceMs` is one grace for every entry, or a function of the entry: the sweep
   * passes {@link stationGraceFor}, so a web station keeps its 30s and a mobile one is
   * held to 10s (renewed by its protocol pongs as well as its pings).
   *
   * `lastSeen` is written at attach and on every heartbeat and, until that sweep
   * landed, was read by nothing at all. Note what it does and does not measure: a
   * station is silent from the moment its console stops *pinging*, which is not
   * the same as its TCP connection being gone and is precisely the case worth
   * detecting — a socket whose client-side heartbeat timer was orphaned looks
   * perfectly healthy from here and holds the agent's ownership key hostage.
   *
   * Media frames deliberately do not renew it: media is relayed by the bridge's
   * own borrowed-socket listener and never reaches `heartbeat`, so audio flowing is
   * not evidence the console's heartbeat is alive. The sweep's mid-attempt guard is
   * what keeps that from costing a live conversation.
   *
   * The decision to close is NOT taken here: the registry has no way to ask whether
   * an agent is mid-call, and this socket is also the media leg.
   */
  silentSince(graceMs: number | ((entry: StationEntry) => number), now = Date.now()): StationEntry[] {
    const out: StationEntry[] = [];
    for (const entry of this.stations.values()) {
      const grace = typeof graceMs === 'number' ? graceMs : graceMs(entry);
      if (now - entry.lastSeen > grace) out.push(entry);
    }
    return out;
  }

  get(sessionId: string): StationEntry | undefined {
    return this.stations.get(sessionId);
  }

  /** The live socket for an agent, if this replica holds it. */
  socketFor(sessionId: string): WebSocket | undefined {
    return this.stations.get(sessionId)?.ws;
  }

  sessionIdsForCampaign(campaignId: string): string[] {
    const out: string[] = [];
    for (const [id, e] of this.stations) if (e.campaignId === campaignId) out.push(id);
    return out;
  }

  /**
   * Push a control frame to an agent.
   *
   * Synchronous by design — `reserved` in particular must reach the wire inside
   * the dial tick, before the dial is placed. Returns false when the socket
   * is gone, which the caller must treat as "this agent is not really there".
   *
   * ── `expectedWs`: THE THIRD SOCKET-SCOPED GUARD ───────────────────────────
   *
   * Optional, and for the same reason it is optional on {@link detach} and
   * {@link heartbeat}: a caller that legitimately holds only a session id — the
   * dial tick, {@link broadcast}, anything reacting to a campaign — keeps the
   * old behaviour of "whoever is attached". A caller that is answering one
   * PARTICULAR socket must pass it, because resolving by session id alone
   * delivers that answer to whatever socket is attached when the send finally
   * happens, and after an await that is not necessarily the socket that asked.
   *
   * Both such callers are on the station route, and both were wrong before this
   * parameter existed. `handlePing` re-checks the incumbent at the top and then
   * awaits a row read and up to two Redis calls, so a supersede inside that
   * window delivered the old socket's `pong` — carrying the old socket's `ts`
   * and a `server_ts` to match — to the REPLACEMENT. The console does not
   * correlate a pong against an outstanding ping: it clears the miss counter,
   * resets the backoff ladder and takes a clock-offset sample from whatever
   * arrives. So that one stray frame told a brand-new socket it had completed a
   * round trip it had never made, which is precisely the "proved liveness"
   * signal the console's ladder is built on. `ready` is the same shape with far
   * more state on it — see the route's `stillOurs` fence.
   *
   * ── Back-pressure (`utils/ws-backpressure.ts`) ──────────────────────────
   *
   * Checked on `ws.bufferedAmount` before the frame is serialised. A control frame is
   * never dropped. A `media` frame (JSON, so a `pcm16` socket's) past the soft limit is
   * dropped and this returns false: it was not delivered. Past the hard cap the console is
   * not reading at all: the socket is closed 4408 `station_send_backlog` (the console
   * re-mints and reconnects, and `ready` carries the state again) and this returns false,
   * so a dial tick treats the agent as not there, as for a socket that is gone.
   *
   * ── Console-only events ─────────────────────────────────────────────────
   * An event in `AGENCY_STATION_CONSOLE_ONLY_EVENTS` (the inbound call frames) is never sent to a
   * MOBILE station, whoever asks: the app has no wire type for it yet (docs/inbound.md §4.3, Q20).
   * Enforced here, the one send path, so the rule does not rest on every inbound caller of `send`
   * having already ruled a phone out. Dropped, logged, and answered false (not delivered).
   */
  send(sessionId: string, frame: AgencyStationServerFrame, expectedWs?: WebSocket): boolean {
    const entry = this.stations.get(sessionId);
    const ws = entry?.ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) return false;
    if (entry.clientKind === 'mobile' && isConsoleOnly(frame.event)) {
      log.warn({ sessionId, event: frame.event }, 'Console-only station frame not sent to a mobile station');
      return false;
    }
    // "Answer this socket, or answer nobody" — never "answer whoever is here now".
    if (expectedWs !== undefined && ws !== expectedWs) return false;
    const verdict = sendVerdict(ws, { media: frame.event === 'media' }, STATION_PCM16_LIMITS);
    if (verdict === 'drop') {
      trackWebsocketSendBackpressure('station', 'media_dropped');
      return false;
    }
    if (verdict === 'over_cap') {
      if (closeForSendBacklog(ws)) {
        trackWebsocketSendBackpressure('station', 'closed');
        log.warn({ sessionId, event: frame.event, bufferedAmount: ws.bufferedAmount },
          'Station console stopped reading: send backlog past its cap, closing 4408');
      }
      return false;
    }
    if (verdict === 'not_open') return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      log.warn({ err, sessionId, event: frame.event }, 'Failed to send station frame');
      return false;
    }
  }

  /**
   * Push a frame to every agent on a campaign. Returns how many received it.
   *
   * The campaign-state frame is the reason this exists: an agent sitting idle with
   * no attempt is unreachable by any per-attempt frame, so "the list is finished"
   * has to be broadcast or it never arrives.
   */
  broadcast(campaignId: string, frame: AgencyStationServerFrame): number {
    let sent = 0;
    for (const sessionId of this.sessionIdsForCampaign(campaignId)) {
      if (this.send(sessionId, frame)) sent++;
    }
    return sent;
  }

  /** Every locally-owned station, for shutdown and sweeps. */
  all(): StationEntry[] {
    return [...this.stations.values()];
  }

  size(): number {
    return this.stations.size;
  }
}

const CONSOLE_ONLY: ReadonlySet<string> = new Set(AGENCY_STATION_CONSOLE_ONLY_EVENTS);

/** Whether `event` is one a mobile station is never sent (`AGENCY_STATION_CONSOLE_ONLY_EVENTS`). */
function isConsoleOnly(event: AgencyStationServerFrame['event']): boolean {
  return CONSOLE_ONLY.has(event);
}
