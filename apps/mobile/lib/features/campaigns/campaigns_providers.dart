import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';

/// `GET /proxy/agency/my-assignments` for the current account. Watches the
/// account, so a switch or sign-out drops the list; no automatic retry (the
/// screen offers one, and pull-to-refresh).
final myAssignmentsProvider = FutureProvider<List<Assignment>>(
  (ref) async {
    final account = ref.watch(readyAccountProvider);
    if (account == null) return const [];
    const path = '/proxy/agency/my-assignments';
    try {
      final body = await ref.read(apiClientProvider).get(path);
      if (body is! Map<String, Object?>) throw const ApiDecodeError(path, FormatException('expected an object'));
      try {
        return MyAssignments.fromJson(body).assignments;
      } on FormatException catch (e) {
        throw ApiDecodeError(path, e);
      }
    } on ApiUnauthorized catch (e) {
      final gate = ref.read(appGateProvider.notifier);
      unawaited(Future.microtask(() => gate.reportError(e)));
      rethrow;
    }
  },
  retry: (_, _) => null,
);
