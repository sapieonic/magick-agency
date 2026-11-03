import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/core/telemetry/telemetry.dart';
import 'package:magick_agency_agent/features/contacts/my_contacts_controller.dart';
import 'package:magick_agency_agent/features/contacts/my_contacts_copy.dart';

import '../../core/telemetry/fake_telemetry_sink.dart';
import 'support.dart';

void main() {
  late FakeMyContactsApi api;
  late ProviderContainer container;
  late FakeTelemetrySink sink;

  MyContactsController controller() => container.read(myContactsControllerProvider('c1').notifier);
  MyContactsState state() => container.read(myContactsControllerProvider('c1'));

  setUp(() {
    api = FakeMyContactsApi();
    container = ProviderContainer(overrides: contactsOverrides(api));
    // Keep the auto-dispose controller alive for the test, as the screen does.
    final sub = container.listen(myContactsControllerProvider('c1'), (_, _) {});
    addTearDown(sub.close);
    addTearDown(container.dispose);
    sink = FakeTelemetrySink();
    Telemetry.install(sink);
    addTearDown(Telemetry.uninstall);
  });

  Future<void> loaded(List<MyContact> rows, {String? next}) async {
    final f = controller().ensureLoaded();
    api.answer(api.pending.length - 1, contactsPage(rows, next: next));
    await f;
  }

  group('loading and paging', () {
    test('the counts and the first page, 50 at a time, for this campaign only', () async {
      final f = controller().ensureLoaded();
      expect(state().status, MyContactsStatus.loading);
      expect(api.summaries, ['c1']);
      expect(api.q(0), {'campaign_id': 'c1', 'limit': '50'});
      api.answer(0, contactsPage([contact(1), contact(2)], next: 'cur-1'));
      await f;
      expect(state().status, MyContactsStatus.ready);
      expect(state().rows.map((r) => r.id), ['k1', 'k2']);
      expect(state().hasMore, isTrue);
      expect(state().summary!.total, 30);
    });

    test('opening it once says so, with counts and no phone number', () async {
      await loaded([contact(1)]);
      final again = controller().reload();
      api.answer(1, contactsPage([contact(1)]));
      await again;
      expect(sink.names.where((n) => n == 'agency_my_contacts_viewed'), hasLength(1));
      final e = sink.last('agency_my_contacts_viewed');
      expect(e['campaign_id'], 'c1');
      expect(e['count_pending'], 12);
      expect(e['count_suppressed'], 1);
      expect(e['retry_eligible'], 3);
      expect(e['assignment_mode'], 'strict');
      expect(e.values.whereType<String>().where((v) => v.contains('98400')), isEmpty);
    });

    test('more pages append with the cursor; one in flight at a time; the last page ends it', () async {
      await loaded([contact(1)], next: 'cur-1');
      final more = controller().loadMore();
      unawaited(controller().loadMore());
      expect(api.queries, hasLength(2));
      expect(api.q(1)['cursor'], 'cur-1');
      api.answer(1, contactsPage([contact(2)]));
      await more;
      expect(state().rows.map((r) => r.id), ['k1', 'k2']);
      expect(state().hasMore, isFalse);
      await controller().loadMore();
      expect(api.queries, hasLength(2));
    });

    test('a failed "more" keeps the rows and waits for retryMore', () async {
      await loaded([contact(1)], next: 'cur-1');
      final more = controller().loadMore();
      api.fail(1);
      await more;
      expect(state().rows, hasLength(1));
      expect(state().moreError, isNotNull);
      await controller().loadMore();
      expect(api.queries, hasLength(2), reason: 'no retry until asked');
      final again = controller().retryMore();
      api.answer(2, contactsPage([contact(2)]));
      await again;
      expect(state().rows, hasLength(2));
      expect(state().moreError, isNull);
    });

    test('a failed first page is an error the screen can retry', () async {
      final f = controller().ensureLoaded();
      api.fail(0);
      await f;
      expect(state().status, MyContactsStatus.error);
      expect(state().error, const ApiNetworkError('offline').userMessage);
    });

    test('the flag turned off on the server reads as the flag, not a raw code', () async {
      api.summaryAnswer = refusal('assignment_disabled', status: 403);
      final f = controller().ensureLoaded();
      api.pending.single.completeError(refusal('assignment_disabled', status: 403));
      await f;
      expect(state().error, MyContactsCopy.flagOff);
      expect(state().summaryError, MyContactsCopy.flagOff);
    });

    test('another workspace drops the rows at once, and a page in flight for the old one', () async {
      final f = controller().ensureLoaded();
      container.read(testWorkspaceProvider.notifier).set('u2:t1:a1');
      expect(state().rows, isEmpty);
      api.answer(0, contactsPage([contact(1)]));
      await f;
      expect(state().rows, isEmpty, reason: 'the old agent’s page never lands');
    });
  });

  group('filters', () {
    test('buckets go comma-joined in the contract’s order; the phone as digits; back to the first page', () async {
      await loaded([contact(1)], next: 'cur-1');
      final f = controller().applyFilters(
        MyContactsFilters(buckets: {MyContactBucket.exhausted, MyContactBucket.notReached}, phone: ' +91 98400 '),
      );
      expect(api.q(1), {'campaign_id': 'c1', 'bucket': 'not_reached,exhausted', 'phone': '9198400', 'limit': '50'});
      expect(api.q(1).containsKey('cursor'), isFalse);
      expect(state().rows, isEmpty, reason: 'never page 2 of the old query under the new one');
      api.answer(1, contactsPage([contact(3)]));
      await f;
      expect(state().rows.single.id, 'k3');
      expect(state().filters.isFiltered, isTrue);
    });

    test('the same filters again read nothing', () async {
      await loaded([contact(1)]);
      await controller().applyFilters(MyContactsFilters.initial);
      expect(api.queries, hasLength(1));
    });

    test('a page for a filter no longer on screen is dropped', () async {
      await loaded([contact(1)], next: 'cur-1');
      final more = controller().loadMore();
      final f = controller().applyFilters(MyContactsFilters(buckets: {MyContactBucket.callback}));
      api.answer(1, contactsPage([contact(9)]));
      await more;
      expect(state().rows, isEmpty);
      api.answer(2, contactsPage([contact(2, bucket: MyContactBucket.callback)]));
      await f;
      expect(state().rows.map((r) => r.id), ['k2']);
    });

    test('a filter change clears the picked contacts', () async {
      await loaded([contact(1, eligible: true)]);
      controller().toggleSelected(state().rows.single);
      expect(state().selected, {'k1'});
      final f = controller().applyFilters(MyContactsFilters(buckets: {MyContactBucket.exhausted}));
      expect(state().selected, isEmpty);
      api.answer(1, contactsPage([]));
      await f;
    });
  });

  group('retry not reached', () {
    test('only an eligible contact can be picked', () async {
      await loaded([contact(1, eligible: true), contact(2, blocked: AgentRetryBlock.cooldown)]);
      controller().toggleSelected(state().rows[1]);
      expect(state().selected, isEmpty);
      controller().toggleSelected(state().rows[0]);
      expect(state().selected, {'k1'});
      controller().toggleSelected(state().rows[0]);
      expect(state().selected, isEmpty);
    });

    test('all: one request with all, then the counts and the list again', () async {
      await loaded([contact(1, eligible: true)]);
      final f = controller().retry();
      expect(state().retrying, isTrue);
      final result = await f;
      expect(api.retries.single.toJson(), {'campaign_id': 'c1', 'all': true});
      expect(result.ok, isTrue);
      expect(result.message, 'Reopened 3 contacts. They’ll be dialled in turn.');
      expect(state().retrying, isFalse);
      expect(api.summaries, hasLength(2), reason: 'the counts are read again');
      expect(api.queries, hasLength(2), reason: 'and the list');
      final e = sink.last('agency_agent_retry_requested');
      expect(e, {'campaign_id': 'c1', 'scope': 'all', 'requested': 3, 'outcome': 'reopened', 'reopened': 3, 'skipped_total': 0});
    });

    test('selected: the picked ids, and the skipped ones counted', () async {
      await loaded([contact(1, eligible: true), contact(2, eligible: true)]);
      controller()
        ..toggleSelected(state().rows[0])
        ..toggleSelected(state().rows[1]);
      api.retryAnswer = AgentRetryResponse(
        reopened: 1,
        skipped: [AgentRetrySkip(contactId: 'k2', blocked: AgentRetryBlock.cooldown)],
        skippedTotal: 1,
      );
      final result = await controller().retry(selectedOnly: true);
      expect(api.retries.single.toJson(), {
        'campaign_id': 'c1',
        'contact_ids': ['k1', 'k2'],
      });
      expect(result.message, 'Reopened 1 contact. They’ll be dialled in turn. 1 couldn’t be retried now.');
      expect(state().selected, isEmpty);
      expect(sink.last('agency_agent_retry_requested')['scope'], 'selected');
    });

    test('selected with nothing picked sends nothing', () async {
      await loaded([contact(1, eligible: true)]);
      final result = await controller().retry(selectedOnly: true);
      expect(result.ok, isFalse);
      expect(api.retries, isEmpty);
    });

    test('a refusal is said in the app’s words, and counted with its code only', () async {
      await loaded([contact(1, eligible: true)]);
      api.retryAnswer = refusal('agent_retry_disabled', status: 403);
      final result = await controller().retry();
      expect(result.ok, isFalse);
      expect(result.message, 'This campaign doesn’t let agents retry contacts.');
      expect(state().retrying, isFalse);
      expect(sink.last('agency_agent_retry_requested'), {
        'campaign_id': 'c1',
        'scope': 'all',
        'requested': 3,
        'outcome': 'refused',
        'code': 'agent_retry_disabled',
      });
    });
  });

  group('calling a contact', () {
    test('from the agent’s available session on this campaign; the station takes it from there', () async {
      await loaded([contact(1, eligible: true)]);
      final result = await controller().call(state().rows.single);
      expect(result, isA<ContactCallPlaced>());
      final (id, request) = api.calls.single;
      expect(id, 'k1');
      expect(request.toJson(), {'campaign_id': 'c1', 'session_id': 'sess-1'});
      expect(state().callingId, isNull);
      final e = sink.last('agency_my_contact_call_requested');
      expect(e, {
        'campaign_id': 'c1',
        'bucket': 'not_reached',
        'override_kinds': 'none',
        'with_override_note': false,
        'outcome': 'placed',
        'override_applied': 'none',
        'retry_round_spent': false,
      });
    });

    test('nothing is sent unless the agent is available on this campaign’s station', () async {
      await loaded([contact(1, eligible: true)]);
      final holder = container.read(stationHolder.notifier);
      for (final (view, words) in [
        (null, MyContactsCopy.callNeedsStation),
        (onStation(campaignId: 'c2'), MyContactsCopy.callNeedsStation),
        (onStation(phase: AgentPhase.onBreak), MyContactsCopy.callNeedsAvailable),
        (onStation(phase: AgentPhase.wrapup), MyContactsCopy.callNeedsAvailable),
        (onStation(sessionId: null), MyContactsCopy.callNeedsStation),
      ]) {
        holder.set(view);
        final result = await controller().call(state().rows.single);
        expect(result, isA<ContactCallFailed>().having((r) => r.message, 'message', words), reason: '$view');
      }
      expect(api.calls, isEmpty);
    });

    test('the gate the screen reads agrees', () {
      expect(callGateOf(onStation(), 'c1'), const ContactCallGate.open('sess-1'));
      expect(callGateOf(onStation(), 'c2').isOpen, isFalse);
      expect(callGateOf(onStation(phase: AgentPhase.offline), 'c1').blocked, MyContactsCopy.callNeedsAvailable);
      expect(callGateOf(null, 'c1').blocked, MyContactsCopy.callNeedsStation);
    });

    test('outside calling hours with a calling-hours override: asks for the note, then calls with it', () async {
      final c = contact(1, state: ContactState.pending, grant: grant(hours: true));
      await loaded([c]);
      api.callAnswers.add(refusal('outside_calling_hours', details: {'next_open_at': '2026-10-14T03:30:00.000Z'}));
      final first = await controller().call(c);
      expect(first, isA<ContactCallNeedsNote>().having((r) => r.grant.disposition, 'grant', 'promise_to_pay'));
      api.callAnswers.add(placed('k1', applied: ['calling_hours']));
      final second = await controller().call(c, overrideNote: '  Customer asked to be called after 9pm.  ');
      expect(second, isA<ContactCallPlaced>());
      expect(api.calls[1].$2.toJson()['override_note'], 'Customer asked to be called after 9pm.');
      final e = sink.last('agency_my_contact_call_requested');
      expect(e['with_override_note'], isTrue);
      expect(e['override_kinds'], 'calling_hours');
      expect(e['override_applied'], 'calling_hours');
      expect(e.values.whereType<String>().where((v) => v.contains('9pm')), isEmpty, reason: 'the note never leaves');
    });

    test('outside calling hours without the override is a plain refusal, with when it opens', () async {
      final c = contact(1, eligible: true);
      await loaded([c]);
      api.callAnswers.add(refusal('outside_calling_hours', details: {'next_open_at': '2026-10-14T03:30:00.000Z'}));
      final result = await controller().call(c);
      expect(result, isA<ContactCallFailed>());
      expect((result as ContactCallFailed).message, startsWith('It’s outside this campaign’s calling hours. Calls resume at'));
    });

    test('a note outside 10–500 characters is not sent', () async {
      final c = contact(1, grant: grant(hours: true));
      await loaded([c]);
      expect(await controller().call(c, overrideNote: ' too short '), isA<ContactCallFailed>());
      expect(await controller().call(c, overrideNote: 'x' * 501), isA<ContactCallFailed>());
      expect(api.calls, isEmpty);
      expect(overrideNoteProblem('0123456789'), isNull);
      expect(overrideNoteProblem('x' * 500), isNull);
    });

    test('a contact that moved under us (reassigned, blocked) refreshes the list', () async {
      final c = contact(1, eligible: true);
      await loaded([c]);
      api.callAnswers.add(refusal('contact_not_retryable', details: {'blocked': 'cooldown'}));
      final result = await controller().call(c);
      expect((result as ContactCallFailed).message, startsWith('This contact can’t be called now.'));
      expect(api.queries, hasLength(2));
      expect(sink.last('agency_my_contact_call_requested')['code'], 'contact_not_retryable');
    });

    test('one call at a time', () async {
      final c = contact(1, eligible: true);
      await loaded([c]);
      final gate = Completer<MyContactCallResponse>();
      api.callAnswers.add(gate.future);
      final first = controller().call(c);
      expect(state().callingId, 'k1');
      expect(await controller().call(c), isA<ContactCallFailed>());
      gate.complete(placed('k1'));
      expect(await first, isA<ContactCallPlaced>());
      expect(state().callingId, isNull);
      expect(api.calls, hasLength(1));
    });
  });

  group('what may be called', () {
    final now = fixedNow;
    test('one the agent can retry, one that is due, or an open one they may call early', () {
      expect(canCallContact(contact(1, eligible: true, bucket: MyContactBucket.exhausted, state: ContactState.exhausted), now), isTrue);
      expect(canCallContact(contact(2, next: now.subtract(const Duration(minutes: 1))), now), isTrue);
      expect(canCallContact(contact(3, grant: grant(early: true)), now), isTrue);
      expect(canCallContact(contact(4), now), isFalse, reason: 'not due, no override, not retryable');
      expect(canCallContact(contact(5, grant: grant(hours: true)), now), isFalse, reason: 'hours alone does not make it due');
      expect(
        canCallContact(contact(6, bucket: MyContactBucket.suppressed, state: ContactState.suppressed, eligible: true), now),
        isFalse,
      );
      expect(canCallContact(contact(7, bucket: MyContactBucket.inProgress, state: ContactState.inFlight), now), isFalse);
    });
  });

  test('a 401 reaches the gate', () async {
    final f = controller().ensureLoaded();
    api.fail(0, const ApiUnauthorized());
    await f;
    await pumpEventQueue();
    expect((container.read(appGateProvider.notifier) as RecordingGate).reported, isNotEmpty);
  });
}
