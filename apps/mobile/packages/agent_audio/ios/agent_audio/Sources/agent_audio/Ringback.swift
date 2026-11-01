import Foundation

/// The ringback tone the agent hears while the customer's phone rings on a soft-phone call:
/// 400 + 450 Hz, 0.4 s on, 0.2 s off, 0.4 s on, 2.0 s off, 12 ms linear edges, peak 0.12 of
/// full scale. A line-for-line port of the Dart reference `lib/src/tone/ringback.dart`, which
/// documents the formula, and of `Ringback.kt`; written to the golden vectors in
/// `test/support/ringback_vectors.dart` (e.g. at 8 kHz sample 1 = 13, 96 = -714, 1000 = 1966,
/// 3200 = 0; first-cycle checksum 593827).
///
/// Owned by `Playout`: its `render` calls `process` on every frame it pops from the jitter
/// buffer, under the playout lock, at the wire rate. No allocation.
final class Ringback {
  static let lowHz = 400
  static let highHz = 450
  static let on1Ms = 400
  static let off1Ms = 200
  static let on2Ms = 400
  static let off2Ms = 2000
  static let cycleMs = on1Ms + off1Ms + on2Ms + off2Ms
  static let edgeMs = 12
  static let peak = 0.12
  static let amplitude = peak * 32767

  private let sampleRate: Int

  /// The index of the next sample to mix.
  private(set) var position = 0

  init(sampleRate: Int) {
    self.sampleRate = sampleRate
  }

  func reset() {
    position = 0
  }

  /// Adds the next `count` samples of the tone to `frame`, saturating, and advances.
  func mix(_ frame: UnsafeMutablePointer<Int16>, count: Int) {
    for i in 0..<count {
      let s = Int(frame[i]) + Ringback.sample(index: position + i, sampleRate: sampleRate)
      frame[i] = Int16(s > 32767 ? 32767 : (s < -32768 ? -32768 : s))
    }
    position += count
  }

  /// One popped playout frame: mixes while `on`; otherwise rewinds, so the next ring starts at
  /// the top of the cadence.
  func process(_ frame: UnsafeMutablePointer<Int16>, count: Int, on: Bool) {
    if on { mix(frame, count: count) } else { reset() }
  }

  /// Sample `index` of the tone (counted from the start of the first ring).
  static func sample(index: Int, sampleRate: Int) -> Int {
    let on1 = on1Ms * sampleRate / 1000
    let gap = off1Ms * sampleRate / 1000
    let on2 = on2Ms * sampleRate / 1000
    let cycle = cycleMs * sampleRate / 1000
    let edge = edgeMs * sampleRate / 1000

    let p = index % cycle
    let k: Int
    let length: Int
    if p < on1 {
      k = p
      length = on1
    } else if p >= on1 + gap && p < on1 + gap + on2 {
      k = p - on1 - gap
      length = on2
    } else {
      return 0
    }
    let envelope = min(k, min(length - k, edge))
    if envelope == 0 { return 0 }

    let a = 2 * Double.pi * Double((lowHz * index) % sampleRate) / Double(sampleRate)
    let b = 2 * Double.pi * Double((highHz * index) % sampleRate) / Double(sampleRate)
    let amp = amplitude * Double(envelope) / Double(edge)
    let v = amp * (sin(a) + sin(b)) * 0.5
    return Int((v + 0.5).rounded(.down))
  }
}
