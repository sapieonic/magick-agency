import Foundation

/// G.711 A-law, table-based. Port of `lib/src/codec/alaw.dart` (the specification) and of
/// `ALaw.kt`. Checks to run when this can be built (macOS): encode(0) == 0xD5,
/// encode(-1) == 0x55, decode(0xAA) == 32256, and the checksums
/// Σ encode(x)·(x + 32769) over all Int16 x == 297161535488 and
/// Σ decode(c)·(c + 1) over 0...255 == 100139008 (the literals the Dart and Kotlin tests assert).
enum ALaw {
  /// Encoded digital silence; muted uplink frames are filled with it.
  static let silence: UInt8 = 0xD5

  private static let segmentEnds: [Int] = [0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF]

  /// Un-masked code for each 13-bit magnitude 0..<4096.
  private static let encodeTable: [UInt8] = {
    var table = [UInt8](repeating: 0, count: 4096)
    for m in 0..<4096 {
      var seg = 0
      while seg < 8 && m > segmentEnds[seg] { seg += 1 }
      let quant = seg < 2 ? (m >> 1) & 0x0F : (m >> seg) & 0x0F
      table[m] = UInt8((seg << 4) | quant)
    }
    return table
  }()

  private static let decodeTable: [Int16] = {
    var table = [Int16](repeating: 0, count: 256)
    for code in 0..<256 {
      let a = code ^ 0x55
      var t = (a & 0x0F) << 4
      let seg = (a & 0x70) >> 4
      switch seg {
      case 0: t += 8
      case 1: t += 0x108
      default:
        t += 0x108
        t <<= seg - 1
      }
      table[code] = Int16((a & 0x80) != 0 ? t : -t)
    }
    return table
  }()

  @inline(__always)
  static func encode(_ sample: Int16) -> UInt8 {
    // Arithmetic shift keeps the sign; negatives fold to -m - 1 as in the G.711 reference.
    let m = Int(sample) >> 3
    return m >= 0 ? encodeTable[m] ^ 0xD5 : encodeTable[-m - 1] ^ 0x55
  }

  @inline(__always)
  static func decode(_ code: UInt8) -> Int16 {
    decodeTable[Int(code)]
  }
}
