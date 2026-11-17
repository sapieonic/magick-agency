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
 * (an upgrade between its reservation and its admission, across the access check, the row and the
 * tap), so two upgrades racing one slot cannot both pass. A supervisor's own sessions that the new one would supersede do not count against the
 * per-call cap: a console reconnecting to the call it was on is not refused by its own stale
 * session.
 *
 * ── Revocation (LS10, LS16 c, d, LS21, LS22) ─────────────────────────────────
 * {@link revokeUser} re-checks one supervisor's sessions now; {@link recheck} re-checks every
 * session every `recheckMs`. Both read the DATABASE through {@link ListenAccessCheck} (the
 * membership floor and the two flags), never the membership cache, and end what fails
 * `permission_revoked`. A check that cannot be made is not a "no", and ends a session
 * `access_unverified` (the console says access could not be checked and offers Try again):
 *  - the immediate path ({@link revokeUser}, a role change or a removal) fails CLOSED: what it
 *    could not check ends at once (the supervisor can ask again; the grant and the upgrade check
 *    again);
 *  - the periodic pass fails OPEN, under a staleness cap: a session keeps going while its checks
 *    fail, until it has gone {@link STALE_AFTER_RECHECKS} × `recheckMs` without a successful one.
 * The upgrade asks too, before the row ({@link verify}: no answer, no listen), and a per-supervisor
 * revocation generation, bumped by every {@link revokeUser}, covers what is between a grant and its
 * session: the grant records it in the token and the reservation records it again, and a
 * reservation (or a token) from before a revocation is refused, at {@link reserve} or at
 * {@link admit}, however the database answered in between.
 *
 * ── The rows ─────────────────────────────────────────────────────────────────
 * Each re-check tick also hands `maintainRows` (`listen-rows.ts`) a getter of the ids this registry
 * holds (sessions and reservations), read when the sweep runs rather than when the tick began: a
 * session row whose close failed is closed again, and a row of this process held by nothing here
 * is closed as lost. One tick at a time: a tick that finds the last one still running (a hung
 * read) applies only the staleness cap.
 */

/** What the access check asks about: one supervisor listening (or about to) in one account. */
export interface ListenAccessSubject {
  readonly listenId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly listenerUserId: string;
  /** The call's `recording_requested` (LS4: the unrecorded flag matters only when false). */
  readonly recording: boolean;
}

/** One open listen session, as the socket presents it to the registry. */
export interface ListenSessionHandle extends ListenAccessSubject {
  readonly callId: string;
  /** Epoch ms the session was admitted. */
  readonly startedAt: number;
  /** End the session for `reason` (idempotent). Resolves once its row is closed. */
  end(reason: AgencyListenEndReason): Promise<void>;
}

/**
 * The access check's answer: the listen ids that may no longer go on (`revoked`), and those it
 * could not decide because a read failed (`unchecked`). Every other id passed.
 */
export interface ListenAccessVerdict {
  revoked: Set<string>;
  unchecked: Set<string>;
}

/** Who may keep listening (`listen-access.ts` in production). May also reject: all unchecked. */
export type ListenAccessCheck = (subjects: readonly ListenAccessSubject[]) => Promise<ListenAccessVerdict>;

/**
 * The periodic pass ends a session not verified for this many `recheckMs`, `access_unverified`
 * (LS16 d, LS21: 2, so 60 s at the default 30 s re-check).
 */
export const STALE_AFTER_RECHECKS = 2;

/** How many supervisors' revocation generations a registry remembers (the oldest are forgotten). */
const MAX_GENERATIONS = 10_000;

export interface ListenLimits {
  maxPerCall: number;
  maxPerProcess: number;
  maxPerUser: number;
  recheckMs: number;
}

/** A slot held for an upgrade between its reservation and its admission ({@link ListenRegistry.reserve}). */
export interface ListenReservation {
  readonly listenId: string;
  readonly callId: string;
  readonly tenantId: string;
  readonly listenerUserId: string;
  /** The supervisor's revocation generation when the slot was reserved ({@link ListenRegistry.admit}). */
  readonly generation: number;
}

/**
 * Why a listen cannot be admitted here: the contract's codes (`errors.ts` §7). A stopping process
 * is `listen_unavailable` (try again: a fresh grant reaches whichever process owns the call), not
 * the server's limit.
 */
export type ListenAdmissionRefusal = 'listen_limit_call' | 'listen_limit_server' | 'listen_unavailable';

/** What {@link ListenRegistry.reserve} takes: the slot, and the generation the grant was minted at. */
export interface ListenReserveInput {
  readonly listenId: string;
  readonly callId: string;
  readonly tenantId: string;
  readonly listenerUserId: string;
  /** {@link ListenRegistry.generation} when the grant was minted; absent: not checked. */
  readonly grantGeneration?: number;
}

export interface ListenRegistryDeps {
  limits: ListenLimits;
  /** The re-check's question (`listen-access.ts` in production). */
  access: ListenAccessCheck;
  /**
   * Each re-check tick, after the pass: the session rows' upkeep (`ListenRowKeeper.maintain`), with
   * a getter of the listen ids this registry holds (open sessions and reservations), so the sweep
   * reads them when it runs, after any retries. Absent: nothing.
   */
  maintainRows?: (held: () => ReadonlySet<string>) => Promise<unknown>;
  now?: () => number;
}

export class ListenRegistry {
  private readonly sessions = new Map<string, ListenSessionHandle>();
  private readonly reservations = new Map<string, ListenReservation>();
  /** Reservations another process superseded before they were admitted ({@link endSessions}, LS22 s). */
  private readonly supersededReservations = new Set<string>();
  /** Epoch ms of each open session's last successful access check (its admission's, at first). */
  private readonly verifiedAt = new Map<string, number>();
  /** Each supervisor's revocation generation (`tenant:user`), bumped by {@link revokeUser}. */
  private readonly generations = new Map<string, number>();
  private generationCounter = 0;
  private timer: NodeJS.Timeout | null = null;
  private rechecking: Promise<void> | null = null;
  /** A timer tick (the pass and the rows' upkeep) is running. */
  private ticking = false;
  private stopping = false;

  constructor(private readonly deps: ListenRegistryDeps) {}

  get limits(): ListenLimits {
    return this.deps.limits;
  }

  /** Sessions open now. */
  get size(): number {
    return this.sessions.size;
  }

  get(listenId: string): ListenSessionHandle | undefined {
    return this.sessions.get(listenId);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The ids this registry holds: its open sessions and its reservations. */
  held(): Set<string> {
    return new Set([...this.sessions.keys(), ...this.reservations.keys()]);
  }

  /**
   * The supervisor's revocation generation in the tenant: 0 until their first {@link revokeUser}
   * here, then a value no earlier generation had. A grant records it; an upgrade whose grant or
   * reservation is from an earlier generation is refused.
   */
  generation(tenantId: string, userId: string): number {
    return this.generations.get(`${tenantId}:${userId}`) ?? 0;
  }

  private bumpGeneration(tenantId: string, userId: string): void {
    const key = `${tenantId}:${userId}`;
    // Re-inserted so the map's order is the bump order; the oldest is forgotten past the bound.
    // Forgetting answers 0 again, so a grant minted before that supervisor's FIRST revocation here
    // (which recorded 0) would pass the generation check if the entry were forgotten within the
    // token's TTL (10,000 other supervisors' revocations in 60 s). Not a hole: the upgrade's
    // database check (`verify`, LS16 n) is the backstop and refuses a supervisor who may no longer
    // listen; the generation only closes the window between the grant and that check.
    this.generations.delete(key);
    this.generations.set(key, ++this.generationCounter);
    if (this.generations.size > MAX_GENERATIONS) {
      const oldest = this.generations.keys().next().value;
      if (oldest !== undefined) this.generations.delete(oldest);
    }
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
    if (this.stopping) return 'listen_unavailable';
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

  /**
   * Hold a slot for an upgrade (synchronous: nothing can interleave with the count). Refused
   * `permission_revoked` when the grant was minted before the supervisor's latest revocation here.
   */
  reserve(input: ListenReserveInput):
    | { ok: true; reservation: ListenReservation }
    | { ok: false; code: ListenAdmissionRefusal | 'permission_revoked' } {
    const generation = this.generation(input.tenantId, input.listenerUserId);
    if (input.grantGeneration !== undefined && input.grantGeneration !== generation) {
      return { ok: false, code: 'permission_revoked' };
    }
    const refused = this.check(input.callId, input.tenantId, input.listenerUserId);
    if (refused) return { ok: false, code: refused };
    const reservation: ListenReservation = {
      listenId: input.listenId, callId: input.callId, tenantId: input.tenantId, listenerUserId: input.listenerUserId, generation,
    };
    this.reservations.set(input.listenId, reservation);
    return { ok: true, reservation };
  }

  /** Give a slot back: the upgrade failed before its session opened. */
  release(reservation: ListenReservation): void {
    if (this.reservations.get(reservation.listenId) === reservation) {
      this.reservations.delete(reservation.listenId);
      this.supersededReservations.delete(reservation.listenId);
    }
  }

  /**
   * The upgrade's access check (LS16 n): may this supervisor listen in this account now, asked of
   * the database? `unchecked` when it could not be answered (the upgrade refuses: no answer, no
   * listen). Never throws.
   */
  async verify(subject: ListenAccessSubject): Promise<'ok' | 'revoked' | 'unchecked'> {
    try {
      const verdict = await this.deps.access([subject]);
      if (verdict.revoked.has(subject.listenId)) return 'revoked';
      if (verdict.unchecked.has(subject.listenId)) return 'unchecked';
      return 'ok';
    } catch (err) {
      log.warn({ err, listenId: subject.listenId }, 'Listen access could not be checked at the upgrade');
      return 'unchecked';
    }
  }

  /**
   * Turn a reservation into an open session, ending the supervisor's older sessions past
   * `maxPerUser` (`superseded`). Refused (the slot given back, nothing ended) when the supervisor
   * was revoked here since the reservation (`permission_revoked`), or when another process
   * superseded it while it was being admitted (`superseded`, LS22 s): the caller ends the session
   * for that reason.
   */
  admit(reservation: ListenReservation, session: ListenSessionHandle):
    | { ok: true; superseded: ListenSessionHandle[] }
    | { ok: false; reason: 'permission_revoked' | 'superseded' } {
    const supersededElsewhere = this.reservations.get(reservation.listenId) === reservation
      && this.supersededReservations.has(reservation.listenId);
    this.release(reservation);
    if (this.generation(reservation.tenantId, reservation.listenerUserId) !== reservation.generation) {
      log.info({ listenId: session.listenId }, 'Listen upgrade refused: the supervisor was revoked while it was admitted');
      return { ok: false, reason: 'permission_revoked' };
    }
    if (supersededElsewhere) {
      log.info({ listenId: session.listenId }, 'Listen upgrade refused: the supervisor\'s newer listen elsewhere superseded it while it was admitted');
      return { ok: false, reason: 'superseded' };
    }
    const superseded = this.toSupersede(session.tenantId, session.listenerUserId);
    this.sessions.set(session.listenId, session);
    this.verifiedAt.set(session.listenId, this.now());
    trackListenSessionsActive(this.sessions.size);
    for (const old of superseded) {
      log.info({ listenId: old.listenId, by: session.listenId }, 'Listen superseded by the same supervisor\'s new listen');
      void old.end('superseded').catch(() => {});
    }
    return { ok: true, superseded };
  }

  /** The session ended (its socket calls this once). */
  remove(listenId: string): void {
    this.verifiedAt.delete(listenId);
    if (this.sessions.delete(listenId)) trackListenSessionsActive(this.sessions.size);
  }

  /**
   * End exactly these sessions for `reason`, those that are open here (a supersede decided in
   * another process, `listen.revoke` over IPC). A named listen still in its upgrade here (its row
   * written, which is how the other process read it, not yet admitted) is marked instead, and its
   * admission refuses it (LS22 s): otherwise it would be admitted after the supersede had passed
   * it by, and the supervisor would hold two listens. Answers how many it ended or marked.
   */
  async endSessions(listenIds: readonly string[], reason: AgencyListenEndReason): Promise<number> {
    let marked = 0;
    for (const id of listenIds) {
      if (reason === 'superseded' && !this.sessions.has(id) && this.reservations.has(id)) {
        this.supersededReservations.add(id);
        marked++;
      }
    }
    const hits = listenIds.map((id) => this.sessions.get(id)).filter((s): s is ListenSessionHandle => s !== undefined);
    await Promise.all(hits.map((s) => s.end(reason).catch(() => {})));
    return hits.length + marked;
  }

  /**
   * LS10's immediate path: re-check one supervisor's sessions in the tenant now, against the
   * database, and end those that fail `permission_revoked`. A role change that leaves them able
   * to listen (a promotion, another membership that still clears the floor) ends nothing. Fails
   * CLOSED (LS16 c): a session the check could not decide ends too, `access_unverified` (LS22: no
   * read said they may not listen). Bumps the supervisor's
   * revocation generation first, so a grant or a reservation of theirs from before this call is
   * refused, whatever the database answers. Answers how many it ended.
   */
  async revokeUser(tenantId: string, userId: string): Promise<number> {
    this.bumpGeneration(tenantId, userId);
    const theirs = [...this.sessions.values()].filter((s) => s.tenantId === tenantId && s.listenerUserId === userId);
    if (theirs.length === 0) return 0;
    const verdict = await this.ask(theirs, 'revoke');
    const unverified = new Set([...verdict.unchecked].filter((id) => !verdict.revoked.has(id)));
    const [revoked, unchecked] = await Promise.all([
      this.endRevoked(theirs, verdict.revoked, 'revoke'),
      this.endUnverified(theirs, unverified, 'revoke'),
    ]);
    return revoked + unchecked;
  }

  /**
   * The backstop: re-check every session now. One pass at a time; a call that finds a pass still
   * running applies the staleness cap to what it has and waits for the pass. Fails OPEN
   * (LS16 d): a session its check could not decide keeps going, until it has gone
   * {@link STALE_AFTER_RECHECKS} × `recheckMs` without a successful check (`access_unverified`,
   * LS21). Answers how many it ended.
   */
  async recheck(): Promise<number> {
    if (this.rechecking) {
      const stale = await this.endStale();
      await this.rechecking;
      return stale;
    }
    let ended = 0;
    const pass = (async () => {
      const open = [...this.sessions.values()];
      if (open.length === 0) return;
      const verdict = await this.ask(open, 'recheck');
      const at = this.now();
      for (const s of open) {
        if (!verdict.revoked.has(s.listenId) && !verdict.unchecked.has(s.listenId) && this.sessions.get(s.listenId) === s) {
          this.verifiedAt.set(s.listenId, at);
        }
      }
      ended = await this.endRevoked(open, verdict.revoked, 'recheck');
      ended += await this.endStale();
    })();
    this.rechecking = pass;
    try {
      await pass;
    } finally {
      this.rechecking = null;
    }
    return ended;
  }

  /** The access check's verdict on `sessions`; a check that throws leaves every one unchecked. */
  private async ask(sessions: readonly ListenSessionHandle[], why: 'revoke' | 'recheck'): Promise<ListenAccessVerdict> {
    let verdict: ListenAccessVerdict;
    try {
      verdict = await this.deps.access(sessions);
    } catch (err) {
      verdict = { revoked: new Set(), unchecked: new Set(sessions.map((s) => s.listenId)) };
      log.warn({ err, why, sessions: sessions.length }, 'Listen access could not be re-checked');
      return verdict;
    }
    if (verdict.unchecked.size > 0) {
      log.warn({ why, unchecked: verdict.unchecked.size }, why === 'revoke'
        ? 'Listen access could not be checked on a revocation — ending what it could not check'
        : 'Listen access could not be re-checked — keeping the sessions until the staleness cap');
    }
    return verdict;
  }

  /** End `permission_revoked` those of `sessions` named in `ids` that are still open here. */
  private async endRevoked(sessions: readonly ListenSessionHandle[], ids: ReadonlySet<string>, why: 'revoke' | 'recheck'): Promise<number> {
    return this.endFor(sessions, ids, 'permission_revoked', why);
  }

  /** End `access_unverified` those of `sessions` named in `ids` that are still open here (LS21, LS22). */
  private async endUnverified(sessions: readonly ListenSessionHandle[], ids: ReadonlySet<string>, why: 'revoke' | 'stale'): Promise<number> {
    return this.endFor(sessions, ids, 'access_unverified', why);
  }

  private async endFor(
    sessions: readonly ListenSessionHandle[],
    ids: ReadonlySet<string>,
    reason: 'permission_revoked' | 'access_unverified',
    why: 'revoke' | 'recheck' | 'stale',
  ): Promise<number> {
    const hits = sessions.filter((s) => ids.has(s.listenId) && this.sessions.get(s.listenId) === s);
    for (const s of hits) {
      log.info({ listenId: s.listenId, callId: s.callId, why, reason }, reason === 'permission_revoked'
        ? 'Listen permission revoked'
        : 'Listen access could not be verified — ending the listen');
    }
    await Promise.all(hits.map((s) => s.end(reason).catch(() => {})));
    return hits.length;
  }

  /** End `access_unverified` the sessions not verified for {@link STALE_AFTER_RECHECKS} × `recheckMs` (LS16 d, LS21). */
  private async endStale(): Promise<number> {
    const cap = STALE_AFTER_RECHECKS * this.deps.limits.recheckMs;
    const at = this.now();
    const stale = [...this.sessions.values()].filter((s) => at - (this.verifiedAt.get(s.listenId) ?? s.startedAt) >= cap);
    if (stale.length === 0) return 0;
    log.warn({ sessions: stale.length, capMs: cap }, 'Listen access unverified past the staleness cap — ending the sessions');
    return this.endUnverified(stale, new Set(stale.map((s) => s.listenId)), 'stale');
  }

  /**
   * One timer tick: the re-check, then the rows' upkeep. Never rejects. A tick that finds the last
   * one still running (a read that hangs) starts no pass and no upkeep of its own, so hung ticks
   * never stack; it applies the staleness cap, which a hung pass must not hold off.
   */
  private async tick(): Promise<void> {
    if (this.ticking) {
      try { await this.endStale(); } catch (err) { log.warn({ err }, 'Listen staleness cap failed'); }
      return;
    }
    this.ticking = true;
    try {
      try {
        await this.recheck();
      } catch (err) {
        log.warn({ err }, 'Listen re-check failed');
      }
      if (this.stopping || !this.deps.maintainRows) return;
      try {
        await this.deps.maintainRows(() => this.held());
      } catch (err) {
        log.warn({ err }, 'Listen session rows upkeep failed');
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Arm the periodic re-check (idempotent). Unref'd: it never holds the process open. */
  start(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => { void this.tick(); }, this.deps.limits.recheckMs);
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
    this.supersededReservations.clear();
    const open = [...this.sessions.values()];
    await Promise.all(open.map((s) => s.end('server_shutdown').catch(() => {})));
  }
}
