import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:agent_audio/agent_audio.dart' show PhoneCallChanged;
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/inbound/inbound_call_rules.dart';
import 'package:magick_agency_agent/core/ring/ring_channel.dart';
import 'package:magick_agency_agent/core/ring/ring_copy.dart';
import 'package:magick_agency_agent/core/ring/station_ring.dart';
import 'package:magick_agency_agent/core/station/station_controller.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import '../inbound/inbound_fixtures.dart';
import '../ring/fake_ring_channel.dart';
import 'controller_harness.dart';

/// Mode B on the station core (IQ58–IQ74): leaving the app asks `away_ring` when this phone can
/// ring; once it applies the socket parks and the on-duty service stops; coming back reopens
/// them; a ring answered reopens the station on the accept's URL. Driven by the frames the
/// server sends (the contract's samples), never an injected `agent_state` to move the screen.

const _breakPath = '/proxy/agency/sessions/sess-1/break';
const _availablePath = '/proxy/agency/sessions/sess-1/available';
const _pushCallId = '7d2b9e4f-6a1c-4e3d-8b5a-2f9c0e1d7a64';

/// The harness with Mode B's seam over a fake channel.
final class _Ring {
  _Ring(FakeAsync async, {bool ringOn = true}) {
    ring.ringOn = ringOn;
    app = App(async, overrides: [stationRingProvider.overrideWithValue(ring)]);
  }

  final channel = FakeRingChannel();
  late final ring = FakeStationRing(channel);
  late final App app;

  /// On duty and available, with the break route answering as the server applies [reason].
  void availableThenAway({void Function()? beforeAnswer}) {
    app.start();
    app.readyFrame('available');
    app.agentStateFrame('available');
    app.routes['POST $_breakPath'] = (r) {
      final reason = (r.body! as Map<String, Object?>)['reason']! as String;
      // The server states the break on the socket before it answers.
      app.socket.serverText(jsonEncode({
        'event': 'agent_state',
        'state': 'break',
        'since': '2026-11-01T09:00:00.000Z',
        'break_reason': reason,
      }));
      beforeAnswer?.call();
      return json(200, stateBody('break', breakReason: reason));
    };
    app.lifecycle.hide();
    app.async.flushMicrotasks();
  }
}

/// A push offer's frame as the server sends it once the station has attached after an accept
/// (`connects_at` null, `accepted_at` set): the contract's sample, on the harness's session.
Map<String, Object?> _pushFrame(String name, {Map<String, Object?> call = const {}}) => stationFrame(name, call: {
      'id': _pushCallId,
      'offered_at': '2026-11-01T09:00:10.000Z',
      'offer_channel': 'push',
      'connects_at': null,
      'ring_expires_at': null,
      'accepted_at': '2026-11-01T09:00:16.000Z',
      ...call,
    });

/// `…/ring/accept`'s answer (the contract's sample), on the harness's session and campaign.
InboundRingAcceptResponse _accept({String url = '/proxy/agency/station?token=accept1'}) {
  final body = pushSample('ring_accept_response');
  body['session_id'] = 'sess-1';
  body['campaign_id'] = 'camp-1';
  body['station_ws_url'] = url;
  body['station_token_expires_at'] = '2026-11-01T09:05:00.000Z';
  final call = body['call']! as Map<String, Object?>;
  call['session_id'] = 'sess-1';
  call['offered_at'] = '2026-11-01T09:00:10.000Z';
  call['accepted_at'] = '2026-11-01T09:00:16.000Z';
  return InboundRingAcceptResponse.fromJson(body);
}

void main() {
  group('leaving the app (IQ58, IQ67)', () {
    test('ringing on: away_ring is asked; once it applies the socket parks, the on-duty service stops, '
        'and the away notification shows instead of "You\'re paused"', () {
      fakeAsync((async) {
        final r = _Ring(async)..availableThenAway();
        final app = r.app;
        expect(app.requests('POST', _breakPath).single.body, {'reason': 'away_ring'});
        expect(app.socket.closed, isTrue, reason: 'parked: the server keeps an away_ring session with no socket');
        expect(app.engine.calls, contains('fgs.stop'));
        expect(r.channel.named('showAwayNotification'), ['showAwayNotification:true']);
        expect(app.notifier.calls, isNot(contains('paused')));
        async.elapse(const Duration(minutes: 5));
        expect(app.connector.attempts, 1, reason: 'never reconnected while away');
        app.dispose();
      });
    });

    test('ringing off: device_away, as without Mode B, and the socket stays', () {
      fakeAsync((async) {
        final r = _Ring(async, ringOn: false)..availableThenAway();
        expect(r.app.requests('POST', _breakPath).single.body, {'reason': 'device_away'});
        expect(r.app.socket.closed, isFalse);
        expect(r.app.notifier.calls.last, 'paused');
        expect(r.channel.named('showAwayNotification'), isEmpty);
        r.app.dispose();
      });
    });

    test('away_ring refused 409 (an away-ring code): device_away at once, and the agent is told they are paused', () {
      fakeAsync((async) {
        final r = _Ring(async);
        final app = r.app..start();
        app.readyFrame('available');
        app.agentStateFrame('available');
        app.routes['POST $_breakPath'] = (req) => (req.body! as Map<String, Object?>)['reason'] == 'away_ring'
            ? json(409, pushSample('refusal_no_push_device'))
            : json(200, stateBody('break', breakReason: 'device_away'));
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath).map((s) => (s.body! as Map<String, Object?>)['reason']), ['away_ring', 'device_away']);
        app.agentStateFrame('break', breakReason: 'device_away');
        expect(app.socket.closed, isFalse);
        expect(app.notifier.calls.last, 'paused');
        expect(r.channel.named('showAwayNotification'), isEmpty);
        app.dispose();
      });
    });

    test('a pause queued in wrap-up queues away_ring; once it applies after the call, the socket parks', () {
      fakeAsync((async) {
        final r = _Ring(async);
        final app = r.app..start();
        app.inWrapup('att-1');
        app.routes['POST $_breakPath'] = (_) => json(200, stateBody('wrapup', breakReason: 'away_ring', pending: 'break'));
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath).single.body, {'reason': 'away_ring'});
        expect(app.socket.closed, isFalse, reason: 'the wrap-up is still on');
        app.agentStateFrame('break', breakReason: 'away_ring', since: '2026-11-01T09:00:05.000Z');
        expect(app.socket.closed, isTrue);
        expect(r.channel.named('showAwayNotification'), ['showAwayNotification:true']);
        app.dispose();
      });
    });

    test('the phone_call pause still wins while the app is open: away_ring is not asked on top of it', () {
      fakeAsync((async) {
        final r = _Ring(async);
        final app = r.app..start();
        app.readyFrame('available');
        app.agentStateFrame('available');
        app.routes['POST $_breakPath'] = (_) => json(200, stateBody('break', breakReason: 'phone_call'));
        app.engine.emitEvent(const PhoneCallChanged(active: true));
        async.flushMicrotasks();
        app.agentStateFrame('break', breakReason: 'phone_call');
        app.lifecycle.hide();
        async.flushMicrotasks();
        expect(app.requests('POST', _breakPath).map((s) => (s.body! as Map<String, Object?>)['reason']), ['phone_call']);
        expect(app.socket.closed, isFalse);
        app.dispose();
      });
    });
  });

  group('coming back from away_ring', () {
    test('within 30 s: the notification goes, the on-duty service and the socket reopen, then /available (IQ50)', () {
      fakeAsync((async) {
        final r = _Ring(async)..availableThenAway();
        final app = r.app;
        app.routes['POST $_availablePath'] = (_) => json(200, stateBody('available'));
        final starts = app.engine.calls.where((c) => c == 'fgs.start').length;
        async.elapse(const Duration(seconds: 20));
        app.lifecycle.show();
        async.flushMicrotasks();
        expect(r.channel.named('showAwayNotification'), ['showAwayNotification:true', 'showAwayNotification:false']);
        expect(app.engine.calls.where((c) => c == 'fgs.start').length, starts + 1);
        expect(app.connector.attempts, 2, reason: 'the socket reopens');
        expect(app.requests('POST', _availablePath), isEmpty, reason: 'decided once the station says where the agent stands');
        app.readyFrame('break', extra: {'break_reason': 'away_ring'});
        async.flushMicrotasks();
        expect(app.requests('POST', _availablePath), hasLength(1));
        expect(app.container.read(ringNoticeProvider), isNull, reason: 'away_ring held: nothing to explain');
        app.dispose();
      });
    });

    test('after 30 s: the away card says this phone rings for inbound calls, and waits for the tap', () {
      fakeAsync((async) {
        final r = _Ring(async)..availableThenAway();
        final app = r.app;
        async.elapse(const Duration(minutes: 2));
        app.lifecycle.show();
        async.flushMicrotasks();
        app.readyFrame('break', extra: {'break_reason': 'away_ring'});
        async.flushMicrotasks();
        expect(app.requests('POST', _availablePath), isEmpty);
        final onBreak = app.view!.onBreak!;
        expect(onBreak.isDeviceAway, isTrue);
        expect(onBreak.isAwayRing, isTrue);
        expect(onBreak.label, 'Away · rings for inbound');
        app.dispose();
      });
    });

    test('the server ended away_ring after two missed rings: the agent is told why', () {
      fakeAsync((async) {
        final r = _Ring(async)..availableThenAway();
        final app = r.app;
        r.channel.emit(RingEnded(_pushCallId, 'expired'));
        r.channel.emit(RingEnded('other-call', 'accept_lapsed'));
        async.elapse(const Duration(minutes: 3));
        app.lifecycle.show();
        async.flushMicrotasks();
        app.readyFrame('break', extra: {'break_reason': 'device_away'});
        async.flushMicrotasks();
        expect(app.container.read(ringNoticeProvider), RingCopy.stopped(RingOffReason.ringMissed));
        expect(app.container.read(ringNoticeProvider), 'Your phone stopped ringing for inbound calls: you missed two in a row.');
        app.dispose();
      });
    });

    test('ended for another reason: the device status read on return says which', () {
      fakeAsync((async) {
        final r = _Ring(async)..availableThenAway();
        final app = r.app;
        r.ring.status = PushDeviceStatus.fromJson(pushSample('device_status_unregistered'));
        r.channel.emit(RingEnded(_pushCallId, 'declined'));
        async.elapse(const Duration(minutes: 3));
        app.lifecycle.show();
        async.flushMicrotasks();
        app.readyFrame('break', extra: {'break_reason': 'device_away'});
        async.flushMicrotasks();
        expect(r.ring.statusReads, 1);
        expect(app.container.read(ringNoticeProvider), RingCopy.stopped(RingOffReason.revoked));
        app.dispose();
      });
    });
  });

  group('answered from a ring (resumeForRing)', () {
    test('the station parked on away_ring: reopened on the accept\'s URL, the call on screen at once, '
        'native told when it binds and when it ends', () {
      fakeAsync((async) {
        final r = _Ring(async)..availableThenAway();
        final app = r.app;
        expect(app.socket.closed, isTrue);
        app.run(app.controller.resumeForRing(_accept()));
        async.flushMicrotasks();
        expect(app.connector.attempts, 2);
        expect(app.socket.url.queryParameters['token'], 'accept1', reason: 'the accept minted the token');
        expect(app.socket.url.queryParameters['caps'], 'inbound');
        expect(app.mints, 0, reason: 'no second mint: it would replace the accept\'s token');
        expect(r.channel.named('showAwayNotification').last, 'showAwayNotification:false');
        expect(app.engine.calls.where((c) => c == 'fgs.start'), hasLength(2), reason: 'the on-duty service started again');
        var v = app.view!;
        expect(v.inbound!.stage, InboundStage.offered);
        expect(app.signals.callActive, isTrue);

        // The server's frames on the attach: ready (reserved), the push offer, then the bind.
        app.readyFrame('reserved');
        app.frame(_pushFrame('inbound_call_push_accepted'));
        expect(app.view!.inbound!.stage, InboundStage.offered, reason: 'ready says reserved: the offer is kept');
        expect(app.engine.chimes, 0, reason: 'it rang as a phone call already');
        app.frame(agentStateFrameJson('on_call', '2026-11-01T09:00:17.000Z'));
        app.frame(_pushFrame('inbound_call_connected', call: {'bridged_at': '2026-11-01T09:00:17.000Z'}));
        v = app.view!;
        expect(v.inbound!.stage, InboundStage.connected);
        expect(r.channel.named('reportBound'), ['reportBound:$_pushCallId']);
        app.frame(agentStateFrameJson('wrapup', '2026-11-01T09:03:00.000Z'));
        app.frame(_pushFrame('inbound_call_outcome_owed', call: {'bridged_at': '2026-11-01T09:00:17.000Z'}));
        expect(r.channel.named('reportEnded'), ['reportEnded:$_pushCallId:ended']);
        app.dispose();
      });
    });

    test('nothing hosted (a cold start): a station opens from the accept, and is filled in by a join once the call is done', () {
      fakeAsync((async) {
        final r = _Ring(async);
        final app = r.app;
        app.run(app.controller.resumeForRing(_accept()));
        async.flushMicrotasks();
        expect(app.connector.attempts, 1);
        expect(app.socket.url.queryParameters['token'], 'accept1');
        expect(app.engine.calls, contains('fgs.start'), reason: 'from the foreground');
        expect(app.view!.inbound!.stage, InboundStage.offered);
        expect(app.view!.campaignId, 'camp-1');
        expect(app.requests('POST', '/proxy/agency/sessions'), isEmpty, reason: 'no join while the call is on');

        app.readyFrame('reserved');
        app.frame(_pushFrame('inbound_call_push_accepted'));
        app.frame(agentStateFrameJson('on_call', '2026-11-01T09:00:17.000Z'));
        app.frame(_pushFrame('inbound_call_connected', call: {'bridged_at': '2026-11-01T09:00:17.000Z'}));
        app.frame(agentStateFrameJson('wrapup', '2026-11-01T09:03:00.000Z'));
        app.frame(_pushFrame('inbound_call_outcome_owed', call: {'bridged_at': '2026-11-01T09:00:17.000Z'}));
        expect(app.requests('POST', '/proxy/agency/sessions'), isEmpty);
        app.frame(agentStateFrameJson('available', '2026-11-01T09:04:00.000Z'));
        app.frame(_pushFrame('inbound_call_settled', call: {'bridged_at': '2026-11-01T09:00:17.000Z'}));
        async.flushMicrotasks();
        final join = app.requests('POST', '/proxy/agency/sessions').single;
        expect((join.body! as Map<String, Object?>)['take_over'], isFalse, reason: 'a rehydrate, never a take-over');
        expect(app.view!.dispositions, isNotEmpty, reason: 'the campaign\'s catalog, from the join');
        expect(app.view!.campaignName, 'Renewals');
        expect(app.socket.closed, isFalse, reason: 'the socket is kept');
        app.dispose();
      });
    });
  });

  group('a ring answered while the app is alive (the answer brings it to the front)', () {
    test('answer first: back in the app, the parked socket waits for the accept\'s URL, '
        'and opens on it with no mint of its own', () {
      fakeAsync((async) {
        final r = _Ring(async)..availableThenAway();
        final app = r.app;
        app.controller.holdForRingAnswer(_pushCallId);
        app.lifecycle.show();
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 5));
        expect(app.connector.attempts, 1, reason: 'an attach of its own would answer the ring (N5) ahead of the accept');
        expect(app.mints, 0);
        app.run(app.controller.resumeForRing(_accept()));
        async.flushMicrotasks();
        expect(app.connector.attempts, 2);
        expect(app.socket.url.queryParameters['token'], 'accept1');
        expect(app.mints, 0);
        app.dispose();
      });
    });

    test('a hold nobody ends is bounded: the socket reopens as usual', () {
      fakeAsync((async) {
        final r = _Ring(async)..availableThenAway();
        final app = r.app;
        app.controller.holdForRingAnswer(_pushCallId);
        app.lifecycle.show();
        async.flushMicrotasks();
        expect(app.connector.attempts, 1);
        async.elapse(StationController.ringAnswerHoldMax);
        async.flushMicrotasks();
        expect(app.connector.attempts, 2);
        expect(app.mints, 1);
        app.dispose();
      });
    });

    test('a failed accept releases the hold: the socket reopens as usual', () {
      fakeAsync((async) {
        final r = _Ring(async)..availableThenAway();
        final app = r.app;
        app.controller.holdForRingAnswer(_pushCallId);
        app.lifecycle.show();
        async.flushMicrotasks();
        app.controller.releaseRingAnswer(_pushCallId);
        async.flushMicrotasks();
        expect(app.connector.attempts, 2);
        app.dispose();
      });
    });

    test('back in the app first: its own socket attached (N5); the station holds the call when its frame comes, '
        'and the accept\'s answer keeps that socket', () {
      fakeAsync((async) {
        final r = _Ring(async)..availableThenAway();
        final app = r.app;
        app.lifecycle.show();
        async.flushMicrotasks();
        expect(app.connector.attempts, 2);
        expect(app.mints, 1);
        app.controller.holdForRingAnswer(_pushCallId);
        bool? held;
        app.controller.holdsRingCall(_pushCallId, const Duration(seconds: 5)).then((v) => held = v);
        async.elapse(const Duration(seconds: 1));
        expect(held, isNull, reason: 'not on the station yet');
        app.readyFrame('reserved');
        app.frame(_pushFrame('inbound_call_push_accepted'));
        async.flushMicrotasks();
        expect(held, isTrue);
        app.run(app.controller.resumeForRing(_accept()));
        async.flushMicrotasks();
        expect(app.connector.attempts, 2, reason: 'the server binds on the socket already here');
        app.frame(_pushFrame('inbound_call_connected', call: {'bridged_at': '2026-11-01T09:00:17.000Z'}));
        expect(r.channel.named('reportBound'), ['reportBound:$_pushCallId']);
        app.dispose();
      });
    });

    test('the station never shows the call: holdsRingCall answers false once the window ends', () {
      fakeAsync((async) {
        final r = _Ring(async)..availableThenAway();
        final app = r.app;
        app.lifecycle.show();
        async.flushMicrotasks();
        bool? held;
        app.controller.holdsRingCall(_pushCallId, const Duration(seconds: 5)).then((v) => held = v);
        app.readyFrame('break', extra: {'break_reason': 'away_ring'});
        async.elapse(const Duration(seconds: 5));
        expect(held, isFalse);
        app.dispose();
      });
    });
  });

  group('hung up on the phone while the call connected (after the accept)', () {
    test('the station hangs the call up once it connects', () {
      fakeAsync((async) {
        final r = _Ring(async)..availableThenAway();
        final app = r.app;
        const hangupPath = '/proxy/agency/inbound/calls/$_pushCallId/hangup';
        app.routes['POST $hangupPath'] = (_) => json(200, {
              'call': _pushFrame('inbound_call_outcome_owed', call: {'bridged_at': '2026-11-01T09:00:17.000Z'})['call'],
            });
        app.run(app.controller.resumeForRing(_accept()));
        app.controller.hangUpRingCall(_pushCallId);
        async.flushMicrotasks();
        app.readyFrame('reserved');
        app.frame(_pushFrame('inbound_call_push_accepted'));
        expect(app.requests('POST', hangupPath), isEmpty, reason: 'not before it connects');
        app.frame(agentStateFrameJson('on_call', '2026-11-01T09:00:17.000Z'));
        app.frame(_pushFrame('inbound_call_connected', call: {'bridged_at': '2026-11-01T09:00:17.000Z'}));
        async.flushMicrotasks();
        expect(app.requests('POST', hangupPath), hasLength(1));
        app.frame(_pushFrame('inbound_call_connected', call: {'bridged_at': '2026-11-01T09:00:17.000Z'}));
        async.flushMicrotasks();
        expect(app.requests('POST', hangupPath), hasLength(1), reason: 'once');
        app.dispose();
      });
    });
  });

  group('the offer backstop and a push offer', () {
    test('the rule: a push offer is stale only past the accept grace; never before accept', () {
      final station = inboundCall('inbound_call_offered');
      expect(inboundOfferStaleAt(station, StationController.offerStaleAfter), station.connectsAt!.add(const Duration(seconds: 10)));
      final push = InboundCall.fromJson(_pushFrame('inbound_call_push_accepted')['call']! as Map<String, Object?>);
      expect(push.connectsAt, isNull);
      expect(inboundOfferStaleAt(push, StationController.offerStaleAfter), DateTime.utc(2026, 11, 1, 9, 0, 41));
      final unanswered = InboundCall.fromJson(
        _pushFrame('inbound_call_push_accepted', call: {'accepted_at': null})['call']! as Map<String, Object?>,
      );
      expect(inboundOfferStaleAt(unanswered, StationController.offerStaleAfter), isNull);
    });

    test('an accepted push offer is kept through the grace (a slow cold start), then retired if nothing settles it', () {
      fakeAsync((async) {
        final r = _Ring(async);
        final app = r.app;
        app.run(app.controller.resumeForRing(_accept()));
        app.readyFrame('reserved');
        app.frame(_pushFrame('inbound_call_push_accepted'));
        // Accepted at 09:00:16: stale at 09:00:41 (the grace, then the backstop's 10 s).
        async.elapse(const Duration(seconds: 40));
        expect(app.view!.inbound?.stage, InboundStage.offered, reason: '15 s grace + 10 s: not yet');
        async.elapse(const Duration(seconds: 2));
        expect(app.view!.inbound, isNull);
        expect(r.channel.named('reportEnded'), ['reportEnded:$_pushCallId:cancelled']);
        app.dispose();
      });
    });
  });
}
