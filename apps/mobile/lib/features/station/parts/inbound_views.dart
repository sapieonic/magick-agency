import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../../missed/missed_on_duty.dart';
import '../logic/disposition_form.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import '../station_reads.dart' show watchInboundComesToMe;
import '../widgets/action_buttons.dart';
import '../widgets/slide_to_confirm.dart';
import 'banners.dart';
import 'call_band.dart';
import 'contact_details.dart';
import 'notes_field.dart';
import 'on_call_view.dart' show ControlTile, QueuedBreakChip;
import 'sheets.dart';
import 'wrapup_view.dart' show FollowUpRow, OutcomeTiles, SpeakNoteButton, showFollowUpSheet;

/// An inbound caller on the station (`docs/inbound.md` §6): the console's inbound panel
/// (`InboundCallView.tsx`) in the station's own phone geometry. The three screens follow the
/// call: offered (who is ringing, before their audio binds), on the call, and the outcome. They
/// reuse the campaign call's band, layout, notes, pad, callback picker and hang-up, so an agent
/// reaches for the same things in the same places.

InboundCallView? _inbound(StationView? v) => v?.inbound;

/// Offered: the caller, before their audio binds at `connects_at`. Hang up is not offered yet.
class InboundOfferView extends ConsumerWidget {
  const InboundOfferView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final call = ref.watch(stationViewProvider.select(_inbound));
    if (call == null) return const SizedBox.shrink();
    return CallPage(
      body: [
        InboundHeadline(call: call),
        const SizedBox(height: Space.md),
        InboundBadges(call: call),
        if (call.callerDnc) ...[const SizedBox(height: Space.md), const _DncEnquiry()],
        const SizedBox(height: Space.lg),
        InboundFacts(call: call),
        const SizedBox(height: Space.lg),
        InboundMatch(call: call, priorLimit: 3),
      ],
      actions: const InboundHangUpBar(),
    );
  }
}

/// On the call: notes, the controls, the queued break and hang-up.
class InboundOnCallView extends ConsumerWidget {
  const InboundOnCallView({super.key, required this.notes});

  final TextEditingController notes;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final call = ref.watch(stationViewProvider.select(_inbound));
    final interrupted = ref.watch(stationViewProvider.select((v) => v?.audio.interruption ?? AudioInterruption.none));
    final dnc = ref.watch(stationViewProvider.select((v) => v?.dncOutcome));
    if (call == null) return const SizedBox.shrink();
    return CallPage(
      body: [
        if (interrupted != AudioInterruption.none) _InboundInterruption(kind: interrupted) else InboundSummary(call: call),
        const SizedBox(height: Space.lg),
        StationNotesField(controller: notes),
        const SizedBox(height: Space.lg),
        const LinkGate(child: InboundControlRow()),
        if (dnc != null) ...[const SizedBox(height: Space.sm), _DncOutcomeLine(text: dnc)],
        const SizedBox(height: Space.md),
        const LinkGate(child: QueuedBreakChip()),
      ],
      actions: const InboundHangUpBar(),
    );
  }
}

/// The call ended after it was answered: What happened?, as the outbound call has it (05): one
/// picture tile per outcome of the call's own list, the follow-up (pay date, call when) in a bottom
/// sheet then one summary row, the note with Speak a note, Don't call again when the list has no
/// such tile, and Save. The band counts down to when the call closes without one. Keyed on the call
/// by the station screen.
///
/// A call-later follows the matched campaign's routing (AS8): "This call will come to you" on a
/// `strict` or `preferred` one, "Another agent may get the call." on `pool`, and for a caller on no
/// list, the agent calls back themselves (the console's `useMatchedComesToMe`).
class InboundOutcomeView extends ConsumerStatefulWidget {
  const InboundOutcomeView({super.key, required this.notes});

  final TextEditingController notes;

  @override
  ConsumerState<InboundOutcomeView> createState() => _InboundOutcomeViewState();
}

class _InboundOutcomeViewState extends ConsumerState<InboundOutcomeView> {
  DispositionForm _form = const DispositionForm();

  /// Save was pressed before the form was ready: the reason shows (spec §6.1).
  bool _tried = false;
  final _noteFocus = FocusNode(debugLabel: 'inbound-note');

  /// AS8, as last built (null: the caller is on no list).
  bool? _comesToMe;

  @override
  void dispose() {
    _noteFocus.dispose();
    super.dispose();
  }

  String Function(String when) get _callLaterLine => switch (_comesToMe) {
        true => StationCopy.callWillComeToYou,
        false => StationCopy.callWillBeMade,
        null => StationCopy.callBackYourself,
      };

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
    final callId = ref.read(stationViewProvider)?.inbound?.callId;
    final next = await showFollowUpSheet(context, option: option, form: _form, attemptId: callId, callLaterLine: _callLaterLine);
    if (next != null && mounted) setState(() => _form = next);
  }

  @override
  Widget build(BuildContext context) {
    final call = ref.watch(stationViewProvider.select(_inbound));
    final options = ref.watch(stationViewProvider.select((v) => v?.dispositions ?? const <DispositionOption>[]));
    final saved = ref.watch(stationViewProvider.select((v) => v?.dispositionSaved));
    final saving = ref.watch(stationViewProvider.select((v) => v?.busy == StationBusy.savingDisposition));
    final dnc = ref.watch(stationViewProvider.select((v) => v?.dncOutcome));
    if (call == null) return const SizedBox.shrink();
    _comesToMe = watchInboundComesToMe(ref, call);
    final selected = findDisposition(options, _form.code);
    final locked = saved != null || saving;
    // Don't call again as its own row only when the list has no such tile (spec §6.2), never for a
    // withheld number (nothing to add), and not once it is done.
    final dontCallAgain = !options.any((o) => o.suppresses) && !call.withheld && dnc == null && saved == null;

    return CallPage(
      body: [
        if (dnc != null) ...[_DncOutcomeLine(text: dnc), const SizedBox(height: Space.md)],
        LinkGate(
          child: OutcomeTiles(options: options, selected: saved ?? _form.code, enabled: !locked, onSelect: _pick),
        ),
        if (selected != null && saved == null && (selected.requiresCallbackTime || selected.requiresPromise)) ...[
          const SizedBox(height: Space.md),
          LinkGate(child: FollowUpRow(option: selected, form: _form, onChange: () => _followUp(selected))),
        ],
        if (dontCallAgain) LinkGate(child: _InboundDontCallAgain(busy: ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none)))),
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
        child: _InboundSaveArea(
          form: _form,
          notes: widget.notes,
          tried: _tried,
          onBlocked: () {
            HapticFeedback.heavyImpact();
            setState(() => _tried = true);
          },
          onSave: _save,
        ),
      ),
    );
  }

  Future<void> _save() async {
    final view = ref.read(stationViewProvider);
    final call = view?.inbound;
    if (view == null || call == null) return;
    final now = ref.read(stationClockProvider)();
    final submit = buildSubmit(view.dispositions, _form, widget.notes.text, now);
    if (submit == null) {
      setState(() => _tried = true);
      return;
    }
    final option = findDisposition(view.dispositions, submit.code)!;
    // A withheld caller has no number to add: the outcome is saved and nothing else happens,
    // so there is nothing irreversible to confirm.
    final from = call.fromE164;
    if (option.suppresses && from != null) {
      final scope = sameCall(call.callId, const {AgentPhase.wrapup});
      final ok = await confirmSheet(
        context,
        title: StationCopy.stopCallingTitle,
        detail: InboundCopy.who(call, masked: view.maskPhone) == stationPhone(from, masked: view.maskPhone)
            ? stationPhone(from, masked: view.maskPhone)
            : '${InboundCopy.who(call, masked: view.maskPhone)} · ${stationPhone(from, masked: view.maskPhone)}',
        message: InboundCopy.stopCallingBody(call.matched ? call.campaignName : null),
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

/// Save: faded, not hidden, until the form is ready (spec §6.1), and its press then says what is
/// missing; or what was saved.
class _InboundSaveArea extends ConsumerWidget {
  const _InboundSaveArea({required this.form, required this.notes, required this.tried, required this.onBlocked, required this.onSave});

  final DispositionForm form;
  final TextEditingController notes;
  final bool tried;
  final VoidCallback onBlocked;
  final Future<void> Function() onSave;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final options = ref.watch(stationViewProvider.select((v) => v?.dispositions ?? const <DispositionOption>[]));
    final saved = ref.watch(stationViewProvider.select((v) => v?.dispositionSaved));
    final saving = ref.watch(stationViewProvider.select((v) => v?.busy == StationBusy.savingDisposition));
    final clock = ref.watch(stationClockProvider);
    final t = context.tokens;
    final s = context.stateTokens;
    final text = Theme.of(context).textTheme;
    if (saved != null) {
      final label = findDisposition(options, saved)?.label ?? saved;
      return Semantics(
        container: true,
        child: Row(
          key: const Key('outcome-saved'),
          children: [
            Icon(Icons.check_circle, color: s.ready.deep),
            const SizedBox(width: Space.sm),
            Expanded(child: Text(StationCopy.savedAs(label), style: text.titleMedium!.copyWith(color: s.ready.deep))),
          ],
        ),
      );
    }
    return ListenableBuilder(
      listenable: notes,
      builder: (context, _) {
        final block = dispositionBlock(options, form, notes.text, clock());
        final say = block != null && (tried || block != DispositionBlock.noSelection) && !saving;
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
              label: saving ? StationCopy.savingOutcome : StationCopy.save,
              icon: Icons.check,
              busy: saving,
              dimmed: block != null,
              onPressed: block == null ? onSave : onBlocked,
            ),
          ],
        );
      },
    );
  }
}

/// Don't call again, under the tiles, when the list has no such tile (spec §6.2): the caller's
/// number, in the matched campaign's list, else the account's, with the same confirm.
class _InboundDontCallAgain extends StatelessWidget {
  const _InboundDontCallAgain({required this.busy});

  final StationBusy busy;

  @override
  Widget build(BuildContext context) {
    final red = context.stateTokens.problem.deep;
    final marking = busy == StationBusy.markingDnc;
    return Padding(
      padding: const EdgeInsets.only(top: Space.sm),
      child: TextButton.icon(
        key: const Key('control-dnc'),
        style: TextButton.styleFrom(foregroundColor: red, minimumSize: const Size.fromHeight(48)),
        onPressed: busy == StationBusy.none ? () => markInboundDnc(context) : null,
        icon: const Icon(Icons.block),
        label: Text(marking ? StationCopy.markingDnc : StationCopy.dontCallAgain),
      ),
    );
  }
}

// ─── The caller ─────────────────────────────────────────────────────────────

/// "Rahul Deshpande" over "+91 87654 32109 · Inbound call"; the number leads when no contact
/// matched, and "Number withheld" when the caller hid it. Masked when the campaign masks numbers
/// (AS9).
class InboundHeadline extends ConsumerWidget {
  const InboundHeadline({super.key, required this.call});

  final InboundCallView call;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final text = Theme.of(context).textTheme;
    final masked = ref.watch(stationViewProvider.select((v) => v?.maskPhone ?? false));
    final name = call.displayName?.trim();
    final hasName = name != null && name.isNotEmpty;
    final from = call.fromE164;
    final number = from == null ? InboundCopy.numberWithheld : stationPhone(from, masked: masked);
    return MergeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(
              hasName ? name : number,
              key: const Key('inbound-caller'),
              style: hasName || from == null
                  ? text.headlineLarge
                  : monoStyle(context, size: 26, weight: FontWeight.w500, color: context.tokens.textPrimary),
            ),
          ),
          const SizedBox(height: Space.xs),
          Text(
            hasName ? '$number · ${InboundCopy.inboundCall}' : InboundCopy.inboundCall,
            key: const Key('inbound-caller-line'),
            style: monoStyle(context, size: 14),
          ),
        ],
      ),
    );
  }
}

/// "Your customer", Do Not Call and the recording, as pills.
class InboundBadges extends StatelessWidget {
  const InboundBadges({super.key, required this.call});

  final InboundCallView call;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final sticky = call.sticky;
    return Wrap(
      spacing: Space.sm,
      runSpacing: Space.sm,
      children: [
        if (sticky != null)
          StatusPill(
            InboundCopy.sticky(sticky, isYou: call.stickyIsYou),
            key: const Key('inbound-sticky'),
            tone: call.stickyIsYou ? Tone.accent : Tone.neutral,
            leading: call.stickyIsYou ? Icon(Icons.star_outline, size: 14, color: Tone.accent.fg(t)) : null,
          ),
        if (call.callerDnc)
          StatusPill(
            InboundCopy.dncBadge,
            key: const Key('inbound-dnc-badge'),
            tone: Tone.danger,
            leading: Icon(Icons.block, size: 14, color: t.danger),
          ),
        call.recording
            ? StatusPill(
                InboundCopy.recorded,
                key: const Key('inbound-recording'),
                tone: Tone.danger,
                leading: Icon(Icons.fiber_manual_record, size: 12, color: t.danger),
              )
            : const StatusPill(InboundCopy.notRecorded, key: Key('inbound-recording')),
      ],
    );
  }
}

class _DncEnquiry extends StatelessWidget {
  const _DncEnquiry();

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return AppCard(
      key: const Key('inbound-dnc-enquiry'),
      color: t.warningSubtle,
      borderColor: t.warning.withValues(alpha: 0.35),
      child: Text(InboundCopy.dncEnquiry, style: Theme.of(context).textTheme.bodyMedium),
    );
  }
}

/// They rang, the route, how long they waited, the campaign they matched.
class InboundFacts extends StatelessWidget {
  const InboundFacts({super.key, required this.call});

  final InboundCallView call;

  @override
  Widget build(BuildContext context) {
    final campaign = call.campaignName;
    return AppCard(
      key: const Key('inbound-facts'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FieldRow(label: InboundCopy.theyRang, value: formatPhone(call.toE164), mono: true),
          const SizedBox(height: Space.sm),
          FieldRow(label: InboundCopy.route, value: call.routeName ?? '—'),
          const SizedBox(height: Space.sm),
          FieldRow(label: InboundCopy.beforeYou, value: InboundCopy.waited(call.waitedSeconds)),
          const SizedBox(height: Space.sm),
          FieldRow(
            label: InboundCopy.work,
            value: campaign == null ? InboundCopy.notInAnyWork : InboundCopy.matchLine(campaign, call.contactState),
          ),
        ],
      ),
    );
  }
}

/// The matched contact, read as the campaign pop reads its contact; or why there is none.
class InboundMatch extends StatelessWidget {
  const InboundMatch({super.key, required this.call, this.priorLimit});

  final InboundCallView call;
  final int? priorLimit;

  @override
  Widget build(BuildContext context) {
    if (!call.matched) {
      return Text(
        InboundCopy.noMatch(withheld: call.withheld),
        key: const Key('inbound-no-match'),
        style: Theme.of(context).textTheme.bodyMedium,
      );
    }
    return Column(
      key: const Key('inbound-match'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        HeroFieldsGrid(fields: call.heroFields, configured: call.heroesConfigured),
        if (call.priorAttempts.isNotEmpty) ...[
          const SizedBox(height: Space.lg),
          PriorAttemptsCard(attempts: call.priorAttempts, limit: priorLimit),
        ],
        if (call.otherFields.isNotEmpty) ...[
          const SizedBox(height: Space.md),
          MoreDetails(key: ValueKey(call.callId), fields: call.otherFields),
        ],
      ],
    );
  }
}

/// Inbound, "Your customer", the recording and DNC, mid-call.
class InboundSummary extends StatelessWidget {
  const InboundSummary({super.key, required this.call});

  final InboundCallView call;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final facts = call.heroFields.where((f) => f.value.trim().isNotEmpty).take(2);
    return Wrap(
      key: const Key('inbound-summary'),
      spacing: Space.sm,
      runSpacing: Space.sm,
      children: [
        StatusPill(InboundCopy.inboundCall, tone: Tone.accent, leading: Icon(Icons.call_received, size: 14, color: Tone.accent.fg(t))),
        if (call.sticky != null && call.stickyIsYou) StatusPill(InboundCopy.sticky(call.sticky!, isYou: true), tone: Tone.accent),
        if (call.recording)
          StatusPill(
            InboundCopy.recorded,
            key: const Key('recording'),
            tone: Tone.danger,
            leading: Icon(Icons.fiber_manual_record, size: 12, color: t.danger),
          ),
        if (call.callerDnc) const StatusPill(InboundCopy.dncBadge, tone: Tone.danger),
        for (final f in facts) StatusPill('${f.label} ${f.value}'),
      ],
    );
  }
}

class _InboundInterruption extends ConsumerWidget {
  const _InboundInterruption({required this.kind});

  final AudioInterruption kind;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final name = ref.watch(stationViewProvider.select((v) => v?.inbound?.displayName));
    return Column(
      key: const Key('interruption'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppCard(
          color: t.warningSubtle,
          borderColor: t.warning.withValues(alpha: 0.35),
          child: Text(kind == AudioInterruption.phoneCall ? StationCopy.phoneCallBody : StationCopy.otherAppBody, style: text.bodyMedium),
        ),
        const SizedBox(height: Space.md),
        FilledButton(
          key: const Key('unmute'),
          onPressed: () => ref.read(stationActionsProvider).setMuted(false),
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          child: Text(StationCopy.backTo(name), textAlign: TextAlign.center),
        ),
      ],
    );
  }
}

// ─── Controls ───────────────────────────────────────────────────────────────

/// Mute · Audio · Details · Don't call again: the campaign call's row, for the caller.
class InboundControlRow extends ConsumerWidget {
  const InboundControlRow({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final muted = ref.watch(stationViewProvider.select((v) => v?.audio.muted ?? false));
    final route = ref.watch(stationViewProvider.select((v) => v?.audio.route));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    final withheld = ref.watch(stationViewProvider.select((v) => v?.inbound?.withheld ?? true));
    final marked = ref.watch(stationViewProvider.select((v) => v?.dncOutcome != null));
    final t = context.tokens;
    final marking = busy == StationBusy.markingDnc;
    final tiles = [
      ControlTile(
        key: const Key('control-mute'),
        icon: muted ? Icons.mic_off : Icons.mic_none,
        label: muted ? StationCopy.muted : StationCopy.mute,
        semanticLabel: StationCopy.mute,
        toggled: muted,
        active: muted,
        onPressed: () => ref.read(stationActionsProvider).setMuted(!muted),
      ),
      ControlTile(
        key: const Key('control-audio'),
        icon: routeIcon(route?.kind),
        label: route?.name ?? StationCopy.audio,
        semanticLabel: '${StationCopy.audio}: ${route?.name ?? ''}',
        active: route?.kind == AudioRouteKind.bluetooth || route?.kind == AudioRouteKind.wired || route?.kind == AudioRouteKind.speaker,
        onPressed: () => showAudioRouteSheet(context),
      ),
      ControlTile(
        key: const Key('control-details'),
        icon: Icons.contact_page_outlined,
        label: StationCopy.details,
        onPressed: () {
          final call = ref.read(stationViewProvider)?.inbound;
          if (call != null) showInboundDetailsSheet(context, call);
        },
      ),
      ControlTile(
        key: const Key('control-dnc'),
        icon: Icons.block,
        label: marking ? StationCopy.markingDnc : (marked ? InboundCopy.dncBadge : StationCopy.dontCallAgain),
        semanticLabel: withheld ? '${StationCopy.dontCallAgain}: ${InboundCopy.dncWithheld}' : null,
        color: t.danger,
        onPressed: busy == StationBusy.none && !withheld && !marked ? () => markInboundDnc(context) : null,
      ),
    ];
    return LayoutBuilder(
      builder: (context, c) {
        final scale = MediaQuery.textScalerOf(context).scale(13) / 13;
        final perRow = scale > 1.4 ? 2 : 4;
        final w = ((c.maxWidth - Space.sm * (perRow - 1)) / perRow).floorToDouble();
        return Wrap(
          spacing: Space.sm,
          runSpacing: Space.md,
          children: [for (final tile in tiles) SizedBox(width: w, child: tile)],
        );
      },
    );
  }
}

class _DncOutcomeLine extends StatelessWidget {
  const _DncOutcomeLine({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Text(
        text,
        key: const Key('dnc-outcome'),
        style: Theme.of(context).textTheme.bodySmall!.copyWith(color: context.tokens.success),
      );
}

/// Slide to end call (AS3), offered only once the caller is connected: before that the panel is up
/// for the 1.5 s the agent has to read it, and a hang-up would end a customer's call unheard.
class InboundHangUpBar extends ConsumerWidget {
  const InboundHangUpBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final stage = ref.watch(stationViewProvider.select((v) => v?.inbound?.stage));
    final failure = ref.watch(stationViewProvider.select((v) => v?.inbound?.hangupFailure));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy == StationBusy.hangingUp));
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (stage == InboundStage.offered) ...[
          Text(InboundCopy.hangupConnecting, key: const Key('inbound-hangup-connecting'), style: text.bodySmall),
          const SizedBox(height: Space.sm),
        ],
        if (failure != null) ...[
          Semantics(
            liveRegion: true,
            child: Text(
              failure,
              key: const Key('inbound-hangup-failure'),
              style: text.bodySmall!.copyWith(color: t.danger),
            ),
          ),
          const SizedBox(height: Space.sm),
        ],
        LinkGate(
          child: SlideToConfirm(
            key: const Key('hang-up'),
            label: StationCopy.slideToEnd,
            busyLabel: StationCopy.ending,
            semanticLabel: StationCopy.endCall,
            semanticHint: StationCopy.endCallHint,
            enabled: stage == InboundStage.connected,
            busy: busy,
            onConfirmed: () => ref.read(stationActionsProvider).hangUp(),
            confirmAccessibly: (context) => confirmHangUp(context),
          ),
        ),
      ],
    );
  }
}

// ─── Dialogs and sheets ─────────────────────────────────────────────────────

/// Don't call again for the caller's number: the station's sheet, scoped to the call it was opened
/// on (it closes when that call leaves, and a "yes" after that marks nothing). The matched
/// campaign's list, else the account's.
Future<void> markInboundDnc(BuildContext context) async {
  final container = ProviderScope.containerOf(context, listen: false);
  final actions = container.read(stationActionsProvider);
  final messenger = ScaffoldMessenger.maybeOf(context);
  final view = container.read(stationViewProvider);
  final call = view?.inbound;
  final from = call?.fromE164;
  if (view == null || call == null || from == null) return;
  final scope = sameCall(call.callId, {AgentPhase.onCall, AgentPhase.wrapup});
  final who = InboundCopy.who(call, masked: view.maskPhone);
  final phone = stationPhone(from, masked: view.maskPhone);
  final ok = await confirmSheet(
    context,
    title: StationCopy.stopCallingTitle,
    detail: who == phone ? phone : '$who · $phone',
    message: InboundCopy.stopCallingBody(call.matched ? call.campaignName : null),
    confirm: StationCopy.yesStopCalls,
    cancel: StationCopy.noGoBack,
    scope: scope,
  );
  if (scope(container.read(stationViewProvider))) {
    if (ok) await actions.markDnc(attemptId: call.callId);
    return;
  }
  messenger?.showSnackBar(const SnackBar(key: Key('dnc-not-marked'), content: Text(InboundCopy.dncNotMarked)));
}

/// Everything about the caller: the contact's every field and history, and the call's facts.
/// About this call only: it closes when the call leaves the station.
Future<void> showInboundDetailsSheet(BuildContext context, InboundCallView call) {
  final view = ProviderScope.containerOf(context, listen: false).read(stationViewProvider);
  final scope = sameCall(call.callId, {if (view != null) view.phase});
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    builder: (context) => StationModalGuard(
      scope: scope,
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.75,
        minChildSize: 0.4,
        maxChildSize: 0.95,
        builder: (context, controller) {
          final text = Theme.of(context).textTheme;
          return ListView(
            key: const Key('inbound-details-sheet'),
            controller: controller,
            padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.xl),
            children: [
              Semantics(header: true, child: Text(InboundCopy.detailsTitle, style: text.titleLarge)),
              const SizedBox(height: Space.xs),
              Text(InboundCopy.who(call, masked: view?.maskPhone ?? false), style: text.bodySmall),
              const SizedBox(height: Space.md),
              InboundFacts(call: call),
              const SizedBox(height: Space.md),
              if (call.matched) ...[
                HeroFieldsGrid(fields: call.heroFields, configured: call.heroesConfigured),
                const SizedBox(height: Space.md),
                ContactFieldList(fields: call.otherFields, alwaysFilter: call.otherFields.length > 8),
                const SizedBox(height: Space.md),
                PriorAttemptsCard(attempts: call.priorAttempts),
              ] else
                Text(InboundCopy.noMatch(withheld: call.withheld), style: text.bodyMedium),
            ],
          );
        },
      ),
    ),
  );
}
