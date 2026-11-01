import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/theme/app_theme.dart';
import 'package:magick_agency_agent/app/theme/tokens.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/features/preflight/preflight_checks.dart';
import 'package:magick_agency_agent/features/softphone/parts/session_cards.dart';
import 'package:magick_agency_agent/features/softphone/softphone_copy.dart';

import 'softphone_harness.dart';

void main() {
  Future<SoftphoneHarness> pumpScreen(WidgetTester tester, SoftphoneScreenState screen, {SoftphoneView? view}) =>
      pumpSoftphone(tester, view ?? SoftphoneView(screen: screen), phoneScreen: true);

  /// One card on its own, in a state the screen holds only for a moment (the
  /// permission prompts are up).
  Future<void> pumpCard(WidgetTester tester, Widget card) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [softphoneViewProvider.overrideWithValue(const SoftphoneView())],
        child: MaterialApp(
          theme: buildTheme(AppTokens.dark, Brightness.dark),
          home: Scaffold(body: card),
        ),
      ),
    );
  }

  Finder inButton(String key, Finder matching) => find.descendant(of: find.byKey(Key(key)), matching: matching);

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

    testWidgets('while the prompts are up, the spinner takes the phone icon’s place', (tester) async {
      await pumpCard(
        tester,
        ClosedCard(state: const SoftphoneScreenClosed(), onOpen: () {}, onOpenSettings: () {}, askingPermission: true),
      );
      expect(inButton('softphone-open', find.byType(CircularProgressIndicator)), findsOneWidget);
      expect(inButton('softphone-open', find.byIcon(Icons.phone_outlined)), findsNothing);
      expect(tester.widget<ButtonStyleButton>(find.byKey(const Key('softphone-open'))).onPressed, isNull);

      await pumpCard(tester, ClosedCard(state: const SoftphoneScreenClosed(), onOpen: () {}, onOpenSettings: () {}));
      expect(inButton('softphone-open', find.byType(CircularProgressIndicator)), findsNothing);
      expect(inButton('softphone-open', find.byIcon(Icons.phone_outlined)), findsOneWidget);
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

    testWidgets('a station here already on the soft phone: nothing to switch, only the station', (tester) async {
      final h = await pumpScreen(
        tester,
        const SoftphoneScreenOnCampaign(
          campaignId: 'c1',
          campaignName: 'Q4 Renewals',
          stateLabel: 'On the soft phone',
          accountId: 'a1',
          sameAccount: true,
          hostedHere: true,
          onSoftphone: true,
        ),
      );
      expect(find.byKey(const Key('softphone-switch')), findsNothing);
      expect(find.text(SoftphoneCopy.onCampaignSwitchIdle), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Go to station'), findsOneWidget);
      await tester.tap(find.byKey(const Key('softphone-go-to-station')));
      await settle(tester);
      expect(h.actions.calls, isEmpty);
      expect(find.text('station-c1'), findsOneWidget);
    });

    testWidgets('in finish mode there is no switch to offer', (tester) async {
      await pumpScreen(tester, here, view: const SoftphoneView(screen: here, startAllowed: false));
      expect(find.byKey(const Key('softphone-switch')), findsNothing);
      expect(find.text(SoftphoneCopy.onCampaignSwitchIdle), findsNothing);
      expect(find.byKey(const Key('softphone-go-to-station')), findsOneWidget);
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

  group('open on another device', () {
    const title = 'Your soft phone is open on another device';
    const body = 'It may be in use on the web or another phone. Using it here moves it, and any call on it, to this phone.';

    testWidgets('says so and opens nothing; "Use it on this phone" asks for the microphone, then takes it', (tester) async {
      final h = await pumpScreen(tester, const SoftphoneScreenOtherDevice(canClose: true));
      expect(find.text(title), findsOneWidget);
      expect(find.text(body), findsOneWidget);
      expect(h.actions.calls, isEmpty);
      await tester.tap(find.byKey(const Key('softphone-use-here')));
      await settle(tester);
      expect(h.permissions.micAsked, 1);
      expect(h.permissions.notificationsAsked, 1);
      expect(h.actions.calls, ['open']);
    });

    testWidgets('"Close it" closes it there', (tester) async {
      final h = await pumpScreen(tester, const SoftphoneScreenOtherDevice(canClose: true));
      await tester.tap(find.byKey(const Key('softphone-other-device-close')));
      await tester.pump();
      expect(h.actions.calls, ['close']);
      expect(h.permissions.micAsked, 0);
    });

    testWidgets('a call unfinished there: no "Close it"', (tester) async {
      await pumpScreen(tester, const SoftphoneScreenOtherDevice());
      expect(find.byKey(const Key('softphone-other-device-close')), findsNothing);
      expect(find.byKey(const Key('softphone-use-here')), findsOneWidget);
    });

    testWidgets('a campaign station on the soft phone: the same words, and nothing to close', (tester) async {
      final h = await pumpScreen(
        tester,
        const SoftphoneScreenOtherDevice(campaignId: 'c1', campaignName: 'Q4 Renewals'),
      );
      expect(find.text(title), findsOneWidget);
      expect(find.byKey(const Key('softphone-other-device-close')), findsNothing);
      await tester.tap(find.byKey(const Key('softphone-use-here')));
      await settle(tester);
      expect(h.actions.calls, ['open']);
    });

    testWidgets('a refused microphone takes nothing over, says why and offers Settings', (tester) async {
      final h = await pumpScreen(tester, const SoftphoneScreenOtherDevice(canClose: true));
      h.permissions.mic = MicPermission.permanentlyDenied;
      await tester.tap(find.byKey(const Key('softphone-use-here')));
      await settle(tester);
      expect(h.actions.count('open'), 0);
      expect(find.textContaining('needs the microphone'), findsOneWidget);
      await tester.tap(find.byKey(const Key('softphone-open-settings')));
      await tester.pump();
      expect(h.settingsOpened, 1);
    });

    testWidgets('busy: the spinner in the button, and nothing else to press', (tester) async {
      await pumpCard(
        tester,
        OtherDeviceCard(
          state: const SoftphoneScreenOtherDevice(canClose: true),
          onUse: () {},
          onOpenSettings: () {},
          askingPermission: true,
        ),
      );
      expect(inButton('softphone-use-here', find.byType(CircularProgressIndicator)), findsOneWidget);
      expect(tester.widget<ButtonStyleButton>(find.byKey(const Key('softphone-use-here'))).onPressed, isNull);
      expect(tester.widget<ButtonStyleButton>(find.byKey(const Key('softphone-other-device-close'))).onPressed, isNull);
    });

    testWidgets('closing: Closing…, and Use waits', (tester) async {
      await pumpScreen(
        tester,
        const SoftphoneScreenOtherDevice(canClose: true),
        view: const SoftphoneView(
          screen: SoftphoneScreenOtherDevice(canClose: true),
          sessionBusy: SoftphoneSessionBusy.closing,
        ),
      );
      expect(find.text('Closing…'), findsOneWidget);
      expect(tester.widget<ButtonStyleButton>(find.byKey(const Key('softphone-use-here'))).onPressed, isNull);
    });

    testWidgets('a refused take-over or close shows its reason', (tester) async {
      await pumpScreen(
        tester,
        const SoftphoneScreenOtherDevice(),
        view: const SoftphoneView(screen: SoftphoneScreenOtherDevice(), sessionError: 'Your soft phone is still open. Try again.'),
      );
      expect(find.text('Your soft phone is still open. Try again.'), findsOneWidget);
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
