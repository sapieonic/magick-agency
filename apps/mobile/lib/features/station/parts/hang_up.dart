import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/station/station_view.dart';
import '../station_copy.dart';
import '../widgets/hold_to_confirm.dart';
import 'banners.dart';
import 'sheets.dart';

/// Hold-to-hang-up, wired to the station. Live from `reserved` on: an agent
/// who sees the wrong contact pop must be able to stop the dial.
class HangUpBar extends ConsumerWidget {
  const HangUpBar({super.key, required this.ringing});

  final bool ringing;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy == StationBusy.hangingUp));
    final hasCall = ref.watch(stationViewProvider.select((v) => v?.call != null));
    return LinkGate(
      child: HoldToConfirmBar(
        key: const Key('hang-up'),
        label: StationCopy.holdToHangUp,
        holdingLabel: StationCopy.keepHolding,
        busyLabel: StationCopy.endingCall,
        semanticLabel: StationCopy.hangUp,
        semanticHint: StationCopy.hangUpHint,
        enabled: hasCall,
        busy: busy,
        onConfirmed: () => ref.read(stationActionsProvider).hangUp(),
        confirmAccessibly: (context) => confirmHangUp(context, ringing: ringing),
      ),
    );
  }
}
