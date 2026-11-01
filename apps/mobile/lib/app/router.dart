import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/auth/app_gate.dart';
import '../features/accounts/account_picker_screen.dart';
import '../features/auth/no_membership_screen.dart';
import '../features/auth/sign_in_screen.dart';
import '../features/auth/update_required_screen.dart';
import '../features/auth/verify_email_screen.dart';
import '../features/calls/calls_screen.dart';
import '../features/campaigns/campaigns_screen.dart';
import '../features/join/invite_screen.dart';
import '../features/performance/performance_screen.dart';
import '../features/preflight/preflight_screen.dart';
import '../features/settings/me_screen.dart';
import '../features/station/station_screen.dart';
import 'routes.dart';
import 'shell.dart';
import 'splash_screen.dart';

/// Bridges the gate (Riverpod) to go_router's `refreshListenable`, so the
/// router is built once and only re-runs its redirect when the gate changes.
class _GateListenable extends ChangeNotifier {
  _GateListenable(Ref ref) {
    ref.listen<AppGate>(appGateProvider, (_, _) => notifyListeners());
  }
}

/// Where the gate sends a location, or null to stay.
@visibleForTesting
String? gateRedirect(AppGate gate, String location) {
  final public = Routes.isPublic(location);
  final invite = location.startsWith('/agency/join/');
  switch (gate) {
    case GateLoading():
      // Keep an invite link in the address while start-up finishes.
      return location == Routes.splash || invite ? null : Routes.splash;
    case GateUpdateRequired():
      return location == Routes.updateRequired ? null : Routes.updateRequired;
    case GateSignedOut():
      return public && location != Routes.verifyEmail && location != Routes.noMembership ? null : Routes.signIn;
    case GateEmailUnverified():
      return location == Routes.verifyEmail ? null : Routes.verifyEmail;
    case GateNoMembership():
      // Claiming an invite is exactly how someone without a membership gets one.
      return location == Routes.noMembership || invite ? null : Routes.noMembership;
    case GateNeedsAccount():
      return location == Routes.accounts ? null : Routes.accounts;
    case GateReady():
      if (location == Routes.splash || (public && !invite) || location == Routes.accounts) return Routes.home;
      return null;
  }
}

final rootNavigatorKey = GlobalKey<NavigatorState>(debugLabel: 'root');

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _GateListenable(ref);
  ref.onDispose(refresh.dispose);

  final router = GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: Routes.splash,
    refreshListenable: refresh,
    redirect: (context, state) => gateRedirect(ref.read(appGateProvider), state.matchedLocation),
    routes: [
      GoRoute(path: Routes.splash, builder: (_, _) => const SplashScreen()),
      GoRoute(path: Routes.updateRequired, builder: (_, _) => const UpdateRequiredScreen()),
      GoRoute(path: Routes.signIn, builder: (_, _) => const SignInScreen()),
      GoRoute(path: Routes.verifyEmail, builder: (_, _) => const VerifyEmailScreen()),
      GoRoute(path: Routes.noMembership, builder: (_, _) => const NoMembershipScreen()),
      GoRoute(path: Routes.accounts, builder: (_, _) => const AccountPickerScreen()),
      GoRoute(
        path: Routes.invitePattern,
        builder: (_, s) => InviteScreen(token: s.pathParameters['token']!),
      ),
      GoRoute(
        path: Routes.preflightPattern,
        builder: (_, s) => PreflightScreen(campaignId: s.pathParameters['campaignId']!),
      ),
      StatefulShellRoute.indexedStack(
        builder: (context, state, shell) => AppShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [
            GoRoute(
              path: Routes.home,
              builder: (_, _) => const CampaignsScreen(),
              routes: [
                GoRoute(
                  path: 'station/:campaignId',
                  builder: (_, s) => StationScreen(campaignId: s.pathParameters['campaignId']!),
                ),
              ],
            ),
          ]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.performance, builder: (_, _) => const PerformanceScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.calls, builder: (_, _) => const CallsScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.me, builder: (_, _) => const MeScreen())]),
        ],
      ),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});
