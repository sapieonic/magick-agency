import { AGENCY_HELP_EXPIRY_MS } from '@magick-agency/contracts/agency';
import type { AgencyAgentState } from '../../types/agency';
import { errorCode, errorStatus } from '../agencyErrors';
import type { StationHelpNotice } from '../agencyStationReducer';

/**
 * The agent's side of floor assist (LF4, LF5, LF24–LF26): Need help on the station, what it says
 * while a request is open and once it ends, and the words around a supervisor's message. Copy and
 * pure rules only; the flow is `pages/agency/station/useStationHelp`, the frames `useAgencyStation`.
 */

/** The agent states Need help may be raised in (LF13): on a call, or in its wrap-up. */
export function helpRaisable(agentState: AgencyAgentState): boolean {
  return agentState === 'on_call' || agentState === 'wrapup';
}

/** How long a request stays open unanswered, in minutes, as the copy says it (LF12). */
export const HELP_EXPIRY_MINUTES = Math.round(AGENCY_HELP_EXPIRY_MS / 60_000);

export const STATION_HELP_COPY = {
  raise: 'Need help',
  raising: 'Asking…',
  cancel: 'Cancel help request',
  cancelling: 'Cancelling…',
  /** Why the control does nothing now: the server's own `help_not_on_call` rule, said before asking. */
  notOnCall: 'You can ask for help during a call, or while you finish one.',
  /** What pressing it does. */
  raiseHint: 'Ask a supervisor for help with this call. Every supervisor on the floor sees it.',
  open: 'Help requested. Waiting for a supervisor.',
  /** Said when the request opens (the direct result of the agent's press). */
  raisedAnnouncement: 'Help requested. Your supervisors can see it.',
  cancelledAnnouncement: 'Help request cancelled.',
  expired: `Nobody answered your request in ${HELP_EXPIRY_MINUTES} minutes, so it was closed. You can ask again.`,
  dismiss: 'Dismiss',
} as const;

/**
 * The words for a request that was answered or lapsed. A null name (the server could not read it)
 * is "A supervisor"; with no `how` (only the clear arrived) the answer says only that someone
 * responded.
 */
export function helpNoticeText(notice: StationHelpNotice): string {
  if (notice.kind === 'expired') return STATION_HELP_COPY.expired;
  const who = notice.by_name?.trim() || null;
  if (notice.how === 'listen') return who ? `${who} is listening in.` : 'A supervisor is listening in.';
  if (notice.how === 'message') return who ? `${who} sent you a message.` : 'A supervisor sent you a message.';
  return who ? `${who} responded to your request.` : 'A supervisor responded to your request.';
}

/** The words for a raise or cancel the server refused, by its code, then its status. */
export function helpRefusalText(err: unknown, action: 'raise' | 'cancel'): string {
  switch (errorCode(err)) {
    case 'floor_assist_disabled':
      return 'Need help is not turned on for this account. Ask your supervisor directly.';
    case 'help_not_on_call':
      return STATION_HELP_COPY.notOnCall;
    case 'session_ended':
      return 'Your station session has ended. Rejoin the campaign to ask for help.';
    case 'account_scope_required':
      return 'Open your station from your account to ask for help.';
    default:
      break;
  }
  const status = errorStatus(err);
  if (status === 404) return 'Your station session was not found. Rejoin the campaign to ask for help.';
  if (status === 403) return 'You do not have permission to ask for help here.';
  return action === 'raise'
    ? 'Your request for help did not go through. Try again.'
    : 'Your request could not be cancelled. Try again.';
}

/** The name a message is signed with; "Your supervisor" when the server could not read it (LF15). */
export function messageSender(fromName: string | null): string {
  return fromName?.trim() || 'Your supervisor';
}
