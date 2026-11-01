import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/widgets/countdown_ring.dart';

import 'station_harness.dart';

/// The station's dialogs and sheets sit on the root navigator, above the
/// station, while the station swaps its body on every change of phase. These
/// tests move the stage under an open dialog (the harness's fakes behave like
/// the runtime: leave drops the station, a call ending moves to wrap-up), so a
/// dialog that outlives its call, or a flow that uses its widget after it is
/// gone, shows up here.
void main() {
  StationView onCall({String attemptId = 'a1', StationLink link = StationLink.open, AudioView audio = const AudioView()}) => station(
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

  group('Leave', () {
    for (final still in [false, true]) {
      testWidgets(
        'the station closes before leave() returns, and the agent still lands on the campaign list${still ? ' (reduced motion)' : ''}',
        (tester) async {
          final h = await pumpStation(tester, station(), disableAnimations: still);
          await tester.tap(find.byKey(const Key('leave')));
          await settle(tester);
          await tester.tap(find.widgetWithText(FilledButton, 'Leave station'));
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

  group('Break after this call', () {
    testWidgets('picked after the call ended (the chip is gone): still sent, and shown queued in wrap-up', (tester) async {
      final h = await pumpStation(tester, onCall());
      await tester.tap(find.byKey(const Key('break-after-call')));
      await settle(tester);
      await h.endCall();
      // The on-call screen (and the chip that opened the sheet) is gone; the sheet is not.
      expect(find.byKey(const Key('break-after-call')), findsNothing);
      expect(find.byKey(const Key('break-lunch')), findsOneWidget);
      await tester.tap(find.byKey(const Key('break-lunch')));
      await settle(tester);
      expect(tester.takeException(), isNull);
      expect(h.actions.args['takeBreak'], ['lunch']);

      // The server queues it behind the wrap-up; wrap-up says so and can cancel it.
      await h.setView(
        station(
          phase: AgentPhase.wrapup,
          call: call(bridgedAt: t0),
          release: hungUpRelease,
          wrapup: wrapup(),
          queuedBreak: const BreakInfo(code: 'lunch', label: 'Lunch'),
        ),
      );
      await settle(tester);
      expect(find.text('Break after this call — Lunch'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('cancel-queued-break')));
      await tester.tap(find.byKey(const Key('cancel-queued-break')));
      expect(h.actions.calls, contains('cancelQueuedBreak'));
    });

    testWidgets('wrap-up offers no new break, only shows a queued one', (tester) async {
      await pumpStation(tester, wrap());
      expect(find.byKey(const Key('break-after-call')), findsNothing);
      expect(find.byKey(const Key('queued-break')), findsNothing);
    });

    testWidgets('the sheet stays through wrap-up but closes when the next call arrives', (tester) async {
      final h = await pumpStation(tester, onCall());
      await tester.tap(find.byKey(const Key('break-after-call')));
      await settle(tester);
      await h.endCall();
      await h.setView(station());
      await settle(tester);
      expect(find.byKey(const Key('break-lunch')), findsOneWidget);
      await h.setView(
        station(
          phase: AgentPhase.reserved,
          call: call(countdown: 3, attemptId: 'a2'),
        ),
      );
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

    testWidgets('Mark DNC: the call ends while the dialog is open — it closes, marks nothing, and says so', (tester) async {
      final h = await pumpStation(tester, onCall());
      await tester.tap(find.byKey(const Key('control-dnc')));
      await settle(tester);
      expect(find.text('Stop calling this number?'), findsOneWidget);
      await h.endCall();
      await settle(tester);
      expect(find.text('Stop calling this number?'), findsNothing);
      expect(h.actions.calls, isNot(contains('markDnc')));
      expect(find.text('The call ended before Do Not Call was marked, so nothing was recorded.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Mark DNC confirmed in the instant the next call replaces it: the new customer is not marked', (tester) async {
      final h = await pumpStation(tester, onCall());
      await tester.tap(find.byKey(const Key('control-dnc')));
      await settle(tester);
      final confirm = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Don’t call in this campaign'));
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
      tester.semantics.tap(find.semantics.byLabel('Hang up'));
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
      expect(find.text('Save and stop calling this number?'), findsOneWidget);
      await h.setView(station());
      await settle(tester);
      expect(find.text('Save and stop calling this number?'), findsNothing);
      expect(h.actions.calls, isNot(contains('submitDisposition')));
      expect(tester.takeException(), isNull);
    });

    testWidgets('the callback time picker closes when the wrap-up ends, without throwing', (tester) async {
      final h = await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
      await tester.tap(find.byKey(const Key('outcome-callback')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('callback-picked')));
      await settle(tester);
      await tester.tap(find.text('31'));
      await tester.tap(find.text('OK'));
      await settle(tester);
      expect(find.byType(TimePickerDialog), findsOneWidget);
      // Wrap-up auto-returns the agent while the time picker is open.
      await h.setView(station());
      await settle(tester);
      expect(find.byType(TimePickerDialog), findsNothing);
      expect(tester.takeException(), isNull);
      expect(find.text('Waiting for a call'), findsOneWidget);
    });

    testWidgets('the callback date picker closes when the wrap-up ends', (tester) async {
      final h = await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
      await tester.tap(find.byKey(const Key('outcome-callback')));
      await tester.pump();
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

  group('no socket: Leave still works, Go and breaks wait for the link', () {
    Future<void> leaveFrom(WidgetTester tester, StationHarness h) async {
      final leave = tester.widget<TextButton>(find.byKey(const Key('leave')));
      expect(leave.onPressed, isNotNull);
      await tester.ensureVisible(find.byKey(const Key('leave')));
      await tester.tap(find.byKey(const Key('leave')));
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Leave station'));
      await settle(tester);
      await settle(tester);
      expect(h.actions.calls, contains('leave'));
      expect(find.text('campaigns-home'), findsOneWidget);
    }

    testWidgets('reconnecting while waiting', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.reconnecting));
      await tester.tap(find.byKey(const Key('take-break')), warnIfMissed: false);
      await settle(tester);
      expect(find.byKey(const Key('break-lunch')), findsNothing);
      await leaveFrom(tester, h);
    });

    testWidgets('disconnected while offline', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.disconnected, phase: AgentPhase.offline));
      await tester.tap(find.byKey(const Key('go-available')), warnIfMissed: false);
      expect(h.actions.calls, isNot(contains('goAvailable')));
      await leaveFrom(tester, h);
    });

    testWidgets('disconnected on a break', (tester) async {
      final h = await pumpStation(
        tester,
        station(
          link: StationLink.disconnected,
          phase: AgentPhase.onBreak,
          onBreak: BreakInfo(code: 'lunch', label: 'Lunch', since: t0),
        ),
      );
      await tester.tap(find.byKey(const Key('end-break')), warnIfMissed: false);
      expect(h.actions.calls, isNot(contains('endBreak')));
      await leaveFrom(tester, h);
    });

    testWidgets('disconnected on the away pause', (tester) async {
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
      await leaveFrom(tester, h);
    });

    testWidgets('still opening the station', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.connecting));
      expect(find.text('Opening your station…'), findsOneWidget);
      await leaveFrom(tester, h);
    });

    testWidgets('another action in flight does not hold Leave; a leave in flight does', (tester) async {
      final h = await pumpStation(tester, station(link: StationLink.reconnecting, busy: StationBusy.takingBreak));
      expect(tester.widget<TextButton>(find.byKey(const Key('leave'))).onPressed, isNotNull);
      await h.setView(station(link: StationLink.reconnecting, busy: StationBusy.leaving));
      await settle(tester);
      expect(tester.widget<TextButton>(find.byKey(const Key('leave'))).onPressed, isNull);
    });
  });

  testWidgets('destructive fills carry white text on the deep danger (contrast)', (tester) async {
    final h = await pumpStation(tester, onCall());
    Color? fill(Finder f) => tester.widget<FilledButton>(f).style!.backgroundColor!.resolve(const {});
    await tester.tap(find.byKey(const Key('control-dnc')));
    await settle(tester);
    expect(fill(find.widgetWithText(FilledButton, 'Don’t call in this campaign')), AppTokens.dark.dangerDeep);
    await tester.tap(find.text('Cancel'));
    await settle(tester);
    await h.setView(onCall(link: StationLink.disconnected));
    expect(fill(find.widgetWithText(FilledButton, 'Reconnect')), AppTokens.dark.dangerDeep);
    await h.setView(station(link: StationLink.disconnected));
    expect(fill(find.widgetWithText(FilledButton, 'Reconnect')), AppTokens.dark.dangerDeep);
  });

  testWidgets('the reconnect ring is drawn to the window the server granted', (tester) async {
    await pumpStation(
      tester,
      station(
        link: StationLink.reconnecting,
        phase: AgentPhase.onCall,
        call: call(bridgedAt: t0),
        reconnectDeadline: t0.add(const Duration(seconds: 10)),
        reconnectWindow: const Duration(seconds: 20),
      ),
    );
    final ring = tester.widget<CountdownRing>(find.byKey(const Key('reconnect-ring')));
    expect(ring.value, 10);
    expect(ring.fraction, closeTo(0.5, 0.001));
  });
}
