import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:meta/meta.dart';

import '../telemetry/log.dart';

/// The ring channel (Mode B, `docs/mobile.md` "The ring channel (Mode B)"): the one seam between
/// the Dart app and the native code that receives ring pushes and rings the phone through the
/// system's calling UI. Frozen: one `MethodChannel` named `magick_agency/ring`, standard codec,
/// both directions. Every argument and result is a map with string keys (or null, a string, a
/// bool). The offer token is never logged.
///
/// Dart never handles a push itself: native posts `…/ring/answering` and `…/ring/decline` at the
/// tap; `…/ring/accept` (the Firebase Bearer and the station device id) is always Dart's
/// (`RingAnswerCoordinator`).
abstract interface class RingChannel {
  /// The FCM registration token; null when push is unavailable (no Firebase defines, no Play
  /// services, a platform with no native side).
  Future<String?> getToken();

  /// The ring the agent answered while Flutter was not running (a cold start from the
  /// full-screen intent), or null. Cleared on read: a second call answers null.
  Future<RingAnswer?> pendingAnswer();

  /// Whether each permission or setting lets the phone ring; null when native could not say.
  Future<RingChecklist?> checklist();

  /// Opens the system screen that fixes [item].
  Future<void> openSettings(RingChecklistItem item);

  /// The station has bound [callId]'s audio: native marks the Telecom connection active.
  Future<void> reportBound(String callId);

  /// Native disconnects the Telecom connection for [callId] and drops its notification.
  Future<void> reportEnded(String callId, RingEndReason reason);

  /// Shows or removes the ongoing "Away · this phone rings for inbound calls" notification. On:
  /// for the absence that began at [since] (server clock) in [sessionId], which native keeps so a
  /// `ring_off` for an earlier absence, delivered late, is dropped.
  Future<void> showAwayNotification(bool on, {DateTime? since, String? sessionId});

  /// Posts the local "Missed inbound call" notification (no name, no number).
  Future<void> showMissedRing();

  /// Keeps the app over the lock screen ([on]) while a call answered from a ring is on the
  /// station, through its outcome; native otherwise lets go once the call ends.
  Future<void> holdOverLockScreen(bool on);

  /// The away notification's "Stop ringing" that Dart has not cleared yet, or null. Left in
  /// place: Dart clears it ([clearStopRinging]) once `device_away` applied, so a process that dies
  /// before then still finds it. Native drops one older than one ring window plus the accept grace,
  /// and a new absence drops one never cleared. Native has already declined a ring ringing then
  /// (and declines one arriving in the next ring window): the station must ask `device_away`
  /// before it attaches, or an attach during a ring would answer it (N5).
  Future<RingStopRequest?> peekStopRinging();

  /// The "Stop ringing" [peekStopRinging] read is done with: `device_away` applied.
  Future<void> clearStopRinging();

  /// The server's clock reads [offsetMs] ahead of this phone's (negative: behind), as the station
  /// measured at [measuredAt] (this phone's clock). Native times a ring on the server's clock with
  /// it while it is fresh.
  Future<void> setServerClock({required int offsetMs, required DateTime measuredAt});

  /// Sends the app's task to the back (Android's `moveTaskToBack`): after "Stop ringing" the
  /// agent goes back to what they were doing. False when native could not.
  Future<bool> moveTaskToBack();

  /// The `ring_off` push native took for the absence it showed (the server ended `away_ring`
  /// while the agent was away), or null. Cleared on read; a new absence drops one never read.
  Future<RingOffRecord?> takeRingOff();

  /// What native tells Dart: `token`, `ringAnswered`, `ringEnded`, `testRingReceived`. Broadcast. An event nobody listens to is answered with an error, so
  /// native knows Dart did not take it (and keeps an answer for `pendingAnswer`).
  Stream<RingEvent> get events;

  /// No native side at all (where nothing rings): every call answers nothing, no event comes.
  static const RingChannel none = _NoRingChannel();
}

final class _NoRingChannel implements RingChannel {
  const _NoRingChannel();

  @override
  Future<String?> getToken() async => null;

  @override
  Future<RingAnswer?> pendingAnswer() async => null;

  @override
  Future<RingChecklist?> checklist() async => null;

  @override
  Future<void> openSettings(RingChecklistItem item) async {}

  @override
  Future<void> reportBound(String callId) async {}

  @override
  Future<void> reportEnded(String callId, RingEndReason reason) async {}

  @override
  Future<void> showAwayNotification(bool on, {DateTime? since, String? sessionId}) async {}

  @override
  Future<void> showMissedRing() async {}

  @override
  Future<void> holdOverLockScreen(bool on) async {}

  @override
  Future<RingStopRequest?> peekStopRinging() async => null;

  @override
  Future<void> clearStopRinging() async {}

  @override
  Future<void> setServerClock({required int offsetMs, required DateTime measuredAt}) async {}

  @override
  Future<bool> moveTaskToBack() async => false;

  @override
  Future<RingOffRecord?> takeRingOff() async => null;

  @override
  Stream<RingEvent> get events => const Stream<RingEvent>.empty();
}

/// One answered ring: what `…/ring/accept` takes. [offerToken] is never logged.
@immutable
final class RingAnswer {
  const RingAnswer({required this.callId, required this.offerToken, required this.sessionId});

  /// Reads `{call_id, offer_token, session_id}`; null when a field is missing or not a string.
  static RingAnswer? tryRead(Object? raw) {
    if (raw is! Map) return null;
    final callId = raw['call_id'];
    final token = raw['offer_token'];
    final session = raw['session_id'];
    if (callId is! String || token is! String || session is! String) return null;
    if (callId.isEmpty || token.isEmpty) return null;
    return RingAnswer(callId: callId, offerToken: token, sessionId: session);
  }

  final String callId;
  final String offerToken;
  final String sessionId;

  @override
  bool operator ==(Object other) =>
      other is RingAnswer && other.callId == callId && other.offerToken == offerToken && other.sessionId == sessionId;

  @override
  int get hashCode => Object.hash(callId, offerToken, sessionId);

  @override
  String toString() => 'RingAnswer($callId, <token>)';
}

/// "Stop ringing" tapped on the away notification, in the absence of [sessionId] (null when native
/// did not know it).
@immutable
final class RingStopRequest {
  const RingStopRequest({this.sessionId});

  /// Reads `{session_id}`; null when it is not a map.
  static RingStopRequest? tryRead(Object? raw) {
    if (raw is! Map) return null;
    final session = raw['session_id'];
    return RingStopRequest(sessionId: session is String && session.isNotEmpty ? session : null);
  }

  final String? sessionId;

  @override
  bool operator ==(Object other) => other is RingStopRequest && other.sessionId == sessionId;

  @override
  int get hashCode => sessionId.hashCode;

  @override
  String toString() => 'RingStopRequest($sessionId)';
}

/// A `ring_off` native took: the server ended `away_ring` for the absence that began at
/// [awaySince] in [sessionId] (each null when the push did not say), for [reason].
@immutable
final class RingOffRecord {
  const RingOffRecord({this.sessionId, this.awaySince, required this.reason});

  /// Reads `{session_id, away_since, reason}`; null when it is not a map.
  static RingOffRecord? tryRead(Object? raw) {
    if (raw is! Map) return null;
    final session = raw['session_id'];
    final since = raw['away_since'];
    final reason = raw['reason'];
    return RingOffRecord(
      sessionId: session is String && session.isNotEmpty ? session : null,
      awaySince: since is String ? DateTime.tryParse(since)?.toUtc() : null,
      reason: RingOffReason.fromWire(reason is String ? reason : null),
    );
  }

  final String? sessionId;
  final DateTime? awaySince;
  final RingOffReason reason;

  @override
  bool operator ==(Object other) =>
      other is RingOffRecord && other.sessionId == sessionId && other.awaySince == awaySince && other.reason == reason;

  @override
  int get hashCode => Object.hash(sessionId, awaySince, reason);

  @override
  String toString() => 'RingOffRecord(${reason.wire}, $sessionId, $awaySince)';
}

/// The `checklist` keys, in the order the settings card lists them.
enum RingChecklistItem {
  notifications('notifications'),
  fullScreen('full_screen'),
  batteryExempt('battery_exempt'),
  microphone('microphone'),
  phoneAccount('phone_account'),
  dndAllowsCalls('dnd_allows_calls');

  const RingChecklistItem(this.wire);
  final String wire;
}

/// What lets this phone ring, as native reads it. A key native did not send reads false.
@immutable
final class RingChecklist {
  const RingChecklist(this.items);

  static RingChecklist? tryRead(Object? raw) {
    if (raw is! Map) return null;
    return RingChecklist({for (final item in RingChecklistItem.values) item: raw[item.wire] == true});
  }

  final Map<RingChecklistItem, bool> items;

  bool ok(RingChecklistItem item) => items[item] ?? false;

  /// Without these the phone cannot ring, or the agent cannot talk once they answer: a
  /// notification to ring with, the calling account Telecom rings through, and the microphone.
  /// Full-screen calls, battery optimisation and Do Not Disturb make a ring easier to miss, not
  /// impossible, so they are advice.
  bool get essentialsOk =>
      ok(RingChecklistItem.notifications) && ok(RingChecklistItem.phoneAccount) && ok(RingChecklistItem.microphone);

  @override
  bool operator ==(Object other) =>
      other is RingChecklist && RingChecklistItem.values.every((i) => other.ok(i) == ok(i));

  @override
  int get hashCode => Object.hashAll(RingChecklistItem.values.map(ok));
}

/// `reportEnded`'s `reason`.
enum RingEndReason {
  /// The call ended after it bound.
  ended('ended'),

  /// Accept or the attach failed inside the grace, after one retry.
  acceptFailed('accept_failed'),

  /// The server says the ring is over, or another agent took the caller.
  cancelled('cancelled');

  const RingEndReason(this.wire);
  final String wire;
}

/// What native tells Dart.
sealed class RingEvent {
  const RingEvent();
}

/// FCM issued a new token (`onNewToken`).
final class RingTokenChanged extends RingEvent {
  const RingTokenChanged(this.token);
  final String token;
}

/// The agent answered with Flutter running; native has already posted `…/ring/answering`.
final class RingAnswered extends RingEvent {
  const RingAnswered(this.answer);
  final RingAnswer answer;
}

/// A ring ended on the phone without being answered. [reasonRaw] is an `InboundRingResult`
/// wire value (`declined`, `busy_on_phone`, `expired`, or a `ring_cancel` push's reason).
final class RingEnded extends RingEvent {
  RingEnded(this.callId, this.reasonRaw) : reason = InboundRingResult.fromWire(reasonRaw);
  final String callId;
  final String reasonRaw;
  final InboundRingResult reason;
}

/// A `test_ring` push arrived and rang locally. [shown]: its notification went up; false when
/// the push reached the phone but the call could not be shown (notifications off).
final class RingTestReceived extends RingEvent {
  const RingTestReceived({this.shown = true});
  final bool shown;
}

/// Decodes one native → Dart call; null for a method or arguments this build does not read.
@visibleForTesting
RingEvent? ringEventOf(String method, Object? arguments) {
  final args = arguments is Map ? arguments : const <Object?, Object?>{};
  switch (method) {
    case 'token':
      final token = args['token'];
      return token is String && token.isNotEmpty ? RingTokenChanged(token) : null;
    case 'ringAnswered':
      final answer = RingAnswer.tryRead(args);
      return answer == null ? null : RingAnswered(answer);
    case 'ringEnded':
      final callId = args['call_id'];
      final reason = args['reason'];
      return callId is String && callId.isNotEmpty ? RingEnded(callId, reason is String ? reason : '') : null;
    case 'testRingReceived':
      return RingTestReceived(shown: args['shown'] != false);
    default:
      return null;
  }
}

/// The channel over `MethodChannel('magick_agency/ring')`. A platform with no native side (iOS
/// today, IQ64; tests) answers [MissingPluginException]: every method then answers "nothing"
/// (no token, no pending answer, no checklist), never throws.
final class MethodRingChannel implements RingChannel {
  MethodRingChannel([MethodChannel? channel]) : _channel = channel ?? const MethodChannel(channelName);

  static const channelName = 'magick_agency/ring';
  static final _log = Log('ring.channel');

  final MethodChannel _channel;
  late final _events = StreamController<RingEvent>.broadcast(onListen: _listen);
  bool _handling = false;

  /// The native handler goes in on the first listener (or call), not at construction: building
  /// the channel must never need the platform binding.
  void _listen() {
    if (_handling) return;
    try {
      _channel.setMethodCallHandler(_onCall);
      _handling = true;
    } catch (e) {
      _log.warn('ring channel handler not set', {'error': e.runtimeType.toString()});
    }
  }

  @override
  Stream<RingEvent> get events => _events.stream;

  Future<Object?> _onCall(MethodCall call) async {
    final event = ringEventOf(call.method, call.arguments);
    if (event == null) {
      _log.warn('ring channel call not read', {'method': call.method});
      return null;
    }
    if (!_events.hasListener) {
      // Nobody would hear it: an error tells native it was not taken, so it keeps what it keeps
      // (an answer stays in `pendingAnswer`, an unheard miss is posted natively).
      _log.warn('ring channel event with no listener', {'method': call.method});
      throw PlatformException(code: 'no_listener', message: '${call.method}: nothing in Dart is listening yet');
    }
    _log.info('ring channel event', {'method': call.method});
    _events.add(event);
    return null;
  }

  Future<T?> _invoke<T>(String method, [Map<String, Object?>? arguments]) async {
    _listen();
    try {
      return await _channel.invokeMethod<T>(method, arguments);
    } on MissingPluginException {
      return null;
    } on PlatformException catch (e) {
      _log.warn('ring channel call failed', {'method': method, 'code': e.code});
      return null;
    } catch (e) {
      // No platform binding (a test), or a result of another type: nothing, as on a platform
      // with no native side.
      _log.warn('ring channel call failed', {'method': method, 'error': e.runtimeType.toString()});
      return null;
    }
  }

  @override
  Future<String?> getToken() async {
    final token = await _invoke<String>('getToken');
    return token == null || token.isEmpty ? null : token;
  }

  @override
  Future<RingAnswer?> pendingAnswer() async => RingAnswer.tryRead(await _invoke<Object?>('pendingAnswer'));

  @override
  Future<RingChecklist?> checklist() async => RingChecklist.tryRead(await _invoke<Object?>('checklist'));

  @override
  Future<void> openSettings(RingChecklistItem item) => _invoke<void>('openSettings', {'item': item.wire});

  @override
  Future<void> reportBound(String callId) => _invoke<void>('reportBound', {'call_id': callId});

  @override
  Future<void> reportEnded(String callId, RingEndReason reason) =>
      _invoke<void>('reportEnded', {'call_id': callId, 'reason': reason.wire});

  @override
  Future<void> showAwayNotification(bool on, {DateTime? since, String? sessionId}) => _invoke<void>('showAwayNotification', {
        'on': on,
        if (since != null) 'since': since.toUtc().toIso8601String(),
        'session_id': ?sessionId,
      });

  @override
  Future<void> showMissedRing() => _invoke<void>('showMissedRing');

  @override
  Future<void> holdOverLockScreen(bool on) => _invoke<void>('holdOverLockScreen', {'on': on});

  @override
  Future<RingOffRecord?> takeRingOff() async => RingOffRecord.tryRead(await _invoke<Object?>('takeRingOff'));

  @override
  Future<RingStopRequest?> peekStopRinging() async => RingStopRequest.tryRead(await _invoke<Object?>('peekStopRinging'));

  @override
  Future<void> clearStopRinging() => _invoke<void>('clearStopRinging');

  @override
  Future<void> setServerClock({required int offsetMs, required DateTime measuredAt}) =>
      _invoke<void>('setServerClock', {'offset_ms': offsetMs, 'measured_at': measuredAt.toUtc().toIso8601String()});

  @override
  Future<bool> moveTaskToBack() async => await _invoke<bool>('moveTaskToBack') ?? false;
}

/// The one channel for the process (it owns the native handler). Tests override it with a fake.
final ringChannelProvider = Provider<RingChannel>((ref) => MethodRingChannel());
