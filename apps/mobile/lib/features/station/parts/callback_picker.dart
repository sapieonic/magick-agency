import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../logic/disposition_form.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import 'sheets.dart';

/// When to call back: three chips for the times most callbacks are, and a
/// picker for the rest. Inline, not a dialog: a chip is one tap.
///
/// The chosen time is written out with its zone beside it, because the app
/// does not know the customer's zone and an agent must not promise a time
/// they silently converted. "We", never "I": the callback goes back to the
/// shared queue.
class CallbackPicker extends ConsumerWidget {
  const CallbackPicker({super.key, required this.form, required this.onPick, this.enabled = true, this.attemptId, this.plain = false});

  final DispositionForm form;
  final void Function(DateTime at, CallbackChoice choice) onPick;
  final bool enabled;

  /// The call being wrapped up: the date and time pickers close when its
  /// wrap-up ends (they sit above the station, and the form they would fill is
  /// gone by then).
  final String? attemptId;

  /// What happened?'s sheet (05b): its own title and line, the redesign's chips (Today 6:00 PM,
  /// Other time) and the time as "Fri 20 Nov at 10:00 AM"; no timezone paragraph (spec §8).
  final bool plain;

  List<CallbackPreset> presets(DateTime now) => plain ? stationCallbackPresets(now) : callbackPresets(now);

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
      label: Padding(
        padding: plain ? const EdgeInsets.symmetric(horizontal: Space.xs, vertical: Space.sm) : EdgeInsets.zero,
        child: Text(plain ? StationCopy.stationCallbackChip(choice) : StationCopy.callbackChip(choice)),
      ),
      selected: form.callbackChoice == choice,
      onSelected: enabled ? (_) => onTap() : null,
    );

    return Column(
      key: const Key('callback-picker'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!plain) ...[Text(StationCopy.callbackTitle, style: text.labelMedium), const SizedBox(height: Space.sm)],
        Wrap(
          spacing: Space.sm,
          runSpacing: Space.sm,
          children: [
            for (final p in presets(now))
              chip(p.choice, () {
                // Read the clock at the tap, so "In 1 hour" means from now.
                final fresh = presets(clock()).firstWhere((x) => x.choice == p.choice, orElse: () => p);
                onPick(fresh.at, p.choice);
              }),
            chip(CallbackChoice.picked, () => _pick(context, clock)),
          ],
        ),
        if (at != null) ...[
          const SizedBox(height: Space.sm),
          Text(
            plain ? formatWhen(at) : formatCallback(at),
            key: const Key('callback-resolved'),
            style: text.titleSmall!.copyWith(color: past ? t.danger : t.textPrimary),
          ),
        ],
        if (!plain) ...[
          const SizedBox(height: Space.xs),
          Text(StationCopy.callbackTimezone(now.timeZoneName), style: text.bodySmall),
          const SizedBox(height: Space.xs),
          Text(StationCopy.callbackGroundTruth, key: const Key('callback-ground-truth'), style: text.bodySmall),
        ],
      ],
    );
  }

  Future<void> _pick(BuildContext context, DateTime Function() clock) async {
    final container = ProviderScope.containerOf(context, listen: false);
    final scope = sameCall(attemptId, const {AgentPhase.wrapup});
    Widget guarded(BuildContext _, Widget? child) => StationModalGuard(scope: scope, child: child!);
    final now = clock();
    final start = form.callbackAt ?? callbackPresets(now).first.at;
    final today = DateTime(now.year, now.month, now.day);
    final date = await showDatePicker(
      context: context,
      initialDate: start.isBefore(today) ? today : start,
      firstDate: today,
      lastDate: today.add(const Duration(days: 90)),
      helpText: StationCopy.callbackDateHelp,
      builder: guarded,
    );
    if (date == null || !context.mounted || !scope(container.read(stationViewProvider))) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(start),
      helpText: StationCopy.callbackTimeHelp,
      builder: guarded,
    );
    // The wrap-up (and the form [onPick] fills) may be gone by now.
    if (time == null || !context.mounted || !scope(container.read(stationViewProvider))) return;
    // A time already gone is kept and shown as such, and blocks the save with
    // the reason, rather than silently snapping to something else.
    onPick(combinePicked(date, time.hour, time.minute), CallbackChoice.picked);
  }
}
