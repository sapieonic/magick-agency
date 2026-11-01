import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../core/api/api_client.dart';
import '../core/api/client_identity.dart';
import '../core/env.dart';

/// App-wide singletons. `main.dart` overrides [envProvider],
/// [clientIdentityProvider] and [idTokenSourceProvider] with real values;
/// tests override them with fakes.

final envProvider = Provider<Env>((ref) => Env.fromDefines());

final clientIdentityProvider = Provider<ClientIdentity>((ref) => ClientIdentity.test);

/// Supplied by the auth layer (Firebase in the app, a fake in tests).
final idTokenSourceProvider = Provider<IdTokenSource>(
  (ref) => throw UnimplementedError('idTokenSourceProvider must be overridden'),
);

/// One keep-alive HTTP client for the process: connection reuse matters on
/// mobile networks (a TLS handshake per request costs 2–3 round trips).
final httpClientProvider = Provider<http.Client>((ref) {
  final client = http.Client();
  ref.onDispose(client.close);
  return client;
});

/// The tenant/account the agent is working in; set by the account picker.
final requestScopeProvider = Provider<RequestScope>((ref) => RequestScope());

final apiClientProvider = Provider<ApiClient>(
  (ref) => ApiClient(
    http: ref.watch(httpClientProvider),
    env: ref.watch(envProvider),
    tokens: ref.watch(idTokenSourceProvider),
    identity: ref.watch(clientIdentityProvider),
    scope: ref.watch(requestScopeProvider),
  ),
);
