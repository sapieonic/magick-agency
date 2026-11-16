import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/promise_rules.dart';
import '../../../core/station/station_view.dart';
import '../logic/disposition_form.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import 'sheets.dart';

/// Promise to pay (PT1): the date the customer promised to pay, three chips
/// for the commonest answers and a date picker for the rest, then the amount
/// if they gave one. Inline, like the callback picker: a chip is one tap.
///
/// Says plainly whether saving books a call (PT2, PT3): the agent is about to
/// tell the customer what happens next.
class PromisePicker extends ConsumerStatefulWidget {
  const PromisePicker({
    super.key,
    required this.form,
    required this.option,
    required this.onDate,
    required this.onAmount,
    this.enabled = true,
    this.attemptId,
    this.station = true,
  });

  final DispositionForm form;
  final DispositionOption option;
  final ValueChanged<DateTime> onDate;
  final ValueChanged<String> onAmount;
  final bool enabled;

  /// The call being wrapped up: the date picker closes when its wrap-up ends.
  final String? attemptId;

  /// On the station (the picker is guarded to its wrap-up), or the soft phone
  /// (no station call to guard on).
  final bool station;

  @override
  ConsumerState<PromisePicker> createState() => _PromisePickerState();
}

class _PromisePickerState extends ConsumerState<PromisePicker> {
  late final TextEditingController _amount = TextEditingController(text: widget.form.promiseAmount);

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final clock = ref.watch(stationClockProvider);
    final now = clock().toLocal();
    final today = DateTime(now.year, now.month, now.day);
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final chosen = widget.form.promiseDate;
    final day = widget.form.promiseDay;
    final presets = <(String, DateTime)>[
      (StationCopy.promiseToday, today),
      (StationCopy.promiseTomorrow, DateTime(today.year, today.month, today.day + 1)),
      (StationCopy.promiseInAWeek, DateTime(today.year, today.month, today.day + 7)),
    ];
    final followUp = widget.option.promiseFollowUpDays;

    return Column(
      key: const Key('promise-picker'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(StationCopy.promiseTitle, style: text.labelMedium),
        const SizedBox(height: Space.sm),
        Wrap(
          spacing: Space.sm,
          runSpacing: Space.sm,
          children: [
            for (final (label, at) in presets)
              ChoiceChip(
                key: Key('promise-$label'),
                label: Text(label),
                selected: chosen != null && promiseDayString(chosen) == promiseDayString(at),
                onSelected: widget.enabled ? (_) => widget.onDate(at) : null,
              ),
            ChoiceChip(
              key: const Key('promise-pick'),
              label: const Text(StationCopy.promisePick),
              selected: chosen != null && !presets.any((p) => promiseDayString(p.$2) == promiseDayString(chosen)),
              onSelected: widget.enabled ? (_) => _pick(context, today) : null,
            ),
          ],
        ),
        if (day != null) ...[
          const SizedBox(height: Space.sm),
          Text(
            formatPromise(day, _amount.text.trim().isEmpty ? null : _amount.text.trim()),
            key: const Key('promise-resolved'),
            style: text.titleSmall!.copyWith(color: t.textPrimary),
          ),
        ],
        const SizedBox(height: Space.sm),
        TextField(
          key: const Key('promise-amount'),
          controller: _amount,
          enabled: widget.enabled,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
          decoration: const InputDecoration(labelText: StationCopy.promiseAmountLabel, hintText: '12500'),
          onChanged: (value) {
            widget.onAmount(value);
            setState(() {});
          },
        ),
        const SizedBox(height: Space.xs),
        Text(StationCopy.promiseDateNote, style: text.bodySmall),
        const SizedBox(height: Space.xs),
        Text(
          followUp != null ? StationCopy.promiseFollowUp(followUp) : StationCopy.promiseNoCall,
          key: const Key('promise-ground-truth'),
          style: text.bodySmall,
        ),
      ],
    );
  }

  Future<void> _pick(BuildContext context, DateTime today) async {
    final container = ProviderScope.containerOf(context, listen: false);
    final scope = sameCall(widget.attemptId, const {AgentPhase.wrapup});
    Widget guarded(BuildContext _, Widget? child) =>
        widget.station ? StationModalGuard(scope: scope, child: child!) : child!;
    final (:first, :last) = promisePickerBounds(today);
    final initial = widget.form.promiseDate ?? today;
    final date = await showDatePicker(
      context: context,
      initialDate: initial.isBefore(first) || initial.isAfter(last) ? today : initial,
      firstDate: first,
      lastDate: last,
      helpText: StationCopy.promiseDateHelp,
      builder: guarded,
    );
    // The wrap-up (and the form this fills) may be gone by now.
    if (date == null || !context.mounted) return;
    if (widget.station && !scope(container.read(stationViewProvider))) return;
    widget.onDate(date);
  }
}
