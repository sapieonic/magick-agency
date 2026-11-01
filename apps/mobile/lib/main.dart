import 'dart:async';
import 'dart:io' show Platform;

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app.dart';
import 'app/providers.dart';
import 'core/api/client_identity.dart';
import 'core/auth/firebase_token_source.dart';
import 'core/env.dart';
import 'core/telemetry/log.dart';

final _log = Log('main');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final env = Env.fromDefines();

  FlutterError.onError = (details) {
    _log.error('Flutter error', {'library': details.library}, details.exception, details.stack);
    if (kDebugMode) FlutterError.presentError(details);
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    _log.error('Uncaught error', const {}, error, stack);
    return true;
  };

  // Both reads hit platform channels; run them together.
  final identityFuture = ClientIdentity.load();
  final firebaseFuture = env.hasFirebase ? _initFirebase(env) : Future<void>.value();
  final identity = await identityFuture;
  await firebaseFuture;

  _log.info('Starting', {'flavor': env.flavor, 'client': identity.header});

  runApp(
    ProviderScope(
      overrides: [
        envProvider.overrideWithValue(env),
        clientIdentityProvider.overrideWithValue(identity),
        idTokenSourceProvider.overrideWithValue(
          env.hasFirebase ? FirebaseIdTokenSource(FirebaseAuth.instance) : const NoIdTokenSource(),
        ),
      ],
      child: const AgentApp(),
    ),
  );
}

Future<void> _initFirebase(Env env) => Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: env.firebaseApiKey,
        projectId: env.firebaseProjectId,
        appId: Platform.isIOS ? env.firebaseAppIdIos : env.firebaseAppIdAndroid,
        messagingSenderId: env.firebaseMessagingSenderId,
        iosClientId: env.googleIosClientId.isEmpty ? null : env.googleIosClientId,
      ),
    );
