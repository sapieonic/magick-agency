import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../auth/app_gate.dart';
import '../inbound/inbound_call_api.dart';
import '../station/station_controller.dart';
import '../station/station_device.dart';
import '../telemetry/log.dart';
import 'ring_channel.dart';
import 'ring_copy.dart';
import 'ring_rules.dart';
import 'ring_telemetry.dart';
import 'station_ring.dart';

/// Where an accepted ring goes: the station core's [StationController.resumeForRing].
/// Injectable, so the coordinator is tested without a station.
final ringResumerProvider = Provider<Future<void> Function(InboundRingAcceptResponse accept)>(
  (ref) => (accept) => ref.read(stationControllerProvider.notifier).resumeForRing(accept),
);

/// Answering from a ring (Mode B, IQ71). Native has already posted `…/ring/answering` at the
/// tap (the grace runs from there, [inboundAcceptGrace]); this takes the call:
///
/// 1. The ring answered: native's `ringAnswered` with Flutter running, or `pendingAnswer` once
///    the gate is ready after a cold start from the full-screen intent (the accept needs the
///    agent's Firebase Bearer and the request scope the gate sets).
/// 2. `POST …/ring/accept {offer_token, device_id}` (the station device id, OS3).
/// 3. The station opens on the answer ([ringResumerProvider]), and the Mode A screens take over.
///
/// A failure is retried once when it says nothing about the call (no network, a 5xx, a 429);
/// then, or at once on the server's refusal (`ring_not_offered`, `ring_expired`,
/// `already_accepted`), the agent is told "This call stopped ringing or someone else took it."
/// and native ends the Telecom connection (`reportEnded`, `accept_failed`).
///
/// Also the missed ring: a ring that ended unanswered on the phone (`ringEnded` expired or
/// accept lapsed) posts native's "Missed inbound call" notification.
///
/// State: the call being accepted, or null.
class RingAnswerCoordinator extends Notifier<String?> {
  static final _log = Log('ring.answer');

  /// The wait before the one retry.
  static const retryDelay = Duration(seconds: 1);

  late RingChannel _channel;
  late InboundCallApi _api;
  bool _ready = false;

  /// A ring answered before the gate was ready: taken once it is.
  RingAnswer? _waiting;

  /// Calls already reported received, bounded (one event per call).
  final Set<String> _seen = {};

  /// Calls already taken (accepted, or failed), bounded: native may deliver one answer twice,
  /// by `ringAnswered` and by `pendingAnswer` (a cold start), and each call is accepted once.
  final Set<String> _taken = {};

  @override
  String? build() {
    _channel = ref.read(ringChannelProvider);
    _api = InboundCallApi(
      ref.read(apiClientProvider),
      onUnauthorized: (e) => ref.read(appGateProvider.notifier).reportError(e),
    );
    final events = _channel.events.listen(_onEvent);
    ref.onDispose(() => unawaited(events.cancel()));
    ref.listen<AppGate>(appGateProvider, (prev, next) {
      final was = _ready;
      _ready = next is GateReady;
      if (_ready && !was) scheduleMicrotask(() => unawaited(_whenReady()));
    }, fireImmediately: true);
    return null;
  }

  Future<void> _whenReady() async {
    if (!_ready || !ref.mounted) return;
    final waiting = _waiting;
    _waiting = null;
    if (waiting != null) {
      await answer(waiting, coldStart: false);
      return;
    }
    // Cleared on read: a cold start's answer is taken once.
    final pending = await _channel.pendingAnswer();
    if (pending == null || !ref.mounted) return;
    _received(pending.callId, 'pending_answer');
    await answer(pending, coldStart: true);
  }

  void _onEvent(RingEvent event) {
    switch (event) {
      case RingAnswered(:final answer):
        _received(answer.callId, 'answered');
        if (_ready) {
          unawaited(this.answer(answer, coldStart: false));
        } else {
          _waiting = answer;
        }
      case RingEnded(:final callId, :final reason, :final reasonRaw):
        _received(callId, 'ended');
        if (isMissedRing(reason)) {
          RingTelemetry.expired(callId, reason: reasonRaw);
          // A call the agent answered and could not take (native's `accept_lapsed` once the grace
          // runs out) was not missed by them: they were told why already.
          if (!_taken.contains(callId)) unawaited(_channel.showMissedRing());
        } else if (isDeclinedRing(reason)) {
          RingTelemetry.declined(callId, reason: reasonRaw);
        }
      case RingTokenChanged() || RingTestReceived() || RingStopTapped():
        break;
    }
  }

  void _received(String callId, String via) {
    if (!_seen.add(callId)) return;
    if (_seen.length > 32) _seen.remove(_seen.first);
    RingTelemetry.received(callId, via: via);
  }

  /// Takes the call [answer] names, once: a second answer for the same call (native delivers
  /// it by `ringAnswered` and again by `pendingAnswer`) does nothing.
  Future<void> answer(RingAnswer answer, {required bool coldStart}) async {
    if (!_taken.add(answer.callId)) {
      _log.info('ring answer already taken', {'call_id': answer.callId});
      return;
    }
    if (_taken.length > 32) _taken.remove(_taken.first);
    state = answer.callId;
    RingTelemetry.answered(answer.callId, coldStart: coldStart);
    _log.info('accepting a ring', {'call_id': answer.callId, 'cold_start': coldStart});
    final deviceId = await ref.read(stationDeviceIdsProvider).id();
    InboundRefusal? refusal;
    for (var attempt = 0; attempt < 2; attempt++) {
      if (!ref.mounted) return;
      final result = await _api.acceptRing(answer.callId, offerToken: answer.offerToken, deviceId: deviceId);
      if (!ref.mounted) return;
      switch (result) {
        case InboundOk(:final value):
          try {
            await ref.read(ringResumerProvider)(value);
          } catch (e, st) {
            _log.error('opening the station for a ring failed', {'call_id': answer.callId}, e, st);
            _failed(answer, null);
            return;
          }
          if (ref.mounted && state == answer.callId) state = null;
          return;
        case InboundRefused(refusal: final r):
          refusal = r;
          _log.warn('ring accept refused', {
            'call_id': answer.callId,
            'code': r.code.wire,
            'status': r.status,
            'transient': r.transient,
            'attempt': attempt,
          });
          if (r.transient && attempt == 0) await Future<void>.delayed(retryDelay);
      }
      if (!refusal.transient) break;
    }
    _failed(answer, refusal);
  }

  void _failed(RingAnswer answer, InboundRefusal? refusal) {
    if (!ref.mounted) return;
    final code = refusal == null || refusal.code == InboundErrorCode.unknown ? null : refusal.code.wire;
    RingTelemetry.expired(answer.callId, reason: 'accept_failed', code: code);
    unawaited(_channel.reportEnded(answer.callId, RingEndReason.acceptFailed));
    ref.read(ringNoticeProvider.notifier).show(RingCopy.acceptFailed);
    if (state == answer.callId) state = null;
  }
}

final ringAnswerCoordinatorProvider = NotifierProvider<RingAnswerCoordinator, String?>(RingAnswerCoordinator.new);
