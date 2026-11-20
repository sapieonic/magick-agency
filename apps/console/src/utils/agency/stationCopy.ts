import type {
  AgencyCampaignChangeReason,
  AgencyQueueIdleReason,
  AgencyReleaseReason,
} from '@magick-agency/contracts/agency';
import type { AgencyAttemptOutcome } from '../../types/agency';
import { clockTime, runningClock } from './stationFormat';

/**
 * The agent station's own words (AS15, spec §3 and §6.6). Simple Indian English, short sentences,
 * British spelling, and none of the jargon in spec §6.6 (no disposition, wrap-up, session,
 * station, campaign, callback, DNC, …). The station shows these keyed on a code, never a sentence
 * the server sent.
 *
 * Exact copy from the spec where it gives one; the rest written to the same rules.
 */
export const STATION_COPY = {
  // Top bar and ⋮ More
  needHelp: 'Need help',
  helpAsked: 'Help asked',
  helpAsking: 'Asking…',
  helpCancelling: 'Cancelling…',
  helpCancelHint: 'Press again to cancel your request.',
  helpRaiseHint: 'Ask a supervisor for help. Every supervisor sees it.',
  helpAnsweredMessage: 'Your supervisor sent you a message.',
  helpExpired: 'No supervisor answered. Ask again if you still need help.',
  helpRefused: 'Your request did not go through. Try again.',
  more: 'More',
  menuMyCustomers: 'My customers',
  menuDialMyself: 'Dial a number myself',
  menuMyCalls: 'My calls today',
  menuSound: 'Sound',
  soundTitle: 'Sound and flash',
  menuLightScreen: 'Light screen',
  menuDarkScreen: 'Dark screen',
  menuFinish: 'Finish work for today',

  // 01 Start of day
  startTitle: (firstName: string | null) => (firstName ? `Namaste, ${firstName}` : 'Namaste'),
  startSubtitle: (checks: number) => `Check these ${checks} things. Then start work.`,
  checkHeadset: 'Headset',
  checkMicrophone: 'Microphone',
  checkInternet: 'Internet',
  checkOk: 'OK',
  checkChecking: 'Checking…',
  checkNoHeadset: 'Not found',
  checkBlocked: 'Blocked',
  checkNotFound: 'Not found',
  checkInUse: 'In use',
  checkProblem: 'Problem',
  checkOffline: 'Not working',
  todaysWork: 'Today’s work',
  target: 'Target',
  targetValue: (calls: number) => `${calls} calls`,
  callLater: 'Call later',
  callLaterToday: (n: number) => `${n} today`,
  howWillYouWork: 'How will you work?',
  workCallsCome: 'Calls come to me',
  workCallsComeHint: 'The system dials. You talk.',
  workDialMyself: 'I dial the number',
  workDialMyselfHint: 'You type the number yourself.',
  startWork: 'Start work',
  starting: 'Starting…',
  listenNotice: 'Your supervisor may listen to calls for training.',

  // 01b A check failed
  micBlockedTitle: 'Microphone is blocked',
  micBlockedSubtitle: 'The customer cannot hear you. Fix this first.',
  micMissingTitle: 'No microphone found',
  micMissingSubtitle: 'Plug in your headset. Then check again.',
  micInUseTitle: 'Microphone is used by another app',
  micInUseSubtitle: 'Close the other app. Then check again.',
  micOtherTitle: 'Microphone is not working',
  micOtherSubtitle: 'Fix this first. Then check again.',
  noInternetTitle: 'No internet',
  noInternetSubtitle: 'Check the internet cable or Wi-Fi.',
  whatToDo: 'What to do',
  stepsMicBlocked: ['Click the lock next to the web address.', 'Turn on Microphone.', 'Press Check again.'],
  stepsMicMissing: ['Plug in your headset.', 'Wait a moment.', 'Press Check again.'],
  stepsMicInUse: ['Close the other app that uses the microphone.', 'Wait a moment.', 'Press Check again.'],
  stepsMicOther: ['Unplug your headset and plug it in again.', 'Press Check again.', 'Still not working? Call your supervisor to your desk.'],
  stepsNoInternet: ['Check the internet cable or Wi-Fi.', 'Wait. We try again by ourselves.', 'Still not working? Call your supervisor to your desk.'],
  noHeadsetWarning: 'No headset. Calls will use the computer speaker.',
  checkAgain: 'Check again',

  // 02 Ready
  readyTitle: 'Ready',
  readySubtitle: 'Next call is coming. Stay on this screen.',
  nextCallComing: 'Next call is coming…',
  dialling: 'Calling a customer…',
  waiting: 'Waiting',
  myDay: 'My day',
  callsToday: 'Calls today',
  talkTime: 'Talk time',
  willPay: 'Will pay',
  myCallLaterList: 'My call-later list',
  callLaterComesToMe: 'These calls will come to you on time.',
  callLaterPool: 'We will call them on time. Another agent may get the call.',
  callLaterSoon: (minutes: number) => (minutes <= 0 ? 'now' : `in ${minutes} min`),
  noAnswerFromLast: (n: number) => (n === 1 ? 'No answer from the last number.' : `No answer from the last ${n} numbers.`),
  diallingSubtitle: 'We are calling a customer for you. Stay on this screen.',
  takeBreak: 'Take break',

  // 02b banners
  lastCallDidNotConnect: 'The last call did not connect. You do not need to do anything.',
  lastCallEnded: 'The last call ended.',
  messageOk: 'OK',
  moreMessages: (n: number) => (n === 1 ? '1 more message' : `${n} more messages`),
  supervisorSuffix: '(supervisor)',

  // 02c No calls right now
  noCallsTitle: 'No calls right now',
  noCallsBody: 'Calls will start again',
  noCallsHint: 'You do not need to do anything.',

  // 03 Call coming
  comingTitle: 'Call coming',
  comingSubtitle: 'Get ready. Say Namaste first.',
  inboundTitle: 'Customer is calling',
  connecting: 'Connecting',
  connectsByItself: 'The call connects by itself.',
  whatTheySaid: 'What they said last time',
  lastCall: 'Last call',
  callAgainTag: (n: number, of: number) => `Calling again · ${n} of ${of}`,

  // 04 On call
  onCallTitle: 'On call',
  callRecorded: 'Call is recorded',
  lastCalls: 'Last calls',
  noLastCalls: 'First call to this customer.',
  note: 'Note',
  notePlaceholder: 'Type a note here (not required)',
  notePlaceholderNeeded: 'Write a note for this one.',
  speakNote: 'Speak a note',
  speakNoteStop: 'Stop listening',
  speakNoteListening: 'Listening… speak now.',
  mute: 'Mute',
  unmute: 'Unmute',
  endCall: 'Hold to end call',
  endCallHolding: 'Keep holding…',
  endCallArmed: 'Press E again to end',
  endCallEnding: 'Ending…',
  endCallHint: 'Hold the button, or press E two times.',
  endCallFailed: 'The call did not end. Try again.',
  onMute: 'You are on mute. The customer cannot hear you.',
  breakAfterCall: (label: string) => `${label} break after this call`,
  dialAfterCall: 'Dial a number myself after this call',
  cancelBreakAfterCall: 'Cancel the break after this call',
  breakCancelFailed: 'The break could not be cancelled. Try again.',
  breakAlreadyStarted: 'Your break already started.',
  micLost: 'Microphone is blocked. The customer cannot hear you.',
  turnSoundOn: 'Turn sound on',

  // 05 What happened?
  happenedTitle: 'What happened?',
  happenedSubtitle: 'Choose one. Then press Save.',
  timeLeft: 'Time left',
  timeOver: 'Time is over',
  timeOverBanner: 'Time is over. Choose one now. Your supervisor can see that you are still on this screen.',
  heldBySupervisor: 'Your supervisor is holding this screen. Choose one when you are ready.',
  callWasCut: 'The call was cut. Choose what happened, or call again.',
  readAloud: (label: string) => `Read “${label}” aloud`,
  moreOutcomes: 'More',
  moreOutcomesHint: (n: number) => `${n} more`,
  dontCallAgain: 'Don’t call again',
  payDate: 'Pay date',
  today: 'Today',
  tomorrow: 'Tomorrow',
  inAWeek: 'In a week',
  otherDate: 'Other date',
  amount: 'Amount',
  amountPlaceholder: 'Amount (not required)',
  full: 'Full',
  half: 'Half',
  callWhen: 'Call when?',
  inOneHour: 'In 1 hour',
  todayAt: (time: string) => `Today ${time}`,
  tomorrowAt: (time: string) => `Tomorrow ${time}`,
  otherTime: 'Other time',
  willComeToYou: (when: string) => `This call will come to you ${when}.`,
  mayGoToAnother: (when: string) => `We will call ${when}. Another agent may get the call.`,
  willCallAgain: (when: string) => `We will call again on ${when}.`,
  willPayOn: (when: string, amount: string | null) => (amount ? `Will pay on ${when} · ${amount}` : `Will pay on ${when}`),
  noteNeeded: 'Write a note for this one.',
  saveAndNext: 'Save & next call',
  saving: 'Saving…',
  saveAndBreak: 'Save & take break',
  callAgain: 'Call again',
  callAgainLeft: (n: number) => `${n} left`,
  callingAgain: 'Calling again…',
  saved: 'Saved',
  catalogChanged: 'This list changed. Choose one of these.',
  keysMoved: 'The number keys have moved. Read the labels.',

  // 05c Don't call again
  stopCallingTitle: 'Stop calling this customer?',
  stopCallingBody: 'We will not call this number again for this work. You cannot change this later.',
  noGoBack: 'No, go back',
  yesStopCalls: 'Yes, stop calls',
  stoppingCalls: 'Stopping…',
  stoppedCalls: 'We will not call this number again.',
  stopCallsFailed: 'That did not go through. Try again.',

  // 06 Which break?
  whichBreak: 'Which break?',
  minutes: (n: number) => `${n} min`,
  cancel: 'Cancel',
  noBreakReasons: 'No breaks are set up. Ask your supervisor.',
  breakRefused: 'You cannot take that break now. Choose another.',

  // 07 / 08 Breaks
  onBreakTitle: (label: string | null) => (label ? `On break · ${label}` : 'On break'),
  onBreakSubtitle: 'No calls will come now.',
  leftOfYour: (left: string, minutes: number) => `${left} left of your ${minutes} minutes.`,
  longBreak: (minutes: number) => `You have been on break for ${minutes} minutes.`,
  breakOverTitle: 'Break time is over',
  breakOverSubtitle: (late: string) => `You are ${late} late. Start calls now.`,
  breakWas: (minutes: number) => `Your break was ${minutes} minutes. Your supervisor can see this.`,
  startCallsAgain: 'Start calls again',
  pausedTitle: 'Paused',
  pausedSubtitle: 'You left the app. No calls came.',

  // 09 / 10 Problems
  internetTitle: 'Internet problem',
  internetSubtitle: 'Calls are stopped. We are trying again.',
  internetGaveUpSubtitle: 'Calls are stopped. Press Try again now.',
  noInternetBody: 'No internet',
  noInternetHint: 'No calls will come until it is back.',
  tryingAgainIn: 'Trying again in',
  tryingNow: 'Trying now…',
  stepsInternet: ['Check the internet cable or Wi-Fi.', 'Wait. Calls start again by themselves.', 'Still not working? Call your supervisor to your desk.'],
  callProblemTitle: 'Call problem',
  callProblemSubtitle: 'Stay here. We are joining the call again.',
  callKeptFor: 'Call is kept for',
  stepsCallProblem: ['Do not close this page.', 'If the call comes back, say sorry and go on.', 'If it does not, you can call again.'],
  tryAgainNow: 'Try again now',
  internetOnHappened: 'Internet problem. We are trying again. Your answer is kept.',

  // 11 Finish work
  finishTitle: 'Finish work for today?',
  finishSubtitle: 'No more calls will come to you.',
  keepWorking: 'No, keep working',
  yesFinish: 'Yes, finish work',
  finishing: 'Finishing…',
  finishFailed: 'Your work is still open. Try again.',

  // 12 Open on another device
  otherDeviceTitle: 'Your work is open on another device',
  otherDeviceSubtitle: 'Only one device can take calls at a time.',
  otherDeviceBody: 'You opened it on another device or window',
  otherDeviceHint: 'No calls will come to this computer now.',
  useThisComputer: 'Use this computer',
  workEndedTitle: 'Your work was closed',
  workEndedSubtitle: 'Open today’s work again to take calls.',
  openWorkAgain: 'Open today’s work',

  // Things that went wrong, in the station's words
  startRefused: 'Finish the last call first. Choose what happened and press Save.',
  somethingWentWrong: 'That did not go through. Try again in a moment.',
} as const;

/** 02c's subtitle, by why calls stopped (spec §3 02c; all four reasons exist today). */
export function noCallsSubtitle(input: {
  campaignReason: AgencyCampaignChangeReason | null;
  dialing: boolean;
  queueReason: AgencyQueueIdleReason | null;
  nextDueAt: string | null;
}): string {
  const { campaignReason, dialing, queueReason, nextDueAt } = input;
  if (!dialing) {
    if (campaignReason === 'list_exhausted') return 'No customers are waiting. Stay on this screen.';
    return 'Your supervisor has stopped calls. Stay on this screen.';
  }
  const at = nextDueAt ? Date.parse(nextDueAt) : NaN;
  const time = Number.isFinite(at) ? clockTime(at) : null;
  switch (queueReason) {
    case 'outside_calling_hours':
      return time ? `Calls start at ${time}.` : 'Calls start again in calling hours.';
    case 'callbacks_later':
    case 'waiting_for_retry':
      return time ? `Your next call is at ${time}.` : 'No customers are waiting. Stay on this screen.';
    case 'queue_empty':
    default:
      return 'No customers are waiting. Stay on this screen.';
  }
}

/** A prior call's result when nobody chose an outcome, in everyday words. */
export const ATTEMPT_OUTCOME_WORDS: Record<AgencyAttemptOutcome, string> = {
  connected: 'Spoke',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Did not connect',
  machine: 'Machine answered',
  invalid: 'Wrong number',
  abandoned: 'Did not connect',
  agent_disconnected: 'Call was cut',
  orphaned: 'Did not connect',
  canceled: 'Stopped',
};

/**
 * The banner for a call that ended with nothing for the agent to do (`released` with no outcome
 * owed). Keyed on the reason; one sentence for all of them, because the agent's action is the same.
 */
export function releaseBanner(reason: AgencyReleaseReason | string): string | null {
  switch (reason) {
    case 'completed':
    case 'agent_hangup':
    case 'remote_hangup':
      return null;
    default:
      return STATION_COPY.lastCallDidNotConnect;
  }
}

/** "Help asked · 0:42". */
export function helpAskedLabel(elapsedMs: number): string {
  return `${STATION_COPY.helpAsked} · ${runningClock(elapsedMs)}`;
}

/** The green line once a supervisor answers (spec §3 top bar). */
export function helpAnsweredLine(byName: string | null, how: 'listen' | 'message' | null): string {
  const who = byName?.trim() || null;
  if (how === 'listen') return who ? `Help is here. ${who} is listening to this call.` : 'Help is here. A supervisor is listening to this call.';
  if (how === 'message') return who ? `Help is here. ${who} sent you a message.` : `Help is here. ${STATION_COPY.helpAnsweredMessage}`;
  return who ? `Help is here. ${who} answered you.` : 'Help is here. A supervisor answered you.';
}

/** The station's words for a refused raise or cancel (AS15), by the server's code, then its status. */
export function helpRefusedLine(refusal: { action: 'raise' | 'cancel'; code: string | null; status: number | null }): string {
  switch (refusal.code) {
    case 'floor_assist_disabled':
      return 'Need help is not turned on. Call your supervisor to your desk.';
    case 'help_not_on_call':
      return 'You can ask for help on a call, or while you choose what happened.';
    case 'session_ended':
      return 'Your work was closed. Open today’s work again to ask for help.';
    case 'account_scope_required':
      return 'Open your work from your account to ask for help.';
    default:
      break;
  }
  if (refusal.status === 404) return 'Your work was not found. Open today’s work again to ask for help.';
  if (refusal.status === 403) return 'You cannot ask for help here. Call your supervisor to your desk.';
  return refusal.action === 'raise' ? STATION_COPY.helpRefused : 'Your request could not be cancelled. Try again.';
}

/** Why Save is not ready yet, in the station's words (spec §6.1), keyed on today's block reasons. */
export const STATION_BLOCK_COPY: Record<
  'no_selection' | 'note_required' | 'datetime_required' | 'callback_in_past' | 'promise_required' | 'promise_date_invalid' | 'promise_amount_invalid',
  string
> = {
  no_selection: 'Choose one first.',
  note_required: 'Write a note for this one.',
  datetime_required: 'Choose when to call.',
  callback_in_past: 'That time is over. Choose a new time.',
  promise_required: 'Choose the pay date.',
  promise_date_invalid: 'Choose a pay date from today up to 30 days ahead.',
  promise_amount_invalid: 'Write the amount in numbers only, like 12500.',
};

/** A call that ended while the internet was down (`ready.missed_release`), said once it is back. */
export function missedReleaseLine(reason: string): string {
  switch (reason) {
    case 'remote_hangup':
      return 'While your internet was down, the customer hung up.';
    case 'agent_disconnected':
      return 'While your internet was down, the call was cut.';
    case 'no_answer':
    case 'busy':
    case 'failed':
    case 'invalid':
    case 'abandoned':
    case 'reservation_expired':
      return 'While your internet was down, the last call did not connect.';
    default:
      return 'While your internet was down, the last call ended.';
  }
}
