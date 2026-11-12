import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/auth/auth_service.dart';
import 'package:magick_agency_agent/core/auth/fake_auth_service.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/features/join/invite_screen.dart';

import '../../core/auth/support/harness.dart';

void main() {
  late Harness h;

  Future<ProviderContainer> started(WidgetTester tester) async {
    final c = ProviderContainer.test(overrides: h.overrides);
    await tester.runAsync(() => startGate(c));
    return c;
  }

  setUp(() => h = Harness());

  testWidgets('mock 2: the invitation, its details, both ways in and what happens next', (tester) async {
    h.server.json('GET', '/invites/tok', inviteJson());
    final c = await started(tester);
    await pumpScreen(tester, c, const InviteScreen(token: 'tok'));
    expect(find.text('Invitation'), findsOneWidget);
    expect(find.text('You’ve been set up as an Agent'), findsOneWidget);
    expect(find.text('Acme Collections'), findsOneWidget);
    expect(find.text('Rahul Menon'), findsOneWidget);
    expect(find.text('meera.k@acmecollect.in'), findsOneWidget);
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.text('Create a password'), findsOneWidget);
    expect(find.text('Set up how you sign in'), findsOneWidget);
    expect(find.text('Allow the microphone'), findsOneWidget);
    expect(find.text('Your campaigns appear'), findsOneWidget);
  });

  testWidgets('no inviter or organisation name: those rows are simply absent', (tester) async {
    h.server.json('GET', '/invites/tok', inviteJson(tenantName: null, inviterName: null));
    final c = await started(tester);
    await pumpScreen(tester, c, const InviteScreen(token: 'tok'));
    expect(find.text('Organisation'), findsNothing);
    expect(find.text('Invited by'), findsNothing);
    expect(find.text('Expires'), findsOneWidget);
  });

  testWidgets('the password form: read-only invited address and a live strength line', (tester) async {
    h.server.json('GET', '/invites/tok', inviteJson());
    final c = await started(tester);
    await pumpScreen(tester, c, const InviteScreen(token: 'tok'));
    await tapVisible(tester, find.text('Create a password'));
    await tester.pumpAndSettle();
    final email = tester.widget<EditableText>(find.descendant(of: find.byKey(const Key('invite-email')), matching: find.byType(EditableText)));
    expect(email.readOnly, isTrue);
    await tester.enterText(find.byKey(const Key('invite-password')), 'abc');
    await tester.pump();
    expect(find.text('Too short · At least 8 characters — 5 to go.'), findsOneWidget);
  });

  testWidgets('claimed → its screen, with the way to sign in', (tester) async {
    h.server.json('GET', '/invites/tok', {'status': 'claimed'});
    final c = await started(tester);
    await pumpScreen(tester, c, const InviteScreen(token: 'tok'));
    expect(find.text('This invitation has already been used'), findsOneWidget);
    await tapVisible(tester, find.text('Go to sign in'));
    await tester.pumpAndSettle();
    expect(find.text('at /sign-in'), findsOneWidget);
  });

  group('every dead end has a way out', () {
    for (final status in ['expired', 'revoked', 'not_found']) {
      testWidgets('$status, signed out → to sign-in', (tester) async {
        h.server.json('GET', '/invites/tok', {'status': status});
        final c = await started(tester);
        await pumpScreen(tester, c, const InviteScreen(token: 'tok'));
        await tapVisible(tester, find.text('Go to sign in'));
        await tester.pumpAndSettle();
        expect(find.text('at /sign-in'), findsOneWidget);
      });
    }

    testWidgets('expired, signed in → back to the app', (tester) async {
      h = Harness(auth: FakeAuthService(signedIn: meera), server: h.server, store: h.store);
      h.server.json('GET', '/invites/tok', {'status': 'expired'});
      final c = await started(tester);
      expect(c.read(appGateProvider), isA<GateReady>());
      await pumpScreen(tester, c, const InviteScreen(token: 'tok'));
      expect(find.text('This invitation has expired'), findsOneWidget);
      expect(find.text('Go to sign in'), findsNothing);
      await tapVisible(tester, find.text('Back to the app'));
      await tester.pumpAndSettle();
      expect(find.text('at /home'), findsOneWidget);
    });

    testWidgets('an invitation for the web console → a way out', (tester) async {
      h.server.json('GET', '/invites/tok', inviteJson(role: 'operator'));
      final c = await started(tester);
      await pumpScreen(tester, c, const InviteScreen(token: 'tok'));
      expect(find.text('Open this invitation on a computer'), findsOneWidget);
      await tapVisible(tester, find.text('Go to sign in'));
      await tester.pumpAndSettle();
      expect(find.text('at /sign-in'), findsOneWidget);
    });

    testWidgets('unreachable → a way out beside Try again', (tester) async {
      h.server.offline('GET', '/invites/tok');
      final c = await started(tester);
      await pumpScreen(tester, c, const InviteScreen(token: 'tok'));
      await tapVisible(tester, find.text('Go to sign in'));
      await tester.pumpAndSettle();
      expect(find.text('at /sign-in'), findsOneWidget);
    });
  });

  testWidgets('unreachable → Try again reads it again', (tester) async {
    h.server.offline('GET', '/invites/tok');
    final c = await started(tester);
    await pumpScreen(tester, c, const InviteScreen(token: 'tok'));
    expect(find.text('We could not open your invitation'), findsOneWidget);
    h.server.json('GET', '/invites/tok', inviteJson());
    await tapVisible(tester, find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Continue with Google'), findsOneWidget);
  });

  testWidgets('Google at the invited address → claimed and on to the campaigns', (tester) async {
    h.auth.googleUser = meera;
    h.server.json('GET', '/invites/tok', inviteJson());
    h.server.json('POST', '/invites/tok/claim', sessionJson(
      tenants: [tenantJson('t1', 'Acme Collections')],
      memberships: [membershipJson('t1', accountId: 'a1')],
    ));
    final c = await started(tester);
    await pumpScreen(tester, c, const InviteScreen(token: 'tok'));
    await tapVisible(tester, find.text('Continue with Google'));
    await tester.pumpAndSettle();
    expect(find.text('at /home'), findsOneWidget);
  });

  testWidgets('claimed into one of several accounts → on to the account picker', (tester) async {
    h.auth.googleUser = meera;
    h.server.json('GET', '/invites/tok', inviteJson());
    h.server.json('POST', '/invites/tok/claim', sessionJson(
      tenants: [tenantJson('t1', 'Acme Collections')],
      memberships: [membershipJson('t1', accountId: 'a1')],
    ));
    h.server.on('GET', '/accounts/mine', (_) => jsonResponse({
          'accounts': [accountJson('a1', 'Chennai', 't1'), accountJson('a2', 'Pune', 't1')],
        }));
    final c = await started(tester);
    await pumpScreen(tester, c, const InviteScreen(token: 'tok'), extraRoutes: const ['/home', '/sign-in', '/accounts']);
    await tapVisible(tester, find.text('Continue with Google'));
    await tester.pumpAndSettle();
    expect(c.read(appGateProvider), isA<GateNeedsAccount>());
    expect(find.text('at /accounts'), findsOneWidget);
  });

  testWidgets('a different Google address asks first, with both addresses', (tester) async {
    h.auth.googleUser = const AuthUser(uid: 'g1', email: 'meera.personal@gmail.com', emailVerified: true);
    h.server.json('GET', '/invites/tok', inviteJson());
    final c = await started(tester);
    await pumpScreen(tester, c, const InviteScreen(token: 'tok'));
    await tapVisible(tester, find.text('Continue with Google'));
    await tester.pumpAndSettle();
    expect(find.text('That is a different address'), findsOneWidget);
    expect(find.text('Use this account'), findsOneWidget);
    await tapVisible(tester, find.text('Use a different account'));
    await tester.pumpAndSettle();
    expect(find.text('Continue with Google'), findsOneWidget);
  });

  testWidgets('on duty: accepting is held back with the reason', (tester) async {
    h.server.json('GET', '/invites/tok', inviteJson());
    final c = await started(tester);
    c.read(testSignalsProvider.notifier).set(const StationSignals(onDuty: true, campaignId: 'c1'));
    await pumpScreen(tester, c, const InviteScreen(token: 'tok'));
    expect(find.text('You’re on duty. Leave the station before accepting an invitation.'), findsOneWidget);
    expect(find.text('Continue with Google'), findsNothing);
    await tapVisible(tester, find.text('Back to your station'));
    await tester.pumpAndSettle();
    expect(find.text('at /home/station/c1'), findsOneWidget);
  });
}
