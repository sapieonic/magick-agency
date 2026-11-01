import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';

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

/// One soft-phone call as this run has seen it.
final class _Tracked {
  _Tracked(this.id, {required this.live, required this.connected});

  final String id;

  /// Seen before it ended (or placed from this phone): its end is this run's
  /// to report. One already over when first seen (a restart after it ended)
  /// was reported by the run that saw it.
  bool live;
  bool connected;
  bool ended = false;
}

/// The station's call events: `call_connected` and `call_ended`, once per
/// call, for campaign and soft-phone calls alike (`kind`), each end with
/// [media]. The station controller feeds it frames and audio; the soft phone
/// tells it which calls it placed ([manualPlaced]).
final class CallTelemetry {
  CallTelemetry({DateTime Function()? now}) : _now = now ?? DateTime.now;

  /// The app's one station.
  static CallTelemetry instance = CallTelemetry();

  @visibleForTesting
  static void resetInstance() => instance = CallTelemetry();

  final DateTime Function() _now;
  final media = CallMedia();

  String? _attemptId;
  DateTime? _bridgedAt;
  _Tracked? _manual;

  // ─── Campaign calls ───────────────────────────────────────────────────────

  void campaignReserved(String attemptId) {
    _attemptId = attemptId;
    _bridgedAt = null;
    media.reset();
  }

  void campaignBridged(String attemptId) {
    if (_attemptId == attemptId && _bridgedAt != null) return;
    _attemptId = attemptId;
    _bridgedAt = _now();
    Telemetry.event('call_connected', {'kind': 'campaign'});
  }

  void campaignReleased(ReleasedFrame frame) {
    final bridgedAt = _attemptId == frame.attemptId ? _bridgedAt : null;
    Telemetry.event('call_ended', {
      'kind': 'campaign',
      'reason': frame.reasonRaw,
      'connected': bridgedAt != null,
      'requires_disposition': frame.requiresDisposition,
      if (bridgedAt != null) 'connected_s': _now().difference(bridgedAt).inSeconds,
      ...media.properties,
    });
    _attemptId = null;
    _bridgedAt = null;
    media.reset();
  }

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
      Telemetry.event('call_connected', {'kind': 'softphone'});
    }
    if (!t.ended && call.endedAt != null) {
      t.ended = true;
      Telemetry.event('call_ended', {
        'kind': 'softphone',
        'outcome': call.outcomeRaw,
        'end_reason': call.endReasonRaw,
        'state': call.stateRaw,
        'connected': call.bridgedAt != null,
        'talk_s': call.talkSeconds,
        'dnc_overridden': call.dncOverridden,
        'hours_overridden': call.hoursOverridden,
        ...media.properties,
      });
    }
  }
}
