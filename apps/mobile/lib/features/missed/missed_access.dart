import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// What the shell and My calls read of the Missed list: whether it shows,
/// whether inbound is on, and the badge. The seam (as `softphoneAvailabilityProvider`
/// is the Phone tab's): the default is hidden, and `main.dart` plugs in the
/// count's controller (`missedCallsOverrides`), so a screen test that is not
/// about missed calls never reads the server for them.
@immutable
class MissedCallsAccess {
  const MissedCallsAccess({this.visible = false, this.inboundOn = false, this.badge = ''});

  static const hidden = MissedCallsAccess();

  /// Show the Missed list: the count answered for this agent (they hold
  /// `agency.inbound.read`), and inbound is on or they have rows to finish.
  final bool visible;

  /// `agency_inbound_enabled`. Off with [visible]: the list shows under the
  /// console's notice (callers hear the closed message and are still listed).
  final bool inboundOn;

  /// The open rows: `''` for none, `'100+'` past the server's cap.
  final String badge;

  @override
  bool operator ==(Object other) =>
      other is MissedCallsAccess && other.visible == visible && other.inboundOn == inboundOn && other.badge == badge;

  @override
  int get hashCode => Object.hash(visible, inboundOn, badge);

  @override
  String toString() => 'MissedCallsAccess(visible: $visible, inboundOn: $inboundOn, badge: $badge)';
}

/// Whether the Missed list shows, and its badge. Overridden by the count's
/// controller (`missedCallsOverrides`); hidden by default.
final missedCallsAccessProvider = Provider<MissedCallsAccess>((ref) => MissedCallsAccess.hidden);
