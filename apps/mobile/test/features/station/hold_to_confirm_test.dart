import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/features/station/widgets/hold_to_confirm.dart';

/// Pointer events that arrive after the bar has left the tree: see `_up` in
/// hold_to_confirm.dart.
void main() {
  group('a finger still down when the bar leaves the screen', () {
    final cases = <(String, Future<void> Function(TestGesture))>[
      ('lifting it does nothing', (finger) => finger.up()),
      ('sliding it does nothing', (finger) async {
        await finger.moveBy(const Offset(0, 300));
        await finger.up();
      }),
      ('a cancelled pointer does nothing', (finger) => finger.cancel()),
    ];

    for (final (name, act) in cases) {
      testWidgets(name, (tester) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: buildTheme(AppTokens.light, Brightness.light),
            home: Scaffold(
              body: Center(
                child: HoldToConfirmBar(
                  key: const Key('bar'),
                  label: 'Hold to hang up',
                  holdingLabel: 'Keep holding…',
                  busyLabel: 'Ending…',
                  semanticLabel: 'Hang up',
                  semanticHint: 'Press and hold to end the call',
                  onConfirmed: () async => fail('fired after the bar left the screen'),
                  confirmAccessibly: (_) async => false,
                ),
              ),
            ),
          ),
        );
        final finger = await tester.startGesture(tester.getCenter(find.byKey(const Key('bar'))));
        await tester.pump(const Duration(milliseconds: 200));
        await tester.pumpWidget(const SizedBox());
        await act(finger);
        // Past the 500 ms hold, so a hold that survived would have fired.
        await tester.pump(const Duration(milliseconds: 600));
        expect(tester.takeException(), isNull);
      });
    }
  });
}
