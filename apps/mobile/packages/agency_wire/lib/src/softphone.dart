/// The soft phone: an agent types a number and calls it outside campaign
/// pacing, from a soft-phone session or from a campaign session switched to the
/// soft phone (SP7).
///
/// Contract: `packages/contracts/src/agency/softphone.ts` (the dialer's shapes,
/// which the public API layer passes through) and the console's reading of it
/// in `api/agency/softphone.ts` (the request bodies without the server-filled
/// actor, the list row and the call detail). Routes live under
/// `/proxy/agency/softphone/*`, plus the SP7 switch and return on
/// `/proxy/agency/sessions/:id/softphone`.
///
/// The manual call row ([ManualCall]) is the one shape every answer carries:
/// the `manual_call` station frame, `POST /calls`, the hang-up, the outcome,
/// `PATCH`, bootstrap and the list all send the whole row, so a client keeps the
/// newest copy it has seen rather than patching one.
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'equality.dart';
import 'json.dart';
import 'reads.dart';
import 'session.dart';
import 'station.dart';

/// The reserved break of an agent on the soft phone (`SOFTPHONE_BREAK_REASON`).
const softphoneBreakReason = 'soft_phone';

/// Bounds of a DNC or calling-hours override note, in characters after
/// trimming (`SOFTPHONE_OVERRIDE_NOTE_MIN` / `_MAX`).
const softphoneOverrideNoteMin = 10;
const softphoneOverrideNoteMax = 500;

/// How long an ended call waits for its outcome before it lapses
/// (`SOFTPHONE_OUTCOME_LAPSE_MS`). The row's `outcome_due_at` already says when.
const softphoneOutcomeLapse = Duration(minutes: 30);

// ─── The manual call ────────────────────────────────────────────────────────

/// The campaign a call is logged to: chosen before Call and fixed for the call.
///
/// Contract: `AgencyManualCallTag`.
@immutable
final class ManualCallTag {
  const ManualCallTag({required this.campaignId, required this.campaignName});

  factory ManualCallTag.fromJson(Map<String, Object?> j) =>
      ManualCallTag(campaignId: j.str('campaign_id'), campaignName: j.str('campaign_name'));

  final String campaignId;

  /// A placeholder name when the campaign row is gone; never empty.
  final String campaignName;

  @override
  bool operator ==(Object other) =>
      other is ManualCallTag && other.campaignId == campaignId && other.campaignName == campaignName;

  @override
  int get hashCode => Object.hash(campaignId, campaignName);
}

/// The roster contact the dialled number matched on the tagged campaign.
///
/// [context] and [priorAttempts] ride on the live call (frame, `POST /calls`,
/// bootstrap) and on the detail only, never on a list row: null there.
///
/// Contract: `AgencyManualCallContact`.
@immutable
final class ManualCallContact {
  ManualCallContact({
    required this.contactId,
    required this.state,
    String? stateRaw,
    required this.claimed,
    Map<String, Object?>? context,
    List<PriorAttempt>? priorAttempts,
  }) : stateRaw = stateRaw ?? state.wire,
       context = context == null ? null : frozenMap(context),
       priorAttempts = priorAttempts == null ? null : List.unmodifiable(priorAttempts);

  factory ManualCallContact.fromJson(Map<String, Object?> j) {
    final state = j.str('state');
    return ManualCallContact(
      contactId: j.str('contact_id'),
      state: ContactState.fromWire(state),
      stateRaw: state,
      claimed: j.boolean('claimed'),
      context: j.objOrNull('context'),
      priorAttempts: j.listOrNull('prior_attempts', PriorAttempt.fromJson),
    );
  }

  final String contactId;

  /// The contact's state now, not at dial.
  final ContactState state;
  final String stateRaw;

  /// Whether this call claimed the contact, so its outcome settles the roster
  /// row. False when the number only matched (linked).
  final bool claimed;

  /// The roster columns, original headers as keys. Untrusted display text:
  /// render through the tag's `context_display`.
  final Map<String, Object?>? context;

  /// Earlier dials of this contact, newest first.
  final List<PriorAttempt>? priorAttempts;

  @override
  bool operator ==(Object other) =>
      other is ManualCallContact &&
      other.contactId == contactId &&
      other.stateRaw == stateRaw &&
      other.claimed == claimed &&
      jsonEquals(other.context, context) &&
      listEquals(other.priorAttempts, priorAttempts);

  @override
  int get hashCode => Object.hash(contactId, stateRaw, claimed, jsonHash(context), listHash(priorAttempts));
}

/// One soft-phone dial (`agency_manual_calls`), whole.
///
/// `state` and `outcome` are the attempt vocabularies. `bridged_at` non-null is
/// the instant audio is live both ways (there is no separate `bridged` frame).
///
/// Contract: `AgencyManualCall`. Not final: [ManualCallListRow] extends it.
@immutable
class ManualCall {
  ManualCall({
    required this.id,
    required this.sessionId,
    required this.agentUserId,
    this.agentName,
    required this.destinationE164,
    required this.callerId,
    this.tag,
    this.contact,
    required this.state,
    String? stateRaw,
    this.outcome,
    String? outcomeRaw,
    this.endReason,
    String? endReasonRaw,
    required this.recordingRequested,
    required this.dncOverridden,
    required this.hoursOverridden,
    required this.requiresDisposition,
    this.outcomeDueAt,
    this.dispositionCode,
    this.dispositionSource,
    String? dispositionSourceRaw,
    this.notes,
    this.callbackAt,
    Map<String, Object?> fields = const <String, Object?>{},
    this.dispositionedByUserId,
    this.dispositionedAt,
    required this.dispositionedOnBehalf,
    this.webrtcCallId,
    this.canCancelRinging,
    this.dialedAt,
    this.answeredAt,
    this.bridgedAt,
    this.endedAt,
    this.talkSeconds,
    this.settledAt,
    required this.createdAt,
    required this.updatedAt,
  }) : stateRaw = stateRaw ?? state.wire,
       outcomeRaw = outcomeRaw ?? outcome?.wire,
       endReasonRaw = endReasonRaw ?? endReason?.wire,
       dispositionSourceRaw = dispositionSourceRaw ?? dispositionSource?.wire,
       fields = frozenMap(fields);

  factory ManualCall.fromJson(Map<String, Object?> j) {
    final f = _ManualCallFields.read(j);
    return ManualCall(
      id: f.id,
      sessionId: f.sessionId,
      agentUserId: f.agentUserId,
      agentName: f.agentName,
      destinationE164: f.destinationE164,
      callerId: f.callerId,
      tag: f.tag,
      contact: f.contact,
      state: AttemptState.fromWire(f.state),
      stateRaw: f.state,
      outcome: f.outcome == null ? null : AttemptOutcome.fromWire(f.outcome),
      outcomeRaw: f.outcome,
      endReason: f.endReason == null ? null : ManualCallEndReason.fromWire(f.endReason),
      endReasonRaw: f.endReason,
      recordingRequested: f.recordingRequested,
      dncOverridden: f.dncOverridden,
      hoursOverridden: f.hoursOverridden,
      requiresDisposition: f.requiresDisposition,
      outcomeDueAt: f.outcomeDueAt,
      dispositionCode: f.dispositionCode,
      dispositionSource: f.dispositionSource == null ? null : DispositionSource.fromWire(f.dispositionSource),
      dispositionSourceRaw: f.dispositionSource,
      notes: f.notes,
      callbackAt: f.callbackAt,
      fields: f.fields,
      dispositionedByUserId: f.dispositionedByUserId,
      dispositionedAt: f.dispositionedAt,
      dispositionedOnBehalf: f.dispositionedOnBehalf,
      webrtcCallId: f.webrtcCallId,
      canCancelRinging: f.canCancelRinging,
      dialedAt: f.dialedAt,
      answeredAt: f.answeredAt,
      bridgedAt: f.bridgedAt,
      endedAt: f.endedAt,
      talkSeconds: f.talkSeconds,
      settledAt: f.settledAt,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    );
  }

  /// [ManualCall.fromJson], or null when [json] is not a readable row. For the
  /// station frame and refusal bodies, where one malformed row must not take
  /// the whole frame or refusal down with it.
  static ManualCall? tryFromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    try {
      return ManualCall.fromJson(json);
    } on FormatException {
      return null;
    } on TypeError {
      return null;
    }
  }

  final String id;
  final String sessionId;

  /// The agent who placed it.
  final String agentUserId;

  /// Filled on bootstrap, the list and the detail; null on the frame and the
  /// call routes' answers (they go to the agent who placed the call).
  final String? agentName;

  /// E.164, as dialled.
  final String destinationE164;
  final String callerId;

  /// Null for an untagged call.
  final ManualCallTag? tag;

  /// Null when untagged, or the number is not on the tag's roster.
  final ManualCallContact? contact;

  final AttemptState state;
  final String stateRaw;

  /// Null until classified.
  final AttemptOutcome? outcome;
  final String? outcomeRaw;

  /// Null until `ended`.
  final ManualCallEndReason? endReason;
  final String? endReasonRaw;

  /// Recording was asked for at dial (the account's `allow_recording` still applies).
  final bool recordingRequested;

  /// A DNC refusal (SP1) / a calling-hours refusal (SP2) was overridden to place it.
  final bool dncOverridden;
  final bool hoursOverridden;

  /// It ended after it was answered and is not settled: the session cannot
  /// dial again until its outcome is saved (or it lapses at [outcomeDueAt]).
  final bool requiresDisposition;

  /// When an awaited outcome lapses; null when none is awaited.
  final DateTime? outcomeDueAt;
  final String? dispositionCode;

  /// The catalog [dispositionCode] belongs to.
  final DispositionSource? dispositionSource;
  final String? dispositionSourceRaw;
  final String? notes;
  final DateTime? callbackAt;

  /// The call-field values, keyed by `CallField.key`: a string (`text`,
  /// `choice`, `date` as `YYYY-MM-DD`), a number, a bool, or null (empty).
  final Map<String, Object?> fields;

  /// Who saved the outcome, which is not always who took the call.
  final String? dispositionedByUserId;
  final DateTime? dispositionedAt;
  final bool dispositionedOnBehalf;

  /// The media leg (`agency_calls.id`).
  final String? webrtcCallId;

  /// Hanging up while the call rings stops the customer's phone ringing: the
  /// media leg's carrier cancels a ringing call (SP3). On the live call only
  /// (the frame, the call routes' answers, bootstrap, the `manual_call_live`
  /// refusal); null on a list row. False before the leg is placed and for a
  /// carrier that cannot. Anything but `true`: warn before a ringing hang-up.
  final bool? canCancelRinging;
  final DateTime? dialedAt;
  final DateTime? answeredAt;

  /// Audio is live both ways from here: the talk timer and the uplink start now.
  final DateTime? bridgedAt;
  final DateTime? endedAt;
  final int? talkSeconds;

  /// Outcome saved, lapsed, or an unanswered call closed. Null while live or
  /// awaiting an outcome.
  final DateTime? settledAt;
  final DateTime createdAt;
  final DateTime updatedAt;

  /// Settled: nothing more happens to this call.
  bool get isSettled => settledAt != null;

  /// Still on the line: not settled and not `ended`.
  bool get isLive => settledAt == null && state != AttemptState.ended;

  /// Holds its session: live, or ended and owing its outcome.
  bool get isUnsettled => settledAt == null && (state != AttemptState.ended || requiresDisposition);

  /// Ended and owing its outcome.
  bool get owesOutcome => settledAt == null && state == AttemptState.ended && requiresDisposition;

  /// `id@updated_at`: names this copy of the row, so a holder can retire the
  /// copy it was asked about and keep a newer one that arrived since.
  String get versionKey => '$id@${isoUtc(updatedAt)}';

  @override
  bool operator ==(Object other) => other is ManualCall && other.runtimeType == runtimeType && _sameCall(other);

  bool _sameCall(ManualCall o) =>
      o.id == id &&
      o.sessionId == sessionId &&
      o.agentUserId == agentUserId &&
      o.agentName == agentName &&
      o.destinationE164 == destinationE164 &&
      o.callerId == callerId &&
      o.tag == tag &&
      o.contact == contact &&
      o.stateRaw == stateRaw &&
      o.outcomeRaw == outcomeRaw &&
      o.endReasonRaw == endReasonRaw &&
      o.recordingRequested == recordingRequested &&
      o.dncOverridden == dncOverridden &&
      o.hoursOverridden == hoursOverridden &&
      o.requiresDisposition == requiresDisposition &&
      o.outcomeDueAt == outcomeDueAt &&
      o.dispositionCode == dispositionCode &&
      o.dispositionSourceRaw == dispositionSourceRaw &&
      o.notes == notes &&
      o.callbackAt == callbackAt &&
      jsonEquals(o.fields, fields) &&
      o.dispositionedByUserId == dispositionedByUserId &&
      o.dispositionedAt == dispositionedAt &&
      o.dispositionedOnBehalf == dispositionedOnBehalf &&
      o.webrtcCallId == webrtcCallId &&
      o.canCancelRinging == canCancelRinging &&
      o.dialedAt == dialedAt &&
      o.answeredAt == answeredAt &&
      o.bridgedAt == bridgedAt &&
      o.endedAt == endedAt &&
      o.talkSeconds == talkSeconds &&
      o.settledAt == settledAt &&
      o.createdAt == createdAt &&
      o.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(id, stateRaw, updatedAt, settledAt, contact, jsonHash(fields), notes);

  @override
  String toString() => 'ManualCall($id, $stateRaw, updated: ${isoUtc(updatedAt)}, settled: ${settledAt != null})';
}

/// The fields of a manual-call row, read once and shared by [ManualCall] and
/// [ManualCallListRow].
final class _ManualCallFields {
  _ManualCallFields.read(Map<String, Object?> j)
    : id = j.str('id'),
      sessionId = j.str('session_id'),
      agentUserId = j.str('agent_user_id'),
      agentName = j.strOrNull('agent_name'),
      destinationE164 = j.str('destination_e164'),
      callerId = j.str('caller_id'),
      tag = _tag(j),
      contact = _contact(j),
      state = j.str('state'),
      outcome = j.strOrNull('outcome'),
      endReason = j.strOrNull('end_reason'),
      recordingRequested = j.boolean('recording_requested'),
      dncOverridden = j.boolean('dnc_overridden'),
      hoursOverridden = j.boolean('hours_overridden'),
      requiresDisposition = j.boolean('requires_disposition'),
      outcomeDueAt = j.timeOrNull('outcome_due_at'),
      dispositionCode = j.strOrNull('disposition_code'),
      dispositionSource = j.strOrNull('disposition_source'),
      notes = j.strOrNull('notes'),
      callbackAt = j.timeOrNull('callback_at'),
      fields = j.objOrNull('fields') ?? const <String, Object?>{},
      dispositionedByUserId = j.strOrNull('dispositioned_by_user_id'),
      dispositionedAt = j.timeOrNull('dispositioned_at'),
      dispositionedOnBehalf = j.boolOrNull('dispositioned_on_behalf') ?? false,
      webrtcCallId = j.strOrNull('webrtc_call_id'),
      canCancelRinging = j.boolOrNull('can_cancel_ringing'),
      dialedAt = j.timeOrNull('dialed_at'),
      answeredAt = j.timeOrNull('answered_at'),
      bridgedAt = j.timeOrNull('bridged_at'),
      endedAt = j.timeOrNull('ended_at'),
      talkSeconds = j.integerOrNull('talk_seconds'),
      settledAt = j.timeOrNull('settled_at'),
      createdAt = j.time('created_at'),
      updatedAt = j.time('updated_at');

  static ManualCallTag? _tag(Map<String, Object?> j) {
    final t = j.objOrNull('tag');
    return t == null ? null : ManualCallTag.fromJson(t);
  }

  static ManualCallContact? _contact(Map<String, Object?> j) {
    final c = j.objOrNull('contact');
    return c == null ? null : ManualCallContact.fromJson(c);
  }

  final String id;
  final String sessionId;
  final String agentUserId;
  final String? agentName;
  final String destinationE164;
  final String callerId;
  final ManualCallTag? tag;
  final ManualCallContact? contact;
  final String state;
  final String? outcome;
  final String? endReason;
  final bool recordingRequested;
  final bool dncOverridden;
  final bool hoursOverridden;
  final bool requiresDisposition;
  final DateTime? outcomeDueAt;
  final String? dispositionCode;
  final String? dispositionSource;
  final String? notes;
  final DateTime? callbackAt;
  final Map<String, Object?> fields;
  final String? dispositionedByUserId;
  final DateTime? dispositionedAt;
  final bool dispositionedOnBehalf;
  final String? webrtcCallId;
  final bool? canCancelRinging;
  final DateTime? dialedAt;
  final DateTime? answeredAt;
  final DateTime? bridgedAt;
  final DateTime? endedAt;
  final int? talkSeconds;
  final DateTime? settledAt;
  final DateTime createdAt;
  final DateTime updatedAt;
}

// ─── Call fields, settings, bootstrap ───────────────────────────────────────

/// One call detail the agent fills in on every soft-phone call (per account).
///
/// Contract: `AgencyCallField`.
@immutable
final class CallField {
  CallField({
    required this.key,
    required this.label,
    required this.type,
    String? typeRaw,
    List<String>? options,
    this.required = false,
  }) : typeRaw = typeRaw ?? type.wire,
       options = options == null ? null : List.unmodifiable(options);

  factory CallField.fromJson(Map<String, Object?> j) {
    final type = j.str('type');
    return CallField(
      key: j.str('key'),
      label: j.str('label'),
      type: CallFieldType.fromWire(type),
      typeRaw: type,
      options: j.stringsOrNull('options'),
      required: j.boolOrNull('required') ?? false,
    );
  }

  /// The value's key on the call (`ManualCall.fields`).
  final String key;
  final String label;
  final CallFieldType type;
  final String typeRaw;

  /// `choice` only: the allowed values.
  final List<String>? options;

  /// The outcome cannot be saved while it is empty. Live edits may leave it empty.
  final bool required;

  @override
  bool operator ==(Object other) =>
      other is CallField &&
      other.key == key &&
      other.label == label &&
      other.typeRaw == typeRaw &&
      listEquals(other.options, options) &&
      other.required == required;

  @override
  int get hashCode => Object.hash(key, label, typeRaw, listHash(options), required);
}

/// A calling window as the pre-dial gate evaluates it.
///
/// Contract: `AgencyCallingWindow`.
@immutable
final class CallingWindow {
  CallingWindow({required this.start, required this.end, required List<int> days, required this.timezone})
    : days = List.unmodifiable(days);

  factory CallingWindow.fromJson(Map<String, Object?> j) {
    final days = j['days'];
    if (days is! List<Object?>) throw const WireFormatException('expected an array of day numbers', 'days');
    return CallingWindow(
      start: j.str('start'),
      end: j.str('end'),
      days: [
        for (final d in days)
          if (d is num && d.isFinite) d.toInt() else throw const WireFormatException('expected a day number', 'days'),
      ],
      timezone: j.str('timezone'),
    );
  }

  /// `HH:MM` or `HH:MM:SS`, in [timezone].
  final String start;
  final String end;

  /// ISO day numbers, 1 = Monday … 7 = Sunday.
  final List<int> days;

  /// An IANA zone. The app has no zone database: show it as the server names it.
  final String timezone;

  @override
  bool operator ==(Object other) =>
      other is CallingWindow &&
      other.start == start &&
      other.end == end &&
      listEquals(other.days, days) &&
      other.timezone == timezone;

  @override
  int get hashCode => Object.hash(start, end, listHash(days), timezone);
}

/// Contract: `AgencySoftphoneProfileSummary`.
@immutable
final class SoftphoneProfileSummary {
  const SoftphoneProfileSummary({required this.id, required this.name});

  factory SoftphoneProfileSummary.fromJson(Map<String, Object?> j) =>
      SoftphoneProfileSummary(id: j.str('id'), name: j.str('name'));

  final String id;
  final String name;

  @override
  bool operator ==(Object other) => other is SoftphoneProfileSummary && other.id == id && other.name == name;

  @override
  int get hashCode => Object.hash(id, name);
}

SoftphoneProfileSummary? _profile(Map<String, Object?> j) {
  final p = j.objOrNull('analysis_profile');
  return p == null ? null : SoftphoneProfileSummary.fromJson(p);
}

/// A campaign the agent may log a call to (`running` or `paused`, staffed),
/// with everything a call tagged to it uses. Bootstrap's `call_campaign` has
/// the same shape for the campaign the current call is logged to.
///
/// Contract: `AgencySoftphoneCampaign`.
@immutable
final class SoftphoneCampaign {
  SoftphoneCampaign({
    required this.campaignId,
    required this.campaignName,
    required this.status,
    String? statusRaw,
    required List<String> callerIds,
    required List<Disposition> dispositionCatalog,
    required this.callingWindow,
    required this.callingWindowOpen,
    required this.recordCalls,
    this.analysisProfile,
    required this.contextDisplay,
  }) : statusRaw = statusRaw ?? status.wire,
       callerIds = List.unmodifiable(callerIds),
       dispositionCatalog = List.unmodifiable(dispositionCatalog);

  factory SoftphoneCampaign.fromJson(Map<String, Object?> j) {
    final status = j.str('status');
    return SoftphoneCampaign(
      campaignId: j.str('campaign_id'),
      campaignName: j.str('campaign_name'),
      status: CampaignStatus.fromWire(status),
      statusRaw: status,
      callerIds: j.strings('caller_ids'),
      dispositionCatalog: j.list('disposition_catalog', Disposition.fromJson),
      callingWindow: CallingWindow.fromJson(j.obj('calling_window')),
      callingWindowOpen: j.boolean('calling_window_open'),
      recordCalls: j.boolean('record_calls'),
      analysisProfile: _profile(j),
      contextDisplay: ContextDisplay.fromJson(j.obj('context_display')),
    );
  }

  final String campaignId;
  final String campaignName;
  final CampaignStatus status;
  final String statusRaw;

  /// The numbers a tagged call may dial from; the first is the default.
  final List<String> callerIds;
  final List<Disposition> dispositionCatalog;

  /// In the campaign's default timezone.
  final CallingWindow callingWindow;

  /// Advisory, at bootstrap time: whether a dial would pass the window gate.
  /// "may need a reason" when false.
  final bool callingWindowOpen;
  final bool recordCalls;

  /// Null: the account default applies.
  final SoftphoneProfileSummary? analysisProfile;

  /// How to render a matched contact's context.
  final ContextDisplay contextDisplay;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneCampaign &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.statusRaw == statusRaw &&
      listEquals(other.callerIds, callerIds) &&
      listEquals(other.dispositionCatalog, dispositionCatalog) &&
      other.callingWindow == callingWindow &&
      other.callingWindowOpen == callingWindowOpen &&
      other.recordCalls == recordCalls &&
      other.analysisProfile == analysisProfile &&
      other.contextDisplay == contextDisplay;

  @override
  int get hashCode => Object.hash(
    campaignId,
    campaignName,
    statusRaw,
    listHash(callerIds),
    listHash(dispositionCatalog),
    callingWindow,
    callingWindowOpen,
    recordCalls,
    analysisProfile,
    contextDisplay,
  );
}

/// What an untagged call dials with and is dispositioned against.
///
/// Contract: `AgencySoftphoneUntagged`.
@immutable
final class SoftphoneUntagged {
  SoftphoneUntagged({
    required List<String> callerIds,
    this.defaultCallerId,
    required List<Disposition> dispositionCatalog,
    required this.recordCalls,
    this.analysisProfile,
  }) : callerIds = List.unmodifiable(callerIds),
       dispositionCatalog = List.unmodifiable(dispositionCatalog);

  factory SoftphoneUntagged.fromJson(Map<String, Object?> j) => SoftphoneUntagged(
    callerIds: j.strings('caller_ids'),
    defaultCallerId: j.strOrNull('default_caller_id'),
    dispositionCatalog: j.list('disposition_catalog', Disposition.fromJson),
    recordCalls: j.boolean('record_calls'),
    analysisProfile: _profile(j),
  );

  /// The account's assigned numbers.
  final List<String> callerIds;

  /// Pre-selected for an untagged call while it is still one of [callerIds].
  final String? defaultCallerId;

  /// Resolved by the server; never empty.
  final List<Disposition> dispositionCatalog;
  final bool recordCalls;
  final SoftphoneProfileSummary? analysisProfile;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneUntagged &&
      listEquals(other.callerIds, callerIds) &&
      other.defaultCallerId == defaultCallerId &&
      listEquals(other.dispositionCatalog, dispositionCatalog) &&
      other.recordCalls == recordCalls &&
      other.analysisProfile == analysisProfile;

  @override
  int get hashCode =>
      Object.hash(listHash(callerIds), defaultCallerId, listHash(dispositionCatalog), recordCalls, analysisProfile);
}

/// The agent's live session in the TENANT, as the soft phone sees it. It may
/// be in a sibling account of the one bootstrap was read for ([accountId]):
/// then bootstrap's `call` is not read, and every session route on it must be
/// sent with [accountId].
///
/// Contract: `AgencySoftphoneSessionSummary`.
@immutable
final class SoftphoneSessionSummary {
  SoftphoneSessionSummary({
    required this.sessionId,
    required this.accountId,
    required this.kind,
    String? kindRaw,
    this.campaignId,
    this.campaignName,
    required this.state,
    String? stateRaw,
    this.breakReason,
    required this.onSoftphone,
    this.pendingState,
    String? pendingStateRaw,
    this.pendingBreakReason,
  }) : kindRaw = kindRaw ?? kind.wire,
       stateRaw = stateRaw ?? state.wire,
       pendingStateRaw = pendingStateRaw ?? pendingState?.wire;

  factory SoftphoneSessionSummary.fromJson(Map<String, Object?> j) {
    final kind = j.str('kind');
    final state = j.str('state');
    final pending = j.strOrNull('pending_state');
    return SoftphoneSessionSummary(
      sessionId: j.str('session_id'),
      accountId: j.str('account_id'),
      kind: SessionKind.fromWire(kind),
      kindRaw: kind,
      campaignId: j.strOrNull('campaign_id'),
      campaignName: j.strOrNull('campaign_name'),
      state: AgentState.fromWire(state),
      stateRaw: state,
      breakReason: j.strOrNull('break_reason'),
      onSoftphone: j.boolean('on_softphone'),
      pendingState: pending == null ? null : AgentState.fromWire(pending),
      pendingStateRaw: pending,
      pendingBreakReason: j.strOrNull('pending_break_reason'),
    );
  }

  final String sessionId;
  final String accountId;
  final SessionKind kind;
  final String kindRaw;

  /// Null for a soft-phone session.
  final String? campaignId;
  final String? campaignName;
  final AgentState state;
  final String stateRaw;
  final String? breakReason;

  /// `break/soft_phone`: the session can dial.
  final bool onSoftphone;

  /// A switch to the soft phone queued behind a call or wrap-up.
  final AgentState? pendingState;
  final String? pendingStateRaw;
  final String? pendingBreakReason;

  bool get switchQueued => pendingState == AgentState.onBreak && pendingBreakReason == softphoneBreakReason;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneSessionSummary &&
      other.sessionId == sessionId &&
      other.accountId == accountId &&
      other.kindRaw == kindRaw &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.stateRaw == stateRaw &&
      other.breakReason == breakReason &&
      other.onSoftphone == onSoftphone &&
      other.pendingStateRaw == pendingStateRaw &&
      other.pendingBreakReason == pendingBreakReason;

  @override
  int get hashCode => Object.hash(
    sessionId,
    accountId,
    kindRaw,
    campaignId,
    campaignName,
    stateRaw,
    breakReason,
    onSoftphone,
    pendingStateRaw,
    pendingBreakReason,
  );
}

/// `GET /proxy/agency/softphone/bootstrap`, sent with an account scope.
///
/// Answers while the flag is off ([softphoneEnabled] false), so an agent the
/// flag was switched off under can finish their call: then only finishing
/// works (hang up, details, outcome, Mark DNC, return, rehydrate).
///
/// Contract: `AgencySoftphoneBootstrap`.
@immutable
final class SoftphoneBootstrap {
  SoftphoneBootstrap({
    required this.softphoneEnabled,
    required List<SoftphoneCampaign> taggableCampaigns,
    required this.untagged,
    required List<CallField> callFields,
    required this.defaultCountryCode,
    this.session,
    this.call,
    this.callCampaign,
  }) : taggableCampaigns = List.unmodifiable(taggableCampaigns),
       callFields = List.unmodifiable(callFields);

  factory SoftphoneBootstrap.fromJson(Map<String, Object?> j) {
    final session = j.objOrNull('session');
    final call = j.objOrNull('call');
    final callCampaign = j.objOrNull('call_campaign');
    return SoftphoneBootstrap(
      softphoneEnabled: j.boolean('softphone_enabled'),
      taggableCampaigns: j.list('taggable_campaigns', SoftphoneCampaign.fromJson),
      untagged: SoftphoneUntagged.fromJson(j.obj('untagged')),
      callFields: j.list('call_fields', CallField.fromJson),
      defaultCountryCode: j.str('default_country_code'),
      session: session == null ? null : SoftphoneSessionSummary.fromJson(session),
      call: call == null ? null : ManualCall.fromJson(call),
      callCampaign: callCampaign == null ? null : SoftphoneCampaign.fromJson(callCampaign),
    );
  }

  /// `agency_softphone_enabled` for the tenant and account. False: finish mode.
  final bool softphoneEnabled;
  final List<SoftphoneCampaign> taggableCampaigns;
  final SoftphoneUntagged untagged;

  /// Applies to every call, tagged or not. Empty means the account has none.
  final List<CallField> callFields;

  /// Read a number typed without a country code in this one (`+91`).
  final String defaultCountryCode;

  /// The agent's live session in the tenant, or null.
  final SoftphoneSessionSummary? session;

  /// That session's live call, or its ended call still owing an outcome.
  final ManualCall? call;

  /// The campaign [call] is logged to, taggable or not any more: its catalog
  /// is the one the outcome is saved against.
  final SoftphoneCampaign? callCampaign;

  /// A taggable campaign by id, or null.
  SoftphoneCampaign? taggable(String? campaignId) {
    if (campaignId == null) return null;
    for (final c in taggableCampaigns) {
      if (c.campaignId == campaignId) return c;
    }
    return null;
  }

  @override
  bool operator ==(Object other) =>
      other is SoftphoneBootstrap &&
      other.softphoneEnabled == softphoneEnabled &&
      listEquals(other.taggableCampaigns, taggableCampaigns) &&
      other.untagged == untagged &&
      listEquals(other.callFields, callFields) &&
      other.defaultCountryCode == defaultCountryCode &&
      other.session == session &&
      other.call == call &&
      other.callCampaign == callCampaign;

  @override
  int get hashCode => Object.hash(
    softphoneEnabled,
    listHash(taggableCampaigns),
    untagged,
    listHash(callFields),
    defaultCountryCode,
    session,
    call,
    callCampaign,
  );
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/// `POST /proxy/agency/softphone/sessions` (no body): 201 opened, or 200 when
/// the agent's live soft-phone session in this account was rehydrated. The
/// socket fields mean what they mean on the campaign join; re-mint the token
/// through `POST /sessions/:id/station-token`.
///
/// Contract: `AgencySoftphoneSessionResponse`.
@immutable
final class SoftphoneSessionResponse {
  SoftphoneSessionResponse({
    required this.sessionId,
    required this.kind,
    String? kindRaw,
    required this.state,
    String? stateRaw,
    required this.breakReason,
    required this.stationWsUrl,
    required this.stationTokenExpiresAt,
    required this.intervals,
  }) : kindRaw = kindRaw ?? kind.wire,
       stateRaw = stateRaw ?? state.wire;

  factory SoftphoneSessionResponse.fromJson(Map<String, Object?> j) {
    final kind = j.str('kind');
    final state = j.str('state');
    return SoftphoneSessionResponse(
      sessionId: j.str('session_id'),
      kind: SessionKind.fromWire(kind),
      kindRaw: kind,
      state: AgentState.fromWire(state),
      stateRaw: state,
      breakReason: j.str('break_reason'),
      stationWsUrl: j.str('station_ws_url'),
      stationTokenExpiresAt: j.time('station_token_expires_at'),
      intervals: StationIntervals.fromJson(j.obj('intervals')),
    );
  }

  final String sessionId;

  /// Always `softphone`.
  final SessionKind kind;
  final String kindRaw;

  /// Always `break`, with [breakReason] `soft_phone`.
  final AgentState state;
  final String stateRaw;
  final String breakReason;

  /// Relative, with the token: prefix the `wss://` origin.
  final String stationWsUrl;
  final DateTime stationTokenExpiresAt;
  final StationIntervals intervals;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneSessionResponse &&
      other.sessionId == sessionId &&
      other.kindRaw == kindRaw &&
      other.stateRaw == stateRaw &&
      other.breakReason == breakReason &&
      other.stationWsUrl == stationWsUrl &&
      other.stationTokenExpiresAt == stationTokenExpiresAt &&
      other.intervals == intervals;

  @override
  int get hashCode =>
      Object.hash(sessionId, kindRaw, stateRaw, breakReason, stationWsUrl, stationTokenExpiresAt, intervals);
}

// ─── Requests ───────────────────────────────────────────────────────────────

/// The agent's reasons for dialling through a refusal: [dncNote] overrides
/// `dnc_listed` (SP1), [hoursNote] `outside_calling_hours` (SP2). Each
/// [softphoneOverrideNoteMin]–[softphoneOverrideNoteMax] characters after
/// trimming. A null note is left out.
///
/// Contract: `AgencyManualCallOverridesRequest`.
@immutable
final class ManualCallOverridesRequest {
  const ManualCallOverridesRequest({this.dncNote, this.hoursNote});

  final String? dncNote;
  final String? hoursNote;

  bool get isEmpty => dncNote == null && hoursNote == null;

  ManualCallOverridesRequest withDncNote(String note) =>
      ManualCallOverridesRequest(dncNote: note, hoursNote: hoursNote);
  ManualCallOverridesRequest withHoursNote(String note) =>
      ManualCallOverridesRequest(dncNote: dncNote, hoursNote: note);

  Map<String, Object?> toJson() {
    final json = <String, Object?>{};
    putIfSet(json, 'dnc_note', dncNote);
    putIfSet(json, 'hours_note', hoursNote);
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is ManualCallOverridesRequest && other.dncNote == dncNote && other.hoursNote == hoursNote;

  @override
  int get hashCode => Object.hash(dncNote, hoursNote);
}

/// `POST /proxy/agency/softphone/calls` → 201 [ManualCall]. Never retried: a
/// timeout means the call may have been placed, and the `manual_call` frame or
/// bootstrap says whether it was.
///
/// `campaign_id` is always sent (null: untagged); [fields] and [overrides]
/// only when given, so a request built before the field set loaded never
/// clears values the server holds.
///
/// Contract: `AgencyApi.AgencyManualCallCreateRequest`.
@immutable
final class ManualCallCreateRequest {
  ManualCallCreateRequest({
    required this.sessionId,
    required this.to,
    this.callerId,
    this.campaignId,
    Map<String, Object?>? fields,
    this.overrides,
  }) : fields = fields == null ? null : frozenMap(fields);

  /// The live session, on the soft phone.
  final String sessionId;

  /// As typed; the server normalises it to E.164 in the account's region.
  final String to;

  /// Null: the server picks (the tag's first, else the default, else the first number).
  final String? callerId;

  /// The tag; null logs the call to no campaign.
  final String? campaignId;
  final Map<String, Object?>? fields;
  final ManualCallOverridesRequest? overrides;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{'session_id': sessionId, 'to': to};
    putIfSet(json, 'caller_id', callerId);
    json['campaign_id'] = campaignId;
    putIfSet(json, 'fields', fields);
    final o = overrides;
    if (o != null && !o.isEmpty) json['overrides'] = o.toJson();
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is ManualCallCreateRequest &&
      other.sessionId == sessionId &&
      other.to == to &&
      other.callerId == callerId &&
      other.campaignId == campaignId &&
      jsonEquals(other.fields, fields) &&
      other.overrides == overrides;

  @override
  int get hashCode => Object.hash(sessionId, to, callerId, campaignId, jsonHash(fields), overrides);
}

/// `PATCH /proxy/agency/softphone/calls/:id` while the call is live or owes
/// its outcome; answers the row. [fields] replaces the stored values
/// wholesale, [notes] replaces the notes (`''` clears them). A null member is
/// left out, and the server keeps what it holds.
///
/// Contract: `AgencyApi.AgencyManualCallUpdateRequest`.
@immutable
final class ManualCallUpdateRequest {
  ManualCallUpdateRequest({Map<String, Object?>? fields, this.notes})
    : fields = fields == null ? null : frozenMap(fields);

  final Map<String, Object?>? fields;
  final String? notes;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{};
    putIfSet(json, 'fields', fields);
    putIfSet(json, 'notes', notes);
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is ManualCallUpdateRequest && jsonEquals(other.fields, fields) && other.notes == notes;

  @override
  int get hashCode => Object.hash(jsonHash(fields), notes);
}

/// `POST /proxy/agency/softphone/calls/:id/disposition`: save the outcome.
/// Same omission rules as [ManualCallUpdateRequest]; `notes: ''` clears notes
/// the agent emptied.
///
/// Contract: `AgencyApi.AgencyManualCallDispositionRequest`.
@immutable
final class ManualCallDispositionRequest {
  ManualCallDispositionRequest({required this.code, this.notes, this.callbackAt, Map<String, Object?>? fields})
    : fields = fields == null ? null : frozenMap(fields);

  /// A code of the catalog the call resolves against.
  final String code;
  final String? notes;

  /// Required when the catalog entry sets `requires_datetime`.
  final DateTime? callbackAt;

  /// Saved with the outcome, replacing the stored values; required fields must be filled.
  final Map<String, Object?>? fields;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{'code': code};
    putIfSet(json, 'notes', notes);
    if (callbackAt != null) json['callback_at'] = isoUtc(callbackAt!);
    putIfSet(json, 'fields', fields);
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is ManualCallDispositionRequest &&
      other.code == code &&
      other.notes == notes &&
      other.callbackAt == callbackAt &&
      jsonEquals(other.fields, fields);

  @override
  int get hashCode => Object.hash(code, notes, callbackAt, jsonHash(fields));
}

/// `POST /proxy/agency/softphone/calls/:id/dnc`. The client never states the
/// scope: the tagged campaign, else the call's account.
///
/// Contract: `AgencyApi.AgencyManualCallDncRequest`.
@immutable
final class ManualCallDncRequest {
  const ManualCallDncRequest({this.reason});

  final String? reason;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{};
    putIfSet(json, 'reason', reason);
    return json;
  }

  @override
  bool operator ==(Object other) => other is ManualCallDncRequest && other.reason == reason;

  @override
  int get hashCode => reason.hashCode;
}

// ─── Answers ────────────────────────────────────────────────────────────────

/// Contract: `AgencyManualCallDispositionResponse`.
@immutable
final class ManualCallDispositionResponse {
  ManualCallDispositionResponse({
    required this.call,
    this.contactState,
    String? contactStateRaw,
    this.nextAttemptAt,
    this.callbackRequestedAt,
  }) : contactStateRaw = contactStateRaw ?? contactState?.wire;

  factory ManualCallDispositionResponse.fromJson(Map<String, Object?> j) {
    final contact = j.strOrNull('contact_state');
    return ManualCallDispositionResponse(
      call: ManualCall.fromJson(j.obj('call')),
      contactState: contact == null ? null : ContactState.fromWire(contact),
      contactStateRaw: contact,
      nextAttemptAt: j.timeOrNull('next_attempt_at'),
      callbackRequestedAt: j.timeOrNull('callback_requested_at'),
    );
  }

  /// The row, settled.
  final ManualCall call;

  /// Where the outcome left the matched contact; null when there is none.
  final ContactState? contactState;
  final String? contactStateRaw;

  /// When the dialer will call the contact again, or null.
  final DateTime? nextAttemptAt;
  final DateTime? callbackRequestedAt;

  @override
  bool operator ==(Object other) =>
      other is ManualCallDispositionResponse &&
      other.call == call &&
      other.contactStateRaw == contactStateRaw &&
      other.nextAttemptAt == nextAttemptAt &&
      other.callbackRequestedAt == callbackRequestedAt;

  @override
  int get hashCode => Object.hash(call, contactStateRaw, nextAttemptAt, callbackRequestedAt);
}

/// Contract: `AgencyManualCallDncResponse`.
@immutable
final class ManualCallDncResponse {
  ManualCallDncResponse({
    required this.callId,
    required this.phoneE164,
    required this.scope,
    String? scopeRaw,
    required this.dncRecorded,
    this.contactState,
    String? contactStateRaw,
  }) : scopeRaw = scopeRaw ?? scope.wire,
       contactStateRaw = contactStateRaw ?? contactState?.wire;

  factory ManualCallDncResponse.fromJson(Map<String, Object?> j) {
    final scope = j.str('scope');
    final contact = j.strOrNull('contact_state');
    return ManualCallDncResponse(
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

  /// `campaign` for a tagged call, else `account`.
  final DncEntryScope scope;
  final String scopeRaw;

  /// False when the list write is still in flight (the roster row is suppressed either way).
  final bool dncRecorded;
  final ContactState? contactState;
  final String? contactStateRaw;

  @override
  bool operator ==(Object other) =>
      other is ManualCallDncResponse &&
      other.callId == callId &&
      other.phoneE164 == phoneE164 &&
      other.scopeRaw == scopeRaw &&
      other.dncRecorded == dncRecorded &&
      other.contactStateRaw == contactStateRaw;

  @override
  int get hashCode => Object.hash(callId, phoneE164, scopeRaw, dncRecorded, contactStateRaw);
}

// ─── The list and the detail ────────────────────────────────────────────────

/// A `GET /proxy/agency/softphone/calls` row: the call (no contact context or
/// prior attempts on a list), plus its media leg's summary status.
///
/// Contract: `AgencyApi.AgencyManualCallListRow`.
@immutable
final class ManualCallListRow extends ManualCall {
  ManualCallListRow({
    required super.id,
    required super.sessionId,
    required super.agentUserId,
    super.agentName,
    required super.destinationE164,
    required super.callerId,
    super.tag,
    super.contact,
    required super.state,
    super.stateRaw,
    super.outcome,
    super.outcomeRaw,
    super.endReason,
    super.endReasonRaw,
    required super.recordingRequested,
    required super.dncOverridden,
    required super.hoursOverridden,
    required super.requiresDisposition,
    super.outcomeDueAt,
    super.dispositionCode,
    super.dispositionSource,
    super.dispositionSourceRaw,
    super.notes,
    super.callbackAt,
    super.fields,
    super.dispositionedByUserId,
    super.dispositionedAt,
    required super.dispositionedOnBehalf,
    super.webrtcCallId,
    super.canCancelRinging,
    super.dialedAt,
    super.answeredAt,
    super.bridgedAt,
    super.endedAt,
    super.talkSeconds,
    super.settledAt,
    required super.createdAt,
    required super.updatedAt,
    this.analysisStatusRaw,
  });

  factory ManualCallListRow.fromJson(Map<String, Object?> j) {
    final c = ManualCall.fromJson(j);
    return ManualCallListRow(
      id: c.id,
      sessionId: c.sessionId,
      agentUserId: c.agentUserId,
      agentName: c.agentName,
      destinationE164: c.destinationE164,
      callerId: c.callerId,
      tag: c.tag,
      contact: c.contact,
      state: c.state,
      stateRaw: c.stateRaw,
      outcome: c.outcome,
      outcomeRaw: c.outcomeRaw,
      endReason: c.endReason,
      endReasonRaw: c.endReasonRaw,
      recordingRequested: c.recordingRequested,
      dncOverridden: c.dncOverridden,
      hoursOverridden: c.hoursOverridden,
      requiresDisposition: c.requiresDisposition,
      outcomeDueAt: c.outcomeDueAt,
      dispositionCode: c.dispositionCode,
      dispositionSource: c.dispositionSource,
      dispositionSourceRaw: c.dispositionSourceRaw,
      notes: c.notes,
      callbackAt: c.callbackAt,
      fields: c.fields,
      dispositionedByUserId: c.dispositionedByUserId,
      dispositionedAt: c.dispositionedAt,
      dispositionedOnBehalf: c.dispositionedOnBehalf,
      webrtcCallId: c.webrtcCallId,
      canCancelRinging: c.canCancelRinging,
      dialedAt: c.dialedAt,
      answeredAt: c.answeredAt,
      bridgedAt: c.bridgedAt,
      endedAt: c.endedAt,
      talkSeconds: c.talkSeconds,
      settledAt: c.settledAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      analysisStatusRaw: j.strOrNull('analysis_status'),
    );
  }

  /// The media leg's `analysis_status`, unparsed (supervisor-facing; the app
  /// only shows that a summary exists). Null: no leg, purged, or never ran.
  final String? analysisStatusRaw;

  @override
  bool operator ==(Object other) =>
      other is ManualCallListRow && _sameCall(other) && other.analysisStatusRaw == analysisStatusRaw;

  @override
  int get hashCode => Object.hash(super.hashCode, analysisStatusRaw);
}

/// `GET /proxy/agency/softphone/calls`. Contract: `AgencyApi.AgencyManualCallsPage`.
typedef ManualCallsPage = KeysetPage<ManualCallListRow>;

ManualCallsPage decodeManualCallsPage(Map<String, Object?> json) =>
    KeysetPage.fromJson(json, ManualCallListRow.fromJson);

/// The query of `GET /proxy/agency/softphone/calls`. The app lists the agent's
/// own calls only, so [agentUserId] is required: a supervisor using the app
/// still sees their own, never the account's.
///
/// Contract: `AgencyManualCallListQuery`.
@immutable
final class ManualCallsQuery {
  const ManualCallsQuery({
    required this.agentUserId,
    this.cursor,
    this.limit,
    this.campaignId,
    this.untaggedOnly = false,
    this.status,
    this.outcome,
    this.dispositionCode,
    this.phoneDigits,
    this.contactId,
    this.from,
    this.to,
  });

  /// The signed-in agent's own user id.
  final String agentUserId;

  /// Opaque, from the previous page's `next_cursor`.
  final String? cursor;
  final int? limit;

  /// Calls logged to this campaign.
  final String? campaignId;

  /// Calls logged to no campaign (`campaign_id=untagged`); wins over [campaignId].
  final bool untaggedOnly;
  final ManualCallListStatus? status;
  final AttemptOutcome? outcome;
  final String? dispositionCode;

  /// Digits only (anything else is stripped), matched as a suffix of the
  /// number. Left out when no digit remains (the server refuses an empty term).
  final String? phoneDigits;
  final String? contactId;

  /// Bounds on `created_at`: inclusive start, exclusive end.
  final DateTime? from;
  final DateTime? to;

  ManualCallsQuery withCursor(String? next) => ManualCallsQuery(
    agentUserId: agentUserId,
    cursor: next,
    limit: limit,
    campaignId: campaignId,
    untaggedOnly: untaggedOnly,
    status: status,
    outcome: outcome,
    dispositionCode: dispositionCode,
    phoneDigits: phoneDigits,
    contactId: contactId,
    from: from,
    to: to,
  );

  Map<String, String> toQuery() {
    final digits = phoneDigits?.replaceAll(RegExp(r'\D'), '');
    final s = status;
    final o = outcome;
    return <String, String>{
      'agent_user_id': agentUserId,
      'cursor': ?cursor,
      if (limit != null) 'limit': '$limit',
      if (untaggedOnly) 'campaign_id': 'untagged' else 'campaign_id': ?campaignId,
      if (s != null && !s.isUnknown) 'status': s.wire,
      if (o != null && !o.isUnknown) 'outcome': o.wire,
      'disposition_code': ?dispositionCode,
      if (digits != null && digits.isNotEmpty) 'phone': digits,
      'contact_id': ?contactId,
      if (from != null) 'from': isoUtc(from!),
      if (to != null) 'to': isoUtc(to!),
    };
  }

  @override
  bool operator ==(Object other) =>
      other is ManualCallsQuery &&
      other.agentUserId == agentUserId &&
      other.cursor == cursor &&
      other.limit == limit &&
      other.campaignId == campaignId &&
      other.untaggedOnly == untaggedOnly &&
      other.status == status &&
      other.outcome == outcome &&
      other.dispositionCode == dispositionCode &&
      other.phoneDigits == phoneDigits &&
      other.contactId == contactId &&
      other.from == from &&
      other.to == to;

  @override
  int get hashCode => Object.hash(
    agentUserId,
    cursor,
    limit,
    campaignId,
    untaggedOnly,
    status,
    outcome,
    dispositionCode,
    phoneDigits,
    contactId,
    from,
    to,
  );
}

/// A DNC entry as the `dnc_listed` refusal shows it, and (with [campaignId])
/// as the call detail's overrides do.
///
/// Contract: `AgencySoftphoneDncListedRefusal['entry']` (and `AgencyManualCallOverrides['dnc_entry']`).
@immutable
final class DncEntry {
  DncEntry({
    required this.id,
    required this.scope,
    String? scopeRaw,
    this.reason,
    required this.createdAt,
    this.campaignId,
  }) : scopeRaw = scopeRaw ?? scope.wire;

  factory DncEntry.fromJson(Map<String, Object?> j) {
    final scope = j.str('scope');
    return DncEntry(
      id: j.str('id'),
      scope: DncEntryScope.fromWire(scope),
      scopeRaw: scope,
      reason: j.strOrNull('reason'),
      createdAt: j.time('created_at'),
      campaignId: j.strOrNull('campaign_id'),
    );
  }

  final String id;
  final DncEntryScope scope;
  final String scopeRaw;
  final String? reason;
  final DateTime createdAt;

  /// The campaign of a `campaign`-scope entry; only on the call detail.
  final String? campaignId;

  @override
  bool operator ==(Object other) =>
      other is DncEntry &&
      other.id == id &&
      other.scopeRaw == scopeRaw &&
      other.reason == reason &&
      other.createdAt == createdAt &&
      other.campaignId == campaignId;

  @override
  int get hashCode => Object.hash(id, scopeRaw, reason, createdAt, campaignId);
}

/// The override notes of a call, for its detail.
///
/// Contract: `AgencyManualCallOverrides`.
@immutable
final class ManualCallOverrides {
  const ManualCallOverrides({this.dncNote, this.dncEntryId, this.dncEntry, this.hoursNote});

  factory ManualCallOverrides.fromJson(Map<String, Object?> j) {
    final entry = j.objOrNull('dnc_entry');
    return ManualCallOverrides(
      dncNote: j.strOrNull('dnc_note'),
      dncEntryId: j.strOrNull('dnc_entry_id'),
      dncEntry: entry == null ? null : DncEntry.fromJson(entry),
      hoursNote: j.strOrNull('hours_note'),
    );
  }

  final String? dncNote;
  final String? dncEntryId;

  /// Null when no DNC override was used or the entry has been removed since.
  final DncEntry? dncEntry;
  final String? hoursNote;

  @override
  bool operator ==(Object other) =>
      other is ManualCallOverrides &&
      other.dncNote == dncNote &&
      other.dncEntryId == dncEntryId &&
      other.dncEntry == dncEntry &&
      other.hoursNote == hoursNote;

  @override
  int get hashCode => Object.hash(dncNote, dncEntryId, dncEntry, hoursNote);
}

/// `GET /proxy/agency/softphone/calls/:id`.
///
/// [media] is the media leg's record, supervise-only (always null for an
/// agent, their own call included). The app never renders it; it is kept
/// opaque only so a supervisor's answer still decodes.
///
/// Contract: `AgencyApi.AgencyManualCallDetail`.
@immutable
final class ManualCallDetail {
  ManualCallDetail({
    required this.call,
    this.dispositionedByName,
    required this.overrides,
    Map<String, Object?>? media,
    required this.callAvailability,
    String? callAvailabilityRaw,
  }) : media = media == null ? null : frozenMap(media),
       callAvailabilityRaw = callAvailabilityRaw ?? callAvailability.wire;

  factory ManualCallDetail.fromJson(Map<String, Object?> j) {
    final availability = j.str('call_availability');
    return ManualCallDetail(
      call: ManualCall.fromJson(j.obj('call')),
      dispositionedByName: j.strOrNull('dispositioned_by_name'),
      overrides: ManualCallOverrides.fromJson(j.obj('overrides')),
      media: j.objOrNull('media'),
      callAvailability: CallAvailability.fromWire(availability),
      callAvailabilityRaw: availability,
    );
  }

  /// With the contact's context and prior attempts.
  final ManualCall call;

  /// Who saved the outcome; null when none is saved or the user is gone.
  final String? dispositionedByName;
  final ManualCallOverrides overrides;
  final Map<String, Object?>? media;
  final CallAvailability callAvailability;
  final String callAvailabilityRaw;

  @override
  bool operator ==(Object other) =>
      other is ManualCallDetail &&
      other.call == call &&
      other.dispositionedByName == dispositionedByName &&
      other.overrides == overrides &&
      jsonEquals(other.media, media) &&
      other.callAvailabilityRaw == callAvailabilityRaw;

  @override
  int get hashCode => Object.hash(call, dispositionedByName, overrides, jsonHash(media), callAvailabilityRaw);
}

// ─── Refusals ───────────────────────────────────────────────────────────────
//
// Read from an `ErrorBody` through its typed accessors (`errors.dart`), each
// null when the body is not that refusal or its fields do not read.

/// One offending path of `fields_invalid` / `settings_invalid` /
/// `override_note_invalid` (`fields.<key>`, `overrides.dnc_note`, …).
///
/// Contract: `AgencySoftphoneErrorResponse['details'][number]`.
@immutable
final class FieldIssue {
  const FieldIssue({required this.path, required this.message});

  final String path;
  final String message;

  /// The call-field key [path] names (`fields.loan_amount` → `loan_amount`),
  /// or null when it names no field.
  String? get fieldKey {
    final m = RegExp(r'^fields[.[]([^\]]+)\]?$').firstMatch(path);
    return m?.group(1);
  }

  @override
  bool operator ==(Object other) => other is FieldIssue && other.path == path && other.message == message;

  @override
  int get hashCode => Object.hash(path, message);
}

/// 409 `dnc_listed` (SP1): redial with `overrides.dnc_note` to place it anyway.
///
/// Contract: `AgencySoftphoneDncListedRefusal`.
@immutable
final class SoftphoneDncListedRefusal {
  const SoftphoneDncListedRefusal({required this.entry, required this.message});

  factory SoftphoneDncListedRefusal.fromJson(Map<String, Object?> j) =>
      SoftphoneDncListedRefusal(entry: DncEntry.fromJson(j.obj('entry')), message: j.strOrNull('message') ?? '');

  final DncEntry entry;
  final String message;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneDncListedRefusal && other.entry == entry && other.message == message;

  @override
  int get hashCode => Object.hash(entry, message);
}

/// 409 `outside_calling_hours` (SP2): redial with `overrides.hours_note`.
///
/// Contract: `AgencySoftphoneOutsideHoursRefusal`.
@immutable
final class SoftphoneOutsideHoursRefusal {
  SoftphoneOutsideHoursRefusal({
    required this.window,
    required this.timezoneSource,
    String? timezoneSourceRaw,
    this.nextOpenAt,
    required this.message,
  }) : timezoneSourceRaw = timezoneSourceRaw ?? timezoneSource.wire;

  factory SoftphoneOutsideHoursRefusal.fromJson(Map<String, Object?> j) {
    final source = j.str('timezone_source');
    return SoftphoneOutsideHoursRefusal(
      window: CallingWindow.fromJson(j.obj('window')),
      timezoneSource: HoursTimezoneSource.fromWire(source),
      timezoneSourceRaw: source,
      nextOpenAt: j.timeOrNull('next_open_at'),
      message: j.strOrNull('message') ?? '',
    );
  }

  /// In [window].timezone, the contact's or the campaign default's ([timezoneSource]).
  final CallingWindow window;
  final HoursTimezoneSource timezoneSource;
  final String timezoneSourceRaw;

  /// When the window next opens; null when it never does (no calling days).
  final DateTime? nextOpenAt;
  final String message;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneOutsideHoursRefusal &&
      other.window == window &&
      other.timezoneSourceRaw == timezoneSourceRaw &&
      other.nextOpenAt == nextOpenAt &&
      other.message == message;

  @override
  int get hashCode => Object.hash(window, timezoneSourceRaw, nextOpenAt, message);
}

/// 409 `contact_in_flight`: a campaign attempt is live on the matched contact.
/// No override.
///
/// Contract: `AgencySoftphoneContactInFlightRefusal`.
@immutable
final class SoftphoneContactInFlightRefusal {
  const SoftphoneContactInFlightRefusal({required this.campaignId, required this.contactId, required this.message});

  factory SoftphoneContactInFlightRefusal.fromJson(Map<String, Object?> j) => SoftphoneContactInFlightRefusal(
    campaignId: j.str('campaign_id'),
    contactId: j.str('contact_id'),
    message: j.strOrNull('message') ?? '',
  );

  final String campaignId;
  final String contactId;
  final String message;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneContactInFlightRefusal &&
      other.campaignId == campaignId &&
      other.contactId == contactId &&
      other.message == message;

  @override
  int get hashCode => Object.hash(campaignId, contactId, message);
}

/// 409 `session_on_campaign` from the open: the agent is live on a campaign,
/// maybe in a sibling account ([accountId]). The remedy is the switch on that
/// session, sent with [accountId].
///
/// Contract: `AgencySoftphoneSessionOnCampaignRefusal`.
@immutable
final class SoftphoneSessionOnCampaignRefusal {
  SoftphoneSessionOnCampaignRefusal({
    required this.sessionId,
    required this.campaignId,
    required this.campaignName,
    required this.state,
    String? stateRaw,
    required this.accountId,
    this.accountName,
    required this.message,
  }) : stateRaw = stateRaw ?? state.wire;

  factory SoftphoneSessionOnCampaignRefusal.fromJson(Map<String, Object?> j) {
    final state = j.str('state');
    return SoftphoneSessionOnCampaignRefusal(
      sessionId: j.str('session_id'),
      campaignId: j.str('campaign_id'),
      campaignName: j.str('campaign_name'),
      state: AgentState.fromWire(state),
      stateRaw: state,
      accountId: j.str('account_id'),
      accountName: j.strOrNull('account_name'),
      message: j.strOrNull('message') ?? '',
    );
  }

  final String sessionId;
  final String campaignId;
  final String campaignName;

  /// The agent's state there.
  final AgentState state;
  final String stateRaw;
  final String accountId;

  /// Best effort; null when the server could not read it.
  final String? accountName;
  final String message;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneSessionOnCampaignRefusal &&
      other.sessionId == sessionId &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.stateRaw == stateRaw &&
      other.accountId == accountId &&
      other.accountName == accountName &&
      other.message == message;

  @override
  int get hashCode => Object.hash(sessionId, campaignId, campaignName, stateRaw, accountId, accountName, message);
}

/// 409 `outcome_pending` / `manual_call_live`: the session's unsettled call,
/// so a client shows it rather than an error.
///
/// Contract: `AgencySoftphoneCallPendingRefusal`.
@immutable
final class SoftphoneCallPendingRefusal {
  const SoftphoneCallPendingRefusal({required this.code, required this.call, required this.message});

  /// [SoftphoneErrorCode.outcomePending] or [SoftphoneErrorCode.manualCallLive].
  final SoftphoneErrorCode code;
  final ManualCall call;
  final String message;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneCallPendingRefusal && other.code == code && other.call == call && other.message == message;

  @override
  int get hashCode => Object.hash(code, call, message);
}

/// Every soft-phone refusal code. Key copy off this; show the body's `message`
/// for [unknown].
///
/// Contract: `AgencySoftphoneErrorCode` / `AGENCY_SOFTPHONE_ERROR_CODES` (`errors.ts`).
enum SoftphoneErrorCode implements WireEnum {
  /// 403: the flag is off for the account. Starting work is refused; finishing is not.
  softphoneDisabled('softphone_disabled'),
  invalidNumber('invalid_number'),

  /// `allowed_codes` lists the caller IDs allowed.
  callerIdNotAllowed('caller_id_not_allowed'),
  campaignNotTaggable('campaign_not_taggable'),

  /// See [SoftphoneDncListedRefusal].
  dncListed('dnc_listed'),
  dncUnavailable('dnc_unavailable'),

  /// See [SoftphoneOutsideHoursRefusal].
  outsideCallingHours('outside_calling_hours'),

  /// `details` names the note (`overrides.dnc_note` / `overrides.hours_note`).
  overrideNoteInvalid('override_note_invalid'),

  /// See [SoftphoneContactInFlightRefusal].
  contactInFlight('contact_in_flight'),

  /// See [SoftphoneSessionOnCampaignRefusal].
  sessionOnCampaign('session_on_campaign'),

  /// The agent's soft-phone session is in another account (`SessionOnSoftphoneRefusal`).
  sessionOnSoftphone('session_on_softphone'),
  sessionNotFound('session_not_found'),
  wrongSessionKind('wrong_session_kind'),
  notOnSoftphone('not_on_softphone'),

  /// See [SoftphoneCallPendingRefusal].
  manualCallLive('manual_call_live'),

  /// See [SoftphoneCallPendingRefusal].
  outcomePending('outcome_pending'),
  concurrencyLimit('concurrency_limit'),
  stationUnavailable('station_unavailable'),

  /// Nothing was dialled or changed; try again.
  dialFailed('dial_failed'),
  callNotFound('call_not_found'),
  callSettled('call_settled'),

  /// `allowed_codes` lists the catalog's codes when the code was unknown.
  dispositionInvalid('disposition_invalid'),

  /// `details`: one entry per offending field.
  fieldsInvalid('fields_invalid'),
  settingsInvalid('settings_invalid'),

  /// 409 (contact assignment): the tagged campaign is `strict` and the
  /// number's contact belongs to another agent. Nothing was dialled.
  contactAssignedElsewhere('contact_assigned_elsewhere'),
  unknown('');

  const SoftphoneErrorCode(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static SoftphoneErrorCode fromWire(String? raw) => _byWire[raw] ?? unknown;
}
