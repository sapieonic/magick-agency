import { createChildLogger } from '@magick-agency/observability';
import { trackListenSessionsActive } from '@magick-agency/observability/metrics/agency';
import type { AgencyListenEndReason } from '@magick-agency/contracts/agency';

const log = createChildLogger({ component: 'agency-listen-registry' });

/**
 * The listen sessions this process carries (`docs/listening.md` §4): the caps, the supersede, the
 * revocation and its periodic re-check, and the shutdown. One per process (the primary with
 * `MEDIA_WORKERS=0`, else each media worker), held by the agency runtime. It knows nothing about
 * sockets: a session is a {@link ListenSessionHandle} the socket (`listen-socket.ts`) implements,
 * and ending one is asking the handle to end itself.
 *
 * ── The caps (LS5) ──────────────────────────────────────────────────────────
 * Per call (`maxPerCall`), per process (`maxPerProcess`), per supervisor (`maxPerUser`, a new
 * listen past it ends their oldest `superseded`). A call is relayed by one process, so the
 * per-call count here is the call's. The per-call and per-process caps count reservations too
 * (an upgrade between its admission and its row), so two upgrades racing one slot cannot both
 * pass. A supervisor's own sessions that the new one would supersede do not count against the
 * per-call cap: a console reconnecting to the call it was on is not refused by its own stale
 * session.
 *
 * ── Revocation (LS10) ───────────────────────────────────────────────────────
 * {@link revokeUser} re-checks one supervisor's sessions now; {@link recheck} re-checks every
 * session every `recheckMs`. Both read the DATABASE through {@link ListenAccessCheck} (the
 * membership floor and the two flags), never the membership cache, and end what fails
 * `permission_revoked`. A check that cannot be made (the database is down) ends nothing: an
 * outage is not a revocation.
 */

/** One open listen session, as the socket presents it to the registry. */
export interface ListenSessionHandle {
  readonly listenId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly callId: string;
  readonly listenerUserId: string;
  /** The call's `recording_requested` (LS4: the unrecorded flag matters only when false). */
  readonly recording: boolean;
  /** Epoch ms the session was admitted. */
  readonly startedAt: number;
  /** End the session for `reason` (idempotent). Resolves once its row is closed. */
  end(reason: AgencyListenEndReason): Promise<void>;
}

/** Who may keep listening: the sessions among `sessions` that no longer may. */
export type ListenAccessCheck = (sessions: readonly ListenSessionHandle[]) => Promise<Set<string>>;

export interface ListenLimits {
  maxPerCall: number;
  maxPerProcess: number;
  maxPerUser: number;
  recheckMs: number;
}

/** A slot held for an upgrade between its admission and its row ({@link ListenRegistry.reserve}). */
export interface ListenReservation {
  readonly listenId: string;
  readonly callId: string;
  readonly tenantId: string;
  readonly listenerUserId: string;
}

/** Why a listen cannot be admitted here: the contract's codes (`errors.ts` §7). */
export type ListenAdmissionRefusal = 'listen_limit_call' | 'listen_limit_server';

export interface ListenRegistryDeps {
  limits: ListenLimits;
  /** The re-check's question (`listen-access.ts` in production). */
  access: ListenAccessCheck;
}

export class ListenRegistry {
  private readonly sessions = new Map<string, ListenSessionHandle>();
  private readonly reservations = new Map<string, ListenReservation>();
  private timer: NodeJS.Timeout | null = null;
  private rechecking: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly deps: ListenRegistryDeps) {}

  get limits(): ListenLimits {
    return this.deps.limits;
  }

  /** Sessions open now. */
  get size(): number {
    return this.sessions.size;
  }

  /** The open sessions (a copy). */
  all(): ListenSessionHandle[] {
    return [...this.sessions.values()];
  }

  get(listenId: string): ListenSessionHandle | undefined {
    return this.sessions.get(listenId);
  }

  /** True once {@link shutdown} has begun: no new session is admitted. */
  get isStopping(): boolean {
    return this.stopping;
  }

  /**
   * The supervisor's sessions a new one would end (`superseded`): their oldest, past
   * `maxPerUser - 1`. In the tenant: a user id is global, but a listen belongs to its tenant.
   */
  private toSupersede(tenantId: string, listenerUserId: string): ListenSessionHandle[] {
    const mine = [...this.sessions.values()]
      .filter((s) => s.tenantId === tenantId && s.listenerUserId === listenerUserId)
      .sort((a, b) => a.startedAt - b.startedAt);
    const keep = Math.max(0, this.deps.limits.maxPerUser - 1);
    return mine.slice(0, Math.max(0, mine.length - keep));
  }

  /**
   * Would a listen by `listenerUserId` on `callId` be admitted now? The grant's question
   * (`POST /listen-grants`); the upgrade asks again ({@link reserve}).
   */
  check(callId: string, tenantId: string, listenerUserId: string): ListenAdmissionRefusal | null {
    if (this.stopping) return 'listen_limit_server';
    const leaving = new Set(this.toSupersede(tenantId, listenerUserId).map((s) => s.listenId));
    let onCall = 0;
    let inProcess = 0;
    for (const s of this.sessions.values()) {
      if (leaving.has(s.listenId)) continue;
      inProcess++;
      if (s.callId === callId) onCall++;
    }
    for (const r of this.reservations.values()) {
      inProcess++;
      if (r.callId === callId) onCall++;
    }
    if (onCall >= this.deps.limits.maxPerCall) return 'listen_limit_call';
    if (inProcess >= this.deps.limits.maxPerProcess) return 'listen_limit_server';
    return null;
  }

  /** Hold a slot for an upgrade (synchronous: nothing can interleave with the count). */
  reserve(input: ListenReservation): { ok: true; reservation: ListenReservation } | { ok: false; code: ListenAdmissionRefusal } {
    const refused = this.check(input.callId, input.tenantId, input.listenerUserId);
    if (refused) return { ok: false, code: refused };
    const reservation: ListenReservation = { ...input };
    this.reservations.set(input.listenId, reservation);
    return { ok: true, reservation };
  }

  /** Give a slot back: the upgrade failed before its session opened. */
  release(reservation: ListenReservation): void {
    if (this.reservations.get(reservation.listenId) === reservation) this.reservations.delete(reservation.listenId);
  }

  /**
   * Turn a reservation into an open session, ending the supervisor's older sessions past
   * `maxPerUser` (`superseded`). Answers the sessions it superseded (their ends are in flight).
   */
  admit(reservation: ListenReservation, session: ListenSessionHandle): ListenSessionHandle[] {
    this.release(reservation);
    const superseded = this.toSupersede(session.tenantId, session.listenerUserId);
    this.sessions.set(session.listenId, session);
    trackListenSessionsActive(this.sessions.size);
    for (const old of superseded) {
      log.info({ listenId: old.listenId, by: session.listenId }, 'Listen superseded by the same supervisor\'s new listen');
      void old.end('superseded').catch(() => {});
    }
    return superseded;
  }

  /** The session ended (its socket calls this once). */
  remove(listenId: string): void {
    if (this.sessions.delete(listenId)) trackListenSessionsActive(this.sessions.size);
  }

  /**
   * End exactly these sessions for `reason`, those that are open here (a supersede decided in
   * another process, `listen.revoke` over IPC). Answers how many it ended.
   */
  async endSessions(listenIds: readonly string[], reason: AgencyListenEndReason): Promise<number> {
    const hits = listenIds.map((id) => this.sessions.get(id)).filter((s): s is ListenSessionHandle => s !== undefined);
    await Promise.all(hits.map((s) => s.end(reason).catch(() => {})));
    return hits.length;
  }

  /**
   * LS10's immediate path: re-check one supervisor's sessions in the tenant now, against the
   * database, and end those that fail `permission_revoked`. A role change that leaves them able
   * to listen (a promotion, another membership that still clears the floor) ends nothing.
   * Answers how many it ended.
   */
  async revokeUser(tenantId: string, userId: string): Promise<number> {
    const theirs = [...this.sessions.values()].filter((s) => s.tenantId === tenantId && s.listenerUserId === userId);
    if (theirs.length === 0) return 0;
    return this.endFailing(theirs, 'revoke');
  }

  /** The backstop: re-check every session now. One pass at a time. */
  async recheck(): Promise<number> {
    if (this.rechecking) {
      await this.rechecking;
      return 0;
    }
    let ended = 0;
    const pass = (async () => {
      const open = [...this.sessions.values()];
      if (open.length > 0) ended = await this.endFailing(open, 'recheck');
    })();
    this.rechecking = pass;
    try {
      await pass;
    } finally {
      this.rechecking = null;
    }
    return ended;
  }

  private async endFailing(sessions: readonly ListenSessionHandle[], why: 'revoke' | 'recheck'): Promise<number> {
    let failing: Set<string>;
    try {
      failing = await this.deps.access(sessions);
    } catch (err) {
      log.warn({ err, why, sessions: sessions.length }, 'Listen access could not be re-checked — keeping the sessions until the next pass');
      return 0;
    }
    const hits = sessions.filter((s) => failing.has(s.listenId) && this.sessions.get(s.listenId) === s);
    for (const s of hits) log.info({ listenId: s.listenId, callId: s.callId, why }, 'Listen permission revoked');
    await Promise.all(hits.map((s) => s.end('permission_revoked').catch(() => {})));
    return hits.length;
  }

  /** Arm the periodic re-check (idempotent). Unref'd: it never holds the process open. */
  start(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => { void this.recheck(); }, this.deps.limits.recheckMs);
    this.timer.unref?.();
  }

  /** Stop the re-check timer (the sessions stay: {@link shutdown} ends them). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The process is stopping: no new session, and every open one ends `server_shutdown` (its row
   * closed) before this resolves. Idempotent.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.stop();
    this.reservations.clear();
    const open = [...this.sessions.values()];
    await Promise.all(open.map((s) => s.end('server_shutdown').catch(() => {})));
  }
}
