import type { AgencyRingOffReason } from '@magick-agency/contracts/agency';

/*
 * What ending a session shares, whoever ends it: the agent's Leave and OS7's end of an idle session
 * in another tenant (`leaveSession`, `endIdleSessionElsewhere` in `api/routes/agency/helpers.ts`),
 * and the idle-session sweep (OS9, `idle-session-sweep.ts`).
 */

/** The part of the runtime ending a session reads: the agent's own `leave`'s signals, station presence across processes. */
export interface SessionEndRuntime {
  stations: {
    stationPresence(sessionId: string): Promise<'connected' | 'absent' | 'unknown'>;
    detach(sessionId: string): Promise<unknown> | unknown;
    /** Agent station (BE-11): the session ended; forget when its station went. */
    sessionEnded(sessionId: string): void;
  };
  /** The floor's reader of the detach times, when it is not `stations` (the primary's directory). Optional for tests. */
  stationDisconnects?: { forgetEnded(sessionIds: readonly string[]): void };
  agents: {
    get(sessionId: string): Promise<{ state: string; ring?: boolean } | null>;
    clear(sessionId: string): Promise<unknown>;
  };
  dialer: { hasLiveAttempt(sessionId: string): boolean; hasRedialInFlight(sessionId: string): boolean };
  softphone: { hasLiveCall(sessionId: string): boolean };
  /** Read on every call: the runtime sets it after it is built. */
  inbound?: { findCallForSession(sessionId: string): unknown } | null;
  /** Mode B: the `ring_off` push to a phone whose away break the end cut short. */
  awayRing?: {
    sendRingOff(agentUserId: string, deviceId: string | null, sessionId: string, reason: AgencyRingOffReason, awaySince: Date | null): void;
  };
  /** Floor assist (LF4): the session's open Need help ends with it (`help_cleared { session_ended }`). Never throws. */
  floorAssist?: { endWithSession(sessionId: string): Promise<void> };
}

/**
 * OS7's rule for a session with nothing in it, but the lease (each caller has its own rule for
 * that): no live attempt, redial being set up, soft-phone call or inbound call, and no station
 * attached in any process (`unknown` keeps the session).
 */
export async function nothingInFlight(
  runtime: { stations: Pick<SessionEndRuntime['stations'], 'stationPresence'> }
    & Pick<SessionEndRuntime, 'dialer' | 'softphone' | 'inbound'>,
  sessionId: string,
): Promise<boolean> {
  if (runtime.dialer.hasLiveAttempt(sessionId) || runtime.dialer.hasRedialInFlight(sessionId)) return false;
  if (runtime.softphone.hasLiveCall(sessionId) || runtime.inbound?.findCallForSession(sessionId)) return false;
  return (await runtime.stations.stationPresence(sessionId)) === 'absent';
}

/**
 * What every end of a session does once its row is left: its open Need help ends (LF4, before the
 * detach, so a station still attached hears `help_cleared { session_ended }`), the station is
 * detached, and when it went is forgotten (BE-11: here, the primary's directory over IPC from a
 * media worker, and the floor's reader when it is not this process's registry).
 */
export async function afterSessionLeft(
  runtime: { stations: Pick<SessionEndRuntime['stations'], 'detach' | 'sessionEnded'> }
    & Pick<SessionEndRuntime, 'stationDisconnects' | 'floorAssist'>,
  sessionId: string,
): Promise<void> {
  await runtime.floorAssist?.endWithSession(sessionId);
  await runtime.stations.detach(sessionId);
  runtime.stations.sessionEnded(sessionId);
  runtime.stationDisconnects?.forgetEnded([sessionId]);
}
