import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/env.dart';
import 'package:magick_agency_agent/core/telemetry/posthog_sink.dart';

/// PostHog's settings: nothing without a key; events and errors only with one,
/// and Dart errors left to the app's own (masked) handlers.
void main() {
  Env env({String key = '', String host = ''}) => Env(
        flavor: 'dev',
        apiOrigin: 'https://api.test',
        firebaseApiKey: '',
        firebaseProjectId: '',
        firebaseAppIdAndroid: '',
        firebaseAppIdIos: '',
        firebaseMessagingSenderId: '',
        googleIosClientId: '',
        googleServerClientId: '',
        posthogKey: key,
        posthogHost: host,
      );

  test('no key: no PostHog', () {
    expect(posthogConfig(env()), isNull);
  });

  test('a key: events, lifecycle and native exceptions; no replay, surveys or flags; Dart errors not hooked', () {
    final c = posthogConfig(env(key: 'phc_test'))!;
    expect(c.projectToken, 'phc_test');
    expect(c.captureApplicationLifecycleEvents, isTrue);
    expect(c.sessionReplay, isFalse);
    expect(c.surveys, isFalse);
    expect(c.preloadFeatureFlags, isFalse);
    expect(c.errorTrackingConfig.captureNativeExceptions, isTrue);
    expect(c.errorTrackingConfig.captureFlutterErrors, isFalse, reason: 'unmasked: main.dart reports them through Log');
    expect(c.errorTrackingConfig.capturePlatformDispatcherErrors, isFalse, reason: 'unmasked: main.dart reports them through Log');
  });

  test('the host is the build’s when it names one, else the SDK’s default', () {
    expect(posthogConfig(env(key: 'k', host: 'https://eu.i.posthog.com'))!.host, 'https://eu.i.posthog.com');
    expect(posthogConfig(env(key: 'k'))!.host, isNotEmpty);
  });
}
