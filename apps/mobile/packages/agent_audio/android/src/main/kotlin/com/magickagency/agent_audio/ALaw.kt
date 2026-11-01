package com.magickagency.agent_audio

/**
 * G.711 A-law, table-based. Port of `lib/src/codec/alaw.dart` (the specification); the
 * checksums in `ALawTest.kt` are the same literals the Dart tests assert.
 */
internal object ALaw {
    /** Encoded digital silence. Muted uplink frames are filled with it. */
    const val SILENCE: Byte = 0xD5.toByte()

    private val SEGMENT_ENDS = intArrayOf(0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF)

    /** Un-masked code for each 13-bit magnitude 0..4095. */
    private val ENCODE = ByteArray(4096).also { table ->
        for (m in 0 until 4096) {
            var seg = 0
            while (seg < 8 && m > SEGMENT_ENDS[seg]) seg++
            val quant = if (seg < 2) (m shr 1) and 0x0F else (m shr seg) and 0x0F
            table[m] = ((seg shl 4) or quant).toByte()
        }
    }

    private val DECODE = ShortArray(256).also { table ->
        for (code in 0 until 256) {
            val a = code xor 0x55
            var t = (a and 0x0F) shl 4
            val seg = (a and 0x70) shr 4
            when (seg) {
                0 -> t += 8
                1 -> t += 0x108
                else -> {
                    t += 0x108
                    t = t shl (seg - 1)
                }
            }
            table[code] = (if (a and 0x80 != 0) t else -t).toShort()
        }
    }

    fun encodeSample(sample: Int): Int {
        // Arithmetic shift keeps the sign; negatives fold to -m - 1 as in the G.711 reference.
        val m = sample shr 3
        return if (m >= 0) (ENCODE[m].toInt() and 0xFF) xor 0xD5 else (ENCODE[-m - 1].toInt() and 0xFF) xor 0x55
    }

    fun decodeSample(code: Int): Int = DECODE[code and 0xFF].toInt()

    fun encode(pcm: ShortArray, pcmOffset: Int, out: ByteArray, outOffset: Int, count: Int) {
        for (i in 0 until count) out[outOffset + i] = encodeSample(pcm[pcmOffset + i].toInt()).toByte()
    }

    fun decode(alaw: ByteArray, alawOffset: Int, out: ShortArray, outOffset: Int, count: Int) {
        for (i in 0 until count) out[outOffset + i] = DECODE[alaw[alawOffset + i].toInt() and 0xFF]
    }
}
