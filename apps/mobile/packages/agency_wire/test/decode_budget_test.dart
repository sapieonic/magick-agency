// A coarse guard on the station decoder's cost. The bound is deliberately
// generous (about 50x what a debug-mode VM takes on a laptop) so CI noise
// never fails it; what it catches is an accidental order-of-magnitude
// regression such as re-parsing per field. The measured time is printed.

import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

void main() {
  test('decodes 10 000 pong + 10 000 agent_state frames well under budget', () {
    const pong = '{"event":"pong","ts":1793428800123,"server_ts":1793428800171}';
    const agentState =
        '{"event":"agent_state","state":"break","break_reason":"lunch",'
        '"since":"2026-11-01T07:30:00.000Z","pending_state":"available"}';
    const n = 10000;

    // Warm-up, so the JIT is measured rather than the first compile.
    for (var i = 0; i < 2000; i++) {
      StationFrame.decode(pong);
      StationFrame.decode(agentState);
    }

    var checksum = 0;
    final sw = Stopwatch()..start();
    for (var i = 0; i < n; i++) {
      final p = StationFrame.decode(pong);
      final a = StationFrame.decode(agentState);
      if (p is PongFrame) checksum += p.serverTs & 1;
      if (a is AgentStateFrame && a.state == AgentState.onBreak) checksum++;
    }
    sw.stop();

    final perFrameUs = sw.elapsedMicroseconds / (2 * n);
    // ignore: avoid_print
    print('decoded ${2 * n} frames in ${sw.elapsedMilliseconds} ms (${perFrameUs.toStringAsFixed(2)} µs/frame)');
    expect(checksum, 2 * n, reason: 'every frame must decode to its type');
    expect(sw.elapsed, lessThan(const Duration(seconds: 2)));
  });

  test('the media fast path decodes 50 000 server media frames well under budget', () {
    final payload = 'A' * 852; // base64 of 640 bytes of PCM16 (20 ms at 16 kHz)
    final text = '{"event":"media","media":{"payload":"$payload"}}';
    const n = 50000;
    for (var i = 0; i < 2000; i++) {
      StationFrame.decode(text);
    }
    var bytes = 0;
    final sw = Stopwatch()..start();
    for (var i = 0; i < n; i++) {
      final f = StationFrame.decode(text);
      if (f is MediaFrame) bytes += f.payload.length;
    }
    sw.stop();
    // ignore: avoid_print
    print(
      'decoded $n media frames in ${sw.elapsedMilliseconds} ms '
      '(${(sw.elapsedMicroseconds / n).toStringAsFixed(2)} µs/frame)',
    );
    expect(bytes, n * payload.length);
    expect(sw.elapsed, lessThan(const Duration(seconds: 3)));
  });
}
