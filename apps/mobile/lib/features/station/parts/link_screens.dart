import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../station_copy.dart';
import 'banners.dart';
import 'idle_views.dart' show LeaveStationButton;

/// Full-screen states with no station to work at: moved to another device,
/// session over, refused, opening. Each has a way off it, so none is a trap.

class _FullScreenMessage extends StatelessWidget {
  const _FullScreenMessage({
    super.key,
    required this.icon,
    required this.title,
    required this.body,
    required this.actions,
    this.note,
    this.iconColor,
  });

  final IconData icon;
  final Color? iconColor;
  final String title;
  final String body;
  final String? note;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(Space.xl, Space.xxl, Space.xl, Space.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(color: t.bgTertiary, borderRadius: BorderRadius.circular(Radii.lg)),
                  child: SizedBox.square(dimension: 64, child: Icon(icon, size: 30, color: iconColor ?? t.textSecondary)),
                ),
                const SizedBox(height: Space.xl),
                Semantics(header: true, child: Text(title, style: text.headlineMedium)),
                const SizedBox(height: Space.md),
                Text(body, style: text.bodyLarge!.copyWith(color: t.textSecondary)),
                if (note != null) ...[const SizedBox(height: Space.lg), AppCard(child: Text(note!, style: text.bodyMedium))],
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, Space.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [const ActionErrorLine(), ...actions],
          ),
        ),
      ],
    );
  }
}

/// 4409: another device took the station.
class SupersededView extends ConsumerWidget {
  const SupersededView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(stationViewProvider.select((v) => v?.campaignName ?? ''));
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy != StationBusy.none));
    return _FullScreenMessage(
      key: const Key('superseded'),
      icon: Icons.swap_horiz,
      title: StationCopy.supersededTitle,
      body: StationCopy.supersededBody(name),
      note: StationCopy.supersededNote,
      actions: [
        FilledButton(
          key: const Key('use-this-phone'),
          onPressed: busy ? null : () => ref.read(stationActionsProvider).useThisDevice(),
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          child: const Text(StationCopy.useThisPhone),
        ),
        const SizedBox(height: Space.sm),
        TextButton(
          key: const Key('superseded-back'),
          onPressed: () => _leaveOver(context, ref),
          child: const Text(StationCopy.backToCampaigns),
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
      icon: Icons.logout,
      title: StationCopy.sessionEnded,
      body: StationCopy.sessionEndedDetail,
      actions: [
        FilledButton(
          key: const Key('back-to-campaigns'),
          onPressed: () => _leaveOver(context, ref),
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          child: const Text(StationCopy.backToCampaigns),
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
      icon: Icons.error_outline,
      iconColor: context.tokens.danger,
      title: StationCopy.fatalTitle,
      body: message,
      actions: [
        FilledButton(
          key: const Key('fatal-back'),
          onPressed: () => _leaveOver(context, ref),
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          child: const Text(StationCopy.backToCampaigns),
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
      icon: Icons.headset_off_outlined,
      title: other == null ? StationCopy.notHereTitle : StationCopy.elsewhereTitle(other.name),
      body: StationCopy.notHereDetail,
      actions: [
        if (other != null) ...[
          FilledButton(
            onPressed: () => context.go(Routes.station(other.id)),
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: const Text(StationCopy.openIt),
          ),
          const SizedBox(height: Space.sm),
        ],
        OutlinedButton(onPressed: () => context.go(Routes.home), child: const Text(StationCopy.backToCampaigns)),
      ],
    );
  }
}

/// Joining / first connect. Leave stays offered: with no network this screen
/// could otherwise only be left by closing the app.
class ConnectingView extends ConsumerWidget {
  const ConnectingView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final text = Theme.of(context).textTheme;
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy ?? StationBusy.none));
    return Column(
      key: const Key('connecting'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const StationHeader(),
        Expanded(
          child: Center(
            child: Semantics(
              liveRegion: true,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const LiveDot(size: 12),
                  const SizedBox(height: Space.md),
                  Text(StationCopy.connecting, style: text.titleMedium, textAlign: TextAlign.center),
                ],
              ),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, Space.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              const ActionErrorLine(),
              LeaveStationButton(busy: busy),
            ],
          ),
        ),
      ],
    );
  }
}
