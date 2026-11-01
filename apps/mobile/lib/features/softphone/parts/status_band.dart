import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../../station/logic/format.dart';
import '../../station/station_providers.dart';
import '../../station/widgets/status_band.dart';
import '../../station/widgets/ticking.dart';
import '../softphone_copy.dart';

/// The soft phone's rail: Ready, Dialing, Ringing, On call, Outcome needed, or
/// what the connection is doing, in one tinted band pinned above the panel.
///
/// The core words it (`describeSoftphoneRail`); this picks the colour, the
/// timer and the one button a broken connection needs. It is the panel's
/// polite live region: a screen reader hears the rail change without being
/// interrupted (the assertive channel is the panel's announcer).
class SoftphoneStatusBand extends ConsumerWidget {
  const SoftphoneStatusBand({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(softphoneViewProvider.select((v) => (rail: v.rail, phase: v.phase, link: v.link, busy: v.sessionBusy)));
    final now = ref.watch(stationClockProvider);
    final t = context.tokens;
    final rail = s.rail;
    final (Color color, Color background) = switch (rail.tone) {
      SoftphoneRailTone.neutral => (t.textPrimary, t.bgTertiary),
      SoftphoneRailTone.info => (t.info, t.infoSubtle),
      SoftphoneRailTone.success => (t.success, t.successSubtle),
      SoftphoneRailTone.warning => (t.warning, t.warningSubtle),
      SoftphoneRailTone.danger => (t.danger, t.dangerSubtle),
    };
    // Ember is what the platform is doing: a ringing customer, a reconnect.
    final moving = s.phase == SoftphonePhase.ringing || s.phase == SoftphonePhase.dialing || s.link == StationLink.reconnecting;
    final from = rail.timerFrom;

    Widget? action;
    if (s.link == StationLink.disconnected) {
      action = FilledButton(
        key: const Key('softphone-reconnect'),
        onPressed: s.busy != SoftphoneSessionBusy.none ? null : () => ref.read(softphoneActionsProvider).reconnect(),
        style: FilledButton.styleFrom(backgroundColor: t.dangerDeep, foregroundColor: t.onAccent),
        child: const Text(SoftphoneCopy.reconnect),
      );
    } else if (s.link == StationLink.superseded) {
      action = FilledButton(
        key: const Key('softphone-use-this-phone'),
        onPressed: s.busy != SoftphoneSessionBusy.none ? null : () => ref.read(softphoneActionsProvider).useThisDevice(),
        child: const Text(SoftphoneCopy.useThisPhone),
      );
    }

    return Semantics(
      key: const Key('softphone-rail'),
      container: true,
      liveRegion: true,
      child: StatusBand(
        title: rail.label,
        subtitle: rail.detail,
        color: moving ? t.ember : color,
        background: moving ? t.emberSubtle : background,
        leading: moving ? const LiveDot(size: 10) : null,
        trailing: from == null ? null : _RailTimer(since: from, now: now, color: moving ? t.ember : color),
        bottom: action == null ? null : Align(alignment: AlignmentDirectional.centerStart, child: action),
      ),
    );
  }
}

/// The rail's timer, as its own leaf so only these digits repaint each second.
/// Kept out of the semantics tree: it sits inside the live region, which would
/// otherwise announce it every second.
class _RailTimer extends StatelessWidget {
  const _RailTimer({required this.since, required this.now, required this.color});

  final DateTime since;
  final DateTime Function() now;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: TickingBuilder(
        now: now,
        anchor: since,
        builder: (context, at) {
          final clock = formatClock(at.difference(since));
          return ExcludeSemantics(
            child: Text(
              clock,
              key: const Key('softphone-timer'),
              style: monoStyle(context, size: 20, color: color),
            ),
          );
        },
      ),
    );
  }
}
