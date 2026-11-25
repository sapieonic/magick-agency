import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/session/local_preferences.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';

import 'station_harness.dart';

void main() {
  group('slide to end call (AS3)', () {
    StationView onCall({StationBusy busy = StationBusy.none}) => station(
      phase: AgentPhase.onCall,
      call: call(bridgedAt: t0),
      busy: busy,
    );

    testWidgets('a slide short of the end does nothing, and the knob springs back', (tester) async {
      final h = await pumpStation(tester, onCall());
      await slideToEnd(tester, fraction: 0.5);
      await settle(tester);
      expect(h.actions.count('hangUp'), 0);
      expect(find.text(StationCopy.slideToEnd), findsOneWidget);
      final track = tester.getRect(find.byKey(const Key('hang-up')));
      expect(tester.getRect(find.byKey(const Key('slide-knob'))).left, lessThan(track.left + 16));
    });

    testWidgets('a full slide fires once, with a tick as it starts and a heavier one as it fires', (tester) async {
      final h = await pumpStation(tester, onCall());
      final r = tester.getRect(find.byKey(const Key('hang-up')));
      final gesture = await tester.startGesture(Offset(r.left + 32, r.center.dy));
      for (var i = 0; i < 12; i++) {
        await gesture.moveBy(Offset(r.width / 10, 0));
        await tester.pump();
      }
      expect(h.actions.count('hangUp'), 1);
      // Dragging on does not fire again.
      await gesture.moveBy(Offset(-r.width / 2, 0));
      await gesture.moveBy(Offset(r.width / 2, 0));
      await gesture.up();
      await tester.pump();
      expect(h.actions.count('hangUp'), 1);
      expect(h.haptics, containsAllInOrder(['HapticFeedbackType.selectionClick', 'HapticFeedbackType.heavyImpact']));
    });

    testWidgets('an up-and-down swipe over it does nothing', (tester) async {
      final h = await pumpStation(tester, onCall());
      final bar = find.byKey(const Key('hang-up'));
      await tester.dragFrom(tester.getCenter(bar), const Offset(0, -200));
      await settle(tester);
      expect(h.actions.count('hangUp'), 0);
    });

    testWidgets('a slide the call ends under lets go without an error', (tester) async {
      // The customer hangs up first: the stage moves to What happened? and the control leaves the
      // screen with the agent's finger still on it.
      final h = await pumpStation(tester, onCall(), disableAnimations: true);
      final r = tester.getRect(find.byKey(const Key('hang-up')));
      final gesture = await tester.startGesture(Offset(r.left + 32, r.center.dy));
      await gesture.moveBy(Offset(r.width / 4, 0));
      await tester.pump(const Duration(milliseconds: 100));
      await h.endCall();
      expect(find.byKey(const Key('hang-up')), findsNothing);
      await gesture.moveBy(Offset(r.width, 0));
      await gesture.up();
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(h.actions.count('hangUp'), 0);
    });

    testWidgets('Call coming has no End call at all (AS11)', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      expect(find.byKey(const Key('hang-up')), findsNothing);
    });

    testWidgets('while the core is ending the call it says Ending… and ignores slides', (tester) async {
      final h = await pumpStation(tester, onCall(busy: StationBusy.hangingUp));
      expect(find.text(StationCopy.ending), findsOneWidget);
      await slideToEnd(tester);
      await settle(tester);
      expect(h.actions.count('hangUp'), 0);
    });

    testWidgets('screen readers confirm in a dialog instead of sliding', (tester) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpStation(tester, onCall());
      final node = tester.getSemantics(find.byKey(const Key('hang-up')));
      expect(node.label, StationCopy.endCall);
      expect(node.hint, StationCopy.endCallHint);
      tester.semantics.tap(find.semantics.byLabel(StationCopy.endCall));
      await settle(tester);
      expect(find.text('End this call?'), findsOneWidget);
      await tester.tap(find.text('Keep the call'));
      await settle(tester);
      expect(h.actions.count('hangUp'), 0);

      tester.semantics.tap(find.semantics.byLabel(StationCopy.endCall));
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, StationCopy.endCall));
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
      expect(said(), 'Call coming');
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
      expect(said(), 'What happened?');
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

    testWidgets('Me → Vibration off: no haptic when a call arrives or connects; on again, read at the moment, they buzz', (tester) async {
      final h = await pumpStation(tester, station());
      await h.container.read(localPreferencesProvider.notifier).setHaptics(false);
      await h.setView(station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      await h.setView(station(phase: AgentPhase.onCall, call: call(bridgedAt: t0)));
      expect(h.haptics, isEmpty);
      await h.setView(station());
      await h.container.read(localPreferencesProvider.notifier).setHaptics(true);
      await h.setView(station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      await h.setView(station(phase: AgentPhase.onCall, call: call(bridgedAt: t0)));
      expect(h.haptics, ['HapticFeedbackType.heavyImpact', 'HapticFeedbackType.mediumImpact']);
    });

    testWidgets('reduced motion: the phase switch has no transition', (tester) async {
      final h = await pumpStation(tester, station(), disableAnimations: true);
      h.container.read(h.holder.notifier).set(station(phase: AgentPhase.reserved, call: call()));
      await tester.pump();
      await tester.pump();
      expect(find.text(StationCopy.nextCallComing), findsNothing);
      expect(find.text(StationCopy.callComing), findsOneWidget);
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
      for (final key in ['control-mute', 'control-audio', 'control-details']) {
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
          missedRelease: const MissedReleaseView(headline: 'While your internet was down, the customer hung up.'),
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
      expect(mute.label, StationCopy.unmute);
      expect(mute.flagsCollection.isToggled, Tristate.isTrue);
      expect(tester.getSemantics(find.byKey(const Key('control-audio'))).label, startsWith(StationCopy.speaker));
      semantics.dispose();
    });

    testWidgets('Call again says what it leaves to a screen reader, and is gone when it is spent', (tester) async {
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
      expect(node.label, 'Call again · 2 left');
      expect(node.flagsCollection.isEnabled, Tristate.isTrue);
      await h.setView(v(0));
      expect(find.byKey(const Key('redial')), findsNothing);
      semantics.dispose();
    });
  });
}
