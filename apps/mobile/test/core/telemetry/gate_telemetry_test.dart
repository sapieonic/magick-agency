import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/core/telemetry/gate_telemetry.dart';
import 'package:magick_agency_agent/core/telemetry/telemetry.dart';

import 'fake_telemetry_sink.dart';

/// Who the events are about: the user's id and the account's, never their
/// name or email; a fresh identity after sign-out.
void main() {
  late FakeTelemetrySink sink;
  late GateTelemetry gate;

  setUp(() {
    sink = installFakeTelemetry();
    gate = GateTelemetry();
  });
  tearDown(Telemetry.uninstall);

  GateReady ready({String user = 'u-1', String account = 'a1'}) => GateReady(
        userId: user,
        displayName: 'Meera Iyer',
        email: 'meera@example.com',
        tenantId: 't1',
        accountId: account,
        accountName: 'Chennai',
      );

  test('signed in: identified by id, the tenant and account on every event; no name, no email', () {
    gate.changed(const GateLoading());
    gate.changed(ready());
    expect(sink.identified, ['u-1']);
    expect(sink.registered, [
      {'tenant_id': 't1', 'account_id': 'a1'},
    ]);
    final everything = '${sink.identified} ${sink.registered} ${sink.events}';
    expect(everything, isNot(contains('Meera')));
    expect(everything, isNot(contains('example.com')));
  });

  test('an account switch (through loading) re-tags the events; the person is the same', () {
    gate.changed(ready());
    gate.changed(const GateLoading());
    gate.changed(ready(account: 'a2'));
    gate.changed(ready(account: 'a2'));
    expect(sink.identified, ['u-1']);
    expect(sink.registered.map((r) => r['account_id']), ['a1', 'a2']);
  });

  test('signed out: a fresh identity, once; a launch signed out resets nothing', () {
    gate.changed(const GateSignedOut());
    expect(sink.resets, 0);

    gate.changed(ready());
    gate.changed(const GateSignedOut());
    gate.changed(const GateSignedOut());
    expect(sink.resets, 1);

    gate.changed(ready(user: 'u-2'));
    expect(sink.identified, ['u-1', 'u-2']);
    expect(sink.registered.length, 2, reason: 'the reset cleared the tags: set again');
  });
}
