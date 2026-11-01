import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/app_gate.dart';
import 'telemetry.dart';

/// Follows the gate for [GateTelemetry] while watched (the root widget does).
final gateTelemetryProvider = Provider<void>((ref) {
  final telemetry = GateTelemetry();
  ref.listen(appGateProvider, (_, gate) => telemetry.changed(gate), fireImmediately: true);
});

/// Who the events are about, from the gate, as the console reports it: the
/// user's server id once signed in; the tenant and account (ids, names and
/// PostHog groups) on every event; and a fresh anonymous id after sign-out, so
/// whoever signs in next on a shared phone is not them.
///
/// Never the person's name or email ([Telemetry]'s PII rule).
final class GateTelemetry {
  String? _user;
  String? _scope;

  void changed(AppGate gate) {
    switch (gate) {
      case GateReady(:final userId, :final tenantId, :final tenantName, :final accountId, :final accountName):
        if (_user != userId) Telemetry.identify(userId);
        _user = userId;
        final scope = '$tenantId:$accountId';
        if (_scope != scope) {
          Telemetry.register({
            'tenant_id': tenantId,
            // Empty from a server that does not send it: replaces the last tenant's.
            'tenant_name': tenantName,
            'account_id': accountId,
            'account_name': accountName,
          });
          Telemetry.group('tenant', tenantId);
          Telemetry.group('account', accountId);
        }
        _scope = scope;
      case GateSignedOut():
        if (_user != null) Telemetry.reset();
        _user = null;
        _scope = null;
      default:
        // Loading, an update needed, an account to pick: the same person still.
        break;
    }
  }
}
