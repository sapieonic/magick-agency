import 'package:agency_wire/agency_wire.dart';

import 'ring_channel.dart';

/// Mode B's pure rules (IQ58–IQ74): whether this phone can be rung while away, and why it
/// stopped ringing.

/// What stops this phone ringing when the agent leaves the app, first failing first.
enum RingBlocker {
  /// The device's status is not known (not read yet, or the read failed).
  statusUnknown,

  /// Ringing is off for the account.
  notAllowed,

  /// The server has no push credentials.
  notConfigured,

  /// No push token on this phone (no Firebase, no Play services): turning ringing on can't help.
  noPush,

  /// The agent has not turned ringing on for this phone.
  optedOut,

  /// The server holds no live registration for this phone.
  notRegistered,

  /// Native could not read the checklist.
  checklistUnknown,

  /// One of the essentials ([RingChecklist.essentialsOk]) is not in place.
  notifications,
  phoneAccount,
  microphone,
}

/// The first thing that stops this phone ringing for inbound calls when the agent leaves the
/// app, or null when nothing does ([ringAvailable]).
RingBlocker? ringBlockerOf({
  required PushDeviceStatus? status,
  required bool optIn,
  required String? token,
  required RingChecklist? checklist,
}) {
  if (status == null) return RingBlocker.statusUnknown;
  if (!status.accountAllowsRing) return RingBlocker.notAllowed;
  if (!status.pushConfigured) return RingBlocker.notConfigured;
  if (token == null || token.isEmpty) return RingBlocker.noPush;
  if (!optIn) return RingBlocker.optedOut;
  final device = status.device;
  if (device == null || !device.pushRegistered || device.revokedAt != null) return RingBlocker.notRegistered;
  if (checklist == null) return RingBlocker.checklistUnknown;
  if (!checklist.ok(RingChecklistItem.notifications)) return RingBlocker.notifications;
  if (!checklist.ok(RingChecklistItem.phoneAccount)) return RingBlocker.phoneAccount;
  if (!checklist.ok(RingChecklistItem.microphone)) return RingBlocker.microphone;
  return null;
}

/// The server's 409 refusal of `away_ring`, as a [RingBlocker].
RingBlocker ringBlockerOfRefusal(AwayRingRefusalCode code) => switch (code) {
      AwayRingRefusalCode.ringNotAllowed => RingBlocker.notAllowed,
      AwayRingRefusalCode.pushUnavailable => RingBlocker.notConfigured,
      AwayRingRefusalCode.noPushDevice => RingBlocker.notRegistered,
      AwayRingRefusalCode.ringDisabled => RingBlocker.optedOut,
      AwayRingRefusalCode.unknown => RingBlocker.statusUnknown,
    };

/// Whether the agent should be told that leaving the app did not ring this phone because of
/// [blocker]: only for what goes wrong on a phone they turned ringing on for. Ringing off for the
/// account, off on this phone, or a status not known says nothing they would expect otherwise.
bool ringBlockerIsNews(RingBlocker? blocker) =>
    blocker != null &&
    blocker != RingBlocker.notAllowed &&
    blocker != RingBlocker.optedOut &&
    blocker != RingBlocker.statusUnknown;

/// Whether leaving the app should ask for `away_ring` rather than `device_away`: the account
/// allows ringing and the deployment can push ([status]), the agent opted in on this phone
/// ([optIn]), the phone has a push address ([token]) that the server holds ([status]'s device
/// registered and not revoked), and nothing on the phone stops it ringing
/// ([RingChecklist.essentialsOk]): no [ringBlockerOf]. Any doubt asks `device_away`: the server
/// refuses `away_ring` on its own reading anyway (409, then the app falls back), so this only
/// spares the round trip.
bool ringAvailable({
  required PushDeviceStatus? status,
  required bool optIn,
  required String? token,
  required RingChecklist? checklist,
}) =>
    ringBlockerOf(status: status, optIn: optIn, token: token, checklist: checklist) == null;

/// A ring that ended on the phone counts as a miss (IQ62): it rang out, or it was answered and
/// not bound within the grace. A decline, `busy_on_phone` or the server taking the caller away
/// is not one.
bool isMissedRing(InboundRingResult reason) =>
    reason == InboundRingResult.expired || reason == InboundRingResult.acceptLapsed;

/// A ring the agent turned away themselves (telemetry's "declined").
bool isDeclinedRing(InboundRingResult reason) =>
    reason == InboundRingResult.declined || reason == InboundRingResult.busyOnPhone;

/// How long one absence on `away_ring` lasts before the server ends it (`max_age`): the server's
/// `AGENCY_AWAY_RING_MAX_MS` default, 4 h (IQ67). The phone uses it only to say why it stopped.
const awayRingMaxAge = Duration(hours: 4);

/// Why the phone stopped ringing during the absence the agent is back from, or null when nothing
/// says it did. The server always ends `away_ring` as `device_away` when the agent comes back
/// (IQ67), so the return itself says nothing: only a concrete reason makes a banner.
///
/// 1. [ringOff]: the `ring_off` native took for this absence (already matched to it): its reason.
/// 2. Else worked out on the phone: [missesWhileAway] ([inboundRingMaxMisses] or more, as
///    `ringEnded` told Dart), the device [status] read on return (revoked, opted out, the flag off,
///    the server unable to push), or an absence of [awayRingMaxAge] or more ([awayFor]).
///
/// Null otherwise: a normal return is not news.
RingOffReason? ringOffReasonOnReturn({
  required RingOffRecord? ringOff,
  required int missesWhileAway,
  required PushDeviceStatus? status,
  required Duration? awayFor,
}) {
  if (ringOff != null) return ringOff.reason;
  if (missesWhileAway >= inboundRingMaxMisses) return RingOffReason.ringMissed;
  if (status != null) {
    if (!status.accountAllowsRing) return RingOffReason.flagOff;
    final device = status.device;
    if (device == null || device.revokedAt != null || pushFailureRevokes(device.lastFailureReason)) {
      return RingOffReason.revoked;
    }
    if (!device.ringEnabled) return RingOffReason.optedOut;
    if (!status.pushConfigured) return RingOffReason.unknown;
  }
  if (awayFor != null && awayFor >= awayRingMaxAge) return RingOffReason.maxAge;
  return null;
}

/// Whether [ringOff] ends the absence that began at [absenceStart] in [sessionId]: the same
/// session (when both say), and an absence starting no more than 2 s before this one's (native
/// already drops older ones; this is the same rule on Dart's side of the channel).
bool ringOffEndsAbsence(RingOffRecord ringOff, {required String sessionId, required DateTime? absenceStart}) {
  final session = ringOff.sessionId;
  if (session != null && session != sessionId) return false;
  final since = ringOff.awaySince;
  if (since == null || absenceStart == null) return true;
  return !since.isBefore(absenceStart.subtract(ringOffTolerance));
}

/// Whether the server revoked the device for a failed push of this [reason]: the token is gone
/// (`unregistered`) or refused for good (`invalid`), as the server's own rule says.
bool pushFailureRevokes(PushFailureReason? reason) =>
    reason == PushFailureReason.unregistered || reason == PushFailureReason.invalid;

/// [ringOffEndsAbsence]'s tolerance between two stamps of one absence's start.
const ringOffTolerance = Duration(seconds: 2);
