import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/features/calls/calls_screen.dart';
import 'package:magick_agency_agent/features/calls/softphone/softphone_call_detail_sheet.dart';
import 'package:magick_agency_agent/features/calls/softphone/softphone_call_tile.dart';
import 'package:magick_agency_agent/features/calls/softphone/softphone_calls_list.dart';

import 'softphone_support.dart';

void main() {
  late FakeSoftphoneCallsApi soft;
  late FakeAttemptsApi attempts;
  late List<String> phoneOpens;

  setUp(() {
    soft = FakeSoftphoneCallsApi();
    attempts = FakeAttemptsApi();
    phoneOpens = [];
  });

  List<Override> overrides({bool visible = true}) => [
        ...softphoneCallsOverrides(soft, attempts: attempts, visible: visible),
        softphoneCallsOpenPhoneProvider.overrideWithValue((_) => phoneOpens.add('/phone')),
      ];

  Future<void> open(WidgetTester tester, {bool visible = true}) async {
    await setPhoneSize(tester);
    await tester.pumpWidget(harness(const CallsScreen(), overrides(visible: visible)));
    await flush(tester);
  }

  Future<void> showSoftphone(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('calls-view-softphone')));
    await flush(tester);
  }

  group('the segment', () {
    testWidgets('hidden when the soft phone is not available and the agent has no soft-phone calls', (tester) async {
      await open(tester, visible: false);
      expect(find.byKey(const Key('calls-view')), findsNothing);
      expect(find.text('Soft-phone calls'), findsNothing);
      expect(soft.probes.single.agentUserId, 'u1');
      // The campaign list is unchanged.
      expect(find.byKey(const Key('filter-days')), findsOneWidget);
      expect(attempts.queries, hasLength(1));
      expect(soft.queries, isEmpty);
    });

    testWidgets('shown where the Phone tab shows; the campaign list stays the default', (tester) async {
      await open(tester);
      expect(find.byKey(const Key('calls-view')), findsOneWidget);
      expect(find.text('Campaign calls'), findsOneWidget);
      expect(find.byKey(const Key('filter-days')), findsOneWidget);
      expect(soft.queries, isEmpty); // not read until the agent asks for it
    });

    testWidgets('shown when a probe finds the agent\'s own soft-phone calls', (tester) async {
      soft.probeRows = {'u1': [softRow(1)]};
      await open(tester, visible: false);
      expect(find.byKey(const Key('calls-view')), findsOneWidget);
    });
  });

  testWidgets('rows: number, outcome, day and talk time, where it was logged', (tester) async {
    await open(tester);
    await showSoftphone(tester);
    expect(find.byKey(const Key('softphone-calls-loading')), findsOneWidget);
    expect(soft.q(0), {'agent_user_id': 'u1', 'limit': '50'});
    soft.answer(
      0,
      softRows([
        softRow(1),
        softRow(2, over: {'tag': null, 'disposition_code': 'wrong_number', 'disposition_source': 'untagged'}),
      ]),
    );
    await flush(tester);

    expect(find.text('+91 98204 10001'), findsOneWidget);
    expect(find.text('Interested, renewing'), findsOneWidget); // the campaign's catalog
    expect(find.text('Wrong number'), findsOneWidget); // the untagged catalog
    expect(find.text('Logged to Home Loan Renewals'), findsOneWidget);
    expect(find.text('Not logged to a campaign'), findsOneWidget);
    expect(find.textContaining('30 Oct'), findsNWidgets(2));
    expect(find.textContaining('3:41'), findsNWidgets(2));
    expect(find.text('Showing 2 calls'), findsOneWidget);
    expect(find.byKey(const Key('filter-days')), findsNothing);
  });

  testWidgets('the number search waits for a pause, sends digits only, and restarts from the first page', (tester) async {
    await open(tester);
    await showSoftphone(tester);
    soft.answer(0, softPage([1, 2], next: 'cur-1'));
    await flush(tester);
    expect(soft.queries, hasLength(2)); // a short page with more: the next one straight away
    soft.answer(1, softPage([3]));
    await flush(tester);

    final field = find.byKey(const Key('softphone-phone-search'));
    for (final s in ['9', '98', '98 2', '98 20']) {
      await tester.enterText(field, s);
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(soft.queries, hasLength(2));
    await tester.pump(const Duration(milliseconds: 400));
    expect(soft.queries, hasLength(3));
    expect(soft.q(2)['phone'], '9820');
    expect(soft.q(2).containsKey('cursor'), isFalse);
    expect(soft.q(2)['agent_user_id'], 'u1');
    soft.answer(2, softPage([4]));
    await flush(tester);
    expect(find.text('Showing 1 call'), findsOneWidget);
  });

  testWidgets('the status filter applies at once and can be cleared', (tester) async {
    await open(tester);
    await showSoftphone(tester);
    soft.answer(0, softPage([1]));
    await flush(tester);
    await tester.tap(find.byKey(const Key('softphone-filter-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Waiting for an outcome'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500)); // the sheet closes; the list spins
    expect(soft.q(1)['status'], 'awaiting_outcome');
    soft.answer(1, softPage([]));
    await flush(tester);
    expect(find.text('Nothing matches those filters'), findsOneWidget);

    await tester.ensureVisible(find.byKey(const Key('softphone-filter-clear')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('softphone-filter-clear')));
    await tester.pump();
    expect(soft.q(2), {'agent_user_id': 'u1', 'limit': '50'});
  });

  testWidgets('an unsettled row takes the agent to the Phone screen', (tester) async {
    await open(tester);
    await showSoftphone(tester);
    soft.answer(
      0,
      softRows([
        softRow(1, over: {
          'state': 'ended',
          'requires_disposition': true,
          'disposition_code': null,
          'settled_at': null,
        }),
      ]),
    );
    await flush(tester);
    expect(find.text('No outcome yet'), findsOneWidget);
    expect(find.text(softphoneFinishOnPhone), findsOneWidget);
    await tester.tap(find.text('+91 98204 10001'));
    await tester.pumpAndSettle();
    expect(phoneOpens, ['/phone']);
    expect(find.byKey(const Key('softphone-call-detail')), findsNothing);
    expect(soft.detailReads, isEmpty);
  });

  testWidgets('a settled row opens its detail: media null says the recording is the supervisors\'', (tester) async {
    await open(tester);
    await showSoftphone(tester);
    soft.answer(0, softPage([1]));
    await flush(tester);
    await tester.tap(find.text('+91 98204 10001'));
    await tester.pumpAndSettle();
    expect(soft.detailReads, ['mc-1']);
    expect(find.byKey(const Key('softphone-call-detail')), findsOneWidget);
    expect(find.text('The recording and analysis are available to supervisors'), findsOneWidget);
    expect(find.text('CALL RECORD'), findsOneWidget);
    expect(phoneOpens, isEmpty);
  });

  testWidgets('media is never rendered, even when an answer carries it', (tester) async {
    soft.details['mc-1'] = softDetail(
      call: {'id': 'mc-1'},
      media: {'transcript': 'SECRET TRANSCRIPT', 'recording_url': 'https://example.test/rec'},
    );
    await open(tester);
    await showSoftphone(tester);
    soft.answer(0, softPage([1]));
    await flush(tester);
    await tester.tap(find.text('+91 98204 10001'));
    await tester.pumpAndSettle();
    expect(find.textContaining('SECRET'), findsNothing);
    expect(find.textContaining('example.test'), findsNothing);
    expect(find.text('CALL RECORD'), findsOneWidget);
  });

  testWidgets('a detail the agent may not read says so, without a retry', (tester) async {
    soft.detailError = const ApiHttpError(
      status: 404,
      code: 'call_not_found',
      message: 'No such call.',
      body: {'error': 'Not Found', 'code': 'call_not_found', 'message': 'No such call.'},
      requestId: null,
    );
    await open(tester);
    await showSoftphone(tester);
    soft.answer(0, softPage([1]));
    await flush(tester);
    await tester.tap(find.text('+91 98204 10001'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('softphone-detail-gone')), findsOneWidget);
    expect(find.text('We can’t show this call'), findsOneWidget);
  });

  testWidgets('an account switch with the tab mounted drops the old calls and reads the new agent\'s', (tester) async {
    await open(tester);
    await showSoftphone(tester);
    soft.answer(0, softPage([1]));
    await flush(tester);
    expect(find.text('+91 98204 10001'), findsOneWidget);

    ProviderScope.containerOf(tester.element(find.byType(CallsScreen))).read(testWorkspaceProvider.notifier).set('u2:t1:a1');
    await flush(tester);
    expect(find.text('+91 98204 10001'), findsNothing);
    expect(soft.queries, hasLength(2));
    expect(soft.q(1)['agent_user_id'], 'u2');
    soft.answer(1, softPage([5]));
    await flush(tester);
    expect(find.text('+91 98204 10005'), findsOneWidget);
  });

  testWidgets('at 200% text rows keep one height and nothing overflows', (tester) async {
    await setPhoneSize(tester);
    await tester.pumpWidget(harness(const CallsScreen(), overrides(), textScale: 2));
    await flush(tester);
    await showSoftphone(tester);
    soft.answer(0, softRows([softRow(1), softRow(2, over: {'dnc_overridden': true, 'hours_overridden': true})]));
    await flush(tester);
    expect(tester.takeException(), isNull);
    expect(
      tester.getSize(find.byKey(const ValueKey('mc-1'))).height,
      tester.getSize(find.byKey(const ValueKey('mc-2'))).height,
    );
  });

  group('the detail, as label and value', () {
    Map<String, String> facts(List<SoftphoneDetailSection> sections, String title) => {
          for (final f in sections.firstWhere((s) => s.title == title).facts) f.label: f.value,
        };

    test('the no-media copy follows call_availability', () {
      expect(softphoneNoMediaCopy(CallAvailability.available)!.title, 'The recording and analysis are available to supervisors');
      expect(softphoneNoMediaCopy(CallAvailability.neverPlaced)!.title, 'No call was placed');
      expect(softphoneNoMediaCopy(CallAvailability.purged)!.title, 'This call’s recording and transcript are no longer available');
      expect(softphoneNoMediaCopy(CallAvailability.unknown), isNull);
    });

    test('who saved the outcome, with the on-behalf marker', () {
      final own = manualCall({'dispositioned_at': '2026-10-30T10:05:00.000Z'});
      final behalf = manualCall({'dispositioned_at': '2026-10-30T10:05:00.000Z', 'dispositioned_on_behalf': true});
      expect(softphoneSavedByLine(own, 'Asha Rao'), endsWith(' · by Asha Rao'));
      expect(softphoneSavedByLine(behalf, 'Priya Sharma'), endsWith(' · by Priya Sharma, on the agent’s behalf'));
      expect(softphoneSavedByLine(behalf, null), endsWith(' · by a supervisor, on the agent’s behalf'));
      expect(softphoneSavedByLine(manualCall(), 'Asha Rao'), isNull);
    });

    test('the outcome in its catalog\'s words; call details by the field set, a removed key in words', () {
      final detail = softDetail(call: {
        'fields': {'customer_name': 'Rahul Verma', 'follow_up': true, 'old_key': 'kept'},
        'notes': 'Wants the new rate.',
      });
      final sections = softphoneCallDetailSections(detail, bootstrap());
      expect(facts(sections, 'Outcome')['Outcome'], 'Interested, renewing');
      expect(facts(sections, 'Outcome')['Notes'], 'Wants the new rate.');
      expect(facts(sections, 'Call details'), {
        'Customer name': 'Rahul Verma',
        'Reason for call': 'Not filled in',
        'Follow-up needed': 'Yes',
        'old key': 'kept',
      });
      expect(facts(sections, 'Call record')['Logged to'], 'Home Loan Renewals');

      // Without the bootstrap a code and a key read as themselves.
      final bare = softphoneCallDetailSections(detail, null);
      expect(facts(bare, 'Outcome')['Outcome'], 'interested');
      expect(facts(bare, 'Call details')['customer name'], 'Rahul Verma');
    });

    test('override notes, with the DNC entry as the agent saw it', () {
      final detail = softDetail(overrides: {
        'dnc_note': 'Customer asked us to call back.',
        'dnc_entry_id': 'dnc-1',
        'dnc_entry': {
          'id': 'dnc-1',
          'scope': 'campaign',
          'reason': 'Asked not to be called',
          'created_at': '2026-10-01T06:00:00.000Z',
          'campaign_id': 'camp-1',
        },
        'hours_note': 'Agreed time with the customer.',
      });
      final o = facts(softphoneCallDetailSections(detail, bootstrap()), 'Overrides');
      expect(o['Called through Do Not Call'], 'Customer asked us to call back.');
      expect(o['Listed for'], 'The campaign Home Loan Renewals');
      expect(o['Reason'], 'Asked not to be called');
      expect(o['Called outside calling hours'], 'Agreed time with the customer.');

      final removed = softDetail(overrides: {'dnc_note': 'x', 'dnc_entry_id': 'dnc-9'});
      expect(facts(softphoneCallDetailSections(removed, null), 'Overrides')['DNC entry'], 'Removed from the list since this call');
      expect(softphoneCallDetailSections(softDetail(), null).any((s) => s.title == 'Overrides'), isFalse);
    });

    test('the roster contact, its columns by the campaign\'s display, and its earlier calls', () {
      final detail = softDetail(call: {
        'contact': {
          'contact_id': 'k-1',
          'state': 'completed',
          'claimed': true,
          'context': {'Loan account': 'HL-4471', 'Name': 'Rahul Verma', 'City': '-'},
          'prior_attempts': [
            {
              'attempt_number': 1,
              'outcome': 'no_answer',
              'disposition_code': null,
              'notes': null,
              'ended_at': '2026-10-20T05:00:00.000Z',
              'campaign_id': 'camp-1',
              'campaign_name': 'Home Loan Renewals',
              'dialed_at': '2026-10-20T04:59:00.000Z',
            },
          ],
        },
      });
      final sections = softphoneCallDetailSections(detail, bootstrap());
      final contact = sections.firstWhere((s) => s.title == 'Roster contact').facts;
      expect(contact.map((f) => f.label), ['Now', 'This call', 'Name', 'Loan account']); // hero order; '-' left out
      expect(contact.first.value, 'Completed');
      expect(contact[1].value, 'Settled the contact with its outcome');
      final earlier = sections.firstWhere((s) => s.title == 'Earlier calls').facts;
      expect(earlier.single.value, 'No answer');
    });
  });

  test('the row view: the outcome kinds and the override badges', () {
    final now = DateTime.utc(2026, 10, 30, 12);
    final live = SoftphoneCallRowView(softRow(1, over: {'state': 'ringing', 'disposition_code': null, 'settled_at': null}), catalog: null, now: now);
    expect(live.outcome, 'On a call now');
    expect(live.unsettled, isTrue);
    final badges = SoftphoneCallRowView(softRow(2, over: {'dnc_overridden': true}), catalog: null, now: now);
    expect(badges.detail, 'Logged to Home Loan Renewals · DNC override');
    expect(badges.unsettled, isFalse);
  });
}
