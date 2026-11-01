import 'dart:async';

import 'package:posthog_flutter/posthog_flutter.dart';

import '../env.dart';
import 'log.dart';
import 'telemetry.dart';

final _log = Log('telemetry');

/// The [TelemetrySink] over PostHog. Every call is fire-and-forget: the SDK
/// queues and sends in batches, and a failure is the SDK's to retry.
final class PosthogSink implements TelemetrySink {
  PosthogSink(this._posthog, {this.base = const {}}) {
    register(base);
  }

  final Posthog _posthog;

  /// The build's own properties (flavour, server): registered again after a
  /// [reset], which clears every registered property.
  final Map<String, Object> base;

  @override
  void capture(String event, Map<String, Object> properties) =>
      unawaited(_posthog.capture(eventName: event, properties: properties));

  @override
  void captureException(Object error, StackTrace? stack, Map<String, Object> properties) =>
      unawaited(_posthog.captureException(error: error, stackTrace: stack, properties: properties));

  @override
  void identify(String userId) => unawaited(_posthog.identify(userId: userId));

  @override
  void register(Map<String, Object> properties) {
    for (final e in properties.entries) {
      unawaited(_posthog.register(e.key, e.value));
    }
  }

  @override
  void group(String type, String key) => unawaited(_posthog.group(groupType: type, groupKey: key));

  @override
  void reset() => unawaited(_posthog.reset().then((_) => register(base)));
}

/// What every event from this build carries. `product` and `environment` are
/// the console's super properties, so one dashboard reads both clients;
/// `client` tells them apart, and `api_host` which server the build talks to
/// (a dev build can point at staging).
Map<String, Object> posthogBaseProperties(Env env) => {
      'product': 'agency',
      'client': 'mobile',
      'environment': env.flavor,
      'api_host': Uri.tryParse(env.apiOrigin)?.host ?? '',
    };

/// PostHog's settings for this build, or null without a key (no telemetry).
///
/// No session replay, surveys or feature flags: events and errors only. Native
/// exceptions are captured (the voice engine is Kotlin and Swift); Dart errors
/// come through [Log] (`main.dart`'s handlers), masked, so the SDK's own Dart
/// error hooks stay off.
PostHogConfig? posthogConfig(Env env) {
  if (env.posthogKey.isEmpty) return null;
  final config = PostHogConfig(env.posthogKey)
    ..captureApplicationLifecycleEvents = true
    ..sessionReplay = false
    ..surveys = false
    ..preloadFeatureFlags = false
    ..sendFeatureFlagEvent = false
    ..personProfiles = PostHogPersonProfiles.identifiedOnly;
  if (env.posthogHost.isNotEmpty) config.host = env.posthogHost;
  config.errorTrackingConfig
    ..captureFlutterErrors = false
    ..capturePlatformDispatcherErrors = false
    ..captureNativeExceptions = true;
  return config;
}

/// PostHog started for this build, its every event tagged as the console's
/// are (`product`, `environment`) and with the client and the server it talks
/// to; null without a key, or when the SDK does not
/// start in time (logged: the app runs without telemetry rather than late).
Future<TelemetrySink?> startPosthog(Env env, {Duration timeout = const Duration(seconds: 5)}) async {
  final config = posthogConfig(env);
  if (config == null) return null;
  try {
    final posthog = Posthog();
    await posthog.setup(config).timeout(timeout);
    return PosthogSink(posthog, base: posthogBaseProperties(env));
  } catch (e, st) {
    _log.error('PostHog did not start; running without telemetry', const {}, e, st);
    return null;
  }
}
