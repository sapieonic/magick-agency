import 'package:agent_audio/agent_audio.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('AgentAudioFormat', () {
    test('frame sizes match the station socket contract', () {
      expect(AgentAudioFormat.alaw8.frameBytes, 160);
      expect(AgentAudioFormat.alaw8.frameSamples, 160);
      expect(AgentAudioFormat.alaw8.wireName, 'alaw8');
      expect(AgentAudioFormat.pcm16.frameBytes, 640);
      expect(AgentAudioFormat.pcm16.frameSamples, 320);
      expect(AgentAudioFormat.pcm16.wireName, 'pcm16');
    });
  });

  group('AgentAudioPhase.after', () {
    const idle = AgentAudioPhase.idle;
    const prepared = AgentAudioPhase.prepared;
    const armed = AgentAudioPhase.armed;
    const streaming = AgentAudioPhase.streaming;

    // The whole table: null means the op is refused.
    const table = <AgentAudioPhase, Map<AudioOp, AgentAudioPhase?>>{
      idle: {
        AudioOp.prepare: prepared,
        AudioOp.arm: null,
        AudioOp.startUplink: null,
        AudioOp.stopKeepWarm: idle,
        AudioOp.release: idle,
        AudioOp.loopback: null,
      },
      prepared: {
        AudioOp.prepare: prepared,
        AudioOp.arm: armed,
        AudioOp.startUplink: null,
        AudioOp.stopKeepWarm: prepared,
        AudioOp.release: idle,
        AudioOp.loopback: prepared,
      },
      armed: {
        AudioOp.prepare: null,
        AudioOp.arm: armed,
        AudioOp.startUplink: streaming,
        AudioOp.stopKeepWarm: prepared,
        AudioOp.release: idle,
        AudioOp.loopback: null,
      },
      streaming: {
        AudioOp.prepare: null,
        AudioOp.arm: streaming,
        AudioOp.startUplink: streaming,
        AudioOp.stopKeepWarm: prepared,
        AudioOp.release: idle,
        AudioOp.loopback: null,
      },
    };

    for (final from in AgentAudioPhase.values) {
      for (final op in AudioOp.values) {
        final to = table[from]![op];
        test('${from.name} --${op.name}--> ${to?.name ?? 'refused'}', () {
          if (to == null) {
            expect(
              () => from.after(op),
              throwsA(isA<AgentAudioException>().having(
                (e) => e.code,
                'code',
                from == idle ? AgentAudioErrorCode.notPrepared : AgentAudioErrorCode.invalidState,
              )),
            );
          } else {
            expect(from.after(op), to);
          }
        });
      }
    }
  });

  group('AudioRoute', () {
    test('round-trips through the channel map and compares by value', () {
      const r = AudioRoute(kind: AudioRouteKind.bluetooth, id: 'bt:1', name: 'boAt Airdopes 141');
      expect(AudioRoute.fromMap(r.toMap()), r);
      expect(r.hashCode, AudioRoute.fromMap(r.toMap()).hashCode);
    });

    test('tolerates missing and unknown fields', () {
      final r = AudioRoute.fromMap(const {'kind': 'hologram'});
      expect(r, const AudioRoute(kind: AudioRouteKind.earpiece, id: '', name: ''));
    });
  });

  group('AgentAudioErrorCode', () {
    test('every code round-trips through its wire name', () {
      for (final c in AgentAudioErrorCode.values) {
        expect(AgentAudioErrorCode.fromWire(c.wireName), c);
      }
      expect(AgentAudioErrorCode.fromWire('something_new'), AgentAudioErrorCode.unknown);
    });
  });

  group('OnDutyNotification', () {
    test('serialises the call block with the timer as epoch milliseconds', () {
      final at = DateTime.utc(2026, 11, 1, 9, 30);
      final n = OnDutyNotification(
        title: 'On a call',
        text: 'Priya Sharma',
        channelName: 'On duty',
        call: OnDutyCall(muted: true, muteLabel: 'Mute', unmuteLabel: 'Unmute', hangUpLabel: 'Hang up', connectedAt: at),
      );
      expect(n.toMap(), {
        'title': 'On a call',
        'text': 'Priya Sharma',
        'channelName': 'On duty',
        'call': {
          'muted': true,
          'muteLabel': 'Mute',
          'unmuteLabel': 'Unmute',
          'hangUpLabel': 'Hang up',
          'connectedAtMs': at.millisecondsSinceEpoch,
        },
      });
      expect(const OnDutyNotification(title: 'a', text: 'b', channelName: 'c').toMap()['call'], isNull);
    });
  });
}
