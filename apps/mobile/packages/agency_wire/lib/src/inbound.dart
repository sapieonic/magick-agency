/// Inbound calls: a customer rings one of the account's numbers and is put
/// through to an agent's station, or reaches nobody and lands on the Missed list.
///
/// Contract: `packages/contracts/src/agency/inbound.ts` (the call, its station
/// frames and the call routes' answers, which the public API layer passes
/// through) and the console's reading of it in `api/agency/inbound.ts` (the
/// request bodies without the server-filled actor, the Missed list, its count
/// and its refusals). Routes live under `/proxy/agency/inbound/*`:
///
/// | Route | Body | Answer |
/// |---|---|---|
/// | `GET /inbound/calls/:id` | | [InboundCallResponse] |
/// | `PATCH /inbound/calls/:id` | [InboundCallUpdateRequest] | [InboundCallResponse] |
/// | `POST /inbound/calls/:id/hangup` | none | [InboundCallResponse] |
/// | `POST /inbound/calls/:id/disposition` | [InboundCallDispositionRequest] | [InboundCallDispositionResponse] |
/// | `POST /inbound/calls/:id/dnc` | [InboundCallDncRequest] | [InboundCallDncResponse] |
/// | `GET /inbound/missed` | [InboundMissedQuery] | [InboundMissedPage] |
/// | `POST /inbound/missed/:id/handled` | none | [InboundMissedCallResponse] |
/// | `POST /inbound/missed/:id/reopen` | none | [InboundMissedCallResponse] |
/// | `GET /inbound/missed/count` | | [InboundMissedCountResponse] |
///
/// Refusals are an `ErrorBody` read through `inboundCode` and its typed
/// accessors (`errors.dart`). Neither the five call routes nor the Missed
/// list and its count are behind the inbound flag: work already taken stays
/// workable with inbound switched off (the server's `requireInboundEnabled`
/// guards only the route editor and the queue tiles).
///
/// The call ([InboundCall]) is the one shape every answer carries: the
/// `inbound_call` station frame and every call route send it whole, so a
/// client keeps the newest copy it has seen rather than patching one.
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'equality.dart';
import 'json.dart';
import 'reads.dart';
import 'session.dart';
import 'station.dart';

/// How long after the offer the server binds the agent's audio
/// (`AGENCY_INBOUND_CONNECT_DELAY_MS`): the panel is up, and the chime has
/// played, before any audio. Server-timed; the call's `connects_at` says when.
const inboundConnectDelay = Duration(milliseconds: 1500);

/// How long an answered call waits for its outcome before it lapses
/// (`AGENCY_INBOUND_OUTCOME_LAPSE_MS`). The call's `outcome_due_at` already says when.
const inboundOutcomeLapse = Duration(minutes: 30);

/// The disposition code of a campaign dial cancelled because its customer
/// rang in (`AGENCY_INBOUND_TOOK_OVER_DISPOSITION_CODE`). Reserved: never in a
/// catalog. The station's `released` frame says [ReleaseReason.inboundCall].
const inboundTookOverDispositionCode = 'inbound_call';

/// The open Missed rows `GET /inbound/missed/count` counts before it stops
/// (`AGENCY_INBOUND_MISSED_COUNT_CAP`): show "100+" when `open_capped`.
const inboundMissedCountCap = 100;

// ─── The call ───────────────────────────────────────────────────────────────

/// The inbound route the call came in on.
///
/// Contract: `AgencyInboundCall['route']`.
@immutable
final class InboundCallRoute {
  const InboundCallRoute({required this.id, required this.name});

  factory InboundCallRoute.fromJson(Map<String, Object?> j) => InboundCallRoute(id: j.str('id'), name: j.str('name'));

  final String id;
  final String name;

  @override
  bool operator ==(Object other) => other is InboundCallRoute && other.id == id && other.name == name;

  @override
  int get hashCode => Object.hash(id, name);
}

/// Why the panel names an agent as the caller's own, and whether that is the
/// agent the call is offered to.
///
/// Contract: `AgencyInboundCallSticky`.
@immutable
final class InboundCallSticky {
  InboundCallSticky({required this.reason, String? reasonRaw, required this.isYou})
    : reasonRaw = reasonRaw ?? reason.wire;

  factory InboundCallSticky.fromJson(Map<String, Object?> j) {
    final reason = j.str('reason');
    return InboundCallSticky(
      reason: InboundStickyReason.fromWire(reason),
      reasonRaw: reason,
      isYou: j.boolean('is_you'),
    );
  }

  final InboundStickyReason reason;
  final String reasonRaw;

  /// The sticky agent is the agent this call is offered to or connected with
  /// ("Your customer").
  final bool isYou;

  @override
  bool operator ==(Object other) => other is InboundCallSticky && other.reasonRaw == reasonRaw && other.isYou == isYou;

  @override
  int get hashCode => Object.hash(reasonRaw, isYou);
}

/// The roster contact the caller's number matched.
///
/// Contract: `AgencyInboundCallMatch`.
@immutable
final class InboundCallMatch {
  InboundCallMatch({
    required this.contactId,
    required this.campaignId,
    required this.campaignName,
    required this.contactState,
    String? contactStateRaw,
    Map<String, Object?> context = const <String, Object?>{},
    required this.contextDisplay,
    List<PriorAttempt> priorAttempts = const <PriorAttempt>[],
  }) : contactStateRaw = contactStateRaw ?? contactState.wire,
       context = frozenMap(context),
       priorAttempts = List.unmodifiable(priorAttempts);

  factory InboundCallMatch.fromJson(Map<String, Object?> j) {
    final state = j.str('contact_state');
    return InboundCallMatch(
      contactId: j.str('contact_id'),
      campaignId: j.str('campaign_id'),
      campaignName: j.str('campaign_name'),
      contactState: ContactState.fromWire(state),
      contactStateRaw: state,
      context: j.obj('context'),
      contextDisplay: ContextDisplay.fromJson(j.obj('context_display')),
      priorAttempts: j.list('prior_attempts', PriorAttempt.fromJson),
    );
  }

  final String contactId;
  final String campaignId;
  final String campaignName;

  /// The contact's state now.
  final ContactState contactState;
  final String contactStateRaw;

  /// Every non-phone CSV column, original headers as keys. Untrusted display
  /// text: render through [contextDisplay] (`ContextDisplay.resolve`).
  final Map<String, Object?> context;

  /// The matched campaign's.
  final ContextDisplay contextDisplay;

  /// Earlier dials of this contact, newest first.
  final List<PriorAttempt> priorAttempts;

  @override
  bool operator ==(Object other) =>
      other is InboundCallMatch &&
      other.contactId == contactId &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.contactStateRaw == contactStateRaw &&
      jsonEquals(other.context, context) &&
      other.contextDisplay == contextDisplay &&
      listEquals(other.priorAttempts, priorAttempts);

  @override
  int get hashCode => Object.hash(
    contactId,
    campaignId,
    campaignName,
    contactStateRaw,
    jsonHash(context),
    contextDisplay,
    listHash(priorAttempts),
  );
}

/// One inbound call as the agent's panel renders it, whole.
///
/// [state] is the authority: `offered` (the panel is up, audio binds at
/// [connectsAt]), `connected` ([bridgedAt] set: audio both ways), `ended`
/// (owing its outcome until [settledAt]). A call requeued because the station
/// was lost before audio bound is no longer this session's: its last frame is
/// never followed by a `connected` one.
///
/// Contract: `AgencyInboundCall`.
@immutable
final class InboundCall {
  InboundCall({
    required this.id,
    required this.sessionId,
    required this.state,
    String? stateRaw,
    this.outcome,
    String? outcomeRaw,
    this.fromE164,
    required this.toE164,
    this.route,
    required this.callerDnc,
    this.sticky,
    this.match,
    required this.catalogSource,
    String? catalogSourceRaw,
    required List<Disposition> dispositionCatalog,
    required this.recording,
    required this.waitedSeconds,
    required this.offeredAt,
    this.connectsAt,
    this.bridgedAt,
    this.endedAt,
    this.talkSeconds,
    this.outcomeDueAt,
    this.dispositionCode,
    this.notes,
    this.callbackAt,
    this.dispositionedByUserId,
    required this.dispositionedOnBehalf,
    this.settledAt,
  }) : stateRaw = stateRaw ?? state.wire,
       outcomeRaw = outcomeRaw ?? outcome?.wire,
       catalogSourceRaw = catalogSourceRaw ?? catalogSource.wire,
       dispositionCatalog = List.unmodifiable(dispositionCatalog);

  factory InboundCall.fromJson(Map<String, Object?> j) {
    final state = j.str('state');
    final outcome = j.strOrNull('outcome');
    final catalog = j.str('catalog_source');
    final route = j.objOrNull('route');
    final sticky = j.objOrNull('sticky');
    final match = j.objOrNull('match');
    return InboundCall(
      id: j.str('id'),
      sessionId: j.str('session_id'),
      state: InboundCallState.fromWire(state),
      stateRaw: state,
      outcome: outcome == null ? null : InboundCallOutcome.fromWire(outcome),
      outcomeRaw: outcome,
      fromE164: j.strOrNull('from_e164'),
      toE164: j.str('to_e164'),
      route: route == null ? null : InboundCallRoute.fromJson(route),
      callerDnc: j.boolean('caller_dnc'),
      sticky: sticky == null ? null : InboundCallSticky.fromJson(sticky),
      match: match == null ? null : InboundCallMatch.fromJson(match),
      catalogSource: InboundCatalogSource.fromWire(catalog),
      catalogSourceRaw: catalog,
      dispositionCatalog: j.list('disposition_catalog', Disposition.fromJson),
      recording: j.boolean('recording'),
      waitedSeconds: j.integer('waited_seconds'),
      offeredAt: j.time('offered_at'),
      connectsAt: j.timeOrNull('connects_at'),
      bridgedAt: j.timeOrNull('bridged_at'),
      endedAt: j.timeOrNull('ended_at'),
      talkSeconds: j.integerOrNull('talk_seconds'),
      outcomeDueAt: j.timeOrNull('outcome_due_at'),
      dispositionCode: j.strOrNull('disposition_code'),
      notes: j.strOrNull('notes'),
      callbackAt: j.timeOrNull('callback_at'),
      dispositionedByUserId: j.strOrNull('dispositioned_by_user_id'),
      dispositionedOnBehalf: j.boolean('dispositioned_on_behalf'),
      settledAt: j.timeOrNull('settled_at'),
    );
  }

  /// [InboundCall.fromJson], or null when [json] is not a readable call. For
  /// the station frame, where one malformed call must not take the frame down.
  static InboundCall? tryFromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    try {
      return InboundCall.fromJson(json);
    } on FormatException {
      return null;
    } on TypeError {
      return null;
    }
  }

  final String id;

  /// The agent session it is offered to or connected with.
  final String sessionId;
  final InboundCallState state;
  final String stateRaw;

  /// Null until ended.
  final InboundCallOutcome? outcome;
  final String? outcomeRaw;

  /// E.164; null when the caller withheld their number ("Number withheld").
  final String? fromE164;

  /// The number they rang, E.164.
  final String toE164;
  final InboundCallRoute? route;

  /// The caller's number is on a DNC list: show the badge. A customer's own
  /// call is an enquiry, so the call is still taken.
  final bool callerDnc;

  /// Null: no sticky agent was found.
  final InboundCallSticky? sticky;

  /// Null: the caller matched no roster contact.
  final InboundCallMatch? match;
  final InboundCatalogSource catalogSource;
  final String catalogSourceRaw;

  /// The catalog the outcome is saved against, resolved: never empty.
  final List<Disposition> dispositionCatalog;

  /// The call is recorded (the route records and the account allows it).
  final bool recording;

  /// How long the caller waited before this offer, in whole seconds.
  final int waitedSeconds;
  final DateTime offeredAt;

  /// When audio binds; null once connected or ended.
  final DateTime? connectsAt;

  /// Audio is live both ways from here: the talk timer starts now.
  final DateTime? bridgedAt;
  final DateTime? endedAt;

  /// Talk time from the bind, once ended; null before.
  final int? talkSeconds;

  /// When an owed outcome lapses; null when none is owed.
  final DateTime? outcomeDueAt;
  final String? dispositionCode;
  final String? notes;

  /// A callback asked for in the outcome.
  final DateTime? callbackAt;

  /// Who saved the outcome, which is not always who took the call.
  final String? dispositionedByUserId;
  final bool dispositionedOnBehalf;

  /// Outcome saved, lapsed, or the call ended unbridged. Null while live or
  /// awaiting an outcome.
  final DateTime? settledAt;

  /// The caller withheld their number.
  bool get isWithheld => fromE164 == null;

  /// Settled: nothing more happens to this call.
  bool get isSettled => settledAt != null;

  /// Offered or connected: on the line, not ended.
  bool get isLive => settledAt == null && state != InboundCallState.ended;

  /// Ended and owing its outcome (until [outcomeDueAt]).
  bool get owesOutcome => settledAt == null && state == InboundCallState.ended;

  /// Holds its session: live, or ended and owing its outcome. While it does,
  /// the campaign session routes refuse with `inbound_call_live`.
  bool get isUnsettled => settledAt == null;

  /// The catalog entry for [code], or null when [code] is not in it.
  Disposition? disposition(String code) {
    for (final d in dispositionCatalog) {
      if (d.code == code) return d;
    }
    return null;
  }

  @override
  bool operator ==(Object other) =>
      other is InboundCall &&
      other.id == id &&
      other.sessionId == sessionId &&
      other.stateRaw == stateRaw &&
      other.outcomeRaw == outcomeRaw &&
      other.fromE164 == fromE164 &&
      other.toE164 == toE164 &&
      other.route == route &&
      other.callerDnc == callerDnc &&
      other.sticky == sticky &&
      other.match == match &&
      other.catalogSourceRaw == catalogSourceRaw &&
      listEquals(other.dispositionCatalog, dispositionCatalog) &&
      other.recording == recording &&
      other.waitedSeconds == waitedSeconds &&
      other.offeredAt == offeredAt &&
      other.connectsAt == connectsAt &&
      other.bridgedAt == bridgedAt &&
      other.endedAt == endedAt &&
      other.talkSeconds == talkSeconds &&
      other.outcomeDueAt == outcomeDueAt &&
      other.dispositionCode == dispositionCode &&
      other.notes == notes &&
      other.callbackAt == callbackAt &&
      other.dispositionedByUserId == dispositionedByUserId &&
      other.dispositionedOnBehalf == dispositionedOnBehalf &&
      other.settledAt == settledAt;

  @override
  int get hashCode => Object.hash(id, stateRaw, bridgedAt, endedAt, settledAt, match, notes, dispositionCode);

  @override
  String toString() => 'InboundCall($id, $stateRaw, settled: ${settledAt != null})';
}

// ─── Requests ───────────────────────────────────────────────────────────────

/// `PATCH /proxy/agency/inbound/calls/:id`: the notes (`''` clears them), last
/// write wins, while the call is unsettled. A null [notes] is left out.
///
/// Contract: `AgencyApi.AgencyInboundCallUpdateRequest`.
@immutable
final class InboundCallUpdateRequest {
  const InboundCallUpdateRequest({this.notes});

  final String? notes;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{};
    putIfSet(json, 'notes', notes);
    return json;
  }

  @override
  bool operator ==(Object other) => other is InboundCallUpdateRequest && other.notes == notes;

  @override
  int get hashCode => notes.hashCode;
}

/// `POST /proxy/agency/inbound/calls/:id/disposition`: save the outcome once
/// the call has ended after it was bridged. The same [code] again is an
/// idempotent 200 (notes and callback last-write-wins); a different code on a
/// settled call is `inbound_outcome_already_saved`.
///
/// Contract: `AgencyApi.AgencyInboundCallDispositionRequest`.
@immutable
final class InboundCallDispositionRequest {
  const InboundCallDispositionRequest({required this.code, this.notes, this.callbackAt});

  /// A code of the call's `disposition_catalog`.
  final String code;
  final String? notes;

  /// Required when the catalog entry sets `requires_datetime`.
  final DateTime? callbackAt;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{'code': code};
    putIfSet(json, 'notes', notes);
    if (callbackAt != null) json['callback_at'] = isoUtc(callbackAt!);
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is InboundCallDispositionRequest &&
      other.code == code &&
      other.notes == notes &&
      other.callbackAt == callbackAt;

  @override
  int get hashCode => Object.hash(code, notes, callbackAt);
}

/// `POST /proxy/agency/inbound/calls/:id/dnc`: mark the caller's number Do Not
/// Call. The client never states the scope: the matched campaign, else the
/// call's account.
///
/// Contract: `AgencyApi.AgencyInboundCallDncRequest`.
@immutable
final class InboundCallDncRequest {
  const InboundCallDncRequest({this.reason});

  final String? reason;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{};
    putIfSet(json, 'reason', reason);
    return json;
  }

  @override
  bool operator ==(Object other) => other is InboundCallDncRequest && other.reason == reason;

  @override
  int get hashCode => reason.hashCode;
}

// ─── Answers ────────────────────────────────────────────────────────────────

/// The answer of `GET` and `PATCH /inbound/calls/:id` and of the hang-up (the
/// call as read after the hang-up was issued).
///
/// Contract: `AgencyInboundCallResponse`.
@immutable
final class InboundCallResponse {
  const InboundCallResponse({required this.call});

  factory InboundCallResponse.fromJson(Map<String, Object?> j) =>
      InboundCallResponse(call: InboundCall.fromJson(j.obj('call')));

  final InboundCall call;

  @override
  bool operator ==(Object other) => other is InboundCallResponse && other.call == call;

  @override
  int get hashCode => call.hashCode;
}

/// Contract: `AgencyInboundCallDispositionResponse`.
@immutable
final class InboundCallDispositionResponse {
  InboundCallDispositionResponse({
    required this.call,
    this.contactState,
    String? contactStateRaw,
    this.nextAttemptAt,
    this.callbackRequestedAt,
  }) : contactStateRaw = contactStateRaw ?? contactState?.wire;

  factory InboundCallDispositionResponse.fromJson(Map<String, Object?> j) {
    final contact = j.strOrNull('contact_state');
    return InboundCallDispositionResponse(
      call: InboundCall.fromJson(j.obj('call')),
      contactState: contact == null ? null : ContactState.fromWire(contact),
      contactStateRaw: contact,
      nextAttemptAt: j.timeOrNull('next_attempt_at'),
      callbackRequestedAt: j.timeOrNull('callback_requested_at'),
    );
  }

  /// The call, settled.
  final InboundCall call;

  /// Where the outcome left the matched contact; null when there is none.
  final ContactState? contactState;
  final String? contactStateRaw;

  /// When the dialer will call the contact again, or null.
  final DateTime? nextAttemptAt;

  /// The `callback_at` asked for, echoed; null when none.
  final DateTime? callbackRequestedAt;

  @override
  bool operator ==(Object other) =>
      other is InboundCallDispositionResponse &&
      other.call == call &&
      other.contactStateRaw == contactStateRaw &&
      other.nextAttemptAt == nextAttemptAt &&
      other.callbackRequestedAt == callbackRequestedAt;

  @override
  int get hashCode => Object.hash(call, contactStateRaw, nextAttemptAt, callbackRequestedAt);
}

/// Contract: `AgencyInboundCallDncResponse`.
@immutable
final class InboundCallDncResponse {
  InboundCallDncResponse({
    required this.callId,
    required this.phoneE164,
    required this.scope,
    String? scopeRaw,
    required this.dncRecorded,
    this.contactState,
    String? contactStateRaw,
  }) : scopeRaw = scopeRaw ?? scope.wire,
       contactStateRaw = contactStateRaw ?? contactState?.wire;

  factory InboundCallDncResponse.fromJson(Map<String, Object?> j) {
    final scope = j.str('scope');
    final contact = j.strOrNull('contact_state');
    return InboundCallDncResponse(
      callId: j.str('call_id'),
      phoneE164: j.str('phone_e164'),
      scope: DncEntryScope.fromWire(scope),
      scopeRaw: scope,
      dncRecorded: j.boolean('dnc_recorded'),
      contactState: contact == null ? null : ContactState.fromWire(contact),
      contactStateRaw: contact,
    );
  }

  final String callId;
  final String phoneE164;

  /// `campaign` when the call matched a campaign, else `account`; never `tenant`.
  final DncEntryScope scope;
  final String scopeRaw;

  /// False when the list write is still in flight (the roster row is suppressed either way).
  final bool dncRecorded;
  final ContactState? contactState;
  final String? contactStateRaw;

  @override
  bool operator ==(Object other) =>
      other is InboundCallDncResponse &&
      other.callId == callId &&
      other.phoneE164 == phoneE164 &&
      other.scopeRaw == scopeRaw &&
      other.dncRecorded == dncRecorded &&
      other.contactStateRaw == contactStateRaw;

  @override
  int get hashCode => Object.hash(callId, phoneE164, scopeRaw, dncRecorded, contactStateRaw);
}

// ─── The Missed list ────────────────────────────────────────────────────────

/// One call that reached nobody: a follow-up for the agent it is assigned to,
/// or for the account.
///
/// Contract: `AgencyApi.AgencyInboundMissedCall`.
@immutable
final class InboundMissedCall {
  InboundMissedCall({
    required this.id,
    this.accountId,
    this.routeId,
    this.routeName,
    this.fromE164,
    required this.toE164,
    required this.arrivedAt,
    required this.endedAt,
    required this.reason,
    String? reasonRaw,
    this.closedCause,
    String? closedCauseRaw,
    required this.outcome,
    String? outcomeRaw,
    required this.callerDnc,
    this.matchedContactId,
    this.matchedCampaignId,
    this.matchedCampaignName,
    this.callbackDueAt,
    required this.hasVoicemail,
    this.voicemailUrl,
    this.assigneeUserId,
    this.assigneeName,
    required this.assigneeDeparted,
    required this.status,
    String? statusRaw,
    this.handledReason,
    String? handledReasonRaw,
    this.handledByUserId,
    this.handledByName,
    this.handledAt,
  }) : reasonRaw = reasonRaw ?? reason.wire,
       closedCauseRaw = closedCauseRaw ?? closedCause?.wire,
       outcomeRaw = outcomeRaw ?? outcome.wire,
       statusRaw = statusRaw ?? status.wire,
       handledReasonRaw = handledReasonRaw ?? handledReason?.wire;

  factory InboundMissedCall.fromJson(Map<String, Object?> j) {
    final reason = j.str('reason');
    final closedCause = j.strOrNull('closed_cause');
    final outcome = j.str('outcome');
    final status = j.str('status');
    final handled = j.strOrNull('handled_reason');
    return InboundMissedCall(
      id: j.str('id'),
      accountId: j.strOrNull('account_id'),
      routeId: j.strOrNull('route_id'),
      routeName: j.strOrNull('route_name'),
      fromE164: j.strOrNull('from_e164'),
      toE164: j.str('to_e164'),
      arrivedAt: j.time('arrived_at'),
      endedAt: j.time('ended_at'),
      reason: InboundMissedReason.fromWire(reason),
      reasonRaw: reason,
      closedCause: closedCause == null ? null : InboundClosedCause.fromWire(closedCause),
      closedCauseRaw: closedCause,
      outcome: InboundCallOutcome.fromWire(outcome),
      outcomeRaw: outcome,
      callerDnc: j.boolean('caller_dnc'),
      matchedContactId: j.strOrNull('matched_contact_id'),
      matchedCampaignId: j.strOrNull('matched_campaign_id'),
      matchedCampaignName: j.strOrNull('matched_campaign_name'),
      callbackDueAt: j.timeOrNull('callback_due_at'),
      hasVoicemail: j.boolean('has_voicemail'),
      voicemailUrl: j.strOrNull('voicemail_url'),
      assigneeUserId: j.strOrNull('assignee_user_id'),
      assigneeName: j.strOrNull('assignee_name'),
      assigneeDeparted: j.boolean('assignee_departed'),
      status: InboundFollowUpStatus.fromWire(status),
      statusRaw: status,
      handledReason: handled == null ? null : InboundHandledReason.fromWire(handled),
      handledReasonRaw: handled,
      handledByUserId: j.strOrNull('handled_by_user_id'),
      handledByName: j.strOrNull('handled_by_name'),
      handledAt: j.timeOrNull('handled_at'),
    );
  }

  final String id;

  /// Null: the tenant default (the number has no route).
  final String? accountId;
  final String? routeId;
  final String? routeName;

  /// E.164; null when the caller withheld their number.
  final String? fromE164;

  /// The number they rang, E.164.
  final String toE164;
  final DateTime arrivedAt;
  final DateTime endedAt;
  final InboundMissedReason reason;
  final String reasonRaw;

  /// With [reason] `closed`: why. Null on another reason's row, or a closed
  /// row from before it was recorded.
  final InboundClosedCause? closedCause;
  final String? closedCauseRaw;
  final InboundCallOutcome outcome;
  final String outcomeRaw;

  /// The caller's number is on a DNC list: never dialled automatically; the agent decides.
  final bool callerDnc;
  final String? matchedContactId;
  final String? matchedCampaignId;
  final String? matchedCampaignName;

  /// When the callback this call booked on the matched contact is due; null: none was booked.
  final DateTime? callbackDueAt;
  final bool hasVoicemail;

  /// Where the voicemail plays from, relative to the proxy
  /// (`/inbound/missed/:id/voicemail`), when [hasVoicemail]. Null from a
  /// build that serves no voicemail.
  final String? voicemailUrl;

  /// Null: the account's (anyone with the list).
  final String? assigneeUserId;
  final String? assigneeName;

  /// The assignee is no longer an active member ("Former member").
  final bool assigneeDeparted;
  final InboundFollowUpStatus status;
  final String statusRaw;

  /// Null while open.
  final InboundHandledReason? handledReason;
  final String? handledReasonRaw;
  final String? handledByUserId;
  final String? handledByName;
  final DateTime? handledAt;

  bool get isWithheld => fromE164 == null;
  bool get isOpen => status == InboundFollowUpStatus.open;

  @override
  bool operator ==(Object other) =>
      other is InboundMissedCall &&
      other.id == id &&
      other.accountId == accountId &&
      other.routeId == routeId &&
      other.routeName == routeName &&
      other.fromE164 == fromE164 &&
      other.toE164 == toE164 &&
      other.arrivedAt == arrivedAt &&
      other.endedAt == endedAt &&
      other.reasonRaw == reasonRaw &&
      other.closedCauseRaw == closedCauseRaw &&
      other.outcomeRaw == outcomeRaw &&
      other.callerDnc == callerDnc &&
      other.matchedContactId == matchedContactId &&
      other.matchedCampaignId == matchedCampaignId &&
      other.matchedCampaignName == matchedCampaignName &&
      other.callbackDueAt == callbackDueAt &&
      other.hasVoicemail == hasVoicemail &&
      other.voicemailUrl == voicemailUrl &&
      other.assigneeUserId == assigneeUserId &&
      other.assigneeName == assigneeName &&
      other.assigneeDeparted == assigneeDeparted &&
      other.statusRaw == statusRaw &&
      other.handledReasonRaw == handledReasonRaw &&
      other.handledByUserId == handledByUserId &&
      other.handledByName == handledByName &&
      other.handledAt == handledAt;

  @override
  int get hashCode => Object.hash(id, statusRaw, handledReasonRaw, handledAt, assigneeUserId, callbackDueAt);

  @override
  String toString() => 'InboundMissedCall($id, $reasonRaw, $statusRaw)';
}

/// `GET /proxy/agency/inbound/missed`. Contract: `AgencyApi.AgencyInboundMissedPage`.
typedef InboundMissedPage = KeysetPage<InboundMissedCall>;

InboundMissedPage decodeInboundMissedPage(Map<String, Object?> json) =>
    KeysetPage.fromJson(json, InboundMissedCall.fromJson);

/// The query of `GET /proxy/agency/inbound/missed`. Newest first, keyset
/// paged. An agent always sees only the rows assigned to them (the server
/// forces `assignee=me` without `agency.supervise`), so the app leaves
/// [assignee] null. A null member is left off.
///
/// Contract: `AgencyApi.AgencyInboundMissedListQuery`.
@immutable
final class InboundMissedQuery {
  const InboundMissedQuery({this.status, this.assignee, this.reason, this.from, this.to, this.cursor, this.limit});

  /// [assignee] for the caller's own rows.
  static const assigneeMe = 'me';

  /// [assignee] for the rows assigned to nobody (the account's).
  static const assigneeUnassigned = 'unassigned';

  /// Null: the server's default, `open`.
  final InboundFollowUpStatus? status;

  /// [assigneeMe], [assigneeUnassigned], or a user id (supervisors only).
  final String? assignee;
  final InboundMissedReason? reason;

  /// Bounds on `arrived_at`: inclusive start, exclusive end.
  final DateTime? from;
  final DateTime? to;

  /// Opaque, from the previous page's `next_cursor`.
  final String? cursor;

  /// 1–100; the server's default is 50.
  final int? limit;

  InboundMissedQuery withCursor(String? next) => InboundMissedQuery(
    status: status,
    assignee: assignee,
    reason: reason,
    from: from,
    to: to,
    cursor: next,
    limit: limit,
  );

  Map<String, String> toQuery() {
    final s = status;
    final r = reason;
    return <String, String>{
      if (s != null && !s.isUnknown) 'status': s.wire,
      'assignee': ?assignee,
      if (r != null && !r.isUnknown) 'reason': r.wire,
      if (from != null) 'from': isoUtc(from!),
      if (to != null) 'to': isoUtc(to!),
      'cursor': ?cursor,
      if (limit != null) 'limit': '$limit',
    };
  }

  @override
  bool operator ==(Object other) =>
      other is InboundMissedQuery &&
      other.status == status &&
      other.assignee == assignee &&
      other.reason == reason &&
      other.from == from &&
      other.to == to &&
      other.cursor == cursor &&
      other.limit == limit;

  @override
  int get hashCode => Object.hash(status, assignee, reason, from, to, cursor, limit);
}

/// The answer of `POST /inbound/missed/:id/handled`, `/reopen` and `/assign`:
/// the row as it now is. Marking a handled row again, or reopening an open
/// one, answers it unchanged (idempotent).
///
/// Contract: `AgencyApi.AgencyInboundMarkHandledResponse`,
/// `AgencyInboundReopenResponse`, `AgencyInboundMissedAssignResponse`.
@immutable
final class InboundMissedCallResponse {
  const InboundMissedCallResponse({required this.call});

  factory InboundMissedCallResponse.fromJson(Map<String, Object?> j) =>
      InboundMissedCallResponse(call: InboundMissedCall.fromJson(j.obj('call')));

  final InboundMissedCall call;

  @override
  bool operator ==(Object other) => other is InboundMissedCallResponse && other.call == call;

  @override
  int get hashCode => call.hashCode;
}

/// `GET /proxy/agency/inbound/missed/count`: the badge. An agent's own rows.
///
/// Contract: `AgencyApi.AgencyInboundMissedCountResponse`.
@immutable
final class InboundMissedCountResponse {
  const InboundMissedCountResponse({required this.open, required this.openCapped, required this.hasRows});

  factory InboundMissedCountResponse.fromJson(Map<String, Object?> j) => InboundMissedCountResponse(
    open: j.integer('open'),
    openCapped: j.boolean('open_capped'),
    hasRows: j.boolean('has_rows'),
  );

  /// Open rows, at most [inboundMissedCountCap].
  final int open;

  /// There are more open rows than [inboundMissedCountCap].
  final bool openCapped;

  /// Any Missed row, open or handled: the list has something to show.
  final bool hasRows;

  /// What the badge says: `''` for none, `'100+'` when capped.
  String get badge => openCapped ? '$inboundMissedCountCap+' : (open == 0 ? '' : '$open');

  @override
  bool operator ==(Object other) =>
      other is InboundMissedCountResponse &&
      other.open == open &&
      other.openCapped == openCapped &&
      other.hasRows == hasRows;

  @override
  int get hashCode => Object.hash(open, openCapped, hasRows);
}

// ─── Refusals ───────────────────────────────────────────────────────────────
//
// Read from an `ErrorBody` through `inboundCode` and its typed accessors
// (`errors.dart`), each null when the body is not that refusal.

/// 400 `inbound_disposition_invalid`: which rule refused the outcome, and
/// (for [InboundDispositionRule.unknownCode]) the codes the call's catalog takes.
///
/// Contract: `AgencyInboundErrorResponse` (`reason`, `allowed_codes`).
@immutable
final class InboundDispositionRefusal {
  InboundDispositionRefusal({
    required this.rule,
    this.ruleRaw,
    List<String>? allowedCodes,
    this.inboundCallId,
    required this.message,
  }) : allowedCodes = allowedCodes == null ? null : List.unmodifiable(allowedCodes);

  /// [InboundDispositionRule.unknown] when the body had no `reason` or a new one.
  final InboundDispositionRule rule;
  final String? ruleRaw;
  final List<String>? allowedCodes;
  final String? inboundCallId;
  final String message;

  @override
  bool operator ==(Object other) =>
      other is InboundDispositionRefusal &&
      other.ruleRaw == ruleRaw &&
      listEquals(other.allowedCodes, allowedCodes) &&
      other.inboundCallId == inboundCallId &&
      other.message == message;

  @override
  int get hashCode => Object.hash(ruleRaw, listHash(allowedCodes), inboundCallId, message);
}

/// 409 `inbound_call_live` from the campaign session routes (`available`,
/// `force-available`, `leave`) and the return from the soft phone: the session
/// holds an inbound call that is offered, connected or owing its outcome.
/// The station's `inbound_call` frame (re-sent after every reconnect) shows it;
/// fetch it by [inboundCallId] if the app has no copy.
///
/// Contract: `AgencyApi.AgencyInboundCallLiveRefusal`.
@immutable
final class InboundCallLiveRefusal {
  const InboundCallLiveRefusal({required this.inboundCallId, required this.message});

  final String inboundCallId;
  final String message;

  @override
  bool operator ==(Object other) =>
      other is InboundCallLiveRefusal && other.inboundCallId == inboundCallId && other.message == message;

  @override
  int get hashCode => Object.hash(inboundCallId, message);
}

/// Every inbound refusal code. Key copy off this; show the body's `message`
/// for [unknown]. The route editor's and clip codes are listed so the enum
/// mirrors the contract; the app meets only the call, Missed and flag codes.
///
/// Contract: `AgencyInboundErrorCode` / `AGENCY_INBOUND_ERROR_CODES` (`errors.ts` §6).
enum InboundErrorCode implements WireEnum {
  /// 403: inbound is off for the tenant or account (the route editor and the queue tiles;
  /// never the call routes or the Missed list).
  inboundDisabled('inbound_disabled'),
  inboundRouteInvalid('inbound_route_invalid'),
  inboundRouteNotFound('inbound_route_not_found'),
  inboundRouteNameTaken('inbound_route_name_taken'),
  inboundNumberNotFound('inbound_number_not_found'),
  inboundNumberNotLinked('inbound_number_not_linked'),
  inboundNumberInUse('inbound_number_in_use'),

  /// 404: no such Missed row the caller may see.
  inboundMissedCallNotFound('inbound_missed_call_not_found'),

  /// 409 from the session routes: see [InboundCallLiveRefusal].
  inboundCallLive('inbound_call_live'),

  /// 404: no such inbound call the caller may act on.
  inboundCallNotFound('inbound_call_not_found'),

  /// 409: the call cannot take an outcome (still live, or it never reached an agent).
  inboundCallNotDispositionable('inbound_call_not_dispositionable'),

  /// 400: see [InboundDispositionRefusal].
  inboundDispositionInvalid('inbound_disposition_invalid'),

  /// 409: another outcome is already saved, or it lapsed.
  inboundOutcomeAlreadySaved('inbound_outcome_already_saved'),
  inboundClipNotFound('inbound_clip_not_found'),
  inboundClipInUse('inbound_clip_in_use'),
  inboundClipInvalid('inbound_clip_invalid'),
  inboundClipNameTaken('inbound_clip_name_taken'),
  inboundClipStorageUnavailable('inbound_clip_storage_unavailable'),

  /// 409 (`/assign`): the row is already handled.
  inboundMissedCallHandled('inbound_missed_call_handled'),
  inboundAssigneeInvalid('inbound_assignee_invalid'),
  unknown('');

  const InboundErrorCode(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static InboundErrorCode fromWire(String? raw) => _byWire[raw] ?? unknown;
}
