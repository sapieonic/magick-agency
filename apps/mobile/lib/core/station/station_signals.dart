import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The few facts about the station that the app shell needs, kept apart
/// from the full station state so the shell rebuilds only when one of them
/// changes (not on every timer tick or audio frame).
@immutable
class StationSignals {
  const StationSignals({this.onDuty = false, this.callActive = false, this.campaignId});

  /// The agent holds a live station session (any state but offline).
  final bool onDuty;

  /// Reserved, on a call or in wrap-up: the call screen must be in front
  /// and the tab bar hidden, whichever tab the agent was on.
  final bool callActive;

  /// The campaign of the live session, when [onDuty].
  final String? campaignId;

  @override
  bool operator ==(Object other) =>
      other is StationSignals && other.onDuty == onDuty && other.callActive == callActive && other.campaignId == campaignId;

  @override
  int get hashCode => Object.hash(onDuty, callActive, campaignId);
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
