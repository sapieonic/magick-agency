import 'dart:async';
import 'dart:typed_data';

import 'package:agency_wire/agency_wire.dart';
import 'package:connectivity_plus/connectivity_plus.dart';

import '../api/api_error.dart';
import '../telemetry/log.dart';
import 'liveness.dart';
import 'station_state.dart' show StationConnection;
import 'station_transport.dart';

/// The station socket: one long-lived connection per shift (port of the
/// connection half of the console's `useAgencyStation`).
///
/// It must survive a shift across network changes, lifts, a backgrounded app
/// and an API deploy, so reconnect, backoff, the heartbeat and token re-minting
/// all live here. The rules, each from the console unless marked:
///
/// * **One owner at a time.** Every connect claims a new generation; every
///   callback compares before touching shared state, so a stale socket's close
///   can never clear the live socket's heartbeat or schedule a second connect.
/// * **A fresh token per connect.** The bootstrap's own token is used once (if
///   not yet expired); every later connect mints, under [tokenMintTimeout]. A
///   mint replaces the previous token server-side, so none is minted ahead.
/// * **Close codes:** 4404 session gone and 4409 superseded are terminal;
///   1008 (the server refused the upgrade itself) is terminal too, reported
///   as [StationConnection.disconnected] with its code: this build sends
///   something the server does not speak, and retrying cannot change that.
///   1011 (the server could not run the station) retries, but
///   [serverErrorLimit] in a row with no `pong` between give up like a
///   flapping socket (held while a call is live). Everything else (4401,
///   4408, a drop) retries with a new token.
/// * **The ladder** (0.5, 1, 2, 5, 10, 15 s) resets on a `pong`, never on open:
///   a socket that opens and dies at once must not reconnect at 2 Hz forever.
/// * **Give up** after [missedPingLimit] heartbeats with a ping unanswered,
///   unless a call is live (the server is holding it; keep trying).
/// * **Flap cap:** more than [flapLimit] proven-live-then-dead sockets in
///   [flapWindow] is a duel over the session; stop and let the agent decide,
///   unless a call is live (as for the heartbeat give-up).
/// * Mobile: app-level pings only while [setAppPings] says so (foreground, or a
///   call or wrap-up is live); protocol pings every 3 s regardless; an OS
///   network change reconnects at once instead of after a backoff step; with
///   [setKeepAlive] false (backgrounded, no call) a dropped socket parks
///   instead of retrying, and resumes the moment the app returns.
/// * Binary frames go straight to [onBinary]: no decoding, no copies, no JSON.
class StationSocket {
  StationSocket({
    required this._connector,
    required this._resolveUrl,
    required this._mintToken,
    required this._refreshIdToken,
    required this._initialUrl,
    this._initialUrlExpiresAt,
    required this._heartbeat,
    required this._clientHeader,
    required this.onFrame,
    required this.onPong,
    required this.onBinary,
    required this.onConnection,
    required this.onMissedPings,
    required this._callLive,
    this._media = MediaFormat.alaw8,
    this._now = DateTime.now,
    this._decode = StationFrame.decode,
  });

  static final _log = Log('station.socket');

  final StationConnector _connector;

  /// `station_ws_url` (relative) → absolute `wss://` URL.
  final Uri Function(String stationWsUrl) _resolveUrl;

  /// A fresh single-use upgrade token: the `station_ws_url` to connect to.
  final Future<String> Function() _mintToken;
  final Future<void> Function() _refreshIdToken;

  /// The bootstrap's own URL and token, used once.
  final String _initialUrl;
  final DateTime? _initialUrlExpiresAt;

  /// `intervals.heartbeat_ms`: the app-level ping cadence.
  final Duration _heartbeat;

  /// `X-Client` on the upgrade request.
  final String _clientHeader;

  /// Whether a call is live (the heartbeat and flap give-ups hold while it is).
  final bool Function() _callLive;
  final MediaFormat _media;
  final DateTime Function() _now;
  final StationFrame Function(String text) _decode;

  /// Every decoded text frame except `pong`.
  final void Function(StationFrame frame) onFrame;

  /// A `pong`, with this device's receive time in epoch ms.
  final void Function(PongFrame frame, int receivedAtMs) onPong;

  /// One binary media frame, exactly as the socket delivered it.
  final void Function(Uint8List bytes) onBinary;

  /// [closeCode] is set when a close caused the change.
  final void Function(StationConnection connection, {int? closeCode}) onConnection;
  final void Function(int count) onMissedPings;

  StationConnection _connection = StationConnection.idle;
  StationTransport? _transport;
  Timer? _heartbeatTimer;
  Timer? _retryTimer;
  Timer? _mintTimer;
  int _generation = 0;
  int _retryCount = 0;
  int _serverErrors = 0;
  int _pendingPings = 0;
  int _unansweredSince = 0;
  bool _provedLive = false;
  bool _initialSpent = false;
  bool _hasOpened = false;
  bool _pingsEnabled = true;
  bool _keepAlive = true;
  bool _parked = false;
  bool _heldLogged = false;
  bool _disposed = false;
  String? _gaveUpCause;
  List<int> _flapStamps = const [];
  DateTime? _idTokenRefreshedAt;
  Set<ConnectivityResult>? _network;

  StationConnection get connection => _connection;
  bool get isOpen => _connection == StationConnection.open;

  /// Why the socket last gave up (`heartbeat`, `flapping`, `server_error`,
  /// `refused`), or null while it has not.
  String? get gaveUpCause => _gaveUpCause;

  /// This many 1011 closes in a row, with no `pong` between, is a server that
  /// is up and broken: stop retrying and let the agent decide.
  static const serverErrorLimit = 3;

  /// The ID token was refreshed elsewhere just now (the controller warms it at join).
  void markIdTokenFresh() => _idTokenRefreshedAt = _now();

  /// Opens the first connection.
  void start() {
    if (_disposed || _connection != StationConnection.idle) return;
    unawaited(_connect());
  }

  /// The agent asked: start over with a clean ladder and flap record. Also how
  /// "Use this phone instead" takes the session back after 4409 (a new socket
  /// on the same session supersedes the other device's).
  void reconnect() {
    if (_disposed) return;
    _retryCount = 0;
    _serverErrors = 0;
    _flapStamps = const [];
    _gaveUpCause = null;
    _resetPings();
    unawaited(_connect());
  }

  /// Closes the socket now and waits, parked, for the app's return
  /// ([setKeepAlive] true, or [reconnect]). The server's close handler then
  /// takes the agent out of the dialable pool at once: what the app does when
  /// the `device_away` pause cannot be delivered while it is in the background.
  void park({String reason = 'device_away'}) {
    if (_disposed) return;
    _generation++;
    _clearTimers();
    _abandon(reason);
    _parked = true;
    _setConnection(StationConnection.reconnecting);
  }

  /// App-level `{event:'ping', ts}` on/off. Off stops the heartbeat and with it
  /// the give-up check (silence is evidence only when we have asked).
  void setAppPings(bool enabled) {
    if (_disposed || enabled == _pingsEnabled) return;
    _pingsEnabled = enabled;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _resetPings();
    if (enabled && isOpen) _startHeartbeat(_generation);
  }

  /// Whether a dropped socket should be retried now. Off (backgrounded with no
  /// call live): a drop parks; turning it back on reconnects at once.
  void setKeepAlive(bool keepAlive) {
    if (_disposed || keepAlive == _keepAlive) return;
    _keepAlive = keepAlive;
    if (keepAlive && _parked) {
      _parked = false;
      unawaited(_connect());
    }
  }

  /// An OS network change. When a transport the socket may have been using
  /// went away, the socket is presumed dead: reconnect now rather than wait for
  /// protocol pings to notice or a backoff step to pass. Additions only (Wi-Fi
  /// joining a live 4G) leave a working socket alone.
  void networkChanged(List<ConnectivityResult> results) {
    final next = results.where((r) => r != ConnectivityResult.none).toSet();
    final previous = _network;
    _network = next;
    if (_disposed || _parked || previous == null || next.isEmpty) return;
    final lost = previous.isEmpty || previous.difference(next).isNotEmpty;
    if (!lost) return;
    switch (_connection) {
      case StationConnection.open || StationConnection.connecting || StationConnection.reconnecting:
        _log.info('network changed: reconnecting now', {'to': next.map((r) => r.name).join(',')});
        unawaited(_connect());
      case StationConnection.disconnected when _gaveUpCause == 'heartbeat':
        // The network is back after a silence give-up: worth one clean try.
        reconnect();
      case _:
        break;
    }
  }

  /// One uplink media frame. False when there is no open socket to take it.
  bool sendBinary(Uint8List bytes) {
    final t = _transport;
    if (t == null || !isOpen) return false;
    t.sendBinary(bytes);
    return true;
  }

  /// Closes for good: every timer cancelled, the socket closed with 1000.
  void dispose({String reason = 'leaving'}) {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    _clearTimers();
    _abandon(reason);
  }

  // ─── Connecting ─────────────────────────────────────────────────────────

  Future<void> _connect() async {
    if (_disposed) return;
    final gen = ++_generation;
    _provedLive = false;
    _parked = false;
    _heldLogged = false;
    _abandon('replaced');
    _clearTimers();
    _setConnection(_retryCount == 0 && !_hasOpened ? StationConnection.connecting : StationConnection.reconnecting);

    final String url;
    if (!_initialSpent && _initialUsable()) {
      _initialSpent = true;
      url = _initialUrl;
    } else {
      _initialSpent = true;
      try {
        url = await _mintWithDeadline();
      } catch (e) {
        if (gen != _generation) return;
        if (e is ApiHttpError && (e.status == 404 || e.code == AgencyErrorCode.sessionEnded.wire)) {
          _log.warn('station token refused: session gone', {'status': e.status});
          _setConnection(StationConnection.sessionGone, closeCode: StationCloseCode.sessionGone.code);
          return;
        }
        _log.warn('station token mint failed', {'error': e.runtimeType.toString(), 'retry': _retryCount});
        _scheduleRetry(null);
        return;
      }
      if (gen != _generation) return;
    }

    final uri = _withQuery(_resolveUrl(url));
    final StationTransport transport;
    try {
      transport = await _connector.connect(
        uri,
        headers: {'x-client': _clientHeader},
        pingInterval: protocolPingInterval,
      );
    } catch (e) {
      if (gen != _generation) return;
      _log.info('station connect failed', {'error': e.runtimeType.toString(), 'retry': _retryCount});
      _scheduleRetry(null);
      return;
    }
    if (gen != _generation) {
      transport.close(1000, 'replaced');
      return;
    }
    _transport = transport;
    transport.listen(
      onText: (text) {
        if (gen == _generation) _onText(text);
      },
      onBinary: (bytes) {
        if (gen == _generation) onBinary(bytes);
      },
      onClosed: (code, reason) {
        if (gen == _generation) _onClosed(code, reason);
      },
    );
    _onOpen(gen);
  }

  bool _initialUsable() {
    final expires = _initialUrlExpiresAt;
    // A token about to lapse would fail the upgrade with 4401 and cost a step.
    return expires == null || _now().isBefore(expires.subtract(const Duration(seconds: 5)));
  }

  /// The mint under [tokenMintTimeout], on a timer [dispose] can cancel
  /// (`Future.timeout`'s cannot be).
  Future<String> _mintWithDeadline() {
    final done = Completer<String>();
    _mintTimer?.cancel();
    final timer = Timer(tokenMintTimeout, () {
      if (!done.isCompleted) done.completeError(TimeoutException('station token mint', tokenMintTimeout));
    });
    _mintTimer = timer;
    _mint().then(
      (url) {
        if (!done.isCompleted) done.complete(url);
      },
      onError: (Object e, StackTrace st) {
        if (!done.isCompleted) done.completeError(e, st);
      },
    );
    return done.future.whenComplete(() {
      // Only this mint's own deadline: a newer connect's mint may hold the field now.
      timer.cancel();
      if (identical(_mintTimer, timer)) _mintTimer = null;
    });
  }

  Future<String> _mint() async {
    final refreshed = _idTokenRefreshedAt;
    if (refreshed == null || _now().difference(refreshed) > idTokenMaxAge) {
      try {
        await _refreshIdToken();
        _idTokenRefreshedAt = _now();
      } catch (e) {
        // The mint still tries with whatever token the client holds.
        _log.warn('id token refresh failed before mint', {'error': e.runtimeType.toString()});
      }
    }
    return _mintToken();
  }

  /// What this build takes beyond its session's own work, declared on every upgrade
  /// (`caps=inbound`): without it the server offers this station no inbound calls and sends it
  /// neither `inbound_call` nor `customer_waiting`.
  static const capabilities = [StationCapability.inbound];

  Uri _withQuery(Uri url) => url.replace(
        queryParameters: StationCapability.withQuery(
          <String, String>{...url.queryParameters, 'client': 'mobile', 'media': _media.wire},
          capabilities,
        ),
      );

  void _onOpen(int gen) {
    _hasOpened = true;
    _gaveUpCause = null;
    _resetPings();
    _setConnection(StationConnection.open);
    if (_pingsEnabled) _startHeartbeat(gen);
  }

  void _startHeartbeat(int gen) {
    _sendPing();
    _unansweredSince = _now().millisecondsSinceEpoch;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(_heartbeat, (_) {
      if (gen != _generation) return;
      _pendingPings += 1;
      onMissedPings(_pendingPings);
      _sendPing();
      final nowMs = _now().millisecondsSinceEpoch;
      if (_unansweredSince == 0) _unansweredSince = nowMs;
      if (!silentTooLong(_unansweredSince, nowMs, _heartbeat)) return;
      if (_callLive()) {
        // The server holds a live call for this session; giving up would end it.
        if (!_heldLogged) {
          _heldLogged = true;
          _log.warn('heartbeat stalled on a live call: holding', {'silent_s': (nowMs - _unansweredSince) ~/ 1000});
        }
        return;
      }
      _giveUp('heartbeat');
    });
  }

  void _sendPing() => _transport?.sendText(PingFrame.encodeTs(_now().millisecondsSinceEpoch));

  void _resetPings() {
    _unansweredSince = 0;
    if (_pendingPings != 0) {
      _pendingPings = 0;
      onMissedPings(0);
    }
  }

  void _onText(String text) {
    final frame = _decode(text);
    if (frame is PongFrame) {
      _pendingPings = 0;
      _retryCount = 0;
      _serverErrors = 0;
      _provedLive = true;
      _unansweredSince = 0;
      _heldLogged = false;
      onPong(frame, _now().millisecondsSinceEpoch);
      return;
    }
    onFrame(frame);
  }

  void _onClosed(int? code, String? reason) {
    _clearTimers();
    _transport = null;
    switch (StationCloseCode.fromCode(code)) {
      case StationCloseCode.sessionGone:
        _log.warn('station closed 4404: session gone');
        _setConnection(StationConnection.sessionGone, closeCode: code);
        return;
      case StationCloseCode.superseded:
        _log.warn('station closed 4409: superseded by another device');
        _setConnection(StationConnection.superseded, closeCode: code);
        return;
      case StationCloseCode.invalidUpgrade:
        // The same upgrade is refused again, whatever the token.
        _log.warn('station closed 1008: upgrade refused', {'reason': reason ?? ''});
        _giveUp('refused', closeCode: code);
        return;
      case StationCloseCode.internalError:
        _serverErrors += 1;
        _log.warn('station closed 1011: server error', {'reason': reason ?? '', 'in_a_row': _serverErrors});
        if (_serverErrors >= serverErrorLimit) {
          if (!_callLive()) {
            _giveUp('server_error', closeCode: code);
            return;
          }
          // The server holds a live call for this session; giving up would end it.
          _log.warn('station failing on a live call: holding');
        }
        _scheduleRetry(code);
      case StationCloseCode.tokenRejected || StationCloseCode.heartbeatTimeout || null:
        _log.info('station closed', {'code': code, 'reason': reason ?? ''});
        _scheduleRetry(code);
    }
  }

  void _scheduleRetry(int? closeCode) {
    _setConnection(StationConnection.reconnecting, closeCode: closeCode);
    if (_provedLive) {
      _provedLive = false;
      final r = recordLiveThenDead(_flapStamps, _now().millisecondsSinceEpoch);
      _flapStamps = r.stamps;
      if (r.flapping) {
        if (!_callLive()) {
          _giveUp('flapping');
          return;
        }
        // The server holds a live call for this session; giving up would end it.
        _log.warn('station flapping on a live call: holding');
      }
    }
    if (!_keepAlive) {
      _parked = true;
      return;
    }
    final delay = backoffFor(_retryCount);
    _retryCount += 1;
    _retryTimer = Timer(delay, () => unawaited(_connect()));
  }

  void _giveUp(String cause, {int? closeCode}) {
    _generation++;
    _clearTimers();
    _abandon(cause);
    _flapStamps = const [];
    _gaveUpCause = cause;
    _log.warn('station gave up', {'cause': cause});
    _setConnection(StationConnection.disconnected, closeCode: closeCode);
  }

  void _abandon(String reason) {
    final t = _transport;
    _transport = null;
    t?.close(1000, reason);
  }

  void _clearTimers() {
    _heartbeatTimer?.cancel();
    _retryTimer?.cancel();
    _mintTimer?.cancel();
    _heartbeatTimer = null;
    _retryTimer = null;
    _mintTimer = null;
  }

  void _setConnection(StationConnection next, {int? closeCode}) {
    if (next == _connection && closeCode == null) return;
    _connection = next;
    onConnection(next, closeCode: closeCode);
  }
}
