import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';
import '../../core/auth/auth_copy.dart';
import '../../core/auth/auth_service.dart';
import '../../core/session/session_api.dart';
import '../../core/telemetry/log.dart';
import 'invite_copy.dart';

/// What the invite page is showing.
enum InvitePhase {
  loading,

  /// The invitation, ready to accept.
  pending,

  /// Claimed, expired, revoked, not found or already bound ([InviteState.status]).
  unavailable,

  /// The lookup itself failed: a retry, not a dead end.
  unreachable,

  /// A non-agent invitation: accepted on the web, not here.
  wrongApp,

  /// Claimed: the gate takes over.
  done,
}

/// The button whose work is in flight, so it shows progress and nothing
/// double-fires.
enum InviteBusy { none, google, create, signIn, confirm, decline }

@immutable
class InviteState {
  const InviteState({
    this.phase = InvitePhase.loading,
    this.invite,
    this.status,
    this.unreachableMessage,
    this.showPassword = false,
    this.existingPassword = false,
    this.busy = InviteBusy.none,
    this.error,
    this.errorOffersSignIn = false,
    this.mismatchEmail,
    this.mismatch = false,
    this.addressRequired = false,
    this.addressRequiredSignedInAs,
  });

  final InvitePhase phase;
  final AgencyInvite? invite;
  final InviteStatus? status;
  final String? unreachableMessage;

  /// The password form is open.
  final bool showPassword;

  /// The invited address already has a password: the form signs in instead
  /// of creating one.
  final bool existingPassword;
  final InviteBusy busy;
  final String? error;

  /// The error's remedy is the sign-in page (`identity_in_use`).
  final bool errorOffersSignIn;

  /// Google answered with another address: confirm or use another account.
  final bool mismatch;
  final String? mismatchEmail;

  /// This invitation must be accepted at the invited address, and the
  /// account used was another (it has been signed out).
  final bool addressRequired;
  final String? addressRequiredSignedInAs;

  InviteState copyWith({
    InvitePhase? phase,
    AgencyInvite? invite,
    InviteStatus? status,
    String? unreachableMessage,
    bool? showPassword,
    bool? existingPassword,
    InviteBusy? busy,
    String? Function()? error,
    bool? errorOffersSignIn,
    bool? mismatch,
    String? Function()? mismatchEmail,
    bool? addressRequired,
    String? Function()? addressRequiredSignedInAs,
  }) =>
      InviteState(
        phase: phase ?? this.phase,
        invite: invite ?? this.invite,
        status: status ?? this.status,
        unreachableMessage: unreachableMessage ?? this.unreachableMessage,
        showPassword: showPassword ?? this.showPassword,
        existingPassword: existingPassword ?? this.existingPassword,
        busy: busy ?? this.busy,
        error: error == null ? this.error : error(),
        errorOffersSignIn: errorOffersSignIn ?? this.errorOffersSignIn,
        mismatch: mismatch ?? this.mismatch,
        mismatchEmail: mismatchEmail == null ? this.mismatchEmail : mismatchEmail(),
        addressRequired: addressRequired ?? this.addressRequired,
        addressRequiredSignedInAs:
            addressRequiredSignedInAs == null ? this.addressRequiredSignedInAs : addressRequiredSignedInAs(),
      );

  @override
  bool operator ==(Object other) =>
      other is InviteState &&
      other.phase == phase &&
      other.invite == invite &&
      other.status == status &&
      other.unreachableMessage == unreachableMessage &&
      other.showPassword == showPassword &&
      other.existingPassword == existingPassword &&
      other.busy == busy &&
      other.error == error &&
      other.errorOffersSignIn == errorOffersSignIn &&
      other.mismatch == mismatch &&
      other.mismatchEmail == mismatchEmail &&
      other.addressRequired == addressRequired &&
      other.addressRequiredSignedInAs == addressRequiredSignedInAs;

  @override
  int get hashCode => Object.hash(phase, invite, status, unreachableMessage, showPassword, existingPassword, busy, error,
      errorOffersSignIn, mismatch, mismatchEmail, addressRequired, addressRequiredSignedInAs);
}

/// The invite page's state machine, keyed by the token in the link.
///
/// Lookup (`GET /invites/:token`) → a credential (Google or a password at the
/// invited address, held by the gate so no session is made from it) → the
/// claim (`POST /invites/:token/claim`) → the gate signs in. Leaving the page
/// with an unclaimed credential drops it.
class InviteController extends Notifier<InviteState> {
  InviteController(this.token);

  final String token;
  static final _log = Log('invite');
  int _lookupSeq = 0;
  bool _claimSent = false;

  AppGateNotifier get _gate => ref.read(appGateProvider.notifier);

  @override
  InviteState build() {
    // Read once: the gate outlives this page and must not rebuild it.
    final gate = ref.read(appGateProvider.notifier);
    ref.onDispose(() {
      _lookupSeq++;
      // An unclaimed credential left behind would sit signed in behind a
      // page that no longer exists.
      // After the dispose, not inside it: a lifecycle callback may not change
      // another provider.
      if (!_claimSent && gate.holdsInviteCredential) unawaited(Future.microtask(gate.abandonInvite));
    });
    unawaited(Future.microtask(load));
    return const InviteState();
  }

  Future<void> load() async {
    final seq = ++_lookupSeq;
    state = const InviteState();
    try {
      final result = await ref.read(sessionApiProvider).lookupInvite(token);
      if (!ref.mounted || seq != _lookupSeq) return;
      switch (result) {
        case InvitePending(:final invite):
          if (invite.role != Role.agent && invite.role != Role.unknown) {
            state = InviteState(phase: InvitePhase.wrongApp, invite: invite);
          } else {
            state = InviteState(phase: InvitePhase.pending, invite: invite);
          }
        case InviteUnavailable(:final status):
          state = InviteState(phase: InvitePhase.unavailable, status: status);
      }
    } on ApiError catch (e) {
      if (!ref.mounted || seq != _lookupSeq) return;
      _log.warn('Invite lookup failed', {'error': e.runtimeType.toString()});
      state = InviteState(phase: InvitePhase.unreachable, unreachableMessage: e.userMessage);
    }
  }

  void revealPassword() => state = state.copyWith(showPassword: true);

  void clearError() => state = state.copyWith(error: () => null, errorOffersSignIn: false);

  Future<void> continueWithGoogle() async {
    final invite = state.invite;
    if (invite == null || state.busy != InviteBusy.none) return;
    state = state.copyWith(busy: InviteBusy.google, error: () => null, errorOffersSignIn: false);
    try {
      final user = await _gate.establishInviteCredential(const InviteViaGoogle());
      if (!ref.mounted) return;
      if (!sameAddress(user.email, invite.email)) {
        if (invite.requiresMatchingAddress) {
          await _requireInvitedAddress(user.email);
          return;
        }
        // Allowed, but never silently: the two addresses side by side, and
        // nothing claimed until the agent says yes.
        state = state.copyWith(busy: InviteBusy.none, mismatch: true, mismatchEmail: () => user.email);
        return;
      }
      await _claim(invite);
    } catch (e) {
      _fail(e);
    }
  }

  Future<void> confirmMismatch() async {
    final invite = state.invite;
    if (invite == null || !state.mismatch || state.busy != InviteBusy.none) return;
    state = state.copyWith(busy: InviteBusy.confirm, error: () => null, errorOffersSignIn: false);
    try {
      await _claim(invite);
    } catch (e) {
      // The confirmation stays up: "Use a different account" is the only way
      // out of a refused claim with this account still signed in.
      _fail(e);
    }
  }

  /// "Use a different account": drops the credential, not just the screen,
  /// so the next Google sheet asks again.
  Future<void> declineMismatch() async {
    state = state.copyWith(busy: InviteBusy.decline, error: () => null, errorOffersSignIn: false);
    await _gate.abandonInvite();
    if (!ref.mounted) return;
    state = state.copyWith(busy: InviteBusy.none, mismatch: false, mismatchEmail: () => null);
  }

  /// Back to the options after an address-required refusal.
  void retryWithInvitedAddress() => state = state.copyWith(
        addressRequired: false,
        addressRequiredSignedInAs: () => null,
        error: () => null,
        showPassword: true,
      );

  Future<void> submitPassword(String password) async {
    final invite = state.invite;
    if (invite == null || state.busy != InviteBusy.none) return;
    final existing = state.existingPassword;
    // The strength rule is for a password being CREATED, never one they
    // already have and cannot change from here.
    if (!existing) {
      final blocker = assessPassword(password, invite.email).blocker;
      if (blocker != null) {
        state = state.copyWith(error: () => blocker, errorOffersSignIn: false);
        return;
      }
    }
    state = state.copyWith(busy: existing ? InviteBusy.signIn : InviteBusy.create, error: () => null, errorOffersSignIn: false);
    try {
      await _gate.establishInviteCredential(
        existing ? InviteSignInPassword(invite.email, password) : InviteCreatePassword(invite.email, password),
      );
      if (!ref.mounted) return;
      await _claim(invite);
    } on AuthFailure catch (e) {
      if (!ref.mounted) return;
      if (e.code == 'email-already-in-use') {
        // Invited to a second workspace with a password from the first: the
        // form becomes a sign-in and the claim adds this workspace to it.
        state = state.copyWith(
          busy: InviteBusy.none,
          existingPassword: true,
          error: () => 'That address already has a password. Enter it and we will add this workspace to it.',
        );
        return;
      }
      _fail(e);
    } catch (e) {
      _fail(e);
    }
  }

  Future<void> _claim(AgencyInvite invite) async {
    _claimSent = true;
    try {
      await _gate.claimInvite(token, invite: invite);
    } catch (_) {
      _claimSent = false;
      rethrow;
    }
    if (!ref.mounted) return;
    state = state.copyWith(phase: InvitePhase.done, busy: InviteBusy.none);
  }

  Future<void> _requireInvitedAddress(String? signedInAs) async {
    await _gate.abandonInvite();
    if (!ref.mounted) return;
    state = state.copyWith(
      busy: InviteBusy.none,
      mismatch: false,
      mismatchEmail: () => null,
      addressRequired: true,
      addressRequiredSignedInAs: () => signedInAs,
    );
  }

  void _fail(Object e) {
    if (!ref.mounted) return;
    switch (e) {
      case InviteClaimRefused(:final refusal):
        switch (refusal.status) {
          case InviteStatus.addressRequired:
            unawaited(_requireInvitedAddress(state.mismatchEmail));
          case InviteStatus.identityInUse:
            // The invitation is untouched; this account belongs to someone
            // else here. The server's own sentence, with the way to sign in.
            state = state.copyWith(
              busy: InviteBusy.none,
              error: () => refusal.message.isEmpty
                  ? 'That account is already set up with this workspace. Sign in with it directly.'
                  : refusal.message,
              errorOffersSignIn: true,
            );
          default:
            unawaited(_gate.abandonInvite());
            state = InviteState(phase: InvitePhase.unavailable, status: refusal.status);
        }
      case AuthFailure():
        state = state.copyWith(
          busy: InviteBusy.none,
          error: () => authErrorMessage(e, action: AuthAction.invite),
          errorOffersSignIn: false,
        );
      case ApiError():
        state = state.copyWith(busy: InviteBusy.none, error: () => e.userMessage, errorOffersSignIn: false);
      default:
        _log.error('Invite step failed', const {}, e);
        state = state.copyWith(busy: InviteBusy.none, error: () => 'That did not work. Try again.', errorOffersSignIn: false);
    }
  }
}

final inviteControllerProvider =
    NotifierProvider.autoDispose.family<InviteController, InviteState, String>(InviteController.new);
