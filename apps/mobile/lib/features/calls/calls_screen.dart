import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../ui/primitives.dart';
import '../performance/agent_workspace.dart';
import '../performance/campaign_names.dart';
import 'calls_controller.dart';
import 'logic/attempt_copy.dart';
import 'widgets/attempt_detail_sheet.dart';
import 'widgets/attempt_tile.dart';
import 'widgets/filter_bar.dart';

/// "My calls": every dial in the agent's name, newest first, across every
/// campaign, filterable by day, outcome, campaign and number. Keyset-paged:
/// the next page is fetched while the agent is still a screenful away from
/// the end, so scrolling never waits on the network.
class CallsScreen extends ConsumerStatefulWidget {
  const CallsScreen({super.key});

  /// Start fetching the next page when the list builds a row this close to
  /// the end (about two screens of rows).
  static const prefetchRows = 20;

  @override
  ConsumerState<CallsScreen> createState() => _CallsScreenState();
}

class _CallsScreenState extends ConsumerState<CallsScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (mounted) unawaited(ref.read(attemptsControllerProvider.notifier).ensureLoaded());
    });
  }

  @override
  Widget build(BuildContext context) {
    // The shell keeps this tab mounted across an account switch or a new
    // sign-in: the controller drops the old rows itself, this asks for the
    // new agent's first page.
    ref.listen<String?>(agentWorkspaceProvider, (prev, next) {
      if (next == null || next == prev) return;
      Future.microtask(() {
        if (mounted) unawaited(ref.read(attemptsControllerProvider.notifier).ensureLoaded());
      });
    });
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 64,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Semantics(header: true, child: const Text('My calls')),
            const _CountLine(),
          ],
        ),
      ),
      body: const Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AttemptsFilterBar(),
          SizedBox(height: Space.sm),
          Expanded(child: _CallsList()),
        ],
      ),
    );
  }
}

/// "Showing 50 calls — there are more", announced when it changes.
class _CountLine extends ConsumerWidget {
  const _CountLine();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final (count, more, ready) = ref.watch(
      attemptsControllerProvider.select((s) => (s.rows.length, s.hasMore, s.status == AttemptsStatus.ready)),
    );
    return Semantics(
      liveRegion: true,
      child: Text(
        ready && count > 0 ? attemptsCountLine(count, more: more) : '',
        key: const Key('attempts-count'),
        style: Theme.of(context).textTheme.labelMedium,
      ),
    );
  }
}

class _CallsList extends ConsumerStatefulWidget {
  const _CallsList();

  @override
  ConsumerState<_CallsList> createState() => _CallsListState();
}

class _CallsListState extends ConsumerState<_CallsList> {
  bool _prefetchScheduled = false;

  /// Called from the row builder: providers cannot change during a build,
  /// so the request goes out right after this frame (once per frame).
  void _maybePrefetch() {
    if (_prefetchScheduled) return;
    _prefetchScheduled = true;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      _prefetchScheduled = false;
      if (mounted) unawaited(ref.read(attemptsControllerProvider.notifier).loadMore());
    });
  }

  Future<void> _refresh() async {
    ref.invalidate(myCampaignsProvider);
    await ref.read(attemptsControllerProvider.notifier).reload(keepRows: true);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(attemptsControllerProvider);
    final names = ref.watch(campaignNamesProvider);
    final controller = ref.read(attemptsControllerProvider.notifier);
    final today = localToday(ref);
    final text = Theme.of(context).textTheme;
    final rows = state.rows;

    final List<Widget> slivers;
    switch (state.status) {
      case AttemptsStatus.loading:
        slivers = const [SliverToBoxAdapter(child: _SkeletonRows())];
      case AttemptsStatus.error:
        slivers = [
          SliverFillRemaining(
            hasScrollBody: false,
            child: LoadErrorView(
              key: const Key('attempts-error'),
              message: state.error ?? 'We couldn’t load these calls.',
              onRetry: () => unawaited(controller.reload()),
            ),
          ),
        ];
      case AttemptsStatus.ready when rows.isEmpty:
        final copy = attemptsEmptyCopy(filtered: state.filters.isFiltered);
        slivers = [
          SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              key: const Key('attempts-empty'),
              child: Padding(
                padding: const EdgeInsets.all(Space.xl),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.phone_forwarded_outlined, size: 32, color: context.tokens.textMuted),
                    const SizedBox(height: Space.md),
                    Text(copy.title, textAlign: TextAlign.center, style: text.titleMedium),
                    const SizedBox(height: Space.xs),
                    Text(copy.body, textAlign: TextAlign.center, style: text.bodySmall),
                  ],
                ),
              ),
            ),
          ),
        ];
      case AttemptsStatus.ready:
        final prototype = AttemptTile(row: _prototypeRow, campaign: 'Campaign', today: today);
        slivers = [
          if (state.error != null)
            SliverToBoxAdapter(
              child: _InlineNotice(
                key: const Key('attempts-refresh-error'),
                message: 'These may be out of date. ${state.error}',
                onRetry: () => unawaited(controller.reload(keepRows: true)),
              ),
            ),
          SliverPrototypeExtentList(
            prototypeItem: prototype,
            delegate: SliverChildBuilderDelegate(
              (context, i) {
                if (i >= rows.length - CallsScreen.prefetchRows && state.hasMore) _maybePrefetch();
                final row = rows[i];
                final campaign = attemptCampaign(row, names);
                return AttemptTile(
                  key: ValueKey(row.id),
                  row: row,
                  campaign: campaign,
                  today: today,
                  onTap: () => showAttemptDetail(context, row: row, campaign: campaign),
                );
              },
              childCount: rows.length,
            ),
          ),
          SliverToBoxAdapter(child: _ListFooter(state: state, onRetryMore: () => unawaited(controller.retryMore()))),
        ];
    }

    return RefreshIndicator(
      onRefresh: _refresh,
      child: Scrollbar(
        child: CustomScrollView(
          key: const Key('attempts-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            if (state.refreshing)
              const SliverToBoxAdapter(child: LinearProgressIndicator(key: Key('attempts-refreshing'), minHeight: 2)),
            ...slivers,
          ],
        ),
      ),
    );
  }
}

/// The shape every row is laid out by (see [AttemptTile]).
final _prototypeRow = AttemptRow(
  id: 'prototype',
  campaignId: 'prototype',
  contactId: 'prototype',
  attemptNumber: 1,
  phoneE164: '+910000000000',
  callerId: '',
  state: AttemptState.ended,
  outcome: AttemptOutcome.connected,
  dispositionCode: 'Prototype',
  notes: 'Prototype',
  dispositionedOnBehalf: false,
  talkSeconds: 0,
  createdAt: DateTime.utc(2026),
);

class _ListFooter extends StatelessWidget {
  const _ListFooter({required this.state, required this.onRetryMore});

  final AttemptsState state;
  final VoidCallback onRetryMore;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final Widget child;
    if (state.moreError != null) {
      child = _InlineNotice(key: const Key('attempts-more-error'), message: state.moreError!, onRetry: onRetryMore);
    } else if (state.hasMore) {
      // Shown only if the agent outruns the prefetch.
      child = const Padding(
        padding: EdgeInsets.all(Space.lg),
        child: Center(child: SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2))),
      );
    } else {
      child = Padding(
        padding: const EdgeInsets.all(Space.lg),
        child: Text(attemptsPrivacyNote, key: const Key('attempts-end'), textAlign: TextAlign.center, style: text.bodySmall),
      );
    }
    return Padding(padding: const EdgeInsets.only(bottom: Space.xl), child: child);
  }
}

class _InlineNotice extends StatelessWidget {
  const _InlineNotice({super.key, required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.sm),
      child: AppCard(
        color: t.warningSubtle,
        borderColor: t.warningSubtle,
        padding: const EdgeInsets.fromLTRB(Space.md, Space.xs, Space.xs, Space.xs),
        child: Row(
          children: [
            Expanded(
              child: Semantics(
                liveRegion: true,
                child: Text(message, style: Theme.of(context).textTheme.bodySmall),
              ),
            ),
            TextButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}

class _SkeletonRows extends StatelessWidget {
  const _SkeletonRows();

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    Widget bar(double w, double h) => DecoratedBox(
          decoration: BoxDecoration(color: t.bgTertiary, borderRadius: BorderRadius.circular(Radii.sm)),
          child: SizedBox(width: w, height: h),
        );
    return Semantics(
      label: 'Loading your calls',
      child: ExcludeSemantics(
        child: Column(
          key: const Key('attempts-skeleton'),
          children: [
            for (var i = 0; i < 8; i++)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.md),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [bar(150, 16), const Spacer(), bar(72, 20)]),
                    const SizedBox(height: Space.sm),
                    bar(220, 12),
                    const SizedBox(height: Space.xs),
                    bar(120, 12),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
