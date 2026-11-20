import type { AgencyMyCallLater } from '@magick-agency/contracts/api/agency/my-day';
import type { AgencyAssignment } from '../../types/agency-campaign';
import type { AgentLandingArrival } from '../agencyStationExit';
import { assignmentEntry } from '../agencyAssignmentEntry';
import type { BandIcon, StationTone } from './stationView';

/**
 * The agent's work picker (`AgentHomePage`, `/dialer`): the step before Start of day when the agent
 * has more than one list, or when the station sent them here (spec §3 01, "More than one
 * campaign"). Big tiles in the station's colours, one per list, each with one way in (AS1), in the
 * station's own words (AS15: none of spec §6.6's jargon, so "work" and "list", never "campaign" or
 * "station").
 *
 * Pure: the page renders what these return; `agentHome.test.ts` pins every status and band.
 */

export const AGENT_HOME_COPY = {
  greeting: (firstName: string | null) => (firstName ? `Namaste, ${firstName}` : 'Namaste'),
  chooseSubtitle: 'Choose your work for today.',
  oneSubtitle: 'Here is your work for today.',
  finishedTitle: 'Work finished for now',
  finishedSubtitle: 'No calls will come to you. Open your work again when you are ready.',
  refusedTitle: 'Your work did not open',
  refusedSubtitle: 'Choose your work below. If it stays closed, ask your supervisor.',
  noneTitle: 'No work for you yet',
  noneSubtitle: 'Ask your supervisor to add you to a list.',
  noneBody: 'When your supervisor adds you, your work shows here.',
  errorTitle: 'We could not load your work',
  errorSubtitle: 'Check your internet. Then try again.',
  errorBody: 'No calls have started. Press Try again.',
  tryAgain: 'Try again',
  loading: 'Getting your work…',
  oneAtATime: 'You can work on only one list at a time.',
  open: 'Open',
  openLabel: (name: string) => `Open ${name}`,
  unnamed: 'Unnamed list',
  callLater: 'Call later',
  callLaterToday: (n: number) => `${n} today`,
  callLaterLate: (n: number) => `${n} late`,
  openConsole: 'Open the console',
} as const;

/** What a list is doing, in plain words, with the tone and picture of its line. */
export interface WorkStatus {
  tone: StationTone;
  icon: 'phone' | 'pause' | 'clock' | 'stop' | 'check';
  line: string;
}

/**
 * The status line by `campaign_status`. Null when the status is unknown (the server's lookup
 * failed, or a status this client has never heard of): the tile says nothing it cannot stand
 * behind (AS1, hide what does not apply), and the way in stays (`assignmentEntry`).
 */
export function workStatus(status: string | null | undefined): WorkStatus | null {
  switch (status) {
    case 'running':
      return { tone: 'ready', icon: 'phone', line: 'Calling is on' };
    case 'paused':
      return { tone: 'quiet', icon: 'pause', line: 'Paused by your supervisor' };
    case 'draft':
      return { tone: 'quiet', icon: 'clock', line: 'Not started yet' };
    case 'stopping':
      return { tone: 'quiet', icon: 'pause', line: 'Ending now. No new calls.' };
    case 'stopped':
      return { tone: 'quiet', icon: 'stop', line: 'Ended by your supervisor. No more calls.' };
    case 'completed':
      return { tone: 'quiet', icon: 'check', line: 'Finished. Every customer was called.' };
    default:
      return null;
  }
}

/** One tile: the list, what it is doing, and whether it can be opened (stopped and completed cannot). */
export interface WorkTile {
  campaignId: string;
  name: string;
  /** False: no way in (AS1), the status line says why. */
  canOpen: boolean;
  status: WorkStatus | null;
}

export function workTile(assignment: AgencyAssignment): WorkTile {
  const name = assignment.campaign_name?.trim() || AGENT_HOME_COPY.unnamed;
  return {
    campaignId: assignment.campaign_id,
    name,
    canOpen: assignmentEntry(assignment.campaign_status).canEnter,
    status: workStatus(assignment.campaign_status),
  };
}

/** "Call later · 3 today · 1 late", or null when there is none (the line is hidden). */
export function callLaterLine(callLater: Pick<AgencyMyCallLater, 'today' | 'overdue'> | null | undefined): string | null {
  if (!callLater) return null;
  const parts: string[] = [];
  if (callLater.today > 0) parts.push(AGENT_HOME_COPY.callLaterToday(callLater.today));
  if (callLater.overdue > 0) parts.push(AGENT_HOME_COPY.callLaterLate(callLater.overdue));
  return parts.length > 0 ? `${AGENT_HOME_COPY.callLater} · ${parts.join(' · ')}` : null;
}

/** The band across the top: its colour, picture and words. */
export interface HomeBand {
  screen: string;
  tone: StationTone;
  icon: BandIcon;
  title: string;
  subtitle: string;
}

export type HomeScreen =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'none' }
  | { kind: 'list'; arrival: AgentLandingArrival | null; count: number };

/**
 * The band for each of the page's screens. The two arrivals are different news and never share
 * words: one agent finished work, the other was refused entry (a stopped list, any join failure).
 */
export function homeBand(screen: HomeScreen, firstName: string | null): HomeBand {
  switch (screen.kind) {
    case 'loading':
      return { screen: 'home_loading', tone: 'start', icon: 'headphones', title: AGENT_HOME_COPY.greeting(firstName), subtitle: AGENT_HOME_COPY.loading };
    case 'error':
      return { screen: 'home_error', tone: 'problem', icon: 'wifi_off', title: AGENT_HOME_COPY.errorTitle, subtitle: AGENT_HOME_COPY.errorSubtitle };
    case 'none':
      return { screen: 'home_none', tone: 'quiet', icon: 'pause', title: AGENT_HOME_COPY.noneTitle, subtitle: AGENT_HOME_COPY.noneSubtitle };
    case 'list':
      if (screen.arrival === 'refused') {
        return { screen: 'home_refused', tone: 'problem', icon: 'warning', title: AGENT_HOME_COPY.refusedTitle, subtitle: AGENT_HOME_COPY.refusedSubtitle };
      }
      if (screen.arrival === 'station') {
        return { screen: 'home_finished', tone: 'start', icon: 'log_out', title: AGENT_HOME_COPY.finishedTitle, subtitle: AGENT_HOME_COPY.finishedSubtitle };
      }
      return {
        screen: 'home_choose',
        tone: 'start',
        icon: 'headphones',
        title: AGENT_HOME_COPY.greeting(firstName),
        subtitle: screen.count > 1 ? AGENT_HOME_COPY.chooseSubtitle : AGENT_HOME_COPY.oneSubtitle,
      };
  }
}
