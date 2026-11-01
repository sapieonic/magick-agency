import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/liveness.dart';
import 'package:magick_agency_agent/core/station/server_clock.dart';

/// Ports of the console's `agencyClock.test.ts` and `agencyStationLiveness.test.ts`.
void main() {
  group('offset estimation', () {
    test('recovers a pure clock skew with no network delay', () {
      expect(offsetFromSample(ts: 1000, serverTs: 61000, receivedAt: 1000), 60000);
    });

    test('splits the round trip when there is latency', () {
      expect(offsetFromSample(ts: 1000, serverTs: 61100, receivedAt: 1200), 60000);
    });

    test('is zero for a perfectly synced clock', () {
      expect(offsetFromSample(ts: 1000, serverTs: 1100, receivedAt: 1200), 0);
    });
  });

  group('ClockOffsetEstimator', () {
    test('assumes no correction before any sample has landed', () {
      expect(ClockOffsetEstimator.empty.offsetMs, 0);
    });

    test('takes a median, so one network stall cannot poison the shift', () {
      var est = ClockOffsetEstimator.empty;
      for (final (ts, server, recv) in [
        (1000, 61000, 1000),
        (2000, 62000, 2000),
        (3000, 66500, 6000), // a 3 s stall: the naive offset is way out
        (4000, 64000, 4000),
        (5000, 65000, 5000),
      ]) {
        est = est.push(ts: ts, serverTs: server, receivedAt: recv);
      }
      expect(est.offsetMs, 60000);
    });

    test('keeps only the last five samples, so a moved clock is tracked, not baked in', () {
      var est = ClockOffsetEstimator.empty;
      for (var i = 0; i < 5; i++) {
        est = est.push(ts: i, serverTs: i + 60000, receivedAt: i);
      }
      for (var i = 0; i < 5; i++) {
        est = est.push(ts: i, serverTs: i + 1000, receivedAt: i);
      }
      expect(est.sampleCount, clockSampleWindow);
      expect(est.offsetMs, 1000);
    });

    test('is immutable', () {
      const a = ClockOffsetEstimator.empty;
      final b = a.push(ts: 0, serverTs: 500, receivedAt: 0);
      expect(a.offsetMs, 0);
      expect(b.offsetMs, 500);
    });
  });

  group('server instants on this device', () {
    final now = DateTime.utc(2026, 1, 1, 12);

    test('subtracts the offset, so a fast server clock does not skew the deadline', () {
      expect(correctedInstant(now, 5000), now.subtract(const Duration(seconds: 5)));
      expect(correctedInstant(null, 5000), isNull);
    });

    test('remainingUntil clamps at zero rather than counting negative, and is exact at the boundary', () {
      expect(remainingUntil(now.subtract(const Duration(seconds: 3)), 0, now), Duration.zero);
      expect(remainingUntil(now, 0, now), Duration.zero);
      expect(remainingUntil(now.add(const Duration(seconds: 30)), 10000, now), const Duration(seconds: 20));
      expect(remainingUntil(null, 0, now), isNull);
    });

    test('elapsedSince floors at zero and measures from the server anchor', () {
      expect(elapsedSince(now.add(const Duration(milliseconds: 300)), 0, now), Duration.zero);
      expect(elapsedSince(now.subtract(const Duration(seconds: 90)), -10000, now), const Duration(seconds: 80));
    });

    test('formatDuration: m:ss, h:mm:ss, floored, never negative', () {
      expect(formatDuration(const Duration(seconds: 65)), '1:05');
      expect(formatDuration(const Duration(minutes: 87, seconds: 3)), '1:27:03');
      expect(formatDuration(const Duration(milliseconds: 1999)), '0:01');
      expect(formatDuration(const Duration(seconds: -5)), '0:00');
    });
  });

  group('backoffFor: the client’s own retry ladder', () {
    test('walks the ladder and holds at the ceiling', () {
      expect([for (var i = 0; i < backoffLadder.length; i++) backoffFor(i)], backoffLadder);
      expect(backoffFor(backoffLadder.length + 10), const Duration(seconds: 15));
      expect(backoffLadder.map((d) => d.inMilliseconds), [500, 1000, 2000, 5000, 10000, 15000]);
    });
  });

  group('silentTooLong: silence is evidence only once we have asked', () {
    const heartbeat = Duration(seconds: 10);

    test('is false with nothing outstanding, however long', () {
      expect(silentTooLong(0, 1000000000000, heartbeat), isFalse);
    });

    test('turns at exactly missedPingLimit intervals of an unanswered ping', () {
      const sent = 1000;
      expect(missedPingLimit, 3);
      expect(silentTooLong(sent, sent + 30000 - 1, heartbeat), isFalse);
      expect(silentTooLong(sent, sent + 30000, heartbeat), isTrue);
    });
  });

  group('recordLiveThenDead: the flap cap', () {
    test('flaps on the cycle after flapLimit inside the window', () {
      var stamps = <int>[];
      for (var i = 0; i < flapLimit; i++) {
        final r = recordLiveThenDead(stamps, i * 1000);
        stamps = r.stamps;
        expect(r.flapping, isFalse);
      }
      expect(recordLiveThenDead(stamps, flapLimit * 1000).flapping, isTrue);
    });

    test('forgets cycles older than the window, so a slow pattern never flaps', () {
      var stamps = <int>[];
      for (var i = 0; i < flapLimit * 3; i++) {
        final r = recordLiveThenDead(stamps, i * flapWindow.inMilliseconds);
        stamps = r.stamps;
        expect(r.flapping, isFalse);
        expect(stamps, hasLength(1));
      }
    });

    test('does not mutate the list it was given', () {
      final given = [1, 2];
      recordLiveThenDead(given, 3);
      expect(given, [1, 2]);
    });
  });

  test('the brief’s fixed numbers', () {
    expect(tokenMintTimeout, const Duration(seconds: 8));
    expect(protocolPingInterval, const Duration(seconds: 3));
    expect(idTokenMaxAge, const Duration(minutes: 50));
  });
}
