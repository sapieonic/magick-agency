/// Error bodies: the generic `{error, code?, message, ...}` shape, the agency
/// action codes, the two structured join refusals, the soft phone's refusals
/// and the inbound ones (typed accessors over the same body).
///
/// Contract: `packages/contracts/src/errors.ts`, `AgencyActionErrorResponse`
/// and `AgencySessionCampaignConflict` (`agency/`),
/// `AgencySoftphoneErrorResponse` with its narrowed refusals (`agency/softphone.ts`),
/// `AgencyInboundErrorResponse` (`api/agency/inbound.ts`) and Mode B's
/// `AgencyAwayRingRefusal` (`agency/push-devices.ts`).
library;

import 'package:meta/meta.dart';

import 'assignment.dart';
import 'enums.dart';
import 'equality.dart';
import 'inbound.dart';
import 'json.dart';
import 'push_devices.dart';
import 'softphone.dart';

/// Why an agency route refused the agent. Key copy off this; show the body's
/// `message` for [unknown].
///
/// Contract: `AgencyActionErrorCode` / `AGENCY_ACTION_ERROR_CODES`, plus the
/// one soft-phone refusal the app's join can hit: `session_on_softphone`
/// (`AgencySoftphoneErrorCode`).
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

  /// 403 on join: not staffed on that campaign.
  notStaffed('not_staffed'),

  /// 409 on the `device_away` break: the agent's state kept changing under
  /// the request. Nothing changed; ask again (the app retries for 10 s, then
  /// closes its station socket so the server takes the agent out of the pool).
  stateChanging('state_changing'),

  // ── Wrap-up redial (`POST /sessions/:id/redial`, all 409). Nothing changed:
  // the agent stays in wrap-up and can still save the outcome.

  /// Redial is off on this campaign, or this wrap-up does not offer it.
  redialNotAllowed('redial_not_allowed'),

  /// The call's redials are used up.
  redialLimitReached('redial_limit_reached'),

  /// An outcome is already saved for this call.
  dispositionAlreadySubmitted('disposition_already_submitted'),

  /// The number is on a do-not-call list.
  redialBlockedDnc('redial_blocked_dnc'),

  /// The contact's calling window is closed.
  redialBlockedCallingHours('redial_blocked_calling_hours'),

  /// Any other reason the dial could not be placed; `message` says which.
  redialBlocked('redial_blocked'),

  /// 409 (OS3) on join, the soft-phone open or a token mint: another device holds this
  /// session's station and the request did not take it over. Nothing changed. See
  /// [StationOnOtherDeviceRefusal].
  stationOnOtherDevice('station_on_other_device'),

  /// 409 (OS1) on join or the soft-phone open: the agent is live in another organisation (tenant).
  /// Nothing here can end it. `message` names the workspace.
  sessionInOtherTenant('session_in_other_tenant'),

  /// 409 (Mode B) on a supervisor's force-available: the agent is on `away_ring`, away from the
  /// app with their phone ringing for inbound callers. Nothing changed. Never sent to the app
  /// (a supervisor's route), listed because the contract's list is the whole union.
  agentAwayRing('agent_away_ring'),
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
    List<FieldIssue>? details,
    Map<String, Object?> raw = const <String, Object?>{},
  }) : code = AgencyErrorCode.fromWire(codeRaw),
       softphoneCode = SoftphoneErrorCode.fromWire(codeRaw),
       agentRetryCode = AgentRetryErrorCode.fromWire(codeRaw),
       inboundCode = InboundErrorCode.fromWire(codeRaw),
       awayRingCode = AwayRingRefusalCode.fromWire(codeRaw),
       allowedCodes = allowedCodes == null ? null : List.unmodifiable(allowedCodes),
       details = details == null ? null : List.unmodifiable(details),
       raw = frozenMap(raw);

  factory ErrorBody.fromJson(Map<String, Object?> j) {
    String text(String k) => j[k] is String ? j[k]! as String : '';
    final allowed = j['allowed_codes'];
    // `details` is a list of `{path, message}` on the soft phone's refusals; a
    // generic validation 400 sends an object there, which is not read.
    final details = j['details'];
    return ErrorBody(
      error: text('error'),
      codeRaw: j['code'] is String ? j['code']! as String : null,
      message: text('message'),
      allowedCodes: allowed is List<Object?> ? allowed.whereType<String>().toList() : null,
      details: details is List<Object?>
          ? [
              for (final d in details)
                if (d is Map<String, Object?> && d['path'] is String)
                  FieldIssue(
                    path: d['path']! as String,
                    message: d['message'] is String ? d['message']! as String : '',
                  ),
            ]
          : null,
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

  /// [codeRaw] as a soft-phone refusal code; [SoftphoneErrorCode.unknown]
  /// when absent or not a soft-phone code. Read this on the soft phone's
  /// routes (and the SP7 switch), [code] on the station's.
  final SoftphoneErrorCode softphoneCode;

  /// [codeRaw] as a refusal of the agent's own-contact routes (My contacts,
  /// retry, the per-contact call); [AgentRetryErrorCode.unknown] when absent
  /// or not one of those codes. Read this on those routes only.
  final AgentRetryErrorCode agentRetryCode;

  /// [codeRaw] as an inbound refusal code; [InboundErrorCode.unknown] when
  /// absent or not an inbound code. Read this on the inbound call and Missed
  /// routes, and on the campaign session routes for `inbound_call_live`.
  final InboundErrorCode inboundCode;

  /// [codeRaw] as a refusal of `POST /sessions/:id/break {reason:'away_ring'}`
  /// (Mode B); [AwayRingRefusalCode.unknown] when absent or not one. On any of
  /// them the app falls back to `device_away`.
  final AwayRingRefusalCode awayRingCode;

  /// The values that ARE accepted; read against [code], never generically.
  final List<String>? allowedCodes;

  /// `fields_invalid` / `override_note_invalid` / `settings_invalid`: one entry
  /// per offending path. Null when the body had no such list.
  final List<FieldIssue>? details;

  /// The whole body, for code-specific fields.
  final Map<String, Object?> raw;

  /// The refusal of an own-contact route, with its `details` read, when
  /// [codeRaw] is one of [AgentRetryErrorCode]. Null otherwise.
  AgentRetryRefusal? get agentRetryRefusal =>
      agentRetryCode == AgentRetryErrorCode.unknown ? null : AgentRetryRefusal.fromBody(raw);

  /// The structured 409 for `session_on_other_campaign`, when this is one
  /// and its fields read.
  SessionCampaignConflict? get campaignConflict =>
      _readAgency(AgencyErrorCode.sessionOnOtherCampaign, SessionCampaignConflict.fromJson);

  /// The structured 409 for `session_on_softphone`, when this is one and its
  /// fields read.
  SessionOnSoftphoneRefusal? get softphoneConflict =>
      _readAgency(AgencyErrorCode.sessionOnSoftphone, SessionOnSoftphoneRefusal.fromJson);

  /// The 409 `station_on_other_device` refusal (OS3), when this is one that reads.
  StationOnOtherDeviceRefusal? get stationOnOtherDevice =>
      _readAgency(AgencyErrorCode.stationOnOtherDevice, StationOnOtherDeviceRefusal.fromJson);

  T? _readAgency<T>(AgencyErrorCode want, T Function(Map<String, Object?>) decode) =>
      code == want ? _decode(decode) : null;

  T? _read<T>(SoftphoneErrorCode want, T Function(Map<String, Object?>) decode) =>
      softphoneCode == want ? _decode(decode) : null;

  T? _decode<T>(T Function(Map<String, Object?>) decode) {
    try {
      return decode(raw);
    } on FormatException {
      return null;
    }
  }

  /// `dnc_listed` (SP1), when this is one and its entry reads.
  SoftphoneDncListedRefusal? get dncListed => _read(SoftphoneErrorCode.dncListed, SoftphoneDncListedRefusal.fromJson);

  /// `outside_calling_hours` (SP2), when this is one and its window reads.
  SoftphoneOutsideHoursRefusal? get outsideHours =>
      _read(SoftphoneErrorCode.outsideCallingHours, SoftphoneOutsideHoursRefusal.fromJson);

  /// `contact_in_flight`, when this is one and its fields read.
  SoftphoneContactInFlightRefusal? get contactInFlight =>
      _read(SoftphoneErrorCode.contactInFlight, SoftphoneContactInFlightRefusal.fromJson);

  /// `session_on_campaign` from the soft-phone open, when this is one and its fields read.
  SoftphoneSessionOnCampaignRefusal? get sessionOnCampaign =>
      _read(SoftphoneErrorCode.sessionOnCampaign, SoftphoneSessionOnCampaignRefusal.fromJson);

  /// `outcome_pending` or `manual_call_live` with the session's unsettled
  /// call, when this is one and the call reads. A body without a readable
  /// call is null here, and the code alone still says what happened.
  SoftphoneCallPendingRefusal? get callPending {
    if (softphoneCode != SoftphoneErrorCode.outcomePending && softphoneCode != SoftphoneErrorCode.manualCallLive) {
      return null;
    }
    final call = ManualCall.tryFromJson(raw['call']);
    return call == null ? null : SoftphoneCallPendingRefusal(code: softphoneCode, call: call, message: message);
  }

  /// `inbound_disposition_invalid`, with the rule that refused and (for an
  /// unknown code) the codes the call's catalog takes. Null for any other code.
  InboundDispositionRefusal? get inboundDispositionInvalid {
    if (inboundCode != InboundErrorCode.inboundDispositionInvalid) return null;
    final rule = raw['reason'] is String ? raw['reason']! as String : null;
    final callId = raw['inbound_call_id'];
    return InboundDispositionRefusal(
      rule: InboundDispositionRule.fromWire(rule),
      ruleRaw: rule,
      allowedCodes: allowedCodes,
      inboundCallId: callId is String ? callId : null,
      message: message,
    );
  }

  /// `inbound_call_live`, when this is one and it names the call. A body
  /// without `inbound_call_id` is null here; [inboundCode] still says what happened.
  InboundCallLiveRefusal? get inboundCallLive {
    if (inboundCode != InboundErrorCode.inboundCallLive) return null;
    final callId = raw['inbound_call_id'];
    return callId is String ? InboundCallLiveRefusal(inboundCallId: callId, message: message) : null;
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
    this.sessionId,
    this.accountId,
    this.accountName,
  }) : stateRaw = stateRaw ?? state.wire;

  factory SessionCampaignConflict.fromJson(Map<String, Object?> j) {
    final state = j.str('state');
    return SessionCampaignConflict(
      campaignId: j.str('campaign_id'),
      campaignName: j.str('campaign_name'),
      state: AgentState.fromWire(state),
      stateRaw: state,
      message: j.strOrNull('message'),
      sessionId: j.strOrNull('session_id'),
      accountId: j.strOrNull('account_id'),
      accountName: j.strOrNull('account_name'),
    );
  }

  /// The campaign they are still on, not the one they asked for.
  final String campaignId;
  final String campaignName;

  /// Their state there: `on_call` means finish the call first.
  final AgentState state;
  final String stateRaw;
  final String? message;

  /// The live session to leave (`POST /sessions/:id/leave`). Null only from a
  /// server older than the field.
  final String? sessionId;

  /// The account that session is in, often a sibling of the current one:
  /// `leave` is scoped to the session's account, so send this as the account
  /// scope. Null only from a server older than the field.
  final String? accountId;

  /// That account's name, for copy. Best effort: null when the server could
  /// not read it (or is older than the field).
  final String? accountName;

  /// Whether this body names everything needed to leave that session.
  bool get canLeave => sessionId != null && accountId != null;

  @override
  bool operator ==(Object other) =>
      other is SessionCampaignConflict &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.stateRaw == stateRaw &&
      other.message == message &&
      other.sessionId == sessionId &&
      other.accountId == accountId &&
      other.accountName == accountName;

  @override
  int get hashCode => Object.hash(campaignId, campaignName, stateRaw, message, sessionId, accountId, accountName);
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

/// 409 `station_on_other_device` (OS3): another device holds this session's station, and the
/// request (the join, the soft-phone open or a token mint) did not take it over. Nothing changed.
/// The remedy is the same request with `take_over: true`, on the agent's own "Use this phone".
///
/// Contract: `AgencyStationOnOtherDeviceRefusal` (`agency/station-device.ts`).
@immutable
final class StationOnOtherDeviceRefusal {
  const StationOnOtherDeviceRefusal({required this.sessionId, required this.clientKind, this.message});

  factory StationOnOtherDeviceRefusal.fromJson(Map<String, Object?> j) => StationOnOtherDeviceRefusal(
    sessionId: j.str('session_id'),
    clientKind: ClientKind.fromWire(j.strOrNull('client_kind')),
    message: j.strOrNull('message'),
  );

  final String sessionId;

  /// The app that last attached the station: `web` reads "in a browser", `mobile` "on another
  /// phone". Display only.
  final ClientKind clientKind;
  final String? message;

  @override
  bool operator ==(Object other) =>
      other is StationOnOtherDeviceRefusal &&
      other.sessionId == sessionId &&
      other.clientKind == clientKind &&
      other.message == message;

  @override
  int get hashCode => Object.hash(sessionId, clientKind, message);
}
