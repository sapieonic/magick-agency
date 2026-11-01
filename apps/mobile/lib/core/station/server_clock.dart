import 'package:meta/meta.dart';

/// The server-corrected clock (port of the console's `agencyClock.ts` and
/// `useServerClock.ts`).
///
/// `since`, `bridged_at` and `ends_at` are SERVER instants and a phone's clock
/// can be minutes out, so every time the station shows is mapped to this
/// device's clock with the offset the heartbeat measures for free: `ping`
/// sends `ts`, `pong` echoes it and adds `server_ts`.
///
/// The rule this enforces: a repaint timer is a trigger, never a time source.
/// Everything derives from an absolute anchor and the corrected present, so
/// nothing accumulates and nothing drifts over a shift.

/// How many pong samples the offset is the median of. A median, not a mean:
/// one 3-second network stall would poison a mean for the rest of the shift.
const int clockSampleWindow = 5;

/// One offset estimate in ms, SUBTRACTED from a server instant to express it in
/// device time: `rtt = receivedAt − ts; offset = serverTs − (ts + rtt/2)`.
double offsetFromSample({required int ts, required int serverTs, required int receivedAt}) {
  final rtt = receivedAt - ts;
  return serverTs - (ts + rtt / 2);
}

/// Rolling median estimator. Immutable: [push] returns a new one.
@immutable
final class ClockOffsetEstimator {
  const ClockOffsetEstimator._(this._samples);

  static const empty = ClockOffsetEstimator._(<double>[]);

  final List<double> _samples;

  ClockOffsetEstimator push({required int ts, required int serverTs, required int receivedAt}) {
    final next = [..._samples, offsetFromSample(ts: ts, serverTs: serverTs, receivedAt: receivedAt)];
    return ClockOffsetEstimator._(
      List.unmodifiable(next.length > clockSampleWindow ? next.sublist(next.length - clockSampleWindow) : next),
    );
  }

  /// Zero until the first sample lands: before a pong there is no reason to
  /// believe the clock is wrong, and an unmeasured offset is worse than none.
  int get offsetMs {
    if (_samples.isEmpty) return 0;
    final sorted = [..._samples]..sort();
    final mid = sorted.length ~/ 2;
    final m = sorted.length.isOdd ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return m.round();
  }

  int get sampleCount => _samples.length;
}

/// A server instant on this device's clock, or null for null.
DateTime? correctedInstant(DateTime? serverInstant, int offsetMs) =>
    serverInstant?.subtract(Duration(milliseconds: offsetMs));

/// Time since a server anchor, floored at zero (a just-arrived anchor never reads negative).
Duration? elapsedSince(DateTime? anchor, int offsetMs, DateTime now) {
  final corrected = correctedInstant(anchor, offsetMs);
  if (corrected == null) return null;
  final d = now.difference(corrected);
  return d.isNegative ? Duration.zero : d;
}

/// Time until a server deadline, clamped at zero: reaching the deadline is not
/// the end of wrap-up (`agent_state` is), and a negative countdown reads as an
/// overrun timer.
Duration? remainingUntil(DateTime? deadline, int offsetMs, DateTime now) {
  final corrected = correctedInstant(deadline, offsetMs);
  if (corrected == null) return null;
  final d = corrected.difference(now);
  return d.isNegative ? Duration.zero : d;
}

/// `m:ss` (or `h:mm:ss`) for a live duration, floored, never negative.
String formatDuration(Duration d) {
  final total = d.isNegative ? 0 : d.inSeconds;
  final h = total ~/ 3600;
  final m = (total % 3600) ~/ 60;
  final s = total % 60;
  String two(int v) => v.toString().padLeft(2, '0');
  return h > 0 ? '$h:${two(m)}:${two(s)}' : '$m:${two(s)}';
}
