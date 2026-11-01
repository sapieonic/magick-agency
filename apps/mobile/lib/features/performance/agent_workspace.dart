import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/app_gate.dart';

/// Whose records "My calls" and "My performance" are showing:
/// `user:tenant:account`, or null when nobody is signed in to an account.
///
/// Both tabs stay mounted in the shell across an account switch, and a
/// different agent can sign in on the same phone to the same account, so the
/// signed-in user is part of the key, not only the account. Everything those
/// tabs cache (pages of calls, stats, campaign names) is keyed on this and
/// dropped when it changes: one agent never sees another's numbers or notes.
final agentWorkspaceProvider = Provider<String?>((ref) {
  final account = ref.watch(readyAccountProvider);
  final userId = ref.watch(appGateProvider.select((g) => g is GateReady ? g.userId : null));
  if (account == null || userId == null) return null;
  return '$userId:${account.tenantId}:${account.accountId}';
});
