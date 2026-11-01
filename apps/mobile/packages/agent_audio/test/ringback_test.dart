import 'dart:math' as math;
import 'dart:typed_data';

import 'package:agent_audio/reference.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/ringback_vectors.dart';

/// The tone without its envelope, computed independently of the reference: what a burst
/// holds between its edges.
double _flat(int n, int rate) =>
    RingbackSpec.amplitude * (math.sin(2 * math.pi * 400 * n / rate) + math.sin(2 * math.pi * 450 * n / rate)) / 2;

/// Amplitude of [hz] in [x] (Goertzel).
double _amplitude(List<int> x, double hz, int rate) {
  final w = 2 * math.pi * hz / rate;
  final coeff = 2 * math.cos(w);
  var s1 = 0.0, s2 = 0.0;
  for (final v in x) {
    final s = v + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return 2 * math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / x.length;
}

int _ms(int ms, int rate) => ms * rate ~/ 1000;

void main() {
  for (final v in ringbackVectors) {
    final rate = v.sampleRate;

    group('${rate ~/ 1000} kHz', () {
      test('matches the shared vectors (also asserted by RingbackTest.kt)', () {
        for (final (index, sample) in v.samples) {
          expect(ringbackSample(index, rate), sample, reason: 'sample $index');
        }
        var checksum = 0;
        for (var n = 0; n < 3 * rate; n++) {
          checksum += ringbackSample(n, rate) * (n % 97 + 1);
        }
        expect(checksum, v.cycleChecksum);
        for (final (start, end, energy) in v.segmentEnergy) {
          var sum = 0;
          for (var n = start; n < end; n++) {
            final s = ringbackSample(n, rate);
            sum += s * s;
          }
          expect(sum, energy, reason: 'segment $start–$end');
        }
      });

      test('rings 0.4 s on, 0.2 s off, 0.4 s on, 2.0 s off, cycle after cycle', () {
        // Each 10 ms window is either entirely silent or clearly ringing; which one is
        // decided by the cadence alone.
        final window = _ms(10, rate);
        for (var w = 0; w < 600; w++) {
          final startMs = w * 10;
          final inCycle = startMs % 3000;
          final ringing = inCycle < 400 || (inCycle >= 600 && inCycle < 1000);
          var sum = 0;
          for (var n = w * window; n < (w + 1) * window; n++) {
            final s = ringbackSample(n, rate);
            sum += s * s;
          }
          final rms = math.sqrt(sum / window);
          if (ringing) {
            // The edge windows hold part of a 12 ms fade; the rest sit near amplitude / 2.
            expect(rms, greaterThan(300), reason: 'ringing at $startMs ms');
          } else {
            expect(sum, 0, reason: 'silent at $startMs ms');
          }
        }
      });

      test('the exact burst boundaries', () {
        final on1 = _ms(400, rate), gap = _ms(200, rate), on2 = _ms(400, rate);
        // Silent from the end of each burst to the start of the next; the first sample of a
        // burst is the zero of its fade-in.
        for (var n = on1; n <= on1 + gap; n++) {
          expect(ringbackSample(n, rate), 0, reason: 'gap $n');
        }
        for (var n = on1 + gap + on2; n <= 3 * rate; n++) {
          expect(ringbackSample(n, rate), 0, reason: 'pause $n');
        }
        expect(ringbackSample(on1 - 1, rate), isNot(0), reason: 'last sample of the first ring');
        expect(ringbackSample(on1 + gap + 1, rate), isNot(0), reason: 'second sample of the second ring');
        expect(ringbackSample(on1 + gap + on2 - 1, rate), isNot(0), reason: 'last sample of the second ring');
      });

      test('12 ms linear edges, flat in between', () {
        final edge = _ms(12, rate), on = _ms(400, rate), second = _ms(600, rate);
        for (final start in [0, second]) {
          for (var k = 0; k < on; k++) {
            final n = start + k;
            final env = math.min(1.0, math.min(k, on - k) / edge);
            expect(ringbackSample(n, rate), closeTo(_flat(n, rate) * env, 1.0), reason: 'k=$k of the ring at $start');
          }
        }
      });

      test('400 and 450 Hz, each at half the peak, peak 0.12 of full scale', () {
        // The flat middle of the first ring: 100–300 ms.
        final mid = [for (var n = _ms(100, rate); n < _ms(300, rate); n++) ringbackSample(n, rate)];
        expect(_amplitude(mid, 400, rate), closeTo(RingbackSpec.amplitude / 2, 5));
        expect(_amplitude(mid, 450, rate), closeTo(RingbackSpec.amplitude / 2, 5));
        expect(_amplitude(mid, 1000, rate), lessThan(5));
        var peak = 0;
        for (var n = 0; n < 3 * rate; n++) {
          peak = math.max(peak, ringbackSample(n, rate).abs());
        }
        expect(peak, lessThanOrEqualTo(RingbackSpec.amplitude.ceil()));
        expect(peak, greaterThan(RingbackSpec.amplitude * 0.95));
      });

      test('mixing frame by frame yields the reference samples', () {
        final frameSamples = rate ~/ 50;
        final tone = Ringback(rate);
        // A whole cycle and a bit, so the cycle wrap falls inside the run.
        for (var f = 0; f < 160; f++) {
          final frame = Int16List(frameSamples);
          tone.mix(frame);
          for (var i = 0; i < frameSamples; i++) {
            expect(frame[i], ringbackSample(f * frameSamples + i, rate), reason: 'frame $f sample $i');
          }
        }
        expect(tone.position, 160 * frameSamples);
      });
    });
  }

  group('mixing', () {
    test('adds to the playout frame instead of replacing it (early media stays audible)', () {
      final frame = Int16List.fromList(List.generate(160, (i) => i * 10 - 800));
      Ringback(8000).mix(frame);
      for (var i = 0; i < 160; i++) {
        expect(frame[i], i * 10 - 800 + ringbackSample(i, 8000));
      }
    });

    test('saturates at full scale instead of wrapping', () {
      // The flat part of the first ring (positions 800–960), where the tone swings ±3900.
      final high = Int16List(160)..fillRange(0, 160, 32767);
      final low = Int16List(160)..fillRange(0, 160, -32768);
      Ringback(8000)
        ..mix(Int16List(800))
        ..mix(high);
      Ringback(8000)
        ..mix(Int16List(800))
        ..mix(low);
      var clippedHigh = 0, clippedLow = 0;
      for (var i = 0; i < 160; i++) {
        final s = ringbackSample(800 + i, 8000);
        expect(high[i], math.min(32767, 32767 + s), reason: 'high $i');
        expect(low[i], math.max(-32768, -32768 + s), reason: 'low $i');
        if (s > 0) clippedHigh++;
        if (s < 0) clippedLow++;
      }
      expect(clippedHigh, greaterThan(50), reason: 'the test exercised the upper clamp');
      expect(clippedLow, greaterThan(50), reason: 'the test exercised the lower clamp');
    });

    test('process rewinds while off, so the next ring starts with a burst', () {
      final tone = Ringback(8000);
      final frame = Int16List(160);
      for (var i = 0; i < 30; i++) {
        tone.process(frame, on: true);
      }
      expect(tone.position, 30 * 160);
      final untouched = Int16List.fromList(List.filled(160, 7));
      tone.process(untouched, on: false);
      expect(untouched, everyElement(7), reason: 'off leaves the frame alone');
      expect(tone.position, 0);
      final next = Int16List(160);
      tone.process(next, on: true);
      expect(next, [for (var i = 0; i < 160; i++) ringbackSample(i, 8000)]);
    });
  });
}
