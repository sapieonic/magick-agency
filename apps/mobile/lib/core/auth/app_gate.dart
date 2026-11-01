import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Where the agent stands before any agency screen can open. The router
/// redirects on this and nothing else, so every entry path (cold start, an
/// invite link, a 401, an account switch) resolves the same way.
///
/// The names [AppGate], its subtypes and [appGateProvider] are a fixed
/// interface: `lib/app/router.dart` depends on them.
sealed class AppGate {
  const AppGate();
}

/// Start-up: reading the version gate, Firebase's persisted user and the session.
final class GateLoading extends AppGate {
  const GateLoading();
}

/// The server's `GET /client-config` says this build is below `min_supported`.
@immutable
final class GateUpdateRequired extends AppGate {
  const GateUpdateRequired({required this.storeUrl, required this.minSupported});
  final String? storeUrl;
  final String minSupported;
}

final class GateSignedOut extends AppGate {
  const GateSignedOut();
}

/// Signed in to Firebase with an address that is not verified yet.
@immutable
final class GateEmailUnverified extends AppGate {
  const GateEmailUnverified({required this.email});
  final String email;
}

/// Firebase knows the person, the agency does not (`403 no_membership`).
@immutable
final class GateNoMembership extends AppGate {
  const GateNoMembership({required this.email});
  final String? email;
}

/// Signed in, but more than one account and none chosen yet.
final class GateNeedsAccount extends AppGate {
  const GateNeedsAccount();
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
  });

  final String userId;
  final String displayName;
  final String? email;
  final String tenantId;
  final String accountId;
  final String accountName;
}

/// The gate. The auth layer replaces this notifier's implementation; the
/// type and provider name stay.
class AppGateNotifier extends Notifier<AppGate> {
  @override
  AppGate build() => const GateLoading();
}

final appGateProvider = NotifierProvider<AppGateNotifier, AppGate>(AppGateNotifier.new);
