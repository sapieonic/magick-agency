import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Which kind of session the app is hosting (`AgencySessionKind`).
enum StationSessionKind {
  /// A campaign station (which may be switched to the soft phone, SP7).
  campaign,

  /// A soft-phone session opened from the Phone tab: always on the
  /// `soft_phone` break, never in the dialing pool.
  softphone,
}

/// Where the live session's screen is, for the router's hold and the shell.
enum StationHome {
  /// The campaign's station (`Routes.station(campaignId)`), also while it is
  /// switched to the soft phone.
  station,

  /// The Phone tab (`Routes.phone`), for a soft-phone session.
  phone,
}

/// The few facts about the hosted session that the app shell needs, kept apart
/// from the full station state so the shell rebuilds only when one of them
/// changes (not on every timer tick or audio frame).
///
/// The defaults are "no session": a campaign station builds them as it always
/// has, and the soft-phone fields stay at their defaults for it.
@immutable
class StationSignals {
  const StationSignals({
    this.onDuty = false,
    this.callActive = false,
    this.onBreak = false,
    this.campaignId,
    this.sessionKind = StationSessionKind.campaign,
    this.outcomeOwed = false,
    this.onSoftphone = false,
  });

  /// The agent holds a live session (any state but offline): a campaign
  /// station or a soft-phone session.
  final bool onDuty;

  /// The call screen must be in front and the tab bar hidden, whichever tab
  /// the agent was on: a campaign call (reserved, on a call, in wrap-up), or a
  /// soft-phone call on the line (dialing, ringing, on the call).
  final bool callActive;

  /// On a break (the agent's own, paused for leaving the app, or the soft
  /// phone's `soft_phone` break, which a soft-phone session is always on).
  final bool onBreak;

  /// The campaign of the live session, when [onDuty] on a campaign session.
  final String? campaignId;

  /// The hosted session's kind. Meaningful only while [onDuty].
  final StationSessionKind sessionKind;

  /// A soft-phone call ended and owes its outcome: the bar stays, but every
  /// tab but [home]'s is closed until the outcome is saved, and a sign-out waits.
  final bool outcomeOwed;

  /// A campaign session is on the soft phone (`break/soft_phone`): the Phone
  /// tab opens that station, and the station renders the soft-phone panel.
  final bool onSoftphone;

  /// On duty on a campaign and not on a break: the agent belongs on the
  /// station screen, so the other tabs are closed to them until they take a
  /// break or leave. An idle soft-phone session never holds (it is always on a break).
  bool get holdsStation => onDuty && !onBreak;

  /// Where the live session's screen is, or null when there is none to go to.
  /// The router holds the agent there while [callActive], [outcomeOwed] or
  /// [holdsStation].
  StationHome? get home {
    if (!onDuty) return null;
    if (sessionKind == StationSessionKind.softphone) return StationHome.phone;
    return campaignId == null ? null : StationHome.station;
  }

  @override
  bool operator ==(Object other) =>
      other is StationSignals &&
      other.onDuty == onDuty &&
      other.callActive == callActive &&
      other.onBreak == onBreak &&
      other.campaignId == campaignId &&
      other.sessionKind == sessionKind &&
      other.outcomeOwed == outcomeOwed &&
      other.onSoftphone == onSoftphone;

  @override
  int get hashCode => Object.hash(onDuty, callActive, onBreak, campaignId, sessionKind, outcomeOwed, onSoftphone);

  @override
  String toString() =>
      'StationSignals(onDuty: $onDuty, callActive: $callActive, onBreak: $onBreak, campaign: $campaignId, '
      'kind: ${sessionKind.name}, outcomeOwed: $outcomeOwed, onSoftphone: $onSoftphone)';
}

/// Overridden by the station layer with a provider derived from its state.
final stationSignalsProvider = Provider<StationSignals>((ref) => const StationSignals());

/// Takes the agent off duty before a sign-out: leaves the station session and
/// closes its socket, on-duty service and audio. Completes true when nothing
/// is left on duty (or there was no station), false when the server refused
/// because a call went live first (the sign-out then waits for it to end).
///
/// The app gate calls this and knows nothing else about the station; the
/// station layer overrides it (`stationOverrides`). The default has no
/// station to leave.
final stationTeardownProvider = Provider<Future<bool> Function()>((ref) => () async => true);
