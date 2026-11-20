import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/promise_rules.dart' show formatPromiseAmount;
import '../../../core/station/station_view.dart';
import '../../missed/missed_on_duty.dart';
import '../logic/disposition_form.dart';
import '../logic/format.dart';
import '../logic/wrapup_math.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import '../station_reads.dart' show watchComesToMe;
import '../widgets/action_buttons.dart';
import '../widgets/read_aloud_button.dart';
import '../widgets/ticking.dart';
import '../widgets/tile_pictures.dart';
import 'banners.dart';
import 'call_band.dart';
import 'callback_picker.dart';
import 'layouts.dart';
import 'notes_field.dart';
import 'on_call_view.dart' show DontCallAgainRow, QueuedBreakChip;
import 'promise_picker.dart';
import 'sheets.dart';

/// What happened? (05): one picture tile per outcome of this campaign's own list, two across; the
/// follow-up (pay date, call when) in a bottom sheet with large chips, then one summary row; the
/// note with Speak a note; Save & next call, Save & break, and Call again while the campaign allows
/// it. Nothing is ever picked for the agent: when the time runs out with nothing picked, the band
/// turns red-orange and says so (05d); with a tile picked, the server saves and moves on (today's
/// rule).
///
/// The station screen keys this on the call, so a new call starts with an empty form, and the notes
/// controller (owned by the screen) carries the agent's text over from On call.
class WrapupPhaseView extends ConsumerStatefulWidget {
  const WrapupPhaseView({super.key, required this.notes});

  final TextEditingController notes;

  @override
  ConsumerState<WrapupPhaseView> createState() => _WrapupViewState();
}

class _WrapupViewState extends ConsumerState<WrapupPhaseView> {
  DispositionForm _form = const DispositionForm();

  /// Save was pressed before the form was ready: the reason shows (spec §6.1).
  bool _tried = false;

  /// AS8, as last built: a call-later booked here comes back to this agent.
  bool _comesToMe = false;
  final _noteFocus = FocusNode(debugLabel: 'wrapup-note');

  @override
  void dispose() {
    _noteFocus.dispose();
    super.dispose();
  }

  Future<void> _pick(String code) async {
    setState(() {
      _form = _form.select(code);
      _tried = false;
    });
    final option = findDisposition(ref.read(stationViewProvider)?.dispositions ?? const [], code);
    if (option == null) return;
    if (option.requiresCallbackTime || option.requiresPromise) await _followUp(option);
  }

  Future<void> _followUp(DispositionOption option) async {
    final attemptId = ref.read(stationViewProvider)?.call?.attemptId;
    final own = _comesToMe;
    final next = await showFollowUpSheet(
      context,
      option: option,
      form: _form,
      attemptId: attemptId,
      callLaterLine: own ? StationCopy.callWillComeToYou : StationCopy.callWillBeMade,
    );
    if (next != null && mounted) setState(() => _form = next);
  }

  @override
  Widget build(BuildContext context) {
    final options = ref.watch(stationViewProvider.select((v) => v?.dispositions ?? const <DispositionOption>[]));
    final saved = ref.watch(stationViewProvider.select((v) => v?.dispositionSaved));
    final saving = ref.watch(
      stationViewProvider.select((v) => v?.busy == StationBusy.savingDisposition || v?.busy == StationBusy.redialing),
    );
    final cut = ref.watch(stationViewProvider.select((v) => v?.release?.tone == ReleaseTone.danger && (v?.release?.requiresDisposition ?? false)));
    final selected = findDisposition(options, _form.code);
    final locked = saved != null || saving;
    _comesToMe = watchComesToMe(ref);

    return CallPage(
      body: [
        const _WrapupBanner(),
        if (cut && saved == null) const _Line(key: Key('call-cut'), text: StationCopy.callWasCut, icon: Icons.wifi_off),
        LinkGate(
          child: OutcomeTiles(
            options: options,
            selected: saved ?? _form.code,
            enabled: !locked,
            onSelect: _pick,
          ),
        ),
        if (selected != null && saved == null && (selected.requiresCallbackTime || selected.requiresPromise)) ...[
          const SizedBox(height: Space.md),
          LinkGate(child: FollowUpRow(option: selected, form: _form, onChange: () => _followUp(selected))),
        ],
        // The list has no stop tile: Don't call again as its own row (spec §6.2), as the console.
        const DontCallAgainRow(),
        const SizedBox(height: Space.md),
        StationNotesField(
          controller: widget.notes,
          required: selected?.requiresNote ?? false,
          focusNode: _noteFocus,
          trailing: SpeakNoteButton(focus: _noteFocus),
        ),
        const SizedBox(height: Space.md),
        const LinkGate(child: QueuedBreakChip(offer: false)),
        // IQ48: the customers waiting to be called back, a tap from the list.
        const MissedToCallBackLine(),
      ],
      actions: LinkGate(
        child: _SaveArea(
          form: _form,
          notes: widget.notes,
          tried: _tried,
          onBlocked: () {
            HapticFeedback.heavyImpact();
            setState(() => _tried = true);
          },
          onSave: _save,
          onSaveAndBreak: _saveAndBreak,
          onRedial: _redial,
        ),
      ),
    );
  }

  Future<void> _redial() async {
    final view = ref.read(stationViewProvider);
    if (view == null) return;
    // The call the agent is looking at: a tap on a stale screen redials nothing.
    await ref.read(stationActionsProvider).redial(attemptId: view.call?.attemptId);
  }

  /// Save & break: which break first (queued behind this screen, as the server does), then save.
  /// Cancel on Which break? saves nothing. A break picked after this screen has gone (the time ran
  /// out with a tile picked, and the server saved it) is still sent: the agent asked for it.
  Future<void> _saveAndBreak() async {
    final actions = ref.read(stationActionsProvider);
    final container = ProviderScope.containerOf(context, listen: false);
    final callId = ref.read(stationViewProvider)?.callId;
    final code = await pickBreakReason(context, queued: true);
    if (code == null) return;
    if (code == switchToSoftphoneChoice) {
      if (!mounted) return;
      await switchStationToSoftphone(context);
    } else {
      await actions.takeBreak(code);
    }
    final now = container.read(stationViewProvider);
    // Saved only on this call's What happened?, and not when the break was refused (its reason is
    // on screen: the agent decides again).
    if (!mounted || !sameCall(callId, const {AgentPhase.wrapup})(now) || now?.actionError != null) return;
    await _save();
  }

  Future<void> _save() async {
    final view = ref.read(stationViewProvider);
    if (view == null) return;
    final now = ref.read(stationClockProvider)();
    final submit = buildSubmit(view.dispositions, _form, widget.notes.text, now);
    if (submit == null) {
      // The time ran out between choosing it and pressing save: say why.
      setState(() => _tried = true);
      return;
    }
    final option = findDisposition(view.dispositions, submit.code)!;
    if (option.suppresses) {
      final call = view.call;
      // About this call's wrap-up: it closes when the wrap-up ends or another
      // call arrives, and a "yes" that lands after that saves nothing.
      final scope = sameCall(call?.attemptId, const {AgentPhase.wrapup});
      final name = (call?.facts?.name ?? call?.displayName)?.trim();
      final phone = call == null ? '' : stationPhone(call.phoneE164, masked: view.maskPhone);
      final ok = await confirmSheet(
        context,
        title: StationCopy.stopCallingTitle,
        detail: name == null || name.isEmpty ? phone : '$name · $phone',
        message: StationCopy.stopCallingBody,
        confirm: StationCopy.yesStopCalls,
        cancel: StationCopy.noGoBack,
        scope: scope,
      );
      if (!ok || !mounted || !scope(ref.read(stationViewProvider))) return;
    }
    await ref.read(stationActionsProvider).submitDisposition(
          submit.code,
          notes: submit.notes,
          callbackAt: submit.callbackAt,
          promiseDate: submit.promiseDate,
          promiseAmount: submit.promiseAmount,
        );
  }
}

/// Speak a note (AS13): puts the cursor in the note, so the keyboard's own microphone dictates.
class SpeakNoteButton extends StatelessWidget {
  const SpeakNoteButton({super.key, required this.focus});

  final FocusNode focus;

  @override
  Widget build(BuildContext context) {
    final c = context.stateTokens.happened;
    return IconButton(
      key: const Key('speak-note'),
      tooltip: StationCopy.speakNote,
      onPressed: () {
        focus.requestFocus();
        SystemChannels.textInput.invokeMethod<void>('TextInput.show');
      },
      style: IconButton.styleFrom(
        minimumSize: const Size(52, 52),
        side: BorderSide(color: c.deep.withValues(alpha: 0.5)),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.md)),
      ),
      icon: Icon(Icons.mic_none, color: c.deep),
    );
  }
}

/// Under the band: the time is over with nothing saved (05d), or a supervisor holds the screen.
class _WrapupBanner extends ConsumerWidget {
  const _WrapupBanner();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final w = ref.watch(stationViewProvider.select((v) => v?.wrapup));
    final saved = ref.watch(stationViewProvider.select((v) => v?.dispositionSaved != null));
    final requires = ref.watch(stationViewProvider.select((v) => v?.release?.requiresDisposition ?? true));
    final now = ref.watch(stationClockProvider);
    if (w == null || saved) return const SizedBox.shrink();
    Widget line(DateTime at) {
      final clock = wrapupClock(w, at, requiresDisposition: requires);
      if (clock.supervisorHold) return const _Line(key: Key('wrapup-held-line'), text: StationCopy.heldBanner, icon: Icons.front_hand_outlined);
      if (clock.holding) return const _Line(key: Key('time-over'), text: StationCopy.timeOverBanner, icon: Icons.timer_off_outlined, over: true);
      return const SizedBox.shrink();
    }

    final endsAt = w.endsAt;
    if (endsAt == null) return line(now());
    return TickingBuilder(now: now, anchor: endsAt, builder: (context, at) => line(at));
  }
}

/// One line under the band, up to two lines of text, with its icon.
class _Line extends StatelessWidget {
  const _Line({super.key, required this.text, required this.icon, this.over = false});

  final String text;
  final IconData icon;
  final bool over;

  @override
  Widget build(BuildContext context) {
    final s = context.stateTokens;
    final c = over ? s.over : s.problem;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.md),
      child: Semantics(
        liveRegion: true,
        container: true,
        child: DecoratedBox(
          decoration: BoxDecoration(color: c.soft, borderRadius: BorderRadius.circular(Radii.md), border: Border.all(color: c.deep.withValues(alpha: 0.4))),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.sm),
            child: Row(
              children: [
                Icon(icon, color: c.deep),
                const SizedBox(width: Space.sm),
                Expanded(child: Text(text, style: Theme.of(context).textTheme.titleSmall!.copyWith(color: c.deep))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The customer's amount due for the Full and Half chips: the server's typed money fact in the
/// amount-due role (BE-6), its parsed value; null without one (an untyped column is never guessed).
String? amountDueOf(CallView? call) {
  for (final t in call?.facts?.tiles ?? const <FactTileView>[]) {
    if (t.amountDue && t.kind == FactKind.money && t.parsed != null) return t.parsed;
  }
  return null;
}

/// The follow-up's one summary row: "Will pay on Fri 20 Nov · 12,500 · Change", "Call later · Fri 20
/// Nov at 10:00 AM · Change", or, before it is given, what is still needed and Choose.
class FollowUpRow extends StatelessWidget {
  const FollowUpRow({super.key, required this.option, required this.form, required this.onChange});

  final DispositionOption option;
  final DispositionForm form;
  final VoidCallback onChange;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final c = context.stateTokens.ready;
    final text = Theme.of(context).textTheme;
    final promise = option.requiresPromise;
    final at = form.callbackAt;
    final day = form.promiseDate;
    final amount = form.promiseAmount.trim();
    final String? summary = promise
        ? (day == null ? null : StationCopy.willPayOn(formatWeekdayDay(day), amount.isEmpty ? null : formatPromiseAmount(amount)))
        : (at == null ? null : StationCopy.callLaterOn(formatWhen(at)));
    return Semantics(
      container: true,
      child: DecoratedBox(
        key: const Key('follow-up-row'),
        decoration: BoxDecoration(color: t.bgSecondary, borderRadius: BorderRadius.circular(Radii.lg), border: Border.all(color: t.border)),
        child: Padding(
          padding: const EdgeInsets.all(Space.md),
          child: Row(
            children: [
              DecoratedBox(
                decoration: BoxDecoration(color: c.soft, borderRadius: BorderRadius.circular(Radii.md)),
                child: SizedBox.square(
                  dimension: 44,
                  child: Icon(promise ? Icons.event_available_outlined : Icons.schedule, color: c.deep),
                ),
              ),
              const SizedBox(width: Space.md),
              Expanded(
                child: Text(
                  summary ?? (promise ? StationCopy.choosePayDate : StationCopy.chooseWhen),
                  key: const Key('follow-up-summary'),
                  style: text.titleMedium,
                ),
              ),
              const SizedBox(width: Space.sm),
              OutlinedButton(
                key: const Key('follow-up-change'),
                onPressed: onChange,
                child: Text(summary == null ? StationCopy.ok : StationCopy.change),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The follow-up of a picked outcome (design-spec §4: a bottom sheet with large chips and OK):
/// Call when? for an outcome that books a call later, the pay date and amount for one that records
/// a promise to pay. Returns the form with what was chosen, or null for Back (the tile stays picked,
/// and Save says what is still needed). Closes with this call's What happened?.
///
/// [callLaterLine] says who makes a call-later at the time picked (AS8): "This call will come to
/// you on …", "We will call on … Another agent may get the call.", or for a caller on no list,
/// that the agent calls back themselves.
Future<DispositionForm?> showFollowUpSheet(
  BuildContext context, {
  required DispositionOption option,
  required DispositionForm form,
  required String? attemptId,
  required String Function(String when) callLaterLine,
}) {
  final scope = sameCall(attemptId, const {AgentPhase.wrapup});
  return showModalBottomSheet<DispositionForm>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => StationModalGuard(
      scope: scope,
      child: _FollowUpSheet(option: option, form: form, attemptId: attemptId, callLaterLine: callLaterLine),
    ),
  );
}

class _FollowUpSheet extends ConsumerStatefulWidget {
  const _FollowUpSheet({required this.option, required this.form, required this.attemptId, required this.callLaterLine});

  final DispositionOption option;
  final DispositionForm form;
  final String? attemptId;
  final String Function(String when) callLaterLine;

  @override
  ConsumerState<_FollowUpSheet> createState() => _FollowUpSheetState();
}

class _FollowUpSheetState extends ConsumerState<_FollowUpSheet> {
  late DispositionForm _form = widget.form;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final now = ref.watch(stationClockProvider)();
    final promise = widget.option.requiresPromise;
    final block = dispositionBlock([widget.option], _form.select(widget.option.code), 'x', now);
    // Only the follow-up's own reasons count here (the note is the screen's).
    final ready = block == null || block == DispositionBlock.noteRequired;
    final at = _form.callbackAt;
    return SingleChildScrollView(
      key: const Key('follow-up-sheet'),
      padding: EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.lg + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(promise ? Icons.event_available_outlined : Icons.schedule, color: t.textPrimary),
              const SizedBox(width: Space.sm),
              Expanded(
                child: Semantics(
                  header: true,
                  child: Text(promise ? StationCopy.willPay : StationCopy.callWhen, style: text.headlineSmall),
                ),
              ),
            ],
          ),
          const SizedBox(height: Space.md),
          if (promise)
            PromisePicker(
              form: _form,
              option: widget.option,
              attemptId: widget.attemptId,
              amountDue: ref.watch(stationViewProvider.select((v) => amountDueOf(v?.call))),
              onDate: (day) => setState(() => _form = _form.withPromiseDate(day)),
              onAmount: (amount) => setState(() => _form = _form.withPromiseAmount(amount)),
            )
          else ...[
            CallbackPicker(
              plain: true,
              form: _form,
              attemptId: widget.attemptId,
              onPick: (at, choice) => setState(() => _form = _form.withCallback(at, choice)),
            ),
            if (at != null && at.isAfter(now)) ...[
              const SizedBox(height: Space.sm),
              Row(
                children: [
                  Icon(Icons.notifications_none, size: 18, color: t.textMuted),
                  const SizedBox(width: Space.xs),
                  Expanded(
                    child: Text(
                      widget.callLaterLine(formatWhen(at)),
                      key: const Key('call-later-who'),
                      style: text.bodyMedium,
                    ),
                  ),
                ],
              ),
            ],
          ],
          // What still stops OK, once something was chosen (a time already gone, an amount that is
          // not a number).
          if (!ready && block != DispositionBlock.callbackRequired && block != DispositionBlock.promiseRequired) ...[
            const SizedBox(height: Space.sm),
            Text(
              StationCopy.blockCopy(block),
              key: const Key('follow-up-blocked'),
              style: text.titleSmall!.copyWith(color: context.stateTokens.problem.deep),
            ),
          ],
          const SizedBox(height: Space.lg),
          ButtonPair(
            first: SecondaryActionButton(
              key: const Key('follow-up-back'),
              label: StationCopy.back,
              onPressed: () => Navigator.of(context).pop(),
            ),
            second: MainActionButton(
              key: const Key('follow-up-ok'),
              label: StationCopy.ok,
              icon: Icons.check,
              onPressed: ready ? () => Navigator.of(context).pop(_form) : null,
            ),
          ),
        ],
      ),
    );
  }
}

/// Save & next call, with Save & break and Call again under it. Save is the one control on the
/// station shown faded rather than hidden (spec §6.1): before the form is ready it stays in place,
/// and pressing it says what is missing ("Choose one first."). Rebuilds on each keystroke (a needed
/// note) without rebuilding the tiles above.
class _SaveArea extends ConsumerWidget {
  const _SaveArea({
    required this.form,
    required this.notes,
    required this.tried,
    required this.onBlocked,
    required this.onSave,
    required this.onSaveAndBreak,
    required this.onRedial,
  });

  final DispositionForm form;
  final TextEditingController notes;
  final bool tried;
  final VoidCallback onBlocked;
  final Future<void> Function() onSave;
  final Future<void> Function() onSaveAndBreak;
  final Future<void> Function() onRedial;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final options = ref.watch(stationViewProvider.select((v) => v?.dispositions ?? const <DispositionOption>[]));
    final saved = ref.watch(stationViewProvider.select((v) => v?.dispositionSaved));
    final dnc = ref.watch(stationViewProvider.select((v) => v?.dncOutcome));
    final autoReturn = ref.watch(stationViewProvider.select((v) => v?.wrapup?.autoReturn ?? true));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    final remaining = ref.watch(stationViewProvider.select(_redialRemaining));
    final saving = busy == StationBusy.savingDisposition;
    final redialing = busy == StationBusy.redialing;
    final clock = ref.watch(stationClockProvider);
    final t = context.tokens;
    final s = context.stateTokens;
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
                Icon(Icons.check_circle, color: s.ready.deep),
                const SizedBox(width: Space.sm),
                Expanded(child: Text(StationCopy.savedAs(label), style: text.titleMedium!.copyWith(color: s.ready.deep))),
              ],
            ),
            // What the outcome did to the Do Not Call list when it is not what the agent was
            // promised (DS8: the number could not go on it).
            if (dnc != null) ...[
              const SizedBox(height: Space.xs),
              Text(dnc, key: const Key('dnc-outcome'), style: text.bodySmall),
            ],
            if (autoReturn) ...[const SizedBox(height: Space.xs), Text(StationCopy.nextCallSoon, style: text.bodySmall)],
          ],
        ),
      );
    }

    return ListenableBuilder(
      listenable: notes,
      builder: (context, _) {
        final block = dispositionBlock(options, form, notes.text, clock());
        // The reason shows once Save was pressed, or once a tile is picked and something else is
        // missing; a time already gone is said at once.
        final say = block != null && (tried || block != DispositionBlock.noSelection) && !saving && !redialing;
        final redial = remaining != null && remaining > 0
            ? SecondaryActionButton(
                key: const Key('redial'),
                label: redialing ? StationCopy.callingAgain : StationCopy.callAgainLeft(remaining),
                icon: Icons.replay,
                busy: redialing,
                semanticsLabel: redialing ? StationCopy.redialling : StationCopy.callAgainLeft(remaining),
                onPressed: busy == StationBusy.none ? onRedial : null,
              )
            : null;
        final saveBreak = SecondaryActionButton(
          key: const Key('save-and-break'),
          label: StationCopy.saveAndBreak,
          icon: Icons.free_breakfast_outlined,
          onPressed: saving || redialing ? null : (block == null ? onSaveAndBreak : onBlocked),
        );
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (say) ...[
              Semantics(
                liveRegion: true,
                child: Text(
                  StationCopy.blockCopy(block),
                  key: const Key('save-blocked'),
                  style: text.titleSmall!.copyWith(color: block == DispositionBlock.callbackInPast || tried ? t.danger : t.textSecondary),
                ),
              ),
              const SizedBox(height: Space.sm),
            ],
            MainActionButton(
              key: const Key('save-outcome'),
              label: saving ? StationCopy.savingOutcome : StationCopy.saveAndNext,
              icon: Icons.check,
              busy: saving,
              dimmed: block != null,
              onPressed: redialing ? null : (block == null ? onSave : onBlocked),
            ),
            const SizedBox(height: Space.sm),
            if (redial == null) saveBreak else ButtonPair(first: saveBreak, second: redial),
          ],
        );
      },
    );
  }
}

/// Call again left on the wrap-up on screen, or null when it is not offered. Never offered once an
/// outcome is saved (here or elsewhere): there is nothing left to call again for.
int? _redialRemaining(StationView? v) {
  final w = v?.wrapup;
  if (w == null || w.dispositionSubmitted || v?.dispositionSaved != null) return null;
  return w.redialRemaining;
}

/// The outcome tiles (05; design-spec §6.2): the campaign's own list in its order (never re-sorted:
/// an agent's muscle memory is the position), two across on the phone, no key numbers. Each has a
/// picture by what the outcome does, until outcomes carry an icon of their own (BE-13): ₹ for a
/// promise to pay, a clock for call later, a stop sign for don't call again, a thumbs-up for a
/// success, a dot otherwise. The picked tile has a green border and a tick, never colour alone.
/// The speaker that reads a tile aloud (AS13) is not here: see `docs/mobile.md`.
class OutcomeTiles extends StatefulWidget {
  const OutcomeTiles({super.key, required this.options, required this.selected, required this.enabled, required this.onSelect});

  final List<DispositionOption> options;
  final String? selected;
  final bool enabled;
  final ValueChanged<String> onSelect;

  /// Up to nine fit; past that the first eight and a More tile that opens the rest (spec §6.2, the
  /// console's `outcomeTileLayout`).
  static const maxWithoutMore = 9;
  static const beforeMore = 8;

  @override
  State<OutcomeTiles> createState() => _OutcomeTilesState();
}

class _OutcomeTilesState extends State<OutcomeTiles> {
  bool _showAll = false;

  @override
  Widget build(BuildContext context) {
    final all = widget.options;
    final overflowing = all.length > OutcomeTiles.maxWithoutMore;
    // An outcome behind More that is picked keeps the rest open.
    final pickedBehind = all.indexWhere((o) => o.code == widget.selected) >= OutcomeTiles.beforeMore;
    final expanded = !overflowing || _showAll || pickedBehind;
    final options = expanded ? all : all.sublist(0, OutcomeTiles.beforeMore);
    final selected = widget.selected;
    final enabled = widget.enabled;
    final onSelect = widget.onSelect;
    return LayoutBuilder(
      builder: (context, c) {
        final scale = MediaQuery.textScalerOf(context).scale(16) / 16;
        final columns = scale > 1.6 || c.maxWidth < 280 ? 1 : 2;
        final w = ((c.maxWidth - Space.sm * (columns - 1)) / columns).floorToDouble();
        // 1–6: big tiles; 7 or more: smaller ones (spec §6.2).
        final big = all.length <= 6;
        return Wrap(
          spacing: Space.sm,
          runSpacing: Space.sm,
          children: [
            for (final o in options)
              SizedBox(
                width: w,
                child: _OutcomeTile(
                  option: o,
                  big: big,
                  selected: o.code == selected,
                  onTap: enabled ? () => onSelect(o.code) : null,
                ),
              ),
            if (!expanded)
              SizedBox(
                width: w,
                child: _MoreTile(hidden: all.length - OutcomeTiles.beforeMore, onTap: () => setState(() => _showAll = true)),
              ),
          ],
        );
      },
    );
  }
}

/// The More tile: the outcomes past the first eight, opened in place.
class _MoreTile extends StatelessWidget {
  const _MoreTile({required this.hidden, required this.onTap});

  final int hidden;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Semantics(
      button: true,
      label: '${StationCopy.moreOutcomes}, ${StationCopy.moreOutcomesHint(hidden)}',
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: t.bgSecondary,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Radii.lg),
          side: BorderSide(color: t.borderStrong, width: 1.5),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: const Key('outcome-more'),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 64),
            child: Padding(
              padding: const EdgeInsets.all(Space.sm),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.more_horiz, color: t.textSecondary),
                  const SizedBox(width: Space.xs),
                  Flexible(
                    child: Text.rich(
                      TextSpan(
                        text: StationCopy.moreOutcomes,
                        style: text.titleMedium,
                        children: [TextSpan(text: ' · ${StationCopy.moreOutcomesHint(hidden)}', style: text.bodySmall)],
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// An outcome's picture: the supervisor's (BE-13), else one by what it does (design-spec §5.4).
IconData outcomeIcon(DispositionOption o) {
  final chosen = o.icon;
  if (chosen != null) return tilePictureIcon(chosen);
  if (o.suppresses) return Icons.block;
  if (o.requiresPromise) return Icons.currency_rupee;
  if (o.requiresCallbackTime) return Icons.schedule;
  if (o.isSuccess) return Icons.thumb_up_outlined;
  return Icons.radio_button_unchecked;
}

class _OutcomeTile extends StatelessWidget {
  const _OutcomeTile({required this.option, required this.big, required this.selected, required this.onTap});

  final DispositionOption option;
  final bool big;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final s = context.stateTokens;
    final text = Theme.of(context).textTheme;
    final ink = option.suppresses ? s.problem : (option.isSuccess || option.requiresPromise ? s.ready : s.coming);
    return Semantics(
      button: true,
      selected: selected,
      enabled: onTap != null,
      label: option.label,
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: selected ? s.ready.soft : t.bgSecondary,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Radii.lg),
          side: BorderSide(color: selected ? s.ready.deep : t.borderStrong, width: selected ? 2.5 : 1.5),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: Key('outcome-${option.code}'),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: big ? 86 : 64),
            child: Stack(
              children: [
                Padding(
                  padding: const EdgeInsets.all(Space.sm),
                  child: Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (big) ...[
                          DecoratedBox(
                            decoration: BoxDecoration(color: ink.soft, shape: BoxShape.circle),
                            child: SizedBox.square(dimension: 36, child: Icon(outcomeIcon(option), size: 22, color: ink.deep)),
                          ),
                          const SizedBox(height: Space.xs),
                        ],
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (!big) ...[Icon(outcomeIcon(option), size: 18, color: ink.deep), const SizedBox(width: Space.xs)],
                            Flexible(
                              child: Text(
                                option.label,
                                textAlign: TextAlign.center,
                                style: text.titleMedium!.copyWith(color: option.suppresses ? s.problem.deep : t.textPrimary),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
                if (selected)
                  Positioned(top: 4, right: 4, child: Icon(Icons.check_circle, size: 22, color: s.ready.deep)),
                // Read the label aloud (AS13); a screen reader reads the tile itself.
                Positioned(
                  top: 0,
                  left: 0,
                  child: ExcludeSemantics(
                    child: ReadAloudButton(key: Key('read-aloud-${option.code}'), text: option.label),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
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
