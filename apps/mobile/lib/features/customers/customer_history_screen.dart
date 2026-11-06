import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
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
/// to in each campaign (hero fields and state), the totals, its DNC status,
/// what is open (callbacks, overrides, a call live now), and one timeline,
/// newest first, with "Load more". An agent never gets a call page (CH8), so
/// nothing here opens one; hidden notes say "Notes hidden", a purged
/// recording "Recording expired".
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
    return Scaffold(
      appBar: AppBar(
        title: Semantics(
          header: true,
          child: Text(CustomerHistoryCopy.resultsFor(result.key.display), key: const Key('customer-results-title')),
        ),
      ),
      body: ListView(
        key: const Key('customer-history'),
        padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.xl),
        children: [
          if (s.expired) ...[
            _Notice(
              key: const Key('customer-expired'),
              message: CustomerHistoryCopy.expired,
              action: CustomerHistoryCopy.searchAgain,
              onAction: s.searching ? null : () => unawaited(controller.searchAgain()),
            ),
            const SizedBox(height: Space.md),
          ],
          if (result.isEmpty)
            const _Empty()
          else ...[
            for (final live in summary.open.liveCalls) ...[_LiveCall(live), const SizedBox(height: Space.sm)],
            _Totals(summary.totals),
            const SizedBox(height: Space.md),
            _Dnc(summary.dnc),
            if (summary.open.callbacks.isNotEmpty || summary.open.overrides.isNotEmpty) ...[
              const SizedBox(height: Space.lg),
              const SectionLabel(CustomerHistoryCopy.open),
              const SizedBox(height: Space.sm),
              for (final c in summary.open.callbacks) _OpenCallback(c),
              for (final o in summary.open.overrides) _OpenOverride(o),
            ],
            if (summary.contacts.isNotEmpty) ...[
              const SizedBox(height: Space.lg),
              const SectionLabel(CustomerHistoryCopy.contacts),
              const SizedBox(height: Space.sm),
              for (final c in summary.contacts) ...[_Contact(c), const SizedBox(height: Space.sm)],
            ],
            const SizedBox(height: Space.lg),
            const SectionLabel(CustomerHistoryCopy.history),
            const SizedBox(height: Space.sm),
            _Filters(
              filter: s.filter,
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
          action: 'Try again',
          onAction: () => unawaited(controller.applyFilter(s.filter)),
        ),
      ];
    }
    return [
      if (s.entries.isEmpty && s.filter.isFiltered)
        Padding(
          padding: const EdgeInsets.all(Space.lg),
          child: Text(CustomerHistoryCopy.noEntriesFiltered, textAlign: TextAlign.center, style: text.bodySmall),
        ),
      for (final e in s.entries) _Entry(e),
      if (s.moreError != null && !s.expired)
        _Notice(
          key: const Key('customer-more-error'),
          message: s.moreError!,
          action: 'Try again',
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
      else if (s.entries.isNotEmpty)
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

// ─── Summary ────────────────────────────────────────────────────────────────

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
  const _LiveCall(this.call);

  final CustomerHistoryLiveCall call;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final where = call.campaign?.name ??
        (call.channel == CustomerTimelineChannel.softphone ? 'Soft phone' : '');
    final who = call.agent == null ? null : personName(call.agent);
    return AppCard(
      key: const Key('customer-live'),
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
          'for ${personName(callback.owner, none: CustomerHistoryCopy.pool)}',
        ].join(' · '),
        key: Key('customer-open-callback-${callback.contactId}'),
        style: text.bodyMedium,
      ),
    );
  }
}

class _OpenOverride extends StatelessWidget {
  const _OpenOverride(this.grant);

  final CustomerHistoryOpenOverride grant;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final parts = [
      if (grant.extraAttempts > 0) '+${grant.extraAttempts} tr${grant.extraAttempts == 1 ? 'y' : 'ies'}',
      if (grant.retryDelay) 'Call early',
      if (grant.callingHours) 'Outside calling hours',
    ];
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.xs),
      child: Text(
        ['Override from ${grant.dispositionCode}', grant.campaign.name, ...parts].join(' · '),
        key: Key('customer-open-override-${grant.contactId}'),
        style: text.bodyMedium,
      ),
    );
  }
}

class _Contact extends StatelessWidget {
  const _Contact(this.contact);

  final CustomerHistoryContact contact;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final c = contact;
    final hero = c.fields.map((f) => f.value).where((v) => v.trim().isNotEmpty).join(' · ');
    final suppressed = c.suppressedReason == null ? null : (suppressedReasonLabels[c.suppressedReason] ?? c.suppressedReason);
    final meta = [
      ?c.accountName,
      '${c.attemptCount} call${c.attemptCount == 1 ? '' : 's'}',
      'Owner: ${personName(c.assignedTo, none: CustomerHistoryCopy.pool)}',
    ].join(' · ');
    final entered = [
      'Added ${EnIn.timestamp(c.enteredAt)}',
      ?c.uploadFileName,
    ].join(' · ');
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
          Text(c.campaign.name, style: text.bodyMedium),
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

class _Filters extends StatelessWidget {
  const _Filters({required this.filter, required this.enabled, required this.onChanged});

  final CustomerHistoryFilter filter;
  final bool enabled;
  final ValueChanged<CustomerHistoryFilter> onChanged;

  @override
  Widget build(BuildContext context) {
    Widget channel(String label, CustomerTimelineChannel? value, String key) => ChoiceChip(
      key: Key(key),
      label: Text(label),
      selected: filter.channel == value,
      onSelected: enabled ? (_) => onChanged(filter.withChannel(value)) : null,
    );
    return Wrap(
      spacing: Space.sm,
      runSpacing: Space.xs,
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
      ],
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
        'try ${c.attemptNumber}',
        if (c.redialNumber > 0) 'redial ${c.redialNumber}',
        if (c.agent != null) personName(c.agent),
        if (c.talkSeconds != null) EnIn.talkTime(c.talkSeconds),
      ]),
      _joined([c.dispositionCode, _recordingLabel(c.recording)]),
      if (c.callbackAt != null) 'Callback booked for ${EnIn.timestamp(c.callbackAt)}',
      _joined([
        for (final k in c.overrideApplied) overrideKindLabels[k],
        if (c.overrideApplied.isNotEmpty) c.overrideNote,
      ]),
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
      _joined([c.dncOverrideNote, c.hoursOverrideNote]),
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
    title: 'Added to ${r.campaign.name}',
    lines: [_joined([r.uploadFileName])],
  ),
  CustomerTimelineUnknownEntry() => const _EntryView(icon: Icons.more_horiz, title: CustomerHistoryCopy.unknownEntry),
};

class _Entry extends StatelessWidget {
  const _Entry(this.entry);

  final CustomerTimelineEntry entry;

  @override
  Widget build(BuildContext context) {
    final view = _viewOf(entry);
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final lines = view.lines.where((l) => l.isNotEmpty).toList();
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

class _Notice extends StatelessWidget {
  const _Notice({super.key, required this.message, required this.action, required this.onAction});

  final String message;
  final String action;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return AppCard(
      color: t.warningSubtle,
      borderColor: t.warningSubtle,
      padding: const EdgeInsets.fromLTRB(Space.md, Space.xs, Space.xs, Space.xs),
      child: Row(
        children: [
          Expanded(
            child: Semantics(liveRegion: true, child: Text(message, style: Theme.of(context).textTheme.bodySmall)),
          ),
          TextButton(onPressed: onAction, child: Text(action)),
        ],
      ),
    );
  }
}
