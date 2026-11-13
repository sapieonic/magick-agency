import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/ring/ring_channel.dart';

/// The method channel's native → Dart side: an event is taken only while something in Dart
/// listens; otherwise native is answered with an error, so it keeps what Dart has not heard (an
/// answer stays in `pendingAnswer`).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const codec = StandardMethodCodec();
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  /// Native calls Dart; the envelope Dart answered with, decoded (throws on an error envelope).
  Future<Object?> nativeCalls(String method, Object? args) async {
    final reply = Completer<ByteData?>();
    await messenger.handlePlatformMessage(MethodRingChannel.channelName, codec.encodeMethodCall(MethodCall(method, args)), reply.complete);
    final data = await reply.future;
    return codec.decodeEnvelope(data!);
  }

  const answer = {'call_id': 'call-1', 'offer_token': 'tok', 'session_id': 'sess-1'};

  tearDown(() => messenger.setMockMethodCallHandler(const MethodChannel(MethodRingChannel.channelName), null));

  test('an answer with nobody listening is refused, so native keeps it; once listened to, it is taken', () async {
    messenger.setMockMethodCallHandler(const MethodChannel(MethodRingChannel.channelName), (call) async => null);
    final channel = MethodRingChannel();
    // A Dart → native call sets the native handler before anything listens.
    await channel.getToken();
    await expectLater(nativeCalls('ringAnswered', answer), throwsA(isA<PlatformException>().having((e) => e.code, 'code', 'no_listener')));

    final events = <RingEvent>[];
    final sub = channel.events.listen(events.add);
    expect(await nativeCalls('ringAnswered', answer), isNull);
    await Future<void>.delayed(Duration.zero);
    expect(events.single, isA<RingAnswered>().having((e) => e.answer.callId, 'call id', 'call-1'));

    await sub.cancel();
    await expectLater(nativeCalls('ringEnded', {'call_id': 'call-1', 'reason': 'expired'}), throwsA(isA<PlatformException>()));
  });

  test('showAwayNotification names the absence: since (ISO, UTC) and the session; both optional', () async {
    final calls = <MethodCall>[];
    messenger.setMockMethodCallHandler(const MethodChannel(MethodRingChannel.channelName), (call) async {
      calls.add(call);
      return null;
    });
    final channel = MethodRingChannel();
    await channel.showAwayNotification(true, since: DateTime.utc(2026, 11, 2, 7, 58, 41, 120), sessionId: 'sess-1');
    await channel.showAwayNotification(false);
    expect(calls.map((c) => c.arguments), [
      {'on': true, 'since': '2026-11-02T07:58:41.120Z', 'session_id': 'sess-1'},
      {'on': false},
    ]);
  });

  test('"Stop ringing" is peeked, then cleared; the server clock goes over as offset_ms and measured_at (ISO, UTC)', () async {
    final calls = <MethodCall>[];
    messenger.setMockMethodCallHandler(const MethodChannel(MethodRingChannel.channelName), (call) async {
      calls.add(call);
      return call.method == 'peekStopRinging' ? {'session_id': 'sess-1'} : null;
    });
    final channel = MethodRingChannel();
    expect(await channel.peekStopRinging(), const RingStopRequest(sessionId: 'sess-1'));
    await channel.clearStopRinging();
    await channel.setServerClock(offsetMs: -4200, measuredAt: DateTime.utc(2026, 11, 2, 7, 50));
    expect(calls.map((c) => c.method), ['peekStopRinging', 'clearStopRinging', 'setServerClock']);
    expect(calls.last.arguments, {'offset_ms': -4200, 'measured_at': '2026-11-02T07:50:00.000Z'});
  });
}
