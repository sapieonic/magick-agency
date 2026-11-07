import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/phone_input.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/softphone/parts/number_field.dart';
import 'package:magick_agency_agent/features/softphone/parts/setup_section.dart';

import 'softphone_harness.dart';

void main() {
  Finder callButton() => find.descendant(of: find.byKey(const Key('dial-call')), matching: find.byType(FilledButton));

  group('ready', () {
    testWidgets('the pad writes keys, long-press 0 is +, Delete deletes and holding it clears', (tester) async {
      final h = await pumpSoftphone(tester, readyView());
      expect(find.text('Ready to dial'), findsOneWidget);
      await tester.tap(find.byKey(const Key('dial-key-5')));
      await tester.longPress(find.byKey(const Key('dial-key-0')));
      await tester.tap(find.byKey(const Key('dial-backspace')));
      await tester.longPress(find.byKey(const Key('dial-backspace')));
      expect(h.actions.calls, ['pressKey', 'pressKey', 'backspace', 'clearNumber']);
      expect(h.actions.calls.where((c) => c == 'pressKey'), hasLength(2));
    });

    testWidgets('long-press 0 sends +, a tap sends 0', (tester) async {
      final h = await pumpSoftphone(tester, readyView());
      final keys = <Object?>[];
      h.actions.onCall = (name) {
        if (name == 'pressKey') keys.add(h.actions.args['pressKey']!.single);
      };
      await tester.tap(find.byKey(const Key('dial-key-0')));
      await tester.longPress(find.byKey(const Key('dial-key-0')));
      expect(keys, ['0', '+']);
    });

    testWidgets('a double tap on Call places one call', (tester) async {
      final h = await pumpSoftphone(tester, readyView());
      h.actions.dialGate = Completer<void>();
      // The view does not say `placing` yet: only the panel's own guard stands
      // between the second tap and a second customer's phone ringing.
      await tester.tap(callButton());
      await tester.tap(callButton());
      await tester.pump();
      // The keyboard's Go on top of the taps does nothing either.
      await tester.showKeyboard(find.byKey(const Key('dial-number')));
      await tester.testTextInput.receiveAction(TextInputAction.go);
      await tester.pump();
      expect(h.actions.count('dial'), 1);

      h.actions.dialGate!.complete();
      await tester.pump();
      await tester.tap(callButton());
      await tester.pump();
      expect(h.actions.count('dial'), 2);
    });

    testWidgets('while placing, Call says Calling… and cannot be pressed', (tester) async {
      final h = await pumpSoftphone(tester, readyView(placing: true));
      expect(find.text('Calling…'), findsOneWidget);
      expect(tester.widget<FilledButton>(callButton()).onPressed, isNull);
      await tester.tap(callButton());
      expect(h.actions.count('dial'), 0);
    });

    testWidgets('while placing, the number, the pad and Delete are locked: the refusal must be about the number sent', (
      tester,
    ) async {
      final h = await pumpSoftphone(tester, readyView(placing: true));
      expect(tester.widget<TextField>(find.byKey(const Key('dial-number'))).enabled, isFalse);
      await tester.tap(find.byKey(const Key('dial-key-4')));
      await tester.tap(find.byKey(const Key('dial-backspace')));
      await tester.longPress(find.byKey(const Key('dial-key-0')));
      expect(h.actions.calls, isEmpty);
    });

    testWidgets('a number that cannot be called says why beside Call', (tester) async {
      await pumpSoftphone(tester, readyView(number: '98', canDial: false, dialBlockReason: 'That number is too short to call.'));
      expect(find.text('That number is too short to call.'), findsOneWidget);
      expect(tester.widget<FilledButton>(callButton()).onPressed, isNull);
    });

    testWidgets('a refused dial shows its reason and can be dismissed', (tester) async {
      final h = await pumpSoftphone(tester, readyView(dialError: 'Q4 Renewals is calling this customer right now.'));
      expect(find.byKey(const Key('dial-error')), findsOneWidget);
      await tester.tap(find.byTooltip('Dismiss'));
      expect(h.actions.calls, ['dismissDialError']);
    });

    testWidgets('typing one character is typing; two or more at once is a paste', (tester) async {
      final h = await pumpSoftphone(tester, readyView(number: ''));
      // As the core does: the number it keeps is what the field shows.
      h.actions.onCall = (name) {
        if (name == 'setNumber') h.container.read(h.holder.notifier).set(readyView(number: h.actions.args[name]!.single! as String));
      };
      await tester.enterText(find.byKey(const Key('dial-number')), '9');
      expect(h.actions.calls, ['setNumber']);
      expect(h.actions.args['setNumber'], ['9']);

      await tester.pump();
      h.actions.calls.clear();
      await tester.enterText(find.byKey(const Key('dial-number')), 'tel:+91-98123-45678');
      expect(h.actions.calls, ['pasteNumber']);
      expect(h.actions.args['pasteNumber'], ['tel:+91-98123-45678']);
      // The field shows the core's number, not the raw paste.
      expect(tester.widget<TextField>(find.byKey(const Key('dial-number'))).controller!.text, '9');
      await h.setView(readyView(number: '+919812345678'));
      expect(tester.widget<TextField>(find.byKey(const Key('dial-number'))).controller!.text, '+919812345678');
    });

    testWidgets('a character the core drops leaves the field too: a dash, a space, a second +, a digit past the limit', (
      tester,
    ) async {
      final h = await pumpSoftphone(tester, readyView(number: '9820461733'));
      // As the core does: it keeps only what can be dialled, and a number it
      // leaves unchanged changes nothing in the view.
      h.actions.onCall = (name) {
        if (name != 'setNumber') return;
        final kept = normaliseTypedNumber(sanitiseDialInput(h.actions.args[name]!.single! as String));
        h.container.read(h.holder.notifier).set(readyView(number: kept));
      };
      final field = find.byKey(const Key('dial-number'));
      TextEditingController controller() => tester.widget<TextField>(field).controller!;

      for (final typed in ['9820461733-', '9820461733 ', '9820461733+', '9820461733,', '9820461733(']) {
        await tester.enterText(field, typed);
        await tester.pump();
        expect(controller().text, '9820461733', reason: 'typed "$typed"');
      }

      // Typed in the middle: the caret stays where the agent was typing.
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(text: '98204-61733', selection: TextSelection.collapsed(offset: 6)),
      );
      await tester.pump();
      expect(controller().text, '9820461733');
      expect(controller().selection, const TextSelection.collapsed(offset: 5));

      final longest = '9' * maxDialLength;
      await h.setView(readyView(number: longest));
      await tester.enterText(field, '${longest}1');
      await tester.pump();
      expect(controller().text, longest);
      expect(h.actions.args['setNumber'], ['${longest}1']);
    });

    testWidgets('the paste detector reads what a paste put in at the caret', (tester) async {
      String inserted(String before, int caret, String after, int newCaret) => PasteAsNumberFormatter.insertedText(
        TextEditingValue(
          text: before,
          selection: TextSelection.collapsed(offset: caret),
        ),
        TextEditingValue(
          text: after,
          selection: TextSelection.collapsed(offset: newCaret),
        ),
      );
      expect(inserted('ab', 1, 'abab', 3), 'ba');
      expect(inserted('98123', 5, '9812345678', 10), '45678');
      expect(inserted('', 0, '+91 98123 45678', 15), '+91 98123 45678');
      expect(inserted('9812', 4, '981', 3), '');
    });

    testWidgets('the country chip shows until the number has its own code', (tester) async {
      final h = await pumpSoftphone(tester, readyView());
      expect(find.byKey(const Key('country-code')), findsOneWidget);
      await h.setView(readyView(number: '+447700900123'));
      expect(find.byKey(const Key('country-code')), findsNothing);
    });

    testWidgets('redial fills the pad, never dials, and Call takes focus', (tester) async {
      final h = await pumpSoftphone(tester, readyView(number: ''));
      await tester.ensureVisible(find.byKey(const Key('redial-m1')));
      await tester.tap(find.byKey(const Key('redial-m1')));
      expect(h.actions.calls, ['redial']);
      expect(h.actions.args['redial'], ['m1']);
      await h.setView(readyView(focusCallToken: 1));
      await tester.pump();
      expect(h.actions.count('dial'), 0);
      final focused = FocusManager.instance.primaryFocus;
      expect(focused?.debugLabel, 'softphone-call');
    });

    testWidgets('recent calls say their day, outcome and where they were logged', (tester) async {
      await pumpSoftphone(tester, readyView());
      expect(find.text('Logged to Q4 Renewals · Today, 09:20 am'), findsOneWidget);
      expect(find.text('Not logged to a campaign · Yesterday, 06:40 pm'), findsOneWidget);
      expect(find.text('No answer'), findsOneWidget);
    });

    testWidgets('recent calls: loading, empty and failed say so', (tester) async {
      final h = await pumpSoftphone(tester, readyView(recentCalls: const []));
      expect(find.byKey(const Key('recent-empty')), findsOneWidget);
      await h.setView(const SoftphoneView(screen: SoftphoneScreenActive(), recentError: 'Network'));
      expect(find.byKey(const Key('recent-error')), findsOneWidget);
      await tester.ensureVisible(find.text('Try again'));
      await tester.tap(find.text('Try again'));
      expect(h.actions.calls, ['reloadRecent']);
    });

    testWidgets('Log to and Call from change the draft; a closed window says it may need a reason', (tester) async {
      final h = await pumpSoftphone(tester, readyView(tag: 'c2'));
      expect(find.byKey(const Key('window-closed')), findsOneWidget);
      expect(find.text('From Diwali Offers’s caller IDs'), findsOneWidget);
      await tester.tap(find.byKey(const Key('log-to')));
      await settle(tester);
      await tester.tap(find.text('Not logged to a campaign').last);
      await settle(tester);
      expect(h.actions.calls, ['setTag']);
      expect(h.actions.args['setTag'], [null]);
    });

    testWidgets('finish mode: no pad, no number, no Call; the notice says what still works', (tester) async {
      final h = await pumpSoftphone(tester, readyView(finishOnly: true));
      expect(find.byKey(const Key('dial-pad')), findsNothing);
      expect(find.byKey(const Key('dial-number')), findsNothing);
      expect(find.byKey(const Key('dial-call')), findsNothing);
      expect(find.text(softphoneFinishIdleCopy[SoftphoneSurface.phone]!), findsOneWidget);
      // Redial is off too.
      await tester.ensureVisible(find.byKey(const Key('redial-m1')));
      expect(tester.widget<IconButton>(find.byKey(const Key('redial-m1'))).onPressed, isNull);
      expect(h.actions.calls, isEmpty);
    });

    testWidgets('finish mode on the station names the station’s way out', (tester) async {
      await pumpSoftphone(tester, readyView(finishOnly: true), surface: SoftphoneSurface.station);
      expect(find.text(softphoneFinishIdleCopy[SoftphoneSurface.station]!), findsOneWidget);
    });

    testWidgets('a bootstrap that failed says so with Try again', (tester) async {
      final h = await pumpSoftphone(tester, readyView(bootstrapError: 'The server did not answer.'));
      expect(find.text('We couldn’t load the soft phone: The server did not answer.'), findsOneWidget);
      await tester.tap(find.text('Try again').first);
      expect(h.actions.calls, ['retry']);
    });
  });

  group('the call phases', () {
    testWidgets('dialing: who, from where, Hold to hang up; no outcome yet', (tester) async {
      await pumpSoftphone(tester, callView(SoftphonePhase.dialing));
      expect(find.text('Dialing +91 98123 45678'), findsOneWidget);
      expect(find.text('Rahul Verma'), findsWidgets);
      expect(find.text('From +91 20712 34567'), findsOneWidget);
      expect(find.text('Dialing'), findsOneWidget);
      expect(find.byKey(const Key('softphone-hang-up')), findsOneWidget);
      expect(find.byKey(const Key('softphone-save')), findsOneWidget);
      expect(find.byKey(const Key('ringing-warning')), findsNothing);
      expect(find.byKey(const Key('dial-pad')), findsNothing);
    });

    testWidgets('ringing: Mute ring (not the mic), and the SP3 warning above hang-up', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.ringing));
      expect(find.text('Ringing +91 98123 45678'), findsOneWidget);
      expect(find.text('Mute ring'), findsOneWidget);
      expect(find.text('Mute'), findsNothing);
      expect(find.byKey(const Key('ringing-warning')), findsOneWidget);
      expect(find.textContaining('This carrier cannot stop a ringing call'), findsOneWidget);
      await tester.tap(find.byKey(const Key('softphone-mute')));
      expect(h.actions.calls, ['toggleMute']);
      await h.setView(callView(SoftphonePhase.ringing, muted: true));
      expect(find.text('Ring muted'), findsOneWidget);
      expect(find.textContaining('Outcomes open when the customer answers.'), findsOneWidget);
    });

    testWidgets('on call: Mute is the microphone, the talk timer runs, no SP3 warning', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.onCall), now: t0.add(const Duration(seconds: 65)));
      expect(find.text('On call with Rahul Verma'), findsOneWidget);
      expect(find.text('Mute'), findsOneWidget);
      expect(find.text('Mute ring'), findsNothing);
      expect(find.byKey(const Key('ringing-warning')), findsNothing);
      expect(find.text('01:05'), findsOneWidget);
      await h.advance(const Duration(seconds: 2));
      expect(find.text('01:07'), findsOneWidget);
      await h.setView(callView(SoftphonePhase.onCall, muted: true, micMuted: true));
      expect(find.byKey(const Key('softphone-muted')), findsOneWidget);
    });

    testWidgets('outcome: Save pinned, the countdown runs, no hang-up', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.outcome, outcomeDueAt: t0.add(const Duration(seconds: 102))));
      expect(find.text('Outcome needed'), findsOneWidget);
      expect(find.byKey(const Key('softphone-hang-up')), findsNothing);
      expect(find.byKey(const Key('softphone-save')), findsOneWidget);
      expect(find.text('Dialing is blocked until this call has an outcome. Without one, it closes in 1:42.'), findsOneWidget);
      await h.advance(const Duration(seconds: 2));
      expect(find.text('Dialing is blocked until this call has an outcome. Without one, it closes in 1:40.'), findsOneWidget);
      await h.advance(const Duration(seconds: 100));
      expect(find.text('Dialing is blocked until this call has an outcome. Closing with no outcome…'), findsOneWidget);
    });

    testWidgets('Log to and Call from are locked once a call is placed', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.ringing));
      await tester.ensureVisible(find.byKey(const Key('log-to')));
      expect(tester.widget<SetupPicker<String?>>(find.byKey(const Key('log-to'))).onChanged, isNull);
      expect(tester.widget<SetupPicker<String?>>(find.byKey(const Key('caller-id'))).onChanged, isNull);
      expect(find.text('Fixed for this call'), findsOneWidget);
      await tester.tap(find.byKey(const Key('log-to')));
      await settle(tester);
      expect(h.actions.calls, isEmpty);
    });

    testWidgets('the roster contact and whether its outcome settles it', (tester) async {
      await pumpSoftphone(tester, callView(SoftphonePhase.onCall));
      expect(find.byKey(const Key('roster-contact')), findsOneWidget);
      expect(find.text('This number is a contact in Q4 Renewals.'), findsOneWidget);
      expect(find.text('Its outcome updates this contact in the campaign.'), findsOneWidget);
      expect(find.text('Pune'), findsOneWidget);
    });

    testWidgets('finish mode mid-call keeps hang-up and the outcome, and says so', (tester) async {
      await pumpSoftphone(tester, callView(SoftphonePhase.onCall, finishOnly: true));
      expect(find.text(softphoneFinishCallCopy), findsOneWidget);
      expect(find.byKey(const Key('softphone-hang-up')), findsOneWidget);
      expect(find.byKey(const Key('softphone-outcome')), findsOneWidget);
    });
  });

  group('hang up', () {
    testWidgets('is hold-to-confirm: a short press does nothing, 500 ms fires once', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.ringing));
      final bar = find.byKey(const Key('softphone-hang-up'));
      var gesture = await tester.startGesture(tester.getCenter(bar));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await gesture.up();
      await tester.pump(const Duration(milliseconds: 300));
      expect(h.actions.count('hangUp'), 0);

      gesture = await tester.startGesture(tester.getCenter(bar));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 520));
      expect(h.actions.count('hangUp'), 1);
      await tester.pump(const Duration(seconds: 1));
      await gesture.up();
      await tester.pump();
      expect(h.actions.count('hangUp'), 1);
    });

    testWidgets('a tap is not a hang-up', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.onCall));
      await tester.tap(find.byKey(const Key('softphone-hang-up')));
      await tester.pump(const Duration(seconds: 1));
      expect(h.actions.count('hangUp'), 0);
    });

    testWidgets('the screen-reader confirm warns that a ringing phone keeps ringing', (tester) async {
      final semantics = tester.ensureSemantics();
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.ringing));
      tester.semantics.tap(find.semantics.byLabel('Hang up'));
      await settle(tester);
      expect(find.text('End this call?'), findsOneWidget);
      expect(find.descendant(of: find.byType(AlertDialog), matching: find.textContaining('This carrier cannot stop')), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Hang up'));
      await settle(tester);
      expect(h.actions.count('hangUp'), 1);
      semantics.dispose();
    });

    testWidgets('while hanging up the bar says Ending…; a failure is said beside it', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.onCall, hangingUp: true));
      expect(find.text('Ending…'), findsOneWidget);
      await h.setView(
        const SoftphoneView(
          screen: SoftphoneScreenActive(),
          phase: SoftphonePhase.onCall,
          callId: 'call-1',
          canHangUp: true,
          hangupFailure: 'Couldn’t end the call. You are still connected.',
        ),
      );
      expect(find.byKey(const Key('hangup-failure')), findsOneWidget);
    });
  });

  group('the outcome', () {
    testWidgets('picking an outcome on a live call: Save unlocks when the call ends', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.onCall));
      await tester.ensureVisible(find.byKey(const Key('outcome-interested')));
      await tester.tap(find.byKey(const Key('outcome-interested')));
      expect(h.actions.calls, ['selectOutcome']);
      await h.setView(callView(SoftphonePhase.onCall, outcomeCode: 'interested'));
      expect(find.text('Save unlocks when the call ends.'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('softphone-save'))).onPressed, isNull);
    });

    testWidgets('the reasons Save is blocked, in the console’s order', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.outcome));
      expect(find.text('Pick an outcome to save this call.'), findsOneWidget);
      await h.setView(callView(SoftphonePhase.outcome, outcomeCode: 'wrong'));
      expect(find.text('This disposition needs a note.'), findsOneWidget);
      expect(find.text('Notes (required)'), findsOneWidget);
      await h.setView(callView(SoftphonePhase.outcome, outcomeCode: 'callback'));
      expect(find.text('This disposition needs a callback time.'), findsOneWidget);
      await h.setView(callView(SoftphonePhase.outcome, outcomeCode: 'callback', callbackAt: t0.subtract(const Duration(minutes: 1))));
      expect(find.text('That time has already passed. Pick when we should call back.'), findsOneWidget);
      await h.setView(callView(SoftphonePhase.outcome, outcomeCode: 'interested', requiredFieldsMissing: true));
      expect(find.text('Fill in the required call details first.'), findsOneWidget);
      await h.setView(callView(SoftphonePhase.outcome, outcomeCode: 'interested'));
      expect(find.byKey(const Key('softphone-save-reason')), findsNothing);
      await tester.tap(find.byKey(const Key('softphone-save')));
      expect(h.actions.calls, ['saveOutcome']);
    });

    testWidgets('a callback time picked from the chips goes to the core', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.outcome, outcomeCode: 'callback'));
      await tester.ensureVisible(find.byKey(const Key('softphone-callback-inOneHour')));
      await tester.tap(find.byKey(const Key('softphone-callback-inOneHour')));
      expect(h.actions.calls, ['setCallback']);
      expect(h.actions.args['setCallback'], [DateTime(2026, 10, 31, 12, 20)]);
      // A claimed contact goes back to the campaign queue; the note says so.
      expect(find.text('Goes back to the campaign queue. It may not be you who calls.'), findsOneWidget);
    });

    testWidgets('a callback on a contact the campaign is not waiting on stays on the call', (tester) async {
      await pumpSoftphone(
        tester,
        callView(
          SoftphonePhase.outcome,
          outcomeCode: 'callback',
          contactView: const SoftphoneContactView(campaignName: 'Q4 Renewals'),
        ),
      );
      expect(find.textContaining('It isn’t added to a campaign’s queue'), findsOneWidget);
    });

    testWidgets('Save becomes blocked by itself when a callback time passes', (tester) async {
      final h = await pumpSoftphone(
        tester,
        callView(SoftphonePhase.outcome, outcomeCode: 'callback', callbackAt: t0.add(const Duration(seconds: 2))),
      );
      expect(find.byKey(const Key('softphone-save-reason')), findsNothing);
      await h.advance(const Duration(seconds: 3));
      expect(find.text('That time has already passed. Pick when we should call back.'), findsOneWidget);
    });
  });

  group('notes and call details', () {
    testWidgets('notes report every keystroke and show their save status', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.onCall, notes: const NotesView(status: NotesStatus.saved)));
      await tester.ensureVisible(find.byKey(const Key('softphone-notes-field')));
      await tester.enterText(find.byKey(const Key('softphone-notes-field')), 'Wants a call back');
      expect(h.actions.calls, ['setNotes']);
      expect(h.actions.args['setNotes'], ['Wants a call back']);
      expect(find.text('Saved'), findsOneWidget);
    });

    testWidgets('each field type writes its value; required fields are marked; errors show', (tester) async {
      final h = await pumpSoftphone(
        tester,
        callView(
          SoftphonePhase.onCall,
          fieldViews: const [
            SoftphoneFieldView(
              key: 'policy',
              label: 'Policy number',
              type: SoftphoneFieldType.text,
              required: true,
              error: 'Fill this in before you save the outcome.',
            ),
            SoftphoneFieldView(key: 'amount', label: 'Amount', type: SoftphoneFieldType.number),
            SoftphoneFieldView(key: 'consent', label: 'Consent given', type: SoftphoneFieldType.boolean),
            SoftphoneFieldView(key: 'plan', label: 'Plan', type: SoftphoneFieldType.choice, options: ['Gold', 'Silver']),
            SoftphoneFieldView(key: 'renewal', label: 'Renewal date', type: SoftphoneFieldType.date, value: '2026-11-15'),
            SoftphoneFieldView(key: 'legacy', label: 'Legacy', type: SoftphoneFieldType.unsupported, value: 'x'),
          ],
        ),
      );
      final values = <List<Object?>>[];
      h.actions.onCall = (name) {
        if (name == 'setFieldValue') values.add(h.actions.args[name]!);
      };
      await tester.ensureVisible(find.byKey(const Key('call-field-policy')));
      expect(find.text('Fill this in before you save the outcome.'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('call-field-policy')), 'PN-7781');
      await tester.enterText(find.byKey(const Key('call-field-amount')), '1250.5');
      await tester.ensureVisible(find.byKey(const Key('call-field-consent')));
      await tester.tap(find.byKey(const Key('call-field-consent')));
      await tester.ensureVisible(find.byKey(const Key('call-field-renewal')));
      await tester.tap(find.byTooltip('Clear date'));
      expect(values, [
        ['policy', 'PN-7781'],
        ['amount', 1250.5],
        ['consent', true],
        ['renewal', null],
      ]);
      expect(find.text('2026-11-15'), findsOneWidget);
      expect(find.text('This app can’t edit this detail.'), findsOneWidget);
    });

    testWidgets('a yes/no detail nobody has answered says so, rather than reading as No', (tester) async {
      SoftphoneView withConsent(Object? value) => callView(
        SoftphonePhase.onCall,
        fieldViews: [
          SoftphoneFieldView(key: 'consent', label: 'Consent given', type: SoftphoneFieldType.boolean, required: true, value: value),
        ],
      );
      // The plain texts under the switch (the label is rich text).
      List<String?> said() => [
        for (final t in tester.widgetList<Text>(find.descendant(of: find.byKey(const Key('call-field-consent')), matching: find.byType(Text))))
          if (t.data != null) t.data,
      ];

      final h = await pumpSoftphone(tester, withConsent(null));
      await tester.ensureVisible(find.byKey(const Key('call-field-consent')));
      expect(said(), contains('Not answered'));
      expect(said(), isNot(contains('No')));
      await h.setView(withConsent(false));
      expect(said(), contains('No'));
      expect(said(), isNot(contains('Not answered')));
      await h.setView(withConsent(true));
      expect(said(), contains('Yes'));
    });
  });

  group('Mark DNC', () {
    testWidgets('asks first, naming the number and where the mark reaches', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.onCall));
      await tester.tap(find.byKey(const Key('softphone-dnc')));
      await settle(tester);
      expect(find.text('Add this number to Do Not Call?'), findsOneWidget);
      expect(
        find.text('+91 98123 45678 won’t be called again for Q4 Renewals. Do this when the customer asks not to be called.'),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('dnc-cancel')));
      await settle(tester);
      expect(h.actions.calls, isEmpty);

      await tester.tap(find.byKey(const Key('softphone-dnc')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('dnc-confirm')));
      await settle(tester);
      expect(h.actions.calls, ['markDnc']);
      expect(h.actions.args['markDnc'], [null, 'call-1']);
    });

    testWidgets('the sheet closes, marking nothing, when its call leaves the screen', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.onCall));
      await tester.tap(find.byKey(const Key('softphone-dnc')));
      await settle(tester);
      await h.setView(readyView());
      await settle(tester);
      expect(find.byKey(const Key('dnc-sheet')), findsNothing);
      expect(h.actions.count('markDnc'), 0);
    });

    testWidgets('once marked it says so and cannot be pressed again', (tester) async {
      await pumpSoftphone(tester, callView(SoftphonePhase.onCall, dncOutcome: 'Added to Do Not Call for Q4 Renewals.'));
      expect(find.text('On Do Not Call'), findsOneWidget);
      expect(find.byKey(const Key('dnc-outcome')), findsOneWidget);
    });
  });

  group('the override prompt', () {
    testWidgets('opens on the prompt; Call anyway only with a 10–500 character note', (tester) async {
      final h = await pumpSoftphone(tester, readyView());
      await h.setView(readyView(overridePrompt: dncPrompt));
      expect(find.text('This number is on the Do Not Call list'), findsOneWidget);
      expect(find.text('Customer asked'), findsOneWidget);
      expect(find.text('If you call anyway, the call is logged with your name and your reason.'), findsOneWidget);

      OutlinedButton confirm() => tester.widget<OutlinedButton>(find.byKey(const Key('override-confirm')));
      expect(confirm().onPressed, isNull);
      expect(find.text('0 / 500'), findsOneWidget);

      await tester.enterText(find.byKey(const Key('override-note')), '   123456789   ');
      await tester.pump();
      expect(confirm().onPressed, isNull, reason: '9 characters after trimming');
      expect(find.textContaining('Write at least 10 characters'), findsOneWidget);

      await tester.enterText(find.byKey(const Key('override-note')), 'Asked us to call today');
      await tester.pump();
      expect(confirm().onPressed, isNotNull);
      expect(find.text('22 / 500'), findsOneWidget);

      await tester.enterText(find.byKey(const Key('override-note')), 'x' * 501);
      await tester.pump();
      expect(confirm().onPressed, isNull, reason: '501 characters');
      expect(find.textContaining('Keep the note to 500 characters.'), findsOneWidget);

      await tester.enterText(find.byKey(const Key('override-note')), 'x' * 500);
      await tester.pump();
      expect(confirm().onPressed, isNotNull);
      await tester.ensureVisible(find.byKey(const Key('override-confirm')));
      await tester.tap(find.byKey(const Key('override-confirm')));
      expect(h.actions.calls, ['confirmOverride']);
      expect(h.actions.args['confirmOverride'], ['x' * 500]);
    });

    testWidgets('“Don’t call” is the primary action and closes nothing by itself', (tester) async {
      final h = await pumpSoftphone(tester, readyView(overridePrompt: dncPrompt));
      await settle(tester);
      expect(find.widgetWithText(FilledButton, 'Don’t call'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Call anyway'), findsOneWidget);
      await tester.tap(find.byKey(const Key('override-cancel')));
      await tester.pump();
      expect(h.actions.calls, ['cancelOverride']);
      // The core closes the prompt; the sheet follows.
      await h.setView(readyView());
      await settle(tester);
      expect(find.byKey(const Key('override-sheet-dnc')), findsNothing);
    });

    testWidgets('a second refusal of the other kind asks again with an empty note', (tester) async {
      final h = await pumpSoftphone(tester, readyView(overridePrompt: dncPrompt));
      await settle(tester);
      await tester.enterText(find.byKey(const Key('override-note')), 'Asked us to call today');
      await h.setView(readyView(overridePrompt: hoursPrompt));
      expect(find.text('Outside calling hours'), findsOneWidget);
      expect(find.text('09:00–18:00 Mon–Sat Asia/Kolkata'), findsOneWidget);
      expect(tester.widget<TextField>(find.byKey(const Key('override-note'))).controller!.text, '');
    });

    testWidgets('while the redial is in flight, both buttons wait and the error shows inline', (tester) async {
      final h = await pumpSoftphone(tester, readyView(overridePrompt: dncPrompt));
      await settle(tester);
      await h.setView(
        readyView(
          overridePrompt: const SoftphoneOverridePrompt(
            kind: SoftphoneOverrideKind.dnc,
            title: 'This number is on the Do Not Call list',
            consequence: 'Logged.',
            noteLabel: 'Why?',
            confirmLabel: 'Call anyway',
            submitting: true,
            error: 'Write a little more about why.',
          ),
        ),
      );
      expect(find.text('Calling…'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('override-cancel'))).onPressed, isNull);
      expect(find.text('Write a little more about why.'), findsOneWidget);
    });

    testWidgets('the back gesture answers Don’t call', (tester) async {
      final h = await pumpSoftphone(tester, readyView(overridePrompt: dncPrompt));
      await settle(tester);
      final navigator = tester.state<NavigatorState>(find.byType(Navigator).last);
      await navigator.maybePop();
      await tester.pump();
      expect(h.actions.calls, ['cancelOverride']);
      expect(find.byKey(const Key('override-sheet-dnc')), findsOneWidget);
    });
  });

  group('header', () {
    testWidgets('Close soft phone asks, then closes', (tester) async {
      final h = await pumpSoftphone(tester, readyView());
      await tester.tap(find.byKey(const Key('softphone-close')));
      await settle(tester);
      expect(find.text('Close the soft phone?'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Close soft phone'));
      await settle(tester);
      expect(h.actions.calls, ['close']);
    });

    testWidgets('Close soft phone is disabled with its reason while a call is live or owed', (tester) async {
      await pumpSoftphone(tester, callView(SoftphonePhase.outcome));
      expect(tester.widget<OutlinedButton>(find.byKey(const Key('softphone-close'))).onPressed, isNull);
      expect(find.byKey(const Key('softphone-exit-reason')), findsOneWidget);
      expect(find.textContaining('Finish this call and save its outcome first'), findsOneWidget);
    });

    testWidgets('on the station: Return to campaign, disabled with its reason while owed', (tester) async {
      final h = await pumpSoftphone(tester, readyView(), surface: SoftphoneSurface.station);
      expect(find.byKey(const Key('softphone-close')), findsNothing);
      await tester.tap(find.byKey(const Key('softphone-return')));
      await tester.pump();
      expect(h.actions.calls, ['returnToCampaign']);
      await h.setView(callView(SoftphonePhase.outcome));
      expect(tester.widget<OutlinedButton>(find.byKey(const Key('softphone-return'))).onPressed, isNull);
      expect(find.text('Finish this call and save its outcome first.'), findsOneWidget);
    });

    testWidgets('recording and where the call is logged are disclosed', (tester) async {
      await pumpSoftphone(tester, callView(SoftphonePhase.onCall));
      expect(find.byKey(const Key('softphone-recording')), findsOneWidget);
      expect(find.text('Logging to: Q4 Renewals'), findsOneWidget);
    });
  });

  group('connection', () {
    testWidgets('disconnected: Reconnect in the rail', (tester) async {
      final h = await pumpSoftphone(
        tester,
        readyView(
          link: StationLink.disconnected,
          rail: const SoftphoneRail(tone: SoftphoneRailTone.danger, label: 'Disconnected'),
        ),
      );
      await tester.tap(find.byKey(const Key('softphone-reconnect')));
      expect(h.actions.calls, ['reconnect']);
    });

    testWidgets('moved to another device: Use this phone', (tester) async {
      final h = await pumpSoftphone(
        tester,
        readyView(
          link: StationLink.superseded,
          rail: const SoftphoneRail(tone: SoftphoneRailTone.warning, label: 'Your soft phone moved to another device'),
        ),
      );
      await tester.tap(find.byKey(const Key('softphone-use-this-phone')));
      expect(h.actions.calls, ['useThisDevice']);
    });

    testWidgets('the audio route sheet picks a route for this call', (tester) async {
      final h = await pumpSoftphone(tester, callView(SoftphonePhase.onCall));
      await tester.tap(find.byKey(const Key('softphone-audio')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('route-s')));
      await settle(tester);
      expect(h.actions.calls, ['setRoute']);
    });
  });

  testWidgets('a microphone problem says what is broken and offers Settings', (tester) async {
    final h = await pumpSoftphone(tester, callView(SoftphonePhase.onCall, audio: const AudioView(micProblem: MicProblem.permissionDenied)));
    expect(find.byKey(const Key('softphone-mic-problem')), findsOneWidget);
    await tester.tap(find.text('Open Settings'));
    await tester.pump();
    expect(h.settingsOpened, 1);
  });

  testWidgets('a key press clicks', (tester) async {
    final h = await pumpSoftphone(tester, readyView());
    await tester.tap(find.byKey(const Key('dial-key-1')));
    expect(h.haptics, contains('HapticFeedbackType.selectionClick'));
  });
}
