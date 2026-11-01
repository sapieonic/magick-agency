import 'dart:async';
import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:magick_agency_agent/app/providers.dart';
import 'package:magick_agency_agent/core/api/api_client.dart';
import 'package:magick_agency_agent/core/env.dart';
import 'package:magick_agency_agent/core/lifecycle/app_lifecycle.dart';
import 'package:magick_agency_agent/core/softphone/softphone_host.dart';
import 'package:magick_agency_agent/core/station/station_controller.dart';
import 'package:magick_agency_agent/core/station/station_deps.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import '../audio/fake_audio_engine.dart';
import 'fake_transport.dart';
import 'fixtures.dart';
import 'memory_notes_store.dart';

const testEnv = Env(
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

class FakeTokens implements IdTokenSource {
  int forced = 0;
  bool signedOut = false;

  /// When set, every call throws it (Firebase failing to mint).
  Object? throws;

  @override
  Future<String?> idToken({bool forceRefresh = false}) async {
    if (forceRefresh) forced++;
    final e = throws;
    if (e != null) throw e;
    return signedOut ? null : 'tok';
  }
}

class FakeLifecycle implements AppLifecycleSource {
  bool foreground = true;
  void Function()? _hide;
  void Function()? _show;

  void hide() {
    foreground = false;
    _hide?.call();
  }

  void show() {
    foreground = true;
    _show?.call();
  }

  @override
  bool get isForeground => foreground;

  @override
  void attach({required void Function() onHide, required void Function() onShow}) {
    _hide = onHide;
    _show = onShow;
  }

  @override
  void detach() {
    _hide = null;
    _show = null;
  }
}

class FakeWakeLock implements WakeLock {
  final List<bool> calls = [];
  bool get on => calls.isNotEmpty && calls.last;

  @override
  Future<void> set(bool enabled) async => calls.add(enabled);
}

class FakeNotifier implements StationNotifier {
  final List<String> calls = [];

  @override
  Future<void> cancel() async => calls.add('cancel');

  @override
  Future<void> showPaused() async => calls.add('paused');

  @override
  Future<void> showWrapupDeadline(DateTime deadline) async => calls.add('wrapup:${deadline.toIso8601String()}');
}

class FakeNetwork implements NetworkMonitor {
  final controller = StreamController<List<ConnectivityResult>>.broadcast(sync: true);

  void close() => controller.close();

  @override
  Stream<List<ConnectivityResult>> changes() => controller.stream;
}

/// One recorded HTTP request.
class Sent {
  Sent(this.method, this.path, this.headers, this.body);
  final String method;
  final String path;
  final Map<String, String> headers;
  final Object? body;

  @override
  String toString() => '$method $path';
}

typedef Reply = FutureOr<http.Response> Function(Sent request);

http.Response json(int status, Object body) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Map<String, Object?> stateBody(String state, {String? breakReason, String? pending}) => {
      'campaign_id': 'camp-1',
      'session_id': 'sess-1',
      'kind': 'campaign',
      'state': state,
      'since': '2026-11-01T09:00:00.000Z',
      'pending_state': pending,
      'break_reason': breakReason,
    };

/// The station core in a container, with every outside dependency faked.
class App {
  App(this.async) {
    final clock = async.getClock(DateTime.utc(2026, 11, 1, 9));
    now = clock.now;
    container = ProviderContainer(
      overrides: [
        envProvider.overrideWithValue(testEnv),
        idTokenSourceProvider.overrideWithValue(tokens),
        httpClientProvider.overrideWithValue(MockClient(_handle)),
        requestScopeProvider.overrideWithValue(RequestScope()
          ..tenantId = 'ten-1'
          ..accountId = 'acc-1'),
        stationConnectorProvider.overrideWithValue(connector),
        networkMonitorProvider.overrideWithValue(network),
        notesStoreProvider.overrideWithValue(store),
        stationNotifierProvider.overrideWithValue(notifier),
        wakeLockProvider.overrideWithValue(wakeLock),
        appLifecycleSourceProvider.overrideWithValue(lifecycle),
        audioEngineProvider.overrideWithValue(engine),
        stationNowProvider.overrideWithValue(clock.now),
        stationFrameDecoderProvider.overrideWithValue((text) {
          decodes++;
          return StationFrame.decode(text);
        }),
        stationUnauthorizedSinkProvider.overrideWithValue(unauthorized.add),
        ...stationOverrides,
      ],
    );
    container.listen<StationView?>(stationControllerProvider, (_, v) => views.add(v));
    routes['POST /proxy/agency/sessions'] = (_) => json(200, bootstrapJson());
    routes['POST /proxy/agency/sessions/sess-1/station-token'] = (_) {
      mints++;
      return json(200, {
        'session_id': 'sess-1',
        'station_ws_url': '/proxy/agency/station?token=mint$mints',
        'expires_at': '2026-11-01T09:02:00.000Z',
      });
    };
    routes['POST /proxy/agency/softphone/sessions'] = (_) => json(201, softphoneSessionJson());
    routes['POST /proxy/agency/sessions/sess-sp/station-token'] = (_) {
      mints++;
      return json(200, {
        'session_id': 'sess-sp',
        'station_ws_url': '/proxy/agency/station?token=mint$mints',
        'expires_at': '2026-11-01T09:02:00.000Z',
      });
    };
  }

  final FakeAsync async;
  late final DateTime Function() now;
  late final ProviderContainer container;
  final tokens = FakeTokens();
  final connector = FakeConnector();
  final network = FakeNetwork();
  final store = MemoryNotesStore();
  final notifier = FakeNotifier();
  final wakeLock = FakeWakeLock();
  final lifecycle = FakeLifecycle();
  final engine = FakeAudioEngine();
  final List<StationView?> views = [];
  final List<Object> unauthorized = [];
  final List<Sent> sent = [];
  final Map<String, Reply> routes = {};
  int decodes = 0;
  int mints = 0;

  StationController get controller => container.read(stationControllerProvider.notifier);
  StationView? get view => container.read(stationControllerProvider);

  /// The soft phone's view of the hosted session, and the shell's signals.
  SoftphoneHostView? get hostView => container.read(softphoneHostViewProvider);
  StationSignals get signals => container.read(stationSignalsProvider);
  FakeTransport get socket => connector.last;

  List<Sent> requests(String method, String path) => sent.where((r) => r.method == method && r.path == path).toList();

  Future<http.Response> _handle(http.Request request) async {
    final body = request.body.isEmpty ? null : jsonDecode(request.body);
    final s = Sent(request.method, request.url.path, request.headers, body);
    sent.add(s);
    final reply = routes['${request.method} ${request.url.path}'];
    if (reply == null) return json(404, {'error': 'Not Found', 'message': 'no route ${request.url.path}'});
    return reply(s);
  }

  /// Runs [future] to completion on the fake clock.
  T run<T>(Future<T> future) {
    T? out;
    Object? error;
    var done = false;
    future.then((v) {
      out = v;
      done = true;
    }, onError: (Object e) {
      error = e;
      done = true;
    });
    async.flushMicrotasks();
    for (var i = 0; i < 20 && !done; i++) {
      async.elapse(const Duration(milliseconds: 1));
    }
    if (error != null) throw error!;
    if (!done) fail('future did not complete');
    return out as T;
  }

  /// Joins and opens the socket.
  StationStart start() {
    final r = run(controller.start('camp-1', campaignName: 'Renewals'));
    async.flushMicrotasks();
    return r;
  }

  /// Opens the soft phone (`POST /softphone/sessions`) and its socket.
  SoftphoneOpenResult openSoftphone() {
    final r = run(controller.openSoftphone());
    async.flushMicrotasks();
    return r;
  }

  /// A `manual_call` frame carrying [call] (a row from `manual_calls.dart`).
  void manualCallFrame(Map<String, Object?> call) => frame({'event': 'manual_call', 'call': call});

  void frame(Map<String, Object?> json) {
    socket.serverText(jsonEncode(json));
    async.flushMicrotasks();
  }

  void readyFrame(String state, {Map<String, Object?>? extra}) =>
      frame({'event': 'ready', 'session_id': 'sess-1', 'state': state, ...?extra});

  void agentStateFrame(String state, {String? breakReason, String? pending, String? pendingReason, String since = '2026-11-01T09:00:00.000Z'}) =>
      frame({
        'event': 'agent_state',
        'state': state,
        'since': since,
        'break_reason': ?breakReason,
        'pending_state': ?pending,
        'pending_break_reason': ?pendingReason,
      });

  Map<String, Object?> attemptJson(String id, {Map<String, Object?> context = const {'Customer Name': 'Asha Rao', 'City': 'Pune'}}) => {
        'attempt_id': id,
        'campaign_id': 'camp-1',
        'campaign_name': 'Renewals',
        'contact_id': 'c-$id',
        'phone_e164': '+919876543210',
        'caller_id': '+911234567890',
        'attempt_number': 1,
        'context': context,
        'prior_attempts': <Object?>[],
      };

  void reserved(String id) => frame({'event': 'reserved', 'attempt': attemptJson(id)});
  void bridged(String id, {String at = '2026-11-01T09:00:10.000Z'}) =>
      frame({'event': 'bridged', 'attempt_id': id, 'bridged_at': at});
  void releasedFrame(String id, {bool requiresDisposition = true, String reason = 'remote_hangup'}) => frame({
        'event': 'released',
        'attempt_id': id,
        'reason': reason,
        'requires_disposition': requiresDisposition,
        'message': 'The customer hung up.',
      });
  void wrapupFrame(String id, {String? endsAt = '2026-11-01T09:01:00.000Z'}) => frame({
        'event': 'wrapup',
        'wrapup': {
          'attempt_id': id,
          'ends_at': endsAt,
          'seconds_total': 30,
          'auto_return': true,
          'requires_disposition': true,
          'disposition_submitted': false,
        },
      });

  /// Available and on a bridged call for [id].
  void onCall(String id) {
    readyFrame('available');
    reserved(id);
    agentStateFrame('reserved');
    bridged(id);
    agentStateFrame('on_call');
  }

  /// A call that ended and is in wrap-up.
  void inWrapup(String id) {
    onCall(id);
    releasedFrame(id);
    agentStateFrame('wrapup');
    wrapupFrame(id);
  }

  void dispose() {
    container.dispose();
    network.close();
    async.flushMicrotasks();
  }
}
