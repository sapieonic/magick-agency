import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/station/station_controller.dart';
import 'package:magick_agency_agent/features/station/station_copy.dart';

/// `packages/contracts/fixtures/agent/<name>`, found by walking up from the working directory.
/// `tooling/contracts-literals.mjs` writes these from the contract's own declarations.
Map<String, Object?> _fixture(String name) {
  var dir = Directory.current.absolute;
  while (!File('${dir.path}/packages/contracts/fixtures/agent/$name').existsSync()) {
    if (dir.parent.path == dir.path) throw StateError('packages/contracts/fixtures/agent/$name not found');
    dir = dir.parent;
  }
  return jsonDecode(File('${dir.path}/packages/contracts/fixtures/agent/$name').readAsStringSync())
      as Map<String, Object?>;
}

/// Late binding's hidden dials say the same words, and hold "Dialling" for the same time, in the
/// app and the console: both are the contract's (`AGENCY_DIAL_ACTIVITY_COPY`,
/// `AGENCY_DIAL_ACTIVITY_TIMING`), which the console imports and this holds the app to.
void main() {
  final copy = ((_fixture('labels.json')['dial_activity_copy']! as Map<String, Object?>)['labels']!
          as Map<String, Object?>)
      .cast<String, String>();

  test('the hidden dials\' copy is word for word the contract\'s (’ and … included)', () {
    expect(copy.keys.toSet(), {'headline', 'hint', 'unanswered_one', 'unanswered_many'},
        reason: 'the contract\'s dial-activity copy changed shape: say the new words here too');
    expect(StationCopy.diallingHeadline, copy['headline']);
    expect(StationCopy.diallingHint, copy['hint']);
    expect(StationCopy.unansweredOne, copy['unanswered_one']);
    expect(StationCopy.unansweredMany, copy['unanswered_many']);
  });

  test('the count line fills the contract\'s placeholder', () {
    expect(StationCopy.unansweredLine(0), isNull);
    expect(StationCopy.unansweredLine(1), copy['unanswered_one']);
    expect(StationCopy.unansweredLine(2), copy['unanswered_many']!.replaceAll('{count}', '2'));
    expect(StationCopy.unansweredLine(12), 'No answer from the last 12 numbers');
  });

  test('the gap hold is the contract\'s', () {
    final timing = ((_fixture('literals.json')['dial_activity_timing']! as Map<String, Object?>)['values']!
            as Map<String, Object?>)
        .cast<String, int>();
    expect(StationController.dialGapHold, Duration(milliseconds: timing['GAP_HOLD_MS']!));
  });
}
