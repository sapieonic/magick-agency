import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/auth/fake_auth_service.dart';
import 'package:magick_agency_agent/core/session/local_preferences.dart';
import 'package:magick_agency_agent/core/session/session_api.dart';

import '../auth/support/harness.dart';

void main() {
  late Harness h;
  late SessionApi api;

  setUp(() {
    h = Harness(auth: FakeAuthService(signedIn: meera));
    api = h.container().read(sessionApiProvider);
  });

  test('invite lookup: pending, an unavailable status, and a 404 not_found are all answers', () async {
    h.server.json('GET', '/invites/abc', inviteJson());
    expect(await api.lookupInvite('abc'), isA<InvitePending>().having((p) => p.invite.inviterName, 'inviter', 'Rahul Menon'));
    h.server.json('GET', '/invites/abc', {'status': 'expired'});
    expect(await api.lookupInvite('abc'), InviteUnavailable(status: InviteStatus.expired));
    h.server.json('GET', '/invites/abc', {'status': 'not_found'}, status: 404);
    expect(await api.lookupInvite('abc'), InviteUnavailable(status: InviteStatus.notFound));
  });

  test('invite lookup is public and the token is path-encoded', () async {
    h.server.json('GET', '/invites/a%20b', inviteJson());
    await api.lookupInvite('a b');
    final req = h.server.requests.single;
    expect(req.url.toString(), 'https://agency.test/invites/a%20b');
    expect(req.headers.containsKey('authorization'), isFalse);
  });

  test('invite lookup: a 500 or no network is an error, not an answer', () async {
    h.server.json('GET', '/invites/abc', {'message': 'boom'}, status: 500);
    await expectLater(api.lookupInvite('abc'), throwsA(isA<ApiHttpError>()));
    h.server.offline('GET', '/invites/abc');
    await expectLater(api.lookupInvite('abc'), throwsA(isA<ApiNetworkError>()));
  });

  test('a claim refusal with a status becomes InviteClaimRefused', () async {
    h.server.json('POST', '/invites/abc/claim',
        {'error': 'Conflict', 'message': 'Use the invited address', 'status': 'address_required', 'email': 'x@y.in'},
        status: 409);
    await expectLater(
      api.claimInvite('abc', 'tok'),
      throwsA(isA<InviteClaimRefused>().having((e) => e.refusal.status, 'status', InviteStatus.addressRequired)),
    );
  });

  test('a malformed session body is a decode error', () async {
    h.server.json('POST', '/auth/session', {'user': 'nope'});
    await expectLater(api.createSession('tok'), throwsA(isA<ApiDecodeError>()));
  });

  group('local preferences', () {
    test('default on, load what was stored, and persist a change', () async {
      h.store.values[LocalPreferencesNotifier.hapticsKey] = false;
      final c = h.container();
      c.listen(localPreferencesProvider, (_, _) {});
      expect(c.read(localPreferencesProvider), const LocalPreferences());
      await settle();
      expect(c.read(localPreferencesProvider), const LocalPreferences(sounds: true, haptics: false));
      await c.read(localPreferencesProvider.notifier).setSounds(false);
      expect(c.read(localPreferencesProvider).sounds, isFalse);
      expect(h.store.values[LocalPreferencesNotifier.soundsKey], false);
    });
  });
}
