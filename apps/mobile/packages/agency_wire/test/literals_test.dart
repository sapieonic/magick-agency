// Every string literal the TypeScript contract declares for a vocabulary the
// app switches on must be a value a Dart enum here knows. literals.json is
// extracted from packages/contracts/src by tooling/contracts-literals.mjs
// (`--check` fails when it is stale), so a literal added on the TypeScript
// side fails this suite instead of decoding as `unknown` on an agent's phone.
//
// And the other way: a value the app SENDS (`client=mobile`, `media=alaw8`, a
// DNC `scope`, a stats `bucket`, an `outcome` filter, `device_away`) or a
// value of an enum that mirrors its vocabulary one to one must still be a
// TypeScript literal, so a rename on that side fails here rather than as a
// 1008 or a 400 in production.

import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

/// Each vocabulary in literals.json and the Dart enum that must know it. A
/// vocabulary added to the extractor without an entry here fails the suite.
final Map<String, List<WireEnum>> dartVocabularies = {
  'agent_states': AgentState.values,
  'attempt_states': AttemptState.values,
  'attempt_outcomes': AttemptOutcome.values,
  'contact_states': ContactState.values,
  'campaign_statuses': CampaignStatus.values,
  'release_reasons': ReleaseReason.values,
  'campaign_change_reasons': CampaignChangeReason.values,
  'station_error_codes': StationErrorCode.values,
  'bridge_statuses': BridgeStatus.values,
  'station_server_events': StationEvent.values,
  'wrapup_hold_reasons': WrapupHoldReason.values,
  'dnc_scopes': DncScope.values,
  'session_kinds': SessionKind.values,
  'reserved_break_codes': ReservedBreakCode.values,
  'action_error_codes': AgencyErrorCode.values,
  'roles': Role.values,
  'invite_unavailable_statuses': InviteStatus.values,
  'invite_claim_refusal_statuses': InviteStatus.values,
  'client_kinds': ClientKind.values,
  'station_media_formats': MediaFormat.values,
  'stats_bucket_units': StatsBucketUnit.values,
  'session_refusal_codes': SessionRefusalCode.values,
  'user_statuses': UserStatus.values,
  'tenant_statuses': TenantStatus.values,
  'membership_statuses': MembershipStatus.values,
  'notification_cadences': NotificationCadence.values,
  'notification_frequencies': NotificationFrequency.values,
};

/// The vocabularies whose Dart enum is NOT a one-to-one mirror, so the
/// Dart → TypeScript direction is checked by its own test below instead.
const notOneToOne = {
  // `AgencyErrorCode` adds the soft-phone join refusal `session_on_softphone`.
  'action_error_codes',
  // `InviteStatus` is `pending` plus both of these.
  'invite_unavailable_statuses',
  'invite_claim_refusal_statuses',
};

/// Every value the app puts on the wire, by the vocabulary that must still
/// declare it. A TypeScript rename of any of these is a refused upgrade (1008)
/// or a 400 on a phone, so it must fail here.
final Map<String, List<WireEnum>> appSends = {
  'client_kinds': [ClientKind.mobile],
  'station_media_formats': [MediaFormat.alaw8],
  'dnc_scopes': [DncScope.campaign],
  'stats_bucket_units': [
    for (final u in StatsBucketUnit.values)
      if (!u.isUnknown) u,
  ],
  // `AttemptsQuery.outcomes` can filter on any of them.
  'attempt_outcomes': [
    for (final o in AttemptOutcome.values)
      if (!o.isUnknown) o,
  ],
  'reserved_break_codes': [ReservedBreakCode.deviceAway],
};

String _camel(String screaming) {
  final parts = screaming.toLowerCase().split('_');
  return parts.first + parts.skip(1).map((p) => p[0].toUpperCase() + p.substring(1)).join();
}

void main() {
  final doc = loadFixtureFile('literals.json');
  final vocabularies = {
    for (final e in doc.entries)
      if (e.value is Map<String, Object?>) e.key: e.value! as Map<String, Object?>,
  };

  test('literals.json has the vocabularies this suite expects', () {
    expect(vocabularies.keys, containsAll(dartVocabularies.keys));
    expect(vocabularies.keys.toSet(), {
      ...dartVocabularies.keys,
      'station_close_codes',
      'softphone_error_codes',
    }, reason: 'a vocabulary was added to tooling/contracts-literals.mjs: map it to a Dart enum here');
  });

  List<String> ts(String name) => (vocabularies[name]!['values']! as List<Object?>).cast<String>();

  for (final MapEntry(key: name, value: dartValues) in dartVocabularies.entries) {
    test('$name: every TypeScript literal is a known Dart value', () {
      final ts = (vocabularies[name]!['values']! as List<Object?>).cast<String>();
      expect(ts, isNotEmpty);
      final known = {for (final v in dartValues) v.wire}..remove('');
      final missing = ts.where((l) => !known.contains(l)).toList();
      expect(
        missing,
        isEmpty,
        reason:
            '${vocabularies[name]!['source']} declares $missing, which ${dartValues.first.runtimeType} '
            'does not know. Add the member, then handle it where the app switches on it.',
      );
    });
  }

  for (final MapEntry(key: name, value: dartValues) in dartVocabularies.entries) {
    if (notOneToOne.contains(name)) continue;
    test('$name: every Dart value is still a TypeScript literal', () {
      final declared = ts(name).toSet();
      final stale = [
        for (final v in dartValues)
          if (!v.isUnknown && !declared.contains(v.wire)) v.wire,
      ];
      expect(
        stale,
        isEmpty,
        reason: '${dartValues.first.runtimeType} has $stale, which ${vocabularies[name]!['source']} no longer declares',
      );
    });
  }

  for (final MapEntry(key: name, value: sent) in appSends.entries) {
    test('$name: every value the app sends is still declared', () {
      expect(sent, isNotEmpty);
      final declared = ts(name).toSet();
      for (final v in sent) {
        expect(
          declared,
          contains(v.wire),
          reason: 'the app sends "${v.wire}"; ${vocabularies[name]!['source']} must declare it',
        );
      }
    });
  }

  test('AgencyErrorCode: every Dart value is an action or soft-phone code the server declares', () {
    final declared = {...ts('action_error_codes'), ...ts('softphone_error_codes')};
    final stale = [
      for (final v in AgencyErrorCode.values)
        if (!v.isUnknown && !declared.contains(v.wire)) v.wire,
    ];
    expect(stale, isEmpty);
    // The join's soft-phone refusal is the soft phone's, not an action code.
    expect(ts('softphone_error_codes'), contains(AgencyErrorCode.sessionOnSoftphone.wire));
  });

  test('InviteStatus: every Dart value is pending or a declared unavailable/refusal status', () {
    final declared = {'pending', ...ts('invite_unavailable_statuses'), ...ts('invite_claim_refusal_statuses')};
    expect([
      for (final v in InviteStatus.values)
        if (!v.isUnknown && !declared.contains(v.wire)) v.wire,
    ], isEmpty);
  });

  test('station_close_codes: every TypeScript code is a StationCloseCode, by name and number', () {
    final ts = (vocabularies['station_close_codes']!['values']! as Map<String, Object?>).cast<String, int>();
    expect(ts, isNotEmpty);
    for (final MapEntry(key: name, value: code) in ts.entries) {
      final dart = StationCloseCode.fromCode(code);
      expect(dart, isNotNull, reason: 'AGENCY_STATION_CLOSE.$name ($code) is not a StationCloseCode');
      expect(dart!.name, _camel(name));
    }
    // And the other way: every code the app acts on is one the server declares.
    for (final c in StationCloseCode.values) {
      expect(ts.values, contains(c.code), reason: '$c is not in AGENCY_STATION_CLOSE');
    }
  });

  test('the Dart enums decode every TypeScript literal to itself', () {
    for (final v in (vocabularies['agent_states']!['values']! as List<Object?>).cast<String>()) {
      expect(AgentState.fromWire(v).wire, v);
    }
    for (final v in (vocabularies['action_error_codes']!['values']! as List<Object?>).cast<String>()) {
      expect(AgencyErrorCode.fromWire(v).wire, v);
    }
    for (final v in (vocabularies['reserved_break_codes']!['values']! as List<Object?>).cast<String>()) {
      expect(ReservedBreakCode.tryFromWire(v)?.wire, v);
    }
  });
}
