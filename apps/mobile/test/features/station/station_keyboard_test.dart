import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/softphone/softphone_copy.dart';
import 'package:magick_agency_agent/features/station/parts/layouts.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';

import '../softphone/softphone_harness.dart' as sp show pumpSoftphone, settle;
import '../softphone/softphone_harness.dart' show callView, expectNoOverflow;
import 'station_harness.dart';
import 'station_inbound_test.dart' show caller, inboundStation;

/// The on-screen keyboard over a station screen (`docs/mobile.md`, the station's screens): while
/// the agent types a note, the page is given to the note. The pinned actions are hidden (they come
/// back as the keyboard goes down) and the note's label and status line are in view with the
/// field, not squashed under the band with the actions riding on the keyboard.
///
/// On a real phone: a 24 dp status bar, the shell's tab bar, and a 300 dp keyboard.
const _keyboard = 300.0;
const _statusBar = 24.0;

/// The station page's scrolling content, as much of it as the agent can see.
Rect _visibleContent(WidgetTester tester, Size size, double keyboard) {
  final scroll = find.descendant(of: find.byType(StationPage), matching: find.byType(SingleChildScrollView)).first;
  return tester.getRect(scroll).intersect(Rect.fromLTRB(0, _statusBar, size.width, size.height - keyboard));
}

bool _inside(Rect outer, Rect inner) =>
    inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5 && inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;

/// Focuses the note as a tap does, then the keyboard comes up over the bottom of the window.
Future<void> _openKeyboard(WidgetTester tester, Finder field) async {
  await tester.ensureVisible(field);
  await settle(tester);
  tester.state<EditableTextState>(find.descendant(of: field, matching: find.byType(EditableText))).requestKeyboard();
  await tester.pump();
  tester.view.viewInsets = FakeViewPadding(bottom: _keyboard * tester.view.devicePixelRatio);
  await settle(tester);
  await settle(tester);
}

Future<void> _closeKeyboard(WidgetTester tester) async {
  tester.view.viewInsets = FakeViewPadding.zero;
  await settle(tester);
}

void main() {
  final screens = <({String name, StationView view, String label, String action, Future<void> Function(WidgetTester)? before})>[
    (
      name: 'What happened?, an outcome that needs a note',
      view: station(phase: AgentPhase.wrapup, call: call(bridgedAt: t0.subtract(const Duration(minutes: 3))), release: hungUpRelease, wrapup: wrapup()),
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
      name: 'What happened?, Time is over',
      view: station(
        phase: AgentPhase.wrapup,
        call: call(bridgedAt: t0.subtract(const Duration(minutes: 3))),
        release: hungUpRelease,
        wrapup: wrapup(endsAt: t0.subtract(const Duration(seconds: 1))),
      ),
      label: StationCopy.notes,
      action: 'save-outcome',
      before: null,
    ),
    (
      name: 'On call',
      view: station(phase: AgentPhase.onCall, call: call(bridgedAt: t0.subtract(const Duration(minutes: 1)))),
      label: StationCopy.notes,
      action: 'hang-up',
      before: null,
    ),
    (
      name: 'an inbound call',
      view: inboundStation(inbound: caller(stage: InboundStage.connected)),
      label: StationCopy.notes,
      action: 'hang-up',
      before: null,
    ),
    (
      name: "an inbound call's outcome",
      view: inboundStation(inbound: caller(stage: InboundStage.outcome)),
      label: StationCopy.notes,
      action: 'save-outcome',
      before: null,
    ),
  ];

  for (final size in const [Size(360, 800), Size(360, 640)]) {
    for (final scale in const [1.0, 2.0]) {
      for (final s in screens) {
        testWidgets('${s.name}, ${size.width.round()}×${size.height.round()}, ${scale}x text: with the keyboard up the note and its label '
            'are in view and the actions hidden; with it down the actions are back', (tester) async {
          await pumpStation(tester, s.view, shell: true, statusBar: _statusBar, size: size, textScale: scale);
          await settle(tester);
          await s.before?.call(tester);
          final action = find.byKey(Key(s.action));
          expect(action.hitTestable(), findsOneWidget, reason: 'the action is there before the keyboard');

          final field = find.byKey(const Key('notes-field'));
          await _openKeyboard(tester, field);
          await expectNoOverflow(tester);

          final editable = find.descendant(of: field, matching: find.byType(EditableText));
          expect(tester.widget<EditableText>(editable).focusNode.hasFocus, isTrue,
              reason: 'the page reshaping for the keyboard keeps the note (its focus, so the keyboard stays)');
          final visible = _visibleContent(tester, size, _keyboard);
          expect(visible.height, greaterThan(100), reason: 'the content keeps real room over the keyboard: $visible');
          final label = find.descendant(of: find.byKey(const Key('notes-block')), matching: find.text(s.label));
          expect(label, findsOneWidget);
          expect(_inside(visible, tester.getRect(label)), isTrue, reason: 'the label ${tester.getRect(label)} is in view in $visible');
          expect(_inside(visible, tester.getRect(find.byKey(const Key('notes-status')))), isTrue, reason: 'the save status is in view');
          final fieldRect = tester.getRect(field);
          expect(fieldRect.top >= visible.top && fieldRect.top + 40 <= visible.bottom, isTrue,
              reason: 'the field $fieldRect (its first line at least) is in view in $visible');
          expect(label.hitTestable(), findsOneWidget, reason: 'nothing covers the label');
          expect(field.hitTestable(), findsOneWidget, reason: 'nothing covers the field');
          expect(action.hitTestable(), findsNothing, reason: 'the pinned actions are hidden while the keyboard is up');

          await _closeKeyboard(tester);
          await expectNoOverflow(tester);
          expect(action.hitTestable(), findsOneWidget, reason: 'the actions are back as the keyboard goes down');
          final bar = tester.getRect(find.byType(NavigationBar));
          expect(tester.getRect(action).bottom <= bar.top, isTrue, reason: 'the action is on screen, above the tab bar');
        });
      }
    }
  }

  testWidgets('the band stays put with the keyboard up on a tall page, and scrolls with the content on a short one', (tester) async {
    Finder bandInScroll() => find.descendant(
      of: find.descendant(of: find.byType(StationPage), matching: find.byType(SingleChildScrollView)).first,
      matching: find.byKey(const Key('band-title')),
    );
    final view = station(phase: AgentPhase.onCall, call: call(bridgedAt: t0.subtract(const Duration(minutes: 1))));

    await pumpStation(tester, view, shell: true, statusBar: _statusBar, size: const Size(390, 844));
    await settle(tester);
    await _openKeyboard(tester, find.byKey(const Key('notes-field')));
    expect(bandInScroll(), findsNothing, reason: '844 - 24 - 300 leaves room: the band and its clock stay pinned');
    expect(find.byKey(const Key('band-title')).hitTestable(), findsOneWidget);
    await _closeKeyboard(tester);

    await pumpStation(tester, view, shell: true, statusBar: _statusBar, size: const Size(360, 640));
    await settle(tester);
    expect(bandInScroll(), findsNothing, reason: 'pinned while the keyboard is down');
    await _openKeyboard(tester, find.byKey(const Key('notes-field')));
    expect(bandInScroll(), findsOneWidget, reason: '640 - 24 - 300 is short: the band scrolls with the content');
    await _closeKeyboard(tester);
    expect(bandInScroll(), findsNothing, reason: 'pinned again once the keyboard is down');
  });

  testWidgets("the soft phone's notes: with the keyboard up the label and the status line are in view with the box", (tester) async {
    const size = Size(390, 844);
    await sp.pumpSoftphone(
      tester,
      callView(SoftphonePhase.outcome, outcomeCode: 'wrong', outcomeDueAt: t0.add(const Duration(minutes: 2))),
      shell: true,
      statusBar: _statusBar,
      size: size,
    );
    await sp.settle(tester);
    final field = find.byKey(const Key('softphone-notes-field'));
    await tester.ensureVisible(field);
    await sp.settle(tester);
    tester.state<EditableTextState>(find.descendant(of: field, matching: find.byType(EditableText))).requestKeyboard();
    await tester.pump();
    tester.view.viewInsets = FakeViewPadding(bottom: _keyboard * tester.view.devicePixelRatio);
    await sp.settle(tester);
    await sp.settle(tester);

    final visible = tester.getRect(find.byKey(const Key('softphone-scroll'))).intersect(Rect.fromLTRB(0, _statusBar, size.width, size.height - _keyboard));
    final label = find.descendant(of: find.byKey(const Key('softphone-notes')), matching: find.text(SoftphoneCopy.notesRequired));
    expect(label, findsOneWidget);
    expect(_inside(visible, tester.getRect(label)), isTrue, reason: 'the label ${tester.getRect(label)} is in view in $visible');
    expect(_inside(visible, tester.getRect(find.byKey(const Key('softphone-notes-status')))), isTrue);
    expect(tester.getRect(field).top >= visible.top, isTrue);
  });
}
