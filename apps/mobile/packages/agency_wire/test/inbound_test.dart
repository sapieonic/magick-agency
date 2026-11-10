// Inbound calls' wire types beyond "the fixtures decode" (fixtures_test.dart):
// frame dispatch and its tolerance, the call's predicates through its states,
// unknown-literal fallbacks, the request bodies the app sends, the Missed
// query, the refusal accessors and the station's `caps=` value.

import 'dart:convert';

import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

Map<String, Object?> st(String name) => fixture('station.json', name);
Map<String, Object?> ib(String name) => fixture('inbound.json', name);

/// A station sample decoded through the socket path.
StationFrame frameOf(String name) => StationFrame.decode(jsonEncode(st(name)));

/// [name]'s call with [patch] applied.
Map<String, Object?> callWith(String name, Map<String, Object?> patch) => {
  ...(st(name)['call']! as Map<String, Object?>),
  ...patch,
};

void main() {
  group('StationFrame.decode: inbound frames', () {
    test('inbound_call dispatches to InboundCallFrame with the call decoded', () {
      final frame = frameOf('inbound_call_offered');
      expect(frame, isA<InboundCallFrame>());
      expect(frame.event, StationEvent.inboundCall);
      final f = frame as InboundCallFrame;
      expect(f.id, '3a9e1c7b-2f4d-4b8a-9c6e-5d7f0a1b2c3d');
      expect(f.sessionId, '6c1f0d3e-8a4b-4f7e-9d21-3b5a7c9e0f12');
      expect(f.state, InboundCallState.offered);
      final call = f.inboundCall!;
      expect(call.connectsAt, DateTime.utc(2026, 11, 2, 5, 30, 15, 700));
      expect(call.connectsAt!.difference(call.offeredAt), inboundConnectDelay);
      expect(call.sticky!.reason, InboundStickyReason.owner);
      expect(call.sticky!.isYou, isTrue);
      expect(call.match!.campaignName, 'Q4 Renewals — Pune');
      expect(call.match!.contactState, ContactState.pending);
      expect(call.match!.priorAttempts.map((p) => p.outcome), [AttemptOutcome.connected, AttemptOutcome.noAnswer]);
      expect(call.match!.contextDisplay.resolve(call.match!.context).hero.map((e) => e.key), [
        'Name',
        'Policy No',
        'Renewal Due',
      ]);
      expect(call.catalogSource, InboundCatalogSource.campaign);
      expect(
        call.route,
        const InboundCallRoute(id: '8b2d4f6a-1c3e-4a5b-9d7f-0e2a4c6b8d10', name: 'Pune customer line'),
      );
      expect(call.recording, isTrue);
      expect(call.waitedSeconds, 14);
    });

    test('customer_waiting dispatches to CustomerWaitingFrame, announced then cleared', () {
      final waiting = frameOf('customer_waiting');
      expect(waiting, isA<CustomerWaitingFrame>());
      expect(waiting.event, StationEvent.customerWaiting);
      final w = waiting as CustomerWaitingFrame;
      expect(w.inboundCallId, '3a9e1c7b-2f4d-4b8a-9c6e-5d7f0a1b2c3d');
      expect(w.fromE164, '+918765432109');
      expect(w.matchName, 'Rahul Deshpande');
      expect(w.waitingSince, DateTime.utc(2026, 11, 2, 5, 30, 0, 180));
      expect(w.cleared, isFalse);
      final cleared = frameOf('customer_waiting_cleared') as CustomerWaitingFrame;
      expect(cleared.cleared, isTrue);
      expect(cleared.inboundCallId, w.inboundCallId);
    });

    test('a withheld wait carries no number and no name', () {
      final f = StationFrame.decode(
        jsonEncode({
          'event': 'customer_waiting',
          'inbound_call_id': 'x',
          'from_e164': null,
          'waiting_since': '2026-11-02T05:30:00Z',
        }),
      );
      expect(f, CustomerWaitingFrame(inboundCallId: 'x', waitingSince: DateTime.utc(2026, 11, 2, 5, 30)));
      f as CustomerWaitingFrame;
      expect([f.fromE164, f.matchName, f.cleared], [null, null, false]);
    });

    test('an unreadable call is a frame with a null call, never an UnknownFrame', () {
      final f = StationFrame.decode(
        jsonEncode({
          'event': 'inbound_call',
          'call': {'id': 'c-1', 'session_id': 's-1', 'state': 'offered'},
        }),
      );
      expect(f, isA<InboundCallFrame>());
      f as InboundCallFrame;
      expect(f.inboundCall, isNull);
      expect(f.id, 'c-1');
      expect(f.state, InboundCallState.offered);
    });

    test('a frame with no call object, or a malformed wait, is an UnknownFrame', () {
      final noCall = StationFrame.decode('{"event":"inbound_call"}');
      expect(noCall, isA<UnknownFrame>());
      expect(noCall.event, StationEvent.inboundCall);
      final badWait = StationFrame.decode('{"event":"customer_waiting","inbound_call_id":"x"}');
      expect(badWait, isA<UnknownFrame>());
      expect(badWait.event, StationEvent.customerWaiting);
    });

    test('frames have value equality and survive a re-decode', () {
      expect(frameOf('inbound_call_settled'), frameOf('inbound_call_settled'));
      expect(frameOf('inbound_call_offered'), isNot(frameOf('inbound_call_connected')));
      expect(frameOf('customer_waiting'), isNot(frameOf('customer_waiting_cleared')));
    });
  });

  group('InboundCall through its states', () {
    InboundCall call(String sample) => (frameOf(sample) as InboundCallFrame).inboundCall!;

    test('offered: live, unsettled, audio not bound yet', () {
      final c = call('inbound_call_offered');
      expect([c.isLive, c.isUnsettled, c.owesOutcome, c.isSettled], [true, true, false, false]);
      expect(c.bridgedAt, isNull);
      expect(c.outcome, isNull);
    });

    test('connected: bridged, no connects_at', () {
      final c = call('inbound_call_connected');
      expect(c.state, InboundCallState.connected);
      expect(c.connectsAt, isNull);
      expect(c.bridgedAt, DateTime.utc(2026, 11, 2, 5, 30, 15, 712));
      expect([c.isLive, c.isUnsettled, c.owesOutcome], [true, true, false]);
    });

    // How long the outcome waits is the server's (the matched campaign's wrap-up window, an
    // unmatched call's own default, at most the 30-minute backstop): the app reads
    // `outcome_due_at` and never works it out.
    test('ended owing an outcome: due when outcome_due_at says', () {
      final c = call('inbound_call_outcome_owed');
      expect(c.state, InboundCallState.ended);
      expect(c.outcome, InboundCallOutcome.answered);
      expect([c.isLive, c.isUnsettled, c.owesOutcome], [false, true, true]);
      expect(c.outcomeDueAt, DateTime.utc(2026, 11, 2, 6, 4, 2, 500));
      expect(c.outcomeDueAt!.isAfter(c.endedAt!), isTrue);
      expect(c.talkSeconds, 227);
      expect(c.notes, 'Wants the renewal quote by email.');
    });

    test('settled: the outcome, the callback and who saved it', () {
      final c = call('inbound_call_settled');
      expect([c.isLive, c.isUnsettled, c.owesOutcome, c.isSettled], [false, false, false, true]);
      expect(c.outcomeDueAt, isNull);
      expect(c.dispositionCode, 'callback');
      expect(c.disposition('callback')!.datetimeRequired, isTrue);
      expect(c.disposition('nope'), isNull);
      expect(c.callbackAt, DateTime.utc(2026, 11, 5, 9, 30));
      expect(c.dispositionedByUserId, 'u-7b1e5c4a-2d3f-4e6a-9b8c-7d6e5f4a3b2c');
      expect(c.dispositionedOnBehalf, isFalse);
    });

    test('a withheld caller: no number, no match, the built-in catalog', () {
      final c = call('inbound_call_withheld');
      expect(c.isWithheld, isTrue);
      expect(c.fromE164, isNull);
      expect(c.match, isNull);
      expect(c.sticky, isNull);
      expect(c.catalogSource, InboundCatalogSource.builtin);
      expect(c.dispositionCatalog.map((d) => d.code), [
        Disposition.voicemail,
        Disposition.callback,
        Disposition.doNotCall,
      ]);
      expect(call('inbound_call_offered').isWithheld, isFalse);
    });

    test('the call routes answer the same call the frames carry', () {
      final hangup = InboundCallResponse.fromJson(ib('call_hangup_response'));
      expect(hangup.call, call('inbound_call_outcome_owed'));
      final saved = InboundCallDispositionResponse.fromJson(ib('call_disposition_response'));
      expect(saved.call, call('inbound_call_settled'));
      expect(saved.contactState, ContactState.pending);
      expect(saved.callbackRequestedAt, DateTime.utc(2026, 11, 5, 9, 30));
      final dnc = InboundCallDncResponse.fromJson(ib('call_dnc_response'));
      expect(dnc.scope, DncEntryScope.campaign);
      expect(dnc.contactState, ContactState.suppressed);
      expect(dnc.dncRecorded, isTrue);
    });
  });

  group('unknown literals fall back, keeping the raw string', () {
    test('a call with a state, outcome, catalog source and sticky reason this build does not know', () {
      final c = InboundCall.fromJson(
        callWith('inbound_call_settled', {
          'state': 'transferred',
          'outcome': 'transferred_out',
          'catalog_source': 'team',
          'sticky': {'reason': 'last_texted', 'is_you': false},
        }),
      );
      expect(c.state, InboundCallState.unknown);
      expect(c.stateRaw, 'transferred');
      expect(c.outcome, InboundCallOutcome.unknown);
      expect(c.outcomeRaw, 'transferred_out');
      expect(c.catalogSource, InboundCatalogSource.unknown);
      expect(c.catalogSourceRaw, 'team');
      expect(c.sticky!.reason, InboundStickyReason.unknown);
      expect(c.sticky!.reasonRaw, 'last_texted');
    });

    test('a Missed row with a new reason, cause, status and handled reason', () {
      final row = {
        ...((ib('missed_page')['rows']! as List<Object?>).first! as Map<String, Object?>),
        'reason': 'spam',
        'closed_cause': 'maintenance',
        'outcome': 'screened',
        'status': 'snoozed',
        'handled_reason': 'auto',
      };
      final m = InboundMissedCall.fromJson(row);
      expect(m.reason, InboundMissedReason.unknown);
      expect(m.reasonRaw, 'spam');
      expect(m.closedCause, InboundClosedCause.unknown);
      expect(m.closedCauseRaw, 'maintenance');
      expect(m.outcome, InboundCallOutcome.unknown);
      expect(m.status, InboundFollowUpStatus.unknown);
      expect(m.statusRaw, 'snoozed');
      expect(m.isOpen, isFalse);
      expect(m.handledReason, InboundHandledReason.unknown);
      expect(m.handledReasonRaw, 'auto');
    });

    test('every inbound enum decodes null and a stranger to unknown', () {
      final decoders = <WireEnum Function(String?)>[
        InboundCallState.fromWire,
        InboundCallOutcome.fromWire,
        InboundStickyReason.fromWire,
        InboundCatalogSource.fromWire,
        InboundMissedReason.fromWire,
        InboundFollowUpStatus.fromWire,
        InboundHandledReason.fromWire,
        InboundClosedCause.fromWire,
        InboundDispositionRule.fromWire,
        InboundErrorCode.fromWire,
        StationCapability.fromWire,
      ];
      for (final decode in decoders) {
        expect(decode(null).isUnknown, isTrue);
        expect(decode('not-a-value').isUnknown, isTrue);
      }
      expect(InboundStickyReason.fromWire('last_dialled'), InboundStickyReason.lastDialled);
      expect(InboundErrorCode.fromWire('inbound_call_live'), InboundErrorCode.inboundCallLive);
    });

    test('a call missing a required field throws a WireFormatException naming it', () {
      final json = callWith('inbound_call_offered', {})..remove('to_e164');
      expect(
        () => InboundCall.fromJson(json),
        throwsA(isA<WireFormatException>().having((e) => e.key, 'key', 'to_e164')),
      );
      expect(InboundCall.tryFromJson(json), isNull);
      expect(InboundCall.tryFromJson('not a map'), isNull);
    });
  });

  group('the request bodies the app sends', () {
    test('notes: sent when set, `\'\'` clears, null is left out', () {
      expect(const InboundCallUpdateRequest(notes: 'hello').toJson(), {'notes': 'hello'});
      expect(const InboundCallUpdateRequest(notes: '').toJson(), {'notes': ''});
      expect(const InboundCallUpdateRequest().toJson(), <String, Object?>{});
      expect(
        InboundCallUpdateRequest(notes: ib('call_update_request')['notes'] as String?).toJson(),
        ib('call_update_request'),
      );
    });

    test('disposition: code always, notes and callback only when set, the callback in UTC', () {
      expect(const InboundCallDispositionRequest(code: 'interested').toJson(), {'code': 'interested'});
      final local = DateTime.utc(2026, 11, 5, 9, 30).toLocal();
      final r = InboundCallDispositionRequest(code: 'callback', notes: 'Thursday', callbackAt: local);
      expect(r.toJson(), {'code': 'callback', 'notes': 'Thursday', 'callback_at': '2026-11-05T09:30:00.000Z'});
      expect(r, InboundCallDispositionRequest(code: 'callback', notes: 'Thursday', callbackAt: local));
      final fixtureBody = ib('call_disposition_request');
      expect(
        InboundCallDispositionRequest(
          code: fixtureBody['code']! as String,
          notes: fixtureBody['notes'] as String?,
          callbackAt: DateTime.parse(fixtureBody['callback_at']! as String),
        ).toJson(),
        fixtureBody,
      );
    });

    test('DNC: the reason only, never a scope', () {
      expect(const InboundCallDncRequest().toJson(), <String, Object?>{});
      expect(const InboundCallDncRequest(reason: 'Asked not to be called again').toJson(), ib('call_dnc_request'));
    });

    test('the request bodies round-trip through JSON text', () {
      for (final body in [
        const InboundCallUpdateRequest(notes: 'n').toJson(),
        InboundCallDispositionRequest(code: 'callback', callbackAt: DateTime.utc(2026, 11, 5, 9, 30)).toJson(),
        const InboundCallDncRequest(reason: 'r').toJson(),
      ]) {
        expect(jsonDecode(jsonEncode(body)), body);
      }
    });
  });

  group('the Missed list', () {
    test('a page decodes its rows, cursor and limit', () {
      final page = decodeInboundMissedPage(ib('missed_page'));
      expect(page.rows, hasLength(3));
      expect(page.hasMore, isTrue);
      expect(page.limit, 3);
      final [closed, overflow, voicemail] = page.rows;
      expect(closed.reason, InboundMissedReason.closed);
      expect(closed.closedCause, InboundClosedCause.hours);
      expect(closed.matchedCampaignName, 'Q4 Renewals — Pune');
      expect(closed.callbackDueAt, DateTime.utc(2026, 11, 2, 3, 30));
      expect(closed.isOpen, isTrue);
      expect(overflow.isWithheld, isTrue);
      expect(overflow.assigneeUserId, isNull);
      expect(voicemail.hasVoicemail, isTrue);
      expect(voicemail.voicemailUrl, '/inbound/missed/7d8e9f0a-1b23-4c4d-8e5f-607182930415/voicemail');
      expect(voicemail.callerDnc, isTrue);
      expect(voicemail.outcome, InboundCallOutcome.voicemail);
      final last = decodeInboundMissedPage(ib('missed_page_last'));
      expect(last.hasMore, isFalse);
      expect(last.rows.single.handledReason, InboundHandledReason.reached);
    });

    test('handled and reopen answer the row as it now is', () {
      final handled = InboundMissedCallResponse.fromJson(ib('missed_handled_response')).call;
      expect(handled.status, InboundFollowUpStatus.handled);
      expect(handled.handledReason, InboundHandledReason.marked);
      expect(handled.handledAt, DateTime.utc(2026, 11, 2, 4, 2, 31));
      final reopened = InboundMissedCallResponse.fromJson(ib('missed_reopen_response')).call;
      expect(reopened.isOpen, isTrue);
      expect(reopened.id, handled.id);
      expect(reopened.handledReason, isNull);
    });

    test('the count, and the badge it shows', () {
      final count = InboundMissedCountResponse.fromJson(ib('missed_count'));
      expect(count, const InboundMissedCountResponse(open: 3, openCapped: false, hasRows: true));
      expect(count.badge, '3');
      expect(InboundMissedCountResponse.fromJson(ib('missed_count_capped')).badge, '100+');
      expect(const InboundMissedCountResponse(open: 0, openCapped: false, hasRows: true).badge, '');
    });

    test('the query: only what is set, enums by wire value, times in UTC', () {
      expect(const InboundMissedQuery().toQuery(), <String, String>{});
      final q = InboundMissedQuery(
        status: InboundFollowUpStatus.handled,
        assignee: InboundMissedQuery.assigneeMe,
        reason: InboundMissedReason.overflowNoCapacity,
        from: DateTime.utc(2026, 11, 1),
        to: DateTime.utc(2026, 11, 2).toLocal(),
        limit: 25,
      );
      expect(q.toQuery(), {
        'status': 'handled',
        'assignee': 'me',
        'reason': 'overflow_no_capacity',
        'from': '2026-11-01T00:00:00.000Z',
        'to': '2026-11-02T00:00:00.000Z',
        'limit': '25',
      });
      final next = q.withCursor('abc');
      expect(next.toQuery()['cursor'], 'abc');
      expect(next.withCursor(null), q);
      expect(
        const InboundMissedQuery(status: InboundFollowUpStatus.unknown, reason: InboundMissedReason.unknown).toQuery(),
        <String, String>{},
      );
    });
  });

  group('ErrorBody: the inbound refusals', () {
    test('inbound_disposition_invalid with unknown_code lists the catalog', () {
      final body = ErrorBody.fromJson(ib('refusal_disposition_unknown_code'));
      expect(body.inboundCode, InboundErrorCode.inboundDispositionInvalid);
      expect(body.code, AgencyErrorCode.unknown, reason: 'not an action code');
      expect(body.softphoneCode, SoftphoneErrorCode.unknown, reason: 'not the soft phone\'s disposition_invalid');
      final r = body.inboundDispositionInvalid!;
      expect(r.rule, InboundDispositionRule.unknownCode);
      expect(r.allowedCodes, ['interested', 'callback', 'query_resolved', 'complaint', 'do_not_call']);
      expect(r.message, 'That outcome cannot be saved as submitted.');
      expect(body.inboundCallLive, isNull);
    });

    test('note_required has no codes; a new rule is unknown with its raw string', () {
      final r = ErrorBody.fromJson(ib('refusal_disposition_note_required')).inboundDispositionInvalid!;
      expect(r.rule, InboundDispositionRule.noteRequired);
      expect(r.allowedCodes, isNull);
      final novel = ErrorBody.fromJson({...ib('refusal_disposition_note_required'), 'reason': 'field_required'})
          .inboundDispositionInvalid!;
      expect(novel.rule, InboundDispositionRule.unknown);
      expect(novel.ruleRaw, 'field_required');
    });

    test('inbound_call_live names the call; without the id it is null but still coded', () {
      final body = ErrorBody.fromJson(ib('refusal_call_live'));
      expect(body.inboundCode, InboundErrorCode.inboundCallLive);
      expect(body.inboundCallLive!.inboundCallId, '3a9e1c7b-2f4d-4b8a-9c6e-5d7f0a1b2c3d');
      final bare = ErrorBody.fromJson({...ib('refusal_call_live')}..remove('inbound_call_id'));
      expect(bare.inboundCallLive, isNull);
      expect(bare.inboundCode, InboundErrorCode.inboundCallLive);
    });

    test('the plain refusals carry their code only', () {
      expect(
        ErrorBody.fromJson(ib('refusal_outcome_already_saved')).inboundCode,
        InboundErrorCode.inboundOutcomeAlreadySaved,
      );
      expect(ErrorBody.fromJson(ib('refusal_call_not_found')).inboundCode, InboundErrorCode.inboundCallNotFound);
      expect(ErrorBody.fromJson(ib('refusal_inbound_disabled')).inboundCode, InboundErrorCode.inboundDisabled);
      expect(ErrorBody.fromJson(ib('refusal_inbound_disabled')).inboundDispositionInvalid, isNull);
    });

    test('a soft-phone or action refusal is not an inbound one', () {
      expect(
        ErrorBody.fromJson(fixture('softphone.json', 'refusal_disposition_invalid')).inboundCode,
        InboundErrorCode.unknown,
      );
      expect(ErrorBody.fromJson(fixture('actions.json', 'error_session_ended')).inboundCode, InboundErrorCode.unknown);
    });
  });

  group('StationCapability: the station upgrade\'s caps=', () {
    test('the app\'s value is `inbound`', () {
      expect(StationCapability.queryKey, 'caps');
      expect(StationCapability.queryValue([StationCapability.inbound]), 'inbound');
    });

    test('unknown, duplicates and order do not change it; none is empty', () {
      expect(
        StationCapability.queryValue([StationCapability.unknown, StationCapability.inbound, StationCapability.inbound]),
        'inbound',
      );
      expect(StationCapability.queryValue(const []), '');
      expect(StationCapability.queryValue([StationCapability.unknown]), '');
    });

    test('withQuery sets or replaces caps= beside the other parameters, and leaves it off when empty', () {
      final base = {'client': 'mobile', 'media': 'alaw8'};
      expect(StationCapability.withQuery(base, [StationCapability.inbound]), {...base, 'caps': 'inbound'});
      expect(StationCapability.withQuery({...base, 'caps': 'old'}, [StationCapability.inbound]), {
        ...base,
        'caps': 'inbound',
      });
      expect(StationCapability.withQuery({...base, 'caps': 'old'}, const []), base);
      final uri = Uri.parse('wss://example.test/proxy/agency/station/s-1?token=t');
      final withCaps = uri.replace(
        queryParameters: StationCapability.withQuery({...uri.queryParameters, ...base}, [StationCapability.inbound]),
      );
      expect(withCaps.query, 'token=t&client=mobile&media=alaw8&caps=inbound');
    });

    test('decodes from the wire', () {
      expect(StationCapability.fromWire('inbound'), StationCapability.inbound);
    });
  });
}
