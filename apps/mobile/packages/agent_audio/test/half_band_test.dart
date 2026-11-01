import 'dart:math' as math;
import 'dart:typed_data';

import 'package:agent_audio/reference.dart';
import 'package:flutter_test/flutter_test.dart';

Int16List _tone(double hz, int rate, int samples, {double amplitude = 10000}) =>
    Int16List.fromList([for (var i = 0; i < samples; i++) (amplitude * math.sin(2 * math.pi * hz * i / rate)).round()]);

/// Amplitude of [hz] in [x] (Goertzel), skipping the first [skip] samples (filter warm-up).
double _amplitude(Int16List x, double hz, int rate, {int skip = 100}) {
  final n = x.length - skip;
  final w = 2 * math.pi * hz / rate;
  final coeff = 2 * math.cos(w);
  var s1 = 0.0, s2 = 0.0;
  for (var i = skip; i < x.length; i++) {
    final s = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  final power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return 2 * math.sqrt(power) / n;
}

double _db(double ratio) => 20 * math.log(ratio) / math.ln10;

Int16List _decimate(Int16List input, {int block = 320}) {
  final d = HalfBandDecimator();
  final out = Int16List(input.length ~/ 2);
  for (var i = 0; i < input.length; i += block) {
    d.process(input, out, inputOffset: i, count: block, outputOffset: i ~/ 2);
  }
  return out;
}

/// Deterministic test signal shared with `HalfBandDecimatorTest.kt`: a 1 kHz tone plus LCG
/// noise, 16 kHz, 50 frames of 320 samples.
Int16List crossLanguageSignal() {
  final x = Int16List(16000);
  var rng = 1;
  for (var i = 0; i < x.length; i++) {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    final noise = (rng >> 16) % 8001 - 4000;
    // Integer tone (no floating point, so every language computes the same input):
    // a triangle wave at 1 kHz, period 16 samples, amplitude ±16000.
    final p = i % 16;
    final tri = p < 8 ? -16000 + p * 4000 : 16000 - (p - 8) * 4000;
    x[i] = tri + noise;
  }
  return x;
}

/// Shared with `HalfBandDecimatorTest.kt`.
const _decimatorChecksum = -40745250;

void main() {
  test('taps are symmetric, half-band, and sum to unity gain in Q15', () {
    expect(halfBandTaps, hasLength(51));
    expect(halfBandTaps.reduce((a, b) => a + b), 32768);
    for (var k = 0; k < 51; k++) {
      expect(halfBandTaps[k], halfBandTaps[50 - k]);
      if (k != 25 && (k - 25).isEven) expect(halfBandTaps[k], 0, reason: 'tap $k');
    }
  });

  group('decimator 16 kHz → 8 kHz', () {
    test('passes DC', () {
      final out = _decimate(Int16List(3200)..fillRange(0, 3200, 10000));
      expect(out.sublist(100), everyElement(inInclusiveRange(9998, 10002)));
    });

    for (final hz in [300.0, 1000.0, 2000.0, 3000.0, 3400.0]) {
      test('keeps $hz Hz within 0.1 dB', () {
        final out = _decimate(_tone(hz, 16000, 16000));
        expect(_db(_amplitude(out, hz, 8000) / 10000).abs(), lessThan(0.1));
      });
    }

    for (final hz in [4600.0, 5000.0, 6000.0, 7500.0]) {
      test('removes $hz Hz (would alias to ${8000 - hz} Hz) by at least 55 dB', () {
        final out = _decimate(_tone(hz, 16000, 16000));
        final alias = 8000 - hz;
        expect(_db(_amplitude(out, alias, 8000) / 10000), lessThan(-55));
      });
    }

    test('block size does not change the output (state carries across calls)', () {
      final x = crossLanguageSignal();
      expect(_decimate(x, block: 320), _decimate(x, block: 1600));
      expect(_decimate(x, block: 320), _decimate(x, block: 2));
    });

    test('rejects odd or oversized blocks', () {
      final d = HalfBandDecimator();
      expect(() => d.process(Int16List(3), Int16List(2)), throwsArgumentError);
      expect(() => d.process(Int16List(1922), Int16List(961)), throwsArgumentError);
    });

    test('reset clears the history', () {
      final d = HalfBandDecimator();
      final x = crossLanguageSignal();
      final a = Int16List(160);
      final b = Int16List(160);
      d.process(x, a, count: 320);
      d.process(x, Int16List(160), inputOffset: 320, count: 320);
      d.reset();
      d.process(x, b, count: 320);
      expect(b, a);
    });

    test('cross-language checksum', () {
      final out = _decimate(crossLanguageSignal());
      var sum = 0;
      for (var i = 0; i < out.length; i++) {
        sum += out[i] * (i % 97 + 1);
      }
      expect(sum, _decimatorChecksum);
    });
  });

  group('interpolator 8 kHz → 16 kHz', () {
    Int16List interpolate(Int16List input) {
      final it = HalfBandInterpolator();
      final out = Int16List(input.length * 2);
      for (var i = 0; i < input.length; i += 160) {
        it.process(input, out, inputOffset: i, count: 160, outputOffset: i * 2);
      }
      return out;
    }

    test('keeps 1 kHz and suppresses its 7 kHz image by at least 55 dB', () {
      final out = interpolate(_tone(1000, 8000, 8000));
      expect(_db(_amplitude(out, 1000, 16000, skip: 200) / 10000).abs(), lessThan(0.1));
      expect(_db(_amplitude(out, 7000, 16000, skip: 200) / 10000), lessThan(-55));
    });

    test('a round trip through 8 kHz preserves in-band speech frequencies', () {
      final x = _tone(800, 16000, 16000);
      final back = interpolate(_decimate(x));
      expect(_db(_amplitude(back, 800, 16000, skip: 400) / 10000).abs(), lessThan(0.2));
    });
  });
}
