import 'dart:math' as math;

import 'package:flutter/foundation.dart';

/// The pre-flight mic check: what the loopback test heard, and whether it was a voice.
///
/// The native side records through the real call pipeline (voice-processing capture, the
/// call's codec, the jitter buffer) and returns one RMS level per 20 ms frame; the verdict is
/// computed here so it is unit-tested and identical on both platforms.
@immutable
final class LoopbackResult {
  const LoopbackResult._({
    required this.frameLevelsDbfs,
    required this.peakDbfs,
    required this.noiseFloorDbfs,
    required this.speechLevelDbfs,
    required this.voiceFrames,
    required this.voiceDetected,
    required this.playedBack,
  });

  /// Analyses per-frame levels (dBFS, 20 ms each).
  factory LoopbackResult.analyze(List<double> frameLevelsDbfs, {required bool playedBack}) {
    final levels = List<double>.unmodifiable(frameLevelsDbfs);
    if (levels.isEmpty) {
      return LoopbackResult._(
        frameLevelsDbfs: levels,
        peakDbfs: floorDbfs,
        noiseFloorDbfs: floorDbfs,
        speechLevelDbfs: floorDbfs,
        voiceFrames: 0,
        voiceDetected: false,
        playedBack: playedBack,
      );
    }
    final sorted = [...levels]..sort();
    final noise = _percentile(sorted, 0.2);
    final speech = _percentile(sorted, 0.9);
    final voiceFrames = levels.where((l) => l >= voiceThresholdDbfs).length;
    return LoopbackResult._(
      frameLevelsDbfs: levels,
      peakDbfs: sorted.last,
      noiseFloorDbfs: noise,
      speechLevelDbfs: speech,
      voiceFrames: voiceFrames,
      voiceDetected: voiceFrames >= minVoiceFrames && speech - noise >= minSnrDb,
      playedBack: playedBack,
    );
  }

  static const double floorDbfs = -100;

  /// A frame at or above this RMS level counts as voice. Speech into a phone mic with the
  /// platform's voice processing sits around −35…−20 dBFS; a quiet room is below −55.
  static const double voiceThresholdDbfs = -42;

  /// At least 200 ms of voice-level frames.
  static const int minVoiceFrames = 10;

  /// The loud part must stand at least this far above the quiet part, so a steady loud
  /// noise (fan, traffic) does not pass as a voice.
  static const double minSnrDb = 10;

  final List<double> frameLevelsDbfs;
  final double peakDbfs;

  /// 20th percentile of frame levels.
  final double noiseFloorDbfs;

  /// 90th percentile of frame levels.
  final double speechLevelDbfs;
  final int voiceFrames;
  final bool voiceDetected;

  /// Whether the recording was played back to the agent.
  final bool playedBack;

  /// Signal-to-noise estimate in dB.
  double get snrDb => speechLevelDbfs - noiseFloorDbfs;

  static double _percentile(List<double> sorted, double p) {
    final i = (p * (sorted.length - 1)).round();
    return sorted[math.max(0, math.min(sorted.length - 1, i))];
  }

  @override
  bool operator ==(Object other) =>
      other is LoopbackResult &&
      listEquals(other.frameLevelsDbfs, frameLevelsDbfs) &&
      other.playedBack == playedBack;

  @override
  int get hashCode => Object.hash(Object.hashAll(frameLevelsDbfs), playedBack);

  @override
  String toString() => 'LoopbackResult(voice: $voiceDetected, frames $voiceFrames, '
      'speech ${speechLevelDbfs.toStringAsFixed(1)} dBFS, floor ${noiseFloorDbfs.toStringAsFixed(1)} dBFS)';
}
