import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import 'softphone_harness.dart';

void main() {
  const small = Size(360, 640);

  void expectOnScreen(WidgetTester tester, Finder f, {Size size = small}) {
    final r = tester.getRect(f);
    expect(r.top >= 0 && r.bottom <= size.height && r.left >= 0 && r.right <= size.width, isTrue, reason: '$f at $r');
  }

  void expectTarget(WidgetTester tester, Finder f) {
    final s = tester.getSize(f);
    expect(s.width >= 48 && s.height >= 48, isTrue, reason: '$f is $s');
  }

  group('200% text on 360×640', () {
    testWidgets('every phase lays out with no overflow, its action on screen', (tester) async {
      final views = <(SoftphoneView, String)>[
        (readyView(dialError: 'Q4 Renewals is calling this customer right now. Try again once that call has ended.'), 'dial-call'),
        (readyView(tag: 'c2', number: '98', canDial: false, dialBlockReason: 'That number is too short to call.'), 'dial-call'),
        (callView(SoftphonePhase.dialing), 'softphone-hang-up'),
        (callView(SoftphonePhase.ringing, muted: true), 'softphone-hang-up'),
        (
          callView(
            SoftphonePhase.onCall,
            micMuted: true,
            muted: true,
            outcomeCode: 'callback',
            callbackAt: t0.add(const Duration(hours: 1)),
          ),
          'softphone-hang-up',
        ),
        (
          callView(
            SoftphonePhase.outcome,
            outcomeCode: 'wrong',
            outcomeDueAt: t0.add(const Duration(minutes: 2)),
            requiredFieldsMissing: true,
          ),
          'softphone-save',
        ),
        (callView(SoftphonePhase.onCall, finishOnly: true, audio: const AudioView(micProblem: MicProblem.busy)), 'softphone-hang-up'),
      ];
      final h = await pumpSoftphone(tester, views.first.$1, textScale: 2, size: small);
      for (final (v, action) in views) {
        await h.setView(v);
        await expectNoOverflow(tester);
        expectOnScreen(tester, find.byKey(Key(action)));
      }
      // Finish mode with nothing to finish: no action, still no overflow.
      await h.setView(readyView(finishOnly: true));
      await expectNoOverflow(tester);
    });

    testWidgets('the whole ready column scrolls without overflow, keys and all', (tester) async {
      await pumpSoftphone(tester, readyView(tag: 'c2'), textScale: 2, size: small);
      for (final key in ['dial-key-1', 'dial-key-#', 'log-to', 'caller-id', 'call-field-renewal', 'redial-m2']) {
        await tester.ensureVisible(find.byKey(Key(key)));
        await tester.pump();
        await expectNoOverflow(tester);
      }
    });

    testWidgets('the whole call column scrolls without overflow', (tester) async {
      await pumpSoftphone(tester, callView(SoftphonePhase.outcome, outcomeCode: 'callback'), textScale: 2, size: small);
      for (final key in [
        'softphone-dnc',
        'roster-contact',
        'outcome-wrong',
        'softphone-callback-picked',
        'softphone-notes-field',
        'call-field-consent',
      ]) {
        await tester.ensureVisible(find.byKey(Key(key)));
        await tester.pump();
        await expectNoOverflow(tester);
      }
    });

    testWidgets('the override sheet and the DNC sheet fit', (tester) async {
      final h = await pumpSoftphone(tester, readyView(overridePrompt: hoursPrompt), textScale: 2, size: small);
      await settle(tester);
      await expectNoOverflow(tester);
      await tester.ensureVisible(find.byKey(const Key('override-confirm')));
      await tester.pump();
      await expectNoOverflow(tester);
      await h.setView(callView(SoftphonePhase.onCall));
      await settle(tester);
      await tester.ensureVisible(find.byKey(const Key('softphone-dnc')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('softphone-dnc')));
      await settle(tester);
      expect(find.byKey(const Key('dnc-sheet')), findsOneWidget);
      await expectNoOverflow(tester);
    });

    testWidgets('every Phone screen state fits', (tester) async {
      const states = <SoftphoneScreenState>[
        SoftphoneScreenLoading(),
        SoftphoneScreenClosed(notice: 'Your soft phone is still open — the server did not answer. Try again.'),
        SoftphoneScreenClosed(microphoneBlocked: true),
        SoftphoneScreenOnCampaign(
          campaignId: 'c1',
          campaignName: 'Q4 Card Renewals — Pune and Mumbai',
          stateLabel: 'On a call',
          accountId: 'a1',
          sameAccount: true,
          hostedHere: true,
        ),
        SoftphoneScreenOnCampaign(
          campaignId: 'c1',
          campaignName: 'Q4 Card Renewals',
          stateLabel: 'Available',
          accountId: 'a2',
          accountName: 'Mumbai collections',
          sameAccount: false,
          hostedHere: false,
          canSwitchAccount: true,
        ),
        SoftphoneScreenElsewhere(accountId: 'a2', accountName: 'Mumbai collections', callPending: true, canSwitchAccount: true),
        SoftphoneScreenOff(),
        SoftphoneScreenOffStranded(accountId: 'a2', callOwed: true),
        SoftphoneScreenError('The server did not answer.'),
      ];
      final h = await pumpSoftphone(tester, const SoftphoneView(), phoneScreen: true, textScale: 2, size: small);
      for (final s in states) {
        await h.setView(SoftphoneView(screen: s));
        await expectNoOverflow(tester);
      }
      expectOnScreen(tester, find.byKey(const Key('softphone-retry')));
    });
  });

  // The panel as the Phone tab really shows it on a 360×640 phone: a 24 dp
  // status bar, the shell's Scaffold and NavigationBar around the branch
  // navigator, and the soft keyboard up (300 dp) or down. The pinned rail and
  // action must leave the column room at every text scale, not only at 1.0.
  group('a real phone: status bar, the shell’s bar, 1.0–2.0 text, the keyboard', () {
    for (final keyboard in [0.0, 300.0]) {
      for (final scale in sweepTextScales) {
        testWidgets('${scale}x text, keyboard ${keyboard.round()} dp: every phase fits, the caret and the action stay visible', (
          tester,
        ) async {
          final h = await pumpSoftphone(
            tester,
            readyView(),
            phoneScreen: true,
            shell: true,
            statusBar: 24,
            keyboard: keyboard,
            textScale: scale,
            size: small,
          );
          await expectEveryPanelPhaseFits(tester, h.setView, size: small, statusBar: 24, keyboard: keyboard);
        });
      }
    }
  });

  group('touch targets', () {
    testWidgets('the pad, Delete, Call and redial are at least 48 dp', (tester) async {
      await pumpSoftphone(tester, readyView(), size: small);
      for (final k in ['1', '2', '5', '0', '*', '#']) {
        expectTarget(tester, find.byKey(Key('dial-key-$k')));
      }
      expectTarget(tester, find.byKey(const Key('dial-backspace')));
      expectTarget(tester, find.byKey(const Key('dial-call')));
      await tester.ensureVisible(find.byKey(const Key('redial-m1')));
      expectTarget(tester, find.byKey(const Key('redial-m1')));
    });

    // Tall, so nothing is cut off by the scrolling column (a clipped target
    // reads as too small).
    for (final scale in [1.0, 2.0]) {
      testWidgets('every phase meets the tap-target and label guidelines at ${scale}x text', (tester) async {
        final semantics = tester.ensureSemantics();
        final h = await pumpSoftphone(tester, readyView(), textScale: scale, size: const Size(360, 4000));
        for (final v in [
          readyView(tag: 'c2'),
          readyView(dialError: 'Refused.', bootstrapError: 'No answer'),
          readyView(link: StationLink.disconnected),
          callView(SoftphonePhase.ringing),
          callView(SoftphonePhase.onCall, outcomeCode: 'callback', dncOutcome: 'Added'),
          callView(SoftphonePhase.onCall, audio: const AudioView(micProblem: MicProblem.permissionDenied)),
          callView(SoftphonePhase.outcome, outcomeCode: 'callback', callbackAt: t0.add(const Duration(hours: 1))),
        ]) {
          await h.setView(v);
          await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
          await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        }
        semantics.dispose();
      });
    }

    testWidgets('every Phone screen state meets the tap-target and label guidelines', (tester) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpSoftphone(tester, const SoftphoneView(), phoneScreen: true, size: small);
      const states = <SoftphoneScreenState>[
        SoftphoneScreenClosed(),
        SoftphoneScreenOnCampaign(campaignId: 'c1', campaignName: 'Q4', stateLabel: 'On break', accountId: 'a1', sameAccount: true, hostedHere: true),
        SoftphoneScreenElsewhere(accountId: 'a2', accountName: 'Mumbai', canSwitchAccount: true),
        SoftphoneScreenOffStranded(accountId: 'a2', callOwed: true),
        SoftphoneScreenError('The server did not answer.'),
      ];
      for (final s in states) {
        await h.setView(SoftphoneView(screen: s));
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      }
      semantics.dispose();
    });

    testWidgets('the call controls, hang-up and the outcome buttons are at least 48 dp', (tester) async {
      await pumpSoftphone(tester, callView(SoftphonePhase.onCall), textScale: 2, size: small);
      for (final k in ['softphone-mute', 'softphone-audio', 'softphone-dnc', 'softphone-hang-up', 'outcome-interested']) {
        await tester.ensureVisible(find.byKey(Key(k)));
        await tester.pump();
        expectTarget(tester, find.byKey(Key(k)));
      }
    });
  });

  group('screen readers', () {
    testWidgets('the rail is a polite live region that says the phase', (tester) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpSoftphone(tester, readyView());
      final rail = tester.getSemantics(find.byKey(const Key('softphone-rail')));
      expect(rail.flagsCollection.isLiveRegion, isTrue);
      expect(find.semantics.byLabel('Ready to dial'), findsOneWidget);
      await h.setView(callView(SoftphonePhase.ringing));
      expect(find.semantics.byLabel('Ringing +91 98123 45678'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('the core’s announcement is said assertively, once per sequence', (tester) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.ringing), supportsAnnounce: true);
      const muted = 'You are muted. The customer can’t hear you.';
      await h.setView(callView(SoftphonePhase.onCall, muted: true, micMuted: true, announcement: muted, announcementSeq: 1));
      expect(h.announcements, hasLength(1));
      final data = (h.announcements.single! as Map)['data'] as Map;
      expect(data['message'], muted);
      expect(data['assertiveness'], 1);
      final region = tester.getSemantics(find.byKey(const Key('softphone-announcer')));
      expect(region.label, muted);
      expect(region.flagsCollection.isLiveRegion, isTrue);

      // Another frame with the same sequence says nothing again…
      await h.setView(callView(SoftphonePhase.onCall, muted: true, announcement: muted, announcementSeq: 1));
      expect(h.announcements, hasLength(1));
      // …and the same sentence with the next sequence is said again.
      await h.setView(callView(SoftphonePhase.onCall, muted: true, announcement: muted, announcementSeq: 2));
      expect(h.announcements, hasLength(2));
      semantics.dispose();
    });

    testWidgets('keys read as a phone prints them; 0 says how to get +', (tester) async {
      final semantics = tester.ensureSemantics();
      await pumpSoftphone(tester, readyView());
      expect(tester.getSemantics(find.byKey(const Key('dial-key-2'))).label, '2 ABC');
      final zero = tester.getSemantics(find.byKey(const Key('dial-key-0')));
      expect(zero.label, '0');
      expect(zero.hint, 'Press and hold for +');
      final delete = tester.getSemantics(find.byKey(const Key('dial-backspace')));
      expect(delete.label, 'Delete last digit');
      semantics.dispose();
    });

    testWidgets('Mute says what it acts on, and whether it is on', (tester) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.ringing, muted: true));
      var mute = tester.getSemantics(find.byKey(const Key('softphone-mute')));
      expect(mute.label, 'Mute ring');
      expect(mute.flagsCollection.isToggled, Tristate.isTrue);
      await h.setView(callView(SoftphonePhase.onCall));
      mute = tester.getSemantics(find.byKey(const Key('softphone-mute')));
      expect(mute.label, 'Mute');
      expect(mute.flagsCollection.isToggled, Tristate.isFalse);
      semantics.dispose();
    });

    testWidgets('a required call detail says so', (tester) async {
      final semantics = tester.ensureSemantics();
      await pumpSoftphone(tester, callView(SoftphonePhase.onCall));
      await tester.ensureVisible(find.byKey(const Key('call-field-policy')));
      expect(find.semantics.byLabel('Policy number, required'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('a disabled Close says why', (tester) async {
      final semantics = tester.ensureSemantics();
      await pumpSoftphone(tester, callView(SoftphonePhase.onCall));
      final node = tester.getSemantics(find.byKey(const Key('softphone-close')));
      expect(node.hint, contains('Finish this call and save its outcome first'));
      semantics.dispose();
    });
  });

  testWidgets('light theme renders the call too', (tester) async {
    await pumpSoftphone(tester, callView(SoftphonePhase.outcome), brightness: Brightness.light);
    expect(find.byKey(const Key('softphone-save')), findsOneWidget);
  });

  testWidgets('landscape tablet: the panel is a readable column on the Phone tab', (tester) async {
    await pumpSoftphone(tester, readyView(), phoneScreen: true, size: const Size(1280, 800));
    expect(tester.getSize(find.byKey(const Key('dial-call'))).width, lessThanOrEqualTo(560));
  });
}
