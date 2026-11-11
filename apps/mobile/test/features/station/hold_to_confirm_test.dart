import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/features/station/widgets/hold_to_confirm.dart';

/// The bar on its own, for what the station tests cannot set up exactly: a
/// pointer keeps reporting to what it hit when it went down, so a finger still
/// on the bar when it leaves the tree goes on sending moves, a lift or a
/// cancel to a bar whose animation is disposed and whose context is gone.
void main() {
  group('a finger still down when the bar leaves the screen', () {
    late int fired;

    Future<TestGesture> holdThenRemove(WidgetTester tester) async {
      final shown = ValueNotifier(true);
      addTearDown(shown.dispose);
      fired = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: buildTheme(AppTokens.light, Brightness.light),
          home: Scaffold(
            body: Center(
              child: ValueListenableBuilder<bool>(
                valueListenable: shown,
                builder: (_, on, _) => on
                    ? HoldToConfirmBar(
                        key: const Key('bar'),
                        label: 'Hold to hang up',
                        holdingLabel: 'Keep holding…',
                        busyLabel: 'Ending…',
                        semanticLabel: 'Hang up',
                        semanticHint: 'Press and hold to end the call',
                        onConfirmed: () async {
                          fired++;
                        },
                        confirmAccessibly: (_) async => false,
                      )
                    : const SizedBox.shrink(),
              ),
            ),
          ),
        ),
      );
      final finger = await tester.startGesture(tester.getCenter(find.byKey(const Key('bar'))));
      await tester.pump(const Duration(milliseconds: 200));
      shown.value = false;
      await tester.pump();
      expect(find.byKey(const Key('bar')), findsNothing);
      return finger;
    }

    testWidgets('lifting it does nothing', (tester) async {
      final finger = await holdThenRemove(tester);
      await finger.up();
      await tester.pump(const Duration(milliseconds: 600));
      expect(tester.takeException(), isNull);
      expect(fired, 0);
    });

    testWidgets('sliding it does nothing', (tester) async {
      final finger = await holdThenRemove(tester);
      await finger.moveBy(const Offset(0, 300));
      await tester.pump();
      expect(tester.takeException(), isNull);
      await finger.up();
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(fired, 0);
    });

    testWidgets('a cancelled pointer does nothing', (tester) async {
      final finger = await holdThenRemove(tester);
      await finger.cancel();
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(fired, 0);
    });
  });
}
