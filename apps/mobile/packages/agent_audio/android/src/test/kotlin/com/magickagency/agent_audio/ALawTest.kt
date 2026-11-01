package com.magickagency.agent_audio

import kotlin.test.Test
import kotlin.test.assertEquals

class ALawTest {
    /** Independent port of the G.711 reference encoder (Sun's g711.c). */
    private fun referenceEncode(pcm: Int): Int {
        val segEnd = intArrayOf(0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF)
        var v = pcm shr 3
        val mask: Int
        if (v >= 0) {
            mask = 0xD5
        } else {
            mask = 0x55
            v = -v - 1
        }
        var seg = 0
        while (seg < 8 && v > segEnd[seg]) seg++
        if (seg >= 8) return 0x7F xor mask
        var a = seg shl 4
        a = a or if (seg < 2) (v shr 1) and 0x0F else (v shr seg) and 0x0F
        return a xor mask
    }

    @Test
    fun encodeMatchesReferenceForEverySample() {
        for (x in -32768..32767) assertEquals(referenceEncode(x), ALaw.encodeSample(x), "sample $x")
    }

    @Test
    fun knownValues() {
        assertEquals(0xD5, ALaw.encodeSample(0))
        assertEquals(0x55, ALaw.encodeSample(-1))
        assertEquals(0xAA, ALaw.encodeSample(32767))
        assertEquals(0x2A, ALaw.encodeSample(-32768))
        assertEquals(8, ALaw.decodeSample(0xD5))
        assertEquals(-8, ALaw.decodeSample(0x55))
        assertEquals(32256, ALaw.decodeSample(0xAA))
        assertEquals(-32256, ALaw.decodeSample(0x2A))
        assertEquals(ALaw.encodeSample(0).toByte(), ALaw.SILENCE)
    }

    @Test
    fun blockCodecMatchesSampleCodec() {
        val pcm = shortArrayOf(0, 1000, -1000, 32767, -32768, 5)
        val enc = ByteArray(8)
        ALaw.encode(pcm, 1, enc, 2, 4)
        for (i in 1..4) assertEquals(ALaw.encodeSample(pcm[i].toInt()), enc[i + 1].toInt() and 0xFF)
        val dec = ShortArray(6)
        ALaw.decode(enc, 2, dec, 1, 4)
        for (i in 1..4) assertEquals(ALaw.decodeSample(enc[i + 1].toInt()), dec[i].toInt())
    }

    /** The same literals as `test/alaw_test.dart`: Dart and Kotlin codecs agree bit for bit. */
    @Test
    fun crossLanguageChecksums() {
        var enc = 0L
        for (x in -32768..32767) enc += ALaw.encodeSample(x).toLong() * (x + 32769)
        var dec = 0L
        for (c in 0 until 256) dec += ALaw.decodeSample(c).toLong() * (c + 1)
        assertEquals(297161535488L, enc)
        assertEquals(100139008L, dec)
    }
}
