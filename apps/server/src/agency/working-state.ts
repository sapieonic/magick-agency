/**
 * Whether an agent is working, as a dropped station is judged (agent station BE-11): the supervisors'
 * `disconnected` alert (`floor-alerts.ts`) and the station-drop metric (`agency_station_disconnects_total`,
 * counted by the station socket's close) read the one rule. Pure, a leaf.
 */
import type { AgencyAgentState } from '@magick-agency/contracts/agency';

/** The states an agent works in, and `break` for the soft phone's live call. */
export type WorkingState = 'available' | 'reserved' | 'on_call' | 'wrapup' | 'break';

const WORKING_STATES: ReadonlySet<string> = new Set(['available', 'reserved', 'on_call', 'wrapup']);

/**
 * The agent in `state` is working: `available`, `reserved`, `on_call` or `wrapup`; or `break` while
 * a soft-phone call is live (the soft phone's presence state is `break`/`soft_phone`, so its calls
 * are made on a break). The state, or null when not working (any other break, `offline`, unknown).
 */
export function workingState(state: AgencyAgentState | null | undefined, softPhoneCallLive: boolean): WorkingState | null {
  if (!state) return null;
  if (WORKING_STATES.has(state)) return state as WorkingState;
  return state === 'break' && softPhoneCallLive ? 'break' : null;
}
