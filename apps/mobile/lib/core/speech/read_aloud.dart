import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_tts/flutter_tts.dart';

import '../telemetry/log.dart';

/// Read aloud (AS13): the phone's own text-to-speech, no server. An Indian English voice where the
/// phone has one (`en-IN`), else the phone's default. Each read stops the one before, so a second
/// tap never queues behind the first.
abstract interface class ReadAloud {
  Future<void> speak(String text);
  Future<void> stop();
}

/// The platform's text-to-speech through `flutter_tts`. A phone with no engine, or one that
/// refuses, reads nothing and says nothing: reading aloud is a help, never in the agent's way.
class DeviceReadAloud implements ReadAloud {
  DeviceReadAloud([FlutterTts? tts]) : _tts = tts ?? FlutterTts();

  final FlutterTts _tts;
  Future<void>? _ready;
  static final _log = Log('read_aloud');

  /// The language the station asks for first.
  static const indianEnglish = 'en-IN';

  Future<void> _prepare() async {
    try {
      final available = await _tts.isLanguageAvailable(indianEnglish);
      if (available == true) await _tts.setLanguage(indianEnglish);
      await _tts.setSpeechRate(0.45);
    } catch (e) {
      _log.warn('text to speech set-up failed', {'error': e.runtimeType.toString()});
    }
  }

  @override
  Future<void> speak(String text) async {
    final words = text.trim();
    if (words.isEmpty) return;
    try {
      await (_ready ??= _prepare());
      await _tts.stop();
      await _tts.speak(words);
    } catch (e) {
      _log.warn('read aloud failed', {'error': e.runtimeType.toString()});
    }
  }

  @override
  Future<void> stop() async {
    try {
      await _tts.stop();
    } catch (_) {}
  }
}

/// The station's read aloud. A provider so widget tests record what would be said.
final readAloudProvider = Provider<ReadAloud>((ref) => DeviceReadAloud());
