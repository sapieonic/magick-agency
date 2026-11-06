import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/features/customers/customer_history_copy.dart';

import 'support.dart';

void main() {
  late FakeCustomerHistoryApi api;
  late MemoryStore store;

  setUp(() {
    api = FakeCustomerHistoryApi();
    store = MemoryStore();
  });

  Future<GoRouter> open(WidgetTester tester, {String initial = Routes.customerSearch}) =>
      pumpCustomer(tester, customerOverrides(api, store), initial: initial);

  Finder field() => find.byKey(const Key('customer-number'));

  group('the search box', () {
    testWidgets('helper text always shown, India by default', (tester) async {
      await open(tester);
      expect(
        find.text('Type the full mobile number. You can include or leave out +91, spaces, dashes or a leading 0.'),
        findsOneWidget,
      );
      expect(
        find.text('For a number from another country, pick the country or start with + and the country code.'),
        findsOneWidget,
      );
      expect(find.text('IN +91'), findsOneWidget);
      expect(find.byKey(const Key('customer-preview')), findsNothing);
    });

    testWidgets('a live preview of the number the search will run on', (tester) async {
      await open(tester);
      await tester.enterText(field(), '098765-43210');
      await tester.pump();
      expect(find.text("We'll search for +91 98765 43210"), findsOneWidget);

      // Not a whole number yet: no promise.
      await tester.enterText(field(), '98765');
      await tester.pump();
      expect(find.byKey(const Key('customer-preview')), findsNothing);
    });

    testWidgets('another country: the helper and the preview follow it', (tester) async {
      await open(tester);
      await tester.tap(find.byKey(const Key('customer-country')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('customer-country-GB')));
      await tester.pumpAndSettle();
      expect(find.text('GB +44'), findsOneWidget);
      expect(find.textContaining('leave out +44,'), findsOneWidget);
      await tester.enterText(field(), '020 7946 0018');
      await tester.pump();
      expect(find.text("We'll search for +44 20 7946 0018"), findsOneWidget);
    });

    testWidgets('a part of a number is refused in place and never sent', (tester) async {
      await open(tester);
      await tester.enterText(field(), '43210');
      await tester.tap(find.byKey(const Key('customer-search')));
      await tester.pumpAndSettle();
      expect(find.text("Enter the full number. Searching by the last few digits isn't supported."), findsOneWidget);
      expect(api.searches, isEmpty);
      expect(find.text('My calls'), findsNothing);
    });

    testWidgets('the search cap says how long to wait', (tester) async {
      api.searchError = const ApiHttpError(
        status: 429,
        code: null,
        message: 'Too many requests',
        body: {'error': 'Too Many Requests', 'retryAfter': 30},
        requestId: null,
      );
      await open(tester);
      await tester.enterText(field(), '9876543210');
      await tester.tap(find.byKey(const Key('customer-search')));
      await tester.pumpAndSettle();
      expect(
        find.text("You've searched a lot of numbers in a short time. Try again in 30 seconds."),
        findsOneWidget,
      );
    });

    testWidgets('a found number opens its history; the route never carries it', (tester) async {
      api.autoSearch = answer();
      await open(tester);
      await tester.enterText(field(), '098765-43210');
      await tester.tap(find.byKey(const Key('customer-search')));
      await tester.pumpAndSettle();
      expect(find.text('Results for +91 98765 43210'), findsOneWidget);
      // The pushed page's own state: `currentConfiguration.uri` is the base
      // location and does not include a route pushed on top of it.
      final results = tester.element(find.byKey(const Key('customer-results-title')));
      final location = GoRouterState.of(results).uri.toString();
      expect(location, Routes.customerHistory);
      expect(location, isNot(contains('98765')));
    });

    testWidgets('recent searches: tap to search again; Clear forgets them', (tester) async {
      store.values[SessionStore.recentSearchesKey] = '[{"e164":"$searchedE164","display":"$searchedDisplay"}]';
      api.autoSearch = answer();
      await open(tester);
      expect(find.text(CustomerHistoryCopy.recent.toUpperCase()), findsOneWidget);
      await tester.tap(find.text(searchedDisplay));
      await tester.pumpAndSettle();
      expect(api.searches.single.value, searchedE164);
      expect(find.text('Results for +91 98765 43210'), findsOneWidget);

      await tester.pageBack();
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('customer-recent-clear')));
      await tester.pumpAndSettle();
      expect(find.text(searchedDisplay), findsNothing);
      expect(store.values.containsKey(SessionStore.recentSearchesKey), isFalse);
    });
  });

  group('the history', () {
    Future<void> searched(WidgetTester tester) async {
      await open(tester);
      await tester.enterText(field(), '9876543210');
      await tester.tap(find.byKey(const Key('customer-search')));
      await tester.pumpAndSettle();
    }

    testWidgets('who the number is, the totals, DNC status and the timeline as an agent reads it', (tester) async {
      api.autoSearch = answer();
      await searched(tester);
      expect(find.text('Asha Rao · LN-0042'), findsOneWidget);
      expect(find.text('Waiting to be called'), findsOneWidget);
      expect(find.text('4 calls placed · 2 connected'), findsOneWidget);
      expect(find.text(CustomerHistoryCopy.notOnDnc), findsOneWidget);
      expect(find.byKey(const Key('customer-entry-softphone_call:m1')), findsOneWidget);
      expect(find.text('Will pay on Friday'), findsOneWidget);
      expect(find.byKey(const Key('customer-notes-hidden-campaign_call:a1')), findsOneWidget);
      expect(find.text(CustomerHistoryCopy.notesHidden), findsOneWidget);
      expect(find.textContaining(CustomerHistoryCopy.recordingExpired), findsOneWidget);
      expect(find.byKey(const Key('customer-history-end')), findsOneWidget);
      expect(find.byKey(const Key('customer-load-more')), findsNothing);
    });

    testWidgets('on a do-not-call list: where, who and why', (tester) async {
      api.autoSearch = answer(dnc: [dncJson()]);
      await searched(tester);
      expect(find.text(CustomerHistoryCopy.notOnDnc), findsNothing);
      expect(find.byKey(const Key('customer-dnc')), findsOneWidget);
      expect(find.textContaining('Campaign: October dues'), findsOneWidget);
      expect(find.textContaining('Asked not to be called'), findsOneWidget);
    });

    testWidgets('nothing in the visible accounts', (tester) async {
      api.autoSearch = answer(empty: true);
      await searched(tester);
      expect(find.text('No calls to this number in the accounts you can see'), findsOneWidget);
      expect(find.byKey(const Key('customer-totals')), findsNothing);
    });

    testWidgets('Load more reads the next page with the cursor', (tester) async {
      api.autoSearch = answer(next: 'cur-1');
      await searched(tester);
      api.autoTimeline = timelinePage([campaignCallJson(2, notesHidden: false, notes: 'Second call')]);
      await tester.tap(find.byKey(const Key('customer-load-more')));
      await tester.pumpAndSettle();
      expect(api.timelines.single.cursor, 'cur-1');
      expect(find.text('Second call'), findsOneWidget);
      expect(find.byKey(const Key('customer-load-more')), findsNothing);
    });

    testWidgets('the soft-phone filter reads its first page again', (tester) async {
      api.autoSearch = answer();
      await searched(tester);
      api.autoTimeline = timelinePage([softphoneCallJson(1)]);
      await tester.tap(find.byKey(const Key('customer-filter-softphone')));
      await tester.pumpAndSettle();
      expect(api.timelines.single.filters?.toJson(), {'channel': 'softphone'});
      expect(api.timelines.single.cursor, isNull);
      expect(find.byKey(const Key('customer-entry-campaign_call:a1')), findsNothing);
    });

    testWidgets('opened with no search in memory, it offers to search', (tester) async {
      await open(tester, initial: Routes.customerHistory);
      expect(find.byKey(const Key('customer-no-result')), findsOneWidget);
    });
  });
}
