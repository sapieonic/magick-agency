import 'package:flutter/foundation.dart';

import '../api/api_client.dart';

/// The signed-in Firebase identity, as much of it as the app needs.
@immutable
class AuthUser {
  const AuthUser({
    required this.uid,
    this.email,
    this.displayName,
    this.emailVerified = false,
    this.usesPassword = false,
  });

  final String uid;
  final String? email;
  final String? displayName;
  final bool emailVerified;

  /// Signed in with an email and password (as opposed to Google).
  final bool usesPassword;

  @override
  bool operator ==(Object other) =>
      other is AuthUser &&
      other.uid == uid &&
      other.email == email &&
      other.displayName == displayName &&
      other.emailVerified == emailVerified &&
      other.usesPassword == usesPassword;

  @override
  int get hashCode => Object.hash(uid, email, displayName, emailVerified, usesPassword);

  @override
  String toString() => 'AuthUser($uid, verified=$emailVerified, password=$usesPassword)';
}

/// A sign-in step failed. [code] is Firebase's stable code without the
/// `auth/` prefix (`wrong-password`, `too-many-requests`, …), or one of the
/// app's own: [cancelled] when the person closed the Google sheet,
/// [notConfigured] for a build without Firebase, [unknown] otherwise.
/// Turn it into words with `authErrorMessage` (auth_copy.dart).
@immutable
class AuthFailure implements Exception {
  const AuthFailure(this.code, [this.detail]);

  static const cancelled = 'cancelled';
  static const notConfigured = 'not-configured';
  static const unknown = 'unknown';

  final String code;

  /// The SDK's own message, for the log only (it is written for developers).
  final String? detail;

  @override
  bool operator ==(Object other) => other is AuthFailure && other.code == code;

  @override
  int get hashCode => code.hashCode;

  @override
  String toString() => 'AuthFailure($code${detail == null ? '' : ': $detail'})';
}

/// Everything the app does with Firebase Auth (and Google), behind one
/// interface so the gate and the screens are tested with a fake.
///
/// Every method throws [AuthFailure] and nothing else, except [idToken]:
/// null when the sign-in is over, `ApiNetworkError` when a token could not be
/// minted (offline), never a reason to sign out.
abstract interface class AuthService implements IdTokenSource {
  /// The user Firebase restored from its own storage at start-up (null when
  /// nobody is signed in). Completes once Firebase has finished restoring.
  Future<AuthUser?> restoredUser();

  /// Sign-in and sign-out, including ones the app did not ask for (an account
  /// disabled in the Firebase console, a revoked refresh token).
  Stream<AuthUser?> authStateChanges();

  AuthUser? get currentUser;

  Future<AuthUser> signInWithEmail(String email, String password);

  /// Opens the system Google account sheet. [AuthFailure.cancelled] when the
  /// person closes it.
  Future<AuthUser> signInWithGoogle();

  /// Creates an email/password account (the invite flow only: there is no
  /// self sign-up).
  Future<AuthUser> createPasswordAccount(String email, String password);

  Future<void> sendPasswordReset(String email);

  Future<void> sendEmailVerification();

  /// Re-reads the user from Firebase (after they clicked the link), so
  /// [AuthUser.emailVerified] is current. Null when nobody is signed in.
  Future<AuthUser?> reloadUser();

  /// Signs out of Firebase and Google, so the next Google sign-in asks which
  /// account rather than silently reusing the last one.
  Future<void> signOut();
}

/// A build without Firebase config (a dev build with no `env/*.json` keys):
/// nobody is ever signed in and every sign-in says so.
class UnconfiguredAuthService implements AuthService {
  const UnconfiguredAuthService();

  static const _failure = AuthFailure(AuthFailure.notConfigured);

  @override
  Future<AuthUser?> restoredUser() async => null;

  @override
  Stream<AuthUser?> authStateChanges() => const Stream.empty();

  @override
  AuthUser? get currentUser => null;

  @override
  Future<String?> idToken({bool forceRefresh = false}) async => null;

  @override
  Future<AuthUser> signInWithEmail(String email, String password) => Future.error(_failure);

  @override
  Future<AuthUser> signInWithGoogle() => Future.error(_failure);

  @override
  Future<AuthUser> createPasswordAccount(String email, String password) => Future.error(_failure);

  @override
  Future<void> sendPasswordReset(String email) => Future.error(_failure);

  @override
  Future<void> sendEmailVerification() async {}

  @override
  Future<AuthUser?> reloadUser() async => null;

  @override
  Future<void> signOut() async {}
}
