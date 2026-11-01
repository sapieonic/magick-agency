import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:collection/collection.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../api/api_client.dart';
import '../api/api_error.dart';
import '../session/account_choice.dart';
import '../session/session_api.dart';
import '../session/session_store.dart';
import '../station/station_signals.dart';
import '../telemetry/log.dart';
import 'auth_providers.dart';
import 'auth_service.dart';

/// Where the agent stands before any agency screen can open. The router
/// redirects on this and nothing else, so every entry path (cold start, an
/// invite link, a 401, an account switch) resolves the same way.
///
/// The names [AppGate], its subtypes and [appGateProvider] are a fixed
/// interface: `lib/app/router.dart` depends on them. Every state has value
/// equality, so setting an equal state does not re-run the router.
sealed class AppGate {
  const AppGate();
}

/// Start-up: reading the version gate, Firebase's persisted user and the session.
@immutable
final class GateLoading extends AppGate {
  const GateLoading({this.notice});

  /// Set while start-up cannot reach the server and is retrying on its own:
  /// what to tell the agent (the splash shows it).
  final String? notice;

  @override
  bool operator ==(Object other) => other is GateLoading && other.notice == notice;
  @override
  int get hashCode => Object.hash(GateLoading, notice);
}

/// The server's `GET /client-config` says this build is below `min_supported`.
@immutable
final class GateUpdateRequired extends AppGate {
  const GateUpdateRequired({required this.storeUrl, required this.minSupported});
  final String? storeUrl;
  final String minSupported;

  @override
  bool operator ==(Object other) =>
      other is GateUpdateRequired && other.storeUrl == storeUrl && other.minSupported == minSupported;
  @override
  int get hashCode => Object.hash(GateUpdateRequired, storeUrl, minSupported);
}

@immutable
final class GateSignedOut extends AppGate {
  const GateSignedOut({this.notice});

  /// Why the agent was signed out when it was not their choice
  /// ("Your sign-in has expired…"); the sign-in screen shows it.
  final String? notice;

  @override
  bool operator ==(Object other) => other is GateSignedOut && other.notice == notice;
  @override
  int get hashCode => Object.hash(GateSignedOut, notice);
}

/// Signed in to Firebase with an address that is not verified yet.
@immutable
final class GateEmailUnverified extends AppGate {
  const GateEmailUnverified({required this.email});
  final String email;

  @override
  bool operator ==(Object other) => other is GateEmailUnverified && other.email == email;
  @override
  int get hashCode => Object.hash(GateEmailUnverified, email);
}

/// Firebase knows the person, the agency does not (`403 no_membership`).
@immutable
final class GateNoMembership extends AppGate {
  const GateNoMembership({required this.email});
  final String? email;

  @override
  bool operator ==(Object other) => other is GateNoMembership && other.email == email;
  @override
  int get hashCode => Object.hash(GateNoMembership, email);
}

/// Signed in, but more than one account and none chosen yet ([choices]), or
/// no account to work in at all ([choices] empty).
@immutable
final class GateNeedsAccount extends AppGate {
  const GateNeedsAccount({this.choices = const []});
  final List<AccountChoice> choices;

  @override
  bool operator ==(Object other) => other is GateNeedsAccount && const ListEquality<AccountChoice>().equals(other.choices, choices);
  @override
  int get hashCode => Object.hash(GateNeedsAccount, Object.hashAll(choices));
}

/// Ready: [tenantId]/[accountId] are set on the request scope.
@immutable
final class GateReady extends AppGate {
  const GateReady({
    required this.userId,
    required this.displayName,
    required this.email,
    required this.tenantId,
    required this.accountId,
    required this.accountName,
    this.tenantName = '',
    this.accounts = const [],
  });

  final String userId;
  final String displayName;
  final String? email;
  final String tenantId;
  final String accountId;
  final String accountName;
  final String tenantName;

  /// Every account the agent can switch to (this one included).
  final List<AccountChoice> accounts;

  AccountChoice get current =>
      AccountChoice(tenantId: tenantId, tenantName: tenantName, accountId: accountId, accountName: accountName);

  @override
  bool operator ==(Object other) =>
      other is GateReady &&
      other.userId == userId &&
      other.displayName == displayName &&
      other.email == email &&
      other.tenantId == tenantId &&
      other.accountId == accountId &&
      other.accountName == accountName &&
      other.tenantName == tenantName &&
      const ListEquality<AccountChoice>().equals(other.accounts, accounts);

  @override
  int get hashCode => Object.hash(userId, displayName, email, tenantId, accountId, accountName, tenantName, accounts.length);
}

/// How an invited agent gets a Firebase credential on the invite page.
sealed class InviteCredentialRequest {
  const InviteCredentialRequest();
}

final class InviteViaGoogle extends InviteCredentialRequest {
  const InviteViaGoogle();
}

/// A new email/password account at the invited address.
final class InviteCreatePassword extends InviteCredentialRequest {
  const InviteCreatePassword(this.email, this.password);
  final String email;
  final String password;
}

/// The invited address already has a password (invited to a second workspace).
final class InviteSignInPassword extends InviteCredentialRequest {
  const InviteSignInPassword(this.email, this.password);
  final String email;
  final String password;
}

/// Shown on the sign-in screen after the server stopped accepting the sign-in.
const sessionExpiredNotice = 'Your sign-in has expired. Please sign in again.';

/// The gate's state machine.
///
/// Start-up runs the version check (`GET /client-config`) and Firebase's
/// restore together; a failed version read is logged and ignored, never a
/// reason to stop. Then `POST /auth/session` → `GET /accounts/mine` (per
/// workspace) → the account pick → [RequestScope] → [GateReady].
///
/// Sign-outs the agent did not ask for (a 401 anywhere, Firebase dropping the
/// user) are held while a call or its wrap-up is on screen and happen as soon
/// as it ends: cutting a customer off to show a sign-in form helps nobody.
///
/// The invite page holds the gate while it gets a credential, so that
/// credential is never turned into a session by the auth listener: the claim
/// is what creates the session ([claimInvite]).
class AppGateNotifier extends Notifier<AppGate> {
  static final _log = Log('gate');

  StreamSubscription<AuthUser?>? _authSub;
  ProviderSubscription<StationSignals>? _signalsSub;
  Timer? _retryTimer;

  /// Re-checks a held sign-out on a clock: a call that went live unseen (a
  /// dial the app was never told of) can end unseen too, and then no signal
  /// ever changes.
  Timer? _deferredRecheck;
  int _retries = 0;

  /// Bumped by every resolution; an async step whose run is stale stops.
  int _run = 0;

  /// The Firebase uid resolved or being resolved; null when signed out.
  String? _uid;
  bool _starting = true;
  bool _updateRequired = false;
  int _manualAuth = 0;
  bool _holdingInvite = false;

  /// A sign-out waiting for the call to end ('' = no notice).
  String? _deferredSignOut;

  /// A sign-out is taking the agent off duty first.
  bool _signingOut = false;
  SessionResponse? _session;
  final Set<String> _verificationSentTo = {};

  AuthService get _auth => ref.read(authServiceProvider);
  SessionApi get _api => ref.read(sessionApiProvider);
  SessionStore get _store => ref.read(sessionStoreProvider);
  RequestScope get _scope => ref.read(requestScopeProvider);

  @override
  AppGate build() {
    _authSub = ref.read(authServiceProvider).authStateChanges().listen(_onAuthEvent);
    ref.onDispose(() {
      _run++;
      unawaited(_authSub?.cancel());
      _retryTimer?.cancel();
      _deferredRecheck?.cancel();
      _signalsSub?.close();
    });
    unawaited(Future.microtask(_start));
    return const GateLoading();
  }

  bool _current(int run) => ref.mounted && run == _run;

  /// Whether a call or its wrap-up is on screen.
  bool get _callActive => ref.read(stationSignalsProvider).callActive;

  // ─── Start-up ─────────────────────────────────────────────────────────────

  Future<void> _start() async {
    if (!ref.mounted) return;
    final run = _run;
    final versionCheck = _checkVersion();
    final restored = _auth.restoredUser().catchError((Object e) {
      _log.warn('Restoring the signed-in user failed', {'error': e.runtimeType.toString()});
      return null;
    });
    final update = await versionCheck;
    final user = await restored;
    if (!ref.mounted) return;
    _starting = false;
    if (update != null) {
      _updateRequired = true;
      _run++;
      state = update;
      return;
    }
    // An invite claim or a button press got there first.
    if (run != _run || _holdingInvite) return;
    await _resolve(user, interactive: false);
  }

  /// `GET /client-config`: the update gate, or null. Never throws: a server
  /// that cannot answer must not keep agents out of a working app.
  Future<GateUpdateRequired?> _checkVersion() async {
    try {
      final identity = ref.read(clientIdentityProvider);
      // A version that could not be read is not judged: start, never block.
      if (!identity.versionKnown) return null;
      final config = (await _api.clientConfig()).mobile;
      if (!config.mustUpdate(identity.version)) return null;
      _log.warn('This build is below the supported minimum', {'min': config.minSupported, 'have': identity.version});
      final urls = config.storeUrls;
      return GateUpdateRequired(
        storeUrl: identity.platform == 'ios' ? urls?.ios : urls?.android,
        minSupported: config.minSupported,
      );
    } catch (e) {
      _log.warn('Client config unavailable; starting anyway', {'error': e.toString()});
      return null;
    }
  }

  // ─── Resolution ───────────────────────────────────────────────────────────

  /// From a Firebase user to a gate state. [interactive] calls come from a
  /// button: their network failures go back to the screen (which shows them
  /// beside the button); start-up and listener calls retry on their own.
  Future<void> _resolve(AuthUser? user, {required bool interactive, bool forceRefresh = false}) async {
    final run = ++_run;
    _retryTimer?.cancel();
    if (user == null) {
      _forget();
      state = const GateSignedOut();
      return;
    }
    _uid = user.uid;
    try {
      final token = await _auth.idToken(forceRefresh: forceRefresh);
      if (!_current(run)) return;
      if (token == null) throw const ApiUnauthorized();
      final session = await _api.createSession(token);
      if (!_current(run)) return;
      await _adopt(session, run);
      _retries = 0;
    } on ApiHttpError catch (e) {
      if (!_current(run)) return;
      final refusal = e.status == 403 ? SessionRefusalCode.fromWire(e.code) : null;
      switch (refusal) {
        case SessionRefusalCode.noMembership:
          _log.info('Signed in without a membership');
          state = GateNoMembership(email: user.email);
        case SessionRefusalCode.emailUnverified:
          state = GateEmailUnverified(email: user.email ?? '');
          unawaited(_sendVerificationOnce(user));
        default:
          if (interactive) rethrow;
          if (e.isServerError) {
            _retryLater(e);
          } else {
            _log.warn('Session refused', {'status': e.status, 'code': e.code});
            _forget();
            state = GateSignedOut(notice: e.userMessage);
          }
      }
    } on ApiUnauthorized {
      if (!_current(run)) return;
      // The server would not accept Firebase's token (revoked, disabled).
      await _signOutNow(notice: sessionExpiredNotice);
    } on ApiError catch (e) {
      if (!_current(run)) return;
      if (interactive) rethrow;
      _retryLater(e);
    }
  }

  void _retryLater(ApiError e) {
    final delay = Duration(seconds: [2, 4, 8, 15, 30][_retries.clamp(0, 4)]);
    _retries++;
    _log.warn('Start-up could not reach the server; retrying', {'in_s': delay.inSeconds});
    state = GateLoading(notice: e.userMessage);
    _retryTimer = Timer(delay, retryNow);
  }

  /// Retries a start-up that is waiting on the network (the splash's button).
  void retryNow() {
    _retryTimer?.cancel();
    if (state is! GateLoading || _starting || !ref.mounted) return;
    unawaited(_resolve(_auth.currentUser, interactive: false));
  }

  Future<void> _adopt(SessionResponse session, int run, {String? preferTenantId}) async {
    _session = session;
    final choices = await _loadChoices(session);
    if (!_current(run)) return;
    final last = await _store.readLastAccount();
    if (!_current(run)) return;
    switch (pickAccount(choices, last: last, preferTenantId: preferTenantId)) {
      case AccountPicked(:final choice):
        await _select(choice, choices, run);
      case AccountMustChoose():
        _scope.clear();
        state = GateNeedsAccount(choices: choices);
      case AccountNone():
        _log.warn('Signed in with no account to work in');
        _scope.clear();
        state = const GateNeedsAccount();
    }
  }

  /// Every account across the workspaces the agent is an active member of,
  /// read in parallel (each call carries its own tenant header).
  Future<List<AccountChoice>> _loadChoices(SessionResponse session) async {
    final activeTenants = {
      for (final m in session.memberships)
        if (m.status == MembershipStatus.active) m.tenantId,
    };
    final tenants = session.tenants.where((t) => activeTenants.contains(t.id)).toList(growable: false);
    final lists = await Future.wait(tenants.map((t) async {
      try {
        return await _api.myAccounts(t.id);
      } on ApiHttpError catch (e) {
        // One workspace refusing (suspended) must not lock the agent out of
        // the others; with a single workspace it is the answer.
        if (tenants.length == 1 || e.isServerError) rethrow;
        _log.warn('Accounts unavailable for one workspace', {'status': e.status});
        return const <AccountSummary>[];
      }
    }));
    return [
      for (var i = 0; i < tenants.length; i++)
        for (final a in lists[i])
          AccountChoice(tenantId: tenants[i].id, tenantName: tenants[i].name, accountId: a.id, accountName: a.name),
    ];
  }

  Future<void> _select(AccountChoice choice, List<AccountChoice> choices, int run) async {
    final session = _session;
    if (session == null || !_current(run)) return;
    _scope
      ..tenantId = choice.tenantId
      ..accountId = choice.accountId;
    await _store.writeLastAccount(LastAccount(tenantId: choice.tenantId, accountId: choice.accountId));
    if (!_current(run)) return;
    final user = session.user;
    final name = user.displayName?.trim() ?? '';
    state = GateReady(
      userId: user.id,
      displayName: name.isEmpty ? user.email : name,
      email: user.email,
      tenantId: choice.tenantId,
      accountId: choice.accountId,
      accountName: choice.accountName,
      tenantName: choice.tenantName,
      accounts: choices,
    );
  }

  void _forget() {
    _uid = null;
    _session = null;
    _scope.clear();
  }

  // ─── Auth listener ────────────────────────────────────────────────────────

  void _onAuthEvent(AuthUser? user) {
    if (!ref.mounted || _starting || _updateRequired || _manualAuth > 0 || _holdingInvite) return;
    if (user == null) {
      if (_uid == null) return; // our own sign-out, or nobody was in
      _log.warn('Firebase ended the sign-in');
      if (_callActive) {
        _deferSignOut(sessionExpiredNotice);
      } else {
        unawaited(_signOutNow(notice: sessionExpiredNotice));
      }
      return;
    }
    if (user.uid == _uid) return;
    unawaited(_resolve(user, interactive: false));
  }

  Future<T> _manual<T>(Future<T> Function() body) async {
    _manualAuth++;
    try {
      return await body();
    } finally {
      _manualAuth--;
    }
  }

  // ─── Sign-in (screens call these) ────────────────────────────────────────

  /// Throws [AuthFailure] for a Firebase refusal and [ApiError] when the
  /// server could not be reached; a refused session becomes a gate state.
  Future<void> signInWithEmail(String email, String password) async {
    final user = await _manual(() => _auth.signInWithEmail(email, password));
    await _resolve(user, interactive: true);
  }

  Future<void> signInWithGoogle() async {
    final user = await _manual(_auth.signInWithGoogle);
    await _resolve(user, interactive: true);
  }

  Future<void> sendPasswordReset(String email) => _auth.sendPasswordReset(email);

  Future<void> _sendVerificationOnce(AuthUser user) async {
    if (!_verificationSentTo.add(user.uid)) return;
    try {
      await _auth.sendEmailVerification();
    } on AuthFailure catch (e) {
      _log.warn('Verification email not sent', {'code': e.code});
    }
  }

  Future<void> resendVerification() => _auth.sendEmailVerification();

  /// After the agent clicked the link: re-read the user and, when verified,
  /// sign in with a fresh token (the old one still says "unverified").
  /// Returns false while the address is still unverified.
  Future<bool> checkEmailVerified() async {
    final user = await _auth.reloadUser();
    if (user == null) {
      await _signOutNow();
      return false;
    }
    if (!user.emailVerified) return false;
    await _resolve(user, interactive: true, forceRefresh: true);
    return state is! GateEmailUnverified;
  }

  // ─── Accounts ─────────────────────────────────────────────────────────────

  /// The account picker's choice.
  Future<void> selectAccount(AccountChoice choice) async {
    final s = state;
    final choices = s is GateNeedsAccount ? s.choices : (s is GateReady ? s.accounts : const <AccountChoice>[]);
    await _select(choice, choices, ++_run);
  }

  /// Reads the accounts again (the picker's "Try again" when there were
  /// none). Network failures go back to the caller.
  Future<void> reloadAccounts() async {
    final session = _session;
    if (session == null) return;
    await _adopt(session, ++_run);
  }

  /// The Me tab's switch: re-reads the accounts (the one asked for may be
  /// gone) and selects it. Refused while on duty: the station belongs to the
  /// account it was opened in. Network failures go back to the caller and
  /// leave the current account in place.
  Future<void> switchAccount(AccountChoice choice) async {
    if (ref.read(stationSignalsProvider).onDuty) {
      throw StateError('Leave the station before switching account.');
    }
    final session = _session;
    if (session == null) return;
    final run = ++_run;
    final choices = await _loadChoices(session);
    if (!_current(run)) return;
    final match = choices.firstWhereOrNull((c) => c.tenantId == choice.tenantId && c.accountId == choice.accountId);
    if (match == null) {
      _scope.clear();
      state = GateNeedsAccount(choices: choices);
      return;
    }
    await _select(match, choices, run);
  }

  // ─── Sign-out ─────────────────────────────────────────────────────────────

  /// Signs out of Firebase and Google and forgets the account choice. While a
  /// call or wrap-up is on screen it waits for it to end.
  Future<void> signOut({String? notice}) async {
    if (_callActive) {
      _deferSignOut(notice);
      return;
    }
    await _signOutNow(notice: notice);
  }

  /// The hook for a 401 seen anywhere (after the API client's own forced
  /// token refresh): the session is over.
  void reportUnauthorized() {
    final s = state;
    if (s is! GateReady && s is! GateNeedsAccount) return;
    // Already on its way out (leaving the station can itself answer 401).
    if (_signingOut) return;
    final held = _deferredSignOut;
    if (held != null) {
      // A sign-out is already waiting for a call: this one is forced, so it
      // says why, and goes the moment nothing is live.
      _deferredSignOut = sessionExpiredNotice;
      if (held != sessionExpiredNotice) _log.warn('The server no longer accepts this sign-in (sign-out already held)');
      if (!_callActive) unawaited(Future.microtask(() => _signOutNow(notice: sessionExpiredNotice)));
      return;
    }
    _log.warn('The server no longer accepts this sign-in');
    unawaited(signOut(notice: sessionExpiredNotice));
  }

  /// Convenience for features: pass any caught API error; only an
  /// [ApiUnauthorized] does anything.
  void reportError(Object error) {
    if (error is ApiUnauthorized) reportUnauthorized();
  }

  /// Whether a sign-out is waiting for the call to end.
  bool get signOutDeferred => _deferredSignOut != null;

  /// How often a held sign-out looks again when nothing tells it the call
  /// ended. Tests shorten it.
  @visibleForTesting
  static Duration deferredSignOutRecheck = const Duration(seconds: 15);

  void _deferSignOut(String? notice) {
    // A forced sign-out's notice is never replaced by a plain one.
    _deferredSignOut = _deferredSignOut == sessionExpiredNotice ? sessionExpiredNotice : (notice ?? '');
    _log.info('Sign-out held until the call and wrap-up end');
    _signalsSub ??= ref.listen<StationSignals>(stationSignalsProvider, (_, next) {
      if (!next.callActive) _resumeDeferredSignOut();
    });
    _deferredRecheck?.cancel();
    _deferredRecheck = null;
    // Held with no call on screen: the leave was refused for a call the app
    // never saw, whose end no signal will report. Look again on a clock.
    if (_callActive) return;
    _deferredRecheck = Timer.periodic(deferredSignOutRecheck, (_) {
      if (!_callActive) _resumeDeferredSignOut();
    });
  }

  void _resumeDeferredSignOut() {
    final pending = _deferredSignOut;
    if (pending == null || _signingOut) return;
    unawaited(Future.microtask(() => _signOutNow(notice: pending.isEmpty ? null : pending)));
  }

  /// How long a sign-out waits for the station to be left. Past it the
  /// sign-out goes ahead and the station finishes closing on its own.
  static const stationTeardownTimeout = Duration(seconds: 6);

  Future<void> _signOutNow({String? notice}) async {
    if (!ref.mounted || _signingOut) return;
    _signingOut = true;
    try {
      _deferredSignOut = null;
      _signalsSub?.close();
      _signalsSub = null;
      _deferredRecheck?.cancel();
      _deferredRecheck = null;
      // Off duty first, while the token still works: a phone showing the
      // sign-in screen must never be sent a customer.
      if (!await _leaveStation()) {
        if (ref.mounted) _deferSignOut(notice);
        return;
      }
      if (!ref.mounted) return;
      final auth = _auth;
      final store = _store;
      _run++;
      _retryTimer?.cancel();
      _holdingInvite = false;
      _forget();
      state = GateSignedOut(notice: notice);
      await store.clearLastAccount();
      try {
        await auth.signOut();
      } on AuthFailure catch (e) {
        _log.warn('Firebase sign-out failed', {'code': e.code});
      }
    } finally {
      _signingOut = false;
    }
  }

  /// The station's teardown ([stationTeardownProvider]), bounded and never
  /// throwing. False only when a call went live before it could leave.
  Future<bool> _leaveStation() async {
    final done = Completer<bool>();
    void failed(Object e) {
      _log.warn('Leaving the station failed; signing out anyway', {'error': e.runtimeType.toString()});
      if (!done.isCompleted) done.complete(true);
    }

    try {
      unawaited(ref.read(stationTeardownProvider)().then((left) {
        if (!done.isCompleted) done.complete(left);
      }, onError: failed));
    } catch (e) {
      failed(e);
    }
    return done.future.timeout(stationTeardownTimeout, onTimeout: () {
      _log.warn('Leaving the station is taking too long; signing out anyway');
      return true;
    });
  }

  // ─── Invites ──────────────────────────────────────────────────────────────

  /// Gets a Firebase credential for an invite WITHOUT creating a session from
  /// it. Signs out whoever was signed in first: accepting an invitation is
  /// signing in as the invited person. Throws [AuthFailure].
  Future<AuthUser> establishInviteCredential(InviteCredentialRequest request) async {
    if (_uid != null && !_holdingInvite) await _signOutNow();
    final hadCredential = _holdingInvite;
    _holdingInvite = true;
    try {
      return await switch (request) {
        InviteViaGoogle() => _auth.signInWithGoogle(),
        InviteCreatePassword(:final email, :final password) => _auth.createPasswordAccount(email, password),
        InviteSignInPassword(:final email, :final password) => _auth.signInWithEmail(email, password),
      };
    } catch (_) {
      // Nothing was established, so nothing to hold, unless an earlier
      // credential from this page is still live.
      if (!hadCredential) _holdingInvite = false;
      rethrow;
    }
  }

  /// Claims the invitation with the held credential (a fresh token, minted
  /// now: the agent may have paused on a confirmation for a long time), then
  /// signs in on the session it answers, preferring the invited workspace.
  /// Throws [InviteClaimRefused] or [ApiError]; the credential stays held.
  Future<void> claimInvite(String token, {AgencyInvite? invite}) async {
    final user = _auth.currentUser;
    final idToken = await _auth.idToken(forceRefresh: true);
    if (user == null || idToken == null) throw const ApiUnauthorized();
    final session = await _api.claimInvite(token, idToken);
    if (!ref.mounted) return;
    _holdingInvite = false;
    final run = ++_run;
    _uid = user.uid;
    try {
      await _adopt(session, run, preferTenantId: invite == null ? null : invitedTenantId(session, invite));
    } on ApiError catch (e) {
      // The claim landed; only the account read failed. The ordinary
      // sign-in path works for this identity now, so retry it.
      if (_current(run)) _retryLater(e);
    }
  }

  /// Leaves the invite flow: drops the held credential (so the next Google
  /// sheet asks again) and stays on the invite page, signed out.
  Future<void> abandonInvite() async {
    if (!_holdingInvite) return;
    await _signOutNow();
  }

  /// Whether the invite page holds a credential it has not claimed with.
  bool get holdsInviteCredential => _holdingInvite;
}

/// The workspace an invitation was for, recognised in the claim's session
/// without the wire naming it: the only workspace, or the only one where the
/// agent holds the invited role under the invited workspace name. Null when
/// it cannot tell (the last-used rules apply then).
@visibleForTesting
String? invitedTenantId(SessionResponse session, AgencyInvite invite) {
  if (session.tenants.length == 1) return session.tenants.single.id;
  final holding = {
    for (final m in session.memberships)
      if (m.status == MembershipStatus.active && m.roleRaw == invite.roleRaw) m.tenantId,
  };
  final candidates = session.tenants
      .where((t) => holding.contains(t.id) && (invite.tenantName == null || t.name == invite.tenantName))
      .toList(growable: false);
  return candidates.length == 1 ? candidates.single.id : null;
}

final appGateProvider = NotifierProvider<AppGateNotifier, AppGate>(AppGateNotifier.new);

/// The tenant/account of a ready gate, or null. Per-account caches (the
/// campaign list, notification preferences) watch this, so a switch or a
/// sign-out drops them.
final readyAccountProvider = Provider<({String tenantId, String accountId})?>((ref) {
  final gate = ref.watch(appGateProvider);
  return gate is GateReady ? (tenantId: gate.tenantId, accountId: gate.accountId) : null;
});

/// Whose data a per-workspace cache holds: `user:tenant:account`, or null
/// when nobody is signed in to an account.
///
/// The tabs stay mounted in the shell across an account switch, and a
/// different agent can sign in on the same phone to the same account, so the
/// signed-in user is part of the key, not only the account. Everything cached
/// per workspace (the campaign list, notification settings, pages of calls,
/// stats, campaign names) is keyed on this and dropped when it changes: one
/// agent never sees another's data, nor one account another's.
final agentWorkspaceProvider = Provider<String?>((ref) {
  final account = ref.watch(readyAccountProvider);
  final userId = ref.watch(appGateProvider.select((g) => g is GateReady ? g.userId : null));
  if (account == null || userId == null) return null;
  return '$userId:${account.tenantId}:${account.accountId}';
});

/// For features that read the API from a provider: hands an [ApiUnauthorized]
/// to the gate (which signs out, after a live call) on the next microtask, so
/// a provider mid-build never changes the gate synchronously. Anything else is
/// ignored: the feature shows it.
void reportToGate(Ref ref, Object error) {
  if (error is! ApiUnauthorized) return;
  final gate = ref.read(appGateProvider.notifier);
  unawaited(Future.microtask(() => gate.reportError(error)));
}
