import 'package:firebase_auth/firebase_auth.dart';

import '../api/api_client.dart';

/// ID tokens from the signed-in Firebase user. Firebase caches a token for
/// about an hour and refreshes it itself; `forceRefresh` is for the one retry
/// after a 401 and for refreshing ahead of a station reconnect.
class FirebaseIdTokenSource implements IdTokenSource {
  FirebaseIdTokenSource(this._auth);

  final FirebaseAuth _auth;

  /// Firebase's word that the sign-in itself is over, not that the network failed: the
  /// user was disabled or deleted, or the refresh token was revoked. Read as "signed
  /// out" (null, so the API layer answers `ApiUnauthorized` and the gate signs out
  /// once no call is live) rather than retried as a network error for ever.
  static const signInEndedCodes = {'user-disabled', 'user-not-found', 'user-token-expired', 'invalid-user-token'};

  @override
  Future<String?> idToken({bool forceRefresh = false}) async {
    final user = _auth.currentUser;
    if (user == null) return null;
    try {
      return await user.getIdToken(forceRefresh);
    } on FirebaseAuthException catch (e) {
      if (signInEndedCodes.contains(e.code)) return null;
      rethrow;
    }
  }
}

/// Used when the build has no Firebase config (a dev build without one):
/// every authenticated call answers 401, so the app sits on sign-in.
class NoIdTokenSource implements IdTokenSource {
  const NoIdTokenSource();

  @override
  Future<String?> idToken({bool forceRefresh = false}) async => null;
}
