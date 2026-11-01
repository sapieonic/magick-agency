import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../telemetry/log.dart';

/// The little the app keeps on the device: which account was last used and
/// the agent's local preferences. Nothing about contacts or calls, ever.
abstract interface class KeyValueStore {
  Future<String?> getString(String key);
  Future<void> setString(String key, String value);
  Future<bool?> getBool(String key);
  Future<void> setBool(String key, bool value);
  Future<void> remove(String key);
}

/// `shared_preferences` (NSUserDefaults / Android DataStore). Failures are
/// logged and swallowed: a preference that did not save must never stop
/// sign-in or a shift.
class SharedPreferencesStore implements KeyValueStore {
  SharedPreferencesStore([SharedPreferencesAsync? prefs]) : _prefs = prefs ?? SharedPreferencesAsync();

  final SharedPreferencesAsync _prefs;
  static final _log = Log('prefs');

  Future<T?> _try<T>(String what, Future<T?> Function() body) async {
    try {
      return await body();
    } catch (e) {
      _log.warn('$what failed', {'error': e.runtimeType.toString()});
      return null;
    }
  }

  @override
  Future<String?> getString(String key) => _try('read $key', () => _prefs.getString(key));
  @override
  Future<void> setString(String key, String value) => _try('write $key', () => _prefs.setString(key, value));
  @override
  Future<bool?> getBool(String key) => _try('read $key', () => _prefs.getBool(key));
  @override
  Future<void> setBool(String key, bool value) => _try('write $key', () => _prefs.setBool(key, value));
  @override
  Future<void> remove(String key) => _try('remove $key', () => _prefs.remove(key));
}

/// For tests and previews.
class MemoryStore implements KeyValueStore {
  MemoryStore([Map<String, Object>? initial]) : values = {...?initial};

  final Map<String, Object> values;

  @override
  Future<String?> getString(String key) async => values[key] as String?;
  @override
  Future<void> setString(String key, String value) async => values[key] = value;
  @override
  Future<bool?> getBool(String key) async => values[key] as bool?;
  @override
  Future<void> setBool(String key, bool value) async => values[key] = value;
  @override
  Future<void> remove(String key) async => values.remove(key);
}

final keyValueStoreProvider = Provider<KeyValueStore>((ref) => SharedPreferencesStore());

/// The tenant/account the agent last worked in on this device.
@immutable
class LastAccount {
  const LastAccount({required this.tenantId, required this.accountId});
  final String tenantId;
  final String accountId;

  @override
  bool operator ==(Object other) => other is LastAccount && other.tenantId == tenantId && other.accountId == accountId;
  @override
  int get hashCode => Object.hash(tenantId, accountId);
}

class SessionStore {
  SessionStore(this._kv);

  final KeyValueStore _kv;

  static const tenantKey = 'session.last_tenant_id';
  static const accountKey = 'session.last_account_id';

  Future<LastAccount?> readLastAccount() async {
    final values = await Future.wait([_kv.getString(tenantKey), _kv.getString(accountKey)]);
    final tenant = values[0];
    final account = values[1];
    if (tenant == null || account == null || tenant.isEmpty || account.isEmpty) return null;
    return LastAccount(tenantId: tenant, accountId: account);
  }

  Future<void> writeLastAccount(LastAccount last) async {
    await Future.wait([_kv.setString(tenantKey, last.tenantId), _kv.setString(accountKey, last.accountId)]);
  }

  Future<void> clearLastAccount() async {
    await Future.wait([_kv.remove(tenantKey), _kv.remove(accountKey)]);
  }
}

final sessionStoreProvider = Provider<SessionStore>((ref) => SessionStore(ref.watch(keyValueStoreProvider)));
