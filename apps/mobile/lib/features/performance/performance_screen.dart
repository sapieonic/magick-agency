import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/app_theme.dart';
import '../../app/theme/tokens.dart';
import '../../ui/primitives.dart';
import 'agent_workspace.dart';
import 'campaign_names.dart';
import 'logic/performance_view.dart';
import 'logic/readouts.dart';
import 'logic/stats_windows.dart';
import 'performance_controller.dart';
import 'widgets/bucket_chart.dart';

/// The agent's numbers for one window: memoised from the current answer,
/// the window and the campaign names, so a frame never re-derives them.
final performanceViewProvider = Provider<PerformanceView>((ref) {
  final window = ref.watch(performanceControllerProvider.select((s) => s.window));
  final stats = ref.watch(performanceControllerProvider.select((s) => s.current.stats));
  return buildPerformanceView(
    window: window,
    stats: stats,
    campaignNames: ref.watch(campaignNamesProvider),
    calendar: ref.watch(localCalendarProvider),
  );
});

/// "My performance": the agent's own dials, connect rate and conversations
/// for a window, the readouts the console shows beside them, and a
/// day-by-day chart. Wording and rounding follow the console's
/// `AgentPerformancePanel` so the two clients print the same figures.
class PerformanceScreen extends ConsumerStatefulWidget {
  const PerformanceScreen({super.key});

  @override
  ConsumerState<PerformanceScreen> createState() => _PerformanceScreenState();
}

class _PerformanceScreenState extends ConsumerState<PerformanceScreen> {
  @override
  void initState() {
    super.initState();
    // Revalidate on arrival; a cached answer (if any) is already on screen.
    Future.microtask(() {
      if (mounted) unawaited(ref.read(performanceControllerProvider.notifier).revalidate());
    });
  }

  Future<void> _refresh() async {
    ref.invalidate(myCampaignsProvider);
    await ref.read(performanceControllerProvider.notifier).revalidate();
  }

  @override
  Widget build(BuildContext context) {
    // The shell keeps this tab mounted across an account switch or a new
    // sign-in: the controller drops the old figures itself, this reads the
    // new agent's.
    ref.listen<String?>(agentWorkspaceProvider, (prev, next) {
      if (next == null || next == prev) return;
      Future.microtask(() {
        if (mounted) unawaited(ref.read(performanceControllerProvider.notifier).revalidate());
      });
    });
    final scoped = ref.watch(_scopeShownProvider);
    return Scaffold(
      appBar: AppBar(
        title: Semantics(header: true, child: const Text('My performance')),
        // Under the title, a full 48 dp row so the scope is easy to hit.
        bottom: scoped ? const PreferredSize(preferredSize: Size.fromHeight(Space.touch), child: _CampaignScopeButton()) : null,
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          key: const Key('performance-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, Space.xxl),
          children: const [
            _WindowSelector(),
            _RefreshBar(),
            SizedBox(height: Space.sm),
            _Body(),
          ],
        ),
      ),
    );
  }
}

/// Whether the campaign scope is offered: a choice to make or a scope
/// already in force (the console's `showScope`).
final _scopeShownProvider = Provider.autoDispose<bool>((ref) {
  final names = ref.watch(campaignNamesProvider);
  final applied = ref.watch(performanceControllerProvider.select((s) => s.campaignId));
  return showScope(scopeOptions(names).length, applied);
});

/// "All campaigns ▾" under the title (see [_scopeShownProvider]).
class _CampaignScopeButton extends ConsumerWidget {
  const _CampaignScopeButton();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final names = ref.watch(campaignNamesProvider);
    final applied = ref.watch(performanceControllerProvider.select((s) => s.campaignId));
    final options = scopeOptions(names);
    final t = context.tokens;
    final label = applied == null ? 'All campaigns' : campaignLabel(applied, names);
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: Padding(
        // The label lines up with the title; the ripple reaches past it.
        padding: const EdgeInsetsDirectional.only(start: NavigationToolbar.kMiddleSpacing - Space.sm, end: Space.lg),
        child: Semantics(
          button: true,
          label: 'Campaign: $label. Change',
          excludeSemantics: true,
          child: InkWell(
            key: const Key('campaign-scope'),
            borderRadius: BorderRadius.circular(Radii.sm),
            onTap: () => _pickCampaign(context, ref, options, applied, names),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: Space.touch, minWidth: Space.touch),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: Space.sm),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Flexible(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.labelMedium!.copyWith(color: t.accentHover),
                      ),
                    ),
                    Icon(Icons.arrow_drop_down, size: 20, color: t.accentHover),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _pickCampaign(
    BuildContext context,
    WidgetRef ref,
    List<MapEntry<String, String>> options,
    String? applied,
    Map<String, String?> names,
  ) async {
    final controller = ref.read(performanceControllerProvider.notifier);
    // The applied scope stays offered even when it cannot be named, so it
    // can always be cleared.
    final entries = <MapEntry<String?, String>>[
      const MapEntry(null, 'All campaigns'),
      for (final o in options) MapEntry(o.key, o.value),
      if (applied != null && !options.any((o) => o.key == applied)) MapEntry(applied, campaignLabel(applied, names)),
    ];
    final picked = await showModalBottomSheet<MapEntry<String?, String>>(
      context: context,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.sm),
              child: SectionLabel('Campaign'),
            ),
            for (final e in entries)
              ListTile(
                key: Key('scope-option-${e.key ?? 'all'}'),
                title: Text(e.value),
                trailing: e.key == applied ? const Icon(Icons.check) : null,
                selected: e.key == applied,
                onTap: () => Navigator.of(context).pop(e),
              ),
          ],
        ),
      ),
    );
    if (picked != null) unawaited(controller.selectCampaign(picked.key));
  }
}

/// Today / This week / This month, and the two completed windows in a menu.
class _WindowSelector extends ConsumerWidget {
  const _WindowSelector();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final window = ref.watch(performanceControllerProvider.select((s) => s.window));
    final controller = ref.read(performanceControllerProvider.notifier);
    final secondary = secondaryWindows.contains(window);
    final t = context.tokens;
    return Row(
      children: [
        Expanded(
          child: SegmentedButton<StatsWindow>(
            key: const Key('window-selector'),
            segments: [
              for (final w in primaryWindows)
                ButtonSegment(value: w, label: Text(w.label, maxLines: 1, overflow: TextOverflow.ellipsis)),
            ],
            selected: secondary ? const <StatsWindow>{} : {window},
            emptySelectionAllowed: true,
            showSelectedIcon: false,
            onSelectionChanged: (s) {
              if (s.isNotEmpty) unawaited(controller.selectWindow(s.first));
            },
          ),
        ),
        const SizedBox(width: Space.xs),
        PopupMenuButton<StatsWindow>(
          key: const Key('window-more'),
          tooltip: 'Earlier periods',
          initialValue: secondary ? window : null,
          onSelected: (w) => unawaited(controller.selectWindow(w)),
          itemBuilder: (_) => [
            for (final w in secondaryWindows)
              PopupMenuItem(value: w, key: Key('window-${w.name}'), child: Text(w.label)),
          ],
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: Space.touch, minWidth: Space.touch),
            child: Center(
              child: secondary
                  ? Text(window.label, style: Theme.of(context).textTheme.labelLarge!.copyWith(color: t.accentHover))
                  : Icon(Icons.more_horiz, color: t.textSecondary),
            ),
          ),
        ),
      ],
    );
  }
}

/// A thin bar while an earlier answer is on screen and a newer one is read.
class _RefreshBar extends ConsumerWidget {
  const _RefreshBar();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final refreshing = ref.watch(performanceControllerProvider.select((s) => s.current.refreshing));
    return SizedBox(
      height: 3,
      child: refreshing
          ? const LinearProgressIndicator(key: Key('performance-refreshing'), minHeight: 2)
          : null,
    );
  }
}

class _Body extends ConsumerWidget {
  const _Body();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final slot = ref.watch(performanceControllerProvider.select((s) => s.current));
    final window = ref.watch(performanceControllerProvider.select((s) => s.window));
    final scoped = ref.watch(performanceControllerProvider.select((s) => s.campaignId != null));
    final controller = ref.read(performanceControllerProvider.notifier);
    final text = Theme.of(context).textTheme;

    if (slot.stats == null && slot.error != null) {
      return AppCard(
        key: const Key('period-error'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(failedWindowTitle(window.label), style: text.titleSmall),
            const SizedBox(height: Space.xs),
            Text(slot.error!, style: text.bodyMedium),
            const SizedBox(height: Space.md),
            OutlinedButton(onPressed: () => unawaited(controller.revalidate()), child: const Text('Try again')),
          ],
        ),
      );
    }
    if (slot.stats == null) return const _Skeleton();

    final view = ref.watch(performanceViewProvider);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (slot.error != null) ...[
          _StaleBanner(message: slot.error!, onRetry: () => unawaited(controller.revalidate())),
          const SizedBox(height: Space.sm),
        ],
        if (view.rangeCaption != null)
          Text(view.rangeCaption!, key: const Key('range-caption'), style: text.bodySmall),
        if (scoped) ...[
          const SizedBox(height: Space.xs),
          Text(campaignScopeNote, key: const Key('campaign-scope-note'), style: text.bodySmall),
        ],
        const SizedBox(height: Space.md),
        _Tiles(figures: view.tiles),
        if (view.emptyLine != null) ...[
          const SizedBox(height: Space.md),
          Text(view.emptyLine!, key: const Key('empty-range'), style: text.bodyMedium),
        ],
        const SizedBox(height: Space.md),
        _Readouts(view: view),
        const SizedBox(height: Space.md),
        if (view.series != null) BucketChart(series: view.series!),
        const SizedBox(height: Space.md),
        _CampaignBreakdown(rows: view.campaigns, worked: view.campaignsWorked),
        const SizedBox(height: Space.md),
        _HeadlineKey(figures: view.tiles),
        const SizedBox(height: Space.sm),
        Text(historyReachNote, key: const Key('history-reach-note'), style: text.bodySmall),
      ],
    );
  }
}

class _StaleBanner extends StatelessWidget {
  const _StaleBanner({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return AppCard(
      key: const Key('performance-stale'),
      color: t.warningSubtle,
      borderColor: t.warningSubtle,
      padding: const EdgeInsets.fromLTRB(Space.md, Space.xs, Space.xs, Space.xs),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Text('These may be out of date. $message', style: Theme.of(context).textTheme.bodySmall),
            ),
          ),
          TextButton(onPressed: onRetry, child: const Text('Try again')),
        ],
      ),
    );
  }
}

/// Dials · Connect rate · Conversations: never collapsed into one "calls".
class _Tiles extends StatelessWidget {
  const _Tiles({required this.figures});

  final List<HeadlineFigure> figures;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < figures.length; i++) ...[
          if (i > 0) const SizedBox(width: Space.sm),
          Expanded(child: _Tile(figure: figures[i])),
        ],
      ],
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.figure});

  final HeadlineFigure figure;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final long = figure.value.length > 6;
    return Semantics(
      container: true,
      label: '${figure.label}: ${figure.value}',
      excludeSemantics: true,
      child: AppCard(
        key: Key('tile-${figure.key}'),
        padding: const EdgeInsets.all(Space.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(figure.label, style: text.labelSmall, maxLines: 2),
            const SizedBox(height: Space.xs),
            Text(
              figure.value,
              style: long
                  ? text.labelLarge!.copyWith(color: figure.known ? t.textPrimary : t.textMuted)
                  : monoStyle(context, size: 22, weight: FontWeight.w500, color: figure.known ? t.textPrimary : t.textMuted),
            ),
          ],
        ),
      ),
    );
  }
}

class _Readouts extends StatelessWidget {
  const _Readouts({required this.view});

  final PerformanceView view;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        children: [
          _ReadoutRow(keyName: 'conversion-rate-readout', label: 'Conversion rate', readout: view.conversion),
          const Divider(height: Space.lg),
          _ReadoutRow(keyName: 'handle-time-readout', label: 'Average call', readout: view.handleTime),
          const Divider(height: Space.lg),
          _ReadoutRow(keyName: 'wrapup-readout', label: 'Wrap-up', readout: view.wrapup),
        ],
      ),
    );
  }
}

class _ReadoutRow extends StatelessWidget {
  const _ReadoutRow({required this.keyName, required this.label, required this.readout});

  final String keyName;
  final String label;
  final Readout readout;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final valueStyle = readout.value.length > 8
        ? text.labelLarge!.copyWith(color: readout.known ? t.textPrimary : t.textMuted)
        : monoStyle(context, size: 16, weight: FontWeight.w500, color: readout.known ? t.textPrimary : t.textMuted);
    return Semantics(
      container: true,
      key: Key(keyName),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.end,
            spacing: Space.sm,
            runSpacing: 2,
            children: [
              Text(label, style: text.labelMedium),
              Text(readout.value, style: valueStyle),
              if (readout.secondary != null) Text('· ${readout.secondary}', style: text.bodySmall),
            ],
          ),
          const SizedBox(height: 2),
          Text(readout.detail, style: text.bodySmall),
        ],
      ),
    );
  }
}

/// Per campaign, for the window. The connect rate is withheld under the
/// console's floor ("Not enough calls").
class _CampaignBreakdown extends StatelessWidget {
  const _CampaignBreakdown({required this.rows, required this.worked});

  final List<CampaignRowView> rows;
  final String? worked;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SectionLabel(
            'By campaign',
            trailing: worked == null ? null : Text(worked!, key: const Key('campaigns-worked'), style: text.labelSmall),
          ),
          const SizedBox(height: Space.sm),
          if (rows.isEmpty)
            Text('No calls on any campaign in this period.', key: const Key('breakdown-empty'), style: text.bodySmall)
          else
            for (final r in rows)
              Padding(
                key: Key('campaign-row-${r.campaignId}'),
                padding: const EdgeInsets.symmetric(vertical: Space.xs),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(r.name, style: text.titleSmall, maxLines: 2, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 2),
                    Text(
                      'Dials ${r.dials} · Connect rate ${r.connectRate} · Conversations ${r.conversations} · '
                      'Counted ${r.counted} · On calls ${r.onCalls}',
                      style: text.bodySmall,
                    ),
                  ],
                ),
              ),
        ],
      ),
    );
  }
}

/// What the three headline figures count, said once (the console's
/// `HeadlineKey`).
class _HeadlineKey extends StatelessWidget {
  const _HeadlineKey({required this.figures});

  final List<HeadlineFigure> figures;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        key: const Key('headline-key'),
        tilePadding: EdgeInsets.zero,
        childrenPadding: EdgeInsets.zero,
        title: Text('What these count', style: text.labelLarge),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final f in figures)
            Padding(
              padding: const EdgeInsets.only(bottom: Space.sm),
              child: Text.rich(TextSpan(children: [
                TextSpan(text: '${f.label}: ', style: text.titleSmall),
                TextSpan(text: f.hint, style: text.bodySmall),
              ])),
            ),
        ],
      ),
    );
  }
}

/// First-load placeholders, shaped like what will replace them.
class _Skeleton extends StatelessWidget {
  const _Skeleton();

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    Widget box(double h) => DecoratedBox(
          decoration: BoxDecoration(color: t.bgTertiary, borderRadius: BorderRadius.circular(Radii.md)),
          child: SizedBox(height: h, width: double.infinity),
        );
    return Semantics(
      label: 'Loading your numbers',
      child: ExcludeSemantics(
        child: Column(
          key: const Key('performance-skeleton'),
          children: [
            const SizedBox(height: Space.lg),
            Row(children: [
              Expanded(child: box(72)),
              const SizedBox(width: Space.sm),
              Expanded(child: box(72)),
              const SizedBox(width: Space.sm),
              Expanded(child: box(72)),
            ]),
            const SizedBox(height: Space.md),
            box(150),
            const SizedBox(height: Space.md),
            box(220),
          ],
        ),
      ),
    );
  }
}
