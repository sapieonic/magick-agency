import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
import { trackListenSessionEnded } from '@magick-agency/observability/metrics/agency';
import {
  AGENCY_LISTEN_CLOSE,
  AGENCY_LISTEN_END_CLOSE,
  AGENCY_LISTEN_FRAME_BYTES,
  AGENCY_LISTEN_IDLE_TIMEOUT_MS,
  AGENCY_LISTEN_PING_INTERVAL_MS,
  type AgencyListenClientFrame,
  type AgencyListenEndReason,
  type AgencyListenServerFrame,
} from '@magick-agency/contracts/agency';
import type { AgencyListenErrorCode } from '@magick-agency/contracts/errors';
import type {
  ListenSink, ListenTapEndReason, ListenTapHandle, ListenTapStats, OpenListenTapResult,
} from '../../core/webrtc-bridge-manager.js';
import { sendToListenerSocket } from '../../core/bridge/listen-tap.js';
import { closeThenTerminate } from '../../utils/ws-backpressure.js';
import { LISTEN_MAX_CLIENT_MESSAGE_BYTES } from '../../utils/ws-limits.js';
import type { ListenSessionCloseInput, ListenSessionOpenInput } from '../../db/repositories/agency.repository.js';
import type { PlatformCreateAuditLogInput } from '../../audit/platform/audit-logger.js';
import { ListenTokenUnavailableError, type ListenGrantPayload, type ListenTokenStore } from './listen-token.js';
import type { ListenRegistry, ListenSessionHandle } from './listen-registry.js';

const log = createChildLogger({ component: 'agency-listen-socket' });

/**
 * The supervisor's listener socket (`docs/listening.md` §3, §4): the upgrade's fail-closed
 * admission, then the session — the bridge's {@link ListenSink} over the socket, the control
 * frames, the idle bound, and the one end that closes the row, the socket and the audit pair.
 *
 * ── The upgrade, in order (LS7: no row, no audio) ────────────────────────────
 *  1. The socket's `error` handler, before anything else: a throw inside a `ws` listener would
 *     take the process down, and an errored socket is just a closed one here.
 *  2. Spend the single-use token (4401 `listen_token_invalid` if it is missing, spent, expired or
 *     another listen's; the grant must name this socket's session too; 1011 `listen_unavailable`
 *     when the token store cannot be asked).
 *  3. Reserve a slot under the caps (4429 with `listen_limit_call` / `listen_limit_server`; 1011
 *     `listen_unavailable` while the process stops), recording the supervisor's revocation
 *     generation; a grant minted before their latest revocation here is refused 4403
 *     `permission_revoked`.
 *  4. Ask the database whether they may still listen (LS16 n: the grant's checks are up to a token
 *     TTL old): 4403 `permission_revoked` if not, 1011 `listen_unavailable` if it cannot say.
 *  5. Write the `agency_listen_sessions` row and AWAIT it (1011 `listen_unavailable` if it
 *     fails: nothing was opened).
 *  6. Attach the bridge's tap (4404 `listen_call_not_live` if the bridge no longer has the call
 *     bridged, or attached nothing; the row just written closes `call_ended`; 1011
 *     `listen_unavailable` if opening it threw, the row closed `tap_error`).
 *  7. Admit the session (the supervisor's older listen ends `superseded`), send `ready`, stamp the
 *     row live (not awaited), audit `agency_call.listen_started`. A revocation since step 3 refuses
 *     it instead: the row closes `permission_revoked`, 4403, no audit pair.
 * A refusal closes with the error code as the close reason, so the listening bar can say why; it
 * sends no `ended` frame (only a session that went live does). A row written and then refused
 * stays not live (`live_at` NULL), so "Listened to by" leaves it out.
 *
 * ── Liveness (QA-M1) ─────────────────────────────────────────────────────────
 * The server pings the socket at the protocol level every {@link AGENCY_LISTEN_PING_INTERVAL_MS}
 * and counts the pong, as it counts any client frame: a browser answers protocol pings itself,
 * so a hidden tab whose timers are throttled to once a minute (its JSON `ping`s late) is not ended
 * `listener_disconnected` while it is still reading. The client's JSON `ping` stays answered.
 * Client messages are rate-limited per socket ({@link LISTEN_CLIENT_MESSAGE_BURST}, refilled at
 * {@link LISTEN_CLIENT_MESSAGES_PER_SECOND}): past it the socket is closed 1008 (QA-L5).
 *
 * ── The end ──────────────────────────────────────────────────────────────────
 * Exactly once, whoever ends it (the client's `stop` or close, the idle bound, the tap, the
 * registry's supersede, revoke, staleness cap or shutdown): the tap detached, `ended { reason }`
 * sent and the socket closed with the reason's code (unless the client closed it), then
 * terminated if it has not closed 5 s later (a reader that stopped never completes the close
 * handshake: `closeThenTerminate`, as the station's backlog close), the row closed with its
 * reason and counters, `agency_call.listen_ended` audited, the metrics counted. A failed row
 * close is logged and retried by the rows' upkeep (`listen-rows.ts`); a failed audit write is
 * logged; neither touches the call.
 */

/** Sent as the close reason when the upgrade's token does not verify. */
export const LISTEN_TOKEN_INVALID_REASON = 'listen_token_invalid';

/** The close reason (with 1008) for a client that sends messages faster than the bucket allows. */
export const LISTEN_MESSAGE_RATE_REASON = 'listen_message_rate';

/** The client messages a listener socket may send at once ({@link LISTEN_CLIENT_MESSAGES_PER_SECOND} refill it). */
export const LISTEN_CLIENT_MESSAGE_BURST = 20;

/**
 * The client messages a second the bucket refills: the console sends a `ping` every 10 s and one
 * `stop`, so 5 a second is far past any honest client.
 */
export const LISTEN_CLIENT_MESSAGES_PER_SECOND = 5;

/**
 * The largest client message the listener socket reads (`utils/ws-limits.ts`): its frames are
 * `ping` and `stop`, tens of bytes. Anything longer is ignored unparsed (the app-wide `maxPayload`
 * still bounds the socket).
 */
export { LISTEN_MAX_CLIENT_MESSAGE_BYTES };

/** The control frame a client message is, or null: JSON, an object, a known event, known keys only. */
export function parseListenClientFrame(raw: string): AgencyListenClientFrame | null {
  if (raw.length > LISTEN_MAX_CLIENT_MESSAGE_BYTES) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (o['event'] === 'stop') return keys.length === 1 ? { event: 'stop' } : null;
  if (o['event'] === 'ping') {
    if (keys.some((k) => k !== 'event' && k !== 'ts')) return null;
    if (o['ts'] === undefined) return { event: 'ping' };
    const ts = o['ts'];
    return typeof ts === 'number' && Number.isFinite(ts) ? { event: 'ping', ts } : null;
  }
  return null;
}

/** What the socket needs from the rest of the process. Production wiring: `runtime.ts`. */
export interface ListenSocketDeps {
  tokens: Pick<ListenTokenStore, 'consume'>;
  registry: ListenRegistry;
  bridge: { openListenTap(callId: string, sink: ListenSink, options?: { faultBudget: number }): OpenListenTapResult };
  /** `AGENCY_LISTEN_FAULT_BUDGET`, passed to the tap through the seam (the voice area reads no agency config). */
  faultBudget?: number;
  rows: {
    open(input: ListenSessionOpenInput): Promise<unknown>;
    close(id: string, input: ListenSessionCloseInput): Promise<unknown>;
    /** Stamp the row live; never rejects (`ListenRowKeeper.markLive`). */
    markLive(id: string): Promise<unknown>;
  };
  audit(entry: PlatformCreateAuditLogInput): void;
  /** This process (`agency_listen_sessions.replica_id`). */
  replicaId: string;
  /**
   * After an admission: end the supervisor's sessions held by OTHER processes past their cap
   * (`superseded`). Null in one process, where every session is this registry's.
   */
  supersedeElsewhere?: ((session: ListenSessionHandle) => void) | null;
  idleTimeoutMs?: number;
  /** How often the server pings the socket at the protocol level (QA-M1); default the client's ping interval. */
  pingIntervalMs?: number;
  now?: () => number;
}

/** `ws`'s `readyState` for an open socket. */
const OPEN = 1;

function sendJson(ws: WebSocket, frame: AgencyListenServerFrame): void {
  if (ws.readyState !== OPEN) return;
  try { ws.send(JSON.stringify(frame)); } catch { /* the close follows */ }
}

/** Close, then terminate after 5 s if the peer never completes the handshake (SWE-M3). Never throws. */
function closeWith(ws: WebSocket, code: number, reason: string): void {
  closeThenTerminate(ws, code, reason);
}

/**
 * A refusal at the upgrade: the close code for each error code (`AGENCY_LISTEN_CLOSE`).
 * `permission_revoked` (an end reason, not an error code) is the supervisor's access gone: 4403.
 */
function refuse(ws: WebSocket, code: AgencyListenErrorCode | typeof LISTEN_TOKEN_INVALID_REASON | 'permission_revoked'): void {
  const close = code === LISTEN_TOKEN_INVALID_REASON ? AGENCY_LISTEN_CLOSE.TOKEN_REJECTED
    : code === 'permission_revoked' ? AGENCY_LISTEN_CLOSE.FORBIDDEN
      : code === 'listen_limit_call' || code === 'listen_limit_server' ? AGENCY_LISTEN_CLOSE.LIMIT
        : code === 'listen_call_not_live' ? AGENCY_LISTEN_CLOSE.CALL_GONE
          : AGENCY_LISTEN_CLOSE.INTERNAL_ERROR;
  closeWith(ws, close, code);
}

/** One open listen: the registry's handle and the bridge's sink. */
class ListenSocketSession implements ListenSessionHandle, ListenSink {
  readonly listenId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly callId: string;
  readonly listenerUserId: string;
  readonly recording: boolean;
  readonly startedAt: number;
  tap: ListenTapHandle | null = null;
  private ended: Promise<void> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private pinger: NodeJS.Timeout | null = null;
  private live = false;

  constructor(
    private readonly ws: WebSocket,
    readonly grant: ListenGrantPayload,
    private readonly deps: ListenSocketDeps,
  ) {
    this.listenId = grant.listenId;
    this.tenantId = grant.tenantId;
    this.accountId = grant.accountId;
    this.callId = grant.callId;
    this.listenerUserId = grant.listenerUserId;
    this.recording = grant.recording;
    this.startedAt = (deps.now ?? Date.now)();
  }

  get isEnded(): boolean {
    return this.ended !== null;
  }

  // ── ListenSink ──────────────────────────────────────────────────────────
  send(message: Buffer) {
    return sendToListenerSocket(this.ws, message);
  }

  close(reason: ListenTapEndReason, stats: ListenTapStats): void {
    // The tap has detached this sink already: end with what it was given.
    void this.end(reason, stats);
  }

  // ── The session ─────────────────────────────────────────────────────────
  /**
   * Live from `ready`: control frames are answered, the idle bound runs, the server pings at the
   * protocol level (a pong counts as liveness, QA-M1), and the row is stamped live (not awaited).
   */
  goLive(): void {
    this.live = true;
    this.touch();
    this.pinger = setInterval(() => {
      if (this.ended || this.ws.readyState !== OPEN) return;
      try { this.ws.ping(); } catch { /* the close follows */ }
    }, this.deps.pingIntervalMs ?? AGENCY_LISTEN_PING_INTERVAL_MS);
    this.pinger.unref?.();
    void this.deps.rows.markLive(this.listenId);
  }

  /** A client frame arrived: the idle bound starts again. */
  touch(): void {
    if (!this.live || this.ended) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      log.info({ listenId: this.listenId, callId: this.callId }, 'Listener silent past the idle bound — ending the listen');
      void this.end('listener_disconnected');
    }, this.deps.idleTimeoutMs ?? AGENCY_LISTEN_IDLE_TIMEOUT_MS);
    this.idle.unref?.();
  }

  onClientFrame(frame: AgencyListenClientFrame): void {
    if (!this.live || this.ended) return;
    this.touch();
    if (frame.event === 'stop') {
      void this.end('listener_stopped');
      return;
    }
    sendJson(this.ws, { event: 'pong', ...(frame.ts !== undefined ? { ts: frame.ts } : {}), server_ts: (this.deps.now ?? Date.now)() });
  }

  /**
   * End the session once. `stats` is the tap's when the tap ended it; `clientClosed` when the
   * socket is already closing from the other side (nothing more is sent on it); `closeCode` to
   * close with another code than the reason's (1008 for a client past the message rate).
   */
  end(reason: AgencyListenEndReason, stats?: ListenTapStats, clientClosed = false, closeCode?: { code: number; reason: string }): Promise<void> {
    if (this.ended) return this.ended;
    this.ended = this.finish(reason, stats, clientClosed, closeCode);
    return this.ended;
  }

  private async finish(
    reason: AgencyListenEndReason,
    tapStats: ListenTapStats | undefined,
    clientClosed: boolean,
    closeCode: { code: number; reason: string } | undefined,
  ): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    let stats: ListenTapStats = tapStats ?? { framesSent: 0, framesDropped: 0 };
    if (!tapStats && this.tap) {
      try {
        stats = this.tap.stats();
        this.tap.detach();
      } catch (err) {
        log.warn({ err, listenId: this.listenId }, 'Listen tap detach threw');
      }
    }
    this.deps.registry.remove(this.listenId);
    // Only a session that went live says how it ended: one ended during its upgrade is a refusal,
    // and the upgrade closes the socket with the refusal's own code (SWE-L1).
    if (this.live && !clientClosed && reason !== 'server_restarted') {
      sendJson(this.ws, { event: 'ended', reason });
      if (closeCode) closeWith(this.ws, closeCode.code, closeCode.reason);
      else closeWith(this.ws, AGENCY_LISTEN_END_CLOSE[reason], reason);
    }
    const now = (this.deps.now ?? Date.now)();
    const seconds = Math.max(0, (now - this.startedAt) / 1000);
    try {
      await this.deps.rows.close(this.listenId, { reason, framesSent: stats.framesSent, framesDropped: stats.framesDropped, live: this.live });
    } catch (err) {
      // Production's rows (`listen-rows.ts`) queue it: the re-check tick retries it with this reason.
      log.error({ err, listenId: this.listenId, callId: this.callId, reason }, 'Could not close the listen session row — retrying on the next re-check');
    }
    // A session refused after its row was written (the call ended under the upgrade) never
    // started: its row says so, and there is no `listen_started` for an `_ended` to pair with.
    if (this.live) {
      auditListen(this.deps, this.grant, 'agency_call.listen_ended', {
        duration_seconds: Math.round(seconds), end_reason: reason, frames_dropped: stats.framesDropped,
      });
      try { trackListenSessionEnded(reason, seconds); } catch { /* a metric is never worth the end */ }
    }
    log.info({ listenId: this.listenId, callId: this.callId, reason, framesSent: stats.framesSent, framesDropped: stats.framesDropped },
      'Listen session ended');
  }
}

function auditListen(
  deps: Pick<ListenSocketDeps, 'audit'>,
  grant: ListenGrantPayload,
  action: 'agency_call.listen_started' | 'agency_call.listen_ended',
  extra: Record<string, unknown> = {},
): void {
  try {
    deps.audit({
      tenant_id: grant.tenantId,
      account_id: grant.accountId,
      actor_type: 'human',
      user_id: grant.listenerUserId,
      action,
      resource_type: 'agency_call',
      resource_id: grant.callId,
      ...(grant.campaignId ? { campaign_id: grant.campaignId } : {}),
      details: {
        listen_id: grant.listenId,
        call_id: grant.callId,
        origin: grant.origin,
        correlation_id: grant.correlationId,
        agent_user_id: grant.agentUserId,
        ...extra,
      },
    });
  } catch (err) {
    // The row is the record (LS7); a lost audit row is logged, never fatal.
    log.error({ err, listenId: grant.listenId, action }, 'Could not write the listen audit row');
  }
}

/**
 * Run one listener socket from its upgrade to its end. The route has refused a malformed upgrade
 * already (`proxy-agency-listen.routes.ts`); `sessionId` and `listenId` are canonical UUIDs.
 * Resolves once the upgrade is decided (admitted or refused), not when the session ends.
 */
export async function handleListenSocket(
  ws: WebSocket,
  input: { sessionId: string; listenId: string; token: string | undefined },
  deps: ListenSocketDeps,
): Promise<ListenSocketSession | null> {
  // 1. First, before any await: an errored socket is a closed one, never a crash.
  ws.on('error', (err) => log.debug({ err: err.message, listenId: input.listenId }, 'Listener socket error'));
  let clientGone = false;
  let session: ListenSocketSession | null = null;
  ws.on('close', () => {
    clientGone = true;
    if (session) void session.end('listener_disconnected', undefined, true);
  });
  // QA-L5: a token bucket per socket, every client message counted (binary and text, before or
  // after `ready`). Past it the socket is closed 1008: an honest console sends a ping every 10 s.
  const nowMs = deps.now ?? Date.now;
  let tokens = LISTEN_CLIENT_MESSAGE_BURST;
  let refilledAt = nowMs();
  let abused = false;
  ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (abused) return;
    const at = nowMs();
    tokens = Math.min(LISTEN_CLIENT_MESSAGE_BURST, tokens + ((at - refilledAt) / 1000) * LISTEN_CLIENT_MESSAGES_PER_SECOND);
    refilledAt = at;
    if (tokens < 1) {
      abused = true;
      log.warn({ listenId: input.listenId }, 'Listener socket past its message rate — closing it');
      const rate = { code: AGENCY_LISTEN_CLOSE.INVALID_UPGRADE, reason: LISTEN_MESSAGE_RATE_REASON };
      if (session) void session.end('listener_disconnected', undefined, false, rate);
      else closeWith(ws, rate.code, rate.reason);
      return;
    }
    tokens -= 1;
    if (!session || isBinary) return; // audio from the client is ignored
    const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    if (bytes.length > LISTEN_MAX_CLIENT_MESSAGE_BYTES) return;
    const frame = parseListenClientFrame(bytes.toString('utf8'));
    if (frame) session.onClientFrame(frame);
  });
  // A protocol pong (the browser answers the server's ping itself) is liveness too (QA-M1).
  ws.on('pong', () => { session?.touch(); });

  // 2. The token, spent once, and it must be this socket's.
  let grant: ListenGrantPayload | null;
  try {
    grant = await deps.tokens.consume(input.listenId, input.token);
  } catch (err) {
    // The store could not be asked (QA-L3): not the token's fault, so not 4401 (re-mint).
    if (!(err instanceof ListenTokenUnavailableError)) log.error({ err, listenId: input.listenId }, 'Listen token consume threw');
    if (!clientGone && !abused) refuse(ws, 'listen_unavailable');
    return null;
  }
  if (abused) return null;
  if (!grant || grant.sessionId !== input.sessionId) {
    log.warn({ listenId: input.listenId, sessionId: input.sessionId }, 'Listen upgrade with a missing, spent or foreign token — refusing');
    refuse(ws, LISTEN_TOKEN_INVALID_REASON);
    return null;
  }
  if (clientGone) return null;

  // 3. A slot under the caps, at the supervisor's revocation generation (the grant's, or refused).
  const reserved = deps.registry.reserve({
    listenId: grant.listenId, callId: grant.callId, tenantId: grant.tenantId, listenerUserId: grant.listenerUserId,
    grantGeneration: grant.revocationGen,
  });
  if (!reserved.ok) {
    log.info({ listenId: grant.listenId, callId: grant.callId, code: reserved.code }, 'Listen upgrade refused at the reservation');
    refuse(ws, reserved.code);
    return null;
  }

  // 4. May they still listen? Asked of the database, fail closed.
  const access = await deps.registry.verify(grant);
  if (access !== 'ok' || clientGone) {
    deps.registry.release(reserved.reservation);
    if (clientGone) return null;
    log.info({ listenId: grant.listenId, callId: grant.callId, access }, 'Listen upgrade refused at the access check');
    refuse(ws, access === 'revoked' ? 'permission_revoked' : 'listen_unavailable');
    return null;
  }

  // 5. The row, awaited: no row, no audio.
  try {
    await deps.rows.open({
      id: grant.listenId, tenantId: grant.tenantId, accountId: grant.accountId, callId: grant.callId,
      origin: grant.origin, campaignId: grant.campaignId, correlationId: grant.correlationId,
      agentSessionId: grant.sessionId, agentUserId: grant.agentUserId, listenerUserId: grant.listenerUserId,
      replicaId: deps.replicaId,
    });
  } catch (err) {
    deps.registry.release(reserved.reservation);
    log.error({ err, listenId: grant.listenId, callId: grant.callId }, 'Could not write the listen session row — refusing the listen');
    refuse(ws, 'listen_unavailable');
    return null;
  }

  const s = new ListenSocketSession(ws, grant, deps);
  if (clientGone || abused || deps.registry.isStopping) {
    deps.registry.release(reserved.reservation);
    await s.end(clientGone || abused ? 'listener_disconnected' : 'server_shutdown', undefined, clientGone);
    // A stopping process refuses as it does at the reservation (LS16 q): try again elsewhere.
    if (!clientGone && !abused) refuse(ws, 'listen_unavailable');
    return null;
  }

  // 6. The tap.
  let opened: OpenListenTapResult;
  try {
    opened = deps.bridge.openListenTap(grant.callId, s, deps.faultBudget !== undefined ? { faultBudget: deps.faultBudget } : undefined);
  } catch (err) {
    // Not the call's end: the bridge failed. The row says the tap failed; the bar retries (1011).
    log.error({ err, listenId: grant.listenId, callId: grant.callId }, 'Opening the listen tap threw');
    deps.registry.release(reserved.reservation);
    await s.end('tap_error', undefined, true);
    refuse(ws, 'listen_unavailable');
    return null;
  }
  // A tap that ended under the attach (it closed the sink at once and attached nothing: SWE-L1) is
  // a call no longer live, as a refusal is.
  if ('refused' in opened || !opened.attached || s.isEnded) {
    deps.registry.release(reserved.reservation);
    const why = 'refused' in opened ? opened.refused : 'ended_under_attach';
    log.info({ listenId: grant.listenId, callId: grant.callId, refused: why }, 'Listen upgrade: the call is not live here');
    if (!('refused' in opened)) {
      try { opened.detach(); } catch { /* already detached */ }
    }
    // The row says what happened to the listen: the call it was for had ended.
    await s.end('call_ended', undefined, true);
    refuse(ws, 'listen_call_not_live');
    return null;
  }
  s.tap = opened;

  // 7. Admitted, unless the supervisor was revoked here since the reservation.
  if (!deps.registry.admit(reserved.reservation, s).ok) {
    await s.end('permission_revoked');
    refuse(ws, 'permission_revoked');
    return null;
  }
  session = s;
  sendJson(ws, {
    event: 'ready', listen_id: grant.listenId, call_id: grant.callId, format: 'alaw8', frame_bytes: AGENCY_LISTEN_FRAME_BYTES,
  });
  s.goLive();
  auditListen(deps, grant, 'agency_call.listen_started');
  log.info({ listenId: grant.listenId, callId: grant.callId, sessionId: grant.sessionId }, 'Listen session started');
  try { deps.supersedeElsewhere?.(s); } catch (err) { log.warn({ err, listenId: grant.listenId }, 'Cross-process supersede threw'); }
  return s;
}

export type { ListenSocketSession };
