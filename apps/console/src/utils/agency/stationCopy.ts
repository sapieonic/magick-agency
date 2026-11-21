import type {
  AgencyCampaignChangeReason,
  AgencyQueueIdleReason,
  AgencyReleaseReason,
} from '@magick-agency/contracts/agency';
import type { AgencyAgentState, AgencyAttemptOutcome } from '../../types/agency';
import { clockTime, runningClock, weekdayDayMonth } from './stationFormat';

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
  numbersDialled: 'Numbers dialled',
  customer: 'Customer',
  late: 'Late',
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
  customerCallingTitle: 'Customer is calling',
  softphoneReadyTitle: 'Dial a number',
  softphoneReadySubtitle: 'Type the number and press Call.',
  softphoneCallingTitle: 'Calling',
  softphoneCallingSubtitle: 'Wait for the customer to pick up.',
  backToCalls: 'Back to my calls',
  finishCallFirst: 'Finish your call and save what happened first.',
  backingToCalls: 'Going back…',
  inboundTitle: 'Customer is calling',
  connecting: 'Connecting',
  connectsByItself: 'The call connects by itself.',
  stopRingingArmed: 'Press E again to stop this call.',
  whatTheySaid: 'What they said last time',
  lastCall: 'Last call',
  /** AS19's hover card under a fact: where its value comes from. */
  factFromColumn: (column: string) => `From column: ${column}`,
  /** AS19 S11: what a screen reader hears for a fact this customer has no value for (the tile shows "—"). */
  factNotGiven: (name: string) => `${name}: not given`,
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
  cancelDialAfterCall: 'Do not dial a number myself after this call',
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
  readLineAloud: 'Read this aloud',

  // 03 / 04 the script (BE-8)
  firstSayThis: 'First, say this',
  whatToSay: 'What to say',
  stepsDone: (done: number, of: number) => `${done} of ${of} done`,
  allStepsDone: 'All steps done',
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

  // 07 / 08 Breaks
  onBreakTitle: (label: string | null) => (label ? `On break · ${label}` : 'On break'),
  onBreakSubtitle: 'No calls will come now.',
  leftOfYour: (left: string, minutes: number) => `${left} left of your ${minutes} minutes.`,
  longBreak: (minutes: number) => `You have been on break for ${minutes} minutes.`,
  breakOverTitle: 'Break time is over',
  breakOverSubtitle: (late: string) => `You are ${late} late. Start calls now.`,
  /** 08's subtitle as a screen reader hears it: once, with no number that counts. */
  breakOverSpoken: 'You are late from your break. Start calls now.',
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

  // Before work opens: it did not open, it is open elsewhere, or the soft phone holds it
  joinFailedTitle: 'Your work did not open',
  joinFailedSubtitle: 'See why below.',
  goBack: 'Go back',
  backHome: 'Back to your home screen',
  otherWorkTitle: 'You are working somewhere else',
  otherWorkSubtitle: 'You can work on only one list at a time.',
  otherWorkDoing: (name: string, doing: string) => `You are on ${name}, ${doing}.`,
  otherWorkMidCall: (name: string) => `Finish the call on ${name} first, then come back here.`,
  otherWorkLeaveFirst: (name: string) => `Leave ${name} first, then come back here.`,
  otherWorkSwitch: (name: string) => `Leave ${name} and work here`,
  otherWorkOpen: (name: string) => `Open ${name}`,
  otherWorkSwitchTitle: (name: string) => `Leave ${name}?`,
  otherWorkSwitchBody: (name: string) => `We will close your work on ${name} and start it here.`,
  otherWorkSwitchYes: 'Leave and work here',
  otherWorkSwitching: 'Leaving…',
  otherWorkSwitchNo: 'No, stay',
  softphoneJoinTitle: 'You are on the soft phone',
  softphoneJoinSubtitle: 'You can use one at a time. Close the soft phone to start work here.',
  softphoneJoinBody: 'Your soft phone is still open.',
  softphoneCloseAndStart: 'Close the soft phone and start here',
  softphoneClosing: 'Closing the soft phone…',
  softphoneCallOpen: 'Your soft phone has a call that is not finished. Hang up and save it there, then come back.',
  openSoftphone: 'Open the soft phone',

  // 11 Finish work
  finishTitle: 'Finish work for today?',
  finishSubtitle: 'No more calls will come to you.',
  keepWorking: 'No, keep working',
  yesFinish: 'Yes, finish work',
  finishing: 'Finishing…',
  leftForToday: (n: number, at: string, goesTo: 'pool' | 'waits_for_me' | null) => {
    const head = n === 1 ? `1 call later is left for today (${at}).` : `${n} call-laters are left for today (first at ${at}).`;
    if (goesTo === 'pool') return `${head} Another agent will make ${n === 1 ? 'it' : 'them'}.`;
    if (goesTo === 'waits_for_me') return `${head} ${n === 1 ? 'It waits' : 'They wait'} for you.`;
    return head;
  },
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

/** What the agent is doing on another list, in the station's words (the join screens). */
export const DOING_WORDS: Record<AgencyAgentState, string> = {
  offline: 'not started yet',
  available: 'ready for calls',
  reserved: 'with a call coming',
  on_call: 'on a call',
  wrapup: 'choosing what happened',
  break: 'on a break',
};

/**
 * 02c's subtitle when the list is not dialling, by why it stopped (`campaign_state.reason`). The
 * one table of it, kept here so the app can mirror it word for word: only a real supervisor's
 * pause or stop says the supervisor did it; the system's own pause (the abandonment ceiling,
 * `auto_paused`) does not blame anyone; a finished list says so; and no reason yet (no
 * `campaign_state` has said why, such as a list that has not started) gets a neutral line.
 */
export const NO_CALLS_STOPPED_WORDS: Record<AgencyCampaignChangeReason | 'none', string> = {
  paused_by_supervisor: 'Your supervisor has stopped calls. Stay on this screen.',
  stopped_by_supervisor: 'Your supervisor has stopped calls. Stay on this screen.',
  auto_paused: 'Calls are paused for a short while. Stay on this screen.',
  list_exhausted: 'Every customer on this list has been called.',
  // Not dialling after a start or resume: the next `campaign_state` says more.
  started: 'Calls have not started yet. Stay on this screen.',
  resumed: 'Calls have not started yet. Stay on this screen.',
  none: 'Calls have not started yet. Stay on this screen.',
};

/** 02c's subtitle (spec §3 02c): why calls stopped, else why nothing is due for this agent. */
export function noCallsSubtitle(input: {
  campaignReason: AgencyCampaignChangeReason | null;
  dialing: boolean;
  queueReason: AgencyQueueIdleReason | null;
  nextDueAt: string | null;
}): string {
  const { campaignReason, dialing, queueReason, nextDueAt } = input;
  if (!dialing) return NO_CALLS_STOPPED_WORDS[campaignReason ?? 'none'] ?? NO_CALLS_STOPPED_WORDS.none;
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

/* ───────────────────────────── AS15: the station's own words for what the server refused ───────────────────────────── */
/*
  Each line below is keyed on the server's code (then its status), never its sentence: the server
  writes for logs and supervisors, the station for an agent on a call (AS15, spec §6.6). A code the
  station does not know gets a plain "it did not go through" with what to do next.
*/

/** Start calls (or Back to calls) refused: `POST /sessions/:id/available`. */
export function presenceRefusedLine(code: string | null): string {
  switch (code) {
    case 'attempt_not_dispositionable':
      return 'Save what happened on your last call first.';
    case 'inbound_call_live':
      return 'Finish the customer’s call first.';
    case 'manual_call_live':
      return 'Finish your call on the soft phone and save it first.';
    case 'session_ended':
    case 'no_station':
      return 'Your work was closed. Open today’s work again.';
    case 'campaign_not_running':
      return 'Calls are stopped for this work right now.';
    case 'state_changing':
      return 'One moment. Try again.';
    case 'dial_failed':
      return 'Calls could not start just now. Try again in a moment.';
    default:
      return 'That did not go through. Try again in a moment.';
  }
}

/**
 * Why today's work did not open (`POST /sessions` refused or failed), the body of the "Your work
 * did not open" screen. Keyed on the server's code, then its status; never the server's sentence.
 * `no_campaign` is the client's own: the link named no work. `placeName` is the other account a
 * `session_in_other_tenant` refusal names (`tenant_name`), a name and not a sentence.
 */
export function joinRefusedLine(input: { code: string | null; status: number | null; placeName?: string | null }): string {
  const place = input.placeName?.trim() || null;
  switch (input.code) {
    case 'no_campaign':
      return 'No work was chosen. Go back and choose your work.';
    case 'not_staffed':
      return 'You are not on this work. Ask your supervisor to add you.';
    case 'session_in_other_tenant':
      return place
        ? `You are working in ${place}. Finish work there first, then come back here.`
        : 'You are working in another account. Finish work there first, then come back here.';
    case 'session_on_other_campaign':
      return 'You are working on another list. Finish work there first, then come back here.';
    case 'feature_disabled':
      return 'Calls are turned off for your team. Ask your supervisor.';
    case 'account_scope_required':
      return 'Open your work again from your home screen.';
    case 'station_token_unavailable':
    case 'dial_failed':
      return 'Calls could not start just now. Go back and try again in a moment.';
    case 'campaign_not_running':
      return 'Calls are stopped for this work right now. Ask your supervisor.';
    default:
      break;
  }
  if (input.status === 404) return 'This work was not found. Ask your supervisor.';
  if (input.status === 403) return 'You cannot open this work. Ask your supervisor.';
  if (input.status === null) return 'Check your internet. Then go back and try again.';
  return 'We could not open your work just now. Go back and try again.';
}

/**
 * The one-press switch from another list failed (`useStationJoin`'s three steps): reaching that
 * list, leaving it, or opening this one after leaving it. `name` is that list's name. The step says
 * what is true now: nothing changed, it is still open, or it is closed and this one did not open.
 */
export function switchFailedLine(stage: 'resume' | 'leave' | 'rejoin', name: string, code: string | null): string {
  switch (stage) {
    case 'resume':
      if (code === 'station_on_other_device') return `${name} is open on another device. Finish work there, then come back here.`;
      return `We could not reach ${name}. Nothing changed. Try again.`;
    case 'leave':
      return `${name} is still open. Nothing changed. Try again.`;
    case 'rejoin':
      return `You left ${name}, but this work did not open. Go back and open it again.`;
  }
}

/** Close the soft phone and start here: what went wrong, in the station's words. */
export const SOFTPHONE_CLOSE_COPY = {
  /** The close failed: the soft phone is still open. */
  stillOpen: 'Your soft phone is still open. Try again.',
  /** The refusal named no session and the soft phone's own read had none either. */
  notFound: 'We could not find your soft phone to close. Open the soft phone and close it there.',
  /** It was opened again (another window) between the close and the start. */
  reopened: 'The soft phone was opened again, maybe in another window. Close it there, or try again.',
  /** The soft phone closed, but this work did not open. */
  closedNotOpened: 'The soft phone is closed, but your work did not open. Go back and open it again.',
} as const;

/** Dial a number myself refused: `POST /sessions/:id/softphone`. Nothing changed. */
export function softphoneSwitchRefusedLine(code: string | null): string {
  switch (code) {
    case 'softphone_disabled':
      return 'Dialling a number yourself is turned off. Ask your supervisor.';
    case 'manual_call_live':
    case 'outcome_pending':
    case 'attempt_not_dispositionable':
      return STATION_COPY.finishCallFirst;
    case 'session_not_found':
    case 'session_ended':
    case 'wrong_session_kind':
      return 'Your work was closed. Open today’s work again.';
    default:
      return 'You cannot dial a number yourself just now. Nothing changed. Try again in a moment.';
  }
}

/** Back to my calls refused: `POST /sessions/:id/softphone/return`. The soft phone stays. */
export function backToCallsRefusedLine(code: string | null): string {
  switch (code) {
    case 'manual_call_live':
    case 'outcome_pending':
      return STATION_COPY.finishCallFirst;
    case 'session_not_found':
    case 'session_ended':
    case 'wrong_session_kind':
      return 'Your work was closed. Open today’s work again.';
    case 'not_on_softphone':
      return 'One moment. Try again.';
    default:
      return 'You could not go back to your calls just now. Try again in a moment.';
  }
}

/**
 * A break refused (`POST /sessions/:id/break`), said on Which break?, which opens again for it.
 * `unknown_break_reason` has re-read the list, so the agent chooses again from what is there.
 */
export function breakRefusedLine(code: string | null): string {
  switch (code) {
    case 'unknown_break_reason':
      return 'You cannot take that break now. Choose another.';
    case 'manual_call_live':
    case 'outcome_pending':
      return 'Finish your call on the soft phone and save it first.';
    case 'session_ended':
    case 'session_not_found':
    case 'wrong_session_kind':
    case 'no_station':
      return 'Your work was closed. Open today’s work again.';
    case 'state_changing':
    case 'dial_failed':
      return 'Your break did not start. Try again.';
    default:
      return 'Your break did not go through. Try again.';
  }
}

/** End call refused or failed: `POST /attempts/:id/hangup`. The call is still on. */
export function hangupFailedLine(code: string | null): string {
  switch (code) {
    case 'not_your_attempt':
      return 'This call has moved on. You cannot end it from here.';
    case 'attempt_not_live':
      return 'We cannot end this call from here. Ask the customer to hang up.';
    default:
      return 'The call did not end. You are still on the call. Try again.';
  }
}

/** Stop calling this number: done. `recorded` false: the number could not go on the list. */
export function dncDoneLine(recorded: boolean): string {
  return recorded
    ? 'Done. We will not call this number again.'
    : 'We will not call this customer again from this list. Ask your supervisor to check the number.';
}

/** Stop calling this number: refused or failed. Nothing was changed. */
export function dncFailedLine(code: string | null): string {
  switch (code) {
    case 'not_your_attempt':
      return 'This call has moved on. Nothing was changed.';
    case 'unknown_attempt':
      return 'That call has already ended. Nothing was changed.';
    default:
      return 'That did not go through. Nothing was changed. Try again.';
  }
}

/** Call again refused (wrap-up redial). `status` null or 5xx: no answer, so it may still ring. */
export function redialRefusedLine(code: string | null, status: number | null): string {
  switch (code) {
    case 'redial_not_allowed':
      return 'You cannot call this number again now. Choose what happened.';
    case 'redial_limit_reached':
      return 'No more tries left for this number. Choose what happened.';
    case 'disposition_already_submitted':
      return 'What happened is already saved for this call.';
    case 'redial_blocked_dnc':
      return 'We must not call this number. Choose what happened.';
    case 'redial_blocked_calling_hours':
      return 'It is too late or too early to call this customer. Choose what happened.';
    case 'redial_blocked':
      return 'You cannot call this number again now. Choose what happened.';
    default:
      return status === null || status >= 500
        ? 'No answer yet. The call may still start. If it does not, try again or choose what happened.'
        : 'That did not go through. Try again, or choose what happened.';
  }
}

/** The microphone banner, by what went wrong (`AudioCaptureFailureKind`). */
export function micProblemLine(kind: string): { headline: string; remedy: string; action: string | null } {
  switch (kind) {
    case 'permission_denied':
      return { headline: 'Your microphone is blocked. The customer cannot hear you.', remedy: 'Allow the microphone for this site, then reload the page.', action: null };
    case 'no_device':
      return { headline: 'No microphone found. The customer cannot hear you.', remedy: 'Plug in your headset, then reload the page.', action: null };
    case 'device_busy':
      return { headline: 'Another app is using your microphone. The customer cannot hear you.', remedy: 'Close the other app, then reload the page.', action: null };
    case 'device_lost':
      return { headline: 'Your headset came off. The customer cannot hear you.', remedy: 'Plug your headset in again, then reload the page.', action: null };
    case 'audio_blocked':
      return { headline: 'Sound is off. You cannot hear the customer, and they cannot hear you.', remedy: 'Press Turn sound on to join the call again.', action: 'Turn sound on' };
    case 'unsupported':
      return { headline: 'This browser cannot use your microphone here.', remedy: 'Open this page in Chrome, Edge or Firefox.', action: null };
    default:
      return { headline: 'Your microphone did not open. The customer cannot hear you.', remedy: 'Reload the page. If it happens again, tell your supervisor.', action: null };
  }
}

/** Said when the outcome is saved: what was saved, and when we call again (the server's time). */
export function savedLine(input: { label: string; nextAttemptAt: string | null; callbackRequestedAt?: string | null; dncRecorded?: boolean }): string {
  let line = `Saved: ${input.label}.`;
  const when = input.nextAttemptAt === null ? Number.NaN : Date.parse(input.nextAttemptAt);
  if (input.nextAttemptAt !== null) {
    if (Number.isNaN(when)) line += ' We will call again as booked.';
    else {
      const at = `${weekdayDayMonth(when)}, ${clockTime(when)}`;
      const asked = input.callbackRequestedAt != null ? Date.parse(input.callbackRequestedAt) : Number.NaN;
      line += !Number.isNaN(asked) && asked !== when
        ? ` We will call again on ${at}, the first time we are allowed to call.`
        : ` We will call again on ${at}.`;
    }
  }
  if (input.dncRecorded === false) line += ' Ask your supervisor to check the number.';
  return line;
}

/** Save refused, by code. The answer the agent chose stays on screen. */
export function saveRefusedLine(code: string | null): string {
  switch (code) {
    case 'unknown_disposition_code':
      return 'The list of outcomes changed. Choose again.';
    case 'note_required':
      return 'Write a note for this one.';
    case 'datetime_required':
      return 'Choose when to call again.';
    case 'invalid_callback_at':
      return 'That time has passed. Choose when to call again.';
    case 'attempt_not_dispositionable':
      return 'This call was closed, so it cannot be saved now.';
    case 'already_dispositioned':
      return 'What happened is already saved for this call.';
    case 'not_your_attempt':
      return 'This call has moved on. It is not yours to save.';
    case 'session_ended':
      return 'Your work was closed. Open today’s work again.';
    default:
      return 'Not saved. Try again.';
  }
}

/** The last call's outcome was not saved (its answer came back for a call no longer on screen). */
export const LAST_OUTCOME_LOST = 'What happened on your last call was not saved.';

/** Why an inbound call left the screen without the agent's outcome. */
export const INBOUND_NOTICE_COPY = {
  hungUpEarly: 'The customer hung up before you were connected.',
  requeued: 'The call went back to wait for another agent while your screen was away.',
  windowEnded: 'Time to save what happened ran out, so the call was closed.',
  closedBySupervisor: 'A supervisor closed this call.',
} as const;
