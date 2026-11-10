import 'dart:async';

import 'package:agent_audio/agent_audio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const methods = MethodChannel(AgentAudioChannels.methods);
  const events = EventChannel(AgentAudioChannels.events);

  late List<MethodCall> calls;
  late Map<String, Object? Function(MethodCall)> replies;
  late List<Uint8List> downlink;
  late AgentAudio audio;

  setUp(() {
    calls = [];
    replies = {};
    downlink = [];
    messenger.setMockMethodCallHandler(methods, (call) async {
      calls.add(call);
      final reply = replies[call.method];
      return reply?.call(call);
    });
    messenger.setMockMessageHandler(AgentAudioChannels.downlink, (data) async {
      downlink.add(Uint8List.fromList(data!.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes)));
      return null;
    });
    audio = AgentAudio();
  });

  tearDown(() async {
    await audio.dispose();
    messenger.setMockMethodCallHandler(methods, null);
    messenger.setMockMessageHandler(AgentAudioChannels.downlink, null);
    messenger.setMockStreamHandler(events, null);
  });

  Future<void> deliverUplink(List<int> bytes) async {
    final data = ByteData.sublistView(Uint8List.fromList(bytes));
    await messenger.handlePlatformMessage(AgentAudioChannels.uplink, data, (_) {});
  }

  group('lifecycle', () {
    test('walks a call: prepare → arm → uplink → stop → release', () async {
      await audio.prepare(format: AgentAudioFormat.alaw8);
      expect(audio.phase, AgentAudioPhase.prepared);
      expect(audio.format, AgentAudioFormat.alaw8);
      await audio.armMicrophone();
      expect(audio.phase, AgentAudioPhase.armed);
      await audio.startUplink();
      expect(audio.phase, AgentAudioPhase.streaming);
      await audio.stop();
      expect(audio.phase, AgentAudioPhase.prepared);
      expect(audio.format, AgentAudioFormat.alaw8, reason: 'kept warm for the next call');
      await audio.release();
      expect(audio.phase, AgentAudioPhase.idle);
      expect(audio.format, isNull);
      expect(calls.map((c) => c.method), ['prepare', 'armMicrophone', 'startUplink', 'stop', 'stop']);
      expect(calls[0].arguments, {'format': 'alaw8'});
      expect(calls[3].arguments, {'keepWarm': true});
      expect(calls[4].arguments, {'keepWarm': false});
    });

    test('refuses out-of-order calls without reaching the platform', () async {
      await expectLater(
        audio.armMicrophone(),
        throwsA(isA<AgentAudioException>().having((e) => e.code, 'code', AgentAudioErrorCode.notPrepared)),
      );
      await audio.prepare(format: AgentAudioFormat.pcm16);
      await expectLater(
        audio.startUplink(),
        throwsA(isA<AgentAudioException>().having((e) => e.code, 'code', AgentAudioErrorCode.invalidState)),
      );
      await audio.armMicrophone();
      await expectLater(
        audio.prepare(format: AgentAudioFormat.alaw8),
        throwsA(isA<AgentAudioException>().having((e) => e.code, 'code', AgentAudioErrorCode.invalidState)),
      );
      expect(calls.map((c) => c.method), ['prepare', 'armMicrophone']);
    });

    test('calls made without awaiting run in order, each after the previous completes', () async {
      final gate = Completer<void>();
      replies['prepare'] = (_) => gate.future;
      final order = <String>[];
      final f1 = audio.prepare(format: AgentAudioFormat.alaw8).then((_) => order.add('prepare'));
      final f2 = audio.armMicrophone().then((_) => order.add('arm'));
      final f3 = audio.startUplink().then((_) => order.add('uplink'));
      await pumpEventQueue();
      expect(calls.map((c) => c.method), ['prepare'], reason: 'arm waits for prepare');
      gate.complete();
      await Future.wait([f1, f2, f3]);
      expect(order, ['prepare', 'arm', 'uplink']);
      expect(audio.phase, AgentAudioPhase.streaming);
    });

    test('a failed call leaves the phase unchanged and does not block later calls', () async {
      replies['prepare'] = (_) => throw PlatformException(code: 'device_busy', message: 'In a phone call');
      await expectLater(
        audio.prepare(format: AgentAudioFormat.alaw8),
        throwsA(const AgentAudioException(AgentAudioErrorCode.deviceBusy, 'In a phone call')),
      );
      expect(audio.phase, AgentAudioPhase.idle);
      replies.remove('prepare');
      await audio.prepare(format: AgentAudioFormat.alaw8);
      expect(audio.phase, AgentAudioPhase.prepared);
    });

    test('stop is safe in any phase and repeatable', () async {
      await audio.stop();
      await audio.stop();
      await audio.release();
      expect(audio.phase, AgentAudioPhase.idle);
    });

    test('a missing plugin surfaces as unsupported', () async {
      messenger.setMockMethodCallHandler(methods, null);
      await expectLater(
        audio.setMuted(true),
        throwsA(isA<AgentAudioException>().having((e) => e.code, 'code', AgentAudioErrorCode.unsupported)),
      );
    });
  });

  group('media', () {
    test('uplink frames arrive as the exact bytes, in order', () async {
      final got = <Uint8List>[];
      final sub = audio.uplink.listen(got.add);
      await deliverUplink(List.filled(160, 0xD5));
      await deliverUplink(List.generate(160, (i) => i));
      await deliverUplink(const []);
      expect(got, hasLength(2), reason: 'empty messages are dropped');
      expect(got[0], everyElement(0xD5));
      expect(got[1], List.generate(160, (i) => i));
      await sub.cancel();
    });

    test('playFrame is ignored until the engine is armed', () async {
      audio.playFrame(Uint8List(160));
      await pumpEventQueue();
      expect(downlink, isEmpty);
      await audio.prepare(format: AgentAudioFormat.alaw8);
      audio.playFrame(Uint8List(160));
      await pumpEventQueue();
      expect(downlink, isEmpty);
      await audio.armMicrophone();
      audio.playFrame(Uint8List(0));
      audio.playFrame(Uint8List(160)..fillRange(0, 160, 0x2A));
      await pumpEventQueue();
      expect(downlink, hasLength(1));
      expect(downlink.single, everyElement(0x2A));
    });

    test('playFrame sends only the view it is given (sub-list of a larger socket buffer)', () async {
      await audio.prepare(format: AgentAudioFormat.alaw8);
      await audio.armMicrophone();
      final socketBuffer = Uint8List.fromList(List.generate(200, (i) => i));
      audio.playFrame(Uint8List.sublistView(socketBuffer, 20, 180));
      await pumpEventQueue();
      expect(downlink.single, List.generate(160, (i) => i + 20));
    });

    test('playFrame stops after stop()', () async {
      await audio.prepare(format: AgentAudioFormat.alaw8);
      await audio.armMicrophone();
      await audio.stop();
      audio.playFrame(Uint8List(160));
      await pumpEventQueue();
      expect(downlink, isEmpty);
    });
  });

  group('ringback', () {
    test('sends the flag; a request made before arm reaches the platform before it', () async {
      await audio.prepare(format: AgentAudioFormat.alaw8);
      await audio.setRingback(true);
      await audio.armMicrophone();
      await audio.setRingback(false);
      await audio.stop();
      expect(calls.map((c) => [c.method, c.arguments]), [
        ['prepare', {'format': 'alaw8'}],
        ['setRingback', {'on': true}],
        ['armMicrophone', null],
        ['setRingback', {'on': false}],
        ['stop', {'keepWarm': true}],
      ]);
      expect(audio.phase, AgentAudioPhase.prepared, reason: 'not a lifecycle call');
    });

    test('waits for a pending stop, so the stop (which clears it natively) cannot undo it', () async {
      await audio.prepare(format: AgentAudioFormat.alaw8);
      await audio.armMicrophone();
      final gate = Completer<void>();
      replies['stop'] = (_) => gate.future;
      final stopped = audio.stop();
      final rearmed = audio.armMicrophone();
      final ring = audio.setRingback(true);
      await pumpEventQueue();
      expect(calls.map((c) => c.method), ['prepare', 'armMicrophone', 'stop'], reason: 'queued behind the stop');
      gate.complete();
      await Future.wait([stopped, rearmed, ring]);
      expect(calls.map((c) => c.method), ['prepare', 'armMicrophone', 'stop', 'armMicrophone', 'setRingback']);
    });

    test('works in any phase and a refusal does not block later calls', () async {
      await audio.setRingback(true);
      expect(audio.phase, AgentAudioPhase.idle);
      replies['setRingback'] = (_) => throw PlatformException(code: 'unknown', message: 'boom');
      await expectLater(audio.setRingback(false), throwsA(isA<AgentAudioException>()));
      await audio.prepare(format: AgentAudioFormat.pcm16);
      expect(audio.phase, AgentAudioPhase.prepared);
    });
  });

  group('chime', () {
    test('asks the platform once per call, queued behind the arm it follows', () async {
      await audio.prepare(format: AgentAudioFormat.alaw8);
      final arm = audio.armMicrophone();
      final chime = audio.playChime();
      await Future.wait([arm, chime]);
      await audio.stop();
      expect(calls.map((c) => [c.method, c.arguments]), [
        ['prepare', {'format': 'alaw8'}],
        ['armMicrophone', null],
        ['playChime', null],
        ['stop', {'keepWarm': true}],
      ]);
      expect(audio.phase, AgentAudioPhase.prepared, reason: 'not a lifecycle call');
    });

    test('a refusal surfaces as an AgentAudioException and blocks nothing after it', () async {
      replies['playChime'] = (_) => throw PlatformException(code: 'unknown', message: 'boom');
      await expectLater(audio.playChime(), throwsA(isA<AgentAudioException>()));
      await audio.prepare(format: AgentAudioFormat.alaw8);
      expect(audio.phase, AgentAudioPhase.prepared);
    });
  });

  group('events', () {
    test('decodes the event channel and drops what it does not understand', () async {
      messenger.setMockStreamHandler(
        events,
        MockStreamHandler.inline(onListen: (args, sink) {
          sink.success({'type': 'noisy'});
          sink.success({'type': 'from-the-future'});
          sink.success({'type': 'level', 'dbfs': -20.5});
          sink.endOfStream();
        }),
      );
      expect(await audio.events.toList(), [const AudioBecomingNoisy(), const InputLevel(-20.5)]);
    });
  });

  group('routes', () {
    test('lists, reads and sets routes', () async {
      replies['routes'] = (_) => [
            {'kind': 'earpiece', 'id': 'earpiece', 'name': 'Phone'},
            {'kind': 'speaker', 'id': 'speaker', 'name': 'Speaker'},
          ];
      replies['currentRoute'] = (_) => {'kind': 'speaker', 'id': 'speaker', 'name': 'Speaker'};
      final routes = await audio.routes();
      expect(routes.map((r) => r.kind), [AudioRouteKind.earpiece, AudioRouteKind.speaker]);
      expect((await audio.currentRoute())!.kind, AudioRouteKind.speaker);
      await audio.setRoute(routes.first);
      expect(calls.last.method, 'setRoute');
      expect(calls.last.arguments, {'kind': 'earpiece', 'id': 'earpiece', 'name': 'Phone'});
    });

    test('currentRoute is null before prepare', () async {
      expect(await audio.currentRoute(), isNull);
      expect(await audio.routes(), isEmpty);
    });
  });

  group('loopback', () {
    test('needs a prepared engine', () async {
      await expectLater(audio.loopbackTest(), throwsA(isA<AgentAudioException>()));
      expect(calls, isEmpty);
    });

    test('passes duration and play-back flag and analyses the levels', () async {
      replies['loopbackTest'] = (_) => {
            'levels': [for (var i = 0; i < 50; i++) -60.0, for (var i = 0; i < 25; i++) -25.0],
            'playedBack': true,
          };
      await audio.prepare(format: AgentAudioFormat.alaw8);
      final r = await audio.loopbackTest(duration: const Duration(milliseconds: 1200), playBack: true);
      expect(calls.last.arguments, {'durationMs': 1200, 'playBack': true});
      expect(r.voiceDetected, isTrue);
      expect(r.playedBack, isTrue);
      expect(r.frameLevelsDbfs, hasLength(75));
      expect(audio.phase, AgentAudioPhase.prepared);
    });

    test('a second test while one runs is refused', () async {
      final gate = Completer<Object?>();
      replies['loopbackTest'] = (_) => gate.future;
      await audio.prepare(format: AgentAudioFormat.pcm16);
      final first = audio.loopbackTest();
      await pumpEventQueue();
      await expectLater(audio.loopbackTest(), throwsA(isA<AgentAudioException>()));
      gate.complete({'levels': <double>[], 'playedBack': false});
      expect((await first).voiceDetected, isFalse);
    });
  });

  group('call system', () {
    test('passes call identity and end reason', () async {
      await audio.configureCallSystem(useCallKit: false);
      await audio.startCall(callId: 'a1b2', displayName: 'Priya Sharma', handle: '+91 98•• •••• 21');
      await audio.reportConnected('a1b2');
      await audio.endCall('a1b2', reason: CallEndReason.remoteEnded);
      expect(calls.map((c) => [c.method, c.arguments]), [
        ['configureCallSystem', {'useCallKit': false}],
        ['startCall', {'callId': 'a1b2', 'displayName': 'Priya Sharma', 'handle': '+91 98•• •••• 21'}],
        ['reportConnected', {'callId': 'a1b2'}],
        ['endCall', {'callId': 'a1b2', 'reason': 'remoteEnded'}],
      ]);
    });

    test('refuses an empty call id', () {
      expect(() => audio.startCall(callId: '', displayName: 'x', handle: 'y'), throwsArgumentError);
      expect(() => audio.endCall(''), throwsArgumentError);
    });

    test('maps CallKit refusals', () async {
      replies['startCall'] = (_) => throw PlatformException(code: 'call_system', message: 'maximumCallGroupsReached');
      await expectLater(
        audio.startCall(callId: 'c', displayName: 'd', handle: 'h'),
        throwsA(isA<AgentAudioException>().having((e) => e.code, 'code', AgentAudioErrorCode.callSystem)),
      );
    });
  });

  group('Android service and battery', () {
    test('sends the notification content', () async {
      const n = OnDutyNotification(title: 'On duty', text: 'Waiting for calls', channelName: 'On duty');
      await audio.startOnDutyService(n);
      await audio.updateOnDutyService(n);
      await audio.stopOnDutyService();
      expect(calls.map((c) => c.method), ['startOnDutyService', 'updateOnDutyService', 'stopOnDutyService']);
      expect(calls.first.arguments, n.toMap());
    });

    test('foreground refusal is a typed error', () async {
      replies['startOnDutyService'] = (_) => throw PlatformException(code: 'not_in_foreground');
      await expectLater(
        audio.startOnDutyService(const OnDutyNotification(title: 't', text: 'x', channelName: 'c')),
        throwsA(isA<AgentAudioException>().having((e) => e.code, 'code', AgentAudioErrorCode.notInForeground)),
      );
    });

    test('battery optimisation defaults to true when the platform has no answer (iOS)', () async {
      expect(await audio.isIgnoringBatteryOptimizations(), isTrue);
      replies['isIgnoringBatteryOptimizations'] = (_) => false;
      expect(await audio.isIgnoringBatteryOptimizations(), isFalse);
      replies['requestIgnoreBatteryOptimizations'] = (_) => true;
      expect(await audio.requestIgnoreBatteryOptimizations(), isTrue);
    });

    test('mute and metering', () async {
      await audio.setMuted(true);
      await audio.setInputLevelMetering(true);
      expect(calls.map((c) => [c.method, c.arguments]), [
        ['setMuted', {'muted': true}],
        ['setInputLevelMetering', {'enabled': true}],
      ]);
    });
  });
}
