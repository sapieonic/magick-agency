import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

void main() {
  test('session response: user, tenancy, memberships and per-account settings', () {
    final s = SessionResponse.fromJson(fixture('platform.json', 'session_response'));
    expect(s.isNew, isFalse);
    expect(s.user.displayName, 'Ravi Kulkarni');
    expect(s.user.status, UserStatus.active);
    expect(s.memberships.single.role, Role.agent);
    expect(s.memberships.single.accountId, 'acc-3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f');
    final settings = s.settings['acc-3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f']!;
    expect(settings.allowRecording, isTrue);
    expect(settings.webrtcMaxDurationSeconds, 1800);
    expect(s, SessionResponse.fromJson(fixture('platform.json', 'session_response')));
  });

  test('me response has no is_new and is not a session response', () {
    final me = MeResponse.fromJson(fixture('platform.json', 'me_response'));
    expect(me.user.displayName, isNull);
    expect(me.settings, isEmpty);
    expect(me, isNot(isA<SessionResponse>()));
  });

  test('my accounts', () {
    final a = MyAccountsResponse.fromJson(fixture('platform.json', 'my_accounts'));
    expect(a.accounts.map((x) => x.name), ['Pune Branch', 'Nashik Branch']);
  });

  group('invites', () {
    test('a pending lookup carries the invitation', () {
      final l = InviteLookup.fromJson(fixture('platform.json', 'invite_lookup_pending'));
      final invite = (l as InvitePending).invite;
      expect(invite.role, Role.agent);
      expect(invite.tenantName, 'Sahyadri Insurance Brokers');
      expect(invite.requiresMatchingAddress, isFalse);
    });

    test('an unavailable lookup carries only its status', () {
      final l = InviteLookup.fromJson(fixture('platform.json', 'invite_lookup_expired'));
      expect((l as InviteUnavailable).status, InviteStatus.expired);
      expect(
        InviteLookup.fromJson({'status': 'superseded'}),
        InviteUnavailable(status: InviteStatus.unknown, statusRaw: 'superseded'),
      );
    });

    test('a missing requires_matching_address reads as false', () {
      final json = Map.of((fixture('platform.json', 'invite_lookup_pending')['invite']! as Map<String, Object?>))
        ..remove('requires_matching_address');
      expect(AgencyInvite.fromJson(json).requiresMatchingAddress, isFalse);
    });

    test('a claim refusal says whether the invitation is still usable', () {
      final r = InviteClaimRefusal.fromJson(fixture('platform.json', 'invite_claim_refusal'));
      expect(r.status, InviteStatus.addressRequired);
      expect(r.email, 'meera.admin@example.in');
      expect(r.invitationStillUsable, isTrue);
      expect(InviteClaimRefusal.fromJson({'status': 'revoked'}).invitationStillUsable, isFalse);
    });
  });

  group('feature flags', () {
    test('a flag absent from the map is off', () {
      final f = FeatureFlags.fromJson(fixture('platform.json', 'feature_flags'));
      expect(f.isOn(FeatureFlags.dialerEnabled), isTrue);
      expect(f.isOn(FeatureFlags.softphoneEnabled), isFalse);
      expect(f.isOn('agency_late_binding'), isFalse);
    });

    test('values are booleans, numbers or strings', () {
      expect(FeatureFlags.fromJson({'a': 3, 'b': 'x'}).values, {'a': 3, 'b': 'x'});
      expect(() => FeatureFlags.fromJson({'a': null}), throwsA(isA<WireFormatException>()));
    });
  });

  test('notification preferences', () {
    final n = NotificationPreferencesResponse.fromJson(fixture('platform.json', 'notification_preferences'));
    final e = n.events.single;
    expect(e.cadence, NotificationCadence.immediate);
    expect(e.frequency, isNull);
    expect(e.isDefault, isTrue);
    expect(
      const NotificationPreferenceUpdate(
        eventKey: 'k',
        enabled: true,
        frequency: NotificationFrequency.weekly,
      ).toJson(),
      {'event_key': 'k', 'enabled': true, 'frequency': 'weekly'},
    );
  });

  group('client config (server addition)', () {
    final json = <String, Object?>{
      'mobile': {
        'min_supported': '1.2.0',
        'latest': '1.4.1',
        'store_urls': {'android': 'https://play.google.com/store/apps/details?id=x'},
      },
    };

    test('decodes, with optional store urls', () {
      final c = ClientConfig.fromJson(json);
      expect(c.mobile.storeUrls!.android, startsWith('https://play.google.com'));
      expect(c.mobile.storeUrls!.ios, isNull);
      expect(
        ClientConfig.fromJson({
          'mobile': {'min_supported': '1.0.0', 'latest': '1.0.0'},
        }).mobile.storeUrls,
        isNull,
      );
    });

    test('update gate', () {
      final m = ClientConfig.fromJson(json).mobile;
      expect(m.mustUpdate('1.1.9+40'), isTrue);
      expect(m.mustUpdate('1.2.0+41'), isFalse);
      expect(m.canUpdate('1.4.0'), isTrue);
      expect(m.canUpdate('1.4.1'), isFalse);
      expect(m.canUpdate('2.0.0'), isFalse);
    });

    test('semver comparison', () {
      expect(compareSemver('1.10.0', '1.9.9'), greaterThan(0));
      expect(compareSemver('1.2.0-beta.1', '1.2.0'), lessThan(0));
      expect(compareSemver('1.2', '1.2.0'), 0);
      expect(compareSemver('1.2.0+7', '1.2.0+9'), 0);
    });
  });
}
