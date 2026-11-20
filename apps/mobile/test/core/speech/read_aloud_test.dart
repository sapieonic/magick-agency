import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:magick_agency_agent/core/speech/read_aloud.dart';

/// `flutter_tts` sends `speak` as the bare text on iOS and as `{text, focus}` on Android (it reads
/// `dart:io`'s platform, which a test cannot change): this one sends the Android form, as the
/// plugin's own Android branch does, so the station's read is checked in both.
class _AndroidFormTts extends FlutterTts {
  static const _channel = MethodChannel('flutter_tts');

  @override
  Future<dynamic> speak(String text, {bool focus = false}) =>
      _channel.invokeMethod('speak', <String, dynamic>{'text': text, 'focus': focus});
}

/// The words a `speak` call carries, in either form.
Object? _words(MethodCall c) => c.arguments is Map ? (c.arguments as Map)['text'] : c.arguments;

/// Read aloud (AS13) on the phone's own text-to-speech (`flutter_tts`'s channel, faked): an Indian
/// English voice where the phone has one, each read stopping the one before, and a phone that
/// cannot speak never in the agent's way.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('flutter_tts');
  late List<MethodCall> calls;

  void fake({
    bool indianEnglish = true,
    bool fails = false,
    List<String> engines = const ['com.google.android.tts'],
    List<String> languages = const ['en-IN', 'hi-IN'],
  }) {
    calls = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      if (fails) throw PlatformException(code: 'no_engine');
      if (call.method == 'isLanguageAvailable') return indianEnglish;
      if (call.method == 'getEngines') return engines;
      if (call.method == 'getLanguages') return languages;
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
    final spoken = calls.where((c) => c.method == 'speak' || c.method == 'stop').map((c) => c.method == 'speak' ? 'speak:${_words(c)}' : 'stop');
    expect(spoken, ['stop', 'speak:Will pay', 'stop', 'speak:Call later']);
  });

  test('Android\'s {text, focus} form: the words, and no claim on the audio focus', () async {
    fake();
    final tts = DeviceReadAloud(_AndroidFormTts(), true);
    await tts.speak('Will pay');
    final speak = calls.singleWhere((c) => c.method == 'speak');
    expect(speak.arguments, {'text': 'Will pay', 'focus': false});
    expect(_words(speak), 'Will pay');
    expect(calls.where((c) => c.method == 'stop'), hasLength(1), reason: 'the read before it is stopped first');
  });

  group('can this phone speak (the speaker is hidden when not)', () {
    test('Android: an engine and a language', () async {
      fake();
      expect(await DeviceReadAloud(null, true).canSpeak(), isTrue);
      expect(calls.map((c) => c.method), ['getEngines', 'getLanguages']);
    });

    test('Android with no engine installed: no', () async {
      fake(engines: const []);
      expect(await DeviceReadAloud(null, true).canSpeak(), isFalse);
      expect(calls.map((c) => c.method), ['getEngines'], reason: 'no engine, no need to ask for languages');
    });

    test('an engine with no language: no', () async {
      fake(languages: const []);
      expect(await DeviceReadAloud(null, true).canSpeak(), isFalse);
    });

    test('iOS lists no engines: the languages alone decide', () async {
      fake(engines: const []);
      expect(await DeviceReadAloud(null, false).canSpeak(), isTrue);
      expect(calls.map((c) => c.method), ['getLanguages']);
      fake(languages: const []);
      expect(await DeviceReadAloud(null, false).canSpeak(), isFalse);
    });

    test('a phone whose speech refuses the question: no, and nothing thrown', () async {
      fake(fails: true);
      expect(await DeviceReadAloud(null, true).canSpeak(), isFalse);
    });
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
