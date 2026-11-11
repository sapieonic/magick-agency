import 'dart:math' as math;
import 'dart:typed_data';

import 'package:agent_audio/reference.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/chime_vectors.dart';

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
  for (final v in chimeVectors) {
    final rate = v.sampleRate;

    group('${rate ~/ 1000} kHz', () {
      test('matches the shared vectors (also asserted by ChimeTest.kt)', () {
        expect(chimeLength(rate), v.length);
        for (final (index, sample) in v.samples) {
          expect(chimeSample(index, rate), sample, reason: 'sample $index');
        }
        var checksum = 0;
        var energy = 0;
        for (var n = 0; n < v.length; n++) {
          final s = chimeSample(n, rate);
          checksum += s * (n % 97 + 1);
          energy += s * s;
        }
        expect(checksum, v.checksum);
        expect(energy, v.energy);
      });

      test('is the console’s inbound_ring: 784, 587, 784, 587 Hz, about 0.84 s, after a 5 ms lead', () {
        expect(v.length, _ms(837, rate), reason: '5 + 4 × (8 + 120 + 25) + 30 + 160 + 30 ms');
        final lead = _ms(5, rate);
        for (var n = 0; n <= lead; n++) {
          expect(chimeSample(n, rate), 0, reason: 'lead $n');
        }
        // Each tone's held part carries its own pitch, and not the other one.
        var start = lead;
        for (final (hz, holdMs, gapMs) in ChimeSpec.tones) {
          final attack = _ms(8, rate);
          final held = [for (var n = start + attack; n < start + attack + _ms(holdMs, rate); n++) chimeSample(n, rate)];
          final other = hz == 784 ? 587 : 784;
          expect(_amplitude(held, hz.toDouble(), rate), closeTo(ChimeSpec.amplitude, ChimeSpec.amplitude * 0.03));
          expect(_amplitude(held, other.toDouble(), rate), lessThan(ChimeSpec.amplitude * 0.1));
          final span = attack + _ms(holdMs, rate) + _ms(25, rate);
          // The gap after the release is silent.
          for (var n = start + span; n < start + span + _ms(gapMs, rate); n++) {
            expect(chimeSample(n, rate), 0, reason: 'gap $n');
          }
          start += span + _ms(gapMs, rate);
        }
        expect(start, v.length);
      });

      test('never exceeds its peak, and is silent past the end', () {
        for (var n = 0; n < v.length + rate; n++) {
          expect(chimeSample(n, rate).abs(), lessThanOrEqualTo(ChimeSpec.amplitude.ceil()), reason: 'sample $n');
        }
        expect(chimeSample(v.length, rate), 0);
        expect(chimeSample(v.length * 50, rate), 0);
      });

      test('played frame by frame, it is the reference once and then nothing', () {
        final frameSamples = rate ~/ 50;
        final chime = Chime(rate);
        expect(chime.active, isFalse);
        final idle = Int16List(frameSamples)..fillRange(0, frameSamples, 7);
        chime.process(idle);
        expect(idle.every((s) => s == 7), isTrue, reason: 'idle leaves playout alone');

        chime.start();
        final frames = (v.length + frameSamples - 1) ~/ frameSamples;
        for (var f = 0; f < frames; f++) {
          expect(chime.active, isTrue, reason: 'frame $f');
          final frame = Int16List(frameSamples);
          chime.process(frame);
          for (var i = 0; i < frameSamples; i++) {
            expect(frame[i], chimeSample(f * frameSamples + i, rate), reason: 'frame $f sample $i');
          }
        }
        expect(chime.active, isFalse, reason: 'once through, then idle');
        final after = Int16List(frameSamples);
        chime.process(after);
        expect(after.every((s) => s == 0), isTrue);
      });
    });
  }

  test('adds to playout, saturating, instead of replacing it', () {
    final high = Int16List(160)..fillRange(0, 160, 32767);
    final low = Int16List(160)..fillRange(0, 160, -32768);
    final mid = Int16List.fromList([for (var i = 0; i < 160; i++) i * 10 - 800]);
    final a = Chime(8000)..start();
    final b = Chime(8000)..start();
    final c = Chime(8000)..start();
    // Into the first tone's hold.
    for (final x in [a, b, c]) {
      x.process(Int16List(1000));
    }
    a.process(high);
    b.process(low);
    c.process(mid);
    for (var i = 0; i < 160; i++) {
      final s = chimeSample(1000 + i, 8000);
      expect(high[i], math.min(32767, 32767 + s));
      expect(low[i], math.max(-32768, -32768 + s));
      expect(mid[i], i * 10 - 800 + s);
    }
  });

  test('start while playing starts it over; stop silences it', () {
    final chime = Chime(8000)..start();
    chime.process(Int16List(2000));
    expect(chime.position, 2000);
    chime.start();
    final again = Int16List(160);
    chime.process(again);
    expect(again, [for (var i = 0; i < 160; i++) chimeSample(i, 8000)]);
    chime.stop();
    expect(chime.active, isFalse);
    final silent = Int16List(160);
    chime.process(silent);
    expect(silent.every((s) => s == 0), isTrue);
  });
}
