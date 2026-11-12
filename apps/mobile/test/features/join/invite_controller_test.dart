import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/auth/auth_service.dart';
import 'package:magick_agency_agent/features/join/invite_controller.dart';
import 'package:magick_agency_agent/features/join/invite_copy.dart';

import '../../core/auth/support/harness.dart';

void main() {
  late Harness h;
  late ProviderContainer c;

  const token = 'tok';
  final provider = inviteControllerProvider(token);

  Future<InviteController> open({Map<String, Object?>? lookup, int status = 200}) async {
    h.server.json('GET', '/invites/$token', lookup ?? inviteJson(), status: status);
    c = h.container();
    await startGate(c);
    c.listen(provider, (_, _) {});
    await settle();
    return c.read(provider.notifier);
  }

  void claimAnswers(Object? body, {int status = 200}) => h.server.json('POST', '/invites/$token/claim', body, status: status);

  void claimSucceeds() => claimAnswers(sessionJson(
        tenants: [tenantJson('t1', 'Acme Collections')],
        memberships: [membershipJson('t1', accountId: 'a1')],
      ));

  setUp(() => h = Harness());

  group('lookup', () {
    test('pending → the invitation', () async {
      await open();
      final s = c.read(provider);
      expect(s.phase, InvitePhase.pending);
      expect(s.invite!.tenantName, 'Acme Collections');
    });

    for (final status in ['claimed', 'expired', 'revoked', 'identity_already_bound']) {
      test('$status → its own unavailable screen', () async {
        await open(lookup: {'status': status});
        expect(c.read(provider).phase, InvitePhase.unavailable);
        expect(c.read(provider).status, InviteStatus.fromWire(status));
      });
    }

    test('404 not_found → unavailable(not_found)', () async {
      await open(lookup: {'status': 'not_found'}, status: 404);
      expect(c.read(provider).status, InviteStatus.notFound);
    });

    test('a failed lookup → unreachable, and Try again looks it up again', () async {
      h.server.offline('GET', '/invites/$token');
      c = h.container();
      await startGate(c);
      c.listen(provider, (_, _) {});
      await settle();
      expect(c.read(provider).phase, InvitePhase.unreachable);
      expect(c.read(provider).unreachableMessage, isNotEmpty);
      h.server.json('GET', '/invites/$token', inviteJson());
      await c.read(provider.notifier).load();
      expect(c.read(provider).phase, InvitePhase.pending);
    });

    test('an invitation for another role is accepted on the web, not here', () async {
      await open(lookup: inviteJson(role: 'operator'));
      expect(c.read(provider).phase, InvitePhase.wrongApp);
    });
  });

  group('Google', () {
    test('the invited address → claimed, signed in, no /auth/session in between', () async {
      h.auth.googleUser = meera;
      claimSucceeds();
      final ctl = await open();
      await ctl.continueWithGoogle();
      await settle();
      expect(c.read(provider).phase, InvitePhase.done);
      expect(c.read(appGateProvider), isA<GateReady>());
      expect(h.server.calls('POST', '/auth/session'), isEmpty);
    });

    test('another address → confirmation; "use this account" claims', () async {
      h.auth.googleUser = const AuthUser(uid: 'g1', email: 'meera.personal@gmail.com', emailVerified: true);
      claimSucceeds();
      final ctl = await open();
      await ctl.continueWithGoogle();
      expect(c.read(provider).mismatch, isTrue);
      expect(c.read(provider).mismatchEmail, 'meera.personal@gmail.com');
      expect(h.server.calls('POST', '/invites/$token/claim'), isEmpty);
      await ctl.confirmMismatch();
      expect(c.read(provider).phase, InvitePhase.done);
    });

    test('another address → "use a different account" signs it out and returns to the options', () async {
      h.auth.googleUser = const AuthUser(uid: 'g1', email: 'other@gmail.com', emailVerified: true);
      final ctl = await open();
      await ctl.continueWithGoogle();
      await ctl.declineMismatch();
      expect(c.read(provider).mismatch, isFalse);
      expect(h.auth.currentUser, isNull);
      expect(c.read(appGateProvider.notifier).holdsInviteCredential, isFalse);
    });

    test('a seat that needs the invited address: no confirmation, signed out, told which address', () async {
      h.auth.googleUser = const AuthUser(uid: 'g1', email: 'other@gmail.com', emailVerified: true);
      final ctl = await open(lookup: inviteJson(requiresMatchingAddress: true));
      await ctl.continueWithGoogle();
      final s = c.read(provider);
      expect(s.addressRequired, isTrue);
      expect(s.mismatch, isFalse);
      expect(s.addressRequiredSignedInAs, 'other@gmail.com');
      expect(h.auth.currentUser, isNull);
      ctl.retryWithInvitedAddress();
      expect(c.read(provider).addressRequired, isFalse);
      expect(c.read(provider).showPassword, isTrue);
    });

    test('closing the Google sheet says so and holds nothing', () async {
      final ctl = await open();
      await ctl.continueWithGoogle();
      expect(c.read(provider).error, 'The Google window closed before you finished. Try again.');
      expect(c.read(provider).busy, InviteBusy.none);
      expect(c.read(appGateProvider.notifier).holdsInviteCredential, isFalse);
    });
  });

  group('password', () {
    test('a weak password is refused before the network', () async {
      final ctl = await open();
      ctl.revealPassword();
      await ctl.submitPassword('short');
      expect(c.read(provider).error, 'At least 8 characters — 3 to go.');
      expect(h.auth.currentUser, isNull);
    });

    test('create → claim → done; the address is the invited one', () async {
      claimSucceeds();
      final ctl = await open();
      ctl.revealPassword();
      await ctl.submitPassword('three unrelated words');
      expect(c.read(provider).phase, InvitePhase.done);
      expect(h.auth.currentUser!.email, 'meera.k@acmecollect.in');
      expect(jsonDecode(h.server.calls('POST', '/invites/$token/claim').single.body), {'id_token': 'token-uid-meera.k@acmecollect.in!'}); // minted for the claim
    });

    test('an address that already has a password → the form becomes a sign-in', () async {
      h.auth.addPasswordAccount('meera.k@acmecollect.in', 'existing-pass', uid: 'fb-u1');
      claimSucceeds();
      final ctl = await open();
      ctl.revealPassword();
      await ctl.submitPassword('a brand new one');
      final s = c.read(provider);
      expect(s.existingPassword, isTrue);
      expect(s.error, 'That address already has a password. Enter it and we will add this organisation to it.');
      // The strength rule does not apply to a password they already have.
      await ctl.submitPassword('existing-pass');
      expect(c.read(provider).phase, InvitePhase.done);
    });
  });

  group('claim refusals', () {
    test('identity_in_use → the server\'s sentence, with a way to sign in; the invitation stays', () async {
      h.auth.googleUser = meera;
      claimAnswers({'error': 'Conflict', 'message': 'That account already belongs to someone here.', 'status': 'identity_in_use'},
          status: 409);
      final ctl = await open();
      await ctl.continueWithGoogle();
      final s = c.read(provider);
      expect(s.phase, InvitePhase.pending);
      expect(s.error, 'That account already belongs to someone here.');
      expect(s.errorOffersSignIn, isTrue);
    });

    test('expired while the page was open → the expired screen, credential dropped', () async {
      h.auth.googleUser = meera;
      claimAnswers({'error': 'Gone', 'message': 'x', 'status': 'expired'}, status: 409);
      final ctl = await open();
      await ctl.continueWithGoogle();
      await settle();
      expect(c.read(provider).phase, InvitePhase.unavailable);
      expect(c.read(provider).status, InviteStatus.expired);
      expect(h.auth.currentUser, isNull);
    });

    test('address_required from the server → the address screen', () async {
      claimAnswers({'error': 'Conflict', 'message': 'x', 'status': 'address_required', 'email': 'meera.k@acmecollect.in'},
          status: 409);
      final ctl = await open();
      ctl.revealPassword();
      await ctl.submitPassword('three unrelated words');
      await settle();
      expect(c.read(provider).addressRequired, isTrue);
    });

    test('offline claim → a retryable message, credential still held', () async {
      h.auth.googleUser = meera;
      h.server.offline('POST', '/invites/$token/claim');
      final ctl = await open();
      await ctl.continueWithGoogle();
      expect(c.read(provider).error, contains('offline'));
      expect(c.read(appGateProvider.notifier).holdsInviteCredential, isTrue);
    });
  });

  test('leaving the page with an unclaimed credential drops it', () async {
    h.auth.googleUser = const AuthUser(uid: 'g1', email: 'other@gmail.com', emailVerified: true);
    h.server.json('GET', '/invites/$token', inviteJson());
    c = h.container();
    await startGate(c);
    final sub = c.listen(provider, (_, _) {});
    await settle();
    await c.read(provider.notifier).continueWithGoogle();
    expect(c.read(appGateProvider.notifier).holdsInviteCredential, isTrue);
    sub.close();
    await settle();
    expect(h.auth.currentUser, isNull);
    expect(c.read(appGateProvider.notifier).holdsInviteCredential, isFalse);
  });

  group('copy rules', () {
    test('assessPassword: floor, own address, then advice', () {
      expect(assessPassword('', 'meera@a.in').blocker, 'Choose a password.');
      expect(assessPassword('Meera1234!', 'meera@a.in').blocker, 'That contains your own address. Pick something unrelated to it.');
      expect(assessPassword('correct horse battery', 'meera@a.in').blocker, isNull);
      expect(assessPassword('Correct-Horse-9', 'meera@a.in').score, 4);
    });

    test('sameAddress is trimmed and case-blind but does not fold Gmail dots', () {
      expect(sameAddress(' Meera@Acme.in ', 'meera@acme.in'), isTrue);
      expect(sameAddress('me.era@gmail.com', 'meera@gmail.com'), isFalse);
      expect(sameAddress(null, 'x'), isFalse);
    });

    test('every unavailable status has its own title; claimed and already-bound offer sign-in', () {
      final titles = {
        for (final s in [InviteStatus.claimed, InviteStatus.expired, InviteStatus.revoked, InviteStatus.notFound, InviteStatus.identityAlreadyBound])
          s: unavailableCopy(s),
      };
      expect(titles.values.map((c) => c.title).toSet(), hasLength(5));
      expect(titles[InviteStatus.claimed]!.offersSignIn, isTrue);
      expect(titles[InviteStatus.identityAlreadyBound]!.offersSignIn, isTrue);
      expect(titles[InviteStatus.expired]!.offersSignIn, isFalse);
      expect(unavailableCopy(InviteStatus.unknown).title, 'We cannot find that invitation');
    });

    test('articles', () {
      expect(withArticle('Agent'), 'an Agent');
      expect(withArticle('Viewer'), 'a Viewer');
    });
  });
}
