import 'dart:io' show SocketException;

import 'package:agency_wire/agency_wire.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/station/floor_assist.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import 'controller_harness.dart';
import 'fixtures.dart';

/// Floor assist on the station (LF4, LF5, LF15; the app's LF34–LF39): the pure state, then the
/// controller driven only by frame sequences the server sends (`ready.help`, `help_answered` then
/// `help_cleared`, `supervisor_message`) and the help routes' answers.

const raisedAt = '2026-11-01T09:00:20.000Z';
final raisedInstant = DateTime.utc(2026, 11, 1, 9, 0, 20);
const helpPath = '/proxy/agency/sessions/sess-1/help';

Map<String, Object?> helpBody({String raised = raisedAt, String? callId = 'call-1'}) =>
    {'session_id': 'sess-1', 'help': {'raised_at': raised, 'call_id': callId}};

Map<String, Object?> answered({String raised = raisedAt, String? by = 'Anitha N', String how = 'listen'}) =>
    {'event': 'help_answered', 'raised_at': raised, 'by_name': by, 'how': how};

Map<String, Object?> cleared({String raised = raisedAt, String reason = 'answered'}) =>
    {'event': 'help_cleared', 'raised_at': raised, 'reason': reason};

Map<String, Object?> message(String id, {String text = 'Offer the 3-month plan', String? from = 'Anitha N', String at = '2026-11-01T09:00:40.000Z'}) =>
    {'event': 'supervisor_message', 'id': id, 'text': text, 'from_name': from, 'sent_at': at};

SupervisorMessageFrame messageFrame(String id) => StationFrame.decode('{"event":"supervisor_message","id":"$id","text":"t $id",'
    '"from_name":null,"sent_at":"2026-11-01T09:00:40.000Z"}') as SupervisorMessageFrame;

HelpAnsweredFrame answeredFrame(DateTime at, {String? by, HelpAnswerHow how = HelpAnswerHow.listen}) =>
    HelpAnsweredFrame(raisedAt: at, byName: by, how: how);

HelpClearedFrame clearedFrame(DateTime at, HelpClearedReason reason) => HelpClearedFrame(raisedAt: at, reason: reason);

void main() {
  group('FloorAssistState (pure)', () {
    final open = SessionHelp(raisedAt: raisedInstant, callId: 'call-1');
    final earlier = raisedInstant.subtract(const Duration(minutes: 3));

    test('raised, answered, cleared: the answer is told once the request ends, matched by raised_at', () {
      var s = FloorAssistState.empty.onRaised(open);
      expect(s.help, open);
      s = s.onAnswered(answeredFrame(raisedInstant, by: 'Anitha N'));
      expect(s.help, open, reason: 'help_answered says who; help_cleared ends it');
      s = s.onCleared(clearedFrame(raisedInstant, HelpClearedReason.answered));
      expect([s.help, s.notice?.text], [null, 'Anitha N is listening to your call.']);
      expect(s.notice!.expired, isFalse);
    });

    test('a frame about another request never touches the one shown', () {
      final s = FloorAssistState.empty.onRaised(open);
      expect(s.onAnswered(answeredFrame(earlier, by: 'X')), same(s));
      expect(s.onCleared(clearedFrame(earlier, HelpClearedReason.expired)), same(s));
      // Nothing shown: nothing to clear, and nothing to tell; only remembered as ended.
      final unseen = FloorAssistState.empty.onCleared(clearedFrame(raisedInstant, HelpClearedReason.answered));
      expect([unseen.help, unseen.notice, unseen.ended], [null, null, raisedInstant]);
      expect(unseen.onCleared(clearedFrame(raisedInstant, HelpClearedReason.answered)), same(unseen));
      // Another request shown: its own end is what is remembered, not this one's.
      expect(s.onCleared(clearedFrame(earlier, HelpClearedReason.answered)).ended, isNull);
    });

    test('a stale ready.help: a request seen to end, shown or not, is never re-opened by a snapshot naming it', () {
      final unseen = FloorAssistState.empty.onCleared(clearedFrame(raisedInstant, HelpClearedReason.answered));
      expect(unseen.onReady(open), same(unseen));
      final shown = FloorAssistState.empty.onRaised(open).onCleared(clearedFrame(raisedInstant, HelpClearedReason.expired));
      expect(shown.onReady(open), same(shown), reason: 'the expiry notice stays');
      expect(FloorAssistState.empty.onRaised(open).onCancelled().onReady(open).help, isNull);
      // A newer request still opens.
      final newer = SessionHelp(raisedAt: raisedInstant.add(const Duration(minutes: 1)));
      expect(unseen.onReady(newer).help, newer);
    });

    test('the same instant in another spelling still matches (UTC compared as instants)', () {
      final s = FloorAssistState.empty.onRaised(open).onCleared(clearedFrame(raisedInstant.toLocal(), HelpClearedReason.expired));
      expect(s.help, isNull);
    });

    test('each reason: answered and expired leave a notice; cancelled, the session ending and a new reason none', () {
      final base = FloorAssistState.empty.onRaised(open);
      expect(base.onCleared(clearedFrame(raisedInstant, HelpClearedReason.expired)).notice?.text, FloorAssistCopy.expired);
      expect(base.onCleared(clearedFrame(raisedInstant, HelpClearedReason.expired)).notice?.expired, isTrue);
      for (final r in [HelpClearedReason.cancelled, HelpClearedReason.sessionEnded, HelpClearedReason.unknown]) {
        final s = base.onCleared(clearedFrame(raisedInstant, r));
        expect([s.help, s.notice], [null, null], reason: r.name);
      }
      // Answered with no help_answered seen: neutral words.
      expect(base.onCleared(clearedFrame(raisedInstant, HelpClearedReason.answered)).notice?.text,
          'A supervisor answered your request for help.');
    });

    test('who and how, a null name in neutral words', () {
      expect(FloorAssistCopy.answered('Anitha N', HelpAnswerHow.message), 'Anitha N answered with a message.');
      expect(FloorAssistCopy.answered(null, HelpAnswerHow.listen), 'Your supervisor is listening to your call.');
      expect(FloorAssistCopy.answered('  ', HelpAnswerHow.message), 'Your supervisor answered with a message.');
      expect(FloorAssistCopy.answered('Ravi', HelpAnswerHow.unknown), 'Ravi answered your request for help.');
      expect(FloorAssistCopy.sender(null), 'Your supervisor');
      expect(FloorAssistCopy.sender(' Anitha N '), 'Anitha N');
    });

    test('the expiry is said in the contract\'s minutes (AGENCY_HELP_EXPIRY_MS, through agency_wire)', () {
      expect(FloorAssistCopy.expiryMinutes, agencyHelpExpiryMs ~/ Duration.millisecondsPerMinute);
      expect(FloorAssistCopy.expired, 'No supervisor answered within 15 minutes. Ask again if you still need help.');
    });

    test('ready restates the request: none open clears it with no notice; a newer one replaces it', () {
      final s = FloorAssistState.empty.onRaised(open).onAnswered(answeredFrame(raisedInstant, by: 'A'));
      final none = s.onReady(null);
      expect([none.help, none.answer, none.notice], [null, null, null]);
      expect(s.onReady(open), same(s), reason: 'the same request: the answer seen so far is kept');
      final newer = SessionHelp(raisedAt: raisedInstant.add(const Duration(minutes: 1)));
      expect([s.onReady(newer).help, s.onReady(newer).answer], [newer, null]);
      expect(FloorAssistState.empty.onReady(null), same(FloorAssistState.empty));
    });

    test('a raise in flight: its request answered and ended before the reply lands, the reply opens nothing', () {
      var s = FloorAssistState.empty
          .onRaiseStarted(raisedInstant)
          .onAnswered(answeredFrame(raisedInstant, by: 'Anitha N'))
          .onCleared(clearedFrame(raisedInstant, HelpClearedReason.answered));
      expect([s.help, s.notice?.text], [null, 'Anitha N is listening to your call.'], reason: 'told at once');
      s = s.onRaised(open).onRaiseEnded();
      expect([s.help, s.notice?.text], [null, 'Anitha N is listening to your call.']);
      // Answered only: the reply opens it with the answer kept, and the help_cleared that follows names who.
      final answeredFirst =
          FloorAssistState.empty.onRaiseStarted(raisedInstant).onAnswered(answeredFrame(raisedInstant, by: 'Ravi')).onRaised(open).onRaiseEnded();
      expect(answeredFirst.help, open);
      expect(answeredFirst.onCleared(clearedFrame(raisedInstant, HelpClearedReason.answered)).notice?.text,
          'Ravi is listening to your call.');
      // Not raising, nothing shown: still ignored.
      expect(FloorAssistState.empty.onAnswered(answeredFrame(raisedInstant)), same(FloorAssistState.empty));
      // A request that ended (help_cleared, or the cancel's answer) is never re-opened by a late reply,
      // and a repeat of its frames while raising again says nothing new.
      final cancelled = FloorAssistState.empty.onRaised(open).onCancelled();
      expect(cancelled.onRaised(open).help, isNull);
      final repeat = cancelled.onRaiseStarted(raisedInstant).onCleared(clearedFrame(raisedInstant, HelpClearedReason.expired));
      expect([repeat.help, repeat.notice], [null, null]);
    });

    test('a raise in flight takes a frame only about a request stamped no earlier than a minute before the press', () {
      final press = raisedInstant;
      final older = press.subtract(FloorAssistState.inFlightSlack + const Duration(seconds: 1));
      final within = press.subtract(FloorAssistState.inFlightSlack - const Duration(seconds: 1));
      final raising = FloorAssistState.empty.onRaiseStarted(press);
      // An older request (the raise expired it) is not the raise's: no notice, nothing held.
      final ignored = raising.onCleared(clearedFrame(older, HelpClearedReason.expired));
      expect([ignored.notice, ignored.ended], [null, older], reason: 'only remembered as ended');
      expect(raising.holds(older), isFalse);
      expect(raising.onAnswered(answeredFrame(older, by: 'X')), same(raising));
      // Within the slack (the clocks a little apart), it is; exactly at it too.
      expect(raising.holds(within), isTrue);
      expect(raising.holds(press.subtract(FloorAssistState.inFlightSlack)), isTrue);
      expect(raising.onCleared(clearedFrame(within, HelpClearedReason.expired)).notice?.expired, isTrue);
      // Its reply landed or failed: no raise in flight, and the same request is no longer held.
      expect(raising.onRaiseEnded().holds(within), isFalse);
    });

    test('raising again puts the last notice away; the cancel clears the request and says nothing', () {
      final ended = FloorAssistState.empty.onRaised(open).onCleared(clearedFrame(raisedInstant, HelpClearedReason.expired));
      expect(ended.notice, isNotNull);
      // A new request (its own raised_at; the one that ended is never opened again).
      expect(ended.onRaised(SessionHelp(raisedAt: raisedInstant.add(const Duration(minutes: 20)))).notice, isNull);
      final c = FloorAssistState.empty.onRaised(open).onCancelled();
      expect([c.help, c.notice], [null, null]);
      expect(ended.dismissNotice().notice, isNull);
    });

    test('a cancel that lost the race: answered, then the cancel\'s help: null, then help_cleared; told who, never only cancelled', () {
      const listening = 'Anitha N is listening to your call.';
      var s = FloorAssistState.empty.onRaised(open).onAnswered(answeredFrame(raisedInstant, by: 'Anitha N'));
      s = s.onCancelled();
      expect([s.help, s.notice?.text, s.ended], [null, listening, raisedInstant], reason: 'the held answer is the notice');
      final cleared = s.onCleared(clearedFrame(raisedInstant, HelpClearedReason.answered));
      expect([cleared.help, cleared.notice?.text, cleared.answer], [null, listening, null], reason: 'its help_cleared keeps the answer said');
      expect(cleared.onCleared(clearedFrame(raisedInstant, HelpClearedReason.answered)), same(cleared));
      expect(cleared.onReady(open), same(cleared), reason: 'a stale snapshot never re-opens it');
      expect(cleared.onRaised(open).help, isNull, reason: 'nor a late raise reply');
    });

    test('a cancel that lost the race, help_cleared first: answered and ended before the cancel\'s help: null, which keeps the notice', () {
      final s = FloorAssistState.empty
          .onRaised(open)
          .onAnswered(answeredFrame(raisedInstant, by: 'Anitha N', how: HelpAnswerHow.message))
          .onCleared(clearedFrame(raisedInstant, HelpClearedReason.answered));
      expect(s.notice?.text, 'Anitha N answered with a message.');
      expect(s.onCancelled(), same(s));
    });

    test('a cancel that lost the race, its frames after the reply: help_answered tells who; help_cleared alone tells it was answered', () {
      final cancelled = FloorAssistState.empty.onRaised(open).onCancelled();
      expect(cancelled.notice, isNull);
      var s = cancelled.onAnswered(answeredFrame(raisedInstant, by: 'Ravi'));
      expect([s.help, s.notice?.text], [null, 'Ravi is listening to your call.']);
      s = s.onCleared(clearedFrame(raisedInstant, HelpClearedReason.answered));
      expect([s.notice?.text, s.answer], ['Ravi is listening to your call.', null]);
      // help_answered missed: the clear still says a supervisor answered.
      expect(cancelled.onCleared(clearedFrame(raisedInstant, HelpClearedReason.answered)).notice?.text,
          'A supervisor answered your request for help.');
      // The cancel won: its own help_cleared says nothing, and frames about another request nothing either.
      final won = cancelled.onCleared(clearedFrame(raisedInstant, HelpClearedReason.cancelled));
      expect([won.help, won.notice, won.cancelled], [null, null, null]);
      expect(won.onAnswered(answeredFrame(raisedInstant, by: 'X')), same(won), reason: 'its help_cleared closed it');
      expect(cancelled.onAnswered(answeredFrame(earlier, by: 'X')), same(cancelled));
      expect(cancelled.onCleared(clearedFrame(earlier, HelpClearedReason.answered)).notice, isNull);
    });

    test('messages: each id once, oldest first, dismissed by id, bounded', () {
      var s = FloorAssistState.empty.onMessage(messageFrame('m1')).onMessage(messageFrame('m2'));
      expect(s.onMessage(messageFrame('m1')), same(s), reason: 'a resent frame is not shown twice');
      expect(s.messages.map((m) => m.id), ['m1', 'm2']);
      s = s.dismissMessage('m1');
      expect(s.messages.map((m) => m.id), ['m2']);
      expect(s.onMessage(messageFrame('m1')).messages.map((m) => m.id), ['m2'], reason: 'dismissed is still seen');
      expect(s.dismissMessage('nope'), same(s));
      var many = FloorAssistState.empty;
      for (var i = 0; i < FloorAssistState.maxQueued + 5; i++) {
        many = many.onMessage(messageFrame('x$i'));
      }
      expect(many.messages, hasLength(FloorAssistState.maxQueued));
      expect(many.messages.first.id, 'x5');
      expect(() => many.messages.add(messageFrame('y')), throwsUnsupportedError);
    });

    test('the message views name the sender and map the time to this device', () {
      final s = FloorAssistState.empty.onMessage(messageFrame('m1'));
      final v = s.messageViews((t) => t.add(const Duration(seconds: 2))).single;
      expect([v.id, v.text, v.from, v.sentAt], ['m1', 't m1', 'Your supervisor', DateTime.utc(2026, 11, 1, 9, 0, 42)]);
    });

    test('every refusal of the raise and the cancel in words', () {
      ApiHttpError http(int status, Map<String, Object?> body) =>
          ApiHttpError(status: status, code: body['code'] as String?, message: (body['message'] as String?) ?? '', body: body, requestId: null);
      expect(FloorAssistCopy.refusal(http(403, {'code': 'floor_assist_disabled', 'message': 'x'}), raising: true), FloorAssistCopy.disabled);
      expect(FloorAssistCopy.refusal(http(409, {'code': 'help_not_on_call', 'message': 'x'}), raising: true), FloorAssistCopy.notOnCall);
      expect(FloorAssistCopy.refusal(http(409, {'code': 'session_ended', 'message': 'x'}), raising: false), FloorAssistCopy.sessionEnded);
      // Never the server's sentence (AS15): its code, then its status.
      expect(FloorAssistCopy.refusal(http(404, {'error': 'Not Found', 'message': 'Session not found'}), raising: true), FloorAssistCopy.notFound);
      expect(FloorAssistCopy.refusal(http(400, {'code': 'account_scope_required', 'message': 'Choose an account.'}), raising: true),
          FloorAssistCopy.accountScope);
      expect(FloorAssistCopy.refusal(http(403, {'code': 'something_new', 'message': 'A sentence.'}), raising: true), FloorAssistCopy.notAllowed);
      expect(FloorAssistCopy.refusal(http(409, {'code': 'something_new', 'message': 'A sentence.'}), raising: true), FloorAssistCopy.raiseFailed);
      expect(FloorAssistCopy.refusal(http(500, {'message': 'Internal'}), raising: true), FloorAssistCopy.raiseFailed);
      expect(FloorAssistCopy.refusal(http(502, {}), raising: false), FloorAssistCopy.cancelFailed);
      expect(FloorAssistCopy.refusal(const ApiNetworkError('x'), raising: true), FloorAssistCopy.raiseOffline);
      expect(FloorAssistCopy.refusal(const ApiNetworkError('x', timedOut: true), raising: false), FloorAssistCopy.cancelOffline);
      expect(FloorAssistCopy.refusal(const ApiUnauthorized(), raising: true), const ApiUnauthorized().userMessage);
      expect(FloorAssistCopy.refusal(StateError('?'), raising: true), FloorAssistCopy.raiseFailed);
    });
  });

  group('the station controller', () {
    test('declares floor_assist on its upgrade, beside inbound and queue_pool (AS18: a pool campaign\'s queue state)', () {
      fakeAsync((async) {
        final app = App(async)..start();
        expect(app.socket.url.queryParameters['caps'], 'inbound,floor_assist,queue_pool');
        app.dispose();
      });
    });

    test('Need help on a call: raised over HTTP, then a listen answers it (help_answered, help_cleared): who, and nothing open', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.onCall('a1');
        expect(app.view!.help, const HelpView());
        app.run(app.controller.raiseHelp());
        expect(app.requests('POST', helpPath), hasLength(1));
        expect(app.view!.help.stage, HelpStage.open);
        expect(app.view!.help.raisedAt, raisedInstant);
        app.frame(answered());
        expect(app.view!.help.stage, HelpStage.open, reason: 'help_cleared is what ends it on screen');
        app.frame(cleared());
        expect(app.view!.help.stage, HelpStage.none);
        expect(app.view!.help.notice, 'Anitha N is listening to your call.');
        expect(app.view!.help.noticeTone, HelpNoticeTone.success);
        // A second raise asks again: one request at a time, the notice put away.
        app.run(app.controller.raiseHelp());
        expect(app.requests('POST', helpPath), hasLength(2));
        expect(app.view!.help.notice, isNull);
        app.dispose();
      });
    });

    test('in flight: Asking, and a second press sends nothing; open, a raise sends nothing', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) async {
          await Future<void>.delayed(const Duration(seconds: 1));
          return json(200, helpBody());
        };
        app.inWrapup('a1');
        final pending = app.controller.raiseHelp();
        async.flushMicrotasks();
        expect(app.view!.help.stage, HelpStage.raising);
        app.controller.raiseHelp();
        async.elapse(const Duration(seconds: 1));
        app.run(pending);
        expect(app.requests('POST', helpPath), hasLength(1));
        expect(app.view!.help.stage, HelpStage.open);
        app.run(app.controller.raiseHelp());
        expect(app.requests('POST', helpPath), hasLength(1));
        // The station's own actions are not held up by it.
        expect(app.view!.busy, StationBusy.none);
        app.dispose();
      });
    });

    test('a message answers it: the message queued, "answered with a message", a null name neutral', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        app.frame(message('m1', from: null));
        app.frame(answered(by: null, how: 'message'));
        app.frame(cleared());
        expect(app.view!.help.notice, 'Your supervisor answered with a message.');
        final msgs = app.container.read(supervisorMessagesProvider);
        expect(msgs.single.from, 'Your supervisor');
        expect(msgs.single.text, 'Offer the 3-month plan');
        app.dispose();
      });
    });

    test('cancel: DELETE, nothing open, nothing to tell; the help_cleared that follows changes nothing', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.routes['DELETE $helpPath'] = (_) => json(200, {'session_id': 'sess-1', 'help': null});
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        app.run(app.controller.cancelHelp());
        expect(app.requests('DELETE', helpPath), hasLength(1));
        expect(app.view!.help, const HelpView());
        app.frame(cleared(reason: 'cancelled'));
        expect(app.view!.help, const HelpView());
        // Nothing open: a cancel sends nothing.
        app.run(app.controller.cancelHelp());
        expect(app.requests('DELETE', helpPath), hasLength(1));
        app.dispose();
      });
    });

    test('a cancel that lost the race: help_answered while the DELETE is out, help: null, then help_cleared: who is listening, not cancelled', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.routes['DELETE $helpPath'] = (_) async {
          await Future<void>.delayed(const Duration(seconds: 1));
          return json(200, {'session_id': 'sess-1', 'help': null});
        };
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        final pending = app.controller.cancelHelp();
        async.flushMicrotasks();
        expect(app.view!.help.stage, HelpStage.cancelling);
        app.frame(answered());
        async.elapse(const Duration(seconds: 1));
        app.run(pending);
        const said = HelpView(notice: 'Anitha N is listening to your call.', noticeTone: HelpNoticeTone.success);
        expect(app.view!.help, said);
        app.frame(cleared());
        expect(app.view!.help, said);
        app.dispose();
      });
    });

    test('a cancel that lost the race, help_cleared before the reply: the reply keeps who is listening', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.routes['DELETE $helpPath'] = (_) async {
          await Future<void>.delayed(const Duration(seconds: 1));
          return json(200, {'session_id': 'sess-1', 'help': null});
        };
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        final pending = app.controller.cancelHelp();
        async.flushMicrotasks();
        app.frame(answered());
        app.frame(cleared());
        const notice = 'Anitha N is listening to your call.';
        expect([app.view!.help.stage, app.view!.help.notice], [HelpStage.cancelling, notice]);
        async.elapse(const Duration(seconds: 1));
        app.run(pending);
        expect(app.view!.help, const HelpView(notice: notice, noticeTone: HelpNoticeTone.success));
        app.dispose();
      });
    });

    test('a cancel that lost the race, the reply first: the help_answered and help_cleared after it still say who', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.routes['DELETE $helpPath'] = (_) => json(200, {'session_id': 'sess-1', 'help': null});
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        app.run(app.controller.cancelHelp());
        expect(app.view!.help, const HelpView());
        app.frame(answered(by: 'Ravi'));
        app.frame(cleared());
        expect(app.view!.help, const HelpView(notice: 'Ravi is listening to your call.', noticeTone: HelpNoticeTone.success));
        app.dispose();
      });
    });

    test('expired: nobody answered in time, said in the warning tone; a late frame about an earlier request is ignored', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.inWrapup('a1');
        app.run(app.controller.raiseHelp());
        app.frame(cleared(raised: '2026-11-01T08:40:00.000Z', reason: 'expired'));
        expect(app.view!.help.stage, HelpStage.open, reason: 'about another request');
        app.frame(cleared(reason: 'expired'));
        expect([app.view!.help.stage, app.view!.help.notice, app.view!.help.noticeTone],
            [HelpStage.none, FloorAssistCopy.expired, HelpNoticeTone.warning]);
        app.controller.dismissHelpNotice();
        expect(app.view!.help, const HelpView());
        app.dispose();
      });
    });

    test('a slow raise reply: the answer and help_cleared arrive first; the reply re-opens nothing and the notice stays', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) async {
          await Future<void>.delayed(const Duration(seconds: 2));
          return json(200, helpBody());
        };
        app.onCall('a1');
        final pending = app.controller.raiseHelp();
        async.flushMicrotasks();
        expect(app.view!.help.stage, HelpStage.raising);
        app.frame(answered());
        app.frame(cleared());
        expect(app.view!.help.notice, 'Anitha N is listening to your call.');
        async.elapse(const Duration(seconds: 2));
        app.run(pending);
        expect([app.view!.help.stage, app.view!.help.notice], [HelpStage.none, 'Anitha N is listening to your call.']);
        app.dispose();
      });
    });

    test('a slow raise reply after a reconnect\'s ready opened, then ended, the request: the notice is kept', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) async {
          await Future<void>.delayed(const Duration(seconds: 2));
          return json(200, helpBody());
        };
        app.onCall('a1');
        final pending = app.controller.raiseHelp();
        async.flushMicrotasks();
        app.readyFrame('on_call', extra: {'help': {'raised_at': raisedAt, 'call_id': 'call-1'}});
        app.frame(answered(how: 'message'));
        app.frame(cleared());
        expect(app.view!.help.notice, 'Anitha N answered with a message.');
        async.elapse(const Duration(seconds: 2));
        app.run(pending);
        expect([app.view!.help.stage, app.view!.help.notice], [HelpStage.none, 'Anitha N answered with a message.']);
        app.dispose();
      });
    });

    test('help_cleared with nothing shown, then a ready still naming that request: nothing opens', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('a1');
        app.frame(cleared());
        expect(app.view!.help, const HelpView());
        app.readyFrame('on_call', extra: {'help': {'raised_at': raisedAt, 'call_id': 'call-1'}});
        expect(app.view!.help, const HelpView(), reason: 'the server forgot it ended; this station did not');
        app.dispose();
      });
    });

    test('ready restores the open request after a reconnect, and its absence clears one', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('on_call', extra: {'help': {'raised_at': raisedAt, 'call_id': 'call-1'}});
        expect([app.view!.help.stage, app.view!.help.raisedAt], [HelpStage.open, raisedInstant]);
        app.readyFrame('wrapup');
        expect(app.view!.help.stage, HelpStage.none);
        expect(app.view!.help.notice, isNull);
        app.dispose();
      });
    });

    test('every refusal of the raise lands in the help card, never the station\'s action error', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('a1');
        final cases = <(Reply, String)>[
          ((_) => json(403, {'error': 'Forbidden', 'code': 'floor_assist_disabled', 'message': 'x'}), FloorAssistCopy.disabled),
          ((_) => json(409, {'error': 'Conflict', 'code': 'help_not_on_call', 'message': 'x'}), FloorAssistCopy.notOnCall),
          ((_) => json(409, {'error': 'Conflict', 'code': 'session_ended', 'message': 'x'}), FloorAssistCopy.sessionEnded),
          ((_) => json(404, {'error': 'Not Found', 'message': 'Session not found'}), FloorAssistCopy.notFound),
          ((_) => json(500, {'error': 'Internal Server Error', 'message': ''}), FloorAssistCopy.raiseFailed),
          ((_) => throw const SocketException('offline'), FloorAssistCopy.raiseOffline),
        ];
        for (final (reply, words) in cases) {
          app.routes['POST $helpPath'] = reply;
          app.run(app.controller.raiseHelp());
          expect([app.view!.help.stage, app.view!.help.error], [HelpStage.none, words]);
          expect(app.view!.actionError, isNull);
        }
        app.controller.dismissHelpNotice();
        expect(app.view!.help.error, isNull);
        // A 401 is reported to the gate as every station request's is.
        app.routes['POST $helpPath'] = (_) => json(401, {'error': 'Unauthorized', 'message': 'expired'});
        app.run(app.controller.raiseHelp());
        expect(app.unauthorized, isNotEmpty);
        expect(app.view!.help.error, const ApiUnauthorized().userMessage);
        app.dispose();
      });
    });

    test('a refused cancel keeps the request open, except when floor assist is off or the session ended', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST $helpPath'] = (_) => json(200, helpBody());
        app.onCall('a1');
        app.run(app.controller.raiseHelp());
        app.routes['DELETE $helpPath'] = (_) => throw const SocketException('offline');
        app.run(app.controller.cancelHelp());
        expect([app.view!.help.stage, app.view!.help.error], [HelpStage.open, FloorAssistCopy.cancelOffline]);
        app.routes['DELETE $helpPath'] = (_) => json(403, {'error': 'Forbidden', 'code': 'floor_assist_disabled', 'message': 'x'});
        app.run(app.controller.cancelHelp());
        expect([app.view!.help.stage, app.view!.help.error], [HelpStage.none, FloorAssistCopy.disabled]);
        app.dispose();
      });
    });

    test('messages: queued once per id, oldest first, on the shell\'s seam; dismissed by id; a soft-phone session gets them too', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.frame(message('m1'));
        app.frame(message('m2', text: 'Wrap up this call', from: 'Ravi'));
        app.frame(message('m1'));
        final first = app.container.read(supervisorMessagesProvider);
        expect(first.map((m) => (m.id, m.from)), [('m1', 'Anitha N'), ('m2', 'Ravi')]);
        expect(first.first.sentAt, DateTime.utc(2026, 11, 1, 9, 0, 40));
        // A pong (any emit) keeps the same list.
        app.agentStateFrame('available');
        expect(app.container.read(supervisorMessagesProvider), same(first));
        app.container.read(dismissSupervisorMessageProvider)('m1');
        expect(app.container.read(supervisorMessagesProvider).map((m) => m.id), ['m2']);
        app.dispose();
      });
      fakeAsync((async) {
        final app = App(async)..openSoftphone();
        app.frame({...message('s1'), 'event': 'supervisor_message'});
        expect(app.view, isNull, reason: 'a soft-phone session has no campaign view');
        expect(app.container.read(supervisorMessagesProvider).single.id, 's1');
        app.dispose();
      });
    });

    test('leaving the station forgets the request and the messages', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.routes['POST /proxy/agency/sessions/sess-1/leave'] = (_) => json(200, stateBody('offline'));
        app.readyFrame('available');
        app.frame(message('m1'));
        expect(app.container.read(supervisorMessagesProvider), hasLength(1));
        app.run(app.controller.leave());
        expect(app.container.read(supervisorMessagesProvider), isEmpty);
        app.dispose();
      });
    });
  });

  group('break limits on the station view', () {
    test('the reason\'s limit, by its code; none for a reason with none, nor for a reserved code', () {
      fakeAsync((async) {
        final app = App(async);
        app.routes['POST /proxy/agency/sessions'] = (_) => json(200, bootstrapJson(breakReasons: [
              {'code': 'tea', 'label': 'Tea break', 'limit_minutes': 15},
              {'code': 'training', 'label': 'Training'},
              // A catalog cannot list a reserved code; were one there, it still gets no limit.
              {'code': 'device_away', 'label': 'Away', 'limit_minutes': 5},
            ]));
        app.start();
        app.agentStateFrame('break', breakReason: 'tea', since: '2026-11-01T09:00:00.000Z');
        expect(app.view!.onBreak!.limitMinutes, 15);
        expect(app.view!.onBreak!.since, DateTime.utc(2026, 11, 1, 9));
        app.agentStateFrame('break', breakReason: 'training');
        expect(app.view!.onBreak!.limitMinutes, isNull);
        app.agentStateFrame('break', breakReason: 'device_away');
        expect(app.view!.onBreak!.limitMinutes, isNull);
        app.agentStateFrame('break', breakReason: 'lunch');
        expect(app.view!.onBreak!.limitMinutes, isNull, reason: 'a code the catalog does not list');
        app.dispose();
      });
    });
  });
}
