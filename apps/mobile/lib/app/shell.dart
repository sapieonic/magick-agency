import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/station/station_signals.dart';
import 'routes.dart';

/// The tabbed shell: Station · Performance · My calls · Me.
///
/// The station's rules that move the agent (a call takes the screen; on duty
/// and not on a break, the agent stays on the station) are the router's
/// (`stationRedirect` in router.dart), so they hold on every route. The
/// shell shows them:
/// * the tab bar hides while a call (reserved, on call, wrap-up) is on screen;
/// * on duty and not on a break, the other tabs are disabled, with the reason;
/// * while on duty, the Station tab opens the station, not the campaign list.
class AppShell extends ConsumerWidget {
  const AppShell({super.key, required this.shell});

  final StatefulNavigationShell shell;

  /// Why a tab is disabled, for a long press and for screen readers.
  static const heldReason = 'Take a break or leave the station to open this';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final signals = ref.watch(stationSignalsProvider);
    final held = signals.holdsStation;

    NavigationDestination other(IconData icon, IconData selected, String label) => NavigationDestination(
          icon: Icon(icon),
          selectedIcon: Icon(selected),
          label: label,
          enabled: !held,
          tooltip: held ? heldReason : null,
        );

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
                other(Icons.bar_chart_outlined, Icons.bar_chart, 'Performance'),
                other(Icons.list_alt_outlined, Icons.list_alt, 'My calls'),
                other(Icons.person_outline, Icons.person, 'Me'),
              ],
            ),
    );
  }
}
