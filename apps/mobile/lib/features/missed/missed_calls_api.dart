import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_client.dart';
import '../performance/performance_api.dart' show decodeBody;

/// The Missed inbound list's routes (`docs/inbound.md` §7, §8.4), all through
/// [ApiClient], so the bearer, the scope headers and the typed errors are the
/// app's own. An agent reads and marks only the rows assigned to them: the
/// server forces `assignee=me` without `agency.supervise`, so no request names
/// an assignee. None of these is behind `agency_inbound_enabled` on the server
/// (the kill switch leaves the follow-ups to be worked).
///
/// Contract: `packages/contracts/src/api/agency/inbound.ts`; the console's
/// `apps/console/src/api/inbound.ts`.
class MissedCallsApi {
  MissedCallsApi(this._api);

  final ApiClient _api;

  static const listPath = '/proxy/agency/inbound/missed';
  static const countPath = '/proxy/agency/inbound/missed/count';
  static String handledPath(String id) => '/proxy/agency/inbound/missed/${Uri.encodeComponent(id)}/handled';
  static String reopenPath(String id) => '/proxy/agency/inbound/missed/${Uri.encodeComponent(id)}/reopen';

  /// `GET /inbound/missed?status=&reason=&cursor=&limit=`: a page, newest first.
  Future<InboundMissedPage> list(InboundMissedQuery query) async {
    final body = await _api.get(listPath, query: query.toQuery());
    return decodeBody(listPath, body, decodeInboundMissedPage);
  }

  /// `GET /inbound/missed/count`: the badge (the agent's open rows, capped at
  /// 100) and whether they have any row at all.
  Future<InboundMissedCountResponse> count() async {
    final body = await _api.get(countPath);
    return decodeBody(countPath, body, InboundMissedCountResponse.fromJson);
  }

  /// `POST /inbound/missed/:id/handled`. Idempotent: a row already handled
  /// comes back as it is, with its first handler.
  Future<InboundMissedCall> markHandled(String id) async {
    final path = handledPath(id);
    final body = await _api.post(path);
    return decodeBody(path, body, InboundMissedCallResponse.fromJson).call;
  }

  /// `POST /inbound/missed/:id/reopen`: a handled row back on the list.
  /// Idempotent: an open row comes back as it is.
  Future<InboundMissedCall> reopen(String id) async {
    final path = reopenPath(id);
    final body = await _api.post(path);
    return decodeBody(path, body, InboundMissedCallResponse.fromJson).call;
  }
}

final missedCallsApiProvider = Provider<MissedCallsApi>((ref) => MissedCallsApi(ref.watch(apiClientProvider)));
