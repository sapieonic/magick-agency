import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_tts/flutter_tts.dart';

import '../telemetry/log.dart';

/// Read aloud (AS13): the phone's own text-to-speech, no server. An Indian English voice where the
/// phone has one (`en-IN`), else the phone's default. Each read stops the one before, so a second
/// tap never queues behind the first.
abstract interface class ReadAloud {
  /// Whether this phone can speak at all: a text-to-speech engine (Android) with at least one
  /// language. False hides the speaker buttons (AS1: hidden, not disabled).
  Future<bool> canSpeak();
  Future<void> speak(String text);
  Future<void> stop();
}

/// The platform's text-to-speech through `flutter_tts`. A phone with no engine, or one that
/// refuses, reads nothing and says nothing: reading aloud is a help, never in the agent's way.
class DeviceReadAloud implements ReadAloud {
  /// [android]: whether to ask for the phone's engines too (only Android lists them); this
  /// platform's answer by default.
  DeviceReadAloud([FlutterTts? tts, bool? android])
      : _tts = tts ?? FlutterTts(),
        _android = android ?? (!kIsWeb && Platform.isAndroid);

  final FlutterTts _tts;
  final bool _android;
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

  /// An engine (Android: `getEngines`, which iOS does not answer) and a language (`getLanguages`).
  /// Any failure reads as "cannot speak".
  @override
  Future<bool> canSpeak() async {
    try {
      if (_android) {
        final engines = await _tts.getEngines;
        if (engines is! List || engines.isEmpty) return false;
      }
      final languages = await _tts.getLanguages;
      return languages is List && languages.isNotEmpty;
    } catch (e) {
      _log.warn('text to speech check failed', {'error': e.runtimeType.toString()});
      return false;
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

/// Whether the speaker buttons are shown: asked once per app run; false while it is being asked.
final readAloudAvailableProvider = FutureProvider<bool>((ref) => ref.watch(readAloudProvider).canSpeak());
