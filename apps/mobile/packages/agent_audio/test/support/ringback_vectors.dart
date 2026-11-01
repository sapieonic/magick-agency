/// Golden vectors for the ringback tone (`lib/src/tone/ringback.dart`), shared with
/// `RingbackTest.kt`, which carries the same numbers. The Swift `Ringback` is written to them
/// too (it cannot be run here). If the tone ever changes on purpose, regenerate these from the
/// Dart reference and copy them to the Kotlin test in the same commit.
class RingbackVectors {
  const RingbackVectors({
    required this.sampleRate,
    required this.samples,
    required this.cycleChecksum,
    required this.segmentEnergy,
  });

  final int sampleRate;

  /// (index, sample): the burst edges, the flat part, the gaps, the cycle wrap and an index
  /// an hour in.
  final List<(int, int)> samples;

  /// Σ sample[n] · (n mod 97 + 1) over the first 3 s cycle.
  final int cycleChecksum;

  /// (start, end, Σ sample²) for each cadence segment of the first cycle: on, off, on, off.
  final List<(int, int, int)> segmentEnergy;
}

const ringbackVectors8k = RingbackVectors(
  sampleRate: 8000,
  samples: [
    (0, 0), (1, 13), (2, 51), (5, 203), (47, 23), (95, -328), (96, -714), (97, -1057), //
    (1000, 1966), (3103, 1057), (3104, 714), (3198, -51), (3199, -13), (3200, 0), (4799, 0), //
    (4800, 0), (4801, 13), (4896, -714), (6000, 0), (7999, -13), (8000, 0), (23999, 0), //
    (24000, 0), (24001, 13), (25000, 1966), (28801234, -843),
  ],
  cycleChecksum: 593827,
  segmentEnergy: [
    (0, 3200, 11805177566),
    (3200, 4800, 0),
    (4800, 8000, 11805177566),
    (8000, 24000, 0),
  ],
);

const ringbackVectors16k = RingbackVectors(
  sampleRate: 16000,
  samples: [
    (0, 0), (1, 3), (2, 13), (5, 76), (95, -170), (191, -522), (192, -714), (193, -894), //
    (2000, 1966), (6207, 894), (6208, 714), (6398, -13), (6399, -3), (6400, 0), (9599, 0), //
    (9600, 0), (9601, 3), (9792, -714), (12000, 0), (15998, -13), (16000, 0), (47998, 0), //
    (48000, 0), (48001, 3), (50000, 1966), (57602468, -843),
  ],
  cycleChecksum: 1829666,
  segmentEnergy: [
    (0, 6400, 23610816756),
    (6400, 9600, 0),
    (9600, 16000, 23610816756),
    (16000, 48000, 0),
  ],
);

const ringbackVectors = [ringbackVectors8k, ringbackVectors16k];
