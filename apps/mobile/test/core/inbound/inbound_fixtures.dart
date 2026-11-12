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

/// A sample of `push.json` (Mode B: device statuses, ring pushes, the ring routes' bodies).
Map<String, Object?> pushSample(String name) => _sample('push.json', name);

/// The fixture call's id.
const fixtureCallId = '3a9e1c7b-2f4d-4b8a-9c6e-5d7f0a1b2c3d';
const withheldCallId = '9f0e1d2c-3b4a-4596-8877-6a5b4c3d2e1f';

/// An `agent_state` frame as the inbound connector sends it (`state`, `since`): the contract's
/// fixtures carry `available` and `break` only.
Map<String, Object?> agentStateFrameJson(String state, String since) => {'event': 'agent_state', 'state': state, 'since': since};

/// One whole inbound call as the server sends it to the station, in the server's own order
/// (`apps/server/src/agency/inbound/inbound-connector.ts`, `inbound-disposition.ts`): the
/// reservation (`agent_state: reserved`) and then, synchronously, the offer; on the bridge
/// `agent_state: on_call` and then the connected call; at the end `agent_state: wrapup` and then
/// the call owing its outcome; and when the outcome is saved the agent is returned
/// (`agent_state: available`) before the settled call is sent. The calls are the contract's
/// samples (`station.json`) on [sessionId]; the `since` stamps are the calls' own.
List<({String step, Map<String, Object?> frame})> realInboundCallFrames({String sessionId = 'sess-1'}) => [
      (step: 'reserved', frame: agentStateFrameJson('reserved', '2026-11-02T05:30:14.200Z')),
      (step: 'offered', frame: stationFrame('inbound_call_offered', sessionId: sessionId)),
      (step: 'on_call', frame: agentStateFrameJson('on_call', '2026-11-02T05:30:15.712Z')),
      (step: 'connected', frame: stationFrame('inbound_call_connected', sessionId: sessionId)),
      (step: 'wrapup', frame: agentStateFrameJson('wrapup', '2026-11-02T05:34:02.500Z')),
      (step: 'owed', frame: stationFrame('inbound_call_outcome_owed', sessionId: sessionId)),
      (step: 'available', frame: agentStateFrameJson('available', '2026-11-02T05:35:40.118Z')),
      (step: 'settled', frame: stationFrame('inbound_call_settled', sessionId: sessionId)),
    ];
