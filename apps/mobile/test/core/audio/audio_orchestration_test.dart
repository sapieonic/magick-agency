import 'dart:typed_data';

import 'package:agent_audio/agent_audio.dart' as audio;
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/audio/audio_orchestrator.dart';
import 'package:magick_agency_agent/core/audio/fake_audio_engine.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';
import 'package:magick_agency_agent/core/telemetry/log.dart';

import '../station/controller_harness.dart';

const _note = audio.OnDutyNotification(title: 'On duty', text: 'Waiting for calls', channelName: 'On duty');
const _earpiece = audio.AudioRoute(kind: audio.AudioRouteKind.earpiece, id: 'ear', name: '');
const _speaker = audio.AudioRoute(kind: audio.AudioRouteKind.speaker, id: 'spk', name: '');
const _headset = audio.AudioRoute(kind: audio.AudioRouteKind.wired, id: 'wired', name: '');

class _Rig {
  _Rig(this.async) {
    orchestrator = AudioOrchestrator(
      engine: engine,
      sendUplink: uplink.add,
      onChanged: () => changes++,
      onSystemHangUp: () => hangUps++,
    );
  }

  final FakeAsync async;
  final engine = FakeAudioEngine();
  final uplink = <Uint8List>[];
  late final AudioOrchestrator orchestrator;
  int changes = 0;
  int hangUps = 0;

  void sync(AudioTarget t) {
    orchestrator.sync(t);
    async.flushMicrotasks();
  }

  void event(audio.AudioEvent e) {
    engine.emitEvent(e);
    async.flushMicrotasks();
  }
}

const _reserved = AudioTarget(attemptId: 'att-1', displayName: 'Asha Rao', handle: '+919876543210');
const _bridged = AudioTarget(attemptId: 'att-1', bridged: true, displayName: 'Asha Rao', handle: '+919876543210');

void main() {
  group('orchestration order', () {
    test('prepare at open → CallKit + arm at reserved → uplink + connected at bridged → endCall + stop at released', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        async.flushMicrotasks();
        expect(r.engine.calls, ['fgs.start', 'prepare']);
        r.sync(_reserved);
        expect(r.engine.calls.skip(2), ['startCall', 'arm']);
        expect(r.engine.startedCalls.single, (callId: 'att-1', displayName: 'Asha Rao', handle: '+919876543210'));
        r.sync(_bridged);
        r.sync(_bridged); // restated: nothing new
        expect(r.engine.calls.skip(4), ['uplink', 'connected']);
        r.sync(const AudioTarget(endReason: audio.CallEndReason.remoteEnded));
        expect(r.engine.calls.skip(6), ['endCall', 'stop']);
        expect(r.engine.endedCalls.single.reason, audio.CallEndReason.remoteEnded);
        r.orchestrator.prewarm();
        async.flushMicrotasks();
        expect(r.engine.calls.last, 'prepare', reason: 'pre-warmed again for the next call');
      });
    });

    test('released then reserved back to back: the old call ends before the new one starts', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.sync(_bridged);
        r.sync(const AudioTarget(attemptId: 'att-2', displayName: '+91…', handle: '+91…'));
        expect(r.engine.lifecycle, ['fgs.start', 'prepare', 'startCall', 'arm', 'uplink', 'connected', 'endCall', 'stop', 'startCall', 'arm']);
      });
    });

    test('a reconnect onto a live, bridged call arms and opens the uplink in one go', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.sync(_bridged);
        expect(r.engine.lifecycle, ['fgs.start', 'prepare', 'startCall', 'arm', 'uplink', 'connected']);
      });
    });

    test('leave: the call ends, the session is released, the on-duty service stops', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.sync(_reserved);
        var closed = false;
        r.orchestrator.close().then((_) => closed = true);
        async.flushMicrotasks();
        expect(closed, isTrue);
        expect(r.engine.calls.skip(4), ['endCall', 'release', 'fgs.stop']);
      });
    });

    test('uplink frames go to the socket as the same buffers; downlink goes straight to the engine', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        final frame = Uint8List(160);
        r.engine.emitUplink(frame);
        expect(identical(r.uplink.single, frame), isTrue);
        r.orchestrator.playFrame(frame);
        expect(identical(r.engine.lastPlayed, frame), isTrue);
      });
    });
  });

  group('the phone gets in the way', () {
    test('a phone call mid-call mutes and says why; when it ends, the mute it added is undone', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.sync(_bridged);
        r.event(const audio.AudioInterruptionBegan(reason: audio.InterruptionReason.phoneCall));
        expect(r.orchestrator.view.interruption, AudioInterruption.phoneCall);
        expect(r.orchestrator.view.muted, isTrue);
        expect(r.engine.muted, isTrue);
        r.event(const audio.AudioInterruptionEnded(reason: audio.InterruptionReason.phoneCall, shouldResume: true));
        expect(r.orchestrator.view.interruption, AudioInterruption.none);
        expect(r.orchestrator.view.muted, isFalse);
      });
    });

    test('a phone call that ends before the engine confirms the mute still unmutes', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.sync(_bridged);
        // Both events before the mute's platform call returns.
        r.engine.emitEvent(const audio.AudioInterruptionBegan(reason: audio.InterruptionReason.phoneCall));
        r.engine.emitEvent(const audio.AudioInterruptionEnded(reason: audio.InterruptionReason.phoneCall, shouldResume: true));
        async.flushMicrotasks();
        expect(r.orchestrator.view.muted, isFalse);
        expect(r.engine.muted, isFalse, reason: 'the customer hears the agent again');
      });
    });

    test('...but an agent who muted themselves stays muted', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.sync(_bridged);
        r.orchestrator.setMuted(true);
        async.flushMicrotasks();
        r.event(const audio.AudioInterruptionBegan(reason: audio.InterruptionReason.phoneCall));
        r.event(const audio.AudioInterruptionEnded(reason: audio.InterruptionReason.phoneCall, shouldResume: true));
        expect(r.orchestrator.view.muted, isTrue);
      });
    });

    test('another app taking audio is reported as such', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.event(const audio.AudioInterruptionBegan(reason: audio.InterruptionReason.focusLoss));
        expect(r.orchestrator.view.interruption, AudioInterruption.otherApp);
      });
    });

    test('a headset unplugged never leaves the call on the loudspeaker', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.sync(_bridged);
        r.event(const audio.AudioRouteChanged(current: _headset, available: [_earpiece, _speaker, _headset], reason: audio.RouteChangeReason.newDevice));
        expect(r.orchestrator.view.route?.kind, AudioRouteKind.wired);
        expect(r.orchestrator.view.route?.name, 'Headphones');
        r.event(const audio.AudioBecomingNoisy());
        r.event(const audio.AudioRouteChanged(current: _speaker, available: [_earpiece, _speaker], reason: audio.RouteChangeReason.deviceRemoved));
        expect(r.engine.calls.last, 'route:ear');
      });
    });

    test('an unchanged route list keeps its identity', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.event(const audio.AudioRouteChanged(current: _earpiece, available: [_earpiece, _speaker], reason: audio.RouteChangeReason.other));
        final routes = r.orchestrator.view.routes;
        expect(routes.map((o) => o.name), ['Phone', 'Speaker']);
        r.event(const audio.AudioRouteChanged(current: _speaker, available: [_earpiece, _speaker], reason: audio.RouteChangeReason.requested));
        expect(identical(r.orchestrator.view.routes, routes), isTrue);
        expect(r.orchestrator.view.route?.kind, AudioRouteKind.speaker);
      });
    });

    test('microphone permission refused at reserved shows as a mic problem, and outlives the call', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.engine.fail['arm'] = const audio.AgentAudioException(audio.AgentAudioErrorCode.permissionDenied);
        r.sync(_reserved);
        expect(r.orchestrator.view.micProblem, MicProblem.permissionDenied);
        r.sync(AudioTarget.idle);
        expect(r.orchestrator.view.micProblem, MicProblem.permissionDenied);
        r.sync(const AudioTarget(attemptId: 'att-2'));
        expect(r.orchestrator.view.micProblem, MicProblem.none, reason: 'arming worked this time');
      });
    });

    test('an on-duty service refused at open is a mic problem, retried on return to the app until it runs', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.engine.fail['fgs.start'] = const audio.AgentAudioException(audio.AgentAudioErrorCode.notInForeground);
        r.orchestrator.open(_note);
        async.flushMicrotasks();
        expect(r.orchestrator.view.micProblem, MicProblem.lost);
        // A call that arms fine does not hide it: the service is still down.
        r.sync(_reserved);
        expect(r.orchestrator.view.micProblem, MicProblem.lost);
        r.engine.fail['fgs.start'] = const audio.AgentAudioException(audio.AgentAudioErrorCode.permissionDenied);
        r.orchestrator.resumed();
        async.flushMicrotasks();
        expect(r.orchestrator.view.micProblem, MicProblem.permissionDenied);
        r.orchestrator.resumed();
        async.flushMicrotasks();
        expect(r.orchestrator.view.micProblem, MicProblem.none);
        expect(r.engine.calls.where((c) => c == 'fgs.start'), hasLength(3));
        expect(r.engine.notification, _note);
        r.orchestrator.resumed();
        async.flushMicrotasks();
        expect(r.engine.calls.where((c) => c == 'fgs.start'), hasLength(3), reason: 'running: never started twice');
      });
    });

    test('a lost microphone is shown until the plugin recovers it', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.event(const audio.AudioErrorEvent(code: audio.AgentAudioErrorCode.lost, message: ''));
        expect(r.orchestrator.view.micProblem, MicProblem.lost);
        r.event(const audio.AudioErrorEvent(code: audio.AgentAudioErrorCode.lost, message: '', recovered: true));
        expect(r.orchestrator.view.micProblem, MicProblem.none);
      });
    });

    test('CallKit refusing the call (a cellular call is up) still arms, and says why audio may be silent', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.engine.fail['startCall'] = const audio.AgentAudioException(audio.AgentAudioErrorCode.callSystem);
        r.sync(_reserved);
        expect(r.engine.calls.last, 'arm');
        expect(r.orchestrator.view.interruption, AudioInterruption.phoneCall);
      });
    });
  });

  group('system call controls', () {
    test('hang-up from CallKit or the notification is the Hang up button; mute is mirrored', () {
      fakeAsync((async) {
        final r = _Rig(async);
        r.orchestrator.open(_note);
        r.sync(_bridged);
        r.event(const audio.CallSystemAction(kind: audio.CallActionKind.mute, source: audio.CallActionSource.notification, muted: true));
        expect(r.orchestrator.view.muted, isTrue);
        r.event(const audio.CallSystemAction(kind: audio.CallActionKind.end, source: audio.CallActionSource.callKit, callId: 'other'));
        expect(r.hangUps, 0, reason: 'not this call');
        r.event(const audio.CallSystemAction(kind: audio.CallActionKind.end, source: audio.CallActionSource.callKit, callId: 'att-1'));
        r.event(const audio.CallSystemReset());
        expect(r.hangUps, 2);
      });
    });
  });

  group('through the station', () {
    test('frames drive the engine in order, CallKit shows the contact’s name, and the notification follows the phase', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.readyFrame('available');
        app.agentStateFrame('available');
        expect(app.engine.notification!.text, 'Waiting for calls');
        app.reserved('att-1');
        app.agentStateFrame('reserved');
        app.bridged('att-1');
        app.agentStateFrame('on_call');
        expect(app.engine.notification!.call, isNotNull);
        app.releasedFrame('att-1');
        app.agentStateFrame('wrapup');
        expect(app.engine.lifecycle, ['fgs.start', 'prepare', 'startCall', 'arm', 'uplink', 'connected', 'endCall', 'stop']);
        expect(app.engine.startedCalls.single.displayName, 'Asha Rao');
        expect(app.engine.endedCalls.single.reason, audio.CallEndReason.remoteEnded);
        expect(app.engine.notification!.text, 'Wrapping up');
        app.dispose();
      });
    });

    test('Hang up on the lock screen hangs up through the API', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        app.routes['POST /proxy/agency/attempts/att-1/hangup'] =
            (_) => json(200, {'campaign_id': 'camp-1', 'attempt_id': 'att-1', 'state': 'bridged'});
        app.engine.emitEvent(const audio.CallSystemAction(kind: audio.CallActionKind.end, source: audio.CallActionSource.callKit, callId: 'att-1'));
        async.flushMicrotasks();
        expect(app.requests('POST', '/proxy/agency/attempts/att-1/hangup'), hasLength(1));
        app.dispose();
      });
    });

    test('joined from the background: the on-duty service starts when the agent comes back', () {
      fakeAsync((async) {
        final app = App(async);
        app.engine.fail['fgs.start'] = const audio.AgentAudioException(audio.AgentAudioErrorCode.notInForeground);
        app.start();
        async.flushMicrotasks();
        expect(app.view!.audio.micProblem, isNot(MicProblem.none));
        app.lifecycle.hide();
        async.flushMicrotasks();
        app.lifecycle.show();
        async.flushMicrotasks();
        expect(app.engine.calls.where((c) => c == 'fgs.start'), hasLength(2));
        expect(app.view!.audio.micProblem, MicProblem.none);
        app.dispose();
      });
    });

    test('superseded: the call moved to the other device, so this one lets go of the audio', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        app.socket.serverClose(4409);
        async.flushMicrotasks();
        expect(app.engine.lifecycle.skip(6), ['endCall', 'stop']);
        app.dispose();
      });
    });

    test('a 10-minute call at 50 frames/s each way: no JSON on the media path, nothing that grows', () {
      fakeAsync((async) {
        final app = App(async)..start();
        app.onCall('att-1');
        final t = app.socket;
        final down = Uint8List(160);
        final up = Uint8List(160);
        final decodesBefore = app.decodes;
        final textSentBefore = t.sentText.length;
        final viewsBefore = app.views.length;
        final logsBefore = Log.recent().length;
        var pongs = 0;
        var lastPings = t.pings.length;

        for (var second = 0; second < 600; second++) {
          for (var i = 0; i < 50; i++) {
            t.serverBinary(down);
            app.engine.emitUplink(up);
          }
          async.elapse(const Duration(seconds: 1));
          if (t.pings.length != lastPings) {
            lastPings = t.pings.length;
            t.serverPong();
            pongs++;
          }
        }

        expect(app.engine.playedFrames, 30000);
        expect(t.sentBinary, 30000);
        expect(identical(app.engine.lastPlayed, down), isTrue, reason: 'no copy on the way down');
        expect(identical(t.lastBinary, up), isTrue, reason: 'no copy on the way up');
        // The decoder saw only the pongs: not one media frame.
        expect(app.decodes - decodesBefore, pongs);
        // Text out: only the heartbeat, every 10 s.
        expect(t.sentText.length - textSentBefore, 60);
        expect(t.sentText.skip(textSentBefore).every((s) => s.startsWith('{"event":"ping"')), isTrue);
        // No state, view or log line per frame.
        expect(app.views.length - viewsBefore, lessThan(pongs + 1));
        expect(Log.recent().length - logsBefore, lessThan(10));
        expect(app.view!.link, StationLink.open);
        app.dispose();
      });
    });
  });
}
