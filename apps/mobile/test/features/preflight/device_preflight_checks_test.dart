import 'dart:convert';
import 'dart:io' show SocketException;

import 'package:agent_audio/agent_audio.dart';
import 'package:battery_plus/battery_plus.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:magick_agency_agent/core/api/api_client.dart';
import 'package:magick_agency_agent/core/api/client_identity.dart';
import 'package:magick_agency_agent/core/env.dart';
import 'package:magick_agency_agent/features/preflight/device_preflight_checks.dart';
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
    expect(paths, ['GET /client-config', 'POST /client-config/uplink-probe']);
    expect(probe.bodyBytes.length, DevicePreflightChecks.probeBytes);
    expect(probe.headers['content-type'], startsWith('application/octet-stream'));
    expect(n.online, isTrue);
    // 262144 bits in roughly 40 ms: a few Mbps, and never more than the 1 ms floor allows.
    expect(n.uploadKbps, isNotNull);
    expect(n.uploadKbps!, greaterThan(500));
    expect(n.uploadKbps!, lessThanOrEqualTo(DevicePreflightChecks.probeBytes * 8));
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
}
