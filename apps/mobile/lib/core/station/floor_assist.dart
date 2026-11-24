import 'package:agency_wire/agency_wire.dart';
import 'package:collection/collection.dart';
import 'package:meta/meta.dart';

import '../api/api_error.dart';
import 'station_api.dart' show errorBodyOf;
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
/// expiry leaves a notice too; a cancel (the agent's own) and the session ending leave none, unless
/// a supervisor answered before the cancel landed (below).
///
/// **A raise in flight.** The frames can beat the raise's answer: a supervisor may answer, and the
/// request end, before the HTTP reply lands. While raising with nothing shown, `help_answered` is
/// kept for its `raised_at` and `help_cleared` leaves its notice at once; the `raised_at` of the
/// last `help_cleared` (or the cancel's answer) is remembered, even with nothing shown, and a
/// raise's answer or a `ready.help` naming it is ignored, so a late reply or a stale snapshot never
/// re-opens a request that already ended (the server keeps no memory of what it cleared).
///
/// **A cancel that lost the race.** A supervisor may answer while the agent's cancel is on its
/// way; the server's cancel then finds nothing open and answers `help: null`, and the frames can
/// land on either side of that reply. Whichever order, the agent is told who answered, never only
/// that it was cancelled: an answer held when the reply lands becomes the notice ([onCancelled]),
/// and a `help_answered` or `help_cleared(answered)` for that request after it says so too.
///
/// **Messages.** Each id is queued once (a resent frame never shows twice), oldest first, until
/// the agent dismisses it. Bounded: past [maxQueued] the oldest is dropped.
@immutable
final class FloorAssistState {
  const FloorAssistState({
    this.help,
    this.answer,
    this.answerFor,
    this.notice,
    this.ended,
    this.cancelled,
    this.messages = const [],
    this.seen = const [],
  });

  static const empty = FloorAssistState();

  /// The most messages held at once; the oldest goes first past it.
  static const maxQueued = 20;

  /// How many message ids are remembered, so a resent frame is not shown again.
  static const maxSeen = 200;

  /// The open request on screen; null for none.
  final SessionHelp? help;

  /// How [help] was answered, from `help_answered`, until its `help_cleared` (held past the
  /// cancel's answer for the request it ended, whose `help_cleared` may still be on its way).
  final HelpAnswer? answer;

  /// The `raised_at` [answer] is about: [help]'s, the request a raise in flight is opening, or
  /// the one the cancel's answer just ended.
  final DateTime? answerFor;

  /// Why the last request ended, when the agent should be told: answered or expired.
  final HelpNotice? notice;

  /// The `raised_at` of the last request seen to end (`help_cleared`, shown or not; the cancel's
  /// answer): a raise's answer or a `ready.help` naming it is late or stale and opens nothing.
  final DateTime? ended;

  /// The `raised_at` of the request the cancel's answer ended, until its `help_cleared`: a
  /// supervisor may have answered it before the cancel landed, and its frames can follow the reply.
  final DateTime? cancelled;

  /// The messages to show, oldest first.
  final List<SupervisorMessageFrame> messages;

  /// The message ids already queued (most recent last).
  final List<String> seen;

  FloorAssistState _with({
    Object? help = _keep,
    Object? answer = _keep,
    Object? answerFor = _keep,
    Object? notice = _keep,
    Object? ended = _keep,
    Object? cancelled = _keep,
    List<SupervisorMessageFrame>? messages,
    List<String>? seen,
  }) => FloorAssistState(
    help: identical(help, _keep) ? this.help : help as SessionHelp?,
    answer: identical(answer, _keep) ? this.answer : answer as HelpAnswer?,
    answerFor: identical(answerFor, _keep) ? this.answerFor : answerFor as DateTime?,
    notice: identical(notice, _keep) ? this.notice : notice as HelpNotice?,
    ended: identical(ended, _keep) ? this.ended : ended as DateTime?,
    cancelled: identical(cancelled, _keep) ? this.cancelled : cancelled as DateTime?,
    messages: messages ?? this.messages,
    seen: seen ?? this.seen,
  );

  static bool _same(DateTime? a, DateTime b) => a != null && a.isAtSameMomentAs(b);

  bool _shows(DateTime raisedAt) => help != null && help!.raisedAt.isAtSameMomentAs(raisedAt);

  /// A frame about the request a raise in flight is opening: nothing shown yet, and not one that
  /// already ended.
  bool _inFlight(DateTime raisedAt, bool raising) => raising && help == null && !_same(ended, raisedAt);

  /// The answer held for [raisedAt], if any.
  HelpAnswer? _answerOf(DateTime raisedAt) => _same(answerFor, raisedAt) ? answer : null;

  /// The answer held for the request raised at [raisedAt] (`help_answered`), if any.
  HelpAnswer? answerOf(DateTime raisedAt) => _answerOf(raisedAt);

  /// Whether a `help_cleared` for [raisedAt] ends a request this station holds (what the end
  /// events of LF39 are sent for): the one shown, the one a raise in flight ([raising]) is opening,
  /// or the one the cancel's answer just ended. A frame about any other request (an earlier one, or
  /// one seen to end already) ends nothing here.
  bool ends(DateTime raisedAt, {bool raising = false}) =>
      _shows(raisedAt) || _inFlight(raisedAt, raising) || _cancelledFirst(raisedAt);

  /// `ready`: the server's whole view of the request ([ReadyFrame.help]). None open clears the
  /// one shown, with no notice (the frame that ended it was missed; nothing says how). One this
  /// station already saw end ([ended]) is stale and ignored.
  FloorAssistState onReady(SessionHelp? open) {
    if (open == null) return help == null ? this : _with(help: null, answer: null, answerFor: null);
    if (_same(ended, open.raisedAt)) return this;
    if (_shows(open.raisedAt)) return help == open ? this : _with(help: open);
    return _open(open);
  }

  /// The raise's answer: the request just raised, or the one already open. One that already ended
  /// while the answer was on its way (its `help_cleared` came first) opens nothing; its notice stays.
  FloorAssistState onRaised(SessionHelp open) {
    if (_same(ended, open.raisedAt)) return this;
    if (_shows(open.raisedAt)) return _with(help: open, notice: null);
    return _open(open);
  }

  /// [open] on screen in place of whatever was, with the answer held for it (a raise in flight's).
  FloorAssistState _open(SessionHelp open) {
    final held = _answerOf(open.raisedAt);
    return _with(help: open, answer: held, answerFor: held == null ? null : open.raisedAt, notice: null, cancelled: null);
  }

  /// The cancel's answer (`help: null`): nothing open, and nothing to tell, unless a supervisor
  /// answered first. Their listen or message reached the request before the cancel did (the server
  /// then finds nothing open, and says only `help: null`): the answer held for it
  /// (`help_answered` came ahead of this reply) becomes the notice, and stays held for the
  /// `help_cleared` still on its way. The agent is never told only that it was cancelled.
  FloorAssistState onCancelled() {
    final open = help;
    if (open == null) return this;
    final held = _answerOf(open.raisedAt);
    return _with(
      help: null,
      notice: held == null ? notice : HelpNotice.answered(held),
      ended: open.raisedAt,
      cancelled: open.raisedAt,
    );
  }

  /// `help_answered`: about the request shown, or ([raising]) the one a raise in flight is opening.
  /// About the request the cancel's answer just ended ([_cancelledFirst]), the cancel lost the race:
  /// the notice says who answered at once.
  FloorAssistState onAnswered(HelpAnsweredFrame f, {bool raising = false}) {
    final answer = HelpAnswer(byName: f.byName, how: f.how);
    if (_shows(f.raisedAt) || _inFlight(f.raisedAt, raising)) return _with(answer: answer, answerFor: f.raisedAt);
    if (_cancelledFirst(f.raisedAt)) return _with(answer: answer, answerFor: f.raisedAt, notice: HelpNotice.answered(answer));
    return this;
  }

  /// A frame about the request the cancel's answer ended ([cancelled]), with nothing shown since:
  /// its frames came behind the reply.
  bool _cancelledFirst(DateTime raisedAt) => help == null && _same(cancelled, raisedAt);

  /// `help_cleared`: ends the request shown, or ([raising]) the one a raise in flight is opening,
  /// whose answer then opens nothing. With nothing shown and no raise in flight it is only
  /// remembered as [ended], with no notice, so a stale `ready.help` naming it opens nothing;
  /// except `answered` for the request the cancel's answer just ended ([_cancelledFirst]): a
  /// supervisor got there first, and the notice says so (with the answer held for it, if any).
  FloorAssistState onCleared(HelpClearedFrame f, {bool raising = false}) {
    if (!_shows(f.raisedAt) && !_inFlight(f.raisedAt, raising)) {
      if (_cancelledFirst(f.raisedAt)) {
        final told = f.reason == HelpClearedReason.answered ? HelpNotice.answered(_answerOf(f.raisedAt)) : this.notice;
        return _with(answer: null, answerFor: null, notice: told, cancelled: null);
      }
      return help != null || _same(ended, f.raisedAt) ? this : _with(ended: f.raisedAt);
    }
    final notice = switch (f.reason) {
      HelpClearedReason.answered => HelpNotice.answered(_answerOf(f.raisedAt)),
      HelpClearedReason.expired => const HelpNotice.expired(),
      HelpClearedReason.cancelled || HelpClearedReason.sessionEnded || HelpClearedReason.unknown => null,
    };
    return _with(help: null, answer: null, answerFor: null, notice: notice, ended: f.raisedAt);
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
  HelpView helpView({required HelpBusy busy, String? error, required DateTime Function(DateTime server) toDevice, bool onlyOnCall = false}) {
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
      onlyOnCall: onlyOnCall,
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
      other.answerFor == answerFor &&
      other.notice == notice &&
      other.ended == ended &&
      other.cancelled == cancelled &&
      const ListEquality<SupervisorMessageFrame>().equals(other.messages, messages) &&
      const ListEquality<String>().equals(other.seen, seen);

  @override
  int get hashCode => Object.hash(help, answer, answerFor, notice, ended, cancelled, Object.hashAll(messages), seen.length);
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

  /// How long a request stays open unanswered, in minutes, as the copy says it (the contract's
  /// `AGENCY_HELP_EXPIRY_MS`, LF4).
  static const expiryMinutes = agencyHelpExpiryMs ~/ 60000;

  static const expired = 'No supervisor answered within $expiryMinutes minutes. Ask again if you still need help.';

  // ── Refusals of the raise and the cancel: the station's words, keyed on the code, then the
  // status, never the server's sentence (AS15; the console's `helpRefusedLine`) ──
  static const disabled = 'Need help is not turned on. Call your supervisor to your desk.';
  static const notOnCall = 'You can ask for help on a call, or while you choose what happened.';
  static const sessionEnded = 'Your work was closed. Open today’s work again to ask for help.';
  static const notFound = 'Your work was not found. Open today’s work again to ask for help.';
  static const notAllowed = 'You cannot ask for help here. Call your supervisor to your desk.';
  static const accountScope = 'Open your work from your account to ask for help.';
  static const raiseOffline = 'Your request for help did not go through. Check your internet and try again.';
  static const cancelOffline = 'Your request could not be cancelled. Check your internet and try again.';
  static const raiseFailed = 'Your request did not go through. Try again.';
  static const cancelFailed = 'Your request could not be cancelled. Try again.';

  /// The words for a refused raise ([raising]) or cancel, from the error.
  static String refusal(Object error, {required bool raising}) {
    if (error is ApiNetworkError) return raising ? raiseOffline : cancelOffline;
    if (error is ApiUnauthorized) return error.userMessage;
    if (error is ApiHttpError) {
      final body = errorBodyOf(error)!;
      switch (body.floorAssistCode) {
        case FloorAssistErrorCode.floorAssistDisabled:
          return disabled;
        case FloorAssistErrorCode.helpNotOnCall:
          return notOnCall;
        case FloorAssistErrorCode.agentNotLive || FloorAssistErrorCode.messageInvalid || FloorAssistErrorCode.unknown:
          break;
      }
      if (body.code == AgencyErrorCode.sessionEnded) return sessionEnded;
      if (body.codeRaw == 'account_scope_required') return accountScope;
      if (error.status == 404) return notFound;
      if (error.status == 403) return notAllowed;
    }
    return raising ? raiseFailed : cancelFailed;
  }
}
