import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/features/calls/my_calls_controller.dart';
import 'package:magick_agency_agent/features/calls/my_calls_copy.dart';
import 'package:magick_agency_agent/features/missed/missed_count_controller.dart';

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
    missed = missedInStep();
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

  test('a server with no /my-calls route (an older one): says the server needs updating, not a generic error', () async {
    // What a server from before the route answers: Fastify's own 404, with no `code`.
    const routeMissing = ApiHttpError(
      status: 404,
      code: null,
      message: 'Route GET:/proxy/agency/my-calls?type=all&limit=50 not found',
      body: {'message': 'Route GET:/proxy/agency/my-calls not found', 'error': 'Not Found', 'statusCode': 404},
      requestId: null,
    );
    final first = controller().ensureLoaded();
    api.fail(0, routeMissing);
    await first;
    expect(state().status, MyCallsStatus.error);
    expect(state().error, 'My calls needs a newer version of the server. Ask your admin to update it.');
    expect(state().error, isNot(contains('Route GET')));
    // A 404 the route itself answers keeps its own words.
    const refused = ApiHttpError(
      status: 404,
      code: 'campaign_not_found',
      message: 'Campaign not found.',
      body: {'code': 'campaign_not_found', 'message': 'Campaign not found.'},
      requestId: null,
    );
    expect(myCallsLoadError(refused), isNot(MyCallsCopy.serverTooOld));
    expect(myCallsLoadError(const ApiNetworkError('offline')), isNot(MyCallsCopy.serverTooOld));
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

  // The To follow up badge and the shell's My calls badge count the same open
  // Missed rows: when the shell's moves, what is owed here is read again.
  // On screen the list is watched; a provider nobody listens to has its own
  // listeners paused, the one on the badge included.
  void onScreen() => addTearDown(container.listen(myCallsControllerProvider, (_, _) {}).close);

  Future<void> moveMissedBadge(int open) async {
    // The count's own first read (asked for when the workspace started) lands first: a
    // refresh while it is in flight would share it.
    await Future<void>.delayed(Duration.zero);
    missed.countAnswer = countOf(open, hasRows: true);
    await container.read(missedCountControllerProvider.notifier).refresh();
    await Future<void>.delayed(Duration.zero);
  }

  test('the Missed badge moving under another chip reads the counts again, and leaves the rows and the cursor', () async {
    onScreen();
    final first = controller().ensureLoaded();
    api.answer(0, myCallsPage([myCall('a1')], next: 'c1'));
    await first;
    expect(state().counts!.toFollowUp, 0);
    await moveMissedBadge(2);
    expect(api.queries, hasLength(2));
    expect(api.q(1), {'limit': '1', 'include_counts': '1'});
    api.answer(1, myCallsPage([myCall('zz')], counts: const MyCallsCounts(toFollowUp: 3, missedOpen: 2, callbacksDue: 1)));
    await Future<void>.delayed(Duration.zero);
    expect(state().counts, const MyCallsCounts(toFollowUp: 3, missedOpen: 2, callbacksDue: 1));
    expect(state().rows.map((r) => r.id), ['a1'], reason: 'the one-row page is read for its counts alone');
    expect(state().nextCursor, 'c1');
  });

  test('the Missed badge moving under To follow up reads the list again, the rows kept until it lands', () async {
    onScreen();
    final first = controller().choose(MyCallsTypeFilter.toFollowUp);
    api.answer(0, myCallsPage([missedRow('m1')], counts: const MyCallsCounts(toFollowUp: 1, missedOpen: 1, callbacksDue: 0)));
    await first;
    await moveMissedBadge(2);
    expect(api.queries, hasLength(2));
    expect(api.q(1), {'type': 'to_follow_up', 'limit': '50', 'include_counts': '1'});
    expect(state().rows.single.id, 'm1');
    expect(state().refreshing, isTrue);
    api.answer(1, myCallsPage([missedRow('m2'), missedRow('m1')], counts: const MyCallsCounts(toFollowUp: 2, missedOpen: 2, callbacksDue: 0)));
    await Future<void>.delayed(Duration.zero);
    expect(state().rows.map((r) => r.id), ['m2', 'm1']);
    expect(state().counts!.toFollowUp, 2);
  });

  test('a Missed badge that says what the list already counts reads nothing', () async {
    onScreen();
    final first = controller().ensureLoaded();
    api.answer(0, myCallsPage([myCall('a1')], counts: const MyCallsCounts(toFollowUp: 3, missedOpen: 2, callbacksDue: 1)));
    await first;
    await moveMissedBadge(2);
    expect(api.queries, hasLength(1));
  });

  test('the Missed badge moving while the first page is in flight is followed once the page lands', () async {
    onScreen();
    final first = controller().ensureLoaded();
    await moveMissedBadge(4);
    expect(api.queries, hasLength(1), reason: 'the page in flight may already hold the new count');
    api.answer(0, myCallsPage([myCall('a1')]));
    await first;
    await Future<void>.delayed(Duration.zero);
    // It did not: asked for before the count moved, it still says none.
    expect(api.queries, hasLength(2));
    expect(api.q(1), {'limit': '1', 'include_counts': '1'});
  });

  test('Call back reads that one Missed row by its id for its number, at that moment', () async {
    final first = controller().choose(MyCallsTypeFilter.toFollowUp);
    api.answer(0, myCallsPage([missedRow('m1')]));
    await first;
    expect(missed.read, isEmpty, reason: 'showing the list reads no number');
    missed.oneAnswer = missed_('m1');
    final call = await controller().missedCallFor(state().rows.single);
    // By id, never a page of the Missed list: an agent with more open rows
    // than a page holds could not call back the ones past it.
    expect(missed.read, ['m1']);
    expect(missed.queries, isEmpty);
    expect(call!.id, 'm1');
    expect(call.fromE164, '+918765432109');
  });

  test('a Missed row that cannot be read is said on the card', () async {
    final first = controller().choose(MyCallsTypeFilter.toFollowUp);
    api.answer(0, myCallsPage([missedRow('m1')]));
    await first;
    missed.oneAnswer = inboundRefusal('inbound_missed_call_not_found');
    expect(await controller().missedCallFor(state().rows.single), isNull);
    expect(state().rowError, (id: 'm1', message: MyCallsCopy.callBackFailed));
  });
}

/// A Missed row of the Missed list (`missed` is this file's fake API).
InboundMissedCall missed_(String id) => InboundMissedCall.fromJson(missedJson(id));
