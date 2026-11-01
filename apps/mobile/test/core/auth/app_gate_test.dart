import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/providers.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/auth/auth_service.dart';
import 'package:magick_agency_agent/core/auth/fake_auth_service.dart';
import 'package:magick_agency_agent/core/session/account_choice.dart';
import 'package:magick_agency_agent/core/session/session_api.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';

import 'support/harness.dart';

void main() {
  late Harness h;

  setUp(() => h = Harness());

  Harness signedIn() => h = Harness(auth: FakeAuthService(signedIn: meera), server: h.server, store: h.store);

  group('start-up', () {
    test('nobody signed in → signed out, after the version check', () async {
      final gate = await startGate(h.container());
      expect(gate, const GateSignedOut());
      expect(h.server.calls('GET', '/client-config'), hasLength(1));
      expect(h.server.calls('POST', '/auth/session'), isEmpty);
    });

    test('a build below min_supported → update required with this platform\'s store link, nothing else', () async {
      h.server.json('GET', '/client-config', clientConfigJson(minSupported: '2.0.0'));
      signedIn();
      final gate = await startGate(h.container());
      expect(gate, const GateUpdateRequired(storeUrl: 'https://play.google.com/store/apps/details?id=x', minSupported: '2.0.0'));
      expect(h.server.calls('POST', '/auth/session'), isEmpty);
    });

    test('the version check is public: no bearer, no tenant', () async {
      await startGate(h.container());
      final req = h.server.calls('GET', '/client-config').single;
      expect(req.headers.containsKey('authorization'), isFalse);
      expect(req.headers.containsKey('x-tenant-id'), isFalse);
      expect(req.headers['x-client'], testIdentity.header);
    });

    for (final failure in ['500', 'offline', 'malformed']) {
      test('a failed client-config read ($failure) does not block start-up', () async {
        switch (failure) {
          case '500':
            h.server.json('GET', '/client-config', {'error': 'x'}, status: 500);
          case 'offline':
            h.server.offline('GET', '/client-config');
          default:
            h.server.json('GET', '/client-config', {'mobile': 'nope'});
        }
        signedIn();
        final gate = await startGate(h.container());
        expect(gate, isA<GateReady>());
      });
    }

    test('restored user with one account → ready; scope set and remembered', () async {
      signedIn();
      final c = h.container();
      final gate = await startGate(c);
      expect(
        gate,
        const GateReady(
          userId: 'u1',
          displayName: 'Meera K',
          email: 'meera.k@acmecollect.in',
          tenantId: 't1',
          accountId: 'a1',
          accountName: 'Chennai',
          tenantName: 'Acme Collections',
          accounts: [AccountChoice(tenantId: 't1', tenantName: 'Acme Collections', accountId: 'a1', accountName: 'Chennai')],
        ),
      );
      final scope = c.read(requestScopeProvider);
      expect((scope.tenantId, scope.accountId), ('t1', 'a1'));
      expect(await SessionStore(h.store).readLastAccount(), const LastAccount(tenantId: 't1', accountId: 'a1'));
      expect(c.read(readyAccountProvider), (tenantId: 't1', accountId: 'a1'));
    });

    test('the session carries the ID token in the body, unscoped; accounts are read per tenant', () async {
      signedIn();
      await startGate(h.container());
      final session = h.server.calls('POST', '/auth/session').single;
      expect(jsonDecode(session.body), {'id_token': 'token-fb-u1'});
      expect(session.headers.containsKey('authorization'), isFalse);
      expect(session.headers.containsKey('x-tenant-id'), isFalse);
      final mine = h.server.calls('GET', '/accounts/mine').single;
      expect(mine.headers['x-tenant-id'], 't1');
      expect(mine.headers.containsKey('x-account-id'), isFalse);
      expect(mine.headers['authorization'], 'Bearer token-fb-u1');
    });

    test('403 no_membership → no membership, with the address', () async {
      h.server.json('POST', '/auth/session', {'error': 'Forbidden', 'code': 'no_membership', 'message': 'x'}, status: 403);
      signedIn();
      expect(await startGate(h.container()), const GateNoMembership(email: 'meera.k@acmecollect.in'));
    });

    test('403 email_unverified → verify email, and one verification email', () async {
      h.server.json('POST', '/auth/session', {'error': 'Forbidden', 'code': 'email_unverified', 'message': 'x'}, status: 403);
      signedIn();
      final c = h.container();
      expect(await startGate(c), const GateEmailUnverified(email: 'meera.k@acmecollect.in'));
      expect(h.auth.verificationEmailsSent, 1);
      // A second refusal in the same run does not send another.
      await c.read(appGateProvider.notifier).signInWithEmail('x', 'y').catchError((_) {});
      expect(h.auth.verificationEmailsSent, 1);
    });

    test('session 401 (token refused) → signed out with the expiry notice, Firebase signed out', () async {
      h.server.json('POST', '/auth/session', {'error': 'Unauthorized'}, status: 401);
      signedIn();
      final gate = await startGate(h.container());
      expect(gate, const GateSignedOut(notice: sessionExpiredNotice));
      expect(h.auth.signOuts, 1);
    });

    test('offline session → loading with a notice, then retries to ready', () async {
      h.server.offline('POST', '/auth/session');
      signedIn();
      final c = h.container();
      final gate = await startGate(c);
      expect(gate, isA<GateLoading>().having((g) => g.notice, 'notice', isNotNull));
      h.server.standard();
      c.read(appGateProvider.notifier).retryNow();
      await settle();
      expect(c.read(appGateProvider), isA<GateReady>());
    });
  });

  group('account pick', () {
    void twoAccounts() => h.server.standard(
          memberships: [membershipJson('t1', accountId: 'a1'), membershipJson('t1', accountId: 'a2')],
          accounts: {
            't1': [accountJson('a1', 'Chennai', 't1'), accountJson('a2', 'Pune', 't1')],
          },
        );

    test('several and none remembered → needs account; picking one → ready and remembered', () async {
      twoAccounts();
      signedIn();
      final c = h.container();
      final gate = await startGate(c);
      expect(gate, isA<GateNeedsAccount>().having((g) => g.choices.map((x) => x.accountId), 'ids', ['a1', 'a2']));
      expect(c.read(requestScopeProvider).isSet, isFalse);
      await c.read(appGateProvider.notifier).selectAccount((gate as GateNeedsAccount).choices[1]);
      expect(c.read(appGateProvider), isA<GateReady>().having((g) => g.accountId, 'account', 'a2'));
      expect(c.read(requestScopeProvider).accountId, 'a2');
      expect(await SessionStore(h.store).readLastAccount(), const LastAccount(tenantId: 't1', accountId: 'a2'));
    });

    test('several with a remembered one still listed → straight to it', () async {
      twoAccounts();
      await SessionStore(h.store).writeLastAccount(const LastAccount(tenantId: 't1', accountId: 'a2'));
      signedIn();
      expect(await startGate(h.container()), isA<GateReady>().having((g) => g.accountId, 'account', 'a2'));
    });

    test('a remembered account no longer listed → the agent picks', () async {
      twoAccounts();
      await SessionStore(h.store).writeLastAccount(const LastAccount(tenantId: 't1', accountId: 'gone'));
      signedIn();
      expect(await startGate(h.container()), isA<GateNeedsAccount>());
    });

    test('no accounts at all → needs account with nothing to pick', () async {
      h.server.standard(accounts: {'t1': []});
      signedIn();
      expect(await startGate(h.container()), const GateNeedsAccount());
    });

    test('two workspaces: both are read, each with its own tenant header, inactive memberships skipped', () async {
      h.server.standard(
        tenants: [tenantJson('t1', 'Acme Collections'), tenantJson('t2', 'Bharat Loans'), tenantJson('t3', 'Old Co')],
        memberships: [
          membershipJson('t1', accountId: 'a1'),
          membershipJson('t2', accountId: 'b1'),
          membershipJson('t3', accountId: 'c1', status: 'revoked'),
        ],
        accounts: {
          't1': [accountJson('a1', 'Chennai', 't1')],
          't2': [accountJson('b1', 'Mumbai', 't2')],
        },
      );
      signedIn();
      final gate = await startGate(h.container()) as GateNeedsAccount;
      expect(gate.choices.map((c) => c.label), ['Acme Collections · Chennai', 'Bharat Loans · Mumbai']);
      expect(h.server.calls('GET', '/accounts/mine').map((r) => r.headers['x-tenant-id']).toSet(), {'t1', 't2'});
    });

    test('switching account from Me re-reads the accounts and moves the scope', () async {
      twoAccounts();
      await SessionStore(h.store).writeLastAccount(const LastAccount(tenantId: 't1', accountId: 'a1'));
      signedIn();
      final c = h.container();
      final gate = await startGate(c) as GateReady;
      await c.read(appGateProvider.notifier).switchAccount(gate.accounts[1]);
      expect(c.read(appGateProvider), isA<GateReady>().having((g) => g.accountId, 'account', 'a2'));
      expect(c.read(requestScopeProvider).accountId, 'a2');
      expect(h.server.calls('GET', '/accounts/mine'), hasLength(2));
    });

    test('switching is refused while on duty, and a failed re-read keeps the current account', () async {
      twoAccounts();
      await SessionStore(h.store).writeLastAccount(const LastAccount(tenantId: 't1', accountId: 'a1'));
      signedIn();
      final c = h.container();
      final gate = await startGate(c) as GateReady;
      c.read(testSignalsProvider.notifier).set(const StationSignals(onDuty: true, campaignId: 'c1'));
      await expectLater(c.read(appGateProvider.notifier).switchAccount(gate.accounts[1]), throwsStateError);
      c.read(testSignalsProvider.notifier).set(const StationSignals());
      h.server.offline('GET', '/accounts/mine');
      await expectLater(c.read(appGateProvider.notifier).switchAccount(gate.accounts[1]), throwsA(isA<ApiNetworkError>()));
      expect(c.read(appGateProvider), gate);
      expect(c.read(requestScopeProvider).accountId, 'a1');
    });
  });

  group('sign-in buttons', () {
    test('email: a wrong password is an AuthFailure and the gate stays signed out', () async {
      h.auth.addPasswordAccount('meera.k@acmecollect.in', 'right', uid: 'fb-u1');
      final c = h.container();
      await startGate(c);
      await expectLater(
        c.read(appGateProvider.notifier).signInWithEmail('meera.k@acmecollect.in', 'wrong'),
        throwsA(const AuthFailure('wrong-password')),
      );
      expect(c.read(appGateProvider), const GateSignedOut());
    });

    test('email: success → ready, and the auth event that follows does not sign in twice', () async {
      h.auth.addPasswordAccount('meera.k@acmecollect.in', 'right', uid: 'fb-u1');
      final c = h.container();
      await startGate(c);
      await c.read(appGateProvider.notifier).signInWithEmail('meera.k@acmecollect.in', 'right');
      await settle();
      expect(c.read(appGateProvider), isA<GateReady>());
      expect(h.server.calls('POST', '/auth/session'), hasLength(1));
    });

    test('email: offline → the error goes back to the screen, gate unchanged', () async {
      h.auth.addPasswordAccount('meera.k@acmecollect.in', 'right', uid: 'fb-u1');
      final c = h.container();
      await startGate(c);
      h.server.offline('POST', '/auth/session');
      await expectLater(
        c.read(appGateProvider.notifier).signInWithEmail('meera.k@acmecollect.in', 'right'),
        throwsA(isA<ApiNetworkError>()),
      );
      expect(c.read(appGateProvider), const GateSignedOut());
    });

    test('Google → ready; a no_membership answer → the unrecognised-account state', () async {
      h.auth.googleUser = const AuthUser(uid: 'fb-u1', email: 'meera@gmail.com', emailVerified: true);
      final c = h.container();
      await startGate(c);
      h.server.json('POST', '/auth/session', {'code': 'no_membership', 'message': 'x'}, status: 403);
      await c.read(appGateProvider.notifier).signInWithGoogle();
      expect(c.read(appGateProvider), const GateNoMembership(email: 'meera@gmail.com'));
      await c.read(appGateProvider.notifier).signOut();
      expect(c.read(appGateProvider), const GateSignedOut());
      h.server.standard();
      await c.read(appGateProvider.notifier).signInWithGoogle();
      expect(c.read(appGateProvider), isA<GateReady>());
    });

    test('email verification: not yet → false; verified → ready on a forced-fresh token', () async {
      h.server.json('POST', '/auth/session', {'code': 'email_unverified', 'message': 'x'}, status: 403);
      h = Harness(
        auth: FakeAuthService(signedIn: const AuthUser(uid: 'fb-u1', email: 'meera.k@acmecollect.in', usesPassword: true)),
        server: h.server,
      );
      final c = h.container();
      await startGate(c);
      final gate = c.read(appGateProvider.notifier);
      expect(await gate.checkEmailVerified(), isFalse);
      h.auth.verifyOnReload = true;
      h.server.standard();
      expect(await gate.checkEmailVerified(), isTrue);
      expect(c.read(appGateProvider), isA<GateReady>());
      expect(h.auth.tokensIssued, contains('token-fb-u1!'));
    });
  });

  group('sign-out', () {
    test('explicit sign-out clears scope, the remembered account and Firebase', () async {
      signedIn();
      final c = h.container();
      await startGate(c);
      await c.read(appGateProvider.notifier).signOut();
      expect(c.read(appGateProvider), const GateSignedOut());
      expect(c.read(requestScopeProvider).isSet, isFalse);
      expect(c.read(readyAccountProvider), isNull);
      expect(await SessionStore(h.store).readLastAccount(), isNull);
      expect(h.auth.signOuts, 1);
      expect(h.auth.currentUser, isNull);
    });

    test('a 401 reported anywhere signs out with the expiry notice', () async {
      signedIn();
      final c = h.container();
      await startGate(c);
      c.read(appGateProvider.notifier).reportError(const ApiUnauthorized());
      await settle();
      expect(c.read(appGateProvider), const GateSignedOut(notice: sessionExpiredNotice));
    });

    test('other API errors are not a reason to sign out', () async {
      signedIn();
      final c = h.container();
      await startGate(c);
      c.read(appGateProvider.notifier).reportError(const ApiNetworkError('x'));
      await settle();
      expect(c.read(appGateProvider), isA<GateReady>());
    });

    test('a 401 during a call waits for the call AND its wrap-up to end', () async {
      signedIn();
      final c = h.container();
      final ready = await startGate(c);
      final signals = c.read(testSignalsProvider.notifier)
        ..set(const StationSignals(onDuty: true, callActive: true, campaignId: 'c1'));
      c.read(appGateProvider.notifier).reportUnauthorized();
      await settle();
      expect(c.read(appGateProvider), ready);
      expect(c.read(appGateProvider.notifier).signOutDeferred, isTrue);
      expect(h.auth.signOuts, 0);

      // Still callActive through wrap-up: nothing yet.
      signals.set(const StationSignals(onDuty: true, callActive: true, campaignId: 'c1'));
      await settle();
      expect(c.read(appGateProvider), ready);

      signals.set(const StationSignals(onDuty: true, campaignId: 'c1'));
      await settle();
      expect(c.read(appGateProvider), const GateSignedOut(notice: sessionExpiredNotice));
      expect(h.auth.signOuts, 1);
    });

    test('Firebase dropping the user signs out, deferred the same way during a call', () async {
      signedIn();
      final c = h.container();
      final ready = await startGate(c);
      c.read(testSignalsProvider.notifier).set(const StationSignals(onDuty: true, callActive: true, campaignId: 'c1'));
      h.auth.externalSignOut();
      await settle();
      expect(c.read(appGateProvider), ready);
      c.read(testSignalsProvider.notifier).set(const StationSignals());
      await settle();
      expect(c.read(appGateProvider), const GateSignedOut(notice: sessionExpiredNotice));
    });

    test('a different user signing in elsewhere is resolved afresh', () async {
      signedIn();
      final c = h.container();
      await startGate(c);
      h.auth.externalSignIn(const AuthUser(uid: 'fb-u2', email: 'other@acme.in', emailVerified: true));
      await settle();
      expect(h.server.calls('POST', '/auth/session'), hasLength(2));
      expect(jsonDecode(h.server.calls('POST', '/auth/session').last.body), {'id_token': 'token-fb-u2'});
    });
  });

  group('invites', () {
    test('a credential for an invite never creates a session; the claim does, in the invited workspace', () async {
      h.server.json('POST', '/invites/tok/claim', sessionJson(
        tenants: [tenantJson('t1', 'Acme Collections'), tenantJson('t2', 'Bharat Loans')],
        memberships: [membershipJson('t1', accountId: 'a1'), membershipJson('t2', accountId: 'b1')],
      ));
      h.server.on('GET', '/accounts/mine', (req) => jsonResponse({
            'accounts': req.headers['x-tenant-id'] == 't1'
                ? [accountJson('a1', 'Chennai', 't1')]
                : [accountJson('b1', 'Mumbai', 't2')],
          }));
      await SessionStore(h.store).writeLastAccount(const LastAccount(tenantId: 't1', accountId: 'a1'));
      h.auth.googleUser = meera;
      final c = h.container();
      await startGate(c);
      final gate = c.read(appGateProvider.notifier);

      await gate.establishInviteCredential(const InviteViaGoogle());
      await settle();
      expect(h.server.calls('POST', '/auth/session'), isEmpty);
      expect(c.read(appGateProvider), const GateSignedOut());
      expect(gate.holdsInviteCredential, isTrue);

      final invite = (InviteLookup.fromJson(inviteJson(tenantName: 'Bharat Loans')) as InvitePending).invite;
      await gate.claimInvite('tok', invite: invite);
      // The invited workspace wins over the remembered one.
      expect(c.read(appGateProvider), isA<GateReady>().having((g) => g.accountId, 'account', 'b1'));
      expect(gate.holdsInviteCredential, isFalse);
      expect(jsonDecode(h.server.calls('POST', '/invites/tok/claim').single.body), {'id_token': 'token-fb-u1'});
    });

    test('invitedTenantId: the only workspace, else the one with the invited role and name, else null', () {
      SessionResponse session(List<Map<String, Object?>> tenants, List<Map<String, Object?>> memberships) =>
          SessionResponse.fromJson(sessionJson(tenants: tenants, memberships: memberships));
      AgencyInvite invite({String? tenantName}) =>
          (InviteLookup.fromJson(inviteJson(tenantName: tenantName)) as InvitePending).invite;

      expect(invitedTenantId(session([tenantJson('t1', 'A')], [membershipJson('t1')]), invite(tenantName: 'Z')), 't1');
      final two = session(
        [tenantJson('t1', 'A'), tenantJson('t2', 'B')],
        [membershipJson('t1', accountId: 'a1'), membershipJson('t2', accountId: 'b1')],
      );
      expect(invitedTenantId(two, invite(tenantName: 'B')), 't2');
      expect(invitedTenantId(two, invite(tenantName: null)), isNull);
      final roles = session(
        [tenantJson('t1', 'A'), tenantJson('t2', 'B')],
        [membershipJson('t1', role: 'operator'), membershipJson('t2', accountId: 'b1')],
      );
      expect(invitedTenantId(roles, invite(tenantName: null)), 't2');
    });

    test('abandoning drops the credential and stays signed out', () async {
      h.auth.googleUser = meera;
      final c = h.container();
      await startGate(c);
      final gate = c.read(appGateProvider.notifier);
      await gate.establishInviteCredential(const InviteViaGoogle());
      await gate.abandonInvite();
      expect(h.auth.currentUser, isNull);
      expect(gate.holdsInviteCredential, isFalse);
      expect(c.read(appGateProvider), const GateSignedOut());
    });

    test('a failed credential call holds nothing', () async {
      final c = h.container();
      await startGate(c);
      final gate = c.read(appGateProvider.notifier);
      await expectLater(gate.establishInviteCredential(const InviteViaGoogle()), throwsA(isA<AuthFailure>()));
      expect(gate.holdsInviteCredential, isFalse);
    });

    test('accepting an invite while signed in signs the old session out first', () async {
      signedIn();
      h.auth.googleUser = const AuthUser(uid: 'fb-u9', email: 'new@acme.in', emailVerified: true);
      final c = h.container();
      await startGate(c);
      await c.read(appGateProvider.notifier).establishInviteCredential(const InviteViaGoogle());
      await settle();
      expect(c.read(appGateProvider), const GateSignedOut());
      expect(c.read(requestScopeProvider).isSet, isFalse);
      expect(h.server.calls('POST', '/auth/session'), hasLength(1)); // only the start-up one
    });

    test('a claim refusal comes back as InviteClaimRefused and the credential stays held', () async {
      h.server.json('POST', '/invites/tok/claim', {'error': 'Conflict', 'message': 'In use', 'status': 'identity_in_use'}, status: 409);
      h.auth.googleUser = meera;
      final c = h.container();
      await startGate(c);
      final gate = c.read(appGateProvider.notifier);
      await gate.establishInviteCredential(const InviteViaGoogle());
      await expectLater(gate.claimInvite('tok'), throwsA(isA<InviteClaimRefused>()));
      expect(gate.holdsInviteCredential, isTrue);
    });
  });
}
