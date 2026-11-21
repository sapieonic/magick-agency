import { createChildLogger } from '@magick-agency/observability';
import {
  agencyAgentSessionRepository,
  type AgencyIdleOfflineSession,
} from '../db/repositories/agency.repository.js';

const log = createChildLogger({ component: 'agency-idle-session-sweep' });

/*
 * OS9: a session forgotten offline is ended.
 *
 * A session stays open until the agent presses Leave (or joins in another tenant, OS7). An agent
 * who closes the laptop, kills the tab or loses the network goes `offline` (the station's close),
 * and nothing else ever ended the session: Live floor showed them as a red "Connection lost" card
 * with a clock counting up for days. This sweep ends a session that has been `offline` for
 * {@link IDLE_SESSION_END_AFTER_MS} with nothing in it, exactly as Leave ends it.
 *
 * What counts as "nothing in it" is OS7's rule (`endIdleSessionElsewhere`): no station attached in
 * any process (`stationPresence` is `absent`; `unknown` keeps the session), a lease that is
 * `offline` or gone (a `break` with `ring` is Mode B's away-ring, ended by its own reconcile), and
 * no live attempt, redial being set up, soft-phone call or inbound call. The row's own guard
 * (`leaveIdle`: still `offline`, for long enough, under the row lock) runs last, so an agent who
 * rejoined or whose station came back since the read keeps the session.
 *
 * Once per deployment, in the primary (`bootstrap/agency.ts`), as OS7 runs there: the station
 * presence is the Redis ownership key, which every process writes.
 */

/** How long a session must have been offline, with nothing in it, before the sweep ends it (OS9). */
export const IDLE_SESSION_END_AFTER_MS = 2 * 60 * 60 * 1000;

/** How often the sweep runs. An ended session is at most this much past the cutoff. */
export const IDLE_SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** At most this many sessions are ended per pass; the oldest first, the rest on the next pass. */
export const IDLE_SESSION_SWEEP_BATCH = 200;

/** What a session that just ended needs from the runtime, after its row is left. */
export interface SessionEndRuntime {
  stations: {
    detach(sessionId: string): Promise<unknown> | unknown;
    /** Agent station (BE-11): the session ended; forget when its station went. */
    sessionEnded(sessionId: string): void;
  };
  /** The floor's reader of the detach times, when it is not `stations` (the primary's directory). */
  stationDisconnects?: { forgetEnded(sessionIds: readonly string[]): void };
  /** Floor assist (LF4): the session's open Need help ends with it. Never throws. */
  floorAssist?: { endWithSession(sessionId: string): Promise<void> };
}

/**
 * What every end of a session does once its row is left: its open Need help ends (LF4, before the
 * detach, so a station still attached hears `help_cleared { session_ended }`), the station is
 * detached, and when it went is forgotten (BE-11). The agent's Leave and OS7 (`leaveSession`) and
 * this sweep share it.
 */
export async function afterSessionLeft(runtime: SessionEndRuntime, sessionId: string): Promise<void> {
  await runtime.floorAssist?.endWithSession(sessionId);
  await runtime.stations.detach(sessionId);
  runtime.stations.sessionEnded(sessionId);
  runtime.stationDisconnects?.forgetEnded([sessionId]);
}

/** What the sweep reads from the runtime: OS7's idle rule and the end's cleanup. */
export interface IdleSessionSweepRuntime extends SessionEndRuntime {
  stations: SessionEndRuntime['stations'] & {
    stationPresence(sessionId: string): Promise<'connected' | 'absent' | 'unknown'>;
  };
  agents: {
    get(sessionId: string): Promise<{ state: string; ring?: boolean } | null>;
    clear(sessionId: string): Promise<unknown>;
  };
  dialer: { hasLiveAttempt(sessionId: string): boolean; hasRedialInFlight(sessionId: string): boolean };
  softphone: { hasLiveCall(sessionId: string): boolean };
  /** Read on every candidate: the runtime sets it after it is built. */
  inbound?: { findCallForSession(sessionId: string): unknown } | null;
}

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
    if (this.inFlight) return this.inFlight;
    const pass = this.pass().finally(() => { this.inFlight = null; });
    this.inFlight = pass;
    return pass;
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
        log.warn({ err, sessionId: session.id }, 'Idle-session sweep could not end a session; the next pass will retry');
      }
    }
    if (ended > 0) log.info({ ended, candidates: candidates.length }, 'Idle-session sweep ended sessions forgotten offline (OS9)');
    return ended;
  }

  private async endIfIdle(session: AgencyIdleOfflineSession): Promise<boolean> {
    const { runtime } = this;
    const id = session.id;
    if (runtime.dialer.hasLiveAttempt(id) || runtime.dialer.hasRedialInFlight(id)) return false;
    if (runtime.softphone.hasLiveCall(id) || runtime.inbound?.findCallForSession(id)) return false;
    if ((await runtime.stations.stationPresence(id)) !== 'absent') return false;
    const lease = await runtime.agents.get(id);
    if (lease && (lease.state !== 'offline' || lease.ring === true)) return false;
    // The row first, under its own guard: a session that came back since the read is not touched,
    // its lease included (Leave clears the lease first because the agent asked; nobody asked here).
    if (!(await this.repo.leaveIdle(id, this.idleMs))) return false;
    await runtime.agents.clear(id);
    await afterSessionLeft(runtime, id);
    log.info({
      sessionId: id, tenantId: session.tenant_id, accountId: session.account_id,
      agentUserId: session.agent_user_id, offlineSince: session.offline_since,
    }, 'Ended a session forgotten offline (OS9)');
    return true;
  }
}
