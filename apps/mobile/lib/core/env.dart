import 'package:flutter/foundation.dart';

/// Build-time configuration, from `--dart-define-from-file=env/<flavor>.json`.
///
/// Nothing here is a secret: the Firebase client config and a PostHog project
/// key are public by design (as in the console's `VITE_*` values). Values are
/// compile-time constants, so an unset key is an empty string, never null.
@immutable
class Env {
  const Env({
    required this.flavor,
    required this.apiOrigin,
    required this.firebaseApiKey,
    required this.firebaseProjectId,
    required this.firebaseAppIdAndroid,
    required this.firebaseAppIdIos,
    required this.firebaseMessagingSenderId,
    required this.googleIosClientId,
    required this.googleServerClientId,
    required this.posthogKey,
    required this.posthogHost,
  });

  factory Env.fromDefines() => const Env(
        flavor: String.fromEnvironment('FLAVOR', defaultValue: 'dev'),
        apiOrigin: String.fromEnvironment('API_ORIGIN', defaultValue: 'http://10.0.2.2:3021'),
        firebaseApiKey: String.fromEnvironment('FIREBASE_API_KEY'),
        firebaseProjectId: String.fromEnvironment('FIREBASE_PROJECT_ID'),
        firebaseAppIdAndroid: String.fromEnvironment('FIREBASE_APP_ID_ANDROID'),
        firebaseAppIdIos: String.fromEnvironment('FIREBASE_APP_ID_IOS'),
        firebaseMessagingSenderId: String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID'),
        googleIosClientId: String.fromEnvironment('GOOGLE_IOS_CLIENT_ID'),
        googleServerClientId: String.fromEnvironment('GOOGLE_SERVER_CLIENT_ID'),
        posthogKey: String.fromEnvironment('POSTHOG_KEY'),
        posthogHost: String.fromEnvironment('POSTHOG_HOST'),
      );

  final String flavor;

  /// Scheme + host (+ port) of the API, e.g. `https://agency.example.com`.
  /// The console calls the API on its own origin; the app calls this one.
  final String apiOrigin;

  final String firebaseApiKey;
  final String firebaseProjectId;
  final String firebaseAppIdAndroid;
  final String firebaseAppIdIos;
  final String firebaseMessagingSenderId;
  final String googleIosClientId;
  final String googleServerClientId;
  final String posthogKey;
  final String posthogHost;

  bool get isProduction => flavor == 'prod';
  bool get hasFirebase => firebaseApiKey.isNotEmpty && firebaseProjectId.isNotEmpty;

  Uri get apiBase => Uri.parse(apiOrigin);

  /// The station socket's origin: `wss://` for `https://`, `ws://` for `http://`.
  /// `station_ws_url` from the server is a RELATIVE path and is resolved here.
  Uri resolveStationUrl(String relativeOrAbsolute) {
    final parsed = Uri.parse(relativeOrAbsolute);
    final base = parsed.hasScheme ? parsed : apiBase.resolveUri(parsed);
    final scheme = switch (base.scheme) { 'https' || 'wss' => 'wss', _ => 'ws' };
    return base.replace(scheme: scheme);
  }
}
