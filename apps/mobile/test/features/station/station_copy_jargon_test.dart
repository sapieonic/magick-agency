import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/softphone_copy.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/promise_rules.dart' show promiseRefusalCopy;
import 'package:magick_agency_agent/core/station/station_copy.dart' show dispositionBlockCopy;
import 'package:magick_agency_agent/features/softphone/softphone_copy.dart';

import '../../support/station_jargon.dart';

/// AS15, spec §6.6: the station's own words never use the jargon on the spec's list. Every string
/// literal in `StationCopy`, `InboundCopy`, `FloorAssistCopy` and `PreflightCopy` (Start of day and
/// its join screens) is read from the source (Dart has no reflection to call each one) and checked, so a new line that says "campaign" or "outcome"
/// goes red, used or not.
void main() {
  /// The body of `abstract final class [name]` in [path], comments taken out.
  String classBody(String path, String name) {
    final lines = File(path).readAsLinesSync();
    final start = lines.indexWhere((l) => l.startsWith('abstract final class $name '));
    expect(start, isNot(-1), reason: '$name in $path');
    final end = lines.indexWhere((l) => l == '}', start);
    return lines
        .sublist(start + 1, end)
        .where((l) => !l.trimLeft().startsWith('//'))
        .map((l) {
          final comment = l.indexOf(' // ');
          return comment == -1 ? l : l.substring(0, comment);
        })
        .join('\n');
  }

  /// [body] with every `${…}` interpolation (and the quotes inside it) taken out: the words are
  /// checked, not the Dart around them.
  String withoutInterpolations(String body) {
    final out = StringBuffer();
    var depth = 0;
    for (var i = 0; i < body.length; i++) {
      if (depth == 0 && body.startsWith(r'${', i)) {
        depth = 1;
        i++;
        continue;
      }
      if (depth > 0) {
        if (body[i] == '{') depth++;
        if (body[i] == '}') depth--;
        continue;
      }
      out.write(body[i]);
    }
    return out.toString().replaceAll(RegExp(r'\$[A-Za-z_]\w*'), '');
  }

  /// Every quoted piece of text in [body].
  List<String> literals(String body) => [
        for (final m in RegExp(r"'((?:[^'\\\n]|\\.)*)'|" r'"((?:[^"\\\n]|\\.)*)"').allMatches(withoutInterpolations(body)))
          m.group(1) ?? m.group(2)!,
      ];

  for (final (path, name) in [
    ('lib/features/station/station_copy.dart', 'StationCopy'),
    ('lib/features/station/station_copy.dart', 'InboundCopy'),
    ('lib/core/station/floor_assist.dart', 'FloorAssistCopy'),
    ('lib/features/preflight/preflight_copy.dart', 'PreflightCopy'),
  ]) {
    test('$name says none of the jargon', () {
      final found = literals(classBody(path, name));
      expect(found, isNotEmpty);
      final bad = [
        for (final line in found)
          if (jargonIn(line).isNotEmpty) '"$line": ${jargonIn(line).join(', ')}',
      ];
      expect(bad, isEmpty, reason: bad.join('\n'));
    });
  }

  test('the soft phone\'s What happened?, and the save and promise lines the station shares, say none of the jargon', () {
    final lines = [
      ...softphoneSaveBlockCopy.values,
      ...dispositionBlockCopy.values,
      ...promiseRefusalCopy.values,
      softphonePadDisabledCopy,
      softphoneOutcomeSavedCopy,
      softphoneOutcomeNotSavedCopy(''),
      SoftphoneCopy.saveOutcome,
      SoftphoneCopy.dialBlockedOwed,
      SoftphoneCopy.closesIn('1:42'),
      SoftphoneCopy.closingNoOutcome,
    ];
    final bad = [for (final l in lines) if (jargonIn(l).isNotEmpty) '"$l": ${jargonIn(l).join(', ')}'];
    expect(bad, isEmpty, reason: bad.join('\n'));
  });

  test('the guard finds what it is looking for', () {
    expect(jargonIn('Pick a disposition'), isNotEmpty);
    expect(jargonIn('Save outcome'), isNotEmpty);
    expect(jargonIn('Mark DNC'), isNotEmpty);
    expect(jargonIn('On Do Not Call'), isNotEmpty);
    expect(jargonIn('Goes back to the campaign queue'), hasLength(2));
    expect(jargonIn('Leave the station'), isNotEmpty);
    expect(jargonIn('What happened?'), isEmpty);
    expect(jargonIn('Call later'), isEmpty);
  });
}
