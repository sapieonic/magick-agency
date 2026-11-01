/// Error bodies: the generic `{error, code?, message, ...}` shape, the agency
/// action codes, and the two structured join refusals.
///
/// Contract: `packages/contracts/src/errors.ts`, `AgencyActionErrorResponse`
/// and `AgencySessionCampaignConflict` (`agency/`), and
/// `AgencySoftphoneSessionOnSoftphoneRefusal` (`agency/softphone.ts`).
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'equality.dart';
import 'json.dart';

/// Why an agency route refused the agent. Key copy off this; show the body's
/// `message` for [unknown].
///
/// Contract: `AgencyActionErrorCode` / `AGENCY_ACTION_ERROR_CODES`, plus the
/// join refusals the app can hit: `session_on_softphone`
/// (`AgencySoftphoneErrorCode`) and `not_staffed` (server addition, 403).
enum AgencyErrorCode implements WireEnum {
  missingActor('missing_actor'),
  notYourAttempt('not_your_attempt'),

  /// `allowed_codes` lists the campaign's disposition codes.
  unknownDispositionCode('unknown_disposition_code'),

  /// `allowed_codes` lists the two DNC scopes.
  invalidDncScope('invalid_dnc_scope'),
  noteRequired('note_required'),
  datetimeRequired('datetime_required'),
  invalidCallbackAt('invalid_callback_at'),
  attemptNotDispositionable('attempt_not_dispositionable'),
  alreadyDispositioned('already_dispositioned'),

  /// `allowed_codes` lists the campaign's break reasons.
  unknownBreakReason('unknown_break_reason'),
  breakAlreadyApplied('break_already_applied'),

  /// The session has left: re-bootstrap rather than retry.
  sessionEnded('session_ended'),

  /// 409 on join: live on another campaign. See [SessionCampaignConflict].
  sessionOnOtherCampaign('session_on_other_campaign'),
  agentOnLiveCall('agent_on_live_call'),
  noStation('no_station'),
  attemptNotLive('attempt_not_live'),
  campaignNotRunning('campaign_not_running'),
  featureDisabled('feature_disabled'),

  /// 409 on join: the live session is a soft-phone one. See [SessionOnSoftphoneRefusal].
  sessionOnSoftphone('session_on_softphone'),

  /// 403 on join: not staffed on that campaign (server addition).
  notStaffed('not_staffed'),
  unknown('');

  const AgencyErrorCode(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static AgencyErrorCode fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Why `POST /auth/session` refused to sign someone in (403).
///
/// Contract: `SessionRefusalCode` (`api/platform/auth.ts`).
enum SessionRefusalCode implements WireEnum {
  emailUnverified('email_unverified'),

  /// No user, stub or invite for this identity: there is no self sign-up.
  noMembership('no_membership'),
  unknown('');

  const SessionRefusalCode(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static SessionRefusalCode fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// The body of a 4xx (and a masked 5xx): `{error, code?, message, ...}`.
///
/// Contract: `AgencyActionErrorResponse`, and the platform's error convention
/// it follows. [ErrorBody.fromJson] **never throws**: an error body is read on
/// the failure path, where a second failure would hide the first.
@immutable
final class ErrorBody {
  ErrorBody({
    required this.error,
    this.codeRaw,
    required this.message,
    List<String>? allowedCodes,
    Map<String, Object?> raw = const <String, Object?>{},
  }) : code = AgencyErrorCode.fromWire(codeRaw),
       allowedCodes = allowedCodes == null ? null : List.unmodifiable(allowedCodes),
       raw = frozenMap(raw);

  factory ErrorBody.fromJson(Map<String, Object?> j) {
    String text(String k) => j[k] is String ? j[k]! as String : '';
    final allowed = j['allowed_codes'];
    return ErrorBody(
      error: text('error'),
      codeRaw: j['code'] is String ? j['code']! as String : null,
      message: text('message'),
      allowedCodes: allowed is List<Object?> ? allowed.whereType<String>().toList() : null,
      raw: j,
    );
  }

  /// Short title, e.g. `Conflict`. Empty when the body had none.
  final String error;

  /// [codeRaw] as an agency code; [AgencyErrorCode.unknown] when absent or new.
  final AgencyErrorCode code;
  final String? codeRaw;

  /// A sentence for people. Empty when the body had none.
  final String message;

  /// The values that ARE accepted; read against [code], never generically.
  final List<String>? allowedCodes;

  /// The whole body, for code-specific fields.
  final Map<String, Object?> raw;

  /// The structured 409 for `session_on_other_campaign`, when this is one
  /// and its fields read.
  SessionCampaignConflict? get campaignConflict {
    if (code != AgencyErrorCode.sessionOnOtherCampaign) return null;
    try {
      return SessionCampaignConflict.fromJson(raw);
    } on FormatException {
      return null;
    }
  }

  /// The structured 409 for `session_on_softphone`, when this is one and its
  /// fields read.
  SessionOnSoftphoneRefusal? get softphoneConflict {
    if (code != AgencyErrorCode.sessionOnSoftphone) return null;
    try {
      return SessionOnSoftphoneRefusal.fromJson(raw);
    } on FormatException {
      return null;
    }
  }

  @override
  bool operator ==(Object other) => other is ErrorBody && jsonEquals(other.raw, raw) && other.error == error;

  @override
  int get hashCode => jsonHash(raw);

  @override
  String toString() => 'ErrorBody($codeRaw, $message)';
}

/// 409 from `POST /proxy/agency/sessions`: the agent is still live on a
/// **different** campaign. Render it as an answer: name that campaign and
/// offer to leave it.
///
/// Contract: `AgencySessionCampaignConflict` (the console's
/// `AgencySessionConflict` reads `message` as optional).
@immutable
final class SessionCampaignConflict {
  SessionCampaignConflict({
    required this.campaignId,
    required this.campaignName,
    required this.state,
    String? stateRaw,
    this.message,
  }) : stateRaw = stateRaw ?? state.wire;

  factory SessionCampaignConflict.fromJson(Map<String, Object?> j) {
    final state = j.str('state');
    return SessionCampaignConflict(
      campaignId: j.str('campaign_id'),
      campaignName: j.str('campaign_name'),
      state: AgentState.fromWire(state),
      stateRaw: state,
      message: j.strOrNull('message'),
    );
  }

  /// The campaign they are still on, not the one they asked for.
  final String campaignId;
  final String campaignName;

  /// Their state there: `on_call` means finish the call first.
  final AgentState state;
  final String stateRaw;
  final String? message;

  @override
  bool operator ==(Object other) =>
      other is SessionCampaignConflict &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.stateRaw == stateRaw &&
      other.message == message;

  @override
  int get hashCode => Object.hash(campaignId, campaignName, stateRaw, message);
}

/// 409 `session_on_softphone`: the agent's live session is a soft-phone one.
/// The remedy is leaving it, in its own account.
///
/// Contract: `AgencySoftphoneSessionOnSoftphoneRefusal`.
@immutable
final class SessionOnSoftphoneRefusal {
  const SessionOnSoftphoneRefusal({required this.sessionId, required this.accountId, this.accountName, this.message});

  factory SessionOnSoftphoneRefusal.fromJson(Map<String, Object?> j) => SessionOnSoftphoneRefusal(
    sessionId: j.str('session_id'),
    accountId: j.str('account_id'),
    accountName: j.strOrNull('account_name'),
    message: j.strOrNull('message'),
  );

  final String sessionId;
  final String accountId;

  /// Best effort; null when the server could not read it.
  final String? accountName;
  final String? message;

  @override
  bool operator ==(Object other) =>
      other is SessionOnSoftphoneRefusal &&
      other.sessionId == sessionId &&
      other.accountId == accountId &&
      other.accountName == accountName &&
      other.message == message;

  @override
  int get hashCode => Object.hash(sessionId, accountId, accountName, message);
}
