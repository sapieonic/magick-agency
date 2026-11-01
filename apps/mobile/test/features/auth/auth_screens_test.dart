import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/auth/auth_service.dart';
import 'package:magick_agency_agent/core/auth/fake_auth_service.dart';
import 'package:magick_agency_agent/features/auth/auth_widgets.dart';
import 'package:magick_agency_agent/features/auth/no_membership_screen.dart';
import 'package:magick_agency_agent/features/auth/sign_in_screen.dart';
import 'package:magick_agency_agent/features/auth/update_required_screen.dart';
import 'package:magick_agency_agent/features/auth/verify_email_screen.dart';

import '../../core/auth/support/harness.dart';

void main() {
  late Harness h;

  Future<ProviderContainer> started(WidgetTester tester, {List<Override> extra = const []}) async {
    final c = ProviderContainer.test(overrides: [...h.overrides, ...extra]);
    await tester.runAsync(() => startGate(c));
    return c;
  }

  setUp(() => h = Harness());

  group('Sign in', () {
    testWidgets('mock 1 copy: both ways in, reset, and how to get an account', (tester) async {
      final c = await started(tester);
      await pumpScreen(tester, c, const SignInScreen());
      expect(find.text('Sign in'), findsWidgets);
      expect(find.text('Magick Agency · for agents'), findsOneWidget);
      expect(find.text('Continue with Google'), findsOneWidget);
      expect(find.text('Reset it'), findsOneWidget);
      expect(find.text('No account? Ask your supervisor for an invite.'), findsOneWidget);
    });

    testWidgets('empty fields are caught before Firebase', (tester) async {
      final c = await started(tester);
      await pumpScreen(tester, c, const SignInScreen());
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pump();
      expect(find.text('Enter your email and password.'), findsOneWidget);
    });

    testWidgets('a wrong password shows the mapped copy, not Firebase\'s', (tester) async {
      h.auth.addPasswordAccount('meera.k@acmecollect.in', 'right');
      final c = await started(tester);
      await pumpScreen(tester, c, const SignInScreen());
      await tester.enterText(find.byKey(const Key('sign-in-email')), 'meera.k@acmecollect.in');
      await tester.enterText(find.byKey(const Key('sign-in-password')), 'wrong');
      await tapVisible(tester, find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();
      expect(find.text('That email and password don\'t match. Try again, or reset your password.'), findsOneWidget);
    });

    testWidgets('a right password signs in (the gate becomes ready)', (tester) async {
      h.auth.addPasswordAccount('meera.k@acmecollect.in', 'right', uid: 'fb-u1');
      final c = await started(tester);
      await pumpScreen(tester, c, const SignInScreen());
      await tester.enterText(find.byKey(const Key('sign-in-email')), 'meera.k@acmecollect.in');
      await tester.enterText(find.byKey(const Key('sign-in-password')), 'right');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(c.read(appGateProvider), isA<GateReady>());
    });

    testWidgets('closing the Google sheet is not an error', (tester) async {
      final c = await started(tester);
      await pumpScreen(tester, c, const SignInScreen());
      await tapVisible(tester, find.text('Continue with Google'));
      await tester.pumpAndSettle();
      expect(find.byType(FormMessage), findsNothing);
    });

    testWidgets('the expiry notice from a 401 is shown', (tester) async {
      final c = await started(tester);
      await tester.runAsync(() async {
        h.auth.externalSignIn(meera);
        await settle();
        c.read(appGateProvider.notifier).reportUnauthorized();
        await settle();
      });
      await pumpScreen(tester, c, const SignInScreen());
      expect(find.text(sessionExpiredNotice), findsOneWidget);
    });

    testWidgets('forgot password: sends to the typed address and says where it went', (tester) async {
      final c = await started(tester);
      await pumpScreen(tester, c, const SignInScreen());
      await tester.enterText(find.byKey(const Key('sign-in-email')), 'meera.k@acmecollect.in');
      await tapVisible(tester, find.text('Reset it'));
      await tester.pumpAndSettle();
      expect(find.text('Reset your password'), findsOneWidget);
      await tapVisible(tester, find.text('Send reset link'));
      await tester.pumpAndSettle();
      expect(h.auth.resetEmailsSent, ['meera.k@acmecollect.in']);
      expect(find.textContaining('We sent a password reset link to meera.k@acmecollect.in'), findsOneWidget);
      await tapVisible(tester, find.text('Back to sign in'));
      await tester.pumpAndSettle();
      expect(find.text('Continue with Google'), findsOneWidget);
    });

    testWidgets('forgot password: unknown address → the console\'s sentence', (tester) async {
      h.auth.failNext('user-not-found');
      final c = await started(tester);
      await pumpScreen(tester, c, const SignInScreen());
      await tapVisible(tester, find.text('Reset it'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('reset-email')), 'nobody@x.in');
      await tapVisible(tester, find.text('Send reset link'));
      await tester.pumpAndSettle();
      expect(find.text('No account found with this email address'), findsOneWidget);
    });
  });

  group('No membership', () {
    testWidgets('names the address and signs out to try another', (tester) async {
      h = Harness(auth: FakeAuthService(signedIn: meera), server: h.server);
      h.server.json('POST', '/auth/session', {'code': 'no_membership', 'message': 'x'}, status: 403);
      final c = await started(tester);
      expect(c.read(appGateProvider), isA<GateNoMembership>());
      await pumpScreen(tester, c, const NoMembershipScreen());
      expect(find.text('We don’t recognise that account'), findsOneWidget);
      expect(find.textContaining('meera.k@acmecollect.in', findRichText: true), findsOneWidget);
      await tapVisible(tester, find.text('Try a different account'));
      // The button spins until the router moves the screen away.
      await tester.pump();
      await tester.pump();
      expect(c.read(appGateProvider), const GateSignedOut());
      expect(h.auth.signOuts, 1);
    });
  });

  group('Verify email', () {
    setUp(() {
      h = Harness(
        auth: FakeAuthService(signedIn: const AuthUser(uid: 'fb-u1', email: 'meera.k@acmecollect.in', usesPassword: true)),
      );
      h.server.json('POST', '/auth/session', {'code': 'email_unverified', 'message': 'x'}, status: 403);
    });

    testWidgets('not yet verified → says so; resend → confirms', (tester) async {
      final c = await started(tester);
      await pumpScreen(tester, c, const VerifyEmailScreen());
      expect(find.textContaining('meera.k@acmecollect.in', findRichText: true), findsOneWidget);
      await tapVisible(tester, find.text('I’ve verified my email'));
      await tester.pumpAndSettle();
      expect(find.text('Email not verified yet. Please check your inbox and click the verification link.'), findsOneWidget);
      final before = h.auth.verificationEmailsSent;
      await tapVisible(tester, find.text('Resend verification email'));
      await tester.pumpAndSettle();
      expect(find.text('Verification email sent!'), findsOneWidget);
      expect(h.auth.verificationEmailsSent, before + 1);
    });

    testWidgets('verified → the gate moves on', (tester) async {
      final c = await started(tester);
      await pumpScreen(tester, c, const VerifyEmailScreen());
      h.auth.verifyOnReload = true;
      h.server.standard();
      await tapVisible(tester, find.text('I’ve verified my email'));
      await tester.pumpAndSettle();
      expect(c.read(appGateProvider), isA<GateReady>());
    });
  });

  group('Update required', () {
    testWidgets('opens this platform\'s store link', (tester) async {
      h.server.json('GET', '/client-config', clientConfigJson(minSupported: '2.0.0'));
      final opened = <Uri>[];
      final c = await started(tester, extra: [
        externalLinkProvider.overrideWithValue((uri) async {
          opened.add(uri);
          return true;
        }),
      ]);
      await pumpScreen(tester, c, const UpdateRequiredScreen());
      expect(find.text('Update the app'), findsOneWidget);
      expect(find.textContaining('needs 2.0.0 or later'), findsOneWidget);
      await tapVisible(tester, find.text('Update now'));
      await tester.pumpAndSettle();
      expect(opened.single.toString(), 'https://play.google.com/store/apps/details?id=x');
    });

    testWidgets('a store that will not open says what to do instead', (tester) async {
      h.server.json('GET', '/client-config', clientConfigJson(minSupported: '2.0.0'));
      final c = await started(tester, extra: [externalLinkProvider.overrideWithValue((_) async => false)]);
      await pumpScreen(tester, c, const UpdateRequiredScreen());
      await tapVisible(tester, find.text('Update now'));
      await tester.pumpAndSettle();
      expect(find.textContaining('We couldn’t open the store'), findsOneWidget);
    });
  });
}
