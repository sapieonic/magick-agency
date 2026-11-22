import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/calls/my_calls_controller.dart';
import 'package:magick_agency_agent/features/calls/my_calls_copy.dart';

import 'support.dart';

/// My calls' controller (docs/call-log.md §7): the chip, the pages, the
/// follow-ups. A page that belongs to a list no longer on screen is dropped.
void main() {
  late FakeMyCallsApi api;
  late FakeMissedCallsApi missed;
  late ProviderContainer container;

  MyCallsController controller() => container.read(myCallsControllerProvider.notifier);
  MyCallsState state() => container.read(myCallsControllerProvider);

  setUp(() {
    api = FakeMyCallsApi();
    missed = FakeMissedCallsApi();
    container = ProviderContainer(overrides: myCallsOverrides(api, missed));
    addTearDown(container.dispose);
  });

  test('opens on All: the first page, with what the agent still owes', () async {
    final loading = controller().ensureLoaded();
    expect(state().status, MyCallsStatus.loading);
    expect(api.q(0), {'limit': '50', 'include_counts': '1'});
    api.answer(0, myCallsPage([myCall('a1'), myCall('a2')], next: 'c1', counts: const MyCallsCounts(toFollowUp: 3, missedOpen: 2, callbacksDue: 1)));
    await loading;
    expect(state().status, MyCallsStatus.ready);
    expect(state().rows.map((r) => r.id), ['a1', 'a2']);
    expect(state().counts!.toFollowUp, 3);
    expect(state().hasMore, isTrue);
    // Asking again does not read again.
    await controller().ensureLoaded();
    expect(api.queries, hasLength(1));
  });

  test('a chip restarts from the first page of that type and keeps the badge while it loads', () async {
    final first = controller().ensureLoaded();
    api.answer(0, myCallsPage([myCall('a1')], next: 'c1', counts: const MyCallsCounts(toFollowUp: 2, missedOpen: 2, callbacksDue: 0)));
    await first;
    final chosen = controller().choose(MyCallsTypeFilter.toFollowUp);
    expect(state().type, MyCallsTypeFilter.toFollowUp);
    expect(state().rows, isEmpty);
    expect(state().counts!.toFollowUp, 2, reason: 'the badge does not blink away');
    expect(api.q(1), {'type': 'to_follow_up', 'limit': '50', 'include_counts': '1'});
    api.answer(1, myCallsPage([missedRow('m1')], callbacks: [callbackDue('k1', fixedNow)]));
    await chosen;
    expect(state().rows.single.id, 'm1');
    expect(state().callbacks.single.contactId, 'k1');
    // The chip already on is not read again.
    await controller().choose(MyCallsTypeFilter.toFollowUp);
    expect(api.queries, hasLength(2));
  });

  test('drops a page that a newer chip overtook', () async {
    final first = controller().ensureLoaded();
    final second = controller().choose(MyCallsTypeFilter.dialler);
    api.answer(1, myCallsPage([myCall('d1')]));
    await second;
    api.answer(0, myCallsPage([myCall('old')]));
    await first;
    expect(state().type, MyCallsTypeFilter.dialler);
    expect(state().rows.single.id, 'd1');
  });

  test('more: follows the cursor and appends; a failure keeps the rows and can be retried', () async {
    final first = controller().ensureLoaded();
    api.answer(0, myCallsPage([myCall('a1')], next: 'c1'));
    await first;
    final more = controller().loadMore();
    expect(api.q(1), {'cursor': 'c1', 'limit': '50'});
    api.fail(1);
    await more;
    expect(state().rows.single.id, 'a1');
    expect(state().moreError, isNotNull);
    // Nothing is asked again until the agent retries.
    await controller().loadMore();
    expect(api.queries, hasLength(2));
    final retry = controller().retryMore();
    api.answer(2, myCallsPage([myCall('a2')], counts: null));
    await retry;
    expect(state().rows.map((r) => r.id), ['a1', 'a2']);
    expect(state().hasMore, isFalse);
  });

  test('a failed first page is an error; a failed refresh keeps the rows', () async {
    final first = controller().ensureLoaded();
    api.fail(0);
    await first;
    expect(state().status, MyCallsStatus.error);
    expect(state().error, isNotNull);
    final again = controller().reload();
    api.answer(1, myCallsPage([myCall('a1')]));
    await again;
    final refresh = controller().reload(keepRows: true);
    expect(state().refreshing, isTrue);
    api.fail(2);
    await refresh;
    expect(state().rows.single.id, 'a1');
    expect(state().error, isNotNull);
    expect(state().status, MyCallsStatus.ready);
  });

  test('a new workspace drops the rows and the chip', () async {
    final first = controller().ensureLoaded();
    api.answer(0, myCallsPage([myCall('a1')]));
    await first;
    await controller().choose(MyCallsTypeFilter.dialler).timeout(Duration.zero, onTimeout: () {});
    container.read(testWorkspaceProvider.notifier).set('u2:t1:a1');
    expect(state().rows, isEmpty);
    expect(state().type, MyCallsTypeFilter.all);
    expect(state().counts, isNull);
  });

  test('signed out, nothing is read', () async {
    container.read(testWorkspaceProvider.notifier).set(null);
    await controller().ensureLoaded();
    expect(api.queries, isEmpty);
  });

  test('Mark handled is the Missed list\'s action: the list and the badge are read again', () async {
    final first = controller().choose(MyCallsTypeFilter.toFollowUp);
    api.answer(0, myCallsPage([missedRow('m1'), missedRow('m2')]));
    await first;
    api.auto = (_) => myCallsPage([missedRow('m2')], counts: const MyCallsCounts(toFollowUp: 1, missedOpen: 1, callbacksDue: 0));
    final counted = missed.countReads;
    expect(await controller().markHandled(state().rows.first), isTrue);
    await pumpEventQueue();
    expect(missed.handled, ['m1']);
    expect(missed.countReads, greaterThan(counted));
    expect(state().rows.single.id, 'm2');
    expect(state().marking, isNull);
  });

  test('a refused Mark handled is said on the row, and the row stays', () async {
    final first = controller().choose(MyCallsTypeFilter.toFollowUp);
    api.answer(0, myCallsPage([missedRow('m1')]));
    await first;
    missed.handledAnswer = inboundRefusal('inbound_missed_call_not_found');
    expect(await controller().markHandled(state().rows.first), isFalse);
    expect(state().rowError, (id: 'm1', message: 'This missed call isn’t yours to handle, or it no longer exists.'));
    expect(state().rows.single.id, 'm1');
    expect(api.queries, hasLength(1));
  });

  test('Call back reads the Missed row for its number: the agent\'s own open rows, at that moment', () async {
    final first = controller().choose(MyCallsTypeFilter.toFollowUp);
    api.answer(0, myCallsPage([missedRow('m1')]));
    await first;
    expect(missed.queries, isEmpty, reason: 'showing the list reads no number');
    missed.autoPage = missedPage([missed_('m0'), missed_('m1')]);
    final call = await controller().missedCallFor(state().rows.single);
    expect(missed.queries.single.toQuery(), {'status': 'open', 'assignee': 'me', 'limit': '100'});
    expect(call!.id, 'm1');
    expect(call.fromE164, '+918765432109');
  });

  test('a Missed row that cannot be read is said on the card', () async {
    final first = controller().choose(MyCallsTypeFilter.toFollowUp);
    api.answer(0, myCallsPage([missedRow('m1')]));
    await first;
    missed.autoPage = missedPage([missed_('other')]);
    expect(await controller().missedCallFor(state().rows.single), isNull);
    expect(state().rowError, (id: 'm1', message: MyCallsCopy.callBackFailed));
  });
}

/// A Missed row of the Missed list (`missed` is this file's fake API).
InboundMissedCall missed_(String id) => InboundMissedCall.fromJson(missedJson(id));
