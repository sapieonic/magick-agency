// The soft phone's wire types beyond "the fixtures decode" (fixtures_test.dart):
// the refusal accessors, the request bodies' omission rules, the list query,
// and the row's own predicates.

import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

Map<String, Object?> sp(String name) => fixture('softphone.json', name);

void main() {
  group('ErrorBody: the soft-phone refusals', () {
    test('dnc_listed reads its entry, and nothing else answers', () {
      final body = ErrorBody.fromJson(sp('refusal_dnc_listed'));
      expect(body.softphoneCode, SoftphoneErrorCode.dncListed);
      expect(body.code, AgencyErrorCode.unknown, reason: 'not an action code');
      final r = body.dncListed!;
      expect(r.entry.scope, DncEntryScope.account);
      expect(r.entry.reason, 'Asked not to be called');
      expect(r.entry.createdAt, DateTime.utc(2026, 10, 20, 11));
      expect(r.message, 'This number is on the Do Not Call list.');
      expect(body.outsideHours, isNull);
      expect(body.contactInFlight, isNull);
      expect(body.sessionOnCampaign, isNull);
      expect(body.callPending, isNull);
    });

    test('outside_calling_hours reads the window, the zone source and the next opening', () {
      final r = ErrorBody.fromJson(sp('refusal_outside_hours')).outsideHours!;
      expect(r.window.start, '09:00:00');
      expect(r.window.days, [1, 2, 3, 4, 5, 6]);
      expect(r.window.timezone, 'Asia/Kolkata');
      expect(r.timezoneSource, HoursTimezoneSource.contact);
      expect(r.nextOpenAt, DateTime.utc(2026, 11, 2, 3, 30));
    });

    test('contact_in_flight and session_on_campaign read their fields', () {
      final flight = ErrorBody.fromJson(sp('refusal_contact_in_flight')).contactInFlight!;
      expect(flight.campaignId, 'c0ffee00-1111-4222-8333-444455556666');
      final campaign = ErrorBody.fromJson(sp('refusal_session_on_campaign')).sessionOnCampaign!;
      expect(campaign.state, AgentState.available);
      expect(campaign.accountId, 'acc-3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f');
      expect(campaign.accountName, 'Pune Branch');
    });

    test('outcome_pending and manual_call_live carry the session\'s unsettled call', () {
      final pending = ErrorBody.fromJson(sp('refusal_outcome_pending')).callPending!;
      expect(pending.code, SoftphoneErrorCode.outcomePending);
      expect(pending.call.owesOutcome, isTrue);
      final live = ErrorBody.fromJson({...sp('refusal_outcome_pending'), 'code': 'manual_call_live'}).callPending!;
      expect(live.code, SoftphoneErrorCode.manualCallLive);
    });

    test('a refusal whose fields do not read is null, never a throw', () {
      expect(ErrorBody.fromJson({...sp('refusal_dnc_listed'), 'entry': 'nope'}).dncListed, isNull);
      expect(ErrorBody.fromJson({...sp('refusal_outside_hours'), 'window': null}).outsideHours, isNull);
      expect(ErrorBody.fromJson({...sp('refusal_outcome_pending'), 'call': {'id': 'x'}}).callPending, isNull);
      expect(ErrorBody.fromJson({...sp('refusal_session_on_campaign'), 'account_id': 5}).sessionOnCampaign, isNull);
    });

    test('fields_invalid lists one issue per path, and names the field', () {
      final body = ErrorBody.fromJson(sp('refusal_fields_invalid'));
      expect(body.softphoneCode, SoftphoneErrorCode.fieldsInvalid);
      expect(body.details, const [
        FieldIssue(path: 'fields.customer_name', message: 'Customer name is required'),
        FieldIssue(path: 'fields.loan_amount', message: 'Loan amount must be a number'),
      ]);
      expect(body.details!.map((d) => d.fieldKey), ['customer_name', 'loan_amount']);
      expect(const FieldIssue(path: 'overrides.dnc_note', message: '').fieldKey, isNull);
      expect(const FieldIssue(path: 'fields[visit_on]', message: '').fieldKey, 'visit_on');
    });

    test('a validation 400 with an object `details` reads as no details', () {
      final body = ErrorBody.fromJson({
        'error': 'Validation failed',
        'details': {'session_id': 'required'},
      });
      expect(body.details, isNull);
      expect(body.softphoneCode, SoftphoneErrorCode.unknown);
    });

    test('disposition_invalid keeps the allowed codes; softphone_disabled is just its code', () {
      final body = ErrorBody.fromJson(sp('refusal_disposition_invalid'));
      expect(body.softphoneCode, SoftphoneErrorCode.dispositionInvalid);
      expect(body.allowedCodes, ['interested', 'callback', 'documents', 'do_not_call']);
      expect(ErrorBody.fromJson(sp('refusal_softphone_disabled')).softphoneCode, SoftphoneErrorCode.softphoneDisabled);
    });

    test('session_on_softphone is both an action code (the join) and a soft-phone code (the open)', () {
      final body = ErrorBody.fromJson(fixture('session.json', 'conflict_softphone'));
      expect(body.code, AgencyErrorCode.sessionOnSoftphone);
      expect(body.softphoneCode, SoftphoneErrorCode.sessionOnSoftphone);
      expect(body.softphoneConflict, isNotNull);
    });
  });

  group('requests', () {
    test('create: campaign_id is always sent, null for an untagged call', () {
      final json = ManualCallCreateRequest(sessionId: 's1', to: '98123 45678').toJson();
      expect(json, {'session_id': 's1', 'to': '98123 45678', 'campaign_id': null});
      expect(json.containsKey('campaign_id'), isTrue);
    });

    test('create: fields and overrides only when given, and empty overrides are left out', () {
      final json = ManualCallCreateRequest(
        sessionId: 's1',
        to: '+919812345678',
        callerId: '+912071234567',
        campaignId: 'c1',
        fields: const {'customer_name': 'Rahul', 'follow_up': null},
        overrides: const ManualCallOverridesRequest(),
      ).toJson();
      expect(json['fields'], {'customer_name': 'Rahul', 'follow_up': null});
      expect(json.containsKey('overrides'), isFalse);
      final withNote = ManualCallCreateRequest(
        sessionId: 's1',
        to: '1',
        overrides: const ManualCallOverridesRequest().withDncNote('Customer asked us to call back'),
      ).toJson();
      expect(withNote['overrides'], {'dnc_note': 'Customer asked us to call back'});
    });

    test('a second override keeps the first note', () {
      final both = const ManualCallOverridesRequest().withDncNote('first reason here').withHoursNote('second reason here');
      expect(both.toJson(), {'dnc_note': 'first reason here', 'hours_note': 'second reason here'});
    });

    test('update: null is left out, an empty string clears the notes, an empty map clears the fields', () {
      expect(ManualCallUpdateRequest().toJson(), isEmpty);
      expect(ManualCallUpdateRequest(notes: 'hi').toJson(), {'notes': 'hi'});
      expect(ManualCallUpdateRequest(notes: '', fields: const {}).toJson(), {'notes': '', 'fields': <String, Object?>{}});
    });

    test('disposition: callback_at in UTC ISO, the rest only when given', () {
      expect(ManualCallDispositionRequest(code: 'resolved').toJson(), {'code': 'resolved'});
      final json = ManualCallDispositionRequest(
        code: 'callback',
        notes: '',
        callbackAt: DateTime.utc(2026, 11, 2, 4, 30),
      ).toJson();
      expect(json, {'code': 'callback', 'notes': '', 'callback_at': '2026-11-02T04:30:00.000Z'});
    });

    test('dnc: the reason only when given; the scope is never the client\'s', () {
      expect(const ManualCallDncRequest().toJson(), isEmpty);
      expect(const ManualCallDncRequest(reason: 'Asked').toJson(), {'reason': 'Asked'});
    });

    test('the request values are frozen', () {
      final fields = <String, Object?>{'a': 1};
      final r = ManualCallUpdateRequest(fields: fields);
      fields['a'] = 2;
      expect(r.fields, {'a': 1});
      expect(() => r.fields!['b'] = 1, throwsUnsupportedError);
    });
  });

  group('ManualCallsQuery', () {
    test('always names the agent, and sends only what is set', () {
      expect(const ManualCallsQuery(agentUserId: 'u1').toQuery(), {'agent_user_id': 'u1'});
    });

    test('every filter, in the server\'s spelling', () {
      final q = ManualCallsQuery(
        agentUserId: 'u1',
        cursor: 'cur',
        limit: 8,
        campaignId: 'c1',
        status: ManualCallListStatus.awaitingOutcome,
        outcome: AttemptOutcome.noAnswer,
        dispositionCode: 'callback',
        phoneDigits: '+91 98123-45',
        contactId: 'k1',
        from: DateTime.utc(2026, 11),
        to: DateTime.utc(2026, 11, 2),
      );
      expect(q.toQuery(), {
        'agent_user_id': 'u1',
        'cursor': 'cur',
        'limit': '8',
        'campaign_id': 'c1',
        'status': 'awaiting_outcome',
        'outcome': 'no_answer',
        'disposition_code': 'callback',
        'phone': '919812345',
        'contact_id': 'k1',
        'from': '2026-11-01T00:00:00.000Z',
        'to': '2026-11-02T00:00:00.000Z',
      });
    });

    test('untagged wins over a campaign; a phone term with no digit is left out', () {
      const q = ManualCallsQuery(agentUserId: 'u1', campaignId: 'c1', untaggedOnly: true, phoneDigits: '+-');
      expect(q.toQuery(), {'agent_user_id': 'u1', 'campaign_id': 'untagged'});
    });

    test('withCursor changes the cursor and nothing else', () {
      const q = ManualCallsQuery(agentUserId: 'u1', status: ManualCallListStatus.settled, limit: 20);
      final next = q.withCursor('n2');
      expect(next.cursor, 'n2');
      expect(next.withCursor(null), q);
    });
  });

  group('ManualCall', () {
    ManualCall call(String name) => SoftphoneBootstrap.fromJson(sp(name)).call!;

    test('live, unsettled and owed, from the row alone', () {
      final ringing = call('bootstrap_enabled');
      expect((ringing.isLive, ringing.isUnsettled, ringing.owesOutcome, ringing.isSettled), (true, true, false, false));
      final owed = call('bootstrap_finish_mode');
      expect((owed.isLive, owed.isUnsettled, owed.owesOutcome, owed.isSettled), (false, true, true, false));
      final settled = ManualCallDispositionResponse.fromJson(sp('call_disposition_response')).call;
      expect((settled.isLive, settled.isUnsettled, settled.owesOutcome, settled.isSettled), (false, false, false, true));
    });

    test('versionKey names the copy: id at updated_at', () {
      expect(call('bootstrap_enabled').versionKey, '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d@2026-11-01T08:02:11.004Z');
    });

    test('tryFromJson is null for anything that is not a readable row', () {
      expect(ManualCall.tryFromJson(null), isNull);
      expect(ManualCall.tryFromJson('x'), isNull);
      expect(ManualCall.tryFromJson(<String, Object?>{}), isNull);
      expect(ManualCall.tryFromJson(sp('call_hangup_response')), isA<ManualCall>());
    });

    test('a list row is a ManualCall with its analysis status, and no contact context', () {
      final page = decodeManualCallsPage(sp('calls_page'));
      expect(page.rows, hasLength(2));
      expect(page.hasMore, isTrue);
      final tagged = page.rows.first;
      expect(tagged, isA<ManualCall>());
      expect(tagged.analysisStatusRaw, 'completed');
      expect(tagged.contact!.context, isNull);
      expect(tagged.contact!.priorAttempts, isNull);
      expect(page.rows.last.tag, isNull);
      expect(page.rows.last.analysisStatusRaw, isNull);
      // A row and the plain call it carries are different types, so never equal.
      final plain = ManualCall.fromJson((sp('calls_page')['rows']! as List<Object?>).first! as Map<String, Object?>);
      expect(tagged == plain, isFalse);
    });

    test('the detail keeps media opaque and names who saved the outcome', () {
      final d = ManualCallDetail.fromJson(sp('call_detail_agent'));
      expect(d.media, isNull);
      expect(d.callAvailability, CallAvailability.available);
      expect(d.dispositionedByName, 'Sunil Rao');
      expect(d.call.dispositionedOnBehalf, isTrue);
      expect(d.overrides.dncEntry!.campaignId, 'c0ffee00-1111-4222-8333-444455556666');
      expect(d.call.contact!.priorAttempts, hasLength(1));
      final supervisor = ManualCallDetail.fromJson({...sp('call_detail_agent'), 'media': {'id': 'm1'}});
      expect(supervisor.media, {'id': 'm1'});
    });
  });

  group('SoftphoneBootstrap', () {
    test('finds a taggable campaign by id', () {
      final b = SoftphoneBootstrap.fromJson(sp('bootstrap_enabled'));
      expect(b.taggable('c0ffee00-1111-4222-8333-444455556666')!.callingWindowOpen, isTrue);
      expect(b.taggable('nope'), isNull);
      expect(b.taggable(null), isNull);
      expect(b.callFields.where((f) => f.required).map((f) => f.key), ['customer_name']);
      expect(b.callFields.map((f) => f.type), CallFieldType.values.where((t) => !t.isUnknown));
    });

    test('a campaign session switched to the soft phone, with the switch queued, reads as such', () {
      final summary = SoftphoneSessionSummary.fromJson({
        ...sp('bootstrap_finish_mode')['session']! as Map<String, Object?>,
        'state': 'wrapup',
        'on_softphone': false,
        'pending_state': 'break',
        'pending_break_reason': 'soft_phone',
      });
      expect(summary.kind, SessionKind.campaign);
      expect(summary.switchQueued, isTrue);
    });
  });
}
