import 'package:agency_wire/agency_wire.dart';
import 'package:test/test.dart';

// One station per agent (OS1, OS3; `agency/station-device.ts`).
void main() {
  group('StationDevice', () {
    test('a join names the device and whether it takes the station over', () {
      const join = CreateSessionRequest(
        campaignId: 'camp-1',
        device: StationDevice(deviceId: 'phone-0123456789abcdef', takeOver: true),
      );
      expect(join.toJson(), {'campaign_id': 'camp-1', 'device_id': 'phone-0123456789abcdef', 'take_over': true});
      // An older shape (no device) sends exactly what it always did.
      expect(const CreateSessionRequest(campaignId: 'camp-1').toJson(), {'campaign_id': 'camp-1'});
    });

    test("the pattern is the server's: 8–64 of letters, digits, - and _", () {
      expect(StationDevice.pattern.hasMatch('phone-0123456789abcdef'), isTrue);
      expect(StationDevice.pattern.hasMatch('9b2f3a1c-5d6e-4f70-8a9b-0c1d2e3f4a5b'), isTrue);
      expect(StationDevice.pattern.hasMatch('short'), isFalse);
      expect(StationDevice.pattern.hasMatch('has space here'), isFalse);
      expect(StationDevice.pattern.hasMatch('x' * 65), isFalse);
    });
  });

  group('the two refusals', () {
    test('station_on_other_device reads its session and the app that holds it', () {
      final body = ErrorBody.fromJson({
        'error': 'Conflict',
        'code': 'station_on_other_device',
        'message': 'Your station is open on another device.',
        'session_id': 'sess-1',
        'client_kind': 'web',
      });
      expect(body.code, AgencyErrorCode.stationOnOtherDevice);
      expect(
        body.stationOnOtherDevice,
        const StationOnOtherDeviceRefusal(sessionId: 'sess-1', clientKind: ClientKind.web, message: 'Your station is open on another device.'),
      );
    });

    test('session_in_other_tenant is its own code, and not a device refusal', () {
      final body = ErrorBody.fromJson({
        'error': 'Conflict',
        'code': 'session_in_other_tenant',
        'message': 'You are live in Acme.',
        'tenant_id': 't2',
        'tenant_name': 'Acme',
      });
      expect(body.code, AgencyErrorCode.sessionInOtherTenant);
      expect(body.stationOnOtherDevice, isNull);
      expect(body.message, 'You are live in Acme.');
    });
  });
}
