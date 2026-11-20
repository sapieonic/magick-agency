import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/telemetry/log.dart';

/// The station's tests check that nothing is left on the fake clock (a leave leaves no timer, say).
/// A burst of log lines must not leave one there: printing never depends on the machine's real
/// clock (`test/flutter_test_config.dart`).
void main() {
  test('a burst of log lines inside fakeAsync leaves no timer behind', () {
    fakeAsync((async) {
      final log = Log('burst');
      // Well past debugPrint's 12 KB-per-second throttle.
      for (var i = 0; i < 400; i++) {
        log.info('station line $i ${'x' * 80}');
      }
      async.flushMicrotasks();
      expect(async.pendingTimers, isEmpty, reason: async.pendingTimersDebugString.join('\n'));
    });
  });
}
