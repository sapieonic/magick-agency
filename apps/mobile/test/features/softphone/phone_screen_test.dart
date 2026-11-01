import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/features/preflight/preflight_checks.dart';

import 'softphone_harness.dart';

void main() {
  Future<SoftphoneHarness> pumpScreen(WidgetTester tester, SoftphoneScreenState screen, {SoftphoneView? view}) =>
      pumpSoftphone(tester, view ?? SoftphoneView(screen: screen), phoneScreen: true);

  testWidgets('loading and opening say so, with nothing to press', (tester) async {
    final h = await pumpScreen(tester, const SoftphoneScreenLoading());
    expect(find.text('Loading the soft phone…'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
    await h.setView(const SoftphoneView(screen: SoftphoneScreenOpening()));
    expect(find.text('Opening your soft phone…'), findsOneWidget);
  });

  group('closed', () {
    testWidgets('Open asks for the microphone and notifications, then opens once', (tester) async {
      final h = await pumpScreen(tester, const SoftphoneScreenClosed());
      expect(find.text('Make calls from your phone'), findsOneWidget);
      // Arriving at the tab opens nothing: opening is the agent's tap.
      expect(h.actions.calls, isEmpty);
      await tester.tap(find.byKey(const Key('softphone-open')));
      await settle(tester);
      expect(h.permissions.micAsked, 1);
      expect(h.permissions.notificationsAsked, 1);
      expect(h.actions.calls, ['open']);
    });

    testWidgets('a refused microphone does not open, says why and offers Settings', (tester) async {
      final h = await pumpScreen(tester, const SoftphoneScreenClosed());
      h.permissions.mic = MicPermission.permanentlyDenied;
      await tester.tap(find.byKey(const Key('softphone-open')));
      await settle(tester);
      expect(h.actions.count('open'), 0);
      expect(find.textContaining('needs the microphone'), findsOneWidget);
      await tester.tap(find.byKey(const Key('softphone-open-settings')));
      await tester.pump();
      expect(h.settingsOpened, 1);

      // Allowed on the next try: it opens.
      h.permissions.mic = MicPermission.granted;
      await tester.tap(find.byKey(const Key('softphone-open')));
      await settle(tester);
      expect(h.actions.count('open'), 1);
      expect(find.textContaining('needs the microphone'), findsNothing);
    });

    testWidgets('a blocked microphone offers Settings instead of Open', (tester) async {
      final h = await pumpScreen(tester, const SoftphoneScreenClosed(microphoneBlocked: true));
      expect(find.text('Your microphone is blocked'), findsOneWidget);
      expect(find.byKey(const Key('softphone-open')), findsNothing);
      await tester.tap(find.byKey(const Key('softphone-open-settings')));
      await tester.pump();
      expect(h.settingsOpened, 1);
    });

    testWidgets('the reason the last open did not happen is shown', (tester) async {
      await pumpScreen(tester, const SoftphoneScreenClosed(notice: 'Your soft phone is still open — try again.'));
      expect(find.text('Your soft phone is still open — try again.'), findsOneWidget);
    });

    testWidgets('a refused open shows its reason, dismissible', (tester) async {
      final h = await pumpScreen(
        tester,
        const SoftphoneScreenClosed(),
        view: const SoftphoneView(screen: SoftphoneScreenClosed(), sessionError: 'The soft phone is off for this account.'),
      );
      expect(find.text('The soft phone is off for this account.'), findsOneWidget);
      await tester.tap(find.byTooltip('Dismiss'));
      expect(h.actions.calls, ['dismissSessionError']);
    });
  });

  testWidgets('active draws the soft phone with Close soft phone', (tester) async {
    await pumpSoftphone(tester, readyView(), phoneScreen: true);
    expect(find.byKey(const Key('softphone-scroll')), findsOneWidget);
    expect(find.byKey(const Key('softphone-close')), findsOneWidget);
    expect(find.byKey(const Key('softphone-return')), findsNothing);
  });

  group('live on a campaign', () {
    const here = SoftphoneScreenOnCampaign(
      campaignId: 'c1',
      campaignName: 'Q4 Renewals',
      stateLabel: 'Available',
      accountId: 'a1',
      accountName: 'Pune',
      sameAccount: true,
      hostedHere: true,
    );

    testWidgets('on this phone: Switch to soft phone, then the station', (tester) async {
      final h = await pumpScreen(tester, here);
      expect(find.text('You’re still at the Q4 Renewals station'), findsOneWidget);
      expect(find.textContaining('— available.'), findsOneWidget);
      await tester.tap(find.byKey(const Key('softphone-switch')));
      await settle(tester);
      expect(h.actions.calls, ['switchToSoftphone']);
      expect(find.text('station-c1'), findsOneWidget);
    });

    testWidgets('a refused switch stays here', (tester) async {
      final h = await pumpScreen(tester, here);
      h.actions.switchResult = false;
      await tester.tap(find.byKey(const Key('softphone-switch')));
      await settle(tester);
      expect(find.text('station-c1'), findsNothing);
      expect(find.byKey(const Key('softphone-on-campaign')), findsOneWidget);
    });

    testWidgets('a switch already queued says so and cannot be pressed again', (tester) async {
      final h = await pumpScreen(
        tester,
        const SoftphoneScreenOnCampaign(
          campaignId: 'c1',
          campaignName: 'Q4 Renewals',
          stateLabel: 'On a call',
          accountId: 'a1',
          sameAccount: true,
          hostedHere: true,
          switchQueued: true,
        ),
      );
      expect(find.text('Switching after this call'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('softphone-switch'))).onPressed, isNull);
      await tester.tap(find.byKey(const Key('softphone-go-to-station')));
      await settle(tester);
      expect(h.actions.calls, isEmpty);
      expect(find.text('station-c1'), findsOneWidget);
    });

    testWidgets('another account: named, with the account switch when offered', (tester) async {
      final h = await pumpScreen(
        tester,
        const SoftphoneScreenOnCampaign(
          campaignId: 'c9',
          campaignName: 'Diwali Offers',
          stateLabel: 'Available',
          accountId: 'a2',
          accountName: 'Mumbai',
          sameAccount: false,
          hostedHere: false,
          canSwitchAccount: true,
        ),
      );
      expect(find.text('You’re live on Diwali Offers in Mumbai'), findsOneWidget);
      expect(find.byKey(const Key('softphone-switch')), findsNothing);
      await tester.tap(find.byKey(const Key('softphone-switch-account')));
      await tester.pump();
      expect(h.actions.calls, ['requestAccountSwitch']);
      expect(h.actions.args['requestAccountSwitch'], ['a2']);
    });

    testWidgets('another account the agent cannot switch to: no button that would fail', (tester) async {
      await pumpScreen(
        tester,
        const SoftphoneScreenOnCampaign(
          campaignId: 'c9',
          campaignName: 'Diwali Offers',
          stateLabel: 'Available',
          accountId: 'a2',
          sameAccount: false,
          hostedHere: false,
        ),
      );
      expect(find.textContaining('in another account — switch to that account'), findsOneWidget);
      expect(find.byKey(const Key('softphone-switch-account')), findsNothing);
      expect(find.byType(FilledButton), findsNothing);
    });
  });

  group('open in another account', () {
    testWidgets('close it and open here, or go there', (tester) async {
      final h = await pumpScreen(tester, const SoftphoneScreenElsewhere(accountId: 'a2', accountName: 'Mumbai', canSwitchAccount: true));
      expect(find.text('Your soft-phone session is open in Mumbai. You can only have one session at a time.'), findsOneWidget);
      await tester.tap(find.byKey(const Key('softphone-elsewhere-close')));
      await tester.pump();
      expect(h.actions.calls, ['closeElsewhereAndOpen']);
      await tester.tap(find.text('Use the soft phone in Mumbai'));
      await tester.pump();
      expect(h.actions.args['requestAccountSwitch'], ['a2']);
    });

    testWidgets('a call there unfinished: no close, going there is the primary way', (tester) async {
      await pumpScreen(
        tester,
        const SoftphoneScreenElsewhere(accountId: 'a2', accountName: 'Mumbai', callPending: true, canSwitchAccount: true),
      );
      expect(find.byKey(const Key('softphone-elsewhere-close')), findsNothing);
      expect(find.textContaining('has a call that isn’t finished'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Use the soft phone in Mumbai'), findsOneWidget);
    });
  });

  testWidgets('off: not available, nothing to press', (tester) async {
    await pumpScreen(tester, const SoftphoneScreenOff());
    expect(find.text('Not available for your account'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('off and stranded: close it there, and who can save an owed outcome', (tester) async {
    final h = await pumpScreen(tester, const SoftphoneScreenOffStranded(accountId: 'a2', callOwed: true));
    expect(find.text('Your soft phone is open in another account'), findsOneWidget);
    expect(find.textContaining('A supervisor can save it for you'), findsOneWidget);
    await tester.tap(find.byKey(const Key('softphone-stranded-close')));
    await tester.pump();
    expect(h.actions.calls, ['closeStranded']);
  });

  testWidgets('stranded with nothing owed does not mention a supervisor', (tester) async {
    await pumpScreen(tester, const SoftphoneScreenOffStranded(accountId: 'a2'));
    expect(find.textContaining('A supervisor can save it for you'), findsNothing);
  });

  testWidgets('error: the reason and Try again', (tester) async {
    final h = await pumpScreen(tester, const SoftphoneScreenError('The server did not answer.'));
    expect(find.text('Can’t open the soft phone'), findsOneWidget);
    expect(find.text('The server did not answer.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('softphone-retry')));
    await tester.pump();
    expect(h.actions.calls, ['retry']);
  });

  testWidgets('a session busy closing disables the close and says Closing…', (tester) async {
    await pumpScreen(
      tester,
      const SoftphoneScreenElsewhere(accountId: 'a2'),
      view: const SoftphoneView(
        screen: SoftphoneScreenElsewhere(accountId: 'a2'),
        sessionBusy: SoftphoneSessionBusy.closing,
      ),
    );
    expect(find.text('Closing…'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const Key('softphone-elsewhere-close'))).onPressed, isNull);
  });
}
