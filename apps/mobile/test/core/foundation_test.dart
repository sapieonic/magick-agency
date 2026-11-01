import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/core/api/client_identity.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/env.dart';
import 'package:magick_agency_agent/core/telemetry/log.dart';
import 'package:magick_agency_agent/main.dart';

Env _env(String origin, {String key = '', String project = '', String android = '', String ios = ''}) => Env(
      flavor: 'test',
      apiOrigin: origin,
      firebaseApiKey: key,
      firebaseProjectId: project,
      firebaseAppIdAndroid: android,
      firebaseAppIdIos: ios,
      firebaseMessagingSenderId: '',
      googleIosClientId: '',
      googleServerClientId: '',
      posthogKey: '',
      posthogHost: '',
    );

void main() {
  group('Env.resolveStationUrl', () {
    test('a relative station path becomes wss on an https origin, query kept', () {
      final u = _env('https://agency.example.com').resolveStationUrl('/proxy/agency/station/s1?token=abc');
      expect(u.toString(), 'wss://agency.example.com/proxy/agency/station/s1?token=abc');
    });

    test('http dev origins become ws with the port kept', () {
      final u = _env('http://10.0.2.2:3021').resolveStationUrl('/proxy/agency/station/s1?token=t');
      expect(u.toString(), 'ws://10.0.2.2:3021/proxy/agency/station/s1?token=t');
    });

    test('an absolute https URL is converted, not re-based', () {
      final u = _env('https://a.example').resolveStationUrl('https://b.example/proxy/agency/station/s?token=t');
      expect(u.toString(), 'wss://b.example/proxy/agency/station/s?token=t');
    });
  });

  group('start-up never hangs on the launch screen', () {
    tearDown(() => debugDefaultTargetPlatformOverride = null);

    test('Firebase counts as configured only with this platform\'s app id', () {
      final androidOnly = _env('https://a', key: 'k', project: 'p', android: '1:2:android:3');
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      expect(androidOnly.hasFirebase, isTrue);
      expect(_env('https://a', key: 'k', project: 'p').hasFirebase, isFalse);
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      expect(androidOnly.hasFirebase, isFalse);
      expect(androidOnly.withoutFirebase().hasFirebase, isFalse);
      expect(androidOnly.withoutFirebase().apiOrigin, 'https://a');
    });

    test('Firebase failing to start is false (signed out), not a throw', () async {
      expect(await startFirebase(() async {}), isTrue);
      expect(await startFirebase(() async => throw Exception('ApplicationId must be set')), isFalse);
    });

    test('the device reads failing give a generic identity the update gate does not judge', () async {
      final identity = await loadIdentity(() async => throw Exception('platform channel'));
      expect(identity.versionKnown, isFalse);
      expect(identity.header, startsWith('magick-agency-mobile/unknown+0'));
      expect(ClientIdentity.test.versionKnown, isTrue);
    });
  });

  group('Log.mask', () {
    test('masks phone numbers in any common format, keeping two digits', () {
      expect(Log.mask('dialled +91 98400 12345 ok'), 'dialled <tel …45> ok');
      expect(Log.mask('to +919840012345'), 'to <tel …45>');
      expect(Log.mask('raw 9840012345'), 'raw <tel …45>');
    });

    test('masks emails', () {
      expect(Log.mask('user meera.k@acme.in signed in'), 'user <email> signed in');
    });

    test('leaves dates, durations and hex ids alone', () {
      const line = '2026-11-01T10:00:00Z took 1234ms id=8f3a1234567890ab attempt 3';
      expect(Log.mask(line), line);
    });

    test('masks the separated and bracketed ways people write a number', () {
      expect(Log.mask('to +91-98400-12345.'), 'to <tel …45>.');
      expect(Log.mask('call 98400 12345 now'), 'call <tel …45> now');
      expect(Log.mask('trunk 098400-12345'), 'trunk <tel …45>');
      expect(Log.mask('us +1 (415) 555-0100'), 'us <tel …00>');
      expect(Log.mask('us (415) 555-0100'), 'us <tel …00>');
      expect(Log.mask('dotted 415.555.0100'), 'dotted <tel …00>');
      expect(Log.mask('number=+44 20 7946 0958,'), 'number=<tel …58>,');
    });

    test('leaves the other numbers a log line carries alone', () {
      for (final line in [
        'DateTime 2026-11-01 10:00:00.000 local',
        'iso 2026-11-01T10:00:00.000Z',
        'request_id=0123456789abcdef0123456789abcdef',
        'uuid 123e4567-e89b-12d3-a456-426614174000',
        'uuid 12345678-1234-1234-1234-123456789012',
        'GET /proxy/agency/stats → 200 in 132ms',
        'magick-agency-mobile/1.4.0+42 (android 14; Pixel 8)',
        'kbps 1234.5678901 retry 3 of 5',
        'address = 192.168.100.200, port = 3021',
        'build 2026 11 01',
        'in_s 30 silent_s 120',
      ]) {
        expect(Log.mask(line), line, reason: line);
      }
    });

    test('field values that are not strings are masked too, and keep their type when clean', () {
      expect(Log.maskField(9840012345), '<tel …45>');
      expect(Log.maskField(503), 503);
      expect(Log.maskField(1.5), 1.5);
      expect(Log.maskField(true), true);
      expect(Log.maskField(null), isNull);
      expect(Log.maskField(Exception('dial +91 98400 12345 failed')), 'Exception: dial <tel …45> failed');
      expect(Log.maskField(['meera.k@acme.in']), '[<email>]');
    });

    test('an exported line never carries a number given as a field', () {
      Log.clear();
      Log('test').warn('x', {'to': 9840012345, 'err': StateError('to 98400 12345')});
      final line = Log.recent().last.toString();
      expect(line, isNot(contains('9840012345')));
      expect(line, isNot(contains('98400 12345')));
    });
  });

  test('X-Client header is printable ASCII in the agreed shape', () {
    const id = ClientIdentity(version: '1.2.3', build: '45', platform: 'android', osVersion: '14', model: 'Xiaomi 23 ✨');
    expect(id.header, 'magick-agency-mobile/1.2.3+45 (android 14; Xiaomi 23 )');
  });

  group('gateRedirect', () {
    const ready = GateReady(
      userId: 'u',
      displayName: 'Meera',
      email: 'm@x.in',
      tenantId: 't',
      accountId: 'a',
      accountName: 'Acme',
    );

    test('loading holds on the splash but keeps an invite link', () {
      expect(gateRedirect(const GateLoading(), Routes.home), Routes.splash);
      expect(gateRedirect(const GateLoading(), Routes.invite('tok')), isNull);
    });

    test('signed out may open sign-in and invites only', () {
      expect(gateRedirect(const GateSignedOut(), Routes.home), Routes.signIn);
      expect(gateRedirect(const GateSignedOut(), Routes.signIn), isNull);
      expect(gateRedirect(const GateSignedOut(), Routes.invite('tok')), isNull);
    });

    test('no membership may still claim an invite', () {
      expect(gateRedirect(const GateNoMembership(email: null), Routes.home), Routes.noMembership);
      expect(gateRedirect(const GateNoMembership(email: null), Routes.invite('tok')), isNull);
    });

    test('update required wins everywhere', () {
      expect(gateRedirect(const GateUpdateRequired(storeUrl: null, minSupported: '9.0.0'), Routes.invite('t')), Routes.updateRequired);
    });

    test('ready leaves start-up screens for home and allows the rest', () {
      expect(gateRedirect(ready, Routes.splash), Routes.home);
      expect(gateRedirect(ready, Routes.signIn), Routes.home);
      expect(gateRedirect(ready, Routes.accounts), Routes.home);
      expect(gateRedirect(ready, Routes.station('c1')), isNull);
      expect(gateRedirect(ready, Routes.invite('tok')), isNull);
    });

    test('needs-account pins the picker', () {
      expect(gateRedirect(const GateNeedsAccount(), Routes.home), Routes.accounts);
    });
  });
}
