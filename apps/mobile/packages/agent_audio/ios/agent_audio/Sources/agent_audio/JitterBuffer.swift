import Foundation

/// What `JitterBuffer.pop` produced. Mirrors `PlayoutKind` in the Dart model.
enum PlayoutKind {
  case real, concealed, silence
}

/// Tuning in 20 ms frames; defaults match `JitterBufferConfig` in the Dart model.
struct JitterBufferConfig {
  var frameSamples: Int
  var minTargetFrames = 4
  var maxTargetFrames = 12
  var initialTargetFrames = 5
  var capacityFrames = 16
  var growStepFrames = 2
  var shrinkAfterFrames = 500
  var trimSlackFrames = 2
  var trimAfterFrames = 25
  var concealFrames = 3

  var fadeInSamples: Int { frameSamples / 4 }
}

struct JitterSnapshot {
  var depthFrames: Int
  var targetFrames: Int
  var underruns: Int
  var concealedFrames: Int
  var silentFrames: Int
  var overflowDrops: Int
  var latencyDrops: Int
  var receivedFrames: Int
  var playedFrames: Int
}

/// Adaptive playout buffer for downlink audio: a line-for-line port of
/// `lib/src/jitter/jitter_buffer.dart` (the specification, with the algorithm documented) and of
/// `JitterBuffer.kt`, which replays the Dart-generated `test/fixtures/jitter_trace.txt` in its
/// unit tests. The trace format is documented in `test/support/jitter_trace.dart`, so a Swift
/// replay test can be added once this builds on macOS.
///
/// Not thread-safe: `Playout` guards it with one lock. No allocation after init.
final class JitterBuffer {
  let config: JitterBufferConfig
  private let slots: UnsafeMutablePointer<Int16>
  private let last: UnsafeMutablePointer<Int16>

  private var head = 0
  private var count = 0
  private var target: Int
  private var buffering = true
  private var hasLast = false
  private var prevReal = false
  private var concealRun = 0
  private var stable = 0
  private var excess = 0

  private var underruns = 0
  private var concealed = 0
  private var silent = 0
  private var overflowDrops = 0
  private var latencyDrops = 0
  private var received = 0
  private var played = 0

  init(config: JitterBufferConfig) {
    self.config = config
    let total = config.capacityFrames * config.frameSamples
    slots = .allocate(capacity: total)
    slots.initialize(repeating: 0, count: total)
    last = .allocate(capacity: config.frameSamples)
    last.initialize(repeating: 0, count: config.frameSamples)
    target = config.initialTargetFrames
  }

  deinit {
    slots.deinitialize(count: config.capacityFrames * config.frameSamples)
    slots.deallocate()
    last.deinitialize(count: config.frameSamples)
    last.deallocate()
  }

  var depthFrames: Int { count }
  var targetFrames: Int { target }

  var snapshot: JitterSnapshot {
    JitterSnapshot(
      depthFrames: count, targetFrames: target, underruns: underruns, concealedFrames: concealed,
      silentFrames: silent, overflowDrops: overflowDrops, latencyDrops: latencyDrops,
      receivedFrames: received, playedFrames: played)
  }

  func reset() {
    head = 0; count = 0; target = config.initialTargetFrames
    buffering = true; hasLast = false; prevReal = false
    concealRun = 0; stable = 0; excess = 0
    underruns = 0; concealed = 0; silent = 0; overflowDrops = 0; latencyDrops = 0
    received = 0; played = 0
  }

  /// Queues one frame of exactly `frameSamples` samples.
  func push(_ frame: UnsafePointer<Int16>) {
    let n = config.frameSamples
    let cap = config.capacityFrames
    received += 1
    if count == cap {
      head = (head + 1) % cap
      count -= 1
      overflowDrops += 1
    }
    let tail = (head + count) % cap
    (slots + tail * n).update(from: frame, count: n)
    count += 1
  }

  /// Writes the next 20 ms into `out` (at least `frameSamples` long).
  func pop(into out: UnsafeMutablePointer<Int16>) -> PlayoutKind {
    let n = config.frameSamples
    let cap = config.capacityFrames

    if !buffering && count == 0 {
      underruns += 1
      target = min(target + config.growStepFrames, config.maxTargetFrames)
      stable = 0
      excess = 0
      buffering = true
    }
    if buffering {
      if count >= target {
        buffering = false
      } else {
        return fill(out)
      }
    }

    if count > target + config.trimSlackFrames {
      excess += 1
      if excess >= config.trimAfterFrames {
        head = (head + 1) % cap
        count -= 1
        latencyDrops += 1
        excess = 0
      }
    } else {
      excess = 0
    }

    let start = slots + head * n
    last.update(from: start, count: n)
    out.update(from: start, count: n)
    head = (head + 1) % cap
    count -= 1

    if !prevReal {
      let f = config.fadeInSamples
      for j in 0..<f {
        out[j] = Int16(Int(out[j]) * j / f)
      }
    }
    hasLast = true
    prevReal = true
    concealRun = 0
    played += 1
    stable += 1
    if stable >= config.shrinkAfterFrames {
      stable = 0
      if target > config.minTargetFrames { target -= 1 }
    }
    return .real
  }

  private func fill(_ out: UnsafeMutablePointer<Int16>) -> PlayoutKind {
    let n = config.frameSamples
    prevReal = false
    if hasLast && concealRun < config.concealFrames {
      let total = config.concealFrames * n
      let base = concealRun * n
      for j in 0..<n {
        out[j] = Int16(Int(last[j]) * (total - (base + j)) / total)
      }
      concealRun += 1
      concealed += 1
      return .concealed
    }
    out.update(repeating: 0, count: n)
    silent += 1
    return .silence
  }
}
