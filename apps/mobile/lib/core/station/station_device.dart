import 'dart:math';

import 'package:agency_wire/agency_wire.dart' show StationDevice;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../session/session_store.dart';

/// This install's station device id (OS3, `docs/mobile.md` "One station per agent").
///
/// The server remembers which device holds a session's station and refuses a join, a soft-phone
/// open or a token mint from any other one unless the agent chose to take it over. So a phone that
/// lost its socket (out of signal, killed in the background) cannot reconnect onto a station the
/// agent has since opened in the console, and the console cannot take it back from the phone.
///
/// **One per install**, kept in the preferences store so a restart of the app is the same device
/// (an auto-resume after the OS killed the app is still this phone's own station). Generated on
/// first use: 32 hex characters from a secure random source. A store that cannot be read or
/// written still yields an id for this run (a new one next time, which only costs a "Use this
/// phone" tap).
final class StationDeviceIds {
  /// [store] is read on first use, not here: building the preferences store can throw where no
  /// platform is registered (tests), and the station must open all the same.
  StationDeviceIds(this._store, {Random? random}) : _random = random ?? Random.secure();

  final KeyValueStore Function() _store;
  final Random _random;
  Future<String>? _id;

  static const storeKey = 'magick-agency.station-device-id';

  Future<String> id() => _id ??= _load();

  Future<String> _load() async {
    KeyValueStore? store;
    try {
      store = _store();
      final stored = await store.getString(storeKey);
      if (stored != null && StationDevice.pattern.hasMatch(stored)) return stored;
    } catch (_) {
      store = null;
    }
    final fresh = _fresh();
    try {
      await store?.setString(storeKey, fresh);
    } catch (_) {
      // Kept for this run only; the next run makes another (one "Use this phone" tap at worst).
    }
    return fresh;
  }

  String _fresh() {
    final b = StringBuffer();
    for (var i = 0; i < 16; i++) {
      b.write(_random.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return b.toString();
  }

  /// The device fields for a request. [takeOver]: only on the agent's own action.
  Future<StationDevice> fields({required bool takeOver}) async => StationDevice(deviceId: await id(), takeOver: takeOver);
}

final stationDeviceIdsProvider = Provider<StationDeviceIds>((ref) => StationDeviceIds(() => ref.read(keyValueStoreProvider)));
