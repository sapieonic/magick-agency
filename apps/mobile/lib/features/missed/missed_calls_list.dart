import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../core/softphone/softphone_view.dart';
import '../../ui/primitives.dart';
import '../calls/softphone/softphone_calls_controller.dart' show workspaceUserId;
import '../performance/agent_workspace.dart';
import 'call_back.dart';
import 'missed_access.dart';
import 'missed_call_tile.dart';
import 'missed_calls_controller.dart';
import 'missed_calls_copy.dart';
import 'missed_count_controller.dart' show missedClockProvider;

/// "Missed calls", a segment of My calls (and, on duty on a campaign, the
/// station's sheet: `missed_on_duty.dart`): the status tabs and the reason
/// filter, the notices, then the agent's rows ([MissedCallTile]), with pull
/// to refresh and the next page fetched before the end.
class MissedCallsList extends ConsumerStatefulWidget {
  const MissedCallsList({super.key, this.onLeave});

  /// Runs before Call back moves the app (the on-duty sheet closes itself with it).
  final VoidCallback? onLeave;

  /// Start fetching the next page this many rows before the end.
  static const prefetchRows = 10;

  @override
  ConsumerState<MissedCallsList> createState() => _MissedCallsListState();
}

class _MissedCallsListState extends ConsumerState<MissedCallsList> {
  bool _prefetchScheduled = false;

  /// Whether this list is on screen: the shell keeps My calls alive in an
  /// indexed stack and turns its tickers off while another tab is in front.
  ValueListenable<TickerModeData>? _onScreen;
  bool _wasOnScreen = true;

  @override
  void initState() {
    super.initState();
    // Built when the segment is picked: entered.
    Future.microtask(_entered);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final onScreen = TickerMode.getValuesNotifier(context);
    if (identical(onScreen, _onScreen)) return;
    _onScreen?.removeListener(_onScreenChanged);
    _onScreen = onScreen..addListener(_onScreenChanged);
    _wasOnScreen = onScreen.value.enabled;
  }

  @override
  void dispose() {
    _onScreen?.removeListener(_onScreenChanged);
    super.dispose();
  }

  /// The My calls tab came back to the front with this segment picked.
  void _onScreenChanged() {
    final now = _onScreen?.value.enabled ?? false;
    final back = now && !_wasOnScreen;
    _wasOnScreen = now;
    // Told while the tree builds: the read starts after it.
    if (back) Future.microtask(_entered);
  }

  void _entered() {
    if (mounted) unawaited(ref.read(missedCallsControllerProvider.notifier).entered());
  }

  void _maybePrefetch() {
    if (_prefetchScheduled) return;
    _prefetchScheduled = true;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      _prefetchScheduled = false;
      if (mounted) unawaited(ref.read(missedCallsControllerProvider.notifier).loadMore());
    });
  }

  void _announce(String message) {
    if (!mounted) return;
    unawaited(SemanticsService.sendAnnouncement(View.of(context), message, Directionality.of(context)));
  }

  Future<void> _markHandled(InboundMissedCall call) async {
    final result = await ref.read(missedCallsControllerProvider.notifier).markHandled(call);
    if (result.ok) _announce(result.message);
  }

  Future<void> _reopen(InboundMissedCall call) async {
    final result = await ref.read(missedCallsControllerProvider.notifier).reopen(call);
    if (result.ok) _announce(result.message);
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<String?>(agentWorkspaceProvider, (prev, next) {
      if (next == null || next == prev) return;
      Future.microtask(() {
        if (mounted) unawaited(ref.read(missedCallsControllerProvider.notifier).ensureLoaded());
      });
    });
    final state = ref.watch(missedCallsControllerProvider);
    final controller = ref.read(missedCallsControllerProvider.notifier);
    final inboundOn = ref.watch(missedCallsAccessProvider.select((a) => a.inboundOn));
    final offered = callBackOffered(ref.watch(softphoneAvailabilityProvider));
    final userId = workspaceUserId(ref.watch(agentWorkspaceProvider));
    final now = ref.watch(missedClockProvider)();
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final filters = state.filters;
    final rows = state.rows;

    final header = <Widget>[
      _Filters(filters: filters, onChanged: (f) => unawaited(controller.applyFilters(f))),
      if (!inboundOn) const _Notice(key: Key('missed-inbound-off'), message: MissedCopy.inboundOff),
      if (filters.open && !offered) const _Notice(key: Key('missed-no-softphone'), message: MissedCopy.noSoftphone),
    ];

    final List<Widget> body;
    switch (state.status) {
      case MissedListStatus.loading:
        body = [
          SliverToBoxAdapter(
            child: Semantics(
              label: MissedCopy.loading,
              child: const Padding(
                key: Key('missed-loading'),
                padding: EdgeInsets.all(Space.xl),
                child: Center(child: SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2))),
              ),
            ),
          ),
        ];
      case MissedListStatus.error:
        body = [
          SliverFillRemaining(
            hasScrollBody: false,
            child: LoadErrorView(
              key: const Key('missed-error'),
              message: state.error ?? MissedCopy.loadFailed,
              onRetry: () => unawaited(controller.reload()),
            ),
          ),
        ];
      case MissedListStatus.ready when rows.isEmpty:
        body = [
          SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              key: const Key('missed-empty'),
              child: Padding(
                padding: const EdgeInsets.all(Space.xl),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.phone_missed_outlined, size: 32, color: t.textMuted),
                    const SizedBox(height: Space.md),
                    Text(
                      MissedCopy.emptyTitle(open: filters.open, filtered: filters.isFiltered),
                      textAlign: TextAlign.center,
                      style: text.titleMedium,
                    ),
                    const SizedBox(height: Space.xs),
                    Text(
                      MissedCopy.emptyBody(open: filters.open, filtered: filters.isFiltered),
                      textAlign: TextAlign.center,
                      style: text.bodySmall,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ];
      case MissedListStatus.ready:
        body = [
          if (state.error != null)
            SliverToBoxAdapter(
              child: _Notice(
                key: const Key('missed-refresh-error'),
                message: 'These may be out of date. ${state.error}',
                onRetry: () => unawaited(controller.reload(keepRows: true)),
              ),
            ),
          SliverList.builder(
            itemCount: rows.length,
            itemBuilder: (context, i) {
              if (i >= rows.length - MissedCallsList.prefetchRows && state.hasMore) _maybePrefetch();
              final call = rows[i];
              final error = state.rowError;
              return MissedCallTile(
                key: ValueKey(call.id),
                call: call,
                now: now,
                userId: userId,
                callBackOffered: offered,
                onCallBack: () => unawaited(startCallBack(context, call, onLeave: widget.onLeave)),
                onMarkHandled: state.marking == null ? () => unawaited(_markHandled(call)) : null,
                onReopen: state.reopening == null ? () => unawaited(_reopen(call)) : null,
                marking: state.marking == call.id,
                reopening: state.reopening == call.id,
                error: error != null && error.id == call.id ? error.message : null,
              );
            },
          ),
          SliverToBoxAdapter(child: _Footer(state: state, onRetryMore: () => unawaited(controller.retryMore()))),
        ];
    }

    return RefreshIndicator(
      onRefresh: () => controller.reload(keepRows: true),
      child: Scrollbar(
        child: CustomScrollView(
          key: const Key('missed-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverToBoxAdapter(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: header)),
            if (state.refreshing)
              const SliverToBoxAdapter(child: LinearProgressIndicator(key: Key('missed-refreshing'), minHeight: 2)),
            ...body,
          ],
        ),
      ),
    );
  }
}

/// "Showing 12 calls — there are more" for My calls' title, while rows show.
String missedCountLine(MissedCallsState s) =>
    s.status == MissedListStatus.ready && s.rows.isNotEmpty ? MissedCopy.countLine(s.rows.length, more: s.hasMore) : '';

class _Filters extends StatelessWidget {
  const _Filters({required this.filters, required this.onChanged});

  final MissedFilters filters;
  final ValueChanged<MissedFilters> onChanged;

  @override
  Widget build(BuildContext context) {
    final reason = filters.reason;
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.sm),
      child: Wrap(
        spacing: Space.sm,
        runSpacing: Space.xs,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          for (final status in const [InboundFollowUpStatus.open, InboundFollowUpStatus.handled])
            ChoiceChip(
              key: Key('missed-tab-${status.wire}'),
              label: Text(status == InboundFollowUpStatus.open ? MissedCopy.openTab : MissedCopy.handledTab),
              selected: filters.status == status,
              onSelected: (_) => onChanged(filters.withStatus(status)),
            ),
          // Keyed by the wire string ('' for any reason): a menu item whose value
          // is null reads as dismissed, so "Any reason" could never be picked.
          PopupMenuButton<String>(
            key: const Key('missed-filter-reason'),
            tooltip: MissedCopy.reasonFilter,
            initialValue: reason?.wire ?? '',
            onSelected: (wire) => onChanged(filters.withReason(wire.isEmpty ? null : InboundMissedReason.fromWire(wire))),
            itemBuilder: (_) => [
              const PopupMenuItem(value: '', child: Text(MissedCopy.anyReason)),
              for (final r in InboundMissedReason.values)
                if (!r.isUnknown) PopupMenuItem(value: r.wire, child: Text(MissedCopy.reasonLabel(r, r.wire))),
            ],
            child: IgnorePointer(
              child: FilterChip(
                label: Text(reason == null ? MissedCopy.reasonFilter : MissedCopy.reasonLabel(reason, reason.wire)),
                selected: reason != null,
                onSelected: (_) {},
                avatar: const Icon(Icons.filter_list, size: 18),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({super.key, required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.xs),
      child: AppCard(
        color: t.warningSubtle,
        borderColor: t.warningSubtle,
        padding: EdgeInsets.fromLTRB(Space.md, Space.sm, onRetry == null ? Space.md : Space.xs, Space.sm),
        child: Row(
          children: [
            Expanded(child: Text(message, style: Theme.of(context).textTheme.bodySmall)),
            if (onRetry != null) TextButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({required this.state, required this.onRetryMore});

  final MissedCallsState state;
  final VoidCallback onRetryMore;

  @override
  Widget build(BuildContext context) {
    final Widget child;
    if (state.moreError != null) {
      child = _Notice(key: const Key('missed-more-error'), message: state.moreError!, onRetry: onRetryMore);
    } else if (state.hasMore) {
      child = const Padding(
        padding: EdgeInsets.all(Space.lg),
        child: Center(child: SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2))),
      );
    } else {
      child = const SizedBox(height: Space.lg);
    }
    return Padding(padding: const EdgeInsets.only(bottom: Space.xl), child: child);
  }
}
