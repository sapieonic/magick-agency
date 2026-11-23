import 'dart:convert';
import 'dart:io';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/calls/logic/attempt_copy.dart';
import 'package:magick_agency_agent/ui/primitives.dart';

/// A label map from `packages/contracts/fixtures/agent/labels.json`, which
/// `tooling/contracts-literals.mjs` extracts from the contract's own maps
/// (`ATTEMPT_STATE_LABELS`, `ATTEMPT_OUTCOME_LABELS`), found by walking up from
/// the working directory.
Map<String, String> contractLabels(String map) {
  var dir = Directory.current.absolute;
  while (!File('${dir.path}/packages/contracts/fixtures/agent/labels.json').existsSync()) {
    if (dir.parent.path == dir.path) throw StateError('packages/contracts/fixtures/agent/labels.json not found');
    dir = dir.parent;
  }
  final doc = jsonDecode(File('${dir.path}/packages/contracts/fixtures/agent/labels.json').readAsStringSync())
      as Map<String, Object?>;
  return ((doc[map]! as Map<String, Object?>)['labels']! as Map<String, Object?>).cast<String, String>();
}

void main() {
  test('state and outcome labels are word for word the contract\'s (British: "Dialling")', () {
    expect({for (final e in attemptStateLabels.entries) e.key.wire: e.value}, contractLabels('attempt_state_labels'));
    expect({for (final e in attemptOutcomeLabels.entries) e.key.wire: e.value}, contractLabels('attempt_outcome_labels'));
    expect(attemptStateLabels[AttemptState.dialing], 'Dialling');
  });

  test('every outcome but `unknown` has a label', () {
    expect(attemptOutcomeLabels.length, AttemptOutcome.values.length - 1);
    expect(attemptOutcomeLabels[AttemptOutcome.abandoned], 'Abandoned (no agent free)');
  });

  test('tones: green for a conversation, never red for an ordinary miss', () {
    expect(outcomeTone(AttemptOutcome.connected), Tone.ok);
    expect(outcomeTone(AttemptOutcome.noAnswer), Tone.neutral);
    expect(outcomeTone(AttemptOutcome.abandoned), Tone.warn);
    expect(outcomeTone(AttemptOutcome.failed), Tone.danger);
    expect(outcomeTone(null), Tone.neutral);
  });
}
