import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import '../widgets/ticking.dart';
import 'banners.dart';
import 'hang_up.dart';
import 'layouts.dart';
import 'notes_field.dart';
import 'ringing_view.dart';
import 'sheets.dart';

/// On a call: notes, the four controls, the queued break and hang-up.
class OnCallView extends ConsumerWidget {
  const OnCallView({super.key, required this.notes});

  final TextEditingController notes;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final interrupted = ref.watch(stationViewProvider.select((v) => v?.audio.interruption ?? AudioInterruption.none));
    return CallLayout(
      body: [
        if (interrupted != AudioInterruption.none) _InterruptionCard(kind: interrupted) else const _CallSummary(),
        const SizedBox(height: Space.lg),
        StationNotesField(controller: notes),
        const SizedBox(height: Space.lg),
        const LinkGate(child: ControlRow()),
        const SizedBox(height: Space.md),
        const LinkGate(child: QueuedBreakChip()),
      ],
      bottom: const HangUpBar(ringing: false),
    );
  }
}

/// Recording, and the two hero facts the agent most needs mid-sentence.
class _CallSummary extends ConsumerWidget {
  const _CallSummary();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final recording = ref.watch(stationViewProvider.select((v) => v?.call?.recording ?? false));
    // Selected as one string so a new-but-equal list from the core is not a rebuild.
    final summary = ref.watch(
      stationViewProvider.select(
        (v) => (v?.call?.heroFields ?? const <ContactField>[])
            .where((f) => f.value.trim().isNotEmpty)
            .take(2)
            .map((f) => '${f.label} ${f.value}')
            .join('\n'),
      ),
    );
    final t = context.tokens;
    final facts = summary.isEmpty ? const <String>[] : summary.split('\n');
    if (!recording && facts.isEmpty) return const SizedBox.shrink();
    return Wrap(
      spacing: Space.sm,
      runSpacing: Space.sm,
      children: [
        if (recording)
          StatusPill(
            StationCopy.recording,
            key: const Key('recording'),
            tone: Tone.danger,
            leading: Icon(Icons.fiber_manual_record, size: 12, color: t.danger),
          ),
        for (final f in facts) StatusPill(f),
      ],
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
    final call = ref.watch(stationViewProvider.select((v) => v?.call));
    final now = ref.watch(stationClockProvider);
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final bridged = call?.bridgedAt;
    return Column(
      key: const Key('interruption'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (call != null)
          CallHeadline(
            call: call,
            subtitle: bridged == null
                ? null
                : TickingBuilder(
                    now: now,
                    anchor: bridged,
                    builder: (context, at) => Text(StationCopy.onCallMuted(formatClock(at.difference(bridged))), style: text.bodySmall),
                  ),
          ),
        const SizedBox(height: Space.md),
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
          child: Text(StationCopy.backTo(call?.displayName), textAlign: TextAlign.center),
        ),
      ],
    );
  }
}

/// Mute · Audio · Details · Mark DNC.
class ControlRow extends ConsumerWidget {
  const ControlRow({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final muted = ref.watch(stationViewProvider.select((v) => v?.audio.muted ?? false));
    final route = ref.watch(stationViewProvider.select((v) => v?.audio.route));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
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
        onPressed: () => showAudioRouteSheet(context, ref),
      ),
      ControlTile(
        key: const Key('control-details'),
        icon: Icons.contact_page_outlined,
        label: StationCopy.details,
        onPressed: () {
          final call = ref.read(stationViewProvider)?.call;
          if (call != null) showDetailsSheet(context, call);
        },
      ),
      ControlTile(
        key: const Key('control-dnc'),
        icon: Icons.block,
        label: marking ? StationCopy.markingDnc : StationCopy.markDnc,
        color: t.danger,
        onPressed: busy == StationBusy.none ? () => markDnc(context, ref) : null,
      ),
    ];

    return LayoutBuilder(
      builder: (context, c) {
        // Four across; two across once large text would crush the labels.
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
class QueuedBreakChip extends ConsumerWidget {
  const QueuedBreakChip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final queued = ref.watch(stationViewProvider.select((v) => v?.queuedBreak));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    if (queued == null) {
      return Align(
        alignment: AlignmentDirectional.centerStart,
        child: ActionChip(
          key: const Key('break-after-call'),
          avatar: Icon(Icons.free_breakfast_outlined, size: 18, color: t.textSecondary),
          label: BusyLabel(label: StationCopy.breakAfterCall, busy: busy == StationBusy.takingBreak),
          onPressed: busy == StationBusy.none ? () => showBreakSheet(context, ref, queued: true) : null,
        ),
      );
    }
    final cancelling = busy == StationBusy.cancellingBreak;
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
              Icon(Icons.free_breakfast_outlined, size: 18, color: t.warning),
              const SizedBox(width: Space.sm),
              Flexible(
                child: Text(StationCopy.breakQueued(queued.label), style: text.labelMedium!.copyWith(color: t.warning)),
              ),
              IconButton(
                key: const Key('cancel-queued-break'),
                tooltip: StationCopy.cancelQueuedBreak,
                onPressed: cancelling ? null : () => ref.read(stationActionsProvider).cancelQueuedBreak(),
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
