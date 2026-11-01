import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/auth/fake_auth_service.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/features/campaigns/assignment_entry.dart';
import 'package:magick_agency_agent/features/campaigns/campaigns_screen.dart';
import 'package:magick_agency_agent/ui/primitives.dart';

import '../../core/auth/support/harness.dart';

Map<String, Object?> assignment(String id, String? name, String? status) =>
    {'campaign_id': id, 'campaign_name': name, 'campaign_status': status, 'assigned_at': '2026-10-01T10:00:00.000Z'};

void main() {
  late Harness h;

  Future<ProviderContainer> started(WidgetTester tester) async {
    final c = ProviderContainer.test(overrides: h.overrides);
    await tester.runAsync(() => startGate(c));
    expect(c.read(appGateProvider), isA<GateReady>());
    return c;
  }

  void assignments(List<Map<String, Object?>> list) =>
      h.server.json('GET', '/proxy/agency/my-assignments', {'assignments': list});

  setUp(() => h = Harness(auth: FakeAuthService(signedIn: meera)));

  testWidgets('mock 4: names, status pills, the console\'s notes, Enter or Closed', (tester) async {
    assignments([
      assignment('c1', 'Q4 Card Renewals', 'running'),
      assignment('c2', 'Personal Loan Top-up', 'paused'),
      assignment('c3', 'Diwali Offers', 'completed'),
    ]);
    final c = await started(tester);
    await pumpScreen(tester, c, const CampaignsScreen());
    expect(find.text('My campaigns'), findsOneWidget);
    expect(find.text('Acme Collections · Chennai'), findsOneWidget);
    expect(find.text('Running'), findsOneWidget);
    expect(find.text('Paused right now. You can wait at the station for it to resume.'), findsOneWidget);
    expect(find.text('Completed'), findsOneWidget);
    expect(find.text('Finished — every contact has been dialled.'), findsOneWidget);
    expect(find.text('Enter station'), findsNWidgets(2));
    expect(find.text('Closed'), findsOneWidget);
    expect(find.text('You can be on one campaign at a time.'), findsOneWidget);
  });

  testWidgets('the request is scoped to the account', (tester) async {
    assignments([]);
    final c = await started(tester);
    await pumpScreen(tester, c, const CampaignsScreen());
    final req = h.server.calls('GET', '/proxy/agency/my-assignments').single;
    expect(req.headers['x-tenant-id'], 't1');
    expect(req.headers['x-account-id'], 'a1');
  });

  testWidgets('Enter station opens pre-flight with the campaign name', (tester) async {
    assignments([assignment('c1', 'Q4 Card Renewals', 'running')]);
    final c = await started(tester);
    await pumpScreen(tester, c, const CampaignsScreen());
    await tapVisible(tester, find.text('Enter station'));
    await tester.pumpAndSettle();
    expect(find.text('at /preflight/c1?campaignName=Q4+Card+Renewals'), findsOneWidget);
  });

  testWidgets('empty: not assigned yet', (tester) async {
    assignments([]);
    final c = await started(tester);
    await pumpScreen(tester, c, const CampaignsScreen());
    expect(find.text('You’re not assigned to a campaign yet'), findsOneWidget);
    expect(find.text('Ask your supervisor to add you to one.'), findsOneWidget);
  });

  testWidgets('error, then Try again', (tester) async {
    h.server.offline('GET', '/proxy/agency/my-assignments');
    final c = await started(tester);
    await pumpScreen(tester, c, const CampaignsScreen());
    expect(find.text('We couldn’t check your campaigns'), findsOneWidget);
    assignments([assignment('c1', 'Q4 Card Renewals', 'running')]);
    await tapVisible(tester, find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Q4 Card Renewals'), findsOneWidget);
  });

  testWidgets('pull to refresh reads the list again', (tester) async {
    assignments([assignment('c1', 'Q4 Card Renewals', 'running')]);
    final c = await started(tester);
    await pumpScreen(tester, c, const CampaignsScreen());
    assignments([assignment('c1', 'Q4 Card Renewals', 'running'), assignment('c2', 'Gold Loans', 'draft')]);
    await tester.fling(find.text('My campaigns'), const Offset(0, 400), 1000);
    await tester.pumpAndSettle();
    expect(h.server.calls('GET', '/proxy/agency/my-assignments'), hasLength(2));
    expect(find.text('Gold Loans'), findsOneWidget);
  });

  testWidgets('on duty: a way back to the station instead of a second one', (tester) async {
    assignments([assignment('c1', 'Q4 Card Renewals', 'running'), assignment('c2', 'Gold Loans', 'running')]);
    final c = await started(tester);
    c.read(testSignalsProvider.notifier).set(const StationSignals(onDuty: true, campaignId: 'c1'));
    await pumpScreen(tester, c, const CampaignsScreen());
    expect(find.text('You’re on duty on Q4 Card Renewals'), findsOneWidget);
    expect(find.text('Enter station'), findsNothing);
    expect(find.text('Back to your station'), findsNWidgets(2)); // banner + its own row
    await tapVisible(tester, find.text('Back to your station').first);
    await tester.pumpAndSettle();
    expect(find.text('at /home/station/c1'), findsOneWidget);
  });

  testWidgets('another agent signing in on this phone never sees the previous agent\'s list', (tester) async {
    assignments([assignment('c1', 'Q4 Card Renewals', 'running')]);
    final c = await started(tester);
    await pumpScreen(tester, c, const CampaignsScreen());
    expect(find.text('Q4 Card Renewals'), findsOneWidget);

    // Signed out: the shell (and this screen) leave the tree.
    await tester.pumpWidget(UncontrolledProviderScope(container: c, child: const SizedBox()));
    await tester.runAsync(() => c.read(appGateProvider.notifier).signOut());
    expect(c.read(appGateProvider), const GateSignedOut());

    // Ravi signs in to the same account; his list is still on its way.
    final ravisList = Completer<http.Response>();
    h.server.on('GET', '/proxy/agency/my-assignments', (_) => ravisList.future);
    h.server.json('POST', '/auth/session', sessionJson(
      user: userJson(id: 'u2', email: 'ravi.s@acmecollect.in', name: 'Ravi S'),
      tenants: [tenantJson('t1', 'Acme Collections')],
      memberships: [membershipJson('t1', accountId: 'a1')],
    ));
    h.auth.addPasswordAccount('ravi.s@acmecollect.in', 'pw-123456', uid: 'fb-u2');
    await tester.runAsync(() => c.read(appGateProvider.notifier).signInWithEmail('ravi.s@acmecollect.in', 'pw-123456'));
    expect(c.read(appGateProvider), isA<GateReady>().having((g) => g.userId, 'user', 'u2'));

    // Its first frame (no settling: the scripted request would time out).
    await tester.pumpWidget(UncontrolledProviderScope(
      container: c,
      child: MaterialApp(theme: buildTheme(AppTokens.dark, Brightness.dark), home: const CampaignsScreen()),
    ));
    expect(find.text('Q4 Card Renewals'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    ravisList.complete(jsonResponse({'assignments': [assignment('c9', 'Gold Loans', 'running')]}));
    await tester.pump();
    await tester.pump();
    expect(find.text('Gold Loans'), findsOneWidget);
    expect(find.text('Q4 Card Renewals'), findsNothing);
  });

  testWidgets('a 401 on the list signs the agent out', (tester) async {
    h.server.json('GET', '/proxy/agency/my-assignments', {'error': 'Unauthorized'}, status: 401);
    final c = await started(tester);
    await pumpScreen(tester, c, const CampaignsScreen());
    await tester.pumpAndSettle();
    expect(c.read(appGateProvider), const GateSignedOut(notice: sessionExpiredNotice));
  });

  group('assignmentEntry', () {
    Assignment a(String? status, {String? name = 'X'}) =>
        Assignment(campaignId: 'c', campaignName: name, campaignStatusRaw: status, assignedAt: DateTime.utc(2026));

    test('only stopped and completed close the way in', () {
      for (final s in ['running', 'draft', 'paused', 'stopping']) {
        expect(assignmentEntry(a(s)).canEnter, isTrue, reason: s);
      }
      expect(assignmentEntry(a('stopped')), const AssignmentEntry(
        canEnter: false, note: 'Ended by a supervisor. It won’t start again.', label: 'Stopped', tone: Tone.neutral));
      expect(assignmentEntry(a('completed')).canEnter, isFalse);
    });

    test('an unknown or missing status never blocks; an unknown one shows as itself', () {
      expect(assignmentEntry(a(null)), const AssignmentEntry(canEnter: true, note: null, label: null, tone: Tone.neutral));
      expect(assignmentEntry(a('archived')), const AssignmentEntry(canEnter: true, note: null, label: 'archived', tone: Tone.neutral));
    });

    test('tones: running ok, paused/stopping warn', () {
      expect(assignmentEntry(a('running')).tone, Tone.ok);
      expect(assignmentEntry(a('paused')).tone, Tone.warn);
      expect(assignmentEntry(a('stopping')).tone, Tone.warn);
    });

    test('an unnamed campaign is named as such', () {
      expect(campaignDisplayName(a('running', name: null)), 'Unnamed campaign');
      expect(campaignDisplayName(a('running', name: '  ')), 'Unnamed campaign');
    });
  });
}
