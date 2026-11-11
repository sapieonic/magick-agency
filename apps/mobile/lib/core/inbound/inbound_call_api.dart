import 'package:agency_wire/agency_wire.dart';
import 'package:meta/meta.dart';

import '../api/api_client.dart';
import '../api/api_error.dart';

/// The agent's inbound call routes (`docs/inbound.md` §6), a port of the console's
/// `api/inbound.ts` call half:
///
/// ```text
/// GET    /proxy/agency/inbound/calls/:id               → { call }
/// PATCH  /proxy/agency/inbound/calls/:id               → { call }   (notes autosave)
/// POST   /proxy/agency/inbound/calls/:id/hangup        → { call }
/// POST   /proxy/agency/inbound/calls/:id/disposition   → InboundCallDispositionResponse
/// POST   /proxy/agency/inbound/calls/:id/dnc           → InboundCallDncResponse
/// ```
///
/// Every path is built by [InboundPaths]. None of these is behind the inbound flag: an agent
/// can always finish a call (the soft phone's rule).
///
/// Every method resolves to an [InboundResult], never throws: a refusal is something the
/// station acts on (retire the call, rebuild the pad, say why), so it is a value it switches on,
/// with its code typed ([InboundRefusal.code]). An expired sign-in is told to [_onUnauthorized]
/// first (the app gate decides when to sign out) and then comes back as a refusal too.
final class InboundCallApi {
  InboundCallApi(this._client, {this._onUnauthorized});

  final ApiClient _client;
  final void Function(ApiUnauthorized error)? _onUnauthorized;

  Future<InboundResult<InboundCall>> getCall(String callId) =>
      _result(InboundPaths.call(callId), () => _client.get(InboundPaths.call(callId)), _call);

  /// [notes]: the whole text; `''` clears it. Last write wins, while unsettled.
  Future<InboundResult<InboundCall>> updateNotes(String callId, String notes) => _result(
        InboundPaths.call(callId),
        () => _client.patch(InboundPaths.call(callId), body: InboundCallUpdateRequest(notes: notes).toJson()),
        _call,
      );

  /// The answer is the call as read when the hang-up was issued and may still say `connected`:
  /// the `inbound_call` frame is the authority for "the call is over".
  Future<InboundResult<InboundCall>> hangup(String callId) => _result(
        InboundPaths.callHangup(callId),
        () => _client.post(InboundPaths.callHangup(callId), body: const <String, Object?>{}),
        _call,
      );

  Future<InboundResult<InboundCallDispositionResponse>> disposition(
    String callId,
    InboundCallDispositionRequest request,
  ) =>
      _result(
        InboundPaths.callDisposition(callId),
        () => _client.post(InboundPaths.callDisposition(callId), body: request.toJson()),
        InboundCallDispositionResponse.fromJson,
      );

  /// The scope is the server's: the matched campaign's, else the account's.
  Future<InboundResult<InboundCallDncResponse>> markDnc(String callId, {String? reason}) {
    final trimmed = reason?.trim();
    return _result(
      InboundPaths.callDnc(callId),
      () => _client.post(
        InboundPaths.callDnc(callId),
        body: InboundCallDncRequest(reason: trimmed == null || trimmed.isEmpty ? null : trimmed).toJson(),
      ),
      InboundCallDncResponse.fromJson,
    );
  }

  static InboundCall _call(Map<String, Object?> j) => InboundCallResponse.fromJson(j).call;

  Future<InboundResult<T>> _result<T>(
    String path,
    Future<Object?> Function() send,
    T Function(Map<String, Object?>) decode,
  ) async {
    final Object? body;
    try {
      body = await send();
    } on ApiUnauthorized catch (e) {
      _onUnauthorized?.call(e);
      return InboundRefused(InboundRefusal.of(e));
    } on ApiError catch (e) {
      return InboundRefused(InboundRefusal.of(e));
    }
    if (body is! Map<String, Object?>) {
      return InboundRefused(InboundRefusal.of(ApiDecodeError(path, 'expected an object')));
    }
    try {
      return InboundOk(decode(body));
    } on FormatException catch (e) {
      return InboundRefused(InboundRefusal.of(ApiDecodeError(path, e)));
    } on TypeError catch (e) {
      return InboundRefused(InboundRefusal.of(ApiDecodeError(path, e)));
    }
  }
}

/// Every inbound call path, in one place (the console's `INBOUND_PATHS`).
abstract final class InboundPaths {
  static const base = '/proxy/agency/inbound';
  static String call(String callId) => '$base/calls/${Uri.encodeComponent(callId)}';
  static String callHangup(String callId) => '${call(callId)}/hangup';
  static String callDisposition(String callId) => '${call(callId)}/disposition';
  static String callDnc(String callId) => '${call(callId)}/dnc';
}

/// What an inbound call route answered.
@immutable
sealed class InboundResult<T> {
  const InboundResult();
}

final class InboundOk<T> extends InboundResult<T> {
  const InboundOk(this.value);
  final T value;
}

final class InboundRefused<T> extends InboundResult<T> {
  const InboundRefused(this.refusal);
  final InboundRefusal refusal;
}

/// A refusal, typed (the console's `InboundRefusal`).
@immutable
final class InboundRefusal {
  const InboundRefusal({
    required this.code,
    required this.message,
    required this.error,
    this.status,
    this.allowedCodes,
    this.rule,
    this.inboundCallId,
  });

  /// Reads [error] (anything the API client throws).
  factory InboundRefusal.of(ApiError error) {
    if (error is! ApiHttpError) {
      return InboundRefusal(code: InboundErrorCode.unknown, message: error.userMessage, error: error);
    }
    final body = ErrorBody.fromJson(error.body);
    final invalid = body.inboundDispositionInvalid;
    final callId = body.raw['inbound_call_id'];
    final message = body.message.trim();
    return InboundRefusal(
      code: body.inboundCode,
      status: error.status,
      message: message.isEmpty ? error.userMessage : message,
      error: error,
      allowedCodes: invalid?.allowedCodes,
      rule: invalid == null || invalid.rule == InboundDispositionRule.unknown ? null : invalid.rule,
      inboundCallId: callId is String ? callId : null,
    );
  }

  /// A contract code, or [InboundErrorCode.unknown] (a network failure, a masked 5xx, an RBAC
  /// 403, an answer the app could not read).
  final InboundErrorCode code;

  /// The HTTP status, or null when the server was not reached.
  final int? status;

  /// The server's sentence (or the API layer's words): the floor when the app has no better copy.
  final String message;

  /// What the API client threw, for logs and the autosave's retry rule.
  final ApiError error;

  /// `inbound_disposition_invalid` (`unknown_code`): the codes the call's catalog accepts.
  final List<String>? allowedCodes;

  /// `inbound_disposition_invalid`: which rule refused, when the server named one this build knows.
  final InboundDispositionRule? rule;

  /// The call refused for (`inbound_call_live` and the call routes' refusals).
  final String? inboundCallId;

  /// Not an answer the server gave about the call: no network, a timeout, a 5xx, a 429, an
  /// answer the app could not read. Says nothing about the call either way, so it is worth
  /// asking again.
  bool get transient =>
      error is ApiNetworkError ||
      error is ApiDecodeError ||
      (error is ApiHttpError && ((error as ApiHttpError).isServerError || status == 429));

  /// The server no longer holds the call for this agent, or its outcome is already closed:
  /// asking again cannot change the answer.
  bool get callGone =>
      code == InboundErrorCode.inboundCallNotFound || code == InboundErrorCode.inboundOutcomeAlreadySaved;
}
