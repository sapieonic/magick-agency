import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

import 'support/fixtures.dart';

void main() {
  group('responses', () {
    test('hangup may still say bridged; the station is the authority', () {
      final h = HangupResponse.fromJson(fixture('actions.json', 'hangup_response'));
      expect(h.state, AttemptState.bridged);
      expect(h.outcome, isNull);
    });

    test('a booked callback separates what was asked from what will happen', () {
      final d = DispositionResponse.fromJson(fixture('actions.json', 'disposition_response_callback'));
      expect(d.contactState, ContactState.pending);
      expect(d.callbackRequestedAt, DateTime.utc(2026, 11, 3, 12, 30));
      expect(d.nextAttemptAt, DateTime.utc(2026, 11, 4, 3, 30));
      expect(d.agentState, AgentState.available);
    });

    test('callback_requested_at is optional as well as nullable', () {
      final json = Map.of(fixture('actions.json', 'disposition_response_completed'))..remove('callback_requested_at');
      expect(DispositionResponse.fromJson(json).callbackRequestedAt, isNull);
    });

    test('a redial names the new attempt and the one it redials', () {
      final r = RedialResponse.fromJson(fixture('actions.json', 'redial_response'));
      expect(r.attemptId, '6b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8');
      expect(r.redialOfAttemptId, 'b8f4d3c2-6e5a-4f7b-9c0d-1e2f3a4b5c6d');
      expect(r.redialNumber, 1);
      expect(r.redialRemaining, 1);
    });

    test('notes and DNC', () {
      final n = NotesResponse.fromJson(fixture('actions.json', 'notes_response'));
      expect(n.updatedAt.isUtc, isTrue);
      final d = DncResponse.fromJson(fixture('actions.json', 'dnc_response'));
      expect(d.contactState, ContactState.suppressed);
      expect(d.dncRecorded, isFalse);
    });
  });

  group('requests', () {
    test('disposition sends the callback as a UTC instant', () {
      final ist = DateTime.parse('2026-11-03T18:00:00+05:30');
      expect(DispositionRequest(dispositionCode: 'callback', notes: 'n', callbackAt: ist).toJson(), {
        'disposition_code': 'callback',
        'notes': 'n',
        'callback_at': '2026-11-03T12:30:00.000Z',
      });
      expect(const DispositionRequest(dispositionCode: 'interested').toJson(), {'disposition_code': 'interested'});
    });

    test('DNC is always campaign-scoped and explicit', () {
      expect(const DncRequest().toJson(), {'scope': 'campaign'});
      expect(const DncRequest(reason: 'r', dispositionCode: 'do_not_call').toJson(), {
        'scope': 'campaign',
        'reason': 'r',
        'disposition_code': 'do_not_call',
      });
    });

    test('notes', () {
      expect(const NotesRequest('').toJson(), {'notes': ''});
    });

    test('redial sends only the attempt on screen, never the actor', () {
      expect(const RedialRequest(attemptId: 'a-1').toJson(), {'attempt_id': 'a-1'});
      expect(
        const RedialRequest(attemptId: 'b8f4d3c2-6e5a-4f7b-9c0d-1e2f3a4b5c6d').toJson(),
        fixture('actions.json', 'redial_request'),
      );
    });
  });

  group('ErrorBody', () {
    test('reads the code and the allowed values', () {
      final e = ErrorBody.fromJson(fixture('actions.json', 'error_unknown_disposition_code'));
      expect(e.code, AgencyErrorCode.unknownDispositionCode);
      expect(e.allowedCodes, contains('callback'));
      expect(e.message, isNotEmpty);
    });

    test('an unknown code keeps the raw string and the message', () {
      final e = ErrorBody.fromJson({'error': 'Conflict', 'code': 'shift_closed', 'message': 'Your shift has ended.'});
      expect(e.code, AgencyErrorCode.unknown);
      expect(e.codeRaw, 'shift_closed');
      expect(e.message, 'Your shift has ended.');
    });

    test('never throws, whatever the body', () {
      final e = ErrorBody.fromJson({'code': 7, 'message': null, 'allowed_codes': 'x'});
      expect(e.codeRaw, isNull);
      expect(e.code, AgencyErrorCode.unknown);
      expect(e.message, '');
      expect(e.error, '');
      expect(e.allowedCodes, isNull);
      expect(ErrorBody.fromJson(const {}).campaignConflict, isNull);
    });

    test('the server additions are known codes', () {
      expect(
        ErrorBody.fromJson({'error': 'Forbidden', 'code': 'not_staffed', 'message': 'm'}).code,
        AgencyErrorCode.notStaffed,
      );
    });

    test('session_on_other_campaign yields the structured conflict', () {
      final e = ErrorBody.fromJson(fixture('session.json', 'conflict_other_campaign'));
      expect(e.code, AgencyErrorCode.sessionOnOtherCampaign);
      final c = e.campaignConflict!;
      expect(c.campaignName, 'Q3 Winback');
      expect(c.state, AgentState.onCall);
      // What leaving it needs: the session, and the (sibling) account it is in.
      expect(c.sessionId, '5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f');
      expect(c.accountId, 'acc-4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a');
      expect(c.accountName, 'Nashik Branch');
      expect(c.canLeave, isTrue);
      expect(e.softphoneConflict, isNull);
    });

    test('a conflict from an older server, without the session fields, still reads', () {
      final json = Map.of(fixture('session.json', 'conflict_other_campaign'))
        ..remove('session_id')
        ..remove('account_id')
        ..remove('account_name');
      final c = ErrorBody.fromJson(json).campaignConflict!;
      expect(c.campaignName, 'Q3 Winback');
      expect(c.sessionId, isNull);
      expect(c.accountId, isNull);
      expect(c.accountName, isNull);
      expect(c.canLeave, isFalse);
    });

    test('an account name the server could not read is null, the ids still there', () {
      final json = {...fixture('session.json', 'conflict_other_campaign'), 'account_name': null};
      final c = ErrorBody.fromJson(json).campaignConflict!;
      expect(c.accountName, isNull);
      expect(c.canLeave, isTrue);
    });

    test('the wrap-up redial refusals are known codes, with the server sentence', () {
      final limit = ErrorBody.fromJson(fixture('actions.json', 'error_redial_limit_reached'));
      expect(limit.code, AgencyErrorCode.redialLimitReached);
      expect(limit.message, isNotEmpty);
      expect(
        ErrorBody.fromJson(fixture('actions.json', 'error_redial_blocked_dnc')).code,
        AgencyErrorCode.redialBlockedDnc,
      );
      for (final (wire, code) in const [
        ('redial_not_allowed', AgencyErrorCode.redialNotAllowed),
        ('disposition_already_submitted', AgencyErrorCode.dispositionAlreadySubmitted),
        ('redial_blocked_calling_hours', AgencyErrorCode.redialBlockedCallingHours),
        ('redial_blocked', AgencyErrorCode.redialBlocked),
      ]) {
        expect(ErrorBody.fromJson({'error': 'Conflict', 'code': wire, 'message': 'm'}).code, code);
      }
    });

    test('state_changing: the device-away pause lost to a moving state', () {
      final e = ErrorBody.fromJson({
        'error': 'Conflict',
        'code': 'state_changing',
        'message': 'Your status changed while pausing you; nothing changed. Try again.',
      });
      expect(e.code, AgencyErrorCode.stateChanging);
    });

    test('a conflict whose fields do not read degrades to the message', () {
      final e = ErrorBody.fromJson({
        'error': 'Conflict',
        'code': 'session_on_other_campaign',
        'message': 'Leave first.',
      });
      expect(e.campaignConflict, isNull);
      expect(e.message, 'Leave first.');
    });

    test('session_on_softphone yields the structured refusal', () {
      final e = ErrorBody.fromJson(fixture('session.json', 'conflict_softphone'));
      expect(e.code, AgencyErrorCode.sessionOnSoftphone);
      expect(e.softphoneConflict!.accountName, 'Pune Branch');
    });

    test('sign-in refusals are read with their own vocabulary', () {
      final e = ErrorBody.fromJson(fixture('platform.json', 'session_refusal'));
      expect(SessionRefusalCode.fromWire(e.codeRaw), SessionRefusalCode.noMembership);
      expect(e.code, AgencyErrorCode.unknown);
    });
  });
}
