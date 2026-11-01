package com.magickagency.agent_audio

import kotlin.math.PI
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class HalfBandDecimatorTest {
    /** Same signal as `crossLanguageSignal()` in `test/half_band_test.dart`. */
    private fun crossLanguageSignal(): ShortArray {
        val x = ShortArray(16000)
        var rng = 1L
        for (i in x.indices) {
            rng = (rng * 1103515245L + 12345L) and 0x7fffffffL
            val noise = ((rng shr 16) % 8001).toInt() - 4000
            val p = i % 16
            val tri = if (p < 8) -16000 + p * 4000 else 16000 - (p - 8) * 4000
            x[i] = (tri + noise).toShort()
        }
        return x
    }

    private fun decimate(input: ShortArray, block: Int = 320): ShortArray {
        val d = HalfBandDecimator()
        val out = ShortArray(input.size / 2)
        var i = 0
        while (i < input.size) {
            d.process(input, i, block, out, i / 2)
            i += block
        }
        return out
    }

    @Test
    fun tapsMatchTheDartModel() {
        assertEquals(51, HalfBandDecimator.TAPS_Q15.size)
        assertEquals(32768, HalfBandDecimator.TAPS_Q15.sum())
    }

    /** The same literal as `test/half_band_test.dart`. */
    @Test
    fun crossLanguageChecksum() {
        val out = decimate(crossLanguageSignal())
        var sum = 0L
        for (i in out.indices) sum += out[i].toLong() * (i % 97 + 1)
        assertEquals(-40745250L, sum)
    }

    @Test
    fun blockSizeDoesNotChangeOutput() {
        val x = crossLanguageSignal()
        assertContentEquals(decimate(x, 320), decimate(x, 1600))
        assertContentEquals(decimate(x, 320), decimate(x, 2))
    }

    @Test
    fun passesDcAndRejectsBadBlocks() {
        val out = decimate(ShortArray(3200) { 10000 })
        for (i in 100 until out.size) assertTrue(out[i] in 9998..10002, "sample $i = ${out[i]}")
        assertFailsWith<IllegalArgumentException> { HalfBandDecimator().process(ShortArray(3), 0, 3, ShortArray(2), 0) }
    }

    @Test
    fun removesContentThatWouldAlias() {
        // 6 kHz at 16 kHz would fold to 2 kHz at 8 kHz; after the filter it is ~60 dB down.
        val tone = ShortArray(16000) { (10000 * sin(2 * PI * 6000 * it / 16000)).roundToInt().toShort() }
        val out = decimate(tone)
        val peak = (200 until out.size).maxOf { kotlin.math.abs(out[it].toInt()) }
        assertTrue(peak < 30, "residual peak $peak")
    }
}
