import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../station_copy.dart';
import '../widgets/action_buttons.dart';
import 'banners.dart';
import 'call_band.dart';
import 'hang_up.dart';
import 'layouts.dart';
import 'more_details_card.dart';
import 'notes_field.dart';
import 'ringing_view.dart' show CustomerCard, LastCallsCard;
import 'script_cards.dart' show ScriptStepsCard;
import 'sheets.dart';

/// On call (04, AS2: no AI anywhere): the customer card, then the script when the campaign has one,
/// else (04c) Last calls; the note,
/// and the controls in thumb reach: Mute and Speaker side by side, Slide to end call under them.
/// No break button (AS10: Save & take break on the next screen). A customer's hang-up moves the screen on by itself.
class OnCallView extends ConsumerWidget {
  const OnCallView({super.key, required this.notes});

  final TextEditingController notes;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final interrupted = ref.watch(stationViewProvider.select((v) => v?.audio.interruption ?? AudioInterruption.none));
    final call = ref.watch(stationViewProvider.select((v) => v?.call));
    final muted = ref.watch(stationViewProvider.select((v) => v?.audio.muted ?? false));
    final lineDown = ref.watch(stationViewProvider.select((v) => v != null && v.link != StationLink.open));
    final hasScript = ref.watch(stationViewProvider.select((v) => (v?.script?.steps ?? const <String>[]).isNotEmpty));
    final tight = MediaQuery.textScalerOf(context).scale(16) / 16 > 1.3;
    return CallPage(
      revealOnPush: true,
      body: [
        if (lineDown) const CallProblemSteps(),
        if (interrupted != AudioInterruption.none) ...[_InterruptionCard(kind: interrupted), const SizedBox(height: Space.md)],
        if (muted && interrupted == AudioInterruption.none) const _MutedBanner(),
        if (call != null) CustomerCard(call: call),
        const SizedBox(height: Space.md),
        // AS2: the script (BE-8) when the campaign has one; else 04c's Last calls and the note. No
        // read aloud here: the customer is on the line, and the phone's speaker can reach them
        // through the microphone (AS13).
        if (call != null && hasScript) ScriptStepsCard(callId: call.attemptId),
        if (call != null && !hasScript && call.priorAttempts.isNotEmpty) LastCallsCard(attempts: call.priorAttempts),
        const SizedBox(height: Space.md),
        StationNotesField(controller: notes),
        const SizedBox(height: Space.md),
        const QueuedBreakChip(offer: false),
        const DontCallAgainRow(),
        // At large text Mute and Speaker scroll with the content, so End call keeps its place; they
        // come before More details, which grows as the agent scrolls and must never push them away.
        if (tight) ...[const SizedBox(height: Space.md), const LinkGate(child: ControlRow())],
        // AS20: the customer's other columns, at the bottom, opened as the agent scrolls down.
        if (call != null) MoreDetailsCard(call: call),
      ],
      actions: tight
          ? const HangUpBar()
          : const Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                LinkGate(child: ControlRow()),
                SizedBox(height: Space.sm),
                HangUpBar(),
              ],
            ),
    );
  }
}

/// Don't call again (design-spec §6.2): when this campaign's outcomes have no "don't call again"
/// tile, a red row offers it on the call and on What happened? (the server marks an attempt after
/// it ended too), with the same confirm; once done, the line that says so. With such a tile, the
/// tile is the way. Not once the outcome is saved.
class DontCallAgainRow extends ConsumerWidget {
  const DontCallAgainRow({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasTile = ref.watch(stationViewProvider.select((v) => (v?.dispositions ?? const <DispositionOption>[]).any((d) => d.suppresses)));
    final marking = ref.watch(stationViewProvider.select((v) => v?.busy == StationBusy.markingDnc));
    final dnc = ref.watch(stationViewProvider.select((v) => v?.dncOutcome));
    final saved = ref.watch(stationViewProvider.select((v) => v?.dispositionSaved != null));
    if (hasTile || saved) return const SizedBox.shrink();
    final red = context.stateTokens.problem.deep;
    return Padding(
      padding: const EdgeInsets.only(top: Space.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (dnc != null)
            Text(dnc, key: const Key('dnc-outcome'), style: Theme.of(context).textTheme.bodySmall)
          else
            LinkGate(
              child: TextButton.icon(
                key: const Key('control-dnc'),
                style: TextButton.styleFrom(foregroundColor: red, minimumSize: const Size.fromHeight(48)),
                onPressed: marking ? null : () => markDnc(context),
                icon: const Icon(Icons.block),
                label: Text(marking ? StationCopy.markingDnc : StationCopy.dontCallAgain),
              ),
            ),
        ],
      ),
    );
  }
}

/// "You are on mute. The customer cannot hear you." (04b), amber.
class _MutedBanner extends StatelessWidget {
  const _MutedBanner();

  @override
  Widget build(BuildContext context) {
    final c = context.stateTokens.onBreak;
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.md),
      child: Semantics(
        liveRegion: true,
        container: true,
        child: DecoratedBox(
          key: const Key('muted-banner'),
          decoration: BoxDecoration(color: c.band, borderRadius: BorderRadius.circular(Radii.md)),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.sm),
            child: Row(
              children: [
                Icon(Icons.mic_off, color: c.ink),
                const SizedBox(width: Space.sm),
                Expanded(child: Text(StationCopy.onMute, style: Theme.of(context).textTheme.titleSmall!.copyWith(color: c.ink))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Call problem (10): the customer card stays; under the band, what to do while the call is kept.
/// "Try again now" once the retries gave up.
class CallProblemSteps extends ConsumerWidget {
  const CallProblemSteps({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final link = ref.watch(stationViewProvider.select((v) => v?.link));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy != StationBusy.none));
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const StepsCard(
            key: Key('call-problem-steps'),
            title: StationCopy.whatToDo,
            tone: StationTone.problem,
            steps: [StationCopy.stepDoNotClose, StationCopy.stepSaySorry, StationCopy.stepCallAgain],
          ),
          if (link == StationLink.disconnected) ...[
            const SizedBox(height: Space.sm),
            MainActionButton(
              key: const Key('reconnect'),
              label: StationCopy.tryAgainNow,
              icon: Icons.refresh,
              kind: ActionKind.stop,
              onPressed: busy ? null : () => ref.read(stationActionsProvider).reconnect(),
            ),
          ],
        ],
      ),
    );
  }
}

/// The phone took the audio: say why the customer cannot hear them, and the
/// one action that fixes it.
class _InterruptionCard extends ConsumerWidget {
  const _InterruptionCard({required this.kind});

  final AudioInterruption kind;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // The name the card heads with (AS19 S12: with chosen facts the server's, never the guess).
    final name = ref.watch(stationViewProvider.select((v) => v?.call?.customerName));
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
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
        MainActionButton(
          key: const Key('unmute'),
          label: StationCopy.backTo(name),
          icon: Icons.mic,
          onPressed: () => ref.read(stationActionsProvider).setMuted(false),
        ),
      ],
    );
  }
}

/// Mute and Speaker, side by side, 52 dp. Mute turns amber and reads Unmute while on.
class ControlRow extends ConsumerWidget {
  const ControlRow({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final muted = ref.watch(stationViewProvider.select((v) => v?.audio.muted ?? false));
    final route = ref.watch(stationViewProvider.select((v) => v?.audio.route));
    final away = route != null && route.kind != AudioRouteKind.earpiece;
    return ButtonPair(
      first: SecondaryActionButton(
        key: const Key('control-mute'),
        label: muted ? StationCopy.unmute : StationCopy.mute,
        icon: muted ? Icons.mic_off : Icons.mic_none,
        active: muted,
        toggled: muted,
        onPressed: () => ref.read(stationActionsProvider).setMuted(!muted),
      ),
      second: SecondaryActionButton(
        key: const Key('control-audio'),
        label: away ? route.name : StationCopy.speaker,
        icon: routeIcon(route?.kind == AudioRouteKind.earpiece ? AudioRouteKind.speaker : route?.kind ?? AudioRouteKind.speaker),
        semanticsLabel: '${StationCopy.speaker}: ${route?.name ?? ''}',
        onPressed: () => showAudioRouteSheet(context),
      ),
    );
  }
}

/// A round control with its label underneath, 56 dp across.
class ControlTile extends StatelessWidget {
  const ControlTile({
    super.key,
    required this.icon,
    required this.label,
    required this.onPressed,
    this.semanticLabel,
    this.toggled,
    this.active = false,
    this.color,
  });

  final IconData icon;
  final String label;
  final String? semanticLabel;
  final VoidCallback? onPressed;
  final bool? toggled;
  final bool active;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final fg = onPressed == null ? t.textMuted : (color ?? (active ? t.accentHover : t.textPrimary));
    final bg = active ? t.accentSubtle : t.bgTertiary;
    return Semantics(
      button: true,
      enabled: onPressed != null,
      toggled: toggled,
      label: semanticLabel ?? label,
      excludeSemantics: true,
      onTap: onPressed,
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(Radii.md),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: Space.xs),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DecoratedBox(
                decoration: BoxDecoration(
                  color: bg,
                  shape: BoxShape.circle,
                  border: Border.all(color: color != null ? color!.withValues(alpha: 0.4) : t.border),
                ),
                child: SizedBox.square(dimension: 56, child: Icon(icon, color: fg)),
              ),
              const SizedBox(height: Space.xs),
              Text(
                label,
                textAlign: TextAlign.center,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: text.labelMedium!.copyWith(color: fg),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// "☕ Break after this call", or the queued break with its ✕. The ✕ sends a
/// real cancel: the pill is a warning that the agent is about to leave the
/// pool, not a receipt to dismiss.
///
/// With [offer] false (wrap-up) only a queued break shows: one picked on the
/// call, or in its sheet after the call ended, stays visible and cancellable
/// until it starts.
///
/// A queued switch to the soft phone (the `soft_phone` break, SP7) is the same
/// queue and reads "Switching after this call"; its ✕ withdraws the switch.
class QueuedBreakChip extends ConsumerWidget {
  const QueuedBreakChip({super.key, this.offer = true});

  final bool offer;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final queued = ref.watch(stationViewProvider.select((v) => v?.queuedBreak));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    if (queued == null) {
      if (!offer) return const SizedBox.shrink();
      return Align(
        alignment: AlignmentDirectional.centerStart,
        child: ActionChip(
          key: const Key('break-after-call'),
          avatar: Icon(Icons.free_breakfast_outlined, size: 18, color: t.textSecondary),
          label: BusyLabel(label: StationCopy.breakAfterCall, busy: busy == StationBusy.takingBreak),
          onPressed: busy == StationBusy.none ? () => showBreakSheet(context, queued: true) : null,
        ),
      );
    }
    final cancelling = busy == StationBusy.cancellingBreak;
    final toSoftphone = queued.code == switchToSoftphoneChoice;
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: DecoratedBox(
        key: const Key('queued-break'),
        decoration: BoxDecoration(color: t.warningSubtle, borderRadius: BorderRadius.circular(Radii.pill)),
        child: Padding(
          padding: const EdgeInsetsDirectional.only(start: Space.md),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(toSoftphone ? Icons.dialpad : Icons.free_breakfast_outlined, size: 18, color: t.warning),
              const SizedBox(width: Space.sm),
              Flexible(
                child: Text(
                  toSoftphone ? StationCopy.switchQueued : StationCopy.breakAfterThisCall(queued.label),
                  style: text.labelMedium!.copyWith(color: t.warning),
                ),
              ),
              IconButton(
                key: const Key('cancel-queued-break'),
                tooltip: toSoftphone ? StationCopy.cancelSwitch : StationCopy.cancelQueuedBreak,
                onPressed: cancelling
                    ? null
                    : toSoftphone
                        ? () => cancelSoftphoneSwitch(context)
                        : () => ref.read(stationActionsProvider).cancelQueuedBreak(),
                icon: cancelling
                    ? SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2, color: t.warning))
                    : Icon(Icons.close, color: t.warning),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
