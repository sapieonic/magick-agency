import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

void main() {
  group('my-contacts summary', () {
    final json = fixture('reads.json', 'my_contacts_summary');

    test('counts per bucket, the queue and what can be retried', () {
      final s = MyContactsSummary.fromJson(json);
      expect(s.assignmentMode, AssignmentMode.strict);
      expect(s.total, 30);
      expect(s.counts[MyContactBucket.pending], 12);
      expect(s.counts[MyContactBucket.callback], 2);
      expect(s.counts[MyContactBucket.notReached], 5);
      expect(s.counts[MyContactBucket.inProgress], 0);
      expect(s.counts[MyContactBucket.reached], 7);
      expect(s.counts[MyContactBucket.exhausted], 3);
      expect(s.counts[MyContactBucket.suppressed], 1);
      expect(s.counts.total, s.total);
      expect(s.dueNow, 0);
      expect(s.queue.reason, QueueIdleReason.waitingForRetry);
      expect(s.queue.nextDueAt, DateTime.utc(2026, 11, 3, 15));
      expect(s.unassignedOpen, 4);
      expect(s.retry, const MyContactsRetrySummary(allowed: true, rounds: 1, cooldownMinutes: 30, eligible: 6));
      expect(s.offersRetry, isTrue);
    });

    test('retry is offered only when allowed, something is eligible and nothing is due', () {
      Map<String, Object?> retry(bool allowed, int eligible) => {
        'allowed': allowed,
        'rounds': 1,
        'cooldown_minutes': 30,
        'eligible': eligible,
      };
      expect(MyContactsSummary.fromJson({...json, 'due_now': 2}).offersRetry, isFalse);
      expect(MyContactsSummary.fromJson({...json, 'retry': retry(false, 6)}).offersRetry, isFalse);
      expect(MyContactsSummary.fromJson({...json, 'retry': retry(true, 0)}).offersRetry, isFalse);
    });

    test('a bucket this build does not know is still counted; an absent one is 0', () {
      final counts = {...json['counts']! as Map<String, Object?>, 'parked': 2}..remove('suppressed');
      final s = MyContactsSummary.fromJson({...json, 'counts': counts});
      expect(s.counts[MyContactBucket.suppressed], 0);
      expect(s.counts.byBucket['parked'], 2);
      expect(s.counts.total, 31);
      expect(s.counts[MyContactBucket.unknown], 0);
    });

    test('an unknown mode is kept; a mistyped count names the key', () {
      final s = MyContactsSummary.fromJson({...json, 'assignment_mode': 'round_robin'});
      expect(s.assignmentMode, AssignmentMode.unknown);
      expect(s.assignmentModeRaw, 'round_robin');
      expect(
        () => MyContactsSummary.fromJson({
          ...json,
          'counts': {'pending': '12'},
        }),
        throwsA(isA<WireFormatException>().having((e) => e.key, 'key', 'pending')),
      );
    });

    test('equality', () {
      expect(MyContactsSummary.fromJson(json), MyContactsSummary.fromJson(json));
      expect(MyContactsSummary.fromJson(json).hashCode, MyContactsSummary.fromJson(json).hashCode);
      expect(MyContactsSummary.fromJson(json), isNot(MyContactsSummary.fromJson({...json, 'total': 31})));
    });
  });

  group('my-contacts list', () {
    test('a keyset page of the agent\'s own contacts', () {
      final p = decodeMyContactsPage(fixture('reads.json', 'my_contacts'));
      expect(p.rows, hasLength(3));
      expect(p.hasMore, isTrue);
      expect(p.limit, 3);

      final exhausted = p.rows[0];
      expect(exhausted.bucket, MyContactBucket.exhausted);
      expect(exhausted.state, ContactState.exhausted);
      expect(exhausted.hero, const [
        HeroField(name: 'Name', value: 'Asha Rao'),
        HeroField(name: 'Loan', value: 'LN-2201'),
      ]);
      expect(exhausted.retry.eligible, isTrue);
      expect(exhausted.retry.blocked, isNull);
      expect(exhausted.overrideGrant, isNull);
      expect(exhausted.lastOutcome, 'no_answer');

      final callback = p.rows[1];
      expect(callback.bucket, MyContactBucket.callback);
      expect(callback.lastDisposition, 'promise_to_pay');
      expect(callback.nextAttemptAt, DateTime.utc(2026, 11, 5, 5, 30));
      expect(callback.retry.blocked, AgentRetryBlock.notRetryable);
      expect(callback.overrideGrant!.disposition, 'promise_to_pay');
      expect(callback.overrideGrant!.kinds, [OverrideKind.extraAttempts, OverrideKind.retryDelay]);
      expect(callback.overrideGrant!.grantedAt, DateTime.utc(2026, 11, 3, 8, 12));

      final busy = p.rows[2];
      expect(busy.bucket, MyContactBucket.notReached);
      expect(busy.hero, isEmpty);
      expect(busy.retry.blocked, AgentRetryBlock.cooldown);
      expect(busy.retry.availableAt, DateTime.utc(2026, 11, 3, 15, 15));
      expect(busy.lastAttemptAt, DateTime.utc(2026, 11, 3, 14, 45));
    });

    test('due now: pending and its time has come', () {
      final busy = decodeMyContactsPage(fixture('reads.json', 'my_contacts')).rows[2];
      expect(busy.isDueAt(DateTime.utc(2026, 11, 3, 14, 59)), isFalse);
      expect(busy.isDueAt(DateTime.utc(2026, 11, 3, 15)), isTrue);
      final exhausted = decodeMyContactsPage(fixture('reads.json', 'my_contacts')).rows[0];
      expect(exhausted.isDueAt(DateTime.utc(2030)), isFalse, reason: 'not open');
    });

    test('the last page has no cursor', () {
      final p = decodeMyContactsPage(fixture('reads.json', 'my_contacts_last_page'));
      expect(p.rows, isEmpty);
      expect(p.hasMore, isFalse);
    });

    test('unknown bucket, state and block are kept beside their raw strings', () {
      final row = (fixture('reads.json', 'my_contacts')['rows']! as List<Object?>).first! as Map<String, Object?>;
      final c = MyContact.fromJson({
        ...row,
        'bucket': 'parked',
        'state': 'archived',
        'retry': {'eligible': false, 'blocked': 'quota', 'rounds_used': 1, 'available_at': null},
      });
      expect(c.bucket, MyContactBucket.unknown);
      expect(c.bucketRaw, 'parked');
      expect(c.state, ContactState.unknown);
      expect(c.stateRaw, 'archived');
      expect(c.retry.blocked, AgentRetryBlock.unknown);
      expect(c.retry.blockedRaw, 'quota');
    });

    test('a spent override has no kinds left', () {
      final o = ContactOverride(
        disposition: 'ptp',
        extraAttempts: 0,
        retryDelay: false,
        callingHours: false,
        grantedAt: DateTime.utc(2026),
      );
      expect(o.kinds, isEmpty);
      expect(
        ContactOverride(
          disposition: 'ptp',
          extraAttempts: 0,
          retryDelay: false,
          callingHours: true,
          grantedAt: DateTime.utc(2026),
        ).kinds,
        [OverrideKind.callingHours],
      );
    });

    group('query', () {
      test('buckets comma-joined under one key, phone as digits, empty ones left out', () {
        expect(
          MyContactsQuery(
            campaignId: 'c',
            buckets: const [MyContactBucket.notReached, MyContactBucket.callback],
            phone: '+91 98123',
            cursor: 'k',
            limit: 50,
          ).toQuery(),
          {'campaign_id': 'c', 'bucket': 'not_reached,callback', 'phone': '9198123', 'cursor': 'k', 'limit': '50'},
        );
        expect(MyContactsQuery(campaignId: 'c', phone: 'abc', q: '  ').toQuery(), {'campaign_id': 'c'});
        expect(MyContactsQuery(campaignId: 'c', q: ' Asha ').toQuery(), {'campaign_id': 'c', 'q': 'Asha'});
        expect(MyContactsQuery(campaignId: 'c', buckets: const [MyContactBucket.unknown]).toQuery(), {
          'campaign_id': 'c',
        }, reason: 'never sends a bucket the server does not know');
      });

      test('withCursor changes the cursor and nothing else', () {
        final q = MyContactsQuery(campaignId: 'c', buckets: const [MyContactBucket.pending], phone: '98');
        final next = q.withCursor('n');
        expect(next.cursor, 'n');
        expect(next.withCursor(null), q);
        expect(next, isNot(q));
      });
    });
  });

  group('agent retry', () {
    test('selected ids or all, never both', () {
      expect(AgentRetryRequest.selected(campaignId: 'c', contactIds: const ['a', 'b']).toJson(), {
        'campaign_id': 'c',
        'contact_ids': ['a', 'b'],
      });
      expect(const AgentRetryRequest.all(campaignId: 'c').toJson(), {'campaign_id': 'c', 'all': true});
      expect(() => AgentRetryRequest.selected(campaignId: 'c', contactIds: const []), throwsArgumentError);
      expect(
        () => AgentRetryRequest.selected(campaignId: 'c', contactIds: List.filled(agentRetryContactIdsMax + 1, 'x')),
        throwsArgumentError,
      );
    });

    test('the response counts what was reopened and why the rest was not', () {
      final r = AgentRetryResponse.fromJson(fixture('actions.json', 'agent_retry_response'));
      expect(r.reopened, 1);
      expect(r.skipped.single.blocked, AgentRetryBlock.cooldown);
      expect(r.skippedTotal, 1);
    });
  });

  group('per-contact call', () {
    test('the note is sent trimmed and only when given', () {
      expect(const MyContactCallRequest(campaignId: 'c', sessionId: 's').toJson(), {
        'campaign_id': 'c',
        'session_id': 's',
      });
      expect(const MyContactCallRequest(campaignId: 'c', sessionId: 's', overrideNote: '   ').toJson(), {
        'campaign_id': 'c',
        'session_id': 's',
      });
      expect(
        const MyContactCallRequest(
          campaignId: 'c',
          sessionId: 's',
          overrideNote: ' Customer asked for 9pm. ',
        ).toJson()['override_note'],
        'Customer asked for 9pm.',
      );
      expect(overrideNoteMin, 10);
      expect(overrideNoteMax, 500);
    });

    test('the response names the overrides spent and whether a round was', () {
      final r = MyContactCallResponse.fromJson(fixture('actions.json', 'my_contact_call_response'));
      expect(r.overrideApplied, [OverrideKind.extraAttempts]);
      expect(r.retryRoundSpent, isTrue);
      final newer = MyContactCallResponse.fromJson({
        ...fixture('actions.json', 'my_contact_call_response'),
        'override_applied': ['quiet_hours'],
      });
      expect(newer.overrideApplied, [OverrideKind.unknown]);
      expect(newer.overrideAppliedRaw, ['quiet_hours']);
    });
  });

  group('refusals', () {
    test('contact_not_retryable reads its block and when it lifts', () {
      final body = ErrorBody.fromJson(fixture('actions.json', 'error_contact_not_retryable'));
      expect(body.agentRetryCode, AgentRetryErrorCode.contactNotRetryable);
      final r = body.agentRetryRefusal!;
      expect(r.code, AgentRetryErrorCode.contactNotRetryable);
      expect(r.blocked, AgentRetryBlock.cooldown);
      expect(r.availableAt, DateTime.utc(2026, 11, 3, 15, 15));
      expect(r.message, 'This contact cannot be retried yet.');
    });

    test('outside_calling_hours and override_note_invalid read their details', () {
      final hours = ErrorBody.fromJson({
        'error': 'Conflict',
        'code': 'outside_calling_hours',
        'message': 'm',
        'details': {'next_open_at': '2026-11-04T03:30:00.000Z'},
      }).agentRetryRefusal!;
      expect(hours.nextOpenAt, DateTime.utc(2026, 11, 4, 3, 30));
      final note = ErrorBody.fromJson({
        'error': 'Bad Request',
        'code': 'override_note_invalid',
        'message': 'm',
        'details': {'min': 10, 'max': 500},
      }).agentRetryRefusal!;
      expect((note.noteMin, note.noteMax), (10, 500));
    });

    test('mistyped details read as absent, never a throw; a code that is not one is null', () {
      final r = ErrorBody.fromJson({
        'code': 'contact_not_retryable',
        'details': {'blocked': 7, 'available_at': 'soon'},
      }).agentRetryRefusal!;
      expect(r.blocked, isNull);
      expect(r.availableAt, isNull);
      expect(r.message, '');
      expect(ErrorBody.fromJson({'code': 'details_list', 'details': []}).agentRetryRefusal, isNull);
      expect(ErrorBody.fromJson(fixture('actions.json', 'error_session_ended')).agentRetryRefusal, isNull);
    });
  });
}
