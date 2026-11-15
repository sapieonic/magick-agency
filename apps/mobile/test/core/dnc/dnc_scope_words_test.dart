import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/dnc/dnc_scope_words.dart';
import 'package:magick_agency_agent/features/customers/customer_history_copy.dart';

/// The words a DNC entry's scope is named by (DS7), as the console says them
/// (`apps/console/src/__tests__/utils/dncScopeWords.test.ts`).
void main() {
  test('names each scope in the console’s words, never with its wire code', () {
    expect(dncScopeWords(DncEntryScope.tenant), 'Every campaign');
    expect(dncScopeWords(DncEntryScope.account, accountName: 'North'), 'North account');
    expect(dncScopeWords(DncEntryScope.account), 'This account');
    expect(dncScopeWords(DncEntryScope.campaign, campaignName: 'Q4 Renewals'), 'Campaign: Q4 Renewals');
    expect(dncScopeWords(DncEntryScope.campaign), 'A campaign that no longer exists');
    expect(dncScopeWords(DncEntryScope.campaign, unnamedCampaign: 'One of this account’s campaigns'),
        'One of this account’s campaigns');
  });

  test('a scope a newer server sends is named as the widest, never narrower', () {
    expect(dncScopeWords(DncEntryScope.unknown), 'Every campaign');
  });

  test('customer history names entries in the same words, a campaign with its account', () {
    CustomerHistoryDncEntry entry(String scope, {String? account, String? campaign}) => CustomerHistoryDncEntry.fromJson({
          'id': 'd1',
          'scope': scope,
          'account_id': account == null ? null : 'a1',
          'account_name': account,
          'campaign': campaign == null ? null : {'id': 'c1', 'name': campaign},
          'source': 'agent',
          'reason': null,
          'added_by': null,
          'created_at': '2026-11-01T10:00:00Z',
        });
    expect(dncScopeLabel(entry('tenant')), 'Every campaign');
    expect(dncScopeLabel(entry('account', account: 'North')), 'North account');
    expect(dncScopeLabel(entry('account')), 'An account');
    expect(dncScopeLabel(entry('campaign', account: 'North', campaign: 'Q4 Renewals')), 'Campaign: Q4 Renewals (North)');
    // A scope a newer server sends: the widest words, never its wire code.
    expect(dncScopeLabel(entry('region')), 'Every campaign');
  });
}
