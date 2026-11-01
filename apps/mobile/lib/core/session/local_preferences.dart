import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'session_store.dart';

/// The agent's own settings for this phone, kept on the device only (no
/// server round trip, so they work offline and apply instantly). The station
/// reads them when it plays a tone or buzzes.
@immutable
class LocalPreferences {
  const LocalPreferences({this.sounds = true, this.haptics = true, this.darkTheme});

  /// Ring and call tones (incoming call, connected, call ended).
  final bool sounds;

  /// A buzz when a call arrives and when it connects.
  final bool haptics;

  /// Dark or light, as the agent chose in the Me tab. Null until they choose:
  /// the phone's own light/dark setting applies.
  final bool? darkTheme;

  LocalPreferences copyWith({bool? sounds, bool? haptics}) =>
      LocalPreferences(sounds: sounds ?? this.sounds, haptics: haptics ?? this.haptics, darkTheme: darkTheme);

  @override
  bool operator ==(Object other) =>
      other is LocalPreferences && other.sounds == sounds && other.haptics == haptics && other.darkTheme == darkTheme;
  @override
  int get hashCode => Object.hash(sounds, haptics, darkTheme);
}

class LocalPreferencesNotifier extends Notifier<LocalPreferences> {
  static const soundsKey = 'prefs.sounds';
  static const hapticsKey = 'prefs.haptics';
  static const darkThemeKey = 'prefs.dark_theme';

  // A toggle made before the stored values arrive wins over them.
  bool _touched = false;

  @override
  LocalPreferences build() {
    unawaited(_load());
    return const LocalPreferences();
  }

  KeyValueStore get _kv => ref.read(keyValueStoreProvider);

  Future<void> _load() async {
    final values = await Future.wait([_kv.getBool(soundsKey), _kv.getBool(hapticsKey), _kv.getBool(darkThemeKey)]);
    if (!ref.mounted || _touched) return;
    state = LocalPreferences(sounds: values[0] ?? true, haptics: values[1] ?? true, darkTheme: values[2]);
  }

  Future<void> setSounds(bool on) async {
    _touched = true;
    state = state.copyWith(sounds: on);
    await _kv.setBool(soundsKey, on);
  }

  Future<void> setHaptics(bool on) async {
    _touched = true;
    state = state.copyWith(haptics: on);
    await _kv.setBool(hapticsKey, on);
  }

  Future<void> setDarkTheme(bool on) async {
    _touched = true;
    state = LocalPreferences(sounds: state.sounds, haptics: state.haptics, darkTheme: on);
    await _kv.setBool(darkThemeKey, on);
  }
}

final localPreferencesProvider =
    NotifierProvider<LocalPreferencesNotifier, LocalPreferences>(LocalPreferencesNotifier.new);
