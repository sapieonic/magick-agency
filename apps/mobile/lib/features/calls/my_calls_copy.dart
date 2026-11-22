import 'package:agency_wire/agency_wire.dart';

import '../missed/missed_calls_copy.dart';
import '../performance/logic/en_in_format.dart';
import '../station/logic/format.dart';
import 'logic/attempt_copy.dart' show attemptOutcomeLabels;

/// My calls in words (`docs/call-log.md` §7): one list of the agent's calls of
/// every type, To follow up first. The console's `utils/agency/myCalls.ts`,
/// in the proposal's words. Pure: no widgets, no providers.
abstract final class MyCallsCopy {
  static const title = 'My calls';

  /// The chips, in their order.
  static String chip(MyCallsTypeFilter type) => switch (type) {
        MyCallsTypeFilter.toFollowUp => 'To follow up',
        MyCallsTypeFilter.all => 'All',
        MyCallsTypeFilter.dialler => 'Dialler',
        MyCallsTypeFilter.softPhone => 'Soft phone',
        MyCallsTypeFilter.inbound => 'Inbound',
      };

  static String typeLabel(MyCallRow row) => switch (row.type) {
        CallLogType.dialler => 'Dialler',
        CallLogType.softPhone => 'Soft phone',
        CallLogType.inbound => 'Inbound',
        CallLogType.unknown => row.typeRaw,
      };

  /// The card's top line: "Dialler · Try 1", "Soft phone · Call back", "Inbound · missed".
  static String typeLine(MyCallRow row) {
    final label = typeLabel(row);
    return switch (row.type) {
      CallLogType.dialler => [
          label,
          if (row.attemptNumber != null) 'Try ${row.attemptNumber}',
          if (row.redial) 'redial',
        ].join(' · '),
      CallLogType.softPhone => row.callbackOf != null ? '$label · Call back' : label,
      CallLogType.inbound => row.isMissed ? '$label · missed' : label,
      CallLogType.unknown => label,
    };
  }

  static const numberWithheld = 'Number withheld';
  static const noCampaign = 'No campaign';

  /// Who the call was with: the customer's name, else the number as this agent
  /// may see it. A number the server hid is shown as it arrived; one in full
  /// is grouped for reading.
  static String who(MyCallRow row) => row.customerName ?? number(row);

  static String number(MyCallRow row) {
    final phone = row.phone;
    if (phone == null) return numberWithheld;
    return row.phoneMasked ? phone : formatPhone(phone);
  }

  /// `3:42 PM` today, `21 Nov, 3:42 PM` on another day.
  static String when(DateTime at, DateTime now) {
    final l = at.toLocal();
    final n = now.toLocal();
    final sameDay = l.year == n.year && l.month == n.month && l.day == n.day;
    return sameDay ? formatTime12(l) : '${formatDay(l)}, ${formatTime12(l)}';
  }

  /// What happened on the line.
  static String happened(MyCallRow row) {
    if (row.type == CallLogType.inbound) return row.isMissed ? 'Missed' : 'Answered';
    if (row.neverDialled) return 'Not dialled';
    if (row.type == CallLogType.softPhone && row.stateRaw != 'ended') return 'On a call now';
    if (row.type == CallLogType.dialler && row.dispositionCode == 'inbound_call') return 'Stopped: customer rang us';
    final raw = row.outcomeRaw;
    if (raw == null) return 'Not classified';
    return attemptOutcomeLabels[AttemptOutcome.fromWire(raw)] ?? raw;
  }

  /// Why a call was missed, lower case, with the wait when the caller queued:
  /// "nobody free to answer · waited 1:40", "hung up while waiting · 0:52".
  static String? missedWhy(MyCallRow row) {
    final followUp = row.followUp;
    if (followUp == null) return null;
    final label = followUp.reason == InboundMissedReason.closed
        ? switch (followUp.closedCause) {
            InboundClosedCause.switchedOff => 'Inbound switched off',
            InboundClosedCause.noRoute => 'Number not on a route',
            InboundClosedCause.credentialInactive => 'Phone line not active',
            _ => MissedCopy.reasonLabel(followUp.reason, followUp.reasonRaw),
          }
        : MissedCopy.reasonLabel(followUp.reason, followUp.reasonRaw);
    final reason = label.isEmpty ? label : '${label[0].toLowerCase()}${label.substring(1)}';
    final wait = row.waitSeconds;
    final waited = !row.queued || wait == null
        ? null
        : followUp.reason == InboundMissedReason.abandonedInQueue
            ? EnIn.talkTime(wait.toDouble())
            : 'waited ${EnIn.talkTime(wait.toDouble())}';
    return [reason, ?waited].join(' · ');
  }

  /// The saved outcome in the campaign's words, with its day: "Will pay · 25 Nov".
  static String? outcome(MyCallRow row) {
    final code = row.dispositionCode ?? row.autoDispositionCode;
    if (code == null || code == 'inbound_call') return null;
    final label = code == 'no_disposition'
        ? 'No outcome chosen'
        : (row.dispositionCode != null ? row.dispositionLabel : null) ?? code;
    final promise = row.promiseDate == null ? null : DateTime.tryParse('${row.promiseDate}T12:00:00');
    final day = promise ?? row.callbackAt?.toLocal();
    return [label, if (day != null) formatDay(day)].join(' · ');
  }

  /// The card's meta line: campaign · what happened or the outcome · talk time.
  /// A missed call says why; a call with an outcome says the outcome, else
  /// what the line did.
  static String meta(MyCallRow row) {
    final campaign = row.campaignName ?? (row.campaignId == null ? noCampaign : null);
    final middle = row.isMissed ? (missedWhy(row) ?? 'Missed') : (outcome(row) ?? happened(row));
    return [
      ?campaign,
      middle,
      if (row.talkSeconds != null) EnIn.talkTime(row.talkSeconds),
    ].join(' · ');
  }

  /// "Called back 3:31 PM" on a missed call that was rung back.
  static String? calledBack(MyCallRow row, DateTime now) {
    final back = row.calledBack;
    return back == null ? null : 'Called back ${when(back.at, now)}';
  }

  static const callBack = 'Call back';
  static const markHandled = 'Mark handled';
  static const marking = 'Marking…';
  static const opening = 'Opening…';

  static const callbackDue = 'Callback due';
  static const callbacksHeading = 'Callbacks due';
  static const aCustomer = 'A customer';

  /// "Due 4:00 PM" / "Late by 2 hours".
  static String dueLine(MyCallbackDue callback, DateTime now) =>
      callbackDueLabel(callback.dueAt, now, formatTime12(callback.dueAt));

  /// "Diwali EMI Collections · you booked it for 1:45 PM".
  static String bookedLine(MyCallbackDue callback, DateTime now) =>
      [?callback.campaignName, 'you booked it for ${when(callback.dueAt, now)}'].join(' · ');

  static const nothingToFollowUp = 'Nobody is waiting for a call from you.';
  static const nothingToFollowUpBody =
      'A missed call that is yours to ring back, and a callback you booked that is due today or late, show here.';

  static ({String title, String body}) empty(MyCallsTypeFilter type) => switch (type) {
        MyCallsTypeFilter.toFollowUp => (title: nothingToFollowUp, body: nothingToFollowUpBody),
        MyCallsTypeFilter.dialler => (title: 'No dialler calls yet', body: 'Calls the dialler places for you show here.'),
        MyCallsTypeFilter.softPhone => (
            title: 'No soft-phone calls yet',
            body: 'Calls you make from the soft phone show here.',
          ),
        MyCallsTypeFilter.inbound => (
            title: 'No inbound calls yet',
            body: 'Calls from customers that you answered, and the missed calls that are yours to ring back, show here.',
          ),
        MyCallsTypeFilter.all => (title: 'No calls yet', body: 'Every call you make or take shows here, newest first.'),
      };

  static const loadFailed = 'We couldn’t load your calls.';

  /// The server has no `/my-calls` yet: an app build installed before its
  /// server was updated, or a server rolled back (`DEPLOYMENT.md` 12).
  static const serverTooOld = 'My calls needs a newer version of the server. Ask your admin to update it.';

  static const moreFailed = 'We couldn’t load any more calls.';
  static const loading = 'Loading your calls';

  /// A Call back whose number could not be read for the pad.
  static const callBackFailed = 'We couldn’t open this call on the soft phone. Open Missed calls and call back from there.';

  /// Under To follow up: the Missed list, with the team's unassigned calls and voicemails.
  static const openMissedList = 'Missed calls list';

  /// "Showing 12 calls — there are more".
  static String countLine(int count, {required bool more}) =>
      'Showing $count call${count == 1 ? '' : 's'}${more ? ' — there are more' : ''}';

  static const endNote = 'Numbers are shown as each campaign allows. There is no export from this view.';
}
