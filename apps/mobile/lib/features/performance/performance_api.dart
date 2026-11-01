import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_error.dart';

/// The agent's own reads behind "My performance" (and the campaign names
/// "My calls" resolves ids with). All through [ApiClient].
class PerformanceApi {
  PerformanceApi(this._api);

  final ApiClient _api;

  /// `tenant:account`, so cached results never cross a workspace switch.
  String get workspaceKey => '${_api.scope.tenantId ?? ''}:${_api.scope.accountId ?? ''}';

  /// `GET /proxy/agency/my-stats`: one call gives the tiles and the series.
  Future<AgentStats> myStats(AgentStatsQuery query) async {
    final body = await _api.get('/proxy/agency/my-stats', query: query.toQuery());
    return _decode('/proxy/agency/my-stats', body, AgentStats.fromJson);
  }

  /// `GET /proxy/agency/my-campaigns`: the staffing history, ended
  /// assignments included, so a campaign the agent has left still has a name.
  Future<StaffingHistory> myCampaigns() async {
    final body = await _api.get('/proxy/agency/my-campaigns');
    return _decode('/proxy/agency/my-campaigns', body, StaffingHistory.fromJson);
  }
}

/// A body that is not the contract's shape is an [ApiDecodeError], not a
/// crash on the UI isolate.
T decodeBody<T>(String path, Object? body, T Function(Map<String, Object?>) decode) => _decode(path, body, decode);

T _decode<T>(String path, Object? body, T Function(Map<String, Object?>) decode) {
  if (body is! Map<String, Object?>) throw ApiDecodeError(path, 'expected a JSON object');
  try {
    return decode(body);
  } on WireFormatException catch (e) {
    throw ApiDecodeError(path, e);
  } on TypeError catch (e) {
    throw ApiDecodeError(path, e);
  }
}

final performanceApiProvider = Provider<PerformanceApi>((ref) => PerformanceApi(ref.watch(apiClientProvider)));

/// What a failure says to the agent: the server's own sentence where there
/// is one (these failures are mostly permission- or connectivity-shaped).
String errorMessage(Object error, String fallback) => error is ApiError ? error.userMessage : fallback;
