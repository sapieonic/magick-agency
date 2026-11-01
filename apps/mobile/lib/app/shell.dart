import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/station/station_signals.dart';
import 'routes.dart';

/// The tabbed shell: Station · Performance · My calls · Me.
///
/// Three station rules live here because they cut across tabs:
/// * a call (reserved, on call, wrap-up) takes the screen from whichever tab
///   the agent is on, and the tab bar hides until it is over;
/// * on duty and not on a break, the agent stays on the station: the other
///   tabs are disabled, and a break ending elsewhere brings them back to it;
/// * while on duty, the Station tab opens the station, not the campaign list.
class AppShell extends ConsumerWidget {
  const AppShell({super.key, required this.shell});

  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final signals = ref.watch(stationSignalsProvider);

    ref.listen<StationSignals>(stationSignalsProvider, (prev, next) {
      final becameActive = next.callActive && !(prev?.callActive ?? false);
      // Only a break ending: joining already lands on the station.
      final breakEnded = next.holdsStation && (prev?.onDuty ?? false) && prev!.onBreak;
      if ((becameActive || breakEnded) && next.campaignId != null) {
        final target = Routes.station(next.campaignId!);
        if (GoRouterState.of(context).matchedLocation != target) context.go(target);
      }
    });

    final held = signals.holdsStation;
    return Scaffold(
      body: shell,
      bottomNavigationBar: signals.callActive
          ? null
          : NavigationBar(
              selectedIndex: shell.currentIndex,
              onDestinationSelected: (i) {
                if (i != 0 && held) return;
                if (i == 0 && signals.onDuty && signals.campaignId != null) {
                  context.go(Routes.station(signals.campaignId!));
                  return;
                }
                shell.goBranch(i, initialLocation: i == shell.currentIndex);
              },
              destinations: [
                const NavigationDestination(icon: Icon(Icons.call_outlined), selectedIcon: Icon(Icons.call), label: 'Station'),
                NavigationDestination(
                  icon: const Icon(Icons.bar_chart_outlined),
                  selectedIcon: const Icon(Icons.bar_chart),
                  label: 'Performance',
                  enabled: !held,
                ),
                NavigationDestination(
                  icon: const Icon(Icons.list_alt_outlined),
                  selectedIcon: const Icon(Icons.list_alt),
                  label: 'My calls',
                  enabled: !held,
                ),
                NavigationDestination(
                  icon: const Icon(Icons.person_outline),
                  selectedIcon: const Icon(Icons.person),
                  label: 'Me',
                  enabled: !held,
                ),
              ],
            ),
    );
  }
}
