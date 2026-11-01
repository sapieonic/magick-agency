import 'package:flutter/foundation.dart';

/// Everything an API call can fail with. Callers switch on the subtype:
///
/// * [ApiHttpError]: the server answered with a 4xx/5xx; carries the
///   machine `code` (e.g. `session_on_other_campaign`, `not_staffed`) when the
///   body had one, and the whole decoded body for refusals that carry fields.
/// * [ApiNetworkError]: no answer (offline, DNS, TLS, timeout). Safe to retry
///   for idempotent reads; for writes the caller decides.
/// * [ApiUnauthorized]: 401 after one forced token refresh. The session is
///   over; the app gate signs the agent out (after a live call ends).
sealed class ApiError implements Exception {
  const ApiError();

  /// What to show an agent. Server messages are written for people
  /// (and 5xx bodies are masked server-side), so they are shown as-is.
  String get userMessage;
}

@immutable
final class ApiHttpError extends ApiError {
  const ApiHttpError({
    required this.status,
    required this.code,
    required this.message,
    required this.body,
    required this.requestId,
  });

  final int status;

  /// The body's `code`, else null. Never the HTTP reason phrase.
  final String? code;
  final String message;

  /// The decoded JSON body (empty when it was not an object).
  final Map<String, Object?> body;

  /// `x-request-id` echoed by the server; quoted in support conversations.
  final String? requestId;

  bool get isConflict => status == 409;
  bool get isServerError => status >= 500;

  @override
  String get userMessage {
    if (message.isNotEmpty) return message;
    if (isServerError) {
      return 'Something went wrong on our side. Try again'
          '${requestId == null ? '' : ' (ref ${requestId!.substring(0, requestId!.length.clamp(0, 8))})'}.';
    }
    return 'That didn\'t work. Try again.';
  }

  @override
  String toString() => 'ApiHttpError($status, $code, $message, request=$requestId)';
}

@immutable
final class ApiNetworkError extends ApiError {
  const ApiNetworkError(this.cause, {this.timedOut = false});

  final Object cause;
  final bool timedOut;

  @override
  String get userMessage => timedOut
      ? 'The server took too long to answer. Check your connection and try again.'
      : 'You\'re offline or the connection dropped. Check your connection and try again.';

  @override
  String toString() => 'ApiNetworkError(timedOut=$timedOut, $cause)';
}

@immutable
final class ApiUnauthorized extends ApiError {
  const ApiUnauthorized();

  @override
  String get userMessage => 'Your sign-in has expired. Please sign in again.';

  @override
  String toString() => 'ApiUnauthorized()';
}

/// The response decoded into something other than the expected shape. A
/// contract drift between server and app; logged loudly, shown generically.
@immutable
final class ApiDecodeError extends ApiError {
  const ApiDecodeError(this.path, this.cause);

  final String path;
  final Object cause;

  @override
  String get userMessage => 'The app couldn\'t read the server\'s answer. Update the app if an update is available.';

  @override
  String toString() => 'ApiDecodeError($path, $cause)';
}
