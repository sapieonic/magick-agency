import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/calls/calls_controller.dart';
import 'package:magick_agency_agent/features/calls/logic/attempt_filters.dart';

import 'support.dart';

void main() {
  late FakeAttemptsApi api;
  late ProviderContainer container;

  AttemptsController controller() => container.read(attemptsControllerProvider.notifier);
  AttemptsState state() => container.read(attemptsControllerProvider);

  setUp(() {
    api = FakeAttemptsApi();
    container = ProviderContainer(overrides: callsOverrides(api, FakePerformanceApi()));
    addTearDown(container.dispose);
  });

  Future<void> firstPage({String? next = 'cur-1'}) async {
    final f = controller().ensureLoaded();
    api.answer(api.pending.length - 1, page(List.generate(50, (i) => i), next: next));
    await f;
  }

  test('the first page: today, 50 at a time, no cursor', () async {
    final f = controller().ensureLoaded();
    expect(state().status, AttemptsStatus.loading);
    expect(api.q(0)['limit'], '50');
    expect(api.q(0).containsKey('cursor'), isFalse);
    expect(api.q(0)['from'], '2026-10-13T18:30:00.000Z');
    api.answer(0, page([1, 2, 3], next: 'cur-1'));
    await f;
    expect(state().status, AttemptsStatus.ready);
    expect(state().rows.map((r) => r.id), ['a1', 'a2', 'a3']);
    expect(state().hasMore, isTrue);
  });

  test('ensureLoaded does not re-read a page already on screen', () async {
    await firstPage();
    await controller().ensureLoaded();
    expect(api.queries, hasLength(1));
  });

  test('more pages append with the cursor; one request in flight at a time', () async {
    await firstPage();
    final more = controller().loadMore();
    unawaited(controller().loadMore()); // the list asks again as rows build
    unawaited(controller().loadMore());
    expect(api.queries, hasLength(2));
    expect(api.q(1)['cursor'], 'cur-1');
    expect(state().loadingMore, isTrue);
    api.answer(1, page([50, 51], next: null));
    await more;
    expect(state().rows, hasLength(52));
    expect(state().rows.last.id, 'a51');
    expect(state().hasMore, isFalse);
    expect(state().loadingMore, isFalse);

    await controller().loadMore(); // last page: nothing to ask for
    expect(api.queries, hasLength(2));
  });

  test('a filter change resets the cursor and the rows', () async {
    await firstPage();
    final applied = controller().applyFilters(AttemptFilters.initial.copyWith(outcomes: {AttemptOutcome.connected}));
    expect(state().status, AttemptsStatus.loading);
    expect(state().rows, isEmpty);
    expect(api.q(1).containsKey('cursor'), isFalse);
    expect(api.q(1)['outcome'], 'connected');
    api.answer(1, page([7]));
    await applied;
    expect(state().rows.map((r) => r.id), ['a7']);
    expect(state().filters.outcomes, {AttemptOutcome.connected});
  });

  test('a "more" page from the old query is thrown away after a filter change', () async {
    await firstPage();
    final more = controller().loadMore();
    final applied = controller().applyFilters(const AttemptFilters(phone: '98400'));
    api.answer(2, page([9]));
    await applied;
    api.answer(1, page([100, 101], next: 'cur-2')); // lands late
    await more;
    expect(state().rows.map((r) => r.id), ['a9']);
    expect(state().filters.phone, '98400');
    expect(state().hasMore, isFalse);
  });

  test('applying the same filters again is not a new request', () async {
    await firstPage();
    await controller().applyFilters(AttemptFilters.initial);
    expect(api.queries, hasLength(1));
  });

  test('a failed "more" keeps the rows, stops the prefetch, and retries on request', () async {
    await firstPage();
    final more = controller().loadMore();
    api.fail(1);
    await more;
    expect(state().rows, hasLength(50));
    expect(state().moreError, contains('offline'));
    await controller().loadMore(); // not retried behind the agent's back
    expect(api.queries, hasLength(2));

    final retry = controller().retryMore();
    expect(api.q(2)['cursor'], 'cur-1');
    api.answer(2, page([50]));
    await retry;
    expect(state().rows, hasLength(51));
    expect(state().moreError, isNull);
  });

  test('a failed first page is an error state; reload recovers', () async {
    final f = controller().ensureLoaded();
    api.fail(0);
    await f;
    expect(state().status, AttemptsStatus.error);
    expect(state().error, contains('offline'));
    final again = controller().reload();
    api.answer(1, page([1]));
    await again;
    expect(state().status, AttemptsStatus.ready);
  });

  test('pull-to-refresh keeps the rows on screen, and on failure keeps them', () async {
    await firstPage();
    final refresh = controller().reload(keepRows: true);
    expect(state().refreshing, isTrue);
    expect(state().rows, hasLength(50));
    api.fail(1);
    await refresh;
    expect(state().status, AttemptsStatus.ready);
    expect(state().rows, hasLength(50));
    expect(state().error, isNotNull);
    expect(state().refreshing, isFalse);

    final ok = controller().reload(keepRows: true);
    api.answer(2, page([1, 2]));
    await ok;
    expect(state().rows, hasLength(2));
    expect(state().error, isNull);
  });

  test('a workspace switch starts again from the default filters', () async {
    await firstPage();
    final applied = controller().applyFilters(const AttemptFilters(campaignId: 'c1'));
    api.answer(1, page([1]));
    await applied;
    container.read(testWorkspaceProvider.notifier).set('u1:t2:a2');
    final f = controller().ensureLoaded();
    expect(state().filters, AttemptFilters.initial);
    expect(api.q(2).containsKey('campaign_id'), isFalse);
    api.answer(2, page([]));
    await f;
  });

  test('another agent signs in on the same account: the old rows go at once, and a late page for them is dropped', () async {
    await firstPage();
    expect(state().rows, hasLength(50));
    final late = controller().reload(keepRows: true); // in flight for the first agent
    container.read(testWorkspaceProvider.notifier).set('u2:t1:a1');
    // Nothing of the first agent's is left to paint, before any new read.
    expect(state().rows, isEmpty);
    expect(state().status, AttemptsStatus.loading);
    api.answer(1, page([7, 8, 9]));
    await late;
    expect(state().rows, isEmpty);

    final f = controller().ensureLoaded();
    expect(api.queries, hasLength(3));
    api.answer(2, page([42]));
    await f;
    expect(state().rows.map((r) => r.id), ['a42']);
  });

  test('signed out: the rows are dropped and nothing is read', () async {
    await firstPage();
    container.read(testWorkspaceProvider.notifier).set(null);
    expect(state().rows, isEmpty);
    await controller().ensureLoaded();
    await controller().applyFilters(const AttemptFilters(campaignId: 'c1'));
    expect(api.queries, hasLength(1));
  });
}
