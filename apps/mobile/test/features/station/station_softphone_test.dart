import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/softphone_host.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/softphone/softphone_panel.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';
import 'package:magick_agency_agent/features/station/station_screen.dart';

import '../softphone/softphone_harness.dart' show callView, expectEveryPanelPhaseFits, readyView, sweepTextScales;
import 'station_harness.dart';

/// The station switched to the soft phone (SP7), and the ways onto it.

const softphoneBreak = BreakInfo(code: 'soft_phone', label: 'Soft phone');
const queuedSwitch = BreakInfo(code: 'soft_phone', label: 'Soft phone');

StationView onSoftphone() => station(phase: AgentPhase.onBreak, onBreak: softphoneBreak);

bool canPop(WidgetTester tester) => tester.widget<PopScope>(find.byType(PopScope).first).canPop;

void main() {
  group('stationStageOf', () {
    test('the soft-phone break is its own stage; other breaks and the pause are not', () {
      expect(stationStageOf(onSoftphone(), 'c1'), StationStage.softphone);
      expect(
        stationStageOf(station(phase: AgentPhase.onBreak, onBreak: const BreakInfo(code: 'tea', label: 'Tea')), 'c1'),
        StationStage.onBreak,
      );
      expect(
        stationStageOf(station(phase: AgentPhase.onBreak, onBreak: const BreakInfo(code: 'device_away', label: 'Away')), 'c1'),
        StationStage.away,
      );
      // A session-level failure still outranks it.
      expect(
        stationStageOf(station(phase: AgentPhase.onBreak, onBreak: softphoneBreak, link: StationLink.superseded), 'c1'),
        StationStage.superseded,
      );
    });
  });

  group('on the soft phone (break/soft_phone)', () {
    testWidgets('the station renders the soft-phone panel in place, without End break or the break menu', (tester) async {
      final h = await pumpStation(tester, onSoftphone(), softphone: readyView(), availability: softphoneOn);
      await settle(tester);

      final panel = tester.widget<SoftphonePanel>(find.byType(SoftphonePanel));
      expect(panel.surface, SoftphoneSurface.station);
      expect(find.byKey(const Key('softphone-return')), findsOneWidget);
      expect(find.byKey(const Key('end-break')), findsNothing);
      expect(find.byKey(const Key('take-break')), findsNothing);
      expect(find.byKey(const Key('switch-softphone')), findsNothing);
      expect(find.text(StationCopy.endBreak), findsNothing);

      await tester.tap(find.byKey(const Key('softphone-return')));
      await settle(tester);
      expect(h.softphoneActions.calls, contains('returnToCampaign'));
      expect(h.actions.calls, isNot(contains('endBreak')));
    });

    testWidgets('Return to campaign is disabled, with the reason, while the outcome is owed', (tester) async {
      await pumpStation(tester, onSoftphone(), softphone: callView(SoftphonePhase.outcome), availability: softphoneOn);
      await settle(tester);

      final button = tester.widget<OutlinedButton>(find.byKey(const Key('softphone-return')));
      expect(button.onPressed, isNull);
      expect(find.byKey(const Key('softphone-exit-reason')), findsOneWidget);
      expect(find.text('Finish this call and save its outcome first.'), findsWidgets);
    });

    testWidgets('the back gesture cannot take a soft-phone call off screen; idle, it can', (tester) async {
      final h = await pumpStation(tester, onSoftphone(), softphone: readyView(), availability: softphoneOn);
      await settle(tester);
      expect(canPop(tester), isTrue);

      await h.setSoftphone(callView(SoftphonePhase.ringing));
      expect(canPop(tester), isFalse);
      await h.setSoftphone(callView(SoftphonePhase.outcome));
      expect(canPop(tester), isFalse, reason: 'an owed outcome is still a call on screen');
      await h.setSoftphone(readyView());
      expect(canPop(tester), isTrue);
    });

    testWidgets('shown in place whatever the flag says: only the switch to it needs the flag', (tester) async {
      await pumpStation(tester, onSoftphone(), softphone: readyView(finishOnly: true));
      await settle(tester);
      expect(find.byType(SoftphonePanel), findsOneWidget);
    });

    // The same panel inside the station's own Scaffold, on a 360×640 phone
    // with a status bar, the shell's bar and the keyboard up or down.
    for (final keyboard in [0.0, 300.0]) {
      for (final scale in sweepTextScales) {
        testWidgets('${scale}x text, keyboard ${keyboard.round()} dp on 360×640: every phase fits, the caret and the action stay visible', (
          tester,
        ) async {
          const size = Size(360, 640);
          final h = await pumpStation(
            tester,
            onSoftphone(),
            softphone: readyView(),
            availability: softphoneOn,
            shell: true,
            statusBar: 24,
            keyboard: keyboard,
            textScale: scale,
            size: size,
          );
          await settle(tester);
          await expectEveryPanelPhaseFits(tester, h.setSoftphone, size: size, statusBar: 24, keyboard: keyboard);
        });
      }
    }
  });

  group('Switch to soft phone', () {
    testWidgets('waiting: offered while the soft phone may start calls, and applied by the host', (tester) async {
      final h = await pumpStation(tester, station(), availability: softphoneOn);
      expect(find.byKey(const Key('switch-softphone')), findsOneWidget);
      expect(find.text(StationCopy.switchToSoftphone), findsOneWidget);

      await tester.tap(find.byKey(const Key('switch-softphone')));
      await settle(tester);
      expect(h.host.calls, ['switchToSoftphone']);
      expect(h.actions.calls, isNot(contains('takeBreak')));
    });

    testWidgets('on a break: offered beside End break', (tester) async {
      final h = await pumpStation(
        tester,
        station(phase: AgentPhase.onBreak, onBreak: const BreakInfo(code: 'tea', label: 'Tea break')),
        availability: softphoneOn,
      );
      expect(find.byKey(const Key('end-break')), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('switch-softphone')));
      await tester.tap(find.byKey(const Key('switch-softphone')));
      await settle(tester);
      expect(h.host.count('switchToSoftphone'), 1);
    });

    testWidgets('not offered while the soft phone cannot start calls (hidden, or finish mode)', (tester) async {
      final h = await pumpStation(tester, station());
      expect(find.byKey(const Key('switch-softphone')), findsNothing);

      h.container.read(h.availability.notifier).set(const SoftphoneAvailability(visible: true, loaded: true));
      await settle(tester);
      expect(find.byKey(const Key('switch-softphone')), findsNothing);

      h.container.read(h.availability.notifier).set(softphoneOn);
      await settle(tester);
      expect(find.byKey(const Key('switch-softphone')), findsOneWidget);
    });

    testWidgets('a refusal is said; nothing changed', (tester) async {
      final h = await pumpStation(tester, station(), availability: softphoneOn);
      h.host.switchResult = const SoftphoneSwitchRefused('Couldn’t change your status just now; nothing changed. Try again.');
      await tester.tap(find.byKey(const Key('switch-softphone')));
      await settle(tester);
      expect(find.byKey(const Key('switch-refused')), findsOneWidget);
      expect(find.text('Couldn’t change your status just now; nothing changed. Try again.'), findsOneWidget);
    });

    testWidgets('the break sheet offers it, at once while waiting', (tester) async {
      final h = await pumpStation(tester, station(), availability: softphoneOn);
      await tester.tap(find.byKey(const Key('take-break')));
      await settle(tester);
      expect(find.byKey(const Key('break-switch-softphone')), findsOneWidget);
      expect(find.text(StationCopy.switchHint), findsOneWidget);

      await tester.tap(find.byKey(const Key('break-switch-softphone')));
      await settle(tester);
      expect(h.host.calls, ['switchToSoftphone']);
      expect(h.actions.calls, isNot(contains('takeBreak')));
    });

    testWidgets('during a call the break-sheet entry is queued: it says so, and the host queues it', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.onCall, call: call()), availability: softphoneOn);
      h.host.switchResult = const SoftphoneSwitchQueued();
      await tester.ensureVisible(find.byKey(const Key('break-after-call')));
      await tester.tap(find.byKey(const Key('break-after-call')));
      await settle(tester);
      expect(find.text(StationCopy.breakSheetQueued), findsOneWidget);
      expect(find.text(StationCopy.switchAfterCallHint), findsOneWidget);

      await tester.tap(find.byKey(const Key('break-switch-softphone')));
      await settle(tester);
      expect(h.host.calls, ['switchToSoftphone']);
      expect(h.actions.calls, isNot(contains('takeBreak')));
    });

    testWidgets('the break sheet leaves it out while the soft phone cannot start calls', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.onCall, call: call()));
      await tester.ensureVisible(find.byKey(const Key('break-after-call')));
      await tester.tap(find.byKey(const Key('break-after-call')));
      await settle(tester);
      expect(find.byKey(const Key('break-switch-softphone')), findsNothing);
      expect(find.byKey(const Key('break-lunch')), findsOneWidget);
    });
  });

  group('the queued switch', () {
    testWidgets('on a call the pill reads "Switching after this call", and its ✕ withdraws the switch', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.onCall, call: call(), queuedBreak: queuedSwitch));
      await tester.ensureVisible(find.byKey(const Key('queued-break')));
      expect(find.text('Switching after this call'), findsOneWidget);
      expect(find.byTooltip(StationCopy.cancelSwitch), findsOneWidget);
      expect(find.byKey(const Key('break-after-call')), findsNothing, reason: 'the queue holds one break');

      await tester.tap(find.byKey(const Key('cancel-queued-break')));
      await settle(tester);
      expect(h.host.calls, ['cancelSwitch']);
      expect(h.actions.calls, isNot(contains('cancelQueuedBreak')));
    });

    testWidgets('in wrap-up the pill stays, with the same words', (tester) async {
      await pumpStation(
        tester,
        station(phase: AgentPhase.wrapup, call: call(), release: hungUpRelease, wrapup: wrapup(), queuedBreak: queuedSwitch),
      );
      await tester.ensureVisible(find.byKey(const Key('queued-break')));
      expect(find.text('Switching after this call'), findsOneWidget);
    });

    testWidgets('a queued ordinary break keeps its own words and cancel', (tester) async {
      final h = await pumpStation(
        tester,
        station(phase: AgentPhase.onCall, call: call(), queuedBreak: const BreakInfo(code: 'tea', label: 'Tea break')),
      );
      await tester.ensureVisible(find.byKey(const Key('queued-break')));
      expect(find.text(StationCopy.breakQueued('Tea break')), findsOneWidget);
      await tester.tap(find.byKey(const Key('cancel-queued-break')));
      await settle(tester);
      expect(h.actions.calls, contains('cancelQueuedBreak'));
      expect(h.host.calls, isEmpty);
    });

    testWidgets('a refused withdrawal is said', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.onCall, call: call(), queuedBreak: queuedSwitch));
      h.host.cancelResult = const SoftphoneSwitchRefused('You’re already on the soft phone.');
      await tester.ensureVisible(find.byKey(const Key('queued-break')));
      await tester.tap(find.byKey(const Key('cancel-queued-break')));
      await settle(tester);
      expect(find.text('You’re already on the soft phone.'), findsOneWidget);
    });
  });
}
