// Readers for decoded JSON objects. Internal: the barrel exports only
// [WireFormatException].
//
// Every reader checks the runtime type itself rather than casting, so a
// mistyped field is a [WireFormatException] naming the key, never a TypeError
// from deep inside a constructor.

/// An HTTP body or station frame did not have the shape its contract declares.
///
/// Thrown by the `fromJson` constructors. The station decoder catches it and
/// answers an `UnknownFrame` instead.
final class WireFormatException extends FormatException {
  const WireFormatException(super.message, [this.key]);

  /// The JSON key that failed, when one did.
  final String? key;

  @override
  String toString() => key == null ? 'WireFormatException: $message' : 'WireFormatException($key): $message';
}

WireFormatException _bad(String key, String want, Object? got) =>
    WireFormatException(got == null ? 'missing $want' : 'expected $want, got ${got.runtimeType}', key);

/// [value] as a JSON object, or a [WireFormatException] naming [what].
Map<String, Object?> asJsonMap(Object? value, [String what = 'body']) {
  if (value is Map<String, Object?>) return value;
  throw _bad(what, 'object', value);
}

int? _int(Object? v) {
  if (v is int) return v;
  // A JSON number with a fractional part of zero (`10.0`) is still a count.
  if (v is double && v.isFinite && v == v.truncateToDouble()) return v.toInt();
  return null;
}

DateTime? _time(String s) => DateTime.tryParse(s)?.toUtc();

extension WireRead on Map<String, Object?> {
  String str(String k) {
    final v = this[k];
    if (v is String) return v;
    throw _bad(k, 'string', v);
  }

  String? strOrNull(String k) {
    final v = this[k];
    if (v == null || v is String) return v as String?;
    throw _bad(k, 'string or null', v);
  }

  int integer(String k) => _int(this[k]) ?? (throw _bad(k, 'integer', this[k]));

  int? integerOrNull(String k) {
    final v = this[k];
    if (v == null) return null;
    return _int(v) ?? (throw _bad(k, 'integer or null', v));
  }

  /// Epoch milliseconds: any JSON number, truncated.
  int epochMs(String k) {
    final v = this[k];
    if (v is num && v.isFinite) return v.toInt();
    throw _bad(k, 'number', v);
  }

  int? epochMsOrNull(String k) {
    final v = this[k];
    if (v == null) return null;
    if (v is num && v.isFinite) return v.toInt();
    throw _bad(k, 'number or null', v);
  }

  double number(String k) {
    final v = this[k];
    if (v is num) return v.toDouble();
    throw _bad(k, 'number', v);
  }

  double? numberOrNull(String k) {
    final v = this[k];
    if (v == null) return null;
    if (v is num) return v.toDouble();
    throw _bad(k, 'number or null', v);
  }

  bool boolean(String k) {
    final v = this[k];
    if (v is bool) return v;
    throw _bad(k, 'boolean', v);
  }

  bool? boolOrNull(String k) {
    final v = this[k];
    if (v == null || v is bool) return v as bool?;
    throw _bad(k, 'boolean or null', v);
  }

  /// An ISO-8601 instant, parsed once into UTC.
  DateTime time(String k) {
    final v = this[k];
    if (v is String) return _time(v) ?? (throw WireFormatException('not an ISO-8601 instant: "$v"', k));
    throw _bad(k, 'ISO-8601 string', v);
  }

  DateTime? timeOrNull(String k) {
    final v = this[k];
    if (v == null) return null;
    if (v is String) return _time(v) ?? (throw WireFormatException('not an ISO-8601 instant: "$v"', k));
    throw _bad(k, 'ISO-8601 string or null', v);
  }

  Map<String, Object?> obj(String k) => asJsonMap(this[k], k);

  Map<String, Object?>? objOrNull(String k) {
    final v = this[k];
    return v == null ? null : asJsonMap(v, k);
  }

  List<T> list<T>(String k, T Function(Map<String, Object?> e) decode) {
    final v = this[k];
    if (v is! List<Object?>) throw _bad(k, 'array', v);
    return List<T>.unmodifiable(v.map((e) => decode(asJsonMap(e, k))));
  }

  List<T>? listOrNull<T>(String k, T Function(Map<String, Object?> e) decode) =>
      this[k] == null ? null : list(k, decode);

  List<String> strings(String k) {
    final v = this[k];
    if (v is! List<Object?>) throw _bad(k, 'array of strings', v);
    for (final e in v) {
      if (e is! String) throw _bad(k, 'array of strings', e);
    }
    return List<String>.unmodifiable(v.cast<String>());
  }

  List<String>? stringsOrNull(String k) => this[k] == null ? null : strings(k);
}

/// A deep, unmodifiable copy of a JSON value (maps keep their key order).
Object? frozenJson(Object? v) {
  if (v is Map<String, Object?>) {
    return Map<String, Object?>.unmodifiable(<String, Object?>{for (final e in v.entries) e.key: frozenJson(e.value)});
  }
  if (v is List<Object?>) return List<Object?>.unmodifiable(v.map(frozenJson));
  return v;
}

Map<String, Object?> frozenMap(Map<String, Object?> m) => frozenJson(m)! as Map<String, Object?>;

/// Puts [value] under [key] only when it is not null (an optional TS field).
void putIfSet(Map<String, Object?> json, String key, Object? value) {
  if (value != null) json[key] = value;
}

String isoUtc(DateTime t) => t.toUtc().toIso8601String();
