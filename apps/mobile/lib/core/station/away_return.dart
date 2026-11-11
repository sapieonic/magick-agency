import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// What took the agent out of the pool for a while.
enum AwayKind {
  /// The app's own `device_away` pause: they left the app (IQ50).
  app,

  /// The `phone_call` pause: a cellular call (IQ51).
  phoneCall,
}

/// The agent is back from a pause that kept customers from reaching them:
/// the station publishes it once per return, auto-returned or not, so the
/// Missed feature can say how many customers rang meanwhile (IQ50). [since] is
/// when the pause began, on the server's clock (`agent_state.since`, else when
/// the phone asked, corrected by the server-clock offset). [seq] tells two
/// returns from the same moment apart.
@immutable
class AwayReturn {
  const AwayReturn({required this.since, required this.kind, required this.seq});

  final DateTime since;
  final AwayKind kind;
  final int seq;

  @override
  bool operator ==(Object other) =>
      other is AwayReturn && other.since == since && other.kind == kind && other.seq == seq;

  @override
  int get hashCode => Object.hash(since, kind, seq);

  @override
  String toString() => 'AwayReturn(${kind.name} since $since, #$seq)';
}

class AwayReturns extends Notifier<AwayReturn?> {
  @override
  AwayReturn? build() => null;

  /// The agent came back from a pause that began at [since] (server clock).
  void announce(DateTime since, AwayKind kind) =>
      state = AwayReturn(since: since, kind: kind, seq: (state?.seq ?? 0) + 1);
}

/// The station's last return from a pause; null before any. The station core
/// writes it, the Missed feature reads it (`rang_while_away.dart`).
final awayReturnProvider = NotifierProvider<AwayReturns, AwayReturn?>(AwayReturns.new);
