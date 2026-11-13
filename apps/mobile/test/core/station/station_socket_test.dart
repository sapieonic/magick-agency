import 'dart:async';
import 'dart:io' show SocketException;
import 'dart:typed_data';

import 'package:agency_wire/agency_wire.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/station/station_socket.dart';
import 'package:magick_agency_agent/core/station/station_state.dart';

import 'fake_transport.dart';

/// The socket's policy against a fake transport on a fake clock: close codes,
/// the ladder, give-up, the flap cap, a token per reconnect, network changes,
/// the ping configuration, and that every timer dies with it.
class _Harness {
  _Harness(this.async, {DateTime? tokenExpiresAt, Duration heartbeat = const Duration(seconds: 10)}) {
    final clock = async.getClock(DateTime.utc(2026, 11, 1, 9));
    socket = StationSocket(
      connector: connector,
      resolveUrl: (u) => Uri.parse('wss://api.test').resolve(u),
      mintToken: () {
        mints++;
        final error = mintError;
        if (error != null) return Future.error(error);
        final gate = mintGate;
        if (gate != null) return gate.future;
        return Future.value('/proxy/agency/station?token=mint$mints');
      },
      refreshIdToken: () async => refreshes++,
      initialUrl: '/proxy/agency/station?token=boot',
      initialUrlExpiresAt: tokenExpiresAt,
      heartbeat: heartbeat,
      clientHeader: 'magick-agency-mobile/0.1.0+1 (android 14; test)',
      onFrame: frames.add,
      onPong: (f, at) => pongs.add(f),
      onBinary: binaries.add,
      onConnection: (c, {closeCode}) => connections.add((c, closeCode)),
      onMissedPings: missed.add,
      callLive: () => callLive,
      now: clock.now,
      decode: (text) {
        decodes++;
        return StationFrame.decode(text);
      },
    );
  }

  final FakeAsync async;
  final connector = FakeConnector();
  late final StationSocket socket;
  int mints = 0;
  int refreshes = 0;
  int decodes = 0;
  Object? mintError;
  Completer<String>? mintGate;
  bool callLive = false;
  final frames = <StationFrame>[];
  final pongs = <PongFrame>[];
  final binaries = <Uint8List>[];
  final missed = <int>[];
  final connections = <(StationConnection, int?)>[];

  StationConnection get state => socket.connection;

  void openFirst() {
    socket.start();
    async.flushMicrotasks();
  }

  /// Drops the current socket with [code] and returns the time to the next connect.
  Duration dropAndMeasure([int? code]) {
    final before = connector.attempts;
    connector.last.serverClose(code);
    var waited = Duration.zero;
    const step = Duration(milliseconds: 100);
    while (connector.attempts == before) {
      async.elapse(step);
      waited += step;
      if (waited > const Duration(minutes: 1)) fail('no reconnect');
    }
    return waited;
  }
}

void main() {
  test('the first connect uses the bootstrap token, adds client=mobile&media=alaw8&caps=inbound, X-Client and 3 s protocol pings', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      final t = h.connector.last;
      expect(t.url.scheme, 'wss');
      expect(t.url.queryParameters, {'token': 'boot', 'client': 'mobile', 'media': 'alaw8', 'caps': 'inbound'});
      expect(t.headers['x-client'], startsWith('magick-agency-mobile/'));
      expect(t.pingInterval, const Duration(seconds: 3));
      expect(h.mints, 0, reason: 'never mint ahead of need');
      expect(h.state, StationConnection.open);
      h.socket.dispose();
    });
  });

  test('declareInbound off: every connect, however it starts, leaves out caps; back on, the next declares it', () {
    fakeAsync((async) {
      final h = _Harness(async);
      h.socket.declareInbound = false;
      h.openFirst();
      expect(h.connector.last.url.queryParameters, {'token': 'boot', 'client': 'mobile', 'media': 'alaw8'});
      // A drop's retry and a parked socket's resume connect without it too.
      h.dropAndMeasure();
      expect(h.connector.last.url.queryParameters.containsKey('caps'), isFalse);
      h.socket.park();
      h.socket.setKeepAlive(false);
      h.socket.setKeepAlive(true);
      async.flushMicrotasks();
      expect(h.connector.last.url.queryParameters.containsKey('caps'), isFalse);
      h.socket.declareInbound = true;
      h.socket.reconnect();
      async.flushMicrotasks();
      expect(h.connector.last.url.queryParameters['caps'], 'inbound');
      h.socket.dispose();
    });
  });

  test('app pings: one on open, then one every heartbeat, as {event:ping, ts}', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      final t = h.connector.last;
      expect(t.pings, hasLength(1));
      expect(t.pings.single, matches(RegExp(r'^\{"event":"ping","ts":\d+\}$')));
      t.serverPong();
      async.elapse(const Duration(seconds: 10));
      t.serverPong();
      async.elapse(const Duration(seconds: 10));
      expect(t.pings, hasLength(3));
      expect(h.pongs, hasLength(2));
      h.socket.dispose();
    });
  });

  group('close codes', () {
    test('4404: session gone, terminal, no retry', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        h.connector.last.serverClose(4404);
        async.elapse(const Duration(minutes: 2));
        expect(h.state, StationConnection.sessionGone);
        expect(h.connector.attempts, 1);
        expect(h.mints, 0);
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('4409: superseded, terminal, no retry; Use this phone re-mints and reconnects', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        h.connector.last.serverClose(4409);
        async.elapse(const Duration(minutes: 2));
        expect(h.state, StationConnection.superseded);
        expect(h.connector.attempts, 1);
        h.socket.reconnect();
        async.flushMicrotasks();
        expect(h.mints, 1);
        expect(h.connector.last.url.queryParameters['token'], 'mint1');
        // Every connect declares inbound calls, a re-minted one included.
        expect(h.connector.last.url.queryParameters['caps'], 'inbound');
        expect(h.state, StationConnection.open);
        h.socket.dispose();
      });
    });

    test('1008: the upgrade was refused — terminal, no retry, reported with its code', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        h.connector.last.serverClose(1008, 'invalid_client');
        async.elapse(const Duration(minutes: 2));
        expect(h.state, StationConnection.disconnected);
        expect(h.connections.last, (StationConnection.disconnected, 1008));
        expect(h.socket.gaveUpCause, 'refused');
        expect(h.connector.attempts, 1);
        expect(h.mints, 0);
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('1011: retried, but ${StationSocket.serverErrorLimit} in a row give up; a pong in between resets the count', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        h.dropAndMeasure(1011);
        async.flushMicrotasks();
        h.connector.last.serverPong();
        // The pong proved the server healthy again: the count starts over.
        h.dropAndMeasure(1011);
        async.flushMicrotasks();
        h.dropAndMeasure(1011);
        async.flushMicrotasks();
        expect(h.state, isNot(StationConnection.disconnected));
        final attempts = h.connector.attempts;
        h.connector.last.serverClose(1011);
        async.elapse(const Duration(minutes: 2));
        expect(h.state, StationConnection.disconnected);
        expect(h.connections.last, (StationConnection.disconnected, 1011));
        expect(h.socket.gaveUpCause, 'server_error');
        expect(h.connector.attempts, attempts, reason: 'no retry after the give-up');
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('1011 on a live call: the server holds the call, so the socket keeps trying', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        h.callLive = true;
        for (var i = 0; i < StationSocket.serverErrorLimit + 2; i++) {
          h.dropAndMeasure(1011);
          async.flushMicrotasks();
        }
        expect(h.state, StationConnection.open);
        h.socket.dispose();
      });
    });

    for (final code in [4401, 4408, 1006, null]) {
      test('$code: re-mint and retry on the ladder', () {
        fakeAsync((async) {
          final h = _Harness(async)..openFirst();
          final waited = h.dropAndMeasure(code);
          expect(waited, const Duration(milliseconds: 500));
          async.flushMicrotasks();
          expect(h.mints, 1);
          expect(h.connector.last.url.queryParameters['token'], 'mint1');
          expect(h.connections.map((c) => c.$1), contains(StationConnection.reconnecting));
          if (code != null) expect(h.connections.where((c) => c.$2 == code), isNotEmpty);
          h.socket.dispose();
        });
      });
    }
  });

  test('the ladder: 0.5, 1, 2, 5, 10, 15, 15 s while the server is unreachable', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      h.connector.failWith = const SocketException('unreachable');
      final gaps = <Duration>[];
      var last = h.connector.attempts;
      var since = Duration.zero;
      h.connector.last.serverClose(1006);
      while (gaps.length < 7) {
        async.elapse(const Duration(milliseconds: 100));
        since += const Duration(milliseconds: 100);
        if (h.connector.attempts != last) {
          gaps.add(since);
          since = Duration.zero;
          last = h.connector.attempts;
        }
      }
      expect(gaps.map((d) => d.inMilliseconds), [500, 1000, 2000, 5000, 10000, 15000, 15000]);
      // Every attempt minted a fresh token; none was minted ahead.
      expect(h.mints, 7);
      expect(h.state, StationConnection.reconnecting);
      h.socket.dispose();
      expect(async.pendingTimers, isEmpty);
    });
  });

  test('the ladder resets on a pong, never on open', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      expect(h.dropAndMeasure(1006), const Duration(milliseconds: 500));
      async.flushMicrotasks();
      // Opened, but never proved liveness: the next step is still up the ladder.
      expect(h.state, StationConnection.open);
      expect(h.dropAndMeasure(1006), const Duration(seconds: 1));
      async.flushMicrotasks();
      h.connector.last.serverPong();
      expect(h.dropAndMeasure(1006), const Duration(milliseconds: 500));
      h.socket.dispose();
    });
  });

  test('gives up after 3 heartbeats with a ping unanswered', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      async.elapse(const Duration(seconds: 29));
      expect(h.state, StationConnection.open);
      expect(h.missed.last, 2);
      async.elapse(const Duration(seconds: 1));
      expect(h.state, StationConnection.disconnected);
      expect(h.connector.last.closed, isTrue);
      expect(async.pendingTimers, isEmpty);
    });
  });

  test('...unless a call is live: the server is holding it, so the socket holds too', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      h.callLive = true;
      async.elapse(const Duration(seconds: 90));
      expect(h.state, StationConnection.open);
      expect(h.connector.last.pings.length, greaterThan(5));
      h.callLive = false;
      async.elapse(const Duration(seconds: 10));
      expect(h.state, StationConnection.disconnected);
    });
  });

  test('flap cap: the 7th proven-live-then-dead socket inside 60 s stops retrying', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      for (var i = 0; i < 6; i++) {
        h.connector.last.serverPong();
        h.dropAndMeasure(1006);
        async.flushMicrotasks();
        expect(h.state, StationConnection.open, reason: 'cycle $i');
      }
      h.connector.last.serverPong();
      h.connector.last.serverClose(1006);
      expect(h.state, StationConnection.disconnected);
      async.elapse(const Duration(minutes: 1));
      expect(h.connector.attempts, 7);
    });
  });

  test('...but never while a call is live: the server is holding it, so the socket keeps trying', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      h.callLive = true;
      for (var i = 0; i < 6; i++) {
        h.connector.last.serverPong();
        h.dropAndMeasure(1006);
        async.flushMicrotasks();
      }
      h.connector.last.serverPong();
      h.dropAndMeasure(1006);
      async.flushMicrotasks();
      expect(h.state, StationConnection.open);
      expect(h.connector.attempts, 8);
      h.socket.dispose();
    });
  });

  test('a socket that never proves liveness is not a flap: it just walks the ladder', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      for (var i = 0; i < 10; i++) {
        h.dropAndMeasure(1006);
        async.flushMicrotasks();
      }
      expect(h.state, StationConnection.open);
      h.socket.dispose();
    });
  });

  group('tokens', () {
    test('a NEW token per reconnect, and the bootstrap token only once', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        for (var i = 1; i <= 3; i++) {
          h.connector.last.serverPong();
          h.dropAndMeasure(4401);
          async.flushMicrotasks();
          expect(h.connector.last.url.queryParameters['token'], 'mint$i');
        }
        expect(h.mints, 3);
        expect(h.connector.opened.where((t) => t.url.queryParameters['token'] == 'boot'), hasLength(1));
        h.socket.dispose();
      });
    });

    test('a bootstrap token that is about to lapse is not used: mint instead', () {
      fakeAsync((async) {
        final h = _Harness(async, tokenExpiresAt: DateTime.utc(2026, 11, 1, 9, 0, 3))..openFirst();
        expect(h.mints, 1);
        expect(h.connector.last.url.queryParameters['token'], 'mint1');
        h.socket.dispose();
      });
    });

    test('a mint that hangs is abandoned after 8 s and retried on the ladder', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        h.mintGate = Completer<String>();
        h.connector.last.serverClose(1006);
        async.elapse(const Duration(milliseconds: 500));
        expect(h.mints, 1);
        async.elapse(const Duration(milliseconds: 7999));
        expect(h.connector.attempts, 1);
        expect(h.mints, 1);
        async.elapse(const Duration(milliseconds: 1));
        // Timed out; next step is 1 s up the ladder.
        async.elapse(const Duration(seconds: 1));
        expect(h.mints, 2);
        h.socket.dispose();
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('an older mint finishing late never cancels the newer mint’s 8 s deadline', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        final older = Completer<String>();
        h.mintGate = older;
        h.connector.last.serverClose(1006);
        async.elapse(const Duration(milliseconds: 500));
        expect(h.mints, 1);
        // The agent taps Reconnect while that mint hangs: a second one starts.
        h.mintGate = Completer<String>();
        h.socket.reconnect();
        async.flushMicrotasks();
        expect(h.mints, 2);
        older.complete('/proxy/agency/station?token=late');
        async.flushMicrotasks();
        expect(h.connector.attempts, 1, reason: 'the late answer belongs to a replaced connect');
        async.elapse(const Duration(seconds: 8));
        // Timed out; retried on the ladder (0.5 s after a reconnect's reset).
        async.elapse(const Duration(milliseconds: 500));
        expect(h.mints, 3);
        h.socket.dispose();
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('a mint the server refuses with 404 means the session is gone', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        h.mintError = const ApiHttpError(status: 404, code: null, message: '', body: {}, requestId: null);
        h.connector.last.serverClose(1006);
        async.elapse(const Duration(seconds: 1));
        expect(h.state, StationConnection.sessionGone);
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('the Firebase ID token is refreshed before a mint when the last refresh is over 50 min old', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        h.socket.markIdTokenFresh();
        h.connector.last.serverPong();
        h.dropAndMeasure(4401);
        async.flushMicrotasks();
        expect(h.refreshes, 0, reason: 'fresh at join');
        // A quiet hour on break in the background: no app pings, no give-up.
        h.socket.setAppPings(false);
        async.elapse(const Duration(minutes: 51));
        h.dropAndMeasure(4401);
        async.flushMicrotasks();
        expect(h.refreshes, 1);
        expect(h.mints, 2);
        h.socket.dispose();
      });
    });
  });

  group('network changes', () {
    test('a pending backoff step is skipped: reconnect at once', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        h.socket.networkChanged([ConnectivityResult.wifi]);
        h.connector.failWith = const SocketException('down');
        h.connector.last.serverClose(1006);
        async.elapse(const Duration(seconds: 9)); // walking up the ladder
        final before = h.connector.attempts;
        h.connector.failWith = null;
        h.socket.networkChanged([ConnectivityResult.mobile]);
        async.flushMicrotasks();
        expect(h.connector.attempts, before + 1);
        expect(h.state, StationConnection.open);
        h.socket.dispose();
      });
    });

    test('an open socket on a transport that went away is replaced at once', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        final old = h.connector.last;
        h.socket.networkChanged([ConnectivityResult.wifi]);
        h.socket.networkChanged([ConnectivityResult.mobile]);
        async.flushMicrotasks();
        expect(old.closed, isTrue);
        expect(h.connector.opened, hasLength(2));
        expect(h.state, StationConnection.open);
        h.socket.dispose();
      });
    });

    test('an addition (Wi-Fi joining 4G) or going offline leaves the socket alone', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        h.socket.networkChanged([ConnectivityResult.mobile]);
        h.socket.networkChanged([ConnectivityResult.mobile, ConnectivityResult.wifi]);
        h.socket.networkChanged([ConnectivityResult.none]);
        async.flushMicrotasks();
        expect(h.connector.opened, hasLength(1));
        h.socket.dispose();
      });
    });
  });

  group('app pings and keep-alive', () {
    test('pings off: no pings and no give-up; back on: a ping at once', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        final t = h.connector.last;
        h.socket.setAppPings(false);
        async.elapse(const Duration(minutes: 2));
        expect(t.pings, hasLength(1));
        expect(h.state, StationConnection.open);
        h.socket.setAppPings(true);
        expect(t.pings, hasLength(2));
        h.socket.dispose();
      });
    });

    test('keep-alive off: a drop parks with no timers; back on: connects at once', () {
      fakeAsync((async) {
        final h = _Harness(async)..openFirst();
        h.socket.setKeepAlive(false);
        h.connector.last.serverClose(1006);
        expect(async.pendingTimers, isEmpty);
        async.elapse(const Duration(minutes: 5));
        expect(h.connector.attempts, 1);
        h.socket.setKeepAlive(true);
        async.flushMicrotasks();
        expect(h.connector.attempts, 2);
        expect(h.state, StationConnection.open);
        h.socket.dispose();
      });
    });
  });

  test('park: the socket closes now, retries nothing while away, and connects again on return', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      final t = h.connector.last;
      h.socket.setKeepAlive(false);
      h.socket.park();
      expect(t.closed, isTrue);
      expect(t.closedWith, 1000);
      expect(h.state, StationConnection.reconnecting);
      expect(async.pendingTimers, isEmpty);
      h.socket.networkChanged([ConnectivityResult.wifi]);
      h.socket.networkChanged([ConnectivityResult.mobile]);
      async.elapse(const Duration(minutes: 5));
      expect(h.connector.attempts, 1, reason: 'parked: not even a network change reconnects it');
      h.socket.setKeepAlive(true);
      async.flushMicrotasks();
      expect(h.connector.attempts, 2);
      expect(h.state, StationConnection.open);
      h.socket.dispose();
    });
  });

  test('binary frames reach onBinary as the very same buffer, never the decoder', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      final frame = Uint8List(160);
      for (var i = 0; i < 100; i++) {
        h.connector.last.serverBinary(frame);
      }
      expect(h.binaries, hasLength(100));
      expect(identical(h.binaries.last, frame), isTrue);
      expect(h.decodes, 0);
      h.socket.sendBinary(frame);
      expect(identical(h.connector.last.lastBinary, frame), isTrue);
      h.socket.dispose();
    });
  });

  test('text frames are decoded once each and pongs stay inside the socket', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      h.connector.last.serverText('{"event":"campaign_state","campaign_id":"c","status":"paused","reason":"paused_by_supervisor","dialing":false,"message":"Paused"}');
      h.connector.last.serverPong();
      expect(h.decodes, 2);
      expect(h.frames.single, isA<CampaignStateFrame>());
      expect(h.pongs, hasLength(1));
      h.socket.dispose();
    });
  });

  test('a frame from a socket that was replaced is ignored', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      final old = h.connector.last;
      h.socket.reconnect();
      async.flushMicrotasks();
      old.serverText('{"event":"campaign_state","campaign_id":"c","status":"paused","reason":"paused_by_supervisor","dialing":false,"message":"x"}');
      old.serverClose(1006);
      expect(h.frames, isEmpty);
      expect(h.state, StationConnection.open);
      h.socket.dispose();
    });
  });

  test('dispose cancels every timer and closes the socket with 1000', () {
    fakeAsync((async) {
      final h = _Harness(async)..openFirst();
      final t = h.connector.last;
      expect(async.pendingTimers, isNotEmpty);
      h.socket.dispose();
      expect(async.pendingTimers, isEmpty);
      expect(t.closedWith, 1000);
      // And nothing comes back to life.
      async.elapse(const Duration(minutes: 5));
      expect(h.connector.attempts, 1);
    });
  });
}
