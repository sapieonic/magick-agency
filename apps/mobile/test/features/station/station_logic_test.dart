import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/features/station/logic/disposition_form.dart';
import 'package:magick_agency_agent/features/station/logic/format.dart';
import 'package:magick_agency_agent/features/station/logic/wrapup_math.dart';
import 'package:magick_agency_agent/features/station/parts/contact_details.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';
import 'package:magick_agency_agent/features/station/station_screen.dart';

import 'station_harness.dart';

void main() {
  test('every microphone problem has a headline and a remedy; none has neither', () {
    for (final p in MicProblem.values) {
      final words = [StationCopy.micHeadline(p), StationCopy.micRemedy(p)];
      expect(words.every((w) => w.isNotEmpty), p != MicProblem.none, reason: '$p');
      expect(words.every((w) => w.isEmpty), p == MicProblem.none, reason: '$p');
    }
  });

  group('format', () {
    test('formatClock pads, rolls into hours and never goes negative', () {
      expect(formatClock(const Duration(seconds: 102)), '01:42');
      expect(formatClock(const Duration(seconds: 18), padMinutes: false), '0:18');
      expect(formatClock(const Duration(hours: 1, minutes: 2, seconds: 9)), '1:02:09');
      expect(formatClock(const Duration(seconds: -5)), '00:00');
    });

    test('secondsLeft rounds up and stops at zero', () {
      final now = DateTime(2026, 1, 1, 10);
      expect(secondsLeft(now.add(const Duration(milliseconds: 2400)), now), 3);
      expect(secondsLeft(now.add(const Duration(seconds: 2)), now), 2);
      expect(secondsLeft(now, now), 0);
      expect(secondsLeft(now.subtract(const Duration(seconds: 9)), now), 0);
    });

    test('Indian mobiles are grouped; other numbers are left alone', () {
      expect(formatPhone('+919840012345'), '+91 98400 12345');
      expect(formatPhone('+14155550100'), '+14155550100');
    });

    test('dates read "28 Oct · 18:05"', () {
      expect(formatDayTime(DateTime(2026, 10, 28, 18, 5)), '28 Oct · 18:05');
    });
  });

  group('wrap-up clock', () {
    test('drains from full to empty and never counts below zero', () {
      final w = wrapup();
      expect(
        wrapupClock(w, t0, requiresDisposition: true),
        const WrapupClock(secondsLeft: 30, fraction: 1, holding: false, supervisorHold: false),
      );
      final mid = wrapupClock(w, t0.add(const Duration(milliseconds: 12500)), requiresDisposition: true);
      expect(mid.secondsLeft, 18);
      expect(mid.fraction, closeTo(17.5 / 30, 1e-9));
      for (final later in [30, 31, 300]) {
        final c = wrapupClock(w, t0.add(Duration(seconds: later)), requiresDisposition: false);
        expect(c.secondsLeft, 0);
        expect(c.fraction, 0);
      }
    });

    test('at zero it holds for a required disposition, and says so', () {
      final end = t0.add(const Duration(seconds: 45));
      expect(wrapupClock(wrapup(), end, requiresDisposition: true).holding, isTrue);
      expect(wrapupClock(wrapup(), end, requiresDisposition: false).holding, isFalse);
      expect(wrapupClock(wrapup(submitted: true), end, requiresDisposition: true).holding, isFalse);
    });

    test('no deadline means no bar and no digits, not an empty bar', () {
      final c = wrapupClock(wrapup(noTimer: true, hold: WrapupHold.dispositionRequired), t0, requiresDisposition: true);
      expect(c.fraction, isNull);
      expect(c.secondsLeft, isNull);
      expect(c.holding, isTrue);
      final sup = wrapupClock(wrapup(noTimer: true, hold: WrapupHold.supervisor, submitted: true), t0, requiresDisposition: true);
      expect(sup.holding, isTrue);
      expect(sup.supervisorHold, isTrue);
    });
  });

  group('disposition rules', () {
    const now = _Now.value;

    test('nothing picked blocks', () {
      expect(dispositionBlock(dispositions, const DispositionForm(), '', now()), DispositionBlock.noSelection);
    });

    test('a plain code saves without notes', () {
      expect(dispositionBlock(dispositions, const DispositionForm(code: 'voicemail'), '', now()), isNull);
    });

    test('a required note is not satisfied by whitespace', () {
      const f = DispositionForm(code: 'wrong');
      expect(dispositionBlock(dispositions, f, '   \n ', now()), DispositionBlock.noteRequired);
      expect(dispositionBlock(dispositions, f, 'Number belongs to a shop', now()), isNull);
    });

    test('a callback code needs a time, in the future', () {
      const f = DispositionForm(code: 'callback');
      expect(dispositionBlock(dispositions, f, '', now()), DispositionBlock.callbackRequired);
      expect(dispositionBlock(dispositions, f.withCallback(now(), CallbackChoice.picked), '', now()), DispositionBlock.callbackInPast);
      expect(
        dispositionBlock(dispositions, f.withCallback(now().subtract(const Duration(minutes: 5)), CallbackChoice.picked), '', now()),
        DispositionBlock.callbackInPast,
      );
      expect(
        dispositionBlock(dispositions, f.withCallback(now().add(const Duration(minutes: 1)), CallbackChoice.picked), '', now()),
        isNull,
      );
    });

    test('an unknown code (catalog changed) blocks as no selection', () {
      expect(dispositionBlock(dispositions, const DispositionForm(code: 'gone'), '', now()), DispositionBlock.noSelection);
    });

    test('the submit trims notes, drops empty ones, and sends a callback only for callback codes', () {
      final at = now().add(const Duration(hours: 2));
      expect(
        buildSubmit(
          dispositions,
          const DispositionForm(code: 'callback').withCallback(at, CallbackChoice.picked),
          '  call after 6  ',
          now(),
        ),
        DispositionSubmit(code: 'callback', notes: 'call after 6', callbackAt: at),
      );
      expect(
        buildSubmit(
          dispositions,
          const DispositionForm(code: 'callback').withCallback(at, CallbackChoice.picked).select('voicemail'),
          '  ',
          now(),
        ),
        const DispositionSubmit(code: 'voicemail'),
      );
      expect(buildSubmit(dispositions, const DispositionForm(code: 'wrong'), ' ', now()), isNull);
    });

    test('switching codes keeps the chosen callback time', () {
      final at = now().add(const Duration(hours: 1));
      final f = const DispositionForm(code: 'callback').withCallback(at, CallbackChoice.inOneHour).select('voicemail').select('callback');
      expect(f.callbackAt, at);
      expect(f.callbackChoice, CallbackChoice.inOneHour);
    });
  });

  group('callback presets (fixed clock)', () {
    test('in 1 hour rounds up to the minute; tomorrow is 10:00 and 18:00 local', () {
      final p = callbackPresets(DateTime(2026, 10, 31, 11, 20, 30));
      expect(p.map((x) => x.choice), CallbackChoice.values.take(3));
      expect(p[0].at, DateTime(2026, 10, 31, 12, 21));
      expect(p[1].at, DateTime(2026, 11, 1, 10));
      expect(p[2].at, DateTime(2026, 11, 1, 18));
    });

    test('on the minute, in 1 hour is exactly an hour', () {
      expect(callbackPresets(DateTime(2026, 10, 31, 11, 20)).first.at, DateTime(2026, 10, 31, 12, 20));
    });

    test('late at night "in 1 hour" crosses midnight; month and year roll over', () {
      final p = callbackPresets(DateTime(2026, 12, 31, 23, 30));
      expect(p[0].at, DateTime(2027, 1, 1, 0, 30));
      expect(p[1].at, DateTime(2027, 1, 1, 10));
    });

    test('every preset is in the future, so a preset never trips the past-time rule', () {
      for (final now in [DateTime(2026, 10, 31, 0, 0), DateTime(2026, 10, 31, 9, 59, 59), DateTime(2026, 10, 31, 23, 59)]) {
        for (final p in callbackPresets(now)) {
          expect(p.at.isAfter(now), isTrue, reason: '$p at $now');
        }
      }
    });
  });

  group('stage', () {
    test('session-level link states outrank the phase', () {
      expect(stationStageOf(station(link: StationLink.superseded, phase: AgentPhase.onCall, call: call()), 'c1'), StationStage.superseded);
      expect(stationStageOf(station(link: StationLink.sessionGone), 'c1'), StationStage.sessionGone);
      expect(stationStageOf(station(fatal: 'Not staffed'), 'c1'), StationStage.fatal);
    });

    test('connecting is a stage only with no call on screen', () {
      expect(stationStageOf(station(link: StationLink.connecting), 'c1'), StationStage.connecting);
      expect(stationStageOf(station(link: StationLink.connecting, phase: AgentPhase.wrapup), 'c1'), StationStage.wrapup);
    });

    test('device_away is its own stage; another campaign or no station is "not here"', () {
      expect(
        stationStageOf(
          station(
            phase: AgentPhase.onBreak,
            onBreak: const BreakInfo(code: 'device_away', label: 'Away'),
          ),
          'c1',
        ),
        StationStage.away,
      );
      expect(
        stationStageOf(
          station(
            phase: AgentPhase.onBreak,
            onBreak: const BreakInfo(code: 'lunch', label: 'Lunch'),
          ),
          'c1',
        ),
        StationStage.onBreak,
      );
      expect(stationStageOf(station(), 'other'), StationStage.notHere);
      expect(stationStageOf(null, 'c1'), StationStage.notHere);
    });
  });

  test('prior attempts: this campaign first, newest first within each', () {
    final a = [
      PriorAttempt(at: DateTime(2026, 10, 1), outcomeLabel: 'x', sameCampaign: false),
      PriorAttempt(at: DateTime(2026, 10, 2), outcomeLabel: 'old here'),
      PriorAttempt(at: DateTime(2026, 10, 9), outcomeLabel: 'new here'),
      PriorAttempt(at: DateTime(2026, 10, 5), outcomeLabel: 'y', sameCampaign: false),
    ];
    expect(orderPriorAttempts(a).map((x) => x.outcomeLabel), ['new here', 'old here', 'y', 'x']);
  });
}

abstract final class _Now {
  static DateTime value() => DateTime(2026, 10, 31, 11, 20);
}
