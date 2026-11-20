import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/promise_rules.dart';
import '../../../core/station/station_view.dart';
import '../logic/disposition_form.dart';
import '../logic/format.dart' show formatDay;
import '../station_copy.dart';
import '../station_providers.dart';
import 'sheets.dart';

/// Promise to pay (PT1): the date the customer promised to pay, three chips
/// for the commonest answers and a date picker for the rest, then the amount
/// if they gave one, with Full and Half chips when the customer's amount due is
/// known (a typed money fact, BE-6). A chip is one tap.
///
/// When the outcome books a follow-up (PT2), the date picked says when: "We will
/// call again on 22 Nov." (spec §8 dropped the system explanations around it.)
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
    this.amountDue,
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

  /// The customer's amount due: a money fact's parsed value (a decimal string), for the Full and
  /// Half chips; null hides them.
  final String? amountDue;

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
    final due = widget.amountDue;
    final full = due == null ? null : plainAmount(due);
    final half = due == null ? null : halfAmount(due);
    final typed = _amount.text.trim();
    final amountChips = <(String, String, String)>[
      if (full != null) ('promise-full', StationCopy.fullAmount, full),
      if (half != null && half != '0') ('promise-half', StationCopy.halfAmount, half),
    ];

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
        if (amountChips.isNotEmpty) ...[
          const SizedBox(height: Space.sm),
          Wrap(
            spacing: Space.sm,
            runSpacing: Space.sm,
            children: [
              for (final (key, label, amount) in amountChips)
                ChoiceChip(
                  key: Key(key),
                  label: Text(StationCopy.amountChip(label, formatPromiseAmount(amount))),
                  selected: typed == amount,
                  onSelected: widget.enabled ? (_) => _setAmount(amount) : null,
                ),
            ],
          ),
        ],
        if (followUp != null && chosen != null) ...[
          const SizedBox(height: Space.sm),
          Text(
            StationCopy.weWillCallAgain(formatDay(DateTime(chosen.year, chosen.month, chosen.day + followUp))),
            key: const Key('promise-follow-up'),
            style: text.bodySmall,
          ),
        ],
      ],
    );
  }

  void _setAmount(String amount) {
    _amount.text = amount;
    widget.onAmount(amount);
    setState(() {});
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
