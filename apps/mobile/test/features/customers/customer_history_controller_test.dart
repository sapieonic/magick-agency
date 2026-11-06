import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/features/customers/customer_history_controller.dart';
import 'package:magick_agency_agent/features/customers/customer_history_copy.dart';
import 'package:magick_agency_agent/features/customers/recent_searches.dart';

import 'support.dart';

void main() {
  late FakeCustomerHistoryApi api;
  late MemoryStore store;

  setUp(() {
    api = FakeCustomerHistoryApi();
    store = MemoryStore();
  });

  ProviderContainer container() {
    final c = ProviderContainer.test(overrides: customerOverrides(api, store));
    // Listened, as a screen listens: an unlistened provider's own subscriptions are paused.
    c.listen(customerHistoryControllerProvider, (_, _) {});
    return c;
  }

  CustomerHistoryController controllerOf(ProviderContainer c) => c.read(customerHistoryControllerProvider.notifier);
  CustomerHistoryState stateOf(ProviderContainer c) => c.read(customerHistoryControllerProvider);

  test('the picker starts on India', () {
    final c = container();
    expect(stateOf(c).country.iso, 'IN');
  });

  test('a number the shared rule refuses is not sent; the refusal says what to do', () async {
    final c = container();
    expect(await controllerOf(c).search('43210'), isFalse);
    expect(api.searches, isEmpty);
    expect(stateOf(c).searchError, "Enter the full number. Searching by the last few digits isn't supported.");
    controllerOf(c).editing();
    expect(stateOf(c).searchError, isNull);
  });

  test('the search sends the raw text and the picked country, never a reformatted number', () async {
    final c = container();
    controllerOf(c).pickCountry(searchCountryByIso('GB')!);
    api.autoSearch = answer();
    expect(await controllerOf(c).search('  020 7946 0018 '), isTrue);
    expect(api.searches.single.toJson(), {'by': 'phone', 'value': '020 7946 0018', 'country': 'GB'});
  });

  test('an answer is held with its first page, and remembered on this device', () async {
    final c = container();
    api.autoSearch = answer(next: 'cur-1');
    expect(await controllerOf(c).search('098765-43210'), isTrue);
    await pumpEventQueue();
    final s = stateOf(c);
    expect(s.result?.key.display, searchedDisplay);
    expect(s.entries, hasLength(2));
    expect(s.hasMore, isTrue);
    expect(s.recent, [const RecentSearch(e164: searchedE164, display: searchedDisplay)]);
    expect(await RecentSearchesStore(store).read(), s.recent);
  });

  test('recent searches: newest first, once each, five at most; Clear forgets them', () async {
    final recent = RecentSearchesStore(store);
    for (var i = 0; i < 6; i++) {
      await recent.remember(RecentSearch(e164: '+9198765432$i$i', display: 'n$i'));
    }
    await recent.remember(const RecentSearch(e164: '+919876543222', display: 'n2'));
    expect((await recent.read()).map((r) => r.display), ['n2', 'n5', 'n4', 'n3', 'n1']);

    final c = container();
    await pumpEventQueue();
    expect(stateOf(c).recent, hasLength(5));
    await controllerOf(c).clearRecent();
    expect(stateOf(c).recent, isEmpty);
    expect(store.values.containsKey(SessionStore.recentSearchesKey), isFalse);
  });

  test('a damaged stored value reads as no recent searches', () async {
    store.values[SessionStore.recentSearchesKey] = '{not json';
    expect(await RecentSearchesStore(store).read(), isEmpty);
    store.values[SessionStore.recentSearchesKey] = '[{"e164":1},{"e164":"+919876543210","display":"x"}]';
    expect(await RecentSearchesStore(store).read(), [const RecentSearch(e164: '+919876543210', display: 'x')]);
  });

  test('the search cap: the wait, in seconds', () async {
    final c = container();
    api.searchError = const ApiHttpError(
      status: 429,
      code: null,
      message: 'Too many requests',
      body: {'error': 'Too Many Requests', 'retryAfter': 12},
      requestId: null,
    );
    expect(await controllerOf(c).search('9876543210'), isFalse);
    expect(
      stateOf(c).searchError,
      "You've searched a lot of numbers in a short time. Try again in 12 seconds.",
    );
  });

  test('the server\'s number refusal is shown in its words', () async {
    final c = container();
    api.searchError = const ApiHttpError(
      status: 400,
      code: 'invalid_number',
      message: 'Server words.',
      body: {'error': 'Bad Request', 'code': 'invalid_number', 'message': 'Server words.', 'number_error': 'too_short'},
      requestId: null,
    );
    await controllerOf(c).search('9876543210');
    expect(stateOf(c).searchError, 'Server words.');
  });

  test('a filter restarts from the first page; Load more continues it with the cursor', () async {
    final c = container();
    api.autoSearch = answer(next: 'cur-1');
    await controllerOf(c).search('9876543210');

    final filter = CustomerHistoryFilter.none.withChannel(CustomerTimelineChannel.softphone);
    final applying = controllerOf(c).applyFilter(filter);
    expect(stateOf(c).loadingTimeline, isTrue);
    expect(stateOf(c).entries, isEmpty);
    api.pendingTimelines.single.complete(timelinePage([softphoneCallJson(1)], next: 'cur-2'));
    await applying;
    expect(api.timelines.single.toJson(), {
      'search_id': 'chs_1',
      'filters': {'channel': 'softphone'},
      'limit': customerTimelinePageSize,
    });
    expect(stateOf(c).entries, hasLength(1));

    final more = controllerOf(c).loadMore();
    api.pendingTimelines.last.complete(timelinePage([softphoneCallJson(2)]));
    await more;
    expect(api.timelines.last.toJson(), {
      'search_id': 'chs_1',
      'filters': {'channel': 'softphone'},
      'cursor': 'cur-2',
      'limit': customerTimelinePageSize,
    });
    expect(stateOf(c).entries.map((e) => e.key), ['softphone_call:m1', 'softphone_call:m2']);
    expect(stateOf(c).hasMore, isFalse);
  });

  test('a page for a filter no longer on screen is dropped', () async {
    final c = container();
    api.autoSearch = answer(next: 'cur-1');
    await controllerOf(c).search('9876543210');

    final more = controllerOf(c).loadMore();
    final applying = controllerOf(c).applyFilter(const CustomerHistoryFilter(connectedOnly: true));
    api.pendingTimelines[0].complete(timelinePage([campaignCallJson(9)]));
    await more;
    expect(stateOf(c).entries, isEmpty, reason: 'the unfiltered page 2 must not land under the new filter');
    api.pendingTimelines[1].complete(timelinePage([campaignCallJson(1)]));
    await applying;
    expect(stateOf(c).entries.map((e) => e.key), ['campaign_call:a1']);
    expect(api.timelines[1].filters?.connectedOnly, isTrue);
  });

  test('an expired search stops paging and offers to search again', () async {
    final c = container();
    api.autoSearch = answer(next: 'cur-1');
    await controllerOf(c).search('9876543210');
    final more = controllerOf(c).loadMore();
    api.pendingTimelines.single.completeError(
      const ApiHttpError(
        status: 404,
        code: 'search_expired',
        message: 'This search has expired. Search the number again.',
        body: {'error': 'Not Found', 'code': 'search_expired', 'message': 'This search has expired. Search the number again.'},
        requestId: null,
      ),
    );
    await more;
    expect(stateOf(c).expired, isTrue);
    expect(stateOf(c).moreError, CustomerHistoryCopy.expired);
    await controllerOf(c).loadMore();
    expect(api.timelines, hasLength(1), reason: 'nothing more is asked of an expired search');

    api.autoSearch = answer(searchId: 'chs_2');
    expect(await controllerOf(c).searchAgain(), isTrue);
    expect(api.searches.last.value, searchedE164);
    expect(stateOf(c).expired, isFalse);
    expect(stateOf(c).result?.searchId, 'chs_2');
  });

  test('another workspace drops the answer', () async {
    final c = container();
    api.autoSearch = answer();
    await controllerOf(c).search('9876543210');
    expect(stateOf(c).result, isNotNull);
    c.read(testWorkspaceProvider.notifier).set('u1:t1:a2');
    expect(stateOf(c).result, isNull);
    expect(stateOf(c).entries, isEmpty);
  });
}
