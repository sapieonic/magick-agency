import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import 'app/app.dart';
import 'app/providers.dart';
import 'core/api/api_client.dart' show IdTokenSource;
import 'core/api/client_identity.dart';
import 'core/auth/firebase_token_source.dart';
import 'core/env.dart';
import 'core/softphone/softphone_controller.dart';
import 'core/station/station_controller.dart';
import 'core/station/station_deps.dart';
import 'core/telemetry/log.dart';
import 'features/preflight/device_preflight_checks.dart';
import 'features/preflight/preflight_checks.dart';

final _log = Log('main');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  var env = Env.fromDefines();

  FlutterError.onError = (details) {
    _log.error('Flutter error', {'library': details.library}, details.exception, details.stack);
    if (kDebugMode) FlutterError.presentError(details);
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    _log.error('Uncaught error', const {}, error, stack);
    return true;
  };

  // Both reads hit platform channels; run them together. Neither may keep
  // the app on the native launch screen: a failure is logged and the app
  // starts anyway (a generic client header, or signed out without Firebase).
  final identityFuture = loadIdentity(ClientIdentity.load);
  final firebaseReady = env.hasFirebase ? startFirebase(() => _initFirebase(env)) : Future.value(false);
  final identity = await identityFuture;
  if (env.hasFirebase && !await firebaseReady) env = env.withoutFirebase();

  _log.info('Starting', {'flavor': env.flavor, 'client': identity.header});

  runApp(
    ProviderScope(
      overrides: appOverrides(
        env: env,
        identity: identity,
        idTokens: env.hasFirebase ? FirebaseIdTokenSource(FirebaseAuth.instance) : const NoIdTokenSource(),
      ),
      child: const AgentApp(),
    ),
  );
}

/// What the app's `ProviderScope` overrides: the real environment, identity
/// and sign-in, and the cores behind the screens' seams. A function, so a test
/// can check that each core is plugged in.
///
/// Each core's app-lifecycle source is its own provider's default (a real
/// `FlutterAppLifecycleSource`, one per core: one source keeps one listener).
@visibleForTesting
List<Override> appOverrides({required Env env, required ClientIdentity identity, required IdTokenSource idTokens}) => [
      envProvider.overrideWithValue(env),
      clientIdentityProvider.overrideWithValue(identity),
      idTokenSourceProvider.overrideWithValue(idTokens),
      // The station core behind the screens' seam (station_view.dart); it also
      // hosts the soft-phone session (softphone_host.dart).
      ...stationOverrides,
      // The soft phone's call domain behind the Phone tab's and the panel's
      // seam (softphone_view.dart), and the Phone tab's availability.
      ...softphoneOverrides,
      // Pre-flight measures with the station's own voice engine instance, never
      // a second one. The soft phone asks it for the microphone permission too.
      preflightChecksProvider.overrideWith(
        (ref) => DevicePreflightChecks(audio: ref.watch(agentAudioPluginProvider), api: ref.watch(apiClientProvider)),
      ),
    ];

/// The client identity, or a generic one when the platform reads fail.
@visibleForTesting
Future<ClientIdentity> loadIdentity(Future<ClientIdentity> Function() load) async {
  try {
    return await load();
  } catch (e, st) {
    _log.error('Reading the app version and device failed; starting with a generic identity', const {}, e, st);
    return ClientIdentity.unknown;
  }
}

/// Initialises Firebase; false (logged) when it cannot, so the app starts
/// signed out rather than hanging on the launch screen.
@visibleForTesting
Future<bool> startFirebase(Future<void> Function() init) async {
  try {
    await init();
    return true;
  } catch (e, st) {
    _log.error('Firebase did not start; running without sign-in', const {}, e, st);
    return false;
  }
}

Future<void> _initFirebase(Env env) => Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: env.firebaseApiKey,
        projectId: env.firebaseProjectId,
        appId: env.firebaseAppId,
        messagingSenderId: env.firebaseMessagingSenderId,
        iosClientId: env.googleIosClientId.isEmpty ? null : env.googleIosClientId,
      ),
    );
