import 'package:agent_audio/agent_audio.dart';
import 'package:flutter_test/flutter_test.dart';

List<double> _levels({required int quiet, required double quietDb, required int loud, required double loudDb}) =>
    [for (var i = 0; i < quiet; i++) quietDb, for (var i = 0; i < loud; i++) loudDb];

void main() {
  test('a quiet room is not a voice', () {
    final r = LoopbackResult.analyze(List.filled(75, -62.0), playedBack: true);
    expect(r.voiceDetected, isFalse);
    expect(r.voiceFrames, 0);
    expect(r.playedBack, isTrue);
  });

  test('half a second of speech over a quiet room is a voice', () {
    final r = LoopbackResult.analyze(_levels(quiet: 50, quietDb: -60, loud: 25, loudDb: -28), playedBack: false);
    expect(r.voiceDetected, isTrue);
    expect(r.voiceFrames, 25);
    expect(r.speechLevelDbfs, -28);
    expect(r.noiseFloorDbfs, -60);
    expect(r.snrDb, 32);
    expect(r.peakDbfs, -28);
  });

  test('a steady loud noise is not a voice (no contrast)', () {
    final r = LoopbackResult.analyze(List.filled(75, -30.0), playedBack: true);
    expect(r.voiceFrames, 75);
    expect(r.voiceDetected, isFalse);
  });

  test('a single click is not a voice (too short)', () {
    final r = LoopbackResult.analyze(_levels(quiet: 70, quietDb: -60, loud: 5, loudDb: -10), playedBack: true);
    expect(r.voiceDetected, isFalse);
  });

  test('no frames at all', () {
    final r = LoopbackResult.analyze(const [], playedBack: false);
    expect(r.voiceDetected, isFalse);
    expect(r.peakDbfs, LoopbackResult.floorDbfs);
  });

  test('levels are kept read-only and compare by value', () {
    final a = LoopbackResult.analyze([-50, -20], playedBack: true);
    expect(() => a.frameLevelsDbfs.add(0), throwsUnsupportedError);
    expect(a, LoopbackResult.analyze([-50, -20], playedBack: true));
    expect(a == LoopbackResult.analyze([-50, -20], playedBack: false), isFalse);
  });
}
