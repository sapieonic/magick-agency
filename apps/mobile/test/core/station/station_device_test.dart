import 'package:agency_wire/agency_wire.dart' show StationDevice;
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/session/session_store.dart';
import 'package:magick_agency_agent/core/station/station_device.dart';

// OS3: this install's station device id.
void main() {
  test('made once, in the server\'s pattern, kept in the store: a restart is the same device', () async {
    final store = MemoryStore();
    final first = await StationDeviceIds(() => store).id();
    expect(StationDevice.pattern.hasMatch(first), isTrue);
    expect(store.values[StationDeviceIds.storeKey], first);
    expect(await StationDeviceIds(() => store).id(), first, reason: 'a new run reads the same id');
  });

  test('a stored value the server would refuse is replaced', () async {
    final store = MemoryStore({StationDeviceIds.storeKey: 'bad id'});
    final id = await StationDeviceIds(() => store).id();
    expect(id, isNot('bad id'));
    expect(StationDevice.pattern.hasMatch(id), isTrue);
  });

  test('a store that cannot be built still yields an id for this run', () async {
    final ids = StationDeviceIds(() => throw StateError('no platform'));
    final id = await ids.id();
    expect(StationDevice.pattern.hasMatch(id), isTrue);
    expect(await ids.id(), id);
  });

  test('fields carry the id and the take-over', () async {
    final ids = StationDeviceIds(() => MemoryStore({StationDeviceIds.storeKey: 'phone-test-device-0001'}));
    expect(await ids.fields(takeOver: true), const StationDevice(deviceId: 'phone-test-device-0001', takeOver: true));
  });
}
