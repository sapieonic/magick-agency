import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:magick_agency_agent/app/providers.dart';
import 'package:magick_agency_agent/core/api/api_client.dart';
import 'package:magick_agency_agent/core/api/client_identity.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/ring/ring_answer_coordinator.dart';
import 'package:magick_agency_agent/core/ring/ring_channel.dart';
import 'package:magick_agency_agent/core/ring/ring_overrides.dart';
import 'package:magick_agency_agent/core/ring/ring_registration.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/core/station/station_device.dart';

import '../inbound/inbound_fixtures.dart' show pushSample;
import '../station/controller_harness.dart' show FakeLifecycle, FakeTokens, Sent, testEnv;
import 'fake_ring_channel.dart';

/// The gate, set by the test.
class RingGate extends AppGateNotifier {
  RingGate(this.initial);
  final AppGate initial;

  @override
  AppGate build() => initial;

  void set(AppGate gate) => state = gate;
}

const ready = GateReady(
  userId: 'u1',
  displayName: 'Meera K',
  email: 'meera@example.test',
  tenantId: 'ten-1',
  accountId: 'acc-1',
  accountName: 'Chennai',
);

const ringDeviceId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const devicePath = '/proxy/agency/push-devices/$ringDeviceId';

http.Response jsonReply(int status, Object? body) =>
    http.Response(body == null ? '' : jsonEncode(body), status, headers: {'content-type': 'application/json'});

/// The station as answering a ring sees it: what it was asked recorded, and whether it holds a
/// call set by the test ([holds], [holdsAfter]).
class FakeRingAnswerStation implements RingAnswerStation {
  FakeRingAnswerStation(this.async);
  final FakeAsync async;
  final List<InboundRingAcceptResponse> resumed = [];
  final List<String> calls = [];

  /// The calls the station holds now.
  final Set<String> holds = {};

  /// A call that shows on the station this long after it is asked about.
  ({String callId, Duration after})? holdsAfter;

  @override
  void hold(String callId) => calls.add('hold:$callId');

  @override
  void release(String callId) => calls.add('release:$callId');

  @override
  Future<void> resume(InboundRingAcceptResponse accept) async {
    calls.add('resume:${accept.call.id}');
    resumed.add(accept);
  }

  @override
  Future<bool> holdsCall(String callId, Duration within) async {
    calls.add('holdsCall:$callId');
    if (holds.contains(callId)) return true;
    final later = holdsAfter;
    if (later == null || later.callId != callId) {
      await Future<void>.delayed(within);
      return false;
    }
    if (later.after > within) {
      await Future<void>.delayed(within);
      return false;
    }
    await Future<void>.delayed(later.after);
    return true;
  }
}

/// Mode B's services in a container: the registration and the coordinator over a fake
/// channel, a mock server, a gate the test sets, and the station's resume recorded.
class RingHarness {
  RingHarness(this.async, {AppGate gate = const GateLoading(), List<Override> overrides = const []}) {
    container = ProviderContainer(
      overrides: [
        envProvider.overrideWithValue(testEnv),
        idTokenSourceProvider.overrideWithValue(FakeTokens()),
        clientIdentityProvider.overrideWithValue(ClientIdentity.test),
        httpClientProvider.overrideWithValue(MockClient(_handle)),
        requestScopeProvider.overrideWithValue(RequestScope()
          ..tenantId = 'ten-1'
          ..accountId = 'acc-1'),
        appGateProvider.overrideWith(() => RingGate(gate)),
        ringChannelProvider.overrideWithValue(channel),
        ringPlatformProvider.overrideWithValue(PushPlatform.android),
        ringLifecycleSourceProvider.overrideWithValue(lifecycle),
        stationDeviceIdsProvider.overrideWithValue(
          StationDeviceIds(() => MemoryStore({StationDeviceIds.storeKey: ringDeviceId})),
        ),
        ringAnswerStationProvider.overrideWithValue(station),
        ...ringOverrides,
        ...overrides,
      ],
    );
    routes['GET $devicePath'] = (_) => jsonReply(200, status);
    routes['PUT $devicePath'] = (_) => jsonReply(200, status);
    routes['PATCH $devicePath'] = (r) {
      final body = Map<String, Object?>.of(status);
      body['device'] = {...(status['device']! as Map<String, Object?>), 'ring_enabled': (r.body! as Map)['ring_enabled']};
      status = body;
      return jsonReply(200, status);
    };
    routes['DELETE $devicePath'] = (_) => jsonReply(204, null);
    routes['POST $devicePath/test-ring'] = (_) => jsonReply(202, {});
  }

  final FakeAsync async;
  late final ProviderContainer container;
  final channel = FakeRingChannel();
  final lifecycle = FakeLifecycle();
  late final station = FakeRingAnswerStation(async);
  List<InboundRingAcceptResponse> get resumed => station.resumed;
  final List<Sent> sent = [];
  final Map<String, Object? Function(Sent)> routes = {};

  /// What the device routes answer (the contract's sample: registered, opted in, this device).
  Map<String, Object?> status = pushSample('device_status_ringing');

  void start() {
    container.read(ringServicesProvider);
    async.flushMicrotasks();
  }

  RingGate get gate => container.read(appGateProvider.notifier) as RingGate;
  RingSettings get settings => container.read(ringRegistrationProvider);
  RingRegistration get registration => container.read(ringRegistrationProvider.notifier);

  void setGate(AppGate gate) {
    this.gate.set(gate);
    async.flushMicrotasks();
  }

  void emit(RingEvent event) {
    channel.emit(event);
    async.flushMicrotasks();
  }

  List<Sent> requests(String method, String path) => sent.where((r) => r.method == method && r.path == path).toList();

  Future<http.Response> _handle(http.Request request) async {
    final body = request.body.isEmpty ? null : jsonDecode(request.body);
    final s = Sent(request.method, request.url.path, request.headers, body);
    sent.add(s);
    final reply = routes['${request.method} ${request.url.path}'];
    if (reply == null) return jsonReply(404, {'error': 'Not Found', 'message': 'no route ${request.url.path}'});
    final out = reply(s);
    return out is http.Response ? out : jsonReply(200, out);
  }

  void dispose() {
    container.dispose();
    async.flushMicrotasks();
  }
}
