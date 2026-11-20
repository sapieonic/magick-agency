import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/speech/read_aloud.dart';

/// Read aloud (AS13) on the phone's own text-to-speech (`flutter_tts`'s channel, faked): an Indian
/// English voice where the phone has one, each read stopping the one before, and a phone that
/// cannot speak never in the agent's way.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('flutter_tts');
  late List<MethodCall> calls;

  void fake({bool indianEnglish = true, bool fails = false}) {
    calls = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      if (fails) throw PlatformException(code: 'no_engine');
      if (call.method == 'isLanguageAvailable') return indianEnglish;
      return 1;
    });
  }

  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));

  test('asks for en-IN once, then stops whatever is being read and reads the words', () async {
    fake();
    final tts = DeviceReadAloud();
    await tts.speak('Will pay');
    await tts.speak('Call later');
    expect(calls.where((c) => c.method == 'setLanguage').map((c) => c.arguments), ['en-IN']);
    expect(calls.where((c) => c.method == 'isLanguageAvailable'), hasLength(1));
    final spoken = calls.where((c) => c.method == 'speak' || c.method == 'stop').map((c) => c.method == 'speak' ? 'speak:${c.arguments}' : 'stop');
    expect(spoken, ['stop', 'speak:Will pay', 'stop', 'speak:Call later']);
  });

  test('a phone without an Indian English voice reads in its own default', () async {
    fake(indianEnglish: false);
    await DeviceReadAloud().speak('Refused');
    expect(calls.where((c) => c.method == 'setLanguage'), isEmpty);
    expect(calls.where((c) => c.method == 'speak').single.arguments, 'Refused');
  });

  test('nothing to read reads nothing; a phone that cannot speak throws nothing', () async {
    fake();
    await DeviceReadAloud().speak('   ');
    expect(calls, isEmpty);
    fake(fails: true);
    await expectLater(DeviceReadAloud().speak('Will pay'), completes);
  });
}
