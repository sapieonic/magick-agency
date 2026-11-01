import 'dart:typed_data';

import 'package:agent_audio/reference.dart';
import 'package:flutter_test/flutter_test.dart';

/// Straight port of the G.711 reference (Sun Microsystems' public-domain g711.c), kept
/// independent of the table-based codec under test.
int _referenceEncode(int pcm) {
  const segEnd = [0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF];
  var v = pcm >> 3;
  int mask;
  if (v >= 0) {
    mask = 0xD5;
  } else {
    mask = 0x55;
    v = -v - 1;
  }
  var seg = 0;
  while (seg < 8 && v > segEnd[seg]) {
    seg++;
  }
  if (seg >= 8) return 0x7F ^ mask;
  var aval = seg << 4;
  aval |= seg < 2 ? (v >> 1) & 0x0F : (v >> seg) & 0x0F;
  return aval ^ mask;
}

/// Shared with `ALawTest.kt` (and `ALaw.swift`'s documented checks): if these change, the
/// codecs no longer agree.
const _encodeChecksum = 297161535488;
const _decodeChecksum = 100139008;

void main() {
  test('encode matches the G.711 reference for every 16-bit sample', () {
    for (var x = -32768; x <= 32767; x++) {
      expect(ALaw.encodeSample(x), _referenceEncode(x), reason: 'sample $x');
    }
  });

  test('known values', () {
    expect(ALaw.encodeSample(0), 0xD5);
    expect(ALaw.encodeSample(-1), 0x55);
    expect(ALaw.encodeSample(32767), 0xAA);
    expect(ALaw.encodeSample(-32768), 0x2A);
    expect(ALaw.decodeSample(0xD5), 8);
    expect(ALaw.decodeSample(0x55), -8);
    expect(ALaw.decodeSample(0xAA), 32256);
    expect(ALaw.decodeSample(0x2A), -32256);
    expect(ALaw.silence, ALaw.encodeSample(0));
  });

  test('decode then encode returns the same code for all 256 codes', () {
    for (var c = 0; c < 256; c++) {
      expect(ALaw.encodeSample(ALaw.decodeSample(c)), c, reason: 'code $c');
    }
  });

  test('quantisation error stays within half a step of each segment', () {
    for (var x = -32768; x <= 32767; x += 7) {
      final y = ALaw.decodeSample(ALaw.encodeSample(x));
      final mag = x.abs();
      // Step is 16 in segments 0-1 (|x| < 512) and doubles each segment after.
      var step = 16;
      for (var edge = 512; edge <= mag && step < 1024; edge <<= 1) {
        step <<= 1;
      }
      expect((y - x).abs(), lessThanOrEqualTo(step ~/ 2 + 1), reason: 'sample $x → $y');
    }
  });

  test('block encode/decode honour offsets and counts', () {
    final pcm = Int16List.fromList([0, 1000, -1000, 32767, -32768, 5]);
    final enc = Uint8List(8);
    ALaw.encode(pcm, enc, pcmOffset: 1, outOffset: 2, count: 4);
    expect(enc.sublist(0, 2), [0, 0]);
    expect(enc.sublist(2, 6), [for (var i = 1; i < 5; i++) ALaw.encodeSample(pcm[i])]);
    final dec = Int16List(6);
    ALaw.decode(enc, dec, alawOffset: 2, outOffset: 1, count: 4);
    expect(dec[0], 0);
    for (var i = 1; i < 5; i++) {
      expect(dec[i], ALaw.decodeSample(enc[i + 1]));
    }
  });

  test('cross-language checksums', () {
    var enc = 0;
    for (var x = -32768; x <= 32767; x++) {
      enc += ALaw.encodeSample(x) * (x + 32769);
    }
    var dec = 0;
    for (var c = 0; c < 256; c++) {
      dec += ALaw.decodeSample(c) * (c + 1);
    }
    expect(enc, _encodeChecksum);
    expect(dec, _decodeChecksum);
  });
}
