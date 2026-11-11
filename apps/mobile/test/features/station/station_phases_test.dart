import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_copy.dart' show leftOfflineCopy;
import 'package:magick_agency_agent/core/station/station_view.dart';

import 'station_harness.dart';

void main() {
  group('waiting (available)', () {
    testWidgets('says it is waiting and counts the time available from phaseSince', (tester) async {
      final h = await pumpStation(tester, station(phaseSince: t0.subtract(const Duration(seconds: 100))));
      expect(find.text('Available'), findsOneWidget);
      expect(find.text('Waiting for a call'), findsOneWidget);
      expect(find.textContaining('Keep this screen open so the next customer reaches you'), findsOneWidget);
      expect(find.text('Available for 01:40'), findsOneWidget);
      await h.advance(const Duration(seconds: 2));
      expect(find.text('Available for 01:42'), findsOneWidget);
      expect(find.text('Running'), findsOneWidget);
    });

    testWidgets('a paused campaign says no campaign calls come, and that callers can still ring in', (tester) async {
      await pumpStation(tester, station(dialing: false));
      expect(find.text('Campaign paused — no campaign calls for now'), findsOneWidget);
      expect(
        find.text('Customers who ring in can still reach you. Campaign calls start again when it’s running.'),
        findsOneWidget,
      );
      expect(find.text('Paused'), findsOneWidget);
      expect(find.text('Waiting for a call'), findsNothing);
    });

    testWidgets('Take a break opens the reasons and starts the chosen one', (tester) async {
      final h = await pumpStation(tester, station());
      await tester.tap(find.byKey(const Key('take-break')));
      await settle(tester);
      expect(find.textContaining('the break starts now'), findsOneWidget);
      await tester.tap(find.byKey(const Key('break-tea')));
      await settle(tester);
      expect(h.actions.calls, ['takeBreak']);
      expect(h.actions.args['takeBreak'], ['tea']);
    });

    testWidgets('Leave confirms, leaves, then goes back to the campaign list', (tester) async {
      final h = await pumpStation(tester, station());
      await tester.tap(find.byKey(const Key('leave')));
      await settle(tester);
      expect(find.text('Leave this station?'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Leave station'));
      await settle(tester);
      expect(h.actions.calls, containsAllInOrder(['dismissActionError', 'leave']));
      await settle(tester);
      expect(find.text('campaigns-home'), findsOneWidget);
    });

    testWidgets('a call arriving closes "Leave this station?" without leaving', (tester) async {
      final h = await pumpStation(tester, station());
      await tester.tap(find.byKey(const Key('leave')));
      await settle(tester);
      expect(find.text('Leave this station?'), findsOneWidget);
      await h.setView(station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      await settle(tester);
      expect(find.text('Leave this station?'), findsNothing);
      expect(find.text('Priya Raman'), findsWidgets);
      expect(h.actions.calls, isNot(contains('leave')));
    });

    testWidgets('Leave confirmed in the instant a call arrives: the call comes first', (tester) async {
      final h = await pumpStation(tester, station());
      await tester.tap(find.byKey(const Key('leave')));
      await settle(tester);
      final confirm = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Leave station'));
      h.container.read(h.holder.notifier).set(station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      confirm.onPressed!(); // the tap lands before the dialog has closed itself
      await settle(tester);
      expect(h.actions.calls, isNot(contains('leave')));
      expect(find.text('Finish this call first — leaving now would cut the customer off.'), findsOneWidget);
      expect(find.text('campaigns-home'), findsNothing);
    });

    testWidgets('a call arriving closes the break reasons without taking a break', (tester) async {
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
      final tea = tester.widget<ListTile>(find.byKey(const Key('break-tea')));
      h.container.read(h.holder.notifier).set(station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      tea.onTap!();
      await settle(tester);
      expect(h.actions.calls, isNot(contains('takeBreak')));
    });

    testWidgets('Leave with no network: off the station here, and told so plainly', (tester) async {
      final h = await pumpStation(tester, station());
      h.actions.leaveOutcome = LeaveOutcome.leftOffline;
      await tester.tap(find.byKey(const Key('leave')));
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Leave station'));
      await settle(tester);
      expect(find.text('campaigns-home'), findsOneWidget);
      expect(find.byKey(const Key('left-offline')), findsOneWidget);
      expect(find.text(leftOfflineCopy), findsOneWidget);
    });

    testWidgets('a refused leave keeps the agent here, with the reason', (tester) async {
      final h = await pumpStation(tester, station());
      h.actions.onCall = (name) {
        if (name == 'leave') h.container.read(h.holder.notifier).set(station(actionError: 'Your station is still open — try again.'));
      };
      await tester.tap(find.byKey(const Key('leave')));
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Leave station'));
      await settle(tester);
      expect(find.text('campaigns-home'), findsNothing);
      expect(find.text('Your station is still open — try again.'), findsOneWidget);
    });

    testWidgets('a release with no wrap-up is said briefly, then goes', (tester) async {
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
      expect(find.text('No answer'), findsOneWidget);
      await h.advance(const Duration(seconds: 9));
      expect(find.text('No answer'), findsNothing);
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
  });

  group('offline and break', () {
    testWidgets('offline offers Go available, with a busy state that cannot double-fire', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.offline));
      expect(find.text('Offline'), findsOneWidget);
      await tester.tap(find.byKey(const Key('go-available')));
      expect(h.actions.calls, ['goAvailable']);
      await h.setView(station(phase: AgentPhase.offline, busy: StationBusy.goingAvailable));
      expect(find.text('Going available…'), findsOneWidget);
      await tester.tap(find.byKey(const Key('go-available')));
      expect(h.actions.count('goAvailable'), 1);
    });

    testWidgets('on break shows the reason, the elapsed time and End break', (tester) async {
      final h = await pumpStation(
        tester,
        station(
          phase: AgentPhase.onBreak,
          onBreak: BreakInfo(code: 'lunch', label: 'Lunch', since: t0.subtract(const Duration(minutes: 5, seconds: 12))),
        ),
      );
      expect(find.text('On break — Lunch'), findsOneWidget);
      expect(find.text('On break for 05:12'), findsOneWidget);
      await tester.tap(find.byKey(const Key('end-break')));
      expect(h.actions.calls, ['endBreak']);
    });

    testWidgets('device_away: "Paused · you left the app", Resume goes available', (tester) async {
      final h = await pumpStation(
        tester,
        station(
          phase: AgentPhase.onBreak,
          onBreak: BreakInfo(code: 'device_away', label: 'Away', since: DateTime(2026, 10, 31, 11, 19, 9)),
        ),
      );
      expect(find.text('Paused · you left the app'), findsOneWidget);
      expect(find.text('No calls while you were away'), findsOneWidget);
      expect(find.textContaining('At 11:19 you switched to another app'), findsOneWidget);
      expect(find.text('00:51'), findsOneWidget);
      expect(find.text('Away (not a break)'), findsOneWidget);
      await tester.tap(find.byKey(const Key('resume')));
      expect(h.actions.calls, ['endBreak']);
      await tester.tap(find.byKey(const Key('break-instead')));
      await settle(tester);
      // The app's own pause is never offered as a break reason.
      expect(find.byKey(const Key('break-device_away')), findsNothing);
      expect(find.byKey(const Key('break-lunch')), findsOneWidget);
    });
  });

  group('ringing (reserved)', () {
    testWidgets('pops the contact: band, countdown, name, number, heroes, history', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(countdown: 2)));
      expect(find.text('Ringing — get ready'), findsOneWidget);
      expect(find.text('Customer is being dialled'), findsOneWidget);
      expect(find.byKey(const Key('dial-countdown')), findsOneWidget);
      expect(find.text('Priya Raman'), findsOneWidget);
      expect(find.text('+91 98400 12345 · Attempt 2'), findsOneWidget);
      for (final v in ['Chennai', 'Platinum', '₹12,400', '15 Nov']) {
        expect(find.text(v), findsOneWidget);
      }
      expect(find.byKey(const Key('auto-selected')), findsNothing);
      expect(find.text('Prior attempts (2)'), findsOneWidget);
      expect(find.text('More details (6)'), findsOneWidget);
      expect(find.byKey(const Key('hang-up')), findsOneWidget);
      // This campaign's attempt is listed before the other campaign's.
      final here = tester.getTopLeft(find.text('No answer')).dy;
      final there = tester.getTopLeft(find.text('Busy')).dy;
      expect(here, lessThan(there));
    });

    testWidgets('no countdown under late binding; the number leads without a name; guessed heroes say so', (tester) async {
      final c = call(name: null);
      final guessed = CallView(
        attemptId: c.attemptId,
        phoneE164: c.phoneE164,
        attemptNumber: 3,
        callerId: c.callerId,
        campaignName: c.campaignName,
        heroFields: c.heroFields,
        heroesConfigured: false,
        otherFields: const [],
        priorAttempts: const [],
      );
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: guessed));
      expect(find.byKey(const Key('dial-countdown')), findsNothing);
      expect(find.text('Connecting the customer…'), findsOneWidget);
      expect(find.text('+91 98400 12345'), findsOneWidget);
      expect(find.text('Attempt 3'), findsOneWidget);
      expect(find.byKey(const Key('auto-selected')), findsOneWidget);
      expect(find.textContaining('More details'), findsNothing);
    });

    testWidgets('the countdown ticks in the band without rebuilding the pop', (tester) async {
      final h = await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(countdown: 3)));
      final before = tester.widget<Text>(find.text('Priya Raman'));
      await h.setView(station(phase: AgentPhase.reserved, call: call(countdown: 2)));
      expect(find.text('2'), findsOneWidget);
      expect(identical(tester.widget<Text>(find.text('Priya Raman')), before), isTrue);
    });

    testWidgets('More details expands, and a long list gets a filter', (tester) async {
      await pumpStation(tester, station(phase: AgentPhase.reserved, call: call(otherFields: 12)));
      expect(find.text('Field 0'), findsNothing);
      await tester.tap(find.byKey(const Key('more-details')));
      await settle(tester);
      expect(find.text('Field 0'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('field-filter')), 'policy');
      await tester.pump();
      expect(find.text('Policy 7781'), findsOneWidget);
      expect(find.text('Field 0'), findsNothing);
      expect(find.text('1 of 12 fields'), findsOneWidget);
    });
  });

  group('on call', () {
    StationView onCall({
      AudioView audio = const AudioView(),
      BreakInfo? queued,
      NotesView notes = const NotesView(),
      StationBusy busy = StationBusy.none,
    }) => station(
      phase: AgentPhase.onCall,
      call: call(bridgedAt: t0.subtract(const Duration(seconds: 134)), recording: true),
      audio: audio,
      queuedBreak: queued,
      notes: notes,
      busy: busy,
    );

    testWidgets('green band with a talk timer that ticks from bridgedAt', (tester) async {
      final h = await pumpStation(tester, onCall());
      expect(find.text('On call'), findsOneWidget);
      expect(find.text('Priya Raman · +91 98400 12345'), findsOneWidget);
      expect(find.text('02:14'), findsOneWidget);
      expect(find.byKey(const Key('recording')), findsOneWidget);
      await h.advance(const Duration(seconds: 3));
      expect(find.text('02:17'), findsOneWidget);
    });

    testWidgets('the talk timer ticks without rebuilding the rest of the screen', (tester) async {
      final h = await pumpStation(tester, onCall());
      final before = tester.widget<Text>(find.text('Mute'));
      await h.advance(const Duration(seconds: 2));
      // Same widget instance: nothing above the timer rebuilt.
      expect(identical(tester.widget<Text>(find.text('Mute')), before), isTrue);
    });

    testWidgets('notes report every keystroke and show the save status', (tester) async {
      final h = await pumpStation(tester, onCall());
      expect(find.text('Notes save as you type.'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('notes-field')), 'Wants the late fee waived');
      expect(h.actions.args['updateNotes'], ['Wants the late fee waived']);
      await h.setView(
        onCall(
          notes: const NotesView(text: 'Wants the late fee waived', status: NotesStatus.retrying),
        ),
      );
      expect(find.text('Not saved yet — trying again. Still on this phone.'), findsOneWidget);
      await h.setView(
        onCall(
          notes: const NotesView(text: 'Wants the late fee waived', status: NotesStatus.saving),
        ),
      );
      expect(find.text('Saving…'), findsOneWidget);
      await h.setView(
        onCall(
          notes: const NotesView(text: 'Wants the late fee waived', status: NotesStatus.failed, changedElsewhere: true),
        ),
      );
      expect(find.textContaining('Not saved to the server'), findsOneWidget);
      expect(find.text('These notes were also changed elsewhere.'), findsOneWidget);
    });

    testWidgets('mute toggles and the audio sheet switches route', (tester) async {
      const phone = AudioRouteOption(id: 'p', kind: AudioRouteKind.earpiece, name: 'Phone');
      const buds = AudioRouteOption(id: 'b', kind: AudioRouteKind.bluetooth, name: 'boAt Airdopes 141');
      final h = await pumpStation(
        tester,
        onCall(
          audio: const AudioView(route: buds, routes: [phone, buds]),
        ),
      );
      await tester.tap(find.byKey(const Key('control-mute')));
      expect(h.actions.args['setMuted'], [true]);
      expect(find.text('boAt Airdopes 141'), findsOneWidget);
      await tester.tap(find.byKey(const Key('control-audio')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('route-p')));
      await settle(tester);
      expect(h.actions.args['setRoute'], [phone]);
    });

    testWidgets('Details opens every contact field and the caller ID', (tester) async {
      await pumpStation(tester, onCall());
      await tester.tap(find.byKey(const Key('control-details')));
      await settle(tester);
      expect(find.text('Contact details'), findsOneWidget);
      expect(find.text('Field 0'), findsOneWidget);
      expect(find.text('+91 80471 82200'), findsOneWidget);
    });

    testWidgets('Mark DNC asks first, in the console words, then marks', (tester) async {
      final h = await pumpStation(tester, onCall());
      await tester.tap(find.byKey(const Key('control-dnc')));
      await settle(tester);
      expect(find.text('Stop calling this number?'), findsOneWidget);
      expect(find.textContaining('+91 98400 12345 won’t be called again by Q4 Card Renewals'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await settle(tester);
      expect(h.actions.calls, isNot(contains('markDnc')));
      await tester.tap(find.byKey(const Key('control-dnc')));
      await settle(tester);
      await tester.tap(find.text('Don’t call in this campaign'));
      await settle(tester);
      expect(h.actions.calls, contains('markDnc'));
      expect(h.actions.args['markDnc'], [null, 'a1'], reason: 'the call the dialog named');
    });

    testWidgets('Break after this call queues a break; the queued pill cancels it', (tester) async {
      final h = await pumpStation(tester, onCall());
      await tester.tap(find.byKey(const Key('break-after-call')));
      await settle(tester);
      expect(find.text('The break starts when you finish this call.'), findsOneWidget);
      await tester.tap(find.byKey(const Key('break-lunch')));
      await settle(tester);
      expect(h.actions.args['takeBreak'], ['lunch']);
      await h.setView(
        onCall(
          queued: const BreakInfo(code: 'lunch', label: 'Lunch'),
        ),
      );
      expect(find.text('Break after this call — Lunch'), findsOneWidget);
      await tester.tap(find.byKey(const Key('cancel-queued-break')));
      expect(h.actions.calls, contains('cancelQueuedBreak'));
    });

    testWidgets('a phone call interruption says the customer cannot hear, and unmutes', (tester) async {
      final h = await pumpStation(tester, onCall(audio: const AudioView(muted: true, interruption: AudioInterruption.phoneCall)));
      expect(find.text('Your phone took another call'), findsOneWidget);
      expect(find.text('The customer can’t hear you'), findsOneWidget);
      expect(find.text('On call · 02:14 · your mic is muted'), findsOneWidget);
      await tester.tap(find.text('Back to Priya (unmute)'));
      expect(h.actions.args['setMuted'], [false]);
    });

    testWidgets('a blocked microphone says so and opens Settings', (tester) async {
      final h = await pumpStation(tester, onCall(audio: const AudioView(micProblem: MicProblem.permissionDenied)));
      expect(find.text('Your microphone is blocked — the customer cannot hear you.'), findsOneWidget);
      await tester.tap(find.text('Open Settings'));
      expect(h.settingsOpened, 1);
    });

    testWidgets('Leave is not offered mid-call', (tester) async {
      await pumpStation(tester, onCall());
      expect(find.byKey(const Key('leave')), findsNothing);
    });
  });

  group('wrap-up', () {
    StationView wrap({WrapupView? w, String? saved, StationBusy busy = StationBusy.none, NotesView notes = const NotesView()}) => station(
      phase: AgentPhase.wrapup,
      call: call(bridgedAt: t0.subtract(const Duration(minutes: 3))),
      release: hungUpRelease,
      wrapup: w ?? wrapup(),
      dispositionSaved: saved,
      busy: busy,
      notes: notes,
    );

    testWidgets('band names the release and drains; never below zero', (tester) async {
      final h = await pumpStation(tester, wrap());
      expect(find.text('Wrap-up'), findsOneWidget);
      expect(find.text('The customer hung up.'), findsOneWidget);
      expect(find.text('0:30'), findsOneWidget);
      expect(find.byKey(const Key('wrapup-bar')), findsOneWidget);
      await h.advance(const Duration(seconds: 12));
      expect(find.text('0:18'), findsOneWidget);
      await h.advance(const Duration(seconds: 40));
      expect(find.text('0:00'), findsOneWidget);
      expect(find.textContaining(RegExp(r'-\d')), findsNothing);
      // Held for the disposition, said in words.
      expect(find.text('Waiting on a disposition'), findsOneWidget);
    });

    testWidgets('a supervisor hold with no deadline has no bar and says who holds it', (tester) async {
      await pumpStation(tester, wrap(w: wrapup(noTimer: true, hold: WrapupHold.supervisor)));
      expect(find.byKey(const Key('wrapup-bar')), findsNothing);
      expect(find.byKey(const Key('wrapup-digits')), findsNothing);
      expect(find.text('Held by your supervisor'), findsOneWidget);
    });

    testWidgets('Save outcome is disabled with the reason until valid', (tester) async {
      final h = await pumpStation(tester, wrap());
      FilledButton save() => tester.widget<FilledButton>(find.byKey(const Key('save-outcome')));
      expect(find.text('How did it go? · Priya Raman'), findsOneWidget);
      expect(save().onPressed, isNull);
      expect(find.text('Pick an outcome to save this call.'), findsOneWidget);

      await tester.tap(find.byKey(const Key('outcome-wrong')));
      await tester.pump();
      expect(find.text('This outcome needs a note.'), findsOneWidget);
      expect(find.text('Notes (required)'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('notes-field')), '   ');
      await tester.pump();
      expect(save().onPressed, isNull);
      await tester.enterText(find.byKey(const Key('notes-field')), 'Number belongs to a shop');
      await tester.pump();
      expect(find.byKey(const Key('save-blocked')), findsNothing);
      expect(save().onPressed, isNotNull);

      await tester.ensureVisible(find.byKey(const Key('save-outcome')));
      await tester.tap(find.byKey(const Key('save-outcome')));
      await tester.pump();
      expect(h.actions.args['submitDisposition'], ['wrong', 'Number belongs to a shop', null]);
    });

    testWidgets('callback chips set a future time, show the zone and block until chosen', (tester) async {
      final h = await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20, 30));
      await tester.tap(find.byKey(const Key('outcome-callback')));
      await tester.pump();
      expect(find.text('This outcome needs a callback time.'), findsOneWidget);
      expect(find.text('Goes back to the campaign queue. It may not be you who calls.'), findsOneWidget);
      expect(find.textContaining('Times are in your timezone'), findsOneWidget);
      for (final label in ['In 1 hour', 'Tomorrow 10 am', 'Tomorrow 6 pm', 'Pick…']) {
        expect(find.text(label), findsOneWidget);
      }
      await tester.tap(find.byKey(const Key('callback-tomorrowMorning')));
      await tester.pump();
      expect(find.byKey(const Key('callback-resolved')), findsOneWidget);
      expect(find.textContaining('Sun, 1 Nov, 10:00'), findsOneWidget);

      await tester.tap(find.byKey(const Key('callback-inOneHour')));
      await tester.pump();
      expect(find.textContaining('Sat, 31 Oct, 12:21'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('save-outcome')));
      await tester.tap(find.byKey(const Key('save-outcome')));
      await tester.pump();
      expect(h.actions.args['submitDisposition'], ['callback', null, DateTime(2026, 10, 31, 12, 21)]);
    });

    testWidgets('Pick… goes through date then time; a time already gone is blocked', (tester) async {
      await pumpStation(tester, wrap(), now: DateTime(2026, 10, 31, 11, 20));
      await tester.tap(find.byKey(const Key('outcome-callback')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('callback-picked')));
      await settle(tester);
      // Date: choose today (31) and confirm.
      await tester.tap(find.text('31'));
      await tester.tap(find.text('OK'));
      await settle(tester);
      // Time: switch to text entry, 09:05 today has passed.
      await tester.tap(find.byIcon(Icons.keyboard_outlined));
      await settle(tester);
      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), '9');
      await tester.enterText(fields.at(1), '05');
      await tester.pump();
      final am = find.text('AM');
      if (am.evaluate().isNotEmpty) await tester.tap(am);
      await tester.tap(find.text('OK'));
      await settle(tester);
      expect(find.textContaining('Sat, 31 Oct, 09:05'), findsOneWidget);
      expect(find.text('That time has already passed. Pick when we should call back.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('save-outcome'))).onPressed, isNull);
    });

    testWidgets('a suppress code is styled as danger and needs a confirm to save', (tester) async {
      final h = await pumpStation(tester, wrap());
      expect(find.text('Stops calling'), findsOneWidget);
      expect(find.text('Success'), findsOneWidget);
      await tester.tap(find.byKey(const Key('outcome-dnc')));
      await tester.pump();
      await tester.ensureVisible(find.byKey(const Key('save-outcome')));
      await tester.tap(find.byKey(const Key('save-outcome')));
      await settle(tester);
      expect(find.text('Save and stop calling this number?'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await settle(tester);
      expect(h.actions.calls, isNot(contains('submitDisposition')));
      await tester.tap(find.byKey(const Key('save-outcome')));
      await settle(tester);
      await tester.tap(find.text('Save and stop calling'));
      await settle(tester);
      expect(h.actions.args['submitDisposition'], ['dnc', null, null]);
    });

    testWidgets('notes typed on the call carry into wrap-up in the same field', (tester) async {
      final h = await pumpStation(
        tester,
        station(
          phase: AgentPhase.onCall,
          call: call(bridgedAt: t0),
        ),
      );
      await tester.enterText(find.byKey(const Key('notes-field')), 'Salary on the 1st');
      await h.setView(
        wrap(
          notes: const NotesView(text: 'Salary on the 1st', status: NotesStatus.saved),
        ),
      );
      final field = tester.widget<TextField>(find.byKey(const Key('notes-field')));
      expect(field.controller!.text, 'Salary on the 1st');
    });

    testWidgets('busy while saving, then the saved outcome is shown and announced', (tester) async {
      final h = await pumpStation(tester, wrap(busy: StationBusy.savingDisposition));
      expect(find.text('Saving…'), findsWidgets);
      await h.setView(wrap(saved: 'interested'));
      expect(find.text('Saved — Interested'), findsOneWidget);
      expect(find.text('You’ll be available again when wrap-up ends.'), findsOneWidget);
      final live = tester.getSemantics(find.byKey(const Key('phase-live-region')));
      expect(live.label, 'Outcome saved');
    });
  });
}
