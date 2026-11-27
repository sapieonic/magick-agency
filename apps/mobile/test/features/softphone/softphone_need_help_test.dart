import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';

import 'softphone_harness.dart';

/// Need help on the Phone tab (LF39): the soft-phone session's request, beside Close soft phone, with
/// the same controls and states as the station's soft phone (AS5): raise, open and cancel, how it
/// ended, refusals (LF35, LF37), offline, and on calls only once an older server refused one off a
/// call. The request is the hosted session's ([sessionHelpProvider]); the Phone tab has no campaign
/// view.
void main() {
  group('Need help on the Phone tab', () {
    testWidgets('beside Close soft phone, and pressing it raises the session\'s request', (tester) async {
      final h = await pumpSoftphone(tester, readyView(), needHelp: true);
      await settle(tester);
      expect(find.byKey(const Key('softphone-close')), findsOneWidget);
      expect(find.byKey(const Key('need-help')), findsOneWidget);
      await tester.tap(find.byKey(const Key('need-help')));
      await tester.pump();
      expect(h.helpActions.count('raiseHelp'), 1);
      expect(h.actions.calls, isNot(contains('close')));
    });

    testWidgets('answered with a message: the notice shows, and Need help is offered again, raising once', (tester) async {
      // Messages are one-way (LF5): the agent answers a supervisor's message by asking again.
      for (final view in [readyView(), callView(SoftphonePhase.onCall)]) {
        final h = await pumpSoftphone(
          tester,
          view,
          needHelp: true,
          help: const HelpView(notice: 'Reshma Mohammad answered with a message.', noticeTone: HelpNoticeTone.success),
        );
        await settle(tester);
        expect(find.text('Reshma Mohammad answered with a message.'), findsOneWidget, reason: view.phase.name);
        expect(find.byKey(const Key('cancel-help')), findsNothing, reason: 'the request ended with the answer');
        expect(tester.widget<OutlinedButton>(find.byKey(const Key('need-help'))).onPressed, isNotNull, reason: view.phase.name);
        await tester.tap(find.byKey(const Key('need-help')));
        await tester.pump();
        expect(h.helpActions.count('raiseHelp'), 1, reason: view.phase.name);
      }
    });

    testWidgets('off for the account: no control and no card, even with news', (tester) async {
      await pumpSoftphone(tester, readyView(), help: const HelpView(notice: 'Anitha N answered with a message.', noticeTone: HelpNoticeTone.success));
      await settle(tester);
      expect(find.byKey(const Key('need-help')), findsNothing);
      expect(find.byKey(const Key('need-help-card')), findsNothing);
    });

    testWidgets('raising: Asking, disabled; open: "Help asked · 0:42", and pressing it cancels', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.onCall), needHelp: true, help: const HelpView(stage: HelpStage.raising));
      await settle(tester);
      expect(find.text(StationCopy.askingForHelp), findsOneWidget);
      expect(tester.widget<OutlinedButton>(find.byKey(const Key('need-help'))).onPressed, isNull);

      await h.setHelp(HelpView(stage: HelpStage.open, raisedAt: t0.subtract(const Duration(seconds: 42))));
      expect(find.text(StationCopy.helpAsked('0:42')), findsOneWidget);
      await tester.tap(find.byKey(const Key('cancel-help')));
      await tester.pump();
      expect(h.helpActions.count('cancelHelp'), 1);

      await h.setHelp(HelpView(stage: HelpStage.cancelling, raisedAt: t0));
      expect(find.text(StationCopy.cancellingHelp), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('cancel-help'))).onPressed, isNull);
    });

    testWidgets('how it ended, and a refusal, under the header; Dismiss puts them away', (tester) async {
      final h = await pumpSoftphone(tester, readyView(), needHelp: true);
      await settle(tester);
      expect(find.byKey(const Key('need-help-card')), findsNothing);
      await h.setHelp(const HelpView(notice: 'Anitha N is listening to your call.', noticeTone: HelpNoticeTone.success));
      expect(find.byKey(const Key('help-notice')), findsOneWidget);
      expect(find.text('Anitha N is listening to your call.'), findsOneWidget);
      await tester.tap(find.descendant(of: find.byKey(const Key('help-notice')), matching: find.byType(IconButton)));
      await tester.pump();
      expect(h.helpActions.count('dismissHelpNotice'), 1);

      await h.setHelp(const HelpView(error: 'Need help is not turned on. Call your supervisor to your desk.'));
      expect(find.byKey(const Key('help-error')), findsOneWidget);
      // Expired, in the warning tone.
      await h.setHelp(const HelpView(notice: 'No supervisor answered within 15 minutes.', noticeTone: HelpNoticeTone.warning));
      expect(find.byKey(const Key('help-notice')), findsOneWidget);
      expect(find.byIcon(Icons.schedule), findsOneWidget);
    });

    testWidgets('with the socket not open, a press says to call the supervisor to the desk and sends nothing', (tester) async {
      final h = await pumpSoftphone(tester, readyView(link: StationLink.reconnecting), needHelp: true);
      await settle(tester);
      await tester.tap(find.byKey(const Key('need-help')));
      await tester.pump();
      expect(find.byKey(const Key('help-offline')), findsOneWidget);
      expect(h.helpActions.calls, isEmpty);
    });

    testWidgets('a server that refused a raise off a call: offered on a call and with the outcome owed only', (tester) async {
      final h = await pumpSoftphone(tester, readyView(), needHelp: true, help: const HelpView(onlyOnCall: true));
      await settle(tester);
      expect(find.byKey(const Key('need-help')), findsNothing);
      await h.setView(callView(SoftphonePhase.onCall));
      expect(find.byKey(const Key('need-help')), findsOneWidget);
      await h.setView(callView(SoftphonePhase.outcome));
      expect(find.byKey(const Key('need-help')), findsOneWidget);
      // An open request shows wherever the agent is.
      await h.setView(readyView());
      await h.setHelp(HelpView(stage: HelpStage.open, raisedAt: t0, onlyOnCall: true));
      expect(find.byKey(const Key('cancel-help')), findsOneWidget);
    });

    testWidgets('fits at 360 wide with 200% text, beside Close soft phone, open and with a notice', (tester) async {
      await pumpSoftphone(
        tester,
        callView(SoftphonePhase.onCall),
        needHelp: true,
        size: const Size(360, 640),
        textScale: 2,
        help: HelpView(stage: HelpStage.open, raisedAt: t0, notice: 'Anitha N is listening to your call.', noticeTone: HelpNoticeTone.success),
      );
      await settle(tester);
      expect(find.byKey(const Key('cancel-help')), findsOneWidget);
      await expectNoOverflow(tester);
    });
  });
}
