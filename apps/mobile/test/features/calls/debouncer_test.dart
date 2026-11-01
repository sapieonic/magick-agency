import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/calls/logic/debouncer.dart';

void main() {
  test('a burst of calls runs the last action once, after the pause', () {
    fakeAsync((clock) {
      final d = Debouncer(const Duration(milliseconds: 400));
      final ran = <String>[];
      for (final s in ['9', '98', '984', '9840']) {
        d(() => ran.add(s));
        clock.elapse(const Duration(milliseconds: 150));
      }
      expect(ran, isEmpty);
      expect(d.pending, isTrue);
      clock.elapse(const Duration(milliseconds: 250));
      expect(ran, ['9840']);
      expect(d.pending, isFalse);
    });
  });

  test('flush runs now and drops the pending one; cancel drops it', () {
    fakeAsync((clock) {
      final d = Debouncer(const Duration(milliseconds: 400));
      final ran = <String>[];
      d(() => ran.add('typed'));
      d.flush(() => ran.add('submitted'));
      clock.elapse(const Duration(seconds: 1));
      expect(ran, ['submitted']);

      d(() => ran.add('late'));
      d.cancel();
      clock.elapse(const Duration(seconds: 1));
      expect(ran, ['submitted']);
    });
  });
}
