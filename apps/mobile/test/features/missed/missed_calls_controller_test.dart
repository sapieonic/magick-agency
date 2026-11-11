import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/features/missed/missed_access.dart';
import 'package:magick_agency_agent/features/missed/missed_calls_controller.dart';

import '../../core/auth/support/harness.dart' show testSignalsProvider;
import 'support.dart';

/// The Missed list's controller: paging, filters, refresh, and Mark handled /
/// Reopen moving the row and the badge.
void main() {
  late FakeMissedCallsApi api;
  late TestClock clock;
  late ProviderContainer c;

  MissedCallsController ctl() => c.read(missedCallsControllerProvider.notifier);
  MissedCallsState st() => c.read(missedCallsControllerProvider);

  setUp(() {
    api = FakeMissedCallsApi();
    clock = TestClock();
    c = ProviderContainer.test(overrides: [
      ...missedOverrides(api, clock: clock),
      stationSignalsProvider.overrideWith((ref) => ref.watch(testSignalsProvider)),
    ]);
    c.listen(missedCallsControllerProvider, (_, _) {});
    c.listen(missedCallsAccessProvider, (_, _) {});
  });

  Future<void> settle() => pumpEventQueue();

  Future<void> loadFirst(List<InboundMissedCall> rows, {String? next}) async {
    final f = ctl().ensureLoaded();
    api.answer(api.queries.length - 1, missedPage(rows, next: next));
    await f;
  }

  group('paging', () {
    test('the first page asks for the agent’s own open rows (assignee=me, so a supervisor’s too), 50 at a time',
        () async {
      await loadFirst([missed('m1'), missed('m2')], next: 'cur-2');
      expect(api.queries.single.toQuery(), {'status': 'open', 'assignee': 'me', 'limit': '50'});
      expect(st().status, MissedListStatus.ready);
      expect(st().rows.map((r) => r.id), ['m1', 'm2']);
      expect(st().hasMore, isTrue);
    });

    test('more appends the next page with the cursor, once, and stops at the last', () async {
      await loadFirst([missed('m1')], next: 'cur-2');
      final more = ctl().loadMore();
      await ctl().loadMore(); // in flight: nothing more
      expect(api.queries, hasLength(2));
      expect(api.queries.last.toQuery()['cursor'], 'cur-2');
      api.answer(1, missedPage([missed('m2')]));
      await more;
      expect(st().rows.map((r) => r.id), ['m1', 'm2']);
      expect(st().hasMore, isFalse);
      await ctl().loadMore();
      expect(api.queries, hasLength(2));
    });

    test('a failed more keeps the rows and is retried by hand', () async {
      await loadFirst([missed('m1')], next: 'cur-2');
      final more = ctl().loadMore();
      api.fail(1);
      await more;
      expect(st().moreError, isNotNull);
      expect(st().rows, hasLength(1));
      await ctl().loadMore();
      expect(api.queries, hasLength(2), reason: 'not retried on its own');
      final retry = ctl().retryMore();
      api.answer(2, missedPage([missed('m2')]));
      await retry;
      expect(st().rows, hasLength(2));
    });

    test('a page for a filter no longer on screen is dropped', () async {
      await loadFirst([missed('m1')], next: 'cur-2');
      final more = ctl().loadMore();
      final handled = ctl().applyFilters(const MissedFilters(status: InboundFollowUpStatus.handled));
      api.answer(2, missedPage([handledCopy(missed('h1'))]));
      await handled;
      api.answer(1, missedPage([missed('stale')]));
      await more;
      expect(st().rows.map((r) => r.id), ['h1']);
      expect(api.queries[2].toQuery(), {'status': 'handled', 'assignee': 'me', 'limit': '50'});
    });

    test('the reason filter goes on the query, from the first page', () async {
      await loadFirst([missed('m1')], next: 'cur-2');
      final f = ctl().applyFilters(const MissedFilters(reason: InboundMissedReason.abandonedInQueue));
      expect(st().status, MissedListStatus.loading);
      api.answer(1, missedPage([]));
      await f;
      expect(api.queries[1].toQuery(), {'status': 'open', 'assignee': 'me', 'reason': 'abandoned_in_queue', 'limit': '50'});
      expect(api.queries[1].withCursor('cur-3').toQuery()['assignee'], 'me', reason: 'the next pages too');
    });

    test('a failed first page says why, and the retry reads it again', () async {
      final f = ctl().ensureLoaded();
      api.fail(0);
      await f;
      expect(st().status, MissedListStatus.error);
      expect(st().error, const ApiNetworkError('offline').userMessage);
      final again = ctl().ensureLoaded();
      api.answer(1, missedPage([missed('m1')]));
      await again;
      expect(st().status, MissedListStatus.ready);
    });
  });

  group('refresh', () {
    test('pull to refresh keeps the rows until the new page lands, and re-reads the badge', () async {
      await settle();
      final reads = api.countReads;
      await loadFirst([missed('m1')]);
      final r = ctl().reload(keepRows: true);
      expect(st().refreshing, isTrue);
      expect(st().rows, hasLength(1));
      api.answer(1, missedPage([missed('m0'), missed('m1')]));
      await r;
      expect(st().rows.map((r) => r.id), ['m0', 'm1']);
      expect(st().refreshing, isFalse);
      expect(api.countReads, reads + 1);
    });

    test('entering the segment again within a minute reads nothing; after a minute, the rows and the count again',
        () async {
      await settle();
      await loadFirst([missed('m1')]);
      final reads = api.countReads;

      clock.now = clock.now.add(const Duration(seconds: 59));
      await ctl().entered();
      expect(api.queries, hasLength(1));
      expect(api.countReads, reads);

      clock.now = clock.now.add(const Duration(seconds: 1));
      final f = ctl().entered();
      expect(st().refreshing, isTrue, reason: 'the rows stay until the new page lands');
      expect(api.queries, hasLength(2));
      api.answer(1, missedPage([missed('m0'), missed('m1')]));
      await f;
      expect(st().rows.map((r) => r.id), ['m0', 'm1']);
      expect(api.countReads, reads + 1);

      await ctl().entered();
      expect(api.queries, hasLength(2), reason: 'just read');
    });

    test('a call settling on this phone makes the next entry read the rows again, however soon', () async {
      await loadFirst([missed('m1')]);
      final signals = c.read(testSignalsProvider.notifier);
      signals.set(const StationSignals(onDuty: true, callActive: true, campaignId: 'c1'));
      await ctl().entered();
      expect(api.queries, hasLength(1), reason: 'a call on the line is not a settled one');
      signals.set(const StationSignals(onDuty: true, outcomeOwed: true, campaignId: 'c1', onBreak: true));
      await settle();
      signals.set(const StationSignals(onDuty: true, campaignId: 'c1', onBreak: true));
      await settle();
      final f = ctl().entered();
      expect(api.queries, hasLength(2));
      api.answer(1, missedPage([]));
      await f;
      expect(st().rows, isEmpty, reason: 'the row the call back closed as reached is gone');
    });

    test('the first entry reads the first page; a failed one is read again on the next', () async {
      final f = ctl().entered();
      api.fail(0);
      await f;
      final again = ctl().entered();
      api.answer(1, missedPage([missed('m1')]));
      await again;
      expect(st().status, MissedListStatus.ready);
    });

    test('a workspace change drops the rows', () async {
      await loadFirst([missed('m1')]);
      c.read(testWorkspaceProvider.notifier).set('u2:t1:a1');
      expect(st().rows, isEmpty);
      expect(st().status, MissedListStatus.loading);
    });
  });

  group('Mark handled and Reopen', () {
    test('Mark handled takes the row off To follow up and re-reads the badge', () async {
      await settle();
      await loadFirst([missed('m1'), missed('m2')]);
      final reads = api.countReads;
      api.countAnswer = countOf(1);
      final result = await ctl().markHandled(st().rows.first);
      await settle();
      expect(result.ok, isTrue);
      expect(result.message, 'Marked the call from +91 87654 32109 as handled.');
      expect(api.handled, ['m1']);
      expect(st().rows.map((r) => r.id), ['m2']);
      expect(st().marking, isNull);
      expect(api.countReads, reads + 1);
      expect(c.read(missedCallsAccessProvider).badge, '1');
    });

    test('on the Handled tab, Reopen takes the row off it', () async {
      final f = ctl().applyFilters(const MissedFilters(status: InboundFollowUpStatus.handled));
      api.answer(0, missedPage([handledCopy(missed('h1')), handledCopy(missed('h2'))]));
      await f;
      final reopened = await ctl().reopen(st().rows.first);
      expect(reopened.ok, isTrue);
      expect(api.reopened, ['h1']);
      expect(st().rows.map((r) => r.id), ['h2']);
    });

    test('Reopen on a list that shows open rows replaces the row with the server’s copy', () async {
      // An open-tab list holding a row the server says is handled (stale): Reopen answers it open.
      await loadFirst([handledCopy(missed('m1'))]);
      await ctl().reopen(st().rows.single);
      expect(st().rows.single.isOpen, isTrue);
    });

    test('a refusal is said on the row, the row stays, and the badge is not re-read', () async {
      await settle();
      await loadFirst([missed('m1')]);
      final reads = api.countReads;
      api.handledAnswer = inboundRefusal('inbound_missed_call_not_found');
      final result = await ctl().markHandled(st().rows.single);
      expect(result.ok, isFalse);
      expect(st().rowError, (id: 'm1', message: 'This missed call isn’t yours to handle, or it no longer exists.'));
      expect(st().rows, hasLength(1));
      expect(st().marking, isNull);
      expect(api.countReads, reads);
    });

    test('a reload while a Mark handled is in flight keeps it the only one, and its end clears it', () async {
      await loadFirst([missed('m1'), missed('m2')]);
      final answer = Completer<InboundMissedCall>();
      api.handledAnswer = answer.future;
      final first = ctl().markHandled(st().rows.first);
      final r = ctl().reload();
      api.answer(1, missedPage([missed('m1'), missed('m2')]));
      await r;
      expect(st().marking, 'm1', reason: 'the reload did not forget it');
      final second = await ctl().markHandled(st().rows.last);
      expect(second.ok, isFalse);
      expect(api.handled, ['m1']);
      answer.complete(handledCopy(missed('m1')));
      await first;
      expect(st().marking, isNull);
    });

    test('a Reopen from before a reload is still the only one', () async {
      final shown = ctl().applyFilters(const MissedFilters(status: InboundFollowUpStatus.handled));
      api.answer(0, missedPage([handledCopy(missed('h1')), handledCopy(missed('h2'))]));
      await shown;
      final answer = Completer<InboundMissedCall>();
      api.reopenAnswer = answer.future;
      final first = ctl().reopen(st().rows.first);
      final r = ctl().reload(keepRows: true);
      api.answer(1, missedPage([handledCopy(missed('h1')), handledCopy(missed('h2'))]));
      await r;
      expect(st().reopening, 'h1');
      expect((await ctl().reopen(st().rows.last)).ok, isFalse);
      answer.complete(missed('h1'));
      await first;
      expect(st().reopening, isNull);
    });

    test('a Mark handled from another workspace never clears this one’s', () async {
      await loadFirst([missed('m1')]);
      final old = Completer<InboundMissedCall>();
      api.handledAnswer = old.future;
      final first = ctl().markHandled(st().rows.single);
      c.read(testWorkspaceProvider.notifier).set('u1:t1:a2');
      await loadFirst([missed('n1')]);
      final mine = Completer<InboundMissedCall>();
      api.handledAnswer = mine.future;
      final second = ctl().markHandled(st().rows.single);
      expect(st().marking, 'n1');
      old.complete(handledCopy(missed('m1')));
      await first;
      expect(st().marking, 'n1', reason: 'the other workspace’s answer is not this one’s');
      expect(st().rows.map((r) => r.id), ['n1']);
      mine.complete(handledCopy(missed('n1')));
      await second;
      expect(st().marking, isNull);
    });

    test('one Mark handled at a time', () async {
      await loadFirst([missed('m1'), missed('m2')]);
      final first = ctl().markHandled(st().rows.first);
      final second = await ctl().markHandled(st().rows.last);
      expect(second.ok, isFalse);
      await first;
      expect(api.handled, ['m1']);
    });
  });

  group('the Team view and Claim (IQ49)', () {
    Future<void> toTeam(List<InboundMissedCall> rows) async {
      await loadFirst([missed('mine-1')]);
      final f = ctl().applyFilters(st().filters.withScope(MissedScope.team));
      api.answer(api.queries.length - 1, missedPage(rows));
      await f;
    }

    test('Team asks for the account\'s unassigned open rows, whatever the status tab was', () async {
      await loadFirst([missed('mine-1')]);
      final handled = ctl().applyFilters(st().filters.withStatus(InboundFollowUpStatus.handled));
      api.answer(1, missedPage([]));
      await handled;
      final team = ctl().applyFilters(st().filters.withScope(MissedScope.team));
      api.answer(2, missedPage([missed('t1', {'assignee_user_id': null})]));
      await team;
      expect(api.queries.last.toQuery(), {'status': 'open', 'assignee': 'unassigned', 'limit': '50'});
      expect(st().rows.single.id, 't1');
      // Back to Mine: its own tab again.
      final mine = ctl().applyFilters(st().filters.withScope(MissedScope.mine));
      api.answer(3, missedPage([]));
      await mine;
      expect(api.queries.last.toQuery(), {'status': 'handled', 'assignee': 'me', 'limit': '50'});
    });

    test('a claimed row leaves Team (it is on Mine now), and the badge is re-read', () async {
      await toTeam([missed('t1', {'assignee_user_id': null}), missed('t2', {'assignee_user_id': null})]);
      final before = api.countReads;
      api.claimAnswer = missed('t1', {'assignee_user_id': 'u1'});
      final result = await ctl().claim(st().rows.first);
      await settle();
      expect(result.ok, isTrue);
      expect(result.message, 'The call from +91 87654 32109 is yours now. It’s on your list to follow up.');
      expect(api.claimed, ['t1']);
      expect(st().rows.map((r) => r.id), ['t2']);
      expect(st().claiming, isNull);
      expect(api.countReads, before + 1);
      // Mine reads it from the server.
      final mine = ctl().applyFilters(st().filters.withScope(MissedScope.mine));
      api.answer(api.queries.length - 1, missedPage([missed('t1'), missed('mine-1')]));
      await mine;
      expect(st().rows.map((r) => r.id), ['t1', 'mine-1']);
    });

    for (final (code, status, words) in [
      ('inbound_missed_call_claimed', 409, 'Someone else has already taken this missed call.'),
      ('inbound_missed_call_handled', 409, 'This missed call has already been handled.'),
      ('inbound_missed_call_not_found', 404, 'This missed call is no longer here. Refresh the list.'),
    ]) {
      test('$code: said on the row, its Claim off until the next read drops it', () async {
        await toTeam([missed('t1', {'assignee_user_id': null})]);
        final before = api.countReads;
        api.claimAnswer = inboundRefusal(code, status: status);
        final result = await ctl().claim(st().rows.single);
        expect(result.ok, isFalse);
        expect(st().rowError, (id: 't1', message: words));
        expect(st().taken, {'t1'});
        expect(st().claiming, isNull);
        expect(api.countReads, before, reason: 'nothing of the agent\'s changed');
        final reload = ctl().reload();
        api.answer(api.queries.length - 1, missedPage([]));
        await reload;
        expect(st().rows, isEmpty);
        expect(st().taken, isEmpty);
      });
    }

    test('no answer: said on the row, and Claim stays on to try again', () async {
      await toTeam([missed('t1', {'assignee_user_id': null})]);
      api.claimAnswer = const ApiNetworkError('offline');
      await ctl().claim(st().rows.single);
      expect(st().rowError?.id, 't1');
      expect(st().taken, isEmpty);
    });

    test('one Claim at a time', () async {
      await toTeam([missed('t1', {'assignee_user_id': null}), missed('t2', {'assignee_user_id': null})]);
      final gate = Completer<InboundMissedCall>();
      api.claimAnswer = gate.future;
      final first = ctl().claim(st().rows.first);
      final second = await ctl().claim(st().rows.last);
      expect(second.ok, isFalse);
      expect(api.claimed, ['t1']);
      expect(st().claiming, 't1');
      gate.complete(missed('t1'));
      await first;
      expect(st().claiming, isNull);
    });
  });
}
