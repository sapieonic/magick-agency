import 'dart:typed_data';

/// 51-tap half-band low-pass (Kaiser β 5.65, cut-off fs/4) in Q15, used to go between
/// 16 kHz and 8 kHz. Pass band is flat (±0.01 dB) to 3.4 kHz; everything from 4.6 kHz up is
/// at least 59 dB down, so the only content that can alias lands in 3.4–4 kHz, above the
/// telephone band. Every even offset from the centre is zero (half-band), so a decimator
/// needs 27 multiplies per output sample.
///
/// The Kotlin `HalfBandDecimator` carries the same coefficients and the same integer
/// arithmetic; the shared checksum in `test/half_band_test.dart` / `HalfBandDecimatorTest.kt`
/// pins the two to bit-identical output. iOS does not use it (AVAudioConverter resamples).
const List<int> halfBandTaps = [
  9, 0, -25, 0, 52, 0, -96, 0, 160, 0, -253, 0, 383, 0, -564, 0, 823, 0, -1214, 0, 1881, 0, //
  -3350, 0, 10387, 16382, 10387, 0, -3350, 0, 1881, 0, -1214, 0, 823, 0, -564, 0, 383, 0, //
  -253, 0, 160, 0, -96, 0, 52, 0, -25, 0, 9,
];

int _clamp16(int v) => v > 32767 ? 32767 : (v < -32768 ? -32768 : v);

/// Streaming 2:1 decimator (16 kHz → 8 kHz). Keeps its filter history across calls, so
/// consecutive 20 ms frames join without a seam. No allocation per call.
final class HalfBandDecimator {
  HalfBandDecimator() : _history = Int16List(_taps + _maxBlock);

  static const int _taps = 51;

  /// Largest input block per call (one 20 ms frame at 48 kHz, with room to spare).
  static const int _maxBlock = 1920;

  // _history holds the last (_taps - 1) input samples followed by the current block.
  final Int16List _history;

  /// Clears the filter state (a new call starts from silence).
  void reset() => _history.fillRange(0, _history.length, 0);

  /// Decimates [count] samples of [input] (count must be even and ≤ 1920) into [output],
  /// writing count / 2 samples. Returns the number written.
  int process(Int16List input, Int16List output, {int inputOffset = 0, int? count, int outputOffset = 0}) {
    final n = count ?? input.length - inputOffset;
    if (n.isOdd || n > _maxBlock) {
      throw ArgumentError.value(n, 'count', 'must be even and at most $_maxBlock');
    }
    const hist = _taps - 1;
    _history.setRange(hist, hist + n, input, inputOffset);
    var o = outputOffset;
    for (var i = 0; i < n; i += 2) {
      // Output aligned with input sample i: y = Σ h[k] · x[i - k], x read from history.
      var acc = 0;
      final base = i + hist;
      for (var k = 0; k < _taps; k += 2) {
        acc += halfBandTaps[k] * _history[base - k];
      }
      acc += halfBandTaps[25] * _history[base - 25];
      output[o++] = _clamp16((acc + 16384) >> 15);
    }
    // Keep the newest (_taps - 1) samples for the next block.
    _history.setRange(0, hist, _history, n);
    return n ~/ 2;
  }
}

/// Streaming 1:2 interpolator (8 kHz → 16 kHz) with the same filter: zero-stuffing then
/// low-pass with gain 2, computed polyphase. Used by tests and as a reference only (Android
/// plays 8 kHz through AudioTrack, iOS lets the mixer convert).
final class HalfBandInterpolator {
  HalfBandInterpolator() : _history = Int16List(_span + _maxBlock);

  // The even-phase branch reads x[c] … x[c - 25].
  static const int _span = 25;
  static const int _maxBlock = 960;
  final Int16List _history;

  void reset() => _history.fillRange(0, _history.length, 0);

  /// Interpolates [count] samples of [input] into [output], writing count × 2 samples.
  int process(Int16List input, Int16List output, {int inputOffset = 0, int? count, int outputOffset = 0}) {
    final n = count ?? input.length - inputOffset;
    if (n > _maxBlock) {
      throw ArgumentError.value(n, 'count', 'must be at most $_maxBlock');
    }
    _history.setRange(_span, _span + n, input, inputOffset);
    var o = outputOffset;
    for (var i = 0; i < n; i++) {
      final c = i + _span;
      // Zero-stuffed u[2m] = x[m]; y[p] = 2 · Σ h[k] · u[p - k].
      // y[2c]: only even k meet non-zero u → 2 · Σ_j h[2j] · x[c - j], j = 0..25.
      var acc = 0;
      for (var j = 0; j <= 25; j++) {
        acc += halfBandTaps[2 * j] * _history[c - j];
      }
      // y[2c + 1]: only k = 25 (the centre, the one odd non-zero tap) → 2 · h[25] · x[c - 12].
      final odd = 2 * halfBandTaps[25] * _history[c - 12];
      output[o++] = _clamp16((2 * acc + 16384) >> 15);
      output[o++] = _clamp16((odd + 16384) >> 15);
    }
    _history.setRange(0, _span, _history, n);
    return n * 2;
  }
}
