// Value equality for lists and decoded JSON, without a package dependency.
// Internal to the package.

bool listEquals<T>(List<T>? a, List<T>? b) {
  if (identical(a, b)) return true;
  if (a == null || b == null || a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

int listHash(List<Object?>? l) => l == null ? 0 : Object.hashAll(l);

/// Structural equality for JSON values (maps compare by key set, not key order).
bool jsonEquals(Object? a, Object? b) {
  if (identical(a, b)) return true;
  if (a is Map<String, Object?> && b is Map<String, Object?>) {
    if (a.length != b.length) return false;
    for (final e in a.entries) {
      if (!b.containsKey(e.key) || !jsonEquals(e.value, b[e.key])) return false;
    }
    return true;
  }
  if (a is List<Object?> && b is List<Object?>) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!jsonEquals(a[i], b[i])) return false;
    }
    return true;
  }
  return a == b;
}

int jsonHash(Object? v) {
  if (v is Map<String, Object?>) {
    // Order-independent, to agree with [jsonEquals].
    return Object.hashAllUnordered(v.entries.map((e) => Object.hash(e.key, jsonHash(e.value))));
  }
  if (v is List<Object?>) return Object.hashAll(v.map(jsonHash));
  return v.hashCode;
}

bool mapEquals<K, V>(Map<K, V>? a, Map<K, V>? b) {
  if (identical(a, b)) return true;
  if (a == null || b == null || a.length != b.length) return false;
  for (final e in a.entries) {
    if (!b.containsKey(e.key) || b[e.key] != e.value) return false;
  }
  return true;
}

int mapHash<K, V>(Map<K, V>? m) =>
    m == null ? 0 : Object.hashAllUnordered(m.entries.map((e) => Object.hash(e.key, e.value)));
