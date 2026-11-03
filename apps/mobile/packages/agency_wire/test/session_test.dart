import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

Map<String, Object?> without(Map<String, Object?> j, String key) => Map.of(j)..remove(key);

void main() {
  group('SessionBootstrap', () {
    final json = fixture('session.json', 'bootstrap_first_join');

    test('decodes everything the station renders with', () {
      final b = SessionBootstrap.fromJson(json);
      expect(b.state, AgentState.offline);
      expect(b.campaignStatus, CampaignStatus.running);
      // The real shape: the session id in the path, the token in the query.
      expect(b.stationWsUrl, startsWith('/proxy/agency/station/${b.sessionId}?token='));
      expect(b.stationTokenExpiresAt, DateTime.utc(2026, 11, 1, 6, 2));
      expect(b.dispositionCatalog.map((d) => d.code), [
        'interested',
        'not_interested',
        'wrong_number',
        'voicemail',
        'callback',
        'do_not_call',
        'promise_to_pay',
      ]);
      expect(b.dispositionFor('interested')!.isSuccess, isTrue);
      expect(b.dispositionFor('not_interested')!.isSuccess, isNull, reason: 'absent stays absent');
      expect(b.dispositionFor('voicemail')!.retry, const DispositionRetry(delayMinutes: 120, maxAttempts: 3));
      expect(b.dispositionFor('callback')!.datetimeRequired, isTrue);
      expect(b.dispositionFor('callback')!.noteRequired, isFalse);
      expect(b.dispositionFor('do_not_call')!.noteRequired, isTrue);
      expect(b.dispositionFor('gone'), isNull);
      expect(b.breakReasons.map((r) => (r.code, r.isPaid)), [('tea', true), ('lunch', false), ('training', null)]);
      // A mobile join's intervals: the 10 s phone grace and the 8 s deferred hangup.
      expect(b.intervals.heartbeat, const Duration(seconds: 10));
      expect(b.intervals.heartbeatGrace, const Duration(seconds: 10));
      expect(b.intervals.countdown, const Duration(seconds: 3));
      expect(b.intervals.deferredHangup, const Duration(seconds: 8));
      expect(b.intervals.toJson(), json['intervals']);
      expect(b.recordCalls, isTrue);
      expect(b.retryContext, isNull);
      expect(b.breakReason, isNull, reason: 'offline: no break to name');
      expect(() => b.dispositionCatalog.add(b.dispositionCatalog.first), throwsUnsupportedError);
    });

    test('a retry campaign carries its banner, and a rehydrated session lands on break', () {
      final b = SessionBootstrap.fromJson(fixture('session.json', 'bootstrap_retry_rehydrated'));
      expect(b.state, AgentState.onBreak);
      // Killed by the OS while paused for leaving the app: the reason survives the cold start.
      expect(b.breakReason, 'device_away');
      expect(ReservedBreakCode.tryFromWire(b.breakReason), ReservedBreakCode.deviceAway);
      expect(
        SessionBootstrap.fromJson(without(fixture('session.json', 'bootstrap_retry_rehydrated'), 'break_reason'))
            .breakReason,
        isNull,
      );
      expect(b.retryContext!.generation, 1);
      expect(b.retryContext!.parentCampaignName, 'Q3 Winback');
      expect(b.wrapupSeconds, 0);
      expect(b.contextDisplay, ContextDisplay());
    });

    test('the fields the console reads as optional decode when absent', () {
      final b = SessionBootstrap.fromJson(without(json, 'station_token_expires_at'));
      expect(b.stationTokenExpiresAt, isNull);
      final intervals = without(json['intervals']! as Map<String, Object?>, 'deferred_hangup_ms');
      final c = SessionBootstrap.fromJson({...json, 'intervals': intervals});
      expect(c.intervals.deferredHangup, isNull);
    });

    test('wrap-up redial: stated by the campaign, false when absent (an older server)', () {
      expect(SessionBootstrap.fromJson(json).allowWrapupRedial, isTrue);
      expect(SessionBootstrap.fromJson(without(json, 'allow_wrapup_redial')).allowWrapupRedial, isFalse);
      expect(SessionBootstrap.fromJson({...json, 'allow_wrapup_redial': null}).allowWrapupRedial, isFalse);
      expect(
        SessionBootstrap.fromJson(fixture('session.json', 'bootstrap_retry_rehydrated')).allowWrapupRedial,
        isFalse,
      );
      expect(SessionBootstrap.fromJson(json), isNot(SessionBootstrap.fromJson(without(json, 'allow_wrapup_redial'))));
    });

    test('contact assignment: mode, agent retry and the queue at join', () {
      final b = SessionBootstrap.fromJson(json);
      expect(b.assignmentMode, AssignmentMode.strict);
      expect(b.assignmentMode.hasOwnQueue, isTrue);
      expect(b.allowAgentRetry, isTrue);
      expect(b.queue, QueueState(due: false, reason: QueueIdleReason.queueEmpty));
      expect(b.queue!.nextDueAt, isNull);
      // An outcome's override grant; the built-ins grant nothing.
      final ptp = b.dispositionFor('promise_to_pay')!;
      expect(ptp.overrideGrant, const DispositionOverride(extraAttempts: 3, retryDelay: true));
      expect(ptp.overrideGrant!.kinds, [OverrideKind.extraAttempts, OverrideKind.retryDelay]);
      expect(ptp.overrideGrant!.callingHours, isNull, reason: 'absent stays absent');
      expect(b.dispositionFor('callback')!.overrideGrant, isNull);
    });

    test('contact assignment: an older server is a pool campaign with no queue and no retry', () {
      final old = SessionBootstrap.fromJson(
        without(without(without(json, 'assignment_mode'), 'allow_agent_retry'), 'queue'),
      );
      expect(old.assignmentMode, AssignmentMode.pool);
      expect(old.assignmentModeRaw, 'pool');
      expect(old.assignmentMode.hasOwnQueue, isFalse);
      expect(old.allowAgentRetry, isFalse);
      expect(old.queue, isNull);
      expect(old, isNot(SessionBootstrap.fromJson(json)));
      // A mode this build does not know is kept, not a failure.
      final newer = SessionBootstrap.fromJson({...json, 'assignment_mode': 'round_robin'});
      expect(newer.assignmentMode, AssignmentMode.unknown);
      expect(newer.assignmentModeRaw, 'round_robin');
      expect(newer.assignmentMode.hasOwnQueue, isFalse);
      // So is a queue reason.
      final reason = SessionBootstrap.fromJson({
        ...json,
        'queue': {'due': false, 'reason': 'supervisor_hold', 'next_due_at': null},
      }).queue!;
      expect(reason.reason, QueueIdleReason.unknown);
      expect(reason.reasonRaw, 'supervisor_hold');
    });

    test('an override grant with a mistyped part names the key', () {
      final catalog = [
        {
          'code': 'x',
          'label': 'X',
          'override': {'extra_attempts': 'three'},
        },
      ];
      expect(
        () => SessionBootstrap.fromJson({...json, 'disposition_catalog': catalog}),
        throwsA(isA<WireFormatException>().having((e) => e.key, 'key', 'extra_attempts')),
      );
    });

    test('the heartbeat grace is read, not assumed', () {
      final intervals = {...json['intervals']! as Map<String, Object?>, 'heartbeat_grace_ms': 30000};
      expect(
        SessionBootstrap.fromJson({...json, 'intervals': intervals}).intervals.heartbeatGrace,
        const Duration(seconds: 30),
      );
    });

    test('a missing required field names the key', () {
      expect(
        () => SessionBootstrap.fromJson(without(json, 'disposition_catalog')),
        throwsA(isA<WireFormatException>().having((e) => e.key, 'key', 'disposition_catalog')),
      );
      expect(
        () => SessionBootstrap.fromJson({...json, 'record_calls': 'yes'}),
        throwsA(isA<WireFormatException>().having((e) => e.key, 'key', 'record_calls')),
      );
    });

    test('equality', () {
      expect(SessionBootstrap.fromJson(json), SessionBootstrap.fromJson(json));
      expect(SessionBootstrap.fromJson(json).hashCode, SessionBootstrap.fromJson(json).hashCode);
      expect(SessionBootstrap.fromJson(json), isNot(SessionBootstrap.fromJson({...json, 'wrapup_seconds': 31})));
    });
  });

  group('ContextDisplay.resolve', () {
    final context = <String, Object?>{
      'Internal ID': 'X-1',
      'Branch': 'Kothrud',
      'Name': 'Priya',
      'Premium (INR)': 18450,
      'Policy No': 'PL-1',
      'Renewal Due': '2026-11-15',
    };

    test('hero first in array order, then order, then CSV order, minus hidden', () {
      final d = ContextDisplay(
        hero: ['Name', 'Policy No', 'Missing column'],
        order: ['Premium (INR)', 'Name'],
        hidden: ['Internal ID'],
      );
      final r = d.resolve(context);
      expect(r.hero.map((e) => e.key), ['Name', 'Policy No']);
      expect(r.rest.map((e) => e.key), ['Premium (INR)', 'Branch', 'Renewal Due']);
    });

    test('hidden beats hero', () {
      final r = ContextDisplay(hero: ['Name'], hidden: ['Name']).resolve(context);
      expect(r.hero, isEmpty);
      expect(r.rest.map((e) => e.key), isNot(contains('Name')));
    });

    test('no opinion renders every column in CSV order', () {
      final r = ContextDisplay().resolve(context);
      expect(r.hero, isEmpty);
      expect(r.rest.map((e) => e.key), context.keys);
    });
  });

  test('StationTokenResponse', () {
    final t = StationTokenResponse.fromJson(fixture('session.json', 'station_token'));
    expect(t.expiresAt, DateTime.utc(2026, 11, 1, 6, 14));
    expect(t.stationWsUrl, startsWith('/proxy/agency/station/${t.sessionId}?token='));
  });

  group('SessionStateResponse', () {
    test('a queued break reads break_reason, not pending_break_reason', () {
      final s = SessionStateResponse.fromJson(fixture('session.json', 'session_state_break_queued'));
      expect(s.kind, SessionKind.campaign);
      expect(s.state, AgentState.onCall);
      expect(s.pendingState, AgentState.onBreak);
      expect(s.breakReason, 'lunch');
    });

    test('explicit nulls read as absent; a soft-phone session has no campaign', () {
      final s = SessionStateResponse.fromJson({
        'campaign_id': null,
        'session_id': 's',
        'kind': 'softphone',
        'state': 'break',
        'since': '2026-11-01T00:00:00Z',
        'pending_state': null,
        'break_reason': 'soft_phone',
      });
      expect(s.campaignId, isNull);
      expect(s.pendingState, isNull);
      expect(ReservedBreakCode.tryFromWire(s.breakReason), ReservedBreakCode.softPhone);
    });
  });

  group('requests', () {
    test('join sends only what is set, and never the client kind (that is the X-Client header)', () {
      expect(const CreateSessionRequest(campaignId: 'c').toJson(), {'campaign_id': 'c'});
      expect(const CreateSessionRequest(campaignId: 'c', sessionId: 's').toJson(), {
        'campaign_id': 'c',
        'session_id': 's',
      });
    });

    test('the device-away break uses the reserved code', () {
      expect(SessionBreakRequest.deviceAway().toJson(), {'reason': 'device_away'});
      expect(ReservedBreakCode.tryFromWire('device_away'), ReservedBreakCode.deviceAway);
      expect(ReservedBreakCode.tryFromWire('lunch'), isNull);
      expect(const SessionBreakRequest('lunch').toJson(), fixture('session.json', 'break_request'));
    });
  });
}
