import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'agent_workspace.dart';
import 'logic/readouts.dart';
import 'performance_api.dart';

/// Campaign id → name from the agent's staffing history, shared by "My
/// performance" (scope menu, breakdown) and "My calls" (row campaign, the
/// campaign filter). `by_campaign[]` and attempt rows carry ids only.
///
/// One entry per [agentWorkspaceProvider] key, disposed once nothing watches
/// it, so another account's (or another agent's) campaigns are never shown,
/// not even while the new list loads.
///
/// No automatic retry: a failed read leaves ids shortened ("Campaign
/// 4f21ab90"), which still reads, and pull-to-refresh re-reads it.
final myCampaignsProvider = FutureProvider.autoDispose.family<StaffingHistory, String>(
  (ref, workspace) => ref.watch(performanceApiProvider).myCampaigns(),
  retry: (_, _) => null,
);

/// The names, or an empty map while loading, after a failure, or signed out.
final campaignNamesProvider = Provider<Map<String, String?>>((ref) {
  final workspace = ref.watch(agentWorkspaceProvider);
  if (workspace == null) return const {};
  final history = ref.watch(myCampaignsProvider(workspace)).value;
  return history == null ? const {} : Map.unmodifiable(campaignNameMap(history.assignments));
});
