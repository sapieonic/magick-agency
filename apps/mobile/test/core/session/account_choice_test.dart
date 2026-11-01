import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/session/account_choice.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';

void main() {
  const a1 = AccountChoice(tenantId: 't1', tenantName: 'Acme', accountId: 'a1', accountName: 'Chennai');
  const a2 = AccountChoice(tenantId: 't1', tenantName: 'Acme', accountId: 'a2', accountName: 'Pune');
  const b1 = AccountChoice(tenantId: 't2', tenantName: 'Bharat', accountId: 'b1', accountName: 'Mumbai');

  group('pickAccount', () {
    test('none → none', () => expect(pickAccount(const []), const AccountNone()));

    test('one → it, whatever was remembered', () {
      expect(pickAccount(const [a1]), const AccountPicked(a1));
      expect(pickAccount(const [a1], last: const LastAccount(tenantId: 't9', accountId: 'x')), const AccountPicked(a1));
    });

    test('several: the remembered one if still listed, else the agent chooses', () {
      expect(pickAccount(const [a1, a2], last: const LastAccount(tenantId: 't1', accountId: 'a2')), const AccountPicked(a2));
      expect(pickAccount(const [a1, a2]), const AccountMustChoose());
      expect(pickAccount(const [a1, a2], last: const LastAccount(tenantId: 't1', accountId: 'gone')), const AccountMustChoose());
    });

    test('the remembered id must match in the same tenant', () {
      expect(pickAccount(const [a1, b1], last: const LastAccount(tenantId: 't2', accountId: 'a1')), const AccountMustChoose());
    });

    test('a preferred workspace (just invited) wins over the remembered account', () {
      expect(
        pickAccount(const [a1, b1], last: const LastAccount(tenantId: 't1', accountId: 'a1'), preferTenantId: 't2'),
        const AccountPicked(b1),
      );
      // Several in the preferred workspace: the remembered one there, else choose.
      expect(
        pickAccount(const [a1, a2, b1], last: const LastAccount(tenantId: 't1', accountId: 'a2'), preferTenantId: 't1'),
        const AccountPicked(a2),
      );
      expect(pickAccount(const [a1, a2, b1], preferTenantId: 't1'), const AccountMustChoose());
      // A preferred workspace with no accounts falls back to the ordinary rules.
      expect(pickAccount(const [a1], preferTenantId: 't9'), const AccountPicked(a1));
    });
  });

  test('label: workspace · account, without repeating a name', () {
    expect(a1.label, 'Acme · Chennai');
    expect(const AccountChoice(tenantId: 't', tenantName: 'Acme', accountId: 'a', accountName: 'Acme').label, 'Acme');
    expect(const AccountChoice(tenantId: 't', tenantName: '', accountId: 'a', accountName: 'Pune').label, 'Pune');
  });

  group('SessionStore', () {
    test('round-trips the last account and clears it', () async {
      final store = SessionStore(MemoryStore());
      expect(await store.readLastAccount(), isNull);
      await store.writeLastAccount(const LastAccount(tenantId: 't1', accountId: 'a1'));
      expect(await store.readLastAccount(), const LastAccount(tenantId: 't1', accountId: 'a1'));
      await store.clearLastAccount();
      expect(await store.readLastAccount(), isNull);
    });

    test('a half-written pair reads as nothing', () async {
      final store = SessionStore(MemoryStore({SessionStore.tenantKey: 't1'}));
      expect(await store.readLastAccount(), isNull);
    });
  });
}
