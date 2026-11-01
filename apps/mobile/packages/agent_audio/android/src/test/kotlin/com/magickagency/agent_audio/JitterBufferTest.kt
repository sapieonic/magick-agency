package com.magickagency.agent_audio

import kotlin.test.Test
import kotlin.test.assertEquals

/** Spot checks at the real frame size (the trace test covers the algorithm in full). */
class JitterBufferTest {
    private val config = JitterBufferConfig(frameSamples = 160)

    @Test
    fun prefillThenPlayWithFadeIn() {
        val jb = JitterBuffer(config)
        val out = ShortArray(160)
        val frame = ShortArray(160) { 1000 }
        repeat(4) { jb.push(frame) }
        assertEquals(PlayoutKind.SILENCE, jb.pop(out))
        jb.push(frame)
        assertEquals(PlayoutKind.REAL, jb.pop(out))
        assertEquals(0, out[0].toInt())
        assertEquals(1000 * 20 / 40, out[20].toInt())
        assertEquals(1000, out[159].toInt())
    }

    @Test
    fun underrunConcealsThenSilenceAndGrowsTarget() {
        val jb = JitterBuffer(config)
        val out = ShortArray(160)
        repeat(5) { jb.push(ShortArray(160) { 3000 }) }
        repeat(5) { jb.pop(out) }
        repeat(3) { assertEquals(PlayoutKind.CONCEALED, jb.pop(out)) }
        assertEquals(PlayoutKind.SILENCE, jb.pop(out))
        assertEquals(1, jb.snapshot().underruns)
        assertEquals(7, jb.targetFrames)
    }
}
