import 'package:flutter/foundation.dart';

import 'session_store.dart';

/// One account the agent can work in: `GET /accounts/mine`, per tenant they
/// belong to, joined with the tenant's name from the session.
@immutable
class AccountChoice {
  const AccountChoice({
    required this.tenantId,
    required this.tenantName,
    required this.accountId,
    required this.accountName,
  });

  final String tenantId;
  final String tenantName;
  final String accountId;
  final String accountName;

  /// "Acme Collections · Chennai": the workspace, then the account.
  String get label => tenantName.isEmpty || tenantName == accountName ? accountName : '$tenantName · $accountName';

  @override
  bool operator ==(Object other) =>
      other is AccountChoice &&
      other.tenantId == tenantId &&
      other.tenantName == tenantName &&
      other.accountId == accountId &&
      other.accountName == accountName;

  @override
  int get hashCode => Object.hash(tenantId, tenantName, accountId, accountName);

  @override
  String toString() => 'AccountChoice($tenantId/$accountId)';
}

/// What to do with the accounts the agent has.
sealed class AccountPick {
  const AccountPick();
}

final class AccountPicked extends AccountPick {
  const AccountPicked(this.choice);
  final AccountChoice choice;

  @override
  bool operator ==(Object other) => other is AccountPicked && other.choice == choice;
  @override
  int get hashCode => choice.hashCode;
}

/// Several, and nothing says which: the agent picks.
final class AccountMustChoose extends AccountPick {
  const AccountMustChoose();
}

/// Signed in with a membership but no account to work in (an agent whose
/// account was deleted, or whose membership points nowhere yet).
final class AccountNone extends AccountPick {
  const AccountNone();
}

/// The pick rules, in order:
/// 1. no accounts → [AccountNone];
/// 2. [preferTenantId] (the workspace an invite was just accepted for): its
///    only account, or the last-used one if it is there, else the agent picks
///    within it;
/// 3. the last-used account on this device, if it is still listed;
/// 4. exactly one → it;
/// 5. otherwise the agent picks.
AccountPick pickAccount(List<AccountChoice> choices, {LastAccount? last, String? preferTenantId}) {
  if (choices.isEmpty) return const AccountNone();

  AccountChoice? lastIn(Iterable<AccountChoice> pool) {
    if (last == null) return null;
    for (final c in pool) {
      if (c.tenantId == last.tenantId && c.accountId == last.accountId) return c;
    }
    return null;
  }

  if (preferTenantId != null) {
    final inTenant = choices.where((c) => c.tenantId == preferTenantId).toList(growable: false);
    if (inTenant.length == 1) return AccountPicked(inTenant.single);
    if (inTenant.length > 1) {
      final remembered = lastIn(inTenant);
      return remembered == null ? const AccountMustChoose() : AccountPicked(remembered);
    }
  }

  final remembered = lastIn(choices);
  if (remembered != null) return AccountPicked(remembered);
  if (choices.length == 1) return AccountPicked(choices.single);
  return const AccountMustChoose();
}
