// Decodes every golden sample in packages/contracts/fixtures/agent/ with the
// Dart type that mirrors it. The same files are type-checked against the
// TypeScript contract by packages/contracts/test/agent-fixtures.test.ts, so a
// contract change that moves a fixture fails here until the Dart type follows.

import 'dart:convert';
import 'dart:io';

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
      'ready_device_away',
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
      'manual_call_owed',
      'ready_softphone_session',
      'agent_state_soft_phone',
      'agent_state_switch_queued',
      'reserved_redial',
      'wrapup_redial_offered',
      'wrapup_redial_used_up',
      'queue_nothing_due',
      'queue_due',
      'inbound_call_offered',
      'inbound_call_connected',
      'inbound_call_outcome_owed',
      'inbound_call_settled',
      'inbound_call_withheld',
      'customer_waiting',
      'customer_waiting_cleared',
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
    'break_request_device_away': (j) => SessionBreakRequest(j['reason']! as String),
    'session_state_device_away': SessionStateResponse.fromJson,
    'conflict_other_campaign': (j) => ErrorBody.fromJson(j).campaignConflict ?? (throw StateError('no conflict')),
    'conflict_softphone': (j) => ErrorBody.fromJson(j).softphoneConflict ?? (throw StateError('no conflict')),
  },
  'softphone.json': {
    'bootstrap_enabled': SoftphoneBootstrap.fromJson,
    'bootstrap_finish_mode': SoftphoneBootstrap.fromJson,
    'bootstrap_idle': SoftphoneBootstrap.fromJson,
    'session_response': SoftphoneSessionResponse.fromJson,
    'call_create_request': (j) {
      final overrides = j['overrides'] as Map<String, Object?>?;
      return ManualCallCreateRequest(
        sessionId: j['session_id']! as String,
        to: j['to']! as String,
        callerId: j['caller_id'] as String?,
        campaignId: j['campaign_id'] as String?,
        fields: j['fields'] as Map<String, Object?>?,
        overrides: overrides == null
            ? null
            : ManualCallOverridesRequest(
                dncNote: overrides['dnc_note'] as String?,
                hoursNote: overrides['hours_note'] as String?,
              ),
      );
    },
    'call_update_request': (j) =>
        ManualCallUpdateRequest(fields: j['fields'] as Map<String, Object?>?, notes: j['notes'] as String?),
    'call_disposition_request': (j) => ManualCallDispositionRequest(
      code: j['code']! as String,
      notes: j['notes'] as String?,
      callbackAt: DateTime.parse(j['callback_at']! as String),
      fields: j['fields'] as Map<String, Object?>?,
    ),
    'call_disposition_response': ManualCallDispositionResponse.fromJson,
    'call_hangup_response': ManualCall.fromJson,
    'call_dnc_request': (j) => ManualCallDncRequest(reason: j['reason'] as String?),
    'call_dnc_response': ManualCallDncResponse.fromJson,
    'calls_page': decodeManualCallsPage,
    'call_detail_agent': ManualCallDetail.fromJson,
    'session_state_switch_queued': SessionStateResponse.fromJson,
    'refusal_dnc_listed': (j) => ErrorBody.fromJson(j).dncListed ?? (throw StateError('not dnc_listed')),
    'refusal_outside_hours': (j) => ErrorBody.fromJson(j).outsideHours ?? (throw StateError('not outside hours')),
    'refusal_contact_in_flight': (j) =>
        ErrorBody.fromJson(j).contactInFlight ?? (throw StateError('not contact_in_flight')),
    'refusal_session_on_campaign': (j) =>
        ErrorBody.fromJson(j).sessionOnCampaign ?? (throw StateError('not session_on_campaign')),
    'refusal_outcome_pending': (j) => ErrorBody.fromJson(j).callPending ?? (throw StateError('not outcome_pending')),
    'refusal_fields_invalid': ErrorBody.fromJson,
    'refusal_disposition_invalid': ErrorBody.fromJson,
    'refusal_softphone_disabled': ErrorBody.fromJson,
    'refusal_contact_assigned_elsewhere': ErrorBody.fromJson,
  },
  'inbound.json': {
    'call_response': InboundCallResponse.fromJson,
    'call_update_request': (j) => InboundCallUpdateRequest(notes: j['notes'] as String?),
    'call_hangup_response': InboundCallResponse.fromJson,
    'call_disposition_request': (j) => InboundCallDispositionRequest(
      code: j['code']! as String,
      notes: j['notes'] as String?,
      callbackAt: DateTime.parse(j['callback_at']! as String),
    ),
    'call_disposition_response': InboundCallDispositionResponse.fromJson,
    'call_dnc_request': (j) => InboundCallDncRequest(reason: j['reason'] as String?),
    'call_dnc_response': InboundCallDncResponse.fromJson,
    'missed_page': decodeInboundMissedPage,
    'missed_page_last': decodeInboundMissedPage,
    'missed_handled_response': InboundMissedCallResponse.fromJson,
    'missed_reopen_response': InboundMissedCallResponse.fromJson,
    'missed_count': InboundMissedCountResponse.fromJson,
    'missed_count_capped': InboundMissedCountResponse.fromJson,
    'refusal_disposition_unknown_code': (j) =>
        ErrorBody.fromJson(j).inboundDispositionInvalid ?? (throw StateError('not inbound_disposition_invalid')),
    'refusal_disposition_note_required': (j) =>
        ErrorBody.fromJson(j).inboundDispositionInvalid ?? (throw StateError('not inbound_disposition_invalid')),
    'refusal_outcome_already_saved': ErrorBody.fromJson,
    'refusal_call_not_found': ErrorBody.fromJson,
    'refusal_call_live': (j) => ErrorBody.fromJson(j).inboundCallLive ?? (throw StateError('not inbound_call_live')),
    'refusal_inbound_disabled': ErrorBody.fromJson,
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
    'redial_request': (j) => RedialRequest(attemptId: j['attempt_id']! as String),
    'redial_response': RedialResponse.fromJson,
    'error_redial_limit_reached': ErrorBody.fromJson,
    'error_redial_blocked_dnc': ErrorBody.fromJson,
    'agent_retry_request_selected': (j) => AgentRetryRequest.selected(
      campaignId: j['campaign_id']! as String,
      contactIds: (j['contact_ids']! as List<Object?>).cast<String>(),
    ),
    'agent_retry_request_all': (j) => AgentRetryRequest.all(campaignId: j['campaign_id']! as String),
    'agent_retry_response': AgentRetryResponse.fromJson,
    'my_contact_call_request': (j) =>
        MyContactCallRequest(campaignId: j['campaign_id']! as String, sessionId: j['session_id']! as String),
    'my_contact_call_request_hours_override': (j) => MyContactCallRequest(
      campaignId: j['campaign_id']! as String,
      sessionId: j['session_id']! as String,
      overrideNote: j['override_note']! as String,
    ),
    'my_contact_call_response': MyContactCallResponse.fromJson,
    'error_contact_not_retryable': (j) =>
        ErrorBody.fromJson(j).agentRetryRefusal ?? (throw StateError('not an own-contact refusal')),
  },
  'reads.json': {
    'my_assignments': MyAssignments.fromJson,
    'my_assignments_empty': MyAssignments.fromJson,
    'my_campaigns': StaffingHistory.fromJson,
    'my_stats': AgentStats.fromJson,
    'my_stats_unmeasured': AgentStats.fromJson,
    'my_attempts': decodeAttemptsPage,
    'my_attempts_last_page': decodeAttemptsPage,
    'my_contacts_summary': MyContactsSummary.fromJson,
    'my_contacts': decodeMyContactsPage,
    'my_contacts_last_page': decodeMyContactsPage,
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
    'client_config': ClientConfig.fromJson,
    'uplink_probe_response': (j) => j['received_bytes']! as int,
    'error_not_staffed': ErrorBody.fromJson,
  },
  'customer-history.json': {
    'search_request': (j) => CustomerSearchRequest(
      by: CustomerSearchBy.fromWire(j['by']! as String),
      value: j['value']! as String,
      country: j['country'] as String?,
    ),
    'search_response': CustomerSearchResponse.fromJson,
    'entry_softphone_call': CustomerTimelineEntry.fromJson,
    'entry_callback': CustomerTimelineEntry.fromJson,
    'entry_campaign_call': CustomerTimelineEntry.fromJson,
    'entry_dnc_mark': CustomerTimelineEntry.fromJson,
    'entry_roster_entry': CustomerTimelineEntry.fromJson,
    'search_response_empty': CustomerSearchResponse.fromJson,
    'timeline_request': decodeTimelineRequest,
    'timeline_page_last': CustomerTimelinePage.fromJson,
    'error_invalid_number': CustomerHistoryRefusal.fromJson,
    'error_search_expired': CustomerHistoryRefusal.fromJson,
    'options_response': CustomerSearchOptionsResponse.fromJson,
  },
};

/// The fixture files that are not wire samples: the vocabularies (their own
/// suite, `literals_test.dart`) and the search box's number table (its own
/// suite, `customer_search_number_test.dart`).
const notSamples = {'literals.json', 'customer-search-numbers.json'};

/// `timeline_request` rebuilt through the Dart request type, so its
/// `toJson()` is checked against the fixture.
CustomerTimelineRequest decodeTimelineRequest(Map<String, Object?> j) {
  final f = j['filters'] as Map<String, Object?>?;
  List<String>? strings(Object? v) => (v as List<Object?>?)?.cast<String>();
  DateTime? time(Object? v) => v == null ? null : DateTime.parse(v as String);
  return CustomerTimelineRequest(
    searchId: j['search_id']! as String,
    filters: f == null
        ? null
        : CustomerTimelineFilters(
            campaignIds: strings(f['campaign_ids']),
            from: time(f['from']),
            to: time(f['to']),
            outcomes: strings(f['outcomes'])?.map(AttemptOutcome.fromWire).toList(),
            dispositionCodes: strings(f['disposition_codes']),
            agentUserIds: strings(f['agent_user_ids']),
            connectedOnly: f['connected_only'] as bool?,
            channel: f['channel'] == null ? null : CustomerTimelineChannel.fromWire(f['channel']! as String),
          ),
    cursor: j['cursor'] as String?,
    limit: j['limit'] as int?,
  );
}

/// The request bodies, whose `toJson()` must reproduce the fixture exactly.
Map<String, Object?>? encoded(Object o) => switch (o) {
  final CreateSessionRequest r => r.toJson(),
  final SessionBreakRequest r => r.toJson(),
  final DispositionRequest r => r.toJson(),
  final NotesRequest r => r.toJson(),
  final DncRequest r => r.toJson(),
  final RedialRequest r => r.toJson(),
  final SessionRequest r => r.toJson(),
  final ClaimInviteRequest r => r.toJson(),
  final NotificationPreferenceUpdate r => r.toJson(),
  final StationClientFrame f => f.toJson(),
  final ManualCallCreateRequest r => r.toJson(),
  final ManualCallUpdateRequest r => r.toJson(),
  final ManualCallDispositionRequest r => r.toJson(),
  final ManualCallDncRequest r => r.toJson(),
  final AgentRetryRequest r => r.toJson(),
  final MyContactCallRequest r => r.toJson(),
  final CustomerSearchRequest r => r.toJson(),
  final CustomerTimelineRequest r => r.toJson(),
  final InboundCallUpdateRequest r => r.toJson(),
  final InboundCallDispositionRequest r => r.toJson(),
  final InboundCallDncRequest r => r.toJson(),
  _ => null,
};

/// The closed-vocabulary fields of a decoded sample. Every fixture uses only
/// literals the contract declares, so none of these may be `unknown`.
Iterable<WireEnum?> enumsOf(Object o) => switch (o) {
  final ReadyFrame f => [
    f.queue?.reason,
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
  final ManualCallFrame f => [
    f.state,
    ...manualCallEnums(f.manualCall ?? (throw StateError('manual_call did not decode'))),
  ],
  final QueueFrame f => [f.queue.reason],
  final InboundCallFrame f => [
    f.state,
    ...inboundCallEnums(f.inboundCall ?? (throw StateError('inbound_call did not decode'))),
  ],
  final InboundCallResponse r => inboundCallEnums(r.call),
  final InboundCallDispositionResponse r => [r.contactState, ...inboundCallEnums(r.call)],
  final InboundCallDncResponse r => [r.scope, r.contactState],
  final KeysetPage<InboundMissedCall> p => p.rows.expand(missedCallEnums),
  final InboundMissedCallResponse r => missedCallEnums(r.call),
  final InboundDispositionRefusal r => [r.rule],
  final SessionBootstrap b => [
    b.state,
    b.campaignStatus,
    b.assignmentMode,
    b.queue?.reason,
    ...b.dispositionCatalog.expand((d) => d.overrideGrant?.kinds ?? const <OverrideKind>[]),
  ],
  final SessionStateResponse s => [s.kind, s.state, s.pendingState],
  final SessionCampaignConflict c => [c.state],
  final HangupResponse h => [h.state, h.outcome],
  final DispositionResponse d => [d.contactState, d.agentState],
  final DncResponse d => [d.contactState],
  final DncRequest d => [d.scope],
  // `session_refusal` is a sign-in code, not an agency one.
  final ErrorBody e when e.codeRaw == null || SessionRefusalCode.fromWire(e.codeRaw) != SessionRefusalCode.unknown =>
    const [],
  // An inbound refusal is read through `inboundCode`.
  final ErrorBody e when e.inboundCode != InboundErrorCode.unknown => [e.inboundCode],
  // A soft-phone refusal is read through `softphoneCode` (its `code` is an action code
  // only for `session_on_softphone`).
  final ErrorBody e when e.softphoneCode != SoftphoneErrorCode.unknown => [e.softphoneCode],
  final ErrorBody e => [e.code],
  final SoftphoneBootstrap b => [
    ...b.taggableCampaigns.map((c) => c.status),
    ?b.callCampaign?.status,
    ...b.callFields.map((f) => f.type),
    ?b.session?.kind,
    ?b.session?.state,
    ?b.session?.pendingState,
    ...?(b.call == null ? null : manualCallEnums(b.call!)),
  ],
  final SoftphoneSessionResponse r => [r.kind, r.state],
  final ManualCallDispositionResponse r => [r.contactState, ...manualCallEnums(r.call)],
  final ManualCallDncResponse r => [r.scope, r.contactState],
  final KeysetPage<ManualCallListRow> p => p.rows.expand(manualCallEnums),
  final ManualCallDetail d => [d.callAvailability, d.overrides.dncEntry?.scope, ...manualCallEnums(d.call)],
  final SoftphoneDncListedRefusal r => [r.entry.scope],
  final SoftphoneOutsideHoursRefusal r => [r.timezoneSource],
  final SoftphoneSessionOnCampaignRefusal r => [r.state],
  final SoftphoneCallPendingRefusal r => [r.code, ...manualCallEnums(r.call)],
  final ManualCall c => manualCallEnums(c),
  final AgentStats s => [s.bucket],
  final MyContactsSummary s => [s.assignmentMode, s.queue.reason],
  final KeysetPage<MyContact> p => p.rows.expand(
    (r) => [r.bucket, r.state, r.retry.blocked, ...?r.overrideGrant?.kinds],
  ),
  final AgentRetryResponse r => r.skipped.map((s) => s.blocked),
  final MyContactCallResponse r => r.overrideApplied,
  final AgentRetryRefusal r => [r.code, r.blocked],
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
  final CustomerSearchRequest r => [r.by],
  final CustomerTimelineRequest r => [r.filters?.channel, ...?r.filters?.outcomes],
  final CustomerSearchResponse r => customerSearchEnums(r),
  final CustomerTimelineEntry e => customerEntryEnums(e),
  final CustomerTimelinePage p => p.entries.expand(customerEntryEnums),
  final CustomerHistoryRefusal r => [r.code, r.numberError],
  _ => const [],
};

/// A customer search answer's closed-vocabulary fields, its timeline included.
Iterable<WireEnum?> customerSearchEnums(CustomerSearchResponse r) {
  final s = r.summary;
  return <WireEnum?>[
    r.key.by,
    for (final c in s.contacts) ...<WireEnum?>[c.state, c.campaign.status, ...c.campaigns.map((x) => x.status)],
    s.totals.lastContacted?.channel,
    s.totals.lastContacted?.outcome,
    ...s.dnc.map((d) => d.scope),
    ...s.open.callbacks.map((c) => c.campaign.status),
    ...s.open.overrides.map((o) => o.campaign.status),
    for (final l in s.open.liveCalls) ...<WireEnum?>[l.channel, l.campaign?.status],
    ...s.filterOptions.outcomes,
    ...r.timeline.entries.expand(customerEntryEnums),
  ];
}

/// One timeline entry's closed-vocabulary fields, its kind first.
Iterable<WireEnum?> customerEntryEnums(CustomerTimelineEntry e) {
  final List<WireEnum?> fields = switch (e) {
    final CustomerTimelineCampaignCall c => <WireEnum?>[
      c.campaign.status,
      c.outcome,
      c.recording,
      ...c.overrideApplied,
    ],
    final CustomerTimelineSoftphoneCall c => <WireEnum?>[c.campaign?.status, c.outcome, c.recording],
    final CustomerTimelineCallback c => <WireEnum?>[c.source.channel, c.campaign?.status, c.status],
    final CustomerTimelineDncMark d => <WireEnum?>[d.entry.scope],
    final CustomerTimelineRosterEntry r => <WireEnum?>[r.campaign.status],
    CustomerTimelineUnknownEntry() => <WireEnum?>[],
  };
  return <WireEnum?>[e.kind, ...fields];
}

/// A manual call's closed-vocabulary fields, its contact and priors included.
Iterable<WireEnum?> manualCallEnums(ManualCall c) => [
  c.state,
  c.outcome,
  c.endReason,
  c.dispositionSource,
  c.contact?.state,
  ...?c.contact?.priorAttempts?.map((p) => p.outcome),
];

/// An inbound call's closed-vocabulary fields, its match and priors included.
Iterable<WireEnum?> inboundCallEnums(InboundCall c) => [
  c.state,
  c.outcome,
  c.catalogSource,
  c.sticky?.reason,
  c.match?.contactState,
  ...?c.match?.priorAttempts.map((p) => p.outcome),
  ...c.dispositionCatalog.expand((d) => d.overrideGrant?.kinds ?? const <OverrideKind>[]),
];

/// A Missed row's closed-vocabulary fields.
Iterable<WireEnum?> missedCallEnums(InboundMissedCall c) => [
  c.reason,
  c.closedCause,
  c.outcome,
  c.status,
  c.handledReason,
];

void main() {
  test('the fixture directory is found from the package', () {
    expect(agentFixturesDir().existsSync(), isTrue);
  });

  test('every fixture file in the directory is registered here (the non-sample files have their own suites)', () {
    final files = {
      for (final f in agentFixturesDir().listSync().whereType<File>())
        if (f.path.endsWith('.json')) f.uri.pathSegments.last,
    };
    expect(files, {...decoders.keys, ...notSamples});
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
    // The inbound frames included: the app declares `caps=inbound`, so it is sent them.
    expect(events, containsAll(StationEvent.values.where((e) => e != StationEvent.unknown)));
  });
}
