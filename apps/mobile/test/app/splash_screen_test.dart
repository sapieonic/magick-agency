import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/splash_screen.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';

class _Gate extends AppGateNotifier {
  _Gate(this.initial);
  final AppGate initial;
  int retries = 0;

  @override
  AppGate build() => initial;

  @override
  void retryNow() => retries++;
}

Future<_Gate> _pump(WidgetTester tester, AppGate gate) async {
  final fake = _Gate(gate);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [appGateProvider.overrideWith(() => fake)],
      child: MaterialApp(theme: buildTheme(AppTokens.dark, Brightness.dark), home: const SplashScreen()),
    ),
  );
  await tester.pump();
  return fake;
}

void main() {
  testWidgets('a plain start-up shows only the mark and the spinner', (tester) async {
    await _pump(tester, const GateLoading());
    expect(find.byKey(const Key('splash-notice')), findsNothing);
    expect(find.byKey(const Key('splash-retry')), findsNothing);
  });

  testWidgets('offline start-up says so and Try again retries at once', (tester) async {
    final gate = await _pump(tester, const GateLoading(notice: 'Can’t reach the server. Retrying…'));
    expect(find.text('Can’t reach the server. Retrying…'), findsOneWidget);
    await tester.tap(find.byKey(const Key('splash-retry')));
    expect(gate.retries, 1);
  });
}
