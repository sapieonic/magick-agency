import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../logic/format.dart';
import '../logic/wrapup_math.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import '../widgets/countdown_ring.dart';
import '../widgets/drain_bar.dart';
import '../widgets/status_band.dart';
import '../widgets/ticking.dart';

/// How long the server holds a live call while the socket comes back. Only
/// the ring's scale: the digits count to the core's real deadline.
const _reconnectWindow = Duration(seconds: 8);

/// The band at the top of a call screen.
///
/// One band, and its priority is the console rail's: a connection problem
/// outranks the call's own state (an agent whose socket is gone must not be
/// told they are "On call" and nothing else), and a phone-call interruption
/// outranks the talk timer (the customer cannot hear them).
class CallBand extends ConsumerWidget {
  const CallBand({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(
      stationViewProvider.select(
        (v) => (
          phase: v?.phase,
          link: v?.link,
          interruption: v?.audio.interruption ?? AudioInterruption.none,
          name: v?.call?.displayName,
          phone: v?.call?.phoneE164,
          countdown: v?.call?.countdownSeconds,
          bridgedAt: v?.call?.bridgedAt,
          deadline: v?.reconnectDeadline,
          release: v?.release,
          wrapup: v?.wrapup,
          busy: v?.busy ?? StationBusy.none,
        ),
      ),
    );
    final t = context.tokens;
    final now = ref.watch(stationClockProvider);
    final liveCall = s.phase == AgentPhase.reserved || s.phase == AgentPhase.onCall;

    if (s.link == StationLink.reconnecting) {
      final deadline = s.deadline;
      return StatusBand(
        key: const Key('band-reconnecting'),
        title: StationCopy.reconnecting,
        subtitle: liveCall ? StationCopy.reconnectingMidCall : StationCopy.reconnectingIdle,
        color: t.ember,
        background: t.emberSubtle,
        leading: const LiveDot(),
        trailing: liveCall && deadline != null
            ? TickingBuilder(
                now: now,
                anchor: deadline,
                builder: (context, at) {
                  final left = secondsLeft(deadline, at);
                  final ms = deadline.difference(at).inMilliseconds;
                  return CountdownRing(
                    key: const Key('reconnect-ring'),
                    value: left,
                    fraction: ms / _reconnectWindow.inMilliseconds,
                    color: t.ember,
                    semanticsLabel: '$left seconds to reconnect',
                  );
                },
              )
            : null,
      );
    }

    if (s.link == StationLink.disconnected) {
      return StatusBand(
        key: const Key('band-disconnected'),
        title: liveCall ? StationCopy.connectionLost : StationCopy.disconnected,
        subtitle: liveCall ? StationCopy.connectionLostDetail : StationCopy.disconnectedDetail,
        color: t.danger,
        background: t.dangerSubtle,
        leading: Icon(Icons.wifi_off, color: t.danger),
        bottom: Align(
          alignment: AlignmentDirectional.centerStart,
          child: FilledButton(
            onPressed: s.busy != StationBusy.none ? null : () => ref.read(stationActionsProvider).reconnect(),
            style: FilledButton.styleFrom(backgroundColor: t.danger, foregroundColor: t.onAccent),
            child: const Text(StationCopy.reconnect),
          ),
        ),
      );
    }

    if (s.phase == AgentPhase.onCall && s.interruption != AudioInterruption.none) {
      final phone = s.interruption == AudioInterruption.phoneCall;
      return StatusBand(
        key: const Key('band-interrupted'),
        title: phone ? StationCopy.phoneCallTitle : StationCopy.otherAppTitle,
        subtitle: StationCopy.phoneCallSubtitle,
        color: t.warning,
        background: t.warningSubtle,
        leading: Icon(phone ? Icons.phone_callback : Icons.music_off, color: t.warning),
      );
    }

    switch (s.phase) {
      case AgentPhase.reserved:
        final n = s.countdown;
        return StatusBand(
          key: const Key('band-ringing'),
          title: StationCopy.ringing,
          subtitle: n != null ? StationCopy.beingDialled : StationCopy.connectingCustomer,
          color: t.ember,
          background: t.emberSubtle,
          leading: const LiveDot(size: 10),
          trailing: n == null ? null : _DialCountdown(value: n),
        );
      case AgentPhase.onCall:
        final who = [if (s.name != null && s.name!.trim().isNotEmpty) s.name!, if (s.phone != null) formatPhone(s.phone!)].join(' · ');
        final bridged = s.bridgedAt;
        return StatusBand(
          key: const Key('band-on-call'),
          title: StationCopy.onCall,
          subtitle: who,
          color: t.success,
          background: t.successSubtle,
          trailing: bridged == null ? null : TalkTimer(since: bridged, now: now),
        );
      case AgentPhase.wrapup:
        return _WrapupBand(release: s.release, wrapup: s.wrapup, now: now);
      default:
        return const SizedBox.shrink();
    }
  }
}

/// The talk timer, as its own leaf so only these digits repaint each second.
class TalkTimer extends StatelessWidget {
  const TalkTimer({super.key, required this.since, required this.now, this.size = 22});

  final DateTime since;
  final DateTime Function() now;
  final double size;

  @override
  Widget build(BuildContext context) {
    final color = context.tokens.success;
    return RepaintBoundary(
      child: TickingBuilder(
        now: now,
        anchor: since,
        builder: (context, at) {
          final clock = formatClock(at.difference(since));
          return Semantics(
            label: 'Talk time $clock',
            excludeSemantics: true,
            child: Text(
              clock,
              key: const Key('talk-timer'),
              style: monoStyle(context, size: size, color: color),
            ),
          );
        },
      ),
    );
  }
}

/// "3, 2, 1" before an early-bound dial connects. Remembers the first value it
/// saw as the ring's full scale, since the frame carries only the remainder.
class _DialCountdown extends StatefulWidget {
  const _DialCountdown({required this.value});

  final int value;

  @override
  State<_DialCountdown> createState() => _DialCountdownState();
}

class _DialCountdownState extends State<_DialCountdown> {
  late int _total = widget.value < 1 ? 1 : widget.value;

  @override
  void didUpdateWidget(_DialCountdown old) {
    super.didUpdateWidget(old);
    if (widget.value > _total) _total = widget.value;
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.value < 0 ? 0 : widget.value;
    return CountdownRing(
      key: const Key('dial-countdown'),
      value: v,
      fraction: v / _total,
      color: context.tokens.ember,
      semanticsLabel: 'Connecting in $v',
    );
  }
}

class _WrapupBand extends StatelessWidget {
  const _WrapupBand({required this.release, required this.wrapup, required this.now});

  final ReleaseView? release;
  final WrapupView? wrapup;
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final w = wrapup;
    final title = release?.headline ?? StationCopy.wrapup;
    final subtitle = release?.detail;
    if (w == null) {
      // Wrap-up with no frame yet: the words, no clock and no spinner.
      return StatusBand(key: const Key('band-wrapup'), title: title, subtitle: subtitle, color: t.warning, background: t.warningSubtle);
    }
    final requires = release?.requiresDisposition ?? true;
    Widget band(DateTime at) {
      final clock = wrapupClock(w, at, requiresDisposition: requires);
      final still = MediaQuery.disableAnimationsOf(context);
      // The bar eases toward where it will be at the next tick, so it reaches
      // empty with the digits rather than a second behind them.
      final barFraction = still
          ? clock.fraction
          : wrapupClock(w, at.add(const Duration(seconds: 1)), requiresDisposition: requires).fraction;
      final text = Theme.of(context).textTheme;
      return StatusBand(
        key: const Key('band-wrapup'),
        title: title,
        subtitle: subtitle,
        color: t.warning,
        background: t.warningSubtle,
        trailing: clock.secondsLeft == null && !clock.holding
            ? null
            : ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 150),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (clock.secondsLeft != null)
                      Semantics(
                        label: '${clock.secondsLeft} seconds of wrap-up left',
                        excludeSemantics: true,
                        child: Text(
                          formatClock(Duration(seconds: clock.secondsLeft!), padMinutes: false),
                          key: const Key('wrapup-digits'),
                          style: monoStyle(context, size: 18, color: t.warning),
                        ),
                      ),
                    // Says who the window waits on instead of counting past zero:
                    // an overrun readout is a stopwatch pointed at the agent.
                    if (clock.holding)
                      Text(
                        clock.supervisorHold ? StationCopy.heldBySupervisor : StationCopy.waitingOnDisposition,
                        key: const Key('wrapup-held'),
                        textAlign: TextAlign.end,
                        style: text.labelMedium!.copyWith(color: t.warning),
                      ),
                  ],
                ),
              ),
        bottom: barFraction == null
            ? null
            : DrainBar(
                key: const Key('wrapup-bar'),
                fraction: barFraction,
                color: t.warning,
                trackColor: t.warning.withValues(alpha: 0.18),
              ),
      );
    }

    final endsAt = w.endsAt;
    if (endsAt == null) return band(now());
    return RepaintBoundary(
      child: TickingBuilder(now: now, anchor: endsAt, builder: (context, at) => band(at)),
    );
  }
}
