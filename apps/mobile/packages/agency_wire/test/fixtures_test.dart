// Decodes every golden sample in packages/contracts/fixtures/agent/ with the
// Dart type that mirrors it. The same files are type-checked against the
// TypeScript contract by packages/contracts/test/agent-fixtures.test.ts, so a
// contract change that moves a fixture fails here until the Dart type follows.

import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

typedef Decoder = Object Function(Map<String, Object?> json);

/// Every sample of every file, with its decoder. A sample added to a file
/// without an entry here fails "registers every sample".
final Map<String, Map<String, Decoder>> decoders = {
  'station.json': {
    for (final name in const [
      'ready_first_join',
      'ready_reconnect_live',
      'ready_reconnect_wrapup',
      'ready_missed_release',
      'reserved',
      'countdown',
      'bridged',
      'released_completed',
      'released_no_answer',
      'wrapup_timed',
      'wrapup_held_timerless',
      'agent_state_available',
      'agent_state_break',
      'agent_state_break_queued',
      'campaign_state_exhausted',
      'pong',
      'pong_without_ts',
      'error',
      'bridge_status',
      'bridge_ended',
      'media',
      'manual_call',
    ])
      name: (j) => StationFrame.decode(jsonEncode(j)),
  },
  'station-client.json': {
    for (final name in const ['ping', 'ping_without_ts', 'media'])
      name: (j) => StationClientFrame.decode(jsonEncode(j)) ?? (throw StateError('not a client frame')),
  },
  'session.json': {
    'create_session_request': (j) => CreateSessionRequest(campaignId: j['campaign_id']! as String),
    'bootstrap_first_join': SessionBootstrap.fromJson,
    'bootstrap_retry_rehydrated': SessionBootstrap.fromJson,
    'station_token': StationTokenResponse.fromJson,
    'break_request': (j) => SessionBreakRequest(j['reason']! as String),
    'session_state_available': SessionStateResponse.fromJson,
    'session_state_break_queued': SessionStateResponse.fromJson,
    'session_state_left': SessionStateResponse.fromJson,
    'conflict_other_campaign': (j) => ErrorBody.fromJson(j).campaignConflict ?? (throw StateError('no conflict')),
    'conflict_softphone': (j) => ErrorBody.fromJson(j).softphoneConflict ?? (throw StateError('no conflict')),
  },
  'actions.json': {
    'hangup_response': HangupResponse.fromJson,
    'disposition_request_callback': (j) => DispositionRequest(
      dispositionCode: j['disposition_code']! as String,
      notes: j['notes'] as String?,
      callbackAt: DateTime.parse(j['callback_at']! as String),
    ),
    'disposition_request_plain': (j) => DispositionRequest(dispositionCode: j['disposition_code']! as String),
    'disposition_response_callback': DispositionResponse.fromJson,
    'disposition_response_completed': DispositionResponse.fromJson,
    'notes_request': (j) => NotesRequest(j['notes']! as String),
    'notes_response': NotesResponse.fromJson,
    'dnc_request': (j) => DncRequest(reason: j['reason'] as String?),
    'dnc_response': DncResponse.fromJson,
    'error_unknown_disposition_code': ErrorBody.fromJson,
    'error_break_already_applied': ErrorBody.fromJson,
    'error_session_ended': ErrorBody.fromJson,
  },
  'reads.json': {
    'my_assignments': MyAssignments.fromJson,
    'my_assignments_empty': MyAssignments.fromJson,
    'my_campaigns': StaffingHistory.fromJson,
    'my_stats': AgentStats.fromJson,
    'my_stats_unmeasured': AgentStats.fromJson,
    'my_attempts': decodeAttemptsPage,
    'my_attempts_last_page': decodeAttemptsPage,
  },
  'platform.json': {
    'session_request': (j) => SessionRequest(idToken: j['id_token']! as String),
    'session_response': SessionResponse.fromJson,
    'me_response': MeResponse.fromJson,
    'session_refusal': ErrorBody.fromJson,
    'my_accounts': MyAccountsResponse.fromJson,
    'invite_lookup_pending': InviteLookup.fromJson,
    'invite_lookup_expired': InviteLookup.fromJson,
    'invite_claim_request': (j) => ClaimInviteRequest(idToken: j['id_token']! as String),
    'invite_claim_refusal': InviteClaimRefusal.fromJson,
    'feature_flags': FeatureFlags.fromJson,
    'notification_preferences': NotificationPreferencesResponse.fromJson,
    'notification_update': (j) => NotificationPreferenceUpdate(
      eventKey: j['event_key']! as String,
      channel: j['channel'] as String?,
      enabled: j['enabled']! as bool,
    ),
    'error_generic': ErrorBody.fromJson,
  },
};

/// The request bodies, whose `toJson()` must reproduce the fixture exactly.
Map<String, Object?>? encoded(Object o) => switch (o) {
  final CreateSessionRequest r => r.toJson(),
  final SessionBreakRequest r => r.toJson(),
  final DispositionRequest r => r.toJson(),
  final NotesRequest r => r.toJson(),
  final DncRequest r => r.toJson(),
  final SessionRequest r => r.toJson(),
  final ClaimInviteRequest r => r.toJson(),
  final NotificationPreferenceUpdate r => r.toJson(),
  final StationClientFrame f => f.toJson(),
  _ => null,
};

/// The closed-vocabulary fields of a decoded sample. Every fixture uses only
/// literals the contract declares, so none of these may be `unknown`.
Iterable<WireEnum?> enumsOf(Object o) => switch (o) {
  final ReadyFrame f => [
    f.state,
    f.pendingState,
    f.activeAttempt?.state,
    ...?f.activeAttempt?.priorAttempts.map((p) => p.outcome),
    f.missedRelease?.reason,
    f.activeWrapup?.heldReason,
  ],
  final ReservedFrame f => f.attempt.priorAttempts.map((p) => p.outcome),
  final ReleasedFrame f => [f.reason],
  final WrapupFrame f => [f.wrapup.heldReason],
  final AgentStateFrame f => [f.state, f.pendingState],
  final CampaignStateFrame f => [f.status, f.reason],
  final StationErrorFrame f => [f.code],
  final BridgeStatusFrame f => [f.status],
  final ManualCallFrame f => [f.state],
  final SessionBootstrap b => [b.state, b.campaignStatus],
  final SessionStateResponse s => [s.kind, s.state, s.pendingState],
  final SessionCampaignConflict c => [c.state],
  final HangupResponse h => [h.state, h.outcome],
  final DispositionResponse d => [d.contactState, d.agentState],
  final DncResponse d => [d.contactState],
  final DncRequest d => [d.scope],
  // `session_refusal` is a sign-in code, not an agency one.
  final ErrorBody e when e.codeRaw == null || SessionRefusalCode.fromWire(e.codeRaw) != SessionRefusalCode.unknown =>
    const [],
  final ErrorBody e => [e.code],
  final AgentStats s => [s.bucket],
  final KeysetPage<AttemptRow> p => p.rows.expand((r) => [r.state, r.outcome]),
  final SessionResponse s => [
    s.user.status,
    ...s.tenants.map((t) => t.status),
    ...s.memberships.expand((m) => [m.role, m.status]),
  ],
  final MeResponse s => [s.user.status],
  final InvitePending i => [i.invite.role],
  final InviteUnavailable i => [i.status],
  final InviteClaimRefusal r => [r.status],
  final NotificationPreferencesResponse n => n.events.expand((e) => [e.cadence, e.frequency, e.defaultFrequency]),
  _ => const [],
};

void main() {
  test('the fixture directory is found from the package', () {
    expect(agentFixturesDir().existsSync(), isTrue);
  });

  for (final MapEntry(key: file, value: byName) in decoders.entries) {
    group(file, () {
      final samples = loadFixtureFile(file);

      test('registers every sample', () {
        expect(byName.keys.toSet(), samples.keys.toSet());
      });

      for (final MapEntry(key: name, value: decode) in byName.entries) {
        test('$name decodes with no unknown literal', () {
          final json = samples[name]! as Map<String, Object?>;
          final decoded = decode(json);
          expect(decoded, isNot(isA<UnknownFrame>()), reason: decoded is UnknownFrame ? decoded.reason : null);
          final unknown = enumsOf(decoded).whereType<WireEnum>().where((e) => e.isUnknown);
          expect(unknown, isEmpty, reason: '$name decoded a literal this build does not know');
          // Decoding is deterministic and the result has value equality.
          expect(decode(json), decoded);
          final body = encoded(decoded);
          if (body != null) expect(body, json, reason: '$name: toJson() must reproduce the fixture');
        });
      }
    });
  }

  test('every station server event in the fixtures has its own frame type', () {
    final samples = loadFixtureFile('station.json');
    final events = {for (final s in samples.values) StationFrame.decode(jsonEncode(s)).event};
    expect(events, containsAll(StationEvent.values.where((e) => e != StationEvent.unknown)));
  });
}
