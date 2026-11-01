import 'package:agent_audio/agent_audio.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const earpiece = {'kind': 'earpiece', 'id': 'earpiece', 'name': 'Phone'};
  const bt = {'kind': 'bluetooth', 'id': 'bt:7', 'name': 'boAt Airdopes 141'};

  test('route', () {
    expect(
      AudioEvent.decode({
        'type': 'route',
        'current': bt,
        'available': [earpiece, bt, 'junk'],
        'reason': 'newDevice',
      }),
      const AudioRouteChanged(
        current: AudioRoute(kind: AudioRouteKind.bluetooth, id: 'bt:7', name: 'boAt Airdopes 141'),
        available: [
          AudioRoute(kind: AudioRouteKind.earpiece, id: 'earpiece', name: 'Phone'),
          AudioRoute(kind: AudioRouteKind.bluetooth, id: 'bt:7', name: 'boAt Airdopes 141'),
        ],
        reason: RouteChangeReason.newDevice,
      ),
    );
    final none = AudioEvent.decode({'type': 'route'})! as AudioRouteChanged;
    expect(none.current, isNull);
    expect(none.available, isEmpty);
    expect(none.reason, RouteChangeReason.other);
  });

  test('interruption began / ended', () {
    expect(
      AudioEvent.decode({'type': 'interruption', 'phase': 'began', 'reason': 'phoneCall'}),
      const AudioInterruptionBegan(reason: InterruptionReason.phoneCall),
    );
    expect(
      AudioEvent.decode({'type': 'interruption', 'phase': 'ended', 'reason': 'focusLoss', 'shouldResume': true}),
      const AudioInterruptionEnded(reason: InterruptionReason.focusLoss, shouldResume: true),
    );
  });

  test('noisy, session, reset', () {
    expect(AudioEvent.decode({'type': 'noisy'}), const AudioBecomingNoisy());
    expect(AudioEvent.decode({'type': 'session', 'active': true}), const AudioSessionActivation(active: true));
    expect(AudioEvent.decode({'type': 'callReset'}), const CallSystemReset());
  });

  test('on-duty service stopped', () {
    expect(AudioEvent.decode({'type': 'service', 'running': false}), const OnDutyServiceStopped());
    expect(AudioEvent.decode({'type': 'service', 'running': true}), isNull, reason: 'a start is a method result');
    expect(AudioEvent.decode({'type': 'service'}), isNull);
  });

  test('error', () {
    expect(
      AudioEvent.decode({'type': 'error', 'code': 'media_services_reset', 'message': 'reset', 'recovered': true}),
      const AudioErrorEvent(code: AgentAudioErrorCode.mediaServicesReset, message: 'reset', recovered: true),
    );
  });

  test('level, with the meter scale', () {
    final e = AudioEvent.decode({'type': 'level', 'dbfs': -30})! as InputLevel;
    expect(e.dbfs, -30.0);
    expect(e.normalized, 0.5);
    expect(const InputLevel(-90).normalized, 0);
    expect(const InputLevel(3).normalized, 1);
  });

  test('jitter stats', () {
    final e = AudioEvent.decode({
      'type': 'jitter',
      'depth': 6,
      'target': 7,
      'underruns': 2,
      'concealed': 6,
      'silent': 10,
      'overflowDrops': 1,
      'latencyDrops': 3,
      'received': 500,
      'played': 490,
      'uplinkDrops': 0,
    })! as JitterStats;
    expect(e.depthMs, 120);
    expect(e.targetMs, 140);
    expect(e.underruns, 2);
    expect(e.latencyDrops, 3);
    expect(e.playedFrames, 490);
  });

  test('call actions', () {
    expect(
      AudioEvent.decode({'type': 'callAction', 'action': 'end', 'callId': 'c1', 'source': 'callKit'}),
      const CallSystemAction(kind: CallActionKind.end, source: CallActionSource.callKit, callId: 'c1'),
    );
    expect(
      AudioEvent.decode({'type': 'callAction', 'action': 'mute', 'muted': true, 'source': 'notification'}),
      const CallSystemAction(kind: CallActionKind.mute, source: CallActionSource.notification, muted: true),
    );
    expect(AudioEvent.decode({'type': 'callAction', 'action': 'hold'}), isNull);
  });

  test('unknown and malformed messages decode to null', () {
    expect(AudioEvent.decode(null), isNull);
    expect(AudioEvent.decode('route'), isNull);
    expect(AudioEvent.decode({'type': 'teleport'}), isNull);
  });
}
