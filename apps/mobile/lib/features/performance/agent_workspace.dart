// The key lives beside the gate it is derived from, so every per-workspace
// cache (campaigns, notification settings, calls, performance) shares it.
export '../../core/auth/app_gate.dart' show agentWorkspaceProvider;

/// The signed-in agent's user id, from the workspace key (`user:tenant:account`).
/// Ids are UUIDs, so the first segment is the whole id.
String? workspaceUserId(String? workspace) {
  if (workspace == null) return null;
  final id = workspace.split(':').first;
  return id.isEmpty ? null : id;
}
