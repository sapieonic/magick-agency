import AVFoundation
import CallKit

/// What CallKit tells the plugin. Main thread (the provider's delegate queue is main).
protocol CallKitControllerDelegate: AnyObject {
  func callKitDidActivate()
  func callKitDidDeactivate()
  /// The agent ended the call from the system UI (lock screen, Dynamic Island, a cellular call's
  /// "End & Accept").
  func callKitUserEnded(callId: String)
  /// The agent toggled mute from the system UI.
  func callKitUserSetMuted(callId: String, muted: Bool)
  /// CallKit reset its provider; every call is gone.
  func callKitDidReset()
  /// The call we were waiting on could not start (CallKit refused or failed it).
  func callKitStartFailed(callId: String)
  /// Whether the uplink is muted right now (to tell user toggles from our own requests).
  var isMuted: Bool { get }
}

/// CallKit for outgoing calls: lock-screen controls and correct behaviour around cellular
/// calls, kept out of Recents. One call at a time; no hold, grouping or DTMF.
///
/// Call ids are the app's attempt ids; a UUID-shaped id is used as CallKit's UUID directly,
/// anything else gets a fresh UUID mapped to it.
///
/// China: CallKit must not be used in apps distributed in mainland China. The app turns it off
/// with `configureCallSystem(useCallKit: false)`; then nothing here is created and the engine
/// activates the audio session itself.
final class CallKitController: NSObject, CXProviderDelegate {
  weak var delegate: CallKitControllerDelegate?

  /// When false, every method is a no-op and the provider is torn down.
  var enabled = true {
    didSet {
      if !enabled { invalidate() }
    }
  }

  private var provider: CXProvider?
  private let controller = CXCallController()
  private var uuidById: [String: UUID] = [:]
  private var idByUUID: [UUID: String] = [:]
  /// Ends we asked for (so the perform callback does not report them back as user actions).
  private var localEnds: Set<UUID> = []

  /// A call is reported to CallKit and not yet ended.
  var hasActiveCall: Bool { enabled && !uuidById.isEmpty }

  /// A cellular (or other app's) call is in progress. Used to classify audio interruptions.
  var otherCallActive: Bool {
    guard enabled else { return false }
    return controller.callObserver.calls.contains { !$0.hasEnded && idByUUID[$0.uuid] == nil }
  }

  // MARK: - Requests (main thread)

  func startCall(callId: String, displayName: String, handle: String, completion: @escaping (PluginError?) -> Void) {
    guard enabled else {
      completion(nil)
      return
    }
    let provider = ensureProvider()
    let uuid = UUID(uuidString: callId) ?? uuidById[callId] ?? UUID()
    // Registered before the request, so an armMicrophone() racing this call waits for
    // CallKit to activate the session.
    uuidById[callId] = uuid
    idByUUID[uuid] = callId
    let cxHandle = CXHandle(type: Self.looksLikePhoneNumber(handle) ? .phoneNumber : .generic, value: handle)
    let action = CXStartCallAction(call: uuid, handle: cxHandle)
    action.isVideo = false
    controller.request(CXTransaction(action: action)) { [weak self] error in
      DispatchQueue.main.async {
        guard let self else { return }
        if let error {
          self.forget(uuid)
          self.delegate?.callKitStartFailed(callId: callId)
          completion(.callSystem("CallKit refused the call: \(error.localizedDescription)"))
          return
        }
        // Name and capabilities as shown on the lock screen and in the call UI.
        let update = CXCallUpdate()
        update.remoteHandle = cxHandle
        update.localizedCallerName = displayName
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        provider.reportCall(with: uuid, updated: update)
        completion(nil)
      }
    }
  }

  func reportConnected(callId: String) {
    guard enabled, let uuid = uuidById[callId] else { return }
    provider?.reportOutgoingCall(with: uuid, connectedAt: Date())
  }

  /// `reason` is the Dart `CallEndReason` name.
  func endCall(callId: String, reason: String, completion: @escaping () -> Void) {
    guard enabled, let uuid = uuidById[callId] else {
      completion()
      return
    }
    if reason == "local" {
      localEnds.insert(uuid)
      controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { [weak self] error in
        DispatchQueue.main.async {
          if error != nil {
            // The call is already gone on CallKit's side; report it ended so nothing lingers.
            self?.provider?.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
            self?.localEnds.remove(uuid)
            self?.forget(uuid)
          }
          completion()
        }
      }
      return
    }
    let cxReason: CXCallEndedReason
    switch reason {
    case "failed": cxReason = .failed
    case "unanswered": cxReason = .unanswered
    default: cxReason = .remoteEnded
    }
    provider?.reportCall(with: uuid, endedAt: Date(), reason: cxReason)
    forget(uuid)
    completion()
  }

  /// Keeps the system mute button in step with the app's.
  func setMuted(_ muted: Bool) {
    guard enabled, let uuid = uuidById.values.first else { return }
    controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) { _ in }
  }

  // MARK: - CXProviderDelegate (main queue)

  func providerDidReset(_ provider: CXProvider) {
    uuidById.removeAll()
    idByUUID.removeAll()
    localEnds.removeAll()
    delegate?.callKitDidReset()
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    // The session category is already set by prepare(); CallKit activates it after this.
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    let uuid = action.callUUID
    let requestedHere = localEnds.remove(uuid) != nil
    if !requestedHere, let callId = idByUUID[uuid] {
      delegate?.callKitUserEnded(callId: callId)
    }
    forget(uuid)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    if let callId = idByUUID[action.callUUID], let delegate, delegate.isMuted != action.isMuted {
      delegate.callKitUserSetMuted(callId: callId, muted: action.isMuted)
    }
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    // Holding is not supported (a held agent would block the dialer); refuse it.
    action.fail()
  }

  func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
    // Nothing to undo: a timed-out start surfaces through the request's completion.
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    delegate?.callKitDidActivate()
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    delegate?.callKitDidDeactivate()
  }

  // MARK: - Private

  private func ensureProvider() -> CXProvider {
    if let provider { return provider }
    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = false
    configuration.maximumCallGroups = 1
    configuration.maximumCallsPerCallGroup = 1
    configuration.supportedHandleTypes = [.phoneNumber, .generic]
    // Dialer calls are work calls to customers: keep them out of the phone's Recents.
    configuration.includesCallsInRecents = false
    let provider = CXProvider(configuration: configuration)
    provider.setDelegate(self, queue: nil)
    self.provider = provider
    return provider
  }

  private func invalidate() {
    for uuid in idByUUID.keys {
      provider?.reportCall(with: uuid, endedAt: Date(), reason: .failed)
    }
    uuidById.removeAll()
    idByUUID.removeAll()
    localEnds.removeAll()
    provider?.invalidate()
    provider = nil
  }

  private func forget(_ uuid: UUID) {
    if let id = idByUUID.removeValue(forKey: uuid) { uuidById.removeValue(forKey: id) }
  }

  private static func looksLikePhoneNumber(_ handle: String) -> Bool {
    let allowed = CharacterSet(charactersIn: "+0123456789 -()")
    return !handle.isEmpty && handle.unicodeScalars.allSatisfy { allowed.contains($0) }
  }
}
