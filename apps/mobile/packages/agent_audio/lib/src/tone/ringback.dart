import 'dart:math' as math;
import 'dart:typed_data';

/// The ringback tone the agent hears while the customer's phone rings on a soft-phone call.
///
/// The carrier sends no early media on the agent's leg, so the tone is made on the device.
/// It matches the console's (`apps/console/src/utils/softphone/ringback.ts`): 400 + 450 Hz,
/// ring-ring at 0.4 s on, 0.2 s off, 0.4 s on, 2.0 s off, with 12 ms linear edges, peaking
/// at 0.12 of full scale.
///
/// The native engines mix it into each 20 ms playout frame at the wire rate (8 or 16 kHz),
/// right after the jitter buffer, with a saturating add, so any early media the carrier does
/// send is still heard. Every sample is a pure function of its index since the tone started:
/// the phase comes from the integer index (not an accumulated float), so Dart, Kotlin and
/// Swift compute the same samples, and the shared vectors in `test/support/ringback_vectors.dart`
/// (also asserted by `RingbackTest.kt`) pin them together.
///
/// Sample `n` at rate `r`, with `p = n mod 3r` the position in the 3 s cycle:
///
/// ```text
/// burst  = p in [0, 0.4r) as k = p, or p in [0.6r, 1.0r) as k = p − 0.6r; else the sample is 0
/// env    = min(k, 0.4r − k, E) / E                  E = 0.012r (96 samples at 8 kHz)
/// a, b   = 2π · ((400 n) mod r) / r,  2π · ((450 n) mod r) / r
/// sample = ⌊ 0.12 · 32767 · env · (sin a + sin b) · 0.5 + 0.5 ⌋
/// ```
///
/// The rounding is spelled out as floor(x + 0.5) because each language's own `round` treats
/// ties differently.
abstract final class RingbackSpec {
  static const int lowHz = 400;
  static const int highHz = 450;

  /// On, off, on, off, in milliseconds.
  static const int on1Ms = 400;
  static const int off1Ms = 200;
  static const int on2Ms = 400;
  static const int off2Ms = 2000;
  static const int cycleMs = on1Ms + off1Ms + on2Ms + off2Ms;

  /// The linear fade at each end of a burst, so a burst starts and stops without a click.
  static const int edgeMs = 12;

  /// Peak of the combined tone as a fraction of full scale (the console's `RINGBACK_PEAK`).
  static const double peak = 0.12;

  /// [peak] in Int16 units.
  static const double amplitude = peak * 32767;
}

/// Sample [index] of the tone (counted from the start of the first ring) at [sampleRate].
int ringbackSample(int index, int sampleRate) {
  final on1 = RingbackSpec.on1Ms * sampleRate ~/ 1000;
  final gap = RingbackSpec.off1Ms * sampleRate ~/ 1000;
  final on2 = RingbackSpec.on2Ms * sampleRate ~/ 1000;
  final cycle = RingbackSpec.cycleMs * sampleRate ~/ 1000;
  final edge = RingbackSpec.edgeMs * sampleRate ~/ 1000;

  final p = index % cycle;
  final int k;
  final int length;
  if (p < on1) {
    k = p;
    length = on1;
  } else if (p >= on1 + gap && p < on1 + gap + on2) {
    k = p - on1 - gap;
    length = on2;
  } else {
    return 0;
  }
  final envelope = math.min(k, math.min(length - k, edge));
  if (envelope == 0) return 0;

  final a = 2 * math.pi * ((RingbackSpec.lowHz * index) % sampleRate) / sampleRate;
  final b = 2 * math.pi * ((RingbackSpec.highHz * index) % sampleRate) / sampleRate;
  final amp = RingbackSpec.amplitude * envelope / edge;
  final v = amp * (math.sin(a) + math.sin(b)) * 0.5;
  return (v + 0.5).floor();
}

/// The tone as the engines run it: a position that advances by one frame per mix. Starting
/// (or [reset]) puts it at the top of the cadence, so a new ring always starts with a burst.
final class Ringback {
  Ringback(this.sampleRate);

  final int sampleRate;
  int _position = 0;

  /// The index of the next sample to mix.
  int get position => _position;

  void reset() => _position = 0;

  /// Adds the next [count] samples of the tone (all of [frame] by default) to [frame],
  /// saturating at the Int16 limits, and advances.
  void mix(Int16List frame, {int? count}) {
    final n = count ?? frame.length;
    for (var i = 0; i < n; i++) {
      final s = frame[i] + ringbackSample(_position + i, sampleRate);
      frame[i] = s > 32767 ? 32767 : (s < -32768 ? -32768 : s);
    }
    _position += n;
  }

  /// One popped playout frame: mixes while [on]; otherwise rewinds, so the next ring starts
  /// at the top of the cadence.
  void process(Int16List frame, {required bool on}) {
    if (on) {
      mix(frame);
    } else {
      reset();
    }
  }
}
