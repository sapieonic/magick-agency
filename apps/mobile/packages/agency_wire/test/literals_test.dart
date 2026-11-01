// Every string literal the TypeScript contract declares for a vocabulary the
// app switches on must be a value a Dart enum here knows. literals.json is
// extracted from packages/contracts/src by tooling/contracts-literals.mjs
// (`--check` fails when it is stale), so a literal added on the TypeScript
// side fails this suite instead of decoding as `unknown` on an agent's phone.

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
    }, reason: 'a vocabulary was added to tooling/contracts-literals.mjs: map it to a Dart enum here');
  });

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

  test('station_close_codes: every TypeScript code is a StationCloseCode, by name and number', () {
    final ts = (vocabularies['station_close_codes']!['values']! as Map<String, Object?>).cast<String, int>();
    expect(ts, isNotEmpty);
    for (final MapEntry(key: name, value: code) in ts.entries) {
      final dart = StationCloseCode.fromCode(code);
      expect(dart, isNotNull, reason: 'AGENCY_STATION_CLOSE.$name ($code) is not a StationCloseCode');
      expect(dart!.name, _camel(name));
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
