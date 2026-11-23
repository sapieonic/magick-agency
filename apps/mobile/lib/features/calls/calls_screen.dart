import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../app/theme/tokens.dart';
import '../../core/softphone/softphone_view.dart';
import '../../ui/primitives.dart';
import '../customers/customer_history_copy.dart' show CustomerHistoryCopy;
import '../missed/call_back.dart';
import '../missed/missed_access.dart';
import '../missed/missed_calls_copy.dart';
import '../missed/missed_calls_list.dart';
import '../performance/agent_workspace.dart';
import '../performance/performance_controller.dart' show statsClockProvider;
import 'my_calls_controller.dart';
import 'my_calls_copy.dart';
import 'widgets/my_call_card.dart';

/// "My calls": every call the agent made or took, as one list of cards,
/// newest first (`docs/call-log.md` §7, CL9). The type is a chip over the
/// list and a line on each card; answered inbound calls are in it.
///
/// **To follow up** is the first chip: the missed calls that are the agent's
/// to ring back (Call back, Mark handled), then the callbacks they booked
/// that are due today or late. It carries what the agent still owes as a
/// badge. Under it, the Missed calls list is one tap away (the team's
/// unassigned calls to claim, voicemails, the handled ones).
///
/// The Soft phone chip shows where the Phone tab shows, and the Inbound and
/// To follow up chips where Missed calls show ([missedCallsAccessProvider]),
/// or whenever the agent owes somebody a call.
class CallsScreen extends ConsumerStatefulWidget {
  const CallsScreen({super.key});

  /// Start fetching the next page when the list builds a card this close to
  /// the end.
  static const prefetchRows = 20;

  @override
  ConsumerState<CallsScreen> createState() => _CallsScreenState();
}

class _CallsScreenState extends ConsumerState<CallsScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (mounted) unawaited(ref.read(myCallsControllerProvider.notifier).ensureLoaded());
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
        if (mounted) unawaited(ref.read(myCallsControllerProvider.notifier).ensureLoaded());
      });
    });
    final softphone = ref.watch(softphoneAvailabilityProvider.select((a) => a.visible));
    final missed = ref.watch(missedCallsAccessProvider);
    final (type, owed) = ref.watch(myCallsControllerProvider.select((s) => (s.type, s.counts?.toFollowUp ?? 0)));
    final chips = [
      if (missed.visible || owed > 0 || type == MyCallsTypeFilter.toFollowUp) MyCallsTypeFilter.toFollowUp,
      MyCallsTypeFilter.all,
      MyCallsTypeFilter.dialler,
      if (softphone || type == MyCallsTypeFilter.softPhone) MyCallsTypeFilter.softPhone,
      if (missed.visible || type == MyCallsTypeFilter.inbound) MyCallsTypeFilter.inbound,
    ];
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 64,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Semantics(header: true, child: const Text(MyCallsCopy.title)),
            const _CountLine(),
          ],
        ),
        actions: [
          // Customer history: every interaction with one number, across the
          // campaigns and the soft phone (the number goes in the screen's box,
          // never in the route).
          IconButton(
            key: const Key('customer-search-open'),
            tooltip: CustomerHistoryCopy.openSearch,
            icon: const Icon(Icons.manage_search),
            onPressed: () => unawaited(context.push<void>(Routes.customerSearch)),
          ),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Wrapped, not scrolled: every chip is on screen, on a second line at large text.
          Padding(
            padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.sm),
            child: Wrap(
              key: const Key('calls-chips'),
              spacing: Space.xs,
              runSpacing: Space.xs,
              children: [
                for (final chip in chips)
                  _TypeChip(
                    type: chip,
                    selected: chip == type,
                    owed: chip == MyCallsTypeFilter.toFollowUp ? owed : 0,
                    onSelected: () => unawaited(ref.read(myCallsControllerProvider.notifier).choose(chip)),
                  ),
              ],
            ),
          ),
          const Expanded(child: _MyCallsList()),
        ],
      ),
    );
  }
}

/// One chip. To follow up is in the warning colour and carries what the agent
/// still owes ("To follow up 3"), as the Missed badge did on its segment.
class _TypeChip extends StatelessWidget {
  const _TypeChip({required this.type, required this.selected, required this.owed, required this.onSelected});

  final MyCallsTypeFilter type;
  final bool selected;
  final int owed;
  final VoidCallback onSelected;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final warn = type == MyCallsTypeFilter.toFollowUp;
    final label = MyCallsCopy.chip(type);
    return Semantics(
      label: owed > 0 ? '$label, $owed' : label,
      selected: selected,
      button: true,
      excludeSemantics: true,
      child: ChoiceChip(
        key: Key('calls-chip-${type.wire}'),
        selected: selected,
        showCheckmark: false,
        // Five chips across a 360 dp phone, as the segments were.
        visualDensity: VisualDensity.compact,
        labelPadding: const EdgeInsets.symmetric(horizontal: 2),
        padding: const EdgeInsets.symmetric(horizontal: Space.xs),
        onSelected: (_) => onSelected(),
        side: warn ? BorderSide(color: t.warning) : null,
        backgroundColor: warn ? t.warningSubtle : null,
        label: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis)),
            if (owed > 0) ...[
              const SizedBox(width: Space.xs),
              Badge(
                key: const Key('calls-follow-up-badge'),
                label: Text(owed > 99 ? '99+' : '$owed'),
                backgroundColor: t.warning,
              ),
            ],
          ],
        ),
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
      myCallsControllerProvider.select((s) => (s.rows.length, s.hasMore, s.status == MyCallsStatus.ready)),
    );
    return Semantics(
      liveRegion: true,
      child: Text(
        ready && count > 0 ? MyCallsCopy.countLine(count, more: more) : '',
        key: const Key('calls-count'),
        style: Theme.of(context).textTheme.labelMedium,
      ),
    );
  }
}

class _MyCallsList extends ConsumerStatefulWidget {
  const _MyCallsList();

  @override
  ConsumerState<_MyCallsList> createState() => _MyCallsListState();
}

class _MyCallsListState extends ConsumerState<_MyCallsList> {
  bool _prefetchScheduled = false;

  /// The card whose Call back is reading the number for the pad.
  String? _opening;

  /// Called from the card builder: providers cannot change during a build,
  /// so the request goes out right after this frame (once per frame).
  void _maybePrefetch() {
    if (_prefetchScheduled) return;
    _prefetchScheduled = true;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      _prefetchScheduled = false;
      if (mounted) unawaited(ref.read(myCallsControllerProvider.notifier).loadMore());
    });
  }

  /// Call back: the Missed row is read for its number (never in this list
  /// where the campaign hides numbers), then handed to the soft phone exactly
  /// as the Missed list's own Call back does. Nothing is dialled.
  Future<void> _callBack(MyCallRow row) async {
    if (_opening != null) return;
    setState(() => _opening = row.id);
    final call = await ref.read(myCallsControllerProvider.notifier).missedCallFor(row);
    if (!mounted) return;
    setState(() => _opening = null);
    if (call != null) await startCallBack(context, call);
  }

  void _openMissedList() {
    unawaited(Navigator.of(context).push<void>(MaterialPageRoute(
      builder: (_) => Scaffold(
        appBar: AppBar(title: const Text(MissedCopy.title)),
        body: const MissedCallsList(),
      ),
    )));
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(myCallsControllerProvider);
    final controller = ref.read(myCallsControllerProvider.notifier);
    final canCallBack = callBackOffered(ref.watch(softphoneAvailabilityProvider));
    final missed = ref.watch(missedCallsAccessProvider);
    final now = ref.watch(statsClockProvider)();
    final text = Theme.of(context).textTheme;
    final rows = state.rows;
    final toFollowUp = state.type == MyCallsTypeFilter.toFollowUp;
    final missedLink = toFollowUp && missed.visible
        ? SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.sm),
              child: Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  key: const Key('calls-open-missed-list'),
                  onPressed: _openMissedList,
                  child: const Text(MyCallsCopy.openMissedList),
                ),
              ),
            ),
          )
        : null;

    final List<Widget> slivers;
    switch (state.status) {
      case MyCallsStatus.loading:
        slivers = const [SliverToBoxAdapter(child: _SkeletonCards())];
      case MyCallsStatus.error:
        slivers = [
          SliverFillRemaining(
            hasScrollBody: false,
            child: LoadErrorView(
              key: const Key('calls-error'),
              message: state.error ?? MyCallsCopy.loadFailed,
              onRetry: () => unawaited(controller.reload()),
            ),
          ),
        ];
      case MyCallsStatus.ready when state.isEmpty:
        final copy = MyCallsCopy.empty(state.type);
        slivers = [
          SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              key: const Key('calls-empty'),
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
                    if (toFollowUp && missed.visible) ...[
                      const SizedBox(height: Space.md),
                      TextButton(
                        key: const Key('calls-open-missed-list'),
                        onPressed: _openMissedList,
                        child: const Text(MyCallsCopy.openMissedList),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ];
      case MyCallsStatus.ready:
        slivers = [
          if (state.error != null)
            SliverToBoxAdapter(
              child: _InlineNotice(
                key: const Key('calls-refresh-error'),
                message: 'These may be out of date. ${state.error}',
                onRetry: () => unawaited(controller.reload(keepRows: true)),
              ),
            ),
          SliverList(
            delegate: SliverChildBuilderDelegate(
              (context, i) {
                if (i >= rows.length - CallsScreen.prefetchRows && state.hasMore) _maybePrefetch();
                final row = rows[i];
                final busy = state.marking != null || _opening != null;
                return MyCallCard(
                  key: ValueKey('${row.typeRaw}:${row.id}'),
                  row: row,
                  now: now,
                  callBackOffered: canCallBack,
                  onCallBack: busy ? null : () => unawaited(_callBack(row)),
                  onMarkHandled: busy ? null : () => unawaited(controller.markHandled(row)),
                  marking: state.marking == row.id,
                  opening: _opening == row.id,
                  error: state.rowError?.id == row.id ? state.rowError!.message : null,
                );
              },
              childCount: rows.length,
            ),
          ),
          if (toFollowUp && state.callbacks.isNotEmpty) ...[
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, Space.sm),
                child: Semantics(
                  header: true,
                  child: Text(MyCallsCopy.callbacksHeading, key: const Key('calls-callbacks-heading'), style: text.titleSmall),
                ),
              ),
            ),
            SliverList(
              delegate: SliverChildBuilderDelegate(
                (context, i) => CallbackDueCard(callback: state.callbacks[i], now: now),
                childCount: state.callbacks.length,
              ),
            ),
          ],
          ?missedLink,
          SliverToBoxAdapter(child: _ListFooter(state: state, onRetryMore: () => unawaited(controller.retryMore()))),
        ];
    }

    return RefreshIndicator(
      onRefresh: () => controller.reload(keepRows: true),
      child: Scrollbar(
        child: CustomScrollView(
          key: const Key('calls-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            if (state.refreshing)
              const SliverToBoxAdapter(child: LinearProgressIndicator(key: Key('calls-refreshing'), minHeight: 2)),
            ...slivers,
          ],
        ),
      ),
    );
  }
}

class _ListFooter extends StatelessWidget {
  const _ListFooter({required this.state, required this.onRetryMore});

  final MyCallsState state;
  final VoidCallback onRetryMore;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final Widget child;
    if (state.moreError != null) {
      child = _InlineNotice(key: const Key('calls-more-error'), message: state.moreError!, onRetry: onRetryMore);
    } else if (state.hasMore) {
      // Shown only if the agent outruns the prefetch.
      child = const Padding(
        padding: EdgeInsets.all(Space.lg),
        child: Center(child: SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2))),
      );
    } else {
      child = Padding(
        padding: const EdgeInsets.all(Space.lg),
        child: Text(MyCallsCopy.endNote, key: const Key('calls-end'), textAlign: TextAlign.center, style: text.bodySmall),
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

class _SkeletonCards extends StatelessWidget {
  const _SkeletonCards();

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    Widget bar(double w, double h) => DecoratedBox(
          decoration: BoxDecoration(color: t.bgTertiary, borderRadius: BorderRadius.circular(Radii.sm)),
          child: SizedBox(width: w, height: h),
        );
    return Semantics(
      label: MyCallsCopy.loading,
      child: ExcludeSemantics(
        child: Column(
          key: const Key('calls-skeleton'),
          children: [
            for (var i = 0; i < 6; i++)
              Padding(
                padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.sm),
                child: AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(children: [bar(110, 12), const Spacer(), bar(56, 12)]),
                      const SizedBox(height: Space.sm),
                      bar(170, 16),
                      const SizedBox(height: Space.xs),
                      bar(230, 12),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
