import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/features/customers/customer_history_api.dart';
import 'package:magick_agency_agent/features/customers/customer_history_screen.dart';
import 'package:magick_agency_agent/features/customers/customer_search_screen.dart';

import '../performance/support.dart';

export '../performance/support.dart';

// Test doubles for Customer history. The answers are built from wire JSON,
// the shapes `packages/contracts/fixtures/agent/customer-history.json` holds.

const searchedE164 = '+919876543210';
const searchedDisplay = '+91 98765 43210';

Map<String, Object?> campaignJson({String id = 'c1', String name = 'October dues', int generation = 0}) => {
      'id': id,
      'name': name,
      'status': 'running',
      'account_id': 'a1',
      'root_id': 'c1',
      'retry_generation': generation,
    };

/// A campaign call as an agent reads it: no call page, by default notes
/// hidden and the recording purged.
Map<String, Object?> campaignCallJson(
  int n, {
  bool notesHidden = true,
  String? notes,
  String recording = 'expired',
  String? outcome = 'connected',
}) =>
    {
      'key': 'campaign_call:a$n',
      'kind': 'campaign_call',
      'at': DateTime.utc(2026, 11, 4, 8).subtract(Duration(hours: n)).toIso8601String(),
      'account_id': 'a1',
      'attempt_id': 'a$n',
      'contact_id': 'k1',
      'campaign': campaignJson(),
      'attempt_number': n,
      'agent': {'user_id': 'u2', 'name': 'Karan Shah'},
      'outcome': outcome,
      'disposition_code': 'callback',
      'talk_seconds': 95,
      'notes': notes,
      'notes_hidden': notesHidden,
      'callback_at': null,
      'redial_of_attempt_id': null,
      'chain_attempt_id': 'a$n',
      'redial_number': 0,
      'override_applied': <String>[],
      'override_note': null,
      'recording': recording,
      'call_page': null,
    };

Map<String, Object?> softphoneCallJson(int n, {String? notes = 'Will pay on Friday'}) => {
      'key': 'softphone_call:m$n',
      'kind': 'softphone_call',
      'at': DateTime.utc(2026, 11, 5, 11).subtract(Duration(hours: n)).toIso8601String(),
      'account_id': 'a1',
      'manual_call_id': 'm$n',
      'campaign': null,
      'contact_id': null,
      'agent': {'user_id': 'u1', 'name': 'Priya Nair'},
      'outcome': 'connected',
      'disposition_code': 'ptp',
      'talk_seconds': 184,
      'notes': notes,
      'notes_hidden': false,
      'fields': null,
      'dnc_override_note': null,
      'hours_override_note': null,
      'callback_at': null,
      'recording': 'available',
      'call_page': null,
    };

Map<String, Object?> dncJson() => {
      'id': 'd1',
      'scope': 'campaign',
      'account_id': 'a1',
      'account_name': 'Collections North',
      'campaign': {'id': 'c1', 'name': 'October dues'},
      'source': 'agent',
      'reason': 'Asked not to be called',
      'added_by': 'Priya Nair',
      'created_at': '2026-10-03T10:00:00.000Z',
    };

CustomerTimelinePage timelinePage(List<Map<String, Object?>> entries, {String? next}) =>
    CustomerTimelinePage.fromJson({'entries': entries, 'next_cursor': next});

/// The search's answer. [empty] is a number nobody in the visible accounts has.
CustomerSearchResponse answer({
  String searchId = 'chs_1',
  List<Map<String, Object?>>? entries,
  String? next,
  List<Map<String, Object?>> dnc = const [],
  bool empty = false,
}) =>
    CustomerSearchResponse.fromJson({
      'search_id': searchId,
      'expires_at': '2026-11-06T10:30:00.000Z',
      'key': {'by': 'phone', 'value': searchedE164, 'display': searchedDisplay},
      'summary': {
        'contacts': empty
            ? <Object?>[]
            : [
                {
                  'contact_id': 'k1',
                  'root_contact_id': 'k1',
                  'account_id': 'a1',
                  'account_name': 'Collections North',
                  'phone_e164': searchedE164,
                  'campaign': campaignJson(),
                  'campaigns': [campaignJson()],
                  'state': 'pending',
                  'suppressed_reason': null,
                  'attempt_count': 3,
                  'fields': [
                    {'column': 'Name', 'value': 'Asha Rao'},
                    {'column': 'Loan No', 'value': 'LN-0042'},
                  ],
                  'assigned_to': {'user_id': 'u1', 'name': 'Priya Nair'},
                  'entered_at': '2026-10-01T09:00:00.000Z',
                  'upload_file_name': 'october-dues.csv',
                },
              ],
        'totals': {
          'calls': empty ? 0 : 4,
          'connected': empty ? 0 : 2,
          'last_contacted': empty
              ? null
              : {
                  'at': '2026-11-05T11:20:00.000Z',
                  'channel': 'softphone',
                  'agent': {'user_id': 'u1', 'name': 'Priya Nair'},
                  'outcome': 'connected',
                  'disposition_code': 'ptp',
                },
        },
        'dnc': dnc,
        'open': {'callbacks': <Object?>[], 'overrides': <Object?>[], 'live_calls': <Object?>[]},
        'filter_options': {
          'campaigns': <Object?>[],
          'agents': <Object?>[],
          'outcomes': <Object?>[],
          'disposition_codes': <Object?>[],
        },
      },
      'timeline': {
        'entries': empty ? <Object?>[] : (entries ?? [softphoneCallJson(1), campaignCallJson(1)]),
        'next_cursor': empty ? null : next,
      },
    });

/// A scripted `/customers/*`. Each request waits on its own completer unless
/// an automatic answer (or failure) is set.
class FakeCustomerHistoryApi implements CustomerHistoryApi {
  final List<CustomerSearchRequest> searches = [];
  final List<CustomerTimelineRequest> timelines = [];
  final List<Completer<CustomerSearchResponse>> pendingSearches = [];
  final List<Completer<CustomerTimelinePage>> pendingTimelines = [];

  CustomerSearchResponse? autoSearch;
  Object? searchError;
  CustomerTimelinePage? autoTimeline;

  @override
  Future<CustomerSearchResponse> search(CustomerSearchRequest request) {
    searches.add(request);
    final error = searchError;
    if (error != null) return Future<CustomerSearchResponse>.error(error);
    final auto = autoSearch;
    if (auto != null) return Future.value(auto);
    final c = Completer<CustomerSearchResponse>();
    pendingSearches.add(c);
    return c.future;
  }

  @override
  Future<CustomerTimelinePage> timeline(CustomerTimelineRequest request) {
    timelines.add(request);
    final auto = autoTimeline;
    if (auto != null) return Future.value(auto);
    final c = Completer<CustomerTimelinePage>();
    pendingTimelines.add(c);
    return c.future;
  }
}

List<Override> customerOverrides(FakeCustomerHistoryApi api, MemoryStore store) => [
      appGateProvider.overrideWith(RecordingGate.new),
      agentWorkspaceProvider.overrideWith((ref) => ref.watch(testWorkspaceProvider)),
      customerHistoryApiProvider.overrideWithValue(api),
      keyValueStoreProvider.overrideWithValue(store),
    ];

/// The Calls tab's customer routes, as `router.dart` nests them, at phone width
/// and tall enough that the whole history is built (the list is lazy).
Future<GoRouter> pumpCustomer(
  WidgetTester tester,
  List<Override> overrides, {
  String initial = Routes.customerSearch,
}) async {
  tester.view.physicalSize = const Size(390, 2400) * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    initialLocation: initial,
    routes: [
      GoRoute(
        path: Routes.calls,
        builder: (_, _) => const Scaffold(body: Text('My calls')),
        routes: [
          GoRoute(
            path: 'customer',
            builder: (_, _) => const CustomerSearchScreen(),
            routes: [GoRoute(path: 'results', builder: (_, _) => const CustomerHistoryScreen())],
          ),
        ],
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: overrides,
      child: MaterialApp.router(theme: buildTheme(AppTokens.dark, Brightness.dark), routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
  return router;
}
