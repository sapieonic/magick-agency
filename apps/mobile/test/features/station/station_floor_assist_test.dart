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

    testWidgets('offered on every working screen (AS5): ready, a call coming, on a break, not yet taking calls', (tester) async {
      for (final v in [
        station(phase: AgentPhase.reserved, call: call()),
        station(),
        station(dialing: false),
        station(phase: AgentPhase.onBreak, onBreak: BreakInfo(code: 'tea', label: 'Tea break', since: t0)),
        station(phase: AgentPhase.offline),
      ]) {
        final h = await pumpStation(tester, v, needHelp: true);
        expect(find.byKey(const Key('need-help')), findsOneWidget, reason: '${v.phase}');
        await tester.tap(find.byKey(const Key('need-help')));
        await tester.pump();
        expect(h.actions.count('raiseHelp'), 1, reason: '${v.phase}');
      }
    });

    testWidgets('a server that refused a raise off a call (older than BE-9): offered on calls only again', (tester) async {
      const narrowed = HelpView(onlyOnCall: true);
      for (final v in [
        station(help: narrowed),
        station(phase: AgentPhase.reserved, call: call(), help: narrowed),
        station(phase: AgentPhase.onBreak, onBreak: BreakInfo(code: 'tea', label: 'Tea break', since: t0), help: narrowed),
      ]) {
        await pumpStation(tester, v, needHelp: true);
        expect(find.byKey(const Key('need-help')), findsNothing, reason: '${v.phase}');
      }
      for (final v in [onCall, inWrapup()]) {
        await pumpStation(tester, station(phase: v.phase, call: v.call, release: v.release, wrapup: v.wrapup, help: narrowed), needHelp: true);
        expect(find.byKey(const Key('need-help')), findsOneWidget, reason: '${v.phase}');
      }
    });

    testWidgets('asking: the button says so and cannot be pressed again', (tester) async {
      final h = await pumpStation(tester, inWrapup(help: const HelpView(stage: HelpStage.raising)), needHelp: true);
      expect(find.text(StationCopy.askingForHelp), findsOneWidget);
      await tester.tap(find.byKey(const Key('need-help')));
      await tester.pump();
      expect(h.actions.count('raiseHelp'), 0);
    });

    testWidgets('open: the button turns solid red, "Help asked · 0:42", ticking; pressing it again cancels', (tester) async {
      final h = await pumpStation(tester, inWrapup(help: open), needHelp: true);
      expect(find.byKey(const Key('need-help')), findsNothing);
      expect(find.text('Help asked · 0:42'), findsOneWidget);
      await h.advance(const Duration(seconds: 3));
      expect(find.text('Help asked · 0:45'), findsOneWidget);
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
      expect(find.text('Help asked · 0:45'), findsOneWidget, reason: 'the clock did tick');
      final after = liveRegions(tester);
      expect(after, before, reason: 'a live region whose text changes is said again, every second');
      expect(after.where((l) => l.contains('0:4')), isEmpty);
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

    testWidgets('an open request stays in view between calls, with Cancel, and no second button', (tester) async {
      final h = await pumpStation(tester, station(help: open), needHelp: true);
      expect(find.byKey(const Key('cancel-help')), findsOneWidget);
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

    testWidgets('answered with a message, on a break: Need help is back and pressing it asks again', (tester) async {
      final h = await pumpStation(
        tester,
        station(
          phase: AgentPhase.onBreak,
          onBreak: BreakInfo(code: 'tea', label: 'Tea break', since: t0),
          help: const HelpView(notice: 'Reshma Mohammad answered with a message.', noticeTone: HelpNoticeTone.success),
        ),
        needHelp: true,
      );
      expect(find.text('Reshma Mohammad answered with a message.'), findsOneWidget);
      expect(find.byKey(const Key('cancel-help')), findsNothing);
      expect(tester.widget<OutlinedButton>(find.byKey(const Key('need-help'))).onPressed, isNotNull);
      await tester.tap(find.byKey(const Key('need-help')));
      await tester.pump();
      expect(h.actions.count('raiseHelp'), 1);
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
        expect(find.byKey(const Key('need-help')).evaluate().length + find.byKey(const Key('need-help-card')).evaluate().length, greaterThan(0));
      }
    });
  });

  group('the break against its limit (LF6; 07, 08)', () {
    BreakInfo tea({required Duration ago, int? limit = 15, String code = 'tea'}) =>
        BreakInfo(code: code, label: 'Tea break', since: t0.subtract(ago), limitMinutes: limit);

    testWidgets('counts the time used against the limit, and what is left', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 10, seconds: 30))));
      expect(find.text('10:30'), findsWidgets);
      expect(find.text('4:30 left of your 15 minutes.'), findsOneWidget);
      await h.advance(const Duration(seconds: 2));
      expect(find.text('4:28 left of your 15 minutes.'), findsOneWidget);
      expect(find.byKey(const Key('break-over')), findsNothing);
      expect(find.byKey(const Key('band-tone-onBreak')), findsOneWidget);
    });

    testWidgets('past the limit the screen turns red-orange: Break time is over, how late, and keeps counting (08)', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 14, seconds: 59))));
      expect(find.text('0:01 left of your 15 minutes.'), findsOneWidget);
      await h.advance(const Duration(seconds: 3));
      expect(find.byKey(const Key('break-left')), findsNothing);
      expect(find.byKey(const Key('band-tone-over')), findsOneWidget);
      expect(find.text(StationCopy.breakTimeOver), findsOneWidget);
      expect(find.text('You are 0:02 late. Start calls now.'), findsOneWidget);
      expect(find.text('Your break was 15 minutes. Your supervisor can see this.'), findsOneWidget);
      final text = tester.widget<Text>(find.byKey(const Key('break-over')));
      final over = tester.element(find.byKey(const Key('break-over'))).stateTokens.over;
      expect(text.style!.color, over.deep);
      // Colour is never the only signal: an icon and words change with it.
      expect(find.byIcon(Icons.warning_amber_rounded), findsOneWidget);
      expect(find.byKey(const Key('end-break')), findsOneWidget);
    });

    testWidgets('time left rounds up: a millisecond past a whole second still shows that second, and "0:00 left" never shows',
        (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 10, seconds: 30, milliseconds: 1))));
      expect(find.text('4:30 left of your 15 minutes.'), findsOneWidget);
      await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 14, seconds: 59, milliseconds: 999))));
      expect(find.text('0:01 left of your 15 minutes.'), findsOneWidget);
      // At the limit itself it is over, by nothing yet.
      await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 15))));
      expect(find.byKey(const Key('break-left')), findsNothing);
      expect(find.text('You are 0:00 late. Start calls now.'), findsOneWidget);
    });

    testWidgets('none on a break whose reason has no limit, nor on a reserved one', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.onBreak, onBreak: tea(ago: const Duration(minutes: 3), limit: null)));
      expect(find.byKey(const Key('break-left')), findsNothing);
      expect(find.byKey(const Key('break-over')), findsNothing);
      expect(find.text('3:00'), findsWidgets);
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
      expect(find.text('You are 17:05 late. Start calls now.'), findsOneWidget);
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

