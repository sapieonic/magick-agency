import 'package:agency_wire/agency_wire.dart' show deviceAwayReturnGrace;
import '../../core/station/station_view.dart';
import '../softphone/softphone_copy.dart';
import 'logic/disposition_form.dart';
import 'logic/format.dart';

/// Every sentence the station screen says, in one place so it can be
/// localised later.
///
/// The wording follows the agent station's design spec (`docs/agent-station/design-spec.md`)
/// and the console's station copy (`stationCopy.ts` and its neighbours), so an agent who uses both reads the same
/// sentences; only what is genuinely different on a phone (Settings instead
/// of a browser permission, "the app" instead of "this tab") is changed.
abstract final class StationCopy {
  // ── The redesign (design-spec §3, AS15): simple Indian English, no jargon ──────────────────
  // Never on an agent screen: disposition, wrap-up, pacing, session, station, SIP, WebRTC, DNC,
  // callback, campaign, reserved, available, offline, reconnecting.

  // Top bar.
  static const more = 'More';
  static const helpAskedLabel = 'Help asked';
  static String helpAsked(String clock) => 'Help asked · $clock';
  static const offlineHelpTitle = 'No internet';
  static const offlineHelp = 'Call your supervisor to your desk.';

  // ⋮ More.
  static const myCustomers = 'My customers';
  static const dialMyself = 'Dial a number myself';
  static const sound = 'Sound';
  static const soundTitle = 'Sound and screen';
  static const soundCalls = 'Sounds';
  static const soundCallsDetail = 'A sound when a call comes and ends.';
  static const vibration = 'Vibration';
  static const vibrationDetail = 'Feel a call come and connect.';
  static const darkScreen = 'Dark screen';
  static const darkScreenDetail = 'On this phone only.';
  static const finishWork = 'Finish work for today';

  // 01 Start of day.
  static String namaste(String? name) {
    final first = name == null ? '' : firstName(name);
    return first.isEmpty ? 'Namaste' : 'Namaste, $first';
  }
  static const startSubtitle = 'Press Start work when you are ready.';
  static const todaysWork = 'Today’s work';
  static const howWillYouWork = 'How will you work?';
  static const callsComeToMe = 'Calls come to me';
  static const iDialTheNumber = 'I dial the number';
  static const supervisorMayListen = 'Your supervisor may listen to calls for training.';
  static const startWork = 'Start work';
  static const starting = 'Starting…';
  static const callLater = 'Call later';
  static String callLaterToday(int n) => '$n today';
  static const target = 'Target';
  static String targetCalls(int n) => '$n calls';

  // 02 Ready.
  static const ready = 'Ready';
  static const readySubtitle = 'Next call is coming. Stay here.';
  static const nextCallComing = 'Next call is coming…';
  static String waiting(String clock) => 'Waiting: $clock';
  static const myDay = 'My day';
  static const callsToday = 'Calls today';
  static const talkTime = 'Talk time';
  static const willPay = 'Will pay';
  static const dialled = 'Numbers dialled';
  static const myCallLaterList = 'My call-later list';
  static const callLaterComesToYou = 'These calls will come to you on time.';
  static const callLaterPool = 'We will call them on time. Another agent may get the call.';
  static const customer = 'Customer';
  static const late = 'Late';
  static String inMinutes(int m) => m <= 0 ? 'now' : (m == 1 ? 'in 1 min' : 'in $m min');
  static const lastCallNotConnected = 'The last call did not connect. You do not need to do anything.';
  static const takeABreak = 'Take break';

  // 02c No calls right now.
  static const noCallsNow = 'No calls right now';
  static const callsWillStart = 'Calls will start again';
  static const nothingToDo = 'You do not need to do anything.';
  static const callsStoppedBySupervisor = 'Your supervisor has stopped calls. Stay on this screen.';

  /// 02c's subtitle while calls are stopped, by why (the console's `NO_CALLS_STOPPED_WORDS`, word for
  /// word).
  static String callsStopped(CallsStopped? why) => switch (why) {
    CallsStopped.bySupervisor => callsStoppedBySupervisor,
    CallsStopped.autoPaused => 'Calls are paused for a short while. Stay on this screen.',
    CallsStopped.listFinished => 'Every customer on this list has been called.',
    CallsStopped.notStarted || null => 'Calls have not started yet. Stay on this screen.',
  };
  static const noCustomersWaiting = 'No customers are waiting. Stay on this screen.';
  static String nextCallAt(String at) => 'Your next call is at $at.';
  static String callsStartAt(String at) => 'Calls start at $at.';
  static const callsStartLater = 'Calls start again later. Stay on this screen.';
  static const customersWhoRingIn = 'Customers who ring in can still reach you.';

  // 03 Call coming.
  static const callComing = 'Call coming';
  static const callComingSubtitle = 'Get ready. Say Namaste first.';
  static const customerCalling = 'Customer is calling';
  static const connectsByItself = 'The call connects by itself.';
  static const lastCall = 'Last call';
  static const whatTheySaid = 'What they said last time';
  static String youSaidYouWillCall(String at) => 'Call later · You said you will call at $at';
  static String bookedFor(String at) => 'Call later · Booked for $at';
  static const firstSayThis = 'First, say this';
  static const whatToSay = 'What to say';
  static String stepsDone(int done, int of) => '$done of $of done';
  static const allStepsDone = 'All steps done';
  static const readAloud = 'Read aloud';
  static String callAgainOf(int n, int? limit) => limit == null || limit < n ? 'Calling again' : 'Calling again · $n of $limit';

  // 04 On call.
  static const recorded = 'Recorded';
  static const unmute = 'Unmute';
  static const speaker = 'Speaker';
  static const onMute = 'You are on mute. The customer cannot hear you.';
  static const lastCalls = 'Last calls';
  static const slideToEnd = 'Slide to end call';
  static const endCall = 'End call';
  static const endCallHint = 'Slide to the right to end the call';
  static const ending = 'Ending…';
  static String breakAfterThisCall(String label) => '$label after this call';

  // 05 What happened?
  static const whatHappened = 'What happened?';
  static const chooseOneThenSave = 'Choose one. Then press Save.';
  static const timeLeft = 'Time left';
  static const timeOver = 'Time is over';
  static const timeOverBanner = 'Time is over. Choose one now. Your supervisor can see that you are still on this screen.';
  static const heldBanner = 'Your supervisor is holding this screen. Choose one, then press Save.';
  static const callWasCut = 'The call was cut. Choose what happened, or call again.';
  static const saveAndNext = 'Save & next call';
  static const saveAndBreak = 'Save & break';
  static String callAgainLeft(int n) => 'Call again · $n left';
  static const callingAgain = 'Calling…';
  static const chooseOneFirst = 'Choose one first.';
  static const writeANote = 'Write a note for this one.';
  static const chooseWhen = 'Choose when to call.';
  static const timeGone = 'That time is over. Choose a new time.';
  static const choosePayDate = 'Choose the pay date.';
  static const amountNotRight = 'Write the amount in numbers only, like 12500.';
  static const noteHint = 'Write a note…';
  static const speakNote = 'Speak a note';
  static const change = 'Change';
  static const ok = 'OK';
  static const back = 'Back';
  static const callWhen = 'Call when?';
  static String willPayOn(String date, String? amount) => amount == null ? 'Will pay on $date' : 'Will pay on $date · $amount';
  static String callLaterOn(String when) => 'Call later · $when';
  static String callWillComeToYou(String when) => 'This call will come to you on $when.';
  static String callWillBeMade(String when) => 'We will call on $when. Another agent may get the call.';
  /// A caller on no list: nobody calls them back by themselves (the console's `callBackYourself`).
  static String callBackYourself(String when) =>
      'This time is saved with the call. No one will call by themselves, so call back on $when yourself.';
  static String weWillCallAgain(String date) => 'We will call again on $date.';
  static const dontCallAgain = 'Don’t call again';
  static const moreOutcomes = 'More';
  static String moreOutcomesHint(int n) => '$n more';
  static const stopCallingTitle = 'Stop calling this customer?';
  static const stopCallingBody = 'We will not call this number again for this work. You cannot change this later.';
  static const noGoBack = 'No, go back';
  static const yesStopCalls = 'Yes, stop calls';
  static String savedAs(String label) => 'Saved · $label';
  static const nextCallSoon = 'Your next call comes after this screen.';

  // 06 Which break?
  static const whichBreak = 'Which break?';
  static const whichBreakAfterCall = 'It starts after this call.';
  static const whichBreakNow = 'No calls will come while you are on break.';
  static String minutes(int m) => '$m min';
  static const noBreakReasons = 'Breaks are not set up yet. Ask your supervisor.';

  // 07 On break, 08 Break over.
  static String onBreakTitle(String? label) => label == null || label.trim().isEmpty ? 'On break' : 'On break · $label';
  static const noCallsWillCome = 'No calls will come now.';
  static String leftOfYour(String clock, int limit) => '$clock left of your $limit minutes.';
  static const breakTimeOver = 'Break time is over';
  static String youAreLate(String clock) => 'You are $clock late. Start calls now.';
  static String yourBreakWas(int limit) => 'Your break was $limit minutes. Your supervisor can see this.';
  static String longBreak(int minutes) => 'You have been on break for $minutes minutes.';
  static const startCallsAgain = 'Start calls again';

  // Paused, you left the app (device_away).
  static const pausedTitle = 'Paused';
  static const pausedSubtitle = 'You left the app. No calls came.';
  static String pausedSince(String at) => 'Paused at $at.';
  static const pausedRinging = 'This phone rings for customers who call in while you are away.';

  // 09 Internet problem, 10 Call problem.
  static const internetProblem = 'Internet problem';
  static const internetProblemSubtitle = 'Calls are stopped. We are trying again.';
  static const internetStopped = 'Calls are stopped. Press Try again now.';
  static const whatToDo = 'What to do';
  static const stepCheckInternet = 'Check the internet cable or Wi-Fi.';
  static const stepWait = 'Wait. Calls start again by themselves.';
  static const stepCallSupervisor = 'Still not working? Call your supervisor to your desk.';
  static const tryAgainNow = 'Try again now';
  static const tryingAgain = 'Trying again…';
  static const callProblem = 'Call problem';
  static const callProblemSubtitle = 'Stay here. We are joining the call again.';
  static String callKeptFor(String clock) => 'Call is kept for $clock';
  static const stepDoNotClose = 'Do not close this app.';
  static const stepSaySorry = 'If the call comes back, say sorry and go on.';
  static const stepCallAgain = 'If it does not, you can call again.';
  static const internetSlow = 'Slow internet';

  // 11 Finish work.
  static const finishWorkTitle = 'Finish work for today?';
  static const finishWorkSubtitle = 'No more calls will come to you.';
  static const noKeepWorking = 'No, keep working';
  static const yesFinishWork = 'Yes, finish work';
  static const finishing = 'Finishing…';
  static String leftForToday(int n, String at, {required bool? pool}) {
    final head = n == 1 ? '1 call later is left for today ($at).' : '$n call-laters are left for today (first at $at).';
    return switch (pool) {
      true => '$head Another agent will make ${n == 1 ? 'it' : 'them'}.',
      false => '$head ${n == 1 ? 'It waits' : 'They wait'} for you.',
      null => head,
    };
  }
  static const finishCallFirst = 'Finish this call first. Leaving now would cut the customer off.';

  // 12 Open on another device.
  static const otherDeviceTitle = 'Your work is open on another device';
  static const otherDeviceSubtitle = 'Only one device can take calls at a time.';
  static const otherDeviceBody = 'No calls will come to this phone now.';
  static const useThisPhoneNow = 'Use this phone';
  static const workEnded = 'Your work here has ended';
  static const workEndedDetail = 'Start again from your list of work.';
  static const cannotStart = 'Work could not start';
  static const backToWork = 'Back to my work list';
  static const opening = 'Opening…';

  // ── Phase labels: the header pill and the screen-reader announcement ──
  static const onCall = 'On call';

  /// What the polite live region says when the phase changes. The soft phone
  /// is a break to the dialer, not to the agent: it is said as what it is.
  static String announce(AgentPhase phase, {String? breakLabel, bool deviceAway = false, bool softphone = false}) => switch (phase) {
    AgentPhase.offline => 'Not taking calls yet',
    AgentPhase.available => 'Ready. Next call is coming',
    AgentPhase.reserved => 'Call coming',
    AgentPhase.onCall => 'On call',
    AgentPhase.wrapup => 'What happened?',
    AgentPhase.onBreak when deviceAway => 'Paused because you left the app',
    AgentPhase.onBreak when softphone => onTheSoftphone,
    AgentPhase.onBreak => onBreakTitle(breakLabel),
  };
  static const onTheSoftphone = 'On the soft phone';

  /// Reserved with no call on the station yet (`StationStage.incoming`): the moment before an
  /// inbound offer lands, or a reconnect's `ready` saying `reserved` before the call (inbound,
  /// or a campaign dial) is restated. Words for either direction, on screen and said aloud.
  static const callComingThrough = 'A call is coming through';

  // ── Header ──

  // ── Monitoring and recording (docs/listening.md LS2) ──
  // While the account allows listening, the agent is told so: a standing line behind the info
  // button on the station and the soft phone, and once, in place, the first time on this phone
  // for an account. The console's words (`LISTEN_AGENT_NOTICE`, `LISTEN_AGENT_INFO_LABEL`,
  // `LISTEN_AGENT_FIRST_NOTICE`). Not a live indicator.
  static const listenInfo = 'Monitoring and recording';
  static const listenNotice = 'Calls may be listened to by a supervisor for quality and training.';
  static const listenFirstDetail = 'You can read this again at any time: press ⋮ More, then $listenInfo.';
  // The standing line is under ⋮ More between calls (on a call the menu holds only Sound), so the
  // notice on a call says where it is between calls. The app's own words.
  static const listenFirstDetailOnCall = 'You can read this again between calls: press ⋮ More, then $listenInfo.';
  static const listenFirstDismiss = 'Got it';

  // ── Waiting ──
  // Says nothing about when the customer's details appear: on a late-binding account they
  // appear only when the customer answers, and the app does not know which kind it is on.
  // A paused campaign stops campaign calls only: the inbound router does not read campaign
  // status, so customers who ring in still reach an available agent.

  // ── Hidden dials (late binding): the console's station copy ──
  // A dial ringing for this agent that they are shown only if it is answered. Never the
  // number, the name or anything else about the contact.
  static const diallingHeadline = 'Dialling a customer…';

  /// The line under the headline after hidden dials went unanswered; null for none.
  static String? unansweredLine(int unansweredInARow) => unansweredInARow <= 0
      ? null
      : unansweredInARow == 1
          ? 'No answer from the last number'
          : 'No answer from the last $unansweredInARow numbers';

  // ── Nothing due (contact assignment: a strict or preferred campaign) ──
  static const nothingDueHeadline = 'Nothing due now';

  /// Why nothing is due for the agent, and when the next contact is ([at],
  /// already formatted; null when none is scheduled).
  static String nothingDueDetail(QueueIdle reason, String? at) => switch (reason) {
    QueueIdle.queueEmpty => 'No contacts are waiting for you. Your supervisor can assign more.',
    QueueIdle.waitingForRetry => at == null
        ? 'Your contacts are scheduled for another try later.'
        : 'Your contacts are scheduled for another try. The next one is due at $at.',
    QueueIdle.callbacksLater => at == null
        ? 'Your call-laters are booked for later.'
        : 'Your call-laters are booked for later. The next one is at $at.',
    QueueIdle.outsideCallingHours => at == null
        ? 'It is outside calling hours.'
        : 'It is outside calling hours. Calls start again at $at.',
    QueueIdle.other => at == null ? 'No calls are due for you right now.' : 'Your next contact is due at $at.',
  };

  // ── Offline ──

  // ── Break ──
  static String breakFor(String clock) => 'On break for $clock';

  static const endingBreak = 'Ending break…';

  // ── Paused because the agent left the app (device_away) ──
  // Mode B's `away_ring`: the same pause, with this phone rung for inbound callers. Its headline is
  // the app's one label for it (`awayRingBreakLabel`).

  /// Paused rather than rung, though ringing is on for this phone.
  static String awayNoRing(String why) => 'This phone won’t ring for inbound calls: $why.';

  /// IQ50: under the away card's detail. The window is the controller's own.
  static final awayAutoReturnHint = 'Come back within ${deviceAwayReturnGrace.inSeconds} seconds and you’re '
      'returned to calls without a tap.';
  static const breakInstead = 'Take a break instead';

  // ── Break sheet ──
  static const cancel = 'Cancel';

  // ── Queued break ──
  static const breakAfterCall = 'Break after this call';
  static const cancelQueuedBreak = 'Cancel the break after this call';

  // ── Switch to the soft phone (SP7) ──
  // The Phone tab's words, so both places name it the same.
  static const switchHint = 'Dial customers yourself. You can come back to your calls.';
  static const switchAfterCallHint = 'Switches when you finish this call.';

  /// The queued switch's pill (the console's words).
  static const switchQueued = SoftphoneCopy.switchQueued;
  static const cancelSwitch = 'Cancel the switch';

  // ── Ringing ──
  static const autoSelected = 'auto-selected';
  static const autoSelectedHint = 'Picked automatically from the contact’s details.';
  static String priorAttempts(int n) => 'Prior attempts ($n)';
  static const thisCampaign = 'This work';
  static String moreAttempts(int n) => '+$n more in Details';
  static String otherCampaign(String? name) => name == null || name.trim().isEmpty ? 'Other work' : name;
  static String moreDetails(int n) => 'More details ($n)';
  static const filterFields = 'Filter fields';
  static const filterHint = 'Type to find a field…';
  static String fieldCount(int shown, int total) =>
      shown == total ? '$total field${total == 1 ? '' : 's'}' : '$shown of $total field${total == 1 ? '' : 's'}';
  static String noFieldMatches(String q) => 'No fields match “$q”.';
  static const noExtraDetails = 'No extra details were uploaded for this contact.';
  static String emptyFields(int n) => '$n empty field${n == 1 ? '' : 's'}';

  // ── On call ──
  static const mute = 'Mute';
  static const muted = 'Muted';
  static const audio = 'Audio';
  static const audioSheetTitle = 'Where to hear the call';
  static const noRoutes = 'Only this phone can be used right now.';
  static const details = 'Details';
  static const detailsTitle = 'Contact details';
  static const markingDnc = 'Stopping…';

  // ── Hang up ──
  static const hangUpConfirmTitle = 'End this call?';
  static const hangUpConfirmBody = 'The customer will be cut off.';
  static const keepCall = 'Keep the call';

  // ── Mark DNC (agencyDncCopy) ──
  static const dncNotMarked = 'The call ended before this was saved, so nothing was changed.';

  // ── Notes (agencyNotes) ──
  static const notes = 'Note';
  static const notesRequired = 'Note (needed)';
  static String notesStatus(NotesStatus s) => switch (s) {
    NotesStatus.idle => 'Saves as you type.',
    NotesStatus.saving => 'Saving…',
    NotesStatus.saved => 'Saved',
    NotesStatus.retrying => 'Not saved yet — trying again. Still on this phone.',
    NotesStatus.failed => 'Not saved to the server. Still on this phone — keep the app open.',
    NotesStatus.closed => 'The note is closed for this call.',
  };
  static const notesChangedElsewhere = 'Your supervisor also changed this note.';

  // ── Interruptions and the microphone (agencyAudioCopy, for phones) ──
  static const phoneCallTitle = 'Your phone took another call';
  static const phoneCallSubtitle = 'The customer can’t hear you';
  static const phoneCallBody = 'A phone call came in on your SIM. Your mic was muted so the customer doesn’t hear it.';
  static const otherAppTitle = 'Another app took the audio';
  static const otherAppBody = 'Your mic was muted so the customer doesn’t hear it.';
  static String backTo(String? name) =>
      name == null || name.trim().isEmpty ? 'Back to the call (unmute)' : 'Back to ${firstName(name)} (unmute)';

  static String micHeadline(MicProblem p) => switch (p) {
    MicProblem.permissionDenied => 'Your microphone is blocked — the customer cannot hear you.',
    MicProblem.noDevice => 'No microphone was found — the customer cannot hear you.',
    MicProblem.busy => 'Your microphone is in use by another app — the customer cannot hear you.',
    MicProblem.lost => 'Your microphone disconnected — the customer cannot hear you.',
    MicProblem.serviceStopped => 'If you leave the app, your phone may cut the microphone mid-call.',
    MicProblem.none => '',
  };
  static String micRemedy(MicProblem p) => switch (p) {
    MicProblem.permissionDenied => 'Allow the microphone for Magick Agency in your phone’s Settings.',
    MicProblem.noDevice => 'Reconnect your headset, or pick the phone in Audio.',
    MicProblem.busy => 'Close the other app using it, then come back here.',
    MicProblem.lost => 'Reconnect your headset, or pick the phone in Audio.',
    MicProblem.serviceStopped => 'Keep Magick Agency on screen. It tries again each time you come back to it.',
    MicProblem.none => '',
  };
  static const openSettings = 'Open Settings';

  // ── Wrap-up ──
  static const heldBySupervisor = 'Held by your supervisor';
  static const save = 'Save';
  static const savingOutcome = 'Saving…';
  static const outcomeSavedAnnouncement = 'Saved';
  static String blockCopy(DispositionBlock b) => switch (b) {
    DispositionBlock.noSelection => chooseOneFirst,
    DispositionBlock.noteRequired => writeANote,
    DispositionBlock.callbackRequired => chooseWhen,
    DispositionBlock.callbackInPast => timeGone,
    DispositionBlock.promiseRequired => choosePayDate,
    DispositionBlock.promiseDateInvalid => 'Choose a pay date from today up to 30 days ahead.',
    DispositionBlock.promiseAmountInvalid => amountNotRight,
  };

  // ── Promise to pay (PT1–PT3, PT9) ─────────────────────────────────────────
  static const promiseTitle = 'When will the customer pay?';
  static const promiseToday = 'Today';
  static const promiseTomorrow = 'Tomorrow';
  static const promiseInAWeek = 'In a week';
  static const promisePick = 'Pick a date';
  static const promiseDateHelp = 'Promised payment date';
  static const promiseAmountLabel = 'Amount (optional)';
  // The Full / Half chips (spec §3 05): the customer's amount due and half of it, with no ₹ (PT5:
  // a promised amount carries no currency yet).
  static const fullAmount = 'Full';
  static const halfAmount = 'Half';
  static String amountChip(String label, String amount) => '$label · $amount';
  static String promiseStanding(PromiseStanding s) => switch (s) {
    PromiseStanding.upcoming => 'Upcoming',
    PromiseStanding.dueToday => 'Due today',
    PromiseStanding.missed => 'Missed',
    PromiseStanding.followedUp => 'Followed up',
    PromiseStanding.unknown => '',
  };
  static const success = 'Success';
  static const stopsCalling = 'Stops calling';

  // ── Wrap-up redial ──
  static const redialling = 'Redialling…';



  // ── Callback ──
  static const callbackTitle = 'When should we call back?';
  static String callbackChip(CallbackChoice c) => switch (c) {
    CallbackChoice.inOneHour => 'In 1 hour',
    CallbackChoice.tomorrowMorning => 'Tomorrow 10 am',
    CallbackChoice.tomorrowEvening => 'Tomorrow 6 pm',
    CallbackChoice.picked => 'Pick…',
    CallbackChoice.todayEvening => 'Today 6 pm',
  };

  /// What happened?'s Call when? chips (05b).
  static String stationCallbackChip(CallbackChoice c) => switch (c) {
    CallbackChoice.inOneHour => 'In 1 hour',
    CallbackChoice.todayEvening => 'Today 6:00 PM',
    CallbackChoice.tomorrowMorning => 'Tomorrow 10:00 AM',
    CallbackChoice.tomorrowEvening => 'Tomorrow 6:00 PM',
    CallbackChoice.picked => 'Other time',
  };
  static String callbackTimezone(String zone) =>
      'Times are in your timezone${zone.isEmpty ? '' : ' ($zone)'}. We don’t have the customer’s — say the time out loud to agree it.';
  static const callbackGroundTruth = 'We will call at this time. Another agent may get the call.';
  static const callbackDateHelp = 'Call back on';
  static const callbackTimeHelp = 'Call back at';

  // ── Link states (the station band) ──
  static const connecting = 'Getting your calls ready…';

  static const supersededNote = 'If a call is live, the customer hears a short gap while it moves.';



  static const notHereTitle = 'This work is not open here';
  static const notHereDetail = 'Start from your list of work to take calls.';
  static String elsewhereTitle(String campaign) => 'Your work is open on $campaign';
  static const openIt = 'Open it';

  // ── Missed release and errors ──
  static const dismiss = 'Dismiss';

  // ── Leave (agencyStationExit) ──

  /// "Priya" from "Priya Raman": a button names the person the agent is talking to.
  static String firstName(String name) {
    final parts = name.trim().split(RegExp(r'\s+'));
    return parts.isEmpty ? name : parts.first;
  }

  // ── Need help (floor assist, LF4) ──
  static const needHelp = 'Need help';
  static const needHelpHint = 'Every supervisor on your account will see that you asked.';
  static const askingForHelp = 'Asking for help…';
  static const helpRequested = 'Help requested';
  static const cancellingHelp = 'Cancelling…';
  static const cancelHelpLabel = 'Cancel your request for help';
  static const cancellingHelpLabel = 'Cancelling your request for help';
  static const dismissHelp = 'Dismiss';

  // ── A supervisor's message (floor assist, LF5) ──
  static String messageFrom(String from, String time) => '$from · $time';
  static String messageAnnouncement(String from, String text) => 'Message from $from: $text';
  static String moreMessages(int n) => n == 1 ? '1 more message' : '$n more messages';
  static const dismissMessageLabel = 'Dismiss this message';
}

/// What the station says about an inbound call, in the console's words
/// (`utils/inbound/inboundCall.ts`, `InboundCallView.tsx`, `CustomerWaitingPill.tsx`).
abstract final class InboundCopy {
  // ── Who rang ──
  static const numberWithheld = 'Number withheld';

  /// Who is on the line, in the fewest words: the name, else the number (masked when the campaign
  /// masks numbers, AS9), else "Number withheld".
  static String who(InboundCallView call, {required bool masked}) {
    final name = call.displayName?.trim();
    if (name != null && name.isNotEmpty) return name;
    final from = call.fromE164;
    return from == null ? numberWithheld : stationPhone(from, masked: masked);
  }
  static const inboundCall = 'Inbound call';

  /// "Your customer" and why (`sticky.is_you`); otherwise whose customer they usually are.
  static String sticky(InboundSticky reason, {required bool isYou}) {
    if (!isYou) return 'Usually speaks to another agent, who isn’t free';
    return switch (reason) {
      InboundSticky.owner => 'Your customer: their contact is assigned to you',
      InboundSticky.lastFromNumber => 'Your customer: you last called them from this number',
      InboundSticky.lastConnected => 'Your customer: you last spoke to them',
      InboundSticky.lastDialled => 'Your customer: you last called them',
      InboundSticky.other => 'Your customer',
    };
  }

  static const recorded = 'Recording';
  static const notRecorded = 'Not recorded';
  static const dncBadge = 'Asked not to be called';
  static const dncEnquiry =
      'This customer asked us not to call. They called us, so help them now. Do not call them back unless they ask.';
  static const theyRang = 'They called';
  static const route = 'Line';
  static const beforeYou = 'Waited';
  static const work = 'Work';
  static const notInAnyWork = 'Not in any work';
  static String matchLine(String work, String? state) => state == null ? work : '$work · $state';

  /// "Waited 1 min 5 s": how long the caller held before this offer.
  static String waited(int seconds) {
    final s = seconds < 0 ? 0 : seconds;
    if (s < 60) return 'Waited $s s';
    final m = s ~/ 60;
    final rest = s % 60;
    return rest == 0 ? 'Waited $m min' : 'Waited $m min $rest s';
  }

  static String noMatch({required bool withheld}) => withheld
      ? 'The number is hidden. Ask the customer’s name and number and write them in the note.'
      : 'We do not know this number. Ask the customer’s name and write it in the note.';

  // ── The band ──
  static const connecting = 'Connecting…';
  static String incomingFrom(String who) => 'From $who · $connecting';
  static String onCallWith(String who) => '$who · Inbound';
  static String outcomeDetail(String who) => 'The call with $who ended. Choose one. Then press Save.';

  /// "Without one, it closes in 29:41": the words around the countdown's digits.
  static const lapsePrefix = 'Without one, it closes in';
  static String lapseSemantics(String clockTime) => 'If you do not choose, this call closes at $clockTime.';

  // ── Hang up ──
  static const hangupConnecting = 'Connecting you to the caller…';

  // ── Don't call again (the console's `SIDE_COPY.stopBodyWork` / `stopBodyAll`) ──
  /// The caller's number goes on the matched campaign's list ([work], its name), else the
  /// account's.
  static String stopCallingBody(String? work) => work == null || work.trim().isEmpty
      ? 'We will not call this number again for any work in this account. You cannot change this later.'
      : 'We will not call this number again for ${work.trim()}. You cannot change this later.';
  static const dncWithheld = 'The caller withheld their number.';
  static const dncNotMarked = 'The call moved on before this was saved, so nothing was changed.';

  // ── Details ──
  static const detailsTitle = 'Caller details';

  // ── "Your customer is waiting" ──
  static String customerWaiting(String? who) => who == null ? 'Your customer is waiting' : 'Your customer is waiting: $who';
  // Not a promise to put them through: under the default `loose` mode a teammate takes them
  // after 30 s.
  static const customerWaitingHint =
      'A customer who usually speaks to you has rung in and is on hold. Finish this call’s work soon to take them.';

  // ── Announcements ──
  static String offerAnnouncement(String who) => 'Incoming call from $who';
  static const outcomeAnnouncement = 'What happened?';
}
