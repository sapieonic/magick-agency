import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/features/missed/missed_call_tile.dart';
import 'package:magick_agency_agent/features/missed/missed_calls_copy.dart';

import 'support.dart';

/// One Missed row on the narrowest phone the app supports (360 × 640 dp): the
/// caller's number is never cut short by the reason pill or the DNC badge.
/// The app's own fonts are loaded, so widths are the ones a phone lays out
/// (the test font draws every glyph a full em wide).
void main() {
  setUpAll(() async {
    for (final (family, files) in [
      ('Inter', ['Inter-400', 'Inter-500', 'Inter-600', 'Inter-700']),
      ('JetBrainsMono', ['JetBrainsMono-400', 'JetBrainsMono-500']),
      ('PlusJakartaSans', ['PlusJakartaSans-600', 'PlusJakartaSans-700', 'PlusJakartaSans-800']),
    ]) {
      final loader = FontLoader(family);
      for (final f in files) {
        loader.addFont(Future.value(ByteData.sublistView(File('assets/fonts/$f.ttf').readAsBytesSync())));
      }
      await loader.load();
    }
  });

  Future<void> pumpTile(WidgetTester tester, Map<String, Object?> over, {double textScale = 1}) async {
    tester.view.physicalSize = const Size(1080, 1920);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(AppTokens.dark, Brightness.dark),
      builder: (context, app) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
        child: app!,
      ),
      home: Scaffold(
        body: SingleChildScrollView(
          child: MissedCallTile(
            call: missed('m1', over),
            now: fixedNow,
            userId: 'u1',
            callBackOffered: true,
            onCallBack: () {},
            onMarkHandled: () {},
          ),
        ),
      ),
    ));
  }

  RenderParagraph callerParagraph(WidgetTester tester) =>
      tester.renderObject<RenderParagraph>(find.descendant(of: find.byKey(const Key('missed-caller')), matching: find.byType(RichText)));

  // Every reason pill the row can show, with and without the DNC badge.
  final reasons = <String, Map<String, Object?>>{
    'Out of hours': {},
    'Inbound switched off': {'closed_cause': 'switched_off'},
    'Number not on a route': {'closed_cause': 'no_route'},
    'Phone line not active': {'closed_cause': 'credential_inactive'},
    'Hung up while waiting': {'reason': 'abandoned_in_queue', 'closed_cause': null},
    'Nobody free to answer': {'reason': 'overflow', 'closed_cause': null},
    'All lines busy': {'reason': 'overflow_no_capacity', 'closed_cause': null},
    'Couldn’t be answered': {'reason': 'failed', 'closed_cause': null},
  };

  for (final scale in [1.0, 2.0]) {
    for (final dnc in [false, true]) {
      for (final MapEntry(key: reason, value: over) in reasons.entries) {
        testWidgets('360 dp, text ×$scale${dnc ? ', DNC' : ''}: the whole number beside "$reason"', (tester) async {
          await pumpTile(tester, {...over, 'caller_dnc': dnc}, textScale: scale);
          expect(tester.widget<Text>(find.byKey(const Key('missed-caller'))).data, '+91 87654 32109');
          expect(MissedCopy.whyMissed(missed('x', over)), reason);
          expect(find.byKey(const Key('missed-dnc')), dnc ? findsOneWidget : findsNothing);
          expect(callerParagraph(tester).didExceedMaxLines, isFalse);
          expect(tester.takeException(), isNull);
        });
      }
    }
  }

  testWidgets('the reason pill sits at the row’s end', (tester) async {
    await pumpTile(tester, {});
    final row = tester.getRect(find.byKey(const ValueKey('missed-row-m1')));
    final pill = tester.getRect(find.byKey(const Key('missed-reason')));
    expect(row.right - pill.right, moreOrLessEquals(16)); // the row's padding
  });

  testWidgets('Call back is labelled for a screen reader with the caller, or why it is off', (tester) async {
    final handle = tester.ensureSemantics();
    await pumpTile(tester, {});
    expect(find.bySemanticsLabel('Call back +91 87654 32109'), findsOneWidget);
    await pumpTile(tester, {'from_e164': null});
    expect(find.bySemanticsLabel(MissedCopy.callBackWithheldLabel), findsOneWidget);
    handle.dispose();
  });
}
