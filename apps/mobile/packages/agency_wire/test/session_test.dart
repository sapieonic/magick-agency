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
      expect(b.stationWsUrl, startsWith('/proxy/agency/station?token='));
      expect(b.stationTokenExpiresAt, DateTime.utc(2026, 11, 1, 6, 2));
      expect(b.dispositionCatalog.map((d) => d.code), [
        'interested',
        'not_interested',
        'wrong_number',
        'voicemail',
        'callback',
        'do_not_call',
      ]);
      expect(b.dispositionFor('interested')!.isSuccess, isTrue);
      expect(b.dispositionFor('not_interested')!.isSuccess, isNull, reason: 'absent stays absent');
      expect(b.dispositionFor('voicemail')!.retry, const DispositionRetry(delayMinutes: 120, maxAttempts: 3));
      expect(b.dispositionFor('callback')!.datetimeRequired, isTrue);
      expect(b.dispositionFor('callback')!.noteRequired, isFalse);
      expect(b.dispositionFor('do_not_call')!.noteRequired, isTrue);
      expect(b.dispositionFor('gone'), isNull);
      expect(b.breakReasons.map((r) => (r.code, r.isPaid)), [('tea', true), ('lunch', false), ('training', null)]);
      expect(b.intervals.heartbeat, const Duration(seconds: 10));
      expect(b.intervals.heartbeatGrace, const Duration(seconds: 30));
      expect(b.intervals.countdown, const Duration(seconds: 3));
      expect(b.intervals.deferredHangup, const Duration(seconds: 15));
      expect(b.intervals.toJson(), json['intervals']);
      expect(b.recordCalls, isTrue);
      expect(b.retryContext, isNull);
      expect(() => b.dispositionCatalog.add(b.dispositionCatalog.first), throwsUnsupportedError);
    });

    test('a retry campaign carries its banner, and a rehydrated session lands on break', () {
      final b = SessionBootstrap.fromJson(fixture('session.json', 'bootstrap_retry_rehydrated'));
      expect(b.state, AgentState.onBreak);
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

    test('mobile heartbeat grace (10 s) is read, not assumed', () {
      final intervals = {...json['intervals']! as Map<String, Object?>, 'heartbeat_grace_ms': 10000};
      expect(
        SessionBootstrap.fromJson({...json, 'intervals': intervals}).intervals.heartbeatGrace,
        const Duration(seconds: 10),
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
    expect(t.stationWsUrl, startsWith('/proxy/agency/station?token='));
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
    test('join sends only what is set', () {
      expect(const CreateSessionRequest(campaignId: 'c').toJson(), {'campaign_id': 'c'});
      expect(const CreateSessionRequest(campaignId: 'c', sessionId: 's', clientKind: ClientKind.mobile).toJson(), {
        'campaign_id': 'c',
        'session_id': 's',
        'client_kind': 'mobile',
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
