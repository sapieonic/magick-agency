import Foundation

/// The inbound chime, played once when an inbound caller is offered to the agent: the console's
/// `inbound_ring` cue, 784 / 587 / 784 / 587 Hz, each 8 ms attack, 120 ms hold, 25 ms release,
/// gaps 30 / 160 / 30 / 0 ms after a 5 ms lead, peak 0.12 of full scale. A line-for-line port of
/// the Dart reference `lib/src/tone/chime.dart`, which documents the formula, and of `Chime.kt`;
/// written to the golden vectors in `test/support/chime_vectors.dart` (e.g. at 8 kHz length
/// 6696, sample 41 = 35, 104 = 3895, 1140 = -2319, 1264 = 0; checksum 2127171).
///
/// Owned by `Playout`: its `render` calls `process` on every frame it pops from the jitter
/// buffer, after the ringback, under the playout lock, at the wire rate. No allocation.
final class Chime {
  /// (Hz, hold ms, gap ms after the release), in order.
  static let tones: [(hz: Int, holdMs: Int, gapMs: Int)] = [(784, 120, 30), (587, 120, 160), (784, 120, 30), (587, 120, 0)]
  static let attackMs = 8
  static let releaseMs = 25
  static let leadMs = 5
  static let peak = 0.12
  static let amplitude = peak * 32767

  private let sampleRate: Int
  let length: Int

  /// The index of the next sample to mix, or -1 when idle.
  private(set) var position = -1

  var active: Bool { position >= 0 }

  init(sampleRate: Int) {
    self.sampleRate = sampleRate
    length = Chime.length(sampleRate: sampleRate)
  }

  func start() {
    position = 0
  }

  func stop() {
    position = -1
  }

  /// While active: adds the next `count` samples to `frame`, saturating, and advances; past the
  /// end it goes idle. Idle: leaves `frame` alone.
  func process(_ frame: UnsafeMutablePointer<Int16>, count: Int) {
    if position < 0 { return }
    for i in 0..<count {
      let s = Int(frame[i]) + Chime.sample(index: position + i, sampleRate: sampleRate)
      frame[i] = Int16(s > 32767 ? 32767 : (s < -32768 ? -32768 : s))
    }
    position += count
    if position >= length { position = -1 }
  }

  /// How many samples the chime lasts, lead and gaps included.
  static func length(sampleRate: Int) -> Int {
    let attack = attackMs * sampleRate / 1000
    let release = releaseMs * sampleRate / 1000
    var total = leadMs * sampleRate / 1000
    for t in tones {
      total += attack + t.holdMs * sampleRate / 1000 + release + t.gapMs * sampleRate / 1000
    }
    return total
  }

  /// Sample `index` of the chime (counted from its start); 0 outside it.
  static func sample(index: Int, sampleRate: Int) -> Int {
    let lead = leadMs * sampleRate / 1000
    if index < lead { return 0 }
    let attack = attackMs * sampleRate / 1000
    let release = releaseMs * sampleRate / 1000
    var m = index - lead
    for t in tones {
      let hold = t.holdMs * sampleRate / 1000
      let span = attack + hold + release
      if m < span {
        let num: Int
        let den: Int
        if m < attack {
          num = m
          den = attack
        } else if m < attack + hold {
          num = 1
          den = 1
        } else {
          num = span - m
          den = release
        }
        if num == 0 { return 0 }
        let theta = 2 * Double.pi * Double((t.hz * m) % sampleRate) / Double(sampleRate)
        let amp = amplitude * Double(num) / Double(den)
        let v = amp * sin(theta)
        return Int((v + 0.5).rounded(.down))
      }
      m -= span
      let gap = t.gapMs * sampleRate / 1000
      if m < gap { return 0 }
      m -= gap
    }
    return 0
  }
}
