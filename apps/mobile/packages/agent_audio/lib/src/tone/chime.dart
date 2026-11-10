import 'dart:math' as math;
import 'dart:typed_data';

/// The inbound chime: played once when an inbound caller is offered to the agent, before their
/// audio binds (`docs/inbound.md` §6, IB1).
///
/// It is the console's `inbound_ring` cue (`apps/console/src/utils/agencyCues.ts`,
/// `CUE_SPECS.inbound_ring`, played by `agencyWebAudioCueSink.ts`): a two-note bell rung twice,
/// high–low, high–low (784 Hz, 587 Hz), each tone 8 ms linear attack, held 120 ms, 25 ms linear
/// release, then its gap (30, 160, 30, 0 ms), after a 5 ms lead, peaking at 0.12 of full scale.
/// About 0.84 s in all. Told apart from the ringback by contour and length: it is one gesture
/// that ends, never a cadence that repeats.
///
/// Like the ringback (`ringback.dart`), the native engines mix it into each 20 ms playout frame
/// at the wire rate, right after the jitter buffer, with a saturating add, so it never reaches
/// the uplink: the customer cannot hear it. Every sample is a pure function of its index since
/// the chime started; each tone's phase starts at 0 and comes from the integer index within the
/// tone, so Dart, Kotlin (`Chime.kt`) and Swift (`Chime.swift`) compute the same samples, pinned
/// by the shared vectors in `test/support/chime_vectors.dart` (also asserted by `ChimeTest.kt`).
///
/// Sample `n` at rate `r`: skip the lead (`L = 5r/1000` samples), then walk the tones; within
/// tone `i` at index `k` (`A = 8r/1000`, `H = hold·r/1000`, `R = 25r/1000`):
///
/// ```text
/// env    = k/A for k < A;  1 for k < A + H;  (A + H + R − k)/R for k < A + H + R
/// sample = ⌊ 0.12 · 32767 · env · sin(2π · ((hz · k) mod r) / r) + 0.5 ⌋
/// ```
///
/// followed by `gap·r/1000` silent samples. Past the last tone every sample is 0.
abstract final class ChimeSpec {
  /// (Hz, hold ms, gap ms after the release), in order.
  static const List<(int, int, int)> tones = [
    (784, 120, 30),
    (587, 120, 160),
    (784, 120, 30),
    (587, 120, 0),
  ];

  static const int attackMs = 8;
  static const int releaseMs = 25;

  /// Silence before the first tone (the console's `CUE_LEAD_S`).
  static const int leadMs = 5;

  /// Peak as a fraction of full scale (the console's `inbound_ring.peak`).
  static const double peak = 0.12;

  /// [peak] in Int16 units.
  static const double amplitude = peak * 32767;
}

/// How many samples the chime lasts at [sampleRate], lead and gaps included.
int chimeLength(int sampleRate) {
  final attack = ChimeSpec.attackMs * sampleRate ~/ 1000;
  final release = ChimeSpec.releaseMs * sampleRate ~/ 1000;
  var total = ChimeSpec.leadMs * sampleRate ~/ 1000;
  for (final (_, holdMs, gapMs) in ChimeSpec.tones) {
    total += attack + holdMs * sampleRate ~/ 1000 + release + gapMs * sampleRate ~/ 1000;
  }
  return total;
}

/// Sample [index] of the chime (counted from its start) at [sampleRate]; 0 outside it.
int chimeSample(int index, int sampleRate) {
  final lead = ChimeSpec.leadMs * sampleRate ~/ 1000;
  if (index < lead) return 0;
  final attack = ChimeSpec.attackMs * sampleRate ~/ 1000;
  final release = ChimeSpec.releaseMs * sampleRate ~/ 1000;
  var m = index - lead;
  for (final (hz, holdMs, gapMs) in ChimeSpec.tones) {
    final hold = holdMs * sampleRate ~/ 1000;
    final span = attack + hold + release;
    if (m < span) {
      final int num;
      final int den;
      if (m < attack) {
        num = m;
        den = attack;
      } else if (m < attack + hold) {
        num = 1;
        den = 1;
      } else {
        num = span - m;
        den = release;
      }
      if (num == 0) return 0;
      final theta = 2 * math.pi * ((hz * m) % sampleRate) / sampleRate;
      final amp = ChimeSpec.amplitude * num / den;
      final v = amp * math.sin(theta);
      return (v + 0.5).floor();
    }
    m -= span;
    final gap = gapMs * sampleRate ~/ 1000;
    if (m < gap) return 0;
    m -= gap;
  }
  return 0;
}

/// The chime as the engines run it: idle until [start], then one pass through the chime, frame
/// by frame, and idle again. Starting it while it plays starts it over.
final class Chime {
  Chime(this.sampleRate) : length = chimeLength(sampleRate);

  final int sampleRate;

  /// [chimeLength] at [sampleRate].
  final int length;

  int _position = -1;

  /// The chime is playing (started, and not yet past its last sample).
  bool get active => _position >= 0;

  /// The index of the next sample to mix, or -1 when idle.
  int get position => _position;

  void start() => _position = 0;

  void stop() => _position = -1;

  /// While [active]: adds the next [count] samples (all of [frame] by default) to [frame],
  /// saturating at the Int16 limits, and advances; past the end it goes idle. Idle: leaves
  /// [frame] alone.
  void process(Int16List frame, {int? count}) {
    if (_position < 0) return;
    final n = count ?? frame.length;
    for (var i = 0; i < n; i++) {
      final s = frame[i] + chimeSample(_position + i, sampleRate);
      frame[i] = s > 32767 ? 32767 : (s < -32768 ? -32768 : s);
    }
    _position += n;
    if (_position >= length) _position = -1;
  }
}
