import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'logic/readouts.dart';
import 'performance_api.dart';

/// Campaign id → name from the agent's staffing history, shared by "My
/// performance" (scope menu, breakdown) and "My calls" (row campaign, the
/// campaign filter). `by_campaign[]` and attempt rows carry ids only.
///
/// No automatic retry: a failed read leaves ids shortened ("Campaign
/// 4f21ab90"), which still reads, and pull-to-refresh re-reads it.
final myCampaignsProvider = FutureProvider<StaffingHistory>(
  (ref) => ref.watch(performanceApiProvider).myCampaigns(),
  retry: (_, _) => null,
);

/// The names, or an empty map while loading or after a failure.
final campaignNamesProvider = Provider<Map<String, String?>>((ref) {
  final history = ref.watch(myCampaignsProvider).value;
  return history == null ? const {} : Map.unmodifiable(campaignNameMap(history.assignments));
});
