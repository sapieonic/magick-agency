import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../logic/format.dart';
import '../logic/wrapup_math.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import '../widgets/state_band.dart';
import '../widgets/ticking.dart';
import 'layouts.dart';

/// A call screen: [StationPage] with the call's band ([CallStateBand]).
class CallPage extends StatelessWidget {
  const CallPage({super.key, required this.body, this.actions});

  final List<Widget> body;
  final Widget? actions;

  @override
  Widget build(BuildContext context) => StationPage(band: const CallStateBand(), body: body, actions: actions, onCall: true);
}

/// The band of a call screen (design-spec §2): Call coming (blue), On call (deep blue, the talk
/// timer and "Recorded"), What happened? (purple, the time left), and, outranking the call's own
/// state, a line that dropped (red: Call problem, "Call is kept for 0:12") and the phone taking the
/// audio (red: the customer cannot hear you). An agent whose line is gone must not be told they are
/// "On call" and nothing else.
class CallStateBand extends ConsumerWidget {
  const CallStateBand({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(
      stationViewProvider.select(
        (v) => (
          phase: v?.phase,
          link: v?.link,
          interruption: v?.audio.interruption ?? AudioInterruption.none,
          name: v?.call?.customerName,
          phone: v?.call?.phoneE164,
          masked: v?.maskPhone ?? false,
          bridgedAt: v?.call?.bridgedAt,
          recording: v?.call?.recording ?? false,
          deadline: v?.reconnectDeadline,
          release: v?.release,
          wrapup: v?.wrapup,
          saved: v?.dispositionSaved != null,
          inbound: v?.inbound?.stage,
          inboundWho: v?.inbound == null ? null : InboundCopy.who(v!.inbound!, masked: v.maskPhone),
          inboundBridgedAt: v?.inbound?.bridgedAt,
          inboundDue: v?.inbound?.outcomeDueAt,
          inboundRecording: v?.inbound?.recording ?? false,
        ),
      ),
    );
    final now = ref.watch(stationClockProvider);
    final liveCall = s.phase == AgentPhase.reserved || s.phase == AgentPhase.onCall;
    final lineDown = s.link == StationLink.reconnecting || s.link == StationLink.disconnected;

    if (lineDown && liveCall) {
      final deadline = s.deadline;
      return StateBand(
        key: Key(s.link == StationLink.disconnected ? 'band-disconnected' : 'band-reconnecting'),
        tone: StationTone.problem,
        icon: Icons.wifi_off,
        title: StationCopy.callProblem,
        subtitle: deadline == null ? StationCopy.callProblemSubtitle : null,
        trailing: deadline == null
            ? null
            : TickingBuilder(
                now: now,
                anchor: deadline,
                builder: (context, at) {
                  final left = secondsLeft(deadline, at);
                  return ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 140),
                    child: Semantics(
                      key: const Key('reconnect-ring'),
                      label: StationCopy.callKeptFor(formatClock(Duration(seconds: left), padMinutes: false)),
                      excludeSemantics: true,
                      child: Text(
                        StationCopy.callKeptFor(formatClock(Duration(seconds: left), padMinutes: false)),
                        textAlign: TextAlign.end,
                        style: Theme.of(context).textTheme.titleSmall!.copyWith(color: context.stateTokens.problem.ink),
                      ),
                    ),
                  );
                },
              ),
      );
    }
    if (lineDown) {
      return StateBand(
        key: Key(s.link == StationLink.disconnected ? 'band-disconnected' : 'band-reconnecting'),
        tone: StationTone.problem,
        icon: Icons.wifi_off,
        title: StationCopy.internetProblem,
        subtitle: s.link == StationLink.disconnected ? StationCopy.internetStopped : StationCopy.internetProblemSubtitle,
      );
    }

    if ((s.phase == AgentPhase.onCall || s.inbound == InboundStage.connected) && s.interruption != AudioInterruption.none) {
      final phone = s.interruption == AudioInterruption.phoneCall;
      return StateBand(
        key: const Key('band-interrupted'),
        tone: StationTone.problem,
        icon: phone ? Icons.phone_callback : Icons.music_off,
        title: phone ? StationCopy.phoneCallTitle : StationCopy.otherAppTitle,
        subtitle: StationCopy.phoneCallSubtitle,
      );
    }

    final inbound = s.inbound;
    if (inbound != null) {
      final who = s.inboundWho ?? InboundCopy.numberWithheld;
      switch (inbound) {
        case InboundStage.offered:
          return StateBand(
            key: const Key('band-inbound-offered'),
            tone: StationTone.coming,
            icon: Icons.phone_callback_outlined,
            title: StationCopy.customerCalling,
            subtitle: InboundCopy.incomingFrom(who),
            trailing: const _ConnectingDots(),
          );
        case InboundStage.connected:
          final bridged = s.inboundBridgedAt;
          return StateBand(
            key: const Key('band-on-call'),
            tone: StationTone.onCall,
            icon: Icons.call,
            title: StationCopy.onCall,
            subtitle: InboundCopy.onCallWith(who),
            trailing: bridged == null ? null : TalkTimer(since: bridged, now: now, recording: s.inboundRecording),
          );
        case InboundStage.outcome:
          final due = s.inboundDue;
          return StateBand(
            key: const Key('band-inbound-outcome'),
            tone: StationTone.happened,
            icon: Icons.check_circle_outline,
            title: StationCopy.whatHappened,
            subtitle: InboundCopy.outcomeDetail(who),
            trailing: due == null ? null : LapseCountdown(due: due, now: now),
          );
      }
    }

    switch (s.phase) {
      case AgentPhase.reserved:
        return const StateBand(
          key: Key('band-ringing'),
          tone: StationTone.coming,
          icon: Icons.phone_callback_outlined,
          title: StationCopy.callComing,
          subtitle: StationCopy.callComingSubtitle,
          trailing: _ConnectingDots(),
        );
      case AgentPhase.onCall:
        final who = [
          if (s.name case final n?) n else if (s.phone != null) stationPhone(s.phone!, masked: s.masked),
        ].join(' · ');
        final bridged = s.bridgedAt;
        return StateBand(
          key: const Key('band-on-call'),
          tone: StationTone.onCall,
          icon: Icons.call,
          title: StationCopy.onCall,
          subtitle: who,
          trailing: bridged == null ? null : TalkTimer(since: bridged, now: now, recording: s.recording),
        );
      case AgentPhase.wrapup:
        return _WrapupBand(release: s.release, wrapup: s.wrapup, saved: s.saved, now: now);
      default:
        return const SizedBox.shrink();
    }
  }
}

/// "Connecting •••" while a call is on its way: three dots that step (still under reduced motion).
class _ConnectingDots extends StatefulWidget {
  const _ConnectingDots();

  @override
  State<_ConnectingDots> createState() => _ConnectingDotsState();
}

class _ConnectingDotsState extends State<_ConnectingDots> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ink = DefaultTextStyle.of(context).style.color ?? Colors.white;
    return ExcludeSemantics(
      child: DecoratedBox(
        decoration: BoxDecoration(color: ink.withValues(alpha: 0.18), borderRadius: BorderRadius.circular(Radii.pill)),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: Space.sm, vertical: 6),
          child: AnimatedBuilder(
            animation: _c,
            builder: (context, _) {
              final step = (_c.value * 3).floor();
              return Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (var i = 0; i < 3; i++)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 3),
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: ink.withValues(alpha: _c.isAnimating ? (i == step ? 1 : 0.45) : 0.8),
                          shape: BoxShape.circle,
                        ),
                        child: const SizedBox.square(dimension: 10),
                      ),
                    ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

/// The talk timer, big in the band, with "Recorded" and its red dot under it when the campaign
/// records. Its own leaf, so only these digits repaint each second.
class TalkTimer extends StatelessWidget {
  const TalkTimer({super.key, required this.since, required this.now, this.recording = false});

  final DateTime since;
  final DateTime Function() now;
  final bool recording;

  @override
  Widget build(BuildContext context) {
    final ink = DefaultTextStyle.of(context).style.color;
    final text = Theme.of(context).textTheme;
    return RepaintBoundary(
      child: TickingBuilder(
        now: now,
        anchor: since,
        builder: (context, at) {
          final clock = formatClock(at.difference(since), padMinutes: false);
          return BandClock(
            clock,
            key: const Key('talk-timer'),
            semanticsLabel: 'Talk time $clock',
            caption: recording
                ? Row(
                    key: const Key('recording'),
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.fiber_manual_record, size: 12, color: Color(0xFFFF6B6B)),
                      const SizedBox(width: 4),
                      Text(StationCopy.recorded, style: text.labelMedium!.copyWith(color: ink, fontWeight: FontWeight.w600)),
                    ],
                  )
                : null,
          );
        },
      ),
    );
  }
}

/// "Without one, it closes in 29:41": the time an owed inbound outcome waits before the server
/// closes the call without one (`outcome_due_at`). A screen reader is told the time it closes at,
/// once, rather than every second.
class LapseCountdown extends StatelessWidget {
  const LapseCountdown({super.key, required this.due, required this.now});

  final DateTime due;
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    final ink = DefaultTextStyle.of(context).style.color;
    final text = Theme.of(context).textTheme;
    return RepaintBoundary(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 150),
        child: Semantics(
          label: InboundCopy.lapseSemantics(formatTime(due)),
          excludeSemantics: true,
          child: TickingBuilder(
            now: now,
            anchor: due,
            builder: (context, at) => Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(InboundCopy.lapsePrefix, textAlign: TextAlign.end, style: text.labelSmall!.copyWith(color: ink)),
                Text(
                  formatClock(due.difference(at), padMinutes: false),
                  key: const Key('inbound-lapse'),
                  style: text.titleLarge!.copyWith(color: ink, fontFeatures: const [FontFeature.tabularFigures()]),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// What happened? (05): purple, "Choose one. Then press Save.", and the time left in a ring. When the
/// time runs out with nothing saved the band turns red-orange and reads "Time is over 0:00" (05d):
/// nothing is picked for the agent, and the screen says so beneath. A supervisor's hold says who it
/// waits on instead of counting.
class _WrapupBand extends StatelessWidget {
  const _WrapupBand({required this.release, required this.wrapup, required this.saved, required this.now});

  final ReleaseView? release;
  final WrapupView? wrapup;
  final bool saved;
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    final w = wrapup;
    if (w == null) {
      return const StateBand(
        key: Key('band-wrapup'),
        tone: StationTone.happened,
        icon: Icons.check_circle_outline,
        title: StationCopy.whatHappened,
        subtitle: StationCopy.chooseOneThenSave,
      );
    }
    final requires = release?.requiresDisposition ?? true;
    Widget band(DateTime at) {
      final clock = wrapupClock(w, at, requiresDisposition: requires);
      final over = !saved && clock.holding && !clock.supervisorHold;
      return StateBand(
        key: const Key('band-wrapup'),
        tone: over ? StationTone.over : StationTone.happened,
        icon: over ? Icons.timer_off_outlined : Icons.check_circle_outline,
        title: over ? StationCopy.timeOver : StationCopy.whatHappened,
        subtitle: over ? StationCopy.chooseOneFirst : StationCopy.chooseOneThenSave,
        trailing: clock.secondsLeft == null
            ? (clock.supervisorHold ? const _HeldTag(text: StationCopy.heldBySupervisor) : null)
            : _TimeLeft(seconds: clock.secondsLeft!, fraction: clock.fraction ?? 0),
      );
    }

    final endsAt = w.endsAt;
    if (endsAt == null) return band(now());
    return RepaintBoundary(
      child: TickingBuilder(now: now, anchor: endsAt, builder: (context, at) => band(at)),
    );
  }
}

class _HeldTag extends StatelessWidget {
  const _HeldTag({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final ink = DefaultTextStyle.of(context).style.color;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 130),
      child: Text(
        text,
        key: const Key('wrapup-held'),
        textAlign: TextAlign.end,
        style: Theme.of(context).textTheme.labelLarge!.copyWith(color: ink),
      ),
    );
  }
}

/// "◔ 0:22": the time left to choose, a ring and the digits, in a pill on the band.
class _TimeLeft extends StatelessWidget {
  const _TimeLeft({required this.seconds, required this.fraction});

  final int seconds;
  final double fraction;

  @override
  Widget build(BuildContext context) {
    final ink = DefaultTextStyle.of(context).style.color ?? Colors.white;
    final text = Theme.of(context).textTheme;
    final clock = formatClock(Duration(seconds: seconds), padMinutes: false);
    return Semantics(
      label: '${StationCopy.timeLeft} $clock',
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(color: ink.withValues(alpha: 0.18), borderRadius: BorderRadius.circular(Radii.pill)),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: Space.sm, vertical: 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox.square(
                dimension: 22,
                child: CircularProgressIndicator(
                  key: const Key('wrapup-bar'),
                  value: fraction.clamp(0.0, 1.0).toDouble(),
                  strokeWidth: 4,
                  color: ink,
                  backgroundColor: ink.withValues(alpha: 0.3),
                ),
              ),
              const SizedBox(width: Space.sm),
              Text(
                clock,
                key: const Key('wrapup-digits'),
                style: text.titleLarge!.copyWith(color: ink, fontFeatures: const [FontFeature.tabularFigures()]),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
