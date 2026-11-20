import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_copy.dart' show leftOfflineCopy, suppressOutcomeNotListedCopy;
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';
import 'package:magick_agency_agent/features/station/station_reads.dart';
import 'package:magick_agency_agent/features/station/widgets/action_buttons.dart';

import 'station_harness.dart';

/// The station's screens, one per state (AS1, design-spec §2–§4, the phone column): what each
/// shows, its one main action, and what is hidden rather than greyed.
void main() {
  String? bandTitle(WidgetTester tester) => tester.widget<Text>(find.byKey(const Key('band-title'))).data;

  group('02 Ready (available)', () {
    testWidgets('a green band, "Next call is coming…", and the wait counted from phaseSince', (tester) async {
      final h = await pumpStation(tester, station(phaseSince: t0.subtract(const Duration(seconds: 100))));
      expect(find.byKey(const Key('band-tone-ready')), findsOneWidget);
      expect(bandTitle(tester), StationCopy.ready);
      expect(find.text(StationCopy.readySubtitle), findsOneWidget);
      expect(find.text(StationCopy.nextCallComing), findsOneWidget);
      expect(find.text('Waiting: 1:40'), findsOneWidget);
      expect(find.text('1:40'), findsOneWidget, reason: 'the band\'s clock');
      await h.advance(const Duration(seconds: 2));
      expect(find.text('Waiting: 1:42'), findsOneWidget);
      // One main action: Take break. No call buttons, no Finish work on the screen (it is in ⋮ More).
      expect(find.byKey(const Key('take-break')), findsOneWidget);
      expect(find.byKey(const Key('leave')), findsNothing);
      expect(find.byKey(const Key('hang-up')), findsNothing);
    });

    testWidgets('My day: calls today, talk time and numbers dialled from today\'s own stats', (tester) async {
      await pumpStation(tester, station(), myDay: const MyDayView(callsToday: 42, talkSeconds: 6720, dialled: 97));
      expect(find.text(StationCopy.myDay), findsOneWidget);
      expect(find.byKey(const Key('my-day-calls')), findsOneWidget);
      expect(find.text('42'), findsOneWidget);
      expect(find.text('1h 52m'), findsOneWidget);
      expect(find.text('97'), findsOneWidget);
      // No target and no Will pay until the server sends them (BE-1, BE-2): no bar, no tile.
      expect(find.byKey(const Key('my-day-bar')), findsNothing);
      expect(find.byKey(const Key('my-day-will-pay')), findsNothing);
    });

    testWidgets('My day with a target and Will pay: "/ 120", a bar, and Will pay in the third tile', (tester) async {
      await pumpStation(tester, station(), myDay: const MyDayView(callsToday: 42, talkSeconds: 60, dialled: 97, target: 120, willPay: 12));
      expect(find.byKey(const Key('my-day-bar')), findsOneWidget);
      expect(find.byKey(const Key('my-day-will-pay')), findsOneWidget);
      expect(find.byKey(const Key('my-day-dialled')), findsNothing);
      expect(find.textContaining('/ 120'), findsOneWidget);
    });

    testWidgets('no My day while the read has nothing: no tile shows a number it does not have', (tester) async {
      await pumpStation(tester, station());
      expect(find.byKey(const Key('my-day')), findsNothing);
    });

    testWidgets('the call-later list: time chips and names, and who makes them by the campaign\'s routing', (tester) async {
      final items = [
        CallLaterItem(at: t0.add(const Duration(minutes: 2)), name: 'Anjali Devi'),
        CallLaterItem(at: DateTime(2026, 10, 31, 16, 30), name: 'K. Venkatesh'),
      ];
      // A pool campaign: another agent may get it (AS8).
      await pumpStation(tester, station(myContactsOffered: true), callLater: items);
      expect(find.text(StationCopy.myCallLaterList), findsOneWidget);
      expect(find.text('Anjali Devi'), findsOneWidget);
      expect(find.text('4:30 PM'), findsOneWidget);
      expect(find.text('in 2 min'), findsOneWidget, reason: 'due within five minutes');
      expect(find.text(StationCopy.callLaterPool), findsOneWidget);
    });

    testWidgets('a campaign that assigns contacts keeps the agent\'s call-laters theirs', (tester) async {
      final items = [CallLaterItem(at: DateTime(2026, 10, 31, 16, 30), name: 'K. Venkatesh')];
      await pumpStation(tester, station(myContactsOffered: true, assignsContacts: true), callLater: items);
      expect(find.text('K. Venkatesh'), findsOneWidget);
      expect(find.text(StationCopy.callLaterComesToYou), findsOneWidget);
    });

    testWidgets('a pool campaign\'s queue frame (BE-5) does not make them the agent\'s', (tester) async {
      final items = [CallLaterItem(at: DateTime(2026, 10, 31, 16, 30), name: 'K. Venkatesh')];
      await pumpStation(tester, station(myContactsOffered: true, queue: const QueueView(due: true)), callLater: items);
      expect(find.text(StationCopy.callLaterPool), findsOneWidget);
    });

    testWidgets('no call-later list when the read has none', (tester) async {
      await pumpStation(tester, station(myContactsOffered: true));
      expect(find.byKey(const Key('call-later-list')), findsNothing);
    });

    testWidgets('my-day\'s word on who makes them wins over the routing guess (AS8), and a late one says so', (tester) async {
      final items = [
        CallLaterItem(at: t0.subtract(const Duration(hours: 1)), name: 'Sunita Patil', overdue: true),
        CallLaterItem(at: DateTime(2026, 10, 31, 16, 30), name: ''),
      ];
      // A pool campaign (no queue), but the server says these come to this agent.
      await pumpStation(tester, station(), callLater: items, callLaterComesToMe: true);
      expect(find.text(StationCopy.callLaterComesToYou), findsOneWidget);
      expect(find.byKey(const Key('call-later-late')), findsOneWidget);
      expect(find.text(StationCopy.customer), findsOneWidget, reason: 'no name: never the number');
    });

    testWidgets('Start of day shows the target and today\'s call-laters when the server sends them', (tester) async {
      await pumpStation(
        tester,
        station(phase: AgentPhase.offline),
        myDay: const MyDayView(callsToday: 0, talkSeconds: 0, dialled: 0, target: 120),
        callLater: [CallLaterItem(at: DateTime(2026, 10, 31, 15), name: 'A'), CallLaterItem(at: DateTime(2026, 10, 31, 18), name: 'B')],
      );
      expect(find.text('120 calls'), findsOneWidget);
      expect(find.text('2 today'), findsOneWidget);
    });

    testWidgets('Finish work says what is left for today, and who will make it', (tester) async {
      await pumpStation(
        tester,
        station(),
        callLater: [CallLaterItem(at: DateTime(2026, 10, 31, 18), name: 'B')],
        callLaterGoesToPool: true,
      );
      await tapMore(tester, 'leave');
      expect(find.text('1 call later is left for today (6:00 PM). Another agent will make it.'), findsOneWidget);
    });

    testWidgets('02c: calls stopped by the supervisor is No calls right now, slate, and callers can still ring in', (tester) async {
      await pumpStation(tester, station(dialing: false));
      expect(find.byKey(const Key('band-tone-quiet')), findsOneWidget);
      expect(bandTitle(tester), StationCopy.noCallsNow);
      expect(find.text(StationCopy.callsStoppedBySupervisor), findsOneWidget);
      expect(find.text(StationCopy.callsWillStart), findsOneWidget);
      expect(find.textContaining(StationCopy.customersWhoRingIn), findsOneWidget);
      expect(find.text(StationCopy.nextCallComing), findsNothing);
      expect(find.byKey(const Key('take-break')), findsOneWidget);
    });

    testWidgets('Take break opens Which break? and starts the chosen one', (tester) async {
      final h = await pumpStation(tester, station());
      await tester.tap(find.byKey(const Key('take-break')));
      await settle(tester);
      expect(find.text(StationCopy.whichBreak), findsOneWidget);
      expect(find.text(StationCopy.whichBreakNow), findsOneWidget);
      await tester.tap(find.byKey(const Key('break-tea')));
      await settle(tester);
      expect(h.actions.calls, ['takeBreak']);
      expect(h.actions.args['takeBreak'], ['tea']);
    });

    testWidgets('Which break? tiles say a reason\'s minutes; one with no limit says none', (tester) async {
      await pumpStation(
        tester,
        station(breakOptions: const [BreakOption(code: 'tea', label: 'Tea', limitMinutes: 15), BreakOption(code: 'meeting', label: 'Meeting')]),
      );
      await tester.tap(find.byKey(const Key('take-break')));
      await settle(tester);
      expect(find.text('15 min'), findsOneWidget);
      expect(find.byKey(const Key('break-meeting')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const Key('break-meeting')), matching: find.textContaining('min')), findsNothing);
    });

    testWidgets('Finish work for today asks on a sheet, leaves, then goes back to the work list', (tester) async {
      final h = await pumpStation(tester, station());
      await tapMore(tester, 'leave');
      expect(find.text(StationCopy.finishWorkTitle), findsOneWidget);
      // The safe choice is the big one.
      expect(tester.widget<MainActionButton>(find.byKey(const Key('finish-no'))).label, StationCopy.noKeepWorking);
      await tester.tap(find.byKey(const Key('finish-no')));
      await settle(tester);
      expect(h.actions.calls, isNot(contains('leave')));
      await finishWork(tester);
      expect(h.actions.calls, containsAllInOrder(['dismissActionError', 'leave']));
      await settle(tester);
      expect(find.text('campaigns-home'), findsOneWidget);
    });

    testWidgets('a call arriving closes Finish work without leaving', (tester) async {
      final h = await pumpStation(tester, station());
      await tapMore(tester, 'leave');
      expect(find.text(StationCopy.finishWorkTitle), findsOneWidget);
      await h.setView(station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      await settle(tester);
      expect(find.text(StationCopy.finishWorkTitle), findsNothing);
      expect(find.text('Priya Raman'), findsWidgets);
      expect(h.actions.calls, isNot(contains('leave')));
    });

    testWidgets('Finish work confirmed in the instant a call arrives: the call comes first', (tester) async {
      final h = await pumpStation(tester, station());
      await tapMore(tester, 'leave');
      final yes = tester.widget<SecondaryActionButton>(find.byKey(const Key('finish-yes')));
      h.container.read(h.holder.notifier).set(station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      yes.onPressed!(); // the tap lands before the sheet has closed itself
      await settle(tester);
      expect(h.actions.calls, isNot(contains('leave')));
      expect(find.text(StationCopy.finishCallFirst), findsOneWidget);
      expect(find.text('campaigns-home'), findsNothing);
    });

    testWidgets('a call arriving closes Which break? without taking a break', (tester) async {
      final h = await pumpStation(tester, station());
      await tester.tap(find.byKey(const Key('take-break')));
      await settle(tester);
      expect(find.byKey(const Key('break-tea')), findsOneWidget);
      await h.setView(station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      await settle(tester);
      expect(find.byKey(const Key('break-tea')), findsNothing);
      expect(h.actions.calls, isNot(contains('takeBreak')));
    });

    testWidgets('a break picked in the instant a call arrives is not started', (tester) async {
      final h = await pumpStation(tester, station());
      await tester.tap(find.byKey(const Key('take-break')));
      await settle(tester);
      final tea = tester.widget<InkWell>(find.descendant(of: find.byKey(const Key('break-tea')), matching: find.byType(InkWell)));
      h.container.read(h.holder.notifier).set(station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      tea.onTap!();
      await settle(tester);
      expect(h.actions.calls, isNot(contains('takeBreak')));
    });

    testWidgets('Finish work with no network: off the station here, and told so plainly', (tester) async {
      final h = await pumpStation(tester, station());
      h.actions.leaveOutcome = LeaveOutcome.leftOffline;
      await finishWork(tester);
      expect(find.text('campaigns-home'), findsOneWidget);
      expect(find.byKey(const Key('left-offline')), findsOneWidget);
      expect(find.text(leftOfflineCopy), findsOneWidget);
    });

    testWidgets('a refused Finish work keeps the agent here, with the reason', (tester) async {
      final h = await pumpStation(tester, station());
      h.actions.onCall = (name) {
        if (name == 'leave') h.container.read(h.holder.notifier).set(station(actionError: 'Your station is still open — try again.'));
      };
      await finishWork(tester);
      expect(find.text('campaigns-home'), findsNothing);
      expect(find.text('Your station is still open — try again.'), findsOneWidget);
    });

    testWidgets('a call that did not connect is a one-line banner for 6 seconds, in the station\'s own words', (tester) async {
      final h = await pumpStation(tester, station());
      await h.setView(
        station(
          release: const ReleaseView(
            headline: 'No answer',
            detail: "Nobody picked up. We'll try again later.",
            tone: ReleaseTone.neutral,
            requiresDisposition: false,
          ),
        ),
      );
      expect(find.text(StationCopy.lastCallNotConnected), findsOneWidget);
      expect(find.text('No answer'), findsNothing, reason: 'never the server\'s sentence (AS15)');
      await h.advance(const Duration(seconds: 5));
      expect(find.text(StationCopy.lastCallNotConnected), findsOneWidget);
      await h.advance(const Duration(seconds: 2));
      expect(find.text(StationCopy.lastCallNotConnected), findsNothing);
    });

    testWidgets('missed release: "While you were away" until dismissed', (tester) async {
      final h = await pumpStation(
        tester,
        station(
          missedRelease: const MissedReleaseView(headline: 'The customer hung up', detail: 'The call ended.'),
        ),
      );
      expect(find.text('While you were away: The customer hung up'), findsOneWidget);
      await tester.tap(find.descendant(of: find.byKey(const Key('missed-release')), matching: find.byTooltip('Dismiss')));
      expect(h.actions.calls, ['dismissMissedRelease']);
    });

    testWidgets('an action error shows inline and can be dismissed', (tester) async {
      final h = await pumpStation(tester, station(actionError: 'That break reason is no longer available. Pick another.'));
      expect(find.byKey(const Key('action-error')), findsOneWidget);
      await tester.tap(find.descendant(of: find.byKey(const Key('action-error')), matching: find.byTooltip('Dismiss')));
      expect(h.actions.calls, ['dismissActionError']);
    });

    testWidgets('⋮ More: Sound always, Finish work last; Sound holds the dark screen switch (AS14)', (tester) async {
      await pumpStation(tester, station());
      await openMore(tester);
      expect(find.byKey(const Key('station-sound')), findsOneWidget);
      expect(find.byKey(const Key('leave')), findsOneWidget);
      expect(find.byKey(const Key('my-contacts')), findsNothing, reason: 'no My contacts on this campaign');
      expect(find.byKey(const Key('switch-softphone')), findsNothing, reason: 'the soft phone is off');
      await tester.tap(find.byKey(const Key('station-sound')));
      await settle(tester);
      expect(find.byKey(const Key('sound-sheet')), findsOneWidget);
      expect(find.byKey(const Key('sound-dark')), findsOneWidget);
    });
  });

  group('01 Start of day, 07 On break, Paused', () {
    testWidgets('Start of day: "Namaste", today\'s work, Start work, which cannot double-fire', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.offline));
      expect(find.byKey(const Key('band-tone-start')), findsOneWidget);
      expect(bandTitle(tester), 'Namaste, Sunita');
      expect(find.text(StationCopy.todaysWork), findsOneWidget);
      expect(find.text(StationCopy.callsComeToMe), findsOneWidget);
      expect(find.text(StationCopy.iDialTheNumber), findsNothing, reason: 'hidden while the soft phone is off');
      await tester.tap(find.byKey(const Key('go-available')));
      expect(h.actions.calls, ['goAvailable']);
      await h.setView(station(phase: AgentPhase.offline, busy: StationBusy.goingAvailable));
      expect(find.text(StationCopy.starting), findsOneWidget);
      await tester.tap(find.byKey(const Key('go-available')));
      expect(h.actions.count('goAvailable'), 1);
    });

    testWidgets('Start of day with no name says "Namaste"', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.offline), agentName: null);
      expect(bandTitle(tester), 'Namaste');
    });

    testWidgets('"I dial the number": Start work switches to the soft phone instead', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.offline), availability: softphoneOn);
      await tester.tap(find.byKey(const Key('mode-i-dial')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('go-available')));
      await settle(tester);
      expect(h.host.calls, ['switchToSoftphone']);
      expect(h.actions.calls, isNot(contains('goAvailable')));
    });

    testWidgets('On break: amber, the reason, the time used, Start calls again and Finish work', (tester) async {
      final h = await pumpStation(
        tester,
        station(
          phase: AgentPhase.onBreak,
          onBreak: BreakInfo(code: 'lunch', label: 'Lunch', since: t0.subtract(const Duration(minutes: 5, seconds: 12))),
        ),
      );
      expect(find.byKey(const Key('band-tone-onBreak')), findsOneWidget);
      expect(bandTitle(tester), 'On break · Lunch');
      expect(find.text(StationCopy.noCallsWillCome), findsOneWidget);
      expect(find.text('5:12'), findsWidgets);
      expect(find.byKey(const Key('leave')), findsOneWidget);
      expect(find.byKey(const Key('take-break')), findsNothing);
      await tester.tap(find.byKey(const Key('end-break')));
      expect(h.actions.calls, ['endBreak']);
    });

    testWidgets('a break with no limit never turns; after 30 minutes it says how long it has been', (tester) async {
      await pumpStation(
        tester,
        station(
          phase: AgentPhase.onBreak,
          onBreak: BreakInfo(code: 'lunch', label: 'Lunch', since: t0.subtract(const Duration(minutes: 31))),
        ),
      );
      expect(find.byKey(const Key('band-tone-onBreak')), findsOneWidget);
      expect(find.text(StationCopy.longBreak(31)), findsOneWidget);
    });

    testWidgets('Paused, you left the app (device_away): the amber screen, Start calls again', (tester) async {
      final h = await pumpStation(
        tester,
        station(
          phase: AgentPhase.onBreak,
          onBreak: BreakInfo(code: 'device_away', label: 'Away', since: DateTime(2026, 10, 31, 11, 19, 9)),
        ),
      );
      expect(find.byKey(const Key('band-tone-onBreak')), findsOneWidget);
      expect(bandTitle(tester), StationCopy.pausedTitle);
      expect(find.text(StationCopy.pausedSubtitle), findsOneWidget);
      expect(find.text('Paused at 11:19 AM.'), findsOneWidget);
      expect(find.text('0:51'), findsOneWidget);
      // IQ50: the window is said with the controller's own number.
      expect(find.text('Come back within 30 seconds and you’re returned to calls without a tap.'), findsOneWidget);
      await tester.tap(find.byKey(const Key('resume')));
      expect(h.actions.calls, ['endBreak']);
      await tester.tap(find.byKey(const Key('break-instead')));
      await settle(tester);
      // The app's own pause is never offered as a break reason.
      expect(find.byKey(const Key('break-device_away')), findsNothing);
      expect(find.byKey(const Key('break-lunch')), findsOneWidget);
    });
  });

  group('03 Call coming (reserved)', () {
    testWidgets('a blue band, the customer card, and no button: the call connects by itself (AS11)', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(countdown: 2)));
      expect(find.byKey(const Key('band-tone-coming')), findsOneWidget);
      expect(bandTitle(tester), StationCopy.callComing);
      expect(find.text(StationCopy.callComingSubtitle), findsOneWidget);
      expect(find.text('Priya Raman'), findsOneWidget);
      expect(find.text('+91 98400 12345'), findsOneWidget);
      // Three tiles: the first two hero fields and the last call's date (this work's call first).
      for (final v in ['Chennai', 'Platinum', '28 Oct']) {
        expect(find.text(v), findsOneWidget);
      }
      expect(find.text(StationCopy.connectsByItself), findsOneWidget);
      expect(find.byKey(const Key('hang-up')), findsNothing);
      expect(find.byKey(const Key('take-break')), findsNothing);
    });

    testWidgets('"What they said last time": the latest note, in quotes', (tester) async {
      await pumpStation(
        tester,
        station(
          phase: AgentPhase.reserved,
          call: call(priorAttempts: [PriorAttempt(at: DateTime(2026, 10, 28, 18, 5), outcomeLabel: 'Call later', notes: 'Asked to call after salary.')]),
        ),
      );
      expect(find.text(StationCopy.whatTheySaid), findsOneWidget);
      expect(find.text('“Asked to call after salary.”'), findsOneWidget);
    });

    testWidgets('with no name the number leads; with no call before, three hero tiles', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(name: null, priorAttempts: const [])));
      expect(find.text('+91 98400 12345'), findsOneWidget);
      for (final v in ['Chennai', 'Platinum', '₹12,400']) {
        expect(find.text(v), findsOneWidget);
      }
      expect(find.byKey(const Key('last-call-tile')), findsNothing);
    });

    testWidgets('the dial countdown does not rebuild the card', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      final before = tester.widget<Text>(find.text('Priya Raman'));
      await h.setView(station(phase: AgentPhase.reserved, call: call(countdown: 2)));
      expect(identical(tester.widget<Text>(find.text('Priya Raman')), before), isTrue);
    });

    testWidgets('a tap on the card opens every field and the caller ID', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(otherFields: 12)));
      await tester.tap(find.byKey(const Key('control-details')));
      await settle(tester);
      expect(find.text('Contact details'), findsOneWidget);
      expect(find.text('Field 0'), findsOneWidget);
      await tester.dragUntilVisible(find.text('+91 80471 82200'), find.byKey(const Key('details-sheet')), const Offset(0, -200));
      expect(find.text('+91 80471 82200'), findsOneWidget);
    });
  });

  group('04 On call', () {
    StationView onCall({
      AudioView audio = const AudioView(),
      BreakInfo? queued,
      NotesView notes = const NotesView(),
      StationBusy busy = StationBusy.none,
      List<DispositionOption>? outcomes,
    }) => station(
      phase: AgentPhase.onCall,
      call: call(bridgedAt: t0.subtract(const Duration(seconds: 134)), recording: true),
      audio: audio,
      queuedBreak: queued,
      notes: notes,
      busy: busy,
      dispositionOptions: outcomes,
    );

    testWidgets('a deep blue band with the name, a talk timer from bridgedAt, and Recorded', (tester) async {
      final h = await pumpStation(tester, onCall());
      expect(find.byKey(const Key('band-tone-onCall')), findsOneWidget);
      expect(bandTitle(tester), StationCopy.onCall);
      expect(find.text('2:14'), findsOneWidget);
      expect(find.text(StationCopy.recorded), findsOneWidget);
      await h.advance(const Duration(seconds: 3));
      expect(find.text('2:17'), findsOneWidget);
    });

    testWidgets('04c: the customer card, Last calls and the note; no script, nothing about AI (AS2)', (tester) async {
      await pumpStation(tester, onCall());
      expect(find.text(StationCopy.lastCalls), findsOneWidget);
      expect(find.text('No answer'), findsOneWidget);
      expect(find.byKey(const Key('notes-field')), findsOneWidget);
      expect(find.textContaining('AI'), findsNothing);
    });

    testWidgets('the talk timer ticks without rebuilding the rest of the screen', (tester) async {
      final h = await pumpStation(tester, onCall());
      final before = tester.widget<Text>(find.text(StationCopy.mute));
      await h.advance(const Duration(seconds: 2));
      expect(identical(tester.widget<Text>(find.text(StationCopy.mute)), before), isTrue);
    });

    testWidgets('the note reports every keystroke and shows its save status', (tester) async {
      final h = await pumpStation(tester, onCall());
      expect(find.text('Saves as you type.'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('notes-field')), 'Wants the late fee waived');
      expect(h.actions.args['updateNotes'], ['Wants the late fee waived']);
      await h.setView(onCall(notes: const NotesView(text: 'Wants the late fee waived', status: NotesStatus.retrying)));
      expect(find.text('Not saved yet — trying again. Still on this phone.'), findsOneWidget);
      await h.setView(onCall(notes: const NotesView(text: 'Wants the late fee waived', status: NotesStatus.saving)));
      expect(find.text('Saving…'), findsOneWidget);
      await h.setView(
        onCall(notes: const NotesView(text: 'Wants the late fee waived', status: NotesStatus.failed, changedElsewhere: true)),
      );
      expect(find.textContaining('Not saved to the server'), findsOneWidget);
      expect(find.text(StationCopy.notesChangedElsewhere), findsOneWidget);
    });

    testWidgets('Mute and Speaker: mute toggles; Speaker opens where to hear the call', (tester) async {
      const phone = AudioRouteOption(id: 'p', kind: AudioRouteKind.earpiece, name: 'Phone');
      const buds = AudioRouteOption(id: 'b', kind: AudioRouteKind.bluetooth, name: 'boAt Airdopes 141');
      final h = await pumpStation(tester, onCall(audio: const AudioView(route: buds, routes: [phone, buds])));
      await tester.tap(find.byKey(const Key('control-mute')));
      expect(h.actions.args['setMuted'], [true]);
      expect(find.text('boAt Airdopes 141'), findsOneWidget);
      await tester.tap(find.byKey(const Key('control-audio')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('route-p')));
      await settle(tester);
      expect(h.actions.args['setRoute'], [phone]);
    });

    testWidgets('on mute: Unmute, and the banner says the customer cannot hear', (tester) async {
      final h = await pumpStation(tester, onCall(audio: const AudioView(muted: true)));
      expect(find.text(StationCopy.unmute), findsOneWidget);
      expect(find.text(StationCopy.onMute), findsOneWidget);
      await tester.tap(find.byKey(const Key('control-mute')));
      expect(h.actions.args['setMuted'], [false]);
    });

    testWidgets('Slide to end call: a full slide ends it once; a short one or a tap does not (AS3)', (tester) async {
      final h = await pumpStation(tester, onCall());
      expect(find.text(StationCopy.slideToEnd), findsOneWidget);
      await slideToEnd(tester, fraction: 0.3);
      await settle(tester);
      expect(h.actions.count('hangUp'), 0);
      await tester.tap(find.byKey(const Key('hang-up')));
      await settle(tester);
      expect(h.actions.count('hangUp'), 0, reason: 'a tap is not a slide');
      await slideToEnd(tester);
      await settle(tester);
      expect(h.actions.count('hangUp'), 1);
    });

    testWidgets('Don\'t call again on the call when the campaign has no such tile: asks first, then marks', (tester) async {
      final outcomes = dispositions.where((d) => !d.suppresses).toList();
      final h = await pumpStation(tester, onCall(outcomes: outcomes));
      await tester.ensureVisible(find.byKey(const Key('control-dnc')));
      await tester.tap(find.byKey(const Key('control-dnc')));
      await settle(tester);
      expect(find.text(StationCopy.stopCallingTitle), findsOneWidget);
      expect(find.text('Priya Raman · +91 98400 12345'), findsOneWidget);
      await tester.tap(find.byKey(const Key('confirm-no')));
      await settle(tester);
      expect(h.actions.calls, isNot(contains('markDnc')));
      await tester.tap(find.byKey(const Key('control-dnc')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('confirm-yes')));
      await settle(tester);
      expect(h.actions.args['markDnc'], [null, 'a1'], reason: 'the call the sheet named');
    });

    testWidgets('with a Don\'t call again tile the row is not on the call: the tile is the way', (tester) async {
      await pumpStation(tester, onCall());
      expect(find.byKey(const Key('control-dnc')), findsNothing);
    });

    testWidgets('no break button on the call (AS10); a break booked for after it shows, and ✕ cancels it', (tester) async {
      final h = await pumpStation(tester, onCall());
      expect(find.byKey(const Key('break-after-call')), findsNothing);
      await h.setView(onCall(queued: const BreakInfo(code: 'lunch', label: 'Lunch')));
      expect(find.text('Lunch after this call'), findsOneWidget);
      await tester.tap(find.byKey(const Key('cancel-queued-break')));
      expect(h.actions.calls, contains('cancelQueuedBreak'));
    });

    testWidgets('a phone call interruption: a red band, the customer cannot hear, and Back unmutes', (tester) async {
      final h = await pumpStation(tester, onCall(audio: const AudioView(muted: true, interruption: AudioInterruption.phoneCall)));
      expect(find.byKey(const Key('band-tone-problem')), findsOneWidget);
      expect(find.text('Your phone took another call'), findsOneWidget);
      expect(find.text('The customer can’t hear you'), findsOneWidget);
      await tester.tap(find.text('Back to Priya (unmute)'));
      expect(h.actions.args['setMuted'], [false]);
    });

    testWidgets('a blocked microphone says so and opens Settings', (tester) async {
      final h = await pumpStation(tester, onCall(audio: const AudioView(micProblem: MicProblem.permissionDenied)));
      expect(find.text('Your microphone is blocked — the customer cannot hear you.'), findsOneWidget);
      await tester.tap(find.text('Open Settings'));
      expect(h.settingsOpened, 1);
    });

    testWidgets('on a call ⋮ More holds only Sound: no Finish work, no soft phone', (tester) async {
      await pumpStation(tester, onCall(), availability: softphoneOn);
      await openMore(tester);
      expect(find.byKey(const Key('station-sound')), findsOneWidget);
      expect(find.byKey(const Key('leave')), findsNothing);
      expect(find.byKey(const Key('switch-softphone')), findsNothing);
    });
  });

  group('05 What happened? (wrap-up)', () {
    StationView wrap({
      WrapupView? w,
      String? saved,
      StationBusy busy = StationBusy.none,
      NotesView notes = const NotesView(),
      String? dnc,
      ReleaseView release = hungUpRelease,
      QueueView? queue,
      bool assigns = false,
    }) => station(
      phase: AgentPhase.wrapup,
      assignsContacts: assigns,
      call: call(bridgedAt: t0.subtract(const Duration(minutes: 3))),
      release: release,
      wrapup: w ?? wrapup(),
      dispositionSaved: saved,
      dncOutcome: dnc,
      busy: busy,
      notes: notes,
      queue: queue,
    );

    testWidgets('a purple band with the time left; at zero with nothing picked it turns to Time is over (05d)', (tester) async {
      final h = await pumpStation(tester, wrap());
      expect(find.byKey(const Key('band-tone-happened')), findsOneWidget);
      expect(bandTitle(tester), StationCopy.whatHappened);
      expect(find.text(StationCopy.chooseOneThenSave), findsOneWidget);
      expect(find.text('0:30'), findsOneWidget);
      expect(find.byKey(const Key('wrapup-bar')), findsOneWidget);
      await h.advance(const Duration(seconds: 12));
      expect(find.text('0:18'), findsOneWidget);
      expect(find.byKey(const Key('time-over')), findsNothing);
      await h.advance(const Duration(seconds: 40));
      expect(find.text('0:00'), findsOneWidget);
      expect(find.textContaining(RegExp(r'-\d')), findsNothing);
      expect(find.byKey(const Key('band-tone-over')), findsOneWidget);
      expect(bandTitle(tester), StationCopy.timeOver);
      expect(find.text(StationCopy.timeOverBanner), findsOneWidget);
      // Nothing is ever picked for the agent.
      expect(h.actions.calls, isNot(contains('submitDisposition')));
    });

    testWidgets('a supervisor hold with no deadline has no ring and says who holds it', (tester) async {
      await pumpStation(tester, wrap(w: wrapup(noTimer: true, hold: WrapupHold.supervisor)));
      expect(find.byKey(const Key('wrapup-bar')), findsNothing);
      expect(find.byKey(const Key('wrapup-digits')), findsNothing);
      expect(find.text('Held by your supervisor'), findsOneWidget);
      expect(find.text(StationCopy.heldBanner), findsOneWidget);
    });

    testWidgets('tiles two across with a picture each; the picked one has a tick', (tester) async {
      await pumpStation(tester, wrap());
      final a = tester.getRect(find.byKey(const Key('outcome-interested')));
      final b = tester.getRect(find.byKey(const Key('outcome-not_interested')));
      expect(a.top, b.top, reason: 'two across');
      expect(find.byIcon(Icons.thumb_up_outlined), findsOneWidget);
      expect(find.byIcon(Icons.schedule), findsOneWidget);
      expect(find.byIcon(Icons.block), findsOneWidget);
      await tester.tap(find.byKey(const Key('outcome-interested')));
      await tester.pump();
      expect(find.byIcon(Icons.check_circle), findsOneWidget);
    });

    testWidgets('Save stays in place, faded; pressing it says what is missing (spec §6.1)', (tester) async {
      final h = await pumpStation(tester, wrap());
      expect(find.byKey(const Key('save-blocked')), findsNothing);
      expect(tester.widget<MainActionButton>(find.byKey(const Key('save-outcome'))).dimmed, isTrue);
      await tester.tap(find.byKey(const Key('save-outcome')));
      await tester.pump();
      expect(find.text(StationCopy.chooseOneFirst), findsWidgets);
      expect(h.actions.calls, isNot(contains('submitDisposition')));

      await tester.tap(find.byKey(const Key('outcome-wrong')));
      await tester.pump();
      expect(find.byKey(const Key('note-needed')), findsOneWidget);
      await tester.enterText(find.byKey(const Key('notes-field')), '   ');
      await tester.pump();
      expect(tester.widget<MainActionButton>(find.byKey(const Key('save-outcome'))).dimmed, isTrue);
      await tester.enterText(find.byKey(const Key('notes-field')), 'Number belongs to a shop');
      await tester.pump();
      expect(find.byKey(const Key('save-blocked')), findsNothing);
      expect(find.byKey(const Key('note-needed')), findsNothing);
      expect(tester.widget<MainActionButton>(find.byKey(const Key('save-outcome'))).dimmed, isFalse);

      await tester.tap(find.byKey(const Key('save-outcome')));
      await tester.pump();
      expect(h.actions.args['submitDisposition'], ['wrong', 'Number belongs to a shop', null]);
    });

    testWidgets('Call later: a sheet with large chips, who will call, OK, then one summary row (05b)', (tester) async {
      final h = await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20, 30));
      await tester.tap(find.byKey(const Key('outcome-callback')));
      await settle(tester);
      expect(find.text(StationCopy.callWhen), findsOneWidget);
      for (final label in ['In 1 hour', 'Today 6:00 PM', 'Tomorrow 10:00 AM', 'Tomorrow 6:00 PM', 'Other time']) {
        expect(find.text(label), findsOneWidget);
      }
      expect(find.textContaining('Times are in your timezone'), findsNothing, reason: 'dropped (spec §8)');
      expect(tester.widget<MainActionButton>(find.byKey(const Key('follow-up-ok'))).onPressed, isNull);
      await tester.tap(find.byKey(const Key('callback-tomorrowMorning')));
      await tester.pump();
      expect(find.text('Sun 1 Nov at 10:00 AM'), findsOneWidget);
      // A pool campaign: the line says so.
      expect(find.text(StationCopy.callWillBeMade('Sun 1 Nov at 10:00 AM')), findsOneWidget);
      await tester.tap(find.byKey(const Key('follow-up-ok')));
      await settle(tester);
      expect(find.text('Call later · Sun 1 Nov at 10:00 AM'), findsOneWidget);
      expect(find.text(StationCopy.change), findsOneWidget);
      await tester.tap(find.byKey(const Key('save-outcome')));
      await tester.pump();
      expect(h.actions.args['submitDisposition'], ['callback', null, DateTime(2026, 11, 1, 10)]);
    });

    testWidgets('Call later on a campaign that assigns contacts: "This call will come to you"', (tester) async {
      await pumpStation(tester, wrap(assigns: true), now: DateTime(2026, 10, 31, 11, 20, 30));
      await tester.tap(find.byKey(const Key('outcome-callback')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('callback-todayEvening')));
      await tester.pump();
      expect(find.text(StationCopy.callWillComeToYou('Sat 31 Oct at 6:00 PM')), findsOneWidget);
    });

    testWidgets('Call later on a pool campaign that sends a queue (BE-5): another agent may get the call', (tester) async {
      await pumpStation(tester, wrap(queue: const QueueView(due: true)), now: DateTime(2026, 10, 31, 11, 20, 30));
      await tester.tap(find.byKey(const Key('outcome-callback')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('callback-todayEvening')));
      await tester.pump();
      expect(find.text(StationCopy.callWillBeMade('Sat 31 Oct at 6:00 PM')), findsOneWidget);
      expect(find.text(StationCopy.callWillComeToYou('Sat 31 Oct at 6:00 PM')), findsNothing);
      await tester.tap(find.byKey(const Key('follow-up-ok')));
      await settle(tester);
    });

    testWidgets('Call later: my-day\'s comes_to_me wins over the campaign\'s mode', (tester) async {
      await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20, 30), callLaterComesToMe: true);
      await tester.tap(find.byKey(const Key('outcome-callback')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('callback-todayEvening')));
      await tester.pump();
      expect(find.text(StationCopy.callWillComeToYou('Sat 31 Oct at 6:00 PM')), findsOneWidget);
    });

    testWidgets('Back keeps the tile picked; the row and Save say when to call is still needed', (tester) async {
      await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
      await tester.tap(find.byKey(const Key('outcome-callback')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('follow-up-back')));
      await settle(tester);
      expect(find.byKey(const Key('follow-up-summary')), findsOneWidget);
      expect(find.text(StationCopy.chooseWhen), findsWidgets);
      expect(tester.widget<MainActionButton>(find.byKey(const Key('save-outcome'))).dimmed, isTrue);
      await tester.tap(find.byKey(const Key('follow-up-change')));
      await settle(tester);
      expect(find.byKey(const Key('follow-up-sheet')), findsOneWidget);
    });

    testWidgets('Other time goes through date then time; a time already gone cannot be OK\'d', (tester) async {
      await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
      await tester.tap(find.byKey(const Key('outcome-callback')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('callback-picked')));
      await settle(tester);
      // Date: choose today (31) and confirm.
      await tester.tap(find.text('31'));
      await tester.tap(find.text('OK').last);
      await settle(tester);
      // Time: switch to text entry, 09:05 today has passed.
      await tester.tap(find.byIcon(Icons.keyboard_outlined));
      await settle(tester);
      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), '9');
      await tester.enterText(fields.at(1), '05');
      await tester.pump();
      final am = find.text('AM');
      if (am.evaluate().isNotEmpty) await tester.tap(am.last);
      await tester.tap(find.text('OK').last);
      await settle(tester);
      expect(find.text('Sat 31 Oct at 9:05 AM'), findsOneWidget);
      expect(tester.widget<MainActionButton>(find.byKey(const Key('follow-up-ok'))).onPressed, isNull);
    });

    testWidgets('Don\'t call again asks on a sheet before it saves (05c)', (tester) async {
      final h = await pumpStation(tester, wrap());
      await tester.tap(find.byKey(const Key('outcome-dnc')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('save-outcome')));
      await settle(tester);
      expect(find.text(StationCopy.stopCallingTitle), findsOneWidget);
      expect(find.text('Priya Raman · +91 98400 12345'), findsOneWidget);
      expect(find.text(StationCopy.stopCallingBody), findsOneWidget);
      await tester.tap(find.byKey(const Key('confirm-no')));
      await settle(tester);
      expect(h.actions.calls, isNot(contains('submitDisposition')));
      await tester.tap(find.byKey(const Key('save-outcome')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('confirm-yes')));
      await settle(tester);
      expect(h.actions.args['submitDisposition'], ['dnc', null, null]);
    });

    testWidgets('Save & break: Which break? first (after this call), then the break, then the save', (tester) async {
      final h = await pumpStation(tester, wrap());
      await tester.tap(find.byKey(const Key('outcome-interested')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('save-and-break')));
      await settle(tester);
      expect(find.text(StationCopy.whichBreakAfterCall), findsOneWidget);
      await tester.tap(find.byKey(const Key('break-lunch')));
      await settle(tester);
      expect(h.actions.calls, containsAllInOrder(['takeBreak', 'submitDisposition']));
      expect(h.actions.args['takeBreak'], ['lunch']);
      expect(h.actions.args['submitDisposition'], ['interested', null, null]);
    });

    testWidgets('Save & break: before a tile is picked it says why; Cancel on Which break? saves nothing', (tester) async {
      final h = await pumpStation(tester, wrap());
      await tester.tap(find.byKey(const Key('save-and-break')));
      await tester.pump();
      expect(find.text(StationCopy.chooseOneFirst), findsWidgets);
      await tester.tap(find.byKey(const Key('outcome-interested')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('save-and-break')));
      await settle(tester);
      await tester.tap(find.text(StationCopy.cancel));
      await settle(tester);
      expect(h.actions.calls, isNot(contains('takeBreak')));
      expect(h.actions.calls, isNot(contains('submitDisposition')));
    });

    testWidgets('after a line drop: "The call was cut."', (tester) async {
      await pumpStation(
        tester,
        wrap(
          release: const ReleaseView(
            headline: 'Call lost — your connection dropped',
            detail: "Check your network. You'll need to go available again.",
            tone: ReleaseTone.danger,
            requiresDisposition: true,
          ),
        ),
      );
      expect(find.text(StationCopy.callWasCut), findsOneWidget);
    });

    testWidgets('Speak a note puts the cursor in the note, so the keyboard\'s microphone can dictate (AS13)', (tester) async {
      await pumpStation(tester, wrap());
      await tester.tap(find.byKey(const Key('speak-note')));
      await tester.pump();
      final field = tester.widget<TextField>(find.byKey(const Key('notes-field')));
      expect(field.focusNode!.hasFocus, isTrue);
    });

    testWidgets('notes typed on the call carry into What happened? in the same field', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.onCall, call: call(bridgedAt: t0)));
      await tester.enterText(find.byKey(const Key('notes-field')), 'Salary on the 1st');
      await h.setView(wrap(notes: const NotesView(text: 'Salary on the 1st', status: NotesStatus.saved)));
      final field = tester.widget<TextField>(find.byKey(const Key('notes-field')));
      expect(field.controller!.text, 'Salary on the 1st');
    });

    testWidgets('busy while saving, then "Saved · Interested", announced', (tester) async {
      final h = await pumpStation(tester, wrap(busy: StationBusy.savingDisposition));
      expect(find.text('Saving…'), findsWidgets);
      await h.setView(wrap(saved: 'interested'));
      expect(find.text('Saved · Interested'), findsOneWidget);
      expect(find.text(StationCopy.nextCallSoon), findsOneWidget);
      final live = tester.getSemantics(find.byKey(const Key('phase-live-region')));
      expect(live.label, 'Saved');
      expect(find.byKey(const Key('dnc-outcome')), findsNothing);
      expect(find.byKey(const Key('time-over')), findsNothing);
    });

    testWidgets('a saved suppress outcome whose number could not go on the list says so (DS8)', (tester) async {
      await pumpStation(tester, wrap(saved: 'do_not_call', dnc: suppressOutcomeNotListedCopy));
      expect(find.byKey(const Key('outcome-saved')), findsOneWidget);
      expect(find.byKey(const Key('dnc-outcome')), findsOneWidget);
      expect(find.textContaining('It couldn’t go on this campaign’s Do Not Call list'), findsOneWidget);
    });
  });
}
