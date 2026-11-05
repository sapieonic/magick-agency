import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/features/performance/logic/bucket_series.dart';
import 'package:magick_agency_agent/features/performance/logic/performance_view.dart';
import 'package:magick_agency_agent/features/performance/logic/stats_windows.dart';
import 'package:magick_agency_agent/features/performance/performance_controller.dart';

import 'support.dart';

void main() {
  late FakePerformanceApi api;
  late ProviderContainer container;

  PerformanceController controller() => container.read(performanceControllerProvider.notifier);
  PerformanceState state() => container.read(performanceControllerProvider);

  final weekStats = stats(
    from: DateTime.utc(2026, 10, 11, 18, 30),
    to: fixedNow,
    buckets: [bucket('2026-10-12', 40, 12), bucket('2026-10-13', 50, 20), bucket('2026-10-14', 52, 22)],
  );
  final todayStats = stats(from: DateTime.utc(2026, 10, 13, 18, 30), to: fixedNow, t: totals(attempts: 52));

  setUp(() {
    api = FakePerformanceApi();
    container = ProviderContainer(overrides: perfOverrides(api));
    addTearDown(container.dispose);
  });

  test('one read per selection: the window is cut on the reader\'s calendar, by day', () async {
    final done = controller().revalidate();
    expect(state().current.firstLoad, isTrue);
    expect(state().current.loading, isTrue);
    final q = api.statsQueries.single;
    expect(q.toQuery(), {
      'from': '2026-10-13T18:30:00.000Z', // 14 Oct 00:00 IST
      'to': '2026-10-14T05:00:00.000Z',
      'bucket': 'day',
    });
    api.answer(0, todayStats);
    await done;
    expect(state().current, StatsSlot(stats: todayStats));
  });

  test('stale-while-revalidate: a cached window shows at once and refreshes behind it', () async {
    final first = controller().revalidate();
    api.answer(0, todayStats);
    await first;

    final toWeek = controller().selectWindow(StatsWindow.week);
    expect(state().window, StatsWindow.week);
    expect(state().current.firstLoad, isTrue);
    expect(api.statsQueries.last.from, DateTime.utc(2026, 10, 11, 18, 30)); // Monday 00:00 IST
    api.answer(1, weekStats);
    await toWeek;

    // Back to Today: the old answer is on screen while the new read runs.
    final back = controller().selectWindow(StatsWindow.today);
    expect(state().current.stats, todayStats);
    expect(state().current.refreshing, isTrue);
    final fresher = stats(from: todayStats.from, to: fixedNow, t: totals(attempts: 60));
    api.answer(2, fresher);
    await back;
    expect(state().current.stats, fresher);
    expect(state().current.refreshing, isFalse);
  });

  test('a failed refresh keeps the last good answer and says why', () async {
    final first = controller().revalidate();
    api.answer(0, todayStats);
    await first;
    final again = controller().revalidate();
    api.fail(1);
    await again;
    expect(state().current.stats, todayStats);
    expect(state().current.error, contains('offline'));
    expect(state().current.loading, isFalse);
  });

  test('a failed first read is an error with nothing stale to show; retry clears it', () async {
    final first = controller().revalidate();
    api.fail(0);
    await first;
    expect(state().current.stats, isNull);
    expect(state().current.firstLoad, isFalse);
    expect(state().current.error, isNotNull);

    final retry = controller().revalidate();
    api.answer(1, todayStats);
    await retry;
    expect(state().current, StatsSlot(stats: todayStats));
  });

  test('an older answer landing after a newer request is dropped', () async {
    final a = controller().revalidate();
    final b = controller().revalidate();
    final newer = stats(from: todayStats.from, to: fixedNow, t: totals(attempts: 99));
    api.answer(1, newer);
    await b;
    api.answer(0, todayStats);
    await a;
    expect(state().current.stats, newer);
  });

  test('a campaign scope is its own selection and its own request', () async {
    final all = controller().revalidate();
    api.answer(0, todayStats);
    await all;
    final scoped = controller().selectCampaign('c1');
    expect(api.statsQueries.last.campaignId, 'c1');
    expect(api.statsQueries.last.toQuery()['campaign_id'], 'c1');
    expect(state().current.firstLoad, isTrue);
    api.answer(1, weekStats);
    await scoped;
    final cleared = controller().selectCampaign(null);
    expect(state().current.stats, todayStats); // the unscoped answer, cached
    api.answer(2, todayStats);
    await cleared;
  });

  test('a workspace switch drops the cache and the campaign scope', () async {
    final first = controller().selectCampaign('c1');
    api.answer(0, todayStats);
    await first;
    container.read(testWorkspaceProvider.notifier).set('u1:t2:a9');
    final next = controller().revalidate();
    expect(state().campaignId, isNull);
    expect(state().current.firstLoad, isTrue);
    expect(state().workspace, 'u1:t2:a9');
    expect(api.statsQueries.last.campaignId, isNull);
    api.answer(1, todayStats);
    await next;
  });

  test('another agent on the same account: the cache goes at once and a late answer for the first is dropped', () async {
    final first = controller().selectCampaign('c1');
    api.answer(0, todayStats);
    await first;
    // The first agent's unscoped read, still in flight at the switch.
    final late = controller().selectCampaign(null);
    container.read(testWorkspaceProvider.notifier).set('u2:t1:a1');
    expect(state().slots, isEmpty);
    expect(state().workspace, 'u2:t1:a1');

    // The same selection, read for the new agent: it must not take the late answer.
    final next = controller().revalidate();
    api.answer(1, weekStats);
    await late;
    expect(state().current.stats, isNull);
    api.answer(2, todayStats);
    await next;
    expect(state().current.stats, todayStats);
  });

  test('signed out: the cache is dropped and nothing is read', () async {
    final first = controller().revalidate();
    api.answer(0, todayStats);
    await first;
    container.read(testWorkspaceProvider.notifier).set(null);
    expect(state().slots, isEmpty);
    await controller().revalidate();
    expect(api.statsQueries, hasLength(1));
  });

  test('the view: tiles, readouts, caption and the floored breakdown', () {
    final s = stats(
      from: DateTime.utc(2026, 10, 11, 18, 30),
      to: fixedNow,
      buckets: [bucket('2026-10-12', 40, 12), bucket('2026-10-14', 52, 22)],
      byCampaign: const [
        AgentCampaignRow(campaignId: 'c1', attempts: 130, connected: 50, successes: 11, talkSeconds: 9000, wrapupSeconds: 0,
            humanConnects: 42, firstDials: 120, connectRatePct: 35),
        AgentCampaignRow(campaignId: 'c2', attempts: 12, connected: 4, successes: 1, talkSeconds: 1390, wrapupSeconds: 0,
            humanConnects: 3, firstDials: 12, connectRatePct: 25),
      ],
    );
    final v = buildPerformanceView(
      window: StatsWindow.week,
      stats: s,
      campaignNames: const {'c1': 'Q4 Card Renewals'},
      calendar: ist,
    );
    expect(v.tiles.map((t) => t.value), ['142', '38%', '54']);
    expect(v.conversion.secondary, '12 counted');
    expect(v.rangeCaption, '12 Oct – 14 Oct 2026 · IST (UTC+05:30)');
    expect(v.emptyLine, isNull);
    expect(v.series!.points.map((p) => p.coverage).toList(), [BucketCoverage.edge, BucketCoverage.soFar]);
    expect(v.campaigns.map((c) => (c.name, c.connectRate)).toList(), [
      // The served rate (42 of 120 first dials), not 50 / 130 = 38.5%.
      ('Q4 Card Renewals', '35%'),
      ('Campaign c2', 'Not enough calls'),
    ]);
    expect(v.campaignsWorked, '2 campaigns');
  });

  test('the view of a quiet window says so', () {
    final s = stats(from: DateTime.utc(2026, 10, 13, 18, 30), to: fixedNow, t: totals(attempts: 0, connected: 0, connectRate: null));
    final v = buildPerformanceView(window: StatsWindow.today, stats: s, campaignNames: const {}, calendar: ist);
    expect(v.emptyLine, 'No calls reached you today.');
    expect(v.tiles[1].value, 'Not measured yet');
  });

  test('a 401 is handed to the gate (which signs out), not only shown', () async {
    final done = controller().revalidate();
    api.fail(0, const ApiUnauthorized());
    await done;
    await Future<void>.delayed(Duration.zero);
    expect(state().current.error, const ApiUnauthorized().userMessage);
    expect((container.read(appGateProvider.notifier) as RecordingGate).reported, [isA<ApiUnauthorized>()]);
  });

  test('other failures are the tab\'s own to show', () async {
    final done = controller().revalidate();
    api.fail(0);
    await done;
    await Future<void>.delayed(Duration.zero);
    expect((container.read(appGateProvider.notifier) as RecordingGate).reported, isEmpty);
  });
}
