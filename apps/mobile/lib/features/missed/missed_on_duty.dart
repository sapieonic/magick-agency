import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../core/station/station_view.dart';
import 'missed_access.dart';
import 'missed_calls_copy.dart';
import 'missed_calls_list.dart';

/// The Missed list on duty on a campaign (IQ48).
///
/// My calls stays closed while the agent is held on the station (on duty, not
/// on a break), except for this: the station's waiting and wrap-up screens say
/// how many customers are waiting to be called back ([MissedToCallBackLine]),
/// and that line and the My calls tab open the Missed list in a sheet over the
/// station. A sheet, not a route: the router's rules (a call takes the screen,
/// the station holds the agent) are untouched, the station stays underneath
/// with nothing paused or changed, and the sheet closes itself when another
/// call reaches the agent ([_CloseWhenAnotherCall]). Call back from it switches
/// the campaign to the soft phone in the same step (`startCallBack`).

/// Opens the Missed list over the station. A provider, so the shell's tests
/// see the tab open it without building the list.
final missedOnDutyOpenerProvider = Provider<void Function(BuildContext context)>(
  (ref) => (context) => unawaited(showMissedCallsOnDuty(context)),
);

/// The Missed list in a sheet over the station, closed by Close, the back
/// gesture, a Call back (which moves to the soft phone's pad) or another call
/// reaching the agent.
Future<void> showMissedCallsOnDuty(BuildContext context) {
  final container = ProviderScope.containerOf(context, listen: false);
  final callId = container.read(stationViewProvider)?.callId;
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    // Over the tab bar too, from the station's body or the tab bar alike.
    useRootNavigator: true,
    builder: (sheet) => _CloseWhenAnotherCall(
      callId: callId,
      child: FractionallySizedBox(
        heightFactor: 0.94,
        child: Column(
          key: const Key('missed-on-duty-sheet'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.xs, Space.xs),
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(MissedCopy.title, style: Theme.of(sheet).textTheme.titleLarge),
                    ),
                  ),
                  TextButton(
                    key: const Key('missed-on-duty-close'),
                    onPressed: () => Navigator.of(sheet).maybePop(),
                    child: const Text(MissedCopy.close),
                  ),
                ],
              ),
            ),
            Expanded(child: MissedCallsList(onLeave: () => Navigator.of(sheet).maybePop())),
          ],
        ),
      ),
    ),
  );
}

/// Holds while the call on the station is still [callId] (none while
/// waiting; the wrapped-up call in a wrap-up, and none once it is saved).
/// Another call reaching the agent, or the station closing, closes the sheet:
/// a call takes the screen.
class _CloseWhenAnotherCall extends ConsumerStatefulWidget {
  const _CloseWhenAnotherCall({required this.callId, required this.child});

  final String? callId;
  final Widget child;

  @override
  ConsumerState<_CloseWhenAnotherCall> createState() => _CloseWhenAnotherCallState();
}

class _CloseWhenAnotherCallState extends ConsumerState<_CloseWhenAnotherCall> {
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    // Immediately too: the station may have moved on while the sheet was opening.
    ref.listenManual<bool>(
      stationViewProvider.select((v) => v != null && (v.callId == null || v.callId == widget.callId)),
      (_, holds) {
        if (!holds) _close();
      },
      fireImmediately: true,
    );
  }

  void _close() {
    if (_closing) return;
    _closing = true;
    // Not inside the build or notification that told us.
    Future.microtask(() {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      final navigator = Navigator.of(context);
      route.isCurrent ? navigator.pop() : navigator.removeRoute(route);
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// "3 customers to call back" on the station while waiting and in wrap-up:
/// the agent's own open Missed rows (the My calls badge's count), a tap
/// opening the list over the station. Nothing when there are none, or when
/// the count is not known or not the agent's to read (the list is hidden).
/// A quiet line, not a card: the call screens stay about the call. A change
/// of count is announced politely.
class MissedToCallBackLine extends ConsumerWidget {
  const MissedToCallBackLine({super.key, this.padding = const EdgeInsets.only(top: Space.sm)});

  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final access = ref.watch(missedCallsAccessProvider);
    if (!access.visible || access.badge.isEmpty) return const SizedBox.shrink();
    final t = context.tokens;
    final style = Theme.of(context).textTheme.bodyMedium!.copyWith(color: t.textSecondary);
    return Padding(
      padding: padding,
      child: Semantics(
        button: true,
        liveRegion: true,
        label: MissedCopy.toCallBackLabel(access.badge),
        excludeSemantics: true,
        child: InkWell(
          key: const Key('missed-to-call-back'),
          borderRadius: BorderRadius.circular(Radii.sm),
          onTap: () => ref.read(missedOnDutyOpenerProvider)(context),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: Space.touch),
            child: Row(
              children: [
                Icon(Icons.phone_missed_outlined, size: 18, color: t.textSecondary),
                const SizedBox(width: Space.sm),
                Expanded(child: Text(MissedCopy.toCallBack(access.badge), style: style)),
                Icon(Icons.chevron_right, size: 20, color: t.textMuted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
