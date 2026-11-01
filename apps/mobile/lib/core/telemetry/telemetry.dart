import 'package:flutter/foundation.dart';

import 'log.dart';

/// Where telemetry goes: PostHog in a build with a key (`posthog_sink.dart`).
/// Everything handed to a sink is already masked.
abstract interface class TelemetrySink {
  void capture(String event, Map<String, Object> properties);
  void captureException(Object error, StackTrace? stack, Map<String, Object> properties);

  /// Later events are this user's.
  void identify(String userId);

  /// Properties every later event carries.
  void register(Map<String, Object> properties);

  /// Later events belong to this [type] group (`tenant`, `account`), as the
  /// console's do.
  void group(String type, String key);

  /// Signed out: later events are a new anonymous user's, without the
  /// registered properties.
  void reset();
}

/// Product analytics and failure reporting: what went wrong on a tester's
/// phone, read in PostHog, without the tester sending their logs in.
///
/// Off (every call a no-op) until [install]; a build without `POSTHOG_KEY`
/// never installs it. [Log]'s PII rule holds: every string is masked with
/// [Log.mask] before it reaches the sink, and no event names a person or a
/// number. The user is their server id; the tenant and account are ids.
///
/// Every warning and error [Log] keeps is reported too: one logged with an
/// exception as that exception (masked, with its stack), the rest as
/// `agency_app_warning` / `agency_app_error` events. Each message is capped at
/// [linesPerMessage] a minute, and all of them at [linesPerMinute], so one
/// stuck loop cannot flood the project; the first line admitted after a cap
/// says how many were dropped.
abstract final class Telemetry {
  static TelemetrySink? _sink;
  static DateTime Function() _now = DateTime.now;

  static const linesPerMessage = 5;
  static const linesPerMinute = 60;
  static const _window = Duration(minutes: 1);

  /// The longest a logged message is sent as (an error's text can run long).
  static const maxMessageLength = 300;

  static final Map<String, _Window> _perMessage = {};
  static _Window? _all;

  /// Starts reporting to [sink], and every warning and error [Log] keeps with it.
  static void install(TelemetrySink sink, {DateTime Function()? now}) {
    _sink = sink;
    _now = now ?? DateTime.now;
    _perMessage.clear();
    _all = null;
    Log.forward = _logged;
  }

  @visibleForTesting
  static void uninstall() {
    _sink = null;
    _now = DateTime.now;
    _perMessage.clear();
    _all = null;
    Log.forward = null;
  }

  static bool get installed => _sink != null;

  static void event(String name, [Map<String, Object?> properties = const {}]) {
    final sink = _sink;
    if (sink == null) return;
    _guard(() => sink.capture(name, _clean(properties)));
  }

  /// [error] with its text masked and its type kept ([MaskedError]).
  static void exception(Object error, StackTrace? stack, {required String source, Map<String, Object?> properties = const {}}) {
    final sink = _sink;
    if (sink == null) return;
    _guard(() => sink.captureException(MaskedError(error), stack, _clean({...properties, 'source': source})));
  }

  static void identify(String userId) {
    final sink = _sink;
    if (sink == null) return;
    _guard(() => sink.identify(userId));
  }

  static void register(Map<String, Object?> properties) {
    final sink = _sink;
    if (sink == null) return;
    _guard(() => sink.register(_clean(properties)));
  }

  static void group(String type, String key) {
    final sink = _sink;
    if (sink == null) return;
    _guard(() => sink.group(type, key));
  }

  static void reset() {
    final sink = _sink;
    if (sink == null) return;
    _guard(sink.reset);
  }

  static void _logged(LogRecord record, Object? error, StackTrace? stack) {
    final dropped = _admit('${record.tag}|${record.message}');
    if (dropped == null) return;
    final message = record.message.length > maxMessageLength
        ? '${record.message.substring(0, maxMessageLength)}…'
        : record.message;
    final properties = <String, Object?>{
      ...record.fields,
      'tag': record.tag,
      'message': message,
      if (dropped > 0) 'repeats_dropped': dropped,
    };
    if (error != null) {
      exception(error, stack, source: record.tag, properties: properties);
    } else {
      event(record.level == LogLevel.error ? 'agency_app_error' : 'agency_app_warning', properties);
    }
  }

  /// Null when the line is over a cap; else how many lines of this message
  /// the cap dropped since the last one admitted.
  static int? _admit(String key) {
    final now = _now();
    final all = _all = _Window.roll(_all, now);
    final mine = _perMessage[key] = _Window.roll(_perMessage[key], now);
    if (mine.count >= linesPerMessage || all.count >= linesPerMinute) {
      mine.dropped++;
      return null;
    }
    // Message keys are few (each is a call site), but a masked error's text
    // can vary: forget windows long over rather than keep every one.
    if (_perMessage.length > 500) _perMessage.removeWhere((_, w) => now.difference(w.start) >= _window);
    mine.count++;
    all.count++;
    final dropped = mine.dropped;
    mine.dropped = 0;
    return dropped;
  }

  static Map<String, Object> _clean(Map<String, Object?> properties) => {
        for (final e in properties.entries)
          if (Log.maskField(e.value) case final Object v) e.key: v is num || v is bool ? v : v.toString(),
      };

  /// A failing sink never fails the app.
  static void _guard(void Function() report) {
    try {
      report();
    } catch (e) {
      if (kDebugMode) debugPrint('telemetry: $e');
    }
  }
}

final class _Window {
  _Window(this.start);

  final DateTime start;
  int count = 0;

  /// Lines over the cap since the last one admitted; carried across windows.
  int dropped = 0;

  static _Window roll(_Window? current, DateTime now) {
    if (current != null && now.difference(current.start) < Telemetry._window) return current;
    return _Window(now)..dropped = current?.dropped ?? 0;
  }
}

/// An error as it may leave the phone: its text masked ([Log.mask]) and its
/// type kept, so PostHog still names and groups it by the real exception type.
@visibleForTesting
final class MaskedError {
  MaskedError(Object error)
      : _type = error.runtimeType,
        _text = Log.mask(error.toString());

  final Type _type;
  final String _text;

  @override
  Type get runtimeType => _type;

  @override
  String toString() => _text;
}
