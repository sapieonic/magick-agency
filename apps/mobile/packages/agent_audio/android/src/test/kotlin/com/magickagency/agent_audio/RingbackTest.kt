package com.magickagency.agent_audio

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class RingbackTest {
    /** The same numbers as `test/support/ringback_vectors.dart`. */
    private class Vectors(
        val sampleRate: Int,
        val samples: List<Pair<Long, Int>>,
        val cycleChecksum: Long,
        val segmentEnergy: List<Triple<Int, Int, Long>>,
    )

    private val vectors8k = Vectors(
        sampleRate = 8000,
        samples = listOf(
            0L to 0, 1L to 13, 2L to 51, 5L to 203, 47L to 23, 95L to -328, 96L to -714, 97L to -1057,
            1000L to 1966, 3103L to 1057, 3104L to 714, 3198L to -51, 3199L to -13, 3200L to 0, 4799L to 0,
            4800L to 0, 4801L to 13, 4896L to -714, 6000L to 0, 7999L to -13, 8000L to 0, 23999L to 0,
            24000L to 0, 24001L to 13, 25000L to 1966, 28801234L to -843,
        ),
        cycleChecksum = 593827L,
        segmentEnergy = listOf(
            Triple(0, 3200, 11805177566L),
            Triple(3200, 4800, 0L),
            Triple(4800, 8000, 11805177566L),
            Triple(8000, 24000, 0L),
        ),
    )

    private val vectors16k = Vectors(
        sampleRate = 16000,
        samples = listOf(
            0L to 0, 1L to 3, 2L to 13, 5L to 76, 95L to -170, 191L to -522, 192L to -714, 193L to -894,
            2000L to 1966, 6207L to 894, 6208L to 714, 6398L to -13, 6399L to -3, 6400L to 0, 9599L to 0,
            9600L to 0, 9601L to 3, 9792L to -714, 12000L to 0, 15998L to -13, 16000L to 0, 47998L to 0,
            48000L to 0, 48001L to 3, 50000L to 1966, 57602468L to -843,
        ),
        cycleChecksum = 1829666L,
        segmentEnergy = listOf(
            Triple(0, 6400, 23610816756L),
            Triple(6400, 9600, 0L),
            Triple(9600, 16000, 23610816756L),
            Triple(16000, 48000, 0L),
        ),
    )

    @Test
    fun matchesTheDartVectors() {
        for (v in listOf(vectors8k, vectors16k)) {
            val rate = v.sampleRate
            for ((index, sample) in v.samples) assertEquals(sample, Ringback.sample(index, rate), "$rate Hz sample $index")
            var checksum = 0L
            for (n in 0 until 3 * rate) checksum += Ringback.sample(n.toLong(), rate).toLong() * (n % 97 + 1)
            assertEquals(v.cycleChecksum, checksum, "$rate Hz checksum")
            for ((start, end, energy) in v.segmentEnergy) {
                var sum = 0L
                for (n in start until end) {
                    val s = Ringback.sample(n.toLong(), rate).toLong()
                    sum += s * s
                }
                assertEquals(energy, sum, "$rate Hz segment $start-$end")
            }
        }
    }

    @Test
    fun cadenceIsOnOffOnOff() {
        for (rate in listOf(8000, 16000)) {
            val window = rate / 100
            for (w in 0 until 600) {
                val inCycle = (w * 10) % 3000
                val ringing = inCycle < 400 || (inCycle in 600 until 1000)
                var sum = 0L
                for (n in w * window until (w + 1) * window) {
                    val s = Ringback.sample(n.toLong(), rate).toLong()
                    sum += s * s
                }
                if (ringing) assertTrue(sum > 0, "$rate Hz ringing at ${w * 10} ms") else assertEquals(0L, sum, "$rate Hz silent at ${w * 10} ms")
            }
            val on1 = rate * 4 / 10
            val gap = rate * 2 / 10
            assertNotEquals(0, Ringback.sample((on1 - 1).toLong(), rate), "last sample of the first ring")
            for (n in on1..on1 + gap) assertEquals(0, Ringback.sample(n.toLong(), rate), "gap $n")
            assertNotEquals(0, Ringback.sample((on1 + gap + 1).toLong(), rate), "second ring starts")
        }
    }

    @Test
    fun mixingFrameByFrameYieldsTheReference() {
        for (format in WireFormat.entries) {
            val tone = Ringback(format.sampleRate)
            val frame = ShortArray(format.frameSamples)
            repeat(160) { f ->
                frame.fill(0)
                tone.process(frame, on = true)
                for (i in frame.indices) {
                    assertEquals(Ringback.sample(f.toLong() * format.frameSamples + i, format.sampleRate), frame[i].toInt(), "$format frame $f sample $i")
                }
            }
            assertEquals(160L * format.frameSamples, tone.position)
        }
    }

    @Test
    fun addsToPlayoutInsteadOfReplacingIt() {
        val frame = ShortArray(160) { (it * 10 - 800).toShort() }
        Ringback(8000).mix(frame)
        for (i in 0 until 160) assertEquals(i * 10 - 800 + Ringback.sample(i.toLong(), 8000), frame[i].toInt(), "sample $i")
    }

    @Test
    fun saturatesAtFullScale() {
        val high = ShortArray(160) { 32767 }
        val low = ShortArray(160) { -32768 }
        Ringback(8000).apply { mix(ShortArray(800)) }.mix(high)
        Ringback(8000).apply { mix(ShortArray(800)) }.mix(low)
        var clippedHigh = 0
        var clippedLow = 0
        for (i in 0 until 160) {
            val s = Ringback.sample(800L + i, 8000)
            assertEquals(minOf(32767, 32767 + s), high[i].toInt(), "high $i")
            assertEquals(maxOf(-32768, -32768 + s), low[i].toInt(), "low $i")
            if (s > 0) clippedHigh++
            if (s < 0) clippedLow++
        }
        assertTrue(clippedHigh > 50 && clippedLow > 50, "both clamps exercised")
    }

    @Test
    fun offRewindsAndLeavesTheFrameAlone() {
        val tone = Ringback(8000)
        repeat(30) { tone.process(ShortArray(160), on = true) }
        val untouched = ShortArray(160) { 7 }
        tone.process(untouched, on = false)
        assertTrue(untouched.all { it.toInt() == 7 })
        assertEquals(0L, tone.position)
        val next = ShortArray(160)
        tone.process(next, on = true)
        assertContentEquals(ShortArray(160) { Ringback.sample(it.toLong(), 8000).toShort() }, next)
    }

    /** Stands in for [VoiceEngine] in [EngineSlot]: records what the slot told it. */
    private class FakeEngine(private val failStart: Boolean = false) : CallEngine {
        override var ringback = false
        var started = false

        override fun playChime() {}
        var stopped = false

        override fun start(loopback: Loopback?) {
            if (failStart) throw EngineException("device_busy", "The microphone is in use by another app")
            started = true
        }

        override fun stop() {
            stopped = true
            ringback = false
        }
    }

    @Test
    fun aRequestMadeBeforeArmStartsWithTheEngine() {
        val slot = EngineSlot<FakeEngine>()
        // Asked for while prepared: nothing runs yet; the engine started at arm rings.
        slot.setRingback(true)
        val armed = FakeEngine()
        slot.start(armed, loopback = null)
        assertTrue(armed.started)
        assertTrue(armed.ringback, "arm")
        // Answered, then rung again: each change reaches the running engine.
        slot.setRingback(false)
        assertFalse(armed.ringback)
        slot.setRingback(true)
        assertTrue(armed.ringback)
    }

    @Test
    fun theRequestOutlivesARestartAndStopClearsIt() {
        val slot = EngineSlot<FakeEngine>()
        slot.setRingback(true)
        val first = FakeEngine()
        slot.start(first, loopback = null)
        // A device error rebuilds the engine; the request carries over.
        assertSame(first, slot.stop(keepRingback = true))
        assertTrue(first.stopped)
        assertNull(slot.engine)
        val restarted = FakeEngine()
        slot.start(restarted, loopback = null)
        assertTrue(restarted.ringback, "restart")
        // stop: the next call starts silent.
        assertSame(restarted, slot.stop(keepRingback = false))
        assertTrue(restarted.stopped)
        assertFalse(slot.ringbackWanted)
        val next = FakeEngine()
        slot.start(next, loopback = null)
        assertFalse(next.ringback, "the next call starts silent")
        // A stopped engine is no longer told anything.
        slot.setRingback(true)
        assertFalse(restarted.ringback)
        assertTrue(next.ringback)
    }

    @Test
    fun stopWithNoEngineRunningStillClearsTheRequest() {
        val slot = EngineSlot<FakeEngine>()
        slot.setRingback(true)
        assertNull(slot.stop(keepRingback = false), "nothing was running")
        val armed = FakeEngine()
        slot.start(armed, loopback = null)
        assertFalse(armed.ringback)
    }

    @Test
    fun aLoopbackTestNeverRingsAndKeepsTheRequest() {
        val slot = EngineSlot<FakeEngine>()
        slot.setRingback(true)
        val test = FakeEngine()
        slot.start(test, Loopback(WireFormat.ALAW8, durationMs = 400, playBack = true))
        assertFalse(test.ringback, "never during the loopback test")
        slot.setRingback(true)
        assertFalse(test.ringback, "not even when asked for during it")
        slot.stop(keepRingback = true)
        val armed = FakeEngine()
        slot.start(armed, loopback = null)
        assertTrue(armed.ringback, "the call's engine after the test rings")
    }

    @Test
    fun anEngineThatFailsToStartLeavesTheSlotEmpty() {
        val slot = EngineSlot<FakeEngine>()
        slot.setRingback(true)
        val broken = FakeEngine(failStart = true)
        assertFailsWith<EngineException> { slot.start(broken, loopback = null) }
        assertNull(slot.engine)
        assertNull(slot.stop(keepRingback = true))
        assertFalse(broken.stopped)
        val retried = FakeEngine()
        slot.start(retried, loopback = null)
        assertTrue(retried.ringback, "the request survives a failed start")
    }
}
