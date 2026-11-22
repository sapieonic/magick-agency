/// The agent's own My calls: their calls of every type as one list.
///
/// Contract: `packages/contracts/src/api/agency/call-log.ts` (`AgencyMyCallRow`,
/// `AgencyMyCallsPage`, `GET /proxy/agency/my-calls`; `docs/call-log.md` §7).
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'equality.dart';
import 'json.dart';

/// `?campaign_id=none`: the calls filed under no campaign.
///
/// Contract: `AGENCY_CALLS_NO_CAMPAIGN`.
const String callsNoCampaign = 'none';

/// The Missed part of an inbound row.
///
/// Contract: `AgencyMyCallFollowUp`.
@immutable
final class MyCallFollowUp {
  MyCallFollowUp({
    required this.status,
    required this.reason,
    this.closedCause,
    this.handledReason,
    String? statusRaw,
    String? reasonRaw,
  }) : statusRaw = statusRaw ?? status.wire,
       reasonRaw = reasonRaw ?? reason.wire;

  factory MyCallFollowUp.fromJson(Map<String, Object?> j) {
    final status = j.str('status');
    final reason = j.str('reason');
    final closed = j.strOrNull('closed_cause');
    final handled = j.strOrNull('handled_reason');
    return MyCallFollowUp(
      status: InboundFollowUpStatus.fromWire(status),
      statusRaw: status,
      reason: InboundMissedReason.fromWire(reason),
      reasonRaw: reason,
      closedCause: closed == null ? null : InboundClosedCause.fromWire(closed),
      handledReason: handled == null ? null : InboundHandledReason.fromWire(handled),
    );
  }

  final InboundFollowUpStatus status;
  final String statusRaw;
  final InboundMissedReason reason;
  final String reasonRaw;

  /// With [reason] closed: why the caller was answered as closed.
  final InboundClosedCause? closedCause;

  /// Marked by a person, or the customer was reached. Null while open.
  final InboundHandledReason? handledReason;

  bool get isOpen => status == InboundFollowUpStatus.open;

  @override
  bool operator ==(Object other) =>
      other is MyCallFollowUp &&
      other.statusRaw == statusRaw &&
      other.reasonRaw == reasonRaw &&
      other.closedCause == closedCause &&
      other.handledReason == handledReason;

  @override
  int get hashCode => Object.hash(statusRaw, reasonRaw, closedCause, handledReason);
}

/// The Missed inbound call a soft-phone call rang back.
@immutable
final class MyCallBackOf {
  const MyCallBackOf({required this.inboundCallId, this.arrivedAt});

  factory MyCallBackOf.fromJson(Map<String, Object?> j) =>
      MyCallBackOf(inboundCallId: j.str('inbound_call_id'), arrivedAt: j.timeOrNull('arrived_at'));

  final String inboundCallId;

  /// When that call arrived; null when its row is gone.
  final DateTime? arrivedAt;

  @override
  bool operator ==(Object other) =>
      other is MyCallBackOf && other.inboundCallId == inboundCallId && other.arrivedAt == arrivedAt;

  @override
  int get hashCode => Object.hash(inboundCallId, arrivedAt);
}

/// The latest soft-phone call dialled from a missed call's Call back.
@immutable
final class MyCalledBack {
  const MyCalledBack({required this.callId, required this.at});

  factory MyCalledBack.fromJson(Map<String, Object?> j) => MyCalledBack(callId: j.str('call_id'), at: j.time('at'));

  final String callId;
  final DateTime at;

  @override
  bool operator ==(Object other) => other is MyCalledBack && other.callId == callId && other.at == at;

  @override
  int get hashCode => Object.hash(callId, at);
}

/// One call on My calls. One shape for the three types; what only one type
/// has is null on the others. It carries no media.
///
/// [phone] is the customer's number as this agent may see it: E.164 in full,
/// or the masked text when the call's campaign hides numbers from agents
/// ([phoneMasked]). The server masks; the app shows it as it arrived.
///
/// Contract: `AgencyMyCallRow`.
@immutable
final class MyCallRow {
  MyCallRow({
    required this.type,
    String? typeRaw,
    required this.id,
    required this.createdAt,
    this.campaignId,
    this.campaignName,
    this.contactId,
    this.customerName,
    this.phone,
    this.phoneMasked = false,
    required this.stateRaw,
    this.outcomeRaw,
    this.dispositionCode,
    this.dispositionLabel,
    this.autoDispositionCode,
    this.callbackAt,
    this.promiseDate,
    this.promiseAmount,
    this.talkSeconds,
    this.notes,
    this.attemptNumber,
    this.redial = false,
    this.dialedAt,
    this.requiresDisposition = false,
    this.callbackOf,
    this.waitSeconds,
    this.queued = false,
    this.voicemailSeconds,
    this.followUp,
    this.calledBack,
  }) : typeRaw = typeRaw ?? type.wire;

  factory MyCallRow.fromJson(Map<String, Object?> j) {
    final type = j.str('type');
    final backOf = j.objOrNull('callback_of');
    final followUp = j.objOrNull('follow_up');
    final calledBack = j.objOrNull('called_back');
    return MyCallRow(
      type: CallLogType.fromWire(type),
      typeRaw: type,
      id: j.str('id'),
      createdAt: j.time('created_at'),
      campaignId: j.strOrNull('campaign_id'),
      campaignName: j.strOrNull('campaign_name'),
      contactId: j.strOrNull('contact_id'),
      customerName: j.strOrNull('customer_name'),
      phone: j.strOrNull('phone'),
      phoneMasked: j.boolean('phone_masked'),
      stateRaw: j.str('state'),
      outcomeRaw: j.strOrNull('outcome'),
      dispositionCode: j.strOrNull('disposition_code'),
      dispositionLabel: j.strOrNull('disposition_label'),
      autoDispositionCode: j.strOrNull('auto_disposition_code'),
      callbackAt: j.timeOrNull('callback_at'),
      promiseDate: j.strOrNull('promise_date'),
      promiseAmount: j.strOrNull('promise_amount'),
      talkSeconds: j.numberOrNull('talk_seconds'),
      notes: j.strOrNull('notes'),
      attemptNumber: j.integerOrNull('attempt_number'),
      redial: j.boolean('redial'),
      dialedAt: j.timeOrNull('dialed_at'),
      requiresDisposition: j.boolean('requires_disposition'),
      callbackOf: backOf == null ? null : MyCallBackOf.fromJson(backOf),
      waitSeconds: j.integerOrNull('wait_seconds'),
      queued: j.boolean('queued'),
      voicemailSeconds: j.integerOrNull('voicemail_seconds'),
      followUp: followUp == null ? null : MyCallFollowUp.fromJson(followUp),
      calledBack: calledBack == null ? null : MyCalledBack.fromJson(calledBack),
    );
  }

  final CallLogType type;
  final String typeRaw;

  /// The attempt's, the soft-phone call's or the inbound call's id.
  final String id;

  /// When the call began (an inbound call: when it arrived).
  final DateTime createdAt;
  final String? campaignId;
  final String? campaignName;
  final String? contactId;

  /// The roster contact's name by the station card's rule; null without one.
  final String? customerName;

  /// See the class note. Null: the caller withheld their number.
  final String? phone;
  final bool phoneMasked;

  /// The call's own state, as sent (`ended` on every inbound row).
  final String stateRaw;

  /// What happened, in the type's own vocabulary.
  final String? outcomeRaw;
  final String? dispositionCode;

  /// The saved outcome in the campaign's own words; null when its list no
  /// longer has the code, or the call has no campaign.
  final String? dispositionLabel;
  final String? autoDispositionCode;
  final DateTime? callbackAt;

  /// `YYYY-MM-DD`.
  final String? promiseDate;
  final String? promiseAmount;
  final double? talkSeconds;
  final String? notes;

  /// Dialler: which try it was.
  final int? attemptNumber;

  /// Dialler: a wrap-up redial.
  final bool redial;

  /// Dialler and soft phone: when the dial was sent; null when it never was.
  final DateTime? dialedAt;

  /// The call was answered and still waits for its outcome.
  final bool requiresDisposition;

  /// Soft phone: the missed call it rang back.
  final MyCallBackOf? callbackOf;

  /// Inbound: how long the caller waited.
  final int? waitSeconds;
  final bool queued;
  final int? voicemailSeconds;

  /// Inbound: its Missed row; null for an answered call.
  final MyCallFollowUp? followUp;
  final MyCalledBack? calledBack;

  /// An inbound call that reached nobody.
  bool get isMissed => type == CallLogType.inbound && (followUp != null || outcomeRaw != 'answered');

  /// A missed call still owed a call back.
  bool get isToFollowUp => followUp?.isOpen ?? false;

  /// A soft-phone row whose dial was never sent.
  bool get neverDialled => type == CallLogType.softPhone && dialedAt == null && stateRaw == 'ended';

  @override
  bool operator ==(Object other) =>
      other is MyCallRow &&
      other.typeRaw == typeRaw &&
      other.id == id &&
      other.createdAt == createdAt &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.contactId == contactId &&
      other.customerName == customerName &&
      other.phone == phone &&
      other.phoneMasked == phoneMasked &&
      other.stateRaw == stateRaw &&
      other.outcomeRaw == outcomeRaw &&
      other.dispositionCode == dispositionCode &&
      other.dispositionLabel == dispositionLabel &&
      other.autoDispositionCode == autoDispositionCode &&
      other.callbackAt == callbackAt &&
      other.promiseDate == promiseDate &&
      other.promiseAmount == promiseAmount &&
      other.talkSeconds == talkSeconds &&
      other.notes == notes &&
      other.attemptNumber == attemptNumber &&
      other.redial == redial &&
      other.dialedAt == dialedAt &&
      other.requiresDisposition == requiresDisposition &&
      other.callbackOf == callbackOf &&
      other.waitSeconds == waitSeconds &&
      other.queued == queued &&
      other.voicemailSeconds == voicemailSeconds &&
      other.followUp == followUp &&
      other.calledBack == calledBack;

  @override
  int get hashCode => Object.hashAll(<Object?>[
    typeRaw,
    id,
    createdAt,
    campaignId,
    campaignName,
    contactId,
    customerName,
    phone,
    phoneMasked,
    stateRaw,
    outcomeRaw,
    dispositionCode,
    dispositionLabel,
    autoDispositionCode,
    callbackAt,
    promiseDate,
    promiseAmount,
    talkSeconds,
    notes,
    attemptNumber,
    redial,
    dialedAt,
    requiresDisposition,
    callbackOf,
    waitSeconds,
    queued,
    voicemailSeconds,
    followUp,
    calledBack,
  ]);
}

/// A callback the agent booked that is due today or already late.
///
/// Contract: `AgencyMyCallbackDue`.
@immutable
final class MyCallbackDue {
  const MyCallbackDue({
    required this.contactId,
    required this.campaignId,
    this.campaignName,
    this.customerName,
    required this.dueAt,
    required this.overdue,
  });

  factory MyCallbackDue.fromJson(Map<String, Object?> j) => MyCallbackDue(
    contactId: j.str('contact_id'),
    campaignId: j.str('campaign_id'),
    campaignName: j.strOrNull('campaign_name'),
    customerName: j.strOrNull('customer_name'),
    dueAt: j.time('due_at'),
    overdue: j.boolean('overdue'),
  );

  final String contactId;
  final String campaignId;
  final String? campaignName;

  /// Never the number; null without a name.
  final String? customerName;
  final DateTime dueAt;
  final bool overdue;

  @override
  bool operator ==(Object other) =>
      other is MyCallbackDue &&
      other.contactId == contactId &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.customerName == customerName &&
      other.dueAt == dueAt &&
      other.overdue == overdue;

  @override
  int get hashCode => Object.hash(contactId, campaignId, campaignName, customerName, dueAt, overdue);
}

/// What the agent still owes: the To follow up chip's badge.
///
/// Contract: `AgencyMyCallsCounts`.
@immutable
final class MyCallsCounts {
  const MyCallsCounts({required this.toFollowUp, required this.missedOpen, required this.callbacksDue});

  factory MyCallsCounts.fromJson(Map<String, Object?> j) => MyCallsCounts(
    toFollowUp: j.integer('to_follow_up'),
    missedOpen: j.integer('missed_open'),
    callbacksDue: j.integer('callbacks_due'),
  );

  /// Open Missed rows plus the callbacks due.
  final int toFollowUp;
  final int missedOpen;
  final int callbacksDue;

  @override
  bool operator ==(Object other) =>
      other is MyCallsCounts &&
      other.toFollowUp == toFollowUp &&
      other.missedOpen == missedOpen &&
      other.callbacksDue == callbacksDue;

  @override
  int get hashCode => Object.hash(toFollowUp, missedOpen, callbacksDue);
}

/// `GET /proxy/agency/my-calls`.
///
/// Contract: `AgencyMyCallsPage`.
@immutable
final class MyCallsPage {
  MyCallsPage({
    required List<MyCallRow> rows,
    this.nextCursor,
    required this.limit,
    this.counts,
    List<MyCallbackDue>? callbacksDue,
  }) : rows = List.unmodifiable(rows),
       callbacksDue = callbacksDue == null ? null : List.unmodifiable(callbacksDue);

  factory MyCallsPage.fromJson(Map<String, Object?> j) {
    final counts = j.objOrNull('counts');
    return MyCallsPage(
      rows: j.list('rows', MyCallRow.fromJson),
      nextCursor: j.strOrNull('next_cursor'),
      limit: j.integer('limit'),
      counts: counts == null ? null : MyCallsCounts.fromJson(counts),
      callbacksDue: j.listOrNull('callbacks_due', MyCallbackDue.fromJson),
    );
  }

  final List<MyCallRow> rows;

  /// Null on the last page.
  final String? nextCursor;
  final int limit;

  /// Only when asked for (`include_counts=1`).
  final MyCallsCounts? counts;

  /// On the first page of To follow up only: soonest due first.
  final List<MyCallbackDue>? callbacksDue;

  bool get hasMore => nextCursor != null;

  @override
  bool operator ==(Object other) =>
      other is MyCallsPage &&
      listEquals(other.rows, rows) &&
      other.nextCursor == nextCursor &&
      other.limit == limit &&
      other.counts == counts &&
      ((other.callbacksDue == null && callbacksDue == null) ||
          (other.callbacksDue != null && callbacksDue != null && listEquals(other.callbacksDue!, callbacksDue!)));

  @override
  int get hashCode =>
      Object.hash(listHash(rows), nextCursor, limit, counts, callbacksDue == null ? null : listHash(callbacksDue!));
}

/// The query of `GET /proxy/agency/my-calls`. The subject is the signed-in
/// agent: nothing here names anyone.
@immutable
final class MyCallsQuery {
  const MyCallsQuery({
    this.type = MyCallsTypeFilter.all,
    this.campaignId,
    this.cursor,
    this.limit,
    this.includeCounts = false,
  });

  final MyCallsTypeFilter type;

  /// A campaign's id, or [callsNoCampaign].
  final String? campaignId;
  final String? cursor;
  final int? limit;
  final bool includeCounts;

  Map<String, String> toQuery() => <String, String>{
    if (type != MyCallsTypeFilter.all) 'type': type.wire,
    'campaign_id': ?campaignId,
    'cursor': ?cursor,
    if (limit != null) 'limit': '$limit',
    if (includeCounts) 'include_counts': '1',
  };
}

/// "Due 4:00 PM" for a callback still to come, "Late by 2 hours" (minutes,
/// hours or days) for one that has passed. [time] is the due time already
/// formatted for the reader.
///
/// Contract: `agencyCallbackDueLabel`, case for case.
String callbackDueLabel(DateTime dueAt, DateTime now, String time) {
  final late = now.difference(dueAt);
  if (late <= Duration.zero) return 'Due $time';
  final minutes = late.inMinutes;
  if (minutes < 1) return 'Late by less than a minute';
  if (minutes < 60) return 'Late by $minutes ${minutes == 1 ? 'minute' : 'minutes'}';
  final hours = late.inHours;
  if (hours < 24) return 'Late by $hours ${hours == 1 ? 'hour' : 'hours'}';
  final days = late.inDays;
  return 'Late by $days ${days == 1 ? 'day' : 'days'}';
}
