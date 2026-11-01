import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/session/local_preferences.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';

/// A store whose reads wait until the test lets them through (the phone's
/// preferences file being slow at start-up).
class _SlowStore extends MemoryStore {
  _SlowStore(super.initial);

  final gate = Completer<void>();

  @override
  Future<bool?> getBool(String key) async {
    await gate.future;
    return super.getBool(key);
  }
}

void main() {
  test('a switch toggled before the stored values arrive wins for that switch only', () async {
    final store = _SlowStore({
      LocalPreferencesNotifier.soundsKey: true,
      LocalPreferencesNotifier.hapticsKey: false,
      LocalPreferencesNotifier.darkThemeKey: true,
    });
    final c = ProviderContainer.test(overrides: [keyValueStoreProvider.overrideWithValue(store)]);
    c.listen(localPreferencesProvider, (_, _) {});

    await c.read(localPreferencesProvider.notifier).setSounds(false);
    store.gate.complete();
    await pumpEventQueue();

    final prefs = c.read(localPreferencesProvider);
    expect(prefs.sounds, isFalse); // the toggle
    expect(prefs.haptics, isFalse); // stored
    expect(prefs.darkTheme, isTrue); // stored, not lost to the toggle
  });
}
