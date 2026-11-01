import 'package:flutter/foundation.dart';

import '../../../core/station/station_view.dart';

/// The wrap-up countdown, as the band renders it (mirrors the console's
/// `wrapupView`).
///
/// Pure so the never-negative and held rules are unit-tested against a clock
/// that jumps, not by watching a bar.
@immutable
class WrapupClock {
  const WrapupClock({required this.secondsLeft, required this.fraction, required this.holding, required this.supervisorHold});

  /// Whole seconds left, rounded up, never below zero. Null when the window
  /// has no deadline: there are no digits then.
  final int? secondsLeft;

  /// How full the drain bar is, 1 → 0. Null means *no bar*, which is not the
  /// same as an empty one: with no deadline nothing counts down, and a bar
  /// that never moves reads as a stalled timer. A countdown that reached zero
  /// keeps its (empty) bar so nothing beside it jumps at 0:00.
  final double? fraction;

  /// The window waits on the agent or a supervisor, not on a clock: the band
  /// says who it is waiting on instead of counting past zero.
  final bool holding;
  final bool supervisorHold;

  @override
  bool operator ==(Object other) =>
      other is WrapupClock &&
      other.secondsLeft == secondsLeft &&
      other.fraction == fraction &&
      other.holding == holding &&
      other.supervisorHold == supervisorHold;
  @override
  int get hashCode => Object.hash(secondsLeft, fraction, holding, supervisorHold);
}

WrapupClock wrapupClock(WrapupView w, DateTime now, {required bool requiresDisposition}) {
  final supervisor = w.hold == WrapupHold.supervisor;
  final endsAt = w.endsAt;
  if (endsAt == null) {
    return WrapupClock(
      secondsLeft: null,
      fraction: null,
      holding: supervisor || (w.hold != WrapupHold.none && !w.dispositionSubmitted),
      supervisorHold: supervisor,
    );
  }
  final ms = endsAt.difference(now).inMilliseconds;
  final left = ms <= 0 ? 0 : (ms + 999) ~/ 1000;
  final totalMs = w.secondsTotal * 1000;
  final fraction = totalMs <= 0 ? 0.0 : (ms / totalMs).clamp(0.0, 1.0).toDouble();
  final holding = supervisor || (!w.dispositionSubmitted && (w.hold != WrapupHold.none || (left == 0 && requiresDisposition)));
  return WrapupClock(secondsLeft: left, fraction: fraction, holding: holding, supervisorHold: supervisor);
}
