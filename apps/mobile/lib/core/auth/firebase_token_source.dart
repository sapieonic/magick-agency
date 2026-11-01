import 'package:firebase_auth/firebase_auth.dart';

import '../api/api_client.dart';

/// ID tokens from the signed-in Firebase user. Firebase caches a token for
/// about an hour and refreshes it itself; `forceRefresh` is for the one retry
/// after a 401 and for refreshing ahead of a station reconnect.
class FirebaseIdTokenSource implements IdTokenSource {
  FirebaseIdTokenSource(this._auth);

  final FirebaseAuth _auth;

  @override
  Future<String?> idToken({bool forceRefresh = false}) async {
    final user = _auth.currentUser;
    if (user == null) return null;
    return user.getIdToken(forceRefresh);
  }
}

/// Used when the build has no Firebase config (a dev build without one):
/// every authenticated call answers 401, so the app sits on sign-in.
class NoIdTokenSource implements IdTokenSource {
  const NoIdTokenSource();

  @override
  Future<String?> idToken({bool forceRefresh = false}) async => null;
}
