import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/softphone/softphone_view.dart' show softphoneAvailabilityProvider;
import '../core/station/station_signals.dart';
import 'routes.dart';

/// The shell's branches, in the router's order (`routerProvider`). The set is
/// fixed, so a branch's index never moves; the Phone branch is simply not a
/// destination while the soft phone is not available to the agent.
abstract final class ShellBranch {
  static const station = 0;
  static const phone = 1;
  static const performance = 2;
  static const calls = 3;
  static const me = 4;
}

/// The branch behind each tab, in tab order: Station · Phone · Performance ·
/// My calls · Me, without Phone when [phone] is false. A tab's index is its
/// position here; a branch's tab is `indexOf(branch)`.
@visibleForTesting
List<int> shellTabBranches({required bool phone}) => [
      ShellBranch.station,
      if (phone) ShellBranch.phone,
      ShellBranch.performance,
      ShellBranch.calls,
      ShellBranch.me,
    ];

/// The tabbed shell: Station · Phone · Performance · My calls · Me (Phone only
/// while the soft phone is available, `softphoneAvailabilityProvider`).
///
/// The rules that move the agent (a call takes the screen; an owed soft-phone
/// outcome holds; on duty on a campaign and not on a break, the agent stays on
/// the station) are the router's (`stationRedirect` in router.dart), so they
/// hold on every route. The shell shows them:
/// * the tab bar hides while a call (a campaign call, or a soft-phone call on
///   the line) is on screen;
/// * while a soft-phone call owes its outcome the bar stays, and every tab but
///   the session's own is disabled, with the reason;
/// * on duty on a campaign and not on a break, the other tabs (Phone too) are
///   disabled, with the reason;
/// * while on a campaign, the Station tab opens the station, not the campaign
///   list; on the soft phone, so does the Phone tab (the soft phone is in the
///   station then). With a soft-phone session the Station tab is the campaign
///   list, which says the soft phone is open.
class AppShell extends ConsumerWidget {
  const AppShell({super.key, required this.shell});

  final StatefulNavigationShell shell;

  /// Why a tab is disabled while on duty on a campaign, for a long press and
  /// for screen readers.
  static const heldReason = 'Take a break or leave the station to open this';

  /// Why a tab is disabled while a soft-phone call owes its outcome.
  static const owedReason = 'Save this call’s outcome to open this';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final signals = ref.watch(stationSignalsProvider);
    final home = signals.home;
    // The session's own screen is always a destination, whatever the
    // availability read says (it may not have answered yet after a restart).
    final phoneShown = ref.watch(softphoneAvailabilityProvider.select((a) => a.visible)) || home == StationHome.phone;
    final branches = shellTabBranches(phone: phoneShown);
    final campaign = signals.sessionKind == StationSessionKind.campaign;
    final held = campaign && signals.holdsStation;
    final owed = signals.outcomeOwed;

    // The tabs that lead to the session's own screen: the only ones open while
    // an owed outcome holds the agent. On the soft phone, Phone leads to the station.
    bool leadsHome(int branch) => switch (home) {
          StationHome.phone => branch == ShellBranch.phone,
          StationHome.station => branch == ShellBranch.station || (signals.onSoftphone && branch == ShellBranch.phone),
          null => false,
        };

    String? closedBecause(int branch) {
      if (owed && home != null) return leadsHome(branch) ? null : owedReason;
      if (held) return branch == ShellBranch.station ? null : heldReason;
      return null;
    }

    NavigationDestination destination(int branch) {
      final reason = closedBecause(branch);
      final (icon, selected, label) = switch (branch) {
        ShellBranch.station => (Icons.call_outlined, Icons.call, 'Station'),
        ShellBranch.phone => (Icons.dialpad_outlined, Icons.dialpad, 'Phone'),
        ShellBranch.performance => (Icons.bar_chart_outlined, Icons.bar_chart, 'Performance'),
        ShellBranch.calls => (Icons.list_alt_outlined, Icons.list_alt, 'My calls'),
        _ => (Icons.person_outline, Icons.person, 'Me'),
      };
      return NavigationDestination(
        icon: Icon(icon),
        selectedIcon: Icon(selected),
        label: label,
        enabled: reason == null,
        tooltip: reason,
      );
    }

    final selectedTab = branches.indexOf(shell.currentIndex);
    return Scaffold(
      body: shell,
      bottomNavigationBar: signals.callActive
          ? null
          : NavigationBar(
              // A hidden branch is never current for long: the router sends `/phone` home.
              selectedIndex: selectedTab < 0 ? 0 : selectedTab,
              onDestinationSelected: (i) {
                final branch = branches[i];
                if (closedBecause(branch) != null) return;
                final campaignId = signals.campaignId;
                final toStation = campaign &&
                    signals.onDuty &&
                    campaignId != null &&
                    (branch == ShellBranch.station || (branch == ShellBranch.phone && signals.onSoftphone));
                if (toStation) {
                  context.go(Routes.station(campaignId));
                  return;
                }
                shell.goBranch(branch, initialLocation: branch == shell.currentIndex);
              },
              destinations: [for (final b in branches) destination(b)],
            ),
    );
  }
}
