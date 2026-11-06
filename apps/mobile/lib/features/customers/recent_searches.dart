import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/session/session_store.dart';

/// One number searched on this device: the E.164 the server searched (searched
/// again as typed, with its `+`, so the picked country does not matter) and
/// how it was shown.
@immutable
class RecentSearch {
  const RecentSearch({required this.e164, required this.display});

  final String e164;
  final String display;

  Map<String, Object?> toJson() => {'e164': e164, 'display': display};

  /// Null for anything that is not a stored search (an older or damaged value).
  static RecentSearch? tryFromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final e164 = json['e164'];
    final display = json['display'];
    if (e164 is! String || display is! String || e164.isEmpty) return null;
    return RecentSearch(e164: e164, display: display);
  }

  @override
  bool operator ==(Object other) => other is RecentSearch && other.e164 == e164 && other.display == display;

  @override
  int get hashCode => Object.hash(e164, display);
}

/// The last [max] numbers searched on this device, newest first, under
/// [SessionStore.recentSearchesKey] (cleared by "Clear" and on sign-out). A
/// value that does not read is treated as no history, never as an error.
class RecentSearchesStore {
  RecentSearchesStore(this._kv);

  final KeyValueStore _kv;

  static const max = 5;

  Future<List<RecentSearch>> read() async {
    final raw = await _kv.getString(SessionStore.recentSearchesKey);
    if (raw == null || raw.isEmpty) return const [];
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return const [];
    }
    if (decoded is! List<Object?>) return const [];
    return [
      for (final e in decoded) ?RecentSearch.tryFromJson(e),
    ].take(max).toList(growable: false);
  }

  /// Puts [search] first (once), keeps [max], and answers the new list.
  Future<List<RecentSearch>> remember(RecentSearch search) async {
    final next = [
      search,
      ...(await read()).where((r) => r.e164 != search.e164),
    ].take(max).toList(growable: false);
    await _kv.setString(SessionStore.recentSearchesKey, jsonEncode([for (final r in next) r.toJson()]));
    return next;
  }

  Future<void> clear() => _kv.remove(SessionStore.recentSearchesKey);
}
