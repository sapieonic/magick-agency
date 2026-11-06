import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_client.dart';
import '../performance/performance_api.dart' show decodeBody;

/// Customer history's routes, both `POST`s through [ApiClient]: the number is
/// in the body, never in a path or a query (CH6), and the API client never
/// logs a body. The CSV export is the console's only.
///
/// Contract: `packages/contracts/src/api/agency/customer-history.ts`.
class CustomerHistoryApi {
  CustomerHistoryApi(this._api);

  final ApiClient _api;

  static const searchPath = '/proxy/agency/customers/search';
  static const timelinePath = '/proxy/agency/customers/timeline';

  /// `POST /customers/search`: the summary and the first timeline page.
  Future<CustomerSearchResponse> search(CustomerSearchRequest request) async {
    final body = await _api.post(searchPath, body: request.toJson());
    return decodeBody(searchPath, body, CustomerSearchResponse.fromJson);
  }

  /// `POST /customers/timeline`: a later page, or the first under new filters.
  Future<CustomerTimelinePage> timeline(CustomerTimelineRequest request) async {
    final body = await _api.post(timelinePath, body: request.toJson());
    return decodeBody(timelinePath, body, CustomerTimelinePage.fromJson);
  }
}

final customerHistoryApiProvider =
    Provider<CustomerHistoryApi>((ref) => CustomerHistoryApi(ref.watch(apiClientProvider)));
