import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../app/theme/tokens.dart';
import '../../ui/primitives.dart';
import '../calls/logic/attempt_copy.dart' show attemptOutcomeLabels, outcomeTone;
import '../performance/logic/en_in_format.dart';
import 'customer_history_controller.dart';
import 'customer_history_copy.dart';

/// One number's history (`docs/customer-history.md` §3–§5): who it belongs
/// to in each campaign (hero fields, the campaign's status and the contact's
/// state), the totals, its DNC status, what is open (callbacks, overrides
/// with their follow-up, a call live now), and one timeline, newest first,
/// with the console's filters and "Load more". An agent never gets a call
/// page (CH8), so nothing here opens one; hidden notes say "Notes hidden", a
/// purged recording "Recording expired".
///
/// Reads the answer [customerHistoryControllerProvider] holds; with none (a
/// restart, another workspace) it offers to search.
class CustomerHistoryScreen extends ConsumerWidget {
  const CustomerHistoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(customerHistoryControllerProvider);
    final result = s.result;
    if (result == null) {
      return Scaffold(
        appBar: AppBar(title: const Text(CustomerHistoryCopy.searchTitle)),
        body: Center(
          key: const Key('customer-no-result'),
          child: Padding(
            padding: const EdgeInsets.all(Space.xl),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text(CustomerHistoryCopy.noResult, textAlign: TextAlign.center),
                const SizedBox(height: Space.lg),
                OutlinedButton(
                  onPressed: () => context.go(Routes.customerSearch),
                  child: const Text(CustomerHistoryCopy.openSearch),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final controller = ref.read(customerHistoryControllerProvider.notifier);
    final summary = result.summary;
    final showAccounts = _severalAccounts(result);
    return Scaffold(
      appBar: AppBar(
        title: Semantics(
          header: true,
          child: Text(CustomerHistoryCopy.resultsFor(result.key.display), key: const Key('customer-results-title')),
        ),
        actions: [_CopyNumberButton(value: result.key.value)],
      ),
      body: ListView(
        key: const Key('customer-history'),
        padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.xl),
        children: [
          if (s.expired) ...[
            _Notice(
              key: const Key('customer-expired'),
              message: CustomerHistoryCopy.expired,
              // A "Search again" that failed (the cap, offline) says why here.
              error: s.searchError,
              action: CustomerHistoryCopy.searchAgain,
              busy: s.searching,
              onAction: s.searching ? null : () => unawaited(controller.searchAgain()),
            ),
            const SizedBox(height: Space.md),
          ],
          if (_isEmptyHistory(result)) ...[
            const _Empty(),
            _Dnc(summary.dnc),
          ] else ...[
            for (final (i, live) in summary.open.liveCalls.indexed) ...[
              _LiveCall(live, index: i),
              const SizedBox(height: Space.sm),
            ],
            _Totals(summary.totals),
            const SizedBox(height: Space.md),
            _Dnc(summary.dnc),
            if (summary.open.callbacks.isNotEmpty || summary.open.overrides.isNotEmpty) ...[
              const SizedBox(height: Space.lg),
              const SectionLabel(CustomerHistoryCopy.open),
              const SizedBox(height: Space.sm),
              for (final c in summary.open.callbacks) _OpenCallback(c),
              for (final (i, o) in summary.open.overrides.indexed) _OpenOverride(o, index: i),
            ],
            if (summary.contacts.isNotEmpty) ...[
              const SizedBox(height: Space.lg),
              const SectionLabel(CustomerHistoryCopy.contacts),
              const SizedBox(height: Space.sm),
              for (final c in summary.contacts) ...[
                _Contact(c, showAccount: showAccounts),
                const SizedBox(height: Space.sm),
              ],
              // More roster rows than the history covers: the oldest were left out
              // of the summary, the timeline and the counts alike (CH14).
              if (summary.contactsTruncated)
                Text(
                  CustomerHistoryCopy.contactsTruncated,
                  key: const Key('customer-contacts-truncated'),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
            ],
            const SizedBox(height: Space.lg),
            const SectionLabel(CustomerHistoryCopy.history),
            const SizedBox(height: Space.sm),
            _Filters(
              filter: s.filter,
              options: summary.filterOptions,
              enabled: !s.expired,
              onChanged: (f) => unawaited(controller.applyFilter(f)),
            ),
            const SizedBox(height: Space.sm),
            ..._timeline(context, s, controller),
          ],
        ],
      ),
    );
  }

  List<Widget> _timeline(BuildContext context, CustomerHistoryState s, CustomerHistoryController controller) {
    final text = Theme.of(context).textTheme;
    if (s.loadingTimeline) {
      return const [
        Padding(
          padding: EdgeInsets.all(Space.lg),
          child: Center(child: CircularProgressIndicator(key: Key('customer-timeline-loading'))),
        ),
      ];
    }
    final error = s.timelineError;
    if (error != null && !s.expired) {
      return [
        _Notice(
          key: const Key('customer-timeline-error'),
          message: error,
          action: CustomerHistoryCopy.tryAgain,
          onAction: () => unawaited(controller.applyFilter(s.filter)),
        ),
      ];
    }
    final moreError = s.moreError;
    return [
      // After expiry the page knows nothing more: neither "nothing matches"
      // nor "the whole history" is true then.
      if (s.entries.isEmpty && s.filter.isFiltered && !s.expired)
        Padding(
          padding: const EdgeInsets.all(Space.lg),
          child: Text(
            CustomerHistoryCopy.noEntriesFiltered,
            key: const Key('customer-timeline-none'),
            textAlign: TextAlign.center,
            style: text.bodySmall,
          ),
        ),
      ..._entryRows(s.entries),
      if (moreError != null && !s.expired)
        _Notice(
          key: const Key('customer-more-error'),
          message: moreError,
          action: CustomerHistoryCopy.tryAgain,
          onAction: () => unawaited(controller.loadMore()),
        )
      else if (s.hasMore && !s.expired)
        Padding(
          padding: const EdgeInsets.only(top: Space.sm),
          child: OutlinedButton(
            key: const Key('customer-load-more'),
            onPressed: s.loadingMore ? null : () => unawaited(controller.loadMore()),
            child: s.loadingMore
                ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text(CustomerHistoryCopy.loadMore),
          ),
        )
      else if (s.entries.isNotEmpty && !s.expired)
        Padding(
          padding: const EdgeInsets.all(Space.lg),
          child: Text(
            CustomerHistoryCopy.endOfHistory,
            key: const Key('customer-history-end'),
            textAlign: TextAlign.center,
            style: text.bodySmall,
          ),
        ),
    ];
  }
}

/// No history, the console's rule (`isEmptyCustomerHistory`): no timeline
/// entry of any kind (a call, a callback, a DNC mark, a roster entry), no call
/// live now and no roster row.
bool _isEmptyHistory(CustomerSearchResponse r) =>
    r.timeline.entries.isEmpty && r.summary.open.liveCalls.isEmpty && r.summary.contacts.isEmpty;

/// Whether the answer spans more than one account: only then is each
/// contact's account named, as the console does.
bool _severalAccounts(CustomerSearchResponse r) {
  final ids = <String>{
    for (final c in r.summary.contacts) c.accountId,
    for (final d in r.summary.dnc) ?d.accountId,
    for (final e in r.timeline.entries) ?e.accountId,
  };
  return ids.length > 1;
}

// ─── Summary ────────────────────────────────────────────────────────────────

/// Copies the searched number. No event is sent for it: the number never goes
/// to analytics.
class _CopyNumberButton extends StatelessWidget {
  const _CopyNumberButton({required this.value});

  final String value;

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text(CustomerHistoryCopy.numberCopied)));
  }

  @override
  Widget build(BuildContext context) {
    return IconButton(
      key: const Key('customer-copy-number'),
      tooltip: CustomerHistoryCopy.copyNumber,
      icon: const Icon(Icons.copy_outlined),
      onPressed: () => unawaited(_copy(context)),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty();

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      key: const Key('customer-empty'),
      padding: const EdgeInsets.symmetric(vertical: Space.xxl, horizontal: Space.lg),
      child: Column(
        children: [
          Icon(Icons.search_off, size: 32, color: context.tokens.textMuted),
          const SizedBox(height: Space.md),
          Text(CustomerHistoryCopy.empty, textAlign: TextAlign.center, style: text.titleMedium),
          const SizedBox(height: Space.xs),
          Text(CustomerHistoryCopy.emptyBody, textAlign: TextAlign.center, style: text.bodySmall),
        ],
      ),
    );
  }
}

class _LiveCall extends StatelessWidget {
  const _LiveCall(this.call, {required this.index});

  final CustomerHistoryLiveCall call;

  /// Its place in `open.live_calls`: one number can be on two calls at once.
  final int index;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final where = call.campaign?.name ??
        (call.channel == CustomerTimelineChannel.softphone ? 'Soft phone' : '');
    final who = call.agent == null ? null : personName(call.agent);
    return AppCard(
      key: Key('customer-live-$index'),
      color: t.emberSubtle,
      borderColor: t.emberSubtle,
      child: Row(
        children: [
          const LiveDot(),
          const SizedBox(width: Space.sm),
          Expanded(
            child: Text(
              [CustomerHistoryCopy.liveNow, if (where.isNotEmpty) where, ?who].join(' · '),
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
        ],
      ),
    );
  }
}

class _Totals extends StatelessWidget {
  const _Totals(this.totals);

  final CustomerHistoryTotals totals;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final last = totals.lastContacted;
    final String lastLine;
    if (last == null) {
      lastLine = CustomerHistoryCopy.neverContacted;
    } else {
      final channel = last.channel == CustomerTimelineChannel.softphone ? 'soft phone' : 'campaign';
      final outcome = last.outcomeRaw == null ? null : (attemptOutcomeLabels[last.outcome] ?? last.outcomeRaw);
      lastLine = [
        '${CustomerHistoryCopy.lastContacted} ${EnIn.timestamp(last.at)}',
        if (last.agent != null) 'by ${personName(last.agent)}',
        channel,
        ?outcome,
        ?last.dispositionCode,
      ].join(' · ');
    }
    return AppCard(
      key: const Key('customer-totals'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(CustomerHistoryCopy.totalsLine(totals.calls, totals.connected), style: text.titleSmall),
          const SizedBox(height: Space.xs),
          Text(lastLine, key: const Key('customer-last-contacted'), style: text.bodySmall),
        ],
      ),
    );
  }
}

/// The number's DNC status, always shown: where it applies, when, by whom
/// and why, or "Not on any do-not-call list".
class _Dnc extends StatelessWidget {
  const _Dnc(this.entries);

  final List<CustomerHistoryDncEntry> entries;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    if (entries.isEmpty) {
      return Row(
        key: const Key('customer-dnc-none'),
        children: [
          Icon(Icons.check_circle_outline, size: 18, color: t.success),
          const SizedBox(width: Space.sm),
          Expanded(child: Text(CustomerHistoryCopy.notOnDnc, style: text.bodyMedium)),
        ],
      );
    }
    return AppCard(
      key: const Key('customer-dnc'),
      color: t.dangerSubtle,
      borderColor: t.dangerSubtle,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.block, size: 18, color: t.danger),
              const SizedBox(width: Space.sm),
              Text(CustomerHistoryCopy.dnc, style: text.titleSmall),
            ],
          ),
          for (final e in entries) ...[
            const SizedBox(height: Space.xs),
            Text(
              [
                dncScopeLabel(e),
                EnIn.timestamp(e.createdAt),
                if (e.addedBy != null) 'by ${e.addedBy}',
                ?e.reason,
              ].join(' · '),
              style: text.bodySmall,
            ),
          ],
        ],
      ),
    );
  }
}

class _OpenCallback extends StatelessWidget {
  const _OpenCallback(this.callback);

  final CustomerHistoryOpenCallback callback;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.xs),
      child: Text(
        [
          'Callback due ${EnIn.timestamp(callback.dueAt)}',
          callback.campaign.name,
          if (callback.owner == null) 'for the shared pool' else 'for ${personName(callback.owner)}',
          if (callback.bookedBy != null) 'booked by ${personName(callback.bookedBy)}',
        ].join(' · '),
        key: Key('customer-open-callback-${callback.contactId}'),
        style: text.bodyMedium,
      ),
    );
  }
}

class _OpenOverride extends StatelessWidget {
  const _OpenOverride(this.grant, {required this.index});

  final CustomerHistoryOpenOverride grant;

  /// Its place in `open.overrides`: one contact can hold more than one grant.
  final int index;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final followUp = grant.followUpAt;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.xs),
      child: Text(
        [
          'Override from ${grant.dispositionCode}',
          grant.campaign.name,
          overrideGrantLabel(grant),
          if (followUp != null)
            CustomerHistoryCopy.followUp(EnIn.timestamp(followUp))
          else
            CustomerHistoryCopy.noFollowUp,
        ].join(' · '),
        key: Key('customer-open-override-${grant.contactId}-$index'),
        style: text.bodyMedium,
      ),
    );
  }
}

class _Contact extends StatelessWidget {
  const _Contact(this.contact, {required this.showAccount});

  final CustomerHistoryContact contact;

  /// Name the account: only when the answer spans more than one.
  final bool showAccount;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final c = contact;
    final hero = c.fields.map((f) => f.value).where((v) => v.trim().isNotEmpty).join(' · ');
    final suppressed =
        c.suppressedReason == null ? null : (suppressedReasonLabels[c.suppressedReason] ?? c.suppressedReason);
    final meta = [
      if (showAccount && c.accountName != null) c.accountName!,
      '${c.attemptCount} call${c.attemptCount == 1 ? '' : 's'} placed',
      if (c.assignedTo == null)
        CustomerHistoryCopy.pool
      else
        CustomerHistoryCopy.assignedTo(personName(c.assignedTo)),
    ].join(' · ');
    final file = c.uploadFileName;
    final entered = 'Added ${EnIn.timestamp(c.enteredAt)}${file == null ? '' : ' from $file'}';
    return AppCard(
      key: Key('customer-contact-${c.contactId}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  hero.isEmpty ? CustomerHistoryCopy.noFields : hero,
                  style: text.titleSmall,
                ),
              ),
              const SizedBox(width: Space.sm),
              StatusPill(contactStateLabel(c), tone: contactStateTone(c.state)),
            ],
          ),
          const SizedBox(height: Space.xs),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: Text(c.campaign.name, style: text.bodyMedium)),
              const SizedBox(width: Space.sm),
              StatusPill(
                campaignStatusLabel(c.campaign),
                key: Key('customer-campaign-status-${c.contactId}'),
                tone: campaignStatusTone(c.campaign.status),
              ),
            ],
          ),
          if (c.campaigns.length > 1)
            Text(
              'Chain: ${c.campaigns.map((x) => x.name).join(' → ')}',
              style: text.bodySmall,
            ),
          if (suppressed != null) Text(suppressed, style: text.bodySmall),
          Text(meta, style: text.bodySmall),
          Text(entered, style: text.bodySmall),
        ],
      ),
    );
  }
}

// ─── Timeline ───────────────────────────────────────────────────────────────

/// The channel and connected-only chips on the page; the campaign, the days,
/// the outcome, the code and the agent in a sheet ("Filters"), so the page
/// stays one column on a phone. Every change reads the first page again.
class _Filters extends StatelessWidget {
  const _Filters({required this.filter, required this.options, required this.enabled, required this.onChanged});

  final CustomerHistoryFilter filter;
  final CustomerHistoryFilterOptions options;
  final bool enabled;
  final ValueChanged<CustomerHistoryFilter> onChanged;

  Future<void> _openSheet(BuildContext context) async {
    final picked = await showModalBottomSheet<CustomerHistoryFilter>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => _FiltersSheet(initial: filter, options: options),
    );
    if (picked != null) onChanged(picked);
  }

  @override
  Widget build(BuildContext context) {
    Widget channel(String label, CustomerTimelineChannel? value, String key) => ChoiceChip(
      key: Key(key),
      label: Text(label),
      selected: filter.channel == value,
      onSelected: enabled ? (_) => onChanged(filter.withChannel(value)) : null,
    );
    final more = filter.sheetCount;
    return Wrap(
      spacing: Space.sm,
      runSpacing: Space.xs,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        channel(CustomerHistoryCopy.all, null, 'customer-filter-all'),
        channel(CustomerHistoryCopy.campaignCalls, CustomerTimelineChannel.campaign, 'customer-filter-campaign'),
        channel(CustomerHistoryCopy.softphoneCalls, CustomerTimelineChannel.softphone, 'customer-filter-softphone'),
        FilterChip(
          key: const Key('customer-filter-connected'),
          label: const Text(CustomerHistoryCopy.connectedOnly),
          selected: filter.connectedOnly,
          onSelected: enabled ? (on) => onChanged(filter.withConnectedOnly(on)) : null,
        ),
        FilterChip(
          key: const Key('customer-filter-more'),
          avatar: const Icon(Icons.tune, size: 18),
          label: Text(more == 0 ? CustomerHistoryCopy.filters : CustomerHistoryCopy.filtersSet(more)),
          selected: more > 0,
          showCheckmark: false,
          onSelected: enabled ? (_) => unawaited(_openSheet(context)) : null,
        ),
        if (filter.isFiltered)
          TextButton(
            key: const Key('customer-filter-clear'),
            onPressed: enabled ? () => onChanged(CustomerHistoryFilter.none) : null,
            child: const Text(CustomerHistoryCopy.clearFilters),
          ),
      ],
    );
  }
}

/// The sheet's filters, each one choice from the summary's `filter_options`,
/// applied together. The channel and connected-only chips are kept as they
/// are on the page.
class _FiltersSheet extends StatefulWidget {
  const _FiltersSheet({required this.initial, required this.options});

  final CustomerHistoryFilter initial;
  final CustomerHistoryFilterOptions options;

  @override
  State<_FiltersSheet> createState() => _FiltersSheetState();
}

class _FiltersSheetState extends State<_FiltersSheet> {
  // A choice the options no longer list is dropped as the sheet opens, so
  // Apply never sends it again.
  late String? _campaignId = _listed(widget.initial.campaignId, widget.options.campaigns.map((c) => c.id));
  late DateTime? _fromDay = widget.initial.fromDay;
  late DateTime? _toDay = widget.initial.toDay;
  late AttemptOutcome? _outcome =
      _listed(widget.initial.outcome, widget.options.outcomes.where((o) => !o.isUnknown));
  late String? _code = _listed(widget.initial.dispositionCode, widget.options.dispositionCodes);
  late String? _agent = _listed(widget.initial.agentUserId, widget.options.agents.map((a) => a.userId));

  static T? _listed<T extends Object>(T? value, Iterable<T> options) =>
      value != null && options.contains(value) ? value : null;

  CustomerHistoryFilter get _draft => CustomerHistoryFilter(
    channel: widget.initial.channel,
    connectedOnly: widget.initial.connectedOnly,
    campaignId: _campaignId,
    fromDay: _fromDay,
    toDay: _toDay,
    outcome: _outcome,
    dispositionCode: _code,
    agentUserId: _agent,
  );

  Future<void> _pickDay({required bool from}) async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final first = DateTime(now.year - 5);
    final current = from ? _fromDay : _toDay;
    final picked = await showDatePicker(
      context: context,
      initialDate: current == null || current.isAfter(today) || current.isBefore(first) ? today : current,
      firstDate: first,
      lastDate: today,
      helpText: from ? CustomerHistoryCopy.from : CustomerHistoryCopy.to,
    );
    if (picked == null || !mounted) return;
    setState(() {
      if (from) {
        _fromDay = picked;
      } else {
        _toDay = picked;
      }
    });
  }

  void _reset() {
    setState(() {
      _campaignId = null;
      _fromDay = null;
      _toDay = null;
      _outcome = null;
      _code = null;
      _agent = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final draft = _draft;
    final problem = draft.dateProblem;
    final o = widget.options;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: Space.lg),
              child: SectionLabel(CustomerHistoryCopy.filtersTitle),
            ),
            Flexible(
              child: ListView(
                key: const Key('customer-filters-sheet'),
                shrinkWrap: true,
                padding: const EdgeInsets.symmetric(horizontal: Space.lg),
                children: [
                  _Choice<String?>(
                    id: 'customer-filter-campaign-choice',
                    label: CustomerHistoryCopy.campaign,
                    value: _campaignId,
                    items: [
                      (null, CustomerHistoryCopy.allCampaigns),
                      for (final c in o.campaigns) (c.id, c.name ?? CustomerHistoryCopy.unnamedCampaign),
                    ],
                    onChanged: (v) => setState(() => _campaignId = v),
                  ),
                  _DayButton(
                    id: 'customer-filter-from',
                    label: CustomerHistoryCopy.from,
                    day: _fromDay,
                    onPick: () => unawaited(_pickDay(from: true)),
                    onClear: () => setState(() => _fromDay = null),
                  ),
                  _DayButton(
                    id: 'customer-filter-to',
                    label: CustomerHistoryCopy.to,
                    day: _toDay,
                    onPick: () => unawaited(_pickDay(from: false)),
                    onClear: () => setState(() => _toDay = null),
                  ),
                  if (problem != null)
                    Padding(
                      padding: const EdgeInsets.only(top: Space.xs),
                      child: Text(
                        problem,
                        key: const Key('customer-filter-date-problem'),
                        style: text.bodySmall!.copyWith(color: t.danger),
                      ),
                    ),
                  _Choice<AttemptOutcome?>(
                    id: 'customer-filter-outcome-choice',
                    label: CustomerHistoryCopy.outcome,
                    value: _outcome,
                    items: [
                      (null, CustomerHistoryCopy.allOutcomes),
                      for (final outcome in o.outcomes)
                        if (!outcome.isUnknown) (outcome, attemptOutcomeLabels[outcome] ?? outcome.wire),
                    ],
                    onChanged: (v) => setState(() => _outcome = v),
                  ),
                  _Choice<String?>(
                    id: 'customer-filter-code-choice',
                    label: CustomerHistoryCopy.outcomeCode,
                    value: _code,
                    items: [
                      (null, CustomerHistoryCopy.allCodes),
                      for (final code in o.dispositionCodes) (code, code),
                    ],
                    onChanged: (v) => setState(() => _code = v),
                  ),
                  _Choice<String?>(
                    id: 'customer-filter-agent-choice',
                    label: CustomerHistoryCopy.agent,
                    value: _agent,
                    items: [
                      (null, CustomerHistoryCopy.allAgents),
                      for (final a in o.agents) (a.userId, personName(a)),
                    ],
                    onChanged: (v) => setState(() => _agent = v),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(Space.lg, Space.md, Space.lg, Space.lg),
              child: Row(
                children: [
                  if (draft.sheetCount > 0)
                    TextButton(
                      key: const Key('customer-filters-reset'),
                      onPressed: _reset,
                      child: const Text(CustomerHistoryCopy.clearFilters),
                    ),
                  const Spacer(),
                  FilledButton(
                    key: const Key('customer-filters-apply'),
                    onPressed: problem == null ? () => Navigator.pop(context, draft) : null,
                    child: const Text(CustomerHistoryCopy.apply),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One single-choice filter: a labelled dropdown, the first item "All …".
class _Choice<T> extends StatelessWidget {
  const _Choice({
    required this.id,
    required this.label,
    required this.value,
    required this.items,
    required this.onChanged,
  });

  final String id;
  final String label;
  final T value;
  final List<(T, String)> items;
  final ValueChanged<T> onChanged;

  @override
  Widget build(BuildContext context) {
    // A choice the options no longer list reads as the first ("All …").
    final shown = items.any((i) => i.$1 == value) ? value : items.first.$1;
    return Padding(
      padding: const EdgeInsets.only(top: Space.md),
      child: InputDecorator(
        decoration: InputDecoration(
          labelText: label,
          contentPadding: const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.xs),
        ),
        child: DropdownButtonHideUnderline(
          child: DropdownButton<T>(
            key: Key(id),
            value: shown,
            isExpanded: true,
            items: [
              for (final (v, l) in items)
                DropdownMenuItem<T>(value: v, child: Text(l, overflow: TextOverflow.ellipsis)),
            ],
            onChanged: (v) => onChanged(v as T),
          ),
        ),
      ),
    );
  }
}

/// A calendar day for the date range, "Any day" when open, with a way to
/// open it again.
class _DayButton extends StatelessWidget {
  const _DayButton({
    required this.id,
    required this.label,
    required this.day,
    required this.onPick,
    required this.onClear,
  });

  final String id;
  final String label;
  final DateTime? day;
  final VoidCallback onPick;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final day = this.day;
    return Padding(
      padding: const EdgeInsets.only(top: Space.md),
      child: Row(
        children: [
          Expanded(
            child: OutlinedButton(
              key: Key(id),
              onPressed: onPick,
              child: Text(
                '$label: ${day == null ? CustomerHistoryCopy.anyDay : EnIn.dayMonthYear(day)}',
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          if (day != null)
            IconButton(
              key: Key('$id-clear'),
              tooltip: CustomerHistoryCopy.clearDay(label),
              icon: const Icon(Icons.close),
              onPressed: onClear,
            ),
        ],
      ),
    );
  }
}

/// The outcome pill of a call: the saved outcome's words, "Not classified"
/// for none, a value this build does not know as sent.
Widget _outcomePill(AttemptOutcome? outcome, String? raw) {
  if (raw == null) return const StatusPill(CustomerHistoryCopy.notClassified);
  return StatusPill(attemptOutcomeLabels[outcome] ?? raw, tone: outcomeTone(outcome));
}

String _recordingLabel(CustomerRecordingState r) => switch (r) {
  CustomerRecordingState.available => CustomerHistoryCopy.recorded,
  CustomerRecordingState.expired => CustomerHistoryCopy.recordingExpired,
  CustomerRecordingState.notRecorded => CustomerHistoryCopy.notRecorded,
  CustomerRecordingState.noCall || CustomerRecordingState.unknown => '',
};

/// `a · b · c`, empty parts left out.
String _joined(List<String?> parts) => parts.whereType<String>().where((p) => p.isNotEmpty).join(' · ');

/// The timeline's rows. A wrap-up redial names its chain's first attempt
/// (`chain_attempt_id`) and the dial it redialled (`redial_of_attempt_id`):
/// each says which call it redialled, the first says how often it was
/// redialled (the console's words), and a chain whose rows sit together
/// (newest first) is drawn as one, joined down the side.
List<Widget> _entryRows(List<CustomerTimelineEntry> entries) {
  final firsts = <String, CustomerTimelineCampaignCall>{};
  final redials = <String, int>{};
  for (final e in entries) {
    if (e is! CustomerTimelineCampaignCall) continue;
    if (e.redialOfAttemptId != null) {
      redials[e.chainAttemptId] = (redials[e.chainAttemptId] ?? 0) + 1;
    } else if (e.attemptId == e.chainAttemptId) {
      firsts[e.attemptId] = e;
    }
  }
  String? chainLine(CustomerTimelineEntry e) {
    if (e is! CustomerTimelineCampaignCall) return null;
    if (e.redialOfAttemptId != null) {
      final first = firsts[e.chainAttemptId];
      return CustomerHistoryCopy.wrapUpRedialOf(e.redialNumber, first == null ? null : EnIn.timestamp(first.at));
    }
    final n = redials[e.attemptId] ?? 0;
    return n == 0 ? null : CustomerHistoryCopy.redialledInWrapUp(n);
  }

  final rows = <Widget>[];
  var i = 0;
  while (i < entries.length) {
    final e = entries[i];
    if (e is CustomerTimelineCampaignCall) {
      var j = i + 1;
      while (j < entries.length) {
        final next = entries[j];
        if (next is! CustomerTimelineCampaignCall || next.chainAttemptId != e.chainAttemptId) break;
        j++;
      }
      if (j - i > 1) {
        rows.add(
          _Chain(
            // A chain split by other rows (or a page break) is drawn more than
            // once: its first row's key tells the pieces apart.
            id: '${e.chainAttemptId}-${e.key}',
            children: [for (final x in entries.sublist(i, j)) _Entry(x, chainLine: chainLine(x))],
          ),
        );
        i = j;
        continue;
      }
    }
    rows.add(_Entry(e, chainLine: chainLine(e)));
    i++;
  }
  return rows;
}

/// A campaign call and its wrap-up redials, joined by a rule down the side.
class _Chain extends StatelessWidget {
  const _Chain({required this.id, required this.children});

  final String id;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return DecoratedBox(
      key: Key('customer-chain-$id'),
      decoration: BoxDecoration(border: Border(left: BorderSide(color: t.borderStrong, width: 2))),
      child: Padding(
        padding: const EdgeInsets.only(left: Space.sm),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
      ),
    );
  }
}

/// One timeline entry, worded for its row.
@immutable
class _EntryView {
  const _EntryView({
    required this.icon,
    required this.title,
    this.lines = const [],
    this.pill,
    this.notes,
    this.notesHidden = false,
  });

  final IconData icon;
  final String title;
  final List<String> lines;
  final Widget? pill;
  final String? notes;
  final bool notesHidden;
}

_EntryView _viewOf(CustomerTimelineEntry entry) => switch (entry) {
  final CustomerTimelineCampaignCall c => _EntryView(
    icon: Icons.call_outlined,
    title: 'Campaign call · ${c.campaign.name}',
    lines: [
      _joined([
        CustomerHistoryCopy.attempt(c.attemptNumber),
        if (c.agent != null) personName(c.agent),
        if (c.talkSeconds != null) EnIn.talkTime(c.talkSeconds),
      ]),
      _joined([c.dispositionCode, _recordingLabel(c.recording)]),
      if (c.callbackAt != null) 'Callback booked for ${EnIn.timestamp(c.callbackAt)}',
      if (c.overrideApplied.isNotEmpty)
        _joined([CustomerHistoryCopy.overrideUsed(overrideAppliedLabel(c)), c.overrideNote]),
    ],
    pill: _outcomePill(c.outcome, c.outcomeRaw),
    notes: c.notes,
    notesHidden: c.notesHidden,
  ),
  final CustomerTimelineSoftphoneCall c => _EntryView(
    icon: Icons.dialpad_outlined,
    title: 'Soft-phone call · ${c.campaign?.name ?? CustomerHistoryCopy.untagged}',
    lines: [
      _joined([
        if (c.agent != null) personName(c.agent),
        if (c.talkSeconds != null) EnIn.talkTime(c.talkSeconds),
      ]),
      _joined([c.dispositionCode, _recordingLabel(c.recording)]),
      if (c.callbackAt != null) 'Callback booked for ${EnIn.timestamp(c.callbackAt)}',
      // The call fields, hidden with the notes where the reader may not see them (CH8).
      for (final f in (c.fields ?? const <String, Object?>{}).entries) '${f.key}: ${fieldValueLabel(f.value)}',
      if (c.dncOverrideNote != null) CustomerHistoryCopy.dncOverride(c.dncOverrideNote!),
      if (c.hoursOverrideNote != null) CustomerHistoryCopy.hoursOverride(c.hoursOverrideNote!),
    ],
    pill: _outcomePill(c.outcome, c.outcomeRaw),
    notes: c.notes,
    notesHidden: c.notesHidden,
  ),
  final CustomerTimelineCallback c => _EntryView(
    icon: Icons.event_outlined,
    title: 'Callback booked · ${c.campaign?.name ?? CustomerHistoryCopy.untagged}',
    lines: [
      'Due ${EnIn.timestamp(c.dueAt)}',
      if (c.bookedBy != null) 'Booked by ${personName(c.bookedBy)}',
      if (c.dialledAt != null) 'Dialled ${EnIn.timestamp(c.dialledAt)}',
    ],
    pill: StatusPill(callbackStatusLabels[c.status] ?? c.statusRaw, tone: callbackStatusTone(c.status)),
  ),
  final CustomerTimelineDncMark d => _EntryView(
    icon: Icons.block,
    title: 'Added to a do-not-call list',
    lines: [
      _joined([
        dncScopeLabel(d.entry),
        if (d.entry.addedBy != null) 'by ${d.entry.addedBy}',
        d.entry.reason,
      ]),
    ],
  ),
  final CustomerTimelineRosterEntry r => _EntryView(
    icon: Icons.playlist_add,
    title: r.uploadFileName == null
        ? 'Added to ${r.campaign.name}'
        : 'Added to ${r.campaign.name} from ${r.uploadFileName}',
  ),
  CustomerTimelineUnknownEntry() => const _EntryView(icon: Icons.more_horiz, title: CustomerHistoryCopy.unknownEntry),
};

class _Entry extends StatelessWidget {
  const _Entry(this.entry, {this.chainLine});

  final CustomerTimelineEntry entry;

  /// Where a campaign call sits in its wrap-up redial chain, if it is in one.
  final String? chainLine;

  @override
  Widget build(BuildContext context) {
    final view = _viewOf(entry);
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final lines = [...view.lines.take(1), ?chainLine, ...view.lines.skip(1)].where((l) => l.isNotEmpty).toList();
    final notes = view.notes;
    final pill = view.pill;
    return Padding(
      key: Key('customer-entry-${entry.key}'),
      padding: const EdgeInsets.symmetric(vertical: Space.sm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(view.icon, size: 20, color: t.textSecondary),
          const SizedBox(width: Space.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(child: Text(view.title, style: text.titleSmall)),
                    if (pill != null) ...[const SizedBox(width: Space.sm), pill],
                  ],
                ),
                Text(EnIn.timestamp(entry.at), style: text.labelSmall),
                for (final l in lines) Text(l, style: text.bodySmall),
                if (view.notesHidden)
                  Text(
                    CustomerHistoryCopy.notesHidden,
                    key: Key('customer-notes-hidden-${entry.key}'),
                    style: text.bodySmall!.copyWith(fontStyle: FontStyle.italic, color: t.textMuted),
                  )
                else if (notes != null && notes.trim().isNotEmpty)
                  Text(notes, style: text.bodySmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A warning with one action: an expired search ("Search again", with why a
/// search again failed in [error]), a page that did not load ("Try again").
class _Notice extends StatelessWidget {
  const _Notice({
    super.key,
    required this.message,
    required this.action,
    required this.onAction,
    this.error,
    this.busy = false,
  });

  final String message;
  final String? error;
  final String action;
  final VoidCallback? onAction;

  /// The action is running: a spinner in its place.
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final error = this.error;
    return AppCard(
      color: t.warningSubtle,
      borderColor: t.warningSubtle,
      padding: const EdgeInsets.fromLTRB(Space.md, Space.xs, Space.xs, Space.xs),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(message, style: text.bodySmall),
                  if (error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: Space.xs),
                      child: Text(
                        error,
                        key: const Key('customer-notice-error'),
                        style: text.bodySmall!.copyWith(color: t.danger),
                      ),
                    ),
                ],
              ),
            ),
          ),
          TextButton(
            onPressed: onAction,
            child: busy
                ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : Text(action),
          ),
        ],
      ),
    );
  }
}
