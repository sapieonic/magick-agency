import 'package:agency_wire/agency_wire.dart';

import 'inbound_call_api.dart';
import 'inbound_call_rules.dart';

/// What the station core says about an inbound call, in the station's own words (AS15, the
/// console's `useInboundCall.ts`: `INBOUND_CALL_REFUSAL_WORDS`, `INBOUND_DISPOSITION_RULE_COPY` and
/// `stationCopy.ts`'s `INBOUND_NOTICE_COPY`), keyed on the server's code and never its sentence.
/// The screens' own words are in `features/station/station_copy.dart` (`InboundCopy`).

/// A refusal this build has no words for (a code the server added later, a 5xx): a safe line, never
/// the server's sentence. The console's `STATION_COPY.somethingWentWrong`.
const inboundSomethingWentWrongCopy = 'That did not go through. Try again in a moment.';

/// Every refusal the agent's call routes can give, keyed by the wire code (the console's
/// `INBOUND_CALL_REFUSAL_WORDS`).
const Map<InboundErrorCode, String> inboundRefusalCopy = {
  InboundErrorCode.inboundDisabled: 'Calls from customers are turned off for this account.',
  InboundErrorCode.inboundCallLive: 'Finish this call first. Choose what happened and press Save.',
  InboundErrorCode.inboundCallNotFound: 'We cannot find this call. It may be closed already.',
  InboundErrorCode.inboundCallNotDispositionable: 'You can choose what happened only after you have talked to the customer.',
  InboundErrorCode.inboundDispositionInvalid: 'That did not save. Check what you chose, the note and the time.',
  InboundErrorCode.inboundOutcomeAlreadySaved: 'This call is saved already.',
};

/// Why the server refused what the agent chose (`inbound_disposition_invalid`'s `reason`), in the
/// station's words (the console's `INBOUND_DISPOSITION_RULE_COPY`).
const Map<InboundDispositionRule, String> inboundDispositionRuleCopy = {
  InboundDispositionRule.unknownCode: 'This list changed. Choose one of these.',
  InboundDispositionRule.noteRequired: 'Write a note for this one.',
  InboundDispositionRule.datetimeRequired: 'Choose when to call.',
  InboundDispositionRule.invalidCallbackAt: 'That time is over. Choose a new time.',
  InboundDispositionRule.promiseRequired: 'Choose the pay date.',
  InboundDispositionRule.invalidPromiseDate: 'Choose a pay date from today up to 30 days ahead.',
  InboundDispositionRule.invalidPromiseAmount: 'Write the amount in numbers only, like 12500.',
  InboundDispositionRule.promiseNotExpected:
      'This choice does not take a pay date. Clear the pay date, or choose the one that does.',
};

/// The time to save what happened ran out: the call was closed without it.
const inboundOutcomeWindowEndedCopy = 'Time to save what happened ran out, so the call was closed.';

/// A supervisor closed the call before its window ended.
const inboundClosedBySupervisorCopy = 'A supervisor closed this call.';
const inboundHungUpEarlyCopy = 'The customer hung up before you were connected.';
const inboundRequeuedCopy = 'The call went back to wait for another agent while your screen was away.';

/// How long the station says why a call left it.
const inboundNoticeDuration = Duration(seconds: 30);

/// Why a call left the station without the agent's outcome, in words.
String inboundLeftCopy(InboundLeftReason reason) => switch (reason) {
      InboundLeftReason.hungUpEarly => inboundHungUpEarlyCopy,
      InboundLeftReason.windowEnded => inboundOutcomeWindowEndedCopy,
      InboundLeftReason.closedBySupervisor => inboundClosedBySupervisorCopy,
      InboundLeftReason.requeued => inboundRequeuedCopy,
    };

/// A refusal in the station's words: ours for a known code, else a safe generic line (the console's
/// `inboundCallRefusalWords`). Never the server's sentence.
String inboundRefusalSentence(InboundRefusal refusal) => inboundRefusalCopy[refusal.code] ?? inboundSomethingWentWrongCopy;

/// What the agent chose, refused: the rule when the server named one. "Already saved" once the
/// call's window has ended is the lapse closing it, not a save someone made.
String inboundDispositionRefusalCopy(InboundRefusal refusal, {bool windowEnded = false}) {
  if (refusal.code == InboundErrorCode.inboundOutcomeAlreadySaved && windowEnded) return inboundOutcomeWindowEndedCopy;
  if (refusal.code == InboundErrorCode.inboundDispositionInvalid) {
    final rule = refusal.rule;
    return (rule == null ? null : inboundDispositionRuleCopy[rule]) ??
        inboundRefusalCopy[InboundErrorCode.inboundDispositionInvalid]!;
  }
  return inboundRefusalSentence(refusal);
}

/// End call did not go through (the console's `SIDE_COPY.endCallFailed`), with the reason when the
/// code names one.
String inboundHangupFailedCopy(InboundRefusal refusal) {
  final why = inboundRefusalCopy[refusal.code];
  return why == null ? 'The call did not end. Try again.' : 'The call did not end. $why';
}

/// Don't call again did not go through (the console's `SIDE_COPY.stopFailed`).
String inboundDncFailedCopy(InboundRefusal refusal) {
  final why = inboundRefusalCopy[refusal.code];
  return why == null ? 'That did not go through. Nothing was changed. Try again.' : 'Nothing was changed. $why';
}

/// After Don't call again on an inbound caller: the console's `SIDE_COPY.stoppedCalls`. Never the
/// number (AS9: the matched campaign may mask it).
const inboundDncOutcomeCopy = 'We will not call this number again.';

/// Save is pressed while the caller is still on the line.
const inboundSaveCallLiveCopy = 'Save opens when the call ends.';

/// Don't call again with no number to add.
const inboundDncWithheldCopy = 'The caller withheld their number.';

/// The caller as the station names them when nothing better is known.
const inboundNumberWithheld = 'Number withheld';

/// The matched contact's state, in the agent's words (as customer history says it).
const inboundContactStateLabels = <ContactState, String>{
  ContactState.pending: 'Waiting to be called',
  ContactState.inFlight: 'On a call',
  ContactState.connected: 'Connected',
  ContactState.completed: 'Completed',
  ContactState.exhausted: 'Out of tries',
  ContactState.suppressed: 'Not called any more',
};

// ── The on-duty notification ──
const inboundOfferedNotificationText = 'Incoming call';
const inboundOnCallNotificationText = 'On a call';
const inboundOutcomeNotificationText = 'Choose what happened';
