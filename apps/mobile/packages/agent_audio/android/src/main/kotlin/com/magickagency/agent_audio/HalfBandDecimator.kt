package com.magickagency.agent_audio

/**
 * Streaming 2:1 decimator, 16 kHz → 8 kHz, for the A-law uplink. Port of
 * `HalfBandDecimator` in `lib/src/codec/half_band.dart`: same 51 Q15 taps (flat to 3.4 kHz,
 * ≥ 59 dB down from 4.6 kHz), same integer arithmetic, bit-identical output (pinned by the
 * shared checksum in `HalfBandDecimatorTest.kt`). No allocation per call.
 */
internal class HalfBandDecimator {
    private val history = ShortArray(TAPS - 1 + MAX_BLOCK)

    fun reset() = history.fill(0)

    /** Decimates [count] (even, ≤ 1920) samples into [output]; returns count / 2. */
    fun process(input: ShortArray, inputOffset: Int, count: Int, output: ShortArray, outputOffset: Int): Int {
        require(count % 2 == 0 && count <= MAX_BLOCK) { "count must be even and at most $MAX_BLOCK" }
        val hist = TAPS - 1
        System.arraycopy(input, inputOffset, history, hist, count)
        var o = outputOffset
        var i = 0
        while (i < count) {
            var acc = 0L
            val base = i + hist
            var k = 0
            while (k < TAPS) {
                acc += TAPS_Q15[k].toLong() * history[base - k]
                k += 2
            }
            acc += TAPS_Q15[25].toLong() * history[base - 25]
            val v = (acc + 16384) shr 15
            output[o++] = (if (v > 32767) 32767 else if (v < -32768) -32768 else v.toInt()).toShort()
            i += 2
        }
        System.arraycopy(history, count, history, 0, hist)
        return count / 2
    }

    companion object {
        const val TAPS = 51
        const val MAX_BLOCK = 1920

        val TAPS_Q15 = intArrayOf(
            9, 0, -25, 0, 52, 0, -96, 0, 160, 0, -253, 0, 383, 0, -564, 0, 823, 0, -1214, 0, 1881, 0,
            -3350, 0, 10387, 16382, 10387, 0, -3350, 0, 1881, 0, -1214, 0, 823, 0, -564, 0, 383, 0,
            -253, 0, 160, 0, -96, 0, 52, 0, -25, 0, 9,
        )
    }
}
