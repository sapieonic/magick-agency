import 'dart:async';
import 'dart:io' show Platform;

import 'package:firebase_auth/firebase_auth.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../api/api_error.dart';
import '../env.dart';
import '../telemetry/log.dart';
import 'auth_service.dart';
import 'firebase_token_source.dart';

/// [AuthService] on Firebase Auth, with Google through `google_sign_in` 7
/// (the system account sheet, then its ID token exchanged for a Firebase
/// credential: the same Firebase identity the console's popup produces).
class FirebaseAuthService implements AuthService {
  FirebaseAuthService(this._auth, this._google, this._env);

  final FirebaseAuth _auth;
  final GoogleSignIn _google;
  final Env _env;

  static final _log = Log('auth');

  // `GoogleSignIn.initialize` must run exactly once, before any other call.
  Future<void>? _googleReady;

  Future<void> _ensureGoogle() => _googleReady ??= _google
      .initialize(
        // iOS needs its own OAuth client; Android reads the server client id
        // to mint an ID token Firebase accepts.
        clientId: Platform.isIOS && _env.googleIosClientId.isNotEmpty ? _env.googleIosClientId : null,
        serverClientId: _env.googleServerClientId.isEmpty ? null : _env.googleServerClientId,
      )
      .catchError((Object e) {
        _googleReady = null; // let the next tap try again
        throw e;
      });

  static AuthUser? _map(User? u) {
    if (u == null) return null;
    return AuthUser(
      uid: u.uid,
      email: u.email,
      displayName: u.displayName,
      emailVerified: u.emailVerified,
      usesPassword: u.providerData.any((p) => p.providerId == 'password'),
    );
  }

  /// Runs a Firebase call, turning its exceptions into [AuthFailure].
  Future<T> _guard<T>(String what, Future<T> Function() body) async {
    try {
      return await body();
    } on AuthFailure {
      rethrow;
    } on FirebaseAuthException catch (e) {
      _log.warn('$what failed', {'code': e.code});
      throw AuthFailure(e.code, e.message);
    } on GoogleSignInException catch (e) {
      _log.warn('$what failed', {'google': e.code.name});
      throw AuthFailure(
        switch (e.code) {
          GoogleSignInExceptionCode.canceled => AuthFailure.cancelled,
          GoogleSignInExceptionCode.interrupted => AuthFailure.cancelled,
          GoogleSignInExceptionCode.clientConfigurationError ||
          GoogleSignInExceptionCode.providerConfigurationError =>
            'google-config',
          GoogleSignInExceptionCode.uiUnavailable => 'google-unavailable',
          _ => AuthFailure.unknown,
        },
        e.description,
      );
    } on FirebaseException catch (e) {
      _log.warn('$what failed', {'code': e.code});
      throw AuthFailure(e.code, e.message);
    } catch (e) {
      _log.warn('$what failed', {'error': e.runtimeType.toString()});
      throw AuthFailure(AuthFailure.unknown, e.toString());
    }
  }

  @override
  Future<AuthUser?> restoredUser() async => _map(await _auth.authStateChanges().first);

  @override
  Stream<AuthUser?> authStateChanges() => _auth.authStateChanges().map(_map);

  @override
  AuthUser? get currentUser => _map(_auth.currentUser);

  /// Null when nobody is signed in or Firebase says the sign-in itself is
  /// over ([FirebaseIdTokenSource.signInEndedCodes]): the gate signs out.
  /// Any other failure (offline, a stalled refresh) throws [ApiNetworkError],
  /// which start-up retries with the splash's offline notice: losing the
  /// network must never cost the agent their sign-in.
  @override
  Future<String?> idToken({bool forceRefresh = false}) async {
    try {
      return await FirebaseIdTokenSource(_auth).idToken(forceRefresh: forceRefresh);
    } catch (e) {
      _log.warn('ID token unavailable', {'error': e is FirebaseAuthException ? e.code : e.runtimeType.toString()});
      throw ApiNetworkError(e);
    }
  }

  @override
  Future<AuthUser> signInWithEmail(String email, String password) => _guard('Email sign-in', () async {
        final cred = await _auth.signInWithEmailAndPassword(email: email.trim(), password: password);
        return _map(cred.user)!;
      });

  @override
  Future<AuthUser> signInWithGoogle() => _guard('Google sign-in', () async {
        await _ensureGoogle();
        final account = await _google.authenticate();
        final idToken = account.authentication.idToken;
        if (idToken == null) throw const AuthFailure('google-no-token');
        final cred = await _auth.signInWithCredential(GoogleAuthProvider.credential(idToken: idToken));
        return _map(cred.user)!;
      });

  @override
  Future<AuthUser> createPasswordAccount(String email, String password) => _guard('Create account', () async {
        final cred = await _auth.createUserWithEmailAndPassword(email: email.trim(), password: password);
        return _map(cred.user)!;
      });

  @override
  Future<void> sendPasswordReset(String email) =>
      _guard('Password reset', () => _auth.sendPasswordResetEmail(email: email.trim()));

  @override
  Future<void> sendEmailVerification() => _guard('Verification email', () async {
        await _auth.currentUser?.sendEmailVerification();
      });

  @override
  Future<AuthUser?> reloadUser() => _guard('Reload user', () async {
        final user = _auth.currentUser;
        if (user == null) return null;
        await user.reload();
        return _map(_auth.currentUser);
      });

  @override
  Future<void> signOut() async {
    // Google first and best effort: a failure there must not keep the
    // Firebase session (the one the API trusts) alive.
    // Initialised here too: after a restart the Google session outlives the
    // process, and leaving it would make the next sheet reuse that account.
    try {
      await _ensureGoogle();
      await _google.signOut();
    } catch (e) {
      _log.warn('Google sign-out failed', {'error': e.runtimeType.toString()});
    }
    await _guard('Sign-out', _auth.signOut);
  }
}
