import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/softphone/softphone_copy.dart';
import 'package:magick_agency_agent/features/station/parts/layouts.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';

import '../softphone/softphone_harness.dart' as sp show pumpSoftphone, settle;
import '../softphone/softphone_harness.dart' show callView, caretRect, expectNoOverflow, setPhoneInsets;
import 'station_harness.dart';
import 'station_inbound_test.dart' show caller, inboundStation;

/// The on-screen keyboard over a station screen (`docs/mobile.md`, the station's screens), in the
/// app's shell (`ShellScaffold` nests the tab as `AppShell` does, with `ShellBody`): the page ends at
/// the keyboard's top, not a keyboard's height above it; the pinned actions stay, on the keyboard,
/// with the main one in view (AS1), taking at most part of the page; the note being typed keeps
/// real room, with its label and save status in view; and a refusal that comes while the agent
/// types is in view too.
///
/// A phone as the testers' (about 411×917 dp, a 330 dp keyboard) and two smaller ones, with a 24 dp
/// status bar and a 24 dp gesture bar at the bottom, and the app's own fonts (the test font draws
/// every glyph a full em wide, so its 200% text is far wider than a phone's).
const _statusBar = 24.0;
const _navBar = 24.0;
const _phones = [(size: Size(411, 917), keyboard: 330.0), (size: Size(360, 800), keyboard: 300.0), (size: Size(360, 640), keyboard: 300.0)];
const _refusal = 'Couldn’t end the call. You are still connected.';

/// The station page's scrolling content, as much of it as the agent can see.
Rect _visibleContent(WidgetTester tester, Size size, double keyboard) {
  final scroll = find.descendant(of: find.byType(StationPage), matching: find.byType(SingleChildScrollView)).first;
  return tester.getRect(scroll).intersect(Rect.fromLTRB(0, _statusBar, size.width, size.height - keyboard));
}

bool _inside(Rect outer, Rect inner) =>
    inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5 && inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;

/// The keyboard slides up over a few frames, as it does on a phone: each step is a metrics change
/// the shell and the page lay out for.
Future<void> _slideKeyboard(WidgetTester tester, {required double from, required double to}) async {
  for (var i = 1; i <= 4; i++) {
    setPhoneInsets(tester, statusBar: _statusBar, keyboard: from + (to - from) * i / 4, navBar: _navBar);
    await tester.pump(const Duration(milliseconds: 40));
  }
  await settle(tester);
  await settle(tester);
}

/// Focuses the note as a tap does, then the keyboard comes up over the bottom of the window.
Future<void> _openKeyboard(WidgetTester tester, Finder field, double keyboard) async {
  await tester.ensureVisible(field);
  await settle(tester);
  tester.state<EditableTextState>(find.descendant(of: field, matching: find.byType(EditableText))).requestKeyboard();
  await tester.pump();
  await _slideKeyboard(tester, from: 0, to: keyboard);
}

/// The note's label, its save status and its first line are in view and nothing covers them; the
/// line being typed (the caret) is in view in any case. Where the label cannot be shown with the
/// caret ([labelFits] false: see the sweep) it is a scroll away, and the caret line is shown.
void _expectNoteInView(WidgetTester tester, Rect visible, String labelText, {bool labelFits = true}) {
  final field = find.byKey(const Key('notes-field'));
  final caret = caretRect(tester, field);
  expect(_inside(visible, caret), isTrue, reason: 'the line being typed $caret is in view in $visible');
  expect(field.hitTestable(), findsOneWidget, reason: 'nothing covers the field');
  if (!labelFits) return;
  final label = find.descendant(of: find.byKey(const Key('notes-block')), matching: find.text(labelText));
  expect(label, findsOneWidget);
  expect(_inside(visible, tester.getRect(label)), isTrue, reason: 'the label ${tester.getRect(label)} is in view in $visible');
  expect(_inside(visible, tester.getRect(find.byKey(const Key('notes-status')))), isTrue, reason: 'the save status is in view');
  final fieldRect = tester.getRect(field);
  expect(fieldRect.top >= visible.top - 0.5 && fieldRect.top + 40 <= visible.bottom + 0.5, isTrue,
      reason: 'the field $fieldRect (its first line at least) is in view in $visible');
  expect(label.hitTestable(), findsOneWidget, reason: 'nothing covers the label');
}

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

  final timeOver = WrapupView(
    endsAt: t0.subtract(const Duration(seconds: 1)),
    secondsTotal: 30,
    hold: WrapupHold.none,
    dispositionSubmitted: false,
    autoReturn: true,
    redialRemaining: 2,
  );
  final screens = <({String name, StationView Function({String? error}) view, String label, String action, Future<void> Function(WidgetTester)? before})>[
    (
      name: 'What happened?, an outcome that needs a note',
      view: ({error}) => station(
        phase: AgentPhase.wrapup,
        call: call(bridgedAt: t0.subtract(const Duration(minutes: 3))),
        release: hungUpRelease,
        wrapup: wrapup(),
        actionError: error,
      ),
      label: StationCopy.notesRequired,
      action: 'save-outcome',
      before: (tester) async {
        await tester.ensureVisible(find.byKey(const Key('outcome-wrong')));
        await settle(tester);
        await tester.tap(find.byKey(const Key('outcome-wrong')));
        await settle(tester);
      },
    ),
    (
      // The testers' screen: Save & next call, Save & take break and Call again · 2 left.
      name: 'What happened?, Time is over, Call again · 2 left',
      view: ({error}) => station(
        phase: AgentPhase.wrapup,
        call: call(bridgedAt: t0.subtract(const Duration(minutes: 3))),
        release: hungUpRelease,
        wrapup: timeOver,
        actionError: error,
      ),
      label: StationCopy.notes,
      action: 'save-outcome',
      before: null,
    ),
    (
      name: 'On call',
      view: ({error}) => station(phase: AgentPhase.onCall, call: call(bridgedAt: t0.subtract(const Duration(minutes: 1))), actionError: error),
      label: StationCopy.notes,
      action: 'hang-up',
      before: null,
    ),
    (
      name: 'an inbound call',
      view: ({error}) => inboundStation(inbound: caller(stage: InboundStage.connected), actionError: error),
      label: StationCopy.notes,
      action: 'hang-up',
      before: null,
    ),
    (
      name: "an inbound call's outcome",
      view: ({error}) => inboundStation(inbound: caller(stage: InboundStage.outcome), actionError: error),
      label: StationCopy.notes,
      action: 'save-outcome',
      before: null,
    ),
  ];

  for (final phone in _phones) {
    final size = phone.size;
    final keyboard = phone.keyboard;
    for (final scale in const [1.0, 2.0]) {
      for (final s in screens) {
        testWidgets('${s.name}, ${size.width.round()}×${size.height.round()} with a ${keyboard.round()} dp keyboard, ${scale}x text: '
            'the page ends at the keyboard, the note and its label are in view, the main action stays, and a refusal shows',
            (tester) async {
          final h = await pumpStation(tester, s.view(), shell: true, statusBar: _statusBar, navBar: _navBar, size: size, textScale: scale);
          await settle(tester);
          await s.before?.call(tester);
          final action = find.byKey(Key(s.action));
          final actions = find.byKey(const Key('station-actions'));
          expect(action.hitTestable(), findsOneWidget, reason: 'the action is there before the keyboard');
          final bar = tester.getRect(find.byType(NavigationBar));
          expect(tester.getRect(find.byType(StationPage)).bottom, moreOrLessEquals(bar.top, epsilon: 0.5),
              reason: 'the page ends at the tab bar: the gesture bar is the tab bar\'s, not padding under the actions');
          final before = tester.getRect(action);

          final field = find.byKey(const Key('notes-field'));
          await _openKeyboard(tester, field, keyboard);
          await expectNoOverflow(tester);

          final editable = find.descendant(of: field, matching: find.byType(EditableText));
          expect(tester.widget<EditableText>(editable).focusNode.hasFocus, isTrue,
              reason: 'the page reshaping for the keyboard keeps the note (its focus, so the keyboard stays)');
          final keyboardTop = size.height - keyboard;
          final page = tester.getRect(find.byType(StationPage));
          expect(page.bottom, moreOrLessEquals(keyboardTop, epsilon: 0.5),
              reason: 'the page ends at the keyboard\'s top ($keyboardTop), not a keyboard\'s height above it: $page');
          var visible = _visibleContent(tester, size, keyboard);
          expect(visible.height, greaterThanOrEqualTo(100), reason: 'the content keeps real room over the keyboard: $visible');
          // The one case where the label does not fit with the line being typed: 360×640 with a
          // 300 dp keyboard leaves a 316 dp page, and at 200% text "Note (needed)" puts the save
          // status on a line of its own. The top bar (64), the whole of Save & next call on two
          // lines with the area's padding (140) and the label, the status and the line being typed
          // (125) need 329 dp.
          final labelFits = !(s.label == StationCopy.notesRequired && size.height < 700 && scale > 1.5);
          _expectNoteInView(tester, visible, s.label, labelFits: labelFits);

          // AS1: the main action stays, whole, on the keyboard, and takes a press; the area takes
          // at most its share of the page.
          final area = tester.getRect(actions);
          final main = tester.getRect(action);
          expect(_inside(area, main), isTrue, reason: 'the main action $main is whole in the actions $area');
          expect(main.bottom, lessThanOrEqualTo(keyboardTop + 0.5));
          expect(action.hitTestable(), findsOneWidget, reason: 'the main action takes a press with the keyboard up');
          expect(area.height + 24, lessThanOrEqualTo(page.height * StationActionArea.share + 0.5), reason: 'the actions take at most their share');

          // A refusal while the agent types: it shows, the main action stays, the note stays in view.
          await h.setView(s.view(error: _refusal));
          await settle(tester);
          await settle(tester);
          await expectNoOverflow(tester);
          final refusal = find.byKey(const Key('action-error'));
          final shown = tester.getRect(refusal).intersect(tester.getRect(find.byKey(const Key('action-error-scroll'))));
          expect(shown.height, greaterThanOrEqualTo(48), reason: 'the refusal is on screen while the keyboard is up: $shown');
          final words = tester.getRect(find.text(_refusal));
          expect(words.top >= shown.top && words.top + 20 <= shown.bottom, isTrue, reason: 'its first line $words shows in $shown');
          expect(find.text(_refusal).hitTestable(at: const Alignment(0, -0.6)), findsOneWidget, reason: 'nothing covers it');
          final mainNow = tester.getRect(action).intersect(tester.getRect(actions));
          expect(mainNow.height, greaterThanOrEqualTo(math.min(StationActionArea.mainRoom, main.height) - 0.5),
              reason: 'at least 64 dp of the main action (all of a one-line one) stays in view: $mainNow');
          expect(action.hitTestable(), findsOneWidget, reason: 'and it takes a press');
          visible = _visibleContent(tester, size, keyboard);
          expect(visible.height, greaterThanOrEqualTo(100), reason: 'the content keeps real room with the refusal: $visible');
          _expectNoteInView(tester, visible, s.label, labelFits: labelFits);
          expect(tester.widget<EditableText>(editable).focusNode.hasFocus, isTrue);

          // The keyboard goes down: the actions are where they were, on the tab bar.
          await h.setView(s.view());
          await settle(tester);
          await _slideKeyboard(tester, from: keyboard, to: 0);
          await expectNoOverflow(tester);
          expect(tester.getRect(action), before, reason: 'the main action is back in its place');
          expect(tester.getRect(find.byType(StationPage)).bottom, moreOrLessEquals(bar.top, epsilon: 0.5));
        });
      }
    }
  }

  testWidgets('a refused hang-up on an inbound call shows under the keyboard\'s top while the agent types', (tester) async {
    for (final phone in _phones) {
      for (final scale in const [1.0, 2.0]) {
        final size = phone.size;
        final h = await pumpStation(
          tester,
          inboundStation(inbound: caller(stage: InboundStage.connected)),
          shell: true,
          statusBar: _statusBar,
          navBar: _navBar,
          size: size,
          textScale: scale,
        );
        await settle(tester);
        await _openKeyboard(tester, find.byKey(const Key('notes-field')), phone.keyboard);
        await h.setView(inboundStation(inbound: caller(stage: InboundStage.connected, hangupFailure: 'We couldn’t end the call — you may still be connected.')));
        await settle(tester);
        await settle(tester);
        await expectNoOverflow(tester);
        final why = '${size.width.round()}×${size.height.round()}, ${scale}x';
        final failure = find.byKey(const Key('inbound-hangup-failure'));
        final area = tester.getRect(find.byKey(const Key('station-actions')));
        expect(tester.getRect(failure).intersect(area).height, greaterThanOrEqualTo(16), reason: '$why: the failure\'s first line shows');
        expect(_inside(area, tester.getRect(find.byKey(const Key('hang-up')))), isTrue, reason: '$why: End call stays whole');
        expect(find.byKey(const Key('hang-up')).hitTestable(), findsOneWidget);
        setPhoneInsets(tester, statusBar: _statusBar, navBar: _navBar);
        await settle(tester);
      }
    }
  });

  testWidgets('the band stays put with the keyboard up on a tall page, scrolls with the content on a short one, and stays for a hardware keyboard\'s strip', (tester) async {
    Finder bandInScroll() => find.descendant(
      of: find.descendant(of: find.byType(StationPage), matching: find.byType(SingleChildScrollView)).first,
      matching: find.byKey(const Key('band-title')),
    );
    final view = station(phase: AgentPhase.onCall, call: call(bridgedAt: t0.subtract(const Duration(minutes: 1))));

    await pumpStation(tester, view, shell: true, statusBar: _statusBar, navBar: _navBar, size: const Size(411, 917));
    await settle(tester);
    await _openKeyboard(tester, find.byKey(const Key('notes-field')), 330);
    expect(bandInScroll(), findsNothing, reason: '917 - 24 - 330 leaves room: the band and its clock stay pinned');
    expect(find.byKey(const Key('band-title')).hitTestable(), findsOneWidget);
    await _slideKeyboard(tester, from: 330, to: 0);

    await pumpStation(tester, view, shell: true, statusBar: _statusBar, navBar: _navBar, size: const Size(360, 800));
    await settle(tester);
    expect(bandInScroll(), findsNothing, reason: 'pinned while the keyboard is down');
    await _openKeyboard(tester, find.byKey(const Key('notes-field')), 300);
    expect(bandInScroll(), findsOneWidget, reason: '800 - 24 - 300 is short: the band scrolls with the content');
    await _slideKeyboard(tester, from: 300, to: 0);
    expect(bandInScroll(), findsNothing, reason: 'pinned again once the keyboard is down');

    // A hardware keyboard's suggestion strip is not the on-screen keyboard (100 dp or less): on a
    // 360×640 phone with three-button navigation (48 dp), a 50 dp strip over the buttons leaves a
    // page under 520 dp, and the band pinned.
    await pumpStation(tester, view, shell: true, statusBar: _statusBar, navBar: 48, size: const Size(360, 640));
    await settle(tester);
    expect(bandInScroll(), findsNothing, reason: 'pinned while the keyboard is down');
    final notes = find.byKey(const Key('notes-field'));
    await tester.ensureVisible(notes);
    await settle(tester);
    tester.state<EditableTextState>(find.descendant(of: notes, matching: find.byType(EditableText))).requestKeyboard();
    await tester.pump();
    setPhoneInsets(tester, statusBar: _statusBar, keyboard: 98, navBar: 48);
    await settle(tester);
    expect(tester.getRect(find.byType(StationPage)).height, lessThan(StationPage.keyboardShortPage));
    expect(bandInScroll(), findsNothing, reason: 'a strip over the buttons (98 dp) leaves the band pinned');
  });

  testWidgets('a follow-up sheet over the station sits on the keyboard, with no room left for the keyboard under it', (tester) async {
    const size = Size(411, 917);
    const keyboard = 330.0;
    await pumpStation(
      tester,
      station(
        phase: AgentPhase.wrapup,
        call: call(bridgedAt: t0.subtract(const Duration(minutes: 3))),
        release: hungUpRelease,
        wrapup: wrapup(),
        dispositionOptions: const [DispositionOption(code: 'ptp', label: 'Promised to pay', requiresPromise: true)],
      ),
      shell: true,
      statusBar: _statusBar,
      navBar: _navBar,
      size: size,
    );
    await settle(tester);
    await tester.tap(find.byKey(const Key('outcome-ptp')));
    await settle(tester);
    expect(find.byKey(const Key('follow-up-sheet')), findsOneWidget);
    await _openKeyboard(tester, find.byKey(const Key('promise-amount')), keyboard);
    await expectNoOverflow(tester);
    // Scrolled to its end, the sheet's last button sits its own padding above the keyboard.
    await tester.drag(find.byKey(const Key('follow-up-sheet')), const Offset(0, -2000));
    await settle(tester);
    final ok = tester.getRect(find.byKey(const Key('follow-up-ok')));
    expect(size.height - keyboard - ok.bottom, lessThanOrEqualTo(32),
        reason: 'the sheet ends at the keyboard; the OK button at $ok is not a keyboard\'s height above it');
    expect(find.byKey(const Key('promise-amount')).hitTestable(), findsOneWidget);
  });

  testWidgets("the soft phone's notes: with the keyboard up the label and the status line are in view with the box", (tester) async {
    for (final phone in _phones) {
      final size = phone.size;
      await sp.pumpSoftphone(
        tester,
        callView(SoftphonePhase.outcome, outcomeCode: 'wrong', outcomeDueAt: t0.add(const Duration(minutes: 2))),
        shell: true,
        statusBar: _statusBar,
        navBar: _navBar,
        size: size,
      );
      await sp.settle(tester);
      final field = find.byKey(const Key('softphone-notes-field'));
      await tester.ensureVisible(field);
      await sp.settle(tester);
      tester.state<EditableTextState>(find.descendant(of: field, matching: find.byType(EditableText))).requestKeyboard();
      await tester.pump();
      await _slideKeyboard(tester, from: 0, to: phone.keyboard);
      await expectNoOverflow(tester);

      final why = '${size.width.round()}×${size.height.round()}';
      final scroll = tester.getRect(find.byKey(const Key('softphone-scroll')));
      expect(scroll.bottom, lessThanOrEqualTo(size.height - phone.keyboard + 0.5));
      final visible = scroll.intersect(Rect.fromLTRB(0, _statusBar, size.width, size.height - phone.keyboard));
      expect(visible.height, greaterThanOrEqualTo(100), reason: '$why: the panel keeps real room: $visible');
      final label = find.descendant(of: find.byKey(const Key('softphone-notes')), matching: find.text(SoftphoneCopy.notesRequired));
      expect(label, findsOneWidget);
      expect(_inside(visible, tester.getRect(label)), isTrue, reason: '$why: the label ${tester.getRect(label)} is in view in $visible');
      expect(_inside(visible, tester.getRect(find.byKey(const Key('softphone-notes-status')))), isTrue, reason: why);
      expect(tester.getRect(field).top >= visible.top, isTrue, reason: why);
      setPhoneInsets(tester, statusBar: _statusBar, navBar: _navBar);
      await sp.settle(tester);
    }
  });

}
