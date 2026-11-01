import 'dart:io';
import 'dart:typed_data';

import 'package:agent_audio/reference.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/jitter_trace.dart';

const _n = 16;
const _config = JitterBufferConfig(frameSamples: _n);

Int16List _frame(int value) => Int16List(_n)..fillRange(0, _n, value);

void main() {
  late JitterBuffer jb;
  late Int16List out;

  setUp(() {
    jb = JitterBuffer(_config);
    out = Int16List(_n);
  });

  void pushN(int count, [int value = 1000]) {
    for (var i = 0; i < count; i++) {
      jb.push(_frame(value));
    }
  }

  group('prefill', () {
    test('plays silence until the initial target (100 ms) is queued', () {
      pushN(4);
      expect(jb.pop(out), PlayoutKind.silence);
      expect(out, everyElement(0));
      pushN(1);
      expect(jb.pop(out), PlayoutKind.real);
      expect(jb.snapshot.underruns, 0, reason: 'prefill is not an underrun');
      expect(jb.snapshot.silentFrames, 1);
    });

    test('the first real frame fades in over 5 ms, later frames are untouched', () {
      pushN(6, 1000);
      jb.pop(out);
      final f = _config.fadeInSamples;
      for (var j = 0; j < f; j++) {
        expect(out[j], 1000 * j ~/ f);
      }
      for (var j = f; j < _n; j++) {
        expect(out[j], 1000);
      }
      jb.pop(out);
      expect(out, everyElement(1000));
    });
  });

  group('steady flow', () {
    test('one in, one out keeps depth constant with no underruns', () {
      pushN(5);
      for (var i = 0; i < 300; i++) {
        jb.push(_frame(i));
        expect(jb.pop(out), PlayoutKind.real);
      }
      final s = jb.snapshot;
      expect(s.depthFrames, 5, reason: 'one pushed and one played per tick keeps the target queued');
      expect(s.underruns, 0);
      expect(s.playedFrames, 300);
      expect(s.receivedFrames, 305);
    });

    test('frames come out in arrival order', () {
      for (var i = 1; i <= 5; i++) {
        jb.push(_frame(i * 100));
      }
      jb.pop(out); // faded
      for (var i = 2; i <= 5; i++) {
        jb.pop(out);
        expect(out[_n - 1], i * 100);
      }
    });
  });

  group('underrun', () {
    test('conceals 60 ms with a linear fade of the last frame, then silence', () {
      pushN(5, 3000);
      for (var i = 0; i < 5; i++) {
        jb.pop(out);
      }
      final total = _config.concealFrames * _n;
      for (var c = 0; c < 3; c++) {
        expect(jb.pop(out), PlayoutKind.concealed);
        for (var j = 0; j < _n; j++) {
          expect(out[j], 3000 * (total - (c * _n + j)) ~/ total);
        }
      }
      expect(jb.pop(out), PlayoutKind.silence);
      expect(out, everyElement(0));
      final s = jb.snapshot;
      expect(s.underruns, 1, reason: 'one gap is one underrun however long it lasts');
      expect(s.concealedFrames, 3);
      expect(s.silentFrames, 1);
    });

    test('grows the target by 40 ms and refills to it before playing again', () {
      pushN(5);
      for (var i = 0; i < 6; i++) {
        jb.pop(out);
      }
      expect(jb.targetFrames, 7);
      pushN(6);
      expect(jb.pop(out), isNot(PlayoutKind.real), reason: '6 queued < target 7');
      pushN(1);
      expect(jb.pop(out), PlayoutKind.real);
    });

    test('target never exceeds the maximum (240 ms)', () {
      for (var gap = 0; gap < 10; gap++) {
        pushN(jb.targetFrames);
        while (jb.pop(out) == PlayoutKind.real || jb.depthFrames > 0) {}
      }
      expect(jb.targetFrames, _config.maxTargetFrames);
      expect(jb.snapshot.underruns, greaterThanOrEqualTo(4));
    });

    test('a frame arriving mid-concealment fades in rather than clicking', () {
      pushN(5, 2000);
      for (var i = 0; i < 6; i++) {
        jb.pop(out); // 5 real + 1 concealed
      }
      pushN(7, 2000);
      jb.pop(out);
      expect(out[0], 0);
      expect(out[_n - 1], 2000);
    });
  });

  group('overflow', () {
    test('a push into a full buffer drops the oldest frame', () {
      for (var i = 1; i <= 20; i++) {
        jb.push(_frame(i));
      }
      final s = jb.snapshot;
      expect(s.depthFrames, _config.capacityFrames);
      expect(s.overflowDrops, 4);
      jb.pop(out);
      expect(out[_n - 1], 5, reason: 'frames 1-4 were dropped');
    });
  });

  group('latency trim', () {
    test('drains excess depth one frame per 25 pops while above target + slack', () {
      pushN(12); // target 5, slack 2: 5 frames of excess
      for (var i = 0; i < 24; i++) {
        jb.push(_frame(1));
        jb.pop(out);
      }
      expect(jb.snapshot.latencyDrops, 0);
      jb.push(_frame(1));
      jb.pop(out);
      expect(jb.snapshot.latencyDrops, 1);
      for (var i = 0; i < 500; i++) {
        jb.push(_frame(1));
        jb.pop(out);
      }
      // Depth settles at target + slack (+ the frame pushed this tick, before the pop).
      expect(jb.depthFrames, lessThanOrEqualTo(jb.targetFrames + _config.trimSlackFrames));
      expect(jb.snapshot.underruns, 0);
    });
  });

  group('shrink', () {
    test('after 10 s without an underrun the target shrinks by 20 ms, down to 80 ms', () {
      pushN(5);
      for (var i = 0; i < 499; i++) {
        jb.push(_frame(1));
        jb.pop(out);
      }
      expect(jb.targetFrames, 5);
      jb.push(_frame(1));
      jb.pop(out);
      expect(jb.targetFrames, 4);
      for (var i = 0; i < 2000; i++) {
        jb.push(_frame(1));
        jb.pop(out);
      }
      expect(jb.targetFrames, _config.minTargetFrames);
    });

    test('an underrun restarts the stability count', () {
      pushN(5);
      for (var i = 0; i < 400; i++) {
        jb.push(_frame(1));
        jb.pop(out);
      }
      while (jb.depthFrames > 0) {
        jb.pop(out);
      }
      jb.pop(out); // underrun → target 7
      pushN(7);
      for (var i = 0; i < 400; i++) {
        jb.push(_frame(1));
        jb.pop(out);
      }
      expect(jb.targetFrames, 7, reason: '400 stable frames since the underrun is not enough');
    });
  });

  test('reset returns to the initial state', () {
    pushN(20);
    jb.pop(out);
    jb.reset();
    expect(jb.snapshot, const JitterSnapshot(
      depthFrames: 0,
      targetFrames: 5,
      underruns: 0,
      concealedFrames: 0,
      silentFrames: 0,
      overflowDrops: 0,
      latencyDrops: 0,
      receivedFrames: 0,
      playedFrames: 0,
    ));
    expect(jb.pop(out), PlayoutKind.silence, reason: 'no last frame to conceal after reset');
  });

  test('push reads from an offset (native re-framing writes into a shared scratch buffer)', () {
    final big = Int16List(_n * 2)..fillRange(_n, _n * 2, 77);
    for (var i = 0; i < 6; i++) {
      jb.push(big, _n);
    }
    jb.pop(out);
    jb.pop(out);
    expect(out, everyElement(77));
  });

  group('cross-language trace', () {
    test('test/fixtures/jitter_trace.txt matches this model', () {
      final trace = generateJitterTrace();
      final file = File('test/fixtures/jitter_trace.txt');
      if (Platform.environment['UPDATE_JITTER_TRACE'] == '1') {
        file.writeAsStringSync(trace);
      }
      expect(file.existsSync(), isTrue, reason: 'run with UPDATE_JITTER_TRACE=1 to create it');
      expect(file.readAsStringSync(), trace,
          reason: 'the model changed: regenerate the fixture and re-run the Kotlin trace test');
    });

    test('the trace exercises every behaviour it is meant to pin', () {
      final lines = generateJitterTrace().split('\n');
      final last = lines.lastWhere((l) => l.startsWith('stats ')).split(' ');
      final underruns = int.parse(last[3]);
      final overflow = int.parse(last[6]);
      final trimmed = int.parse(last[7]);
      expect(underruns, greaterThan(5));
      expect(overflow, greaterThan(0));
      expect(trimmed, greaterThan(0));
      expect(lines.where((l) => l.startsWith('pop concealed')), isNotEmpty);
      expect(lines.where((l) => l.startsWith('pop silence')), isNotEmpty);
      final targets = lines.where((l) => l.startsWith('stats ')).map((l) => int.parse(l.split(' ')[2])).toSet();
      expect(targets, containsAll(<int>[4, 12]), reason: 'reaches both the minimum and the maximum target');
    });
  });
}
