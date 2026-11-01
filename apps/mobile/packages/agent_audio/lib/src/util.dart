/// Decodes an enum from its `name` as sent by the native side, with a fallback so a newer
/// native value never throws in an older Dart build.
T enumByName<T extends Enum>(List<T> values, Object? name, T fallback) {
  for (final v in values) {
    if (v.name == name) return v;
  }
  return fallback;
}

int intOr(Object? v, [int fallback = 0]) => v is int ? v : fallback;

double doubleOr(Object? v, [double fallback = 0]) => v is num ? v.toDouble() : fallback;

bool boolOr(Object? v, [bool fallback = false]) => v is bool ? v : fallback;
