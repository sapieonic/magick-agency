import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/features/calls/softphone/softphone_calls_controller.dart';

import 'softphone_support.dart';

void main() {
  late FakeSoftphoneCallsApi api;
  late ProviderContainer container;

  SoftphoneCallsController controller() => container.read(softphoneCallsControllerProvider.notifier);
  SoftphoneCallsState state() => container.read(softphoneCallsControllerProvider);

  setUp(() {
    api = FakeSoftphoneCallsApi();
    container = ProviderContainer(overrides: softphoneCallsOverrides(api));
    addTearDown(container.dispose);
  });

  Future<void> firstPage({String? next = 'cur-1'}) async {
    final f = controller().ensureLoaded();
    api.answer(api.pending.length - 1, softPage(List.generate(50, (i) => i), next: next));
    await f;
  }

  test('the first page: the agent\'s own, 50 at a time, no cursor', () async {
    final f = controller().ensureLoaded();
    expect(state().status, SoftphoneCallsStatus.loading);
    expect(api.q(0), {'agent_user_id': 'u1', 'limit': '50'});
    api.answer(0, softPage([1, 2, 3], next: 'cur-1'));
    await f;
    expect(state().status, SoftphoneCallsStatus.ready);
    expect(state().rows.map((r) => r.id), ['mc-1', 'mc-2', 'mc-3']);
    expect(state().hasMore, isTrue);

    await controller().ensureLoaded(); // already on screen
    expect(api.queries, hasLength(1));
  });

  test('more pages append with the cursor; one request in flight at a time', () async {
    await firstPage();
    final more = controller().loadMore();
    unawaited(controller().loadMore());
    expect(api.queries, hasLength(2));
    expect(api.q(1)['cursor'], 'cur-1');
    api.answer(1, softPage([50, 51]));
    await more;
    expect(state().rows, hasLength(52));
    expect(state().hasMore, isFalse);
    await controller().loadMore(); // the last page: nothing to ask for
    expect(api.queries, hasLength(2));
  });

  test('a filter change resets the cursor and the rows', () async {
    await firstPage();
    final applied = controller().applyFilters(
      const SoftphoneCallFilters(phoneDigits: '61733', status: ManualCallListStatus.awaitingOutcome),
    );
    expect(state().status, SoftphoneCallsStatus.loading);
    expect(state().rows, isEmpty);
    expect(state().nextCursor, isNull);
    expect(api.q(1).containsKey('cursor'), isFalse);
    expect(api.q(1)['phone'], '61733');
    expect(api.q(1)['status'], 'awaiting_outcome');
    api.answer(1, softPage([7]));
    await applied;
    expect(state().rows.map((r) => r.id), ['mc-7']);
    expect(state().hasMore, isFalse); // the old cursor is gone with the old query
  });

  test('a "more" page of the old query is dropped after a filter change (generation)', () async {
    await firstPage();
    final more = controller().loadMore();
    final applied = controller().applyFilters(const SoftphoneCallFilters(phoneDigits: '98204'));
    api.answer(2, softPage([9]));
    await applied;
    api.answer(1, softPage([100, 101], next: 'cur-2')); // lands late
    await more;
    expect(state().rows.map((r) => r.id), ['mc-9']);
    expect(state().filters.phoneDigits, '98204');
    expect(state().hasMore, isFalse);
  });

  test('a first page answering an older filter is dropped when it lands after the newer one', () async {
    await firstPage();
    final older = controller().applyFilters(const SoftphoneCallFilters(status: ManualCallListStatus.live));
    final newer = controller().applyFilters(const SoftphoneCallFilters(status: ManualCallListStatus.settled));
    api.answer(2, softPage([2]));
    await newer;
    api.answer(1, softPage([1, 3, 5]));
    await older;
    expect(state().rows.map((r) => r.id), ['mc-2']);
    expect(state().filters.status, ManualCallListStatus.settled);
  });

  test('applying the same filters again is not a new request', () async {
    await firstPage();
    await controller().applyFilters(SoftphoneCallFilters.initial);
    expect(api.queries, hasLength(1));
  });

  test('agent_user_id is always the signed-in agent: first page, more, filters, and after a switch', () async {
    await firstPage();
    final more = controller().loadMore();
    api.answer(1, softPage([]));
    await more;
    final applied = controller().applyFilters(const SoftphoneCallFilters(phoneDigits: '1'));
    api.answer(2, softPage([]));
    await applied;
    final refresh = controller().reload(keepRows: true);
    api.answer(3, softPage([]));
    await refresh;
    expect([for (var i = 0; i < api.queries.length; i++) api.q(i)['agent_user_id']], everyElement('u1'));

    container.read(testWorkspaceProvider.notifier).set('u2:t1:a1');
    final f = controller().ensureLoaded();
    expect(api.q(4)['agent_user_id'], 'u2');
    api.answer(4, softPage([]));
    await f;
  });

  test('keyed per workspace: a switch drops the rows and filters at once, and a late page for the old one', () async {
    await firstPage();
    final applied = controller().applyFilters(const SoftphoneCallFilters(status: ManualCallListStatus.settled));
    api.answer(1, softPage([1]));
    await applied;
    final late = controller().reload(keepRows: true); // in flight for the first workspace
    container.read(testWorkspaceProvider.notifier).set('u1:t1:a2');
    expect(state().rows, isEmpty);
    expect(state().status, SoftphoneCallsStatus.loading);
    expect(state().filters, SoftphoneCallFilters.initial);
    api.answer(2, softPage([7, 8]));
    await late;
    expect(state().rows, isEmpty);

    final f = controller().ensureLoaded();
    expect(api.queries, hasLength(4));
    expect(api.q(3).containsKey('status'), isFalse);
    api.answer(3, softPage([42]));
    await f;
    expect(state().rows.map((r) => r.id), ['mc-42']);
  });

  test('signed out: the rows go and nothing is read', () async {
    await firstPage();
    container.read(testWorkspaceProvider.notifier).set(null);
    expect(state().rows, isEmpty);
    await controller().ensureLoaded();
    await controller().applyFilters(const SoftphoneCallFilters(phoneDigits: '9'));
    expect(api.queries, hasLength(1));
  });

  test('a failed "more" keeps the rows, stops the prefetch, and retries on request', () async {
    await firstPage();
    final more = controller().loadMore();
    api.fail(1);
    await more;
    expect(state().rows, hasLength(50));
    expect(state().moreError, isNotNull);
    await controller().loadMore();
    expect(api.queries, hasLength(2));
    final retry = controller().retryMore();
    expect(api.q(2)['cursor'], 'cur-1');
    api.answer(2, softPage([50]));
    await retry;
    expect(state().rows, hasLength(51));
    expect(state().moreError, isNull);
  });

  test('a failed first page is an error; reload recovers; a 401 goes to the gate', () async {
    final f = controller().ensureLoaded();
    api.fail(0, const ApiUnauthorized());
    await f;
    await Future<void>.delayed(Duration.zero);
    expect(state().status, SoftphoneCallsStatus.error);
    expect((container.read(appGateProvider.notifier) as RecordingGate).reported, [isA<ApiUnauthorized>()]);
    final again = controller().reload();
    api.answer(1, softPage([1]));
    await again;
    expect(state().status, SoftphoneCallsStatus.ready);
  });

  group('the number filter', () {
    test('digits only; nothing left is no filter', () {
      expect(SoftphoneCallFilters.digitsOf('+91 98204-61733'), '919820461733');
      expect(SoftphoneCallFilters.digitsOf(' 61733 '), '61733');
      expect(SoftphoneCallFilters.digitsOf('abc'), isNull);
      expect(SoftphoneCallFilters.digitsOf(''), isNull);
    });

    test('what counts as filtered', () {
      expect(SoftphoneCallFilters.initial.isFiltered, isFalse);
      const both = SoftphoneCallFilters(phoneDigits: '1', status: ManualCallListStatus.live);
      expect(both.groupCount, 2);
      expect(both.copyWith(clearPhone: true), const SoftphoneCallFilters(status: ManualCallListStatus.live));
    });
  });

  group('the segment (decision 5)', () {
    ProviderContainer withPhoneTab(bool visible) {
      final c = ProviderContainer(overrides: softphoneCallsOverrides(api, visible: visible));
      addTearDown(c.dispose);
      return c;
    }

    Future<bool> visibleIn(ProviderContainer c) async {
      final sub = c.listen(softphoneCallsVisibleProvider, (_, _) {});
      addTearDown(sub.close);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      return c.read(softphoneCallsVisibleProvider);
    }

    test('shown where the Phone tab shows, without a probe', () async {
      expect(await visibleIn(withPhoneTab(true)), isTrue);
      expect(api.probes, isEmpty);
    });

    test('hidden when the Phone tab is hidden and the agent has no soft-phone calls', () async {
      expect(await visibleIn(withPhoneTab(false)), isFalse);
      expect(api.probes.single.toQuery(), {'agent_user_id': 'u1', 'limit': '1'});
    });

    test('shown when the probe finds one of the agent\'s own calls', () async {
      api.probeRows = {'u1': [softRow(1)]};
      expect(await visibleIn(withPhoneTab(false)), isTrue);
    });

    test('a refused or failed probe is hidden', () async {
      api.probeError = const ApiNetworkError('offline');
      expect(await visibleIn(withPhoneTab(false)), isFalse);
    });

    test('per workspace: another agent on the same phone starts hidden until their own probe answers', () async {
      api.probeRows = {'u1': [softRow(1)]};
      final c = withPhoneTab(false);
      expect(await visibleIn(c), isTrue);
      c.read(testWorkspaceProvider.notifier).set('u2:t1:a1');
      expect(c.read(softphoneCallsVisibleProvider), isFalse);
      await Future<void>.delayed(Duration.zero);
      expect(c.read(softphoneCallsVisibleProvider), isFalse);
      expect(api.probes.last.agentUserId, 'u2');
    });
  });
}
