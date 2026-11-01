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
      fields.isEmpty ? const {} : {for (final e in fields.entries) e.key: maskField(e.value)},
    );
    if (_ring.length == _capacity) _ring.removeFirst();
    _ring.addLast(record);
    if (kDebugMode) debugPrint(record.toString());
  }

  /// A field value as it may be stored: strings masked; any other object as
  /// its masked `toString` (an int can be a phone number, an exception's text
  /// can quote one). Null, booleans and numbers that mask to themselves keep
  /// their type.
  @visibleForTesting
  static Object? maskField(Object? value) {
    if (value == null || value is bool) return value;
    if (value is String) return mask(value);
    final text = value.toString();
    final masked = mask(text);
    return value is num && masked == text ? value : masked;
  }

  // A phone number in the ways people and systems write one: digit groups
  // joined by single separators (space, `-`, `.`, brackets), optionally led by
  // `+`: `+91 98400 12345`, `+91-98400-12345`, `098400-12345`,
  // `+1 (415) 555-0100`. The span must stand alone (not glued to a word, a
  // decimal point or a time's colon), so hex ids, UUIDs, ISO dates and times,
  // versions and durations survive. Whether it is a phone is decided by its
  // digit count in [mask].
  static final _phone = RegExp(
    r'(?<![\w+.:-])(\+ ?)?\(?\d+(?:(?:[ .-]|\) ?|[ .-]?\()\d+)*\)?(?![\w:])',
  );
  static final _decimal = RegExp(r'^\d+\.\d+$');
  static final _ipv4 = RegExp(r'^\d{1,3}(?:\.\d{1,3}){3}$');
  static final _email = RegExp(r'[\w.+-]+@[\w-]+\.[\w.-]+');

  /// Masks phone numbers (keeping the last two digits) and emails.
  ///
  /// A phone is 10 to 15 digits, or 8 to 15 after a `+`; an unbroken run of
  /// 10 or more digits is masked whatever its length.
  static String mask(String input) => input
      .replaceAllMapped(_email, (_) => '<email>')
      .replaceAllMapped(_phone, (m) {
        final span = m[0]!;
        // A decimal or an IPv4 address, not a phone.
        if (_decimal.hasMatch(span) || _ipv4.hasMatch(span)) return span;
        final digits = span.replaceAll(RegExp(r'\D'), '');
        final unbroken = RegExp(r'^\d+$').hasMatch(span);
        final plus = m[1] != null;
        final isPhone = (unbroken && digits.length >= 10) ||
            (digits.length <= 15 && digits.length >= (plus ? 8 : 10));
        return isPhone ? '<tel …${digits.substring(digits.length - 2)}>' : span;
      });
}
