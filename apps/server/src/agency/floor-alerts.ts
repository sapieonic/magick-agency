/**
 * The supervisors' alerts (agent station AS16: BE-10 Need help, AS12 break over time, BE-11 an agent
 * whose station went), judged from what the alerts read gathered (`api/routes/agency/floor.ts`,
 * `GET /floor/alerts`): pure, so the rules and the ids are unit tested on their own.
 *
 *  - `help`: every open Need help request the read found (the repository applied the open rule).
 *  - `break_over`: a session on a break whose reason has a limit of its own (`floorBreak`: the
 *    floor's `break_limit_minutes`; a reserved break, the soft phone and a reason with no limit
 *    never alert) and has run PAST it (strictly: at the limit itself it is not over).
 *  - `disconnected`: a session whose station went at least `AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS`
 *    ago (the in-memory detach time), is still gone (the registry's liveness says `false`; unknown
 *    never alerts), and was working when it went: its state, or for a row the close wrote `offline`
 *    the state it left, is `available`, `reserved`, `on_call` or `wrapup` (never a break, so an app
 *    paused in the background on `device_away` never alerts).
 *
 * **Ids** follow the contract's recipe (`AgencyFloorAlertBase.id`): the kind, the session and the
 * instant the condition began (the raise, the break's start, the detach), so the same condition
 * keeps its id from poll to poll (the console chimes once) and a second break or drop of the same
 * agent is a new alert. Oldest `since` first, then by id.
 */
import {
  AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS,
  type AgencyFloorAlert,
} from '@magick-agency/contracts/api/agency/floor';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';
import type { FloorAlertHelpRow, FloorAlertSessionRow } from '../db/repositories/agency.repository.js';
import { floorBreak } from './floor.js';
import { toSessionHelp } from './floor-assist.js';

/** An alert as the internal handler answers it: everything but the agent's name (the public layer's). */
export type CoreFloorAlert = AgencyFloorAlert extends infer A ? (A extends unknown ? Omit<A, 'agent_name'> : never) : never;

/** The states an agent works in: a station going in one of them is a `disconnected` alert. */
const WORKING_STATES: ReadonlySet<AgencyAgentState> = new Set(['available', 'reserved', 'on_call', 'wrapup']);

export interface FloorAlertsInput {
  help: readonly FloorAlertHelpRow[];
  sessions: readonly FloorAlertSessionRow[];
  /** When each session's station went (memory: `StationDetachTimes`). */
  disconnectedSince: ReadonlyMap<string, Date>;
  /** Whether each session's station is held (`connectedBySession`); null when it could not be read. */
  connected: ReadonlyMap<string, boolean> | null;
  /** The call each disconnected session is on, if any. */
  callIds?: ReadonlyMap<string, string | null>;
  now: Date;
}

/** The working state of a session whose station went: its own, or for a row written `offline` by the close, the one it left. */
export function stateWhenStationWent(row: Pick<FloorAlertSessionRow, 'state' | 'left_state'>): AgencyAgentState | null {
  const state = row.state === 'offline' ? row.left_state : row.state;
  return state && WORKING_STATES.has(state) ? state : null;
}

/** Whether a session's station has been gone long enough, still gone, and went while working: the `disconnected` rule. */
export function isDisconnectedAlert(
  row: Pick<FloorAlertSessionRow, 'session_id' | 'state' | 'left_state'>,
  since: Date | undefined,
  connected: ReadonlyMap<string, boolean> | null,
  now: Date,
): boolean {
  if (!since || connected?.get(row.session_id) !== false) return false;
  if (now.getTime() - since.getTime() < AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS) return false;
  return stateWhenStationWent(row) !== null;
}

/** The sessions the alerts read must ask the database about: their station went at least the threshold ago. */
export function goneLongEnough(disconnectedSince: ReadonlyMap<string, Date>, now: Date): string[] {
  const out: string[] = [];
  for (const [id, since] of disconnectedSince) {
    if (now.getTime() - since.getTime() >= AGENCY_FLOOR_DISCONNECTED_ALERT_AFTER_MS) out.push(id);
  }
  return out;
}

export function buildFloorAlerts(input: FloorAlertsInput): CoreFloorAlert[] {
  const alerts: CoreFloorAlert[] = [];
  for (const h of input.help) {
    const help = toSessionHelp(h);
    alerts.push({
      id: `help:${h.session_id}:${help.raised_at}`,
      kind: 'help',
      session_id: h.session_id,
      agent_user_id: h.agent_user_id,
      campaign_id: h.campaign_id,
      campaign_name: h.campaign_name,
      since: help.raised_at,
      help,
    });
  }
  for (const s of input.sessions) {
    if (s.state === 'break' && s.break_reason) {
      const { label, limit_minutes } = floorBreak(s.break_reason, s.break_reasons);
      const started = new Date(s.state_since);
      if (limit_minutes !== null) {
        const overAt = new Date(started.getTime() + limit_minutes * 60_000);
        if (input.now.getTime() > overAt.getTime()) {
          alerts.push({
            id: `break_over:${s.session_id}:${started.toISOString()}`,
            kind: 'break_over',
            session_id: s.session_id,
            agent_user_id: s.agent_user_id,
            campaign_id: s.campaign_id,
            campaign_name: s.campaign_name,
            since: overAt.toISOString(),
            break_reason: s.break_reason,
            break_label: label,
            limit_minutes,
            break_started_at: started.toISOString(),
          });
        }
      }
    }
    const since = input.disconnectedSince.get(s.session_id);
    if (isDisconnectedAlert(s, since, input.connected, input.now)) {
      alerts.push({
        id: `disconnected:${s.session_id}:${since!.toISOString()}`,
        kind: 'disconnected',
        session_id: s.session_id,
        agent_user_id: s.agent_user_id,
        campaign_id: s.campaign_id,
        campaign_name: s.campaign_name,
        since: since!.toISOString(),
        state: stateWhenStationWent(s)!,
        client_kind: s.client_kind,
        call_id: input.callIds?.get(s.session_id) ?? null,
      });
    }
  }
  return alerts.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
