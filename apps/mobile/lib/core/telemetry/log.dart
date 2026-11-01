import 'dart:collection';

import 'package:flutter/foundation.dart';

enum LogLevel { debug, info, warn, error }

/// One log line, already masked.
@immutable
class LogRecord {
  const LogRecord(this.time, this.level, this.tag, this.message, this.fields);

  final DateTime time;
  final LogLevel level;
  final String tag;
  final String message;
  final Map<String, Object?> fields;

  @override
  String toString() {
    final f = fields.isEmpty ? '' : ' ${fields.entries.map((e) => '${e.key}=${e.value}').join(' ')}';
    return '${time.toIso8601String()} ${level.name.toUpperCase()} [$tag] $message$f';
  }
}

/// A small structured logger with the server's PII rule: phone numbers and
/// email addresses never reach a log line, whatever the caller passed.
///
/// Lines go to a bounded in-memory ring (the diagnostics screen exports it)
/// and, in debug builds, to the console. Nothing is written to disk.
class Log {
  Log(this.tag);

  final String tag;

  static const _capacity = 2000;
  static final ListQueue<LogRecord> _ring = ListQueue<LogRecord>(_capacity);

  /// Extra sinks (crash reporting breadcrumbs). Errors in a sink are swallowed.
  static final List<void Function(LogRecord)> sinks = [];

  static LogLevel minLevel = kDebugMode ? LogLevel.debug : LogLevel.info;

  /// The most recent lines, oldest first.
  static List<LogRecord> recent() => List.unmodifiable(_ring);

  @visibleForTesting
  static void clear() => _ring.clear();

  void debug(String message, [Map<String, Object?> fields = const {}]) => _emit(LogLevel.debug, message, fields);
  void info(String message, [Map<String, Object?> fields = const {}]) => _emit(LogLevel.info, message, fields);
  void warn(String message, [Map<String, Object?> fields = const {}]) => _emit(LogLevel.warn, message, fields);
  void error(String message, [Map<String, Object?> fields = const {}, Object? error, StackTrace? stack]) {
    _emit(LogLevel.error, error == null ? message : '$message: ${mask(error.toString())}', fields);
    if (stack != null && kDebugMode) debugPrintStack(stackTrace: stack, maxFrames: 12);
  }

  void _emit(LogLevel level, String message, Map<String, Object?> fields) {
    if (level.index < minLevel.index) return;
    final record = LogRecord(
      DateTime.now(),
      level,
      tag,
      mask(message),
      fields.isEmpty ? const {} : {for (final e in fields.entries) e.key: e.value is String ? mask(e.value! as String) : e.value},
    );
    if (_ring.length == _capacity) _ring.removeFirst();
    _ring.addLast(record);
    if (kDebugMode) debugPrint(record.toString());
    for (final sink in sinks) {
      try {
        sink(record);
      } catch (_) {}
    }
  }

  // E.164-ish (`+` then 8+ digits, single spaces allowed: `+91 98400 12345`)
  // or a bare run of 10+ digits that is not part of a longer token (so hex
  // request ids, ISO dates and durations survive). Keeps the last 2 digits.
  static final _phone = RegExp(r'\+\d(?: ?\d){7,}|(?<![\w-])\d{10,}(?![\w-])');
  static final _email = RegExp(r'[\w.+-]+@[\w-]+\.[\w.-]+');

  /// Masks phone numbers (keeping the last two digits) and emails.
  static String mask(String input) => input
      .replaceAllMapped(_email, (_) => '<email>')
      .replaceAllMapped(_phone, (m) {
        final digits = m[0]!.replaceAll(RegExp(r'\D'), '');
        if (digits.length < 7) return m[0]!;
        return '<tel …${digits.substring(digits.length - 2)}>';
      });
}
