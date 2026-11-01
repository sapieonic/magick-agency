import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';

/// `GET /proxy/agency/my-assignments`, per workspace ([agentWorkspaceProvider]
/// key): another account or another agent gets a fresh entry, never the
/// previous one's list. No automatic retry (the screen offers one, and
/// pull-to-refresh).
final myAssignmentsProvider = FutureProvider.autoDispose.family<List<Assignment>, String>(
  (ref, workspace) async {
    const path = '/proxy/agency/my-assignments';
    try {
      final body = await ref.read(apiClientProvider).get(path);
      if (body is! Map<String, Object?>) throw const ApiDecodeError(path, FormatException('expected an object'));
      try {
        return MyAssignments.fromJson(body).assignments;
      } on FormatException catch (e) {
        throw ApiDecodeError(path, e);
      }
    } catch (e) {
      reportToGate(ref, e);
      rethrow;
    }
  },
  retry: (_, _) => null,
);
