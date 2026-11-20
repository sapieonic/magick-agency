import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../../../core/station/station_view.dart' show DispositionOption;
import '../../../ui/primitives.dart';
import '../../station/logic/disposition_form.dart';
import '../../station/logic/format.dart';
import '../../station/parts/banners.dart' show BusyLabel;
import '../../station/parts/promise_picker.dart';
import '../../station/parts/wrapup_view.dart' show OutcomeTiles;
import '../../station/station_copy.dart';
import '../../station/station_providers.dart';
import '../../station/widgets/ticking.dart';
import '../softphone_copy.dart';

/// What happened? on the soft phone, as the station has it (05): one picture tile per outcome of the
/// call's list (`OutcomeTiles`, More past nine), the call-later time and the pay date with the
/// station's chips, and the reason Save is not ready yet, in the station's words (AS15). The speaker
/// on each tile shows only once the call has ended (AS13).
///
/// The tiles open when the customer answers; Save opens when the call ends. The list is the tag's,
/// else the soft phone's own (the core picks it). A call-later says who makes it (AS8, the console's
/// `StationSoftphone`): on a call a list is waiting on (the contact claimed), another agent may get
/// it; otherwise nobody calls back by themselves, so the agent does.
///
/// The panel keys this on the call, so a new call starts with no call-later chip.
class OutcomeSection extends ConsumerStatefulWidget {
  const OutcomeSection({super.key, this.includeSave = true});

  /// Save sits at the end of the section while the call is live; once it has
  /// ended the panel pins it below instead.
  final bool includeSave;

  @override
  ConsumerState<OutcomeSection> createState() => _OutcomeSectionState();
}

class _OutcomeSectionState extends ConsumerState<OutcomeSection> {
  /// Which chip the agent chose, so it stays selected. The time is the core's.
  CallbackChoice? _choice;

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(
      softphoneViewProvider.select(
        (v) => (
          outcomes: v.outcomes,
          code: v.outcomeCode,
          callbackAt: v.callbackAt,
          promiseDate: v.promiseDate,
          promiseAmount: v.promiseAmount,
          enabled: v.padEnabled,
          reason: v.padDisabledReason,
          rejection: v.padRejection,
          saving: v.saving,
          ended: v.phase == SoftphonePhase.outcome,
          claimed: v.contact?.claimed ?? false,
        ),
      ),
    );
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final actions = ref.read(softphoneActionsProvider);
    final selected = s.outcomes.firstWhereOrNull((o) => o.code == s.code);

    return Column(
      key: const Key('softphone-outcome'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SectionLabel(StationCopy.whatHappened),
        const SizedBox(height: Space.sm),
        if (!s.enabled && s.reason != null) ...[
          Text(s.reason!, key: const Key('pad-disabled-reason'), style: text.bodySmall),
          const SizedBox(height: Space.sm),
        ],
        if (s.rejection case final rejection?) ...[
          Semantics(
            liveRegion: true,
            child: Text(
              rejection,
              key: const Key('pad-rejection'),
              style: text.bodySmall!.copyWith(color: t.warning),
            ),
          ),
          const SizedBox(height: Space.sm),
        ],
        OutcomeTiles(
          options: s.outcomes,
          selected: s.code,
          enabled: s.enabled && !s.saving,
          onSelect: actions.selectOutcome,
          readAloud: s.ended,
        ),
        if (selected != null && selected.requiresCallbackTime) ...[
          const SizedBox(height: Space.lg),
          _CallbackChooser(
            at: s.callbackAt,
            choice: _choice,
            enabled: s.enabled && !s.saving,
            claimed: s.claimed,
            onPick: (at, choice) {
              setState(() => _choice = choice);
              actions.setCallback(at);
            },
          ),
        ],
        if (selected != null && selected.requiresPromise) ...[
          const SizedBox(height: Space.lg),
          PromisePicker(
            form: DispositionForm(code: s.code, promiseDate: s.promiseDate, promiseAmount: s.promiseAmount),
            option: selected,
            enabled: s.enabled && !s.saving,
            station: false,
            onDate: actions.setPromiseDate,
            onAmount: actions.setPromiseAmount,
          ),
        ],
        if (widget.includeSave) ...[const SizedBox(height: Space.lg), const OutcomeSaveArea()],
      ],
    );
  }
}

/// Call when?: the station's chips (In 1 hour, Today 6:00 PM, Tomorrow 10:00 AM, Tomorrow 6:00 PM,
/// Other time), the time written out, and who makes the call ([claimed]: a list is waiting on this
/// contact, so another agent may get it; otherwise the agent calls back themselves).
class _CallbackChooser extends ConsumerWidget {
  const _CallbackChooser({required this.at, required this.choice, required this.enabled, required this.claimed, required this.onPick});

  final DateTime? at;
  final CallbackChoice? choice;
  final bool enabled;
  final bool claimed;
  final void Function(DateTime at, CallbackChoice choice) onPick;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final clock = ref.watch(stationClockProvider);
    final now = clock();
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final at = this.at;
    final past = at != null && !at.isAfter(now);

    Widget chip(CallbackChoice c, VoidCallback onTap) => ChoiceChip(
      key: Key('softphone-callback-${c.name}'),
      label: Text(StationCopy.stationCallbackChip(c)),
      selected: choice == c && at != null,
      onSelected: enabled ? (_) => onTap() : null,
    );

    return Column(
      key: const Key('softphone-callback'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(StationCopy.callWhen, style: text.labelMedium),
        const SizedBox(height: Space.sm),
        Wrap(
          spacing: Space.sm,
          runSpacing: Space.sm,
          children: [
            for (final p in stationCallbackPresets(now))
              chip(p.choice, () {
                // Read the clock at the tap, so "In 1 hour" means from now.
                final fresh = stationCallbackPresets(clock()).firstWhere((x) => x.choice == p.choice, orElse: () => p);
                onPick(fresh.at, p.choice);
              }),
            chip(CallbackChoice.picked, () => _pick(context, ref, clock)),
          ],
        ),
        if (at != null) ...[
          const SizedBox(height: Space.sm),
          Text(
            formatWhen(at),
            key: const Key('softphone-callback-resolved'),
            style: text.titleSmall!.copyWith(color: past ? t.danger : t.textPrimary),
          ),
          if (!past) ...[
            const SizedBox(height: Space.xs),
            Text(
              claimed ? StationCopy.callWillBeMade(formatWhen(at)) : StationCopy.callBackYourself(formatWhen(at)),
              key: const Key('callback-note'),
              style: text.bodySmall,
            ),
          ],
        ],
      ],
    );
  }

  Future<void> _pick(BuildContext context, WidgetRef ref, DateTime Function() clock) async {
    final container = ProviderScope.containerOf(context, listen: false);
    final callId = container.read(softphoneViewProvider).callId;
    final now = clock();
    final start = at ?? stationCallbackPresets(now).first.at;
    final today = DateTime(now.year, now.month, now.day);
    final date = await showDatePicker(
      context: context,
      initialDate: start.isBefore(today) ? today : start,
      firstDate: today,
      lastDate: today.add(const Duration(days: 90)),
      helpText: StationCopy.callbackDateHelp,
    );
    if (date == null || !context.mounted || container.read(softphoneViewProvider).callId != callId) return;
    final time = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(start), helpText: StationCopy.callbackTimeHelp);
    // The call (and the outcome this time is for) may be gone by now.
    if (time == null || !context.mounted || container.read(softphoneViewProvider).callId != callId) return;
    onPick(combinePicked(date, time.hour, time.minute), CallbackChoice.picked);
  }
}

/// Save, with the reason it is disabled written beside it (a bare
/// greyed button reads as broken), and, once the call has ended, how long the
/// outcome has before the call closes without one.
///
/// Re-checks every second while a callback code is chosen: a picked time can
/// slide into the past with nobody touching anything.
class OutcomeSaveArea extends ConsumerWidget {
  const OutcomeSaveArea({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(softphoneViewProvider.select(_SaveSlice.of));
    final clock = ref.watch(stationClockProvider);
    final t = context.tokens;
    final text = Theme.of(context).textTheme;

    Widget body(DateTime now) {
      final block = view.view.saveBlockAt(now);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (block != null && !view.view.saving) ...[
            Text(
              softphoneSaveBlockCopy[block]!,
              key: const Key('softphone-save-reason'),
              style: text.bodySmall!.copyWith(color: block == SoftphoneSaveBlock.callbackInPast ? t.danger : t.textSecondary),
            ),
            const SizedBox(height: Space.sm),
          ],
          FilledButton(
            key: const Key('softphone-save'),
            onPressed: block == null && !view.view.saving ? () => ref.read(softphoneActionsProvider).saveOutcome() : null,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: BusyLabel(
              label: view.view.saving ? SoftphoneCopy.saving : SoftphoneCopy.saveOutcome,
              busy: view.view.saving,
              color: t.onAccent,
            ),
          ),
        ],
      );
    }

    if (!view.ticks) return body(clock());
    return TickingBuilder(now: clock, builder: (context, now) => body(now));
  }
}

/// What Save reads, as a view of its own so a keystroke elsewhere is not a
/// rebuild. Equality is on the fields [SoftphoneView.saveBlockAt] reads.
class _SaveSlice {
  _SaveSlice(this.view);

  static _SaveSlice of(SoftphoneView v) => _SaveSlice(v);

  final SoftphoneView view;

  bool get ticks => view.outcomes.firstWhereOrNull((o) => o.code == view.outcomeCode)?.requiresCallbackTime ?? false;

  @override
  bool operator ==(Object other) =>
      other is _SaveSlice &&
      other.view.outcomeCode == view.outcomeCode &&
      other.view.phase == view.phase &&
      other.view.callbackAt == view.callbackAt &&
      other.view.promiseDate == view.promiseDate &&
      other.view.promiseAmount == view.promiseAmount &&
      other.view.notes.text == view.notes.text &&
      other.view.requiredFieldsMissing == view.requiredFieldsMissing &&
      other.view.saving == view.saving &&
      const ListEquality<DispositionOption>().equals(other.view.outcomes, view.outcomes);
  @override
  int get hashCode =>
      Object.hash(view.outcomeCode, view.phase, view.callbackAt, view.promiseDate, view.promiseAmount, view.notes.text, view.saving);
}

/// "Dialing is blocked until this call has an outcome. Without one, it closes
/// in 1:42." Outside the rail (the polite live region), so the ticking digits
/// are read when the agent goes to them and never announced every second.
class OutcomeCountdown extends ConsumerWidget {
  const OutcomeCountdown({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(softphoneViewProvider.select((v) => (phase: v.phase, due: v.outcomeDueAt)));
    if (s.phase != SoftphonePhase.outcome) return const SizedBox.shrink();
    final clock = ref.watch(stationClockProvider);
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final due = s.due;

    Widget line(DateTime now) {
      final left = due == null ? null : (due.isAfter(now) ? due.difference(now) : Duration.zero);
      final tail = left == null
          ? ''
          : left == Duration.zero
          ? ' ${SoftphoneCopy.closingNoOutcome}'
          : ' ${SoftphoneCopy.closesIn(formatClock(left, padMinutes: false))}';
      return Text(
        '${SoftphoneCopy.dialBlockedOwed}$tail',
        key: const Key('outcome-closes'),
        style: text.bodySmall!.copyWith(color: t.warning),
      );
    }

    if (due == null) return line(clock());
    return RepaintBoundary(
      child: TickingBuilder(now: clock, anchor: due, builder: (context, now) => line(now)),
    );
  }
}
