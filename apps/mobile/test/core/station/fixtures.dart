import 'package:agency_wire/agency_wire.dart';

/// Wire values shared by the station tests.

ReservedAttempt attempt(
  String id, {
  String campaignId = 'camp-1',
  Map<String, Object?> context = const {},
  List<PriorAttempt> prior = const [],
  String phone = '+919876543210',
}) =>
    ReservedAttempt(
      attemptId: id,
      campaignId: campaignId,
      campaignName: 'Renewals',
      contactId: 'c-$id',
      phoneE164: phone,
      callerId: '+911234567890',
      attemptNumber: 1,
      context: context,
      priorAttempts: prior,
    );

ActiveAttempt activeAttempt(String id, {DateTime? bridgedAt}) => ActiveAttempt(
      attemptId: id,
      campaignId: 'camp-1',
      campaignName: 'Renewals',
      contactId: 'c-$id',
      phoneE164: '+919876543210',
      callerId: '+911234567890',
      attemptNumber: 1,
      context: const {},
      priorAttempts: const [],
      bridgedAt: bridgedAt,
      state: bridgedAt == null ? AttemptState.ringing : AttemptState.bridged,
    );

ReleasedFrame released(String attemptId, {bool requiresDisposition = true, ReleaseReason reason = ReleaseReason.completed}) =>
    ReleasedFrame(attemptId: attemptId, reason: reason, requiresDisposition: requiresDisposition, message: 'Call ended.');

AgentStateFrame agentState(
  AgentState state, {
  DateTime? since,
  String? breakReason,
  AgentState? pending,
  String? pendingBreakReason,
}) =>
    AgentStateFrame(
      state: state,
      since: since ?? DateTime.utc(2026, 8, 11, 10),
      breakReason: breakReason,
      pendingState: pending,
      pendingBreakReason: pendingBreakReason,
    );

ReadyFrame ready({
  AgentState state = AgentState.available,
  ActiveAttempt? active,
  WrapupState? wrapup,
  MissedRelease? missed,
  AgentState? pending,
  String? pendingBreakReason,
}) =>
    ReadyFrame(
      sessionId: 'sess-1',
      state: state,
      activeAttempt: active,
      activeWrapup: wrapup,
      missedRelease: missed,
      pendingState: pending,
      pendingBreakReason: pendingBreakReason,
    );

MissedRelease missedRelease(String attemptId) => MissedRelease(
      attemptId: attemptId,
      reason: ReleaseReason.completed,
      requiresDisposition: false,
      message: 'x',
      endedAt: DateTime.utc(2026, 8, 11, 10),
    );

/// A bootstrap body as the server sends it.
Map<String, Object?> bootstrapJson({
  String sessionId = 'sess-1',
  String campaignId = 'camp-1',
  String state = 'offline',
  String campaignStatus = 'running',
  String? tokenExpiresAt,
  Map<String, Object?>? contextDisplay,
  List<Map<String, Object?>>? dispositions,
  List<Map<String, Object?>>? breakReasons,
}) =>
    {
      'session_id': sessionId,
      'campaign_id': campaignId,
      'campaign_name': 'Renewals',
      'agent_user_id': 'u-1',
      'state': state,
      'campaign_status': campaignStatus,
      'station_ws_url': '/proxy/agency/station?token=boot',
      'station_token_expires_at': ?tokenExpiresAt,
      'disposition_catalog': dispositions ??
          [
            {'code': 'interested', 'label': 'Interested', 'is_success': true},
            {'code': 'callback', 'label': 'Call back', 'requires_datetime': true},
            {'code': 'not_interested', 'label': 'Not interested', 'requires_note': true},
            {'code': 'do_not_call', 'label': 'Do not call', 'suppress': true},
          ],
      'wrapup_seconds': 30,
      'wrapup_auto_return': true,
      'record_calls': true,
      'break_reasons': breakReasons ??
          [
            {'code': 'tea', 'label': 'Tea break'},
            {'code': 'lunch', 'label': 'Lunch'},
          ],
      'context_display': contextDisplay ?? <String, Object?>{},
      'intervals': {
        'heartbeat_ms': 10000,
        'heartbeat_grace_ms': 10000,
        'reservation_lease_ms': 10000,
        'countdown_ms': 3000,
        'deferred_hangup_ms': 8000,
      },
    };

SessionBootstrap bootstrap() => SessionBootstrap.fromJson(bootstrapJson());

/// `POST /softphone/sessions`' answer as the server sends it.
Map<String, Object?> softphoneSessionJson({
  String sessionId = 'sess-sp',
  String stationWsUrl = '/proxy/agency/station?token=sp',
}) =>
    {
      'session_id': sessionId,
      'kind': 'softphone',
      'state': 'break',
      'break_reason': 'soft_phone',
      'station_ws_url': stationWsUrl,
      'station_token_expires_at': '2026-11-01T09:02:00.000Z',
      'intervals': {
        'heartbeat_ms': 10000,
        'heartbeat_grace_ms': 10000,
        'reservation_lease_ms': 10000,
        'countdown_ms': 3000,
        'deferred_hangup_ms': 8000,
      },
    };
