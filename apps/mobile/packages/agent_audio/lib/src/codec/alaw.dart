import 'dart:typed_data';

/// G.711 A-law, table-based. This is the reference the Kotlin (`ALaw.kt`) and Swift
/// (`ALaw.swift`) codecs mirror table-for-table; the shared checksums in
/// `test/alaw_test.dart` and `ALawTest.kt` pin all three to the same output.
///
/// Encoding works on the 13-bit magnitude (`sample >> 3`), as G.711 specifies, through a
/// 4096-entry table; decoding is a 256-entry table. Neither allocates per call.
abstract final class ALaw {
  /// The encoded value of digital silence (`0` → `0xD5`). Muted uplink frames are filled
  /// with it so the far end keeps receiving a steady 50 frames/s.
  static const int silence = 0xD5;

  static final Uint8List _encode = _buildEncodeTable();
  static final Int16List _decode = _buildDecodeTable();

  /// Encodes one signed 16-bit sample to an A-law byte.
  static int encodeSample(int sample) {
    // Arithmetic shift keeps the sign; negative magnitudes are folded as -m - 1 exactly as
    // the G.711 reference does, so both halves index the same table.
    final m = sample >> 3;
    return m >= 0 ? _encode[m] ^ 0xD5 : _encode[-m - 1] ^ 0x55;
  }

  /// Decodes one A-law byte to a signed 16-bit sample.
  static int decodeSample(int alaw) => _decode[alaw & 0xFF];

  /// Encodes [count] samples of [pcm] starting at [pcmOffset] into [out] at [outOffset].
  static void encode(Int16List pcm, Uint8List out, {int pcmOffset = 0, int outOffset = 0, int? count}) {
    final n = count ?? pcm.length - pcmOffset;
    for (var i = 0; i < n; i++) {
      out[outOffset + i] = encodeSample(pcm[pcmOffset + i]);
    }
  }

  /// Decodes [count] bytes of [alaw] starting at [alawOffset] into [out] at [outOffset].
  static void decode(Uint8List alaw, Int16List out, {int alawOffset = 0, int outOffset = 0, int? count}) {
    final n = count ?? alaw.length - alawOffset;
    for (var i = 0; i < n; i++) {
      out[outOffset + i] = _decode[alaw[alawOffset + i]];
    }
  }

  /// Segment end points of the 13-bit magnitude (G.711 table 1a).
  static const List<int> _segmentEnds = [0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF];

  /// The un-masked code for each 13-bit magnitude 0..4095 (before the 0x55/0xD5 XOR).
  static Uint8List _buildEncodeTable() {
    final table = Uint8List(4096);
    for (var m = 0; m < 4096; m++) {
      var seg = 0;
      while (seg < 8 && m > _segmentEnds[seg]) {
        seg++;
      }
      // m <= 0xFFF always lands in segment 0..7, so no clipping branch is needed here.
      final quant = seg < 2 ? (m >> 1) & 0x0F : (m >> seg) & 0x0F;
      table[m] = (seg << 4) | quant;
    }
    return table;
  }

  static Int16List _buildDecodeTable() {
    final table = Int16List(256);
    for (var code = 0; code < 256; code++) {
      final a = code ^ 0x55;
      var t = (a & 0x0F) << 4;
      final seg = (a & 0x70) >> 4;
      switch (seg) {
        case 0:
          t += 8;
        case 1:
          t += 0x108;
        default:
          t += 0x108;
          t <<= seg - 1;
      }
      table[code] = (a & 0x80) != 0 ? t : -t;
    }
    return table;
  }
}
