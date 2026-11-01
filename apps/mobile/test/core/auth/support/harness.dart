import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:magick_agency_agent/app/providers.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/api/client_identity.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/auth/auth_providers.dart';
import 'package:magick_agency_agent/core/auth/auth_service.dart';
import 'package:magick_agency_agent/core/auth/fake_auth_service.dart';
import 'package:magick_agency_agent/core/env.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';

/// Shared fakes for the getting-in tests: a scripted HTTP server, a fake
/// Firebase, an in-memory preference store and settable station signals.

const testEnv = Env(
  flavor: 'test',
  apiOrigin: 'https://agency.test',
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

const testIdentity = ClientIdentity(version: '1.4.0', build: '42', platform: 'android', osVersion: '14', model: 'Pixel 8');

http.Response jsonResponse(Object? body, {int status = 200}) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

typedef Handler = FutureOr<http.Response> Function(http.Request request);

/// Routes by `METHOD /path`; records every request. An unknown route is a 404.
class FakeServer {
  final List<http.Request> requests = [];
  final Map<String, Handler> _routes = {};

  void on(String method, String path, Handler handler) => _routes['$method $path'] = handler;

  void json(String method, String path, Object? body, {int status = 200}) =>
      on(method, path, (_) => jsonResponse(body, status: status));

  void offline(String method, String path) => on(method, path, (_) => throw http.ClientException('offline'));

  List<http.Request> calls(String method, String path) =>
      requests.where((r) => r.method == method && r.url.path == path).toList();

  late final MockClient client = MockClient((request) async {
    requests.add(request);
    final handler = _routes['${request.method} ${request.url.path}'];
    if (handler == null) return jsonResponse({'error': 'Not Found', 'message': 'no route'}, status: 404);
    return handler(request);
  });

  /// The happy path: a current build, a session, and [accounts] per tenant.
  void standard({
    String minSupported = '1.0.0',
    List<Map<String, Object?>>? tenants,
    List<Map<String, Object?>>? memberships,
    Map<String, List<Map<String, Object?>>>? accounts,
  }) {
    json('GET', '/client-config', clientConfigJson(minSupported: minSupported));
    final t = tenants ?? [tenantJson('t1', 'Acme Collections')];
    final m = memberships ?? [membershipJson('t1', accountId: 'a1')];
    json('POST', '/auth/session', sessionJson(tenants: t, memberships: m));
    final byTenant = accounts ?? {'t1': [accountJson('a1', 'Chennai', 't1')]};
    on('GET', '/accounts/mine', (req) => jsonResponse({'accounts': byTenant[req.headers['x-tenant-id']] ?? []}));
  }
}

Map<String, Object?> clientConfigJson({String minSupported = '1.0.0', String latest = '9.9.9'}) => {
      'mobile': {
        'min_supported': minSupported,
        'latest': latest,
        'store_urls': {'ios': 'https://apps.apple.com/app/id1', 'android': 'https://play.google.com/store/apps/details?id=x'},
      },
    };

const _ts = '2026-10-01T10:00:00.000Z';

Map<String, Object?> userJson({String id = 'u1', String email = 'meera.k@acmecollect.in', String? name = 'Meera K'}) => {
      'id': id,
      'firebase_uid': 'fb-$id',
      'email': email,
      'display_name': name,
      'avatar_url': null,
      'status': 'active',
      'created_at': _ts,
      'updated_at': _ts,
    };

Map<String, Object?> tenantJson(String id, String name) => {
      'id': id,
      'name': name,
      'slug': id,
      'settings': <String, Object?>{},
      'status': 'active',
      'created_at': _ts,
      'updated_at': _ts,
    };

Map<String, Object?> membershipJson(String tenantId, {String? accountId, String role = 'agent', String status = 'active'}) => {
      'id': 'm-$tenantId-${accountId ?? 'all'}',
      'user_id': 'u1',
      'tenant_id': tenantId,
      'account_id': accountId,
      'role': role,
      'status': status,
      'invited_by': null,
      'created_at': _ts,
      'updated_at': _ts,
    };

Map<String, Object?> accountJson(String id, String name, String tenantId) => {'id': id, 'name': name, 'tenant_id': tenantId};

Map<String, Object?> sessionJson({
  required List<Map<String, Object?>> tenants,
  required List<Map<String, Object?>> memberships,
  Map<String, Object?>? user,
}) =>
    {
      'user': user ?? userJson(),
      'tenants': tenants,
      'memberships': memberships,
      'settings': <String, Object?>{},
      'is_new': false,
    };

Map<String, Object?> inviteJson({
  String email = 'meera.k@acmecollect.in',
  String role = 'agent',
  String? tenantName = 'Acme Collections',
  String? inviterName = 'Rahul Menon',
  bool requiresMatchingAddress = false,
}) =>
    {
      'status': 'pending',
      'invite': {
        'email': email,
        'role': role,
        'tenant_name': tenantName,
        'inviter_name': inviterName,
        'product_name': 'Magick Agency',
        'expires_at': '2026-11-07T13:00:00.000Z',
        'requires_matching_address': requiresMatchingAddress,
      },
    };

/// Station signals the test can change.
class TestSignals extends Notifier<StationSignals> {
  @override
  StationSignals build() => const StationSignals();
  void set(StationSignals s) => state = s;
}

final testSignalsProvider = NotifierProvider<TestSignals, StationSignals>(TestSignals.new);

const meera = AuthUser(uid: 'fb-u1', email: 'meera.k@acmecollect.in', emailVerified: true, usesPassword: true);

/// Everything a test may want to reach.
class Harness {
  Harness({FakeAuthService? auth, FakeServer? server, MemoryStore? store})
      : auth = auth ?? FakeAuthService(),
        server = server ?? (FakeServer()..standard()),
        store = store ?? MemoryStore();

  final FakeAuthService auth;
  final FakeServer server;
  final MemoryStore store;

  List<Override> get overrides => [
        envProvider.overrideWithValue(testEnv),
        clientIdentityProvider.overrideWithValue(testIdentity),
        idTokenSourceProvider.overrideWithValue(auth),
        httpClientProvider.overrideWithValue(server.client),
        authServiceProvider.overrideWithValue(auth),
        keyValueStoreProvider.overrideWithValue(store),
        stationSignalsProvider.overrideWith((ref) => ref.watch(testSignalsProvider)),
      ];

  /// [extra] adds overrides (a recording station teardown, say).
  ProviderContainer container({List<Override> extra = const []}) {
    final c = ProviderContainer.test(overrides: [...overrides, ...extra]);
    return c;
  }
}

/// Starts the gate and lets every queued future run.
Future<AppGate> startGate(ProviderContainer c) async {
  // Listened, as the router listens in the app: an unlistened provider's own
  // subscriptions are paused.
  c.listen(appGateProvider, (_, _) {});
  await settle();
  return c.read(appGateProvider);
}

Future<void> settle() => pumpEventQueue(times: 50);

/// A screen inside the app theme, a router (so `context.go/push` work) and a
/// scope on [container]. [extraRoutes] stand in for the other screens; each
/// renders its location so tests can assert where navigation went.
Future<GoRouter> pumpScreen(
  WidgetTester tester,
  ProviderContainer container,
  Widget screen, {
  String path = '/screen',
  List<String> extraRoutes = const ['/home', '/sign-in', '/preflight/:campaignId', '/home/station/:campaignId'],
}) async {
  final router = GoRouter(
    initialLocation: path,
    routes: [
      GoRoute(path: path, builder: (_, _) => screen),
      for (final r in extraRoutes)
        GoRoute(path: r, builder: (_, s) => Scaffold(body: Text('at ${s.uri}'))),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: buildTheme(AppTokens.dark, Brightness.dark),
        routerConfig: router,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return router;
}

/// Scrolls [finder] into view, then taps it (the test surface is a small
/// phone; lower buttons start below the fold).
Future<void> tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
}
