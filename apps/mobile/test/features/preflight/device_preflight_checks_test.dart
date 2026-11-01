import 'dart:async';
import 'dart:convert';
import 'dart:io' show SocketException;

import 'package:agent_audio/agent_audio.dart';
import 'package:battery_plus/battery_plus.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:magick_agency_agent/core/api/api_client.dart';
import 'package:magick_agency_agent/core/api/client_identity.dart';
import 'package:magick_agency_agent/core/env.dart';
import 'package:magick_agency_agent/features/preflight/device_preflight_checks.dart';
import 'package:magick_agency_agent/features/preflight/preflight_checks.dart';
import 'package:magick_agency_agent/features/preflight/preflight_screen.dart';
import 'package:mocktail/mocktail.dart';

class _Audio extends Mock implements AgentAudio {}

class _Battery extends Mock implements Battery {}

class _Conn extends Mock implements Connectivity {}

class _Tokens implements IdTokenSource {
  @override
  Future<String?> idToken({bool forceRefresh = false}) async => 't';
}

const _env = Env(
  flavor: 'test',
  apiOrigin: 'https://api.test',
  firebaseApiKey: '',
  firebaseProjectId: '',
  firebaseAppIdAndroid: '',
  firebaseAppIdIos: '',
  firebaseMessagingSenderId: '',
  googleIosClientId: '',
  googleServerClientId: '',
  posthogKey: '',
  posthogHost: '',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Conn conn;
  final paths = <String>[];

  setUp(() {
    conn = _Conn();
    paths.clear();
    when(() => conn.checkConnectivity()).thenAnswer((_) async => [ConnectivityResult.wifi]);
  });

  DevicePreflightChecks checks(MockClientHandler handler) => DevicePreflightChecks(
        audio: _Audio(),
        api: ApiClient(
          http: MockClient((req) {
            paths.add('${req.method} ${req.url.path}');
            return handler(req);
          }),
          env: _env,
          tokens: _Tokens(),
          identity: ClientIdentity.test,
          scope: RequestScope(),
        ),
        connectivity: conn,
        battery: _Battery(),
        isAndroid: false,
      );

  http.Response ok(Object body) => http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});

  test('no link at all is offline, without touching the server', () async {
    when(() => conn.checkConnectivity()).thenAnswer((_) async => [ConnectivityResult.none]);
    final n = await checks((_) async => ok({})).network();
    expect(n.online, isFalse);
    expect(paths, isEmpty);
  });

  test('a link but no server (transport failure) is offline', () async {
    final n = await checks((_) async => throw const SocketException('unreachable')).network();
    expect(n.online, isFalse);
    expect(n.transport, 'Wi-Fi');
  });

  test('an HTTP error still proves the server is reachable', () async {
    final n = await checks((req) async => http.Response('{}', 503, headers: {'content-type': 'application/json'}))
        .network();
    expect(n.online, isTrue);
    expect(n.latencyMs, isNotNull);
    expect(n.uploadKbps, isNull); // the probe was refused: not measured, not invented
  });

  test('round trip, then a 32 KB raw upload to the probe gives kbps', () async {
    late http.Request probe;
    final n = await checks((req) async {
      if (req.url.path == '/client-config/uplink-probe') {
        probe = req;
        await Future<void>.delayed(const Duration(milliseconds: 40));
        return ok({'received_bytes': req.bodyBytes.length});
      }
      return ok({'mobile': <String, Object?>{}});
    }).network();
    expect(paths, ['GET /client-config', 'GET /client-config', 'POST /client-config/uplink-probe']);
    expect(probe.bodyBytes.length, DevicePreflightChecks.probeBytes);
    expect(probe.headers['content-type'], startsWith('application/octet-stream'));
    expect(n.online, isTrue);
    // 262144 bits in roughly 40 ms: a few Mbps, and never more than the 1 ms floor allows.
    expect(n.uploadKbps, isNotNull);
    expect(n.uploadKbps!, greaterThan(500));
    expect(n.uploadKbps!, lessThanOrEqualTo(DevicePreflightChecks.probeBytes * 8));
  });

  test('the round trip is timed on a warm connection, not the handshake\'s', () async {
    var gets = 0;
    final n = await checks((req) async {
      if (req.url.path == '/client-config') {
        // The first read on an idle connection also pays for DNS, TCP and TLS.
        if (gets++ == 0) await Future<void>.delayed(const Duration(milliseconds: 400));
        return ok({});
      }
      return ok({'received_bytes': req.bodyBytes.length});
    }).network();
    expect(gets, 2);
    expect(n.latencyMs, lessThan(200));
    expect(gradeNetwork(n).pill, 'Good');
  });

  test('an upload that runs out of time is below the probe\'s ceiling, and blocks', () {
    fakeAsync((async) {
      NetworkSample? n;
      checks((req) async {
        if (req.url.path == '/client-config/uplink-probe') {
          await Future<void>.delayed(const Duration(seconds: 30)); // never finishes in 5 s
        }
        return ok({});
      }).network().then((v) => n = v);
      // Settles within the screen's deadline, as a figure rather than "couldn't tell".
      async.elapse(const Duration(seconds: 6));
      expect(n, isNotNull);
      expect(n!.online, isTrue);
      // 32 KB not through in 5 s: under 32768 × 8 / 5000 ≈ 52.4 kbps, below the 64 kbps floor.
      expect(n!.uploadKbps, 52.0);
      expect(gradeNetwork(n!).status, CheckStatus.fail);
    });
  });

  test('the whole network check fits inside the screen\'s per-check deadline', () {
    final worst = DevicePreflightChecks.firstReadTimeout + DevicePreflightChecks.roundTripTimeout + const Duration(seconds: 5);
    expect(DevicePreflightChecks.networkBudget, worst);
    // A second to spare for the link check and scheduling.
    expect(worst + const Duration(seconds: 1), lessThanOrEqualTo(PreflightScreen.checkTimeout));
    // The cold read gets the larger share: it also pays for DNS, TCP and TLS.
    expect(DevicePreflightChecks.firstReadTimeout, greaterThan(DevicePreflightChecks.roundTripTimeout));
    expect(DevicePreflightChecks.probeBytes * 8 / 5000, lessThan(minUploadKbps));
  });

  test('a slow cold connection (4 s to the first answer) is graded on the warm round trip, not as offline', () {
    fakeAsync((async) {
      NetworkSample? n;
      var gets = 0;
      checks((req) async {
        if (req.url.path == '/client-config' && gets++ == 0) {
          await Future<void>.delayed(const Duration(seconds: 4)); // DNS + TCP + TLS on a waking radio
        }
        return ok({'received_bytes': req.bodyBytes.length});
      }).network().then((v) => n = v);
      async.elapse(const Duration(seconds: 5));
      expect(n, isNotNull);
      expect(n!.online, isTrue);
      expect(n!.noAnswer, isFalse);
      expect(n!.latencyMs, lessThan(100));
      expect(gradeNetwork(n!).status, CheckStatus.ok);
    });
  });

  test('a server that never answers is too slow for calls, said honestly, inside the deadline', () {
    fakeAsync((async) {
      NetworkSample? n;
      checks((req) async {
        await Future<void>.delayed(const Duration(seconds: 60));
        return ok({});
      }).network().then((v) => n = v);
      async.elapse(DevicePreflightChecks.firstReadTimeout + const Duration(milliseconds: 100));
      expect(n, isNotNull);
      expect(n!.online, isTrue);
      expect(n!.noAnswer, isTrue);
      expect(n!.transport, 'Wi-Fi');
      final graded = gradeNetwork(n!);
      expect(graded.status, CheckStatus.fail); // still blocks: no call can run on it
      expect(graded.detail, startsWith('Too slow for calls'));
      expect(graded.detail, contains('Wi-Fi'));
      expect(graded.detail, isNot(contains('No connection')));
      // No upload probe on a link that could not answer a read.
      expect(paths, ['GET /client-config']);
    });
  });

  test('a warm round trip past its limit is too slow, not offline', () {
    fakeAsync((async) {
      NetworkSample? n;
      var gets = 0;
      checks((req) async {
        if (req.url.path == '/client-config' && gets++ == 1) await Future<void>.delayed(const Duration(seconds: 10));
        return ok({});
      }).network().then((v) => n = v);
      async.elapse(const Duration(seconds: 3));
      expect(n, isNotNull);
      expect(n!.online, isTrue);
      expect(n!.noAnswer, isTrue);
    });
  });

  test('a server without the probe (404) reports no upload figure', () async {
    final n = await checks((req) async => req.url.path == '/client-config'
        ? ok({})
        : http.Response('{"code":"not_found"}', 404, headers: {'content-type': 'application/json'})).network();
    expect(n.online, isTrue);
    expect(n.uploadKbps, isNull);
  });

  test('battery optimisation does not apply off Android', () async {
    final b = await checks((_) async => ok({})).batteryOptimisation();
    expect(b.applies, isFalse);
  });

  group('sound check and the station share one voice engine', () {
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    const methods = MethodChannel(AgentAudioChannels.methods);
    late List<String> calls;
    late Completer<void> loopback;
    late AgentAudio audio;

    setUp(() {
      calls = [];
      loopback = Completer<void>();
      messenger.setMockMethodCallHandler(methods, (call) async {
        final args = call.arguments;
        calls.add(call.method == 'stop' && args is Map && args['keepWarm'] == false ? 'release' : call.method);
        if (call.method == 'loopbackTest') {
          await loopback.future;
          return {'levels': <double>[], 'playedBack': false};
        }
        return null;
      });
      // The real plugin class: its lifecycle calls run in order, as on a phone.
      audio = AgentAudio();
    });

    tearDown(() async {
      await audio.dispose();
      messenger.setMockMethodCallHandler(methods, null);
    });

    DevicePreflightChecks soundChecks() => DevicePreflightChecks(
          audio: audio,
          api: ApiClient(http: MockClient((_) async => ok({})), env: _env, tokens: _Tokens(), identity: ClientIdentity.test, scope: RequestScope()),
          connectivity: conn,
          battery: _Battery(),
          isAndroid: false,
          microphoneGranted: () async => true,
        );

    test('alone, it warms the idle engine and leaves it idle again', () async {
      final checks = soundChecks();
      final sample = checks.soundCheck();
      await pumpEventQueue();
      loopback.complete();
      expect((await sample).ran, isTrue);
      expect(calls, ['prepare', 'loopbackTest', 'release']);
      expect(audio.phase, AgentAudioPhase.idle);
    });

    test('the station takes the engine mid-check: the check never releases it, and the first call has audio', () async {
      final checks = soundChecks();
      final sample = checks.soundCheck();
      await pumpEventQueue();
      expect(calls, ['prepare', 'loopbackTest']);

      // "Go on duty": the station prepares while the loopback is still listening.
      checks.handOverAudio();
      final stationPrepare = audio.prepare(format: AgentAudioFormat.alaw8);
      loopback.complete();
      await sample;
      await stationPrepare;

      expect(calls, isNot(contains('release')));
      expect(audio.phase, AgentAudioPhase.prepared);
      await audio.armMicrophone(); // the first call: would throw "not prepared" on a released engine
      expect(audio.phase, AgentAudioPhase.armed);
    });

    test('on an engine the station already prepared, the check leaves it prepared', () async {
      await audio.prepare(format: AgentAudioFormat.alaw8);
      final checks = soundChecks();
      final sample = checks.soundCheck();
      await pumpEventQueue();
      loopback.complete();
      expect((await sample).ran, isTrue);
      expect(calls, ['prepare', 'loopbackTest']);
      expect(audio.phase, AgentAudioPhase.prepared);
    });
  });
}
