import Foundation
import os

/// The station socket's media format. Raw values match `AgentAudioFormat.wireName` in Dart.
enum WireFormat: String {
  case alaw8
  case pcm16

  var sampleRate: Double { self == .alaw8 ? 8000 : 16000 }
  var frameSamples: Int { self == .alaw8 ? 160 : 320 }
  var frameBytes: Int { self == .alaw8 ? 160 : 640 }
}

/// A failure the Dart side maps by `code` (`AgentAudioErrorCode.wireName`).
struct PluginError: Error {
  let code: String
  let message: String

  static func notPrepared(_ message: String) -> PluginError { PluginError(code: "not_prepared", message: message) }
  static func invalidState(_ message: String) -> PluginError { PluginError(code: "invalid_state", message: message) }
  static func deviceBusy(_ message: String) -> PluginError { PluginError(code: "device_busy", message: message) }
  static func permissionDenied(_ message: String) -> PluginError { PluginError(code: "permission_denied", message: message) }
  static func unsupported(_ message: String) -> PluginError { PluginError(code: "unsupported", message: message) }
  static func callSystem(_ message: String) -> PluginError { PluginError(code: "call_system", message: message) }
}

/// `os_unfair_lock` on a stable heap address (a Swift stored `os_unfair_lock` may move, which
/// the lock forbids). Short critical sections only; it is taken on the audio render threads.
final class UnfairLock {
  private let pointer: UnsafeMutablePointer<os_unfair_lock>

  init() {
    pointer = .allocate(capacity: 1)
    pointer.initialize(to: os_unfair_lock())
  }

  deinit {
    pointer.deinitialize(count: 1)
    pointer.deallocate()
  }

  @inline(__always) func lock() { os_unfair_lock_lock(pointer) }
  @inline(__always) func unlock() { os_unfair_lock_unlock(pointer) }

  @inline(__always)
  func withLock<T>(_ body: () throws -> T) rethrows -> T {
    os_unfair_lock_lock(pointer)
    defer { os_unfair_lock_unlock(pointer) }
    return try body()
  }
}

/// Flags set on the main thread and read by the I/O queue once per tick.
struct UplinkFlags {
  var open = false
  var muted = false
  var metering = false
  /// Downlink frames are accepted only while a call's engine runs (not idle, not loopback).
  var acceptDownlink = false
}

/// Mono Float32 samples from the capture render thread to the I/O queue. Fixed capacity,
/// drop-oldest when full (the I/O queue fell behind), no allocation after init.
final class FloatRing {
  private let capacity: Int
  private let buffer: UnsafeMutablePointer<Float>
  private let lock = UnfairLock()
  private var readIndex = 0
  private var count = 0
  private var written = 0

  init(capacity: Int) {
    self.capacity = capacity
    buffer = .allocate(capacity: capacity)
    buffer.initialize(repeating: 0, count: capacity)
  }

  deinit {
    buffer.deinitialize(count: capacity)
    buffer.deallocate()
  }

  /// Total samples ever written (for the "is capture alive" watchdog).
  var totalWritten: Int { lock.withLock { written } }

  func reset() {
    lock.withLock {
      readIndex = 0
      count = 0
      written = 0
    }
  }

  /// Render thread (sink node) or tap thread.
  func write(_ source: UnsafePointer<Float>, count n: Int) {
    guard n > 0 else { return }
    lock.lock()
    defer { lock.unlock() }
    var src = source
    var remaining = n
    if remaining > capacity {
      src += remaining - capacity
      remaining = capacity
    }
    let free = capacity - count
    if remaining > free {
      let drop = remaining - free
      readIndex = (readIndex + drop) % capacity
      count -= drop
    }
    var writeIndex = (readIndex + count) % capacity
    count += remaining
    written &+= remaining
    while remaining > 0 {
      let chunk = min(remaining, capacity - writeIndex)
      (buffer + writeIndex).update(from: src, count: chunk)
      src += chunk
      remaining -= chunk
      writeIndex = (writeIndex + chunk) % capacity
    }
  }

  /// I/O queue. Moves up to `max` samples into `destination`; returns how many.
  func read(into destination: UnsafeMutablePointer<Float>, max: Int) -> Int {
    lock.lock()
    defer { lock.unlock() }
    let n = min(max, count)
    var copied = 0
    while copied < n {
      let chunk = min(n - copied, capacity - readIndex)
      (destination + copied).update(from: buffer + readIndex, count: chunk)
      copied += chunk
      readIndex = (readIndex + chunk) % capacity
    }
    count -= n
    return n
  }
}

/// The downlink side shared by three threads: the downlink task queue pushes frames, the
/// playback render thread pulls samples (with the ringback tone mixed into each popped frame
/// while `ringback` is set), the I/O queue reads stats. One lock, held for at most one
/// frame's copy.
final class Playout {
  private let lock = UnfairLock()
  private var jitter: JitterBuffer
  private var tone: Ringback
  private var ringback = false
  private let current: UnsafeMutablePointer<Int16>
  private var cursor: Int
  private var frameSamples: Int

  init(format: WireFormat) {
    frameSamples = format.frameSamples
    jitter = JitterBuffer(config: JitterBufferConfig(frameSamples: format.frameSamples))
    tone = Ringback(sampleRate: Int(format.sampleRate))
    current = .allocate(capacity: 320)
    current.initialize(repeating: 0, count: 320)
    cursor = format.frameSamples
  }

  deinit {
    current.deinitialize(count: 320)
    current.deallocate()
  }

  /// Main thread, engine stopped.
  func reconfigure(_ format: WireFormat) {
    let fresh = JitterBuffer(config: JitterBufferConfig(frameSamples: format.frameSamples))
    let freshTone = Ringback(sampleRate: Int(format.sampleRate))
    lock.withLock {
      jitter = fresh
      tone = freshTone
      frameSamples = format.frameSamples
      cursor = format.frameSamples
    }
  }

  func reset() {
    lock.withLock {
      jitter.reset()
      tone.reset()
      cursor = frameSamples
    }
  }

  /// Main thread. Mix the ringback tone into playout (a soft-phone call that is ringing).
  func setRingback(_ on: Bool) {
    lock.withLock { ringback = on }
  }

  func push(_ frame: UnsafePointer<Int16>) {
    lock.withLock { jitter.push(frame) }
  }

  var depthFrames: Int { lock.withLock { jitter.depthFrames } }

  var snapshot: JitterSnapshot { lock.withLock { jitter.snapshot } }

  /// Playback render thread: fills `frames` Float32 samples, popping 20 ms frames as needed.
  func render(into out: UnsafeMutablePointer<Float>, frames: Int) {
    lock.lock()
    defer { lock.unlock() }
    var written = 0
    let scale: Float = 1.0 / 32768.0
    while written < frames {
      if cursor >= frameSamples {
        _ = jitter.pop(into: current)
        // At the wire rate, after the jitter buffer: the same frame-level mix as Android.
        tone.process(current, count: frameSamples, on: ringback)
        cursor = 0
      }
      let n = min(frames - written, frameSamples - cursor)
      for i in 0..<n {
        out[written + i] = Float(current[cursor + i]) * scale
      }
      cursor += n
      written += n
    }
  }
}

/// Re-frames downlink bytes (any chunking) into whole frames, decodes them and pushes them
/// into the playout buffer. A partial frame is carried over. Used from the downlink task
/// queue, or from the I/O queue during a loopback test; the lock makes `reset` from the main
/// thread safe.
final class DownlinkAssembler {
  private let lock = UnfairLock()
  private var format: WireFormat
  private let partial: UnsafeMutablePointer<UInt8>
  private var filled = 0
  private let pcm: UnsafeMutablePointer<Int16>

  init(format: WireFormat) {
    self.format = format
    partial = .allocate(capacity: 640)
    partial.initialize(repeating: 0, count: 640)
    pcm = .allocate(capacity: 320)
    pcm.initialize(repeating: 0, count: 320)
  }

  deinit {
    partial.deinitialize(count: 640)
    partial.deallocate()
    pcm.deinitialize(count: 320)
    pcm.deallocate()
  }

  func reset(format: WireFormat) {
    lock.withLock {
      self.format = format
      filled = 0
    }
  }

  func feed(_ data: Data, into playout: Playout) {
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return }
      feed(base, count: raw.count, into: playout)
    }
  }

  func feed(_ bytes: UnsafePointer<UInt8>, count: Int, into playout: Playout) {
    lock.lock()
    defer { lock.unlock() }
    let frameBytes = format.frameBytes
    var pos = 0
    while pos < count {
      let take = min(frameBytes - filled, count - pos)
      (partial + filled).update(from: bytes + pos, count: take)
      filled += take
      pos += take
      if filled == frameBytes {
        decode()
        playout.push(pcm)
        filled = 0
      }
    }
  }

  private func decode() {
    switch format {
    case .alaw8:
      for i in 0..<160 { pcm[i] = ALaw.decode(partial[i]) }
    case .pcm16:
      for i in 0..<320 {
        pcm[i] = Int16(bitPattern: UInt16(partial[2 * i]) | (UInt16(partial[2 * i + 1]) << 8))
      }
    }
  }
}

enum Level {
  static let floorDbfs = -100.0

  static func sumSquares(_ pcm: UnsafePointer<Int16>, count: Int) -> Double {
    var s = 0.0
    for i in 0..<count {
      let v = Double(pcm[i])
      s += v * v
    }
    return s
  }

  static func dbfs(sumSquares: Double, samples: Int) -> Double {
    guard samples > 0, sumSquares > 0 else { return floorDbfs }
    let rms = (sumSquares / Double(samples)).squareRoot() / 32768.0
    return max(floorDbfs, 20 * log10(rms))
  }
}
