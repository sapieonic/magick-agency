package com.magickagency.agent_audio

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MediaTest {
    @Test
    fun wireFormatsMatchTheSocketContract() {
        assertEquals(160, WireFormat.ALAW8.frameBytes)
        assertEquals(160, WireFormat.ALAW8.frameSamples)
        assertEquals(640, WireFormat.PCM16.frameBytes)
        assertEquals(320, WireFormat.PCM16.frameSamples)
        assertEquals(WireFormat.ALAW8, WireFormat.fromWire("alaw8"))
        assertNull(WireFormat.fromWire("opus"))
    }

    @Test
    fun downlinkReframesArbitraryChunks() {
        val frames = mutableListOf<ShortArray>()
        val asm = DownlinkAssembler(WireFormat.ALAW8) { frames += it.copyOf() }
        val bytes = ByteArray(400) { (it % 256).toByte() }
        // 7 + 200 + 193 bytes: two whole frames, 80 bytes carried over.
        asm.feed(bytes, 0, 7)
        asm.feed(bytes, 7, 200)
        asm.feed(bytes, 207, 193)
        assertEquals(2, frames.size)
        for (i in 0 until 160) {
            assertEquals(ALaw.decodeSample(bytes[i].toInt()), frames[0][i].toInt())
            assertEquals(ALaw.decodeSample(bytes[160 + i].toInt()), frames[1][i].toInt())
        }
        asm.reset()
        asm.feed(bytes, 0, 160)
        assertEquals(3, frames.size, "reset drops the carried partial frame")
    }

    @Test
    fun downlinkDecodesPcm16LittleEndian() {
        var got: ShortArray? = null
        val asm = DownlinkAssembler(WireFormat.PCM16) { got = it.copyOf() }
        val bytes = ByteArray(640)
        bytes[0] = 0x34; bytes[1] = 0x12 // 0x1234
        bytes[2] = 0xFF.toByte(); bytes[3] = 0xFF.toByte() // -1
        bytes[638] = 0x00; bytes[639] = 0x80.toByte() // -32768
        asm.feed(bytes, 0, 640)
        val frame = got!!
        assertEquals(0x1234, frame[0].toInt())
        assertEquals(-1, frame[1].toInt())
        assertEquals(-32768, frame[319].toInt())
    }

    @Test
    fun uplinkEncodesBothFormatsAndMutesToSilence() {
        val capture = ShortArray(CAPTURE_FRAME) { (it * 50 - 8000).toShort() }
        val out = ByteArray(640)
        val pcm = UplinkEncoder(WireFormat.PCM16)
        assertEquals(640, pcm.encode(capture, false, out))
        for (i in 0 until CAPTURE_FRAME) {
            val v = (out[2 * i].toInt() and 0xFF) or (out[2 * i + 1].toInt() shl 8)
            assertEquals(capture[i].toInt(), v.toShort().toInt())
        }
        assertEquals(640, pcm.encode(capture, true, out))
        assertTrue(out.all { it.toInt() == 0 })

        val alaw = UplinkEncoder(WireFormat.ALAW8)
        assertEquals(160, alaw.encode(capture, true, out))
        assertTrue((0 until 160).all { out[it] == ALaw.SILENCE })
        // Unmuted output is the decimated signal, A-law encoded.
        val expected = ShortArray(160)
        val reference = HalfBandDecimator()
        reference.process(capture, 0, CAPTURE_FRAME, expected, 0) // muted frame primed the filter
        reference.process(capture, 0, CAPTURE_FRAME, expected, 0)
        alaw.encode(capture, false, out)
        for (i in 0 until 160) assertEquals(ALaw.encodeSample(expected[i].toInt()), out[i].toInt() and 0xFF)
    }

    @Test
    fun levelMeterReportsEvery100ms() {
        val meter = LevelMeter()
        val full = ShortArray(CAPTURE_FRAME) { if (it % 2 == 0) 32767 else -32767 }
        repeat(4) { assertNull(meter.add(full, CAPTURE_FRAME)) }
        val db = meter.add(full, CAPTURE_FRAME)!!
        assertTrue(db > -0.01 && db <= 0.0, "full scale square wave is 0 dBFS, got $db")
        repeat(4) { meter.add(ShortArray(CAPTURE_FRAME), CAPTURE_FRAME) }
        assertEquals(Level.FLOOR_DBFS, meter.add(ShortArray(CAPTURE_FRAME), CAPTURE_FRAME))
    }

    @Test
    fun interruptionTrackerFoldsSignalsIntoOneBeganEnded() {
        val t = InterruptionTracker()
        // A cellular call: focus lost while ringing, then the mode listener reports it too.
        assertEquals(InterruptionTracker.Transition.Began("phoneCall"), t.update(focusLost = true, telephony = true))
        assertNull(t.update(silenced = true))
        assertNull(t.update(telephony = false))
        assertNull(t.update(silenced = false), "focus is still lost")
        assertEquals(InterruptionTracker.Transition.Ended("phoneCall"), t.update(focusLost = false))
        assertNull(t.update(focusLost = false))
        assertEquals(InterruptionTracker.Transition.Began("focusLoss"), t.update(focusLost = true))
        t.clear()
        assertTrue(!t.interrupted)
        assertEquals(InterruptionTracker.Transition.Began("microphoneSilenced"), t.update(silenced = true))
    }
}
