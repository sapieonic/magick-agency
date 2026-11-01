import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/telemetry/log.dart';
import 'package:magick_agency_agent/core/telemetry/telemetry.dart';

import 'fake_telemetry_sink.dart';

/// The telemetry seam: nothing leaves unmasked, warnings and errors from [Log]
/// arrive as events or exceptions, the caps hold, and a broken sink is harmless.
void main() {
  late FakeTelemetrySink sink;
  late DateTime clock;
  final log = Log('station_socket');

  setUp(() {
    clock = DateTime.utc(2026, 11, 1, 9);
    sink = installFakeTelemetry(now: () => clock);
  });
  tearDown(Telemetry.uninstall);

  group('events', () {
    test('properties are masked, nulls dropped, other objects sent as text', () {
      Telemetry.event('dial_refused', {
        'code': 'dnc_listed',
        'note': 'called +91 98200 12345 at work, mail asha@example.com',
        'raw_number': 919820012345,
        'status': 409,
        'overrides': false,
        'missing': null,
        'type': StateError,
      });
      expect(sink.last('dial_refused'), {
        'code': 'dnc_listed',
        'note': 'called <tel …45> at work, mail <email>',
        'raw_number': '<tel …45>',
        'status': 409,
        'overrides': false,
        'type': 'StateError',
      });
    });

    test('identify, register, group and reset reach the sink; register is masked too', () {
      Telemetry.identify('u-1');
      Telemetry.register({'tenant_id': 't1', 'oops': '+919820012345', 'none': null});
      Telemetry.group('account', 'a1');
      Telemetry.reset();
      expect(sink.identified, ['u-1']);
      expect(sink.groups, [('account', 'a1')]);
      expect(sink.registered.single, {'tenant_id': 't1', 'oops': '<tel …45>'});
      expect(sink.resets, 1);
    });

    test('not installed: every call is a no-op, and Log forwards nothing', () {
      Telemetry.uninstall();
      expect(Telemetry.installed, isFalse);
      expect(Log.forward, isNull);
      Telemetry.event('call_ended');
      Telemetry.exception(StateError('x'), null, source: 'test');
      log.warn('station gave up');
      expect(sink.events, isEmpty);
      expect(sink.exceptions, isEmpty);
    });

    test('a sink that throws never fails the caller, nor the log line', () {
      sink.broken = true;
      Telemetry.event('call_ended');
      Telemetry.identify('u-1');
      Telemetry.reset();
      log.warn('station gave up');
      log.error('boom', const {}, StateError('x'), StackTrace.current);
      expect(Log.recent().last.message, startsWith('boom'));
    });
  });

  group('exceptions', () {
    test('masked text, real type: PostHog still names and groups it by the exception', () {
      final stack = StackTrace.current;
      Telemetry.exception(const FormatException('bad number +91 98200 12345'), stack, source: 'flutter', properties: {'library': 'widgets'});
      final (error, sentStack, props) = sink.exceptions.single;
      expect(error.runtimeType, FormatException);
      expect(error.toString(), 'FormatException: bad number <tel …45>');
      expect(sentStack, same(stack));
      expect(props, {'library': 'widgets', 'source': 'flutter'});
    });
  });

  group('Log lines', () {
    test('info and debug stay on the phone; a warning is an agency_app_warning with its fields', () {
      log.debug('frame');
      log.info('connected');
      log.warn('station closed 1011: server error', {'reason': 'down', 'in_a_row': 2});
      expect(sink.names, ['agency_app_warning']);
      expect(sink.last('agency_app_warning'), {
        'reason': 'down',
        'in_a_row': 2,
        'tag': 'station_socket',
        'message': 'station closed 1011: server error',
      });
    });

    test('an error without an exception is an agency_app_error; with one, an exception carrying the line', () {
      log.error('GET /x failed', {'status': 500});
      expect(sink.last('agency_app_error'), {'status': 500, 'tag': 'station_socket', 'message': 'GET /x failed'});

      final stack = StackTrace.current;
      log.error('Uncaught error', const {}, StateError('lost +919820012345'), stack);
      final (error, sentStack, props) = sink.exceptions.single;
      expect(error.runtimeType, StateError);
      expect(error.toString(), 'Bad state: lost <tel …45>');
      expect(sentStack, same(stack));
      expect(props, {'tag': 'station_socket', 'message': 'Uncaught error: Bad state: lost <tel …45>', 'source': 'station_socket'});
      expect(sink.names, ['agency_app_error'], reason: 'the exception is not also an agency_app_error');
    });

    test('a long message is cut to ${Telemetry.maxMessageLength} characters', () {
      log.warn('x' * 1000);
      expect(sink.last('agency_app_warning')['message'], '${'x' * Telemetry.maxMessageLength}…');
    });

    test('a field cannot overwrite the tag or the message', () {
      log.warn('real message', {'tag': 'fake', 'message': 'fake'});
      expect(sink.last('agency_app_warning')['tag'], 'station_socket');
      expect(sink.last('agency_app_warning')['message'], 'real message');
    });
  });

  group('caps', () {
    test('${Telemetry.linesPerMessage} of one message a minute; the next admitted says how many were dropped', () {
      for (var i = 0; i < 12; i++) {
        log.warn('heartbeat stalled');
      }
      expect(sink.events.length, Telemetry.linesPerMessage);
      expect(sink.events.any((e) => e.$2.containsKey('repeats_dropped')), isFalse);

      clock = clock.add(const Duration(minutes: 1));
      log.warn('heartbeat stalled');
      expect(sink.events.length, Telemetry.linesPerMessage + 1);
      expect(sink.events.last.$2['repeats_dropped'], 12 - Telemetry.linesPerMessage);

      log.warn('heartbeat stalled');
      expect(sink.events.last.$2.containsKey('repeats_dropped'), isFalse);
    });

    test('another message has its own allowance', () {
      for (var i = 0; i < 10; i++) {
        log.warn('heartbeat stalled');
      }
      log.warn('station gave up');
      expect(sink.events.last.$2['message'], 'station gave up');
    });

    test('${Telemetry.linesPerMinute} lines a minute in all, whatever the messages', () {
      for (var i = 0; i < 100; i++) {
        log.warn('distinct $i');
      }
      expect(sink.events.length, Telemetry.linesPerMinute);
      clock = clock.add(const Duration(minutes: 1));
      log.warn('distinct 0');
      expect(sink.events.length, Telemetry.linesPerMinute + 1);
    });

    test('named events are not capped (they are counted, not logged)', () {
      for (var i = 0; i < 100; i++) {
        Telemetry.event('call_ended');
      }
      expect(sink.events.length, 100);
    });
  });
}
