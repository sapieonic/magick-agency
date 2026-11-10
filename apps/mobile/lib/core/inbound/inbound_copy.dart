import 'package:agency_wire/agency_wire.dart';

import 'inbound_call_api.dart';
import 'inbound_call_rules.dart';

/// What the station core says about an inbound call (British English), in the console's words
/// (`utils/inbound/inboundCopy.ts`, `hooks/useInboundCall.ts`). The screens' own words are in
/// `features/station/station_copy.dart` (`InboundCopy`).

/// Every refusal the agent's call routes can give, keyed by the wire code; the route editor's
/// and the Missed list's codes are not met on the station and fall back to the server's sentence.
const Map<InboundErrorCode, String> inboundRefusalCopy = {
  InboundErrorCode.inboundDisabled: 'Inbound calls aren’t turned on for this account.',
  InboundErrorCode.inboundCallLive: 'An inbound call is in progress or still needs its outcome. Save the outcome first.',
  InboundErrorCode.inboundCallNotFound: 'We can’t find that call any more — it may already be closed.',
  InboundErrorCode.inboundCallNotDispositionable:
      'This call can’t take an outcome: it hasn’t ended, or nobody spoke to the caller.',
  InboundErrorCode.inboundDispositionInvalid:
      'That outcome can’t be saved. Check the outcome, its note and its callback time.',
  InboundErrorCode.inboundOutcomeAlreadySaved: 'This call’s outcome is already saved.',
};

/// Why the server refused an outcome (`inbound_disposition_invalid`'s `reason`), in words.
const Map<InboundDispositionRule, String> inboundDispositionRuleCopy = {
  InboundDispositionRule.unknownCode: 'The outcome list for this call changed. Pick one of these.',
  InboundDispositionRule.noteRequired: 'This outcome needs a note.',
  InboundDispositionRule.datetimeRequired: 'This outcome needs a callback time.',
  InboundDispositionRule.invalidCallbackAt: 'That callback time can’t be used. Pick a time in the future.',
};

/// The outcome window ended before an outcome was saved: the call was closed without one.
const inboundOutcomeWindowEndedCopy = 'The time to save this call’s outcome ran out, so it was closed without one.';

/// A supervisor closed the call before its window ended.
const inboundClosedBySupervisorCopy = 'A supervisor closed this call without an outcome.';
const inboundHungUpEarlyCopy = 'The caller hung up before you were connected.';
const inboundRequeuedCopy = 'The call went back to the queue while your station was away.';

/// How long the station says why a call left it.
const inboundNoticeDuration = Duration(seconds: 30);

/// Why a call left the station without the agent's outcome, in words.
String inboundLeftCopy(InboundLeftReason reason) => switch (reason) {
      InboundLeftReason.hungUpEarly => inboundHungUpEarlyCopy,
      InboundLeftReason.windowEnded => inboundOutcomeWindowEndedCopy,
      InboundLeftReason.closedBySupervisor => inboundClosedBySupervisorCopy,
      InboundLeftReason.requeued => inboundRequeuedCopy,
    };

/// A refusal in the console's words: ours for a known code, the server's sentence otherwise.
String inboundRefusalSentence(InboundRefusal refusal) => inboundRefusalCopy[refusal.code] ?? refusal.message;

/// An outcome refused, in the console's words: the rule when the server named one. "Already
/// saved" once the call's window has ended is the lapse closing it, not an outcome someone saved.
String inboundDispositionRefusalCopy(InboundRefusal refusal, {bool windowEnded = false}) {
  if (refusal.code == InboundErrorCode.inboundOutcomeAlreadySaved && windowEnded) return inboundOutcomeWindowEndedCopy;
  if (refusal.code == InboundErrorCode.inboundDispositionInvalid) {
    final rule = refusal.rule;
    return (rule == null ? null : inboundDispositionRuleCopy[rule]) ??
        inboundRefusalCopy[InboundErrorCode.inboundDispositionInvalid]!;
  }
  return inboundRefusalSentence(refusal);
}

String inboundHangupFailedCopy(InboundRefusal refusal) =>
    'We couldn’t end the call — you may still be connected. ${inboundRefusalSentence(refusal)}';

String inboundDncFailedCopy(InboundRefusal refusal) =>
    'We couldn’t add the number to Do Not Call. ${inboundRefusalSentence(refusal)}';

/// After Mark DNC: what the server recorded. [number] is already formatted for display.
String inboundDncOutcomeCopy(String number, {required String? campaignName}) =>
    '$number is on the Do Not Call list ${campaignName != null ? 'for $campaignName' : 'for this account'}.';

/// Save is pressed while the caller is still on the line.
const inboundSaveCallLiveCopy = 'Save unlocks when the call ends.';

/// Mark DNC with no number to mark.
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
const inboundOutcomeNotificationText = 'Outcome needed';
