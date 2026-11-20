import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import '../widgets/action_buttons.dart';
import '../widgets/state_band.dart';
import 'idle_views.dart' show LeaveStationButton;
import 'layouts.dart';
import 'top_bar.dart';

/// Full-screen states with no station to work at: moved to another device,
/// session over, refused, opening. Each has a way off it, so none is a trap.

class _FullScreenMessage extends StatelessWidget {
  const _FullScreenMessage({
    super.key,
    required this.tone,
    required this.icon,
    required this.title,
    required this.body,
    required this.actions,
    this.subtitle,
    this.note,
  });

  final StationTone tone;
  final IconData icon;
  final String title;
  final String? subtitle;
  final String body;
  final String? note;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final c = context.stateTokens.of(tone);
    return StationPage(
      topBar: const StationTopBar(help: false, more: false),
      banners: false,
      band: StateBand(tone: tone, icon: icon, title: title, subtitle: subtitle),
      body: [
        StationCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DecoratedBox(
                decoration: BoxDecoration(color: c.soft, borderRadius: BorderRadius.circular(Radii.lg)),
                child: SizedBox.square(dimension: 56, child: Icon(icon, size: 28, color: c.deep)),
              ),
              const SizedBox(height: Space.md),
              Text(body, style: text.titleMedium),
              if (note != null) ...[const SizedBox(height: Space.sm), Text(note!, style: text.bodyMedium)],
            ],
          ),
        ),
      ],
      actions: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: actions),
    );
  }
}

/// 4409: another device took the station.
class SupersededView extends ConsumerWidget {
  const SupersededView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy != StationBusy.none));
    return _FullScreenMessage(
      key: const Key('superseded'),
      tone: StationTone.quiet,
      icon: Icons.devices_other,
      title: StationCopy.otherDeviceTitle,
      subtitle: StationCopy.otherDeviceSubtitle,
      body: StationCopy.otherDeviceBody,
      note: StationCopy.supersededNote,
      actions: [
        MainActionButton(
          key: const Key('use-this-phone'),
          label: StationCopy.useThisPhoneNow,
          icon: Icons.smartphone,
          onPressed: busy ? null : () => ref.read(stationActionsProvider).useThisDevice(),
        ),
        const SizedBox(height: Space.xs),
        QuietActionButton(
          key: const Key('superseded-back'),
          label: StationCopy.backToWork,
          onPressed: () => _leaveOver(context, ref),
        ),
      ],
    );
  }
}

/// Off a station that is over on this phone: home, and the core forgets it
/// (the on-duty service and audio already went when it ended).
void _leaveOver(BuildContext context, WidgetRef ref) {
  final actions = ref.read(stationActionsProvider);
  context.go(Routes.home);
  unawaited(actions.dismiss());
}

/// 4404, or the session was left elsewhere.
class SessionEndedView extends ConsumerWidget {
  const SessionEndedView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _FullScreenMessage(
      key: const Key('session-ended'),
      tone: StationTone.quiet,
      icon: Icons.logout,
      title: StationCopy.workEnded,
      body: StationCopy.workEndedDetail,
      actions: [
        MainActionButton(
          key: const Key('back-to-campaigns'),
          label: StationCopy.backToWork,
          onPressed: () => _leaveOver(context, ref),
        ),
      ],
    );
  }
}

/// The station could not open at all.
class FatalView extends ConsumerWidget {
  const FatalView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final message = ref.watch(stationViewProvider.select((v) => v?.fatal ?? ''));
    return _FullScreenMessage(
      key: const Key('fatal'),
      tone: StationTone.problem,
      icon: Icons.error_outline,
      title: StationCopy.cannotStart,
      body: message,
      actions: [
        MainActionButton(
          key: const Key('fatal-back'),
          label: StationCopy.backToWork,
          onPressed: () => _leaveOver(context, ref),
        ),
      ],
    );
  }
}

/// No station here: the app was restarted, or the station is another campaign's.
class NotHereView extends ConsumerWidget {
  const NotHereView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final other = ref.watch(stationViewProvider.select((v) => v == null ? null : (id: v.campaignId, name: v.campaignName)));
    return _FullScreenMessage(
      key: const Key('not-here'),
      tone: StationTone.quiet,
      icon: Icons.headset_off_outlined,
      title: other == null ? StationCopy.notHereTitle : StationCopy.elsewhereTitle(other.name),
      body: StationCopy.notHereDetail,
      actions: [
        if (other != null) ...[
          MainActionButton(
            label: StationCopy.openIt,
            onPressed: () => context.go(Routes.station(other.id)),
          ),
          const SizedBox(height: Space.xs),
        ],
        QuietActionButton(label: StationCopy.backToWork, onPressed: () => context.go(Routes.home)),
      ],
    );
  }
}

/// Joining / first connect. Finish work stays offered: with no network this screen could otherwise
/// only be left by closing the app.
class ConnectingView extends ConsumerWidget {
  const ConnectingView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final text = Theme.of(context).textTheme;
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    final name = ref.watch(stationAgentNameProvider);
    return StationPage(
      key: const Key('connecting'),
      topBar: const StationTopBar(help: false, more: false),
      band: StateBand(tone: StationTone.start, icon: Icons.headphones, title: StationCopy.namaste(name), subtitle: StationCopy.opening),
      body: [
        const SizedBox(height: Space.xl),
        Semantics(
          liveRegion: true,
          child: Column(
            children: [
              const LiveDot(size: 12),
              const SizedBox(height: Space.md),
              Text(StationCopy.connecting, style: text.titleMedium, textAlign: TextAlign.center),
            ],
          ),
        ),
      ],
      actions: LeaveStationButton(busy: busy),
    );
  }
}

/// Internet problem (09): the line is down with no call on screen. Calls are stopped; the station
/// tries again by itself, and "Try again now" is offered once it has given up (pressed while it is
/// still trying it would only start the ladder over). What to do, in three steps; the last one is
/// "Call your supervisor to your desk", because Need help cannot reach anyone now (AS5). Finish work
/// stays under ⋮ More: leaving is plain HTTP.
class InternetProblemView extends ConsumerWidget {
  const InternetProblemView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final link = ref.watch(stationViewProvider.select((v) => v?.link));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy != StationBusy.none));
    final gaveUp = link == StationLink.disconnected;
    final text = Theme.of(context).textTheme;
    return StationPage(
      key: Key(gaveUp ? 'idle-disconnected' : 'idle-reconnecting'),
      band: StateBand(
        key: const Key('band-internet-problem'),
        tone: StationTone.problem,
        icon: Icons.wifi_off,
        title: StationCopy.internetProblem,
        subtitle: gaveUp ? StationCopy.internetStopped : StationCopy.internetProblemSubtitle,
      ),
      body: const [
        StepsCard(
          title: StationCopy.whatToDo,
          tone: StationTone.problem,
          steps: [StationCopy.stepCheckInternet, StationCopy.stepWait, StationCopy.stepCallSupervisor],
        ),
      ],
      actions: gaveUp
          ? MainActionButton(
              key: const Key('reconnect'),
              label: StationCopy.tryAgainNow,
              icon: Icons.refresh,
              onPressed: busy ? null : () => ref.read(stationActionsProvider).reconnect(),
            )
          : Padding(
              padding: const EdgeInsets.symmetric(vertical: Space.sm),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                  const SizedBox(width: Space.sm),
                  Flexible(child: Text(StationCopy.tryingAgain, key: const Key('trying-again'), style: text.titleMedium)),
                ],
              ),
            ),
    );
  }
}
