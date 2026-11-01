import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../logic/disposition_form.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import 'banners.dart';
import 'callback_picker.dart';
import 'layouts.dart';
import 'notes_field.dart';
import 'on_call_view.dart' show QueuedBreakChip;
import 'sheets.dart';

/// Wrap-up: pick the outcome, a callback time when it needs one, notes, save.
///
/// The station screen keys this on the call, so a new call starts with an
/// empty form, and the notes controller (owned by the screen) carries the
/// agent's text over from "On call".
class WrapupPhaseView extends ConsumerStatefulWidget {
  const WrapupPhaseView({super.key, required this.notes});

  final TextEditingController notes;

  @override
  ConsumerState<WrapupPhaseView> createState() => _WrapupViewState();
}

class _WrapupViewState extends ConsumerState<WrapupPhaseView> {
  DispositionForm _form = const DispositionForm();

  @override
  Widget build(BuildContext context) {
    final options = ref.watch(stationViewProvider.select((v) => v?.dispositions ?? const <DispositionOption>[]));
    final saved = ref.watch(stationViewProvider.select((v) => v?.dispositionSaved));
    final who = ref.watch(
      stationViewProvider.select((v) {
        final c = v?.call;
        if (c == null) return null;
        final name = c.displayName?.trim();
        return name != null && name.isNotEmpty ? name : formatPhone(c.phoneE164);
      }),
    );
    final saving = ref.watch(stationViewProvider.select((v) => v?.busy == StationBusy.savingDisposition));
    final attemptId = ref.watch(stationViewProvider.select((v) => v?.call?.attemptId));
    final text = Theme.of(context).textTheme;
    final selected = findDisposition(options, _form.code);
    final locked = saved != null || saving;

    return CallLayout(
      body: [
        Semantics(header: true, child: Text(StationCopy.howDidItGo(who), style: text.labelMedium)),
        const SizedBox(height: Space.sm),
        LinkGate(
          child: DispositionGrid(
            options: options,
            selected: saved ?? _form.code,
            enabled: !locked,
            onSelect: (code) => setState(() => _form = _form.select(code)),
          ),
        ),
        if (selected != null && selected.requiresCallbackTime && saved == null) ...[
          const SizedBox(height: Space.lg),
          LinkGate(
            child: CallbackPicker(
              form: _form,
              // The pickers close with this wrap-up.
              attemptId: attemptId,
              enabled: !locked,
              onPick: (at, choice) => setState(() => _form = _form.withCallback(at, choice)),
            ),
          ),
        ],
        const SizedBox(height: Space.lg),
        StationNotesField(controller: widget.notes, required: selected?.requiresNote ?? false),
        const SizedBox(height: Space.md),
        const LinkGate(child: QueuedBreakChip(offer: false)),
      ],
      bottom: LinkGate(
        child: _SaveArea(form: _form, notes: widget.notes, onSave: _save),
      ),
    );
  }

  Future<void> _save() async {
    final view = ref.read(stationViewProvider);
    if (view == null) return;
    final now = ref.read(stationClockProvider)();
    final submit = buildSubmit(view.dispositions, _form, widget.notes.text, now);
    if (submit == null) {
      // The time ran out between choosing it and pressing save: re-render
      // so the reason beside the button says so.
      setState(() {});
      return;
    }
    final option = findDisposition(view.dispositions, submit.code)!;
    if (option.suppresses) {
      final call = view.call;
      // About this call's wrap-up: it closes when the wrap-up ends or another
      // call arrives, and a "yes" that lands after that saves nothing.
      final scope = sameCall(call?.attemptId, const {AgentPhase.wrapup});
      final ok = await confirmDialog(
        context,
        title: StationCopy.suppressConfirmTitle,
        message: StationCopy.suppressConfirmBody(
          option.label,
          call == null ? '' : formatPhone(call.phoneE164),
          call?.campaignName ?? view.campaignName,
        ),
        confirm: StationCopy.suppressConfirmAction,
        danger: true,
        scope: scope,
      );
      if (!ok || !mounted || !scope(ref.read(stationViewProvider))) return;
    }
    await ref.read(stationActionsProvider).submitDisposition(submit.code, notes: submit.notes, callbackAt: submit.callbackAt);
  }
}

/// "Save outcome", with the reason it is disabled written beside it: a bare
/// greyed button reads as broken. Rebuilds on each keystroke (a required note)
/// without rebuilding the grid above.
class _SaveArea extends ConsumerWidget {
  const _SaveArea({required this.form, required this.notes, required this.onSave});

  final DispositionForm form;
  final TextEditingController notes;
  final Future<void> Function() onSave;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final options = ref.watch(stationViewProvider.select((v) => v?.dispositions ?? const <DispositionOption>[]));
    final saved = ref.watch(stationViewProvider.select((v) => v?.dispositionSaved));
    final autoReturn = ref.watch(stationViewProvider.select((v) => v?.wrapup?.autoReturn ?? true));
    final saving = ref.watch(stationViewProvider.select((v) => v?.busy == StationBusy.savingDisposition));
    final clock = ref.watch(stationClockProvider);
    final t = context.tokens;
    final text = Theme.of(context).textTheme;

    if (saved != null) {
      final label = findDisposition(options, saved)?.label ?? saved;
      return Semantics(
        container: true,
        child: Column(
          key: const Key('outcome-saved'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Icon(Icons.check_circle, color: t.success),
                const SizedBox(width: Space.sm),
                Expanded(
                  child: Text(StationCopy.outcomeSaved(label), style: text.titleSmall!.copyWith(color: t.success)),
                ),
              ],
            ),
            if (autoReturn) ...[const SizedBox(height: Space.xs), Text(StationCopy.savedReturning, style: text.bodySmall)],
          ],
        ),
      );
    }

    return ListenableBuilder(
      listenable: notes,
      builder: (context, _) {
        final block = dispositionBlock(options, form, notes.text, clock());
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (block != null && !saving) ...[
              Text(
                StationCopy.blockCopy(block),
                key: const Key('save-blocked'),
                style: text.bodySmall!.copyWith(color: block == DispositionBlock.callbackInPast ? t.danger : t.textSecondary),
              ),
              const SizedBox(height: Space.sm),
            ],
            FilledButton(
              key: const Key('save-outcome'),
              onPressed: block == null && !saving ? onSave : null,
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
              child: BusyLabel(label: saving ? StationCopy.savingOutcome : StationCopy.saveOutcome, busy: saving, color: t.onAccent),
            ),
          ],
        );
      },
    );
  }
}

/// The outcome buttons, two across, in the server's order (never re-sorted:
/// an agent's muscle memory is the position). Success and Do-Not-Call codes
/// carry a word and an icon, not only a colour.
class DispositionGrid extends StatelessWidget {
  const DispositionGrid({super.key, required this.options, required this.selected, required this.enabled, required this.onSelect});

  final List<DispositionOption> options;
  final String? selected;
  final bool enabled;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, c) {
        final scale = MediaQuery.textScalerOf(context).scale(15) / 15;
        final columns = scale > 1.6 || c.maxWidth < 280 ? 1 : 2;
        final w = ((c.maxWidth - Space.sm * (columns - 1)) / columns).floorToDouble();
        return Wrap(
          spacing: Space.sm,
          runSpacing: Space.sm,
          children: [
            for (var i = 0; i < options.length; i++)
              SizedBox(
                width: w,
                child: _OutcomeButton(
                  index: i,
                  option: options[i],
                  selected: options[i].code == selected,
                  onTap: enabled ? () => onSelect(options[i].code) : null,
                ),
              ),
          ],
        );
      },
    );
  }
}

class _OutcomeButton extends StatelessWidget {
  const _OutcomeButton({required this.index, required this.option, required this.selected, required this.onTap});

  final int index;
  final DispositionOption option;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final edge = option.suppresses ? t.danger : (option.isSuccess ? t.success : null);
    final border = selected ? t.accent : (edge?.withValues(alpha: 0.45) ?? t.border);
    final fg = option.suppresses ? t.danger : t.textPrimary;
    final marker = option.suppresses
        ? StationCopy.stopsCalling
        : option.isSuccess
        ? StationCopy.success
        : null;
    return Semantics(
      button: true,
      selected: selected,
      enabled: onTap != null,
      label: marker == null ? option.label : '${option.label}, $marker',
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: selected ? t.accentSubtle : t.bgSecondary,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Radii.md),
          side: BorderSide(color: border, width: selected ? 2 : 1),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: Key('outcome-${option.code}'),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 60),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.sm),
              child: Row(
                children: [
                  if (index < 9) ...[
                    Container(
                      width: 22,
                      height: 22,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(color: t.bgTertiary, borderRadius: BorderRadius.circular(6)),
                      child: Text('${index + 1}', style: text.labelSmall),
                    ),
                    const SizedBox(width: Space.sm),
                  ],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(option.label, style: text.labelLarge!.copyWith(color: fg)),
                        if (marker != null) Text(marker, style: text.labelSmall!.copyWith(color: edge)),
                      ],
                    ),
                  ),
                  if (option.isSuccess) Icon(Icons.check_circle_outline, size: 18, color: t.success),
                  if (option.suppresses) Icon(Icons.block, size: 18, color: t.danger),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
