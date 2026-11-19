import 'package:agency_wire/agency_wire.dart' show FeatureFlags;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show SemanticsNode;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/flags/feature_flags.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';
import 'package:magick_agency_agent/features/station/station_providers.dart';

import 'station_harness.dart';

/// Floor assist on the station screen (LF4, LF6; the app's LF35, LF38): Need help on a call and in
/// wrap-up behind the account's flag, its open, answered and refused states, and the break's
/// countdown against its reason's limit.
void main() {
  final onCall = station(phase: AgentPhase.onCall, call: call(bridgedAt: t0.subtract(const Duration(seconds: 30))));
  StationView inWrapup({HelpView help = const HelpView()}) =>
      station(phase: AgentPhase.wrapup, call: call(), release: hungUpRelease, wrapup: wrapup(), help: help);
  final open = HelpView(stage: HelpStage.open, raisedAt: t0.subtract(const Duration(seconds: 42)));

  test('follows the contract’s client flag', () {
    expect(FeatureFlags.floorAssistEnabled, 'agency_floor_assist_enabled');
    for (final on in [true, false]) {
      final container = ProviderContainer(overrides: [featureFlagProvider(FeatureFlags.floorAssistEnabled).overrideWithValue(on)]);
      addTearDown(container.dispose);
      expect(container.read(stationNeedHelpProvider), on);
    }
  });

  group('Need help', () {
    testWidgets('hidden while the account has floor assist off, on a call, in wrap-up and with a request open', (tester) async {
      for (final v in [onCall, inWrapup(), inWrapup(help: open)]) {
        await pumpStation(tester, v);
        expect(find.byKey(const Key('need-help-card')), findsNothing);
        expect(find.byKey(const Key('need-help')), findsNothing);
      }
    });

    testWidgets('offered on a call and in wrap-up; pressing it asks once', (tester) async {
      for (final v in [onCall, inWrapup()]) {
        final h = await pumpStation(tester, v, needHelp: true);
        expect(find.text(StationCopy.needHelp), findsOneWidget, reason: '${v.phase}');
        await tester.tap(find.byKey(const Key('need-help')));
        await tester.pump();
        expect(h.actions.count('raiseHelp'), 1);
      }
    });

    testWidgets('not offered while ringing, waiting or on a break', (tester) async {
      for (final v in [
        station(phase: AgentPhase.reserved, call: call()),
        station(),
        station(phase: AgentPhase.onBreak, onBreak: BreakInfo(code: 'tea', label: 'Tea break', since: t0)),
      ]) {
        await pumpStation(tester, v, needHelp: true);
        expect(find.byKey(const Key('need-help')), findsNothing, reason: '${v.phase}');
      }
    });

    testWidgets('asking: the button says so and cannot be pressed again', (tester) async {
      final h = await pumpStation(tester, inWrapup(help: const HelpView(stage: HelpStage.raising)), needHelp: true);
      expect(find.text(StationCopy.askingForHelp), findsOneWidget);
      await tester.tap(find.byKey(const Key('need-help')));
      await tester.pump();
      expect(h.actions.count('raiseHelp'), 0);
    });

    testWidgets('open: "Help requested", how long ago, ticking; Cancel withdraws it', (tester) async {
      final h = await pumpStation(tester, inWrapup(help: open), needHelp: true);
      expect(find.byKey(const Key('need-help')), findsNothing);
      expect(find.text(StationCopy.helpRequested), findsOneWidget);
      expect(find.text('Your supervisors can see it · asked 0:42 ago'), findsOneWidget);
      await h.advance(const Duration(seconds: 3));
      expect(find.text('Your supervisors can see it · asked 0:45 ago'), findsOneWidget);
      await tester.tap(find.byKey(const Key('cancel-help')));
      await tester.pump();
      expect(h.actions.count('cancelHelp'), 1);
    });

    testWidgets('a screen reader is told "Help requested" once: the ticking "asked … ago" is not in a live region', (tester) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpStation(tester, inWrapup(help: open), needHelp: true);
      final before = liveRegions(tester);
      expect(before, contains(StationCopy.helpRequested));
      await h.advance(const Duration(seconds: 3));
      expect(find.text('Your supervisors can see it · asked 0:45 ago'), findsOneWidget, reason: 'the clock did tick');
      final after = liveRegions(tester);
      expect(after, before, reason: 'a live region whose text changes is said again, every second');
      expect(after.where((l) => l.contains('ago')), isEmpty);
      semantics.dispose();
    });

    testWidgets('Cancel to a screen reader: a button that acts, then says it is cancelling and is disabled', (tester) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpStation(tester, inWrapup(help: open), needHelp: true);
      expect(tester.getSemantics(find.byKey(const Key('cancel-help'))), matchesSemantics(
        label: StationCopy.cancelHelpLabel,
        isButton: true,
        hasEnabledState: true,
        isEnabled: true,
        hasTapAction: true,
      ));
      tester.semantics.tap(find.semantics.byLabel(StationCopy.cancelHelpLabel));
      await tester.pump();
      expect(h.actions.count('cancelHelp'), 1, reason: 'the screen reader\'s double tap reaches it');
      await h.setView(inWrapup(help: HelpView(stage: HelpStage.cancelling, raisedAt: open.raisedAt)));
      expect(tester.getSemantics(find.byKey(const Key('cancel-help'))), matchesSemantics(
        label: StationCopy.cancellingHelpLabel,
        isButton: true,
        hasEnabledState: true,
        isEnabled: false,
      ));
      semantics.dispose();
    });

    testWidgets('cancelling: Cancel says so and cannot be pressed again', (tester) async {
      final h = await pumpStation(
        tester,
        inWrapup(help: HelpView(stage: HelpStage.cancelling, raisedAt: t0)),
        needHelp: true,
      );
      expect(find.text(StationCopy.cancellingHelp), findsOneWidget);
      await tester.tap(find.byKey(const Key('cancel-help')));
      await tester.pump();
      expect(h.actions.count('cancelHelp'), 0);
    });

    testWidgets('an open request raised in wrap-up stays in view after it, with Cancel, but no new button', (tester) async {
      final h = await pumpStation(tester, station(help: open), needHelp: true);
      expect(find.byKey(const Key('help-requested')), findsOneWidget);
      expect(find.byKey(const Key('need-help')), findsNothing);
      await tester.tap(find.byKey(const Key('cancel-help')));
      await tester.pump();
      expect(h.actions.count('cancelHelp'), 1);
    });

    testWidgets('the answer, in its tone, as a polite live region; Dismiss puts it away', (tester) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpStation(
        tester,
        inWrapup(help: const HelpView(notice: 'Anitha N is listening to your call.', noticeTone: HelpNoticeTone.success)),
        needHelp: true,
      );
      expect(find.text('Anitha N is listening to your call.'), findsOneWidget);
      // The button is back: a new request can be raised.
      expect(find.byKey(const Key('need-help')), findsOneWidget);
      final node = tester.getSemantics(find.text('Anitha N is listening to your call.'));
      expect(node.flagsCollection.isLiveRegion, isTrue);
      await tester.tap(find.descendant(of: find.byKey(const Key('help-notice')), matching: find.byIcon(Icons.close)));
      await tester.pump();
      expect(h.actions.count('dismissHelpNotice'), 1);
      // Between calls too.
      await h.setView(station(help: const HelpView(notice: 'x', noticeTone: HelpNoticeTone.warning)));
      expect(find.byKey(const Key('help-notice')), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('a refusal under the button, dismissible; the station\'s own error line untouched', (tester) async {
      final h = await pumpStation(tester, inWrapup(help: const HelpView(error: 'You can ask for help during a call, or while you finish one.')),
          needHelp: true);
      expect(find.byKey(const Key('help-error')), findsOneWidget);
      expect(find.byKey(const Key('action-error')), findsNothing);
      await tester.tap(find.descendant(of: find.byKey(const Key('help-error')), matching: find.byIcon(Icons.close)));
      await tester.pump();
      expect(h.actions.count('dismissHelpNotice'), 1);
    });

    testWidgets('48 dp targets, and a hint saying who will see it', (tester) async {
      final semantics = tester.ensureSemantics();
      await pumpStation(tester, onCall, needHelp: true);
      expect(tester.getSize(find.byKey(const Key('need-help'))).height, greaterThanOrEqualTo(48));
      expect(tester.getSemantics(find.byKey(const Key('need-help'))), matchesSemantics(
        label: StationCopy.needHelp,
        hint: StationCopy.needHelpHint,
        isButton: true,
        hasEnabledState: true,
        isEnabled: true,
        isFocusable: true,
        hasTapAction: true,
        hasFocusAction: true,
      ));
      semantics.dispose();
    });

    testWidgets('at 200% text on 360×640 it lays out with no overflow, open with a notice and an error', (tester) async {
      for (final v in [
        onCall,
        inWrapup(help: open.copyWithError('Your request couldn’t be cancelled. Check your connection and try again.')),
        station(help: const HelpView(notice: 'No supervisor answered within 15 minutes. Ask again if you still need help.',
            noticeTone: HelpNoticeTone.warning)),
      ]) {
        await pumpStation(tester, v, textScale: 2, size: const Size(360, 640), needHelp: true);
        expect(tester.takeException(), isNull, reason: '${v.phase}');
        expect(find.byKey(const Key('need-help-card')), findsOneWidget);
      }
    });
  });

  group('the break countdown (LF6)', () {
    BreakInfo tea({required Duration ago, int? limit = 15, String code = 'tea'}) =>
        BreakInfo(code: code, label: 'Tea break', since: t0.subtract(ago), limitMinutes: limit);

    testWidgets('counts down from the break\'s start to its limit', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 10, seconds: 30))));
      expect(find.text('On break for 10:30'), findsOneWidget);
      expect(find.text('4:30 left of your 15 min'), findsOneWidget);
      await h.advance(const Duration(seconds: 2));
      expect(find.text('4:28 left of your 15 min'), findsOneWidget);
      expect(find.byKey(const Key('break-over')), findsNothing);
    });

    testWidgets('past the limit it says over, in the warning tone, and keeps counting', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 14, seconds: 59))));
      expect(find.text('0:01 left of your 15 min'), findsOneWidget);
      await h.advance(const Duration(seconds: 3));
      expect(find.byKey(const Key('break-left')), findsNothing);
      expect(find.text('Over your 15 min break by 0:02'), findsOneWidget);
      final text = tester.widget<Text>(find.byKey(const Key('break-over')));
      final tokens = tester.element(find.byKey(const Key('break-over'))).tokens;
      expect(text.style!.color, tokens.warning);
      expect(find.byIcon(Icons.schedule), findsOneWidget);
    });

    testWidgets('time left rounds up: a millisecond past a whole second still shows that second, and "0:00 left" never shows',
        (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 10, seconds: 30, milliseconds: 1))));
      expect(find.text('4:30 left of your 15 min'), findsOneWidget);
      await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 14, seconds: 59, milliseconds: 999))));
      expect(find.text('0:01 left of your 15 min'), findsOneWidget);
      // At the limit itself it is over, by nothing yet.
      await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 15))));
      expect(find.byKey(const Key('break-left')), findsNothing);
      expect(find.text('Over your 15 min break by 0:00'), findsOneWidget);
    });

    testWidgets('none on a break whose reason has no limit, nor on a reserved one', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 3), limit: null)));
      expect(find.byKey(const Key('break-left')), findsNothing);
      expect(find.byKey(const Key('break-over')), findsNothing);
      expect(find.text('On break for 03:00'), findsOneWidget);
      await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 3), limit: null, code: 'device_away')));
      expect(find.byKey(const Key('break-left')), findsNothing);
    });

    testWidgets('at 200% text on 360×640, over the limit, no overflow', (tester) async {
      await pumpStation(
        tester,
        station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 47, seconds: 5), limit: 30)),
        textScale: 2,
        size: const Size(360, 640),
      );
      expect(tester.takeException(), isNull);
      expect(find.text('Over your 30 min break by 17:05'), findsOneWidget);
    });
  });
}

/// The text of every live region on screen.
List<String> liveRegions(WidgetTester tester) {
  final out = <String>[];
  void walk(SemanticsNode n) {
    if (n.getSemanticsData().flagsCollection.isLiveRegion) out.add(n.label);
    n.visitChildren((c) {
      walk(c);
      return true;
    });
  }

  walk(tester.binding.renderViews.first.owner!.semanticsOwner!.rootSemanticsNode!);
  return out;
}

extension on HelpView {
  HelpView copyWithError(String error) => HelpView(stage: stage, raisedAt: raisedAt, notice: notice, noticeTone: noticeTone, error: error);
}

