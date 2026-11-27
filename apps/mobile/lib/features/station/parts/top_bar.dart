import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/flags/feature_flags.dart' show contactAssignmentEnabledProvider;
import '../../../core/session/local_preferences.dart';
import '../../../core/softphone/softphone_view.dart' show softphoneAvailabilityProvider, softphoneViewProvider;
import '../../../core/station/station_view.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import '../station_providers.dart';
import '../widgets/ticking.dart';
import 'banners.dart' show showStationInfoSheet;
import 'sheets.dart';

/// The top bar of every station screen (design-spec §3, "Every screen: the top bar"): who is
/// working and on what, then Need help and ⋮ More on the right, 48 dp each. Not shown on Finish
/// work and Open on another device ([help] and [more] false there).
class StationTopBar extends ConsumerWidget {
  const StationTopBar({super.key, this.help = true, this.more = true});

  final bool help;
  final bool more;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(stationAgentNameProvider);
    final work = ref.watch(stationViewProvider.select((v) => v?.campaignName ?? ''));
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final initials = _initials(name ?? work);
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.md, Space.sm),
      child: Row(
        children: [
          ExcludeSemantics(
            child: DecoratedBox(
              decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.circular(Radii.md)),
              child: SizedBox.square(
                dimension: 40,
                child: Center(
                  child: Text(initials, style: text.titleSmall!.copyWith(color: t.onAccent, fontWeight: FontWeight.w700)),
                ),
              ),
            ),
          ),
          const SizedBox(width: Space.sm),
          Expanded(
            child: Semantics(
              header: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  // At large text the work's name is the one line kept: the agent knows their own.
                  if (name != null && MediaQuery.textScalerOf(context).scale(16) / 16 <= 1.3)
                    Text(name, key: const Key('agent-name'), style: text.titleSmall, maxLines: 1, overflow: TextOverflow.ellipsis),
                  Text(work, key: const Key('work-name'), style: text.bodySmall, maxLines: 1, overflow: TextOverflow.ellipsis),
                ],
              ),
            ),
          ),
          if (help) const Flexible(child: NeedHelpButton()),
          if (more) ...[const SizedBox(width: Space.xs), const MoreButton()],
        ],
      ),
    );
  }

  static String _initials(String s) {
    final parts = s.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '';
    final first = parts.first.characters.first;
    final second = parts.length > 1 ? parts[1].characters.first : '';
    return (first + second).toUpperCase();
  }
}

/// Need help, top right, on every working screen (AS5, BE-9; floor assist LF4). A server older than
/// BE-9 takes a raise only on a call or while the agent finishes one: once it refuses one elsewhere
/// (`help_not_on_call`, [HelpView.onlyOnCall]) the button is offered there only. An open request
/// shows on any screen, as "Help asked · 0:42", and pressing it again cancels.
/// With no internet the press cannot reach anyone: it says to call the supervisor to the desk.
///
/// Behind the account's `agency_floor_assist_enabled` ([stationNeedHelpProvider]). Its own stage,
/// never the station's busy state, so asking for help never holds up ending or saving a call.
///
/// The request and its actions are the hosted session's ([sessionHelpProvider],
/// [sessionHelpActionsProvider]), a campaign station's or a soft-phone session's. On the Phone tab
/// ([NeedHelpButton.phoneTab], LF39) there is no campaign view: the soft phone's view
/// ([softphoneViewProvider]) says whether a call is on screen and whether the socket is open.
class NeedHelpButton extends ConsumerWidget {
  const NeedHelpButton({super.key}) : _phoneTab = false;

  /// On the Phone tab's soft-phone session.
  const NeedHelpButton.phoneTab({super.key}) : _phoneTab = true;

  final bool _phoneTab;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!ref.watch(stationNeedHelpProvider)) return const SizedBox.shrink();
    final help = ref.watch(sessionHelpProvider);
    final bool offered;
    final bool open;
    if (_phoneTab) {
      // A call on screen (live or owing its outcome), and whether the session's socket is open.
      final phone = ref.watch(softphoneViewProvider.select((v) => (onCall: v.callOnScreen, linkOpen: v.link == StationLink.open)));
      // A soft-phone session takes a raise in any state (AS5); on calls only when this server
      // refused a raise off one.
      offered = !help.onlyOnCall || phone.onCall;
      open = phone.linkOpen;
    } else {
      final phase = ref.watch(stationViewProvider.select((v) => v?.phase));
      open = ref.watch(stationViewProvider.select((v) => v?.link == StationLink.open));
      // Every working screen (AS5, BE-9); on calls only when this server refused a raise off one.
      final onCall = phase == AgentPhase.onCall || phase == AgentPhase.wrapup;
      offered = phase != null && (!help.onlyOnCall || onCall);
    }
    if (!help.isOpen && !offered) return const SizedBox.shrink();
    final s = context.stateTokens;
    final text = Theme.of(context).textTheme;
    final actions = ref.read(sessionHelpActionsProvider);

    if (help.isOpen) {
      final cancelling = help.stage == HelpStage.cancelling;
      final raisedAt = help.raisedAt;
      final now = ref.watch(stationClockProvider);
      Widget label(String clock) => Text(
            cancelling ? StationCopy.cancellingHelp : (clock.isEmpty ? StationCopy.helpAskedLabel : StationCopy.helpAsked(clock)),
            key: const Key('help-asked'),
            maxLines: 2,
            style: text.labelLarge!.copyWith(color: s.onAction),
          );
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Said once as the request opens; the ticking clock stays out of it (a live region whose
          // text changes is said again, every second, over the customer).
          Semantics(
            key: const Key('help-requested-status'),
            container: true,
            liveRegion: true,
            label: StationCopy.helpRequested,
            child: const SizedBox.square(dimension: 1),
          ),
          Flexible(
            child: Semantics(
              button: true,
              enabled: !cancelling,
              label: cancelling ? StationCopy.cancellingHelpLabel : StationCopy.cancelHelpLabel,
              excludeSemantics: true,
              onTap: cancelling ? null : actions.cancelHelp,
              child: FilledButton(
                key: const Key('cancel-help'),
                onPressed: cancelling ? null : actions.cancelHelp,
                style: FilledButton.styleFrom(
                  minimumSize: const Size(48, 48),
                  backgroundColor: s.stop,
                  disabledBackgroundColor: s.stop.withValues(alpha: 0.6),
                  padding: const EdgeInsets.symmetric(horizontal: Space.md),
                ),
                child: raisedAt == null || cancelling
                    ? label('')
                    : TickingBuilder(
                        now: now,
                        anchor: raisedAt,
                        builder: (context, at) => label(formatClock(at.difference(raisedAt), padMinutes: false)),
                      ),
              ),
            ),
          ),
        ],
      );
    }

    final raising = help.stage == HelpStage.raising;
    final red = s.problem.deep;
    return MergeSemantics(
        child: Semantics(
          hint: StationCopy.needHelpHint,
          child: OutlinedButton.icon(
            key: const Key('need-help'),
            onPressed: raising || help.stage != HelpStage.none
                ? null
                : open
                    ? actions.raiseHelp
                    : () => _offline(context),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(48, 48),
              foregroundColor: red,
              side: BorderSide(color: red, width: 1.5),
              padding: const EdgeInsets.symmetric(horizontal: Space.md),
            ),
            icon: raising
                ? SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2, color: red))
                : const Icon(Icons.help_outline),
            label: Text(raising ? StationCopy.askingForHelp : StationCopy.needHelp, maxLines: 2),
          ),
        ),
    );
  }

  /// No internet: a press could not reach a supervisor (AS5).
  void _offline(BuildContext context) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(
        key: Key('help-offline'),
        content: Text('${StationCopy.offlineHelpTitle}. ${StationCopy.offlineHelp}'),
      ),
    );
  }
}

enum _MoreItem { myCustomers, dialMyself, listening, sound, finishWork }

/// ⋮ More (design-spec §3): what the screens dropped but agents still need. Items that cannot be
/// used now are hidden: on a call and on What happened? it holds only Sound.
class MoreButton extends ConsumerWidget {
  const MoreButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(
      stationViewProvider.select(
        (v) => (
          callActive: v?.callActive ?? false,
          inbound: v?.inbound != null,
          phase: v?.phase,
          away: v?.onBreak?.isDeviceAway ?? false,
          offered: v?.myContactsOffered ?? false,
          campaignId: v?.campaignId,
          busy: v?.busy ?? StationBusy.none,
          open: v?.link == StationLink.open,
        ),
      ),
    );
    final contacts = ref.watch(contactAssignmentEnabledProvider);
    final softphone = ref.watch(softphoneAvailabilityProvider.select((a) => a.startAllowed));
    final listening = ref.watch(stationListenNoticeProvider);
    final call = s.callActive || s.inbound;
    final items = <_MoreItem>[
      if (!call && contacts && s.offered && s.campaignId != null) _MoreItem.myCustomers,
      if (!call && softphone && s.open && (s.phase == AgentPhase.available || (s.phase == AgentPhase.onBreak && !s.away)))
        _MoreItem.dialMyself,
      if (!call && listening) _MoreItem.listening,
      _MoreItem.sound,
      if (!call) _MoreItem.finishWork,
    ];
    final t = context.tokens;
    final red = context.stateTokens.problem.deep;
    return PopupMenuButton<_MoreItem>(
      key: const Key('station-more'),
      tooltip: StationCopy.more,
      icon: const Icon(Icons.more_vert),
      style: IconButton.styleFrom(
        minimumSize: const Size(48, 48),
        side: BorderSide(color: t.borderStrong),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.md)),
      ),
      onSelected: (item) => _select(context, ref, item, s.campaignId, s.busy),
      itemBuilder: (context) => [
        for (final item in items)
          if (item == _MoreItem.finishWork) ...[
            if (items.length > 1) const PopupMenuDivider(),
            PopupMenuItem(
              key: const Key('leave'),
              value: item,
              enabled: s.busy != StationBusy.leaving,
              child: _MenuRow(icon: Icons.logout, label: StationCopy.finishWork, color: red),
            ),
          ] else
            PopupMenuItem(
              key: Key(switch (item) {
                _MoreItem.myCustomers => 'my-contacts',
                _MoreItem.dialMyself => 'switch-softphone',
                _MoreItem.listening => 'station-info',
                _MoreItem.sound => 'station-sound',
                _MoreItem.finishWork => 'leave',
              }),
              value: item,
              enabled: item != _MoreItem.dialMyself || s.busy == StationBusy.none,
              child: switch (item) {
                _MoreItem.myCustomers => const _MenuRow(icon: Icons.people_alt_outlined, label: StationCopy.myCustomers),
                _MoreItem.dialMyself => const _MenuRow(icon: Icons.dialpad, label: StationCopy.dialMyself),
                _MoreItem.listening => const _MenuRow(icon: Icons.info_outline, label: StationCopy.listenInfo),
                _MoreItem.sound => const _MenuRow(icon: Icons.volume_up_outlined, label: StationCopy.sound),
                _MoreItem.finishWork => const SizedBox.shrink(),
              },
            ),
      ],
    );
  }

  void _select(BuildContext context, WidgetRef ref, _MoreItem item, String? campaignId, StationBusy busy) {
    switch (item) {
      case _MoreItem.myCustomers:
        if (campaignId != null) GoRouter.maybeOf(context)?.go(Routes.myContacts(campaignId));
      case _MoreItem.dialMyself:
        unawaited(switchStationToSoftphone(context));
      case _MoreItem.listening:
        unawaited(showStationInfoSheet(context));
      case _MoreItem.sound:
        unawaited(showSoundSheet(context));
      case _MoreItem.finishWork:
        unawaited(leaveStation(context));
    }
  }
}

class _MenuRow extends StatelessWidget {
  const _MenuRow({required this.icon, required this.label, this.color});

  final IconData icon;
  final String label;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Row(
      children: [
        Icon(icon, color: color),
        const SizedBox(width: Space.md),
        Flexible(child: Text(label, style: text.titleMedium!.copyWith(color: color))),
      ],
    );
  }
}

/// ⋮ More → Sound: today's sound and vibration switches, and the dark screen (AS14: light by
/// default, dark on offer). All kept on this phone only.
Future<void> showSoundSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    builder: (context) => Consumer(
      builder: (context, ref, _) {
        final prefs = ref.watch(localPreferencesProvider);
        final notifier = ref.read(localPreferencesProvider.notifier);
        final text = Theme.of(context).textTheme;
        return SingleChildScrollView(
          key: const Key('sound-sheet'),
          padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.xl),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(header: true, child: Text(StationCopy.soundTitle, style: text.titleLarge)),
              const SizedBox(height: Space.sm),
              SwitchListTile(
                key: const Key('sound-sounds'),
                value: prefs.sounds,
                onChanged: notifier.setSounds,
                title: const Text(StationCopy.soundCalls),
                subtitle: const Text(StationCopy.soundCallsDetail),
              ),
              SwitchListTile(
                key: const Key('sound-vibration'),
                value: prefs.haptics,
                onChanged: notifier.setHaptics,
                title: const Text(StationCopy.vibration),
                subtitle: const Text(StationCopy.vibrationDetail),
              ),
              SwitchListTile(
                key: const Key('sound-dark'),
                value: prefs.darkTheme ?? false,
                onChanged: notifier.setDarkTheme,
                title: const Text(StationCopy.darkScreen),
                subtitle: const Text(StationCopy.darkScreenDetail),
              ),
            ],
          ),
        );
      },
    ),
  );
}
