import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/station/station_signals.dart';

/// Invite links through the gate. The rest of the redirect table is tested
/// with the app's foundations.
void main() {
  test('choosing an account may still open an invite; anything else goes to the picker', () {
    expect(gateRedirect(const GateNeedsAccount(), Routes.invite('tok')), isNull);
    expect(gateRedirect(const GateNeedsAccount(), Routes.accounts), isNull);
    expect(gateRedirect(const GateNeedsAccount(), Routes.home), Routes.accounts);
    expect(gateRedirect(const GateNeedsAccount(), Routes.station('c1')), Routes.accounts);
  });

  test('every gate that lets an invite through agrees on it', () {
    for (final gate in [const GateLoading(), const GateSignedOut(), const GateNoMembership(email: null), const GateNeedsAccount()]) {
      expect(gateRedirect(gate, Routes.invite('tok')), isNull, reason: '$gate');
    }
  });

  group('an invite link while a soft-phone call is unfinished leads to that call', () {
    const ready = GateReady(userId: 'u1', displayName: 'Meera', email: null, tenantId: 't1', accountId: 'a1', accountName: 'Chennai');
    const softphone = StationSessionKind.softphone;
    final invite = Routes.invite('tok');

    test('on the Phone tab (a soft-phone session): live, and owing its outcome', () {
      const live = StationSignals(onDuty: true, onBreak: true, sessionKind: softphone, callActive: true);
      const owed = StationSignals(onDuty: true, onBreak: true, sessionKind: softphone, outcomeOwed: true);
      expect(appRedirect(ready, live, invite, phoneVisible: true), Routes.phone);
      expect(appRedirect(ready, owed, invite, phoneVisible: true), Routes.phone);
    });

    test('on a campaign station switched to the soft phone: live, and owing its outcome', () {
      const live = StationSignals(onDuty: true, onBreak: true, campaignId: 'c1', onSoftphone: true, callActive: true);
      const owed = StationSignals(onDuty: true, onBreak: true, campaignId: 'c1', onSoftphone: true, outcomeOwed: true);
      expect(appRedirect(ready, live, invite, phoneVisible: true), Routes.station('c1'));
      expect(appRedirect(ready, owed, invite, phoneVisible: true), Routes.station('c1'));
    });

    test('an idle soft phone lets the invitation open', () {
      const idle = StationSignals(onDuty: true, onBreak: true, sessionKind: softphone);
      expect(appRedirect(ready, idle, invite, phoneVisible: true), isNull);
    });
  });
}
