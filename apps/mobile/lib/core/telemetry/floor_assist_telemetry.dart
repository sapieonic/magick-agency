import 'package:agency_wire/agency_wire.dart' show HelpAnswerHow;
import 'package:flutter/foundation.dart';

import '../api/api_error.dart';
import '../station/floor_assist.dart' show HelpRefusal;
import 'telemetry.dart';

/// Where the agent pressed Need help (`surface`): the campaign station's screens, an inbound
/// call's, or a soft phone's (the Phone tab, or the station switched to the soft phone).
enum HelpSurface {
  station('station'),
  inbound('inbound'),
  softphone('softphone');

  const HelpSurface(this.wire);
  final String wire;
}

/// Floor assist's events (decision LF39), named and shaped as the console's
/// (`apps/console/src/analytics/events.ts`) so one dashboard reads both clients. Closed values,
/// counts and booleans only: never a message's text, a name, a number or the supervisor who
/// answered.
///
/// * `agency_help_raised` (`surface`, `on_call`, as at the press): the first raise answer naming a
///   `raised_at` (on screen or not by then: the frames or a `ready.help` may have got there first;
///   never a `ready.help` or a frame by itself);
/// * `agency_help_cancelled` (`wait_bucket`): the agent's cancel ended it;
/// * `agency_help_answered` (`how`, `wait_bucket`): it ended answered, a cancel that lost the race
///   to the answer included (`how` is `unknown` when `help_answered` was not seen);
/// * `agency_help_expired`: it ended `expired`;
/// * `agency_help_refused` (`action`, `code`): a raise or a cancel was refused or failed, or got a
///   2xx this build cannot read (`other`);
/// * `agency_supervisor_message_shown` (`on_call`): a message id was first queued.
///
/// The station controller decides when (it sees the frames and the help routes' answers; the
/// pure `FloorAssistState` says which request a frame ends); this class makes each Need help event
/// fire at most once per request (`raised_at`) on this phone, whatever reconnects, repeated frames
/// or the order of a reply and its frames would otherwise send twice: a request reported raised is
/// never reported raised again, and a request reported ended (cancelled, answered or expired) is
/// never reported ended again. A `session_ended` (or unknown-reason) clear, and a frame about a
/// request this phone did not hold, are for the controller never to report at all.
final class FloorAssistTelemetry {
  /// How many requests are remembered per kind; far more than one session raises.
  static const remembered = 64;

  final List<int> _raised = [];
  final List<int> _ended = [];

  /// True the first time [raisedAt] is added to [seen] (kept to [remembered], oldest dropped).
  static bool _first(List<int> seen, DateTime raisedAt) {
    final key = raisedAt.microsecondsSinceEpoch;
    if (seen.contains(key)) return false;
    seen.add(key);
    if (seen.length > remembered) seen.removeAt(0);
    return true;
  }

  void raised(DateTime raisedAt, {required HelpSurface surface, required bool onCall}) {
    if (!_first(_raised, raisedAt)) return;
    Telemetry.event('agency_help_raised', {'surface': surface.wire, 'on_call': onCall});
  }

  /// The agent's cancel ended the request raised at [raisedAt]; [now] on the server's clock.
  void cancelled(DateTime raisedAt, {required DateTime now}) {
    if (!_first(_ended, raisedAt)) return;
    Telemetry.event('agency_help_cancelled', {'wait_bucket': waitBucket(now.difference(raisedAt))});
  }

  /// The request ended answered; [how] null when `help_answered` was not seen.
  void answered(DateTime raisedAt, HelpAnswerHow? how, {required DateTime now}) {
    if (!_first(_ended, raisedAt)) return;
    Telemetry.event('agency_help_answered', {
      'how': switch (how) {
        HelpAnswerHow.listen => 'listen',
        HelpAnswerHow.message => 'message',
        HelpAnswerHow.unknown || null => 'unknown',
      },
      'wait_bucket': waitBucket(now.difference(raisedAt)),
    });
  }

  void expired(DateTime raisedAt) {
    if (!_first(_ended, raisedAt)) return;
    Telemetry.event('agency_help_expired');
  }

  /// A raise ([raising]) or a cancel was refused or got no answer ([error], as the help routes threw
  /// it), or answered 2xx with a body this build cannot read (no [error]: `other`).
  void refused({required bool raising, Object? error}) =>
      Telemetry.event('agency_help_refused', {'action': raising ? 'raise' : 'cancel', 'code': error == null ? 'other' : refusalCode(error)});

  /// A supervisor's message id first queued for the agent (the controller's once per id).
  void messageShown({required bool onCall}) => Telemetry.event('agency_supervisor_message_shown', {'on_call': onCall});

  /// The refusal's closed code ([HelpRefusal.of]): the floor-assist code, the session's, a 404, no
  /// network, or `other` (a sign-in that expired, a 403 or an account to choose included).
  @visibleForTesting
  static String refusalCode(Object error) => switch (HelpRefusal.of(error)) {
    HelpRefusal.network => 'network',
    HelpRefusal.disabled => 'floor_assist_disabled',
    HelpRefusal.notOnCall => 'help_not_on_call',
    HelpRefusal.sessionEnded => 'session_ended',
    HelpRefusal.notFound => 'not_found',
    // The server sends `account_scope_required` as a 400; one sent as a 404 counts as a 404.
    HelpRefusal.accountScope => error is ApiHttpError && error.status == 404 ? 'not_found' : 'other',
    HelpRefusal.unauthorized || HelpRefusal.notAllowed || HelpRefusal.other => 'other',
  };

  /// How long a request waited, in the buckets of the console's `agency_floor_intervention`
  /// (`secondsInStateBucket`): under a minute, 1–5, 5–15, over 15 minutes. A negative wait (the
  /// clocks a moment apart) is under a minute.
  @visibleForTesting
  static String waitBucket(Duration wait) {
    final seconds = wait.inMilliseconds / 1000;
    if (seconds < 60) return 'under_60';
    if (seconds < 5 * 60) return '1_5m';
    if (seconds < 15 * 60) return '5_15m';
    return 'over_15m';
  }
}
