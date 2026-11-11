import Flutter
import UIKit

/// Channel names; must match `AgentAudioChannels` in `lib/src/types.dart`.
enum Channels {
  static let methods = "magick_agency/agent_audio/methods"
  static let events = "magick_agency/agent_audio/events"
  static let uplink = "magick_agency/agent_audio/uplink"
  static let downlink = "magick_agency/agent_audio/downlink"
}

/// Method dispatch (main thread), one event channel, and two BinaryCodec media channels:
/// uplink frames are sent from the main thread as the engine posts them; downlink messages are
/// handled on a background task queue straight into the engine's jitter buffer.
public final class AgentAudioPlugin: NSObject, FlutterPlugin, FlutterStreamHandler {
  private let messenger: FlutterBinaryMessenger
  private let engine = VoiceEngine()
  private let callKit = CallKitController()
  private let phoneCalls = PhoneCallMonitor()
  /// The app asked for phone-call reports; they run only while CallKit is on.
  private var phoneCallsWanted = false
  private var eventSink: FlutterEventSink?
  private var downlink: FlutterBasicMessageChannel?

  init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
    super.init()
    engine.delegate = self
    callKit.delegate = self
    engine.cellularCallActive = { [weak self] in self?.callKit.otherCallActive ?? false }
    phoneCalls.isOwnCall = { [weak self] uuid in self?.callKit.isOwnCall(uuid) ?? false }
    phoneCalls.emit = { [weak self] event in self?.emit(event) }
  }

  /// Phone-call reports run while the app wants them and CallKit is allowed (the call
  /// observer is CallKit; where CallKit is turned off, nothing is reported).
  private func syncPhoneCalls() {
    phoneCalls.setEnabled(phoneCallsWanted && callKit.enabled)
  }

  public static func register(with registrar: FlutterPluginRegistrar) {
    let messenger = registrar.messenger()
    let instance = AgentAudioPlugin(messenger: messenger)
    let methods = FlutterMethodChannel(name: Channels.methods, binaryMessenger: messenger)
    registrar.addMethodCallDelegate(instance, channel: methods)
    let events = FlutterEventChannel(name: Channels.events, binaryMessenger: messenger)
    events.setStreamHandler(instance)
    // ~50 downlink frames/s: keep them off the main thread.
    let taskQueue = messenger.makeBackgroundTaskQueue?()
    let downlink = FlutterBasicMessageChannel(
      name: Channels.downlink, binaryMessenger: messenger, codec: FlutterBinaryCodec.sharedInstance(),
      taskQueue: taskQueue)
    downlink.setMessageHandler { [weak instance] message, reply in
      if let data = message as? Data { instance?.engine.pushDownlink(data) }
      reply(nil)
    }
    instance.downlink = downlink
  }

  public func detachFromEngine(for registrar: FlutterPluginRegistrar) {
    engine.stop(keepWarm: false)
    callKit.enabled = false
    phoneCallsWanted = false
    syncPhoneCalls()
    downlink?.setMessageHandler(nil)
    downlink = nil
    eventSink = nil
  }

  // MARK: - FlutterStreamHandler

  public func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
    eventSink = events
    return nil
  }

  public func onCancel(withArguments arguments: Any?) -> FlutterError? {
    eventSink = nil
    return nil
  }

  private func emit(_ event: [String: Any]) {
    eventSink?(event)
  }

  // MARK: - Methods

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let args = call.arguments as? [String: Any] ?? [:]
    do {
      switch call.method {
      case "prepare":
        guard let format = WireFormat(rawValue: args["format"] as? String ?? "") else {
          throw PluginError.unsupported("Unknown format \(String(describing: args["format"]))")
        }
        engine.useCallKit = callKit.enabled
        try engine.prepare(format: format)
        result(nil)
      case "armMicrophone":
        engine.callKitCallActive = callKit.hasActiveCall
        try engine.arm()
        result(nil)
      case "startUplink":
        try engine.startUplink()
        result(nil)
      case "stop":
        engine.callKitCallActive = callKit.hasActiveCall
        engine.stop(keepWarm: args["keepWarm"] as? Bool ?? true)
        result(nil)
      case "setMuted":
        let muted = args["muted"] as? Bool ?? false
        engine.setMuted(muted)
        callKit.setMuted(muted)
        result(nil)
      case "routes":
        result(engine.availableRoutes())
      case "currentRoute":
        result(engine.currentRoute())
      case "setRoute":
        try engine.setRoute(id: args["id"] as? String ?? "", kind: args["kind"] as? String ?? "")
        result(nil)
      case "setRingback":
        engine.setRingback(args["on"] as? Bool ?? false)
        result(nil)
      case "playChime":
        engine.playChime()
        result(nil)
      case "setInputLevelMetering":
        engine.setMetering(args["enabled"] as? Bool ?? false)
        result(nil)
      case "loopbackTest":
        engine.loopbackTest(
          durationMs: args["durationMs"] as? Int ?? 1500,
          playBack: args["playBack"] as? Bool ?? true
        ) { outcome in
          switch outcome {
          case .success(let value): result(value)
          case .failure(let error): result(FlutterError(code: error.code, message: error.message, details: nil))
          }
        }
      case "configureCallSystem":
        callKit.enabled = args["useCallKit"] as? Bool ?? true
        syncPhoneCalls()
        result(nil)
      case "setPhoneCallMonitoring":
        phoneCallsWanted = args["enabled"] as? Bool ?? false
        syncPhoneCalls()
        result(nil)
      case "startCall":
        callKit.startCall(
          callId: args["callId"] as? String ?? "",
          displayName: args["displayName"] as? String ?? "",
          handle: args["handle"] as? String ?? ""
        ) { error in
          if let error {
            result(FlutterError(code: error.code, message: error.message, details: nil))
          } else {
            result(nil)
          }
        }
      case "reportConnected":
        callKit.reportConnected(callId: args["callId"] as? String ?? "")
        result(nil)
      case "endCall":
        callKit.endCall(callId: args["callId"] as? String ?? "", reason: args["reason"] as? String ?? "local") {
          result(nil)
        }
      // Android only: the on-duty foreground service and battery optimisation.
      case "startOnDutyService", "updateOnDutyService", "stopOnDutyService":
        result(nil)
      case "isIgnoringBatteryOptimizations", "requestIgnoreBatteryOptimizations":
        result(true)
      default:
        result(FlutterMethodNotImplemented)
      }
    } catch let error as PluginError {
      result(FlutterError(code: error.code, message: error.message, details: nil))
    } catch {
      result(FlutterError(code: "unknown", message: error.localizedDescription, details: nil))
    }
  }
}

extension AgentAudioPlugin: VoiceEngineDelegate {
  func voiceEngine(_ engine: VoiceEngine, emit event: [String: Any]) {
    emit(event)
  }

  func voiceEngine(_ engine: VoiceEngine, uplinkFrame frame: Data) {
    messenger.send(onChannel: Channels.uplink, message: frame)
  }
}

extension AgentAudioPlugin: CallKitControllerDelegate {
  var isMuted: Bool { engine.isMuted }

  func callKitDidActivate() {
    engine.sessionActivated()
    emit(["type": "session", "active": true])
  }

  func callKitDidDeactivate() {
    engine.sessionDeactivated()
    emit(["type": "session", "active": false])
  }

  func callKitUserEnded(callId: String) {
    emit(["type": "callAction", "action": "end", "callId": callId, "source": "callKit"])
  }

  func callKitUserSetMuted(callId: String, muted: Bool) {
    engine.setMuted(muted)
    emit(["type": "callAction", "action": "mute", "callId": callId, "muted": muted, "source": "callKit"])
  }

  func callKitDidReset() {
    engine.callKitCallActive = false
    engine.stop(keepWarm: true)
    emit(["type": "callReset"])
  }

  func callKitStartFailed(callId: String) {
    engine.callKitUnavailable()
  }
}
