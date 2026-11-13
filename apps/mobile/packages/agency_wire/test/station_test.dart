import 'dart:convert';
import 'dart:typed_data';

import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

T decodeAs<T extends StationFrame>(String text) {
  final frame = StationFrame.decode(text);
  expect(frame, isA<T>(), reason: frame is UnknownFrame ? frame.reason : null);
  return frame as T;
}

T sample<T extends StationFrame>(String name) => decodeAs<T>(fixtureText('station.json', name));

void main() {
  group('StationFrame.decode: server frames', () {
    test('ready on a first join carries only the state', () {
      final f = sample<ReadyFrame>('ready_first_join');
      expect(f.sessionId, '6c1f0d3e-8a4b-4f7e-9d21-3b5a7c9e0f12');
      expect(f.state, AgentState.offline);
      expect(f.activeAttempt, isNull);
      expect(f.activeWrapup, isNull);
      expect(f.missedRelease, isNull);
      expect(f.pendingState, isNull);
      expect(f.breakReason, isNull);
      expect(f.event, StationEvent.ready);
    });

    test('ready onto a break names it: device_away after the app was killed while paused', () {
      final f = sample<ReadyFrame>('ready_device_away');
      expect(f.state, AgentState.onBreak);
      expect(f.breakReason, 'device_away');
      expect(ReservedBreakCode.tryFromWire(f.breakReason), ReservedBreakCode.deviceAway);
      expect(f.pendingState, isNull);
      // An older server sends no reason: still a plain break.
      final old = decodeAs<ReadyFrame>('{"event":"ready","session_id":"s","state":"break"}');
      expect(old.breakReason, isNull);
      expect(old, isNot(f));
    });

    test('back from away_ring: agent_state keeps the absence start, ready stays on the same break', () {
      final s = sample<AgentStateFrame>('agent_state_after_away_ring_return');
      expect(s.state, AgentState.onBreak);
      expect(s.breakReason, 'device_away');
      expect(s.since, DateTime.utc(2026, 11, 2, 7, 58, 41, 120));
      final r = sample<ReadyFrame>('ready_after_away_ring_return');
      expect(r.state, AgentState.onBreak);
      expect(r.breakReason, 'device_away');
    });

    test('ready on a reconnect onto a live call restores the panel and the queued break', () {
      final f = sample<ReadyFrame>('ready_reconnect_live');
      final a = f.activeAttempt!;
      expect(f.state, AgentState.onCall);
      expect(a.isLive, isTrue);
      expect(a.bridgedAt, DateTime.utc(2026, 11, 1, 6, 31, 8, 512));
      expect(a.bridgedAt!.isUtc, isTrue);
      expect(a.state, AttemptState.bridged);
      expect(a.attemptNumber, 2);
      expect(a.context['Premium (INR)'], 18450);
      expect(a.priorAttempts.single.outcome, AttemptOutcome.noAnswer);
      expect(f.pendingState, AgentState.onBreak);
      expect(f.pendingStateRaw, 'break');
      expect(f.pendingBreakReason, 'lunch');
    });

    test('ready mid-wrap-up carries the absolute deadline', () {
      final w = sample<ReadyFrame>('ready_reconnect_wrapup').activeWrapup!;
      expect(w.endsAt, DateTime.utc(2026, 11, 1, 6, 36, 40));
      expect(w.secondsTotal, 45);
      expect(w.heldReason, isNull);
      expect(w.requiresDisposition, isTrue);
    });

    test('ready after a drop explains the missed release', () {
      final m = sample<ReadyFrame>('ready_missed_release').missedRelease!;
      expect(m.reason, ReleaseReason.agentDisconnected);
      expect(m.requiresDisposition, isTrue);
      expect(m.endedAt, DateTime.utc(2026, 11, 1, 6, 33, 2, 877));
    });

    test('reserved keeps the CSV columns in order, untouched, and prior attempts newest first', () {
      final a = sample<ReservedFrame>('reserved').attempt;
      expect(a, isNot(isA<ActiveAttempt>()));
      expect(a.phoneE164, '+918765432109');
      expect(a.context.keys.toList(), [
        'Name',
        'Policy No',
        'Renewal Due',
        'Premium (INR)',
        'Notes from branch',
        'Opted in',
        'Alt phone',
      ]);
      expect(a.context['Notes from branch'], 'Prefers Marathi. <b>not markup</b>');
      expect(a.context['Opted in'], isTrue);
      expect(a.context['Alt phone'], isNull);
      expect(() => a.context['x'] = 1, throwsUnsupportedError);
      expect(a.priorAttempts, hasLength(2));
      expect(a.priorAttempts[0].dispositionCode, 'callback');
      expect(a.priorAttempts[1].outcome, isNull);
      expect(a.priorAttempts[1].dialedAt, isNull);
      expect(a.priorAttempts[1].campaignName, 'Q3 Winback');
    });

    test('a wrap-up redial names the call it redials and how many are left', () {
      final a = sample<ReservedFrame>('reserved_redial').attempt;
      expect(a.redial, const RedialInfo(ofAttemptId: 'b8f4d3c2-6e5a-4f7b-9c0d-1e2f3a4b5c6d', number: 1, remaining: 1));
      expect(a.redial!.limit, 2);
      // A call the pacing engine placed carries none.
      expect(sample<ReservedFrame>('reserved').attempt.redial, isNull);
    });

    test('a redial that does not read never costs the call', () {
      final json = fixture('station.json', 'reserved_redial');
      final attempt = {
        ...json['attempt']! as Map<String, Object?>,
        'redial': {'number': 'one'},
      };
      final f = decodeAs<ReservedFrame>(jsonEncode({...json, 'attempt': attempt}));
      expect(f.attempt.attemptId, '6b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8');
      expect(f.attempt.redial, isNull);
    });

    test('ready onto a live redial restores it with the active attempt', () {
      final json = fixture('station.json', 'ready_reconnect_live');
      final redial = (fixture('station.json', 'reserved_redial')['attempt']! as Map<String, Object?>)['redial'];
      final active = {...json['active_attempt']! as Map<String, Object?>, 'redial': redial};
      final f = decodeAs<ReadyFrame>(jsonEncode({...json, 'active_attempt': active}));
      expect(f.activeAttempt!.redial?.number, 1);
      expect(f.activeAttempt!.redial?.remaining, 1);
      expect(sample<ReadyFrame>('ready_reconnect_live').activeAttempt!.redial, isNull);
    });

    test('wrap-up redial: offered with a count, used up at zero, absent when not offered', () {
      expect(sample<WrapupFrame>('wrapup_redial_offered').wrapup.redialRemaining, 2);
      final used = sample<WrapupFrame>('wrapup_redial_used_up').wrapup;
      expect(used.redialRemaining, 0);
      expect(used.heldReason, WrapupHoldReason.dispositionRequired);
      expect(sample<WrapupFrame>('wrapup_timed').wrapup.redialRemaining, isNull);
      final json = fixture('station.json', 'wrapup_redial_offered');
      final nulled = {...json['wrapup']! as Map<String, Object?>, 'redial_remaining': null};
      expect(decodeAs<WrapupFrame>(jsonEncode({...json, 'wrapup': nulled})).wrapup.redialRemaining, isNull);
      // Unreadable reads as not offered, and the wrap-up itself still lands.
      final bad = {...json['wrapup']! as Map<String, Object?>, 'redial_remaining': 'two'};
      expect(decodeAs<WrapupFrame>(jsonEncode({...json, 'wrapup': bad})).wrapup.redialRemaining, isNull);
      expect(
        sample<WrapupFrame>('wrapup_redial_offered').wrapup,
        isNot(WrapupState.fromJson({...json['wrapup']! as Map<String, Object?>, 'redial_remaining': 1})),
      );
    });

    test('ready mid-wrap-up carries the redial count', () {
      final json = fixture('station.json', 'ready_reconnect_wrapup');
      final wrapup = {...json['active_wrapup']! as Map<String, Object?>, 'redial_remaining': 1};
      expect(decodeAs<ReadyFrame>(jsonEncode({...json, 'active_wrapup': wrapup})).activeWrapup!.redialRemaining, 1);
    });

    test('countdown, bridged, released', () {
      expect(sample<CountdownFrame>('countdown').secondsRemaining, 2);
      expect(sample<BridgedFrame>('bridged').bridgedAt, DateTime.utc(2026, 11, 1, 6, 41, 15, 250));
      final r = sample<ReleasedFrame>('released_completed');
      expect(r.reason, ReleaseReason.remoteHangup);
      expect(r.requiresDisposition, isTrue);
      expect(sample<ReleasedFrame>('released_no_answer').requiresDisposition, isFalse);
    });

    test('a timerless held wrap-up has no deadline and says why', () {
      final w = sample<WrapupFrame>('wrapup_held_timerless').wrapup;
      expect(w.endsAt, isNull);
      expect(w.secondsTotal, 0);
      expect(w.heldReason, WrapupHoldReason.dispositionRequired);
    });

    test('agent_state: plain, on break, and with a queued break', () {
      expect(sample<AgentStateFrame>('agent_state_available').state, AgentState.available);
      final b = sample<AgentStateFrame>('agent_state_break');
      expect(b.state, AgentState.onBreak);
      expect(b.breakReason, 'lunch');
      final q = sample<AgentStateFrame>('agent_state_break_queued');
      expect(q.state, AgentState.onCall);
      expect(q.pendingState, AgentState.onBreak);
      expect(q.pendingBreakReason, 'tea');
    });

    test('campaign_state drains the idle screen', () {
      final f = sample<CampaignStateFrame>('campaign_state_exhausted');
      expect(f.status, CampaignStatus.completed);
      expect(f.reason, CampaignChangeReason.listExhausted);
      expect(f.dialing, isFalse);
    });

    test('pong with and without the echoed ts', () {
      expect(sample<PongFrame>('pong'), const PongFrame(ts: 1793428800123, serverTs: 1793428800171));
      expect(sample<PongFrame>('pong_without_ts').ts, isNull);
      // A fractional ts (another client's clock) still reads, truncated.
      expect(decodeAs<PongFrame>('{"event":"pong","ts":12.7,"server_ts":20}').ts, 12);
    });

    test('error, bridge status and bridge ended', () {
      final e = sample<StationErrorFrame>('error');
      expect(e.code, StationErrorCode.invalidFrame);
      expect(sample<BridgeStatusFrame>('bridge_status').status, BridgeStatus.inProgress);
      expect(sample<BridgeEndedFrame>('bridge_ended').reason, 'remote_hangup');
    });

    test('manual_call is kept whole and typed only where a station needs it', () {
      final f = sample<ManualCallFrame>('manual_call');
      expect(f.id, '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d');
      expect(f.state, AttemptState.ringing);
      expect(f.bridgedAt, isNull);
      expect(f.requiresDisposition, isFalse);
      expect((f.call['tag']! as Map<String, Object?>)['campaign_name'], 'Q4 Renewals — Pune');
      // Lenient: a partial row still decodes.
      final partial = decodeAs<ManualCallFrame>('{"event":"manual_call","call":{"state":"bridged"}}');
      expect(partial.id, isNull);
      expect(partial.state, AttemptState.bridged);
    });

    test('manual_call is decoded once into a typed ManualCall', () {
      final f = sample<ManualCallFrame>('manual_call');
      final call = f.manualCall!;
      expect(call.id, f.id);
      expect(call.state, AttemptState.ringing);
      expect(
        call.tag,
        const ManualCallTag(campaignId: 'c0ffee00-1111-4222-8333-444455556666', campaignName: 'Q4 Renewals — Pune'),
      );
      expect(call.isLive, isTrue);
      expect(call.isUnsettled, isTrue);
      expect(call.canCancelRinging, isTrue, reason: 'its carrier cancels a ringing call (SP3)');
      expect(identical(f.manualCall, f.manualCall), isTrue, reason: 'decoded at construction, not per read');

      final owed = sample<ManualCallFrame>('manual_call_owed').manualCall!;
      expect(owed.state, AttemptState.ended);
      expect(owed.owesOutcome, isTrue);
      expect(owed.isLive, isFalse);
      expect(owed.outcomeDueAt, DateTime.utc(2026, 11, 1, 9, 14, 20));
      expect(owed.endReason, ManualCallEndReason.remoteHangup);
    });

    test('a manual_call row that does not read stays a ManualCallFrame with a null manualCall', () {
      // A partial row, a mistyped field and a call that is not an object: never an
      // UnknownFrame, so the station keeps reading frames and ignores this one.
      for (final text in [
        '{"event":"manual_call","call":{"state":"bridged"}}',
        jsonEncode({
          'event': 'manual_call',
          'call': {...fixture('station.json', 'manual_call')['call']! as Map<String, Object?>, 'updated_at': 42},
        }),
        jsonEncode({
          'event': 'manual_call',
          'call': {...fixture('station.json', 'manual_call')['call']! as Map<String, Object?>, 'tag': 'oops'},
        }),
      ]) {
        final f = decodeAs<ManualCallFrame>(text);
        expect(f.manualCall, isNull, reason: text);
      }
      // A call that is not an object at all is still unreadable as a frame.
      expect(StationFrame.decode('{"event":"manual_call","call":7}'), isA<UnknownFrame>());
    });

    test('a manual_call with an unknown state or a new key still decodes, as unknown', () {
      final row = {...fixture('station.json', 'manual_call')['call']! as Map<String, Object?>};
      row['state'] = 'transferring';
      row['brand_new_field'] = true;
      final call = decodeAs<ManualCallFrame>(jsonEncode({'event': 'manual_call', 'call': row})).manualCall!;
      expect(call.state, AttemptState.unknown);
      expect(call.stateRaw, 'transferring');
    });

    test('value equality across separate decodes', () {
      final text = fixtureText('station.json', 'ready_reconnect_live');
      final a = StationFrame.decode(text);
      final b = StationFrame.decode(text);
      expect(identical(a, b), isFalse);
      expect(a, b);
      expect(a.hashCode, b.hashCode);
      expect(
        StationFrame.decode(fixtureText('station.json', 'reserved')),
        StationFrame.decode(fixtureText('station.json', 'reserved')),
      );
    });

    group('queue (contact assignment)', () {
      test('nothing due: the reason and when the next contact falls due', () {
        final f = sample<QueueFrame>('queue_nothing_due');
        expect(f.event, StationEvent.queue);
        expect(f.campaignId, '8c0f5b1e-3f7a-4d2b-9c61-2a4e5f6b7c8d');
        expect(f.queue.due, isFalse);
        expect(f.queue.reason, QueueIdleReason.callbacksLater);
        expect(f.queue.nextDueAt, DateTime.utc(2026, 11, 4, 10, 30));
        expect(f.queue.nextDueAt!.isUtc, isTrue);
      });

      test('due: no reason, no next time', () {
        final f = sample<QueueFrame>('queue_due');
        expect(f.queue, QueueState(due: true));
        expect(f.queue.reason, isNull);
        expect(f, isNot(sample<QueueFrame>('queue_nothing_due')));
      });

      test('the state round-trips through toJson', () {
        final json = fixture('station.json', 'queue_nothing_due');
        final f = sample<QueueFrame>('queue_nothing_due');
        expect(f.queue.toJson(), {
          for (final k in ['due', 'reason', 'next_due_at']) k: json[k],
        });
        expect(QueueState.fromJson(f.queue.toJson()), f.queue);
      });

      test('a reason this build does not know is kept, still "nothing due"', () {
        final f = decodeAs<QueueFrame>(
          '{"event":"queue","campaign_id":"c","due":false,"reason":"supervisor_hold","next_due_at":null}',
        );
        expect(f.queue.due, isFalse);
        expect(f.queue.reason, QueueIdleReason.unknown);
        expect(f.queue.reasonRaw, 'supervisor_hold');
      });

      test('a queue frame missing `due` is an UnknownFrame, never a throw', () {
        final f = StationFrame.decode('{"event":"queue","campaign_id":"c","reason":null}');
        expect(f, isA<UnknownFrame>());
        expect(f.event, StationEvent.queue);
      });

      test('ready carries the queue on a strict or preferred campaign, and nothing otherwise', () {
        final json = fixture('station.json', 'ready_first_join');
        expect(sample<ReadyFrame>('ready_first_join').queue, isNull);
        final withQueue = decodeAs<ReadyFrame>(
          jsonEncode({
            ...json,
            'queue': {'due': false, 'reason': 'outside_calling_hours', 'next_due_at': '2026-11-04T03:30:00.000Z'},
          }),
        );
        expect(withQueue.queue!.reason, QueueIdleReason.outsideCallingHours);
        expect(withQueue.queue!.nextDueAt, DateTime.utc(2026, 11, 4, 3, 30));
        expect(withQueue, isNot(sample<ReadyFrame>('ready_first_join')));
      });
    });
  });

  group('StationFrame.decode: tolerance (never throws)', () {
    test('an unknown event is an UnknownFrame that keeps the event', () {
      final f = decodeAs<UnknownFrame>('{"event":"coach_whisper","text":"hi"}');
      expect(f.eventRaw, 'coach_whisper');
      expect(f.event, StationEvent.unknown);
      expect(f.reason, 'unknown event');
    });

    for (final (name, text) in <(String, String)>[
      ('not JSON', 'pong'),
      ('truncated JSON', '{"event":"pong","server_ts":1'),
      ('empty text', ''),
      ('a JSON array', '[1,2,3]'),
      ('a JSON string', '"ready"'),
      ('no event', '{"state":"available"}'),
      ('a non-string event', '{"event":7}'),
      ('a missing required field', '{"event":"agent_state","state":"available"}'),
      ('a mistyped field', '{"event":"countdown","attempt_id":"a","seconds_remaining":"3"}'),
      ('a fractional count', '{"event":"countdown","attempt_id":"a","seconds_remaining":2.5}'),
      ('a bad timestamp', '{"event":"bridged","attempt_id":"a","bridged_at":"yesterday"}'),
      ('a nested object of the wrong type', '{"event":"reserved","attempt":[]}'),
      ('a list of the wrong element type', '{"event":"wrapup","wrapup":{"attempt_id":1}}'),
      ('media without a payload', '{"event":"media","media":{}}'),
    ]) {
      test('$name → UnknownFrame', () {
        final f = StationFrame.decode(text);
        expect(f, isA<UnknownFrame>());
        expect((f as UnknownFrame).raw, text);
        expect(f.reason, isNotEmpty);
      });
    }

    test('an unknown literal decodes to `unknown` and keeps the raw string', () {
      final f = decodeAs<AgentStateFrame>('{"event":"agent_state","state":"coaching","since":"2026-11-01T00:00:00Z"}');
      expect(f.state, AgentState.unknown);
      expect(f.state.isUnknown, isTrue);
      expect(f.stateRaw, 'coaching');

      final r = decodeAs<ReleasedFrame>(
        '{"event":"released","attempt_id":"a","reason":"carrier_blocked","requires_disposition":false,"message":"Blocked by the carrier."}',
      );
      expect(r.reason, ReleaseReason.unknown);
      expect(r.reasonRaw, 'carrier_blocked');
      expect(r.message, 'Blocked by the carrier.');

      final c = decodeAs<CampaignStateFrame>(
        '{"event":"campaign_state","campaign_id":"c","status":"archived","reason":"budget_spent","dialing":false,"message":"m"}',
      );
      expect(
        (c.status, c.statusRaw, c.reason, c.reasonRaw),
        (CampaignStatus.unknown, 'archived', CampaignChangeReason.unknown, 'budget_spent'),
      );

      final s = decodeAs<BridgeStatusFrame>('{"event":"status","status":"transferring"}');
      expect(s.statusRaw, 'transferring');

      final w = decodeAs<WrapupFrame>(
        '{"event":"wrapup","wrapup":{"attempt_id":"a","ends_at":null,"seconds_total":0,"auto_return":false,'
        '"requires_disposition":true,"disposition_submitted":false,"held_reason":"qa_review"}}',
      );
      expect(w.wrapup.heldReason, WrapupHoldReason.unknown);
      expect(w.wrapup.heldReasonRaw, 'qa_review');
    });

    test('fields the build does not know are ignored', () {
      final f = decodeAs<PongFrame>('{"event":"pong","server_ts":5,"region":"ap-south-1"}');
      expect(f.serverTs, 5);
    });
  });

  group('media', () {
    const payload = 'AAABAAIAAwAEAAUABgAHAAgACQAKAAsADAANAA4ADwAQABEAEgATABQAFQAWABcAGAAZABoAGwAcAB0AHgAfAA==';

    test('the server serialisation takes the fast path and matches the JSON path', () {
      final text = fixtureText('station.json', 'media');
      expect(text, '{"event":"media","media":{"payload":"$payload"}}');
      final fast = decodeAs<MediaFrame>(text);
      final general = MediaFrame.fromJson(jsonDecode(text) as Map<String, Object?>);
      expect(fast, general);
      expect(fast.decodePayload(), hasLength(64));
    });

    test('any other spelling of a media frame still decodes, through JSON', () {
      expect(decodeAs<MediaFrame>('{ "event": "media", "media": { "payload": "$payload" } }').payload, payload);
      expect(decodeAs<MediaFrame>('{"media":{"payload":"$payload"},"event":"media"}').payload, payload);
      // An escaped character defeats the slice; the JSON path unescapes it.
      expect(decodeAs<MediaFrame>(r'{"event":"media","media":{"payload":"AB\/C"}}').payload, 'AB/C');
      // A frame that only looks like media at both ends is not taken by the slice.
      expect(
        StationFrame.decode('{"event":"media","media":{"payload":"AA"}, "x":{"y":"z"}}'),
        isA<MediaFrame>().having((f) => f.payload, 'payload', 'AA'),
      );
      expect(StationFrame.decode('{"event":"media","media":{"payload":"}}'), isA<UnknownFrame>());
    });

    test('binary frames never touch JSON and are not copied', () {
      final bytes = Uint8List(160)..[0] = 0xd5;
      final f = StationFrame.decodeBinary(bytes);
      expect(identical(f.bytes, bytes), isTrue);
      expect(f.event, StationEvent.media);
      expect(StationFrame.decodeBinary(<int>[1, 2, 3]).bytes, Uint8List.fromList([1, 2, 3]));
    });

    test('media formats carry their frame sizes', () {
      expect(MediaFormat.fromWire('alaw8').bytesPerFrame, 160);
      expect(MediaFormat.fromWire('pcm16').bytesPerFrame, 640);
      expect(MediaFormat.fromWire('opus'), MediaFormat.unknown);
    });
  });

  group('client frames', () {
    test('ping encodes to the fixture and round-trips', () {
      const ping = PingFrame(ts: 1793428800123);
      expect(jsonDecode(ping.encode()), fixture('station-client.json', 'ping'));
      expect(ping.toJson(), fixture('station-client.json', 'ping'));
      expect(StationClientFrame.decode(ping.encode()), ping);
      expect(PingFrame.encodeTs(1793428800123), ping.encode());
    });

    test('ping without a ts', () {
      const ping = PingFrame();
      expect(ping.encode(), '{"event":"ping"}');
      expect(jsonDecode(ping.encode()), fixture('station-client.json', 'ping_without_ts'));
      expect(StationClientFrame.decode(ping.encode()), ping);
    });

    test('media encodes to the fixture, round-trips, and matches the server shape', () {
      final fx = fixture('station-client.json', 'media');
      final payload = (fx['media']! as Map<String, Object?>)['payload']! as String;
      final frame = MediaClientFrame(payload);
      expect(jsonDecode(frame.encode()), fx);
      expect(frame.toJson(), fx);
      expect(StationClientFrame.decode(frame.encode()), frame);
      // The same text the server would send back decodes as a server media frame.
      expect(StationFrame.decode(frame.encode()), MediaFrame(payload));
    });

    test('media from raw PCM bytes', () {
      final pcm = Uint8List.fromList(List<int>.generate(640, (i) => i & 0xff));
      final text = MediaClientFrame.encodePcm(pcm);
      final back = StationClientFrame.decode(text)! as MediaClientFrame;
      expect(base64.decode(back.payload), pcm);
    });

    test('anything else is not a client frame', () {
      expect(StationClientFrame.decode('{"event":"hangup","attempt_id":"a"}'), isNull);
      expect(StationClientFrame.decode('nope'), isNull);
    });
  });

  group('close codes', () {
    test('map to what the client must do', () {
      expect(StationCloseCode.fromCode(4401), StationCloseCode.tokenRejected);
      expect(StationCloseCode.fromCode(4404)!.isTerminal, isTrue);
      expect(StationCloseCode.fromCode(4408)!.isTerminal, isFalse);
      expect(StationCloseCode.fromCode(4409)!.isTerminal, isTrue);
      expect(StationCloseCode.tokenRejected.isTerminal, isFalse);
      // A refused upgrade: the same upgrade is refused again, so stop.
      expect(StationCloseCode.fromCode(1008), StationCloseCode.invalidUpgrade);
      expect(StationCloseCode.invalidUpgrade.isTerminal, isTrue);
      expect(StationCloseCode.invalidUpgrade.boundsRetries, isFalse);
      // An internal error: retry, but not forever.
      expect(StationCloseCode.fromCode(1011), StationCloseCode.internalError);
      expect(StationCloseCode.internalError.isTerminal, isFalse);
      expect(StationCloseCode.internalError.boundsRetries, isTrue);
      for (final c in [StationCloseCode.tokenRejected, StationCloseCode.heartbeatTimeout]) {
        expect(c.boundsRetries, isFalse, reason: '$c');
      }
      // Unknown or absent: an ordinary drop.
      expect(StationCloseCode.fromCode(1006), isNull);
      expect(StationCloseCode.fromCode(1000), isNull);
      expect(StationCloseCode.fromCode(null), isNull);
    });

    test('every code decodes back to itself', () {
      for (final c in StationCloseCode.values) {
        expect(StationCloseCode.fromCode(c.code), c);
      }
    });
  });
}
