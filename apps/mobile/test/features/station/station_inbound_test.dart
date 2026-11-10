import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';

import 'station_harness.dart';

/// The station's inbound screens (`docs/inbound.md` §6), rendered from the view seam: the
/// offer, the call, the outcome, "Your customer is waiting" and why a call left.

const _catalog = [
  DispositionOption(code: 'interested', label: 'Interested', isSuccess: true),
  DispositionOption(code: 'callback', label: 'Call back later', requiresCallbackTime: true),
  DispositionOption(code: 'complaint', label: 'Complaint', requiresNote: true),
  DispositionOption(code: 'do_not_call', label: 'Do not call', suppresses: true),
];

InboundCallView caller({
  InboundStage stage = InboundStage.offered,
  String? from = '+918765432109',
  String? name = 'Rahul Deshpande',
  bool matched = true,
  bool dnc = false,
  bool recording = true,
  InboundSticky? sticky = InboundSticky.owner,
  bool isYou = true,
  DateTime? bridgedAt,
  DateTime? outcomeDueAt,
  String? hangupFailure,
}) =>
    InboundCallView(
      callId: 'ib-1',
      stage: stage,
      fromE164: from,
      toE164: '+912071234500',
      routeName: 'Pune customer line',
      displayName: matched ? name : null,
      sticky: sticky,
      stickyIsYou: isYou,
      callerDnc: dnc,
      recording: recording,
      waitedSeconds: 65,
      campaignName: matched ? 'Q4 Renewals — Pune' : null,
      contactState: matched ? 'Waiting to be called' : null,
      heroFields: matched
          ? const [
              ContactField(key: 'Name', label: 'Name', value: 'Rahul Deshpande'),
              ContactField(key: 'Policy No', label: 'Policy No', value: 'PL-2023-099120'),
            ]
          : const [],
      heroesConfigured: matched,
      priorAttempts: matched ? [PriorAttempt(at: DateTime(2026, 10, 31, 15, 10), outcomeLabel: 'Call back later')] : const [],
      catalogKind: matched ? InboundCatalogKind.campaign : InboundCatalogKind.standard,
      connectsAt: stage == InboundStage.offered ? t0.add(const Duration(milliseconds: 1500)) : null,
      bridgedAt: bridgedAt ?? (stage == InboundStage.offered ? null : t0),
      outcomeDueAt: outcomeDueAt ?? (stage == InboundStage.outcome ? t0.add(const Duration(minutes: 29, seconds: 41)) : null),
      hangupFailure: hangupFailure,
    );

AgentPhase _phaseOf(InboundStage s) => switch (s) {
      InboundStage.offered => AgentPhase.reserved,
      InboundStage.connected => AgentPhase.onCall,
      InboundStage.outcome => AgentPhase.wrapup,
    };

StationView inboundStation({
  InboundCallView? inbound,
  AgentPhase? phase,
  CustomerWaitingView? waiting,
  String? notice,
  String? dispositionSaved,
  String? dncOutcome,
  NotesView notes = const NotesView(),
  StationBusy busy = StationBusy.none,
  String? actionError,
}) =>
    StationView(
      campaignId: 'c1',
      campaignName: 'Q4 Card Renewals',
      sessionId: 's1',
      link: StationLink.open,
      phase: phase ?? (inbound == null ? AgentPhase.available : _phaseOf(inbound.stage)),
      breakOptions: breaks,
      dispositions: _catalog,
      dispositionSaved: dispositionSaved,
      dncOutcome: dncOutcome,
      notes: notes,
      busy: busy,
      actionError: actionError,
      inbound: inbound,
      customerWaiting: waiting,
      inboundNotice: notice,
    );

void main() {
  group('the offer', () {
    testWidgets('who is ringing, "Your customer", the route, the wait, the match; Hang up waits for the connect',
        (tester) async {
      final h = await pumpStation(tester, inboundStation(inbound: caller()));
      expect(find.byKey(const Key('band-inbound-offered')), findsOneWidget);
      expect(find.text(InboundCopy.incomingCall), findsOneWidget);
      expect(find.text('From Rahul Deshpande · Connecting…'), findsOneWidget);
      expect(find.byKey(const Key('inbound-caller')), findsOneWidget);
      expect(find.text('Rahul Deshpande'), findsWidgets);
      expect(find.text('+91 87654 32109 · Inbound call'), findsOneWidget);
      expect(find.text('Your customer: their contact is assigned to you'), findsOneWidget);
      expect(find.text('Recording'), findsOneWidget);
      expect(find.text('Pune customer line'), findsOneWidget);
      expect(find.text('Waited 1 min 5 s'), findsOneWidget);
      expect(find.text('Q4 Renewals — Pune · Waiting to be called'), findsOneWidget);
      expect(find.byKey(const Key('inbound-match')), findsOneWidget);
      expect(find.text(InboundCopy.hangupConnecting), findsOneWidget);

      // Holding the bar while only offered ends nothing.
      final gesture = await tester.startGesture(tester.getCenter(find.byKey(const Key('hang-up'))));
      await tester.pump(const Duration(milliseconds: 600));
      await gesture.up();
      await tester.pump();
      expect(h.actions.count('hangUp'), 0);
    });

    testWidgets('a withheld caller: "Number withheld", no match to show, not "your customer"', (tester) async {
      await pumpStation(
        tester,
        inboundStation(inbound: caller(from: null, matched: false, sticky: null, recording: false)),
      );
      expect(find.text('Number withheld'), findsWidgets);
      expect(find.byKey(const Key('inbound-no-match')), findsOneWidget);
      expect(find.textContaining('there is no number to match'), findsOneWidget);
      expect(find.text('Not recorded'), findsOneWidget);
      expect(find.byKey(const Key('inbound-sticky')), findsNothing);
      expect(find.text(InboundCopy.notOnCampaign), findsOneWidget);
    });

    testWidgets('a caller on Do Not Call: the badge and why they are still taken; another agent\'s customer',
        (tester) async {
      await pumpStation(tester, inboundStation(inbound: caller(dnc: true, isYou: false)));
      expect(find.byKey(const Key('inbound-dnc-badge')), findsOneWidget);
      expect(find.byKey(const Key('inbound-dnc-enquiry')), findsOneWidget);
      expect(find.text('Usually speaks to another agent, who isn’t free'), findsOneWidget);
    });
  });

  group('on the call', () {
    testWidgets('the talk timer, notes, the controls, and a 500 ms hold hangs up', (tester) async {
      final h = await pumpStation(tester, inboundStation(inbound: caller(stage: InboundStage.connected)));
      expect(find.byKey(const Key('band-on-call')), findsOneWidget);
      expect(find.text('Rahul Deshpande · Inbound'), findsOneWidget);
      expect(find.byKey(const Key('talk-timer')), findsOneWidget);
      expect(find.byKey(const Key('notes-field')), findsOneWidget);
      for (final k in ['control-mute', 'control-audio', 'control-details', 'control-dnc']) {
        expect(find.byKey(Key(k)), findsOneWidget, reason: k);
      }
      expect(find.text(InboundCopy.hangupConnecting), findsNothing);
      await tester.enterText(find.byKey(const Key('notes-field')), 'Wants a quote');
      expect(h.actions.args['updateNotes'], ['Wants a quote']);

      final gesture = await tester.startGesture(tester.getCenter(find.byKey(const Key('hang-up'))));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 510));
      await gesture.up();
      await tester.pump();
      expect(h.actions.count('hangUp'), 1);
    });

    testWidgets('Mark DNC confirms the number and its scope, then marks this call', (tester) async {
      final h = await pumpStation(tester, inboundStation(inbound: caller(stage: InboundStage.connected)));
      await tester.tap(find.byKey(const Key('control-dnc')));
      await settle(tester);
      expect(find.text(InboundCopy.dncTitle), findsOneWidget);
      expect(find.textContaining('+91 87654 32109 won’t be called again for Q4 Renewals — Pune'), findsOneWidget);
      await tester.tap(find.text(InboundCopy.dncAction));
      await settle(tester);
      expect(h.actions.args['markDnc'], [null, 'ib-1']);
    });

    testWidgets('a withheld number cannot be marked; a refused hang-up is said', (tester) async {
      await pumpStation(
        tester,
        inboundStation(
          inbound: caller(stage: InboundStage.connected, from: null, matched: false, hangupFailure: 'We couldn’t end the call — you may still be connected. x'),
        ),
      );
      await tester.tap(find.byKey(const Key('control-dnc')));
      await settle(tester);
      expect(find.text(InboundCopy.dncTitle), findsNothing);
      expect(find.byKey(const Key('inbound-hangup-failure')), findsOneWidget);
    });
  });

  group('the outcome', () {
    testWidgets('"Without one, it closes in" counts to outcome_due_at; the call\'s own list; Save', (tester) async {
      final h = await pumpStation(tester, inboundStation(inbound: caller(stage: InboundStage.outcome)));
      expect(find.byKey(const Key('band-inbound-outcome')), findsOneWidget);
      expect(find.text(InboundCopy.outcomeNeeded), findsOneWidget);
      expect(find.text(InboundCopy.lapsePrefix), findsOneWidget);
      expect(find.text('29:41'), findsOneWidget);
      await h.advance(const Duration(seconds: 2));
      expect(find.text('29:39'), findsOneWidget);
      expect(find.text('From Q4 Renewals — Pune’s outcome list'), findsOneWidget);
      expect(find.text('Pick an outcome to save this call.'), findsOneWidget);

      await tester.tap(find.byKey(const Key('outcome-callback')));
      await settle(tester);
      expect(find.byKey(const Key('callback-picker')), findsOneWidget);
      expect(find.text('This outcome needs a callback time.'), findsOneWidget);

      await tester.tap(find.byKey(const Key('outcome-interested')));
      await settle(tester);
      await tester.ensureVisible(find.byKey(const Key('save-outcome')));
      await tester.tap(find.byKey(const Key('save-outcome')));
      await settle(tester);
      expect(h.actions.args['submitDisposition'], ['interested', null, null]);
    });

    testWidgets('a code that stops calling asks first; saved shows what was saved', (tester) async {
      final h = await pumpStation(tester, inboundStation(inbound: caller(stage: InboundStage.outcome)));
      await tester.tap(find.byKey(const Key('outcome-do_not_call')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('save-outcome')));
      await settle(tester);
      expect(find.text(StationCopy.suppressConfirmTitle), findsOneWidget);
      await tester.tap(find.text(StationCopy.suppressConfirmAction));
      await settle(tester);
      expect(h.actions.args['submitDisposition'], ['do_not_call', null, null]);
      await h.setView(inboundStation(inbound: caller(stage: InboundStage.outcome), dispositionSaved: 'do_not_call'));
      expect(find.byKey(const Key('outcome-saved')), findsOneWidget);
    });
  });

  group('above whatever the station shows', () {
    final waiting = CustomerWaitingView(callId: 'ib-2', since: t0, name: 'Rahul Deshpande', fromE164: '+918765432109');

    testWidgets('"Your customer is waiting" over a call, and gone when cleared', (tester) async {
      final h = await pumpStation(tester, inboundStation(inbound: caller(stage: InboundStage.connected), waiting: waiting));
      expect(find.byKey(const Key('customer-waiting')), findsOneWidget);
      expect(find.text('Your customer is waiting: Rahul Deshpande'), findsOneWidget);
      expect(find.text(InboundCopy.customerWaitingHint), findsOneWidget);
      await h.setView(inboundStation(inbound: caller(stage: InboundStage.connected)));
      expect(find.byKey(const Key('customer-waiting')), findsNothing);
    });

    testWidgets('over a campaign call too, named by number when no contact matched', (tester) async {
      await pumpStation(
        tester,
        station(phase: AgentPhase.onCall, call: call(bridgedAt: t0)).copyWithWaiting(
          CustomerWaitingView(callId: 'ib-2', since: t0, fromE164: '+918765432109'),
        ),
      );
      expect(find.text('Your customer is waiting: +91 87654 32109'), findsOneWidget);
      expect(find.byKey(const Key('band-on-call')), findsOneWidget);
    });

    testWidgets('why the last call left, on the waiting screen', (tester) async {
      await pumpStation(tester, inboundStation(notice: 'The caller hung up before you were connected.'));
      expect(find.byKey(const Key('inbound-notice')), findsOneWidget);
      expect(find.text('The caller hung up before you were connected.'), findsOneWidget);
      expect(find.text(StationCopy.waitingHeadline), findsOneWidget);
    });

    testWidgets('every inbound screen fits a 360×640 phone at 200% text, its action on screen', (tester) async {
      final views = [
        inboundStation(inbound: caller(dnc: true), waiting: waiting),
        inboundStation(inbound: caller(stage: InboundStage.connected), waiting: waiting),
        inboundStation(inbound: caller(stage: InboundStage.outcome), waiting: waiting, notice: 'x'),
      ];
      final h = await pumpStation(tester, views.first, size: const Size(360, 640), textScale: 2);
      for (final v in views) {
        final errors = <FlutterErrorDetails>[];
        final old = FlutterError.onError;
        FlutterError.onError = errors.add;
        await h.setView(v);
        FlutterError.onError = old;
        expect(errors, isEmpty, reason: errors.map((e) => e.toString()).join('\n'));
        final r = tester.getRect(find.byKey(Key(v.inbound!.stage == InboundStage.outcome ? 'save-outcome' : 'hang-up')));
        expect(r.bottom <= 640 && r.top >= 0, isTrue, reason: '${v.inbound!.stage}: $r');
      }
    });
  });
}

extension on StationView {
  /// [this] with "Your customer is waiting" set.
  StationView copyWithWaiting(CustomerWaitingView w) => StationView(
        campaignId: campaignId,
        campaignName: campaignName,
        sessionId: sessionId,
        link: link,
        phase: phase,
        breakOptions: breakOptions,
        call: this.call,
        dispositions: dispositions,
        notes: notes,
        audio: audio,
        customerWaiting: w,
      );
}
