import 'dart:convert';
import 'dart:io';

import 'package:agency_wire/agency_wire.dart';

/// The contract's golden samples (`packages/contracts/fixtures/agent/`), found by walking up
/// from the working directory, as `agency_wire`'s tests find them: the inbound frames the
/// server sends (`station.json`) and the call routes' answers and refusals (`inbound.json`).
/// The station tests drive the controller only with these, so a frame the app is tested on is
/// one the contract checks.
Directory _fixturesDir() {
  var dir = Directory.current.absolute;
  while (true) {
    final candidate = Directory('${dir.path}/packages/contracts/fixtures/agent');
    if (candidate.existsSync()) return candidate;
    final parent = dir.parent;
    if (parent.path == dir.path) throw StateError('packages/contracts/fixtures/agent not found above ${Directory.current.path}');
    dir = parent;
  }
}

final Map<String, Map<String, Object?>> _files = {};

Map<String, Object?> _sample(String file, String name) {
  final samples = _files.putIfAbsent(
    file,
    () => jsonDecode(File('${_fixturesDir().path}/$file').readAsStringSync()) as Map<String, Object?>,
  );
  final value = samples[name];
  if (value is! Map<String, Object?>) throw StateError('$file has no sample "$name"');
  // A deep copy the test may change.
  return jsonDecode(jsonEncode(value)) as Map<String, Object?>;
}

/// A station frame from `station.json`, with its call's session set to [sessionId] (the
/// harness's session: the fixture's own id is another one) and [call] fields overridden.
Map<String, Object?> stationFrame(String name, {String? sessionId = 'sess-1', Map<String, Object?> call = const {}}) {
  final frame = _sample('station.json', name);
  final c = frame['call'];
  if (c is Map<String, Object?>) {
    if (sessionId != null) c['session_id'] = sessionId;
    c.addAll(call);
  }
  return frame;
}

/// The call of an `inbound_call` sample, as JSON (with [overrides]).
Map<String, Object?> inboundCallJson(String frame, {String sessionId = 'sess-1', Map<String, Object?> overrides = const {}}) =>
    stationFrame(frame, sessionId: sessionId, call: overrides)['call']! as Map<String, Object?>;

/// The call of an `inbound_call` sample, decoded.
InboundCall inboundCall(String frame, {String sessionId = 'sess-1', Map<String, Object?> overrides = const {}}) =>
    InboundCall.fromJson(inboundCallJson(frame, sessionId: sessionId, overrides: overrides));

/// A sample of `inbound.json` (an answer or a refusal body).
Map<String, Object?> inboundSample(String name) => _sample('inbound.json', name);

/// The fixture call's id.
const fixtureCallId = '3a9e1c7b-2f4d-4b8a-9c6e-5d7f0a1b2c3d';
const withheldCallId = '9f0e1d2c-3b4a-4596-8877-6a5b4c3d2e1f';
