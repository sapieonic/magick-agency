package com.magickagency.agent_audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ChimeTest {
    /** The same numbers as `test/support/chime_vectors.dart`. */
    private class Vectors(
        val sampleRate: Int,
        val length: Int,
        val samples: List<Pair<Int, Int>>,
        val checksum: Long,
        val energy: Long,
    )

    private val vectors8k = Vectors(
        sampleRate = 8000,
        length = 6696,
        samples = listOf(
            0 to 0, 39 to 0, 40 to 0, 41 to 35, 42 to 116, 72 to 1483, 104 to 3895, 540 to 0,
            1063 to 3931, 1140 to -2319, 1263 to -16, 1264 to 0, 1300 to 0, 1700 to 2665, 3000 to 0,
            6694 to -34, 6695 to -20, 6696 to 0, 7696 to 0,
        ),
        checksum = 2127171L,
        energy = 32407388626L,
    )

    private val vectors16k = Vectors(
        sampleRate = 16000,
        length = 13392,
        samples = listOf(
            0 to 0, 78 to 0, 80 to 0, 82 to 35, 84 to 116, 144 to 1483, 208 to 3895, 1080 to 0,
            2126 to 3931, 2280 to -2319, 2526 to -16, 2528 to 0, 2600 to 0, 3400 to 2665, 6000 to 0,
            13390 to -20, 13391 to -10, 13392 to 0, 14392 to 0,
        ),
        checksum = 1219378L,
        energy = 64814515772L,
    )

    @Test
    fun matchesTheDartVectors() {
        for (v in listOf(vectors8k, vectors16k)) {
            val rate = v.sampleRate
            assertEquals(v.length, Chime.length(rate), "$rate Hz length")
            for ((index, sample) in v.samples) assertEquals(sample, Chime.sample(index, rate), "$rate Hz sample $index")
            var checksum = 0L
            var energy = 0L
            for (n in 0 until v.length) {
                val s = Chime.sample(n, rate).toLong()
                checksum += s * (n % 97 + 1)
                energy += s * s
            }
            assertEquals(v.checksum, checksum, "$rate Hz checksum")
            assertEquals(v.energy, energy, "$rate Hz energy")
        }
    }

    @Test
    fun playsOnceFrameByFrameThenGoesIdle() {
        for (format in WireFormat.entries) {
            val chime = Chime(format.sampleRate)
            val idle = ShortArray(format.frameSamples) { 7 }
            chime.process(idle)
            assertTrue(idle.all { it.toInt() == 7 }, "$format: idle leaves playout alone")
            chime.start()
            val frames = (chime.length + format.frameSamples - 1) / format.frameSamples
            val frame = ShortArray(format.frameSamples)
            for (f in 0 until frames) {
                assertTrue(chime.active, "$format frame $f")
                frame.fill(0)
                chime.process(frame)
                for (i in frame.indices) {
                    assertEquals(Chime.sample(f * format.frameSamples + i, format.sampleRate), frame[i].toInt(), "$format frame $f sample $i")
                }
            }
            assertFalse(chime.active, "$format: once through, then idle")
        }
    }

    @Test
    fun addsToPlayoutSaturating() {
        val high = ShortArray(160) { 32767 }
        val low = ShortArray(160) { -32768 }
        val mid = ShortArray(160) { (it * 10 - 800).toShort() }
        for (frame in listOf(high, low, mid)) {
            val chime = Chime(8000).apply { start() }
            chime.process(ShortArray(1000))
            chime.process(frame)
        }
        for (i in 0 until 160) {
            val s = Chime.sample(1000 + i, 8000)
            assertEquals(minOf(32767, 32767 + s), high[i].toInt(), "high $i")
            assertEquals(maxOf(-32768, -32768 + s), low[i].toInt(), "low $i")
            assertEquals(i * 10 - 800 + s, mid[i].toInt(), "mid $i")
        }
    }

    @Test
    fun startWhilePlayingStartsOver() {
        val chime = Chime(8000)
        chime.start()
        chime.process(ShortArray(2000))
        assertEquals(2000, chime.position)
        chime.start()
        val again = ShortArray(160)
        chime.process(again)
        for (i in 0 until 160) assertEquals(Chime.sample(i, 8000), again[i].toInt(), "sample $i")
        chime.stop()
        assertFalse(chime.active)
    }

    /** Stands in for [VoiceEngine] in [EngineSlot]: counts the chimes the slot handed it. */
    private class FakeEngine : CallEngine {
        override var ringback = false
        var chimes = 0

        override fun playChime() {
            chimes++
        }

        override fun start(loopback: Loopback?) {}

        override fun stop() {}
    }

    @Test
    fun aChimeAskedForBeforeTheEngineRunsPlaysWhenItStarts() {
        val slot = EngineSlot<FakeEngine>()
        // Offered between arm and CallKit activating the session: nothing runs yet.
        slot.playChime()
        assertTrue(slot.chimePending)
        val armed = FakeEngine()
        slot.start(armed, loopback = null)
        assertEquals(1, armed.chimes, "played at start")
        assertFalse(slot.chimePending)
        // Running: straight to the engine.
        slot.playChime()
        assertEquals(2, armed.chimes)
    }

    @Test
    fun aChimeIsPlayedOnceNotAgainAfterARestart() {
        val slot = EngineSlot<FakeEngine>()
        val first = FakeEngine()
        slot.start(first, loopback = null)
        slot.playChime()
        assertEquals(1, first.chimes)
        slot.stop(keepRingback = true)
        val restarted = FakeEngine()
        slot.start(restarted, loopback = null)
        assertEquals(0, restarted.chimes, "one-shot: the restart does not replay it")
    }

    @Test
    fun stopDropsAChimeNotYetPlayed() {
        val slot = EngineSlot<FakeEngine>()
        slot.playChime()
        slot.stop(keepRingback = false)
        assertFalse(slot.chimePending)
        val next = FakeEngine()
        slot.start(next, loopback = null)
        assertEquals(0, next.chimes, "the call it was for is over")
    }

    @Test
    fun aLoopbackTestNeverChimesAndKeepsTheRequest() {
        val slot = EngineSlot<FakeEngine>()
        slot.playChime()
        val test = FakeEngine()
        slot.start(test, Loopback(WireFormat.ALAW8, durationMs = 400, playBack = true))
        assertEquals(0, test.chimes)
        slot.playChime()
        assertEquals(0, test.chimes, "not even when asked for during it")
        slot.stop(keepRingback = true)
        val armed = FakeEngine()
        slot.start(armed, loopback = null)
        assertEquals(1, armed.chimes, "the call's engine after the test chimes once")
    }
}
