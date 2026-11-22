import { createChildLogger } from '@magick-agency/observability';
import {
  agencyAgentSessionRepository,
  type AgencyIdleOfflineSession,
} from '../db/repositories/agency.repository.js';
import { afterSessionLeft, nothingInFlight, type SessionEndRuntime } from './session-end.js';

const log = createChildLogger({ component: 'agency-idle-session-sweep' });

/*
 * OS9: a session forgotten offline is ended.
 *
 * Before OS9 a session stayed open until the agent pressed Leave (or joined in another tenant,
 * OS7). An agent who closed the laptop, killed the tab or lost the network went `offline` (the
 * station's close), and nothing else ended the session: Live floor showed them as a red "Connection
 * lost" card with a clock counting up for days. This sweep ends a session that has been `offline`
 * for {@link IDLE_SESSION_END_AFTER_MS} with nothing in it, as Leave ends it.
 *
 * ── What keeps a session ─────────────────────────────────────────────────────
 * The row's rule (`findIdleOffline`, re-checked by `leaveIdle` under the row lock), then OS7's
 * (`nothingInFlight`, `session-end.ts`), and a lease `offline` or gone, never Mode B's `ring`.
 *
 * With media workers the sweep runs in the primary, whose dialer and soft phone hold nothing, so
 * `nothingInFlight`'s call checks answer "none" there and only matter in one process. What protects a working
 * session is the rest: a station's close never writes `offline` while its process holds a live
 * attempt or call (`releaseStationOnClose`), the ownership key, and the two hours.
 *
 * ── The one race it shares with Leave and OS7 ────────────────────────────────
 * A station attaching in the instant between the presence read and the row's end (the attach checks
 * `left_at`, then claims the key, then rehydrates) can lose the session: the station is detached or
 * closed (4404 on its next ping with media workers) and the client says the session ended, as it
 * does after a Leave from another device. A rejoin cannot: the join upsert takes the same row lock.
 *
 * Once per deployment, in the primary (`bootstrap/agency.ts`), as OS7 runs there.
 */

/** How long a session must have been offline, with nothing in it, before the sweep ends it (OS9). */
export const IDLE_SESSION_END_AFTER_MS = 2 * 60 * 60 * 1000;

/** How often the sweep runs. An ended session is at most this much past the cutoff. */
export const IDLE_SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** At most this many sessions are ended per pass; the oldest first, the rest on the next pass. */
export const IDLE_SESSION_SWEEP_BATCH = 200;

/** What the sweep reads from the runtime: all of ending a session but Mode B's `ring_off` (it never ends an away-ring). */
export type IdleSessionSweepRuntime = Omit<SessionEndRuntime, 'awayRing'>;

/** The two statements the sweep runs. */
export interface IdleSessionSweepRepo {
  findIdleOffline(idleMs: number, limit: number): Promise<AgencyIdleOfflineSession[]>;
  leaveIdle(id: string, idleMs: number): Promise<boolean>;
}

export interface IdleSessionSweepOptions {
  idleMs?: number;
  batch?: number;
}

export class IdleSessionSweep {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<number> | null = null;
  private readonly idleMs: number;
  private readonly batch: number;

  constructor(
    private readonly runtime: IdleSessionSweepRuntime,
    private readonly repo: IdleSessionSweepRepo = agencyAgentSessionRepository,
    options: IdleSessionSweepOptions = {},
  ) {
    this.idleMs = options.idleMs ?? IDLE_SESSION_END_AFTER_MS;
    this.batch = options.batch ?? IDLE_SESSION_SWEEP_BATCH;
  }

  /**
   * One pass: how many sessions it ended. A pass already running is answered by that pass, so two
   * never overlap. Never throws: a candidate that fails is logged and left for the next pass.
   */
  sweep(): Promise<number> {
    this.inFlight ??= this.pass().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  start(intervalMs: number = IDLE_SESSION_SWEEP_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, intervalMs);
    this.timer.unref?.();
  }

  /** No new pass from here; resolves when the pass in flight, if any, has finished. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  private async pass(): Promise<number> {
    let candidates: AgencyIdleOfflineSession[];
    try {
      candidates = await this.repo.findIdleOffline(this.idleMs, this.batch);
    } catch (err) {
      log.warn({ err }, 'Idle-session sweep could not read its candidates; the next pass will retry');
      return 0;
    }
    let ended = 0;
    for (const session of candidates) {
      try {
        if (await this.endIfIdle(session)) ended += 1;
      } catch (err) {
        log.warn({ err, sessionId: session.id }, 'Idle-session sweep could not end a session; the next pass will try again');
      }
    }
    if (ended > 0) log.info({ ended, candidates: candidates.length }, 'Idle-session sweep ended sessions forgotten offline (OS9)');
    return ended;
  }

  private async endIfIdle(session: AgencyIdleOfflineSession): Promise<boolean> {
    const { runtime } = this;
    const id = session.id;
    if (!(await nothingInFlight(runtime, id))) return false;
    const lease = await runtime.agents.get(id);
    if (lease && (lease.state !== 'offline' || lease.ring === true)) return false;
    // The row first, under its own guard: a session that came back since the read is not touched,
    // its lease included (Leave clears the lease first because the agent asked; nobody asked here).
    if (!(await this.repo.leaveIdle(id, this.idleMs))) return false;
    // The session has ended, and no later pass will find it again: each step from here runs on its
    // own, so a Redis that fails the lease's clear still detaches the station. What one leaves
    // behind lapses on its own (the lease's TTL, the Need help expiry, the detach time's bound).
    await this.step('clear the lease', id, () => runtime.agents.clear(id));
    await this.step('finish the end', id, () => afterSessionLeft(runtime, id));
    log.info({
      sessionId: id, tenantId: session.tenant_id, accountId: session.account_id,
      agentUserId: session.agent_user_id, offlineSince: session.offline_since,
    }, 'Ended a session forgotten offline (OS9)');
    return true;
  }

  private async step(what: string, sessionId: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (err) {
      log.warn({ err, sessionId }, `Idle-session sweep ended a session but could not ${what}; it lapses on its own`);
    }
  }
}
