import 'package:magick_agency_agent/core/telemetry/telemetry.dart';

/// A [TelemetrySink] that keeps what it is handed.
class FakeTelemetrySink implements TelemetrySink {
  final events = <(String, Map<String, Object>)>[];
  final exceptions = <(Object, StackTrace?, Map<String, Object>)>[];
  final identified = <String>[];
  final registered = <Map<String, Object>>[];
  int resets = 0;

  /// Every call throws, as a broken SDK might.
  bool broken = false;

  List<String> get names => [for (final e in events) e.$1];

  /// The last [name] event's properties.
  Map<String, Object> last(String name) => events.lastWhere((e) => e.$1 == name).$2;

  void _check() {
    if (broken) throw StateError('sink down');
  }

  @override
  void capture(String event, Map<String, Object> properties) {
    _check();
    events.add((event, properties));
  }

  @override
  void captureException(Object error, StackTrace? stack, Map<String, Object> properties) {
    _check();
    exceptions.add((error, stack, properties));
  }

  @override
  void identify(String userId) {
    _check();
    identified.add(userId);
  }

  @override
  void register(Map<String, Object> properties) {
    _check();
    registered.add(properties);
  }

  @override
  void reset() {
    _check();
    resets++;
  }
}

/// Telemetry reporting to a fresh [FakeTelemetrySink] for this test.
FakeTelemetrySink installFakeTelemetry({DateTime Function()? now}) {
  final sink = FakeTelemetrySink();
  Telemetry.install(sink, now: now);
  return sink;
}
