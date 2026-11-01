import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/app/router.dart';
import 'package:magick_agency_agent/app/routes.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';

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
}
