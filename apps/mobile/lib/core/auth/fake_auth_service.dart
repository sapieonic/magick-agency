import 'dart:async';

import 'auth_service.dart';

/// An in-memory [AuthService] for tests and for running the screens without
/// Firebase. Accounts are registered with [addPasswordAccount]; Google returns
/// [googleUser]; [failNext] makes the next call fail with a given code.
class FakeAuthService implements AuthService {
  FakeAuthService({AuthUser? signedIn, this.googleUser, this.restoreDelay = Duration.zero}) : _user = signedIn;

  AuthUser? _user;

  /// What the Google sheet answers with; null behaves as a cancelled sheet.
  AuthUser? googleUser;

  /// How long [restoredUser] takes (Firebase reads its keychain/disk).
  Duration restoreDelay;

  final Map<String, ({String password, AuthUser user})> _accounts = {};
  final StreamController<AuthUser?> _changes = StreamController<AuthUser?>.broadcast();
  final List<String> _failures = [];

  /// Tokens handed out, in order (`forceRefresh` ones end in `!`).
  final List<String> tokensIssued = [];
  final List<String> resetEmailsSent = [];
  int verificationEmailsSent = 0;
  int signOuts = 0;

  /// Set to simulate the address being verified in the mail app.
  bool verifyOnReload = false;

  /// The ID token prefix; tests change it to tell sessions apart.
  String tokenPrefix = 'token';

  void addPasswordAccount(String email, String password, {String? uid, bool verified = true}) {
    _accounts[email.toLowerCase()] = (
      password: password,
      user: AuthUser(uid: uid ?? 'uid-$email', email: email, emailVerified: verified, usesPassword: true),
    );
  }

  /// The next call that can fail throws `AuthFailure(code)`.
  void failNext(String code) => _failures.add(code);

  void _maybeFail() {
    if (_failures.isNotEmpty) throw AuthFailure(_failures.removeAt(0));
  }

  void _set(AuthUser? user) {
    _user = user;
    _changes.add(user);
  }

  /// Simulates Firebase signing the user out on its own (a disabled account).
  void externalSignOut() => _set(null);

  /// Simulates a sign-in that did not come through this app's buttons.
  void externalSignIn(AuthUser user) => _set(user);

  @override
  Future<AuthUser?> restoredUser() async {
    if (restoreDelay > Duration.zero) await Future<void>.delayed(restoreDelay);
    return _user;
  }

  @override
  Stream<AuthUser?> authStateChanges() => _changes.stream;

  @override
  AuthUser? get currentUser => _user;

  @override
  Future<String?> idToken({bool forceRefresh = false}) async {
    final u = _user;
    if (u == null) return null;
    final t = '$tokenPrefix-${u.uid}${forceRefresh ? '!' : ''}';
    tokensIssued.add(t);
    return t;
  }

  @override
  Future<AuthUser> signInWithEmail(String email, String password) async {
    _maybeFail();
    final account = _accounts[email.trim().toLowerCase()];
    if (account == null) throw const AuthFailure('user-not-found');
    if (account.password != password) throw const AuthFailure('wrong-password');
    _set(account.user);
    return account.user;
  }

  @override
  Future<AuthUser> signInWithGoogle() async {
    _maybeFail();
    final g = googleUser;
    if (g == null) throw const AuthFailure(AuthFailure.cancelled);
    _set(g);
    return g;
  }

  @override
  Future<AuthUser> createPasswordAccount(String email, String password) async {
    _maybeFail();
    if (_accounts.containsKey(email.trim().toLowerCase())) throw const AuthFailure('email-already-in-use');
    addPasswordAccount(email, password, verified: false);
    final user = _accounts[email.trim().toLowerCase()]!.user;
    _set(user);
    return user;
  }

  @override
  Future<void> sendPasswordReset(String email) async {
    _maybeFail();
    resetEmailsSent.add(email);
  }

  @override
  Future<void> sendEmailVerification() async {
    _maybeFail();
    verificationEmailsSent++;
  }

  @override
  Future<AuthUser?> reloadUser() async {
    _maybeFail();
    final u = _user;
    if (u == null) return null;
    if (verifyOnReload && !u.emailVerified) {
      _user = AuthUser(uid: u.uid, email: u.email, displayName: u.displayName, emailVerified: true, usesPassword: u.usesPassword);
    }
    return _user;
  }

  @override
  Future<void> signOut() async {
    signOuts++;
    _set(null);
  }

  Future<void> dispose() => _changes.close();
}
