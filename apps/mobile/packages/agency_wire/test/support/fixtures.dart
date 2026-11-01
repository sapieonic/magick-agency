import 'dart:convert';
import 'dart:io';

/// `packages/contracts/fixtures/agent/`, found by walking up from the working
/// directory (`dart test` runs in the package root, four levels below the repo
/// root; walking up also survives being run from elsewhere in the repo).
Directory agentFixturesDir() {
  var dir = Directory.current.absolute;
  while (true) {
    final candidate = Directory('${dir.path}/packages/contracts/fixtures/agent');
    if (candidate.existsSync()) return candidate;
    final parent = dir.parent;
    if (parent.path == dir.path) {
      throw StateError(
        'packages/contracts/fixtures/agent not found above ${Directory.current.path}; '
        'run `dart test` inside apps/mobile/packages/agency_wire',
      );
    }
    dir = parent;
  }
}

/// One fixture file: `{ "<sample>": <payload>, ... }`.
Map<String, Object?> loadFixtureFile(String name) {
  final file = File('${agentFixturesDir().path}/$name');
  return jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
}

/// One sample of a fixture file, as a JSON object.
Map<String, Object?> fixture(String file, String sample) {
  final samples = loadFixtureFile(file);
  final value = samples[sample];
  if (value is! Map<String, Object?>) throw StateError('$file has no object sample "$sample"');
  return value;
}

/// One sample re-encoded as the wire text a socket would deliver.
String fixtureText(String file, String sample) => jsonEncode(fixture(file, sample));
