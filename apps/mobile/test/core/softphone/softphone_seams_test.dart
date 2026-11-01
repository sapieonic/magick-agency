import 'package:agency_wire/agency_wire.dart' show SessionKind;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/softphone_host.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import 'manual_calls.dart';

/// The seams the soft-phone packages are built against: what the view derives
/// from its own values, what the providers answer before anything overrides
/// them, and the station signals' new facts (whose defaults keep a campaign
/// station's signals exactly as they were).
void main() {
  group('SoftphoneView.saveBlockAt', () {
    final now = DateTime(2026, 11, 1, 10);
    const outcomes = [
      DispositionOption(code: 'resolved', label: 'Query resolved'),
      DispositionOption(code: 'documents', label: 'Needs documents', requiresNote: true),
      DispositionOption(code: 'callback', label: 'Callback requested', requiresCallbackTime: true),
    ];
    SoftphoneView view({
      String? code,
      SoftphonePhase phase = SoftphonePhase.outcome,
      String notes = '',
      DateTime? callbackAt,
      bool requiredFieldsMissing = false,
    }) => SoftphoneView(
      outcomes: outcomes,
      outcomeCode: code,
      phase: phase,
      notes: NotesView(text: notes),
      callbackAt: callbackAt,
      requiredFieldsMissing: requiredFieldsMissing,
    );

    test('in the console\'s order: nothing picked, the call live, the outcome\'s rules, then the fields', () {
      expect(view(phase: SoftphonePhase.onCall).saveBlockAt(now), SoftphoneSaveBlock.noSelection);
      expect(view(code: 'gone').saveBlockAt(now), SoftphoneSaveBlock.noSelection);
      expect(view(code: 'resolved', phase: SoftphonePhase.onCall).saveBlockAt(now), SoftphoneSaveBlock.callLive);
      expect(view(code: 'documents', notes: '   ').saveBlockAt(now), SoftphoneSaveBlock.noteRequired);
      expect(view(code: 'callback').saveBlockAt(now), SoftphoneSaveBlock.callbackRequired);
      expect(view(code: 'callback', callbackAt: now).saveBlockAt(now), SoftphoneSaveBlock.callbackInPast);
      expect(
        view(code: 'resolved', requiredFieldsMissing: true).saveBlockAt(now),
        SoftphoneSaveBlock.fieldsRequired,
      );
      expect(view(code: 'documents', notes: 'Sent the list').saveBlockAt(now), isNull);
      expect(view(code: 'callback', callbackAt: now.add(const Duration(hours: 1))).saveBlockAt(now), isNull);
    });

    test('every block has its sentence', () {
      for (final b in SoftphoneSaveBlock.values) {
        expect(softphoneSaveBlockCopy[b], isNotEmpty, reason: b.name);
      }
      expect(softphoneSaveBlockCopy[SoftphoneSaveBlock.callLive], 'Save unlocks when the call ends.');
    });
  });

  group('SoftphoneView derivations', () {
    test('the outcome countdown runs only while an outcome is owed, and stops at zero', () {
      final due = DateTime(2026, 11, 1, 10, 30);
      final owed = SoftphoneView(phase: SoftphonePhase.outcome, outcomeDueAt: due);
      expect(owed.outcomeTimeLeft(DateTime(2026, 11, 1, 10, 28, 30)), const Duration(minutes: 1, seconds: 30));
      expect(owed.outcomeTimeLeft(DateTime(2026, 11, 1, 10, 31)), Duration.zero);
      expect(SoftphoneView(phase: SoftphonePhase.onCall, outcomeDueAt: due).outcomeTimeLeft(due), isNull);
    });

    test('the finish notice depends on the call and the surface, and is null outside finish mode', () {
      const idle = SoftphoneView(finishOnly: true);
      expect(idle.finishNotice(SoftphoneSurface.phone), contains('Close the soft phone'));
      expect(idle.finishNotice(SoftphoneSurface.station), contains('Return to your campaign'));
      const onCall = SoftphoneView(finishOnly: true, phase: SoftphonePhase.onCall);
      expect(onCall.finishNotice(SoftphoneSurface.phone), softphoneFinishCallCopy);
      expect(const SoftphoneView().finishNotice(SoftphoneSurface.phone), isNull);
    });

    test('a call is on screen from the dial until its outcome is saved', () {
      for (final p in SoftphonePhase.values) {
        final v = SoftphoneView(phase: p);
        expect(v.callOnScreen, p != SoftphonePhase.ready, reason: p.name);
        expect(v.callLive, p != SoftphonePhase.ready && p != SoftphonePhase.outcome, reason: p.name);
      }
    });

    test('value equality, so a select rebuilds only on a change', () {
      expect(const SoftphoneView(number: '98'), const SoftphoneView(number: '98'));
      expect(const SoftphoneView(number: '98'), isNot(const SoftphoneView(number: '981')));
      expect(
        const SoftphoneScreenOnCampaign(
          campaignId: 'c',
          campaignName: 'C',
          stateLabel: 'Available',
          accountId: 'a',
          sameAccount: true,
          hostedHere: true,
        ),
        const SoftphoneScreenOnCampaign(
          campaignId: 'c',
          campaignName: 'C',
          stateLabel: 'Available',
          accountId: 'a',
          sameAccount: true,
          hostedHere: true,
        ),
      );
    });
  });

  test('an override note is 10 to 500 characters after trimming, counted as the server counts them', () {
    expect(SoftphoneOverridePrompt.noteValid('short'), isFalse);
    expect(SoftphoneOverridePrompt.noteValid('   123456789   '), isFalse);
    expect(SoftphoneOverridePrompt.noteValid('1234567890'), isTrue);
    expect(SoftphoneOverridePrompt.noteValid('x' * 500), isTrue);
    expect(SoftphoneOverridePrompt.noteValid('x' * 501), isFalse);
    // An emoji is one character to the server, two UTF-16 units to `length`.
    expect(SoftphoneOverridePrompt.noteLength('😀' * 5), 5);
    expect(SoftphoneOverridePrompt.noteValid('😀' * 10), isTrue);
  });

  group('the providers before the cores override them', () {
    late ProviderContainer c;
    setUp(() => c = ProviderContainer.test());

    test('no soft phone, hidden, and no host session', () {
      expect(c.read(softphoneViewProvider), const SoftphoneView());
      expect(c.read(softphoneViewProvider).screen, const SoftphoneScreenLoading());
      expect(c.read(softphoneAvailabilityProvider), SoftphoneAvailability.hidden);
      expect(c.read(softphoneAvailabilityProvider).visible, isFalse);
      expect(c.read(softphoneHostViewProvider), isNull);
    });

    test('the actions say which core provides them', () {
      expect(() => c.read(softphoneActionsProvider), throwsA(anything));
      expect(() => c.read(softphoneHostActionsProvider), throwsA(anything));
    });
  });

  group('SoftphoneHostView', () {
    test('live and owed, from the held call', () {
      expect(const SoftphoneHostView(sessionId: 's', kind: SessionKind.softphone).callLive, isFalse);
      final live = SoftphoneHostView(sessionId: 's', kind: SessionKind.softphone, call: manualCall({'state': 'ringing'}));
      expect((live.callLive, live.outcomeOwed), (true, false));
      final owed = SoftphoneHostView(
        sessionId: 's',
        kind: SessionKind.softphone,
        call: manualCall({'state': 'ended', 'requires_disposition': true}),
      );
      expect((owed.callLive, owed.outcomeOwed), (false, true));
    });
  });

  group('StationSignals', () {
    test('the defaults are a campaign station\'s, so its signals compare as before', () {
      const before = StationSignals(onDuty: true, campaignId: 'c1');
      expect(before.sessionKind, StationSessionKind.campaign);
      expect(before.outcomeOwed, isFalse);
      expect(before.onSoftphone, isFalse);
      expect(before, const StationSignals(onDuty: true, campaignId: 'c1', sessionKind: StationSessionKind.campaign));
      expect(before.home, StationHome.station);
      expect(before.holdsStation, isTrue);
    });

    test('a soft-phone session lives on the Phone tab and, idle, holds nothing', () {
      const idle = StationSignals(onDuty: true, onBreak: true, sessionKind: StationSessionKind.softphone);
      expect(idle.home, StationHome.phone);
      expect(idle.holdsStation, isFalse);
      expect(idle.callActive || idle.outcomeOwed, isFalse);
      const owed = StationSignals(
        onDuty: true,
        onBreak: true,
        sessionKind: StationSessionKind.softphone,
        outcomeOwed: true,
      );
      expect(owed, isNot(idle));
    });

    test('a campaign switched to the soft phone stays at its station', () {
      const switched = StationSignals(onDuty: true, onBreak: true, campaignId: 'c1', onSoftphone: true);
      expect(switched.home, StationHome.station);
      expect(switched.holdsStation, isFalse);
    });

    test('off duty has no home', () {
      expect(const StationSignals().home, isNull);
      expect(const StationSignals(sessionKind: StationSessionKind.softphone).home, isNull);
    });
  });
}
