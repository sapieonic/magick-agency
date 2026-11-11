import CallKit
import Foundation

/// Reports a phone call that is not ours (`{type: phoneCall, active}`): CallKit's call observer,
/// which needs no permission and sees cellular calls (and other apps' CallKit calls), ringing
/// or active. The app's own CallKit calls are excluded ([isOwnCall]), so a dialer call never
/// reads as a phone call. Turning it on reports the state then; after that only changes are
/// reported. Main thread only (the observer's delegate queue is main).
final class PhoneCallMonitor: NSObject, CXCallObserverDelegate {
  /// Whether [uuid] is one of the calls this app reported to CallKit.
  var isOwnCall: (UUID) -> Bool = { _ in false }
  var emit: ([String: Any]) -> Void = { _ in }

  private var observer: CXCallObserver?
  private var last: Bool?

  var running: Bool { observer != nil }

  /// Idempotent. Off releases the observer.
  func setEnabled(_ enabled: Bool) {
    if enabled == running { return }
    if enabled {
      let observer = CXCallObserver()
      observer.setDelegate(self, queue: nil)
      self.observer = observer
      let now = otherCallActive(observer)
      last = now
      emit(["type": "phoneCall", "active": now])
    } else {
      observer?.setDelegate(nil, queue: nil)
      observer = nil
      last = nil
    }
  }

  // MARK: - CXCallObserverDelegate (main queue)

  func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
    guard let observer, observer === callObserver else { return }
    let now = otherCallActive(observer)
    if now == last { return }
    last = now
    emit(["type": "phoneCall", "active": now])
  }

  private func otherCallActive(_ observer: CXCallObserver) -> Bool {
    observer.calls.contains { !$0.hasEnded && !isOwnCall($0.uuid) }
  }
}
