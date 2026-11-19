/// Floor assist (the Live floor's Phase 3, decisions LF4, LF5, LF13–LF16): the
/// agent's **Need help** on their own live session, and how it was answered or
/// ended. The station frames themselves (`supervisor_message`, `help_answered`,
/// `help_cleared`) are in `station.dart`, beside the other server frames.
///
/// Contract: `packages/contracts/src/agency/floor-assist.ts`, and
/// `AgencyFloorAssistErrorCode` in `errors.ts`.
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'json.dart';

/// How a supervisor answered the agent's Need help: they are listening to the
/// call, or they sent a message (which arrives first, as its own frame).
///
/// Contract: `AgencyHelpAnswerHow` / `AGENCY_HELP_ANSWER_HOWS`.
enum HelpAnswerHow implements WireEnum {
  listen('listen'),
  message('message'),
  unknown('');

  const HelpAnswerHow(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static HelpAnswerHow fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Why a Need help request ended.
///
/// Contract: `AgencyHelpClearedReason` / `AGENCY_HELP_CLEARED_REASONS`.
enum HelpClearedReason implements WireEnum {
  /// The agent cancelled it.
  cancelled('cancelled'),

  /// Nobody answered in 15 minutes (`AGENCY_HELP_EXPIRY_MS`).
  expired('expired'),

  /// A supervisor answered it (`help_answered` came first and says who and how).
  answered('answered'),

  /// The session ended (the agent left).
  sessionEnded('session_ended'),
  unknown('');

  const HelpClearedReason(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static HelpClearedReason fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Why a Need help raise or cancel (or a supervisor's message) was refused.
/// The app meets only [floorAssistDisabled] and [helpNotOnCall]; the other two
/// are the supervisor's message route's, listed because the contract's list is
/// the whole union.
///
/// Contract: `AgencyFloorAssistErrorCode` / `AGENCY_FLOOR_ASSIST_ERROR_CODES`.
enum FloorAssistErrorCode implements WireEnum {
  /// 403: `agency_floor_assist_enabled` is off for the account.
  floorAssistDisabled('floor_assist_disabled'),

  /// 409: Need help is raised only on a call or in wrap-up.
  helpNotOnCall('help_not_on_call'),

  /// 409 (a supervisor's message): the agent has no station that can show it.
  agentNotLive('agent_not_live'),

  /// 400 (a supervisor's message): empty or too long.
  messageInvalid('message_invalid'),
  unknown('');

  const FloorAssistErrorCode(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static FloorAssistErrorCode fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// An open Need help request on the agent's session. [raisedAt] identifies it:
/// the frames that end it carry the same instant, so the app clears only the
/// request it shows.
///
/// Contract: `AgencySessionHelp`.
@immutable
final class SessionHelp {
  const SessionHelp({required this.raisedAt, this.callId});

  factory SessionHelp.fromJson(Map<String, Object?> j) =>
      SessionHelp(raisedAt: j.time('raised_at'), callId: j.strOrNull('call_id'));

  /// [value] as a request, or null when absent or unreadable. For the optional
  /// `ready.help`: a field this build cannot read must never cost the agent the
  /// reconnect snapshot it rides on.
  static SessionHelp? tryFromJson(Object? value) {
    if (value is! Map<String, Object?>) return null;
    try {
      return SessionHelp.fromJson(value);
    } on FormatException {
      return null;
    }
  }

  /// When the agent raised it (server clock).
  final DateTime raisedAt;

  /// The call the agent was on when they raised it; null in wrap-up.
  final String? callId;

  @override
  bool operator ==(Object other) => other is SessionHelp && other.raisedAt == raisedAt && other.callId == callId;

  @override
  int get hashCode => Object.hash(raisedAt, callId);

  @override
  String toString() => 'SessionHelp($raisedAt, call: $callId)';
}

/// `POST` and `DELETE /proxy/agency/sessions/:id/help`: the open request after
/// the raise (the one just raised, or the one already open), or null after the
/// cancel (whether or not one was open).
///
/// Contract: `AgencyHelpResponse`.
@immutable
final class HelpResponse {
  const HelpResponse({required this.sessionId, this.help});

  factory HelpResponse.fromJson(Map<String, Object?> j) {
    final help = j.objOrNull('help');
    return HelpResponse(sessionId: j.str('session_id'), help: help == null ? null : SessionHelp.fromJson(help));
  }

  final String sessionId;
  final SessionHelp? help;

  @override
  bool operator ==(Object other) => other is HelpResponse && other.sessionId == sessionId && other.help == help;

  @override
  int get hashCode => Object.hash(sessionId, help);

  @override
  String toString() => 'HelpResponse($sessionId, $help)';
}
