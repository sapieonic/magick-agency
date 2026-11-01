import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

/// The station socket's wire, behind the smallest interface the station needs,
/// so tests drive frames without a network.
///
/// Text frames are control frames (JSON); binary frames are media (A-law). The
/// transport hands both over untouched: no decoding, no copies.
abstract interface class StationTransport {
  /// Registers the one listener. [onClosed] runs once, with the close code when
  /// the peer sent one (null for a dropped connection or a transport error).
  void listen({
    required void Function(String text) onText,
    required void Function(Uint8List bytes) onBinary,
    required void Function(int? code, String? reason) onClosed,
  });

  void sendText(String text);

  /// Sends [bytes] as one binary frame. Dropped when the socket is not open.
  void sendBinary(Uint8List bytes);

  /// Closes deliberately. Events after this are not delivered.
  void close(int code, String reason);
}

abstract interface class StationConnector {
  Future<StationTransport> connect(Uri url, {required Map<String, String> headers, required Duration pingInterval});
}

/// `dart:io` WebSocket. The upgrade is bounded by [connectTimeout]: a handshake
/// that hangs must fall into the retry ladder, not hold the station forever.
final class IoStationConnector implements StationConnector {
  const IoStationConnector({this.connectTimeout = const Duration(seconds: 10)});

  final Duration connectTimeout;

  @override
  Future<StationTransport> connect(Uri url, {required Map<String, String> headers, required Duration pingInterval}) async {
    final pending = WebSocket.connect(url.toString(), headers: headers);
    // Owned by the transport returned below, which closes it.
    // ignore: close_sinks
    final WebSocket ws;
    try {
      ws = await pending.timeout(connectTimeout);
    } on TimeoutException {
      // The upgrade may still complete; close that socket rather than leak it.
      unawaited(pending.then((late) => late.close(1000, 'connect timed out'), onError: (Object _) {}));
      rethrow;
    }
    ws.pingInterval = pingInterval;
    return _IoTransport(ws);
  }
}

final class _IoTransport implements StationTransport {
  _IoTransport(this._ws);

  final WebSocket _ws;
  StreamSubscription<Object?>? _sub;
  bool _detached = false;
  bool _closedReported = false;

  @override
  void listen({
    required void Function(String text) onText,
    required void Function(Uint8List bytes) onBinary,
    required void Function(int? code, String? reason) onClosed,
  }) {
    void closed(int? code, String? reason) {
      if (_closedReported) return;
      _closedReported = true;
      if (!_detached) onClosed(code, reason);
    }

    _sub = _ws.listen(
      (Object? data) {
        if (_detached) return;
        if (data is String) {
          onText(data);
        } else if (data is Uint8List) {
          onBinary(data);
        } else if (data is List<int>) {
          onBinary(Uint8List.fromList(data));
        }
      },
      onDone: () => closed(_ws.closeCode, _ws.closeReason),
      onError: (Object _) => closed(null, null),
      cancelOnError: true,
    );
  }

  @override
  void sendText(String text) {
    if (!_detached && _ws.readyState == WebSocket.open) _ws.add(text);
  }

  @override
  void sendBinary(Uint8List bytes) {
    if (!_detached && _ws.readyState == WebSocket.open) _ws.add(bytes);
  }

  @override
  void close(int code, String reason) {
    if (_detached) return;
    _detached = true;
    unawaited(_ws.close(code, reason).then((_) => _sub?.cancel(), onError: (Object _) => _sub?.cancel()));
  }
}
