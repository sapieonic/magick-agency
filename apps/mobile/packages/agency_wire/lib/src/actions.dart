/// The agent's attempt actions: hang up, disposition, notes, mark DNC, and
/// the wrap-up redial.
///
/// Contract: `packages/contracts/src/agency/actions.ts`. Routes are
/// `POST /proxy/agency/attempts/:id/{hangup,disposition,notes,dnc}` and
/// `POST /proxy/agency/sessions/:id/redial`. The server attributes every
/// action to the signed-in user, so no request here carries `agent_user_id`
/// or `on_behalf`.
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'json.dart';

/// `POST .../hangup` (no body). This answers "was the hangup accepted"; the
/// station's `released` frame is the authority that the call is over.
///
/// Contract: `AgencyHangupResponse`.
@immutable
final class HangupResponse {
  HangupResponse({
    required this.campaignId,
    required this.attemptId,
    required this.state,
    String? stateRaw,
    this.outcome,
    String? outcomeRaw,
  }) : stateRaw = stateRaw ?? state.wire,
       outcomeRaw = outcomeRaw ?? outcome?.wire;

  factory HangupResponse.fromJson(Map<String, Object?> j) {
    final state = j.str('state');
    final outcome = j.strOrNull('outcome');
    return HangupResponse(
      campaignId: j.str('campaign_id'),
      attemptId: j.str('attempt_id'),
      state: AttemptState.fromWire(state),
      stateRaw: state,
      outcome: outcome == null ? null : AttemptOutcome.fromWire(outcome),
      outcomeRaw: outcome,
    );
  }

  final String campaignId;
  final String attemptId;

  /// As read right after the hangup was issued; may still say `bridged`.
  final AttemptState state;
  final String stateRaw;
  final AttemptOutcome? outcome;
  final String? outcomeRaw;

  @override
  bool operator ==(Object other) =>
      other is HangupResponse &&
      other.campaignId == campaignId &&
      other.attemptId == attemptId &&
      other.stateRaw == stateRaw &&
      other.outcomeRaw == outcomeRaw;

  @override
  int get hashCode => Object.hash(campaignId, attemptId, stateRaw, outcomeRaw);
}

/// `POST .../disposition`. Re-submitting the same code is an idempotent 200
/// (notes and callback last-write-wins); a different code is 409
/// `already_dispositioned`.
///
/// Contract: `AgencyDispositionRequest`.
@immutable
final class DispositionRequest {
  const DispositionRequest({required this.dispositionCode, this.notes, this.callbackAt});

  final String dispositionCode;

  /// Required when the catalog entry sets `requires_note`.
  final String? notes;

  /// Required when the catalog entry sets `requires_datetime`.
  final DateTime? callbackAt;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{'disposition_code': dispositionCode};
    putIfSet(json, 'notes', notes);
    putIfSet(json, 'callback_at', callbackAt == null ? null : isoUtc(callbackAt!));
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is DispositionRequest &&
      other.dispositionCode == dispositionCode &&
      other.notes == notes &&
      other.callbackAt == callbackAt;

  @override
  int get hashCode => Object.hash(dispositionCode, notes, callbackAt);
}

/// Contract: `AgencyDispositionResponse`.
@immutable
final class DispositionResponse {
  DispositionResponse({
    required this.campaignId,
    required this.attemptId,
    required this.contactId,
    required this.dispositionCode,
    required this.contactState,
    String? contactStateRaw,
    this.nextAttemptAt,
    this.callbackRequestedAt,
    required this.agentState,
    String? agentStateRaw,
  }) : contactStateRaw = contactStateRaw ?? contactState.wire,
       agentStateRaw = agentStateRaw ?? agentState.wire;

  factory DispositionResponse.fromJson(Map<String, Object?> j) {
    final contact = j.str('contact_state');
    final agent = j.str('agent_state');
    return DispositionResponse(
      campaignId: j.str('campaign_id'),
      attemptId: j.str('attempt_id'),
      contactId: j.str('contact_id'),
      dispositionCode: j.str('disposition_code'),
      contactState: ContactState.fromWire(contact),
      contactStateRaw: contact,
      nextAttemptAt: j.timeOrNull('next_attempt_at'),
      callbackRequestedAt: j.timeOrNull('callback_requested_at'),
      agentState: AgentState.fromWire(agent),
      agentStateRaw: agent,
    );
  }

  final String campaignId;
  final String attemptId;
  final String contactId;
  final String dispositionCode;

  /// `completed`, or `pending` when a callback was booked. Do not infer "this
  /// contact is finished" from it.
  final ContactState contactState;
  final String contactStateRaw;

  /// When the dialer WILL call back (window-adjusted). Say this one.
  final DateTime? nextAttemptAt;

  /// What the agent asked for, echoed.
  final DateTime? callbackRequestedAt;

  /// ADVISORY snapshot; races the station by design. Never assign state from it.
  final AgentState agentState;
  final String agentStateRaw;

  @override
  bool operator ==(Object other) =>
      other is DispositionResponse &&
      other.campaignId == campaignId &&
      other.attemptId == attemptId &&
      other.contactId == contactId &&
      other.dispositionCode == dispositionCode &&
      other.contactStateRaw == contactStateRaw &&
      other.nextAttemptAt == nextAttemptAt &&
      other.callbackRequestedAt == callbackRequestedAt &&
      other.agentStateRaw == agentStateRaw;

  @override
  int get hashCode => Object.hash(
    campaignId,
    attemptId,
    contactId,
    dispositionCode,
    contactStateRaw,
    nextAttemptAt,
    callbackRequestedAt,
    agentStateRaw,
  );
}

/// `POST .../notes`: save notes without dispositioning (autosave). Replaces
/// the notes wholesale; empty clears them.
///
/// Contract: `AgencyNotesRequest`.
@immutable
final class NotesRequest {
  const NotesRequest(this.notes);

  final String notes;

  Map<String, Object?> toJson() => <String, Object?>{'notes': notes};

  @override
  bool operator ==(Object other) => other is NotesRequest && other.notes == notes;

  @override
  int get hashCode => notes.hashCode;
}

/// Contract: `AgencyNotesResponse`.
@immutable
final class NotesResponse {
  const NotesResponse({required this.attemptId, required this.notes, required this.updatedAt});

  factory NotesResponse.fromJson(Map<String, Object?> j) =>
      NotesResponse(attemptId: j.str('attempt_id'), notes: j.str('notes'), updatedAt: j.time('updated_at'));

  final String attemptId;

  /// What the server stored; differs from what was sent when another write won.
  final String notes;
  final DateTime updatedAt;

  @override
  bool operator ==(Object other) =>
      other is NotesResponse && other.attemptId == attemptId && other.notes == notes && other.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(attemptId, notes, updatedAt);
}

/// `POST .../dnc`: mark the contact on the line as Do Not Call **for this
/// campaign**. The scope is always sent explicitly as `campaign`: the agent
/// role cannot escalate to `tenant`, and an explicit scope keeps the request
/// self-describing in logs.
///
/// Contract: `AgencyDncRequest`.
@immutable
final class DncRequest {
  const DncRequest({this.reason, this.dispositionCode});

  /// Free text, stored on the DNC entry.
  final String? reason;

  /// Also disposition the attempt in the same call (a catalog code).
  final String? dispositionCode;

  DncScope get scope => DncScope.campaign;

  Map<String, Object?> toJson() {
    final json = <String, Object?>{'scope': scope.wire};
    putIfSet(json, 'reason', reason);
    putIfSet(json, 'disposition_code', dispositionCode);
    return json;
  }

  @override
  bool operator ==(Object other) =>
      other is DncRequest && other.reason == reason && other.dispositionCode == dispositionCode;

  @override
  int get hashCode => Object.hash(reason, dispositionCode);
}

/// Contract: `AgencyDncResponse`.
@immutable
final class DncResponse {
  DncResponse({
    required this.campaignId,
    required this.attemptId,
    required this.contactId,
    required this.phoneE164,
    required this.contactState,
    String? contactStateRaw,
    required this.dncRecorded,
  }) : contactStateRaw = contactStateRaw ?? contactState.wire;

  factory DncResponse.fromJson(Map<String, Object?> j) {
    final contact = j.str('contact_state');
    return DncResponse(
      campaignId: j.str('campaign_id'),
      attemptId: j.str('attempt_id'),
      contactId: j.str('contact_id'),
      phoneE164: j.str('phone_e164'),
      contactState: ContactState.fromWire(contact),
      contactStateRaw: contact,
      dncRecorded: j.boolean('dnc_recorded'),
    );
  }

  final String campaignId;
  final String attemptId;
  final String contactId;
  final String phoneE164;

  /// Always `suppressed` on success: this campaign will not dial them again.
  final ContactState contactState;
  final String contactStateRaw;

  /// False when the DNC list write is still in flight: do not claim it landed.
  final bool dncRecorded;

  @override
  bool operator ==(Object other) =>
      other is DncResponse &&
      other.campaignId == campaignId &&
      other.attemptId == attemptId &&
      other.contactId == contactId &&
      other.phoneE164 == phoneE164 &&
      other.contactStateRaw == contactStateRaw &&
      other.dncRecorded == dncRecorded;

  @override
  int get hashCode => Object.hash(campaignId, attemptId, contactId, phoneE164, contactStateRaw, dncRecorded);
}

/// `POST /proxy/agency/sessions/:id/redial`: redial the customer of the
/// wrap-up on screen, before its outcome is saved.
///
/// Contract: `AgencyRedialRequest` (minus the server-injected actor).
@immutable
final class RedialRequest {
  const RedialRequest({required this.attemptId});

  /// The attempt whose wrap-up the agent is looking at, so a tap on a stale
  /// screen never redials a different call than the one shown.
  final String attemptId;

  Map<String, Object?> toJson() => <String, Object?>{'attempt_id': attemptId};

  @override
  bool operator ==(Object other) => other is RedialRequest && other.attemptId == attemptId;

  @override
  int get hashCode => attemptId.hashCode;
}

/// The redial was placed. Its progress arrives on the station socket like any
/// call (`reserved` with `attempt.redial`, `bridged`, `released`, a wrap-up on
/// the NEW attempt); this only says it started.
///
/// Contract: `AgencyRedialResponse`.
@immutable
final class RedialResponse {
  const RedialResponse({
    required this.sessionId,
    required this.attemptId,
    required this.redialOfAttemptId,
    required this.redialNumber,
    required this.redialRemaining,
  });

  factory RedialResponse.fromJson(Map<String, Object?> j) => RedialResponse(
    sessionId: j.str('session_id'),
    attemptId: j.str('attempt_id'),
    redialOfAttemptId: j.str('redial_of_attempt_id'),
    redialNumber: j.integer('redial_number'),
    redialRemaining: j.integer('redial_remaining'),
  );

  final String sessionId;

  /// The new attempt (the redial).
  final String attemptId;

  /// The attempt it redials, now closed with the system code `redialed`.
  final String redialOfAttemptId;

  /// 1 for the first redial of a call, 2 for the second.
  final int redialNumber;

  /// Redials left after this one.
  final int redialRemaining;

  @override
  bool operator ==(Object other) =>
      other is RedialResponse &&
      other.sessionId == sessionId &&
      other.attemptId == attemptId &&
      other.redialOfAttemptId == redialOfAttemptId &&
      other.redialNumber == redialNumber &&
      other.redialRemaining == redialRemaining;

  @override
  int get hashCode => Object.hash(sessionId, attemptId, redialOfAttemptId, redialNumber, redialRemaining);
}
