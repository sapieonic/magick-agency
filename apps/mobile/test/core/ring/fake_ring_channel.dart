import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:magick_agency_agent/core/ring/ring_channel.dart';
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

  @override
  Future<void> showAwayNotification(bool on) async => calls.add('showAwayNotification:$on');

  @override
  Future<void> showMissedRing() async => calls.add('showMissedRing');
}

/// The station's Mode B seam over a [FakeRingChannel], with the ring switched on or off by the
/// test ([ringOn]) and the device status a return reads ([status]).
class FakeStationRing implements StationRing {
  FakeStationRing(this.channel);

  final FakeRingChannel channel;

  @override
  bool ringOn = true;

  PushDeviceStatus? status;
  int statusReads = 0;

  @override
  Stream<RingEvent> get events => channel.events;

  @override
  void showAwayNotification(bool on) => channel.showAwayNotification(on);

  @override
  void reportBound(String callId) => channel.reportBound(callId);

  @override
  void reportEnded(String callId, RingEndReason reason) => channel.reportEnded(callId, reason);

  @override
  Future<PushDeviceStatus?> readStatus() async {
    statusReads++;
    return status;
  }
}
