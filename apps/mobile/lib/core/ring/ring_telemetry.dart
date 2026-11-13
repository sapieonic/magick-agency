import '../telemetry/telemetry.dart';

/// Mode B's events (`docs/mobile.md` "The ring channel (Mode B)"). Ids and codes only: never a
/// name, a number or the offer token. The console sends none of these (a ring is the phone's
/// alone), so the names follow the app's own inbound events (`agency_inbound_*`).
abstract final class RingTelemetry {
  /// Dart learned of a ring (answered, ended, or waiting from a cold start): once per call.
  static void received(String callId, {required String via}) =>
      Telemetry.event('agency_inbound_ring_received', {'call_id': callId, 'via': via});

  /// The agent answered; [coldStart]: Flutter was not running (the full-screen intent).
  static void answered(String callId, {required bool coldStart}) =>
      Telemetry.event('agency_inbound_ring_answered', {'call_id': callId, 'cold_start': coldStart});

  /// A ring the agent turned away ([reason]: `declined`, `busy_on_phone`).
  static void declined(String callId, {required String reason}) =>
      Telemetry.event('agency_inbound_ring_declined', {'call_id': callId, 'reason': reason});

  /// A ring that ended unanswered ([reason]: `expired`, `accept_lapsed`), or an answer whose
  /// accept failed ([reason] `accept_failed`, with the refusal's [code]).
  static void expired(String callId, {required String reason, String? code}) =>
      Telemetry.event('agency_inbound_ring_expired', {'call_id': callId, 'reason': reason, 'code': ?code});

  /// The agent turned ringing on or off on this phone ([source]: `settings`, the Me card, the only
  /// place it changes).
  static void optInChanged({required bool on, required String source}) =>
      Telemetry.event('agency_ring_optin_changed', {'on': on, 'source': source});
}
