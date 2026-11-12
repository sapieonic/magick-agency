import 'package:agency_wire/agency_wire.dart';

import 'ring_channel.dart';

/// Mode B's pure rules (IQ58–IQ74): whether this phone can be rung while away, and why it
/// stopped ringing.

/// Whether leaving the app should ask for `away_ring` rather than `device_away`: the account
/// allows ringing and the deployment can push ([status]), the agent opted in on this phone
/// ([optIn]), the phone has a push address ([token]) that the server holds ([status]'s device
/// registered and not revoked), and nothing on the phone stops it ringing
/// ([RingChecklist.essentialsOk]). Any doubt asks `device_away`: the server refuses `away_ring`
/// on its own reading anyway (409, then the app falls back), so this only spares the round trip.
bool ringAvailable({
  required PushDeviceStatus? status,
  required bool optIn,
  required String? token,
  required RingChecklist? checklist,
}) {
  if (status == null || !status.accountAllowsRing || !status.pushConfigured) return false;
  if (!optIn || token == null || token.isEmpty) return false;
  final device = status.device;
  if (device == null || !device.pushRegistered || device.revokedAt != null) return false;
  return checklist != null && checklist.essentialsOk;
}

/// A ring that ended on the phone counts as a miss (IQ62): it rang out, or it was answered and
/// not bound within the grace. A decline, `busy_on_phone` or the server taking the caller away
/// is not one.
bool isMissedRing(InboundRingResult reason) =>
    reason == InboundRingResult.expired || reason == InboundRingResult.acceptLapsed;

/// A ring the agent turned away themselves (telemetry's "declined").
bool isDeclinedRing(InboundRingResult reason) =>
    reason == InboundRingResult.declined || reason == InboundRingResult.busyOnPhone;

/// Why the server ended `away_ring`, worked out on the phone, which never sees the `ring_off`
/// push itself (native drops the away notification). [missesWhileAway]: the rings that ended
/// unanswered on this phone since `away_ring` began, as `ringEnded` told Dart. [status]: the
/// device's status read on return (null when the read failed). Null when nothing on the phone
/// says which (a long absence, say): the agent is told it stopped, not a guess at why.
RingOffReason? inferRingOffReason({required int missesWhileAway, required PushDeviceStatus? status}) {
  if (missesWhileAway >= inboundRingMaxMisses) return RingOffReason.ringMissed;
  if (status == null) return null;
  if (!status.accountAllowsRing) return RingOffReason.flagOff;
  final device = status.device;
  if (device == null || device.revokedAt != null || device.lastFailureReason == PushFailureReason.unregistered) {
    return RingOffReason.revoked;
  }
  if (!device.ringEnabled) return RingOffReason.optedOut;
  return null;
}
