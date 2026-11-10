/// Golden vectors for the inbound chime (`lib/src/tone/chime.dart`), shared with
/// `ChimeTest.kt`, which carries the same numbers. The Swift `Chime` is written to them too (it
/// cannot be run here). If the chime ever changes on purpose, regenerate these from the Dart
/// reference and copy them to the Kotlin test in the same commit.
class ChimeVectors {
  const ChimeVectors({
    required this.sampleRate,
    required this.length,
    required this.samples,
    required this.checksum,
    required this.energy,
  });

  final int sampleRate;

  /// `chimeLength`: the lead, four tones and their gaps.
  final int length;

  /// (index, sample): the lead, the first attack, the hold, a release's tail, a gap, the last
  /// samples and past the end.
  final List<(int, int)> samples;

  /// Σ sample[n] · (n mod 97 + 1) over the whole chime.
  final int checksum;

  /// Σ sample² over the whole chime.
  final int energy;
}

const chimeVectors8k = ChimeVectors(
  sampleRate: 8000,
  length: 6696,
  samples: [
    (0, 0), (39, 0), (40, 0), (41, 35), (42, 116), (72, 1483), (104, 3895), (540, 0), //
    (1063, 3931), (1140, -2319), (1263, -16), (1264, 0), (1300, 0), (1700, 2665), (3000, 0), //
    (6694, -34), (6695, -20), (6696, 0), (7696, 0),
  ],
  checksum: 2127171,
  energy: 32407388626,
);

const chimeVectors16k = ChimeVectors(
  sampleRate: 16000,
  length: 13392,
  samples: [
    (0, 0), (78, 0), (80, 0), (82, 35), (84, 116), (144, 1483), (208, 3895), (1080, 0), //
    (2126, 3931), (2280, -2319), (2526, -16), (2528, 0), (2600, 0), (3400, 2665), (6000, 0), //
    (13390, -20), (13391, -10), (13392, 0), (14392, 0),
  ],
  checksum: 1219378,
  energy: 64814515772,
);

const chimeVectors = [chimeVectors8k, chimeVectors16k];
