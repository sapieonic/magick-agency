import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../api/api_client.dart';
import '../api/api_error.dart';

/// `POST /invites/:token/claim` refused with a `{status}` body (404/409):
/// the invitation is gone, or this account cannot claim it.
class InviteClaimRefused implements Exception {
  const InviteClaimRefused(this.refusal);
  final InviteClaimRefusal refusal;

  @override
  String toString() => 'InviteClaimRefused(${refusal.statusRaw})';
}

/// The calls that get the agent in: the version gate, the session, the
/// account list, and the invite. Every response is decoded to `agency_wire`
/// types here so the gate and the screens deal in values, not JSON.
class SessionApi {
  SessionApi({required this._api, required this._scopedClient});

  final ApiClient _api;
  final ApiClient Function(RequestScope scope) _scopedClient;

  static Map<String, Object?> _object(Object? body, String path) {
    if (body is Map<String, Object?>) return body;
    throw ApiDecodeError(path, const FormatException('expected a JSON object'));
  }

  static T _decode<T>(String path, Object? body, T Function(Map<String, Object?>) fromJson) {
    try {
      return fromJson(_object(body, path));
    } on FormatException catch (e) {
      throw ApiDecodeError(path, e);
    }
  }

  /// `GET /client-config` (public). Kept short: start-up waits for it.
  Future<ClientConfig> clientConfig({Duration timeout = const Duration(seconds: 5)}) async {
    const path = '/client-config';
    return _decode(path, await _api.getPublic(path, timeout: timeout), ClientConfig.fromJson);
  }

  /// `POST /auth/session`. The ID token is the credential (in the body), so
  /// no bearer and no tenant scope. 403 `no_membership` / `email_unverified`
  /// arrive as [ApiHttpError] with that `code`.
  Future<SessionResponse> createSession(String idToken) async {
    const path = '/auth/session';
    final body = await _api.post(path, body: SessionRequest(idToken: idToken).toJson(), scoped: false, authenticated: false);
    return _decode(path, body, SessionResponse.fromJson);
  }

  /// `GET /accounts/mine` for one tenant. Uses its own scope, so listing the
  /// accounts of another workspace never touches the app's live
  /// [RequestScope] (a request in flight keeps the headers it started with).
  Future<List<AccountSummary>> myAccounts(String tenantId) async {
    const path = '/accounts/mine';
    final client = _scopedClient(RequestScope()..tenantId = tenantId);
    return _decode(path, await client.get(path), MyAccountsResponse.fromJson).accounts;
  }

  /// `GET /invites/:token` (public). A 404 is an answer (`not_found`), not an
  /// error.
  Future<InviteLookup> lookupInvite(String token) async {
    final path = '/invites/${Uri.encodeComponent(token)}';
    try {
      return _decode<InviteLookup>(path, await _api.getPublic(path), InviteLookup.fromJson);
    } on ApiHttpError catch (e) {
      if (e.status == 404 && e.body['status'] is String) return _decode<InviteLookup>(path, e.body, InviteLookup.fromJson);
      rethrow;
    }
  }

  /// `POST /invites/:token/claim`. Answers a session like `POST /auth/session`.
  /// Throws [InviteClaimRefused] for a `{status}` refusal.
  Future<SessionResponse> claimInvite(String token, String idToken) async {
    final path = '/invites/${Uri.encodeComponent(token)}/claim';
    try {
      final body = await _api.post(
        path,
        body: ClaimInviteRequest(idToken: idToken).toJson(),
        scoped: false,
        authenticated: false,
      );
      return _decode<SessionResponse>(path, body, SessionResponse.fromJson);
    } on ApiHttpError catch (e) {
      if ((e.status == 404 || e.status == 409) && e.body['status'] is String) {
        throw InviteClaimRefused(InviteClaimRefusal.fromJson(e.body));
      }
      rethrow;
    }
  }
}

final sessionApiProvider = Provider<SessionApi>((ref) {
  final http = ref.watch(httpClientProvider);
  final env = ref.watch(envProvider);
  final tokens = ref.watch(idTokenSourceProvider);
  final identity = ref.watch(clientIdentityProvider);
  return SessionApi(
    api: ref.watch(apiClientProvider),
    scopedClient: (scope) => ApiClient(http: http, env: env, tokens: tokens, identity: identity, scope: scope),
  );
});
