import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import 'station_harness.dart';

void main() {
  group('hold to hang up', () {
    StationView onCall({StationBusy busy = StationBusy.none}) => station(
      phase: AgentPhase.onCall,
      call: call(bridgedAt: t0),
      busy: busy,
    );

    testWidgets('a hold shorter than 500 ms does nothing', (tester) async {
      final h = await pumpStation(tester, onCall());
      final gesture = await tester.startGesture(tester.getCenter(find.byKey(const Key('hang-up'))));
      await tester.pump();
      expect(find.text('Keep holding…'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 480));
      await gesture.up();
      await tester.pump(const Duration(milliseconds: 300));
      expect(h.actions.count('hangUp'), 0);
      expect(find.text('Hold to hang up'), findsOneWidget);
    });

    testWidgets('a 500 ms hold fires once, with the finger still down', (tester) async {
      final h = await pumpStation(tester, onCall());
      final gesture = await tester.startGesture(tester.getCenter(find.byKey(const Key('hang-up'))));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 510));
      expect(h.actions.count('hangUp'), 1);
      // Holding on for two more seconds does not fire again.
      await tester.pump(const Duration(seconds: 2));
      await gesture.up();
      await tester.pump();
      expect(h.actions.count('hangUp'), 1);
      // Haptic tick on start, a heavier one on fire.
      expect(h.haptics, containsAllInOrder(['HapticFeedbackType.selectionClick', 'HapticFeedbackType.heavyImpact']));
    });

    testWidgets('sliding off the bar cancels the hold', (tester) async {
      final h = await pumpStation(tester, onCall());
      final bar = find.byKey(const Key('hang-up'));
      final gesture = await tester.startGesture(tester.getCenter(bar));
      await tester.pump(const Duration(milliseconds: 200));
      await gesture.moveTo(tester.getTopLeft(bar) - const Offset(0, 200));
      await tester.pump(const Duration(milliseconds: 600));
      await gesture.up();
      expect(h.actions.count('hangUp'), 0);
    });

    testWidgets('a hold the call ends under lets go without an error', (tester) async {
      // The customer hangs up first: the stage moves to wrap-up and the bar
      // leaves the screen with the agent's finger still on it. Reduced motion
      // takes the old stage out on the next frame; with the 220 ms fade the bar
      // stays mounted and armed, and whether the hold completes first would
      // turn on how the test's pumps line up with the 500 ms hold.
      final h = await pumpStation(tester, onCall(), disableAnimations: true);
      final gesture = await tester.startGesture(tester.getCenter(find.byKey(const Key('hang-up'))));
      await tester.pump(const Duration(milliseconds: 100));
      await h.endCall();
      expect(find.byKey(const Key('hang-up')), findsNothing);
      await gesture.up();
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(h.actions.count('hangUp'), 0);
    });

    testWidgets('works while ringing', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      final gesture = await tester.startGesture(tester.getCenter(find.byKey(const Key('hang-up'))));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 520));
      await gesture.up();
      expect(h.actions.count('hangUp'), 1);
    });

    testWidgets('while the core is hanging up the bar says Ending… and ignores holds', (tester) async {
      final h = await pumpStation(tester, onCall(busy: StationBusy.hangingUp));
      expect(find.text('Ending…'), findsOneWidget);
      final gesture = await tester.startGesture(tester.getCenter(find.byKey(const Key('hang-up'))));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      await gesture.up();
      expect(h.actions.count('hangUp'), 0);
    });

    testWidgets('screen readers confirm in a dialog instead of holding', (tester) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpStation(tester, onCall());
      final node = tester.getSemantics(find.byKey(const Key('hang-up')));
      expect(node.label, 'Hang up');
      expect(node.hint, 'Press and hold to end the call');
      tester.semantics.tap(find.semantics.byLabel('Hang up'));
      await settle(tester);
      expect(find.text('End this call?'), findsOneWidget);
      await tester.tap(find.text('Keep the call'));
      await settle(tester);
      expect(h.actions.count('hangUp'), 0);

      tester.semantics.tap(find.semantics.byLabel('Hang up'));
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Hang up'));
      await settle(tester);
      expect(h.actions.count('hangUp'), 1);
      semantics.dispose();
    });
  });

  group('announcements and haptics', () {
    testWidgets('a live region says each phase; ringing is also assertive', (tester) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpStation(tester, station(), supportsAnnounce: true);
      String said() => tester.getSemantics(find.byKey(const Key('phase-live-region'))).label;
      final region = tester.getSemantics(find.byKey(const Key('phase-live-region')));
      expect(region.flagsCollection.isLiveRegion, isTrue);

      await h.setView(station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      expect(said(), 'Ringing');
      expect(h.announcements, hasLength(1));
      expect((h.announcements.single! as Map)['data'], containsPair('assertiveness', 1));

      await h.setView(
        station(
          phase: AgentPhase.onCall,
          call: call(bridgedAt: t0),
        ),
      );
      expect(said(), 'On call');
      await h.setView(
        station(
          phase: AgentPhase.wrapup,
          call: call(bridgedAt: t0),
          release: hungUpRelease,
          wrapup: wrapup(),
        ),
      );
      expect(said(), 'Wrap-up');
      // Polite phases are not pushed as announcements: the live region says them.
      expect(h.announcements, hasLength(1));
      semantics.dispose();
    });

    testWidgets('heavy haptic on reserved, medium on bridged', (tester) async {
      final h = await pumpStation(tester, station());
      await h.setView(station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      expect(h.haptics, ['HapticFeedbackType.heavyImpact']);
      await h.setView(
        station(
          phase: AgentPhase.onCall,
          call: call(bridgedAt: t0),
        ),
      );
      expect(h.haptics, ['HapticFeedbackType.heavyImpact', 'HapticFeedbackType.mediumImpact']);
    });

    testWidgets('reduced motion: the phase switch has no transition', (tester) async {
      final h = await pumpStation(tester, station(), disableAnimations: true);
      h.container.read(h.holder.notifier).set(station(phase: AgentPhase.reserved, call: call()));
      await tester.pump();
      await tester.pump();
      expect(find.text('Waiting for a call'), findsNothing);
      expect(find.text('Ringing — get ready'), findsOneWidget);
    });
  });

  group('layout', () {
    Future<void> expectNoOverflow(WidgetTester tester) async {
      final errors = <FlutterErrorDetails>[];
      final old = FlutterError.onError;
      FlutterError.onError = errors.add;
      await tester.pump();
      FlutterError.onError = old;
      expect(errors, isEmpty);
      expect(tester.takeException(), isNull);
    }

    void expectOnScreen(WidgetTester tester, Finder f, {Size size = const Size(360, 640)}) {
      final r = tester.getRect(f);
      expect(r.top >= 0 && r.bottom <= size.height && r.left >= 0 && r.right <= size.width, isTrue, reason: '$f at $r');
    }

    testWidgets('on call at 200% text on 360×640: no overflow, hang-up on screen', (tester) async {
      await pumpStation(
        tester,
        station(
          phase: AgentPhase.onCall,
          call: call(bridgedAt: t0, recording: true),
          queuedBreak: const BreakInfo(code: 'lunch', label: 'Lunch'),
          audio: const AudioView(
            route: AudioRouteOption(id: 'b', kind: AudioRouteKind.bluetooth, name: 'boAt Airdopes 141'),
          ),
          actionError: 'Couldn’t end the call. You are still connected.',
        ),
        textScale: 2,
        size: const Size(360, 640),
      );
      await expectNoOverflow(tester);
      expectOnScreen(tester, find.byKey(const Key('hang-up')));
      // Every control is reachable by scrolling and at least 48 dp.
      for (final key in ['control-mute', 'control-audio', 'control-details', 'control-dnc']) {
        await tester.ensureVisible(find.byKey(Key(key)));
        await tester.pump();
        final s = tester.getSize(find.byKey(Key(key)));
        expect(s.width >= 48 && s.height >= 48, isTrue, reason: '$key is $s');
      }
      await expectNoOverflow(tester);
    });

    testWidgets('every phase survives 200% text on 360×640', (tester) async {
      final views = <StationView>[
        station(
          phaseSince: t0,
          dialing: false,
          missedRelease: const MissedReleaseView(headline: 'The customer hung up', detail: 'The call ended.'),
        ),
        station(phase: AgentPhase.offline, link: StationLink.disconnected),
        station(
          phase: AgentPhase.onBreak,
          onBreak: BreakInfo(code: 'device_away', label: 'Away', since: t0),
        ),
        station(
          phase: AgentPhase.reserved,
          call: call(countdown: 3),
          audio: const AudioView(micProblem: MicProblem.permissionDenied),
        ),
        station(
          phase: AgentPhase.onCall,
          call: call(bridgedAt: t0),
          link: StationLink.reconnecting,
          reconnectDeadline: t0.add(const Duration(seconds: 8)),
        ),
        station(
          phase: AgentPhase.onCall,
          call: call(bridgedAt: t0),
          audio: const AudioView(muted: true, interruption: AudioInterruption.phoneCall),
        ),
        station(
          phase: AgentPhase.wrapup,
          call: call(bridgedAt: t0),
          release: hungUpRelease,
          wrapup: wrapup(),
          actionError: 'That outcome is no longer available.',
        ),
        // Wrap-up redial: Redial beside Save, and the redial's own call.
        station(
          phase: AgentPhase.wrapup,
          call: call(bridgedAt: t0),
          release: hungUpRelease,
          wrapup: WrapupView(
            endsAt: t0.add(const Duration(seconds: 30)),
            secondsTotal: 30,
            hold: WrapupHold.none,
            dispositionSubmitted: false,
            autoReturn: true,
            redialRemaining: 2,
          ),
          actionError: 'This number is on a Do Not Call list, so it can’t be redialled. Save the outcome.',
        ),
        station(phase: AgentPhase.reserved, call: call(countdown: 3, redialNumber: 1, redialLimit: 2)),
        station(link: StationLink.superseded),
      ];
      final h = await pumpStation(tester, views.first, textScale: 2, size: const Size(360, 640));
      for (final v in views) {
        await h.setView(v);
        await expectNoOverflow(tester);
      }
      expectOnScreen(tester, find.byKey(const Key('use-this-phone')));
    });

    testWidgets('landscape tablet: content is a readable column', (tester) async {
      await pumpStation(
        tester,
        station(
          phase: AgentPhase.onCall,
          call: call(bridgedAt: t0),
        ),
        size: const Size(1280, 800),
      );
      expect(tester.getSize(find.byKey(const Key('hang-up'))).width, lessThanOrEqualTo(560));
    });

    testWidgets('light theme renders the call screens too', (tester) async {
      await pumpStation(
        tester,
        station(
          phase: AgentPhase.wrapup,
          call: call(bridgedAt: t0),
          release: hungUpRelease,
          wrapup: wrapup(),
        ),
        brightness: Brightness.light,
      );
      expect(find.byKey(const Key('save-outcome')), findsOneWidget);
    });

    testWidgets('call controls carry labels for screen readers', (tester) async {
      final semantics = tester.ensureSemantics();
      await pumpStation(
        tester,
        station(
          phase: AgentPhase.onCall,
          call: call(bridgedAt: t0),
          audio: const AudioView(muted: true),
        ),
      );
      final mute = tester.getSemantics(find.byKey(const Key('control-mute')));
      expect(mute.label, 'Mute');
      expect(mute.flagsCollection.isToggled, Tristate.isTrue);
      expect(tester.getSemantics(find.byKey(const Key('control-dnc'))).label, 'Mark DNC');
      semantics.dispose();
    });

    testWidgets('Redial says what it leaves to a screen reader, and when it is spent', (tester) async {
      final semantics = tester.ensureSemantics();
      WrapupView w(int remaining) => WrapupView(
        endsAt: t0.add(const Duration(seconds: 30)),
        secondsTotal: 30,
        hold: WrapupHold.none,
        dispositionSubmitted: false,
        autoReturn: true,
        redialRemaining: remaining,
      );
      StationView v(int remaining) =>
          station(phase: AgentPhase.wrapup, call: call(bridgedAt: t0), release: hungUpRelease, wrapup: w(remaining));
      final h = await pumpStation(tester, v(2));
      final node = tester.getSemantics(find.byKey(const Key('redial')));
      expect(node.label, 'Redial this customer, 2 redials left');
      expect(node.flagsCollection.isEnabled, Tristate.isTrue);
      await h.setView(v(0));
      final spent = tester.getSemantics(find.byKey(const Key('redial')));
      expect(spent.label, 'Redial, no redials left for this call');
      expect(spent.flagsCollection.isEnabled, Tristate.isFalse);
      semantics.dispose();
    });
  });
}
