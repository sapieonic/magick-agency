import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import 'station_harness.dart';

/// Wrap-up redial on the station screen: the Redial button beside the
/// outcome pad, and the live call's "Redial 1 of 2".

WrapupView _wrapup({int? remaining, bool submitted = false}) => WrapupView(
  endsAt: t0.add(const Duration(seconds: 30)),
  secondsTotal: 30,
  hold: WrapupHold.none,
  dispositionSubmitted: submitted,
  autoReturn: true,
  redialRemaining: remaining,
);

StationView _wrap({int? remaining, String? saved, StationBusy busy = StationBusy.none, String? actionError}) => station(
  phase: AgentPhase.wrapup,
  call: call(bridgedAt: t0.subtract(const Duration(minutes: 3))),
  release: hungUpRelease,
  wrapup: _wrapup(remaining: remaining),
  dispositionSaved: saved,
  busy: busy,
  actionError: actionError,
);

OutlinedButton _redial(WidgetTester tester) => tester.widget<OutlinedButton>(find.byKey(const Key('redial')));
FilledButton _save(WidgetTester tester) => tester.widget<FilledButton>(find.byKey(const Key('save-outcome')));

void main() {
  group('the wrap-up', () {
    testWidgets('no Redial when the campaign does not offer it', (tester) async {
      await pumpStation(tester, _wrap());
      expect(find.byKey(const Key('save-outcome')), findsOneWidget);
      expect(find.byKey(const Key('redial')), findsNothing);
    });

    testWidgets('Redial sits beside Save outcome, says what it leaves, and redials the call on screen', (tester) async {
      final h = await pumpStation(tester, _wrap(remaining: 2));
      expect(find.text('Redial'), findsOneWidget);
      expect(find.text('2 redials left'), findsOneWidget);
      expect(find.byKey(const Key('save-outcome')), findsOneWidget);
      // Side by side at normal text size.
      final redialBox = tester.getRect(find.byKey(const Key('redial')));
      final saveBox = tester.getRect(find.byKey(const Key('save-outcome')));
      expect(redialBox.center.dy, moreOrLessEquals(saveBox.center.dy, epsilon: 1));
      expect(redialBox.right, lessThan(saveBox.left));

      await tester.tap(find.byKey(const Key('redial')));
      await tester.pump();
      expect(h.actions.count('redial'), 1);
      expect(h.actions.args['redial'], ['a1']);
      expect(h.actions.count('submitDisposition'), 0);
    });

    testWidgets('one left is said in the singular', (tester) async {
      await pumpStation(tester, _wrap(remaining: 1));
      expect(find.text('1 redial left'), findsOneWidget);
    });

    testWidgets('used up: shown, disabled, "No redials left"', (tester) async {
      final h = await pumpStation(tester, _wrap(remaining: 0));
      expect(find.text('No redials left'), findsOneWidget);
      expect(_redial(tester).onPressed, isNull);
      await tester.tap(find.byKey(const Key('redial')), warnIfMissed: false);
      await tester.pump();
      expect(h.actions.count('redial'), 0);
    });

    testWidgets('while the redial goes out, the pad, Save and Redial are all held', (tester) async {
      final h = await pumpStation(tester, _wrap(remaining: 2));
      await tester.tap(find.byKey(const Key('outcome-interested')));
      await tester.pump();
      expect(_save(tester).onPressed, isNotNull);

      await h.setView(_wrap(remaining: 2, busy: StationBusy.redialing));
      expect(find.text('Redialling…'), findsOneWidget);
      expect(_redial(tester).onPressed, isNull);
      expect(_save(tester).onPressed, isNull);
      await tester.tap(find.byKey(const Key('outcome-not_interested')));
      await tester.pump();
      await h.setView(_wrap(remaining: 2));
      // The pick made before is still the one selected: the pad ignored the tap.
      expect(_save(tester).onPressed, isNotNull);
      await tester.tap(find.byKey(const Key('save-outcome')));
      await tester.pump();
      expect(h.actions.args['submitDisposition']?.first, 'interested');
    });

    testWidgets('while the outcome saves, Redial waits', (tester) async {
      await pumpStation(tester, _wrap(remaining: 2, busy: StationBusy.savingDisposition));
      expect(_redial(tester).onPressed, isNull);
    });

    testWidgets('a refusal is said, and the outcome pad stays usable', (tester) async {
      final h = await pumpStation(
        tester,
        _wrap(remaining: 2, actionError: 'This number is on a Do Not Call list, so it can’t be redialled. Save the outcome.'),
      );
      expect(find.byKey(const Key('action-error')), findsOneWidget);
      expect(find.textContaining('can’t be redialled'), findsOneWidget);
      await tester.tap(find.byKey(const Key('outcome-interested')));
      await tester.pump();
      expect(_save(tester).onPressed, isNotNull);
      await tester.tap(find.byKey(const Key('save-outcome')));
      await tester.pump();
      expect(h.actions.count('submitDisposition'), 1);
    });

    testWidgets('once the outcome is saved there is nothing to redial for', (tester) async {
      await pumpStation(tester, _wrap(remaining: 2, saved: 'interested'));
      expect(find.byKey(const Key('outcome-saved')), findsOneWidget);
      expect(find.byKey(const Key('redial')), findsNothing);
    });

    testWidgets('large text puts Redial under the outcome pad, so Save keeps the pinned area', (tester) async {
      final h = await pumpStation(tester, _wrap(remaining: 2), textScale: 2);
      expect(find.byKey(const Key('redial')), findsOneWidget);
      final redialBox = tester.getRect(find.byKey(const Key('redial')));
      expect(redialBox.top, greaterThan(tester.getRect(find.byKey(const Key('outcome-dnc'))).bottom));
      expect(redialBox.bottom, lessThan(tester.getRect(find.byKey(const Key('notes-field'))).top));
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(find.byKey(const Key('redial')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('redial')));
      await tester.pump();
      expect(h.actions.count('redial'), 1);
    });
  });

  group('the live call', () {
    testWidgets('a redial says which one while it rings and once connected', (tester) async {
      final h = await pumpStation(
        tester,
        station(phase: AgentPhase.reserved, call: call(redialNumber: 1, redialLimit: 2)),
      );
      expect(find.byKey(const Key('band-ringing')), findsOneWidget);
      expect(find.byKey(const Key('redial-label')), findsOneWidget);
      expect(find.text('Redial 1 of 2'), findsOneWidget);
      // Above the name the agent reads while it rings.
      expect(
        tester.getRect(find.byKey(const Key('redial-label'))).bottom,
        lessThanOrEqualTo(tester.getRect(find.byKey(const Key('call-headline'))).top),
      );

      await h.setView(station(phase: AgentPhase.onCall, call: call(bridgedAt: t0, redialNumber: 2, redialLimit: 2)));
      expect(find.byKey(const Key('band-on-call')), findsOneWidget);
      expect(find.text('Redial 2 of 2'), findsOneWidget);
    });

    testWidgets('a call the dialer placed carries no label', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.reserved, call: call()));
      expect(find.byKey(const Key('redial-label')), findsNothing);
      await h.setView(station(phase: AgentPhase.onCall, call: call(bridgedAt: t0)));
      expect(find.byKey(const Key('redial-label')), findsNothing);
    });
  });
}
