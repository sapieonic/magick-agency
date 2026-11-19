import 'package:agency_wire/agency_wire.dart';
import 'package:meta/meta.dart';

import '../api/api_error.dart';
import 'station_view.dart' show HelpNoticeTone, HelpStage, HelpView, SupervisorMessageView;

/// Floor assist on the station (the Live floor's Phase 3; decisions LF4, LF5, LF13–LF16, and the
/// app's LF34–LF39): the agent's Need help and a supervisor's messages, as the station socket and
/// the help routes tell them. Pure: the controller feeds it frames and answers and reads the views.
///
/// **Need help.** One request at a time, identified by its `raised_at` ([SessionHelp.raisedAt]).
/// It is open from the raise's answer (or `ready.help` on a reconnect) until `help_cleared` for
/// that same instant, or the cancel's answer. A frame about another request (an earlier one, late)
/// never touches the one shown (LF15). `help_answered` says who and how; the `help_cleared` that
/// follows ends the request and leaves a notice of the answer ("Anitha N is listening"). An
/// expiry leaves a notice too; a cancel (the agent's own) and the session ending leave none.
///
/// **Messages.** Each id is queued once (a resent frame never shows twice), oldest first, until
/// the agent dismisses it. Bounded: past [maxQueued] the oldest is dropped.
@immutable
final class FloorAssistState {
  const FloorAssistState({this.help, this.answer, this.notice, this.messages = const [], this.seen = const []});

  static const empty = FloorAssistState();

  /// The most messages held at once; the oldest goes first past it.
  static const maxQueued = 20;

  /// How many message ids are remembered, so a resent frame is not shown again.
  static const maxSeen = 200;

  /// The open request on screen; null for none.
  final SessionHelp? help;

  /// How [help] was answered, from `help_answered`, until its `help_cleared`.
  final HelpAnswer? answer;

  /// Why the last request ended, when the agent should be told: answered or expired.
  final HelpNotice? notice;

  /// The messages to show, oldest first.
  final List<SupervisorMessageFrame> messages;

  /// The message ids already queued (most recent last).
  final List<String> seen;

  FloorAssistState _with({
    Object? help = _keep,
    Object? answer = _keep,
    Object? notice = _keep,
    List<SupervisorMessageFrame>? messages,
    List<String>? seen,
  }) => FloorAssistState(
    help: identical(help, _keep) ? this.help : help as SessionHelp?,
    answer: identical(answer, _keep) ? this.answer : answer as HelpAnswer?,
    notice: identical(notice, _keep) ? this.notice : notice as HelpNotice?,
    messages: messages ?? this.messages,
    seen: seen ?? this.seen,
  );

  bool _shows(DateTime raisedAt) => help != null && help!.raisedAt.isAtSameMomentAs(raisedAt);

  /// `ready`: the server's whole view of the request ([ReadyFrame.help]). None open clears the
  /// one shown, with no notice (the frame that ended it was missed; nothing says how).
  FloorAssistState onReady(SessionHelp? open) {
    if (open == null) return help == null ? this : _with(help: null, answer: null);
    if (_shows(open.raisedAt)) return help == open ? this : _with(help: open);
    return _with(help: open, answer: null, notice: null);
  }

  /// The raise's answer: the request just raised, or the one already open.
  FloorAssistState onRaised(SessionHelp open) =>
      _shows(open.raisedAt) ? _with(help: open, notice: null) : _with(help: open, answer: null, notice: null);

  /// The cancel's answer (`help: null`): nothing open, and nothing to tell.
  FloorAssistState onCancelled() => help == null && answer == null ? this : _with(help: null, answer: null);

  FloorAssistState onAnswered(HelpAnsweredFrame f) =>
      _shows(f.raisedAt) ? _with(answer: HelpAnswer(byName: f.byName, how: f.how)) : this;

  FloorAssistState onCleared(HelpClearedFrame f) {
    if (!_shows(f.raisedAt)) return this;
    final notice = switch (f.reason) {
      HelpClearedReason.answered => HelpNotice.answered(answer),
      HelpClearedReason.expired => const HelpNotice.expired(),
      HelpClearedReason.cancelled || HelpClearedReason.sessionEnded || HelpClearedReason.unknown => null,
    };
    return _with(help: null, answer: null, notice: notice);
  }

  FloorAssistState onMessage(SupervisorMessageFrame f) {
    if (seen.contains(f.id)) return this;
    final queued = [...messages, f];
    final ids = [...seen, f.id];
    return _with(
      messages: List.unmodifiable(queued.length > maxQueued ? queued.sublist(queued.length - maxQueued) : queued),
      seen: List.unmodifiable(ids.length > maxSeen ? ids.sublist(ids.length - maxSeen) : ids),
    );
  }

  FloorAssistState dismissMessage(String id) {
    if (!messages.any((m) => m.id == id)) return this;
    return _with(messages: List.unmodifiable(messages.where((m) => m.id != id)));
  }

  FloorAssistState dismissNotice() => notice == null ? this : _with(notice: null);

  /// The station's help card, with what the controller holds beside it (a request in flight, a refusal).
  HelpView helpView({required HelpBusy busy, String? error, required DateTime Function(DateTime server) toDevice}) {
    final open = help;
    final stage = switch (busy) {
      HelpBusy.raising => HelpStage.raising,
      HelpBusy.cancelling => HelpStage.cancelling,
      HelpBusy.none => open == null ? HelpStage.none : HelpStage.open,
    };
    final n = notice;
    return HelpView(
      stage: stage,
      raisedAt: open == null ? null : toDevice(open.raisedAt),
      notice: n?.text,
      noticeTone: n == null ? null : (n.expired ? HelpNoticeTone.warning : HelpNoticeTone.success),
      error: error,
    );
  }

  /// The messages for the banner, oldest first, the sender named ("Your supervisor" for none).
  List<SupervisorMessageView> messageViews(DateTime Function(DateTime server) toDevice) => List.unmodifiable([
    for (final m in messages)
      SupervisorMessageView(
        id: m.id,
        text: m.text,
        from: FloorAssistCopy.sender(m.fromName),
        sentAt: toDevice(m.sentAt),
      ),
  ]);

  @override
  bool operator ==(Object other) =>
      other is FloorAssistState &&
      other.help == help &&
      other.answer == answer &&
      other.notice == notice &&
      _listEq(other.messages, messages) &&
      _listEq(other.seen, seen);

  @override
  int get hashCode => Object.hash(help, answer, notice, Object.hashAll(messages), seen.length);

  static bool _listEq<T>(List<T> a, List<T> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}

const _keep = Object();

/// A Need help raise or cancel in flight.
enum HelpBusy { none, raising, cancelling }

/// Who answered the open request, and how (`help_answered`).
@immutable
final class HelpAnswer {
  const HelpAnswer({this.byName, required this.how});
  final String? byName;
  final HelpAnswerHow how;

  @override
  bool operator ==(Object other) => other is HelpAnswer && other.byName == byName && other.how == how;
  @override
  int get hashCode => Object.hash(byName, how);
}

/// Why the last request ended, when the agent is told.
@immutable
final class HelpNotice {
  const HelpNotice.expired() : answer = null, expired = true;
  const HelpNotice.answered(this.answer) : expired = false;

  /// How it was answered; null when `help_answered` was not seen (the frame was missed).
  final HelpAnswer? answer;
  final bool expired;

  String get text => expired ? FloorAssistCopy.expired : FloorAssistCopy.answered(answer?.byName, answer?.how);

  @override
  bool operator ==(Object other) => other is HelpNotice && other.answer == answer && other.expired == expired;
  @override
  int get hashCode => Object.hash(answer, expired);
}

/// Floor assist's words on the station. British English; a null name is "Your supervisor" (LF15).
abstract final class FloorAssistCopy {
  static const yourSupervisor = 'Your supervisor';

  static String sender(String? name) => name == null || name.trim().isEmpty ? yourSupervisor : name.trim();

  /// The notice once a supervisor answered.
  static String answered(String? byName, HelpAnswerHow? how) {
    final named = byName != null && byName.trim().isNotEmpty;
    final who = named ? byName.trim() : yourSupervisor;
    return switch (how) {
      HelpAnswerHow.listen => '$who is listening to your call.',
      HelpAnswerHow.message => '$who answered with a message.',
      _ => named ? '$who answered your request for help.' : 'A supervisor answered your request for help.',
    };
  }

  static const expired = 'No supervisor answered within 15 minutes. Ask again if you still need help.';

  // ── Refusals of the raise and the cancel ──
  static const disabled = 'Need help is turned off for your workspace. Ask your supervisor another way.';
  static const notOnCall = 'You can ask for help during a call, or while you finish one.';
  static const sessionEnded = 'Your session on this station has ended, so help can’t be asked for here.';
  static const raiseOffline = 'Your request for help didn’t reach the server. Check your connection and try again.';
  static const cancelOffline = 'Your request couldn’t be cancelled. Check your connection and try again.';
  static const raiseFailed = 'Your request for help didn’t go through. Try again.';
  static const cancelFailed = 'Your request couldn’t be cancelled. Try again.';

  /// The words for a refused raise ([raising]) or cancel, from the error.
  static String refusal(Object error, {required bool raising}) {
    if (error is ApiNetworkError) return raising ? raiseOffline : cancelOffline;
    if (error is ApiUnauthorized) return error.userMessage;
    if (error is ApiHttpError) {
      final body = ErrorBody.fromJson(error.body);
      switch (body.floorAssistCode) {
        case FloorAssistErrorCode.floorAssistDisabled:
          return disabled;
        case FloorAssistErrorCode.helpNotOnCall:
          return notOnCall;
        case FloorAssistErrorCode.agentNotLive || FloorAssistErrorCode.messageInvalid || FloorAssistErrorCode.unknown:
          break;
      }
      if (body.code == AgencyErrorCode.sessionEnded) return sessionEnded;
      if (error.isServerError || body.message.isEmpty) return raising ? raiseFailed : cancelFailed;
      return body.message;
    }
    return raising ? raiseFailed : cancelFailed;
  }
}
