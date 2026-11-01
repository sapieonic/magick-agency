import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/auth/app_gate.dart';
import '../../../core/softphone/call_labels.dart';
import '../../../ui/primitives.dart';
import '../../performance/performance_controller.dart' show statsClockProvider;
import '../logic/attempt_copy.dart' show attemptsCountLine;
import '../logic/attempt_filters.dart' show phoneSearchHint, phoneSearchProblem;
import '../logic/debouncer.dart';
import 'softphone_call_detail_sheet.dart';
import 'softphone_call_tile.dart';
import 'softphone_calls_controller.dart';

/// Takes the agent to the Phone screen, where an unsettled call is finished.
/// A seam, so a test can see the hand-off without the app's router.
final softphoneCallsOpenPhoneProvider = Provider<void Function(BuildContext context)>(
  (ref) => (context) => context.go('/phone'),
);

/// The count line above the list ("Showing 50 calls — there are more"), or
/// empty while nothing is shown.
String softphoneCallsCountLine(SoftphoneCallsState s) =>
    s.status == SoftphoneCallsStatus.ready && s.rows.isNotEmpty ? attemptsCountLine(s.rows.length, more: s.hasMore) : '';

/// Empty-state copy (the console's `SoftphoneCallsList` empty state; the agent
/// list has no date range to widen).
({String title, String body}) softphoneCallsEmptyCopy({required bool filtered}) => filtered
    ? (title: 'Nothing matches those filters', body: 'Clear the filters to see every call.')
    : (title: 'No soft-phone calls yet', body: 'Calls placed from the soft phone appear here as they are made.');

/// The status chip, the clear button and the number search.
class SoftphoneCallsFilterBar extends ConsumerWidget {
  const SoftphoneCallsFilterBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final filters = ref.watch(softphoneCallsControllerProvider.select((s) => s.filters));
    final controller = ref.read(softphoneCallsControllerProvider.notifier);
    void apply(SoftphoneCallFilters f) => unawaited(controller.applyFilters(f));
    final status = filters.status;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: Space.lg),
          child: Row(
            children: [
              Padding(
                padding: const EdgeInsets.only(right: Space.sm),
                child: FilterChip(
                  key: const Key('softphone-filter-status'),
                  label: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 180),
                        child: Text(
                          status == null ? 'Any status' : softphoneCallStatusLabels[status] ?? status.wire,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const Icon(Icons.arrow_drop_down, size: 18),
                    ],
                  ),
                  selected: status != null,
                  showCheckmark: false,
                  onSelected: (_) => _pickStatus(context, filters, apply),
                ),
              ),
              if (filters.isFiltered)
                TextButton(
                  key: const Key('softphone-filter-clear'),
                  onPressed: () => apply(SoftphoneCallFilters.initial),
                  child: Text('Clear (${filters.groupCount})'),
                ),
            ],
          ),
        ),
        const Padding(
          padding: EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, 0),
          child: SoftphoneNumberSearchField(),
        ),
      ],
    );
  }

  Future<void> _pickStatus(
    BuildContext context,
    SoftphoneCallFilters filters,
    void Function(SoftphoneCallFilters) apply,
  ) async {
    final applied = filters.status;
    final entries = <MapEntry<ManualCallListStatus?, String>>[
      const MapEntry(null, 'Any status'),
      ...softphoneCallStatusLabels.entries.map((e) => MapEntry(e.key, e.value)),
    ];
    final picked = await showModalBottomSheet<MapEntry<ManualCallListStatus?, String>>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(padding: EdgeInsets.symmetric(horizontal: Space.lg), child: SectionLabel('Status')),
            for (final e in entries)
              ListTile(
                key: Key('softphone-status-${e.key?.wire ?? 'any'}'),
                title: Text(e.value),
                selected: e.key == applied,
                trailing: e.key == applied ? const Icon(Icons.check) : null,
                onTap: () => Navigator.pop(context, e),
              ),
          ],
        ),
      ),
    );
    if (picked == null) return;
    apply(picked.key == null ? filters.copyWith(clearStatus: true) : filters.copyWith(status: picked.key));
  }
}

/// The number search: digits only on the wire (a suffix match), applied
/// [debounce] after the agent stops typing. Owns its text, so keystrokes
/// rebuild this field only.
class SoftphoneNumberSearchField extends ConsumerStatefulWidget {
  const SoftphoneNumberSearchField({super.key, this.debounce = const Duration(milliseconds: 400)});

  final Duration debounce;

  @override
  ConsumerState<SoftphoneNumberSearchField> createState() => _SoftphoneNumberSearchFieldState();
}

class _SoftphoneNumberSearchFieldState extends ConsumerState<SoftphoneNumberSearchField> {
  late final TextEditingController _text =
      TextEditingController(text: ref.read(softphoneCallsControllerProvider).filters.phoneDigits ?? '');
  late final Debouncer _debounce = Debouncer(widget.debounce);
  String? _problem;

  @override
  void dispose() {
    _debounce.dispose();
    _text.dispose();
    super.dispose();
  }

  void _apply() {
    if (!mounted) return;
    final raw = _text.text;
    if (phoneSearchProblem(raw) != null) return;
    final digits = SoftphoneCallFilters.digitsOf(raw);
    final current = ref.read(softphoneCallsControllerProvider).filters;
    if (current.phoneDigits == digits) return;
    final next = digits == null ? current.copyWith(clearPhone: true) : current.copyWith(phoneDigits: digits);
    unawaited(ref.read(softphoneCallsControllerProvider.notifier).applyFilters(next));
  }

  void _onChanged(String raw) {
    final problem = phoneSearchProblem(raw);
    if (problem != _problem) setState(() => _problem = problem);
    _debounce(_apply);
  }

  @override
  Widget build(BuildContext context) {
    // Cleared from elsewhere (the Clear button, a workspace switch): empty the box to match.
    ref.listen<String?>(softphoneCallsControllerProvider.select((s) => s.filters.phoneDigits), (prev, next) {
      if (next == null && SoftphoneCallFilters.digitsOf(_text.text) != null) {
        _debounce.cancel();
        _text.clear();
      }
    });
    final t = context.tokens;
    return TextField(
      key: const Key('softphone-phone-search'),
      controller: _text,
      keyboardType: TextInputType.phone,
      textInputAction: TextInputAction.search,
      onChanged: _onChanged,
      onSubmitted: (_) => _debounce.flush(_apply),
      decoration: InputDecoration(
        isDense: true,
        prefixIcon: Icon(Icons.search, color: t.textMuted),
        hintText: phoneSearchHint,
        labelText: 'Phone number',
        errorText: _problem,
        suffixIcon: ListenableBuilder(
          listenable: _text,
          builder: (context, _) => _text.text.isEmpty
              ? const SizedBox.shrink()
              : IconButton(
                  tooltip: 'Clear the number',
                  icon: const Icon(Icons.close),
                  onPressed: () {
                    _text.clear();
                    _onChanged('');
                    _debounce.flush(_apply);
                  },
                ),
        ),
      ),
    );
  }
}

/// The soft-phone calls, keyset-paged: the next page is fetched while the
/// agent is still a screenful away from the end. Asks for its first page when
/// shown and again when the workspace changes under it.
class SoftphoneCallsList extends ConsumerStatefulWidget {
  const SoftphoneCallsList({super.key});

  /// Start fetching the next page when a row this close to the end builds.
  static const prefetchRows = 20;

  @override
  ConsumerState<SoftphoneCallsList> createState() => _SoftphoneCallsListState();
}

class _SoftphoneCallsListState extends ConsumerState<SoftphoneCallsList> {
  bool _prefetchScheduled = false;

  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (mounted) unawaited(ref.read(softphoneCallsControllerProvider.notifier).ensureLoaded());
    });
  }

  /// Called from the row builder: providers cannot change during a build, so
  /// the request goes out right after this frame (once per frame).
  void _maybePrefetch() {
    if (_prefetchScheduled) return;
    _prefetchScheduled = true;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      _prefetchScheduled = false;
      if (mounted) unawaited(ref.read(softphoneCallsControllerProvider.notifier).loadMore());
    });
  }

  Future<void> _refresh() async {
    final workspace = ref.read(agentWorkspaceProvider);
    if (workspace != null) ref.invalidate(softphoneCallsBootstrapProvider(workspace));
    await ref.read(softphoneCallsControllerProvider.notifier).reload(keepRows: true);
  }

  void _open(ManualCallListRow row) {
    if (row.isUnsettled) {
      ref.read(softphoneCallsOpenPhoneProvider)(context);
    } else {
      unawaited(showSoftphoneCallDetail(context, row: row));
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<String?>(agentWorkspaceProvider, (prev, next) {
      if (next == null || next == prev) return;
      Future.microtask(() {
        if (mounted) unawaited(ref.read(softphoneCallsControllerProvider.notifier).ensureLoaded());
      });
    });
    final state = ref.watch(softphoneCallsControllerProvider);
    final bootstrap = softphoneCallsBootstrapOf(ref);
    final controller = ref.read(softphoneCallsControllerProvider.notifier);
    final now = ref.read(statsClockProvider)();
    final text = Theme.of(context).textTheme;
    final rows = state.rows;

    final List<Widget> slivers;
    switch (state.status) {
      case SoftphoneCallsStatus.loading:
        slivers = const [
          SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              child: SizedBox.square(
                key: Key('softphone-calls-loading'),
                dimension: 24,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          ),
        ];
      case SoftphoneCallsStatus.error:
        slivers = [
          SliverFillRemaining(
            hasScrollBody: false,
            child: LoadErrorView(
              key: const Key('softphone-calls-error'),
              message: state.error ?? 'We couldn’t load the soft-phone calls.',
              onRetry: () => unawaited(controller.reload()),
            ),
          ),
        ];
      case SoftphoneCallsStatus.ready when rows.isEmpty:
        final copy = softphoneCallsEmptyCopy(filtered: state.filters.isFiltered);
        slivers = [
          SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              key: const Key('softphone-calls-empty'),
              child: Padding(
                padding: const EdgeInsets.all(Space.xl),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.phone_outlined, size: 32, color: context.tokens.textMuted),
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
      case SoftphoneCallsStatus.ready:
        slivers = [
          if (state.error != null)
            SliverToBoxAdapter(
              child: _Notice(
                key: const Key('softphone-calls-refresh-error'),
                message: 'These may be out of date. ${state.error}',
                onRetry: () => unawaited(controller.reload(keepRows: true)),
              ),
            ),
          SliverPrototypeExtentList(
            prototypeItem: SoftphoneCallTile(view: SoftphoneCallRowView(_prototypeRow, catalog: null, now: now)),
            delegate: SliverChildBuilderDelegate(
              (context, i) {
                if (i >= rows.length - SoftphoneCallsList.prefetchRows && state.hasMore) _maybePrefetch();
                final row = rows[i];
                return SoftphoneCallTile(
                  key: ValueKey(row.id),
                  view: SoftphoneCallRowView(row, catalog: catalogForCall(row, bootstrap), now: now),
                  onTap: () => _open(row),
                );
              },
              childCount: rows.length,
            ),
          ),
          SliverToBoxAdapter(child: _Footer(state: state, onRetryMore: () => unawaited(controller.retryMore()))),
        ];
    }

    return RefreshIndicator(
      onRefresh: _refresh,
      child: Scrollbar(
        child: CustomScrollView(
          key: const Key('softphone-calls-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            if (state.refreshing)
              const SliverToBoxAdapter(
                child: LinearProgressIndicator(key: Key('softphone-calls-refreshing'), minHeight: 2),
              ),
            ...slivers,
          ],
        ),
      ),
    );
  }
}

/// The shape every row is laid out by (see [SoftphoneCallTile]).
final _prototypeRow = ManualCallListRow(
  id: 'prototype',
  sessionId: 'prototype',
  agentUserId: 'prototype',
  destinationE164: '+910000000000',
  callerId: '',
  tag: const ManualCallTag(campaignId: 'prototype', campaignName: 'Prototype'),
  state: AttemptState.ended,
  recordingRequested: false,
  dncOverridden: false,
  hoursOverridden: false,
  requiresDisposition: false,
  dispositionCode: 'Prototype',
  dispositionedOnBehalf: false,
  talkSeconds: 0,
  createdAt: DateTime.utc(2026),
  updatedAt: DateTime.utc(2026),
);

class _Footer extends StatelessWidget {
  const _Footer({required this.state, required this.onRetryMore});

  final SoftphoneCallsState state;
  final VoidCallback onRetryMore;

  @override
  Widget build(BuildContext context) {
    final Widget child;
    if (state.moreError != null) {
      child = _Notice(key: const Key('softphone-calls-more-error'), message: state.moreError!, onRetry: onRetryMore);
    } else if (state.hasMore) {
      // Shown only if the agent outruns the prefetch.
      child = const Padding(
        padding: EdgeInsets.all(Space.lg),
        child: Center(child: SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2))),
      );
    } else {
      child = const SizedBox(key: Key('softphone-calls-end'), height: Space.lg);
    }
    return Padding(padding: const EdgeInsets.only(bottom: Space.xl), child: child);
  }
}

class _Notice extends StatelessWidget {
  const _Notice({super.key, required this.message, required this.onRetry});

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
