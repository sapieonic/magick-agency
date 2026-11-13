import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_client.dart';
import '../../core/api/decode_body.dart';

/// The agent's own-contact routes (contact assignment), all through
/// [ApiClient]. The subject is always the signed-in agent: no request names one.
///
/// Contract: `packages/contracts/src/api/agency/assignment.ts`.
class MyContactsApi {
  MyContactsApi(this._api);

  final ApiClient _api;

  static const summaryPath = '/proxy/agency/my-contacts/summary';
  static const listPath = '/proxy/agency/my-contacts';
  static const retryPath = '/proxy/agency/my-contacts/retry';
  static String callPath(String contactId) => '/proxy/agency/my-contacts/${Uri.encodeComponent(contactId)}/call';

  /// `GET /my-contacts/summary?campaign_id=`.
  Future<MyContactsSummary> summary(String campaignId) async {
    final body = await _api.get(summaryPath, query: {'campaign_id': campaignId});
    return decodeBody(summaryPath, body, MyContactsSummary.fromJson);
  }

  /// `GET /my-contacts?campaign_id=&bucket=&phone=&cursor=&limit=`.
  Future<MyContactsPage> list(MyContactsQuery query) async {
    final body = await _api.get(listPath, query: query.toQuery());
    return decodeBody(listPath, body, decodeMyContactsPage);
  }

  /// `POST /my-contacts/retry`: reopen not-reached contacts into the agent's queue.
  Future<AgentRetryResponse> retry(AgentRetryRequest request) async {
    final body = await _api.post(retryPath, body: request.toJson());
    return decodeBody(retryPath, body, AgentRetryResponse.fromJson);
  }

  /// `POST /my-contacts/:contactId/call`: dial one contact now, from the station session.
  Future<MyContactCallResponse> call(String contactId, MyContactCallRequest request) async {
    final path = callPath(contactId);
    final body = await _api.post(path, body: request.toJson());
    return decodeBody(path, body, MyContactCallResponse.fromJson);
  }
}

final myContactsApiProvider = Provider<MyContactsApi>((ref) => MyContactsApi(ref.watch(apiClientProvider)));
