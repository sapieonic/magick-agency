import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../ui/primitives.dart';
import '../../performance/campaign_names.dart';
import '../../performance/logic/readouts.dart';
import '../../performance/performance_controller.dart';
import '../calls_controller.dart';
import '../logic/attempt_copy.dart';
import '../logic/attempt_filters.dart';
import '../logic/debouncer.dart';

/// The filter chips (days, outcome, campaign, clear) and the number search.
///
/// Each chip opens a sheet and applies its choice as a whole; the search
/// applies after a pause in typing. Typing rebuilds only the search field:
/// the list rebuilds when the debounced query lands, not per keystroke.
class AttemptsFilterBar extends ConsumerWidget {
  const AttemptsFilterBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final filters = ref.watch(attemptsControllerProvider.select((s) => s.filters));
    final names = ref.watch(campaignNamesProvider);
    final controller = ref.read(attemptsControllerProvider.notifier);

    void apply(AttemptFilters f) => unawaited(controller.applyFilters(f));

    final outcomeLabel = switch (filters.outcomes.length) {
      0 => 'All outcomes',
      1 => attemptOutcomeLabels[filters.outcomes.first] ?? 'Outcome',
      final n => '$n outcomes',
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: Space.lg),
          child: Row(
            children: [
              _Chip(
                key: const Key('filter-days'),
                label: dayFilterLabel(filters.days),
                selected: filters.days is! AnyDay,
                onTap: () => _pickDays(context, filters, apply),
              ),
              _Chip(
                key: const Key('filter-outcome'),
                label: outcomeLabel,
                selected: filters.outcomes.isNotEmpty,
                onTap: () => _pickOutcomes(context, filters, apply),
              ),
              _Chip(
                key: const Key('filter-campaign'),
                label: filters.campaignId == null ? 'Every campaign' : campaignLabel(filters.campaignId!, names),
                selected: filters.campaignId != null,
                onTap: () => _pickCampaign(context, filters, names, apply),
              ),
              if (filters.isFiltered)
                Padding(
                  padding: const EdgeInsets.only(left: Space.xs),
                  child: TextButton(
                    key: const Key('filter-clear'),
                    onPressed: () => apply(const AttemptFilters()),
                    child: Text('Clear (${filters.groupCount})'),
                  ),
                ),
            ],
          ),
        ),
        const Padding(
          padding: EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, 0),
          child: PhoneSearchField(),
        ),
        if (filters.days is DayRange)
          Padding(
            padding: const EdgeInsets.fromLTRB(Space.lg, Space.xs, Space.lg, 0),
            child: Text(attemptRangeNote, style: Theme.of(context).textTheme.bodySmall),
          ),
      ],
    );
  }

  Future<void> _pickDays(BuildContext context, AttemptFilters filters, void Function(AttemptFilters) apply) async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(padding: EdgeInsets.symmetric(horizontal: Space.lg), child: SectionLabel('Days')),
            ListTile(
              key: const Key('days-today'),
              title: const Text('Today'),
              selected: filters.days is TodayOnly,
              onTap: () => Navigator.pop(context, 'today'),
            ),
            ListTile(
              key: const Key('days-any'),
              title: const Text('Any day'),
              selected: filters.days is AnyDay,
              onTap: () => Navigator.pop(context, 'any'),
            ),
            ListTile(
              key: const Key('days-pick'),
              title: const Text('Pick days…'),
              subtitle: const Text(attemptRangeNote),
              selected: filters.days is DayRange,
              onTap: () => Navigator.pop(context, 'pick'),
            ),
          ],
        ),
      ),
    );
    if (choice == 'today') apply(filters.copyWith(days: const TodayOnly()));
    if (choice == 'any') apply(filters.copyWith(days: const AnyDay()));
    if (choice == 'pick' && context.mounted) {
      final now = DateTime.now();
      final current = filters.days;
      final picked = await showDateRangePicker(
        context: context,
        firstDate: DateTime(now.year - 5),
        lastDate: DateTime(now.year, now.month, now.day),
        initialDateRange: current is DayRange
            ? DateTimeRange(
                start: DateTime(current.first.year, current.first.month, current.first.day),
                end: DateTime(current.last.year, current.last.month, current.last.day),
              )
            : null,
        helpText: 'First day – last day',
      );
      if (picked != null) {
        apply(filters.copyWith(
          days: DayRange(
            CalendarDate(picked.start.year, picked.start.month, picked.start.day),
            CalendarDate(picked.end.year, picked.end.month, picked.end.day),
          ),
        ));
      }
    }
  }

  Future<void> _pickOutcomes(BuildContext context, AttemptFilters filters, void Function(AttemptFilters) apply) async {
    final picked = await showModalBottomSheet<Set<AttemptOutcome>>(
      context: context,
      isScrollControlled: true,
      builder: (context) => _OutcomeSheet(initial: filters.outcomes),
    );
    if (picked != null) apply(filters.copyWith(outcomes: picked));
  }

  Future<void> _pickCampaign(
    BuildContext context,
    AttemptFilters filters,
    Map<String, String?> names,
    void Function(AttemptFilters) apply,
  ) async {
    final options = scopeOptions(names);
    final applied = filters.campaignId;
    final entries = <MapEntry<String?, String>>[
      const MapEntry(null, 'Every campaign'),
      for (final o in options) MapEntry(o.key, o.value),
      if (applied != null && !options.any((o) => o.key == applied)) MapEntry(applied, campaignLabel(applied, names)),
    ];
    final picked = await showModalBottomSheet<MapEntry<String?, String>>(
      context: context,
      isScrollControlled: true,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(padding: EdgeInsets.symmetric(horizontal: Space.lg), child: SectionLabel('Campaign')),
            for (final e in entries)
              ListTile(
                key: Key('campaign-option-${e.key ?? 'all'}'),
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
    apply(picked.key == null ? filters.copyWith(clearCampaign: true) : filters.copyWith(campaignId: picked.key));
  }
}

class _Chip extends StatelessWidget {
  const _Chip({super.key, required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: Space.sm),
      child: FilterChip(
        label: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 180),
              child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
            const Icon(Icons.arrow_drop_down, size: 18),
          ],
        ),
        selected: selected,
        showCheckmark: false,
        onSelected: (_) => onTap(),
      ),
    );
  }
}

/// "What happened": several outcomes at once, applied together.
class _OutcomeSheet extends StatefulWidget {
  const _OutcomeSheet({required this.initial});

  final Set<AttemptOutcome> initial;

  @override
  State<_OutcomeSheet> createState() => _OutcomeSheetState();
}

class _OutcomeSheetState extends State<_OutcomeSheet> {
  late final Set<AttemptOutcome> _draft = {...widget.initial};

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(padding: EdgeInsets.symmetric(horizontal: Space.lg), child: SectionLabel('What happened')),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final e in attemptOutcomeLabels.entries)
                    CheckboxListTile(
                      key: Key('outcome-${e.key.wire}'),
                      value: _draft.contains(e.key),
                      title: Text(e.value),
                      onChanged: (on) => setState(() => on == true ? _draft.add(e.key) : _draft.remove(e.key)),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, Space.lg),
              child: Row(
                children: [
                  if (_draft.isNotEmpty)
                    TextButton(onPressed: () => setState(_draft.clear), child: const Text('Clear')),
                  const Spacer(),
                  FilledButton(
                    key: const Key('outcome-apply'),
                    onPressed: () => Navigator.pop(context, Set<AttemptOutcome>.unmodifiable(_draft)),
                    child: const Text('Apply'),
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

/// The number search. Owns its text: keystrokes rebuild this field only, and
/// the query is applied [debounce] after the agent stops typing.
class PhoneSearchField extends ConsumerStatefulWidget {
  const PhoneSearchField({super.key, this.debounce = const Duration(milliseconds: 400)});

  final Duration debounce;

  @override
  ConsumerState<PhoneSearchField> createState() => _PhoneSearchFieldState();
}

class _PhoneSearchFieldState extends ConsumerState<PhoneSearchField> {
  late final TextEditingController _text =
      TextEditingController(text: ref.read(attemptsControllerProvider).filters.phone ?? '');
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
    final phone = normalisePhone(raw);
    final current = ref.read(attemptsControllerProvider).filters;
    if (current.phone == phone) return;
    final next = phone == null ? current.copyWith(clearPhone: true) : current.copyWith(phone: phone);
    unawaited(ref.read(attemptsControllerProvider.notifier).applyFilters(next));
  }

  void _onChanged(String raw) {
    final problem = phoneSearchProblem(raw);
    if (problem != _problem) setState(() => _problem = problem);
    _debounce(_apply);
  }

  @override
  Widget build(BuildContext context) {
    // Cleared from elsewhere (the Clear chip): empty the box to match.
    ref.listen<String?>(attemptsControllerProvider.select((s) => s.filters.phone), (prev, next) {
      if (next == null && normalisePhone(_text.text) != null && phoneSearchProblem(_text.text) == null) {
        _debounce.cancel();
        _text.clear();
      }
    });
    final t = context.tokens;
    return TextField(
      key: const Key('phone-search'),
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

/// "Today" in the reader's zone, for row dates (from the injectable clock).
DateTime localToday(WidgetRef ref) {
  final w = ref.read(localCalendarProvider).wall(ref.read(statsClockProvider)());
  return DateTime(w.year, w.month, w.day);
}
