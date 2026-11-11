import 'package:agency_wire/agency_wire.dart';

import '../../core/api/api_error.dart';
import '../../core/softphone/call_labels.dart' show formatDialNumber, recentCallWhen;

/// The Missed list's words, the console's own (`utils/inbound/missedCopy.ts`,
/// `inboundCopy.ts`, `components/agency/inbound/MissedCallsList.tsx`,
/// `pages/agency/MissedCallsPage.tsx`) in the agent's view: the app is
/// agent-only (M2), so nothing here names an assignee or reassigns. British
/// English. Tested directly (`missed_calls_copy_test.dart`).
abstract final class MissedCopy {
  static const title = 'Missed calls';

  /// The segment's label on My calls, and its short form beside two others.
  static const segment = 'Missed calls';
  static const segmentShort = 'Missed';

  /// The console agent page's subtitle.
  static const subtitle = 'Your customers who rang when nobody could answer. Call them back. Reaching them closes the '
      'row on its own; mark it handled only if you dealt with it another way.';

  /// The status tabs (the console's "To follow up" / "Handled").
  static const openTab = 'To follow up';
  static const handledTab = 'Handled';

  static const anyReason = 'Any reason';
  static const reasonFilter = 'Why it was missed';

  /// `agency_inbound_enabled` off with rows to read (the kill switch).
  static const inboundOff = 'Inbound calls are switched off for this account: callers hear the closed message and are '
      'still listed here. You can call them back and mark them handled.';

  /// Call back is not offered: the soft phone is not on for this agent.
  static const noSoftphone = 'Call back opens the soft phone, which isn’t on for this account. '
      'Call the customer another way, then mark the call handled.';

  static const withheld = 'Number withheld';
  static const withheldCallBack = 'The caller withheld their number.';
  static const dncBadge = 'DNC';
  static const dncHint = 'This number is on a Do Not Call list. The soft phone asks for a reason before calling it.';

  /// Under an open DNC row's Call back (IQ55): a missed call is not consent, so Call back
  /// keeps the soft phone's DNC check (SP1). "Why it has to go ahead" is the override
  /// prompt's own question (`describeDncRefusal`'s note label).
  static const dncCallBackNote = 'On Do Not Call: a missed call isn’t consent. Before the call goes through, '
      'you’ll be asked why it has to go ahead.';
  static const notMatched = 'Not matched';

  static const callBack = 'Call back';

  /// Call back's label for a screen reader: whom it calls, or why it is off
  /// (the withheld note under the row says the same on screen).
  static String callBackLabel(String caller) => 'Call back $caller';
  static const callBackWithheldLabel = 'Call back (number withheld)';
  static const markHandled = 'Mark handled';
  static const marking = 'Marking…';
  static const reopen = 'Reopen';
  static const reopening = 'Reopening…';

  /// A voicemail: the app does not play it in this build (no audio player).
  static const voicemail = 'Left a voicemail';
  static const voicemailOnConsole = 'Listen on the web console';

  /// After Call back, while the soft phone is not open here yet (it waits
  /// five minutes: `callBackWaitsFor`).
  static const callBackWaits = 'Switch to the soft phone within 5 minutes and the number will be on the pad. '
      'Nothing is dialled until you press Call.';

  /// After Call back, with a call on the soft phone: the number waits for it.
  static const callBackAfterCall = 'The number goes on the pad once this call is finished. '
      'Nothing is dialled until you press Call.';

  /// After Call back, with the soft phone open on another device or in
  /// another account: nothing here can take the number, so none is kept.
  static const callBackElsewhere = 'Your soft phone is open on another device or in another account. '
      'Bring it to this phone, then press Call back again.';

  static const loadFailed = 'We couldn’t load the missed calls.';
  static const moreFailed = 'We couldn’t load older missed calls.';
  static const loading = 'Loading your missed calls';

  /// The reason labels (`MISSED_REASON_LABELS`); a reason this build does not
  /// know reads as sent.
  static String reasonLabel(InboundMissedReason reason, String raw) => switch (reason) {
        InboundMissedReason.closed => 'Out of hours',
        InboundMissedReason.abandonedInQueue => 'Hung up while waiting',
        InboundMissedReason.overflow => 'Nobody free to answer',
        InboundMissedReason.overflowNoCapacity => 'All lines busy',
        InboundMissedReason.failed => 'Couldn’t be answered',
        InboundMissedReason.unknown => raw,
      };

  /// Why a row was missed: the reason's label, or for a closed call the cause
  /// when it was not the hours (`missedReasonLabel`).
  static String whyMissed(InboundMissedCall call) {
    if (call.reason == InboundMissedReason.closed) {
      switch (call.closedCause) {
        case InboundClosedCause.switchedOff:
          return 'Inbound switched off';
        case InboundClosedCause.noRoute:
          return 'Number not on a route';
        case InboundClosedCause.credentialInactive:
          return 'Phone line not active';
        case InboundClosedCause.hours || InboundClosedCause.unknown || null:
          break;
      }
    }
    return reasonLabel(call.reason, call.reasonRaw);
  }

  /// The caller: their number laid out for reading, or "Number withheld".
  /// The row carries no contact name (only the matched contact's id).
  static String caller(InboundMissedCall call) => call.isWithheld ? withheld : formatDialNumber(call.fromE164);

  /// The caller in a sentence ("the call from …").
  static String callerInSentence(InboundMissedCall call) =>
      call.isWithheld ? 'a withheld number' : formatDialNumber(call.fromE164);

  /// "Rang +91 22 … · Support line".
  static String rang(InboundMissedCall call) =>
      ['Rang ${formatDialNumber(call.toE164)}', ?call.routeName].join(' · ');

  /// When the call came in: "Today, 09:05 am".
  static String when(InboundMissedCall call, DateTime now) => recentCallWhen(call.arrivedAt, now);

  /// Any instant in the list's words.
  static String whenAt(DateTime at, DateTime now) => recentCallWhen(at, now);

  /// "Callback booked for Today, 10:00 am", when the call booked one.
  static String? callbackBooked(InboundMissedCall call, DateTime now) {
    final due = call.callbackDueAt;
    return due == null ? null : 'Callback booked for ${recentCallWhen(due, now)}';
  }

  /// How a handled row was handled, and by whom (`missedHandledLabel`).
  static String handledLabel(InboundMissedCall call, String? userId) {
    final by = call.handledByUserId;
    final who = by == null ? null : (by == userId ? 'you' : (call.handledByName ?? 'a former member'));
    if (call.handledReason == InboundHandledReason.reached) {
      return who == null ? 'Customer reached' : 'Customer reached by $who';
    }
    if (who == null) return 'Closed automatically';
    return who == 'you' ? 'You' : '${who[0].toUpperCase()}${who.substring(1)}';
  }

  /// Under a reached row: why it closed without anyone marking it.
  static const reachedNote = 'Closed on its own: an agent spoke to the customer after this call.';

  static String emptyTitle({required bool open, required bool filtered}) => filtered
      ? 'Nothing matches that filter'
      : open
          ? 'No missed calls to follow up'
          : 'No handled missed calls';

  static String emptyBody({required bool open, required bool filtered}) => filtered
      ? 'Clear the filter to see every call.'
      : open
          ? 'When one of your customers rings and nobody answers, the call appears here for you to call them back.'
          : 'Calls marked handled appear here.';

  /// "Showing 12 calls — there are more".
  static String countLine(int count, {required bool more}) =>
      'Showing $count call${count == 1 ? '' : 's'}${more ? ' — there are more' : ''}';

  static String markedAnnouncement(InboundMissedCall call) =>
      'Marked the call from ${callerInSentence(call)} as handled.';
  static String reopenedAnnouncement(InboundMissedCall call) =>
      'Reopened the call from ${callerInSentence(call)}. It is back on the list to follow up.';

  /// A Mark handled that did not go through (`inboundRefusalCopy`): the
  /// console's words for a code, the server's sentence for one it has none for,
  /// the app's own words for no answer.
  static String handledRefusal(Object error) => switch (_code(error)) {
        InboundErrorCode.inboundMissedCallNotFound => 'This missed call isn’t yours to handle, or it no longer exists.',
        InboundErrorCode.inboundDisabled => 'Inbound calls aren’t turned on for this account.',
        _ => _fallback(error, 'We couldn’t mark this call handled. Try again in a moment.'),
      };

  /// A Reopen that did not go through (`reopenRefusalCopy`).
  static String reopenRefusal(Object error) => switch (_code(error)) {
        InboundErrorCode.inboundMissedCallNotFound =>
          'This missed call isn’t yours to reopen, or it no longer exists. Refresh the list.',
        _ => error is ApiHttpError || error is ApiDecodeError
            ? 'We couldn’t reopen this call. Try again in a moment.'
            : _fallback(error, 'We couldn’t reopen this call. Try again in a moment.'),
      };

  static InboundErrorCode? _code(Object error) =>
      error is ApiHttpError ? ErrorBody.fromJson(error.body).inboundCode : null;

  /// No refusal code we have words for: the server's sentence, else the
  /// error's own (offline, timed out, signed out), else [fallback].
  static String _fallback(Object error, String fallback) {
    if (error is ApiHttpError) return error.message.isNotEmpty && !error.isServerError ? error.message : fallback;
    if (error is ApiError) return error.userMessage;
    return fallback;
  }
}
