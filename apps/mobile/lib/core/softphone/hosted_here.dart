import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../session/session_store.dart';

/// The session this phone last hosted, per workspace (`user:tenant:account`),
/// kept on the device.
///
/// The soft phone resumes a session by itself only when this phone was the
/// one hosting it (killed by the system, restarted): rehydrating a session
/// that lives on the web or on another phone would take its socket, and move
/// a live call's audio, to this phone without the agent asking. A session the
/// bootstrap names that is not the one remembered here waits for the agent's
/// "Use it on this phone".
///
/// Written when the host holds a session (and no other device has taken it),
/// removed when it stops holding it. Each operation runs after the one before
/// it, so a forget and a remember of the same key in quick succession land in
/// that order. Nothing here throws: an unreadable store reads as "hosted
/// nowhere", which only costs the agent a tap.
class HostedHere {
  HostedHere(this._kv);

  final KeyValueStore _kv;
  Future<void> _last = Future.value();

  static String keyFor(String workspace) => 'softphone.hosted_session.$workspace';

  Future<T?> _inTurn<T>(Future<T?> Function() op) {
    final next = _last.then((_) => op()).then<T?>((v) => v, onError: (Object _) => null);
    _last = next;
    return next;
  }

  /// The session id this phone last hosted in [workspace], or null.
  Future<String?> read(String workspace) => _inTurn(() => _kv.getString(keyFor(workspace)));

  /// This phone hosts [sessionId] in [workspace] now.
  Future<void> remember(String workspace, String sessionId) =>
      _inTurn(() => _kv.setString(keyFor(workspace), sessionId));

  /// This phone no longer hosts [sessionId]: forgotten, unless another
  /// session has been remembered since.
  Future<void> forget(String workspace, String sessionId) => _inTurn(() async {
    if (await _kv.getString(keyFor(workspace)) == sessionId) await _kv.remove(keyFor(workspace));
  });
}

final hostedHereProvider = Provider<HostedHere>((ref) => HostedHere(ref.watch(keyValueStoreProvider)));
