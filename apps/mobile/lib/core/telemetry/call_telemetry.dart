import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';

import '../inbound/inbound_call_rules.dart' show inboundOfferKey;
import 'telemetry.dart';

/// What this phone itself saw of a call's audio. The server counts the same
/// thing from its side; this is the phone's side, in PostHog without a log:
/// * [binaryIn]: A-law frames received (the format the app asks for);
/// * [jsonIn]: JSON `pcm16` media frames received, which on the app's `alaw8`
///   socket mean the server did not honour the format (heard as noise);
/// * [sent] / [unsent]: microphone frames the socket took, and refused
///   (closed or reconnecting).
final class CallMedia {
  int binaryIn = 0;
  int jsonIn = 0;
  int sent = 0;
  int unsent = 0;

  void reset() => binaryIn = jsonIn = sent = unsent = 0;

  Map<String, Object> get properties =>
      {'media_binary_in': binaryIn, 'media_json_in': jsonIn, 'media_sent': sent, 'media_unsent': unsent};
}

/// One soft-phone call, or one offer of an inbound call, as this run has seen it.
final class _Tracked {
  _Tracked(this.id, {required this.live, required this.connected});

  /// The soft-phone call's id; for an inbound call its offer ([inboundOfferKey]): a call
  /// requeued and offered again is a second funnel, with its own connect and end.
  final String id;

  /// Seen before it ended (or placed from this phone): its end is this run's
  /// to report. One already over when first seen (a restart after it ended)
  /// was reported by the run that saw it.
  bool live;
  bool connected;
  bool ended = false;
}

/// The station's call events, once per call, named and shaped as the
/// console's (`apps/console/src/analytics/events.ts`) so one dashboard reads
/// both clients, each end with [media] besides:
/// * a campaign call: `agency_attempt_bridged`, `agency_attempt_released`;
/// * a soft-phone call: `agency_softphone_call_bridged`,
///   `agency_softphone_call_ended` (the console has neither; the server
///   settles its calls);
/// * a wrap-up redial: `agency_redial_requested` when Redial is pressed and
///   the request goes out, `agency_redial_refused` when it is refused or gets
///   no usable answer (`code` null). Pressed minus refused is NOT the redials
///   placed: a request with no usable answer may have been placed all the
///   same. Placed redials are the server's to count.
///
/// The station controller feeds it frames and audio; the soft phone tells it
/// which calls it placed ([manualPlaced]).
final class CallTelemetry {
  CallTelemetry({DateTime Function()? now}) : _now = now ?? DateTime.now;

  /// The app's one station.
  static CallTelemetry instance = CallTelemetry();

  @visibleForTesting
  static void resetInstance() => instance = CallTelemetry();

  final DateTime Function() _now;
  final media = CallMedia();

  String? _attemptId;
  String? _campaignId;
  DateTime? _reservedAt;
  DateTime? _bridgedAt;
  _Tracked? _manual;

  // ─── Wrap-up redial ───────────────────────────────────────────────────────

  /// [remaining]: the redials the wrap-up showed when Redial was pressed.
  void redialRequested({required String? campaignId, required int remaining}) =>
      Telemetry.event('agency_redial_requested', {'campaign_id': campaignId, 'redial_remaining': remaining});

  /// [code]: the refusal's code; null when none came back (no network, a
  /// timeout, an unreadable answer), and the redial may have been placed.
  void redialRefused({required String? campaignId, required String? code}) =>
      Telemetry.event('agency_redial_refused', {'campaign_id': campaignId, 'code': code});

  // ─── Campaign calls ───────────────────────────────────────────────────────

  void campaignReserved(ReservedAttempt attempt) {
    _attemptId = attempt.attemptId;
    _campaignId = attempt.campaignId;
    _reservedAt = _now();
    _bridgedAt = null;
    media.reset();
  }

  void campaignBridged(String attemptId) {
    final seen = _attemptId == attemptId;
    if (seen && _bridgedAt != null) return;
    final now = _now();
    final reservedAt = seen ? _reservedAt : null;
    if (!seen) {
      // Rejoined mid-call: the reservation was another run's (or this socket's before a drop).
      _attemptId = attemptId;
      _campaignId = null;
      _reservedAt = null;
    }
    _bridgedAt = now;
    Telemetry.event('agency_attempt_bridged', {
      'campaign_id': _campaignId,
      'ring_seconds': reservedAt == null ? 0 : now.difference(reservedAt).inSeconds,
      'from_reconnect': reservedAt == null,
    });
  }

  void campaignReleased(ReleasedFrame frame) {
    final seen = _attemptId == frame.attemptId;
    final bridgedAt = seen ? _bridgedAt : null;
    Telemetry.event('agency_attempt_released', {
      'campaign_id': seen ? _campaignId : null,
      'reason': frame.reasonRaw,
      'requires_disposition': frame.requiresDisposition,
      'was_bridged': bridgedAt != null,
      'talk_seconds': bridgedAt == null ? 0 : _now().difference(bridgedAt).inSeconds,
      'missed': false,
      ...media.properties,
    });
    _attemptId = null;
    _campaignId = null;
    _reservedAt = null;
    _bridgedAt = null;
    media.reset();
  }

  // ─── Inbound calls ────────────────────────────────────────────────────────
  //
  // The console sends no inbound call events (`apps/console/src/analytics/events.ts` has
  // none), so these follow the soft phone's names: `agency_inbound_call_offered`, `_connected`,
  // `_ended`, and `agency_inbound_outcome_saved` / `_refused`. Ids only: never the caller's
  // number, the contact's name or the notes.

  _Tracked? _inbound;
  DateTime? _inboundOfferedAt;

  /// The last copy of the tracked offer seen: what a synthetic end reports.
  InboundCall? _inboundLast;

  /// The offer this phone chimed for (once per offer: a restatement is not a new one).
  void inboundOffered(InboundCall call) {
    Telemetry.event('agency_inbound_call_offered', {
      'route_id': call.route?.id,
      'matched': call.match != null,
      'campaign_id': call.match?.campaignId,
      'sticky': call.sticky != null,
      'sticky_is_you': call.sticky?.isYou ?? false,
      'recording': call.recording,
      'caller_dnc': call.callerDnc,
      'withheld': call.fromE164 == null,
      'waited_seconds': call.waitedSeconds,
      'catalog_source': call.catalogSourceRaw,
    });
  }

  /// The station's copy of the inbound call, whenever it changes. Tracked per offer
  /// ([inboundOfferKey]): a re-offer of the same call after a requeue starts a new funnel, and
  /// an earlier offer the station never saw end is reported ended as `retired` first.
  void inboundChanged(InboundCall call) {
    final key = inboundOfferKey(call);
    var t = _inbound;
    if (t == null || t.id != key) {
      if (_inboundLast case final last?) inboundLetGo(last);
      final live = call.isLive;
      t = _inbound = _Tracked(key, live: live, connected: call.bridgedAt != null);
      _inboundOfferedAt = live && call.state == InboundCallState.offered ? _now() : null;
      if (live) media.reset();
    }
    _inboundLast = call;
    if (!t.live) return;
    if (!t.connected && call.bridgedAt != null) {
      t.connected = true;
      final offeredAt = _inboundOfferedAt;
      Telemetry.event('agency_inbound_call_connected', {
        'route_id': call.route?.id,
        'offer_seconds': offeredAt == null ? 0 : _now().difference(offeredAt).inSeconds,
        'from_reconnect': offeredAt == null,
      });
    }
    // Left the line: ended, settled before it was answered, or back in the queue.
    final over = call.state == InboundCallState.ended || call.state == InboundCallState.queued || call.isSettled;
    if (over) _inboundEnded(t, call, retired: false);
  }

  /// The station let go of [call] (`last`: the copy it held) without a copy saying it left the
  /// line: retired by the reconnect check, dropped by a campaign `reserved`, or replaced by
  /// another offer. Its end is reported (`retired: true`) unless it already was.
  void inboundLetGo(InboundCall call) {
    final t = _inbound;
    if (t == null || t.id != inboundOfferKey(call) || !t.live) return;
    _inboundEnded(t, call, retired: true);
  }

  void _inboundEnded(_Tracked t, InboundCall call, {required bool retired}) {
    if (t.ended) return;
    t.ended = true;
    Telemetry.event('agency_inbound_call_ended', {
      'route_id': call.route?.id,
      'state': call.stateRaw,
      'outcome': call.outcomeRaw,
      'was_connected': call.bridgedAt != null,
      'talk_seconds': call.talkSeconds ?? 0,
      'retired': retired,
      ...media.properties,
    });
  }

  void inboundOutcomeSaved(InboundCall call, {required String code, required bool callback}) =>
      Telemetry.event('agency_inbound_outcome_saved', {
        'catalog_source': call.catalogSourceRaw,
        'code': code,
        'callback': callback,
      });

  /// [code]: the refusal's code; null when none came back.
  void inboundOutcomeRefused(InboundCall call, {required String? code}) =>
      Telemetry.event('agency_inbound_outcome_refused', {'catalog_source': call.catalogSourceRaw, 'code': code});

  // ─── Soft-phone calls ─────────────────────────────────────────────────────

  /// The soft phone placed [call] from this phone: its end is reported even
  /// when the dial's own answer already says it failed.
  void manualPlaced(ManualCall call) {
    final t = _manual;
    if (t == null || t.id != call.id) {
      _manual = _Tracked(call.id, live: true, connected: false);
      media.reset();
    } else {
      t.live = true;
    }
    manualChanged(call);
  }

  /// The station's copy of the soft-phone call, whenever it changes.
  void manualChanged(ManualCall? call) {
    if (call == null) return;
    var t = _manual;
    if (t == null || t.id != call.id) {
      t = _manual = _Tracked(call.id, live: call.endedAt == null, connected: call.bridgedAt != null);
      media.reset();
    }
    if (call.endedAt == null) t.live = true;
    if (!t.live) return;
    if (!t.connected && call.bridgedAt != null) {
      t.connected = true;
      Telemetry.event('agency_softphone_call_bridged', {'tagged': call.tag != null});
    }
    if (!t.ended && call.endedAt != null) {
      t.ended = true;
      Telemetry.event('agency_softphone_call_ended', {
        'outcome': call.outcomeRaw,
        'end_reason': call.endReasonRaw,
        'state': call.stateRaw,
        'was_bridged': call.bridgedAt != null,
        'talk_seconds': call.talkSeconds ?? 0,
        'tagged': call.tag != null,
        'dnc_overridden': call.dncOverridden,
        'hours_overridden': call.hoursOverridden,
        ...media.properties,
      });
    }
  }
}
