import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../logic/disposition_form.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import '../station_providers.dart';

/// When to call back: three chips for the times most callbacks are, and a
/// picker for the rest. Inline, not a dialog: a chip is one tap.
///
/// The chosen time is written out with its zone beside it, because the app
/// does not know the customer's zone and an agent must not promise a time
/// they silently converted. "We", never "I": the callback goes back to the
/// shared queue.
class CallbackPicker extends ConsumerWidget {
  const CallbackPicker({super.key, required this.form, required this.onPick, this.enabled = true});

  final DispositionForm form;
  final void Function(DateTime at, CallbackChoice choice) onPick;
  final bool enabled;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final clock = ref.watch(stationClockProvider);
    final now = clock();
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final at = form.callbackAt;
    final past = at != null && !at.isAfter(now);

    Widget chip(CallbackChoice choice, VoidCallback onTap) => ChoiceChip(
      key: Key('callback-${choice.name}'),
      label: Text(StationCopy.callbackChip(choice)),
      selected: form.callbackChoice == choice,
      onSelected: enabled ? (_) => onTap() : null,
    );

    return Column(
      key: const Key('callback-picker'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(StationCopy.callbackTitle, style: text.labelMedium),
        const SizedBox(height: Space.sm),
        Wrap(
          spacing: Space.sm,
          runSpacing: Space.sm,
          children: [
            for (final p in callbackPresets(now))
              chip(p.choice, () {
                // Read the clock at the tap, so "In 1 hour" means from now.
                final fresh = callbackPresets(clock()).firstWhere((x) => x.choice == p.choice);
                onPick(fresh.at, p.choice);
              }),
            chip(CallbackChoice.picked, () => _pick(context, clock)),
          ],
        ),
        if (at != null) ...[
          const SizedBox(height: Space.sm),
          Text(
            formatCallback(at),
            key: const Key('callback-resolved'),
            style: text.titleSmall!.copyWith(color: past ? t.danger : t.textPrimary),
          ),
        ],
        const SizedBox(height: Space.xs),
        Text(StationCopy.callbackTimezone(now.timeZoneName), style: text.bodySmall),
        const SizedBox(height: Space.xs),
        Text(StationCopy.callbackGroundTruth, key: const Key('callback-ground-truth'), style: text.bodySmall),
      ],
    );
  }

  Future<void> _pick(BuildContext context, DateTime Function() clock) async {
    final now = clock();
    final start = form.callbackAt ?? callbackPresets(now).first.at;
    final today = DateTime(now.year, now.month, now.day);
    final date = await showDatePicker(
      context: context,
      initialDate: start.isBefore(today) ? today : start,
      firstDate: today,
      lastDate: today.add(const Duration(days: 90)),
      helpText: StationCopy.callbackDateHelp,
    );
    if (date == null || !context.mounted) return;
    final time = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(start), helpText: StationCopy.callbackTimeHelp);
    if (time == null) return;
    // A time already gone is kept and shown as such, and blocks the save with
    // the reason, rather than silently snapping to something else.
    onPick(combinePicked(date, time.hour, time.minute), CallbackChoice.picked);
  }
}
