import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';
import 'package:magick_agency_agent/features/station/widgets/action_buttons.dart';

import 'station_harness.dart';

/// The station's dialogs and sheets sit on the root navigator, above the
/// station, while the station swaps its body on every change of phase. These
/// tests move the stage under an open dialog (the harness's fakes behave like
/// the runtime: leave drops the station, a call ending moves to wrap-up), so a
/// dialog that outlives its call, or a flow that uses its widget after it is
/// gone, shows up here.
void main() {
  // A campaign whose outcomes have no Don't call again tile: the call offers it (design-spec §6.2).
  final noDncTile = dispositions.where((d) => !d.suppresses).toList();

  StationView onCall({String attemptId = 'a1', StationLink link = StationLink.open, AudioView audio = const AudioView()}) => station(
    dispositionOptions: noDncTile,
    link: link,
    phase: AgentPhase.onCall,
    call: call(
      bridgedAt: t0.subtract(const Duration(seconds: 40)),
      attemptId: attemptId,
      phone: attemptId == 'a1' ? '+919840012345' : '+919876500000',
    ),
    audio: audio,
  );

  StationView wrap({String attemptId = 'a1'}) => station(
    phase: AgentPhase.wrapup,
    call: call(bridgedAt: t0.subtract(const Duration(minutes: 3)), attemptId: attemptId),
    release: hungUpRelease,
    wrapup: wrapup(),
  );

  group('Finish work', () {
    for (final still in [false, true]) {
      testWidgets(
        'the station closes before leave() returns, and the agent still lands on the campaign list${still ? ' (reduced motion)' : ''}',
        (tester) async {
          final h = await pumpStation(tester, station(), disableAnimations: still);
          await tapMore(tester, 'leave');
          await tester.tap(find.byKey(const Key('finish-yes')));
          // Frame by frame, as on a phone: the station's switch finishes (and
          // the button that asked is gone) before leave() returns.
          for (var i = 0; i < 30; i++) {
            await tester.pump(const Duration(milliseconds: 50));
          }
          expect(h.actions.calls, containsAllInOrder(['dismissActionError', 'leave']));
          expect(h.view, isNull); // the fake dropped the station, as the runtime does
          expect(tester.takeException(), isNull);
          expect(find.text('campaigns-home'), findsOneWidget);
          expect(find.byKey(const Key('not-here')), findsNothing);
        },
      );
    }
  });

  group('Save & break', () {
    testWidgets('a break picked after What happened? has gone is still sent, and nothing is saved twice', (tester) async {
      final h = await pumpStation(tester, wrap());
      await tester.tap(find.byKey(const Key('outcome-interested')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('save-and-break')));
      await settle(tester);
      // The server saved the picked tile when the time ran out, and the agent is ready again.
      await h.setView(station());
      await settle(tester);
      expect(find.byKey(const Key('break-lunch')), findsOneWidget);
      await tester.tap(find.byKey(const Key('break-lunch')));
      await settle(tester);
      expect(tester.takeException(), isNull);
      expect(h.actions.args['takeBreak'], ['lunch']);
      expect(h.actions.calls, isNot(contains('submitDisposition')));
    });

    testWidgets('a break booked for after this call shows on What happened?, and ✕ cancels it', (tester) async {
      final h = await pumpStation(
        tester,
        station(
          phase: AgentPhase.wrapup,
          call: call(bridgedAt: t0),
          release: hungUpRelease,
          wrapup: wrapup(),
          queuedBreak: const BreakInfo(code: 'lunch', label: 'Lunch'),
        ),
      );
      expect(find.text('Lunch after this call'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('cancel-queued-break')));
      await tester.tap(find.byKey(const Key('cancel-queued-break')));
      expect(h.actions.calls, contains('cancelQueuedBreak'));
    });

    testWidgets('What happened? offers no break chip, only shows a queued one', (tester) async {
      await pumpStation(tester, wrap());
      expect(find.byKey(const Key('break-after-call')), findsNothing);
      expect(find.byKey(const Key('queued-break')), findsNothing);
    });

    testWidgets('Which break? stays after What happened? but closes when the next call arrives', (tester) async {
      final h = await pumpStation(tester, wrap());
      await tester.tap(find.byKey(const Key('outcome-interested')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('save-and-break')));
      await settle(tester);
      await h.setView(station());
      await settle(tester);
      expect(find.byKey(const Key('break-lunch')), findsOneWidget);
      await h.setView(station(phase: AgentPhase.reserved, call: call(countdown: 3, attemptId: 'a2')));
      await settle(tester);
      expect(find.byKey(const Key('break-lunch')), findsNothing);
      expect(tester.takeException(), isNull);
      expect(h.actions.calls, isNot(contains('takeBreak')));
    });
  });

  group('dialogs close with the call they were opened for', () {
    testWidgets('Details closes when another call replaces this one', (tester) async {
      final h = await pumpStation(tester, onCall());
      await tester.tap(find.byKey(const Key('control-details')));
      await settle(tester);
      expect(find.byKey(const Key('details-sheet')), findsOneWidget);
      expect(find.text('Priya Raman · Attempt 2'), findsOneWidget);
      await h.setView(onCall(attemptId: 'a2'));
      await settle(tester);
      expect(find.byKey(const Key('details-sheet')), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Details closes when the call ends', (tester) async {
      final h = await pumpStation(tester, onCall());
      await tester.tap(find.byKey(const Key('control-details')));
      await settle(tester);
      await h.endCall();
      expect(find.byKey(const Key('details-sheet')), findsNothing);
      expect(find.byKey(const Key('band-wrapup')), findsOneWidget);
    });

    testWidgets('Don\'t call again: the call ends while the sheet is open — it closes, marks nothing, and says so', (tester) async {
      final h = await pumpStation(tester, onCall());
      await tester.ensureVisible(find.byKey(const Key('control-dnc')));
      await tester.tap(find.byKey(const Key('control-dnc')));
      await settle(tester);
      expect(find.text(StationCopy.stopCallingTitle), findsOneWidget);
      await h.endCall();
      await settle(tester);
      expect(find.text(StationCopy.stopCallingTitle), findsNothing);
      expect(h.actions.calls, isNot(contains('markDnc')));
      expect(find.text('The call ended before Do Not Call was marked, so nothing was recorded.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Don\'t call again confirmed in the instant the next call replaces it: the new customer is not marked', (tester) async {
      final h = await pumpStation(tester, onCall());
      await tester.ensureVisible(find.byKey(const Key('control-dnc')));
      await tester.tap(find.byKey(const Key('control-dnc')));
      await settle(tester);
      final confirm = tester.widget<MainActionButton>(find.byKey(const Key('confirm-yes')));
      h.container.read(h.holder.notifier).set(onCall(attemptId: 'a2'));
      confirm.onPressed!(); // the tap lands before the dialog has closed itself
      await settle(tester);
      expect(h.actions.calls, isNot(contains('markDnc')));
      expect(find.byKey(const Key('dnc-not-marked')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the audio sheet closes with the call and switches nothing', (tester) async {
      const phone = AudioRouteOption(id: 'p', kind: AudioRouteKind.earpiece, name: 'Phone');
      const buds = AudioRouteOption(id: 'b', kind: AudioRouteKind.bluetooth, name: 'Buds');
      final h = await pumpStation(
        tester,
        onCall(
          audio: const AudioView(route: buds, routes: [phone, buds]),
        ),
      );
      await tester.tap(find.byKey(const Key('control-audio')));
      await settle(tester);
      expect(find.byKey(const Key('route-p')), findsOneWidget);
      await h.endCall();
      expect(find.byKey(const Key('route-p')), findsNothing);
      expect(h.actions.calls, isNot(contains('setRoute')));
      expect(tester.takeException(), isNull);
    });

    testWidgets('the screen-reader hang-up confirm closes when the call ends', (tester) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpStation(tester, onCall());
      tester.semantics.tap(find.semantics.byLabel(StationCopy.endCall));
      await settle(tester);
      expect(find.text('End this call?'), findsOneWidget);
      await h.endCall();
      expect(find.text('End this call?'), findsNothing);
      expect(h.actions.count('hangUp'), 0);
      expect(tester.takeException(), isNull);
      semantics.dispose();
    });

    testWidgets('the suppress confirm closes when the wrap-up ends, and saves nothing', (tester) async {
      final h = await pumpStation(tester, wrap());
      await tester.tap(find.byKey(const Key('outcome-dnc')));
      await tester.pump();
      await tester.ensureVisible(find.byKey(const Key('save-outcome')));
      await tester.tap(find.byKey(const Key('save-outcome')));
      await settle(tester);
      expect(find.text(StationCopy.stopCallingTitle), findsOneWidget);
      await h.setView(station());
      await settle(tester);
      expect(find.text(StationCopy.stopCallingTitle), findsNothing);
      expect(h.actions.calls, isNot(contains('submitDisposition')));
      expect(tester.takeException(), isNull);
    });

    testWidgets('the callback time picker closes when the wrap-up ends, without throwing', (tester) async {
      final h = await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
      await tester.tap(find.byKey(const Key('outcome-callback')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('callback-picked')));
      await settle(tester);
      await tester.tap(find.text('31'));
      await tester.tap(find.text('OK').last);
      await settle(tester);
      expect(find.byType(TimePickerDialog), findsOneWidget);
      // Wrap-up auto-returns the agent while the time picker is open: it and the sheet close.
      await h.setView(station());
      await settle(tester);
      expect(find.byType(TimePickerDialog), findsNothing);
      expect(find.byKey(const Key('follow-up-sheet')), findsNothing);
      expect(tester.takeException(), isNull);
      expect(find.text(StationCopy.nextCallComing), findsOneWidget);
    });

    testWidgets('the callback date picker closes when the wrap-up ends', (tester) async {
      final h = await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
      await tester.tap(find.byKey(const Key('outcome-callback')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('callback-picked')));
      await settle(tester);
      expect(find.byType(DatePickerDialog), findsOneWidget);
      await h.setView(station());
      await settle(tester);
      expect(find.byType(DatePickerDialog), findsNothing);
      expect(find.byType(TimePickerDialog), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  group('no line: Finish work still works, Start work and breaks wait for it', () {
    Future<void> finishFrom(WidgetTester tester, StationHarness h, {bool fromMenu = true}) async {
      if (fromMenu) {
        await tapMore(tester, 'leave');
      } else {
        await tester.ensureVisible(find.byKey(const Key('leave')));
        await tester.tap(find.byKey(const Key('leave')));
        await settle(tester);
      }
      await tester.tap(find.byKey(const Key('finish-yes')));
      await settle(tester);
      await settle(tester);
      expect(h.actions.calls, contains('leave'));
      expect(find.text('campaigns-home'), findsOneWidget);
    }

    testWidgets('reconnecting while ready: Internet problem, no break, trying again by itself (09)', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.reconnecting));
      expect(find.byKey(const Key('band-internet-problem')), findsOneWidget);
      expect(find.text(StationCopy.internetProblemSubtitle), findsOneWidget);
      expect(find.text(StationCopy.stepCallSupervisor), findsOneWidget);
      expect(find.byKey(const Key('take-break')), findsNothing);
      expect(find.byKey(const Key('reconnect')), findsNothing, reason: 'still trying: no button that restarts it');
      expect(find.byKey(const Key('trying-again')), findsOneWidget);
      await finishFrom(tester, h);
    });

    testWidgets('disconnected while not taking calls: Try again now reconnects', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.disconnected, phase: AgentPhase.offline));
      expect(find.byKey(const Key('go-available')), findsNothing);
      await tester.tap(find.byKey(const Key('reconnect')));
      expect(h.actions.calls, ['reconnect']);
      await finishFrom(tester, h);
    });

    testWidgets('disconnected on a break: Internet problem, and Start calls again waits', (tester) async {
      final h = await pumpStation(
        tester,
        station(
          link: StationLink.disconnected,
          phase: AgentPhase.onBreak,
          onBreak: BreakInfo(code: 'lunch', label: 'Lunch', since: t0),
        ),
      );
      expect(find.byKey(const Key('band-internet-problem')), findsOneWidget);
      expect(find.byKey(const Key('end-break')), findsNothing);
      await finishFrom(tester, h);
    });

    testWidgets('disconnected on the away pause: Paused stays, its Start calls again waits', (tester) async {
      final h = await pumpStation(
        tester,
        station(
          link: StationLink.disconnected,
          phase: AgentPhase.onBreak,
          onBreak: BreakInfo(code: 'device_away', label: 'Away', since: t0),
        ),
      );
      await tester.tap(find.byKey(const Key('resume')), warnIfMissed: false);
      expect(h.actions.calls, isNot(contains('endBreak')));
      await finishFrom(tester, h);
    });

    testWidgets('still getting ready', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.connecting));
      expect(find.text(StationCopy.connecting), findsOneWidget);
      await finishFrom(tester, h, fromMenu: false);
    });

    testWidgets('another action in flight does not hold Finish work; a leave in flight does', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.connecting, busy: StationBusy.takingBreak));
      expect(tester.widget<QuietActionButton>(find.byKey(const Key('leave'))).onPressed, isNotNull);
      await h.setView(station(link: StationLink.connecting, busy: StationBusy.leaving));
      await settle(tester);
      expect(tester.widget<QuietActionButton>(find.byKey(const Key('leave'))).onPressed, isNull);
    });
  });

  testWidgets('stop fills (Yes, stop calls; Try again now on a call) are the stop red, with white text', (tester) async {
    final h = await pumpStation(tester, onCall());
    final stop = StateTokens.light.stop;
    await tester.ensureVisible(find.byKey(const Key('control-dnc')));
    await tester.tap(find.byKey(const Key('control-dnc')));
    await settle(tester);
    expect(tester.widget<MainActionButton>(find.byKey(const Key('confirm-yes'))).kind, ActionKind.stop);
    Color? fill(Finder f) => tester.widget<FilledButton>(find.descendant(of: f, matching: find.byType(FilledButton))).style!.backgroundColor!.resolve(const {});
    expect(fill(find.byKey(const Key('confirm-yes'))), stop);
    await tester.tap(find.byKey(const Key('confirm-no')));
    await settle(tester);
    await h.setView(onCall(link: StationLink.disconnected));
    expect(fill(find.byKey(const Key('reconnect'))), stop);
  });

  testWidgets('Call problem (10): the customer card stays, and the call is kept for the time the server granted', (tester) async {
    final h = await pumpStation(
      tester,
      station(
        link: StationLink.reconnecting,
        phase: AgentPhase.onCall,
        call: call(bridgedAt: t0),
        reconnectDeadline: t0.add(const Duration(seconds: 10)),
        reconnectWindow: const Duration(seconds: 20),
      ),
    );
    expect(find.byKey(const Key('band-tone-problem')), findsOneWidget);
    expect(find.text(StationCopy.callProblem), findsOneWidget);
    expect(find.text('Call is kept for 0:10'), findsOneWidget);
    expect(find.text('Priya Raman'), findsOneWidget);
    expect(find.byKey(const Key('call-problem-steps')), findsOneWidget);
    await h.advance(const Duration(seconds: 3));
    expect(find.text('Call is kept for 0:07'), findsOneWidget);
  });
}
