import 'dart:typed_data';

/// What [JitterBuffer.pop] produced for one 20 ms output frame.
enum PlayoutKind {
  /// A received frame.
  real,

  /// The last real frame repeated with a fade (packet-loss concealment).
  concealed,

  /// Zeros: before the first frame, while refilling, or after concealment ran out.
  silence,
}

/// Tuning for [JitterBuffer], in 20 ms frames. The defaults are the product's numbers:
/// target depth 80–240 ms starting at 100 ms, hard cap 320 ms, grow 40 ms per underrun,
/// shrink 20 ms after 10 s without one, conceal at most 60 ms.
final class JitterBufferConfig {
  const JitterBufferConfig({
    required this.frameSamples,
    this.minTargetFrames = 4,
    this.maxTargetFrames = 12,
    this.initialTargetFrames = 5,
    this.capacityFrames = 16,
    this.growStepFrames = 2,
    this.shrinkAfterFrames = 500,
    this.trimSlackFrames = 2,
    this.trimAfterFrames = 25,
    this.concealFrames = 3,
  })  : assert(frameSamples >= 4),
        assert(minTargetFrames >= 1 && minTargetFrames <= initialTargetFrames),
        assert(initialTargetFrames <= maxTargetFrames),
        assert(maxTargetFrames < capacityFrames);

  /// Samples per frame: 160 for 8 kHz, 320 for 16 kHz.
  final int frameSamples;
  final int minTargetFrames;
  final int maxTargetFrames;
  final int initialTargetFrames;

  /// Frames held at most; a push beyond this drops the oldest frame.
  final int capacityFrames;

  /// Target growth on each underrun event.
  final int growStepFrames;

  /// Real frames played without an underrun before the target shrinks by one frame.
  final int shrinkAfterFrames;

  /// Depth above target + slack counts as excess latency.
  final int trimSlackFrames;

  /// Consecutive excess pops before one frame is dropped to bring latency down.
  final int trimAfterFrames;

  /// Frames of concealment (fading repeat of the last frame) before silence.
  final int concealFrames;

  /// Samples faded in on the first real frame after concealment or silence (5 ms).
  int get fadeInSamples => frameSamples ~/ 4;
}

/// Counters and depth, as reported to telemetry.
final class JitterSnapshot {
  const JitterSnapshot({
    required this.depthFrames,
    required this.targetFrames,
    required this.underruns,
    required this.concealedFrames,
    required this.silentFrames,
    required this.overflowDrops,
    required this.latencyDrops,
    required this.receivedFrames,
    required this.playedFrames,
  });

  final int depthFrames;
  final int targetFrames;
  final int underruns;
  final int concealedFrames;
  final int silentFrames;
  final int overflowDrops;
  final int latencyDrops;
  final int receivedFrames;
  final int playedFrames;

  /// The trace-file form (`stats …`) shared with the Kotlin and Swift ports' tests.
  String toTraceLine() => 'stats $depthFrames $targetFrames $underruns $concealedFrames $silentFrames '
      '$overflowDrops $latencyDrops $receivedFrames $playedFrames';

  @override
  bool operator ==(Object other) =>
      other is JitterSnapshot &&
      other.depthFrames == depthFrames &&
      other.targetFrames == targetFrames &&
      other.underruns == underruns &&
      other.concealedFrames == concealedFrames &&
      other.silentFrames == silentFrames &&
      other.overflowDrops == overflowDrops &&
      other.latencyDrops == latencyDrops &&
      other.receivedFrames == receivedFrames &&
      other.playedFrames == playedFrames;

  @override
  int get hashCode => Object.hash(depthFrames, targetFrames, underruns, concealedFrames, silentFrames,
      overflowDrops, latencyDrops, receivedFrames, playedFrames);

  @override
  String toString() => 'JitterSnapshot(${toTraceLine()})';
}

/// The adaptive playout buffer for downlink audio. **This file is the specification**: the
/// Kotlin `JitterBuffer.kt` and Swift `JitterBuffer.swift` are line-for-line ports, and
/// `test/fixtures/jitter_trace.txt` (generated from this model) is replayed by the Kotlin
/// unit tests to prove they match.
///
/// Frames come over TCP, so they never arrive out of order or duplicated; they arrive in
/// bursts after a stall. The design follows from that:
///
/// * **Prefill.** Output is silence until [targetFrames] frames are queued.
/// * **Underrun.** When the queue runs dry mid-playout, that is one underrun event: the
///   target grows by `growStepFrames` (up to the max) and the buffer refills to the new
///   target before playing again. Meanwhile the last frame repeats with a linear fade to
///   zero over `concealFrames` frames (60 ms), then silence.
/// * **Fade-in.** The first real frame after concealment or silence ramps up over 5 ms, so
///   resuming does not click.
/// * **Overflow.** A push into a full buffer drops the oldest frame (a burst after a long
///   stall keeps only the newest 320 ms).
/// * **Latency trim.** If the depth stays above target + slack for `trimAfterFrames`
///   consecutive pops, one frame is dropped, so the delay a burst added drains away
///   (20 ms per 0.5 s) instead of persisting for the rest of the call.
/// * **Shrink.** After `shrinkAfterFrames` real frames (10 s) without an underrun the
///   target shrinks by one frame, down to the minimum.
///
/// All arithmetic is integer and truncates toward zero, so the three ports produce
/// bit-identical samples. No allocation after construction.
final class JitterBuffer {
  JitterBuffer(this.config)
      : _slots = Int16List(config.capacityFrames * config.frameSamples),
        _last = Int16List(config.frameSamples),
        _target = config.initialTargetFrames;

  final JitterBufferConfig config;
  final Int16List _slots;
  final Int16List _last;

  int _head = 0;
  int _count = 0;
  int _target;
  bool _buffering = true;
  bool _hasLast = false;
  bool _prevReal = false;
  int _concealRun = 0;
  int _stable = 0;
  int _excess = 0;

  int _underruns = 0;
  int _concealed = 0;
  int _silent = 0;
  int _overflowDrops = 0;
  int _latencyDrops = 0;
  int _received = 0;
  int _played = 0;

  int get depthFrames => _count;
  int get targetFrames => _target;

  JitterSnapshot get snapshot => JitterSnapshot(
        depthFrames: _count,
        targetFrames: _target,
        underruns: _underruns,
        concealedFrames: _concealed,
        silentFrames: _silent,
        overflowDrops: _overflowDrops,
        latencyDrops: _latencyDrops,
        receivedFrames: _received,
        playedFrames: _played,
      );

  /// Back to the initial state (a new call).
  void reset() {
    _head = 0;
    _count = 0;
    _target = config.initialTargetFrames;
    _buffering = true;
    _hasLast = false;
    _prevReal = false;
    _concealRun = 0;
    _stable = 0;
    _excess = 0;
    _underruns = 0;
    _concealed = 0;
    _silent = 0;
    _overflowDrops = 0;
    _latencyDrops = 0;
    _received = 0;
    _played = 0;
  }

  /// Queues one frame of exactly `frameSamples` samples, read from [frame] at [offset].
  void push(Int16List frame, [int offset = 0]) {
    final n = config.frameSamples;
    final cap = config.capacityFrames;
    _received++;
    if (_count == cap) {
      _head = (_head + 1) % cap;
      _count--;
      _overflowDrops++;
    }
    final tail = (_head + _count) % cap;
    _slots.setRange(tail * n, tail * n + n, frame, offset);
    _count++;
  }

  /// Writes the next 20 ms of output into [out] (at least `frameSamples` long).
  PlayoutKind pop(Int16List out) {
    final n = config.frameSamples;
    final cap = config.capacityFrames;

    if (!_buffering && _count == 0) {
      _underruns++;
      _target = _min(_target + config.growStepFrames, config.maxTargetFrames);
      _stable = 0;
      _excess = 0;
      _buffering = true;
    }
    if (_buffering) {
      if (_count >= _target) {
        _buffering = false;
      } else {
        return _fill(out);
      }
    }

    if (_count > _target + config.trimSlackFrames) {
      _excess++;
      if (_excess >= config.trimAfterFrames) {
        _head = (_head + 1) % cap;
        _count--;
        _latencyDrops++;
        _excess = 0;
      }
    } else {
      _excess = 0;
    }

    final start = _head * n;
    _last.setRange(0, n, _slots, start);
    out.setRange(0, n, _slots, start);
    _head = (_head + 1) % cap;
    _count--;

    if (!_prevReal) {
      final f = config.fadeInSamples;
      for (var j = 0; j < f; j++) {
        out[j] = (out[j] * j) ~/ f;
      }
    }
    _hasLast = true;
    _prevReal = true;
    _concealRun = 0;
    _played++;
    _stable++;
    if (_stable >= config.shrinkAfterFrames) {
      _stable = 0;
      if (_target > config.minTargetFrames) _target--;
    }
    return PlayoutKind.real;
  }

  PlayoutKind _fill(Int16List out) {
    final n = config.frameSamples;
    _prevReal = false;
    if (_hasLast && _concealRun < config.concealFrames) {
      final total = config.concealFrames * n;
      final base = _concealRun * n;
      for (var j = 0; j < n; j++) {
        out[j] = (_last[j] * (total - (base + j))) ~/ total;
      }
      _concealRun++;
      _concealed++;
      return PlayoutKind.concealed;
    }
    out.fillRange(0, n, 0);
    _silent++;
    return PlayoutKind.silence;
  }

  static int _min(int a, int b) => a < b ? a : b;
}
