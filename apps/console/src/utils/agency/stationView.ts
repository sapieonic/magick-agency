import type { StationConnection } from '../../hooks/useAgencyStation';
import type {
  AgencyAgentState,
  AgencyCampaignChangeReason,
  AgencyQueueState,
} from '../../types/agency';
import { STATION_COPY, noCallsSubtitle } from './stationCopy';
import { runningClock } from './stationFormat';

/**
 * The agent station's view model: one agent state in, one screen out (AS1, spec §2).
 *
 * The server has six agent states and the socket five connection states; the redesign adds no
 * state of its own. This function decides, from those and a few client facts (the device checks,
 * whether Finish work is being asked), which of the spec's screens is on, what its band says, which
 * one main action it has, whether Need help and which ⋮ More items are offered. Everything that
 * is not here is hidden, not disabled (AS1).
 *
 * Pure and total: every input maps to exactly one screen, which `stationView.test.ts` pins.
 *
 * ── Where new data slots in ──────────────────────────────────────────────────
 * Fields the server does not send yet arrive as optional inputs that are absent today, and each
 * one's tile or line is simply not shown while it is: `helpEverywhere` (BE-9 — Need help on every
 * working screen), `reservedBreak` (the app's pauses). The customer card's own optional fields are
 * in `stationCustomer.ts`, My day's in `StationMyDay`.
 */

/** The spec's screens, by their numbers (`01`, `01b`, `02`, …). */
export type StationScreen =
  /** 01 */ | 'start'
  /** 01b */ | 'check_failed'
  /** 02 (02b is its banners) */ | 'ready'
  /** 02c */ | 'no_calls'
  /** 03, 03b */ | 'coming'
  /** 04, 04b, 04c */ | 'on_call'
  /** 05, 05b, 05c, 05d */ | 'happened'
  /** 07 */ | 'on_break'
  /** 08 */ | 'break_over'
  /** 09 */ | 'internet'
  /** 10 */ | 'call_problem'
  /** 11 */ | 'finish'
  /** 12 */ | 'other_device'
  /** 12's layout: the work was closed under the agent (the session ended). */ | 'work_ended';

/** The band colour: a `--st-<tone>` token family in web-ui's global.css. */
export type StationTone = 'start' | 'ready' | 'coming' | 'oncall' | 'happened' | 'break' | 'over' | 'problem' | 'quiet';

export type BandIcon =
  | 'headphones' | 'mic_off' | 'wifi_off' | 'phone_in' | 'phone' | 'check' | 'cup' | 'warning' | 'pause' | 'device' | 'log_out';

/** The one main action, bottom right (AS1: it never moves). */
export type MainAction =
  | 'start_work' | 'check_again' | 'take_break' | 'end_call' | 'save_next' | 'start_calls'
  | 'try_again' | 'keep_working' | 'use_this_computer' | 'open_work_again';

/** The key printed on each main action (spec §2 table). */
export const MAIN_ACTION_KEY: Record<MainAction, string | null> = {
  start_work: 'Enter',
  check_again: 'Enter',
  take_break: 'B',
  end_call: 'E',
  save_next: 'Enter',
  start_calls: 'A',
  try_again: 'R',
  keep_working: 'Esc',
  use_this_computer: 'Enter',
  open_work_again: null,
};

/** ⋮ More's items, in their order; Finish work is last and red. */
export type MoreItem = 'my_customers' | 'dial_myself' | 'my_calls' | 'sound' | 'theme' | 'finish';

/** What a device check found (spec 01, 01b). `unknown` is not shown. */
export interface DeviceChecks {
  microphone: 'checking' | 'ok' | 'blocked' | 'not_found' | 'in_use' | 'problem';
  /** A guess from the device label; never blocks Start work. `unknown` where the browser cannot tell. */
  headset: 'ok' | 'missing' | 'unknown';
}

export interface StationViewInput {
  firstName: string | null;
  connection: StationConnection;
  agentState: AgencyAgentState;
  /** The outbound call on screen: none, ringing (reserved, not yet `bridged`), or connected. */
  call: 'none' | 'ringing' | 'connected';
  /** The call on screen ended and its outcome is owed (or the wrap-up is still open). */
  outcomeOwed: boolean;
  /** Whether the campaign dials for this agent (`campaign_state.dialing`). */
  dialing: boolean;
  campaignReason: AgencyCampaignChangeReason | null;
  /** The agent's own queue (strict and preferred campaigns); null or absent on pool. */
  queue: AgencyQueueState | null | undefined;
  /** Late binding: a hidden dial for this agent is ringing, which outranks "nothing due". */
  diallingCustomer: boolean;
  breakReasonLabel: string | null;
  breakLimitMinutes: number | null;
  /** How long the agent has been on break, in ms; null when not on break or not known yet. */
  breakElapsedMs: number | null;
  /** On a reserved break the app sets by itself (device away, a phone call): "Paused". */
  reservedBreak?: boolean;
  checks: DeviceChecks;
  /** The agent pressed Finish work for today and has not answered yet. */
  finishOpen: boolean;
  /** `agency_floor_assist_enabled` is on. */
  helpOffered: boolean;
  /** A help request is open. */
  helpOpen: boolean;
  /**
   * BE-9 (not on the server yet): a raise is accepted in every state of a live session. Absent or
   * false today, so Need help shows on On call and What happened? only (AS5, phase 0).
   */
  helpEverywhere?: boolean;
  softphoneAvailable: boolean;
  myContactsOffered: boolean;
}

export interface StationView {
  screen: StationScreen;
  tone: StationTone;
  icon: BandIcon;
  title: string;
  subtitle: string | null;
  /** Need help, top right. */
  needHelp: boolean;
  /** ⋮ More's items; empty means no ⋮ button. */
  menu: MoreItem[];
  main: MainAction | null;
  /** The footer's line when there is no main action ("The call connects by itself."). */
  footHint: string | null;
}

const LIVE_STATES: ReadonlySet<AgencyAgentState> = new Set(['reserved', 'on_call', 'wrapup']);

function micFailure(checks: DeviceChecks): { title: string; subtitle: string } | null {
  switch (checks.microphone) {
    case 'blocked':
      return { title: STATION_COPY.micBlockedTitle, subtitle: STATION_COPY.micBlockedSubtitle };
    case 'not_found':
      return { title: STATION_COPY.micMissingTitle, subtitle: STATION_COPY.micMissingSubtitle };
    case 'in_use':
      return { title: STATION_COPY.micInUseTitle, subtitle: STATION_COPY.micInUseSubtitle };
    case 'problem':
      return { title: STATION_COPY.micOtherTitle, subtitle: STATION_COPY.micOtherSubtitle };
    default:
      return null;
  }
}

/** The breaks' "over" rule (spec 08): a limit, and more time used than it allows. */
export function breakIsOver(elapsedMs: number | null, limitMinutes: number | null): boolean {
  return elapsedMs !== null && limitMinutes !== null && elapsedMs > limitMinutes * 60_000;
}

export function stationView(input: StationViewInput): StationView {
  const screen = stationScreen(input);
  const band = bandFor(screen, input);
  return {
    screen,
    ...band,
    needHelp: needHelpShown(screen, input),
    menu: menuFor(screen, input),
    main: mainFor(screen),
    footHint: screen === 'coming' ? STATION_COPY.connectsByItself : null,
  };
}

/** Which screen is on. Order matters: the socket outranks the agent state (an agent whose
 *  internet is gone must not be told a call is coming). */
export function stationScreen(input: StationViewInput): StationScreen {
  const { connection, agentState, call, outcomeOwed } = input;
  if (connection === 'superseded') return 'other_device';
  if (connection === 'session_gone') return 'work_ended';

  const onACall = call !== 'none' || LIVE_STATES.has(agentState) || outcomeOwed;
  if (input.finishOpen && !onACall) return 'finish';

  if (connection === 'reconnecting' || connection === 'disconnected') {
    if (call !== 'none') return 'call_problem';
    // What happened? stays: its answer is kept and saving is a request, not the socket.
    if (outcomeOwed || agentState === 'wrapup') return 'happened';
    if (agentState === 'offline') return 'check_failed';
    return 'internet';
  }

  if (agentState === 'offline' && call === 'none' && !outcomeOwed) {
    return micFailure(input.checks) ? 'check_failed' : 'start';
  }
  if (call === 'ringing') return 'coming';
  if (call === 'connected') return 'on_call';
  if (outcomeOwed || agentState === 'wrapup') return 'happened';
  if (agentState === 'reserved') return 'coming';
  if (agentState === 'on_call') return 'on_call';
  if (agentState === 'break') {
    return breakIsOver(input.breakElapsedMs, input.breakLimitMinutes) ? 'break_over' : 'on_break';
  }
  // available
  if (input.diallingCustomer) return 'ready';
  if (!input.dialing) return 'no_calls';
  if (input.queue && input.queue.due === false) return 'no_calls';
  return 'ready';
}

function bandFor(screen: StationScreen, input: StationViewInput): Pick<StationView, 'tone' | 'icon' | 'title' | 'subtitle'> {
  switch (screen) {
    case 'start':
      return { tone: 'start', icon: 'headphones', title: STATION_COPY.startTitle(input.firstName), subtitle: STATION_COPY.startSubtitle(input.checks.headset === 'unknown' ? 2 : 3) };
    case 'check_failed': {
      const mic = micFailure(input.checks);
      if (mic && input.connection !== 'reconnecting' && input.connection !== 'disconnected') {
        return { tone: 'problem', icon: 'mic_off', title: mic.title, subtitle: mic.subtitle };
      }
      return { tone: 'problem', icon: 'wifi_off', title: STATION_COPY.noInternetTitle, subtitle: STATION_COPY.noInternetSubtitle };
    }
    case 'ready':
      return { tone: 'ready', icon: 'headphones', title: STATION_COPY.readyTitle, subtitle: STATION_COPY.readySubtitle };
    case 'no_calls':
      return {
        tone: 'quiet',
        icon: 'pause',
        title: STATION_COPY.noCallsTitle,
        subtitle: noCallsSubtitle({
          campaignReason: input.campaignReason,
          dialing: input.dialing,
          queueReason: input.queue?.reason ?? null,
          nextDueAt: input.queue?.next_due_at ?? null,
        }),
      };
    case 'coming':
      return { tone: 'coming', icon: 'phone_in', title: STATION_COPY.comingTitle, subtitle: STATION_COPY.comingSubtitle };
    case 'on_call':
      // The subtitle is the customer's name and place, which the page fills from the card.
      return { tone: 'oncall', icon: 'phone', title: STATION_COPY.onCallTitle, subtitle: null };
    case 'happened':
      return { tone: 'happened', icon: 'check', title: STATION_COPY.happenedTitle, subtitle: STATION_COPY.happenedSubtitle };
    case 'on_break':
      return input.reservedBreak
        ? { tone: 'break', icon: 'cup', title: STATION_COPY.pausedTitle, subtitle: STATION_COPY.pausedSubtitle }
        : { tone: 'break', icon: 'cup', title: STATION_COPY.onBreakTitle(input.breakReasonLabel), subtitle: STATION_COPY.onBreakSubtitle };
    case 'break_over': {
      const lateMs = (input.breakElapsedMs ?? 0) - (input.breakLimitMinutes ?? 0) * 60_000;
      return { tone: 'over', icon: 'warning', title: STATION_COPY.breakOverTitle, subtitle: STATION_COPY.breakOverSubtitle(runningClock(lateMs)) };
    }
    case 'internet':
      return {
        tone: 'problem',
        icon: 'wifi_off',
        title: STATION_COPY.internetTitle,
        subtitle: input.connection === 'disconnected' ? STATION_COPY.internetGaveUpSubtitle : STATION_COPY.internetSubtitle,
      };
    case 'call_problem':
      return { tone: 'problem', icon: 'wifi_off', title: STATION_COPY.callProblemTitle, subtitle: STATION_COPY.callProblemSubtitle };
    case 'finish':
      return { tone: 'start', icon: 'log_out', title: STATION_COPY.finishTitle, subtitle: STATION_COPY.finishSubtitle };
    case 'other_device':
      return { tone: 'quiet', icon: 'device', title: STATION_COPY.otherDeviceTitle, subtitle: STATION_COPY.otherDeviceSubtitle };
    case 'work_ended':
      return { tone: 'quiet', icon: 'log_out', title: STATION_COPY.workEndedTitle, subtitle: STATION_COPY.workEndedSubtitle };
  }
}

/**
 * Need help, top right (AS5). Today the server accepts a raise only on a call or while choosing
 * what happened, so it is shown on 04 and 05 only; an open request stays reachable wherever it is
 * (its press cancels). Never on 11 or 12, and not while the internet is down (the press cannot
 * reach anyone; 09 says to call the supervisor to the desk).
 */
function needHelpShown(screen: StationScreen, input: StationViewInput): boolean {
  if (!input.helpOffered) return false;
  if (screen === 'finish' || screen === 'other_device' || screen === 'work_ended') return false;
  if (input.connection !== 'open') return false;
  if (input.helpOpen) return true;
  if (screen === 'on_call' || screen === 'happened') return true;
  // BE-9: every working screen once the server accepts a raise there.
  return input.helpEverywhere === true && screen !== 'start' && screen !== 'check_failed';
}

/**
 * ⋮ More (spec §3 top bar). During a call and on What happened? only Sound (and the screen
 * colour); nothing at all on 11 and 12. My customers needs the internet and no call; Dial a
 * number myself is on Start of day's own tiles, so not in the menu there.
 */
function menuFor(screen: StationScreen, input: StationViewInput): MoreItem[] {
  switch (screen) {
    case 'finish':
    case 'other_device':
    case 'work_ended':
      return [];
    case 'coming':
    case 'on_call':
    case 'happened':
    case 'call_problem':
    case 'internet':
      return ['sound', 'theme'];
    default: {
      const items: MoreItem[] = [];
      if (input.myContactsOffered && input.connection === 'open') items.push('my_customers');
      if (input.softphoneAvailable && screen !== 'start' && input.connection === 'open') items.push('dial_myself');
      items.push('my_calls', 'sound', 'theme', 'finish');
      return items;
    }
  }
}

function mainFor(screen: StationScreen): MainAction | null {
  switch (screen) {
    case 'start': return 'start_work';
    case 'check_failed': return 'check_again';
    case 'ready':
    case 'no_calls': return 'take_break';
    case 'coming': return null;
    case 'on_call': return 'end_call';
    case 'happened': return 'save_next';
    case 'on_break':
    case 'break_over': return 'start_calls';
    case 'internet':
    case 'call_problem': return 'try_again';
    case 'finish': return 'keep_working';
    case 'other_device': return 'use_this_computer';
    case 'work_ended': return 'open_work_again';
  }
}
