import AVFoundation
import UIKit

/// Receives what the engine reports. Always called on the main thread.
protocol VoiceEngineDelegate: AnyObject {
  func voiceEngine(_ engine: VoiceEngine, emit event: [String: Any])
  func voiceEngine(_ engine: VoiceEngine, uplinkFrame frame: Data)
}

/// The iOS voice engine: AVAudioSession (`.playAndRecord` / `.voiceChat`, Bluetooth HFP) and an
/// AVAudioEngine with voice processing (VPIO echo cancellation) on the input node.
///
/// Graph: `inputNode → AVAudioSinkNode` (capture) and `AVAudioSourceNode → mainMixerNode →
/// outputNode` (playback). The hardware runs at 48 kHz (or 16/8 kHz on a Bluetooth HFP route);
/// the source node runs at the wire rate and the mixer converts, and capture is converted to
/// the wire rate with AVAudioConverter.
///
/// Threads:
/// * main: every public method, session/route/interruption handling, events.
/// * capture render thread (sink node): copies samples into `FloatRing`. Lock held for one copy.
/// * playback render thread (source node): pulls from `Playout`. Lock held for one buffer.
/// * I/O queue (serial, user-interactive, 10 ms timer): drains the ring, converts, frames to
///   20 ms, meters, encodes, loopback; posts uplink frames and events to main.
/// * downlink task queue (Flutter background queue): `pushDownlink`, straight into `Playout`.
///
/// Session ownership: with CallKit, CallKit activates the session (`sessionActivated()` from
/// `provider(_:didActivate:)`) and the engine starts then; without it the engine activates the
/// session itself at `prepare` (pre-warm) and keeps it active until `stop(keepWarm: false)`.
final class VoiceEngine {
  enum Phase { case idle, prepared, armed, streaming }

  weak var delegate: VoiceEngineDelegate?

  /// Set by the plugin: whether calls go through CallKit (then CallKit owns activation).
  var useCallKit = true

  /// Set by the plugin before `arm()`: whether a CallKit call is in progress, so the engine
  /// waits for CallKit to activate the session instead of activating it itself.
  var callKitCallActive = false

  private(set) var phase: Phase = .idle
  private(set) var format: WireFormat?

  private let session = AVAudioSession.sharedInstance()
  private var engine: AVAudioEngine?
  private var sourceNode: AVAudioSourceNode?
  private var sinkNode: AVAudioSinkNode?
  private var sourceFormat: WireFormat?
  private var tapInstalled = false
  private var useTapCapture = false

  private var sessionActive = false
  private var wantsRunning = false
  private var running = false
  private var interrupted = false
  private var observersRegistered = false
  private var speakerOverride = false
  private var lastRoute: [String: Any]?
  private var activationWatchdog: DispatchWorkItem?
  private var captureWatchdog: DispatchWorkItem?

  // Shared with the render threads, the I/O queue and the downlink queue.
  private let ring = FloatRing(capacity: 48_000)
  private let playout = Playout(format: .alaw8)
  private let downlink = DownlinkAssembler(format: .alaw8)
  private let flagsLock = UnfairLock()
  private var flags = UplinkFlags()

  /// Uplink frames posted to main and not yet handed to Flutter, and frames dropped because
  /// main fell `maxUplinkInFlight` frames (160 ms) behind. Guarded by `uplinkLock`.
  private let uplinkLock = UnfairLock()
  private var uplinkInFlight = 0
  private var uplinkDrops = 0
  private static let maxUplinkInFlight = 8

  // I/O queue state. Only touched on `ioQueue` (or on main while the timer is stopped).
  private let ioQueue = DispatchQueue(label: "com.magickagency.agent_audio.io", qos: .userInteractive)
  private var ioTimer: DispatchSourceTimer?
  private var ioFormat: WireFormat?
  private var converter: AVAudioConverter?
  private var convertIn: AVAudioPCMBuffer?
  private var convertOut: AVAudioPCMBuffer?
  private let frame = UnsafeMutablePointer<Int16>.allocate(capacity: 320)
  private var frameFill = 0
  private let wire = UnsafeMutablePointer<UInt8>.allocate(capacity: 640)
  private var meterSum = 0.0
  private var meterSamples = 0
  private var meterFrames = 0
  private var ticks = 0
  private var loopback: LoopbackRun?
  private let loopbackDownlink = DownlinkAssembler(format: .alaw8)

  init() {
    frame.initialize(repeating: 0, count: 320)
    wire.initialize(repeating: 0, count: 640)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    frame.deinitialize(count: 320)
    frame.deallocate()
    wire.deinitialize(count: 640)
    wire.deallocate()
  }

  // MARK: - Lifecycle (main thread)

  func prepare(format: WireFormat) throws {
    if phase == .armed || phase == .streaming {
      throw PluginError.invalidState("Cannot prepare during a call")
    }
    try configureSession()
    registerObservers()
    if engine == nil { buildEngine() }
    if self.format != format {
      self.format = format
      playout.reconfigure(format)
    }
    if !useCallKit && !sessionActive {
      // Pre-warm: activation is the slow part, so do it now rather than at `reserved`.
      try activateSession()
    }
    phase = .prepared
    lastRoute = nil
    clearStaleInterruption()
    emitRoute(reason: "other")
  }

  func arm() throws {
    switch phase {
    case .idle:
      throw PluginError.notPrepared("Cannot arm while idle")
    case .armed, .streaming:
      // Already armed. If audio died and could not recover, try again.
      if !running && wantsRunning && sessionActive { try startEngine() }
      return
    case .prepared:
      break
    }
    if recordPermissionDenied() {
      throw PluginError.permissionDenied("Microphone permission is not granted")
    }
    wantsRunning = true
    if useCallKit && callKitCallActive && !sessionActive {
      // CallKit will activate the session (provider didActivate) and the engine starts then.
      phase = .armed
      scheduleActivationWatchdog()
      return
    }
    do {
      if !sessionActive { try activateSession() }
      try startEngine()
    } catch {
      wantsRunning = false
      throw error
    }
    phase = .armed
  }

  func startUplink() throws {
    switch phase {
    case .armed, .streaming:
      flagsLock.withLock { flags.open = true }
      phase = .streaming
    case .idle:
      throw PluginError.notPrepared("Cannot start the uplink while idle")
    case .prepared:
      throw PluginError.invalidState("Arm the microphone first")
    }
  }

  /// Safe in any phase and repeatable.
  func stop(keepWarm: Bool) {
    finishLoopback(error: PluginError.invalidState("Stopped"))
    activationWatchdog?.cancel()
    activationWatchdog = nil
    wantsRunning = false
    stopEngine()
    flagsLock.withLock {
      flags.open = false
      flags.muted = false
    }
    clearStaleInterruption()
    let endsCall = phase == .armed || phase == .streaming
    if keepWarm {
      if phase != .idle { phase = .prepared }
      // A route choice (the speaker above all) belongs to the call it was made in: the next
      // call starts on the default route (headset, else the earpiece), never on the
      // loudspeaker by itself.
      if endsCall && (speakerOverride || session.preferredInput != nil) {
        speakerOverride = false
        try? session.overrideOutputAudioPort(.none)
        try? session.setPreferredInput(nil)
        emitRoute(reason: "other")
      }
    } else {
      speakerOverride = false
      if sessionActive && !(useCallKit && callKitCallActive) {
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        sessionActive = false
      }
      teardownEngine()
      phase = .idle
      format = nil
      lastRoute = nil
    }
    updateProximity()
  }

  func setMuted(_ muted: Bool) {
    flagsLock.withLock { flags.muted = muted }
  }

  var isMuted: Bool { flagsLock.withLock { flags.muted } }

  func setMetering(_ enabled: Bool) {
    flagsLock.withLock { flags.metering = enabled }
  }

  /// Downlink task queue. Copies the bytes into the jitter buffer.
  func pushDownlink(_ data: Data) {
    guard flagsLock.withLock({ flags.acceptDownlink }) else { return }
    downlink.feed(data, into: playout)
  }

  // MARK: - CallKit session hand-off (main thread)

  /// CallKit's `provider(_:didActivate:)`.
  func sessionActivated() {
    sessionActive = true
    activationWatchdog?.cancel()
    activationWatchdog = nil
    if wantsRunning && !running {
      do {
        try startEngine()
      } catch let e as PluginError {
        emitError(code: e.code, message: e.message, recovered: false)
      } catch {
        emitError(code: "unknown", message: error.localizedDescription, recovered: false)
      }
    }
    // CallKit handing us the session means audio is ours again.
    clearStaleInterruption()
  }

  /// CallKit's `provider(_:didDeactivate:)`.
  func sessionDeactivated() {
    sessionActive = false
    if running { stopEngine() }
  }

  /// CallKit refused or failed the call while the engine waited for it: run without it.
  func callKitUnavailable() {
    callKitCallActive = false
    guard wantsRunning && !running && !sessionActive else { return }
    activationWatchdog?.cancel()
    activationWatchdog = nil
    do {
      try activateSession()
      try startEngine()
    } catch let e as PluginError {
      emitError(code: e.code, message: e.message, recovered: false)
    } catch {
      emitError(code: "unknown", message: error.localizedDescription, recovered: false)
    }
  }

  // MARK: - Routes (main thread)

  func availableRoutes() -> [[String: Any]] {
    var routes: [[String: Any]] = []
    if UIDevice.current.userInterfaceIdiom == .phone {
      routes.append(Self.route("earpiece", "earpiece", ""))
    }
    routes.append(Self.route("speaker", "speaker", ""))
    for port in session.availableInputs ?? [] {
      if let kind = Self.headsetKind(port.portType) {
        routes.append(Self.route(kind, port.uid, port.portName))
      }
    }
    // Headphones without a microphone are an output only; list them when in use.
    if let current = currentRoute(), let id = current["id"] as? String,
      !routes.contains(where: { ($0["id"] as? String) == id })
    {
      routes.append(current)
    }
    return routes
  }

  func currentRoute() -> [String: Any]? {
    guard phase != .idle, let output = session.currentRoute.outputs.first else { return nil }
    switch output.portType {
    case .builtInReceiver:
      return Self.route("earpiece", "earpiece", "")
    case .builtInSpeaker:
      return Self.route("speaker", "speaker", "")
    default:
      let kind = Self.headsetKind(output.portType) ?? "wired"
      // Prefer the input port's uid so the id matches `availableRoutes()` (built from inputs).
      let input = session.currentRoute.inputs.first { Self.headsetKind($0.portType) == kind }
      return Self.route(kind, input?.uid ?? output.uid, output.portName)
    }
  }

  func setRoute(id: String, kind: String) throws {
    guard phase != .idle else { throw PluginError.notPrepared("Prepare first") }
    do {
      switch kind {
      case "speaker":
        try session.overrideOutputAudioPort(.speaker)
        speakerOverride = true
      case "earpiece":
        try session.overrideOutputAudioPort(.none)
        speakerOverride = false
        if let mic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
          try session.setPreferredInput(mic)
        }
      default:
        try session.overrideOutputAudioPort(.none)
        speakerOverride = false
        if let port = session.availableInputs?.first(where: { $0.uid == id }) {
          try session.setPreferredInput(port)
        } else if (currentRoute()?["id"] as? String) != id {
          throw PluginError.unsupported("Route \(id) is not available")
        }
      }
    } catch let e as PluginError {
      throw e
    } catch {
      throw PluginError.unsupported("Could not switch audio route: \(error.localizedDescription)")
    }
    emitRoute(reason: "requested", force: true)
  }

  // MARK: - Loopback (main thread)

  func loopbackTest(durationMs: Int, playBack: Bool, completion: @escaping (Result<[String: Any], PluginError>) -> Void) {
    guard phase == .prepared, !running, loopback == nil, let format else {
      completion(.failure(phase == .idle ? .notPrepared("Prepare first") : .invalidState("Loopback needs a prepared, idle engine")))
      return
    }
    if recordPermissionDenied() {
      completion(.failure(.permissionDenied("Microphone permission is not granted")))
      return
    }
    let activatedHere = !sessionActive
    let run = LoopbackRun(
      format: format, durationMs: durationMs, playBack: playBack, activatedSession: activatedHere,
      completion: completion)
    do {
      if activatedHere { try activateSession() }
      loopbackDownlink.reset(format: format)
      loopback = run
      wantsRunning = true
      try startEngine()
    } catch let e as PluginError {
      loopback = nil
      wantsRunning = false
      if activatedHere { deactivateAfterLoopback() }
      completion(.failure(e))
      return
    } catch {
      loopback = nil
      wantsRunning = false
      if activatedHere { deactivateAfterLoopback() }
      completion(.failure(PluginError(code: "unknown", message: error.localizedDescription)))
      return
    }
    let timeout = DispatchWorkItem { [weak self] in
      self?.finishLoopback(error: PluginError(code: "lost", message: "Loopback test timed out"))
    }
    run.timeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(durationMs * 2 + 3000), execute: timeout)
  }

  /// Main thread. Completes the pending loopback with its levels, or with `error`.
  private func finishLoopback(error: PluginError? = nil) {
    guard let run = loopback else { return }
    run.timeout?.cancel()
    wantsRunning = false
    stopEngine()
    loopback = nil
    if run.activatedSession { deactivateAfterLoopback() }
    if let error {
      run.completion(.failure(error))
    } else {
      let levels = Array(run.levels.prefix(run.recorded))
      run.completion(.success(["levels": levels, "playedBack": run.playBack]))
    }
  }

  private func deactivateAfterLoopback() {
    // Without CallKit the session stays active while prepared (pre-warm).
    guard useCallKit else { return }
    try? session.setActive(false, options: .notifyOthersOnDeactivation)
    sessionActive = false
  }

  // MARK: - Session and engine (main thread)

  private func configureSession() throws {
    do {
      // HFP (.allowBluetooth) carries the headset's microphone; A2DP is output-only and adds
      // ~150 ms, so it is deliberately not allowed: a Bluetooth headset is used as a headset.
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
      try? session.setPreferredSampleRate(48_000)
      try? session.setPreferredIOBufferDuration(0.01)
    } catch {
      throw PluginError.deviceBusy("Audio session could not be configured: \(error.localizedDescription)")
    }
  }

  private func activateSession() throws {
    do {
      try session.setActive(true)
      sessionActive = true
    } catch {
      // Typically '!pri' / cannotInterruptOthers: a cellular call owns audio right now.
      throw PluginError.deviceBusy("Audio session could not be activated: \(error.localizedDescription)")
    }
  }

  private func buildEngine() {
    let engine = AVAudioEngine()
    // VPIO setup is the slow part of starting; doing it here keeps it off the call path. It
    // may fail before the session is active, in which case startEngine() retries.
    try? engine.inputNode.setVoiceProcessingEnabled(true)
    self.engine = engine
    sourceNode = nil
    sinkNode = nil
    sourceFormat = nil
    tapInstalled = false
  }

  private func teardownEngine() {
    stopEngine()
    if let engine {
      if let sourceNode { engine.detach(sourceNode) }
      if let sinkNode { engine.detach(sinkNode) }
    }
    engine = nil
    sourceNode = nil
    sinkNode = nil
    sourceFormat = nil
  }

  private func startEngine() throws {
    guard let format else { throw PluginError.notPrepared("No format") }
    if self.engine == nil { buildEngine() }
    guard let engine = self.engine else { throw PluginError.deviceBusy("Audio engine unavailable") }
    if running { return }

    let input = engine.inputNode
    if !input.isVoiceProcessingEnabled {
      do {
        try input.setVoiceProcessingEnabled(true)
      } catch {
        throw PluginError.deviceBusy("Echo cancellation could not start: \(error.localizedDescription)")
      }
    }
    let hardware = input.outputFormat(forBus: 0)
    guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
      throw PluginError.deviceBusy("No microphone input is available")
    }

    // Reset every pipeline stage for a clean call.
    ring.reset()
    playout.reset()
    downlink.reset(format: format)
    uplinkLock.withLock { uplinkDrops = 0 }
    try ioQueue.sync { try makeConverter(inputRate: hardware.sampleRate, format: format) }

    // Capture: a sink node gets render-thread buffers at the I/O size (10 ms); a tap is the
    // fallback if the sink delivers nothing (it buffers ≥ 100 ms, so it costs latency).
    let captureRing = self.ring
    if useTapCapture {
      if !tapInstalled {
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(hardware.sampleRate / 50), format: hardware) { buffer, _ in
          guard let data = buffer.floatChannelData else { return }
          captureRing.write(data[0], count: Int(buffer.frameLength))
        }
        tapInstalled = true
      }
    } else {
      let sink = sinkNode ?? {
        let node = AVAudioSinkNode { _, frameCount, bufferList -> OSStatus in
          let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: bufferList))
          if let data = buffers[0].mData {
            captureRing.write(data.assumingMemoryBound(to: Float.self), count: Int(frameCount))
          }
          return noErr
        }
        engine.attach(node)
        self.sinkNode = node
        return node
      }()
      engine.disconnectNodeInput(sink)
      engine.connect(input, to: sink, format: hardware)
    }

    // Playback at the wire rate; the mixer converts to the hardware rate.
    if sourceFormat != format, let old = sourceNode {
      engine.detach(old)
      sourceNode = nil
    }
    let source = sourceNode ?? {
      let renderPlayout = self.playout
      let node = AVAudioSourceNode(format: Self.playbackFormat(format)) { _, _, frameCount, bufferList -> OSStatus in
        let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
        guard let data = buffers[0].mData else { return noErr }
        let out = data.assumingMemoryBound(to: Float.self)
        renderPlayout.render(into: out, frames: Int(frameCount))
        // Mono, but fill any further buffer the same, in case the format is ever widened.
        for i in 1..<max(1, buffers.count) {
          if let more = buffers[i].mData {
            more.assumingMemoryBound(to: Float.self).update(from: out, count: Int(frameCount))
          }
        }
        return noErr
      }
      engine.attach(node)
      self.sourceNode = node
      self.sourceFormat = format
      return node
    }()
    engine.disconnectNodeOutput(source)
    engine.connect(source, to: engine.mainMixerNode, format: Self.playbackFormat(format))

    engine.prepare()
    do {
      try engine.start()
    } catch {
      throw PluginError.deviceBusy("Audio could not start: \(error.localizedDescription)")
    }
    running = true
    let acceptDownlink = loopback == nil
    flagsLock.withLock { flags.acceptDownlink = acceptDownlink }
    if speakerOverride { try? session.overrideOutputAudioPort(.speaker) }
    startIoTimer()
    scheduleCaptureWatchdog()
    updateProximity()
  }

  private func stopEngine() {
    flagsLock.withLock { flags.acceptDownlink = false }
    captureWatchdog?.cancel()
    captureWatchdog = nil
    stopIoTimer()
    if let engine {
      if engine.isRunning { engine.stop() }
      if tapInstalled {
        engine.inputNode.removeTap(onBus: 0)
        tapInstalled = false
      }
    }
    running = false
    updateProximity()
  }

  private func restartEngine() {
    stopEngine()
    guard wantsRunning, sessionActive else { return }
    do {
      try startEngine()
    } catch let e as PluginError {
      emitError(code: e.code, message: e.message, recovered: false)
    } catch {
      emitError(code: "unknown", message: error.localizedDescription, recovered: false)
    }
  }

  private static func playbackFormat(_ format: WireFormat) -> AVAudioFormat {
    // Standard (deinterleaved Float32) mono at the wire rate; cannot fail for these values.
    AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: 1)!
  }

  private func recordPermissionDenied() -> Bool {
    if #available(iOS 17.0, *) {
      return AVAudioApplication.shared.recordPermission == .denied
    }
    return session.recordPermission == .denied
  }

  private func scheduleActivationWatchdog() {
    activationWatchdog?.cancel()
    let item = DispatchWorkItem { [weak self] in
      guard let self, self.wantsRunning, !self.sessionActive else { return }
      self.emitError(code: "lost", message: "CallKit did not activate the audio session", recovered: false)
    }
    activationWatchdog = item
    DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: item)
  }

  /// If the sink node delivers no samples within 600 ms, rebuild capture with a tap.
  private func scheduleCaptureWatchdog() {
    captureWatchdog?.cancel()
    guard !useTapCapture else { return }
    let item = DispatchWorkItem { [weak self] in
      guard let self, self.running, !self.useTapCapture, self.ring.totalWritten == 0 else { return }
      self.useTapCapture = true
      if let engine = self.engine, let sink = self.sinkNode {
        engine.stop()
        engine.disconnectNodeInput(sink)
      }
      self.restartEngine()
    }
    captureWatchdog = item
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(600), execute: item)
  }

  // MARK: - I/O queue

  private func makeConverter(inputRate: Double, format: WireFormat) throws {
    guard
      let inFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inputRate, channels: 1, interleaved: false),
      let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: format.sampleRate, channels: 1, interleaved: true),
      let converter = AVAudioConverter(from: inFormat, to: outFormat),
      let input = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(inputRate / 10)),
      let output = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(format.sampleRate / 10) + 64)
    else {
      throw PluginError.unsupported("Cannot convert \(inputRate) Hz to \(format.sampleRate) Hz")
    }
    ioFormat = format
    self.converter = converter
    convertIn = input
    convertOut = output
    frameFill = 0
    meterSum = 0
    meterSamples = 0
    meterFrames = 0
    ticks = 0
  }

  private func startIoTimer() {
    stopIoTimer()
    let timer = DispatchSource.makeTimerSource(flags: [], queue: ioQueue)
    timer.schedule(deadline: .now() + .milliseconds(10), repeating: .milliseconds(10), leeway: .milliseconds(2))
    timer.setEventHandler { [weak self] in self?.ioTick() }
    ioTimer = timer
    timer.resume()
  }

  /// Main thread. After this returns no tick is running or will run.
  private func stopIoTimer() {
    guard let timer = ioTimer else { return }
    ioTimer = nil
    timer.cancel()
    ioQueue.sync {}
  }

  private func ioTick() {
    guard let converter, let convertIn, let convertOut, let format = ioFormat, let inData = convertIn.floatChannelData else { return }
    let got = ring.read(into: inData[0], max: Int(convertIn.frameCapacity))
    if got > 0 {
      convertIn.frameLength = AVAudioFrameCount(got)
      var consumed = false
      var error: NSError?
      let status = converter.convert(to: convertOut, error: &error) { _, inputStatus in
        if consumed {
          inputStatus.pointee = .noDataNow
          return nil
        }
        consumed = true
        inputStatus.pointee = .haveData
        return convertIn
      }
      if status != .error, let out = convertOut.int16ChannelData {
        let samples = out[0]
        let n = Int(convertOut.frameLength)
        var i = 0
        while i < n {
          let take = min(n - i, format.frameSamples - frameFill)
          (frame + frameFill).update(from: samples + i, count: take)
          frameFill += take
          i += take
          if frameFill == format.frameSamples {
            frameFill = 0
            handleFrame(format: format)
          }
        }
      }
    }
    ticks += 1
    if ticks % 100 == 0 {
      let snap = playout.snapshot
      let drops = uplinkLock.withLock { uplinkDrops }
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.delegate?.voiceEngine(self, emit: [
          "type": "jitter", "depth": snap.depthFrames, "target": snap.targetFrames,
          "underruns": snap.underruns, "concealed": snap.concealedFrames, "silent": snap.silentFrames,
          "overflowDrops": snap.overflowDrops, "latencyDrops": snap.latencyDrops,
          "received": snap.receivedFrames, "played": snap.playedFrames, "uplinkDrops": drops,
        ])
      }
    }
  }

  /// One 20 ms capture frame at the wire rate is in `frame`.
  private func handleFrame(format: WireFormat) {
    let n = format.frameSamples
    let f = flagsLock.withLock { flags }

    if f.metering {
      meterSum += Level.sumSquares(frame, count: n)
      meterSamples += n
      meterFrames += 1
      if meterFrames == 5 {
        let db = Level.dbfs(sumSquares: meterSum, samples: meterSamples)
        meterSum = 0
        meterSamples = 0
        meterFrames = 0
        DispatchQueue.main.async { [weak self] in
          guard let self else { return }
          self.delegate?.voiceEngine(self, emit: ["type": "level", "dbfs": db])
        }
      }
    }

    if let run = loopback {
      loopbackTick(run, format: format)
      return
    }
    guard f.open else { return }
    // If main has fallen behind, drop and count rather than queue: a backlog would reach the
    // customer as a burst of stale audio.
    let admitted = uplinkLock.withLock { () -> Bool in
      if uplinkInFlight >= Self.maxUplinkInFlight {
        uplinkDrops += 1
        return false
      }
      uplinkInFlight += 1
      return true
    }
    guard admitted else { return }
    let bytes = encode(format: format, muted: f.muted)
    let data = Data(bytes: wire, count: bytes)
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.uplinkLock.withLock { self.uplinkInFlight -= 1 }
      self.delegate?.voiceEngine(self, uplinkFrame: data)
    }
  }

  private func encode(format: WireFormat, muted: Bool) -> Int {
    switch format {
    case .alaw8:
      if muted {
        wire.update(repeating: ALaw.silence, count: 160)
      } else {
        for i in 0..<160 { wire[i] = ALaw.encode(frame[i]) }
      }
      return 160
    case .pcm16:
      if muted {
        wire.update(repeating: 0, count: 640)
      } else {
        for i in 0..<320 {
          let v = UInt16(bitPattern: frame[i])
          wire[2 * i] = UInt8(truncatingIfNeeded: v)
          wire[2 * i + 1] = UInt8(truncatingIfNeeded: v >> 8)
        }
      }
      return 640
    }
  }

  /// I/O queue. Record frames through the encoder, then feed them back through the downlink
  /// path one per captured frame, then let the jitter buffer drain.
  private func loopbackTick(_ run: LoopbackRun, format: WireFormat) {
    if run.finished { return }
    let fb = format.frameBytes
    if run.recorded < run.frames {
      run.levels[run.recorded] = Level.dbfs(sumSquares: Level.sumSquares(frame, count: format.frameSamples), samples: format.frameSamples)
      _ = encode(format: format, muted: false)
      run.recording.withUnsafeMutableBufferPointer { buf in
        (buf.baseAddress! + run.recorded * fb).update(from: wire, count: fb)
      }
      run.recorded += 1
      if run.recorded == run.frames && !run.playBack { completeLoopback(run) }
      return
    }
    if run.fed < run.frames {
      run.recording.withUnsafeBufferPointer { buf in
        loopbackDownlink.feed(buf.baseAddress! + run.fed * fb, count: fb, into: playout)
      }
      run.fed += 1
      return
    }
    if playout.depthFrames == 0 || run.tail > 0 { run.tail += 1 }
    if run.tail >= 5 { completeLoopback(run) }
  }

  private func completeLoopback(_ run: LoopbackRun) {
    run.finished = true
    DispatchQueue.main.async { [weak self] in
      guard let self, self.loopback === run else { return }
      self.finishLoopback()
    }
  }

  // MARK: - Notifications

  private func registerObservers() {
    guard !observersRegistered else { return }
    observersRegistered = true
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(handleInterruption(_:)), name: AVAudioSession.interruptionNotification, object: session)
    center.addObserver(self, selector: #selector(handleRouteChange(_:)), name: AVAudioSession.routeChangeNotification, object: session)
    center.addObserver(self, selector: #selector(handleMediaServicesReset(_:)), name: AVAudioSession.mediaServicesWereResetNotification, object: session)
    center.addObserver(self, selector: #selector(handleEngineConfigurationChange(_:)), name: .AVAudioEngineConfigurationChange, object: nil)
  }

  /// Answers whether a cellular (non-app) call is in progress, for classifying interruptions.
  var cellularCallActive: () -> Bool = { false }

  @objc private func handleInterruption(_ notification: Notification) {
    guard let info = notification.userInfo,
      let rawType = info[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: rawType)
    else { return }
    let rawOptions = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
    var micMuted = false
    var appWasSuspended = false
    if #available(iOS 14.5, *), let rawReason = info[AVAudioSessionInterruptionReasonKey] as? UInt {
      let reason = AVAudioSession.InterruptionReason(rawValue: rawReason)
      micMuted = reason == .builtInMicMuted
      appWasSuspended = reason == .appWasSuspended
    }
    // A late notice that the session was interrupted while the app was suspended: nothing is
    // interrupted now, and no `.ended` will follow it.
    if type == .began && appWasSuspended { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      switch type {
      case .began:
        // Apple does not promise an `.ended` for every `.began` (e.g. "End & Accept" of a
        // cellular call), so `clearStaleInterruption()` also clears this when the session is
        // ours again (CallKit activation, prepare, stop).
        self.interrupted = true
        if self.running { self.stopEngine() }
        let reason = micMuted ? "microphoneSilenced" : (self.cellularCallActive() ? "phoneCall" : "system")
        self.delegate?.voiceEngine(self, emit: ["type": "interruption", "phase": "began", "reason": reason])
      case .ended:
        self.interrupted = false
        let shouldResume = AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume)
        if self.wantsRunning {
          if !(self.useCallKit && self.callKitCallActive) { try? self.activateSession() }
          self.restartEngine()
        }
        self.delegate?.voiceEngine(self, emit: [
          "type": "interruption", "phase": "ended", "reason": "system", "shouldResume": shouldResume && self.wantsRunning,
        ])
      @unknown default:
        break
      }
    }
  }

  @objc private func handleRouteChange(_ notification: Notification) {
    guard let info = notification.userInfo,
      let rawReason = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
      let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason)
    else { return }
    let previous = info[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
    DispatchQueue.main.async { [weak self] in
      guard let self, self.phase != .idle else { return }
      switch reason {
      case .newDeviceAvailable:
        self.emitRoute(reason: "newDevice")
      case .oldDeviceUnavailable:
        let hadHeadset = previous?.outputs.contains { Self.headsetKind($0.portType) != nil } ?? false
        if hadHeadset { self.delegate?.voiceEngine(self, emit: ["type": "noisy"]) }
        // iOS falls back to the receiver in voice chat; re-assert the speaker only if chosen.
        if self.speakerOverride { try? self.session.overrideOutputAudioPort(.speaker) }
        self.emitRoute(reason: "deviceRemoved")
      default:
        self.emitRoute(reason: "other")
      }
      self.updateProximity()
    }
  }

  @objc private func handleEngineConfigurationChange(_ notification: Notification) {
    DispatchQueue.main.async { [weak self] in
      guard let self, let engine = notification.object as? AVAudioEngine, engine === self.engine else { return }
      // The hardware format changed (e.g. a Bluetooth HFP route at 16 kHz) and the engine
      // stopped itself: reconnect with the new format and a new converter.
      if self.wantsRunning && !self.interrupted && self.sessionActive { self.restartEngine() }
    }
  }

  @objc private func handleMediaServicesReset(_ notification: Notification) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      // Every audio object is invalid now: rebuild from scratch.
      let wasRunning = self.wantsRunning
      self.stopIoTimer()
      self.running = false
      self.tapInstalled = false
      self.engine = nil
      self.sourceNode = nil
      self.sinkNode = nil
      self.sourceFormat = nil
      self.sessionActive = false
      var recovered = false
      if self.phase != .idle {
        do {
          try self.configureSession()
          self.buildEngine()
          if wasRunning || !self.useCallKit { try self.activateSession() }
          if wasRunning { try self.startEngine() }
          recovered = true
        } catch {
          recovered = false
        }
      }
      self.emitError(code: "media_services_reset", message: "Audio services were reset", recovered: recovered)
    }
  }

  // MARK: - Helpers (main thread)

  private func emitRoute(reason: String, force: Bool = false) {
    guard phase != .idle else { return }
    let current = currentRoute()
    let available = availableRoutes()
    let key: [String: Any] = ["current": current as Any, "available": available]
    if !force, let last = lastRoute, NSDictionary(dictionary: last).isEqual(to: key) { return }
    lastRoute = key
    delegate?.voiceEngine(self, emit: [
      "type": "route", "current": current as Any, "available": available, "reason": reason,
    ])
    updateProximity()
  }

  private func emitError(code: String, message: String, recovered: Bool) {
    delegate?.voiceEngine(self, emit: ["type": "error", "code": code, "message": message, "recovered": recovered])
  }

  /// Closes an interruption whose `.ended` never came, so engine restarts (e.g. on a
  /// Bluetooth rate change) work again and the app drops its banner.
  private func clearStaleInterruption() {
    guard interrupted else { return }
    interrupted = false
    delegate?.voiceEngine(self, emit: [
      "type": "interruption", "phase": "ended", "reason": "system", "shouldResume": running,
    ])
  }

  /// Screen off at the ear: a call's engine running and audio on the receiver. Not during the
  /// loopback check, when the phone is held in front of the agent.
  private func updateProximity() {
    let want = running && loopback == nil && session.currentRoute.outputs.first?.portType == .builtInReceiver
    if UIDevice.current.isProximityMonitoringEnabled != want {
      UIDevice.current.isProximityMonitoringEnabled = want
    }
  }

  private static func route(_ kind: String, _ id: String, _ name: String) -> [String: Any] {
    ["kind": kind, "id": id, "name": name]
  }

  private static func headsetKind(_ port: AVAudioSession.Port) -> String? {
    switch port {
    case .headsetMic, .headphones, .usbAudio, .lineOut:
      return "wired"
    case .bluetoothHFP, .bluetoothLE, .bluetoothA2DP, .carAudio:
      return "bluetooth"
    default:
      return nil
    }
  }
}

/// A loopback test in progress. Created on main; `recorded`/`fed`/`tail`/`finished` are only
/// touched on the I/O queue while it runs.
final class LoopbackRun {
  let frames: Int
  let playBack: Bool
  let activatedSession: Bool
  let completion: (Result<[String: Any], PluginError>) -> Void
  var recording: [UInt8]
  var levels: [Double]
  var recorded = 0
  var fed = 0
  var tail = 0
  var finished = false
  var timeout: DispatchWorkItem?

  init(
    format: WireFormat, durationMs: Int, playBack: Bool, activatedSession: Bool,
    completion: @escaping (Result<[String: Any], PluginError>) -> Void
  ) {
    frames = min(250, max(10, durationMs / 20))
    self.playBack = playBack
    self.activatedSession = activatedSession
    self.completion = completion
    recording = [UInt8](repeating: 0, count: frames * format.frameBytes)
    levels = [Double](repeating: Level.floorDbfs, count: frames)
  }
}
