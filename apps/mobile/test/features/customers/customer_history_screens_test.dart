import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/features/customers/customer_history_controller.dart';
import 'package:magick_agency_agent/features/customers/customer_history_copy.dart';
import 'package:magick_agency_agent/features/customers/customer_history_screen.dart';

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
      // Still on the search page: the results were never pushed over it.
      expect(find.byKey(const Key('customer-results-title')), findsNothing);
      expect(find.byKey(const Key('customer-number')), findsOneWidget);
    });

    testWidgets('letters are refused as they are typed; a short number only once Search is pressed', (tester) async {
      await open(tester);
      await tester.enterText(field(), '98765abc');
      await tester.pump();
      expect(find.text('Only digits, spaces, +, dashes and brackets are allowed.'), findsOneWidget);

      await tester.enterText(field(), '98765');
      await tester.pump();
      expect(find.text("Enter the full number. Searching by the last few digits isn't supported."), findsNothing);
      expect(find.byKey(const Key('customer-preview')), findsNothing);

      await tester.tap(find.byKey(const Key('customer-search')));
      await tester.pumpAndSettle();
      expect(find.text("Enter the full number. Searching by the last few digits isn't supported."), findsOneWidget);

      // Typed whole: the refusal gives way to the preview.
      await tester.enterText(field(), '9876543210');
      await tester.pump();
      expect(find.text("Enter the full number. Searching by the last few digits isn't supported."), findsNothing);
      expect(find.text("We'll search for +91 98765 43210"), findsOneWidget);
    });

    testWidgets('the picker starts on the platform default the server names', (tester) async {
      api.defaultCountryCode = '+971';
      await open(tester);
      expect(find.text('AE +971'), findsOneWidget);
      expect(find.textContaining('leave out +971,'), findsOneWidget);
    });

    testWidgets('the platform default cannot be read: India', (tester) async {
      api.optionsError = const ApiHttpError(status: 500, code: null, message: '', body: {}, requestId: null);
      await open(tester);
      expect(find.text('IN +91'), findsOneWidget);
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
      expect(find.text('RECENT SEARCHES ON THIS DEVICE'), findsOneWidget);
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

    const expiredError = ApiHttpError(
      status: 404,
      code: 'search_expired',
      message: 'This search has expired. Search the number again.',
      body: {
        'error': 'Not Found',
        'code': 'search_expired',
        'message': 'This search has expired. Search the number again.',
      },
      requestId: null,
    );

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
      expect(find.textContaining('ptp · Recording available'), findsOneWidget);
      expect(find.byKey(const Key('customer-history-end')), findsOneWidget);
      expect(find.byKey(const Key('customer-load-more')), findsNothing);
      expect(find.byKey(const Key('customer-contacts-truncated')), findsNothing);
    });

    testWidgets("each contact card shows its campaign's status; one account is not named", (tester) async {
      api.autoSearch = answer();
      await searched(tester);
      final status = find.byKey(const Key('customer-campaign-status-k1'));
      expect(status, findsOneWidget);
      expect(find.descendant(of: status, matching: find.text('Running')), findsOneWidget);
      expect(find.textContaining('3 calls placed · Assigned to Priya Nair'), findsOneWidget);
      expect(find.textContaining('Collections North ·'), findsNothing);
      expect(find.textContaining('from october-dues.csv'), findsOneWidget);
    });

    testWidgets('more roster rows than the summary lists: it says so', (tester) async {
      api.autoSearch = answer(contactsTruncated: true);
      await searched(tester);
      expect(
        find.text('Showing the 2,000 most recent roster rows for this number. The timeline still includes every call.'),
        findsOneWidget,
      );
    });

    testWidgets('copy the number: the E.164 to the clipboard, and a word that it was', (tester) async {
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') copied = (call.arguments as Map<Object?, Object?>)['text'] as String?;
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      api.autoSearch = answer();
      await searched(tester);
      await tester.tap(find.byKey(const Key('customer-copy-number')));
      await tester.pumpAndSettle();
      expect(copied, searchedE164);
      expect(find.text('Number copied'), findsOneWidget);
    });

    testWidgets('on a do-not-call list: where, who and why', (tester) async {
      api.autoSearch = answer(dnc: [dncJson()]);
      await searched(tester);
      expect(find.text(CustomerHistoryCopy.notOnDnc), findsNothing);
      expect(find.byKey(const Key('customer-dnc')), findsOneWidget);
      expect(find.textContaining('Campaign: October dues (Collections North)'), findsOneWidget);
      expect(find.textContaining('Asked not to be called'), findsOneWidget);
    });

    testWidgets('nothing in the visible accounts: the empty state, and its DNC status', (tester) async {
      api.autoSearch = answer(empty: true);
      await searched(tester);
      expect(find.text('No calls to this number in the accounts you can see'), findsOneWidget);
      expect(find.byKey(const Key('customer-dnc-none')), findsOneWidget);
      expect(find.text('Not on any do-not-call list'), findsOneWidget);
      expect(find.byKey(const Key('customer-totals')), findsNothing);
    });

    testWidgets('no calls but a do-not-call entry: the empty state still shows it', (tester) async {
      api.autoSearch = answer(empty: true, dnc: [dncJson()]);
      await searched(tester);
      expect(find.byKey(const Key('customer-empty')), findsOneWidget);
      expect(find.byKey(const Key('customer-dnc')), findsOneWidget);
      expect(find.byKey(const Key('customer-dnc-none')), findsNothing);
    });

    testWidgets('a number only on a do-not-call list: its mark is history, not "no calls"', (tester) async {
      api.autoSearch = answer(empty: true, dnc: [dncJson()], entries: [dncMarkJson()]);
      await searched(tester);
      expect(find.byKey(const Key('customer-empty')), findsNothing);
      expect(find.text('0 calls placed · 0 connected'), findsOneWidget);
      expect(find.text(CustomerHistoryCopy.neverContacted), findsOneWidget);
      expect(find.byKey(const Key('customer-dnc')), findsOneWidget);
      expect(find.byKey(const Key('customer-entry-dnc_mark:d1')), findsOneWidget);
      expect(find.text('Added to a do-not-call list'), findsOneWidget);
    });

    testWidgets('a call live now to a number with no history yet is shown, not "no calls"', (tester) async {
      api.autoSearch = answer(empty: true, liveCalls: [liveCallJson()]);
      await open(tester);
      await tester.enterText(field(), '9876543210');
      await tester.tap(find.byKey(const Key('customer-search')));
      // The live dot never settles: pump the push through instead.
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(find.byKey(const Key('customer-empty')), findsNothing);
      expect(find.byKey(const Key('customer-live-0')), findsOneWidget);
      expect(find.text('Live now · October dues · Karan Shah'), findsOneWidget);
    });

    testWidgets('what is open: a callback with its owner, overrides with or without a follow-up', (tester) async {
      api.autoSearch = answer(
        callbacks: [openCallbackJson()],
        overrides: [
          openOverrideJson(followUpAt: '2026-11-08T05:00:00.000Z'),
          openOverrideJson(contactId: 'k2'),
        ],
      );
      await searched(tester);
      expect(find.text('OPEN NOW'), findsOneWidget);
      final callback = find.byKey(const Key('customer-open-callback-k1'));
      expect(callback, findsOneWidget);
      expect(tester.widget<Text>(callback).data, contains('for Priya Nair · booked by Karan Shah'));
      final due = tester.widget<Text>(find.byKey(const Key('customer-open-override-k1-0'))).data;
      expect(due, startsWith('Override from ptp · October dues · 1 extra attempt, retry delay waived · Follow-up '));
      final none = tester.widget<Text>(find.byKey(const Key('customer-open-override-k2-1'))).data;
      expect(
        none,
        'Override from ptp · October dues · 1 extra attempt, retry delay waived · No follow-up scheduled',
      );
    });

    testWidgets('callbacks, roster entries and kinds this build does not know', (tester) async {
      api.autoSearch = answer(entries: [callbackJson(), rosterJson(), unknownEntryJson()]);
      await searched(tester);
      expect(find.text('Callback booked · October dues'), findsOneWidget);
      expect(find.text('Missed'), findsOneWidget);
      expect(find.text('Booked by Karan Shah'), findsOneWidget);
      expect(find.text('Added to October dues from october-dues.csv'), findsOneWidget);
      expect(find.text(CustomerHistoryCopy.unknownEntry), findsOneWidget);
    });

    testWidgets('a call and its wrap-up redial read as one chain', (tester) async {
      api.autoSearch = answer(entries: [
        campaignCallJson(1, redialOf: 'a2', redialNumber: 1),
        campaignCallJson(2),
        softphoneCallJson(1),
      ]);
      await searched(tester);
      final chain = find.byKey(const Key('customer-chain-a2-campaign_call:a1'));
      expect(chain, findsOneWidget);
      expect(
        find.descendant(of: chain, matching: find.byKey(const Key('customer-entry-campaign_call:a1'))),
        findsOneWidget,
      );
      expect(
        find.descendant(of: chain, matching: find.byKey(const Key('customer-entry-campaign_call:a2'))),
        findsOneWidget,
      );
      expect(
        find.descendant(of: chain, matching: find.byKey(const Key('customer-entry-softphone_call:m1'))),
        findsNothing,
      );
      expect(find.textContaining('Wrap-up redial 1 of the call at '), findsOneWidget);
      expect(find.text('Redialled in wrap-up once'), findsOneWidget);
    });

    testWidgets('a soft-phone call: its fields and the notes on what it overrode', (tester) async {
      api.autoSearch = answer(entries: [
        softphoneCallJson(
          1,
          fields: {'Promise date': '2026-11-12', 'Amount': 5000, 'Paid': true, 'Remark': null},
          dncOverrideNote: 'Asked us to call back',
        ),
        campaignCallJson(1, overrideApplied: ['retry_delay'], overrideNote: 'Customer asked'),
      ]);
      await searched(tester);
      expect(find.text('Promise date: 2026-11-12'), findsOneWidget);
      expect(find.text('Amount: 5000'), findsOneWidget);
      expect(find.text('Paid: Yes'), findsOneWidget);
      expect(find.text('Remark: --'), findsOneWidget);
      expect(find.text('Called despite do-not-call: “Asked us to call back”'), findsOneWidget);
      expect(find.text('Override used: retry delay waived · Customer asked'), findsOneWidget);
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

    testWidgets('the filters sheet: campaign, outcome, code and agent from the options, applied together',
        (tester) async {
      api.autoSearch = answer(filterOptions: filterOptionsJson());
      await searched(tester);
      api.autoTimeline = timelinePage([]);
      await tester.tap(find.byKey(const Key('customer-filter-more')));
      await tester.pumpAndSettle();

      Future<void> choose(String dropdown, String option) async {
        await tester.tap(find.byKey(Key(dropdown)));
        await tester.pumpAndSettle();
        await tester.tap(find.text(option).last);
        await tester.pumpAndSettle();
      }

      await choose('customer-filter-campaign-choice', 'November dues');
      await choose('customer-filter-outcome-choice', 'No answer');
      await choose('customer-filter-code-choice', 'ptp');
      await choose('customer-filter-agent-choice', 'Karan Shah');
      expect(api.timelines, isEmpty, reason: 'nothing is read until Apply');
      await tester.tap(find.byKey(const Key('customer-filters-apply')));
      await tester.pumpAndSettle();

      expect(api.timelines.single.cursor, isNull);
      expect(api.timelines.single.filters?.toJson(), {
        'campaign_ids': ['c2'],
        'outcomes': ['no_answer'],
        'disposition_codes': ['ptp'],
        'agent_user_ids': ['u2'],
      });
      expect(find.text('Filters (4)'), findsOneWidget);
      expect(find.text('Nothing in this history matches these filters.'), findsOneWidget);

      await tester.tap(find.byKey(const Key('customer-filter-clear')));
      await tester.pumpAndSettle();
      expect(api.timelines, hasLength(2));
      expect(api.timelines.last.filters, isNull);
      expect(find.text(CustomerHistoryCopy.filters), findsOneWidget);
    });

    testWidgets('a choice the options no longer list is dropped when the sheet opens', (tester) async {
      api.autoSearch = answer(filterOptions: filterOptionsJson());
      await searched(tester);
      api.autoTimeline = timelinePage([]);
      final container = ProviderScope.containerOf(tester.element(find.byType(CustomerHistoryScreen)));
      final applying = container
          .read(customerHistoryControllerProvider.notifier)
          .applyFilter(const CustomerHistoryFilter(campaignId: 'gone', agentUserId: 'u2'));
      await tester.pumpAndSettle();
      await applying;
      expect(find.text('Filters (2)'), findsOneWidget);

      await tester.tap(find.byKey(const Key('customer-filter-more')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('customer-filters-apply')));
      await tester.pumpAndSettle();
      expect(api.timelines.last.filters?.toJson(), {
        'agent_user_ids': ['u2'],
      });
      expect(find.text('Filters (1)'), findsOneWidget);
    });

    testWidgets('expired: Search again says why it failed, then searches the number afresh', (tester) async {
      api.autoSearch = answer(next: 'cur-1');
      await searched(tester);
      await tester.tap(find.byKey(const Key('customer-load-more')));
      await tester.pump();
      api.pendingTimelines.single.completeError(expiredError);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('customer-expired')), findsOneWidget);
      // Neither "the whole history" nor Load more: the page no longer knows.
      expect(find.byKey(const Key('customer-history-end')), findsNothing);
      expect(find.byKey(const Key('customer-load-more')), findsNothing);

      api.autoSearch = null;
      api.searchError = const ApiHttpError(
        status: 429,
        code: null,
        message: 'Too many requests',
        body: {'error': 'Too Many Requests', 'retryAfter': 20},
        requestId: null,
      );
      await tester.tap(find.text(CustomerHistoryCopy.searchAgain));
      await tester.pumpAndSettle();
      expect(api.searches.last.value, searchedE164);
      expect(find.byKey(const Key('customer-notice-error')), findsOneWidget);
      expect(find.text("You've searched a lot of numbers in a short time. Try again in 20 seconds."), findsOneWidget);

      api.searchError = null;
      api.autoSearch = answer(searchId: 'chs_2');
      await tester.tap(find.text(CustomerHistoryCopy.searchAgain));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('customer-expired')), findsNothing);
      expect(find.byKey(const Key('customer-history-end')), findsOneWidget);
    });

    testWidgets('expired under a filter: no "nothing matches", the filters are off', (tester) async {
      api.autoSearch = answer();
      await searched(tester);
      await tester.tap(find.byKey(const Key('customer-filter-softphone')));
      await tester.pump();
      api.pendingTimelines.single.completeError(expiredError);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('customer-expired')), findsOneWidget);
      expect(find.byKey(const Key('customer-timeline-none')), findsNothing);
      await tester.tap(find.byKey(const Key('customer-filter-campaign')));
      await tester.pumpAndSettle();
      expect(api.timelines, hasLength(1), reason: 'an expired search reads no more pages');
    });

    testWidgets('a page that did not load offers to try again', (tester) async {
      api.autoSearch = answer();
      await searched(tester);
      await tester.tap(find.byKey(const Key('customer-filter-softphone')));
      await tester.pump();
      api.pendingTimelines.single.completeError(
        const ApiHttpError(status: 500, code: null, message: '', body: {}, requestId: null),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('customer-timeline-error')), findsOneWidget);
      api.autoTimeline = timelinePage([softphoneCallJson(1)]);
      await tester.tap(find.text(CustomerHistoryCopy.tryAgain));
      await tester.pumpAndSettle();
      expect(api.timelines, hasLength(2));
      expect(find.byKey(const Key('customer-entry-softphone_call:m1')), findsOneWidget);
    });

    testWidgets('opened with no search in memory, it offers to search', (tester) async {
      await open(tester, initial: Routes.customerHistory);
      expect(find.byKey(const Key('customer-no-result')), findsOneWidget);
    });
  });
}
