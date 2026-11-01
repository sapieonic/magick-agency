import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/auth/app_gate.dart';
import '../core/station/station_signals.dart';
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

/// Bridges the gate and the station signals (Riverpod) to go_router's
/// `refreshListenable`, so the router is built once and re-runs its redirect
/// only when one of them changes.
class RouterRefresh extends ChangeNotifier {
  RouterRefresh(Ref ref) {
    ref.listen<AppGate>(appGateProvider, (_, _) => notifyListeners());
    ref.listen<StationSignals>(stationSignalsProvider, (_, _) => notifyListeners());
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
      // An invite can add the very account they are about to pick.
      return location == Routes.accounts || invite ? null : Routes.accounts;
    case GateReady():
      if (location == Routes.splash || (public && !invite) || location == Routes.accounts) return Routes.home;
      return null;
  }
}

/// The station's rules, for every route (the tab shell, the invite page, a
/// deep link alike), or null to stay:
/// * a call (reserved, on call, wrap-up) takes the screen: the live station,
///   whatever the agent was on;
/// * on duty and not on a break, the agent stays on the station. Only the
///   pre-flight of that same campaign stays open (it is still finishing the
///   join that made them on duty, and moves to the station itself).
/// On a break, or off duty, the agent moves freely.
///
/// A state, not a transition: a shell built while a call is already live,
/// or a break that ended on another tab, lands on the station all the same.
@visibleForTesting
String? stationRedirect(StationSignals station, String location) {
  final campaignId = station.campaignId;
  if (campaignId == null || !(station.callActive || station.holdsStation)) return null;
  final target = Routes.station(campaignId);
  if (location == target) return null;
  if (!station.callActive && location == Routes.preflight(campaignId)) return null;
  return target;
}

/// The gate first, then (once ready) the station: the gate's own screens
/// (update required, sign-in, account picker) are never overridden by it.
@visibleForTesting
String? appRedirect(AppGate gate, StationSignals station, String location) {
  final byGate = gateRedirect(gate, location);
  if (gate is! GateReady) return byGate;
  return stationRedirect(station, byGate ?? location) ?? byGate;
}

final rootNavigatorKey = GlobalKey<NavigatorState>(debugLabel: 'root');

/// The router over [routes], redirecting by [appRedirect]. Tests build it
/// over stand-in screens.
GoRouter buildAppRouter(
  Ref ref, {
  required List<RouteBase> routes,
  String initialLocation = Routes.splash,
  GlobalKey<NavigatorState>? navigatorKey,
}) {
  final refresh = RouterRefresh(ref);
  ref.onDispose(refresh.dispose);
  final router = GoRouter(
    navigatorKey: navigatorKey,
    initialLocation: initialLocation,
    refreshListenable: refresh,
    redirect: (context, state) =>
        appRedirect(ref.read(appGateProvider), ref.read(stationSignalsProvider), state.matchedLocation),
    routes: routes,
  );
  ref.onDispose(router.dispose);
  return router;
}

final routerProvider = Provider<GoRouter>(
  (ref) => buildAppRouter(
    ref,
    navigatorKey: rootNavigatorKey,
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
  ),
);
