import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../app/theme/tokens.dart';
import '../../core/auth/app_gate.dart';
import '../../core/flags/feature_flags.dart';
import '../../core/station/station_view.dart';
import '../../ui/primitives.dart';
import '../calls/logic/debouncer.dart';
import '../campaigns/assignment_entry.dart' show campaignDisplayName;
import '../campaigns/campaigns_providers.dart';
import '../performance/performance_controller.dart' show statsClockProvider;
import '../station/logic/format.dart' show formatDueAt, formatPhone;
import '../station/station_copy.dart';
import 'my_contacts_controller.dart';
import 'my_contacts_copy.dart';

/// "My contacts" on one campaign (contact assignment): the agent's counts,
/// "Retry not reached", their contacts filtered by bucket and number, and a
/// Call on each contact they may call now.
///
/// Behind the `agency_contact_assignment_enabled` flag. Reachable, when the
/// join bootstrap offers it ([StationView.myContactsOffered]), from the
/// station's waiting screen and the on-duty campaign's card; while on duty on
/// this campaign the router keeps it open (it is the station's own page) until
/// a call takes the screen, so the call it places lands on the station.
class MyContactsScreen extends ConsumerStatefulWidget {
  const MyContactsScreen({super.key, required this.campaignId});

  final String campaignId;

  /// Start fetching the next page this many rows from the end.
  static const prefetchRows = 20;

  @override
  ConsumerState<MyContactsScreen> createState() => _MyContactsScreenState();
}

class _MyContactsScreenState extends ConsumerState<MyContactsScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (mounted && ref.read(contactAssignmentEnabledProvider)) unawaited(_controller.ensureLoaded());
    });
  }

  MyContactsController get _controller => ref.read(myContactsControllerProvider(widget.campaignId).notifier);

  void _back() {
    final router = GoRouter.of(context);
    if (router.canPop()) {
      router.pop();
    } else {
      router.go(Routes.home);
    }
  }

  @override
  Widget build(BuildContext context) {
    final enabled = ref.watch(contactAssignmentEnabledProvider);
    // The flag arrives after the screen (a deep link, a cold start): load then.
    ref.listen<bool>(contactAssignmentEnabledProvider, (prev, next) {
      if (next && prev != true) unawaited(_controller.ensureLoaded());
    });
    ref.listen<String?>(agentWorkspaceProvider, (prev, next) {
      if (next == null || next == prev) return;
      Future.microtask(() {
        if (mounted) unawaited(_controller.ensureLoaded());
      });
    });
    return Scaffold(
      appBar: AppBar(
        leading: BackButton(onPressed: _back),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Semantics(header: true, child: const Text(MyContactsCopy.title)),
            _CampaignLine(campaignId: widget.campaignId),
          ],
        ),
      ),
      body: enabled
          ? _Body(campaignId: widget.campaignId)
          : const Center(
              key: Key('my-contacts-off'),
              child: Padding(padding: EdgeInsets.all(Space.xl), child: Text(MyContactsCopy.flagOff, textAlign: TextAlign.center)),
            ),
    );
  }
}

/// The campaign's name under the title: the station's when the agent is on
/// it, else the agent's assignment list's.
class _CampaignLine extends ConsumerWidget {
  const _CampaignLine({required this.campaignId});

  final String campaignId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final station = ref.watch(
      stationViewProvider.select((v) => v != null && v.campaignId == campaignId ? v.campaignName : null),
    );
    String? name = station;
    if (name == null) {
      final workspace = ref.watch(agentWorkspaceProvider);
      final list = workspace == null ? null : ref.watch(myAssignmentsProvider(workspace)).value;
      final match = list?.where((a) => a.campaignId == campaignId).firstOrNull;
      name = match == null ? null : campaignDisplayName(match);
    }
    if (name == null || name.isEmpty) return const SizedBox.shrink();
    return Text(name, style: Theme.of(context).textTheme.labelMedium, overflow: TextOverflow.ellipsis);
  }
}

class _Body extends ConsumerStatefulWidget {
  const _Body({required this.campaignId});

  final String campaignId;

  @override
  ConsumerState<_Body> createState() => _BodyState();
}

class _BodyState extends ConsumerState<_Body> {
  bool _prefetchScheduled = false;

  MyContactsController get _controller => ref.read(myContactsControllerProvider(widget.campaignId).notifier);

  void _maybePrefetch() {
    if (_prefetchScheduled) return;
    _prefetchScheduled = true;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      _prefetchScheduled = false;
      if (mounted) unawaited(_controller.loadMore());
    });
  }

  void _say(String message) {
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger?.hideCurrentSnackBar();
    messenger?.showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _retry({required bool selectedOnly, required int count}) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text(MyContactsCopy.retryTitle),
        content: Text(MyContactsCopy.retryBody(count, selected: selectedOnly)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text(MyContactsCopy.cancel)),
          FilledButton(
            key: const Key('retry-confirm'),
            onPressed: () => Navigator.pop(context, true),
            child: const Text(MyContactsCopy.retryConfirm),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final result = await _controller.retry(selectedOnly: selectedOnly);
    if (mounted) _say(result.message);
  }

  Future<void> _call(MyContact contact) async {
    var result = await _controller.call(contact);
    if (!mounted) return;
    if (result case ContactCallNeedsNote(:final grant)) {
      final note = await showDialog<String>(
        context: context,
        builder: (context) => _OverrideNoteDialog(disposition: grant?.disposition),
      );
      if (note == null || !mounted) return;
      result = await _controller.call(contact, overrideNote: note);
      if (!mounted) return;
    }
    switch (result) {
      case ContactCallPlaced():
        _say(MyContactsCopy.callPlaced);
      case ContactCallFailed(:final message):
        _say(message);
      case ContactCallNeedsNote():
        // Asked once: the same refusal with a note sent is a ContactCallFailed.
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(myContactsControllerProvider(widget.campaignId));
    final gate = ref.watch(myContactsCallGateProvider(widget.campaignId));
    final now = ref.read(statsClockProvider)();
    final rows = state.rows;
    final summary = state.summary;
    // Picking rows follows "Retry not reached": only once nothing is due.
    final retryOpen = summary?.retryOpen ?? false;

    final List<Widget> list;
    switch (state.status) {
      case MyContactsStatus.loading:
        list = const [
          SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(Space.xl),
              child: Center(child: CircularProgressIndicator(semanticsLabel: 'Loading your contacts')),
            ),
          ),
        ];
      case MyContactsStatus.error:
        list = [
          SliverToBoxAdapter(
            child: LoadErrorView(
              key: const Key('my-contacts-error'),
              message: state.error ?? MyContactsCopy.loadFailed,
              onRetry: () => unawaited(_controller.reload()),
            ),
          ),
        ];
      case MyContactsStatus.ready when rows.isEmpty:
        list = [
          SliverToBoxAdapter(
            child: _Empty(
              filtered: state.filters.isFiltered,
              onClear: () => unawaited(_controller.applyFilters(MyContactsFilters.initial)),
            ),
          ),
        ];
      case MyContactsStatus.ready:
        list = [
          if (state.error != null)
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.xs),
                child: Text(state.error!, key: const Key('my-contacts-refresh-error'), style: Theme.of(context).textTheme.bodySmall),
              ),
            ),
          SliverPrototypeExtentList(
            prototypeItem: _ContactTile(
              contact: _prototype,
              now: now,
              selectable: true,
              selected: false,
              callable: true,
              calling: false,
            ),
            delegate: SliverChildBuilderDelegate(
              (context, i) {
                if (i >= rows.length - MyContactsScreen.prefetchRows && state.hasMore) _maybePrefetch();
                final c = rows[i];
                final selectable = retryOpen && c.retry.eligible;
                return _ContactTile(
                  key: ValueKey(c.id),
                  contact: c,
                  now: now,
                  selectable: selectable,
                  selected: state.selected.contains(c.id),
                  callable: gate.isOpen && canCallContact(c, now),
                  calling: state.callingId == c.id,
                  onToggle: selectable ? () => _controller.toggleSelected(c) : null,
                  onCall: state.callingId == null ? () => unawaited(_call(c)) : null,
                );
              },
              childCount: rows.length,
            ),
          ),
          SliverToBoxAdapter(child: _Footer(state: state, onRetryMore: () => unawaited(_controller.retryMore()))),
        ];
    }

    return RefreshIndicator(
      onRefresh: () => _controller.reload(keepRows: true),
      child: CustomScrollView(
        key: const Key('my-contacts-list'),
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          if (state.refreshing) const SliverToBoxAdapter(child: LinearProgressIndicator(minHeight: 2)),
          SliverToBoxAdapter(
            child: _SummaryCard(
              summary: summary,
              error: state.summaryError,
              now: now,
              filters: state.filters,
              onBucket: (b) {
                final buckets = {...state.filters.buckets};
                if (!buckets.remove(b)) {
                  buckets
                    ..clear()
                    ..add(b);
                }
                unawaited(_controller.applyFilters(state.filters.withBuckets(buckets)));
              },
            ),
          ),
          SliverToBoxAdapter(
            child: _RetryBar(
              summary: summary,
              selected: state.selected.length,
              retrying: state.retrying,
              onRetryAll: (n) => unawaited(_retry(selectedOnly: false, count: n)),
              onRetrySelected: (n) => unawaited(_retry(selectedOnly: true, count: n)),
              onClearSelection: _controller.clearSelection,
            ),
          ),
          if (!gate.isOpen)
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.sm),
                child: Text(gate.blocked!, key: const Key('call-gate'), style: Theme.of(context).textTheme.bodySmall),
              ),
            ),
          SliverToBoxAdapter(child: _FilterBar(campaignId: widget.campaignId, filters: state.filters)),
          ...list,
        ],
      ),
    );
  }
}

/// The counts, and the queue's state when nothing is due.
class _SummaryCard extends StatelessWidget {
  const _SummaryCard({
    required this.summary,
    required this.error,
    required this.now,
    required this.filters,
    required this.onBucket,
  });

  final MyContactsSummary? summary;
  final String? error;
  final DateTime now;
  final MyContactsFilters filters;
  final void Function(MyContactBucket) onBucket;

  /// The counts shown, in this order; `in_progress` only when it is not 0.
  static const shown = [
    MyContactBucket.pending,
    MyContactBucket.callback,
    MyContactBucket.notReached,
    MyContactBucket.reached,
    MyContactBucket.exhausted,
    MyContactBucket.suppressed,
  ];

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final s = summary;
    if (s == null) {
      return Padding(
        padding: const EdgeInsets.all(Space.lg),
        child: Text(error ?? '', key: const Key('summary-error'), style: text.bodySmall),
      );
    }
    final queue = s.queue;
    final next = queue.nextDueAt;
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.sm),
      child: AppCard(
        key: const Key('my-contacts-summary'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              spacing: Space.md,
              runSpacing: Space.xs,
              children: [
                Text('${MyContactsCopy.total}: ${s.total}', key: const Key('summary-total'), style: text.titleSmall),
                Text('${MyContactsCopy.dueNow}: ${s.dueNow}', key: const Key('summary-due'), style: text.titleSmall),
              ],
            ),
            if (!queue.due && s.assignmentMode.hasOwnQueue) ...[
              const SizedBox(height: Space.xs),
              Text(
                '${StationCopy.nothingDueHeadline}. '
                '${StationCopy.nothingDueDetail(_idle(queue.reason), next == null ? null : formatDueAt(next, now))}',
                key: const Key('summary-queue'),
                style: text.bodySmall!.copyWith(color: t.textSecondary),
              ),
            ],
            const SizedBox(height: Space.sm),
            Wrap(
              spacing: Space.xs,
              runSpacing: Space.xs,
              children: [
                for (final b in [...shown, if (s.counts[MyContactBucket.inProgress] > 0) MyContactBucket.inProgress])
                  FilterChip(
                    key: Key('count-${b.wire}'),
                    label: Text('${MyContactsCopy.bucketLabel(b)} ${s.counts[b]}'),
                    selected: filters.buckets.contains(b),
                    showCheckmark: false,
                    onSelected: (_) => onBucket(b),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  static QueueIdle _idle(QueueIdleReason? r) => switch (r) {
        QueueIdleReason.queueEmpty => QueueIdle.queueEmpty,
        QueueIdleReason.waitingForRetry => QueueIdle.waitingForRetry,
        QueueIdleReason.callbacksLater => QueueIdle.callbacksLater,
        QueueIdleReason.outsideCallingHours => QueueIdle.outsideCallingHours,
        QueueIdleReason.unknown || null => QueueIdle.other,
      };
}

/// "Retry not reached (N)" when retry is allowed, nothing is due and
/// something can be retried, and "Retry selected (k)" while contacts are
/// picked; nothing while anything is due (the console's rule: retry is
/// offered once the due contacts are used up).
class _RetryBar extends StatelessWidget {
  const _RetryBar({
    required this.summary,
    required this.selected,
    required this.retrying,
    required this.onRetryAll,
    required this.onRetrySelected,
    required this.onClearSelection,
  });

  final MyContactsSummary? summary;
  final int selected;
  final bool retrying;
  final void Function(int) onRetryAll;
  final void Function(int) onRetrySelected;
  final VoidCallback onClearSelection;

  @override
  Widget build(BuildContext context) {
    final s = summary;
    if (s == null || !s.retryOpen) return const SizedBox.shrink();
    final children = <Widget>[
      if (selected > 0) ...[
        FilledButton(
          key: const Key('retry-selected'),
          onPressed: retrying ? null : () => onRetrySelected(selected),
          child: Text(retrying ? MyContactsCopy.retrying : MyContactsCopy.retrySelected(selected)),
        ),
        TextButton(key: const Key('clear-selection'), onPressed: onClearSelection, child: const Text(MyContactsCopy.clearSelection)),
      ] else if (s.offersRetry)
        FilledButton.icon(
          key: const Key('retry-all'),
          onPressed: retrying ? null : () => onRetryAll(s.retry.eligible),
          icon: const Icon(Icons.replay),
          label: Text(retrying ? MyContactsCopy.retrying : MyContactsCopy.retryAll(s.retry.eligible)),
        ),
    ];
    if (children.isEmpty && s.retry.eligible == 0) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (children.isNotEmpty) Wrap(spacing: Space.sm, runSpacing: Space.xs, children: children),
          if (s.retry.eligible > 0 && selected == 0)
            Padding(
              padding: const EdgeInsets.only(top: Space.xs),
              child: Text(MyContactsCopy.selectHint, style: Theme.of(context).textTheme.bodySmall),
            ),
        ],
      ),
    );
  }
}

/// The number search (debounced) and the bucket filter.
class _FilterBar extends ConsumerStatefulWidget {
  const _FilterBar({required this.campaignId, required this.filters});

  final String campaignId;
  final MyContactsFilters filters;

  @override
  ConsumerState<_FilterBar> createState() => _FilterBarState();
}

class _FilterBarState extends ConsumerState<_FilterBar> {
  late final TextEditingController _text = TextEditingController(text: widget.filters.phone ?? '');
  final Debouncer _debounce = Debouncer(const Duration(milliseconds: 400));
  String? _problem;

  @override
  void dispose() {
    _debounce.dispose();
    _text.dispose();
    super.dispose();
  }

  void _apply() {
    if (!mounted) return;
    final raw = _text.text.trim();
    if (raw.isNotEmpty && !RegExp(r'\d').hasMatch(raw)) return;
    final controller = ref.read(myContactsControllerProvider(widget.campaignId).notifier);
    final current = ref.read(myContactsControllerProvider(widget.campaignId)).filters;
    final next = current.withPhone(raw);
    if (next != current) unawaited(controller.applyFilters(next));
  }

  void _onChanged(String raw) {
    final t = raw.trim();
    final problem = t.isEmpty || RegExp(r'\d').hasMatch(t) ? null : MyContactsCopy.searchProblem;
    if (problem != _problem) setState(() => _problem = problem);
    _debounce(_apply);
  }

  @override
  Widget build(BuildContext context) {
    final filters = widget.filters;
    final controller = ref.read(myContactsControllerProvider(widget.campaignId).notifier);
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            key: const Key('contacts-phone-search'),
            controller: _text,
            keyboardType: TextInputType.phone,
            textInputAction: TextInputAction.search,
            onChanged: _onChanged,
            onSubmitted: (_) => _debounce.flush(_apply),
            decoration: InputDecoration(
              isDense: true,
              prefixIcon: const Icon(Icons.search),
              labelText: MyContactsCopy.searchLabel,
              hintText: MyContactsCopy.searchHint,
              errorText: _problem,
            ),
          ),
          const SizedBox(height: Space.sm),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                ChoiceChip(
                  key: const Key('bucket-all'),
                  label: const Text(MyContactsCopy.allBuckets),
                  selected: filters.buckets.isEmpty,
                  onSelected: (_) => unawaited(controller.applyFilters(filters.withBuckets(const {}))),
                ),
                for (final b in MyContactBucket.values)
                  if (!b.isUnknown)
                    Padding(
                      padding: const EdgeInsets.only(left: Space.xs),
                      child: FilterChip(
                        key: Key('bucket-${b.wire}'),
                        label: Text(MyContactsCopy.bucketLabel(b)),
                        selected: filters.buckets.contains(b),
                        onSelected: (on) {
                          final next = {...filters.buckets};
                          on ? next.add(b) : next.remove(b);
                          unawaited(controller.applyFilters(filters.withBuckets(next)));
                        },
                      ),
                    ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// One contact: number, hero fields, where it stands and when it is next
/// due, the override it holds, and Call. Fixed height (a prototype row).
class _ContactTile extends StatelessWidget {
  const _ContactTile({
    super.key,
    required this.contact,
    required this.now,
    required this.selectable,
    required this.selected,
    required this.callable,
    required this.calling,
    this.onToggle,
    this.onCall,
  });

  final MyContact contact;
  final DateTime now;
  final bool selectable;
  final bool selected;
  final bool callable;
  final bool calling;
  final VoidCallback? onToggle;
  final VoidCallback? onCall;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final c = contact;
    final hero = c.hero.map((h) => h.value).where((v) => v.trim().isNotEmpty).join(' · ');
    final when = MyContactsCopy.whenLine(c, now);
    final grant = c.overrideGrant;
    final badge = grant == null || grant.kinds.isEmpty ? null : MyContactsCopy.overrideBadge(grant);
    return InkWell(
      onTap: onToggle,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.sm),
        child: Row(
          children: [
            SizedBox(
              width: 48,
              child: selectable
                  ? Checkbox(
                      key: Key('select-${c.id}'),
                      value: selected,
                      onChanged: onToggle == null ? null : (_) => onToggle!(),
                      semanticLabel: 'Pick for retry',
                    )
                  : null,
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(formatPhone(c.phoneE164), style: text.titleSmall, maxLines: 1, overflow: TextOverflow.ellipsis),
                  Text(hero, style: text.bodySmall, maxLines: 1, overflow: TextOverflow.ellipsis),
                  Text(
                    [MyContactsCopy.bucketLabel(c.bucket, raw: c.bucketRaw), ?when].join(' · '),
                    style: text.bodySmall!.copyWith(color: t.textSecondary),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (badge != null)
                    Text(
                      badge,
                      key: Key('override-${c.id}'),
                      style: text.labelSmall!.copyWith(color: t.warning),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    )
                  else
                    Text('', style: text.labelSmall),
                ],
              ),
            ),
            if (callable)
              OutlinedButton(
                key: Key('call-${c.id}'),
                onPressed: calling ? null : onCall,
                child: Semantics(
                  label: '${MyContactsCopy.call} ${formatPhone(c.phoneE164)}',
                  excludeSemantics: true,
                  child: Text(calling ? MyContactsCopy.calling : MyContactsCopy.call),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.filtered, required this.onClear});

  final bool filtered;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      key: const Key('my-contacts-empty'),
      padding: const EdgeInsets.all(Space.xl),
      child: Column(
        children: [
          Text(MyContactsCopy.emptyTitle, textAlign: TextAlign.center, style: text.titleMedium),
          const SizedBox(height: Space.xs),
          Text(
            filtered ? MyContactsCopy.emptyFilteredBody : MyContactsCopy.emptyBody,
            textAlign: TextAlign.center,
            style: text.bodySmall,
          ),
          if (filtered) TextButton(onPressed: onClear, child: const Text(MyContactsCopy.clearFilters)),
        ],
      ),
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({required this.state, required this.onRetryMore});

  final MyContactsState state;
  final VoidCallback onRetryMore;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final Widget child;
    if (state.moreError != null) {
      child = Column(
        children: [
          Text(state.moreError!, key: const Key('my-contacts-more-error'), style: text.bodySmall),
          TextButton(onPressed: onRetryMore, child: const Text('Try again')),
        ],
      );
    } else if (state.hasMore) {
      child = const Center(child: SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2)));
    } else {
      child = Text(MyContactsCopy.end, key: const Key('my-contacts-end'), textAlign: TextAlign.center, style: text.bodySmall);
    }
    return Padding(padding: const EdgeInsets.all(Space.lg), child: child);
  }
}

/// The calling-hours override note: [overrideNoteMin] to [overrideNoteMax] characters, checked as typed.
class _OverrideNoteDialog extends StatefulWidget {
  const _OverrideNoteDialog({required this.disposition});

  final String? disposition;

  @override
  State<_OverrideNoteDialog> createState() => _OverrideNoteDialogState();
}

class _OverrideNoteDialogState extends State<_OverrideNoteDialog> {
  final _text = TextEditingController();
  bool _touched = false;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final problem = overrideNoteProblem(_text.text);
    return AlertDialog(
      title: const Text(MyContactsCopy.noteTitle),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(MyContactsCopy.noteBody(widget.disposition)),
          const SizedBox(height: Space.md),
          TextField(
            key: const Key('override-note'),
            controller: _text,
            autofocus: true,
            minLines: 2,
            maxLines: 4,
            maxLength: overrideNoteMax,
            onChanged: (_) => setState(() => _touched = true),
            decoration: InputDecoration(
              labelText: MyContactsCopy.noteLabel,
              errorText: _touched ? problem : null,
            ),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text(MyContactsCopy.cancel)),
        FilledButton(
          key: const Key('override-note-confirm'),
          onPressed: problem == null ? () => Navigator.pop(context, _text.text.trim()) : null,
          child: const Text(MyContactsCopy.noteConfirm),
        ),
      ],
    );
  }
}

/// The shape every row is laid out by.
final _prototype = MyContact(
  id: 'prototype',
  campaignId: 'prototype',
  phoneE164: '+910000000000',
  bucket: MyContactBucket.notReached,
  state: ContactState.pending,
  attemptCount: 1,
  nextAttemptAt: DateTime.utc(2026),
  hero: const [HeroField(name: 'Name', value: 'Prototype')],
  retry: MyContactRetry(eligible: true, roundsUsed: 0),
  overrideGrant: ContactOverride(
    disposition: 'prototype',
    extraAttempts: 1,
    retryDelay: true,
    callingHours: true,
    grantedAt: DateTime.utc(2026),
  ),
);
