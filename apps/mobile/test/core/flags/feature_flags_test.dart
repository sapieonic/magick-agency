import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:magick_agency_agent/app/providers.dart';
import 'package:magick_agency_agent/core/api/api_client.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/flags/feature_flags.dart';

import '../../features/performance/support.dart' show RecordingGate, testWorkspaceProvider;
import '../station/controller_harness.dart' show FakeLifecycle, FakeTokens, testEnv;

/// The client flag map: read per workspace from `GET /feature-flags`, and
/// fail closed while it loads or when it cannot be read.
void main() {
  late List<String> paths;
  late Map<String, String> lastHeaders;
  late FutureOr<http.Response> Function() reply;
  late List<FakeLifecycle> lifecycles;

  ProviderContainer make() {
    paths = [];
    lifecycles = [];
    final c = ProviderContainer(
      overrides: [
        featureFlagsLifecycleProvider.overrideWithValue(() {
          final l = FakeLifecycle();
          lifecycles.add(l);
          return l;
        }),
        envProvider.overrideWithValue(testEnv),
        idTokenSourceProvider.overrideWithValue(FakeTokens()),
        requestScopeProvider.overrideWithValue(RequestScope()
          ..tenantId = 't1'
          ..accountId = 'a1'),
        httpClientProvider.overrideWithValue(MockClient((r) async {
          paths.add(r.url.path);
          lastHeaders = r.headers;
          return reply();
        })),
        appGateProvider.overrideWith(RecordingGate.new),
        agentWorkspaceProvider.overrideWith((ref) => ref.watch(testWorkspaceProvider)),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  http.Response ok(Map<String, Object?> body) =>
      http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});

  Future<bool> settle(ProviderContainer c) async {
    final sub = c.listen(contactAssignmentEnabledProvider, (_, _) {});
    addTearDown(sub.close);
    for (var i = 0; i < 10; i++) {
      await pumpEventQueue();
    }
    return c.read(contactAssignmentEnabledProvider);
  }

  test('on when the account’s map says so, read from /feature-flags in the account’s scope', () async {
    reply = () => ok({'agency_dialer_enabled': true, 'agency_contact_assignment_enabled': true});
    final c = make();
    expect(c.read(contactAssignmentEnabledProvider), isFalse, reason: 'off while loading');
    expect(await settle(c), isTrue);
    expect(paths, ['/feature-flags']);
    expect(lastHeaders.keys.map((k) => k.toLowerCase()), contains('x-account-id'));
  });

  test('off when absent from the map, and when the map cannot be read', () async {
    reply = () => ok({'agency_dialer_enabled': true});
    expect(await settle(make()), isFalse);
    reply = () => http.Response('{"error":"Forbidden","message":"no"}', 403, headers: {'content-type': 'application/json'});
    expect(await settle(make()), isFalse);
  });

  test('a failed read does not stick: the next return to the app reads it again', () async {
    reply = () => throw http.ClientException('offline');
    final c = make();
    expect(await settle(c), isFalse);
    expect(paths, hasLength(1));
    expect(lifecycles, hasLength(1));

    // Leaving and coming back while it still fails: asked again, still off.
    lifecycles.single
      ..hide()
      ..show();
    expect(await settle(c), isFalse);
    expect(paths, hasLength(2));

    reply = () => ok({'agency_contact_assignment_enabled': true});
    lifecycles.last
      ..hide()
      ..show();
    expect(await settle(c), isTrue);
    expect(paths, hasLength(3));

    // A map that was read stays: returning to the app reads nothing more.
    for (final l in lifecycles) {
      l.show();
    }
    expect(await settle(c), isTrue);
    expect(paths, hasLength(3));
  });

  test('nobody signed in to an account: off, and nothing is asked', () async {
    reply = () => ok({'agency_contact_assignment_enabled': true});
    final c = make();
    c.read(testWorkspaceProvider.notifier).set(null);
    expect(await settle(c), isFalse);
    expect(paths, isEmpty);
  });

  test('another workspace reads its own map', () async {
    reply = () => ok({'agency_contact_assignment_enabled': true});
    final c = make();
    expect(await settle(c), isTrue);
    reply = () => ok({'agency_contact_assignment_enabled': false});
    c.read(testWorkspaceProvider.notifier).set('u2:t1:a2');
    expect(await settle(c), isFalse);
    expect(paths, hasLength(2));
  });
}
