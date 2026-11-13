import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:magick_agency_agent/core/ring/ring_channel.dart';
import 'package:magick_agency_agent/core/ring/ring_rules.dart' show RingBlocker;
import 'package:magick_agency_agent/core/ring/station_ring.dart';

/// The ring channel with no native side: the test plays native. Every Dart → native call is
/// recorded as a string (`reportEnded:call-1:accept_failed`), and [emit] sends a native → Dart
/// event.
class FakeRingChannel implements RingChannel {
  final List<String> calls = [];
  final _events = StreamController<RingEvent>.broadcast(sync: true);

  String? token = 'fcm-token-1';
  RingAnswer? pending;
  RingChecklist? list = const RingChecklist({
    RingChecklistItem.notifications: true,
    RingChecklistItem.fullScreen: true,
    RingChecklistItem.batteryExempt: true,
    RingChecklistItem.microphone: true,
    RingChecklistItem.phoneAccount: true,
    RingChecklistItem.dndAllowsCalls: true,
  });

  void emit(RingEvent event) => _events.add(event);

  List<String> named(String method) => calls.where((c) => c == method || c.startsWith('$method:')).toList();

  @override
  Stream<RingEvent> get events => _events.stream;

  @override
  Future<String?> getToken() async {
    calls.add('getToken');
    return token;
  }

  @override
  Future<RingAnswer?> pendingAnswer() async {
    calls.add('pendingAnswer');
    final p = pending;
    pending = null;
    return p;
  }

  @override
  Future<RingChecklist?> checklist() async {
    calls.add('checklist');
    return list;
  }

  @override
  Future<void> openSettings(RingChecklistItem item) async => calls.add('openSettings:${item.wire}');

  @override
  Future<void> reportBound(String callId) async => calls.add('reportBound:$callId');

  @override
  Future<void> reportEnded(String callId, RingEndReason reason) async => calls.add('reportEnded:$callId:${reason.wire}');

  /// The absence the last `showAwayNotification(true)` named.
  ({DateTime? since, String? sessionId})? awayShownFor;

  @override
  Future<void> showAwayNotification(bool on, {DateTime? since, String? sessionId}) async {
    calls.add('showAwayNotification:$on');
    if (on) awayShownFor = (since: since, sessionId: sessionId);
    // As native: a new absence drops a "Stop ringing" never cleared.
    if (on) stop = null;
  }

  @override
  Future<void> showMissedRing() async => calls.add('showMissedRing');

  @override
  Future<void> holdOverLockScreen(bool on) async => calls.add('holdOverLockScreen:$on');

  /// What `peekStopRinging` answers (left in place until `clearStopRinging`, as native keeps it).
  RingStopRequest? stop;

  @override
  Future<RingStopRequest?> peekStopRinging() async {
    calls.add('peekStopRinging');
    return stop;
  }

  @override
  Future<void> clearStopRinging() async {
    calls.add('clearStopRinging');
    stop = null;
  }

  /// The last `setServerClock`.
  ({int offsetMs, DateTime measuredAt})? serverClock;

  @override
  Future<void> setServerClock({required int offsetMs, required DateTime measuredAt}) async {
    calls.add('setServerClock:$offsetMs');
    serverClock = (offsetMs: offsetMs, measuredAt: measuredAt);
  }

  @override
  Future<bool> moveTaskToBack() async {
    calls.add('moveTaskToBack');
    return true;
  }

  /// What `takeRingOff` answers next (then null: cleared on read).
  RingOffRecord? ringOff;

  @override
  Future<RingOffRecord?> takeRingOff() async {
    calls.add('takeRingOff');
    final r = ringOff;
    ringOff = null;
    return r;
  }
}

/// The station's Mode B seam over a [FakeRingChannel], with the ring switched on or off by the
/// test ([ringOn]) and the device status a return reads ([status]).
class FakeStationRing implements StationRing {
  FakeStationRing(this.channel);

  @override
  final FakeRingChannel channel;

  @override
  bool ringOn = true;

  @override
  RingBlocker? fallbackBlocker;

  PushDeviceStatus? status;
  int statusReads = 0;

  @override
  Future<PushDeviceStatus?> readStatus() async {
    statusReads++;
    return status;
  }
}
