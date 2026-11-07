import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/auth/app_gate.dart';
import '../core/softphone/softphone_view.dart' show softphoneAvailabilityProvider;
import '../core/station/station_signals.dart';
import '../features/accounts/account_picker_screen.dart';
import '../features/auth/no_membership_screen.dart';
import '../features/auth/sign_in_screen.dart';
import '../features/auth/update_required_screen.dart';
import '../features/auth/verify_email_screen.dart';
import '../features/calls/calls_screen.dart';
import '../features/campaigns/campaigns_screen.dart';
import '../features/contacts/my_contacts_screen.dart';
import '../features/customers/customer_history_screen.dart';
import '../features/customers/customer_search_screen.dart';
import '../features/join/invite_screen.dart';
import '../features/performance/performance_screen.dart';
import '../features/preflight/preflight_screen.dart';
import '../features/settings/me_screen.dart';
import '../features/softphone/phone_screen.dart';
import '../features/station/station_screen.dart';
import 'routes.dart';
import 'shell.dart';
import 'splash_screen.dart';

/// Bridges the gate, the station signals and the soft phone's availability
/// (Riverpod) to go_router's `refreshListenable`, so the router is built once
/// and re-runs its redirect only when one of them changes.
class RouterRefresh extends ChangeNotifier {
  RouterRefresh(Ref ref) {
    ref.listen<AppGate>(appGateProvider, (_, _) => notifyListeners());
    ref.listen<StationSignals>(stationSignalsProvider, (_, _) => notifyListeners());
    ref.listen<bool>(softphoneAvailabilityProvider.select((a) => a.visible), (_, _) => notifyListeners());
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

/// Where the hosted session's screen is: the campaign's station, or the Phone
/// tab for a soft-phone session. Null with no session to go to.
String? homeRouteOf(StationSignals station) => switch (station.home) {
      StationHome.station => Routes.station(station.campaignId!),
      StationHome.phone => Routes.phone,
      null => null,
    };

/// The hosted session's rules, for every route (the tab shell, the invite
/// page, a deep link alike), or null to stay. The target is the session's own
/// screen ([homeRouteOf]): the station for a campaign session (also while it
/// is switched to the soft phone), the Phone tab for a soft-phone session.
/// * a call takes the screen: a campaign call (reserved, on call, wrap-up) or
///   a soft-phone call on the line (dialing, ringing, on the call), whatever
///   the agent was on;
/// * a soft-phone call that owes its outcome holds the agent there until it
///   is saved (the tab bar stays, the other tabs closed);
/// * on duty on a campaign and not on a break, the agent stays on the
///   station. Only the pre-flight of that same campaign stays open (it is
///   still finishing the join that made them on duty, and moves to the station
///   itself), and that campaign's My contacts (the agent picks whom to call
///   next from it; the call it places takes the screen back to the station).
/// On a break (the soft phone's own included, so an idle soft phone holds
/// nothing), or off duty, the agent moves freely.
///
/// A state, not a transition: a shell built while a call is already live,
/// or a break that ended on another tab, lands on the station all the same.
@visibleForTesting
String? stationRedirect(StationSignals station, String location) {
  final target = homeRouteOf(station);
  if (target == null) return null;
  final campaign = station.sessionKind == StationSessionKind.campaign;
  // A soft-phone session is always on its break; never let it hold the tabs
  // on the strength of a state frame that has not said so yet.
  final holds = campaign && station.holdsStation;
  if (!(station.callActive || station.outcomeOwed || holds)) return null;
  if (location == target) return null;
  if (campaign &&
      !station.callActive &&
      !station.outcomeOwed &&
      (location == Routes.preflight(station.campaignId!) || location == Routes.myContacts(station.campaignId!))) {
    return null;
  }
  return target;
}

/// The gate first, then (once ready) the hosted session: the gate's own
/// screens (update required, sign-in, account picker) are never overridden by
/// it. Last, `/phone` goes home while the Phone tab is not shown to this
/// agent ([phoneVisible]), unless it is where the session lives.
@visibleForTesting
String? appRedirect(AppGate gate, StationSignals station, String location, {bool phoneVisible = false}) {
  final byGate = gateRedirect(gate, location);
  if (gate is! GateReady) return byGate;
  final here = byGate ?? location;
  final held = stationRedirect(station, here);
  if (held != null) return held;
  if (here == Routes.phone && !phoneVisible && station.home != StationHome.phone) return Routes.home;
  return byGate;
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
    redirect: (context, state) => appRedirect(
      ref.read(appGateProvider),
      ref.read(stationSignalsProvider),
      state.matchedLocation,
      phoneVisible: ref.read(softphoneAvailabilityProvider).visible,
    ),
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
                GoRoute(
                  path: 'contacts/:campaignId',
                  builder: (_, s) => MyContactsScreen(campaignId: s.pathParameters['campaignId']!),
                ),
              ],
            ),
          ]),
          // Always a branch, so the branch indexes never move; the shell shows
          // it as a tab only while the soft phone is available (AppShell).
          StatefulShellBranch(routes: [GoRoute(path: Routes.phone, builder: (_, _) => const PhoneScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.performance, builder: (_, _) => const PerformanceScreen())]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: Routes.calls,
              builder: (_, _) => const CallsScreen(),
              routes: [
                GoRoute(
                  path: 'customer',
                  builder: (_, _) => const CustomerSearchScreen(),
                  routes: [GoRoute(path: 'results', builder: (_, _) => const CustomerHistoryScreen())],
                ),
              ],
            ),
          ]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.me, builder: (_, _) => const MeScreen())]),
        ],
      ),
    ],
  ),
);
