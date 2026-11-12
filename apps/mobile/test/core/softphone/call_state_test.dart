import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/call_state.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/station_view.dart' show StationLink;

import 'manual_calls.dart';

/// The console's `softphoneCallState.test.ts` tables, row for row, plus the
/// app's own rows (an unknown state, the device-clock timer, the mobile copy).
void main() {
  group('softphonePhase: the rail\'s five states from one row', () {
    test('reads every state', () {
      final call = manualCall();
      expect(softphonePhase(null), SoftphonePhase.ready);
      expect(softphonePhase(call), SoftphonePhase.dialing);
      expect(softphonePhase(manualCall({'state': 'dialing'})), SoftphonePhase.dialing);
      expect(softphonePhase(manualCall({'state': 'ringing'})), SoftphonePhase.ringing);
      expect(softphonePhase(manualCall({'state': 'answered'})), SoftphonePhase.onCall);
      expect(softphonePhase(manualCall({'state': 'bridged'})), SoftphonePhase.onCall);
      expect(softphonePhase(manualCall({'state': 'ended', 'requires_disposition': true})), SoftphonePhase.outcome);
      expect(softphonePhase(manualCall({'state': 'ended', 'requires_disposition': false})), SoftphonePhase.ready);
      expect(
        softphonePhase(manualCall({'state': 'ended', 'settled_at': '2026-10-30T10:05:00Z'})),
        SoftphonePhase.ready,
      );
    });

    test('a state this build does not know reads as a call on the line, never as Ready', () {
      expect(softphonePhase(manualCall({'state': 'transferring'})), SoftphonePhase.onCall);
      expect(
        softphonePhase(manualCall({'state': 'transferring', 'settled_at': '2026-10-30T10:05:00Z'})),
        SoftphonePhase.ready,
      );
    });

    test('holds the session for a live call and for one that owes its outcome, and for nothing else', () {
      expect(isCallUnsettled(manualCall({'state': 'ringing'})), isTrue);
      expect(isCallUnsettled(manualCall({'state': 'ended', 'requires_disposition': true})), isTrue);
      expect(isCallUnsettled(manualCall({'state': 'ended', 'requires_disposition': false})), isFalse);
      expect(isCallLive(manualCall({'state': 'ended', 'requires_disposition': true})), isFalse);
      expect(isCallUnsettled(null), isFalse);
      expect(isCallLive(null), isFalse);
    });
  });

  group('newerCall: frames are the authority, HTTP answers fill the gap', () {
    final base = manualCall();

    test('takes the later updated_at for the same call', () {
      final ringing = step(base, 3, {'state': 'ringing'});
      expect(identical(newerCall(base, ringing), ringing), isTrue);
      expect(identical(newerCall(ringing, base), ringing), isTrue);
    });

    test('lets the first argument (the frame) win a tie', () {
      final frame = step(base, 3, {'state': 'ended'});
      final http = step(base, 3, {'state': 'ringing'});
      expect(identical(newerCall(frame, http), frame), isTrue);
    });

    test('takes a settled copy over an unsettled one with the same stamp', () {
      final unsettled = step(base, 9, {'state': 'ended', 'requires_disposition': true});
      final settled = step(base, 9, {'state': 'ended', 'settled_at': '2026-10-30T10:00:09.000Z'});
      expect(identical(newerCall(unsettled, settled), settled), isTrue);
    });

    test('lets a new dial win over the one before it', () {
      final next = manualCall({
        'id': 'mc-2',
        'created_at': '2026-10-30T10:10:00.000Z',
        'updated_at': '2026-10-30T10:10:00.000Z',
      });
      expect(identical(newerCall(base, next), next), isTrue);
      expect(identical(newerCall(next, base), next), isTrue);
    });

    test('null on either side answers the other', () {
      expect(newerCall(null, null), isNull);
      expect(identical(newerCall(base, null), base), isTrue);
      expect(identical(newerCall(null, base), base), isTrue);
    });
  });

  group('describeSoftphoneRail', () {
    SoftphoneRail rail({
      StationLink link = StationLink.open,
      ManualCall? call,
      ManualCall? lastCall,
      bool fromCampaign = false,
      String? contactName,
      int offsetMs = 0,
    }) => describeSoftphoneRail(
      link: link,
      call: call,
      lastCall: lastCall,
      fromCampaign: fromCampaign,
      contactName: contactName,
      offsetMs: offsetMs,
    );

    test('Ready, with the campaign sentence only when switched from one', () {
      expect(rail().label, 'Ready to dial');
      expect(rail().detail, isNot(contains('paced')));
      expect(
        rail(fromCampaign: true).detail,
        contains("not paced, and the campaign's dialer does not reserve you"),
      );
    });

    test('Dialling and Ringing name the number and time from dialed_at', () {
      final ringing = manualCall({'state': 'ringing'});
      final r = rail(call: ringing);
      expect(r.label, 'Ringing +91 98204 61733');
      expect(r.detail, contains('ringback tone plays on your phone'));
      expect(r.timerFrom, ringing.dialedAt);
      expect(rail(call: manualCall()).label, 'Dialling +91 98204 61733');
    });

    test('On call names the contact and times from bridged_at alone', () {
      expect(rail(call: manualCall({'state': 'answered'})).timerFrom, isNull);
      final bridged = manualCall({'state': 'bridged', 'bridged_at': '2026-10-30T10:00:05Z'});
      final r = rail(call: bridged, contactName: 'Rahul Verma');
      expect(r.tone, SoftphoneRailTone.success);
      expect(r.label, 'On call with Rahul Verma');
      expect(r.timerFrom, DateTime.utc(2026, 10, 30, 10, 0, 5));
    });

    test('the timer is on this device\'s clock: the offset is subtracted', () {
      final bridged = manualCall({'state': 'bridged', 'bridged_at': '2026-10-30T10:00:05Z'});
      expect(rail(call: bridged, offsetMs: 2000).timerFrom, DateTime.utc(2026, 10, 30, 10, 0, 3));
    });

    test('Outcome needed after an answered call ends', () {
      final ended = manualCall({
        'state': 'ended',
        'requires_disposition': true,
        'end_reason': 'remote_hangup',
        'ended_at': '2026-10-30T10:04:00Z',
      });
      final r = rail(call: ended);
      expect(r.label, 'Outcome needed');
      expect(r.detail, contains('The customer hung up.'));
      expect(r.timerFrom, DateTime.utc(2026, 10, 30, 10, 4));
    });

    test('says how the last unanswered call ended on the Ready rail', () {
      final last = manualCall({'state': 'ended', 'end_reason': 'no_answer', 'settled_at': '2026-10-30T10:01:00Z'});
      expect(rail(lastCall: last).detail, startsWith('Last call to +91 98204 61733: No answer.'));
    });

    test('lets connection failures outrank the call', () {
      final live = manualCall({'state': 'bridged', 'bridged_at': '2026-10-30T10:00:05Z'});
      expect(rail(link: StationLink.disconnected, call: live).detail, contains('customer can’t hear you'));
      expect(rail(link: StationLink.reconnecting, call: live).label, 'Reconnecting');
      expect(rail(link: StationLink.superseded).tone, SoftphoneRailTone.danger);
      expect(rail(link: StationLink.connecting).label, 'Connecting your phone…');
      expect(rail(link: StationLink.sessionGone).label, 'Session ended');
    });
  });

  group('contactName', () {
    test('reads a name-like field through the tag\'s display, never the first column', () {
      final call = manualCall({
        'contact': {
          'contact_id': 'c-1',
          'state': 'in_flight',
          'claimed': true,
          'context': {'Loan account': 'HL-20931', 'Name': 'Rahul Verma'},
        },
      });
      expect(contactName(call, ContextDisplay(hero: const ['Loan account', 'Name'])), 'Rahul Verma');
      expect(contactName(manualCall(), null), isNull);
    });
  });

  group('callEndSummary', () {
    test('the end reason when known, else the line\'s outcome, else a plain ending', () {
      expect(callEndSummary(manualCall({'state': 'ended', 'end_reason': 'busy'})), 'The line was busy.');
      expect(callEndSummary(manualCall({'state': 'ended', 'outcome': 'no_answer'})), 'No answer.');
      expect(callEndSummary(manualCall({'state': 'ended'})), 'The call ended.');
    });

    test('every end reason the contract declares has its sentence', () {
      for (final r in ManualCallEndReason.values.where((r) => !r.isUnknown)) {
        expect(manualEndReasonCopy[r], isNotNull, reason: r.wire);
      }
    });
  });
}
