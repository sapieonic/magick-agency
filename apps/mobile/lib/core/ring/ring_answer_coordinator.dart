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

/// What answering a ring needs of the station core ([StationController]). Injectable, so the
/// coordinator is tested without a station.
abstract interface class RingAnswerStation {
  /// The agent answered [callId] and its accept is in flight: the accept's URL is the station's
  /// only attach until [resume] or [release] ([StationController.holdForRingAnswer]).
  void hold(String callId);

  /// The accept failed, or the call was found on the station without it: the hold ends.
  void release(String callId);

  /// Where an accepted ring goes ([StationController.resumeForRing]).
  Future<void> resume(InboundRingAcceptResponse accept);

  /// Whether the station holds [callId] on screen, now or within [within]
  /// ([StationController.holdsRingCall]).
  Future<bool> holdsCall(String callId, Duration within);

  /// The agent hung up [callId] on the phone while it connected: the station hangs it up once it
  /// binds ([StationController.hangUpRingCall]).
  void hangUp(String callId);

  /// "Stop ringing" on a cold start, for the session the absence was in
  /// ([StationController.stopRingingWithoutStation]).
  Future<void> stopRinging(String sessionId);
}

final class _ControllerStation implements RingAnswerStation {
  _ControllerStation(this._ref);
  final Ref _ref;

  StationController get _station => _ref.read(stationControllerProvider.notifier);

  @override
  void hold(String callId) => _station.holdForRingAnswer(callId);

  @override
  void release(String callId) => _station.releaseRingAnswer(callId);

  @override
  Future<void> resume(InboundRingAcceptResponse accept) => _station.resumeForRing(accept);

  @override
  Future<bool> holdsCall(String callId, Duration within) => _station.holdsRingCall(callId, within);

  @override
  void hangUp(String callId) => _station.hangUpRingCall(callId);

  @override
  Future<void> stopRinging(String sessionId) => _station.stopRingingWithoutStation(sessionId);
}

final ringAnswerStationProvider = Provider<RingAnswerStation>(_ControllerStation.new);

/// Answering from a ring (Mode B, IQ71). Native has already posted `…/ring/answering` at the
/// tap (the grace runs from there, [inboundAcceptGrace]); this takes the call:
///
/// 1. The ring answered: native's `ringAnswered` with Flutter running, or `pendingAnswer` once
///    the gate is ready after a cold start from the full-screen intent (the accept needs the
///    agent's Firebase Bearer and the request scope the gate sets).
/// 2. `POST …/ring/accept {offer_token, device_id}` (the station device id, OS3).
/// 3. The station opens on the answer ([RingAnswerStation.resume]), and the Mode A screens take
///    over. From the answer until then the station attaches on nothing but the accept's URL
///    ([RingAnswerStation.hold]): the server takes an attach during a ring as the answer (N5), so
///    a socket of its own (the app brought to the front by the answer) would win the race and the
///    accept would be refused `already_accepted`.
///
/// A failure is retried once when it says nothing about the call (no network, a 5xx, a 429);
/// then, or at once on the server's refusal (`ring_not_offered`, `ring_expired`,
/// `already_accepted`), the agent is told "This call stopped ringing or someone else took it."
/// and native ends the Telecom connection (`reportEnded`, `accept_failed`). `already_accepted`
/// for a call the station holds (or receives within [alreadyAcceptedWindow]) is this phone's own
/// attach having answered first (the socket was already open): the call goes on.
///
/// Hanging up on the phone while the call connects (the "Connecting the call…" notification, a
/// headset or a car): native sends its token-only decline and `ringEnded` `declined`. Once the
/// accept went through the server refuses that decline (N4) and the call binds anyway, so for a
/// call answered here the station hangs it up once it binds; an accept the decline beat is no
/// failure to tell the agent about.
///
/// Also the missed ring: a ring that ended unanswered on the phone (`ringEnded` expired or
/// accept lapsed) posts native's "Missed inbound call" notification.
///
/// No state: what it does shows on the station and in the ring notice.
class RingAnswerCoordinator extends Notifier<void> {
  static final _log = Log('ring.answer');

  /// The wait before the one retry.
  static const retryDelay = Duration(seconds: 1);

  /// How long `already_accepted` waits for the call to show on the station before it is a failure.
  static const alreadyAcceptedWindow = Duration(seconds: 5);

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

  /// Calls answered here that the agent then hung up on the phone, bounded.
  final Set<String> _hungUp = {};

  /// How many calls each of those sets keeps.
  static const _remembered = 32;

  /// Adds [id] to [ids], forgetting the oldest beyond [_remembered]; false when it was there.
  static bool _remember(Set<String> ids, String id) {
    if (!ids.add(id)) return false;
    if (ids.length > _remembered) ids.remove(ids.first);
    return true;
  }

  @override
  void build() {
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
    if (!ref.mounted) return;
    if (pending == null) {
      // A cold start from the away notification's "Stop ringing": the station is not here to read
      // it on its return, so the session it was for is paused (device_away) from here. Read, not
      // taken: the station clears it once device_away applied, so a process that dies first finds
      // it again on its next start (native drops it after one ring window plus the grace).
      final stop = await _channel.peekStopRinging();
      if (stop == null || !ref.mounted) return;
      final session = stop.sessionId;
      if (session == null) {
        // No session to pause: nothing to do with it.
        unawaited(_channel.clearStopRinging());
        return;
      }
      await ref.read(ringAnswerStationProvider).stopRinging(session);
      return;
    }
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
          _wait(answer);
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
          if (reason == InboundRingResult.declined && _taken.contains(callId) && _remember(_hungUp, callId)) {
            _log.info('a ring answered here was hung up on the phone', {'call_id': callId});
            ref.read(ringAnswerStationProvider).hangUp(callId);
          }
        }
      case RingTokenChanged() || RingTestReceived():
        break;
    }
  }

  /// Holds [answer] until the gate is ready. One ring rings at a time, so an answer for another
  /// call means the one held is over on the phone: it is reported ended (`accept_failed`: it was
  /// answered and never accepted) rather than dropped silently, so native lets its call go.
  void _wait(RingAnswer answer) {
    final held = _waiting;
    _waiting = answer;
    if (held == null || held.callId == answer.callId) return;
    _log.warn('a held ring answer was replaced before the gate was ready', {'call_id': held.callId, 'by': answer.callId});
    _remember(_taken, held.callId);
    RingTelemetry.expired(held.callId, reason: 'accept_failed');
    unawaited(_channel.reportEnded(held.callId, RingEndReason.acceptFailed));
  }

  void _received(String callId, String via) {
    if (!_remember(_seen, callId)) return;
    RingTelemetry.received(callId, via: via);
  }

  /// Takes the call [answer] names, once: a second answer for the same call (native delivers
  /// it by `ringAnswered` and again by `pendingAnswer`) does nothing.
  Future<void> answer(RingAnswer answer, {required bool coldStart}) async {
    if (!_remember(_taken, answer.callId)) {
      _log.info('ring answer already taken', {'call_id': answer.callId});
      return;
    }
    RingTelemetry.answered(answer.callId, coldStart: coldStart);
    _log.info('accepting a ring', {'call_id': answer.callId, 'cold_start': coldStart});
    final station = ref.read(ringAnswerStationProvider)..hold(answer.callId);
    final deviceId = await ref.read(stationDeviceIdsProvider).id();
    InboundRefusal? refusal;
    for (var attempt = 0; attempt < 2; attempt++) {
      if (!ref.mounted) return;
      final result = await _api.acceptRing(answer.callId, offerToken: answer.offerToken, deviceId: deviceId);
      if (!ref.mounted) return;
      switch (result) {
        case InboundOk(:final value):
          try {
            await station.resume(value);
          } catch (e, st) {
            _log.error('opening the station for a ring failed', {'call_id': answer.callId}, e, st);
            _failed(answer, null);
            return;
          }
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
          if (r.code == InboundErrorCode.alreadyAccepted) {
            // This phone's own station attached first (N5): the call is ours if it is on screen.
            final held = await station.holdsCall(answer.callId, alreadyAcceptedWindow);
            if (!ref.mounted) return;
            if (held) {
              _log.info('ring already accepted by this station\'s attach', {'call_id': answer.callId});
              station.release(answer.callId);
              return;
            }
          }
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
    // The agent hung up on the phone first (their decline beat the accept): nothing to tell them.
    if (!_hungUp.contains(answer.callId)) ref.read(ringNoticeProvider.notifier).show(RingCopy.acceptFailed);
    ref.read(ringAnswerStationProvider).release(answer.callId);
  }
}

final ringAnswerCoordinatorProvider = NotifierProvider<RingAnswerCoordinator, void>(RingAnswerCoordinator.new);
