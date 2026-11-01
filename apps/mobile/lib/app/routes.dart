/// Every path in the app, in one place. Screens navigate with these helpers,
/// never with string literals, so a renamed route is a compile error.
abstract final class Routes {
  static const splash = '/';
  static const updateRequired = '/update';
  static const signIn = '/sign-in';
  static const verifyEmail = '/verify-email';
  static const noMembership = '/no-membership';
  static const accounts = '/accounts';

  /// The invite link path, identical to the console's (`/agency/join/:token`),
  /// so the same https link opens the app through Universal/App Links.
  static const invitePattern = '/agency/join/:token';
  static String invite(String token) => '/agency/join/${Uri.encodeComponent(token)}';

  // Tabs.
  static const home = '/home';
  static const performance = '/performance';
  static const calls = '/calls';
  static const me = '/me';

  static const preflightPattern = '/preflight/:campaignId';
  static String preflight(String campaignId) => '/preflight/$campaignId';

  /// The station lives inside the Station tab (the tab bar shows while waiting
  /// and hides for a call), so it is a child of [home].
  static const stationPattern = '/home/station/:campaignId';
  static String station(String campaignId) => '/home/station/$campaignId';

  /// Paths reachable without a ready gate.
  static bool isPublic(String path) =>
      path == signIn || path == verifyEmail || path == noMembership || path == updateRequired || path.startsWith('/agency/join/');
}
