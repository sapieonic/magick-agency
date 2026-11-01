import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/auth/app_gate.dart';
import 'package:magick_agency_agent/features/performance/agent_workspace.dart';

class _Gate extends AppGateNotifier {
  _Gate(this.initial);
  final AppGate initial;

  @override
  AppGate build() => initial;

  void put(AppGate gate) => state = gate;
}

GateReady _ready(String user, String tenant, String account) => GateReady(
      userId: user,
      displayName: user,
      email: '$user@example.test',
      tenantId: tenant,
      accountId: account,
      accountName: account,
    );

void main() {
  test('the workspace key is the signed-in agent and their account; null when not ready', () {
    final gate = _Gate(_ready('u1', 't1', 'a1'));
    final c = ProviderContainer(overrides: [appGateProvider.overrideWith(() => gate)]);
    addTearDown(c.dispose);
    final seen = <String?>[];
    c.listen(agentWorkspaceProvider, (_, next) => seen.add(next), fireImmediately: true);

    for (final g in [
      _ready('u1', 't1', 'a2'), // another account
      _ready('u2', 't1', 'a2'), // another agent, same account
      const GateSignedOut(),
    ]) {
      gate.put(g);
      c.read(agentWorkspaceProvider);
    }

    expect(seen, ['u1:t1:a1', 'u1:t1:a2', 'u2:t1:a2', null]);
  });
}
