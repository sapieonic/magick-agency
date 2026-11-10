import 'package:flutter/material.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../logic/format.dart';
import '../station_copy.dart';

/// Who is on the line: hero fields, the rest of the roster row, history.
///
/// Every value is operator-uploaded file content and is rendered as plain
/// text, always.

/// Up to four pinned fields in a two-column grid.
class HeroFieldsGrid extends StatelessWidget {
  const HeroFieldsGrid({super.key, required this.fields, required this.configured});

  final List<ContactField> fields;
  final bool configured;

  @override
  Widget build(BuildContext context) {
    if (fields.isEmpty) return const SizedBox.shrink();
    final text = Theme.of(context).textTheme;
    final shown = fields.take(4).toList(growable: false);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        LayoutBuilder(
          builder: (context, c) {
            // Two columns, or one when large text would squeeze the values.
            final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
            final columns = c.maxWidth < 300 || scale > 1.6 ? 1 : 2;
            final w = (c.maxWidth - Space.md * (columns - 1)) / columns;
            return Wrap(
              spacing: Space.md,
              runSpacing: Space.md,
              children: [
                for (final f in shown)
                  SizedBox(
                    width: w,
                    child: MergeSemantics(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(f.label, style: text.labelSmall),
                          const SizedBox(height: 2),
                          Text(f.value.isEmpty ? '—' : f.value, style: text.titleSmall),
                        ],
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
        if (!configured) ...[
          const SizedBox(height: Space.xs),
          // A guess shown as a guess: an agent must not come to trust four
          // heuristically picked fields as the operator's choice.
          Tooltip(
            message: StationCopy.autoSelectedHint,
            child: Text(StationCopy.autoSelected, key: const Key('auto-selected'), style: text.labelSmall),
          ),
        ],
      ],
    );
  }
}

/// One label/value pair, stacked so long values wrap rather than clip.
class FieldRow extends StatelessWidget {
  const FieldRow({super.key, required this.label, required this.value, this.mono = false});

  final String label;
  final String value;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return MergeSemantics(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: Space.xs),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: text.labelSmall),
            const SizedBox(height: 2),
            SelectableText(
              value.isEmpty ? '—' : value,
              style: mono ? monoStyle(context, size: 14, color: context.tokens.textPrimary) : text.bodyMedium,
            ),
          ],
        ),
      ),
    );
  }
}

/// The non-hero fields, with a filter once there are enough to need one.
///
/// Empty fields fold into one line: forty rows of "—" is scan cost, not
/// information.
class ContactFieldList extends StatefulWidget {
  const ContactFieldList({super.key, required this.fields, this.alwaysFilter = false});

  final List<ContactField> fields;
  final bool alwaysFilter;

  @override
  State<ContactFieldList> createState() => _ContactFieldListState();
}

class _ContactFieldListState extends State<ContactFieldList> {
  final _filter = TextEditingController();
  bool _showEmpty = false;

  @override
  void dispose() {
    _filter.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final filled = widget.fields.where((f) => f.value.trim().isNotEmpty).toList(growable: false);
    final empty = widget.fields.where((f) => f.value.trim().isEmpty).toList(growable: false);
    if (filled.isEmpty && empty.isEmpty) return Text(StationCopy.noExtraDetails, style: text.bodySmall);

    final q = _filter.text.trim().toLowerCase();
    final shown = q.isEmpty
        ? filled
        : filled.where((f) => f.label.toLowerCase().contains(q) || f.value.toLowerCase().contains(q)).toList(growable: false);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.alwaysFilter && filled.isNotEmpty) ...[
          TextField(
            key: const Key('field-filter'),
            controller: _filter,
            onChanged: (_) => setState(() {}),
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              labelText: StationCopy.filterFields,
              hintText: StationCopy.filterHint,
              prefixIcon: const Icon(Icons.search),
              helperText: StationCopy.fieldCount(shown.length, filled.length),
            ),
          ),
          const SizedBox(height: Space.sm),
        ],
        if (shown.isEmpty && q.isNotEmpty) Text(StationCopy.noFieldMatches(_filter.text.trim()), style: text.bodySmall),
        for (final f in shown) FieldRow(label: f.label, value: f.value),
        if (empty.isNotEmpty && q.isEmpty) ...[
          TextButton.icon(
            style: TextButton.styleFrom(alignment: AlignmentDirectional.centerStart),
            onPressed: () => setState(() => _showEmpty = !_showEmpty),
            icon: Icon(_showEmpty ? Icons.expand_less : Icons.expand_more),
            label: Text(StationCopy.emptyFields(empty.length)),
          ),
          if (_showEmpty)
            for (final f in empty) FieldRow(label: f.label, value: ''),
        ],
      ],
    );
  }
}

/// "More details (6) ▾" on the ringing screen.
class MoreDetails extends StatefulWidget {
  const MoreDetails({super.key, required this.fields});

  final List<ContactField> fields;

  @override
  State<MoreDetails> createState() => _MoreDetailsState();
}

class _MoreDetailsState extends State<MoreDetails> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    if (widget.fields.isEmpty) return const SizedBox.shrink();
    final text = Theme.of(context).textTheme;
    return AppCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            expanded: _open,
            child: InkWell(
              key: const Key('more-details'),
              borderRadius: BorderRadius.circular(Radii.md),
              onTap: () => setState(() => _open = !_open),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: Space.touch),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.sm),
                  child: Row(
                    children: [
                      Expanded(child: Text(StationCopy.moreDetails(widget.fields.length), style: text.titleSmall)),
                      Icon(_open ? Icons.expand_less : Icons.expand_more),
                    ],
                  ),
                ),
              ),
            ),
          ),
          AnimatedSize(
            duration: MediaQuery.disableAnimationsOf(context) ? Duration.zero : const Duration(milliseconds: 200),
            alignment: Alignment.topCenter,
            child: _open
                ? Padding(
                    padding: const EdgeInsets.fromLTRB(Space.md, 0, Space.md, Space.md),
                    child: ContactFieldList(fields: widget.fields, alwaysFilter: widget.fields.length > 8),
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

/// This campaign's attempts first (a retry lineage's history is why the
/// agent is told anything), then other campaigns', each newest first.
List<PriorAttempt> orderPriorAttempts(List<PriorAttempt> attempts) {
  int newest(PriorAttempt a, PriorAttempt b) => b.at.compareTo(a.at);
  return [
    ...attempts.where((a) => a.sameCampaign).toList()..sort(newest),
    ...attempts.where((a) => !a.sameCampaign).toList()..sort(newest),
  ];
}

class PriorAttemptsCard extends StatelessWidget {
  const PriorAttemptsCard({super.key, required this.attempts, this.limit});

  final List<PriorAttempt> attempts;

  /// Show at most this many (the ringing screen); null shows all (Details).
  final int? limit;

  @override
  Widget build(BuildContext context) {
    if (attempts.isEmpty) return const SizedBox.shrink();
    final text = Theme.of(context).textTheme;
    final ordered = orderPriorAttempts(attempts);
    final shown = limit == null ? ordered : ordered.take(limit!).toList(growable: false);
    final allHere = attempts.every((a) => a.sameCampaign);
    return AppCard(
      key: const Key('prior-attempts'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // A Wrap, not a Row: at 200% text "This campaign" alone is wider than a 360 dp phone's card.
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            spacing: Space.sm,
            children: [
              Text(StationCopy.priorAttempts(attempts.length), style: text.labelMedium),
              if (allHere) Text(StationCopy.thisCampaign, style: text.labelSmall),
            ],
          ),
          for (final a in shown)
            MergeSemantics(
              child: Padding(
                padding: const EdgeInsets.only(top: Space.sm),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Wrap(
                      spacing: Space.sm,
                      runSpacing: Space.xs,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(formatDayTime(a.at), style: monoStyle(context, size: 13)),
                        StatusPill(a.outcomeLabel),
                        if (!a.sameCampaign && !allHere) Text(StationCopy.otherCampaign(a.campaignName), style: text.labelSmall),
                      ],
                    ),
                    if (a.notes != null && a.notes!.trim().isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(a.notes!, style: text.bodySmall),
                    ],
                  ],
                ),
              ),
            ),
          if (shown.length < ordered.length)
            Padding(
              padding: const EdgeInsets.only(top: Space.sm),
              child: Text(StationCopy.moreAttempts(ordered.length - shown.length), style: text.labelSmall),
            ),
        ],
      ),
    );
  }
}
