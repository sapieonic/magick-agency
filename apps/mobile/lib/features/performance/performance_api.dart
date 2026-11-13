import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_client.dart';
import '../../core/api/api_error.dart';
import '../../core/api/decode_body.dart';

/// The agent's own reads behind "My performance" (and the campaign names
/// "My calls" resolves ids with). All through [ApiClient].
class PerformanceApi {
  PerformanceApi(this._api);

  final ApiClient _api;

  /// `GET /proxy/agency/my-stats`: one call gives the tiles and the series.
  Future<AgentStats> myStats(AgentStatsQuery query) async {
    final body = await _api.get('/proxy/agency/my-stats', query: query.toQuery());
    return decodeBody('/proxy/agency/my-stats', body, AgentStats.fromJson);
  }

  /// `GET /proxy/agency/my-campaigns`: the staffing history, ended
  /// assignments included, so a campaign the agent has left still has a name.
  Future<StaffingHistory> myCampaigns() async {
    final body = await _api.get('/proxy/agency/my-campaigns');
    return decodeBody('/proxy/agency/my-campaigns', body, StaffingHistory.fromJson);
  }
}

final performanceApiProvider = Provider<PerformanceApi>((ref) => PerformanceApi(ref.watch(apiClientProvider)));

/// What a failure says to the agent: the server's own sentence where there
/// is one (these failures are mostly permission- or connectivity-shaped).
String errorMessage(Object error, String fallback) => error is ApiError ? error.userMessage : fallback;
