import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../api/api_error.dart';
import '../auth/app_gate.dart';
import '../lifecycle/app_lifecycle.dart';

/// `GET /feature-flags`: the client-exposed flags resolved for the signed-in
/// agent's tenant and account, read once per workspace
/// ([agentWorkspaceProvider] key), so another account or another agent gets
/// its own map, never the previous one's.
///
/// As the console's `FeatureFlagsContext`: **fail closed**. While the map is
/// loading or after it failed, every flag reads off, so a gated surface never
/// flickers on. The flags gate a SURFACE only (what the app shows); the
/// station core never reads them.
///
/// A map that was read stays for the workspace. A failed read does not: it is
/// read again on the next return to the app, or when the agent pulls the
/// campaign list to refresh ([rereadFeatureFlagsIfFailed]), so one failure at
/// a cold start does not hide a surface for the rest of the session. There is
/// no automatic retry in between: offline, the flags simply stay off.
final featureFlagsProvider = FutureProvider.family<FeatureFlags, String>((ref, workspace) async {
  const path = '/feature-flags';
  try {
    final body = await ref.read(apiClientProvider).get(path);
    if (body is! Map<String, Object?>) throw const ApiDecodeError(path, FormatException('expected an object'));
    try {
      return FeatureFlags.fromJson(body);
    } on FormatException catch (e) {
      throw ApiDecodeError(path, e);
    }
  } catch (e) {
    reportToGate(ref, e);
    // Its own listener, gone with this failed state (a read again, or the workspace's end).
    final lifecycle = ref.read(featureFlagsLifecycleProvider)();
    lifecycle.attach(onHide: () {}, onShow: ref.invalidateSelf);
    ref.onDispose(lifecycle.detach);
    rethrow;
  }
}, retry: (_, _) => null);

/// A fresh app-lifecycle source for each failed flag read: one source holds
/// one listener, and the station's and the soft phone's have their own.
final featureFlagsLifecycleProvider = Provider<AppLifecycleSource Function()>((ref) => FlutterAppLifecycleSource.new);

/// Reads [workspace]'s flag map again when the last read failed (and none is
/// in flight); a map that was read is kept.
void rereadFeatureFlagsIfFailed(WidgetRef ref, String workspace) {
  final flags = ref.read(featureFlagsProvider(workspace));
  if (flags.hasError && !flags.isLoading) ref.invalidate(featureFlagsProvider(workspace));
}

/// Whether [key] is on for the current workspace: false with nobody signed in
/// to an account, while the map loads, and when it could not be read.
final featureFlagProvider = Provider.family<bool, String>((ref, key) {
  final workspace = ref.watch(agentWorkspaceProvider);
  if (workspace == null) return false;
  return ref.watch(featureFlagsProvider(workspace)).value?.isOn(key) ?? false;
});

/// Contact assignment's agent surface: My contacts, retry not reached, and
/// the per-contact call. The station's "Nothing due now" is NOT behind it:
/// pacing reads the campaign's stored mode whatever the flag says.
final contactAssignmentEnabledProvider = Provider<bool>(
  (ref) => ref.watch(featureFlagProvider(FeatureFlags.contactAssignmentEnabled)),
);
