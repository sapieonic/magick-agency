/// The station socket's liveness rules (port of the console's
/// `agencyStationLiveness.ts`): the retry ladder, the silence that means the
/// server has dropped the agent, the flap cap, and the bound on a token mint.
///
/// Pure and clock-free (every function takes the present), so the thresholds
/// are assertable without a socket or a fake timer.
library;

/// The client's own retry ladder. Deliberately not derived from `intervals`:
/// those are the server's liveness parameters, and coupling a retry delay to
/// them would silently retune one when the other moves.
const List<Duration> backoffLadder = [
  Duration(milliseconds: 500),
  Duration(seconds: 1),
  Duration(seconds: 2),
  Duration(seconds: 5),
  Duration(seconds: 10),
  Duration(seconds: 15),
];

Duration backoffFor(int attempt) => backoffLadder[attempt < backoffLadder.length ? attempt : backoffLadder.length - 1];

/// Three unanswered heartbeats: the server has genuinely dropped the agent.
const int missedPingLimit = 3;

/// More than this many sockets that PROVED liveness (answered a ping) and then
/// died inside [flapWindow] is two clients duelling over one session, not a
/// line to wait out. Connect attempts are not counted: an unreachable server
/// walks the ladder out to its ceiling on its own.
const int flapLimit = 6;
const Duration flapWindow = Duration(seconds: 60);

/// A station-token mint that hangs must not leave the station with no socket,
/// no timer and no retry. Mid-call the whole reconnect has 8 s.
const Duration tokenMintTimeout = Duration(seconds: 8);

/// Protocol-level pings (`dart:io` `WebSocket.pingInterval`): a silent drop
/// shows within two intervals, and the server renews liveness from them too.
const Duration protocolPingInterval = Duration(seconds: 3);

/// Refresh the Firebase ID token before a mint when the last refresh is older
/// than this (tokens live an hour).
const Duration idTokenMaxAge = Duration(minutes: 50);

/// Whether a ping we sent has gone unanswered for [missedPingLimit] heartbeats.
/// [unansweredSinceMs] is when the OLDEST unanswered ping went out, 0 when
/// nothing is outstanding: silence is evidence only once we have asked.
bool silentTooLong(int unansweredSinceMs, int nowMs, Duration heartbeat) =>
    unansweredSinceMs != 0 && nowMs - unansweredSinceMs >= missedPingLimit * heartbeat.inMilliseconds;

/// Records one proven-live-then-died socket and says whether that makes a
/// flap. Pruned to [flapWindow] on every pass, so the count is honest. Never
/// mutates [stamps].
({List<int> stamps, bool flapping}) recordLiveThenDead(List<int> stamps, int nowMs) {
  final recent = [
    for (final at in stamps)
      if (nowMs - at < flapWindow.inMilliseconds) at,
    nowMs,
  ];
  return (stamps: recent, flapping: recent.length > flapLimit);
}
