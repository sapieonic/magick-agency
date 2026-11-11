import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/api_client.dart';
import '../performance/performance_api.dart' show decodeBody;

/// The Missed inbound list's routes (`docs/inbound.md` §7, §8.4), all through
/// [ApiClient], so the bearer, the scope headers and the typed errors are the
/// app's own. The app's own list names `assignee=me` (`MissedFilters.toQuery`),
/// which the server forces anyway without `agency.supervise`; without it a
/// supervisor using the app would be shown the whole account's rows. The Team
/// view (IQ49) names `assignee=unassigned`, and its rows are claimed. The
/// count names `assignee=me` too (IQ57), so the badge counts what the list shows. None of these is behind
/// `agency_inbound_enabled` on the server (the kill switch leaves the
/// follow-ups to be worked).
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
  static String claimPath(String id) => '/proxy/agency/inbound/missed/${Uri.encodeComponent(id)}/claim';

  /// `GET /inbound/missed?status=&assignee=&reason=&cursor=&limit=`: a page, newest first.
  Future<InboundMissedPage> list(InboundMissedQuery query) async {
    final body = await _api.get(listPath, query: query.toQuery());
    return decodeBody(listPath, body, decodeInboundMissedPage);
  }

  /// `GET /inbound/missed/count?assignee=me`: the badge (the agent's own open
  /// rows, capped at 100) and whether they have any row at all, as the list
  /// shows them, a supervisor's too (IQ57). With [since], only the rows whose
  /// call arrived at or after it ("N customers rang while you were away", IQ50).
  Future<InboundMissedCountResponse> count({DateTime? since}) async {
    final query = InboundMissedCountQuery(assignee: InboundMissedQuery.assigneeMe, since: since);
    final body = await _api.get(countPath, query: query.toQuery());
    return decodeBody(countPath, body, InboundMissedCountResponse.fromJson);
  }

  /// `POST /inbound/missed/:id/claim` (IQ49): an unassigned row of the Team
  /// view becomes the agent's own. Idempotent for a row already theirs.
  /// Refused 409 `inbound_missed_call_claimed` (someone else has it),
  /// 409 `inbound_missed_call_handled`, 404 `inbound_missed_call_not_found`.
  Future<InboundMissedCall> claim(String id) async {
    final path = claimPath(id);
    final body = await _api.post(path);
    return decodeBody(path, body, InboundMissedCallResponse.fromJson).call;
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
