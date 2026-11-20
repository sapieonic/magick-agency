import type { AgencyAgentState } from '../../types/agency';

/**
 * The agent's side of floor assist (LF4, LF5, LF24–LF26): Need help on the station, what it says
 * while a request is open and once it ends, and the words around a supervisor's message. Copy and
 * pure rules only; the flow is `pages/agency/station/useStationHelp`, the frames `useAgencyStation`.
 */

/** The agent states Need help may be raised in (LF13): on a call, or in its wrap-up. */
export function helpRaisable(agentState: AgencyAgentState): boolean {
  return agentState === 'on_call' || agentState === 'wrapup';
}

export const STATION_HELP_COPY = {
  raise: 'Need help',
  raising: 'Asking…',
  cancel: 'Cancel help request',
  cancelling: 'Cancelling…',
  /** Why the control does nothing now: the server's own `help_not_on_call` rule, said before asking. */
  notOnCall: 'You can ask for help during a call, or while you finish one.',
  open: 'Help requested. Waiting for a supervisor.',
  /** Said when the request opens (the direct result of the agent's press). */
  raisedAnnouncement: 'Help requested. Your supervisors can see it.',
  cancelledAnnouncement: 'Help request cancelled.',
} as const;

/** The name a message is signed with; "Your supervisor" when the server could not read it (LF15). */
export function messageSender(fromName: string | null): string {
  return fromName?.trim() || 'Your supervisor';
}
