import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/station/station_view.dart';
import '../station_copy.dart';
import '../widgets/slide_to_confirm.dart';
import 'banners.dart';
import 'sheets.dart';

/// Slide to end call (AS3), wired to the station: today's protection against a slip of the thumb,
/// made visible. On call only: Call coming has no button (AS11), and a customer's own hang-up moves
/// the screen on by itself.
class HangUpBar extends ConsumerWidget {
  const HangUpBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = ref.watch(stationViewProvider.select((v) => v?.busy == StationBusy.hangingUp));
    final hasCall = ref.watch(stationViewProvider.select((v) => v?.call != null));
    return LinkGate(
      child: SlideToConfirm(
        key: const Key('hang-up'),
        label: StationCopy.slideToEnd,
        busyLabel: StationCopy.ending,
        semanticLabel: StationCopy.endCall,
        semanticHint: StationCopy.endCallHint,
        enabled: hasCall,
        busy: busy,
        onConfirmed: () => ref.read(stationActionsProvider).hangUp(),
        confirmAccessibly: (context) => confirmHangUp(context),
      ),
    );
  }
}
