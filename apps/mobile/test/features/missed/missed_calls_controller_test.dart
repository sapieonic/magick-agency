import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/features/missed/missed_access.dart';
import 'package:magick_agency_agent/features/missed/missed_calls_controller.dart';

import 'support.dart';

/// The Missed list's controller: paging, filters, refresh, and Mark handled /
/// Reopen moving the row and the badge.
void main() {
  late FakeMissedCallsApi api;
  late ProviderContainer c;

  MissedCallsController ctl() => c.read(missedCallsControllerProvider.notifier);
  MissedCallsState st() => c.read(missedCallsControllerProvider);

  setUp(() {
    api = FakeMissedCallsApi();
    c = ProviderContainer.test(overrides: missedOverrides(api));
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
    test('the first page asks for the open rows, 50 at a time, and names no assignee', () async {
      await loadFirst([missed('m1'), missed('m2')], next: 'cur-2');
      expect(api.queries.single.toQuery(), {'status': 'open', 'limit': '50'});
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
      expect(api.queries[2].toQuery(), {'status': 'handled', 'limit': '50'});
    });

    test('the reason filter goes on the query, from the first page', () async {
      await loadFirst([missed('m1')], next: 'cur-2');
      final f = ctl().applyFilters(const MissedFilters(reason: InboundMissedReason.abandonedInQueue));
      expect(st().status, MissedListStatus.loading);
      api.answer(1, missedPage([]));
      await f;
      expect(api.queries[1].toQuery(), {'status': 'open', 'reason': 'abandoned_in_queue', 'limit': '50'});
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

    test('one Mark handled at a time', () async {
      await loadFirst([missed('m1'), missed('m2')]);
      final first = ctl().markHandled(st().rows.first);
      final second = await ctl().markHandled(st().rows.last);
      expect(second.ok, isFalse);
      await first;
      expect(api.handled, ['m1']);
    });
  });
}
