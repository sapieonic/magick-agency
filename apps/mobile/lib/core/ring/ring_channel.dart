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

  /// Shows or removes the ongoing "Away · this phone rings for inbound calls" notification.
  Future<void> showAwayNotification(bool on);

  /// Posts the local "Missed inbound call" notification (no name, no number).
  Future<void> showMissedRing();

  /// What native tells Dart: `token`, `ringAnswered`, `ringEnded`, `testRingReceived`,
  /// `stopRingingTapped`. Broadcast. An event nobody listens to is answered with an error, so
  /// native knows Dart did not take it (and keeps an answer for `pendingAnswer`).
  Stream<RingEvent> get events;
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
  /// impossible, so they are advice ([allOk]).
  bool get essentialsOk =>
      ok(RingChecklistItem.notifications) && ok(RingChecklistItem.phoneAccount) && ok(RingChecklistItem.microphone);

  bool get allOk => RingChecklistItem.values.every(ok);

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

/// The away notification's "Stop ringing".
final class RingStopTapped extends RingEvent {
  const RingStopTapped();
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
    case 'stopRingingTapped':
      return const RingStopTapped();
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
  Future<void> showAwayNotification(bool on) => _invoke<void>('showAwayNotification', {'on': on});

  @override
  Future<void> showMissedRing() => _invoke<void>('showMissedRing');
}

/// The one channel for the process (it owns the native handler). Tests override it with a fake.
final ringChannelProvider = Provider<RingChannel>((ref) => MethodRingChannel());
