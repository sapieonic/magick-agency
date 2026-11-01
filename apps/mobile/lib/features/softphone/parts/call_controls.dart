import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../../../core/station/station_view.dart';
import '../../station/parts/on_call_view.dart' show ControlTile;
import '../../station/parts/sheets.dart' show routeIcon;
import '../../station/widgets/hold_to_confirm.dart';
import '../softphone_copy.dart';
import 'dnc_sheet.dart';
import 'modal_guard.dart';

/// Mute · Audio · Mark DNC, the station's control tiles on the soft phone.
///
/// Mute acts on what is sounding: while the customer's phone rings it silences
/// the ringback only ("Mute ring"; the microphone is not muted), otherwise it is
/// the microphone. Separate, so an agent who quietened the ring is not muted
/// when the customer answers.
class SoftphoneControlRow extends ConsumerWidget {
  const SoftphoneControlRow({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(
      softphoneViewProvider.select(
        (v) => (
          target: v.muteTarget,
          muted: v.muted,
          muteEnabled: v.muteEnabled,
          route: v.audio.route,
          live: v.callLive,
          dncEnabled: v.dncEnabled,
          dncInFlight: v.dncInFlight,
          dncDone: v.dncOutcome != null,
        ),
      ),
    );
    final t = context.tokens;
    final actions = ref.read(softphoneActionsProvider);
    final ring = s.target == SoftphoneMuteTarget.ring;
    final route = s.route;

    final tiles = [
      ControlTile(
        key: const Key('softphone-mute'),
        icon: ring
            ? (s.muted ? Icons.notifications_off_outlined : Icons.notifications_active_outlined)
            : (s.muted ? Icons.mic_off : Icons.mic_none),
        label: ring ? (s.muted ? SoftphoneCopy.ringMuted : SoftphoneCopy.muteRing) : (s.muted ? SoftphoneCopy.muted : SoftphoneCopy.mute),
        semanticLabel: ring ? SoftphoneCopy.muteRing : SoftphoneCopy.mute,
        toggled: s.muted,
        active: s.muted,
        onPressed: s.muteEnabled ? actions.toggleMute : null,
      ),
      ControlTile(
        key: const Key('softphone-audio'),
        icon: routeIcon(route?.kind),
        label: route?.name ?? SoftphoneCopy.audio,
        semanticLabel: '${SoftphoneCopy.audio}: ${route?.name ?? ''}',
        active: route?.kind == AudioRouteKind.bluetooth || route?.kind == AudioRouteKind.wired || route?.kind == AudioRouteKind.speaker,
        onPressed: s.live ? () => showSoftphoneAudioSheet(context) : null,
      ),
      ControlTile(
        key: const Key('softphone-dnc'),
        icon: Icons.block,
        label: s.dncInFlight ? SoftphoneCopy.markingDnc : (s.dncDone ? SoftphoneCopy.onDnc : SoftphoneCopy.markDnc),
        color: t.danger,
        onPressed: s.dncEnabled && !s.dncInFlight && !s.dncDone ? () => showDncSheet(context) : null,
      ),
    ];

    return LayoutBuilder(
      builder: (context, c) {
        // Three across; two once large text would crush the labels.
        final scale = MediaQuery.textScalerOf(context).scale(13) / 13;
        final perRow = scale > 1.4 ? 2 : 3;
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

/// What Mark DNC recorded, or why it did not: beside the controls, never a toast.
class DncResultLine extends ConsumerWidget {
  const DncResultLine({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(softphoneViewProvider.select((v) => (done: v.dncOutcome, failure: v.dncFailure)));
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    if (s.done == null && s.failure == null) return const SizedBox.shrink();
    return Semantics(
      liveRegion: true,
      container: true,
      child: Padding(
        padding: const EdgeInsets.only(top: Space.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (s.done case final done?)
              Text(
                done,
                key: const Key('dnc-outcome'),
                style: text.bodySmall!.copyWith(color: t.success),
              ),
            if (s.failure case final failure?)
              Text(
                failure,
                key: const Key('dnc-failure'),
                style: text.bodySmall!.copyWith(color: t.danger),
              ),
          ],
        ),
      ),
    );
  }
}

/// Where the call is heard: phone, speaker, a headset. Closes with the call.
Future<void> showSoftphoneAudioSheet(BuildContext context) async {
  final container = ProviderScope.containerOf(context, listen: false);
  final actions = container.read(softphoneActionsProvider);
  final view = container.read(softphoneViewProvider);
  final audio = view.audio;
  final scope = sameSoftphoneCall(view.callId);
  final picked = await showModalBottomSheet<AudioRouteOption>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    builder: (context) {
      final text = Theme.of(context).textTheme;
      final t = context.tokens;
      return SoftphoneModalGuard(
        scope: scope,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(header: true, child: Text(SoftphoneCopy.audioSheetTitle, style: text.titleLarge)),
              const SizedBox(height: Space.sm),
              if (audio.routes.isEmpty) Text(SoftphoneCopy.noRoutes, style: text.bodyMedium),
              for (final r in audio.routes)
                ListTile(
                  key: Key('route-${r.id}'),
                  minTileHeight: Space.touch + 8,
                  leading: Icon(routeIcon(r.kind)),
                  title: Text(r.name),
                  selected: r == audio.route,
                  selectedColor: t.accentHover,
                  trailing: r == audio.route ? const Icon(Icons.check) : null,
                  onTap: () => Navigator.of(context).pop(r),
                ),
            ],
          ),
        ),
      );
    },
  );
  if (picked != null && picked != audio.route && scope(container.read(softphoneViewProvider))) await actions.setRoute(picked);
}

/// Hold-to-hang-up, the station's gesture unchanged: 500 ms, firing with the
/// finger still down, a dialog for a screen reader. While the customer's
/// phone rings the SP3 warning sits above it: the carrier cannot stop a ringing
/// call, so hanging up then leaves the customer's phone ringing for a while.
class SoftphoneHangUp extends ConsumerWidget {
  const SoftphoneHangUp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(
      softphoneViewProvider.select(
        (v) => (ringing: v.phase == SoftphonePhase.ringing, can: v.canHangUp, busy: v.hangingUp, failure: v.hangupFailure),
      ),
    );
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (s.ringing) ...[
          Text(
            SoftphoneCopy.ringingHangupWarning,
            key: const Key('ringing-warning'),
            style: text.bodySmall!.copyWith(color: t.warning),
          ),
          const SizedBox(height: Space.sm),
        ],
        if (s.failure case final failure?) ...[
          Semantics(
            liveRegion: true,
            child: Text(
              failure,
              key: const Key('hangup-failure'),
              style: text.bodySmall!.copyWith(color: t.danger),
            ),
          ),
          const SizedBox(height: Space.sm),
        ],
        HoldToConfirmBar(
          key: const Key('softphone-hang-up'),
          label: SoftphoneCopy.holdToHangUp,
          holdingLabel: SoftphoneCopy.keepHolding,
          busyLabel: SoftphoneCopy.endingCall,
          semanticLabel: SoftphoneCopy.hangUp,
          semanticHint: SoftphoneCopy.hangUpHint,
          enabled: s.can,
          busy: s.busy,
          onConfirmed: () => ref.read(softphoneActionsProvider).hangUp(),
          confirmAccessibly: (context) => _confirmHangUp(context, ringing: s.ringing),
        ),
      ],
    );
  }
}

/// The screen-reader path of hold-to-hang-up. Closes with the call it asked about.
Future<bool> _confirmHangUp(BuildContext context, {required bool ringing}) {
  final view = ProviderScope.containerOf(context, listen: false).read(softphoneViewProvider);
  return softphoneConfirm(
    context,
    title: SoftphoneCopy.hangUpConfirmTitle,
    message: ringing ? SoftphoneCopy.ringingHangupWarning : SoftphoneCopy.hangUpConfirmBody,
    confirm: SoftphoneCopy.hangUp,
    cancel: SoftphoneCopy.keepCall,
    danger: true,
    scope: sameSoftphoneCall(view.callId),
  );
}
