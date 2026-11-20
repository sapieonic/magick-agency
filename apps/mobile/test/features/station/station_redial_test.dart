import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/widgets/action_buttons.dart';

import '../../core/station/controller_harness.dart' as core;
import 'station_harness.dart';

/// Wrap-up redial on the station screen: "Call again · 2 left" beside Save & break under Save,
/// and the live call's "Calling again · 1 of 2".

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

/// The views the real station core derives from exactly the frames the
/// server sends for a wrap-up redial (no `agent_state` on the dial path):
/// the wrap-up it starts from, the redial ringing, on the call, and its own
/// wrap-up.
({StationView wrapup, StationView ringing, StationView onCall, StationView redialWrapup}) _serverFaithfulRedial() {
  late ({StationView wrapup, StationView ringing, StationView onCall, StationView redialWrapup}) out;
  fakeAsync((async) {
    final app = core.App(async)..start();
    Map<String, Object?> wrapup(String id, int remaining) => {
          'attempt_id': id,
          'ends_at': '2026-11-01T09:01:00.000Z',
          'seconds_total': 30,
          'auto_return': true,
          'requires_disposition': true,
          'disposition_submitted': false,
          'redial_remaining': remaining,
        };
    app.inWrapup('a1');
    app.frame({'event': 'wrapup', 'wrapup': wrapup('a1', 2)});
    final inWrapup = app.view!;
    app.routes['POST /proxy/agency/sessions/sess-1/redial'] = (_) => core.json(200, {
          'session_id': 'sess-1',
          'attempt_id': 'a2',
          'redial_of_attempt_id': 'a1',
          'redial_number': 1,
          'redial_remaining': 1,
        });
    app.run(app.controller.redial(attemptId: 'a1'));
    app.frame({
      'event': 'reserved',
      'attempt': {
        ...app.attemptJson('a2'),
        'redial': {'of_attempt_id': 'a1', 'number': 1, 'remaining': 1},
      },
    });
    final ringing = app.view!;
    app.bridged('a2');
    final onCall = app.view!;
    app.releasedFrame('a2');
    app.agentStateFrame('wrapup');
    app.frame({'event': 'wrapup', 'wrapup': wrapup('a2', 1)});
    out = (wrapup: inWrapup, ringing: ringing, onCall: onCall, redialWrapup: app.view!);
    app.dispose();
  });
  return out;
}

SecondaryActionButton _redial(WidgetTester tester) => tester.widget<SecondaryActionButton>(find.byKey(const Key('redial')));
MainActionButton _save(WidgetTester tester) => tester.widget<MainActionButton>(find.byKey(const Key('save-outcome')));

/// Save can be pressed and is ready (not faded, not busy, nothing held).
bool _saveReady(WidgetTester tester) => _save(tester).onPressed != null && !_save(tester).dimmed && !_save(tester).busy;

void main() {
  group('the wrap-up', () {
    testWidgets('no Redial when the campaign does not offer it', (tester) async {
      await pumpStation(tester, _wrap());
      expect(find.byKey(const Key('save-outcome')), findsOneWidget);
      expect(find.byKey(const Key('redial')), findsNothing);
    });

    testWidgets('Call again sits beside Save & break under Save, says what it leaves, and redials the call on screen', (tester) async {
      final h = await pumpStation(tester, _wrap(remaining: 2));
      expect(find.text('Call again · 2 left'), findsOneWidget);
      expect(find.byKey(const Key('save-outcome')), findsOneWidget);
      // Side by side with Save & break, under the main button, at normal text size.
      final redialBox = tester.getRect(find.byKey(const Key('redial')));
      final breakBox = tester.getRect(find.byKey(const Key('save-and-break')));
      final saveBox = tester.getRect(find.byKey(const Key('save-outcome')));
      expect(redialBox.center.dy, moreOrLessEquals(breakBox.center.dy, epsilon: 1));
      expect(breakBox.right, lessThan(redialBox.left));
      expect(redialBox.top, greaterThan(saveBox.bottom));

      await tester.tap(find.byKey(const Key('redial')));
      await tester.pump();
      expect(h.actions.count('redial'), 1);
      expect(h.actions.args['redial'], ['a1']);
      expect(h.actions.count('submitDisposition'), 0);
    });

    testWidgets('one left is said in the singular', (tester) async {
      await pumpStation(tester, _wrap(remaining: 1));
      expect(find.text('Call again · 1 left'), findsOneWidget);
    });

    testWidgets('used up: hidden, not greyed (AS1); Save & break takes the row', (tester) async {
      await pumpStation(tester, _wrap(remaining: 0));
      expect(find.byKey(const Key('redial')), findsNothing);
      expect(find.byKey(const Key('save-and-break')), findsOneWidget);
    });

    testWidgets('while the redial goes out, the pad, Save and Redial are all held', (tester) async {
      final h = await pumpStation(tester, _wrap(remaining: 2));
      await tester.tap(find.byKey(const Key('outcome-interested')));
      await tester.pump();
      expect(_saveReady(tester), isTrue);

      await h.setView(_wrap(remaining: 2, busy: StationBusy.redialing));
      expect(find.text('Calling…'), findsOneWidget);
      expect(_redial(tester).busy, isTrue);
      expect(_save(tester).onPressed, isNull);
      await tester.tap(find.byKey(const Key('outcome-not_interested')));
      await tester.pump();
      await h.setView(_wrap(remaining: 2));
      // The pick made before is still the one selected: the pad ignored the tap.
      expect(_saveReady(tester), isTrue);
      await tester.tap(find.byKey(const Key('save-outcome')));
      await tester.pump();
      expect(h.actions.args['submitDisposition']?.first, 'interested');
    });

    testWidgets('while the outcome saves, Redial waits', (tester) async {
      await pumpStation(tester, _wrap(remaining: 2, busy: StationBusy.savingDisposition));
      expect(_redial(tester).onPressed, isNull);
      expect(_save(tester).busy, isTrue);
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
      expect(_saveReady(tester), isTrue);
      await tester.tap(find.byKey(const Key('save-outcome')));
      await tester.pump();
      expect(h.actions.count('submitDisposition'), 1);
    });

    testWidgets('once the outcome is saved there is nothing to redial for', (tester) async {
      await pumpStation(tester, _wrap(remaining: 2, saved: 'interested'));
      expect(find.byKey(const Key('outcome-saved')), findsOneWidget);
      expect(find.byKey(const Key('redial')), findsNothing);
    });

    testWidgets('large text stacks Save & break and Call again under Save; nothing overflows', (tester) async {
      final h = await pumpStation(tester, _wrap(remaining: 2), textScale: 2);
      expect(find.byKey(const Key('redial')), findsOneWidget);
      final redialBox = tester.getRect(find.byKey(const Key('redial')));
      expect(redialBox.top, greaterThan(tester.getRect(find.byKey(const Key('save-and-break'))).top));
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(find.byKey(const Key('redial')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('redial')));
      await tester.pump();
      expect(h.actions.count('redial'), 1);
    });
  });

  group('the frames the server sends, through the real station core', () {
    testWidgets('a live redial shows the ringing and on-call screens: no outcome pad, no Save', (tester) async {
      final views = _serverFaithfulRedial();
      final h = await pumpStation(tester, views.wrapup, campaignId: 'camp-1');
      expect(find.byKey(const Key('save-outcome')), findsOneWidget);
      expect(find.byKey(const Key('redial')), findsOneWidget);

      await h.setView(views.ringing);
      expect(find.byKey(const Key('band-ringing')), findsOneWidget);
      expect(find.text('Calling again · 1 of 2'), findsOneWidget);
      expect(find.byKey(const Key('save-outcome')), findsNothing);
      expect(find.byKey(const Key('redial')), findsNothing);

      await h.setView(views.onCall);
      expect(find.byKey(const Key('band-on-call')), findsOneWidget);
      expect(find.byKey(const Key('save-outcome')), findsNothing);
      expect(find.byKey(const Key('outcome-interested')), findsNothing);

      await h.setView(views.redialWrapup);
      expect(find.byKey(const Key('save-outcome')), findsOneWidget);
      expect(find.text('Call again · 1 left'), findsOneWidget);
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
      expect(find.text('Calling again · 1 of 2'), findsOneWidget);
      // Above the name the agent reads while it rings.
      expect(
        tester.getRect(find.byKey(const Key('redial-label'))).bottom,
        lessThanOrEqualTo(tester.getRect(find.byKey(const Key('call-headline'))).top),
      );

      await h.setView(station(phase: AgentPhase.onCall, call: call(bridgedAt: t0, redialNumber: 2, redialLimit: 2)));
      expect(find.byKey(const Key('band-on-call')), findsOneWidget);
      expect(find.text('Calling again · 2 of 2'), findsOneWidget);
    });

    testWidgets('a call the dialer placed carries no label', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.reserved, call: call()));
      expect(find.byKey(const Key('redial-label')), findsNothing);
      await h.setView(station(phase: AgentPhase.onCall, call: call(bridgedAt: t0)));
      expect(find.byKey(const Key('redial-label')), findsNothing);
    });
  });
}
