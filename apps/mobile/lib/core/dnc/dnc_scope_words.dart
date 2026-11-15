import 'package:agency_wire/agency_wire.dart';

/// How far a Do Not Call entry reaches, in the same words everywhere it is shown (DS7),
/// as the console says it (`apps/console/src/utils/dncScopeWords.ts`):
///
///  - every campaign in the organisation: **Every campaign**
///  - one account's campaigns: **North account** (the account's name), or **This account**
///  - one campaign: **Campaign: Q4 Renewals**, or [unnamedCampaign] when the name is not known
///
/// The wire codes are never shown; an unknown scope (a newer server) is named as the
/// widest, so the app never under-states how far an entry reaches.
String dncScopeWords(
  DncEntryScope scope, {
  String? accountName,
  String? campaignName,
  String unnamedCampaign = 'A campaign that no longer exists',
}) {
  final account = accountName?.trim() ?? '';
  final campaign = campaignName?.trim() ?? '';
  return switch (scope) {
    DncEntryScope.tenant || DncEntryScope.unknown => 'Every campaign',
    DncEntryScope.account => account.isNotEmpty ? '$account account' : 'This account',
    DncEntryScope.campaign => campaign.isNotEmpty ? 'Campaign: $campaign' : unnamedCampaign,
  };
}
