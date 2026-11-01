import 'dart:async';
import 'dart:typed_data';

import 'package:magick_agency_agent/core/station/station_transport.dart';

/// A station socket with no network: the test plays the server.
class FakeTransport implements StationTransport {
  FakeTransport(this.url, this.headers, this.pingInterval);

  final Uri url;
  final Map<String, String> headers;
  final Duration pingInterval;

  final List<String> sentText = [];
  int sentBinary = 0;
  Uint8List? lastBinary;
  bool closed = false;
  int? closedWith;

  void Function(String)? _onText;
  void Function(Uint8List)? _onBinary;
  void Function(int?, String?)? _onClosed;

  List<String> get pings => sentText.where((t) => t.startsWith('{"event":"ping"')).toList();

  /// The `ts` of the last ping, as the server would echo it.
  int get lastPingTs {
    final t = pings.last;
    return int.parse(RegExp(r'"ts":(\d+)').firstMatch(t)!.group(1)!);
  }

  void serverText(String text) => _onText?.call(text);
  void serverBinary(Uint8List bytes) => _onBinary?.call(bytes);
  void serverPong({int serverOffsetMs = 0}) {
    final ts = lastPingTs;
    serverText('{"event":"pong","ts":$ts,"server_ts":${ts + serverOffsetMs}}');
  }

  /// The server closes (or the line drops, with no code).
  void serverClose([int? code, String? reason]) {
    final cb = _onClosed;
    _onClosed = null;
    cb?.call(code, reason);
  }

  @override
  void listen({
    required void Function(String text) onText,
    required void Function(Uint8List bytes) onBinary,
    required void Function(int? code, String? reason) onClosed,
  }) {
    _onText = onText;
    _onBinary = onBinary;
    _onClosed = onClosed;
  }

  @override
  void sendText(String text) {
    if (!closed) sentText.add(text);
  }

  @override
  void sendBinary(Uint8List bytes) {
    if (closed) return;
    sentBinary++;
    lastBinary = bytes;
  }

  @override
  void close(int code, String reason) {
    closed = true;
    closedWith = code;
    _onText = null;
    _onBinary = null;
    _onClosed = null;
  }
}

class FakeConnector implements StationConnector {
  final List<FakeTransport> opened = [];
  int attempts = 0;

  /// When set, every connect fails with it.
  Object? failWith;

  /// When set, connects wait on it.
  Completer<void>? gate;

  FakeTransport get last => opened.last;

  @override
  Future<StationTransport> connect(Uri url, {required Map<String, String> headers, required Duration pingInterval}) async {
    attempts++;
    final g = gate;
    if (g != null) await g.future;
    final error = failWith;
    if (error != null) throw error;
    final t = FakeTransport(url, headers, pingInterval);
    opened.add(t);
    return t;
  }
}
