import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/core/api/client_identity.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/env.dart';
import 'package:magick_agency_agent/core/telemetry/log.dart';

Env _env(String origin) => Env(
      flavor: 'test',
      apiOrigin: origin,
      firebaseApiKey: '',
      firebaseProjectId: '',
      firebaseAppIdAndroid: '',
      firebaseAppIdIos: '',
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
