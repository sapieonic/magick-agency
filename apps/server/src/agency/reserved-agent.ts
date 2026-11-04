/**
 * What every dial path that reserves an agent before its attempt exists shares: the marker the
 * reservation holds, and how a reserved agent that was not dialled goes back.
 *
 * The paths: the pacing tick (`pacing-engine.ts`, and its media-worker twin, the
 * `agent.return_reserved` handler in `cluster/media-child.ts`), the agent's dial of one of their
 * own contacts (`my-contact-call.ts`) and the wrap-up redial (`wrapup-redial.ts`, which uses
 * only the marker: its agent goes back to `wrapup`, not to the pool).
 *
 * A leaf: types only from the modules it names, so any of them can import it without a cycle.
 */
import type { AgencyDialer } from './agency-dialer.js';

/**
 * Written into the agent's Redis hash between reservation and dial.
 *
 * There is no attempt yet at reservation time — that is the whole point of reserving first —
 * and `executeDial` overwrites this with the real attempt id. A marker rather than a
 * synthesized id so anyone reading the hash mid-dial can tell "reserved, attempt not created
 * yet" from "an attempt id we lost track of".
 */
export const RESERVING_MARKER = 'reserving';

/** A break (or a switch to the soft phone) queued while the agent was reserved, and its release. */
export interface QueuedBreakRelease {
  hasQueuedBreak(sessionId: string): boolean;
  release(sessionId: string): Promise<unknown>;
}

/**
 * The queued-break release over the runtime's pieces: a break queued in `breaks` is applied by
 * `dialer.releaseAgent`, the single place a queued break is applied (`break`, mirrored, with its
 * `agent_state` frame).
 */
export function queuedBreakReleaseOf(deps: {
  breaks: { peek(sessionId: string): unknown };
  dialer: Pick<AgencyDialer, 'releaseAgent'>;
}): QueuedBreakRelease {
  return {
    hasQueuedBreak: (sessionId) => deps.breaks.peek(sessionId) !== null,
    release: (sessionId) => deps.dialer.releaseAgent(sessionId),
  };
}

/**
 * Hand a reserved agent that was not dialled back: to the break they queued meanwhile, through
 * `queuedBreak` (none registered: no break can be queued), else to the pool by `toPool`, the
 * caller's own write (the tick's unconditional `available`, or a CAS from `reserved`).
 */
export async function returnReservedAgent(
  sessionId: string,
  queuedBreak: QueuedBreakRelease | null,
  toPool: (sessionId: string) => Promise<unknown>,
): Promise<void> {
  if (queuedBreak?.hasQueuedBreak(sessionId)) {
    await queuedBreak.release(sessionId);
    return;
  }
  await toPool(sessionId);
}
